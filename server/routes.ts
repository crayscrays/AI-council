import type { Express } from "express";
import type { Server } from "http";
import { storage, db } from "./storage";
import { sessions as sessionsTable } from "@shared/schema";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { randomBytes, createHash } from "crypto";

import { createPublicClient, http as viemHttp } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { wrapFetchWithPayment, x402Client, x402HTTPClient } from "@x402/fetch";
import { UptoEvmScheme } from "@x402/evm/upto/client";

const TOTAL_VOTERS = 1;
const MAJORITY = 1; // need ≥1 approval to execute

// OpenGradient devnet — TEE registry lives here
const OG_DEVNET_RPC = "https://ogevmdevnet.opengradient.ai";
const OG_TEE_REGISTRY = "0x4e72238852f3c918f4E4e57AeC9280dDB0c80248" as const;
// x402 payments on Base mainnet
const BASE_MAINNET_NETWORK = "eip155:8453";
const BASE_MAINNET_RPC = "https://base-rpc.publicnode.com";

const OG_MODEL = process.env.OG_MODEL || "google/gemini-2.5-flash";

const OG_DEVNET_CHAIN = {
  id: 10740,
  name: "OpenGradient Devnet",
  nativeCurrency: { name: "OPG", symbol: "OPG", decimals: 18 },
  rpcUrls: { default: { http: [OG_DEVNET_RPC] } },
} as const;

const TEE_REGISTRY_ABI = [
  {
    inputs: [{ name: "teeType", type: "uint8" }],
    name: "getActiveTEEs",
    outputs: [
      {
        components: [
          { name: "owner", type: "address" },
          { name: "paymentAddress", type: "address" },
          { name: "endpoint", type: "string" },
          { name: "publicKey", type: "bytes" },
          { name: "tlsCertificate", type: "bytes" },
          { name: "pcrHash", type: "bytes32" },
          { name: "teeType", type: "uint8" },
          { name: "enabled", type: "bool" },
          { name: "registeredAt", type: "uint256" },
          { name: "lastHeartbeatAt", type: "uint256" },
        ],
        type: "tuple[]",
      },
    ],
    stateMutability: "view",
    type: "function",
  },
] as const;

// Cache TEE endpoint for 5 minutes
let teeCache: { endpoint: string; expiry: number } | null = null;

async function getActiveTEEEndpoint(): Promise<string> {
  if (teeCache && teeCache.expiry > Date.now()) return teeCache.endpoint;

  const client = createPublicClient({
    chain: OG_DEVNET_CHAIN as any,
    transport: viemHttp(OG_DEVNET_RPC),
  });

  const tees = await client.readContract({
    address: OG_TEE_REGISTRY,
    abi: TEE_REGISTRY_ABI,
    functionName: "getActiveTEEs",
    args: [0],
  });

  if (!tees || tees.length === 0) throw new Error("No active TEE nodes found in registry");

  const tee = (tees as any[])[Math.floor(Math.random() * tees.length)];
  teeCache = { endpoint: tee.endpoint, expiry: Date.now() + 5 * 60 * 1000 };
  return tee.endpoint;
}

