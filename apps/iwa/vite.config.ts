import { defineConfig } from 'vite'
import { resolve } from 'path'
import { request as httpRequest } from 'http'
import { Agent as HttpsAgent, request as httpsRequest } from 'https'
import { connect as netConnect, type Socket } from 'net'
import { createSocket as createDgramSocket, type Socket as DgramSocket } from 'dgram'

// IWA_BASE_URL is set during bundle builds so all asset paths use isolated-app://
const base = process.env['VITE_BASE'] ?? '/'
const DEV_SUNSHINE_PROXY = '/__moonlight_http'
const DEV_TCP_PROXY = '/__moonlight_tcp'
const DEV_UDP_PROXY = '/__moonlight_udp'
const DEBUG_ENDPOINT = 'http://127.0.0.1:7458/ingest/a70defe2-9a92-40ab-8b63-4a3e87de3fac'
let proxyRequestId = 0
let tcpProxyId = 0
let udpProxyId = 0
const tcpSockets = new Map<number, TcpProxySocket>()
const udpSockets = new Map<number, UdpProxySocket>()

function debugLog(hypothesisId: string, location: string, message: string, data: Record<string, unknown>): void {
  // #region agent log
  fetch(DEBUG_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Debug-Session-Id': '31fcc6' },
    body: JSON.stringify({
      sessionId: '31fcc6',
      runId: 'cert-auth-502',
      hypothesisId,
      location,
      message,
      data,
      timestamp: Date.now(),
    }),
  }).catch(() => {})
  // #endregion
}

export default defineConfig({
  root: '.',
  base,
  plugins: [{
    name: 'sunshine-dev-proxy',
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        const requestUrl = new URL(req.url ?? '', 'http://localhost')
        if (requestUrl.pathname === DEV_TCP_PROXY) {
          try {
            const body = await readJsonBody(req)
            const result = await handleTcpProxy(body)
            res.setHeader('Content-Type', 'application/json')
            res.end(JSON.stringify(result))
          } catch (err) {
            debugLog('H22,H23,H24', 'apps/iwa/vite.config.ts:tcpProxy', 'TCP proxy request failed', {
              errorName: err instanceof Error ? err.name : typeof err,
              errorMessage: err instanceof Error ? err.message : String(err),
            })
            res.statusCode = 502
            res.end(JSON.stringify({ error: err instanceof Error ? err.message : 'TCP proxy failed' }))
          }
          return
        }

        if (requestUrl.pathname === DEV_UDP_PROXY) {
          try {
            const body = await readJsonBody(req)
            const result = await handleUdpProxy(body)
            res.setHeader('Content-Type', 'application/json')
            res.end(JSON.stringify(result))
          } catch (err) {
            debugLog('H30', 'apps/iwa/vite.config.ts:udpProxy', 'UDP proxy request failed', {
              errorName: err instanceof Error ? err.name : typeof err,
              errorMessage: err instanceof Error ? err.message : String(err),
            })
            res.statusCode = 502
            res.end(JSON.stringify({ error: err instanceof Error ? err.message : 'UDP proxy failed' }))
          }
          return
        }

        if (requestUrl.pathname !== DEV_SUNSHINE_PROXY) {
          next()
          return
        }

        try {
          const body = req.method === 'POST' ? await readJsonBody(req) : null
          const host = body?.host ?? requestUrl.searchParams.get('host')
          const port = String(body?.port ?? requestUrl.searchParams.get('port') ?? '')
          const path = body?.path ?? requestUrl.searchParams.get('path')
          const scheme = (body?.scheme ?? requestUrl.searchParams.get('scheme')) === 'https' ? 'https' : 'http'
          const clientCert = scheme === 'https'
            ? body?.clientCert ?? requestUrl.searchParams.get('clientcert') ?? undefined
            : undefined
          const clientKey = scheme === 'https'
            ? body?.clientKey ?? requestUrl.searchParams.get('clientkey') ?? undefined
            : undefined

          if (!host || !port || !path?.startsWith('/')) {
            res.statusCode = 400
            res.end('Missing host, port, or path')
            return
          }

          debugLog('H1,H2,H4', 'apps/iwa/vite.config.ts:configureServer', 'Proxy received Sunshine request', {
            method: req.method,
            scheme,
            host,
            port,
            path,
            hasClientCert: Boolean(clientCert),
            hasClientKey: Boolean(clientKey),
            clientCertLength: clientCert?.length ?? 0,
            clientKeyLength: clientKey?.length ?? 0,
            paramKeys: body?.params ? Object.keys(body.params) : Array.from(requestUrl.searchParams.keys()),
          })

          const target = new URL(`${scheme}://${host}:${port}${path}`)
          if (body?.params) {
            for (const [key, value] of Object.entries(body.params)) {
              target.searchParams.append(key, String(value))
            }
          }
          for (const [key, value] of requestUrl.searchParams) {
            const isProxyParam = ['host', 'port', 'path', 'scheme'].includes(key)
              || (scheme === 'https' && ['clientcert', 'clientkey'].includes(key))
            if (!isProxyParam) {
              target.searchParams.append(key, value)
            }
          }

          const upstream = await proxySunshine(target, { clientCert, clientKey })
          res.statusCode = upstream.statusCode
          if (upstream.contentType) res.setHeader('Content-Type', upstream.contentType)
          res.end(upstream.body)
        } catch (err) {
          debugLog('H2,H3,H4', 'apps/iwa/vite.config.ts:configureServer', 'Proxy returned 502', {
            errorName: err instanceof Error ? err.name : typeof err,
            errorMessage: err instanceof Error ? err.message : String(err),
            errorCode: typeof err === 'object' && err !== null && 'code' in err ? String(err.code) : '',
          })
          console.error('[sunshine-dev-proxy]', err)
          res.statusCode = 502
          res.end(err instanceof Error ? err.message : 'Sunshine proxy failed')
        }
      })
    },
  }],
  build: {
    outDir: 'dist',
    target: 'esnext',
    rollupOptions: {
      input: {
        main: resolve(__dirname, 'index.html'),
        auto: resolve(__dirname, 'auto.html'),
      },
    },
  },
  server: {
    port: 3001,
    headers: {
      // Required for SharedArrayBuffer (used by some codecs)
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
    },
  },
})

