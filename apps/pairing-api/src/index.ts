import { serve } from '@hono/node-server'
import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { PairingSession, type PairingIdentity } from './pairing.js'
import { fetchPortMap, type PortMap } from './port-map.js'

type JobStatus = 'pairing' | 'paired' | 'failed'

interface Job {
  id: string
  host: string
  status: JobStatus
  error: string | null
  identity: PairingIdentity | null
  createdAt: number
}

// In-memory job store. Single-instance only; multi-instance would need shared
// storage. Jobs are swept after a TTL so the map can't grow unbounded.
const jobs = new Map<string, Job>()
const JOB_TTL_MS = 60 * 60 * 1000

function sweepJobs(): void {
  const now = Date.now()
  for (const [id, job] of jobs) {
    if (now - job.createdAt > JOB_TTL_MS) jobs.delete(id)
  }
}

const app = new Hono()

// Allow the IWA auto-connect page (served from another local origin, e.g.
// localhost:3001) to call this API from the browser. Without CORS the browser
// blocks the cross-origin fetch and the page sees "Failed to fetch".
app.use('*', cors())

app.get('/health', c => c.json({ ok: true }))

// Proxy the 0xbox-server's port mappings so the browser can read them without
// CORS issues (this Hono app already sends Access-Control-Allow-Origin: *).
const UPSTREAM_PORTMAP_URL = process.env.PORTMAP_URL ?? 'http://localhost:3000/mappings.json'
app.get('/mappings.json', async c => {
  try {
    const res = await fetch(UPSTREAM_PORTMAP_URL)
    if (!res.ok) return c.json({ error: `upstream ${res.status}` }, 502)
    return c.json(await res.json())
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : 'upstream unreachable' }, 502)
  }
})

// Start pairing with a Sunshine host. Generates the PIN and returns it
// immediately; the handshake completes in the background once the caller
// submits the PIN to Sunshine out-of-band. Poll GET /pair/:id for completion.
app.post('/pair', async c => {
  sweepJobs()

  let body: { host?: string; port?: number; portMapUrl?: string }
  try {
    body = await c.req.json()
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400)
  }

  const host = (body.host ?? '').trim()
  if (!host) return c.json({ error: 'host is required' }, 400)
  const port = Number(body.port) || 47989

  // Opt-in Akash port translation: when a port-map URL is supplied (per request
  // or via PORTMAP_URL), fetch the internal->external map and pair against the
  // external ports. Omit it for direct/local hosts (ports pass through).
  const portMapUrl = (body.portMapUrl ?? process.env.PORTMAP_URL ?? '').trim()
  let portMap: PortMap | undefined
  if (portMapUrl) {
    try {
      portMap = await fetchPortMap(portMapUrl)
      console.log(`[pair] loaded ${portMap.size} port mappings from ${portMapUrl}`)
    } catch (e) {
      return c.json({ error: e instanceof Error ? e.message : 'Failed to load port map' }, 502)
    }
  }

  const session = new PairingSession(host, port, portMap)

  // Probe first so an unreachable / wrong-port host fails before we mint a PIN.
  try {
    await session.getServerInfo()
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : 'Sunshine unreachable' }, 502)
  }

  let pin: string
  try {
    pin = await session.prepare()
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : 'Failed to prepare pairing' }, 500)
  }

  const id = crypto.randomUUID()
  const job: Job = {
    id,
    host,
    status: 'pairing',
    error: null,
    identity: session.identity,
    createdAt: Date.now(),
  }
  jobs.set(id, job)

  session.onStep = step => console.log(`[pair ${id}] ${step}`)

  // complete() fires handshake step 1 synchronously, so by the time we return
  // the PIN below, a client is already waiting and Sunshine will accept the PIN.
  session.complete()
    .then(() => {
      job.status = 'paired'
      job.identity = session.identity
      console.log(`[pair ${id}] paired with ${host}`)
    })
    .catch((err: unknown) => {
      job.status = 'failed'
      job.error = err instanceof Error ? err.message : String(err)
      console.warn(`[pair ${id}] failed: ${job.error}`)
    })

  return c.json({ id, pin, status: job.status })
})

// Manually mark a pairing job as paired (skips the background handshake).
// Use this when pairing was performed through Sunshine's UI/API manually.
app.post('/pair/:id/confirm', c => {
  const job = jobs.get(c.req.param('id'))
  if (!job) return c.json({ error: 'Not found' }, 404)
  job.status = 'paired'
  console.log(`[pair ${job.id}] confirmed as paired manually`)
  return c.json({ id: job.id, host: job.host, status: job.status })
})

// Poll pairing status. Pass ?includeIdentity=1 to also receive the client
// cert/key/uniqueId for this pairing (needed later to stream against it).
app.get('/pair/:id', c => {
  const job = jobs.get(c.req.param('id'))
  if (!job) return c.json({ error: 'Not found' }, 404)

  const includeIdentity = c.req.query('includeIdentity') === '1'
  return c.json({
    id: job.id,
    host: job.host,
    status: job.status,
    error: job.error,
    ...(includeIdentity ? { identity: job.identity } : {}),
  })
})

const port = Number(process.env.PORT ?? 4100)
serve({ fetch: app.fetch, port }, () => {
  console.log(`[pairing-api] listening on :${port}`)
})
