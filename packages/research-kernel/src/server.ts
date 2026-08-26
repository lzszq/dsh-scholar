/**
 * Research Kernel HTTP API (design §8.3) — a minimal, versioned JSON API on
 * node:http. The DSH plugin and the runner gateway are the primary clients.
 * @module @dsh-scholar/research-kernel/server
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { createHash, createHmac, timingSafeEqual } from 'node:crypto'
import { performance } from 'node:perf_hooks'
import { z } from 'zod'
import { ResearchKernel, KernelError, TEX_ENGINES, validateUploadFileName } from './kernel.js'
import { dshOperatorPrincipal } from './dsh-principal.js'
import { TexError } from './tex-workspace.js'
import { PtyError } from './pty-session.js'
import { WorkspaceError } from './workspace-store.js'
import { PtyOpenRequest, PtyControlRequest, HumanPrincipal, NoveltyAudit, ObservedPhase, WorkspaceWriteRequest, WorkspaceMoveRequest, generateJsonSchema, randomId, ReproductionReportInput, ProviderCreateInput, ProviderUpdateInput, ProjectModelBindingInput, RunnerTargetCreateInput, RunnerTargetUpdateInput, IdeaDraft, runnerTargetConfigHash, type PtySession } from '@dsh-scholar/research-schemas'
import {
  UPLOAD_MAX_BODY_BYTES, extractBoundary, parseMultipart,
  type MultipartPart,
} from './uploads.js'
import { validateSecretRefInput } from './provider.js'
import { AssuranceStoreError } from './assurance-store.js'
import { MethodologyStoreError } from './methodology-store.js'
import { WritingReviewStoreError } from './writing-review-store.js'
import { MethodologyRolloutStoreError } from './rollout-policy.js'
import { evaluateResearchMethodology } from './research-methodology.js'
import { buildResearchGraph } from './research-graph.js'
import { writingClaimEvidenceSha256, writingTexSha256 } from './writing-methodology.js'
import { FullAutoSurveyResultSchema } from './full-auto.js'
import {
  AssuranceAuditKind,
  AssuranceSemanticReviewReceipt,
  ChildExecutionIdentity,
  WritingAssuranceAuditKind,
  DirectionGatePayload,
  DirectionProposal,
  KnowledgeActivationIntent,
  KnowledgePackageEvaluation,
  KnowledgePackageRecord,
  ProtocolRevision,
  ResearchRunOutcomeWrite,
  ResearchSynthesis,
  ReviewFinding,
  ReverseOutline,
  MethodTriadWrite,
  SectionGuideActivationWrite,
  WritingReviewerPanelWrite,
  WritingPatchProposalWrite,
  WritingPatchApplyInput,
  MethodologyRolloutMode,
  MethodologyRolloutSha256,
} from '@dsh-scholar/research-schemas'

export interface KernelServerOptions {
  kernel: ResearchKernel
  host?: string
  port?: number
  /** Optional static bearer token for local loopback auth. */
  token?: string
  /** §12.7: require signed run manifests (also settable on the kernel itself). */
  requireSignedManifest?: boolean
  /**
   * CONFIG-01: sha256 pin of the deployment's effective config (computed by
   * the CLI through the canonical Config Registry). When omitted the kernel's
   * own configPinHash is used; exposed via the `x-config-pin` response header
   * and the `/v1|v2/health` `config_pin` field.
   */
  configPinHash?: string
  /**
   * CONFIG-01: redacted view of the deployment's effective config (secret
   * values already replaced with `<redacted>` by validateConfig) served by
   * GET /v1/config/effective. When omitted the kernel's own
   * constructor-level redacted config is served.
   */
  configRedacted?: Record<string, unknown>
}

const idSchema = z.string().min(1)

const methodologyExpectedRevision = z.number().int().nonnegative().safe()
const assuranceAcceptSchema = z.object({
  expected_revision: methodologyExpectedRevision,
}).strict()
const writingAssuranceExecutionSchema = z.object({
  expected_revision: methodologyExpectedRevision,
  audit_kind: WritingAssuranceAuditKind,
  mode: z.literal('deterministic'),
  semantic_review: z.null(),
}).strict()
const internalWritingAssuranceExecutionSchema = z.discriminatedUnion('mode', [
  writingAssuranceExecutionSchema,
  z.object({
    expected_revision: methodologyExpectedRevision,
    audit_kind: WritingAssuranceAuditKind,
    mode: z.literal('semantic'),
    semantic_review: AssuranceSemanticReviewReceipt,
  }).strict(),
])
const protocolRevisionWriteSchema = z.object({
  record: ProtocolRevision,
  expected_revision: methodologyExpectedRevision,
}).strict()
const researchSynthesisWriteSchema = z.object({
  request_id: z.string().regex(/^synthesis_request_[a-z0-9_]+$/),
  record: ResearchSynthesis,
  expected_revision: methodologyExpectedRevision,
}).strict()
const methodologyRolloutPolicyUpdateSchema = z.object({
  mode: MethodologyRolloutMode,
  expected_revision: z.number().int().positive().safe(),
}).strict()
const projectMethodologyRolloutPinSchema = z.object({
  expected_project_pin_revision: z.number().int().positive().safe(),
  expected_policy_revision: z.number().int().positive().safe(),
  expected_policy_hash: MethodologyRolloutSha256,
}).strict()
const researchRunOutcomeWriteSchema = ResearchRunOutcomeWrite
const directionProposalWriteSchema = z.object({
  record: DirectionProposal,
  expected_revision: methodologyExpectedRevision,
}).strict()
const directionAdoptionWriteSchema = z.object({
  adoption_id: z.string().regex(/^adoption_[a-z0-9_]+$/),
  decision: z.enum(['adopted', 'rejected']),
  gate_decision_ref: z.string().min(1).max(256).nullable(),
  created_at: z.string().datetime(),
  expected_revision: methodologyExpectedRevision,
}).strict()
const knowledgePackageWriteSchema = z.object({
  record: KnowledgePackageRecord,
  expected_revision: methodologyExpectedRevision,
}).strict()
const knowledgeEvaluationWriteSchema = z.object({
  record: KnowledgePackageEvaluation,
  expected_revision: methodologyExpectedRevision,
}).strict()
const knowledgeActivationWriteSchema = KnowledgeActivationIntent
const knowledgeDeactivationWriteSchema = z.object({
  request: z.object({
    project_id: z.string().min(1).max(256),
    session_id: z.string().min(1).max(256),
    activation_id: z.string().regex(/^activation_[a-z0-9_]+$/),
    explicit_human_deactivation: z.literal(true),
    reason: z.enum(['user-requested', 'superseded', 'no-longer-needed']),
  }).strict(),
  expected_revision: methodologyExpectedRevision,
}).strict()
const writingReviewWriteSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('reverse-outline'),
    record: ReverseOutline,
    expected_revision: methodologyExpectedRevision,
  }).strict(),
  z.object({
    kind: z.literal('review-finding'),
    record: ReviewFinding,
    expected_revision: methodologyExpectedRevision,
  }).strict(),
])

/** TRAJ-01/SUBAGENT-01 (trajectory-subagents.md §3): register one spawned
 * subagent child link. `project_id` comes from the route path (never the
 * body — the kernel binds the child to the path project). */
const childStateSchema = z.enum(['running', 'inactive', 'diagnostic', 'succeeded', 'failed', 'cancelled', 'redacted', 'unknown'])

const registerChildSchema = z.object({
  child_id: z.string().min(1),
  parent_id: z.string().nullable().optional(),
  label: z.string().nullable().optional(),
  summary: z.string().max(2000).optional(),
  kind: z.enum(['subagent', 'task']).optional(),
  mode: z.enum(['one-shot', 'continuable', 'read-only']).optional(),
  role: z.string().nullable().optional(),
  state: childStateSchema.optional(),
}).strict()

const registerChildFromSessionSchema = registerChildSchema.extend({
  session_id: z.string().min(1).max(256),
  execution_identity: ChildExecutionIdentity.optional(),
}).strict()

const updateChildFromSessionSchema = z.object({
  session_id: z.string().min(1).max(256),
  state: childStateSchema,
  detail: z.string().max(2000).optional(),
}).strict()

/** One-shot READ-ONLY followup (recorded, never executed by the standalone
 * kernel — trajectory-subagents.md §3 "接收只返回 message_id"). */
const followupSchema = z.object({
  message: z.string().min(1).max(4000),
  request_id: z.string().optional(),
}).strict()

/** Canonical artifact kind list (schema + upload route share it). */
const ARTIFACT_KINDS = ['code', 'pdf', 'data', 'log', 'model', 'chart', 'paper', 'analysis', 'manifest', 'bundle', 'tex-source', 'bib', 'compile-log', 'compile-aux'] as const

const terminalFramesSchema = z.object({
  run_id: z.string().min(1),
  frames: z.array(z.object({
    seq: z.number().int().nonnegative(),
    stream_seq: z.number().int().nonnegative().nullable().optional(),
    channel: z.enum(['stdout', 'stderr']).nullable().optional(),
    text: z.string().nullable().optional(),
    byte_offset: z.number().int().nonnegative().nullable().optional(),
    byte_length: z.number().int().nonnegative().nullable().optional(),
    frame_kind: z.enum(['chunk', 'gap', 'exit']),
    payload_json: z.string().optional(),
    lease_generation: z.number().int().nonnegative().optional(),
  })).min(1).max(256),
  max_log_bytes: z.number().int().positive().optional(),
  // §4 P0 (TERM-01): lease owner/token MAY travel in the body as a fallback;
  // the x-lease-owner/x-lease-token headers take precedence (runner client).
  owner: z.string().optional(),
  lease_token: z.string().nullable().optional(),
}).strict()

const createProjectSchema = z.object({
  name: z.string().min(1),
  workspace: z.string().min(1),
  brief: z.unknown(),
  mode: z.enum(['gate-only', 'full-auto']).optional(),
  constraints: z.record(z.unknown()).optional(),
  execution: z.record(z.unknown()).optional(),
  integrity: z.record(z.unknown()).optional(),
  session_id: z.string().nullable().optional(),
  dsh_workspace_id: z.string().nullable().optional(),
  // API-01: the caller (BFF) resolves the authenticated principal and seeds
  // the creator PI membership; callers never submit actor/principal fields.
  creator_principal_id: z.string().optional(),
  creator_tenant_id: z.string().optional(),
})

const createProjectForGrillSchema = z.object({
  name: z.string().trim().min(1).max(120),
  creator_principal_id: z.string().optional(),
  creator_tenant_id: z.string().optional(),
})

const createDshSessionProjectSchema = z.object({
  name: z.string().trim().min(1).max(120),
}).strict()

const linkDshSessionProjectSchema = z.object({
  project_id: z.string().regex(/^rsp_[a-z0-9_]+$/),
}).strict()

const deleteProjectSchema = z.object({
  expected_revision: z.number().int().nonnegative(),
  confirm_name: z.string(),
  reason: z.string().min(1),
}).strict()

const projectGrillAnswerSchema = z.object({
  question_code: z.string().min(1),
  question_revision: z.number().int().positive(),
  value: z.unknown().optional(),
  disposition: z.enum(['answered', 'skipped', 'unknown']).optional(),
}).strict()

const projectGrillConfirmSchema = z.object({
  expected_project_revision: z.number().int().nonnegative(),
  expected_intake_revision: z.number().int().positive(),
}).strict()

const projectRunnerTargetSchema = z.object({
  expected_revision: z.number().int().nonnegative(),
  runner_target_id: z.string().min(1).max(120),
}).strict()

const transitionSchema = z.object({
  to: z.string().min(1),
  expected_revision: z.number().int().nonnegative(),
  reason: z.string().optional(),
})

const gateSchema = z.object({
  type: z.enum(['scope', 'idea', 'contract', 'budget', 'release', 'direction']),
  title: z.string().min(1),
  summary: z.string().optional(),
  payload: z.record(z.unknown()).optional(),
  session_id: z.string().nullable().optional(),
})

const decisionSchema = z.object({
  // GOV-01: `actor` is a legacy display label only — the identity is the
  // REQUIRED `principal` below. The route rejects requests without a
  // principal (422 principal_required, fail-closed) and defaults actor to
  // principal.principal_id when omitted. The only actor-based exception is
  // the internal orchestrator approve route (contracts/{id}/approve), which
  // is not a Human Gate decision.
  actor: z.string().min(1).optional(),
  principal: z.object({
    principal_id: z.string().min(1),
    tenant_id: z.string().optional(),
    auth_method: z.string().optional(),
    session_id: z.string().nullable().optional(),
  }),
  decision: z.enum(['approved', 'rejected', 'revised']),
  // gui-plugin-plan §6: reject/revise must carry the operator's rationale.
  reason: z.string().optional().superRefine((value, ctx) => {
    // refined below against the decision (schema-level cross-field check).
    void value; void ctx
  }),
  diff: z.string().optional(),
  session_id: z.string().nullable().optional(),
  event_id: z.string().nullable().optional(),
}).superRefine((value, ctx) => {
  if ((value.decision === 'rejected' || value.decision === 'revised') && (value.reason === undefined || value.reason.trim() === '')) {
    ctx.addIssue({ code: 'custom', message: 'reason is required for rejected/revised decisions', path: ['reason'] })
  }
})

const artifactSchema = z.object({
  project_id: z.string().min(1),
  kind: z.enum(ARTIFACT_KINDS),
  content_base64: z.string().min(1),
  metadata: z.record(z.unknown()).optional(),
  media_type: z.string().min(1).max(256).optional(),
  file_name: z.string().min(1).max(255).optional(),
})

const corpusSchema = z.object({
  project_id: z.string().min(1).optional(),
  /** Optional CAS fence used by state-guided native turns. Explicit slash
   *  snapshots remain valid without it, but an automatic turn must pin the
   *  projection revision it revalidated immediately before committing. */
  expected_revision: z.number().int().nonnegative().optional(),
  expected_session_id: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:@-]{0,255}$/).optional(),
  queries: z.array(z.object({ source: z.enum(['openalex', 'crossref', 'arxiv', 'semantic-scholar']), query: z.string(), run_at: z.string() })).default([]),
  papers: z.array(z.unknown()),
  passages: z.array(z.unknown()).optional(),
  citation_edges: z.array(z.unknown()).optional(),
  external_claims: z.array(z.unknown()).optional(),
  // v2 shape (domain-model.md §5): per-source status; a source failure must
  // be recorded (pending) instead of silently dropping the query.
  source_status: z.enum(['pending', 'complete']).optional(),
})

const contractSchema = z.object({
  project_id: z.string().min(1).optional(),
  idea_id: z.string().min(1),
  baseline_run: z.string().optional(),
  code_snapshot: z.string().optional(),
  data: z.object({ dataset_id: z.string().min(1), version: z.string().optional(), split: z.string().optional(), preprocessing_hash: z.string().optional() }),
  methods: z.object({ baseline: z.string().min(1), treatment: z.string().min(1) }),
  metrics: z.object({ primary: z.string().min(1), secondary: z.array(z.string()).optional(), direction: z.enum(['higher_is_better', 'lower_is_better']).optional() }),
  seeds: z.array(z.number().int()).optional(),
  analysis: z.record(z.unknown()).optional(),
  ablations: z.array(z.string()).optional(),
  stop_conditions: z.record(z.unknown()).optional(),
})

const jobSchema = z.object({
  project_id: z.string().min(1).optional(),
  idempotency_key: z.string().min(1),
  kind: z.enum(['echo', 'smoke', 'baseline', 'pilot', 'formal', 'analysis', 'reproduce']),
  command: z.array(z.string()).optional(),
  payload: z.record(z.unknown()).optional(),
  contract_id: z.string().nullable().optional(),
  max_attempts: z.number().int().positive().optional(),
  // §12.2 JobSpec binding (SCH-EXEC-002).
  code_snapshot_id: z.string().nullable().optional(),
  data_artifact_ids: z.array(z.string()).optional(),
  image_digest: z.string().optional(),
  output_contract: z.object({ metrics: z.string(), logs: z.string() }).optional(),
  runner_profile_id: z.string().nullable().optional(),
  runner_target_id: z.string().nullable().optional(),
  protocol_pin: z.object({
    protocol_id: z.string().regex(/^protocol_[a-z0-9_]+$/),
    revision: z.number().int().positive(),
    canonical_hash: z.string().regex(/^sha256:[0-9a-f]{64}$/),
  }).strict().nullable().optional(),
  run_intent: z.enum(['exploratory', 'confirmatory']).optional(),
  // v2 shape (domain-model.md §9): durable submitter principal. The route
  // prefers the BFF-injected x-principal-id header; a body value is accepted
  // only as an explicit override for internal callers — absent both → NULL.
  created_by_principal_id: z.string().nullable().optional(),
})

/** Baselines are contract-bound operations, never ordinary Jobs. All seeds
 * use /baseline-runs so contract, snapshot, environment, revision and phase
 * rules share the same atomic Kernel boundary. */
function rejectBaselineOrdinarySubmit(kind: string): void {
  if (kind !== 'baseline') return
  throw new KernelError(422, 'baseline_handoff_required',
    'baseline jobs must use POST /v1/projects/{id}/baseline-runs')
}

const baselineRunSchema = z.object({
  expected_revision: z.number().int().nonnegative(),
  idempotency_key: z.string().min(1),
  contract_id: z.string().min(1),
  code_snapshot_id: z.string().min(1),
  seed: z.number().int().safe().optional(),
  data_artifact_ids: z.array(z.string().min(1)).max(1).optional(),
  command: z.array(z.string().min(1)).min(1),
  runner_target_id: z.string().min(1).nullable().optional(),
  image_digest: z.string().min(1).optional(),
  output_contract: z.object({
    metrics: z.string().min(1),
    logs: z.string().min(1),
  }).strict().optional(),
}).strict()

// P0-4 (hardening-v0.2-status.md §5 SNAPSHOT-01/API-01): the code-snapshot
// API accepts ONLY a project workspace + root-relative path — never a caller
// supplied host path. `.strict()` rejects the deprecated `{path: …}` shape
// (and any unknown field) with 422 validation_error: the old shape is
// documented as deprecated and refused, not silently re-interpreted.
const codeSnapshotSchema = z.object({
  workspace_id: z.string().min(1),
  root_relative_path: z.string().optional(),
  description: z.string().optional(),
}).strict()

const jobCompleteSchema = z.object({
  owner: z.string().min(1),
  status: z.enum(['succeeded', 'failed', 'cancelled']),
  run_manifest: z.record(z.unknown()).optional(),
  failure_class: z.enum(['environment', 'resources', 'code_error', 'data_issue', 'no_improvement', 'unstable_results', 'budget_exhausted', 'unknown']).nullable().optional(),
  error: z.string().optional(),
  // §12.6 lease fencing: when provided, both must match the current lease.
  lease_generation: z.number().int().nonnegative().nullable().optional(),
  lease_token: z.string().nullable().optional(),
})

const runnerKeySchema = z.object({
  key_id: z.string().min(1),
  public_key_pem: z.string().min(1),
})

const ideaSchema = z.object({
  project_id: z.string().min(1).optional(),
  // v2 shape (domain-model.md §6): optional frozen-corpus binding; the Idea
  // Gate validates it (422 idea_corpus_unknown/idea_corpus_foreign) when set.
  corpus_snapshot_id: z.string().nullable().optional(),
  title: z.string().min(1),
  hypothesis: z.string().min(1),
  scientific_gap: z.record(z.unknown()).optional(),
  nearest_prior_works: z.array(z.record(z.unknown())).optional(),
  exact_delta: z.string().min(1),
  falsification: z.object({ observation: z.string().min(1) }),
  minimum_viable_experiment: z.record(z.unknown()),
  novelty_audit: z.record(z.unknown()).optional(),
  scores: z.object({
    feasibility: z.number().int().min(1).max(5),
    information_gain: z.number().int().min(1).max(5),
    reproducibility: z.number().int().min(1).max(5),
    cost: z.number().int().min(1).max(5),
  }),
  risk_notes: z.string().optional(),
})

const ideaBatchSchema = z.object({
  expected_project_revision: z.number().int().nonnegative(),
  corpus_snapshot_id: z.string().min(1),
  ideas: z.array(IdeaDraft).min(1).max(5),
}).strict()

const ideaGatePrepareSchema = z.object({
  idea_id: z.string().min(1),
  expected_project_revision: z.number().int().nonnegative(),
  expected_idea_version: z.number().int().positive(),
  novelty_audit: NoveltyAudit,
}).strict()

const contractGatePrepareSchema = z.object({
  idea_id: z.string().min(1),
  expected_project_revision: z.number().int().nonnegative(),
  expected_idea_version: z.number().int().positive(),
  contract: contractSchema.omit({ project_id: true, idea_id: true }).strict(),
}).strict()

const evidenceSchema = z.object({
  project_id: z.string().min(1).optional(),
  source_type: z.enum(['run', 'analysis', 'external-passage', 'reproduction']),
  run_ids: z.array(z.string()).optional(),
  artifact_refs: z.array(z.string()).optional(),
  analysis_method: z.string().min(1),
  result: z.record(z.unknown()),
  uncertainty: z.string().optional(),
  // v2 §13.1 / §6: agent-facing write defaults to draft_unverified; 'verified'
  // and 'accepted' are internal states (Analysis-Worker / Verifier-Auditor
  // accept) and are REJECTED on the public route (hardening EVID-01).
  provenance_status: z.enum(['draft_unverified', 'legacy_unverified']).optional(),
})

const claimVerifySchema = z.object({
  claim_id: z.string().min(1),
  evidence_ids: z.array(z.string()).min(1),
  analysis_artifact: z.string().optional(),
  reason: z.string().optional(),
})

const claimCreateSchema = z.object({
  project_id: z.string().min(1).optional(),
  statement: z.string().min(1),
  scope: z.record(z.unknown()).optional(),
})

const budgetSchema = z.object({
  model_cost_usd: z.number().nonnegative().optional(),
  gpu_hours: z.number().nonnegative().optional(),
  api_requests: z.number().int().nonnegative().optional(),
  // v2 shape (domain-model.md §16): storage accounting in bytes.
  storage_bytes: z.number().int().nonnegative().optional(),
})

/**
 * reconstruction-contracts.md §10: POST /v1/jobs/{id}/terminal-frames accepts
 * {frames: TerminalFrame[]} with 1–256 frames and TOTAL JSON <= 1 MiB. All
 * other JSON routes keep the general 32 MiB cap (the browser-facing BFF
 * additionally enforces its own 16 MiB default, security-baseline.md §3).
 */
function requestBodyCap(method: string, version: string | undefined, resource: string | undefined, id: string | undefined, sub: string | undefined): number {
  if (method === 'POST' && version === 'v1' && resource === 'jobs' && id !== undefined && sub === 'terminal-frames') {
    return 1024 * 1024
  }
  return 32 * 1024 * 1024
}

function readJson(req: IncomingMessage, maxBytes = 32 * 1024 * 1024): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > maxBytes) {
        // Respond with an explicit 413 (the dispatcher's .catch sends the
        // envelope) instead of an implicit connection reset; the remainder
        // of the stream is drained so the response can flush.
        req.resume()
        reject(new KernelError(413, 'payload_too_large', `request body exceeds ${Math.floor(maxBytes / 1024 / 1024)} MiB`))
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      if (chunks.length === 0) {
        resolve({})
        return
      }
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')))
      } catch {
        reject(new KernelError(400, 'invalid_json', 'request body is not valid JSON'))
      }
    })
    req.on('error', reject)
  })
}

/**
 * UPLOAD-01: read a raw request body into a Buffer with a hard cap. The cap
 * is the file limit plus a bounded multipart envelope allowance (headers +
 * boundaries), so a file at the exact 32 MiB limit still fits while an
 * oversized upload is rejected mid-stream (413 payload_too_large).
 */
function readBodyBytes(req: IncomingMessage, limit: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    let settled = false
    const settle = (fn: () => void): void => {
      if (settled) return
      settled = true
      fn()
    }
    req.on('data', (chunk: Buffer) => {
      if (settled) return // past the cap: keep draining (bounded memory) so
      // the client can still read our 413 response — destroying the socket
      // here would surface as a client-side connection error instead.
      size += chunk.length
      if (size > limit) {
        settle(() => reject(new KernelError(413, 'payload_too_large',
          `upload body exceeds ${limit} bytes (max_file_bytes=${ResearchKernel.UPLOAD_MAX_FILE_BYTES} plus envelope overhead)`)))
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => settle(() => resolve(Buffer.concat(chunks))))
    req.on('error', (error: Error) => settle(() => reject(error)))
    req.on('close', () => settle(() => reject(new KernelError(400, 'invalid_multipart', 'request closed before the upload body was complete'))))
  })
}

/** Form-field text helper: a part's UTF-8 payload trimmed, or undefined. */
function fieldText(parts: MultipartPart[], name: string): string | undefined {
  const part = parts.find(p => p.name === name)
  if (part === undefined) return undefined
  const text = part.data.toString('utf8').trim()
  return text === '' ? undefined : text
}

/**
 * UPLOAD-01 (api-contracts.md §7): POST /v1/projects/{id}/uploads —
 * multipart/form-data single-file artifact upload with staged finalize
 * semantics:
 *
 *   - fields: `kind` (required ArtifactKind), `file` (required file part),
 *     `file_name` (optional, defaults to the part's filename), `media_type`
 *     (optional);
 *   - server-side sha256 binding: the hash recorded on the artifact is
 *     computed over the bytes actually received (never a client claim);
 *   - size cap: ≤ 32 MiB per file (413 payload_too_large; the streaming body
 *     reader rejects oversized requests before they are buffered in full);
 *   - path safety: the file name must be a plain basename (validateUpload-
 *     FileName) — absolute paths, `..`, NUL and Windows drive prefixes are
 *     rejected (422 invalid_file_name); multiple file parts are rejected
 *     (422 multiple_files; duplicate normalized paths are an archive concern
 *     enforced by the code-snapshot walk);
 *   - staged → finalize: bytes land in a session-id'd staging file first,
 *     then finalizeStagedUpload atomically promotes them into the CAS blob
 *     slot + artifact row; any failure rolls the stage back;
 *   - idempotency: the same project + sha256 + file_name returns the
 *     ORIGINAL artifact (HTTP 200, `reused: true`) without re-writing;
 *   - GC/recovery: expired staged files are collected by
 *     kernel.cleanupStagedUploads (24 h default TTL).
 */
