/**
 * GUIDE-01 — authoritative structured NextAction projection (design §4.2
 * Projection API, domain-model.md §14, api-contracts.md §21).
 *
 * `nextActionProjection` is a PURE function of the project's authoritative
 * state: it never reads the database, never throws, and deterministically
 * derives one action set per (status, gates, jobs, budget, contracts,
 * ideas, evidence, claims). The Kernel calls it from `projectProjection` as
 * the only next-step authority. Unknown/future statuses degrade to
 * `code: 'unknown'` with a
 * read-only label, never a mutation CTA.
 *
 * Projection rules:
 * - one base action per project status (the phase's primary next step);
 * - one overlay action per pending gate NOT already referenced by a base
 *   action (budget gates → `budget_resolve`, others → `gate_decide`);
 * - one overlay action per failed/retryable job (`job_retry`, with
 *   attempts-exhausted → blocked + `repair_decision` requirement);
 * - `state` semantics: ready = do now, blocked = preconditions missing
 *   (listed in `required`), done = step already satisfied;
 * - `revision` pins the dependency object revision (project revision for
 *   gate decisions, contract version for run actions, idea version for the
 *   idea gate);
 * - `blocking` marks actions that gate phase completion (pending human
 *   gates, budget exhaustion, phase steps); retry/stop overlays are not
 *   blocking.
 *
 * Intake/Grill overlay actions (ONBOARD-01 landing, 2026-08-11): when the
 * project has an active intake session the projection also emits
 * `intake_resume` (any active status) plus one step overlay per session
 * status (`intake_scan` / `intake_answer` / `intake_propose` /
 * `intake_adopt`), so the UI can guide the human through begin→stage→
 * scan→grill→propose→adopt on every step (see intake-flow.ts client model).
 * @module @dsh-scholar/research-kernel/next-action
 */

import type {
  BudgetRecord,
  Claim,
  CorpusSnapshot,
  DirectionAdoption,
  DirectionProposal,
  EvidenceItem,
  ExperimentContract,
  Gate,
  IdeaCard,
  NextAction,
  NextActionRef,
  ResearchSynthesis,
  ResearchProject,
} from '@dsh-scholar/research-schemas'
import { DirectionGatePayload, NEXT_ACTION_UNKNOWN_CODE } from '@dsh-scholar/research-schemas'

/** Minimal durable-job view the projection needs (subset of JobRecord). */
export interface NextActionJob {
  job_id: string
  kind: string
  status: 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled' | 'retryable'
  failure_class: string | null
  attempts: number
  max_attempts: number
  contract_id: string | null
  created_at: string
}

/** Intake statuses in which an intake is still recoverable/continuable
 *  (mirrors research-schemas INTAKE_ACTIVE_STATUSES; the projection never
 *  guides a terminal session). */
export const INTAKE_ACTIVE_STATUSES: readonly string[] = [
  'draft', 'uploading', 'scanning', 'needs_input', 'grilling',
  'proposal_ready', 'awaiting_human',
]

/** Minimal durable intake view the projection needs (subset of IntakeSession
 *  + per-session artifact count; the kernel feeds it from listIntakes). */
export interface NextActionIntake {
  intake_id: string
  status: string
  target_phase: string | null
  artifact_count: number
}

/** Minimal reproduction view the projection needs (subset of
 *  PaperReproductionSpec + attempt/report counts; fed by the kernel's
 *  reproductionProjectionFor). Absent for legacy callers — the projection
 *  then keeps the pre-reproduction baseline_reproduce semantics. */
export interface NextActionReproduction {
  spec_id: string
  status: string
  revision: number
  attempt_count: number
  report_count: number
  /** 'pass' | 'fail' | 'blocked' | 'inconclusive' | null (no report yet). */
  latest_report_status: string | null
  has_running_attempt: boolean
}

/** Fresh, append-only Methodology facts used as a projection overlay. The
 * Methodology stream remains the only durable source; this is not another
 * loop state machine. */
export interface NextActionMethodology {
  syntheses: ResearchSynthesis[]
  proposals: DirectionProposal[]
  adoptions: DirectionAdoption[]
  /** Durable Gate/Decision pairs used to revalidate governed adoptions when
   * rebuilding the projection after restart. */
  direction_gate_approvals?: Array<{
    decision_id: string
    gate_id: string
    project_id: string
    decision: 'approved' | 'rejected' | 'revised'
    gate: Gate
  }>
}

export interface NextActionRunObservation {
  observation_id: string
  job_id: string
  run_id: string
  attempt_no: number
}

export interface NextActionSynthesisRequest {
  request_id: string
  trigger_run_ref: string
  reasons: string[]
  window: { from_event_seq: number; to_event_seq: number }
}

/** Authoritative state inputs the projection derives actions from. */
export interface NextActionContext {
  project: ResearchProject
  /** Pending human gates only (decided gates carry no next step). */
  gates: Gate[]
  jobs: NextActionJob[]
  budget: BudgetRecord
  contracts: ExperimentContract[]
  ideas: IdeaCard[]
  evidence: EvidenceItem[]
  claims: Claim[]
  corpus_snapshots: CorpusSnapshot[]
  /** Immutable code snapshots currently available to execution setup. */
  code_snapshots?: Array<{ snapshot_id: string }>
  /** Project default profile+target currently resolve to an enabled target. */
  runner_environment_ready?: boolean
  /** Active intake sessions of the project (ONBOARD-01 overlay; absent when
   *  the caller has no intake view — legacy callers stay compatible). */
  intakes?: NextActionIntake[]
  /** Paper reproduction specs (REPRO-01 overlay; absent for legacy
   *  callers — baseline_reproduce then keeps its job-based semantics). */
  reproductions?: NextActionReproduction[]
  /** Project-scoped Methodology stream records, in append order. */
  methodology?: NextActionMethodology
  /** Exact terminal attempts not yet consumed by an immutable outcome. */
  run_outcome_observations?: NextActionRunObservation[]
  /** Trigger receipts not yet covered by a stored synthesis window. */
  synthesis_requests?: NextActionSynthesisRequest[]
}

