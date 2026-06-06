import {
  AKASH_CHAIN_ID,
  BASE_CHAIN_ID,
  FUNDING_TOKENS,
  SQUID_BASE_URL,
  type FundingToken,
} from "@game-stream/shared";

const SQUID_HEADERS = () => ({
  "Content-Type": "application/json",
  "x-integrator-id": process.env.SQUID_INTEGRATOR_ID ?? "game-stream-launch",
});

export interface SquidRouteResponse {
  route: {
    quoteId: string;
    estimate: {
      fromAmount: string;
      toAmount: string;
      toAmountMin: string;
      estimatedRouteDuration: number;
    };
    transactionRequest?: {
      target: string;
      data: string;
      value: string;
      gasLimit: string;
    };
  };
}

export async function getSquidQuote(params: {
  fromAddress: string;
  toAddress: string;
  fromAmount: string;
  fundingToken: FundingToken;
  quoteOnly?: boolean;
}): Promise<SquidRouteResponse> {
  const body = {
    fromChain: BASE_CHAIN_ID,
    toChain: AKASH_CHAIN_ID,
    fromToken: FUNDING_TOKENS[params.fundingToken],
    toToken: "uakt",
    fromAmount: params.fromAmount,
    fromAddress: params.fromAddress,
    toAddress: params.toAddress,
    slippage: 1,
    quoteOnly: params.quoteOnly ?? true,
  };

  const res = await fetch(`${SQUID_BASE_URL}/route`, {
    method: "POST",
    headers: SQUID_HEADERS(),
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Squid route failed: ${res.status} ${text}`);
  }

  return res.json() as Promise<SquidRouteResponse>;
}

export type SquidTransactionStatus =
  | "success"
  | "ongoing"
  | "needs_gas"
  | "partial_success"
  | "not_found"
  | "refund";

export interface SquidStatusResponse {
  squidTransactionStatus: SquidTransactionStatus;
  toChain?: {
    transactionUrl?: string;
  };
}

export async function getSquidStatus(params: {
  transactionId: string;
  quoteId: string;
}): Promise<SquidStatusResponse> {
  const url = new URL(`${SQUID_BASE_URL}/status`);
  url.searchParams.set("transactionId", params.transactionId);
  url.searchParams.set("fromChainId", BASE_CHAIN_ID);
  url.searchParams.set("toChainId", AKASH_CHAIN_ID);
  url.searchParams.set("quoteId", params.quoteId);

  const res = await fetch(url.toString(), { headers: SQUID_HEADERS() });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Squid status failed: ${res.status} ${text}`);
  }

  return res.json() as Promise<SquidStatusResponse>;
}

export async function pollSquidStatus(
  params: { transactionId: string; quoteId: string },
  onUpdate?: (status: SquidTransactionStatus) => void,
  maxAttempts = 120
): Promise<SquidStatusResponse> {
  for (let i = 0; i < maxAttempts; i++) {
    const result = await getSquidStatus(params);
    onUpdate?.(result.squidTransactionStatus);

    if (
      result.squidTransactionStatus === "success" ||
      result.squidTransactionStatus === "refund" ||
      result.squidTransactionStatus === "partial_success"
    ) {
      return result;
    }

    await new Promise((r) => setTimeout(r, 5000));
  }

  throw new Error("Squid status polling timed out");
}