function proxySunshine(
  target: URL,
  tls?: { clientCert?: string; clientKey?: string },
): Promise<{ statusCode: number; contentType?: string; body: string }> {
  return new Promise((resolveProxy, rejectProxy) => {
    const requestId = ++proxyRequestId
    const requestImpl = target.protocol === 'https:' ? httpsRequest : httpRequest
    debugLog('H10,H11,H12', 'apps/iwa/vite.config.ts:proxySunshine', 'Starting upstream request with socket probe', {
      requestId,
      protocol: target.protocol,
      port: target.port,
      path: target.pathname,
      hasClientCert: Boolean(tls?.clientCert),
      hasClientKey: Boolean(tls?.clientKey),
    })
    debugLog('H2,H3,H4', 'apps/iwa/vite.config.ts:proxySunshine', 'Opening upstream Sunshine request', {
      protocol: target.protocol,
      port: target.port,
      path: target.pathname,
      fullPathLength: `${target.pathname}${target.search}`.length,
      searchLength: target.search.length,
      queryKeys: Array.from(target.searchParams.keys()),
      clientCertQueryLength: target.searchParams.get('clientcert')?.length ?? 0,
      tlsCertPresent: Boolean(tls?.clientCert),
      tlsKeyPresent: Boolean(tls?.clientKey),
      tlsCertLength: tls?.clientCert?.length ?? 0,
      tlsKeyLength: tls?.clientKey?.length ?? 0,
      tlsMinVersion: 'TLSv1.2',
      tlsMaxVersion: 'TLSv1.2',
      tlsSessionCacheDisabled: target.protocol === 'https:',
    })
    const agent = target.protocol === 'https:'
      ? new HttpsAgent({ keepAlive: false, maxCachedSessions: 0 })
      : undefined
    const upstream = requestImpl({
      protocol: target.protocol,
      hostname: target.hostname,
      port: target.port,
      path: `${target.pathname}${target.search}`,
      method: 'GET',
      rejectUnauthorized: false,
      minVersion: 'TLSv1.2',
      maxVersion: 'TLSv1.2',
      agent,
      cert: tls?.clientCert,
      key: tls?.clientKey,
    }, response => {
      response.setEncoding('utf8')
      let body = ''
      response.on('data', chunk => { body += chunk })
      response.on('end', () => {
        const contentType = response.headers['content-type']
        debugLog('H4', 'apps/iwa/vite.config.ts:proxySunshine', 'Received upstream Sunshine response', {
          protocol: target.protocol,
          port: target.port,
          path: target.pathname,
          statusCode: response.statusCode ?? 0,
          contentType: Array.isArray(contentType) ? contentType[0] : contentType,
          bodyPrefix: body.slice(0, 180),
        })
        resolveProxy({
          statusCode: response.statusCode ?? 502,
          contentType: Array.isArray(contentType) ? contentType[0] : contentType,
          body,
        })
      })
    })

    upstream.on('socket', socket => {
      if (target.protocol !== 'https:') return
      socket.once('secureConnect', () => {
        const tlsSocket = socket as import('tls').TLSSocket
        debugLog('H10,H11,H12', 'apps/iwa/vite.config.ts:proxySunshine', 'HTTPS socket secureConnect details', {
          requestId,
          path: target.pathname,
          protocol: tlsSocket.getProtocol(),
          isSessionReused: tlsSocket.isSessionReused(),
          authorized: tlsSocket.authorized,
          authorizationError: tlsSocket.authorizationError ? String(tlsSocket.authorizationError) : '',
          cipherName: tlsSocket.getCipher().name,
        })
      })
    })

    upstream.setTimeout(120_000, () => {
      upstream.destroy(new Error(`Timed out proxying ${target.toString()}`))
    })
    upstream.on('error', rejectProxy)
    upstream.end()
  })
}

