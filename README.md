# AI Council — Consensus Prompt Engine

A single-prompt consensus engine: one prompt, council vote (6/10 majority), then verifiable AI execution inside a Trusted Execution Environment on **OpenGradient Testnet**.

## Flow

```
Prompt → Vote (6/10 majority) → TEE Execute → Result + On-Chain Proof
```

1. **Prompt** — anyone writes the prompt (up to 5,000 chars)
2. **Vote** — 10 council members (Alice–Jack) vote Approve/Reject. Need 6+ to proceed
3. **Execute** — prompt sent to OpenGradient TEE via x402 payment-gated API
4. **Result** — LLM response + cryptographic attestation proof settled on-chain

## Stack

- **Frontend**: React + Vite + Tailwind CSS + shadcn/ui
- **Backend**: Express + SQLite (Drizzle ORM)
- **TEE**: [OpenGradient Testnet](https://docs.opengradient.ai) x402 LLM inference (Intel TDX)
- **Payment**: `$OPG` token on Base Sepolia (chain 84532) — **free testnet tokens available**
- **Proof settlement**: OpenGradient Testnet (chain 10740), verified by 2/3+ validators
- **Default model**: `anthropic/claude-4.0-sonnet` (configurable)
- **Payment library**: [`@x402/fetch`](https://github.com/coinbase/x402) — handles 402 challenge-response automatically

## Getting Started

```bash
npm install
npm run dev
```

App runs on `http://localhost:5000`. Works in **demo mode** with no wallet needed.

## Live TEE on Testnet (Free)

### Environment Variables

| Variable | Required | Description |
|---|---|---|
| `OG_PRIVATE_KEY` | **Yes** | Ethereum wallet private key (hex, with or without `0x`) |
| `OG_MODEL` | No | LLM model ID (default: `anthropic/claude-4.0-sonnet`) |
| `OG_SETTLEMENT_MODE` | No | `SETTLE_METADATA` \| `SETTLE` \| `SETTLE_BATCH` (default: `SETTLE_METADATA`) |

### Testnet Setup (3 steps, free)

**1. Create a wallet**

Any EVM-compatible wallet works. Quickest options:
- MetaMask → create new account → export private key
- CLI: `npx @scure/bip39 generate` or `cast wallet new` (Foundry)
- Or generate one in Node: `node -e "const {ethers}=require('ethers'); console.log(ethers.Wallet.createRandom().privateKey)"`

**2. Get free $OPG testnet tokens**

Visit **[faucet.opengradient.ai](https://faucet.opengradient.ai)** — enter your wallet address, receive 0.1 OPG per request. No signup needed.

Token: `$OPG` at `0x240b09731D96979f50B2C649C9CE10FcF9C7987F` on Base Sepolia (chain 84532).

**3. Run the app**

```bash
OG_PRIVATE_KEY=0xyourprivatekeyhere npm run dev
```

That's it. The [`@x402/fetch`](https://github.com/coinbase/x402) library automatically handles the x402 payment flow:
- Initial request → server returns `402 Payment Required`
- Library signs the payment with your wallet
- Library retries → inference executes in TEE → proof settled on-chain

### Network Details

| Network | Purpose | Chain ID | RPC |
|---|---|---|---|
| Base Sepolia | Payment settlement ($OPG tokens) | 84532 | `https://sepolia.base.org` |
| OpenGradient Testnet | Proof settlement + block explorer | 10740 | `https://ogevmdevnet.opengradient.ai` |

Block explorer: [explorer.opengradient.ai](https://explorer.opengradient.ai)

### Supported Models (TEE)

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

### Settlement Modes

| Mode | On-Chain Data | Use Case |
|---|---|---|
| `SETTLE_METADATA` | Full prompt + response + metadata | Maximum auditability (default) |
| `SETTLE` | Input/output hashes only | Privacy-preserving |
| `SETTLE_BATCH` | Batch hashes | High-volume / lower cost |

## API Endpoints

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/session` | Get or create active session |
| `POST` | `/api/session/:id/prompt` | Submit prompt → moves to voting |
| `POST` | `/api/session/:id/vote` | Cast approve/reject vote |
| `GET` | `/api/session/:id/result` | Poll for TEE result |
| `POST` | `/api/session/new` | Start a new round |

## Attestation Fields

| Field | Description |
|---|---|
| `provider` | `OpenGradient Testnet` |
| `model` | LLM model used |
| `inferenceMode` | `TEE` — hardware-attested |
| `teeType` | `Intel TDX (hardware-attested)` |
| `paymentNetwork` | Base Sepolia (chain 84532) |
| `settlementNetwork` | OpenGradient Testnet (chain 10740) |
| `token` | `$OPG` contract address |
| `walletAddress` | Wallet that signed the payment |
| `txHash` | On-chain settlement transaction |
| `blockExplorer` | Link to verify proof |
| `verified` | `true` for live TEE; `false` in demo |

## Build

```bash
npm run build
NODE_ENV=production node dist/index.cjs
```

## References

- [OpenGradient Testnet Deployments](https://docs.opengradient.ai/learn/network/deployment.html)
- [OpenGradient x402 LLM Docs](https://docs.opengradient.ai/developers/sdk/llm.html)
- [x402 Protocol (Coinbase)](https://github.com/coinbase/x402)
- [$OPG Faucet](https://faucet.opengradient.ai)
- [Block Explorer](https://explorer.opengradient.ai)
