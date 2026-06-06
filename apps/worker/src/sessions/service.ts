import {
  CPU_MAX,
  CPU_MIN,
  RAM_MAX_GB,
  RAM_MIN_GB,
  type CreateSessionRequest,
  type SessionStatus,
} from "@basehack/shared";
import { eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { sessions, users } from "../db/schema.js";
import { runDeployJob } from "../deploy/deploy-job.js";
import { fetchAktUsdPrice, computeSessionPricing } from "../swap/pricing.js";
import { getSquidQuote, pollSquidStatus } from "../swap/squid.js";
import {
  getAkashAddress,
  getDecryptedMnemonic,
  provisionAkashWallet,
} from "../wallets/provision.js";
import {
  INITIAL_SWAP,
  mapSwapStatus,
  sessionToResponse,
} from "./state-machine.js";
import {
  closeDeployment,
  trackActiveDeployment,
  untrackActiveDeployment,
} from "./teardown.js";

async function updateSession(
  sessionId: string,
  patch: Partial<{
    status: SessionStatus;
    specs: unknown;
    pricing: unknown;
    swap: unknown;
    connection: unknown;
    error: string | null;
    activeDseq: string | null;
  }>
) {
  await db
    .update(sessions)
    .set({ ...patch, updatedAt: new Date() })
    .where(eq(sessions.id, sessionId));
}

export async function syncUser(
  privyUserId: string,
  baseWalletAddress: string
) {
  await db
    .insert(users)
    .values({ privyUserId, baseWalletAddress })
    .onConflictDoUpdate({
      target: users.privyUserId,
      set: { baseWalletAddress },
    });
}

export async function getUser(privyUserId: string) {
  const rows = await db
    .select()
    .from(users)
    .where(eq(users.privyUserId, privyUserId))
    .limit(1);
  return rows[0] ?? null;
}

export async function createSession(
  privyUserId: string,
  body: CreateSessionRequest
) {
  const { specs } = body;

  if (specs.cpuUnits < CPU_MIN || specs.cpuUnits > CPU_MAX) {
    throw new Error(`CPU must be between ${CPU_MIN} and ${CPU_MAX}`);
  }
  if (specs.memoryGb < RAM_MIN_GB || specs.memoryGb > RAM_MAX_GB) {
    throw new Error(`RAM must be between ${RAM_MIN_GB} and ${RAM_MAX_GB} GB`);
  }
  if (specs.durationHours <= 0 || specs.budgetUsd <= 0) {
    throw new Error("Duration and budget must be positive");
  }

  await db
    .insert(users)
    .values({ privyUserId })
    .onConflictDoNothing();

  const [session] = await db
    .insert(sessions)
    .values({
      privyUserId,
      status: "akash_provisioning",
      swap: INITIAL_SWAP,
    })
    .returning();

  try {
    await provisionAkashWallet(privyUserId);
    const aktUsdPrice = await fetchAktUsdPrice();
    const pricing = computeSessionPricing(
      specs.budgetUsd,
      specs.durationHours,
      aktUsdPrice
    );

    await updateSession(session.id, {
      status: "deposit_quote",
      specs,
      pricing,
    });

    const updated = await getSession(session.id, privyUserId);
    return updated!;
  } catch (e) {
    const message = e instanceof Error ? e.message : "Provisioning failed";
    await updateSession(session.id, { status: "failed", error: message });
    throw e;
  }
}

export async function getSession(sessionId: string, privyUserId: string) {
  const rows = await db
    .select()
    .from(sessions)
    .where(eq(sessions.id, sessionId))
    .limit(1);

  const row = rows[0];
  if (!row || row.privyUserId !== privyUserId) return null;
  return sessionToResponse(row);
}

export async function getSquidQuoteForSession(
  privyUserId: string,
  sessionId: string,
  fromAmount: string,
  fundingToken: "ETH" | "USDC"
) {
  const session = await getSession(sessionId, privyUserId);
  if (!session) throw new Error("Session not found");

  const user = await getUser(privyUserId);
  const akashAddress = await getAkashAddress(privyUserId);
  if (!user?.baseWalletAddress || !akashAddress) {
    throw new Error("Wallets not ready");
  }

  const quote = await getSquidQuote({
    fromAddress: user.baseWalletAddress,
    toAddress: akashAddress,
    fromAmount,
    fundingToken,
    quoteOnly: true,
  });

  await updateSession(sessionId, {
    status: "deposit_quote",
    swap: {
      ...session.swap,
      status: "quoting",
      quoteId: quote.route.quoteId,
      fromAmount: quote.route.estimate.fromAmount,
      toAmount: quote.route.estimate.toAmount,
      error: null,
    },
  });

  return quote;
}

export async function getSquidRouteForSession(
  privyUserId: string,
  sessionId: string,
  fromAmount: string,
  fundingToken: "ETH" | "USDC"
) {
  const user = await getUser(privyUserId);
  const akashAddress = await getAkashAddress(privyUserId);
  if (!user?.baseWalletAddress || !akashAddress) {
    throw new Error("Wallets not ready");
  }

  await updateSession(sessionId, {
    status: "swap_in_progress",
    swap: {
      ...INITIAL_SWAP,
      status: "awaiting_signature",
    },
  });

  return getSquidQuote({
    fromAddress: user.baseWalletAddress,
    toAddress: akashAddress,
    fromAmount,
    fundingToken,
    quoteOnly: false,
  });
}

export async function submitSwapTx(
  privyUserId: string,
  sessionId: string,
  baseTxHash: string,
  quoteId: string
) {
  const session = await getSession(sessionId, privyUserId);
  if (!session) throw new Error("Session not found");

  await updateSession(sessionId, {
    status: "swap_in_progress",
    swap: {
      ...session.swap,
      status: "tx_submitted",
      baseTxHash,
      quoteId,
      error: null,
    },
  });

  pollSwapInBackground(sessionId, privyUserId, baseTxHash, quoteId);
}

async function pollSwapInBackground(
  sessionId: string,
  privyUserId: string,
  baseTxHash: string,
  quoteId: string
) {
  try {
    const result = await pollSquidStatus(
      { transactionId: baseTxHash, quoteId },
      async (squidStatus) => {
        const swapStatus = mapSwapStatus(squidStatus);
        const session = await getSession(sessionId, privyUserId);
        if (session) {
          await updateSession(sessionId, {
            swap: { ...session.swap, status: swapStatus },
          });
        }
      }
    );

    if (result.squidTransactionStatus !== "success") {
      await updateSession(sessionId, {
        status: "failed",
        swap: {
          ...INITIAL_SWAP,
          status: mapSwapStatus(result.squidTransactionStatus),
          baseTxHash,
          quoteId,
          error: `Swap ended with status: ${result.squidTransactionStatus}`,
        },
      });
      return;
    }

    const session = await getSession(sessionId, privyUserId);
    await updateSession(sessionId, {
      status: "swap_complete",
      swap: {
        ...(session?.swap ?? INITIAL_SWAP),
        status: "arrived",
        baseTxHash,
        quoteId,
        error: null,
      },
    });

    if (session?.specs && session.pricing) {
      startDeployInBackground(sessionId, privyUserId);
    }
  } catch (e) {
    const message = e instanceof Error ? e.message : "Swap polling failed";
    await updateSession(sessionId, {
      status: "failed",
      error: message,
    });
  }
}

export async function startDeploy(
  privyUserId: string,
  sessionId: string
) {
  const session = await getSession(sessionId, privyUserId);
  if (!session) throw new Error("Session not found");
  if (session.status !== "swap_complete") {
    throw new Error("Session must complete swap before deploy");
  }
  startDeployInBackground(sessionId, privyUserId);
}

async function startDeployInBackground(
  sessionId: string,
  privyUserId: string
) {
  const session = await getSession(sessionId, privyUserId);
  if (!session?.specs || !session.pricing) {
    await updateSession(sessionId, {
      status: "failed",
      error: "Missing session specs or pricing",
    });
    return;
  }

  let mnemonic = "";
  try {
    const creds = await getDecryptedMnemonic(privyUserId);
    mnemonic = creds.mnemonic;

    const result = await runDeployJob({
      mnemonic,
      ownerAddress: creds.address,
      specs: session.specs,
      pricing: session.pricing,
      callbacks: {
        onStatus: async (status, extra) => {
          await updateSession(sessionId, {
            status,
            ...(extra?.dseq
              ? { activeDseq: String(extra.dseq) }
              : {}),
          });
        },
      },
    });

    trackActiveDeployment(sessionId, creds.address, result.dseq);

    await updateSession(sessionId, {
      status: "ready",
      activeDseq: String(result.dseq),
      connection: {
        hostname: result.connection.hostname,
        forwardedPorts: result.connection.forwardedPorts,
        sunshineCredentials: result.connection.sunshineCredentials,
        leaseId: result.leaseId,
        dseq: result.dseq,
        provider: result.provider,
      },
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : "Deploy failed";
    await updateSession(sessionId, { status: "failed", error: message });
  } finally {
    if (mnemonic) mnemonic.split("").fill("");
  }
}

export async function teardownSession(
  privyUserId: string,
  sessionId: string
) {
  const session = await getSession(sessionId, privyUserId);
  if (!session) throw new Error("Session not found");

  await updateSession(sessionId, { status: "tearing_down" });

  const activeDseq = (
    await db
      .select({ activeDseq: sessions.activeDseq })
      .from(sessions)
      .where(eq(sessions.id, sessionId))
      .limit(1)
  )[0]?.activeDseq;

  const parsedDseq =
    session.connection?.dseq ?? (activeDseq ? Number(activeDseq) : null);
  if (!parsedDseq || Number.isNaN(parsedDseq)) {
    await updateSession(sessionId, { status: "closed" });
    return sessionToResponse(
      (
        await db
          .select()
          .from(sessions)
          .where(eq(sessions.id, sessionId))
          .limit(1)
      )[0]
    );
  }

  let mnemonic = "";
  try {
    const creds = await getDecryptedMnemonic(privyUserId);
    mnemonic = creds.mnemonic;
    await closeDeployment({
      mnemonic,
      ownerAddress: creds.address,
      dseq: parsedDseq,
    });
    untrackActiveDeployment(sessionId);
    await updateSession(sessionId, { status: "closed", activeDseq: null });
  } catch (e) {
    const message = e instanceof Error ? e.message : "Teardown failed";
    await updateSession(sessionId, { status: "failed", error: message });
  } finally {
    if (mnemonic) mnemonic.split("").fill("");
  }

  const row = (
    await db.select().from(sessions).where(eq(sessions.id, sessionId)).limit(1)
  )[0];
  return sessionToResponse(row);
}

export async function getShutdownCredentials(sessionId: string) {
  const rows = await db
    .select()
    .from(sessions)
    .where(eq(sessions.id, sessionId))
    .limit(1);
  const row = rows[0];
  if (!row?.activeDseq) return null;

  try {
    const creds = await getDecryptedMnemonic(row.privyUserId);
    return {
      mnemonic: creds.mnemonic,
      ownerAddress: creds.address,
      dseq: Number(row.activeDseq),
    };
  } catch {
    return null;
  }
}
