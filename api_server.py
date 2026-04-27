#!/usr/bin/env python3
"""
Pythia dashboard API — HTTP control plane for the React dashboard.

Wraps the coordinator's primitives (peer discovery, fan-out inference, receipt
verification, Delphi trade) behind REST endpoints, plus a Server-Sent Events
endpoint that streams live phase updates while a run is in progress.

Endpoints:
  GET  /api/health             — orchestrator + downstream services status
  GET  /api/topology           — AXL topology (our peer + connected peers)
  GET  /api/markets            — proxy to delphi_bridge GET /markets
  GET  /api/markets/:id        — proxy to delphi_bridge GET /markets/:id
  GET  /api/wallet             — proxy to delphi_bridge GET /wallet
  POST /api/quote              — proxy to delphi_bridge POST /quote
  POST /api/run (SSE)          — orchestrate full pipeline and stream events:
       event types:
         status        — top-level phase string + message
         peer_started  — fan-out kicked off for a peer
         peer_output   — peer returned text output + receipt
         peer_verified — verification result for a peer
         consensus     — aggregated probability across verified peers
         trade_decision — YES / NO / ABSTAIN with rationale
         trade_result  — on-chain tx hash (or error)
         done          — final summary
         error         — fatal pipeline error
"""
from __future__ import annotations

import argparse
from datetime import datetime, timezone
import json
import logging
import os
import queue
import threading
import time
import uuid
from typing import Any, Dict, Optional

import requests
from flask import Flask, Response, jsonify, request, stream_with_context

import coordinator as coord
from run_store import RunStore


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description="Pythia dashboard API server")
    p.add_argument("--port", type=int, default=5050,
                   help="HTTP port for the dashboard API (default: 5050)")
    p.add_argument("--host", default="127.0.0.1",
                   help="Bind host (default: 127.0.0.1)")
    p.add_argument("--axl-api-port", type=int, default=9002,
                   help="AXL API port for the bootstrap/coordinator node (default: 9002)")
    p.add_argument("--ree-path", default="./ree/ree.sh",
                   help="Path to ree.sh used for receipt verification")
    p.add_argument("--delphi-bridge-url", default="http://127.0.0.1:3001",
                   help="URL of the delphi_bridge Express server")
    p.add_argument("--min-verified-peers", type=int, default=2,
                   help="Minimum verified receipts required before trading (default: 2)")
    p.add_argument("--runs-db", default="./pythia_runs.sqlite3",
                   help="SQLite DB path for persisted dashboard runs")
    p.add_argument("--exa-api-key", default=None,
                   help="Exa API key for web research context")
    p.add_argument("--exa-results", type=int, default=2,
                   help="Number of Exa search results to include per run")
    p.add_argument("--log-level", default="INFO",
                   choices=["DEBUG", "INFO", "WARNING", "ERROR"])
    return p.parse_args()


# ---------------------------------------------------------------------------
# CORS — allow Vite dev server to call this API in dev. Permissive on purpose;
# this whole stack is local-only and never exposed publicly.
# ---------------------------------------------------------------------------

def _load_env_file(path: str) -> None:
    """Load simple KEY=VALUE lines without adding a python-dotenv dependency."""
    if not os.path.isfile(path):
        return
    with open(path, "r", encoding="utf-8") as f:
        for raw in f:
            line = raw.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, value = line.split("=", 1)
            key = key.strip()
            value = value.strip().strip('"').strip("'")
            if key and key not in os.environ:
                os.environ[key] = value


def _resolve_exa_api_key(explicit_key: Optional[str]) -> Optional[str]:
    if explicit_key:
        return explicit_key.strip()

    # The user added the key to dashboard/.env because the dashboard owns the
    # feature. Read it server-side so the browser does not need to call Exa.
    _load_env_file(os.path.join(os.getcwd(), "dashboard", ".env"))
    _load_env_file(os.path.join(os.getcwd(), ".env"))
    script_dir = os.path.dirname(os.path.abspath(__file__))
    _load_env_file(os.path.join(script_dir, "dashboard", ".env"))
    _load_env_file(os.path.join(script_dir, ".env"))
    return (
        os.getenv("EXA_API_KEY")
        or os.getenv("VITE_EXA_SEARCH_API_KEY")
        or None
    )


