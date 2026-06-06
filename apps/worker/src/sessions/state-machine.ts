import type {
  Session,
  SessionConnection,
  SessionPricing,
  SessionSpecs,
  SessionStatus,
  SwapInfo,
  SwapStatus,
} from "@basehack/shared";

export const INITIAL_SWAP: SwapInfo = {
  status: "idle",
  quoteId: null,
  baseTxHash: null,
  fromAmount: null,
  toAmount: null,
  error: null,
};

export function mapSwapStatus(squidStatus: string): SwapStatus {
  switch (squidStatus) {
    case "success":
      return "arrived";
    case "ongoing":
      return "bridging";
    case "refund":
      return "refund";
    default:
      return "failed";
  }
}

export function sessionToResponse(row: {
  id: string;
  privyUserId: string;
  status: string;
  specs: unknown;
  pricing: unknown;
  swap: unknown;
  connection: unknown;
  error: string | null;
  createdAt: Date;
  updatedAt: Date;
}): Session {
  return {
    id: row.id,
    privyUserId: row.privyUserId,
    status: row.status as SessionStatus,
    specs: (row.specs as SessionSpecs | null) ?? null,
    pricing: (row.pricing as SessionPricing | null) ?? null,
    swap: (row.swap as SwapInfo) ?? INITIAL_SWAP,
    connection: (row.connection as SessionConnection | null) ?? null,
    error: row.error,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export function canTransition(from: SessionStatus, to: SessionStatus): boolean {
  const allowed: Record<SessionStatus, SessionStatus[]> = {
    authenticated: ["akash_provisioning", "failed"],
    akash_provisioning: ["spec_select", "failed"],
    spec_select: ["deposit_quote", "failed"],
    deposit_quote: ["swap_in_progress", "failed"],
    swap_in_progress: ["swap_complete", "failed"],
    swap_complete: ["deploying", "failed"],
    deploying: ["bid_wait", "failed"],
    bid_wait: ["lease_created", "failed"],
    lease_created: ["manifest_sent", "failed"],
    manifest_sent: ["lease_ready", "failed"],
    lease_ready: ["ready", "failed"],
    ready: ["tearing_down", "failed"],
    tearing_down: ["closed", "failed"],
    closed: [],
    failed: ["tearing_down", "closed"],
  };
  return allowed[from]?.includes(to) ?? false;
}
