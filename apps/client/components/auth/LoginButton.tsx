"use client";

import { usePrivy } from "@privy-io/react-auth";

export function LoginButton() {
  const { ready, authenticated, login, logout, user } = usePrivy();

  if (!ready) {
    return <button className="btn" disabled>Loading…</button>;
  }

  if (authenticated) {
    const label =
      user?.twitter?.username ??
      user?.discord?.username ??
      user?.wallet?.address?.slice(0, 8) ??
      "User";
    return (
      <div style={{ display: "flex", gap: "0.75rem", alignItems: "center" }}>
        <span style={{ color: "var(--muted)", fontSize: "0.875rem" }}>
          {label}
        </span>
        <button className="btn btn-secondary" onClick={logout}>
          Log out
        </button>
      </div>
    );
  }

  return (
    <button className="btn" onClick={login}>
      Sign in with Discord, X, or Wallet
    </button>
  );
}
