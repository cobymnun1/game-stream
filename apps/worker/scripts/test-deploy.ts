/**
 * Standalone Akash deploy test — no UI, no DB, no Privy.
 *
 * Exercises the real production deploy path (runDeployJob) with hardcoded
 * test specs and the SDL template from /sdl/sunshine-stream.yaml.
 *
 * Usage:
 *   AKASH_MNEMONIC="word1 word2 ..." pnpm --filter @basehack/worker test:deploy
 *
 * Optional env:
 *   TEST_GPU=rtx4090           GPU model id (default rtx4090)
 *   TEST_CPU=8                 vCPU units    (default 8)
 *   TEST_MEM=16                memory GB     (default 16)
 *   TEST_BUDGET_USD=2          session budget USD (default 2)
 *   TEST_DURATION_HRS=1        session hours (default 1)
 *   KEEP_ALIVE_MIN=30          minutes to keep lease open before teardown (default 30)
 *   AKASH_RPC, AKASH_GRPC, SUNSHINE_IMAGE  (from .env)
 */
import "../src/env.js";
import { DirectSecp256k1HdWallet } from "@cosmjs/proto-signing";
import { GPU_CATALOG, type GpuId } from "@basehack/shared";
import { fetchAktUsdPrice, computeSessionPricing } from "../src/swap/pricing.js";
import { runDeployJob } from "../src/deploy/deploy-job.js";
import { closeDeployment } from "../src/sessions/teardown.js";

const TAG = "[test-deploy]";
const log = (...a: unknown[]) => console.log(TAG, ...a);
const err = (...a: unknown[]) => console.error(TAG, ...a);

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) {
    err(`Missing required env var: ${name}`);
    process.exit(1);
  }
  return v;
}

// Query a denom balance via REST (no SDK needed, works from any machine)
async function fetchBalance(address: string, denom = "uakt"): Promise<bigint> {
  const endpoints = [
    "https://akash-api.polkachu.com",
    "https://api.akashnet.net",
  ];
  for (const base of endpoints) {
    try {
      const res = await fetch(
        `${base}/cosmos/bank/v1beta1/balances/${address}`,
        { signal: AbortSignal.timeout(10_000) }
      );
      if (!res.ok) continue;
      const data = (await res.json()) as {
        balances: { denom: string; amount: string }[];
      };
      const found = data.balances.find((b) => b.denom === denom);
      return BigInt(found?.amount ?? "0");
    } catch {
      /* try next endpoint */
    }
  }
  return 0n;
}

