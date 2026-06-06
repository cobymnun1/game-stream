import {
  BASE_CHAIN_ID,
  FUNDING_TOKENS,
  type FundingToken,
} from "@game-stream/shared";
import type { ConnectedWallet } from "@privy-io/react-auth";
import {
  createPublicClient,
  createWalletClient,
  custom,
  encodeFunctionData,
  http,
  type Hex,
} from "viem";
import { base } from "viem/chains";

const ERC20_ABI = [
  {
    name: "approve",
    type: "function",
    inputs: [
      { name: "spender", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ type: "bool" }],
  },
] as const;

export async function executeSquidRoute(params: {
  wallet: ConnectedWallet;
  route: {
    quoteId: string;
    estimate: { fromAmount: string };
    transactionRequest: {
      target: string;
      data: string;
      value: string;
      gasLimit: string;
    };
  };
  fundingToken: FundingToken;
}): Promise<string> {
  const provider = await params.wallet.getEthereumProvider();
  const address = params.wallet.address as Hex;

  const walletClient = createWalletClient({
    account: address,
    chain: base,
    transport: custom(provider),
  });

  const publicClient = createPublicClient({
    chain: base,
    transport: http(),
  });

  if (params.fundingToken === "USDC") {
    const approveData = encodeFunctionData({
      abi: ERC20_ABI,
      functionName: "approve",
      args: [
        params.route.transactionRequest.target as Hex,
        BigInt(params.route.estimate.fromAmount),
      ],
    });

    const approveHash = await walletClient.sendTransaction({
      to: FUNDING_TOKENS.USDC as Hex,
      data: approveData,
    });

    await publicClient.waitForTransactionReceipt({ hash: approveHash });
  }

  const txHash = await walletClient.sendTransaction({
    to: params.route.transactionRequest.target as Hex,
    data: params.route.transactionRequest.data as Hex,
    value: BigInt(params.route.transactionRequest.value),
    gas: BigInt(params.route.transactionRequest.gasLimit),
  });

  void BASE_CHAIN_ID;
  return txHash;
}
