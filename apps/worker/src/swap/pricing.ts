import { BLOCKS_PER_HOUR } from "../deploy/constants.js";

const DEFAULT_SAFETY_MARGIN = 1.1;
const DEFAULT_IP_LEASE_USD_PER_HOUR = 0.5;

export async function fetchAktUsdPrice(): Promise<number> {
  const override = process.env.AKASH_AKT_USD_PRICE;
  if (override) {
    const price = Number(override);
    if (!Number.isFinite(price) || price <= 0) {
      throw new Error("AKASH_AKT_USD_PRICE must be a positive number");
    }
    return price;
  }

  const res = await fetch(
    "https://api.coingecko.com/api/v3/simple/price?ids=akash-network&vs_currencies=usd"
  );
  if (!res.ok) {
    throw new Error(`CoinGecko price fetch failed: ${res.status}`);
  }

  const data = (await res.json()) as Record<string, { usd?: number }>;
  const price = data?.["akash-network"]?.usd;
  if (!Number.isFinite(price) || !price || price <= 0) {
    throw new Error("CoinGecko returned invalid AKT price");
  }

  return price;
}

export function computeMaxUaktPerBlock(
  maxUsdPerHour: number,
  aktUsdPrice: number
): number {
  const uaktPerHour = (maxUsdPerHour / aktUsdPrice) * 1_000_000;
  return Math.max(1, Math.floor(uaktPerHour / BLOCKS_PER_HOUR));
}

export function computeSessionPricing(
  budgetUsd: number,
  durationHours: number,
  aktUsdPrice: number
) {
  const maxUsdPerHour = budgetUsd / durationHours;
  const ipLeaseUsdPerHour = Number(
    process.env.AKASH_IP_LEASE_USD_PER_HOUR ?? DEFAULT_IP_LEASE_USD_PER_HOUR
  );
  const maxUaktPerBlock = computeMaxUaktPerBlock(maxUsdPerHour, aktUsdPrice);
  const ipLeaseUaktPerBlock = computeMaxUaktPerBlock(
    ipLeaseUsdPerHour,
    aktUsdPrice
  );

  const depositUakt = Math.ceil(
    ((budgetUsd * DEFAULT_SAFETY_MARGIN) / aktUsdPrice) * 1_000_000
  );

  return {
    aktUsdPrice,
    maxUsdPerHour,
    maxUaktPerBlock,
    ipLeaseUaktPerBlock,
    depositUakt: String(depositUakt),
    depositAkt: (depositUakt / 1_000_000).toFixed(4),
  };
}
