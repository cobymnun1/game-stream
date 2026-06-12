import { createChainNodeSDK, createStargateClient, generateManifestVersion } from "@akashnetwork/chain-sdk";
import { DirectSecp256k1HdWallet } from "@cosmjs/proto-signing";
import type {
  SessionPricing,
  SessionSpecs,
  SessionStatus,
} from "@basehack/shared";
import { selectCheapestAffordableBid } from "./bid-select.js";
import {
  BID_POLL_INTERVAL_MS,
  BID_POLL_MAX_ATTEMPTS,
} from "./constants.js";
import { watchLeaseUntilReady } from "./lease-watch.js";
import { sendManifest } from "./manifest.js";
import { buildSdlVars, renderSdl, validateAndParseSdl } from "./render-sdl.js";
import { fetchAktUsdPrice } from "../swap/pricing.js";

export interface DeployCallbacks {
  onStatus: (status: SessionStatus, extra?: Record<string, unknown>) => void;
}

export interface DeployResult {
  dseq: number;
  provider: string;
  leaseId: string;
  connection: {
    hostname: string;
    forwardedPorts: import("@basehack/shared").ForwardedPort[];
    sunshineCredentials: import("@basehack/shared").SunshineCredentials | null;
  };
}

async function getBalance(
  sdk: ReturnType<typeof createChainNodeSDK>,
  address: string,
  denom: string
): Promise<bigint> {
  const res = await sdk.cosmos.bank.v1beta1.getBalance({ address, denom });
  return BigInt(res.balance?.amount ?? "0");
}

