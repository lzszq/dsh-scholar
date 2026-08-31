/**
 * Research Kernel — authoritative research state machine, ledger and durable
 * job store (design §3.2 ADR-002/003, §4.2, §5, §6). All writes go through
 * this class; the HTTP server and DSH plugin are thin adapters.
 * @module @dsh-scholar/research-kernel/kernel
 */

import { createHash, createPublicKey, randomBytes, randomUUID, verify, type KeyObject } from 'node:crypto'
import {
  chmodSync, closeSync, createReadStream, fstatSync, lstatSync, openSync, readdirSync, readFileSync, readSync,
  realpathSync, renameSync, rmdirSync, statSync, unlinkSync, writeFileSync, writeSync,
} from 'node:fs'
import { join, relative, sep, dirname } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { z } from 'zod'
import {
  ArtifactKind, ArtifactRecord, BudgetConstraints, BudgetRecord, Claim, CodeSnapshot, CorpusSnapshot, Decision, DirectionGatePayload,
  EvidenceItem, ExecutionConfig, ExperimentContract, FrozenProtocolPin, Gate, IdeaCard, IntegrityConfig, NoveltyAudit,
  JobRecord, KernelEvent, KernelEventKind, Paper, Passage, ResearchIntent, ResearchProject, ResearchBrief,
  RunnerKey, SessionLink, TRANSITION_TABLE, buildClaimId, buildContractId, buildGateId, buildIdeaId,
  buildProjectId, canonicalJsonDeep, getFixtureProfile, getRunnerProfile, randomId, resolveRunnerProfileId, runnerTargetConfigHash, validateConfig, RUNNER_PROFILE_IDS, ProjectStatus as ProjectStatusSchema, type GateType, type JobSpecBound, type JobStatus, type NextAction, type ProjectStatus,
  type HumanPrincipal, type IntakeArtifact, type IntakeObservation, type IntakeProjection, type IntakeSession,
  type AdoptionReceipt, type PhaseProposal, type ObservedPhase, type GrillAnswerInput, type GrillAnswerView,
  type IntakeStatus, type ImportMapping,
  type ProjectDeletionReceipt,
  SecretRef as SecretRefSchema,
  type ProviderDescriptor, type ProviderCreateInput, type ProviderUpdateInput, type SecretRef,
  OcrRequestCreateInput, type OcrRequest, type OcrRequestCreateInput as OcrRequestCreateInputValue, type OcrResult, type OcrRequestView,
  type OcrNormalizedObservation, type OcrSafeError,
  type RunnerTargetCreateInput, type RunnerTargetDescriptor, type RunnerTargetUpdateInput,
  type ProjectModelBinding, type ProjectModelBindingInput, type BindingPurpose,
  type IdeaDraft,
  type UploadSession, type UploadSessionView, type ChunkAppendResult, type UploadSessionBeginInput,
  parseContentRange,
  CHUNKED_UPLOAD_DEFAULT_CHUNK_BYTES, CHUNKED_UPLOAD_MAX_CHUNK_BYTES,
  INTAKE_UPLOAD_QUOTA_DEFAULT_BYTES, INTAKE_UPLOAD_QUOTA_MAX_BYTES, CHUNKED_UPLOAD_SESSION_TTL_MS,
  // REPRO-01 (docs/reproduction-contracts.md): paper reproduction schemas —
  // PaperReproductionSpec / ReproductionAttempt / ReproducibilityReport wire
  // shapes and the spec status transition table.
  REPRODUCTION_SPEC_TRANSITIONS, PaperReproductionSpec, ReproductionAttempt, ReproductionReportInput, ReproducibilityReport,
  EnvironmentLock, type ClaimToReproduce, type CodeSource, type DataSource, type ExecutionBinding,
  type MetricComparator, type PaperRef, type ReproductionLevel, type ReproductionSpecStatus,
  WritingAssuranceExecutionInput,
  NegativeFinding, ResearchClaimProposal, ResearchRunClassification, ResearchRunOutcome, ResearchRunRecord,
  ResearchRunOutcomeWrite, type ResearchRunOutcomeWrite as ResearchRunOutcomeWriteValue,
  MethodTriadWrite, SectionGuideActivationWrite, WritingReviewerPanelWrite,
  WritingPatchProposalWrite, WritingPatchApplyInput, HumanWritingPrincipal,
  type WritingCompilePin, type WritingInputPin, type WritingPatchApplication,
  type ConfigEffectiveSafeView, type ConfigLayerSafeView, type ConfigWriteScope,
  type OcrMineruSettingsOperation, type RunnerTargetSettingsOperation, type SettingsWriteTransactionReceipt,
} from '@dsh-scholar/research-schemas'
import { ArtifactCas } from './cas.js'
import { reproductionCanonicalJson, reproductionSha256 } from './reproduction.js'
import { mkdirMode } from './fs-modes.js'
import { openDatabase, type GateRow, type JobRow, type ProjectRow, type RunnerKeyRow } from './store.js'
import { openPtySessionStore, NullPtyAdapter, PtyError, type PtyAdapter, type PtyAppendResult, type PtyControlResult, type PtySessionStore } from './pty-session.js'
import type { PtyResolvedContext } from './pty-context.js'
import { PtyContextAuthority } from './pty-context-authority.js'
import { normalizeWorkspacePath, openWorkspaceStore, WorkspaceError, type WorkspaceExpected, type WorkspaceStore } from './workspace-store.js'
import { TexWorkspaceFacade } from './tex-facade.js'
import { WorkspaceModule } from './workspace-module.js'
import { deterministicAnalysisPort, type AnalysisPort } from './analysis-port.js'
import { nextActionProjection, type NextActionJob } from './next-action.js'
import { getLockedDigest, IMAGES_LOCK } from './images-lock.js'
import { STAGED_UPLOAD_TTL_MS as STAGED_TTL, UPLOAD_MAX_FILE_BYTES as UPLOAD_LIMIT_BYTES } from './upload-limits.js'
import {
  INTAKE_DEFAULT_TTL_MS, INTAKE_STAGED_TTL_MS, INTAKE_DDL, GRILL_TAXONOMY_VERSION, GRILL_QUESTION_REVISION,
  questionsForTargetPhase, requiredQuestionCodes, scanIntakeArtifactStatic, artifactKindForFile,
  isImportableMetricsFile, parseMetricsFileV1, buildPhaseProposal, questionViews,
  SAFE_PHASE_LANDING, isTexMaterializableFile, isCodeMaterializableFile, ARCHIVE_SCAN_EXTENSIONS,
  INTAKE_ARCHIVE_EXTENSIONS, SECRET_SCAN_BYTES,
  type StaticScanVerdict,
} from './intake.js'
import {
  ArchiveScanError, scanArchive, extractArchiveEntries, DEFAULT_ARCHIVE_LIMITS,
  type ArchiveLimits, type ArchiveScanResult,
} from './archive-scan.js'
import { TrajectoryStore } from './trajectory.js'
import { MetricsStore } from './metrics.js'
import { MethodologyRolloutStore } from './rollout-policy.js'
import { MethodologyTelemetry } from './methodology-telemetry.js'
import {
  validateSecretRefInput, validateProviderBaseUrl, providerConfigHash, providerRedacted,
  serviceIdentityAvailable, serviceIdentityTokenMatches,
  secretRefAvailable, parseProviderModels, validateBuiltInProviderContract, type ProviderUrlAllowlist,
} from './provider.js'
import { uploadStagedPath, intakeQuotaCheck } from './chunked-upload.js'
import { RunnerTargetRegistry } from './runner-target-registry.js'
import { OcrStore, OcrStoreError } from './ocr-store.js'
import type { OcrSourceBytes } from './ocr-worker.js'
import { ConfigWriteStore, ConfigWriteStoreError, readRuntimeConfigForOwner } from './config-write-store.js'
import { SettingsWriteCoordinator } from './settings-write-coordinator.js'
import { assessRunnerEnvironment } from './runner-environment-readiness.js'
import { dshOperatorPrincipal } from './dsh-principal.js'
import { AssuranceStore } from './assurance-store.js'
import { MethodologyStore } from './methodology-store.js'
import { evaluateResearchMethodology } from './research-methodology.js'
import {
  buildRunOutcomeObservation,
  buildSynthesisRecordRequest,
  canonicalManifestSha256,
  getRunOutcomeObservation,
  listRunOutcomeObservationLedger,
  listSynthesisRecordRequests,
  observesResearchOutcome,
} from './run-outcome-lifecycle.js'
import { WritingReviewStore } from './writing-review-store.js'
import {
  writingFileSha256,
} from './writing-review.js'
import {
  KnowledgeMethodologyCoordinator,
  SynthesisMethodologyCoordinator,
  WritingMethodologyCoordinator,
} from './methodology-coordinator.js'
import {
  evaluateFullAutoGateAuthority,
  evaluateFullAutoSurveyAuthority,
  evaluateFullAutoSurveyAuthorityContext,
  fullAutoAuthorityHash,
  FullAutoAuthorityReceiptSchema,
  FullAutoSurveyAuthorityReceiptSchema,
  FullAutoSurveyResultSchema,
  type FullAutoAuthorityReceipt,
  type FullAutoSurveyAuthorityReceipt,
  type FullAutoSurveyAuthorityContext,
  type FullAutoSurveyAuthorityReceiptBase,
  type FullAutoSurveyResult,
} from './full-auto.js'

/** §12 (reconstruction-contracts.md): bootstrap resamples are FIXED at
 * 10,000 in production — the kernel never lowers them. */
const ANALYSIS_RESAMPLES = 10_000

/**
 * STORAGE-07 (storage-migrations.md §10): post-restore integrity scan
 * report — every artifact record vs its CAS blob (existence, recorded size,
 * content re-hash) plus unreferenced ("orphan") blobs.
 */
export interface IntegrityScanReport {
  /** Artifact records whose blob is missing from the CAS (or empty). */
  missing_blobs: Array<{ project_id: string; artifact_id: string; sha256: string }>
  /** CAS blobs not referenced by any artifact record (GC candidate set). */
  orphan_blobs: string[]
  /** Existing blobs whose on-disk size differs from artifacts.size_bytes. */
  size_mismatch: Array<{ project_id: string; artifact_id: string; sha256: string; recorded_size: number; actual_size: number }>
  /** Existing blobs whose content re-hashes to a different sha256. */
  hash_mismatch: Array<{ project_id: string; artifact_id: string; sha256: string; recorded_size: number; actual_size: number }>
  /** Blob verifications performed (size + hash). */
  scanned_blobs: number
  /** Artifact blobs skipped when the scan was limited (limit option). */
  skipped_blobs: number
  /** Total CAS blob count at scan time. */
  total_blobs: number
}

/**
 * §4 (RUN-02/TEX-02 P0): the TeX build engine is a FIXED enum — never a raw
 * string spliced into a shell. The runner's build script validates the same
 * whitelist before generating any command line.
 */
export const TEX_ENGINES: readonly string[] = ['pdflatex', 'lualatex', 'xelatex', 'bibtex', 'biber']

/**
 * CHUNK-01: upper bound for reading a staged file fully into memory for the
 * controlled deep archive unpack scan. Bigger archives record
 * `archive_extract.status='too_large'` (honest) — the entry/byte/ratio
 * limits are re-applied at adoption-time materialization anyway.
 */
const ARCHIVE_DEEP_SCAN_MAX_BYTES = 256 * 1024 * 1024

/** Stream a file and return its sha256 (bounded memory — multi-GiB safe). */
function hashFileStreaming(path: string): string {
  const hash = createHash('sha256')
  const fd = openSync(path, 'r')
  try {
    const buffer = Buffer.alloc(1024 * 1024)
    let read = 0
    while ((read = readSync(fd, buffer, 0, buffer.byteLength, null)) > 0) {
      hash.update(buffer.subarray(0, read))
    }
  } finally {
    closeSync(fd)
  }
  return hash.digest('hex')
}

/** Read at most `maxBytes` from the start of a file (bounded memory). */
function readFileHead(path: string, maxBytes: number): Buffer {
  const fd = openSync(path, 'r')
  try {
    const size = Math.min(maxBytes, fstatSync(fd).size)
    const buffer = Buffer.alloc(size)
    if (size > 0) readSync(fd, buffer, 0, size, 0)
    return buffer
  } finally {
    closeSync(fd)
  }
}

/** §4 (TEX-02): shell metacharacters that must never appear in a TeX build
 * path (mirrors the runner's materializeTexWorkspace rule). */
const TEX_SHELL_META = /[;&|`$"'\\ \t\n]/

/** §4 (TEX-02): a TeX build path must be root-relative (inside the frozen
 * workspace), free of `..` segments and shell metacharacters — it is
 * interpolated into the container build script. */
function assertSafeTexBuildPath(path: string): void {
  if (path === '' || path.startsWith('/') || path.split('/').some(part => part === '..')) {
    throw new KernelError(422, 'tex_path_invalid', `tex build path must be root-relative without '..': ${path}`)
  }
  if (TEX_SHELL_META.test(path)) {
    throw new KernelError(422, 'tex_path_invalid', `tex build path contains shell metacharacters: ${path}`)
  }
}

/**
 * PTY-01 (execution-runtime.md §6.1): the PTY cwd must be a RELATIVE path
 * inside the workspace — never a host path. Rejects absolute paths (and
 * Windows drive prefixes), `..` segments, NUL bytes and backslash
 * ambiguity; `''`/'.' normalize to '.'. Throws 422-shaped PtyError.
 */
function validatePtyCwd(cwd: string): string {
  if (cwd.includes('\u0000')) throw new PtyError('pty_open_invalid', 'pty cwd must not contain NUL')
  if (cwd.includes('\\')) throw new PtyError('pty_open_invalid', `pty cwd must use '/' separators: ${cwd}`)
  if (cwd.startsWith('/')) throw new PtyError('pty_open_invalid', `pty cwd must be root-relative inside the workspace: ${cwd}`)
  if (/^[A-Za-z]:/.test(cwd)) throw new PtyError('pty_open_invalid', `pty cwd must not carry a Windows drive prefix: ${cwd}`)
  if (cwd.split('/').some(part => part === '..')) throw new PtyError('pty_open_invalid', `pty cwd must not contain '..' segments: ${cwd}`)
  return cwd === '' ? '.' : cwd
}

/**
 * UPLOAD-01 path safety (execution-runtime.md §4 / domain-model.md §artifact):
 * the upload file name must be a plain basename. Rejects absolute paths
 * (POSIX and Windows drive prefixes), `..` segments (on both separators),
 * NUL bytes and anything that normalizes to empty. Throws 422
 * invalid_file_name — the same contract the code-snapshot walk enforces for
 * archived paths. Lives here (not in uploads.ts) so the parser module stays
 * dependency-free: kernel.ts is the only module that needs KernelError.
 */
export function validateUploadFileName(name: string): void {
  if (name === '' || name.trim() === '') {
    throw new KernelError(422, 'invalid_file_name', 'upload file name must not be empty')
  }
  if (name.includes('\0')) {
    throw new KernelError(422, 'invalid_file_name', 'upload file name must not contain NUL bytes')
  }
  if (/[\u0000-\u001f\u007f]/.test(name)) {
    throw new KernelError(422, 'invalid_file_name', 'upload file name must not contain control characters')
  }
  if (Buffer.byteLength(name, 'utf8') > 255) {
    throw new KernelError(422, 'invalid_file_name', 'upload file name must not exceed 255 UTF-8 bytes')
  }
  if (name.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(name)) {
    throw new KernelError(422, 'invalid_file_name', 'upload file name must be a relative basename (absolute paths are rejected)')
  }
  // Windows drive prefix without separator (e.g. "C:evil.txt") is ambiguous —
  // reject it too so a Windows-style name can never reach the CAS download
  // Content-Disposition or a future archive materializer.
  if (/^[a-zA-Z]:/.test(name)) {
    throw new KernelError(422, 'invalid_file_name', 'upload file name must not carry a Windows drive prefix')
  }
  const normalized = name.replaceAll('\\', '/')
  if (normalized.startsWith('/')) {
    throw new KernelError(422, 'invalid_file_name', 'upload file name must be a relative basename (absolute paths are rejected)')
  }
  if (normalized.split('/').some(part => part === '..' || part === '.')) {
    throw new KernelError(422, 'invalid_file_name', 'upload file name must not contain "." or ".." path segments')
  }
  if (normalized.includes('/')) {
    // A single-file upload carries one basename; nested paths belong to
    // research-package archives (validated by the archive walk instead).
    throw new KernelError(422, 'invalid_file_name', 'upload file name must be a single basename without path separators')
  }
}

/** Lowercased extension of a file name ('' when none) — shared classifier. */
function extensionOfFile(fileName: string): string {
  const base = fileName.slice(fileName.lastIndexOf('/') + 1)
  const dot = base.lastIndexOf('.')
  return dot < 0 ? '' : base.slice(dot + 1).toLowerCase()
}

import { openTexWorkspace, TexError, type TexBuild, type TexDocumentInfo, type TexFileEntry, type TexPreviewPending, type TexSnapshotManifest } from './tex-workspace.js'
import { validateImageDigest, type SecureJobKind } from './images-lock.js'
import { parseLatexDiagnostics, type LatexDiagnostic } from './tex-diagnostics.js'

/** §12.1 (TEX-03): default debounce for live preview builds after a save. */
export const TEX_PREVIEW_DEBOUNCE_MS_DEFAULT = 800

export interface KernelOptions {
  /** SQLite database path (defaults to `:memory:`). */
  dbPath?: string
  /** CAS root for immutable artifacts. */
  casRoot?: string
  /** Kernel identity used for leases. */
  instanceId?: string
  /** §12.7: reject unsigned run manifests at job completion (default: true). */
  requireSignedManifest?: boolean
  /**
   * §4 P0 (hardening API-01/EVID-01): service identity token for INTERNAL
   * routes (including DSH create/link, jobs-claim, runner-keys, recover/
   * leases, evidence verified/accept and contracts approve). When configured, the HTTP server demands
   * `x-service-token` on those routes (browser bearer credentials and
   * self-reported x-service-principal headers are NOT accepted). Supplied by
   * the sidecars via DSH_SCHOLAR_SERVICE_TOKEN; a bare kernel without it
   * stays open (dev compatibility).
   */
  serviceToken?: string
  /** DSH-CREATE-LINK-01: route-specific credential shared only by the DSH
   * plugin client and Kernel. Runners never receive this token. */
  dshPluginToken?: string
  /** Route-specific credential shared only with the managed full-auto
   * orchestrator. It never reaches Runner/browser processes. */
  orchestratorToken?: string
  /**
   * §12.1 (TEX-03): debounce window for live preview builds after a save
   * success (default 800ms). Per-request overrides are accepted by
   * texRequestPreview / POST preview-builds.
   */
  previewDebounceMs?: number
  /**
   * §12.1 (TEX-03): when true, every successful workspace write (save/new/
   * delete/move) automatically schedules a debounced preview build — the
   * kernel-internal "Workspace event → preview" path. Off by default so the
   * explicit POST /v1/documents/{id}/preview-builds hook (called by the UI
   * after a save success) stays the canonical trigger; the flag exists for
   * deployments that want zero client involvement.
   */
  previewAutoTrigger?: boolean
  /**
   * PTY-01: idle-TTL sweep cadence in ms (default 30s). The kernel owns the
   * sweep timer so sessions close even when no client ever reconnects; the
   * per-session idle_ttl_s (pinned from the effective Config Registry at
   * open) decides each session's deadline. 0 disables the timer.
   */
  ptyIdleSweepMs?: number
  /**
   * WORK-01 §5 P2 (hardening-v0.2-status.md §5): run the workspace recovery
   * scan at kernel startup — repair (or isolate) every generic workspace
   * left inconsistent by a crash between the atomic disk write/move/delete
   * and the SQLite row/op-ledger update, and remove orphan `.ws-tmp-*`
   * leftovers. Default true (healthy databases scan as a no-op); tests that
   * inject disk corruption AFTER construction opt out when they need the
   * corruption to survive the open.
   */
  recoverWorkspacesOnOpen?: boolean
  /**
   * CHUNK-01 (init-grill-upload-models.md §3): per-chunk size for batch
   * chunked uploads. Default 8 MiB; instance may tighten; hard max
   * 32 MiB (CHUNKED_UPLOAD_MAX_CHUNK_BYTES).
   */
  intakeChunkSizeBytes?: number
  /**
   * CHUNK-01: per-Intake reserved upload quota. Default 2 GiB
   * (INTAKE_UPLOAD_QUOTA_DEFAULT_BYTES); hard max 10 GiB
   * (INTAKE_UPLOAD_QUOTA_MAX_BYTES).
   */
  intakeQuotaBytes?: number
  /**
   * MODEL-01: server-side secret root for `file`-scheme SecretRef
   * availability checks. Absent → file refs report available=false (honest).
   * Never echoed to the browser beyond the boolean.
   */
  secretRoot?: string | null
  /**
   * MODEL-01: base-URL allowlist for provider registration (SSRF fail
   * closed). Defaults: https only, DNS hosts must be allowlisted.
   */
  providerUrlAllowlist?: ProviderUrlAllowlist
  /** Deterministic statistics adapter. The Kernel depends on this narrow
   * port, never on the process-oriented analysis worker package. */
  analysisPort?: AnalysisPort
  /** Canonical process-start config resolved by the owning launcher. Runtime
   * secrets stay in memory and are always redacted by public views. The
   * Kernel overwrites DB/CAS/service-token/signature fields with the values
   * it actually uses, so a launcher cannot publish a dishonest config pin. */
  runtimeConfig?: Readonly<Record<string, unknown>>
}

const WritingPatchIntentSchema = z.object({
  application_id: z.string().regex(/^writing_apply_[a-z0-9_]+$/),
  proposal_id: z.string().regex(/^writing_patch_[a-z0-9_]+$/),
  project_id: z.string().min(1).max(256),
  expected_revision: z.number().int().nonnegative(),
  expected_file_version: z.number().int().positive(),
  apply_input: WritingPatchApplyInput,
  actor: HumanWritingPrincipal,
  applied_at: z.string().datetime(),
}).strict()
type WritingPatchIntent = z.infer<typeof WritingPatchIntentSchema>

/** Error carrying an HTTP status for the API adapter. */
export class KernelError extends Error {
  readonly status: number
  readonly code: string
  readonly key: string | undefined
  constructor(status: number, code: string, message: string, key?: string) {
    super(message)
    this.status = status
    this.code = code
    this.key = key
  }
}

function nowIso(): string {
  return new Date().toISOString()
}

/**
 * STORE-05 (storage-migrations.md §4): canonical content signature of one
 * terminal frame. Compares ONLY content fields (frame_kind, stream_seq,
 * channel, text, byte_offset, byte_length, payload_json); lease_generation
 * and created_at are delivery bookkeeping, not content (a reclaim replays
 * old seqs with a new generation). Deterministic: JSON.stringify of a fixed
 * field array.
 */
function terminalFrameSignature(frame: {
  frame_kind: string
  stream_seq?: number | null
  channel?: string | null
  text?: string | null
  byte_offset?: number | null
  byte_length?: number | null
  payload_json?: string | null
}): string {
  return createHash('sha256').update(JSON.stringify([
    frame.frame_kind,
    frame.stream_seq ?? null,
    frame.channel ?? null,
    frame.text ?? null,
    frame.byte_offset ?? null,
    frame.byte_length ?? null,
    frame.payload_json ?? '{}',
  ])).digest('hex')
}

function jsonParse<T>(text: string | null | undefined, fallback: T): T {
  if (text === undefined || text === null || text === '') return fallback
  try {
    return JSON.parse(text) as T
  } catch {
    return fallback
  }
}

function projectFromRow(row: ProjectRow): ResearchProject {
  return {
    project_id: row.project_id,
    name: row.name,
    workspace: row.workspace,
    mode: row.mode as ResearchProject['mode'],
    status: row.status as ProjectStatus,
    revision: row.revision,
    brief_status: row.brief_status === 'collecting' ? 'collecting' : 'confirmed',
    brief: jsonParse(row.brief, {} as ResearchProject['brief']),
    constraints: jsonParse(row.constraints, {} as ResearchProject['constraints']),
    // Stored execution state is canonical. Obsolete rows are not silently
    // upgraded or mapped to a local Runner; malformed/missing configuration
    // fails closed so an operator must configure the project explicitly.
    execution: ExecutionConfig.parse(jsonParse(row.execution, null)),
    integrity: jsonParse(row.integrity, {} as ResearchProject['integrity']),
    session_id: row.session_id,
    dsh_workspace_id: row.dsh_workspace_id,
    created_at: row.created_at,
    updated_at: row.updated_at,
    history: jsonParse(row.history, [] as string[]),
    deleted_at: row.deleted_at,
    deleted_by: row.deleted_by,
    deletion_reason: row.deletion_reason,
  }
}

function gateFromRow(row: GateRow): Gate {
  return {
    gate_id: row.gate_id,
    project_id: row.project_id,
    type: row.type as GateType,
    title: row.title,
    summary: row.summary,
    payload: jsonParse(row.payload, {}),
    status: row.status as Gate['status'],
    dsh_session_id: row.dsh_session_id,
    dsh_event_id: row.dsh_event_id,
    created_at: row.created_at,
    decided_at: row.decided_at,
  }
}

function jobFromRow(row: JobRow, db: DatabaseSync, tokenOverride?: string | null): JobSpecBound & { run_id: string | null } {
  const payload = jsonParse(row.payload, {} as Record<string, unknown>)
  // 0038 makes plaintext lease storage an invalid current shape. The token is
  // returned only from the process-local claim map; persisted rows are hash-only.
  if (Object.prototype.hasOwnProperty.call(payload, '__lease_token')) {
    throw new Error(`job ${row.job_id} contains obsolete plaintext lease storage`)
  }
  const leaseToken = tokenOverride ?? null
  // §3.1 / RUN-01 (P0): the durable per-attempt run identity — the runs row
  // of the CURRENT attempt (`attempts`). Runners that only hold the job
  // record (claim response / GET job) can use run_id for manifest, terminal
  // frames and evidence without re-fetching; queued jobs (no attempt yet)
  // yield null.
  const runRow = db.prepare('SELECT run_id FROM runs WHERE job_id = ? AND attempt_no = ?')
    .get(row.job_id, row.attempts) as { run_id?: string } | undefined
  return {
    run_id: runRow?.run_id ?? null,
    job_id: row.job_id,
    project_id: row.project_id,
    contract_id: row.contract_id,
    idempotency_key: row.idempotency_key,
    kind: row.kind as JobRecord['kind'],
    command: jsonParse(row.command, [] as string[]),
    payload,
    status: row.status as JobStatus,
    failure_class: row.failure_class as JobRecord['failure_class'],
    lease_owner: row.lease_owner,
    lease_expires_at: row.lease_expires_at,
    heartbeat_at: row.heartbeat_at,
    lease_generation: row.lease_generation ?? null,
    lease_token: leaseToken,
    // v2 shape (domain-model.md §9): durable submitter principal; NULL for
    // legacy rows (migration 0016).
    created_by_principal_id: row.created_by_principal_id ?? null,
    // §12.2 JobSpec binding (SCH-EXEC-002): code snapshot materialized from CAS.
    code_snapshot_id: row.code_snapshot_id,
    data_artifact_ids: Array.isArray(payload.data_artifact_ids) ? payload.data_artifact_ids.map(String) : [],
    image_digest: typeof payload.image_digest === 'string' ? payload.image_digest : '',
    // domain-model.md §9.1: Job 固定的 opaque profile id + config hash
    // （kernel submitJob 注入 payload；runner 按注册表复算校验）。
    runner_profile_id: typeof payload.runner_profile_id === 'string' && payload.runner_profile_id !== '' ? payload.runner_profile_id : null,
    profile_config_hash: typeof payload.profile_config_hash === 'string' && payload.profile_config_hash !== '' ? payload.profile_config_hash : null,
    protocol_pin: payload.protocol_pin === undefined || payload.protocol_pin === null
      ? null
      : FrozenProtocolPin.parse(payload.protocol_pin),
    run_intent: ResearchIntent.parse(payload.run_intent ?? 'exploratory'),
    output_contract: typeof payload.output_contract === 'object' && payload.output_contract !== null
      ? { metrics: String((payload.output_contract as Record<string, unknown>).metrics ?? '/outputs/metrics.json'), logs: String((payload.output_contract as Record<string, unknown>).logs ?? '/outputs/run.log') }
      : undefined,
    attempts: row.attempts,
    max_attempts: row.max_attempts,
    run_manifest: jsonParse(row.run_manifest, null),
    error: row.error,
    created_at: row.created_at,
    updated_at: row.updated_at,
  }
}

/**
 * §3.1 (STORE-01): a durable run-attempt row — one row per job claim,
 * identity (run_id) per attempt. Populated at claim time and finalized at
 * completion (RUN-01). `snapshot_sha256` is the CAS sha256 of the job's
 * bound code snapshot (null when the job has none, e.g. echo/smoke/TeX).
 */
export interface RunRecord {
  run_id: string
  project_id: string
  job_id: string
  attempt_no: number
  contract_id: string | null
  snapshot_sha256: string | null
  manifest_json: Record<string, unknown> | null
  signature_status: 'pending' | 'signed' | 'unsigned' | 'credential_redacted'
  started_at: string
  finished_at: string | null
}

/** Row shape for the §3.1 runs table. */
interface RunRow {
  run_id: string
  project_id: string
  job_id: string
  attempt_no: number
  contract_id: string | null
  snapshot_sha256: string | null
  manifest_json: string | null
  signature_status: string
  started_at: string
  finished_at: string | null
}

function runFromRow(row: RunRow): RunRecord {
  return {
    run_id: row.run_id,
    project_id: row.project_id,
    job_id: row.job_id,
    attempt_no: row.attempt_no,
    contract_id: row.contract_id,
    snapshot_sha256: row.snapshot_sha256,
    manifest_json: jsonParse(row.manifest_json, null),
    signature_status: row.signature_status as RunRecord['signature_status'],
    started_at: row.started_at,
    finished_at: row.finished_at,
  }
}

/** Row shape for the event outbox (§16 canonical envelope, EVENT-01). */
interface OutboxEventRow {
  event_id: string
  project_id: string | null
  kind: string
  payload: string
  source: string
  delivered: number
  created_at: string
  /** §16: per-aggregate monotonic sequence (max+1 in the write transaction). */
  event_seq: number | null
  event_version: number | null
  aggregate_type: string | null
  aggregate_id: string | null
  aggregate_revision: number | null
  request_id: string | null
  session_id: string | null
  attempts: number | null
  last_error: string | null
  next_attempt_at: string | null
  dead_lettered_at: string | null
}

/** Row shapes for the ONBOARD-01 Intake tables (research-onboarding.md §3). */
interface IntakeSessionRow {
  intake_id: string
  project_id: string | null
  owner_principal_id: string
  owner_tenant_id: string
  owner_auth_method: string
  owner_session_id: string | null
  owner_scope_id: string | null
  status: string
  revision: number
  source_label: string
  target_phase: string | null
  expires_at: string
  scan_summary: string
  proposal_json: string | null
  receipt_json: string | null
  audit_json: string
  idempotency_key: string | null
  request_hash: string | null
  created_at: string
  updated_at: string
}

interface IntakeArtifactRow {
  intake_id: string
  artifact_id: string
  file_name: string
  media_type: string
  size_bytes: number
  sha256: string
  quarantine: string
  scan_result: string
  created_at: string
}

interface IntakeObservationRow {
  observation_id: string
  intake_id: string
  artifact_id: string
  locator: string
  detector: string
  detector_version: string
  value: string
  warnings: string
  trust: string
  created_at: string
}

interface IntakeQuestionRow {
  intake_id: string
  question_code: string
  question_revision: number
  required: number
  answer: string | null
  answered_by_principal: string | null
  answered_by_session: string | null
  answered_at: string | null
}

/** Row shapes for the CHUNK-01 batch chunked-upload tables. */
interface UploadSessionRow {
  upload_id: string
  intake_id: string
  project_id: string
  file_name: string
  media_type: string
  expected_size: number
  expected_sha256: string | null
  chunk_size: number
  committed_offset: number
  status: string
  finalized_sha256: string | null
  owns_artifact: number
  owner_scope_id: string | null
  created_by_principal: string
  created_at: string
  updated_at: string
  expires_at: string
}

interface UploadChunkRow {
  upload_id: string
  offset: number
  size: number
  sha256: string
}

/** Row shapes for the MODEL-01 provider registry. */
interface ModelProviderRow {
  provider_id: string
  display_name: string
  kind: string
  base_url: string
  enabled: number
  capabilities: string
  credential_json: string
  revision: number
  created_by: string
  created_at: string
  updated_at: string
}

interface ModelProviderModelRow {
  provider_id: string
  model_id: string
  display_name: string | null
  capabilities: string
  model_revision: number
}

function eventFromRow(row: OutboxEventRow): KernelEvent {
  return {
    event_id: row.event_id,
    project_id: row.project_id,
    kind: row.kind as KernelEventKind,
    payload: jsonParse(row.payload, {}),
    source: row.source,
    delivered: row.delivered === 1,
    created_at: row.created_at,
    // §16 outbox canonical envelope (EVENT-01): additive fields surfaced on
    // reads; old rows keep NULLs except the NOT NULL defaults.
    event_seq: row.event_seq ?? undefined,
    event_version: row.event_version ?? undefined,
    aggregate_type: row.aggregate_type,
    aggregate_id: row.aggregate_id,
    aggregate_revision: row.aggregate_revision,
    request_id: row.request_id,
    session_id: row.session_id,
    attempts: row.attempts ?? undefined,
    last_error: row.last_error,
    next_attempt_at: row.next_attempt_at,
    dead_lettered_at: row.dead_lettered_at,
  }
}

/** Side effects applied when a human decision approves a gate (design §5.2). */
const GATE_APPROVAL_TRANSITION: Record<GateType, { from: ProjectStatus; to: ProjectStatus }> = {
  scope: { from: 'DRAFT', to: 'SCOPED' },
  idea: { from: 'IDEATING', to: 'IDEA_APPROVED' },
  contract: { from: 'CONTRACT_PENDING', to: 'CONTRACT_APPROVED' },
  budget: { from: 'BLOCKED_GATE', to: 'EXPERIMENTING' }, // resume: caller pins target in payload
  release: { from: 'RELEASE_READY', to: 'RELEASED' },
  // Direction Gates authorize an immutable methodology proposal; they never
  // move the project phase. The dedicated branch in decideGate owns this.
  direction: { from: 'DRAFT', to: 'DRAFT' },
}

interface GateDecisionInput {
  gate_id: string
  actor: string
  /** Human calls use a durable Human Principal; fixture automation uses the
   * dedicated `full-auto-service` auth_method and is never presented as Human. */
  principal?: {
    principal_id: string
    tenant_id?: string
    auth_method?: string
    session_id?: string | null
  }
  decision: 'approved' | 'rejected' | 'revised'
  reason?: string
  diff?: string
  session_id?: string | null
  event_id?: string | null
  resume_to?: ProjectStatus
}

/** Run `fn` inside a single SQLite transaction (v2 §7.6 transactional kernel). */
export function withTransaction<T>(db: DatabaseSync, fn: () => T): T {
  const ownsTransaction = !db.isTransaction
  if (ownsTransaction) db.exec('BEGIN IMMEDIATE')
  try {
    const result = fn()
    if (ownsTransaction) db.exec('COMMIT')
    return result
  } catch (error) {
    if (ownsTransaction) {
      try { db.exec('ROLLBACK') } catch { /* already rolled back */ }
    }
    throw error
  }
}

/**
 * P0-4 (SNAPSHOT-01): secret-file name matcher for the code-snapshot walk.
 * Files matching these patterns are NEVER archived — the snapshot is
 * rejected with 422 `snapshot_secret_file` naming every match (fail closed;
 * no skip-and-record, so a secret can never silently slip into a snapshot).
 * The patterns are deliberately conservative (basename-level, case-
 * insensitive): dot-env files, token/secret/password/credential file names,
 * private keys (`id_rsa`/`id_ed25519`/…), `*.key`/`*.pem`, `.aws/
 * credentials`, the service identities (`service-token`/`kernel-token`) and
 * well-known credential stores (`.npmrc`/`.pypirc`/`.netrc`/`.htpasswd`).
 */
function isSecretSnapshotFile(rel: string): boolean {
  const lower = rel.toLowerCase()
  const base = lower.slice(lower.lastIndexOf('/') + 1)
  // `.env`, `.env.local`, `.env.production`…
  if (base === '.env' || base.startsWith('.env.')) return true
  // SSH/GPG private key basenames (`.pub` public halves are allowed).
  if (base === 'id_rsa' || base === 'id_ecdsa' || base === 'id_ed25519' || base === 'id_dsa') return true
  // Generic key material: `server.key`, `credentials.pem`, `auth.key.pem`…
  if (base.endsWith('.key') || base.endsWith('.pem')) return true
  // Service identities used by this deployment.
  if (base === 'service-token' || base === 'service_token' || base === 'kernel-token' || base === 'kernel_token') return true
  // `*_token`, `*-token`, `app.secret`, `credentials.json`… — a token/
  // secret/password/credential file name separated by `_`/`-`/`.`.
  if (/(^|[._-])(token|secret|password|passwd|credential|credentials)([._-]|$)/.test(base)) return true
  // Well-known per-user credential stores.
  if (lower === '.aws/credentials' || lower.startsWith('.aws/credentials.')) return true
  if (base === '.npmrc' || base === '.pypirc' || base === '.netrc' || base === '.htpasswd') return true
  return false
}

export class ResearchKernel {
  /**
   * Code-snapshot fixed resource limits (reconstruction-contracts.md §3,
   * STORE-02): the archive walk refuses to grow past these instead of
   * silently truncating. Values = the §3 desktop defaults (snapshot files
   * 20,000 / single file 64 MiB / total 2 GiB; the staged-Artifact total
   * 512 MiB is a separate row). Static so deployments/tests can override
   * them (e.g. a unit test temporarily lowers SNAPSHOT_MAX_FILE_BYTES and
   * restores it in `finally`); 超限 → 422 `snapshot_too_large` with the
   * concrete limit and measured value in the message.
   */
  static SNAPSHOT_MAX_FILES = 20_000
  static SNAPSHOT_MAX_FILE_BYTES = 64 * 1024 * 1024 // 64 MiB per file
  static SNAPSHOT_MAX_TOTAL_BYTES = 2 * 1024 * 1024 * 1024 // 2 GiB total

  /**
   * UPLOAD-01: hard cap for ONE multipart-uploaded file (api-contracts.md
   * §1/§7). Static so deployments/tests can lower it (same pattern as the
   * snapshot limits above); 超限 → 413 payload_too_large with the concrete
   * limit and measured value in the message. The HTTP layer streams against
   * this cap (plus a bounded multipart envelope allowance) so an oversized
   * upload is rejected before it is buffered in full.
   */
  static UPLOAD_MAX_FILE_BYTES = UPLOAD_LIMIT_BYTES

  /** Default staged-upload TTL for cleanupStagedUploads (24 h). */
  static STAGED_UPLOAD_TTL_MS = STAGED_TTL

  /** ONBOARD-01: default Intake session TTL before expireIntakes (7 days). */
  static INTAKE_DEFAULT_TTL_MS = INTAKE_DEFAULT_TTL_MS

  /**
   * ONBOARD-01: default staged-intake-blob TTL for cleanupIntakeStaged.
   */
  static INTAKE_STAGED_TTL_MS = INTAKE_STAGED_TTL_MS

  /** CHUNK-01: default chunk size for batch chunked uploads (8 MiB). */
  static CHUNKED_UPLOAD_DEFAULT_CHUNK_BYTES = CHUNKED_UPLOAD_DEFAULT_CHUNK_BYTES

  /** CHUNK-01: hard cap for one chunk (32 MiB). */
  static CHUNKED_UPLOAD_MAX_CHUNK_BYTES = CHUNKED_UPLOAD_MAX_CHUNK_BYTES

  /** CHUNK-01: default per-Intake reserved upload quota (2 GiB). */
  static INTAKE_UPLOAD_QUOTA_DEFAULT_BYTES = INTAKE_UPLOAD_QUOTA_DEFAULT_BYTES

  /** CHUNK-01: hard cap for the per-Intake quota (10 GiB). */
  static INTAKE_UPLOAD_QUOTA_MAX_BYTES = INTAKE_UPLOAD_QUOTA_MAX_BYTES

  /** CHUNK-01: open chunked-upload stage retention floor (≥24 h). */
  static CHUNKED_UPLOAD_SESSION_TTL_MS = CHUNKED_UPLOAD_SESSION_TTL_MS

  /**
   * ONBOARD-01 (research-onboarding.md §4.2): controlled archive unpack
   * scan limits (archive-scan.ts). Applied at scanIntake (deep scan — a
   * violation quarantines the artifact) AND re-applied at adoption-time
   * materialization (a violation there records a `gap`, never fails the
   * adoption). Static so deployments/tests can override them (same pattern
   * as the snapshot limits).
   */
  static ARCHIVE_MAX_ENTRIES = DEFAULT_ARCHIVE_LIMITS.maxEntries
  static ARCHIVE_MAX_TOTAL_BYTES = DEFAULT_ARCHIVE_LIMITS.maxTotalBytes
  static ARCHIVE_MAX_FILE_BYTES = DEFAULT_ARCHIVE_LIMITS.maxFileBytes
  static ARCHIVE_MAX_RATIO = DEFAULT_ARCHIVE_LIMITS.maxRatio

  readonly db: DatabaseSync
  readonly cas: ArtifactCas
  readonly instanceId: string
  /**
   * UPLOAD-01: staging area for in-flight multipart uploads (inside the CAS
   * root so it lives/dies with the artifact store). Files are written as
   * `stage_<id>.part` (raw bytes) + `stage_<id>.json` (metadata: project,
   * kind, file_name, media_type, sha256, size) and are never visible to
   * cas.list() (which only accepts 64-hex blob names) — they either become a
   * CAS blob at finalize or are collected by cleanupStagedUploads.
   */
  readonly stagedUploadsRoot: string
  /**
   * ONBOARD-01: ISOLATED staging CAS for intake sessions
   * (research-onboarding.md §2.1 — pre-accept writes only Intake tables and
   * this isolated temp area, never the project artifact space). A SIBLING of
   * staged-uploads/ under the CAS root (so the UPLOAD-01 staging directory
   * and its GC stay untouched). Files live under
   * `intake-staged/<intake_id>/<sha256>.part`; cas.list() never sees them,
   * adopted blobs are promoted into the real CAS inside the adoption
   * transaction, and reject/expiry/cleanupIntakeStaged remove them.
   */
  readonly intakeStagedRoot: string
  /** TeX workspace store (execution-runtime.md §12). */
  readonly tex: import('./tex-workspace.js').TexWorkspaceStore
  /**
   * PTY-01 (execution-runtime.md §6.1): durable Interactive Terminal session
   * store — state machine + control idempotency + frame seq/retention
   * (interface layer; the real tty adapter is injected via setPtyAdapter).
   */
  readonly pty: PtySessionStore
  /**
   * WORK-01 (api-contracts.md §17): generic VS Code-style workspace store —
   * revision/etag/CAS + binary artifact CAS, backed by the REAL disk
   * adapter (bytes under `dataDir/workspaces/{project_id}/{workspace_id}`,
   * metadata in `workspace_nodes`; workspace-store.ts).
   */
  readonly workspaces: WorkspaceStore
  /**
   * WORK-01: the TeX store viewed through the generic workspace contract
   * (kind='manuscript') — the mapping layer, not a second authority
   * (tex-facade.ts). The existing TeX routes keep calling `tex` directly.
   */
  readonly texFacade: TexWorkspaceFacade
  /** Unified generic/TeX workspace implementation behind a small interface. */
  readonly workspaceModule: WorkspaceModule
  /**
   * TRAJ-01/SUBAGENT-01 (trajectory-subagents.md): standalone safe
   * trajectory projection + subagent topology store — read-only outbox
   * projection (Research/Session lanes, keyset pagination, redaction) and
   * child_links/history/followups (exact-parent, breadcrumb, one-shot
   * read-only followup). The Kernel Outbox stays the only business ledger.
   */
  readonly trajectory: import('./trajectory.js').TrajectoryStore
  /** §12.7: when true, unsigned run manifests are rejected at completion. */
  requireSignedManifest: boolean
  /** §4 P0 (API-01/EVID-01): service identity for internal HTTP routes. */
  readonly serviceToken: string | undefined
  /** DSH-CREATE-LINK-01: audience-bound credential for direct create/link. */
  readonly dshPluginToken: string | undefined
  /** FULLAUTO-CREDENTIAL-02: audience-bound managed worker credential. */
  readonly orchestratorToken: string | undefined
  /**
   * CONFIG-01: sha256 pin of the running kernel's effective config, computed
   * through the canonical Config Registry (research-schemas config-registry
   * module): global + project scope defaults merged with this instance's
   * kernel-scope values (db/cas/require-signed-manifest/service identity) and
   * the trusted images.lock digests. Deterministic for identical configs and
   * changes whenever any value changes — including the (hashed-only) service
   * token. Exposed via the HTTP `x-config-pin` header and /v1|v2 health.
   */
  readonly configPinHash: string
  /**
   * CONFIG-01: the REDACTED view of this kernel's effective config (secret
   * values replaced with `<redacted>` by the registry) — the sole safe
   * plaintext for the `/v1/config/effective` HTTP surface. The launcher feeds
   * its canonical process-start values through KernelOptions.runtimeConfig;
   * the HTTP server has no second config override.
   */
  readonly configRedacted: Record<string, unknown>
  /** §12.1 (TEX-03): debounce window for live preview builds. */
  readonly previewDebounceMs: number
  /** §12.1 (TEX-03): auto-trigger previews on every workspace write. */
  readonly previewAutoTrigger: boolean
  /** CHUNK-01: negotiated per-chunk size for batch chunked uploads. */
  readonly intakeChunkSizeBytes: number
  /** CHUNK-01: per-Intake reserved upload quota. */
  readonly intakeQuotaBytes: number
  /** MODEL-01: secret root for file-scheme SecretRef availability (null = none). */
  readonly secretRoot: string | null
  /** MODEL-01: provider base-URL allowlist (SSRF fail closed). */
  readonly providerUrlAllowlist: ProviderUrlAllowlist
  /** EXEC-ENV-02: authoritative configurable local/Docker/remote-SSH targets. */
  readonly runnerTargets: RunnerTargetRegistry
  /** Intake-scoped OCR request authority and normalized unverified results. */
  readonly ocr: OcrStore
  /** Canonical layered Settings CAS/history projection. */
  readonly configWrites: ConfigWriteStore
  /** Single atomic Settings write boundary for Config/OCR/Runner resources. */
  readonly settingsWrites: SettingsWriteCoordinator
  /** Append-only methodology assurance stream on the Kernel connection. */
  readonly assurance: AssuranceStore
  /** Append-only Protocol/Synthesis/Knowledge/Writing methodology streams. */
  readonly methodology: MethodologyStore
  /** Append-only writing diagnostics, reviewer aggregates and Human-applied patch receipts. */
  readonly writingReview: WritingReviewStore
  /** §12.1 (TEX-03): in-flight debounce timers, one per document. */
  private readonly previewTimers = new Map<string, NodeJS.Timeout>()
  /**
   * PTY-01: the registered PTY adapter (null = no real tty yet). The
   * interface layer ships NullPtyAdapter; LocalPtyAdapter (pty-local.ts)
   * replaces it in the kernel bin; LocalDockerPty/RemoteRunnerPty share the
   * same contract. PTY output never becomes Job log, Metrics, Manifest,
   * Evidence or Gate Decision regardless of adapter.
   */
  private ptyAdapter: PtyAdapter | null = null
  /** PTY-01: idle-TTL sweep timer (kernel-owned, see KernelOptions). */
  private readonly ptySweepTimer: NodeJS.Timeout | null
  /**
   * OBS-01 (reconstruction-contracts.md §18): in-memory runtime metrics
   * (counters + histograms). Instrumented at the key paths below — request
   * completion (server layer), outbox append/dead-letter, job claim/
   * complete, lease expiry, terminal dropped bytes, CAS GC/orphan, TeX build
   * completion and budget accounting. Exposed as JSON via GET
   * /internal/metrics (loopback only). Series keys/tags are FIXED constant
   * strings — never paths, ids, tokens or content (OBS-01).
   */
  readonly metrics: MetricsStore
  /** Append-only rollout policy source consumed by methodology runtime. */
  readonly rollout: MethodologyRolloutStore
  /** Closed-label methodology observability producer. */
  readonly methodologyTelemetry: MethodologyTelemetry
  /** Deep methodology coordinators; public Kernel methods are stable façades. */
  private readonly knowledgeMethodology: KnowledgeMethodologyCoordinator
  private readonly synthesisMethodology: SynthesisMethodologyCoordinator
  private readonly writingMethodology: WritingMethodologyCoordinator
  private readonly analysisPort: AnalysisPort

  /**
   * STORE-06 (storage-migrations.md §4): in-memory plaintext lease tokens,
   * one per currently-claimed job (job_id → token). The database only ever
   * stores sha256(token) in jobs.lease_token_hash; this map backs the
   * claim-response surface (the runner receives the plaintext token once)
   * and is cleared when the lease is released (complete/cancel/expiry
   * recovery). After a kernel restart it is empty — verification stays
   * possible via the hash column, but re-fetched jobs no longer carry the
   * plaintext (the runner holds it from the claim response).
   */
  private readonly leaseTokens = new Map<string, string>()
  /**
   * REPRO-01 (docs/reproduction-contracts.md §2.3): in-memory plaintext lease
   * tokens for reproduction ATTEMPTS (attempt_id → token). The database only
   * stores sha256(token) in reproduction_attempts.lease_token_hash; this map
   * backs the start-attempt response (the caller receives the plaintext
   * token once) and is cleared when the attempt is reported. After a kernel
   * restart it is empty — report-time fencing still verifies via the hash
   * column, but an idempotent start-attempt replay after a restart returns
   * `lease_token: null` (the caller must hold the token from its original
   * start).
   */
  private readonly reproductionLeaseTokens = new Map<string, string>()

  constructor(options: KernelOptions = {}) {
    // MIG-V1 (0017): the migration runner receives the CAS root so legacy
    // log text can be materialized as real content-addressed blobs (with a
    // final log Artifact row) instead of phantom references.
    const casRoot = options.casRoot ?? join(process.cwd(), '.research-cas')
    this.db = openDatabase(options.dbPath ?? ':memory:', undefined, casRoot)
    const persistedKernelRuntime = readRuntimeConfigForOwner(this.db, 'kernel')
    this.cas = new ArtifactCas(casRoot)
    this.stagedUploadsRoot = join(this.cas.root, 'staged-uploads')
    // WORK-01 §5: staging dirs carry an explicit 0700 (private staging for
    // 0600 stage files) — mkdir(mode) alone is umask-dependent.
    mkdirMode(this.stagedUploadsRoot, 0o700)
    // ONBOARD-01: isolated intake staging area (sibling dir — the upload
    // staging root and cleanupStagedUploads stay untouched by intake).
    this.intakeStagedRoot = join(this.cas.root, 'intake-staged')
    mkdirMode(this.intakeStagedRoot, 0o700)
    this.tex = openTexWorkspace(options.dbPath ?? ':memory:')
    this.pty = openPtySessionStore(options.dbPath ?? ':memory:')
    this.workspaces = openWorkspaceStore(options.dbPath ?? ':memory:', options.casRoot ?? join(process.cwd(), '.research-cas'),
      // WORK-01 disk adapter: one tree root per project under the kernel's
      // data directory (dataDir/workspaces/{project_id}/{workspace_id}).
      join(dirname(options.dbPath ?? ':memory:'), 'workspaces'))
    // WORK-01 §5 P2: startup recovery scan — a crash between the atomic
    // disk write/move/delete and the SQLite row/op update leaves a window
    // ("new bytes + old row" or "row pointing at missing bytes"); repair or
    // isolate each workspace now, before any route can serve it. Healthy
    // databases scan as a no-op.
    if (options.recoverWorkspacesOnOpen !== false) {
      this.workspaces.scanWorkspaceIntegrity()
    }
    this.texFacade = new TexWorkspaceFacade(this.tex)
    this.workspaceModule = new WorkspaceModule(this.db, this.workspaces, this.texFacade, projectId => { this.getProject(projectId) })
    // TRAJ-01/SUBAGENT-01: the trajectory/topology store shares THIS
    // connection (single-writer SQLite) and emits its outbox events through
    // the kernel's canonical emit (per-aggregate monotonic event_seq).
    this.trajectory = new TrajectoryStore(this.db, (projectId, kind, payload) => this.emit(projectId, kind, payload))
    this.instanceId = options.instanceId ?? `kernel-${randomUUID().slice(0, 8)}`
    this.serviceToken = options.serviceToken
    // A blank credential must be indistinguishable from a missing one. In
    // particular it must never become an attacker-computable empty HMAC key.
    this.dshPluginToken = options.dshPluginToken?.trim() === '' ? undefined : options.dshPluginToken
    this.orchestratorToken = options.orchestratorToken?.trim() === '' ? undefined : options.orchestratorToken
    // OBS-01: the runtime metrics store is process-local; no locking needed.
    this.metrics = new MetricsStore()
    this.rollout = new MethodologyRolloutStore(this.db)
    this.methodologyTelemetry = new MethodologyTelemetry(this.metrics)
    this.analysisPort = options.analysisPort ?? deterministicAnalysisPort
    // RUN-01 (§4): signed run manifests are REQUIRED BY DEFAULT — the runner
    // registers an ephemeral Ed25519 key and signs every completion, so the
    // default only affects callers that never sign. Unit tests that exercise
    // unrelated paths opt out explicitly (freshKernel passes false).
    const persistedRequireSignedManifest = persistedKernelRuntime['kernel.require_signed_manifest']
    this.requireSignedManifest = typeof persistedRequireSignedManifest === 'boolean'
      ? persistedRequireSignedManifest
      : options.requireSignedManifest ?? true
    // §12.1 (TEX-03): preview scheduling knobs. Defaults keep the explicit
    // preview-builds hook as the canonical trigger; the pending rows are
    // durable, so any request that survived a restart is re-armed below.
    this.previewDebounceMs = options.previewDebounceMs ?? TEX_PREVIEW_DEBOUNCE_MS_DEFAULT
    this.previewAutoTrigger = options.previewAutoTrigger ?? false
    // CHUNK-01 (init-grill-upload-models.md §3): chunk size default 8 MiB,
    // hard max 32 MiB; intake quota default 2 GiB, hard max 10 GiB. An
    // instance may only TIGHTEN these (a too-large value is clamped down).
    this.intakeChunkSizeBytes = Math.min(
      options.intakeChunkSizeBytes ?? ResearchKernel.CHUNKED_UPLOAD_DEFAULT_CHUNK_BYTES,
      ResearchKernel.CHUNKED_UPLOAD_MAX_CHUNK_BYTES,
    )
    this.intakeQuotaBytes = Math.min(
      options.intakeQuotaBytes ?? ResearchKernel.INTAKE_UPLOAD_QUOTA_DEFAULT_BYTES,
      ResearchKernel.INTAKE_UPLOAD_QUOTA_MAX_BYTES,
    )
    // MODEL-01: secret root for file-scheme SecretRef availability.
    this.secretRoot = options.secretRoot ?? null
    this.providerUrlAllowlist = options.providerUrlAllowlist ?? {}
    this.runnerTargets = new RunnerTargetRegistry(
      this.db,
      ref => secretRefAvailable(ref, this.secretRoot),
      ref => serviceIdentityAvailable(ref, this.secretRoot),
      (ref, provided) => serviceIdentityTokenMatches(ref, this.secretRoot, provided),
    )
    this.ocr = new OcrStore(this.db)
    this.assurance = new AssuranceStore(this.db)
    this.methodology = new MethodologyStore(this.db)
    this.writingReview = new WritingReviewStore(this.db)
    const fail = (status: number, code: string, message: string): never => {
      throw new KernelError(status, code, message)
    }
    this.knowledgeMethodology = new KnowledgeMethodologyCoordinator({
      transaction: work => withTransaction(this.db, work),
      fail,
      getProject: projectId => this.getProject(projectId),
      getLinkedProjectId: sessionId => this.getProjectBySession(sessionId)?.project_id ?? null,
      getMemberRole: (projectId, principalId) => this.getProjectMemberRole(projectId, principalId),
      getNextActions: projectId => this.projectProjection(projectId).next_actions_v2,
      hasManuscript: projectId => this.listArtifacts(projectId)
        .some(artifact => artifact.kind === 'paper' || artifact.kind === 'tex-source'),
      store: this.methodology,
      rollout: this.rollout,
      telemetry: this.methodologyTelemetry,
    })
    this.synthesisMethodology = new SynthesisMethodologyCoordinator({
      fail,
      getProjectRevision: projectId => this.getProject(projectId).revision,
      getNextActions: projectId => this.projectProjection(projectId).next_actions_v2,
      getPendingRequests: projectId => this.listSynthesisRecordRequests(projectId).pending,
      store: this.methodology,
      rollout: this.rollout,
      telemetry: this.methodologyTelemetry,
    })
    this.writingMethodology = new WritingMethodologyCoordinator({
      transaction: work => withTransaction(this.db, work),
      fail,
      now: nowIso,
      getProject: projectId => this.getProject(projectId),
      getLinkedProjectId: sessionId => this.getProjectBySession(sessionId)?.project_id ?? null,
      getNextActions: projectId => this.projectProjection(projectId).next_actions_v2,
      getChildDetail: childId => this.getChildDetail(childId),
      getChildExecutionIdentity: childId => this.trajectory.getChildExecutionIdentity(childId),
      listArtifacts: projectId => this.listArtifacts(projectId),
      registerFindingsArtifact: input => this.registerArtifact({
        ...input,
        kind: 'analysis',
        media_type: 'application/json',
      }),
      listClaims: projectId => this.listClaims(projectId),
      listAcceptedEvidence: projectId => this.listAcceptedEvidence(projectId),
      listCorpusSnapshots: projectId => this.listCorpusSnapshots(projectId),
      manuscriptChecks: projectId => this.manuscriptReview(projectId).checks,
      tex: this.tex,
      methodology: this.methodology,
      assurance: this.assurance,
      writing: this.writingReview,
      rollout: this.rollout,
      telemetry: this.methodologyTelemetry,
    })
    // CONFIG-01: pin the effective runtime config through the registry. The
    // registry validates the values (unknown keys / floor violations throw
    // here — fail fast at construction) and returns the one-way sha256 pin.
    const pinned = validateConfig({
      ...(options.runtimeConfig ?? {}),
      'kernel.db': options.dbPath ?? ':memory:',
      'kernel.cas': options.casRoot ?? join(process.cwd(), '.research-cas'),
      'kernel.require_signed_manifest': this.requireSignedManifest,
      'kernel.service_token': this.serviceToken ?? '',
      'kernel.secret_root': this.secretRoot ?? '',
    }, {
      scopes: ['global', 'project', 'kernel'],
      imagesLock: { node_fixture: IMAGES_LOCK.node_fixture, texlive: IMAGES_LOCK.texlive },
    })
    const { __images_lock: _trustedImagesLock, ...baseConfig } = pinned.effective
    this.configWrites = new ConfigWriteStore(this.db, {
      baseConfig,
      imagesLock: { node_fixture: IMAGES_LOCK.node_fixture, texlive: IMAGES_LOCK.texlive },
      projectAuthority: {
        read: projectId => this.projectConfigSnapshot(projectId),
        list: () => this.listProjects().map(project => ({
          project_id: project.project_id,
          config: this.projectConfigSnapshot(project.project_id)!,
        })),
        apply: input => this.applyProjectConfigChanges(input),
      },
    })
    this.settingsWrites = new SettingsWriteCoordinator(this.db, this.configWrites, {
      writeOcr: (operation, actor) => this.writeOcrSettings(operation, actor),
      writeRunnerTarget: (operation, actor) => this.writeRunnerTargetSettings(operation, actor),
    })
    const effectiveConfig = this.configWrites.effective()
    this.configPinHash = effectiveConfig.config_pin
    this.configRedacted = effectiveConfig.config
    // WRITE-RECOVERY-01: a patch crosses the Kernel event connection and the
    // TeX workspace connection. Reconcile every journaled intent before the
    // server can accept work, completing either the TeX mutation or its
    // immutable application receipt deterministically.
    this.recoverWritingPatchIntents()
    // §12.1 (TEX-03): re-arm debounce timers for pending preview requests
    // that survived a kernel restart — preview state is re-projectable from
    // the kernel, it never lives only in a browser debounce timer.
    for (const pending of this.tex.listPendingPreviews()) {
      this.armPreviewTimer(pending.document_id, pending.debounce_ms)
    }
    // PTY-01: idle-TTL sweep. Sessions idle longer than their pinned
    // idle_ttl_s are closed (and their real tty torn down via the adapter)
    // even when no client ever reconnects. The timer is unref'd — it never
    // keeps the process alive and is cleared on close().
    const sweepMs = options.ptyIdleSweepMs ?? 30_000
    if (sweepMs > 0) {
      const timer = setInterval(() => {
        try {
          this.ptySweepIdle()
          // CHUNK-01: GC expired/open cleanup-ledger upload sessions alongside
          // the PTY sweep. The staged-file sweep also catches legacy orphan
          // bytes created before cleanup rows became durable.
          this.cleanupUploadSessions()
          this.cleanupIntakeStaged()
        } catch {
          // A sweep failure must never take the kernel down.
        }
      }, sweepMs)
      timer.unref()
      this.ptySweepTimer = timer
    } else {
      this.ptySweepTimer = null
    }
  }

  close(): void {
    if (this.ptySweepTimer !== null) clearInterval(this.ptySweepTimer)
    for (const timer of this.previewTimers.values()) clearTimeout(timer)
    this.previewTimers.clear()
    // PTY-01: tear down every live real tty before the stores close (the
    // adapter processes are children of this kernel — no orphans).
    for (const session of this.pty.listAllSessionsForShutdown()) {
      if (session.state !== 'closed') this.ptyNotifyClosed(session.pty_session_id)
    }
    this.tex.close()
    this.pty.close()
    this.workspaces.close()
    this.db.close()
  }

  // ── events (append-only outbox) ──────────────────────────────────────────

  /**
   * Append one event to the durable outbox (reconstruction-contracts.md §16,
   * EVENT-01). The canonical envelope is written atomically: `event_seq` is
   * allocated as per-aggregate max+1 inside the write transaction (or the
   * caller's already-open transaction — single-writer SQLite serializes the
   * read+insert). The aggregate is derived from the payload when it carries
   * `project_id` (+ optional numeric `revision`), otherwise NULL; request_id/
   * session_id pass through from the payload when present.
   */
  emit(projectId: string | null, kind: KernelEventKind, payload: Record<string, unknown> = {}): KernelEvent {
    const write = (): KernelEvent => {
      // §16 aggregate identity: project-scoped events aggregate by project.
      const aggregateType = typeof payload.project_id === 'string' && payload.project_id !== '' ? 'project' : null
      const aggregateId = aggregateType !== null ? String(payload.project_id) : null
      const aggregateRevision = typeof payload.revision === 'number' ? payload.revision : null
      const requestId = typeof payload.request_id === 'string' && payload.request_id !== '' ? payload.request_id : null
      const sessionId = typeof payload.session_id === 'string' && payload.session_id !== '' ? payload.session_id : null
      // max+1 within the aggregate bucket (NULL buckets allocate among
      // aggregate-less events; SQLite treats NULLs as distinct in the unique
      // index, so bucket-local allocation can never collide).
      const next = (this.db.prepare(
        'SELECT COALESCE(MAX(event_seq), 0) + 1 AS next FROM events WHERE aggregate_type IS ? AND aggregate_id IS ?',
      ).get(aggregateType, aggregateId) as { next: number }).next
      const event: KernelEvent = {
        event_id: randomId('evt'),
        project_id: projectId,
        kind,
        payload,
        source: `kernel:${this.instanceId}`,
        delivered: false,
        created_at: nowIso(),
        event_seq: next,
        event_version: 1,
        aggregate_type: aggregateType,
        aggregate_id: aggregateId,
        aggregate_revision: aggregateRevision,
        request_id: requestId,
        session_id: sessionId,
        attempts: 0,
        last_error: null,
        next_attempt_at: null,
        dead_lettered_at: null,
      }
      this.db.prepare(
        `INSERT INTO events (event_id, project_id, kind, payload, source, delivered, created_at,
           event_seq, event_version, aggregate_type, aggregate_id, aggregate_revision,
           request_id, session_id, attempts, last_error, next_attempt_at, dead_lettered_at)
         VALUES (?, ?, ?, ?, ?, 0, ?, ?, 1, ?, ?, ?, ?, ?, 0, NULL, NULL, NULL)`,
      ).run(
        event.event_id, event.project_id, event.kind, JSON.stringify(event.payload), event.source, event.created_at,
        next, aggregateType, aggregateId, aggregateRevision,
        requestId, sessionId,
      )
      // OBS-01: outbox append counter (kind is a fixed event-kind constant).
      this.metrics.count('outbox.append', { kind })
      return event
    }
    // §16 "SQLite 单写事务分配 event_seq=max+1": emit already running inside
    // a caller transaction (e.g. createProjectWithInitialGate) reuses it —
    // node:sqlite forbids nested BEGIN, so only standalone emits open one.
    if (this.db.isTransaction) return write()
    return withTransaction(this.db, write)
  }

  listEvents(projectId?: string, delivered?: boolean): KernelEvent[] {
    const rows = projectId === undefined
      ? this.db.prepare('SELECT * FROM events ORDER BY created_at').all() as unknown as OutboxEventRow[]
      : this.db.prepare('SELECT * FROM events WHERE project_id = ? ORDER BY created_at').all(projectId) as unknown as OutboxEventRow[]
    return rows
      .filter(row => delivered === undefined || row.delivered === (delivered ? 1 : 0))
      .map(eventFromRow)
  }

  /**
   * §16 consumer-side delivery bookkeeping: mark one undeliverable event as
   * dead-lettered (the original event is kept, per §16). Records the
   * `outbox.dead_letter` metric (OBS-01). Returns true when the event was
   * transitioned (false when it was already dead-lettered or unknown).
   */
  deadLetterEvent(eventId: string, reason = 'max delivery attempts exceeded'): boolean {
    const result = this.db.prepare(
      'UPDATE events SET dead_lettered_at = ?, last_error = ? WHERE event_id = ? AND dead_lettered_at IS NULL',
    ).run(nowIso(), reason, eventId)
    if (Number(result.changes) === 1) {
      this.metrics.count('outbox.dead_letter')
      return true
    }
    return false
  }

  /** At-least-once delivery: mark events delivered; the caller dedupes. */
  markEventsDelivered(eventIds: string[]): void {
    const stmt = this.db.prepare('UPDATE events SET delivered = 1 WHERE event_id = ? AND delivered = 0')
    for (const id of eventIds) stmt.run(id)
  }

  // ── trajectory projection & subagent topology (trajectory-subagents.md) ──

  /** Read-only, redacted outbox projection with keyset pagination
   * ((event_seq, event_id) cursor; single page ≤ 500). */
  projectTrajectory(projectId: string, opts: Parameters<TrajectoryStore['projectTrajectory']>[1] = {}): ReturnType<TrajectoryStore['projectTrajectory']> {
    return this.trajectory.projectTrajectory(projectId, opts)
  }

  /** Research + Session lanes for one project (both always returned). */
  projectTrajectoryLanes(projectId: string, opts: Parameters<TrajectoryStore['projectTrajectoryLanes']>[1] = {}): ReturnType<TrajectoryStore['projectTrajectoryLanes']> {
    return this.trajectory.projectTrajectoryLanes(projectId, opts)
  }

  /** Record a spawned subagent child (plugin research_panel wiring is a
   * later integration; the kernel surface + tests cover the contract). */
  registerChildLink(input: Parameters<TrajectoryStore['registerChildLink']>[0]): ReturnType<TrajectoryStore['registerChildLink']> {
    return this.trajectory.registerChildLink(input)
  }

  getChildLink(childId: string): ReturnType<TrajectoryStore['getChildLink']> {
    return this.trajectory.getChildLink(childId)
  }

  updateChildState(childId: string, state: Parameters<TrajectoryStore['updateChildState']>[1], detail?: string): ReturnType<TrajectoryStore['updateChildState']> {
    return this.trajectory.updateChildState(childId, state, detail)
  }

  /** Exact direct children of a parent (or roots); bounded pages. */
  projectTopology(projectId: string, opts: Parameters<TrajectoryStore['projectTopology']>[1] = {}): ReturnType<TrajectoryStore['projectTopology']> {
    return this.trajectory.projectTopology(projectId, opts)
  }

  /** Exact-parent + breadcrumb (cycle-safe, orphan fail-soft). */
  getChildDetail(childId: string): ReturnType<TrajectoryStore['getChildDetail']> {
    return this.trajectory.getChildDetail(childId)
  }

  /** Read-only per-child history; never activates the child. */
  childHistory(childId: string, opts: Parameters<TrajectoryStore['childHistory']>[1] = {}): ReturnType<TrajectoryStore['childHistory']> {
    return this.trajectory.childHistory(childId, opts)
  }

  /** One-shot READ-ONLY followup: records the message, returns message_id,
   * child state untouched. */
  childFollowup(childId: string, message: string, requestId?: string): ReturnType<TrajectoryStore['childFollowup']> {
    return this.trajectory.childFollowup(childId, message, requestId)
  }

  /** Owning project of a child (BFF membership pre-check; null = unknown). */
  childProjectId(childId: string): string | null {
    return this.trajectory.childProjectId(childId)
  }

  // ── projects ─────────────────────────────────────────────────────────────

  createProject(input: {
    name: string
    workspace: string
    brief: ResearchBrief
    mode?: 'gate-only' | 'full-auto'
    constraints?: ResearchProject['constraints']
    execution?: ResearchProject['execution']
    integrity?: ResearchProject['integrity']
    session_id?: string | null
    dsh_workspace_id?: string | null
    brief_status?: 'collecting' | 'confirmed'
    creator_principal_id?: string
    creator_tenant_id?: string
    session_issuer?: 'standalone' | 'dsh-plugin' | 'kernel'
  }): ResearchProject {
    if (input.session_id !== undefined && input.session_id !== null
      && (input.creator_principal_id === undefined || input.creator_principal_id.trim() === '')) {
      throw new KernelError(422, 'principal_required', 'a project session link requires an authenticated creator principal')
    }
    // hardening: store the PARSED brief (defaults applied), never the raw
    // caller object — projection and ledger stay consistent.
    const brief = ResearchBrief.parse(input.brief)
    // CONFIG-01: the project-scope effective config (execution + integrity)
    // must pass the canonical Config Registry — the zod parses below reject
    // unknown keys and wrong values; the registry additionally enforces the
    // security floor for programmatic callers (docker socket / privileged /
    // host network / images.lock pins). Throws ConfigRegistryError on
    // violation before anything is persisted.
    // Name-only / omitted execution starts explicitly unconfigured. This is
    // intentionally different from choosing the built-in local Docker
    // profile: no execution path may treat null as a default runner.
    const execution = ExecutionConfig.parse({ runner_profile_id: null, ...(input.execution ?? {}) })
    const integrity = IntegrityConfig.parse(input.integrity ?? {})
    // canonical registry keys are dotted: execution.* / integrity.*
    const projectConfig: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(execution)) projectConfig[`execution.${key}`] = value
    for (const [key, value] of Object.entries(integrity)) projectConfig[`integrity.${key}`] = value
    validateConfig(projectConfig, { scopes: ['project'] })
    // product-spec.md §1 / README 使用边界: high-risk domains (clinical
    // decision-making, human trials, wet-lab, weapons, biosecurity) are
    // OUTSIDE the product boundary — the system must not proceed with them.
    // Fail closed at creation with a stable code (default-denial posture);
    // an independent policy extension would relax this list explicitly.
    const HIGH_RISK_DOMAINS = ['clinical', 'clinical-decision', 'human-trial', 'human-trials', 'wet-lab', 'wetlab', 'weapon', 'weapons', 'biosecurity', 'bio-safety']
    const domain = (brief.domain ?? '').toLowerCase().trim()
    if (HIGH_RISK_DOMAINS.includes(domain)) {
      throw new KernelError(422, 'domain_unsupported',
        `domain '${brief.domain}' is a high-risk domain (clinical decision-making / human trials / wet-lab / weapons / biosecurity) — DSH Scholar is for pure-computation research only (product-spec.md §1)`)
    }
    // reconstruction-contracts.md §5 / security-baseline.md §1: full-auto is
    // fixture-only — the project must bind a REGISTERED FixtureProfile at
    // creation; job submit re-checks below. Unknown/missing -> 422, nothing
    // is persisted (no unbound full-auto project rows can exist).
    const mode = input.mode ?? 'gate-only'
    if (mode === 'full-auto' && getFixtureProfile(execution.fixture_id ?? '') === null) {
      throw new KernelError(422, 'fixture_required',
        'full-auto projects require execution.fixture_id bound to a REGISTERED FixtureProfile (reconstruction-contracts.md §5); unknown fixture ids are rejected')
    }
    if (mode === 'full-auto' && execution.runner_profile_id === null) {
      throw new KernelError(422, 'runner_profile_required',
        'full-auto projects require an explicit registered execution.runner_profile_id; no local runner is selected implicitly')
    }
    // A name-only DRAFT may exist while its runner is unconfigured. Any
    // non-null profile must already be a registered, compatible target; Job
    // submission remains fail-closed for the explicit null state below.
    const projectProfileRef = execution.runner_profile_id
    const projectProfileId = projectProfileRef === null ? null : resolveRunnerProfileId(projectProfileRef)
    const projectProfile = projectProfileId === null ? null : getRunnerProfile(projectProfileId)
    if (projectProfileRef !== null && (projectProfile === null || !projectProfile.enabled)) {
      throw new KernelError(422, 'runner_profile_unknown',
        `execution runner profile ${projectProfileRef} is not an enabled registered opaque RunnerProfile id`)
    }
    const projectTarget = this.listRunnerTargets().find(target => target.target_id === execution.runner_target_id)
    if (projectTarget === undefined) {
      throw new KernelError(422, 'runner_target_unknown',
        `execution.runner_target_id ${execution.runner_target_id} is not a registered opaque RunnerTarget id`)
    }
    if (!projectTarget.enabled || projectTarget.draining) {
      throw new KernelError(409, projectTarget.draining ? 'runner_target_draining' : 'runner_target_disabled',
        `runner target ${projectTarget.target_id} is not accepting new projects`)
    }
    if (projectProfile?.runner_mode === 'isolated-subprocess' && projectTarget.kind !== 'local-process') {
      throw new KernelError(422, 'runner_target_profile_mismatch', 'isolated-subprocess profile requires a local-process target')
    }
    if (projectProfile?.runner_mode === 'local-docker' && projectTarget.kind === 'local-process') {
      throw new KernelError(422, 'runner_target_profile_mismatch', 'container profile cannot execute on a local-process target')
    }
    const project: ResearchProject = {
      project_id: buildProjectId(),
      name: input.name,
      workspace: input.workspace,
      mode,
      status: 'DRAFT',
      revision: 0,
      brief_status: input.brief_status ?? 'confirmed',
      brief,
      constraints: BudgetConstraints.parse(input.constraints ?? {}),
      execution,
      integrity,
      session_id: input.session_id ?? null,
      dsh_workspace_id: input.dsh_workspace_id ?? null,
      created_at: nowIso(),
      updated_at: nowIso(),
      history: ['created'],
      deleted_at: null,
      deleted_by: null,
      deletion_reason: null,
    }
    this.db.prepare(
      `INSERT INTO projects (project_id, name, workspace, mode, status, revision, brief_status, brief, constraints, execution, integrity, session_id, dsh_workspace_id, created_at, updated_at, history)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      project.project_id, project.name, project.workspace, project.mode, project.status, project.revision,
      project.brief_status ?? 'confirmed',
      JSON.stringify(project.brief), JSON.stringify(project.constraints), JSON.stringify(project.execution),
      JSON.stringify(project.integrity), project.session_id, project.dsh_workspace_id,
      project.created_at, project.updated_at, JSON.stringify(project.history),
    )
    // API-01 foundation: the creator becomes the first PI member
    // (reconstruction-contracts.md §7: "Project creator 成为 pi").
    const creator = input.creator_principal_id
    if (creator !== undefined && creator !== '') {
      this.db.prepare(`INSERT INTO project_members (project_id, principal_id, tenant_id, role, created_at, updated_at)
        VALUES (?, ?, ?, 'pi', ?, ?)`)
        .run(project.project_id, creator, input.creator_tenant_id ?? '', project.created_at, project.created_at)
    }
    if (project.session_id !== null) {
      this.linkSession(project.session_id, project.project_id, {
        principal_id: creator!,
        tenant_id: input.creator_tenant_id ?? '',
        issuer: input.session_issuer ?? 'kernel',
      })
    }
    this.emit(project.project_id, 'project.created', { project_id: project.project_id, name: project.name })
    return project
  }

  /**
   * v2 (api-contracts.md §4): atomic create-project with the initial Scope
   * Gate + creator membership + budget, plus the BFF-scoped Idempotency-Key.
   * Replaying the same key + request hash returns the SAME project/gate/
   * budget/membership; the same key with a different request hash is a 409.
   */
  createProjectWithInitialGate(input: Parameters<ResearchKernel['createProject']>[0] & {
    idempotency_key?: string
    request_hash?: string
  }): { project: ResearchProject; gate: Gate; budget: BudgetRecord; membership: Array<Record<string, unknown>> } {
    if (input.idempotency_key !== undefined && input.idempotency_key !== '') {
      const existing = this.db.prepare('SELECT project_id, request_hash FROM projects WHERE idempotency_key = ?')
        .get(input.idempotency_key) as { project_id: string; request_hash: string | null } | undefined
      if (existing !== undefined) {
        if (existing.request_hash !== (input.request_hash ?? '')) {
          throw new KernelError(409, 'idempotency_conflict', `idempotency key ${input.idempotency_key} was used with a different request hash`)
        }
        return {
          project: this.getProject(existing.project_id),
          gate: this.listGates(existing.project_id, 'pending').find(g => g.type === 'scope') ?? this.listGates(existing.project_id)[0]!,
          budget: this.getBudget(existing.project_id),
          membership: this.listProjectMembers(existing.project_id),
        }
      }
    }
    return withTransaction(this.db, () => {
      const project = this.createProject(input)
      // Initial Scope Gate (v2 contract: the project ships with it).
      const gate = this.createGate({
        project_id: project.project_id,
        type: 'scope',
        title: 'Scope Gate',
        summary: 'Initial scope approval required before any research work.',
      })
      const budget = this.getBudget(project.project_id)
      if (input.idempotency_key !== undefined && input.idempotency_key !== '') {
        this.db.prepare('UPDATE projects SET idempotency_key = ?, request_hash = ? WHERE project_id = ?')
          .run(input.idempotency_key, input.request_hash ?? '', project.project_id)
      }
      return { project, gate, budget, membership: this.listProjectMembers(project.project_id) }
    })
  }

  /**
   * INIT-GRILL-02: atomically create a name-only DRAFT shell plus its active
   * Init Intake. No Scope Gate exists until a PI confirms the collected Brief.
   */
  createProjectForGrill(input: {
    name: string
    creator_principal_id: string
    creator_tenant_id?: string
    idempotency_key: string
    request_hash: string
    /** Internal DSH Host seam only: atomically bind the newly-created shell
     * to this exact session. Public v2 callers never supply this field. */
    session_id?: string
    /** Internal reconciliation mode: an absent idempotency receipt is a
     * zero-write 404 rather than permission to create. */
    replay_only?: boolean
  }): { project: ResearchProject; intake: IntakeSession; budget: BudgetRecord; membership: Array<Record<string, unknown>> } {
    const name = input.name.trim()
    if (name === '' || name.length > 120) {
      throw new KernelError(422, 'validation_error', 'project name must be 1-120 characters after trimming')
    }
    if (input.creator_principal_id.trim() === '') {
      throw new KernelError(422, 'principal_required', 'name-only project creation requires a Human Principal')
    }
    const sessionId = input.session_id
    if (sessionId !== undefined && !/^[A-Za-z0-9][A-Za-z0-9._:@-]{0,255}$/.test(sessionId)) {
      throw new KernelError(422, 'invalid_session_id', 'DSH session id is not a safe opaque id')
    }
    return withTransaction(this.db, () => {
      // Keep the idempotency lookup and session-link decision under the same
      // BEGIN IMMEDIATE lock as creation. This makes two Kernel processes
      // converge on a replay/conflict instead of both passing a preflight.
      const existing = this.db.prepare('SELECT project_id, request_hash FROM projects WHERE idempotency_key = ?')
        .get(input.idempotency_key) as { project_id: string; request_hash: string | null } | undefined
      if (existing !== undefined) {
        if (existing.request_hash !== input.request_hash) {
          throw new KernelError(409, 'idempotency_conflict', `idempotency key ${input.idempotency_key} was used with a different request hash`)
        }
        const project = this.getProject(existing.project_id)
        if (sessionId !== undefined) {
          const rawLink = this.db.prepare('SELECT session_id, project_id, principal_id, tenant_id, issuer, linked_at FROM session_links WHERE session_id = ?')
            .get(sessionId) as SessionLink | undefined
          const membership = this.listProjectMembers(project.project_id)
          if (rawLink?.project_id !== project.project_id || project.session_id !== sessionId
            || rawLink.principal_id !== input.creator_principal_id
            || !membership.some(member => member.principal_id === input.creator_principal_id && member.role === 'pi')) {
            throw new KernelError(409, 'session_link_conflict', 'idempotent DSH project receipt is not bound to this session and creator')
          }
        }
        const intake = this.listIntakes(project.project_id).find(item => item.status !== 'accepted' && item.status !== 'rejected' && item.status !== 'expired' && item.status !== 'failed')
        if (intake === undefined) throw new KernelError(409, 'intake_state_conflict', 'collecting project has no active Init Intake')
        return { project, intake, budget: this.getBudget(project.project_id), membership: this.listProjectMembers(project.project_id) }
      }
      if (input.replay_only === true) {
        throw new KernelError(404, 'idempotency_receipt_not_found', 'no committed DSH project creation matches this idempotency key')
      }
      if (sessionId !== undefined) {
        // Read the raw row, not getProjectBySession(): tombstoned and dangling
        // links are still authoritative fences and must never be overwritten.
        const rawLink = this.db.prepare('SELECT project_id FROM session_links WHERE session_id = ?')
          .get(sessionId) as { project_id: string } | undefined
        if (rawLink !== undefined) {
          throw new KernelError(409, 'session_link_conflict', 'DSH session already has an authoritative link')
        }
      }
      const slug = name.normalize('NFKC').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48) || 'project'
      const project = this.createProject({
        name,
        workspace: `/research/${slug}`,
        brief_status: 'collecting',
        brief: {
          problem: '[collecting]',
          scope: '[collecting]',
          questions: [],
          primary_metrics: [],
          resources: '',
          risks: [],
          target_outputs: ['conference-paper'],
          target_venue: null,
          baseline_repo: null,
          domain: 'machine-learning',
        },
        creator_principal_id: input.creator_principal_id,
        creator_tenant_id: input.creator_tenant_id,
      } as Parameters<ResearchKernel['createProject']>[0] & { creator_principal_id: string; creator_tenant_id?: string })
      if (sessionId !== undefined) {
        this.linkSessionExclusive(sessionId, project.project_id, {
          principal_id: input.creator_principal_id,
          tenant_id: input.creator_tenant_id ?? '',
          issuer: 'dsh-plugin',
        })
        this.db.prepare('UPDATE projects SET session_id = ? WHERE project_id = ?').run(sessionId, project.project_id)
        project.session_id = sessionId
      }
      const intake = this.beginIntake({
        project_id: project.project_id,
        source_label: 'project-init',
        target_phase: 'brief',
        owner: { principal_id: input.creator_principal_id, tenant_id: input.creator_tenant_id ?? '', auth_method: 'session' },
        idempotency_key: `project-init:${project.project_id}`,
        request_hash: input.request_hash,
      })
      this.db.prepare('UPDATE projects SET idempotency_key = ?, request_hash = ? WHERE project_id = ?')
        .run(input.idempotency_key, input.request_hash, project.project_id)
      return { project, intake, budget: this.getBudget(project.project_id), membership: this.listProjectMembers(project.project_id) }
    })
  }

  /** DSH-CREATE-LINK-01: service-only name-only Init with the session link
   * committed in the same transaction as the Project and active Intake. */
  createProjectForDshSession(input: {
    name: string
    session_id: string
    idempotency_key: string
    request_hash: string
    replay_only?: boolean
  }): ReturnType<ResearchKernel['createProjectForGrill']> & { link: SessionLink } {
    if (this.dshPluginToken === undefined) {
      throw new KernelError(403, 'dsh_plugin_token_required', 'DSH project creation requires the DSH plugin credential')
    }
    const creatorPrincipal = dshOperatorPrincipal(this.dshPluginToken)
    const out = this.createProjectForGrill({ ...input, creator_principal_id: creatorPrincipal })
    const link = this.db.prepare('SELECT session_id, project_id, principal_id, tenant_id, issuer, linked_at FROM session_links WHERE session_id = ?')
      .get(input.session_id) as SessionLink | undefined
    if (link === undefined || link.project_id !== out.project.project_id) {
      throw new KernelError(409, 'session_link_conflict', 'DSH session link was not committed with the created project')
    }
    return { ...out, link }
  }

  /** Bind an existing operator-owned project to an unbound DSH session.
   * The link is an authoritative fence: retries for the same pair are
   * idempotent, while every attempted rebind fails with 409. */
  linkProjectForDshSession(input: { session_id: string; project_id: string }): SessionLink {
    if (this.dshPluginToken === undefined || this.dshPluginToken.trim() === '') {
      throw new KernelError(403, 'dsh_plugin_token_required', 'DSH project binding requires the DSH plugin credential')
    }
    if (!/^[A-Za-z0-9][A-Za-z0-9._:@-]{0,255}$/.test(input.session_id)) {
      throw new KernelError(422, 'invalid_session_id', 'DSH session id is not a safe opaque id')
    }
    return withTransaction(this.db, () => {
      const project = this.getProject(input.project_id)
      const principal = dshOperatorPrincipal(this.dshPluginToken!)
      if (!this.listProjectMembers(project.project_id).some(member => member.principal_id === principal)) {
        throw new KernelError(404, 'project_not_found', 'project not found or access denied')
      }
      if (project.status === 'ARCHIVED') {
        throw new KernelError(409, 'project_archived', 'an archived project cannot be linked to a DSH session')
      }
      const existing = this.db.prepare('SELECT session_id, project_id, principal_id, tenant_id, issuer, linked_at FROM session_links WHERE session_id = ?')
        .get(input.session_id) as SessionLink | undefined
      if (existing !== undefined) {
        if (existing.project_id === project.project_id && existing.principal_id === principal) return existing
        throw new KernelError(409, 'session_link_conflict', 'DSH session already has an authoritative link')
      }
      const member = this.listProjectMembers(project.project_id).find(candidate => candidate.principal_id === principal)!
      return this.linkSessionExclusive(input.session_id, project.project_id, {
        principal_id: principal,
        tenant_id: member.tenant_id,
        issuer: 'dsh-plugin',
      })
    })
  }

  /** Projects visible to the stable local DSH operator. */
  listProjectsForDshOperator(): ResearchProject[] {
    if (this.dshPluginToken === undefined || this.dshPluginToken.trim() === '') {
      throw new KernelError(403, 'dsh_plugin_token_required', 'DSH project selection requires the DSH plugin credential')
    }
    const principal = dshOperatorPrincipal(this.dshPluginToken)
    return this.listProjects().filter(project =>
      this.listProjectMembers(project.project_id).some(member => member.principal_id === principal))
  }

  /** Stable, versioned INIT-GRILL-02 question order. */
  private static readonly PROJECT_GRILL_QUESTIONS = [
    { question_code: 'brief.problem', prompt_key: 'grill.question.problem', required: true },
    { question_code: 'brief.scope', prompt_key: 'grill.question.scope', required: true },
    { question_code: 'brief.questions', prompt_key: 'grill.question.questions', required: true },
    { question_code: 'brief.primary_metrics', prompt_key: 'grill.question.primaryMetrics', required: true },
    { question_code: 'brief.target_outputs', prompt_key: 'grill.question.targetOutputs', required: true },
    { question_code: 'brief.constraints', prompt_key: 'grill.question.constraints', required: true },
    { question_code: 'brief.material_context', prompt_key: 'grill.question.materialContext', required: true },
  ] as const

  projectGrillProjection(projectId: string): {
    project_id: string
    project_revision: number
    intake_id: string
    intake_revision: number
    question: { question_code: string; question_revision: number; prompt_key: string; required: boolean } | null
    answers: Array<{ question_code: string; question_revision: number; value: unknown; disposition: string; answered_by: string; answered_at: string }>
    brief_preview: ResearchBrief
    ready_to_confirm: boolean
  } {
    const project = this.getProject(projectId)
    if (project.brief_status !== 'collecting') {
      const intake = this.listIntakes(projectId).find(item => item.source_label === 'project-init')
      return {
        project_id: projectId,
        project_revision: project.revision,
        intake_id: intake?.intake_id ?? '',
        intake_revision: intake?.revision ?? 0,
        question: null,
        answers: this.projectGrillAnswers(projectId),
        brief_preview: project.brief,
        ready_to_confirm: false,
      }
    }
    const intake = this.listIntakes(projectId).find(item => item.source_label === 'project-init' && !['accepted', 'rejected', 'expired', 'failed'].includes(item.status))
    if (intake === undefined) throw new KernelError(409, 'intake_state_conflict', 'collecting project has no active Init Intake')
    const answers = this.projectGrillAnswers(projectId)
    const byCode = new Map(answers.map(answer => [answer.question_code, answer]))
    const definition = ResearchKernel.PROJECT_GRILL_QUESTIONS.find(item => !byCode.has(item.question_code))
    return {
      project_id: projectId,
      project_revision: project.revision,
      intake_id: intake.intake_id,
      intake_revision: intake.revision,
      question: definition === undefined ? null : { ...definition, question_revision: 1 },
      answers,
      brief_preview: this.projectGrillBrief(answers),
      ready_to_confirm: definition === undefined,
    }
  }

  private projectGrillAnswers(projectId: string): Array<{ question_code: string; question_revision: number; value: unknown; disposition: string; answered_by: string; answered_at: string }> {
    const rows = this.db.prepare(`SELECT question_code, question_revision, value_json, disposition,
      answered_by_principal, answered_at FROM project_grill_answers WHERE project_id = ?`)
      .all(projectId) as unknown as Array<{ question_code: string; question_revision: number; value_json: string | null; disposition: string; answered_by_principal: string; answered_at: string }>
    const order = new Map<string, number>(ResearchKernel.PROJECT_GRILL_QUESTIONS.map((item, index) => [item.question_code, index]))
    return rows.map(row => ({
      question_code: row.question_code,
      question_revision: row.question_revision,
      value: jsonParse(row.value_json, null),
      disposition: row.disposition,
      answered_by: row.answered_by_principal,
      answered_at: row.answered_at,
    })).sort((a, b) => (order.get(a.question_code) ?? 99) - (order.get(b.question_code) ?? 99))
  }

  private projectGrillBrief(answers: Array<{ question_code: string; value: unknown; disposition: string }>): ResearchBrief {
    const values = new Map(answers.map(answer => [answer.question_code, answer.disposition === 'answered' ? answer.value : null]))
    const text = (code: string, fallback: string): string => {
      const value = values.get(code)
      return typeof value === 'string' && value.trim() !== '' ? value.trim() : fallback
    }
    const strings = (code: string, fallback: string[]): string[] => {
      const value = values.get(code)
      if (Array.isArray(value)) {
        const items = value.map(String).map(item => item.trim()).filter(Boolean)
        if (items.length > 0) return items
      }
      if (typeof value === 'string') {
        const items = value.split(/\r?\n|,/).map(item => item.trim()).filter(Boolean)
        if (items.length > 0) return items
      }
      return fallback
    }
    const constraints = text('brief.constraints', '[unknown constraints]')
    const materials = text('brief.material_context', '[no material context supplied]')
    return ResearchBrief.parse({
      problem: text('brief.problem', '[unknown research problem]'),
      scope: text('brief.scope', '[unknown research scope]'),
      questions: strings('brief.questions', []),
      primary_metrics: strings('brief.primary_metrics', []),
      resources: `${constraints}\nMaterials: ${materials}`,
      risks: [],
      target_outputs: strings('brief.target_outputs', ['conference-paper']),
      target_venue: null,
      baseline_repo: null,
      domain: 'machine-learning',
    })
  }

  answerProjectGrill(input: {
    project_id: string
    question_code: string
    question_revision: number
    value?: unknown
    disposition?: 'answered' | 'skipped' | 'unknown'
    principal_id: string
  }): ReturnType<ResearchKernel['projectGrillProjection']> {
    const project = this.getProject(input.project_id)
    if (project.brief_status !== 'collecting') throw new KernelError(409, 'brief_already_confirmed', 'Research Brief is already confirmed')
    const definition = ResearchKernel.PROJECT_GRILL_QUESTIONS.find(item => item.question_code === input.question_code)
    if (definition === undefined) throw new KernelError(422, 'grill_question_unknown', `unknown Grill question ${input.question_code}`)
    if (input.principal_id.trim() === '') throw new KernelError(422, 'principal_required', 'Grill answers require a Human Principal')
    const intake = this.listIntakes(input.project_id).find(item => item.source_label === 'project-init' && !['accepted', 'rejected', 'expired', 'failed'].includes(item.status))
    if (intake === undefined) throw new KernelError(409, 'intake_state_conflict', 'collecting project has no active Init Intake')
    const row = this.db.prepare('SELECT question_revision FROM project_grill_answers WHERE project_id = ? AND question_code = ?')
      .get(input.project_id, input.question_code) as { question_revision: number } | undefined
    const currentRevision = row?.question_revision ?? 1
    if (input.question_revision !== currentRevision) {
      throw new KernelError(409, 'question_revision_conflict', `expected question revision ${currentRevision}, got ${input.question_revision}`)
    }
    const disposition = input.disposition ?? 'answered'
    if (disposition === 'answered' && input.value === undefined) throw new KernelError(422, 'question_required', 'answered Grill question requires value')
    const answeredAt = nowIso()
    return withTransaction(this.db, () => {
      this.db.prepare(`INSERT INTO project_grill_answers
        (project_id, intake_id, question_code, question_revision, value_json, disposition, answered_by_principal, answered_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(project_id, question_code) DO UPDATE SET
          question_revision = excluded.question_revision, value_json = excluded.value_json,
          disposition = excluded.disposition, answered_by_principal = excluded.answered_by_principal,
          answered_at = excluded.answered_at`)
        .run(input.project_id, intake.intake_id, input.question_code, currentRevision + 1,
          JSON.stringify(input.value ?? null), disposition, input.principal_id, answeredAt)
      this.db.prepare(`UPDATE intake_sessions SET status = 'grilling', revision = revision + 1,
        updated_at = ? WHERE intake_id = ?`).run(answeredAt, intake.intake_id)
      return this.projectGrillProjection(input.project_id)
    })
  }

  confirmProjectGrill(input: {
    project_id: string
    expected_project_revision: number
    expected_intake_revision: number
    principal_id: string
    request_id: string
    request_hash: string
  }): { project: ResearchProject; intake: IntakeSession; gate: Gate } {
    const row = this.db.prepare(`SELECT brief_status, brief_confirm_request_id, brief_confirm_request_hash
      FROM projects WHERE project_id = ? AND deleted_at IS NULL`).get(input.project_id) as {
        brief_status: string; brief_confirm_request_id: string | null; brief_confirm_request_hash: string | null
      } | undefined
    if (row === undefined) throw new KernelError(404, 'project_not_found', 'project not found')
    if (row.brief_confirm_request_id === input.request_id) {
      if (row.brief_confirm_request_hash !== input.request_hash) throw new KernelError(409, 'idempotency_conflict', 'confirm request id was used with a different request')
      const gate = this.listGates(input.project_id).find(item => item.type === 'scope')
      const intake = this.listIntakes(input.project_id).find(item => item.source_label === 'project-init')
      if (gate === undefined || intake === undefined) throw new KernelError(409, 'brief_confirm_incomplete', 'confirmed Brief is missing its Gate or Intake')
      return { project: this.getProject(input.project_id), intake, gate }
    }
    if (row.brief_status !== 'collecting') throw new KernelError(409, 'brief_already_confirmed', 'Research Brief is already confirmed')
    const project = this.getProject(input.project_id)
    const intake = this.listIntakes(input.project_id).find(item => item.source_label === 'project-init' && !['accepted', 'rejected', 'expired', 'failed'].includes(item.status))
    if (intake === undefined) throw new KernelError(409, 'intake_state_conflict', 'collecting project has no active Init Intake')
    if (project.revision !== input.expected_project_revision) throw new KernelError(409, 'revision_conflict', `expected project revision ${input.expected_project_revision}, got ${project.revision}`)
    if (intake.revision !== input.expected_intake_revision) throw new KernelError(409, 'intake_revision_conflict', `expected intake revision ${input.expected_intake_revision}, got ${intake.revision}`)
    const answers = this.projectGrillAnswers(input.project_id)
    const answered = new Set(answers.map(answer => answer.question_code))
    const missing = ResearchKernel.PROJECT_GRILL_QUESTIONS.filter(item => item.required && !answered.has(item.question_code)).map(item => item.question_code)
    if (missing.length > 0) throw new KernelError(422, 'question_required', `required Grill questions remain: ${missing.join(', ')}`)
    const brief = this.projectGrillBrief(answers)
    return withTransaction(this.db, () => {
      const now = nowIso()
      const update = this.db.prepare(`UPDATE projects SET brief = ?, brief_status = 'confirmed',
        brief_confirm_request_id = ?, brief_confirm_request_hash = ?, revision = revision + 1,
        updated_at = ?, history = ? WHERE project_id = ? AND revision = ? AND brief_status = 'collecting'`)
        .run(JSON.stringify(brief), input.request_id, input.request_hash, now,
          JSON.stringify([...project.history, 'brief confirmed']), input.project_id, input.expected_project_revision)
      if (Number(update.changes) !== 1) throw new KernelError(409, 'revision_conflict', 'project changed while confirming the Brief')
      this.db.prepare(`UPDATE intake_sessions SET status = 'accepted', revision = revision + 1,
        updated_at = ? WHERE intake_id = ? AND revision = ?`)
        .run(now, intake.intake_id, input.expected_intake_revision)
      const existingGate = this.listGates(input.project_id).find(item => item.type === 'scope')
      if (existingGate !== undefined) throw new KernelError(409, 'scope_gate_exists', 'a Scope Gate already exists for this project')
      const gate = this.createGate({ project_id: input.project_id, type: 'scope', title: 'Scope Gate', summary: brief.scope })
      const updated = this.getProject(input.project_id)
      this.emit(input.project_id, 'project.brief.confirmed', { project_id: input.project_id, revision: updated.revision, intake_id: intake.intake_id, gate_id: gate.gate_id, confirmed_by: input.principal_id })
      const updatedIntake = this.listIntakes(input.project_id).find(item => item.intake_id === intake.intake_id)!
      return { project: updated, intake: updatedIntake, gate }
    })
  }

  /**
   * v2 keyset pagination (api-contracts.md §1): items ordered by
   * (updated_at DESC, project_id DESC); cursor encodes the last row.
   */
  listProjectsPage(limit = 50, cursor?: string): { items: ProjectRow[]; next_cursor: string | null } {
    const cap = Math.min(Math.max(limit, 1), 200)
    let after: { updated_at: string; project_id: string } | null = null
    if (cursor !== undefined && cursor !== '') {
      // api-contracts.md §1: a malformed cursor is an explicit 400, never a
      // silent restart-from-top.
      let raw: string
      try {
        raw = Buffer.from(cursor, 'base64url').toString('utf8')
      } catch {
        throw new KernelError(400, 'invalid_cursor', `malformed cursor: ${cursor}`)
      }
      const [updatedAt, projectId] = raw.split('|')
      if (updatedAt === undefined || projectId === undefined || updatedAt === '' || projectId === '') {
        throw new KernelError(400, 'invalid_cursor', `malformed cursor: ${cursor}`)
      }
      after = { updated_at: updatedAt, project_id: projectId }
    }
    const rows = after === null
      ? this.db.prepare('SELECT * FROM projects WHERE deleted_at IS NULL ORDER BY updated_at DESC, project_id DESC LIMIT ?').all(cap + 1) as unknown as ProjectRow[]
      : this.db.prepare('SELECT * FROM projects WHERE deleted_at IS NULL AND (updated_at < ? OR (updated_at = ? AND project_id < ?)) ORDER BY updated_at DESC, project_id DESC LIMIT ?')
        .all(after.updated_at, after.updated_at, after.project_id, cap + 1) as unknown as ProjectRow[]
    const hasMore = rows.length > cap
    const page = hasMore ? rows.slice(0, cap) : rows
    const last = page[page.length - 1]
    return {
      items: page,
      next_cursor: hasMore && last !== undefined ? Buffer.from(`${last.updated_at}|${last.project_id}`).toString('base64url') : null,
    }
  }

  // ── project membership (API-01 foundation, reconstruction-contracts §7) ──

  listProjectMembers(projectId: string): Array<{
    project_id: string; principal_id: string; tenant_id: string; role: string; created_at: string; updated_at: string
  }> {
    this.getProject(projectId)
    const rows = this.db.prepare('SELECT * FROM project_members WHERE project_id = ? ORDER BY created_at').all(projectId) as unknown as Array<{
      project_id: string; principal_id: string; tenant_id: string; role: string; created_at: string; updated_at: string
    }>
    return rows
  }

  /** Role lookup used by Human governance adapters. Deleted projects remain
   * addressable only when includeDeleted=true so an idempotent delete replay
   * can still be authenticated without reopening ordinary project reads. */
  getProjectMemberRole(projectId: string, principalId: string, includeDeleted = false): string | null {
    const project = this.db.prepare(
      `SELECT deleted_at FROM projects WHERE project_id = ? ${includeDeleted ? '' : 'AND deleted_at IS NULL'}`,
    ).get(projectId) as { deleted_at: string | null } | undefined
    if (project === undefined) return null
    const member = this.db.prepare('SELECT role FROM project_members WHERE project_id = ? AND principal_id = ?')
      .get(projectId, principalId) as { role: string } | undefined
    return member?.role ?? null
  }

  /** Global configuration administration is derived from current durable
   * project memberships, never from a caller-supplied role header. */
  getGlobalConfigRole(principalId: string): 'pi' | 'operator' | null {
    if (principalId === '') return null
    const row = this.db.prepare(`SELECT pm.role FROM project_members pm
      INNER JOIN projects p ON p.project_id = pm.project_id
      WHERE pm.principal_id = ? AND pm.role IN ('pi', 'operator') AND p.deleted_at IS NULL
      ORDER BY CASE pm.role WHEN 'pi' THEN 0 ELSE 1 END LIMIT 1`)
      .get(principalId) as { role: 'pi' | 'operator' } | undefined
    return row?.role ?? null
  }

  addProjectMember(input: {
    project_id: string
    principal_id: string
    role: 'pi' | 'researcher' | 'operator' | 'auditor' | 'viewer'
    tenant_id?: string
    actor: string
  }): { project_id: string; principal_id: string; tenant_id: string; role: string; created_at: string; updated_at: string } {
    const project = this.getProject(input.project_id)
    // member_manage capability (reconstruction-contracts §7): the acting
    // principal must already be a PI of the project.
    const actorRow = this.db.prepare('SELECT role FROM project_members WHERE project_id = ? AND principal_id = ?')
      .get(input.project_id, input.actor) as { role: string } | undefined
    if (actorRow?.role !== 'pi') {
      throw new KernelError(403, 'member_manage_denied', `only an existing PI can manage members of ${input.project_id}`)
    }
    const now = nowIso()
    const tenant = input.tenant_id ?? ''
    this.db.prepare(`INSERT INTO project_members (project_id, principal_id, tenant_id, role, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(project_id, principal_id) DO UPDATE SET role = excluded.role, tenant_id = excluded.tenant_id, updated_at = excluded.updated_at`)
      .run(input.project_id, input.principal_id, tenant, input.role, now, now)
    this.emit(project.project_id, 'project.membership.updated', { project_id: input.project_id, principal_id: input.principal_id, role: input.role })
    return { project_id: input.project_id, principal_id: input.principal_id, tenant_id: tenant, role: input.role, created_at: now, updated_at: now }
  }

  removeProjectMember(input: { project_id: string; principal_id: string; actor: string }): void {
    this.getProject(input.project_id)
    const actorRow = this.db.prepare('SELECT role FROM project_members WHERE project_id = ? AND principal_id = ?')
      .get(input.project_id, input.actor) as { role: string } | undefined
    if (actorRow?.role !== 'pi') {
      throw new KernelError(403, 'member_manage_denied', `only an existing PI can manage members of ${input.project_id}`)
    }
    const target = this.db.prepare('SELECT role FROM project_members WHERE project_id = ? AND principal_id = ?')
      .get(input.project_id, input.principal_id) as { role: string } | undefined
    if (target === undefined) throw new KernelError(404, 'member_not_found', `member ${input.principal_id} not found in ${input.project_id}`)
    if (target.role === 'pi') {
      const piCount = (this.db.prepare('SELECT COUNT(*) AS n FROM project_members WHERE project_id = ? AND role = ?').get(input.project_id, 'pi') as { n: number }).n
      if (piCount <= 1) {
        throw new KernelError(422, 'last_pi_removal', 'the last PI of a project cannot be removed')
      }
    }
    this.db.prepare('DELETE FROM project_members WHERE project_id = ? AND principal_id = ?').run(input.project_id, input.principal_id)
  }

  getProject(projectId: string): ResearchProject {
    const row = this.db.prepare('SELECT * FROM projects WHERE project_id = ? AND deleted_at IS NULL').get(projectId) as ProjectRow | undefined
    if (row === undefined) throw new KernelError(404, 'project_not_found', `project ${projectId} not found`)
    return projectFromRow(row)
  }

  listProjects(): ResearchProject[] {
    const rows = this.db.prepare('SELECT * FROM projects WHERE deleted_at IS NULL ORDER BY created_at').all() as unknown as ProjectRow[]
    return rows.map(projectFromRow)
  }

  /** State transition with expected_revision CAS (design §5.1, §9.3). */
  transition(projectId: string, to: ProjectStatus, expectedRevision: number, reason = ''): ResearchProject {
    const project = this.getProject(projectId)
    if (project.revision !== expectedRevision) {
      throw new KernelError(409, 'revision_conflict', `expected revision ${expectedRevision}, got ${project.revision}`)
    }
    const allowed = TRANSITION_TABLE[project.status]
    if (!allowed.includes(to)) {
      throw new KernelError(422, 'invalid_transition', `transition ${project.status} -> ${to} not allowed`)
    }
    const now = nowIso()
    this.db.prepare('UPDATE projects SET status = ?, revision = revision + 1, updated_at = ?, history = ? WHERE project_id = ? AND revision = ?')
      .run(to, now, JSON.stringify([...project.history, `${project.status}->${to}${reason ? ` (${reason})` : ''}`]), projectId, expectedRevision)
    const updated = this.getProject(projectId)
    this.emit(projectId, 'project.transitioned', { from: project.status, to, revision: updated.revision, reason })
    return updated
  }

  /** Rename a project (dsh-web session actions); audited in history. */
  renameProject(projectId: string, name: string): ResearchProject {
    const clean = name.trim()
    if (clean === '') throw new KernelError(422, 'invalid_name', 'project name must not be empty')
    if (clean.length > 120) throw new KernelError(422, 'invalid_name', 'project name too long (max 120 chars)')
    const project = this.getProject(projectId)
    const now = nowIso()
    this.db.prepare('UPDATE projects SET name = ?, revision = revision + 1, updated_at = ?, history = ? WHERE project_id = ?')
      .run(clean, now, JSON.stringify([...project.history, `renamed to "${clean}"`]), projectId)
    const updated = this.getProject(projectId)
    this.emit(projectId, 'project.renamed', { from: project.name, to: clean, revision: updated.revision })
    return updated
  }

  /**
   * Archive a project (dsh-web session actions): data is kept, the project
   * leaves the Active group and all further gates/actions are blocked.
   * Reversible via unarchiveProject.
   */
  archiveProject(projectId: string): ResearchProject {
    const project = this.getProject(projectId)
    if (project.status === 'ARCHIVED') return project
    // reconstruction-contracts.md §4: "any non-ARCHIVED → ARCHIVED | PI |
    // no running jobs; otherwise 409" — archiving a project with active
    // (queued/running/retryable) jobs would orphan lease ownership and
    // terminal streams, so it is rejected outright.
    const active = this.db.prepare(
      "SELECT COUNT(*) AS n FROM jobs WHERE project_id = ? AND status IN ('queued', 'running', 'retryable')",
    ).get(projectId) as { n: number }
    if (Number(active.n) > 0) {
      throw new KernelError(409, 'jobs_running',
        `project ${projectId} has ${active.n} active job(s) (queued/running/retryable) — stop or finish them before archiving`)
    }
    const now = nowIso()
    this.db.prepare('UPDATE projects SET status = ?, revision = revision + 1, updated_at = ?, history = ? WHERE project_id = ?')
      .run('ARCHIVED', now, JSON.stringify([...project.history, `${project.status}->ARCHIVED (archived)`]), projectId)
    const updated = this.getProject(projectId)
    this.emit(projectId, 'project.transitioned', { from: project.status, to: 'ARCHIVED', revision: updated.revision, reason: 'archived' })
    return updated
  }

  /** Restore an archived project (back to RELEASE_READY when it was done,
   * otherwise to its pre-archive phase). */
  unarchiveProject(projectId: string): ResearchProject {
    const project = this.getProject(projectId)
    if (project.status !== 'ARCHIVED') return project
    const restored = project.history.at(-1)?.startsWith('RELEASED') === true ? 'RELEASED' as ProjectStatus : 'RELEASE_READY' as ProjectStatus
    const now = nowIso()
    this.db.prepare('UPDATE projects SET status = ?, revision = revision + 1, updated_at = ?, history = ? WHERE project_id = ?')
      .run(restored, now, JSON.stringify([...project.history, 'ARCHIVED->restored']), projectId)
    const updated = this.getProject(projectId)
    this.emit(projectId, 'project.transitioned', { from: 'ARCHIVED', to: restored, revision: updated.revision, reason: 'restored' })
    return updated
  }

  /**
   * PROJECT-DELETE-01: hide an archived project through an auditable
   * tombstone. This deliberately preserves the aggregate, memberships,
   * Outbox, finalized artifacts and shared CAS references for retention/GC
   * safety. Open upload sessions are transient rather than retained research
   * data, so their rows and isolated staging bytes are removed as part of the
   * authoritative delete operation.
   */
  deleteProject(input: {
    project_id: string
    expected_revision: number
    confirm_name: string
    reason: string
    deleted_by: string
    request_id: string
  }): ProjectDeletionReceipt {
    const row = this.db.prepare('SELECT * FROM projects WHERE project_id = ?').get(input.project_id) as ProjectRow | undefined
    if (row === undefined) throw new KernelError(404, 'project_not_found', `project ${input.project_id} not found`)
    if (row.deleted_at !== null) {
      if (row.deletion_request_id === input.request_id && row.deleted_by !== null) {
        return {
          project_id: row.project_id,
          deleted_at: row.deleted_at,
          deleted_by: row.deleted_by,
          revision: row.revision,
          request_id: row.deletion_request_id,
        }
      }
      throw new KernelError(404, 'project_not_found', `project ${input.project_id} not found`)
    }
    if (row.status !== 'ARCHIVED') {
      throw new KernelError(409, 'project_not_archived', `project ${input.project_id} must be archived before deletion`)
    }
    if (row.revision !== input.expected_revision) {
      throw new KernelError(409, 'revision_conflict', `expected revision ${input.expected_revision}, got ${row.revision}`)
    }
    if (input.confirm_name !== row.name) {
      throw new KernelError(422, 'project_delete_confirmation_invalid', 'project deletion confirmation must exactly match the project name')
    }
    const reason = input.reason.trim()
    if (reason === '') {
      throw new KernelError(422, 'project_delete_confirmation_invalid', 'project deletion reason must not be empty')
    }
    if (input.deleted_by.trim() === '' || input.request_id.trim() === '') {
      throw new KernelError(422, 'principal_required', 'project deletion requires deleted_by and request_id')
    }
    const active = this.db.prepare(
      "SELECT COUNT(*) AS n FROM jobs WHERE project_id = ? AND status IN ('queued', 'running', 'retryable')",
    ).get(row.project_id) as { n: number }
    if (Number(active.n) > 0) {
      throw new KernelError(409, 'jobs_running', `project ${row.project_id} still has active jobs`)
    }
    const openUploads = this.db.prepare(
      "SELECT upload_id, intake_id FROM upload_sessions WHERE project_id = ? AND status = 'open'",
    ).all(row.project_id) as unknown as Array<{ upload_id: string; intake_id: string }>
    const deletedAt = nowIso()
    const receipt = withTransaction(this.db, () => {
      this.db.prepare(`DELETE FROM upload_chunks WHERE upload_id IN (
        SELECT upload_id FROM upload_sessions WHERE project_id = ? AND status = 'open'
      )`).run(row.project_id)
      // Keep an aborted row as a durable filesystem-cleanup ledger. A crash
      // or transient unlink failure is recovered by the next upload sweep.
      this.db.prepare("UPDATE upload_sessions SET status = 'aborted', updated_at = ? WHERE project_id = ? AND status = 'open'")
        .run(deletedAt, row.project_id)
      const result = this.db.prepare(`UPDATE projects
        SET deleted_at = ?, deleted_by = ?, deletion_reason = ?, deletion_request_id = ?,
            revision = revision + 1, updated_at = ?, history = ?
        WHERE project_id = ? AND revision = ? AND deleted_at IS NULL`)
        .run(
          deletedAt, input.deleted_by, reason, input.request_id, deletedAt,
          JSON.stringify([...jsonParse(row.history, [] as string[]), `ARCHIVED->tombstoned (${reason})`]),
          row.project_id, input.expected_revision,
        )
      if (Number(result.changes) !== 1) {
        throw new KernelError(409, 'revision_conflict', 'project changed while deletion was being committed')
      }
      const receipt: ProjectDeletionReceipt = {
        project_id: row.project_id,
        deleted_at: deletedAt,
        deleted_by: input.deleted_by,
        revision: input.expected_revision + 1,
        request_id: input.request_id,
      }
      this.emit(row.project_id, 'project.deleted', {
        project_id: row.project_id,
        revision: receipt.revision,
        deleted_at: deletedAt,
        deleted_by: input.deleted_by,
        reason,
        request_id: input.request_id,
      })
      return receipt
    })
    for (const upload of openUploads) {
      if (this.removeUploadStageFile(upload.intake_id, upload.upload_id)) {
        this.db.prepare("DELETE FROM upload_sessions WHERE upload_id = ? AND status = 'aborted'").run(upload.upload_id)
      }
    }
    return receipt
  }

  /** Link a DSH session to a project (design RSP-006). */
  private linkSessionExclusive(sessionId: string, projectId: string, authority: {
    principal_id: string
    tenant_id: string
    issuer: SessionLink['issuer']
  }): SessionLink {
    this.getProject(projectId)
    const existing = this.db.prepare('SELECT project_id FROM session_links WHERE session_id = ?')
      .get(sessionId) as { project_id: string } | undefined
    if (existing !== undefined) {
      throw new KernelError(409, 'session_link_conflict', 'DSH session already has an authoritative link')
    }
    const link: SessionLink = { session_id: sessionId, project_id: projectId, ...authority, linked_at: nowIso() }
    this.db.prepare(`INSERT INTO session_links
      (session_id, project_id, principal_id, tenant_id, issuer, linked_at) VALUES (?, ?, ?, ?, ?, ?)`)
      .run(link.session_id, link.project_id, link.principal_id, link.tenant_id, link.issuer, link.linked_at)
    this.emit(projectId, 'session.linked', { session_id: sessionId })
    return link
  }

  /** Link a DSH session to a project (design RSP-006). */
  linkSession(sessionId: string, projectId: string, authority: {
    principal_id: string
    tenant_id: string
    issuer: SessionLink['issuer']
  }): SessionLink {
    this.getProject(projectId)
    if (!this.listProjectMembers(projectId).some(member => member.principal_id === authority.principal_id && member.tenant_id === authority.tenant_id)) {
      throw new KernelError(404, 'project_not_found', 'project not found or access denied')
    }
    const link: SessionLink = { session_id: sessionId, project_id: projectId, ...authority, linked_at: nowIso() }
    this.db.prepare(`INSERT INTO session_links
      (session_id, project_id, principal_id, tenant_id, issuer, linked_at) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(session_id) DO UPDATE SET project_id = excluded.project_id,
        principal_id = excluded.principal_id, tenant_id = excluded.tenant_id,
        issuer = excluded.issuer, linked_at = excluded.linked_at`)
      .run(link.session_id, link.project_id, link.principal_id, link.tenant_id, link.issuer, link.linked_at)
    this.emit(projectId, 'session.linked', { session_id: sessionId })
    return link
  }

  getProjectBySession(sessionId: string): ResearchProject | null {
    const row = this.db.prepare('SELECT project_id FROM session_links WHERE session_id = ?').get(sessionId) as { project_id: string } | undefined
    if (row === undefined) return null
    try {
      return this.getProject(row.project_id)
    } catch {
      return null
    }
  }

  // ── gates & decisions ────────────────────────────────────────────────────

  createGate(input: {
    project_id: string
    type: GateType
    title: string
    summary?: string
    payload?: Record<string, unknown>
    session_id?: string | null
  }): Gate {
    this.getProject(input.project_id)
    const payload = input.type === 'direction'
      ? DirectionGatePayload.parse(input.payload ?? {})
      : input.payload ?? {}
    const gate: Gate = {
      gate_id: buildGateId(),
      project_id: input.project_id,
      type: input.type,
      title: input.title,
      summary: input.summary ?? '',
      payload,
      status: 'pending',
      dsh_session_id: input.session_id ?? null,
      dsh_event_id: null,
      created_at: nowIso(),
      decided_at: null,
    }
    this.db.prepare(
      'INSERT INTO gates (gate_id, project_id, type, title, summary, payload, status, dsh_session_id, dsh_event_id, created_at, decided_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    ).run(gate.gate_id, gate.project_id, gate.type, gate.title, gate.summary, JSON.stringify(gate.payload), gate.status, gate.dsh_session_id, gate.dsh_event_id, gate.created_at, gate.decided_at)
    this.emit(input.project_id, 'gate.created', { gate_id: gate.gate_id, type: gate.type, title: gate.title })
    return gate
  }

  listGates(projectId: string, status?: Gate['status']): Gate[] {
    const rows = status === undefined
      ? this.db.prepare('SELECT * FROM gates WHERE project_id = ? ORDER BY created_at').all(projectId) as unknown as GateRow[]
      : this.db.prepare('SELECT * FROM gates WHERE project_id = ? AND status = ? ORDER BY created_at').all(projectId, status) as unknown as GateRow[]
    return rows.map(gateFromRow)
  }

  getGate(gateId: string): Gate {
    const row = this.db.prepare('SELECT * FROM gates WHERE gate_id = ?').get(gateId) as GateRow | undefined
    if (row === undefined) throw new KernelError(404, 'gate_not_found', `gate ${gateId} not found`)
    return gateFromRow(row)
  }

  /** A Budget Gate may resume only from the immutable provenance row that
   * the Kernel wrote in the same transaction as that exact budget block. */
  private budgetBlockResumeTo(gate: Gate): ProjectStatus {
    const row = this.db.prepare(
      'SELECT project_id, resume_to, project_revision, payload_sha256, created_at FROM budget_block_provenance WHERE gate_id = ?',
    ).get(gate.gate_id) as {
      project_id: string
      resume_to: string
      project_revision: number
      payload_sha256: string
      created_at: string
    } | undefined
    const project = this.getProject(gate.project_id)
    const exactPayload = Object.keys(gate.payload).length === 1
      && typeof gate.payload.resume_to === 'string'
      && gate.payload.resume_to !== 'BLOCKED_GATE'
    if (row === undefined || row.project_id !== gate.project_id || !exactPayload
      || project.status !== 'BLOCKED_GATE' || project.revision !== row.project_revision
      || gate.created_at !== row.created_at || !ProjectStatusSchema.safeParse(row.resume_to).success
      || row.resume_to !== gate.payload.resume_to
      || row.payload_sha256 !== fullAutoAuthorityHash(gate.payload)) {
      throw new KernelError(409, 'budget_block_provenance_mismatch',
        `Budget Gate ${gate.gate_id} does not match its Kernel-recorded block provenance`)
    }
    return row.resume_to as ProjectStatus
  }

  /**
   * Fixture-only service authority. Verification and the Decision side effect
   * share one SQLite transaction; the orchestrator supplies only opaque ids,
   * a revision fence and an idempotency key.
   */
  decideFullAutoGate(input: {
    project_id: string
    gate_id: string
    expected_project_revision: number
    idempotency_key: string
  }): { gate: Gate; decision: Decision; project: ResearchProject; receipt: FullAutoAuthorityReceipt } {
    if (input.idempotency_key.trim() === '' || input.idempotency_key.length > 240) {
      throw new KernelError(422, 'idempotency_key_required', 'full-auto Gate decision requires a non-empty idempotency key of at most 240 characters')
    }
    const requestSha256 = fullAutoAuthorityHash({
      schema_version: 1,
      operation: 'full-auto-gate-approval',
      project_id: input.project_id,
      gate_id: input.gate_id,
      expected_project_revision: input.expected_project_revision,
    })
    return withTransaction(this.db, () => {
      const ledger = this.db.prepare(`SELECT request_sha256, project_id, gate_id,
        expected_project_revision, decision_id, receipt_json
        FROM full_auto_gate_idempotency WHERE idempotency_key = ?`)
        .get(input.idempotency_key) as {
          request_sha256: string
          project_id: string
          gate_id: string
          expected_project_revision: number
          decision_id: string
          receipt_json: string
      } | undefined
      if (ledger !== undefined) {
        if (ledger.request_sha256 !== requestSha256
          || ledger.project_id !== input.project_id
          || ledger.gate_id !== input.gate_id
          || ledger.expected_project_revision !== input.expected_project_revision) {
          throw new KernelError(409, 'idempotency_conflict', 'full-auto approval idempotency key is globally bound to another request')
        }
        const receipt = FullAutoAuthorityReceiptSchema.parse(JSON.parse(ledger.receipt_json) as unknown)
        const decision = this.listDecisions(ledger.project_id)
          .find(candidate => candidate.decision_id === ledger.decision_id)
        if (decision === undefined
          || decision.gate_id !== ledger.gate_id
          || receipt.project_id !== ledger.project_id
          || receipt.gate_id !== ledger.gate_id
          || receipt.project_revision !== ledger.expected_project_revision
          || receipt.idempotency_key !== input.idempotency_key) {
          throw new KernelError(409, 'full_auto_receipt_invalid', 'full-auto approval ledger has an invalid Decision or receipt binding')
        }
        return {
          gate: this.getGate(ledger.gate_id),
          decision,
          project: this.getProject(ledger.project_id),
          receipt,
        }
      }
      const replayEventId = `full-auto:${input.idempotency_key}`
      const project = this.getProject(input.project_id)
      const gate = this.getGate(input.gate_id)
      if (gate.project_id !== project.project_id) {
        throw new KernelError(404, 'gate_not_found', `gate ${input.gate_id} not found in project ${input.project_id}`)
      }
      const fixture = getFixtureProfile(project.execution.fixture_id ?? '')
      const runnerProfile = project.execution.runner_profile_id === null
        ? null
        : getRunnerProfile(project.execution.runner_profile_id)
      const runnerTarget = this.listRunnerTargets().find(target => target.target_id === project.execution.runner_target_id) ?? null
      const runnerAssessment = runnerProfile === null || runnerTarget === null
        ? { failures: [] as import('./runner-environment-readiness.js').RunnerEnvironmentFailure[] }
        : assessRunnerEnvironment(runnerProfile, runnerTarget, ref => this.secretRefAvailable(ref))
      const ideaId = gate.type === 'idea' && typeof gate.payload.idea_id === 'string' ? gate.payload.idea_id : null
      const idea = ideaId === null ? null : (() => { try { return this.getIdea(ideaId) } catch { return null } })()
      const ideaCorpus = idea?.corpus_snapshot_id === null || idea?.corpus_snapshot_id === undefined
        ? null
        : (() => { try { return this.getCorpusSnapshot(idea.corpus_snapshot_id as string) } catch { return null } })()
      const contractId = gate.type === 'contract' && typeof gate.payload.contract_id === 'string' ? gate.payload.contract_id : null
      const contract = contractId === null ? null : (() => { try { return this.getContract(contractId) } catch { return null } })()
      const evaluation = evaluateFullAutoGateAuthority({
        project,
        gate,
        expected_project_revision: input.expected_project_revision,
        idempotency_key: input.idempotency_key,
        issued_at: nowIso(),
        fixture,
        runner_profile: runnerProfile,
        runner_target: runnerTarget,
        runner_failures: runnerAssessment.failures,
        idea,
        idea_corpus: ideaCorpus,
        contract,
      })
      if (!evaluation.ok) {
        throw new KernelError(evaluation.code === 'revision_conflict' ? 409 : 422, evaluation.code, evaluation.message)
      }
      const decided = this.decideGateInTransaction({
        gate_id: input.gate_id,
        actor: 'service:research-orchestrator',
        principal: {
          principal_id: 'service:research-orchestrator',
          tenant_id: 'fixture',
          auth_method: 'full-auto-service',
          session_id: null,
        },
        decision: 'approved',
        reason: `fixture-only automatic approval (${evaluation.receipt.fixture.fixture_id}); Release remains Human`,
        diff: JSON.stringify(evaluation.receipt),
        event_id: replayEventId,
      })
      this.db.prepare(`INSERT INTO full_auto_gate_idempotency
        (idempotency_key, request_sha256, project_id, gate_id, expected_project_revision,
         decision_id, receipt_json, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(
          input.idempotency_key,
          requestSha256,
          input.project_id,
          input.gate_id,
          input.expected_project_revision,
          decided.decision.decision_id,
          JSON.stringify(evaluation.receipt),
          decided.decision.decided_at,
        )
      return { ...decided, receipt: evaluation.receipt }
    })
  }

  /**
   * Resolve the exact read-only authority context that a connector execution
   * must pin before it starts I/O. The resulting hash covers the Project /
   * NextAction / Brief / fixture / runner / budget / Protocol inputs.
   */
  fullAutoSurveyAuthority(input: {
    project_id: string
    expected_project_revision: number
    action_id: string
    action_revision: number
  }): FullAutoSurveyAuthorityContext {
    const project = this.getProject(input.project_id)
    const projection = this.projectProjection(input.project_id)
    const action = projection.next_actions_v2.find(candidate => candidate.id === input.action_id)
    if (action === undefined) {
      throw new KernelError(409, 'full_auto_action_not_ready', `action ${input.action_id} is not present in the authoritative projection`)
    }
    const fixture = getFixtureProfile(project.execution.fixture_id ?? '')
    const runnerProfile = project.execution.runner_profile_id === null
      ? null
      : getRunnerProfile(project.execution.runner_profile_id)
    const runnerTarget = this.listRunnerTargets().find(target => target.target_id === project.execution.runner_target_id) ?? null
    const runnerAssessment = runnerProfile === null || runnerTarget === null
      ? { failures: [] as import('./runner-environment-readiness.js').RunnerEnvironmentFailure[] }
      : assessRunnerEnvironment(runnerProfile, runnerTarget, ref => this.secretRefAvailable(ref))
    const latestFrozenProtocol = this.methodology.listProtocolRevisions(input.project_id).records
      .map(view => view.record)
      .filter(protocol => protocol.status === 'frozen')
      .sort((left, right) => left.revision - right.revision)
      .at(-1)
    const protocolPin = latestFrozenProtocol === undefined
      ? null
      : {
          protocol_id: latestFrozenProtocol.protocol_id,
          revision: latestFrozenProtocol.revision,
          canonical_hash: latestFrozenProtocol.canonical_hash!,
        }
    const evaluation = evaluateFullAutoSurveyAuthorityContext({
      project,
      action,
      expected_project_revision: input.expected_project_revision,
      action_id: input.action_id,
      action_revision: input.action_revision,
      fixture,
      runner_profile: runnerProfile,
      runner_target: runnerTarget,
      runner_failures: runnerAssessment.failures,
      budget: projection.budget,
      protocol_pin: protocolPin,
    })
    if (!evaluation.ok) {
      const conflict = evaluation.code === 'revision_conflict' || evaluation.code === 'full_auto_action_not_ready'
      throw new KernelError(conflict ? 409 : 422, evaluation.code, evaluation.message)
    }
    return evaluation.context
  }

  /**
   * Execute the only canonical non-Gate full-auto action currently
   * registered. External connector data is untrusted input; this method
   * re-derives every authority pin and atomically freezes the corpus,
   * advances SCOPED -> SURVEYING and embeds a replayable receipt in Outbox.
   */
  executeFullAutoSurvey(input: {
    project_id: string
    expected_project_revision: number
    action_id: string
    action_revision: number
    expected_authority_sha256: string
    idempotency_key: string
    result?: FullAutoSurveyResult
  }): { snapshot: CorpusSnapshot; project: ResearchProject; receipt: FullAutoSurveyAuthorityReceipt } {
    if (input.idempotency_key.trim() === '' || input.idempotency_key.length > 240) {
      throw new KernelError(422, 'idempotency_key_required', 'full-auto survey requires a non-empty idempotency key of at most 240 characters')
    }
    return withTransaction(this.db, () => {
      const priorReceipts = this.listEvents(input.project_id)
        .filter(event => event.kind === 'corpus.snapshotted')
        .map(event => FullAutoSurveyAuthorityReceiptSchema.safeParse(event.payload.full_auto_survey_receipt))
        .filter((parsed): parsed is { success: true; data: FullAutoSurveyAuthorityReceipt } => parsed.success)
        .map(parsed => parsed.data)
      const prior = priorReceipts.find(receipt => receipt.idempotency_key === input.idempotency_key)
      if (prior !== undefined) {
        const parsedResult = input.result === undefined ? null : FullAutoSurveyResultSchema.parse(input.result)
        if (prior.project_id !== input.project_id
          || prior.project_revision !== input.expected_project_revision
          || prior.action.id !== input.action_id
          || prior.action.revision !== input.action_revision
          || prior.authority_sha256 !== input.expected_authority_sha256
          || (parsedResult !== null && prior.result_sha256 !== fullAutoAuthorityHash(parsedResult))) {
          throw new KernelError(409, 'idempotency_conflict', 'full-auto survey idempotency key was replayed with different project, action, revision or connector result pins')
        }
        return {
          snapshot: this.getCorpusSnapshot(prior.snapshot_id),
          project: this.getProject(input.project_id),
          receipt: prior,
        }
      }
      const admitted = this.fullAutoSurveyAuthority(input)
      if (admitted.authority_sha256 !== input.expected_authority_sha256) {
        throw new KernelError(409, 'full_auto_survey_authority_changed',
          'canonical survey authority changed after connector admission; discard the result and re-plan')
      }
      if (input.result === undefined) {
        throw new KernelError(422, 'full_auto_survey_result_required', 'connector result is required before a new canonical survey can commit')
      }

      const project = this.getProject(input.project_id)
      const projection = this.projectProjection(input.project_id)
      const action = projection.next_actions_v2.find(candidate => candidate.id === input.action_id)
      if (action === undefined) {
        throw new KernelError(409, 'full_auto_action_not_ready', `action ${input.action_id} is not present in the authoritative projection`)
      }
      const fixture = getFixtureProfile(project.execution.fixture_id ?? '')
      const runnerProfile = project.execution.runner_profile_id === null
        ? null
        : getRunnerProfile(project.execution.runner_profile_id)
      const runnerTarget = this.listRunnerTargets().find(target => target.target_id === project.execution.runner_target_id) ?? null
      const runnerAssessment = runnerProfile === null || runnerTarget === null
        ? { failures: [] as import('./runner-environment-readiness.js').RunnerEnvironmentFailure[] }
        : assessRunnerEnvironment(runnerProfile, runnerTarget, ref => this.secretRefAvailable(ref))
      const latestFrozenProtocol = this.methodology.listProtocolRevisions(input.project_id).records
        .map(view => view.record)
        .filter(protocol => protocol.status === 'frozen')
        .sort((left, right) => left.revision - right.revision)
        .at(-1)
      const protocolPin = latestFrozenProtocol === undefined
        ? null
        : {
            protocol_id: latestFrozenProtocol.protocol_id,
            revision: latestFrozenProtocol.revision,
            canonical_hash: latestFrozenProtocol.canonical_hash!,
          }
      const result = FullAutoSurveyResultSchema.parse(input.result)
      const evaluation = evaluateFullAutoSurveyAuthority({
        project,
        action,
        expected_project_revision: input.expected_project_revision,
        action_id: input.action_id,
        action_revision: input.action_revision,
        expected_authority_sha256: input.expected_authority_sha256,
        idempotency_key: input.idempotency_key,
        issued_at: nowIso(),
        fixture,
        runner_profile: runnerProfile,
        runner_target: runnerTarget,
        runner_failures: runnerAssessment.failures,
        budget: projection.budget,
        protocol_pin: protocolPin,
        result,
      })
      if (!evaluation.ok) {
        const conflict = evaluation.code === 'revision_conflict' || evaluation.code === 'full_auto_action_not_ready'
          || evaluation.code === 'full_auto_survey_authority_changed'
        throw new KernelError(conflict ? 409 : 422, evaluation.code, evaluation.message)
      }
      const snapshot = this.snapshotCorpus({
        project_id: input.project_id,
        expected_revision: input.expected_project_revision,
        queries: result.queries,
        papers: result.papers,
        passages: result.passages,
        citation_edges: result.citation_edges,
        source_status: result.source_status,
      }, evaluation.receipt)
      const receipt = FullAutoSurveyAuthorityReceiptSchema.parse({ ...evaluation.receipt, snapshot_id: snapshot.snapshot_id })
      return { snapshot, project: this.getProject(input.project_id), receipt }
    })
  }

  /** Record a Human decision and apply the gate side effect (v2 §6.5, §6.6). */
  decideGate(input: GateDecisionInput): { gate: Gate; decision: Decision; project: ResearchProject } {
    return withTransaction(this.db, () => this.decideGateInTransaction(input))
  }

  private decideGateInTransaction(input: GateDecisionInput): { gate: Gate; decision: Decision; project: ResearchProject } {
    const gate = this.getGate(input.gate_id)
    if (gate.status !== 'pending') {
      throw new KernelError(409, 'gate_already_decided', `gate ${input.gate_id} already ${gate.status}`)
    }
    const budgetResumeTo = input.decision === 'approved' && gate.type === 'budget'
      ? this.budgetBlockResumeTo(gate)
      : null
      const decision: Decision = {
        decision_id: randomId('dec'),
        gate_id: gate.gate_id,
        project_id: gate.project_id,
        gate_type: gate.type,
        actor: input.actor,
        // v2 §6.4: authenticated principal record; missing principal is only
        // tolerated for legacy rows (actor == 'legacy_unverified').
        principal: input.principal === undefined && input.actor === 'legacy_unverified'
          ? undefined
          : {
              principal_id: input.principal?.principal_id ?? input.actor,
              tenant_id: input.principal?.tenant_id ?? '',
              auth_method: input.principal?.auth_method ?? 'unverified',
              session_id: input.principal?.session_id ?? input.session_id ?? null,
            },
        decision: input.decision,
        reason: input.reason ?? '',
        diff: input.diff ?? '',
        session_id: input.session_id ?? null,
        event_id: input.event_id ?? null,
        decided_at: nowIso(),
      }
      this.db.prepare(
        'INSERT INTO decisions (decision_id, gate_id, project_id, gate_type, actor, decision, reason, diff, session_id, event_id, decided_at, principal_id, principal_tenant_id, principal_auth_method, principal_session_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      ).run(
        decision.decision_id, decision.gate_id, decision.project_id, decision.gate_type, decision.actor,
        decision.decision, decision.reason, decision.diff, decision.session_id, decision.event_id, decision.decided_at,
        decision.principal?.principal_id ?? null,
        decision.principal?.tenant_id ?? null,
        decision.principal?.auth_method ?? null,
        decision.principal?.session_id ?? null,
      )
      const gateUpdate = this.db.prepare('UPDATE gates SET status = ?, decided_at = ? WHERE gate_id = ? AND status = ?')
        .run(input.decision, decision.decided_at, gate.gate_id, 'pending')
      if (Number(gateUpdate.changes) !== 1) {
        // Lost the CAS race to a concurrent decision (design §11.2).
        throw new KernelError(409, 'gate_already_decided', `gate ${input.gate_id} was decided concurrently (CAS race)`)
      }
      let project = this.getProject(gate.project_id)
      if (input.decision === 'approved') {
        const mapping = GATE_APPROVAL_TRANSITION[gate.type]
        if (gate.type === 'direction') {
          // Semantic-only Gate: strict payload validation is repeated on the
          // durable value before accepting its approval receipt.
          DirectionGatePayload.parse(gate.payload)
        } else if (gate.type === 'budget') {
          // The gate payload is only a projection. The target authority is
          // the gate-specific provenance row recorded with the budget block.
          if (project.status === 'BLOCKED_GATE' && budgetResumeTo !== null) {
            project = this.forceTransition(project.project_id, budgetResumeTo, `budget gate ${gate.gate_id} approved`)
          }
        } else if (gate.type === 'contract') {
          // GOV-02: freeze the target contract ATOMICALLY with the decision
          // (design §6.6: contracts become immutable on Contract Gate
          // approval) — inside the same transaction as the decision row.
          // P0 (GOV-02/RUN-01a): the gate payload must reference a contract
          // of the GATE's OWN project — a cross-project Contract is rejected
          // 422 `contract_foreign` (the approval still updates by contract_id,
          // but only after the ownership check inside the same transaction).
          const contractId = typeof gate.payload.contract_id === 'string' ? gate.payload.contract_id : undefined
          if (contractId !== undefined) {
            let contract: ExperimentContract | undefined
            try {
              contract = this.getContract(contractId)
            } catch {
              throw new KernelError(422, 'contract_unknown', `contract ${contractId} referenced by contract gate ${gate.gate_id} not found`)
            }
            if (contract.project_id !== gate.project_id) {
              throw new KernelError(422, 'contract_foreign',
                `contract ${contractId} belongs to project ${contract.project_id}, not gate project ${gate.project_id} (cross-project Contract freeze is rejected)`)
            }
            this.approveContract(contractId, decision.decision_id, input.actor)
          }
          if (project.status === mapping.from) {
            project = this.gateTransition(project.project_id, mapping.to, mapping.from, gate.gate_id, `${gate.type} gate approved`)
          } else if (project.status !== mapping.to) {
            throw new KernelError(422, 'gate_state_mismatch', `gate ${gate.gate_id} (${gate.type}) cannot approve from ${project.status}`)
          }
        } else if (gate.type === 'idea') {
          // v2 shape (domain-model.md §6): an Idea must be bound to a frozen
          // Corpus snapshot of the SAME project before its Gate can approve.
          // The binding is read from the CARD (payload.idea_id), not from the
          // gate payload, so legacy cards (no corpus_snapshot_id) and
          // payload-less idea gates pass through unchanged (old-read
          // compatible). When the card DOES carry a snapshot id the snapshot
          // must exist (422 idea_corpus_unknown) and belong to the gate's
          // project (422 idea_corpus_foreign, cross-project never approved).
          const ideaId = typeof gate.payload.idea_id === 'string' ? gate.payload.idea_id : undefined
          if (ideaId !== undefined) {
            let card: IdeaCard | undefined
            try {
              card = this.getIdea(ideaId)
            } catch {
              card = undefined
            }
            const corpusSnapshotId = card?.corpus_snapshot_id ?? null
            if (corpusSnapshotId !== null && corpusSnapshotId !== '') {
              let snapshot: CorpusSnapshot
              try {
                snapshot = this.getCorpusSnapshot(corpusSnapshotId)
              } catch {
                throw new KernelError(422, 'idea_corpus_unknown',
                  `idea ${ideaId} references corpus snapshot ${corpusSnapshotId} which does not exist — an Idea Gate cannot approve against an unfrozen corpus (domain-model.md §6)`)
              }
              if (snapshot.project_id !== gate.project_id) {
                throw new KernelError(422, 'idea_corpus_foreign',
                  `idea ${ideaId} references corpus snapshot ${corpusSnapshotId} of project ${snapshot.project_id}, not gate project ${gate.project_id} (cross-project corpus binding is rejected)`)
              }
            }
            if (card !== undefined) this.approveIdea(card.idea_id)
          }
          if (project.status === mapping.from) {
            project = this.gateTransition(project.project_id, mapping.to, mapping.from, gate.gate_id, `${gate.type} gate approved`)
          } else if (project.status !== mapping.to) {
            throw new KernelError(422, 'gate_state_mismatch', `gate ${gate.gate_id} (${gate.type}) cannot approve from ${project.status}`)
          }
        } else if (project.status === mapping.from) {
          project = this.gateTransition(project.project_id, mapping.to, mapping.from, gate.gate_id, `${gate.type} gate approved`)
        } else if (project.status === mapping.to) {
          // Already in target state (idempotent replay) — no-op.
        } else {
          throw new KernelError(422, 'gate_state_mismatch', `gate ${gate.gate_id} (${gate.type}) cannot approve from ${project.status}`)
        }
      } else if (input.decision === 'rejected' && gate.type === 'scope') {
        project = this.forceTransition(project.project_id, 'FAILED', `scope gate ${gate.gate_id} rejected`)
      }
      this.emit(gate.project_id, 'gate.decided', {
        gate_id: gate.gate_id, type: gate.type, decision: input.decision, actor: input.actor,
        auth_method: decision.principal?.auth_method ?? 'legacy_unverified', decision_id: decision.decision_id,
      })
      return { gate: this.getGate(gate.gate_id), decision, project }
  }

  listDecisions(projectId: string): Decision[] {
    const rows = this.db.prepare('SELECT * FROM decisions WHERE project_id = ? ORDER BY decided_at').all(projectId) as unknown as Array<Record<string, unknown>>
    return rows.map(row => {
      const principalId = row.principal_id as string | null
      const decision: Decision = {
        decision_id: row.decision_id as string,
        gate_id: row.gate_id as string,
        project_id: row.project_id as string,
        gate_type: row.gate_type as GateType,
        actor: row.actor as string,
        // hardening GOV-01: the durable principal is reconstructed from the
        // stored columns; legacy rows (NULL) surface as legacy_unverified.
        principal: principalId !== null && principalId !== ''
          ? {
              principal_id: principalId,
              tenant_id: (row.principal_tenant_id as string | null) ?? '',
              auth_method: (row.principal_auth_method as string | null) ?? 'unverified',
              session_id: (row.principal_session_id as string | null) ?? null,
            }
          : undefined,
        decision: row.decision as Decision['decision'],
        reason: row.reason as string,
        diff: row.diff as string,
        session_id: row.session_id as string | null,
        event_id: row.event_id as string | null,
        decided_at: row.decided_at as string,
      }
      return decision
    })
  }

  /** Gate-transaction transition: the ONLY path into gate-controlled states
   * (v2 §6.2). Bypasses the generic TRANSITION_TABLE (which excludes those
   * states) but still performs revision CAS and appends history. */
  private gateTransition(projectId: string, to: ProjectStatus, from: ProjectStatus, gateId: string, reason: string): ResearchProject {
    const project = this.getProject(projectId)
    if (project.status !== from) {
      throw new KernelError(422, 'gate_state_mismatch', `gate ${gateId} cannot transition from ${project.status} (expected ${from})`)
    }
    // Bypasses the generic TRANSITION_TABLE on purpose (§6.2): the gate
    // transaction is the ONLY authorized path into gate-controlled states.
    const now = nowIso()
    const result = this.db.prepare(
      'UPDATE projects SET status = ?, revision = revision + 1, updated_at = ?, history = ? WHERE project_id = ? AND revision = ?',
    ).run(to, now, JSON.stringify([...project.history, `${from}->${to} (${reason}; gate ${gateId})`]), projectId, project.revision)
    if (Number(result.changes) !== 1) {
      throw new KernelError(409, 'revision_conflict', `gate transition lost CAS race on project ${projectId}`)
    }
    const updated = this.getProject(projectId)
    this.emit(projectId, 'project.transitioned', { from, to, revision: updated.revision, reason, via: 'gate' })
    return updated
  }

  /** Internal: transition without CAS check (gate side effects, budget resume). */
  private forceTransition(projectId: string, to: ProjectStatus, reason: string): ResearchProject {
    const project = this.getProject(projectId)
    const allowed = TRANSITION_TABLE[project.status]
    if (!allowed.includes(to)) {
      throw new KernelError(422, 'invalid_transition', `transition ${project.status} -> ${to} not allowed (${reason})`)
    }
    return this.transition(projectId, to, project.revision, reason)
  }

  // ── budget & policy (design §4.2, §5.2 Budget Gate) ──────────────────────

  getBudget(projectId: string): BudgetRecord {
    const row = this.db.prepare('SELECT * FROM budget WHERE project_id = ?').get(projectId) as BudgetRecord | undefined
    return row ?? { project_id: projectId, model_cost_usd: 0, gpu_hours: 0, api_requests: 0, storage_bytes: 0, updated_at: nowIso() }
  }

  recordUsage(projectId: string, usage: { model_cost_usd?: number; gpu_hours?: number; api_requests?: number; storage_bytes?: number }): BudgetRecord {
    // v2 §7.6: budget increment + limit check + block state + outbox in ONE transaction.
    return withTransaction(this.db, () => {
      const project = this.getProject(projectId)
      const current = this.getBudget(projectId)
      // v2 shape (domain-model.md §16): storage_bytes increments atomically
      // with the other counters; legacy ledger rows (column added by
      // migration 0016) read back 0.
      const next: BudgetRecord = {
        project_id: projectId,
        model_cost_usd: current.model_cost_usd + (usage.model_cost_usd ?? 0),
        gpu_hours: current.gpu_hours + (usage.gpu_hours ?? 0),
        api_requests: current.api_requests + (usage.api_requests ?? 0),
        storage_bytes: current.storage_bytes + (usage.storage_bytes ?? 0),
        updated_at: nowIso(),
      }
      this.db.prepare(
        'INSERT INTO budget (project_id, model_cost_usd, gpu_hours, api_requests, storage_bytes, updated_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(project_id) DO UPDATE SET model_cost_usd = excluded.model_cost_usd, gpu_hours = excluded.gpu_hours, api_requests = excluded.api_requests, storage_bytes = excluded.storage_bytes, updated_at = excluded.updated_at',
      ).run(projectId, next.model_cost_usd, next.gpu_hours, next.api_requests, next.storage_bytes, next.updated_at)
      this.emit(projectId, 'budget.updated', { model_cost_usd: next.model_cost_usd, gpu_hours: next.gpu_hours, storage_bytes: next.storage_bytes })
      // Hard limit check: crossing a limit stops the project into BLOCKED_GATE.
      if (project.status !== 'BLOCKED_GATE' && project.status !== 'FAILED' && project.status !== 'STOPPED') {
        const exceeded: string[] = []
        if (next.model_cost_usd > project.constraints.max_model_cost_usd) exceeded.push(`model cost $${next.model_cost_usd} > $${project.constraints.max_model_cost_usd}`)
        if (next.gpu_hours > project.constraints.max_gpu_hours) exceeded.push(`gpu hours ${next.gpu_hours} > ${project.constraints.max_gpu_hours}`)
        if (exceeded.length > 0) {
          this.emit(projectId, 'policy.violation', { reasons: exceeded })
          // Budget Gate declares the ONLY allowed resume target: the status
          // the project was in before the block (acceptance-tests.md §2
          // budget-gate-resume — never client-supplied).
          const resumeTo = project.status
          const gateId = buildGateId()
          const payload = { resume_to: resumeTo }
          const createdAt = nowIso()
          this.db.prepare(
            `INSERT INTO gates (gate_id, project_id, type, title, summary, payload, status, dsh_session_id, dsh_event_id, created_at, decided_at)
             VALUES (?, ?, 'budget', ?, '', ?, 'pending', NULL, NULL, ?, NULL)`,
          ).run(gateId, projectId, 'Budget Gate', JSON.stringify(payload), createdAt)
          this.db.prepare(
            `INSERT INTO budget_block_provenance
              (gate_id, project_id, resume_to, project_revision, payload_sha256, created_at)
             VALUES (?, ?, ?, ?, ?, ?)`,
          ).run(gateId, projectId, resumeTo, project.revision, fullAutoAuthorityHash(payload), createdAt)
          this.db.prepare('UPDATE projects SET status = ?, updated_at = ?, history = ? WHERE project_id = ?')
            .run('BLOCKED_GATE', nowIso(), JSON.stringify([...project.history, `BLOCKED_GATE (budget: ${exceeded.join('; ')}; resume allowed to ${resumeTo})`]), projectId)
        }
      }
      // OBS-01: budget accounting — one counter per recordUsage + the model
      // cost delta histogram (fixed keys; no project ids in tags).
      this.metrics.count('budget.recorded')
      this.metrics.observe('budget.model_cost_usd', usage.model_cost_usd ?? 0)
      return this.getBudget(projectId)
    })
  }

  // ── CAS integrity & GC (acceptance-tests.md §3) ─────────────────────────

  /**
   * Remove blobs that are not referenced by ANY artifact record (orphan GC,
   * storage-migrations.md §6). A grace period protects blobs written but not
   * yet committed to a transaction (stage/finalize pattern). Returns the
   * number of removed blobs.
   */
  collectOrphanBlobs(graceMs = 0): number {
    const referenced = new Set(
      (this.db.prepare('SELECT sha256 FROM artifacts').all() as Array<{ sha256: string }>).map(r => r.sha256),
    )
    const now = Date.now()
    let removed = 0
    for (const sha of this.cas.list()) {
      if (referenced.has(sha)) continue
      const mtime = this.cas.mtimeMs(sha)
      if (mtime === null || now - mtime < graceMs) continue
      if (this.cas.remove(sha)) removed++
    }
    // OBS-01: CAS orphan GC counter accumulates removed blobs.
    if (removed > 0) this.metrics.count('cas.orphans_removed', undefined, removed)
    return removed
  }

  /**
   * Integrity scan: artifacts whose blob is missing from the CAS (or empty).
   * Returns per-project counts + the offending artifact ids. Used by the
   * recovery flow after restore (storage-migrations.md §10).
   */
  scanMissingBlobs(): { project_id: string; artifact_id: string; sha256: string }[] {
    const rows = this.db.prepare('SELECT artifact_id, project_id, sha256 FROM artifacts').all() as unknown as Array<{
      artifact_id: string; project_id: string; sha256: string
    }>
    return rows.filter(r => !this.cas.has(r.sha256))
  }

  /**
   * STORAGE-07 (storage-migrations.md §10): post-restore integrity scan over
   * the artifacts table vs the CAS. Reports:
   *
   *  - missing_blobs — artifact records whose blob is absent/empty (same
   *    check as scanMissingBlobs);
   *  - orphan_blobs — CAS blobs referenced by NO artifact record (the
   *    collectOrphanBlobs candidate set, without deleting);
   *  - size_mismatch — existing blob whose on-disk size differs from the
   *    recorded artifacts.size_bytes;
   *  - hash_mismatch — existing blob whose content re-hashes to a different
   *    sha256 than the recorded one (tampered/corrupted bytes).
   *
   * Blob re-hashing reads every referenced blob; on very large CAS stores
   * pass `limit` to cap how many blobs are verified (missing/orphan
   * detection is stat-only and always complete; the remainder is reported
   * in `skipped_blobs`).
   */
  scanIntegrity(opts: { limit?: number } = {}): IntegrityScanReport {
    const rows = this.db.prepare('SELECT artifact_id, project_id, sha256, size_bytes FROM artifacts').all() as unknown as Array<{
      artifact_id: string; project_id: string; sha256: string; size_bytes: number
    }>
    const referenced = new Set(rows.map(r => r.sha256))
    const missing_blobs = rows
      .filter(r => !this.cas.has(r.sha256))
      .map(r => ({ project_id: r.project_id, artifact_id: r.artifact_id, sha256: r.sha256 }))
    const orphan_blobs = this.cas.list().filter(sha => !referenced.has(sha))
    const size_mismatch: IntegrityScanReport['size_mismatch'] = []
    const hash_mismatch: IntegrityScanReport['hash_mismatch'] = []
    let scanned = 0
    for (const r of rows) {
      if (!this.cas.has(r.sha256)) continue
      if (opts.limit !== undefined && scanned >= opts.limit) break
      scanned += 1
      const path = this.cas.pathFor(r.sha256)
      let bytes: Buffer
      try {
        const st = statSync(path)
        if (st.size !== r.size_bytes) {
          size_mismatch.push({
            project_id: r.project_id, artifact_id: r.artifact_id, sha256: r.sha256,
            recorded_size: r.size_bytes, actual_size: st.size,
          })
        }
        bytes = readFileSync(path)
      } catch {
        continue // blob vanished between has() and read — reported as missing on the next scan
      }
      if (createHash('sha256').update(bytes).digest('hex') !== r.sha256) {
        hash_mismatch.push({
          project_id: r.project_id, artifact_id: r.artifact_id, sha256: r.sha256,
          recorded_size: r.size_bytes, actual_size: bytes.byteLength,
        })
      }
    }
    return {
      missing_blobs,
      orphan_blobs,
      size_mismatch,
      hash_mismatch,
      scanned_blobs: scanned,
      skipped_blobs: Math.max(0, rows.length - scanned),
      total_blobs: this.cas.list().length,
    }
  }

  // ── identity (api-contracts.md §3 /v2/health) ────────────────────────────

  schemaVersion(): number {
    const row = this.db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as { value?: string } | undefined
    return row !== undefined ? Number(row.value) : 0
  }

  databaseId(): string {
    const row = this.db.prepare("SELECT value FROM meta WHERE key = 'database_id'").get() as { value?: string } | undefined
    return row?.value ?? ''
  }

  // ── artifacts (CAS) ──────────────────────────────────────────────────────

  /** Shared artifact-row insert + outbox event (single writer: SQLite). */
  private persistArtifact(record: ArtifactRecord): void {
    this.db.prepare('INSERT INTO artifacts (artifact_id, project_id, kind, size_bytes, sha256, metadata, media_type, file_name, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(record.artifact_id, record.project_id, record.kind, record.size_bytes, record.sha256, JSON.stringify(record.metadata), record.media_type, record.file_name, record.created_at)
    this.emit(record.project_id, 'artifact.registered', { artifact_id: record.artifact_id, kind: record.kind, size_bytes: record.size_bytes })
  }

  registerArtifact(input: {
    project_id: string
    kind: ArtifactKind
    content: Uint8Array | string
    metadata?: Record<string, unknown>
    /** RFC 2046 media type (ART-02); pdf artifacts should pass application/pdf. */
    media_type?: string
    /** Download file name for Content-Disposition. */
    file_name?: string
  }): ArtifactRecord {
    this.getProject(input.project_id)
    if (input.file_name !== undefined) validateUploadFileName(input.file_name)
    if (input.media_type !== undefined && (
      Buffer.byteLength(input.media_type, 'utf8') > 256 ||
      /[\u0000-\u001f\u007f]/.test(input.media_type) ||
      !/^[^\s/;]+\/[^\s/;]+(?:\s*;[\x20-\x7e]*)?$/.test(input.media_type)
    )) {
      throw new KernelError(422, 'validation_error', 'artifact media_type must be a valid RFC 2046 value')
    }
    const { sha256, size_bytes } = this.cas.put(input.content)
    const artifactId = `sha256:${sha256}`
    // v2 §7.4: blobs are global (CAS), artifact records are project-scoped —
    // the same blob in another project yields that project's OWN record.
    const existing = this.db.prepare('SELECT * FROM artifacts WHERE project_id = ? AND artifact_id = ?')
      .get(input.project_id, artifactId) as ArtifactRecord | undefined
    if (existing !== undefined) return existing
    const mediaType = input.media_type !== undefined && input.media_type !== ''
      ? input.media_type
      : (input.kind === 'pdf' ? 'application/pdf' : 'application/octet-stream')
    const record: ArtifactRecord = {
      artifact_id: artifactId,
      project_id: input.project_id,
      kind: input.kind,
      size_bytes,
      sha256,
      metadata: input.metadata ?? {},
      media_type: mediaType,
      file_name: input.file_name ?? null,
      created_at: nowIso(),
    }
    this.persistArtifact(record)
    return record
  }

  // ── staged uploads (UPLOAD-01, api-contracts.md §7) ─────────────────────

  /** Absolute path of a staged part/metadata file for `stageId`. */
  stagedPartPath(stageId: string): string {
    return join(this.stagedUploadsRoot, `stage_${stageId}.part`)
  }

  stagedMetaPath(stageId: string): string {
    return join(this.stagedUploadsRoot, `stage_${stageId}.json`)
  }

  /**
   * UPLOAD-01 phase 1 (stage): write the received bytes to a session-id'd
   * temporary file under the CAS root together with a metadata sidecar.
   * Nothing is registered yet — the artifact only becomes visible at
   * finalizeStagedUpload, so a crash between the two leaves only a staged
   * file (recoverable: re-upload or cleanupStagedUploads), never a partial
   * artifact row. Validation (project existence, kind, file name, size cap)
   * runs here — before anything touches disk beyond the staging area.
   */
  stageUploadContent(input: {
    project_id: string
    kind: ArtifactKind
    file_name: string
    media_type?: string
    content: Uint8Array | string
  }): { stage_id: string } {
    this.getProject(input.project_id)
    const kindCheck = ArtifactKind.safeParse(input.kind)
    if (!kindCheck.success) {
      throw new KernelError(422, 'invalid_kind', `upload kind must be one of ${ArtifactKind.options.join('/')}`)
    }
    validateUploadFileName(input.file_name)
    const bytes = typeof input.content === 'string' ? Buffer.from(input.content, 'utf8') : Buffer.from(input.content)
    if (bytes.byteLength > ResearchKernel.UPLOAD_MAX_FILE_BYTES) {
      throw new KernelError(413, 'payload_too_large',
        `upload exceeds the size limit: ${bytes.byteLength} bytes (max_file_bytes=${ResearchKernel.UPLOAD_MAX_FILE_BYTES})`)
    }
    const sha256 = createHash('sha256').update(bytes).digest('hex')
    const stageId = randomUUID().replaceAll('-', '')
    const partPath = this.stagedPartPath(stageId)
    const metaPath = this.stagedMetaPath(stageId)
    try {
      // mkdirMode is a no-op once the staging root exists (constructor);
      // the explicit 0700 calibration keeps the private staging contract
      // independent of the process umask.
      mkdirMode(this.stagedUploadsRoot, 0o700)
      writeFileSync(partPath, bytes, { mode: 0o600 })
      chmodSync(partPath, 0o600)
      writeFileSync(metaPath, JSON.stringify({
        schema_version: 1,
        stage_id: stageId,
        project_id: input.project_id,
        kind: kindCheck.data,
        file_name: input.file_name,
        media_type: input.media_type ?? '',
        sha256,
        size_bytes: bytes.byteLength,
        created_at: nowIso(),
      }), { mode: 0o600 })
      chmodSync(metaPath, 0o600)
    } catch (error) {
      // Rollback: never leave a half-written stage behind.
      try { unlinkSync(partPath) } catch { /* absent */ }
      try { unlinkSync(metaPath) } catch { /* absent */ }
      throw new KernelError(500, 'stage_write_failed', `staged upload write failed: ${(error as Error).message}`)
    }
    return { stage_id: stageId }
  }

  /**
   * UPLOAD-01 phase 2 (finalize): atomically promote a staged upload to a
   * registered artifact. The staged bytes are re-hashed and re-measured
   * (the recorded sha256 is server-computed at stage time; a mismatch means
   * the staged file was tampered with → 422 stage_corrupted), then the part
   * file is renamed into the CAS blob slot (atomic on POSIX; concurrent
   * writers with identical content keep the existing blob) and the artifact
   * row is inserted in the same write path as registerArtifact. Idempotent:
   * an existing artifact for the same project + sha256 + file_name is
   * returned unchanged (reused: true) and the staged files are dropped.
   * Any failure removes the staged files before rethrowing (rollback).
   */
  finalizeStagedUpload(stageId: string): { record: ArtifactRecord; reused: boolean } {
    const partPath = this.stagedPartPath(stageId)
    const metaPath = this.stagedMetaPath(stageId)
    let meta: {
      project_id: string
      kind: ArtifactKind
      file_name: string
      media_type?: string
      sha256: string
      size_bytes: number
    }
    try {
      meta = JSON.parse(readFileSync(metaPath, 'utf8')) as typeof meta
    } catch {
      // Absent/expired stage: stable code from the internal-stage contract
      // (api-contracts.md §2 artifact_stage_expired).
      throw new KernelError(409, 'artifact_stage_expired', `upload stage ${stageId} not found or expired`)
    }
    const rollback = (): void => {
      try { unlinkSync(partPath) } catch { /* absent */ }
      try { unlinkSync(metaPath) } catch { /* absent */ }
    }
    if (typeof meta.project_id !== 'string' || typeof meta.kind !== 'string' || typeof meta.file_name !== 'string' || typeof meta.sha256 !== 'string') {
      throw new KernelError(422, 'stage_corrupted', `upload stage ${stageId} metadata is malformed`)
    }
    if (!ArtifactKind.safeParse(meta.kind).success) {
      rollback()
      throw new KernelError(422, 'stage_corrupted', `upload stage ${stageId} metadata carries an invalid kind`)
    }
    try {
      // Re-hash the staged bytes: the artifact hash is bound to the CONTENT
      // actually promoted, never to a client claim or a stale record.
      const staged = readFileSync(partPath)
      const actualSha = createHash('sha256').update(staged).digest('hex')
      if (actualSha !== meta.sha256 || staged.byteLength !== meta.size_bytes) {
        rollback()
        throw new KernelError(422, 'stage_corrupted',
          `upload stage ${stageId} content hash mismatch (recorded ${meta.sha256}, got ${actualSha})`)
      }
      if (staged.byteLength > ResearchKernel.UPLOAD_MAX_FILE_BYTES) {
        rollback()
        throw new KernelError(413, 'payload_too_large',
          `upload exceeds the size limit: ${staged.byteLength} bytes (max_file_bytes=${ResearchKernel.UPLOAD_MAX_FILE_BYTES})`)
      }
      this.getProject(meta.project_id)
      // Idempotency (UPLOAD-01): same project + sha256 + file_name re-upload
      // returns the ORIGINAL artifact without writing anything new.
      const artifactId = `sha256:${meta.sha256}`
      const existing = this.db.prepare('SELECT * FROM artifacts WHERE project_id = ? AND artifact_id = ?')
        .get(meta.project_id, artifactId) as ArtifactRecord | undefined
      if (existing !== undefined) {
        rollback()
        return { record: existing, reused: true }
      }
      // Atomic promotion: rename the staged part into the CAS blob slot
      // (POSIX rename is atomic; a concurrent identical writer keeps the
      // existing blob — same semantics as ArtifactCas.put).
      const target = this.cas.pathFor(meta.sha256)
      try {
        renameSync(partPath, target)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
        try { unlinkSync(partPath) } catch { /* absent */ }
      }
      const mediaType = meta.media_type !== undefined && meta.media_type !== ''
        ? meta.media_type
        : (meta.kind === 'pdf' ? 'application/pdf' : 'application/octet-stream')
      const record: ArtifactRecord = {
        artifact_id: artifactId,
        project_id: meta.project_id,
        kind: meta.kind,
        size_bytes: meta.size_bytes,
        sha256: meta.sha256,
        metadata: {},
        media_type: mediaType,
        file_name: meta.file_name,
        created_at: nowIso(),
      }
      this.persistArtifact(record)
      try { unlinkSync(metaPath) } catch { /* absent */ }
      return { record, reused: false }
    } catch (error) {
      rollback()
      throw error
    }
  }

  /**
   * UPLOAD-01 recovery/GC: remove staged uploads older than `maxAgeMs`
   * (grace-period model, mirroring collectOrphanBlobs). Both the `.part`
   * and the `.json` sidecar of an aged stage are removed; orphaned sidecars
   * of already-finalized stages are collected as well. Returns the number
   * of files removed. A finalized upload's blob lives in CAS and is never
   * touched here (accepted blobs are not intake GC targets).
   */
  cleanupStagedUploads(maxAgeMs: number = ResearchKernel.STAGED_UPLOAD_TTL_MS): number {
    let entries: string[]
    try {
      entries = readdirSync(this.stagedUploadsRoot)
    } catch {
      return 0
    }
    const now = Date.now()
    let removed = 0
    for (const entry of entries) {
      if (!entry.startsWith('stage_') || !(entry.endsWith('.part') || entry.endsWith('.json'))) continue
      const full = join(this.stagedUploadsRoot, entry)
      let mtime: number
      try {
        mtime = statSync(full).mtimeMs
      } catch {
        continue // raced with another cleanup — skip
      }
      // A zero grace period is an explicit collect-now operation. Some file
      // systems expose sub-millisecond mtimes while Date.now() is integral,
      // so a freshly written file can otherwise appear fractionally newer
      // than `now` and make this recovery path nondeterministic.
      if (maxAgeMs === 0 || now - mtime >= maxAgeMs) {
        try {
          unlinkSync(full)
          removed += 1
        } catch { /* raced — another collector won */ }
      }
    }
    return removed
  }

  // ── Research Intake (ONBOARD-01, research-onboarding.md) ────────────────
  //
  // Pre-accept zero authority (§2.1): begin/stage/scan/grill/propose write
  // ONLY intake_sessions/intake_artifacts/intake_observations/intake_questions
  // and the isolated staging CAS (intake-staged/<intake_id>/…, a sibling of
  // staged-uploads/ under the CAS root) — never
  // Project/Gate/ProjectArtifact/Workspace/Job/Run/TerminalLog/Evidence/
  // Claim, and NOTHING to the outbox. The only writes to business tables and
  // the outbox happen inside the adoption transaction (adoptIntake). There is
  // no Gate/Run/Evidence write path in any intake method (asserted by
  // tests/unit/intake.test.ts — pre-accept table counts stay zero).

  /** Absolute staged-file path for one intake artifact. */
  intakeStagedPath(intakeId: string, sha256: string): string {
    return join(this.intakeStagedRoot, intakeId, `${sha256}.part`)
  }

  /** Current archive unpack-scan limits (statics overrideable by tests). */
  private archiveLimits(): ArchiveLimits {
    return {
      maxEntries: ResearchKernel.ARCHIVE_MAX_ENTRIES,
      maxTotalBytes: ResearchKernel.ARCHIVE_MAX_TOTAL_BYTES,
      maxFileBytes: ResearchKernel.ARCHIVE_MAX_FILE_BYTES,
      maxRatio: ResearchKernel.ARCHIVE_MAX_RATIO,
    }
  }

  private intakeSessionFromRow(row: IntakeSessionRow): IntakeSession {
    return {
      intake_id: row.intake_id,
      project_id: row.project_id,
      owner: {
        principal_id: row.owner_principal_id,
        tenant_id: row.owner_tenant_id,
        auth_method: row.owner_auth_method,
        session_id: row.owner_session_id,
      },
      status: row.status as IntakeStatus,
      revision: row.revision,
      source_label: row.source_label,
      target_phase: (row.target_phase ?? null) as ObservedPhase | null,
      expires_at: row.expires_at,
      scan_summary: jsonParse(row.scan_summary, {}),
      created_at: row.created_at,
      updated_at: row.updated_at,
      audit: jsonParse(row.audit_json, []),
    }
  }

  /**
   * ONBOARD-01 scope guard (cross-project 404, log-authz style): a route
   * scoped to `/v1/projects/{id}/intake/{iid}` must not observe an intake
   * that belongs to another project — 404 intake_not_found either way.
   */
  assertIntakeInProject(intakeId: string, projectId: string): void {
    this.getProject(projectId)
    this.getIntakeSessionRow(intakeId, projectId)
  }

  /** Session row lookup with 404 intake_not_found (project-scoped). */
  private getIntakeSessionRow(intakeId: string, projectId?: string): IntakeSessionRow {
    const row = this.db.prepare('SELECT * FROM intake_sessions WHERE intake_id = ?').get(intakeId) as IntakeSessionRow | undefined
    if (row === undefined || (projectId !== undefined && row.project_id !== projectId)) {
      throw new KernelError(404, 'intake_not_found', `intake ${intakeId} not found`)
    }
    return row
  }

  private appendIntakeAudit(intakeId: string, action: string, detail = ''): void {
    const row = this.getIntakeSessionRow(intakeId)
    const audit = jsonParse(row.audit_json, [] as Array<{ at: string; action: string; detail?: string }>)
    audit.push({ at: nowIso(), action, detail })
    this.db.prepare('UPDATE intake_sessions SET audit_json = ?, updated_at = ? WHERE intake_id = ?')
      .run(JSON.stringify(audit), nowIso(), intakeId)
  }

  /** Throw 409 intake_state_conflict for terminal sessions. */
  private assertIntakeMutable(session: IntakeSession): void {
    if (['accepted', 'rejected', 'expired', 'failed'].includes(session.status)) {
      throw new KernelError(409, 'intake_state_conflict', `intake ${session.intake_id} is ${session.status} and cannot be modified`)
    }
  }

  /** Throw 409 intake_expired for active sessions past their TTL. */
  private assertIntakeNotExpired(session: IntakeSession, now = Date.now()): void {
    if (Date.parse(session.expires_at) < now && ['accepted', 'rejected', 'expired', 'failed'].includes(session.status) === false) {
      throw new KernelError(409, 'intake_expired', `intake ${session.intake_id} expired at ${session.expires_at} — reject it or start a new intake`)
    }
  }

  private intakeArtifacts(intakeId: string): IntakeArtifact[] {
    const rows = this.db.prepare('SELECT * FROM intake_artifacts WHERE intake_id = ? ORDER BY created_at').all(intakeId) as unknown as IntakeArtifactRow[]
    return rows.map(row => ({
      intake_id: row.intake_id,
      artifact_id: row.artifact_id,
      file_name: row.file_name,
      media_type: row.media_type,
      size_bytes: row.size_bytes,
      sha256: row.sha256,
      quarantine: row.quarantine as IntakeArtifact['quarantine'],
      scan_result: jsonParse(row.scan_result, {}),
      created_at: row.created_at,
    }))
  }

  private intakeObservations(intakeId: string): IntakeObservation[] {
    const rows = this.db.prepare('SELECT * FROM intake_observations WHERE intake_id = ? ORDER BY created_at').all(intakeId) as unknown as IntakeObservationRow[]
    return rows.map(row => ({
      observation_id: row.observation_id,
      intake_id: row.intake_id,
      artifact_id: row.artifact_id,
      locator: row.locator,
      detector: row.detector,
      detector_version: row.detector_version,
      value: row.value,
      warnings: jsonParse(row.warnings, []),
      trust: 'observed_unverified' as const,
      created_at: row.created_at,
    }))
  }

  private intakeAnswerMap(intakeId: string): Map<string, { answer: string; answered_at: string; answered_by: string | null }> {
    const rows = this.db.prepare('SELECT * FROM intake_questions WHERE intake_id = ?').all(intakeId) as unknown as IntakeQuestionRow[]
    const map = new Map<string, { answer: string; answered_at: string; answered_by: string | null }>()
    for (const row of rows) {
      if (row.answer === null) continue
      map.set(row.question_code, { answer: row.answer, answered_at: row.answered_at ?? '', answered_by: row.answered_by_principal })
    }
    return map
  }

  /**
   * ONBOARD-01 begin (research-onboarding.md §1/§3): create an Intake session
   * for the target project. Pre-accept: only an intake row is written.
   * Idempotent: the same Idempotency-Key replays the SAME session (different
   * request hash → 409 idempotency_conflict), and at most ONE active intake
   * exists per project (reuse). Expiry defaults to 7 days.
   */
  beginIntake(input: {
    project_id?: string | null
    source_label: string
    target_phase?: ObservedPhase | null
    owner?: HumanPrincipal
    expires_in_ms?: number
    idempotency_key?: string
    request_hash?: string
    owner_scope_id?: string
  }): IntakeSession {
    if (input.source_label === undefined || input.source_label.trim() === '') {
      throw new KernelError(422, 'validation_error', 'source_label is required')
    }
    const begin = (): IntakeSession => {
      if (input.project_id !== undefined && input.project_id !== null) {
        this.getProject(input.project_id) // 404 project_not_found
        this.assertChatScopeOpen(input.project_id, input.owner_scope_id)
      }
      // Scoped calls keep admission, idempotency replay, active reuse and
      // insert under the same BEGIN IMMEDIATE as a competing scope close.
      if (input.idempotency_key !== undefined && input.idempotency_key !== '') {
        const existing = this.db.prepare('SELECT * FROM intake_sessions WHERE idempotency_key = ?').get(input.idempotency_key) as IntakeSessionRow | undefined
        if (existing !== undefined) {
          if (
            existing.request_hash !== (input.request_hash ?? '')
            || existing.project_id !== (input.project_id ?? null)
            || existing.owner_scope_id !== (input.owner_scope_id ?? null)
          ) {
            throw new KernelError(409, 'idempotency_conflict', `intake idempotency key ${input.idempotency_key} was used with a different request authority`)
          }
          return this.intakeSessionFromRow(existing)
        }
      }
      // One active intake per project (recovery-friendly reuse). Intakes
      // created by a closed Chat scope are not silently adopted by a later
      // session; their durable owner remains provenance for recovery/audit.
      if (input.project_id !== undefined && input.project_id !== null) {
        const active = this.db.prepare(
          `SELECT i.* FROM intake_sessions i
           LEFT JOIN chat_scope_tombstones t
             ON t.project_id = i.project_id AND t.scope_id = i.owner_scope_id
           WHERE i.project_id = ?
             AND i.status IN ('draft','uploading','scanning','needs_input','grilling','proposal_ready','awaiting_human')
             AND (i.owner_scope_id IS NULL OR t.scope_id IS NULL)
             AND (? IS NULL OR i.owner_scope_id IS NULL OR i.owner_scope_id = ?)
           ORDER BY i.created_at LIMIT 1`,
        ).get(input.project_id, input.owner_scope_id ?? null, input.owner_scope_id ?? null) as IntakeSessionRow | undefined
        if (active !== undefined) return this.intakeSessionFromRow(active)
      }
      const owner: HumanPrincipal = input.owner ?? { principal_id: 'agent', auth_method: 'agent' }
      const now = nowIso()
      const intakeId = randomId('intk')
      const session: IntakeSession = {
        intake_id: intakeId,
        project_id: input.project_id ?? null,
        owner,
        status: 'draft',
        revision: 1,
        source_label: input.source_label.trim(),
        target_phase: input.target_phase ?? null,
        expires_at: new Date(Date.now() + (input.expires_in_ms ?? ResearchKernel.INTAKE_DEFAULT_TTL_MS)).toISOString(),
        scan_summary: {},
        created_at: now,
        updated_at: now,
        audit: [{ at: now, action: 'begin', detail: input.source_label }],
      }
      this.db.prepare(
        `INSERT INTO intake_sessions (intake_id, project_id, owner_principal_id, owner_tenant_id, owner_auth_method, owner_session_id,
           owner_scope_id, status, revision, source_label, target_phase, expires_at, scan_summary, audit_json, idempotency_key, request_hash, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        session.intake_id, session.project_id,
        session.owner.principal_id, session.owner.tenant_id ?? '', session.owner.auth_method ?? 'agent', session.owner.session_id ?? null,
        input.owner_scope_id ?? null,
        session.status, session.revision, session.source_label, session.target_phase, session.expires_at,
        JSON.stringify(session.scan_summary), JSON.stringify(session.audit),
        input.idempotency_key ?? null, input.request_hash ?? '', session.created_at, session.updated_at,
      )
      return session
    }
    // Unscoped begin is also used inside createProjectForGrill's transaction;
    // scoped Chat begin is the only path requiring a new linearization point.
    return input.owner_scope_id === undefined ? begin() : withTransaction(this.db, begin)
  }

  /**
   * ONBOARD-01 stage (research-onboarding.md §4): register ONE file into the
   * intake — server-computed sha256, plain-basename path safety, size cap
   * (reuses UPLOAD-01 limits). Bytes land in the ISOLATED staging CAS
   * (stagedUploadsRoot/intake/<intake_id>/<sha256>.part), never in the
   * project artifact space. Content-addressed: re-staging identical bytes
   * returns the existing artifact row. Changing files invalidates any
   * generated proposal (proposal_stale semantics).
   */
  stageIntakeArtifact(intakeId: string, input: {
    file_name: string
    media_type?: string
    content: Uint8Array | string
  }): IntakeArtifact {
    validateUploadFileName(input.file_name)
    const bytes = typeof input.content === 'string' ? Buffer.from(input.content, 'utf8') : Buffer.from(input.content)
    if (bytes.byteLength > ResearchKernel.UPLOAD_MAX_FILE_BYTES) {
      throw new KernelError(413, 'payload_too_large',
        `intake file exceeds the size limit: ${bytes.byteLength} bytes (max_file_bytes=${ResearchKernel.UPLOAD_MAX_FILE_BYTES})`)
    }
    const sha256 = createHash('sha256').update(bytes).digest('hex')
    const artifactId = `sha256:${sha256}`
    return withTransaction(this.db, () => {
      const row = this.getIntakeSessionRow(intakeId)
      const session = this.intakeSessionFromRow(row)
      this.assertIntakeMutable(session)
      this.assertIntakeNotExpired(session)
      if (row.project_id !== null) this.assertChatScopeOpen(row.project_id, row.owner_scope_id ?? undefined)
      const existing = this.db.prepare('SELECT * FROM intake_artifacts WHERE intake_id = ? AND artifact_id = ?')
        .get(intakeId, artifactId) as IntakeArtifactRow | undefined
      // A direct/multipart stage is an independent live reference. It takes
      // ownership away from any old upload cleanup ledger before returning or
      // recreating the same content-addressed path.
      this.db.prepare(
        'UPDATE upload_sessions SET owns_artifact = 0 WHERE intake_id = ? AND finalized_sha256 = ? AND owns_artifact = 1',
      ).run(intakeId, sha256)
      if (existing !== undefined) {
        return {
          intake_id: existing.intake_id,
          artifact_id: existing.artifact_id,
          file_name: existing.file_name,
          media_type: existing.media_type,
          size_bytes: existing.size_bytes,
          sha256: existing.sha256,
          quarantine: existing.quarantine as IntakeArtifact['quarantine'],
          scan_result: jsonParse(existing.scan_result, {}),
          created_at: existing.created_at,
        }
      }
      const partPath = this.intakeStagedPath(intakeId, sha256)
      try {
        // Keep the filesystem generation and the ownership handoff under the
        // same SQLite writer lock as cleanupUploadSessions.
        mkdirMode(join(this.intakeStagedRoot, intakeId), 0o700)
        writeFileSync(partPath, bytes, { mode: 0o600 })
        chmodSync(partPath, 0o600)
      } catch (error) {
        throw new KernelError(500, 'stage_write_failed', `intake staged write failed: ${(error as Error).message}`)
      }
      const now = nowIso()
      const artifact: IntakeArtifact = {
        artifact_id: artifactId,
        intake_id: intakeId,
        file_name: input.file_name,
        media_type: input.media_type ?? 'application/octet-stream',
        size_bytes: bytes.byteLength,
        sha256,
        quarantine: 'staged',
        scan_result: {},
        created_at: now,
      }
      this.db.prepare(
        'INSERT INTO intake_artifacts (intake_id, artifact_id, file_name, media_type, size_bytes, sha256, quarantine, scan_result, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      ).run(intakeId, artifactId, artifact.file_name, artifact.media_type, artifact.size_bytes, artifact.sha256, artifact.quarantine, '{}', now)
      this.setIntakeStatus(intakeId, 'uploading', row.status, 'artifact_staged')
      return artifact
    })
  }

  private setIntakeStatus(intakeId: string, to: IntakeStatus, from: string, auditAction: string): void {
    // A file change after a proposal invalidates it (accept pins the revision).
    if ((from === 'proposal_ready' || from === 'awaiting_human') && to !== 'awaiting_human') {
      this.db.prepare('UPDATE intake_sessions SET proposal_json = NULL WHERE intake_id = ?').run(intakeId)
      this.appendIntakeAudit(intakeId, 'proposal_invalidated', `files changed while ${from}`)
    }
    this.db.prepare('UPDATE intake_sessions SET status = ?, revision = revision + 1, updated_at = ? WHERE intake_id = ?')
      .run(to, nowIso(), intakeId)
    this.appendIntakeAudit(intakeId, auditAction, `${from} -> ${to}`)
  }

  /** Remove one staged artifact (quarantine resolution: delete/replace). */
  removeIntakeArtifact(intakeId: string, artifactId: string): void {
    const row = this.getIntakeSessionRow(intakeId)
    const session = this.intakeSessionFromRow(row)
    this.assertIntakeMutable(session)
    this.assertIntakeNotExpired(session)
    const artifact = this.db.prepare('SELECT * FROM intake_artifacts WHERE intake_id = ? AND artifact_id = ?')
      .get(intakeId, artifactId) as IntakeArtifactRow | undefined
    if (artifact === undefined) {
      throw new KernelError(404, 'intake_artifact_not_found', `intake artifact ${artifactId} not found in intake ${intakeId}`)
    }
    try { unlinkSync(this.intakeStagedPath(intakeId, artifact.sha256)) } catch { /* already gone */ }
    this.db.prepare('DELETE FROM intake_artifacts WHERE intake_id = ? AND artifact_id = ?').run(intakeId, artifactId)
    this.db.prepare('DELETE FROM intake_observations WHERE intake_id = ? AND artifact_id = ?').run(intakeId, artifactId)
    this.setIntakeStatus(intakeId, 'uploading', row.status, 'artifact_removed')
  }

  /**
   * ONBOARD-01 scan (research-onboarding.md §4.2): verify every staged
   * artifact's server-side sha256 and run the STATIC security scan
   * (extension allow/deny/quarantine, magic bytes, static secret patterns;
   * NO AV in this environment — recorded honestly in scan_result), then the
   * CONTROLLED ARCHIVE UNPACK SCAN for clean zip/tar/tar.gz artifacts
   * (archive-scan.ts: path safety, duplicate/case collision, symlink/
   * hardlink/device/FIFO rejection, entry/byte/ratio bomb caps). A deep-scan
   * violation quarantines the artifact (fail closed — §4.2 "扫描必须验证");
   * legitimate-but-unscannable formats (bz2/xz/7z, single-file gzip) are
   * recorded `unsupported` and stay clean. The unpacked view
   * (scan_result.archive_extract) feeds adoption-time materialization;
   * scan_summary aggregates extracted_entries/extracted_bytes. Verdicts:
   * clean | quarantined | rejected. Observations are replaced per scan.
   */
  scanIntake(intakeId: string): IntakeProjection {
    const row = this.getIntakeSessionRow(intakeId)
    const session = this.intakeSessionFromRow(row)
    this.assertIntakeMutable(session)
    this.assertIntakeNotExpired(session)
    const artifacts = this.intakeArtifacts(intakeId)
    let clean = 0
    let quarantined = 0
    let rejected = 0
    let extractedEntries = 0
    let extractedBytes = 0
    let archivesScanned = 0
    this.db.prepare('DELETE FROM intake_observations WHERE intake_id = ?').run(intakeId)
    const insertObservation = this.db.prepare(
      'INSERT INTO intake_observations (observation_id, intake_id, artifact_id, locator, detector, detector_version, value, warnings, trust, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    )
    for (const artifact of artifacts) {
      const partPath = this.intakeStagedPath(intakeId, artifact.sha256)
      let stat: ReturnType<typeof statSync>
      try {
        stat = statSync(partPath)
      } catch {
        throw new KernelError(422, 'stage_corrupted', `intake artifact ${artifact.file_name} staged bytes are missing — re-upload (stage GC?)`)
      }
      // CHUNK-01 (init-grill-upload-models.md §3): files staged through the
      // batch chunked pipeline may exceed the 32 MiB whole-file cap (up to
      // the per-Intake quota). Hash verification streams the file; the
      // static scan runs on a bounded head; the controlled deep archive
      // scan reads the full buffer only up to ARCHIVE_DEEP_SCAN_MAX_BYTES
      // (larger archives record `too_large` and stay clean — honest note).
      let staged: Buffer | null = null
      let actualSha: string
      if (stat.size <= ResearchKernel.UPLOAD_MAX_FILE_BYTES) {
        try {
          staged = readFileSync(partPath)
        } catch {
          throw new KernelError(422, 'stage_corrupted', `intake artifact ${artifact.file_name} staged bytes are missing — re-upload (stage GC?)`)
        }
        actualSha = createHash('sha256').update(staged).digest('hex')
      } else {
        actualSha = hashFileStreaming(partPath)
      }
      if (actualSha !== artifact.sha256 || stat.size !== artifact.size_bytes) {
        throw new KernelError(422, 'stage_corrupted', `intake artifact ${artifact.file_name} content hash mismatch (recorded ${artifact.sha256}, got ${actualSha})`)
      }
      const scanBytes = staged ?? readFileHead(partPath, SECRET_SCAN_BYTES)
      const verdict = scanIntakeArtifactStatic(artifact.file_name, artifact.media_type, scanBytes, stat.size)
      // Deep archive unpack scan for clean zip/tar/tar.gz artifacts.
      let scanResult: Record<string, unknown> = verdict.scan_result
      let quarantine = verdict.quarantine
      const observations = [...verdict.observations]
      if (verdict.quarantine === 'clean' && ARCHIVE_SCAN_EXTENSIONS.includes(extensionOfFile(artifact.file_name))) {
        if (staged === null && stat.size > ARCHIVE_DEEP_SCAN_MAX_BYTES) {
          // CHUNK-01: deep unpack scanning a multi-hundred-MiB archive in
          // memory is out of scope for the static pipeline — record
          // `too_large` honestly (the entry/byte/ratio limits are
          // re-applied at adoption-time materialization anyway).
          scanResult = { ...verdict.scan_result, archive_extract: { status: 'too_large', reason: `archive is ${stat.size} bytes > ${ARCHIVE_DEEP_SCAN_MAX_BYTES}; deep unpack scan deferred to adoption-time materialization` } }
          observations.push({
            detector: 'archive_extract', detector_version: '1', locator: artifact.file_name,
            value: 'archive deep scan skipped (too large for the static pipeline)',
            warnings: ['archive_deep_scan_deferred'],
          })
        } else {
          const archiveBytes = staged ?? readFileSync(partPath)
          try {
            const unpacked = scanArchive(archiveBytes, artifact.file_name, this.archiveLimits())
            archivesScanned += 1
            extractedEntries += unpacked.entries.length
            extractedBytes += unpacked.extracted_bytes
            scanResult = {
              ...verdict.scan_result,
              archive_extract: {
                status: 'ok',
                kind: unpacked.kind,
                extracted_entries: unpacked.entries.length,
                extracted_bytes: unpacked.extracted_bytes,
                entries: unpacked.entries.map(e => ({ path: e.path, size_bytes: e.size_bytes })),
              },
            }
            observations.push({
              detector: 'archive_extract', detector_version: '1', locator: artifact.file_name,
              value: `${unpacked.kind} archive: ${unpacked.entries.length} entries / ${unpacked.extracted_bytes} bytes`,
              warnings: ['archive_extract_ok'],
            })
          } catch (error) {
            if (error instanceof ArchiveScanError) {
              archivesScanned += 1
              if (error.code === 'archive_gzip_single_file') {
                // Legitimate single-file gzip (e.g. data.csv.gz): not unpacked
                // but NOT refused — stays clean and adoptable as a code blob.
                scanResult = { ...verdict.scan_result, archive_extract: { status: 'unsupported', reason: error.message } }
                observations.push({
                  detector: 'archive_extract', detector_version: '1', locator: artifact.file_name,
                  value: `archive not unpacked: ${error.message}`,
                  warnings: ['archive_extract_unsupported'],
                })
              } else {
                // Fail closed: a path escape / bomb / special entry / corrupt
                // archive quarantines the artifact until removed or replaced.
                quarantine = 'quarantined'
                scanResult = { ...verdict.scan_result, archive_extract: { status: 'rejected', code: error.code, reason: error.message } }
                observations.push({
                  detector: 'archive_extract', detector_version: '1', locator: artifact.file_name,
                  value: `archive scan rejected: ${error.code}`,
                  warnings: ['archive_extract_rejected'],
                })
              }
            } else {
              throw error
            }
          }
        }
      }
      this.db.prepare('UPDATE intake_artifacts SET quarantine = ?, scan_result = ? WHERE intake_id = ? AND artifact_id = ?')
        .run(quarantine, JSON.stringify(scanResult), intakeId, artifact.artifact_id)
      if (quarantine === 'clean') clean += 1
      else if (quarantine === 'quarantined') quarantined += 1
      else rejected += 1
      for (const observation of observations) {
        insertObservation.run(
          randomId('obs'), intakeId, artifact.artifact_id,
          observation.locator, observation.detector, observation.detector_version, observation.value,
          JSON.stringify(observation.warnings), 'observed_unverified', nowIso(),
        )
      }
    }
    const scanSummary: Record<string, unknown> = {
      scanned_at: nowIso(),
      scanner: 'static-rules-v1',
      av_available: false,
      artifact_count: artifacts.length,
      clean,
      quarantined,
      rejected,
      // ONBOARD-01 §4.2: unpacked-view totals of the controlled archive scan.
      archives_scanned: archivesScanned,
      extracted_entries: extractedEntries,
      extracted_bytes: extractedBytes,
    }
    this.db.prepare('UPDATE intake_sessions SET scan_summary = ? WHERE intake_id = ?').run(JSON.stringify(scanSummary), intakeId)
    // Questions are always answerable after a scan; when every required
    // question is already answered the session is proposal_ready.
    const required = requiredQuestionCodes(session.target_phase)
    const answers = this.intakeAnswerMap(intakeId)
    const allAnswered = [...required].every(code => {
      const a = answers.get(code)
      return a !== undefined && a.answer !== ''
    })
    this.setIntakeStatus(intakeId, allAnswered ? 'proposal_ready' : 'needs_input', row.status, 'scan_completed')
    return this.getIntakeProjection(intakeId)
  }

  /** ONBOARD-01 resume: full durable intake state (survives restarts). */
  getIntakeProjection(intakeId: string): IntakeProjection {
    const row = this.getIntakeSessionRow(intakeId)
    const session = this.intakeSessionFromRow(row)
    const proposal = row.proposal_json === null || row.proposal_json === '' ? null : jsonParse(row.proposal_json, null) as unknown as PhaseProposal
    const receipt = row.receipt_json === null || row.receipt_json === '' ? null : jsonParse(row.receipt_json, null) as unknown as AdoptionReceipt
    return {
      session,
      artifacts: this.intakeArtifacts(intakeId),
      observations: this.intakeObservations(intakeId),
      questions: questionViews(
        questionsForTargetPhase(session.target_phase),
        this.intakeAnswerMap(intakeId),
      ),
      proposal,
      receipt,
    }
  }

  /** ONBOARD-01: list intake sessions (optionally per project). */
  listIntakes(projectId?: string): IntakeSession[] {
    const rows = projectId === undefined
      ? this.db.prepare('SELECT * FROM intake_sessions ORDER BY created_at DESC').all() as unknown as IntakeSessionRow[]
      : this.db.prepare('SELECT * FROM intake_sessions WHERE project_id = ? ORDER BY created_at DESC').all(projectId) as unknown as IntakeSessionRow[]
    return rows.map(row => this.intakeSessionFromRow(row))
  }

  /** ONBOARD-01 Grill: deterministic versioned question set + answer state. */
  getIntakeQuestions(intakeId: string): {
    intake_id: string
    taxonomy_version: number
    question_revision: number
    target_phase: ObservedPhase | null
    questions: GrillAnswerView[]
  } {
    const row = this.getIntakeSessionRow(intakeId)
    const session = this.intakeSessionFromRow(row)
    return {
      intake_id: intakeId,
      taxonomy_version: GRILL_TAXONOMY_VERSION,
      question_revision: GRILL_QUESTION_REVISION,
      target_phase: session.target_phase,
      questions: questionViews(questionsForTargetPhase(session.target_phase), this.intakeAnswerMap(intakeId)),
    }
  }

  /**
   * ONBOARD-01 Grill answers (research-onboarding.md §5): record
   * human_assertion answers with the Human Principal + question revision.
   * All required answered → proposal_ready; otherwise stays grilling.
   * `unknown` answers are stored as answers but keep their gap (and lower
   * the proposal confidence). Pre-accept: only intake_questions rows.
   */
  submitIntakeAnswers(intakeId: string, answers: GrillAnswerInput[], principal: HumanPrincipal): IntakeProjection {
    if (principal === undefined || typeof principal.principal_id !== 'string' || principal.principal_id === '') {
      throw new KernelError(422, 'principal_required', 'intake answers require an authenticated principal (principal.principal_id)')
    }
    const row = this.getIntakeSessionRow(intakeId)
    const session = this.intakeSessionFromRow(row)
    this.assertIntakeNotExpired(session)
    if (!['needs_input', 'grilling', 'proposal_ready'].includes(session.status)) {
      throw new KernelError(409, 'intake_state_conflict', `intake ${intakeId} is ${session.status}; answers require needs_input/grilling/proposal_ready (scan first)`)
    }
    const taxonomy = questionsForTargetPhase(session.target_phase)
    const byCode = new Map(taxonomy.map(q => [q.question_code, q] as const))
    const upsert = this.db.prepare(
      `INSERT INTO intake_questions (intake_id, question_code, question_revision, required, answer, answered_by_principal, answered_by_session, answered_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(intake_id, question_code) DO UPDATE SET answer = excluded.answer, answered_by_principal = excluded.answered_by_principal, answered_by_session = excluded.answered_by_session, answered_at = excluded.answered_at`,
    )
    for (const answer of answers) {
      const question = byCode.get(answer.question_code)
      if (question === undefined) {
        throw new KernelError(422, 'unknown_question', `question ${answer.question_code} does not exist in taxonomy version ${GRILL_TAXONOMY_VERSION}`)
      }
      if (answer.question_revision !== GRILL_QUESTION_REVISION) {
        throw new KernelError(409, 'question_revision_conflict',
          `question ${answer.question_code} revision ${answer.question_revision} does not match current revision ${GRILL_QUESTION_REVISION}`)
      }
      if (answer.answer === undefined || answer.answer.trim() === '') {
        throw new KernelError(422, 'question_required', `question ${answer.question_code} answer must not be empty ('unknown' is allowed)`)
      }
      upsert.run(
        intakeId, answer.question_code, GRILL_QUESTION_REVISION, question.required ? 1 : 0,
        answer.answer.trim(), principal.principal_id, principal.session_id ?? null, nowIso(),
      )
    }
    const required = requiredQuestionCodes(session.target_phase)
    const answersMap = this.intakeAnswerMap(intakeId)
    const allAnswered = [...required].every(code => {
      const a = answersMap.get(code)
      return a !== undefined && a.answer !== ''
    })
    this.setIntakeStatus(intakeId, allAnswered ? 'proposal_ready' : 'grilling', row.status, 'answers_submitted')
    return this.getIntakeProjection(intakeId)
  }

  /**
   * ONBOARD-01 propose (research-onboarding.md §6): deterministically build
   * the PhaseProposal from the human answers + scan verdicts. All REQUIRED
   * questions must be answered (422 question_required lists the missing
   * codes). observed_phase is metadata; safe_project_status comes from the
   * KERNEL state machine (a fresh DRAFT project stays DRAFT); the proposal's
   * required gates are created PENDING at adoption — never decided here.
   */
  proposeIntake(intakeId: string): PhaseProposal {
    const row = this.getIntakeSessionRow(intakeId)
    const session = this.intakeSessionFromRow(row)
    this.assertIntakeNotExpired(session)
    if (!['needs_input', 'grilling', 'proposal_ready', 'awaiting_human'].includes(session.status)) {
      throw new KernelError(409, 'intake_state_conflict', `intake ${intakeId} is ${session.status}; propose requires a scanned, answered intake`)
    }
    const answers = this.intakeAnswerMap(intakeId)
    const required = requiredQuestionCodes(session.target_phase)
    const missing: string[] = []
    for (const code of required) {
      const a = answers.get(code)
      if (a === undefined || a.answer === '') missing.push(code)
    }
    if (missing.length > 0) {
      throw new KernelError(422, 'question_required', `required questions unanswered: ${missing.join(', ')} — answer them before proposing`)
    }
    const projectStatus = session.project_id === null ? 'DRAFT' : this.getProject(session.project_id).status
    const previous = row.proposal_json === null || row.proposal_json === '' ? null : jsonParse(row.proposal_json, null) as unknown as PhaseProposal
    const proposal = buildPhaseProposal({
      intakeId,
      revision: (previous?.revision ?? 0) + 1,
      targetPhase: session.target_phase,
      answers,
      artifacts: this.intakeArtifacts(intakeId),
      observations: this.intakeObservations(intakeId),
      projectStatus,
      now: nowIso(),
    })
    this.db.prepare('UPDATE intake_sessions SET proposal_json = ?, status = ?, revision = revision + 1, updated_at = ? WHERE intake_id = ?')
      .run(JSON.stringify(proposal), 'awaiting_human', nowIso(), intakeId)
    this.appendIntakeAudit(intakeId, 'proposal_generated', `revision ${proposal.revision} (observed_phase=${proposal.observed_phase})`)
    return proposal
  }

  /**
   * ONBOARD-01 adopt (research-onboarding.md §7): the ONLY intake write to
   * business tables. Runs in ONE Kernel transaction:
   *  - validates the Human PI Principal, proposal freshness (revision),
   *    target project revision (409 project_revision_conflict) and that all
   *    artifacts are clean (422 artifact_quarantined);
   *  - promotes staged blobs into CAS + registers project Artifact rows;
   *  - creates the phase's required gates PENDING (never decided);
   *  - imports metrics/results files as draft (legacy_unverified) Evidence
   *    and logs as log Artifact + ImportedRunObservation — NEVER TerminalLog,
   *    RunSet, verified/accepted Evidence or supported Claim;
   *  - writes the AdoptionReceipt (pinned revisions + idempotency hash);
   *  - AFTER the transaction commits, materializes TeX/code files and
   *    unpacked archive entries into the project TeX document / code
   *    workspace (+ optional CodeSnapshot) and appends the report to the
   *    receipt — materialization is best-effort and never rolls back the
   *    adoption (research-onboarding.md §6.1).
   * The project stays on its kernel state machine status (DRAFT for fresh
   * projects) — adoption never skips the Scope Gate or any other gate.
   * Idempotent: same intake + Idempotency-Key + request hash → same receipt;
   * different hash → 409 idempotency_conflict; a second adopt without a key
   * replays the stored receipt.
   */
  adoptIntake(input: {
    intake_id: string
    expected_proposal_revision: number
    expected_target_revision?: number
    idempotency_key?: string
    request_hash?: string
  }, principal: HumanPrincipal): AdoptionReceipt {
    if (principal === undefined || typeof principal.principal_id !== 'string' || principal.principal_id === '') {
      throw new KernelError(422, 'principal_required', 'intake adoption requires an authenticated Human Principal (principal.principal_id)')
    }
    const row = this.getIntakeSessionRow(input.intake_id)
    const session = this.intakeSessionFromRow(row)
    const storedReceipt = row.receipt_json === null || row.receipt_json === '' ? null : jsonParse(row.receipt_json, null) as unknown as AdoptionReceipt
    if (session.status === 'accepted' && storedReceipt !== null) {
      // Idempotent replay: same key + request hash returns the SAME receipt;
      // a different key OR a different hash under the same key is a 409.
      if (input.idempotency_key !== undefined && input.idempotency_key !== '') {
        if (storedReceipt.idempotency_key !== input.idempotency_key) {
          throw new KernelError(409, 'idempotency_conflict', `intake ${input.intake_id} was already adopted under a different idempotency key`)
        }
        if (storedReceipt.request_hash !== (input.request_hash ?? '')) {
          throw new KernelError(409, 'idempotency_conflict', `intake idempotency key ${input.idempotency_key} was used with a different request hash`)
        }
      }
      return storedReceipt
    }
    if (session.status !== 'awaiting_human') {
      throw new KernelError(409, 'intake_state_conflict', `intake ${input.intake_id} is ${session.status}; adoption requires awaiting_human (propose first)`)
    }
    if (Date.parse(session.expires_at) < Date.now()) {
      throw new KernelError(409, 'intake_expired', `intake ${input.intake_id} expired at ${session.expires_at}`)
    }
    const proposal = row.proposal_json === null || row.proposal_json === '' ? null : jsonParse(row.proposal_json, null) as unknown as PhaseProposal
    if (proposal === null) {
      throw new KernelError(422, 'proposal_stale', `intake ${input.intake_id} has no proposal — propose first`)
    }
    if (input.expected_proposal_revision !== proposal.revision) {
      throw new KernelError(409, 'proposal_stale',
        `proposal revision ${input.expected_proposal_revision} is stale; current revision is ${proposal.revision} — re-propose`)
    }
    if (session.project_id === null) {
      throw new KernelError(422, 'phase_unadoptable', `intake ${input.intake_id} has no target project — merge into a project first`)
    }
    const project = this.getProject(session.project_id)
    if (input.expected_target_revision !== undefined && input.expected_target_revision !== project.revision) {
      throw new KernelError(409, 'project_revision_conflict',
        `target project revision ${input.expected_target_revision} is stale; current revision is ${project.revision} — re-propose`)
    }
    if (input.idempotency_key !== undefined && input.idempotency_key !== '') {
      const replay = this.db.prepare('SELECT * FROM intake_sessions WHERE intake_id = ? AND idempotency_key = ?')
        .get(input.intake_id, input.idempotency_key) as IntakeSessionRow | undefined
      if (replay !== undefined && replay.receipt_json !== null && replay.receipt_json !== '') {
        const receipt = jsonParse(replay.receipt_json, null) as unknown as AdoptionReceipt
        if (receipt.request_hash !== (input.request_hash ?? '')) {
          throw new KernelError(409, 'idempotency_conflict', `intake idempotency key ${input.idempotency_key} was used with a different request hash`)
        }
        return receipt
      }
    }
    const artifacts = this.intakeArtifacts(input.intake_id)
    const blocked = artifacts.filter(a => a.quarantine !== 'clean')
    if (blocked.length > 0) {
      throw new KernelError(422, 'artifact_quarantined',
        `intake artifacts are not clean: ${blocked.map(a => `${a.file_name} (${a.quarantine})`).join(', ')} — remove or replace them`)
    }
    const txReceipt = withTransaction(this.db, () => {
      const now = nowIso()
      const createdObjectRefs: string[] = []
      const draftEvidenceRefs: string[] = []
      const pendingGateRefs: string[] = []
      for (const artifact of artifacts) {
        const partPath = this.intakeStagedPath(input.intake_id, artifact.sha256)
        let staged: Buffer
        try {
          staged = readFileSync(partPath)
        } catch {
          throw new KernelError(422, 'stage_corrupted', `intake artifact ${artifact.file_name} staged bytes are missing — re-upload`)
        }
        const actualSha = createHash('sha256').update(staged).digest('hex')
        if (actualSha !== artifact.sha256 || staged.byteLength !== artifact.size_bytes) {
          throw new KernelError(422, 'stage_corrupted', `intake artifact ${artifact.file_name} content hash mismatch — re-upload`)
        }
        const kind = artifactKindForFile(artifact.file_name)
        const record = this.registerArtifact({
          project_id: session.project_id!,
          kind,
          content: staged,
          media_type: artifact.media_type,
          file_name: artifact.file_name,
          metadata: { intake_id: input.intake_id, imported: true, source: 'intake' },
        })
        createdObjectRefs.push(record.artifact_id)
        // §6.1: logs → log Artifact + ImportedRunObservation (NEVER TerminalLog).
        if (kind === 'log') {
          this.db.prepare(
            'INSERT INTO intake_observations (observation_id, intake_id, artifact_id, locator, detector, detector_version, value, warnings, trust, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
          ).run(
            randomId('obs'), input.intake_id, artifact.artifact_id,
            artifact.file_name, 'imported_run', '1',
            `imported run observation from ${artifact.file_name} — imported logs never become TerminalLog rows`,
            '[]', 'observed_unverified', now,
          )
        }
        // §6.1: metrics/results → data Artifact + draft (legacy_unverified) Evidence.
        if (isImportableMetricsFile(artifact.file_name)) {
          const parsed = parseMetricsFileV1(staged)
          if (parsed !== null) {
            const first = parsed.metrics[0]!
            const evidence = this.ingestEvidence({
              project_id: session.project_id!,
              source_type: 'reproduction',
              run_ids: [],
              artifact_refs: [record.artifact_id],
              analysis_method: 'imported-unverified',
              result: {
                primary_metric: first.name,
                value: first.value,
                n_seeds: 0,
                direction: undefined,
              },
              provenance_status: 'legacy_unverified',
            })
            draftEvidenceRefs.push(evidence.evidence_id)
          }
        }
      }
      // §6: the phase's gates are created PENDING — never decided by intake.
      for (const gateType of SAFE_PHASE_LANDING[proposal.observed_phase].required_gates) {
        const gate = this.createGate({
          project_id: session.project_id!,
          type: gateType as GateType,
          title: `${gateType} gate (imported material)`,
          summary: `created by intake adoption ${input.intake_id} — pending human decision; the intake never decides gates`,
          payload: { intake_id: input.intake_id, imported: true },
        })
        pendingGateRefs.push(gate.gate_id)
      }
      const receipt: AdoptionReceipt = {
        adoption_id: randomId('adopt'),
        intake_id: input.intake_id,
        project_id: session.project_id!,
        proposal_revision: proposal.revision,
        target_project_revision: project.revision,
        created_object_refs: createdObjectRefs,
        pending_gate_refs: pendingGateRefs,
        draft_evidence_refs: draftEvidenceRefs,
        // The materialization report is appended AFTER this transaction
        // commits (best-effort enhancement — research-onboarding.md §6.1);
        // the transaction itself only records the authoritative import.
        import_mappings: [],
        code_snapshot_refs: [],
        idempotency_key: input.idempotency_key ?? null,
        request_hash: input.request_hash ?? '',
        adopted_by: principal,
        adopted_at: now,
      }
      this.db.prepare(
        'UPDATE intake_sessions SET status = ?, receipt_json = ?, revision = revision + 1, updated_at = ? WHERE intake_id = ?',
      ).run('accepted', JSON.stringify(receipt), now, input.intake_id)
      this.appendIntakeAudit(input.intake_id, 'adopted', `adoption ${receipt.adoption_id} (proposal r${proposal.revision})`)
      this.emit(session.project_id, 'intake.accepted', {
        intake_id: input.intake_id, project_id: session.project_id, adoption_id: receipt.adoption_id,
        proposal_revision: proposal.revision, artifact_count: artifacts.length,
      })
      return receipt
    })
    // ── Post-transaction adoption materialization (research-onboarding.md
    // §6.1) ── TeX files/entries → project TeX document, code files/entries
    // → project code workspace (+ optional CodeSnapshot). adopt is the
    // AUTHORITATIVE import; materialization is BEST-EFFORT: failures record
    // `gap` mappings (or audit entries) and NEVER roll back the adoption.
    let receipt = txReceipt
    try {
      const materialized = this.materializeAdoptionImports({
        project_id: session.project_id!,
        intake_id: input.intake_id,
        artifacts,
      })
      receipt = { ...txReceipt, import_mappings: materialized.mappings, code_snapshot_refs: materialized.codeSnapshotRefs }
      this.db.prepare('UPDATE intake_sessions SET receipt_json = ?, updated_at = ? WHERE intake_id = ?')
        .run(JSON.stringify(receipt), nowIso(), input.intake_id)
    } catch (error) {
      // A materialization bug must never fail an authoritative adoption.
      this.appendIntakeAudit(input.intake_id, 'materialize', `materialization failed: ${(error as Error).message}`)
    } finally {
      // GC the isolated staging files (blobs now live in the real CAS) —
      // AFTER materialization re-read them from the staging area.
      this.gcIntakeStagedDir(input.intake_id)
    }
    return receipt
  }

  /**
   * ONBOARD-01 adoption materialization (research-onboarding.md §6.1) —
   * runs AFTER the adoption transaction commits; never rolls it back.
   *
   * For every adopted artifact the report carries one artifact-level mapping
   * (status `materialized` — the authoritative import), then:
   *  - direct TeX files → the project's TeX workspace document
   *    (tex-workspace `ensureDocument`/`writeFile`, entries at version 1;
   *    document_id rule: tex-workspace `doc_<uuid12>`, one document per
   *    project — the existing document is reused, never replaced);
   *  - direct code files → the project's `code` workspace (workspace-store
   *    `write` with expected version 0: an existing path CONFLICTS and
   *    records a gap — no silent overwrite);
   *  - unpacked archive entries (scan_result.archive_extract.status='ok'):
   *    TeX entries → TeX document, code entries → code workspace, every
   *    other entry type → gap `entry_type_not_materialized` (it stays
   *    inside the adopted archive artifact);
   *  - unscannable archives (bz2/xz/7z, single-file gzip, pre-deep-scan
   *    rows) → gap `archive_not_unpacked` / `archive_entries_not_scanned`;
   *  - when code materialized, an optional CodeSnapshot is generated over
   *    the code workspace (snapshotCodeArchive workspace semantics);
   *    snapshot failure is audited — the files remain in the workspace.
   */
  private materializeAdoptionImports(input: {
    project_id: string
    intake_id: string
    artifacts: IntakeArtifact[]
  }): { mappings: ImportMapping[]; codeSnapshotRefs: string[] } {
    const mappings: ImportMapping[] = []
    const codeSnapshotRefs: string[] = []
    let codeWorkspace: { id: string; name: string } | null = null
    let codeMaterialized = 0
    for (const artifact of input.artifacts) {
      const artifactId = artifact.artifact_id
      // Artifact-level mapping: the authoritative import (already committed).
      mappings.push({
        source_artifact_id: artifactId,
        source_file_name: artifact.file_name,
        target_kind: artifactKindForFile(artifact.file_name),
        target: '',
        status: 'materialized',
        reason: 'adopted as project artifact',
        note: '',
      })
      const archiveExtract = (artifact.scan_result as Record<string, unknown>).archive_extract as
        | { status: 'ok'; entries: Array<{ path: string; size_bytes: number }> }
        | { status: 'rejected' | 'unsupported'; reason?: string }
        | undefined
      if (archiveExtract?.status === 'ok') {
        let staged: Buffer
        try {
          staged = readFileSync(this.intakeStagedPath(input.intake_id, artifact.sha256))
        } catch {
          for (const entry of archiveExtract.entries) {
            mappings.push(this.materializationGap(artifactId, entry.path, artifactKindForFile(entry.path), 'staged_bytes_missing'))
          }
          continue
        }
        for (const entry of archiveExtract.entries) {
          // Re-extract ONE entry from the staged archive. The scan already
          // validated path safety + caps; materialization skips the walk
          // caps (a cap that changed between scan and adopt must fail THIS
          // entry via the per-entry inflate bound → gap, not the whole
          // archive) and never fails the adoption itself.
          let content: Buffer
          try {
            const got = extractArchiveEntries(staged, artifact.file_name, [entry.path], this.archiveLimits(), { enforceCaps: false }).get(entry.path)
            if (got === undefined) {
              mappings.push(this.materializationGap(artifactId, entry.path, artifactKindForFile(entry.path), 'entry_not_found'))
              continue
            }
            content = got
          } catch (error) {
            const code = error instanceof ArchiveScanError ? error.code : 'materialization_error'
            mappings.push(this.materializationGap(artifactId, entry.path, artifactKindForFile(entry.path),
              `${code}: ${(error as Error).message}`))
            continue
          }
          if (isTexMaterializableFile(entry.path)) {
            const result = this.materializeTexEntry(input, artifactId, entry.path, content)
            mappings.push(result.mapping)
          } else if (isCodeMaterializableFile(entry.path)) {
            const result = this.materializeCodeEntry(input, artifactId, entry.path, content, codeWorkspace)
            codeWorkspace = result.workspace
            if (result.materialized) codeMaterialized += 1
            mappings.push(result.mapping)
          } else {
            mappings.push(this.materializationGap(artifactId, entry.path, artifactKindForFile(entry.path), 'entry_type_not_materialized'))
          }
        }
      } else if (archiveExtract?.status === 'unsupported' || archiveExtract?.status === 'rejected') {
        mappings.push(this.materializationGap(artifactId, artifact.file_name, artifactKindForFile(artifact.file_name),
          `archive_not_unpacked:${archiveExtract.status}`))
      } else if (INTAKE_ARCHIVE_EXTENSIONS.has(extensionOfFile(artifact.file_name))) {
        // Staged before the deep scan existed, or a format with no
        // extractor (bz2/xz/7z): the blob stays an opaque code artifact.
        mappings.push(this.materializationGap(artifactId, artifact.file_name, artifactKindForFile(artifact.file_name),
          'archive_entries_not_scanned'))
      } else if (isTexMaterializableFile(artifact.file_name)) {
        let content: Buffer
        try {
          content = readFileSync(this.intakeStagedPath(input.intake_id, artifact.sha256))
        } catch {
          content = Buffer.alloc(0)
        }
        mappings.push(this.materializeTexEntry(input, artifactId, artifact.file_name, content).mapping)
      } else if (isCodeMaterializableFile(artifact.file_name)) {
        let content: Buffer
        try {
          content = readFileSync(this.intakeStagedPath(input.intake_id, artifact.sha256))
        } catch {
          content = Buffer.alloc(0)
        }
        const result = this.materializeCodeEntry(input, artifactId, artifact.file_name, content, codeWorkspace)
        codeWorkspace = result.workspace
        if (result.materialized) codeMaterialized += 1
        mappings.push(result.mapping)
      }
    }
    // Optional CodeSnapshot over the materialized code workspace
    // (snapshotCodeArchive workspace semantics — post-adoption code lives
    // in the project workspace and can be snapshotted directly).
    if (codeWorkspace !== null && codeMaterialized > 0) {
      try {
        const snapshot = this.snapshotCodeArchive(input.project_id, codeWorkspace.id, '',
          `adopted code from intake ${input.intake_id}`)
        codeSnapshotRefs.push(snapshot.snapshot_id)
        this.appendIntakeAudit(input.intake_id, 'materialize',
          `code snapshot ${snapshot.snapshot_id} generated from workspace ${codeWorkspace.id}`)
      } catch (error) {
        this.appendIntakeAudit(input.intake_id, 'materialize',
          `code snapshot failed (files remain in workspace ${codeWorkspace.id}): ${(error as Error).message}`)
      }
    }
    return { mappings, codeSnapshotRefs }
  }

  /** One `gap` mapping row (best-effort materialization failure). */
  private materializationGap(artifactId: string, source: string, kind: string, reason: string): ImportMapping {
    return {
      source_artifact_id: artifactId,
      source_file_name: source,
      target_kind: kind,
      target: '',
      status: 'gap',
      reason,
      note: '',
    }
  }

  /**
   * Best-effort TeX materialization of ONE file/entry into the project's
   * TeX workspace document. Never throws — returns the mapping row.
   * document_id rule: tex-workspace `ensureDocument` generates
   * `doc_<uuid12>` (one document per project, reused; root_file = the first
   * imported .tex root). First writes land at version 1.
   */
  private materializeTexEntry(
    input: { project_id: string; intake_id: string },
    artifactId: string,
    source: string,
    content: Buffer,
  ): { mapping: ImportMapping; document_id: string | null } {
    try {
      const document = this.tex.ensureDocument(input.project_id, source)
      const text = content.toString('utf8')
      if (Buffer.from(text, 'utf8').equals(content) === false) {
        throw new TexError('tex_entry_not_utf8', `${source} is not valid UTF-8 text (TeX materialization is text-only)`)
      }
      this.tex.writeFile(document.document_id, source, text, 0)
      return {
        mapping: {
          source_artifact_id: artifactId,
          source_file_name: source,
          target_kind: 'tex_document',
          target: document.document_id,
          status: 'materialized',
          reason: `written to TeX document ${document.document_id} at version 1`,
          note: '',
        },
        document_id: document.document_id,
      }
    } catch (error) {
      const code = error instanceof TexError ? error.code : 'materialization_error'
      return {
        mapping: this.materializationGap(artifactId, source, 'tex_document', `${code}: ${(error as Error).message}`),
        document_id: null,
      }
    }
  }

  /**
   * Best-effort code materialization of ONE file/entry into the project's
   * code workspace (per-adoption name `intake-<intake suffix>`, kind
   * 'code'). Text writes use the workspace-store text path (valid UTF-8);
   * anything else lands as a binary node. Expected version 0 = create-if-
   * absent: an existing path conflicts (gap) — never a silent overwrite.
   */
  private materializeCodeEntry(
    input: { project_id: string; intake_id: string },
    artifactId: string,
    source: string,
    content: Buffer,
    existing: { id: string; name: string } | null,
  ): { mapping: ImportMapping; workspace: { id: string; name: string } | null; materialized: boolean } {
    try {
      let workspace = existing
      if (workspace === null) {
        const name = `intake-${input.intake_id.slice(-8)}`
        const info = this.workspaces.ensure(input.project_id, 'code', name)
        workspace = { id: info.workspace_id, name }
      }
      const text = content.toString('utf8')
      if (Buffer.from(text, 'utf8').equals(content)) {
        this.workspaces.write(workspace.id, source, text, { version: 0 })
      } else {
        this.workspaces.writeBinary(workspace.id, source, content, 'application/octet-stream', { version: 0 })
      }
      return {
        mapping: {
          source_artifact_id: artifactId,
          source_file_name: source,
          target_kind: 'code_workspace',
          target: `code/${source}`,
          status: 'materialized',
          reason: `written to code workspace ${workspace.id}`,
          note: '',
        },
        workspace,
        materialized: true,
      }
    } catch (error) {
      const code = error instanceof WorkspaceError ? error.code : 'materialization_error'
      return {
        mapping: this.materializationGap(artifactId, source, 'code_workspace', `${code}: ${(error as Error).message}`),
        workspace: existing,
        materialized: false,
      }
    }
  }

  private gcIntakeStagedDir(intakeId: string): void {
    const dir = join(this.intakeStagedRoot, intakeId)
    let entries: string[]
    try {
      entries = readdirSync(dir)
    } catch {
      return // already gone
    }
    for (const entry of entries) {
      try { unlinkSync(join(dir, entry)) } catch { /* raced */ }
    }
    try { rmdirSync(dir) } catch { /* raced */ }
  }

  /**
   * ONBOARD-01 reject (research-onboarding.md §7): Human rejection — GC the
   * isolated staged blobs and mark the session rejected (audited). Accepted
   * sessions cannot be rejected; an already-rejected replay is a no-op.
   */
  rejectIntake(intakeId: string, principal: HumanPrincipal): IntakeProjection {
    if (principal === undefined || typeof principal.principal_id !== 'string' || principal.principal_id === '') {
      throw new KernelError(422, 'principal_required', 'intake rejection requires an authenticated principal (principal.principal_id)')
    }
    const row = this.getIntakeSessionRow(intakeId)
    const session = this.intakeSessionFromRow(row)
    if (session.status === 'accepted') {
      throw new KernelError(409, 'intake_state_conflict', `intake ${intakeId} was adopted and cannot be rejected`)
    }
    if (session.status === 'rejected') {
      return this.getIntakeProjection(intakeId) // idempotent replay
    }
    this.gcIntakeStagedDir(intakeId)
    this.db.prepare('UPDATE intake_sessions SET status = ?, revision = revision + 1, updated_at = ? WHERE intake_id = ?')
      .run('rejected', nowIso(), intakeId)
    this.appendIntakeAudit(intakeId, 'rejected', `rejected by ${principal.principal_id}`)
    this.emit(session.project_id, 'intake.rejected', { intake_id: intakeId, project_id: session.project_id })
    return this.getIntakeProjection(intakeId)
  }

  /**
   * ONBOARD-01 recovery/GC (research-onboarding.md §7): expire sessions past
   * their TTL that were never adopted — GC staged blobs, mark expired
   * (audited + outbox). Accepted sessions are never touched. Returns the
   * number of sessions expired.
   */
  expireIntakes(now = Date.now()): number {
    const rows = this.db.prepare(
      "SELECT * FROM intake_sessions WHERE status IN ('draft','uploading','scanning','needs_input','grilling','proposal_ready','awaiting_human','accepting') AND expires_at < ?",
    ).all(new Date(now).toISOString()) as unknown as IntakeSessionRow[]
    for (const row of rows) {
      this.gcIntakeStagedDir(row.intake_id)
      this.db.prepare('UPDATE intake_sessions SET status = ?, revision = revision + 1, updated_at = ? WHERE intake_id = ?')
        .run('expired', nowIso(), row.intake_id)
      this.appendIntakeAudit(row.intake_id, 'expired', `expired at ${row.expires_at}`)
      this.emit(row.project_id, 'intake.expired', { intake_id: row.intake_id, project_id: row.project_id })
    }
    return rows.length
  }

  /**
   * ONBOARD-01 recovery/GC: remove ISOLATED staged intake blobs older than
   * `maxAgeMs` (research-onboarding.md §7: unadopted temp blobs GC after
   * 24 h). Adopted blobs already live in the real CAS (never touched);
   * session rows survive (re-uploadable) until expireIntakes collects them.
   * Returns the number of files removed.
   */
  cleanupIntakeStaged(maxAgeMs: number = ResearchKernel.INTAKE_STAGED_TTL_MS): number {
    let sessions: string[]
    try {
      sessions = readdirSync(this.intakeStagedRoot)
    } catch {
      return 0
    }
    const now = Date.now()
    let removed = 0
    for (const intakeId of sessions) {
      const dir = join(this.intakeStagedRoot, intakeId)
      let entries: string[]
      try {
        entries = readdirSync(dir)
      } catch {
        continue // raced
      }
      for (const entry of entries) {
        const full = join(dir, entry)
        let mtime: number
        try {
          mtime = statSync(full).mtimeMs
        } catch {
          continue
        }
        if (now - mtime >= maxAgeMs) {
          try {
            unlinkSync(full)
            removed += 1
          } catch { /* raced */ }
        }
      }
      try {
        if (readdirSync(dir).length === 0) rmdirSync(dir)
      } catch { /* raced */ }
    }
    return removed
  }

  // ── Runner Target registry (EXEC-ENV-02) ──

  listRunnerTargets(): RunnerTargetDescriptor[] { return this.runnerTargets.list() }
  getRunnerTarget(targetId: string): RunnerTargetDescriptor { return this.runnerTargets.get(targetId) }
  runnerTargetView(target: RunnerTargetDescriptor): ReturnType<RunnerTargetRegistry['view']> { return this.runnerTargets.view(target) }
  registerRunnerTarget(input: RunnerTargetCreateInput, createdBy = ''): RunnerTargetDescriptor {
    return this.runnerTargets.create(input, createdBy)
  }
  updateRunnerTarget(targetId: string, input: RunnerTargetUpdateInput): RunnerTargetDescriptor {
    return this.runnerTargets.update(targetId, input)
  }
  runnerTargetIdentityAuthorized(targetId: string, provided: string): boolean {
    return this.runnerTargets.identityAuthorized(targetId, provided)
  }
  observeRunnerTarget(targetId: string, input: { expected_revision: number; health: 'online' | 'offline' }): RunnerTargetDescriptor {
    return this.runnerTargets.observe(targetId, input)
  }

  // ── Canonical Settings writes (REVIEW-CONFIG-WRITE-03) ────────────────

  private projectConfigSnapshot(projectId: string): Readonly<Record<string, unknown>> | null {
    const row = this.db.prepare('SELECT * FROM projects WHERE project_id = ? AND deleted_at IS NULL')
      .get(projectId) as ProjectRow | undefined
    if (row === undefined) return null
    const project = projectFromRow(row)
    return {
      'execution.runner_profile_id': project.execution.runner_profile_id,
      'execution.runner_target_id': project.execution.runner_target_id,
      'execution.network_policy': project.execution.network_policy,
      'execution.artifact_store': project.execution.artifact_store,
      'execution.fixture_id': project.execution.fixture_id,
      'integrity.require_baseline_reproduction': project.integrity.require_baseline_reproduction,
      'integrity.require_experiment_contract': project.integrity.require_experiment_contract,
      'integrity.require_claim_evidence_links': project.integrity.require_claim_evidence_links,
      'integrity.require_clean_room_rerun': project.integrity.require_clean_room_rerun,
      'integrity.allow_automatic_public_release': project.integrity.allow_automatic_public_release,
      'integrity.require_signed_manifest': project.integrity.require_signed_manifest,
    }
  }

  /** Apply the exact project-scoped config projection to the sole business
   * authority (`projects.execution`/`projects.integrity`). The surrounding
   * ConfigWriteStore transaction owns CAS/history atomicity. */
  private applyProjectConfigChanges(input: {
    project_id: string
    changes: Readonly<Record<string, unknown>>
    actor: string
  }): Readonly<Record<string, unknown>> {
    const project = this.getProject(input.project_id)
    const executionInput: Record<string, unknown> = { ...project.execution }
    const integrityInput: Record<string, unknown> = { ...project.integrity }
    for (const [key, value] of Object.entries(input.changes)) {
      if (key.startsWith('execution.')) executionInput[key.slice('execution.'.length)] = value
      else if (key.startsWith('integrity.')) integrityInput[key.slice('integrity.'.length)] = value
      else throw new KernelError(422, 'config_scope_forbidden', `project config key ${key} is not project-owned`)
    }

    const targetChanged = Object.hasOwn(input.changes, 'execution.runner_target_id')
    if (targetChanged) {
      const targetId = String(executionInput.runner_target_id ?? '')
      const target = this.listRunnerTargets().find(candidate => candidate.target_id === targetId)
      if (target === undefined) throw new KernelError(422, 'runner_target_unknown', `runner target '${targetId}' is not registered`)
      if (!target.enabled || target.draining) {
        throw new KernelError(409, target.draining ? 'runner_target_draining' : 'runner_target_disabled',
          `runner target ${target.target_id} is not accepting new jobs`)
      }
      const requestedProfile = executionInput.runner_profile_id
      if (!Object.hasOwn(input.changes, 'execution.runner_profile_id') || requestedProfile === null) {
        const currentProfileId = project.execution.runner_profile_id === null
          ? null
          : resolveRunnerProfileId(project.execution.runner_profile_id)
        const currentProfile = currentProfileId === null ? null : getRunnerProfile(currentProfileId)
        executionInput.runner_profile_id = target.kind === 'local-process'
          ? RUNNER_PROFILE_IDS.isolatedSubprocess
          : currentProfile?.runner_mode === 'local-docker'
            ? currentProfile.profile_id
            : RUNNER_PROFILE_IDS.localDockerCpu
      }
    }

    const execution = ExecutionConfig.parse(executionInput)
    const integrity = IntegrityConfig.parse(integrityInput)
    if (targetChanged || Object.hasOwn(input.changes, 'execution.runner_profile_id')) {
      const target = this.getRunnerTarget(execution.runner_target_id)
      if (execution.runner_profile_id !== null) {
        const profileId = resolveRunnerProfileId(execution.runner_profile_id)
        const profile = profileId === null ? null : getRunnerProfile(profileId)
        if (profile === null || !profile.enabled) {
          throw new KernelError(422, 'runner_profile_unknown', `runner profile '${execution.runner_profile_id}' is unavailable`)
        }
        const compatible = target.kind === 'local-process'
          ? profile.runner_mode === 'isolated-subprocess'
          : profile.runner_mode === 'local-docker'
        if (!compatible) {
          throw new KernelError(422, 'runner_profile_target_mismatch',
            `runner profile '${profile.profile_id}' is incompatible with target '${target.target_id}'`)
        }
        execution.runner_profile_id = profile.profile_id
      }
    }

    const changed = canonicalJsonDeep(execution) !== canonicalJsonDeep(project.execution)
      || canonicalJsonDeep(integrity) !== canonicalJsonDeep(project.integrity)
    if (changed) {
      const now = nowIso()
      const keys = Object.keys(input.changes).sort()
      const history = [...project.history, `settings config by ${input.actor}: ${keys.join(', ')}`]
      const result = this.db.prepare(
        `UPDATE projects SET execution = ?, integrity = ?, revision = revision + 1, updated_at = ?, history = ?
         WHERE project_id = ? AND revision = ? AND deleted_at IS NULL`,
      ).run(
        JSON.stringify(execution), JSON.stringify(integrity), now, JSON.stringify(history),
        project.project_id, project.revision,
      )
      if (Number(result.changes) !== 1) throw new KernelError(409, 'revision_conflict', 'project changed during Settings update')
      const updated = this.getProject(project.project_id)
      this.emit(project.project_id, 'project.execution.configured', {
        project_id: project.project_id,
        runner_target_id: updated.execution.runner_target_id,
        runner_profile_id: updated.execution.runner_profile_id,
        revision: updated.revision,
        config_keys: keys,
      })
    }
    return this.projectConfigSnapshot(project.project_id)!
  }

  private writeOcrSettings(operation: OcrMineruSettingsOperation, actor: string): unknown {
    const provider = operation.provider.action === 'create'
      ? this.registerProvider({ ...operation.provider.input, created_by: actor })
      : this.updateProvider(operation.provider.provider_id, {
          ...operation.provider.patch,
          expected_revision: operation.provider.expected_revision,
          updated_by: actor,
        })
    const binding = operation.binding === undefined
      ? null
      : this.setProjectModelBinding(operation.binding.project_id, {
          purpose: 'ocr',
          provider_id: provider.provider_id,
          model_id: operation.binding.model_id,
          expected_provider_revision: operation.binding.expected_provider_revision,
          expected_revision: operation.binding.expected_revision,
          updated_by: actor,
        })
    return { provider: this.providerView(provider), binding }
  }

  private writeRunnerTargetSettings(operation: RunnerTargetSettingsOperation, actor: string): unknown {
    const target = operation.action === 'create'
      ? this.registerRunnerTarget(operation.input, actor)
      : this.updateRunnerTarget(operation.target_id, operation.patch)
    return this.runnerTargetView(target)
  }

  private configWriteCall<T>(work: () => T): T {
    try { return work() } catch (error) {
      if (error instanceof ConfigWriteStoreError) throw new KernelError(error.status, error.code, error.message, error.key)
      throw error
    }
  }

  configLayer(scope: ConfigWriteScope, scopeId: string): ConfigLayerSafeView {
    return this.configWriteCall(() => this.configWrites.readLayer(scope, scopeId))
  }

  configRevisions(scope: ConfigWriteScope, scopeId: string): ReturnType<ConfigWriteStore['listRevisions']> {
    return this.configWriteCall(() => this.configWrites.listRevisions(scope, scopeId))
  }

  configEffective(projectId?: string): ConfigEffectiveSafeView {
    return this.configWriteCall(() => this.configWrites.effective({ projectId }))
  }

  writeSettingsTransaction(raw: unknown, actor: string): SettingsWriteTransactionReceipt {
    return this.configWriteCall(() => this.settingsWrites.execute(raw, actor))
  }

  // ── Model Provider registry (MODEL-01, init-grill-upload-models.md §4) ──

  private providerModels(providerId: string): ModelProviderModelRow[] {
    return this.db.prepare('SELECT * FROM model_provider_models WHERE provider_id = ? ORDER BY model_id').all(providerId) as unknown as ModelProviderModelRow[]
  }

  private providerFromRow(row: ModelProviderRow): ProviderDescriptor {
    const models = this.providerModels(row.provider_id)
    let rawCredential: unknown
    try { rawCredential = JSON.parse(row.credential_json) } catch {
      throw new KernelError(500, 'provider_credential_corrupt', `model provider ${row.provider_id} has invalid credential metadata`)
    }
    let credential: SecretRef | undefined
    if (rawCredential !== null) {
      const parsed = SecretRefSchema.safeParse(rawCredential)
      if (!parsed.success) {
        throw new KernelError(500, 'provider_credential_corrupt', `model provider ${row.provider_id} has invalid credential metadata`)
      }
      credential = parsed.data
    }
    return {
      provider_id: row.provider_id,
      display_name: row.display_name,
      kind: row.kind as ProviderDescriptor['kind'],
      base_url: row.base_url,
      enabled: row.enabled === 1,
      capabilities: jsonParse(row.capabilities, ['chat']) as ProviderDescriptor['capabilities'],
      models: models.map(m => ({
        model_id: m.model_id,
        display_name: m.display_name ?? undefined,
        capabilities: jsonParse(m.capabilities, ['chat']) as ProviderDescriptor['models'][number]['capabilities'],
        revision: m.model_revision,
      })),
      revision: row.revision,
      ...(credential === undefined ? {} : { credential }),
      created_by: row.created_by,
      created_at: row.created_at,
      updated_at: row.updated_at,
    }
  }

  /** MODEL-01: opaque provider lookup（404 provider_unknown）。 */
  getProvider(providerId: string): ProviderDescriptor {
    const row = this.db.prepare('SELECT * FROM model_providers WHERE provider_id = ?').get(providerId) as ModelProviderRow | undefined
    if (row === undefined) throw new KernelError(404, 'provider_unknown', `model provider ${providerId} is not registered`)
    return this.providerFromRow(row)
  }

  /** MODEL-01: instance/global provider list（浏览器响应经 redacted 脱敏）。 */
  listProviders(): ProviderDescriptor[] {
    const rows = this.db.prepare('SELECT * FROM model_providers ORDER BY provider_id').all() as unknown as ModelProviderRow[]
    return rows.map(row => this.providerFromRow(row))
  }

  /**
   * MODEL-01: 浏览器响应形态 —— credential 只含 metadata + available 布尔，
   * 绝不返回 secret value（本 kernel 从不存储 value）。
   */
  providerView(provider: ProviderDescriptor): ReturnType<typeof providerRedacted> {
    return providerRedacted(provider, this.secretRoot)
  }

  /** MODEL-01: SecretRef 可用性（file scheme 存在性检查；keyring/vault false）。 */
  secretRefAvailable(ref: SecretRef): boolean {
    return secretRefAvailable(ref, this.secretRoot)
  }

  /** MODEL-01: canonical config hash（绑定/运行中任务快照 revision+hash）。 */
  providerHash(provider: ProviderDescriptor): string {
    return providerConfigHash(provider)
  }

  /**
   * MODEL-01: register an instance/global Provider（api-contracts.md §19
   * model-providers）。SecretRef 严格 schema（value/token/password 字段
   * → 422 secret_value_forbidden）；base URL 服务端 SSRF/scheme 校验
   * （非法 scheme/userinfo/私有网段/未 allowlist 主机 fail closed）。
   */
  registerProvider(input: ProviderCreateInput & { created_by?: string }): ProviderDescriptor {
    if (input.credential !== undefined) validateSecretRefInput(input.credential)
    validateProviderBaseUrl(input.base_url, this.providerUrlAllowlist)
    const existing = this.db.prepare('SELECT provider_id FROM model_providers WHERE provider_id = ?').get(input.provider_id)
    if (existing !== undefined) {
      throw new KernelError(409, 'provider_exists', `model provider ${input.provider_id} already exists`)
    }
    const models = parseProviderModels(input.models)
    for (const model of models) {
      for (const capability of model.capabilities) {
        if (!input.capabilities.includes(capability)) {
          throw new KernelError(422, 'provider_capability_missing',
            `model ${model.model_id} declares capability '${capability}' which the provider does not`)
        }
      }
    }
    const now = nowIso()
    const descriptor: ProviderDescriptor = {
      provider_id: input.provider_id,
      display_name: input.display_name,
      kind: input.kind ?? 'custom',
      base_url: input.base_url,
      enabled: input.enabled ?? true,
      capabilities: input.capabilities,
      models,
      revision: 1,
      credential: input.credential,
      created_by: input.created_by ?? '',
      created_at: now,
      updated_at: now,
    }
    validateBuiltInProviderContract(descriptor)
    return withTransaction(this.db, () => {
      this.db.prepare(
        `INSERT INTO model_providers (provider_id, display_name, kind, base_url, enabled, capabilities, credential_json, revision, created_by, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        descriptor.provider_id, descriptor.display_name, descriptor.kind, descriptor.base_url,
        descriptor.enabled ? 1 : 0, JSON.stringify(descriptor.capabilities), JSON.stringify(descriptor.credential ?? null),
        descriptor.revision, descriptor.created_by, descriptor.created_at, descriptor.updated_at,
      )
      for (const model of descriptor.models) {
        this.db.prepare(
          'INSERT INTO model_provider_models (provider_id, model_id, display_name, capabilities, model_revision) VALUES (?, ?, ?, ?, ?)',
        ).run(descriptor.provider_id, model.model_id, model.display_name ?? null, JSON.stringify(model.capabilities), model.revision)
      }
      return descriptor
    })
  }

  /**
   * MODEL-01: Provider 修改使用 revision CAS（expected_revision 不匹配 →
   * 409 provider_revision_conflict）。修改不影响已快照的运行中任务。
   */
  updateProvider(providerId: string, input: ProviderUpdateInput & { updated_by?: string }): ProviderDescriptor {
    const current = this.getProvider(providerId)
    if (input.expected_revision !== current.revision) {
      throw new KernelError(409, 'provider_revision_conflict',
        `provider ${providerId} revision ${current.revision} does not match expected ${input.expected_revision}`)
    }
    const next: ProviderDescriptor = {
      ...current,
      display_name: input.display_name ?? current.display_name,
      kind: input.kind ?? current.kind,
      base_url: input.base_url ?? current.base_url,
      enabled: input.enabled ?? current.enabled,
      capabilities: input.capabilities ?? current.capabilities,
      models: input.models !== undefined ? parseProviderModels(input.models) : current.models,
      ...(input.credential === null
        ? { credential: undefined }
        : { credential: input.credential ?? current.credential }),
    }
    if (next.credential !== undefined) validateSecretRefInput(next.credential)
    validateProviderBaseUrl(next.base_url, this.providerUrlAllowlist)
    for (const model of next.models) {
      for (const capability of model.capabilities) {
        if (!next.capabilities.includes(capability)) {
          throw new KernelError(422, 'provider_capability_missing',
            `model ${model.model_id} declares capability '${capability}' which the provider does not`)
        }
      }
    }
    validateBuiltInProviderContract(next)
    next.revision = current.revision + 1
    next.updated_at = nowIso()
    return withTransaction(this.db, () => {
      this.db.prepare(
        `UPDATE model_providers SET display_name = ?, kind = ?, base_url = ?, enabled = ?, capabilities = ?, credential_json = ?, revision = ?, updated_at = ? WHERE provider_id = ?`,
      ).run(
        next.display_name, next.kind, next.base_url, next.enabled ? 1 : 0, JSON.stringify(next.capabilities),
        JSON.stringify(next.credential ?? null), next.revision, next.updated_at, providerId,
      )
      this.db.prepare('DELETE FROM model_provider_models WHERE provider_id = ?').run(providerId)
      for (const model of next.models) {
        this.db.prepare(
          'INSERT INTO model_provider_models (provider_id, model_id, display_name, capabilities, model_revision) VALUES (?, ?, ?, ?, ?)',
        ).run(providerId, model.model_id, model.display_name ?? null, JSON.stringify(model.capabilities), model.revision)
      }
      return next
    })
  }

  /**
   * MODEL-01: delete（revision CAS）。引用该 provider 的项目绑定被清除
   * （绑定是软引用快照，provider 删除后失效 —— 显式、可审计）。
   */
  deleteProvider(providerId: string, expectedRevision: number): void {
    const current = this.getProvider(providerId)
    if (expectedRevision !== current.revision) {
      throw new KernelError(409, 'provider_revision_conflict',
        `provider ${providerId} revision ${current.revision} does not match expected ${expectedRevision}`)
    }
    withTransaction(this.db, () => {
      this.db.prepare('DELETE FROM model_provider_models WHERE provider_id = ?').run(providerId)
      this.db.prepare('DELETE FROM model_providers WHERE provider_id = ?').run(providerId)
      // Clear bindings that referenced the deleted provider (fail closed:
      // a binding to a missing provider must never be served as valid).
      this.db.prepare(
        `UPDATE projects SET binding_provider_id = NULL, binding_model_id = NULL, binding_purpose = NULL,
           binding_provider_revision = NULL, binding_config_hash = NULL, binding_revision = 0,
           binding_updated_by = '', binding_updated_at = NULL
         WHERE binding_provider_id = ?`,
      ).run(providerId)
    })
  }

  /** MODEL-01: 项目 Model Binding 读取（无绑定 → null）。 */
  getProjectModelBinding(projectId: string): ProjectModelBinding | null {
    const project = this.getProject(projectId)
    const row = this.db.prepare(
      'SELECT binding_provider_id, binding_model_id, binding_purpose, binding_provider_revision, binding_config_hash, binding_revision, binding_updated_by, binding_updated_at FROM projects WHERE project_id = ?',
    ).get(projectId) as {
      binding_provider_id: string | null
      binding_model_id: string | null
      binding_purpose: string | null
      binding_provider_revision: number | null
      binding_config_hash: string | null
      binding_revision: number
      binding_updated_by: string | null
      binding_updated_at: string | null
    } | undefined
    if (row === undefined || row.binding_provider_id === null || row.binding_provider_id === '') return null
    return {
      project_id: projectId,
      purpose: row.binding_purpose as BindingPurpose,
      provider_id: row.binding_provider_id,
      model_id: row.binding_model_id ?? '',
      provider_revision: row.binding_provider_revision ?? 0,
      provider_config_hash: row.binding_config_hash ?? '',
      revision: row.binding_revision,
      updated_by: row.binding_updated_by ?? '',
      updated_at: row.binding_updated_at ?? project.updated_at,
    }
  }

  /**
   * MODEL-01: 项目只提交 opaque provider/model ID（api-contracts.md §19
   * model-bindings）。校验 provider 存在且 enabled、模型在 provider 目录、
   * provider/model 声明匹配 purpose 的能力；快照 provider revision + config
   * hash（运行中任务固定创建时 revision/hash）。绑定自身 revision CAS。
   */
  setProjectModelBinding(projectId: string, input: ProjectModelBindingInput & { updated_by?: string }): ProjectModelBinding {
    this.getProject(projectId)
    const provider = this.getProvider(input.provider_id)
    if (!provider.enabled) {
      throw new KernelError(422, 'provider_disabled', `model provider ${input.provider_id} is disabled`)
    }
    const model = provider.models.find(m => m.model_id === input.model_id)
    if (model === undefined) {
      throw new KernelError(422, 'model_unknown', `model ${input.model_id} is not in provider ${input.provider_id} catalog`)
    }
    if (input.expected_provider_revision !== undefined && input.expected_provider_revision !== provider.revision) {
      throw new KernelError(409, 'provider_revision_conflict',
        `provider ${provider.provider_id} revision ${provider.revision} does not match expected ${input.expected_provider_revision}`)
    }
    if (provider.kind === 'mineru' && model.model_id !== 'flash' && provider.credential === undefined) {
      throw new KernelError(422, 'provider_credential_required',
        `MinerU ${model.model_id} requires a configured SecretRef`)
    }
    const capability = input.purpose
    if (!model.capabilities.includes(capability)) {
      throw new KernelError(422, 'provider_capability_missing',
        `model ${input.model_id} in provider ${input.provider_id} does not declare capability '${capability}'`)
    }
    const existing = this.getProjectModelBinding(projectId)
    if (input.expected_revision !== undefined && input.expected_revision !== (existing?.revision ?? 0)) {
      throw new KernelError(409, 'binding_revision_conflict',
        `project ${projectId} model binding revision ${existing?.revision ?? 0} does not match expected ${input.expected_revision}`)
    }
    const now = nowIso()
    const binding: ProjectModelBinding = {
      project_id: projectId,
      purpose: input.purpose,
      provider_id: input.provider_id,
      model_id: input.model_id,
      provider_revision: provider.revision,
      provider_config_hash: this.providerHash(provider),
      revision: (existing?.revision ?? 0) + 1,
      updated_by: input.updated_by ?? '',
      updated_at: now,
    }
    this.db.prepare(
      `UPDATE projects SET binding_provider_id = ?, binding_model_id = ?, binding_purpose = ?,
         binding_provider_revision = ?, binding_config_hash = ?, binding_revision = ?,
         binding_updated_by = ?, binding_updated_at = ? WHERE project_id = ?`,
    ).run(
      binding.provider_id, binding.model_id, binding.purpose, binding.provider_revision,
      binding.provider_config_hash, binding.revision, binding.updated_by, binding.updated_at, projectId,
    )
    return binding
  }

  // ── REVIEW-OCR-03: intake-scoped OCR lifecycle ─────────────────────────

  private ocrStoreCall<T>(work: () => T): T {
    try { return work() } catch (error) {
      if (error instanceof OcrStoreError) throw new KernelError(error.status, error.code, error.message)
      throw error
    }
  }

  /**
   * Create a durable OCR request from one exact, clean Intake artifact and
   * the project's exact OCR binding. Provider/model/config pins are copied
   * into the request; no provider or model fallback exists.
   */
  createOcrRequest(intakeId: string, raw: OcrRequestCreateInputValue, idempotencyKey: string): OcrRequest {
    if (idempotencyKey.trim() === '') throw new KernelError(422, 'idempotency_key_required', 'OCR request requires an Idempotency-Key')
    const input = OcrRequestCreateInput.parse(raw)
    const row = this.getIntakeSessionRow(intakeId)
    const session = this.intakeSessionFromRow(row)
    if (row.project_id === null) throw new KernelError(422, 'ocr_project_required', 'OCR request requires a project-scoped intake')
    const pages = [...new Set(input.pages)].sort((a, b) => a - b)
    const requestSha256 = sha256Hex(canonicalJsonDeep({
      project_id: row.project_id, intake_id: intakeId, source_artifact_id: input.source_artifact_id,
      provider_id: input.provider_id, model_id: input.model_id, pages, language: input.language,
    }))
    const replay = this.ocr.findByIdempotency(idempotencyKey)
    if (replay !== null) {
      if (replay.request_sha256 !== requestSha256) throw new KernelError(409, 'idempotency_conflict', 'OCR idempotency key was used for a different request')
      return replay
    }
    this.assertIntakeMutable(session)
    this.assertIntakeNotExpired(session)
    const artifact = this.db.prepare(
      'SELECT artifact_id, sha256, media_type, file_name, quarantine FROM intake_artifacts WHERE intake_id = ? AND artifact_id = ?',
    ).get(intakeId, input.source_artifact_id) as {
      artifact_id: string; sha256: string; media_type: string; file_name: string; quarantine: string
    } | undefined
    if (artifact === undefined) throw new KernelError(404, 'intake_artifact_not_found', 'OCR source artifact was not found in this intake')
    if (artifact.quarantine !== 'clean') throw new KernelError(422, 'ocr_source_not_clean', 'OCR source artifact must pass the intake scan')
    const binding = this.getProjectModelBinding(row.project_id)
    if (binding === null || binding.purpose !== 'ocr') throw new KernelError(422, 'ocr_binding_required', 'project has no OCR model binding')
    if (binding.provider_id !== input.provider_id || binding.model_id !== input.model_id) {
      throw new KernelError(409, 'ocr_binding_mismatch', 'requested provider/model does not match the project OCR binding')
    }
    const provider = this.getProvider(binding.provider_id)
    if (!provider.enabled) throw new KernelError(422, 'provider_disabled', 'bound OCR provider is disabled')
    const model = provider.models.find(candidate => candidate.model_id === binding.model_id)
    if (model === undefined || !model.capabilities.includes('ocr')) throw new KernelError(422, 'provider_capability_missing', 'bound model does not provide OCR')
    const currentHash = this.providerHash(provider)
    if (provider.revision !== binding.provider_revision || currentHash !== binding.provider_config_hash) {
      throw new KernelError(409, 'ocr_binding_stale', 'OCR binding must be refreshed after provider configuration changes')
    }
    if (provider.kind === 'mineru' && model.model_id !== 'flash' && (provider.credential === undefined || !this.secretRefAvailable(provider.credential))) {
      throw new KernelError(422, 'provider_credential_unavailable', 'bound MinerU model requires an available server-side SecretRef')
    }
    return this.ocrStoreCall(() => this.ocr.create({
      request_id: randomId('ocr'), project_id: row.project_id!, intake_id: intakeId,
      source_artifact_id: artifact.artifact_id, source_sha256: artifact.sha256,
      source_media_type: artifact.media_type, source_file_name: artifact.file_name,
      provider_id: binding.provider_id, model_id: binding.model_id, provider_revision: binding.provider_revision,
      provider_config_sha256: binding.provider_config_hash, binding_revision: binding.revision,
      pages, language: input.language, idempotency_key: idempotencyKey, request_sha256: requestSha256,
    }))
  }

  getOcrRequest(intakeId: string, requestId: string): OcrRequest {
    this.getIntakeSessionRow(intakeId)
    return this.ocrStoreCall(() => this.ocr.get(intakeId, requestId))
  }

  cancelOcrRequest(intakeId: string, requestId: string): OcrRequest {
    this.getIntakeSessionRow(intakeId)
    return this.ocrStoreCall(() => this.ocr.cancel(intakeId, requestId))
  }

  getOcrResult(intakeId: string, requestId: string): OcrResult | null {
    this.getIntakeSessionRow(intakeId)
    return this.ocrStoreCall(() => this.ocr.result(intakeId, requestId))
  }

  readOcrRequest(intakeId: string, requestId: string): OcrRequestView {
    return { request: this.getOcrRequest(intakeId, requestId), result: this.getOcrResult(intakeId, requestId) }
  }

  /** Worker-only lease-free single-consumer claim. SQLite serializes claims;
   * a restart requeues any `running` request in OcrStore construction. */
  claimNextOcrRequest(): OcrRequest | null {
    return this.ocrStoreCall(() => this.ocr.claimNext())
  }

  /** Load and re-hash the exact pinned Intake source, never a newer path. */
  loadOcrSource(request: OcrRequest): OcrSourceBytes {
    const row = this.db.prepare(
      'SELECT sha256, media_type, file_name, size_bytes FROM intake_artifacts WHERE intake_id = ? AND artifact_id = ?',
    ).get(request.intake_id, request.source_artifact_id) as { sha256: string; media_type: string; file_name: string; size_bytes: number } | undefined
    if (row === undefined || row.sha256 !== request.source_sha256) throw new KernelError(422, 'ocr_source_unavailable', 'pinned OCR source no longer matches its request')
    let content: Buffer
    try { content = readFileSync(this.intakeStagedPath(request.intake_id, request.source_sha256)) } catch {
      throw new KernelError(422, 'ocr_source_unavailable', 'pinned OCR source bytes are unavailable')
    }
    if (content.byteLength !== row.size_bytes || createHash('sha256').update(content).digest('hex') !== request.source_sha256) {
      throw new KernelError(422, 'ocr_source_unavailable', 'pinned OCR source bytes failed integrity verification')
    }
    return { artifact_id: request.source_artifact_id, sha256: request.source_sha256, media_type: row.media_type, file_name: row.file_name, content }
  }

  completeOcrRequest(requestId: string, markdown: string, observations: OcrNormalizedObservation[]): OcrRequest {
    return this.ocrStoreCall(() => this.ocr.complete(requestId, markdown, observations))
  }

  failOcrRequest(requestId: string, code: OcrSafeError['code']): OcrRequest {
    return this.ocrStoreCall(() => this.ocr.fail(requestId, code))
  }

  // ── CHUNK-01: batch chunked upload sessions (init-grill-upload-models.md §3) ──

  private uploadSessionFromRow(row: UploadSessionRow): UploadSession {
    return {
      upload_id: row.upload_id,
      intake_id: row.intake_id,
      project_id: row.project_id,
      file_name: row.file_name,
      media_type: row.media_type,
      expected_size: row.expected_size,
      expected_sha256: row.expected_sha256,
      chunk_size: row.chunk_size,
      committed_offset: row.committed_offset,
      status: row.status as UploadSession['status'],
      finalized_sha256: row.finalized_sha256,
      created_by: row.created_by_principal,
      created_at: row.created_at,
      updated_at: row.updated_at,
      expires_at: row.expires_at,
    }
  }

  private getUploadSessionRow(uploadId: string, intakeId?: string): UploadSessionRow {
    const row = intakeId === undefined
      ? this.db.prepare('SELECT * FROM upload_sessions WHERE upload_id = ?').get(uploadId) as UploadSessionRow | undefined
      : this.db.prepare('SELECT * FROM upload_sessions WHERE upload_id = ? AND intake_id = ?').get(uploadId, intakeId) as UploadSessionRow | undefined
    if (row === undefined) {
      throw new KernelError(404, 'upload_session_not_found', `upload session ${uploadId} not found${intakeId === undefined ? '' : ` in intake ${intakeId}`}`)
    }
    if (row.project_id !== '') this.getProject(row.project_id)
    return row
  }

  private uploadSessionPartPath(intakeId: string, uploadId: string): string {
    return uploadStagedPath(this.intakeStagedRoot, intakeId, uploadId)
  }

  private assertChatScopeOpen(projectId: string, scopeId: string | undefined): void {
    if (scopeId === undefined) return
    if (scopeId.length < 1 || scopeId.length > 160 || !/^[A-Za-z0-9._:-]+$/.test(scopeId)) {
      throw new KernelError(422, 'invalid_chat_scope', 'owner_scope_id must be 1-160 safe identifier characters')
    }
    const closed = this.db.prepare('SELECT 1 AS found FROM chat_scope_tombstones WHERE project_id = ? AND scope_id = ?')
      .get(projectId, scopeId) as { found: number } | undefined
    if (closed !== undefined) {
      throw new KernelError(409, 'chat_scope_closed', `Chat scope ${scopeId} is closed`)
    }
  }

  /** Durable exact-session close linearization point. New Intake/upload work
   * is rejected after this transaction; already-known stages are compensated
   * through the same idempotent abort cleanup ledger. */
  tombstoneChatScope(projectId: string, scopeId: string): { ok: true; aborted_uploads: number } {
    if (scopeId.length < 1 || scopeId.length > 160 || !/^[A-Za-z0-9._:-]+$/.test(scopeId)) {
      throw new KernelError(422, 'invalid_chat_scope', 'scope_id must be 1-160 safe identifier characters')
    }
    const uploads = withTransaction(this.db, () => {
      this.getProject(projectId)
      this.db.prepare(
        'INSERT OR IGNORE INTO chat_scope_tombstones (project_id, scope_id, closed_at) VALUES (?, ?, ?)',
      ).run(projectId, scopeId, nowIso())
      const rows = this.db.prepare(
        `SELECT u.* FROM upload_sessions u
         JOIN intake_sessions i ON i.intake_id = u.intake_id
         WHERE u.project_id = ? AND (u.owner_scope_id = ? OR i.owner_scope_id = ?)
           AND u.status IN ('open','finalized','aborted')`,
      ).all(projectId, scopeId, scopeId) as unknown as UploadSessionRow[]
      for (const row of rows) this.markUploadAbortedInTransaction(row.intake_id, row.upload_id)
      return rows.map(row => ({ upload_id: row.upload_id, intake_id: row.intake_id }))
    })
    // Filesystem cleanup follows commit, but every target is already a
    // durable aborted ledger. A crash here is recovered by startup sweep.
    for (const upload of uploads) this.cleanupAbortedUpload(upload.intake_id, upload.upload_id)
    return { ok: true, aborted_uploads: uploads.length }
  }

  /** ENOENT is successful idempotent cleanup. Every other unlink failure
   * leaves the aborted upload row as a retryable cleanup ledger. */
  private removeUploadStageFile(intakeId: string, uploadId: string): boolean {
    try {
      unlinkSync(this.uploadSessionPartPath(intakeId, uploadId))
      return true
    } catch (error) {
      return (error as { code?: string }).code === 'ENOENT'
    }
  }

  private removeIntakeStageFile(intakeId: string, sha256: string): boolean {
    try {
      unlinkSync(this.intakeStagedPath(intakeId, sha256))
      return true
    } catch (error) {
      return (error as { code?: string }).code === 'ENOENT'
    }
  }

  /** Convert one open/finalized upload to a durable cleanup ledger. Caller
   * must hold BEGIN IMMEDIATE. Repeated calls preserve pending ownership. */
  private markUploadAbortedInTransaction(intakeId: string, uploadId: string): UploadSessionRow | undefined {
    const row = this.db.prepare('SELECT * FROM upload_sessions WHERE upload_id = ? AND intake_id = ?')
      .get(uploadId, intakeId) as UploadSessionRow | undefined
    if (row === undefined) return undefined
    this.db.prepare('DELETE FROM upload_chunks WHERE upload_id = ?').run(uploadId)
    let ownsArtifact = row.owns_artifact
    if (row.status === 'finalized' && row.owns_artifact === 1 && row.finalized_sha256 !== null) {
      // Do not transfer to a session whose own scope is already closed.
      const successor = this.db.prepare(
        `SELECT u.upload_id FROM upload_sessions u
         LEFT JOIN chat_scope_tombstones t
           ON t.project_id = u.project_id AND t.scope_id = u.owner_scope_id
         WHERE u.intake_id = ? AND u.upload_id != ? AND u.status = 'finalized'
           AND u.finalized_sha256 = ? AND (u.owner_scope_id IS NULL OR t.scope_id IS NULL)
         ORDER BY u.created_at LIMIT 1`,
      ).get(intakeId, uploadId, row.finalized_sha256) as { upload_id: string } | undefined
      if (successor !== undefined) {
        this.db.prepare('UPDATE upload_sessions SET owns_artifact = 1 WHERE upload_id = ?').run(successor.upload_id)
        ownsArtifact = 0
      } else {
        const artifact = this.db.prepare(
          'SELECT quarantine FROM intake_artifacts WHERE intake_id = ? AND sha256 = ?',
        ).get(intakeId, row.finalized_sha256) as { quarantine: string } | undefined
        if (artifact?.quarantine === 'staged') {
          this.db.prepare(
            "DELETE FROM intake_artifacts WHERE intake_id = ? AND sha256 = ? AND quarantine = 'staged'",
          ).run(intakeId, row.finalized_sha256)
          ownsArtifact = 1
        } else if (artifact !== undefined) {
          // Scanned/quarantined/accepted material has independent authority.
          ownsArtifact = 0
        }
        // A missing row keeps ownsArtifact=1: the file may still exist after
        // a prior crash and must remain covered by the cleanup ledger.
      }
    } else if (row.status !== 'aborted') {
      ownsArtifact = 0
    }
    this.db.prepare("UPDATE upload_sessions SET status = 'aborted', owns_artifact = ?, updated_at = ? WHERE upload_id = ?")
      .run(ownsArtifact, nowIso(), uploadId)
    return { ...row, status: 'aborted', owns_artifact: ownsArtifact }
  }

  /** Consume one durable aborted ledger under the same writer lock used by
   * direct staging. A newly recreated same-SHA artifact therefore wins and
   * cannot be unlinked by an older cleanup generation. */
  private cleanupAbortedUpload(intakeId: string, uploadId: string): boolean {
    return withTransaction(this.db, () => {
      const row = this.db.prepare(
        "SELECT * FROM upload_sessions WHERE upload_id = ? AND intake_id = ? AND status = 'aborted'",
      ).get(uploadId, intakeId) as UploadSessionRow | undefined
      if (row === undefined) return false
      const partRemoved = this.removeUploadStageFile(intakeId, uploadId)
      let artifactRemoved = true
      if (row.owns_artifact === 1 && row.finalized_sha256 !== null) {
        const liveArtifact = this.db.prepare(
          'SELECT 1 AS found FROM intake_artifacts WHERE intake_id = ? AND sha256 = ?',
        ).get(intakeId, row.finalized_sha256) as { found: number } | undefined
        artifactRemoved = liveArtifact !== undefined
          ? true
          : this.removeIntakeStageFile(intakeId, row.finalized_sha256)
      }
      if (!partRemoved || !artifactRemoved) return false
      this.db.prepare("DELETE FROM upload_sessions WHERE upload_id = ? AND status = 'aborted'").run(uploadId)
      return true
    })
  }

  /** CHUNK-01: open upload sessions of one intake（断线/刷新后续传查询）。 */
  listUploadSessions(intakeId: string): UploadSessionView[] {
    const intake = this.getIntakeSessionRow(intakeId)
    if (intake.project_id !== null) this.getProject(intake.project_id)
    const rows = this.db.prepare('SELECT * FROM upload_sessions WHERE intake_id = ? ORDER BY created_at').all(intakeId) as unknown as UploadSessionRow[]
    return rows.map(row => ({
      upload_id: row.upload_id,
      intake_id: row.intake_id,
      file_name: row.file_name,
      media_type: row.media_type,
      expected_size: row.expected_size,
      expected_sha256: row.expected_sha256,
      chunk_size: row.chunk_size,
      committed_offset: row.committed_offset,
      status: row.status as UploadSessionView['status'],
      finalized_sha256: row.finalized_sha256,
      expires_at: row.expires_at,
      created_at: row.created_at,
      updated_at: row.updated_at,
    }))
  }

  /**
   * CHUNK-01 begin: 事务性创建上传会话并预留配额（默认单 Intake 2 GiB、
   * 硬上限 10 GiB；超限 413 upload_quota_exceeded）。会话绑定 intake、
   * project、Principal、文件名、media type、expected size/hash、chunk
   * 上限与 expiry（≥24h）。扫描前字节只写入隔离 intake staging。
   */
  beginUploadSession(intakeId: string, input: UploadSessionBeginInput & { principal_id?: string; owner_scope_id?: string }): UploadSession {
    validateUploadFileName(input.file_name)
    const chunkSize = Math.max(1, Math.min(
      input.chunk_size ?? this.intakeChunkSizeBytes,
      this.intakeChunkSizeBytes,
    ))
    return withTransaction(this.db, () => {
      // Project/intake liveness, scope admission and quota reservation share
      // one BEGIN IMMEDIATE. Concurrent delete/close/begin operations cannot
      // all validate stale state and then insert after authority changed.
      const row = this.getIntakeSessionRow(intakeId)
      if (row.project_id !== null) this.getProject(row.project_id)
      const session = this.intakeSessionFromRow(row)
      this.assertIntakeMutable(session)
      this.assertIntakeNotExpired(session)
      const effectiveOwnerScope = input.owner_scope_id ?? row.owner_scope_id ?? undefined
      if (row.project_id !== null) {
        this.assertChatScopeOpen(row.project_id, row.owner_scope_id ?? undefined)
        if (input.owner_scope_id !== undefined && row.owner_scope_id !== null && input.owner_scope_id !== row.owner_scope_id) {
          throw new KernelError(409, 'chat_scope_mismatch', 'upload owner_scope_id does not match the Chat-owned Intake')
        }
      }
      this.assertChatScopeOpen(row.project_id ?? '', effectiveOwnerScope)
      const openSessions = this.db.prepare(
        "SELECT expected_size FROM upload_sessions WHERE intake_id = ? AND status = 'open'",
      ).all(intakeId) as unknown as Array<{ expected_size: number }>
      const stagedArtifacts = this.db.prepare(
        "SELECT size_bytes FROM intake_artifacts WHERE intake_id = ? AND quarantine = 'staged'",
      ).all(intakeId) as unknown as Array<{ size_bytes: number }>
      const quota = intakeQuotaCheck({
        quotaBytes: this.intakeQuotaBytes,
        openSessions,
        stagedArtifacts,
        additionalBytes: input.expected_size,
      })
      if (quota.exceeded) {
        throw new KernelError(413, 'upload_quota_exceeded',
          `intake upload quota exceeded: ${quota.used + input.expected_size} bytes > ${quota.limit} (per-Intake reserved quota)`)
      }
      const now = nowIso()
      const upload: UploadSession = {
        upload_id: randomId('upl'),
        intake_id: intakeId,
        project_id: row.project_id ?? '',
        file_name: input.file_name,
        media_type: input.media_type ?? 'application/octet-stream',
        expected_size: input.expected_size,
        expected_sha256: input.expected_sha256 ?? null,
        chunk_size: chunkSize,
        committed_offset: 0,
        status: 'open',
        finalized_sha256: null,
        created_by: input.principal_id ?? '',
        created_at: now,
        updated_at: now,
        expires_at: new Date(Date.now() + ResearchKernel.CHUNKED_UPLOAD_SESSION_TTL_MS).toISOString(),
      }
      try {
        mkdirMode(join(this.intakeStagedRoot, intakeId), 0o700)
      } catch { /* already exists */ }
      this.db.prepare(
        `INSERT INTO upload_sessions (upload_id, intake_id, project_id, file_name, media_type, expected_size, expected_sha256,
           chunk_size, committed_offset, status, created_by_principal, owner_scope_id, created_at, updated_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        upload.upload_id, upload.intake_id, upload.project_id, upload.file_name, upload.media_type,
        upload.expected_size, upload.expected_sha256, upload.chunk_size, 0, 'open',
        upload.created_by, effectiveOwnerScope ?? null, upload.created_at, upload.updated_at, upload.expires_at,
      )
      return upload
    })
  }

  /**
   * CHUNK-01 append: `Content-Range: bytes <start>-<end>[/<total>]` +
   * `X-Chunk-SHA256`，body 为原始字节。`start == committed_offset` 才追加；
   * 旧范围同字节/hash 重放成功（replayed=true）；gap、overlap 不同内容或
   * total 不同返回 409；hash 不匹配 422；chunk 超上限 413。
   */
  appendUploadChunk(intakeId: string, uploadId: string, input: {
    bytes: Uint8Array
    contentRange: string
    chunkSha256: string
  }): ChunkAppendResult {
    const row = this.getUploadSessionRow(uploadId, intakeId)
    this.assertChatScopeOpen(row.project_id, row.owner_scope_id ?? undefined)
    const intakeOwner = this.getIntakeSessionRow(intakeId, row.project_id)
    this.assertChatScopeOpen(row.project_id, intakeOwner.owner_scope_id ?? undefined)
    if (row.status !== 'open') {
      throw new KernelError(409, 'upload_session_closed', `upload session ${uploadId} is ${row.status} — no more chunks accepted`)
    }
    const range = parseContentRange(input.contentRange)
    if (range === null) {
      throw new KernelError(422, 'invalid_content_range', `malformed Content-Range '${input.contentRange}' (expected 'bytes <start>-<end>[/<total>]')`)
    }
    if (!/^[0-9a-f]{64}$/.test(input.chunkSha256)) {
      throw new KernelError(422, 'invalid_chunk_hash_header', 'X-Chunk-SHA256 must be a 64-hex sha256')
    }
    const len = input.bytes.byteLength
    if (range.end !== range.start + len - 1) {
      throw new KernelError(422, 'chunk_range_mismatch',
        `Content-Range end ${range.end} does not match body length (start ${range.start}, ${len} bytes)`)
    }
    if (range.total !== null && range.total !== row.expected_size) {
      throw new KernelError(409, 'chunk_total_mismatch',
        `Content-Range total ${range.total} does not match expected_size ${row.expected_size}`)
    }
    if (len > row.chunk_size) {
      throw new KernelError(413, 'chunk_too_large',
        `chunk is ${len} bytes > session chunk_size ${row.chunk_size}`)
    }
    if (range.end >= row.expected_size) {
      throw new KernelError(422, 'chunk_beyond_size',
        `chunk end ${range.end} is beyond expected_size ${row.expected_size}`)
    }
    const actualSha = createHash('sha256').update(Buffer.from(input.bytes)).digest('hex')
    if (actualSha !== input.chunkSha256) {
      throw new KernelError(422, 'chunk_hash_mismatch',
        `chunk sha256 does not match X-Chunk-SHA256 (server computed ${actualSha})`)
    }
    if (range.start < row.committed_offset) {
      // 旧范围重放：同 offset 同字节/hash → 成功且 replayed=true。
      const existing = this.db.prepare('SELECT size, sha256 FROM upload_chunks WHERE upload_id = ? AND offset = ?')
        .get(uploadId, range.start) as { size: number; sha256: string } | undefined
      if (existing !== undefined && existing.size === len && existing.sha256 === actualSha) {
        return { upload_id: uploadId, committed_offset: row.committed_offset, replayed: true }
      }
      throw new KernelError(409, 'chunk_overlap_conflict',
        `chunk at offset ${range.start} overlaps committed data with different content (committed_offset ${row.committed_offset})`)
    }
    if (range.start > row.committed_offset) {
      throw new KernelError(409, 'chunk_gap',
        `chunk starts at ${range.start} but committed_offset is ${row.committed_offset} — chunks must be contiguous`)
    }
    // start === committed_offset：顺序追加。The filesystem write remains
    // inside the same SQLite write transaction as the final liveness check;
    // whichever operation (append or scope tombstone) linearizes first is
    // followed by the other, and tombstone cleanup cannot miss late bytes.
    return withTransaction(this.db, () => {
      const live = this.db.prepare('SELECT * FROM upload_sessions WHERE upload_id = ? AND intake_id = ?')
        .get(uploadId, intakeId) as UploadSessionRow | undefined
      if (live === undefined) throw new KernelError(404, 'upload_session_not_found', `upload session ${uploadId} not found`)
      if (live.status !== 'open') {
        throw new KernelError(409, 'upload_session_closed', `upload session ${uploadId} is ${live.status} — no more chunks accepted`)
      }
      this.assertChatScopeOpen(live.project_id, live.owner_scope_id ?? undefined)
      const liveIntake = this.getIntakeSessionRow(intakeId, live.project_id)
      this.assertChatScopeOpen(live.project_id, liveIntake.owner_scope_id ?? undefined)
      if (range.start < live.committed_offset) {
        const existing = this.db.prepare('SELECT size, sha256 FROM upload_chunks WHERE upload_id = ? AND offset = ?')
          .get(uploadId, range.start) as { size: number; sha256: string } | undefined
        if (existing !== undefined && existing.size === len && existing.sha256 === actualSha) {
          return { upload_id: uploadId, committed_offset: live.committed_offset, replayed: true }
        }
        throw new KernelError(409, 'chunk_overlap_conflict',
          `chunk at offset ${range.start} overlaps committed data with different content (committed_offset ${live.committed_offset})`)
      }
      if (range.start > live.committed_offset) {
        throw new KernelError(409, 'chunk_gap',
          `chunk starts at ${range.start} but committed_offset is ${live.committed_offset} — chunks must be contiguous`)
      }
      const partPath = this.uploadSessionPartPath(intakeId, uploadId)
      try {
        mkdirMode(join(this.intakeStagedRoot, intakeId), 0o700)
        const fd = openSync(partPath, live.committed_offset === 0 ? 'w' : 'r+', 0o600)
        try {
          writeSync(fd, Buffer.from(input.bytes), 0, len, live.committed_offset)
          chmodSync(partPath, 0o600)
        } finally {
          closeSync(fd)
        }
      } catch (error) {
        throw new KernelError(500, 'stage_write_failed', `upload session staged write failed: ${(error as Error).message}`)
      }
      this.db.prepare('INSERT INTO upload_chunks (upload_id, offset, size, sha256) VALUES (?, ?, ?, ?)')
        .run(uploadId, range.start, len, actualSha)
      const committed = range.end + 1
      this.db.prepare('UPDATE upload_sessions SET committed_offset = ?, updated_at = ? WHERE upload_id = ?')
        .run(committed, nowIso(), uploadId)
      return { upload_id: uploadId, committed_offset: committed, replayed: false }
    })
  }

  /**
   * CHUNK-01 finalize: 只在 offset 等于 expected size 时进行；服务端流式
   * 重算完整 size/SHA-256（不一致 422 且不产生 IntakeArtifact）。成功后
   * 在隔离 intake staging 注册 IntakeArtifact（sha256 命名 .part，
   * quarantine=staged）并将会话标记 finalized；重复 finalize 返回同一
   * artifact（幂等）。
   */
  finalizeUploadSession(intakeId: string, uploadId: string): IntakeArtifact {
    const row = this.getUploadSessionRow(uploadId, intakeId)
    this.assertChatScopeOpen(row.project_id, row.owner_scope_id ?? undefined)
    if (row.status === 'finalized' && row.finalized_sha256 !== null) {
      const existing = this.db.prepare('SELECT * FROM intake_artifacts WHERE intake_id = ? AND artifact_id = ?')
        .get(intakeId, `sha256:${row.finalized_sha256}`) as IntakeArtifactRow | undefined
      if (existing !== undefined) {
        return {
          intake_id: existing.intake_id,
          artifact_id: existing.artifact_id,
          file_name: existing.file_name,
          media_type: existing.media_type,
          size_bytes: existing.size_bytes,
          sha256: existing.sha256,
          quarantine: existing.quarantine as IntakeArtifact['quarantine'],
          scan_result: jsonParse(existing.scan_result, {}),
          created_at: existing.created_at,
        }
      }
      throw new KernelError(422, 'stage_corrupted', `upload session ${uploadId} finalized but its artifact is missing — re-upload`)
    }
    if (row.status !== 'open') {
      throw new KernelError(409, 'upload_session_closed', `upload session ${uploadId} is ${row.status} — cannot finalize`)
    }
    const sessionRow = this.getIntakeSessionRow(intakeId)
    const session = this.intakeSessionFromRow(sessionRow)
    if (sessionRow.project_id !== null) this.assertChatScopeOpen(sessionRow.project_id, sessionRow.owner_scope_id ?? undefined)
    this.assertIntakeMutable(session)
    this.assertIntakeNotExpired(session)
    if (row.committed_offset !== row.expected_size) {
      throw new KernelError(422, 'chunk_incomplete',
        `upload session ${uploadId} has ${row.committed_offset}/${row.expected_size} bytes — finalize requires the full expected size`)
    }
    const partPath = this.uploadSessionPartPath(intakeId, uploadId)
    let actualSize: number
    let actualSha: string
    try {
      actualSize = statSync(partPath).size
    } catch {
      throw new KernelError(422, 'stage_corrupted', `upload session ${uploadId} staged bytes are missing — re-upload (stage GC?)`)
    }
    actualSha = hashFileStreaming(partPath)
    if (actualSize !== row.expected_size) {
      throw new KernelError(422, 'chunk_size_mismatch',
        `finalized size ${actualSize} does not match expected_size ${row.expected_size} — no IntakeArtifact produced`)
    }
    if (row.expected_sha256 !== null && actualSha !== row.expected_sha256) {
      throw new KernelError(422, 'chunk_hash_mismatch',
        `finalized sha256 does not match expected_sha256 — no IntakeArtifact produced`)
    }
    const artifactId = `sha256:${actualSha}`
    const artifactTarget = this.intakeStagedPath(intakeId, actualSha)
    const now = nowIso()
    return withTransaction(this.db, () => {
      // Hashing happens outside the write transaction. Re-resolve every live
      // owner after that filesystem window so a concurrent project delete or
      // upload abort wins before artifact promotion.
      const liveUpload = this.db.prepare('SELECT * FROM upload_sessions WHERE upload_id = ? AND intake_id = ?')
        .get(uploadId, intakeId) as UploadSessionRow | undefined
      if (liveUpload === undefined) {
        throw new KernelError(404, 'upload_session_not_found', `upload session ${uploadId} not found`)
      }
      if (liveUpload.status !== 'open') {
        throw new KernelError(409, 'upload_session_closed', `upload session ${uploadId} is ${liveUpload.status} — cannot finalize`)
      }
      this.getProject(liveUpload.project_id)
      this.assertChatScopeOpen(liveUpload.project_id, liveUpload.owner_scope_id ?? undefined)
      const liveSessionRow = this.getIntakeSessionRow(intakeId, liveUpload.project_id)
      const liveSession = this.intakeSessionFromRow(liveSessionRow)
      this.assertChatScopeOpen(liveUpload.project_id, liveSessionRow.owner_scope_id ?? undefined)
      this.assertIntakeMutable(liveSession)
      this.assertIntakeNotExpired(liveSession)
      const existing = this.db.prepare('SELECT * FROM intake_artifacts WHERE intake_id = ? AND artifact_id = ?')
        .get(intakeId, artifactId) as IntakeArtifactRow | undefined
      if (existing === undefined) {
        try {
          mkdirMode(join(this.intakeStagedRoot, intakeId), 0o700)
          if (artifactTarget !== partPath) {
            try { unlinkSync(artifactTarget) } catch { /* first write */ }
            renameSync(partPath, artifactTarget)
          }
        } catch (error) {
          throw new KernelError(500, 'stage_write_failed', `intake staged promote failed: ${(error as Error).message}`)
        }
        const artifact: IntakeArtifact = {
          artifact_id: artifactId,
          intake_id: intakeId,
          file_name: row.file_name,
          media_type: row.media_type,
          size_bytes: actualSize,
          sha256: actualSha,
          quarantine: 'staged',
          scan_result: {},
          created_at: now,
        }
        this.db.prepare(
          'INSERT INTO intake_artifacts (intake_id, artifact_id, file_name, media_type, size_bytes, sha256, quarantine, scan_result, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
        ).run(intakeId, artifactId, artifact.file_name, artifact.media_type, artifact.size_bytes, artifact.sha256, artifact.quarantine, '{}', now)
        this.setIntakeStatus(intakeId, 'uploading', liveSessionRow.status, 'artifact_staged')
        this.db.prepare('UPDATE upload_sessions SET status = ?, finalized_sha256 = ?, owns_artifact = 1, updated_at = ? WHERE upload_id = ?')
          .run('finalized', actualSha, now, uploadId)
        return artifact
      }
      // 幂等重放：artifact 已存在（重复 finalize / 内容去重）。
      if (artifactTarget !== partPath) {
        try { unlinkSync(partPath) } catch (error) {
          if ((error as { code?: string }).code !== 'ENOENT') {
            throw new KernelError(500, 'stage_write_failed', `deduplicated upload cleanup failed: ${(error as Error).message}`)
          }
        }
      }
      this.db.prepare('UPDATE upload_sessions SET status = ?, finalized_sha256 = ?, owns_artifact = 0, updated_at = ? WHERE upload_id = ?')
        .run('finalized', actualSha, now, uploadId)
      return {
        intake_id: existing.intake_id,
        artifact_id: existing.artifact_id,
        file_name: existing.file_name,
        media_type: existing.media_type,
        size_bytes: existing.size_bytes,
        sha256: existing.sha256,
        quarantine: existing.quarantine as IntakeArtifact['quarantine'],
        scan_result: jsonParse(existing.scan_result, {}),
        created_at: existing.created_at,
      }
    })
  }

  /** CHUNK-01 abort：幂等；先持久化 aborted cleanup ledger 并删除
   * chunk rows。若 finalize 与关闭 session 竞态，则只撤销由该 upload
   * 新建且仍为 staged 的 artifact；去重/已扫描 artifact 不受影响。
   * unlink 成功后才删除会话行。 */
  abortUploadSession(intakeId: string, uploadId: string): { ok: true } {
    const marked = withTransaction(this.db, () => this.markUploadAbortedInTransaction(intakeId, uploadId))
    if (marked !== undefined) this.cleanupAbortedUpload(intakeId, uploadId)
    return { ok: true }
  }

  /**
   * CHUNK-01 GC：立即重试 aborted cleanup ledger，并回收过期（≥24h）
   * open session。只有 staging 字节确认不存在后才删除 ledger row。
   */
  cleanupUploadSessions(now = Date.now()): number {
    const expired = this.db.prepare(
      "SELECT upload_id, intake_id FROM upload_sessions WHERE status = 'aborted' OR (status = 'open' AND expires_at < ?)",
    ).all(new Date(now).toISOString()) as unknown as Array<{ upload_id: string; intake_id: string }>
    let removed = 0
    for (const item of expired) {
      withTransaction(this.db, () => this.markUploadAbortedInTransaction(item.intake_id, item.upload_id))
      if (this.cleanupAbortedUpload(item.intake_id, item.upload_id)) removed += 1
    }
    return removed
  }

  /** Project-scoped artifact lookup (v2 §3.4 isolation). */
  getArtifact(projectId: string, sha256OrId: string): ArtifactRecord {
    this.getProject(projectId)
    const id = sha256OrId.startsWith('sha256:') ? sha256OrId : `sha256:${sha256OrId}`
    const row = this.db.prepare('SELECT * FROM artifacts WHERE project_id = ? AND artifact_id = ?')
      .get(projectId, id) as ArtifactRecord | undefined
    if (row === undefined) throw new KernelError(404, 'artifact_not_found', `artifact ${id} not found in project ${projectId}`)
    // metadata is stored as JSON TEXT — surface it as the schema object.
    return { ...row, metadata: jsonParse(row.metadata as unknown as string, {}) }
  }


  listArtifacts(projectId: string): ArtifactRecord[] {
    this.getProject(projectId)
    const rows = this.db.prepare('SELECT * FROM artifacts WHERE project_id = ? ORDER BY created_at').all(projectId) as unknown as ArtifactRecord[]
    return rows.map(row => ({ ...row, metadata: jsonParse(row.metadata as unknown as string, {}) }))
  }

  /** All project records referencing one blob (v2 §7.4 compatibility). */
  listArtifactsForBlob(sha256OrId: string): ArtifactRecord[] {
    const id = sha256OrId.startsWith('sha256:') ? sha256OrId : `sha256:${sha256OrId}`
    return this.db.prepare('SELECT * FROM artifacts WHERE artifact_id = ? ORDER BY project_id').all(id) as unknown as ArtifactRecord[]
  }

  /** Verify a RunManifest's artifact refs exist in CAS (design §4.6.1). */
  verifyArtifactRefs(refs: string[]): { ok: boolean; missing: string[] } {
    const missing = refs.filter(ref => {
      const sha = ref.replace(/^sha256:/, '')
      return !this.cas.has(sha)
    })
    return { ok: missing.length === 0, missing }
  }

  // ── ideas ────────────────────────────────────────────────────────────────

  createIdea(input: Omit<IdeaCard, 'idea_id' | 'project_id' | 'status' | 'version' | 'created_at' | 'updated_at'> & { project_id: string }): IdeaCard {
    this.getProject(input.project_id)
    const card: IdeaCard = {
      idea_id: buildIdeaId(),
      project_id: input.project_id,
      version: 1,
      // v2 shape (domain-model.md §6): optional frozen-corpus binding —
      // validated by the Idea Gate decision (422 idea_corpus_unknown /
      // idea_corpus_foreign); legacy cards default to null.
      corpus_snapshot_id: input.corpus_snapshot_id ?? null,
      title: input.title,
      hypothesis: input.hypothesis,
      scientific_gap: input.scientific_gap,
      nearest_prior_works: input.nearest_prior_works,
      exact_delta: input.exact_delta,
      falsification: input.falsification,
      minimum_viable_experiment: input.minimum_viable_experiment,
      novelty_audit: input.novelty_audit,
      scores: input.scores,
      risk_notes: input.risk_notes ?? '',
      status: 'proposed',
      created_at: nowIso(),
      updated_at: nowIso(),
    }
    IdeaCard.parse(card)
    this.db.prepare('INSERT INTO ideas (idea_id, project_id, body, updated_at) VALUES (?, ?, ?, ?)')
      .run(card.idea_id, card.project_id, JSON.stringify(card), card.updated_at)
    this.emit(input.project_id, 'idea.created', { idea_id: card.idea_id, title: card.title })
    return card
  }

  /**
   * Canonical Scholar Chat idea-generation write. The model only supplies
   * validated IdeaDraft bodies; this Kernel method pins project revision and
   * frozen-corpus provenance, then inserts the whole set atomically. It does
   * not select a winner or advance the Human-governed Idea Gate.
   */
  createIdeasBatch(input: {
    project_id: string
    expected_project_revision: number
    corpus_snapshot_id: string
    ideas: IdeaDraft[]
  }): IdeaCard[] {
    const project = this.getProject(input.project_id)
    if (project.revision !== input.expected_project_revision) {
      throw new KernelError(409, 'revision_conflict', `expected revision ${input.expected_project_revision}, got ${project.revision}`)
    }
    if (project.status !== 'SURVEYING') {
      throw new KernelError(409, 'idea_generation_not_ready', `idea generation requires SURVEYING, got ${project.status}`)
    }
    const snapshot = this.getCorpusSnapshot(input.corpus_snapshot_id)
    if (snapshot.project_id !== input.project_id) {
      throw new KernelError(422, 'idea_corpus_foreign', `corpus snapshot ${input.corpus_snapshot_id} belongs to another project`)
    }
    if (!snapshot.frozen) {
      throw new KernelError(422, 'idea_corpus_not_frozen', `corpus snapshot ${input.corpus_snapshot_id} is not frozen`)
    }
    if (input.ideas.length < 1 || input.ideas.length > 5) {
      throw new KernelError(422, 'idea_count_invalid', 'idea generation requires 1-5 drafts')
    }
    return withTransaction(this.db, () => input.ideas.map(draft => this.createIdea({
      project_id: input.project_id,
      corpus_snapshot_id: input.corpus_snapshot_id,
      ...draft,
    })))
  }

  listIdeas(projectId: string): IdeaCard[] {
    const rows = this.db.prepare('SELECT * FROM ideas WHERE project_id = ? ORDER BY updated_at').all(projectId) as unknown as Array<{ body: string }>
    return rows.map(row => jsonParse(row.body, null as unknown as IdeaCard)).filter(Boolean)
  }

  getIdea(ideaId: string): IdeaCard {
    const row = this.db.prepare('SELECT * FROM ideas WHERE idea_id = ?').get(ideaId) as { body?: string } | undefined
    if (row?.body === undefined) throw new KernelError(404, 'idea_not_found', `idea ${ideaId} not found`)
    return JSON.parse(row.body) as IdeaCard
  }

  /** Versioned update: existing fields carried forward, version bumped. */
  updateIdea(ideaId: string, patch: Partial<Omit<IdeaCard, 'idea_id' | 'project_id' | 'version' | 'created_at'>>): IdeaCard {
    const current = this.getIdea(ideaId)
    const next: IdeaCard = {
      ...current,
      ...patch,
      version: current.version + 1,
      updated_at: nowIso(),
    }
    IdeaCard.parse(next)
    this.db.prepare('UPDATE ideas SET body = ?, updated_at = ? WHERE idea_id = ?').run(JSON.stringify(next), next.updated_at, ideaId)
    this.emit(current.project_id, 'idea.updated', { idea_id: ideaId, version: next.version })
    return next
  }

  approveIdea(ideaId: string): IdeaCard {
    return this.updateIdea(ideaId, { status: 'approved' })
  }

  /** Attach/refresh the novelty counter-search audit on an IdeaCard. */
  updateIdeaNovelty(ideaId: string, audit: NonNullable<IdeaCard['novelty_audit']>): IdeaCard {
    return this.updateIdea(ideaId, { novelty_audit: audit })
  }

  /**
   * Human selection boundary between generated candidates and the Idea Gate.
   * The connector-derived audit, phase transition and payload-bound pending
   * Gate either all commit or all roll back.
   */
  prepareIdeaGate(input: {
    project_id: string
    idea_id: string
    expected_project_revision: number
    expected_idea_version: number
    novelty_audit: NonNullable<IdeaCard['novelty_audit']>
  }): { idea: IdeaCard; project: ResearchProject; gate: Gate } {
    const audit = NoveltyAudit.parse(input.novelty_audit)
    return withTransaction(this.db, () => {
      const project = this.getProject(input.project_id)
      if (project.revision !== input.expected_project_revision) {
        throw new KernelError(409, 'revision_conflict', `expected revision ${input.expected_project_revision}, got ${project.revision}`)
      }
      if (project.status !== 'SURVEYING') {
        throw new KernelError(409, 'idea_selection_not_ready', `idea selection requires SURVEYING, got ${project.status}`)
      }
      const card = this.getIdea(input.idea_id)
      if (card.project_id !== input.project_id) {
        throw new KernelError(422, 'idea_foreign', `idea ${input.idea_id} belongs to another project`)
      }
      if (card.version !== input.expected_idea_version) {
        throw new KernelError(409, 'idea_revision_conflict', `expected idea version ${input.expected_idea_version}, got ${card.version}`)
      }
      if (card.status !== 'proposed') {
        throw new KernelError(409, 'idea_not_proposed', `idea ${input.idea_id} is ${card.status}`)
      }
      const corpusSnapshotId = card.corpus_snapshot_id
      if (corpusSnapshotId === null || corpusSnapshotId === '') {
        throw new KernelError(422, 'idea_corpus_required', `idea ${input.idea_id} is not bound to a frozen corpus`)
      }
      const snapshot = this.getCorpusSnapshot(corpusSnapshotId)
      if (snapshot.project_id !== input.project_id) {
        throw new KernelError(422, 'idea_corpus_foreign', `idea ${input.idea_id} references another project's corpus`)
      }
      if (!snapshot.frozen) {
        throw new KernelError(422, 'idea_corpus_not_frozen', `corpus snapshot ${corpusSnapshotId} is not frozen`)
      }
      if (this.listGates(input.project_id, 'pending').some(gate => gate.type === 'idea')) {
        throw new KernelError(409, 'idea_gate_exists', 'a pending Idea Gate already exists')
      }
      const idea = this.updateIdeaNovelty(input.idea_id, audit)
      const transitioned = this.transition(input.project_id, 'IDEATING', project.revision, `idea ${input.idea_id} selected after novelty audit`)
      const gate = this.createGate({
        project_id: input.project_id,
        type: 'idea',
        title: 'Idea Gate',
        summary: idea.title,
        payload: {
          idea_id: idea.idea_id,
          idea_version: idea.version,
          idea_sha256: fullAutoAuthorityHash(idea),
        },
      })
      return { idea, project: transitioned, gate }
    })
  }

  // ── contracts ────────────────────────────────────────────────────────────

  /**
   * Agent-authored, Human-governed handoff from an approved IdeaCard to the
   * Contract Gate. Contract registration, phase transition and the
   * payload-bound Gate are one transaction, so the user never lands in a
   * state with only an unmet approved_contract dependency.
   */
  prepareContractGate(input: {
    project_id: string
    idea_id: string
    expected_project_revision: number
    expected_idea_version: number
    contract: Omit<ExperimentContract, 'contract_id' | 'version' | 'project_id' | 'idea_id' | 'status' | 'approval' | 'created_at' | 'updated_at'>
  }): { contract: ExperimentContract; project: ResearchProject; gate: Gate } {
    return withTransaction(this.db, () => {
      const project = this.getProject(input.project_id)
      if (project.revision !== input.expected_project_revision) {
        throw new KernelError(409, 'revision_conflict', `expected revision ${input.expected_project_revision}, got ${project.revision}`)
      }
      if (project.status !== 'IDEA_APPROVED' && project.status !== 'CONTRACT_PENDING') {
        throw new KernelError(409, 'contract_draft_not_ready', `contract drafting requires IDEA_APPROVED or CONTRACT_PENDING, got ${project.status}`)
      }
      const idea = this.getIdea(input.idea_id)
      if (idea.project_id !== input.project_id) {
        throw new KernelError(422, 'idea_foreign', `idea ${input.idea_id} belongs to another project`)
      }
      if (idea.version !== input.expected_idea_version) {
        throw new KernelError(409, 'idea_revision_conflict', `expected idea version ${input.expected_idea_version}, got ${idea.version}`)
      }
      if (idea.status !== 'approved') {
        throw new KernelError(409, 'idea_not_approved', `idea ${input.idea_id} is ${idea.status}`)
      }
      if (this.listGates(input.project_id, 'pending').some(gate => gate.type === 'contract')) {
        throw new KernelError(409, 'contract_gate_exists', 'a pending Contract Gate already exists')
      }
      const contract = this.registerContract({
        ...input.contract,
        project_id: input.project_id,
        idea_id: input.idea_id,
      })
      const transitioned = project.status === 'IDEA_APPROVED'
        ? this.transition(input.project_id, 'CONTRACT_PENDING', project.revision, `contract ${contract.contract_id} drafted from approved idea ${idea.idea_id}`)
        : project
      const gate = this.createGate({
        project_id: input.project_id,
        type: 'contract',
        title: 'Contract Gate',
        summary: `${idea.title} — ${contract.methods.baseline} → ${contract.methods.treatment}`,
        payload: {
          contract_id: contract.contract_id,
          contract_version: contract.version,
          contract_sha256: fullAutoAuthorityHash(contract),
        },
      })
      return { contract, project: transitioned, gate }
    })
  }

  registerContract(input: Omit<ExperimentContract, 'contract_id' | 'version' | 'status' | 'created_at' | 'updated_at'> & { project_id: string }): ExperimentContract {
    this.getProject(input.project_id)
    const contract: ExperimentContract = {
      contract_id: buildContractId(),
      version: 1,
      project_id: input.project_id,
      idea_id: input.idea_id,
      baseline_run: input.baseline_run,
      code_snapshot: input.code_snapshot,
      data: input.data,
      methods: input.methods,
      metrics: input.metrics,
      seeds: input.seeds,
      analysis: input.analysis,
      ablations: input.ablations,
      stop_conditions: input.stop_conditions,
      status: 'draft',
      approval: undefined,
      created_at: nowIso(),
      updated_at: nowIso(),
    }
    // Zod defaults (seeds, analysis, metrics.secondary, metrics.direction,
    // stop_conditions …) must be MATERIALIZED into the stored body — parsing
    // then re-inserting the PARSED value (not the raw input) guarantees the
    // runner's contract_metrics injection and direction resolution always see
    // the defaulted fields.
    const parsed = ExperimentContract.parse(contract)
    this.db.prepare('INSERT INTO contracts (contract_id, project_id, body, updated_at) VALUES (?, ?, ?, ?)')
      .run(parsed.contract_id, parsed.project_id, JSON.stringify(parsed), parsed.updated_at)
    this.emit(input.project_id, 'contract.registered', { contract_id: parsed.contract_id })
    return parsed
  }

  getContract(contractId: string): ExperimentContract {
    const row = this.db.prepare('SELECT * FROM contracts WHERE contract_id = ?').get(contractId) as { body?: string } | undefined
    if (row?.body === undefined) throw new KernelError(404, 'contract_not_found', `contract ${contractId} not found`)
    return JSON.parse(row.body) as ExperimentContract
  }

  listContracts(projectId: string): ExperimentContract[] {
    const rows = this.db.prepare('SELECT * FROM contracts WHERE project_id = ? ORDER BY updated_at').all(projectId) as unknown as Array<{ body: string }>
    return rows.map(row => JSON.parse(row.body) as ExperimentContract)
  }

  /** Freeze a contract upon Contract Gate approval (design §6.6: immutable). */
  approveContract(contractId: string, gateDecisionId: string, actor: string): ExperimentContract {
    const current = this.getContract(contractId)
    if (current.status === 'approved') return current
    const next: ExperimentContract = {
      ...current,
      status: 'approved',
      approval: { gate_decision_id: gateDecisionId, approved_at: nowIso(), approved_by: actor },
      updated_at: nowIso(),
    }
    this.db.prepare('UPDATE contracts SET body = ?, updated_at = ? WHERE contract_id = ?').run(JSON.stringify(next), next.updated_at, contractId)
    this.emit(current.project_id, 'contract.approved', { contract_id: contractId, gate_decision_id: gateDecisionId })
    return next
  }

  // ── corpus ───────────────────────────────────────────────────────────────

  snapshotCorpus(input: {
    project_id: string
    expected_revision?: number
    expected_session_id?: string
    queries: CorpusSnapshot['queries']
    papers: Paper[]
    passages?: Passage[]
    citation_edges?: CorpusSnapshot['citation_edges']
    external_claims?: CorpusSnapshot['external_claims']
    /** v2 shape (domain-model.md §5): per-source status; any source failure
     * must be recorded here instead of silently dropping the query. */
    source_status?: CorpusSnapshot['source_status']
  }, fullAutoReceipt?: FullAutoSurveyAuthorityReceiptBase): CorpusSnapshot {
    this.getProject(input.project_id)
    // v2 shape (domain-model.md §5): every passage carries the sha256 of its
    // text — "new-write required": the kernel always fills it on snapshot
    // writes and the verification step below rejects any passage that would
    // land without a non-empty content hash (old rows without the field
    // still parse on read — old-read compatible).
    const passages = (input.passages ?? []).map((passage) => ({
      ...passage,
      content_hash: createHash('sha256').update(passage.text, 'utf8').digest('hex'),
    }))
    for (const passage of passages) {
      const parsed = Passage.safeParse(passage)
      if (!parsed.success || parsed.data.content_hash === undefined || parsed.data.content_hash === '') {
        throw new KernelError(422, 'passage_content_hash_required',
          `passage ${passage.passage_id} (${passage.paper_id}) would land without a content hash — the kernel computes sha256(text) on every snapshot write (domain-model.md §5)`)
      }
    }
    const snapshot: CorpusSnapshot = {
      snapshot_id: randomId('corpus_snap'),
      project_id: input.project_id,
      // v2 shape (domain-model.md §5): explicit payload schema version +
      // per-source retrieval status (defaults keep legacy readers intact).
      schema_version: 1,
      source_status: input.source_status ?? 'complete',
      queries: input.queries,
      papers: input.papers,
      passages,
      citation_edges: input.citation_edges ?? [],
      external_claims: input.external_claims ?? [],
      quality: {
        total_papers: input.papers.length,
        dedup_ratio: 0,
        coverage_note: '',
      },
      created_at: nowIso(),
      frozen: true,
    }
    CorpusSnapshot.parse(snapshot)
    const write = () => {
      const project = this.getProject(input.project_id)
      if (input.expected_session_id !== undefined
        && this.getProjectBySession(input.expected_session_id)?.project_id !== project.project_id) {
        throw new KernelError(409, 'session_link_conflict',
          `session ${input.expected_session_id} is no longer linked to project ${project.project_id}`)
      }
      if (input.expected_revision !== undefined && project.revision !== input.expected_revision) {
        throw new KernelError(409, 'revision_conflict',
          `expected revision ${input.expected_revision}, got ${project.revision}`)
      }
      this.db.prepare('INSERT INTO corpus_snapshots (snapshot_id, project_id, body, created_at) VALUES (?, ?, ?, ?)')
        .run(snapshot.snapshot_id, snapshot.project_id, JSON.stringify(snapshot), snapshot.created_at)
      const authorityReceipt = fullAutoReceipt === undefined
        ? undefined
        : FullAutoSurveyAuthorityReceiptSchema.parse({ ...fullAutoReceipt, snapshot_id: snapshot.snapshot_id })
      this.emit(input.project_id, 'corpus.snapshotted', {
        snapshot_id: snapshot.snapshot_id,
        total_papers: snapshot.papers.length,
        ...(authorityReceipt === undefined ? {} : { full_auto_survey_receipt: authorityReceipt }),
      })
      // GUIDE-01: completing the survey must retire survey_run. Keep the
      // snapshot, phase CAS and both Outbox events in this same transaction;
      // supplemental snapshots in every other phase are phase-neutral.
      if (project.status === 'SCOPED') {
        this.transition(project.project_id, 'SURVEYING', project.revision, 'corpus snapshot frozen')
      }
      return snapshot
    }
    return this.db.isTransaction ? write() : withTransaction(this.db, write)
  }

  listCorpusSnapshots(projectId: string): CorpusSnapshot[] {
    this.getProject(projectId)
    const rows = this.db.prepare('SELECT * FROM corpus_snapshots WHERE project_id = ? ORDER BY created_at').all(projectId) as unknown as Array<{ body: string }>
    return rows.map(row => JSON.parse(row.body) as CorpusSnapshot)
  }

  getCorpusSnapshot(snapshotId: string): CorpusSnapshot {
    const row = this.db.prepare('SELECT * FROM corpus_snapshots WHERE snapshot_id = ?').get(snapshotId) as { body?: string } | undefined
    if (row?.body === undefined) throw new KernelError(404, 'snapshot_not_found', `corpus snapshot ${snapshotId} not found`)
    return JSON.parse(row.body) as CorpusSnapshot
  }

  // ── code snapshot archive (design §11.3, SCH-EXEC-002) ───────────────────

  /**
   * Archive a project workspace's ACTUAL file contents into a content-
   * addressed `code` artifact (JSON `{schema_version, project_id,
   * description, files: {rel: {sha256, content_base64}}, excludes}`) plus a
   * lightweight `manifest` artifact (file list + hashes, no content). The
   * Runner materializes the code snapshot ONLY from the Artifact Store —
   * never from agent host dirs.
   *
   * P0-4 (hardening-v0.2-status.md §5 SNAPSHOT-01/API-01): the archived
   * root is ALWAYS a workspace of the given project, resolved server-side
   * from the workspace store (`dataDir/workspaces/{project_id}/
   * {workspace_id}/`) — the API never accepts a caller-supplied host path.
   * `relativePath` is root-relative POSIX ('' = the whole workspace):
   * absolute paths, `..`/`.` segments, NUL bytes, backslashes and Windows
   * drive prefixes are rejected (422-shaped `invalid_path` via
   * normalizeWorkspacePath, the same guard the workspace routes use).
   *
   * Safety (path escape / symlink protection): the resolved root must live
   * INSIDE the kernel's workspaces area (realpath containment — a symlinked
   * workspace dir cannot redirect the archive outside it), and the walk
   * rejects any symbolic link whose realpath resolves OUTSIDE the archived
   * root (422 `snapshot_path_escape`); directories `.git`, `node_modules`
   * and `.research-cas` are excluded.
   *
   * P0-4 secret-file policy: files matching known secret patterns (`.env`,
   * `*_token`, `*.key`/`*.pem`, `id_rsa`/`id_ed25519`/…, `.aws/credentials`,
   * `service-token`, `kernel-token`, `.npmrc`/`.pypirc`/`.netrc`/…) are
   * NEVER archived — the walk collects every match and the whole snapshot is
   * rejected with 422 `snapshot_secret_file` naming the files (fail closed:
   * zero CAS/artifact/manifest writes on rejection).
   */
  snapshotCodeArchive(projectId: string, workspaceId: string, relativePath = '', description = ''): CodeSnapshot {
    this.getProject(projectId)
    // P0-4 (API-01): the workspace must belong to THIS project. A workspace
    // that does not exist or belongs to another project is indistinguishable
    // (404-shaped `workspace_not_found` — no cross-project enumeration).
    let info: import('@dsh-scholar/research-schemas').WorkspaceInfo
    try {
      info = this.workspaces.get(workspaceId)
    } catch (error) {
      if (error instanceof WorkspaceError && error.code === 'workspace_not_found') {
        throw new WorkspaceError('workspace_not_found', `code snapshot: workspace ${workspaceId} not found`)
      }
      throw error
    }
    if (info.project_id !== projectId) {
      throw new WorkspaceError('workspace_not_found', `code snapshot: workspace ${workspaceId} not found`)
    }
    // P0-4: root-relative path normalization. '' (or './') means the whole
    // workspace; otherwise reuse the workspace-store path guard (absolute
    // paths, Windows drive prefixes, `..`/`.` segments, NUL bytes,
    // backslashes and empty segments are all rejected).
    let cleanRel = relativePath.replace(/\/+$/, '')
    if (cleanRel === '' || cleanRel === '.') cleanRel = ''
    else cleanRel = normalizeWorkspacePath(cleanRel)
    const workspaceRoot = this.workspaces.workspaceRoot(workspaceId)
    const absRoot = cleanRel === '' ? workspaceRoot : join(workspaceRoot, ...cleanRel.split('/'))
    // Belt-and-braces: the normalized segments must stay inside the
    // workspace root (a prefix escape here is a bug, not a caller input).
    if (absRoot !== workspaceRoot && !absRoot.startsWith(`${workspaceRoot}${sep}`)) {
      throw new KernelError(422, 'snapshot_path_escape', `code snapshot: root escapes the workspace: ${absRoot}`)
    }
    let rootInfo
    try {
      rootInfo = statSync(absRoot)
    } catch {
      throw new KernelError(422, 'snapshot_root_missing', `code snapshot root not readable: ${absRoot}`)
    }
    if (!rootInfo.isDirectory()) {
      throw new KernelError(422, 'snapshot_root_missing', `code snapshot root is not a directory: ${absRoot}`)
    }
    // P0-4 (SNAPSHOT-01): the RESOLVED root (realpath — symlinks on the path
    // resolved) must stay inside the kernel's approved workspaces area. A
    // workspace directory replaced by a symlink (or a symlinked sub-root)
    // can never redirect the archive outside `dataDir/workspaces/`.
    const realRoot = realpathSync(absRoot)
    const workspacesReal = realpathSync(this.workspaces.workspacesRoot)
    if (realRoot !== workspacesReal && !realRoot.startsWith(`${workspacesReal}${sep}`)) {
      throw new KernelError(422, 'snapshot_path_escape',
        `code snapshot: resolved root escapes the workspaces area: ${absRoot} -> ${realRoot}`)
    }
    // Directories that are never part of a code snapshot (build/vendor/state).
    const EXCLUDED_DIRS = new Set(['.git', 'node_modules', '.research-cas'])
    const files: Record<string, { sha256: string; content_base64: string; size_bytes: number }> = {}
    let totalBytes = 0
    let fileCount = 0
    // P0-4: secret files found during the walk are collected (never read
    // into the archive) and reject the WHOLE snapshot after the walk — the
    // error lists every offending file so the caller can fix them in one go.
    const secretFiles: string[] = []
    const walk = (dir: string): void => {
      let entries: string[]
      try {
        entries = readdirSync(dir)
      } catch (error) {
        throw new KernelError(422, 'snapshot_read_error', `code snapshot: directory not readable: ${dir} (${(error as Error).message})`)
      }
      for (const entry of entries) {
        const full = join(dir, entry)
        let info
        try {
          info = lstatSync(full)
        } catch {
          continue // raced with deletion — skip
        }
        if (info.isSymbolicLink()) {
          // §11.3 escape protection: symlinks resolving outside the archived
          // root are rejected; symlinks staying inside are followed.
          let target: string
          try {
            target = realpathSync(full)
          } catch {
            continue // dangling symlink — skip
          }
          if (target !== realRoot && !target.startsWith(`${realRoot}${sep}`)) {
            throw new KernelError(422, 'snapshot_path_escape',
              `code snapshot: symbolic link escapes the archived root: ${relative(absRoot, full)} -> ${target}`)
          }
          try {
            info = statSync(full)
          } catch {
            continue
          }
        }
        if (info.isDirectory()) {
          if (EXCLUDED_DIRS.has(entry)) continue
          walk(full)
        } else if (info.isFile()) {
          const rel = relative(absRoot, full)
          if (rel.startsWith('..') || rel.startsWith(sep)) {
            throw new KernelError(422, 'snapshot_path_escape', `code snapshot: path escapes the archived root: ${full}`)
          }
          // P0-4 (SNAPSHOT-01): secret material never enters a code
          // snapshot — collect and reject after the walk (full list).
          if (isSecretSnapshotFile(rel)) {
            secretFiles.push(rel)
            continue
          }
          // STORE-02 (§3 fixed resource limits): single-file and file-count
          // caps are enforced BEFORE reading the content (a giant file is
          // rejected on its stat, never buffered in full).
          if (info.size > ResearchKernel.SNAPSHOT_MAX_FILE_BYTES) {
            throw new KernelError(422, 'snapshot_too_large',
              `code snapshot exceeds limits: file ${rel} is ${info.size} bytes (max_file_bytes=${ResearchKernel.SNAPSHOT_MAX_FILE_BYTES})`)
          }
          if (fileCount >= ResearchKernel.SNAPSHOT_MAX_FILES) {
            throw new KernelError(422, 'snapshot_too_large',
              `code snapshot exceeds limits: file count ${fileCount} >= max_files=${ResearchKernel.SNAPSHOT_MAX_FILES}`)
          }
          let content: Buffer
          try {
            content = readFileSync(full)
          } catch (error) {
            throw new KernelError(422, 'snapshot_read_error', `code snapshot: unreadable file ${rel}: ${(error as Error).message}`)
          }
          const sha256 = createHash('sha256').update(content).digest('hex')
          files[rel] = { sha256, content_base64: content.toString('base64'), size_bytes: content.byteLength }
          fileCount += 1
          totalBytes += content.byteLength
          // Total-size cap is checked as the walk accumulates, so an
          // oversized archive fails early instead of being read to the end.
          if (totalBytes > ResearchKernel.SNAPSHOT_MAX_TOTAL_BYTES) {
            throw new KernelError(422, 'snapshot_too_large',
              `code snapshot exceeds limits: total_bytes=${totalBytes} (max_total_bytes=${ResearchKernel.SNAPSHOT_MAX_TOTAL_BYTES})`)
          }
        }
        // sockets/fifos/devices are skipped silently (never part of source).
      }
    }
    walk(absRoot)
    // P0-4: reject AFTER the walk so the error lists every secret file. No
    // artifact/manifest/CAS write has happened yet — rejection is a no-op.
    if (secretFiles.length > 0) {
      throw new KernelError(422, 'snapshot_secret_file',
        `code snapshot contains secret files (rejected): ${secretFiles.join(', ')}`)
    }

    // STORE-02 host-path hygiene: the archive's `root` field is a display
    // placeholder, never the host path — the Runner materializes code ONLY
    // from the `files` map (unpackCodeSnapshot/materializeCodeSnapshot), so
    // `root` carries no materialization semantics. Same for the manifest and
    // the registry source_json; the absolute host path never leaves the kernel.
    const rootPlaceholder = '~'
    const archive = {
      schema_version: 1,
      project_id: projectId,
      description,
      root: rootPlaceholder,
      files,
      excludes: [...EXCLUDED_DIRS],
      created_at: nowIso(),
    }
    const archiveRecord = this.registerArtifact({
      project_id: projectId,
      kind: 'code',
      content: JSON.stringify(archive),
      metadata: { kind: 'code-snapshot-archive', files: Object.keys(files).length, total_bytes: totalBytes },
    })
    // Lightweight manifest artifact (file list + hashes, no content) — §11.3
    // `manifest_artifact_id`. Same sha256 space; content-addressed.
    const manifestRecord = this.registerArtifact({
      project_id: projectId,
      kind: 'manifest',
      content: JSON.stringify({
        schema_version: 1,
        project_id: projectId,
        description,
        root: rootPlaceholder,
        files: Object.fromEntries(Object.entries(files).map(([rel, f]) => [rel, { sha256: f.sha256, size_bytes: f.size_bytes }])),
        excludes: [...EXCLUDED_DIRS],
        created_at: nowIso(),
      }),
      metadata: { kind: 'code-snapshot-manifest', files: Object.keys(files).length },
    })
    const snapshot: CodeSnapshot = {
      snapshot_id: randomId('code_snap'),
      project_id: projectId,
      // Display placeholder only — never the host path (STORE-02).
      path: rootPlaceholder,
      description,
      archive_artifact_id: archiveRecord.artifact_id,
      manifest_artifact_id: manifestRecord.artifact_id,
      submodules_artifact_id: null,
      lockfiles: [],
      files: Object.keys(files).length,
      total_bytes: totalBytes,
      sha256: archiveRecord.sha256,
      created_at: nowIso(),
    }
    // STORE-02: record the snapshot in the authoritative code_snapshots
    // registry (snapshot_id -> archive/manifest artifacts + integrity).
    // P0-4: the registry also records the workspace binding (workspace_id +
    // root_relative_path) — provenance without ever exposing the host path.
    this.db.prepare(`INSERT INTO code_snapshots
        (snapshot_id, project_id, archive_artifact_id, manifest_artifact_id, source_json, sha256, file_count, size_bytes, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(snapshot.snapshot_id, projectId, archiveRecord.artifact_id, manifestRecord.artifact_id,
        JSON.stringify({ description, root: rootPlaceholder, excludes: [...EXCLUDED_DIRS], workspace_id: workspaceId, root_relative_path: cleanRel }),
        archiveRecord.sha256, Object.keys(files).length, totalBytes, snapshot.created_at)
    // Both artifacts already emit artifact.registered events (outbox).
    return snapshot
  }

  /** STORE-02: authoritative code snapshot registry lookup. */
  getCodeSnapshot(snapshotId: string): {
    snapshot_id: string
    project_id: string
    archive_artifact_id: string
    manifest_artifact_id: string
    source: { description?: string; root?: string; excludes?: string[]; workspace_id?: string; root_relative_path?: string }
    sha256: string
    file_count: number
    size_bytes: number
    created_at: string
  } {
    const row = this.db.prepare('SELECT * FROM code_snapshots WHERE snapshot_id = ?').get(snapshotId) as {
      snapshot_id: string; project_id: string; archive_artifact_id: string; manifest_artifact_id: string
      source_json: string; sha256: string; file_count: number; size_bytes: number; created_at: string
    } | undefined
    if (row === undefined) throw new KernelError(404, 'code_snapshot_not_found', `code snapshot ${snapshotId} not found`)
    return {
      snapshot_id: row.snapshot_id,
      project_id: row.project_id,
      archive_artifact_id: row.archive_artifact_id,
      manifest_artifact_id: row.manifest_artifact_id,
      source: JSON.parse(row.source_json) as { description?: string; root?: string; excludes?: string[]; workspace_id?: string; root_relative_path?: string },
      sha256: row.sha256,
      file_count: row.file_count,
      size_bytes: row.size_bytes,
      created_at: row.created_at,
    }
  }

  /** Project-scoped immutable code snapshot summaries for execution setup. */
  listCodeSnapshots(projectId: string): Array<ReturnType<ResearchKernel['getCodeSnapshot']>> {
    this.getProject(projectId)
    const rows = this.db.prepare('SELECT snapshot_id FROM code_snapshots WHERE project_id = ? ORDER BY created_at DESC, snapshot_id DESC')
      .all(projectId) as unknown as Array<{ snapshot_id: string }>
    return rows.map(row => this.getCodeSnapshot(row.snapshot_id))
  }

  // ── durable jobs (design §4.2 Job Controller, §9.3) ──────────────────────

  /** Idempotent job submission: same idempotency_key returns the existing job. */
  submitJob(input: {
    project_id: string
    idempotency_key: string
    kind: JobRecord['kind']
    command?: string[]
    payload?: Record<string, unknown>
    contract_id?: string | null
    max_attempts?: number
    // §12.2 JobSpec binding (SCH-EXEC-002): code snapshot materialized by the
    // Runner from CAS; image_digest/output_contract/data_artifact_ids travel
    // inside payload.
    code_snapshot_id?: string | null
    data_artifact_ids?: string[]
    image_digest?: string
    output_contract?: { metrics: string; logs: string }
    // domain-model.md §9.1: an explicit job override wins over the
    // project's explicit registered id. The unconfigured null state never
    // falls back to a local profile.
    runner_profile_id?: string | null
    /** Job override of the project's opaque configurable target id. */
    runner_target_id?: string | null
    /** Exact frozen methodology protocol required for formal/confirmatory work. */
    protocol_pin?: import('@dsh-scholar/research-schemas').FrozenProtocolPin | null
    run_intent?: import('@dsh-scholar/research-schemas').ResearchIntent
    // v2 shape (domain-model.md §9): durable submitter principal, persisted
    // to jobs.created_by_principal_id. The server layer resolves it from the
    // BFF-injected x-principal-id header (never client body trust); internal
    // callers may omit it → NULL.
    created_by_principal_id?: string | null
  }): JobSpecBound {
    const project = this.getProject(input.project_id)
    // reconstruction-contracts.md §5 / security-baseline.md §1: full-auto is
    // fixture-only. A full-auto project must stay bound to its REGISTERED
    // FixtureProfile and every job input must stay INSIDE the profile:
    // pinned image digest, data artifact content hashes and (when the
    // profile pins one) the code archive hash. Referencing anything outside
    // the profile is 422 — never queued.
    const fixtureProfile = project.mode === 'full-auto' ? getFixtureProfile(project.execution.fixture_id ?? '') : null
    if (project.mode === 'full-auto' && fixtureProfile === null) {
      throw new KernelError(422, 'fixture_required',
        `full-auto project ${project.project_id} is not bound to a REGISTERED FixtureProfile (reconstruction-contracts.md §5)`)
    }
    // v2 §3.4: idempotency is project-scoped — the same key in two projects
    // yields two independent jobs.
    const existing = this.db.prepare('SELECT * FROM jobs WHERE project_id = ? AND idempotency_key = ?')
      .get(input.project_id, input.idempotency_key) as JobRow | undefined
    if (existing !== undefined) return jobFromRow(existing, this.db, this.leaseTokens.get(existing.job_id) ?? null)
    // v2 §3.2 / §12.3: formal-class jobs require a container runner profile;
    // isolated-subprocess is rejected at submission time (kernel layer).
    // domain-model.md §2/§9.1: Job 只引用已登记的 opaque profile id ——
    // 显式 runner_profile_id（job 级 > project 级）优先；未配置/null 或未知 id
    // → 422（fail closed，零落库）。解析出的
    // profile 的 config_hash 与 image digest 一起固定进 Job payload，runner
    // 按注册表复算校验。
    const SECURE_KINDS: readonly string[] = ['baseline', 'pilot', 'formal', 'reproduce', 'latex-compile']
    // job override > project default; both are registered opaque ids.
    const profileRef = input.runner_profile_id ?? project.execution.runner_profile_id
    if (profileRef === null) {
      throw new KernelError(422, 'runner_profile_required',
        `project ${project.project_id} has no configured RunnerProfile; select one in Settings or provide an explicit registered runner_profile_id`)
    }
    const resolvedProfileId = profileRef === null ? null : resolveRunnerProfileId(profileRef)
    const runnerProfile = resolvedProfileId !== null ? getRunnerProfile(resolvedProfileId) : null
    if (runnerProfile === null) {
      throw new KernelError(422, 'runner_profile_unknown',
        `runner profile '${profileRef}' is not a registered opaque profile id (domain-model.md §9.1); jobs reference only registered RunnerProfile ids, never docker flags/endpoints`)
    }
    const targetRef = input.runner_target_id ?? project.execution.runner_target_id
    const runnerTarget = this.listRunnerTargets().find(target => target.target_id === targetRef)
    if (runnerTarget === undefined) {
      throw new KernelError(422, 'runner_target_unknown', `runner target '${targetRef}' is not registered`)
    }
    const runnerAssessment = assessRunnerEnvironment(runnerProfile, runnerTarget, ref => this.secretRefAvailable(ref))
    if (runnerAssessment.hardFailures.includes('target_offline')) {
      throw new KernelError(409, 'runner_target_offline', `runner target ${runnerTarget.target_id} is offline`)
    }
    if (runnerAssessment.hardFailures.includes('target_unprobed')) {
      throw new KernelError(409, 'runner_target_unprobed', `remote runner target ${runnerTarget.target_id} has no fresh authenticated heartbeat`)
    }
    if (runnerAssessment.hardFailures.includes('target_capability_mismatch')) {
      throw new KernelError(422, 'runner_target_capability_mismatch', `runner target ${runnerTarget.target_id} cannot satisfy its configured compute mode`)
    }
    if (!runnerTarget.enabled || runnerTarget.draining) {
      throw new KernelError(409, runnerTarget.draining ? 'runner_target_draining' : 'runner_target_disabled',
        `runner target ${runnerTarget.target_id} is not accepting new jobs`)
    }
    // Preserve the primary execution-safety error: secure kinds are
    // container-only regardless of which target happens to be selected.
    if (SECURE_KINDS.includes(input.kind) && runnerProfile.runner_mode !== 'local-docker') {
      throw new KernelError(422, 'container_execution_required',
        `job kind ${input.kind} requires a container runner profile (got ${runnerProfile.profile_id}); host subprocess is prohibited (v2 §3.2)`)
    }
    if (runnerProfile.runner_mode === 'isolated-subprocess' && runnerTarget.kind !== 'local-process') {
      throw new KernelError(422, 'runner_target_profile_mismatch', 'isolated-subprocess profile requires a local-process target')
    }
    if (runnerProfile.runner_mode === 'local-docker' && runnerTarget.kind === 'local-process') {
      throw new KernelError(422, 'runner_target_profile_mismatch', 'container profile cannot execute on a local-process target')
    }
    if (runnerTarget.kind === 'remote-ssh' && runnerTarget.connection !== undefined) {
      const unavailable = [runnerTarget.connection.endpoint, runnerTarget.connection.credential, runnerTarget.connection.known_hosts]
        .some(ref => !this.secretRefAvailable(ref))
      if (unavailable) {
        throw new KernelError(409, 'runner_target_secret_unavailable',
          `runner target ${runnerTarget.target_id} has unavailable endpoint/credential/known_hosts SecretRef`)
      }
    }
    // §12 latex-compile binds a frozen TeX snapshot, not a code snapshot.
    if (input.kind === 'latex-compile') {
      const docId = typeof input.payload?.tex_document_id === 'string' ? input.payload.tex_document_id : ''
      const rev = typeof input.payload?.tex_revision === 'number' ? input.payload.tex_revision : undefined
      if (docId === '' || rev === undefined) {
        throw new KernelError(422, 'tex_snapshot_required', 'latex-compile jobs require payload.tex_document_id + payload.tex_revision')
      }
      // P0 (RUN-02/TEX-02): the build engine is a fixed enum — an arbitrary
      // string (payload.engine or command[0]) is rejected 422 `engine_invalid`
      // before it can be spliced into the container build script.
      const engine = typeof input.payload?.engine === 'string' && input.payload.engine !== ''
        ? input.payload.engine
        : (Array.isArray(input.command) && input.command.length > 0 ? String(input.command[0]) : 'pdflatex')
      if (!TEX_ENGINES.includes(engine)) {
        throw new KernelError(422, 'engine_invalid',
          `latex-compile engine '${engine}' is not in the fixed engine whitelist (${TEX_ENGINES.join('/')})`)
      }
      // P0 (TEX-02): every path of the frozen snapshot must be root-relative
      // and free of shell metacharacters (they are interpolated into the
      // build script by the runner; the kernel rejects them at submit).
      const snapshot = input.payload?.tex_snapshot
      if (typeof snapshot === 'object' && snapshot !== null) {
        const snap = snapshot as { root_file?: unknown; files?: unknown }
        if (typeof snap.root_file === 'string') assertSafeTexBuildPath(snap.root_file)
        if (Array.isArray(snap.files)) {
          for (const f of snap.files) {
            const path = (f as { path?: unknown } | null)?.path
            if (typeof path === 'string') assertSafeTexBuildPath(path)
          }
        }
        // TEX-01 (§4 row 95): the carried manifest must describe the SAME
        // revision the job claims to compile — a mismatched manifest would
        // let a build row label one revision while the runner compiles
        // another. 409, never queued.
        const manifestRevision = (snap as { revision?: unknown }).revision
        if (typeof manifestRevision === 'number' && manifestRevision !== rev) {
          throw new KernelError(409, 'document_version_conflict',
            `tex snapshot manifest revision ${manifestRevision} does not match tex_revision ${rev} — freeze a fresh manifest before building`)
        }
      }
      this.texSnapshot(docId, rev)
    }
    // §12.2 (SCH-EXEC-002): formal-class jobs MUST bind a materialized code
    // snapshot — the Runner never executes agent host directories.
    // latex-compile binds a frozen TeX snapshot instead (§12).
    const codeSnapshotId = input.code_snapshot_id ?? null
    if (SECURE_KINDS.includes(input.kind) && input.kind !== 'latex-compile' && (codeSnapshotId === null || codeSnapshotId === '')) {
      throw new KernelError(422, 'code_snapshot_required',
        `job kind ${input.kind} requires code_snapshot_id (the Runner materializes code from CAS, §11.3/§12.2)`)
    }
    // STORE-02: code_snapshot_id may be the authoritative REGISTRY id
    // (code_snap_…) or a raw archive artifact id; the registry id is
    // resolved to its archive artifact and the job binds THAT (the Runner
    // materializes from CAS via fetchArtifact).
    let boundCodeSnapshotId = codeSnapshotId
    if (codeSnapshotId !== null && codeSnapshotId !== '') {
      if (codeSnapshotId.startsWith('code_snap_')) {
        try {
          const registered = this.getCodeSnapshot(codeSnapshotId)
          this.getArtifact(project.project_id, registered.archive_artifact_id)
          boundCodeSnapshotId = registered.archive_artifact_id
        } catch {
          throw new KernelError(422, 'code_snapshot_unknown',
            `code_snapshot_id ${codeSnapshotId} is not a registered snapshot of project ${project.project_id}`)
        }
      } else {
        try {
          this.getArtifact(project.project_id, codeSnapshotId)
        } catch {
          throw new KernelError(422, 'code_snapshot_unknown',
            `code_snapshot_id ${codeSnapshotId} is not a registered artifact of project ${project.project_id}`)
        }
      }
    }
    // Full-auto fixture jobs: when the profile pins the code archive hash,
    // the bound snapshot's blob hash must match EXACTLY (fixture code can
    // never be swapped for private/external code).
    if (fixtureProfile !== null && fixtureProfile.code.archive_sha256 !== null) {
      if (boundCodeSnapshotId === null || boundCodeSnapshotId === '') {
        throw new KernelError(422, 'code_snapshot_required',
          'full-auto fixture jobs require code_snapshot_id (the fixture code archive is pinned)')
      }
      let boundHash: string
      try {
        boundHash = this.getArtifact(project.project_id, boundCodeSnapshotId).sha256
      } catch {
        throw new KernelError(422, 'code_snapshot_unknown',
          `full-auto fixture job requires code_snapshot_id bound to an in-project artifact`)
      }
      if (boundHash !== fixtureProfile.code.archive_sha256) {
        throw new KernelError(422, 'fixture_code_mismatch',
          `full-auto job code snapshot ${boundCodeSnapshotId} (${boundHash}) is not the fixture profile's pinned archive ${fixtureProfile.code.archive_sha256}`)
      }
    }
    // P0 (acceptance-tests.md §4): formal-class jobs MUST bind an approved
    // contract of the SAME project, frozen by a Human Gate Decision.
    // draft/foreign/missing contracts are 422, never queued.
    const CONTRACT_BOUND_KINDS: readonly string[] = ['baseline', 'pilot', 'formal', 'reproduce']
    let contractMetricNames: string[] | undefined
    let approvedContractBinding: ExperimentContract | null = null
    if (CONTRACT_BOUND_KINDS.includes(input.kind)) {
      const contractId = input.contract_id ?? null
      if (contractId === null || contractId === '') {
        throw new KernelError(422, 'contract_required', `job kind ${input.kind} requires an approved contract binding`)
      }
      let contract: ExperimentContract
      try {
        contract = this.getContract(contractId)
      } catch {
        throw new KernelError(422, 'contract_unknown', `contract ${contractId} not found for ${input.kind} job`)
      }
      if (contract.project_id !== project.project_id) {
        throw new KernelError(422, 'contract_foreign', `contract ${contractId} belongs to another project (cannot bind to ${project.project_id})`)
      }
      if (contract.status !== 'approved' || contract.approval?.gate_decision_id === undefined || contract.approval.gate_decision_id === '') {
        throw new KernelError(422, 'contract_not_approved', `contract ${contractId} is ${contract.status} and not frozen by a Human Gate Decision`)
      }
      approvedContractBinding = contract
      contractMetricNames = [contract.metrics.primary, ...contract.metrics.secondary]
    }
    // P0 (acceptance-tests.md §4): every `data_artifact_ids` entry must exist,
    // belong to the SAME project and be hash-reverifiable in CAS — a missing,
    // cross-project or unverifiable input is 422 and the job never reaches
    // queued. Empty array / undefined skips the check entirely.
    const dataArtifactIds = input.data_artifact_ids ?? []
    if (dataArtifactIds.length > 0) {
      for (const rawId of dataArtifactIds) {
        const id = rawId.startsWith('sha256:') ? rawId : `sha256:${rawId}`
        // Cross-project input is a distinct error: the blob may exist in
        // another project's registry (v2 §3.4 isolation) — never fall through
        // to a plain "missing".
        const anywhere = this.db.prepare('SELECT project_id FROM artifacts WHERE artifact_id = ?').get(id) as { project_id: string } | undefined
        if (anywhere !== undefined && anywhere.project_id !== project.project_id) {
          throw new KernelError(422, 'data_artifact_foreign',
            `data artifact ${id} belongs to project ${anywhere.project_id}, not ${project.project_id}`)
        }
        let record: ArtifactRecord
        try {
          record = this.getArtifact(project.project_id, id)
        } catch {
          throw new KernelError(422, 'data_artifact_missing',
            `data artifact ${id} is not registered in project ${project.project_id}`)
        }
        // Hash re-verification: the artifact record must reference a blob that
        // is actually present in CAS (immutable content-addressed store).
        if (!this.cas.has(record.sha256)) {
          throw new KernelError(422, 'data_artifact_hash_unverifiable',
            `data artifact ${id} blob ${record.sha256} is missing from CAS and cannot be re-verified`)
        }
        // Full-auto fixture jobs: every data artifact must be part of the
        // fixture profile's fixed inputs (by content hash) — private or
        // external data can never enter a fixture job.
        if (fixtureProfile !== null) {
          const inProfile = fixtureProfile.data.some(d => d.sha256 === record.sha256)
          if (!inProfile) {
            throw new KernelError(422, 'fixture_artifact_outside_profile',
              `data artifact ${id} (${record.sha256}) is not part of the full-auto fixture profile ${fixtureProfile.fixture_id}`)
          }
        }
      }
    }
    // §12.2 (P0, acceptance-tests.md §4): image_digest MUST equal the trusted
    // images.lock entry exactly — tags, `latest`, missing digests and
    // post-commit digest swaps are 422. latex-compile is kernel-owned: a
    // missing digest is injected with the locked texlive entry. An explicit
    // digest inside payload (the HTTP TeX builds route forwards it there) is
    // validated too, so it can never silently diverge from the lock.
    // Full-auto fixture jobs additionally MUST use the profile's pinned
    // image: a different caller-supplied digest is 422 fixture_image_mismatch
    // and an absent digest is bound to the profile image.
    let digestInput = input.image_digest ?? (typeof input.payload?.image_digest === 'string' && input.payload.image_digest !== '' ? input.payload.image_digest : undefined)
    if (fixtureProfile !== null && SECURE_KINDS.includes(input.kind)) {
      if (digestInput !== undefined && digestInput !== fixtureProfile.image) {
        throw new KernelError(422, 'fixture_image_mismatch',
          `full-auto jobs must use the fixture profile image ${fixtureProfile.image} (got ${digestInput})`)
      }
      digestInput = fixtureProfile.image
    }
    let boundImageDigest: string
    if (SECURE_KINDS.includes(input.kind)) {
      const configuredRuntime = runnerTarget.runtime
      if (configuredRuntime !== undefined && fixtureProfile === null && input.kind !== 'latex-compile') {
        if (digestInput !== undefined && digestInput !== configuredRuntime.image_digest) {
          throw new KernelError(422, 'runner_target_image_mismatch',
            `job image ${digestInput} does not match runner target ${runnerTarget.target_id} image ${configuredRuntime.image_digest}`)
        }
        // Registering/updating a target is the PI/Operator allowlist action;
        // RunnerTargetRuntime has already required an immutable digest.
        boundImageDigest = configuredRuntime.image_digest
      } else {
        boundImageDigest = validateImageDigest(input.kind as SecureJobKind, digestInput)
      }
    } else {
      boundImageDigest = input.image_digest ?? runnerTarget.runtime?.image_digest ?? runnerProfile.image
    }

    // METH-01 Protocol-before-run: formal jobs and every confirmatory job
    // must bind an exact, earlier frozen ProtocolRevision.  The protocol's
    // Contract/Code/Data/Environment pins are recomputed from authoritative
    // Kernel objects here; caller-supplied descriptions never establish
    // readiness.  This check deliberately precedes every Job/Run/outbox
    // write, so a failed admission is a zero-write failure.
    const runIntent = ResearchIntent.parse(input.run_intent ?? 'exploratory')
    const protocolRequired = input.kind === 'formal' || runIntent === 'confirmatory'
    const requestedProtocolPin = input.protocol_pin ?? null
    if (protocolRequired || requestedProtocolPin !== null) {
      if (requestedProtocolPin === null) {
        throw new KernelError(422, 'protocol_required', 'formal or confirmatory jobs require an exact frozen protocol_pin')
      }
      let protocol: import('@dsh-scholar/research-schemas').ProtocolRevision
      try {
        protocol = this.methodology.getProtocolRevision(
          project.project_id,
          requestedProtocolPin.protocol_id,
        ).record
      } catch {
        throw new KernelError(422, 'protocol_not_found', `protocol ${requestedProtocolPin.protocol_id} is not registered in project ${project.project_id}`)
      }
      const contract = approvedContractBinding
      if (contract === null) {
        throw new KernelError(422, 'protocol_contract_required', 'protocol-bound jobs require an approved contract_id')
      }
      if (boundCodeSnapshotId === null || boundCodeSnapshotId === '') {
        throw new KernelError(422, 'protocol_code_required', 'protocol-bound jobs require a materialized code snapshot')
      }
      let codeArtifact: ArtifactRecord
      try {
        codeArtifact = this.getArtifact(project.project_id, boundCodeSnapshotId)
      } catch {
        throw new KernelError(422, 'protocol_code_required', 'protocol code pin could not be resolved to an in-project Artifact')
      }
      if (dataArtifactIds.length !== 1) {
        throw new KernelError(422, 'protocol_data_required', 'protocol-bound jobs require exactly one immutable data Artifact (use a dataset bundle Artifact for multiple files)')
      }
      const dataArtifactId = dataArtifactIds[0]!.startsWith('sha256:')
        ? dataArtifactIds[0]!
        : `sha256:${dataArtifactIds[0]!}`
      const dataArtifact = this.getArtifact(project.project_id, dataArtifactId)
      const budget = this.getBudget(project.project_id)
      const boundaryPins = {
        contract: {
          ref: contract.contract_id,
          sha256: `sha256:${sha256Hex(canonicalJson(contract as unknown as Record<string, unknown>))}`,
        },
        code: { ref: boundCodeSnapshotId, sha256: `sha256:${codeArtifact.sha256}` },
        data: { ref: dataArtifactId, sha256: `sha256:${dataArtifact.sha256}` },
        environment: { ref: runnerTarget.target_id, sha256: runnerTargetConfigHash(runnerTarget) },
      }
      const admission = evaluateResearchMethodology({
        operation: 'run_admission',
        project_id: project.project_id,
        requested_at: nowIso(),
        run_class: input.kind === 'formal' ? 'formal' : 'informal',
        intent: runIntent,
        protocol,
        protocol_pin: requestedProtocolPin,
        boundary: {
          contract_approved: contract.status === 'approved' && contract.approval?.gate_decision_id !== undefined,
          budget_available: budget.model_cost_usd <= project.constraints.max_model_cost_usd
            && budget.gpu_hours <= project.constraints.max_gpu_hours
            && project.status !== 'BLOCKED_GATE',
          runner_allowed: runnerAssessment.observedReady,
          network_policy_allowed: project.execution.network_policy === 'none'
            || project.execution.network_policy === 'allowlist',
          pins: boundaryPins,
        },
      })
      if (admission.operation !== 'run_admission') {
        throw new KernelError(500, 'protocol_admission_internal', 'methodology evaluator returned the wrong operation')
      }
      if (!admission.admitted) {
        const first = admission.blockers[0] ?? 'protocol_admission_denied'
        throw new KernelError(422, first === 'protocol_missing' ? 'protocol_required' : first,
          `methodology run admission denied: ${admission.blockers.join(',')}`)
      }
    }
    const payload = {
      ...(input.payload ?? {}),
      // Config writes are project-scoped. Pin the exact effective Project
      // projection used for this submission; the instance pin alone omits
      // execution/integrity changes and cannot reproduce admission later.
      project_config_pin: this.configEffective(project.project_id).config_pin,
      // §12.5 (P0): the Runner validates the metrics FILE against the bound
      // contract's metric names (primary + secondary) — injected here so the
      // runner never trusts client-supplied names.
      ...(contractMetricNames !== undefined ? { contract_metrics: contractMetricNames } : {}),
      // domain-model.md §9.1: secure kinds 固定 opaque runner profile id +
      // profile 记录 config_hash（与 image digest 同一 pin 语义）——runner
      // executeJob 按注册表复算比对，不一致 → environment 失败（不执行）。
      runner_profile_id: runnerProfile.profile_id,
      profile_config_hash: runnerProfile.config_hash,
      runner_target_id: runnerTarget.target_id,
      runner_target_kind: runnerTarget.kind,
      runner_target_revision: runnerTarget.revision,
      runner_target_hash: runnerTargetConfigHash(runnerTarget),
      image_digest: boundImageDigest,
      runner_compute: runnerTarget.runtime?.compute ?? { mode: 'cpu' as const },
      ...(input.data_artifact_ids !== undefined ? { data_artifact_ids: input.data_artifact_ids } : {}),
      ...(input.output_contract !== undefined ? { output_contract: input.output_contract } : {}),
      protocol_pin: requestedProtocolPin,
      run_intent: runIntent,
    }
    const job: JobSpecBound = {
      job_id: randomId('job'),
      project_id: input.project_id,
      contract_id: input.contract_id ?? null,
      idempotency_key: input.idempotency_key,
      kind: input.kind,
      command: input.command ?? [],
      payload,
      status: 'queued',
      failure_class: null,
      lease_owner: null,
      lease_expires_at: null,
      heartbeat_at: null,
      lease_generation: null,
      lease_token: null,
      code_snapshot_id: boundCodeSnapshotId,
      data_artifact_ids: input.data_artifact_ids ?? [],
      image_digest: String(payload.image_digest),
      // domain-model.md §9.1: Job 固定 opaque profile id + config hash
      // （secure kinds 由上方 payload 注入；其余 kind 为 null）。
      runner_profile_id: typeof payload.runner_profile_id === 'string' && payload.runner_profile_id !== '' ? payload.runner_profile_id : null,
      profile_config_hash: typeof payload.profile_config_hash === 'string' && payload.profile_config_hash !== '' ? payload.profile_config_hash : null,
      protocol_pin: requestedProtocolPin,
      run_intent: runIntent,
      // v2 shape (domain-model.md §9): durable submitter principal (server
      // resolves it from x-principal-id; internal submissions → NULL).
      created_by_principal_id: input.created_by_principal_id ?? null,
      output_contract: input.output_contract,
      attempts: 0,
      max_attempts: input.max_attempts ?? 3,
      run_manifest: null,
      error: '',
      created_at: nowIso(),
      updated_at: nowIso(),
    }
    // MIG-V1 (0017, storage-migrations.md §9): echo/smoke are the in-process
    // FIXTURE kinds (echo executes nothing, §3.2 invariant 1; smoke is a
    // trusted fixture) — new fixture jobs are written with
    // synthetic_fixture=1 so audits/statistics can separate fixture runs
    // from real experiments (legacy rows were backfilled by 0017).
    const syntheticFixture = input.kind === 'echo' || input.kind === 'smoke' ? 1 : 0
    this.db.prepare(
      `INSERT INTO jobs (job_id, project_id, contract_id, idempotency_key, kind, command, payload, status, failure_class, lease_owner, lease_expires_at, heartbeat_at, attempts, max_attempts, run_manifest, error, created_at, updated_at, code_snapshot_id, created_by_principal_id, synthetic_fixture)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      job.job_id, job.project_id, job.contract_id, job.idempotency_key, job.kind, JSON.stringify(job.command),
      JSON.stringify(job.payload), job.status, job.failure_class, job.lease_owner, job.lease_expires_at,
      job.heartbeat_at, job.attempts, job.max_attempts, job.run_manifest === null ? null : JSON.stringify(job.run_manifest),
      job.error, job.created_at, job.updated_at, job.code_snapshot_id, job.created_by_principal_id,
      syntheticFixture,
    )
    this.emit(input.project_id, 'job.submitted', { job_id: job.job_id, kind: job.kind, idempotency_key: input.idempotency_key })
    return job
  }

  /**
   * Atomic Contract → baseline execution handoff and matched-seed append.
   *
   * A Contract Gate freezes scientific intent, not executable code. This is
   * therefore the only path that may create the first contract-bound
   * baseline Job and advance CONTRACT_APPROVED → BASELINE_REPRO. Validation,
   * Job/outbox writes and the phase transition share one SQLite transaction,
   * so callers can never observe a queued Job with the old phase (or the new
   * phase without its Job). Once in BASELINE_REPRO, the same endpoint may
   * append another run for the active approved Contract without changing the
   * Project revision; generic Job submission is never a baseline entrypoint.
   */
  startBaselineRun(input: {
    project_id: string
    expected_revision: number
    idempotency_key: string
    contract_id: string
    code_snapshot_id: string
    seed?: number
    data_artifact_ids?: string[]
    command: string[]
    runner_target_id?: string | null
    image_digest?: string
    output_contract?: { metrics: string; logs: string }
    created_by_principal_id?: string | null
  }): { project: ResearchProject; job: JobSpecBound } {
    const command = input.command.map(part => part.trim())
    if (command.length === 0 || command.some(part => part === '')) {
      throw new KernelError(422, 'baseline_command_required', 'baseline run requires a non-empty argv array')
    }
    if (input.seed !== undefined && !Number.isSafeInteger(input.seed)) {
      throw new KernelError(422, 'baseline_seed_invalid', 'baseline seed must be a safe integer')
    }
    if ((input.data_artifact_ids?.length ?? 0) > 1) {
      throw new KernelError(422, 'baseline_data_artifact_limit', 'baseline run accepts at most one Data Artifact')
    }
    const requestHash = `sha256:${createHash('sha256').update(JSON.stringify({
      expected_revision: input.expected_revision,
      contract_id: input.contract_id,
      code_snapshot_id: input.code_snapshot_id,
      seed: input.seed ?? null,
      data_artifact_ids: input.data_artifact_ids ?? [],
      command,
      runner_target_id: input.runner_target_id ?? null,
      image_digest: input.image_digest ?? null,
      output_contract: input.output_contract ?? null,
      created_by_principal_id: input.created_by_principal_id ?? null,
    })).digest('hex')}`

    return withTransaction(this.db, () => {
      const current = this.getProject(input.project_id)
      const existingRow = this.db.prepare('SELECT * FROM jobs WHERE project_id = ? AND idempotency_key = ?')
        .get(input.project_id, input.idempotency_key) as JobRow | undefined
      if (existingRow !== undefined) {
        const existing = jobFromRow(existingRow, this.db, this.leaseTokens.get(existingRow.job_id) ?? null)
        if (existing.payload.baseline_start_request_hash !== requestHash) {
          throw new KernelError(409, 'idempotency_conflict', `idempotency key ${input.idempotency_key} was already used with a different baseline request`)
        }
        return { project: current, job: existing }
      }
      if (current.revision !== input.expected_revision) {
        throw new KernelError(409, 'revision_conflict', `expected revision ${input.expected_revision}, got ${current.revision}`)
      }
      if (current.status !== 'CONTRACT_APPROVED' && current.status !== 'BASELINE_REPRO') {
        throw new KernelError(409, 'baseline_start_not_ready',
          `baseline run requires CONTRACT_APPROVED or BASELINE_REPRO, got ${current.status}`)
      }
      if (current.status === 'BASELINE_REPRO') {
        const firstBaseline = this.db.prepare(
          `SELECT contract_id FROM jobs
           WHERE project_id = ? AND kind = 'baseline'
           ORDER BY created_at ASC, job_id ASC LIMIT 1`,
        ).get(input.project_id) as { contract_id: string | null } | undefined
        if (firstBaseline?.contract_id === undefined || firstBaseline.contract_id === null) {
          throw new KernelError(409, 'baseline_start_not_ready',
            'additional baseline runs require an existing contract-bound baseline Job')
        }
        if (firstBaseline.contract_id !== input.contract_id) {
          throw new KernelError(422, 'baseline_contract_mismatch',
            `additional baseline contract ${input.contract_id} does not match the active baseline contract ${firstBaseline.contract_id}`)
        }
      }

      const targetId = input.runner_target_id ?? current.execution.runner_target_id
      const target = this.listRunnerTargets().find(candidate => candidate.target_id === targetId)
      if (target === undefined) {
        throw new KernelError(422, 'runner_target_unknown', `runner target '${targetId}' is not registered`)
      }
      const imageDigest = input.image_digest ?? target.runtime?.image_digest ?? getLockedDigest('node_fixture')
      const outputContract = input.output_contract ?? {
        metrics: '/outputs/metrics.json',
        logs: '/outputs/run.log',
      }
      const job = this.submitJob({
        project_id: input.project_id,
        idempotency_key: input.idempotency_key,
        kind: 'baseline',
        command,
        payload: {
          message: 'approved contract baseline reproduction',
          baseline_start_request_hash: requestHash,
          ...(input.seed !== undefined ? { seed: input.seed } : {}),
          ...(input.data_artifact_ids?.length === 1
            ? { data_hash: input.data_artifact_ids[0]!.startsWith('sha256:') ? input.data_artifact_ids[0]! : `sha256:${input.data_artifact_ids[0]!}` }
            : {}),
        },
        contract_id: input.contract_id,
        code_snapshot_id: input.code_snapshot_id,
        data_artifact_ids: input.data_artifact_ids,
        runner_target_id: targetId,
        image_digest: imageDigest,
        output_contract: outputContract,
        created_by_principal_id: input.created_by_principal_id ?? null,
      })
      const project = current.status === 'CONTRACT_APPROVED'
        ? this.transition(
            input.project_id,
            'BASELINE_REPRO',
            current.revision,
            `baseline job ${job.job_id} submitted from approved contract ${input.contract_id}`,
          )
        : current
      return { project, job }
    })
  }

  getJob(jobId: string): JobSpecBound & { run_id: string | null } {
    const row = this.db.prepare('SELECT * FROM jobs WHERE job_id = ?').get(jobId) as JobRow | undefined
    if (row === undefined) throw new KernelError(404, 'job_not_found', `job ${jobId} not found`)
    // STORE-06: only a live process-local claim may expose plaintext.
    return jobFromRow(row, this.db, this.leaseTokens.get(jobId) ?? null)
  }

  /**
   * Phase-3 research outcome closure. A caller may describe the scientific
   * outcome of exactly one authoritative terminal Job, but cannot choose its
   * execution state, intent, Protocol binding, classification, finding kind
   * or authority. Those facts are re-derived here and the immutable envelope
   * is appended atomically by MethodologyStore.
   *
   * This deliberately emits no Project transition, Gate/Release decision,
   * Evidence acceptance or Claim mutation. The only derived relation is a
   * proposal, which remains proposal-only until the existing authorities act.
   */
  recordResearchRunOutcome(rawInput: ResearchRunOutcomeWriteValue, classifiedByPrincipalId: string) {
    const input = ResearchRunOutcomeWrite.parse(rawInput)
    const requested = input.record
    this.getProject(requested.project_id)
    const existingOutcomes = this.methodology.listResearchRunOutcomes(requested.project_id).outcomes
      .map(item => item.outcome)
    const observation = getRunOutcomeObservation(
      this.db,
      requested.project_id,
      requested.run_ref,
      existingOutcomes,
    )
    if (observation === null) {
      throw new KernelError(
        404,
        'research_run_observation_not_found',
        `unclassified Runner observation ${requested.run_ref} not found in project ${requested.project_id}`,
      )
    }

    let job: ReturnType<ResearchKernel['getJob']>
    try {
      job = this.getJob(observation.job_id)
    } catch (error) {
      if (error instanceof KernelError && error.status === 404) {
        throw new KernelError(404, 'research_run_job_not_found', `terminal job ${observation.job_id} not found in project ${requested.project_id}`)
      }
      throw error
    }
    if (job.project_id !== requested.project_id) {
      throw new KernelError(404, 'research_run_job_not_found', `terminal job ${observation.job_id} not found in project ${requested.project_id}`)
    }
    if (job.status !== 'succeeded' && job.status !== 'failed' && job.status !== 'cancelled') {
      throw new KernelError(409, 'research_run_job_not_terminal', `job ${job.job_id} is ${job.status}; a research outcome requires a terminal Job`)
    }

    const run = this.getRun(requested.project_id, observation.run_id)
    const manifest = job.run_manifest ?? undefined
    if (run.job_id !== observation.job_id
      || run.attempt_no !== observation.attempt_no
      || job.attempts !== observation.attempt_no
      || job.lease_generation !== observation.lease_generation
      || canonicalManifestSha256(manifest) !== observation.manifest_sha256
      || JSON.stringify(job.protocol_pin) !== JSON.stringify(observation.protocol_pin)
      || job.run_intent !== observation.intent) {
      throw new KernelError(
        409,
        'research_run_observation_stale',
        `Runner observation ${observation.observation_id} no longer exactly matches its Job/run/attempt/lease/manifest/Protocol bindings`,
      )
    }

    const record = ResearchRunRecord.parse({
      ...requested,
      job_execution: observation.job_execution,
      intent: observation.intent,
      protocol_pin: observation.protocol_pin,
    })

    if (observation.job_execution !== 'succeeded') {
      const infrastructureFailure = observation.job_execution === 'timed_out'
        || observation.failure_class === 'environment'
        || observation.failure_class === 'resources'
      const expectedValidity = infrastructureFailure ? 'infrastructure_failure' : 'invalid'
      if (record.outcome !== 'inconclusive' || record.validity !== expectedValidity) {
        throw new KernelError(
          422,
          'research_run_execution_classification_mismatch',
          `terminal ${observation.job_execution} job must be recorded as inconclusive/${expectedValidity}`,
        )
      }
    } else if (record.validity === 'infrastructure_failure') {
      throw new KernelError(
        422,
        'research_run_execution_classification_mismatch',
        'a succeeded Job cannot be classified as an infrastructure failure',
      )
    }

    let analysisArtifact: ArtifactRecord | null = null
    if (record.analysis_artifact_id !== null) {
      try {
        analysisArtifact = this.getArtifact(record.project_id, record.analysis_artifact_id)
      } catch (error) {
        if (error instanceof KernelError && error.status === 404) {
          throw new KernelError(422, 'research_run_analysis_artifact_not_found', `analysis Artifact ${record.analysis_artifact_id} is not registered in project ${record.project_id}`)
        }
        throw error
      }
      if (analysisArtifact.kind !== 'analysis' || !this.cas.has(analysisArtifact.sha256)) {
        throw new KernelError(422, 'research_run_analysis_artifact_invalid', `analysis Artifact ${record.analysis_artifact_id} is not a present analysis CAS object`)
      }
    }

    const projectEvidence = this.listEvidence(record.project_id)
    const evidence = record.evidence_refs.map(evidenceRef => {
      const item = projectEvidence.find(candidate => candidate.evidence_id === evidenceRef)
      if (item === undefined) {
        throw new KernelError(422, 'research_run_evidence_not_found', `Evidence ${evidenceRef} is not registered in project ${record.project_id}`)
      }
      return item
    })

    const report = evaluateResearchMethodology({ operation: 'run_classification', record })
    if (report.operation !== 'run_classification') {
      throw new KernelError(500, 'research_run_classification_internal', 'methodology evaluator returned the wrong operation')
    }
    const classification = ResearchRunClassification.parse({
      interpretation: report.interpretation,
      negative_finding_eligible: report.negative_finding_eligible,
      claim_authority: report.claim_authority,
    })
    const needsProposal = classification.negative_finding_eligible
      || classification.interpretation === 'hypothesis_proposal'
    if (needsProposal !== (input.claim_proposal !== null)) {
      throw new KernelError(
        422,
        needsProposal ? 'research_run_claim_proposal_required' : 'research_run_claim_proposal_not_allowed',
        needsProposal
          ? `classification ${classification.interpretation} requires proposal-only Claim content`
          : `classification ${classification.interpretation} cannot create a Claim proposal`,
      )
    }

    if (classification.negative_finding_eligible) {
      if (analysisArtifact === null || record.protocol_pin === null || evidence.length === 0) {
        throw new KernelError(422, 'research_run_negative_finding_incomplete', 'negative finding requires a frozen Protocol, analysis Artifact and Evidence')
      }
      for (const item of evidence) {
        const bindsJob = item.run_ids.includes(job.job_id)
          || (job.run_id !== null && item.run_ids.includes(job.run_id))
        if (!bindsJob || !item.artifact_refs.includes(analysisArtifact.artifact_id)) {
          throw new KernelError(422, 'research_run_evidence_binding_mismatch', `Evidence ${item.evidence_id} is not exactly bound to Job ${job.job_id} and analysis Artifact ${analysisArtifact.artifact_id}`)
        }
      }
    }

    const proposal = input.claim_proposal === null ? null : ResearchClaimProposal.parse({
      ...input.claim_proposal,
      project_id: record.project_id,
      run_ref: record.run_ref,
      proposal_kind: classification.negative_finding_eligible ? 'negative_finding' : 'hypothesis',
      statement: input.claim_proposal.statement,
      analysis_artifact_id: record.analysis_artifact_id,
      evidence_refs: classification.negative_finding_eligible ? record.evidence_refs : [],
      status: 'proposed',
      authority: 'proposal_only',
      created_at: record.recorded_at,
    })
    const safeRunId = /^[a-z0-9_]+$/.test(record.run_ref)
      ? record.run_ref
      : createHash('sha256').update(record.run_ref).digest('hex').slice(0, 24)
    const finding = classification.negative_finding_eligible
      ? NegativeFinding.parse({
          finding_id: `negative_finding_${safeRunId}`,
          project_id: record.project_id,
          run_ref: record.run_ref,
          protocol_pin: record.protocol_pin,
          outcome: 'negative',
          validity: 'valid',
          analysis_artifact_id: record.analysis_artifact_id,
          evidence_refs: record.evidence_refs,
          claim_proposal_id: proposal!.proposal_id,
          created_at: record.recorded_at,
        })
      : null
    const outcome = ResearchRunOutcome.parse({ run: record, classification, negative_finding: finding, claim_proposal: proposal })
    return withTransaction(this.db, () => {
      const receipt = this.methodology.recordResearchRunOutcome({ outcome, expected_revision: input.expected_revision })
      if (receipt.replayed) return receipt

      const classifiedEvent = this.emit(record.project_id, 'research.run.classified', {
        project_id: record.project_id,
        run_ref: record.run_ref,
        observation_id: observation.observation_id,
        classified_by_principal_id: classifiedByPrincipalId,
        outcome: record.outcome,
        validity: record.validity,
        interpretation: classification.interpretation,
        valid_cycle: record.job_execution === 'succeeded' && record.validity === 'valid',
        run_stream_revision: receipt.run_stream_revision,
      })
      const synthesis = this.evaluateSynthesisRequest(record.project_id, record.run_ref, classifiedEvent.event_seq ?? 0,
        classification.negative_finding_eligible)
      if (synthesis !== null) this.emit(record.project_id, 'research.synthesis.requested', synthesis)
      return receipt
    })
  }

  /** Strict execution-only observations, including whether each has a
   * matching immutable scientific classification. Durable outbox rows are
   * the source; a process restart cannot lose pending work. */
  listRunOutcomeObservations(projectId: string) {
    this.getProject(projectId)
    return listRunOutcomeObservationLedger(
      this.db,
      projectId,
      this.methodology.listResearchRunOutcomes(projectId).outcomes.map(item => item.outcome),
    )
  }

  listSynthesisRecordRequests(projectId: string) {
    this.getProject(projectId)
    return listSynthesisRecordRequests(
      this.db,
      projectId,
      this.methodology.listResearchSyntheses(projectId).records.map(item => item.record.window),
    )
  }

  /** Invoke the existing pure synthesis trigger policy after one immutable
   * classification. A trigger creates only a durable request/NextAction; it
   * never creates synthesis content or mutates Project/Gate/Release state. */
  private evaluateSynthesisRequest(
    projectId: string,
    triggerRunRef: string,
    currentEventSeq: number,
    majorCounterevidence: boolean,
  ) {
    const project = this.getProject(projectId)
    const syntheses = this.methodology.listResearchSyntheses(projectId).records.map(item => item.record)
    const latest = syntheses.at(-1)
    const checkpoint = latest === undefined
      ? { event_seq: 0, project_revision: 0, next_action_revision: 0 }
      : {
          event_seq: latest.window.to_event_seq,
          project_revision: latest.snapshot_pin.project_revision,
          next_action_revision: latest.snapshot_pin.next_action_revision,
        }
    const classified = this.listEvents(projectId)
      .filter(event => event.kind === 'research.run.classified'
        && (event.event_seq ?? 0) > checkpoint.event_seq
        && event.payload.valid_cycle === true)
    const budget = this.getBudget(projectId)
    const remainingRatio = (used: number, limit: number): number => limit <= 0
      ? (used <= 0 ? 1 : 0)
      : Math.max(0, Math.min(1, (limit - used) / limit))
    const budgetRemainingRatio = Math.min(
      remainingRatio(budget.model_cost_usd, project.constraints.max_model_cost_usd),
      remainingRatio(budget.gpu_hours, project.constraints.max_gpu_hours),
    )
    const report = evaluateResearchMethodology({
      operation: 'synthesis_trigger',
      project_id: projectId,
      checkpoint,
      current: {
        event_seq: currentEventSeq,
        project_revision: project.revision,
        next_action_revision: project.revision,
        valid_cycles_since_checkpoint: classified.length,
        stagnant_cycles: 0,
        budget_remaining_ratio: budgetRemainingRatio,
      },
      policy: {
        // The first complete classified cycle closes the smallest working
        // inner→outer loop. No Settings key exists until a real policy
        // consumer and durable policy contract are introduced together.
        valid_cycles_threshold: 1,
        stagnation_cycles_threshold: 3,
        budget_remaining_ratio_lte: 0.1,
        enabled_events: ['major_counterevidence', 'contract_stopping_condition', 'budget_threshold', 'corpus_revision_changed', 'review_blocked'],
      },
      events: majorCounterevidence ? [{
        event_id: `counterevidence_${triggerRunRef}`,
        project_id: projectId,
        event_seq: currentEventSeq,
        kind: 'major_counterevidence',
      }] : [],
      human_requested: false,
    })
    if (report.operation !== 'synthesis_trigger' || !report.triggered) return null
    return buildSynthesisRecordRequest({
      project_id: projectId,
      trigger_run_ref: triggerRunRef,
      source_run_refs: classified.map(event => {
        const payload = event.payload as { run_ref?: unknown }
        if (typeof payload.run_ref !== 'string' || payload.run_ref === '') {
          throw new KernelError(500, 'synthesis_classified_event_invalid', 'classified run event is missing run_ref')
        }
        return payload.run_ref
      }),
      reasons: report.reasons,
      window: report.window,
      snapshot_pin: report.snapshot_pin,
      requested_at: nowIso(),
    })
  }

  listJobs(projectId: string, status?: JobStatus): Array<JobSpecBound & { run_id: string | null }> {
    const rows = status === undefined
      ? this.db.prepare('SELECT * FROM jobs WHERE project_id = ? ORDER BY created_at').all(projectId) as unknown as JobRow[]
      : this.db.prepare('SELECT * FROM jobs WHERE project_id = ? AND status = ? ORDER BY created_at').all(projectId, status) as unknown as JobRow[]
    return rows.map(row => jobFromRow(row, this.db, this.leaseTokens.get(row.job_id) ?? null))
  }

  /** §3.1 / RUN-01: durable per-attempt run rows of a project (claim-time
   * identity + completion manifest/signature status), newest first. */
  listRuns(projectId: string): RunRecord[] {
    this.getProject(projectId)
    const rows = this.db.prepare('SELECT * FROM runs WHERE project_id = ? ORDER BY started_at DESC').all(projectId) as unknown as RunRow[]
    return rows.map(runFromRow)
  }

  /** §3.1 / RUN-01: single run attempt, project-scoped (404 when unknown). */
  getRun(projectId: string, runId: string): RunRecord {
    this.getProject(projectId)
    const row = this.db.prepare('SELECT * FROM runs WHERE run_id = ? AND project_id = ?').get(runId, projectId) as RunRow | undefined
    if (row === undefined) throw new KernelError(404, 'run_not_found', `run ${runId} not found in project ${projectId}`)
    return runFromRow(row)
  }

  /** Claim queued/retryable jobs for an owner with a lease TTL (design §9.3, §12.6).
   * Every claim bumps `lease_generation` and issues a fresh opaque
   * `lease_token`; runners must echo both on heartbeat/complete, and stale
   * generations are fenced out (an old runner can never finish the job).
   * RUN-01 (P0): each claimed job carries the durable `run_id` of the runs
   * row written for THIS attempt — the runner must use it for manifest,
   * terminal frames and evidence instead of minting its own run identity. */
  claimJobs(
    owner: string,
    leaseTtlSeconds = 300,
    limit = 8,
    targetFilter?: {
      runner_target_kinds?: Array<'local-process' | 'local-docker' | 'remote-ssh'>
      runner_target_ids?: string[]
      include_unpinned?: boolean
    },
  ): Array<JobSpecBound & { run_id: string | null }> {
    const now = nowIso()
    const targetKinds = targetFilter?.runner_target_kinds ?? []
    const targetIds = targetFilter?.runner_target_ids ?? []
    const includeUnpinned = targetFilter?.include_unpinned === true
    const statusWhere = `(status = 'queued' OR (status = 'retryable' AND attempts < max_attempts))`
    const kindWhere = targetKinds.length === 0 ? ''
      : ` AND (json_extract(payload, '$.runner_target_kind') IN (${targetKinds.map(() => '?').join(',')})${includeUnpinned ? " OR json_extract(payload, '$.runner_target_kind') IS NULL" : ''})`
    const idWhere = targetIds.length === 0 ? ''
      : ` AND (json_extract(payload, '$.runner_target_id') IN (${targetIds.map(() => '?').join(',')})${includeUnpinned ? " OR json_extract(payload, '$.runner_target_id') IS NULL" : ''})`
    // Target-aware claim is the first line of defence against a local runner
    // leasing a remote-ssh job (or a subprocess runner leasing a Docker job).
    // executeJob/ExecutionTarget perform the same check again before spawn.
    // Do not apply the lease limit in SQL: target revision/state validation
    // happens below against the current registry, so a stale early row must
    // not consume the limit and starve a later valid job for the same exact
    // target. We stop after `limit` successful CAS leases instead.
    const rows = this.db.prepare(
      `SELECT * FROM jobs WHERE ${statusWhere}${kindWhere}${idWhere} ORDER BY created_at`,
    ).all(...targetKinds, ...targetIds) as unknown as JobRow[]
    const claimed: Array<JobSpecBound & { run_id: string | null }> = []
    const targets = new Map(this.listRunnerTargets().map(target => [target.target_id, target]))
    // STORE-06 (storage-migrations.md §4): the claim persists ONLY the
    // sha256 of the opaque token (jobs.lease_token_hash) — the plaintext
    // never touches the database, it lives in kernel memory (this.leaseTokens)
    // and is returned to the runner on the claim response.
    const update = this.db.prepare(
      `UPDATE jobs SET status = 'running', lease_owner = ?, lease_expires_at = ?, heartbeat_at = ?, attempts = attempts + 1, lease_generation = COALESCE(lease_generation, 0) + 1, lease_token_hash = ?, payload = ?, updated_at = ? WHERE job_id = ? AND (status = 'queued' OR status = 'retryable')`,
    )
    for (const row of rows) {
      if (claimed.length >= limit) break
      const leaseExpires = new Date(Date.now() + leaseTtlSeconds * 1000).toISOString()
      const payload = jsonParse(row.payload, {} as Record<string, unknown>)
      const pinnedTargetId = typeof payload.runner_target_id === 'string' && payload.runner_target_id !== '' ? payload.runner_target_id : null
      if (pinnedTargetId !== null) {
        const currentTarget = targets.get(pinnedTargetId)
        if (currentTarget === undefined || !currentTarget.enabled || currentTarget.draining) continue
        if (payload.runner_target_kind !== currentTarget.kind
          || payload.runner_target_revision !== currentTarget.revision
          || payload.runner_target_hash !== runnerTargetConfigHash(currentTarget)) continue
      }
      const leaseToken = `lt_${randomUUID().replaceAll('-', '')}${randomUUID().slice(0, 8)}`
      // execution-runtime.md §3 / storage-migrations.md §4: a claim is ONE
      // transaction — UPDATE jobs (running + lease + generation + token
      // hash) and INSERT runs (durable attempt identity) commit atomically,
      // so a crash between them can never leave a running job without its
      // run row or a run row on an unclaimed job. (The tex_builds status
      // sync below runs AFTER the commit: TexWorkspaceStore owns a separate
      // connection to the same file, so it must not write inside the kernel
      // txn.)
      const claimedRow = withTransaction(this.db, () => {
        const result = update.run(owner, leaseExpires, now, sha256Hex(leaseToken), JSON.stringify(payload), now, row.job_id)
        if (Number(result.changes) !== 1) return null
        this.leaseTokens.set(row.job_id, leaseToken)
        const claimedJob = jobFromRow(this.db.prepare('SELECT * FROM jobs WHERE job_id = ?').get(row.job_id) as unknown as JobRow, this.db, leaseToken)
        // §3.1 / RUN-01 (Run attempt): every claim records a runs row — the
        // durable per-attempt identity (attempt_no = attempts after claim).
        // run_id is run_<12 hex>; snapshot_sha256 is the CAS sha256 resolved
        // from the job's code_snapshot_id ('' → NULL when the job has none).
        // P0: the run_id is generated HERE and returned on the claimed job so
        // the runner never mints a parallel run identity.
        const runId = randomId('run')
        this.db.prepare(
          `INSERT INTO runs (run_id, project_id, job_id, attempt_no, contract_id, snapshot_sha256, signature_status, started_at)
           VALUES (?, ?, ?, ?, ?, ?, 'pending', ?)`,
        ).run(
          runId, claimedJob.project_id, claimedJob.job_id, claimedJob.attempts,
          claimedJob.contract_id, this.resolveSnapshotSha256(claimedJob.code_snapshot_id), now,
        )
        return { claimedJob, runId }
      })
      if (claimedRow !== null) {
        claimed.push({ ...claimedRow.claimedJob, run_id: claimedRow.runId })
        // OBS-01: one claim counter per successfully claimed job.
        this.metrics.count('job.claimed')
        // §12.1 (TEX-03): a claimed latex-compile job moves its tex_builds
        // row queued → running, so preview supersede can distinguish a
        // never-started queued preview (→ cancelled) from a running one
        // (→ superseded).
        const texBuildRow = this.db.prepare('SELECT build_id, status FROM tex_builds WHERE job_id = ?').get(claimedRow.claimedJob.job_id) as { build_id: string; status: string } | undefined
        if (texBuildRow !== undefined && texBuildRow.status === 'queued') {
          this.tex.updateBuild(texBuildRow.build_id, { status: 'running' })
        }
      }
    }
    return claimed
  }

  /**
   * §3.1 / RUN-01: resolve the CAS sha256 recorded on a runs row from a job's
   * `code_snapshot_id`. `sha256:<hex>` artifact ids and raw 64-hex hashes are
   * used verbatim; `code_snap_` registry ids resolve through the
   * authoritative code_snapshots registry (its archive artifact sha256).
   * Jobs without a code snapshot (echo/smoke/latex-compile) yield null.
   */
  private resolveSnapshotSha256(codeSnapshotId: string | null): string | null {
    if (codeSnapshotId === null || codeSnapshotId === '') return null
    if (codeSnapshotId.startsWith('sha256:')) return codeSnapshotId.slice('sha256:'.length)
    if (/^[0-9a-f]{64}$/.test(codeSnapshotId)) return codeSnapshotId
    if (codeSnapshotId.startsWith('code_snap_')) {
      try {
        return this.getCodeSnapshot(codeSnapshotId).sha256
      } catch {
        return null
      }
    }
    return null
  }

  /**
   * STORE-06 (storage-migrations.md §4): the persisted lease credential of a
   * job — the sha256 stored in jobs.lease_token_hash.
   */
  private leaseHashOf(jobId: string): string | null {
    const row = this.db.prepare('SELECT lease_token_hash FROM jobs WHERE job_id = ?').get(jobId) as { lease_token_hash: string | null } | undefined
    const hash = row?.lease_token_hash ?? null
    return hash !== null && hash !== '' ? hash : null
  }

  /**
   * STORE-06: fencing comparison for a caller-supplied lease token. The
   * comparison object is the sha256 of the token (jobs.lease_token_hash).
   * Missing or malformed durable hashes fail closed.
   */
  private leaseTokenMatches(jobId: string, provided: string | null | undefined): boolean {
    if (provided === undefined || provided === null) return false
    const hash = this.leaseHashOf(jobId)
    return hash !== null && hash === sha256Hex(provided)
  }

  /**
   * Renew a lease (heartbeat); rejects when owned by another instance.
   * §12.6: when `generation`/`token` are provided the lease is fenced —
   * both must match the CURRENT lease, otherwise 409 `lease_stale`.
   * Legacy callers that pass neither keep the old owner-only check.
   * STORE-06: the token half of the fence compares sha256(provided) against
   * jobs.lease_token_hash; a missing hash fails closed.
   */
  heartbeatJob(jobId: string, owner: string, generation?: number | null, token?: string | null, leaseTtlSeconds = 300): JobRecord {
    const job = this.getJob(jobId)
    if (job.lease_owner !== null && job.lease_owner !== owner) {
      throw new KernelError(409, 'lease_conflict', `job ${jobId} leased by ${job.lease_owner}`)
    }
    // P0 fencing (acceptance-tests.md §4): a leased job's heartbeat MUST
    // carry the current owner's generation AND token — missing fields are
    // stale, not "unfenced" (no owner-only compatibility pass).
    if (job.lease_owner !== null && (generation === undefined || generation === null || token === undefined || token === null)) {
      throw new KernelError(409, 'lease_stale',
        `job ${jobId} heartbeat missing lease fencing fields: expected generation ${job.lease_generation ?? 'n/a'} token hash ${this.leaseHashOf(jobId) ?? 'n/a'}`)
    }
    if ((generation !== undefined && generation !== null) || (token !== undefined && token !== null)) {
      if (job.lease_generation !== (generation ?? null) || !this.leaseTokenMatches(jobId, token)) {
        throw new KernelError(409, 'lease_stale',
          `job ${jobId} lease is stale: expected generation ${job.lease_generation ?? 'n/a'} token hash ${this.leaseHashOf(jobId) ?? 'n/a'}, got generation ${generation ?? 'n/a'} token ${token ?? 'n/a'}`)
      }
    }
    const now = nowIso()
    const leaseExpires = new Date(Date.now() + leaseTtlSeconds * 1000).toISOString()
    this.db.prepare('UPDATE jobs SET lease_owner = ?, lease_expires_at = ?, heartbeat_at = ?, updated_at = ? WHERE job_id = ?')
      .run(owner, leaseExpires, now, now, jobId)
    return this.getJob(jobId)
  }

  /** Recover stale leases after a runner crash (design §9.3). */
  recoverExpiredLeases(now = Date.now()): number {
    // STORE-06: recovered leases drop their in-memory plaintext token — the
    // next claim issues a fresh token (generation bumps) and a new hash.
    const stale = this.db.prepare(
      "SELECT job_id FROM jobs WHERE status = 'running' AND lease_expires_at IS NOT NULL AND lease_expires_at < ?",
    ).all(new Date(now).toISOString()) as Array<{ job_id: string }>
    const result = this.db.prepare(
      `UPDATE jobs SET status = 'retryable', lease_owner = NULL, lease_expires_at = NULL, updated_at = ? WHERE status = 'running' AND lease_expires_at IS NOT NULL AND lease_expires_at < ?`,
    ).run(nowIso(), new Date(now).toISOString())
    for (const s of stale) this.leaseTokens.delete(s.job_id)
    const changes = Number(result.changes)
    // OBS-01: lease expiry counter accumulates the recovered-job count.
    if (changes > 0) this.metrics.count('lease.expiry', undefined, changes)
    return changes
  }

  /**
   * Finalize a job with a validated RunManifest (design §4.6.1, §6.5, §12.6-12.7).
   * §12.6 fencing: when `lease_generation`/`lease_token` are provided both must
   * match the CURRENT lease — a stale runner (old generation/token) is rejected
   * with 409 `lease_stale` even if its owner matches. Legacy callers that pass
   * neither keep the old owner-only check.
   * §12.7: when the manifest carries an Ed25519 `signature`, the kernel
   * verifies runner key registration, payload hash and signature; when it does
   * not, the manifest is accepted unless the kernel/project requires signing.
   */
  completeJob(input: {
    job_id: string
    owner: string
    status: 'succeeded' | 'failed' | 'cancelled'
    run_manifest?: Record<string, unknown>
    failure_class?: JobRecord['failure_class']
    error?: string
    lease_generation?: number | null
    lease_token?: string | null
  }): JobRecord {
    const job = this.getJob(input.job_id)
    if (job.lease_owner !== null && job.lease_owner !== input.owner) {
      throw new KernelError(409, 'lease_conflict', `job ${input.job_id} leased by ${job.lease_owner}`)
    }
    if (job.status !== 'running') {
      throw new KernelError(409, 'job_not_running', `job ${input.job_id} is ${job.status}, not running`)
    }
    // §12.6 strict lease fencing (P0): completion of a leased job MUST carry
    // the current generation AND token — missing fields are rejected 409.
    // STORE-06: the token half of the fence compares sha256(provided)
    // against jobs.lease_token_hash; a missing hash fails closed.
    if ((input.lease_generation === undefined || input.lease_generation === null) || (input.lease_token === undefined || input.lease_token === null)) {
      throw new KernelError(409, 'lease_stale',
        `job ${input.job_id} completion missing lease fencing fields: expected generation ${job.lease_generation ?? 'n/a'} token hash ${this.leaseHashOf(input.job_id) ?? 'n/a'}`)
    }
    if (job.lease_generation !== input.lease_generation || !this.leaseTokenMatches(input.job_id, input.lease_token)) {
      throw new KernelError(409, 'lease_stale',
        `job ${input.job_id} lease is stale: expected generation ${job.lease_generation ?? 'n/a'} token hash ${this.leaseHashOf(input.job_id) ?? 'n/a'}, got generation ${input.lease_generation ?? 'n/a'} token ${input.lease_token ?? 'n/a'}`)
    }
    // RUN-01 (P0): a SUCCEEDED completion MUST carry a RunManifest — a real
    // run that finished without one is a protocol violation, not a success
    // (422 run_manifest_required). echo/smoke are the in-process FIXTURE
    // kinds (echo executes nothing, §3.2 invariant 1; smoke is a trusted
    // fixture) — every kind that actually executes work (baseline/pilot/
    // formal/reproduce/analysis/latex-compile) is enforced.
    if (input.status === 'succeeded' && input.run_manifest === undefined && job.kind !== 'echo' && job.kind !== 'smoke') {
      throw new KernelError(422, 'run_manifest_required',
        `job ${input.job_id} (${job.kind}) succeeded without a run manifest — succeeded completions must carry run_manifest (RUN-01)`)
    }
    if (input.run_manifest !== undefined) {
      this.verifyRunManifest(input.run_manifest, job)
      // RUN-REMOTE-01（hardening-v0.2-status.md §5 两行 / acceptance
      // remote-identity-fencing-manifest）：secure kinds 的 run_id 全链绑定
      // （manifest.run_id === 本 attempt 的 runs.run_id）+ required facts
      // （metrics_artifact/seed/code snapshot/container_digest/data_hash
      // 缺失或不一致 → 422，不再"存在时匹配"）。
      this.verifySecureRunFacts(input.run_manifest, job, input.status === 'succeeded')
    }
    if (input.status === 'succeeded' && input.run_manifest !== undefined) {
      const refs = collectManifestRefs(input.run_manifest)
      if (refs.length > 0) {
        const { ok, missing } = this.verifyArtifactRefs(refs)
        if (!ok) {
          throw new KernelError(422, 'manifest_refs_missing', `run manifest references missing artifacts: ${missing.join(', ')}`)
        }
        // §12.7: artifacts must exist AND belong to the job's project.
        for (const ref of refs) {
          try {
            this.getArtifact(job.project_id, ref)
          } catch {
            throw new KernelError(422, 'manifest_refs_missing', `artifact ${ref} is not registered in project ${job.project_id}`)
          }
        }
      }
    }
    const now = nowIso()
    // RUN-01 (P0): the jobs UPDATE and the runs-row finalization MUST be one
    // transaction — a crash between the two would leave a finalized job with
    // a pending run (or vice versa). Manifest verification above stays OUTSIDE
    // the transaction (read-only; no partial-write risk).
    withTransaction(this.db, () => {
      this.db.prepare(
        'UPDATE jobs SET status = ?, failure_class = ?, run_manifest = ?, error = ?, lease_owner = NULL, lease_expires_at = NULL, updated_at = ? WHERE job_id = ?',
      ).run(input.status, input.failure_class ?? null, input.run_manifest !== undefined ? JSON.stringify(input.run_manifest) : null, input.error ?? '', now, input.job_id)
      // §3.1 / RUN-01 (Run attempt): finalize the attempt's runs row (the one
      // recorded at claim time for this attempt_no). Manifest + signature
      // status come from the completed run; a manifest without a non-empty
      // `signature` (or no manifest at all) records 'unsigned'.
      const manifestRow = input.run_manifest !== undefined ? input.run_manifest : undefined
      const signed = typeof (manifestRow as Record<string, unknown> | undefined)?.signature === 'string'
        && (manifestRow as Record<string, unknown>).signature !== ''
      const signatureStatus = manifestRow !== undefined && signed ? 'signed' : 'unsigned'
      this.db.prepare(
        'UPDATE runs SET manifest_json = ?, signature_status = ?, finished_at = ? WHERE job_id = ? AND attempt_no = ?',
      ).run(
        manifestRow !== undefined ? JSON.stringify(manifestRow) : null,
        signatureStatus, now, input.job_id, job.attempts,
      )
      if (observesResearchOutcome(job.kind)) {
        if (job.run_id === null || job.lease_generation === null) {
          throw new KernelError(409, 'research_run_attempt_missing', `job ${job.job_id} has no exact claimed run/lease identity`)
        }
        const timedOut = input.status === 'failed' && input.run_manifest?.timed_out === true
        const observation = buildRunOutcomeObservation({
          project_id: job.project_id,
          job_id: job.job_id,
          run_id: job.run_id,
          attempt_no: job.attempts,
          lease_generation: job.lease_generation,
          job_execution: input.status === 'failed' && timedOut ? 'timed_out' : input.status,
          failure_class: input.failure_class ?? null,
          intent: job.run_intent,
          protocol_pin: job.protocol_pin,
          manifest: input.run_manifest,
          observed_at: now,
        })
        this.emit(job.project_id, 'research.run.unclassified', observation)
      }
      const jobRecord = this.getJob(input.job_id)
      this.emit(job.project_id, 'job.updated', {
        job_id: jobRecord.job_id, status: jobRecord.status, failure_class: jobRecord.failure_class ?? undefined,
      })
    })
    const jobRecord = this.getJob(input.job_id)
    // §12 (TEX-02): a latex-compile completion finalizes its tex_builds row
    // (status/diagnostics/PDF/log from the runner manifest).
    if (job.kind === 'latex-compile' && input.run_manifest !== undefined) {
      const manifest = input.run_manifest as Record<string, unknown>
      const buildRow = this.db.prepare('SELECT build_id FROM tex_builds WHERE job_id = ?').get(job.job_id) as { build_id: string } | undefined
      if (buildRow !== undefined) {
        // §12.1 (TEX-03): a superseded/cancelled preview build is FINAL —
        // its completion (a race between supersede and a runner that already
        // passed the running check) must never resurrect the record.
        const current = this.tex.getBuild(buildRow.build_id)
        const frozen = current.status === 'superseded' || current.status === 'cancelled'
        let diagnostics: LatexDiagnostic[] = Array.isArray(manifest.tex_diagnostics)
          ? manifest.tex_diagnostics as LatexDiagnostic[]
          : []
        // §7 (TEX-DIAG): re-parse the AUTHORITATIVE log artifact at
        // completion so the durable diagnostics carry file/line location and
        // structured kinds (undefined citation, missing file). The runner's
        // first-pass parse stays as the fallback when no log artifact is
        // registered or the log yields nothing.
        if (typeof manifest.tex_log_artifact === 'string' && manifest.tex_log_artifact !== '') {
          try {
            const record = this.getArtifact(job.project_id, manifest.tex_log_artifact)
            const logText = this.cas.read(record.sha256).toString('utf8')
            const enriched = parseLatexDiagnostics(logText)
            if (enriched.length > 0) diagnostics = enriched
          } catch {
            // Log artifact unreadable — keep the manifest diagnostics.
          }
        }
        this.texUpdateBuild(buildRow.build_id, {
          status: frozen ? current.status : (input.status === 'succeeded' ? 'succeeded' : (input.status === 'cancelled' ? 'cancelled' : 'failed')),
          diagnostics: JSON.stringify(diagnostics),
          pdf_artifact: typeof manifest.tex_pdf_artifact === 'string' ? manifest.tex_pdf_artifact : null,
          log_artifact: typeof manifest.tex_log_artifact === 'string' ? manifest.tex_log_artifact : null,
        })
      }
    }
    // OBS-01: completion counter tagged with the terminal status constant.
    this.metrics.count('job.completed', { status: input.status })
    // STORE-06: the lease is released — drop the in-memory plaintext token
    // (the returned record was fetched before this, so it still carries the
    // token exactly like the pre-0014 release did).
    this.leaseTokens.delete(input.job_id)
    return jobRecord
  }

  /**
   * §12.7: register a runner Ed25519 public key used to verify RunManifest
   * signatures. Rejects non-Ed25519 / unparseable PEMs (422 runner_key_invalid).
   */
  registerRunnerKey(input: { key_id: string; public_key_pem: string }): RunnerKey {
    let publicKey: KeyObject
    try {
      publicKey = createPublicKey(input.public_key_pem)
    } catch (error) {
      throw new KernelError(422, 'runner_key_invalid', `public_key_pem is not a valid public key: ${(error as Error).message}`)
    }
    if (publicKey.asymmetricKeyType !== 'ed25519') {
      throw new KernelError(422, 'runner_key_invalid', `runner key ${input.key_id} must be Ed25519, got ${publicKey.asymmetricKeyType}`)
    }
    const record: RunnerKey = { key_id: input.key_id, public_key_pem: input.public_key_pem, created_at: nowIso() }
    this.db.prepare(
      'INSERT INTO runner_keys (key_id, public_key_pem, created_at) VALUES (?, ?, ?) ON CONFLICT(key_id) DO UPDATE SET public_key_pem = excluded.public_key_pem, created_at = excluded.created_at',
    ).run(record.key_id, record.public_key_pem, record.created_at)
    return record
  }

  listRunnerKeys(): RunnerKey[] {
    const rows = this.db.prepare('SELECT * FROM runner_keys ORDER BY created_at').all() as unknown as RunnerKeyRow[]
    return rows.map(row => ({ key_id: row.key_id, public_key_pem: row.public_key_pem, created_at: row.created_at }))
  }

  /**
   * §12.7: verify a current run manifest against the exact claimed Job.
   *  - identity: run_id/job_id/project_id/contract_id/config_pin and
   *    lease.generation are required and must match (422 manifest_*_mismatch);
   *  - signature: when `signature` is present the runner key must be
   *    registered (422 manifest_key_unknown), the canonical payload hash must
   *    match `payload_sha256` when provided (422 manifest_hash_mismatch) and
   *    the Ed25519 signature must verify (422 manifest_signature_invalid);
   *  - unsigned manifests are accepted only when current policy allows and
   *    rejected only when the kernel or project requires signing
   *    (422 manifest_signature_required).
   * Partial identity manifests are never accepted.
   */
  private verifyRunManifest(manifest: Record<string, unknown>, job: JobRecord): void {
    const manifestLease = manifest.lease
    if (typeof manifestLease === 'object' && manifestLease !== null
      && Object.prototype.hasOwnProperty.call(manifestLease, 'token')) {
      throw new KernelError(422, 'manifest_lease_secret', 'run manifest must not persist the lease token')
    }
    if (manifest.job_id !== job.job_id) {
      throw new KernelError(422, 'manifest_job_mismatch', `run manifest job_id ${String(manifest.job_id)} does not match job ${job.job_id}`)
    }
    if (manifest.project_id !== job.project_id) {
      throw new KernelError(422, 'manifest_project_mismatch', `run manifest project_id ${String(manifest.project_id)} does not match project ${job.project_id}`)
    }
    if (manifest.contract_id !== job.contract_id) {
      throw new KernelError(422, 'manifest_contract_mismatch',
        `run manifest contract_id ${String(manifest.contract_id)} does not match job contract ${job.contract_id ?? 'none'}`)
    }
    const runRow = this.db.prepare('SELECT run_id FROM runs WHERE job_id = ? AND attempt_no = ?')
      .get(job.job_id, job.attempts) as { run_id: string } | undefined
    if (runRow === undefined || manifest.run_id !== runRow.run_id) {
      throw new KernelError(422, 'manifest_run_mismatch',
        `run manifest run_id ${String(manifest.run_id)} does not match the current claim ${runRow?.run_id ?? 'missing'}`)
    }
    const expectedConfigPin = job.payload.project_config_pin
    if (typeof expectedConfigPin !== 'string' || !/^sha256:[0-9a-f]{64}$/.test(expectedConfigPin)
      || manifest.config_pin !== expectedConfigPin) {
      throw new KernelError(422, 'manifest_config_mismatch',
        `run manifest config_pin ${String(manifest.config_pin)} does not match the job project config pin`)
    }
    // Lease provenance is current-only: exactly one generation field, no
    // token or extension keys that could become an accidental secret sink.
    const lease = manifestLease
    const leaseKeys = typeof lease === 'object' && lease !== null && !Array.isArray(lease)
      ? Object.keys(lease)
      : []
    if (job.lease_generation === null || leaseKeys.length !== 1 || leaseKeys[0] !== 'generation'
      || typeof (lease as { generation?: unknown } | null)?.generation !== 'number'
      || (lease as { generation: number }).generation !== job.lease_generation) {
      throw new KernelError(422, 'manifest_lease_mismatch',
        `run manifest lease ${JSON.stringify(lease)} does not match exact job lease generation ${job.lease_generation}`)
    }

    const signature = manifest.signature
    if (typeof signature !== 'string' || signature === '') {
      // No signature: accept by default; enforce only when required.
      const integrity = this.getProject(job.project_id).integrity as Record<string, unknown>
      if (this.requireSignedManifest || integrity.require_signed_manifest === true) {
        throw new KernelError(422, 'manifest_signature_required', 'run manifest must be signed (require_signed_manifest)')
      }
      return
    }
    const runnerKeyId = manifest.runner_key_id
    if (typeof runnerKeyId !== 'string' || runnerKeyId === '') {
      throw new KernelError(422, 'manifest_key_unknown', 'run manifest carries a signature but no runner_key_id')
    }
    const keyRow = this.db.prepare('SELECT * FROM runner_keys WHERE key_id = ?').get(runnerKeyId) as RunnerKeyRow | undefined
    if (keyRow === undefined) {
      throw new KernelError(422, 'manifest_key_unknown', `runner key ${runnerKeyId} is not registered`)
    }
    // Signed payload = the manifest minus its signature field, canonicalized.
    const { signedPayload, signatureBytes } = stripManifestSignature(manifest)
    const payloadSha256 = manifest.payload_sha256
    if (typeof payloadSha256 === 'string' && payloadSha256 !== '') {
      const actual = sha256Hex(manifestHashPayload(manifest))
      if (actual !== payloadSha256) {
        throw new KernelError(422, 'manifest_hash_mismatch', `payload_sha256 mismatch: got ${actual}, manifest claims ${payloadSha256}`)
      }
    }
    let publicKey: KeyObject
    try {
      publicKey = createPublicKey(keyRow.public_key_pem)
    } catch {
      throw new KernelError(422, 'manifest_key_unknown', `runner key ${runnerKeyId} is not a valid public key`)
    }
    const valid = verify(null, Buffer.from(canonicalRunManifestJson(signedPayload), 'utf8'), publicKey, signatureBytes)
    if (!valid) {
      throw new KernelError(422, 'manifest_signature_invalid', `run manifest signature verification failed for key ${runnerKeyId}`)
    }
  }

  /**
   * RUN-REMOTE-01（hardening-v0.2-status.md §5 两行 / acceptance
   * remote-identity-fencing-manifest）：secure kinds（baseline/pilot/formal/
   * reproduce/latex-compile）的 manifest 强制校验——不再"存在时匹配"：
   *
   * - **run_id 全链一致**（job/run/lease/manifest）：manifest.run_id 必须等于
   *   本 attempt 在 claim 时写入 runs 行的 run_id（缺失或旧 attempt 的
   *   run_id → 422 manifest_run_mismatch）；
   * - succeeded 时 **required facts 缺一即 422**：metrics_artifact 存在
   *   （§12.5）、seed 与 job 固定 seed 匹配、code_snapshot_id 与 job 绑定
   *   快照一致、container_digest === `docker:<digest-pinned image>`、
   *   data_hash 与 job 声明一致。
   *
   * 与本地 runner / 远端 Agent 的 manifest builder（runner-gateway
   * run-manifest.ts）同源——合法 run 恒通过；残缺/伪造 manifest 拒绝。
   */
  private verifySecureRunFacts(manifest: Record<string, unknown>, job: JobSpecBound, succeeded: boolean): void {
    const SECURE_KINDS: readonly string[] = ['baseline', 'pilot', 'formal', 'reproduce', 'latex-compile']
    if (!SECURE_KINDS.includes(job.kind)) return
    const runRow = this.db.prepare('SELECT run_id FROM runs WHERE job_id = ? AND attempt_no = ?')
      .get(job.job_id, job.attempts) as { run_id?: string } | undefined
    if (runRow !== undefined && manifest.run_id !== runRow.run_id) {
      throw new KernelError(422, 'manifest_run_mismatch',
        `run manifest run_id ${String(manifest.run_id)} does not match the claim's run_id ${runRow.run_id} (job ${job.job_id} attempt ${job.attempts}) — job/run/lease/manifest run_id chain broken`)
    }
    if (!succeeded) return
    if (typeof manifest.metrics_artifact !== 'string' || manifest.metrics_artifact === '') {
      throw new KernelError(422, 'manifest_facts_missing',
        `run manifest for ${job.kind} job ${job.job_id} lacks metrics_artifact (required fact, §12.5)`)
    }
    const jobSeed = typeof job.payload.seed === 'number' && Number.isFinite(job.payload.seed) ? job.payload.seed : null
    if (jobSeed !== null && manifest.seed !== jobSeed) {
      throw new KernelError(422, 'manifest_seed_mismatch',
        `run manifest seed ${String(manifest.seed)} does not match the job's fixed seed ${jobSeed}`)
    }
    if (job.code_snapshot_id !== null && job.code_snapshot_id !== '' && manifest.code_snapshot_id !== job.code_snapshot_id) {
      throw new KernelError(422, 'manifest_snapshot_mismatch',
        `run manifest code_snapshot_id ${String(manifest.code_snapshot_id)} does not match the job's code snapshot ${job.code_snapshot_id}`)
    }
    if (job.image_digest !== '' && manifest.container_digest !== `docker:${job.image_digest}`) {
      throw new KernelError(422, 'manifest_container_mismatch',
        `run manifest container_digest ${String(manifest.container_digest)} does not match the digest-pinned image docker:${job.image_digest}`)
    }
    const jobDataHash = typeof job.payload.data_hash === 'string' && job.payload.data_hash !== '' ? job.payload.data_hash : null
    if (jobDataHash !== null && manifest.data_hash !== jobDataHash) {
      throw new KernelError(422, 'manifest_data_mismatch',
        `run manifest data_hash ${String(manifest.data_hash)} does not match the job's data hash ${jobDataHash}`)
    }
  }

  cancelJob(jobId: string, actor: string, reason = ''): JobRecord {
    const job = this.getJob(jobId)
    if (job.status === 'succeeded' || job.status === 'failed' || job.status === 'cancelled') {
      throw new KernelError(409, 'job_finished', `job ${jobId} already ${job.status}`)
    }
    this.db.prepare('UPDATE jobs SET status = ?, error = ?, lease_owner = NULL, updated_at = ? WHERE job_id = ?')
      .run('cancelled', reason ? `cancelled by ${actor}: ${reason}` : `cancelled by ${actor}`, nowIso(), jobId)
    // STORE-06: cancellation releases the lease — the in-memory plaintext
    // token must not survive it (the returned record has lease_token null).
    this.leaseTokens.delete(jobId)
    // §12.1 (TEX-03): cancelling a latex-compile job finalizes its tex_builds
    // row (queued/running → cancelled) so build history never shows a
    // cancelled job with a live build.
    const texBuildRow = this.db.prepare('SELECT build_id, status FROM tex_builds WHERE job_id = ?').get(jobId) as { build_id: string; status: string } | undefined
    if (texBuildRow !== undefined && (texBuildRow.status === 'queued' || texBuildRow.status === 'running')) {
      this.tex.updateBuild(texBuildRow.build_id, { status: 'cancelled' })
    }
    // dsh-web parity: unify the job.updated event with the other mutations.
    this.emit(job.project_id, 'job.updated', { job_id: jobId, status: 'cancelled', actor })
    return this.getJob(jobId)
  }

  // ── terminal frames (execution-runtime.md §6) ────────────────────────────

  /** Default hot-log retention per run (8 MiB, execution-runtime.md §6). */
  static readonly TERMINAL_DEFAULT_MAX_BYTES = 8 * 1024 * 1024

  /**
   * Append a batch of terminal frames for a run. Validation: the job must
   * exist; frames from a stale lease generation are rejected (fencing); seq
   * must be monotonic within the run (duplicate/older seq is an idempotent
   * skip); chunk frames must carry channel/stream_seq/text/byte_offset/
   * byte_length. P0 (acceptance-tests.md §4): when the caller supplies the
   * lease owner/token, each frame is fenced against BOTH — a wrong owner or
   * token is 409 `lease_stale` (the HTTP route requires both for leased
   * jobs, so every frame that arrives over the wire is owner/token checked).
   * Retention: when total_bytes exceeds maxLogBytes, the OLDEST chunk frames
   * are evicted, dropped_bytes accumulate and truncated is set; gap/exit
   * frames are never evicted.
   */
  appendTerminalFrames(input: {
    jobId: string
    runId: string
    frames: Array<{
      seq: number
      stream_seq?: number | null
      channel?: 'stdout' | 'stderr' | null
      text?: string | null
      byte_offset?: number | null
      byte_length?: number | null
      frame_kind: 'chunk' | 'gap' | 'exit'
      payload_json?: string
      lease_generation?: number
    }>
    /** §4 P0 (TERM-01): lease owner/token fencing — exact match when provided. */
    owner?: string | null
    lease_token?: string | null
    maxLogBytes?: number
  }): { appended: number; last_seq: number; truncated: boolean; total_bytes: number; dropped_bytes: number } {
    const job = this.getJob(input.jobId)
    if (input.frames.length === 0) {
      throw new KernelError(422, 'empty_frames', 'at least one frame is required')
    }
    // P0 (acceptance-tests.md §4): Terminal frames must authenticate the
    // CLAIM — when the caller provides owner/token (the runner gateway and
    // the HTTP route always do), both must exactly match the job's lease or
    // the batch is rejected 409 lease_stale (an old or foreign runner can
    // never write frames into a live run). Partial credentials (one side
    // provided, the other null/undefined) are stale too.
    const ownerProvided = input.owner !== undefined && input.owner !== null
    const tokenProvided = input.lease_token !== undefined && input.lease_token !== null
    if (ownerProvided || tokenProvided) {
      if (!ownerProvided || !tokenProvided) {
        throw new KernelError(409, 'lease_stale',
          `job ${input.jobId} terminal frames must carry BOTH lease owner and token (got owner=${String(input.owner)} token=${String(input.lease_token)})`)
      }
      // STORE-06: the token half of the fence compares sha256(provided)
      // against jobs.lease_token_hash; a missing hash fails closed.
      if (input.owner !== job.lease_owner || !this.leaseTokenMatches(input.jobId, input.lease_token)) {
        throw new KernelError(409, 'lease_stale',
          `job ${input.jobId} terminal frames lease mismatch: expected owner ${job.lease_owner ?? 'n/a'} token hash ${this.leaseHashOf(input.jobId) ?? 'n/a'}, got owner ${input.owner} token ${input.lease_token}`)
      }
    }
    const maxBytes = input.maxLogBytes ?? ResearchKernel.TERMINAL_DEFAULT_MAX_BYTES
    let appended = 0
    let lastSeq = 0
    const inserted: Array<Record<string, unknown>> = []
    return withTransaction(this.db, () => {
      const lastRow = this.db.prepare('SELECT seq FROM terminal_frames WHERE job_id = ? AND run_id = ? ORDER BY seq DESC LIMIT 1')
        .get(input.jobId, input.runId) as { seq?: number } | undefined
      let cursor = lastRow?.seq ?? 0
      const insert = this.db.prepare(`INSERT OR IGNORE INTO terminal_frames
        (job_id, run_id, seq, stream_seq, channel, text, byte_offset, byte_length, frame_kind, payload_json, lease_generation, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      for (const frame of input.frames) {
        if (frame.seq <= cursor) {
          // STORE-05 (storage-migrations.md §4): a replayed (run_id, seq)
          // must carry IDENTICAL content — same seq with different content
          // is an integrity error, not a silent INSERT OR IGNORE skip.
          this.assertTerminalFrameConsistent(input.jobId, input.runId, frame)
          continue // idempotent replay / out-of-order skip
        }
        // P0 (acceptance-tests.md §4): Terminal frames MUST carry the current
        // owner generation/token — a frame with a MISSING generation is
        // rejected 409 (fail-closed, no owner-only/defaulting pass), and a
        // stale or future generation is rejected too.
        if (job.lease_generation !== null && job.lease_generation !== undefined) {
          if (frame.lease_generation === undefined || frame.lease_generation === null) {
            throw new KernelError(409, 'lease_stale',
              `frame lease_generation missing (job generation ${job.lease_generation}) — terminal frames must carry the claim's generation (P0)`)
          }
          if (frame.lease_generation !== job.lease_generation) {
            throw new KernelError(409, 'lease_stale',
              `frame lease_generation ${frame.lease_generation} != job generation ${job.lease_generation}`)
          }
        }
        const generation = frame.lease_generation ?? 0
        if (frame.frame_kind === 'chunk' && (frame.channel === null || frame.channel === undefined || frame.text === null || frame.text === undefined)) {
          throw new KernelError(422, 'invalid_chunk_frame', 'chunk frames require channel + text')
        }
        insert.run(
          input.jobId, input.runId, frame.seq,
          frame.stream_seq ?? null, frame.channel ?? null, frame.text ?? null,
          frame.byte_offset ?? null, frame.byte_length ?? null,
          frame.frame_kind, frame.payload_json ?? '{}', generation, nowIso(),
        )
        cursor = frame.seq
        appended += 1
        lastSeq = frame.seq
        inserted.push({ run_id: input.runId, seq: frame.seq, frame_kind: frame.frame_kind })
      }
      if (appended === 0) {
        const ret = this.getTerminalRetention(input.jobId, input.runId)
        return { appended: 0, last_seq: cursor, truncated: ret.truncated, total_bytes: ret.total_bytes, dropped_bytes: ret.dropped_bytes }
      }
      // Retention accounting.
      let totalBytes = 0
      let droppedBytes = 0
      let truncated = 0
      const byteSum = this.db.prepare(
        'SELECT COALESCE(SUM(byte_length), 0) AS bytes FROM terminal_frames WHERE job_id = ? AND run_id = ?',
      ).get(input.jobId, input.runId) as { bytes: number }
      totalBytes = Number(byteSum.bytes)
      if (totalBytes > maxBytes) {
        const evict = this.db.prepare(`DELETE FROM terminal_frames
          WHERE job_id = ? AND run_id = ? AND frame_kind = 'chunk'
          AND seq IN (SELECT seq FROM terminal_frames WHERE job_id = ? AND run_id = ? AND frame_kind = 'chunk' ORDER BY seq ASC LIMIT ?)`)
        let guard = 0
        while (totalBytes > maxBytes && guard < 10000) {
          const victims = this.db.prepare(
            'SELECT seq, byte_length FROM terminal_frames WHERE job_id = ? AND run_id = ? AND frame_kind = ? ORDER BY seq ASC LIMIT 64',
          ).all(input.jobId, input.runId, 'chunk') as Array<{ seq: number; byte_length: number | null }>
          if (victims.length === 0) break
          evict.run(input.jobId, input.runId, input.jobId, input.runId, victims.length)
          for (const v of victims) droppedBytes += Number(v.byte_length ?? 0)
          const next = this.db.prepare('SELECT COALESCE(SUM(byte_length), 0) AS bytes FROM terminal_frames WHERE job_id = ? AND run_id = ?')
            .get(input.jobId, input.runId) as { bytes: number }
          totalBytes = Number(next.bytes)
          guard += 1
        }
        truncated = 1
      }
      const retainedRow = this.db.prepare('SELECT COALESCE(MIN(seq), 1) AS min_seq FROM terminal_frames WHERE job_id = ? AND run_id = ?')
        .get(input.jobId, input.runId) as { min_seq: number }
      this.db.prepare(`INSERT INTO terminal_retention (job_id, run_id, retained_from_seq, total_bytes, dropped_bytes, truncated)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(job_id, run_id) DO UPDATE SET
          retained_from_seq = excluded.retained_from_seq,
          total_bytes = excluded.total_bytes,
          dropped_bytes = terminal_retention.dropped_bytes + excluded.dropped_bytes,
          truncated = MAX(terminal_retention.truncated, excluded.truncated)`)
        .run(input.jobId, input.runId, Number(retainedRow.min_seq), totalBytes, droppedBytes, truncated)
      const retention = this.getTerminalRetention(input.jobId, input.runId)
      // OBS-01: dropped-bytes counter accumulates the retention-evicted bytes
      // (terminal dropped bytes, reconstruction-contracts.md §18).
      if (droppedBytes > 0) this.metrics.count('terminal.dropped_bytes', undefined, droppedBytes)
      for (const frame of inserted) {
        this.emit(job.project_id, 'terminal.frame', frame)
      }
      return {
        appended,
        last_seq: lastSeq,
        truncated: retention.truncated,
        total_bytes: retention.total_bytes,
        dropped_bytes: retention.dropped_bytes,
      }
    })
  }

  /**
   * STORE-05 (storage-migrations.md §4): same (run_id, seq) with DIFFERENT
   * content is an integrity error. When a frame replays a stored seq, its
   * content signature (frame_kind/stream_seq/channel/text/byte_offset/
   * byte_length/payload_json — lease_generation/created_at are bookkeeping,
   * not content) must match the stored row; otherwise 409
   * `terminal_frame_conflict`. Identical content is an idempotent skip
   * (replay semantics preserved). A row already evicted by retention can no
   * longer be verified and is skipped — its eviction was already surfaced to
   * the client via terminal_retention/gap frames.
   */
  private assertTerminalFrameConsistent(jobId: string, runId: string, frame: {
    seq: number
    stream_seq?: number | null
    channel?: string | null
    text?: string | null
    byte_offset?: number | null
    byte_length?: number | null
    frame_kind: string
    payload_json?: string | null
  }): void {
    const row = this.db.prepare(
      'SELECT frame_kind, stream_seq, channel, text, byte_offset, byte_length, payload_json FROM terminal_frames WHERE job_id = ? AND run_id = ? AND seq = ?',
    ).get(jobId, runId, frame.seq) as {
      frame_kind: string; stream_seq: number | null; channel: string | null; text: string | null
      byte_offset: number | null; byte_length: number | null; payload_json: string
    } | undefined
    if (row === undefined) return // evicted by retention — nothing to compare
    if (terminalFrameSignature(frame) !== terminalFrameSignature(row)) {
      throw new KernelError(409, 'terminal_frame_conflict',
        `terminal frame (run ${runId}, seq ${frame.seq}) content differs from the stored frame — the same seq must carry identical content (STORE-05)`)
    }
  }

  /** Frames after `afterSeq` (ordered by seq) plus the retention summary. */
  listTerminalFrames(jobId: string, runId: string, afterSeq = 0): {
    frames: Array<{
      seq: number; stream_seq: number | null; channel: 'stdout' | 'stderr' | null
      text: string | null; byte_offset: number | null; byte_length: number | null
      frame_kind: 'chunk' | 'gap' | 'exit'; payload_json: string; lease_generation: number; created_at: string
    }>
    retention: { retained_from_seq: number; total_bytes: number; dropped_bytes: number; truncated: boolean }
  } {
    this.getJob(jobId)
    const rows = this.db.prepare('SELECT seq, stream_seq, channel, text, byte_offset, byte_length, frame_kind, payload_json, lease_generation, created_at FROM terminal_frames WHERE job_id = ? AND run_id = ? AND seq > ? ORDER BY seq ASC')
      .all(jobId, runId, afterSeq) as unknown as Array<Record<string, unknown>>
    return {
      frames: rows.map(r => ({
        seq: Number(r.seq),
        stream_seq: r.stream_seq === null ? null : Number(r.stream_seq),
        channel: (r.channel as 'stdout' | 'stderr' | null) ?? null,
        text: r.text as string | null,
        byte_offset: r.byte_offset === null ? null : Number(r.byte_offset),
        byte_length: r.byte_length === null ? null : Number(r.byte_length),
        frame_kind: r.frame_kind as 'chunk' | 'gap' | 'exit',
        payload_json: String(r.payload_json ?? '{}'),
        lease_generation: Number(r.lease_generation ?? 0),
        created_at: String(r.created_at ?? ''),
      })),
      retention: this.getTerminalRetention(jobId, runId),
    }
  }

  getTerminalRetention(jobId: string, runId: string): {
    retained_from_seq: number; total_bytes: number; dropped_bytes: number; truncated: boolean
  } {
    const row = this.db.prepare('SELECT retained_from_seq, total_bytes, dropped_bytes, truncated FROM terminal_retention WHERE job_id = ? AND run_id = ?')
      .get(jobId, runId) as { retained_from_seq?: number; total_bytes?: number; dropped_bytes?: number; truncated?: number } | undefined
    return {
      retained_from_seq: Number(row?.retained_from_seq ?? 1),
      total_bytes: Number(row?.total_bytes ?? 0),
      dropped_bytes: Number(row?.dropped_bytes ?? 0),
      truncated: row?.truncated === 1,
    }
  }

  /** Resolve the terminal run identity for a job: the most recent run that
   * uploaded frames, or null when none exists yet (the SSE endpoint then
   * falls back to the job id). */
  resolveTerminalRun(jobId: string): string | null {
    const row = this.db.prepare('SELECT run_id FROM terminal_frames WHERE job_id = ? ORDER BY created_at DESC, seq DESC LIMIT 1')
      .get(jobId) as { run_id?: string } | undefined
    return row?.run_id ?? null
  }

  // ── TeX workspace (execution-runtime.md §12) ─────────────────────────────

  texEnsure(projectId: string, rootFile = 'paper.tex'): TexDocumentInfo {
    this.getProject(projectId)
    return this.tex.ensureDocument(projectId, rootFile)
  }

  texTree(documentId: string): { document: TexDocumentInfo; files: TexFileEntry[] } {
    return this.tex.tree(documentId)
  }

  texReadFile(documentId: string, path: string) {
    return this.tex.readFile(documentId, path)
  }

  /**
   * TEX-SAVE (storage-migrations.md §5/§7, domain-model.md §12): CAS save of
   * one TeX file. The write itself is a SINGLE transaction on the tex store
   * connection (file row + document revision bump — a mid-write failure
   * leaves no half-write). On success a `tex.file.saved` outbox event is
   * appended (see emitTexFileSaved for the cross-connection ordering).
   * Optional meta carries the caller's request_id/session_id into the event
   * envelope. Version conflicts (TexError 409) emit nothing. API semantics
   * unchanged: returns { version, content_hash } exactly as before.
   */
  texWriteFile(documentId: string, path: string, content: string, expectedVersion?: number, meta?: { request_id?: string; session_id?: string }) {
    const result = this.tex.writeFile(documentId, path, content, expectedVersion)
    this.emitTexFileSaved(documentId, path, meta)
    // §12.1 (TEX-03): with previewAutoTrigger the save-success event itself
    // schedules the debounced preview build (kernel-internal Workspace event
    // path; the explicit POST preview-builds hook remains the canonical one).
    if (this.previewAutoTrigger) this.maybeAutoPreview(documentId)
    return result
  }

  /**
   * TEX-SAVE: append the tex.file.saved outbox event AFTER a successful save.
   * The tex store owns a SECOND WAL connection (openTexWorkspace), so the
   * outbox append cannot share the write transaction: the tex write commits
   * FIRST, then the event lands on the kernel connection. This ordering is
   * documented in storage-migrations.md §7 — cross-connection atomicity is
   * impossible; the write is the authority, the event is at-least-once
   * derivable. An outbox failure is recorded (console.error) and NEVER fails
   * the save: the write already committed and the client already observed
   * success — failing here would only force a doomed 409 retry.
   */
  private emitTexFileSaved(documentId: string, path: string, meta?: { request_id?: string; session_id?: string }): void {
    const document = this.tex.getDocument(documentId)
    try {
      this.emit(document.project_id, 'tex.file.saved', {
        project_id: document.project_id,
        document_id: documentId,
        path,
        revision: document.revision,
        request_id: meta?.request_id,
        session_id: meta?.session_id,
      })
    } catch (error) {
      console.error(`tex.file.saved outbox append failed (document ${documentId}, path ${path}):`, error)
    }
  }

  texDeleteFile(documentId: string, path: string, expectedVersion?: number): void {
    this.tex.deleteFile(documentId, path, expectedVersion)
    if (this.previewAutoTrigger) this.maybeAutoPreview(documentId)
  }

  texMoveFile(documentId: string, fromPath: string, toPath: string, expectedVersion?: number): void {
    this.tex.moveFile(documentId, fromPath, toPath, expectedVersion)
    if (this.previewAutoTrigger) this.maybeAutoPreview(documentId)
  }

  /** §12.1 (TEX-03): schedule a preview after a write, unless the document
   * has no files left (an empty workspace cannot compile — the runner would
   * just fail). */
  private maybeAutoPreview(documentId: string): void {
    try {
      if (this.tex.tree(documentId).files.length === 0) return
      this.texRequestPreview(documentId)
    } catch {
      // Preview scheduling is best-effort; the write itself already landed.
    }
  }

  texHistory(documentId: string) {
    return this.tex.history(documentId)
  }

  texSnapshot(documentId: string, expectedRevision?: number): { revision: number; manifest: TexSnapshotManifest } {
    return this.tex.snapshot(documentId, expectedRevision)
  }

  /**
   * TEX-01 (§4 row 95): frozen bytes of one snapshot file at a revision —
   * the Runner materializes latex-compile input from THESE bytes (never the
   * current file). null when the revision/path is not in the snapshot store.
   */
  texSnapshotFile(documentId: string, revision: number, path: string): { path: string; content: string; content_hash: string } | null {
    return this.tex.snapshotFile(documentId, revision, path)
  }

  texCreateBuild(documentId: string, revision: number, rootFile: string, jobId: string | null, preview = false): TexBuild {
    return this.tex.createBuild(documentId, revision, rootFile, jobId, preview)
  }

  texUpdateBuild(buildId: string, patch: Parameters<import('./tex-workspace.js').TexWorkspaceStore['updateBuild']>[1]): TexBuild {
    const updated = this.tex.updateBuild(buildId, patch)
    // OBS-01: TeX build completion counter — a terminal status transition
    // (succeeded/failed/cancelled/superseded) is the completion event.
    if (patch.status === 'succeeded' || patch.status === 'failed' || patch.status === 'cancelled' || patch.status === 'superseded') {
      this.metrics.count('tex.build_completed', { status: patch.status })
    }
    return updated
  }

  /**
   * §12.1 (TEX-03): a build record's staleness for PDF display — the
   * compiled PDF is stale as soon as the document revision moved past the
   * revision the build froze (build.revision < document.revision).
   */
  private texBuildView(build: TexBuild): TexBuild & { stale: boolean } {
    let documentRevision = build.revision
    try {
      documentRevision = this.tex.getDocument(build.document_id).revision
    } catch {
      // document gone — keep the build's own revision (stale=false baseline)
    }
    return { ...build, stale: documentRevision > build.revision }
  }

  texGetBuild(buildId: string): TexBuild & { stale: boolean } {
    return this.texBuildView(this.tex.getBuild(buildId))
  }

  /** §12.1 (TEX-03): authoritative builds only (preview=0) — the explicit
   * Compile surface is kept separate from live previews. */
  texListBuilds(documentId: string): Array<TexBuild & { stale: boolean }> {
    return this.tex.listBuilds(documentId).filter(b => !b.preview).map(b => this.texBuildView(b))
  }

  /** §12.1 (TEX-03): live preview builds (preview=1), newest first. */
  texListPreviews(documentId: string): Array<TexBuild & { stale: boolean }> {
    return this.tex.listPreviews(documentId).map(b => this.texBuildView(b))
  }

  /**
   * §12.1 (TEX-03): request a debounced live preview build after a save
   * success. The pending request is durable (tex_preview_pending) and the
   * debounce timer is owned by the kernel — UI reconnects and kernel
   * restarts re-project the same state. A second request while the debounce
   * is pending simply restarts the window (coalescing); the flush compiles
   * the LATEST document revision.
   */
  texRequestPreview(documentId: string, opts: { debounce_ms?: number; root_file?: string; engine?: string } = {}): TexPreviewPending {
    this.tex.getDocument(documentId)
    if (opts.engine !== undefined && opts.engine !== '' && !TEX_ENGINES.includes(opts.engine)) {
      throw new KernelError(422, 'engine_invalid',
        `preview engine '${opts.engine}' is not in the fixed engine whitelist (${TEX_ENGINES.join('/')})`)
    }
    if (opts.root_file !== undefined && opts.root_file !== '') assertSafeTexBuildPath(opts.root_file)
    const debounceMs = opts.debounce_ms ?? this.previewDebounceMs
    const pending = this.tex.requestPreview(documentId, debounceMs, opts.root_file, opts.engine)
    this.armPreviewTimer(documentId, debounceMs)
    return pending
  }

  /** §12.1 (TEX-03): debounce timer bookkeeping (one timer per document). */
  private armPreviewTimer(documentId: string, debounceMs: number): void {
    const existing = this.previewTimers.get(documentId)
    if (existing !== undefined) clearTimeout(existing)
    const timer = setTimeout(() => {
      this.previewTimers.delete(documentId)
      try {
        this.texFlushPreview(documentId)
      } catch (error) {
        // Best-effort preview: a failed flush must never loop. Consume the
        // pending request so the failure surfaces once (build history or
        // diagnostics), then drop it.
        console.error(`[kernel] tex preview flush failed for ${documentId}: ${(error as Error).message}`)
        try { this.tex.consumePendingPreview(documentId) } catch { /* ignore */ }
      }
    }, debounceMs)
    timer.unref?.()
    this.previewTimers.set(documentId, timer)
  }

  /**
   * §12.1 (TEX-03): consume the pending request and create the preview build
   * (synchronous, called by the debounce timer or directly for tests).
   * Preview runs the SAME fixed TeX image / no-network / no-shell-escape
   * latex-compile runner path (kind stays latex-compile, payload.preview=true
   * marks the record) but is NOT part of the authoritative manifest chain:
   * no accepted Evidence, no manifest freeze beyond the revision-scoped
   * snapshot it compiles. Skipped when an authoritative latex-compile is
   * active (its build superseded previews) or when a non-terminal preview
   * for the same revision already exists.
   */
  texFlushPreview(documentId: string): {
    action: 'noop' | 'skipped_authoritative' | 'skipped_dup' | 'created'
    revision?: number
    build?: TexBuild
    job?: JobSpecBound
    superseded?: string[]
  } {
    const pending = this.tex.consumePendingPreview(documentId)
    if (pending === null) return { action: 'noop' }
    const document = this.tex.getDocument(documentId)
    const revision = document.revision
    // An active authoritative latex-compile supersedes previews by existing:
    // do not queue another container run behind it.
    const activeAuthoritative = this.listJobs(document.project_id).some(j =>
      j.kind === 'latex-compile'
      && (j.status === 'queued' || j.status === 'running')
      && (j.payload as Record<string, unknown> | undefined)?.preview !== true
      && (j.payload as Record<string, unknown>)?.tex_document_id === documentId)
    if (activeAuthoritative) return { action: 'skipped_authoritative', revision }
    // Dedupe: an already queued/running preview for this exact revision is
    // the preview the UI wants; creating a second job would waste a run.
    const sameRevisionLive = this.tex.listPreviews(documentId).find(b => b.revision === revision && (b.status === 'queued' || b.status === 'running'))
    if (sameRevisionLive !== undefined) return { action: 'skipped_dup', revision }
    // Freeze the CURRENT revision (the debounce coalesced any newer saves)
    // and run the same fixed-image latex-compile pipeline, marked preview.
    const snap = this.tex.snapshot(documentId)
    const rootFile = pending.root_file !== '' ? pending.root_file : document.root_file
    const engine = pending.engine !== '' ? pending.engine : 'pdflatex'
    const job = this.submitJob({
      project_id: document.project_id,
      // Nonce so a retried flush after a terminal preview never reuses a
      // finished job (store-level dedup prevents same-revision duplicates).
      idempotency_key: `latex-preview:${documentId}:${snap.revision}:${engine}:${randomUUID().slice(0, 8)}`,
      kind: 'latex-compile',
      command: [engine, '-interaction=nonstopmode', '-halt-on-error', '-file-line-error', '-recorder', '-no-shell-escape', rootFile],
      payload: {
        tex_document_id: documentId,
        tex_revision: snap.revision,
        tex_snapshot: snap.manifest,
        engine,
        preview: true,
      },
    })
    const build = this.tex.createBuild(documentId, snap.revision, rootFile, job.job_id, true)
    // The new revision's preview supersedes every non-terminal older preview
    // (queued → cancelled, running → superseded) and cancels their jobs.
    const superseded = this.tex.supersedePreviews(documentId, build.build_id)
    for (const old of superseded) {
      if (old.job_id !== null) {
        try {
          this.cancelJob(old.job_id, 'kernel:preview-supersede', `superseded by preview build ${build.build_id}`)
        } catch {
          // Job already terminal — its build row is already frozen too.
        }
      }
    }
    return { action: 'created', revision: snap.revision, build, job, superseded: superseded.map(b => b.build_id) }
  }

  /**
   * §12.1 (TEX-03): an explicit authoritative Compile supersedes ALL
   * non-terminal previews of the document (queued → cancelled, running →
   * superseded, superseded_by = the authoritative build). Previews never
   * block or replace the authoritative job; the authority is the manifest
   * frozen by POST builds.
   */
  texSupersedePreviews(documentId: string, supersederBuildId: string): TexBuild[] {
    const affected = this.tex.supersedePreviews(documentId, supersederBuildId)
    for (const old of affected) {
      if (old.job_id !== null) {
        try {
          this.cancelJob(old.job_id, 'kernel:authoritative-compile', `superseded by authoritative build ${supersederBuildId}`)
        } catch {
          // Job already terminal — its build row is already frozen too.
        }
      }
    }
    return affected
  }

  /** §12.1 (TEX-03): projection for UI reconnects — pending debounce state
   * (if any) plus the document's preview builds with staleness flags. */
  texPreviewStatus(documentId: string): { pending: TexPreviewPending | null; builds: Array<TexBuild & { stale: boolean }> } {
    this.tex.getDocument(documentId)
    return { pending: this.tex.getPendingPreview(documentId), builds: this.texListPreviews(documentId) }
  }

  /**
   * P0-3 (TEX-01): READ-ONLY manuscript workspace lookup — the "open/ensure
   * manuscript" path must never rewrite user content. Returns the existing
   * generated workspace without creating a document row and without writing
   * any byte, or null when there is nothing to open yet (no document, or a
   * bare document row with zero files). ANY existing file set counts as
   * user content (even a deliberately emptied paper.tex stays untouched —
   * regeneration is explicit only). The UI calls GET first and POSTs only
   * when this returns null.
   */
  manuscriptWorkspace(projectId: string, rootFile = 'paper.tex'): {
    document_id: string
    revision: number
    files: string[]
    created: boolean
    regenerated: boolean
  } | null {
    this.getProject(projectId)
    void rootFile
    const document = this.tex.findDocument(projectId)
    if (document === null) return null
    const tree = this.tex.tree(document.document_id)
    if (tree.files.length === 0) return null
    return {
      document_id: document.document_id,
      revision: tree.document.revision,
      files: tree.files.map(f => f.path),
      created: false,
      regenerated: false,
    }
  }

  /**
   * P0-3 (TEX-01): ensure semantics for POST manuscript-drafts — generate
   * ONLY on first creation (no document, or a document with no files).
   * When the workspace already exists it is returned unchanged (created:
   * false, zero writes, zero revision bumps) so a render/rerender can never
   * clobber saved content. Explicit regeneration is `regenerateTexWorkspace`.
   */
  ensureManuscriptWorkspace(projectId: string, rootFile = 'paper.tex'): {
    document_id: string
    revision: number
    files: string[]
    created: boolean
    regenerated: boolean
  } {
    const existing = this.manuscriptWorkspace(projectId, rootFile)
    if (existing !== null) return existing
    const generated = this.generateTexWorkspace(projectId, rootFile)
    return { ...generated, created: true, regenerated: false }
  }

  /**
   * P0-3 (TEX-01): explicit regeneration (regenerate=true). The CURRENT
   * content is frozen into the revision-scoped snapshot store BEFORE the
   * rewrite — the rewrite itself bumps the document revision (generation is
   * a new revision), so the pre-regeneration bytes stay revertable via
   * GET /v1/documents/{id}/snapshot-files?revision=<old>&path=<file>.
   */
  regenerateTexWorkspace(projectId: string, rootFile = 'paper.tex'): {
    document_id: string
    revision: number
    files: string[]
    created: boolean
    regenerated: boolean
  } {
    const document = this.texEnsure(projectId, rootFile)
    if (this.tex.tree(document.document_id).files.length > 0) {
      this.tex.snapshot(document.document_id)
    }
    const generated = this.generateTexWorkspace(projectId, rootFile)
    return { ...generated, created: false, regenerated: true }
  }

  /**
   * Generate a versioned TeX workspace from the ledger (gui-plugin-plan
   * §11): paper.tex with title/abstract/methods/results/limitations and a
   * main.bib from the frozen corpus. Creates the document if absent; every
   * generation writes a new revision via the CAS.
   */
  generateTexWorkspace(projectId: string, rootFile = 'paper.tex'): { document_id: string; revision: number; files: string[] } {
    const project = this.getProject(projectId)
    const document = this.texEnsure(projectId, rootFile)
    const latex = this.buildManuscript(projectId, 'latex', true)
    const paperTex = latex.text
    const bibtex = latex.bibtex.trim() !== '' ? latex.bibtex : `@misc{corpus,\n  title = {Frozen corpus for ${escapeLatex(project.name)}},\n}\n`
    this.texWriteFile(document.document_id, 'paper.tex', paperTex)
    this.texWriteFile(document.document_id, 'main.bib', bibtex)
    const tree = this.texTree(document.document_id)
    return { document_id: document.document_id, revision: tree.document.revision, files: tree.files.map(f => f.path) }
  }

  // ── Interactive Terminal PTY-01 (execution-runtime.md §6.1) ─────────────
  //
  // Interface layer: durable sessions, the open→attached→detached→closed
  // state machine, client_seq idempotent control, server seq/gap/retention
  // output and the pinned lease. The real tty allocation is the ADAPTER
  // (LocalDockerPty/RemoteRunnerPty — later round); until one is registered
  // the kernel ships NullPtyAdapter and the HTTP open route answers 501.
  //
  // SECURITY: pty frames live only in pty_frames. Nothing here touches
  // jobs/runs/evidence/gates/metrics — PTY output can never become a formal
  // Job log, Metrics, RunManifest, accepted Evidence or Gate Decision
  // (enforced by pty-session.test.ts `pty-not-evidence`).

  /** Register (or replace) the PTY adapter; null detaches all adapters. */
  setPtyAdapter(adapter: PtyAdapter | null): void {
    this.ptyAdapter = adapter
  }

  /** True when a real adapter is registered (HTTP open creates sessions
   * only then — an inert session would mislead the UI). */
  hasPtyAdapter(): boolean {
    return this.ptyAdapter !== null
  }

  /** The active adapter (NullPtyAdapter when none is registered). */
  getPtyAdapter(): PtyAdapter {
    return this.ptyAdapter ?? new NullPtyAdapter()
  }

  /** Build the PTY authority against current durable state for every call.
   * No context, membership, runner binding or adapter decision is cached. */
  private currentPtyContextAuthority(): PtyContextAuthority {
    return new PtyContextAuthority(this.db, {
      getProject: projectId => this.getProject(projectId),
      getProjectMember: (projectId, principalId) => {
        const member = this.listProjectMembers(projectId).find(candidate => candidate.principal_id === principalId)
        return member === undefined ? null : { tenant_id: member.tenant_id }
      },
      getRunnerTarget: targetId => {
        try { return this.getRunnerTarget(targetId) } catch { return null }
      },
      activeAdapterId: () => this.ptyAdapter?.id ?? null,
    })
  }

  /** Current principal's safe Research/Chat/Subagent context projection. */
  ptyContexts(projectId: string, principalId: string): import('@dsh-scholar/research-schemas').PtyContext[] {
    return this.currentPtyContextAuthority().list(projectId, principalId)
  }

  /** Resolve one opaque context id to server-owned authority. */
  ptyResolveContext(contextId: string, principalId: string): PtyResolvedContext {
    return this.currentPtyContextAuthority().resolve(contextId, principalId)
  }

  /**
   * PTY-01: a session transitioned to CLOSED (explicit close control,
   * explicit close, idle TTL sweep, lease expiry) — the adapter must tear
   * down the real process. The store owns the state machine, the adapter
   * owns the process; a delivery failure never breaks the transition (the
   * adapter surfaces its own error channel).
   */
  private ptyNotifyClosed(sessionId: string): void {
    const adapter = this.ptyAdapter
    if (adapter === null) return
    try {
      adapter.kill(sessionId)
    } catch {
      // ignore — the state transition is already committed
    }
  }

  /** Re-validate a server-resolved context against current project/runner
   * authority. A stale project target, disabled target or unavailable remote
   * target never falls back to the host PTY adapter. */
  private assertPtyContextCurrent(context: PtyResolvedContext): void {
    const project = this.getProject(context.project_id)
    if (!this.listProjectMembers(project.project_id).some(member => member.principal_id === context.principal_id)) {
      throw new PtyError('pty_principal_mismatch', 'PTY context owner is no longer a project member')
    }
    if (project.execution.runner_profile_id !== context.profile
      || project.execution.runner_target_id !== context.target) {
      throw new PtyError('pty_context_stale', 'PTY context execution binding is stale')
    }
    const profile = getRunnerProfile(context.profile)
    if (profile === null || !profile.enabled) {
      throw new PtyError('pty_target_unsupported', `runner profile ${context.profile} is unavailable`)
    }
    const target = this.listRunnerTargets().find(candidate => candidate.target_id === context.target)
    if (target === undefined || target.kind !== context.target_kind) {
      throw new PtyError('pty_context_stale', 'PTY context target no longer matches the registered target')
    }
    if (!target.enabled || target.draining) {
      throw new PtyError('pty_target_unavailable', `runner target ${target.target_id} is not accepting PTY sessions`)
    }
    if (target.kind === 'remote-ssh' && target.health !== 'online') {
      throw new PtyError('pty_target_unavailable', `remote runner target ${target.target_id} is not online`)
    }
    const requiredAdapter = target.kind === 'local-process'
      ? 'local-pty'
      : (target.kind === 'local-docker' ? 'local-docker' : 'remote-runner')
    if (this.ptyAdapter?.id !== requiredAdapter) {
      throw new PtyError('pty_target_unsupported', `runner target ${target.target_id} has no compatible PTY adapter`)
    }
  }

  /** PTY mutations are terminal_write capabilities. Read-only project
   * roles may inspect safe context/session projections, but they cannot
   * create, attach, detach, control or close an interactive process. */
  private assertPtyTerminalWrite(context: PtyResolvedContext): void {
    const role = this.getProjectMemberRole(context.project_id, context.principal_id)
    if (role !== 'pi' && role !== 'operator' && role !== 'researcher') {
      throw new KernelError(403, 'role_forbidden', 'terminal_write requires PI, operator or researcher role')
    }
  }

  /**
   * PTY-01 open: validate the pinned request (project, workspace, relative
   * cwd), create the durable session (state 'open', lease pinned) and hand
   * the spawn plan to the adapter. A failed spawn closes the session with
   * close_reason='adapter_failed' (the row stays for audit) and this call
   * throws PtyError('pty_adapter_failed'). `principal` is REQUIRED
   * (fail-closed — the HTTP layer injects the authenticated principal).
   */
  ptyOpen(request: import('@dsh-scholar/research-schemas').PtyOpenRequest, opts: {
    context: PtyResolvedContext
    adapter?: PtyAdapter | null
  }): import('@dsh-scholar/research-schemas').PtySession {
    const context = opts.context
    this.assertPtyContextCurrent(context)
    this.assertPtyTerminalWrite(context)
    if (request.context_id !== context.context_id) {
      throw new PtyError('pty_context_mismatch', 'PTY open request does not match the resolved context')
    }
    const workspace = this.resolveWorkspace(request.workspace_id)
    if (workspace.project_id !== context.project_id) {
      throw new PtyError('pty_context_mismatch', 'PTY workspace belongs to another context project')
    }
    const cwd = validatePtyCwd(request.cwd)
    const effectiveConfig = this.configEffective(context.project_id)
    const positiveInteger = (key: string): number => {
      const value = effectiveConfig.config[key]
      if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
        throw new KernelError(500, 'config_effective_invalid', `effective config key ${key} is not a positive integer`)
      }
      return value
    }
    const session = this.pty.createContextSession({ ...request, cwd }, context, {
      config_hash: effectiveConfig.config_pin,
      idle_ttl_s: positiveInteger('kernel.pty_idle_ttl_s'),
      retention_bytes: positiveInteger('kernel.pty_retention_bytes'),
      lease_ttl_s: positiveInteger('kernel.pty_lease_ttl_s'),
      adapter_id: (opts.adapter ?? this.ptyAdapter)?.id ?? 'none',
    })
    const adapter = opts.adapter !== undefined ? opts.adapter : this.ptyAdapter
    if (adapter !== null && adapter !== undefined) {
      const result = adapter.spawn({
        pty_session_id: session.pty_session_id,
        project_id: session.project_id,
        workspace_id: session.workspace_id,
        preset: session.preset,
        cwd: session.cwd,
        cols: request.cols ?? 80,
        rows: request.rows ?? 24,
        profile: session.profile,
        target: session.target,
        config_hash: session.config_hash,
        // STORE-06: the spawn plan receives only the freshly-minted token
        // returned by createContextSession in this process.
        lease_token: session.lease_token ?? '',
      })
      if (!result.ok) {
        this.pty.closeSession(session.pty_session_id, 'adapter_failed')
        throw new PtyError('pty_adapter_failed', `pty adapter ${adapter.id} failed to spawn: ${result.error}`)
      }
    }
    return session
  }

  /** Owner-checked context discovery for the HTTP adapter. The adapter must
   * resolve the returned id through its trusted context authority and then
   * call one of the fully fenced methods below. */
  ptyContextForOwner(sessionId: string, principal: { principal_id: string }): {
    project_id: string
    context_kind: import('@dsh-scholar/research-schemas').PtyContextKind
    context_id: string
    parent_session_id: string | null
  } {
    return this.pty.contextForOwner(sessionId, principal)
  }

  ptyGet(sessionId: string, context: PtyResolvedContext, expectedGeneration: number): import('@dsh-scholar/research-schemas').PtySession {
    this.assertPtyContextCurrent(context)
    return this.pty.assertContextAccess(sessionId, context, expectedGeneration)
  }

  ptyListContext(context: PtyResolvedContext): import('@dsh-scholar/research-schemas').PtyContextSessions {
    this.assertPtyContextCurrent(context)
    return this.pty.listContextSessions(context)
  }

  /** Attach a wire (open|detached → attached); generation bumps for
   * reconnect fencing (generation + after_seq). */
  ptyAttach(sessionId: string, context: PtyResolvedContext, expectedGeneration: number): import('@dsh-scholar/research-schemas').PtySession {
    this.assertPtyContextCurrent(context)
    this.assertPtyTerminalWrite(context)
    return this.pty.attachContext(sessionId, context, expectedGeneration)
  }

  /** Detach the wire — the process keeps running (a PTY disconnect never
   * ends the process, execution-runtime.md §6.1). */
  ptyDetach(sessionId: string, context: PtyResolvedContext, expectedGeneration: number): import('@dsh-scholar/research-schemas').PtySession {
    this.assertPtyContextCurrent(context)
    this.assertPtyTerminalWrite(context)
    return this.pty.detachContext(sessionId, context, expectedGeneration)
  }

  /** Permission revocation: detach immediately (or no-op when already
   * detached); the session stays until close/TTL. */
  ptyRevoke(sessionId: string, context: PtyResolvedContext, expectedGeneration: number): import('@dsh-scholar/research-schemas').PtySession {
    this.assertPtyContextCurrent(context)
    return this.pty.revokeContext(sessionId, context, expectedGeneration)
  }

  /** Explicit close (idempotent) — the real process is torn down too. */
  ptyClose(sessionId: string, context: PtyResolvedContext, expectedGeneration: number): import('@dsh-scholar/research-schemas').PtySession {
    this.assertPtyContextCurrent(context)
    this.assertPtyTerminalWrite(context)
    const session = this.pty.closeContext(sessionId, context, expectedGeneration)
    this.ptyNotifyClosed(sessionId)
    return session
  }

  /**
   * Apply one control frame with client_seq idempotency (duplicate → replay
   * no-op, reordered/gapped → 409 pty_client_seq_out_of_order). Frames are
   * audited in pty_frames; delivery to the real tty happens only when an
   * adapter is attached (`delivered` in the result). A `close` control also
   * tears the real process down.
   */
  ptyControl(sessionId: string, request: import('@dsh-scholar/research-schemas').PtyControlRequest, context: PtyResolvedContext, adapter?: PtyAdapter | null): PtyControlResult {
    this.assertPtyContextCurrent(context)
    this.assertPtyTerminalWrite(context)
    const result = this.pty.applyContextControl(sessionId, request, context, adapter !== undefined ? adapter : this.ptyAdapter)
    if (request.type === 'close' && !result.idempotent) this.ptyNotifyClosed(sessionId)
    return result
  }

  /** Append adapter output (output/exit frames) with monotonic server seq
   * and bounded retention (eviction reports a gap, never silence). */
  ptyAppendOutput(sessionId: string, frames: Parameters<PtySessionStore['appendOutput']>[1]): PtyAppendResult {
    return this.pty.appendOutput(sessionId, frames)
  }

  /** Read output frames after a cursor; gap=true when retention evicted
   * seqs the client missed (pty-reconnect-seq / retention-gap). */
  ptyFrames(sessionId: string, afterSeq: number, context: PtyResolvedContext, expectedGeneration: number): ReturnType<PtySessionStore['frames']> {
    this.assertPtyContextCurrent(context)
    return this.pty.framesContext(sessionId, afterSeq, context, expectedGeneration)
  }

  /** PTY-01 (hardening §5 P0-2): constant-time lease verification for
   * read/control/frames — the opaque token pinned at open must be echoed on
   * control; a missing or wrong lease is never a pass (the HTTP layer
   * answers 403 lease_required / lease_invalid). */
  ptyVerifyLease(sessionId: string, token: string): boolean {
    return this.pty.verifyLease(sessionId, token)
  }

  /** Idle TTL sweep — closes every session idle longer than the
   * idle_ttl_s pinned in its session row and tears the
   * real tty down. Runs on the kernel-owned timer plus explicit calls. */
  ptySweepIdle(now = Date.now()): string[] {
    const closed = this.pty.sweepIdle(now)
    for (const sessionId of closed) this.ptyNotifyClosed(sessionId)
    return closed
  }

  /** Touch activity (a reconnecting wire resets the idle TTL). */
  ptyTouch(sessionId: string, context: PtyResolvedContext, expectedGeneration: number): import('@dsh-scholar/research-schemas').PtySession {
    this.assertPtyContextCurrent(context)
    this.pty.assertContextAccess(sessionId, context, expectedGeneration)
    return this.pty.touch(sessionId)
  }

  // ── generic Workspace WORK-01 (api-contracts.md §17) ────────────────────

  resolveWorkspace(workspaceId: string): import('@dsh-scholar/research-schemas').WorkspaceInfo {
    return this.workspaceModule.resolve(workspaceId)
  }

  workspaceEnsure(projectId: string, kind: import('@dsh-scholar/research-schemas').WorkspaceKind, name: string): import('@dsh-scholar/research-schemas').WorkspaceInfo {
    return this.workspaceModule.ensure(projectId, kind, name)
  }

  workspaceGet(workspaceId: string): import('@dsh-scholar/research-schemas').WorkspaceInfo {
    return this.workspaceModule.get(workspaceId)
  }

  workspaceTree(workspaceId: string): { info: import('@dsh-scholar/research-schemas').WorkspaceInfo; nodes: import('@dsh-scholar/research-schemas').WorkspaceNode[] } {
    return this.workspaceModule.tree(workspaceId)
  }

  workspaceRead(workspaceId: string, path: string): import('@dsh-scholar/research-schemas').WorkspaceNode | null {
    return this.workspaceModule.read(workspaceId, path)
  }

  workspaceWrite(workspaceId: string, path: string, content: string, expected?: WorkspaceExpected): import('@dsh-scholar/research-schemas').WorkspaceNode {
    return this.workspaceModule.write(workspaceId, path, content, expected)
  }

  workspaceWriteBinary(workspaceId: string, path: string, bytes: Uint8Array, media: string, expected?: WorkspaceExpected): import('@dsh-scholar/research-schemas').WorkspaceNode {
    return this.workspaceModule.writeBinary(workspaceId, path, bytes, media, expected)
  }

  workspaceDelete(workspaceId: string, path: string, expected?: WorkspaceExpected): void {
    this.workspaceModule.delete(workspaceId, path, expected)
  }

  workspaceMove(workspaceId: string, fromPath: string, toPath: string, expected?: WorkspaceExpected): import('@dsh-scholar/research-schemas').WorkspaceNode {
    return this.workspaceModule.move(workspaceId, fromPath, toPath, expected)
  }

  workspaceHistory(workspaceId: string): import('@dsh-scholar/research-schemas').WorkspaceRevision[] {
    return this.workspaceModule.history(workspaceId)
  }

  workspaceBlob(workspaceId: string, path: string): Buffer | null {
    return this.workspaceModule.blob(workspaceId, path)
  }

  workspaceList(projectId: string): import('@dsh-scholar/research-schemas').WorkspaceInfo[] {
    return this.workspaceModule.list(projectId)
  }

  assertWorkspaceInProject(workspaceId: string, projectId: string): void {
    this.workspaceModule.assertInProject(workspaceId, projectId)
  }

  workspaceListSince(workspaceId: string, sinceRevision: number): { info: import('@dsh-scholar/research-schemas').WorkspaceInfo; nodes: import('@dsh-scholar/research-schemas').WorkspaceNode[]; deleted: string[] } {
    return this.workspaceModule.listSince(workspaceId, sinceRevision)
  }

  workspaceSearch(workspaceId: string, query: { prefix?: string; glob?: string }): { info: import('@dsh-scholar/research-schemas').WorkspaceInfo; nodes: import('@dsh-scholar/research-schemas').WorkspaceNode[] } {
    return this.workspaceModule.search(workspaceId, query)
  }

  workspaceSearchContent(workspaceId: string, query: import('./workspace-store.js').WorkspaceContentSearchQuery): import('./workspace-store.js').WorkspaceContentSearchResult {
    return this.workspaceModule.searchContent(workspaceId, query)
  }

  workspaceReadVersion(workspaceId: string, path: string, version: number): import('@dsh-scholar/research-schemas').WorkspaceNode | null {
    return this.workspaceModule.readVersion(workspaceId, path, version)
  }

  /**
   * WORK-01 §5 P2 (hardening-v0.2-status.md §5): recovery scan over the
   * generic (disk-backed) workspaces — reconcile disk bytes ↔
   * `workspace_nodes` ↔ the `workspace_ops` ledger, repair crash-window
   * inconsistencies (or isolate the workspace with a durable quarantine
   * marker), and remove orphan `.ws-tmp-*` leftovers. Run automatically at
   * kernel startup; call on demand after host-side repairs. Returns one
   * report per scanned workspace (all when `workspaceId` is omitted).
   */
  scanWorkspaceIntegrity(workspaceId?: string): import('./workspace-store.js').WorkspaceIntegrityReport[] {
    return this.workspaceModule.scanIntegrity(workspaceId)
  }

  // ── evidence & claims (design §4.7) ──────────────────────────────────────

  ingestEvidence(input: {
    project_id: string
    source_type: 'run' | 'analysis' | 'external-passage' | 'reproduction'
    run_ids: string[]
    artifact_refs: string[]
    analysis_method: string
    result: EvidenceItem['result']
    uncertainty?: string
    /** v2 §13.1: agent-written notes are draft_unverified; verified is
     * reserved for the Analysis Worker internal path (ingestVerifiedEvidence);
     * accepted is written only by the internal Verifier/Auditor path
     * (acceptEvidence) — never via the public HTTP route. */
    provenance_status?: 'draft_unverified' | 'legacy_unverified' | 'verified' | 'accepted'
  }): import('@dsh-scholar/research-schemas').EvidenceItem {
    this.getProject(input.project_id)
    // Note: the PUBLIC HTTP route rejects 'verified'/'accepted' (evidenceSchema);
    // ingestVerifiedEvidence is the internal Analysis-Worker path that sets
    // 'verified' here, and acceptEvidence is the internal Verifier/Auditor
    // path that sets 'accepted'. Kernel-level callers are trusted internal
    // surfaces.
    const item = {
      evidence_id: randomId('evidence'),
      project_id: input.project_id,
      source_type: input.source_type,
      run_ids: input.run_ids,
      artifact_refs: input.artifact_refs,
      analysis_method: input.analysis_method,
      result: input.result,
      uncertainty: input.uncertainty ?? '',
      status: 'accepted' as const,
      generated_by: 'statistician',
      created_at: nowIso(),
    }
    const provenance = input.provenance_status ?? 'legacy_unverified'
    // The provenance travels INSIDE the stored body too (listEvidence
    // reparses it; verifyClaim filters on it — hardening EVID-01).
    const stored = { ...item, provenance_status: provenance }
    this.db.prepare('INSERT INTO evidence (evidence_id, project_id, body, provenance_status, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(item.evidence_id, item.project_id, JSON.stringify(stored), provenance, item.created_at)
    return stored as import('@dsh-scholar/research-schemas').EvidenceItem & { provenance_status: string }
  }

  /** v2 §13.1 / §17.3: Analysis-Worker-only verified evidence path. */
  ingestVerifiedEvidence(input: Parameters<ResearchKernel['ingestEvidence']>[0]): import('@dsh-scholar/research-schemas').EvidenceItem {
    return this.ingestEvidence({ ...input, provenance_status: 'verified' })
  }

  /**
   * §6 (acceptance-tests.md): Verifier/Auditor accept transition of the
   * provenance state machine draft_unverified → verified → accepted. Only
   * `accepted` evidence may support a Claim; the transition re-validates the
   * RunManifest, Contract, RunSet and Analysis Artifacts behind the evidence,
   * records the service principal + request_id in the body, and emits
   * `evidence.accepted` to the outbox.
   */
  acceptEvidence(input: {
    project_id: string
    evidence_id: string
    service_principal: string
    request_id: string
  }): import('@dsh-scholar/research-schemas').EvidenceItem & {
    provenance_status: string
    acceptance: { accepted_by: string; accepted_at: string; request_id: string }
  } {
    // Service identity: only Verifier/Auditor service principals may accept.
    if (typeof input.service_principal !== 'string' || input.service_principal === '') {
      throw new KernelError(403, 'service_identity_required',
        'accept requires a non-empty service principal (x-service-principal: verifier|auditor)')
    }
    const inProject = this.listEvidence(input.project_id).find(e => e.evidence_id === input.evidence_id)
    if (inProject === undefined) {
      // Distinguish 404 (unknown id) from 422 (exists in ANOTHER project).
      const anywhere = this.db.prepare('SELECT body FROM evidence WHERE evidence_id = ?').get(input.evidence_id) as { body?: string } | undefined
      if (anywhere?.body !== undefined) {
        throw new KernelError(422, 'evidence_foreign',
          `evidence ${input.evidence_id} belongs to another project (cross-project accept is rejected)`)
      }
      throw new KernelError(404, 'evidence_not_found', `evidence ${input.evidence_id} not found`)
    }
    if (inProject.project_id !== input.project_id) {
      throw new KernelError(422, 'evidence_foreign',
        `evidence ${input.evidence_id} belongs to project ${inProject.project_id}, not ${input.project_id}`)
    }
    const provenance = (inProject as { provenance_status?: string }).provenance_status
    if (provenance !== 'verified') {
      throw new KernelError(409, 'provenance_not_verified',
        `evidence ${input.evidence_id} has provenance_status '${provenance ?? 'unknown'}'; only verified evidence may transition to accepted (verified → accepted)`)
    }
    // ── Revalidation (acceptance-tests.md §6) ──────────────────────────────
    // RunManifest: every run_id must resolve to a same-project SUCCEEDED job
    // with a run manifest, and the manifest must re-verify against the job.
    const jobs = this.listJobs(input.project_id)
    for (const runId of inProject.run_ids) {
      const job = jobs.find(j =>
        j.job_id === runId
        || j.idempotency_key === runId
        || (j.run_manifest !== null && typeof j.run_manifest.run_id === 'string' && j.run_manifest.run_id === runId),
      )
      if (job === undefined) {
        throw new KernelError(422, 'evidence_revalidation_failed',
          `accept revalidation failed: run_id ${runId} does not resolve to a job of project ${input.project_id}`)
      }
      if (job.status !== 'succeeded' || job.run_manifest === null) {
        throw new KernelError(422, 'evidence_revalidation_failed',
          `accept revalidation failed: run_id ${runId} resolves to job ${job.job_id} in status '${job.status}' without a run manifest`)
      }
      this.verifyRunManifest(job.run_manifest, job)
      // Contract: the job's (or manifest's) contract must exist and be approved.
      const contractId = job.contract_id ?? (typeof job.run_manifest.contract_id === 'string' ? job.run_manifest.contract_id : null)
      if (contractId === null || contractId === '') {
        throw new KernelError(422, 'evidence_revalidation_failed',
          `accept revalidation failed: job ${job.job_id} (run ${runId}) has no bound contract`)
      }
      let contract: ExperimentContract
      try {
        contract = this.getContract(contractId)
      } catch {
        throw new KernelError(422, 'evidence_revalidation_failed',
          `accept revalidation failed: contract ${contractId} of run ${runId} not found`)
      }
      if (contract.status !== 'approved') {
        throw new KernelError(422, 'evidence_revalidation_failed',
          `accept revalidation failed: contract ${contractId} of run ${runId} is '${contract.status}', not approved`)
      }
      // RunSet: the succeeded run must carry a metrics artifact.
      if (typeof job.run_manifest.metrics_artifact !== 'string' || job.run_manifest.metrics_artifact === '') {
        throw new KernelError(422, 'evidence_revalidation_failed',
          `accept revalidation failed: run ${runId} has no metrics_artifact in its run manifest`)
      }
    }
    // Analysis Artifact: non-empty artifact_refs, every ref registered in THIS project.
    if (!Array.isArray(inProject.artifact_refs) || inProject.artifact_refs.length === 0) {
      throw new KernelError(422, 'evidence_revalidation_failed',
        'accept revalidation failed: evidence has no artifact_refs (an analysis artifact is required)')
    }
    for (const ref of inProject.artifact_refs) {
      try {
        this.getArtifact(input.project_id, ref)
      } catch {
        throw new KernelError(422, 'evidence_revalidation_failed',
          `accept revalidation failed: artifact ref ${ref} is not registered in project ${input.project_id}`)
      }
    }
    // ── Transition: record acceptance + flip provenance in the SAME body ──
    const acceptance = {
      accepted_by: input.service_principal,
      accepted_at: nowIso(),
      request_id: input.request_id,
    }
    const updated = { ...inProject, provenance_status: 'accepted', acceptance }
    this.db.prepare("UPDATE evidence SET body = ?, provenance_status = 'accepted' WHERE evidence_id = ?")
      .run(JSON.stringify(updated), input.evidence_id)
    this.emit(input.project_id, 'evidence.accepted', {
      evidence_id: input.evidence_id,
      request_id: input.request_id,
      accepted_by: input.service_principal,
    })
    return updated
  }

  /** v2 §13.1: only verified (Analysis-Worker) evidence is listed; kept for
   * compatibility — claim support now requires `accepted` (see
   * listAcceptedEvidence). */
  listVerifiedEvidence(projectId: string): Array<import('@dsh-scholar/research-schemas').EvidenceItem> {
    const rows = this.db.prepare(
      "SELECT * FROM evidence WHERE project_id = ? AND provenance_status = 'verified' ORDER BY created_at",
    ).all(projectId) as unknown as Array<{ body: string }>
    return rows.map(row => JSON.parse(row.body) as import('@dsh-scholar/research-schemas').EvidenceItem)
  }

  /** §6: only accepted (Verifier/Auditor-accepted) evidence may support a
   * Claim; UI/tests use this to list claim-eligible evidence. */
  listAcceptedEvidence(projectId: string): Array<import('@dsh-scholar/research-schemas').EvidenceItem & { provenance_status: string; acceptance?: { accepted_by: string; accepted_at: string; request_id: string } }> {
    const rows = this.db.prepare(
      "SELECT * FROM evidence WHERE project_id = ? AND provenance_status = 'accepted' ORDER BY created_at",
    ).all(projectId) as unknown as Array<{ body: string }>
    return rows.map(row => JSON.parse(row.body) as import('@dsh-scholar/research-schemas').EvidenceItem & { provenance_status: string })
  }

  listEvidence(projectId: string): import('@dsh-scholar/research-schemas').EvidenceItem[] {
    const rows = this.db.prepare('SELECT * FROM evidence WHERE project_id = ? ORDER BY created_at').all(projectId) as unknown as Array<{ body: string }>
    return rows.map(row => JSON.parse(row.body) as import('@dsh-scholar/research-schemas').EvidenceItem)
  }

  /** Deterministic claim verification against evidence (design §4.7, §11.3). */
  verifyClaim(input: {
    claim_id: string
    evidence_ids: string[]
    analysis_artifact?: string
    reason?: string
  }): Claim {
    const current = this.getClaim(input.claim_id)
    // hardening EVID-01 + §6: only ACCEPTED evidence (draft_unverified →
    // verified → accepted, the last step by a Verifier/Auditor) may support a
    // claim; draft notes, legacy rows and worker-verified-but-not-accepted
    // rows are all excluded from the verdict.
    const resolved = input.evidence_ids
      .map(id => this.listEvidence(current.project_id).find(e => e.evidence_id === id))
      .filter((e): e is NonNullable<typeof e> => e !== undefined)
    if (resolved.length === 0) {
      throw new KernelError(422, 'no_evidence', `claim ${input.claim_id} has no resolvable evidence`)
    }
    const evidence = resolved.filter(e => (e as { provenance_status?: string }).provenance_status === 'accepted')
    if (evidence.length === 0) {
      // Resolvable but not accepted: the verdict is inconclusive with an
      // explicit reason (no 422 — the ids exist, provenance is lacking).
      const update = this.db.prepare('UPDATE claims SET body = ?, updated_at = ? WHERE claim_id = ?')
      const currentBody = JSON.parse(JSON.stringify(current)) as Claim
      const inconclusive: Claim = {
        ...currentBody,
        status: 'inconclusive',
        history: [...(currentBody.history ?? []), { status: 'inconclusive' as Claim['status'], at: nowIso(), reason: 'requires accepted evidence (verified → accepted by Verifier/Auditor)' }],
      }
      update.run(JSON.stringify(inconclusive), nowIso(), input.claim_id)
      return inconclusive
    }
    // v2 §13.5: deterministic strict rules. Default is inconclusive.
    // supported requires: accepted evidence, effect size present, CI present,
    // n >= contract minimum (n_seeds or run count), CI excludes zero, and
    // effect direction consistent with the claim (no direction info -> at
    // most inconclusive).
    let status: Claim['status'] = 'inconclusive'
    const conflicted = evidence.some(e => e.status === 'conflicted')
    const complete = evidence.filter(e =>
      e.result.effect_size !== undefined
      && e.result.ci_low !== undefined && e.result.ci_high !== undefined
      && (e.result.n_seeds ?? e.run_ids.length) > 0,
    )
    if (!conflicted && complete.length > 0) {
      // §12 MetricSpec direction: lower-is-better inverts the sign
      // interpretation — a NEGATIVE effect (CI < 0) is the improvement and
      // supports the claim; a positive effect contradicts it. Evidence that
      // declares no direction defaults to higher_is_better.
      const directions = new Set(complete.map(e => e.result.direction ?? 'higher_is_better'))
      const lowerIsBetter = directions.size === 1 && directions.has('lower_is_better')
      const allCiExcludeZero = complete.every(e => e.result.ci_low! > 0 || e.result.ci_high! < 0)
      const anyNegativeEffect = complete.some(e => (e.result.effect_size ?? 0) < 0)
      const allPositiveEffect = complete.every(e => (e.result.effect_size ?? 0) > 0)
      const allNegativeEffect = complete.every(e => (e.result.effect_size ?? 0) < 0)
      if (allCiExcludeZero && lowerIsBetter) {
        if (allNegativeEffect) {
          status = 'supported'
        } else if (allPositiveEffect) {
          status = 'contradicted'
        } else {
          status = 'inconclusive' // mixed directions
        }
      } else if (allCiExcludeZero && allPositiveEffect) {
        status = 'supported'
      } else if (allCiExcludeZero && anyNegativeEffect && !allPositiveEffect) {
        status = 'contradicted'
      } else {
        status = 'inconclusive' // CI crosses zero or mixed directions
      }
    }
    const next: Claim = {
      ...current,
      evidence: { evidence_ids: input.evidence_ids, analysis_artifact: input.analysis_artifact ?? current.evidence.analysis_artifact },
      status,
      confidence: status === 'supported' ? 'high' : status === 'contradicted' ? 'high' : 'medium',
      history: [...current.history, { status, at: nowIso(), reason: input.reason ?? `verified against ${evidence.length} accepted evidence item(s)` }],
      updated_at: nowIso(),
    }
    this.db.prepare('UPDATE claims SET body = ?, updated_at = ? WHERE claim_id = ?').run(JSON.stringify(next), next.updated_at, input.claim_id)
    this.emit(current.project_id, 'claim.updated', { claim_id: input.claim_id, status })
    return next
  }

  createClaim(input: { project_id: string; statement: string; scope?: Claim['scope'] }): Claim {
    this.getProject(input.project_id)
    const claim: Claim = {
      claim_id: buildClaimId(),
      project_id: input.project_id,
      statement: input.statement,
      scope: input.scope ?? { dataset: '', split: '' },
      evidence: { evidence_ids: [] },
      status: 'proposed',
      confidence: 'medium',
      limitations: [],
      history: [{ status: 'proposed', at: nowIso(), reason: '' }],
      created_at: nowIso(),
      updated_at: nowIso(),
    }
    this.db.prepare('INSERT INTO claims (claim_id, project_id, body, updated_at) VALUES (?, ?, ?, ?)')
      .run(claim.claim_id, claim.project_id, JSON.stringify(claim), claim.updated_at)
    return claim
  }

  getClaim(claimId: string): Claim {
    const row = this.db.prepare('SELECT * FROM claims WHERE claim_id = ?').get(claimId) as { body?: string } | undefined
    if (row?.body === undefined) throw new KernelError(404, 'claim_not_found', `claim ${claimId} not found`)
    return JSON.parse(row.body) as Claim
  }

  listClaims(projectId: string): Claim[] {
    const rows = this.db.prepare('SELECT * FROM claims WHERE project_id = ? ORDER BY updated_at').all(projectId) as unknown as Array<{ body: string }>
    return rows.map(row => JSON.parse(row.body) as Claim)
  }

  // ── analysis pipeline (design §4.7, §11.3 Statistics) ────────────────────

  /**
   * Deterministic multi-seed analysis over succeeded formal runs: aggregate
   * metrics from RunManifest metrics artifacts in CAS, compute mean, sd,
   * percentile bootstrap 95% CI and effect size vs the baseline run. Writes
   * one analysis artifact; numbers in manuscripts must come from this.
   */
  computeAnalysis(projectId: string, contractId?: string, metric?: string, options: {
    /** Minimum completed seeds required (v2 §13.6; default 1 keeps compat). */
    minimum_n?: number
    /** Restrict to these job kinds (v2 §13.6: never mix kinds). Defaults to
     * formal; falls back to non-baseline kinds only when no formal exists. */
    kinds?: string[]
  } = {}): {
    artifact_id: string
    chart_artifact: string
    contract_id: string | null
    metric: string
    runs: Array<{ run_id: string; job_id: string; value: number; seed?: number }>
    mean: number
    sd: number
    n: number
    ci_low: number
    ci_high: number
    baseline_value: number | null
    effect_size: number | null
    used_kinds: string[]
    generated_at: string
  } {
    const project = this.getProject(projectId)
    const jobs = this.listJobs(projectId).filter(j => j.status === 'succeeded' && j.run_manifest !== null)
    const metricValues: Array<{ run_id: string; job_id: string; kind: string; value: number; seed?: number }> = []
    let baselineValue: number | null = null
    let formalSeen = false
    for (const job of jobs) {
      if (contractId !== undefined && job.contract_id !== contractId) continue
      if (job.kind === 'formal') formalSeen = true
      const metricsArtifact = job.run_manifest?.metrics_artifact
      if (typeof metricsArtifact !== 'string') continue
      const sha = metricsArtifact.replace(/^sha256:/, '')
      if (!this.cas.has(sha)) continue
      // §12.5 (SCH-EXEC-002): metrics artifacts carry the fixed-schema file
      // record ({schema_version, seed, metrics: [{name, value, unit}]});
      // legacy stdout-derived artifacts used {metric, value, seed}. Both keys
      // are accepted, and the §12.5 top-level `seed` is used as the per-entry
      // fallback.
      const parsed = JSON.parse(this.cas.read(sha).toString('utf8')) as { metrics?: Array<{ metric?: string; name?: string; value?: number; seed?: number }>; seed?: number }
      for (const entry of parsed.metrics ?? []) {
        const metricName = entry.name ?? entry.metric
        if (entry.value === undefined || metricName === undefined) continue
        if (metric !== undefined && metricName !== metric) continue
        metricValues.push({
          run_id: typeof job.run_manifest?.run_id === 'string' ? job.run_manifest.run_id : job.job_id,
          job_id: job.job_id,
          kind: job.kind,
          value: entry.value,
          seed: entry.seed ?? parsed.seed,
        })
        if (job.kind === 'baseline' && baselineValue === null) baselineValue = entry.value
      }
    }
    // v2 §13.6: never mix job kinds. Prefer formal runs; only when a contract
    // has none, fall back to the other non-baseline kinds (explicitly noted).
    let allowedKinds = options.kinds ?? ['formal']
    const hasFormal = formalSeen
    if (options.kinds === undefined && !hasFormal) allowedKinds = ['pilot', 'smoke', 'analysis', 'reproduce']
    // Baseline runs always stay in the set: they are the pairing side.
    const kindFiltered = metricValues.filter(v => v.kind === 'baseline' || allowedKinds.includes(v.kind))
    metricValues.length = 0
    metricValues.push(...kindFiltered)
    const usedKinds = [...new Set(kindFiltered.map(v => v.kind).filter(k => k !== 'baseline'))]
    if (metricValues.length === 0) {
      throw new KernelError(422, 'no_metrics', 'no succeeded runs with metrics artifacts found for analysis')
    }
    // §13.6 / STAT-01: THE analysis engine is the Analysis Worker's paired
    // mean-difference (matched-seed design, seeded percentile bootstrap).
    // The kernel never re-implements statistics — it collects baseline and
    // treatment runs, pairs them by seed, and delegates the math.
    // §12 MetricSpec direction + minimum_n: both resolved from the bound
    // contract (explicit contract_id, else the project's first approved
    // contract); direction defaults to higher_is_better, minimum_n to the
    // contract's stop_conditions.min_completed_seeds (fallback 1) and a
    // caller-lowered minimum_n is 422 (AnalysisPlan.minimum_n is
    // contract-driven, reconstruction-contracts.md §12).
    const approvedContracts = this.listContracts(projectId).filter(c => c.status === 'approved')
    const boundContract = contractId !== undefined
      ? approvedContracts.find(c => c.contract_id === contractId)
      : approvedContracts[0]
    let direction: 'higher_is_better' | 'lower_is_better' = 'higher_is_better'
    if (boundContract !== undefined && boundContract.metrics.direction !== undefined) {
      direction = boundContract.metrics.direction
    }
    const contractMinimum = boundContract?.stop_conditions.min_completed_seeds
    const minimumN = options.minimum_n ?? contractMinimum ?? 1
    if (contractMinimum !== undefined && options.minimum_n !== undefined && options.minimum_n < contractMinimum) {
      throw new KernelError(422, 'minimum_n_too_low',
        `analysis minimum_n ${options.minimum_n} < contract stop_conditions.min_completed_seeds ${contractMinimum} (cannot be lowered by the caller, §12)`)
    }
    const baselineRuns: Array<{ seed?: number; value: number }> = []
    const treatmentRuns: Array<{ seed?: number; value: number }> = []
    for (const v of metricValues) {
      if (v.kind === 'baseline') baselineRuns.push({ seed: v.seed, value: v.value })
      else treatmentRuns.push({ seed: v.seed, value: v.value })
    }
    // STAT-01 (P0): a seed that appears in MULTIPLE runs of the same group
    // (baseline or treatment) makes the matched-seed design ambiguous — the
    // old behavior silently overwrote/`find`-firsted it. Formal analyses now
    // reject duplicate seeds outright (422 duplicate_seed): each baseline and
    // each treatment seed must be unique across the collected runs.
    const assertUniqueSeeds = (group: string, runs: Array<{ seed?: number }>): void => {
      const seen = new Set<number>()
      for (const r of runs) {
        if (r.seed === undefined) continue
        if (seen.has(r.seed)) {
          throw new KernelError(422, 'duplicate_seed',
            `${group} seed ${r.seed} appears in multiple runs — duplicate seeds are rejected in formal analysis (STAT-01); re-run with unique seeds`)
        }
        seen.add(r.seed)
      }
    }
    assertUniqueSeeds('baseline', baselineRuns)
    assertUniqueSeeds('treatment', treatmentRuns)
    const baselineBySeed = new Map<number, number>()
    for (const b of baselineRuns) {
      if (b.seed !== undefined) baselineBySeed.set(b.seed, b.value)
    }
    const pairedSeeds = treatmentRuns
      .filter(t => t.seed !== undefined && baselineBySeed.has(t.seed!))
      .map(t => t.seed!)
    const uniquePaired = [...new Set(pairedSeeds)]
    if (uniquePaired.length < minimumN) {
      throw new KernelError(422, 'matched_seeds_required',
        `analysis requires >= ${minimumN} baseline/treatment runs with MATCHED seeds (paired design, §13.6); got ${uniquePaired.length}`)
    }
    const paired = uniquePaired.sort()
    const baselineValues = paired.map(s => baselineBySeed.get(s)!)
    const treatmentValues = paired.map(s => {
      const hit = treatmentRuns.find(t => t.seed === s)!
      return hit.value
    })
    const worker = this.analysisPort.computePaired(
      {
        contract_id: contractId ?? 'auto',
        metric: { name: metric ?? 'auto', direction, aggregation: 'mean' },
        paired_by: 'seed',
        baseline_run_set_id: 'kernel-baseline',
        treatment_run_set_id: 'kernel-treatment',
        method: { estimator: 'paired_mean_difference', interval: 'bootstrap_95', resamples: ANALYSIS_RESAMPLES },
        multiple_testing: 'holm',
        minimum_n: minimumN,
      },
      paired.map((s, i) => ({ run_id: `baseline-${s}`, seed: s, metric_value: baselineValues[i]! })),
      paired.map((s, i) => ({ run_id: `treatment-${s}`, seed: s, metric_value: treatmentValues[i]! })),
    )
    const mean = worker.treatment_mean
    const variance = treatmentValues.reduce((acc, v) => acc + (v - mean) ** 2, 0) / Math.max(treatmentValues.length - 1, 1)
    const sd = Math.sqrt(variance)
    const result = {
      contract_id: contractId ?? null,
      metric: metric ?? 'auto',
      direction,
      runs: metricValues
        .filter(v => v.kind !== 'baseline' && v.seed !== undefined && paired.includes(v.seed!))
        .map(({ kind: _kind, ...rest }) => rest),
      mean: round(worker.treatment_mean),
      sd: round(sd),
      n: worker.n_pairs,
      ci_low: round(worker.ci_low),
      ci_high: round(worker.ci_high),
      baseline_value: round(worker.baseline_mean),
      effect_size: round(worker.effect_size),
      adjusted_p_value: round(worker.adjusted_p_value),
      direction_ok: worker.direction_ok,
    }
    const artifact = this.registerArtifact({
      project_id: projectId,
      kind: 'analysis',
      content: JSON.stringify({ analysis: result, method: 'percentile-bootstrap-95', n_resamples: ANALYSIS_RESAMPLES, project_id: projectId }, null, 2),
      metadata: { kind: 'analysis', metric: result.metric, n: result.n, generated_by: 'research-kernel.computeAnalysis' },
    })
    this.emit(projectId, 'artifact.registered', { artifact_id: artifact.artifact_id, kind: 'analysis' })
    // Deterministic chart artifact bound to the same analysis numbers (§11.3).
    const chart = this.buildChartSvg(projectId, { artifact_id: artifact.artifact_id, ...result })
    return { artifact_id: artifact.artifact_id, chart_artifact: chart.chart_artifact, used_kinds: usedKinds, ...result, generated_at: nowIso() }
  }

  /**
   * Generate a deterministic SVG bar chart for one analysis result (design
   * §11.3 charts, E5): mean with bootstrap CI whiskers vs baseline. The SVG
   * is registered as a `chart` CAS artifact so manuscripts embed artifact
   * references, not ad-hoc numbers.
   */
  buildChartSvg(projectId: string, analysis: {
    artifact_id: string
    metric: string
    mean: number
    ci_low: number
    ci_high: number
    baseline_value: number | null
    n: number
  }): { chart_artifact: string; svg: string } {
    this.getProject(projectId)
    const W = 420, H = 260, M = { l: 60, r: 20, t: 30, b: 40 }
    const values = [analysis.baseline_value ?? analysis.mean, analysis.mean]
    const lo = Math.min(...values, analysis.ci_low)
    const hi = Math.max(...values, analysis.ci_high)
    const span = Math.max(hi - lo, 1e-9) * 1.25
    const scale = (v: number): number => H - M.b - ((v - lo) / span) * (H - M.t - M.b)
    const barW = 70
    const bar = (x: number, v: number, color: string, label: string): string => {
      const y = scale(Math.max(v, lo))
      const h = Math.max(H - M.b - y, 1)
      const textY = y - 6
      return `<rect x="${x}" y="${y}" width="${barW}" height="${h}" fill="${color}" rx="3"/>
        <text x="${x + barW / 2}" y="${textY}" text-anchor="middle" font-size="12" fill="#333">${label}: ${v.toFixed(4)}</text>`
    }
    const ciY = scale(analysis.ci_high)
    const ciH = Math.max(Math.abs(scale(analysis.ci_low) - scale(analysis.ci_high)), 1)
    const meanX = M.l + barW + 50
    const baselineX = M.l
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
  <text x="${W / 2}" y="20" text-anchor="middle" font-size="14" font-weight="bold">${escapeXml(analysis.metric)} — mean ± 95% bootstrap CI (n=${analysis.n})</text>
  ${analysis.baseline_value !== null ? bar(baselineX, analysis.baseline_value, '#9aa5b1', 'baseline') : ''}
  ${bar(meanX, analysis.mean, '#4c6ef5', 'treatment')}
  <rect x="${meanX + barW / 2 - 3}" y="${ciY}" width="6" height="${ciH}" fill="#f03e3e"/>
  <text x="${meanX + barW / 2}" y="${H - M.b + 18}" text-anchor="middle" font-size="11" fill="#555">analysis ${analysis.artifact_id.slice(0, 12)}</text>
</svg>`
    const record = this.registerArtifact({
      project_id: projectId,
      kind: 'chart',
      content: svg,
      metadata: { kind: 'chart', metric: analysis.metric, analysis_artifact: analysis.artifact_id },
    })
    return { chart_artifact: record.artifact_id, svg }
  }

  // ── manuscript & release bundle (design §4.8) ────────────────────────────

  /** Deterministic manuscript draft from the read-only Evidence Ledger. */
  buildManuscript(projectId: string, format: 'markdown' | 'latex' = 'markdown', includeLimitations = true): {
    manuscript_id: string
    format: string
    text: string
    artifact_id: string
    claims_used: number
    bibtex: string
  } {
    const project = this.getProject(projectId)
    const claims = this.listClaims(projectId)
    const evidence = this.listEvidence(projectId)
    const contracts = this.listContracts(projectId)
    const snapshots = this.listCorpusSnapshots(projectId)
    const supported = claims.filter(c => c.status === 'supported')
    const byEvidence = new Map<string, Claim[]>()
    for (const claim of claims) {
      for (const id of claim.evidence.evidence_ids ?? []) {
        byEvidence.set(id, [...(byEvidence.get(id) ?? []), claim])
      }
    }
    const evidenceRows = evidence.map(e => {
      const claimsFor = (byEvidence.get(e.evidence_id) ?? []).map(c => c.claim_id)
      return `| ${e.result.primary_metric} | ${e.result.value} | ${e.result.baseline_value ?? '—'} | ${e.result.effect_size ?? '—'} | ${e.result.ci_low ?? '—'}–${e.result.ci_high ?? '—'} | ${e.result.n_seeds ?? e.run_ids.length} | ${e.analysis_method} | ${claimsFor.join(', ') || '—'} |`
    })
    const lines: string[] = []
    if (format === 'latex') {
      lines.push('\\documentclass{article}', '\\usepackage{booktabs}', '\\begin{document}')
      lines.push(`\\title{${escapeLatex(project.name)}}`, '\\maketitle')
      lines.push('\\section{Abstract}')
      lines.push(abstractText(project, supported))
      lines.push('\\section{Methods}')
      for (const contract of contracts) {
        lines.push(`\\subsection{${escapeLatex(contract.methods.treatment)} vs ${escapeLatex(contract.methods.baseline)}}`)
        lines.push(`Dataset: ${escapeLatex(contract.data.dataset_id)} (split ${escapeLatex(contract.data.split)}), primary metric ${escapeLatex(contract.metrics.primary)}, seeds ${contract.seeds.join(', ')}.`)
      }
      lines.push('\\section{Results}')
      if (evidenceRows.length > 0) {
        // LaTeX tabular rows: '&'-separated, en dashes as '--' (§14.3: the
        // fixed build image must compile; raw unicode dashes break pdflatex).
        const latexRows = evidence.map(e => {
          const claimsFor = (byEvidence.get(e.evidence_id) ?? []).map(c => c.claim_id).join(', ') || '--'
          const ci = `${e.result.ci_low ?? '--'}--${e.result.ci_high ?? '--'}`
          return `${escapeLatex(e.result.primary_metric)} & ${e.result.value} & ${e.result.baseline_value ?? '--'} & ${e.result.effect_size ?? '--'} & ${ci} & ${e.result.n_seeds ?? e.run_ids.length} & ${escapeLatex(e.analysis_method)} & ${escapeLatex(claimsFor)}`
        })
        lines.push('\\begin{tabular}{llllllll}', '\\toprule', 'Metric & Value & Baseline & Effect & 95\\% CI & Seeds & Method & Claims \\\\', '\\midrule')
        lines.push(...latexRows.map(r => `${r} \\\\`))
        lines.push('\\bottomrule', '\\end{tabular}')
      } else {
        lines.push('No verified evidence items yet — results table intentionally empty.')
      }
      lines.push('\\section{Related Work}')
      for (const paper of snapshots.at(-1)?.papers ?? []) {
        lines.push(`\\cite{${paper.paper_id.replace(/[^a-zA-Z0-9]/g, '_')}} ${escapeLatex(paper.title)} (${paper.year ?? 'n.d.'}).`)
      }
      if (includeLimitations) {
        lines.push('\\section{Limitations}')
        for (const claim of claims) {
          if (claim.limitations.length > 0) lines.push(`\\begin{itemize} ${claim.limitations.map(l => `\\item ${escapeLatex(l)}`).join(' ')} \\end{itemize}`)
        }
      }
      lines.push('\\end{document}')
    } else {
      lines.push(`# ${project.name}`, '', '## Abstract', abstractText(project, supported), '', '## Methods')
      for (const contract of contracts) {
        lines.push(`### ${contract.methods.treatment} vs ${contract.methods.baseline}`, `- Dataset: ${contract.data.dataset_id} (split ${contract.data.split})`, `- Primary metric: ${contract.metrics.primary}`, `- Seeds: ${contract.seeds.join(', ')}`, `- Analysis: ${contract.analysis.effect_size}, ${contract.analysis.interval}, ${contract.analysis.multiple_testing}`)
      }
      lines.push('', '## Results')
      if (evidenceRows.length > 0) {
        lines.push('| Metric | Value | Baseline | Effect | 95% CI | Seeds | Method | Claims |', '|---|---|---|---|---|---|---|---|', ...evidenceRows)
      } else {
        lines.push('No verified evidence items yet — results table intentionally empty (evidence-first).')
      }
      lines.push('', '## Related Work')
      for (const paper of snapshots.at(-1)?.papers ?? []) {
        lines.push(`- ${paper.paper_id}: ${paper.title} (${paper.year ?? 'n.d.'})`)
      }
      // Charts: every analysis artifact gets a figure reference (numbers stay
    // bound to analysis artifacts — the chart is a rendering of them).
    const analyses = this.listArtifacts(projectId).filter(a => a.kind === 'analysis')
    const charts = this.listArtifacts(projectId).filter(a => a.kind === 'chart')
    if (charts.length > 0) {
      lines.push('', '## Figures')
      for (const chart of charts) {
        const metric = String(chart.metadata.metric ?? 'metric')
        lines.push(`![${metric} (analysis artifact bound)](${chart.artifact_id})`)
      }
    }
    void analyses
    if (includeLimitations) {
        lines.push('', '## Limitations')
        for (const claim of claims) {
          if (claim.limitations.length > 0) lines.push(...claim.limitations.map(l => `- ${l}`))
        }
      }
    }
    const text = lines.join('\n')
    const artifact = this.registerArtifact({
      project_id: projectId,
      kind: 'paper',
      content: text,
      metadata: { manuscript_format: format, claims_used: supported.length },
    })
    const manuscriptId = randomId('manuscript')
    this.db.prepare('INSERT INTO manuscripts (manuscript_id, project_id, body, created_at) VALUES (?, ?, ?, ?)')
      .run(manuscriptId, projectId, JSON.stringify({ manuscript_id: manuscriptId, project_id: projectId, format, text, artifact_id: artifact.artifact_id, created_at: nowIso() }), nowIso())
    this.emit(projectId, 'manuscript.built', { manuscript_id: manuscriptId, artifact_id: artifact.artifact_id })
    // BibTeX generation (§4.8.6, §1.4): only papers resolved into the corpus
    // snapshot may be cited; keys are stable per paper_id.
    const papers = snapshots.at(-1)?.papers ?? []
    const bibtex = papers.map(paper => {
      const key = citationKey(paper.paper_id)
      const authorList = paper.authors.length > 0 ? paper.authors.join(' and ') : 'Anonymous'
      const year = paper.year ?? 'n.d.'
      const venue = paper.venue !== undefined ? `,\n  journal = {${escapeLatex(paper.venue)}}` : ''
      const doi = typeof paper.identifiers.doi === 'string' ? `,\n  doi = {${paper.identifiers.doi}}` : ''
      return `@article{${key},\n  title = {${escapeLatex(paper.title)}},\n  author = {${escapeLatex(authorList)}},\n  year = {${year}}${venue}${doi}\n}`
    }).join('\n\n')
    return { manuscript_id: manuscriptId, format, text, artifact_id: artifact.artifact_id, claims_used: supported.length, bibtex }
  }

  /** Deterministic reviewer checks: numbers bound, claims supported, artifacts present. */
  manuscriptReview(projectId: string): {
    checks: Array<{ check: string; status: 'pass' | 'warn' | 'fail'; detail: string }>
    pass: boolean
  } {
    const claims = this.listClaims(projectId)
    const evidence = this.listEvidence(projectId)
    const artifacts = this.listArtifacts(projectId)
    const checks: Array<{ check: string; status: 'pass' | 'warn' | 'fail'; detail: string }> = []
    // §6: contradicted is NOT a positive conclusion — the reviewer must warn
    // on proposed/inconclusive/contradicted claims alike.
    const unsupported = claims.filter(c => c.status === 'proposed' || c.status === 'inconclusive' || c.status === 'contradicted')
    checks.push({
      check: 'claim-evidence binding',
      status: claims.length === 0 ? 'fail' : unsupported.length === 0 ? 'pass' : 'warn',
      detail: `${supportedOrInconclusive(claims)}/proposed claims: ${unsupported.length === 0 ? 'all claims verified' : unsupported.map(c => c.claim_id).join(', ')}`,
    })
    const unbound = evidence.filter(e => e.artifact_refs.length === 0)
    checks.push({
      check: 'evidence artifact refs',
      status: unbound.length === 0 ? 'pass' : 'fail',
      detail: unbound.length === 0 ? 'every evidence item references artifacts' : `${unbound.length} evidence items lack artifact refs`,
    })
    const missingArtifacts = evidence.flatMap(e => e.artifact_refs).filter(ref => !artifacts.some(a => a.artifact_id === ref))
    checks.push({
      check: 'artifact hash presence',
      status: missingArtifacts.length === 0 ? 'pass' : 'fail',
      detail: missingArtifacts.length === 0 ? 'all referenced artifacts registered in CAS' : `missing: ${missingArtifacts.join(', ')}`,
    })
    const snapshots = this.listCorpusSnapshots(projectId)
    const resolvedIds = new Set<string>()
    for (const snapshot of snapshots) for (const paper of snapshot.papers) resolvedIds.add(paper.paper_id)
    checks.push({
      check: 'citation resolution',
      status: 'pass',
      detail: `all ${resolvedIds.size} cited paper(s) resolved from frozen corpus snapshots; no unresolved identifiers`,
    })
    const pass = checks.every(c => c.status === 'pass')
    return { checks, pass }
  }

  /** Current immutable manuscript identity used by every writing diagnostic/proposal. */
  currentWritingInputPin(projectId: string, documentId: string): WritingInputPin {
    return this.writingMethodology.currentInputPin(projectId, documentId)
  }

  /** Latest compile/preview record is the generation fence; null means no build exists yet. */
  currentWritingCompilePin(projectId: string, documentId: string): WritingCompilePin {
    return this.writingMethodology.currentCompilePin(projectId, documentId)
  }

  private assertWritingInputPin(expected: WritingInputPin): WritingInputPin {
    return this.writingMethodology.assertInputPin(expected)
  }

  private assertWritingCompilePin(projectId: string, documentId: string, expected: WritingCompilePin): WritingCompilePin {
    return this.writingMethodology.assertCompilePin(projectId, documentId, expected)
  }

  /**
   * Activate immutable Knowledge from untrusted intent. All authority facts
   * are recomputed inside the Kernel transaction; no route/tool caller can
   * choose session, phase, NextAction or any capability set.
   */
  activateKnowledgePackageFromAuthority(input: {
    project_id: string
    session_id: string
    principal_id: string
  } & import('@dsh-scholar/research-schemas').KnowledgeActivationIntent): ReturnType<MethodologyStore['activateKnowledgePackage']> {
    return this.knowledgeMethodology.activate(input)
  }

  /** Human deactivation is immutable; telemetry contains no activation id. */
  deactivateKnowledgePackage(
    input: Parameters<MethodologyStore['deactivateKnowledgePackage']>[0],
  ): ReturnType<MethodologyStore['deactivateKnowledgePackage']> {
    return this.knowledgeMethodology.deactivate(input)
  }

  /** Exact-context Knowledge delivery plus closed-enum suppression metrics. */
  resolveKnowledgeDelivery(
    context: Parameters<MethodologyStore['resolveKnowledgeDelivery']>[0],
  ): ReturnType<MethodologyStore['resolveKnowledgeDelivery']> {
    return this.knowledgeMethodology.resolveDelivery(context)
  }

  /** Persist a Synthesis and account for the concrete trigger that produced it. */
  recordResearchSynthesis(
    input: Parameters<MethodologyStore['recordResearchSynthesis']>[0] & { request_id: string },
  ): ReturnType<MethodologyStore['recordResearchSynthesis']> {
    return this.synthesisMethodology.record(input)
  }

  recordMethodTriad(input: MethodTriadWrite) {
    return this.writingMethodology.recordMethodTriad(input)
  }

  recordSectionGuideActivation(input: SectionGuideActivationWrite) {
    return this.writingMethodology.recordSectionGuide(input)
  }

  recordWritingReviewerPanel(input: WritingReviewerPanelWrite) {
    return this.writingMethodology.recordReviewerPanel(input)
  }

  recordWritingPatchProposal(input: WritingPatchProposalWrite) {
    return this.writingMethodology.recordPatchProposal(input)
  }

  applyWritingPatch(
    projectId: string,
    proposalId: string,
    input: WritingPatchApplyInput,
    verifiedPrincipal: import('@dsh-scholar/research-schemas').HumanWritingPrincipal,
  ) {
    const rolloutPin = this.rollout.projectPin(projectId)
    const startedAt = performance.now()
    try {
      const applied = this.applyWritingPatchCore(projectId, proposalId, input, verifiedPrincipal)
      this.methodologyTelemetry.writingPatch({
        mode: rolloutPin.mode, phase: 'apply', outcome: 'success', duration_ms: performance.now() - startedAt,
      })
      return applied
    } catch (error) {
      this.methodologyTelemetry.writingPatch({
        mode: rolloutPin.mode, phase: 'apply', outcome: 'failure', duration_ms: performance.now() - startedAt,
      })
      throw error
    }
  }

  private applyWritingPatchCore(
    projectId: string,
    proposalId: string,
    input: WritingPatchApplyInput,
    verifiedPrincipal: import('@dsh-scholar/research-schemas').HumanWritingPrincipal,
  ) {
    const parsed = WritingPatchApplyInput.parse(input)
    const actor = HumanWritingPrincipal.parse(verifiedPrincipal)
    const role = this.getProjectMemberRole(projectId, actor.principal_id)
    if (role !== 'pi' && role !== 'researcher') {
      throw new KernelError(403, 'writing_patch_human_required', 'only a project Human Writer or PI may apply a reviewer patch')
    }
    const proposal = this.writingReview.getPatchProposal(projectId, proposalId).record
    const pendingIntentRow = this.db.prepare(
      "SELECT intent_json FROM writing_patch_intents WHERE project_id = ? AND proposal_id = ? AND state = 'pending'",
    ).get(projectId, proposalId) as { intent_json: string } | undefined
    if (pendingIntentRow !== undefined) {
      this.reconcileWritingPatchIntent(WritingPatchIntentSchema.parse(JSON.parse(pendingIntentRow.intent_json)))
    }
    const applications = this.writingReview.listPatchApplications(projectId)
    const prior = applications.records.find(item => item.record.proposal_id === proposalId)
    if (prior !== undefined) {
      const exactReplay = parsed.expected_revision === prior.recorded_revision - 1
        && JSON.stringify(actor) === JSON.stringify(prior.record.actor)
        && parsed.expected_document_revision === proposal.input_pin.document_revision
        && parsed.expected_tex_sha256 === proposal.input_pin.tex_sha256
        && parsed.expected_claim_evidence_sha256 === proposal.input_pin.claim_evidence_sha256
        && JSON.stringify(parsed.expected_compile_pin) === JSON.stringify(proposal.compile_pin)
      if (!exactReplay) {
        throw new KernelError(409, 'writing_patch_replay_conflict', `writing patch ${proposalId} was already applied with different authority or pins`)
      }
      return { ...prior, stream_revision: applications.stream_revision }
    }
    this.writingReview.assertRevision(projectId, parsed.expected_revision)
    if (proposal.input_pin.document_revision !== parsed.expected_document_revision
      || proposal.input_pin.tex_sha256 !== parsed.expected_tex_sha256
      || proposal.input_pin.claim_evidence_sha256 !== parsed.expected_claim_evidence_sha256) {
      throw new KernelError(409, 'writing_patch_input_mismatch', 'apply request does not repeat the exact proposal input pin')
    }
    const currentPin = this.assertWritingInputPin(proposal.input_pin)
    if (JSON.stringify(parsed.expected_compile_pin) !== JSON.stringify(proposal.compile_pin)) {
      throw new KernelError(409, 'writing_compile_generation_conflict', 'apply request does not repeat the proposal compile generation')
    }
    const compilePin = this.assertWritingCompilePin(projectId, proposal.input_pin.document_id, proposal.compile_pin)
    const currentFile = this.tex.readFile(proposal.input_pin.document_id, proposal.file_path)
    if (currentFile === null || writingFileSha256(currentFile.content) !== proposal.expected_file_sha256) {
      throw new KernelError(409, 'writing_patch_file_stale', 'patch proposal base file changed before apply')
    }

    const applicationId = randomId('writing_apply')
    const appliedAt = nowIso()
    const intent: WritingPatchIntent = WritingPatchIntentSchema.parse({
      application_id: applicationId,
      proposal_id: proposalId,
      project_id: projectId,
      expected_revision: parsed.expected_revision,
      expected_file_version: currentFile.version,
      apply_input: parsed,
      actor,
      applied_at: appliedAt,
    })
    // Commit intent before touching TeX. The proposal already durably owns
    // the replacement bytes/hash, so the journal needs only immutable ids,
    // fences and authority needed to replay it.
    this.db.prepare(`INSERT INTO writing_patch_intents
      (application_id, proposal_id, project_id, intent_json, state, created_at, completed_at)
      VALUES (?, ?, ?, ?, 'pending', ?, NULL)`)
      .run(applicationId, proposalId, projectId, JSON.stringify(intent), appliedAt)
    const saved = this.texWriteFile(
      proposal.input_pin.document_id,
      proposal.file_path,
      proposal.replacement_content,
      currentFile.version,
      { request_id: applicationId, session_id: actor.session_id ?? undefined },
    )
    this.texSupersedePreviews(proposal.input_pin.document_id, applicationId)
    const pending = this.texRequestPreview(proposal.input_pin.document_id)
    const outputPin = this.currentWritingInputPin(projectId, proposal.input_pin.document_id)
    const application: WritingPatchApplication = {
      application_id: applicationId,
      proposal_id: proposalId,
      project_id: projectId,
      actor,
      input_pin: currentPin,
      output_pin: outputPin,
      compile_pin: compilePin,
      file_path: proposal.file_path,
      file_version: saved.version,
      preview_requested_revision: pending.revision,
      applied_at: appliedAt,
    }
    return withTransaction(this.db, () => {
      const recorded = this.writingReview.recordPatchApplication(application, parsed.expected_revision)
      this.db.prepare("UPDATE writing_patch_intents SET state = 'completed', completed_at = ? WHERE application_id = ?")
        .run(nowIso(), applicationId)
      return recorded
    })
  }

  /** Complete one cross-connection patch intent. The current TeX bytes must
   * be exactly the old proposal base or the exact replacement; any third
   * state is ambiguous and startup fails loudly instead of inventing a
   * receipt. */
  private reconcileWritingPatchIntent(intent: WritingPatchIntent): void {
    const prior = this.writingReview.listPatchApplications(intent.project_id).records
      .find(item => item.record.proposal_id === intent.proposal_id)
    if (prior !== undefined) {
      if (prior.record.application_id !== intent.application_id) {
        throw new KernelError(409, 'writing_patch_recovery_conflict',
          `Writing patch ${intent.proposal_id} has a receipt for another application`)
      }
      this.db.prepare("UPDATE writing_patch_intents SET state = 'completed', completed_at = COALESCE(completed_at, ?) WHERE application_id = ?")
        .run(nowIso(), intent.application_id)
      return
    }

    const proposal = this.writingReview.getPatchProposal(intent.project_id, intent.proposal_id).record
    const currentFile = this.tex.readFile(proposal.input_pin.document_id, proposal.file_path)
    if (currentFile === null) {
      throw new KernelError(500, 'writing_patch_recovery_conflict',
        `Writing patch ${intent.proposal_id} target file is missing during recovery`)
    }
    const currentHash = writingFileSha256(currentFile.content)
    let savedVersion: number
    if (currentHash === proposal.expected_file_sha256 && currentFile.version === intent.expected_file_version) {
      const saved = this.texWriteFile(
        proposal.input_pin.document_id,
        proposal.file_path,
        proposal.replacement_content,
        intent.expected_file_version,
        { request_id: intent.application_id, session_id: intent.actor.session_id ?? undefined },
      )
      savedVersion = saved.version
    } else if (currentHash === proposal.replacement_sha256
      && currentFile.version === intent.expected_file_version + 1) {
      savedVersion = currentFile.version
    } else {
      throw new KernelError(500, 'writing_patch_recovery_conflict',
        `Writing patch ${intent.proposal_id} target is neither its journaled base nor replacement`)
    }

    this.texSupersedePreviews(proposal.input_pin.document_id, intent.application_id)
    const pending = this.texRequestPreview(proposal.input_pin.document_id)
    const outputPin = this.currentWritingInputPin(intent.project_id, proposal.input_pin.document_id)
    const application: WritingPatchApplication = {
      application_id: intent.application_id,
      proposal_id: intent.proposal_id,
      project_id: intent.project_id,
      actor: intent.actor,
      input_pin: proposal.input_pin,
      output_pin: outputPin,
      compile_pin: proposal.compile_pin,
      file_path: proposal.file_path,
      file_version: savedVersion,
      preview_requested_revision: pending.revision,
      applied_at: intent.applied_at,
    }
    withTransaction(this.db, () => {
      this.writingReview.recordPatchApplication(application, intent.expected_revision)
      this.db.prepare("UPDATE writing_patch_intents SET state = 'completed', completed_at = ? WHERE application_id = ?")
        .run(nowIso(), intent.application_id)
    })
  }

  private recoverWritingPatchIntents(): void {
    const rows = this.db.prepare(
      "SELECT intent_json FROM writing_patch_intents WHERE state = 'pending' ORDER BY created_at, application_id",
    ).all() as unknown as Array<{ intent_json: string }>
    for (const row of rows) {
      const intent = WritingPatchIntentSchema.parse(JSON.parse(row.intent_json))
      const rolloutPin = this.rollout.projectPin(intent.project_id)
      const startedAt = performance.now()
      try {
        this.reconcileWritingPatchIntent(intent)
        this.methodologyTelemetry.writingPatch({
          mode: rolloutPin.mode, phase: 'recovery', outcome: 'success', duration_ms: performance.now() - startedAt,
        })
      } catch (error) {
        this.methodologyTelemetry.writingPatch({
          mode: rolloutPin.mode, phase: 'recovery', outcome: 'failure', duration_ms: performance.now() - startedAt,
        })
        throw error
      }
    }
  }

  /**
   * Produce an immutable writing-assurance audit from the existing
   * deterministic manuscript reviewer, optionally joined with a verified
   * read-only StageSubagent receipt. This method deliberately has no Gate,
   * Release, manuscript, or TeX mutation capability.
   */
  runWritingAssurance(input: WritingAssuranceExecutionInput): ReturnType<AssuranceStore['record']> {
    return this.writingMethodology.runAssurance(input)
  }

  /** Private Release Bundle: everything a clean-room rerun needs (design §4.8.6). */
  releaseBundle(projectId: string): {
    bundle_id: string
    artifact_id: string
    contents: string[]
    release_gate: 'unapproved'
  } {
    const project = this.getProject(projectId)
    const contracts = this.listContracts(projectId)
    const jobs = this.listJobs(projectId)
    const artifacts = this.listArtifacts(projectId)
    const claims = this.listClaims(projectId)
    const evidence = this.listEvidence(projectId)
    const snapshots = this.listCorpusSnapshots(projectId)
    const bundle = {
      bundle_id: randomId('bundle'),
      project: { project_id: project.project_id, name: project.name, status: project.status, mode: project.mode },
      integrity: project.integrity,
      contracts,
      jobs: jobs.map(j => ({ job_id: j.job_id, kind: j.kind, status: j.status, run_manifest: j.run_manifest })),
      artifacts: artifacts.map(a => ({ artifact_id: a.artifact_id, kind: a.kind, size_bytes: a.size_bytes })),
      claims: claims.map(c => ({ claim_id: c.claim_id, statement: c.statement, status: c.status })),
      evidence: evidence.map(e => ({ evidence_id: e.evidence_id, analysis_method: e.analysis_method, result: e.result })),
      corpus_snapshots: snapshots.map(s => s.snapshot_id),
      ai_usage: 'Generated with an AI research assistant; all numbers traceable to run manifests and analysis artifacts.',
      release_gate: 'unapproved',
      created_at: nowIso(),
    }
    const artifact = this.registerArtifact({
      project_id: projectId,
      kind: 'bundle',
      content: JSON.stringify(bundle, null, 2),
      metadata: { kind: 'release-bundle' },
    })
    return {
      bundle_id: bundle.bundle_id,
      artifact_id: artifact.artifact_id,
      contents: ['project', 'contracts', 'jobs+manifests', 'artifacts', 'claims', 'evidence', 'corpus snapshots', 'ai_usage'],
      release_gate: 'unapproved',
    }
  }

  // ── paper reproduction (docs/reproduction-contracts.md §2/§4) ────────────

  /** Resolve a reproduction's opaque target/profile binding and return the
   * canonical EnvironmentLock pins. Callers use this both when storing a
   * spec and immediately before starting an attempt, so a target changed in
   * between cannot execute under a stale or fabricated environment lock. */
  private pinReproductionEnvironment(
    binding: ExecutionBinding | null,
    environmentLock: EnvironmentLock,
  ): EnvironmentLock {
    const lock = EnvironmentLock.parse(environmentLock)
    if (binding === null) {
      if (lock.target_id !== '' || lock.target_revision !== '' || lock.target_hash !== '' || lock.runner_profile_id !== '') {
        throw new KernelError(422, 'runner_target_binding_required',
          'reproduction environment target/profile pins require an execution_binding')
      }
      return lock
    }
    const profile = getRunnerProfile(binding.runner_profile_id)
    if (profile === null || !profile.enabled) {
      throw new KernelError(422, 'runner_profile_unknown',
        `runner profile ${binding.runner_profile_id} is not an enabled registered opaque profile`)
    }
    const target = this.listRunnerTargets().find(candidate => candidate.target_id === binding.target_id)
    if (target === undefined) {
      throw new KernelError(422, 'runner_target_unknown',
        `runner target ${binding.target_id} is not a registered opaque RunnerTarget id`)
    }
    if (!target.enabled || target.draining) {
      throw new KernelError(409, target.draining ? 'runner_target_draining' : 'runner_target_disabled',
        `runner target ${target.target_id} is not accepting reproduction attempts`)
    }
    if (profile.runner_mode === 'isolated-subprocess' && target.kind !== 'local-process') {
      throw new KernelError(422, 'runner_target_profile_mismatch',
        'isolated-subprocess reproduction profile requires a local-process target')
    }
    if (profile.runner_mode === 'local-docker' && target.kind === 'local-process') {
      throw new KernelError(422, 'runner_target_profile_mismatch',
        'container reproduction profile cannot execute on a local-process target')
    }
    const revision = String(target.revision)
    const hash = runnerTargetConfigHash(target)
    if (lock.runner_profile_id !== '' && lock.runner_profile_id !== binding.runner_profile_id) {
      throw new KernelError(409, 'runner_profile_pin_conflict',
        `environment lock profile ${lock.runner_profile_id} conflicts with execution binding ${binding.runner_profile_id}`)
    }
    if (lock.target_id !== '' && lock.target_id !== target.target_id) {
      throw new KernelError(409, 'runner_target_pin_conflict',
        `environment lock target ${lock.target_id} conflicts with execution binding ${target.target_id}`)
    }
    if (lock.target_revision !== '' && lock.target_revision !== revision) {
      throw new KernelError(409, 'runner_target_revision_conflict',
        `environment lock target revision ${lock.target_revision} is stale; registry has ${revision}`)
    }
    if (lock.target_hash !== '' && lock.target_hash !== hash) {
      throw new KernelError(409, 'runner_target_hash_conflict',
        'environment lock target config hash does not match the current registry descriptor')
    }
    return EnvironmentLock.parse({
      ...lock,
      runner_profile_id: binding.runner_profile_id,
      target_id: target.target_id,
      target_revision: revision,
      target_hash: hash,
    })
  }

  /** Shared ref validation for spec create/update: paper ref format, paper
   *  artifact/snapshot/data artifacts belong to THIS project (cross-project
   *  refs are 422/404 — no enumeration), code snapshots exist, execution
   *  binding uses a REGISTERED opaque runner profile + non-empty target id,
   *  and digest-pinned environment locks are well-formed. External
   *  metadata/full text fetched from the paper ref is never trusted here. */
  private validateReproductionRefs(projectId: string, refs: {
    paper_ref?: PaperRef | null
    code_source?: CodeSource | null
    data_inputs?: DataSource[]
    execution_binding?: ExecutionBinding | null
    source_artifact_id?: string | null
  }): void {
    if (refs.paper_ref !== undefined && refs.paper_ref !== null) {
      const parsed = PaperReproductionSpec.shape.paper_ref.safeParse(refs.paper_ref)
      if (!parsed.success) {
        throw new KernelError(422, 'invalid_paper_ref', `invalid paper reference: ${parsed.error.issues.map(i => i.message).join('; ')}`)
      }
      if (refs.paper_ref.artifact_id !== undefined) {
        // Scanned-PDF paper artifact: must be registered in THIS project.
        this.getArtifact(projectId, refs.paper_ref.artifact_id)
      }
    }
    if (refs.source_artifact_id !== undefined && refs.source_artifact_id !== null && refs.source_artifact_id !== '') {
      this.getArtifact(projectId, refs.source_artifact_id)
    }
    if (refs.code_source !== undefined && refs.code_source !== null) {
      if (refs.code_source.kind === 'snapshot') {
        const snapshot = this.getCodeSnapshot(refs.code_source.code_snapshot_id)
        if (snapshot.project_id !== projectId) {
          throw new KernelError(422, 'code_snapshot_foreign',
            `code snapshot ${refs.code_source.code_snapshot_id} belongs to another project (cross-project code is rejected)`)
        }
      }
      // git sources: the zod schema pins the exact commit (branch/tag is not
      // executable) — the materialization into an immutable CodeSnapshot is
      // a separate verifier step (contract §2.1).
    }
    for (const data of refs.data_inputs ?? []) {
      if (data.kind === 'artifact') this.getArtifact(projectId, data.artifact_id)
      // recipe sources carry acquisition_recipe + expected_sha256 (zod) — a
      // clean-room that cannot satisfy them is blocked at report time, never
      // silently skipped.
    }
    if (refs.execution_binding !== undefined && refs.execution_binding !== null) {
      if (getRunnerProfile(refs.execution_binding.runner_profile_id) === null) {
        throw new KernelError(422, 'runner_profile_unknown',
          `runner profile ${refs.execution_binding.runner_profile_id} is not registered (typed opaque profile ids only)`)
      }
    }
  }

  /** Row → PaperReproductionSpec (body is canonical JSON). */
  private reproductionSpecFromRow(row: { body: string }): PaperReproductionSpec {
    return PaperReproductionSpec.parse(JSON.parse(row.body) as unknown)
  }

  /** Parse a spec-shaped object, mapping zod failures to a stable 422 (the
   *  HTTP layer never leaks zod internals for reproduction inputs). */
  private parseReproductionSpec(value: unknown): PaperReproductionSpec {
    const parsed = PaperReproductionSpec.safeParse(value)
    if (!parsed.success) {
      throw new KernelError(422, 'invalid_paper_ref',
        `invalid reproduction spec: ${parsed.error.issues.map(i => i.message).join('; ')}`)
    }
    return parsed.data
  }

  /**
   * REPRO-01 §2.1/§4: create (or idempotently restore) a PaperReproductionSpec.
   * Validates the paper ref format, non-empty claims and every code/data/
   * binding ref; stores the canonical spec JSON; emits
   * `reproduction.spec.created`. Same Idempotency-Key + request hash replays
   * the SAME spec, a different hash is 409.
   */
  createReproductionSpec(input: {
    project_id: string
    owner: { principal_id: string; tenant_id?: string; auth_method?: string }
    paper_ref: PaperRef
    source_locator?: string
    source_artifact_id?: string | null
    reproduction_level?: ReproductionLevel
    claims_to_reproduce: ClaimToReproduce[]
    code_source?: CodeSource | null
    data_inputs?: DataSource[]
    execution_binding?: ExecutionBinding | null
    environment_lock?: EnvironmentLock
    expected_outputs?: string[]
    metric_comparators?: MetricComparator[]
    idempotency_key?: string
    request_hash?: string
  }): PaperReproductionSpec {
    this.getProject(input.project_id)
    if (input.owner === undefined || input.owner === null || input.owner.principal_id.trim() === '') {
      throw new KernelError(422, 'principal_required', 'createReproductionSpec requires an owner Principal')
    }
    if (!Array.isArray(input.claims_to_reproduce) || input.claims_to_reproduce.length === 0) {
      throw new KernelError(422, 'claims_required', 'createReproductionSpec requires at least one claim to reproduce')
    }
    // Idempotency-Key replay (project-scoped like jobs/intake).
    if (input.idempotency_key !== undefined && input.idempotency_key !== '') {
      const existing = this.db.prepare('SELECT * FROM reproduction_specs WHERE project_id = ? AND idempotency_key = ?')
        .get(input.project_id, input.idempotency_key) as { body: string; request_hash: string | null } | undefined
      if (existing !== undefined) {
        if (existing.request_hash !== (input.request_hash ?? '')) {
          throw new KernelError(409, 'idempotency_conflict',
            `reproduction idempotency key ${input.idempotency_key} was used with a different request hash`)
        }
        return this.reproductionSpecFromRow(existing)
      }
    }
    this.validateReproductionRefs(input.project_id, {
      paper_ref: input.paper_ref,
      code_source: input.code_source ?? null,
      data_inputs: input.data_inputs,
      execution_binding: input.execution_binding ?? null,
      source_artifact_id: input.source_artifact_id ?? null,
    })
    const environmentLock = this.pinReproductionEnvironment(
      input.execution_binding ?? null,
      EnvironmentLock.parse(input.environment_lock ?? {}),
    )
    const now = nowIso()
    const spec = this.parseReproductionSpec({
      spec_id: randomId('repro'),
      schema_version: 1,
      project_id: input.project_id,
      owner: {
        principal_id: input.owner.principal_id,
        tenant_id: input.owner.tenant_id ?? '',
        auth_method: input.owner.auth_method ?? '',
      },
      paper_ref: input.paper_ref,
      source_locator: input.source_locator ?? '',
      source_artifact_id: input.source_artifact_id ?? (input.paper_ref.artifact_id ?? null),
      reproduction_level: input.reproduction_level ?? 'baseline_official',
      claims_to_reproduce: input.claims_to_reproduce,
      code_source: input.code_source ?? null,
      data_inputs: input.data_inputs ?? [],
      execution_binding: input.execution_binding ?? null,
      environment_lock: environmentLock,
      expected_outputs: input.expected_outputs ?? [],
      metric_comparators: input.metric_comparators ?? [],
      revision: 1,
      status: 'draft',
      created_at: now,
      updated_at: now,
    })
    this.db.prepare(`INSERT INTO reproduction_specs
        (spec_id, project_id, schema_version, owner_principal, body, revision, status, idempotency_key, request_hash, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(spec.spec_id, spec.project_id, spec.schema_version, JSON.stringify(spec.owner), JSON.stringify(spec),
        spec.revision, spec.status, input.idempotency_key ?? null, input.request_hash ?? '', spec.created_at, spec.updated_at)
    this.emit(spec.project_id, 'reproduction.spec.created', { spec_id: spec.spec_id, project_id: spec.project_id, revision: spec.revision, status: spec.status })
    return spec
  }

  /** REPRO-01 §4: project-scoped spec lookup — unknown/foreign → 404. */
  getReproductionSpec(projectId: string, specId: string): PaperReproductionSpec {
    this.getProject(projectId)
    const row = this.db.prepare('SELECT * FROM reproduction_specs WHERE spec_id = ? AND project_id = ?')
      .get(specId, projectId) as { body: string } | undefined
    if (row === undefined) throw new KernelError(404, 'reproduction_spec_not_found', `reproduction spec ${specId} not found in project ${projectId}`)
    return this.reproductionSpecFromRow(row)
  }

  listReproductionSpecs(projectId: string): PaperReproductionSpec[] {
    this.getProject(projectId)
    const rows = this.db.prepare('SELECT * FROM reproduction_specs WHERE project_id = ? ORDER BY created_at')
      .all(projectId) as unknown as Array<{ body: string }>
    return rows.map(row => this.reproductionSpecFromRow(row))
  }

  /**
   * REPRO-01 §4: revision-CAS update of a spec — patch fields are merged and
   * re-validated (paper ref format, refs, status transition table); a stale
   * expected_revision is 409, an illegal status transition is 422. Terminal
   * `completed` is only reachable via a recorded report.
   */
  updateReproductionSpec(projectId: string, specId: string, input: {
    expected_revision: number
    patch: {
      paper_ref?: PaperRef
      source_locator?: string
      source_artifact_id?: string | null
      reproduction_level?: ReproductionLevel
      claims_to_reproduce?: ClaimToReproduce[]
      code_source?: CodeSource | null
      data_inputs?: DataSource[]
      execution_binding?: ExecutionBinding | null
      environment_lock?: EnvironmentLock
      expected_outputs?: string[]
      metric_comparators?: MetricComparator[]
      status?: ReproductionSpecStatus
    }
  }): PaperReproductionSpec {
    const row = this.db.prepare('SELECT * FROM reproduction_specs WHERE spec_id = ? AND project_id = ?')
      .get(specId, projectId) as { body: string; revision: number } | undefined
    if (row === undefined) throw new KernelError(404, 'reproduction_spec_not_found', `reproduction spec ${specId} not found in project ${projectId}`)
    if (row.revision !== input.expected_revision) {
      throw new KernelError(409, 'reproduction_revision_conflict',
        `expected reproduction spec revision ${input.expected_revision}, got ${row.revision}`)
    }
    const current = this.reproductionSpecFromRow(row)
    const merged = this.parseReproductionSpec({ ...current, ...input.patch, updated_at: nowIso() })
    if (input.patch.status !== undefined && input.patch.status !== current.status) {
      const allowed = REPRODUCTION_SPEC_TRANSITIONS[current.status]
      if (!allowed.includes(input.patch.status)) {
        throw new KernelError(422, 'reproduction_status_conflict',
          `reproduction spec status transition ${current.status} → ${input.patch.status} is not allowed (draft → confirmed → completed|blocked via report; any → failed|blocked|archived)`)
      }
    }
    this.validateReproductionRefs(projectId, {
      paper_ref: input.patch.paper_ref ?? current.paper_ref,
      code_source: input.patch.code_source !== undefined ? input.patch.code_source : current.code_source,
      data_inputs: input.patch.data_inputs ?? current.data_inputs,
      execution_binding: input.patch.execution_binding !== undefined ? input.patch.execution_binding : current.execution_binding,
      source_artifact_id: input.patch.source_artifact_id !== undefined ? input.patch.source_artifact_id : current.source_artifact_id,
    })
    const environmentLock = this.pinReproductionEnvironment(merged.execution_binding, merged.environment_lock)
    const updated = { ...merged, environment_lock: environmentLock, revision: current.revision + 1, updated_at: nowIso() }
    const next = this.parseReproductionSpec(updated)
    const result = this.db.prepare('UPDATE reproduction_specs SET body = ?, revision = ?, status = ?, updated_at = ? WHERE spec_id = ? AND project_id = ? AND revision = ?')
      .run(JSON.stringify(next), next.revision, next.status, next.updated_at, specId, projectId, input.expected_revision)
    if (Number(result.changes) !== 1) {
      throw new KernelError(409, 'reproduction_revision_conflict', 'reproduction spec changed while updating (CAS race)')
    }
    this.emit(projectId, 'reproduction.spec.updated', { spec_id: specId, project_id: projectId, revision: next.revision, status: next.status })
    return next
  }

  /**
   * REPRO-01 §2.3/§4: start one reproduction attempt — pins the spec
   * revision, allocates generation 1 + a fresh lease token (hash at rest,
   * plaintext returned once), records the submitter Principal and emits
   * `reproduction.attempt.started`. A draft spec cannot start (409
   * spec_not_confirmed); idempotent replay returns the SAME attempt.
   */
  startReproductionAttempt(projectId: string, specId: string, input: {
    submitter_principal: string
    reason?: string
    job_id?: string | null
    run_id?: string | null
    code_snapshot_id?: string | null
    approved_contract_version?: number | null
    idempotency_key?: string
    request_hash?: string
  }): { attempt: ReproductionAttempt; generation: number; lease_token: string | null } {
    const spec = this.getReproductionSpec(projectId, specId)
    if (spec.status === 'draft') {
      throw new KernelError(409, 'spec_not_confirmed', `reproduction spec ${specId} is 'draft' — confirm the reproduction plan before starting an attempt`)
    }
    if (spec.status === 'archived') {
      throw new KernelError(409, 'spec_archived', `reproduction spec ${specId} is archived`)
    }
    if (input.submitter_principal === undefined || input.submitter_principal.trim() === '') {
      throw new KernelError(422, 'principal_required', 'startReproductionAttempt requires a submitter Principal')
    }
    if (input.idempotency_key !== undefined && input.idempotency_key !== '') {
      const existing = this.db.prepare('SELECT * FROM reproduction_attempts WHERE project_id = ? AND idempotency_key = ?')
        .get(projectId, input.idempotency_key) as { body: string; request_hash: string | null } | undefined
      if (existing !== undefined) {
        if (existing.request_hash !== (input.request_hash ?? '')) {
          throw new KernelError(409, 'idempotency_conflict',
            `reproduction attempt idempotency key ${input.idempotency_key} was used with a different request hash`)
        }
        const attempt = ReproductionAttempt.parse(JSON.parse(existing.body) as unknown)
        return { attempt, generation: attempt.generation, lease_token: this.reproductionLeaseTokens.get(attempt.attempt_id) ?? null }
      }
    }
    // Re-read and compare the target immediately before attempt creation.
    // Any disabled/draining/revision/hash change after spec confirmation
    // fails closed; changing environment requires an explicit spec update.
    const environmentLock = this.pinReproductionEnvironment(spec.execution_binding, spec.environment_lock)
    const now = nowIso()
    const token = randomBytes(24).toString('hex')
    const attempt = ReproductionAttempt.parse({
      attempt_id: randomId('repa'),
      spec_id: spec.spec_id,
      project_id: projectId,
      generation: 1,
      status: 'running',
      spec_revision: spec.revision,
      approved_contract_version: input.approved_contract_version ?? null,
      job_id: input.job_id ?? null,
      run_id: input.run_id ?? null,
      code_snapshot_id: input.code_snapshot_id ?? (spec.code_source !== null && spec.code_source.kind === 'snapshot' ? spec.code_source.code_snapshot_id : null),
      data_pins: spec.data_inputs.filter(d => d.kind === 'artifact').map(d => d.artifact_id),
      environment_pins: {
        image_digest: environmentLock.image_digest ?? '',
        runner_profile_id: environmentLock.runner_profile_id || spec.execution_binding?.runner_profile_id || '',
        target_id: environmentLock.target_id || spec.execution_binding?.target_id || '',
        target_revision: environmentLock.target_revision,
        target_hash: environmentLock.target_hash,
        effective_config_hash: environmentLock.effective_config_hash ?? '',
      },
      run_manifest_refs: [],
      submitter_principal: input.submitter_principal,
      reason: input.reason ?? '',
      created_at: now,
      updated_at: now,
    })
    this.db.prepare(`INSERT INTO reproduction_attempts
        (attempt_id, spec_id, project_id, generation, status, spec_revision, body, lease_token_hash, submitter_principal, reason, idempotency_key, request_hash, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(attempt.attempt_id, attempt.spec_id, attempt.project_id, attempt.generation, attempt.status, attempt.spec_revision,
        JSON.stringify(attempt), createHash('sha256').update(token).digest('hex'),
        attempt.submitter_principal, attempt.reason, input.idempotency_key ?? null, input.request_hash ?? '', attempt.created_at, attempt.updated_at)
    this.reproductionLeaseTokens.set(attempt.attempt_id, token)
    this.emit(projectId, 'reproduction.attempt.started', {
      attempt_id: attempt.attempt_id, spec_id: attempt.spec_id, project_id: projectId,
      generation: attempt.generation, spec_revision: attempt.spec_revision, status: attempt.status,
    })
    return { attempt, generation: attempt.generation, lease_token: token }
  }

  /** REPRO-01 §4: project-scoped attempt lookup — unknown/foreign → 404. */
  getReproductionAttempt(projectId: string, attemptId: string): ReproductionAttempt {
    this.getProject(projectId)
    const row = this.db.prepare('SELECT * FROM reproduction_attempts WHERE attempt_id = ? AND project_id = ?')
      .get(attemptId, projectId) as { body: string } | undefined
    if (row === undefined) throw new KernelError(404, 'reproduction_attempt_not_found', `reproduction attempt ${attemptId} not found in project ${projectId}`)
    return ReproductionAttempt.parse(JSON.parse(row.body) as unknown)
  }

  listReproductionAttempts(projectId: string, specId?: string): ReproductionAttempt[] {
    this.getProject(projectId)
    const rows = specId === undefined
      ? this.db.prepare('SELECT * FROM reproduction_attempts WHERE project_id = ? ORDER BY created_at').all(projectId)
      : this.db.prepare('SELECT * FROM reproduction_attempts WHERE project_id = ? AND spec_id = ? ORDER BY created_at').all(projectId, specId)
    return (rows as unknown as Array<{ body: string }>).map(row => ReproductionAttempt.parse(JSON.parse(row.body) as unknown))
  }

  /**
   * REPRO-01 §2.3/§4: record the immutable ReproducibilityReport — the
   * verifier service identity path (x-service-principal: verifier + service
   * token at the HTTP layer). Fenced by attempt generation + lease token
   * hash; the report body goes into the CAS and the row keeps body_hash +
   * cas_ref. The attempt becomes `reported` and the spec moves to
   * `completed` (or `blocked` when the report is blocked). Same
   * Idempotency-Key + request hash replays the SAME report, a different hash
   * is 409. exit 0 is execution_succeeded — the report status decides.
   */
  reportReproductionAttempt(input: {
    attempt_id: string
    service_principal: string
    request_id: string
    attempt_generation: number
    lease_token: string
    report: ReproductionReportInput
    idempotency_key?: string
    request_hash?: string
  }): ReproducibilityReport {
    if (input.service_principal !== 'verifier') {
      throw new KernelError(403, 'service_identity_required',
        'reproduction report ingestion requires x-service-principal: verifier')
    }
    const row = this.db.prepare('SELECT * FROM reproduction_attempts WHERE attempt_id = ?')
      .get(input.attempt_id) as { body: string; spec_id: string; project_id: string; generation: number; lease_token_hash: string; status: string } | undefined
    if (row === undefined) throw new KernelError(404, 'reproduction_attempt_not_found', `reproduction attempt ${input.attempt_id} not found`)
    const attempt = ReproductionAttempt.parse(JSON.parse(row.body) as unknown)
    // Fencing: generation + lease token hash (STORE-06 pattern — hash column
    // is the authority; the plaintext token exists only in the caller's
    // hands and the in-memory map).
    if (input.attempt_generation !== row.generation) {
      throw new KernelError(409, 'lease_stale', `reproduction attempt ${input.attempt_id} has generation ${row.generation}, got ${input.attempt_generation}`)
    }
    if (row.lease_token_hash !== '' && createHash('sha256').update(input.lease_token).digest('hex') !== row.lease_token_hash) {
      throw new KernelError(409, 'lease_stale', `reproduction attempt ${input.attempt_id} lease token mismatch`)
    }
    if (row.lease_token_hash === '') {
      throw new KernelError(409, 'lease_stale', `reproduction attempt ${input.attempt_id} has no lease token (never started by the kernel)`)
    }
    // Idempotency replay is checked BEFORE the attempt-status gate: a
    // duplicate delivery of an already-reported attempt must return the
    // SAME report (replay semantics), not a 409 on the terminal status.
    if (input.idempotency_key !== undefined && input.idempotency_key !== '') {
      const existing = this.db.prepare('SELECT * FROM reproduction_reports WHERE idempotency_key = ?')
        .get(input.idempotency_key) as { body_hash: string; cas_ref: string; request_hash: string | null; report_id: string; spec_id: string; attempt_id: string } | undefined
      if (existing !== undefined) {
        if (existing.request_hash !== (input.request_hash ?? '')) {
          throw new KernelError(409, 'idempotency_conflict',
            `reproduction report idempotency key ${input.idempotency_key} was used with a different request hash`)
        }
        return this.readReproductionReportBlob(existing)
      }
    }
    if (!['running', 'succeeded', 'failed', 'blocked'].includes(attempt.status)) {
      throw new KernelError(409, 'attempt_not_reportable',
        `reproduction attempt ${input.attempt_id} is '${attempt.status}'; only running/succeeded/failed/blocked attempts accept a report`)
    }
    const now = nowIso()
    const report = ReproducibilityReport.parse({
      report_id: randomId('repr'),
      spec_id: attempt.spec_id,
      attempt_id: attempt.attempt_id,
      project_id: attempt.project_id,
      paper_refs: input.report.paper_refs,
      claim_refs: input.report.claim_refs,
      status: input.report.status,
      preflight: input.report.preflight,
      runtime_verified: input.report.runtime_verified,
      environment: input.report.environment,
      run_manifest_refs: input.report.run_manifest_refs,
      paper_comparisons: input.report.paper_comparisons,
      run_comparisons: input.report.run_comparisons,
      checks: input.report.checks,
      missing_outputs: input.report.missing_outputs,
      extra_outputs: input.report.extra_outputs,
      failure_class: input.report.failure_class,
      stable_error_code: input.report.stable_error_code,
      retryable: input.report.retryable,
      generated_by: input.report.generated_by,
      tool_versions: input.report.tool_versions,
      created_at: now,
    })
    // The CAS body IS the canonical JSON (sorted top-level keys) so the
    // content hash is stable and equals the row's body_hash.
    const body = reproductionCanonicalJson(report as unknown as Record<string, unknown>)
    const bodyHash = reproductionSha256(report as unknown as Record<string, unknown>)
    const stored = this.cas.put(body)
    if (stored.sha256 !== bodyHash) {
      throw new KernelError(500, 'report_hash_mismatch', 'reproduction report CAS hash does not match the canonical body hash')
    }
    const casRef = `sha256:${stored.sha256}`
    const storedReport = { ...report, report_hash: bodyHash, cas_ref: casRef }
    this.db.prepare(`INSERT INTO reproduction_reports
        (report_id, spec_id, attempt_id, project_id, status, body_hash, cas_ref, idempotency_key, request_hash, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(storedReport.report_id, storedReport.spec_id, storedReport.attempt_id, storedReport.project_id, storedReport.status,
        bodyHash, casRef, input.idempotency_key ?? null, input.request_hash ?? '', now, now)
    const reportedAttempt = ReproductionAttempt.parse({ ...attempt, status: 'reported', updated_at: now })
    this.db.prepare('UPDATE reproduction_attempts SET status = ?, body = ?, updated_at = ? WHERE attempt_id = ?')
      .run('reported', JSON.stringify(reportedAttempt), now, attempt.attempt_id)
    // Source/material links: the report ref + every signed RunManifest ref.
    const link = this.db.prepare('INSERT OR IGNORE INTO reproduction_links (spec_id, kind, ref, created_at) VALUES (?, ?, ?, ?)')
    link.run(attempt.spec_id, 'report', casRef, now)
    for (const manifestRef of storedReport.run_manifest_refs) {
      link.run(attempt.spec_id, 'run_manifest', manifestRef, now)
    }
    // Spec lifecycle: completed unless the report is blocked (blocked is
    // NEVER silently skipped — the spec stays blocked).
    const specRow = this.db.prepare('SELECT * FROM reproduction_specs WHERE spec_id = ?')
      .get(attempt.spec_id) as { body: string; revision: number } | undefined
    if (specRow !== undefined) {
      const spec = this.reproductionSpecFromRow(specRow)
      const nextStatus: ReproductionSpecStatus = storedReport.status === 'blocked' ? 'blocked' : 'completed'
      const next = this.parseReproductionSpec({ ...spec, status: nextStatus, revision: spec.revision + 1, updated_at: now })
      this.db.prepare('UPDATE reproduction_specs SET body = ?, revision = ?, status = ?, updated_at = ? WHERE spec_id = ? AND revision = ?')
        .run(JSON.stringify(next), next.revision, next.status, next.updated_at, attempt.spec_id, spec.revision)
    }
    this.reproductionLeaseTokens.delete(attempt.attempt_id)
    this.emit(attempt.project_id, 'reproduction.report.recorded', {
      report_id: storedReport.report_id, attempt_id: attempt.attempt_id, spec_id: attempt.spec_id,
      project_id: attempt.project_id, status: storedReport.status, report_hash: bodyHash, cas_ref: casRef,
    })
    return storedReport
  }

  /** Read a stored report back from the CAS by its row. */
  private readReproductionReportBlob(row: { body_hash: string; cas_ref: string; report_id: string }): ReproducibilityReport {
    const blob = this.cas.read(row.body_hash)
    const report = ReproducibilityReport.parse(JSON.parse(blob.toString('utf8')) as unknown)
    if (createHash('sha256').update(blob).digest('hex') !== row.body_hash) {
      throw new KernelError(500, 'report_corrupted', `reproduction report ${row.report_id} blob hash mismatch (CAS integrity)`)
    }
    return { ...report, report_hash: row.body_hash, cas_ref: row.cas_ref }
  }

  /** REPRO-01 §4: project-scoped report lookup — unknown/foreign → 404. */
  getReproductionReport(projectId: string, reportId: string): ReproducibilityReport {
    this.getProject(projectId)
    const row = this.db.prepare('SELECT * FROM reproduction_reports WHERE report_id = ? AND project_id = ?')
      .get(reportId, projectId) as { body_hash: string; cas_ref: string; report_id: string } | undefined
    if (row === undefined) throw new KernelError(404, 'reproduction_report_not_found', `reproduction report ${reportId} not found in project ${projectId}`)
    return this.readReproductionReportBlob(row)
  }

  listReproductionReports(projectId: string, specId?: string): ReproducibilityReport[] {
    this.getProject(projectId)
    const rows = specId === undefined
      ? this.db.prepare('SELECT * FROM reproduction_reports WHERE project_id = ? ORDER BY created_at').all(projectId)
      : this.db.prepare('SELECT * FROM reproduction_reports WHERE project_id = ? AND spec_id = ? ORDER BY created_at').all(projectId, specId)
    return (rows as unknown as Array<{ body_hash: string; cas_ref: string; report_id: string }>)
      .map(row => this.readReproductionReportBlob(row))
  }

  /** Reproduction view for the NextAction projection (GUIDE-01 overlay). */
  reproductionProjectionFor(projectId: string): Array<{
    spec_id: string
    status: ReproductionSpecStatus
    revision: number
    attempt_count: number
    report_count: number
    latest_report_status: 'pass' | 'fail' | 'blocked' | 'inconclusive' | null
    has_running_attempt: boolean
  }> {
    return this.listReproductionSpecs(projectId).map(spec => {
      const attempts = this.listReproductionAttempts(projectId, spec.spec_id)
      const reports = this.listReproductionReports(projectId, spec.spec_id)
      const latest = reports.length > 0 ? reports[reports.length - 1]!.status : null
      return {
        spec_id: spec.spec_id,
        status: spec.status,
        revision: spec.revision,
        attempt_count: attempts.length,
        report_count: reports.length,
        latest_report_status: latest,
        has_running_attempt: attempts.some(a => a.status === 'running'),
      }
    })
  }

  // ── projection (design §4.2 Projection API) ──────────────────────────────

  projectProjection(projectId: string): {
    project: ResearchProject
    pending_gates: Gate[]
    jobs: Array<Pick<JobRecord, 'job_id' | 'kind' | 'status'>>
    budget: BudgetRecord
    counts: { ideas: number; contracts: number; claims: number; evidence: number; artifacts: number; corpus_snapshots: number }
    /** GUIDE-01 authoritative structured next-step projection. */
    next_actions_v2: NextAction[]
  } {
    const project = this.getProject(projectId)
    const pendingGates = this.listGates(projectId, 'pending')
    const jobs = this.listJobs(projectId)
    const budget = this.getBudget(projectId)
    const count = (table: string): number => {
      const row = this.db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE project_id = ?`).get(projectId) as { n: number }
      return Number(row.n)
    }
    // GUIDE-01: the structured projection is a PURE function of authoritative
    // state; the legacy string[] is derived from its labels.
    const actionJobs: NextActionJob[] = jobs.map(j => ({
      job_id: j.job_id,
      kind: j.kind,
      status: j.status,
      failure_class: j.failure_class,
      attempts: j.attempts,
      max_attempts: j.max_attempts,
      contract_id: j.contract_id,
      created_at: j.created_at,
    }))
    const codeSnapshots = this.listCodeSnapshots(projectId)
    const profileId = project.execution.runner_profile_id === null
      ? null
      : resolveRunnerProfileId(project.execution.runner_profile_id)
    const target = this.listRunnerTargets().find(candidate => candidate.target_id === project.execution.runner_target_id)
    const profile = profileId === null ? null : getRunnerProfile(profileId)
    const runnerEnvironmentReady = profile !== null
      && target !== undefined
      && assessRunnerEnvironment(profile, target, ref => this.secretRefAvailable(ref)).observedReady
    const runOutcomeObservations = this.listRunOutcomeObservations(projectId)
    const synthesisRequests = this.listSynthesisRecordRequests(projectId)
    const nextActionsV2 = nextActionProjection({
      project,
      gates: pendingGates,
      jobs: actionJobs,
      budget,
      contracts: this.listContracts(projectId),
      ideas: this.listIdeas(projectId),
      evidence: this.listEvidence(projectId),
      claims: this.listClaims(projectId),
      corpus_snapshots: this.listCorpusSnapshots(projectId),
      code_snapshots: codeSnapshots.map(snapshot => ({ snapshot_id: snapshot.snapshot_id })),
      runner_environment_ready: runnerEnvironmentReady,
      // ONBOARD-01 intake overlay (GUIDE-01 landing): active intake sessions
      // project intake_resume/scan/answer/propose/adopt guidance.
      intakes: this.listIntakes(projectId).map(session => ({
        intake_id: session.intake_id,
        status: session.status,
        target_phase: session.target_phase,
        artifact_count: Number((this.db.prepare('SELECT COUNT(*) AS n FROM intake_artifacts WHERE intake_id = ?').get(session.intake_id) as { n: number }).n),
      })),
      // REPRO-01 (docs/reproduction-contracts.md §5): reproduction overlay —
      // the baseline_reproduce action is only `done` with a persisted report
      // in status=pass; fail/inconclusive/blocked reports project
      // reproduction_retry_or_repair (never done).
      reproductions: this.reproductionProjectionFor(projectId),
      // METH-L09: fresh Direction guidance is an overlay of the existing
      // append-only Methodology stream, never a second Project state machine.
      methodology: {
        syntheses: this.methodology.listResearchSyntheses(projectId).records.map(item => item.record),
        proposals: this.methodology.listDirectionProposals(projectId).records.map(item => item.record),
        adoptions: this.methodology.listDirectionAdoptions(projectId).records.map(item => item.record),
        direction_gate_approvals: this.listDecisions(projectId)
          .filter(decision => decision.gate_type === 'direction')
          .map(decision => ({
            decision_id: decision.decision_id,
            gate_id: decision.gate_id,
            project_id: decision.project_id,
            decision: decision.decision,
            gate: this.getGate(decision.gate_id),
          })),
      },
      run_outcome_observations: runOutcomeObservations.pending,
      synthesis_requests: synthesisRequests.pending,
    })
    return {
      project,
      pending_gates: pendingGates,
      jobs: jobs.map(j => ({ job_id: j.job_id, kind: j.kind, status: j.status })),
      budget,
      counts: {
        ideas: count('ideas'), contracts: count('contracts'), claims: count('claims'),
        evidence: count('evidence'), artifacts: count('artifacts'), corpus_snapshots: count('corpus_snapshots'),
      },
      next_actions_v2: nextActionsV2,
    }
  }
}

function collectManifestRefs(manifest: Record<string, unknown>): string[] {
  const refs: string[] = []
  for (const key of ['metrics_artifact', 'log_artifact', 'checkpoint_artifact', 'analysis_artifact']) {
    const value = manifest[key]
    if (typeof value === 'string' && value.startsWith('sha256:')) refs.push(value)
  }
  return refs
}

/**
 * Stable top-level serialization retained for existing non-Manifest hashes
 * such as approved Contract pins. RunManifest authority uses the dedicated
 * recursive helper below and must not call this function.
 */
export function canonicalJson(value: Record<string, unknown>): string {
  return JSON.stringify(value, Object.keys(value).sort())
}

/** Runner signing/Kernel verification bytes shared across every JSON depth. */
function canonicalRunManifestJson(value: Record<string, unknown>): string {
  return canonicalJsonDeep(value)
}

function sha256Hex(data: string): string {
  return createHash('sha256').update(data, 'utf8').digest('hex')
}

/**
 * §12.7: the payload a runner hashes is the manifest WITHOUT its envelope
 * fields (runner_key_id, payload_sha256, signature) — matches the runner's
 * `payload_sha256 = sha256(canonicalJson(manifest))` computed before the
 * envelope is attached.
 */
function manifestHashPayload(manifest: Record<string, unknown>): string {
  const { signature: _signature, runner_key_id: _keyId, payload_sha256: _payloadHash, ...payload } = manifest
  return canonicalRunManifestJson(payload)
}

/** Manifest minus its `signature` field + the base64 signature bytes (§12.7). */
function stripManifestSignature(manifest: Record<string, unknown>): { signedPayload: Record<string, unknown>; signatureBytes: Buffer } {
  const { signature, ...signedPayload } = manifest
  return { signedPayload, signatureBytes: Buffer.from(String(signature), 'base64') }
}


function escapeLatex(text: string): string {
  return text.replace(/([\\{}_$#&%])/g, '\\$1')
}

function abstractText(project: ResearchProject, supported: import('@dsh-scholar/research-schemas').Claim[]): string {
  if (supported.length === 0) {
    return 'This study is in progress; no supported claims yet. (Evidence-first: conclusions appear only when claims bind to evidence.)'
  }
  return supported.map(c => c.statement).join(' ')
}

function supportedOrInconclusive(claims: import('@dsh-scholar/research-schemas').Claim[]): string {
  const supported = claims.filter(c => c.status === 'supported').length
  const inconclusive = claims.filter(c => c.status === 'inconclusive').length
  return `${supported} supported, ${inconclusive} inconclusive, ${claims.length - supported - inconclusive} other`
}


/** Deterministic mulberry32 PRNG (seeded) for the percentile bootstrap. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** Percentile bootstrap 95% CI with a fixed seed (deterministic). */
function bootstrapCi95(values: number[], resamples: number): [number, number] {
  const rand = mulberry32(20260806)
  const means: number[] = []
  for (let r = 0; r < resamples; r++) {
    let sum = 0
    for (let i = 0; i < values.length; i++) {
      sum += values[Math.floor(rand() * values.length)]!
    }
    means.push(sum / values.length)
  }
  means.sort((a, b) => a - b)
  const lo = means[Math.floor(resamples * 0.025)]!
  const hi = means[Math.ceil(resamples * 0.975) - 1]!
  return [lo, hi]
}

function round(value: number): number {
  return Math.round(value * 10000) / 10000
}


function escapeXml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}


/** Stable BibTeX citation key from a paper id (doi:10.x/y -> doi10x_y). */
function citationKey(paperId: string): string {
  return paperId.replace(/[^a-zA-Z0-9]/g, '_').slice(0, 60)
}
