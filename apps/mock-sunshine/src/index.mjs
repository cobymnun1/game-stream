/**
 * Mock Sunshine server for local IWA testing.
 *
 * Implements:
 *   HTTP  :47984 — /serverinfo, /pair, /applist, /launch, /cancel
 *   TCP   :48010 — RTSP OPTIONS/DESCRIBE/SETUP/PLAY
 *   UDP   :47998 — H.264 test video stream (color-cycling frames)
 *   UDP   :47999 — audio (silent)
 *
 * No real crypto — pairing always succeeds so you can focus on
 * testing the stream pipeline.
 *
 * Usage: node src/index.mjs
 */

import http from 'http'
import net from 'net'
import dgram from 'dgram'
import crypto from 'crypto'

// ─── Config ──────────────────────────────────────────────────────────────────
const HTTP_PORT = 47984
const RTSP_PORT = 48010
const VIDEO_PORT = 47998
const AUDIO_PORT = 47999
const SESSION_ID = 'mock-session-1234'

// ─── HTTP server (pairing + launch) ──────────────────────────────────────────
const httpServer = http.createServer((req, res) => {
  const url = new URL(req.url, `http://localhost:${HTTP_PORT}`)
  const path = url.pathname
  console.log(`[HTTP] ${req.method} ${path}`)

  res.setHeader('Content-Type', 'text/xml')
  res.setHeader('Access-Control-Allow-Origin', '*')

  if (path === '/serverinfo') {
    res.end(xml({
      root: {
        hostname: 'mock-sunshine',
        appversion: '7.1.431.0',
        GfeVersion: '3.23.0.74',
        uniqueid: 'mock-server-id',
        HttpsPort: '47989',
        ExternalPort: '47989',
        mac: '00:00:00:00:00:00',
        LocalIP: '127.0.0.1',
        PairStatus: '1',
        currentgame: '0',
        state: 'SUNSHINE_SERVER_FREE',
        ServerCodecModeSupport: '3',
        ServerCert: FAKE_CERT_HEX,
      }
    }))
    return
  }

  if (path === '/pair') {
    const phrase = url.searchParams.get('phrase')
    if (phrase === 'getservercert') {
      res.end(xml({ root: { paired: '1', plaincert: FAKE_CERT_HEX } }))
    } else if (phrase === 'clientchallenge') {
      // Return a fake 256-byte challenge response (RSA block size)
      const fakeChallenge = crypto.randomBytes(256).toString('hex')
      res.end(xml({ root: { paired: '1', challengeresponse: fakeChallenge } }))
    } else if (phrase === 'clientpairingsecret') {
      res.end(xml({ root: { paired: '1' } }))
    } else if (phrase === 'pairchallenge') {
      res.end(xml({ root: { paired: '1' } }))
    } else {
      res.end(xml({ root: { paired: '1' } }))
    }
    return
  }

  if (path === '/applist') {
    res.end(xml({
      root: {
        App: [
          { ID: '0', AppTitle: 'Steam Big Picture', IsRunning: '0', IsHdrSupported: '0' },
          { ID: '1', AppTitle: 'Desktop', IsRunning: '0', IsHdrSupported: '0' },
        ]
      }
    }))
    return
  }

  if (path === '/launch') {
    console.log('[HTTP] Stream launch requested — starting video stream')
    startVideoStream()
    res.end(xml({ root: { sessionid: SESSION_ID, gamesession: SESSION_ID } }))
    return
  }

  if (path === '/cancel') {
    stopVideoStream()
    res.end(xml({ root: { cancel: '1' } }))
    return
  }

  res.statusCode = 404
  res.end('<root><status>not found</status></root>')
})

httpServer.listen(HTTP_PORT, () => {
  console.log(`[HTTP]  Listening on :${HTTP_PORT}`)
})

// ─── RTSP server (stream setup) ──────────────────────────────────────────────
let rtspClients = []

const rtspServer = net.createServer((socket) => {
  console.log('[RTSP] Client connected')
  rtspClients.push(socket)

  let buffer = ''
  socket.on('data', (data) => {
    buffer += data.toString()
    while (buffer.includes('\r\n\r\n')) {
      const end = buffer.indexOf('\r\n\r\n') + 4
      const request = buffer.slice(0, end)
      buffer = buffer.slice(end)
      handleRtsp(socket, request)
    }
  })

  socket.on('close', () => {
    rtspClients = rtspClients.filter(c => c !== socket)
    console.log('[RTSP] Client disconnected')
  })

  socket.on('error', () => {})
})

