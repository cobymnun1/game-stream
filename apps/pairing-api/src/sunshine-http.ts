import { Agent as HttpAgent, request as httpRequest } from 'node:http'
import { Agent as HttpsAgent, request as httpsRequest } from 'node:https'

// Server-side replacement for the browser fetch + Vite dev proxy that the IWA
// uses to reach Sunshine. Ported from apps/iwa/vite.config.ts `proxySunshine`:
// Sunshine speaks GameStream XML over plain HTTP (pairing steps 1-4) and over
// HTTPS with a mutual client certificate (step 5 / launch). Its TLS stack is
// pinned to TLSv1.2 and uses a self-signed cert, so we must disable cert
// verification and disable session resumption.

export type Scheme = 'http' | 'https'

export interface SunshineTls {
  clientCert?: string
  clientKey?: string
}

export interface SunshineRequest {
  host: string
  port: number
  path: string
  params?: Record<string, string>
  scheme?: Scheme
  tls?: SunshineTls
  timeoutMs?: number
}

const DEFAULT_TIMEOUT_MS = 10_000

// Perform a GET against a Sunshine GameStream endpoint and return the XML body.
// Throws on transport errors, non-2xx responses, or HTML (wrong port) responses.
export function sunshineGet(req: SunshineRequest): Promise<string> {
  const scheme: Scheme = req.scheme ?? 'http'
  const timeoutMs = req.timeoutMs ?? DEFAULT_TIMEOUT_MS

  const query = new URLSearchParams(req.params ?? {}).toString()
  const fullPath = query ? `${req.path}?${query}` : req.path

  return new Promise<string>((resolve, reject) => {
    const requestImpl = scheme === 'https' ? httpsRequest : httpRequest
    // Disable keep-alive so each request opens a fresh TCP connection.
    // Sunshine can close idle GameStream connections between calls (e.g.
    // between getServerInfo and getservercert which has an RSA keygen gap),
    // causing "socket hang up" when Node's default agent reuses a dead socket.
    const agent = scheme === 'https'
      ? new HttpsAgent({ keepAlive: false, maxCachedSessions: 0 })
      : new HttpAgent({ keepAlive: false })

    const upstream = requestImpl({
      protocol: `${scheme}:`,
      hostname: req.host,
      port: req.port,
      path: fullPath,
      method: 'GET',
      // Sunshine uses a self-signed cert and only negotiates TLSv1.2.
      rejectUnauthorized: false,
      minVersion: 'TLSv1.2',
      maxVersion: 'TLSv1.2',
      agent,
      cert: req.tls?.clientCert,
      key: req.tls?.clientKey,
    }, response => {
      response.setEncoding('utf8')
      let body = ''
      response.on('data', chunk => { body += chunk })
      response.on('end', () => {
        const status = response.statusCode ?? 0
        if (status < 200 || status >= 300) {
          reject(new Error(`Sunshine ${scheme}://${req.host}:${req.port}${req.path} returned HTTP ${status}: ${body.slice(0, 300)}`))
          return
        }
        if (/^\s*<!doctype html/i.test(body) || /^\s*<html[\s>]/i.test(body)) {
          reject(new Error('Expected Sunshine GameStream XML but got HTML (wrong port — likely hit the Sunshine Web UI/API instead of the GameStream port).'))
          return
        }
        resolve(body)
      })
    })

    upstream.setTimeout(timeoutMs, () => {
      upstream.destroy(new Error(`Timed out after ${Math.round(timeoutMs / 1000)}s waiting for Sunshine ${req.host}:${req.port}${req.path}`))
    })
    upstream.on('error', reject)
    upstream.end()
  })
}

// --- Minimal XML field extraction (replaces the browser DOMParser) ----------
// Sunshine responses are flat <tag>value</tag> documents with a status_code
// attribute on the root element, so simple, well-scoped regex extraction is
// sufficient and dependency-free.

export function xmlTag(xml: string, tag: string): string {
  const match = xml.match(new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, 'i'))
  return match?.[1]?.trim() ?? ''
}

export function xmlRootAttr(xml: string, attr: string): string {
  const withoutDecl = xml.replace(/<\?[\s\S]*?\?>/g, '').replace(/<!--[\s\S]*?-->/g, '')
  const root = withoutDecl.match(/<([A-Za-z_][\w:.-]*)((?:\s+[\w:.-]+\s*=\s*"[^"]*")*)\s*\/?>/)
  if (!root) return ''
  const attrMatch = (root[2] ?? '').match(new RegExp(`${attr}\\s*=\\s*"([^"]*)"`))
  return attrMatch?.[1]?.trim() ?? ''
}