export async function runDeployJob(params: {
  mnemonic: string;
  ownerAddress: string;
  specs: SessionSpecs;
  pricing: SessionPricing;
  callbacks: DeployCallbacks;
}): Promise<DeployResult> {
  const { mnemonic, ownerAddress, specs, pricing, callbacks } = params;

  const rpc = process.env.AKASH_RPC;
  const grpc = process.env.AKASH_GRPC;
  if (!rpc || !grpc) {
    throw new Error("AKASH_RPC and AKASH_GRPC are required");
  }

  const wallet = await DirectSecp256k1HdWallet.fromMnemonic(mnemonic, {
    prefix: "akash",
  });

  // tx.signer must be a TxClient (has signAndBroadcast) — built via createStargateClient.
  // query uses gRPC endpoint; tx signing uses the RPC endpoint.
  const txClient = createStargateClient({
    baseUrl: rpc,
    signer: wallet,
    defaultGasPrice: "0.025uakt",
  });

  const sdk = createChainNodeSDK({
    query: { baseUrl: grpc },
    tx: { signer: txClient },
  });

  // Deposit is in uact (USD-pegged Akash Credit). Gas is paid in uakt.
  // Akash mainnet requires uact for new deployments (AKT rejected). If the
  // wallet has no/low uact, mint it by burning a little AKT via x/bme MsgMintACT.
  const required = BigInt(pricing.depositUakt); // value is uact
  let uactBalance = await getBalance(sdk, ownerAddress, "uact");

  if (uactBalance < required) {
    callbacks.onStatus("deploying"); // surface "minting credits" stage as deploying
    const aktUsdPrice = await fetchAktUsdPrice();

    // x/bme enforces a minimum mint (min_mint, currently 10 ACT = $10).
    // Mint at least that much; deposit uses what it needs, rest stays as credit.
    const MIN_MINT_UACT = 10_000_000n; // 10 ACT = $10
    const targetUact = required > MIN_MINT_UACT ? required : MIN_MINT_UACT;
    const usdToMint = Number(targetUact) / 1_000_000;
    // AKT to burn = USD / price, +25% buffer for price drift + mint spread
    const aktToBurn = (usdToMint / aktUsdPrice) * 1.25;
    const uaktToBurn = BigInt(Math.ceil(aktToBurn * 1_000_000));

    console.log(
      `[deploy] minting ${usdToMint} ACT by burning ~${(Number(uaktToBurn) / 1e6).toFixed(3)} AKT`
    );

    // Explicit fee skips the SDK's gas-estimation simulation, which runs in a
    // stale query context and trips the oracle's tight max_price_staleness (4 blocks).
    await sdk.akash.bme.v1.mintACT(
      {
        owner: ownerAddress,
        to: ownerAddress, // minting ACT — destination must equal signer
        coinsToBurn: { denom: "uakt", amount: uaktToBurn.toString() },
      },
      { fee: { amount: [{ denom: "uakt", amount: "20000" }], gas: "400000" } }
    );

    // Poll for the minted credits to reflect (a few blocks)
    for (let i = 0; i < 15 && uactBalance < required; i++) {
      await new Promise((r) => setTimeout(r, 3000));
      uactBalance = await getBalance(sdk, ownerAddress, "uact");
    }
    if (uactBalance < required) {
      throw new Error(
        `ACT mint did not yield enough credits in time: have ${uactBalance} uact, need ${required} uact`
      );
    }
    console.log(`[deploy] ACT minted — balance now ${uactBalance} uact`);
  }

  const uaktBalance = await getBalance(sdk, ownerAddress, "uakt");
  if (uaktBalance < 200000n) {
    throw new Error(
      `Insufficient uakt for gas: have ${uaktBalance} uakt (need ~0.2 AKT for fees).`
    );
  }

  callbacks.onStatus("deploying");

  const sdlVars = buildSdlVars({
    gpuId: specs.gpuId,
    cpuUnits: specs.cpuUnits,
    memoryGb: specs.memoryGb,
    maxUaktPerBlock: pricing.maxUaktPerBlock,
    ipLeaseUaktPerBlock: pricing.ipLeaseUaktPerBlock,
  });

  const yamlContent = await renderSdl(sdlVars);
  const { groups, groupSpecs } = await validateAndParseSdl(yamlContent);

  // Deployment hash = manifest version (required by MsgCreateDeployment)
  const hash = await generateManifestVersion(groups);

  const latestBlock =
    await sdk.cosmos.base.tendermint.v1beta1.getLatestBlock({});
  const dseq = latestBlock.block!.header!.height as unknown as number;

  // v1beta4 deposit shape: { amount: Coin, sources: [Source.balance=1] }
  // Cast bypasses optional-field strictness (reclamation); runtime shape is correct.
  await sdk.akash.deployment.v1beta4.createDeployment(
    {
      id: { owner: ownerAddress, dseq },
      groups: groupSpecs,
      hash,
      deposit: {
        // Akash mainnet requires uact (USD-pegged credits) for new deployments;
        // uakt is rejected (only valid for topping up existing deployments).
        amount: { denom: "uact", amount: pricing.depositUakt },
        sources: [1], // Source.balance — fund from owner's account balance
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any,
    // explicit fee → skip gas-estimation simulation
    { fee: { amount: [{ denom: "uakt", amount: "25000" }], gas: "500000" } }
  );

  callbacks.onStatus("bid_wait", { dseq });

  let bids: Parameters<typeof selectCheapestAffordableBid>[0] = [];
  for (let i = 0; i < BID_POLL_MAX_ATTEMPTS; i++) {
    await new Promise((r) => setTimeout(r, BID_POLL_INTERVAL_MS));
    const res = await sdk.akash.market.v1beta5.getBids({
      filters: { owner: ownerAddress, dseq, state: "open" },
    });
    bids = (res.bids ?? []) as unknown as Parameters<
      typeof selectCheapestAffordableBid
    >[0];
    if (bids.length > 0) break;
  }

  if (bids.length === 0) {
    await sdk.akash.deployment.v1beta4.closeDeployment({
      id: { owner: ownerAddress, dseq },
    });
    throw new Error("No bids received within polling window");
  }

  const selectedBid = selectCheapestAffordableBid(
    bids,
    pricing.maxUaktPerBlock
  );
  if (!selectedBid) {
    await sdk.akash.deployment.v1beta4.closeDeployment({
      id: { owner: ownerAddress, dseq },
    });
    throw new Error("All bids exceed price ceiling");
  }

  // SDK Bid uses `id` (a BidID), not `bidId`
  const bidId = selectedBid.id;
  const provider = bidId.provider;

  // Bid exposes the id as `.id`, but MsgCreateLease's field is `bidId`
  await sdk.akash.market.v1beta5.createLease(
    { bidId } as any,
    { fee: { amount: [{ denom: "uakt", amount: "25000" }], gas: "500000" } }
  );
  callbacks.onStatus("lease_created", { provider, dseq });

  const info = await sdk.akash.provider.v1beta4.getProvider({
    owner: provider,
  });
  const providerHostUri = info.provider!.hostUri;
  if (!providerHostUri) {
    throw new Error("Provider host URI not found");
  }

  await sendManifest({
    mnemonic,
    providerHostUri,
    dseq,
    groups,
  });
  callbacks.onStatus("manifest_sent", { dseq, provider });

  const leaseResult = await watchLeaseUntilReady({
    mnemonic,
    providerHostUri,
    dseq,
    gseq: Number(bidId.gseq),
    oseq: Number(bidId.oseq),
  });
  callbacks.onStatus("lease_ready");

  const leaseId = `${bidId.owner}/${dseq}/${Number(bidId.gseq)}/${Number(bidId.oseq)}`;

  return {
    dseq,
    provider,
    leaseId,
    connection: {
      hostname: leaseResult.hostname,
      forwardedPorts: leaseResult.forwardedPorts,
      sunshineCredentials: leaseResult.sunshineCredentials,
    },
  };
}