/** UI tab / operation path an action maps to. */
export type NextActionRoute = 'chat' | 'gates' | 'runs' | 'evidence' | 'manuscript' | 'budget' | 'ideas' | 'contracts' | 'release' | 'overview'

interface BaseActionSpec {
  code: string
  label: string
  reason: string
  route: NextActionRoute
  state: 'ready' | 'blocked' | 'done'
  required: true | string[]
  required_by: 'human' | 'agent' | 'runner'
  capability?: string
  revision: number | null
  refs: NextActionRef[]
  /** Defaults to `state !== 'done'`; sub-step overlays opt out. */
  blocking?: boolean
}

/** Stable per-instance action id: code + project id (+ ref id for overlays). */
function actionId(projectId: string, code: string, refId?: string): string {
  return refId === undefined ? `${code}:${projectId}` : `${code}:${projectId}:${refId}`
}

function action(projectId: string, spec: BaseActionSpec): NextAction {
  return {
    id: actionId(projectId, spec.code),
    code: spec.code,
    label: spec.label,
    reason: spec.reason,
    required: spec.required,
    route: spec.route,
    capability: spec.capability,
    revision: spec.revision,
    state: spec.state,
    blocking: spec.blocking ?? spec.state !== 'done',
    refs: spec.refs,
    required_by: spec.required_by,
  }
}

/** Highest version among `items`, or null when there are none. */
function latestVersion(contracts: ExperimentContract[]): number | null {
  if (contracts.length === 0) return null
  return contracts.reduce((max, c) => Math.max(max, c.version), 0)
}

/** Highest-version approved contract, or null when none is approved. */
function approvedContract(contracts: ExperimentContract[]): ExperimentContract | null {
  let best: ExperimentContract | null = null
  for (const c of contracts) {
    if (c.status === 'approved' && (best === null || c.version > best.version)) best = c
  }
  return best
}

function succeededJob(jobs: NextActionJob[], kinds: readonly string[]): boolean {
  return jobs.some(j => kinds.includes(j.kind) && j.status === 'succeeded')
}

/** REPRO-01: a persisted reproduction report in status=pass exists. */
function reproductionPassed(ctx: NextActionContext): boolean {
  return (ctx.reproductions ?? []).some(r => r.latest_report_status === 'pass')
}

/** REPRO-01: the project has reproduction specs (overlay context present). */
function hasReproduction(ctx: NextActionContext): boolean {
  return (ctx.reproductions ?? []).length > 0
}

