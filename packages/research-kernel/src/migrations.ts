/**
 * Explicit, ordered, idempotent schema migrations (storage-migrations.md §8).
 *
 * Every migration has a stable id, a canonical body used for its checksum,
 * and an `up` step that runs inside a transaction. `schema_migrations`
 * records (id, checksum, applied_at, report_json); re-running the same
 * id+checksum is a no-op, a different checksum is a loud fail (released
 * migrations are immutable), and the schema_version meta key is only bumped
 * after every step succeeds. Downgrades are explicit scripts only.
 * @module @dsh-scholar/research-kernel/migrations
 */

import { DatabaseSync } from 'node:sqlite'
import { createHash, randomUUID } from 'node:crypto'
import { PTY_CURRENT_DDL, PTY_DDL, PTY_SESSIONS_TABLE_DDL } from './pty-session.js'
import { WORKSPACE_DDL } from './workspace-store.js'
import { INTAKE_DDL } from './intake.js'
import { TRAJECTORY_DDL } from './trajectory.js'
import { PROVIDER_DDL } from './provider.js'
import { CHUNKED_UPLOAD_DDL } from './chunked-upload.js'
import { REPRODUCTION_DDL } from './reproduction.js'
import { RUNNER_TARGET_DDL, seedBuiltinRunnerTargets } from './runner-target-registry.js'
import { ASSURANCE_DDL } from './assurance-store.js'
import { METHODOLOGY_DDL, RESEARCH_RUN_OUTCOME_DDL } from './methodology-store.js'
import { WRITING_REVIEW_DDL } from './writing-review-store.js'
import { METHODOLOGY_ROLLOUT_DDL } from './rollout-policy.js'
import { OCR_DDL } from './ocr-store.js'
import { CONFIG_WRITE_DDL } from './config-write-store.js'
import { ArtifactCas } from './cas.js'

/** Code-side schema version; bumped only when the migration set grows. */
export const SCHEMA_VERSION = 35

export interface MigrationReport {
  /** Row counts per affected table (legacy import steps). */
  rows?: Record<string, number>
  notes?: string[]
}

/**
 * Runtime context handed to a migration's `up` step (beyond the connection).
 * Only migrations that need it read it; released migrations ignore it, so the
 * optional shape never changes their behavior or checksum.
 */
export interface MigrationContext {
  /**
   * CAS root (migration 0017): lets a migration materialize legacy log text
   * as real content-addressed blobs instead of leaving phantom references.
   * Absent when the caller opened the database without a CAS root — 0017
   * then records a plain marker and never creates an artifact row that would
   * reference a missing blob.
   */
  casRoot?: string
}

export interface Migration {
  id: string
  description: string
  /** Canonical source text for the checksum (SQL text, or the `up` source). */
  body: string
  up: (db: DatabaseSync, report: MigrationReport, ctx?: MigrationContext) => void
}

/** CORRECT-01: gate-specific budget block provenance plus a cross-store
 * Writing patch intent journal. These are new tables in a new migration;
 * released migration bodies remain immutable. */
export const CORRECTNESS_HARDENING_DDL = `
CREATE TABLE IF NOT EXISTS budget_block_provenance (
  gate_id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  resume_to TEXT NOT NULL,
  project_revision INTEGER NOT NULL CHECK (project_revision >= 0),
  payload_sha256 TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (gate_id) REFERENCES gates(gate_id),
  FOREIGN KEY (project_id) REFERENCES projects(project_id)
);
CREATE INDEX IF NOT EXISTS idx_budget_block_provenance_project
  ON budget_block_provenance(project_id, created_at);

CREATE TABLE IF NOT EXISTS writing_patch_intents (
  application_id TEXT PRIMARY KEY,
  proposal_id TEXT NOT NULL UNIQUE,
  project_id TEXT NOT NULL,
  intent_json TEXT NOT NULL CHECK (json_valid(intent_json)),
  state TEXT NOT NULL CHECK (state IN ('pending', 'completed')),
  created_at TEXT NOT NULL,
  completed_at TEXT,
  FOREIGN KEY (project_id) REFERENCES projects(project_id)
);
CREATE INDEX IF NOT EXISTS idx_writing_patch_intents_pending
  ON writing_patch_intents(state, created_at);
`

/** CORRECT-02: process-independent global key namespace for full-auto Gate
 * approval requests. The receipt is stored with the exact canonical digest
 * so replay never has to infer authority from a Gate-local Decision scan. */
export const FULL_AUTO_IDEMPOTENCY_DDL = `
CREATE TABLE IF NOT EXISTS full_auto_gate_idempotency (
  idempotency_key TEXT PRIMARY KEY,
  request_sha256 TEXT NOT NULL CHECK (
    length(request_sha256) = 71
    AND substr(request_sha256, 1, 7) = 'sha256:'
    AND substr(request_sha256, 8) NOT GLOB '*[^0-9a-f]*'
  ),
  project_id TEXT NOT NULL,
  gate_id TEXT NOT NULL,
  expected_project_revision INTEGER NOT NULL CHECK (expected_project_revision >= 0),
  decision_id TEXT NOT NULL UNIQUE,
  receipt_json TEXT NOT NULL CHECK (json_valid(receipt_json)),
  created_at TEXT NOT NULL,
  FOREIGN KEY (project_id) REFERENCES projects(project_id),
  FOREIGN KEY (gate_id) REFERENCES gates(gate_id),
  FOREIGN KEY (decision_id) REFERENCES decisions(decision_id)
);
`

/** REVIEW-UPLOAD-02: mark which upload created a still-isolated Intake
 * artifact. A late session-close abort may then compensate a finalize without
 * deleting an artifact that pre-dated or was deduplicated by that upload. */
const uploadAbortOwnership = (db: DatabaseSync, report: MigrationReport): void => {
  ensureColumn(db, 'upload_sessions', 'owns_artifact', 'INTEGER NOT NULL DEFAULT 0 CHECK (owns_artifact IN (0,1))')
  ensureColumn(db, 'upload_sessions', 'owner_scope_id', 'TEXT')
  ensureColumn(db, 'intake_sessions', 'owner_scope_id', 'TEXT')
  db.exec(`
    CREATE TABLE IF NOT EXISTS chat_scope_tombstones (
      project_id TEXT NOT NULL,
      scope_id TEXT NOT NULL,
      closed_at TEXT NOT NULL,
      PRIMARY KEY (project_id, scope_id),
      FOREIGN KEY (project_id) REFERENCES projects(project_id)
    );
  `)
  if (report.rows === undefined) report.rows = {}
  report.rows.upload_sessions_with_owned_artifact = Number((db.prepare(
    'SELECT COUNT(*) AS n FROM upload_sessions WHERE owns_artifact = 1',
  ).get() as { n: number }).n)
  report.rows.chat_scope_tombstones = Number((db.prepare(
    'SELECT COUNT(*) AS n FROM chat_scope_tombstones',
  ).get() as { n: number }).n)
}

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex')
}

/** Stable checksum of a migration: id + canonical body. */
export function checksumOf(m: Migration): string {
  return sha256(`${m.id}\n${m.body}`)
}

