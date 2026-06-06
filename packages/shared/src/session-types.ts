import type { GpuId } from "./gpu-catalog";
import type { FundingToken } from "./squid-chains";

export type SessionStatus =
  | "authenticated"
  | "akash_provisioning"
  | "spec_select"
  | "deposit_quote"
  | "swap_in_progress"
  | "swap_complete"
  | "deploying"
  | "bid_wait"
  | "lease_created"
  | "manifest_sent"
  | "lease_ready"
  | "ready"
  | "tearing_down"
  | "closed"
  | "failed";

export type SwapStatus =
  | "idle"
  | "quoting"
  | "awaiting_signature"
  | "tx_submitted"
  | "bridging"
  | "arrived"
  | "failed"
  | "refund";

export interface SessionSpecs {
  gpuId: GpuId;
  cpuUnits: number;
  memoryGb: number;
  durationHours: number;
  budgetUsd: number;
  fundingToken: FundingToken;
}

export interface ForwardedPort {
  port: number;
  proto: "tcp" | "udp";
  externalPort: number;
  host?: string;
}

export interface SunshineCredentials {
  username: string;
  password: string;
}

export interface SessionConnection {
  hostname: string;
  forwardedPorts: ForwardedPort[];
  sunshineCredentials: SunshineCredentials | null;
  leaseId: string | null;
  dseq: number | null;
  provider: string | null;
}

export interface SessionPricing {
  aktUsdPrice: number;
  maxUsdPerHour: number;
  maxUaktPerBlock: number;
  ipLeaseUaktPerBlock: number;
  depositUakt: string;
  depositAkt: string;
}

export interface SwapInfo {
  status: SwapStatus;
  quoteId: string | null;
  baseTxHash: string | null;
  fromAmount: string | null;
  toAmount: string | null;
  error: string | null;
}

export interface Session {
  id: string;
  privyUserId: string;
  status: SessionStatus;
  specs: SessionSpecs | null;
  pricing: SessionPricing | null;
  swap: SwapInfo;
  connection: SessionConnection | null;
  error: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface UserRecord {
  privyUserId: string;
  baseWalletAddress: string | null;
  akashAddress: string | null;
  createdAt: string;
}

export interface CreateSessionRequest {
  specs: SessionSpecs;
}

export interface AuthSyncRequest {
  baseWalletAddress: string;
}

export interface SquidQuoteRequest {
  sessionId: string;
  fromAmount: string;
  fundingToken: FundingToken;
}

export interface SquidSwapSubmitRequest {
  sessionId: string;
  baseTxHash: string;
  quoteId: string;
}
