#!/usr/bin/env python3
"""
Pythia inference node — runs REE inference and serves results via AXL MCP.

Each node:
  1. Exposes a Flask MCP server (JSON-RPC 2.0) on --inference-port
  2. Registers the "infer" service with the AXL MCP router
  3. On each infer request: runs REE subprocess, finds the receipt, returns output + receipt
  4. Polls AXL /recv in a background thread for raw messages
"""
import argparse
import atexit
import glob
import json
import logging
import os
import re
import signal
import shutil
import socket
import subprocess
import sys
import threading
import time
from pathlib import Path
from typing import Optional, Tuple

import requests
from flask import Flask, request, jsonify


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

# ---------------------------------------------------------------------------
# System prompt
# ---------------------------------------------------------------------------
#
# The base Qwen model often refuses to answer probability questions ("I cannot
# predict the future..."). REE already applies the model's chat template for
# Qwen, so we pass the steering instruction as normal prompt text instead of
# raw ChatML tokens. This keeps REE's own tokenizer/template path in charge.
# coordinator.extract_probability() looks for "Probability: NN%" / "NN%" /
# "probability: 0.NN", so we ask the model to emit one of those.

DEFAULT_SYSTEM_PROMPT = (
    "You are Pythia, a probability estimator for prediction markets.\n"
    "Reply only as:\n"
    "Probability: NN%\n"
    "Reasoning: <one sentence>\n"
    "NN is an integer 0-100. Never refuse, never hedge."
)


def build_steered_prompt(system_prompt: str, user_prompt: str) -> str:
    """
    Prefix the user prompt with the Pythia instruction in plain text.

    REE's Qwen path logs "applying chat template"; if we pass raw ChatML here,
    those tokens become user-content inside another template. Plain text is the
    safer contract for REE's --prompt-text input.
    """
    return (
        f"{system_prompt}\n\n"
        "Question:\n"
        f"{user_prompt}\n\n"
        "Answer now using exactly the required format."
    )


def parse_args():
    p = argparse.ArgumentParser(description="Pythia inference node")
    p.add_argument("--api-port",       type=int, default=9012,
                   help="AXL HTTP API port for this node (default: 9012)")
    p.add_argument("--router-port",    type=int, default=9013,
                   help="AXL MCP router port for this node (default: 9013)")
    p.add_argument("--inference-port", type=int, default=5011,
                   help="Local Flask MCP server port (default: 5011)")
    p.add_argument("--axl-config",     default="axl/node1-config.json",
                   help="Path to AXL config JSON for this node")
    p.add_argument("--ree-path",       default="./ree/ree.sh",
                   help="Path to ree.sh script (default: ./ree/ree.sh)")
    p.add_argument("--model-name",     default="Qwen/Qwen2.5-3B",
                   help="HuggingFace model name to run in REE")
    p.add_argument("--max-new-tokens", type=int, default=200,
                   help="Max tokens for REE inference (default: 200)")
    p.add_argument(
        "--system-prompt",
        default=DEFAULT_SYSTEM_PROMPT,
        help="Steering instruction prepended to every user prompt",
    )
    p.add_argument(
        "--no-system-prompt",
        action="store_true",
        help="Disable the system prompt wrapper and pass user prompts raw",
    )
    p.add_argument("--log-level",      default="INFO",
                   choices=["DEBUG", "INFO", "WARNING", "ERROR"])
    return p.parse_args()


# ---------------------------------------------------------------------------
# REE invocation
# ---------------------------------------------------------------------------

