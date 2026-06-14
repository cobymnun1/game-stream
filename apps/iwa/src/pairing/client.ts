import type { AppInfo, LaunchResult, StreamConfig } from '../types/protocol.ts'
import { mapPort } from '../net/port-map.ts'
import {
  generatePairingKeys,
  type PairingKeys,
  sha1,
  sha256,
  aesEcbEncrypt,
  aesEcbDecrypt,
  rsaSign,
  getCertificateSignatureFromDerHex,
  verifyCertificateSignature,
  bufToHex,
  hexToBuf,
  randomBytes,
  concatBytes,
  equalBytes,
} from './crypto.ts'

const CLIENT_VERSION = 14
const DEVICE_NAME = 'roth'
const DEV_SUNSHINE_PROXY = '/__moonlight_http'
const DEFAULT_REQUEST_TIMEOUT_MS = 10_000
const PIN_REQUEST_TIMEOUT_MS = 120_000
const DEBUG_ENDPOINT = 'http://127.0.0.1:7458/ingest/a70defe2-9a92-40ab-8b63-4a3e87de3fac'

function debugLog(hypothesisId: string, location: string, message: string, data: Record<string, unknown>): void {
  // #region agent log
  fetch(DEBUG_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Debug-Session-Id': '31fcc6' },
    body: JSON.stringify({
      sessionId: '31fcc6',
      runId: 'cert-auth-502',
      hypothesisId,
      location,
      message,
      data,
      timestamp: Date.now(),
    }),
  }).catch(() => {})
  // #endregion
}

function apiUrl(host: string, port: number, path: string, params: Record<string, string> = {}, scheme: 'http' | 'https' = 'http') {
  // Translate Sunshine's internal port to its external (Akash) port. No-op when
  // no port map is loaded, so direct (non-Akash) hosts behave unchanged.
  const realPort = mapPort(port)
  const shouldProxy = location.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(location.hostname)
  const url = shouldProxy
    ? new URL(DEV_SUNSHINE_PROXY, location.origin)
    : new URL(`${scheme}://${host}:${realPort}${path}`)

  if (shouldProxy) {
    url.searchParams.set('host', host)
    url.searchParams.set('port', String(realPort))
    url.searchParams.set('path', path)
    url.searchParams.set('scheme', scheme)
  }

  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v)
  return url.toString()
}

async function xmlGet(url: string, timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS): Promise<Document> {
  return xmlRequest(url, undefined, timeoutMs)
}

async function xmlPostJson(url: string, body: unknown, timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS): Promise<Document> {
  return xmlRequest(url, body, timeoutMs)
}

async function xmlRequest(url: string, body: unknown | undefined, timeoutMs: number): Promise<Document> {
  const controller = new AbortController()
  const timeout = window.setTimeout(() => controller.abort(), timeoutMs)
  let res: Response
  try {
    res = await fetch(url, body === undefined
      ? { signal: controller.signal }
      : {
          signal: controller.signal,
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        })
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') {
      throw new Error(`Timed out after ${Math.round(timeoutMs / 1000)}s waiting for Sunshine`)
    }
    throw err
  } finally {
    window.clearTimeout(timeout)
  }

  const text = await res.text()
  if (!res.ok) {
    const body = text.trim()
    debugLog('H4', 'apps/iwa/src/pairing/client.ts:xmlRequest', 'Sunshine proxy returned non-OK response', {
      status: res.status,
      urlPath: new URL(url).pathname,
      bodyPrefix: body.slice(0, 180),
    })
    throw new Error(`HTTP ${res.status} from ${url}${body ? `: ${body.slice(0, 500)}` : ''}`)
  }
  if (/^\s*<!doctype html/i.test(text) || /^\s*<html[\s>]/i.test(text)) {
    throw new Error(
      'Expected Sunshine GameStream XML but got HTML. This usually means the request hit the Sunshine Web UI/API instead of the GameStream XML endpoint.',
    )
  }

  const doc = new DOMParser().parseFromString(text, 'text/xml')
  const parserError = doc.querySelector('parsererror')
  if (parserError) {
    throw new Error(`Invalid Sunshine XML response: ${parserError.textContent?.trim() ?? text.slice(0, 200)}`)
  }
  return doc
}

