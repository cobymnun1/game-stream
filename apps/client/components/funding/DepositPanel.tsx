"use client";

import type { FundingToken, Session, SessionPricing } from "@basehack/shared";
import { usePrivy, useWallets } from "@privy-io/react-auth";
import { useCallback, useEffect, useState } from "react";
import { createPublicClient, formatEther, formatUnits, http } from "viem";
import { base } from "viem/chains";
import { FUNDING_TOKENS } from "@basehack/shared";
import { getQuote, getRoute, submitSwap } from "@/lib/api";
import { executeSquidRoute } from "@/lib/squid-client";
import { SwapProgress } from "./SwapProgress";

const ERC20_BALANCE_ABI = [
  {
    name: "balanceOf",
    type: "function",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ type: "uint256" }],
    stateMutability: "view",
  },
] as const;

interface DepositPanelProps {
  session: Session;
  pricing: SessionPricing;
  onSessionUpdate: (session: Session) => void;
}

export function DepositPanel({
  session,
  pricing,
  onSessionUpdate,
}: DepositPanelProps) {
  const { getAccessToken } = usePrivy();
  const { wallets } = useWallets();
  // Prefer Privy embedded wallet; fall back to first connected wallet
  const embeddedWallet = wallets.find((w) => w.walletClientType === "privy") ?? wallets[0];

  const [fundingToken, setFundingToken] = useState<FundingToken>("USDC");
  const [ethBalance, setEthBalance] = useState<string>("—");
  const [usdcBalance, setUsdcBalance] = useState<string>("—");
  const [quoteToAmount, setQuoteToAmount] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const baseAddress = embeddedWallet?.address;

  const refreshBalances = useCallback(async () => {
    if (!baseAddress) return;
    const client = createPublicClient({ chain: base, transport: http() });
    const eth = await client.getBalance({ address: baseAddress as `0x${string}` });
    setEthBalance(formatEther(eth));

    const usdc = await client.readContract({
      address: FUNDING_TOKENS.USDC as `0x${string}`,
      abi: ERC20_BALANCE_ABI,
      functionName: "balanceOf",
      args: [baseAddress as `0x${string}`],
    });
    setUsdcBalance(formatUnits(usdc, 6));
  }, [baseAddress]);

  useEffect(() => {
    refreshBalances();
  }, [refreshBalances]);

  const fromAmount =
    fundingToken === "USDC"
      ? String(Math.ceil(pricing.depositAkt ? Number(pricing.depositAkt) * 1.05 * 1_000_000 : 0))
      : undefined;

  const fetchQuote = useCallback(async () => {
    if (!fromAmount || fromAmount === "0") return;
    try {
      const token = await getAccessToken();
      if (!token) return;
      const quote = (await getQuote(
        token,
        session.id,
        fromAmount,
        fundingToken
      )) as {
        route: { estimate: { toAmount: string } };
      };
      setQuoteToAmount(quote.route.estimate.toAmount);
      setError(null); // clear any previous rate limit errors on success
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Quote failed";
      // Don't show rate limit errors as red errors — just silently retry
      if (!msg.includes("429") && !msg.includes("RATE_LIMIT") && !msg.includes("Too many")) {
        setError(msg);
      }
    }
  }, [getAccessToken, session.id, fromAmount, fundingToken]);

  // Poll every 45s to avoid Squid rate limits (20s was too aggressive)
  useEffect(() => {
    const id = setInterval(fetchQuote, 45_000);
    fetchQuote();
    return () => clearInterval(id);
  }, [fetchQuote]);

  async function handleSwap() {
    if (!embeddedWallet || !fromAmount) {
      setError("Embedded Base wallet not ready");
      return;
    }

    setLoading(true);
    setError(null);

    try {
      const token = await getAccessToken();
      if (!token) throw new Error("Not authenticated");

      const routeRes = await getRoute(
        token,
        session.id,
        fromAmount,
        fundingToken
      );

      const txHash = await executeSquidRoute({
        wallet: embeddedWallet,
        route: routeRes.route,
        fundingToken,
      });

      const updated = await submitSwap(
        token,
        session.id,
        txHash,
        routeRes.route.quoteId
      );
      onSessionUpdate(updated);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Swap failed");
    } finally {
      setLoading(false);
    }
  }

  const swapStatus = session.swap?.status ?? "idle";

  return (
    <div className="card">
      <h3 style={{ marginTop: 0 }}>Deposit &amp; Swap</h3>
      <p style={{ color: "var(--muted)", fontSize: "0.875rem" }}>
        Send funds to your Base wallet below, then confirm payment to reserve
        your session. Estimated total: ~${session.specs?.budgetUsd ?? "—"}
      </p>

      {baseAddress && (
        <p style={{ fontSize: "0.8rem", wordBreak: "break-all" }}>
          Base wallet: {baseAddress}
        </p>
      )}

      <p style={{ fontSize: "0.875rem" }}>
        Balances — ETH: {ethBalance} | USDC: {usdcBalance}
      </p>

      <div className="field">
        <label className="label">Funding token</label>
        <select
          value={fundingToken}
          onChange={(e) => setFundingToken(e.target.value as FundingToken)}
          style={{
            width: "100%",
            padding: "0.6rem",
            borderRadius: "8px",
            border: "1px solid var(--border)",
            background: "var(--bg)",
            color: "var(--text)",
          }}
        >
          <option value="USDC">USDC on Base</option>
          <option value="ETH">ETH on Base</option>
        </select>
      </div>

      {quoteToAmount && (
        <p style={{ fontSize: "0.875rem" }}>
          Quote ready — proceed when your Base balance is sufficient.
        </p>
      )}

      <SwapProgress status={swapStatus} error={session.swap?.error ?? error} />

      {swapStatus === "idle" || swapStatus === "quoting" ? (
        <button
          className="btn"
          onClick={handleSwap}
          disabled={loading || !embeddedWallet}
          style={{ marginTop: "1rem" }}
        >
          {loading ? "Processing…" : "Pay & reserve session"}
        </button>
      ) : null}
    </div>
  );
}
