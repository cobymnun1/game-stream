"use client";

import { ConnectionCard } from "@/components/session/ConnectionCard";
import { DepositPanel } from "@/components/funding/DepositPanel";
import { getSession, teardownSession } from "@/lib/api";
import type { Session } from "@game-stream/shared";
import { usePrivy } from "@privy-io/react-auth";
import { useParams } from "next/navigation";
import { useCallback, useEffect, useState } from "react";

const DEPLOY_STATUSES = new Set([
  "deploying",
  "bid_wait",
  "lease_created",
  "manifest_sent",
  "lease_ready",
  "swap_complete",
]);

export default function SessionPage() {
  const params = useParams<{ id: string }>();
  const { getAccessToken } = usePrivy();
  const [session, setSession] = useState<Session | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tearingDown, setTearingDown] = useState(false);

  const load = useCallback(async () => {
    try {
      const token = await getAccessToken();
      if (!token) return;
      const s = await getSession(token, params.id);
      setSession(s);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load session");
    }
  }, [getAccessToken, params.id]);

  useEffect(() => {
    load();
    const id = setInterval(load, 5000);
    return () => clearInterval(id);
  }, [load]);

  async function handleTeardown() {
    setTearingDown(true);
    try {
      const token = await getAccessToken();
      if (!token) return;
      const s = await teardownSession(token, params.id);
      setSession(s);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Teardown failed");
    } finally {
      setTearingDown(false);
    }
  }

  if (!session) {
    return (
      <main style={{ maxWidth: 720, margin: "0 auto", padding: "2rem 1rem" }}>
        <p style={{ color: "var(--muted)" }}>Loading session…</p>
      </main>
    );
  }

  return (
    <main style={{ maxWidth: 720, margin: "0 auto", padding: "2rem 1rem" }}>
      <h1 style={{ fontSize: "1.25rem" }}>Session {session.id.slice(0, 8)}…</h1>
      <p style={{ color: "var(--muted)" }}>
        Status: <strong>{session.status}</strong>
      </p>

      {error && <p style={{ color: "var(--error)" }}>{error}</p>}

      {(session.status === "deposit_quote" ||
        session.status === "swap_in_progress") &&
        session.pricing && (
          <DepositPanel
            session={session}
            pricing={session.pricing}
            onSessionUpdate={setSession}
          />
        )}

      {DEPLOY_STATUSES.has(session.status) && session.status !== "ready" && (
        <div className="card">
          <p style={{ color: "var(--muted)", margin: 0 }}>
            {session.status === "swap_complete"
              ? "Swap complete. Deploy starting…"
              : `Deploy in progress (${session.status})…`}
          </p>
        </div>
      )}

      {session.status === "ready" && (
        <ConnectionCard
          session={session}
          onTeardown={handleTeardown}
          tearingDown={tearingDown}
        />
      )}

      {session.status === "failed" && (
        <div className="card">
          <p style={{ color: "var(--error)", margin: 0 }}>
            {session.error ?? "Session failed"}
          </p>
        </div>
      )}
    </main>
  );
}
