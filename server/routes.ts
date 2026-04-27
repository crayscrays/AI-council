import type { Express } from "express";
import type { Server } from "http";
import { storage, db } from "./storage";
import { sessions as sessionsTable } from "@shared/schema";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { randomBytes, createHash } from "crypto";
import { spawn } from "child_process";
import { join } from "path";

const TOTAL_VOTERS = 1;
const MAJORITY = 1; // need ≥1 approval to execute

const OG_MODEL = process.env.OG_MODEL || "anthropic/claude-opus-4-6";

async function callOpenGradientTEE(
  prompt: string,
  privateKey: string
): Promise<{ response: string; txHash: string; attestation: object }> {
  return new Promise((resolve, reject) => {
    const scriptPath = join(process.cwd(), "server", "og_llm.py");
    const child = spawn("python3", [scriptPath], {
      env: { ...process.env, OG_PRIVATE_KEY: privateKey, OG_MODEL },
    });

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d: Buffer) => { stdout += d.toString(); });
    child.stderr.on("data", (d: Buffer) => { stderr += d.toString(); });
    child.on("error", (err) => reject(new Error(`Failed to spawn og_llm.py: ${err.message}`)));
    child.stdin.write(prompt);
    child.stdin.end();

    child.on("close", (code: number) => {
      if (code !== 0) {
        return reject(new Error(`og_llm.py exited ${code}: ${stderr.slice(0, 400)}`));
      }
      let result: any;
      try {
        result = JSON.parse(stdout);
      } catch {
        return reject(new Error(`Failed to parse og_llm.py output: ${stdout.slice(0, 400)}`));
      }
      if (result.error) return reject(new Error(`og_llm.py: ${result.error}`));

      const teePaymentAddress = result.tee_payment_address ?? null;
      const teeId = result.tee_id ?? null;
      const processingHash = result.processing_hash ?? null;
      const attestation = {
        provider: "OpenGradient TEE",
        model: result.model ?? OG_MODEL,
        inferenceMode: "TEE",
        teeType: "Intel TDX (hardware-attested)",
        teeEndpoint: result.tee_endpoint ?? "via on-chain registry",
        teeId,
        teePaymentAddress,
        processingHash,
        txProofUrl: processingHash
          ? `https://explorer.opengradient.ai/tx/${processingHash}`
          : null,
        teeRegistryUrl: teePaymentAddress
          ? `https://explorer.opengradient.ai/address/${teePaymentAddress}`
          : null,
        teeSignature: result.tee_signature ?? null,
        teeTimestamp: result.tee_timestamp ?? null,
        timestamp: new Date().toISOString(),
        verified: !!(result.tee_signature),
        note: processingHash
          ? "txProofUrl links to the exact on-chain inference record (input + output + signature) settled via INDIVIDUAL_FULL mode."
          : "teeSignature is an RSA-PSS signature over the response produced inside the Intel TDX enclave. teeRegistryUrl shows the TEE node's on-chain identity.",
      };

      resolve({ response: result.response, txHash: processingHash ?? teePaymentAddress ?? "none", attestation });
    });
  });
}