let rtspCseq = 1

function handleRtsp(socket, request) {
  const firstLine = request.split('\r\n')[0]
  const cseqMatch = request.match(/CSeq:\s*(\d+)/i)
  const cseq = cseqMatch ? cseqMatch[1] : rtspCseq++

  console.log(`[RTSP] ${firstLine}`)

  if (firstLine.startsWith('OPTIONS')) {
    socket.write(
      `RTSP/1.0 200 OK\r\nCSeq: ${cseq}\r\nPublic: DESCRIBE, SETUP, TEARDOWN, PLAY\r\n\r\n`
    )
    return
  }

  if (firstLine.startsWith('DESCRIBE')) {
    const sdp = [
      'v=0',
      `o=- 0 0 IN IP4 127.0.0.1`,
      `s=Sunshine Mock`,
      `t=0 0`,
      `m=video ${VIDEO_PORT} RTP/AVP 96`,
      `a=rtpmap:96 H264/90000`,
      `a=fmtp:96 profile-level-id=640033`,
      `m=audio ${AUDIO_PORT} RTP/AVP 97`,
      `a=rtpmap:97 OPUS/48000/2`,
      '',
    ].join('\r\n')
    socket.write(
      `RTSP/1.0 200 OK\r\nCSeq: ${cseq}\r\nContent-Type: application/sdp\r\nContent-Length: ${sdp.length}\r\n\r\n${sdp}`
    )
    return
  }

  if (firstLine.startsWith('SETUP')) {
    socket.write(
      `RTSP/1.0 200 OK\r\nCSeq: ${cseq}\r\nSession: ${SESSION_ID}\r\nTransport: unicast\r\n\r\n`
    )
    return
  }

  if (firstLine.startsWith('PLAY')) {
    socket.write(
      `RTSP/1.0 200 OK\r\nCSeq: ${cseq}\r\nSession: ${SESSION_ID}\r\n\r\n`
    )
    return
  }

  if (firstLine.startsWith('TEARDOWN')) {
    socket.write(`RTSP/1.0 200 OK\r\nCSeq: ${cseq}\r\n\r\n`)
    socket.end()
    stopVideoStream()
    return
  }

  socket.write(`RTSP/1.0 200 OK\r\nCSeq: ${cseq}\r\n\r\n`)
}

rtspServer.listen(RTSP_PORT, () => {
  console.log(`[RTSP]  Listening on :${RTSP_PORT}`)
})

// ─── UDP video stream ─────────────────────────────────────────────────────────
// Streams real H.264 Annex-B NAL units (a minimal SPS+PPS+IDR, then P-frames)
// wrapped in the NV_VIDEO_PACKET format that our depacketizer expects.

const udpVideo = dgram.createSocket('udp4')
let videoInterval = null
let clientAddress = null
let clientPort = null
let frameIndex = 0
let rtpSeq = 0

// Minimal H.264 SPS+PPS+IDR for 320x240 (generated from ffmpeg -vframes 1)
const H264_SPS = Buffer.from('6764001facd940a02ff9610000030001000003003c8f162d96', 'hex')
const H264_PPS = Buffer.from('68ebe3cb22c0', 'hex')

// Annex-B start code
const START_CODE = Buffer.from([0x00, 0x00, 0x00, 0x01])

function buildAnnexB(...nalUnits) {
  return Buffer.concat(nalUnits.flatMap(nal => [START_CODE, nal]))
}

function buildNvPacket(payload, frameIdx, streamPktIdx, flags) {
  // RTP header (12 bytes) + NV_VIDEO_PACKET (16 bytes) + payload
  const rtp = Buffer.alloc(12)
  rtp[0] = 0x80           // version=2
  rtp[1] = 0x60           // payload type 96
  rtp.writeUInt16BE(rtpSeq++ & 0xffff, 2)
  rtp.writeUInt32BE(frameIdx * 3000, 4) // timestamp (90kHz clock)
  rtp.writeUInt32BE(0xdeadbeef, 8)      // ssrc

  const nv = Buffer.alloc(16)
  nv.writeUInt32LE(streamPktIdx, 0)
  nv.writeUInt32LE(frameIdx, 4)
  nv[8] = flags           // FLAG_SOF=4, FLAG_EOF=2, FLAG_CONTAINS_PIC_DATA=1
  nv[9] = 0               // extraFlags
  nv[10] = 0              // multiFecFlags
  nv[11] = 0              // multiFecBlocks
  nv.writeUInt32LE(0, 12) // fecInfo

  return Buffer.concat([rtp, nv, payload])
}

