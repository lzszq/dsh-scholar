import { createHash } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import {
  OcrNormalizedObservation, OcrRequest, OcrResult,
  type OcrNormalizedObservation as OcrNormalizedObservationValue,
  type OcrRequest as OcrRequestValue,
  type OcrResult as OcrResultValue,
  type OcrSafeError,
} from '@dsh-scholar/research-schemas'

export const OCR_DDL = `
CREATE TABLE IF NOT EXISTS ocr_requests (
  request_id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  intake_id TEXT NOT NULL,
  source_artifact_id TEXT NOT NULL,
  source_sha256 TEXT NOT NULL,
  source_media_type TEXT NOT NULL,
  source_file_name TEXT NOT NULL,
  provider_id TEXT NOT NULL,
  model_id TEXT NOT NULL,
  provider_revision INTEGER NOT NULL CHECK (provider_revision > 0),
  provider_config_sha256 TEXT NOT NULL CHECK (length(provider_config_sha256) = 64),
  binding_revision INTEGER NOT NULL CHECK (binding_revision > 0),
  pages_json TEXT NOT NULL CHECK (json_valid(pages_json)),
  language TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('queued','running','succeeded','failed','cancelled')),
  result_artifact_id TEXT,
  safe_error_json TEXT CHECK (safe_error_json IS NULL OR json_valid(safe_error_json)),
  idempotency_key TEXT NOT NULL UNIQUE,
  request_sha256 TEXT NOT NULL CHECK (length(request_sha256) = 64),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  started_at TEXT,
  finished_at TEXT,
  FOREIGN KEY (project_id) REFERENCES projects(project_id)
);
CREATE INDEX IF NOT EXISTS idx_ocr_requests_intake ON ocr_requests(intake_id, created_at, request_id);
CREATE INDEX IF NOT EXISTS idx_ocr_requests_queue ON ocr_requests(status, created_at, request_id);
CREATE TABLE IF NOT EXISTS ocr_result_artifacts (
  request_id TEXT PRIMARY KEY,
  artifact_id TEXT NOT NULL,
  intake_id TEXT NOT NULL,
  source_artifact_id TEXT NOT NULL,
  media_type TEXT NOT NULL CHECK (media_type = 'text/markdown'),
  normalized_text TEXT NOT NULL,
  sha256 TEXT NOT NULL CHECK (length(sha256) = 64),
  trust TEXT NOT NULL CHECK (trust = 'observed_unverified'),
  created_at TEXT NOT NULL,
  FOREIGN KEY (request_id) REFERENCES ocr_requests(request_id)
);
CREATE TABLE IF NOT EXISTS ocr_observations (
  observation_id TEXT PRIMARY KEY,
  request_id TEXT NOT NULL,
  intake_id TEXT NOT NULL,
  source_artifact_id TEXT NOT NULL,
  result_artifact_id TEXT NOT NULL,
  page INTEGER NOT NULL CHECK (page > 0),
  locator TEXT NOT NULL,
  text TEXT NOT NULL,
  confidence REAL NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
  provider_id TEXT NOT NULL,
  model_id TEXT NOT NULL,
  provider_revision INTEGER NOT NULL CHECK (provider_revision > 0),
  provider_config_sha256 TEXT NOT NULL CHECK (length(provider_config_sha256) = 64),
  trust TEXT NOT NULL CHECK (trust = 'observed_unverified'),
  created_at TEXT NOT NULL,
  FOREIGN KEY (request_id) REFERENCES ocr_requests(request_id)
);
CREATE INDEX IF NOT EXISTS idx_ocr_observations_request ON ocr_observations(request_id, page, locator, observation_id);
`

export class OcrStoreError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message)
    this.name = 'OcrStoreError'
  }
}

interface OcrRequestRow {
  request_id: string; project_id: string; intake_id: string; source_artifact_id: string; source_sha256: string
  source_media_type: string; source_file_name: string; provider_id: string; model_id: string; provider_revision: number
  provider_config_sha256: string; binding_revision: number; pages_json: string; language: string; status: string
  result_artifact_id: string | null; safe_error_json: string | null; idempotency_key: string; request_sha256: string
  attempts: number; created_at: string; updated_at: string; started_at: string | null; finished_at: string | null
}

export interface PinnedOcrRequest {
  request_id: string; project_id: string; intake_id: string; source_artifact_id: string; source_sha256: string
  source_media_type: string; source_file_name: string; provider_id: string; model_id: string; provider_revision: number
  provider_config_sha256: string; binding_revision: number; pages: number[]; language: string
  idempotency_key: string; request_sha256: string
}

