import type { MouseButtonAction } from '@basehack/protocol'

// #region agent log
function mouseDbg(hypothesisId: string, location: string, message: string, data: Record<string, unknown>): void {
  fetch('http://127.0.0.1:7458/ingest/a70defe2-9a92-40ab-8b63-4a3e87de3fac', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Debug-Session-Id': '31fcc6' },
    body: JSON.stringify({ sessionId: '31fcc6', runId: 'keyboard-dbg', hypothesisId, location, message, data, timestamp: Date.now() }),
  }).catch(() => {})
}
// #endregion

// Keyboard Lock API (not yet in lib.dom). Capturing system keys like Escape
// while in fullscreen requires this, otherwise Chrome reserves Escape to exit
// pointer lock and it can never be forwarded to the streamed game.
interface KeyboardLockApi {
  lock(keyCodes?: string[]): Promise<void>
  unlock(): void
}
type NavigatorWithKeyboard = Navigator & { keyboard?: KeyboardLockApi }

export type MouseInputEvent =
  | { type: 'move'; deltaX: number; deltaY: number }
  | { type: 'button'; button: number; action: MouseButtonAction }
  | { type: 'scroll'; wheelDelta: number }

export class MouseInput {
  private canvas: HTMLCanvasElement
  private onInput: (event: MouseInputEvent) => void
  private attached = false

  constructor(canvas: HTMLCanvasElement, onInput: (event: MouseInputEvent) => void) {
    this.canvas = canvas
    this.onInput = onInput
  }

  // Acquire full input capture in one user-gesture task: fullscreen + keyboard
  // lock (so Escape/system keys forward to the game) + pointer lock. All three
  // are fired synchronously so they share the click's transient activation.
  requestPointerLock(): void {
    const kb = (navigator as NavigatorWithKeyboard).keyboard
    // #region agent log
    mouseDbg('Hesc1', 'mouse.ts:requestPointerLock', 'requesting capture', {
      hasKeyboardApi: Boolean(kb),
      hasLock: typeof kb?.lock === 'function',
      alreadyFullscreen: Boolean(document.fullscreenElement),
    })
    // #endregion
    try {
      kb?.lock?.().then(
        () => mouseDbg('Hesc1', 'mouse.ts:requestPointerLock', 'keyboard.lock resolved', {}),
        (e: unknown) => mouseDbg('Hesc1', 'mouse.ts:requestPointerLock', 'keyboard.lock rejected', { err: String(e) }),
      )
    } catch (e) {
      mouseDbg('Hesc1', 'mouse.ts:requestPointerLock', 'keyboard.lock threw', { err: String(e) })
    }
    if (!document.fullscreenElement) {
      void this.canvas.requestFullscreen?.({ navigationUI: 'hide' }).catch(() => {})
    }
    const p = this.canvas.requestPointerLock() as unknown as Promise<void> | undefined
    if (p && typeof p.catch === 'function') p.catch(() => {})
  }

  attach(): void {
    if (this.attached) return
    this.canvas.addEventListener('mousemove', this.handleMove)
    this.canvas.addEventListener('mousedown', this.handleButtonDown)
    this.canvas.addEventListener('mouseup', this.handleButtonUp)
    this.canvas.addEventListener('wheel', this.handleWheel, { passive: false })
    this.canvas.addEventListener('contextmenu', this.suppressContext)
    document.addEventListener('pointerlockchange', this.handlePointerLockChange)
    document.addEventListener('fullscreenchange', this.handleFullscreenChange)
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
    document.removeEventListener('fullscreenchange', this.handleFullscreenChange)
    this.releaseCapture()
    this.attached = false
  }

  private releaseCapture(): void {
    try { (navigator as NavigatorWithKeyboard).keyboard?.unlock?.() } catch { /* noop */ }
    if (document.pointerLockElement === this.canvas) document.exitPointerLock()
    if (document.fullscreenElement) void document.exitFullscreen().catch(() => {})
  }

  private handleFullscreenChange = (): void => {
    // #region agent log
    mouseDbg('Hesc2', 'mouse.ts:handleFullscreenChange', 'fullscreenchange', {
      inFullscreen: Boolean(document.fullscreenElement),
      pointerLocked: document.pointerLockElement === this.canvas,
    })
    // #endregion
    // User held Escape to leave fullscreen — free the cursor + keyboard. The
    // stream keeps running; clicking the canvas re-acquires capture.
    if (!document.fullscreenElement) {
      try { (navigator as NavigatorWithKeyboard).keyboard?.unlock?.() } catch { /* noop */ }
      if (document.pointerLockElement === this.canvas) document.exitPointerLock()
    }
  }

  private handleMove = (e: Event): void => {
    const event = e as MouseEvent
    // Only send relative movement — requires pointer lock for accurate deltas
    if (document.pointerLockElement !== this.canvas) return
    if (event.movementX === 0 && event.movementY === 0) return
    this.onInput({ type: 'move', deltaX: event.movementX, deltaY: event.movementY })
  }

  private handleButtonDown = (e: Event): void => {
    const event = e as MouseEvent
    e.preventDefault()
    const btn = browserButtonToMoonlight(event.button)
    this.onInput({ type: 'button', button: btn, action: 'down' })

    // Request pointer lock on first click if not already locked
    if (document.pointerLockElement !== this.canvas) {
      void this.requestPointerLock()
    }
  }

  private handleButtonUp = (e: Event): void => {
    const event = e as MouseEvent
    e.preventDefault()
    const btn = browserButtonToMoonlight(event.button)
    this.onInput({ type: 'button', button: btn, action: 'up' })
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
    this.onInput({ type: 'scroll', wheelDelta: Math.round(delta) })
  }

  private handlePointerLockChange = (): void => {
    // Pointer lock dropped (e.g. user pressed Escape) — stop sending moves
    if (document.pointerLockElement !== this.canvas) {
      // Could show a "click to recapture" overlay here
    }
  }

  private suppressContext = (e: Event): void => e.preventDefault()
}

function browserButtonToMoonlight(button: number): number {
  switch (button) {
    case 0: return 1  // left
    case 1: return 2  // middle
    case 2: return 3  // right
    case 3: return 4  // back
    case 4: return 5  // forward
    default: return 1
  }
}
