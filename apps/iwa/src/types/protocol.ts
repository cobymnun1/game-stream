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

export interface AppInfo {
  id: number
  title: string
  isRunning: boolean
}

export interface LaunchResult {
  sessionToken: string
  rtspSessionUrl: string
  riKey: Uint8Array    // 16-byte AES key for stream encryption
  riKeyId: number
  riIv: Uint8Array     // 16-byte IV derived from the RI key ID for moonlight-common-c
  videoPort: number
  audioPort: number
  controlPort: number
  serverInfoAppVersion?: string
  serverCodecModeSupport?: number
}

export type FrameType = 'idr' | 'pframe'

export interface VideoFrame {
  data: Uint8Array
  frameIndex: number
  type: FrameType
}

export type ConnectionState =
  | 'idle'
  | 'pairing'
  | 'launching'
  | 'connecting'
  | 'streaming'
  | 'disconnected'
  | 'error'