function now(): string { return new Date().toISOString() }
function parseJson<T>(value: string, fallback: T): T { try { return JSON.parse(value) as T } catch { return fallback } }
const SAFE_ERROR_MESSAGES: Record<OcrSafeError['code'], string> = {
  provider_unavailable: 'The configured OCR provider is unavailable.',
  provider_rejected: 'The configured OCR provider rejected the request.',
  transport_failed: 'The OCR transport failed.',
  result_invalid: 'The OCR provider returned an invalid normalized result.',
  source_unavailable: 'The pinned OCR source is unavailable.',
}

export class OcrStore {
  constructor(readonly db: DatabaseSync) {
    // A process loss cannot prove what a remote provider did. Requeue the
    // exact pinned request; idempotency remains bound to the same row.
    db.prepare("UPDATE ocr_requests SET status = 'queued', started_at = NULL, updated_at = ? WHERE status = 'running'").run(now())
  }

  private fromRow(row: OcrRequestRow): OcrRequestValue {
    const { pages_json, safe_error_json, ...fields } = row
    return OcrRequest.parse({
      ...fields, pages: parseJson(pages_json, []), safe_error: safe_error_json === null ? null : parseJson(safe_error_json, null),
    })
  }

  findByIdempotency(key: string): OcrRequestValue | null {
    const row = this.db.prepare('SELECT * FROM ocr_requests WHERE idempotency_key = ?').get(key) as OcrRequestRow | undefined
    return row === undefined ? null : this.fromRow(row)
  }

  create(input: PinnedOcrRequest): OcrRequestValue {
    const existing = this.findByIdempotency(input.idempotency_key)
    if (existing !== null) {
      if (existing.request_sha256 !== input.request_sha256) throw new OcrStoreError(409, 'idempotency_conflict', 'OCR idempotency key was used for a different request')
      return existing
    }
    const at = now()
    this.db.prepare(`INSERT INTO ocr_requests (
      request_id, project_id, intake_id, source_artifact_id, source_sha256, source_media_type, source_file_name,
      provider_id, model_id, provider_revision, provider_config_sha256, binding_revision, pages_json, language,
      status, result_artifact_id, safe_error_json, idempotency_key, request_sha256, attempts, created_at, updated_at, started_at, finished_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', NULL, NULL, ?, ?, 0, ?, ?, NULL, NULL)`).run(
      input.request_id, input.project_id, input.intake_id, input.source_artifact_id, input.source_sha256,
      input.source_media_type, input.source_file_name, input.provider_id, input.model_id, input.provider_revision,
      input.provider_config_sha256, input.binding_revision, JSON.stringify(input.pages), input.language,
      input.idempotency_key, input.request_sha256, at, at,
    )
    return this.get(input.intake_id, input.request_id)
  }

  get(intakeId: string, requestId: string): OcrRequestValue {
    const row = this.db.prepare('SELECT * FROM ocr_requests WHERE intake_id = ? AND request_id = ?').get(intakeId, requestId) as OcrRequestRow | undefined
    if (row === undefined) throw new OcrStoreError(404, 'ocr_request_not_found', 'OCR request not found')
    return this.fromRow(row)
  }

  cancel(intakeId: string, requestId: string): OcrRequestValue {
    const current = this.get(intakeId, requestId)
    if (current.status === 'cancelled') return current
    if (current.status === 'succeeded' || current.status === 'failed') throw new OcrStoreError(409, 'ocr_state_conflict', `OCR request is ${current.status}`)
    const at = now()
    this.db.prepare("UPDATE ocr_requests SET status = 'cancelled', updated_at = ?, finished_at = ? WHERE request_id = ?").run(at, at, requestId)
    return this.get(intakeId, requestId)
  }

