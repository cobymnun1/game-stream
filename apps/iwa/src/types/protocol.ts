// Moonlight / GameStream protocol types

export type VideoCodec = 'h264' | 'hevc' | 'av1'

export interface StreamConfig {
  width: number
  height: number
  fps: number
  bitrateKbps: number
  codec: VideoCodec
  audioChannels: 2 | 6 | 8
}

export interface ConnectionParams {
  host: string
  httpPort: number   // 47984 (plain HTTP for pairing)
  httpsPort: number  // 47989 (HTTPS — Sunshine self-signed cert)
  controlPort: number // 48010 (RTSP control)
  videoPort: number   // 47998 (UDP video)
  audioPort: number   // 47999 (UDP audio)
}

export interface PairingState {
  uniqueId: string
  deviceName: string
  privateKeyPem: string
  certDerHex: string
}

export interface AppInfo {
  id: number
  title: string
  isRunning: boolean
}

export interface LaunchResult {
  sessionToken: string
  riKey: Uint8Array    // 16-byte AES key for stream encryption
  riKeyId: number
  videoPort: number
  audioPort: number
  controlPort: number
}

// NV_VIDEO_PACKET flags (from Video.h)
export const VideoFlags = {
  CONTAINS_PIC_DATA: 0x1,
  EOF: 0x2,
  SOF: 0x4,
} as const

// From Limelight.h
export const VideoFormat = {
  H264: 0x0001,
  HEVC: 0x0100,
  AV1_MAIN8: 0x1000,
} as const

export type FrameType = 'idr' | 'pframe'

export interface VideoFrame {
  data: Uint8Array
  frameIndex: number
  type: FrameType
}

// Input packet magic numbers (from Input.h, little-endian)
export const InputMagic = {
  KEY_DOWN: 0x00000003,
  KEY_UP: 0x00000004,
  MOUSE_MOVE_ABS: 0x00000005,
  MOUSE_MOVE_REL: 0x00000007, // gen5
  MOUSE_BTN_DOWN: 0x00000008, // gen5
  MOUSE_BTN_UP: 0x00000009,   // gen5
  SCROLL: 0x0000000a,          // gen5
} as const

export type ConnectionState =
  | 'idle'
  | 'pairing'
  | 'launching'
  | 'connecting'
  | 'streaming'
  | 'disconnected'
  | 'error'