interface TcpProxySocket {
  socket: Socket
  chunks: Buffer[]
  bufferedLength: number
  ended: boolean
  error: string | null
  waiters: Array<() => void>
}

async function handleTcpProxy(body: {
  op?: string
  host?: string
  port?: number
  id?: number
  data?: string
  length?: number
} | null): Promise<Record<string, unknown>> {
  if (!body?.op) throw new Error('Missing TCP proxy op')

  if (body.op === 'connect') {
    if (!body.host || !body.port) throw new Error('Missing TCP proxy host or port')
    const id = await tcpConnect(body.host, body.port)
    return { id }
  }

  if (body.id === undefined) throw new Error('Missing TCP proxy socket id')
  const entry = tcpSockets.get(body.id)
  if (!entry) throw new Error(`Unknown TCP proxy socket ${body.id}`)

  if (body.op === 'send') {
    const data = Buffer.from(body.data ?? '', 'base64')
    await tcpWrite(entry, data)
    return { written: data.length }
  }

  if (body.op === 'recv') {
    const data = await tcpReadExact(entry, body.length ?? 0)
    return { data: data.toString('base64') }
  }

  if (body.op === 'recvsome') {
    const data = await tcpReadSome(entry, body.length ?? 0)
    return { data: data.toString('base64') }
  }

  if (body.op === 'close') {
    tcpSockets.delete(body.id)
    entry.socket.destroy()
    return { closed: true }
  }

  throw new Error(`Unsupported TCP proxy op ${body.op}`)
}

