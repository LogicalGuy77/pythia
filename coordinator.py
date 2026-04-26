#!/usr/bin/env python3
"""
Pythia coordinator — discovers inference peers, fans out prompts, verifies receipts.

Phase 1: peer discovery via AXL /topology
Phase 2: fan-out inference via AXL /mcp/{peer_id}/infer (JSON-RPC 2.0)
Phase 3: receipt verification via REE validate + verify
Phase 4 (optional): consensus probability → Delphi prediction market trade
"""
import argparse
import json
import logging
import os
import re
import subprocess
import sys
import tempfile
import time
import uuid
from typing import Optional

import requests


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def parse_args():
    p = argparse.ArgumentParser(description="Pythia coordinator")
    p.add_argument("--api-port",  type=int, default=9002,
                   help="AXL HTTP API port for the coordinator node (default: 9002)")
    p.add_argument("--prompt",    required=True,
                   help="Prompt to send to all inference peers")
    p.add_argument("--ree-path",  default="./ree/ree.sh",
                   help="Path to ree.sh for receipt verification")
    p.add_argument("--market-id", default=None,
                   help="Delphi market ID to trade on (Phase 2, optional)")
    p.add_argument("--delphi-bridge-url", default="http://127.0.0.1:3001",
                   help="URL of the delphi_bridge Express server")
    p.add_argument("--min-verified-peers", type=int, default=2,
                   help="Minimum verified receipts required before trading (default: 2)")
    p.add_argument("--trade-amount-usdc",  type=float, default=10.0,
                   help="USDC amount to trade on each Delphi position (default: 10.0)")
    p.add_argument("--log-level", default="INFO",
                   choices=["DEBUG", "INFO", "WARNING", "ERROR"])
    return p.parse_args()


# ---------------------------------------------------------------------------
# Peer discovery
# ---------------------------------------------------------------------------

def get_topology(api_port: int) -> dict:
    """
    Fetch /topology from AXL.
    Returns full topology dict with our_public_key, peers, tree.
    """
    url = f"http://127.0.0.1:{api_port}/topology"
    try:
        resp = requests.get(url, timeout=10)
        resp.raise_for_status()
    except requests.RequestException as e:
        raise RuntimeError(f"Failed to GET /topology on port {api_port}: {e}")
    return resp.json()


# ---------------------------------------------------------------------------
# Inference fan-out
# ---------------------------------------------------------------------------

def call_peer_infer(api_port: int, peer_id: str, prompt: str) -> dict:
    """
    Send a tools/call JSON-RPC 2.0 request to a peer's 'infer' MCP service
    via AXL /mcp/{peer_id}/infer.

    Returns the parsed JSON-RPC result dict.
    Raises RuntimeError on HTTP error or JSON-RPC error response.
    """
    url = f"http://127.0.0.1:{api_port}/mcp/{peer_id}/infer"
    payload = {
        "jsonrpc": "2.0",
        "id": str(uuid.uuid4()),
        "method": "tools/call",
        "params": {
            "name": "infer",
            "arguments": {"prompt": prompt},
        },
    }

    logging.info("Calling peer %s...%s", peer_id[:8], peer_id[-8:])

    try:
        resp = requests.post(url, json=payload, timeout=360)  # 6 min; REE can be slow
        resp.raise_for_status()
    except requests.Timeout:
        raise RuntimeError(f"Peer {peer_id[:16]}... timed out after 360s")
    except requests.RequestException as e:
        raise RuntimeError(f"HTTP error calling peer {peer_id[:16]}...: {e}")

    body = resp.json()
    if "error" in body:
        err = body["error"]
        raise RuntimeError(
            f"Peer {peer_id[:16]}... JSON-RPC error {err['code']}: {err['message']}"
        )

    return body.get("result", {})


# ---------------------------------------------------------------------------
# Receipt verification
# ---------------------------------------------------------------------------

