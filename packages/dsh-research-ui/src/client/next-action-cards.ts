/**
 * GUIDE-01 NextAction v2 card model (gui-plugin-plan §5.1, api-contracts.md
 * §21): PURE logic that turns one structured kernel action into what the
 * Overview card should look like. No DOM — the
 * panel layer (panels/overview.ts) only assembles nodes from this model.
 *
 * Rendering rules (api-contracts.md §21 — UI 只负责翻译 label 与路由):
 *
 * - `title` — the kernel `label` is wire DATA, not chrome: when a stable
 *   i18n key exists for the action `code` (NEXT_ACTION_LABEL_KEYS) the label
 *   is translated via `t()`; otherwise the kernel label is shown verbatim
 *   (codes whose labels embed dynamic ids — `gate_decide`, `job_retry` —
 *   intentionally fall back, as do unknown/future codes).
 * - `tone` — the kernel `state` ('ready' | 'blocked' | 'done') maps to the
 *   card visual class of the same name.
 * - `disabled` — done actions are grayed out; blocked actions are disabled
 *   while they carry a non-empty `required` gap list; the `unknown` code is
 *   ALWAYS read-only (never a mutation CTA, api-contracts §21).
 * - `missingList` — `required` as an array names the missing preconditions;
 *   each known gap code is translated (NEXT_ACTION_GAP_KEYS), unknown gap
 *   codes render verbatim (wire data).
 * - `route` — the kernel `route` (gates/runs/evidence/manuscript/budget map
 *   to the same tab; ideas/contracts/release/overview converge on the
 *   Overview tab 'phase' — the four primary tabs, nav.ts). Unknown/future
 *   routes fall back to 'phase'; the `unknown` code yields NO route (no
 *   CTA). hasRoute=false cards render no button.
 * - `blockingNote` — `blocking=true` actions carry the chrome note that the
 *   phase cannot advance before this step.
 */
import type { NextActionV2, Projection } from './types'
import { getLocale, t, type Locale } from './i18n/index'
import { zh as overviewZh, en as overviewEn } from './i18n/locales/overview'

/** Kernel's NEXT_ACTION_UNKNOWN_CODE (research-schemas) — mirrored locally so
 *  the browser bundle stays dependency-light. */
export const NEXT_ACTION_UNKNOWN_CODE = 'unknown'

/** Kernel NextActionRoute values that are NOT panel tabs (nav.ts) and
 *  converge on the Overview tab (the phase panel hosts ideas/contracts and
 *  release/overview guidance). */
const ROUTE_TO_TAB: Record<string, string> = {
  chat: 'chat',
  gates: 'gates',
  runs: 'runs',
  evidence: 'evidence',
  manuscript: 'manuscript',
  budget: 'budget',
  ideas: 'phase',
  contracts: 'phase',
  release: 'phase',
  overview: 'phase',
}

/** i18n key per stable action code; codes absent here render the kernel
 *  label verbatim (their labels embed dynamic wire data). */
export const NEXT_ACTION_LABEL_KEYS: Record<string, string> = {
  scope_gate_submit: 'overview.nextaction.code.scope_gate_submit',
  survey_run: 'overview.nextaction.code.survey_run',
  idea_generate: 'overview.nextaction.code.idea_generate',
  idea_select: 'overview.nextaction.code.idea_select',
  idea_gate_approve: 'overview.nextaction.code.idea_gate_approve',
  baseline_reproduce: 'overview.nextaction.code.baseline_reproduce',
  contract_register: 'overview.nextaction.code.contract_register',
  contract_gate_approve: 'overview.nextaction.code.contract_gate_approve',
  pilot_formal_submit: 'overview.nextaction.code.pilot_formal_submit',
  evidence_verify: 'overview.nextaction.code.evidence_verify',
  manuscript_write: 'overview.nextaction.code.manuscript_write',
  reviewer_run: 'overview.nextaction.code.reviewer_run',
  release_bundle: 'overview.nextaction.code.release_bundle',
  release_gate: 'overview.nextaction.code.release_gate',
  gate_resolve: 'overview.nextaction.code.gate_resolve',
  project_stop: 'overview.nextaction.code.project_stop',
  project_archived: 'overview.nextaction.code.project_archived',
  project_released: 'overview.nextaction.code.project_released',
  project_stopped: 'overview.nextaction.code.project_stopped',
  budget_resolve: 'overview.nextaction.code.budget_resolve',
  // ONBOARD-01 intake overlay actions (GUIDE-01 landing): the wizard CTA is
  // a modal, so these cards carry route 'intake' (opened by the panel layer).
  intake_resume: 'overview.nextaction.code.intake_resume',
  intake_scan: 'overview.nextaction.code.intake_scan',
  intake_answer: 'overview.nextaction.code.intake_answer',
  intake_propose: 'overview.nextaction.code.intake_propose',
  intake_adopt: 'overview.nextaction.code.intake_adopt',
  unknown: 'overview.nextaction.code.unknown',
}

