import { beforeEach, describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { lookup } from 'node:dns/promises'
import { request } from 'node:https'
import { requestMinerU, type MinerUHttpInput } from '@dsh-scholar/research-kernel'

vi.mock('node:dns/promises', () => ({ lookup: vi.fn() }))
vi.mock('node:https', () => ({ request: vi.fn() }))
const resolveDns = vi.mocked(lookup)
const connect = vi.mocked(request)
const input = (): MinerUHttpInput => ({ url: 'https://mineru.net/api/v4/file-urls/batch', method: 'POST', maxResponseBytes: 16, signal: new AbortController().signal })
function reply(status = 200, chunks = [Buffer.from('ok')], length?: string) {
  connect.mockImplementation(((_url: URL, options: Record<string, unknown>, callback: (response: EventEmitter) => void) => {
    const req = new EventEmitter() as EventEmitter & { end: () => void }
    req.end = () => queueMicrotask(() => {
      let destroyed = false
      const res = Object.assign(new EventEmitter(), {
        statusCode: status, headers: length === undefined ? {} : { 'content-length': length },
        destroy(error?: Error) { destroyed = true; if (error) this.emit('error', error) },
      })
      callback(res)
      for (const chunk of chunks) if (!destroyed) res.emit('data', chunk)
      if (!destroyed) res.emit('end')
    })
    return req
  }) as never)
}
beforeEach(() => {
  vi.resetAllMocks()
  resolveDns.mockResolvedValue([{ address: '8.8.8.8', family: 4 }] as never)
  reply()
})

describe('MinerU connection-time boundaries', () => {
  it('pins the validated address while keeping the HTTPS hostname and fresh connection', async () => {
    expect(await requestMinerU(input())).toEqual(Buffer.from('ok'))
    expect(resolveDns).toHaveBeenCalledTimes(1)
    const [url, options] = connect.mock.calls[0]! as unknown as [URL, { agent: boolean; lookup: (...args: unknown[]) => void }]
    expect(url.origin).toBe('https://mineru.net')
    expect(options.agent).toBe(false)
    const callback = vi.fn()
    options.lookup('mineru.net', {}, callback)
    expect(callback).toHaveBeenCalledWith(null, '8.8.8.8', 4)
    options.lookup('mineru.net', { all: true }, callback)
    expect(callback).toHaveBeenLastCalledWith(null, [{ address: '8.8.8.8', family: 4 }])
  })

  it('rejects mixed public/private DNS results before opening a socket', async () => {
    resolveDns.mockResolvedValue([{ address: '8.8.8.8', family: 4 }, { address: '127.0.0.1', family: 4 }] as never)
    await expect(requestMinerU(input())).rejects.toMatchObject({ code: 'provider_rejected' })
    expect(connect).not.toHaveBeenCalled()
  })

  it('refuses redirects, declared oversized bodies and oversized streaming bodies', async () => {
    reply(302)
    await expect(requestMinerU(input())).rejects.toMatchObject({ code: 'provider_rejected' })
    expect(connect).toHaveBeenCalledTimes(1)
    reply(200, [], '20000')
    await expect(requestMinerU(input())).rejects.toMatchObject({ code: 'provider_rejected' })
    reply(200, [Buffer.alloc(10), Buffer.alloc(10)])
    await expect(requestMinerU(input())).rejects.toMatchObject({ code: 'provider_rejected' })
  })

  it('never attaches API credentials to an object-storage/CDN request', async () => {
    await expect(requestMinerU({ ...input(), url: 'https://cdn-mineru.openxlab.org.cn/file', headers: { Authorization: 'secret' } }))
      .rejects.toMatchObject({ code: 'provider_rejected' })
    expect(resolveDns).not.toHaveBeenCalled()
    expect(connect).not.toHaveBeenCalled()
  })

  it('can stop during a pending DNS lookup without waiting for the resolver', async () => {
    resolveDns.mockImplementation(() => new Promise(() => {}))
    const stop = new AbortController()
    const pending = requestMinerU({ ...input(), signal: stop.signal })
    stop.abort(new Error('stop now'))
    await expect(pending).rejects.toThrow('stop now')
    expect(connect).not.toHaveBeenCalled()
  })
})