/** Base per-status action(s) — the phase's primary next step (GUIDE-01). */
function baseActions(ctx: NextActionContext): BaseActionSpec[] {
  const { project, contracts, jobs, ideas, evidence, gates } = ctx
  const contract = approvedContract(contracts)
  const contractVersion = contract?.version ?? latestVersion(contracts)
  const proposedIdea = ideas.find(i => i.status === 'proposed')
  const proposedIdeaRefs: NextActionRef[] = ideas
    .filter(i => i.status === 'proposed')
    .map(i => ({ kind: 'idea', id: i.idea_id }))
  const approvedIdea = ideas.find(i => i.status === 'approved')
  const ideaVersion = approvedIdea?.version ?? proposedIdea?.version ?? null
  const ideaRefs: NextActionRef[] = approvedIdea === undefined ? [] : [{ kind: 'idea', id: approvedIdea.idea_id }]
  const contractRefs: NextActionRef[] = contract === null ? [] : [{ kind: 'contract', id: contract.contract_id }]
  const latestContract = contracts.length === 0 ? undefined : contracts[contracts.length - 1]
  const latestContractRefs: NextActionRef[] = latestContract === undefined ? [] : [{ kind: 'contract', id: latestContract.contract_id }]
  const pendingGateOf = (type: Gate['type']): Gate | undefined => gates.find(g => g.type === type)

  switch (project.status) {
    case 'DRAFT': {
      // INIT-GRILL-02: a name-only shell has no Scope Gate yet. Its active
      // Init Intake overlays below are the only authoritative next actions.
      if (project.brief_status === 'collecting') return []
      const scopeGate = pendingGateOf('scope')
      return [{
        code: 'scope_gate_submit',
        label: 'Complete Scope Gate',
        reason: scopeGate !== undefined
          ? `scope gate ${scopeGate.gate_id} is pending — approving it moves the project into SCOPED`
          : 'approve the Scope Gate to move the project into SCOPED',
        route: 'gates',
        state: 'ready',
        required: true,
        required_by: 'human',
        revision: project.revision,
        refs: scopeGate === undefined ? [] : [{ kind: 'gate', id: scopeGate.gate_id }],
      }]
    }
    case 'SCOPED':
      return [{
        code: 'survey_run',
        label: 'Run literature survey → corpus snapshot',
        reason: 'a corpus snapshot is required before idea generation can start',
        // Survey is a connector/Corpus action initiated through the
        // project-scoped Chat slash command, not a Runner Job.
        route: 'chat',
        state: 'ready',
        required: true,
        required_by: 'agent',
        revision: project.revision,
        refs: [],
      }]
    case 'SURVEYING':
      if (proposedIdeaRefs.length === 0) {
        const corpus = ctx.corpus_snapshots
          .filter(snapshot => snapshot.project_id === project.project_id
            && snapshot.frozen
            && snapshot.source_status === 'complete'
            && snapshot.papers.length > 0)
          .at(-1)
        const ideaAction: BaseActionSpec = {
          code: 'idea_generate',
          label: 'Generate idea cards',
          reason: corpus === undefined
            ? 'idea generation requires a frozen, complete, non-empty corpus snapshot'
            : 'the survey corpus is ready — produce candidate ideas',
          route: 'ideas',
          state: corpus === undefined ? 'blocked' : 'ready',
          required: corpus === undefined ? ['frozen_nonempty_corpus_snapshot'] : true,
          required_by: 'agent',
          revision: project.revision,
          refs: corpus === undefined ? [] : [{ kind: 'corpus_snapshot', id: corpus.snapshot_id }],
        }
        if (corpus !== undefined) return [ideaAction]
        return [ideaAction, {
          code: 'survey_run',
          label: 'Run literature survey → corpus snapshot',
          reason: 'the current survey has no complete non-empty frozen corpus; run or repair the survey before generating ideas',
          route: 'chat',
          state: 'ready',
          required: true,
          required_by: 'agent',
          revision: project.revision,
          refs: [],
        }]
      }
      return [{
        code: 'idea_select',
        label: 'Select an idea → novelty audit + Idea Gate',
        reason: `${proposedIdeaRefs.length} proposed idea(s) are ready — a human must select one for counter-search before the Idea Gate`,
        route: 'ideas',
        state: 'ready',
        required: true,
        required_by: 'human',
        revision: project.revision,
        refs: proposedIdeaRefs,
      }]
    case 'IDEATING': {
      const ideaGate = pendingGateOf('idea')
      return [{
        code: 'idea_gate_approve',
        label: 'Approve an Idea at the Idea Gate',
        reason: ideaGate !== undefined
          ? `idea gate ${ideaGate.gate_id} is pending — approving it freezes the winning idea`
          : 'an Idea must be approved at the Idea Gate before the baseline phase',
        route: 'gates',
        state: ideaGate === undefined ? 'blocked' : 'ready',
        required: ideaGate === undefined ? ['pending_idea_gate'] : true,
        required_by: 'human',
        revision: ideaGate !== undefined ? project.revision : ideaVersion,
        refs: ideaGate !== undefined ? [{ kind: 'gate', id: ideaGate.gate_id }, ...ideaRefs] : ideaRefs,
      }]
    }
    case 'IDEA_APPROVED':
      return [{
        code: 'contract_register',
        label: 'Draft Experiment Contract from the approved idea',
        reason: 'freeze the experiment design through a Human Contract Gate before any contract-bound baseline run',
        route: 'contracts',
        state: approvedIdea === undefined ? 'blocked' : 'ready',
        required: approvedIdea === undefined ? ['approved_idea'] : true,
        required_by: 'agent',
        capability: 'researcher',
        revision: ideaVersion,
        refs: ideaRefs,
      }]
    case 'CONTRACT_PENDING': {
      const contractGate = pendingGateOf('contract')
      return contractGate === undefined ? [{
        code: 'contract_register',
        label: 'Revise and resubmit Experiment Contract',
        reason: 'the previous Contract Gate is no longer pending — create a revised contract draft for human review',
        route: 'contracts',
        state: approvedIdea === undefined ? 'blocked' : 'ready',
        required: approvedIdea === undefined ? ['approved_idea'] : true,
        required_by: 'agent',
        capability: 'researcher',
        revision: ideaVersion,
        refs: [...ideaRefs, ...latestContractRefs],
      }] : [{
        code: 'contract_gate_approve',
        label: 'Review the Experiment Contract at the Contract Gate',
        reason: `contract gate ${contractGate.gate_id} is pending — approve or reject the bound draft`,
        route: 'gates',
        state: 'ready',
        required: true,
        required_by: 'human',
        revision: project.revision,
        refs: [{ kind: 'gate', id: contractGate.gate_id }, ...latestContractRefs],
      }]
    }
    case 'CONTRACT_APPROVED':
      {
        const baselineGaps: string[] = []
        // `baseline_run` is scientific prose/identity, never executable argv.
        // No command is persisted before the atomic startBaselineRun handoff.
        baselineGaps.push('baseline_command')
        if ((contract?.code_snapshot === undefined || contract.code_snapshot.trim() === '') && (ctx.code_snapshots?.length ?? 0) === 0) {
          baselineGaps.push('code_snapshot')
        }
        if (ctx.runner_environment_ready === false) baselineGaps.push('runner_environment')
        const snapshotRefs: NextActionRef[] = (ctx.code_snapshots ?? []).slice(0, 1).map(snapshot => ({
          kind: 'code_snapshot',
          id: snapshot.snapshot_id,
        }))
      return [{
        code: 'baseline_reproduce',
        label: 'Reproduce baseline in isolated runner',
        reason: baselineGaps.length === 0
          ? 'the approved contract and execution inputs are ready — start its baseline in the configured isolated environment'
          : 'the contract is approved; prepare the missing execution inputs before starting a real baseline job',
        route: 'runs',
        state: 'ready',
        required: baselineGaps.length === 0 ? true : baselineGaps,
        required_by: 'agent',
        capability: 'researcher',
        revision: contractVersion,
        refs: [...contractRefs, ...snapshotRefs],
      }]
      }
    case 'BASELINE_REPRO': {
      const baselineDone = reproductionPassed(ctx) || (!hasReproduction(ctx) && succeededJob(jobs, ['baseline']))
      return [
        {
          code: 'baseline_reproduce',
          label: 'Reproduce baseline in isolated runner',
          reason: baselineDone
            ? 'the contract-bound baseline completed successfully'
            : 'run the approved contract baseline before pilot and formal experiments',
          route: 'runs',
          state: baselineDone ? 'done' : 'ready',
          required: true,
          required_by: 'agent',
          capability: 'researcher',
          revision: contractVersion,
          refs: contractRefs,
        },
        {
          code: 'pilot_formal_submit',
          label: 'Submit pilot + formal runs per contract',
          reason: baselineDone
            ? 'the baseline passed — submit pilot and formal runs bound to the frozen contract'
            : 'pilot and formal runs wait for a successful baseline reproduction',
          route: 'runs',
          state: baselineDone ? (succeededJob(jobs, ['pilot', 'formal']) ? 'done' : 'ready') : 'blocked',
          required: baselineDone ? true : ['baseline_reproduction'],
          required_by: 'agent',
          capability: 'researcher',
          revision: contractVersion,
          refs: contractRefs,
        },
      ]
    }
    case 'EXPERIMENTING': {
      const runsDone = succeededJob(jobs, ['pilot', 'formal'])
      const evidenceAccepted = evidence.some(e => e.status === 'accepted')
      return [
        {
          code: 'pilot_formal_submit',
          label: 'Submit pilot + formal runs per contract',
          reason: 'keep submitting pilot/formal runs until the contract stop conditions are met',
          route: 'runs',
          state: runsDone ? 'done' : (contract !== null ? 'ready' : 'blocked'),
          required: contract !== null ? true : ['approved_contract'],
          required_by: 'agent',
          capability: 'researcher',
          revision: contractVersion,
          refs: contractRefs,
        },
        {
          code: 'evidence_verify',
          label: 'Build evidence + verify claims',
          reason: 'accepted evidence from succeeded runs is required before the manuscript phase',
          route: 'evidence',
          state: evidenceAccepted ? 'done' : (runsDone ? 'ready' : 'blocked'),
          required: runsDone ? true : ['succeeded_runs'],
          required_by: 'agent',
          capability: 'researcher',
          revision: contractVersion,
          refs: contractRefs,
        },
      ]
    }
    case 'EVIDENCE_READY':
      return [{
        code: 'manuscript_write',
        label: 'Write manuscript from read-only ledger',
        reason: 'evidence and claims are frozen — write the manuscript from the read-only ledger',
        route: 'manuscript',
        state: 'ready',
        required: true,
        required_by: 'agent',
        capability: 'researcher',
        revision: project.revision,
        refs: evidence.filter(e => e.status === 'accepted').map(e => ({ kind: 'evidence', id: e.evidence_id }) as NextActionRef).slice(0, 16),
      }]
    case 'WRITING':
      return [{
        code: 'reviewer_run',
        label: 'Run reviewer panel + reproducibility audit',
        reason: 'the manuscript draft needs an independent reviewer panel and reproducibility audit before release review',
        route: 'runs',
        state: 'ready',
        required: true,
        required_by: 'agent',
        capability: 'researcher',
        revision: project.revision,
        refs: [],
      }]
    case 'REVIEWING':
      return [
        {
          code: 'release_bundle',
          label: 'Finalize release bundle',
          reason: 'the review passed — assemble the self-contained release bundle from the private ledger',
          route: 'release',
          state: 'ready',
          required: true,
          required_by: 'agent',
          capability: 'researcher',
          revision: project.revision,
          refs: [],
        },
        {
          code: 'release_gate',
          label: 'Release Gate stays human — submit for final approval',
          reason: 'public release is gated by a human Release Gate decision',
          route: 'gates',
          state: 'ready',
          required: true,
          required_by: 'human',
          revision: project.revision,
          refs: [],
        },
      ]
    case 'RELEASE_READY': {
      const releaseGate = pendingGateOf('release')
      return [{
        code: 'release_gate',
        label: 'Release Gate stays human — submit for final approval',
        reason: releaseGate !== undefined
          ? `release gate ${releaseGate.gate_id} is pending — the human decision publishes the project`
          : 'a human Release Gate decision is required to publish',
        route: 'gates',
        state: 'ready',
        required: true,
        required_by: 'human',
        revision: project.revision,
        refs: releaseGate === undefined ? [] : [{ kind: 'gate', id: releaseGate.gate_id }],
      }]
    }
    case 'BLOCKED_GATE':
      return [{
        code: 'gate_resolve',
        label: 'Resolve pending gate or budget decision',
        reason: 'project progress is blocked on a pending human gate or budget decision',
        route: 'gates',
        state: 'ready',
        required: true,
        required_by: 'human',
        revision: project.revision,
        refs: gates.map(g => ({ kind: 'gate', id: g.gate_id })),
      }]
    case 'FAILED':
      return [{
        code: 'project_stop',
        label: 'Project FAILED — review failure and stop',
        reason: 'a FAILED project has no forward transitions; review the failure evidence and stop the project',
        route: 'overview',
        state: 'ready',
        required: true,
        required_by: 'human',
        capability: 'pi',
        revision: project.revision,
        refs: [],
        blocking: false,
      }]
    case 'ARCHIVED':
      return [{
        code: 'project_archived',
        label: 'Project archived — no pending actions',
        reason: 'the project is archived; no further actions are available',
        route: 'overview',
        state: 'done',
        required: true,
        required_by: 'human',
        revision: project.revision,
        refs: [],
      }]
    case 'RELEASED':
      return [{
        code: 'project_released',
        label: 'Project released — no pending actions',
        reason: 'the project was published through the Release Gate; no further actions are available',
        route: 'overview',
        state: 'done',
        required: true,
        required_by: 'human',
        revision: project.revision,
        refs: [],
      }]
    case 'STOPPED':
      return [{
        code: 'project_stopped',
        label: 'Project stopped — no pending actions',
        reason: 'the project is stopped; no further actions are available',
        route: 'overview',
        state: 'done',
        required: true,
        required_by: 'human',
        revision: project.revision,
        refs: [],
      }]
    default:
      // GUIDE-01 legacy unknown 安全退化: future/unknown statuses degrade to
      // a read-only 'unknown' action — never throw, never a mutation CTA.
      return [{
        code: NEXT_ACTION_UNKNOWN_CODE,
        label: 'Unknown project state — inspect project',
        reason: `status '${project.status}' has no NextAction mapping; treat the project as read-only until the kernel maps this state`,
        route: 'overview',
        state: 'blocked',
        required: ['state_mapping'],
        required_by: 'human',
        revision: project.revision,
        refs: [],
      }]
  }
}

