# Pythia

**P2P inference with cryptographic receipts, settled on Delphi.**

Each node runs a local LLM via [REE](https://github.com/gensyn-ai/ree) (Gensyn's Reproducible Execution Environment) and exposes it as an MCP service over [AXL](https://github.com/gensyn-ai/axl) (Gensyn's P2P layer). A coordinator discovers peers, fans out prompts, and verifies every receipt before optionally placing trades on Delphi prediction markets.

> No central server. Every inference is cryptographically proven.

---

## Architecture

```
Coordinator (bootstrap AXL node)
      │  tls://coordinator:9001
  ┌───┴───┐
Node 1  Node 2         ← inference nodes (AXL + Flask MCP + REE)
  │       │
  └───────┘
     AXL mesh (Yggdrasil P2P, TLS 1.3)

Phase 2: Coordinator → delphi_bridge → Delphi on-chain market
```

See [SPEC.md](SPEC.md) for the full architecture document.

---

## Prerequisites

| Dependency | Version | Notes |
|---|---|---|
| Go | 1.21+ | Required to build AXL |
| Python | 3.10+ | Application layer |
| Docker | 24+ | Required by REE (≥8 GB memory recommended) |
| OpenSSL | any | Key generation |
| Node.js | 18+ | delphi_bridge (Phase 2 only) |
| NVIDIA drivers | 570.00+ (Linux) | GPU inference (optional; CPU fallback available) |

---

## Setup

### 1. Clone this repo and install Python deps

```bash
git clone <this-repo> && cd pythia
pip install -r requirements.txt
```

### 2. Build AXL

```bash
git clone https://github.com/gensyn-ai/axl /tmp/axl
cd /tmp/axl && make build
cp node pythia/axl/axl   # copy binary into the project
```

### 3. Clone REE

```bash
git clone https://github.com/gensyn-ai/ree pythia/ree
```

### 4. (Phase 2 only) Install delphi_bridge deps

```bash
cd delphi_bridge
npm install
npm run build
cp .env.example .env
# Edit .env — fill in DELPHI_API_ACCESS_KEY, WALLET_PRIVATE_KEY
```

---

## Running Locally (1 coordinator + 2 inference nodes)

### Terminal 1 — coordinator (bootstrap node)

```bash
cd pythia
./start_coordinator.sh
```

This starts the AXL bootstrap node (listens on `:9001`) and optionally starts
the delphi_bridge if `delphi_bridge/.env` exists.

Note the bootstrap address printed:
```
Bootstrap address: tls://127.0.0.1:9001
```

### Terminal 2 — inference node 1

```bash
cd pythia
./start_node.sh 1 127.0.0.1
```

### Terminal 3 — inference node 2

```bash
cd pythia
./start_node.sh 2 127.0.0.1
```

### Terminal 4 — run a query

```bash
cd pythia
python coordinator.py --prompt "Will ETH be above \$3000 at end of 2025?"
```

Expected output:
```
Prompt: 'Will ETH be above $3000 at end of 2025?'
Sending to 2 peer(s)...

Peer a1b2c3d4ef01...56789a  (200::...)
  Output:  'Based on current trends... approximately 52% probability...'
  receipt_hash: sha256:778899...
  Verifying... ✓ VERIFIED

Peer b2c3d4e5f012...678901  (200::...)
  Output:  'Historical data suggests... around 48% chance...'
  receipt_hash: sha256:aabbcc...
  Verifying... ✓ VERIFIED

======================================================================
Verification: 2/2 peers verified
Done.
```

---

## One-command Demo

```bash
cd pythia
./demo.sh "Will ETH be above \$3000 at end of 2025?"
```

Spins up coordinator + 2 nodes, waits for them to connect, runs the query, then cleans up.

With Delphi trading:
```bash
./demo.sh "Will ETH be above \$3000 at end of 2025?" <market_id>
```

---

## Verifying a Receipt Manually

```bash
# Structural validation only (fast — no Docker)
python verify.py --receipt example_receipt.json --validate-only

# Full cryptographic verify (re-runs inference in Docker)
python verify.py --receipt example_receipt.json
```

---

## Adding a Third Node

```bash
# Terminal 5
./start_node.sh 3 127.0.0.1
```

Port layout for node N:
- AXL API: `9002 + N×10` → 9032
- AXL router: `9003 + N×10` → 9033
- Flask inference: `5001 + N×10` → 5031

The coordinator's `/topology` automatically picks up the new peer. Re-run coordinator.py and it will include node 3 in the query.

---

## Phase 2: Delphi Trading

### Setup

1. Create a YES/NO market at https://app.delphi.fyi/ (agents cannot create markets)
2. Note the market ID from the URL
3. Configure `delphi_bridge/.env`:

```bash
cp delphi_bridge/.env.example delphi_bridge/.env
# Edit:
#   DELPHI_API_ACCESS_KEY=<your key>
#   WALLET_PRIVATE_KEY=0x<your key>
#   DELPHI_NETWORK=testnet
```

4. Fund your wallet with testnet tokens

### Run

```bash
./demo.sh "Will ETH be above \$3000 at end of 2025?" <market_id>
```

The coordinator will:
1. Collect verified inference from all peers
2. Extract probability estimates from their outputs
3. Compute consensus probability
4. If > 65%: buy YES; if < 35%: buy NO; otherwise abstain
5. Print the transaction hash

**Safety guarantee**: the bridge refuses to trade if fewer than 2 peers have REE-verified receipts.

---

## Project Structure

```
pythia/
├── README.md
├── SPEC.md                       ← architecture document
├── axl/                          ← AXL binary (place axl binary here)
│   └── axl                       ← built from github.com/gensyn-ai/axl
├── ree/                          ← REE scripts (clone from github.com/gensyn-ai/ree)
│   └── ree.sh
├── inference_node.py             ← inference peer: MCP server + REE wrapper
├── coordinator.py                ← coordinator: topology discovery + routing
├── verify.py                     ← standalone receipt verifier
├── start_node.sh                 ← start AXL + inference_node.py
├── start_coordinator.sh          ← start AXL bootstrap + optional delphi_bridge
├── demo.sh                       ← one-command local demo
├── node-config.template.json     ← AXL config template
├── requirements.txt
├── example_receipt.json          ← example REE receipt
└── delphi_bridge/
    ├── index.ts                  ← Express sidecar bridging Python → Delphi SDK
    ├── package.json
    ├── tsconfig.json
    └── .env.example
```

---

## Troubleshooting

**"No peers found in topology"**
- Inference nodes haven't connected yet — wait 10–15s after starting them
- Check the bootstrap IP in `start_node.sh` matches the coordinator machine's IP

**REE times out (exit code 137)**
- Docker is out of memory — increase Docker memory: Settings → Resources → Advanced → Memory → 8 GB+

**"REE script not found"**
- Run: `git clone https://github.com/gensyn-ai/ree ree`
- Confirm `ree/ree.sh` exists and is executable: `chmod +x ree/ree.sh`

**MCP router returns 404 on /register**
- AXL router (port 9013/9023) may not be running
- Check that AXL config has `router_addr` and `router_port` set

**delphi_bridge returns 422 "Insufficient verified peers"**
- The coordinator did not pass enough REE-verified receipts
- Ensure at least 2 inference nodes are running and fully verified
