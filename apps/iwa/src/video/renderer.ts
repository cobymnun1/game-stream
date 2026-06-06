// Canvas renderer — paints decoded VideoFrames as fast as the display allows.
// Uses requestVideoFrameCallback when available, falls back to rAF.

export class CanvasRenderer {
  private ctx: CanvasRenderingContext2D
  private canvas: HTMLCanvasElement
  private pendingFrame: VideoFrame | null = null
  private rafId: number | null = null

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

        this.ctx.drawImage(frame, 0, 0)
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
