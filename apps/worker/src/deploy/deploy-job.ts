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

  // Deployment hash = manifest version (required by MsgCreateDeployment)
  const hash = await generateManifestVersion(groups);

  const latestBlock =
    await sdk.cosmos.base.tendermint.v1beta1.getLatestBlock({});
  const dseq = latestBlock.block!.header!.height as unknown as number;

  // v1beta4 deposit shape: { amount: Coin, sources: [Source.balance=1] }
  // Cast bypasses optional-field strictness (reclamation); runtime shape is correct.
  await sdk.akash.deployment.v1beta4.createDeployment({
    id: { owner: ownerAddress, dseq },
    groups: groupSpecs,
    hash,
    deposit: {
      amount: { denom: "uakt", amount: pricing.depositUakt },
      sources: [1], // Source.balance — fund from owner's account balance
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any);

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

  const { bidId } = selectedBid;
  const provider = bidId.provider;

  await sdk.akash.market.v1beta5.createLease({ bidId: bidId as any });
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
