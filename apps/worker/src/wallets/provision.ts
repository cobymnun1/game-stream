import { EnglishMnemonic, Random } from "@cosmjs/crypto";
import { DirectSecp256k1HdWallet } from "@cosmjs/proto-signing";
import { eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { akashWallets } from "../db/schema.js";
import { decryptMnemonic, encryptMnemonic } from "./custody.js";
import type { EncryptionContext } from "./custody.js";

export async function generateAkashWallet(): Promise<{
  mnemonic: string;
  address: string;
}> {
  const mnemonic = new EnglishMnemonic(Random.getBytes(32)).toString();
  const wallet = await DirectSecp256k1HdWallet.fromMnemonic(mnemonic, {
    prefix: "akash",
  });
  const [{ address }] = await wallet.getAccounts();
  return { mnemonic, address };
}

export async function provisionAkashWallet(
  privyUserId: string
): Promise<string> {
  const existing = await db
    .select()
    .from(akashWallets)
    .where(eq(akashWallets.privyUserId, privyUserId))
    .limit(1);

  if (existing.length > 0) {
    return existing[0].akashAddress;
  }

  const { mnemonic, address } = await generateAkashWallet();
  const { encryptedMnemonic, context } = await encryptMnemonic(
    mnemonic,
    privyUserId
  );
  mnemonic.split("").fill("");

  await db.insert(akashWallets).values({
    privyUserId,
    akashAddress: address,
    encryptedMnemonic,
    encryptionContext: context,
  });

  return address;
}

export async function getAkashAddress(
  privyUserId: string
): Promise<string | null> {
  const rows = await db
    .select({ akashAddress: akashWallets.akashAddress })
    .from(akashWallets)
    .where(eq(akashWallets.privyUserId, privyUserId))
    .limit(1);
  return rows[0]?.akashAddress ?? null;
}

export async function getDecryptedMnemonic(
  privyUserId: string
): Promise<{ mnemonic: string; address: string }> {
  const rows = await db
    .select()
    .from(akashWallets)
    .where(eq(akashWallets.privyUserId, privyUserId))
    .limit(1);

  if (rows.length === 0) {
    throw new Error("Akash wallet not found for user");
  }

  const row = rows[0];
  const mnemonic = await decryptMnemonic(
    row.encryptedMnemonic,
    row.encryptionContext as EncryptionContext
  );
  return { mnemonic, address: row.akashAddress };
}
