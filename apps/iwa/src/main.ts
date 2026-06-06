import { SessionManager } from './session/manager.ts'
import type { ConnectionState } from './types/protocol.ts'
import type { ConnectionInfo } from './types/connection.ts'

const canvas = document.getElementById('stream-canvas') as HTMLCanvasElement
const form   = document.getElementById('connect-form') as HTMLFormElement
const hostInput = document.getElementById('host-input') as HTMLInputElement
const portInput = document.getElementById('port-input') as HTMLInputElement
const connectBtn = document.getElementById('connect-btn') as HTMLButtonElement
const statusEl   = document.getElementById('status') as HTMLDivElement

// URL params — used by Next.js client to pre-fill + auto-connect
const params = new URLSearchParams(location.search)
const paramHost = params.get('host')
const paramPort = params.get('port')
if (paramHost) hostInput.value = paramHost
if (paramPort) portInput.value = paramPort

let session: SessionManager | null = null

const WORKER_URL = 'http://localhost:4000' // injected by build in production

function setStatus(text: string): void { statusEl.textContent = text }

function onStateChange(state: ConnectionState): void {
  const labels: Record<ConnectionState, string> = {
    idle: '', pairing: 'Pairing with Sunshine…', launching: 'Launching game…',
    connecting: 'Connecting stream…', streaming: '', disconnected: 'Disconnected', error: '',
  }
  setStatus(labels[state])
  connectBtn.disabled = !['idle', 'disconnected', 'error'].includes(state)
  connectBtn.textContent = state === 'streaming' ? 'Disconnect' : 'Connect'
}

// Manual connect via the form (dev / direct testing)
form.addEventListener('submit', async (e) => {
  e.preventDefault()
  if (session) { await session.disconnect(); session = null; return }

  const host = hostInput.value.trim()
  const httpPort = parseInt(portInput.value) || 47984
  if (!host) return

  // Build a ConnectionInfo from the manual form — all ports assumed to be at default values
  const connectionInfo: ConnectionInfo = {
    host,
    ports: { http: httpPort, https: 47989, webUi: 47990, control: 48010, video: 47998, audio: 47999 },
    leaseId: 'manual',
    dseq: 0,
    provider: host,
  }

  session = new SessionManager({
    sessionId: 'manual',
    workerUrl: WORKER_URL,
    authToken: '',
    connectionInfo,
    canvas,
    onStateChange: state => {
      onStateChange(state)
      if (state === 'streaming') form.style.display = 'none'
      if (state === 'disconnected' || state === 'error') form.style.display = 'flex'
    },
    onError: err => { setStatus(`Error: ${err.message}`); console.error('[Session]', err) },
  })

  await session.connect()
})

// Escape = exit pointer lock without disconnecting
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && document.pointerLockElement) document.exitPointerLock()
})

// postMessage from Next.js — receives full ConnectionInfo from the worker
window.addEventListener('message', async (e: MessageEvent) => {
  if (typeof e.data !== 'object' || e.data?.type !== 'basehack:connect') return

  const { connectionInfo, sessionId, authToken } = e.data as {
    type: string
    connectionInfo: ConnectionInfo
    sessionId: string
    authToken: string
  }

  hostInput.value = connectionInfo.host
  portInput.value = String(connectionInfo.ports.http)

  session = new SessionManager({
    sessionId,
    workerUrl: WORKER_URL,
    authToken,
    connectionInfo,
    canvas,
    onStateChange,
    onError: err => setStatus(`Error: ${err.message}`),
  })

  form.style.display = 'none'
  await session.connect()
})

// Auto-connect if ?autoconnect=1 and host provided via URL params
if (params.get('autoconnect') === '1' && paramHost) {
  form.requestSubmit()
}