async function handleUpload(req: IncomingMessage, res: ServerResponse, kernel: ResearchKernel, projectId: string): Promise<void> {
  const contentType = req.headers['content-type']
  if (typeof contentType !== 'string' || !contentType.trim().toLowerCase().startsWith('multipart/form-data')) {
    throw new KernelError(415, 'unsupported_media_type', 'artifact upload requires multipart/form-data')
  }
  const boundary = extractBoundary(contentType)
  if (boundary === null || boundary === '') {
    throw new KernelError(400, 'invalid_multipart', 'multipart/form-data boundary is missing or malformed')
  }
  const body = await readBodyBytes(req, UPLOAD_MAX_BODY_BYTES)
  let parts: MultipartPart[]
  try {
    parts = parseMultipart(body, boundary)
  } catch (error) {
    throw new KernelError(400, 'invalid_multipart', `malformed multipart body: ${(error as Error).message}`)
  }
  const fileParts = parts.filter(p => p.fileName !== undefined)
  if (fileParts.length === 0) {
    throw new KernelError(422, 'missing_file', 'upload requires exactly one file part (name="file", with a filename)')
  }
  if (fileParts.length > 1) {
    throw new KernelError(422, 'multiple_files', 'single-file uploads must not carry more than one file part')
  }
  const filePart = fileParts[0]!
  const kindRaw = fieldText(parts, 'kind')
  const kindCheck = z.enum(ARTIFACT_KINDS).safeParse(kindRaw)
  if (!kindCheck.success) {
    throw new KernelError(422, 'invalid_kind', `upload kind must be one of ${ARTIFACT_KINDS.join('/')}`)
  }
  // The registered download name: explicit file_name field wins, otherwise
  // the part's filename. Both are validated as plain basenames.
  const rawName = fieldText(parts, 'file_name') ?? filePart.fileName!
  validateUploadFileName(rawName)
  if (filePart.data.byteLength > ResearchKernel.UPLOAD_MAX_FILE_BYTES) {
    throw new KernelError(413, 'payload_too_large',
      `upload exceeds the size limit: ${filePart.data.byteLength} bytes (max_file_bytes=${ResearchKernel.UPLOAD_MAX_FILE_BYTES})`)
  }
  const mediaType = fieldText(parts, 'media_type')
  const stage = kernel.stageUploadContent({
    project_id: projectId,
    kind: kindCheck.data,
    file_name: rawName,
    media_type: mediaType,
    content: filePart.data,
  })
  const { record, reused } = kernel.finalizeStagedUpload(stage.stage_id)
  send(res, reused ? 200 : 201, { ...record, reused })
}

/**
 * ONBOARD-01 (api-contracts.md §16, research-onboarding.md §4): intake
 * artifact staging — multipart/form-data single-file upload bound to an
 * Intake session. Same hard caps/parser as UPLOAD-01 (≤32 MiB per file,
 * server-side sha256, path-safe basename) but the bytes land in the ISOLATED
 * intake staging CAS — NO project artifact row is written before adoption
 * (pre-accept zero authority).
 */
async function handleIntakeArtifactUpload(req: IncomingMessage, res: ServerResponse, kernel: ResearchKernel, projectId: string, intakeId: string): Promise<void> {
  const contentType = req.headers['content-type']
  if (typeof contentType !== 'string' || !contentType.trim().toLowerCase().startsWith('multipart/form-data')) {
    throw new KernelError(415, 'unsupported_media_type', 'intake artifact upload requires multipart/form-data')
  }
  const boundary = extractBoundary(contentType)
  if (boundary === null || boundary === '') {
    throw new KernelError(400, 'invalid_multipart', 'multipart/form-data boundary is missing or malformed')
  }
  const body = await readBodyBytes(req, UPLOAD_MAX_BODY_BYTES)
  let parts: MultipartPart[]
  try {
    parts = parseMultipart(body, boundary)
  } catch (error) {
    throw new KernelError(400, 'invalid_multipart', `malformed multipart body: ${(error as Error).message}`)
  }
  const fileParts = parts.filter(p => p.fileName !== undefined)
  if (fileParts.length === 0) {
    throw new KernelError(422, 'missing_file', 'intake artifact upload requires exactly one file part (name="file", with a filename)')
  }
  if (fileParts.length > 1) {
    throw new KernelError(422, 'multiple_files', 'single-file uploads must not carry more than one file part')
  }
  const filePart = fileParts[0]!
  // Cross-project scope guard: 404 unless the intake belongs to the route project.
  kernel.assertIntakeInProject(intakeId, projectId)
  const rawName = fieldText(parts, 'file_name') ?? filePart.fileName!
  const mediaType = fieldText(parts, 'media_type')
  const artifact = kernel.stageIntakeArtifact(intakeId, {
    file_name: rawName,
    media_type: mediaType,
    content: filePart.data,
  })
  send(res, 201, artifact)
}

/**
 * CHUNK-01 (init-grill-upload-models.md §3, api-contracts.md §16
 * artifact-stages): append ONE raw chunk to an upload session. The body is
 * the raw chunk bytes (bounded by the session's chunk_size); `Content-Range:
 * bytes <start>-<end>[/<total>]` and `X-Chunk-SHA256` headers drive the
 * protocol — `start == committed_offset` appends, older same-byte/hash
 * ranges replay with `replayed=true`, gaps/overlaps/total mismatches are
 * 409, hash mismatches 422. Bytes land ONLY in the isolated intake staging.
 */
async function handleChunkAppend(req: IncomingMessage, res: ServerResponse, kernel: ResearchKernel, projectId: string, intakeId: string, uploadId: string): Promise<void> {
  // Cross-project scope guard: 404 unless the intake belongs to the route
  // project (the session itself is re-scoped by intakeId in the kernel).
  kernel.assertIntakeInProject(intakeId, projectId)
  const contentRange = req.headers['content-range']
  if (typeof contentRange !== 'string' || contentRange === '') {
    throw new KernelError(422, 'invalid_content_range', 'chunk append requires a Content-Range header (bytes <start>-<end>[/<total>])')
  }
  const chunkSha256 = req.headers['x-chunk-sha256']
  if (typeof chunkSha256 !== 'string' || chunkSha256 === '') {
    throw new KernelError(422, 'invalid_chunk_hash_header', 'chunk append requires an X-Chunk-SHA256 header')
  }
  const body = await readBodyBytes(req, kernel.intakeChunkSizeBytes + 4096)
  const result = kernel.appendUploadChunk(intakeId, uploadId, { bytes: body, contentRange, chunkSha256 })
  send(res, 200, result)
}

/**
 * WORK-01 (api-contracts.md §17): multipart binary upload into a workspace
 * node — same staged-capsule pipeline as UPLOAD-01 (one file part ≤ 32 MiB,
 * server-side sha256 via writeBinary, path safety inside the kernel), but
 * the bytes land on the workspace tree instead of an artifact row. Fields:
 * `path` (required workspace-relative path), `media` (optional media type),
 * `expected_version` / `expected_etag` (optional CAS guard — 409 on stale).
 */
async function handleWorkspaceAsset(req: IncomingMessage, res: ServerResponse, kernel: ResearchKernel, projectId: string, workspaceId: string): Promise<void> {
  const contentType = req.headers['content-type']
  if (typeof contentType !== 'string' || !contentType.trim().toLowerCase().startsWith('multipart/form-data')) {
    throw new KernelError(415, 'unsupported_media_type', 'workspace asset upload requires multipart/form-data')
  }
  const boundary = extractBoundary(contentType)
  if (boundary === null || boundary === '') {
    throw new KernelError(400, 'invalid_multipart', 'multipart/form-data boundary is missing or malformed')
  }
  const body = await readBodyBytes(req, UPLOAD_MAX_BODY_BYTES)
  let parts: MultipartPart[]
  try {
    parts = parseMultipart(body, boundary)
  } catch (error) {
    throw new KernelError(400, 'invalid_multipart', `malformed multipart body: ${(error as Error).message}`)
  }
  const fileParts = parts.filter(p => p.fileName !== undefined)
  if (fileParts.length === 0) {
    throw new KernelError(422, 'missing_file', 'workspace asset upload requires exactly one file part (name="file", with a filename)')
  }
  if (fileParts.length > 1) {
    throw new KernelError(422, 'multiple_files', 'workspace asset uploads must not carry more than one file part')
  }
  const path = fieldText(parts, 'path')
  if (path === undefined || path === '') {
    throw new KernelError(422, 'missing_path', 'workspace asset upload requires a path field (workspace-relative)')
  }
  const filePart = fileParts[0]!
  if (filePart.data.byteLength > ResearchKernel.UPLOAD_MAX_FILE_BYTES) {
    throw new KernelError(413, 'payload_too_large',
      `workspace asset exceeds the size limit: ${filePart.data.byteLength} bytes (max_file_bytes=${ResearchKernel.UPLOAD_MAX_FILE_BYTES})`)
  }
  // CAS guard fields (both optional; the kernel answers 409 on mismatch).
  const expected: { version?: number; etag?: string } = {}
  const rawVersion = fieldText(parts, 'expected_version')
  if (rawVersion !== undefined) {
    const version = Number(rawVersion)
    if (!Number.isInteger(version) || version < 0) {
      throw new KernelError(422, 'invalid_expected_version', 'expected_version must be a non-negative integer')
    }
    expected.version = version
  }
  const rawEtag = fieldText(parts, 'expected_etag')
  if (rawEtag !== undefined) expected.etag = rawEtag
  // Cross-project scope guard (the BFF checks membership of the PATH project;
  // the kernel additionally pins the workspace to it).
  kernel.assertWorkspaceInProject(workspaceId, projectId)
  const node = kernel.workspaceWriteBinary(workspaceId, path, filePart.data, fieldText(parts, 'media') ?? 'application/octet-stream', expected)
  send(res, 201, node)
}

/** ONBOARD-01 request schemas (research-onboarding.md §5/§7). */
const intakeBeginSchema = z.object({
  source_label: z.string().min(1),
  target_phase: ObservedPhase.nullable().optional(),
  principal: HumanPrincipal.optional(),
  expires_in_ms: z.number().int().positive().optional(),
  idempotency_key: z.string().optional(),
  request_hash: z.string().optional(),
  owner_scope_id: z.string().min(1).max(160).regex(/^[A-Za-z0-9._:-]+$/).optional(),
}).strict()

const intakeAnswersSchema = z.object({
  answers: z.array(z.object({
    question_code: z.string().min(1),
    answer: z.string().min(1),
    question_revision: z.number().int().positive(),
  })).min(1).max(64),
  principal: HumanPrincipal,
}).strict()

const intakeAdoptSchema = z.object({
  principal: HumanPrincipal,
  expected_proposal_revision: z.number().int().positive(),
  expected_target_revision: z.number().int().nonnegative().optional(),
  idempotency_key: z.string().optional(),
  request_hash: z.string().optional(),
}).strict()

const intakeRejectSchema = z.object({
  principal: HumanPrincipal,
}).strict()

/** CHUNK-01 (init-grill-upload-models.md §3): batch chunked upload begin. */
const uploadSessionBeginSchema = z.object({
  file_name: z.string().min(1).max(512),
  media_type: z.string().max(256).optional(),
  expected_size: z.number().int().nonnegative(),
  expected_sha256: z.string().regex(/^[0-9a-f]{64}$/).optional(),
  chunk_size: z.number().int().positive().optional(),
  owner_scope_id: z.string().min(1).max(160).regex(/^[A-Za-z0-9._:-]+$/).optional(),
}).strict()

/** MODEL-01 (init-grill-upload-models.md §4): provider create/update/delete. */
const providerDeleteSchema = z.object({
  expected_revision: z.number().int().positive(),
}).strict()

const runnerTargetHeartbeatSchema = z.object({
  expected_revision: z.number().int().positive(),
  health: z.enum(['online', 'offline']),
}).strict()

/**
 * GOV-01 fail-closed pattern for intake Human actions: a request without an
 * authenticated `principal.principal_id` is 422 principal_required BEFORE
 * zod parsing — anonymous/actor-only requests never reach the kernel.
 */
function requireIntakePrincipal(body: unknown, res: ServerResponse, action: string): boolean {
  const bodyObj = typeof body === 'object' && body !== null ? body as Record<string, unknown> : {}
  const p = bodyObj.principal as Record<string, unknown> | undefined
  const principalId = typeof p === 'object' && p !== null && !Array.isArray(p)
    && typeof p.principal_id === 'string'
    ? p.principal_id
    : ''
  if (principalId === '') {
    send(res, 422, { error: errorEnvelope('principal_required', `${action} requires an authenticated principal (principal.principal_id); anonymous or actor-only requests are rejected`) })
    return false
  }
  return true
}

function errorEnvelope(code: string, message: string): Record<string, unknown> {
  // api-contracts.md §1: stable retryable flags for the documented codes.
  const retryableCodes = new Set(['lease_conflict', 'lease_stale', 'upload_offset_conflict', 'document_version_conflict'])
  return { code, message, request_id: currentRequestId, retryable: retryableCodes.has(code) }
}

/**
 * §4 P0 (hardening API-01/EVID-01): INTERNAL service routes. When the kernel
 * was configured with a service token, EVERY one of these demands the
 * `x-service-token` header — the loopback bearer credential (browser) and
 * self-reported `x-service-principal` headers do NOT satisfy it, so a
 * browser session can never claim jobs, register runner keys, recover
 * leases, write verified evidence, accept evidence or freeze contracts.
 * Route patterns are matched on the canonical decoded-segment path; the
 * handlers below also require the correct x-service-principal on the
 * evidence routes. Matching raw pathname here would let percent-encoding or
 * duplicate slashes bypass the service-token gate while reaching the same
 * decoded handler.
 */
const SERVICE_ROUTES: ReadonlyArray<{ method: string; re: RegExp; label: string }> = [
  { method: 'POST', re: /^\/v1\/jobs-claim\/run$/, label: 'jobs-claim' },
  { method: 'POST', re: /^\/v1\/runner-keys$/, label: 'runner-keys' },
  { method: 'POST', re: /^\/v1\/recover\/leases$/, label: 'recover/leases' },
  { method: 'POST', re: /^\/v1\/runner-targets$/, label: 'runner-targets/create' },
  { method: 'PATCH', re: /^\/v1\/runner-targets\/[^/]+$/, label: 'runner-targets/update' },
  { method: 'POST', re: /^\/v1\/runner-targets\/[^/]+\/heartbeat$/, label: 'runner-targets/heartbeat' },
  { method: 'POST', re: /^\/v1\/projects\/[^/]+\/evidence\/verified$/, label: 'evidence/verified' },
  { method: 'POST', re: /^\/v1\/projects\/[^/]+\/evidence\/[^/]+\/accept$/, label: 'evidence/accept' },
  { method: 'POST', re: /^\/v1\/projects\/[^/]+\/contracts\/[^/]+\/approve$/, label: 'contracts/approve' },
  { method: 'POST', re: /^\/internal\/reproduction-attempts\/[^/]+\/reports$/, label: 'reproduction/reports' },
  { method: 'POST', re: /^\/internal\/projects\/[^/]+\/topology\/children$/, label: 'topology/children' },
  { method: 'PATCH', re: /^\/internal\/topology\/[^/]+\/state$/, label: 'topology/state' },
  { method: 'POST', re: /^\/internal\/dsh-sessions\/[^/]+\/knowledge-activations$/, label: 'dsh/knowledge-activation' },
  { method: 'POST', re: /^\/internal\/dsh-sessions\/[^/]+\/assurance-executions$/, label: 'dsh/assurance-execution' },
]

function isServiceRoute(method: string, pathname: string): boolean {
  return SERVICE_ROUTES.some(r => r.method === method && r.re.test(pathname))
}

/** Constant-time comparison: hash both sides then timingSafeEqual. */
function serviceTokenEquals(provided: string, expected: string): boolean {
  const a = createHash('sha256').update(provided).digest()
  const b = createHash('sha256').update(expected).digest()
  return timingSafeEqual(a, b)
}

function requireDshPlugin(
  req: IncomingMessage,
  res: ServerResponse,
  kernel: ResearchKernel,
  action: string,
): boolean {
  if (kernel.serviceToken === undefined) {
    send(res, 403, { error: errorEnvelope('service_token_required', `${action} requires a configured service token`) })
    return false
  }
  const configured = kernel.dshPluginToken
  const provided = req.headers['x-dsh-plugin-token']
  if (configured === undefined || configured.trim() === '' || typeof provided !== 'string'
    || provided.trim() === '' || !serviceTokenEquals(provided, configured)) {
    send(res, 403, { error: errorEnvelope('dsh_plugin_token_required', `${action} requires the DSH plugin credential`) })
    return false
  }
  if (req.headers['x-service-principal'] !== 'dsh-plugin') {
    send(res, 403, { error: errorEnvelope('service_identity_required', `${action} requires x-service-principal: dsh-plugin`) })
    return false
  }
  return true
}

function requireResearchOrchestrator(
  req: IncomingMessage,
  res: ServerResponse,
  kernel: ResearchKernel,
  action: string,
): boolean {
  if (req.headers['x-service-principal'] !== 'research-orchestrator') {
    send(res, 403, { error: errorEnvelope('service_identity_required', `${action} requires x-service-principal: research-orchestrator`) })
    return false
  }
  const configured = kernel.orchestratorToken
  const provided = req.headers['x-orchestrator-token']
  if (configured === undefined || typeof provided !== 'string' || provided.trim() === ''
    || !serviceTokenEquals(provided, configured)) {
    send(res, 403, { error: errorEnvelope('orchestrator_token_required', `${action} requires the managed orchestrator credential`) })
    return false
  }
  return true
}

/** OBS-01: loopback source addresses (IPv4, IPv6, IPv4-mapped IPv6). */
export function isLoopbackAddress(address: string | undefined | null): boolean {
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1'
}

/**
 * RunnerTarget target-token headers are a loopback transport only. This
 * decision deliberately accepts only the TCP peer address reported by Node;
 * caller-controlled forwarding headers must never widen the trust boundary.
 * A production mTLS terminator may authenticate the peer and forward from a
 * loopback socket, but this plaintext Kernel listener never accepts the
 * target-token wire directly from a non-loopback peer.
 */
export function runnerTargetTokenAccessAllowed(remoteAddress: string | undefined | null): boolean {
  return isLoopbackAddress(remoteAddress)
}

/**
 * OBS-01 (reconstruction-contracts.md §18): GET /internal/metrics is only
 * reachable from loopback — either the peer's source address IS loopback or
 * the server itself is bound to a loopback host (then every peer is local by
 * construction). Any other combination is rejected 403 by the route.
 */
export function metricsAccessAllowed(remoteAddress: string | undefined | null, boundHost: string): boolean {
  if (boundHost === '127.0.0.1' || boundHost === '::1' || boundHost === 'localhost' || boundHost === '') return true
  return isLoopbackAddress(remoteAddress)
}

/**
 * OBS-01: the /internal/metrics surface — a JSON metrics snapshot, loopback
 * only, and deliberately NOT a service-token route: like /v1/health it sits
 * at the deployment's public surface (or is exposed per deployment config;
 * the loopback check is the default guard). Returns true when the request
 * was handled (route() then returns immediately).
 */
export function handleInternalMetrics(req: IncomingMessage, res: ServerResponse, kernel: ResearchKernel, boundHost: string): boolean {
  let url: URL
  try {
    url = new URL(req.url ?? '/', 'http://127.0.0.1')
  } catch {
    return false
  }
  if (req.method !== 'GET' || url.pathname !== '/internal/metrics') return false
  if (!metricsAccessAllowed(req.socket.remoteAddress, boundHost)) {
    send(res, 403, { error: errorEnvelope('loopback_only', '/internal/metrics is reachable only from loopback addresses') })
    return true
  }
  ok(res, kernel.metrics.snapshot())
  return true
}

let currentRequestId = 'req_unknown'

function send(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
  })
  res.end(payload)
}

function ok(res: ServerResponse, body: unknown): void {
  send(res, 200, body)
}