def run_ree_inference(
    ree_path: str,
    model_name: str,
    prompt: str,
    max_new_tokens: int = 200,
) -> Tuple[str, dict]:
    """
    Invoke REE CLI as a subprocess and return (text_output, receipt_dict).

    REE writes receipts to:
      ~/.cache/gensyn/<model_name>/<task-id>/metadata/receipt_*.json

    We record a timestamp before the run, then pick the newest receipt file
    that appeared after that timestamp.
    """
    run_start_time = time.time()

    cmd = [
        ree_path,
        "--model-name", model_name,
        "--prompt-text", prompt,
        "--max-new-tokens", str(max_new_tokens),
    ]
    logging.info("Running REE: %s", " ".join(cmd))

    result = _run_ree_command(cmd)

    if result.returncode != 0:
        # Surface both streams because shell wrappers and Docker may split
        # useful failure details across stdout/stderr.
        logging.error("REE stdout: %s", result.stdout)
        logging.error("REE stderr: %s", result.stderr)
        combined = (result.stderr or "") + (result.stdout or "")

        # The REE on-disk cache can land in two distinct broken states:
        #
        # 1. Stale compiled artifacts:
        #      compiled-artifacts-reproducible/gensyn_module.py
        #      ValueError: offset (...) must be ... no greater than buffer length
        #    Fix: delete `compiled-artifacts-reproducible/` and retry.
        #
        # 2. Corrupt model export (typically caused by two REE processes
        #    racing on prepare_task before we serialized them with a flock):
        #      InvalidModel: Tensor offset overflows tensor file tensors.binary
        #      ValueError: offset ... no greater than buffer length
        #      ...inside conversion/modules.py during torch.frombuffer
        #    Fix: delete the entire `model/` dir for that task hash so REE
        #    re-runs the export from a clean slate.
        #
        # Both are recoverable without operator intervention; we attempt one
        # auto-repair and retry once.
        kind = _classify_cache_corruption(combined)
        if kind is not None:
            repaired = _repair_ree_cache(model_name, combined, kind=kind)
            if repaired:
                logging.warning(
                    "REE cache looked corrupt (kind=%s); cleaned and retrying once.",
                    kind,
                )
                result = _run_ree_command(cmd)
                if result.returncode == 0:
                    logging.info("REE retry succeeded after cache repair")
                else:
                    logging.error("REE retry stdout: %s", result.stdout)
                    logging.error("REE retry stderr: %s", result.stderr)
                    combined = (result.stderr or "") + (result.stdout or "")

        if result.returncode == 0:
            logging.debug("REE stdout: %s", result.stdout[:1000])
            receipt = _find_latest_receipt(model_name, run_start_time)
            if receipt is None:
                raise RuntimeError(
                    "REE ran successfully but no receipt file found under "
                    f"~/.cache/gensyn/ for model '{model_name}'"
                )
            output = receipt.get("output", {})
            text_output = receipt.get("text_output") or output.get("text_output", "")
            return text_output, receipt

        raise RuntimeError(
            f"REE exited with code {result.returncode}: {combined[-500:].strip()}"
        )

    logging.debug("REE stdout: %s", result.stdout[:1000])

    receipt = _find_latest_receipt(model_name, run_start_time)
    if receipt is None:
        raise RuntimeError(
            "REE ran successfully but no receipt file found under "
            f"~/.cache/gensyn/ for model '{model_name}'"
        )

    output = receipt.get("output", {})
    text_output = receipt.get("text_output") or output.get("text_output", "")
    return text_output, receipt


def _run_ree_command(cmd: list[str]) -> subprocess.CompletedProcess[str]:
    """Run REE and normalize common process-level failures."""
    try:
        return subprocess.run(
            cmd,
            capture_output=True,
            text=True,
            timeout=1800,  # 30-min timeout; first run downloads Docker image + model
        )
    except subprocess.TimeoutExpired:
        raise RuntimeError("REE inference timed out after 1800s")
    except FileNotFoundError:
        raise RuntimeError(f"REE script not found at: {cmd[0]}")