/** i18n key per known missing-precondition code; unknown gap codes render
 *  verbatim (wire data). */
export const NEXT_ACTION_GAP_KEYS: Record<string, string> = {
  approved_contract: 'overview.nextaction.missing.approved_contract',
  approved_idea: 'overview.nextaction.missing.approved_idea',
  baseline_reproduction: 'overview.nextaction.missing.baseline_reproduction',
  baseline_command: 'overview.nextaction.missing.baseline_command',
  code_snapshot: 'overview.nextaction.missing.code_snapshot',
  runner_environment: 'overview.nextaction.missing.runner_environment',
  succeeded_runs: 'overview.nextaction.missing.succeeded_runs',
  proposed_idea: 'overview.nextaction.missing.proposed_idea',
  pending_idea_gate: 'overview.nextaction.missing.pending_idea_gate',
  budget_headroom: 'overview.nextaction.missing.budget_headroom',
  repair_decision: 'overview.nextaction.missing.repair_decision',
  state_mapping: 'overview.nextaction.missing.state_mapping',
}

/** One Overview card, fully resolved for the current locale. */
export interface NextActionCardModel {
  code: string
  /** Resolved title: t() mapping when a dict key exists, else the kernel
   *  label verbatim (wire data). */
  title: string
  /** Visual tone class: 'ready' | 'blocked' | 'done'. */
  tone: 'ready' | 'blocked' | 'done'
  /** Whether the card CTA must be inert (done / blocked-with-gaps /
   *  unknown read-only). */
  disabled: boolean
  /** Kernel reason, verbatim (wire data). */
  reasonText: string
  /** Resolved missing-precondition texts (empty when none). */
  missingList: string[]
  /** Panel tab the card navigates to ('' = no CTA; 'intake' = the intake
   *  wizard modal, see intake-flow.ts). */
  route: string
  /** Whether a route CTA should be rendered. */
  hasRoute: boolean
  /** Blocking chrome note ('' when the action is not phase-blocking). */
  blockingNote: string
  /** State chrome label ('ready' | 'blocked' | 'done' copy). */
  stateLabel: string
  /** True for the kernel's read-only `unknown` code (api-contracts §21). */
  isUnknown: boolean
  /** Intake session id when the card is an intake_* action (wizard CTA). */
  intakeId: string | null
  /** Project id from the intake action refs (project-scoped routes). */
  intakeProjectId: string | null
  /** Who must perform the action ('human' | 'agent' | 'runner'); null when
   *  the kernel did not declare it (USAGE_GUIDE §11 "需要 Human/Agent/
   *  Runner" chip — rendered by the panel layer). */
  requiredBy: 'human' | 'agent' | 'runner' | null
  /** Safe, editable slash-command draft for whitelisted Chat interactions.
   * Never auto-submitted by the card click. */
  commandDraft: string | null
}

export interface NextActionCardContext {
  briefProblem?: string
}

/** True when `key` exists in the overview dictionary of `locale` (parity is
 *  enforced statically, so zh/en agree). */
function hasOverviewKey(key: string, locale: Locale): boolean {
  const dict = (locale === 'zh' ? overviewZh : overviewEn) as Record<string, string>
  return dict[key] !== undefined
}