function tcpConnect(host: string, port: number): Promise<number> {
  return new Promise((resolveConnect, rejectConnect) => {
    const id = ++tcpProxyId
    const entry: TcpProxySocket = {
      socket: netConnect({ host, port }),
      chunks: [],
      bufferedLength: 0,
      ended: false,
      error: null,
      waiters: [],
    }
    const failConnect = (err: Error) => {
      tcpSockets.delete(id)
      rejectConnect(err)
    }
    entry.socket.setNoDelay(true)
    entry.socket.once('connect', () => {
      tcpSockets.set(id, entry)
      debugLog('H22', 'apps/iwa/vite.config.ts:tcpConnect', 'TCP proxy connected', { id, host, port })
      resolveConnect(id)
    })
    entry.socket.once('error', failConnect)
    entry.socket.on('data', chunk => {
      entry.chunks.push(chunk)
      entry.bufferedLength += chunk.length
      notifyTcpWaiters(entry)
    })
    entry.socket.on('close', () => {
      entry.ended = true
      notifyTcpWaiters(entry)
      debugLog('H24', 'apps/iwa/vite.config.ts:tcpConnect', 'TCP proxy socket closed', { id })
    })
    entry.socket.on('error', err => {
      entry.error = err.message
      notifyTcpWaiters(entry)
      debugLog('H24', 'apps/iwa/vite.config.ts:tcpConnect', 'TCP proxy socket error', {
        id,
        message: err.message,
      })
    })
  })
}

function tcpWrite(entry: TcpProxySocket, data: Buffer): Promise<void> {
  return new Promise((resolveWrite, rejectWrite) => {
    if (entry.error) {
      rejectWrite(new Error(entry.error))
      return
    }
    entry.socket.write(data, err => {
      if (err) rejectWrite(err)
      else resolveWrite()
    })
  })
}

async function tcpReadExact(entry: TcpProxySocket, length: number): Promise<Buffer> {
  if (length <= 0) return Buffer.alloc(0)
  while (entry.bufferedLength < length) {
    if (entry.error) throw new Error(entry.error)
    if (entry.ended) throw new Error('TCP proxy socket closed unexpectedly')
    await new Promise<void>(resolveWait => {
      entry.waiters.push(resolveWait)
    })
  }

  const output = Buffer.allocUnsafe(length)
  let offset = 0
  while (offset < length) {
    const chunk = entry.chunks[0]
    const needed = length - offset
    if (chunk.length <= needed) {
      output.set(chunk, offset)
      offset += chunk.length
      entry.chunks.shift()
    } else {
      output.set(chunk.subarray(0, needed), offset)
      entry.chunks[0] = chunk.subarray(needed)
      offset += needed
    }
  }
  entry.bufferedLength -= length
  return output
}

// Return whatever bytes are buffered (up to length), blocking until at least
// one byte arrives. Returns an empty buffer when the peer has closed and no
// buffered bytes remain — matching POSIX recv() end-of-stream semantics.
async function tcpReadSome(entry: TcpProxySocket, length: number): Promise<Buffer> {
  if (length <= 0) return Buffer.alloc(0)
  while (entry.bufferedLength === 0) {
    if (entry.error) throw new Error(entry.error)
    if (entry.ended) return Buffer.alloc(0)
    await new Promise<void>(resolveWait => {
      entry.waiters.push(resolveWait)
    })
  }

  const take = Math.min(length, entry.bufferedLength)
  const output = Buffer.allocUnsafe(take)
  let offset = 0
  while (offset < take) {
    const chunk = entry.chunks[0]
    const needed = take - offset
    if (chunk.length <= needed) {
      output.set(chunk, offset)
      offset += chunk.length
      entry.chunks.shift()
    } else {
      output.set(chunk.subarray(0, needed), offset)
      entry.chunks[0] = chunk.subarray(needed)
      offset += needed
    }
  }
  entry.bufferedLength -= take
  return output
}

function notifyTcpWaiters(entry: TcpProxySocket): void {
  for (const waiter of entry.waiters.splice(0)) waiter()
}

interface UdpDatagram {
  data: Buffer
  address: string
  port: number
}

