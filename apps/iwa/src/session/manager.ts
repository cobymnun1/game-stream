import {
  MoonlightSession,
  type EncodedVideoFrame,
  type ServerInfo,
  type TransportFactory,
} from '@basehack/protocol'
import { PairingClient } from '../pairing/client.ts'
import { keysFromPem } from '../pairing/crypto.ts'
import { TcpTransport } from '../transport/tcp.ts'
import { UdpTransport } from '../transport/udp.ts'
import { VideoStreamDecoder } from '../video/decoder.ts'
import { CanvasRenderer } from '../video/renderer.ts'
import { AudioPlayer } from '../audio/player.ts'
import { KeyboardInput } from '../input/keyboard.ts'
import { MouseInput } from '../input/mouse.ts'
import type { ConnectionState, StreamConfig } from '../types/protocol.ts'
import type { ConnectionInfo } from '../types/connection.ts'

const DEFAULT_STREAM: StreamConfig = {
  width: 1920, height: 1080, fps: 60,
  bitrateKbps: 20000, codec: 'h264', audioChannels: 2,
}
const DEBUG_ENDPOINT = 'http://127.0.0.1:7458/ingest/a70defe2-9a92-40ab-8b63-4a3e87de3fac'

function debugLog(hypothesisId: string, location: string, message: string, data: Record<string, unknown>): void {
  // #region agent log
  fetch(DEBUG_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Debug-Session-Id': '31fcc6' },
    body: JSON.stringify({
      sessionId: '31fcc6',
      runId: 'wasm-loader-url',
      hypothesisId,
      location,
      message,
      data,
      timestamp: Date.now(),
    }),
  }).catch(() => {})
  // #endregion
}

export interface SessionOptions {
  // Session ID from the worker or manual dev flow.
  sessionId: string
  // Worker base URL for production session APIs.
  workerUrl: string
  // Auth token for worker API calls.
  authToken: string
  // Connection info returned by the worker when session is 'ready'.
  connectionInfo: ConnectionInfo
  stream?: Partial<StreamConfig>
  canvas: HTMLCanvasElement
  onPin?: (pin: string) => Promise<void>
  onStateChange: (state: ConnectionState) => void
  onError: (err: Error) => void
  // When set, pair() is skipped and this pre-paired identity is used directly.
  prePairedIdentity?: {
    uniqueId: string
    certPem: string
    privateKeyPem: string
  }
}

export class SessionManager {
  private opts: SessionOptions & { stream: StreamConfig }
  private state: ConnectionState = 'idle'

  private protocol?: MoonlightSession
  private decoder: VideoStreamDecoder
  private renderer: CanvasRenderer
  private audio: AudioPlayer
  private keyboard: KeyboardInput
  private mouse: MouseInput
  private startPromise?: Promise<void>