/**
 * Pending-gate overlay (GUIDE-01): budget gates ALWAYS produce a
 * `budget_resolve` action (they carry the blocked/headroom semantics);
 * other pending gates produce `gate_decide` UNLESS a base action already
 * references that exact gate (so e.g. DRAFT does not emit both
 * `scope_gate_submit` and `gate_decide` for the same scope gate).
 */
function gateOverlay(ctx: NextActionContext): BaseActionSpec[] {
  const { project, gates, budget } = ctx
  const baseRefs = new Set(baseActions(ctx).flatMap(a => a.refs.map(r => `${r.kind}:${r.id}`)))
  const maxCost = project.constraints.max_model_cost_usd
  const maxGpu = project.constraints.max_gpu_hours
  const overBudget = budget.model_cost_usd > maxCost || budget.gpu_hours > maxGpu
  const actions: BaseActionSpec[] = []
  for (const gate of gates) {
    // A Direction Gate is meaningful only through its exact Methodology
    // proposal/synthesis binding. Once that overlay is available, never
    // degrade it to the generic gate CTA.
    if (gate.type === 'direction' && ctx.methodology !== undefined) continue
    if (gate.type === 'budget') {
      actions.push({
        code: 'budget_resolve',
        label: 'Resolve Budget Gate / budget headroom',
        reason: overBudget
          ? `budget limits exceeded ($${budget.model_cost_usd.toFixed(2)} / $${maxCost} max, ${budget.gpu_hours} / ${maxGpu} GPU-h) — the project is blocked until the Budget Gate is decided or headroom is increased`
          : `budget gate ${gate.gate_id} is pending a human decision`,
        route: 'budget',
        state: overBudget ? 'blocked' : 'ready',
        required: overBudget ? ['budget_headroom'] : true,
        required_by: 'human',
        revision: project.revision,
        refs: [{ kind: 'gate', id: gate.gate_id }, ...(overBudget ? [{ kind: 'budget', id: project.project_id }] : [])],
      })
    } else if (!baseRefs.has(`gate:${gate.gate_id}`)) {
      actions.push({
        code: 'gate_decide',
        label: `Decide pending ${gate.type} gate`,
        reason: `gate ${gate.gate_id} (${gate.type}) is pending a human decision`,
        route: 'gates',
        state: 'ready',
        required: true,
        required_by: 'human',
        revision: project.revision,
        refs: [{ kind: 'gate', id: gate.gate_id }],
      })
    }
  }
  return actions
}

