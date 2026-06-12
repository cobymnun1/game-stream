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

// Akash migrated to USD-denominated deployments: pricing + deposit use `uact`
// (Akash Credit Token), where 1 act = 1 USD, so 1 uact = 10^-6 USD.
// No token-price conversion needed — amounts are derived straight from USD.
const UACT_PER_USD = 1_000_000;

// USD/hour → uact/block
export function computeMaxUactPerBlock(maxUsdPerHour: number): number {
  const uactPerHour = maxUsdPerHour * UACT_PER_USD;
  return Math.max(1, Math.floor(uactPerHour / BLOCKS_PER_HOUR));
}

export function computeSessionPricing(
  budgetUsd: number,
  durationHours: number,
  // kept for signature compatibility; not needed for uact (USD-pegged)
  _aktUsdPrice?: number
) {
  const maxUsdPerHour = budgetUsd / durationHours;
  const ipLeaseUsdPerHour = Number(
    process.env.AKASH_IP_LEASE_USD_PER_HOUR ?? DEFAULT_IP_LEASE_USD_PER_HOUR
  );

  // Field names keep the *PerBlock / deposit shape the rest of the app expects,
  // but the values are now uact (USD-pegged), and the SDL/deposit denom is uact.
  const maxUaktPerBlock = computeMaxUactPerBlock(maxUsdPerHour);
  const ipLeaseUaktPerBlock = computeMaxUactPerBlock(ipLeaseUsdPerHour);

  const depositUact = Math.ceil(budgetUsd * DEFAULT_SAFETY_MARGIN * UACT_PER_USD);

  return {
    aktUsdPrice: 1, // uact is USD-pegged
    maxUsdPerHour,
    maxUaktPerBlock,
    ipLeaseUaktPerBlock,
    depositUakt: String(depositUact), // value is uact; denom set to uact at deploy time
    depositAkt: (depositUact / UACT_PER_USD).toFixed(2), // == USD amount
  };
}
