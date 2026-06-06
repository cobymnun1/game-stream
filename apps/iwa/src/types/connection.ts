// Matches the ConnectionInfo from packages/shared — duplicated here
// because the IWA is an isolated app and can't import from shared directly.

export interface SunshinePorts {
  http: number
  https: number
  webUi: number
  control: number
  video: number
  audio: number
}

export interface ConnectionInfo {
  host: string
  ports: SunshinePorts
  leaseId: string
  dseq: number
  provider: string
}
