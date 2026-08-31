import { describe, expect, it, vi } from 'vitest'
import { registerRunnerKeyRequired, RunnerKeyRegistrationError } from '../../workers/runner-gateway/src/runner-key-registration.js'

describe('runner manifest key registration is a required startup fence', () => {
  it('fails immediately when the canonical route is missing instead of entering compatibility mode', async () => {
    const client = {
      registerRunnerKey: vi.fn().mockRejectedValue(Object.assign(new Error('old kernel'), { status: 404 })),
    }
    await expect(registerRunnerKeyRequired(client, {
      keyId: 'runner-key', publicKeyPem: 'pem', maxWaitMs: 10_000, retryDelayMs: 1,
    })).rejects.toMatchObject({ code: 'runner_key_route_unavailable' })
    expect(client.registerRunnerKey).toHaveBeenCalledTimes(1)
  })

  it('retries transient failure and returns only after the key is registered', async () => {
    const client = {
      registerRunnerKey: vi.fn()
        .mockRejectedValueOnce(Object.assign(new Error('temporary'), { status: 503 }))
        .mockResolvedValueOnce({ key_id: 'runner-key' }),
    }
    await registerRunnerKeyRequired(client, {
      keyId: 'runner-key', publicKeyPem: 'pem', maxWaitMs: 100, retryDelayMs: 1,
    })
    expect(client.registerRunnerKey).toHaveBeenCalledTimes(2)
  })

  it('returns a stable safe failure after the bounded wait', async () => {
    const client = {
      registerRunnerKey: vi.fn().mockRejectedValue(new Error('/home/user/private.pem secret=abc')),
    }
    await expect(registerRunnerKeyRequired(client, {
      keyId: 'runner-key', publicKeyPem: 'pem', maxWaitMs: 0, retryDelayMs: 1,
    })).rejects.toEqual(expect.objectContaining<Partial<RunnerKeyRegistrationError>>({
      code: 'runner_key_registration_failed',
      message: 'runner manifest key registration failed',
    }))
  })
})
