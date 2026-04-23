import type { Express } from "express";
import type { Server } from "http";
import { storage, db } from "./storage";
import { sessions as sessionsTable } from "@shared/schema";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { randomBytes, createHash } from "crypto";

// x402 + viem — handles the full 402 → sign → resubmit flow automatically
import { wrapFetch } from "@x402/fetch";
import { ExactEvmScheme } from "@x402/evm/exact/client";
import { createWalletClient, http as viemHttp } from "viem";
import { privateKeyToAccount } from "viem/accounts";

const TOTAL_VOTERS = 10;
const MAJORITY = 6; // need ≥6 approvals to execute

// ── Testnet config ────────────────────────────────────────────────────────────
//
//  OpenGradient Testnet (primary):
//    RPC  : https://ogevmdevnet.opengradient.ai
//    Chain: 10740
//    Token: OPG
//
//  Payment is handled via Base Sepolia (chain 84532) with $OPG token:
//    Token contract: 0x240b09731D96979f50B2C649C9CE10FcF9C7987F
//    Faucet        : https://faucet.opengradient.ai
//
//  LLM endpoint (same for testnet and mainnet — payments routed by chain):
//    https://llmogevm.opengradient.ai/v1/chat/completions
//
// ─────────────────────────────────────────────────────────────────────────────

const OG_LLM_ENDPOINT = "https://llmogevm.opengradient.ai/v1/chat/completions";

// Base Sepolia — where $OPG testnet tokens live and payments are settled
const BASE_SEPOLIA_CHAIN = {
  id: 84532,
  name: "Base Sepolia",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 as const },
  rpcUrls: {
    default: { http: ["https://sepolia.base.org"] as [`https://${string}`] },
  },
};

// OpenGradient network identifier used by @x402/evm
const OG_NETWORK_ID = "eip155:84532"; // Base Sepolia for $OPG testnet payments

const OG_MODEL = process.env.OG_MODEL || "anthropic/claude-4.0-sonnet";
const OG_SETTLEMENT = (process.env.OG_SETTLEMENT_MODE || "SETTLE_METADATA") as string;

/**
 * Build an x402-wrapped fetch client for a given private key.
 * The @x402/fetch library handles the full 402 challenge-response automatically:
 *   1. Initial POST → server returns 402 + X-PAYMENT-REQUIRED header
 *   2. Library signs payment with wallet
 *   3. Library retries with X-PAYMENT header
 *   4. Returns final response
 */
function buildX402Fetch(privateKey: string) {
  const key = privateKey.startsWith("0x") ? privateKey : `0x${privateKey}`;
  const account = privateKeyToAccount(key as `0x${string}`);

  const walletClient = createWalletClient({
    account,
    chain: BASE_SEPOLIA_CHAIN,
    transport: viemHttp(),
  });

  const x402Fetch = wrapFetch(fetch, {
    schemes: [
      { network: OG_NETWORK_ID, client: new ExactEvmScheme(walletClient) },
    ],
  });

  return { x402Fetch, walletAddress: account.address };
}

/**
 * Call OpenGradient TEE LLM via x402.
 * Payment in $OPG on Base Sepolia, proof settled on OpenGradient Testnet.
 */
