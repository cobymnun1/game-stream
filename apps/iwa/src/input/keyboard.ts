import {
  encodeKeyDown,
  encodeKeyUp,
  browserCodeToVK,
  getModifierFlags,
} from './packets.ts'

export class KeyboardInput {
  private onPacket: (data: Uint8Array) => void
  private target: HTMLElement | null = null
  private held = new Set<string>()

  constructor(onPacket: (data: Uint8Array) => void) {
    this.onPacket = onPacket
  }

  attach(element: HTMLElement): void {
    this.target = element
    element.addEventListener('keydown', this.handleKeyDown)
    element.addEventListener('keyup', this.handleKeyUp)
    // Prevent browser from handling keys we're forwarding
    element.addEventListener('keydown', this.suppressDefault)
  }

  detach(): void {
    if (!this.target) return
    this.target.removeEventListener('keydown', this.handleKeyDown)
    this.target.removeEventListener('keyup', this.handleKeyUp)
    this.target.removeEventListener('keydown', this.suppressDefault)
    this.held.clear()
    this.target = null
  }

  private handleKeyDown = (e: Event): void => {
    const event = e as KeyboardEvent
    if (this.held.has(event.code)) return // already held — browser fires repeated keydown
    this.held.add(event.code)
    const vk = browserCodeToVK(event.code)
    if (!vk) return
    this.onPacket(encodeKeyDown(vk, getModifierFlags(event)))
  }

  private handleKeyUp = (e: Event): void => {
    const event = e as KeyboardEvent
    this.held.delete(event.code)
    const vk = browserCodeToVK(event.code)
    if (!vk) return
    this.onPacket(encodeKeyUp(vk, getModifierFlags(event)))
  }

  private suppressDefault = (e: Event): void => {
    const event = e as KeyboardEvent
    // Let browser handle F5 (refresh), F12 (devtools), but block everything else
    if (!['F5', 'F12'].includes(event.key)) e.preventDefault()
  }
}
