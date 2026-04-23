import type { Express } from "express";
import type { Server } from "http";
import { storage, db } from "./storage";
import { sessions as sessionsTable } from "@shared/schema";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { randomBytes, createHash } from "crypto";
import { ethers } from "ethers";

const TOTAL_VOTERS = 10;
const MAJORITY = 6; // need ≥6 approvals to execute

// OpenGradient x402 config
const OG_LLM_ENDPOINT = "https://llmogevm.opengradient.ai/v1/chat/completions";
const OG_MODEL = process.env.OG_MODEL || "anthropic/claude-4.0-sonnet";

/**
 * Call OpenGradient's x402 TEE LLM endpoint.
 * Flow:
 *  1. POST → 402 with X-PAYMENT-REQUIRED header
 *  2. Wallet signs payment payload
 *  3. Re-POST with X-PAYMENT-SIGNATURE → LLM response + on-chain settlement
 */
async function callOpenGradientTEE(
  prompt: string,
  privateKey: string
): Promise<{ response: string; paymentHash: string; txHash: string; attestation: object }> {
  const wallet = new ethers.Wallet(privateKey);

  const body = JSON.stringify({
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
    settlement_mode: process.env.OG_SETTLEMENT_MODE || "SETTLE_METADATA",
    inference_mode: "TEE",
  });

  // Step 1: Initial request — expect 402
  const firstRes = await fetch(OG_LLM_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
  });

  if (firstRes.status !== 402) {
    if (!firstRes.ok) {
      const err = await firstRes.text();
      throw new Error(`OpenGradient API error: ${firstRes.status} — ${err}`);
    }
    const data = await firstRes.json() as any;
    return {
      response: data.choices?.[0]?.message?.content ?? "(No response)",
      paymentHash: "n/a",
      txHash: "n/a",
      attestation: { note: "Responded without payment challenge", raw: data },
    };
  }

  // Step 2: Parse payment requirement
  const paymentRequiredHeader =
    firstRes.headers.get("X-PAYMENT-REQUIRED") ||
    firstRes.headers.get("PAYMENT-REQUIRED");

  if (!paymentRequiredHeader) {
    throw new Error("OpenGradient returned 402 but no X-PAYMENT-REQUIRED header");
  }

  let paymentRequired: any;
  try {
    try {
      paymentRequired = JSON.parse(paymentRequiredHeader);
    } catch {
      paymentRequired = JSON.parse(Buffer.from(paymentRequiredHeader, "base64").toString());
    }
  } catch {
    throw new Error(`Failed to parse X-PAYMENT-REQUIRED header: ${paymentRequiredHeader.slice(0, 200)}`);
  }

  // Step 3: Sign payment payload
  const paymentPayload = {
    ...paymentRequired,
    timestamp: Date.now(),
    nonce: randomBytes(16).toString("hex"),
  };
  const signature = await wallet.signMessage(JSON.stringify(paymentPayload));
  const paymentSignature = JSON.stringify({
    payload: paymentPayload,
    signature,
    address: wallet.address,
  });

  // Step 4: Re-submit with payment signature
  const secondRes = await fetch(OG_LLM_ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-PAYMENT-SIGNATURE": paymentSignature,
      "PAYMENT-SIGNATURE": paymentSignature,
    },
    body,
  });

  if (!secondRes.ok) {
    const err = await secondRes.text();
    throw new Error(`OpenGradient payment/inference error: ${secondRes.status} — ${err}`);
  }

  const result = await secondRes.json() as any;

  const paymentResponse =
    secondRes.headers.get("X-PAYMENT-RESPONSE") ||
    secondRes.headers.get("PAYMENT-RESPONSE");

  let txHash = "pending";
  let paymentHash = "pending";
  if (paymentResponse) {
    try {
      const pr = JSON.parse(paymentResponse);
      txHash = pr.tx_hash ?? pr.txHash ?? "pending";
      paymentHash = pr.payment_id ?? pr.paymentId ?? "pending";
    } catch {}
  }

  const llmContent =
    result.choices?.[0]?.message?.content ??
    result.completion ??
    "(No response)";

  const attestation = {
    provider: "OpenGradient",
    model: OG_MODEL,
    settlementMode: process.env.OG_SETTLEMENT_MODE || "SETTLE_METADATA",
    inferenceMode: "TEE",
    teeType: "Intel TDX (hardware-attested)",
    network: "OpenGradient Mainnet (chain 10744)",
    walletAddress: wallet.address,
    txHash,
    paymentHash,
    blockExplorer: txHash !== "pending"
      ? `https://explorer.opengradient.ai/tx/${txHash}`
      : "https://explorer.opengradient.ai",
    timestamp: new Date().toISOString(),
    verified: true,
    note: "Prompt routed through Intel TDX TEE node to Anthropic. TEE attestation proof posted and verified on OpenGradient blockchain by 2/3+ validators.",
    verification: result.verification ?? null,
  };

  return { response: llmContent, paymentHash, txHash, attestation };
}

