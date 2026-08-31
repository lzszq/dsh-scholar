/** Shared UI request helpers must never replay non-idempotent writes. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

beforeEach(() => {
  vi.resetModules()
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('UI API write retry policy', () => {
  it('attempts a JSON write only once after a transport failure', async () => {
    const fetchMock = vi.fn(async () => { throw new TypeError('network down') })
    vi.stubGlobal('fetch', fetchMock)
    const { apiResult } = await import('../../packages/dsh-research-ui/src/client/api')

    const result = await apiResult('/v1/settings/transactions', { method: 'POST', body: '{}' })

    expect(result).toMatchObject({ ok: false, status: 0, error: { code: 'network_error' } })
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain('/api/session/csrf')
    expect(String(fetchMock.mock.calls[1]?.[0])).toContain('/v1/settings/transactions')
  })

  it('attempts a multipart POST only once after a transport failure', async () => {
    const fetchMock = vi.fn(async () => { throw new TypeError('network down') })
    vi.stubGlobal('fetch', fetchMock)
    const { apiMultipart } = await import('../../packages/dsh-research-ui/src/client/api')

    const result = await apiMultipart('/v1/projects/rsp_1/uploads', new FormData())

    expect(result).toMatchObject({ ok: false, status: 0, error: { code: 'network_error' } })
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain('/api/session/csrf')
    expect(String(fetchMock.mock.calls[1]?.[0])).toContain('/v1/projects/rsp_1/uploads')
  })

  it('preserves a field key from a rejected settings write', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ csrf_token: 'csrf_test' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        error: {
          code: 'config_value_invalid',
          message: 'expected an integer port',
          key: 'kernel.port',
        },
      }), {
        status: 422,
        headers: { 'content-type': 'application/json' },
      }))
    vi.stubGlobal('fetch', fetchMock)
    const { apiResult } = await import('../../packages/dsh-research-ui/src/client/api')

    const result = await apiResult('/v1/settings/transactions', { method: 'POST', body: '{}' })

    expect(result).toEqual({
      ok: false,
      status: 422,
      error: {
        code: 'config_value_invalid',
        message: 'expected an integer port',
        key: 'kernel.port',
        request_id: undefined,
        retryable: undefined,
      },
    })
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })
})