/**
 * PURE card model for ONE structured action. Never throws: missing wire
 * fields degrade to safe defaults (unknown code, ready tone, no gaps, no
 * route) so a malformed action still renders as a read-only card.
 */
export function nextActionCardModel(
  action: NextActionV2,
  locale: Locale = getLocale(),
  context: NextActionCardContext = {},
): NextActionCardModel {
  const code = typeof action.code === 'string' && action.code !== '' ? action.code : NEXT_ACTION_UNKNOWN_CODE
  const isUnknown = code === NEXT_ACTION_UNKNOWN_CODE
  // ONBOARD-01 intake overlay actions open the intake wizard modal (route
  // 'intake'); the session/project ids come from the kernel refs.
  const isIntake = code.startsWith('intake_')
  const refs = Array.isArray(action.refs) ? action.refs : []
  const intakeId = isIntake ? (refs.find(r => r?.kind === 'intake' && typeof r.id === 'string')?.id ?? null) : null
  const intakeProjectId = isIntake ? (refs.find(r => r?.kind === 'project' && typeof r.id === 'string')?.id ?? null) : null
  const labelKey = NEXT_ACTION_LABEL_KEYS[code]
  const title = labelKey !== undefined && hasOverviewKey(labelKey, locale)
    ? t('overview', labelKey)
    : (typeof action.label === 'string' ? action.label : '')
  const state = action.state ?? 'ready'
  const tone: NextActionCardModel['tone'] = state === 'done' || state === 'blocked' ? state : 'ready'
  const required = Array.isArray(action.required) ? action.required.filter(g => typeof g === 'string' && g !== '') : []
  const requiredBy = action.required_by === 'human' || action.required_by === 'agent' || action.required_by === 'runner'
    ? action.required_by
    : null
  const missingList = required.map(gap => {
    const gapKey = NEXT_ACTION_GAP_KEYS[gap]
    return gapKey !== undefined && hasOverviewKey(gapKey, locale) ? t('overview', gapKey) : gap
  })
  // done → inert; blocked → inert only while preconditions are missing;
  // unknown → always read-only (never a mutation CTA).
  const disabled = state === 'done' || isUnknown || (state === 'blocked' && required.length > 0)
  const rawRoute = typeof action.route === 'string' ? action.route : ''
  // Compatibility: old kernels projected survey_run as route=runs. Runs only
  // contains durable Jobs and cannot launch a connector survey, so the stable
  // action code wins and opens project Chat instead.
  const route = isUnknown ? '' : (isIntake ? 'intake' : (code === 'survey_run' ? 'chat' : (ROUTE_TO_TAB[rawRoute] ?? 'phase')))
  const problem = typeof context.briefProblem === 'string'
    ? context.briefProblem.trim().replace(/\s+/g, ' ')
    : ''
  const commandDraft = code === 'survey_run'
    ? `/survey ${problem}`
    : code === 'contract_register' ? '/contract draft'
      : code === 'baseline_reproduce' ? '/reproduce'
        : null
  return {
    code,
    title,
    tone,
    disabled,
    reasonText: typeof action.reason === 'string' ? action.reason : '',
    missingList,
    route,
    hasRoute: route !== '',
    blockingNote: action.blocking === true ? t('overview', 'overview.nextaction.blocking') : '',
    stateLabel: t('overview', `overview.nextaction.state.${tone}`),
    isUnknown,
    intakeId,
    intakeProjectId,
    requiredBy,
    commandDraft,
  }
}

/** Resolve only the structured authority. Missing or malformed wire data is
 * a safe empty state; labels are never reinterpreted as executable actions. */
export interface NextActionInput { actions: NextActionV2[] }

export function resolveNextActionInput(p: Pick<Projection, 'next_actions_v2'>): NextActionInput {
  const v2 = p.next_actions_v2
  if (Array.isArray(v2) && v2.every(a => typeof a === 'object' && a !== null && typeof (a as NextActionV2).code === 'string')) {
    return { actions: v2 as NextActionV2[] }
  }
  return { actions: [] }
}
