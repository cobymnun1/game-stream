import { SessionManager } from './session/manager.ts'
import { loadPortMap, resolvePortMapUrl } from './net/port-map.ts'
import type { ConnectionState } from './types/protocol.ts'

// Pairing-api base URL. In dev both services run locally.
const PAIRING_API = 'http://localhost:4100'
const POLL_INTERVAL_MS = 1500

const canvas   = document.getElementById('stream-canvas') as HTMLCanvasElement
const statusEl = document.getElementById('status') as HTMLDivElement
const errorEl  = document.getElementById('error') as HTMLDivElement
const spinner  = document.getElementById('spinner') as HTMLDivElement
const panel    = document.getElementById('status-panel') as HTMLDivElement

function setStatus(msg: string): void { statusEl.textContent = msg }
function setError(msg: string): void {
  errorEl.textContent = msg
  spinner.style.display = 'none'
}

// ── Read ?id= from the URL ────────────────────────────────────────────────────
const params = new URLSearchParams(location.search)
const pairIdParam = params.get('id')
if (!pairIdParam) {
  setStatus('')
  setError('No ?id= in URL. Usage: /auto.html?id=<pair-job-id>')
  throw new Error('missing pair id')
}
// Narrowed to a non-null const so the closures below see `string`, not `string | null`.
const pairId: string = pairIdParam

// ── Pairing-api response shape ────────────────────────────────────────────────
interface PairJobResponse {
  id: string
  host: string
  status: 'pairing' | 'paired' | 'failed'
  error: string | null
  identity?: {
    uniqueId: string
    certPem: string
    privateKeyPem: string
  }
}

// ── Poll until status === "paired" ────────────────────────────────────────────
async function pollUntilPaired(): Promise<PairJobResponse> {
  for (;;) {
    const res = await fetch(`${PAIRING_API}/pair/${pairId}?includeIdentity=1`)
    if (!res.ok) throw new Error(`Pairing-api returned ${res.status}`)
    const job = await res.json() as PairJobResponse
    if (job.status === 'failed') throw new Error(`Pairing failed: ${job.error ?? 'unknown'}`)
    if (job.status === 'paired') return job
    setStatus(`Status: ${job.status} — waiting…`)
    await new Promise<void>(r => setTimeout(r, POLL_INTERVAL_MS))
  }
}

// ── Main flow ─────────────────────────────────────────────────────────────────
async function run(): Promise<void> {
  setStatus('Polling pairing-api for confirmation…')

  const job = await pollUntilPaired()
  if (!job.identity) {
    throw new Error('Pairing job has no identity — was it started via the pairing-api?')
  }

  const { uniqueId, certPem, privateKeyPem } = job.identity
  const host = job.host

  // Fetch the Akash port mapping (no-op/guarded if unreachable) before we open
  // any sockets, so all subsequent connections use the external ports.
  setStatus('Loading port map…')
  await loadPortMap(resolvePortMapUrl())

  setStatus(`Paired with ${host}. Starting stream…`)

  const session = new SessionManager({
    sessionId: pairId,
    workerUrl: '',
    authToken: '',
    connectionInfo: {
      host,
      ports: {
        http: 47989,
        https: 47984,
        webUi: 47990,
        control: 48010,
        video: 47998,
        audio: 47999,
      },
      leaseId: pairId,
      dseq: 0,
      provider: host,
    },
    canvas,
    prePairedIdentity: { uniqueId, certPem, privateKeyPem },
    onStateChange: (state: ConnectionState) => {
      if (state === 'streaming') {
        panel.style.display = 'none'
        canvas.style.display = 'block'
      }
      if (state === 'disconnected' || state === 'error') {
        panel.style.display = 'flex'
        canvas.style.display = 'none'
        setStatus('Disconnected.')
        spinner.style.display = 'none'
      }
    },
    onError: (err: Error) => setError(err.message),
  })

  await session.connect()
}

run().catch(err => {
  console.error('[auto]', err)
  setError(err instanceof Error ? err.message : String(err))
})
