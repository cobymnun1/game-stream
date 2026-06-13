export interface UdpPacket {
  data: Uint8Array
  remoteAddress: string
  remotePort: number
}

export class UdpTransport {
  private reader: ReadableStreamDefaultReader<UDPMessage> | undefined
  private writer:
    | WritableStreamDefaultWriter<{ data: Uint8Array; remoteAddress?: string; remotePort?: number }>
    | undefined
  private socket: UDPSocket | undefined
  private devSocketId: number | undefined
  private remoteAddress: string | undefined
  private remotePort: number | undefined
  // Dev-proxy receive batching: the Node proxy buffers all incoming datagrams,
  // so we drain many per HTTP round-trip into this local queue instead of one
  // fetch() per packet (which capped video throughput and grew an ever-larger
  // backlog → lag). receive() serves from here and only refills when empty.
  private rxQueue: UdpPacket[] = []
  // #region agent log
  private rxStatCount = 0
  private rxStatBatches = 0
  private rxStatStart = 0
  // #endregion

  private constructor(
    socket: UDPSocket | undefined,
    reader: ReadableStreamDefaultReader<UDPMessage> | undefined,
    writer:
      | WritableStreamDefaultWriter<{ data: Uint8Array; remoteAddress?: string; remotePort?: number }>
      | undefined,
    remoteAddress: string | undefined,
    remotePort: number | undefined,
    devSocketId?: number,
  ) {
    this.socket = socket
    this.reader = reader
    this.writer = writer
    this.remoteAddress = remoteAddress
    this.remotePort = remotePort
    this.devSocketId = devSocketId
  }

  // Bound socket — listens on a local port, sends to specific remote
  static async create(options?: {
    localPort?: number
    remoteAddress?: string
    remotePort?: number
  }): Promise<UdpTransport> {
    if (!('UDPSocket' in globalThis)) {
      const bindBody: Record<string, unknown> = {}
      if (options?.localPort !== undefined) bindBody['localPort'] = options.localPort
      if (options?.remoteAddress !== undefined) bindBody['remoteAddress'] = options.remoteAddress
      if (options?.remotePort !== undefined) bindBody['remotePort'] = options.remotePort
      const bound = await devUdpRequest<{ id: number }>({ op: 'bind', ...bindBody })
      return new UdpTransport(
        undefined,
        undefined,
        undefined,
        options?.remoteAddress,
        options?.remotePort,
        bound.id,
      )
    }

    const socketOpts: UDPSocketOptions = {}
    if (options?.localPort !== undefined) socketOpts.localPort = options.localPort
    if (options?.remoteAddress !== undefined) socketOpts.remoteAddress = options.remoteAddress
    if (options?.remotePort !== undefined) socketOpts.remotePort = options.remotePort

    const socket = new UDPSocket(socketOpts)
    const { readable, writable } = await socket.opened
    return new UdpTransport(
      socket,
      readable.getReader(),
      writable.getWriter(),
      options?.remoteAddress,
      options?.remotePort,
    )
  }

  async send(data: Uint8Array, address?: string, port?: number): Promise<void> {
    const resolved = address ?? this.remoteAddress
    const resolvedPort = port ?? this.remotePort

    if (this.devSocketId !== undefined) {
      const sendBody: Record<string, unknown> = { op: 'send', id: this.devSocketId, data: bytesToBase64(data) }
      if (resolved !== undefined) sendBody['host'] = resolved
      if (resolvedPort !== undefined) sendBody['port'] = resolvedPort
      await devUdpRequest(sendBody)
      return
    }

    if (!this.writer) throw new Error('UDP writer is not available')
    const msg: { data: Uint8Array; remoteAddress?: string; remotePort?: number } = { data }
    if (resolved !== undefined) msg.remoteAddress = resolved
    if (resolvedPort !== undefined) msg.remotePort = resolvedPort
    await this.writer.write(msg)
  }

