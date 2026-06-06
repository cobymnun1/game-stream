import type {
  AuthSyncRequest,
  CreateSessionRequest,
  Session,
  UserRecord,
} from "@game-stream/shared";

const WORKER_URL =
  process.env.NEXT_PUBLIC_WORKER_URL ?? "http://localhost:4000";

async function workerFetch<T>(
  path: string,
  token: string,
  init?: RequestInit
): Promise<T> {
  const res = await fetch(`${WORKER_URL}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
      ...init?.headers,
    },
  });

  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `Request failed: ${res.status}`);
  }

  return res.json() as Promise<T>;
}

export async function syncAuth(
  token: string,
  body: AuthSyncRequest
): Promise<UserRecord> {
  return workerFetch("/auth/sync", token, {
    method: "POST",
    body: JSON.stringify(body),
  });
}

export async function getMe(token: string) {
  return workerFetch<{
    privyUserId: string;
    baseWalletAddress: string | null;
    akashAddress: string | null;
  }>("/users/me", token);
}

export async function createSession(
  token: string,
  body: CreateSessionRequest
): Promise<Session> {
  return workerFetch("/sessions", token, {
    method: "POST",
    body: JSON.stringify(body),
  });
}

export async function getSession(
  token: string,
  sessionId: string
): Promise<Session> {
  return workerFetch(`/sessions/${sessionId}`, token);
}

export async function getQuote(
  token: string,
  sessionId: string,
  fromAmount: string,
  fundingToken: "ETH" | "USDC"
) {
  return workerFetch(`/sessions/${sessionId}/quote`, token, {
    method: "POST",
    body: JSON.stringify({ fromAmount, fundingToken }),
  });
}

export async function getRoute(
  token: string,
  sessionId: string,
  fromAmount: string,
  fundingToken: "ETH" | "USDC"
) {
  return workerFetch<{
    route: {
      quoteId: string;
      estimate: { fromAmount: string; toAmount: string };
      transactionRequest: {
        target: string;
        data: string;
        value: string;
        gasLimit: string;
      };
    };
  }>(`/sessions/${sessionId}/route`, token, {
    method: "POST",
    body: JSON.stringify({ fromAmount, fundingToken }),
  });
}

export async function submitSwap(
  token: string,
  sessionId: string,
  baseTxHash: string,
  quoteId: string
): Promise<Session> {
  return workerFetch(`/sessions/${sessionId}/swap`, token, {
    method: "POST",
    body: JSON.stringify({ baseTxHash, quoteId }),
  });
}

export async function teardownSession(
  token: string,
  sessionId: string
): Promise<Session> {
  return workerFetch(`/sessions/${sessionId}`, token, { method: "DELETE" });
}