def verify_receipt(ree_path: str, receipt_dict: dict) -> tuple[bool, str]:
    """
    Write receipt to a temp file, run structural validate then full verify.

    Returns (success, detail_message).
    Full verify re-runs Docker inference — can take several minutes.
    """
    with tempfile.NamedTemporaryFile(
        mode="w", suffix=".json", delete=False, prefix="pythia_receipt_"
    ) as f:
        json.dump(receipt_dict, f)
        tmp_path = f.name

    try:
        # Step 1: structural validation (fast, no Docker)
        validate = subprocess.run(
            ["gensyn-sdk", "validate", "--receipt-path", tmp_path],
            capture_output=True, text=True, timeout=30,
        )
        if validate.returncode != 0:
            return False, f"validate failed: {validate.stderr.strip()}"

        # Step 2: full cryptographic verify (re-runs Docker)
        verify = subprocess.run(
            [ree_path, "verify", "--receipt-path", tmp_path],
            capture_output=True, text=True, timeout=300,
        )
        if verify.returncode != 0:
            return False, f"verify failed: {verify.stderr.strip()}"

        return True, "OK"

    except subprocess.TimeoutExpired:
        return False, "Verification timed out"
    except FileNotFoundError as e:
        return False, f"Verification tool not found: {e}"
    finally:
        try:
            os.unlink(tmp_path)
        except OSError:
            pass


# ---------------------------------------------------------------------------
# Probability extraction (Phase 2)
# ---------------------------------------------------------------------------

def extract_probability(text: str) -> Optional[float]:
    """
    Best-effort extraction of a probability from LLM output text.
    Returns a float in [0.0, 1.0], or None if nothing parseable is found.
    """
    patterns = [
        r'(\d+(?:\.\d+)?)\s*%',
        r'probability[:\s]+(\d+(?:\.\d+)?)',
        r'(\d+(?:\.\d+)?)\s*percent',
        r'chance[:\s]+(\d+(?:\.\d+)?)',
    ]
    for pat in patterns:
        m = re.search(pat, text, re.IGNORECASE)
        if m:
            val = float(m.group(1))
            return val / 100.0 if val > 1.0 else val
    return None


# ---------------------------------------------------------------------------
# Delphi bridge call (Phase 2)
# ---------------------------------------------------------------------------

