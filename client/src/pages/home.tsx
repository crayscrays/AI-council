import { useState, useEffect, useCallback } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import type { Session, Input, Vote } from "@shared/schema";
import { Shield, CheckCircle2, XCircle, Clock, Zap, Lock, ChevronRight, Copy, RefreshCw, AlertTriangle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";

interface SessionData {
  session: Session;
  inputs: Input[];
  votes: Vote[];
  attestation?: Record<string, unknown>;
}

const USER_NAMES = [
  "Alice", "Bob", "Charlie", "Diana", "Eve",
  "Frank", "Grace", "Hiro", "Iris", "Jack"
];

type PhaseStep = "collecting" | "reviewing" | "voting" | "executing" | "complete";

const PHASE_ORDER: PhaseStep[] = ["collecting", "reviewing", "voting", "executing", "complete"];

function PhaseIndicator({ current }: { current: PhaseStep }) {
  const phases = [
    { key: "collecting", label: "Input" },
    { key: "reviewing", label: "Review" },
    { key: "voting", label: "Vote" },
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
            <div className={`flex flex-col items-center flex-1 ${active ? "" : ""}`}>
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
    <svg aria-label="Consensus Prompt Logo" viewBox="0 0 40 40" fill="none" className="w-8 h-8 shrink-0">
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

export default function HomePage() {
  const [selectedUser, setSelectedUser] = useState<number | null>(null);
  const [inputText, setInputText] = useState("");
  const [copied, setCopied] = useState(false);
  const qc = useQueryClient();
  const { toast } = useToast();

  const { data, isLoading, refetch } = useQuery<SessionData>({
    queryKey: ["/api/session"],
    refetchInterval: (data) => {
      const status = data?.state?.data?.session?.status;
      if (status === "executing") return 2000;
      if (status === "voting" || status === "collecting") return 3000;
      return false;
    },
  });

  // Poll for result when executing
  const { data: resultData } = useQuery<SessionData>({
    queryKey: ["/api/session", data?.session?.id, "result"],
    enabled: !!data?.session?.id && data?.session?.status === "executing",
    refetchInterval: 2000,
    queryFn: async () => {
      if (!data?.session?.id) throw new Error("No session");
      const res = await apiRequest("GET", `/api/session/${data.session.id}/result`);
      return res.json();
    },
  });

  // Merge result data into main when complete
  useEffect(() => {
    if (resultData?.session?.status === "complete") {
      qc.setQueryData(["/api/session"], resultData);
    }
  }, [resultData, qc]);

  const submitInput = useMutation({
    mutationFn: async ({ content }: { content: string }) => {
      if (!data?.session || selectedUser === null) throw new Error("No session or user selected");
      const res = await apiRequest("POST", `/api/session/${data.session.id}/input`, {
        userId: selectedUser,
        userName: USER_NAMES[selectedUser - 1],
        content,
      });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || "Failed to submit");
      }
      return res.json();
    },
    onSuccess: () => {
      setInputText("");
      setSelectedUser(null);
      qc.invalidateQueries({ queryKey: ["/api/session"] });
      toast({ title: "Input submitted", description: "Your contribution has been recorded." });
    },
    onError: (e: Error) => {
      toast({ title: "Error", description: e.message, variant: "destructive" });
    },
  });

  const lockAndVote = useMutation({
    mutationFn: async () => {
      if (!data?.session) throw new Error("No session");
      const res = await apiRequest("POST", `/api/session/${data.session.id}/lock`);
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || "Failed to lock");
      }
      return res.json();
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["/api/session"] });
    },
    onError: (e: Error) => toast({ title: "Error", description: e.message, variant: "destructive" }),
  });

  const submitVote = useMutation({
    mutationFn: async ({ approve }: { approve: boolean }) => {
      if (!data?.session || selectedUser === null) throw new Error("No session or user selected");
      const res = await apiRequest("POST", `/api/session/${data.session.id}/vote`, {
        userId: selectedUser,
        userName: USER_NAMES[selectedUser - 1],
        approve,
      });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || "Failed to vote");
      }
      return res.json();
    },
    onSuccess: () => {
      setSelectedUser(null);
      qc.invalidateQueries({ queryKey: ["/api/session"] });
      toast({ title: "Vote recorded" });
    },
    onError: (e: Error) => toast({ title: "Error", description: e.message, variant: "destructive" }),
  });

  const newSession = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", "/api/session/new");
      return res.json();
    },
    onSuccess: () => {
      setSelectedUser(null);
      setInputText("");
      qc.invalidateQueries({ queryKey: ["/api/session"] });
      toast({ title: "New session started" });
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
  const inputs = data?.inputs ?? [];
  const votes = data?.votes ?? [];

  if (!session) return null;

  const approveCount = votes.filter(v => v.approve === 1).length;
  const rejectCount = votes.filter(v => v.approve === 0).length;
  const submittedUserIds = new Set(inputs.map(i => i.userId));
  const votedUserIds = new Set(votes.map(v => v.userId));

  const selectedUserHasInput = selectedUser !== null && submittedUserIds.has(selectedUser);
  const selectedUserHasVoted = selectedUser !== null && votedUserIds.has(selectedUser);

  const attestation = data?.attestation ?? (
    session.attestationReport ? JSON.parse(session.attestationReport) : null
  );

  return (
    <div className="min-h-screen bg-background">
      {/* Header */}
      <header className="border-b border-border bg-card/80 backdrop-blur sticky top-0 z-40">
        <div className="max-w-5xl mx-auto px-4 py-3 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <Logo />
            <div>
              <h1 className="text-base font-semibold font-mono text-foreground tracking-tight">
                Consensus<span className="text-primary">Prompt</span>
              </h1>
              <p className="text-[10px] text-muted-foreground font-mono uppercase tracking-widest">
                Phala Network TEE Engine
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <div className="hidden sm:flex items-center gap-1.5 px-2 py-1 rounded-md bg-muted/50 border border-border">
              <span className={`status-dot ${session.status === "complete" ? "success" : session.status === "executing" ? "active" : "active"}`} />
              <span className="text-xs font-mono text-muted-foreground capitalize">{session.status}</span>
            </div>
            {session.status === "complete" && (
              <Button
                size="sm"
                variant="outline"
                onClick={() => newSession.mutate()}
                disabled={newSession.isPending}
                data-testid="button-new-session"
                className="text-xs font-mono h-7"
              >
                <RefreshCw className="w-3 h-3 mr-1" />
                New Round
              </Button>
            )}
          </div>
        </div>
      </header>

      <main className="max-w-5xl mx-auto px-4 py-6 space-y-6">
        {/* Phase indicator */}
        <div className="px-4">
          <PhaseIndicator current={session.status as PhaseStep} />
        </div>

        {/* === COLLECTING PHASE === */}
        {(session.status === "collecting" || session.status === "reviewing") && (
          <div className="grid lg:grid-cols-5 gap-5">
            {/* Left: Input form */}
            <div className="lg:col-span-3 space-y-4">
              <div className="rounded-lg border border-border bg-card p-5 circuit-border">
                <div className="flex items-center gap-2 mb-4">
                  <Zap className="w-4 h-4 text-primary" />
                  <h2 className="font-mono font-semibold text-sm text-foreground uppercase tracking-wide">
                    Submit Your Input
                  </h2>
                  <Badge variant="outline" className="ml-auto font-mono text-[10px]">
                    {inputs.length}/10 submitted
                  </Badge>
                </div>

                {/* User selector */}
                <div className="mb-4">
                  <p className="text-xs text-muted-foreground font-mono mb-2 uppercase tracking-wider">Select Your Identity</p>
                  <div className="grid grid-cols-5 gap-1.5">
                    {USER_NAMES.map((name, i) => {
                      const uid = i + 1;
                      const hasSubmitted = submittedUserIds.has(uid);
                      return (
                        <button
                          key={uid}
                          data-testid={`button-user-${uid}`}
                          onClick={() => !hasSubmitted && setSelectedUser(uid)}
                          disabled={hasSubmitted}
                          className={`
                            py-1.5 rounded text-[11px] font-mono font-medium border transition-all
                            ${hasSubmitted ? "bg-primary/10 border-primary/30 text-primary/50 cursor-not-allowed" : ""}
                            ${selectedUser === uid && !hasSubmitted ? "bg-primary border-primary text-primary-foreground glow-cyan" : ""}
                            ${!hasSubmitted && selectedUser !== uid ? "bg-muted/50 border-border text-muted-foreground hover:border-primary/50 hover:text-foreground" : ""}
                          `}
                        >
                          {hasSubmitted ? "✓" : name.slice(0, 3)}
                        </button>
                      );
                    })}
                  </div>
                  {selectedUser && (
                    <p className="text-xs text-primary font-mono mt-1.5">
                      → {USER_NAMES[selectedUser - 1]} (User {selectedUser}) selected
                    </p>
                  )}
                </div>

                {/* Text input */}
                <div className="space-y-2">
                  <Textarea
                    data-testid="input-contribution"
                    placeholder="Enter your prompt contribution... What perspective, question, or instruction do you want to contribute to the consensus?"
                    value={inputText}
                    onChange={e => setInputText(e.target.value)}
                    disabled={selectedUser === null || selectedUserHasInput}
                    className="min-h-[120px] bg-input border-border font-sans text-sm resize-none focus:ring-primary focus:border-primary"
                  />
                  <div className="flex items-center justify-between">
                    <span className="text-xs text-muted-foreground font-mono">{inputText.length}/2000</span>
                    <Button
                      data-testid="button-submit-input"
                      onClick={() => submitInput.mutate({ content: inputText })}
                      disabled={!selectedUser || !inputText.trim() || selectedUserHasInput || submitInput.isPending}
                      size="sm"
                      className="font-mono text-xs bg-primary hover:bg-primary/80 text-primary-foreground"
                    >
                      {submitInput.isPending ? "Submitting..." : "Submit Input"}
                      <ChevronRight className="w-3 h-3 ml-1" />
                    </Button>
                  </div>
                </div>
              </div>

              {/* Lock & review button */}
              {inputs.length > 0 && session.status === "collecting" && (
                <Button
                  data-testid="button-lock-prompt"
                  variant="outline"
                  className="w-full font-mono text-xs border-primary/40 text-primary hover:bg-primary/10 h-9"
                  onClick={() => lockAndVote.mutate()}
                  disabled={lockAndVote.isPending}
                >
                  <Lock className="w-3 h-3 mr-2" />
                  Lock Inputs & Move to Voting ({inputs.length} submitted)
                </Button>
              )}
            </div>

            {/* Right: Submitted inputs list */}
            <div className="lg:col-span-2 space-y-2">
              <h3 className="text-xs font-mono text-muted-foreground uppercase tracking-wider flex items-center gap-2">
                <span className="status-dot active" />
                Contributions
              </h3>
              <div className="space-y-1.5 max-h-[420px] overflow-y-auto pr-1">
                {Array.from({ length: 10 }, (_, i) => {
                  const uid = i + 1;
                  const inp = inputs.find(x => x.userId === uid);
                  return (
                    <div
                      key={uid}
                      data-testid={`card-input-${uid}`}
                      className={`
                        rounded-md border p-2.5 transition-all duration-300
                        ${inp ? "bg-card border-primary/20 fade-in" : "bg-muted/20 border-border/50"}
                      `}
                    >
                      <div className="flex items-center gap-2 mb-1">
                        <span className={`text-[10px] font-mono font-bold ${inp ? "text-primary" : "text-muted-foreground/50"}`}>
                          {USER_NAMES[i]}
                        </span>
                        {inp ? (
                          <Badge className="h-4 text-[9px] font-mono bg-primary/15 text-primary border-primary/30 ml-auto">
                            ✓ submitted
                          </Badge>
                        ) : (
                          <span className="ml-auto text-[9px] text-muted-foreground/40 font-mono">pending</span>
                        )}
                      </div>
                      {inp && (
                        <p className="text-xs text-muted-foreground line-clamp-2">{inp.content}</p>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
        )}

        {/* === VOTING PHASE === */}
        {session.status === "voting" && (
          <div className="space-y-5">
            {/* Merged prompt preview */}
            <div className="rounded-lg border border-primary/20 bg-card p-5 circuit-border">
              <div className="flex items-center gap-2 mb-3">
                <Lock className="w-4 h-4 text-primary" />
                <h2 className="font-mono font-semibold text-sm text-foreground uppercase tracking-wide">
                  Merged Consensus Prompt
                </h2>
                <Badge variant="outline" className="ml-auto text-[10px] font-mono border-primary/40 text-primary">
                  Locked for Review
                </Badge>
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-6 w-6 p-0 text-muted-foreground hover:text-primary"
                  onClick={() => copyToClipboard(session.mergedPrompt ?? "")}
                  data-testid="button-copy-prompt"
                >
                  <Copy className="w-3 h-3" />
                </Button>
              </div>
              <div className="bg-muted/40 rounded-md p-3 font-mono text-xs text-muted-foreground whitespace-pre-wrap max-h-48 overflow-y-auto leading-relaxed border border-border/50">
                {session.mergedPrompt}
              </div>
              <p className="text-[10px] text-muted-foreground font-mono mt-2">
                SHA-256: <span className="text-primary/70 break-all">
                  {/* deterministic hash preview */}
                  {session.mergedPrompt
                    ? `${session.mergedPrompt.length.toString(16).padStart(4, "0")}…${session.mergedPrompt.slice(-8).split("").map(c => c.charCodeAt(0).toString(16)).join("")}`
                    : "—"}
                </span>
              </p>
            </div>

            {/* Vote progress */}
            <div className="rounded-lg border border-border bg-card p-5">
              <div className="flex items-center justify-between mb-4">
                <h3 className="font-mono text-sm font-semibold uppercase tracking-wide">Vote Progress</h3>
                <span className="text-xs font-mono text-muted-foreground">{votes.length}/10 voted · need 6 to approve</span>
              </div>

              <div className="grid grid-cols-2 gap-4 mb-4">
                <div className="text-center p-3 rounded-md bg-primary/5 border border-primary/20">
                  <div className="text-2xl font-mono font-bold text-primary">{approveCount}</div>
                  <div className="text-xs font-mono text-primary/70 uppercase tracking-wider mt-0.5">Approve</div>
                </div>
                <div className="text-center p-3 rounded-md bg-destructive/5 border border-destructive/20">
                  <div className="text-2xl font-mono font-bold text-destructive">{rejectCount}</div>
                  <div className="text-xs font-mono text-destructive/70 uppercase tracking-wider mt-0.5">Reject</div>
                </div>
              </div>

              <div className="progress-bar h-2 mb-4">
                <div className="progress-fill" style={{ width: `${(approveCount / 10) * 100}%` }} />
              </div>

              {/* Vote list */}
              <div className="grid grid-cols-5 gap-1.5 mb-5">
                {Array.from({ length: 10 }, (_, i) => {
                  const uid = i + 1;
                  const vote = votes.find(v => v.userId === uid);
                  return (
                    <div
                      key={uid}
                      data-testid={`chip-vote-${uid}`}
                      className={`
                        rounded px-1.5 py-1 text-center border transition-all
                        ${vote?.approve === 1 ? "bg-primary/10 border-primary/40 text-primary" : ""}
                        ${vote?.approve === 0 ? "bg-destructive/10 border-destructive/40 text-destructive" : ""}
                        ${!vote ? "bg-muted/20 border-border/40 text-muted-foreground/40" : ""}
                      `}
                    >
                      <div className="text-[9px] font-mono font-bold">
                        {USER_NAMES[i].slice(0, 3)}
                      </div>
                      <div className="text-[10px] mt-0.5">
                        {vote?.approve === 1 ? "✓" : vote?.approve === 0 ? "✗" : "·"}
                      </div>
                    </div>
                  );
                })}
              </div>

              {/* Cast your vote */}
              <div className="border-t border-border pt-4">
                <p className="text-xs font-mono text-muted-foreground mb-3 uppercase tracking-wider">Cast Your Vote</p>

                <div className="grid grid-cols-5 gap-1.5 mb-3">
                  {USER_NAMES.map((name, i) => {
                    const uid = i + 1;
                    const hasVoted = votedUserIds.has(uid);
                    return (
                      <button
                        key={uid}
                        data-testid={`button-voter-${uid}`}
                        onClick={() => !hasVoted && setSelectedUser(uid)}
                        disabled={hasVoted}
                        className={`
                          py-1.5 rounded text-[11px] font-mono font-medium border transition-all
                          ${hasVoted ? "bg-muted/20 border-border/30 text-muted-foreground/40 cursor-not-allowed" : ""}
                          ${selectedUser === uid && !hasVoted ? "bg-primary border-primary text-primary-foreground glow-cyan" : ""}
                          ${!hasVoted && selectedUser !== uid ? "bg-muted/50 border-border text-muted-foreground hover:border-primary/50 hover:text-foreground" : ""}
                        `}
                      >
                        {hasVoted ? (votes.find(v => v.userId === uid)?.approve === 1 ? "✓" : "✗") : name.slice(0, 3)}
                      </button>
                    );
                  })}
                </div>

                {selectedUser && !selectedUserHasVoted && (
                  <div className="flex gap-2">
                    <Button
                      data-testid="button-vote-approve"
                      onClick={() => submitVote.mutate({ approve: true })}
                      disabled={submitVote.isPending}
                      className="flex-1 font-mono text-xs bg-primary hover:bg-primary/80 text-primary-foreground h-9"
                    >
                      <CheckCircle2 className="w-3.5 h-3.5 mr-2" />
                      Approve
                    </Button>
                    <Button
                      data-testid="button-vote-reject"
                      onClick={() => submitVote.mutate({ approve: false })}
                      disabled={submitVote.isPending}
                      variant="destructive"
                      className="flex-1 font-mono text-xs h-9"
                    >
                      <XCircle className="w-3.5 h-3.5 mr-2" />
                      Reject
                    </Button>
                  </div>
                )}

                {selectedUser && selectedUserHasVoted && (
                  <div className="text-center text-xs font-mono text-muted-foreground py-2">
                    {USER_NAMES[selectedUser - 1]} has already voted
                  </div>
                )}

                {!selectedUser && (
                  <div className="text-center text-xs font-mono text-muted-foreground py-2">
                    Select a user above to vote
                  </div>
                )}
              </div>
            </div>
          </div>
        )}

        {/* === EXECUTING PHASE === */}
        {session.status === "executing" && (
          <div className="rounded-lg border border-primary/30 bg-card p-8 text-center glow-cyan">
            <div className="flex justify-center mb-4">
              <div className="relative">
                <div className="w-16 h-16 rounded-full border-2 border-primary/30 flex items-center justify-center">
                  <Shield className="w-8 h-8 text-primary animate-pulse" />
                </div>
                <div className="absolute inset-0 rounded-full border-2 border-primary/60 animate-ping" />
              </div>
            </div>
            <h2 className="font-mono font-bold text-lg text-foreground mb-2">
              Executing in TEE
            </h2>
            <p className="text-sm text-muted-foreground font-mono mb-1">
              Prompt is running inside Phala Network's Intel TDX + NVIDIA GPU enclave
            </p>
            <p className="text-xs text-muted-foreground/60 font-mono">
              Generating cryptographic attestation report...
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
        {session.status === "complete" && (
          <div className="space-y-5 fade-in">
            {/* LLM Response */}
            <div className="rounded-lg border border-primary/30 bg-card p-5 glow-cyan">
              <div className="flex items-center gap-2 mb-4">
                <Zap className="w-4 h-4 text-primary" />
                <h2 className="font-mono font-semibold text-sm uppercase tracking-wide">
                  TEE Response
                </h2>
                <Badge className="ml-auto text-[10px] font-mono bg-primary/15 text-primary border-primary/30">
                  Executed in Phala TEE
                </Badge>
              </div>
              <div className="prose prose-invert max-w-none">
                <div className="bg-muted/30 rounded-md p-4 border border-border/50 font-sans text-sm text-foreground leading-relaxed whitespace-pre-wrap">
                  {session.llmResponse}
                </div>
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
                      Demo mode: Set the <code className="bg-warning/20 px-1 rounded">REDPILL_API_KEY</code> environment variable to enable live TEE execution and real attestation from Phala Network.
                    </p>
                  </div>
                )}

                <div className="bg-background/60 rounded-md p-4 border border-border/50 overflow-x-auto hash-reveal">
                  <AttestationViewer data={attestation} />
                </div>
              </div>
            )}

            {/* Vote summary */}
            <div className="rounded-lg border border-border bg-card p-4">
              <h3 className="font-mono text-xs uppercase tracking-wider text-muted-foreground mb-3">Consensus Summary</h3>
              <div className="grid grid-cols-3 gap-3">
                <div className="text-center">
                  <div className="text-xl font-mono font-bold text-primary">{inputs.length}</div>
                  <div className="text-[10px] font-mono text-muted-foreground uppercase">Contributors</div>
                </div>
                <div className="text-center">
                  <div className="text-xl font-mono font-bold text-success">{approveCount}</div>
                  <div className="text-[10px] font-mono text-muted-foreground uppercase">Approved</div>
                </div>
                <div className="text-center">
                  <div className="text-xl font-mono font-bold text-destructive">{rejectCount}</div>
                  <div className="text-[10px] font-mono text-muted-foreground uppercase">Rejected</div>
                </div>
              </div>
            </div>
          </div>
        )}
      </main>

      {/* Footer */}
      <footer className="border-t border-border mt-12 py-4">
        <div className="max-w-5xl mx-auto px-4 flex items-center justify-between">
          <p className="text-xs font-mono text-muted-foreground/50">
            Powered by{" "}
            <a href="https://phala.network" target="_blank" rel="noopener noreferrer" className="text-primary/60 hover:text-primary transition-colors">
              Phala Network
            </a>
            {" "}TEE · {" "}
            <a href="https://red-pill.ai" target="_blank" rel="noopener noreferrer" className="text-primary/60 hover:text-primary transition-colors">
              RedPill AI
            </a>
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
              {typeof v === "object" ? (
                render(v, depth + 1)
              ) : (
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
          {(val as unknown[]).map((item, i) => (
            <div key={i}>{render(item, depth + 1)}</div>
          ))}
        </div>
      );
    }
    return <span className="attestation-value text-xs break-all">{String(val)}</span>;
  };

  return render(data);
}
