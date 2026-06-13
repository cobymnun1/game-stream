import type { KeyboardAction } from '@basehack/protocol'

// #region agent log
function kbDbg(hypothesisId: string, location: string, message: string, data: Record<string, unknown>): void {
  fetch('http://127.0.0.1:7458/ingest/a70defe2-9a92-40ab-8b63-4a3e87de3fac', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Debug-Session-Id': '31fcc6' },
    body: JSON.stringify({ sessionId: '31fcc6', runId: 'keyboard-dbg', hypothesisId, location, message, data, timestamp: Date.now() }),
  }).catch(() => {})
}
// #endregion

export interface KeyboardInputEvent {
  keyCode: number
  action: KeyboardAction
  modifiers: number
}

export class KeyboardInput {
  private onInput: (event: KeyboardInputEvent) => void
  private target: HTMLElement | null = null
  private held = new Set<string>()

  constructor(onInput: (event: KeyboardInputEvent) => void) {
    this.onInput = onInput
  }

  attach(element: HTMLElement): void {
    this.target = element
    // Listen on window, not the canvas: a <canvas> is not keyboard-focusable
    // (tabIndex -1) so it never receives keydown/keyup — those go to the focused
    // element (usually <body>) and bubble to window. Pointer lock captures the
    // mouse regardless, which is why the mouse worked but the keyboard didn't.
    window.addEventListener('keydown', this.handleKeyDown)
    window.addEventListener('keyup', this.handleKeyUp)
    // Prevent browser from handling keys we're forwarding
    window.addEventListener('keydown', this.suppressDefault)
  }

  detach(): void {
    if (!this.target) return
    window.removeEventListener('keydown', this.handleKeyDown)
    window.removeEventListener('keyup', this.handleKeyUp)
    window.removeEventListener('keydown', this.suppressDefault)
    this.held.clear()
    this.target = null
  }

  private handleKeyDown = (e: Event): void => {
    const event = e as KeyboardEvent
    // #region agent log
    kbDbg('H80,H81', 'keyboard.ts:handleKeyDown', 'keydown handler fired', {
      code: event.code,
      vk: browserCodeToVK(event.code),
    })
    // #endregion
    if (this.held.has(event.code)) return // already held — browser fires repeated keydown
    this.held.add(event.code)
    const vk = browserCodeToVK(event.code)
    if (!vk) return
    this.onInput({ keyCode: vk, action: 'down', modifiers: getModifierFlags(event) })
  }

  private handleKeyUp = (e: Event): void => {
    const event = e as KeyboardEvent
    this.held.delete(event.code)
    const vk = browserCodeToVK(event.code)
    if (!vk) return
    this.onInput({ keyCode: vk, action: 'up', modifiers: getModifierFlags(event) })
  }

  private suppressDefault = (e: Event): void => {
    const event = e as KeyboardEvent
    // Let browser handle F5 (refresh), F12 (devtools), but block everything else
    if (!['F5', 'F12'].includes(event.key)) e.preventDefault()
  }
}

// Windows Virtual Key codes used by Moonlight.
const KEY_MAP: Record<string, number> = {
  'KeyA': 0x41, 'KeyB': 0x42, 'KeyC': 0x43, 'KeyD': 0x44, 'KeyE': 0x45,
  'KeyF': 0x46, 'KeyG': 0x47, 'KeyH': 0x48, 'KeyI': 0x49, 'KeyJ': 0x4A,
  'KeyK': 0x4B, 'KeyL': 0x4C, 'KeyM': 0x4D, 'KeyN': 0x4E, 'KeyO': 0x4F,
  'KeyP': 0x50, 'KeyQ': 0x51, 'KeyR': 0x52, 'KeyS': 0x53, 'KeyT': 0x54,
  'KeyU': 0x55, 'KeyV': 0x56, 'KeyW': 0x57, 'KeyX': 0x58, 'KeyY': 0x59,
  'KeyZ': 0x5A,
  'Digit0': 0x30, 'Digit1': 0x31, 'Digit2': 0x32, 'Digit3': 0x33, 'Digit4': 0x34,
  'Digit5': 0x35, 'Digit6': 0x36, 'Digit7': 0x37, 'Digit8': 0x38, 'Digit9': 0x39,
  'Numpad0': 0x60, 'Numpad1': 0x61, 'Numpad2': 0x62, 'Numpad3': 0x63,
  'Numpad4': 0x64, 'Numpad5': 0x65, 'Numpad6': 0x66, 'Numpad7': 0x67,
  'Numpad8': 0x68, 'Numpad9': 0x69,
  'NumpadMultiply': 0x6A, 'NumpadAdd': 0x6B, 'NumpadSubtract': 0x6D,
  'NumpadDecimal': 0x6E, 'NumpadDivide': 0x6F, 'NumpadEnter': 0x0D,
  'Space': 0x20, 'Enter': 0x0D, 'Backspace': 0x08, 'Tab': 0x09,
  'Escape': 0x1B, 'Delete': 0x2E, 'Insert': 0x2D,
  'Home': 0x24, 'End': 0x23, 'PageUp': 0x21, 'PageDown': 0x22,
  'ArrowLeft': 0x25, 'ArrowUp': 0x26, 'ArrowRight': 0x27, 'ArrowDown': 0x28,
  'F1': 0x70, 'F2': 0x71, 'F3': 0x72, 'F4': 0x73, 'F5': 0x74,
  'F6': 0x75, 'F7': 0x76, 'F8': 0x77, 'F9': 0x78, 'F10': 0x79,
  'F11': 0x7A, 'F12': 0x7B,
  'ShiftLeft': 0xA0, 'ShiftRight': 0xA1,
  'ControlLeft': 0xA2, 'ControlRight': 0xA3,
  'AltLeft': 0xA4, 'AltRight': 0xA5,
  'MetaLeft': 0x5B, 'MetaRight': 0x5C,
  'CapsLock': 0x14, 'NumLock': 0x90, 'ScrollLock': 0x91,
  'Semicolon': 0xBA, 'Equal': 0xBB, 'Comma': 0xBC, 'Minus': 0xBD,
  'Period': 0xBE, 'Slash': 0xBF, 'Backquote': 0xC0,
  'BracketLeft': 0xDB, 'Backslash': 0xDC, 'BracketRight': 0xDD, 'Quote': 0xDE,
}

function browserCodeToVK(code: string): number {
  return KEY_MAP[code] ?? 0
}

function getModifierFlags(event: KeyboardEvent): number {
  let mods = 0
  if (event.shiftKey) mods |= 0x01
  if (event.ctrlKey)  mods |= 0x02
  if (event.altKey)   mods |= 0x04
  if (event.metaKey)  mods |= 0x08
  return mods
}