function directionOverlay(ctx: NextActionContext, currentNextActionRevision: number): BaseActionSpec[] {
  const methodology = ctx.methodology
  if (methodology === undefined || methodology.proposals.length === 0) return []
  const proposal = methodology.proposals[methodology.proposals.length - 1]!
  const synthesis = methodology.syntheses.find(candidate => candidate.synthesis_id === proposal.synthesis_id)
  const adoption = methodology.adoptions.find(candidate => candidate.proposal_id === proposal.proposal_id)
  const invalid: string[] = []
  const stale: string[] = []
  if (proposal.project_id !== ctx.project.project_id) invalid.push('direction_project_binding_invalid')
  if (synthesis === undefined) invalid.push('direction_synthesis_missing')
  if (synthesis !== undefined && synthesis.project_id !== ctx.project.project_id) invalid.push('direction_synthesis_project_invalid')
  if (synthesis !== undefined && synthesis.direction_proposal_id !== proposal.proposal_id) invalid.push('direction_synthesis_binding_invalid')
  if (adoption !== undefined && adoption.project_id !== ctx.project.project_id) invalid.push('direction_adoption_project_invalid')
  if (proposal.status !== 'proposed') stale.push('direction_proposal_stale')
  if (proposal.snapshot_pin.project_revision !== ctx.project.revision
    || synthesis?.snapshot_pin.project_revision !== ctx.project.revision) {
    stale.push('direction_project_revision_changed')
  }
  if (proposal.snapshot_pin.next_action_revision !== currentNextActionRevision
    || synthesis?.snapshot_pin.next_action_revision !== currentNextActionRevision) {
    stale.push('direction_next_action_revision_changed')
  }
  if (synthesis?.status === 'stale') stale.push('direction_synthesis_stale')
  if (synthesis !== undefined && synthesis.input_hash !== proposal.input_hash) stale.push('direction_input_hash_changed')
  const safeRefs: NextActionRef[] = [
    ...(proposal.project_id === ctx.project.project_id ? [{ kind: 'direction', id: proposal.proposal_id }] : []),
    ...(synthesis?.project_id === ctx.project.project_id ? [{ kind: 'synthesis', id: synthesis.synthesis_id }] : []),
  ]
  if (invalid.length > 0) {
    return [{
      code: 'direction_overlay_invalid', label: 'Inspect invalid Direction binding',
      reason: `Direction overlay is not project-bound: ${invalid.join(', ')}`,
      route: 'overview', state: 'blocked', required: invalid, required_by: 'human', capability: 'pi',
      revision: currentNextActionRevision, refs: safeRefs, blocking: false,
    }]
  }
  if (stale.length > 0) {
    return [{
      code: 'direction_overlay_stale', label: 'Refresh stale Direction proposal',
      reason: `Direction proposal no longer matches current authority: ${stale.join(', ')}`,
      route: 'overview', state: 'blocked', required: [...new Set(stale)], required_by: 'human', capability: 'pi',
      revision: currentNextActionRevision, refs: safeRefs, blocking: false,
    }]
  }
  if (synthesis === undefined) return []

  if (adoption !== undefined) {
    if (adoption.decision !== 'adopted') return []
    const gateWasRequired = proposal.direction === 'pivot' || proposal.direction === 'broaden'
      || (proposal.direction === 'deepen'
        && !['CONTRACT_APPROVED', 'BASELINE_REPRO', 'EXPERIMENTING', 'EVIDENCE_READY', 'WRITING', 'REVIEWING', 'RELEASE_READY'].includes(ctx.project.status))
    if (gateWasRequired && adoption.gate_decision_ref === null) {
      return [{
        code: 'direction_overlay_invalid', label: 'Inspect invalid Direction adoption',
        reason: `adoption ${adoption.adoption_id} has no required Direction Gate decision receipt`,
        route: 'overview', state: 'blocked', required: ['direction_adoption_gate_missing'], required_by: 'human', capability: 'pi',
        revision: currentNextActionRevision, refs: safeRefs, blocking: false,
      }]
    }
    if (gateWasRequired) {
      const approval = methodology.direction_gate_approvals?.find(candidate =>
        candidate.decision_id === adoption.gate_decision_ref)
      const binding = approval?.gate.type === 'direction'
        ? DirectionGatePayload.safeParse(approval.gate.payload)
        : undefined
      const exactApproval = approval !== undefined
        && approval.project_id === ctx.project.project_id
        && approval.gate_id === approval.gate.gate_id
        && approval.gate.project_id === ctx.project.project_id
        && approval.decision === 'approved'
        && approval.gate.status === 'approved'
        && binding?.success === true
        && binding.data.proposal_id === proposal.proposal_id
        && binding.data.source_synthesis_id === synthesis.synthesis_id
        && binding.data.direction === proposal.direction
      if (!exactApproval) {
        return [{
          code: 'direction_overlay_invalid', label: 'Inspect invalid Direction adoption',
          reason: `adoption ${adoption.adoption_id} does not replay against its exact approved Direction Gate receipt`,
          route: 'overview', state: 'blocked', required: ['direction_adoption_gate_binding_invalid'], required_by: 'human', capability: 'pi',
          revision: currentNextActionRevision, refs: safeRefs, blocking: false,
        }]
      }
    }
    const continuation = {
      deepen: {
        code: 'direction_deepen_continue', label: 'Continue deeper research inside the approved boundary',
        reason: 'the adopted direction deepens the current approved question without changing Scope or Contract',
        route: 'runs' as const, required_by: 'agent' as const, capability: 'researcher',
      },
      broaden: {
        code: 'direction_broaden_intake', label: 'Propose a broader continuation through Intake',
        reason: 'the adopted broader direction must enter the existing Human Intake proposal/adoption flow',
        route: 'overview' as const, required_by: 'human' as const, capability: 'pi',
      },
      pivot: {
        code: 'direction_pivot_intake', label: 'Propose a pivot through Intake',
        reason: 'the adopted pivot must enter the existing Human Intake proposal/adoption flow',
        route: 'overview' as const, required_by: 'human' as const, capability: 'pi',
      },
      conclude: {
        code: 'direction_conclude_prepare', label: 'Prepare evidence and writing for conclusion',
        reason: 'the adopted conclusion proposes evidence/manuscript preparation without changing Project phase',
        route: 'evidence' as const, required_by: 'agent' as const, capability: 'researcher',
      },
      pause: {
        code: 'direction_pause_review', label: 'Review the adopted pause',
        reason: 'the adopted pause leaves Project state unchanged until a Human chooses an existing authoritative action',
        route: 'overview' as const, required_by: 'human' as const, capability: 'pi',
      },
    }[proposal.direction]
    return [{
      ...continuation,
      state: 'ready', required: true, revision: currentNextActionRevision, blocking: false,
      refs: [
        { kind: 'adoption', id: adoption.adoption_id },
        { kind: 'direction', id: proposal.proposal_id },
        { kind: 'synthesis', id: synthesis.synthesis_id },
        { kind: 'project', id: ctx.project.project_id },
      ],
    }]
  }

  const withinApprovedContract = ['CONTRACT_APPROVED', 'BASELINE_REPRO', 'EXPERIMENTING', 'EVIDENCE_READY', 'WRITING', 'REVIEWING', 'RELEASE_READY']
    .includes(ctx.project.status)
  const requiresGate = proposal.direction === 'pivot' || proposal.direction === 'broaden'
    || (proposal.direction === 'deepen' && !withinApprovedContract)
  if (!requiresGate) return []
  const exactGates = ctx.gates.filter(gate => {
    const binding = DirectionGatePayload.safeParse(gate.payload)
    return gate.type === 'direction'
      && gate.project_id === ctx.project.project_id
      && gate.status === 'pending'
      && binding.success
      && binding.data.proposal_id === proposal.proposal_id
      && binding.data.source_synthesis_id === synthesis.synthesis_id
      && binding.data.direction === proposal.direction
  })
  const exactGate = exactGates.length === 1 ? exactGates[0] : undefined
  const hasWrongDirectionGate = exactGates.length === 0 && ctx.gates.some(gate => gate.type === 'direction')
  const gateDiagnostic = exactGates.length > 1
    ? 'direction_gate_ambiguous'
    : hasWrongDirectionGate ? 'direction_gate_binding_mismatch' : 'pending_direction_gate'
  return [{
    code: 'direction_gate_review',
    label: `Review ${proposal.direction} direction at the Direction Gate`,
    reason: exactGate === undefined
      ? exactGates.length > 1
        ? `direction ${proposal.proposal_id} has multiple matching pending Gates and cannot choose authority`
        : `direction ${proposal.proposal_id} requires a dedicated pending Gate bound to its proposal, synthesis and direction`
      : `direction gate ${exactGate.gate_id} is exactly bound to proposal ${proposal.proposal_id}`,
    route: 'gates',
    state: exactGate === undefined ? 'blocked' : 'ready',
    required: exactGate === undefined
      ? [gateDiagnostic]
      : true,
    required_by: 'human',
    capability: 'pi',
    revision: currentNextActionRevision,
    refs: [
      ...(exactGate === undefined ? [] : [{ kind: 'gate', id: exactGate.gate_id }]),
      { kind: 'direction', id: proposal.proposal_id },
      { kind: 'synthesis', id: synthesis.synthesis_id },
    ],
  }]
}

