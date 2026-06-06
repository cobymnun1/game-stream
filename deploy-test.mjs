import { DirectSecp256k1HdWallet } from "@cosmjs/proto-signing";
import { Secp256k1HdWallet } from "@cosmjs/amino";
import {
  createChainNodeSDK,
  generateManifest,
  yaml,
  JwtTokenManager,
} from "@akashnetwork/chain-sdk";

const TAG = "[deploy-test]";
const log = (...args) => console.log(TAG, ...args);
const err = (...args) => console.error(TAG, ...args);

// Module-scope state for the SIGTERM/SIGINT handler.
let sdk = null;
let ownerAddress = null;
let activeDseq = null;
let closing = false;

function requireEnv(name) {
  const val = process.env[name];
  if (!val) {
    err(`Missing required env var: ${name}`);
    process.exit(1);
  }
  return val;
}

async function closeDeploy(owner, dseq) {
  try {
    await sdk.akash.deployment.v1beta4.closeDeployment({
      id: { owner, dseq },
    });
  } catch (_) {
    /* best-effort */
  }
  activeDseq = null;
}

async function shutdown(signal) {
  if (closing) return;
  closing = true;
  log(`Received ${signal}, cleaning up…`);
  if (sdk && ownerAddress && activeDseq) {
    try {
      await sdk.akash.deployment.v1beta4.closeDeployment({
        id: { owner: ownerAddress, dseq: activeDseq },
      });
      log("Deployment closed during shutdown.");
    } catch (e) {
      err("Shutdown close failed:", e.message);
    }
  }
  process.exit(1);
}

for (const sig of ["SIGTERM", "SIGINT"]) {
  process.on(sig, () => shutdown(sig));
}

async function makeJwt(mnemonic) {
  const w = await Secp256k1HdWallet.fromMnemonic(mnemonic, { prefix: "akash" });
  const [{ address }] = await w.getAccounts();
  const tm = new JwtTokenManager(w);
  const now = Math.floor(Date.now() / 1000);
  const token = await tm.generateToken({
    iss: address,
    exp: now + 3600,
    iat: now,
    nbf: now,
    version: "v1",
    leases: { access: "full" },
  });
  return token;
}

// Akash mainnet block time is ~6 s.
const BLOCKS_PER_HOUR = 600;
const DEFAULT_MAX_USD_PER_HOUR = 2.8;

async function fetchAktUsdPrice() {
  const override = process.env.AKASH_AKT_USD_PRICE;
  if (override) {
    const price = Number(override);
    if (!Number.isFinite(price) || price <= 0) {
      throw new Error("AKASH_AKT_USD_PRICE must be a positive number");
    }
    log("Using AKASH_AKT_USD_PRICE override:", price);
    return price;
  }

  const res = await fetch(
    "https://api.coingecko.com/api/v3/simple/price?ids=akash-network&vs_currencies=usd"
  );
  if (!res.ok) {
    throw new Error(`CoinGecko price fetch failed: ${res.status}`);
  }

  const data = await res.json();
  const price = data?.["akash-network"]?.usd;
  if (!Number.isFinite(price) || price <= 0) {
    throw new Error("CoinGecko returned invalid AKT price");
  }

  return price;
}

function computeMaxUaktPerBlock(maxUsdPerHour, aktUsdPrice) {
  const uaktPerHour = (maxUsdPerHour / aktUsdPrice) * 1_000_000;
  return Math.max(1, Math.floor(uaktPerHour / BLOCKS_PER_HOUR));
}

function buildSdl(maxUaktPerBlock) {
  return yaml`
---
version: "2.0"
services:
  descai-test-2:
    image: cobymnun/descai-agent_core:v5-fa-on
    expose:
      - port: 80
        as: 80
        to:
          - global: true
    env:
      - AGE_SECRET_KEY_ENV=
      - AGE_SECRET_KEY_ARWEAVE=
profiles:
  compute:
    descai-test-2:
      resources:
        cpu:
          units: 48
        memory:
          size: 128Gb
        storage:
          - size: 128Gi
        gpu:
          units: 1
          attributes:
            vendor:
              nvidia:
                - model: h100
                  ram: 80Gi
                  interface: sxm
  placement:
    dcloud:
      pricing:
        descai-test-2:
          denom: uakt
          amount: ${maxUaktPerBlock}
deployment:
  descai-test-2:
    dcloud:
      profile: descai-test-2
      count: 1
`;
}

