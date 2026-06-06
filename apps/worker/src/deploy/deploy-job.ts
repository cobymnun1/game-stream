import { createChainNodeSDK } from "@akashnetwork/chain-sdk";
import { DirectSecp256k1HdWallet } from "@cosmjs/proto-signing";
import type {
  SessionPricing,
  SessionSpecs,
  SessionStatus,
} from "@game-stream/shared";
import { selectCheapestAffordableBid } from "./bid-select.js";
import {
  BID_POLL_INTERVAL_MS,
  BID_POLL_MAX_ATTEMPTS,
} from "./constants.js";
import { watchLeaseUntilReady } from "./lease-watch.js";
import { sendManifest } from "./manifest.js";
import { buildSdlVars, renderSdl, validateAndParseSdl } from "./render-sdl.js";

export interface DeployCallbacks {
  onStatus: (status: SessionStatus, extra?: Record<string, unknown>) => void;
}

export interface DeployResult {
  dseq: number;
  provider: string;
  leaseId: string;
  connection: {
    hostname: string;
    forwardedPorts: import("@game-stream/shared").ForwardedPort[];
    sunshineCredentials: import("@game-stream/shared").SunshineCredentials | null;
  };
}

async function getAktBalance(
  sdk: ReturnType<typeof createChainNodeSDK>,
  address: string
): Promise<bigint> {
  const res = await sdk.cosmos.bank.v1beta1.getBalance({
    address,
    denom: "uakt",
  });
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

  const sdk = createChainNodeSDK({
    query: { baseUrl: grpc },
    tx: { baseUrl: rpc, signer: wallet, gasPrice: "0.025uakt" },
  });

  const balance = await getAktBalance(sdk, ownerAddress);
  const required = BigInt(pricing.depositUakt);
  if (balance < required) {
    throw new Error(
      `Insufficient AKT balance: have ${balance} uakt, need ${required} uakt`
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

  const latestBlock =
    await sdk.cosmos.base.tendermint.v1beta1.getLatestBlock({});
  const dseq = latestBlock.block.header.height;

  await sdk.akash.deployment.v1beta4.createDeployment({
    id: { owner: ownerAddress, dseq },
    groups: groupSpecs,
    deposit: { denom: "uakt", amount: pricing.depositUakt },
    depositor: ownerAddress,
  });

  callbacks.onStatus("bid_wait", { dseq });

  let bids: Parameters<typeof selectCheapestAffordableBid>[0] = [];
  for (let i = 0; i < BID_POLL_MAX_ATTEMPTS; i++) {
    await new Promise((r) => setTimeout(r, BID_POLL_INTERVAL_MS));
    const res = await sdk.akash.market.v1beta5.getBids({
      filters: { owner: ownerAddress, dseq, state: "open" },
    });
    bids = (res.bids ?? []) as Parameters<
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

  const { bidId } = selectedBid;
  const provider = bidId.provider;

  await sdk.akash.market.v1beta5.createLease({ bidId });
  callbacks.onStatus("lease_created", { provider, dseq });

  const info = await sdk.akash.provider.v1beta4.getProvider({
    owner: provider,
  });
  const providerHostUri = info.provider.hostUri;
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
    gseq: bidId.gseq,
    oseq: bidId.oseq,
  });
  callbacks.onStatus("lease_ready");

  const leaseId = `${bidId.owner}/${dseq}/${bidId.gseq}/${bidId.oseq}`;

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
