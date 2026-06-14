// Canvas renderer — paints decoded VideoFrames as fast as the display allows.
// Uses requestVideoFrameCallback when available, falls back to rAF.

const RDBG_EP = 'http://127.0.0.1:7458/ingest/a70defe2-9a92-40ab-8b63-4a3e87de3fac'
function rdbg(hypothesisId: string, location: string, message: string, data: Record<string, unknown>): void {
  // #region agent log
  fetch(RDBG_EP, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Debug-Session-Id': '31fcc6' }, body: JSON.stringify({ sessionId: '31fcc6', runId: 'video-render', hypothesisId, location, message, data, timestamp: Date.now() }) }).catch(() => {})
  // #endregion
}

export class CanvasRenderer {
  private ctx: CanvasRenderingContext2D
  private canvas: HTMLCanvasElement
  private pendingFrame: VideoFrame | null = null
  private rafId: number | null = null
  // #region agent log
  private drawCount = 0
  private prevPixelHash = -1
  private samePixelRun = 0
  // #endregion

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas
    const ctx = canvas.getContext('2d', { alpha: false })
    if (!ctx) throw new Error('Could not get 2D canvas context')
    this.ctx = ctx
    this.startRenderLoop()
  }

  private startRenderLoop(): void {
    const render = () => {
      if (this.pendingFrame) {
        const frame = this.pendingFrame
        this.pendingFrame = null

        if (
          this.canvas.width !== frame.displayWidth ||
          this.canvas.height !== frame.displayHeight
        ) {
          this.canvas.width = frame.displayWidth
          this.canvas.height = frame.displayHeight
        }

        try {
          this.ctx.drawImage(frame, 0, 0)
          // #region agent log
          this.drawCount++
          if (this.drawCount === 1 || this.drawCount % 60 === 0) {
            let hash = -1
            let center: number[] | null = null
            try {
              // Hash a 3x3 grid spread across the frame so we detect motion
              // anywhere, not just at two points that might sit in static areas.
              hash = 0
              for (let gx = 1; gx <= 3; gx++) {
                for (let gy = 1; gy <= 3; gy++) {
                  const x = Math.floor((this.canvas.width * gx) / 4)
                  const y = Math.floor((this.canvas.height * gy) / 4)
                  const px = this.ctx.getImageData(x, y, 1, 1).data
                  hash = (hash * 31 + px[0] + px[1] * 7 + px[2] * 13) >>> 0
                  if (gx === 2 && gy === 2) center = [px[0], px[1], px[2]]
                }
              }
            } catch (e) { rdbg('HV5', 'video/renderer.ts:render', 'pixel read err', { err: String(e) }); }
            const changed = hash !== this.prevPixelHash
            if (changed) this.samePixelRun = 0; else this.samePixelRun++
            this.prevPixelHash = hash
            rdbg('H-REND', 'video/renderer.ts:render', 'drawImage+pixelgrid', { n: this.drawCount, fw: frame.displayWidth, fh: frame.displayHeight, cw: this.canvas.width, ch: this.canvas.height, gridHash: hash, changedFromPrev: changed, samePixelRun: this.samePixelRun, center })
          }
          // #endregion
        } catch (err) {
          // #region agent log
          rdbg('HV4', 'video/renderer.ts:render', 'drawImage threw', { message: err instanceof Error ? err.message : String(err) })
          // #endregion
        }
        frame.close()
      }
      this.rafId = requestAnimationFrame(render)
    }
    this.rafId = requestAnimationFrame(render)
  }

  render(frame: VideoFrame): void {
    // Discard the previous pending frame if we haven't rendered it yet
    this.pendingFrame?.close()
    this.pendingFrame = frame
  }

  destroy(): void {
    if (this.rafId !== null) cancelAnimationFrame(this.rafId)
    this.pendingFrame?.close()
    this.pendingFrame = null
  }
}