  claimNext(): OcrRequestValue | null {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const row = this.db.prepare("SELECT * FROM ocr_requests WHERE status = 'queued' ORDER BY created_at, request_id LIMIT 1").get() as OcrRequestRow | undefined
      if (row === undefined) { this.db.exec('COMMIT'); return null }
      const at = now()
      this.db.prepare("UPDATE ocr_requests SET status = 'running', attempts = attempts + 1, started_at = ?, updated_at = ? WHERE request_id = ? AND status = 'queued'").run(at, at, row.request_id)
      this.db.exec('COMMIT')
      return this.get(row.intake_id, row.request_id)
    } catch (error) { this.db.exec('ROLLBACK'); throw error }
  }

  complete(requestId: string, markdown: string, observations: OcrNormalizedObservationValue[]): OcrRequestValue {
    const row = this.db.prepare('SELECT * FROM ocr_requests WHERE request_id = ?').get(requestId) as OcrRequestRow | undefined
    if (row === undefined) throw new OcrStoreError(404, 'ocr_request_not_found', 'OCR request not found')
    if (row.status !== 'running') throw new OcrStoreError(409, 'ocr_state_conflict', `OCR request is ${row.status}`)
    const checked = observations.map(value => OcrNormalizedObservation.parse(value))
    const pinnedPages = parseJson<number[]>(row.pages_json, [])
    if (pinnedPages.length > 0 && checked.some(item => !pinnedPages.includes(item.page))) {
      throw new OcrStoreError(422, 'ocr_result_invalid', 'OCR observation is outside the pinned page selection')
    }
    const sha = createHash('sha256').update(markdown, 'utf8').digest('hex')
    const artifactId = `sha256:${sha}`
    const at = now()
    this.db.exec('BEGIN IMMEDIATE')
    try {
      this.db.prepare(`INSERT INTO ocr_result_artifacts
        (request_id, artifact_id, intake_id, source_artifact_id, media_type, normalized_text, sha256, trust, created_at)
        VALUES (?, ?, ?, ?, 'text/markdown', ?, ?, 'observed_unverified', ?)`).run(
        requestId, artifactId, row.intake_id, row.source_artifact_id, markdown, sha, at,
      )
      const insert = this.db.prepare(`INSERT INTO ocr_observations
        (observation_id, request_id, intake_id, source_artifact_id, result_artifact_id, page, locator, text, confidence,
         provider_id, model_id, provider_revision, provider_config_sha256, trust, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'observed_unverified', ?)`)
      checked.forEach((item, index) => insert.run(
        `ocrobs_${requestId.slice(4)}_${index + 1}`, requestId, row.intake_id, row.source_artifact_id, artifactId,
        item.page, item.locator, item.text, item.confidence, row.provider_id, row.model_id, row.provider_revision,
        row.provider_config_sha256, at,
      ))
      this.db.prepare("UPDATE ocr_requests SET status = 'succeeded', result_artifact_id = ?, safe_error_json = NULL, updated_at = ?, finished_at = ? WHERE request_id = ?")
        .run(artifactId, at, at, requestId)
      this.db.exec('COMMIT')
    } catch (error) { this.db.exec('ROLLBACK'); throw error }
    return this.get(row.intake_id, requestId)
  }

  fail(requestId: string, code: OcrSafeError['code']): OcrRequestValue {
    const row = this.db.prepare('SELECT * FROM ocr_requests WHERE request_id = ?').get(requestId) as OcrRequestRow | undefined
    if (row === undefined) throw new OcrStoreError(404, 'ocr_request_not_found', 'OCR request not found')
    if (row.status !== 'running') throw new OcrStoreError(409, 'ocr_state_conflict', `OCR request is ${row.status}`)
    if (!(code in SAFE_ERROR_MESSAGES)) throw new OcrStoreError(422, 'ocr_error_code_invalid', 'OCR failure code is not allowed')
    const at = now()
    const error: OcrSafeError = { code, message: SAFE_ERROR_MESSAGES[code] }
    this.db.prepare("UPDATE ocr_requests SET status = 'failed', safe_error_json = ?, updated_at = ?, finished_at = ? WHERE request_id = ?")
      .run(JSON.stringify(error), at, at, requestId)
    return this.get(row.intake_id, requestId)
  }

  result(intakeId: string, requestId: string): OcrResultValue | null {
    const request = this.get(intakeId, requestId)
    if (request.result_artifact_id === null) return null
    const artifact = this.db.prepare('SELECT * FROM ocr_result_artifacts WHERE request_id = ?').get(requestId) as Record<string, unknown> | undefined
    if (artifact === undefined) throw new OcrStoreError(500, 'ocr_result_corrupt', 'OCR result artifact is missing')
    const observations = this.db.prepare('SELECT * FROM ocr_observations WHERE request_id = ? ORDER BY page, locator, observation_id').all(requestId)
    return OcrResult.parse({
      artifact: {
        artifact_id: artifact.artifact_id, request_id: artifact.request_id, intake_id: artifact.intake_id,
        source_artifact_id: artifact.source_artifact_id, media_type: artifact.media_type,
        text: artifact.normalized_text, sha256: artifact.sha256, trust: artifact.trust, created_at: artifact.created_at,
      },
      observations,
    })
  }
}
