import type { AudioFormat } from '@basehack/protocol'

// #region agent log
function audioDbg(hypothesisId: string, location: string, message: string, data: Record<string, unknown>): void {
  fetch('http://127.0.0.1:7458/ingest/a70defe2-9a92-40ab-8b63-4a3e87de3fac', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Debug-Session-Id': '31fcc6' },
    body: JSON.stringify({ sessionId: '31fcc6', runId: 'audio-dbg', hypothesisId, location, message, data, timestamp: Date.now() }),
  }).catch(() => {})
}
// #endregion

// Plays the Moonlight audio stream. moonlight-common-c hands us *encoded Opus*
// frames (one per onAudioPacket); we decode them with WebCodecs AudioDecoder and
// schedule the resulting PCM on a Web Audio playhead with a small jitter buffer.
export class AudioPlayer {
  private ctx: AudioContext | null = null
  private gain: GainNode | null = null
  private decoder: AudioDecoder | null = null
  private format: AudioFormat | null = null

  private frameDurationUs = 5000
  private chunkTimestampUs = 0
  private nextPlayTime = 0
  // Target buffer ahead of the playhead (seconds). Small to keep latency low for
  // a game stream, but enough to absorb network jitter.
  private readonly jitterSec = 0.06

  private pktCount = 0
  private decodedCount = 0

  configure(format: AudioFormat): void {
    this.format = format
    const sampleRate = format.sampleRate || 48000
    const channels = format.channelCount || 2
    const samplesPerFrame = format.samplesPerFrame || 240
    this.frameDurationUs = Math.round((samplesPerFrame / sampleRate) * 1_000_000)
    this.chunkTimestampUs = 0
    this.nextPlayTime = 0

    if (!this.ctx) {
      this.ctx = new AudioContext({ sampleRate, latencyHint: 'interactive' })
      this.gain = this.ctx.createGain()
      this.gain.connect(this.ctx.destination)
    }

    this.decoder = new AudioDecoder({
      output: data => this.onDecoded(data),
      error: err => {
        // #region agent log
        audioDbg('Haud3', 'audio/player.ts:decoder.error', 'AudioDecoder error', { message: err.message })
        // #endregion
      },
    })
    this.decoder.configure({ codec: 'opus', sampleRate, numberOfChannels: channels })

    // #region agent log
    audioDbg('Haud1,Haud4', 'audio/player.ts:configure', 'audio configured', {
      audioConfiguration: format.audioConfiguration,
      sampleRate, channels, samplesPerFrame,
      frameDurationUs: this.frameDurationUs,
      ctxState: this.ctx.state,
      decoderState: this.decoder.state,
    })
    // #endregion
  }

  // Must be called from within a user gesture to satisfy Chrome autoplay policy.
  resume(): void {
    const ctx = this.ctx
    if (!ctx || ctx.state !== 'suspended') return
    const before = ctx.state
    ctx.resume().then(
      () => {
        // #region agent log
        audioDbg('Haud4', 'audio/player.ts:resume', 'audioContext resumed', { before, after: ctx.state })
        // #endregion
      },
      () => {},
    )
  }

  enqueue(data: Uint8Array): void {
    const decoder = this.decoder
    if (!decoder || decoder.state !== 'configured') return
    this.pktCount++
    // Every Opus packet is independently decodable → mark as a key chunk.
    const chunk = new EncodedAudioChunk({
      type: 'key',
      timestamp: this.chunkTimestampUs,
      duration: this.frameDurationUs,
      data,
    })
    this.chunkTimestampUs += this.frameDurationUs
    try {
      decoder.decode(chunk)
    } catch (err) {
      // #region agent log
      audioDbg('Haud3', 'audio/player.ts:enqueue', 'decode threw', { message: String(err) })
      // #endregion
    }
    // #region agent log
    if (this.pktCount === 1 || this.pktCount % 200 === 0) {
      audioDbg('Haud2', 'audio/player.ts:enqueue', 'opus packet enqueued', {
        pktCount: this.pktCount, length: data.length, decoderState: decoder.state, ctxState: this.ctx?.state,
      })
    }
    // #endregion
  }

  private onDecoded(audioData: AudioData): void {
    const ctx = this.ctx
    const gain = this.gain
    if (!ctx || !gain) { audioData.close(); return }
    this.decodedCount++

    const channels = audioData.numberOfChannels
    const frames = audioData.numberOfFrames
    const rate = audioData.sampleRate
    const buffer = ctx.createBuffer(channels, frames, rate)
    for (let ch = 0; ch < channels; ch++) {
      const plane = new Float32Array(frames)
      audioData.copyTo(plane, { planeIndex: ch, format: 'f32-planar' })
      buffer.copyToChannel(plane, ch)
    }
    audioData.close()

    const src = ctx.createBufferSource()
    src.buffer = buffer
    src.connect(gain)

    const now = ctx.currentTime
    // If we've fallen behind (underrun) or this is the first buffer, re-anchor
    // the playhead a jitter window into the future.
    if (this.nextPlayTime < now + 0.005) {
      this.nextPlayTime = now + this.jitterSec
    }
    src.start(this.nextPlayTime)
    this.nextPlayTime += buffer.duration

    // #region agent log
    if (this.decodedCount === 1 || this.decodedCount % 200 === 0) {
      audioDbg('Haud3,Haud5', 'audio/player.ts:onDecoded', 'pcm decoded + scheduled', {
        decodedCount: this.decodedCount, channels, frames, rate,
        startAt: Number(this.nextPlayTime.toFixed(3)), now: Number(now.toFixed(3)), ctxState: ctx.state,
      })
    }
    // #endregion
  }

  async close(): Promise<void> {
    try { if (this.decoder && this.decoder.state !== 'closed') this.decoder.close() } catch { /* noop */ }
    this.decoder = null
    try { await this.ctx?.close() } catch { /* noop */ }
    this.ctx = null
    this.gain = null
    this.format = null
    this.pktCount = 0
    this.decodedCount = 0
  }
}
