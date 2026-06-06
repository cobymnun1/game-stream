"use client";

import {
  CPU_MAX,
  CPU_MIN,
  RAM_MAX_GB,
  RAM_MIN_GB,
  STORAGE_GB,
} from "@basehack/shared";

interface ResourceSlidersProps {
  cpuUnits: number;
  memoryGb: number;
  durationHours: number;
  budgetUsd: number;
  onCpuChange: (v: number) => void;
  onMemoryChange: (v: number) => void;
  onDurationChange: (v: number) => void;
  onBudgetChange: (v: number) => void;
}

export function ResourceSliders({
  cpuUnits,
  memoryGb,
  durationHours,
  budgetUsd,
  onCpuChange,
  onMemoryChange,
  onDurationChange,
  onBudgetChange,
}: ResourceSlidersProps) {
  return (
    <>
      <div className="field">
        <div className="slider-row">
          <label className="label" style={{ margin: 0 }}>
            vCPU
          </label>
          <span>{cpuUnits} cores</span>
        </div>
        <input
          type="range"
          min={CPU_MIN}
          max={CPU_MAX}
          step={1}
          value={cpuUnits}
          onChange={(e) => onCpuChange(Number(e.target.value))}
          style={{ width: "100%" }}
        />
      </div>

      <div className="field">
        <div className="slider-row">
          <label className="label" style={{ margin: 0 }}>
            RAM
          </label>
          <span>{memoryGb} GB</span>
        </div>
        <input
          type="range"
          min={RAM_MIN_GB}
          max={RAM_MAX_GB}
          step={4}
          value={memoryGb}
          onChange={(e) => onMemoryChange(Number(e.target.value))}
          style={{ width: "100%" }}
        />
      </div>

      <div className="field">
        <label className="label">Storage (ephemeral)</label>
        <input
          type="text"
          value={`${STORAGE_GB} GB`}
          disabled
          style={{
            width: "100%",
            padding: "0.6rem",
            borderRadius: "8px",
            border: "1px solid var(--border)",
            background: "var(--bg)",
            color: "var(--muted)",
          }}
        />
      </div>

      <div className="field">
        <div className="slider-row">
          <label className="label" style={{ margin: 0 }}>
            Session duration
          </label>
          <span>{durationHours} hr</span>
        </div>
        <input
          type="range"
          min={1}
          max={8}
          step={1}
          value={durationHours}
          onChange={(e) => onDurationChange(Number(e.target.value))}
          style={{ width: "100%" }}
        />
      </div>

      <div className="field">
        <label className="label" htmlFor="budget">
          Session budget (USD)
        </label>
        <input
          id="budget"
          type="number"
          min={1}
          step={0.5}
          value={budgetUsd}
          onChange={(e) => onBudgetChange(Number(e.target.value))}
          style={{
            width: "100%",
            padding: "0.6rem",
            borderRadius: "8px",
            border: "1px solid var(--border)",
            background: "var(--bg)",
            color: "var(--text)",
          }}
        />
      </div>
    </>
  );
}
