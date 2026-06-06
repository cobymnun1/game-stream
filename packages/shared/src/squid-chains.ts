export const SQUID_BASE_URL = "https://v2.api.squidrouter.com/v2";

export const BASE_CHAIN_ID = "8453";
export const AKASH_CHAIN_ID = "akashnet-2";

export const BASE_ETH_TOKEN = "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";
export const BASE_USDC_TOKEN = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
export const AKT_TOKEN = "uakt";

export type FundingToken = "ETH" | "USDC";

export const FUNDING_TOKENS: Record<FundingToken, string> = {
  ETH: BASE_ETH_TOKEN,
  USDC: BASE_USDC_TOKEN,
};