function sendFrame(frameData, isKeyFrame) {
  if (!clientAddress) return

  const MAX_PAYLOAD = 1300
  const chunks = []
  for (let i = 0; i < frameData.length; i += MAX_PAYLOAD) {
    chunks.push(frameData.slice(i, i + MAX_PAYLOAD))
  }

  chunks.forEach((chunk, i) => {
    const isFirst = i === 0
    const isLast = i === chunks.length - 1
    let flags = 0x01 // CONTAINS_PIC_DATA
    if (isFirst) flags |= 0x04 // SOF
    if (isLast) flags |= 0x02  // EOF

    const pkt = buildNvPacket(chunk, frameIndex, i, flags)
    udpVideo.send(pkt, clientPort, clientAddress)
  })

  frameIndex++
}

function startVideoStream() {
  if (videoInterval) return

  let tick = 0
  videoInterval = setInterval(() => {
    if (!clientAddress) return

    if (tick % 60 === 0) {
      // Send IDR frame (SPS + PPS + IDR NAL)
      const idrNal = buildIdrNal(tick)
      const frameData = buildAnnexB(H264_SPS, H264_PPS, idrNal)
      sendFrame(frameData, true)
      console.log(`[UDP]   IDR frame #${frameIndex} → ${clientAddress}:${clientPort}`)
    } else {
      // Minimal P-frame NAL (tells decoder: same as last frame)
      const pFrame = buildPFrameNal()
      const frameData = buildAnnexB(pFrame)
      sendFrame(frameData, false)
    }

    tick++
  }, 1000 / 30) // 30fps
}

function stopVideoStream() {
  if (videoInterval) {
    clearInterval(videoInterval)
    videoInterval = null
    console.log('[UDP]   Video stream stopped')
  }
}

// Minimal H.264 IDR NAL (5-type, just a color-cycling macroblock pattern)
function buildIdrNal(tick) {
  // NAL type 5 = IDR slice
  const header = Buffer.from([0x65, 0x88, 0x84, 0x00, 0x33, 0xff])
  const payload = Buffer.alloc(64).fill((tick * 4) & 0xff) // changes color each IDR
  return Buffer.concat([header, payload])
}

function buildPFrameNal() {
  // NAL type 1 = non-IDR slice — minimal skip macroblock
  return Buffer.from([0x41, 0x9a, 0x1c, 0x0c, 0x44, 0xef, 0xff])
}

udpVideo.on('message', (msg, rinfo) => {
  // Client sends PING to wake up the stream
  if (msg.toString() === 'PING' || msg.length === 4) {
    console.log(`[UDP]   PING from ${rinfo.address}:${rinfo.port} — video will stream here`)
    clientAddress = rinfo.address
    clientPort = rinfo.port
    if (!videoInterval) startVideoStream()
  }
})

udpVideo.bind(VIDEO_PORT, () => {
  console.log(`[UDP]   Video listening on :${VIDEO_PORT}`)
})

// ─── UDP audio (silent stub) ──────────────────────────────────────────────────
const udpAudio = dgram.createSocket('udp4')
udpAudio.bind(AUDIO_PORT, () => {
  console.log(`[UDP]   Audio listening on :${AUDIO_PORT}`)
})

// ─── XML helper ──────────────────────────────────────────────────────────────
function xml(obj, indent = '') {
  let out = '<?xml version="1.0" encoding="utf-8"?>'
  function render(o, ind) {
    for (const [key, val] of Object.entries(o)) {
      if (Array.isArray(val)) {
        val.forEach(item => { out += `\n${ind}<${key}>`; render(item, ind + '  '); out += `\n${ind}</${key}>` })
      } else if (typeof val === 'object') {
        out += `\n${ind}<${key}>`; render(val, ind + '  '); out += `\n${ind}</${key}>`
      } else {
        out += `\n${ind}<${key}>${val}</${key}>`
      }
    }
  }
  render(obj, indent)
  return out
}

// Fake DER-encoded cert hex (256 bytes of zeros — Sunshine only checks format, not content in pairing)
const FAKE_CERT_HEX = '3082015a' + '00'.repeat(346)

console.log('\n🎮 Mock Sunshine running. Open the IWA and connect to: 127.0.0.1\n')