/**
 * Failed/retryable job overlay (GUIDE-01): a retry/repair action per failed
 * job. Attempts exhausted → blocked with `repair_decision` (a PI must
 * repair or cancel the job). Not phase-blocking itself.
 */
function jobOverlay(ctx: NextActionContext): BaseActionSpec[] {
  const { project, jobs } = ctx
  const actions: BaseActionSpec[] = []
  for (const job of jobs) {
    if (job.status !== 'failed' && job.status !== 'retryable') continue
    const exhausted = job.attempts >= job.max_attempts
    const failure = job.failure_class === null || job.failure_class === '' ? 'unknown' : job.failure_class
    actions.push({
      code: 'job_retry',
      label: exhausted ? 'Repair failed job (attempts exhausted)' : 'Retry failed job',
      reason: `job ${job.job_id} [${job.kind}] ${job.status} (${failure})${exhausted ? ` after ${job.attempts} attempts — a PI must repair or cancel it` : ` — retry (${job.attempts}/${job.max_attempts} attempts)`}`,
      route: 'runs',
      state: exhausted ? 'blocked' : 'ready',
      required: exhausted ? ['repair_decision'] : true,
      required_by: 'agent',
      capability: exhausted ? 'pi' : 'researcher',
      revision: null,
      refs: [{ kind: 'job', id: job.job_id }],
      blocking: false,
    })
  }
  return actions
}

