import type { VideoFrame as MoonlightFrame } from '../types/protocol.ts'

// WebCodecs VideoDecoder — hardware-accelerated H.264/HEVC decode in the browser.
// Frames arrive as EncodedVideoChunks → decoded VideoFrames → renderer.

export class VideoStreamDecoder extends EventTarget {
  private decoder!: VideoDecoder
  private configured = false
  private pendingConfig: VideoDecoderConfig | null = null

  constructor() {
    super()
    this.initDecoder()
  }

  private initDecoder(): void {
    this.decoder = new VideoDecoder({
      output: (frame) => {
        this.dispatchEvent(new CustomEvent<VideoFrame>('frame', { detail: frame }))
      },
      error: (err) => {
        this.dispatchEvent(new CustomEvent<Error>('error', { detail: err }))
        // Attempt decoder reset on error
        this.configured = false
        this.initDecoder()
      },
    })
  }

  configure(config: VideoDecoderConfig): void {
    this.pendingConfig = config
    this.decoder.configure(config)
    this.configured = true
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

    if (this.decoder.state !== 'configured') return

    const chunk = new EncodedVideoChunk({
      type: frame.type === 'idr' ? 'key' : 'delta',
      timestamp: frame.frameIndex * (1_000_000 / 60), // approximate PTS
      data: frame.data,
    })

    try {
      this.decoder.decode(chunk)
    } catch (err) {
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
