/**
 * INIT-GRILL-02 (init-grill-upload-models.md §2): the conversational Brief
 * prompt model behind post-create onboarding. After creating a project the
 * UI asks each Init Grill question inside Chat and reuses its composer.
 * PURE logic — no DOM, no fetch — so unit tests can assert every state
 * transition without a browser (mirrors next-action-cards.ts).
 *
 * The card is driven by two server reads (both v2 — the kernel serves the
 * Grill routes only under /v2, see server.ts handleV2; chat.ts's
 * The Chat conversation pipeline already uses /v2/projects/{id}/grill):
 *   GET /v2/projects/{id}         → project row with brief_status
 *   GET /v2/projects/{id}/grill   → projectGrillProjection
 *
 * and renders only while the project is still collecting its Brief
 * (brief_status=collecting). Confirmed projects have no active prompt.
 *
 * `loadGrillGuideState` is the async seam with an INJECTABLE fetcher so the
 * chat wiring (chat.ts) and the tests share one implementation: the chat
 * passes its `api()` bridge, tests pass a mock map.
 */

export const GRILL_TOTAL_QUESTIONS = 7

export type GrillDisposition = 'answered' | 'skipped' | 'unknown'
export type ProjectBriefStatus = 'collecting' | 'confirmed'

export interface GrillQuestion {
  question_code: string
  question_revision: number
  prompt_key: string
  required: boolean
}

export interface GrillAnswer {
  question_code: string
  question_revision: number
  value: unknown
  disposition: string
  answered_by: string
  answered_at: string
}

export interface GrillProjection {
  project_id: string
  project_revision: number
  intake_id: string
  intake_revision: number
  question: GrillQuestion | null
  answers: GrillAnswer[]
  brief_preview: { problem: string; scope: string; primary_metrics: string[]; target_outputs: string[] }
  ready_to_confirm: boolean
}

/** The state the current conversational Brief prompt renders from. */
export interface GrillGuideModelState {
  visible: boolean
  titleKey: string
  /** Plain numeric form ("3 / 7") — machine readable. The localized chrome
   *  label is the `grill-guide.progress` key with {answered}/{total}. */
  progressText: string
  current: { questionCode: string; promptKey: string; required: boolean } | null
  readyToConfirm: boolean
  answeredCount: number
  totalCount: number
  nextActionKey: string
}

export const GRILL_GUIDE_TITLE_KEY = 'grill-guide.title'
export const GRILL_GUIDE_NEXT_ANSWER = 'grill-guide.next.answer'
export const GRILL_GUIDE_NEXT_CONFIRM = 'grill-guide.next.confirm'
export const GRILL_GUIDE_NEXT_DONE = 'grill-guide.next.done'

/** Stable prompt-key per Grill question code (the wire carries prompt_key on
 *  the CURRENT question; answered rows only carry the code, so the answered
 *  list maps code → prompt key to reuse the same question copy). */
export function grillQuestionLabelKey(questionCode: string): string {
  const map: Record<string, string> = {
    'brief.problem': 'grill.question.problem',
    'brief.scope': 'grill.question.scope',
    'brief.questions': 'grill.question.questions',
    'brief.primary_metrics': 'grill.question.primaryMetrics',
    'brief.target_outputs': 'grill.question.targetOutputs',
    'brief.constraints': 'grill.question.constraints',
    'brief.material_context': 'grill.question.materialContext',
  }
  return map[questionCode] ?? questionCode
}

/**
 * The conversational prompt model (INIT-GRILL-02):
 *   - brief_status=collecting + projection.question → visible, current set;
 *   - collecting + ready_to_confirm → visible, current=null, readyToConfirm;
 *   - non-collecting → visible=false (project confirmed, guide done);
 *   - degenerate (collecting but no question and not ready) → invisible.
 * answeredCount counts handled rows (any disposition) — the same measure the
 * server uses for readiness, so the progress bar always matches
 * ready_to_confirm.
 */
export function grillGuideModel(
  projection: GrillProjection,
  projectStatus: ProjectBriefStatus | undefined,
): GrillGuideModelState {
  const answeredCount = projection.answers.length
  const totalCount = GRILL_TOTAL_QUESTIONS
  const collecting = projectStatus === 'collecting'
  const current = projection.question === null
    ? null
    : {
        questionCode: projection.question.question_code,
        promptKey: projection.question.prompt_key,
        required: projection.question.required,
      }
  const readyToConfirm = collecting && projection.ready_to_confirm && current === null
  const visible = collecting && (current !== null || projection.ready_to_confirm)
  let nextActionKey = GRILL_GUIDE_NEXT_DONE
  if (visible && current !== null) nextActionKey = GRILL_GUIDE_NEXT_ANSWER
  else if (visible && readyToConfirm) nextActionKey = GRILL_GUIDE_NEXT_CONFIRM
  return {
    visible,
    titleKey: GRILL_GUIDE_TITLE_KEY,
    progressText: `${answeredCount} / ${totalCount}`,
    current,
    readyToConfirm,
    answeredCount,
    totalCount,
    nextActionKey,
  }
}