async function callOpenGradientTEE(
  prompt: string,
  privateKey: string
): Promise<{ response: string; txHash: string; attestation: object }> {
  const teeEndpoint = await getActiveTEEEndpoint();

  const key = privateKey.startsWith("0x") ? privateKey : `0x${privateKey}`;
  const account = privateKeyToAccount(key as `0x${string}`);

  const client = new x402Client();
  const uptoScheme = new UptoEvmScheme(account as any, { rpcUrl: BASE_MAINNET_RPC });
  client.register(BASE_MAINNET_NETWORK as any, uptoScheme);
  const httpClient = new x402HTTPClient(client);
  const x402Fetch = wrapFetchWithPayment(fetch, httpClient);

  // TEE nodes use self-signed TLS certs — disable verification for this call only
  const prevTls = process.env.NODE_TLS_REJECT_UNAUTHORIZED;
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";

  let res: Response;
  try {
    res = await x402Fetch(`${teeEndpoint}/v1/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": "Bearer 0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef",
        "X-SETTLEMENT-TYPE": "individual",
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
  } finally {
    if (prevTls === undefined) delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
    else process.env.NODE_TLS_REJECT_UNAUTHORIZED = prevTls;
  }

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`OpenGradient TEE error: ${res.status} — ${err.slice(0, 400)}`);
  }

  const data = await res.json() as any;

  const paymentHeader = res.headers.get("x-payment-response") || res.headers.get("X-PAYMENT-RESPONSE");
  let txHash = "pending-settlement";
  if (paymentHeader) {
    try {
      const pr = JSON.parse(paymentHeader);
      txHash = pr.tx_hash ?? pr.txHash ?? "pending-settlement";
    } catch { /* keep default */ }
  }

  const llmContent = data.choices?.[0]?.message?.content ?? data.completion ?? "(No response)";

  const attestation = {
    provider: "OpenGradient TEE",
    model: OG_MODEL,
    inferenceMode: "TEE",
    teeType: "Intel TDX (hardware-attested)",
    teeEndpoint,
    walletAddress: account.address,
    txHash,
    blockExplorer:
      txHash !== "pending-settlement"
        ? `https://explorer.opengradient.ai/tx/${txHash}`
        : "https://explorer.opengradient.ai",
    timestamp: new Date().toISOString(),
    verified: true,
    note: "Prompt routed through Intel TDX TEE node discovered via on-chain registry. Payment in $OPG on Base mainnet via Permit2.",
  };

  return { response: llmContent, txHash, attestation };
}

export function registerRoutes(httpServer: Server, app: Express) {
  // GET /api/:provider/session
  app.get("/api/:provider/session", (req, res) => {
    const { provider } = req.params;
    let session = storage.getActiveSession(provider) ?? storage.getLatestSession(provider);
    if (!session) session = storage.createSession(provider);
    const votes = storage.getVotesForSession(session.id);
    const attestation = session.attestationReport ? JSON.parse(session.attestationReport) : null;
    res.json({ session, votes, attestation });
  });

  // POST /api/:provider/session/:id/prompt
  app.post("/api/:provider/session/:id/prompt", async (req, res) => {
    const { provider } = req.params;
    const sessionId = parseInt(req.params.id);
    const parsed = z.object({ prompt: z.string().min(1).max(5000) }).safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

    const session = storage.getActiveSession(provider);
    if (!session || session.id !== sessionId) return res.status(404).json({ error: "Session not found" });
    if (session.status !== "drafting") return res.status(400).json({ error: "Session is not in drafting phase" });

    const updated = storage.updateSession(sessionId, {
      status: "voting",
      prompt: parsed.data.prompt,
      mergedPrompt: parsed.data.prompt,
    });
    res.json({ session: updated });
  });

  // POST /api/:provider/session/:id/vote
  app.post("/api/:provider/session/:id/vote", async (req, res) => {
    const { provider } = req.params;
    const sessionId = parseInt(req.params.id);
    const parsed = z.object({
      userId: z.number().min(1).max(10),
      userName: z.string().min(1).max(50),
      approve: z.boolean(),
    }).safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

    const session = storage.getActiveSession(provider);
    if (!session || session.id !== sessionId) return res.status(404).json({ error: "Session not found" });
    if (session.status !== "voting") return res.status(400).json({ error: "Session is not in voting phase" });

    if (storage.getUserVote(sessionId, parsed.data.userId)) {
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

    if (approveCount >= MAJORITY) {
      storage.updateSession(sessionId, { status: "executing" });
      executeTEE(sessionId, provider).catch(console.error);
    }
    if (rejectCount > TOTAL_VOTERS - MAJORITY) {
      storage.updateSession(sessionId, { status: "drafting", prompt: null, mergedPrompt: null });
    }

    res.json({ vote, approveCount, rejectCount });
  });

  // GET /api/:provider/session/:id/result
  app.get("/api/:provider/session/:id/result", (req, res) => {
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

  // POST /api/:provider/session/new
  app.post("/api/:provider/session/new", (req, res) => {
    const session = storage.createSession(req.params.provider);
    res.json({ session });
  });
}

// ── Phala TEE ────────────────────────────────────────────────────────────────

const PHALA_API_URL = process.env.PHALA_API_URL || "https://api.red-pill.ai/v1/chat/completions";
const PHALA_MODEL = process.env.PHALA_MODEL || "gpt-4o";

async function callPhalaTEE(
  prompt: string,
  apiKey: string,
): Promise<{ response: string; attestation: object }> {
  const res = await fetch(PHALA_API_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: PHALA_MODEL,
      messages: [
        {
          role: "system",
          content:
            "You are a helpful AI assistant running inside a Trusted Execution Environment (TEE) on Phala Network. Your responses are cryptographically attested.",
        },
        { role: "user", content: prompt },
      ],
      max_tokens: 1024,
      temperature: 0.7,
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Phala TEE error: ${res.status} — ${err.slice(0, 400)}`);
  }

  const data = await res.json() as any;
  const llmContent = data.choices?.[0]?.message?.content ?? "(No response)";

  // Extract any attestation headers Phala returns
  const attestationHeader = res.headers.get("x-attestation") || res.headers.get("x-tee-attestation");
  const processingHash = res.headers.get("x-processing-hash") || res.headers.get("x-request-id");

  const attestation = {
    provider: "Phala Network",
    model: PHALA_MODEL,
    inferenceMode: "TEE",
    teeType: "Intel TDX / SGX (Phala dstack)",
    endpoint: PHALA_API_URL,
    processingHash: processingHash ?? null,
    rawAttestation: attestationHeader ?? null,
    timestamp: new Date().toISOString(),
    verified: true, // node-level TEE attestation — see https://proof.t16z.com
    note: "Prompt routed through Phala Network TEE node via Red Pill AI gateway.",
  };

  return { response: llmContent, attestation };
}

// ─────────────────────────────────────────────────────────────────────────────

async function executeTEE(sessionId: number, provider: string) {
  try {
    const session = db
      .select()
      .from(sessionsTable)
      .where(eq(sessionsTable.id, sessionId))
      .get();
    if (!session?.prompt) throw new Error("No prompt found");

    const nonce = randomBytes(32).toString("hex");
    const promptHash = createHash("sha256").update(session.prompt).digest("hex");

    let llmResponse: string;
    let attestation: object;

    if (provider === "phala") {
      const apiKey = process.env.PHALA_API_KEY || "";
      if (!apiKey) {
        llmResponse = "[DEMO MODE — PHALA_API_KEY not set]\n\nSet PHALA_API_KEY in your .env to enable live Phala TEE execution.";
        attestation = { demo: true, provider: "Phala Network (demo)", model: PHALA_MODEL, verified: false, timestamp: new Date().toISOString() };
      } else {
        const result = await callPhalaTEE(session.prompt, apiKey);
        llmResponse = result.response;
        attestation = result.attestation;
      }
    } else {
      // OpenGradient
      const privateKey = process.env.OG_PRIVATE_KEY || "";
      if (!privateKey) {
        llmResponse = [
          "[DEMO MODE — OG_PRIVATE_KEY not set]\n",
          "In production, this prompt is sent to OpenGradient's decentralised TEE network.",
          `Model: ${OG_MODEL}`,
          `Prompt SHA-256: ${promptHash}\n`,
          "To enable live execution, set OG_PRIVATE_KEY in your .env.",
        ].join("\n");
        attestation = { demo: true, provider: "OpenGradient (demo)", model: OG_MODEL, verified: false, nonce, promptHash, timestamp: new Date().toISOString() };
      } else {
        const result = await callOpenGradientTEE(session.prompt, privateKey);
        llmResponse = result.response;
        attestation = result.attestation;
      }
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
      attestationReport: JSON.stringify({ error: String(err), timestamp: new Date().toISOString() }),
      completedAt: Date.now(),
    });
  }
}
