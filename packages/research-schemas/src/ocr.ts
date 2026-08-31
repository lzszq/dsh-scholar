/** Durable, intake-scoped OCR request and normalized result contracts. */
import { z } from 'zod'

export const OcrRequestStatus = z.enum(['queued', 'running', 'succeeded', 'failed', 'cancelled'])
export type OcrRequestStatus = z.infer<typeof OcrRequestStatus>

export const OcrRequestCreateInput = z.object({
  source_artifact_id: z.string().regex(/^sha256:[0-9a-f]{64}$/),
  provider_id: z.string().min(1).max(128),
  model_id: z.string().min(1).max(256),
  pages: z.array(z.number().int().positive().max(600)).max(600).default([]),
  language: z.string().min(1).max(64).default('auto'),
}).strict()
export type OcrRequestCreateInput = z.infer<typeof OcrRequestCreateInput>

export const OcrSafeError = z.object({
  code: z.enum(['provider_unavailable', 'provider_rejected', 'transport_failed', 'result_invalid', 'source_unavailable']),
  message: z.string().min(1).max(256),
}).strict()
export type OcrSafeError = z.infer<typeof OcrSafeError>

export const OcrRequest = z.object({
  request_id: z.string().regex(/^ocr_[a-z0-9_]+$/),
  project_id: z.string().min(1),
  intake_id: z.string().min(1),
  source_artifact_id: z.string().regex(/^sha256:[0-9a-f]{64}$/),
  source_sha256: z.string().regex(/^[0-9a-f]{64}$/),
  source_media_type: z.string().min(1),
  source_file_name: z.string().min(1),
  provider_id: z.string().min(1),
  model_id: z.string().min(1),
  provider_revision: z.number().int().positive(),
  provider_config_sha256: z.string().regex(/^[0-9a-f]{64}$/),
  binding_revision: z.number().int().positive(),
  pages: z.array(z.number().int().positive()),
  language: z.string().min(1),
  status: OcrRequestStatus,
  result_artifact_id: z.string().nullable(),
  safe_error: OcrSafeError.nullable(),
  idempotency_key: z.string().min(1),
  request_sha256: z.string().regex(/^[0-9a-f]{64}$/),
  attempts: z.number().int().nonnegative(),
  created_at: z.string(),
  updated_at: z.string(),
  started_at: z.string().nullable(),
  finished_at: z.string().nullable(),
}).strict()
export type OcrRequest = z.infer<typeof OcrRequest>

export const OcrNormalizedObservation = z.object({
  page: z.number().int().positive(),
  locator: z.string().min(1).max(1024),
  text: z.string().min(1),
  confidence: z.number().min(0).max(1),
}).strict()
export type OcrNormalizedObservation = z.infer<typeof OcrNormalizedObservation>

export const OcrResultArtifact = z.object({
  artifact_id: z.string().regex(/^sha256:[0-9a-f]{64}$/),
  request_id: z.string().min(1),
  intake_id: z.string().min(1),
  source_artifact_id: z.string().min(1),
  media_type: z.literal('text/markdown'),
  text: z.string(),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  trust: z.literal('observed_unverified'),
  created_at: z.string(),
}).strict()
export type OcrResultArtifact = z.infer<typeof OcrResultArtifact>

export const OcrObservation = OcrNormalizedObservation.extend({
  observation_id: z.string().min(1),
  request_id: z.string().min(1),
  intake_id: z.string().min(1),
  source_artifact_id: z.string().min(1),
  result_artifact_id: z.string().min(1),
  provider_id: z.string().min(1),
  model_id: z.string().min(1),
  provider_revision: z.number().int().positive(),
  provider_config_sha256: z.string().regex(/^[0-9a-f]{64}$/),
  trust: z.literal('observed_unverified'),
  created_at: z.string(),
}).strict()
export type OcrObservation = z.infer<typeof OcrObservation>

export const OcrResult = z.object({
  artifact: OcrResultArtifact,
  observations: z.array(OcrObservation),
}).strict()
export type OcrResult = z.infer<typeof OcrResult>

/** GET projection: status plus normalized result provenance when complete. */
export const OcrRequestView = z.object({
  request: OcrRequest,
  result: OcrResult.nullable(),
}).strict()
export type OcrRequestView = z.infer<typeof OcrRequestView>
