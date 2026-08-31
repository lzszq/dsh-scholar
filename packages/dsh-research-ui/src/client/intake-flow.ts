/**
 * ONBOARD-01 intake client logic layer (research-onboarding.md,
 * api-contracts.md §16, acceptance-tests.md §8.1 / §21 init-resume-intake-
 * grill): PURE functions that turn the kernel's IntakeProjection into the
 * wizard step model, the per-step NextAction guidance list and stable
 * error-code copy. No DOM — the modal layer (modals/intake.ts) only
 * assembles nodes from this model (same pattern as next-action-cards.ts).
 *
 * Every step is DERIVED from the durable projection: re-entering the page
 * (or reopening the wizard) refetches GET .../intake/{iid} and resumes at
 * the exact step — nothing lives in the browser only.
 */
import { t } from './i18n/index'
import type {
  GrillAnswerViewLite, IntakeArtifactLite, IntakeProjectionLite,
  NextActionV2, PhaseProposalLite,
} from './types'

/** Wizard step order (pipeline display + state machine). */
export const INTAKE_STEPS = ['begin', 'stage', 'scan', 'grill', 'propose', 'adopt', 'done'] as const
export type IntakeStep = (typeof INTAKE_STEPS)[number]

/** Session statuses in which an intake is still recoverable/continuable
 *  (mirrors research-schemas INTAKE_ACTIVE_STATUSES). */
export const INTAKE_ACTIVE_STATUSES = [
  'draft', 'uploading', 'scanning', 'needs_input', 'grilling',
  'proposal_ready', 'awaiting_human',
] as const

/** Resolve the one resumable Intake from a project list response. */
export function activeIntakeId(
  rows: Array<{ intake_id?: string; status?: string }> | null | undefined,
): string | null {
  const active = rows?.find(row => typeof row.intake_id === 'string'
    && row.intake_id !== ''
    && (INTAKE_ACTIVE_STATUSES as readonly string[]).includes(row.status ?? ''))
  return active?.intake_id ?? null
}

/** Terminal statuses: the session can no longer continue. */
export const INTAKE_TERMINAL_STATUSES = ['rejected', 'expired', 'failed'] as const

/** Claimed target-phase options (research-onboarding.md §6; the question
 *  taxonomy is trimmed per phase by the server). */
export const INTAKE_PHASE_OPTIONS = [
  'brief', 'survey', 'idea', 'baseline', 'contract',
  'experiment', 'evidence', 'writing', 'review', 'release',
] as const
export type IntakePhaseOption = (typeof INTAKE_PHASE_OPTIONS)[number]

/** Client-side pre-check for the UPLOAD-01 cap; the kernel re-enforces the
 *  same limit (413 payload_too_large) and the BFF 413s before forwarding. */
export const INTAKE_MAX_FILE_BYTES = 32 * 1024 * 1024

/** i18n key per stable kernel error code (server.ts errorEnvelope). Codes
 *  absent here render the machine code verbatim (wire data). */
export const INTAKE_ERROR_KEYS: Record<string, string> = {
  intake_not_found: 'intake.error.intake_not_found',
  intake_state_conflict: 'intake.error.intake_state_conflict',
  intake_expired: 'intake.error.intake_expired',
  artifact_quarantined: 'intake.error.artifact_quarantined',
  question_required: 'intake.error.question_required',
  proposal_stale: 'intake.error.proposal_stale',
  acceptance_required: 'intake.error.acceptance_required',
  phase_unadoptable: 'intake.error.phase_unadoptable',
  project_revision_conflict: 'intake.error.project_revision_conflict',
  cross_project_reference: 'intake.error.cross_project_reference',
  question_revision_conflict: 'intake.error.question_revision_conflict',
  unknown_question: 'intake.error.unknown_question',
  intake_artifact_not_found: 'intake.error.intake_artifact_not_found',
  principal_required: 'intake.error.principal_required',
  payload_too_large: 'intake.error.payload_too_large',
  invalid_file_name: 'intake.error.invalid_file_name',
  stage_corrupted: 'intake.error.stage_corrupted',
  idempotency_conflict: 'intake.error.idempotency_conflict',
  validation_error: 'intake.error.validation_error',
  missing_file: 'intake.error.missing_file',
  multiple_files: 'intake.error.multiple_files',
  unsupported_media_type: 'intake.error.unsupported_media_type',
  project_not_found: 'intake.error.project_not_found',
  network_error: 'intake.error.network_error',
  unauthorized: 'intake.error.unauthorized',
  http_error: 'intake.error.http_error',
}