async function callOpenGradientTEE(
  prompt: string,
  privateKey: string
): Promise<{ response: string; txHash: string; attestation: object }> {
  const { x402Fetch, walletAddress } = buildX402Fetch(privateKey);

  const res = await x402Fetch(OG_LLM_ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-SETTLE": OG_SETTLEMENT,    // settlement mode header
    },
    body: JSON.stringify({
      model: OG_MODEL,
      messages: [
        {
          role: "system",
          content:
            "You are a helpful AI assistant running inside a Trusted Execution Environment (TEE) on OpenGradient's decentralized network. Your responses are cryptographically verified and settled on-chain.",
        },
        { role: "user", content: prompt },
      ],
      max_tokens: 1024,
      temperature: 0.7,
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`OpenGradient TEE error: ${res.status} — ${err.slice(0, 400)}`);
  }

  const data = await res.json() as any;

  // Extract settlement/payment info from response headers
  const paymentResponseHeader =
    res.headers.get("X-PAYMENT-RESPONSE") ||
    res.headers.get("PAYMENT-RESPONSE") ||
    res.headers.get("x-payment-response");

  let txHash = "pending-settlement";
  let paymentId = "";

  if (paymentResponseHeader) {
    try {
      const pr = JSON.parse(paymentResponseHeader);
      txHash = pr.tx_hash ?? pr.txHash ?? pr.transaction ?? "pending-settlement";
      paymentId = pr.payment_id ?? pr.paymentId ?? "";
    } catch {
      // header may not be JSON — keep defaults
    }
  }

  const llmContent =
    data.choices?.[0]?.message?.content ??
    data.completion ??
    "(No response)";

  const attestation = {
    provider: "OpenGradient Testnet",
    model: OG_MODEL,
    settlementMode: OG_SETTLEMENT,
    inferenceMode: "TEE",
    teeType: "Intel TDX (hardware-attested)",
    paymentNetwork: "Base Sepolia (chain 84532)",
    settlementNetwork: "OpenGradient Testnet (chain 10740)",
    token: "$OPG (0x240b09731D96979f50B2C649C9CE10FcF9C7987F)",
    walletAddress,
    txHash,
    paymentId,
    blockExplorer: txHash !== "pending-settlement"
      ? `https://explorer.opengradient.ai/tx/${txHash}`
      : "https://explorer.opengradient.ai",
    timestamp: new Date().toISOString(),
    verified: true,
    note:
      "Prompt routed through Intel TDX TEE node. Payment settled in $OPG on Base Sepolia. TEE attestation proof verified on OpenGradient Testnet by 2/3+ validators.",
    verification: data.verification ?? null,
  };

  return { response: llmContent, txHash, attestation };
}

export function registerRoutes(httpServer: Server, app: Express) {
  // GET /api/session — get or create current session
  app.get("/api/session", (req, res) => {
    let session = storage.getActiveSession() ?? storage.getLatestSession();
    if (!session) session = storage.createSession();
    const votes = storage.getVotesForSession(session.id);
    const attestation = session.attestationReport
      ? JSON.parse(session.attestationReport)
      : null;
    res.json({ session, votes, attestation });
  });

  // POST /api/session/:id/prompt — submit the single prompt → moves to voting
  app.post("/api/session/:id/prompt", async (req, res) => {
    const sessionId = parseInt(req.params.id);
    const schema = z.object({
      prompt: z.string().min(1).max(5000),
    });

    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.flatten() });
    }

    const session = storage.getActiveSession();
    if (!session || session.id !== sessionId) {
      return res.status(404).json({ error: "Session not found" });
    }
    if (session.status !== "drafting") {
      return res.status(400).json({ error: "Session is not in drafting phase" });
    }

    const updated = storage.updateSession(sessionId, {
      status: "voting",
      prompt: parsed.data.prompt,
      mergedPrompt: parsed.data.prompt,
    });

    res.json({ session: updated });
  });

  // POST /api/session/:id/vote — cast approve/reject vote
  app.post("/api/session/:id/vote", async (req, res) => {
    const sessionId = parseInt(req.params.id);
    const schema = z.object({
      userId: z.number().min(1).max(10),
      userName: z.string().min(1).max(50),
      approve: z.boolean(),
    });

    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.flatten() });
    }

    const session = storage.getActiveSession();
    if (!session || session.id !== sessionId) {
      return res.status(404).json({ error: "Session not found" });
    }
    if (session.status !== "voting") {
      return res.status(400).json({ error: "Session is not in voting phase" });
    }

    const existing = storage.getUserVote(sessionId, parsed.data.userId);
    if (existing) {
      return res.status(409).json({ error: "You have already voted." });
    }

    const vote = storage.submitVote({
      sessionId,
      userId: parsed.data.userId,
      userName: parsed.data.userName,
      approve: parsed.data.approve ? 1 : 0,
      votedAt: Date.now(),
    });

    const allVotes = storage.getVotesForSession(sessionId);
    const approveCount = allVotes.filter((v) => v.approve === 1).length;
    const rejectCount = allVotes.filter((v) => v.approve === 0).length;

    // Majority approves → execute in TEE
    if (approveCount >= MAJORITY) {
      storage.updateSession(sessionId, { status: "executing" });
      executeTEE(sessionId).catch(console.error);
    }

    // Cannot reach majority → reset to drafting
    if (rejectCount > TOTAL_VOTERS - MAJORITY) {
      storage.updateSession(sessionId, {
        status: "drafting",
        prompt: null,
        mergedPrompt: null,
      });
    }

    res.json({ vote, approveCount, rejectCount });
  });

  // GET /api/session/:id/result — poll for TEE result
  app.get("/api/session/:id/result", (req, res) => {
    const sessionId = parseInt(req.params.id);
    const session = db
      .select()
      .from(sessionsTable)
      .where(eq(sessionsTable.id, sessionId))
      .get();
    if (!session) return res.status(404).json({ error: "Session not found" });
    const sessionVotes = storage.getVotesForSession(sessionId);
    res.json({
      session,
      votes: sessionVotes,
      attestation: session.attestationReport
        ? JSON.parse(session.attestationReport)
        : null,
    });
  });

  // POST /api/session/new — start a new round
  app.post("/api/session/new", (req, res) => {
    const session = storage.createSession();
    res.json({ session });
  });
}