  async receive(): Promise<UdpPacket> {
    if (this.devSocketId !== undefined) {
      while (this.rxQueue.length === 0) {
        // Server blocks until >=1 datagram is buffered, then returns the whole
        // backlog (up to max) in a single response.
        const resp = await devUdpRequest<{ packets: { data: string; address: string; port: number }[] }>({
          op: 'recvbatch',
          id: this.devSocketId,
          max: 256,
        })
        for (const p of resp.packets) {
          this.rxQueue.push({
            data: base64ToBytes(p.data),
            remoteAddress: p.address,
            remotePort: p.port,
          })
        }
        // #region agent log
        if (resp.packets.length > 0) {
          if (this.rxStatStart === 0) this.rxStatStart = Date.now()
          this.rxStatBatches++
          this.rxStatCount += resp.packets.length
          if (this.rxStatCount >= 2000) {
            const elapsed = Date.now() - this.rxStatStart
            fetch('http://127.0.0.1:7458/ingest/a70defe2-9a92-40ab-8b63-4a3e87de3fac', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Debug-Session-Id': '31fcc6' }, body: JSON.stringify({ sessionId: '31fcc6', runId: 'udp-batch-perf', hypothesisId: 'H80', location: 'apps/iwa/src/transport/udp.ts:receive', message: 'UDP batch receive throughput', data: { packets: this.rxStatCount, batches: this.rxStatBatches, elapsedMs: elapsed, pktPerSec: Math.round((this.rxStatCount / elapsed) * 1000), avgBatch: Math.round(this.rxStatCount / this.rxStatBatches) }, timestamp: Date.now() }) }).catch(() => {})
            this.rxStatCount = 0
            this.rxStatBatches = 0
            this.rxStatStart = Date.now()
          }
        }
        // #endregion
      }
      return this.rxQueue.shift() as UdpPacket
    }

    if (!this.reader) throw new Error('UDP reader is not available')
    const { value, done } = await this.reader.read()
    if (done) throw new Error('UDP socket closed')
    return value as UdpPacket
  }

  // Receive a datagram, waiting up to timeoutMs; resolve null on timeout.
  async receiveTimed(timeoutMs: number): Promise<UdpPacket | null> {
    if (this.devSocketId !== undefined) {
      const packet = await devUdpRequest<{ data: string; address: string; port: number; timedOut?: boolean }>({
        op: 'recv',
        id: this.devSocketId,
        timeoutMs,
      })
      if (packet.timedOut) return null
      return {
        data: base64ToBytes(packet.data),
        remoteAddress: packet.address,
        remotePort: packet.port,
      }
    }

    if (!this.reader) throw new Error('UDP reader is not available')
    let timer: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<null>(resolveTimeout => {
      timer = setTimeout(() => resolveTimeout(null), timeoutMs)
    })
    const read = this.reader.read().then(({ value, done }) => {
      if (done) return null
      return value as UdpPacket
    })
    try {
      return await Promise.race([read, timeout])
    } finally {
      if (timer !== undefined) clearTimeout(timer)
    }
  }

  // Start a continuous receive loop, calling handler for each packet
  startReceiving(handler: (packet: UdpPacket) => void, onError: (err: Error) => void): () => void {
    let cancelled = false
    const loop = async () => {
      while (!cancelled) {
        try {
          const pkt = await this.receive()
          handler(pkt)
        } catch (err) {
          if (!cancelled) onError(err instanceof Error ? err : new Error(String(err)))
          break
        }
      }
    }
    void loop()
    return () => { cancelled = true }
  }

  async close(): Promise<void> {
    try {
      if (this.devSocketId !== undefined) {
        await devUdpRequest({ op: 'close', id: this.devSocketId })
        return
      }
      this.reader?.releaseLock()
      this.writer?.releaseLock()
      await this.socket?.close()
    } catch {
      // Ignore — socket may already be gone
    }
  }
}

async function devUdpRequest<T = Record<string, unknown>>(body: Record<string, unknown>): Promise<T> {
  const response = await fetch('/__moonlight_udp', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!response.ok) {
    throw new Error(await response.text())
  }
  return await response.json() as T
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary)
}

function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes
}