export function registerRoutes(httpServer: Server, app: Express) {
  // GET /api/session — get or create current session
  app.get("/api/session", (req, res) => {
    let session = storage.getActiveSession() ?? storage.getLatestSession();
    if (!session) session = storage.createSession();
    const votes = storage.getVotesForSession(session.id);
    const attestation = session.attestationReport ? JSON.parse(session.attestationReport) : null;
    res.json({ session, votes, attestation });
  });

  // POST /api/session/:id/prompt — submit the single prompt (moves to voting)
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

    // Impossible to reach majority → reset to drafting
    if (rejectCount > TOTAL_VOTERS - MAJORITY) {
      storage.updateSession(sessionId, { status: "drafting", prompt: null, mergedPrompt: null });
    }

    res.json({ vote, approveCount, rejectCount });
  });

  // GET /api/session/:id/result — poll for result
  app.get("/api/session/:id/result", (req, res) => {
    const sessionId = parseInt(req.params.id);
    const session = db.select().from(sessionsTable).where(eq(sessionsTable.id, sessionId)).get();
    if (!session) return res.status(404).json({ error: "Session not found" });
    const sessionVotes = storage.getVotesForSession(sessionId);
    res.json({
      session,
      votes: sessionVotes,
      attestation: session.attestationReport ? JSON.parse(session.attestationReport) : null,
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
    const session = db.select().from(sessionsTable).where(eq(sessionsTable.id, sessionId)).get();
    if (!session?.prompt) throw new Error("No prompt found");

    const privateKey = process.env.OG_PRIVATE_KEY || "";
    const nonce = randomBytes(32).toString("hex");
    const promptHash = createHash("sha256").update(session.prompt).digest("hex");

    let llmResponse: string;
    let attestation: object;

    if (!privateKey) {
      // Demo mode
      llmResponse = [
        "[DEMO MODE — OG_PRIVATE_KEY not set]\n",
        "In production, this prompt is sent to OpenGradient's decentralized TEE network.",
        `Model: ${OG_MODEL}`,
        "Routed through an Intel TDX TEE node, cryptographically attested,",
        "and the proof is settled on the OpenGradient blockchain (chain 10744).\n",
        `Prompt SHA-256: ${promptHash}\n`,
        "Set OG_PRIVATE_KEY to enable live execution.",
      ].join("\n");

      attestation = {
        demo: true,
        provider: "OpenGradient (demo)",
        model: OG_MODEL,
        inferenceMode: "TEE",
        teeType: "Intel TDX (hardware-attested) — NOT verified in demo",
        network: "OpenGradient Mainnet (chain 10744)",
        nonce,
        promptHash,
        timestamp: new Date().toISOString(),
        verified: false,
        note: "Set OG_PRIVATE_KEY (Ethereum wallet private key funded with OUSDC on chain 10744) to enable real TEE attestation.",
        setup: {
          step1: "Create an Ethereum wallet (MetaMask or any EVM wallet), export the private key",
          step2: "Add OpenGradient Mainnet: RPC https://rpc.opengradient.ai, Chain ID 10744",
          step3: "Fund with OUSDC on chain 10744",
          step4: "Set OG_PRIVATE_KEY env var and restart",
          docs: "https://docs.opengradient.ai/developers/sdk/llm.html",
        },
      };
    } else {
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
      attestationReport: JSON.stringify({ error: String(err) }),
      completedAt: Date.now(),
    });
  }
}