/**
 * Active-intake overlay (ONBOARD-01 landing, 2026-08-11): one `intake_resume`
 * action per active intake session plus the session-status step overlay —
 * `intake_scan` once artifacts are staged, `intake_answer` while questions
 * are open, `intake_propose` when the required answers are in, and
 * `intake_adopt` (PI capability) once the proposal awaits the human. All are
 * non-blocking overlays (like job_retry): the phase's own base action stays
 * authoritative; terminal intakes (accepted/rejected/expired/failed) emit
 * nothing.
 */
function intakeOverlay(ctx: NextActionContext): BaseActionSpec[] {
  const { project, intakes } = ctx
  const actions: BaseActionSpec[] = []
  for (const intake of intakes ?? []) {
    if (!INTAKE_ACTIVE_STATUSES.includes(intake.status)) continue
    const refs: NextActionRef[] = [
      { kind: 'intake', id: intake.intake_id },
      { kind: 'project', id: project.project_id },
    ]
    const target = intake.target_phase === null || intake.target_phase === '' ? '' : ` (${intake.target_phase})`
    actions.push({
      code: 'intake_resume',
      label: `Resume intake ${intake.intake_id}${target}`,
      reason: `intake ${intake.intake_id} is ${intake.status} — continue uploading, scanning, answering or adopting it`,
      route: 'overview',
      state: 'ready',
      required: true,
      required_by: 'human',
      revision: null,
      refs,
      blocking: false,
    })
    if (intake.status === 'uploading' && intake.artifact_count > 0) {
      actions.push({
        code: 'intake_scan',
        label: 'Scan staged intake files',
        reason: `${intake.artifact_count} staged file(s) are waiting for the static security scan`,
        route: 'overview',
        state: 'ready',
        required: true,
        required_by: 'human',
        revision: null,
        refs,
        blocking: false,
      })
    }
    if (intake.status === 'needs_input' || intake.status === 'grilling') {
      actions.push({
        code: 'intake_answer',
        label: 'Answer intake Grill questions',
        reason: 'the intake scan is done — required Grill questions still need human answers',
        route: 'overview',
        state: 'ready',
        required: true,
        required_by: 'human',
        revision: null,
        refs,
        blocking: false,
      })
    }
    if (intake.status === 'proposal_ready') {
      actions.push({
        code: 'intake_propose',
        label: 'Generate intake phase proposal',
        reason: 'all required Grill questions are answered — generate the phase proposal for human review',
        route: 'overview',
        state: 'ready',
        required: true,
        required_by: 'human',
        revision: null,
        refs,
        blocking: false,
      })
    }
    if (intake.status === 'awaiting_human') {
      actions.push({
        code: 'intake_adopt',
        label: 'Adopt intake proposal (PI)',
        reason: `the intake proposal awaits a Human PI decision — adopting imports the material into the project`,
        route: 'overview',
        state: 'ready',
        required: true,
        required_by: 'human',
        capability: 'pi',
        revision: null,
        refs,
        blocking: false,
      })
    }
  }
  return actions
}

/** 
 * REPRO-01 overlay (docs/reproduction-contracts.md §5): per-spec guidance
 * through the reproduction wizard — reproduction_plan_confirm (draft spec,
 * human), reproduction_run (confirmed spec, no attempt yet), 
 * reproduction_compare (attempt in flight/executed, no persisted report),
 * reproduction_report_review (a report exists, not pass), and
 * reproduction_retry_or_repair (fail/inconclusive report → ready; blocked
 * report → blocked with the concrete missing environment gap). A passing
 * report emits NOTHING here — the base baseline_reproduce action turns
 * `done` (contract §3: only a persisted report in status=pass does). All
 * overlays are non-blocking like job_retry/intake overlays.
 */
