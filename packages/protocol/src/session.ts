import { loadMoonlightModule } from './loader.js'
import type {
  InputSink,
  KeyboardAction,
  MoonlightSessionOptions,
  MoonlightWasmModule,
  MouseButtonAction,
} from './types.js'

const KEY_ACTION_DOWN = 0x03
const KEY_ACTION_UP = 0x04
const BUTTON_ACTION_PRESS = 0x07
const BUTTON_ACTION_RELEASE = 0x08

const VIDEO_FORMATS = {
  h264: 0x0001,
  hevc: 0x0100,
  av1: 0x1000,
} as const
const DEBUG_ENDPOINT = 'http://127.0.0.1:7458/ingest/a70defe2-9a92-40ab-8b63-4a3e87de3fac'

function debugLog(hypothesisId: string, location: string, message: string, data: Record<string, unknown>): void {
  // #region agent log
  fetch(DEBUG_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Debug-Session-Id': '31fcc6' },
    body: JSON.stringify({
      sessionId: '31fcc6',
      runId: 'stream-disconnect',
      hypothesisId,
      location,
      message,
      data,
      timestamp: Date.now(),
    }),
  }).catch(() => {})
  // #endregion
}

export class MoonlightSession implements InputSink {
  private constructor(
    private readonly module: MoonlightWasmModule,
    private readonly opts: MoonlightSessionOptions,
  ) {}

  private started = false

  static async create(opts: MoonlightSessionOptions): Promise<MoonlightSession> {
    const loadOptions = {
      transport: opts.transport,
    } as Parameters<typeof loadMoonlightModule>[0]
    if (opts.moduleFactory) loadOptions.moduleFactory = opts.moduleFactory
    if (opts.moduleUrl) loadOptions.moduleUrl = opts.moduleUrl
    if (opts.callbacks) loadOptions.callbacks = opts.callbacks
    if (opts.locateFile) loadOptions.locateFile = opts.locateFile

    const module = await loadMoonlightModule(loadOptions)

    return new MoonlightSession(module, opts)
  }

  async start(): Promise<void> {
    if (this.started) throw new Error('Moonlight session has already been started')

    // ml_start_connection now spawns a worker thread for the whole handshake
    // (its socket/crypto I/O is proxied back here to the main thread), so it
    // returns immediately and the real outcome arrives via onConnectionResult.
    const resultPromise = this.awaitConnectionResult()

    const allocations = new Allocations(this.module)
    try {
      const address = allocations.string(this.opts.server.address)
      const appVersion = allocations.optionalString(this.opts.server.appVersion)
      const gfeVersion = allocations.optionalString(this.opts.server.gfeVersion)
      const rtspSessionUrl = allocations.string(this.opts.launch.rtspSessionUrl)
      const riKey = allocations.bytes(this.opts.launch.riKey)
      const riIv = allocations.bytes(this.opts.launch.riIv ?? deriveRiIv(this.opts.launch.riKeyId))

      debugLog('H50', 'packages/protocol/src/session.ts:start', 'Calling ml_start_connection (spawns worker)', {
        address: this.opts.server.address,
        appVersion: this.opts.server.appVersion ?? '',
        gfeVersion: this.opts.server.gfeVersion ?? '',
        rtspSessionUrl: this.opts.launch.rtspSessionUrl,
        codecModeSupport: this.opts.server.codecModeSupport ?? 0,
        width: this.opts.stream.width,
        height: this.opts.stream.height,
        fps: this.opts.stream.fps,
        bitrateKbps: this.opts.stream.bitrateKbps,
        audioChannels: this.opts.stream.audioChannels,
        codec: this.opts.stream.codec,
        riKeyLength: riKey.length,
        riIvLength: riIv.length,
      })
      this.module.ccall('ml_start_connection', 'number', [
        'number',
        'number',
        'number',
        'number',
        'number',
        'number',
        'number',
        'number',
        'number',
        'number',
        'number',
        'number',
        'number',
        'number',
        'number',
        'number',
        'number',
      ], [
        address,
        appVersion,
        gfeVersion,
        rtspSessionUrl,
        this.opts.server.codecModeSupport ?? 0,
        this.opts.stream.width,
        this.opts.stream.height,
        this.opts.stream.fps,
        this.opts.stream.bitrateKbps,
        this.opts.stream.audioChannels,
        VIDEO_FORMATS[this.opts.stream.codec],
        1024,
        2,
        riKey.ptr,
        riKey.length,
        riIv.ptr,
        riIv.length,
      ])
    } finally {
      // C deep-copies every parameter synchronously before returning, so the
      // JS-side buffers are safe to free now even though the worker runs later.
      allocations.freeAll()
    }

    const result = await resultPromise
    debugLog('H50', 'packages/protocol/src/session.ts:start', 'ml_connection_result received', {
      result,
      started: this.started,
    })
    if (result !== 0) throw new Error(`LiStartConnection failed with code ${result}`)
    this.started = true
  }

  // Resolves with the LiStartConnection result code delivered asynchronously by
  // the connection worker through the (main-thread) onConnectionResult callback.
  private awaitConnectionResult(): Promise<number> {
    return new Promise<number>(resolve => {
      const callbacks = (this.module.moonlightCallbacks ??= {})
      const previous = callbacks.onConnectionResult
      callbacks.onConnectionResult = (code: number) => {
        if (previous) callbacks.onConnectionResult = previous
        else delete callbacks.onConnectionResult
        previous?.(code)
        resolve(code)
      }
    })
  }

