import { drizzle } from "drizzle-orm/postgres-js";
import postgres, { type Options } from "postgres";
import * as schema from "./schema.js";

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  throw new Error("DATABASE_URL is required");
}

function getPostgresOptions(url: string): Options<Record<string, never>> {
  const isSupabase = /supabase\.(com|co)/.test(url);
  const isTransactionPooler = /:6543(\/|$)/.test(url);
  const options: Options<Record<string, never>> = {};

  if (isSupabase || process.env.DATABASE_SSL === "true") {
    options.ssl = "require";
  }

  // Supabase transaction pooler (port 6543) does not support prepared statements.
  if (isTransactionPooler) {
    options.prepare = false;
  }

  return options;
}

const client = postgres(connectionString, getPostgresOptions(connectionString));
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
