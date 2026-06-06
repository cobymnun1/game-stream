"use client";

import { GPU_OPTIONS, type GpuId } from "@game-stream/shared";

interface GpuSelectProps {
  value: GpuId;
  onChange: (value: GpuId) => void;
}

export function GpuSelect({ value, onChange }: GpuSelectProps) {
  return (
    <div className="field">
      <label className="label" htmlFor="gpu">
        GPU
      </label>
      <select
        id="gpu"
        value={value}
        onChange={(e) => onChange(e.target.value as GpuId)}
        style={{
          width: "100%",
          padding: "0.6rem",
          borderRadius: "8px",
          border: "1px solid var(--border)",
          background: "var(--bg)",
          color: "var(--text)",
        }}
      >
        {GPU_OPTIONS.map((gpu) => (
          <option key={gpu.id} value={gpu.id}>
            {gpu.label}
          </option>
        ))}
      </select>
    </div>
  );
}
