export class TcpTransport {
  private reader: ReadableStreamDefaultReader<Uint8Array>
  private writer: WritableStreamDefaultWriter<Uint8Array>
  private socket: TCPSocket
  private readBuffer = new Uint8Array(0)

  private constructor(
    socket: TCPSocket,
    reader: ReadableStreamDefaultReader<Uint8Array>,
    writer: WritableStreamDefaultWriter<Uint8Array>,
  ) {
    this.socket = socket
    this.reader = reader
    this.writer = writer
  }

  static async connect(host: string, port: number): Promise<TcpTransport> {
    const socket = new TCPSocket(host, port, { noDelay: true })
    const { readable, writable } = await socket.opened
    return new TcpTransport(
      socket,
      readable.getReader(),
      writable.getWriter(),
    )
  }

  async send(data: Uint8Array): Promise<void> {
    await this.writer.write(data)
  }

  async sendString(text: string): Promise<void> {
    await this.send(new TextEncoder().encode(text))
  }

  // Read exactly `length` bytes, buffering across multiple socket reads
  async readExact(length: number): Promise<Uint8Array> {
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

  // Read until \r\n\r\n (RTSP/HTTP response headers end)
  async readUntilBlankLine(): Promise<string> {
    const decoder = new TextDecoder()
    let text = ''
    while (!text.includes('\r\n\r\n')) {
      const { value, done } = await this.reader.read()
      if (done) throw new Error('TCP connection closed while reading headers')
      text += decoder.decode(value, { stream: true })
    }
    // Put any bytes after the blank line back into the buffer
    const boundary = text.indexOf('\r\n\r\n') + 4
    const extra = text.slice(boundary)
    if (extra.length > 0) {
      const merged = new Uint8Array(this.readBuffer.length + extra.length)
      merged.set(this.readBuffer)
      merged.set(new TextEncoder().encode(extra), this.readBuffer.length)
      this.readBuffer = merged
    }
    return text.slice(0, boundary)
  }

  async close(): Promise<void> {
    try {
      this.reader.releaseLock()
      this.writer.releaseLock()
      await this.socket.close()
    } catch {
      // Ignore close errors — socket may already be gone
    }
  }
}
