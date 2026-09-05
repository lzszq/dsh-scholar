/** Bounded HTTPS for MinerU. No redirects, environment proxies, or a second
 * DNS lookup after validating the destination. Credentials are API-only. */
import { lookup as dnsLookup } from 'node:dns/promises'
import type { LookupAddress } from 'node:dns'
import { request as httpsRequest } from 'node:https'
import { isIP } from 'node:net'
import { validateProviderBaseUrl } from './provider.js'
import { MinerUTransportError } from './ocr-worker.js'

export const MINERU_API_ORIGIN = 'https://mineru.net'
const TRANSFER_HOSTS = new Set([
  'mineru.oss-cn-shanghai.aliyuncs.com',
  'oss-mineru.openxlab.org.cn',
  'cdn-mineru.openxlab.org.cn',
])
export interface MinerUHttpInput {
  url: string
  method: 'GET' | 'POST' | 'PUT'
  headers?: Record<string, string>
  body?: Buffer
  maxResponseBytes: number
  signal: AbortSignal
}
export type MinerUHttpRequest = (input: MinerUHttpInput) => Promise<Buffer>

export function validateMinerUUrl(value: string, api: boolean): URL {
  try {
    const url = new URL(value)
    if (url.protocol !== 'https:' || url.port !== '' || url.username !== '' || url.password !== '' || url.hash !== '') throw new Error()
    if (api ? url.origin !== MINERU_API_ORIGIN : !TRANSFER_HOSTS.has(url.hostname)) throw new Error()
    return url
  } catch { throw new MinerUTransportError('provider_rejected') }
}

/** Pure check shared with the connection-time lookup callback tests. */
export function validateMinerUAddress(address: string): void {
  try {
    const family = isIP(address)
    if (family === 0) throw new Error()
    if (family === 6 && (!/^[23][0-9a-f]{3}:/i.test(address) || /^(2001:db8:|2001:0:|2002:|3fff:)/i.test(address))) throw new Error()
    validateProviderBaseUrl(`https://${family === 6 ? `[${address}]` : address}`)
  } catch { throw new MinerUTransportError('provider_rejected') }
}

export const requestMinerU: MinerUHttpRequest = async input => {
  const api = new URL(input.url).origin === MINERU_API_ORIGIN
  const url = validateMinerUUrl(input.url, api)
  if (!api && Object.keys(input.headers ?? {}).some(name => name.toLowerCase() === 'authorization')) {
    throw new MinerUTransportError('provider_rejected')
  }
  input.signal.throwIfAborted()
  const addresses = await new Promise<LookupAddress[]>((resolve, reject) => {
    const abort = () => reject(input.signal.reason)
    input.signal.addEventListener('abort', abort, { once: true })
    const lookup = dnsLookup(url.hostname, { all: true, verbatim: true })
    void lookup.then(resolve, reject).finally(() => input.signal.removeEventListener('abort', abort))
  })
  input.signal.throwIfAborted()
  if (addresses.length === 0) throw new MinerUTransportError('provider_unavailable')
  // Reject mixed public/private answers as well as direct private addresses.
  for (const entry of addresses) validateMinerUAddress(entry.address)
  const selected = addresses[0]!
  return await new Promise<Buffer>((resolve, reject) => {
    const req = httpsRequest(url, {
      method: input.method, agent: false, signal: input.signal,
      headers: { ...input.headers, ...(input.body === undefined ? {} : { 'content-length': String(input.body.byteLength) }) },
      // TLS still verifies the original hostname. The connection can only use
      // this already-checked address, closing the DNS rebinding window.
      lookup: (_hostname, options, callback) => {
        if (typeof options === 'object' && options.all) callback(null, [selected])
        else callback(null, selected.address, selected.family)
      },
    }, res => {
      const status = res.statusCode ?? 0
      if (status < 200 || status >= 300) {
        res.destroy()
        reject(new MinerUTransportError(status === 429 || status >= 500 ? 'provider_unavailable' : 'provider_rejected'))
        return
      }
      const length = res.headers['content-length']
      if (length !== undefined && Number(length) > input.maxResponseBytes) {
        res.destroy()
        reject(new MinerUTransportError('provider_rejected'))
        return
      }
      const chunks: Buffer[] = []
      let total = 0
      res.on('data', (chunk: Buffer) => {
        total += chunk.length
        if (total > input.maxResponseBytes) {
          res.destroy(new MinerUTransportError('provider_rejected'))
          return
        }
        chunks.push(chunk)
      })
      res.once('error', reject)
      res.once('aborted', () => reject(new MinerUTransportError('provider_unavailable')))
      res.once('end', () => resolve(Buffer.concat(chunks, total)))
    })
    req.once('error', reject)
    req.end(input.body)
  })
}