async function main() {
  const mnemonic = requireEnv("AKASH_MNEMONIC");
  requireEnv("AKASH_RPC");
  requireEnv("AKASH_GRPC");

  const gpuId = (process.env.TEST_GPU ?? "rtx4090") as GpuId;
  if (!GPU_CATALOG[gpuId]) {
    err(`Unknown TEST_GPU "${gpuId}". Options: ${Object.keys(GPU_CATALOG).join(", ")}`);
    process.exit(1);
  }
  const cpuUnits = Number(process.env.TEST_CPU ?? 8);
  const memoryGb = Number(process.env.TEST_MEM ?? 16);
  const budgetUsd = Number(process.env.TEST_BUDGET_USD ?? 2);
  const durationHours = Number(process.env.TEST_DURATION_HRS ?? 1);
  const keepAliveMin = Number(process.env.KEEP_ALIVE_MIN ?? 30);

  // ── Wallet ──────────────────────────────────────────────────────────────
  const wallet = await DirectSecp256k1HdWallet.fromMnemonic(mnemonic, {
    prefix: "akash",
  });
  const [{ address: ownerAddress }] = await wallet.getAccounts();
  log("Wallet address:", ownerAddress);

  // ── Pricing ─────────────────────────────────────────────────────────────
  const aktUsdPrice = await fetchAktUsdPrice();
  const pricing = computeSessionPricing(budgetUsd, durationHours, aktUsdPrice);
  log(
    `Pricing: $${budgetUsd} / ${durationHours}h @ $${aktUsdPrice}/AKT → ` +
      `deposit ${pricing.depositAkt} AKT (${pricing.depositUakt} uakt), ` +
      `max ${pricing.maxUaktPerBlock} uakt/block`
  );

  // ── Balance (informational) ───────────────────────────────────────────────
  // The deposit is in uact (Akash Credits). runDeployJob auto-mints ACT from AKT
  // if needed and checks uakt for gas — so no hard gate here.
  const aktBalance = await fetchBalance(ownerAddress, "uakt");
  const actBalance = await fetchBalance(ownerAddress, "uact");
  log(`Balance: ${Number(aktBalance) / 1e6} AKT (gas) | ${Number(actBalance) / 1e6} ACT (deposit credits)`);
  log(`Deposit needed: ${Number(pricing.depositUakt) / 1e6} ACT — runDeployJob will mint from AKT if short.`);

  log("Specs:", { gpuId, cpuUnits, memoryGb });
  log("Image:", process.env.SUNSHINE_IMAGE ?? "(default)");
  log("Starting deploy…\n");

  // ── Deploy (real production path) ─────────────────────────────────────────
  let activeDseq: number | null = null;

  const cleanup = async () => {
    if (activeDseq !== null) {
      log(`Closing deployment dseq=${activeDseq}…`);
      await closeDeployment({ mnemonic, ownerAddress, dseq: activeDseq });
      activeDseq = null;
      log("Deployment closed.");
    }
  };

  for (const sig of ["SIGINT", "SIGTERM"]) {
    process.on(sig, async () => {
      log(`\nReceived ${sig}`);
      await cleanup();
      process.exit(0);
    });
  }

  try {
    // Auto-retry on "no bids" — IP+GPU providers are intermittent
    const maxRetries = Number(process.env.MAX_RETRIES ?? 8);
    let result;
    for (let attempt = 1; ; attempt++) {
      try {
        result = await runDeployJob({
          mnemonic,
          ownerAddress,
          specs: { gpuId, cpuUnits, memoryGb, durationHours, budgetUsd, fundingToken: "USDC" },
          pricing,
          callbacks: {
            onStatus: (status, extra) => {
              if (extra?.dseq) activeDseq = Number(extra.dseq);
              log(`status → ${status}${extra ? " " + JSON.stringify(extra) : ""}`);
            },
          },
        });
        break; // success
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (msg.includes("No bids") && attempt < maxRetries) {
          log(`No bids (attempt ${attempt}/${maxRetries}) — retrying in 10s…`);
          activeDseq = null;
          await new Promise((r) => setTimeout(r, 10_000));
          continue;
        }
        throw e;
      }
    }

    activeDseq = result.dseq;

    console.log("\n" + "=".repeat(60));
    log("✅ DEPLOYMENT LIVE");
    console.log("=".repeat(60));
    log("dseq:    ", result.dseq);
    log("provider:", result.provider);
    log("lease:   ", result.leaseId);
    log("hostname:", result.connection.hostname || "(pending)");
    log("ports:");
    for (const p of result.connection.forwardedPorts) {
      log(`   ${p.proto.toUpperCase()} ${p.port} → ${p.externalPort}${p.host ? ` @ ${p.host}` : ""}`);
    }
    if (result.connection.sunshineCredentials) {
      log("sunshine:", result.connection.sunshineCredentials);
    } else {
      log("sunshine: (credentials not found in logs yet)");
    }
    console.log("=".repeat(60) + "\n");

    log(`Keeping lease alive for ${keepAliveMin} min. Ctrl-C to tear down early.`);
    await new Promise((r) => setTimeout(r, keepAliveMin * 60_000));

    await cleanup();
    log("Done.");
    process.exit(0);
  } catch (e) {
    err("Deploy failed:", e instanceof Error ? e.message : e);
    await cleanup();
    process.exit(1);
  }
}

main();
