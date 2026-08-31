/**
 * Kernel infrastructure schemas: gates/decisions, artifacts (CAS), durable
 * jobs, budget ledger and the append-only event outbox (design §4.2, §5.2,
 * §8.3).
 * @module @dsh-scholar/research-schemas
 */

import { z } from 'zod'
import { KernelEventKind } from './project.js'

/** Human gate kinds (design §5.2). */
export const GateType = z.enum(['scope', 'idea', 'contract', 'budget', 'release', 'direction'])
export type GateType = z.infer<typeof GateType>

/** A pending human gate attached to a project. */
export const Gate = z.object({
  gate_id: z.string().regex(/^gate_[a-z0-9_]+$/),
  project_id: z.string().min(1),
  type: GateType,
  title: z.string().min(1),
  summary: z.string().default(''),
  payload: z.record(z.unknown()).default({}),
  status: z.enum(['pending', 'approved', 'rejected', 'revised']).default('pending'),
  dsh_session_id: z.string().nullable().default(null),
  dsh_event_id: z.string().nullable().default(null),
  created_at: z.string(),
  decided_at: z.string().nullable().default(null),
})
export type Gate = z.infer<typeof Gate>

/** Append-only human decision record (v2 §6.4: authenticated principal, diff, reason kept forever). */
export const Decision = z.object({
  decision_id: z.string().min(1),
  gate_id: z.string().min(1),
  project_id: z.string().min(1),
  gate_type: GateType,
  /** v2: authenticated human principal; 'legacy_unverified' marks pre-v2 rows. */
  actor: z.string().min(1),
  principal: z.object({
    principal_id: z.string().min(1),
    tenant_id: z.string().default(''),
    auth_method: z.string().default('dsh-session'),
    session_id: z.string().nullable().default(null),
  }).optional(),
  decision: z.enum(['approved', 'rejected', 'revised']),
  reason: z.string().default(''),
  diff: z.string().default(''),
  session_id: z.string().nullable().default(null),
  event_id: z.string().nullable().default(null),
  decided_at: z.string(),
})
export type Decision = z.infer<typeof Decision>

/** Artifact kinds in the CAS registry. */
export const ArtifactKind = z.enum(['code', 'pdf', 'data', 'log', 'model', 'chart', 'paper', 'analysis', 'manifest', 'bundle', 'tex-source', 'bib', 'compile-log', 'compile-aux'])
export type ArtifactKind = z.infer<typeof ArtifactKind>

/** Content-addressed artifact registry record (design §4.2 Artifact Registry). */
export const ArtifactRecord = z.object({
  artifact_id: z.string().min(1), // sha256:<hex>
  project_id: z.string().min(1),
  kind: ArtifactKind,
  size_bytes: z.number().int().nonnegative(),
  sha256: z.string().min(1),
  metadata: z.record(z.unknown()).default({}),
  /** RFC 2046 media type served on GET (ART-02); pdf artifacts are application/pdf. */
  media_type: z.string().default('application/octet-stream'),
  /** Download file name for Content-Disposition (null when unknown). */
  file_name: z.string().nullable().default(null),
  created_at: z.string(),
})
export type ArtifactRecord = z.infer<typeof ArtifactRecord>

/** Durable job state — the runner authority across process restarts (design §4.6.1, §9.3). */
export const JobStatus = z.enum(['queued', 'running', 'succeeded', 'failed', 'cancelled', 'retryable'])
export type JobStatus = z.infer<typeof JobStatus>

