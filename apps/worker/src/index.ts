import "./env.js";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { verifyPrivyToken } from "./auth/privy-verify.js";
import { initDb } from "./db/index.js";
import {
  createSession,
  getSession,
  getSquidQuoteForSession,
  getSquidRouteForSession,
  getShutdownCredentials,
  getUser,
  startDeploy,
  submitSwapTx,
  syncUser,
  teardownSession,
} from "./sessions/service.js";
import { provisionAkashWallet } from "./wallets/provision.js";
import { registerShutdownHandler } from "./sessions/teardown.js";
import type {
  AuthSyncRequest,
  CreateSessionRequest,
  SquidQuoteRequest,
  SquidSwapSubmitRequest,
} from "@basehack/shared";

const app = new Hono();

app.use(
  "/*",
  cors({
    origin: process.env.CORS_ORIGIN ?? "http://localhost:3000",
    allowHeaders: ["Authorization", "Content-Type"],
    allowMethods: ["GET", "POST", "DELETE", "OPTIONS"],
  })
);

app.get("/health", (c) => c.json({ ok: true }));

async function authMiddleware(c: {
  req: { header: (name: string) => string | undefined };
}) {
  const privyUserId = await verifyPrivyToken(
    c.req.header("Authorization")
  );
  return privyUserId;
}

app.post("/auth/sync", async (c) => {
  try {
    const privyUserId = await authMiddleware(c);
    const body = (await c.req.json()) as AuthSyncRequest;
    if (!body.baseWalletAddress) {
      return c.json({ error: "baseWalletAddress required" }, 400);
    }
    await syncUser(privyUserId, body.baseWalletAddress);
    const akashAddress = await provisionAkashWallet(privyUserId);
    const user = await getUser(privyUserId);
    return c.json({
      privyUserId,
      baseWalletAddress: user?.baseWalletAddress ?? body.baseWalletAddress,
      akashAddress,
    });
  } catch (e) {
    return c.json(
      { error: e instanceof Error ? e.message : "Auth sync failed" },
      401
    );
  }
});

app.get("/users/me", async (c) => {
  try {
    const privyUserId = await authMiddleware(c);
    const user = await getUser(privyUserId);
    const { getAkashAddress } = await import("./wallets/provision.js");
    const akashAddress = await getAkashAddress(privyUserId);
    return c.json({
      privyUserId,
      baseWalletAddress: user?.baseWalletAddress ?? null,
      akashAddress,
    });
  } catch (e) {
    return c.json(
      { error: e instanceof Error ? e.message : "Unauthorized" },
      401
    );
  }
});

app.post("/sessions", async (c) => {
  try {
    const privyUserId = await authMiddleware(c);
    const body = (await c.req.json()) as CreateSessionRequest;
    const session = await createSession(privyUserId, body);
    return c.json(session, 201);
  } catch (e) {
    return c.json(
      { error: e instanceof Error ? e.message : "Create session failed" },
      400
    );
  }
});

app.get("/sessions/:id", async (c) => {
  try {
    const privyUserId = await authMiddleware(c);
    const session = await getSession(c.req.param("id"), privyUserId);
    if (!session) return c.json({ error: "Not found" }, 404);
    return c.json(session);
  } catch (e) {
    return c.json(
      { error: e instanceof Error ? e.message : "Unauthorized" },
      401
    );
  }
});

app.post("/sessions/:id/quote", async (c) => {
  try {
    const privyUserId = await authMiddleware(c);
    const body = (await c.req.json()) as Omit<
      SquidQuoteRequest,
      "sessionId"
    >;
    const quote = await getSquidQuoteForSession(
      privyUserId,
      c.req.param("id"),
      body.fromAmount,
      body.fundingToken
    );
    return c.json(quote);
  } catch (e) {
    return c.json(
      { error: e instanceof Error ? e.message : "Quote failed" },
      400
    );
  }
});

app.post("/sessions/:id/route", async (c) => {
  try {
    const privyUserId = await authMiddleware(c);
    const body = (await c.req.json()) as {
      fromAmount: string;
      fundingToken: "ETH" | "USDC";
    };
    const route = await getSquidRouteForSession(
      privyUserId,
      c.req.param("id"),
      body.fromAmount,
      body.fundingToken
    );
    return c.json(route);
  } catch (e) {
    return c.json(
      { error: e instanceof Error ? e.message : "Route failed" },
      400
    );
  }
});

app.post("/sessions/:id/swap", async (c) => {
  try {
    const privyUserId = await authMiddleware(c);
    const body = (await c.req.json()) as Omit<
      SquidSwapSubmitRequest,
      "sessionId"
    >;
    await submitSwapTx(
      privyUserId,
      c.req.param("id"),
      body.baseTxHash,
      body.quoteId
    );
    const session = await getSession(c.req.param("id"), privyUserId);
    return c.json(session);
  } catch (e) {
    return c.json(
      { error: e instanceof Error ? e.message : "Swap submit failed" },
      400
    );
  }
});

app.post("/sessions/:id/deploy", async (c) => {
  try {
    const privyUserId = await authMiddleware(c);
    await startDeploy(privyUserId, c.req.param("id"));
    const session = await getSession(c.req.param("id"), privyUserId);
    return c.json(session);
  } catch (e) {
    return c.json(
      { error: e instanceof Error ? e.message : "Deploy failed" },
      400
    );
  }
});

app.delete("/sessions/:id", async (c) => {
  try {
    const privyUserId = await authMiddleware(c);
    const session = await teardownSession(privyUserId, c.req.param("id"));
    return c.json(session);
  } catch (e) {
    return c.json(
      { error: e instanceof Error ? e.message : "Teardown failed" },
      400
    );
  }
});

const port = Number(process.env.PORT ?? 4000);

await initDb();

registerShutdownHandler(getShutdownCredentials);

serve({ fetch: app.fetch, port }, () => {
  console.log(`[worker] listening on :${port}`);
});
