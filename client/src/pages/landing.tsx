import { useLocation } from "wouter";
import { Shield, Zap, ChevronRight } from "lucide-react";

export default function LandingPage() {
  const [, navigate] = useLocation();

  return (
    <div className="min-h-screen bg-background flex flex-col items-center justify-center p-6">
      <div className="text-center mb-10">
        <h1 className="text-3xl font-bold font-mono text-foreground tracking-tight mb-2">
          AI<span className="text-primary">Council</span>
        </h1>
        <p className="text-sm text-muted-foreground font-mono">
          Verifiable AI consensus — choose your TEE provider
        </p>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 w-full max-w-xl">
        {/* OpenGradient */}
        <button
          onClick={() => navigate("/og")}
          className="group rounded-xl border border-primary/30 bg-card p-6 text-left hover:border-primary hover:glow-cyan transition-all duration-200"
        >
          <div className="flex items-center gap-2 mb-3">
            <div className="w-8 h-8 rounded-lg bg-primary/10 border border-primary/30 flex items-center justify-center">
              <Zap className="w-4 h-4 text-primary" />
            </div>
            <span className="font-mono font-bold text-sm text-foreground">OpenGradient</span>
          </div>
          <p className="text-xs text-muted-foreground font-mono leading-relaxed mb-4">
            Intel TDX TEE nodes with on-chain proof via x402 payment settlement on Base mainnet.
          </p>
          <div className="flex items-center gap-1 text-xs font-mono text-primary group-hover:gap-2 transition-all">
            Launch Council <ChevronRight className="w-3 h-3" />
          </div>
        </button>

        {/* Phala */}
        <button
          onClick={() => navigate("/phala")}
          className="group rounded-xl border border-purple/30 bg-card p-6 text-left hover:border-purple transition-all duration-200"
        >
          <div className="flex items-center gap-2 mb-3">
            <div className="w-8 h-8 rounded-lg bg-purple/10 border border-purple/30 flex items-center justify-center">
              <Shield className="w-4 h-4 text-purple" />
            </div>
            <span className="font-mono font-bold text-sm text-foreground">Phala Network</span>
          </div>
          <p className="text-xs text-muted-foreground font-mono leading-relaxed mb-4">
            Intel TDX / SGX TEE nodes via Phala dstack with cryptographic attestation from Red Pill AI.
          </p>
          <div className="flex items-center gap-1 text-xs font-mono text-purple group-hover:gap-2 transition-all">
            Launch Council <ChevronRight className="w-3 h-3" />
          </div>
        </button>
      </div>
    </div>
  );
}
