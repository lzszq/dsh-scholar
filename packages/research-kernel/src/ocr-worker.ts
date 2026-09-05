/** Small MinerU worker coordinator; transport and credentials stay injected. */
import {
  OcrNormalizedObservation,
  type OcrNormalizedObservation as OcrNormalizedObservationValue,
  type OcrRequest,
  type OcrSafeError,
} from '@dsh-scholar/research-schemas'

export interface OcrSourceBytes {
  artifact_id: string
  sha256: string
  media_type: string
  file_name: string
  content: Buffer
}

export interface MinerUExtractInput {
  /** Exact persisted request pin; contains no endpoint or secret value. */
  request: OcrRequest
  /** Exact source bytes verified against the persisted source SHA-256. */
  source: OcrSourceBytes
  signal?: AbortSignal
}

export interface MinerUExtractResult {
  /** Normalized Markdown only; raw provider envelopes are never persisted. */
  markdown: string
  observations: OcrNormalizedObservationValue[]
}

export interface MinerUTransportBinding {
  provider_id: 'mineru'
  model_id: string
  provider_revision: number
  provider_config_sha256: string
}

/** The production adapter implements signed upload and polling; tests can
 * inject a deterministic transport at this same boundary. */
export interface MinerUOcrTransport {
  /** Exact configuration used by this adapter; secrets remain inside it. */
  binding: MinerUTransportBinding
  extract(input: MinerUExtractInput): Promise<MinerUExtractResult>
}

export interface OcrWorkerKernelPort {
  claimNextOcrRequest(): OcrRequest | null
  loadOcrSource(request: OcrRequest): OcrSourceBytes
  completeOcrRequest(requestId: string, markdown: string, observations: OcrNormalizedObservationValue[]): OcrRequest
  failOcrRequest(requestId: string, code: OcrSafeError['code']): OcrRequest
  getOcrRequest(intakeId: string, requestId: string): OcrRequest
}

export class MinerUTransportError extends Error {
  constructor(readonly code: 'provider_unavailable' | 'provider_rejected') {
    super(code)
    this.name = 'MinerUTransportError'
  }
}

const SAFE_MESSAGES: Record<OcrSafeError['code'], string> = {
  provider_unavailable: 'The configured OCR provider is unavailable.',
  provider_rejected: 'The configured OCR provider rejected the request.',
  transport_failed: 'The OCR transport failed.',
  result_invalid: 'The OCR provider returned an invalid normalized result.',
  source_unavailable: 'The pinned OCR source is unavailable.',
}

function safeError(error: unknown): OcrSafeError {
  if (error instanceof MinerUTransportError) return { code: error.code, message: SAFE_MESSAGES[error.code] }
  if (typeof error === 'object' && error !== null && 'code' in error && (error as { code?: string }).code === 'ocr_source_unavailable') {
    return { code: 'source_unavailable', message: SAFE_MESSAGES.source_unavailable }
  }
  if (typeof error === 'object' && error !== null && 'code' in error && (error as { code?: string }).code === 'ocr_result_invalid') {
    return { code: 'result_invalid', message: SAFE_MESSAGES.result_invalid }
  }
  if (typeof error === 'object' && error !== null && 'name' in error && (error as { name?: string }).name === 'ZodError') {
    return { code: 'result_invalid', message: SAFE_MESSAGES.result_invalid }
  }
  return { code: 'transport_failed', message: SAFE_MESSAGES.transport_failed }
}

export class MinerUOcrWorker {
  constructor(private readonly kernel: OcrWorkerKernelPort,
    private readonly transport: MinerUOcrTransport | ((request: OcrRequest) => MinerUOcrTransport | Promise<MinerUOcrTransport>)) {}

  /** Run at most one queued request. No other provider/model is selected. */
  async runOnce(signal?: AbortSignal): Promise<OcrRequest | null> {
    if (signal?.aborted) return null
    const request = this.kernel.claimNextOcrRequest()
    if (request === null) return null
    try {
      if (request.provider_id !== 'mineru') throw new MinerUTransportError('provider_unavailable')
      const transport = typeof this.transport === 'function' ? await this.transport(request) : this.transport
      if (signal?.aborted) return null
      const pin = transport.binding
      if (
        pin.provider_id !== request.provider_id
        || pin.model_id !== request.model_id
        || pin.provider_revision !== request.provider_revision
        || pin.provider_config_sha256 !== request.provider_config_sha256
      ) throw new MinerUTransportError('provider_unavailable')
      const source = this.kernel.loadOcrSource(request)
      const output = await transport.extract({ request, source, ...(signal === undefined ? {} : { signal }) })
      if (signal?.aborted) return null
      if (typeof output.markdown !== 'string') throw Object.assign(new Error('invalid OCR markdown'), { name: 'ZodError' })
      const observations = output.observations.map(item => OcrNormalizedObservation.parse(item))
      return this.kernel.completeOcrRequest(request.request_id, output.markdown, observations)
    } catch (error) {
      // Shutdown/cancellation owns durable state. An aborted transport must
      // not write after Kernel.close or overwrite a requeued/cancelled row.
      if (signal?.aborted) return null
      try {
        return this.kernel.failOcrRequest(request.request_id, safeError(error).code)
      } catch (stateError) {
        // Cancellation may race an in-flight transport. The durable state is
        // authoritative; never overwrite it with a late result/failure.
        if (typeof stateError === 'object' && stateError !== null && 'code' in stateError && (stateError as { code?: string }).code === 'ocr_state_conflict') {
          return this.kernel.getOcrRequest(request.intake_id, request.request_id)
        }
        throw stateError
      }
    }
  }
}
