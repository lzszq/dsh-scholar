/** Per-request HTTP context and canonical error envelope.
 *
 * AsyncLocalStorage is the authority because request body parsing and domain
 * writes complete asynchronously and may interleave with other requests.
 * A process-global mutable request id would cross-contaminate audit metadata.
 */
import { AsyncLocalStorage } from 'node:async_hooks'
import type { IncomingMessage } from 'node:http'

interface KernelRequestContext {
  requestId: string
}

const requestContext = new AsyncLocalStorage<KernelRequestContext>()
const RETRYABLE_CODES = new Set([
  'lease_conflict', 'lease_stale', 'upload_offset_conflict', 'document_version_conflict',
])

export function requestIdFrom(req: IncomingMessage): string {
  const provided = req.headers['x-request-id']
  return typeof provided === 'string' && provided !== ''
    ? provided
    : `req_${Math.random().toString(36).slice(2, 12)}`
}

export function withKernelRequestContext<T>(req: IncomingMessage, work: () => T): T {
  return requestContext.run({ requestId: requestIdFrom(req) }, work)
}

export function kernelRequestId(): string {
  return requestContext.getStore()?.requestId ?? 'req_unknown'
}

export function errorEnvelope(code: string, message: string): Record<string, unknown> {
  return { code, message, request_id: kernelRequestId(), retryable: RETRYABLE_CODES.has(code) }
}
