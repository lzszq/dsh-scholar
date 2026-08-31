/** Required Runner manifest-key registration fence. */

export interface RunnerKeyRegistrationClient {
  registerRunnerKey(input: { key_id: string; public_key_pem: string }): Promise<unknown>
}

export class RunnerKeyRegistrationError extends Error {
  constructor(readonly code: 'runner_key_route_unavailable' | 'runner_key_registration_failed') {
    super(code === 'runner_key_route_unavailable'
      ? 'runner manifest key registration route is unavailable'
      : 'runner manifest key registration failed')
  }
}

export interface RunnerKeyRegistrationOptions {
  keyId: string
  publicKeyPem: string
  maxWaitMs: number
  retryDelayMs?: number
}

function statusOf(error: unknown): number | undefined {
  if (typeof error !== 'object' || error === null || !('status' in error)) return undefined
  return typeof error.status === 'number' ? error.status : undefined
}

/**
 * Do not return until the canonical Kernel has accepted the signing key.
 * A missing route is an incompatible deployment, while other failures retry
 * only inside the caller's explicit startup budget. Error text is stable and
 * never includes upstream paths, credentials, or response bodies.
 */
export async function registerRunnerKeyRequired(
  client: RunnerKeyRegistrationClient,
  options: RunnerKeyRegistrationOptions,
): Promise<void> {
  const retryDelayMs = Math.max(1, options.retryDelayMs ?? 1000)
  const deadline = Date.now() + Math.max(0, options.maxWaitMs)
  for (;;) {
    try {
      await client.registerRunnerKey({ key_id: options.keyId, public_key_pem: options.publicKeyPem })
      return
    } catch (error) {
      if (statusOf(error) === 404) {
        throw new RunnerKeyRegistrationError('runner_key_route_unavailable')
      }
      if (Date.now() >= deadline) {
        throw new RunnerKeyRegistrationError('runner_key_registration_failed')
      }
      await new Promise(resolve => setTimeout(resolve, Math.min(retryDelayMs, Math.max(1, deadline - Date.now()))))
    }
  }
}
