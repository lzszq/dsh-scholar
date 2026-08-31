import { request } from 'node:http'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ResearchKernel } from '@dsh-scholar/research-kernel'
import { startKernelServer } from '../../packages/research-kernel/src/server.js'

function beginJsonPost(url: string, requestId: string): {
  write(chunk: string): void
  end(chunk?: string): void
  response: Promise<{ status: number; body: { error?: { request_id?: string } } }>
} {
  const parsed = new URL(url)
  let resolveResponse!: (value: { status: number; body: { error?: { request_id?: string } } }) => void
  const response = new Promise<{ status: number; body: { error?: { request_id?: string } } }>(resolve => { resolveResponse = resolve })
  const req = request({
    hostname: parsed.hostname,
    port: parsed.port,
    path: '/v1/projects',
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-request-id': requestId },
  }, res => {
    let body = ''
    res.setEncoding('utf8')
    res.on('data', chunk => { body += chunk })
    res.on('end', () => resolveResponse({ status: res.statusCode ?? 0, body: JSON.parse(body) as { error?: { request_id?: string } } }))
  })
  return { write: chunk => req.write(chunk), end: chunk => req.end(chunk), response }
}

describe('REVIEW-REQUEST-CONTEXT-03', () => {
  it('keeps request ids isolated while two request bodies complete out of order', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-request-context-'))
    const kernel = new ResearchKernel({ dbPath: join(root, 'kernel.db'), casRoot: join(root, 'cas'), requireSignedManifest: false })
    const { server, url } = await startKernelServer({ kernel, port: 0 })
    try {
      const first = beginJsonPost(url, 'request-A')
      first.write('{')
      const second = beginJsonPost(url, 'request-B')
      second.end('{}')
      const secondResponse = await second.response
      first.end('}')
      const firstResponse = await first.response
      expect(secondResponse.status).toBe(422)
      expect(firstResponse.status).toBe(422)
      expect(secondResponse.body.error?.request_id).toBe('request-B')
      expect(firstResponse.body.error?.request_id).toBe('request-A')
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()))
      kernel.close()
    }
  })
})
