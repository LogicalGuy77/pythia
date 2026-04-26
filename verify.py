#!/usr/bin/env python3
"""
Pythia standalone receipt verifier.

Usage:
  python verify.py --receipt path/to/receipt.json
  python verify.py --receipt path/to/receipt.json --validate-only
  python verify.py --receipt path/to/receipt.json --ree-path ./ree/ree.sh
"""
import argparse
import json
import subprocess
import sys


def parse_args():
    p = argparse.ArgumentParser(
        description="Verify a Pythia REE receipt",
        epilog=(
            "--validate-only checks structural integrity only (no Docker). "
            "Full verify re-runs inference in Docker and confirms bitwise reproducibility."
        ),
    )
    p.add_argument("--receipt",       required=True,
                   help="Path to the receipt JSON file to verify")
    p.add_argument("--ree-path",      default="./ree/ree.sh",
                   help="Path to ree.sh (default: ./ree/ree.sh)")
    p.add_argument("--validate-only", action="store_true",
                   help="Run structural validation only — skip Docker re-execution")
    return p.parse_args()


def main():
    args = parse_args()

    # Load receipt
    try:
        with open(args.receipt) as f:
            receipt = json.load(f)
    except FileNotFoundError:
        print(f"ERROR: File not found: {args.receipt}", file=sys.stderr)
        sys.exit(1)
    except json.JSONDecodeError as e:
        print(f"ERROR: Invalid JSON in receipt: {e}", file=sys.stderr)
        sys.exit(1)

    # Print summary
    print("=" * 60)
    print("Pythia Receipt Verifier")
    print("=" * 60)
    print(f"File:          {args.receipt}")
    print(f"Model:         {receipt.get('model_name', 'N/A')}")
    print(f"REE version:   {receipt.get('ree_version', 'N/A')}")
    print(f"Device:        {receipt.get('device_type', 'N/A')} / {receipt.get('device_name', 'N/A')}")
    print(f"Token count:   {receipt.get('token_count', 'N/A')}")
    print(f"Finish reason: {receipt.get('finish_reason', 'N/A')}")
    print(f"Prompt hash:   {receipt.get('prompt_hash', 'N/A')}")
    print(f"Receipt hash:  {receipt.get('receipt_hash', 'N/A')}")
    print()

    # Step 1: structural validation (fast, no Docker)
    print("Step 1/2  Structural validation...", end=" ", flush=True)
    validate = subprocess.run(
        ["gensyn-sdk", "validate", "--receipt-path", args.receipt],
        capture_output=True, text=True, timeout=30,
    )
    if validate.returncode != 0:
        print("FAILED")
        print(f"  {validate.stderr.strip()}", file=sys.stderr)
        sys.exit(1)
    print("OK")

    if args.validate_only:
        print("\nSkipped full verify (--validate-only).")
        print("\nResult: STRUCTURALLY VALID (not cryptographically verified)")
        sys.exit(0)

    # Step 2: full cryptographic verify (re-runs Docker inference)
    print("Step 2/2  Full cryptographic verify (runs Docker)...", end=" ", flush=True)
    verify = subprocess.run(
        [args.ree_path, "verify", "--receipt-path", args.receipt],
        capture_output=True, text=True, timeout=300,
    )
    if verify.returncode != 0:
        print("FAILED")
        print(f"  {verify.stderr.strip()}", file=sys.stderr)
        sys.exit(1)
    print("OK")

    print("\nResult: VERIFIED ✓")
    print("  The receipt is cryptographically valid and the inference is reproducible.")
    sys.exit(0)


if __name__ == "__main__":
    main()