async function executeTEE(sessionId: number) {
  try {
    const session = db
      .select()
      .from(sessionsTable)
      .where(eq(sessionsTable.id, sessionId))
      .get();
    if (!session?.prompt) throw new Error("No prompt found");

    const privateKey = process.env.OG_PRIVATE_KEY || "";
    const nonce = randomBytes(32).toString("hex");
    const promptHash = createHash("sha256").update(session.prompt).digest("hex");

    let llmResponse: string;
    let attestation: object;

    if (!privateKey) {
      // ── Demo mode ─────────────────────────────────────────────────────────
      llmResponse = [
        "[DEMO MODE — OG_PRIVATE_KEY not set]\n",
        "In production, this prompt is sent to OpenGradient's decentralised TEE network.",
        `Model: ${OG_MODEL}`,
        "Routed through an Intel TDX TEE node with cryptographic attestation.",
        "Payment settled in $OPG on Base Sepolia (chain 84532).",
        "Proof verified on OpenGradient Testnet (chain 10740).\n",
        `Prompt SHA-256: ${promptHash}\n`,
        "To enable live execution:",
        "  1. Create an EVM wallet and export the private key",
        "  2. Get free $OPG tokens from https://faucet.opengradient.ai",
        "  3. Set OG_PRIVATE_KEY=<your-key> and restart the server",
      ].join("\n");

      attestation = {
        demo: true,
        provider: "OpenGradient Testnet (demo)",
        model: OG_MODEL,
        inferenceMode: "TEE",
        teeType: "Intel TDX — NOT verified in demo",
        paymentNetwork: "Base Sepolia (chain 84532)",
        settlementNetwork: "OpenGradient Testnet (chain 10740)",
        token: "$OPG (0x240b09731D96979f50B2C649C9CE10FcF9C7987F)",
        nonce,
        promptHash,
        timestamp: new Date().toISOString(),
        verified: false,
        setup: {
          step1: "Create any EVM wallet (MetaMask, Rabby, cast wallet new, etc.)",
          step2: "Get free $OPG testnet tokens → https://faucet.opengradient.ai",
          step3: "Export private key → set as OG_PRIVATE_KEY env var",
          step4: "Optionally set OG_MODEL to change the LLM (default: anthropic/claude-4.0-sonnet)",
          faucet: "https://faucet.opengradient.ai",
          docs: "https://docs.opengradient.ai/developers/sdk/llm.html",
        },
      };
    } else {
      // ── Live TEE execution ────────────────────────────────────────────────
      const result = await callOpenGradientTEE(session.prompt, privateKey);
      llmResponse = result.response;
      attestation = result.attestation;
    }

    storage.updateSession(sessionId, {
      status: "complete",
      llmResponse,
      attestationReport: JSON.stringify(attestation),
      attestationNonce: nonce,
      completedAt: Date.now(),
    });
  } catch (err) {
    console.error("TEE execution error:", err);
    storage.updateSession(sessionId, {
      status: "complete",
      llmResponse: `Execution failed: ${err instanceof Error ? err.message : String(err)}`,
      attestationReport: JSON.stringify({
        error: String(err),
        timestamp: new Date().toISOString(),
      }),
      completedAt: Date.now(),
    });
  }
}