  stop(): void {
    this.module.ccall('ml_stop_connection', null, [], [])
    this.started = false
  }

  interrupt(): void {
    this.module.ccall('ml_interrupt_connection', null, [], [])
  }

  requestIdrFrame(): void {
    this.module.ccall('ml_request_idr_frame', null, [], [])
  }

  sendKeyboard(keyCode: number, action: KeyboardAction, modifiers = 0): void {
    const rawAction = action === 'down' ? KEY_ACTION_DOWN : KEY_ACTION_UP
    const ret = this.module.ccall('ml_send_keyboard', 'number', ['number', 'number', 'number'], [
      keyCode,
      rawAction,
      modifiers,
    ])
    // #region agent log
    fetch('http://127.0.0.1:7458/ingest/a70defe2-9a92-40ab-8b63-4a3e87de3fac',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'31fcc6'},body:JSON.stringify({sessionId:'31fcc6',runId:'input-tx',hypothesisId:'H-IN1',location:'session.ts:sendKeyboard',message:'LiSendKeyboardEvent ret',data:{keyCode,rawAction,ret},timestamp:Date.now()})}).catch(()=>{})
    // #endregion
  }

  sendMouseMove(deltaX: number, deltaY: number): void {
    const ret = this.module.ccall('ml_send_mouse_move', 'number', ['number', 'number'], [
      Math.round(deltaX),
      Math.round(deltaY),
    ])
    // #region agent log
    fetch('http://127.0.0.1:7458/ingest/a70defe2-9a92-40ab-8b63-4a3e87de3fac',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'31fcc6'},body:JSON.stringify({sessionId:'31fcc6',runId:'input-tx',hypothesisId:'H-IN1',location:'session.ts:sendMouseMove',message:'LiSendMouseMoveEvent ret',data:{dx:Math.round(deltaX),dy:Math.round(deltaY),ret},timestamp:Date.now()})}).catch(()=>{})
    // #endregion
  }

  sendMouseButton(button: number, action: MouseButtonAction): void {
    const rawAction = action === 'down' ? BUTTON_ACTION_PRESS : BUTTON_ACTION_RELEASE
    const ret = this.module.ccall('ml_send_mouse_button', 'number', ['number', 'number'], [button, rawAction])
    // #region agent log
    fetch('http://127.0.0.1:7458/ingest/a70defe2-9a92-40ab-8b63-4a3e87de3fac',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'31fcc6'},body:JSON.stringify({sessionId:'31fcc6',runId:'input-tx',hypothesisId:'H-IN1',location:'session.ts:sendMouseButton',message:'LiSendMouseButtonEvent ret',data:{button,rawAction,ret},timestamp:Date.now()})}).catch(()=>{})
    // #endregion
  }

  sendMouseScroll(wheelDelta: number): void {
    this.module.ccall('ml_send_high_res_scroll', 'number', ['number'], [Math.round(wheelDelta)])
  }

  async getStats(): Promise<{ estimatedRttMs: number; estimatedRttVarianceMs: number } | null> {
    const rtt = this.module._malloc(4)
    const variance = this.module._malloc(4)
    try {
      const ok = this.module.ccall('ml_get_estimated_rtt', 'number', ['number', 'number'], [rtt, variance])
      if (ok !== 1) return null
      const view = new DataView(this.module.HEAPU8.buffer)
      return {
        estimatedRttMs: view.getUint32(rtt, true),
        estimatedRttVarianceMs: view.getUint32(variance, true),
      }
    } finally {
      this.module._free(rtt)
      this.module._free(variance)
    }
  }

}

class Allocations {
  private ptrs: number[] = []

  constructor(private readonly module: MoonlightWasmModule) {}

  string(value: string): number {
    const length = this.lengthBytesUtf8(value) + 1
    const ptr = this.module._malloc(length)
    this.ptrs.push(ptr)
    this.writeString(value, ptr, length)
    return ptr
  }

  optionalString(value: string | undefined): number {
    return value && value.length > 0 ? this.string(value) : 0
  }

  bytes(value: Uint8Array): { ptr: number; length: number } {
    const ptr = this.module._malloc(value.length)
    this.ptrs.push(ptr)
    this.module.HEAPU8.set(value, ptr)
    return { ptr, length: value.length }
  }

  freeAll(): void {
    for (const ptr of this.ptrs.splice(0)) this.module._free(ptr)
  }

  private lengthBytesUtf8(value: string): number {
    if (this.module.lengthBytesUTF8) return this.module.lengthBytesUTF8(value)
    return new TextEncoder().encode(value).length
  }

  private writeString(value: string, ptr: number, length: number): void {
    if (this.module.stringToUTF8) {
      this.module.stringToUTF8(value, ptr, length)
      return
    }

    const encoded = new TextEncoder().encode(value)
    this.module.HEAPU8.set(encoded.slice(0, length - 1), ptr)
    this.module.HEAPU8[ptr + length - 1] = 0
  }
}

function deriveRiIv(riKeyId: number): Uint8Array {
  const iv = new Uint8Array(16)
  new DataView(iv.buffer).setUint32(0, riKeyId >>> 0, false)
  return iv
}