  constructor(opts: SessionOptions) {
    this.opts = { ...opts, stream: { ...DEFAULT_STREAM, ...opts.stream } }

    this.renderer = new CanvasRenderer(opts.canvas)
    this.decoder = new VideoStreamDecoder()
    this.decoder.onFrame(frame => this.renderer.render(frame))
    this.decoder.onError(err => console.warn('[VideoDecoder]', err))
    this.audio = new AudioPlayer()
    this.keyboard = new KeyboardInput(event => {
      // #region agent log
      fetch('http://127.0.0.1:7458/ingest/a70defe2-9a92-40ab-8b63-4a3e87de3fac', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Debug-Session-Id': '31fcc6' }, body: JSON.stringify({ sessionId: '31fcc6', runId: 'keyboard-dbg', hypothesisId: 'H82', location: 'manager.ts:keyboard.onInput', message: 'keyboard onInput callback', data: { state: this.state, keyCode: event.keyCode, action: event.action, hasProtocol: !!this.protocol }, timestamp: Date.now() }) }).catch(() => {})
      // #endregion
      if (this.state !== 'streaming') return
      // Resume audio on a real key gesture (Chrome autoplay policy). Idempotent.
      this.audio.resume()
      this.protocol?.sendKeyboard(event.keyCode, event.action, event.modifiers)
    })
    this.mouse = new MouseInput(opts.canvas, event => {
      if (this.state !== 'streaming') return
      // Resume audio on a real mouse gesture (Chrome autoplay policy). Idempotent.
      this.audio.resume()
      if (event.type === 'move') this.protocol?.sendMouseMove(event.deltaX, event.deltaY)
      if (event.type === 'button') this.protocol?.sendMouseButton(event.button, event.action)
      if (event.type === 'scroll') this.protocol?.sendMouseScroll(event.wheelDelta)
    })
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
      const prePaired = this.opts.prePairedIdentity
      const uniqueId = prePaired?.uniqueId ?? getOrCreateUniqueId()
      const pairing = new PairingClient(host, ports.http, uniqueId)

      pairing.onPin = this.opts.onPin ?? null
      pairing.onPairingStep = step => console.info(`[pairing] ${step}`)

      const serverInfo = await pairing.getServerInfo().catch(err => {
        console.warn('[pairing] serverinfo unavailable:', err)
        return { appVersion: '', codecModeSupport: 0, pairStatus: '0' }
      })

      if (prePaired) {
        // Identity was established out-of-band (e.g. via pairing-api); skip pair().
        pairing.injectKeys(keysFromPem(prePaired.certPem, prePaired.privateKeyPem))
        console.info('[pairing] using pre-paired identity, skipping pair()')
      } else {
        try {
          await pairing.pair()
        } catch (err) {
          if (serverInfo.pairStatus === '1') {
            console.warn('[pairing] skipping failed pair attempt because server reported this client as already paired:', err)
          } else {
            throw err
          }
        }
      }

      // ── Launch app ───────────────────────────────────────────────────────
      this.setState('launching')
      const appId = await this.selectLaunchApp(pairing)
      const launch = await pairing.launch(appId, stream)

      // ── moonlight-common-c WASM core ─────────────────────────────────────
      this.setState('connecting')
      const protocolServer: ServerInfo = { address: host }
      if (serverInfo.appVersion) protocolServer.appVersion = serverInfo.appVersion
      if (serverInfo.codecModeSupport) protocolServer.codecModeSupport = serverInfo.codecModeSupport

      debugLog('H14,H15,H16,H17', 'apps/iwa/src/session/manager.ts:connect', 'Creating MoonlightSession', {
        host,
        rtspSessionUrl: launch.rtspSessionUrl,
        sessionTokenLength: launch.sessionToken.length,
        codec: stream.codec,
        width: stream.width,
        height: stream.height,
        fps: stream.fps,
      })
      this.protocol = await MoonlightSession.create({
        transport: createDirectSocketsTransport(),
        moduleUrl: '/moonlight.js',
        locateFile: path => `/${path}`,
        server: protocolServer,
        stream,
        launch: {
          sessionToken: launch.sessionToken,
          rtspSessionUrl: launch.rtspSessionUrl,
          riKey: launch.riKey,
          riKeyId: launch.riKeyId,
          riIv: launch.riIv,
        },
        callbacks: {
          onConnectionStarted: () => {
            debugLog('H15', 'apps/iwa/src/session/manager.ts:onConnectionStarted', 'Moonlight connection started callback fired', {})
            this.setState('streaming')
            this.opts.canvas.style.display = 'block'
          },
          onConnectionTerminated: errorCode => this.handleConnectionTerminated(errorCode),
          onStage: event => {
            debugLog('H14,H15,H16,H17', 'apps/iwa/src/session/manager.ts:onStage', 'Moonlight connection stage event', {
              stage: event.stage,
              phase: event.phase,
              errorCode: event.errorCode ?? null,
              name: event.name ?? '',
            })
            if (event.phase === 'failed') {
              console.warn('[moonlight-common-c] stage failed:', event)
            }
          },
          onVideoFrame: frame => this.decodeVideoFrame(frame),
          onAudioFormat: format => this.audio.configure(format),
          onAudioPacket: packet => this.audio.enqueue(packet.data),
          onError: err => this.handleStreamError(err),
        },
      })
      debugLog('H13', 'apps/iwa/src/session/manager.ts:connect', 'Created MoonlightSession with explicit public WASM module URLs', {
        moduleUrl: '/moonlight.js',
        wasmUrl: '/moonlight.wasm',
      })

      this.keyboard.attach(this.opts.canvas)
      this.mouse.attach()
      this.opts.canvas.focus()

      debugLog('H14,H15,H16,H17', 'apps/iwa/src/session/manager.ts:connect', 'Starting MoonlightSession', {})
      this.startPromise = this.protocol.start()
        .then(() => {
          debugLog('H14', 'apps/iwa/src/session/manager.ts:startPromise', 'MoonlightSession.start resolved', {
            state: this.state,
          })
          if (this.state === 'connecting') this.setState('streaming')
        })
        .catch(err => {
          debugLog('H14,H17', 'apps/iwa/src/session/manager.ts:startPromise', 'MoonlightSession.start rejected', {
            state: this.state,
            message: err instanceof Error ? err.message : String(err),
            name: err instanceof Error ? err.name : typeof err,
          })
          this.handleStreamError(err instanceof Error ? err : new Error(String(err)))
        })
    } catch (err) {
      this.setState('error')
      this.opts.onError(err instanceof Error ? err : new Error(String(err)))
    }
  }