function xmlText(doc: Document, tag: string): string {
  return doc.querySelector(tag)?.textContent?.trim() ?? ''
}

function xmlAttr(doc: Document, attr: string): string {
  return doc.documentElement.getAttribute(attr)?.trim() ?? ''
}

function assertStatusOk(doc: Document, context: string): void {
  const statusCode = xmlAttr(doc, 'status_code')
  if (statusCode && statusCode !== '200') {
    const message = xmlAttr(doc, 'status_message') || xmlText(doc, 'status_message') || 'unknown Sunshine error'
    throw new Error(`${context} failed — Sunshine returned ${statusCode}: ${message}`)
  }
}

export class PairingClient {
  private readonly host: string
  private port: number
  private resolvedPort: number | null = null
  private httpsPort = 47984
  private readonly uniqueId: string
  private readonly uuid: string
  private serverMajorVersion = 7
  private pairingKeys: PairingKeys | null = null

  // Called after the PIN is generated and before the final pairing steps continue.
  // Dev builds can display it while production can submit it through a backend.
  onPin: ((pin: string) => Promise<void>) | null = null
  onPairingStep: ((step: string) => void) | null = null

  // Inject a pre-existing client identity so pair() can be skipped entirely.
  // Used when pairing was performed out-of-band (e.g. via pairing-api).
  injectKeys(keys: PairingKeys): void {
    this.pairingKeys = keys
  }

  constructor(host: string, port: number, uniqueId: string) {
    this.host = host
    this.port = port
    this.uniqueId = uniqueId
    this.uuid = crypto.randomUUID()
  }

  private params(extra: Record<string, string> = {}): Record<string, string> {
    return { uniqueid: this.uniqueId, uuid: this.uuid, ...extra }
  }

  private async request(path: string, params: Record<string, string> = {}, timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS): Promise<Document> {
    const ports = this.resolvedPort !== null ? [this.resolvedPort] : endpointCandidates(this.port)
    const errors: string[] = []

    for (const port of ports) {
      try {
        const doc = await xmlGet(apiUrl(this.host, port, path, params), timeoutMs)
        if (this.resolvedPort !== port) {
          console.info(`[pairing] using Sunshine GameStream HTTP endpoint ${this.host}:${port}`)
        }
        this.port = port
        this.resolvedPort = port
        return doc
      } catch (err) {
        errors.push(`${port}: ${err instanceof Error ? err.message : String(err)}`)
      }
    }

    throw new Error(`Could not reach Sunshine GameStream XML endpoint. Tried ${errors.join('; ')}`)
  }

  private secureRequest(path: string, params: Record<string, string> = {}, timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS): Promise<Document> {
    if (!this.pairingKeys) {
      throw new Error('Cannot call Sunshine HTTPS endpoint before pairing keys are generated')
    }

    debugLog('H1,H2,H4', 'apps/iwa/src/pairing/client.ts:secureRequest', 'Preparing Sunshine HTTPS request with client certificate', {
      path,
      httpsPort: this.httpsPort,
      hasCert: this.pairingKeys.certPem.length > 0,
      hasKey: this.pairingKeys.privateKeyPem.length > 0,
      certLength: this.pairingKeys.certPem.length,
      keyLength: this.pairingKeys.privateKeyPem.length,
      paramKeys: Object.keys(params),
    })

    const shouldProxy = location.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(location.hostname)
    if (!shouldProxy) {
      return xmlGet(apiUrl(this.host, this.httpsPort, path, params, 'https'), timeoutMs)
    }

    return xmlPostJson(new URL(DEV_SUNSHINE_PROXY, location.origin).toString(), {
      host: this.host,
      port: mapPort(this.httpsPort),
      path,
      scheme: 'https',
      params,
      clientCert: this.pairingKeys.certPem,
      clientKey: this.pairingKeys.privateKeyPem,
    }, timeoutMs)
  }