function reproductionOverlay(ctx: NextActionContext): BaseActionSpec[] {
  const { project } = ctx
  const actions: BaseActionSpec[] = []
  for (const repro of ctx.reproductions ?? []) {
    const refs: NextActionRef[] = [
      { kind: 'reproduction_spec', id: repro.spec_id },
      { kind: 'project', id: project.project_id },
    ]
    if (repro.status === 'draft') {
      actions.push({
        code: 'reproduction_plan_confirm',
        label: `Confirm reproduction plan ${repro.spec_id}`,
        reason: `reproduction spec ${repro.spec_id} is draft — a Human confirms the plan/contract before any attempt starts`,
        route: 'runs',
        state: 'ready',
        required: true,
        required_by: 'human',
        revision: repro.revision,
        refs,
        blocking: false,
      })
      continue
    }
    if (repro.status === 'confirmed' && repro.attempt_count === 0 && repro.latest_report_status === null) {
      actions.push({
        code: 'reproduction_run',
        label: `Run reproduction ${repro.spec_id}`,
        reason: `reproduction spec ${repro.spec_id} is confirmed — execute the attempt on the bound runner/target`,
        route: 'runs',
        state: 'ready',
        required: true,
        required_by: 'agent',
        revision: repro.revision,
        refs,
        blocking: false,
      })
      continue
    }
    if (repro.has_running_attempt && repro.report_count === 0) {
      actions.push({
        code: 'reproduction_compare',
        label: `Compare + report reproduction ${repro.spec_id}`,
        reason: `an attempt of reproduction spec ${repro.spec_id} is running — compare paper targets and the clean-room vs formal run, then persist the report`,
        route: 'runs',
        state: 'ready',
        required: true,
        required_by: 'agent',
        revision: repro.revision,
        refs,
        blocking: false,
      })
      continue
    }
    if (repro.latest_report_status === 'fail' || repro.latest_report_status === 'inconclusive') {
      actions.push({
        code: 'reproduction_retry_or_repair',
        label: `Repair or retry reproduction ${repro.spec_id}`,
        reason: `reproduction spec ${repro.spec_id} has a persisted report in status '${repro.latest_report_status}' — out-of-tolerance is a scientific result, not code_error; repair inputs or start a new attempt`,
        route: 'runs',
        state: 'ready',
        required: true,
        required_by: 'agent',
        revision: repro.revision,
        refs,
        blocking: false,
      })
      continue
    }
    if (repro.latest_report_status === 'blocked') {
      actions.push({
        code: 'reproduction_retry_or_repair',
        label: `Unblock reproduction ${repro.spec_id}`,
        reason: `reproduction spec ${repro.spec_id} is blocked (e.g. a clean-room cannot satisfy an acquisition recipe) — the block was NOT silently skipped`,
        route: 'runs',
        state: 'blocked',
        required: ['reproduction_environment'],
        required_by: 'agent',
        revision: repro.revision,
        refs,
        blocking: false,
      })
      continue
    }
    if (repro.report_count > 0 && repro.latest_report_status !== 'pass') {
      actions.push({
        code: 'reproduction_report_review',
        label: `Review reproduction report for ${repro.spec_id}`,
        reason: `reproduction spec ${repro.spec_id} has a persisted report in status '${repro.latest_report_status}' — review the comparison details`,
        route: 'runs',
        state: 'ready',
        required: true,
        required_by: 'human',
        revision: repro.revision,
        refs,
        blocking: false,
      })
    }
  }
  return actions
}

/** Runner execution facts and deterministic outer-loop trigger receipts are
 * projected as explicit work. Neither is silently converted into scientific
 * content, and both remain outside the automatic full-auto executor allowlist. */
function researchLoopOverlay(ctx: NextActionContext): BaseActionSpec[] {
  const actions: BaseActionSpec[] = []
  const observations = ctx.run_outcome_observations ?? []
  if (observations.length > 0) {
    actions.push({
      code: 'run_outcome_classify',
      label: 'Classify completed run outcome',
      reason: `${observations.length} terminal Runner observation(s) need an authorized outcome/validity classification; process success is not a scientific conclusion`,
      route: 'runs',
      state: 'ready',
      required: true,
      required_by: 'agent',
      capability: 'researcher',
      revision: ctx.project.revision,
      refs: observations.flatMap(observation => [
        { kind: 'run', id: observation.run_id } as NextActionRef,
        { kind: 'job', id: observation.job_id } as NextActionRef,
      ]),
      blocking: true,
    })
  }
  const requests = ctx.synthesis_requests ?? []
  if (requests.length > 0) {
    actions.push({
      code: 'synthesis_record',
      label: 'Record research synthesis',
      reason: `${requests.length} deterministic trigger request(s) await explicit synthesis content; the Kernel will not generate or adopt it`,
      route: 'chat',
      state: 'ready',
      required: true,
      required_by: 'agent',
      capability: 'researcher',
      revision: ctx.project.revision,
      refs: requests.flatMap(request => [
        { kind: 'synthesis_request', id: request.request_id } as NextActionRef,
        { kind: 'run', id: request.trigger_run_ref } as NextActionRef,
      ]),
      blocking: true,
    })
  }
  return actions
}

/**
 * GUIDE-01 authoritative projection: deterministic structured actions for
 * the current project state. Pure — no DB, no side effects, never throws.
 * Unknown/future statuses degrade to `code: 'unknown'` (read-only).
 */
export function nextActionProjection(ctx: NextActionContext): NextAction[] {
  const base = baseActions(ctx)
  const ordinaryOverlays = [
    ...researchLoopOverlay(ctx),
    ...gateOverlay(ctx),
    ...jobOverlay(ctx),
    ...intakeOverlay(ctx),
    ...reproductionOverlay(ctx),
  ]
  const ordinary = [...base, ...ordinaryOverlays]
  const currentNextActionRevision = ordinary.find(spec => spec.state === 'ready')?.revision
    ?? ordinary.find(spec => spec.state !== 'done')?.revision
    ?? ctx.project.revision
  const overlays = [...ordinaryOverlays, ...directionOverlay(ctx, currentNextActionRevision)]
  return [...base, ...overlays].map(spec => action(ctx.project.project_id, spec))
}