  private videoFrameCount = 0
  private decodeVideoFrame(frame: EncodedVideoFrame): void {
    // #region agent log
    this.videoFrameCount++
    if (this.videoFrameCount === 1 || this.videoFrameCount % 120 === 0) {
      debugLog('H53', 'apps/iwa/src/session/manager.ts:decodeVideoFrame', 'Video frame received from WASM core', {
        count: this.videoFrameCount,
        type: frame.type,
        frameIndex: frame.frameIndex,
        length: frame.data.length,
      })
    }
    // #endregion
    this.decoder.decode({
      data: frame.data,
      frameIndex: frame.frameIndex,
      type: frame.type,
    }, this.opts.stream.width, this.opts.stream.height)
  }

  private handleConnectionTerminated(errorCode: number): void {
    debugLog('H15', 'apps/iwa/src/session/manager.ts:handleConnectionTerminated', 'Moonlight connection terminated callback fired', {
      state: this.state,
      errorCode,
    })
    if (this.state === 'disconnected') return
    if (errorCode !== 0) {
      this.opts.onError(new Error(`Moonlight connection terminated with code ${errorCode}`))
    }
    void this.disconnect()
  }

  private async selectLaunchApp(pairing: PairingClient): Promise<number> {
    try {
      const apps = await pairing.getApps()
      const preferred = apps.find(app => app.id === 730)
        ?? apps.find(app => /steam|big picture/i.test(app.title))
        ?? apps[0]

      if (preferred) {
        console.info(`[session] launching Sunshine app ${preferred.id}: ${preferred.title}`)
        return preferred.id
      }
    } catch (err) {
      console.warn('[session] app list unavailable; falling back to app id 0:', err)
    }

    return 0
  }

  private handleStreamError(err: Error): void {
    debugLog('H14,H17', 'apps/iwa/src/session/manager.ts:handleStreamError', 'Handling stream error', {
      state: this.state,
      message: err.message,
      name: err.name,
    })
    if (this.state !== 'streaming' && this.state !== 'connecting') return
    this.opts.onError(err)
    void this.disconnect()
  }

  async disconnect(): Promise<void> {
    debugLog('H14,H15,H17', 'apps/iwa/src/session/manager.ts:disconnect', 'Disconnect called', {
      previousState: this.state,
      hasProtocol: Boolean(this.protocol),
      hasStartPromise: Boolean(this.startPromise),
    })
    this.setState('disconnected')
    this.keyboard.detach()
    this.mouse.detach()
    this.protocol?.stop()
    await this.startPromise?.catch(() => {})
    await this.decoder.close()
    await this.audio.close()
    this.renderer.destroy()
    this.opts.canvas.style.display = 'none'
  }
}

function createDirectSocketsTransport(): TransportFactory {
  return {
    connectTcp: (host, port) => TcpTransport.connect(host, port),
    createUdp: options => {
      const udpOptions: { localPort?: number; remoteAddress?: string; remotePort?: number } = {}
      if (options.localPort !== undefined) udpOptions.localPort = options.localPort
      if (options.remoteAddress !== undefined) udpOptions.remoteAddress = options.remoteAddress
      if (options.remotePort !== undefined) udpOptions.remotePort = options.remotePort
      return UdpTransport.create(udpOptions)
    },
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
