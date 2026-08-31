/**
 * Per-role tool ACL (design §4.1 工具面原则, §1.3 Least privilege).
 * Every research tool declares its allowed roles; a `tools/pre-execute`
 * listener denies calls outside the caller's role. Scholar never executes,
 * Writer never writes evidence, Runner has no DSH credentials.
 * @module @dsh-scholar/research-plugin/acl
 */

export type ResearchRole =
  | 'none'
  | 'director'
  | 'scholar'
  | 'curator'
  | 'idea-panel'
  | 'architect'
  | 'engineer'
  | 'operator'
  | 'statistician'
  | 'writer'
  | 'reviewer'
  | 'auditor'

export const RESEARCH_ROLES: readonly ResearchRole[] = [
  'none', 'director', 'scholar', 'curator', 'idea-panel', 'architect', 'engineer',
  'operator', 'statistician', 'writer', 'reviewer', 'auditor',
]

/** Session-bound methodology entry points callable by the root DSH
 * conversation. They cannot name an arbitrary project; each resolves the
 * caller's persisted session link before any read or write. */
export const DSH_SESSION_METHODOLOGY_TOOLS = [
  'research_methodology_status',
  'research_assurance_run',
  'research_protocol_record',
  'research_synthesis_record',
  'research_writing_review_record',
  'research_knowledge_activate',
  'research_knowledge_deactivate',
] as const

/** Tools that require an explicit DSH Host confirmation before execution. */
export const RESEARCH_HUMAN_CONFIRMATION_TOOLS = [
  'research_knowledge_activate',
  'research_knowledge_deactivate',
  'research_assurance_run',
] as const

/** Canonical research tool names. Obsolete aliases are intentionally absent. */
export const RESEARCH_TOOLS = [
  // Bounded native-DSH conversation façade. Public to every DSH role, but it
  // only resolves the calling session and never grants a low-level capability.
  'dsh_scholar',
  'research_project',
  'research_phase',
  'research_gate_request',
  'research_budget',
  'research_status',
  ...DSH_SESSION_METHODOLOGY_TOOLS,
  'research_panel',
  'literature_search',
  'paper_resolve',
  'corpus_snapshot',
  'passage_lookup',
  'idea_create',
  'idea_compare',
  'novelty_audit',
  'experiment_register',
  'experiment_submit',
  'experiment_status',
  'experiment_cancel',
  'evidence_note_create',
  'claim_create',
  'claim_verify_request',
  'analysis_request',
  'workspace_snapshot',
  'patch_apply',
  'baseline_prepare',
  'baseline_verify',
  'test_run',
  'manuscript_build',
  'manuscript_review',
  'release_bundle_request',
  // ONBOARD-01 intake prepare surface (research-onboarding.md §2): agents
  // may begin/stage/scan/propose; Human answers and adopt stay in the
  // authenticated native question UI/BFF.
  'research_intake_begin',
  'research_intake_stage',
  'research_intake_scan',
  'research_intake_propose',
] as const

/** Tool surface per role (design §4.1 table) — canonical names only. */
export const ROLE_TOOLS: Record<ResearchRole, readonly string[]> = {
  none: ['dsh_scholar', ...DSH_SESSION_METHODOLOGY_TOOLS],
  director: ['research_project', 'research_phase', 'research_gate_request', 'research_budget', 'research_status', 'research_panel', 'release_bundle_request', ...DSH_SESSION_METHODOLOGY_TOOLS],
  // ONBOARD-01 (research-onboarding.md §2): the researcher (scholar) role
  // prepares intakes — begin/stage/scan/propose. There is no Human-answer or
  // adopt tool: those actions belong to the Human PI via the
  // authenticated BFF/UI (researcher/viewer/auditor project members are
  // likewise 403 on the kernel's adopt route).
  scholar: ['literature_search', 'paper_resolve', 'corpus_snapshot', 'passage_lookup', 'research_status', 'research_methodology_status', 'research_synthesis_record', 'research_intake_begin', 'research_intake_stage', 'research_intake_scan', 'research_intake_propose'],
  curator: ['literature_search', 'paper_resolve', 'corpus_snapshot', 'passage_lookup', 'research_status'],
  'idea-panel': ['idea_create', 'idea_compare', 'novelty_audit', 'literature_search', 'research_status'],
  architect: ['experiment_register', 'research_status', 'research_methodology_status', 'research_protocol_record', 'experiment_status'],
  engineer: ['workspace_snapshot', 'patch_apply', 'baseline_prepare', 'baseline_verify', 'test_run', 'research_status', 'experiment_status'],
  operator: ['experiment_submit', 'experiment_status', 'experiment_cancel', 'research_status'],
  statistician: ['evidence_note_create', 'claim_create', 'claim_verify_request', 'analysis_request', 'research_status', 'experiment_status'],
  writer: ['manuscript_build', 'research_status', 'research_methodology_status', 'research_writing_review_record'],
  reviewer: ['manuscript_review', 'claim_verify_request', 'research_status', 'research_methodology_status', 'research_writing_review_record'],
  auditor: ['claim_verify_request', 'manuscript_review', 'research_status', 'research_methodology_status', 'research_writing_review_record'],
}

/** v2 §3.1: unknown/unregistered agents default to `none` (deny), NOT director. */
export const DEFAULT_ROLE: ResearchRole = 'none'

/** Fail-closed project fence for stage-subagent tool calls. The child may
 * name its bound project explicitly, but may never use an arbitrary project
 * or job id to escape that scope. */
export async function stageProjectScopeDenial(
  projectScope: string,
  args: unknown,
  projectForJob: (jobId: string) => Promise<string>,
): Promise<string | undefined> {
  const record = args !== null && typeof args === 'object' && !Array.isArray(args)
    ? args as Record<string, unknown>
    : {}
  if (typeof record.project_id === 'string' && record.project_id !== '' && record.project_id !== projectScope) {
    return 'stage subagent project scope does not match project_id'
  }
  if (typeof record.job_id === 'string' && record.job_id !== '') {
    try {
      if (await projectForJob(record.job_id) !== projectScope) {
        return 'stage subagent project scope does not match job_id'
      }
    } catch {
      return 'stage subagent job scope could not be verified'
    }
  }
  return undefined
}

/** In-memory session → role registry (roles are set per session). */
export class RoleRegistry {
  private readonly roles = new Map<string, ResearchRole>()

  set(sessionId: string, role: ResearchRole): void {
    this.roles.set(sessionId, role)
  }

  delete(sessionId: string): void {
    this.roles.delete(sessionId)
  }

  get(sessionId: string | undefined): ResearchRole {
    if (sessionId === undefined) return DEFAULT_ROLE
    return this.roles.get(sessionId) ?? DEFAULT_ROLE
  }

  /** Whether the role may call one canonical tool. */
  allows(role: ResearchRole, toolName: string): boolean {
    return toolName === 'dsh_scholar' || ROLE_TOOLS[role].includes(toolName)
  }
}
