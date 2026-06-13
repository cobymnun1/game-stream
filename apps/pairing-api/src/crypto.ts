import * as forge from 'node-forge'

// Moonlight pairing uses RSA-2048 + SHA-1 + X.509 self-signed cert.
// Web Crypto doesn't support RSA PKCS#1 v1.5 raw encrypt/decrypt, so
// we use node-forge for those operations and Web Crypto for the rest.
// (Node 20+ exposes crypto.subtle / crypto.getRandomValues / TextEncoder
// as globals, so this module runs unchanged server-side.)

export interface PairingKeys {
  privateKeyPem: string
  certPem: string
  certHex: string       // PEM-encoded cert bytes as hex, what Sunshine expects
  certBytes: Uint8Array
  certSignature: Uint8Array
}

export async function generatePairingKeys(uniqueId: string): Promise<PairingKeys> {
  const keypair = forge.pki.rsa.generateKeyPair({ bits: 2048, e: 0x10001 })
  const cert = forge.pki.createCertificate()

  cert.publicKey = keypair.publicKey
  cert.serialNumber = '01'
  cert.validity.notBefore = new Date()
  cert.validity.notAfter = new Date()
  cert.validity.notAfter.setFullYear(cert.validity.notBefore.getFullYear() + 20)

  const attrs = [
    { name: 'commonName', value: `Moonlight-${uniqueId}` },
    { name: 'organizationName', value: 'Moonlight' },
  ]
  cert.setSubject(attrs)
  cert.setIssuer(attrs)
  cert.sign(keypair.privateKey, forge.md.sha256.create())

  const certPem = normalizePem(forge.pki.certificateToPem(cert))
  const certBytes = new TextEncoder().encode(certPem)
  const certSignature = forgeBytesToUint8Array(cert.signature)

  return {
    privateKeyPem: normalizePem(forge.pki.privateKeyToPem(keypair.privateKey)),
    certPem,
    certHex: bufToHex(certBytes),
    certBytes,
    certSignature,
  }
}

export async function sha1(data: Uint8Array): Promise<Uint8Array> {
  // crypto.subtle.digest requires a proper ArrayBuffer, not SharedArrayBuffer-backed view
  const buf = new ArrayBuffer(data.byteLength)
  new Uint8Array(buf).set(data)
  const hash = await crypto.subtle.digest('SHA-1', buf)
  return new Uint8Array(hash)
}

export async function sha256(data: Uint8Array): Promise<Uint8Array> {
  const buf = new ArrayBuffer(data.byteLength)
  new Uint8Array(buf).set(data)
  const hash = await crypto.subtle.digest('SHA-256', buf)
  return new Uint8Array(hash)
}

export function aesEcbEncrypt(data: Uint8Array, key: Uint8Array): Uint8Array {
  const cipher = forge.cipher.createCipher('AES-ECB', uint8ArrayToForgeBytes(key))
  cipher.start({})
  ;(cipher.mode as unknown as { pad: false | ((input: forge.util.ByteStringBuffer) => boolean) }).pad = false
  cipher.update(forge.util.createBuffer(uint8ArrayToForgeBytes(data)))
  if (!cipher.finish()) throw new Error('AES encrypt failed')
  return forgeBytesToUint8Array(cipher.output.bytes())
}

export function aesEcbDecrypt(data: Uint8Array, key: Uint8Array): Uint8Array {
  const cipher = forge.cipher.createDecipher('AES-ECB', uint8ArrayToForgeBytes(key))
  cipher.start({})
  ;(cipher.mode as unknown as { unpad: false | ((output: forge.util.ByteStringBuffer) => boolean) }).unpad = false
  cipher.update(forge.util.createBuffer(uint8ArrayToForgeBytes(data)))
  if (!cipher.finish()) throw new Error('AES decrypt failed')
  return forgeBytesToUint8Array(cipher.output.bytes())
}

// RSA PKCS#1 v1.5 decrypt (not available in Web Crypto — requires forge)
export function rsaDecrypt(ciphertext: Uint8Array, privateKeyPem: string): Uint8Array {
  const privKey = forge.pki.privateKeyFromPem(privateKeyPem)
  const cipherStr = String.fromCharCode(...ciphertext)
  const decrypted = privKey.decrypt(cipherStr) // PKCS1_V1_5 is the default
  const result = new Uint8Array(decrypted.length)
  for (let i = 0; i < decrypted.length; i++) result[i] = decrypted.charCodeAt(i)
  return result
}

// RSA PKCS#1 v1.5 sign with SHA-256
export function rsaSign(data: Uint8Array, privateKeyPem: string): Uint8Array {
  const privKey = forge.pki.privateKeyFromPem(privateKeyPem)
  const md = forge.md.sha256.create()
  md.update(String.fromCharCode(...data))
  const sig = privKey.sign(md)
  const result = new Uint8Array(sig.length)
  for (let i = 0; i < sig.length; i++) result[i] = sig.charCodeAt(i)
  return result
}

export function getCertificateSignatureFromDerHex(certDerHex: string): Uint8Array {
  const cert = parseCertificateFromHex(certDerHex)
  return forgeBytesToUint8Array(cert.signature)
}

export function verifyCertificateSignature(data: Uint8Array, signature: Uint8Array, certDerHex: string): boolean {
  const cert = parseCertificateFromHex(certDerHex)
  const md = forge.md.sha256.create()
  md.update(uint8ArrayToForgeBytes(data))
  return (cert.publicKey as forge.pki.rsa.PublicKey).verify(md.digest().bytes(), uint8ArrayToForgeBytes(signature))
}

export function bufToHex(buf: Uint8Array): string {
  return Array.from(buf).map(b => b.toString(16).padStart(2, '0')).join('')
}

export function hexToBuf(hex: string): Uint8Array {
  const result = new Uint8Array(hex.length / 2)
  for (let i = 0; i < result.length; i++) {
    result[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16)
  }
  return result
}

export function randomBytes(n: number): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(n))
}

export function concatBytes(...chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0)
  const result = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    result.set(chunk, offset)
    offset += chunk.length
  }
  return result
}

export function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= (a[i] ?? 0) ^ (b[i] ?? 0)
  return diff === 0
}

function forgeBytesToUint8Array(bytes: string): Uint8Array {
  const result = new Uint8Array(bytes.length)
  for (let i = 0; i < bytes.length; i++) result[i] = bytes.charCodeAt(i)
  return result
}

function uint8ArrayToForgeBytes(bytes: Uint8Array): string {
  let result = ''
  for (const byte of bytes) result += String.fromCharCode(byte)
  return result
}

function parseCertificateFromHex(certHex: string): forge.pki.Certificate {
  const certBytes = hexToBuf(certHex)
  const certText = new TextDecoder().decode(certBytes)
  if (certText.startsWith('-----BEGIN CERTIFICATE-----')) {
    return forge.pki.certificateFromPem(certText)
  }

  return forge.pki.certificateFromAsn1(forge.asn1.fromDer(uint8ArrayToForgeBytes(certBytes)))
}

function normalizePem(pem: string): string {
  return pem.replace(/\r\n/g, '\n')
}