/** Safe RFC 6266/5987 download header; active document types are attachment-only. */
function artifactContentDisposition(mediaType: string, fileName: string): string {
  const essence = mediaType.split(';', 1)[0]!.trim().toLowerCase()
  const safeInline = essence === 'application/pdf' || [
    'image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/avif',
  ].includes(essence)
  const fallback = fileName
    .normalize('NFKD')
    .replace(/[^\x20-\x7e]/g, '_')
    .replace(/["\\]/g, '_')
    .slice(0, 180) || 'artifact'
  const encoded = encodeURIComponent(fileName).replace(/[!'()*]/g, char =>
    `%${char.charCodeAt(0).toString(16).toUpperCase()}`)
  return `${safeInline ? 'inline' : 'attachment'}; filename="${fallback}"; filename*=UTF-8''${encoded}`
}

function fail(res: ServerResponse, error: unknown): void {
  if (error instanceof KernelError) {
    send(res, error.status, { error: errorEnvelope(error.code, error.message) })
  } else if (error instanceof TexError) {
    // CAS write conflicts and invalid TeX paths map to HTTP semantics.
    const status = error.code === 'document_version_conflict' ? 409 : 422
    send(res, status, { error: errorEnvelope(error.code, error.message) })
  } else if (error instanceof PtyError) {
    // PTY-01 wire mapping: not found → 404, idempotency/state conflicts →
    // 409, open/param validation → 422, adapter absence → 501/503.
    const status = error.code === 'pty_session_not_found' ? 404
      : error.code === 'pty_state_conflict' || error.code === 'pty_client_seq_out_of_order' || error.code === 'pty_session_closed' ? 409
        : error.code === 'pty_adapter_failed' ? 503
          : 422
    send(res, status, { error: errorEnvelope(error.code, error.message) })
  } else if (error instanceof WorkspaceError) {
    // WORK-01 wire mapping: version/etag/destination conflicts → 409,
    // missing nodes/workspaces → 404, oversized nodes → 413, path/binary/
    // kind validation → 422, quarantined workspace (recovery scan could not
    // provably repair it) → 503 (server-side consistency state, retry will
    // not help until the operator restores the bytes).
    const status = error.code === 'workspace_not_found' || error.code === 'workspace_file_not_found' ? 404
      : error.code === 'workspace_version_conflict' || error.code === 'workspace_etag_conflict' || error.code === 'workspace_move_destination_exists' ? 409
        : error.code === 'workspace_file_too_large' ? 413
          : error.code === 'workspace_inconsistent' ? 503
            : error.code === 'search_busy' ? 429
              : 422
    send(res, status, { error: errorEnvelope(error.code, error.message) })
  } else if (error instanceof z.ZodError) {
    const issues = error.issues.map(i => `${i.path.join('.') || '<root>'}: ${i.message}`).join('; ')
    send(res, 422, { error: errorEnvelope('validation_error', issues) })
  } else {
    send(res, 500, { error: errorEnvelope('internal', (error as Error).message ?? String(error)) })
  }
}

/** TRAJ-01/SUBAGENT-01: trajectory/topology reads are project-scoped —
 * the authenticated principal (BFF-injected x-principal-id, never a
 * client-asserted value) must be a project member; otherwise fail-closed
 * (422 principal_required / 404 project_not_found — no enumeration). */
function requireProjectMember(kernel: ResearchKernel, req: IncomingMessage, res: ServerResponse, projectId: string): string | null {
  const principalId = typeof req.headers['x-principal-id'] === 'string' && req.headers['x-principal-id'] !== '' ? req.headers['x-principal-id'] : ''
  if (principalId === '') {
    send(res, 422, { error: errorEnvelope('principal_required', 'trajectory/topology access requires an authenticated principal (x-principal-id); the BFF injects it from the operator session') })
    return null
  }
  if (!kernel.listProjectMembers(projectId).some(m => m.principal_id === principalId)) {
    send(res, 404, { error: errorEnvelope('project_not_found', 'project not found or access denied') })
    return null
  }
  return principalId
}

/**
 * GOV-01/ONBOARD-01 (hardening §5 P1): explicit capability ROUTE TABLE for
 * PI-only writes — the same table the standalone BFF enforces, so the two
 * layers can never drift apart. Matched against the RAW pathname
 * (segment-anchored, no query params). Governance writes: transitions, gates,
 * decisions, budget, approve, accept (existing) PLUS intake ADOPT
 * (POST /v1/projects/{id}/intake/{iid}/adopt — the PI decision that converts
 * a proposal into project state) and project archive/unarchive.
 */
const PI_ONLY_WRITE_ROUTES: ReadonlyArray<RegExp> = [
  /(?:^|\/)transitions(?:\/|$)/,
  /(?:^|\/)gates(?:\/|$)/,
  /(?:^|\/)decisions(?:\/|$)/,
  /(?:^|\/)budget(?:\/|$)/,
  /(?:^|\/)approve(?:\/|$)/,
  /(?:^|\/)accept(?:\/|$)/,
  /(?:^|\/)intake\/[^/]+\/adopt(?:\/|$)/,
  /(?:^|\/)archive(?:\/|$)/,
  /(?:^|\/)unarchive(?:\/|$)/,
  // INIT-GRILL-02 §2: Grill confirm 是 PI-only 显式确认事务（写入 canonical
  // Brief + 创建唯一 Scope Gate）—— researcher/viewer/auditor 一律 403。
  /(?:^|\/)grill\/confirm(?:\/|$)/,
  /(?:^|\/)execution(?:\/|$)/,
  /(?:^|\/)idea-gate(?:\/|$)/,
  /(?:^|\/)contract-gate(?:\/|$)/,
]

function isPiOnlyWrite(pathname: string): boolean {
  return PI_ONLY_WRITE_ROUTES.some(re => re.test(pathname))
}

/**
 * GOV-01/ONBOARD-01 (hardening §5 P1): the KERNEL's own PI/operator gate for
 * the v1 PI-only decision routes (intake adopt, project archive/unarchive) —
 * defense in depth, never a single BFF layer. When x-principal-id is present
 * (the BFF always injects it on these forwards; direct callers may supply
 * it), the kernel resolves the acting principal's role from its OWN
 * project_members table: researcher/viewer/auditor → 403 role_forbidden, an
 * unknown principal → 404 project_not_found (no enumeration, same shape as
 * memberOr404). With no header, the body `principal.principal_id` (intake
 * adopt's direct-kernel service path) keeps the existing GOV-01 contract;
 * when no identity exists at all (archive/unarchive carry no body principal)
 * → 422 principal_required (fail-closed, same pattern as requireIntakePrincipal).
 */
function requirePiOnly(
  kernel: ResearchKernel,
  req: IncomingMessage,
  res: ServerResponse,
  projectId: string,
  body: unknown,
  action: string,
  options: { allowOperator?: boolean; includeDeleted?: boolean } = {},
): boolean {
  const headerPrincipal = typeof req.headers['x-principal-id'] === 'string' ? req.headers['x-principal-id'] : undefined
  let principal = headerPrincipal !== undefined && headerPrincipal !== '' ? headerPrincipal : ''
  if (principal === '') {
    // Direct-kernel fallback: the body principal (intake adopt only).
    const bodyObj = typeof body === 'object' && body !== null ? body as Record<string, unknown> : {}
    const p = bodyObj.principal as Record<string, unknown> | undefined
    if (typeof p === 'object' && p !== null && !Array.isArray(p) && typeof p.principal_id === 'string') principal = p.principal_id
  }
  if (principal === '') {
    send(res, 422, { error: errorEnvelope('principal_required', `${action} requires an authenticated principal (x-principal-id or principal.principal_id); anonymous or actor-only requests are rejected`) })
    return false
  }
  if (headerPrincipal !== undefined && headerPrincipal !== '') {
    const role = kernel.getProjectMemberRole(projectId, principal, options.includeDeleted === true)
    if (role === null) {
      send(res, 404, { error: errorEnvelope('project_not_found', 'project not found or access denied') })
      return false
    }
    const allowed = role === 'pi' || (options.allowOperator !== false && role === 'operator')
    if (!allowed) {
      const scope = options.allowOperator === false ? 'PI-only' : 'PI/operator-only'
      send(res, 403, { error: errorEnvelope('role_forbidden', `${action} is a ${scope} decision; role '${role}' is not permitted`) })
      return false
    }
  }
  return true
}

/** Global execution-target configuration is a PI/operator administration
 * surface. The Kernel derives that authority from current durable project
 * memberships for x-principal-id; x-principal-role is never trusted. The
 * BFF independently performs the same fail-closed check before proxying. */
function requireGlobalConfigRole(kernel: ResearchKernel, req: IncomingMessage, res: ServerResponse, action: string): boolean {
  const principal = typeof req.headers['x-principal-id'] === 'string' ? req.headers['x-principal-id'] : ''
  const role = kernel.getGlobalConfigRole(principal)
  if (role !== null) return true
  send(res, 403, { error: errorEnvelope('role_forbidden', `${action} requires PI or operator role`) })
  return false
}

/**
 * PTY-01 (hardening §5 P0-2): every pty operation (session read, control,
 * frames) is fail-closed on the authenticated principal AND the session
 * OWNER — a missing x-principal-id is 422 principal_required (GOV-01
 * pattern), a session owned by another principal is 403
 * pty_principal_mismatch (consistent with the pre-existing control check).
 * `requireLease` (control) additionally demands the session lease
 * (x-pty-lease): missing → 403 lease_required, wrong → 403 lease_invalid.
 * Frames/reads accept an OPTIONAL lease — when present it must be valid.
 * "Header missing = pass" is never accepted. Unknown session ids still
 * answer 404 pty_session_not_found via kernel.ptyGet.
 */
function requirePtyOwner(kernel: ResearchKernel, req: IncomingMessage, res: ServerResponse, sessionId: string, opts: { requireLease: boolean }): PtySession | null {
  const principalId = typeof req.headers['x-principal-id'] === 'string' && req.headers['x-principal-id'] !== '' ? req.headers['x-principal-id'] : ''
  if (principalId === '') {
    send(res, 422, { error: errorEnvelope('principal_required', 'pty access requires an authenticated principal (x-principal-id); the BFF injects it from the operator session') })
    return null
  }
  const session = kernel.ptyGet(sessionId) // unknown → 404 pty_session_not_found
  if (session.principal_id !== principalId) {
    send(res, 403, { error: errorEnvelope('pty_principal_mismatch', 'the authenticated principal does not own this pty session') })
    return null
  }
  const leaseHeader = req.headers['x-pty-lease']
  const lease = typeof leaseHeader === 'string' && leaseHeader !== '' ? leaseHeader : ''
  if (opts.requireLease && lease === '') {
    send(res, 403, { error: errorEnvelope('lease_required', 'pty control requires the session lease (x-pty-lease); a missing header is never a pass') })
    return null
  }
  if (lease !== '' && !kernel.ptyVerifyLease(sessionId, lease)) {
    send(res, 403, { error: errorEnvelope('lease_invalid', 'the provided pty lease does not match the session') })
    return null
  }
  return session
}

function parseSeqParam(raw: string | null): number | undefined {
  if (raw === null || raw === '') return undefined
  const n = Number(raw)
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : undefined
}

function parseLimitParam(raw: string | null): number | undefined {
  if (raw === null || raw === '') return undefined
  const n = Number(raw)
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : undefined
}

function parseLaneParam(raw: string | null): 'research' | 'session' | undefined {
  return raw === 'research' || raw === 'session' ? raw : undefined
}

function route(req: IncomingMessage, res: ServerResponse, kernel: ResearchKernel, token: string | undefined, configPin: string | undefined, configRedacted: Record<string, unknown> | undefined, boundHost: string): void {
  currentRequestId = typeof req.headers['x-request-id'] === 'string' && req.headers['x-request-id'] !== ''
    ? req.headers['x-request-id']
    : `req_${Math.random().toString(36).slice(2, 12)}`
  // CONFIG-01: every response carries the effective-config pin so running
  // objects can be correlated with the config that produced them. The header
  // is set before any writeHead and therefore lands on every answer.
  if (configPin !== undefined && configPin !== '') res.setHeader('x-config-pin', configPin)
  let url: URL
  try {
    url = new URL(req.url ?? '/', 'http://127.0.0.1')
  } catch {
    send(res, 400, { error: { code: 'invalid_url', message: 'malformed request url' } })
    return
  }
  // §5 P0-1 (hardening API-01/SIDE-01): when the kernel was configured with a
  // bearer token (--token / DSH_SCHOLAR_KERNEL_TOKEN — the sidecars ALWAYS
  // inject one via the 0600 <dataDir>/kernel-token file), every non-health
  // route demands `Authorization: Bearer <token>`: missing or wrong bearer →
  // 401 unauthorized, no exception. /v1/health and /v2/health stay exempt so
  // liveness probes (sidecar handshake, operators, orchestrators) never lock
  // themselves out. A kernel WITHOUT a token skips the whole check — that is
  // the explicit bare-kernel dev mode only (unit tests spawn bare kernels);
  // sidecar-spawned kernels always carry a token. The service-token layer
  // (x-service-token on internal routes, below) is independent: a bearer
  // never unlocks an internal route and x-service-token never substitutes
  // for the bearer on the public surface.
  if (token !== undefined) {
    const isHealth = url.pathname === '/v1/health' || url.pathname === '/v2/health'
    if (!isHealth) {
      const provided = req.headers.authorization
      if (provided !== `Bearer ${token}`) {
        send(res, 401, { error: { code: 'unauthorized', message: 'missing or invalid bearer token' } })
        return
      }
    }
  }
  // OBS-01 (reconstruction-contracts.md §18): GET /internal/metrics — JSON
  // snapshot, loopback only, no service token required (same public surface
  // as /v1/health, or exposed per deployment config). Routed BEFORE the
  // v1/v2 version gate because the path carries no API version prefix.
  if (handleInternalMetrics(req, res, kernel, boundHost)) return
  // pathname is percent-encoded; decode segments so ids like sha256:<hex>
  // survive (encodeURIComponent on the client side). A malformed escape
  // (e.g. %zz) must answer JSON 400 — never crash the server (§19.2).
  let parts: string[]
  try {
    parts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent) // e.g. ['v1','projects','rsp_x']
  } catch {
    send(res, 400, { error: { code: 'invalid_encoding', message: 'malformed percent-encoding in path' } })
    return
  }

  const method = req.method ?? 'GET'
  const [version, resource, id, sub, subId, subSubId] = parts as [string | undefined, string | undefined, string | undefined, string | undefined, string | undefined, string | undefined]
  const canonicalPath = '/' + parts.map(part => encodeURIComponent(part)).join('/')
  // §4 P0 (API-01/EVID-01): internal service routes require the configured
  // service token via `x-service-token` — the loopback bearer (Authorization)
  // and any self-reported x-service-principal do NOT unlock these routes.
  // A missing/wrong/misplaced credential is 403 service_token_required.
  if (kernel.serviceToken !== undefined && (version === 'internal' || isServiceRoute(method, canonicalPath))) {
    const provided = req.headers['x-service-token']
    if (typeof provided !== 'string' || !serviceTokenEquals(provided, kernel.serviceToken)) {
      send(res, 403, {
        error: errorEnvelope('service_token_required',
          'internal route requires x-service-token (service identity); browser bearer credentials are not accepted'),
      })
      return
    }
  }
  if (version === 'internal' && resource === 'methodology' && id === 'native-packs'
    && sub === 'reconcile' && method === 'POST') {
    if (!requireDshPlugin(req, res, kernel, 'native Knowledge reconciliation')) return
    send(res, 200, kernel.methodology.reconcileNativeKnowledgePacks())
    return
  }
  // FULLAUTO-01: the Durable Orchestrator is a service authority, never a
  // Human Principal. It can request an allowlisted fixture Gate decision only
  // through this internal endpoint. The Kernel re-derives every authority pin
  // and commits Decision/receipt/Gate/Project/Outbox atomically.
  if (version === 'internal' && resource === 'projects' && id !== undefined
    && sub === 'full-auto-gates' && subId !== undefined && subSubId === 'approve' && method === 'POST') {
    if (kernel.serviceToken === undefined) {
      send(res, 403, { error: errorEnvelope('service_token_required', 'full-auto Gate approval requires a configured service token') })
      return
    }
    if (!requireResearchOrchestrator(req, res, kernel, 'full-auto Gate approval')) return
    void readJson(req).then((body) => {
      try {
        const input = z.object({
          expected_project_revision: z.number().int().nonnegative(),
          idempotency_key: z.string().min(1).max(240),
        }).strict().parse(body)
        send(res, 200, kernel.decideFullAutoGate({
          project_id: id,
          gate_id: subId,
          ...input,
        }))
      } catch (error) {
        fail(res, error)
      }
    }).catch((error: unknown) => fail(res, error))
    return
  }
  // GOV-03: Human Gate decisions have no public Kernel write route. The
  // standalone Human BFF authenticates the browser, checks membership/role
  // and CSRF, then crosses this service-only bridge with its own credential.
  // This remains separate from the full-auto authority endpoint above.
  if (version === 'internal' && resource === 'human-gates' && id !== undefined
    && sub === 'decisions' && method === 'POST') {
    if (kernel.serviceToken === undefined) {
      send(res, 403, { error: errorEnvelope('service_token_required', 'Human Gate decisions require a configured service token') })
      return
    }
    if (req.headers['x-service-principal'] !== 'standalone-human-bff') {
      send(res, 403, { error: errorEnvelope('service_identity_required', 'Human Gate decisions require x-service-principal: standalone-human-bff') })
      return
    }
    void readJson(req).then((body) => {
      try {
        const input = decisionSchema.parse(body)
        const forwardedSession = req.headers['x-principal-session']
        if ((input.session_id === undefined || input.session_id === null)
          && typeof forwardedSession === 'string' && forwardedSession !== '') {
          input.session_id = forwardedSession
        }
        ok(res, kernel.decideGate({
          gate_id: id,
          actor: input.actor ?? input.principal.principal_id,
          ...input,
        }))
      } catch (error) {
        fail(res, error)
      }
    }).catch((error: unknown) => fail(res, error))
    return
  }
  // FULLAUTO-01 canonical survey executor: the plugin-hosted connector only
  // supplies untrusted structured retrieval output. Kernel authority derives
  // the complete Brief query and revalidates action/revision/fixture/runner/
  // budget/protocol pins before the atomic corpus+phase+Outbox commit.
  if (version === 'internal' && resource === 'projects' && id !== undefined
    && sub === 'full-auto-actions' && subId === 'survey-run' && subSubId === 'authority' && method === 'POST') {
    if (kernel.serviceToken === undefined) {
      send(res, 403, { error: errorEnvelope('service_token_required', 'full-auto survey authority requires a configured service token') })
      return
    }
    if (!requireResearchOrchestrator(req, res, kernel, 'full-auto survey authority')) return
    void readJson(req).then((body) => {
      try {
        const input = z.object({
          expected_project_revision: z.number().int().nonnegative(),
          action_id: z.string().min(1).max(512),
          action_revision: z.number().int().nonnegative(),
        }).strict().parse(body)
        send(res, 200, kernel.fullAutoSurveyAuthority({ project_id: id, ...input }))
      } catch (error) {
        fail(res, error)
      }
    }).catch((error: unknown) => fail(res, error))
    return
  }
  if (version === 'internal' && resource === 'projects' && id !== undefined
    && sub === 'full-auto-actions' && subId === 'survey-run' && subSubId === undefined && method === 'POST') {
    if (kernel.serviceToken === undefined) {
      send(res, 403, { error: errorEnvelope('service_token_required', 'full-auto survey requires a configured service token') })
      return
    }
    if (!requireResearchOrchestrator(req, res, kernel, 'full-auto survey')) return
    void readJson(req).then((body) => {
      try {
        const input = z.object({
          expected_project_revision: z.number().int().nonnegative(),
          action_id: z.string().min(1).max(512),
          action_revision: z.number().int().nonnegative(),
          expected_authority_sha256: z.string().regex(/^sha256:[a-f0-9]{64}$/),
          idempotency_key: z.string().min(1).max(240),
          result: FullAutoSurveyResultSchema.optional(),
        }).strict().parse(body)
        send(res, 200, kernel.executeFullAutoSurvey({ project_id: id, ...input }))
      } catch (error) {
        fail(res, error)
      }
    }).catch((error: unknown) => fail(res, error))
    return
  }
  // REPRO-01 (docs/reproduction-contracts.md §4): POST
  // /internal/reproduction-attempts/{attempt}/reports — verifier service
  // identity (x-service-token gate above + x-service-principal: verifier
  // here). The public surface can never ingest a report. Routed before the
  // v1/v2 version gate because the path carries no API version prefix.
  if (version === 'internal' && resource === 'reproduction-attempts' && id !== undefined && sub === 'reports' && method === 'POST') {
    void readJson(req, 8 * 1024 * 1024).then(async (body) => {
      try {
        const servicePrincipal = typeof req.headers['x-service-principal'] === 'string' ? req.headers['x-service-principal'] : ''
        if (servicePrincipal !== 'verifier') {
          send(res, 403, { error: errorEnvelope('service_identity_required', 'reproduction report ingestion requires x-service-principal: verifier') })
          return
        }
        const input = ReproductionReportInput.parse(body)
        const report = kernel.reportReproductionAttempt({
          attempt_id: id,
          service_principal: servicePrincipal,
          request_id: currentRequestId,
          attempt_generation: input.attempt_generation,
          lease_token: input.lease_token,
          report: input,
          idempotency_key: typeof req.headers['idempotency-key'] === 'string' && req.headers['idempotency-key'] !== '' ? req.headers['idempotency-key'] : undefined,
          request_hash: createHash('sha256').update(JSON.stringify(body)).digest('hex'),
        })
        send(res, 201, report)
      } catch (error) {
        fail(res, error)
      }
    }).catch((error: unknown) => fail(res, error))
    return
  }
  if (version === 'internal' && resource === 'dsh-sessions' && id !== undefined && sub === 'projects' && method === 'POST') {
    void readJson(req).then((body) => {
      try {
        if (!requireDshPlugin(req, res, kernel, 'DSH project creation')) return
        const configuredDshPluginToken = kernel.dshPluginToken
        if (configuredDshPluginToken === undefined) return
        if (!/^[A-Za-z0-9][A-Za-z0-9._:@-]{0,255}$/.test(id)) {
          send(res, 422, { error: errorEnvelope('invalid_session_id', 'DSH session id is not a safe opaque id') })
          return
        }
        const idempotencyKey = typeof req.headers['idempotency-key'] === 'string' && req.headers['idempotency-key'] !== ''
          ? req.headers['idempotency-key']
          : undefined
        if (idempotencyKey === undefined) {
          send(res, 422, { error: errorEnvelope('idempotency_key_required', 'DSH project creation requires an Idempotency-Key header') })
          return
        }
        const input = createDshSessionProjectSchema.parse(body)
        const replayHeader = req.headers['x-idempotency-replay-only']
        if (replayHeader !== undefined && replayHeader !== '1') {
          send(res, 422, { error: errorEnvelope('validation_error', 'x-idempotency-replay-only must be 1 when provided') })
          return
        }
        const requestHash = createHmac('sha256', configuredDshPluginToken)
          .update(JSON.stringify({ route: 'dsh-create-link-v1', session_id: id, name: input.name }))
          .digest('hex')
        const out = kernel.createProjectForDshSession({
          name: input.name,
          session_id: id,
          idempotency_key: idempotencyKey,
          request_hash: requestHash,
          replay_only: replayHeader === '1',
        })
        send(res, 201, out)
      } catch (error) {
        fail(res, error)
      }
    }).catch((error: unknown) => fail(res, error))
    return
  }
  if (version === 'internal' && resource === 'dsh-sessions' && id !== undefined && sub === 'project-options' && method === 'GET') {
    try {
      if (!requireDshPlugin(req, res, kernel, 'DSH project selection')) return
      if (!/^[A-Za-z0-9][A-Za-z0-9._:@-]{0,255}$/.test(id)) {
        send(res, 422, { error: errorEnvelope('invalid_session_id', 'DSH session id is not a safe opaque id') })
        return
      }
      ok(res, kernel.listProjectsForDshOperator())
    } catch (error) {
      fail(res, error)
    }
    return
  }
  if (version === 'internal' && resource === 'dsh-sessions' && id !== undefined && sub === 'project-link' && method === 'POST') {
    void readJson(req).then((body) => {
      try {
        if (!requireDshPlugin(req, res, kernel, 'DSH project binding')) return
        const input = linkDshSessionProjectSchema.parse(body)
        send(res, 201, kernel.linkProjectForDshSession({ session_id: id, project_id: input.project_id }))
      } catch (error) {
        fail(res, error)
      }
    }).catch((error: unknown) => fail(res, error))
    return
  }
  if (version === 'internal' && resource === 'dsh-sessions' && id !== undefined && sub === 'knowledge-activations' && method === 'POST') {
    void readJson(req).then((body) => {
      try {
        if (!requireDshPlugin(req, res, kernel, 'DSH Knowledge activation')) return
        if (!/^[A-Za-z0-9][A-Za-z0-9._:@-]{0,255}$/.test(id)) {
          send(res, 422, { error: errorEnvelope('invalid_session_id', 'DSH session id is not a safe opaque id') })
          return
        }
        const linked = kernel.getProjectBySession(id)
        if (linked === null) {
          send(res, 409, { error: errorEnvelope('session_link_required', 'DSH session is not linked to a Scholar project') })
          return
        }
        const input = knowledgeActivationWriteSchema.parse(body)
        const dshToken = kernel.dshPluginToken
        if (dshToken === undefined) {
          send(res, 403, { error: errorEnvelope('dsh_plugin_token_required', 'DSH plugin credential is unavailable') })
          return
        }
        send(res, 201, kernel.activateKnowledgePackageFromAuthority({
          project_id: linked.project_id,
          session_id: id,
          principal_id: dshOperatorPrincipal(dshToken),
          ...input,
        }))
      } catch (error) {
        fail(res, error)
      }
    }).catch((error: unknown) => fail(res, error))
    return
  }
  if (version === 'internal' && resource === 'dsh-sessions' && id !== undefined && sub === 'assurance-executions' && method === 'POST') {
    void readJson(req).then((body) => {
      try {
        if (!requireDshPlugin(req, res, kernel, 'DSH Assurance execution')) return
        if (!/^[A-Za-z0-9][A-Za-z0-9._:@-]{0,255}$/.test(id)) {
          send(res, 422, { error: errorEnvelope('invalid_session_id', 'DSH session id is not a safe opaque id') })
          return
        }
        const linked = kernel.getProjectBySession(id)
        if (linked === null) {
          send(res, 409, { error: errorEnvelope('session_link_required', 'DSH session is not linked to a Scholar project') })
          return
        }
        const input = internalWritingAssuranceExecutionSchema.parse(body)
        if (input.mode === 'semantic' && input.semantic_review.session_id !== id) {
          send(res, 409, { error: errorEnvelope('semantic_review_session_mismatch', 'semantic review does not belong to the exact DSH session') })
          return
        }
        send(res, 201, kernel.runWritingAssurance({ project_id: linked.project_id, ...input }))
      } catch (error) {
        fail(res, error)
      }
    }).catch((error: unknown) => fail(res, error))
    return
  }
  if (version === 'internal' && resource === 'projects' && id !== undefined && sub === 'topology' && subId === 'children' && method === 'POST') {
    void readJson(req).then((body) => {
      try {
        if (req.headers['x-service-principal'] !== 'dsh-plugin') {
          send(res, 403, { error: errorEnvelope('service_identity_required', 'topology registration requires x-service-principal: dsh-plugin') })
          return
        }
        const input = registerChildFromSessionSchema.parse(body)
        const linked = kernel.getProjectBySession(input.session_id)
        if (linked?.project_id !== id) {
          send(res, 409, { error: errorEnvelope('session_link_conflict', 'DSH session is not linked to the topology project') })
          return
        }
        if (input.parent_id !== input.session_id) {
          send(res, 403, { error: errorEnvelope('exact_parent_required', 'topology child parent must be the exact linked DSH session') })
          return
        }
        const { session_id: _sessionId, ...child } = input
        send(res, 201, kernel.registerChildLink({ project_id: id, ...child }))
      } catch (error) {
        fail(res, error)
      }
    }).catch((error: unknown) => fail(res, error))
    return
  }
  if (version === 'internal' && resource === 'topology' && id !== undefined && sub === 'state' && method === 'PATCH') {
    void readJson(req).then((body) => {
      try {
        if (req.headers['x-service-principal'] !== 'dsh-plugin') {
          send(res, 403, { error: errorEnvelope('service_identity_required', 'topology state update requires x-service-principal: dsh-plugin') })
          return
        }
        const input = updateChildFromSessionSchema.parse(body)
        const child = kernel.getChildLink(id)
        const linked = kernel.getProjectBySession(input.session_id)
        if (linked?.project_id !== child.project_id || child.parent_id !== input.session_id) {
          send(res, 409, { error: errorEnvelope('session_link_conflict', 'DSH session is no longer the exact parent of this topology child') })
          return
        }
        ok(res, kernel.updateChildState(id, input.state, input.detail))
      } catch (error) {
        fail(res, error)
      }
    }).catch((error: unknown) => fail(res, error))
    return
  }
  if (version !== 'v1' && version !== 'v2') {
    send(res, 404, { error: { code: 'not_found', message: 'unknown api version' } })
    return
  }
  // §4 P1 (UPLOAD-01): multipart artifact upload — staged, hash-bound,
  // idempotent (api-contracts.md §7 / acceptance-tests.md §3.1). Routed
  // before readJson: the body is raw multipart, not JSON.
  if (method === 'POST' && version === 'v1' && resource === 'projects' && id !== undefined && sub === 'uploads' && subId === undefined) {
    void handleUpload(req, res, kernel, id).catch((error: unknown) => fail(res, error))
    return
  }
  // ONBOARD-01: intake artifact staging — multipart, isolated staging CAS
  // (research-onboarding.md §4). Routed before readJson like UPLOAD-01.
  if (method === 'POST' && version === 'v1' && resource === 'projects' && id !== undefined && sub === 'intake' && subId !== undefined && url.pathname.endsWith('/artifacts')) {
    void handleIntakeArtifactUpload(req, res, kernel, id, subId).catch((error: unknown) => fail(res, error))
    return
  }
  // CHUNK-01 (init-grill-upload-models.md §3): chunked upload append — raw
  // bytes body + Content-Range / X-Chunk-SHA256 headers. Routed before
  // readJson like the multipart handlers.
  if (method === 'PUT' && version === 'v1' && resource === 'projects' && id !== undefined && sub === 'intake' && subId !== undefined
      && subSubId === 'upload-sessions' && parts[6] !== undefined && parts[7] === 'chunks') {
    void handleChunkAppend(req, res, kernel, id, subId, parts[6]).catch((error: unknown) => fail(res, error))
    return
  }
  // WORK-01 (api-contracts.md §17): binary workspace asset upload —
  // multipart, same caps/parser as UPLOAD-01, bytes land on the workspace
  // tree (server-side sha256 binding). Routed before readJson (raw body).
  if (method === 'POST' && version === 'v1' && resource === 'projects' && id !== undefined && sub === 'workspaces' && subId !== undefined && subSubId === 'assets') {
    void handleWorkspaceAsset(req, res, kernel, id, subId).catch((error: unknown) => fail(res, error))
    return
  }
  if (version === 'v2') {
    void readJson(req, requestBodyCap(method, version, resource, id, sub)).then(async (body) => {
      try {
        await handleV2({ req, res, method, url, resource, id, sub, subId, subSubId, body, kernel, configPin })
      } catch (error) {
        if (error instanceof KernelError) send(res, error.status, { error: { code: error.code, message: error.message } })
        else if (error instanceof AssuranceStoreError || error instanceof MethodologyStoreError || error instanceof WritingReviewStoreError || error instanceof MethodologyRolloutStoreError) {
          send(res, error.status, { error: { code: error.code, message: error.message } })
        }
        else if (error instanceof z.ZodError) {
          // INIT-GRILL-02 §1: v2 契约校验失败（如 name 去空白后 1–120）→
          // 稳定的 422 validation_error，绝不 500。
          send(res, 422, { error: { code: 'validation_error', message: error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; ') } })
        } else {
          console.error(`[kernel] v2 handler error: ${(error as Error).message}`)
          send(res, 500, { error: { code: 'internal_error', message: 'internal error' } })
        }
      }
    }).catch((error: unknown) => fail(res, error))
    return
  }

  void readJson(req, requestBodyCap(method, version, resource, id, sub)).then(async (body) => {
    try {
      switch (resource) {
        case 'health': {
          // test-instance-plan.md §1: instance identity (instance_id /
          // protocol_version / schema_version / database_id) is exposed on
          // BOTH health surfaces so sidecars and operators can verify they
          // talk to the expected kernel instance. v1 keeps the legacy
          // ok/instance/config_pin fields; v2 carries the canonical
          // HealthResponse (reconstruction-contracts.md §5).
          ok(res, {
            ok: true,
            instance: kernel.instanceId,
            instance_id: kernel.instanceId,
            protocol_version: 'v1',
            schema_version: kernel.schemaVersion(),
            database_id: kernel.databaseId(),
            config_pin: configPin ?? kernel.configPinHash,
            time: new Date().toISOString(),
          })
          return
        }
        // CONFIG-01 HTTP surface: GET /v1/config/effective returns the
        // deployment's effective config (REDACTED — secrets never leave the
        // process in plaintext) with its pin; GET /v1/config/schema serves
        // the registry-generated JSON Schema (canonical UI metadata).
        case 'config': {
          if (method === 'GET' && id === 'effective') {
            ok(res, {
              config_pin: configPin ?? kernel.configPinHash,
              config: configRedacted ?? kernel.configRedacted,
              generated_at: new Date().toISOString(),
            })
            return
          }
          if (method === 'GET' && id === 'schema') {
            ok(res, generateJsonSchema())
            return
          }
          send(res, 404, { error: { code: 'not_found', message: 'unknown config resource' } })
          return
        }
        case 'providers': {
          // MODEL-01 (init-grill-upload-models.md §4 / api-contracts.md §19):
          // instance/global Provider registry. Responses are redacted —
          // credential carries metadata + available only, never a secret value.
          const headerPrincipal = typeof req.headers['x-principal-id'] === 'string' ? req.headers['x-principal-id'] : undefined
          if (method === 'GET' && id === undefined) {
            ok(res, kernel.listProviders().map(p => kernel.providerView(p)))
            return
          }
          if (method === 'POST' && id === undefined) {
            if (!requireGlobalConfigRole(kernel, req, res, 'model provider creation')) return
            const rawCredential = body !== null && typeof body === 'object' && !Array.isArray(body)
              ? (body as Record<string, unknown>).credential
              : undefined
            if (rawCredential !== undefined && rawCredential !== null && typeof rawCredential === 'object' && !Array.isArray(rawCredential)) {
              validateSecretRefInput(rawCredential as never)
            }
            const input = ProviderCreateInput.parse(body)
            send(res, 201, kernel.providerView(kernel.registerProvider({ ...input, created_by: headerPrincipal ?? '' })))
            return
          }
          if (id !== undefined) {
            if (method === 'GET') {
              ok(res, kernel.providerView(kernel.getProvider(id)))
              return
            }
            if (method === 'PATCH') {
              if (!requireGlobalConfigRole(kernel, req, res, 'model provider update')) return
              const rawCredential = body !== null && typeof body === 'object' && !Array.isArray(body)
                ? (body as Record<string, unknown>).credential
                : undefined
              if (rawCredential !== undefined && rawCredential !== null && typeof rawCredential === 'object' && !Array.isArray(rawCredential)) {
                validateSecretRefInput(rawCredential as never)
              }
              const input = ProviderUpdateInput.parse(body)
              ok(res, kernel.providerView(kernel.updateProvider(id, { ...input, updated_by: headerPrincipal ?? '' })))
              return
            }
            if (method === 'DELETE') {
              if (!requireGlobalConfigRole(kernel, req, res, 'model provider deletion')) return
              const input = providerDeleteSchema.parse(body)
              kernel.deleteProvider(id, input.expected_revision)
              ok(res, { ok: true })
              return
            }
          }
          send(res, 404, { error: { code: 'not_found', message: 'unknown provider route' } })
          return
        }
        case 'runner-targets': {
          // EXEC-ENV-02: global target registry. Connection fields are
          // SecretRef metadata + availability only; values never cross HTTP.
          const headerPrincipal = typeof req.headers['x-principal-id'] === 'string' ? req.headers['x-principal-id'] : ''
          if (method === 'GET' && id === undefined) {
            ok(res, kernel.listRunnerTargets().map(target => kernel.runnerTargetView(target)))
            return
          }
          if (method === 'POST' && id === undefined) {
            if (!requireGlobalConfigRole(kernel, req, res, 'runner target creation')) return
            const input = RunnerTargetCreateInput.parse(body)
            send(res, 201, kernel.runnerTargetView(kernel.registerRunnerTarget(input, headerPrincipal)))
            return
          }
          if (id !== undefined) {
            if (method === 'GET') {
              ok(res, kernel.runnerTargetView(kernel.getRunnerTarget(id)))
              return
            }
            if (method === 'PATCH') {
              if (!requireGlobalConfigRole(kernel, req, res, 'runner target update')) return
              const input = RunnerTargetUpdateInput.parse(body)
              ok(res, kernel.runnerTargetView(kernel.updateRunnerTarget(id, input)))
              return
            }
            if (method === 'POST' && sub === 'heartbeat') {
              if (!runnerTargetTokenAccessAllowed(req.socket.remoteAddress)) {
                send(res, 403, { error: errorEnvelope('loopback_only', 'runner target token heartbeat is accepted only from a direct loopback peer; non-loopback deployments require a trusted mTLS terminator') })
                return
              }
              // The shared internal service token only admits the caller to
              // this route family. A second target-scoped credential proves
              // which exact allowlisted target it may observe; URL ids and
              // x-service-principal are never accepted as identity proof.
              const targetToken = req.headers['x-runner-target-token']
              if (typeof targetToken !== 'string' || targetToken === ''
                || !kernel.runnerTargetIdentityAuthorized(id, targetToken)) {
                send(res, 403, { error: errorEnvelope('runner_target_identity_required', 'runner target heartbeat requires the configured target-scoped service identity') })
                return
              }
              const input = runnerTargetHeartbeatSchema.parse(body)
              ok(res, kernel.runnerTargetView(kernel.observeRunnerTarget(id, input)))
              return
            }
          }
          send(res, 404, { error: { code: 'not_found', message: 'unknown runner target route' } })
          return
        }
        case 'projects': {
          if (method === 'POST' && id === undefined) {
            const input = createProjectSchema.parse(body)
            const project = kernel.createProject(input as Parameters<ResearchKernel['createProject']>[0])
            send(res, 201, project)
            return
          }
          if (method === 'GET' && id === undefined) {
            ok(res, kernel.listProjects())
            return
          }
          if (id !== undefined) {
            // PROJECT-DELETE-01: every ordinary project-scoped route is
            // hidden by the tombstone. DELETE itself is the sole exception
            // so an authenticated identical X-Request-Id can replay its
            // stable receipt after ordinary get/list already return 404.
            if (!(method === 'DELETE' && sub === undefined)) kernel.getProject(id)
            // WORK-01 (api-contracts.md §17): generic VS Code-style workspace
            // routes, project-scoped so the BFF membership/role checks bind
            // to the PATH project; the kernel additionally pins the workspace
            // to it (cross-project → 404 workspace_not_found).
            if (sub === 'workspaces') {
              if (method === 'POST' && subId === undefined) {
                const input = z.object({
                  kind: z.enum(['code', 'manuscript', 'scratch']),
                  name: z.string().min(1).max(120),
                }).strict().parse(body)
                send(res, 201, kernel.workspaceEnsure(id, input.kind, input.name))
                return
              }
              if (method === 'GET' && subId === undefined) {
                ok(res, kernel.workspaceList(id))
                return
              }
              if (subId !== undefined) {
                // Every workspace route below is bound to the path project.
                kernel.assertWorkspaceInProject(subId, id)
                if (method === 'GET' && subSubId === 'watch' && parts[6] === 'stream') {
                  // Workspace watch SSE stream (api-contracts.md §22):
                  // change/delete events + revision advance, same
                  // listSince data source as the polling watch feed.
                  void handleWorkspaceWatchSse(req, res, kernel, id, subId, url)
                  return
                }
                if (method === 'GET' && subSubId === 'tree') {
                  ok(res, kernel.workspaceTree(subId))
                  return
                }
                if (method === 'GET' && subSubId === 'history') {
                  ok(res, kernel.workspaceHistory(subId))
                  return
                }
                if (subSubId === 'nodes') {
                  if (method === 'GET') {
                    // ?path= read, ?after_revision=N watch feed, ?path=&version=N
                    // rollback read (all mutually exclusive).
                    const path = url.searchParams.get('path')
                    const afterRevision = url.searchParams.get('after_revision')
                    const version = url.searchParams.get('version')
                    if (path !== null && afterRevision === null && version === null) {
                      const node = kernel.workspaceRead(subId, path)
                      if (node === null) throw new KernelError(404, 'workspace_file_not_found', `file ${path} not found`)
                      ok(res, node)
                      return
                    }
                    if (path !== null && version !== null) {
                      const v = Number(version)
                      if (!Number.isInteger(v) || v <= 0) {
                        throw new KernelError(422, 'invalid_version', 'version must be a positive integer')
                      }
                      const node = kernel.workspaceReadVersion(subId, path, v)
                      if (node === null) throw new KernelError(404, 'workspace_file_not_found', `file ${path} not found at version ${v}`)
                      ok(res, node)
                      return
                    }
                    if (afterRevision !== null) {
                      const since = Number(afterRevision)
                      if (!Number.isInteger(since) || since < 0) {
                        throw new KernelError(422, 'invalid_revision', 'after_revision must be a non-negative integer')
                      }
                      ok(res, kernel.workspaceListSince(subId, since))
                      return
                    }
                    throw new KernelError(422, 'missing_params', '?path= (optionally &version=) or ?after_revision= is required')
                  }
                  if (method === 'POST') {
                    const input = WorkspaceWriteRequest.parse(body)
                    const node = kernel.workspaceWrite(subId, input.path, input.content, {
                      version: input.expected_version,
                      etag: input.expected_etag,
                    })
                    send(res, 201, node)
                    return
                  }
                  if (method === 'DELETE') {
                    const path = url.searchParams.get('path')
                    if (path === null) throw new KernelError(422, 'missing_path', '?path= is required')
                    const raw = url.searchParams.get('expected_version')
                    const expected = raw === null || raw === '' ? undefined : Number(raw)
                    if (expected !== undefined && (!Number.isInteger(expected) || expected < 0)) {
                      throw new KernelError(422, 'invalid_expected_version', 'expected_version must be a non-negative integer')
                    }
                    kernel.workspaceDelete(subId, path, { version: expected, etag: url.searchParams.get('expected_etag') ?? undefined })
                    ok(res, { ok: true })
                    return
                  }
                }
                if (method === 'POST' && subSubId === 'moves') {
                  const input = WorkspaceMoveRequest.parse(body)
                  const node = kernel.workspaceMove(subId, input.from_path, input.to_path, {
                    version: input.expected_version,
                    etag: input.expected_etag,
                  })
                  ok(res, node)
                  return
                }
                if (method === 'POST' && subSubId === 'search') {
                  // WORK-01 (api-contracts.md §17): one endpoint, two modes —
                  //   path:    {prefix?, glob?} (legacy, unchanged);
                  //   content: {q, case_sensitive?} — q is the substring to
                  //            find (trimmed non-empty), text nodes only
                  //            (binary/non-text media skipped), bounded per
                  //            file/result/size; mutually exclusive with the
                  //            path filters.
                  const input = z.object({
                    prefix: z.string().min(1).optional(),
                    glob: z.string().min(1).optional(),
                    // No min() here: empty/whitespace q is rejected below with
                    // the dedicated invalid_query code (422), uniformly.
                    q: z.string().optional(),
                    mode: z.enum(['path', 'content']).optional(),
                    case_sensitive: z.boolean().optional(),
                  }).strict().parse(body)
                  const contentMode = input.mode === 'content' || input.q !== undefined
                  if (contentMode) {
                    if (input.q === undefined || input.q.trim() === '') {
                      throw new KernelError(422, 'invalid_query', 'content search requires a non-empty q')
                    }
                    if (input.mode === 'path') {
                      throw new KernelError(422, 'invalid_search_params', "mode='path' cannot carry q — use prefix/glob for path search")
                    }
                    if (input.prefix !== undefined || input.glob !== undefined) {
                      throw new KernelError(422, 'invalid_search_params', 'content search (q/mode=content) cannot be combined with prefix/glob path filters')
                    }
                    ok(res, kernel.workspaceSearchContent(subId, { q: input.q, case_sensitive: input.case_sensitive }))
                    return
                  }
                  if (input.prefix === undefined && input.glob === undefined) {
                    throw new KernelError(422, 'missing_params', 'search requires prefix and/or glob (path search), or q (content search)')
                  }
                  ok(res, kernel.workspaceSearch(subId, { prefix: input.prefix, glob: input.glob }))
                  return
                }
                if (method === 'GET' && subSubId === 'blobs') {
                  // Raw binary bytes: content-type = node media, strong etag
                  // header, byte-exact body (binary read path).
                  const path = url.searchParams.get('path')
                  if (path === null) throw new KernelError(422, 'missing_path', '?path= is required')
                  const node = kernel.workspaceRead(subId, path)
                  if (node === null) throw new KernelError(404, 'workspace_file_not_found', `file ${path} not found`)
                  if (!node.binary) {
                    throw new KernelError(422, 'workspace_not_binary', `file ${path} is a text node — read it via ?path= on /nodes`)
                  }
                  const bytes = kernel.workspaceBlob(subId, path)
                  if (bytes === null) throw new KernelError(404, 'workspace_file_not_found', `file ${path} bytes not readable`)
                  res.writeHead(200, {
                    'content-type': node.media,
                    'content-length': bytes.byteLength,
                    etag: node.etag,
                    'cache-control': 'no-store',
                  })
                  res.end(bytes)
                  return
                }
                throw new KernelError(404, 'not_found', `unknown workspace route /v1/projects/${id}/workspaces/${subId}/${subSubId ?? ''}`)
              }
              break
            }
            // MODEL-01 (init-grill-upload-models.md §4 / api-contracts.md §19
            // model-bindings): project submits only opaque provider/model ID;
            // the kernel validates provider+model+catalog capability and
            // snapshots provider revision/config hash.
            if (sub === 'model-binding') {
              const headerPrincipal = typeof req.headers['x-principal-id'] === 'string' ? req.headers['x-principal-id'] : undefined
              if (method === 'GET') {
                ok(res, kernel.getProjectModelBinding(id))
                return
              }
              if (method === 'PUT' || method === 'POST') {
                if (!requirePiOnly(kernel, req, res, id, body, 'model binding update')) return
                const input = ProjectModelBindingInput.parse(body)
                ok(res, kernel.setProjectModelBinding(id, { ...input, updated_by: headerPrincipal ?? '' }))
                return
              }
              send(res, 404, { error: { code: 'not_found', message: 'unknown model-binding route' } })
              return
            }
            if (sub === 'chat-scopes' && subId !== undefined && subSubId === 'tombstone' && method === 'POST') {
              ok(res, kernel.tombstoneChatScope(id, subId))
              return
            }
            // ONBOARD-01 (research-onboarding.md / api-contracts.md §16):
            // intake sessions are project-scoped on this surface — every
            // route re-resolves the intake under the path project (cross-
            // project access → 404 intake_not_found, log-authz style).
            if (sub === 'intake') {
              if (method === 'POST' && subId === undefined) {
                const input = intakeBeginSchema.parse(body)
                const session = kernel.beginIntake({
                  project_id: id,
                  source_label: input.source_label,
                  target_phase: input.target_phase ?? null,
                  owner: input.principal,
                  expires_in_ms: input.expires_in_ms,
                  idempotency_key: input.idempotency_key,
                  request_hash: input.request_hash,
                  owner_scope_id: input.owner_scope_id,
                })
                send(res, 201, session)
                return
              }
              if (method === 'GET' && subId === undefined) {
                ok(res, kernel.listIntakes(id))
                return
              }
              if (subId !== undefined) {
                // Cross-project scope guard: 404 unless the intake belongs to
                // the route project (membership fail-closed, log-authz style).
                kernel.assertIntakeInProject(subId, id)
                const segments = parts as Array<string | undefined>
                const action = segments[5]
                if (method === 'GET' && action === undefined) {
                  ok(res, kernel.getIntakeProjection(subId))
                  return
                }
                if (method === 'POST' && action === 'scan') {
                  ok(res, kernel.scanIntake(subId))
                  return
                }
                if (method === 'POST' && action === 'upload-sessions' && segments[6] === undefined) {
                  // CHUNK-01: begin a batch chunked upload session (quota reserved).
                  const input = uploadSessionBeginSchema.parse(body)
                  const headerPrincipal = typeof req.headers['x-principal-id'] === 'string' ? req.headers['x-principal-id'] : undefined
                  send(res, 201, kernel.beginUploadSession(subId, { ...input, principal_id: headerPrincipal }))
                  return
                }
                if (method === 'GET' && action === 'upload-sessions' && segments[6] === undefined) {
                  // CHUNK-01: list sessions (offset/expiry — refresh/断线续传).
                  ok(res, kernel.listUploadSessions(subId))
                  return
                }
                if (method === 'POST' && action === 'upload-sessions' && segments[6] !== undefined && segments[7] === 'finalize') {
                  // CHUNK-01: finalize — server recomputes size/sha256, registers the IntakeArtifact.
                  ok(res, kernel.finalizeUploadSession(subId, segments[6]!))
                  return
                }
                if ((method === 'POST' && action === 'upload-sessions' && segments[6] !== undefined && segments[7] === 'abort')
                    || (method === 'DELETE' && action === 'upload-sessions' && segments[6] !== undefined)) {
                  // CHUNK-01: abort — idempotent (DELETE alias per api-contracts §16).
                  ok(res, kernel.abortUploadSession(subId, segments[6]!))
                  return
                }
                if (method === 'GET' && action === 'questions') {
                  ok(res, kernel.getIntakeQuestions(subId))
                  return
                }
                if (method === 'POST' && action === 'answers') {
                  if (!requireIntakePrincipal(body, res, 'intake answers')) return
                  const input = intakeAnswersSchema.parse(body)
                  ok(res, kernel.submitIntakeAnswers(subId, input.answers, input.principal))
                  return
                }
                if (method === 'POST' && action === 'propose') {
                  send(res, 201, kernel.proposeIntake(subId))
                  return
                }
                if (method === 'POST' && action === 'adopt') {
                  if (!requireIntakePrincipal(body, res, 'intake adoption')) return
                  // GOV-01/ONBOARD-01 (hardening §5 P1): the kernel's OWN
                  // PI/operator gate — when the BFF-injected x-principal-id is
                  // present, the acting principal's role is resolved from the
                  // kernel's project_members table (researcher/viewer/auditor
                  // → 403, unknown → 404); never a single BFF layer.
                  if (!requirePiOnly(kernel, req, res, id, body, 'intake adoption')) return
                  const input = intakeAdoptSchema.parse(body)
                  ok(res, kernel.adoptIntake({
                    intake_id: subId,
                    expected_proposal_revision: input.expected_proposal_revision,
                    expected_target_revision: input.expected_target_revision,
                    idempotency_key: input.idempotency_key,
                    request_hash: input.request_hash,
                  }, input.principal))
                  return
                }
                if (method === 'POST' && action === 'reject') {
                  if (!requireIntakePrincipal(body, res, 'intake rejection')) return
                  const input = intakeRejectSchema.parse(body)
                  ok(res, kernel.rejectIntake(subId, input.principal))
                  return
                }
                if (method === 'DELETE' && action === 'artifacts' && segments[6] !== undefined) {
                  kernel.removeIntakeArtifact(subId, segments[6]!)
                  ok(res, { ok: true })
                  return
                }
              }
            }
            if (method === 'GET' && sub === undefined) {
              ok(res, kernel.getProject(id))
              return
            }
            if (method === 'PATCH' && sub === undefined) {
              const input = z.object({ name: z.string().min(1) }).parse(body)
              ok(res, kernel.renameProject(id, input.name))
              return
            }
            if (method === 'DELETE' && sub === undefined) {
              const input = deleteProjectSchema.parse(body)
              if (!requirePiOnly(kernel, req, res, id, body, 'project deletion', { allowOperator: false, includeDeleted: true })) return
              const deletedBy = typeof req.headers['x-principal-id'] === 'string' ? req.headers['x-principal-id'] : ''
              const requestId = typeof req.headers['x-request-id'] === 'string' ? req.headers['x-request-id'] : ''
              if (requestId === '') throw new KernelError(422, 'request_id_required', 'project deletion requires X-Request-Id')
              ok(res, kernel.deleteProject({ project_id: id, ...input, deleted_by: deletedBy, request_id: requestId }))
              return
            }
            if (method === 'POST' && sub === 'archive') {
              // GOV-01/ONBOARD-01 (hardening §5 P1): kernel-side PI/operator
              // gate (see requirePiOnly) — archive is a PI-only decision and
              // the kernel never relies on the BFF's single layer.
              if (!requirePiOnly(kernel, req, res, id, body, 'project archive')) return
              ok(res, kernel.archiveProject(id))
              return
            }
            if (method === 'POST' && sub === 'unarchive') {
              if (!requirePiOnly(kernel, req, res, id, body, 'project unarchive')) return
              ok(res, kernel.unarchiveProject(id))
              return
            }
            if (method === 'GET' && sub === 'projection') {
              ok(res, kernel.projectProjection(id))
              return
            }
            if (method === 'GET' && sub === 'gates') {
              ok(res, kernel.listGates(id))
              return
            }
            if (method === 'GET' && sub === 'decisions') {
              ok(res, kernel.listDecisions(id))
              return
            }
            if (method === 'GET' && sub === 'ideas') {
              ok(res, kernel.listIdeas(id))
              return
            }
            if (method === 'GET' && sub === 'contracts') {
              ok(res, kernel.listContracts(id))
              return
            }
            // Internal automation path: freeze a contract by a simulated
            // Human Gate Decision (approveContract). The token-protected
            // route is used by evals/orchestrator; interactive flows use the
            // contract gate decision route instead (GOV-02 atomic freeze).
            if (sub === 'contracts' && subId !== undefined && method === 'POST' && url.pathname.endsWith('/approve')) {
              const input = z.object({ actor: z.string().min(1) }).parse(body)
              ok(res, kernel.approveContract(subId, randomId('dec'), input.actor))
              return
            }
            if (sub === 'members' && method === 'GET') {
              ok(res, kernel.listProjectMembers(id))
              return
            }
            if (sub === 'members' && (method === 'POST' || method === 'PATCH')) {
              const input = z.object({
                principal_id: z.string().min(1),
                role: z.enum(['pi', 'researcher', 'operator', 'auditor', 'viewer']),
                tenant_id: z.string().optional(),
                actor: z.string().min(1),
              }).parse(body)
              ok(res, kernel.addProjectMember({ project_id: id, ...input }))
              return
            }
            if (sub === 'members' && subId !== undefined && method === 'DELETE') {
              const input = z.object({ actor: z.string().min(1) }).parse(body)
              kernel.removeProjectMember({ project_id: id, principal_id: subId, actor: input.actor })
              ok(res, { ok: true })
              return
            }
            if (method === 'GET' && sub === 'jobs') {
              ok(res, kernel.listJobs(id))
              return
            }
            if (method === 'GET' && sub === 'runs' && subId === undefined) {
              ok(res, kernel.listRuns(id))
              return
            }
            if (method === 'GET' && sub === 'runs' && subId !== undefined) {
              ok(res, kernel.getRun(id, subId))
              return
            }
            if (method === 'GET' && sub === 'artifacts') {
              ok(res, kernel.listArtifacts(id))
              return
            }
            if (method === 'GET' && sub === 'evidence') {
              ok(res, kernel.listEvidence(id))
              return
            }
            if (method === 'GET' && sub === 'claims') {
              ok(res, kernel.listClaims(id))
              return
            }
            if (method === 'GET' && sub === 'budget') {
              ok(res, kernel.getBudget(id))
              return
            }
            if (method === 'GET' && sub === 'manuscript-review') {
              ok(res, kernel.manuscriptReview(id))
              return
            }
            if (method === 'POST' && sub === 'manuscripts' && subId === 'build') {
              const input = z.object({ format: z.enum(['markdown', 'latex']).optional(), include_limitations: z.boolean().optional() }).parse(body)
              ok(res, kernel.buildManuscript(id, input.format ?? 'markdown', input.include_limitations ?? true))
              return
            }
            if (method === 'POST' && sub === 'release-bundle') {
              ok(res, kernel.releaseBundle(id))
              return
            }
            if (method === 'POST' && sub === 'analysis') {
              const input = z.object({ contract_id: z.string().optional(), metric: z.string().optional() }).parse(body)
              ok(res, kernel.computeAnalysis(id, input.contract_id, input.metric))
              return
            }
            if (method === 'GET' && sub === 'manuscript-drafts') {
              // P0-3 (TEX-01): READ-ONLY open — return the existing
              // workspace without creating a document row or writing any
              // byte. 404 manuscript_not_found when nothing exists yet; the
              // UI then POSTs to create it (the ONLY write path for opening).
              const workspace = kernel.manuscriptWorkspace(id)
              if (workspace === null) {
                throw new KernelError(404, 'manuscript_not_found',
                  `no manuscript workspace for project ${id} — POST manuscript-drafts to create it`)
              }
              ok(res, workspace)
              return
            }
            if (method === 'POST' && sub === 'manuscript-drafts') {
              // gui-plugin-plan §11 + P0-3 (TEX-01): create-or-ensure the
              // versioned TeX workspace. Default (ensure): generation
              // happens ONLY on first creation — an existing workspace with
              // files is returned unchanged (never rewritten by a render).
              // regenerate=true: EXPLICIT regeneration — the current content
              // is frozen as a revision-scoped snapshot BEFORE the rewrite,
              // so the previous bytes stay revertable (GET snapshot-files).
              const input = z.object({
                root_file: z.string().optional(),
                regenerate: z.boolean().optional(),
              }).parse(body)
              ok(res, input.regenerate === true
                ? kernel.regenerateTexWorkspace(id, input.root_file)
                : kernel.ensureManuscriptWorkspace(id, input.root_file))
              return
            }
            if (method === 'GET' && sub === 'events') {
              ok(res, kernel.listEvents(id))
              return
            }
            // TRAJ-01/SUBAGENT-01 (trajectory-subagents.md §7 standalone
            // surface): read-only trajectory projection + child topology.
            // Principal + project membership are enforced here (fail-closed);
            // the BFF injects x-principal-id and pre-checks membership.
            if (method === 'GET' && sub === 'trajectory' && subId === 'stream') {
              // Trajectory incremental SSE stream (api-contracts.md §22):
              // keyset after_seq replay + live tail, lane-filtered, redacted
              // by the projection. Registered BEFORE the polling check so
              // .../trajectory/stream never falls through to the JSON page.
              void handleTrajectorySse(req, res, kernel, id, url)
              return
            }
            if (method === 'GET' && sub === 'trajectory') {
              if (requireProjectMember(kernel, req, res, id) === null) return
              const q = url.searchParams
              ok(res, kernel.projectTrajectory(id, {
                after_seq: parseSeqParam(q.get('after_seq')),
                after_event_id: q.get('after_event_id') ?? undefined,
                limit: parseLimitParam(q.get('limit')),
                lane: parseLaneParam(q.get('lane')),
              }))
              return
            }
            if (method === 'GET' && sub === 'trajectory-lanes') {
              if (requireProjectMember(kernel, req, res, id) === null) return
              ok(res, kernel.projectTrajectoryLanes(id, { limit: parseLimitParam(url.searchParams.get('limit')) }))
              return
            }
            if (method === 'GET' && sub === 'topology' && subId === undefined) {
              if (requireProjectMember(kernel, req, res, id) === null) return
              const q = url.searchParams
              ok(res, kernel.projectTopology(id, {
                parent_id: q.get('parent_id') ?? null,
                after_seq: parseSeqParam(q.get('after_seq')),
                limit: parseLimitParam(q.get('limit')),
              }))
              return
            }
            if (method === 'POST' && sub === 'topology' && subId === 'children') {
              if (requireProjectMember(kernel, req, res, id) === null) return
              const input = registerChildSchema.parse(body)
              const link = kernel.registerChildLink({ ...input, project_id: id })
              send(res, 201, link)
              return
            }
            if (method === 'POST' && sub === 'transitions') {
              const input = transitionSchema.parse(body)
              ok(res, kernel.transition(id, input.to as never, input.expected_revision, input.reason))
              return
            }
            if (method === 'POST' && sub === 'gates') {
              const input = gateSchema.parse(body)
              const gate = kernel.createGate({ project_id: id, ...input })
              send(res, 201, gate)
              return
            }
            if (method === 'POST' && sub === 'session') {
              const input = z.object({ session_id: z.string().min(1) }).parse(body)
              ok(res, kernel.linkSession(input.session_id, id))
              return
            }
            if (method === 'POST' && sub === 'budget') {
              const input = budgetSchema.parse(body)
              ok(res, kernel.recordUsage(id, input))
              return
            }
            if (method === 'POST' && sub === 'ideas' && subId === 'batch') {
              const input = ideaBatchSchema.parse(body)
              const ideas = kernel.createIdeasBatch({ ...input, project_id: id })
              send(res, 201, { ideas })
              return
            }
            if (method === 'POST' && sub === 'ideas' && subId === undefined) {
              const input = ideaSchema.parse(body)
              const idea = kernel.createIdea({ ...input, project_id: id } as never)
              send(res, 201, idea)
              return
            }
            if (method === 'POST' && sub === 'contracts') {
              const input = contractSchema.parse(body)
              const contract = kernel.registerContract({ ...input, project_id: id } as never)
              send(res, 201, contract)
              return
            }
            if (method === 'POST' && sub === 'jobs') {
              const input = jobSchema.parse(body)
              rejectBaselineOrdinarySubmit(input.kind)
              // v2 shape (domain-model.md §9): durable submitter principal —
              // BFF-injected x-principal-id first, body override for internal
              // callers, NULL when neither is present.
              const headerPrincipal = typeof req.headers['x-principal-id'] === 'string' && req.headers['x-principal-id'] !== '' ? req.headers['x-principal-id'] : undefined
              const job = kernel.submitJob({ ...input, project_id: id, created_by_principal_id: input.created_by_principal_id ?? headerPrincipal ?? null })
              send(res, 201, job)
              return
            }
            if (method === 'POST' && sub === 'baseline-runs') {
              const input = baselineRunSchema.parse(body)
              const headerPrincipal = typeof req.headers['x-principal-id'] === 'string' && req.headers['x-principal-id'] !== ''
                ? req.headers['x-principal-id']
                : null
              const started = kernel.startBaselineRun({
                ...input,
                project_id: id,
                created_by_principal_id: headerPrincipal,
              })
              send(res, 201, started)
              return
            }
            if (method === 'GET' && sub === 'code-snapshots') {
              ok(res, kernel.listCodeSnapshots(id))
              return
            }
            if (method === 'POST' && sub === 'code-snapshots') {
              // §11.3 (SCH-EXEC-002): archive ACTUAL workspace contents into
              // a content-addressed `code` artifact (+ manifest artifact).
              // P0-4 (SNAPSHOT-01/API-01): the root is resolved server-side
              // from the approved project workspace (workspace_id +
              // root_relative_path); the deprecated host-`path` shape is
              // refused by the strict schema (422) — see codeSnapshotSchema.
              const input = codeSnapshotSchema.parse(body)
              const snapshot = kernel.snapshotCodeArchive(id, input.workspace_id, input.root_relative_path ?? '', input.description ?? '')
              send(res, 201, snapshot)
              return
            }
            if (method === 'POST' && sub === 'claims') {
              const input = claimCreateSchema.parse(body)
              const claim = kernel.createClaim({ project_id: input.project_id ?? id, statement: input.statement, scope: input.scope as never })
              send(res, 201, claim)
              return
            }
            if (method === 'POST' && sub === 'corpus') {
              const input = corpusSchema.parse(body)
              const snapshot = kernel.snapshotCorpus({ ...input, project_id: id } as never)
              send(res, 201, snapshot)
              return
            }
            if (method === 'GET' && sub === 'corpus-snapshots') {
              ok(res, kernel.listCorpusSnapshots(id))
              return
            }
            if (method === 'POST' && sub === 'evidence' && subId === undefined) {
              const input = evidenceSchema.parse(body)
              const item = kernel.ingestEvidence({ ...input, project_id: id } as never)
              send(res, 201, item)
              return
            }
            // Analysis-Worker internal path (v2 §13.1): verified provenance is
            // only reachable here with the Analysis-Worker service identity;
            // the public route rejects it (EVID-01). A missing/mismatched
            // x-service-principal is a 403 — the public cannot masquerade.
            if (method === 'POST' && sub === 'evidence' && subId === 'verified') {
              const servicePrincipal = typeof req.headers['x-service-principal'] === 'string' ? req.headers['x-service-principal'] : ''
              if (servicePrincipal !== 'analysis-worker') {
                send(res, 403, { error: errorEnvelope('service_identity_required', 'verified evidence ingestion requires x-service-principal: analysis-worker') })
                return
              }
              const input = evidenceSchema.parse(body)
              const item = kernel.ingestVerifiedEvidence({ ...input, project_id: id } as never)
              send(res, 201, item)
              return
            }
            // §6 Verifier/Auditor internal accept route:
            // POST /v1/projects/{id}/evidence/{eid}/accept — transitions
            // verified → accepted (provenance state machine) after full
            // revalidation; only service principals 'verifier'/'auditor' may
            // accept. request_id defaults to the x-request-id header.
            if (method === 'POST' && sub === 'evidence' && subId !== undefined && subId !== 'verified' && url.pathname.endsWith('/accept')) {
              const servicePrincipal = typeof req.headers['x-service-principal'] === 'string' ? req.headers['x-service-principal'] : ''
              if (servicePrincipal !== 'verifier' && servicePrincipal !== 'auditor') {
                send(res, 403, { error: errorEnvelope('service_identity_required', 'evidence accept requires x-service-principal: verifier|auditor') })
                return
              }
              const input = z.object({ request_id: z.string().optional() }).parse(body)
              const item = kernel.acceptEvidence({
                project_id: id,
                evidence_id: subId,
                service_principal: servicePrincipal,
                request_id: input.request_id ?? currentRequestId,
              })
              ok(res, item)
              return
            }
          }
          break
        }
        case 'topology': {
          // SUBAGENT-01 global child surface (trajectory-subagents.md §3/§7):
          // every route resolves the child's project FIRST, then enforces
          // principal + membership — unknown child AND non-member are the
          // same 404 (no enumeration). Reads never activate the child.
          if (id === undefined) {
            send(res, 404, { error: errorEnvelope('not_found', 'unknown api resource') })
            return
          }
          const childProjectId = kernel.childProjectId(id)
          if (childProjectId === null) {
            send(res, 404, { error: errorEnvelope('child_not_found', 'subagent child not found or access denied') })
            return
          }
          if (requireProjectMember(kernel, req, res, childProjectId) === null) return
          if (method === 'GET' && sub === undefined) {
            ok(res, kernel.getChildDetail(id))
            return
          }
          if (method === 'GET' && sub === 'history') {
            const q = url.searchParams
            ok(res, kernel.childHistory(id, { after_seq: parseSeqParam(q.get('after_seq')), limit: parseLimitParam(q.get('limit')) }))
            return
          }
          if (method === 'PATCH' && sub === 'state') {
            const input = z.object({
              state: childStateSchema,
              detail: z.string().max(2000).optional(),
            }).strict().parse(body)
            ok(res, kernel.updateChildState(id, input.state, input.detail))
            return
          }
          if (method === 'POST' && sub === 'followup') {
            const input = followupSchema.parse(body)
            ok(res, kernel.childFollowup(id, input.message, input.request_id))
            return
          }
          send(res, 404, { error: errorEnvelope('not_found', 'unknown api resource') })
          return
        }
        case 'gates': {
          if (id !== undefined && sub === undefined && method === 'GET') {
            // Gate lookup (BFF principal resolver uses it to map a gate
            // decision to the gate's project for membership/role checks).
            ok(res, kernel.getGate(id))
            return
          }
          break
        }
        case 'artifacts': {
          if (method === 'POST' && id === undefined) {
            const input = artifactSchema.parse(body)
            const content = Buffer.from(input.content_base64, 'base64')
            const record = kernel.registerArtifact({
              project_id: input.project_id,
              kind: input.kind,
              content,
              metadata: input.metadata,
              media_type: input.media_type,
              file_name: input.file_name,
            })
            send(res, 201, record)
            return
          }
          if (id !== undefined && (method === 'GET' || method === 'HEAD') && sub === undefined) {
            // v2: project-scoped lookup via ?project_id=; legacy unqualified
            // lookup resolves only when the blob has a single project record.
            const projectId = url.searchParams.get('project_id') ?? undefined
            let record: import('@dsh-scholar/research-schemas').ArtifactRecord
            if (projectId !== undefined) {
              record = kernel.getArtifact(projectId, id)
            } else {
              const matches = kernel.listArtifactsForBlob(id)
              if (matches.length === 0) throw new KernelError(404, 'artifact_not_found', `artifact ${id} not found`)
              if (matches.length > 1) throw new KernelError(409, 'artifact_ambiguous', `artifact ${id} exists in multiple projects; pass project_id`)
              record = matches[0]!
            }
            const content = kernel.cas.read(record.sha256)
            // ART-02: serve the stored media type (PDF artifacts must be
            // application/pdf), with ETag + Content-Disposition + Range
            // (api-contracts.md §artifact GET).
            const mediaType = record.media_type !== null && record.media_type !== '' ? record.media_type
              : (record.kind === 'pdf' ? 'application/pdf' : 'application/octet-stream')
            const etag = `"sha256:${record.sha256}"`
            if (req.headers['if-none-match'] === etag) {
              res.writeHead(304, { etag, 'cache-control': 'no-store' })
              res.end()
              return
            }
            const headOnly = method === 'HEAD'
            const endBody = (status: number, headers: Record<string, string>, body?: Buffer): void => {
              if (headOnly) { res.writeHead(status, headers); res.end(); return }
              res.writeHead(status, headers)
              res.end(body)
            }
            const fileName = record.file_name ?? `${record.kind}-${record.artifact_id.slice(0, 16)}`
            const disposition = artifactContentDisposition(mediaType, fileName)
            const baseHeaders: Record<string, string> = {
              'content-type': mediaType,
              'content-length': String(content.byteLength),
              etag,
              'cache-control': 'no-store',
              'content-disposition': disposition,
              'accept-ranges': 'bytes',
              'x-artifact-id': record.artifact_id,
              'x-project-id': record.project_id,
            }
            // Single-range support (api-contracts.md): bytes=a-b. Invalid or
            // unsatisfiable byte ranges never clamp to a different resource
            // segment; they retain the RFC 7233 416 + bytes */N contract.
            const range = req.headers.range
            const match = typeof range === 'string' ? /^bytes=(\d*)-(\d*)$/.exec(range.trim()) : null
            if (match !== null) {
              const unsatisfiable = (): void => {
                res.writeHead(416, { 'content-range': `bytes */${content.byteLength}`, 'accept-ranges': 'bytes' })
                res.end()
              }
              let start: number
              let end: number
              if (content.byteLength === 0 || (match[1] === '' && match[2] === '')) {
                unsatisfiable()
                return
              }
              if (match[1] !== '') {
                start = Number(match[1])
                if (!Number.isSafeInteger(start) || start >= content.byteLength) {
                  unsatisfiable()
                  return
                }
                if (match[2] === '') {
                  end = content.byteLength - 1
                } else {
                  const requestedEnd = Number(match[2])
                  if (!Number.isSafeInteger(requestedEnd) || requestedEnd < start) {
                    unsatisfiable()
                    return
                  }
                  end = Math.min(requestedEnd, content.byteLength - 1)
                }
              } else {
                const suffixLength = Number(match[2])
                if (!Number.isSafeInteger(suffixLength) || suffixLength <= 0) {
                  unsatisfiable()
                  return
                }
                start = Math.max(0, content.byteLength - suffixLength)
                end = content.byteLength - 1
              }
              endBody(206, { ...baseHeaders, 'content-range': `bytes ${start}-${end}/${content.byteLength}`, 'content-length': String(end - start + 1) }, content.subarray(start, end + 1))
              return
            }
            endBody(200, baseHeaders, content)
            return
          }
          break
        }
        case 'ideas': {
          if (id !== undefined && method === 'GET' && sub === undefined) {
            ok(res, kernel.getIdea(id))
            return
          }
          if (id !== undefined && sub === 'novelty' && method === 'POST') {
            const input = z.object({
              queries: z.array(z.string()),
              result: z.enum(['no_direct_match_found', 'overlap_found', 'inconclusive']),
              overlap_papers: z.array(z.string()).optional(),
              unresolved_risk: z.enum(['low', 'medium', 'high']).optional(),
            }).parse(body)
            ok(res, kernel.updateIdeaNovelty(id, {
              queries: input.queries,
              result: input.result,
              overlap_papers: input.overlap_papers ?? [],
              unresolved_risk: input.unresolved_risk ?? 'medium',
              audited_at: new Date().toISOString(),
            }))
            return
          }
          break
        }
        case 'jobs': {
          if (id !== undefined && sub === undefined && method === 'GET') {
            ok(res, kernel.getJob(id))
            return
          }
          if (id !== undefined && sub === 'status' && method === 'POST') {
            const input = jobCompleteSchema.parse(body)
            ok(res, kernel.completeJob({
              job_id: id, ...input,
              lease_generation: input.lease_generation ?? null,
              lease_token: input.lease_token ?? null,
            }))
            return
          }
          if (id !== undefined && sub === 'heartbeat' && method === 'POST') {
            const input = z.object({
              owner: z.string().min(1),
              lease_generation: z.number().int().nonnegative().nullable().optional(),
              lease_token: z.string().nullable().optional(),
            }).parse(body)
            ok(res, kernel.heartbeatJob(id, input.owner, input.lease_generation ?? null, input.lease_token ?? null))
            return
          }
          if (id !== undefined && sub === 'cancel' && method === 'POST') {
            const input = z.object({ actor: z.string().min(1), reason: z.string().optional() }).parse(body)
            ok(res, kernel.cancelJob(id, input.actor, input.reason))
            return
          }
          if (id !== undefined && sub === 'terminal' && method === 'GET') {
            void handleTerminalSse(req, res, kernel, id, url)
            return
          }
          if (id !== undefined && sub === 'terminal-frames' && method === 'POST') {
            const input = terminalFramesSchema.parse(body)
            // §4 P0 (TERM-01): lease owner/token travel via the
            // x-lease-owner/x-lease-token headers (runner client) or the body
            // fallback; the kernel exact-matches them against the job's
            // current lease when provided — a wrong owner/token is 409
            // lease_stale. The runner gateway ALWAYS sends both, so every
            // frame it produces is owner/token-fenced.
            const owner = typeof req.headers['x-lease-owner'] === 'string' && req.headers['x-lease-owner'] !== ''
              ? req.headers['x-lease-owner']
              : input.owner
            const leaseToken = typeof req.headers['x-lease-token'] === 'string' && req.headers['x-lease-token'] !== ''
              ? req.headers['x-lease-token']
              : input.lease_token ?? undefined
            ok(res, kernel.appendTerminalFrames({
              jobId: id,
              runId: input.run_id,
              frames: input.frames.map(f => ({
                seq: f.seq,
                stream_seq: f.stream_seq ?? null,
                channel: f.channel ?? null,
                text: f.text ?? null,
                byte_offset: f.byte_offset ?? null,
                byte_length: f.byte_length ?? null,
                frame_kind: f.frame_kind,
                payload_json: f.payload_json,
                lease_generation: f.lease_generation,
              })),
              owner,
              lease_token: leaseToken,
              maxLogBytes: input.max_log_bytes,
            }))
            return
          }
          break
        }
        case 'claims': {
          if (method === 'POST' && id === 'verify') {
            const input = claimVerifySchema.parse(body)
            ok(res, kernel.verifyClaim(input))
            return
          }
          break
        }
        case 'documents': {
          // TeX workspace (api-contracts.md §11, execution-runtime.md §12).
          if (id !== undefined && sub === 'tree' && method === 'GET') {
            ok(res, kernel.texTree(id))
            return
          }
          if (id !== undefined && sub === 'file' && method === 'GET') {
            const path = url.searchParams.get('path')
            if (path === null) throw new KernelError(422, 'missing_path', '?path= is required')
            ok(res, kernel.texReadFile(id, path))
            return
          }
          if (id !== undefined && sub === 'file' && method === 'PUT') {
            // expected_version is the CAS guard: undefined = unchecked write,
            // 0 = create-if-absent (the UI "new file" path sends 0; the file
            // must NOT already exist), N>0 = must match the stored version.
            // 0 must be accepted here — a positive-only schema would 422 the
            // create-if-absent call (acceptance-tests.md §7 ui-new-file).
            const input = z.object({
              path: z.string().min(1),
              content: z.string(),
              expected_version: z.number().int().nonnegative().optional(),
            }).parse(body)
            // TEX-SAVE: correlate the tex.file.saved outbox event with the
            // request id (x-request-id) and, when present, the forwarded
            // BFF session (x-principal-session) — same convention as the
            // gate-decision route below.
            const forwardedSession = req.headers['x-principal-session']
            const sessionId = typeof forwardedSession === 'string' && forwardedSession !== '' ? forwardedSession : undefined
            ok(res, kernel.texWriteFile(id, input.path, input.content, input.expected_version, {
              request_id: currentRequestId,
              session_id: sessionId,
            }))
            return
          }
          if (id !== undefined && sub === 'file' && method === 'DELETE') {
            const path = url.searchParams.get('path')
            if (path === null) throw new KernelError(422, 'missing_path', '?path= is required')
            // Same CAS semantics as PUT: 0 is a legal value (never matches a
            // stored version >= 1 → 409), so it must survive the query parse.
            const raw = url.searchParams.get('expected_version')
            const expected = raw === null || raw === '' ? undefined : Number(raw)
            if (expected !== undefined && (!Number.isInteger(expected) || expected < 0)) {
              throw new KernelError(422, 'invalid_expected_version', 'expected_version must be a non-negative integer')
            }
            kernel.texDeleteFile(id, path, expected)
            ok(res, { ok: true })
            return
          }
          if (id !== undefined && sub === 'moves' && method === 'POST') {
            // expected_version = CAS guard on the source file: 0 is accepted
            // by the schema but never matches a stored version (>= 1), so it
            // answers 409 — reload before moving (acceptance-tests.md §7).
            const input = z.object({
              from_path: z.string().min(1),
              to_path: z.string().min(1),
              expected_version: z.number().int().nonnegative().optional(),
            }).parse(body)
            kernel.texMoveFile(id, input.from_path, input.to_path, input.expected_version)
            ok(res, { ok: true })
            return
          }
          if (id !== undefined && sub === 'history' && method === 'GET') {
            ok(res, kernel.texHistory(id))
            return
          }
          if (id !== undefined && sub === 'snapshots' && method === 'POST') {
            const input = z.object({ expected_revision: z.number().int().positive().optional() }).parse(body)
            ok(res, kernel.texSnapshot(id, input.expected_revision))
            return
          }
          if (id !== undefined && sub === 'snapshot-files' && method === 'GET') {
            // TEX-01 (§4 row 95): frozen, revision-scoped build bytes — the
            // Runner materializes latex-compile input from this route, never
            // from the current file (which may have moved on since freeze).
            const revisionRaw = url.searchParams.get('revision')
            const path = url.searchParams.get('path')
            if (revisionRaw === null || path === null) {
              throw new KernelError(422, 'missing_params', '?revision=&path= are required')
            }
            const revision = Number(revisionRaw)
            if (!Number.isInteger(revision) || revision <= 0) {
              throw new KernelError(422, 'invalid_revision', 'revision must be a positive integer')
            }
            const file = kernel.texSnapshotFile(id, revision, path)
            if (file === null) {
              throw new KernelError(404, 'snapshot_file_not_found',
                `tex snapshot file ${path} not found at revision ${revision} (document ${id})`)
            }
            ok(res, file)
            return
          }
          if (id !== undefined && sub === 'builds' && subId === undefined && method === 'GET') {
            ok(res, kernel.texListBuilds(id))
            return
          }
          if (id !== undefined && sub === 'builds' && subId === undefined && method === 'POST') {
            const input = z.object({
              expected_document_revision: z.number().int().positive(),
              root_file: z.string().optional(),
              engine: z.string().optional(),
              max_passes: z.number().int().positive().optional(),
              idempotency_key: z.string().optional(),
              image_digest: z.string().optional(),
            }).parse(body)
            // §4 P0 (RUN-02/TEX-02): the build engine is a fixed enum —
            // reject anything outside the whitelist before it can be spliced
            // into the container build script (422 engine_invalid).
            const engine = input.engine ?? 'pdflatex'
            if (!TEX_ENGINES.includes(engine)) {
              throw new KernelError(422, 'engine_invalid',
                `latex-compile engine '${engine}' is not in the fixed engine whitelist (${TEX_ENGINES.join('/')})`)
            }
            // Freeze the workspace manifest, then submit the latex-compile job.
            const snap = kernel.texSnapshot(id, input.expected_document_revision)
            const tree = kernel.texTree(id)
            const rootFile = input.root_file ?? tree.document.root_file
            const job = kernel.submitJob({
              project_id: tree.document.project_id,
              idempotency_key: input.idempotency_key ?? `latex:${id}:${snap.revision}:${engine}`,
              kind: 'latex-compile',
              command: [engine, '-interaction=nonstopmode', '-halt-on-error', '-file-line-error', '-recorder', '-no-shell-escape', rootFile],
              payload: {
                tex_document_id: id,
                tex_revision: snap.revision,
                tex_snapshot: snap.manifest,
                // The runner builds with payload.engine — it MUST see the
                // validated engine so command[0] and the actual build agree.
                engine,
                image_digest: input.image_digest ?? '',
              },
            })
            const build = kernel.texCreateBuild(id, snap.revision, rootFile, job.job_id)
            // §12.1 (TEX-03): the authoritative Compile supersedes every
            // non-terminal preview (queued → cancelled, running →
            // superseded) — previews never block or replace the authority.
            kernel.texSupersedePreviews(id, build.build_id)
            send(res, 201, { build, job })
            return
          }
          if (id !== undefined && sub === 'builds' && subId !== undefined && method === 'GET') {
            ok(res, kernel.texGetBuild(subId))
            return
          }
          if (id !== undefined && sub === 'preview-builds' && subId === undefined && method === 'POST') {
            // §12.1 (TEX-03): save-success hook — the caller (UI/BFF) invokes
            // this after a successful save; the kernel owns the debounce
            // timer and the durable pending request, so preview state is
            // re-projectable after reconnects/restarts.
            const input = z.object({
              debounce_ms: z.number().int().positive().optional(),
              root_file: z.string().optional(),
              engine: z.string().optional(),
            }).parse(body)
            const pending = kernel.texRequestPreview(id, {
              debounce_ms: input.debounce_ms,
              root_file: input.root_file,
              engine: input.engine,
            })
            ok(res, { pending })
            return
          }
          if (id !== undefined && sub === 'preview-builds' && subId === undefined && method === 'GET') {
            // §12.1 (TEX-03): projection for UI reconnects — pending debounce
            // state plus preview builds, each carrying preview=true and the
            // stale flag (build.revision < document.revision).
            ok(res, kernel.texPreviewStatus(id))
            return
          }
          break
        }
        case 'pty': {
          // PTY-01 (execution-runtime.md §6.1, api-contracts.md §18) —
          // Interactive Terminal. Wire shape: the client never sends
          // endpoint/SSH credential/Docker socket/host path — only opaque
          // profile/target ids, a preset and a relative cwd (pty-safe-open).
          // The REAL tty allocation is the adapter (LocalPtyAdapter in the
          // kernel bin / LocalDockerPty / RemoteRunnerPty, all behind the
          // same PtyAdapter contract). While no adapter is registered the
          // HTTP open route stays 501 and no inert session row is created
          // (an adapter-less session would mislead the UI).
          if (id === 'sessions') {
            if (sub === undefined && method === 'POST') {
              // Open: schema + semantics validation first, then the adapter
              // gate, then the authenticated principal + project membership.
              const input = PtyOpenRequest.parse(body)
              kernel.getProject(input.project_id) // 404 project_not_found
              kernel.resolveWorkspace(input.workspace_id) // 404 workspace_not_found
              if (!kernel.hasPtyAdapter()) {
                send(res, 501, {
                  error: errorEnvelope('pty_adapter_not_implemented',
                    'no PTY adapter is registered (LocalPtyAdapter/RemoteRunnerPty pending) — the interface layer state machine is exercised via the kernel API'),
                })
                return
              }
              // PTY-01 (API-01): the BFF resolves the authenticated operator
              // and injects x-principal-id (never trusted from the client);
              // the kernel fails closed without it and pins it on the row.
              const principalId = typeof req.headers['x-principal-id'] === 'string' && req.headers['x-principal-id'] !== ''
                ? req.headers['x-principal-id']
                : ''
              if (principalId === '') {
                send(res, 422, {
                  error: errorEnvelope('principal_required',
                    'pty open requires an authenticated principal (x-principal-id); the BFF injects it from the operator session'),
                })
                return
              }
              // Project membership (mirrors handleV2 memberOr404): a
              // non-member cannot open a terminal in the project.
              if (!kernel.listProjectMembers(input.project_id).some(m => m.principal_id === principalId)) {
                throw new KernelError(404, 'project_not_found', 'project not found or access denied')
              }
              const session = kernel.ptyOpen(input, { principal: { principal_id: principalId } })
              send(res, 201, session)
              return
            }
            if (sub !== undefined && subId === undefined && method === 'GET') {
              // Session state + lease summary (api-contracts.md §18 GET).
              // PTY-01 (hardening §5 P0-2): fail-closed principal + OWNER —
              // knowing a session id is not enough to read it; a foreign
              // session (even inside a member project) is 403, a missing
              // principal 422. No lease required for the read itself.
              if (requirePtyOwner(kernel, req, res, sub, { requireLease: false }) === null) return
              ok(res, kernel.ptyGet(sub))
              return
            }
            if (sub !== undefined && subId === 'control' && method === 'POST') {
              // Control with client_seq idempotency: 422 on schema failure,
              // 404 on unknown session, 409 on reorder/closed, 200 with
              // delivered=false while no adapter is attached. PTY-01
              // (hardening §5 P0-2): principal + OWNER + LEASE are ALL
              // mandatory — a missing x-principal-id is 422
              // principal_required, a non-owner 403 pty_principal_mismatch,
              // a missing x-pty-lease 403 lease_required, a wrong lease 403
              // lease_invalid. "Header missing = pass" is never accepted.
              const input = PtyControlRequest.parse(body)
              if (requirePtyOwner(kernel, req, res, sub, { requireLease: true }) === null) return
              const result = kernel.ptyControl(sub, input)
              ok(res, result)
              return
            }
            if (sub !== undefined && subId === 'frames' && subSubId === 'stream' && method === 'GET') {
              // PTY frame SSE stream (api-contracts.md §22): replay + live
              // tail with the same owner+lease validation as the polling
              // frames route below (checked INSIDE the handler before any
              // SSE byte). Registered BEFORE the polling check so
              // .../frames/stream never falls through to the JSON page.
              void handlePtyFramesSse(req, res, kernel, sub, url)
              return
            }
            if (sub !== undefined && subId === 'frames' && method === 'GET') {
              // Output replay with server seq / gap / retention. PTY-01
              // (hardening §5 P0-2): same fail-closed principal + owner as
              // the session read; the lease is OPTIONAL here but when
              // present it must be valid (never "wrong lease = pass").
              const raw = url.searchParams.get('after_seq')
              const afterSeq = raw === null ? 0 : Number(raw)
              if (!Number.isInteger(afterSeq) || afterSeq < 0) {
                throw new KernelError(422, 'pty_after_seq_invalid', 'after_seq must be a non-negative integer')
              }
              if (requirePtyOwner(kernel, req, res, sub, { requireLease: false }) === null) return
              ok(res, kernel.ptyFrames(sub, afterSeq))
              return
            }
          }
          break
        }
        case 'events': {
          if (method === 'GET' && id === undefined) {
            const projectId = url.searchParams.get('project_id') ?? undefined
            ok(res, kernel.listEvents(projectId))
            return
          }
          break
        }
        case 'session-links': {
          if (id !== undefined && method === 'GET') {
            ok(res, kernel.getProjectBySession(id))
            return
          }
          break
        }
        case 'jobs-claim': {
          if (method === 'POST' && id !== undefined) {
            const input = z.object({
              owner: z.string().min(1),
              lease_ttl_seconds: z.number().int().positive().optional(),
              limit: z.number().int().positive().max(64).optional(),
              runner_target_kinds: z.array(z.enum(['local-process', 'local-docker', 'remote-ssh'])).max(3).optional(),
              runner_target_ids: z.array(z.string().min(1).max(120)).max(64).optional(),
              include_unpinned: z.boolean().optional(),
            }).parse(body)
            ok(res, kernel.claimJobs(input.owner, input.lease_ttl_seconds, input.limit, {
              runner_target_kinds: input.runner_target_kinds,
              runner_target_ids: input.runner_target_ids,
              include_unpinned: input.include_unpinned,
            }))
            return
          }
          break
        }
        case 'runner-keys': {
          if (method === 'POST' && id === undefined) {
            const input = runnerKeySchema.parse(body)
            send(res, 201, kernel.registerRunnerKey(input))
            return
          }
          if (method === 'GET' && id === undefined) {
            ok(res, kernel.listRunnerKeys())
            return
          }
          break
        }
        case 'recover': {
          if (method === 'POST' && id === 'leases') {
            ok(res, { recovered: kernel.recoverExpiredLeases() })
            return
          }
          break
        }
        default:
          break
      }
      send(res, 404, { error: { code: 'not_found', message: `no route ${method} ${url.pathname}` } })
    } catch (error) {
      fail(res, error)
    }
  }).catch((error: unknown) => fail(res, error))
}

/**
 * Terminal SSE (api-contracts.md §9): text/event-stream replay + live
 * tail of a run's terminal frames. Polls the kernel's frame store with a
 * bounded cursor; gap frames are emitted before evicted sequences; comment
 * frames act as heartbeats; the exit frame ends the stream (replayable via
 * after_seq on reconnect).
 */
function handleTerminalSse(
  req: IncomingMessage,
  res: ServerResponse,
  kernel: ResearchKernel,
  jobId: string,
  url: URL,
): void {
  // log-authz (acceptance-tests.md §5): when the caller pins a project with
  // ?project_id=, the job must belong to THAT project — a cross-project read
  // answers 404 (no enumeration). Callers without a project_id (legacy direct
  // kernel access; the BFF enforces membership itself) keep the job-scoped
  // behavior. Synchronous throw -> the router's fail() sends the 404 JSON.
  const projectId = url.searchParams.get('project_id')
  if (projectId !== null && projectId !== '') {
    const job = kernel.getJob(jobId)
    if (job.project_id !== projectId) {
      throw new KernelError(404, 'project_not_found', 'project not found or access denied')
    }
  }
  const runId = url.searchParams.get('run_id')
    ?? kernel.resolveTerminalRun(jobId)
    ?? jobId
  const afterSeq = Math.max(0, Number(url.searchParams.get('after_seq') ?? 0) || 0)
  const writeEvent = (event: string, data: unknown): void => {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
  }
  // Initial snapshot before the headers: a missing job propagates to the
  // router's error handler (404 JSON) instead of half-open SSE.
  const initial = kernel.listTerminalFrames(jobId, runId, 0)
  const initialLastSeq = initial.frames.length > 0 ? initial.frames[initial.frames.length - 1]!.seq : 0
  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-store',
    'x-accel-buffering': 'no',
    connection: 'keep-alive',
  })
  writeEvent('subscribed', {
    run_id: runId,
    last_seq: initialLastSeq,
    retained_from_seq: initial.retention.retained_from_seq,
  })
  let cursor = afterSeq
  let gapSent = false
  let heartbeat: NodeJS.Timeout | undefined
  let poll: NodeJS.Timeout | undefined
  let closed = false
  const cleanup = (): void => {
    if (closed) return
    closed = true
    if (heartbeat !== undefined) clearInterval(heartbeat)
    if (poll !== undefined) clearInterval(poll)
  }
  req.on('close', cleanup)
  req.on('error', cleanup)
  res.on('error', cleanup)

  const sendBatch = (): void => {
    if (closed) return
    let data
    try {
      data = kernel.listTerminalFrames(jobId, runId, cursor)
    } catch {
      cleanup()
      res.end()
      return
    }
    const retention = data.retention
    // Gap: requested sequences were already evicted.
    if (!gapSent && cursor + 1 < retention.retained_from_seq) {
      writeEvent('gap', {
        kind: 'gap',
        job_id: jobId,
        run_id: runId,
        seq: cursor + 1,
        requested_after: cursor,
        retained_from_seq: retention.retained_from_seq,
        dropped_bytes: retention.dropped_bytes,
        lease_generation: 0,
        time: new Date().toISOString(),
      })
      gapSent = true
      cursor = retention.retained_from_seq - 1
    }
    for (const frame of data.frames) {
      const base = {
        kind: frame.frame_kind,
        job_id: jobId,
        run_id: runId,
        seq: frame.seq,
        lease_generation: frame.lease_generation,
        time: frame.created_at,
      }
      if (frame.frame_kind === 'chunk') {
        writeEvent('chunk', {
          ...base,
          stream_seq: frame.stream_seq,
          channel: frame.channel,
          text: frame.text,
          byte_offset: frame.byte_offset,
          byte_length: frame.byte_length,
        })
      } else if (frame.frame_kind === 'exit') {
        // The exit frame carries the terminal-side facts; business terminal
        // state remains authoritative in the job record.
        let exitPayload: Record<string, unknown> = {}
        try { exitPayload = JSON.parse(frame.payload_json) as Record<string, unknown> } catch { /* opaque */ }
        writeEvent('exit', {
          ...base,
          exit_code: exitPayload.exit_code ?? null,
          signal: exitPayload.signal ?? null,
          cancelled: exitPayload.cancelled ?? false,
          timed_out: exitPayload.timed_out ?? false,
          truncated: retention.truncated,
          total_bytes: retention.total_bytes,
          dropped_bytes: retention.dropped_bytes,
        })
      } else {
        writeEvent(frame.frame_kind, base)
      }
      cursor = frame.seq
      if (frame.frame_kind === 'exit') {
        // Exit is authoritative; the client replays via after_seq if needed.
        cleanup()
        res.end()
        return
      }
    }
    void data
  }

  // Initial snapshot + live tail.
  sendBatch()
  poll = setInterval(sendBatch, 500)
  heartbeat = setInterval(() => { if (!closed) res.write(`: heartbeat ${Date.now()}\n\n`) }, 15000)
}

/**
 * SSE real-time stream timing knobs (acceptance-tests.md §21 "SSE 实时流替代
 * 轮询"): the three stream endpoints below poll their EXISTING polling data
 * sources (pty frames / workspace listSince / trajectory projection) with a
 * bounded cursor every `pollMs` and push deltas — deliberately the same
 * data source the polling endpoints read, so stream and poll can never
 * diverge. `heartbeatMs` is the named-heartbeat interval. Unit tests shrink
 * both knobs (module-level state, reset after each test).
 */
export const sseStreamTiming = { pollMs: 200, heartbeatMs: 15000 }

/**
 * PTY frame stream (api-contracts.md §22, PTY-01): text/event-stream replay
 * + live tail of a session's output frames, mirroring the terminal SSE
 * pattern (handleTerminalSse). Auth is IDENTICAL to the polling frames
 * route (requirePtyOwner: missing principal → 422, non-owner → 403,
 * unknown session → 404; an OPTIONAL lease must be valid when present).
 * Events: subscribed / frame (server_seq monotonic) / gap (retention
 * eviction) / exit (ends the stream, replayable via after_seq) / heartbeat.
 * Data comes from kernel.ptyFrames — the same store the polling
 * GET /v1/pty/sessions/{id}/frames reads.
 */
function handlePtyFramesSse(
  req: IncomingMessage,
  res: ServerResponse,
  kernel: ResearchKernel,
  sessionId: string,
  url: URL,
): void {
  // Same wire validation as the polling frames route: after_seq must be a
  // non-negative integer (422 pty_after_seq_invalid, thrown → router fail()).
  const raw = url.searchParams.get('after_seq')
  const afterSeq = raw === null ? 0 : Number(raw)
  if (!Number.isInteger(afterSeq) || afterSeq < 0) {
    throw new KernelError(422, 'pty_after_seq_invalid', 'after_seq must be a non-negative integer')
  }
  // Fail-closed owner check BEFORE any SSE byte: requirePtyOwner writes the
  // JSON error itself (422/403/404) and returns null on rejection.
  if (requirePtyOwner(kernel, req, res, sessionId, { requireLease: false }) === null) return
  const writeEvent = (event: string, data: unknown): void => {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
  }
  // Initial snapshot before the headers: an unknown session propagates as a
  // JSON 404 (pty_session_not_found) instead of half-open SSE.
  const initial = kernel.ptyFrames(sessionId, 0)
  const initialLastSeq = initial.frames.length > 0 ? initial.frames[initial.frames.length - 1]!.server_seq : 0
  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-store',
    'x-accel-buffering': 'no',
    connection: 'keep-alive',
  })
  writeEvent('subscribed', {
    session_id: sessionId,
    last_seq: initialLastSeq,
    retained_from_seq: initial.retained_from_seq,
  })
  let cursor = afterSeq
  let heartbeat: NodeJS.Timeout | undefined
  let poll: NodeJS.Timeout | undefined
  let closed = false
  const cleanup = (): void => {
    if (closed) return
    closed = true
    if (heartbeat !== undefined) clearInterval(heartbeat)
    if (poll !== undefined) clearInterval(poll)
  }
  req.on('close', cleanup)
  req.on('error', cleanup)
  res.on('error', cleanup)

  const sendBatch = (): void => {
    if (closed) return
    let data
    try {
      data = kernel.ptyFrames(sessionId, cursor)
    } catch {
      cleanup()
      res.end()
      return
    }
    for (const frame of data.frames) {
      const seq = frame.server_seq
      const time = frame.created_at
      if (frame.type === 'gap') {
        // Retention evicted seqs the client missed: the store synthesizes a
        // gap frame; surface it as the gap event. seq = first DROPPED seq
        // (same convention as the terminal SSE gap event), the cursor still
        // advances past the retained window so no evicted seq is re-asked.
        writeEvent('gap', {
          session_id: sessionId,
          seq: frame.payload.gap_from_seq,
          gap_from_seq: frame.payload.gap_from_seq,
          gap_to_seq: frame.payload.gap_to_seq,
          dropped_bytes: frame.payload.dropped_bytes,
          dropped_frames: frame.payload.dropped_frames,
          retained_from_seq: data.retained_from_seq,
          time,
        })
        cursor = Math.max(cursor, seq)
      } else if (frame.type === 'exit') {
        writeEvent('exit', {
          session_id: sessionId,
          seq,
          exit_code: frame.payload.exit_code ?? null,
          signal: frame.payload.signal ?? null,
          time,
        })
        // Exit is authoritative; the client replays via after_seq if needed.
        cleanup()
        res.end()
        return
      } else {
        writeEvent('frame', {
          session_id: sessionId,
          seq,
          type: frame.type,
          payload: frame.payload,
          time,
        })
        cursor = seq
      }
    }
    void data
  }

  // Initial snapshot + live tail (poll the frames store for new seqs).
  sendBatch()
  poll = setInterval(sendBatch, sseStreamTiming.pollMs)
  heartbeat = setInterval(() => {
    if (!closed) writeEvent('heartbeat', { time: new Date().toISOString() })
  }, sseStreamTiming.heartbeatMs)
}

/**
 * Workspace watch stream (api-contracts.md §22, WORK-01): text/event-stream
 * replay + live tail of workspace mutations — change nodes + delete
 * tombstones + revision advance. Auth mirrors the project-scoped reads:
 * authenticated principal + project membership fail-closed
 * (requireProjectMember: missing principal → 422, non-member → 404), and
 * the workspace is pinned to the PATH project (cross-project → 404
 * workspace_not_found). Data comes from kernel.workspaceListSince — the
 * same watch feed the polling GET .../nodes?after_revision= reads; the
 * cursor advances to the workspace's current revision after each batch, so
 * reconnects with after_revision resume without duplicates. Open-ended
 * stream: no exit event; the client closes or reconnects via after_revision.
 */
function handleWorkspaceWatchSse(
  req: IncomingMessage,
  res: ServerResponse,
  kernel: ResearchKernel,
  projectId: string,
  workspaceId: string,
  url: URL,
): void {
  // Same wire validation as the polling watch feed: after_revision must be
  // a non-negative integer (422 invalid_revision, thrown → router fail()).
  const raw = url.searchParams.get('after_revision')
  const since = raw === null ? 0 : Number(raw)
  if (!Number.isInteger(since) || since < 0) {
    throw new KernelError(422, 'invalid_revision', 'after_revision must be a non-negative integer')
  }
  // Fail-closed principal + membership BEFORE any SSE byte.
  if (requireProjectMember(kernel, req, res, projectId) === null) return
  // Path-project binding: cross-project workspace → 404 (router fail()).
  kernel.assertWorkspaceInProject(workspaceId, projectId)
  const writeEvent = (event: string, data: unknown): void => {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
  }
  // Initial snapshot before the headers: an unknown workspace propagates as
  // a JSON 404 (workspace_not_found) instead of half-open SSE.
  const initial = kernel.workspaceListSince(workspaceId, 0)
  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-store',
    'x-accel-buffering': 'no',
    connection: 'keep-alive',
  })
  writeEvent('subscribed', {
    workspace_id: workspaceId,
    project_id: projectId,
    revision: initial.info.revision,
    after_revision: since,
  })
  let cursor = since
  let heartbeat: NodeJS.Timeout | undefined
  let poll: NodeJS.Timeout | undefined
  let closed = false
  const cleanup = (): void => {
    if (closed) return
    closed = true
    if (heartbeat !== undefined) clearInterval(heartbeat)
    if (poll !== undefined) clearInterval(poll)
  }
  req.on('close', cleanup)
  req.on('error', cleanup)
  res.on('error', cleanup)

  const sendBatch = (): void => {
    if (closed) return
    let data
    try {
      data = kernel.workspaceListSince(workspaceId, cursor)
    } catch {
      cleanup()
      res.end()
      return
    }
    if (data.nodes.length > 0 || data.deleted.length > 0 || data.info.revision > cursor) {
      const revision = data.info.revision
      for (const node of data.nodes) {
        writeEvent('change', { workspace_id: workspaceId, revision, node })
      }
      for (const path of data.deleted) {
        writeEvent('delete', { workspace_id: workspaceId, revision, path })
      }
      // Revision advance: the cursor always lands on the CURRENT workspace
      // revision, so a reconnect with after_revision resumes without
      // duplicates (intermediate revisions collapse — listSince projects
      // current node state per touched path).
      cursor = revision
    }
    void data
  }

  // Initial snapshot + live tail (poll the op-ledger watch feed).
  sendBatch()
  poll = setInterval(sendBatch, sseStreamTiming.pollMs)
  heartbeat = setInterval(() => {
    if (!closed) writeEvent('heartbeat', { time: new Date().toISOString() })
  }, sseStreamTiming.heartbeatMs)
}

