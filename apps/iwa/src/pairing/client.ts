import type { AppInfo, LaunchResult, StreamConfig } from '../types/protocol.ts'
import {
  generatePairingKeys,
  sha1,
  rsaDecrypt,
  rsaSign,
  bufToHex,
  hexToBuf,
  randomBytes,
} from './crypto.ts'

const CLIENT_VERSION = 14
const DEVICE_NAME = 'BaseHack-Moonlight'

function apiUrl(host: string, port: number, path: string, params: Record<string, string> = {}) {
  const url = new URL(`http://${host}:${port}${path}`)
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v)
  return url.toString()
}

async function xmlGet(url: string): Promise<Document> {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`)
  const text = await res.text()
  return new DOMParser().parseFromString(text, 'text/xml')
}

function xmlText(doc: Document, tag: string): string {
  return doc.querySelector(tag)?.textContent?.trim() ?? ''
}

export class PairingClient {
  private readonly host: string
  private readonly port: number
  private readonly uniqueId: string
  private readonly uuid: string

  // Callback that sends the PIN to the worker backend for auto-submission to Sunshine.
  // Set by the SessionManager before pairing starts.
  onPin: ((pin: string) => Promise<void>) | null = null

  constructor(host: string, port: number, uniqueId: string) {
    this.host = host
    this.port = port
    this.uniqueId = uniqueId
    this.uuid = crypto.randomUUID()
  }

  private params(extra: Record<string, string> = {}): Record<string, string> {
    return { uniqueid: this.uniqueId, uuid: this.uuid, ...extra }
  }

  async getServerInfo() {
    const doc = await xmlGet(apiUrl(this.host, this.port, '/serverinfo', this.params()))
    return {
      hostname:      xmlText(doc, 'hostname'),
      serverCertHex: xmlText(doc, 'ServerCert') || xmlText(doc, 'serverCert'),
      appVersion:    xmlText(doc, 'appversion') || xmlText(doc, 'AppVersion'),
    }
  }

  async pair(): Promise<void> {
    const keys = await generatePairingKeys(this.uniqueId)
    const salt = randomBytes(16)
    const saltHex = bufToHex(salt)

    // Step 1 — send client cert, get server cert
    const step1 = await xmlGet(apiUrl(this.host, this.port, '/pair', this.params({
      devicename: DEVICE_NAME, updateState: '1',
      phrase: 'getservercert', salt: saltHex, clientcert: keys.certDerHex,
    })))
    if (xmlText(step1, 'paired') !== '1') throw new Error('Pairing step 1 failed')

    const serverCertHex = xmlText(step1, 'plaincert')
    const serverCertBytes = hexToBuf(serverCertHex)

    // Step 2 — client challenge
    const clientChallenge = randomBytes(16)
    const challengeInput = new Uint8Array(salt.length + serverCertBytes.length + clientChallenge.length)
    challengeInput.set(salt)
    challengeInput.set(serverCertBytes, salt.length)
    challengeInput.set(clientChallenge, salt.length + serverCertBytes.length)
    const challengeHash = await sha1(challengeInput)

    const step2 = await xmlGet(apiUrl(this.host, this.port, '/pair', this.params({
      devicename: DEVICE_NAME, updateState: '1',
      phrase: 'clientchallenge', salt: saltHex, clientchallenge: bufToHex(challengeHash),
    })))
    if (xmlText(step2, 'paired') !== '1') throw new Error('Pairing step 2 failed')

    // ── AUTO-PIN: generate a 4-digit PIN and send to worker for Sunshine submission ──
    // Sunshine needs this between step 2 and step 3. The worker POSTs it to
    // Sunshine's /api/pin endpoint with Basic auth using the per-session credentials.
    const pin = String(Math.floor(Math.random() * 9000) + 1000)
    if (this.onPin) {
      await this.onPin(pin)
    }

    // Step 3 — server challenge response + pairing secret
    const serverChallengeHex = xmlText(step2, 'challengeresponse')
    const encryptedServerChallenge = hexToBuf(serverChallengeHex)
    const decryptedChallenge = rsaDecrypt(encryptedServerChallenge, keys.privateKeyPem)
    const expectedServerHash = decryptedChallenge.slice(0, 20)
    const serverSecret = decryptedChallenge.slice(20, 36)

    const clientChallengeHashInput = new Uint8Array(clientChallenge.length + keys.certBytes.length)
    clientChallengeHashInput.set(clientChallenge)
    clientChallengeHashInput.set(keys.certBytes, clientChallenge.length)
    const expectedHash = await sha1(clientChallengeHashInput)

    if (bufToHex(expectedHash) !== bufToHex(expectedServerHash)) {
      throw new Error('Server challenge verification failed — server identity mismatch')
    }

    const clientSecret = randomBytes(16)
    const pairingSecretInput = new Uint8Array(serverSecret.length + clientSecret.length)
    pairingSecretInput.set(serverSecret)
    pairingSecretInput.set(clientSecret, serverSecret.length)
    const clientPairingSecret = await sha1(pairingSecretInput)
    const signedSecret = rsaSign(clientPairingSecret, keys.privateKeyPem)
    const clientPairingSecretFull = new Uint8Array(clientPairingSecret.length + signedSecret.length)
    clientPairingSecretFull.set(clientPairingSecret)
    clientPairingSecretFull.set(signedSecret, clientPairingSecret.length)

    // Step 4 — send pairing secret
    const step4 = await xmlGet(apiUrl(this.host, this.port, '/pair', this.params({
      devicename: DEVICE_NAME, updateState: '1',
      phrase: 'clientpairingsecret', clientpairingsecret: bufToHex(clientPairingSecretFull),
    })))
    if (xmlText(step4, 'paired') !== '1') throw new Error('Pairing step 4 failed')

    // Step 5 — final confirmation
    const step5 = await xmlGet(apiUrl(this.host, this.port, '/pair', this.params({
      phrase: 'pairchallenge',
    })))
    if (xmlText(step5, 'paired') !== '1') throw new Error('Pairing final confirmation failed')
  }

  async getApps(): Promise<AppInfo[]> {
    const doc = await xmlGet(apiUrl(this.host, this.port, '/applist', this.params()))
    return Array.from(doc.querySelectorAll('App')).map(app => ({
      id: parseInt(app.querySelector('ID')?.textContent ?? '0'),
      title: app.querySelector('AppTitle')?.textContent ?? 'Unknown',
      isRunning: app.querySelector('IsRunning')?.textContent === '1',
    }))
  }

  async launch(appId: number, config: StreamConfig): Promise<LaunchResult> {
    const riKey = crypto.getRandomValues(new Uint8Array(16))
    const riKeyId = Math.floor(Math.random() * 0xFFFFFFFF)
    const surroundInfo = config.audioChannels === 2 ? '196610'
      : config.audioChannels === 6 ? '1573390' : '2752546'

    const doc = await xmlGet(apiUrl(this.host, this.port, '/launch', this.params({
      appid: String(appId),
      mode: `${config.width}x${config.height}x${config.fps}`,
      additionalStates: '1', sops: '0',
      rikey: bufToHex(riKey), rikeyid: String(riKeyId),
      localAudioPlayMode: '0', surroundAudioInfo: surroundInfo,
      remoteControllersBitmap: '0', gcmap: '0',
      clientUpdateRate: '0', gcmonitor: '0',
    })))

    const sessionToken = xmlText(doc, 'sessionid') || xmlText(doc, 'gamesession')
    if (!sessionToken) throw new Error('Launch failed — no session token in response')

    return { sessionToken, riKey, riKeyId, videoPort: 47998, audioPort: 47999, controlPort: 48010 }
  }

  async quit(): Promise<void> {
    await xmlGet(apiUrl(this.host, this.port, '/cancel', this.params()))
  }
}
