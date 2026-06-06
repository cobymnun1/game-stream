import { config } from "dotenv";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
config({ path: resolve(root, ".env") });

type Result = { name: string; ok: boolean; detail: string };

const results: Result[] = [];

function pass(name: string, detail: string) {
  results.push({ name, ok: true, detail });
  console.log(`✓ ${name}: ${detail}`);
}

function fail(name: string, detail: string) {
  results.push({ name, ok: false, detail });
  console.error(`✗ ${name}: ${detail}`);
}

async function testWalletGen() {
  const { generateAkashWallet } = await import("../src/wallets/provision.js");
  const { encryptMnemonic, decryptMnemonic } = await import(
    "../src/wallets/custody.js"
  );

  const { mnemonic, address } = await generateAkashWallet();
  if (!address.startsWith("akash1")) {
    throw new Error(`Unexpected address prefix: ${address}`);
  }
  if (mnemonic.split(" ").length !== 24) {
    throw new Error(
      `Expected 24-word mnemonic, got ${mnemonic.split(" ").length}`
    );
  }

  const { encryptedMnemonic, context } = await encryptMnemonic(
    mnemonic,
    "service-test-user"
  );
  const decrypted = await decryptMnemonic(encryptedMnemonic, context);
  if (decrypted !== mnemonic) {
    throw new Error("Encrypt/decrypt round-trip failed");
  }

  pass(
    "Wallet generation",
    `address ${address.slice(0, 12)}…, 24-word mnemonic, encrypt/decrypt OK`
  );
}

async function testSquidQuote() {
  const integratorId =
    process.env.SQUID_INTEGRATOR_ID ?? "game-stream-launch";

  const body = {
    fromChain: "8453",
    toChain: "akashnet-2",
    fromToken: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    toToken: "uakt",
    fromAmount: "5000000",
    fromAddress: "0x0000000000000000000000000000000000000001",
    toAddress: "akash1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq",
    slippage: 1,
    quoteOnly: true,
  };

  const res = await fetch("https://v2.api.squidrouter.com/v2/route", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-integrator-id": integratorId,
    },
    body: JSON.stringify(body),
  });

  const text = await res.text();
  if (!res.ok) {
    throw new Error(`HTTP ${res.status}: ${text.slice(0, 300)}`);
  }

  const data = JSON.parse(text) as {
    route?: { quoteId?: string; estimate?: { toAmount?: string } };
  };
  if (!data.route?.quoteId || !data.route?.estimate?.toAmount) {
    throw new Error(`Unexpected response shape: ${text.slice(0, 300)}`);
  }

  const akt = (Number(data.route.estimate.toAmount) / 1_000_000).toFixed(4);
  pass(
    "Squid quote",
    `quoteId ${data.route.quoteId.slice(0, 8)}…, ~${akt} AKT for 5 USDC`
  );
}

async function testSdlRender() {
  const image =
    process.env.SUNSHINE_IMAGE ?? "cobymnun/game-stream-container:latest";
  const { buildSdlVars, renderSdl, validateAndParseSdl } = await import(
    "../src/deploy/render-sdl.js"
  );

  const vars = buildSdlVars({
    gpuId: "rtx4090",
    cpuUnits: 16,
    memoryGb: 32,
    maxUaktPerBlock: 100,
    ipLeaseUaktPerBlock: 10,
  });

  const yamlContent = await renderSdl(vars);
  if (!yamlContent.includes(image)) {
    throw new Error(`Rendered SDL missing image ${image}`);
  }

  const parsed = await validateAndParseSdl(yamlContent);
  if (!parsed.groups?.length) {
    throw new Error("SDL parsed but no deployment groups found");
  }

  pass(
    "SDL render + validate",
    `image ${image}, ${parsed.groups.length} group(s)`
  );
}

async function testAkashConnectivity() {
  const rpc = process.env.AKASH_RPC ?? "https://rpc.akash.network:443";
  const grpcCandidates = [
    process.env.AKASH_GRPC,
    "https://akash-grpc.lavenderfive.com:443",
    "https://akash-grpc.polkachu.com:443",
  ].filter((url): url is string => Boolean(url));

  const { createChainNodeSDK } = await import("@akashnetwork/chain-sdk");
  let lastError: unknown;

  for (const grpc of grpcCandidates) {
    try {
      const sdk = createChainNodeSDK({
        query: { baseUrl: grpc },
        tx: { baseUrl: rpc },
      });
      const latest =
        await sdk.cosmos.base.tendermint.v1beta1.getLatestBlock({});
      const height = latest.block?.header?.height;
      if (!height) {
        throw new Error("Could not read latest block height");
      }
      pass("Akash RPC/GRPC", `latest block height ${height} via ${grpc}`);
      return;
    } catch (e) {
      lastError = e;
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new Error("All Akash GRPC endpoints failed");
}

async function testAkashDeploy() {
  const mnemonic = process.env.AKASH_MNEMONIC;
  if (!mnemonic) {
    pass(
      "Akash deploy (live)",
      "skipped — set AKASH_MNEMONIC in .env to run funded deploy test"
    );
    return;
  }

  const { run } = await import("../../../deploy-test.mjs");
  await run();
  pass("Akash deploy (live)", "deploy-test.mjs completed");
}

async function main() {
  console.log("Running service tests (no Privy / wall clock required)…\n");

  const tests = [
    ["wallet", testWalletGen],
    ["squid", testSquidQuote],
    ["sdl", testSdlRender],
    ["akash-connectivity", testAkashConnectivity],
    ["akash-deploy", testAkashDeploy],
  ] as const;

  for (const [name, fn] of tests) {
    try {
      await fn();
    } catch (e) {
      fail(name, e instanceof Error ? e.message : String(e));
    }
  }

  console.log("\n--- Summary ---");
  const failed = results.filter((r) => !r.ok);
  for (const r of results) {
    console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name}`);
  }

  if (failed.length > 0) {
    process.exit(1);
  }
}

main();
