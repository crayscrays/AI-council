# AI Council — Consensus Prompt Engine

A 10-user consensus prompt engine powered by [Phala Network](https://phala.network) Trusted Execution Environment (TEE) with cryptographic attestation.

## How It Works

1. **Input** — 10 users each submit their own prompt contribution
2. **Review** — All inputs are merged into a single consensus prompt
3. **Vote** — Each user votes Approve or Reject; requires 6/10 (majority) to proceed
4. **Execute** — The approved prompt is sent to Phala Network's confidential AI API inside an Intel TDX + NVIDIA GPU TEE enclave
5. **Result** — The LLM response is returned alongside a full cryptographic attestation report

## Stack

- **Frontend**: React + Vite + Tailwind CSS + shadcn/ui
- **Backend**: Express + SQLite (Drizzle ORM)
- **TEE**: [Phala Network](https://phala.network) via [RedPill AI](https://red-pill.ai) (`phala/deepseek-chat-v3-0324`)
- **Attestation**: Intel TDX + NVIDIA GPU TEE, hardware-signed cryptographic proof

## Getting Started

```bash
npm install
npm run dev
```

The app runs on `http://localhost:5000`.

## Live TEE Execution

By default the app runs in **demo mode** with a simulated response and attestation structure.

To enable real Phala Network TEE inference:

1. Get an API key from [red-pill.ai](https://red-pill.ai)
2. Set the environment variable:
   ```bash
   REDPILL_API_KEY=your_key npm run dev
   ```
3. The app will call `phala/deepseek-chat-v3-0324` inside a hardware-sealed TEE enclave and return a real attestation report signed by the CPU hardware.

## Attestation Report Fields

| Field | Description |
|---|---|
| `nonce` | Fresh random value (prevents replay attacks) |
| `promptHash` | SHA-256 of the merged consensus prompt |
| `model` | Phala confidential model identifier |
| `tee_type` | Intel TDX + NVIDIA GPU TEE |
| `gateway` | `https://api.redpill.ai` |
| `measurements.hardware` | Hardware-level TEE measurement |
| `measurements.model_hash` | Verifies exact model version |
| `measurements.code_hash` | Confirms inference code integrity |
| `measurements.platform_cert` | Chain of trust to CPU vendor |

## API Endpoints

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/session` | Get or create active session |
| `POST` | `/api/session/:id/input` | Submit a user input |
| `POST` | `/api/session/:id/lock` | Lock inputs and move to voting |
| `POST` | `/api/session/:id/vote` | Cast a vote (approve/reject) |
| `GET` | `/api/session/:id/result` | Poll for TEE execution result |
| `POST` | `/api/session/new` | Start a new session |

## Build

```bash
npm run build
NODE_ENV=production node dist/index.cjs
```
