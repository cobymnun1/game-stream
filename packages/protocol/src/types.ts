export type VideoCodec = 'h264' | 'hevc' | 'av1'

export interface StreamConfig {
  width: number
  height: number
  fps: number
  bitrateKbps: number
  codec: VideoCodec
  audioChannels: 2 | 6 | 8
}

export interface LaunchInfo {
  sessionToken: string
  rtspSessionUrl: string
  riKey: Uint8Array
  riKeyId: number
  riIv?: Uint8Array
}

export interface ServerInfo {
  address: string
  appVersion?: string
  gfeVersion?: string
  codecModeSupport?: number
}

export type ConnectionStagePhase = 'starting' | 'complete' | 'failed'
export type EncodedVideoFrameType = 'idr' | 'pframe'

export interface EncodedVideoFrame {
  data: Uint8Array
  frameIndex: number
  type: EncodedVideoFrameType
  timestampUs: number
  rtpTimestamp: number
}

export interface VideoFormat {
  codec: VideoCodec
  width: number
  height: number
  fps: number
  rawFormat: number
}

export interface AudioFormat {
  audioConfiguration: number
  sampleRate: number
  channelCount: number
  samplesPerFrame: number
}

export interface AudioPacket {
  data: Uint8Array
}

export interface ConnectionStats {
  estimatedRttMs: number
  estimatedRttVarianceMs: number
}

export interface MoonlightCallbacks {
  onStage?: (event: {
    stage: number
    phase: ConnectionStagePhase
    errorCode?: number
    name?: string
  }) => void
  onConnectionStarted?: () => void
  onConnectionTerminated?: (errorCode: number) => void
  // Fired once after LiStartConnection returns on the connection worker,
  // carrying its result code (0 = streams established, non-zero = failure).
  onConnectionResult?: (code: number) => void
  onVideoFormat?: (format: VideoFormat) => void
  onVideoFrame?: (frame: EncodedVideoFrame) => void
  onAudioFormat?: (format: AudioFormat) => void
  onAudioPacket?: (packet: AudioPacket) => void
  onError?: (error: Error) => void
}

export interface MoonlightSessionOptions {
  transport: TransportFactory
  server: ServerInfo
  stream: StreamConfig
  launch: LaunchInfo
  callbacks?: MoonlightCallbacks
  moduleFactory?: MoonlightModuleFactory
  moduleUrl?: string
  locateFile?: (path: string, prefix: string) => string
}

export interface TcpHandle {
  send(data: Uint8Array): Promise<void>
  readExact(length: number): Promise<Uint8Array>
  // Read whatever bytes are available (up to maxLength), blocking until at
  // least one byte arrives. Returns an empty array when the peer closes the
  // connection. This matches POSIX recv() semantics that moonlight expects.
  readAvailable(maxLength: number): Promise<Uint8Array>
  close(): Promise<void>
}

export interface UdpHandle {
  send(data: Uint8Array, address?: string, port?: number): Promise<void>
  receive(): Promise<{ data: Uint8Array; remoteAddress: string; remotePort: number }>
  // Receive a datagram, waiting up to timeoutMs. Resolves null if no datagram
  // arrives in time. Used by the ENet control stream (poll + non-blocking recv).
  receiveTimed(timeoutMs: number): Promise<{ data: Uint8Array; remoteAddress: string; remotePort: number } | null>
  close(): Promise<void>
}

export interface TransportFactory {
  connectTcp(host: string, port: number): Promise<TcpHandle>
  createUdp(options: {
    localPort?: number
    remoteAddress?: string
    remotePort?: number
  }): Promise<UdpHandle>
}

export interface MoonlightRuntimeTransport {
  connect(host: string, port: number, socketType: 'tcp' | 'udp'): Promise<number>
  bindUdp(localPort?: number): Promise<number>
  send(fd: number, data: Uint8Array): Promise<number>
  recv(fd: number, length: number): Promise<Uint8Array>
  sendTo(fd: number, data: Uint8Array, host?: string, port?: number): Promise<number>
  recvFrom(fd: number, length: number): Promise<Uint8Array>
  recvFromTimed(fd: number, length: number, timeoutMs: number): Promise<Uint8Array>
  close(fd: number): void
}

export interface MoonlightWasmModule {
  HEAPU8: Uint8Array
  ccall: (
    ident: string,
    returnType: string | null,
    argTypes: string[],
    args: unknown[],
    opts?: { async?: boolean },
  ) => unknown
  cwrap: (ident: string, returnType: string | null, argTypes: string[]) => (...args: unknown[]) => unknown
  _malloc: (size: number) => number
  _free: (ptr: number) => void
  UTF8ToString?: (ptr: number) => string
  stringToUTF8?: (value: string, ptr: number, maxBytesToWrite: number) => void
  lengthBytesUTF8?: (value: string) => number
  moonlightTransport?: MoonlightRuntimeTransport
  moonlightCallbacks?: MoonlightCallbacks
}

export type MoonlightModuleFactory = (opts?: Record<string, unknown>) => Promise<MoonlightWasmModule>

export type KeyboardAction = 'down' | 'up'
export type MouseButtonAction = 'down' | 'up'

export interface InputSink {
  sendKeyboard(keyCode: number, action: KeyboardAction, modifiers?: number): void
  sendMouseMove(deltaX: number, deltaY: number): void
  sendMouseButton(button: number, action: MouseButtonAction): void
  sendMouseScroll(wheelDelta: number): void
}
