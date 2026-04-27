# Pythia — Architecture Specification

## Overview

Pythia is a peer-to-peer inference network where:

1. Each **inference node** runs a local LLM via REE (Reproducible Execution Environment), wraps every output in a cryptographic receipt, and exposes the result as an MCP service over AXL.
2. A **coordinator node** discovers inference peers via AXL's `/topology` endpoint, fans out prompts, collects `{output, receipt}` pairs, and cryptographically verifies each receipt.
3. Callers receive: the answer **plus** a verifiable proof that the inference wasn't tampered with.
4. (Phase 2) The coordinator aggregates verified probability estimates and places on-chain trades on Delphi prediction markets.

**No central server. All inter-node communication goes through AXL (Yggdrasil P2P mesh).**

---

## Components

### inference_node.py

Runs on each peer machine.

- Starts an AXL node binary as a subprocess (via `start_node.sh`)
- Runs a Flask HTTP server implementing MCP JSON-RPC 2.0 on `localhost:{inference_port}`
- Registers the `"infer"` service with AXL's local MCP router (`POST /register`)
- On `tools/call` → `infer`:
  1. Invokes `./ree/ree.sh` as a subprocess with the prompt
  2. Finds the receipt file written to `~/.cache/gensyn/...`
  3. Returns `{content: [{type: "text", text: output}], receipt: {...}}`
- Returns an error (never an unverified response) if REE fails
- Polls AXL `/recv` in a background thread for any raw peer messages

### coordinator.py

Runs on the orchestrator machine.

- Starts its own AXL bootstrap node (via `start_coordinator.sh`)
- Calls `GET /topology` to discover all directly-connected peers
- For each peer: `POST /mcp/{peer_id}/infer` (JSON-RPC `tools/call`)
- Verifies each receipt: `gensyn-sdk validate` → `ree.sh verify`
- Displays: per-peer output, receipt hash, `✓ VERIFIED` / `✗ FAILED`
- (Phase 2) Extracts probability from verified outputs → consensus → Delphi trade

### verify.py

Standalone receipt verifier for auditors.

- `--validate-only`: structural check only (fast, no Docker)
- Full mode: re-runs inference in Docker to confirm bitwise reproducibility

### delphi_bridge/ (TypeScript sidecar)

Express server on `localhost:3001` bridging Python ↔ Delphi SDK (TypeScript-only).

- `GET /markets` → list open markets
- `GET /markets/:id` → single market details
- `GET /wallet` → read configured wallet address, ETH/token balances, position count
- `POST /quote` → read-only buy quote for `{market_id, outcome_index, amount_usdc}`
- `POST /trade` → `{market_id, outcome_index, amount_usdc, verified_receipts[]}` → on-chain buy

**Safety constraint**: refuses trade if `verified_receipts.length < MIN_VERIFIED_PEERS`.

---

## Network Topology

```
Coordinator (bootstrap)
    AXL port 9001 (TLS listener)
    AXL API  9002
    MCP router 9003
         │
         │  tls://coordinator:9001
    ┌────┴────┐
    │         │
  Node 1    Node 2     (... Node N)
  AXL 9012  AXL 9022
  Flask 5011 Flask 5021
```

All inference nodes connect to the coordinator's port 9001. `/topology` on the coordinator returns all connected peers in `peers[]`.

---

## AXL API

All requests to `http://127.0.0.1:{api_port}`.

| Endpoint | Method | Purpose |
|---|---|---|
| `/topology` | GET | Node identity + peer list + spanning tree |
| `/mcp/{peer_id}/{service}` | POST | JSON-RPC 2.0 call to remote peer MCP service |
| `/send` | POST | Raw binary send (`X-Destination-Peer-Id` header) |
| `/recv` | GET | Poll inbound raw messages (200 + body, or 204 if empty) |

AXL MCP Router at `http://127.0.0.1:{router_port}`:

| Endpoint | Method | Body |
|---|---|---|
| `/register` | POST | `{"service": "infer", "endpoint": "http://127.0.0.1:{port}"}` |
| `/register/{service}` | DELETE | Deregister on shutdown |
| `/services` | GET | List registered services |

---

## REE Integration

REE wraps a Docker-based multi-stage pipeline: ONNX export → compilation → inference → receipt generation.

```bash
# Run inference
./ree/ree.sh --model-name Qwen/Qwen2.5-3B --prompt-text "..." --max-new-tokens 200

# Structural validation (no Docker)
gensyn-sdk validate --receipt-path /path/to/receipt.json

# Full cryptographic verify (re-runs Docker)
./ree/ree.sh verify --receipt-path /path/to/receipt.json
```

Receipt location: `~/.cache/gensyn/<model_name>/<task-id>/metadata/receipt_*.json`

### Receipt JSON schema

```json
{
  "model_name":       "Qwen/Qwen2.5-3B",
  "commit_hash":      "...",
  "config_hash":      "sha256:...",
  "prompt":           "...",
  "prompt_hash":      "sha256:...",
  "parameters":       {"temperature": 0.7, "top_k": 50, "top_p": 0.9},
  "parameters_hash":  "sha256:...",
  "tokens_hash":      "sha256:...",
  "token_count":      142,
  "finish_reason":    "eos_token",
  "text_output":      "...",
  "device_type":      "cpu",
  "device_name":      "...",
  "receipt_hash":     "sha256:...",
  "version":          "1.0.0",
  "ree_version":      "0.1.0"
}
```

---

## Delphi SDK (Phase 2)

TypeScript SDK: `@gensyn-ai/gensyn-delphi-sdk`

```typescript
const client = new DelphiClient();                            // reads env vars
const { markets } = await client.listMarkets({ status: "open" });
await client.ensureTokenApproval({
  marketAddress: market.id,
  minimumAmount: maxTokensIn,
  approveAmount: maxTokensIn,
});
const { transactionHash } = await client.buyShares({
  marketAddress: market.id,
  outcomeIdx: 0,                                              // 0=YES, 1=NO
  sharesOut:    BigInt(Math.round(amount * 1e18)),
  maxTokensIn:  BigInt(Math.round(amount * 1.2 * 1e6)),       // 20% slippage buffer
});
```

Required env vars: `DELPHI_API_ACCESS_KEY`, `DELPHI_SIGNER_TYPE=private_key`, `WALLET_PRIVATE_KEY=0x...`, `DELPHI_NETWORK=testnet`

On testnet, the wallet needs native ETH for gas and mock USDC from the Delphi
testnet faucet before trades can settle.

---

## Trading Logic

```
verified_outputs = [r for r in peer_results if r.verified]

if len(verified_outputs) < MIN_VERIFIED_PEERS:
    abort("not enough verified peers")

probs = [extract_probability(r.output) for r in verified_outputs]
consensus = mean(probs)

if consensus > 0.65:   buy YES (outcome 0)
elif consensus < 0.35: buy NO  (outcome 1)
else:                  abstain (too uncertain)
```

Markets must be pre-created via https://app.delphi.fyi/ — the SDK cannot create markets.

---

## Security Properties

| Property | Mechanism |
|---|---|
| Inference integrity | REE receipt contains `receipt_hash = hash(commit + config + prompt + params + tokens)` |
| Transport security | AXL uses TLS 1.3 + ed25519 peer authentication (Yggdrasil) |
| No unverified trades | delphi_bridge enforces `verified_receipts.length >= MIN_VERIFIED_PEERS` |
| No central server | All routing through AXL mesh; coordinator is just another AXL node |
| Reproducibility | REE `--operation-set reproducible` guarantees bitwise-identical outputs across hardware |