/**
 * Trajectory incremental stream (api-contracts.md §22, TRAJ-01):
 * text/event-stream replay + live tail of the redacted trajectory
 * projection. Keyset cursor (after_seq, after_event_id) with the SAME
 * (event_seq, event_id) ordering as the polling GET .../trajectory — the
 * stream calls kernel.projectTrajectory, so redaction is guaranteed by the
 * projection and the lane filter (research|session) matches the polling
 * endpoint. Auth: principal + project membership fail-closed (422/404).
 * Events: subscribed / entry (redacted TrajectoryEntry) / heartbeat.
 * Open-ended stream; reconnects resume via after_seq (+ after_event_id).
 */
function handleTrajectorySse(
  req: IncomingMessage,
  res: ServerResponse,
  kernel: ResearchKernel,
  projectId: string,
  url: URL,
): void {
  // Fail-closed principal + membership BEFORE any SSE byte.
  if (requireProjectMember(kernel, req, res, projectId) === null) return
  const q = url.searchParams
  const afterSeq = parseSeqParam(q.get('after_seq')) ?? 0
  const afterEventId = q.get('after_event_id') ?? ''
  const lane = parseLaneParam(q.get('lane')) ?? null
  const writeEvent = (event: string, data: unknown): void => {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
  }
  // Initial snapshot before the headers: an unknown project propagates as a
  // JSON 404 (project_not_found) instead of half-open SSE.
  const initial = kernel.projectTrajectory(projectId, { after_seq: 0, limit: 1, lane: lane ?? undefined })
  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-store',
    'x-accel-buffering': 'no',
    connection: 'keep-alive',
  })
  writeEvent('subscribed', {
    project_id: projectId,
    lane,
    after_seq: afterSeq,
    after_event_id: afterEventId,
  })
  let cursorSeq = afterSeq
  let cursorEventId = afterEventId
  let heartbeat: NodeJS.Timeout | undefined
  let poll: NodeJS.Timeout | undefined
  let closed = false
  const cleanup = (): void => {
    if (closed) return
    closed = true
    if (heartbeat !== undefined) clearInterval(heartbeat)
    if (poll !== undefined) clearInterval(poll)
  }
  req.on('close', cleanup)
  req.on('error', cleanup)
  res.on('error', cleanup)

  const sendBatch = (): void => {
    if (closed) return
    let page
    try {
      page = kernel.projectTrajectory(projectId, {
        after_seq: cursorSeq,
        after_event_id: cursorEventId,
        limit: 200,
        lane: lane ?? undefined,
      })
    } catch {
      cleanup()
      res.end()
      return
    }
    for (const entry of page.entries) {
      writeEvent('entry', entry)
    }
    if (page.entries.length > 0 && page.next_after_seq !== null) {
      // Keyset advance mirrors the polling cursor semantics: (event_seq,
      // event_id) of the LAST entry — equal seqs across buckets are resumed
      // by event_id, so no duplicate and no missing on reconnect.
      cursorSeq = page.next_after_seq
      cursorEventId = page.next_after_event_id ?? cursorEventId
    }
    void page
  }

  // Initial snapshot + live tail (poll the outbox projection).
  sendBatch()
  poll = setInterval(sendBatch, sseStreamTiming.pollMs)
  heartbeat = setInterval(() => {
    if (!closed) writeEvent('heartbeat', { time: new Date().toISOString() })
  }, sseStreamTiming.heartbeatMs)
}