  async getServerInfo() {
    const doc = await this.request('/serverinfo', this.params())
    const appVersion = xmlText(doc, 'appversion') || xmlText(doc, 'AppVersion')
    this.serverMajorVersion = parseInt(appVersion.split('.')[0] ?? '7') || 7
    this.httpsPort = parseInt(xmlText(doc, 'HttpsPort') || '47984') || 47984

    return {
      hostname:      xmlText(doc, 'hostname'),
      serverCertHex: xmlText(doc, 'ServerCert') || xmlText(doc, 'serverCert'),
      appVersion,
      codecModeSupport: parseInt(xmlText(doc, 'ServerCodecModeSupport') || '0'),
      pairStatus: xmlText(doc, 'PairStatus'),
    }
  }

  async pair(): Promise<void> {
    const keys = await generatePairingKeys(this.uniqueId)
    this.pairingKeys = keys
    const salt = randomBytes(16)
    const saltHex = bufToHex(salt)
    const pin = String(Math.floor(Math.random() * 9000) + 1000)
    const hashLength = this.serverMajorVersion >= 7 ? 32 : 20
    const aesKey = (await this.pairingHash(concatBytes(salt, new TextEncoder().encode(pin)))).slice(0, 16)

    debugLog('H6,H7,H8', 'apps/iwa/src/pairing/client.ts:pair', 'Generated pairing certificate for step 1', {
      certHexLength: keys.certHex.length,
      certPemLength: keys.certPem.length,
      certHexPrefix: keys.certHex.slice(0, 20),
      certLooksPemEncoded: keys.certHex.startsWith('2d2d2d2d2d'),
      serverMajorVersion: this.serverMajorVersion,
      uniqueIdLength: this.uniqueId.length,
      uuidLength: this.uuid.length,
    })

    // Step 1 waits until Sunshine receives the PIN through its UI/API.
    this.onPairingStep?.('Waiting for Sunshine to accept PIN...')
    const step1Promise = this.request('/pair', this.params({
      devicename: DEVICE_NAME, updateState: '1',
      phrase: 'getservercert', salt: saltHex, clientcert: keys.certHex,
    }), PIN_REQUEST_TIMEOUT_MS)

    // Start the pending pairing request before showing the PIN, otherwise the
    // Sunshine API can reject the PIN because no client is waiting yet.
    if (this.onPin) {
      void this.onPin(pin)
    }

    const step1 = await step1Promise
    debugLog('H5', 'apps/iwa/src/pairing/client.ts:pair', 'Pairing step 1 response', {
      statusCode: xmlAttr(step1, 'status_code'),
      paired: xmlText(step1, 'paired'),
      hasPlainCert: xmlText(step1, 'plaincert').length > 0,
      plainCertLength: xmlText(step1, 'plaincert').length,
    })
    if (xmlText(step1, 'paired') !== '1') throw new Error('Pairing step 1 failed')
    this.onPairingStep?.('PIN accepted; verifying Sunshine...')

    const serverCertHex = xmlText(step1, 'plaincert')
    if (!serverCertHex) throw new Error('Pairing failed — Sunshine did not return a server certificate')
    const serverCertSignature = getCertificateSignatureFromDerHex(serverCertHex)

    const clientChallenge = randomBytes(16)
    const encryptedClientChallenge = aesEcbEncrypt(clientChallenge, aesKey)

    // Step 2 — encrypted client challenge
    this.onPairingStep?.('Sending encrypted client challenge...')
    const step2 = await this.request('/pair', this.params({
      devicename: DEVICE_NAME, updateState: '1',
      clientchallenge: bufToHex(encryptedClientChallenge),
    }))
    debugLog('H5', 'apps/iwa/src/pairing/client.ts:pair', 'Pairing step 2 response', {
      statusCode: xmlAttr(step2, 'status_code'),
      paired: xmlText(step2, 'paired'),
      hasChallengeResponse: xmlText(step2, 'challengeresponse').length > 0,
      challengeResponseLength: xmlText(step2, 'challengeresponse').length,
    })
    if (xmlText(step2, 'paired') !== '1') throw new Error('Pairing step 2 failed')

    const encryptedServerChallenge = hexToBuf(xmlText(step2, 'challengeresponse'))
    const decryptedServerChallenge = aesEcbDecrypt(encryptedServerChallenge, aesKey)
    const serverResponse = decryptedServerChallenge.slice(0, hashLength)
    const serverChallenge = decryptedServerChallenge.slice(hashLength, hashLength + 16)

    const clientSecret = randomBytes(16)
    const challengeResponseHash = await this.pairingHash(concatBytes(
      serverChallenge,
      keys.certSignature,
      clientSecret,
    ))
    const encryptedChallengeResponse = aesEcbEncrypt(challengeResponseHash, aesKey)

    // Step 3 — prove we decrypted Sunshine's challenge
    this.onPairingStep?.('Sending server challenge response...')
    const step3 = await this.request('/pair', this.params({
      devicename: DEVICE_NAME, updateState: '1',
      serverchallengeresp: bufToHex(encryptedChallengeResponse),
    }))
    debugLog('H5', 'apps/iwa/src/pairing/client.ts:pair', 'Pairing step 3 response', {
      statusCode: xmlAttr(step3, 'status_code'),
      paired: xmlText(step3, 'paired'),
      hasPairingSecret: xmlText(step3, 'pairingsecret').length > 0,
      pairingSecretLength: xmlText(step3, 'pairingsecret').length,
    })
    if (xmlText(step3, 'paired') !== '1') throw new Error('Pairing step 3 failed')

    const serverSecretResponse = hexToBuf(xmlText(step3, 'pairingsecret'))
    const serverSecret = serverSecretResponse.slice(0, 16)
    const serverSignature = serverSecretResponse.slice(16)

    if (!verifyCertificateSignature(serverSecret, serverSignature, serverCertHex)) {
      throw new Error('Pairing failed — Sunshine server signature verification failed')
    }

    const expectedServerResponse = await this.pairingHash(concatBytes(
      clientChallenge,
      serverCertSignature,
      serverSecret,
    ))
    if (!equalBytes(expectedServerResponse, serverResponse)) {
      throw new Error('Pairing failed — PIN was rejected by Sunshine')
    }

    const clientPairingSecret = concatBytes(clientSecret, rsaSign(clientSecret, keys.privateKeyPem))

    // Step 4 — send our signed pairing secret
    this.onPairingStep?.('Sending signed pairing secret...')
    const step4 = await this.request('/pair', this.params({
      devicename: DEVICE_NAME, updateState: '1',
      clientpairingsecret: bufToHex(clientPairingSecret),
    }))
    debugLog('H5', 'apps/iwa/src/pairing/client.ts:pair', 'Pairing step 4 response', {
      statusCode: xmlAttr(step4, 'status_code'),
      paired: xmlText(step4, 'paired'),
    })
    if (xmlText(step4, 'paired') !== '1') throw new Error('Pairing step 4 failed')

    // Step 5 — final confirmation
    this.onPairingStep?.('Confirming pairing...')
    const step5 = await this.secureRequest('/pair', this.params({
      phrase: 'pairchallenge',
    }))
    debugLog('H5', 'apps/iwa/src/pairing/client.ts:pair', 'Pairing final challenge response', {
      statusCode: xmlAttr(step5, 'status_code'),
      paired: xmlText(step5, 'paired'),
    })
    if (xmlText(step5, 'paired') !== '1') throw new Error('Pairing final confirmation failed')
    this.onPairingStep?.('Pairing complete.')
  }

