#!/usr/bin/env bash
# start_coordinator.sh — Start the Pythia coordinator (bootstrap AXL node + optional delphi_bridge)
#
# Usage: ./start_coordinator.sh
#
# After startup it prints the bootstrap address that inference nodes
# should put in their "Peers" config.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

PEM_FILE="${SCRIPT_DIR}/axl/coordinator-private.pem"
CONFIG_FILE="${SCRIPT_DIR}/axl/coordinator-config.json"
AXL_BIN="${SCRIPT_DIR}/axl/axl"

# Validate AXL binary
if [ ! -f "${AXL_BIN}" ]; then
  echo "ERROR: AXL binary not found at ${AXL_BIN}"
  echo "  Build it: git clone https://github.com/gensyn-ai/axl && cd axl && make build"
  echo "  Then copy the binary to ${SCRIPT_DIR}/axl/axl"
  exit 1
fi

# Generate key if not present
if [ ! -f "${PEM_FILE}" ]; then
  echo "[coordinator] Generating ed25519 key: ${PEM_FILE}"
  openssl genpkey -algorithm ed25519 -out "${PEM_FILE}"
fi

# Write AXL config — coordinator is the bootstrap node
# (empty Peers, Listen on 9001, HTTP API on 9002)
cat > "${CONFIG_FILE}" <<EOF
{
  "PrivateKeyPath": "${PEM_FILE}",
  "Peers": [],
  "Listen": ["tls://0.0.0.0:9001"],
  "api_port": 9002,
  "router_addr": "http://127.0.0.1",
  "router_port": 9003,
  "conn_read_timeout_secs": 1800,
  "conn_idle_timeout_secs": 1800
}
EOF
echo "[coordinator] Wrote ${CONFIG_FILE}"

# Start AXL
echo "[coordinator] Starting AXL bootstrap node..."
"${AXL_BIN}" --config "${CONFIG_FILE}" &
AXL_PID=$!
echo "[coordinator] AXL PID: ${AXL_PID}"

# Wait for HTTP API
echo "[coordinator] Waiting for AXL API..."
for i in $(seq 1 20); do
  if curl -sf "http://127.0.0.1:9002/topology" > /dev/null 2>&1; then
    echo "[coordinator] AXL ready."
    break
  fi
  if [ "${i}" -eq 20 ]; then
    echo "ERROR: AXL did not become ready after 40s."
    kill "${AXL_PID}" 2>/dev/null || true
    exit 1
  fi
  sleep 2
done

# Start MCP router for the coordinator
echo "[coordinator] Starting MCP router on port 9003..."
python3 "${SCRIPT_DIR}/mcp_router.py" --port 9003 &
ROUTER_PID=$!
echo "[coordinator] MCP router PID: ${ROUTER_PID}"
sleep 2

# Print bootstrap address for inference nodes
LOCAL_IP=$(hostname -I 2>/dev/null | awk '{print $1}' || echo "127.0.0.1")
echo ""
echo "════════════════════════════════════════════════════════"
echo "  Coordinator bootstrap address:"
echo "    tls://${LOCAL_IP}:9001"
echo ""
echo "  Add this to each inference node's Peers config."
echo "════════════════════════════════════════════════════════"
echo ""

BRIDGE_PID=""

# Start delphi_bridge if .env is present
if [ -f "${SCRIPT_DIR}/delphi_bridge/.env" ]; then
  echo "[coordinator] Starting delphi_bridge..."
  cd "${SCRIPT_DIR}/delphi_bridge"
  npm start &
  BRIDGE_PID=$!
  echo "[coordinator] delphi_bridge PID: ${BRIDGE_PID}"
  cd "${SCRIPT_DIR}"
else
  echo "[coordinator] delphi_bridge/.env not found — skipping Delphi bridge."
  echo "              To enable Phase 2 trading: cp delphi_bridge/.env.example delphi_bridge/.env && edit it."
fi

# Kill all children on exit
trap "echo '[coordinator] Shutting down...'; kill ${AXL_PID} ${ROUTER_PID} ${BRIDGE_PID:-} 2>/dev/null || true" EXIT INT TERM

wait "${AXL_PID}"
