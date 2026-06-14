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
} from './crypto.js'
import { sunshineGet, xmlTag, type SunshineTls } from './sunshine-http.js'
import { mapPort, type PortMap } from './port-map.js'

const DEVICE_NAME = 'roth'
const DEFAULT_REQUEST_TIMEOUT_MS = 10_000
const PIN_REQUEST_TIMEOUT_MS = 120_000

export interface PairingIdentity {
  uniqueId: string
  certPem: string
  privateKeyPem: string
}

// Server-side port of apps/iwa/src/pairing/client.ts. Runs the Moonlight
// pairing handshake against a Sunshine host. The PIN is generated here (the
// client owns the PIN in GameStream); the caller submits it to Sunshine
// out-of-band, which unblocks handshake step 1.
export class PairingSession {
  private readonly host: string
  private port: number
  private resolvedHttpPort: number | null = null
  private httpsPort = 47984
  private readonly uniqueId: string
  private readonly uuid: string
  private serverMajorVersion = 7

  private keys: PairingKeys | null = null
  private pin: string | null = null
  private salt: Uint8Array | null = null
  private aesKey: Uint8Array | null = null

  // Optional Akash internal->external port map. When absent, ports pass through
  // unchanged (direct/local pairing). When present, every Sunshine HTTP/HTTPS
  // call is translated, so the host can advertise its internal ports while we
  // connect to the external ones.
  private readonly portMap: PortMap | undefined

  onStep: ((step: string) => void) | null = null

  constructor(host: string, port = 47989, portMap?: PortMap) {
    this.host = host
    this.port = port
    this.portMap = portMap
    this.uniqueId = bufToHex(randomBytes(8))
    this.uuid = crypto.randomUUID()
  }

  get identity(): PairingIdentity | null {
    if (!this.keys) return null
    return {
      uniqueId: this.uniqueId,
      certPem: this.keys.certPem,
      privateKeyPem: this.keys.privateKeyPem,
    }
  }

  private params(extra: Record<string, string> = {}): Record<string, string> {
    return { uniqueid: this.uniqueId, uuid: this.uuid, ...extra }
  }

  private async request(path: string, params: Record<string, string>, timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS): Promise<string> {
    const ports = this.resolvedHttpPort !== null ? [this.resolvedHttpPort] : endpointCandidates(this.port)
    const errors: string[] = []

    for (const port of ports) {
      try {
        const body = await sunshineGet({ host: this.host, port: mapPort(this.portMap, port), path, params, scheme: 'http', timeoutMs })
        this.port = port
        this.resolvedHttpPort = port
        return body
      } catch (err) {
        errors.push(`${port} (-> ${mapPort(this.portMap, port)}): ${err instanceof Error ? err.message : String(err)}`)
      }
    }

    throw new Error(`Could not reach Sunshine GameStream XML endpoint. Tried ${errors.join('; ')}`)
  }

  private secureRequest(path: string, params: Record<string, string>, timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS): Promise<string> {
    if (!this.keys) throw new Error('Cannot call Sunshine HTTPS endpoint before pairing keys are generated')
    const tls: SunshineTls = { clientCert: this.keys.certPem, clientKey: this.keys.privateKeyPem }
    return sunshineGet({ host: this.host, port: mapPort(this.portMap, this.httpsPort), path, params, scheme: 'https', tls, timeoutMs })
  }

  // Probe Sunshine; resolves the GameStream HTTP port and reads version info.
  // Throws if the host is unreachable or not a GameStream endpoint.
  async getServerInfo(): Promise<{ hostname: string; appVersion: string; pairStatus: string }> {
    const body = await this.request('/serverinfo', this.params())
    const appVersion = xmlTag(body, 'appversion') || xmlTag(body, 'AppVersion')
    this.serverMajorVersion = parseInt(appVersion.split('.')[0] ?? '7') || 7
    this.httpsPort = parseInt(xmlTag(body, 'HttpsPort') || '47984') || 47984
    return {
      hostname: xmlTag(body, 'hostname'),
      appVersion,
      pairStatus: xmlTag(body, 'PairStatus'),
    }
  }

