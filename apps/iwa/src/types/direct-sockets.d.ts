// Direct Sockets API — W3C WICG spec (Chrome IWA only)
// https://wicg.github.io/direct-sockets/

interface TCPSocketOpenInfo {
  readable: ReadableStream<Uint8Array>
  writable: WritableStream<Uint8Array>
  remoteAddress: string
  remotePort: number
  localAddress: string
  localPort: number
}

interface TCPSocketOptions {
  sendBufferSize?: number
  receiveBufferSize?: number
  noDelay?: boolean
  keepAliveDelay?: number
}

declare class TCPSocket {
  readonly opened: Promise<TCPSocketOpenInfo>
  readonly closed: Promise<void>
  constructor(remoteAddress: string, remotePort: number, options?: TCPSocketOptions)
  close(): Promise<void>
}

interface UDPMessage {
  data: Uint8Array
  remoteAddress: string
  remotePort: number
}

interface UDPSocketOpenInfo {
  readable: ReadableStream<UDPMessage>
  writable: WritableStream<{ data: Uint8Array; remoteAddress?: string; remotePort?: number }>
  localAddress: string
  localPort: number
}

interface UDPSocketOptions {
  localAddress?: string
  localPort?: number
  remoteAddress?: string
  remotePort?: number
  sendBufferSize?: number
  receiveBufferSize?: number
}

declare class UDPSocket {
  readonly opened: Promise<UDPSocketOpenInfo>
  readonly closed: Promise<void>
  constructor(options?: UDPSocketOptions)
  close(): Promise<void>
}