interface UdpProxySocket {
  socket: DgramSocket
  packets: UdpDatagram[]
  waiters: Array<() => void>
  remoteAddress: string | undefined
  remotePort: number | undefined
  // #region agent log
  rxTotal?: number
  rxUniqueFull?: Set<number>
  rxUniquePayload?: Set<number>
  rxLastReport?: number
  // #endregion
}

async function handleUdpProxy(body: {
  op?: string
  host?: string
  port?: number
  id?: number
  data?: string
  length?: number
  localPort?: number
  remoteAddress?: string
  remotePort?: number
  timeoutMs?: number
  max?: number
} | null): Promise<Record<string, unknown>> {
  if (!body?.op) throw new Error('Missing UDP proxy op')

  if (body.op === 'bind') {
    const id = await udpBind(body.localPort, body.remoteAddress, body.remotePort)
    return { id }
  }

  if (body.id === undefined) throw new Error('Missing UDP proxy socket id')
  const entry = udpSockets.get(body.id)
  if (!entry) throw new Error(`Unknown UDP proxy socket ${body.id}`)

  if (body.op === 'send') {
    const data = Buffer.from(body.data ?? '', 'base64')
    const host = body.host ?? entry.remoteAddress
    const port = body.port ?? entry.remotePort
    if (host === undefined || port === undefined) throw new Error('UDP send missing destination')
    await udpSend(entry, data, host, port)
    return { written: data.length }
  }

  if (body.op === 'recv') {
    const packet = await udpReceive(entry, body.timeoutMs)
    if (!packet) return { timedOut: true, data: '', address: '', port: 0 }
    return {
      data: packet.data.toString('base64'),
      address: packet.address,
      port: packet.port,
    }
  }

  if (body.op === 'recvbatch') {
    const packets = await udpReceiveBatch(entry, body.max ?? 256)
    return {
      packets: packets.map(p => ({
        data: p.data.toString('base64'),
        address: p.address,
        port: p.port,
      })),
    }
  }

  if (body.op === 'close') {
    udpSockets.delete(body.id)
    try { entry.socket.close() } catch { /* already closed */ }
    return { closed: true }
  }

  throw new Error(`Unsupported UDP proxy op ${body.op}`)
}

function udpBind(localPort?: number, remoteAddress?: string, remotePort?: number): Promise<number> {
  return new Promise((resolveBind, rejectBind) => {
    const id = ++udpProxyId
    const socket = createDgramSocket('udp4')
    const entry: UdpProxySocket = {
      socket,
      packets: [],
      waiters: [],
      remoteAddress,
      remotePort,
    }
    socket.on('message', (msg, rinfo) => {
      entry.packets.push({ data: Buffer.from(msg), address: rinfo.address, port: rinfo.port })
      // #region agent log
      // Distinguish header variation from payload variation. A frozen host
      // desktop sends advancing frame/seq headers (bytes ~0-31) with identical
      // encoded payload (bytes 32+). Hashing densely (every byte) avoids missing
      // the header fields the previous sparse hash skipped.
      {
        let full = msg.length
        for (let i = 0; i < msg.length; i++) full = (full * 31 + msg[i]) >>> 0
        let payload = Math.max(0, msg.length - 32)
        for (let i = 32; i < msg.length; i++) payload = (payload * 31 + msg[i]) >>> 0
        entry.rxTotal = (entry.rxTotal ?? 0) + 1
        if (!entry.rxUniqueFull) entry.rxUniqueFull = new Set<number>()
        if (!entry.rxUniquePayload) entry.rxUniquePayload = new Set<number>()
        entry.rxUniqueFull.add(full)
        entry.rxUniquePayload.add(payload)
        const now = Date.now()
        if (!entry.rxLastReport) entry.rxLastReport = now
        if (entry.rxTotal % 500 === 0 && now - entry.rxLastReport > 1500) {
          entry.rxLastReport = now
          const head: number[] = []
          for (let i = 0; i < Math.min(16, msg.length); i++) head.push(msg[i])
          debugLog('H-WIRE', 'apps/iwa/vite.config.ts:socket.message', 'raw datagram variation', {
            id,
            localPort: socket.address().port,
            total: entry.rxTotal,
            uniqueFull: entry.rxUniqueFull.size,
            uniquePayload: entry.rxUniquePayload.size,
            lastLen: msg.length,
            head16: head,
          })
          if (entry.rxUniqueFull.size > 8192) entry.rxUniqueFull.clear()
          if (entry.rxUniquePayload.size > 8192) entry.rxUniquePayload.clear()
        }
      }
      // #endregion
      for (const waiter of entry.waiters.splice(0)) waiter()
    })
    socket.once('error', err => {
      udpSockets.delete(id)
      rejectBind(err)
    })
    socket.bind(localPort && localPort > 0 ? localPort : 0, () => {
      udpSockets.set(id, entry)
      debugLog('H30', 'apps/iwa/vite.config.ts:udpBind', 'UDP proxy bound', {
        id,
        localPort: socket.address().port,
        remoteAddress: remoteAddress ?? null,
        remotePort: remotePort ?? null,
      })
      resolveBind(id)
    })
  })
}