def _truncate(text: str, max_chars: int) -> str:
    text = " ".join((text or "").split())
    if len(text) <= max_chars:
        return text
    return text[: max_chars - 1].rstrip() + "…"


def search_exa(query: str, api_key: Optional[str], *, num_results: int) -> dict:
    """Fetch a compact, immutable evidence packet from Exa for this run."""
    generated_at = datetime.now(timezone.utc).isoformat()
    if not api_key:
        return {
            "ok": False,
            "query": query,
            "generatedAt": generated_at,
            "results": [],
            "error": "EXA_API_KEY or VITE_EXA_SEARCH_API_KEY is not configured.",
        }

    result_count = max(1, min(num_results, 5))
    payload = {
        "query": query,
        "type": "auto",
        "numResults": result_count,
        "contents": {
            "summary": {
                # Force Exa to return a one-sentence summary instead of the
                # default multi-paragraph bulleted analysis. Keeps prompt
                # tokens manageable for an 8GB GPU running Qwen2.5-3B.
                "query": "Summarize in exactly one short sentence.",
            },
        },
    }
    try:
        resp = requests.post(
            "https://api.exa.ai/search",
            headers={
                "x-api-key": api_key,
                "Content-Type": "application/json",
            },
            json=payload,
            timeout=20,
        )
        resp.raise_for_status()
        body = resp.json()
    except (requests.RequestException, ValueError) as e:
        return {
            "ok": False,
            "query": query,
            "generatedAt": generated_at,
            "results": [],
            "error": str(e),
        }

    results = []
    for item in body.get("results", [])[:result_count]:
        results.append({
            "title": item.get("title") or item.get("url") or "Untitled source",
            "url": item.get("url"),
            "publishedDate": item.get("publishedDate"),
            "author": item.get("author"),
            "summary": item.get("summary") or "",
        })

    return {
        "ok": True,
        "query": query,
        "generatedAt": generated_at,
        "results": results,
    }


def build_research_prompt(user_prompt: str, research: dict) -> str:
    """Freeze Exa evidence into the exact prompt every REE peer receives.

    Only title + date are injected. URL and full summary are kept out of the
    REE prompt entirely — they're persisted in the SQLite run history and
    rendered in the dashboard Research Context card. This keeps the prefill
    matmul small enough to fit on a 7.5GB GPU after Qwen2.5-3B is loaded.
    """
    if not research.get("ok") or not research.get("results"):
        return user_prompt

    lines = [f"Sources ({research.get('generatedAt', '')[:10]}):"]
    for idx, item in enumerate(research.get("results", []), start=1):
        date = item.get("publishedDate", "")[:10] if item.get("publishedDate") else ""
        date_str = f" ({date})" if date else ""
        lines.append(f"{idx}. {item.get('title')}{date_str}")

    lines.extend(["", "Question:", user_prompt])
    return "\n".join(lines)


def _add_cors(resp):
    resp.headers["Access-Control-Allow-Origin"] = "*"
    resp.headers["Access-Control-Allow-Methods"] = "GET, POST, OPTIONS"
    resp.headers["Access-Control-Allow-Headers"] = "Content-Type"
    return resp


# ---------------------------------------------------------------------------
# App factory
# ---------------------------------------------------------------------------