/** Start the kernel API server; returns the listening server. */
function canonicalMethodologyHash(value: unknown): `sha256:${string}` {
  const canonical = (item: unknown): string => {
    if (item === null || typeof item === 'string' || typeof item === 'boolean') return JSON.stringify(item)
    if (typeof item === 'number' && Number.isFinite(item)) return JSON.stringify(item)
    if (Array.isArray(item)) return `[${item.map(canonical).join(',')}]`
    if (typeof item === 'object') {
      const record = item as Record<string, unknown>
      return `{${Object.keys(record).filter(key => record[key] !== undefined).sort()
        .map(key => `${JSON.stringify(key)}:${canonical(record[key])}`).join(',')}}`
    }
    throw new TypeError('methodology hash accepts JSON values only')
  }
  return `sha256:${createHash('sha256').update(canonical(value), 'utf8').digest('hex')}`
}

function currentAssuranceInputHashes(
  kernel: ResearchKernel,
  projectId: string,
  refs: readonly string[],
): Record<string, `sha256:${string}`> {
  const hashes: Record<string, `sha256:${string}`> = {}
  for (const ref of refs) {
    try {
      const separator = ref.indexOf(':')
      const kind = separator === -1 ? '' : ref.slice(0, separator)
      const id = separator === -1 ? ref : ref.slice(separator + 1)
      if (kind === 'artifact' || kind === 'bundle' || kind === 'data' || ref.startsWith('sha256:')) {
        const artifact = kernel.getArtifact(projectId, ref.startsWith('sha256:') ? ref : id)
        hashes[ref] = `sha256:${artifact.sha256}`
      } else if (kind === 'tex') {
        const document = kernel.tex.getDocument(id)
        if (document.project_id !== projectId) continue
        hashes[ref] = writingTexSha256(kernel.tex.tree(id).files)
      } else if (kind === 'claim') {
        const claim = kernel.getClaim(id)
        if (claim.project_id !== projectId) continue
        hashes[ref] = canonicalMethodologyHash(claim)
      } else if (kind === 'claim-evidence') {
        if (id !== projectId) continue
        const accepted = new Set(kernel.listAcceptedEvidence(projectId).map(item => item.evidence_id))
        hashes[ref] = writingClaimEvidenceSha256(kernel.listClaims(projectId).map(claim => ({
          claim_ref: claim.claim_id,
          accepted_evidence_refs: claim.evidence.evidence_ids.filter(evidenceId => accepted.has(evidenceId)),
        })))
      } else if (kind === 'evidence') {
        const evidence = kernel.listEvidence(projectId).find(item => item.evidence_id === id)
        if (evidence !== undefined) hashes[ref] = canonicalMethodologyHash(evidence)
      } else if (kind === 'protocol') {
        const protocol = kernel.methodology.getProtocolRevision(projectId, id).record
        if (protocol.canonical_hash !== undefined) hashes[ref] = protocol.canonical_hash as `sha256:${string}`
      } else if (kind === 'contract') {
        const contract = kernel.getContract(id)
        if (contract.project_id !== projectId) continue
        hashes[ref] = canonicalMethodologyHash(contract)
      } else if (kind === 'code') {
        const snapshot = kernel.getCodeSnapshot(id)
        if (snapshot.project_id !== projectId) continue
        hashes[ref] = `sha256:${snapshot.sha256}`
      } else if (kind === 'environment') {
        hashes[ref] = runnerTargetConfigHash(kernel.runnerTargets.get(id)) as `sha256:${string}`
      }
    } catch {
      // An absent/unresolvable ref is intentionally omitted. verifyAssurance
      // turns it into input_missing/stale instead of trusting an old pin.
    }
  }
  return hashes
}

