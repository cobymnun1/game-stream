// Node-side port map for the pairing handshake. Akash maps Sunshine's internal
// ports (47989 HTTP, 47984 HTTPS, ...) to random external ports. When a caller
// opts in by supplying a port-map URL, we fetch the flat
// { "<internalPort>": <externalPort> } JSON and translate every Sunshine port.
// Pairing is otherwise direct (internal ports), so local hosts are unaffected.

export type PortMap = Map<number, number>

export async function fetchPortMap(url: string): Promise<PortMap> {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`port map fetch ${url} returned HTTP ${res.status}`)
  const raw = await res.json() as Record<string, number>
  const map: PortMap = new Map()
  for (const [key, value] of Object.entries(raw)) {
    const from = parseInt(key, 10)
    const to = Number(value)
    if (Number.isInteger(from) && Number.isInteger(to)) map.set(from, to)
  }
  return map
}

// Translate an internal Sunshine port to its external port. Returns the input
// unchanged when no map is provided or the port isn't mapped (local pairing).
export function mapPort(map: PortMap | undefined, port: number): number {
  return map?.get(port) ?? port
}