  private pairingHash(data: Uint8Array): Promise<Uint8Array> {
    return this.serverMajorVersion >= 7 ? sha256(data) : sha1(data)
  }

  async getApps(): Promise<AppInfo[]> {
    const doc = await this.secureRequest('/applist', this.params())
    assertStatusOk(doc, 'App list')
    return Array.from(doc.querySelectorAll('App')).map(app => ({
      id: parseInt(app.querySelector('ID')?.textContent ?? '0'),
      title: app.querySelector('AppTitle')?.textContent ?? 'Unknown',
      isRunning: app.querySelector('IsRunning')?.textContent === '1',
    }))
  }

  async launch(appId: number, config: StreamConfig): Promise<LaunchResult> {
    const riKey = crypto.getRandomValues(new Uint8Array(16))
    const riKeyId = Math.floor(Math.random() * 0xFFFFFFFF)
    const riIv = deriveRiIv(riKeyId)
    const surroundInfo = config.audioChannels === 2 ? '196610'
      : config.audioChannels === 6 ? '1573390' : '2752546'

    const launchParams = this.params({
      appid: String(appId),
      mode: `${config.width}x${config.height}x${config.fps}`,
      additionalStates: '1', sops: '0',
      rikey: bufToHex(riKey), rikeyid: String(riKeyId),
      localAudioPlayMode: '0', surroundAudioInfo: surroundInfo,
      remoteControllersBitmap: '0', gcmap: '0',
      clientUpdateRate: '0', gcmonitor: '0',
    })

    let doc = await this.secureRequest('/launch', launchParams)

    const statusCode = xmlAttr(doc, 'status_code')
    if (statusCode && statusCode !== '200') {
      const message = xmlAttr(doc, 'status_message') || xmlText(doc, 'status_message') || 'unknown Sunshine error'
      if (statusCode === '400' && message === 'An app is already running on this host') {
        debugLog('H9', 'apps/iwa/src/pairing/client.ts:launch', 'Launch reported running app; trying Sunshine resume endpoint', {
          appId,
          statusCode,
          message,
        })
        doc = await this.secureRequest('/resume', launchParams)
        assertStatusOk(doc, 'Resume')
      } else {
        throw new Error(`Launch failed — Sunshine returned ${statusCode}: ${message}`)
      }
    }

    const rtspSessionUrl = xmlText(doc, 'sessionUrl0')
    const sessionToken = xmlText(doc, 'sessionid')
      || xmlText(doc, 'gamesession')
      || parseStreamId(rtspSessionUrl)

    if (!rtspSessionUrl && !sessionToken) {
      const serialized = new XMLSerializer().serializeToString(doc).slice(0, 500)
      throw new Error(`Launch failed — no RTSP session URL in response: ${serialized}`)
    }

    return {
      sessionToken: sessionToken || '0',
      rtspSessionUrl: rtspSessionUrl || `rtsp://${this.host}/streamid=${sessionToken}`,
      riKey,
      riKeyId,
      riIv,
      videoPort: 47998,
      audioPort: 47999,
      controlPort: 48010,
    }
  }

  async quit(): Promise<void> {
    await this.secureRequest('/cancel', this.params())
  }
}

function endpointCandidates(port: number): number[] {
  return Array.from(new Set([
    port,
    // Sunshine often reports/uses 47989 as the external GameStream HTTP port.
    47989,
    // Older/default local GameStream HTTP port.
    47984,
  ].filter(p => p > 0 && p !== 47990)))
}

function deriveRiIv(riKeyId: number): Uint8Array {
  const iv = new Uint8Array(16)
  new DataView(iv.buffer).setUint32(0, riKeyId >>> 0, false)
  return iv
}

function parseStreamId(rtspSessionUrl: string): string {
  if (!rtspSessionUrl) return ''
  const match = rtspSessionUrl.match(/streamid=([^/?#]+)/i)
  return match?.[1] ?? ''
}