/** i18n key per session status (intake.status.<status>). */
export const INTAKE_STATUS_KEYS: Record<string, string> = {
  draft: 'intake.status.draft',
  uploading: 'intake.status.uploading',
  scanning: 'intake.status.scanning',
  needs_input: 'intake.status.needs_input',
  grilling: 'intake.status.grilling',
  proposal_ready: 'intake.status.proposal_ready',
  awaiting_human: 'intake.status.awaiting_human',
  accepting: 'intake.status.accepting',
  accepted: 'intake.status.accepted',
  rejected: 'intake.status.rejected',
  expired: 'intake.status.expired',
  failed: 'intake.status.failed',
}

/** i18n key per target phase (intake.phase.<phase>). */
export const INTAKE_PHASE_KEYS: Record<string, string> = {
  brief: 'intake.phase.brief',
  survey: 'intake.phase.survey',
  idea: 'intake.phase.idea',
  baseline: 'intake.phase.baseline',
  contract: 'intake.phase.contract',
  experiment: 'intake.phase.experiment',
  evidence: 'intake.phase.evidence',
  writing: 'intake.phase.writing',
  review: 'intake.phase.review',
  release: 'intake.phase.release',
}

/** Resolve stable error-code copy: known codes → `code — i18n text`, unknown
 *  codes → the machine code verbatim (+ server message when present). Never
 *  throws; missing dictionary keys are reported by the i18n adapter. */
export function intakeErrorText(code: string | undefined, message?: string): string {
  const stable = typeof code === 'string' ? code : ''
  if (stable === '') return message ?? ''
  const key = INTAKE_ERROR_KEYS[stable]
  if (key === undefined) {
    return message !== undefined && message !== '' ? `${stable} — ${message}` : stable
  }
  return `${stable} — ${t('intake', key)}`
}

/** Stable phase label (machine value + i18n copy). */
export function intakePhaseText(phase: string | null | undefined): string {
  if (phase === undefined || phase === null || phase === '') return t('intake', 'intake.begin.anyPhase')
  const key = INTAKE_PHASE_KEYS[phase]
  return key !== undefined ? `${phase} — ${t('intake', key)}` : phase
}

/** Session status label via the i18n dictionary; unknown statuses render the
 *  wire value verbatim (future statuses stay honest). */
export function intakeStatusText(status: string | undefined): string {
  if (status === undefined || status === '') return ''
  const key = INTAKE_STATUS_KEYS[status]
  return key !== undefined ? t('intake', key) : status
}

/* ─────────────────────────── step derivation ─────────────────────────── */

export interface IntakeStepModel {
  /** Current wizard step (re-derived from the projection on every render). */
  step: IntakeStep
  /** Wire session status ('' when no session yet). */
  status: string
  statusText: string
  /** Terminal kind ('rejected' | 'expired' | 'failed') or null. */
  terminal: string | null
  /** True when every required question has a non-empty answer. */
  canPropose: boolean
  /** Required question codes still unanswered (proposal blocker). */
  requiredOpen: string[]
  /** Staged artifact count (drives scan readiness). */
  artifactCount: number
  /** i18n step title key for the current step. */
  stepTitleKey: string
}

const STEP_TITLE_KEYS: Record<IntakeStep, string> = {
  begin: 'intake.step.begin',
  stage: 'intake.step.stage',
  scan: 'intake.step.scan',
  grill: 'intake.step.grill',
  propose: 'intake.step.propose',
  adopt: 'intake.step.adopt',
  done: 'intake.step.done',
}