  // Generate the client identity + PIN. Must be called after getServerInfo()
  // (the hash algorithm depends on the server version). Returns the PIN.
  async prepare(): Promise<string> {
    this.keys = await generatePairingKeys(this.uniqueId)
    this.salt = randomBytes(16)
    this.pin = String(Math.floor(Math.random() * 9000) + 1000)
    this.aesKey = (await this.pairingHash(concatBytes(this.salt, new TextEncoder().encode(this.pin)))).slice(0, 16)
    return this.pin
  }

  // Run the full 5-step handshake. Step 1 (getservercert) is fired synchronously
  // at the top so it is in-flight before the caller is handed the PIN, then it
  // blocks until Sunshine receives the PIN; steps 2-5 complete the pairing.
  async complete(): Promise<void> {
    const keys = this.keys
    const salt = this.salt
    const aesKey = this.aesKey
    if (!keys || !salt || !aesKey) throw new Error('complete() called before prepare()')

    const hashLength = this.serverMajorVersion >= 7 ? 32 : 20

    this.onStep?.('Waiting for Sunshine to accept PIN...')
    const step1Promise = this.request('/pair', this.params({
      devicename: DEVICE_NAME, updateState: '1',
      phrase: 'getservercert', salt: bufToHex(salt), clientcert: keys.certHex,
    }), PIN_REQUEST_TIMEOUT_MS)

    const step1 = await step1Promise
    if (xmlTag(step1, 'paired') !== '1') throw new Error('Pairing step 1 failed (getservercert)')
    this.onStep?.('PIN accepted; verifying Sunshine...')

    const serverCertHex = xmlTag(step1, 'plaincert')
    if (!serverCertHex) throw new Error('Pairing failed — Sunshine did not return a server certificate')
    const serverCertSignature = getCertificateSignatureFromDerHex(serverCertHex)

    const clientChallenge = randomBytes(16)
    const encryptedClientChallenge = aesEcbEncrypt(clientChallenge, aesKey)

    this.onStep?.('Sending encrypted client challenge...')
    const step2 = await this.request('/pair', this.params({
      devicename: DEVICE_NAME, updateState: '1',
      clientchallenge: bufToHex(encryptedClientChallenge),
    }))
    if (xmlTag(step2, 'paired') !== '1') throw new Error('Pairing step 2 failed (clientchallenge)')

    const encryptedServerChallenge = hexToBuf(xmlTag(step2, 'challengeresponse'))
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

    this.onStep?.('Sending server challenge response...')
    const step3 = await this.request('/pair', this.params({
      devicename: DEVICE_NAME, updateState: '1',
      serverchallengeresp: bufToHex(encryptedChallengeResponse),
    }))
    if (xmlTag(step3, 'paired') !== '1') throw new Error('Pairing step 3 failed (serverchallengeresp)')

    const serverSecretResponse = hexToBuf(xmlTag(step3, 'pairingsecret'))
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

    this.onStep?.('Sending signed pairing secret...')
    const step4 = await this.request('/pair', this.params({
      devicename: DEVICE_NAME, updateState: '1',
      clientpairingsecret: bufToHex(clientPairingSecret),
    }))
    if (xmlTag(step4, 'paired') !== '1') throw new Error('Pairing step 4 failed (clientpairingsecret)')

    this.onStep?.('Confirming pairing...')
    const step5 = await this.secureRequest('/pair', this.params({ phrase: 'pairchallenge' }))
    if (xmlTag(step5, 'paired') !== '1') throw new Error('Pairing final confirmation failed (pairchallenge)')
    this.onStep?.('Pairing complete.')
  }

  private pairingHash(data: Uint8Array): Promise<Uint8Array> {
    return this.serverMajorVersion >= 7 ? sha256(data) : sha1(data)
  }
}

function endpointCandidates(port: number): number[] {
  return Array.from(new Set([
    port,
    // Sunshine commonly reports/uses 47989 as the external GameStream HTTP port.
    47989,
    // Older/default local GameStream HTTP port.
    47984,
  ].filter(p => p > 0 && p !== 47990)))
}