function compactMethodologyProjection(kernel: ResearchKernel, projectId: string): Record<string, unknown> {
  const projectProjection = kernel.projectProjection(projectId)
  const project = projectProjection.project
  const nextActionRevision = projectProjection.next_actions_v2.find(action => action.state === 'ready')?.revision
    ?? projectProjection.next_actions_v2.find(action => action.state !== 'done')?.revision
    ?? project.revision
  const assurance = kernel.assurance.list(projectId)
  const protocols = kernel.methodology.listProtocolRevisions(projectId)
  const syntheses = kernel.methodology.listResearchSyntheses(projectId)
  const activations = kernel.methodology.listKnowledgeActivations(projectId)
  const outlines = kernel.methodology.listReverseOutlines(projectId)
  const findings = kernel.methodology.listReviewFindings(projectId)
  const runOutcomes = kernel.methodology.listResearchRunOutcomes(projectId)
  const methodTriads = kernel.writingReview.listMethodTriads(projectId)
  const sectionGuides = kernel.writingReview.listSectionGuides(projectId)
  const reviewerPanels = kernel.writingReview.listReviewerPanels(projectId)
  const patchProposals = kernel.writingReview.listPatchProposals(projectId)
  const patchApplications = kernel.writingReview.listPatchApplications(projectId)

  const currentAudits = new Map<string, (typeof assurance.audits)[number]>()
  for (const audit of assurance.audits) currentAudits.set(audit.audit.audit_kind, audit)
  const selectedAudits = [...currentAudits.values()]
  const latestAudit = selectedAudits.at(-1)
  const assuranceLevel = selectedAudits.some(item => item.audit.assurance_level === 'submission')
    ? 'submission' as const
    : 'draft' as const
  const assuranceProjection = kernel.assurance.project({
    project_id: projectId,
    level: assuranceLevel,
    required_audit_kinds: assuranceLevel === 'submission' ? [...AssuranceAuditKind.options] : [],
    current_input_hashes: currentAssuranceInputHashes(
      kernel,
      projectId,
      selectedAudits.flatMap(item => item.audit.input_pins.map(pin => pin.ref)),
    ),
  })
  const assuranceReasons = [...new Set([
    ...assuranceProjection.missing_audit_kinds.map(kind => `missing_${kind}`),
    ...assuranceProjection.audits.flatMap(audit => audit.reasons),
  ])]
  const assuranceSummary = latestAudit === undefined
    ? null
    : {
        level: assuranceProjection.level,
        ready: assuranceProjection.submission_ready,
        reason_codes: assuranceReasons,
      }

  const latestProtocol = protocols.records.at(-1)?.record
  const protocolSummary = latestProtocol === undefined
    ? null
    : {
        current_id: latestProtocol.protocol_id,
        revision: latestProtocol.revision,
        status: latestProtocol.status,
        intent: latestProtocol.intent,
      }
  const latestSynthesis = syntheses.records.at(-1)?.record
  const synthesisAssessment = latestSynthesis === undefined
    ? null
    : evaluateResearchMethodology({
        operation: 'synthesis_freshness',
        synthesis: latestSynthesis,
        current: {
          project_revision: project.revision,
          next_action_revision: nextActionRevision ?? project.revision,
          input_hash: latestSynthesis.input_hash,
        },
      })
  if (synthesisAssessment?.operation === 'synthesis_freshness') {
    kernel.methodologyTelemetry.synthesisFreshness({
      mode: kernel.rollout.projectPin(projectId).mode,
      fresh: synthesisAssessment.effective_status !== 'stale',
      stale_reasons: synthesisAssessment.stale_reasons,
    })
  }
  const synthesisSummary = latestSynthesis === undefined || synthesisAssessment?.operation !== 'synthesis_freshness'
    ? null
    : {
        current_id: latestSynthesis.synthesis_id,
        fresh: synthesisAssessment.effective_status !== 'stale',
        stale_reasons: synthesisAssessment.stale_reasons,
      }

  const deliveryItems = [...new Set(activations.records.map(item => item.record.request.session_id))]
    .flatMap(sessionId => kernel.methodology.resolveKnowledgeDelivery({
      project_id: projectId,
      session_id: sessionId,
      phase: project.status,
      next_action_revision: nextActionRevision,
      surface: 'scholar-chat',
    }).deliveries)
  const activeDeliveries = [...new Map(deliveryItems.map(item => [item.activation_id, item])).values()]
  const activeNames = [...new Set(activeDeliveries.map(item => item.package_name))]
  const knowledgeSummary = {
    active_count: activeDeliveries.length,
    package_names: activeNames,
    suppressed_count: Math.max(0, activations.records.length - activeDeliveries.length),
    status: activeDeliveries.length > 0 ? 'delivery-ready' : activations.records.length > 0 ? 'suppressed' : 'inactive',
  }
  const latestOutline = outlines.records.at(-1)?.record
  const blockingCount = findings.records.filter(item =>
    item.record.severity === 'blocking'
      && item.record.resolution_status !== 'resolved'
      && item.record.resolution_status !== 'dismissed',
  ).length
  let writingStale: boolean | null = null
  const writingReasons: string[] = []
  let currentBlockingCount = blockingCount
  if (latestOutline !== undefined) {
    try {
      const document = kernel.tex.getDocument(latestOutline.input_pin.document_id)
      if (document.project_id !== projectId) throw new Error('document_project_mismatch')
      const tree = kernel.tex.tree(document.document_id)
      const acceptedEvidence = new Set(kernel.listEvidence(projectId)
        .filter(evidence => (evidence as typeof evidence & { provenance_status?: string }).provenance_status === 'accepted')
        .map(evidence => evidence.evidence_id))
      const claimEvidence = kernel.listClaims(projectId).map(claim => ({
        claim_ref: claim.claim_id,
        accepted_evidence_refs: claim.evidence.evidence_ids.filter(id => acceptedEvidence.has(id)),
      }))
      const report = kernel.methodology.assessWriting({
        project_id: projectId,
        outline_id: latestOutline.outline_id,
        finding_ids: findings.records.map(item => item.record.finding_id),
        current_input: {
          project_id: projectId,
          document_id: document.document_id,
          document_revision: document.revision,
          tex_sha256: writingTexSha256(tree.files),
          claim_evidence_sha256: writingClaimEvidenceSha256(claimEvidence),
        },
        claim_evidence: claimEvidence,
      })
      writingStale = report.outline.status === 'stale'
      writingReasons.push(...report.outline.reasons)
      if (report.claim_evidence_gaps.length > 0) writingReasons.push('claim_evidence_gap')
      const freshFindingIds = new Set(report.findings
        .filter(finding => finding.status === 'fresh')
        .map(finding => finding.finding_id))
      currentBlockingCount = findings.records.filter(item =>
        freshFindingIds.has(item.record.finding_id)
          && item.record.severity === 'blocking'
          && item.record.resolution_status !== 'resolved'
          && item.record.resolution_status !== 'dismissed',
      ).length
    } catch {
      writingStale = true
      writingReasons.push('document_not_found')
      currentBlockingCount = 0
    }
  }
  const writingSummary = latestOutline === undefined
    ? null
    : {
        outline_id: latestOutline.outline_id,
        blocking_count: currentBlockingCount,
        stale: writingStale,
        reason_codes: writingReasons,
      }
  const researchGraph = buildResearchGraph({
    project_id: projectId,
    protocols: protocols.records.map(item => item.record),
    syntheses: syntheses.records.map(item => item.record),
    directions: kernel.methodology.listDirectionProposals(projectId).records.map(item => item.record),
    adoptions: kernel.methodology.listDirectionAdoptions(projectId).records.map(item => item.record),
    run_outcomes: runOutcomes.outcomes.map(item => item.outcome),
  })
  const topologySummary = {
    assurance_audit_count: assurance.audits.length,
    latest_audit_id: assurance.audits.at(-1)?.audit.audit_id ?? null,
    research_node_count: researchGraph.nodes.length,
    research_edge_count: researchGraph.edges.length,
  }
  const negativeFindingCount = runOutcomes.outcomes.filter(item => item.outcome.negative_finding !== null).length
  const claimProposalCount = runOutcomes.outcomes.filter(item => item.outcome.claim_proposal !== null).length
  const runSummary = {
    revision: runOutcomes.run_stream_revision,
    count: runOutcomes.outcomes.length,
    negative_finding_count: negativeFindingCount,
    claim_proposal_count: claimProposalCount,
    latest_run_ref: runOutcomes.outcomes.at(-1)?.outcome.run.run_ref ?? null,
  }
  const latestTriad = methodTriads.records.at(-1)?.record
  const latestGuide = sectionGuides.records.at(-1)?.record
  const latestPanel = reviewerPanels.records.at(-1)?.record
  const latestPatch = patchProposals.records.at(-1)?.record
  const latestApplication = patchApplications.records.at(-1)?.record
  const manuscriptSummary = {
    revision: kernel.writingReview.revision(projectId),
    method_triad: latestTriad === undefined ? null : {
      triad_id: latestTriad.triad.triad_id,
      status: latestTriad.diagnostic.status,
      gap_codes: latestTriad.diagnostic.gaps.map(gap => gap.code),
    },
    section_guide: latestGuide === undefined ? null : {
      activation_id: latestGuide.activation_id,
      section: latestGuide.section,
      state: latestGuide.state,
      missing_inputs: latestGuide.missing_inputs,
    },
    reviewer_panel: latestPanel === undefined ? null : {
      aggregate_id: latestPanel.aggregate_id,
      state: latestPanel.state,
      complete_roles: latestPanel.roles.filter(item => item.state === 'complete').map(item => item.role),
      missing_roles: latestPanel.roles.filter(item => item.state === 'missing').map(item => item.role),
    },
    patches: {
      proposal_count: patchProposals.records.length,
      application_count: patchApplications.records.length,
      latest_proposal_id: latestPatch?.proposal_id ?? null,
      latest_application_id: latestApplication?.application_id ?? null,
    },
  }

  const directionRecommendationKeys: Readonly<Record<string, string>> = {
    direction_gate_review: 'methodology.next.directionGateReview',
    direction_deepen_continue: 'methodology.next.directionDeepenContinue',
    direction_broaden_intake: 'methodology.next.directionBroadenIntake',
    direction_pivot_intake: 'methodology.next.directionPivotIntake',
    direction_conclude_prepare: 'methodology.next.directionConcludePrepare',
    direction_pause_review: 'methodology.next.directionPauseReview',
    direction_overlay_stale: 'methodology.next.directionOverlayStale',
    direction_overlay_invalid: 'methodology.next.directionOverlayInvalid',
  }
  const directionAction = projectProjection.next_actions_v2.find(action =>
    action.state !== 'done' && directionRecommendationKeys[action.code] !== undefined)
  const nextRecommendation = directionAction !== undefined
    ? { code: directionAction.code, label_key: directionRecommendationKeys[directionAction.code]! }
    : latestProtocol?.status !== 'frozen'
      ? { code: 'configure_protocol', label_key: 'methodology.next.configureProtocol' }
      : latestSynthesis === undefined
        ? { code: 'run_synthesis', label_key: 'methodology.next.runSynthesis' }
        : activations.records.length === 0
          ? { code: 'activate_knowledge', label_key: 'methodology.next.activateKnowledge' }
          : blockingCount > 0
            ? { code: 'review_writing', label_key: 'methodology.next.reviewWriting' }
            : assuranceSummary?.ready !== true
              ? { code: 'run_assurance', label_key: 'methodology.next.runAssurance' }
              : null
  const rolloutPin = kernel.rollout.projectPin(projectId)

  return {
    project_id: projectId,
    revision: kernel.methodology.projectRevision(projectId),
    assurance: assuranceSummary,
    protocol: protocolSummary,
    synthesis: synthesisSummary,
    knowledge: knowledgeSummary,
    writing: writingSummary,
    manuscript: manuscriptSummary,
    runs: runSummary,
    topology: topologySummary,
    next_recommendation: nextRecommendation,
    rollout: {
      mode: rolloutPin.mode,
      policy_revision: rolloutPin.policy_revision,
      project_pin_revision: rolloutPin.project_pin_revision,
      telemetry: kernel.methodologyTelemetry.redactedAggregate(),
    },
  }
}