/** Map a projection to the wizard step — the single source of truth for
 *  resume: session status decides the step, so any durable state recovers. */
export function intakeStepModel(p: IntakeProjectionLite | null | undefined): IntakeStepModel {
  const session = p?.session
  const status = typeof session?.status === 'string' ? session.status : ''
  const artifacts = Array.isArray(p?.artifacts) ? p.artifacts : []
  const questions = Array.isArray(p?.questions) ? p.questions : []
  const requiredOpen = questions
    .filter(q => q.required === true)
    .filter(q => typeof q.answer !== 'string' || q.answer === '')
    .map(q => q.question_code ?? '')
    .filter(code => code !== '')
  let step: IntakeStep = 'begin'
  if (status === 'draft' || status === 'uploading') step = 'stage'
  else if (status === 'scanning') step = 'scan'
  else if (status === 'needs_input' || status === 'grilling') step = 'grill'
  else if (status === 'proposal_ready') step = 'propose'
  else if (status === 'awaiting_human' || status === 'accepting') step = 'adopt'
  else if (status === 'accepted') step = 'done'
  const terminal = (INTAKE_TERMINAL_STATUSES as readonly string[]).includes(status) ? status : null
  return {
    step,
    status,
    statusText: intakeStatusText(status),
    terminal,
    canPropose: requiredOpen.length === 0,
    requiredOpen,
    artifactCount: artifacts.length,
    stepTitleKey: STEP_TITLE_KEYS[step],
  }
}

/** Pipeline step order for the wizard header (begin is implicit — the first
 *  rendered step after a session exists is stage). */
export function intakePipelineSteps(): IntakeStep[] {
  return [...INTAKE_STEPS]
}

/* ─────────────────────────── NextAction guidance ─────────────────────────── */

/** One guidance row for the current intake step. */
export interface IntakeGuidanceItem {
  /** Stable machine code (intake_* — matches the kernel overlay). */
  code: string
  /** Resolved i18n label. */
  label: string
  /** Resolved i18n reason. */
  reason: string
  /** Kernel tone semantics: ready / blocked / done. */
  tone: 'ready' | 'blocked' | 'done'
  intakeId: string
}

/** Guidance code → i18n keys (zh/en parity enforced statically). */
export const INTAKE_GUIDANCE_KEYS: Record<string, { label: string; reason: string }> = {
  intake_resume: { label: 'intake.guidance.resume', reason: 'intake.guidance.resume.reason' },
  intake_scan: { label: 'intake.guidance.scan', reason: 'intake.guidance.scan.reason' },
  intake_answer: { label: 'intake.guidance.answer', reason: 'intake.guidance.answer.reason' },
  intake_propose: { label: 'intake.guidance.propose', reason: 'intake.guidance.propose.reason' },
  intake_adopt: { label: 'intake.guidance.adopt', reason: 'intake.guidance.adopt.reason' },
}

/** Status-derived guidance (used inside the wizard where the project
 *  projection may not be fetched yet). One base item per active session
 *  plus the status step item — mirrors the kernel intakeOverlay codes. */
export function intakeStatusGuidance(p: IntakeProjectionLite | null | undefined): IntakeGuidanceItem[] {
  const session = p?.session
  const status = typeof session?.status === 'string' ? session.status : ''
  const intakeId = typeof session?.intake_id === 'string' ? session.intake_id : ''
  if (intakeId === '' || !(INTAKE_ACTIVE_STATUSES as readonly string[]).includes(status)) return []
  const artifactCount = Array.isArray(p?.artifacts) ? p.artifacts.length : 0
  const items: IntakeGuidanceItem[] = [guidanceItem('intake_resume', 'ready', intakeId)]
  if (status === 'uploading' && artifactCount > 0) items.push(guidanceItem('intake_scan', 'ready', intakeId))
  if (status === 'needs_input' || status === 'grilling') items.push(guidanceItem('intake_answer', 'ready', intakeId))
  if (status === 'proposal_ready') items.push(guidanceItem('intake_propose', 'ready', intakeId))
  if (status === 'awaiting_human') items.push(guidanceItem('intake_adopt', 'ready', intakeId))
  return items
}

