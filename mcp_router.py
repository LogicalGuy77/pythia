#!/usr/bin/env python3
"""
Minimal MCP router for Pythia.
Forwards JSON-RPC requests from AXL to local backend services.
"""
import argparse
import json
import logging
import sys

import requests
from flask import Flask, request, jsonify

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

app = Flask(__name__)

# Service registry: {service_name: endpoint_url}
SERVICES = {}


@app.route("/register", methods=["POST"])
def register():
    """Register a service endpoint."""
    body = request.get_json(force=True, silent=True)
    if not body:
        return jsonify({"error": "Invalid JSON"}), 400

    service = body.get("service")
    endpoint = body.get("endpoint")

    if not service or not endpoint:
        return jsonify({"error": "Missing 'service' or 'endpoint'"}), 400

    SERVICES[service] = endpoint
    logger.info(f"Registered service '{service}' → {endpoint}")
    return jsonify({"status": "registered", "service": service}), 201


@app.route("/register/<service>", methods=["DELETE"])
def deregister(service: str):
    """Deregister a service."""
    if service in SERVICES:
        del SERVICES[service]
        logger.info(f"Deregistered service '{service}'")
    return jsonify({"status": "deregistered"}), 200


@app.route("/services", methods=["GET"])
def list_services():
    """List all registered services."""
    return jsonify({"services": list(SERVICES.keys())}), 200


@app.route("/health", methods=["GET"])
def health():
    """Health check."""
    return jsonify({"status": "ok"}), 200


@app.route("/route", methods=["POST"])
def route_request():
    """
    Forward a JSON-RPC request to the appropriate backend service.

    AXL sends the raw JSON-RPC body to /route with the service name
    extracted from the URL path it received (/mcp/{peer_id}/{service}).
    The body is the raw JSON-RPC payload — we forward it directly.
    """
    raw = request.get_data()
    body = request.get_json(force=True, silent=True)
    logger.info(f"[/route] headers: {dict(request.headers)}")
    logger.info(f"[/route] body: {raw[:500]}")

    if not body:
        return jsonify({"error": "Invalid JSON"}), 400

    # AXL may include service name in a header or in the body.
    # Try header first, then body field, then fall back to first registered service.
    service = (
        request.headers.get("X-Service-Name")
        or request.headers.get("X-Mcp-Service")
        or body.get("service")
        or (list(SERVICES.keys())[0] if SERVICES else None)
    )
    # The actual JSON-RPC payload: AXL may wrap it or send it directly
    rpc_request = body.get("request") or body.get("body") or body

    logger.info(f"[/route] resolved service={service!r}  registered={list(SERVICES.keys())}")

    if not service or service not in SERVICES:
        # If only one service registered, use it regardless
        if len(SERVICES) == 1:
            service = list(SERVICES.keys())[0]
        else:
            return jsonify({"error": f"Unknown service: {service!r}", "registered": list(SERVICES.keys())}), 404

    endpoint = SERVICES[service]
    logger.info(f"[/route] forwarding to {endpoint}: {str(rpc_request)[:200]}")

    try:
        resp = requests.post(endpoint, json=rpc_request, timeout=360)
        resp.raise_for_status()
        return resp.json(), resp.status_code
    except requests.RequestException as e:
        logger.error(f"Failed to route to {endpoint}: {e}")
        return jsonify({"error": str(e)}), 500


def main():
    parser = argparse.ArgumentParser(description="Minimal MCP router for Pythia")
    parser.add_argument("--port", type=int, default=9003, help="Listen port")
    parser.add_argument("--host", default="127.0.0.1", help="Listen address")
    args = parser.parse_args()

    logger.info(f"MCP router listening on {args.host}:{args.port}")
    app.run(host=args.host, port=args.port, debug=False)


if __name__ == "__main__":
    main()
