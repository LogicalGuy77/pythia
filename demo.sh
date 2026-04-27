#!/usr/bin/env bash
# demo.sh — Full local Pythia demo: 1 coordinator + 2 inference nodes
#
# Usage:
#   ./demo.sh
#   ./demo.sh "Will ETH be above \$3000 at end of 2025?"
#   ./demo.sh "Will ETH be above \$3000 at end of 2025?" <market_id>
#
# Prerequisites:
#   - axl/axl binary present (build from https://github.com/gensyn-ai/axl)
#   - ree/ directory present (clone from https://github.com/gensyn-ai/ree)
#   - pip install -r requirements.txt
#   - Docker running with ≥8GB memory (for REE)
#   - For Phase 2: delphi_bridge/.env configured and npm install done

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROMPT="${1:-Will ETH be above \$3000 at end of 2025?}"
MARKET_ID="${2:-}"

echo ""
echo "╔══════════════════════════════════════════════════════════╗"
echo "║          Pythia — P2P Inference Demo                     ║"
echo "╚══════════════════════════════════════════════════════════╝"
echo ""
echo "Prompt: ${PROMPT}"
if [ -n "${MARKET_ID}" ]; then
  echo "Market: ${MARKET_ID}"
fi
echo ""

# Track PIDs for cleanup
PIDS=()

cleanup() {
  echo ""
  echo "[demo] Cleaning up processes..."
  for pid in "${PIDS[@]}"; do
    kill "${pid}" 2>/dev/null || true
  done
}
trap cleanup EXIT INT TERM

# ── Step 1: Start coordinator ────────────────────────────────────────────────
echo "[demo] Starting coordinator..."
"${SCRIPT_DIR}/start_coordinator.sh" &
PIDS+=($!)
echo "[demo] Waiting 10s for coordinator to be ready..."
sleep 10

# ── Step 2: Start inference nodes ────────────────────────────────────────────
echo "[demo] Starting inference node 1..."
"${SCRIPT_DIR}/start_node.sh" 1 127.0.0.1 &
PIDS+=($!)

echo "[demo] Starting inference node 2..."
"${SCRIPT_DIR}/start_node.sh" 2 127.0.0.1 &
PIDS+=($!)

echo "[demo] Waiting 25s for nodes to connect and register services..."
sleep 25

# ── Step 3: Run coordinator query ────────────────────────────────────────────
echo ""
echo "[demo] Running coordinator query..."
echo ""

COORDINATOR_ARGS=(
  --api-port 9002
  --prompt   "${PROMPT}"
)

if [ -n "${MARKET_ID}" ]; then
  COORDINATOR_ARGS+=(--market-id "${MARKET_ID}")
fi

python3 "${SCRIPT_DIR}/coordinator.py" "${COORDINATOR_ARGS[@]}"

echo ""
echo "[demo] Demo complete."
