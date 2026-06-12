import { Secp256k1HdWallet } from "@cosmjs/amino";
import { JwtTokenManager, manifestToSortedJSON } from "@akashnetwork/chain-sdk";

// Akash providers serve their REST API over self-signed TLS certs by design.
// Node's fetch rejects these ("fetch failed"), so disable cert verification for
// provider communication — this is the standard Akash provider-comms approach.
process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";

export async function makeJwt(mnemonic: string): Promise<string> {
  const w = await Secp256k1HdWallet.fromMnemonic(mnemonic, {
    prefix: "akash",
  });
  const [{ address }] = await w.getAccounts();
  const tm = new JwtTokenManager(w);
  const now = Math.floor(Date.now() / 1000);
  return tm.generateToken({
    iss: address,
    exp: now + 3600,
    iat: now,
    nbf: now,
    version: "v1",
    leases: { access: "full" },
  });
}

export async function sendManifest(params: {
  mnemonic: string;
  providerHostUri: string;
  dseq: number;
  groups: unknown;
}): Promise<void> {
  const token = await makeJwt(params.mnemonic);
  const url = `${params.providerHostUri}/deployment/${params.dseq}/manifest`;
  // Provider expects the manifest as deterministically-sorted JSON
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const body = manifestToSortedJSON(params.groups as any);
  const res = await fetch(url, {
    method: "PUT",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body,
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "(unreadable)");
    throw new Error(`Manifest PUT failed — ${res.status}: ${body}`);
  }
}
