import type { Express } from "express";
import type { Server } from "http";
import { storage, db } from "./storage";
import { sessions as sessionsTable } from "@shared/schema";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { randomBytes, createHash } from "crypto";

const TOTAL_USERS = 10;
const MAJORITY = 6; // >5 = majority

function buildMergedPrompt(inputs: { userId: number; userName: string; content: string }[]): string {
  const sorted = [...inputs].sort((a, b) => a.userId - b.userId);
  const parts = sorted.map(
    (inp) => `[${inp.userName} (User ${inp.userId})]: ${inp.content}`
  );
  return (
    "The following inputs were contributed by 10 participants in a consensus round. " +
    "Please synthesize all perspectives into a thoughtful, unified response:\n\n" +
    parts.join("\n\n")
  );
}

async function callPhalaLLM(prompt: string, apiKey: string): Promise<string> {
  const res = await fetch("https://api.redpill.ai/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: "phala/deepseek-chat-v3-0324",
      messages: [
        {
          role: "system",
          content: "You are a helpful assistant running inside a Trusted Execution Environment (TEE) on Phala Network. Your responses are verifiably private and cryptographically attested.",
        },
        { role: "user", content: prompt },
      ],
      max_tokens: 1024,
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`LLM API error: ${res.status} — ${err}`);
  }

  const data = await res.json();
  return data.choices?.[0]?.message?.content ?? "(No response)";
}

async function fetchAttestation(nonce: string, apiKey: string): Promise<object> {
  const res = await fetch(
    `https://api.redpill.ai/v1/attestation/report?nonce=${nonce}`,
    {
      headers: { Authorization: `Bearer ${apiKey}` },
    }
  );

  if (!res.ok) {
    const err = await res.text();
    // Return a structured mock if attestation endpoint not available
    return {
      error: `Attestation endpoint returned ${res.status}`,
      raw: err.slice(0, 500),
      nonce,
      timestamp: new Date().toISOString(),
      note: "Attestation could not be retrieved. This may require a paid API key.",
    };
  }

  return await res.json();
}

