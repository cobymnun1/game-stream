import { VideoFlags, type FrameType, type VideoFrame } from '../types/protocol.ts'

// RTP + NV_VIDEO_PACKET layout (from Video.h, moonlight-common-c)
//
// [0]     header   — version/flags
// [1]     type     — payload type + marker
// [2..3]  seqNum   — BE uint16
// [4..7]  timestamp — BE uint32
// [8..11] ssrc     — BE uint32
// Optional 4-byte RTP extension if header & 0x10
// Then NV_VIDEO_PACKET (12 bytes):
//   [0..3]  streamPacketIndex — LE uint32
//   [4..7]  frameIndex        — LE uint32
//   [8]     flags             — FLAG_SOF=0x4, FLAG_EOF=0x2, FLAG_CONTAINS_PIC_DATA=0x1
//   [9]     extraFlags
//   [10]    multiFecFlags
//   [11]    multiFecBlocks
//   [12..15] fecInfo          — LE uint32

const RTP_HEADER_SIZE = 12
const RTP_EXT_SIZE = 4
const NV_PACKET_HEADER_SIZE = 16 // 12 base + 4 fecInfo
const FLAG_EXTENSION = 0x10

interface FrameBuffer {
  frameIndex: number
  fragments: Map<number, Uint8Array> // streamPacketIndex → payload
  hasStart: boolean
  hasEnd: boolean
  totalPackets: number
  receivedPackets: number
}

export class VideoDepacketizer extends EventTarget {
  private frames = new Map<number, FrameBuffer>()
  private lastCompletedFrame = -1

  processPacket(raw: Uint8Array): void {
    if (raw.length < RTP_HEADER_SIZE + NV_PACKET_HEADER_SIZE) return

    const view = new DataView(raw.buffer, raw.byteOffset, raw.byteLength)

    const rtpHeader = raw[0] ?? 0
    const hasExtension = (rtpHeader & FLAG_EXTENSION) !== 0
    const nvOffset = RTP_HEADER_SIZE + (hasExtension ? RTP_EXT_SIZE : 0)

    if (raw.length < nvOffset + NV_PACKET_HEADER_SIZE) return

    const streamPacketIndex = view.getUint32(nvOffset + 0, true)  // LE
    const frameIndex = view.getUint32(nvOffset + 4, true)          // LE
    const flags = raw[nvOffset + 8] ?? 0

    const payloadOffset = nvOffset + NV_PACKET_HEADER_SIZE
    const payload = raw.slice(payloadOffset)

    // Skip FEC (parity) packets — they don't contain picture data
    if (!(flags & VideoFlags.CONTAINS_PIC_DATA)) return

    let frame = this.frames.get(frameIndex)
    if (!frame) {
      frame = {
        frameIndex,
        fragments: new Map(),
        hasStart: false,
        hasEnd: false,
        totalPackets: 0,
        receivedPackets: 0,
      }
      this.frames.set(frameIndex, frame)
    }

    frame.fragments.set(streamPacketIndex, payload)
    frame.receivedPackets++
    if (flags & VideoFlags.SOF) frame.hasStart = true
    if (flags & VideoFlags.EOF) {
      frame.hasEnd = true
      // streamPacketIndex of EOF tells us the total packet count for this frame
      frame.totalPackets = streamPacketIndex + 1
    }

    if (frame.hasStart && frame.hasEnd && frame.receivedPackets >= frame.totalPackets) {
      this.assembleFrame(frame)
      // Clean up old frames
      for (const idx of this.frames.keys()) {
        if (idx <= frameIndex) this.frames.delete(idx)
      }
    }
  }

  private assembleFrame(frame: FrameBuffer): void {
    const chunks: Uint8Array[] = []
    let totalLen = 0

    for (let i = 0; i < frame.totalPackets; i++) {
      const fragment = frame.fragments.get(i)
      if (!fragment) return // Missing fragment — drop frame
      chunks.push(fragment)
      totalLen += fragment.length
    }

    const data = new Uint8Array(totalLen)
    let offset = 0
    for (const chunk of chunks) {
      data.set(chunk, offset)
      offset += chunk.length
    }

    // H.264 IDR frame starts with 0x65 NAL unit type (after Annex-B start codes)
    const type = isIdrFrame(data) ? 'idr' : 'pframe'

    const videoFrame: VideoFrame = { data, frameIndex: frame.frameIndex, type }
    this.dispatchEvent(new CustomEvent<VideoFrame>('frame', { detail: videoFrame }))
  }

  onFrame(handler: (frame: VideoFrame) => void): void {
    this.addEventListener('frame', (e) => {
      handler((e as CustomEvent<VideoFrame>).detail)
    })
  }
}

// H.264 IDR NAL unit type = 5, HEVC IDR = 19 or 20
// Annex-B start code: 00 00 00 01 or 00 00 01
function isIdrFrame(data: Uint8Array): boolean {
  for (let i = 0; i < Math.min(data.length - 4, 32); i++) {
    if (
      data[i] === 0 && data[i + 1] === 0 && data[i + 2] === 0 && data[i + 3] === 1
    ) {
      const nalType = (data[i + 4] ?? 0) & 0x1f // H.264
      if (nalType === 5) return true
      const hevcType = ((data[i + 4] ?? 0) & 0x7e) >> 1 // HEVC
      if (hevcType === 19 || hevcType === 20) return true
    }
  }
  return false
}
