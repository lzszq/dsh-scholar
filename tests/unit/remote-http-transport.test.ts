import { afterEach, describe, expect, it } from 'vitest'
import { createServer, type RequestListener } from 'node:http'
import { HttpRemoteFleetTransport, isSpoolableWireError } from '@dsh-scholar/runner-gateway'

const cleanup: Array<() => Promise<void>> = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close() })
async function transport(handler: RequestListener, timeoutMs = 1000) {
  const server = createServer(handler)
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  cleanup.push(() => new Promise<void>(resolve => { server.close(resolve); server.closeAllConnections() }))
  return new HttpRemoteFleetTransport(`http://127.0.0.1:${(server.address() as { port: number }).port}`, { timeoutMs })
}

describe('remote HTTP response failures', () => {
  it.each(['disconnect', 'timeout'] as const)('retries a %s after successful response headers', async failure => {
    const client = await transport((req, res) => {
      req.resume()
      res.writeHead(200, { 'content-type': 'application/json' })
      res.write('{"schema_version":')
      if (failure === 'disconnect') setTimeout(() => res.destroy(), 20)
    }, failure === 'timeout' ? 100 : 1000)
    const error = await client.heartbeat('agent', { schema_version: 1 }).catch(error => error)
    expect(error).toMatchObject({ code: 'transport_unreachable', retryable: true })
    expect(isSpoolableWireError(error)).toBe(true)
  })

  it.each([429, 500, 502, 503, 504])('retries HTTP %i without a JSON error envelope', async status => {
    const client = await transport((req, res) => { req.resume(); res.writeHead(status); res.end('upstream unavailable') })
    const error = await client.heartbeat('agent', { schema_version: 1 }).catch(error => error)
    expect(error).toMatchObject({ status, retryable: true })
    expect(isSpoolableWireError(error)).toBe(true)
  })

  it('keeps a complete malformed response and an explicit lease rejection terminal', async () => {
    const invalid = await transport((req, res) => { req.resume(); res.end('{') })
    await expect(invalid.heartbeat('agent', { schema_version: 1 })).rejects.toBeInstanceOf(SyntaxError)
    const stale = await transport((req, res) => {
      req.resume()
      res.writeHead(409)
      res.end(JSON.stringify({ error: { code: 'lease_stale', message: 'expired', retryable: true } }))
    })
    const error = await stale.heartbeat('agent', { schema_version: 1 }).catch(error => error)
    expect(isSpoolableWireError(error)).toBe(false)
  })
})
