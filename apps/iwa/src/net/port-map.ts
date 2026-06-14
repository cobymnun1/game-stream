// Akash maps Sunshine's internal ports to random external ports. The master
// server (0xbox-server) exposes the mapping as a flat JSON object at
// GET /mappings.json — { "<internalPort>": <externalPort>, ... }. We fetch it
// once and translate every outbound port (HTTP/HTTPS discovery, RTSP, and the
// UDP media streams) from internal -> external. The host is unchanged.

// Proxied through the pairing-api (which has CORS enabled) so the browser can
// read it cross-origin. The pairing-api forwards to the 0xbox-server at :3000.
const DEFAULT_PORTMAP_URL = 'http://localhost:4100/mappings.json'

let portMap: Map<number, number> | null = null
let loaded = false

// Populate the translation table from a flat { internalPort: externalPort } map.
export function setPortMap(raw: Record<string, number>): void {
  const next = new Map<number, number>()
  for (const [key, value] of Object.entries(raw)) {
    const from = parseInt(key, 10)
    const to = Number(value)
    if (Number.isInteger(from) && Number.isInteger(to)) next.set(from, to)
  }
  portMap = next
  loaded = true
}

// Translate an internal Sunshine port to its external (Akash) port. Returns the
// input unchanged when no mapping is loaded or the port isn't in the table, so
// non-Akash flows behave exactly as before.
export function mapPort(port: number): number {
  return portMap?.get(port) ?? port
}

// Fetch and cache the mapping from the master server. Idempotent — a second call
// is a no-op once a map has been loaded. Failures are swallowed (warning only)
// so a missing/unreachable map never aborts the connection flow.
export async function loadPortMap(url: string): Promise<void> {
  if (loaded) return
  try {
    const res = await fetch(url)
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const raw = await res.json() as Record<string, number>
    setPortMap(raw)
    console.info(`[port-map] loaded ${portMap?.size ?? 0} mappings from ${url}`)
  } catch (err) {
    console.warn(`[port-map] failed to load from ${url}; ports will pass through unmapped:`, err)
  }
}

// Resolve the mappings URL: explicit ?portmap= override, then the build-time
// VITE_PORTMAP_URL env var, then the default 0xbox-server endpoint.
export function resolvePortMapUrl(): string {
  const fromQuery = new URLSearchParams(location.search).get('portmap')
  if (fromQuery) return fromQuery
  const fromEnv = import.meta.env.VITE_PORTMAP_URL
  if (fromEnv) return fromEnv
  return DEFAULT_PORTMAP_URL
}