export async function run() {
  const AKASH_MNEMONIC = requireEnv("AKASH_MNEMONIC");
  const AKASH_RPC = requireEnv("AKASH_RPC");
  const AKASH_GRPC = requireEnv("AKASH_GRPC");
  const AKASH_DEPOSIT = requireEnv("AKASH_DEPOSIT");

  const maxUsdPerHour = Number(process.env.AKASH_MAX_USD_PER_HOUR ?? DEFAULT_MAX_USD_PER_HOUR);
  if (!Number.isFinite(maxUsdPerHour) || maxUsdPerHour <= 0) {
    err("AKASH_MAX_USD_PER_HOUR must be a positive number");
    process.exit(1);
  }

  const aktUsdPrice = await fetchAktUsdPrice();
  const maxUaktPerBlock = computeMaxUaktPerBlock(maxUsdPerHour, aktUsdPrice);
  log(
    `Price ceiling: $${maxUsdPerHour}/hr @ $${aktUsdPrice}/AKT → ${maxUaktPerBlock} uakt/block`
  );

  const sdl = buildSdl(maxUaktPerBlock);

  // Wallet
  log("Initialising wallet…");
  const wallet = await DirectSecp256k1HdWallet.fromMnemonic(AKASH_MNEMONIC, {
    prefix: "akash",
  });
  const [{ address }] = await wallet.getAccounts();
  ownerAddress = address;
  log("Wallet:", address);

  // SDK
  sdk = createChainNodeSDK({
    query: { baseUrl: AKASH_GRPC },
    tx: { baseUrl: AKASH_RPC, signer: wallet, gasPrice: "0.025uakt" },
  });

  // Parse SDL
  const manifest = generateManifest(sdl, "mainnet");
  if (!manifest.ok) {
    err("SDL validation failed:", JSON.stringify(manifest.value));
    process.exit(1);
  }
  const { groups, groupSpecs } = manifest.value;

  // Block height → dseq
  const latestBlock =
    await sdk.cosmos.base.tendermint.v1beta1.getLatestBlock({});
  const dseq = latestBlock.block.header.height;
  activeDseq = dseq;
  log("dseq:", dseq);

  // Create deployment
  try {
    await sdk.akash.deployment.v1beta4.createDeployment({
      id: { owner: address, dseq },
      groups: groupSpecs,
      deposit: { denom: "uakt", amount: String(AKASH_DEPOSIT) },
      depositor: address,
    });
    log("Deployment created.");
  } catch (e) {
    err("createDeployment failed:", e.message);
    process.exit(1);
  }

  // Poll for bids (every 15 s, up to 3 min)
  log("Polling for bids…");
  let bids = [];
  for (let i = 0; i < 12; i++) {
    await new Promise((r) => setTimeout(r, 15_000));
    try {
      const res = await sdk.akash.market.v1beta5.getBids({
        filters: { owner: address, dseq, state: "open" },
      });
      bids = res.bids ?? [];
      log(`Poll ${i + 1}/12 — ${bids.length} bid(s)`);
      if (bids.length > 0) break;
    } catch (e) {
      err(`Poll ${i + 1} error:`, e.message);
    }
  }

  if (bids.length === 0) {
    err("No bids received within 3 minutes.");
    await closeDeploy(address, dseq);
    process.exit(1);
  }

  // Select cheapest bid under price ceiling
  const affordable = bids
    .filter((b) => Number(b.bid.price.amount) <= maxUaktPerBlock)
    .sort((a, b) => Number(a.bid.price.amount) - Number(b.bid.price.amount));

  if (affordable.length === 0) {
    err(`All bids exceed ${maxUaktPerBlock} uakt/block ($${maxUsdPerHour}/hr) ceiling.`);
    await closeDeploy(address, dseq);
    process.exit(1);
  }

  const selectedBid = affordable[0].bid;
  const { bidId } = selectedBid;
  const provider = bidId.provider;
  log(`Bid selected — provider: ${provider}, price: ${selectedBid.price.amount} ${selectedBid.price.denom}/block`);

  // Create lease
  try {
    await sdk.akash.market.v1beta5.createLease({ bidId });
    log("Lease created.");
  } catch (e) {
    err("createLease failed:", e.message);
    process.exit(1);
  }

  // Resolve provider host URL
  let providerHostUri;
  try {
    const info = await sdk.akash.provider.v1beta4.getProvider({ owner: provider });
    providerHostUri = info.provider.hostUri;
    log("Provider URI:", providerHostUri);
  } catch (e) {
    err("Provider query failed:", e.message);
    process.exit(1);
  }

  // Send manifest via JWT-authenticated PUT
  try {
    const token = await makeJwt(AKASH_MNEMONIC);
    const url = `${providerHostUri}/deployment/${dseq}/manifest`;
    log("PUT", url);
    const res = await fetch(url, {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(groups),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "(unreadable)");
      err(`Manifest PUT failed — ${res.status}: ${body}`);
      process.exit(1);
    }
    log("Manifest sent.");
  } catch (e) {
    err("Failed to send manifest:", e.message);
    process.exit(1);
  }

  // Query lease status (non-fatal)
  try {
    const token = await makeJwt(AKASH_MNEMONIC);
    const url = `${providerHostUri}/lease/${dseq}/${bidId.gseq}/${bidId.oseq}/status`;
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (res.ok) {
      const data = await res.json();
      log("Lease status:", JSON.stringify(data, null, 2));
    } else {
      log("Lease status returned", res.status, "(non-fatal)");
    }
  } catch (e) {
    log("Lease status unavailable (non-fatal):", e.message);
  }

  // Summary
  const leaseId = `${bidId.owner}/${dseq}/${bidId.gseq}/${bidId.oseq}`;
  log("=== Deployment live ===");
  log("  dseq:", dseq);
  log("  provider:", provider);
  log("  lease:", leaseId);
  log("  Keeping alive for 30 minutes…");

  // Wait 30 minutes
  await new Promise((r) => setTimeout(r, 30 * 60 * 1000));

  // Close deployment
  log("30 minutes elapsed. Closing deployment…");
  try {
    await sdk.akash.deployment.v1beta4.closeDeployment({
      id: { owner: address, dseq },
    });
    activeDseq = null;
    log("Deployment closed.");
  } catch (e) {
    err("closeDeployment failed:", e.message);
    process.exit(1);
  }

  log("Done.");
}

// Standalone: `node jobs/deploy-test.mjs`
const isMain =
  process.argv[1] &&
  new URL(process.argv[1], "file://").href === import.meta.url;

if (isMain) {
  run()
    .then(() => process.exit(0))
    .catch((e) => {
      err("Unrecoverable error:", e);
      process.exit(1);
    });
}
