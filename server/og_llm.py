#!/usr/bin/env python3
"""Runs an OpenGradient TEE LLM chat inference via the official SDK.

Reads the user prompt from stdin, writes a single JSON object to stdout.
"""

# server/types.py shadows the stdlib 'types' module when Python adds this
# directory to sys.path. Remove it before any other imports.
import sys as _sys, os as _os
_here = _os.path.dirname(_os.path.abspath(__file__))
while _here in _sys.path:
    _sys.path.remove(_here)

import asyncio
import json
import os
import sys
from pathlib import Path

from dotenv import load_dotenv
import opengradient as og

# Load .env from the project root (two levels up from this script)
load_dotenv(Path(__file__).parent.parent / ".env")


async def main() -> None:
    private_key = os.environ.get("OG_PRIVATE_KEY", "")
    if not private_key:
        print(json.dumps({"error": "OG_PRIVATE_KEY not set"}))
        sys.exit(1)

    prompt = sys.stdin.read().strip()
    if not prompt:
        print(json.dumps({"error": "No prompt provided"}))
        sys.exit(1)

    model_str = os.environ.get("OG_MODEL", "anthropic/claude-opus-4-6")
    try:
        model = og.TEE_LLM(model_str)
    except ValueError:
        model = og.TEE_LLM.CLAUDE_OPUS_4_6

    llm = og.LLM(private_key=private_key)
    llm.ensure_opg_approval(min_allowance=0.1)

    # Capture x-processing-hash as a reliable fallback — the SDK exposes
    # data_settlement_transaction_hash (x-settlement-tx-hash) but that header
    # is only present once the settlement tx is mined, which may not be
    # synchronous. x-processing-hash is always returned immediately.
    processing_hashes: list[str] = []

    async def _capture_processing_hash(response) -> None:
        h = response.headers.get("x-processing-hash")
        if h:
            processing_hashes.append(h)

    http_client = llm._tee.get().http_client
    http_client.event_hooks.setdefault("response", []).append(_capture_processing_hash)

    result = await llm.chat(
        model=model,
        messages=[
            {
                "role": "system",
                "content": (
                    "You are a helpful AI assistant running inside a Trusted Execution Environment (TEE) "
                    "on OpenGradient's decentralized network. Your responses are cryptographically verified "
                    "and settled on-chain."
                ),
            },
            {"role": "user", "content": prompt},
        ],
        max_tokens=1024,
        temperature=0.7,
        x402_settlement_mode=og.x402SettlementMode.INDIVIDUAL_FULL,
    )

    await llm.close()

    # Prefer the SDK's settlement tx hash; fall back to the processing hash
    tx_hash = result.data_settlement_transaction_hash or (
        processing_hashes[-1] if processing_hashes else None
    )

    # Debug: dump every field on the result so we can see what the API returns
    print("\n" + "=" * 40, file=sys.stderr)
    print(f"[DEBUG] data_settlement_transaction_hash : {result.data_settlement_transaction_hash}", file=sys.stderr)
    print(f"[DEBUG] data_settlement_blob_id          : {result.data_settlement_blob_id}", file=sys.stderr)
    print(f"[DEBUG] payment_hash                     : {result.payment_hash}", file=sys.stderr)
    print(f"[DEBUG] tee_signature                    : {result.tee_signature}", file=sys.stderr)
    print(f"[DEBUG] tee_id                           : {result.tee_id}", file=sys.stderr)
    print(f"[DEBUG] tee_payment_address              : {result.tee_payment_address}", file=sys.stderr)
    print(f"[DEBUG] processing_hash (header hook)    : {processing_hashes}", file=sys.stderr)
    print(f"[DEBUG] tx_hash (resolved)               : {tx_hash}", file=sys.stderr)
    if tx_hash:
        print(f"Explorer: https://explorer.opengradient.ai/tx/{tx_hash}?tab=inferences", file=sys.stderr)
    print("=" * 40, file=sys.stderr)

    print(json.dumps({
        "response": result.chat_output.get("content", "") if result.chat_output else "",
        "finish_reason": result.finish_reason,
        "tx_hash": tx_hash,
        "tee_signature": result.tee_signature,
        "tee_timestamp": result.tee_timestamp,
        "tee_id": result.tee_id,
        "tee_endpoint": result.tee_endpoint,
        "tee_payment_address": result.tee_payment_address,
        "model": model_str,
    }))


asyncio.run(main())