/** POST /grill/answers body builder. `value` is trimmed; the `value` field is
 *  omitted when empty (the server rejects answered-without-value with 422
 *  question_required; skipped/unknown tolerate an omitted value). */
export function grillAnswerPayload(
  question: { question_code: string; question_revision: number },
  value: string,
  disposition: GrillDisposition,
): { question_code: string; question_revision: number; value?: string; disposition: GrillDisposition } {
  const trimmed = value.trim()
  return {
    question_code: question.question_code,
    question_revision: question.question_revision,
    ...(trimmed !== '' ? { value: trimmed } : {}),
    disposition,
  }
}

/** POST /grill/confirm body builder (expected revisions guard the write). */
export function grillConfirmPayload(projection: {
  project_revision: number
  intake_revision: number
}): { expected_project_revision: number; expected_intake_revision: number } {
  return {
    expected_project_revision: projection.project_revision,
    expected_intake_revision: projection.intake_revision,
  }
}

/**
 * Stable kernel error code → i18n key. Common envelope codes reuse the
 * intake wizard's existing `intake.error.*` copy (same envelope contract,
 * api-contracts.md §1); Grill-specific codes get their own `grill-guide.*`
 * keys. Unmapped codes return the raw code so the caller can show it
 * verbatim instead of inventing copy.
 */
export function grillErrorKey(code: string | undefined): string {
  const map: Record<string, string> = {
    principal_required: 'intake.error.principal_required',
    question_required: 'intake.error.question_required',
    question_revision_conflict: 'intake.error.question_revision_conflict',
    revision_conflict: 'grill-guide.error.revisionConflict',
    intake_revision_conflict: 'grill-guide.error.intakeRevisionConflict',
    idempotency_conflict: 'intake.error.idempotency_conflict',
    intake_state_conflict: 'intake.error.intake_state_conflict',
    brief_already_confirmed: 'grill-guide.error.briefConfirmed',
    scope_gate_exists: 'grill-guide.error.briefConfirmed',
    grill_question_unknown: 'intake.error.unknown_question',
    project_not_found: 'intake.error.project_not_found',
    validation_error: 'intake.error.validation_error',
    unauthorized: 'intake.error.unauthorized',
    network_error: 'intake.error.network_error',
    http_error: 'intake.error.http_error',
    role_forbidden: 'intake.error.acceptance_required',
  }
  return map[code ?? ''] ?? code ?? ''
}

/** Structural guard: is this value a kernel Grill projection? */
export function isGrillProjection(value: unknown): value is GrillProjection {
  if (typeof value !== 'object' || value === null) return false
  const v = value as Record<string, unknown>
  if (typeof v.project_id !== 'string') return false
  if (typeof v.project_revision !== 'number' || typeof v.intake_revision !== 'number') return false
  if (v.question !== null) {
    if (typeof v.question !== 'object' || v.question === null) return false
    const q = v.question as Record<string, unknown>
    if (typeof q.question_code !== 'string' || typeof q.question_revision !== 'number' || typeof q.prompt_key !== 'string') return false
  }
  return Array.isArray(v.answers) && typeof v.ready_to_confirm === 'boolean'
}

/** Fetcher seam — chat.ts injects its `api()` bridge; tests inject mocks. */
export type GrillGuideFetcher = (path: string) => Promise<unknown>

export interface GrillGuideLoaded {
  projectStatus: ProjectBriefStatus | undefined
  projection: GrillProjection
}

/**
 * Load + validate both reads for the conversational prompt. The Grill projection is
 * authoritative for `collecting`: only collecting projects carry a question
 * or ready_to_confirm=true, so when the project GET fails (or lags) the
 * status is derived from the projection instead of hiding the prompt.
 * Returns null when the projection is missing/malformed (caller stays
 * silent — the chat keeps working without the prompt).
 */
export async function loadGrillGuideState(
  fetchApi: GrillGuideFetcher,
  projectId: string,
): Promise<GrillGuideLoaded | null> {
  const encoded = encodeURIComponent(projectId)
  const [project, projection] = await Promise.all([
    fetchApi(`/v2/projects/${encoded}`),
    fetchApi(`/v2/projects/${encoded}/grill`),
  ])
  if (!isGrillProjection(projection)) return null
  const raw = (project as Record<string, unknown> | null)?.brief_status
  const wireStatus: ProjectBriefStatus | undefined = raw === 'collecting' || raw === 'confirmed' ? raw : undefined
  const projectStatus: ProjectBriefStatus | undefined = wireStatus
    ?? (projection.question !== null || projection.ready_to_confirm ? 'collecting' : 'confirmed')
  return { projectStatus, projection }
}