/**
 * v2 adapter (api-contracts.md §4): the /v2 surface the BFF exposes to the
 * UI. Idempotency-Key-scoped project creation, membership-filtered paginated
 * listing, projection with capabilities, gate-requests (decision fields are
 * rejected — agents cannot attach a decision) and transitions (gate states
 * stay 422). x-principal-id is the BFF-resolved operator identity; when
 * present, project-scoped routes enforce membership (404 on non-member).
 */
async function handleV2(ctx: {
  req: IncomingMessage
  res: ServerResponse
  method: string
  url: URL
  resource?: string
  id?: string
  sub?: string
  subId?: string
  subSubId?: string
  body: unknown
  kernel: ResearchKernel
  configPin?: string
}): Promise<void> {
  const { req, res, method, url, resource, id, sub, subId, subSubId, body, kernel, configPin } = ctx
  const principal = typeof req.headers['x-principal-id'] === 'string' ? req.headers['x-principal-id'] : undefined
  // API-01 role capabilities: the BFF injects x-principal-role from ITS OWN
  // membership lookup (client-supplied values are never trusted). When
  // present, the role gates the surface: viewer/auditor are read-only and
  // researcher cannot perform governance writes. A present-but-invalid role
  // is 403 role_required (fail-closed); an absent header means the caller
  // has no BFF identity and the route falls back to principal/member checks.
  const role = typeof req.headers['x-principal-role'] === 'string' ? req.headers['x-principal-role'] : undefined
  const roleOk = role === undefined || role === 'pi' || role === 'researcher' || role === 'operator' || role === 'auditor' || role === 'viewer'
  // Governance writes (API-01): transitions, gate creation/decisions
  // (incl. gate-requests), budget and the internal approve/accept channels,
  // plus intake adopt and project archive/unarchive (GOV-01/ONBOARD-01 §5 P1
  // — shared explicit capability route table, same table as the BFF).
  // researcher may submit ordinary work but never these.
  if (!roleOk) {
    send(res, 403, { error: { code: 'role_required', message: 'invalid x-principal-role; BFF must inject pi|researcher|operator|auditor|viewer' } })
    return
  }
  const projectDelete = method === 'DELETE' && /^\/v2\/projects\/[^/]+\/?$/.test(url.pathname)
  if (role !== undefined && method !== 'GET' && method !== 'HEAD' && method !== 'OPTIONS') {
    if (role === 'viewer' || role === 'auditor' || (role === 'researcher' && (isPiOnlyWrite(url.pathname) || projectDelete))) {
      send(res, 403, { error: { code: 'role_forbidden', message: 'role forbidden for this operation' } })
      return
    }
  }
  const memberOr404 = (projectId: string): void => {
    if (principal === undefined) return
    const members = kernel.listProjectMembers(projectId)
    if (!members.some(m => m.principal_id === principal)) {
      throw new KernelError(404, 'project_not_found', 'project not found or access denied')
    }
  }
  const methodologyMember = (projectId: string): { principal_id: string; role: string } | null => {
    if (principal === undefined || principal.trim() === '') {
      send(res, 422, { error: errorEnvelope('principal_required', 'methodology access requires an authenticated Human Principal') })
      return null
    }
    const durableRole = kernel.getProjectMemberRole(projectId, principal)
    if (durableRole === null) {
      send(res, 404, { error: errorEnvelope('project_not_found', 'project not found or access denied') })
      return null
    }
    return { principal_id: principal, role: durableRole }
  }
  const methodologyWriter = (projectId: string, piOnly = false): { principal_id: string; role: string } | null => {
    const member = methodologyMember(projectId)
    if (member === null) return null
    const allowed = piOnly ? member.role === 'pi' : member.role === 'pi' || member.role === 'researcher'
    if (!allowed) {
      send(res, 403, {
        error: errorEnvelope(
          'role_forbidden',
          piOnly ? 'methodology decision requires project PI authority' : 'methodology write requires project PI or researcher authority',
        ),
      })
      return null
    }
    return member
  }
  const methodologyOperator = (): string | null => {
    if (principal === undefined || principal.trim() === '') {
      send(res, 422, { error: errorEnvelope('principal_required', 'methodology registry access requires an authenticated Operator') })
      return null
    }
    const operator = kernel.db.prepare(`
      SELECT 1
      FROM project_members AS membership
      JOIN projects AS project ON project.project_id = membership.project_id
      WHERE membership.principal_id = ?
        AND membership.role = 'operator'
        AND project.deleted_at IS NULL
      LIMIT 1
    `).get(principal)
    if (operator === undefined) {
      send(res, 403, { error: errorEnvelope('role_forbidden', 'methodology registry access requires durable Operator authority') })
      return null
    }
    return principal
  }
  const sameProject = (pathProjectId: string, recordProjectId: string): boolean => {
    if (pathProjectId === recordProjectId) return true
    send(res, 404, { error: errorEnvelope('project_not_found', 'project not found or access denied') })
    return false
  }
  if (id === undefined && sub === undefined && method === 'GET' && url.pathname === '/v2/health') {
    // api-contracts.md §3 / reconstruction-contracts.md §5: canonical
    // HealthResponse — capability discovery with protocol/schema version.
    // capabilities is the OBJECT form with one boolean per implemented
    // server-side capability (locales + locale_contract_revision included);
    // protocol_version is the string 'v2' per the canonical wire type.
    send(res, 200, {
      ok: true,
      instance_id: kernel.instanceId,
      protocol_version: 'v2',
      schema_version: kernel.schemaVersion(),
      database_id: kernel.databaseId(),
      config_pin: configPin ?? kernel.configPinHash,
      capabilities: {
        terminal_stream: true,
        interactive_terminal: true,
        workspace_files: true,
        tex_workspace: true,
        latex_compile: true,
        latex_live_preview: true,
        remote_runner: true,
        config_registry: true,
        research_onboarding: true,
        trajectory: true,
        subagent_topology: true,
        signed_manifest: true,
        clean_room: true,
        locales: ['zh', 'en'],
        locale_contract_revision: 1,
      },
      time: new Date().toISOString(),
    })
    return
  }
  // Methodology / Knowledge API (api-contracts.md §24): global registry
  // access is Operator-only and derives authority from durable membership,
  // never x-principal-role.
  if (resource === 'methodology' && id === 'rollout-policy' && sub === undefined && subId === undefined && subSubId === undefined) {
    const operator = methodologyOperator()
    if (operator === null) return
    if (method === 'GET') {
      send(res, 200, kernel.rollout.currentPolicy())
      return
    }
    if (method === 'POST') {
      const input = methodologyRolloutPolicyUpdateSchema.parse(body)
      send(res, 201, kernel.rollout.updatePolicy({ ...input, actor_ref: operator }))
      return
    }
  }
  if (resource === 'methodology' && id === 'packages' && sub === undefined && subId === undefined && subSubId === undefined) {
    if (methodologyOperator() === null) return
    if (method === 'GET') {
      const packages = kernel.methodology.listKnowledgePackages()
      const evaluations = kernel.methodology.listKnowledgeEvaluations()
      send(res, 200, { registry_revision: packages.registry_revision, packages, evaluations })
      return
    }
    if (method === 'POST') {
      const input = knowledgePackageWriteSchema.parse(body)
      send(res, 201, kernel.methodology.registerKnowledgePackage(input))
      return
    }
  }
  if (resource === 'methodology' && id === 'packages' && sub !== undefined && subId !== undefined && subSubId === 'evaluations' && method === 'POST') {
    if (methodologyOperator() === null) return
    const input = knowledgeEvaluationWriteSchema.parse(body)
    if (input.record.package_name !== sub || input.record.package_version !== subId) {
      send(res, 404, { error: errorEnvelope('methodology_knowledge_package_not_found', 'knowledge package not found') })
      return
    }
    send(res, 201, kernel.methodology.recordKnowledgeEvaluation(input))
    return
  }
  if (resource === 'methodology' && id === 'native-packs' && sub === 'reconcile' && subId === undefined && subSubId === undefined && method === 'POST') {
    if (methodologyOperator() === null) return
    send(res, 200, kernel.methodology.reconcileNativeKnowledgePacks())
    return
  }
  if (resource !== 'projects') {
    send(res, 404, { error: { code: 'not_found', message: 'unknown v2 route' } })
    return
  }
  if (id === undefined && method === 'POST') {
    // POST /v2/projects — Idempotency-Key REQUIRED (api-contracts §4).
    const idem = typeof req.headers['idempotency-key'] === 'string' && req.headers['idempotency-key'] !== ''
      ? req.headers['idempotency-key']
      : undefined
    if (idem === undefined) {
      send(res, 422, { error: { code: 'idempotency_key_required', message: 'POST /v2/projects requires an Idempotency-Key header' } })
      return
    }
    const input = createProjectForGrillSchema.parse(body)
    const requestHash = createHash('sha256').update(JSON.stringify(body)).digest('hex')
    const creatorPrincipal = principal ?? input.creator_principal_id
    if (creatorPrincipal === undefined || creatorPrincipal.trim() === '') {
      send(res, 422, { error: { code: 'principal_required', message: 'POST /v2/projects requires an authenticated Human Principal' } })
      return
    }
    const out = kernel.createProjectForGrill({
      name: input.name,
      creator_principal_id: creatorPrincipal,
      creator_tenant_id: input.creator_tenant_id,
      idempotency_key: idem,
      request_hash: requestHash,
    })
    send(res, 201, { project: out.project, intake: out.intake, budget: out.budget, membership: out.membership })
    return
  }
  if (id === undefined && method === 'GET') {
    // GET /v2/projects — membership-filtered paginated list.
    const limit = Number(url.searchParams.get('limit') ?? '50')
    const cursor = url.searchParams.get('cursor') ?? undefined
    const page = kernel.listProjectsPage(Number.isFinite(limit) ? limit : 50, cursor)
    const items = principal === undefined
      ? page.items
      : page.items.filter(p => kernel.listProjectMembers(p.project_id).some(m => m.principal_id === principal))
    send(res, 200, { items, next_cursor: page.next_cursor })
    return
  }
  if (id !== undefined && sub === 'methodology' && subId === undefined && method === 'GET') {
    if (methodologyMember(id) === null) return
    send(res, 200, compactMethodologyProjection(kernel, id))
    return
  }
  if (id !== undefined && sub === 'rollout-policy' && subId === undefined && method === 'POST') {
    const member = methodologyWriter(id, true)
    if (member === null) return
    const input = projectMethodologyRolloutPinSchema.parse(body)
    send(res, 201, kernel.rollout.pinProject({
      project_id: id,
      ...input,
      actor_ref: member.principal_id,
    }))
    return
  }
  if (id !== undefined && sub === 'methodology' && subId === 'graph' && subSubId === undefined && method === 'GET') {
    if (methodologyMember(id) === null) return
    send(res, 200, buildResearchGraph({
      project_id: id,
      protocols: kernel.methodology.listProtocolRevisions(id).records.map(item => item.record),
      syntheses: kernel.methodology.listResearchSyntheses(id).records.map(item => item.record),
      directions: kernel.methodology.listDirectionProposals(id).records.map(item => item.record),
      adoptions: kernel.methodology.listDirectionAdoptions(id).records.map(item => item.record),
      run_outcomes: kernel.methodology.listResearchRunOutcomes(id).outcomes.map(item => item.outcome),
    }))
    return
  }
  if (id !== undefined && sub === 'research-runs' && subId === undefined && method === 'GET') {
    if (methodologyMember(id) === null) return
    send(res, 200, kernel.methodology.listResearchRunOutcomes(id))
    return
  }
  if (id !== undefined && sub === 'run-outcome-observations' && subId === undefined && method === 'GET') {
    if (methodologyMember(id) === null) return
    send(res, 200, kernel.listRunOutcomeObservations(id))
    return
  }
  if (id !== undefined && sub === 'synthesis-requests' && subId === undefined && method === 'GET') {
    if (methodologyMember(id) === null) return
    send(res, 200, kernel.listSynthesisRecordRequests(id))
    return
  }
  if (id !== undefined && sub === 'research-runs' && subId === undefined && method === 'POST') {
    const member = methodologyWriter(id)
    if (member === null) return
    const input = researchRunOutcomeWriteSchema.parse(body)
    if (!sameProject(id, input.record.project_id)) return
    send(res, 201, kernel.recordResearchRunOutcome(input, member.principal_id))
    return
  }
  if (id !== undefined && sub === 'negative-findings' && subId === undefined && method === 'GET') {
    if (methodologyMember(id) === null) return
    send(res, 200, kernel.methodology.listNegativeFindings(id))
    return
  }
  if (id !== undefined && sub === 'claim-proposals' && subId === undefined && method === 'GET') {
    if (methodologyMember(id) === null) return
    send(res, 200, kernel.methodology.listResearchClaimProposals(id))
    return
  }
  if (id !== undefined && sub === 'method-triads' && subId === undefined && method === 'GET') {
    if (methodologyMember(id) === null) return
    send(res, 200, kernel.writingReview.listMethodTriads(id))
    return
  }
  if (id !== undefined && sub === 'method-triads' && subId === undefined && method === 'POST') {
    if (methodologyWriter(id) === null) return
    const input = MethodTriadWrite.parse(body)
    if (!sameProject(id, input.record.input_pin.project_id)) return
    send(res, 201, kernel.recordMethodTriad(input))
    return
  }
  if (id !== undefined && sub === 'section-guides' && subId === undefined && method === 'GET') {
    if (methodologyMember(id) === null) return
    send(res, 200, kernel.writingReview.listSectionGuides(id))
    return
  }
  if (id !== undefined && sub === 'section-guides' && subId === undefined && method === 'POST') {
    if (methodologyWriter(id) === null) return
    const input = SectionGuideActivationWrite.parse(body)
    if (!sameProject(id, input.request.input_pin.project_id)) return
    send(res, 201, kernel.recordSectionGuideActivation(input))
    return
  }
  if (id !== undefined && sub === 'reviewer-panels' && subId === undefined && method === 'GET') {
    if (methodologyMember(id) === null) return
    send(res, 200, kernel.writingReview.listReviewerPanels(id))
    return
  }
  if (id !== undefined && sub === 'reviewer-panels' && subId === undefined && method === 'POST') {
    if (methodologyWriter(id) === null) return
    const input = WritingReviewerPanelWrite.parse(body)
    if (!sameProject(id, input.input_pin.project_id)) return
    send(res, 201, kernel.recordWritingReviewerPanel(input))
    return
  }
  if (id !== undefined && sub === 'writing-patches' && subId === undefined && method === 'GET') {
    if (methodologyMember(id) === null) return
    const proposals = kernel.writingReview.listPatchProposals(id)
    const applications = kernel.writingReview.listPatchApplications(id)
    send(res, 200, { project_id: id, stream_revision: proposals.stream_revision, proposals, applications })
    return
  }
  if (id !== undefined && sub === 'writing-patches' && subId === undefined && method === 'POST') {
    if (methodologyWriter(id) === null) return
    const input = WritingPatchProposalWrite.parse(body)
    if (!sameProject(id, input.record.project_id)) return
    send(res, 201, kernel.recordWritingPatchProposal(input))
    return
  }
  if (id !== undefined && sub === 'writing-patches' && subId !== undefined && subSubId === 'apply' && method === 'POST') {
    const member = methodologyWriter(id)
    if (member === null) return
    const sessionId = req.headers['x-principal-session']
    const serviceCredential = req.headers['x-service-token']
    const trustedHumanSession = kernel.serviceToken !== undefined
      && typeof serviceCredential === 'string'
      && serviceTokenEquals(serviceCredential, kernel.serviceToken)
      && req.headers['x-service-principal'] === 'standalone-human-bff'
      && typeof sessionId === 'string'
      && sessionId.trim() !== ''
    if (!trustedHumanSession) {
      send(res, 403, { error: errorEnvelope('writing_patch_trusted_session_required', 'Writing patch apply requires a server-verified Human BFF session') })
      return
    }
    const input = WritingPatchApplyInput.parse(body)
    send(res, 201, kernel.applyWritingPatch(id, subId, input, {
      principal_id: member.principal_id,
      auth_method: 'dsh-session',
      session_id: sessionId,
    }))
    return
  }
  if (id !== undefined && sub === 'assurance-audits' && subId === undefined && method === 'GET') {
    if (methodologyMember(id) === null) return
    send(res, 200, kernel.assurance.list(id))
    return
  }
  if (id !== undefined && sub === 'assurance-executions' && subId === undefined && method === 'POST') {
    if (methodologyWriter(id) === null) return
    const input = writingAssuranceExecutionSchema.parse(body)
    send(res, 201, kernel.runWritingAssurance({ project_id: id, ...input }))
    return
  }
  if (id !== undefined && sub === 'assurance-audits' && subId !== undefined && subSubId === 'accept' && method === 'POST') {
    const member = methodologyWriter(id, true)
    if (member === null) return
    const input = assuranceAcceptSchema.parse(body)
    send(res, 200, kernel.assurance.accept({
      project_id: id,
      audit_id: subId,
      expected_revision: input.expected_revision,
      accepted_by: member.principal_id,
    }))
    return
  }
  if (id !== undefined && sub === 'protocols' && subId === undefined && method === 'GET') {
    if (methodologyMember(id) === null) return
    send(res, 200, kernel.methodology.listProtocolRevisions(id))
    return
  }
  if (id !== undefined && sub === 'protocols' && subId === undefined && method === 'POST') {
    if (methodologyWriter(id) === null) return
    const input = protocolRevisionWriteSchema.parse(body)
    if (!sameProject(id, input.record.project_id)) return
    send(res, 201, kernel.methodology.recordProtocolRevision(input))
    return
  }
  if (id !== undefined && sub === 'syntheses' && subId === undefined && method === 'GET') {
    if (methodologyMember(id) === null) return
    send(res, 200, kernel.methodology.listResearchSyntheses(id))
    return
  }
  if (id !== undefined && sub === 'syntheses' && subId === undefined && method === 'POST') {
    if (methodologyWriter(id) === null) return
    const input = researchSynthesisWriteSchema.parse(body)
    if (!sameProject(id, input.record.project_id)) return
    send(res, 201, kernel.recordResearchSynthesis(input))
    return
  }
  if (id !== undefined && sub === 'directions' && subId === undefined && method === 'GET') {
    if (methodologyMember(id) === null) return
    const proposals = kernel.methodology.listDirectionProposals(id)
    const adoptions = kernel.methodology.listDirectionAdoptions(id)
    send(res, 200, { project_id: id, stream_revision: proposals.stream_revision, proposals, adoptions })
    return
  }
  if (id !== undefined && sub === 'directions' && subId === undefined && method === 'POST') {
    if (methodologyWriter(id) === null) return
    const input = directionProposalWriteSchema.parse(body)
    if (!sameProject(id, input.record.project_id)) return
    send(res, 201, kernel.methodology.recordDirectionProposal(input))
    return
  }
  if (id !== undefined && sub === 'directions' && subId !== undefined && subSubId === 'adopt' && method === 'POST') {
    const member = methodologyWriter(id, true)
    if (member === null) return
    const input = directionAdoptionWriteSchema.parse(body)
    // Scope the proposal path before evaluating the immutable decision so a
    // proposal id from another project is indistinguishable from missing.
    const proposal = kernel.methodology.getDirectionProposal(id, subId).record
    const project = kernel.getProject(id)
    const nextActions = kernel.projectProjection(id).next_actions_v2
    const nextActionRevision = nextActions.find(action => action.state === 'ready')?.revision
      ?? nextActions.find(action => action.state !== 'done')?.revision
      ?? project.revision
    const gateDecision = input.gate_decision_ref === null
      ? undefined
      : kernel.listDecisions(id).find(candidate => candidate.decision_id === input.gate_decision_ref)
    const directionGate = gateDecision === undefined ? undefined : kernel.getGate(gateDecision.gate_id)
    const gateBinding = directionGate?.type === 'direction'
      ? DirectionGatePayload.safeParse(directionGate.payload)
      : undefined
    const gatePrincipal = gateDecision?.principal
    const gatePrincipalRole = gatePrincipal === undefined
      ? null
      : kernel.getProjectMemberRole(id, gatePrincipal.principal_id)
    const gateHasAuthenticatedHuman = gatePrincipal !== undefined
      && gatePrincipal.auth_method !== 'agent'
      && gatePrincipal.auth_method !== 'unverified'
      && (gatePrincipalRole === 'pi' || gatePrincipalRole === 'operator')
    const gateMatchesProposal = gateHasAuthenticatedHuman
      && gateDecision?.decision === 'approved'
      && directionGate?.project_id === id
      && gateBinding?.success === true
      && gateBinding.data.proposal_id === proposal.proposal_id
      && gateBinding.data.source_synthesis_id === proposal.synthesis_id
      && gateBinding.data.direction === proposal.direction
    const verifiedGateApproval = gateMatchesProposal
      ? {
          decision_ref: gateDecision.decision_id,
          gate_id: directionGate.gate_id,
          gate_type: 'direction' as const,
          decision: 'approved' as const,
          human_principal_ref: gatePrincipal.principal_id,
          binding: gateBinding.data,
        }
      : null
    const decision = evaluateResearchMethodology({
      operation: 'direction_adoption',
      proposal,
      request: {
        adoption_id: input.adoption_id,
        decision: input.decision === 'adopted' ? 'adopt' : 'reject',
        actor: { kind: 'human', ref: member.principal_id },
        within_approved_contract: ['CONTRACT_APPROVED', 'BASELINE_REPRO', 'EXPERIMENTING', 'EVIDENCE_READY', 'WRITING', 'REVIEWING', 'RELEASE_READY'].includes(project.status),
        gate_approval: verifiedGateApproval,
        current: {
          project_revision: project.revision,
          next_action_revision: nextActionRevision ?? project.revision,
          // The project/NextAction revision fence above detects authoritative
          // movement. `input_hash` is the immutable proposal pin; a future
          // typed graph projection may recompute it from its source refs.
          input_hash: proposal.input_hash,
        },
        requested_at: input.created_at,
      },
    })
    if (decision.operation !== 'direction_adoption') {
      throw new KernelError(500, 'direction_adoption_internal', 'methodology evaluator returned the wrong operation')
    }
    if (!decision.adoptable || decision.adoption_candidate === null) {
      throw new KernelError(422, decision.blockers[0] ?? 'direction_adoption_denied',
        `direction adoption denied: ${decision.blockers.join(',')}`)
    }
    send(res, 201, kernel.methodology.recordDirectionAdoption({
      expected_revision: input.expected_revision,
      record: decision.adoption_candidate,
    }))
    return
  }
  if (id !== undefined && sub === 'knowledge-activations' && subId === undefined && method === 'GET') {
    if (methodologyMember(id) === null) return
    send(res, 200, kernel.methodology.listKnowledgeActivations(id))
    return
  }
  if (id !== undefined && sub === 'knowledge-activations' && subId === undefined && method === 'POST') {
    const member = methodologyWriter(id, true)
    if (member === null) return
    const input = knowledgeActivationWriteSchema.parse(body)
    const sessionId = typeof req.headers['x-principal-session'] === 'string'
      ? req.headers['x-principal-session'].trim()
      : ''
    if (!/^[A-Za-z0-9][A-Za-z0-9._:@-]{0,255}$/.test(sessionId)) {
      send(res, 422, { error: errorEnvelope('principal_session_required', 'Knowledge activation requires the authenticated BFF session') })
      return
    }
    send(res, 201, kernel.activateKnowledgePackageFromAuthority({
      project_id: id,
      session_id: sessionId,
      principal_id: member.principal_id,
      ...input,
    }))
    return
  }
  if (id !== undefined && sub === 'knowledge-activations' && subId !== undefined && subSubId === 'deactivate' && method === 'POST') {
    if (methodologyWriter(id, true) === null) return
    const input = knowledgeDeactivationWriteSchema.parse(body)
    if (!sameProject(id, input.request.project_id)) return
    if (input.request.activation_id !== subId) {
      send(res, 404, { error: errorEnvelope('methodology_activation_not_found', 'knowledge activation not found') })
      return
    }
    send(res, 201, kernel.deactivateKnowledgePackage(input))
    return
  }
  if (id !== undefined && sub === 'knowledge-delivery' && subId === undefined && method === 'GET') {
    if (methodologyMember(id) === null) return
    const sessionId = url.searchParams.get('session_id')?.trim() ?? ''
    const surface = url.searchParams.get('surface')
    if (sessionId === '' || sessionId.length > 256 || (surface !== 'scholar-chat' && surface !== 'assurance-reviewer')) {
      send(res, 422, { error: errorEnvelope('validation_error', 'session_id and a valid surface are required') })
      return
    }
    const projection = kernel.projectProjection(id)
    const actionRevision = projection.next_actions_v2.find(action => action.state === 'ready')?.revision
      ?? projection.next_actions_v2.find(action => action.state !== 'done')?.revision
      ?? projection.project.revision
    send(res, 200, kernel.resolveKnowledgeDelivery({
      project_id: id,
      session_id: sessionId,
      phase: projection.project.status,
      next_action_revision: actionRevision,
      surface,
    }))
    return
  }
  if (id !== undefined && sub === 'writing-reviews' && subId === undefined && method === 'GET') {
    if (methodologyMember(id) === null) return
    const reverseOutlines = kernel.methodology.listReverseOutlines(id)
    const findings = kernel.methodology.listReviewFindings(id)
    send(res, 200, {
      project_id: id,
      stream_revision: reverseOutlines.stream_revision,
      reverse_outlines: reverseOutlines,
      findings,
    })
    return
  }
  if (id !== undefined && sub === 'writing-reviews' && subId === undefined && method === 'POST') {
    if (methodologyWriter(id) === null) return
    const input = writingReviewWriteSchema.parse(body)
    if (!sameProject(id, input.record.input_pin.project_id)) return
    const receipt = input.kind === 'reverse-outline'
      ? kernel.methodology.recordReverseOutline({ record: input.record, expected_revision: input.expected_revision })
      : kernel.methodology.recordReviewFinding({ record: input.record, expected_revision: input.expected_revision })
    send(res, 201, receipt)
    return
  }
  if (id !== undefined && sub === 'grill' && subId === undefined && method === 'GET') {
    memberOr404(id)
    ok(res, kernel.projectGrillProjection(id))
    return
  }
  if (id !== undefined && sub === 'grill' && subId === 'answers' && method === 'POST') {
    memberOr404(id)
    if (principal === undefined || principal.trim() === '') {
      send(res, 422, { error: { code: 'principal_required', message: 'Grill answers require an authenticated Human Principal' } })
      return
    }
    const input = projectGrillAnswerSchema.parse(body)
    ok(res, kernel.answerProjectGrill({ project_id: id, principal_id: principal, ...input }))
    return
  }
  if (id !== undefined && sub === 'grill' && subId === 'confirm' && method === 'POST') {
    memberOr404(id)
    if (!requirePiOnly(kernel, req, res, id, body, 'Grill confirm', { allowOperator: false })) return
    const idem = typeof req.headers['idempotency-key'] === 'string' && req.headers['idempotency-key'] !== '' ? req.headers['idempotency-key'] : undefined
    if (idem === undefined) {
      send(res, 422, { error: { code: 'idempotency_key_required', message: 'Grill confirm requires an Idempotency-Key header' } })
      return
    }
    const input = projectGrillConfirmSchema.parse(body)
    const requestHash = createHash('sha256').update(JSON.stringify(body)).digest('hex')
    ok(res, kernel.confirmProjectGrill({ project_id: id, principal_id: principal!, request_id: idem, request_hash: requestHash, ...input }))
    return
  }
  if (id !== undefined && sub === undefined && method === 'GET') {
    memberOr404(id)
    ok(res, kernel.getProject(id))
    return
  }
  if (id !== undefined && sub === 'execution' && method === 'PATCH') {
    memberOr404(id)
    if (!requirePiOnly(kernel, req, res, id, body, 'project execution configuration')) return
    const input = projectRunnerTargetSchema.parse(body)
    ok(res, kernel.configureProjectRunnerTarget({ project_id: id, ...input }))
    return
  }
  if (id !== undefined && sub === 'idea-gate' && method === 'POST') {
    memberOr404(id)
    if (!requirePiOnly(kernel, req, res, id, body, 'Idea selection')) return
    const input = ideaGatePrepareSchema.parse(body)
    send(res, 201, kernel.prepareIdeaGate({ project_id: id, ...input }))
    return
  }
  if (id !== undefined && sub === 'contract-gate' && method === 'POST') {
    memberOr404(id)
    if (!requirePiOnly(kernel, req, res, id, body, 'Contract draft preparation')) return
    const input = contractGatePrepareSchema.parse(body)
    send(res, 201, kernel.prepareContractGate({ project_id: id, ...input } as never))
    return
  }
  if (id !== undefined && sub === undefined && method === 'DELETE') {
    const input = deleteProjectSchema.parse(body)
    if (!requirePiOnly(kernel, req, res, id, body, 'project deletion', { allowOperator: false, includeDeleted: true })) return
    const deletedBy = typeof req.headers['x-principal-id'] === 'string' ? req.headers['x-principal-id'] : ''
    const requestId = typeof req.headers['x-request-id'] === 'string' ? req.headers['x-request-id'] : ''
    if (requestId === '') throw new KernelError(422, 'request_id_required', 'project deletion requires X-Request-Id')
    ok(res, kernel.deleteProject({ project_id: id, ...input, deleted_by: deletedBy, request_id: requestId }))
    return
  }
  if (id !== undefined && sub === 'projection' && method === 'GET') {
    memberOr404(id)
    const projection = kernel.projectProjection(id)
    const members = kernel.listProjectMembers(id)
    const project = kernel.getProject(id)
    const capabilities = {
      editor: true,
      runner_profile_id: project.execution.runner_profile_id,
      gates: ['scope', 'idea', 'contract', 'release', 'direction'],
      roles: members.map(m => m.role),
      membership: principal === undefined ? null : members.find(m => m.principal_id === principal)?.role ?? null,
    }
    send(res, 200, { ...projection, capabilities })
    return
  }
  if (id !== undefined && sub === 'gate-requests' && subId === undefined && method === 'POST') {
    memberOr404(id)
    const input = z.object({
      type: z.enum(['scope', 'idea', 'contract', 'release', 'direction']),
      title: z.string().min(1),
      summary: z.string().optional(),
      payload: z.record(z.unknown()).optional(),
    }).parse(body)
    // Gate requests must NOT carry a decision (agents cannot attach one).
    const bodyObj = typeof body === 'object' && body !== null ? body as Record<string, unknown> : {}
    for (const forbidden of ['decision', 'actor', 'principal', 'resume_to']) {
      if (forbidden in bodyObj) {
        throw new KernelError(422, 'decision_not_allowed', `gate-requests must not carry '${forbidden}'`)
      }
    }
    const gate = kernel.createGate({
      project_id: id,
      type: input.type,
      title: input.title,
      summary: input.summary,
      payload: input.payload,
    })
    send(res, 201, { gate })
    return
  }
  if (id !== undefined && sub === 'jobs' && method === 'POST') {
    // v2 ordinary work submission (API-01): allowed for pi/operator/
    // researcher; viewer/auditor are read-only (enforced above).
    memberOr404(id)
    const input = jobSchema.parse(body)
    rejectBaselineOrdinarySubmit(input.kind)
    // v2 shape (domain-model.md §9): the durable submitter principal is the
    // BFF-injected x-principal-id (never client body trust); a body override
    // is honored for internal callers; absent both → NULL.
    const headerPrincipal = typeof req.headers['x-principal-id'] === 'string' && req.headers['x-principal-id'] !== '' ? req.headers['x-principal-id'] : undefined
    const job = kernel.submitJob({ ...input, project_id: id, created_by_principal_id: input.created_by_principal_id ?? headerPrincipal ?? null })
    send(res, 201, job)
    return
  }
  if (id !== undefined && sub === 'transitions' && method === 'POST') {
    memberOr404(id)
    const input = z.object({
      to: z.string().min(1),
      expected_revision: z.number().int().nonnegative(),
      reason: z.string().optional(),
    }).parse(body)
    const project = kernel.transition(id, input.to as never, input.expected_revision, input.reason)
    ok(res, project)
    return
  }
  // REPRO-01 (docs/reproduction-contracts.md §4): reproduction v2 surface.
  // Every route resolves the project id in the path FIRST (memberOr404) —
  // all other ids (spec/attempt/report) are project-scoped afterwards, so a
  // cross-project id is the same 404 as an unknown one (no enumeration).
  if (id !== undefined && sub === 'reproduction-specs' && subId === undefined && method === 'POST') {
    memberOr404(id)
    if (principal === undefined || principal.trim() === '') {
      send(res, 422, { error: { code: 'principal_required', message: 'reproduction spec creation requires an authenticated Human Principal' } })
      return
    }
    const input = z.object({
      paper_ref: z.unknown(),
      source_locator: z.string().optional(),
      source_artifact_id: z.string().nullable().optional(),
      reproduction_level: z.string().optional(),
      claims_to_reproduce: z.array(z.unknown()).optional(),
      code_source: z.unknown().nullable().optional(),
      data_inputs: z.array(z.unknown()).optional(),
      execution_binding: z.unknown().nullable().optional(),
      environment_lock: z.unknown().optional(),
      expected_outputs: z.array(z.string()).optional(),
      metric_comparators: z.array(z.unknown()).optional(),
      idempotency_key: z.string().optional(),
    }).parse(body)
    const requestHash = createHash('sha256').update(JSON.stringify(body)).digest('hex')
    const spec = kernel.createReproductionSpec({
      project_id: id,
      owner: { principal_id: principal, auth_method: 'dsh-session' },
      paper_ref: input.paper_ref as never,
      source_locator: input.source_locator,
      source_artifact_id: input.source_artifact_id,
      reproduction_level: input.reproduction_level as never,
      claims_to_reproduce: (input.claims_to_reproduce ?? []) as never,
      code_source: input.code_source as never,
      data_inputs: input.data_inputs as never,
      execution_binding: input.execution_binding as never,
      environment_lock: input.environment_lock as never,
      expected_outputs: input.expected_outputs,
      metric_comparators: input.metric_comparators as never,
      idempotency_key: input.idempotency_key,
      request_hash: requestHash,
    })
    send(res, 201, spec)
    return
  }
  if (id !== undefined && sub === 'reproduction-specs' && subId === undefined && method === 'GET') {
    memberOr404(id)
    ok(res, kernel.listReproductionSpecs(id))
    return
  }
  if (id !== undefined && sub === 'reproduction-specs' && subId !== undefined && subSubId === undefined && method === 'GET') {
    memberOr404(id)
    ok(res, kernel.getReproductionSpec(id, subId))
    return
  }
  if (id !== undefined && sub === 'reproduction-specs' && subId !== undefined && subSubId === undefined && method === 'PATCH') {
    memberOr404(id)
    const input = z.object({
      expected_revision: z.number().int().nonnegative(),
      patch: z.record(z.unknown()),
    }).parse(body)
    ok(res, kernel.updateReproductionSpec(id, subId, {
      expected_revision: input.expected_revision,
      patch: input.patch as never,
    }))
    return
  }
  if (id !== undefined && sub === 'reproduction-specs' && subId !== undefined && subSubId === 'attempts' && method === 'POST') {
    memberOr404(id)
    const input = z.object({
      submitter_principal: z.string().optional(),
      reason: z.string().optional(),
      job_id: z.string().nullable().optional(),
      run_id: z.string().nullable().optional(),
      code_snapshot_id: z.string().nullable().optional(),
      approved_contract_version: z.number().int().nonnegative().nullable().optional(),
      idempotency_key: z.string().optional(),
    }).parse(body)
    const requestHash = createHash('sha256').update(JSON.stringify(body)).digest('hex')
    // The submitter Principal is the BFF-injected x-principal-id (client
    // body values are never trusted); the body field is an internal-caller
    // fallback mirroring the v2 job route.
    const started = kernel.startReproductionAttempt(id, subId, {
      submitter_principal: principal ?? input.submitter_principal ?? '',
      reason: input.reason,
      job_id: input.job_id,
      run_id: input.run_id,
      code_snapshot_id: input.code_snapshot_id,
      approved_contract_version: input.approved_contract_version,
      idempotency_key: input.idempotency_key,
      request_hash: requestHash,
    })
    send(res, 201, started)
    return
  }
  if (id !== undefined && sub === 'reproduction-attempts' && subId !== undefined && method === 'GET') {
    memberOr404(id)
    ok(res, kernel.getReproductionAttempt(id, subId))
    return
  }
  if (id !== undefined && sub === 'reproduction-reports' && subId !== undefined && method === 'GET') {
    memberOr404(id)
    ok(res, kernel.getReproductionReport(id, subId))
    return
  }
  send(res, 404, { error: { code: 'not_found', message: 'unknown v2 route' } })
}