function guidanceItem(code: string, tone: IntakeGuidanceItem['tone'], intakeId: string): IntakeGuidanceItem {
  const keys = INTAKE_GUIDANCE_KEYS[code]
  return {
    code,
    label: keys !== undefined ? t('intake', keys.label) : code,
    reason: keys !== undefined ? t('intake', keys.reason) : '',
    tone,
    intakeId,
  }
}

/**
 * Full guidance list for a step: the kernel's structured next_actions_v2
 * (authoritative — GUIDE-01 intake overlay actions) merged with the
 * status-derived base items, deduped by code in projection order. `v2` is
 * the project projection's next_actions_v2 (may be absent → status-derived
 * fallback keeps the wizard self-sufficient).
 */
export function intakeGuidance(
  p: IntakeProjectionLite | null | undefined,
  v2?: NextActionV2[] | null,
): IntakeGuidanceItem[] {
  const intakeId = typeof p?.session?.intake_id === 'string' ? p.session.intake_id : ''
  const status = typeof p?.session?.status === 'string' ? p.session.status : ''
  const items: IntakeGuidanceItem[] = intakeStatusGuidance(p)
  if (Array.isArray(v2)) {
    for (const action of v2) {
      const code = typeof action.code === 'string' ? action.code : ''
      if (!code.startsWith('intake_')) continue
      if (items.some(item => item.code === code)) continue
      if (!(INTAKE_ACTIVE_STATUSES as readonly string[]).includes(status)) continue
      const keys = INTAKE_GUIDANCE_KEYS[code]
      const tone = action.state === 'blocked' || action.state === 'done' ? action.state : 'ready'
      items.push({
        code,
        label: keys !== undefined ? t('intake', keys.label) : (typeof action.label === 'string' ? action.label : code),
        reason: keys !== undefined ? t('intake', keys.reason) : (typeof action.reason === 'string' ? action.reason : ''),
        tone,
        intakeId,
      })
    }
  }
  return items
}

/* ─────────────────────────── grill / propose / adopt ─────────────────────────── */

/** Answer draft shape (server GrillAnswerInput mirror). */
export interface GrillAnswerDraft {
  question_code: string
  answer: string
  question_revision: number
}

/** Answers POST body contains domain input only. The BFF supplies the
 * authenticated Human identity through its trusted header seam. */
export function intakeAnswersPayload(answers: GrillAnswerDraft[]): Record<string, unknown> {
  return { answers }
}

/** Whether the proposal step is reachable (scan done + required answered). */
export function intakeProposeReady(p: IntakeProjectionLite | null | undefined): boolean {
  return intakeStepModel(p).canPropose
}

/** Adopt POST body (ONBOARD-01 §7): pins the proposal revision (+ target
 *  project revision when known) so stale adopts 409 instead of overwriting. */
export function intakeAdoptPayload(proposal: PhaseProposalLite | null | undefined, targetRevision?: number): Record<string, unknown> {
  const body: Record<string, unknown> = {
    expected_proposal_revision: typeof proposal?.revision === 'number' ? proposal.revision : 0,
  }
  if (targetRevision !== undefined && Number.isFinite(targetRevision)) body.expected_target_revision = targetRevision
  return body
}

/** Begin POST body (target_phase drives the question taxonomy; nullable
 *  target = taxonomy decides from the answers). */
export function intakeBeginPayload(sourceLabel: string, targetPhase: string | null | undefined): Record<string, unknown> {
  const body: Record<string, unknown> = { source_label: sourceLabel }
  if (targetPhase !== undefined && targetPhase !== null && targetPhase !== '') body.target_phase = targetPhase
  return body
}

/** Client-side upload pre-check: returns an i18n key when the file must be
 *  rejected locally (null = OK to send; the server enforces the same rules
 *  again — defense in depth). */
