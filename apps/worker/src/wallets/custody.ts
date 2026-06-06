import {
  DecryptCommand,
  EncryptCommand,
  KMSClient,
} from "@aws-sdk/client-kms";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12;

export interface EncryptionContext {
  version: number;
  kmsKeyId: string | null;
  dekCipher: string;
  nonce: string;
  aad: string;
}

interface EncryptResult {
  encryptedMnemonic: string;
  context: EncryptionContext;
}

function getDevKey(): Buffer {
  const key = process.env.DEV_ENCRYPTION_KEY ?? "dev-32-byte-key-change-in-prod!!";
  return Buffer.from(key.padEnd(32, "0").slice(0, 32));
}

async function wrapDek(dek: Buffer, aad: string): Promise<{
  dekCipher: string;
  kmsKeyId: string | null;
}> {
  const kmsKeyId = process.env.AWS_KMS_KEY_ID;
  if (kmsKeyId && process.env.AWS_REGION) {
    const kms = new KMSClient({ region: process.env.AWS_REGION });
    const result = await kms.send(
      new EncryptCommand({
        KeyId: kmsKeyId,
        Plaintext: dek,
        EncryptionContext: { purpose: "akash-mnemonic", aad },
      })
    );
    if (!result.CiphertextBlob) {
      throw new Error("KMS encrypt returned empty ciphertext");
    }
    return {
      dekCipher: Buffer.from(result.CiphertextBlob).toString("base64"),
      kmsKeyId,
    };
  }

  const devKey = getDevKey();
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, devKey, iv);
  cipher.setAAD(Buffer.from(aad));
  const encrypted = Buffer.concat([cipher.update(dek), cipher.final()]);
  const tag = cipher.getAuthTag();
  const combined = Buffer.concat([iv, tag, encrypted]);
  return { dekCipher: combined.toString("base64"), kmsKeyId: null };
}

async function unwrapDek(
  dekCipher: string,
  kmsKeyId: string | null,
  aad: string
): Promise<Buffer> {
  if (kmsKeyId && process.env.AWS_REGION) {
    const kms = new KMSClient({ region: process.env.AWS_REGION });
    const result = await kms.send(
      new DecryptCommand({
        CiphertextBlob: Buffer.from(dekCipher, "base64"),
        EncryptionContext: { purpose: "akash-mnemonic", aad },
      })
    );
    if (!result.Plaintext) {
      throw new Error("KMS decrypt returned empty plaintext");
    }
    return Buffer.from(result.Plaintext);
  }

  const combined = Buffer.from(dekCipher, "base64");
  const iv = combined.subarray(0, IV_LENGTH);
  const tag = combined.subarray(IV_LENGTH, IV_LENGTH + 16);
  const encrypted = combined.subarray(IV_LENGTH + 16);
  const devKey = getDevKey();
  const decipher = createDecipheriv(ALGORITHM, devKey, iv);
  decipher.setAAD(Buffer.from(aad));
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(encrypted), decipher.final()]);
}

export async function encryptMnemonic(
  mnemonic: string,
  privyUserId: string
): Promise<EncryptResult> {
  const dek = randomBytes(32);
  const nonce = randomBytes(16).toString("base64");
  const aad = privyUserId;
  const { dekCipher, kmsKeyId } = await wrapDek(dek, aad);

  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, dek, iv);
  cipher.setAAD(Buffer.from(aad));
  const encrypted = Buffer.concat([
    cipher.update(mnemonic, "utf8"),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  const payload = Buffer.concat([iv, tag, encrypted]).toString("base64");

  dek.fill(0);

  return {
    encryptedMnemonic: payload,
    context: {
      version: 1,
      kmsKeyId,
      dekCipher,
      nonce,
      aad,
    },
  };
}

export async function decryptMnemonic(
  encryptedMnemonic: string,
  context: EncryptionContext
): Promise<string> {
  const dek = await unwrapDek(context.dekCipher, context.kmsKeyId, context.aad);
  const combined = Buffer.from(encryptedMnemonic, "base64");
  const iv = combined.subarray(0, IV_LENGTH);
  const tag = combined.subarray(IV_LENGTH, IV_LENGTH + 16);
  const encrypted = combined.subarray(IV_LENGTH + 16);

  const decipher = createDecipheriv(ALGORITHM, dek, iv);
  decipher.setAAD(Buffer.from(context.aad));
  decipher.setAuthTag(tag);
  const mnemonic = Buffer.concat([
    decipher.update(encrypted),
    decipher.final(),
  ]).toString("utf8");

  dek.fill(0);
  return mnemonic;
}