function udpSend(entry: UdpProxySocket, data: Buffer, host: string, port: number): Promise<void> {
  return new Promise((resolveSend, rejectSend) => {
    entry.socket.send(data, port, host, err => {
      if (err) rejectSend(err)
      else resolveSend()
    })
  })
}

async function udpReceive(entry: UdpProxySocket, timeoutMs?: number): Promise<UdpDatagram | null> {
  if (entry.packets.length === 0 && timeoutMs !== undefined) {
    let timer: ReturnType<typeof setTimeout> | undefined
    let waiter: (() => void) | undefined
    await new Promise<void>(resolveWait => {
      waiter = resolveWait
      entry.waiters.push(resolveWait)
      timer = setTimeout(resolveWait, timeoutMs)
    })
    if (timer !== undefined) clearTimeout(timer)
    if (waiter !== undefined) {
      const idx = entry.waiters.indexOf(waiter)
      if (idx >= 0) entry.waiters.splice(idx, 1)
    }
    if (entry.packets.length === 0) return null
  } else {
    while (entry.packets.length === 0) {
      await new Promise<void>(resolveWait => {
        entry.waiters.push(resolveWait)
      })
    }
  }
  return entry.packets.shift() as UdpDatagram
}

// Blocks until at least one datagram is buffered, then returns the entire
// backlog (up to `max`) in one shot. This lets the client drain many datagrams
// per HTTP round-trip instead of one fetch() per packet, which is essential to
// keep up with the video RTP rate (~1800 pkt/s) over the dev proxy.
async function udpReceiveBatch(entry: UdpProxySocket, max: number): Promise<UdpDatagram[]> {
  while (entry.packets.length === 0) {
    await new Promise<void>(resolveWait => {
      entry.waiters.push(resolveWait)
    })
  }
  return entry.packets.splice(0, max) as UdpDatagram[]
}

interface ProxyRequestBody {
  op?: string
  host?: string
  port?: number
  id?: number
  data?: string
  length?: number
  path?: string
  scheme?: string
  params?: Record<string, string>
  clientCert?: string
  clientKey?: string
  localPort?: number
  remoteAddress?: string
  remotePort?: number
}

function readJsonBody(req: import('http').IncomingMessage): Promise<ProxyRequestBody | null> {
  return new Promise((resolveRead, rejectRead) => {
    let raw = ''
    req.setEncoding('utf8')
    req.on('data', chunk => { raw += chunk })
    req.on('end', () => {
      if (!raw.trim()) {
        resolveRead(null)
        return
      }

      try {
        resolveRead(JSON.parse(raw) as ProxyRequestBody)
      } catch (err) {
        rejectRead(err)
      }
    })
    req.on('error', rejectRead)
  })
}