def _classify_cache_corruption(output: str) -> Optional[str]:
    """
    Identify which kind of REE cache corruption (if any) caused this failure.

    Returns:
      - "compiled-artifacts": stale compiled artifacts; recoverable by
        deleting just `compiled-artifacts-reproducible/`.
      - "model-export": corrupt ONNX export (typically `tensors.binary`);
        recoverable by deleting the full `model/` directory so REE re-runs
        `prepare_task` from scratch.
      - None: not a cache-corruption failure we can safely auto-repair.
    """
    if "Tensor offset overflows tensor file tensors.binary" in output:
        return "model-export"

    if "tensors.binary" in output and "buffer length" in output and "offset" in output:
        return "model-export"

    if (
        "compiled-artifacts-reproducible" in output
        and "buffer length" in output
        and "ValueError: offset" in output
    ):
        return "compiled-artifacts"

    return None


def _find_corrupt_task_dir(model_name: str, output: str) -> Optional[Path]:
    """Best-effort extraction of the host-side task_dir from REE's traceback."""
    model_dir = re.escape(model_name.replace("/", "--"))
    patterns = [
        rf"task_dir=([^\s,]+/{model_dir}/[0-9a-f]+)",
        rf"([^\s'\"]+/{model_dir}/[0-9a-f]+)/model[/'\"]",
        rf"([^\s'\"]+/{model_dir}/[0-9a-f]+)",
    ]
    for pat in patterns:
        match = re.search(pat, output)
        if match:
            return Path(match.group(1))
    return None


def _repair_ree_cache(model_name: str, output: str, *, kind: str) -> bool:
    """
    Delete the corrupt subtree of the REE cache so the next run rebuilds it.

    For `compiled-artifacts` corruption we only nuke `compiled-artifacts-
    reproducible/` — reusing `model.onnx` is much faster and the traceback
    points specifically at compiled artifacts.

    For `model-export` corruption (e.g. truncated `tensors.binary` from a
    concurrent-export race) we have to nuke the entire `model/` directory:
    the ONNX graph and tensor file are produced together and a partially
    written tensor file can't be salvaged.
    """
    task_dir = _find_corrupt_task_dir(model_name, output)
    if task_dir is None:
        logging.warning("Could not locate corrupt REE task dir in error output")
        return False

    if kind == "compiled-artifacts":
        target = task_dir / "model" / "compiled-artifacts-reproducible"
    elif kind == "model-export":
        target = task_dir / "model"
    else:
        return False

    try:
        if target.exists():
            shutil.rmtree(target)
            logging.warning("Deleted corrupt REE cache subtree: %s", target)
            return True
        logging.warning("REE cache subtree not found: %s", target)
        return False
    except OSError as e:
        logging.warning("Failed to delete REE cache subtree %s: %s", target, e)
        return False


def _find_latest_receipt(model_name: str, after_timestamp: float) -> Optional[dict]:
    """
    Glob for receipt JSON files and return the one created most recently
    after `after_timestamp`. Falls back to the globally newest receipt if
    no file has a newer mtime (e.g. container clock skew).
    """
    cache_base = Path.home() / ".cache" / "gensyn"

    # REE encodes model names with "--" instead of "/" in the cache dir
    # e.g. "Qwen/Qwen2.5-3B" -> "Qwen--Qwen2.5-3B"
    model_dir = model_name.replace("/", "--")
    model_cache = cache_base / model_dir
    pattern = str(model_cache / "**" / "receipt_*.json")
    candidates = glob.glob(pattern, recursive=True)

    if not candidates:
        # Fallback: search entire gensyn cache for any receipt
        fallback = str(cache_base / "**" / "receipt_*.json")
        candidates = glob.glob(fallback, recursive=True)

    if not candidates:
        return None

    recent = [f for f in candidates if os.path.getmtime(f) >= after_timestamp]

    if not recent:
        logging.warning(
            "No receipt newer than run start; using most-recent existing receipt"
        )
        recent = candidates

    recent.sort(key=os.path.getmtime, reverse=True)
    newest = recent[0]
    logging.info("Found receipt: %s", newest)

    try:
        with open(newest) as f:
            return json.load(f)
    except (json.JSONDecodeError, IOError) as e:
        logging.error("Failed to parse receipt %s: %s", newest, e)
        return None


