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

    # The SDK defines x-processing-hash but never reads it back.
    # Hook into the underlying httpx client to capture it ourselves.
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

    processing_hash = processing_hashes[-1] if processing_hashes else None

    print(json.dumps({
        "response": result.chat_output.get("content", "") if result.chat_output else "",
        "finish_reason": result.finish_reason,
        "processing_hash": processing_hash,
        "tee_signature": result.tee_signature,
        "tee_timestamp": result.tee_timestamp,
        "tee_id": result.tee_id,
        "tee_endpoint": result.tee_endpoint,
        "tee_payment_address": result.tee_payment_address,
        "model": model_str,
    }))


asyncio.run(main())