/** Add a column to an existing table if absent (additive migrations). */
export function ensureColumn(db: DatabaseSync, table: string, column: string, ddl: string): void {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as unknown as Array<{ name: string }>
  if (!cols.some(c => c.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`)
  }
}

/** Terminal frames (§4): append-only, monotonic seq, bounded retention. */
export const TERMINAL_DDL = `
CREATE TABLE IF NOT EXISTS terminal_frames (
  job_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  stream_seq INTEGER,
  channel TEXT,
  text TEXT,
  byte_offset INTEGER,
  byte_length INTEGER,
  frame_kind TEXT NOT NULL,
  payload_json TEXT NOT NULL DEFAULT '{}',
  lease_generation INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  PRIMARY KEY (job_id, run_id, seq),
  FOREIGN KEY (job_id) REFERENCES jobs(job_id),
  CHECK (frame_kind IN ('chunk','gap','exit')),
  CHECK (channel IS NULL OR channel IN ('stdout','stderr')),
  CHECK (
    (frame_kind = 'chunk' AND channel IS NOT NULL AND stream_seq IS NOT NULL AND text IS NOT NULL AND byte_offset IS NOT NULL AND byte_length IS NOT NULL)
    OR
    (frame_kind IN ('gap','exit') AND channel IS NULL AND stream_seq IS NULL AND text IS NULL)
  )
);
CREATE INDEX IF NOT EXISTS idx_terminal_job_seq ON terminal_frames(job_id, seq);
CREATE TABLE IF NOT EXISTS terminal_retention (
  job_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  retained_from_seq INTEGER NOT NULL DEFAULT 1,
  total_bytes INTEGER NOT NULL DEFAULT 0,
  dropped_bytes INTEGER NOT NULL DEFAULT 0,
  truncated INTEGER NOT NULL DEFAULT 0 CHECK (truncated IN (0,1)),
  PRIMARY KEY (job_id, run_id)
);
`

/**
 * TeX workspace tables (§5). Also owned by tex-workspace.ts on its own WAL
 * connection; CREATE IF NOT EXISTS keeps both connections in sync.
 */
export const TEX_DDL = `
CREATE TABLE IF NOT EXISTS tex_documents (
  document_id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  root_file TEXT NOT NULL DEFAULT 'paper.tex',
  revision INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS tex_files (
  document_id TEXT NOT NULL,
  path TEXT NOT NULL,
  version INTEGER NOT NULL,
  content TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (document_id, path)
);
CREATE INDEX IF NOT EXISTS idx_tex_files_doc ON tex_files(document_id);
CREATE TABLE IF NOT EXISTS tex_snapshots (
  document_id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  manifest TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (document_id, revision)
);
-- TEX-01 (§4 row 95): frozen, materializable snapshot bytes (parity with the
-- tex-workspace SCHEMA — the Runner compiles these revision-scoped bytes).
CREATE TABLE IF NOT EXISTS tex_snapshot_files (
  document_id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  path TEXT NOT NULL,
  content TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  PRIMARY KEY (document_id, revision, path)
);
CREATE INDEX IF NOT EXISTS idx_tex_snapshot_files_doc ON tex_snapshot_files(document_id, revision);
CREATE TABLE IF NOT EXISTS tex_builds (
  build_id TEXT PRIMARY KEY,
  document_id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  root_file TEXT NOT NULL,
  job_id TEXT,
  status TEXT NOT NULL,
  diagnostics TEXT NOT NULL DEFAULT '[]',
  pdf_artifact TEXT,
  log_artifact TEXT,
  -- TEX-03 (§4 row 96 / execution-runtime.md §12.1): preview flag +
  -- supersede linkage for live preview builds (parity with tex-workspace.ts).
  preview INTEGER NOT NULL DEFAULT 0,
  superseded_by TEXT,
  superseded_at TEXT,
  created_at TEXT NOT NULL,
  finished_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_tex_builds_doc ON tex_builds(document_id);
-- TEX-03: durable debounced preview request (survives kernel restarts).
CREATE TABLE IF NOT EXISTS tex_preview_pending (
  document_id TEXT PRIMARY KEY,
  revision INTEGER NOT NULL,
  root_file TEXT NOT NULL,
  engine TEXT NOT NULL DEFAULT 'pdflatex',
  debounce_ms INTEGER NOT NULL DEFAULT 800,
  requested_at TEXT NOT NULL
);
`

/**
 * 0001 — the full v2 initial schema for an empty database. Kept idempotent
 * (IF NOT EXISTS) so it is also a safe no-op on databases that already
 * carry the v2-preview shape.
 */
const SCHEMA_V2_INITIAL = `
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS projects (
  project_id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  workspace TEXT NOT NULL,
  mode TEXT NOT NULL,
  status TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 0,
  brief TEXT NOT NULL,
  constraints TEXT NOT NULL,
  execution TEXT NOT NULL,
  integrity TEXT NOT NULL,
  session_id TEXT,
  dsh_workspace_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  history TEXT NOT NULL DEFAULT '[]'
);
CREATE TABLE IF NOT EXISTS gates (
  gate_id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  type TEXT NOT NULL,
  title TEXT NOT NULL,
  summary TEXT NOT NULL DEFAULT '',
  payload TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'pending',
  dsh_session_id TEXT,
  dsh_event_id TEXT,
  created_at TEXT NOT NULL,
  decided_at TEXT
);
CREATE TABLE IF NOT EXISTS decisions (
  decision_id TEXT PRIMARY KEY,
  gate_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  gate_type TEXT NOT NULL,
  actor TEXT NOT NULL,
  decision TEXT NOT NULL,
  reason TEXT NOT NULL DEFAULT '',
  diff TEXT NOT NULL DEFAULT '',
  session_id TEXT,
  event_id TEXT,
  decided_at TEXT NOT NULL,
  -- v2 §6.4 authenticated principal (hardening GOV-01): durable identity of
  -- the human operator behind the decision; NULL for legacy rows.
  principal_id TEXT,
  principal_tenant_id TEXT,
  principal_auth_method TEXT,
  principal_session_id TEXT
);
CREATE TABLE IF NOT EXISTS ideas (
  idea_id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  body TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS contracts (
  contract_id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  body TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS corpus_snapshots (
  snapshot_id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  body TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS artifacts (
  artifact_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  sha256 TEXT NOT NULL,
  metadata TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  PRIMARY KEY (project_id, artifact_id)
);
CREATE TABLE IF NOT EXISTS jobs (
  job_id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  contract_id TEXT,
  idempotency_key TEXT NOT NULL,
  kind TEXT NOT NULL,
  command TEXT NOT NULL DEFAULT '[]',
  payload TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL,
  failure_class TEXT,
  lease_owner TEXT,
  lease_expires_at TEXT,
  heartbeat_at TEXT,
  lease_generation INTEGER,
  -- §12.2 JobSpec binding (SCH-EXEC-002): code snapshot materialized by the
  -- Runner from CAS; image_digest/output_contract/data_artifact_ids live in
  -- payload (see ResearchKernel.submitJob).
  code_snapshot_id TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 3,
  run_manifest TEXT,
  error TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS runner_keys (
  key_id TEXT PRIMARY KEY,
  public_key_pem TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS evidence (
  evidence_id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  body TEXT NOT NULL,
  provenance_status TEXT NOT NULL DEFAULT 'legacy_unverified',
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS claims (
  claim_id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  body TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS events (
  event_id TEXT PRIMARY KEY,
  project_id TEXT,
  kind TEXT NOT NULL,
  payload TEXT NOT NULL DEFAULT '{}',
  source TEXT NOT NULL DEFAULT 'kernel',
  delivered INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS session_links (
  session_id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  linked_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS budget (
  project_id TEXT PRIMARY KEY,
  model_cost_usd REAL NOT NULL DEFAULT 0,
  gpu_hours REAL NOT NULL DEFAULT 0,
  api_requests INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS manuscripts (
  manuscript_id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  body TEXT NOT NULL,
  created_at TEXT NOT NULL
);
${TERMINAL_DDL}
CREATE INDEX IF NOT EXISTS idx_gates_project ON gates(project_id);
CREATE INDEX IF NOT EXISTS idx_jobs_project ON jobs(project_id);
-- v2 §3.4 invariant 2: idempotency_key is unique per (project_id, idempotency_key).
CREATE UNIQUE INDEX IF NOT EXISTS idx_jobs_project_idempotency ON jobs(project_id, idempotency_key);
CREATE INDEX IF NOT EXISTS idx_events_project ON events(project_id);
CREATE INDEX IF NOT EXISTS idx_ideas_project ON ideas(project_id);
CREATE INDEX IF NOT EXISTS idx_contracts_project ON contracts(project_id);
CREATE INDEX IF NOT EXISTS idx_claims_project ON claims(project_id);
CREATE INDEX IF NOT EXISTS idx_evidence_project ON evidence(project_id);
`

/**
 * v2 §7.4: artifacts become PROJECT-SCOPED references (the legacy table had
 * artifact_id as the GLOBAL primary key, so the same ID could be reused
 * across projects). Rebuild with a composite PK; colliding IDs get a
 * project-suffixed regeneration so no project loses a record.
 */
function rebuildArtifactsProjectScoped(db: DatabaseSync, report: MigrationReport): void {
  const info = db.prepare(`PRAGMA table_info('artifacts')`).all() as unknown as Array<{ pk: number; name: string }>
  const pkCount = info.filter(c => c.pk > 0).length
  if (pkCount >= 2) return
  const rows = db.prepare('SELECT artifact_id, project_id, kind, size_bytes, sha256, metadata, created_at FROM artifacts').all() as unknown as Array<{
    artifact_id: string; project_id: string; kind: string; size_bytes: number; sha256: string; metadata: string; created_at: string
  }>
  db.exec(`
    DROP TABLE IF EXISTS artifacts_v2;
    CREATE TABLE artifacts_v2 (
      artifact_id TEXT NOT NULL,
      project_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      size_bytes INTEGER NOT NULL,
      sha256 TEXT NOT NULL,
      metadata TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL,
      PRIMARY KEY (project_id, artifact_id)
    );
  `)
  const insert = db.prepare('INSERT INTO artifacts_v2 (artifact_id, project_id, kind, size_bytes, sha256, metadata, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
  const seen = new Set<string>()
  let reborn = 0
  for (const row of rows) {
    let id = row.artifact_id
    const key = `${row.project_id}\u0000${id}`
    if (seen.has(key)) {
      id = `${id}~${sha256(row.project_id).slice(0, 8)}`
      reborn += 1
    }
    seen.add(`${row.project_id}\u0000${id}`)
    insert.run(id, row.project_id, row.kind, row.size_bytes, row.sha256, row.metadata, row.created_at)
  }
  db.exec('DROP TABLE artifacts; ALTER TABLE artifacts_v2 RENAME TO artifacts;')
  if (report.rows === undefined) report.rows = {}
  report.rows.artifacts_migrated = rows.length
  if (reborn > 0) {
    if (report.notes === undefined) report.notes = []
    report.notes.push(`${reborn} cross-project artifact id(s) regenerated with a project suffix`)
  }
}

/**
 * v2 §3.4/§7.2: the v1.5 jobs table carried a GLOBAL unique constraint on
 * idempotency_key, breaking project-scoped idempotency. Rebuild the table
 * (copy -> verify -> atomic rename) when such an index exists; pure v1
 * (3da1392) never had one and is left untouched.
 */
function rebuildJobsProjectScopedUnique(db: DatabaseSync, report: MigrationReport): void {
  const indexes = db.prepare(`PRAGMA index_list('jobs')`).all() as unknown as Array<{ name: string; unique: number; origin: string }>
  const globalUnique = indexes.some(idx => idx.unique === 1 && idx.origin !== 'pk' && idx.name !== 'idx_jobs_project_idempotency')
  if (!globalUnique) return
  const count = (db.prepare('SELECT COUNT(*) AS n FROM jobs').get() as { n: number }).n
  db.exec(`
    DROP TABLE IF EXISTS jobs_v2;
    CREATE TABLE jobs_v2 (
      job_id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      contract_id TEXT,
      idempotency_key TEXT NOT NULL,
      kind TEXT NOT NULL,
      command TEXT NOT NULL DEFAULT '[]',
      payload TEXT NOT NULL DEFAULT '{}',
      status TEXT NOT NULL,
      failure_class TEXT,
      lease_owner TEXT,
      lease_expires_at TEXT,
      heartbeat_at TEXT,
      attempts INTEGER NOT NULL DEFAULT 0,
      max_attempts INTEGER NOT NULL DEFAULT 3,
      run_manifest TEXT,
      error TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      lease_generation INTEGER NOT NULL DEFAULT 0,
      code_snapshot_id TEXT,
      UNIQUE(project_id, idempotency_key)
    );
    INSERT INTO jobs_v2 (job_id, project_id, contract_id, idempotency_key, kind, command, payload, status, failure_class, lease_owner, lease_expires_at, heartbeat_at, attempts, max_attempts, run_manifest, error, created_at, updated_at, lease_generation, code_snapshot_id)
      SELECT job_id, project_id, contract_id, idempotency_key, kind, command, payload, status, failure_class, lease_owner, lease_expires_at, heartbeat_at, attempts, max_attempts, run_manifest, error, created_at, updated_at, COALESCE(lease_generation, 0), code_snapshot_id FROM jobs;
    DROP TABLE jobs;
    ALTER TABLE jobs_v2 RENAME TO jobs;
    CREATE INDEX IF NOT EXISTS idx_jobs_project ON jobs(project_id);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_jobs_project_idempotency ON jobs(project_id, idempotency_key);
  `)
  if (report.rows === undefined) report.rows = {}
  report.rows.jobs_migrated = count
}

/** §9: legacy manuscript strings become the initial TeX workspace document. */
function convertManuscriptsToTex(db: DatabaseSync, report: MigrationReport): void {
  db.exec(TEX_DDL)
  const rows = db.prepare('SELECT manuscript_id, project_id, body, created_at FROM manuscripts').all() as unknown as Array<{
    manuscript_id: string; project_id: string; body: string; created_at: string
  }>
  let converted = 0
  for (const m of rows) {
    const existing = db.prepare('SELECT 1 AS x FROM tex_documents WHERE project_id = ?').get(m.project_id)
    if (existing !== undefined) continue
    const docId = `doc_${sha256(m.manuscript_id).slice(0, 12)}`
    const body = typeof m.body === 'string' && m.body.trim() !== '' ? m.body : '\\documentclass{article}\n\\begin{document}\n% legacy manuscript body was empty\n\\end{document}\n'
    const at = m.created_at ?? new Date().toISOString()
    db.prepare('INSERT INTO tex_documents (document_id, project_id, root_file, revision, created_at, updated_at) VALUES (?, ?, ?, 1, ?, ?)')
      .run(docId, m.project_id, 'paper.tex', at, at)
    db.prepare('INSERT INTO tex_files (document_id, path, version, content, content_hash, created_at) VALUES (?, ?, 1, ?, ?, ?)')
      .run(docId, 'paper.tex', body, sha256(body), at)
    converted += 1
  }
  if (report.rows === undefined) report.rows = {}
  report.rows.manuscripts_converted = converted
}

/**
 * 0002 — import a legacy v1 database (storage-migrations.md §9): durable
 * decision principal, evidence provenance, project-scoped artifacts/jobs,
 * and manuscript strings → initial TeX workspace. Idempotent: every step
 * detects the legacy shape before acting.
 */
const legacyV1Import = (db: DatabaseSync, report: MigrationReport): void => {
  // §9: decisions gain the durable principal; unprovable identities stay NULL.
  ensureColumn(db, 'decisions', 'principal_id', 'TEXT')
  ensureColumn(db, 'decisions', 'principal_tenant_id', 'TEXT')
  ensureColumn(db, 'decisions', 'principal_auth_method', 'TEXT')
  ensureColumn(db, 'decisions', 'principal_session_id', 'TEXT')
  // §9: existing evidence is legacy_unverified.
  ensureColumn(db, 'evidence', 'provenance_status', "TEXT NOT NULL DEFAULT 'legacy_unverified'")
  db.prepare("UPDATE evidence SET provenance_status = 'legacy_unverified' WHERE provenance_status IS NULL OR provenance_status = ''").run()
  // §9: jobs gain lease fencing + snapshot binding, project-scoped idempotency.
  ensureColumn(db, 'jobs', 'lease_generation', 'INTEGER')
  ensureColumn(db, 'jobs', 'code_snapshot_id', 'TEXT')
  rebuildJobsProjectScopedUnique(db, report)
  // §9: artifacts become project-scoped records.
  rebuildArtifactsProjectScoped(db, report)
  // §9: manuscript strings become the initial TeX workspace document.
  convertManuscriptsToTex(db, report)
}



/**
 * 0003 — terminal/TeX/i18n capabilities for databases that were created by
 * the early v2 preview code (SCHEMA_VERSION=1 with implicit column fixes).
 * Idempotent: terminal + TeX tables are CREATE IF NOT EXISTS, and column
 * additions check existence first. On current databases this is a no-op.
 *
 * RELEASED-MIGRATION FREEZE: 0003's recorded checksum binds THIS function
 * source, which references the shared TERMINAL_DDL/TEX_DDL constants by
 * name — those constants are therefore part of 0003's released behaviour
 * and must only ever GROW via new migrations + the live stores' own CREATE
 * IF NOT EXISTS convergence, never be edited in place. An earlier attempt
 * to inline a frozen DDL snapshot changed this function source and broke
 * every existing database's recorded checksum ("released migrations are
 * immutable"); it was reverted — checksums are immutable once released.
 */
const terminalTexCapabilities = (db: DatabaseSync, report: MigrationReport): void => {
  db.exec(TERMINAL_DDL)
  db.exec(TEX_DDL)
  ensureColumn(db, 'evidence', 'provenance_status', "TEXT NOT NULL DEFAULT 'legacy_unverified'")
  ensureColumn(db, 'decisions', 'principal_id', 'TEXT')
  ensureColumn(db, 'decisions', 'principal_tenant_id', 'TEXT')
  ensureColumn(db, 'decisions', 'principal_auth_method', 'TEXT')
  ensureColumn(db, 'decisions', 'principal_session_id', 'TEXT')
  ensureColumn(db, 'jobs', 'lease_generation', 'INTEGER')
  ensureColumn(db, 'jobs', 'code_snapshot_id', 'TEXT')
  if (report.rows === undefined) report.rows = {}
  report.rows.capability_tables = 0
}

/**
 * 0007 — project idempotency keys (api-contracts.md §4 /v2): the BFF-scoped
 * Idempotency-Key + request hash are persisted so POST /v2/projects replays
 * return the same project/gate/budget/membership while a different request
 * hash under the same key is a 409.
 */
const projectIdempotencyKeys = (db: DatabaseSync, report: MigrationReport): void => {
  ensureColumn(db, 'projects', 'idempotency_key', 'TEXT')
  ensureColumn(db, 'projects', 'request_hash', 'TEXT')
  db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_projects_idempotency ON projects(idempotency_key) WHERE idempotency_key IS NOT NULL`)
  if (report.rows === undefined) report.rows = {}
  report.rows.projects = (db.prepare('SELECT COUNT(*) AS n FROM projects WHERE idempotency_key IS NOT NULL').get() as { n: number }).n
}

/**
 * 0006 — project membership (API-01 foundation): creator is seeded as the
 * first PI; roles follow reconstruction-contracts.md (last PI cannot be
 * removed or demoted). BFF route-level enforcement lands with the v2
 * migration; the model + APIs are the durable base.
 */
const projectMembers = (db: DatabaseSync, report: MigrationReport): void => {
  db.exec(`
    CREATE TABLE IF NOT EXISTS project_members (
      project_id TEXT NOT NULL,
      principal_id TEXT NOT NULL,
      tenant_id TEXT NOT NULL,
      role TEXT NOT NULL CHECK(role IN ('pi','researcher','operator','auditor','viewer')),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (project_id, principal_id),
      FOREIGN KEY (project_id) REFERENCES projects(project_id)
    );
    CREATE INDEX IF NOT EXISTS idx_members_project ON project_members(project_id);
  `)
  if (report.rows === undefined) report.rows = {}
  report.rows.project_members = (db.prepare('SELECT COUNT(*) AS n FROM project_members').get() as { n: number }).n
}

/**
 * 0005 — authoritative code_snapshots registry (STORE-02): one row per
 * snapshotCodeArchive() call, binding snapshot_id to its archive/manifest
 * artifacts, source description, content hash, file count and size.
 */
const codeSnapshotRegistry = (db: DatabaseSync, report: MigrationReport): void => {
  db.exec(`
    CREATE TABLE IF NOT EXISTS code_snapshots (
      snapshot_id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      archive_artifact_id TEXT NOT NULL,
      manifest_artifact_id TEXT NOT NULL,
      source_json TEXT NOT NULL DEFAULT '{}',
      sha256 TEXT NOT NULL,
      file_count INTEGER NOT NULL,
      size_bytes INTEGER NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_code_snapshots_project ON code_snapshots(project_id, created_at DESC);
  `)
  if (report.rows === undefined) report.rows = {}
  report.rows.code_snapshots = (db.prepare('SELECT COUNT(*) AS n FROM code_snapshots').get() as { n: number }).n
}

/**
 * 0004 — artifact media type (ART-02): RFC 2046 media_type served on GET
 * (pdf artifacts are application/pdf) plus a download file_name. Additive;
 * existing rows keep application/octet-stream / NULL.
 */
const artifactMediaType = (db: DatabaseSync, report: MigrationReport): void => {
  ensureColumn(db, 'artifacts', 'media_type', "TEXT NOT NULL DEFAULT 'application/octet-stream'")
  ensureColumn(db, 'artifacts', 'file_name', 'TEXT')
  if (report.rows === undefined) report.rows = {}
  report.rows.artifacts = (db.prepare('SELECT COUNT(*) AS n FROM artifacts').get() as { n: number }).n
}

/**
 * 0008 — outbox canonical envelope (reconstruction-contracts.md §16,
 * EVENT-01): the append-only events table becomes a durable outbox with
 * per-aggregate `event_seq`, `event_version`, aggregate identity and
 * request/session tracing plus delivery bookkeeping (attempts/last_error/
 * next_attempt_at/dead_lettered_at). Also adds the §3.1 `runs` table (run
 * identity per job attempt — STORE-01 parity) and the durable principal +
 * issuer columns on session_links. Additive and idempotent: fresh databases
 * and databases created by older releases both converge here.
 */
const outboxEnvelope = (db: DatabaseSync, report: MigrationReport): void => {
  // §16 outbox columns (additive; pre-existing rows keep NULLs except the
  // NOT NULL defaults, and event_seq is backfilled below).
  ensureColumn(db, 'events', 'event_seq', 'INTEGER')
  ensureColumn(db, 'events', 'event_version', 'INTEGER NOT NULL DEFAULT 1')
  ensureColumn(db, 'events', 'aggregate_type', 'TEXT')
  ensureColumn(db, 'events', 'aggregate_id', 'TEXT')
  ensureColumn(db, 'events', 'aggregate_revision', 'INTEGER')
  ensureColumn(db, 'events', 'request_id', 'TEXT')
  ensureColumn(db, 'events', 'session_id', 'TEXT')
  ensureColumn(db, 'events', 'attempts', 'INTEGER NOT NULL DEFAULT 0')
  ensureColumn(db, 'events', 'last_error', 'TEXT')
  ensureColumn(db, 'events', 'next_attempt_at', 'TEXT')
  ensureColumn(db, 'events', 'dead_lettered_at', 'TEXT')
  // Backfill event_seq for rows written before the outbox envelope (one-time
  // and idempotent: only NULL seqs are touched). Ordering by (created_at,
  // event_id) keeps replays stable across re-runs.
  const rows = db.prepare('SELECT event_id FROM events WHERE event_seq IS NULL ORDER BY created_at, event_id')
    .all() as unknown as Array<{ event_id: string }>
  const updateSeq = db.prepare('UPDATE events SET event_seq = ? WHERE event_id = ?')
  let seq = (db.prepare('SELECT COALESCE(MAX(event_seq), 0) AS m FROM events').get() as { m: number }).m
  for (const row of rows) {
    seq += 1
    updateSeq.run(seq, row.event_id)
  }
  // §16: same-aggregate revisions are ordered by event_seq (per-aggregate
  // monotonic; NULL aggregates are their own bucket — SQLite treats NULLs as
  // distinct in unique indexes, and the kernel allocates max+1 per bucket).
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_events_aggregate_seq ON events(aggregate_type, aggregate_id, event_seq)')
  // §3.1 parity (STORE-01): runs identity per job attempt; the doc creates
  // one row at claim time and keeps every retry attempt.
  db.exec(`
    CREATE TABLE IF NOT EXISTS runs (
      run_id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      job_id TEXT NOT NULL,
      attempt_no INTEGER NOT NULL CHECK (attempt_no > 0),
      contract_id TEXT,
      snapshot_sha256 TEXT NOT NULL,
      manifest_json TEXT,
      signature_status TEXT NOT NULL DEFAULT 'pending',
      started_at TEXT NOT NULL,
      finished_at TEXT,
      UNIQUE (job_id, attempt_no)
    );
    CREATE INDEX IF NOT EXISTS idx_runs_project ON runs(project_id, started_at DESC);
    CREATE INDEX IF NOT EXISTS idx_runs_job ON runs(job_id);
  `)
  // §3.1 parity: session_links carry the durable principal + issuer (NULL for
  // legacy rows whose identity cannot be proven).
  ensureColumn(db, 'session_links', 'principal_id', 'TEXT')
  ensureColumn(db, 'session_links', 'tenant_id', 'TEXT')
  ensureColumn(db, 'session_links', 'issuer', 'TEXT')
  if (report.rows === undefined) report.rows = {}
  report.rows.events_seq_backfilled = rows.length
  report.rows.runs = (db.prepare('SELECT COUNT(*) AS n FROM runs').get() as { n: number }).n
}

/**
 * 0009 — runs.snapshot_sha256 nullable (RUN-01): the §3.1 runs row is written
 * at CLAIM time, and non-snapshot jobs (echo/smoke) legitimately have no code
 * snapshot. SQLite cannot DROP a NOT NULL constraint in place, so the table
 * is rebuilt with the same shape minus NOT NULL on snapshot_sha256. The
 * rebuild is transactional and idempotent (only runs the first time the
 * constraint is detected).
 */
const runsSnapshotNullable = (db: DatabaseSync, report: MigrationReport): void => {
  const has = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'runs'").get() as { sql?: string } | undefined
  if (has?.sql !== undefined && /snapshot_sha256\s+TEXT\s+NOT NULL/.test(has.sql)) {
    db.exec(`
      CREATE TABLE runs_new (
        run_id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        job_id TEXT NOT NULL,
        attempt_no INTEGER NOT NULL CHECK (attempt_no > 0),
        contract_id TEXT,
        snapshot_sha256 TEXT,
        manifest_json TEXT,
        signature_status TEXT NOT NULL DEFAULT 'pending',
        started_at TEXT NOT NULL,
        finished_at TEXT,
        UNIQUE (job_id, attempt_no)
      );
      INSERT INTO runs_new (run_id, project_id, job_id, attempt_no, contract_id, snapshot_sha256, manifest_json, signature_status, started_at, finished_at)
        SELECT run_id, project_id, job_id, attempt_no, contract_id, snapshot_sha256, manifest_json, signature_status, started_at, finished_at FROM runs;
      DROP TABLE runs;
      ALTER TABLE runs_new RENAME TO runs;
    `)
  }
  db.exec('CREATE INDEX IF NOT EXISTS idx_runs_project ON runs(project_id, started_at DESC)')
  db.exec('CREATE INDEX IF NOT EXISTS idx_runs_job ON runs(job_id)')
  if (report.rows === undefined) report.rows = {}
  report.rows.runs = (db.prepare('SELECT COUNT(*) AS n FROM runs').get() as { n: number }).n
}

/**
 * 0010 — TEX-03 (execution-runtime.md §12.1): live LaTeX preview build
 * records. tex_builds gains the preview flag + supersede linkage
 * (superseded_by/superseded_at) and the durable debounced preview request
 * table (tex_preview_pending) so preview state survives kernel restarts and
 * UI reconnects. Additive and idempotent: columns are ensured by name, the
 * pending table is CREATE IF NOT EXISTS, and existing latex-compile rows
 * stay authoritative (preview=0 default).
 */
const previewBuilds = (db: DatabaseSync, report: MigrationReport): void => {
  ensureColumn(db, 'tex_builds', 'preview', 'INTEGER NOT NULL DEFAULT 0')
  ensureColumn(db, 'tex_builds', 'superseded_by', 'TEXT')
  ensureColumn(db, 'tex_builds', 'superseded_at', 'TEXT')
  db.exec(`
    CREATE TABLE IF NOT EXISTS tex_preview_pending (
      document_id TEXT PRIMARY KEY,
      revision INTEGER NOT NULL,
      root_file TEXT NOT NULL,
      engine TEXT NOT NULL DEFAULT 'pdflatex',
      debounce_ms INTEGER NOT NULL DEFAULT 800,
      requested_at TEXT NOT NULL
    );
  `)
  if (report.rows === undefined) report.rows = {}
  report.rows.tex_builds = (db.prepare('SELECT COUNT(*) AS n FROM tex_builds').get() as { n: number }).n
  report.rows.tex_preview_pending = (db.prepare('SELECT COUNT(*) AS n FROM tex_preview_pending').get() as { n: number }).n
}

/**
 * 0011 — PTY-01 + WORK-01 (execution-runtime.md §6.1, api-contracts.md
 * §17/§18): durable Interactive Terminal sessions/frames and the generic
 * VS Code-style workspace (nodes + op ledger). The DDL is shared with the
 * store modules (pty-session.ts / workspace-store.ts) so the kernel
 * migration runner and the stores' own WAL connections converge on the same
 * shape — CREATE IF NOT EXISTS + additive columns keep it idempotent on
 * databases from older releases.
 */
const ptyAndWorkspaceTables = (db: DatabaseSync, report: MigrationReport): void => {
  db.exec(PTY_DDL)
  db.exec(WORKSPACE_DDL)
  if (report.rows === undefined) report.rows = {}
  report.rows.pty_sessions = (db.prepare('SELECT COUNT(*) AS n FROM pty_sessions').get() as { n: number }).n
  report.rows.pty_frames = (db.prepare('SELECT COUNT(*) AS n FROM pty_frames').get() as { n: number }).n
  report.rows.workspaces = (db.prepare('SELECT COUNT(*) AS n FROM workspaces').get() as { n: number }).n
  report.rows.workspace_nodes = (db.prepare('SELECT COUNT(*) AS n FROM workspace_nodes').get() as { n: number }).n
  report.rows.workspace_ops = (db.prepare('SELECT COUNT(*) AS n FROM workspace_ops').get() as { n: number }).n
}

/**
 * STORE-06 current-only credential storage. Released migrations 0014 and
 * 0036 retain their historical intermediate shapes/checksums; this append-only
 * migration removes those shapes after validating every credential first.
 */
const removePlaintextLeaseStorage = (db: DatabaseSync, report: MigrationReport): void => {
  const hasOwn = (value: object, key: string): boolean => Object.prototype.hasOwnProperty.call(value, key)
  let jobsScrubbed = 0
  let jobHashesBackfilled = 0
  const jobRows = db.prepare("SELECT job_id, payload, lease_token_hash FROM jobs WHERE payload LIKE '%__lease_token%'")
    .all() as unknown as Array<{ job_id: string; payload: string; lease_token_hash: string | null }>
  const updateJob = db.prepare('UPDATE jobs SET payload = ?, lease_token_hash = ? WHERE job_id = ?')
  for (const row of jobRows) {
    const parsed = JSON.parse(row.payload) as unknown
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed) || !hasOwn(parsed, '__lease_token')) continue
    const payload = parsed as Record<string, unknown>
    const token = payload.__lease_token
    if (typeof token !== 'string' || token.length === 0) {
      throw new Error(`migration 0038: job ${row.job_id} has an invalid plaintext lease token`)
    }
    const expectedHash = sha256(token)
    let storedHash = row.lease_token_hash
    if (storedHash === null || storedHash === '') {
      storedHash = expectedHash
      jobHashesBackfilled += 1
    } else if (!/^[0-9a-f]{64}$/.test(storedHash) || storedHash !== expectedHash) {
      throw new Error(`migration 0038: job ${row.job_id} plaintext lease token conflicts with its hash`)
    }
    delete payload.__lease_token
    updateJob.run(JSON.stringify(payload), storedHash, row.job_id)
    jobsScrubbed += 1
  }

  const scrubManifest = (raw: string, tokenHash: string | null, label: string): { json: string; tokenHash: string; scrubbed: boolean } => {
    const parsed = JSON.parse(raw) as unknown
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new Error(`migration 0038: ${label} is not a JSON object`)
    }
    const manifest = parsed as Record<string, unknown>
    const lease = manifest.lease
    if (typeof lease !== 'object' || lease === null || Array.isArray(lease) || !hasOwn(lease, 'token')) {
      if (tokenHash === null || tokenHash === '' || !/^[0-9a-f]{64}$/.test(tokenHash)) {
        return { json: raw, tokenHash: tokenHash ?? '', scrubbed: false }
      }
      return { json: raw, tokenHash, scrubbed: false }
    }
    const leaseRecord = lease as Record<string, unknown>
    const token = leaseRecord.token
    if (typeof token !== 'string' || token.length === 0) {
      throw new Error(`migration 0038: ${label} has an invalid plaintext lease token`)
    }
    const expectedHash = sha256(token)
    let storedHash = tokenHash
    if (storedHash === null || storedHash === '') {
      storedHash = expectedHash
      jobHashesBackfilled += 1
    } else if (!/^[0-9a-f]{64}$/.test(storedHash) || storedHash !== expectedHash) {
      throw new Error(`migration 0038: ${label} plaintext lease token conflicts with its Job hash`)
    }
    delete leaseRecord.token
    delete manifest.signature
    delete manifest.runner_key_id
    delete manifest.payload_sha256
    return { json: JSON.stringify(manifest), tokenHash: storedHash, scrubbed: true }
  }

  let jobManifestsScrubbed = 0
  const manifestJobs = db.prepare("SELECT job_id, run_manifest, lease_token_hash FROM jobs WHERE run_manifest LIKE '%\"token\"%'")
    .all() as unknown as Array<{ job_id: string; run_manifest: string; lease_token_hash: string | null }>
  const updateJobManifest = db.prepare("UPDATE jobs SET run_manifest = ?, lease_token_hash = ?, signature_status = 'credential_redacted' WHERE job_id = ?")
  for (const row of manifestJobs) {
    const scrubbed = scrubManifest(row.run_manifest, row.lease_token_hash, `job ${row.job_id} run_manifest`)
    if (!scrubbed.scrubbed) continue
    updateJobManifest.run(scrubbed.json, scrubbed.tokenHash, row.job_id)
    jobManifestsScrubbed += 1
  }

  let runManifestsScrubbed = 0
  const manifestRuns = db.prepare(`
    SELECT runs.run_id, runs.job_id, runs.manifest_json, jobs.lease_token_hash
    FROM runs JOIN jobs ON jobs.job_id = runs.job_id
    WHERE runs.manifest_json LIKE '%"token"%'
  `).all() as unknown as Array<{ run_id: string; job_id: string; manifest_json: string; lease_token_hash: string | null }>
  const updateRunManifest = db.prepare("UPDATE runs SET manifest_json = ?, signature_status = 'credential_redacted' WHERE run_id = ?")
  const markRunJobRedacted = db.prepare("UPDATE jobs SET lease_token_hash = ?, signature_status = 'credential_redacted' WHERE job_id = ?")
  for (const row of manifestRuns) {
    const scrubbed = scrubManifest(row.manifest_json, row.lease_token_hash, `run ${row.run_id} manifest_json`)
    if (!scrubbed.scrubbed) continue
    updateRunManifest.run(scrubbed.json, row.run_id)
    markRunJobRedacted.run(scrubbed.tokenHash, row.job_id)
    runManifestsScrubbed += 1
  }

  const ptyColumns = (db.prepare("PRAGMA table_info('pty_sessions')").all() as unknown as Array<{ name: string }>).map(column => column.name)
  let ptyHashesBackfilled = 0
  const ptyRows = (ptyColumns.includes('lease_token')
    ? db.prepare('SELECT pty_session_id, lease_token, lease_token_hash FROM pty_sessions').all()
    : db.prepare('SELECT pty_session_id, NULL AS lease_token, lease_token_hash FROM pty_sessions').all()) as unknown as Array<{
      pty_session_id: string
      lease_token: string | null
      lease_token_hash: string
    }>
  const updatePtyHash = db.prepare('UPDATE pty_sessions SET lease_token_hash = ? WHERE pty_session_id = ?')
  for (const row of ptyRows) {
    let storedHash = row.lease_token_hash
    if (row.lease_token !== null) {
      if (row.lease_token.length === 0) {
        throw new Error(`migration 0038: PTY ${row.pty_session_id} has an invalid plaintext lease token`)
      }
      const expectedHash = sha256(row.lease_token)
      if (storedHash === '') {
        storedHash = expectedHash
        updatePtyHash.run(storedHash, row.pty_session_id)
        ptyHashesBackfilled += 1
      } else if (!/^[0-9a-f]{64}$/.test(storedHash) || storedHash !== expectedHash) {
        throw new Error(`migration 0038: PTY ${row.pty_session_id} plaintext lease token conflicts with its hash`)
      }
    }
    if (!/^[0-9a-f]{64}$/.test(storedHash)) {
      throw new Error(`migration 0038: PTY ${row.pty_session_id} has no valid lease hash`)
    }
  }
  const sessionsBefore = Number((db.prepare('SELECT COUNT(*) AS n FROM pty_sessions').get() as { n: number }).n)
  const framesBefore = Number((db.prepare('SELECT COUNT(*) AS n FROM pty_frames').get() as { n: number }).n)
  if (ptyColumns.includes('lease_token')) {
    db.exec(`
      DROP TABLE IF EXISTS pty_sessions_v0037;
      ALTER TABLE pty_sessions RENAME TO pty_sessions_v0037;
      DROP INDEX IF EXISTS idx_pty_sessions_project;
      DROP INDEX IF EXISTS idx_pty_sessions_context;
    `)
    db.exec(PTY_CURRENT_DDL)
    db.exec(`
      INSERT INTO pty_sessions (
        pty_session_id, project_id, workspace_id, principal_id, tenant_id,
        context_kind, context_id, parent_session_id, label, purpose,
        profile, target, preset, cwd, config_hash, state, generation,
        lease_token_hash, lease_expires_at, idle_ttl_s, retention_bytes,
        retained_from_seq, last_client_seq, last_event_seq, total_bytes,
        dropped_bytes, adapter_id, open_at, last_activity_at, closed_at,
        close_reason
      )
      SELECT
        pty_session_id, project_id, workspace_id, principal_id, tenant_id,
        context_kind, context_id, parent_session_id, label, purpose,
        profile, target, preset, cwd, config_hash, state, generation,
        lease_token_hash, lease_expires_at, idle_ttl_s, retention_bytes,
        retained_from_seq, last_client_seq, last_event_seq, total_bytes,
        dropped_bytes, adapter_id, open_at, last_activity_at, closed_at,
        close_reason
      FROM pty_sessions_v0037;
      DROP TABLE pty_sessions_v0037;
    `)
  } else {
    db.exec(PTY_CURRENT_DDL)
  }
  const sessionsAfter = Number((db.prepare('SELECT COUNT(*) AS n FROM pty_sessions').get() as { n: number }).n)
  const framesAfter = Number((db.prepare('SELECT COUNT(*) AS n FROM pty_frames').get() as { n: number }).n)
  if (sessionsAfter !== sessionsBefore || framesAfter !== framesBefore) {
    throw new Error(`migration 0038: PTY preservation mismatch sessions ${sessionsBefore}/${sessionsAfter}, frames ${framesBefore}/${framesAfter}`)
  }
  const foreignKeyFailures = db.prepare('PRAGMA foreign_key_check').all()
  if (foreignKeyFailures.length > 0) {
    throw new Error(`migration 0038: foreign key check failed for ${foreignKeyFailures.length} row(s)`)
  }
  report.rows = {
    ...(report.rows ?? {}),
    jobs_scrubbed: jobsScrubbed,
    job_manifests_scrubbed: jobManifestsScrubbed,
    run_manifests_scrubbed: runManifestsScrubbed,
    job_hashes_backfilled: jobHashesBackfilled,
    pty_hashes_backfilled: ptyHashesBackfilled,
    pty_sessions_preserved: sessionsAfter,
    pty_frames_preserved: framesAfter,
  }
  report.notes = ['plaintext lease storage removed; current runtime uses hash-only fencing']
}

/**
 * 0012 — ONBOARD-01 (research-onboarding.md): Research Intake sessions.
 * Four isolated tables (sessions/artifacts/observations/questions) that the
 * pre-accept pipeline may write — business tables stay untouched until the
 * adoption transaction. DDL shared with kernel.ts via INTAKE_DDL (CREATE IF
 * NOT EXISTS keeps it idempotent on databases from older releases).
 */
const intakeTables = (db: DatabaseSync, report: MigrationReport): void => {
  db.exec(INTAKE_DDL)
  if (report.rows === undefined) report.rows = {}
  report.rows.intake_sessions = (db.prepare('SELECT COUNT(*) AS n FROM intake_sessions').get() as { n: number }).n
  report.rows.intake_artifacts = (db.prepare('SELECT COUNT(*) AS n FROM intake_artifacts').get() as { n: number }).n
  report.rows.intake_observations = (db.prepare('SELECT COUNT(*) AS n FROM intake_observations').get() as { n: number }).n
  report.rows.intake_questions = (db.prepare('SELECT COUNT(*) AS n FROM intake_questions').get() as { n: number }).n
}

/**
 * 0013 — TRAJ-01/SUBAGENT-01 (trajectory-subagents.md): standalone safe
 * trajectory projection + subagent topology storage. `child_links` records
 * the durable parent/child topology (research_panel spawns); `child_history`
 * is the append-only per-child ledger (started/state/followup);
 * `child_followups` holds one-shot read-only followup receipts; the
 * `events(project_id,event_seq,event_id)` index keeps 10k-event keyset
 * pagination stable. The projection itself reads the existing `events`
 * outbox — no trajectory copy of business state (Kernel Outbox stays the
 * only authority). DDL shared with trajectory.ts (CREATE IF NOT EXISTS +
 * additive = idempotent on older databases).
 */
const trajectoryAndTopologyTables = (db: DatabaseSync, report: MigrationReport): void => {
  db.exec(TRAJECTORY_DDL)
  if (report.rows === undefined) report.rows = {}
  report.rows.child_links = (db.prepare('SELECT COUNT(*) AS n FROM child_links').get() as { n: number }).n
  report.rows.child_history = (db.prepare('SELECT COUNT(*) AS n FROM child_history').get() as { n: number }).n
  report.rows.child_followups = (db.prepare('SELECT COUNT(*) AS n FROM child_followups').get() as { n: number }).n
}

/**
 * 0014 — STORE-06 (storage-migrations.md §4 / domain-model §10.1): lease
 * tokens are stored as sha256 hashes, never plaintext.
 *
 *  - jobs gains `lease_token_hash TEXT`; rows claimed by the PREVIOUS
 *    release carry the plaintext token inside payload.__lease_token, and
 *    0014 backfills the hash from it (existing data is otherwise untouched)
 *    so hash-based fencing covers every leased row.
 *  - pty_sessions is REBUILT (same copy→verify→rename pattern as 0009 for
 *    runs): the released shape had `lease_token TEXT NOT NULL` (plaintext at
 *    rest). The new shape (PTY_SESSIONS_TABLE_DDL, shared with
 *    pty-session.ts) makes the plaintext column nullable — legacy rows keep
 *    their values for audit, with the hash backfilled from them — and adds
 *    `lease_token_hash TEXT NOT NULL DEFAULT ''`, populated at open time.
 *    New sessions persist ONLY the hash; the plaintext token lives in
 *    kernel memory and is handed to the caller at open.
 *
 * Additive + idempotent: fresh databases already carry both shapes (0011
 * executes the CURRENT PTY_DDL, and the pty store does the same on its own
 * connection), so every step detects its precondition before acting.
 */
const leaseTokenHashing = (db: DatabaseSync, report: MigrationReport): void => {
  // jobs: additive hash column + backfill from the legacy payload token.
  ensureColumn(db, 'jobs', 'lease_token_hash', 'TEXT')
  const legacyRows = db.prepare("SELECT job_id, payload FROM jobs WHERE lease_token_hash IS NULL AND payload LIKE '%__lease_token%'")
    .all() as unknown as Array<{ job_id: string; payload: string }>
  const updateHash = db.prepare('UPDATE jobs SET lease_token_hash = ? WHERE job_id = ?')
  let jobsBackfilled = 0
  for (const row of legacyRows) {
    let token: string | null = null
    try {
      const parsed = JSON.parse(row.payload) as { __lease_token?: unknown }
      if (typeof parsed.__lease_token === 'string' && parsed.__lease_token !== '') token = parsed.__lease_token
    } catch {
      // Malformed payload — leave the hash NULL (fencing falls back to the
      // legacy payload-token comparison, which stays a mismatch-free no-op
      // for rows that never carried a token).
    }
    if (token !== null) {
      updateHash.run(sha256(token), row.job_id)
      jobsBackfilled += 1
    }
  }
  // pty_sessions: rebuild only when the legacy plaintext-NOT NULL shape is
  // present (fresh databases already carry PTY_SESSIONS_TABLE_DDL).
  const ptyCols = db.prepare(`PRAGMA table_info('pty_sessions')`).all() as unknown as Array<{ name: string }>
  let ptyRebuilt = 0
  if (!ptyCols.some(c => c.name === 'lease_token_hash')) {
    const legacyPty = db.prepare(
      `SELECT pty_session_id, project_id, workspace_id, principal_id, tenant_id, profile, target, preset, cwd, config_hash,
              state, generation, lease_token, lease_expires_at, idle_ttl_s, retention_bytes, retained_from_seq,
              last_client_seq, last_event_seq, total_bytes, dropped_bytes, adapter_id, open_at, last_activity_at, closed_at, close_reason
       FROM pty_sessions`,
    ).all() as unknown as Array<{
      pty_session_id: string; project_id: string; workspace_id: string; principal_id: string; tenant_id: string
      profile: string; target: string; preset: string; cwd: string; config_hash: string
      state: string; generation: number; lease_token: string | null
      lease_expires_at: string | null; idle_ttl_s: number; retention_bytes: number; retained_from_seq: number
      last_client_seq: number; last_event_seq: number; total_bytes: number; dropped_bytes: number
      adapter_id: string; open_at: string; last_activity_at: string; closed_at: string | null; close_reason: string | null
    }>
    db.exec('DROP TABLE IF EXISTS pty_sessions_new')
    db.exec(PTY_SESSIONS_TABLE_DDL.replace('CREATE TABLE IF NOT EXISTS pty_sessions', 'CREATE TABLE pty_sessions_new'))
    const insert = db.prepare(`INSERT INTO pty_sessions_new (
      pty_session_id, project_id, workspace_id, principal_id, tenant_id, profile, target, preset, cwd, config_hash,
      state, generation, lease_token, lease_token_hash, lease_expires_at, idle_ttl_s, retention_bytes, retained_from_seq,
      last_client_seq, last_event_seq, total_bytes, dropped_bytes, adapter_id, open_at, last_activity_at, closed_at, close_reason)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    for (const r of legacyPty) {
      const token = typeof r.lease_token === 'string' && r.lease_token !== '' ? r.lease_token : null
      insert.run(
        r.pty_session_id, r.project_id, r.workspace_id, r.principal_id, r.tenant_id, r.profile, r.target, r.preset,
        r.cwd, r.config_hash, r.state, r.generation, r.lease_token,
        token !== null ? sha256(token) : '', r.lease_expires_at, r.idle_ttl_s, r.retention_bytes, r.retained_from_seq,
        r.last_client_seq, r.last_event_seq, r.total_bytes, r.dropped_bytes, r.adapter_id, r.open_at,
        r.last_activity_at, r.closed_at, r.close_reason,
      )
    }
    db.exec('DROP TABLE pty_sessions')
    db.exec('ALTER TABLE pty_sessions_new RENAME TO pty_sessions')
    db.exec('CREATE INDEX IF NOT EXISTS idx_pty_sessions_project ON pty_sessions(project_id)')
    ptyRebuilt = legacyPty.length
  }
  if (report.rows === undefined) report.rows = {}
  report.rows.jobs_lease_token_hash_backfilled = jobsBackfilled
  report.rows.pty_sessions_rebuilt = ptyRebuilt
}

/**
 * 0016 — v2 shape alignment (domain-model.md §5/§6/§8/§9/§16): additive
 * columns for the v2-shape group. Both columns are additive + idempotent:
 * legacy rows keep NULL / DEFAULT 0 and read back unchanged; fresh databases
 * already carry the columns via 0001's initial schema? No — 0001 is frozen,
 * so the columns are only added here; the kernel write paths fill them for
 * new rows. Nothing is backfilled: old rows honestly read NULL / 0.
 *
 *  - jobs.created_by_principal_id TEXT — durable submitter identity
 *    (domain-model.md §9); NULL = legacy/internal rows.
 *  - budget.storage_bytes INTEGER NOT NULL DEFAULT 0 — storage accounting
 *    (domain-model.md §16); 0 = legacy rows that predate storage metering.
 */
const v2ShapeAlignment = (db: DatabaseSync, report: MigrationReport): void => {
  ensureColumn(db, 'jobs', 'created_by_principal_id', 'TEXT')
  ensureColumn(db, 'budget', 'storage_bytes', 'INTEGER NOT NULL DEFAULT 0')
  if (report.rows === undefined) report.rows = {}
  report.rows.jobs_created_by_principal_id = Number((db.prepare("SELECT COUNT(*) AS n FROM jobs WHERE created_by_principal_id IS NOT NULL").get() as { n: number }).n)
  report.rows.budget_storage_bytes_rows = Number((db.prepare("SELECT COUNT(*) AS n FROM budget WHERE storage_bytes > 0").get() as { n: number }).n)
}

/** 0017 (MIG-V1) helper: does a run-manifest JSON text carry a non-empty signature? */
function manifestHasSignature(manifestJson: string): boolean {
  try {
    const manifest = JSON.parse(manifestJson) as { signature?: unknown }
    return typeof manifest.signature === 'string' && manifest.signature !== ''
  } catch {
    return false
  }
}

/** 0017 (MIG-V1) helper: deterministic final-log text for a legacy v1 job. */
function composeLegacyLog(
  job: { job_id: string; kind: string; created_at: string; updated_at: string },
  payload: Record<string, unknown>,
): string {
  const lines: string[] = [
    `=== dsh-scholar legacy run (job ${job.job_id}, kind ${job.kind}) ===`,
    `created: ${job.created_at}`,
    `updated: ${job.updated_at}`,
  ]
  const stdout = typeof payload.stdout === 'string' && payload.stdout !== '' ? payload.stdout : null
  const stderr = typeof payload.stderr === 'string' && payload.stderr !== '' ? payload.stderr : null
  const output = typeof payload.output === 'string' && payload.output !== '' ? payload.output : null
  if (stdout !== null) lines.push('', '--- stdout ---', stdout)
  if (stderr !== null) lines.push('', '--- stderr ---', stderr)
  if (output !== null) lines.push('', '--- output ---', output)
  return `${lines.join('\n')}\n`
}

/**
 * 0017 — MIG-V1 (storage-migrations.md §9, final audit §4 #6): the three
 * remaining v1-migration steps. Implemented as an INDEPENDENT migration
 * appended AFTER 0002 — editing 0002 in place would break its released
 * checksum (§8.1) — so 0001–0016 stay byte-identical. Additive + idempotent:
 * every step detects its precondition before acting, so fresh databases,
 * v1-imported databases and databases from older releases converge here
 * without re-marking anything.
 *
 *  - synthetic_fixture — jobs.synthetic_fixture INTEGER NOT NULL DEFAULT 0.
 *    v1 message-only fixture runs (echo/smoke: no real execution, output
 *    lives inline) are marked 1 so audits/statistics can separate fixture
 *    runs from real experiments. The backfill only touches pre-0017 rows
 *    (kind match + still 0); new echo/smoke jobs are written with 1 by
 *    submitJob and non-fixture new rows stay 0.
 *  - unsigned_legacy — jobs.signature_status TEXT (legacy-only column; new
 *    rows keep NULL and stay governed by runs.signature_status). v1
 *    manifests predate signed-manifest enforcement (requireSignedManifest
 *    defaulted on later), so jobs whose run_manifest is present but unsigned
 *    — and non-fixture jobs that succeeded without ANY manifest (RUN-01's
 *    run_manifest_required postdates them) — are marked 'legacy_unsigned':
 *    once "必签 Manifest" defaults on, old data is never misread as a NEW
 *    violation. runs rows finalized 'unsigned' before 0017 (or left
 *    'pending' with an unsigned manifest — an inconsistent legacy shape) are
 *    re-marked the same way; post-0017 runs keep 'pending'/'signed'/'unsigned'.
 *  - legacy log → final log Artifact — jobs.legacy_log_artifact TEXT. v1
 *    stored the one-shot stdout/stderr inline in jobs.payload (string keys
 *    'stdout'/'stderr'/'output'); 0017 turns it into a final log Artifact
 *    (kind='log', real CAS blob, text/plain, metadata legacy_log:true) with
 *    the reference recorded on the job — NO terminal frames are fabricated
 *    (§9 "不伪造 terminal frames"). When the CAS root is unavailable
 *    (runMigrations/openDatabase without casRoot) the job is marked
 *    'legacy:in-payload' instead of materializing an artifact row that would
 *    reference a missing blob (integrity scans would report it).
 */
const v1LegacyMarks = (db: DatabaseSync, report: MigrationReport, ctx?: MigrationContext): void => {
  // ── §9 synthetic_fixture: v1 message-only fixture runs (echo/smoke). ──
  ensureColumn(db, 'jobs', 'synthetic_fixture', 'INTEGER NOT NULL DEFAULT 0')
  const syntheticBackfilled = Number(db.prepare(
    "UPDATE jobs SET synthetic_fixture = 1 WHERE kind IN ('echo','smoke') AND synthetic_fixture = 0",
  ).run().changes)

  // ── §9 unsigned_legacy: manifests predating signed-manifest enforcement. ──
  ensureColumn(db, 'jobs', 'signature_status', 'TEXT')
  const markJob = db.prepare('UPDATE jobs SET signature_status = ? WHERE job_id = ?')
  let jobsMarked = 0
  // (a) jobs whose run_manifest is present but unsigned (every v1 manifest
  // predates signing; status scope avoids queued/running rows).
  const unsignedManifests = db.prepare(
    "SELECT job_id, run_manifest FROM jobs WHERE signature_status IS NULL AND run_manifest IS NOT NULL AND trim(run_manifest) != '' AND status IN ('succeeded','failed')",
  ).all() as unknown as Array<{ job_id: string; run_manifest: string }>
  for (const row of unsignedManifests) {
    if (!manifestHasSignature(row.run_manifest)) {
      markJob.run('legacy_unsigned', row.job_id)
      jobsMarked += 1
    }
  }
  // (b) non-fixture jobs that succeeded without ANY manifest — RUN-01's
  // run_manifest_required postdates them (echo/smoke are exempt by design).
  const noManifestSucceeded = db.prepare(
    "SELECT job_id FROM jobs WHERE signature_status IS NULL AND status = 'succeeded' AND kind NOT IN ('echo','smoke') AND (run_manifest IS NULL OR trim(run_manifest) = '')",
  ).all() as unknown as Array<{ job_id: string }>
  for (const row of noManifestSucceeded) {
    markJob.run('legacy_unsigned', row.job_id)
    jobsMarked += 1
  }
  // (c) runs: every row finalized 'unsigned' (or left 'pending' with an
  // unsigned manifest) before 0017 predates the default-on signing regime.
  const markRun = db.prepare('UPDATE runs SET signature_status = ? WHERE run_id = ?')
  let runsMarked = Number(db.prepare(
    "UPDATE runs SET signature_status = 'legacy_unsigned' WHERE signature_status = 'unsigned'",
  ).run().changes)
  const pendingManifests = db.prepare(
    "SELECT run_id, manifest_json FROM runs WHERE signature_status = 'pending' AND manifest_json IS NOT NULL AND trim(manifest_json) != ''",
  ).all() as unknown as Array<{ run_id: string; manifest_json: string }>
  for (const row of pendingManifests) {
    if (!manifestHasSignature(row.manifest_json)) {
      markRun.run('legacy_unsigned', row.run_id)
      runsMarked += 1
    }
  }

  // ── §9 one-shot v1 logs → final log Artifact (never fake terminal frames). ──
  ensureColumn(db, 'jobs', 'legacy_log_artifact', 'TEXT')
  const cas = ctx?.casRoot !== undefined && ctx.casRoot !== '' ? new ArtifactCas(ctx.casRoot) : null
  const now = new Date().toISOString()
  const logJobs = db.prepare(
    "SELECT job_id, project_id, kind, payload, created_at, updated_at FROM jobs WHERE legacy_log_artifact IS NULL AND (payload LIKE '%stdout%' OR payload LIKE '%stderr%' OR payload LIKE '%output%')",
  ).all() as unknown as Array<{
    job_id: string; project_id: string; kind: string; payload: string; created_at: string; updated_at: string
  }>
  const insertLogArtifact = db.prepare(
    `INSERT OR IGNORE INTO artifacts (artifact_id, project_id, kind, size_bytes, sha256, metadata, media_type, file_name, created_at)
     VALUES (?, ?, 'log', ?, ?, ?, 'text/plain; charset=utf-8', ?, ?)`,
  )
  const setLogRef = db.prepare('UPDATE jobs SET legacy_log_artifact = ? WHERE job_id = ?')
  let materialized = 0
  let markers = 0
  for (const row of logJobs) {
    let payload: Record<string, unknown>
    try {
      payload = JSON.parse(row.payload) as Record<string, unknown>
    } catch {
      // Malformed payload — nothing to convert (the row stays unmarked).
      continue
    }
    const stdout = typeof payload.stdout === 'string' && payload.stdout !== '' ? payload.stdout : null
    const stderr = typeof payload.stderr === 'string' && payload.stderr !== '' ? payload.stderr : null
    const output = typeof payload.output === 'string' && payload.output !== '' ? payload.output : null
    if (stdout === null && stderr === null && output === null) continue
    const text = composeLegacyLog(row, payload)
    const sha = createHash('sha256').update(text, 'utf8').digest('hex')
    const at = row.updated_at ?? row.created_at ?? now
    if (cas !== null) {
      // Content-addressed blob + project-scoped artifact row (same semantics
      // as registerArtifact: INSERT OR IGNORE keeps re-runs idempotent and
      // identical content in the same project shares one artifact).
      cas.put(text)
      insertLogArtifact.run(`sha256:${sha}`, row.project_id, Buffer.byteLength(text, 'utf8'), sha,
        JSON.stringify({
          legacy_log: true, source: 'v1 payload', job_id: row.job_id, kind: row.kind,
          migrated_by: '0017_v1_legacy_marks',
        }),
        `legacy-run-${row.job_id}.log`, at)
      setLogRef.run(`sha256:${sha}`, row.job_id)
      materialized += 1
    } else {
      // No CAS root — record the marker only (a phantom artifact row would
      // poison the STORAGE-07 integrity scan with a missing blob).
      setLogRef.run('legacy:in-payload', row.job_id)
      markers += 1
    }
  }

  if (report.rows === undefined) report.rows = {}
  report.rows.jobs_synthetic_fixture_backfilled = syntheticBackfilled
  report.rows.jobs_legacy_unsigned_marked = jobsMarked
  report.rows.runs_legacy_unsigned_marked = runsMarked
  report.rows.legacy_log_artifacts_materialized = materialized
  report.rows.legacy_log_markers = markers
}

/**
 * 0018 — WORK-01 §5 P2 (hardening-v0.2-status.md §5, storage-migrations.md
 * §10.1): durable workspace quarantine marker for the crash-recovery scan.
 * When `scanWorkspaceIntegrity()` finds a disk/DB inconsistency it cannot
 * provably repair (e.g. a text node whose bytes vanished with no CAS/history
 * copy), the workspace is marked `workspaces.quarantine = <reason>`; every
 * read/write/move/delete is then refused (`workspace_inconsistent`) until
 * the bytes are restored and a later scan reconciles cleanly (which clears
 * the marker). Additive + idempotent: ensureColumn by name; fresh databases
 * get the column here (0011's released WORKSPACE_DDL stays byte-identical
 * per STORE-08), and the live workspace store converges on its own WAL
 * connection with the same existence check.
 */
const workspaceRecoveryQuarantine = (db: DatabaseSync, report: MigrationReport): void => {
  ensureColumn(db, 'workspaces', 'quarantine', 'TEXT')
  if (report.rows === undefined) report.rows = {}
  report.rows.workspaces_quarantined = Number((db.prepare('SELECT COUNT(*) AS n FROM workspaces WHERE quarantine IS NOT NULL AND trim(quarantine) != \'\'').get() as { n: number }).n)
}

/**
 * 0019 — PROJECT-DELETE-01: archived Project deletion is an additive,
 * auditable tombstone. The aggregate row and all evidence/audit references
 * remain in place; ordinary read paths filter deleted_at. A partial unique
 * index makes request replay stable without constraining legacy NULL rows.
 */
const projectDeletionTombstone = (db: DatabaseSync, report: MigrationReport): void => {
  ensureColumn(db, 'projects', 'deleted_at', 'TEXT')
  ensureColumn(db, 'projects', 'deleted_by', 'TEXT')
  ensureColumn(db, 'projects', 'deletion_reason', 'TEXT')
  ensureColumn(db, 'projects', 'deletion_request_id', 'TEXT')
  db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_projects_deletion_request
    ON projects(deletion_request_id) WHERE deletion_request_id IS NOT NULL`)
  if (report.rows === undefined) report.rows = {}
  report.rows.projects_tombstoned = Number((db.prepare(
    'SELECT COUNT(*) AS n FROM projects WHERE deleted_at IS NOT NULL',
  ).get() as { n: number }).n)
}

/** 0020 — name-only Init keeps DRAFT while the canonical Brief is collected. */
const projectBriefStatus = (db: DatabaseSync, report: MigrationReport): void => {
  ensureColumn(db, 'projects', 'brief_status', "TEXT NOT NULL DEFAULT 'confirmed'")
  ensureColumn(db, 'projects', 'brief_confirm_request_id', 'TEXT')
  ensureColumn(db, 'projects', 'brief_confirm_request_hash', 'TEXT')
  db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_projects_brief_confirm_request
    ON projects(brief_confirm_request_id) WHERE brief_confirm_request_id IS NOT NULL;
    CREATE TABLE IF NOT EXISTS project_grill_answers (
      project_id TEXT NOT NULL,
      intake_id TEXT NOT NULL,
      question_code TEXT NOT NULL,
      question_revision INTEGER NOT NULL DEFAULT 1,
      value_json TEXT,
      disposition TEXT NOT NULL DEFAULT 'answered',
      answered_by_principal TEXT NOT NULL,
      answered_at TEXT NOT NULL,
      PRIMARY KEY (project_id, question_code)
    );
    CREATE INDEX IF NOT EXISTS idx_project_grill_answers_intake
      ON project_grill_answers(intake_id, question_code);`)
  db.exec("UPDATE projects SET brief_status = 'confirmed' WHERE brief_status IS NULL OR trim(brief_status) = ''")
  if (report.rows === undefined) report.rows = {}
  report.rows.projects_collecting_brief = Number((db.prepare(
    "SELECT COUNT(*) AS n FROM projects WHERE brief_status = 'collecting'",
  ).get() as { n: number }).n)
}

/**
 * 0021 — INIT-GRILL-02 §3/§4（init-grill-upload-models.md）：批量分块上传
 * 会话（upload_sessions/upload_chunks）与 Model Provider 注册表
 * （model_providers/model_provider_models）+ 项目绑定列。Additive +
 * idempotent：全新数据库直接携带本 DDL；存量库经 ensureColumn 补项目
 * 绑定列（provider 绑定为 NULL = 未绑定）。
 */
const providerAndChunkedUpload = (db: DatabaseSync, report: MigrationReport): void => {
  db.exec(PROVIDER_DDL)
  db.exec(CHUNKED_UPLOAD_DDL)
  // Project Model Binding（只存 opaque provider_id/model_id + 快照）。
  ensureColumn(db, 'projects', 'binding_provider_id', 'TEXT')
  ensureColumn(db, 'projects', 'binding_model_id', 'TEXT')
  ensureColumn(db, 'projects', 'binding_purpose', 'TEXT')
  ensureColumn(db, 'projects', 'binding_provider_revision', 'INTEGER')
  ensureColumn(db, 'projects', 'binding_config_hash', 'TEXT')
  ensureColumn(db, 'projects', 'binding_revision', "INTEGER NOT NULL DEFAULT 0")
  ensureColumn(db, 'projects', 'binding_updated_by', 'TEXT')
  ensureColumn(db, 'projects', 'binding_updated_at', 'TEXT')
  if (report.rows === undefined) report.rows = {}
  report.rows.model_providers = Number((db.prepare('SELECT COUNT(*) AS n FROM model_providers').get() as { n: number }).n)
  report.rows.upload_sessions = Number((db.prepare('SELECT COUNT(*) AS n FROM upload_sessions').get() as { n: number }).n)
  report.rows.projects_bound = Number((db.prepare(
    'SELECT COUNT(*) AS n FROM projects WHERE binding_provider_id IS NOT NULL AND trim(binding_provider_id) != \'\'',
  ).get() as { n: number }).n)
}

/** 0023 — EXEC-ENV-02 configurable local/Docker/remote-SSH target registry. */
const runnerTargetRegistry = (db: DatabaseSync, report: MigrationReport): void => {
  db.exec(RUNNER_TARGET_DDL)
  seedBuiltinRunnerTargets(db)
  if (report.rows === undefined) report.rows = {}
  report.rows.runner_targets = Number((db.prepare('SELECT COUNT(*) AS n FROM runner_targets').get() as { n: number }).n)
}

/**
 * 0022 — REPRO-01 (docs/reproduction-contracts.md §2/§4): the paper
 * reproduction aggregate — reproduction_specs (PaperReproductionSpec rows,
 * revision-CAS'd), reproduction_attempts (generation/lease fencing, token
 * hash only at rest), reproduction_reports (immutable report: the body lives
 * in the CAS, the row keeps body_hash + cas_ref) and reproduction_links
 * (source/material links: paper artifact, code snapshots, data artifacts,
 * contracts, run manifests, reports). Additive + idempotent (CREATE IF NOT
 * EXISTS); fresh databases get the tables here, existing databases converge
 * on re-open.
 */
const reproductionTables = (db: DatabaseSync, report: MigrationReport): void => {
  db.exec(REPRODUCTION_DDL)
  if (report.rows === undefined) report.rows = {}
  report.rows.reproduction_specs = Number((db.prepare('SELECT COUNT(*) AS n FROM reproduction_specs').get() as { n: number }).n)
  report.rows.reproduction_attempts = Number((db.prepare('SELECT COUNT(*) AS n FROM reproduction_attempts').get() as { n: number }).n)
  report.rows.reproduction_reports = Number((db.prepare('SELECT COUNT(*) AS n FROM reproduction_reports').get() as { n: number }).n)
  report.rows.reproduction_links = Number((db.prepare('SELECT COUNT(*) AS n FROM reproduction_links').get() as { n: number }).n)
}

/**
 * 0024 — SUBAGENT-STAGE-02: cancelled is a durable terminal child state.
 * SQLite cannot widen a CHECK constraint in place, so rebuild child_links
 * while preserving ids, timestamps and the child_history/followup FKs.
 */
const topologyCancelledState = (db: DatabaseSync, report: MigrationReport): void => {
  const table = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'child_links'").get() as { sql: string } | undefined
  if (table !== undefined && !table.sql.includes("'cancelled'")) {
    db.exec([
      "CREATE TABLE child_links_0024 (child_id TEXT PRIMARY KEY, project_id TEXT NOT NULL, parent_id TEXT, label TEXT, summary TEXT NOT NULL DEFAULT '', kind TEXT NOT NULL DEFAULT 'subagent', mode TEXT NOT NULL DEFAULT 'one-shot', state TEXT NOT NULL DEFAULT 'running', role TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, ended_at TEXT, FOREIGN KEY (project_id) REFERENCES projects(project_id), CHECK (kind IN ('subagent','task')), CHECK (mode IN ('one-shot','continuable','read-only')), CHECK (state IN ('running','inactive','diagnostic','succeeded','failed','cancelled','redacted','unknown')))",
      "CREATE TABLE child_history_0024 (child_id TEXT NOT NULL, seq INTEGER NOT NULL, event_id TEXT NOT NULL, event_type TEXT NOT NULL, payload TEXT NOT NULL DEFAULT '{}', occurred_at TEXT NOT NULL, PRIMARY KEY (child_id, seq), FOREIGN KEY (child_id) REFERENCES child_links_0024(child_id))",
      "CREATE TABLE child_followups_0024 (message_id TEXT PRIMARY KEY, child_id TEXT NOT NULL, project_id TEXT NOT NULL, request TEXT NOT NULL, request_hash TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'accepted_read_only', created_at TEXT NOT NULL, FOREIGN KEY (child_id) REFERENCES child_links_0024(child_id))",
      'INSERT INTO child_links_0024 (child_id, project_id, parent_id, label, summary, kind, mode, state, role, created_at, updated_at, ended_at) SELECT child_id, project_id, parent_id, label, summary, kind, mode, state, role, created_at, updated_at, ended_at FROM child_links',
      'INSERT INTO child_history_0024 (child_id, seq, event_id, event_type, payload, occurred_at) SELECT child_id, seq, event_id, event_type, payload, occurred_at FROM child_history',
      'INSERT INTO child_followups_0024 (message_id, child_id, project_id, request, request_hash, status, created_at) SELECT message_id, child_id, project_id, request, request_hash, status, created_at FROM child_followups',
      'DROP TABLE child_followups',
      'DROP TABLE child_history',
      'DROP TABLE child_links',
      'ALTER TABLE child_links_0024 RENAME TO child_links',
      'ALTER TABLE child_history_0024 RENAME TO child_history',
      'ALTER TABLE child_followups_0024 RENAME TO child_followups',
      'CREATE INDEX IF NOT EXISTS idx_child_links_project_parent ON child_links(project_id, parent_id)',
      'CREATE INDEX IF NOT EXISTS idx_child_links_parent ON child_links(parent_id)',
      'CREATE INDEX IF NOT EXISTS idx_child_history_seq ON child_history(child_id, seq)',
      'CREATE INDEX IF NOT EXISTS idx_child_followups_child ON child_followups(child_id, created_at)',
    ].join(';\n'))
  }
  const violations = db.prepare('PRAGMA foreign_key_check').all()
  if (violations.length > 0) throw new Error('0024 topology rebuild violated foreign keys')
  if (report.rows === undefined) report.rows = {}
  report.rows.child_links = Number((db.prepare('SELECT COUNT(*) AS n FROM child_links').get() as { n: number }).n)
  report.rows.child_history = Number((db.prepare('SELECT COUNT(*) AS n FROM child_history').get() as { n: number }).n)
  report.rows.child_followups = Number((db.prepare('SELECT COUNT(*) AS n FROM child_followups').get() as { n: number }).n)
}

/** 0025 — typed Docker image/CPU/NVIDIA runtime attached to a runner target. */
const runnerTargetRuntime = (db: DatabaseSync, report: MigrationReport): void => {
  ensureColumn(db, 'runner_targets', 'runtime_json', 'TEXT')
  if (report.rows === undefined) report.rows = {}
  report.rows.runner_targets_with_runtime = Number((db.prepare(
    'SELECT COUNT(*) AS n FROM runner_targets WHERE runtime_json IS NOT NULL',
  ).get() as { n: number }).n)
}

/** 0026 — bind every RunnerTarget heartbeat to a target-scoped service
 * identity. Existing custom targets remain unconfigured and therefore cannot
 * heartbeat until an Operator installs a SecretRef; built-ins receive their
 * fixed instance-secret paths. */
const runnerTargetServiceIdentity = (db: DatabaseSync, report: MigrationReport): void => {
  ensureColumn(db, 'runner_targets', 'service_identity_json', 'TEXT')
  const builtins = [
    { target_id: 'target_local_process_v1', service_identity: { scheme: 'file', name: 'runner-targets/target_local_process_v1.token', scope: 'instance' } },
    { target_id: 'target_local_docker_v1', service_identity: { scheme: 'file', name: 'runner-targets/target_local_docker_v1.token', scope: 'instance' } },
  ]
  for (const target of builtins) {
    db.prepare('UPDATE runner_targets SET service_identity_json=? WHERE target_id=? AND service_identity_json IS NULL')
      .run(JSON.stringify(target.service_identity), target.target_id)
  }
  if (report.rows === undefined) report.rows = {}
  report.rows.runner_targets_with_service_identity = Number((db.prepare(
    'SELECT COUNT(*) AS n FROM runner_targets WHERE service_identity_json IS NOT NULL',
  ).get() as { n: number }).n)
}

/**
 * 0027 — projects created before runner profiles became explicit may carry
 * the removed `runner_profile` label or omit `runner_profile_id`. Normalize
 * every stored value once at the storage boundary. A legacy label is not an
 * executable profile id: it becomes null so readiness remains fail-closed
 * until the operator explicitly selects a current RunnerProfile.
 */
const canonicalizeProjectExecution = (db: DatabaseSync, report: MigrationReport): void => {
  const rows = db.prepare('SELECT project_id, execution FROM projects').all() as Array<{
    project_id: string
    execution: string
  }>
  const update = db.prepare('UPDATE projects SET execution = ? WHERE project_id = ?')
  let normalized = 0
  let malformed = 0
  for (const row of rows) {
    let source: Record<string, unknown> = {}
    try {
      const parsed = JSON.parse(row.execution) as unknown
      if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
        source = parsed as Record<string, unknown>
      } else {
        malformed += 1
      }
    } catch {
      malformed += 1
    }
    const runnerProfileId = typeof source.runner_profile_id === 'string' && source.runner_profile_id.trim() !== ''
      ? source.runner_profile_id
      : null
    const runnerTargetId = typeof source.runner_target_id === 'string' && source.runner_target_id.trim() !== ''
      ? source.runner_target_id
      : 'target_local_docker_v1'
    const networkPolicy = source.network_policy === 'none' ? 'none' : 'allowlist'
    const fixtureId = typeof source.fixture_id === 'string' && source.fixture_id.trim() !== ''
      ? source.fixture_id
      : null
    const canonical = JSON.stringify({
      runner_profile_id: runnerProfileId,
      runner_target_id: runnerTargetId,
      network_policy: networkPolicy,
      artifact_store: 'local-cas',
      fixture_id: fixtureId,
    })
    if (canonical !== row.execution) {
      update.run(canonical, row.project_id)
      normalized += 1
    }
  }
  if (report.rows === undefined) report.rows = {}
  report.rows.projects_normalized = normalized
  report.rows.projects_with_malformed_execution = malformed
  if (malformed > 0) {
    report.notes = [`${malformed} project execution value(s) were malformed and reset to an explicit unconfigured runner profile`]
  }
}

/**
 * 0036 — REVIEW-PTY-CONTEXT-03. Interactive PTYs are transient interface
 * state, never formal research evidence. A context-less historical session
 * cannot be authorized safely, so the upgrade does not infer a context from
 * its project/workspace/owner/profile/target fields. Instead it atomically
 * drops frames then sessions and recreates the current tables. Current,
 * valid context-bound rows are left untouched.
 */
const ptyContextReset = (db: DatabaseSync, report: MigrationReport): void => {
  const tableExists = (table: string): boolean => db.prepare(
    "SELECT 1 FROM sqlite_master WHERE type='table' AND name=?",
  ).get(table) !== undefined
  const rowCount = (table: string): number => tableExists(table)
    ? Number((db.prepare(`SELECT COUNT(*) AS n FROM "${table}"`).get() as { n: number }).n)
    : 0

  const sessionColumns = tableExists('pty_sessions')
    ? (db.prepare("PRAGMA table_info('pty_sessions')").all() as unknown as Array<{ name: string }>).map(column => column.name)
    : []
  const requiredColumns = ['context_kind', 'context_id', 'parent_session_id', 'label', 'purpose']
  let reset = sessionColumns.length > 0 && requiredColumns.some(column => !sessionColumns.includes(column))
  if (!reset && sessionColumns.length > 0) {
    const invalid = Number((db.prepare(`SELECT COUNT(*) AS n FROM pty_sessions
      WHERE context_kind NOT IN ('research','chat','subagent')
         OR context_id IS NULL OR length(context_id) < 1 OR length(context_id) > 256
         OR substr(context_id, 1, 1) NOT GLOB '[A-Za-z0-9]'
         OR context_id GLOB '*[^A-Za-z0-9._:@-]*'
         OR (parent_session_id IS NOT NULL AND (
              length(parent_session_id) < 1 OR length(parent_session_id) > 256
              OR substr(parent_session_id, 1, 1) NOT GLOB '[A-Za-z0-9]'
              OR parent_session_id GLOB '*[^A-Za-z0-9._:@-]*'))
         OR label IS NULL OR length(trim(label)) < 1 OR length(trim(label)) > 96
         OR purpose IS NULL OR length(trim(purpose)) > 512`).get() as { n: number }).n)
    reset = invalid > 0
  }

  const discardedSessions = reset ? rowCount('pty_sessions') : 0
  const discardedFrames = reset ? rowCount('pty_frames') : 0
  if (reset) {
    db.exec('DROP TABLE IF EXISTS pty_frames; DROP TABLE IF EXISTS pty_sessions;')
  }
  db.exec(PTY_DDL)
  if (report.rows === undefined) report.rows = {}
  report.rows.pty_sessions_discarded = discardedSessions
  report.rows.pty_frames_discarded = discardedFrames
  report.rows.pty_sessions = rowCount('pty_sessions')
  report.rows.pty_frames = rowCount('pty_frames')
  report.notes = reset
    ? ['legacy transient PTY sessions and frames were discarded; no context was inferred']
    : ['PTY context schema already current; existing context-bound sessions were preserved']
}

/**
 * Ordered migration registry. Never reorder or edit a released migration:
 * its checksum is recorded in schema_migrations and a mismatch is fatal.
 * New steps append at the end and bump SCHEMA_VERSION.
 */
export const MIGRATIONS: Migration[] = [
  {
    id: '0001_schema_v2_initial',
    description: 'Full v2 initial schema for empty databases (idempotent)',
    body: SCHEMA_V2_INITIAL,
    up: (db) => { db.exec(SCHEMA_V2_INITIAL) },
  },
  {
    id: '0002_import_legacy_v1',
    description: 'Import legacy v1 databases: principal, provenance, project-scoped artifacts/jobs, manuscript → TeX',
    body: legacyV1Import.toString(),
    up: legacyV1Import,
  },
  {
    id: '0003_terminal_tex_i18n_capabilities',
    description: 'Terminal/TeX tables + v2 columns for early v2-preview databases',
    body: terminalTexCapabilities.toString(),
    up: terminalTexCapabilities,
  },
  {
    id: '0004_artifact_media_type',
    description: 'Artifact media_type + file_name columns (ART-02)',
    body: artifactMediaType.toString(),
    up: artifactMediaType,
  },
  {
    id: '0005_code_snapshots',
    description: 'Authoritative code_snapshots registry (STORE-02)',
    body: codeSnapshotRegistry.toString(),
    up: codeSnapshotRegistry,
  },
  {
    id: '0006_project_members',
    description: 'Project membership model (API-01 foundation)',
    body: projectMembers.toString(),
    up: projectMembers,
  },
  {
    id: '0007_project_idempotency_keys',
    description: 'Project Idempotency-Key + request hash columns (v2)',
    body: projectIdempotencyKeys.toString(),
    up: projectIdempotencyKeys,
  },
  {
    id: '0008_outbox_envelope',
    description: 'Outbox canonical envelope (EVENT-01/§16) + runs table + session_links principal (STORE-01)',
    body: outboxEnvelope.toString(),
    up: outboxEnvelope,
  },
  {
    id: '0009_runs_snapshot_nullable',
    description: 'RUN-01: runs.snapshot_sha256 nullable (echo/smoke jobs have no code snapshot)',
    body: runsSnapshotNullable.toString(),
    up: runsSnapshotNullable,
  },
  {
    id: '0010_preview_builds',
    description: 'TEX-03: tex_builds preview/superseded_by/superseded_at + tex_preview_pending (live LaTeX preview)',
    body: previewBuilds.toString(),
    up: previewBuilds,
  },
  {
    id: '0011_pty_workspace',
    description: 'PTY-01 + WORK-01: pty_sessions/pty_frames + workspaces/workspace_nodes/workspace_ops (interface layer)',
    body: ptyAndWorkspaceTables.toString(),
    up: ptyAndWorkspaceTables,
  },
  {
    id: '0012_intake',
    description: 'ONBOARD-01: intake_sessions/intake_artifacts/intake_observations/intake_questions (Research Intake)',
    body: intakeTables.toString(),
    up: intakeTables,
  },
  {
    id: '0013_trajectory_topology',
    description: 'TRAJ-01/SUBAGENT-01: child_links/child_history/child_followups + events(project_id,event_seq,event_id) index (trajectory projection & subagent topology)',
    body: trajectoryAndTopologyTables.toString(),
    up: trajectoryAndTopologyTables,
  },
  {
    id: '0014_lease_token_hash',
    description: 'STORE-06: jobs.lease_token_hash (+ backfill from legacy payload token) + pty_sessions rebuild with lease_token_hash (no plaintext lease tokens at rest)',
    body: leaseTokenHashing.toString(),
    up: leaseTokenHashing,
  },
  {
    id: '0016_v2_shape_alignment',
    description: 'v2 shape: jobs.created_by_principal_id + budget.storage_bytes (additive, idempotent; domain-model §5/§6/§8/§9/§16)',
    body: v2ShapeAlignment.toString(),
    up: v2ShapeAlignment,
  },
  {
    id: '0017_v1_legacy_marks',
    description: 'MIG-V1: v1 legacy marks — jobs.synthetic_fixture (echo/smoke backfill), jobs/runs signature_status=legacy_unsigned, legacy payload log → final log Artifact (CAS) with no terminal frames (storage-migrations.md §9)',
    // STORE-08 rule: the canonical body binds what the migration ACTUALLY
    // executes — the up source PLUS the two helper functions it relies on.
    body: `${v1LegacyMarks.toString()}\n\n${manifestHasSignature.toString()}\n${composeLegacyLog.toString()}`,
    up: v1LegacyMarks,
  },
  {
    id: '0018_workspace_recovery_quarantine',
    description: 'WORK-01 §5 P2: workspaces.quarantine TEXT — durable marker for the crash-recovery scan (scanWorkspaceIntegrity isolates unrepairable workspaces until a later scan reconciles cleanly)',
    body: workspaceRecoveryQuarantine.toString(),
    up: workspaceRecoveryQuarantine,
  },
  {
    id: '0019_project_deletion_tombstone',
    description: 'PROJECT-DELETE-01: archived project tombstone + idempotent deletion request receipt (audit/retention preserving)',
    body: projectDeletionTombstone.toString(),
    up: projectDeletionTombstone,
  },
  {
    id: '0020_project_brief_status',
    description: 'INIT-GRILL-02: additive collecting/confirmed Research Brief lifecycle',
    body: projectBriefStatus.toString(),
    up: projectBriefStatus,
  },
  {
    id: '0021_provider_chunked_upload',
    description: 'INIT-GRILL-02 §3/§4: upload_sessions/upload_chunks (batch chunked upload) + model_providers/model_provider_models (Model Provider registry) + projects model-binding columns',
    body: `${providerAndChunkedUpload.toString()}\n\n${PROVIDER_DDL}\n${CHUNKED_UPLOAD_DDL}`,
    up: providerAndChunkedUpload,
  },
  {
    id: '0022_reproduction_contracts',
    description: 'REPRO-01 (docs/reproduction-contracts.md §2/§4): reproduction_specs / reproduction_attempts / reproduction_reports + reproduction_links (source/material links; report body lives in the CAS — the row keeps hash + ref)',
    body: reproductionTables.toString(),
    up: reproductionTables,
  },
  {
    id: '0023_runner_target_registry',
    description: 'EXEC-ENV-02: configurable local-process/local-docker/remote-ssh runner targets with SecretRef-only connection metadata and revision CAS',
    body: `${runnerTargetRegistry.toString()}\n\n${RUNNER_TARGET_DDL}\n${seedBuiltinRunnerTargets.toString()}`,
    up: runnerTargetRegistry,
  },
  {
    id: '0024_topology_cancelled_state',
    description: 'SUBAGENT-STAGE-02: cancelled child topology state + rebuilt CHECK constraint',
    body: topologyCancelledState.toString(),
    up: topologyCancelledState,
  },
  {
    id: '0025_runner_target_runtime',
    description: 'EXEC-ENV-03: digest-pinned Docker CPU/NVIDIA runtime configuration on runner targets',
    body: runnerTargetRuntime.toString(),
    up: runnerTargetRuntime,
  },
  {
    id: '0026_runner_target_service_identity',
    description: 'EXEC-ENV-04: target-scoped service identity SecretRef for authenticated RunnerTarget heartbeats',
    body: runnerTargetServiceIdentity.toString(),
    up: runnerTargetServiceIdentity,
  },
  {
    id: '0027_project_execution_shape',
    description: 'UPGRADE-01: canonical project execution shape; legacy runner labels stay explicitly unconfigured',
    body: canonicalizeProjectExecution.toString(),
    up: canonicalizeProjectExecution,
  },
  {
    id: '0028_methodology_knowledge_layer',
    description: 'METH-01: append-only Assurance, Protocol, Synthesis, Direction, Knowledge and writing-methodology ledgers',
    body: `${ASSURANCE_DDL}\n${METHODOLOGY_DDL}`,
    up: (db) => { db.exec(ASSURANCE_DDL); db.exec(METHODOLOGY_DDL) },
  },
  {
    id: '0029_research_run_outcomes',
    description: 'METH-02: append-only terminal research-run outcomes, NegativeFindings and proposal-only Claim relations',
    body: RESEARCH_RUN_OUTCOME_DDL,
    up: (db) => { db.exec(RESEARCH_RUN_OUTCOME_DDL) },
  },
  {
    id: '0030_writing_review_methodology',
    description: 'WRITE-01: append-only MethodTriad, SectionGuide, reviewer-panel and TeX patch proposal/application receipts',
    body: WRITING_REVIEW_DDL,
    up: (db) => { db.exec(WRITING_REVIEW_DDL) },
  },
  {
    id: '0031_correctness_hardening',
    description: 'CORRECT-01: durable Budget Gate block provenance and crash-recoverable Writing patch intents',
    body: CORRECTNESS_HARDENING_DDL,
    up: (db) => { db.exec(CORRECTNESS_HARDENING_DDL) },
  },
  {
    id: '0032_methodology_rollout_policy',
    description: 'METH-ROLLOUT-01: append-only methodology rollout policies plus project and execution pins',
    body: METHODOLOGY_ROLLOUT_DDL,
    up: (db) => { db.exec(METHODOLOGY_ROLLOUT_DDL) },
  },
  {
    id: '0033_full_auto_global_idempotency',
    description: 'CORRECT-02: globally bind each full-auto Gate approval key to one canonical request digest and receipt',
    body: FULL_AUTO_IDEMPOTENCY_DDL,
    up: (db) => { db.exec(FULL_AUTO_IDEMPOTENCY_DDL) },
  },
  {
    id: '0034_upload_abort_ownership',
    description: 'REVIEW-UPLOAD-02: durable Chat scope tombstones and ownership marker for session-close/upload races',
    body: uploadAbortOwnership.toString(),
    up: uploadAbortOwnership,
  },
  {
    id: '0035_ocr_requests',
    description: 'REVIEW-OCR-03: durable pinned OCR request lifecycle and observed-unverified normalized results',
    body: OCR_DDL,
    up: (db) => { db.exec(OCR_DDL) },
  },
  {
    id: '0036_pty_context_reset',
    description: 'REVIEW-PTY-CONTEXT-03: destructive reset of legacy context-less transient PTY sessions and frames',
    body: `${ptyContextReset.toString()}\n\n${PTY_DDL}`,
    up: ptyContextReset,
  },
  {
    id: '0037_config_write_layers',
    description: 'REVIEW-CONFIG-WRITE-03: durable revision-CAS global/project/runtime Settings layers and immutable revision ledger',
    body: CONFIG_WRITE_DDL,
    up: (db) => { db.exec(CONFIG_WRITE_DDL) },
  },
  {
    id: '0038_remove_plaintext_lease_storage',
    description: 'STORE-06: scrub legacy job lease plaintext and remove the obsolete PTY plaintext column',
    body: `${removePlaintextLeaseStorage.toString()}\n\n${PTY_CURRENT_DDL}`,
    up: removePlaintextLeaseStorage,
  },
]

/**
 * Open an existing database to the code's schema: bootstrap meta +
 * schema_migrations, apply every pending migration in order (each in a
 * transaction with a recorded checksum + report), then bump schema_version.
 * Fails loudly on a checksum mismatch, a version ahead of the code, or any
 * failed step (the failed step is rolled back).
 *
 * `casRoot` (optional) lets migrations materialize real CAS blobs (0017's
 * legacy log → final log Artifact step); callers that open the database
 * without a CAS root get the marker-only fallback.
 */
export function runMigrations(db: DatabaseSync, log?: (line: string) => void, casRoot?: string): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id TEXT PRIMARY KEY,
      checksum TEXT NOT NULL,
      applied_at TEXT NOT NULL,
      report_json TEXT NOT NULL
    );
  `)
  const versionRow = db.prepare('SELECT value FROM meta WHERE key = ?').get('schema_version') as { value?: string } | undefined
  const current = versionRow === undefined ? 0 : Number(versionRow.value)
  if (!Number.isFinite(current)) {
    throw new Error(`research-kernel: corrupt meta.schema_version '${versionRow?.value ?? ''}'`)
  }
  if (current > SCHEMA_VERSION) {
    throw new Error(`research-kernel schema version mismatch: db=${current} expected=${SCHEMA_VERSION}; downgrade requires an explicit script`)
  }
  const appliedRows = db.prepare('SELECT id, checksum FROM schema_migrations').all() as unknown as Array<{ id: string; checksum: string }>
  const applied = new Map(appliedRows.map(r => [r.id, r.checksum] as const))
  const insertMigration = db.prepare('INSERT INTO schema_migrations (id, checksum, applied_at, report_json) VALUES (?, ?, ?, ?)')
  const setMeta = db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
  let migratedAt: string | null = null
  for (const m of MIGRATIONS) {
    const expected = checksumOf(m)
    const existing = applied.get(m.id)
    if (existing !== undefined) {
      if (existing !== expected) {
        throw new Error(`research-kernel migration ${m.id} checksum mismatch: db=${existing} code=${expected}; released migrations are immutable`)
      }
      continue
    }
    const report: MigrationReport = {}
    db.exec('BEGIN IMMEDIATE')
    try {
      m.up(db, report, { casRoot })
      insertMigration.run(m.id, expected, new Date().toISOString(), JSON.stringify(report))
      db.exec('COMMIT')
    } catch (error) {
      db.exec('ROLLBACK')
      throw new Error(`research-kernel migration ${m.id} failed: ${(error as Error).message}`)
    }
    migratedAt = new Date().toISOString()
    log?.(`research-kernel: applied migration ${m.id} (${m.description})`)
  }
  if (current !== SCHEMA_VERSION) {
    setMeta.run('schema_version', String(SCHEMA_VERSION))
    if (migratedAt !== null) setMeta.run('last_migrated_at', migratedAt)
    const databaseId = db.prepare('SELECT value FROM meta WHERE key = ?').get('database_id') as { value?: string } | undefined
    if (databaseId === undefined) setMeta.run('database_id', randomUUID())
    const created = db.prepare('SELECT value FROM meta WHERE key = ?').get('created_at') as { value?: string } | undefined
    if (created === undefined) setMeta.run('created_at', new Date().toISOString())
  }
}
