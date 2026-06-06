import { TcpTransport } from '../transport/tcp.ts'
import type { LaunchResult, StreamConfig } from '../types/protocol.ts'

// Standard RTSP 1.0 over TCP to Sunshine port 48010.
// After PLAY, Sunshine starts sending UDP video/audio on the negotiated ports.

interface RtspResponse {
  status: number
  headers: Map<string, string>
  body: string
}

export interface StreamPorts {
  videoPort: number
  audioPort: number
  controlPort: number
  sessionId: string
}

export class RtspClient {
  private transport!: TcpTransport
  private cseq = 0
  private sessionId = ''
  private host: string
  private port: number

  constructor(host: string, port: number) {
    this.host = host
    this.port = port
  }

  async connect(): Promise<void> {
    this.transport = await TcpTransport.connect(this.host, this.port)
  }

  private async request(method: string, url: string, headers: Record<string, string> = {}): Promise<RtspResponse> {
    this.cseq++
    const lines = [
      `${method} ${url} RTSP/1.0`,
      `CSeq: ${this.cseq}`,
      `X-GS-ClientVersion: 14`,
      `Host: ${this.host}`,
      ...(this.sessionId ? [`Session: ${this.sessionId}`] : []),
      ...Object.entries(headers).map(([k, v]) => `${k}: ${v}`),
      '',
      '',
    ]
    await this.transport.sendString(lines.join('\r\n'))
    return this.readResponse()
  }

  private async readResponse(): Promise<RtspResponse> {
    const raw = await this.transport.readUntilBlankLine()
    const lines = raw.split('\r\n')
    const statusLine = lines[0] ?? ''
    const match = statusLine.match(/RTSP\/\S+\s+(\d+)/)
    const status = match ? parseInt(match[1] ?? '0') : 0

    const headers = new Map<string, string>()
    for (const line of lines.slice(1)) {
      const colon = line.indexOf(':')
      if (colon === -1) continue
      headers.set(line.slice(0, colon).trim().toLowerCase(), line.slice(colon + 1).trim())
    }

    let body = ''
    const contentLength = parseInt(headers.get('content-length') ?? '0')
    if (contentLength > 0) {
      const bodyBytes = await this.transport.readExact(contentLength)
      body = new TextDecoder().decode(bodyBytes)
    }

    return { status, headers, body }
  }

  async setup(launch: LaunchResult, config: StreamConfig): Promise<StreamPorts> {
    const rtspUrl = `rtsp://${this.host}/streamid=${launch.sessionToken}`

    // OPTIONS — check server capabilities
    const options = await this.request('OPTIONS', '*')
    if (options.status !== 200) throw new Error(`RTSP OPTIONS failed: ${options.status}`)

    // DESCRIBE — get stream description
    const describe = await this.request('DESCRIBE', rtspUrl, { Accept: 'application/sdp' })
    if (describe.status !== 200) throw new Error(`RTSP DESCRIBE failed: ${describe.status}`)

    // Parse SDP for port info
    const ports = parseSdpPorts(describe.body) ?? {
      videoPort: launch.videoPort,
      audioPort: launch.audioPort,
      controlPort: launch.controlPort,
    }

    // SETUP — negotiate transport params
    const transportHeader = [
      'unicast',
      `X-GS-Width=${config.width}`,
      `X-GS-Height=${config.height}`,
      `X-GS-Fps=${config.fps}`,
      `X-GS-ClientUpdateRate=0`,
      `X-GS-Bitrate=${config.bitrateKbps}`,
      `X-GS-supportedVideoFormats=1`,
      `X-GS-ClientViewportWd=${config.width}`,
      `X-GS-ClientViewportHt=${config.height}`,
    ].join(';')

    const setup = await this.request('SETUP', rtspUrl, { Transport: transportHeader })
    if (setup.status !== 200) throw new Error(`RTSP SETUP failed: ${setup.status}`)

    this.sessionId = setup.headers.get('session')?.split(';')[0] ?? launch.sessionToken

    return { ...ports, sessionId: this.sessionId }
  }

  async play(): Promise<void> {
    const rtspUrl = `rtsp://${this.host}/streamid=${this.sessionId}`
    const play = await this.request('PLAY', rtspUrl)
    if (play.status !== 200) throw new Error(`RTSP PLAY failed: ${play.status}`)
  }

  async teardown(): Promise<void> {
    try {
      const rtspUrl = `rtsp://${this.host}/streamid=${this.sessionId}`
      await this.request('TEARDOWN', rtspUrl)
    } finally {
      await this.transport.close()
    }
  }
}

// Minimal SDP parser — we only care about port numbers from Sunshine's SDP
function parseSdpPorts(sdp: string): { videoPort: number; audioPort: number; controlPort: number } | null {
  const lines = sdp.split('\n').map(l => l.trim())
  let videoPort = 0
  let audioPort = 0
  let currentMedia = ''

  for (const line of lines) {
    if (line.startsWith('m=')) {
      const parts = line.split(' ')
      currentMedia = parts[0]?.slice(2) ?? ''
      const port = parseInt(parts[1] ?? '0')
      if (currentMedia === 'video' && port) videoPort = port
      if (currentMedia === 'audio' && port) audioPort = port
    }
  }

  if (!videoPort || !audioPort) return null
  return { videoPort, audioPort, controlPort: 48010 }
}
