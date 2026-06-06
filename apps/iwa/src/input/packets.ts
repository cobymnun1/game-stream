import { InputMagic } from '../types/protocol.ts'

// All input packet formats are from moonlight-common-c/src/Input.h
// NV_INPUT_HEADER: { uint32_t size (BE) = total - 4, uint32_t magic (LE) }
// All structs use #pragma pack(push, 1) — no padding.

function writeHeader(buf: DataView, magic: number, totalSize: number): void {
  buf.setUint32(0, totalSize - 4, false) // size = total - sizeof(size field), BE
  buf.setUint32(4, magic, true)          // magic, LE
}

// NV_KEYBOARD_PACKET: header(8) + flags(1) + keyCode(2) + modifiers(1) + zero2(2) = 14 bytes
export function encodeKeyDown(keyCode: number, modifiers = 0): Uint8Array {
  const buf = new ArrayBuffer(14)
  const view = new DataView(buf)
  writeHeader(view, InputMagic.KEY_DOWN, 14)
  view.setUint8(8, 0)                   // flags (always 0)
  view.setInt16(9, keyCode, true)        // keyCode LE
  view.setUint8(11, modifiers)           // modifiers
  view.setInt16(12, 0, true)             // zero2
  return new Uint8Array(buf)
}

export function encodeKeyUp(keyCode: number, modifiers = 0): Uint8Array {
  const buf = new ArrayBuffer(14)
  const view = new DataView(buf)
  writeHeader(view, InputMagic.KEY_UP, 14)
  view.setUint8(8, 0)
  view.setInt16(9, keyCode, true)
  view.setUint8(11, modifiers)
  view.setInt16(12, 0, true)
  return new Uint8Array(buf)
}

// NV_REL_MOUSE_MOVE_PACKET (gen5): header(8) + deltaX(2) + deltaY(2) = 12 bytes
export function encodeMouseMoveRel(deltaX: number, deltaY: number): Uint8Array {
  const buf = new ArrayBuffer(12)
  const view = new DataView(buf)
  writeHeader(view, InputMagic.MOUSE_MOVE_REL, 12)
  view.setInt16(8, Math.round(deltaX), true)
  view.setInt16(10, Math.round(deltaY), true)
  return new Uint8Array(buf)
}

// NV_MOUSE_BUTTON_PACKET (gen5): header(8) + button(1) = 9 bytes
// button: 1=left, 2=middle, 3=right, 4=side, 5=extra
export function encodeMouseButtonDown(button: number): Uint8Array {
  const buf = new ArrayBuffer(9)
  const view = new DataView(buf)
  writeHeader(view, InputMagic.MOUSE_BTN_DOWN, 9)
  view.setUint8(8, button)
  return new Uint8Array(buf)
}

export function encodeMouseButtonUp(button: number): Uint8Array {
  const buf = new ArrayBuffer(9)
  const view = new DataView(buf)
  writeHeader(view, InputMagic.MOUSE_BTN_UP, 9)
  view.setUint8(8, button)
  return new Uint8Array(buf)
}

// NV_SCROLL_PACKET (gen5): header(8) + scrollAmt1(2) + scrollAmt2(2) + zero3(2) = 14 bytes
// scrollAmt is in wheel clicks * 120 (Windows WHEEL_DELTA convention)
export function encodeMouseScroll(wheelDelta: number): Uint8Array {
  const buf = new ArrayBuffer(14)
  const view = new DataView(buf)
  writeHeader(view, InputMagic.SCROLL, 14)
  view.setInt16(8, wheelDelta, true)  // scrollAmt1
  view.setInt16(10, wheelDelta, true) // scrollAmt2 (same value, mirrors GFE behavior)
  view.setInt16(12, 0, true)          // zero3
  return new Uint8Array(buf)
}

// Windows Virtual Key codes used by Moonlight
// Browser KeyboardEvent.code → Windows VK code
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

export function browserCodeToVK(code: string): number {
  return KEY_MAP[code] ?? 0
}

// Modifier flags (Moonlight uses Windows modifier constants)
export function getModifierFlags(event: KeyboardEvent): number {
  let mods = 0
  if (event.shiftKey) mods |= 0x01
  if (event.ctrlKey)  mods |= 0x02
  if (event.altKey)   mods |= 0x04
  if (event.metaKey)  mods |= 0x08
  return mods
}

// Browser mouse button → Moonlight button index
export function browserButtonToMoonlight(button: number): number {
  switch (button) {
    case 0: return 1  // left
    case 1: return 2  // middle
    case 2: return 3  // right
    case 3: return 4  // back
    case 4: return 5  // forward
    default: return 1
  }
}
