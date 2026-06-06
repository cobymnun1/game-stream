import { createChainNodeSDK } from "@akashnetwork/chain-sdk";
import { DirectSecp256k1HdWallet } from "@cosmjs/proto-signing";

const activeDeployments = new Map<
  string,
  { ownerAddress: string; dseq: number }
>();

export function trackActiveDeployment(
  sessionId: string,
  ownerAddress: string,
  dseq: number
) {
  activeDeployments.set(sessionId, { ownerAddress, dseq });
}

export function untrackActiveDeployment(sessionId: string) {
  activeDeployments.delete(sessionId);
}

export async function closeDeployment(params: {
  mnemonic: string;
  ownerAddress: string;
  dseq: number;
}): Promise<void> {
  const rpc = process.env.AKASH_RPC;
  const grpc = process.env.AKASH_GRPC;
  if (!rpc || !grpc) {
    throw new Error("AKASH_RPC and AKASH_GRPC are required");
  }

  const wallet = await DirectSecp256k1HdWallet.fromMnemonic(params.mnemonic, {
    prefix: "akash",
  });

  const sdk = createChainNodeSDK({
    query: { baseUrl: grpc },
    tx: { baseUrl: rpc, signer: wallet, gasPrice: "0.025uakt" },
  });

  try {
    await sdk.akash.deployment.v1beta4.closeDeployment({
      id: { owner: params.ownerAddress, dseq: params.dseq },
    });
  } catch {
    /* best-effort */
  }
}

let shuttingDown = false;

export function registerShutdownHandler(
  getMnemonicForSession: (
    sessionId: string
  ) => Promise<{ mnemonic: string; ownerAddress: string; dseq: number } | null>
) {
  async function shutdown(signal: string) {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[worker] Received ${signal}, cleaning up active deployments…`);

    for (const [sessionId, { ownerAddress, dseq }] of activeDeployments) {
      try {
        const creds = await getMnemonicForSession(sessionId);
        if (creds) {
          await closeDeployment({
            mnemonic: creds.mnemonic,
            ownerAddress,
            dseq,
          });
          creds.mnemonic.split("").fill("");
          console.log(`[worker] Closed deployment for session ${sessionId}`);
        }
      } catch (e) {
        console.error(
          `[worker] Shutdown close failed for ${sessionId}:`,
          e instanceof Error ? e.message : e
        );
      }
    }

    process.exit(0);
  }

  for (const sig of ["SIGTERM", "SIGINT"]) {
    process.on(sig, () => shutdown(sig));
  }
}
