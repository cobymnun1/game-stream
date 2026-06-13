export class TcpTransport {
  private reader: ReadableStreamDefaultReader<Uint8Array> | undefined
  private writer: WritableStreamDefaultWriter<Uint8Array> | undefined
  private socket: TCPSocket | undefined
  private devSocketId: number | undefined
  private readBuffer = new Uint8Array(0)

  private constructor(
    socket?: TCPSocket,
    reader?: ReadableStreamDefaultReader<Uint8Array>,
    writer?: WritableStreamDefaultWriter<Uint8Array>,
    devSocketId?: number,
  ) {
    this.socket = socket
    this.reader = reader
    this.writer = writer
    this.devSocketId = devSocketId
  }

  static async connect(host: string, port: number): Promise<TcpTransport> {
    if (!('TCPSocket' in globalThis)) {
      const connected = await devTcpRequest<{ id: number }>({ op: 'connect', host, port })
      return new TcpTransport(undefined, undefined, undefined, connected.id)
    }

    const socket = new TCPSocket(host, port, { noDelay: true })
    const { readable, writable } = await socket.opened
    return new TcpTransport(
      socket,
      readable.getReader(),
      writable.getWriter(),
    )
  }

  async send(data: Uint8Array): Promise<void> {
    if (this.devSocketId !== undefined) {
      await devTcpRequest({ op: 'send', id: this.devSocketId, data: bytesToBase64(data) })
      return
    }
    if (!this.writer) throw new Error('TCP writer is not available')
    await this.writer.write(data)
  }

  // Read exactly `length` bytes, buffering across multiple socket reads
  async readExact(length: number): Promise<Uint8Array> {
    if (this.devSocketId !== undefined) {
      const result = await devTcpRequest<{ data: string }>({ op: 'recv', id: this.devSocketId, length })
      return base64ToBytes(result.data)
    }

    if (!this.reader) throw new Error('TCP reader is not available')
    while (this.readBuffer.length < length) {
      const { value, done } = await this.reader.read()
      if (done) throw new Error('TCP connection closed unexpectedly')
      const merged = new Uint8Array(this.readBuffer.length + value.length)
      merged.set(this.readBuffer)
      merged.set(value, this.readBuffer.length)
      this.readBuffer = merged
    }
    const result = this.readBuffer.slice(0, length)
    this.readBuffer = this.readBuffer.slice(length)
    return result
  }

  // Read whatever bytes are available (up to maxLength). Blocks until at least
  // one byte arrives; returns an empty array when the peer closes the socket.
  async readAvailable(maxLength: number): Promise<Uint8Array> {
    if (this.devSocketId !== undefined) {
      const result = await devTcpRequest<{ data: string }>({
        op: 'recvsome',
        id: this.devSocketId,
        length: maxLength,
      })
      return base64ToBytes(result.data)
    }

    if (!this.reader) throw new Error('TCP reader is not available')
    if (this.readBuffer.length === 0) {
      const { value, done } = await this.reader.read()
      if (done) return new Uint8Array(0)
      this.readBuffer = new Uint8Array(value)
    }
    const take = Math.min(maxLength, this.readBuffer.length)
    const result = this.readBuffer.slice(0, take)
    this.readBuffer = this.readBuffer.slice(take)
    return result
  }

  async close(): Promise<void> {
    try {
      if (this.devSocketId !== undefined) {
        await devTcpRequest({ op: 'close', id: this.devSocketId })
        return
      }
      this.reader?.releaseLock()
      this.writer?.releaseLock()
      await this.socket?.close()
    } catch {
      // Ignore close errors — socket may already be gone
    }
  }
}

async function devTcpRequest<T = Record<string, unknown>>(body: Record<string, unknown>): Promise<T> {
  const response = await fetch('/__moonlight_tcp', {
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