/** Durable runner job with lease/heartbeat/idempotency (design §4.2 Job Controller). */
export const JobRecord = z.object({
  job_id: z.string().min(1),
  project_id: z.string().min(1),
  contract_id: z.string().nullable().default(null),
  idempotency_key: z.string().min(1),
  kind: z.enum(['echo', 'smoke', 'baseline', 'pilot', 'formal', 'analysis', 'reproduce', 'latex-compile']),
  command: z.array(z.string()).default([]),
  payload: z.record(z.unknown()).default({}),
  status: JobStatus.default('queued'),
  failure_class: z.enum(['environment', 'resources', 'code_error', 'data_issue', 'no_improvement', 'unstable_results', 'budget_exhausted', 'unknown']).nullable().default(null),
  lease_owner: z.string().nullable().default(null),
  lease_expires_at: z.string().nullable().default(null),
  heartbeat_at: z.string().nullable().default(null),
  /** §12.6: bumped on every claim; old-generation runners are fenced out. */
  lease_generation: z.number().int().nonnegative().nullable().default(null),
  /** §12.6: opaque lease token returned only from the live claim process. */
  lease_token: z.string().nullable().default(null),
  // v2 shape (domain-model.md §9): durable submitter identity — the
  // authenticated principal who submitted the job (BFF-injected
  // x-principal-id, never client-supplied). NULL for legacy rows and
  // internal submissions without a principal.
  created_by_principal_id: z.string().nullable().default(null),
  attempts: z.number().int().nonnegative().default(0),
  max_attempts: z.number().int().positive().default(3),
  run_manifest: z.record(z.unknown()).nullable().default(null),
  error: z.string().default(''),
  created_at: z.string(),
  updated_at: z.string(),
})
export type JobRecord = z.infer<typeof JobRecord>

/** Registered runner Ed25519 public key for RunManifest signing (§12.7). */
export const RunnerKey = z.object({
  key_id: z.string().min(1),
  public_key_pem: z.string().min(1),
  created_at: z.string(),
})
export type RunnerKey = z.infer<typeof RunnerKey>

/** Budget accounting record (design §4.2 Budget & Policy). */
export const BudgetRecord = z.object({
  project_id: z.string().min(1),
  model_cost_usd: z.number().nonnegative().default(0),
  gpu_hours: z.number().nonnegative().default(0),
  api_requests: z.number().int().nonnegative().default(0),
  // v2 shape (domain-model.md §16): storage accounting in bytes, filled at
  // recordUsage time; default 0 keeps legacy ledger rows readable.
  storage_bytes: z.number().int().nonnegative().default(0),
  updated_at: z.string(),
})
export type BudgetRecord = z.infer<typeof BudgetRecord>

/**
 * One append-only kernel event — §16 outbox canonical envelope (EVENT-01):
 * `{event_id, event_seq, event_version, project_id, kind, aggregate_type,
 * aggregate_id, aggregate_revision, source, request_id, session_id?, payload,
 * created_at}` plus delivery bookkeeping. SQLite allocates
 * event_seq = per-aggregate max+1 inside the write transaction; consumers
 * dedupe by event_id and record attempts/last_error/next_attempt_at (20
 * attempts → dead_lettered_at, event kept).
 */
export const KernelEvent = z.object({
  event_id: z.string().min(1),
  project_id: z.string().nullable().default(null),
  kind: KernelEventKind,
  payload: z.record(z.unknown()).default({}),
  source: z.string().default('kernel'),
  delivered: z.boolean().default(false),
  created_at: z.string(),
  /** §16: monotonic within one aggregate (NULL bucket for aggregate-less events). */
  event_seq: z.number().int().nonnegative().optional(),
  event_version: z.number().int().nonnegative().optional(),
  aggregate_type: z.string().nullable().optional(),
  aggregate_id: z.string().nullable().optional(),
  aggregate_revision: z.number().int().nullable().optional(),
  request_id: z.string().nullable().optional(),
  session_id: z.string().nullable().optional(),
  attempts: z.number().int().nonnegative().optional(),
  last_error: z.string().nullable().optional(),
  next_attempt_at: z.string().nullable().optional(),
  dead_lettered_at: z.string().nullable().optional(),
})
export type KernelEvent = z.infer<typeof KernelEvent>

/** Session↔project mapping (design RSP-006). */
export const SessionLink = z.object({
  session_id: z.string().min(1),
  project_id: z.string().min(1),
  /** Durable authority for session-scoped operations such as PTY. A link
   * without an authenticated principal is not a valid current link. */
  principal_id: z.string().min(1),
  tenant_id: z.string(),
  issuer: z.enum(['standalone', 'dsh-plugin', 'kernel']),
  linked_at: z.string(),
}).strict()
export type SessionLink = z.infer<typeof SessionLink>