def create_app(args: argparse.Namespace) -> Flask:
    app = Flask(__name__)

    ree_path = os.path.abspath(args.ree_path)
    run_store = RunStore(os.path.abspath(args.runs_db))
    exa_api_key = _resolve_exa_api_key(args.exa_api_key)

    @app.after_request
    def _cors(resp):  # type: ignore[unused-ignore]
        return _add_cors(resp)

    @app.route("/api/<path:_>", methods=["OPTIONS"])
    def _preflight(_):
        return ("", 204)

    # ------------------------------------------------------------------
    # Health
    # ------------------------------------------------------------------
    @app.route("/api/health", methods=["GET"])
    def health():
        services: Dict[str, Any] = {}

        # AXL
        try:
            resp = requests.get(
                f"http://127.0.0.1:{args.axl_api_port}/topology", timeout=2,
            )
            services["axl"] = {
                "ok": resp.status_code == 200,
                "port": args.axl_api_port,
            }
        except Exception as e:
            services["axl"] = {"ok": False, "port": args.axl_api_port, "error": str(e)}

        # Delphi bridge
        try:
            resp = requests.get(f"{args.delphi_bridge_url}/health", timeout=2)
            services["delphi"] = {
                "ok": resp.status_code == 200,
                "url": args.delphi_bridge_url,
                "data": resp.json() if resp.status_code == 200 else None,
            }
        except Exception as e:
            services["delphi"] = {"ok": False, "url": args.delphi_bridge_url, "error": str(e)}

        # REE script presence (cheap proxy for "verification is possible")
        services["ree"] = {
            "ok": os.path.isfile(ree_path),
            "path": ree_path,
        }
        services["exa"] = {
            "ok": bool(exa_api_key),
            "provider": "exa",
            "results": args.exa_results,
        }

        all_ok = all(s.get("ok") for s in services.values())
        return jsonify({"ok": all_ok, "services": services})

    # ------------------------------------------------------------------
    # AXL topology pass-through
    # ------------------------------------------------------------------
    @app.route("/api/topology", methods=["GET"])
    def topology():
        try:
            topo = coord.get_topology(args.axl_api_port)
        except RuntimeError as e:
            return jsonify({"error": str(e)}), 502

        peers = topo.get("peers") or []
        return jsonify({
            "ourPublicKey": topo.get("our_public_key"),
            "peerCount":    len(peers),
            "peers": [
                {
                    "publicKey": p.get("public_key"),
                    "address":   p.get("address"),
                }
                for p in peers
            ],
        })

    # ------------------------------------------------------------------
    # Delphi bridge pass-throughs
    # ------------------------------------------------------------------
    def _bridge_get(path: str):
        try:
            resp = requests.get(f"{args.delphi_bridge_url}{path}", timeout=15)
            return jsonify(resp.json()), resp.status_code
        except requests.RequestException as e:
            return jsonify({"error": str(e)}), 502

    def _bridge_post(path: str, payload: dict):
        try:
            resp = requests.post(
                f"{args.delphi_bridge_url}{path}", json=payload, timeout=30,
            )
            return jsonify(resp.json()), resp.status_code
        except requests.RequestException as e:
            return jsonify({"error": str(e)}), 502

    @app.route("/api/markets", methods=["GET"])
    def markets():
        return _bridge_get("/markets")

    @app.route("/api/markets/<market_id>", methods=["GET"])
    def market_detail(market_id: str):
        return _bridge_get(f"/markets/{market_id}")

    @app.route("/api/wallet", methods=["GET"])
    def wallet():
        return _bridge_get("/wallet")

    @app.route("/api/quote", methods=["POST"])
    def quote():
        body = request.get_json(silent=True) or {}
        return _bridge_post("/quote", body)

    # ------------------------------------------------------------------
    # Persisted run history
    # ------------------------------------------------------------------
    @app.route("/api/runs", methods=["GET"])
    def runs():
        try:
            limit = int(request.args.get("limit", "25"))
        except ValueError:
            limit = 25
        return jsonify({"runs": run_store.list_runs(limit=limit)})

    @app.route("/api/runs/<run_id>", methods=["GET"])
    def run_detail(run_id: str):
        saved = run_store.get_run(run_id)
        if saved is None:
            return jsonify({"error": "run not found"}), 404
        return jsonify(saved)

    @app.route("/api/runs/<run_id>", methods=["DELETE"])
    def delete_run(run_id: str):
        if not run_store.delete_run(run_id):
            return jsonify({"error": "run not found"}), 404
        return ("", 204)

    # ------------------------------------------------------------------
    # SSE pipeline run
    # ------------------------------------------------------------------
    @app.route("/api/run", methods=["POST"])
    def run():
        body = request.get_json(silent=True) or {}
        prompt = body.get("prompt")
        if not isinstance(prompt, str) or not prompt.strip():
            return jsonify({"error": "prompt is required"}), 400

        market_id = body.get("market_id")  # Optional — skip trade if absent
        outcome_force = body.get("outcome_index")  # Optional override
        amount_usdc = float(body.get("amount_usdc") or 0.05)
        min_verified = int(body.get("min_verified_peers") or args.min_verified_peers)
        verify = bool(body.get("verify", True))
        run_id = uuid.uuid4().hex

        run_store.create_run(
            run_id=run_id,
            prompt=prompt,
            market_id=market_id,
            amount_usdc=amount_usdc,
            min_verified_peers=min_verified,
            verify=verify,
        )

        ev_queue: "queue.Queue[Optional[dict]]" = queue.Queue()
        summary: Dict[str, Any] = {}

        def emit(event: str, data: Any) -> None:
            ts = time.time()
            msg = {"event": event, "data": data, "ts": ts}
            ev_queue.put(msg)
            try:
                run_store.append_event(run_id=run_id, ts=ts, event=event, data=data)
                if event in {"research", "consensus", "trade_decision", "trade_result", "error"}:
                    summary[event] = data
                if event == "done":
                    ok = bool(data.get("ok")) if isinstance(data, dict) else False
                    status = "completed" if ok else "failed"
                    summary["done"] = data
                    run_store.update_run(run_id=run_id, status=status, summary=summary)
                elif event == "error":
                    run_store.update_run(run_id=run_id, status="failed", summary=summary)
            except Exception:
                logging.exception("Failed to persist run event")

        def worker() -> None:
            try:
                _run_pipeline(
                    emit=emit,
                    axl_api_port=args.axl_api_port,
                    ree_path=ree_path,
                    bridge_url=args.delphi_bridge_url,
                    prompt=prompt,
                    market_id=market_id,
                    outcome_force=outcome_force,
                    amount_usdc=amount_usdc,
                    min_verified=min_verified,
                    verify=verify,
                    exa_api_key=exa_api_key,
                    exa_results=args.exa_results,
                )
            except Exception as exc:  # noqa: BLE001 — surface every error to UI
                logging.exception("Run pipeline crashed")
                emit("error", {"message": str(exc)})
            finally:
                ev_queue.put(None)  # sentinel to close the stream

        threading.Thread(target=worker, daemon=True, name="pythia-run").start()

        @stream_with_context
        def event_stream():
            while True:
                msg = ev_queue.get()
                if msg is None:
                    break
                payload = json.dumps(msg["data"], default=str)
                yield f"id: {run_id}:{msg['ts']}\nevent: {msg['event']}\ndata: {payload}\n\n"

        resp = Response(event_stream(), mimetype="text/event-stream")
        resp.headers["Cache-Control"] = "no-cache"
        resp.headers["X-Accel-Buffering"] = "no"
        resp.headers["X-Run-Id"] = run_id
        return resp

    return app


