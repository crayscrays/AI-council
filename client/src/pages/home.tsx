import { useState, useEffect, useCallback } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import type { Session } from "@shared/schema";
import {
  Shield, CheckCircle2, Zap,
  ChevronRight, Copy, RefreshCw, AlertTriangle, Send,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";

interface SessionData {
  session: Session;
  attestation?: Record<string, unknown>;
}

type PhaseStep = "drafting" | "executing" | "complete";
const PHASE_ORDER: PhaseStep[] = ["drafting", "executing", "complete"];

function PhaseIndicator({ current }: { current: PhaseStep }) {
  const phases = [
    { key: "drafting", label: "Prompt" },
    { key: "executing", label: "Execute" },
    { key: "complete", label: "Result" },
  ];
  const currentIdx = PHASE_ORDER.indexOf(current);
  return (
    <div className="flex items-center gap-1 w-full max-w-2xl mx-auto">
      {phases.map((phase, i) => {
        const done = i < currentIdx;
        const active = i === currentIdx;
        return (
          <div key={phase.key} className="flex items-center flex-1">
            <div className="flex flex-col items-center flex-1">
              <div className={`
                w-7 h-7 rounded-full flex items-center justify-center text-xs font-mono font-bold border transition-all duration-500
                ${done ? "bg-primary/20 border-primary text-primary" : ""}
                ${active ? "bg-primary border-primary text-primary-foreground glow-cyan" : ""}
                ${!done && !active ? "bg-muted border-border text-muted-foreground" : ""}
              `}>
                {done ? <CheckCircle2 className="w-4 h-4" /> : i + 1}
              </div>
              <span className={`text-[10px] mt-1 font-mono uppercase tracking-wider ${active ? "text-primary" : done ? "text-primary/60" : "text-muted-foreground"}`}>
                {phase.label}
              </span>
            </div>
            {i < phases.length - 1 && (
              <div className={`h-px flex-1 mx-1 mb-4 transition-all duration-700 ${done ? "bg-primary/40" : "bg-border"}`} />
            )}
          </div>
        );
      })}
    </div>
  );
}

function Logo() {
  return (
    <svg aria-label="AI Council Logo" viewBox="0 0 40 40" fill="none" className="w-8 h-8 shrink-0">
      <rect x="2" y="2" width="16" height="16" rx="3" stroke="currentColor" strokeWidth="1.5" className="text-primary" />
      <rect x="22" y="2" width="16" height="16" rx="3" stroke="currentColor" strokeWidth="1.5" className="text-primary" />
      <rect x="2" y="22" width="16" height="16" rx="3" stroke="currentColor" strokeWidth="1.5" className="text-primary" />
      <rect x="22" y="22" width="16" height="16" rx="3" stroke="currentColor" strokeWidth="1.5" className="text-purple" />
      <circle cx="10" cy="10" r="2" fill="currentColor" className="text-primary" />
      <circle cx="30" cy="10" r="2" fill="currentColor" className="text-primary" />
      <circle cx="10" cy="30" r="2" fill="currentColor" className="text-primary" />
      <circle cx="30" cy="30" r="2" fill="currentColor" className="text-purple" />
      <line x1="18" y1="10" x2="22" y2="10" stroke="currentColor" strokeWidth="1.5" className="text-primary" opacity="0.5" />
      <line x1="10" y1="18" x2="10" y2="22" stroke="currentColor" strokeWidth="1.5" className="text-primary" opacity="0.5" />
      <line x1="30" y1="18" x2="30" y2="22" stroke="currentColor" strokeWidth="1.5" className="text-primary" opacity="0.5" />
      <line x1="18" y1="30" x2="22" y2="30" stroke="currentColor" strokeWidth="1.5" className="text-purple" opacity="0.5" />
    </svg>
  );
}

export default function CouncilPage({ provider }: { provider: "og" | "phala" }) {
  const apiBase = `/api/${provider}`;
  const [promptText, setPromptText] = useState("");
  const [copied, setCopied] = useState(false);
  const qc = useQueryClient();
  const { toast } = useToast();

  const { data, isLoading } = useQuery<SessionData>({
    queryKey: [`${apiBase}/session`],
    refetchInterval: (data) => {
      const status = data?.state?.data?.session?.status;
      if (status === "executing") return 2000;
      return false;
    },
  });

  // Poll result when executing
  const { data: resultData } = useQuery<SessionData>({
    queryKey: [`${apiBase}/session`, data?.session?.id, "result"],
    enabled: !!data?.session?.id && data?.session?.status === "executing",
    refetchInterval: 2000,
    queryFn: async () => {
      const res = await apiRequest("GET", `${apiBase}/session/${data!.session.id}/result`);
      return res.json();
    },
  });

  useEffect(() => {
    if (resultData?.session?.status === "complete") {
      qc.setQueryData([`${apiBase}/session`], resultData);
    }
  }, [resultData, qc, apiBase]);

  // Submit the single prompt → moves session to executing
  const submitPrompt = useMutation({
    mutationFn: async () => {
      if (!data?.session) throw new Error("No session");
      const res = await apiRequest("POST", `${apiBase}/session/${data.session.id}/prompt`, {
        prompt: promptText,
      });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || "Failed to submit prompt");
      }
      return res.json();
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: [`${apiBase}/session`] });
      toast({ title: "Prompt submitted", description: "Executing in TEE..." });
    },
    onError: (e: Error) => toast({ title: "Error", description: e.message, variant: "destructive" }),
  });

  // New session
  const newSession = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", `${apiBase}/session/new`);
      return res.json();
    },
    onSuccess: () => {
      setPromptText("");
      qc.invalidateQueries({ queryKey: [`${apiBase}/session`] });
      toast({ title: "New round started" });
    },
  });

  const copyToClipboard = useCallback((text: string) => {
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }, []);

  if (isLoading) {
    return (
      <div className="min-h-screen bg-background p-6 flex items-center justify-center">
        <div className="space-y-3 w-full max-w-2xl">
          <Skeleton className="h-8 w-64" />
          <Skeleton className="h-48 w-full" />
          <Skeleton className="h-32 w-full" />
        </div>
      </div>
    );
  }

  const session = data?.session;
  if (!session) return null;

  const attestation = data?.attestation ?? (
    session.attestationReport ? JSON.parse(session.attestationReport) : null
  );

  // Normalise status — old sessions may still say 'collecting'
  const status = (session.status === "collecting" || session.status === "reviewing")
    ? "drafting"
    : session.status as PhaseStep;

  return (
    <div className="min-h-screen bg-background">
      {/* Header */}
      <header className="border-b border-border bg-card/80 backdrop-blur sticky top-0 z-40">
        <div className="max-w-3xl mx-auto px-4 py-3 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <Logo />
            <div>
              <h1 className="text-base font-semibold font-mono text-foreground tracking-tight">
                AI<span className="text-primary">Council</span>
              </h1>
              <p className="text-[10px] text-muted-foreground font-mono uppercase tracking-widest">
                {provider === "phala" ? "Phala Network TEE · Verifiable Inference" : "OpenGradient TEE · Verifiable Inference"}
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <div className="hidden sm:flex items-center gap-1.5 px-2 py-1 rounded-md bg-muted/50 border border-border">
              <span className={`status-dot ${status === "complete" ? "success" : "active"}`} />
              <span className="text-xs font-mono text-muted-foreground capitalize">{status}</span>
            </div>
            {status === "complete" && (
              <Button
                size="sm"
                variant="outline"
                onClick={() => newSession.mutate()}
                disabled={newSession.isPending}
                className="text-xs font-mono h-7"
              >
                <RefreshCw className="w-3 h-3 mr-1" />
                New Round
              </Button>
            )}
          </div>
        </div>
      </header>

      <main className="max-w-3xl mx-auto px-4 py-6 space-y-6">
        {/* Phase indicator */}
        <div className="px-4">
          <PhaseIndicator current={status} />
        </div>

        {/* === DRAFTING PHASE === */}
        {status === "drafting" && (
          <div className="rounded-lg border border-border bg-card p-6 circuit-border">
            <div className="flex items-center gap-2 mb-5">
              <Zap className="w-4 h-4 text-primary" />
              <h2 className="font-mono font-semibold text-sm text-foreground uppercase tracking-wide">
                Submit Prompt
              </h2>
            </div>
            <p className="text-xs text-muted-foreground font-mono mb-4">
              Write the prompt to send to the AI running inside the TEE.
            </p>
            <Textarea
              data-testid="input-prompt"
              placeholder="Enter your prompt here... e.g. 'What are the most critical risks for a DeFi protocol in 2026?'"
              value={promptText}
              onChange={e => setPromptText(e.target.value)}
              className="min-h-[160px] bg-input border-border font-sans text-sm resize-none focus:ring-primary focus:border-primary mb-3"
            />
            <div className="flex items-center justify-between">
              <span className="text-xs text-muted-foreground font-mono">{promptText.length}/5000</span>
              <Button
                data-testid="button-submit-prompt"
                onClick={() => submitPrompt.mutate()}
                disabled={!promptText.trim() || submitPrompt.isPending}
                size="sm"
                className="font-mono text-xs bg-primary hover:bg-primary/80 text-primary-foreground"
              >
                {submitPrompt.isPending ? "Submitting..." : "Submit & Execute"}
                <Send className="w-3 h-3 ml-2" />
              </Button>
            </div>
          </div>
        )}

        {/* === EXECUTING PHASE === */}
        {status === "executing" && (
          <div className="rounded-lg border border-primary/30 bg-card p-8 text-center glow-cyan">
            <div className="flex justify-center mb-4">
              <div className="relative">
                <div className="w-16 h-16 rounded-full border-2 border-primary/30 flex items-center justify-center">
                  <Shield className="w-8 h-8 text-primary animate-pulse" />
                </div>
                <div className="absolute inset-0 rounded-full border-2 border-primary/60 animate-ping" />
              </div>
            </div>
            <h2 className="font-mono font-bold text-lg text-foreground mb-2">Executing in TEE</h2>
            <p className="text-sm text-muted-foreground font-mono mb-1">
              {provider === "phala"
                ? "Prompt running inside Phala Network's TEE node"
                : "Prompt running inside OpenGradient's Intel TDX TEE node"}
            </p>
            <p className="text-xs text-muted-foreground/60 font-mono">
              Generating cryptographic attestation · settling proof on-chain...
            </p>
            <div className="mt-4 flex justify-center gap-1">
              {[0, 1, 2, 3, 4].map(i => (
                <div
                  key={i}
                  className="w-1.5 h-1.5 rounded-full bg-primary/60"
                  style={{ animation: `statusPulse 1.4s ease-in-out ${i * 0.2}s infinite` }}
                />
              ))}
            </div>
          </div>
        )}

        {/* === COMPLETE PHASE === */}
        {status === "complete" && (
          <div className="space-y-5 fade-in">
            {/* LLM Response */}
            <div className="rounded-lg border border-primary/30 bg-card p-5 glow-cyan">
              <div className="flex items-center gap-2 mb-4">
                <Zap className="w-4 h-4 text-primary" />
                <h2 className="font-mono font-semibold text-sm uppercase tracking-wide">TEE Response</h2>
                <Badge className="ml-auto text-[10px] font-mono bg-primary/15 text-primary border-primary/30">
                  {provider === "phala" ? "Phala TEE" : "OpenGradient TEE"}
                </Badge>
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-6 w-6 p-0 text-muted-foreground hover:text-primary"
                  onClick={() => copyToClipboard(session.llmResponse ?? "")}
                  data-testid="button-copy-response"
                >
                  <Copy className="w-3 h-3" />
                </Button>
              </div>
              <div className="bg-muted/30 rounded-md p-4 border border-border/50 font-sans text-sm text-foreground leading-relaxed whitespace-pre-wrap">
                {session.llmResponse}
              </div>
            </div>

            {/* Attestation Report */}
            {attestation && (
              <div className="rounded-lg border border-purple/20 bg-card p-5">
                <div className="flex items-center gap-2 mb-4">
                  <Shield className="w-4 h-4 text-purple" />
                  <h2 className="font-mono font-semibold text-sm uppercase tracking-wide">
                    Cryptographic Attestation
                  </h2>
                  <Badge className="ml-auto text-[10px] font-mono border-purple/30 text-purple bg-purple/10">
                    {attestation.demo ? "Demo Mode" : "TEE Verified"}
                  </Badge>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-6 w-6 p-0 text-muted-foreground hover:text-purple"
                    onClick={() => copyToClipboard(JSON.stringify(attestation, null, 2))}
                    data-testid="button-copy-attestation"
                  >
                    <Copy className="w-3 h-3" />
                  </Button>
                </div>

                {attestation.demo && (
                  <div className="flex items-start gap-2 mb-3 p-2.5 rounded-md bg-warning/10 border border-warning/30">
                    <AlertTriangle className="w-3.5 h-3.5 text-warning shrink-0 mt-0.5" />
                    <p className="text-xs text-warning font-mono">
                      Demo mode: Set <code className="bg-warning/20 px-1 rounded">OG_PRIVATE_KEY</code> to enable live TEE. Get free <code className="bg-warning/20 px-1 rounded">$OPG</code> testnet tokens at{" "}<a href="https://faucet.opengradient.ai" target="_blank" rel="noopener noreferrer" className="underline">faucet.opengradient.ai</a>.
                    </p>
                  </div>
                )}

                {!attestation.demo && attestation.blockExplorer && (
                  <div className="mb-3">
                    <a
                      href={(attestation.blockExplorer as string).replace(/\?tab=\w+/, "?tab=inferences")}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center gap-1.5 text-xs font-mono text-primary hover:text-primary/80 underline underline-offset-2"
                    >
                      <Shield className="w-3 h-3" />
                      View proof on OpenGradient block explorer ↗
                    </a>
                  </div>
                )}

                {!attestation.demo && provider === "phala" && (
                  <div className="mb-3 flex flex-col gap-2">
                    {/* Overall status */}
                    {attestation.verified ? (
                      <div className="flex items-start gap-2 p-2.5 rounded-md bg-success/10 border border-success/30">
                        <CheckCircle2 className="w-3.5 h-3.5 text-success shrink-0 mt-0.5" />
                        <p className="text-xs text-success font-mono">
                          Full TEE proof verified — all 3 checks passed. Paste <code className="bg-success/20 px-1 rounded">tdxQuote</code> at proof.t16z.com to independently verify the Intel enclave.
                        </p>
                      </div>
                    ) : (
                      <div className="flex items-start gap-2 p-2.5 rounded-md bg-warning/10 border border-warning/30">
                        <AlertTriangle className="w-3.5 h-3.5 text-warning shrink-0 mt-0.5" />
                        <p className="text-xs text-warning font-mono">
                          {(attestation.sigError || attestation.attError || "Verification incomplete") as string}
                        </p>
                      </div>
                    )}

                    {/* Step-by-step checks */}
                    <div className="rounded-md border border-border/50 bg-background/40 p-3 space-y-2 text-[10px] font-mono">
                      {[
                        {
                          label: "1. Prompt hash match",
                          ok: attestation.hashesMatch as boolean,
                          detail: "SHA-256 of your prompt matches what the TEE signed",
                        },
                        {
                          label: "2. ECDSA sig valid",
                          ok: attestation.sigVerified as boolean,
                          detail: "Signature recovers to the TEE signing address",
                        },
                        {
                          label: "3. Address in TDX quote",
                          ok: attestation.addressInQuote as boolean,
                          detail: "Signing address bound in Intel TDX attestation report",
                        },
                      ].map(({ label, ok, detail }) => (
                        <div key={label} className="flex items-start gap-2">
                          <span className={`shrink-0 ${ok ? "text-success" : "text-destructive"}`}>{ok ? "✓" : "✗"}</span>
                          <div>
                            <span className={ok ? "text-success" : "text-destructive"}>{label}</span>
                            <span className="text-muted-foreground ml-2">{detail}</span>
                          </div>
                        </div>
                      ))}
                    </div>

                    {/* Key values */}
                    <div className="grid grid-cols-1 gap-1 text-[10px] font-mono">
                      {[
                        ["Prompt SHA-256",   attestation.requestHash],
                        ["Response SHA-256", attestation.responseHash],
                        ["TEE Signer",       attestation.signingAddress],
                        ["Signature",        attestation.signature],
                      ].map(([label, val]) => val ? (
                        <div key={label as string} className="flex gap-2">
                          <span className="text-muted-foreground shrink-0 w-28">{label as string}</span>
                          <span className="text-foreground/70 break-all">{val as string}</span>
                        </div>
                      ) : null)}
                    </div>

                    {/* proof.t16z.com guide */}
                    {attestation.tdxQuote && (
                      <div className="rounded-md border border-purple/20 bg-purple/5 p-3 space-y-2 text-[10px] font-mono">
                        <div className="flex items-center gap-1.5 text-purple font-semibold text-xs">
                          <Shield className="w-3 h-3" />
                          How to verify independently on proof.t16z.com
                        </div>
                        <ol className="list-decimal list-inside space-y-1.5 text-muted-foreground leading-relaxed">
                          <li>
                            <button
                              onClick={() => navigator.clipboard.writeText(attestation.tdxQuote as string)}
                              className="inline-flex items-center gap-1 text-purple hover:text-purple/80 underline underline-offset-2 ml-1"
                            >
                              <Copy className="w-2.5 h-2.5" />
                              Copy TDX quote (hex)
                            </button>
                          </li>
                          <li>
                            Go to{" "}
                            <a
                              href="https://proof.t16z.com"
                              target="_blank"
                              rel="noopener noreferrer"
                              className="text-purple hover:text-purple/80 underline underline-offset-2"
                            >
                              proof.t16z.com ↗
                            </a>
                            , paste the quote and submit
                          </li>
                          <li>
                            On the report page, find the <span className="text-foreground bg-muted px-1 rounded">UserData</span> or <span className="text-foreground bg-muted px-1 rounded">Report Data</span> field — it will look like garbled binary characters. That binary IS your signing address embedded by the Intel TEE hardware.
                          </li>
                          <li>
                            The raw bytes decode as:
                            <div className="mt-1 ml-2 space-y-0.5">
                              <div className="flex gap-2 items-center">
                                <span className="text-success bg-success/10 px-1 rounded">bytes 0–19</span>
                                <span className="text-foreground/80 break-all">{(attestation.signingAddress as string)?.toLowerCase()}</span>
                                <span className="text-muted-foreground">(TEE signer)</span>
                              </div>
                              <div className="flex gap-2 items-center">
                                <span className="text-muted-foreground bg-muted px-1 rounded">bytes 20–31</span>
                                <span className="text-foreground/60">000000000000000000000000</span>
                                <span className="text-muted-foreground">(padding)</span>
                              </div>
                              {attestation.attestationNonce && (
                                <div className="flex gap-2 items-center">
                                  <span className="text-primary bg-primary/10 px-1 rounded">bytes 32–63</span>
                                  <span className="text-foreground/80 break-all">{attestation.attestationNonce as string}</span>
                                  <span className="text-muted-foreground">(nonce)</span>
                                </div>
                              )}
                            </div>
                          </li>
                        </ol>
                        {attestation.reportDataHex && (
                          <div className="mt-2 pt-2 border-t border-purple/20">
                            <div className="flex items-center justify-between mb-1">
                              <span className="text-purple/80">Expected full report_data (hex):</span>
                              <button
                                onClick={() => navigator.clipboard.writeText(attestation.reportDataHex as string)}
                                className="inline-flex items-center gap-1 text-purple hover:text-purple/80 underline underline-offset-2"
                              >
                                <Copy className="w-2.5 h-2.5" />
                                Copy
                              </button>
                            </div>
                            <div className="bg-background rounded p-1.5 border border-border/50 break-all text-foreground/60 leading-relaxed">
                              <span className="text-success">{(attestation.signingAddress as string)?.slice(2).toLowerCase()}</span>
                              <span className="text-muted-foreground/40">{"00".repeat(12)}</span>
                              <span className="text-primary">{attestation.attestationNonce as string}</span>
                            </div>
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                )}

                <div className="bg-background/60 rounded-md p-4 border border-border/50 overflow-x-auto hash-reveal">
                  <AttestationViewer data={attestation} />
                </div>
              </div>
            )}

          </div>
        )}
      </main>

      {/* Footer */}
      <footer className="border-t border-border mt-12 py-4">
        <div className="max-w-3xl mx-auto px-4 flex items-center justify-between">
          <p className="text-xs font-mono text-muted-foreground/50">
            {provider === "phala" ? (
              <>
                Powered by{" "}
                <a href="https://red-pill.ai" target="_blank" rel="noopener noreferrer" className="text-purple/60 hover:text-purple transition-colors">
                  Phala Network
                </a>
                {" "}· Intel TDX TEE via Red Pill AI ·{" "}
                <a href="https://proof.t16z.com" target="_blank" rel="noopener noreferrer" className="text-purple/60 hover:text-purple transition-colors">
                  Verify node ↗
                </a>
              </>
            ) : (
              <>
                Powered by{" "}
                <a href="https://opengradient.ai" target="_blank" rel="noopener noreferrer" className="text-primary/60 hover:text-primary transition-colors">
                  OpenGradient
                </a>
                {" "}· Intel TDX TEE · Base mainnet $OPG
              </>
            )}
          </p>
          <p className="text-xs font-mono text-muted-foreground/40">
            Session #{session.id}
          </p>
        </div>
      </footer>
    </div>
  );
}

function AttestationViewer({ data }: { data: Record<string, unknown> }) {
  const render = (val: unknown, depth = 0): JSX.Element => {
    if (typeof val === "object" && val !== null && !Array.isArray(val)) {
      return (
        <div className={depth > 0 ? "ml-4 border-l border-border/40 pl-3 mt-1" : ""}>
          {Object.entries(val as Record<string, unknown>).map(([k, v]) => (
            <div key={k} className="py-0.5">
              <span className="attestation-key text-xs">{k}</span>
              <span className="text-muted-foreground text-xs font-mono">: </span>
              {typeof v === "object" ? render(v, depth + 1) : (
                <span className="attestation-value text-xs break-all">{String(v)}</span>
              )}
            </div>
          ))}
        </div>
      );
    }
    if (Array.isArray(val)) {
      return (
        <div className="ml-4">
          {(val as unknown[]).map((item, i) => <div key={i}>{render(item, depth + 1)}</div>)}
        </div>
      );
    }
    return <span className="attestation-value text-xs break-all">{String(val)}</span>;
  };
  return render(data);
}
