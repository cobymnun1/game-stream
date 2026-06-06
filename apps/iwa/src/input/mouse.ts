import {
  encodeMouseMoveRel,
  encodeMouseButtonDown,
  encodeMouseButtonUp,
  encodeMouseScroll,
  browserButtonToMoonlight,
} from './packets.ts'

export class MouseInput {
  private canvas: HTMLCanvasElement
  private onPacket: (data: Uint8Array) => void
  private attached = false

  constructor(canvas: HTMLCanvasElement, onPacket: (data: Uint8Array) => void) {
    this.canvas = canvas
    this.onPacket = onPacket
  }

  async requestPointerLock(): Promise<void> {
    await this.canvas.requestPointerLock()
  }

  attach(): void {
    if (this.attached) return
    this.canvas.addEventListener('mousemove', this.handleMove)
    this.canvas.addEventListener('mousedown', this.handleButtonDown)
    this.canvas.addEventListener('mouseup', this.handleButtonUp)
    this.canvas.addEventListener('wheel', this.handleWheel, { passive: false })
    this.canvas.addEventListener('contextmenu', this.suppressContext)
    document.addEventListener('pointerlockchange', this.handlePointerLockChange)
    this.attached = true
  }

  detach(): void {
    if (!this.attached) return
    this.canvas.removeEventListener('mousemove', this.handleMove)
    this.canvas.removeEventListener('mousedown', this.handleButtonDown)
    this.canvas.removeEventListener('mouseup', this.handleButtonUp)
    this.canvas.removeEventListener('wheel', this.handleWheel)
    this.canvas.removeEventListener('contextmenu', this.suppressContext)
    document.removeEventListener('pointerlockchange', this.handlePointerLockChange)
    this.attached = false
  }

  private handleMove = (e: Event): void => {
    const event = e as MouseEvent
    // Only send relative movement — requires pointer lock for accurate deltas
    if (document.pointerLockElement !== this.canvas) return
    if (event.movementX === 0 && event.movementY === 0) return
    this.onPacket(encodeMouseMoveRel(event.movementX, event.movementY))
  }

  private handleButtonDown = (e: Event): void => {
    const event = e as MouseEvent
    e.preventDefault()
    const btn = browserButtonToMoonlight(event.button)
    this.onPacket(encodeMouseButtonDown(btn))

    // Request pointer lock on first click if not already locked
    if (document.pointerLockElement !== this.canvas) {
      void this.requestPointerLock()
    }
  }

  private handleButtonUp = (e: Event): void => {
    const event = e as MouseEvent
    e.preventDefault()
    const btn = browserButtonToMoonlight(event.button)
    this.onPacket(encodeMouseButtonUp(btn))
  }

  private handleWheel = (e: Event): void => {
    const event = e as WheelEvent
    e.preventDefault()
    // Convert to Windows WHEEL_DELTA (120 per notch)
    const delta = event.deltaMode === WheelEvent.DOM_DELTA_LINE
      ? event.deltaY * -120
      : event.deltaMode === WheelEvent.DOM_DELTA_PAGE
        ? event.deltaY * -120 * 10
        : -Math.sign(event.deltaY) * 120
    this.onPacket(encodeMouseScroll(Math.round(delta)))
  }

  private handlePointerLockChange = (): void => {
    // Pointer lock dropped (e.g. user pressed Escape) — stop sending moves
    if (document.pointerLockElement !== this.canvas) {
      // Could show a "click to recapture" overlay here
    }
  }

  private suppressContext = (e: Event): void => e.preventDefault()
}