export function intakeUploadIssue(file: { name?: string; size?: number } | null | undefined): string | null {
  if (file === null || file === undefined) return 'intake.error.missing_file'
  const name = typeof file.name === 'string' ? file.name : ''
  if (name === '' || name.includes('/') || name.includes('\\') || name.includes('\u0000')) return 'intake.error.invalid_file_name'
  if (typeof file.size === 'number' && file.size > INTAKE_MAX_FILE_BYTES) return 'intake.error.payload_too_large'
  return null
}

/** Quarantine verdict label key per artifact (research-onboarding.md §4). */
export const INTAKE_VERDICT_KEYS: Record<string, string> = {
  staged: 'intake.verdict.staged',
  scanning: 'intake.verdict.scanning',
  clean: 'intake.verdict.clean',
  quarantined: 'intake.verdict.quarantined',
  rejected: 'intake.verdict.rejected',
}

export function intakeVerdictText(artifact: IntakeArtifactLite): string {
  const quarantine = typeof artifact.quarantine === 'string' ? artifact.quarantine : ''
  const key = INTAKE_VERDICT_KEYS[quarantine]
  return key !== undefined ? t('intake', key) : quarantine
}

/** Verdict tone (drives the artifact row visual). */
export function intakeVerdictTone(artifact: IntakeArtifactLite): 'staged' | 'clean' | 'quarantined' | 'rejected' {
  const q = typeof artifact.quarantine === 'string' ? artifact.quarantine : ''
  if (q === 'clean') return 'clean'
  if (q === 'rejected') return 'rejected'
  if (q === 'quarantined') return 'quarantined'
  return 'staged'
}

/** Scan summary counters (server scan_summary; defaults keep the UI honest
 *  when the field is absent). */
export interface IntakeScanSummary {
  artifact_count: number
  clean: number
  quarantined: number
  rejected: number
  av_available: boolean
}

export function intakeScanSummary(p: IntakeProjectionLite | null | undefined): IntakeScanSummary {
  const raw = p?.session?.scan_summary
  const num = (key: string): number => {
    const value = raw?.[key]
    return typeof value === 'number' && Number.isFinite(value) ? value : 0
  }
  return {
    artifact_count: num('artifact_count'),
    clean: num('clean'),
    quarantined: num('quarantined'),
    rejected: num('rejected'),
    av_available: raw?.av_available === true,
  }
}

/** Adopt idempotency input: a stable per-session key derived from the
 *  intake id (client-side; the server replays the same receipt on retry). */
export function intakeIdempotencyKey(intakeId: string): string {
  return `ui-adopt-${intakeId}`
}

/** Extract the intake id from a NextAction refs list (kernel overlay emits
 *  {kind:'intake', id} plus {kind:'project', id}). */
export function intakeRefId(refs: NextActionV2['refs']): string | null {
  if (!Array.isArray(refs)) return null
  for (const ref of refs) {
    if (ref?.kind === 'intake' && typeof ref.id === 'string' && ref.id !== '') return ref.id
  }
  return null
}

/** Extract the project id from a NextAction refs list (needed to call the
 *  project-scoped intake routes). */
export function intakeProjectRefId(refs: NextActionV2['refs']): string | null {
  if (!Array.isArray(refs)) return null
  for (const ref of refs) {
    if (ref?.kind === 'project' && typeof ref.id === 'string' && ref.id !== '') return ref.id
  }
  return null
}

/** Question list helpers: answered/unanswered splits for the grill step. */
export function intakeQuestionState(q: GrillAnswerViewLite): 'answered' | 'unanswered' {
  return typeof q.answer === 'string' && q.answer !== '' ? 'answered' : 'unanswered'
}

export function intakeAnsweredCount(questions: GrillAnswerViewLite[] | undefined): { answered: number; total: number } {
  const list = Array.isArray(questions) ? questions : []
  return { answered: list.filter(q => intakeQuestionState(q) === 'answered').length, total: list.length }
}