# ---------------------------------------------------------------------------
# Flask MCP server (JSON-RPC 2.0)
# ---------------------------------------------------------------------------

def create_flask_app(
    ree_path: str,
    model_name: str,
    max_new_tokens: int,
    system_prompt: Optional[str] = None,
) -> Flask:
    app = Flask(__name__)

    @app.route("/", methods=["POST"])
    def mcp_handler():
        body = request.get_json(force=True, silent=True)
        if body is None:
            return _rpc_error(None, -32700, "Parse error"), 400

        req_id = body.get("id")
        method = body.get("method", "")
        params = body.get("params", {})

        if method == "tools/list":
            return jsonify({
                "jsonrpc": "2.0",
                "id": req_id,
                "result": {
                    "tools": [{
                        "name": "infer",
                        "description": (
                            "Run LLM inference via REE and return output "
                            "with a cryptographic reproducibility receipt."
                        ),
                        "inputSchema": {
                            "type": "object",
                            "properties": {
                                "prompt": {
                                    "type": "string",
                                    "description": "The prompt to run inference on"
                                }
                            },
                            "required": ["prompt"]
                        }
                    }]
                }
            })

        elif method == "tools/call":
            tool_name = params.get("name", "")
            arguments = params.get("arguments", {})

            if tool_name != "infer":
                return _rpc_error(req_id, -32601, f"Unknown tool: {tool_name}")

            prompt = arguments.get("prompt")
            if not prompt or not isinstance(prompt, str):
                return _rpc_error(req_id, -32602,
                                  "Missing or invalid 'prompt' in arguments")

            # Prefix the user prompt with the Pythia instruction so the model
            # produces a parseable probability estimate. The receipt records
            # the exact steered prompt so verifiers can re-derive the same
            # output deterministically.
            wrapped = (
                build_steered_prompt(system_prompt, prompt)
                if system_prompt
                else prompt
            )

            try:
                text_output, receipt = run_ree_inference(
                    ree_path, model_name, wrapped, max_new_tokens
                )
                return jsonify({
                    "jsonrpc": "2.0",
                    "id": req_id,
                    "result": {
                        "content": [{"type": "text", "text": text_output}],
                        "receipt": receipt,
                        "isError": False,
                    }
                })
            except RuntimeError as e:
                logging.error("Inference failed: %s", e)
                return _rpc_error(req_id, -32000, str(e))

        else:
            return _rpc_error(req_id, -32601, f"Method not found: {method}")

    @app.route("/health", methods=["GET"])
    def health():
        return jsonify({"status": "ok", "model": model_name})

    return app


def _rpc_error(req_id, code: int, message: str):
    # AXL's RouterResponse.error must be a plain string, not an object
    return jsonify({
        "jsonrpc": "2.0",
        "id": req_id,
        "error": f"{code}: {message}"
    })


# ---------------------------------------------------------------------------
# AXL MCP router registration
# ---------------------------------------------------------------------------

def register_with_mcp_router(
    router_port: int,
    inference_port: int,
    retries: int = 10,
    delay: float = 2.0,
):
    """
    Register our Flask server with the AXL MCP router.
    Retries because AXL may not be ready immediately after startup.
    Deregisters any existing 'infer' entry first to handle crash-restarts.
    """
    base = f"http://127.0.0.1:{router_port}"

    # Best-effort cleanup of stale registration
    try:
        requests.delete(f"{base}/register/infer", timeout=3)
    except Exception:
        pass

    payload = {
        "service": "infer",
        "endpoint": f"http://127.0.0.1:{inference_port}",
    }

    for attempt in range(1, retries + 1):
        try:
            resp = requests.post(f"{base}/register", json=payload, timeout=5)
            if resp.status_code in (200, 201, 204):
                logging.info(
                    "Registered 'infer' with MCP router on port %d -> inference port %d",
                    router_port, inference_port,
                )
                return
            logging.warning(
                "MCP register attempt %d/%d returned %d: %s",
                attempt, retries, resp.status_code, resp.text[:200],
            )
        except requests.ConnectionError:
            logging.warning(
                "MCP router not ready (attempt %d/%d), retrying in %.1fs...",
                attempt, retries, delay,
            )
        time.sleep(delay)

    raise RuntimeError(
        f"Could not register with MCP router on port {router_port} "
        f"after {retries} attempts"
    )


