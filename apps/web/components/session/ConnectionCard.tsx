"use client";

import type { Session } from "@game-stream/shared";

interface ConnectionCardProps {
  session: Session;
  onTeardown: () => void;
  tearingDown?: boolean;
}

export function ConnectionCard({
  session,
  onTeardown,
  tearingDown,
}: ConnectionCardProps) {
  const conn = session.connection;
  if (!conn) return null;

  return (
    <div className="card">
      <div style={{ display: "flex", justifyContent: "space-between" }}>
        <h3 style={{ marginTop: 0 }}>Session Ready</h3>
        <span
          className={`status-pill ${session.status === "ready" ? "ready" : ""}`}
        >
          {session.status}
        </span>
      </div>

      <div style={{ fontSize: "0.875rem", lineHeight: 1.7 }}>
        <p>
          <strong>Hostname:</strong> {conn.hostname || "Pending…"}
        </p>
        <p>
          <strong>Lease:</strong> {conn.leaseId}
        </p>
        <p>
          <strong>Provider:</strong> {conn.provider}
        </p>
        <p>
          <strong>dseq:</strong> {conn.dseq}
        </p>

        {conn.sunshineCredentials ? (
          <div
            style={{
              marginTop: "1rem",
              padding: "1rem",
              background: "var(--bg)",
              borderRadius: "8px",
            }}
          >
            <p style={{ margin: "0 0 0.5rem" }}>
              <strong>Sunshine credentials</strong>
            </p>
            <p style={{ margin: 0 }}>
              User: {conn.sunshineCredentials.username}
            </p>
            <p style={{ margin: 0 }}>
              Pass: {conn.sunshineCredentials.password}
            </p>
          </div>
        ) : (
          <p style={{ color: "var(--muted)" }}>
            Sunshine credentials not yet available in logs.
          </p>
        )}

        {conn.forwardedPorts.length > 0 && (
          <div style={{ marginTop: "1rem" }}>
            <strong>Forwarded ports</strong>
            <ul style={{ paddingLeft: "1.25rem", margin: "0.5rem 0 0" }}>
              {conn.forwardedPorts.map((p) => (
                <li key={`${p.proto}-${p.port}`}>
                  {p.proto.toUpperCase()} {p.port} → {p.externalPort}
                  {p.host ? ` (${p.host})` : ""}
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>

      <button
        className="btn btn-secondary"
        onClick={onTeardown}
        disabled={tearingDown || session.status === "closed"}
        style={{ marginTop: "1.5rem" }}
      >
        {tearingDown ? "Ending session…" : "End session"}
      </button>
    </div>
  );
}