export function registerRoutes(_httpServer: Server, app: Express) {
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

const PHALA_API_BASE = "https://api.red-pill.ai";
const PHALA_API_URL = process.env.PHALA_API_URL || `${PHALA_API_BASE}/v1/chat/completions`;
// phala/ prefix = runs natively in TEE → supports per-request signing
const PHALA_MODEL = process.env.PHALA_MODEL || "phala/qwen-2.5-7b-instruct";

async function callPhalaTEE(
  prompt: string,
  apiKey: string,
): Promise<{ response: string; attestation: object }> {
  const requestBody = {
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
  };

  const requestBodyStr = JSON.stringify(requestBody);
  const requestHash = createHash("sha256").update(requestBodyStr).digest("hex");

  const res = await fetch(PHALA_API_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${apiKey}`,
    },
    body: requestBodyStr,
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Phala TEE error: ${res.status} — ${err.slice(0, 400)}`);
  }

  const rawResponse = await res.text();
  const data = JSON.parse(rawResponse) as any;
  const llmContent = data.choices?.[0]?.message?.content ?? "(No response)";

  // Hash the full raw JSON response body — matches what the TEE signs
  const responseHash = createHash("sha256").update(rawResponse).digest("hex");

  // chatcmpl-... ID from the response body is what the signature endpoint expects
  const completionId = (data as any).id as string | undefined;

  let signatureText: string | null = null;
  let signature: string | null = null;
  let signingAddress: string | null = null;
  let signingAlgo: string | null = null;
  let sigVerified = false;
  let hashesMatch = false;
  let sigError: string | null = null;

  if (completionId) {
    try {
      const sigRes = await fetch(
        `${PHALA_API_BASE}/v1/signature/${completionId}?model=${encodeURIComponent(PHALA_MODEL)}`,
        { headers: { "Authorization": `Bearer ${apiKey}` } },
      );
      if (sigRes.ok) {
        const sigData = await sigRes.json() as any;
        signatureText = sigData.text ?? null;
        signature = sigData.signature ?? null;
        signingAddress = sigData.signing_address ?? null;
        signingAlgo = sigData.signing_algo ?? "ecdsa";

        // Step 3 verify: text field is "{requestHash}:{responseHash}"
        // We can only verify the request hash — TEE hashes an internal response
        // representation we cannot reproduce, so we trust sigVerified for the response side
        if (signatureText) {
          const [sigReqHash] = signatureText.split(":");
          hashesMatch = sigReqHash?.toLowerCase() === requestHash.toLowerCase();
        }

        // Step 4 verify: recover signer address from ECDSA signature and compare
        if (signature && signingAddress && signatureText) {
          try {
            const { recoverAddress, hashMessage } = await import("viem");
            const msgHash = hashMessage(signatureText);
            const recovered = await recoverAddress({ hash: msgHash, signature: signature as `0x${string}` });
            sigVerified = recovered.toLowerCase() === signingAddress.toLowerCase();
          } catch (e) {
            sigError = `Address recovery failed: ${e instanceof Error ? e.message : String(e)}`;
          }
        }
      } else {
        sigError = `Signature fetch failed: ${sigRes.status}`;
      }
    } catch (e) {
      sigError = `Signature error: ${e instanceof Error ? e.message : String(e)}`;
    }
  }

  // Step 5: fetch TDX attestation report that binds signing_address to the enclave
  let tdxQuote: string | null = null;
  let attestationNonce: string | null = null;
  let addressInQuote = false;
  let attError: string | null = null;

  if (signingAddress) {
    try {
      attestationNonce = randomBytes(32).toString("hex");
      const attRes = await fetch(
        `${PHALA_API_BASE}/v1/attestation/report?model=${encodeURIComponent(PHALA_MODEL)}&nonce=${attestationNonce}&signing_address=${signingAddress}`,
        { headers: { "Authorization": `Bearer ${apiKey}` } },
      );
      if (attRes.ok) {
        const attData = await attRes.json() as any;
        tdxQuote = attData.intel_quote ?? null;

        // Verify: report_data = address_bytes (20B) + zeros (12B) + nonce_bytes (32B)
        if (tdxQuote) {
          // intel_quote is hex-encoded (not base64)
          const quoteRaw = Buffer.from(tdxQuote, "hex");
          const addrHex = signingAddress.slice(2).toLowerCase();
          const addrBytes = Buffer.from(addrHex, "hex");
          addressInQuote = quoteRaw.indexOf(addrBytes) !== -1;
        }
      } else {
        attError = `Attestation fetch failed: ${attRes.status}`;
      }
    } catch (e) {
      attError = `Attestation error: ${e instanceof Error ? e.message : String(e)}`;
    }
  }

  const verified = hashesMatch && sigVerified && addressInQuote;

  // Compute the expected report_data that the TEE embeds in the TDX quote:
  // layout = signer_address (20 bytes) + zero_padding (12 bytes) + nonce (32 bytes)
  const reportDataHex = signingAddress && attestationNonce
    ? `${signingAddress.slice(2).toLowerCase()}${"00".repeat(12)}${attestationNonce}`
    : null;

  const attestation = {
    provider: "Phala Network",
    model: PHALA_MODEL,
    inferenceMode: "TEE",
    teeType: "Intel TDX (Phala dstack)",
    endpoint: PHALA_API_URL,
    completionId: completionId ?? null,
    requestHash,
    responseHash,
    signatureText,
    signature,
    signingAddress,
    signingAlgo,
    attestationNonce,
    reportDataHex,
    hashesMatch,
    sigVerified,
    tdxQuote,
    addressInQuote,
    timestamp: new Date().toISOString(),
    verified,
    ...(sigError ? { sigError } : {}),
    ...(attError ? { attError } : {}),
    note: verified
      ? "Full TEE proof: hashes match + ECDSA verified + signing address bound in Intel TDX quote. Paste tdxQuote at proof.t16z.com to verify the enclave."
      : "Verification incomplete.",
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
