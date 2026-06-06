import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema.js";

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  throw new Error("DATABASE_URL is required");
}

const client = postgres(connectionString);
export const db = drizzle(client, { schema });

export async function initDb() {
  await client`
    CREATE TABLE IF NOT EXISTS users (
      privy_user_id TEXT PRIMARY KEY,
      base_wallet_address TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `;
  await client`
    CREATE TABLE IF NOT EXISTS akash_wallets (
      privy_user_id TEXT PRIMARY KEY REFERENCES users(privy_user_id),
      akash_address TEXT NOT NULL UNIQUE,
      encrypted_mnemonic TEXT NOT NULL,
      encryption_context JSONB NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `;
  await client`
    CREATE TABLE IF NOT EXISTS sessions (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      privy_user_id TEXT NOT NULL REFERENCES users(privy_user_id),
      status TEXT NOT NULL,
      specs JSONB,
      pricing JSONB,
      swap JSONB NOT NULL,
      connection JSONB,
      error TEXT,
      active_dseq TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `;
}
