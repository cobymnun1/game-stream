import * as forge from 'node-forge'

// Moonlight pairing uses RSA-2048 + SHA-1 + X.509 self-signed cert.
// Web Crypto doesn't support RSA PKCS#1 v1.5 raw encrypt/decrypt, so
// we use node-forge for those operations and Web Crypto for the rest.

export interface PairingKeys {
  privateKeyPem: string
  certDerHex: string    // DER-encoded cert, hex string (what Sunshine expects)
  certBytes: Uint8Array
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

  const certDer = forge.asn1.toDer(forge.pki.certificateToAsn1(cert)).getBytes()
  const certBytes = new Uint8Array(certDer.length)
  for (let i = 0; i < certDer.length; i++) certBytes[i] = certDer.charCodeAt(i)

  return {
    privateKeyPem: forge.pki.privateKeyToPem(keypair.privateKey),
    certDerHex: bufToHex(certBytes),
    certBytes,
  }
}

export async function sha1(data: Uint8Array): Promise<Uint8Array> {
  // crypto.subtle.digest requires a proper ArrayBuffer, not SharedArrayBuffer-backed view
  const buf = new ArrayBuffer(data.byteLength)
  new Uint8Array(buf).set(data)
  const hash = await crypto.subtle.digest('SHA-1', buf)
  return new Uint8Array(hash)
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
