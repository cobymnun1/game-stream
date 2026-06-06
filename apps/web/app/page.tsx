"use client";

import { LoginButton } from "@/components/auth/LoginButton";
import { GpuSelect } from "@/components/specs/GpuSelect";
import { ResourceSliders } from "@/components/specs/ResourceSliders";
import { DepositPanel } from "@/components/funding/DepositPanel";
import { ConnectionCard } from "@/components/session/ConnectionCard";
import { createSession, getSession, syncAuth, teardownSession } from "@/lib/api";
import type { FundingToken, GpuId, Session } from "@game-stream/shared";
import { usePrivy } from "@privy-io/react-auth";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";

const DEPLOY_STATUSES = new Set([
  "deploying",
  "bid_wait",
  "lease_created",
  "manifest_sent",
  "lease_ready",
]);

export default function HomePage() {
  const { ready, authenticated, user, getAccessToken } = usePrivy();
  const router = useRouter();

  const [synced, setSynced] = useState(false);
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [tearingDown, setTearingDown] = useState(false);

  const [gpuId, setGpuId] = useState<GpuId>("rtx4090");
  const [cpuUnits, setCpuUnits] = useState(16);
  const [memoryGb, setMemoryGb] = useState(32);
  const [durationHours, setDurationHours] = useState(2);
  const [budgetUsd, setBudgetUsd] = useState(5);
  const [fundingToken] = useState<FundingToken>("USDC");

  const pollSession = useCallback(
    async (sessionId: string, token: string) => {
      const s = await getSession(token, sessionId);
      setSession(s);
      return s;
    },
    []
  );

  useEffect(() => {
    if (!ready || !authenticated || !user || synced) return;

    (async () => {
      try {
        const token = await getAccessToken();
        if (!token) return;

        const baseWallet =
          user.wallet?.address ??
          user.linkedAccounts?.find(
            (a) => a.type === "wallet" && "address" in a
          )?.address;

        if (baseWallet) {
          await syncAuth(token, { baseWalletAddress: baseWallet });
        }
        setSynced(true);
      } catch (e) {
        setError(e instanceof Error ? e.message : "Auth sync failed");
      }
    })();
  }, [ready, authenticated, user, synced, getAccessToken]);

  useEffect(() => {
    if (!session?.id) return;
    const terminal = new Set(["ready", "closed", "failed"]);
    if (terminal.has(session.status)) return;

    const id = setInterval(async () => {
      try {
        const token = await getAccessToken();
        if (!token) return;
        await pollSession(session.id, token);
      } catch {
        /* ignore poll errors */
      }
    }, 5000);

    return () => clearInterval(id);
  }, [session?.id, session?.status, getAccessToken, pollSession]);

  async function handleCreateSession() {
    setLoading(true);
    setError(null);
    try {
      const token = await getAccessToken();
      if (!token) throw new Error("Not authenticated");

      const s = await createSession(token, {
        specs: {
          gpuId,
          cpuUnits,
          memoryGb,
          durationHours,
          budgetUsd,
          fundingToken,
        },
      });
      setSession(s);
      router.push(`/session/${s.id}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to create session");
    } finally {
      setLoading(false);
    }
  }

  async function handleTeardown() {
    if (!session) return;
    setTearingDown(true);
    try {
      const token = await getAccessToken();
      if (!token) return;
      const s = await teardownSession(token, session.id);
      setSession(s);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Teardown failed");
    } finally {
      setTearingDown(false);
    }
  }

  const showSpecs =
    !session ||
    session.status === "spec_select" ||
    session.status === "akash_provisioning";
  const showDeposit =
    session &&
    (session.status === "deposit_quote" ||
      session.status === "swap_in_progress" ||
      session.swap.status !== "idle");
  const showDeploying = session && DEPLOY_STATUSES.has(session.status);
  const showConnection = session?.status === "ready";

  return (
    <main style={{ maxWidth: 720, margin: "0 auto", padding: "2rem 1rem" }}>
      <header
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          marginBottom: "2rem",
        }}
      >
        <div>
          <h1 style={{ margin: 0, fontSize: "1.5rem" }}>Game Stream Launch</h1>
          <p style={{ margin: "0.25rem 0 0", color: "var(--muted)" }}>
            Decentralized Sunshine streaming on Akash
          </p>
        </div>
        <LoginButton />
      </header>

      {error && (
        <div
          className="card"
          style={{ borderColor: "var(--error)", marginBottom: "1rem" }}
        >
          <p style={{ margin: 0, color: "var(--error)" }}>{error}</p>
        </div>
      )}

      {!authenticated && (
        <div className="card">
          <p>Sign in to provision an Akash wallet and launch a stream.</p>
        </div>
      )}

      {authenticated && showSpecs && (
        <div className="card">
          <h2 style={{ marginTop: 0, fontSize: "1.125rem" }}>Session specs</h2>
          <GpuSelect value={gpuId} onChange={setGpuId} />
          <ResourceSliders
            cpuUnits={cpuUnits}
            memoryGb={memoryGb}
            durationHours={durationHours}
            budgetUsd={budgetUsd}
            onCpuChange={setCpuUnits}
            onMemoryChange={setMemoryGb}
            onDurationChange={setDurationHours}
            onBudgetChange={setBudgetUsd}
          />
          <button
            className="btn"
            onClick={handleCreateSession}
            disabled={loading}
          >
            {loading ? "Provisioning…" : "Create session"}
          </button>
        </div>
      )}

      {session?.pricing && showDeposit && !showConnection && (
        <div style={{ marginTop: "1rem" }}>
          <DepositPanel
            session={session}
            pricing={session.pricing}
            onSessionUpdate={setSession}
          />
        </div>
      )}

      {showDeploying && (
        <div className="card" style={{ marginTop: "1rem" }}>
          <h3 style={{ marginTop: 0 }}>Deploying</h3>
          <p style={{ color: "var(--muted)" }}>
            Status: <strong>{session?.status}</strong>
          </p>
          <p style={{ fontSize: "0.875rem", color: "var(--muted)" }}>
            Waiting for provider bids, lease, and container readiness…
          </p>
        </div>
      )}

      {showConnection && session && (
        <div style={{ marginTop: "1rem" }}>
          <ConnectionCard
            session={session}
            onTeardown={handleTeardown}
            tearingDown={tearingDown}
          />
        </div>
      )}

      {session?.status === "failed" && (
        <div className="card" style={{ marginTop: "1rem" }}>
          <p style={{ color: "var(--error)", margin: 0 }}>
            {session.error ?? "Session failed"}
          </p>
        </div>
      )}
    </main>
  );
}
