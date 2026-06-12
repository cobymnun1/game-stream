import {
  SUNSHINE_READY_REGEX,
  type ForwardedPort,
  type SunshineCredentials,
} from "@basehack/shared";
import { makeJwt } from "./manifest.js";
import {
  LEASE_POLL_INTERVAL_MS,
  LEASE_POLL_MAX_ATTEMPTS,
} from "./constants.js";

interface LeaseStatusService {
  name: string;
  available: number;
  total: number;
  uris?: string[];
  observed_generation?: number;
  replicas?: number;
  updated_replicas?: number;
  ready_replicas?: number;
  available_replicas?: number;
}

interface ForwardedPortEntry {
  port: number;
  externalPort: number;
  proto?: string;
  host?: string;
}

// The Akash provider returns `services` and `forwarded_ports` as OBJECTS
// (maps keyed by service name), not arrays.
interface LeaseStatusResponse {
  services?: Record<string, LeaseStatusService>;
  forwarded_ports?: Record<string, ForwardedPortEntry[]>;
  ips?: { ip: string }[] | null;
  uris?: string[];
}

export interface LeaseReadyResult {
  hostname: string;
  forwardedPorts: ForwardedPort[];
  sunshineCredentials: SunshineCredentials | null;
}

function parseHostname(status: LeaseStatusResponse): string {
  // Prefer dedicated IP if present
  if (status.ips && status.ips.length && status.ips[0]?.ip) return status.ips[0].ip;
  if (status.uris?.length) {
    const uri = status.uris[0]!;
    try { return new URL(uri.startsWith("http") ? uri : `http://${uri}`).hostname; } catch { return uri; }
  }
  for (const svc of Object.values(status.services ?? {})) {
    if (svc.uris?.length) {
      const uri = svc.uris[0]!;
      try { return new URL(uri.startsWith("http") ? uri : `http://${uri}`).hostname; } catch { return uri; }
    }
  }
  // Fall back to the host on any forwarded port
  for (const entries of Object.values(status.forwarded_ports ?? {})) {
    for (const p of entries) if (p.host) return p.host;
  }
  return "";
}

function parseForwardedPorts(status: LeaseStatusResponse): ForwardedPort[] {
  const out: ForwardedPort[] = [];
  for (const entries of Object.values(status.forwarded_ports ?? {})) {
    for (const p of entries) {
      out.push({
        port: p.port,
        externalPort: p.externalPort,
        proto: (p.proto?.toLowerCase() === "udp" ? "udp" : "tcp") as "tcp" | "udp",
        host: p.host,
      });
    }
  }
  return out;
}

function isLeaseServicesReady(status: LeaseStatusResponse): boolean {
  const services = Object.values(status.services ?? {});
  if (services.length === 0) return false;
  return services.every(
    (s) =>
      (s.ready_replicas ?? s.available ?? 0) >= 1 ||
      (s.available_replicas ?? 0) >= 1
  );
}

async function fetchLeaseStatus(params: {
  mnemonic: string;
  providerHostUri: string;
  dseq: number;
  gseq: number;
  oseq: number;
}): Promise<LeaseStatusResponse | null> {
  const token = await makeJwt(params.mnemonic);
  const url = `${params.providerHostUri}/lease/${params.dseq}/${params.gseq}/${params.oseq}/status`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) return null;
  return res.json() as Promise<LeaseStatusResponse>;
}

async function fetchServiceLogs(params: {
  mnemonic: string;
  providerHostUri: string;
  dseq: number;
  gseq: number;
  oseq: number;
  serviceName: string;
}): Promise<string> {
  const token = await makeJwt(params.mnemonic);
  const url = `${params.providerHostUri}/lease/${params.dseq}/${params.gseq}/${params.oseq}/logs?service=${params.serviceName}&tail=200`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) return "";
  return res.text();
}

export function parseSunshineReady(logs: string): SunshineCredentials | null {
  for (const line of logs.split("\n")) {
    const match = line.match(SUNSHINE_READY_REGEX);
    if (match?.[1] && match?.[2]) {
      return { username: match[1], password: match[2] };
    }
  }
  return null;
}

export async function watchLeaseUntilReady(params: {
  mnemonic: string;
  providerHostUri: string;
  dseq: number;
  gseq: number;
  oseq: number;
  onPoll?: (attempt: number) => void;
}): Promise<LeaseReadyResult> {
  let lastStatus: LeaseStatusResponse | null = null;

  for (let i = 0; i < LEASE_POLL_MAX_ATTEMPTS; i++) {
    params.onPoll?.(i + 1);
    const status = await fetchLeaseStatus(params);
    if (status) {
      lastStatus = status;
      if (isLeaseServicesReady(status)) {
        const hostname = parseHostname(status);
        const forwardedPorts = parseForwardedPorts(status);
        const logs = await fetchServiceLogs({
          ...params,
          serviceName: "sunshine",
        });
        const sunshineCredentials = parseSunshineReady(logs);

        return {
          hostname,
          forwardedPorts,
          sunshineCredentials,
        };
      }
    }
    await new Promise((r) => setTimeout(r, LEASE_POLL_INTERVAL_MS));
  }

  if (lastStatus) {
    return {
      hostname: parseHostname(lastStatus),
      forwardedPorts: parseForwardedPorts(lastStatus),
      sunshineCredentials: null,
    };
  }

  throw new Error("Lease status polling timed out");
}
