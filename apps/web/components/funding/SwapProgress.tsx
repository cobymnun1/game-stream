"use client";

import type { SwapStatus } from "@game-stream/shared";

const STEPS: { key: SwapStatus; label: string }[] = [
  { key: "quoting", label: "Quote" },
  { key: "awaiting_signature", label: "Sign tx" },
  { key: "tx_submitted", label: "Submitted" },
  { key: "bridging", label: "Bridging" },
  { key: "arrived", label: "Arrived" },
];

const ORDER = STEPS.map((s) => s.key);

interface SwapProgressProps {
  status: SwapStatus;
  error?: string | null;
}

export function SwapProgress({ status, error }: SwapProgressProps) {
  const currentIdx = ORDER.indexOf(status);

  return (
    <div>
      <div className="step-list">
        {STEPS.map((step, idx) => {
          let cls = "step";
          if (status === "failed" || status === "refund") {
            cls = idx <= currentIdx ? "step failed" : "step";
          } else if (idx < currentIdx) {
            cls = "step done";
          } else if (idx === currentIdx) {
            cls = "step active";
          }
          return (
            <span key={step.key} className={cls}>
              {step.label}
            </span>
          );
        })}
      </div>
      {error && (
        <p style={{ color: "var(--error)", fontSize: "0.875rem" }}>{error}</p>
      )}
    </div>
  );
}
