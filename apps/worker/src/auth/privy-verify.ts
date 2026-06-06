import { PrivyClient } from "@privy-io/server-auth";

let privyClient: PrivyClient | null = null;

function getPrivyClient(): PrivyClient {
  if (!privyClient) {
    const appId = process.env.PRIVY_APP_ID;
    const appSecret = process.env.PRIVY_APP_SECRET;
    if (!appId || !appSecret) {
      throw new Error("PRIVY_APP_ID and PRIVY_APP_SECRET are required");
    }
    privyClient = new PrivyClient(appId, appSecret);
  }
  return privyClient;
}

export async function verifyPrivyToken(
  authHeader: string | undefined
): Promise<string> {
  if (!authHeader?.startsWith("Bearer ")) {
    throw new Error("Missing or invalid Authorization header");
  }
  const token = authHeader.slice(7);
  const client = getPrivyClient();
  const claims = await client.verifyAuthToken(token);
  return claims.userId;
}

export function verifyWorkerSecret(secret: string | undefined): void {
  const expected = process.env.WORKER_SHARED_SECRET;
  if (!expected || secret !== expected) {
    throw new Error("Invalid worker shared secret");
  }
}