export function startKernelServer(options: KernelServerOptions): Promise<{ server: Server; url: string; port: number }> {  const { kernel, host = '127.0.0.1', port = 7412, token } = options
  // §12.7 server-level startup parameter (see also KernelOptions.requireSignedManifest).
  if (options.requireSignedManifest !== undefined) kernel.requireSignedManifest = options.requireSignedManifest
  // CONFIG-01: the deployment config pin (CLI-computed) or the kernel's own.
  const configPin = options.configPinHash ?? kernel.configPinHash
  // CONFIG-01: the deployment's redacted effective config (CLI-computed) or
  // the kernel's own — served by GET /v1/config/effective.
  const configRedacted = options.configRedacted ?? kernel.configRedacted
  const server = createServer((req, res) => {
    // OBS-01 (reconstruction-contracts.md §18): HTTP request count + latency
    // histogram. Recorded once per request on response finish (or close for
    // aborted sockets); tags are fixed constants (method/status) — never
    // paths, ids or tokens.
    const startedAt = performance.now()
    let counted = false
    const recordRequest = (): void => {
      if (counted) return
      counted = true
      const method = req.method ?? 'GET'
      kernel.metrics.count('http.request', { method, status: String(res.statusCode) })
      kernel.metrics.observe('http.request.duration_ms', performance.now() - startedAt, { method })
    }
    res.on('finish', recordRequest)
    res.on('close', recordRequest)
    route(req, res, kernel, token, configPin, configRedacted, host)
  })
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, host, () => {
      const address = server.address()
      const actualPort = typeof address === 'object' && address !== null ? address.port : port
      resolve({ server, url: `http://${host}:${actualPort}`, port: actualPort })
    })
  })
}