# ---------------------------------------------------------------------------
# Pipeline (runs in a worker thread, emits events via callback)
# ---------------------------------------------------------------------------

def _short(peer_id: str) -> str:
    if not peer_id:
        return "(unknown)"
    return f"{peer_id[:10]}…{peer_id[-6:]}"


def _run_pipeline(
    emit,
    *,
    axl_api_port: int,
    ree_path: str,
    bridge_url: str,
    prompt: str,
    market_id: Optional[str],
    outcome_force: Optional[int],
    amount_usdc: float,
    min_verified: int,
    verify: bool,
    exa_api_key: Optional[str],
    exa_results: int,
) -> None:
    # Phase 1 — discovery
    emit("status", {
        "phase": "discover",
        "message": "Fetching AXL topology…",
    })

    topo = coord.get_topology(axl_api_port)
    our_key = topo.get("our_public_key")
    peers = topo.get("peers") or []

    emit("topology", {
        "ourPublicKey": our_key,
        "peerCount": len(peers),
        "peers": [
            {"publicKey": p.get("public_key"), "address": p.get("address")}
            for p in peers
        ],
    })

    if not peers:
        emit("error", {"message": "No peers connected. Start at least one inference node."})
        emit("done", {"ok": False})
        return

    # Phase 2 — Exa research. The fetched evidence is frozen into the prompt
    # and sent identically to every peer, preserving REE reproducibility.
    emit("status", {
        "phase": "research",
        "message": "Fetching current context from Exa…",
    })
    research = search_exa(prompt, exa_api_key, num_results=exa_results)
    emit("research", research)
    prompt_for_peers = build_research_prompt(prompt, research)

    # Phase 3 — inference fan-out (sequential to respect single-GPU memory)
    emit("status", {
        "phase": "inference",
        "message": f"Fanning prompt to {len(peers)} peer(s)…",
    })

    peer_results = []
    for peer in peers:
        peer_id = peer.get("public_key")
        peer_addr = peer.get("address")

        emit("peer_started", {
            "peerId": peer_id,
            "shortId": _short(peer_id),
            "address": peer_addr,
        })

        try:
            result = coord.call_peer_infer(axl_api_port, peer_id, prompt_for_peers)
        except RuntimeError as exc:
            emit("peer_output", {
                "peerId": peer_id,
                "shortId": _short(peer_id),
                "error": str(exc),
            })
            peer_results.append({
                "peer_id": peer_id,
                "output": None,
                "receipt": None,
                "verified": False,
                "verify_msg": str(exc),
            })
            continue

        content = result.get("content") or []
        text_output = content[0].get("text", "") if content else ""
        receipt = result.get("receipt") or {}
        if isinstance(receipt, str):
            try:
                receipt = json.loads(receipt)
            except json.JSONDecodeError:
                receipt = {}

        receipt_hash = (
            receipt.get("receipt_hash")
            or (receipt.get("hashes") or {}).get("receipt_hash")
        )

        emit("peer_output", {
            "peerId": peer_id,
            "shortId": _short(peer_id),
            "output": text_output,
            "receiptHash": receipt_hash,
            "receipt": receipt,
        })

        # Phase 3 — verification (skippable for speed during demos)
        if verify:
            emit("status", {
                "phase": "verify",
                "message": f"Verifying receipt from {_short(peer_id)}…",
                "peerId": peer_id,
            })
            verified, verify_msg = coord.verify_receipt(ree_path, receipt)
        else:
            verified, verify_msg = True, "verification skipped"

        emit("peer_verified", {
            "peerId": peer_id,
            "shortId": _short(peer_id),
            "verified": verified,
            "message": verify_msg,
        })

        peer_results.append({
            "peer_id": peer_id,
            "output": text_output,
            "receipt": receipt,
            "verified": verified,
            "verify_msg": verify_msg,
        })

    verified_results = [r for r in peer_results if r["verified"]]

    # Phase 4 — consensus
    emit("status", {
        "phase": "aggregate",
        "message": "Aggregating verified peer answers…",
    })

    per_peer_probs = []
    probs = []
    for r in verified_results:
        p = coord.extract_probability(r["output"] or "")
        per_peer_probs.append({
            "peerId": r["peer_id"],
            "shortId": _short(r["peer_id"]),
            "probability": p,
        })
        if p is not None:
            probs.append(p)

    consensus = sum(probs) / len(probs) if probs else None

    emit("consensus", {
        "verifiedCount": len(verified_results),
        "totalCount": len(peer_results),
        "perPeer": per_peer_probs,
        "consensusProbability": consensus,
    })

    # Phase 5 — trade decision (only if a market_id was provided)
    if not market_id:
        emit("trade_decision", {
            "decision": "skipped",
            "reason": "No market_id supplied — pure inference mode.",
        })
        emit("done", {"ok": True})
        return

    if len(verified_results) < min_verified:
        emit("trade_decision", {
            "decision": "abort",
            "reason": (
                f"Only {len(verified_results)} verified peer(s); "
                f"need at least {min_verified}."
            ),
        })
        emit("done", {"ok": False})
        return

    if consensus is None:
        emit("trade_decision", {
            "decision": "abort",
            "reason": "Could not extract any probability from verified outputs.",
        })
        emit("done", {"ok": False})
        return

    if outcome_force in (0, 1):
        outcome_idx = int(outcome_force)
        outcome_label = "YES" if outcome_idx == 0 else "NO"
        rationale = f"Forced override (consensus={consensus:.1%})"
    elif consensus > 0.65:
        outcome_idx, outcome_label = 0, "YES"
        rationale = f"Consensus {consensus:.1%} > 65%"
    elif consensus < 0.35:
        outcome_idx, outcome_label = 1, "NO"
        rationale = f"Consensus {consensus:.1%} < 35%"
    else:
        emit("trade_decision", {
            "decision": "abstain",
            "consensus": consensus,
            "reason": f"Consensus {consensus:.1%} is in the 35–65% uncertainty band.",
        })
        emit("done", {"ok": True})
        return

    emit("trade_decision", {
        "decision": "trade",
        "outcomeIndex": outcome_idx,
        "outcomeLabel": outcome_label,
        "consensus": consensus,
        "amountUsdc": amount_usdc,
        "marketId": market_id,
        "verifiedPeers": len(verified_results),
        "rationale": rationale,
    })

    # Phase 6 — execute trade
    emit("status", {
        "phase": "trade",
        "message": f"Submitting {outcome_label} trade for {amount_usdc} USDC…",
    })

    try:
        trade = coord.call_delphi_trade(
            bridge_url=bridge_url,
            market_id=market_id,
            outcome_idx=outcome_idx,
            amount_usdc=amount_usdc,
            verified_receipts=[r["receipt"] for r in verified_results],
        )
    except RuntimeError as exc:
        emit("trade_result", {"ok": False, "error": str(exc)})
        emit("done", {"ok": False})
        return

    emit("trade_result", {
        "ok": True,
        "transactionHash": trade.get("transactionHash"),
        "marketAddress":   trade.get("marketAddress"),
        "outcomeLabel":    trade.get("outcomeLabel") or outcome_label,
        "outcomeIndex":    trade.get("outcomeIdx", outcome_idx),
        "sharesOut":       trade.get("sharesOut"),
        "verifiedPeers":   trade.get("verifiedPeers", len(verified_results)),
    })
    emit("done", {"ok": True})


# ---------------------------------------------------------------------------
# Entrypoint
# ---------------------------------------------------------------------------

def main() -> None:
    args = parse_args()
    logging.basicConfig(
        level=getattr(logging, args.log_level),
        format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
    )
    app = create_app(args)
    logging.info("Pythia dashboard API listening on http://%s:%d", args.host, args.port)
    # threaded=True so the SSE worker thread can keep streaming while other
    # short polls (markets, wallet) are served on different request handlers.
    app.run(host=args.host, port=args.port, debug=False, threaded=True)


if __name__ == "__main__":
    main()
