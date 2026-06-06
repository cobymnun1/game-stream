import { PairingClient } from '../pairing/client.ts'
import { RtspClient } from '../rtsp/client.ts'
import { UdpTransport } from '../transport/udp.ts'
import { VideoDepacketizer } from '../video/depacketizer.ts'
import { VideoStreamDecoder } from '../video/decoder.ts'
import { CanvasRenderer } from '../video/renderer.ts'
import { KeyboardInput } from '../input/keyboard.ts'
import { MouseInput } from '../input/mouse.ts'
import type { ConnectionState, StreamConfig } from '../types/protocol.ts'
import type { ConnectionInfo } from '../types/connection.ts'

const DEFAULT_STREAM: StreamConfig = {
  width: 1920, height: 1080, fps: 60,
  bitrateKbps: 20000, codec: 'h264', audioChannels: 2,
}

export interface SessionOptions {
  // Session ID in the worker DB — used for /api/pin callback
  sessionId: string
  // Worker base URL for pin submission
  workerUrl: string
  // Auth token for worker API calls
  authToken: string
  // Connection info returned by the worker when session is 'ready'
  connectionInfo: ConnectionInfo
  stream?: Partial<StreamConfig>
  canvas: HTMLCanvasElement
  onStateChange: (state: ConnectionState) => void
  onError: (err: Error) => void
}

export class SessionManager {
  private opts: SessionOptions & { stream: StreamConfig }
  private state: ConnectionState = 'idle'

  private rtsp?: RtspClient
  private videoUdp?: UdpTransport
  private audioUdp?: UdpTransport
  private inputUdp?: UdpTransport

  private depacketizer = new VideoDepacketizer()
  private decoder: VideoStreamDecoder
  private renderer: CanvasRenderer
  private keyboard: KeyboardInput
  private mouse: MouseInput
  private stopReceiving?: () => void

  constructor(opts: SessionOptions) {
    this.opts = { ...opts, stream: { ...DEFAULT_STREAM, ...opts.stream } }

    this.renderer = new CanvasRenderer(opts.canvas)
    this.decoder = new VideoStreamDecoder()
    this.decoder.onFrame(frame => this.renderer.render(frame))
    this.decoder.onError(err => console.warn('[VideoDecoder]', err))
    this.depacketizer.onFrame(frame => {
      this.decoder.decode(frame, this.opts.stream.width, this.opts.stream.height)
    })
    this.keyboard = new KeyboardInput(pkt => void this.sendInput(pkt))
    this.mouse = new MouseInput(opts.canvas, pkt => void this.sendInput(pkt))
  }

  private setState(s: ConnectionState): void {
    this.state = s
    this.opts.onStateChange(s)
  }

  async connect(): Promise<void> {
    try {
      const { connectionInfo, stream } = this.opts
      const { host, ports } = connectionInfo

      // ── Pairing ─────────────────────────────────────────────────────────
      this.setState('pairing')
      const uniqueId = getOrCreateUniqueId()
      const pairing = new PairingClient(host, ports.http, uniqueId)

      // Wire up auto-PIN: IWA sends PIN to worker, worker POSTs to Sunshine
      pairing.onPin = async (pin: string) => {
        const res = await fetch(
          `${this.opts.workerUrl}/api/sessions/${this.opts.sessionId}/pin`,
          {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${this.opts.authToken}`,
            },
            body: JSON.stringify({ pin }),
          },
        )
        if (!res.ok) {
          const err = await res.json().catch(() => ({ error: 'unknown' })) as { error: string }
          throw new Error(`PIN submission failed: ${err.error}`)
        }
      }

      try {
        await pairing.pair()
      } catch (err) {
        console.warn('[pairing] skipping (may already be paired):', err)
      }

      // ── Launch app ───────────────────────────────────────────────────────
      this.setState('launching')
      const launch = await pairing.launch(0 /* Steam Big Picture */, stream)

      // ── RTSP control ─────────────────────────────────────────────────────
      this.setState('connecting')
      this.rtsp = new RtspClient(host, ports.control)
      await this.rtsp.connect()
      await this.rtsp.setup(launch, stream)
      await this.rtsp.play()

      // ── UDP video stream ─────────────────────────────────────────────────
      this.videoUdp = await UdpTransport.create({
        remoteAddress: host,
        remotePort: ports.video,
      })
      const ping = new Uint8Array([0x50, 0x49, 0x4E, 0x47]) // "PING"
      await this.videoUdp.send(ping)

      this.stopReceiving = this.videoUdp.startReceiving(
        pkt => this.depacketizer.processPacket(pkt.data),
        err => this.handleStreamError(err),
      )

      // ── Audio ────────────────────────────────────────────────────────────
      this.audioUdp = await UdpTransport.create({
        remoteAddress: host, remotePort: ports.audio,
      })
      await this.audioUdp.send(ping)

      // ── Input ────────────────────────────────────────────────────────────
      this.inputUdp = await UdpTransport.create({
        remoteAddress: host, remotePort: ports.control,
      })
      this.keyboard.attach(this.opts.canvas)
      this.mouse.attach()
      this.opts.canvas.focus()

      this.setState('streaming')
      this.opts.canvas.style.display = 'block'
    } catch (err) {
      this.setState('error')
      this.opts.onError(err instanceof Error ? err : new Error(String(err)))
    }
  }

  private async sendInput(packet: Uint8Array): Promise<void> {
    if (this.state !== 'streaming') return
    await this.inputUdp?.send(packet).catch(() => {})
  }

  private handleStreamError(err: Error): void {
    if (this.state !== 'streaming') return
    this.opts.onError(err)
    void this.disconnect()
  }

  async disconnect(): Promise<void> {
    this.setState('disconnected')
    this.keyboard.detach()
    this.mouse.detach()
    this.stopReceiving?.()
    await Promise.allSettled([
      this.rtsp?.teardown(),
      this.videoUdp?.close(),
      this.audioUdp?.close(),
      this.inputUdp?.close(),
    ])
    await this.decoder.close()
    this.renderer.destroy()
    this.opts.canvas.style.display = 'none'
  }
}

const UNIQUE_ID_KEY = 'moonlight:uniqueId'
function getOrCreateUniqueId(): string {
  let id = localStorage.getItem(UNIQUE_ID_KEY)
  if (!id) {
    id = crypto.randomUUID().replace(/-/g, '').slice(0, 16).toUpperCase()
    localStorage.setItem(UNIQUE_ID_KEY, id)
  }
  return id
}