def deregister_from_mcp_router(router_port: int):
    """Best-effort deregistration at shutdown."""
    try:
        requests.delete(
            f"http://127.0.0.1:{router_port}/register/infer", timeout=3
        )
        logging.info("Deregistered 'infer' from MCP router")
    except Exception as e:
        logging.debug("Deregistration failed (non-fatal): %s", e)


# ---------------------------------------------------------------------------
# Local server preflight
# ---------------------------------------------------------------------------

def ensure_port_available(host: str, port: int):
    """Fail before MCP registration if the Flask port is already occupied."""
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        try:
            sock.bind((host, port))
        except OSError as e:
            raise RuntimeError(
                f"Inference port {host}:{port} is already in use. "
                "Stop the old node process or choose a different node number."
            ) from e


# ---------------------------------------------------------------------------
# Background /recv poll thread
# ---------------------------------------------------------------------------

def start_recv_poll_thread(api_port: int, stop_event: threading.Event):
    """Poll AXL /recv every 2s and log any raw messages from peers."""
    def _poll():
        url = f"http://127.0.0.1:{api_port}/recv"
        while not stop_event.is_set():
            try:
                resp = requests.get(url, timeout=5)
                if resp.status_code == 200:
                    peer_id = resp.headers.get("X-From-Peer-Id", "unknown")
                    logging.info(
                        "[RECV] Message from peer %s...%s: %s",
                        peer_id[:8], peer_id[-8:], resp.content[:200],
                    )
                # 204 = empty queue; continue silently
            except requests.ConnectionError:
                logging.debug("AXL not reachable on port %d", api_port)
            except Exception as e:
                logging.debug("recv poll error: %s", e)
            stop_event.wait(timeout=2.0)

    t = threading.Thread(target=_poll, daemon=True, name="recv-poll")
    t.start()
    return t


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
    if not os.path.isfile(ree_path):
        logging.error("REE script not found at %s", ree_path)
        sys.exit(1)

    logging.info(
        "Starting Pythia inference node  "
        "inference_port=%d  api_port=%d  router_port=%d  model=%s",
        args.inference_port, args.api_port, args.router_port, args.model_name,
    )

    try:
        ensure_port_available("127.0.0.1", args.inference_port)
    except RuntimeError as e:
        logging.error("%s", e)
        sys.exit(1)

    # Register with AXL MCP router (retries until AXL is up)
    register_with_mcp_router(args.router_port, args.inference_port)

    # Deregister cleanly on shutdown
    stop_event = threading.Event()

    def _shutdown(signum=None, frame=None):
        logging.info("Shutting down inference node...")
        stop_event.set()
        deregister_from_mcp_router(args.router_port)
        sys.exit(0)

    atexit.register(deregister_from_mcp_router, args.router_port)
    signal.signal(signal.SIGTERM, _shutdown)
    signal.signal(signal.SIGINT, _shutdown)

    # Background recv poller
    start_recv_poll_thread(args.api_port, stop_event)

    # Start Flask MCP server (blocking)
    system_prompt = None if args.no_system_prompt else args.system_prompt
    if system_prompt:
        logging.info("System prompt enabled (%d chars)", len(system_prompt))
    else:
        logging.info("System prompt disabled (raw user prompts)")

    app = create_flask_app(
        ree_path,
        args.model_name,
        args.max_new_tokens,
        system_prompt=system_prompt,
    )
    logging.info("MCP inference server listening on 127.0.0.1:%d", args.inference_port)
    app.run(host="127.0.0.1", port=args.inference_port, debug=False)


if __name__ == "__main__":
    main()
