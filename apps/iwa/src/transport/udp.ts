export interface UdpPacket {
  data: Uint8Array
  remoteAddress: string
  remotePort: number
}

export class UdpTransport {
  private reader: ReadableStreamDefaultReader<UDPMessage>
  private writer: WritableStreamDefaultWriter<{ data: Uint8Array; remoteAddress?: string; remotePort?: number }>
  private socket: UDPSocket
  private remoteAddress: string | undefined
  private remotePort: number | undefined

  private constructor(
    socket: UDPSocket,
    reader: ReadableStreamDefaultReader<UDPMessage>,
    writer: WritableStreamDefaultWriter<{ data: Uint8Array; remoteAddress?: string; remotePort?: number }>,
    remoteAddress: string | undefined,
    remotePort: number | undefined,
  ) {
    this.socket = socket
    this.reader = reader
    this.writer = writer
    this.remoteAddress = remoteAddress
    this.remotePort = remotePort
  }

  // Bound socket — listens on a local port, sends to specific remote
  static async create(options?: {
    localPort?: number
    remoteAddress?: string
    remotePort?: number
  }): Promise<UdpTransport> {
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
    const msg: { data: Uint8Array; remoteAddress?: string; remotePort?: number } = { data }
    if (resolved !== undefined) msg.remoteAddress = resolved
    if (resolvedPort !== undefined) msg.remotePort = resolvedPort
    await this.writer.write(msg)
  }

  async receive(): Promise<UdpPacket> {
    const { value, done } = await this.reader.read()
    if (done) throw new Error('UDP socket closed')
    return value as UdpPacket
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
      this.reader.releaseLock()
      this.writer.releaseLock()
      await this.socket.close()
    } catch {
      // Ignore — socket may already be gone
    }
  }
}
