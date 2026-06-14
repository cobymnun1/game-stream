import type { VideoFrame as MoonlightFrame } from '../types/protocol.ts'

// WebCodecs VideoDecoder — hardware-accelerated H.264/HEVC decode in the browser.
// Frames arrive as EncodedVideoChunks → decoded VideoFrames → renderer.

const DBG_EP = 'http://127.0.0.1:7458/ingest/a70defe2-9a92-40ab-8b63-4a3e87de3fac'
function vdbg(hypothesisId: string, location: string, message: string, data: Record<string, unknown>): void {
  // #region agent log
  fetch(DBG_EP, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Debug-Session-Id': '31fcc6' }, body: JSON.stringify({ sessionId: '31fcc6', runId: 'video-decode', hypothesisId, location, message, data, timestamp: Date.now() }) }).catch(() => {})
  // #endregion
}

export class VideoStreamDecoder extends EventTarget {
  private decoder!: VideoDecoder
  private configured = false
  private pendingConfig: VideoDecoderConfig | null = null
  // #region agent log
  private outCount = 0
  private errCount = 0
  private decAttempt = 0
  private prevHash = -1
  private sameHashRun = 0
  private prevOutHash = -1
  private sameOutRun = 0
  private probeCanvas: OffscreenCanvas | null = null
  private probeCtx: OffscreenCanvasRenderingContext2D | null = null
  // #endregion

  constructor() {
    super()
    this.initDecoder()
  }

  private initDecoder(): void {
    this.decoder = new VideoDecoder({
      output: (frame) => {
        // #region agent log
        this.outCount++
        if (this.outCount === 1 || this.outCount % 60 === 0) {
          // Hash the ACTUAL decoded pixels (independent of the renderer) by
          // drawing the output VideoFrame to a tiny offscreen canvas. This
          // proves whether the decoder itself emits varying images.
          let outHash = -1
          let fmt: string | null = null
          try {
            if (!this.probeCanvas) {
              this.probeCanvas = new OffscreenCanvas(64, 36)
              this.probeCtx = this.probeCanvas.getContext('2d', { willReadFrequently: true })
            }
            fmt = frame.format ?? null
            this.probeCtx!.drawImage(frame, 0, 0, 64, 36)
            const d = this.probeCtx!.getImageData(0, 0, 64, 36).data
            outHash = 0
            for (let i = 0; i < d.length; i += 4) outHash = (outHash * 31 + d[i] + d[i + 1] * 7 + d[i + 2] * 13) >>> 0
          } catch (e) { vdbg('H-OUT', 'video/decoder.ts:output', 'probe draw err', { err: String(e) }) }
          const changed = outHash !== this.prevOutHash
          if (changed) this.sameOutRun = 0; else this.sameOutRun++
          this.prevOutHash = outHash
          vdbg('H-OUT', 'video/decoder.ts:output', 'decoded frame pixel hash', { outCount: this.outCount, ts: frame.timestamp, w: frame.displayWidth, h: frame.displayHeight, codedW: frame.codedWidth, codedH: frame.codedHeight, format: fmt, outHash, changedFromPrev: changed, sameOutRun: this.sameOutRun })
        }
        // #endregion
        this.dispatchEvent(new CustomEvent<VideoFrame>('frame', { detail: frame }))
      },
      error: (err) => {
        // #region agent log
        this.errCount++
        vdbg('HV1', 'video/decoder.ts:error', 'decoder error callback', { errCount: this.errCount, message: err instanceof Error ? err.message : String(err), state: this.decoder.state })
        // #endregion
        this.dispatchEvent(new CustomEvent<Error>('error', { detail: err }))
        // Attempt decoder reset on error
        this.configured = false
        this.initDecoder()
      },
    })
  }

  configure(config: VideoDecoderConfig): void {
    this.pendingConfig = config
    // #region agent log
    vdbg('HV3', 'video/decoder.ts:configure', 'configuring decoder', { codec: config.codec, codedWidth: config.codedWidth ?? null, codedHeight: config.codedHeight ?? null })
    // #endregion
    this.decoder.configure(config)
    this.configured = true
    // #region agent log
    vdbg('HV3', 'video/decoder.ts:configure', 'decoder configured', { state: this.decoder.state })
    // #endregion
  }

  // Auto-configure from the first IDR frame if not already configured
  private autoConfigureFromFrame(frame: MoonlightFrame, width: number, height: number): void {
    if (this.configured) return
    const config: VideoDecoderConfig = {
      codec: 'avc1.640033', // H.264 High Profile Level 5.1
      codedWidth: width,
      codedHeight: height,
      optimizeForLatency: true,
    }
    this.configure(config)
  }

  decode(frame: MoonlightFrame, width: number, height: number): void {
    if (frame.type === 'idr') {
      if (!this.configured) this.autoConfigureFromFrame(frame, width, height)
      // Flush decoder before IDR frames to clear reference frame buffers
      if (this.decoder.state === 'configured') this.decoder.flush().catch(() => {})
    }

    // #region agent log
    this.decAttempt++
    {
      const d = frame.data
      // DENSE checksum over every byte — the previous sparse (every-53rd-byte)
      // hash was unreliable and falsely reported identical frames. This detects
      // whether the reassembled frame fed to the decoder actually varies.
      let h = d.length
      for (let i = 0; i < d.length; i++) h = (h * 31 + d[i]) >>> 0
      const changed = h !== this.prevHash
      if (changed) this.sameHashRun = 0
      else this.sameHashRun++
      this.prevHash = h
      if (this.decAttempt === 1 || this.decAttempt % 60 === 0 || frame.type === 'idr') {
        const head: number[] = []
        for (let i = 0; i < Math.min(24, d.length); i++) head.push(d[i])
        vdbg('H-RE1', 'video/decoder.ts:decode', 'encoded frame dense hash', { n: this.decAttempt, type: frame.type, state: this.decoder.state, len: d.length, hash: h, changedFromPrev: changed, sameHashRun: this.sameHashRun, head })
      }
    }
    // #endregion

    if (this.decoder.state !== 'configured') return

    const chunk = new EncodedVideoChunk({
      type: frame.type === 'idr' ? 'key' : 'delta',
      timestamp: frame.frameIndex * (1_000_000 / 60), // approximate PTS
      data: frame.data,
    })

    try {
      this.decoder.decode(chunk)
    } catch (err) {
      // #region agent log
      vdbg('HV1', 'video/decoder.ts:decode', 'decode threw', { message: err instanceof Error ? err.message : String(err) })
      // #endregion
      // Frame decode errors are non-fatal — next IDR will recover
      console.warn('[VideoDecoder] decode error:', err)
    }
  }

  onFrame(handler: (frame: VideoFrame) => void): void {
    this.addEventListener('frame', (e) => {
      handler((e as CustomEvent<VideoFrame>).detail)
    })
  }

  onError(handler: (err: Error) => void): void {
    this.addEventListener('error', (e) => {
      handler((e as CustomEvent<Error>).detail)
    })
  }

  async flush(): Promise<void> {
    if (this.decoder.state === 'configured') await this.decoder.flush()
  }

  async close(): Promise<void> {
    if (this.decoder.state !== 'closed') this.decoder.close()
  }
}
