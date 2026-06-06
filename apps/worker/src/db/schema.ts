import {
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";

export const users = pgTable("users", {
  privyUserId: text("privy_user_id").primaryKey(),
  baseWalletAddress: text("base_wallet_address"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
});

export const akashWallets = pgTable("akash_wallets", {
  privyUserId: text("privy_user_id")
    .primaryKey()
    .references(() => users.privyUserId),
  akashAddress: text("akash_address").notNull().unique(),
  encryptedMnemonic: text("encrypted_mnemonic").notNull(),
  encryptionContext: jsonb("encryption_context").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
});

export const sessions = pgTable("sessions", {
  id: uuid("id").defaultRandom().primaryKey(),
  privyUserId: text("privy_user_id")
    .notNull()
    .references(() => users.privyUserId),
  status: text("status").notNull(),
  specs: jsonb("specs"),
  pricing: jsonb("pricing"),
  swap: jsonb("swap").notNull(),
  connection: jsonb("connection"),
  error: text("error"),
  activeDseq: text("active_dseq"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
});
