# AI Council — Consensus Prompt Engine

A 10-user consensus prompt engine powered by [OpenGradient](https://opengradient.ai) Trusted Execution Environment (TEE) with on-chain cryptographic proof settlement.

## How It Works

1. **Input** — 10 users each submit their own prompt contribution
2. **Review** — All inputs are merged into a single consensus prompt
3. **Vote** — Each user votes Approve or Reject; requires 6/10 (majority) to proceed
4. **Execute** — The approved prompt is sent to OpenGradient's decentralized TEE network via the x402 payment-gated API, routed through an Intel TDX node to the LLM provider
5. **Result** — The LLM response is returned alongside a cryptographic attestation proof that is permanently settled on the OpenGradient blockchain

## Stack

- **Frontend**: React + Vite + Tailwind CSS + shadcn/ui
- **Backend**: Express + SQLite (Drizzle ORM)
- **TEE**: [OpenGradient](https://opengradient.ai) x402 LLM inference (Intel TDX hardware-attested)
- **Default model**: `anthropic/claude-4.0-sonnet` (configurable via `OG_MODEL`)
- **Proof settlement**: OpenGradient blockchain (chain 10744), verified by 2/3+ validators

## Getting Started

```bash
npm install
npm run dev
```

The app runs on `http://localhost:5000`.

By default it runs in **demo mode** with a simulated response and attestation structure — no wallet needed.

## Live TEE Execution (OpenGradient)

To enable real on-chain TEE inference you need an Ethereum wallet funded with **OUSDC** on the OpenGradient network.

### Environment Variables

| Variable | Required | Description |
|---|---|---|
| `OG_PRIVATE_KEY` | **Yes** | Ethereum wallet private key (hex, with or without `0x` prefix) used to sign x402 payments |
| `OG_MODEL` | No | OpenGradient model to use (default: `anthropic/claude-4.0-sonnet`) |
| `OG_SETTLEMENT_MODE` | No | On-chain settlement mode (default: `SETTLE_METADATA`) |

### Wallet Setup (Step by Step)

1. **Create an Ethereum wallet** — use MetaMask, Rabby, or any EVM-compatible wallet. Export the private key.

2. **Add OpenGradient Mainnet to your wallet**:
   - Network name: `OpenGradient`
   - RPC URL: `https://rpc.opengradient.ai`
   - Chain ID: `10744`
   - Currency symbol: `OG`

3. **Get OUSDC** (the payment token for LLM inference on OpenGradient mainnet):
   - Bridge or swap into OUSDC on chain 10744
   - OUSDC contract: check [docs.opengradient.ai](https://docs.opengradient.ai)
   - Alternatively use Base Sepolia testnet with `$OPG` test tokens from the faucet (see below)

4. **Set the env var and run**:
   ```bash
   OG_PRIVATE_KEY=0xyourprivatekeyhere npm run dev
   ```

### Testnet (Free) Option

OpenGradient also supports Base Sepolia testnet with free `$OPG` test tokens:

1. Create a wallet
2. Visit the [OpenGradient SDK faucet](https://docs.opengradient.ai/developers/sdk/) to get test tokens
3. Run `opengradient config init` (Python SDK) to set up your account

> Note: The testnet uses a different endpoint and chain. The code defaults to mainnet (chain 10744). Ask the team for testnet endpoint details.

### Supported Models (TEE mode)

| Model | Provider |
|---|---|
| `anthropic/claude-4.0-sonnet` | Anthropic (default) |
| `anthropic/claude-3.5-haiku` | Anthropic |
| `openai/gpt-4.1` | OpenAI |
| `openai/gpt-4o` | OpenAI |
| `google/gemini-2.5-pro-preview` | Google |
| `google/gemini-2.5-flash-preview` | Google |
| `x-ai/grok-3-beta` | xAI |
| `x-ai/grok-4-1-fast-non-reasoning` | xAI |

All models route through Intel TDX TEE nodes — the gateway is hardware-attested even though inference runs at the provider.

## Settlement Modes

| Mode | On-Chain Data | Use Case |
|---|---|---|
| `SETTLE_METADATA` | Full prompt + full response + all metadata | Maximum auditability — anyone can verify exactly what was sent and received |
| `SETTLE` | Input/output hashes only | Privacy-preserving — proves execution without exposing content |
| `SETTLE_BATCH` | Aggregated batch hashes | High-volume / cost-efficient |

Default is `SETTLE_METADATA` so the consensus prompt and LLM response are permanently on-chain.

## Attestation Report Fields

| Field | Description |
|---|---|
| `provider` | `OpenGradient` |
| `model` | Model used for inference |
| `inferenceMode` | `TEE` — hardware-attested routing |
| `teeType` | `Intel TDX (hardware-attested)` |
| `network` | OpenGradient Mainnet (chain 10744) |
| `txHash` | On-chain settlement transaction hash |
| `blockExplorer` | Link to verify proof on OpenGradient explorer |
| `walletAddress` | Wallet that signed the x402 payment |
| `settlementMode` | How much data was recorded on-chain |
| `verified` | `true` when real TEE executed; `false` in demo mode |
| `timestamp` | ISO timestamp of execution |

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

## References

- [OpenGradient Docs — LLM Execution](https://docs.opengradient.ai/learn/onchain_inference/llm_execution.html)
- [OpenGradient SDK](https://docs.opengradient.ai/developers/sdk/llm.html)
- [OpenGradient Block Explorer](https://explorer.opengradient.ai)
- [x402 Payment Protocol](https://x402.org)