export function registerRoutes(httpServer: Server, app: Express) {
  // Get or create current session
  app.get("/api/session", (req, res) => {
    // Show active session, or latest (including completed), or create new
    let session = storage.getActiveSession() ?? storage.getLatestSession();
    if (!session) {
      session = storage.createSession();
    }
    const inputs = storage.getInputsForSession(session.id);
    const votes = storage.getVotesForSession(session.id);
    const attestation = session.attestationReport ? JSON.parse(session.attestationReport) : null;
    res.json({ session, inputs, votes, attestation });
  });

  // Submit a user input
  app.post("/api/session/:id/input", async (req, res) => {
    const sessionId = parseInt(req.params.id);
    const schema = z.object({
      userId: z.number().min(1).max(10),
      userName: z.string().min(1).max(50),
      content: z.string().min(1).max(2000),
    });

    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.flatten() });
    }

    const session = storage.getActiveSession();
    if (!session || session.id !== sessionId) {
      return res.status(404).json({ error: "Session not found" });
    }
    if (session.status !== "collecting") {
      return res.status(400).json({ error: "Session is no longer accepting inputs" });
    }

    // Upsert: if user already submitted, just update
    const existing = storage.getUserInput(sessionId, parsed.data.userId);
    if (existing) {
      return res.status(409).json({ error: "You have already submitted an input for this session." });
    }

    const input = storage.submitInput({
      sessionId,
      userId: parsed.data.userId,
      userName: parsed.data.userName,
      content: parsed.data.content,
      submittedAt: Date.now(),
    });

    const allInputs = storage.getInputsForSession(sessionId);

    // Auto-transition to reviewing once all 10 submit
    if (allInputs.length >= TOTAL_USERS) {
      const merged = buildMergedPrompt(allInputs);
      storage.updateSession(sessionId, { status: "reviewing", mergedPrompt: merged });
    }

    res.json({ input, totalInputs: allInputs.length });
  });

  // Lock prompt and transition to voting (manual trigger or auto)
  app.post("/api/session/:id/lock", (req, res) => {
    const sessionId = parseInt(req.params.id);
    const session = storage.getActiveSession();
    if (!session || session.id !== sessionId) {
      return res.status(404).json({ error: "Session not found" });
    }
    if (!["collecting", "reviewing"].includes(session.status)) {
      return res.status(400).json({ error: "Cannot lock in current state" });
    }
    const allInputs = storage.getInputsForSession(sessionId);
    if (allInputs.length === 0) {
      return res.status(400).json({ error: "No inputs to merge" });
    }
    const merged = buildMergedPrompt(allInputs);
    const updated = storage.updateSession(sessionId, { status: "voting", mergedPrompt: merged });
    res.json({ session: updated, mergedPrompt: merged });
  });

  // Submit a vote
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

    // If majority approves, trigger TEE execution
    if (approveCount >= MAJORITY) {
      storage.updateSession(sessionId, { status: "executing" });
      // Execute async without blocking response
      executeTEE(sessionId).catch(console.error);
    }

    // If impossible to reach majority (reject majority), reset to collecting
    if (rejectCount > TOTAL_USERS - MAJORITY) {
      storage.updateSession(sessionId, { status: "collecting" });
    }

    res.json({ vote, approveCount, rejectCount });
  });

  // Get execution result (poll endpoint)
  app.get("/api/session/:id/result", (req, res) => {
    const sessionId = parseInt(req.params.id);
    const session = db.select().from(sessionsTable).where(eq(sessionsTable.id, sessionId)).get();

    if (!session) return res.status(404).json({ error: "Session not found" });

    const sessionInputs = storage.getInputsForSession(sessionId);
    const sessionVotes = storage.getVotesForSession(sessionId);

    res.json({
      session,
      inputs: sessionInputs,
      votes: sessionVotes,
      attestation: session.attestationReport ? JSON.parse(session.attestationReport) : null,
    });
  });

  // Create a new session (reset)
  app.post("/api/session/new", (req, res) => {
    const session = storage.createSession();
    res.json({ session });
  });
}

async function executeTEE(sessionId: number) {
  try {
    const session = db.select().from(sessionsTable).where(eq(sessionsTable.id, sessionId)).get();
    if (!session?.mergedPrompt) throw new Error("No merged prompt found");

    const apiKey = process.env.REDPILL_API_KEY || process.env.PHALA_API_KEY || "";

    // Generate fresh nonce
    const nonce = randomBytes(32).toString("hex");

    // Hash of merged prompt for integrity
    const promptHash = createHash("sha256").update(session.mergedPrompt).digest("hex");

    let llmResponse: string;
    let attestation: object;

    if (!apiKey) {
      // Demo mode — no real API key
      llmResponse = `[DEMO MODE — no API key set]\n\nThis is a simulated TEE response. In production, the merged prompt would be sent to Phala Network's confidential AI API (https://api.redpill.ai/v1/chat/completions) using model phala/deepseek-chat-v3-0324, executed inside an Intel TDX + NVIDIA GPU TEE enclave.\n\nMerged prompt hash (SHA-256): ${promptHash}\n\nTo enable live execution, set the REDPILL_API_KEY environment variable.`;
      attestation = {
        demo: true,
        model: "phala/deepseek-chat-v3-0324",
        nonce,
        promptHash,
        timestamp: new Date().toISOString(),
        tee_type: "Intel TDX + NVIDIA GPU TEE",
        gateway: "https://api.redpill.ai",
        verified: false,
        note: "Set REDPILL_API_KEY to enable real TEE attestation from Phala Network.",
        measurements: {
          hardware: "DEMO — not verified",
          model_hash: `sha256:${promptHash}`,
          code_hash: "DEMO — not verified",
          platform_cert: "DEMO — not verified",
        },
      };
    } else {
      [llmResponse, attestation] = await Promise.all([
        callPhalaLLM(session.mergedPrompt, apiKey),
        fetchAttestation(nonce, apiKey),
      ]);
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
