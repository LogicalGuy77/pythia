#!/usr/bin/env bash
# start_node.sh — Start a Pythia inference node (AXL + inference_node.py)
#
# Usage: ./start_node.sh [NODE_NUMBER] [BOOTSTRAP_IP]
#   NODE_NUMBER   integer ≥ 1 (default: 1)
#   BOOTSTRAP_IP  IP of the coordinator/bootstrap node (default: 127.0.0.1)
#
# Port layout for node N:
#   AXL api:          9002 + N*10  →  9012, 9022, ...
#   AXL router:       9003 + N*10  →  9013, 9023, ...
#   AXL listen (TLS): 9001 + N*10  →  9011, 9021, ... (inference nodes don't listen)
#   Flask inference:  5001 + N*10  →  5011, 5021, ...

set -euo pipefail

NODE_NUM="${1:-1}"
BOOTSTRAP_IP="${2:-127.0.0.1}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

API_PORT=$((9002 + NODE_NUM * 10))
ROUTER_PORT=$((9003 + NODE_NUM * 10))
INFERENCE_PORT=$((5001 + NODE_NUM * 10))
# The probability task only needs a short answer ("Probability: NN%" +
# one short reasoning sentence). 256 tokens leaves more KV-cache headroom on
# an 8GB GPU when the model and other GPU processes are already loaded.
MAX_NEW_TOKENS="${MAX_NEW_TOKENS:-256}"

CONFIG_FILE="${SCRIPT_DIR}/axl/node${NODE_NUM}-config.json"
PEM_FILE="${SCRIPT_DIR}/axl/node${NODE_NUM}-private.pem"
AXL_BIN="${SCRIPT_DIR}/axl/axl"

AXL_PID=""
ROUTER_PID=""
INFERENCE_PID=""

cleanup() {
  trap - EXIT INT TERM
  echo "[node${NODE_NUM}] Shutting down..."

  local pids=()
  [ -n "${INFERENCE_PID}" ] && pids+=("${INFERENCE_PID}")
  [ -n "${ROUTER_PID}" ] && pids+=("${ROUTER_PID}")
  [ -n "${AXL_PID}" ] && pids+=("${AXL_PID}")

  if [ "${#pids[@]}" -eq 0 ]; then
    return
  fi

  kill "${pids[@]}" 2>/dev/null || true

  for _ in $(seq 1 20); do
    local alive=0
    for pid in "${pids[@]}"; do
      if kill -0 "${pid}" 2>/dev/null; then
        alive=1
        break
      fi
    done
    [ "${alive}" -eq 0 ] && break
    sleep 0.25
  done

  for pid in "${pids[@]}"; do
    if kill -0 "${pid}" 2>/dev/null; then
      echo "[node${NODE_NUM}] Force killing lingering PID ${pid}"
      kill -9 "${pid}" 2>/dev/null || true
    fi
  done

  wait "${pids[@]}" 2>/dev/null || true
}

trap cleanup EXIT INT TERM

echo "[node${NODE_NUM}] api=${API_PORT}  router=${ROUTER_PORT}  inference=${INFERENCE_PORT}"
echo "[node${NODE_NUM}] max_new_tokens=${MAX_NEW_TOKENS}"

# Validate AXL binary
if [ ! -f "${AXL_BIN}" ]; then
  echo "ERROR: AXL binary not found at ${AXL_BIN}"
  echo "  Build it: git clone https://github.com/gensyn-ai/axl && cd axl && make build"
  echo "  Then copy the binary to ${SCRIPT_DIR}/axl/axl"
  exit 1
fi

# Generate key if not present
if [ ! -f "${PEM_FILE}" ]; then
  echo "[node${NODE_NUM}] Generating ed25519 key: ${PEM_FILE}"
  openssl genpkey -algorithm ed25519 -out "${PEM_FILE}"
fi

# Write AXL config
cat > "${CONFIG_FILE}" <<EOF
{
  "PrivateKeyPath": "${PEM_FILE}",
  "Peers": ["tls://${BOOTSTRAP_IP}:9001"],
  "Listen": [],
  "api_port": ${API_PORT},
  "router_addr": "http://127.0.0.1",
  "router_port": ${ROUTER_PORT},
  "conn_read_timeout_secs": 1800,
  "conn_idle_timeout_secs": 1800
}
EOF
echo "[node${NODE_NUM}] Wrote ${CONFIG_FILE}"

# Start AXL node
echo "[node${NODE_NUM}] Starting AXL..."
"${AXL_BIN}" --config "${CONFIG_FILE}" &
AXL_PID=$!
echo "[node${NODE_NUM}] AXL PID: ${AXL_PID}"

# Wait for AXL HTTP API to become ready
echo "[node${NODE_NUM}] Waiting for AXL API..."
for i in $(seq 1 20); do
  if curl -sf "http://127.0.0.1:${API_PORT}/topology" > /dev/null 2>&1; then
    echo "[node${NODE_NUM}] AXL ready."
    break
  fi
  if [ "${i}" -eq 20 ]; then
    echo "ERROR: AXL did not become ready after 40s — check logs above."
    kill "${AXL_PID}" 2>/dev/null || true
    exit 1
  fi
  sleep 2
done

# Start MCP router
echo "[node${NODE_NUM}] Starting MCP router on port ${ROUTER_PORT}..."
python3 "${SCRIPT_DIR}/mcp_router.py" --port "${ROUTER_PORT}" &
ROUTER_PID=$!
echo "[node${NODE_NUM}] MCP router PID: ${ROUTER_PID}"
sleep 2

# Start inference node
echo "[node${NODE_NUM}] Starting inference_node.py..."
python3 "${SCRIPT_DIR}/inference_node.py" \
  --api-port    "${API_PORT}"     \
  --router-port "${ROUTER_PORT}"  \
  --inference-port "${INFERENCE_PORT}" \
  --max-new-tokens "${MAX_NEW_TOKENS}" \
  --axl-config  "${CONFIG_FILE}"  \
  &
INFERENCE_PID=$!
echo "[node${NODE_NUM}] inference_node.py PID: ${INFERENCE_PID}"

wait "${INFERENCE_PID}"