def call_delphi_trade(
    bridge_url: str,
    market_id: str,
    outcome_idx: int,
    amount_usdc: float,
    verified_receipts: list,
) -> dict:
    """POST /trade to the delphi_bridge sidecar."""
    url = f"{bridge_url}/trade"
    payload = {
        "market_id": market_id,
        "outcome_index": outcome_idx,
        "amount_usdc": amount_usdc,
        "verified_receipts": verified_receipts,
    }
    try:
        resp = requests.post(url, json=payload, timeout=60)
        resp.raise_for_status()
        return resp.json()
    except requests.RequestException as e:
        raise RuntimeError(f"delphi_bridge call failed: {e}")


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main():
    args = parse_args()
    logging.basicConfig(
        level=getattr(logging, args.log_level),
        format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
    )

    ree_path = os.path.abspath(args.ree_path)

    # ── Phase 1: Peer Discovery ──────────────────────────────────────────────
    logging.info("Fetching topology from AXL port %d...", args.api_port)
    try:
        topo = get_topology(args.api_port)
    except RuntimeError as e:
        logging.error("Cannot reach AXL: %s", e)
        sys.exit(1)

    our_key = topo.get("our_public_key", "unknown")
    peers   = topo.get("peers", [])
    logging.info("Our peer ID: %s...%s", our_key[:8], our_key[-8:])
    logging.info("Discovered %d direct peer(s)", len(peers))

    if not peers:
        logging.error(
            "No peers found in topology. "
            "Are inference nodes running and connected to this bootstrap node?"
        )
        sys.exit(1)

    # ── Phase 2: Fan-out Inference ───────────────────────────────────────────
    print(f"\nPrompt: {args.prompt!r}")
    print(f"Sending to {len(peers)} peer(s)...\n")
    print("=" * 70)

    peer_results = []

    for peer in peers:
        peer_id   = peer["public_key"]
        peer_addr = peer.get("address", "unknown")
        short_id  = f"{peer_id[:12]}...{peer_id[-6:]}"

        print(f"\nPeer {short_id}  ({peer_addr})")

        try:
            result = call_peer_infer(args.api_port, peer_id, args.prompt)
        except RuntimeError as e:
            print(f"  [UNREACHABLE] {e}")
            peer_results.append({
                "peer_id":    peer_id,
                "output":     None,
                "receipt":    None,
                "verified":   False,
                "verify_msg": str(e),
            })
            continue

        content = result.get("content", [])
        text_output = content[0].get("text", "") if content else ""
        receipt     = result.get("receipt", {})

        print(f"  Output:       {text_output[:300]!r}")
        print(f"  receipt_hash: {receipt.get('receipt_hash', 'N/A')}")

        # ── Phase 3: Receipt Verification ────────────────────────────────────
        print("  Verifying...", end=" ", flush=True)
        verified, verify_msg = verify_receipt(ree_path, receipt)
        status = "✓ VERIFIED" if verified else f"✗ FAILED ({verify_msg})"
        print(status)

        peer_results.append({
            "peer_id":    peer_id,
            "output":     text_output,
            "receipt":    receipt,
            "verified":   verified,
            "verify_msg": verify_msg,
        })

    # ── Summary ──────────────────────────────────────────────────────────────
    verified_results = [r for r in peer_results if r["verified"]]
    failed_results   = [r for r in peer_results if not r["verified"]]

    print("\n" + "=" * 70)
    print(f"Verification: {len(verified_results)}/{len(peer_results)} peers verified")
    if failed_results:
        for r in failed_results:
            sid = f"{r['peer_id'][:12]}...{r['peer_id'][-6:]}"
            print(f"  ✗ {sid}: {r['verify_msg']}")

    if not verified_results:
        logging.error("No peers produced verified receipts.")
        sys.exit(1)

    # ── Phase 4 (optional): Prediction Market Trading ────────────────────────
    if not args.market_id:
        print("\nNo --market-id supplied; skipping Delphi trade.")
        print("Done.")
        return

    if len(verified_results) < args.min_verified_peers:
        logging.error(
            "Only %d verified peer(s), need at least %d for trading. Aborting.",
            len(verified_results), args.min_verified_peers,
        )
        sys.exit(1)

    # Extract probability estimates from verified peer outputs
    probs = []
    for r in verified_results:
        p = extract_probability(r["output"] or "")
        sid = f"{r['peer_id'][:8]}...{r['peer_id'][-6:]}"
        if p is not None:
            probs.append(p)
            print(f"  Peer {sid} probability estimate: {p:.1%}")
        else:
            print(f"  Peer {sid}: could not extract probability from output")

    if not probs:
        logging.error(
            "Could not extract a probability from any verified peer output. "
            "Ensure the prompt asks for a numeric probability or percentage."
        )
        sys.exit(1)

    consensus_prob = sum(probs) / len(probs)
    print(f"\nConsensus probability ({len(probs)} peers): {consensus_prob:.1%}")

    if consensus_prob > 0.65:
        outcome_idx  = 0
        outcome_name = "YES"
    elif consensus_prob < 0.35:
        outcome_idx  = 1
        outcome_name = "NO"
    else:
        print(
            f"Consensus {consensus_prob:.1%} is in the uncertainty band (35–65%). "
            "Abstaining from trade."
        )
        print("Done.")
        return

    print(
        f"Placing {outcome_name} trade on market {args.market_id}  "
        f"amount={args.trade_amount_usdc} USDC  "
        f"verified_peers={len(verified_results)}"
    )

    try:
        trade = call_delphi_trade(
            bridge_url=args.delphi_bridge_url,
            market_id=args.market_id,
            outcome_idx=outcome_idx,
            amount_usdc=args.trade_amount_usdc,
            verified_receipts=[r["receipt"] for r in verified_results],
        )
        print(f"\nTrade executed!")
        print(f"  tx hash:        {trade.get('transactionHash', 'N/A')}")
        print(f"  market address: {trade.get('marketAddress', 'N/A')}")
        print(f"  outcome:        {outcome_name} (index {outcome_idx})")
        print(f"  shares out:     {trade.get('sharesOut', 'N/A')}")
    except RuntimeError as e:
        logging.error("Trading failed: %s", e)
        sys.exit(1)

    print("\nDone.")


if __name__ == "__main__":
    main()
