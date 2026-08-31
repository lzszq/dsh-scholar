/**
 * Durable fixture-only full-auto orchestrator.
 *
 * The Kernel projection is the sole workflow authority. This worker never
 * creates Gates and never impersonates a Human Principal: it either asks the
 * Kernel's service-only full-auto endpoint to decide an exact allowlisted
 * fixture Gate, or records a typed park reason. ActionStore + per-project
 * leases retain crash recovery and exactly-once reconciliation across restarts.
 */
import { existsSync, readFileSync } from 'node:fs'
import { hostname } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod'
import {
  BudgetRecord,
  CorpusSnapshot,
  Gate,
  NextAction,
  ResearchProject,
  type Gate as GateValue,
  type NextAction as NextActionValue,
  type ResearchProject as ResearchProjectValue,
} from '@dsh-scholar/research-schemas'
import {
  FullAutoSurveyAuthorityContextSchema,
  FullAutoSurveyAuthorityReceiptSchema,
  FullAutoSurveyResultSchema,
  type FullAutoSurveyAuthorityContext,
  type FullAutoSurveyResult,
} from '@dsh-scholar/research-kernel'
import { ActionStore, type Action, type ActionLike } from './actions.js'

const DEFAULT_POLL_MS = 5000
const DEFAULT_MAX_ATTEMPTS = 3
const DEFAULT_LEASE_SECONDS = 60

const ProjectionSchema = z.object({
  project: ResearchProject,
  pending_gates: z.array(Gate),
  jobs: z.array(z.object({ job_id: z.string(), kind: z.string(), status: z.string() }).strict()),
  budget: BudgetRecord,
  counts: z.object({
    ideas: z.number().int().nonnegative(),
    contracts: z.number().int().nonnegative(),
    claims: z.number().int().nonnegative(),
    evidence: z.number().int().nonnegative(),
    artifacts: z.number().int().nonnegative(),
    corpus_snapshots: z.number().int().nonnegative(),
  }).strict(),
  next_actions_v2: z.array(NextAction),
}).strict()

const FullAutoResponseSchema = z.object({
  gate: Gate,
  project: ResearchProject,
  decision: z.object({ decision_id: z.string(), gate_id: z.string(), decision: z.literal('approved') }).passthrough(),
  receipt: z.object({
    authority: z.literal('full_auto_service'),
    project_id: z.string(),
    project_revision: z.number().int().nonnegative(),
    gate_id: z.string(),
    gate_type: z.enum(['scope', 'idea', 'contract', 'budget']),
    idempotency_key: z.string(),
  }).passthrough(),
}).strict()

const FullAutoSurveyResponseSchema = z.object({
  snapshot: CorpusSnapshot,
  project: ResearchProject,
  receipt: FullAutoSurveyAuthorityReceiptSchema,
}).strict()

export type KernelProjection = z.infer<typeof ProjectionSchema>

export const FULL_AUTO_GATE_ALLOWLIST = new Set<GateValue['type']>(['scope', 'idea', 'contract', 'budget'])
/** Every entry must have a canonical internal Kernel executor below. */
export const FULL_AUTO_ACTION_EXECUTOR_ALLOWLIST = new Set<string>(['survey_run'])

export type ParkCode =
  | 'brief_confirmation_required'
  | 'fixture_binding_required'
  | 'release_never_automatic'
  | 'human_action_required'
  | 'action_not_ready'
  | 'parameters_incomplete'
  | 'unsupported_executor'
  | 'service_token_required'
  | 'orchestrator_token_required'
  | 'stale_projection'
  | 'authority_rejected'
  | 'postcondition_failed'

export interface ParkReason {
  code: ParkCode
  reason: string
  action_id: string | null
  gate_id: string | null
}

export type FullAutoPlan =
  | {
      kind: 'gate-approve'
      type: string
      idempotency_key: string
      gate_id: string
      gate_type: 'scope' | 'idea' | 'contract' | 'budget'
      expected_project_revision: number
    }
  | {
      kind: 'action-execute'
      type: 'full-auto-action:survey_run'
      idempotency_key: string
      action_id: string
      action_code: 'survey_run'
      action_revision: number
      expected_project_revision: number
      /** Present after the service-only admission read and pinned in Action idempotency. */
      expected_authority_sha256?: string
    }
  | {
      kind: 'park'
      type: string
      idempotency_key: string
      park: ParkReason
      expected_project_revision: number
    }

function readCredential(
  direct: string | undefined,
  file: string | undefined,
  envName: 'DSH_SCHOLAR_KERNEL_TOKEN' | 'DSH_SCHOLAR_SERVICE_TOKEN',
  log: (message: string) => void,
): string | null {
  if (direct !== undefined && direct !== '') return direct
  if (file !== undefined && file !== '') {
    if (!existsSync(file)) throw new Error(`${file} does not exist (${envName} credential required)`)
    const value = readFileSync(file, 'utf8').trim()
    if (value === '') throw new Error(`${file} is empty`)
    log(`using ${envName} credential from a private file`)
    return value
  }
  const value = process.env[envName]
  return value === undefined || value === '' ? null : value
}

function parkForAction(project: ResearchProjectValue, action: NextActionValue): FullAutoPlan {
  let code: ParkCode
  let reason: string
  if (action.state !== 'ready') {
    code = 'action_not_ready'
    reason = `authoritative action ${action.code} is ${action.state}: ${action.reason || 'preconditions are not satisfied'}`
  } else if (action.code === 'release_bundle' || action.code === 'release_gate') {
    code = 'release_never_automatic'
    reason = 'FixtureProfile.automatic_release=false: Release always requires a Human decision'
  } else if (action.required !== true) {
    code = 'parameters_incomplete'
    reason = `canonical action ${action.code} is missing: ${action.required.join(', ')}`
  } else if (action.required_by !== 'agent') {
    code = 'human_action_required'
    reason = `canonical action ${action.code} remains ${action.required_by}-owned and is not in the automatic Gate allowlist`
  } else {
    code = 'unsupported_executor'
    reason = `canonical action ${action.code} has no registered full-auto executor; no success was fabricated`
  }
  return {
    kind: 'park',
    type: `park:${action.code}`,
    idempotency_key: `park:${action.id}:r${action.revision ?? project.revision}:${code}`,
    expected_project_revision: project.revision,
    park: { code, reason, action_id: action.id, gate_id: null },
  }
}

function actionPlan(project: ResearchProjectValue, action: NextActionValue): FullAutoPlan {
  if (action.state !== 'ready' || action.required !== true || action.required_by !== 'agent') {
    return parkForAction(project, action)
  }
  if (action.code !== 'survey_run' || !FULL_AUTO_ACTION_EXECUTOR_ALLOWLIST.has(action.code)) {
    return parkForAction(project, action)
  }
  const revision = action.revision ?? project.revision
  return {
    kind: 'action-execute',
    type: 'full-auto-action:survey_run',
    idempotency_key: `full-auto-action:survey_run:${encodeURIComponent(action.id)}:r${revision}`,
    action_id: action.id,
    action_code: 'survey_run',
    action_revision: revision,
    expected_project_revision: project.revision,
  }
}

/** Pure admission/planning seam over one strict authoritative projection. */
export function planFullAutoProjection(projection: KernelProjection): FullAutoPlan[] {
  const project = projection.project
  if (project.mode !== 'full-auto') return []
  if (project.brief_status === 'collecting') {
    return [{
      kind: 'park', type: 'park:brief-confirmation',
      idempotency_key: `park:brief-confirmation:r${project.revision}`,
      expected_project_revision: project.revision,
      park: {
        code: 'brief_confirmation_required',
        reason: 'Research Brief confirmation remains Human-only; full-auto never bypasses Grill/confirm',
        action_id: null,
        gate_id: null,
      },
    }]
  }
  if (project.execution.fixture_id === null || project.execution.runner_profile_id === null) {
    return [{
      kind: 'park', type: 'park:fixture-binding',
      idempotency_key: `park:fixture-binding:r${project.revision}`,
      expected_project_revision: project.revision,
      park: {
        code: 'fixture_binding_required',
        reason: 'full-auto requires an exact registered FixtureProfile and explicit RunnerProfile/Target',
        action_id: null,
        gate_id: null,
      },
    }]
  }

  const pending = projection.pending_gates[0]
  if (pending !== undefined) {
    if (FULL_AUTO_GATE_ALLOWLIST.has(pending.type)) {
      return [{
        kind: 'gate-approve',
        type: `full-auto-gate:${pending.type}`,
        idempotency_key: `full-auto-gate:${pending.gate_id}:r${project.revision}`,
        gate_id: pending.gate_id,
        gate_type: pending.type as 'scope' | 'idea' | 'contract' | 'budget',
        expected_project_revision: project.revision,
      }]
    }
    return [{
      kind: 'park', type: `park:gate:${pending.type}`,
      idempotency_key: `park:gate:${pending.gate_id}:r${project.revision}`,
      expected_project_revision: project.revision,
      park: {
        code: pending.type === 'release' ? 'release_never_automatic' : 'human_action_required',
        reason: pending.type === 'release'
          ? 'Release Gate is never automatically approved, including fixture projects'
          : `${pending.type} Gate is outside the fixture automatic approval allowlist`,
        action_id: null,
        gate_id: pending.gate_id,
      },
    }]
  }

  const candidate = projection.next_actions_v2.find(action => action.state === 'ready')
    ?? projection.next_actions_v2.find(action => action.state === 'blocked')
  if (candidate === undefined) return []
  return [actionPlan(project, candidate)]
}

/** Idempotency/retry filter shared by gate decisions and typed parks. */
export function decideFullAutoPlans(projection: KernelProjection, existing: ActionLike[]): FullAutoPlan[] {
  return planFullAutoProjection(projection).filter(plan => {
    const prior = existing.find(action => action.idempotency_key === plan.idempotency_key)
    if (prior === undefined) return true
    if (prior.status === 'done' || prior.status === 'blocked') return false
    return !(prior.status === 'failed' && prior.attempt >= prior.max_attempts)
  })
}

function gatePlanFromAction(action: Action): Extract<FullAutoPlan, { kind: 'gate-approve' }> | null {
  if (action.type !== 'full-auto-gate:scope' && action.type !== 'full-auto-gate:idea'
    && action.type !== 'full-auto-gate:contract' && action.type !== 'full-auto-gate:budget') return null
  const match = /^full-auto-gate:(.+):r([0-9]+)$/.exec(action.idempotency_key)
  if (match === null || match[1] === '') return null
  return {
    kind: 'gate-approve',
    type: action.type,
    idempotency_key: action.idempotency_key,
    gate_id: match[1]!,
    gate_type: action.type.slice('full-auto-gate:'.length) as 'scope' | 'idea' | 'contract' | 'budget',
    expected_project_revision: Number(match[2]!),
  }
}

function surveyPlanFromAction(action: Action): Extract<FullAutoPlan, { kind: 'action-execute' }> | null {
  if (action.type !== 'full-auto-action:survey_run') return null
  const match = /^full-auto-action:survey_run:(.+):r([0-9]+):(sha256:[a-f0-9]{64})$/.exec(action.idempotency_key)
  if (match === null || match[1] === '') return null
  let actionId: string
  try { actionId = decodeURIComponent(match[1]!) } catch { return null }
  return {
    kind: 'action-execute',
    type: 'full-auto-action:survey_run',
    idempotency_key: action.idempotency_key,
    action_id: actionId,
    action_code: 'survey_run',
    action_revision: Number(match[2]!),
    expected_project_revision: Number(match[2]!),
    expected_authority_sha256: match[3]!,
  }
}

export interface ProjectPollDetail {
  project_id: string
  status: string
  planned: FullAutoPlan[]
  executed: Array<{ type: string; idempotency_key: string; result: 'blocked' | 'done' | 'failed' }>
  parked: ParkReason[]
  skipped: string[]
  errors: string[]
}

export interface PollResult {
  polled_at: string
  projects: number
  planned: number
  executed: number
  errors: string[]
  details: ProjectPollDetail[]
}

export interface EngineOptions {
  kernelUrl: string
  pollMs?: number
  dbPath?: string
  dryRun?: boolean
  maxAttempts?: number
  owner?: string
  leaseSeconds?: number
  token?: string
  tokenFile?: string
  serviceToken?: string
  serviceTokenFile?: string
  orchestratorToken?: string
  /** Plugin-hosted real connector adapter; the Kernel remains authority. */
  surveyExecutor?: (query: string) => Promise<FullAutoSurveyResult>
}

export interface EngineRuntimeStatus {
  worker: 'running' | 'stopped'
  last_park: ParkReason | null
}

export class KernelApiError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message)
    this.name = 'KernelApiError'
  }
}

export class Engine {
  readonly kernelUrl: string
  readonly pollMs: number
  readonly maxAttempts: number
  readonly dryRun: boolean
  readonly store: ActionStore
  readonly owner: string
  readonly leaseSeconds: number
  readonly token: string | null
  readonly serviceToken: string | null
  readonly orchestratorToken: string | null
  readonly surveyExecutor: ((query: string) => Promise<FullAutoSurveyResult>) | null

  private stopped = false
  private closed = false
  private running = false
  private lastPark: ParkReason | null = null
  private timer: ReturnType<typeof setTimeout> | undefined
  private wake: (() => void) | undefined
  private readonly log: (message: string) => void
  private readonly ownedProjects = new Set<string>()

  constructor(options: EngineOptions, log: (message: string) => void = message => { console.error(`[research-orchestrator] ${message}`) }) {
    this.kernelUrl = options.kernelUrl.replace(/\/+$/, '')
    this.pollMs = options.pollMs ?? DEFAULT_POLL_MS
    this.maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS
    this.dryRun = options.dryRun ?? false
    this.owner = options.owner ?? `orch-${hostname()}-${process.pid}`
    this.leaseSeconds = options.leaseSeconds ?? DEFAULT_LEASE_SECONDS
    this.log = log
    this.token = readCredential(options.token, options.tokenFile, 'DSH_SCHOLAR_KERNEL_TOKEN', log)
    this.serviceToken = readCredential(options.serviceToken, options.serviceTokenFile, 'DSH_SCHOLAR_SERVICE_TOKEN', log)
    const orchestratorToken = options.orchestratorToken === undefined
      ? process.env.DSH_SCHOLAR_ORCHESTRATOR_TOKEN
      : options.orchestratorToken
    this.orchestratorToken = orchestratorToken === undefined || orchestratorToken.trim() === ''
      ? null
      : orchestratorToken
    this.surveyExecutor = options.surveyExecutor ?? null
    this.store = new ActionStore({ dbPath: options.dbPath ?? join(process.cwd(), '.orchestrator', 'actions.db') })
    const recovered = this.store.recover()
    if (recovered > 0) this.log(`recovered ${recovered} stale running action(s) from crash`)
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    this.stop()
    if (!this.dryRun) {
      for (const projectId of this.ownedProjects) this.store.releaseLease(projectId, this.owner)
      this.ownedProjects.clear()
    }
    this.store.close()
  }

  runtimeStatus(): EngineRuntimeStatus {
    return { worker: this.running ? 'running' : 'stopped', last_park: this.lastPark }
  }

  private async request<T>(path: string, init?: RequestInit): Promise<T> {
    let response: Response
    try {
      response = await fetch(`${this.kernelUrl}${path}`, {
        ...init,
        headers: {
          'content-type': 'application/json',
          ...(this.token === null ? {} : { authorization: `Bearer ${this.token}` }),
          ...init?.headers,
        },
      })
    } catch (error) {
      throw new KernelApiError(0, 'network_error', `cannot reach kernel: ${(error as Error).message}`)
    }
    const text = await response.text()
    let body: unknown = null
    if (text !== '') {
      try { body = JSON.parse(text) } catch { body = null }
    }
    if (!response.ok) {
      const envelope = body as { error?: { code?: string; message?: string } } | null
      throw new KernelApiError(response.status, envelope?.error?.code ?? 'http_error', envelope?.error?.message ?? `${response.status} ${path}`)
    }
    return body as T
  }

  async listProjects(): Promise<ResearchProjectValue[]> {
    return z.array(ResearchProject).parse(await this.request<unknown>('/v1/projects'))
  }

  async getProjection(projectId: string): Promise<KernelProjection> {
    return ProjectionSchema.parse(await this.request<unknown>(`/v1/projects/${encodeURIComponent(projectId)}/projection`))
  }

  private async approveFixtureGate(projectId: string, plan: Extract<FullAutoPlan, { kind: 'gate-approve' }>) {
    if (this.serviceToken === null) {
      throw new KernelApiError(403, 'service_token_required', 'research-orchestrator has no service token; fixture Gate parked')
    }
    if (this.orchestratorToken === null) {
      throw new KernelApiError(403, 'orchestrator_token_required', 'research-orchestrator has no managed orchestrator credential; fixture Gate parked')
    }
    return FullAutoResponseSchema.parse(await this.request<unknown>(
      `/internal/projects/${encodeURIComponent(projectId)}/full-auto-gates/${encodeURIComponent(plan.gate_id)}/approve`,
      {
        method: 'POST',
        headers: {
          'x-service-token': this.serviceToken,
          'x-service-principal': 'research-orchestrator',
          'x-orchestrator-token': this.orchestratorToken,
        },
        body: JSON.stringify({
          expected_project_revision: plan.expected_project_revision,
          idempotency_key: plan.idempotency_key,
        }),
      },
    ))
  }

  private async executeFixtureSurvey(
    projectId: string,
    plan: Extract<FullAutoPlan, { kind: 'action-execute' }>,
    result?: FullAutoSurveyResult,
  ) {
    if (this.serviceToken === null) {
      throw new KernelApiError(403, 'service_token_required', 'research-orchestrator has no service token; fixture survey parked')
    }
    if (this.orchestratorToken === null) {
      throw new KernelApiError(403, 'orchestrator_token_required', 'research-orchestrator has no managed orchestrator credential; fixture survey parked')
    }
    if (plan.expected_authority_sha256 === undefined) {
      throw new KernelApiError(409, 'full_auto_survey_authority_required', 'canonical survey mutation requires a pre-I/O authority hash')
    }
    return FullAutoSurveyResponseSchema.parse(await this.request<unknown>(
      `/internal/projects/${encodeURIComponent(projectId)}/full-auto-actions/survey-run`,
      {
        method: 'POST',
        headers: {
          'x-service-token': this.serviceToken,
          'x-service-principal': 'research-orchestrator',
          'x-orchestrator-token': this.orchestratorToken,
        },
        body: JSON.stringify({
          expected_project_revision: plan.expected_project_revision,
          action_id: plan.action_id,
          action_revision: plan.action_revision,
          expected_authority_sha256: plan.expected_authority_sha256,
          idempotency_key: plan.idempotency_key,
          ...(result === undefined ? {} : { result }),
        }),
      },
    ))
  }

  private async prepareFixtureSurvey(
    projectId: string,
    plan: Extract<FullAutoPlan, { kind: 'action-execute' }>,
  ): Promise<FullAutoSurveyAuthorityContext> {
    if (this.serviceToken === null) {
      throw new KernelApiError(403, 'service_token_required', 'research-orchestrator has no service token; fixture survey parked')
    }
    if (this.orchestratorToken === null) {
      throw new KernelApiError(403, 'orchestrator_token_required', 'research-orchestrator has no managed orchestrator credential; fixture survey parked')
    }
    return FullAutoSurveyAuthorityContextSchema.parse(await this.request<unknown>(
      `/internal/projects/${encodeURIComponent(projectId)}/full-auto-actions/survey-run/authority`,
      {
        method: 'POST',
        headers: {
          'x-service-token': this.serviceToken,
          'x-service-principal': 'research-orchestrator',
          'x-orchestrator-token': this.orchestratorToken,
        },
        body: JSON.stringify({
          expected_project_revision: plan.expected_project_revision,
          action_id: plan.action_id,
          action_revision: plan.action_revision,
        }),
      },
    ))
  }

  async pollOnce(): Promise<PollResult> {
    const result: PollResult = { polled_at: new Date().toISOString(), projects: 0, planned: 0, executed: 0, errors: [], details: [] }
    let projects: ResearchProjectValue[]
    try {
      projects = await this.listProjects()
    } catch (error) {
      result.errors.push(`listProjects: ${(error as Error).message}`)
      return result
    }
    result.projects = projects.length
    for (const listed of projects) {
      const detail: ProjectPollDetail = {
        project_id: listed.project_id,
        status: listed.status,
        planned: [],
        executed: [],
        parked: [],
        skipped: [],
        errors: [],
      }
      try {
        if (!this.dryRun) {
          const claim = this.store.claimLease(listed.project_id, this.owner, this.leaseSeconds)
          if (!claim.granted) {
            detail.skipped.push(`lease held by another orchestrator owner (generation ${claim.generation})`)
            result.details.push(detail)
            continue
          }
          this.ownedProjects.add(listed.project_id)
        }
        let projection = await this.getProjection(listed.project_id)
        detail.status = projection.project.status
        if (projection.project.mode !== 'full-auto') {
          detail.skipped.push('project mode is gate-only')
          result.details.push(detail)
          continue
        }
        // One poll may close a bounded chain (Gate receipt -> fresh survey ->
        // next authoritative action). Every step re-reads the Kernel; no plan
        // is carried across a mutation or inferred in the browser/worker.
        for (let step = 0; step < 8; step += 1) {
          const existing = this.dryRun ? [] : this.store.listByProject(listed.project_id)
          const reconciledGates = await this.reconcileCommittedGateActions(projection, existing, detail)
          const reconciledSurveys = await this.reconcileCommittedSurveyActions(projection, existing, detail)
          const reconciled = reconciledGates + reconciledSurveys
          result.executed += reconciled
          if (reconciled > 0) {
            projection = await this.getProjection(listed.project_id)
            detail.status = projection.project.status
          }
          const plans = decideFullAutoPlans(
            projection,
            this.dryRun ? [] : this.store.listByProject(listed.project_id),
          )
          const plan = plans[0]
          if (plan === undefined) break
          detail.planned.push(plan)
          result.planned += 1
          const executed = await this.executePlan(projection, plan, detail)
          if (executed) result.executed += 1
          const outcome = detail.executed.at(-1)?.result
          if (this.dryRun || !executed || outcome !== 'done') break
          projection = await this.getProjection(listed.project_id)
          detail.status = projection.project.status
        }
        if (!this.dryRun) this.store.refreshLease(listed.project_id, this.owner, this.leaseSeconds)
      } catch (error) {
        const message = (error as Error).message
        detail.errors.push(message)
        result.errors.push(`${listed.project_id}: ${message}`)
      }
      result.details.push(detail)
    }
    return result
  }

  /**
   * Close the only cross-database crash window: if the Kernel committed a
   * Gate decision after ActionStore wrote `running` but before it wrote
   * `done`, the next projection no longer contains that Gate. Replay the
   * exact internal request and require the same durable Kernel receipt before
   * marking the recovered action complete.
   */
  private async reconcileCommittedGateActions(
    projection: KernelProjection,
    actions: Action[],
    detail: ProjectPollDetail,
  ): Promise<number> {
    if (this.dryRun) return 0
    let reconciled = 0
    const pendingIds = new Set(projection.pending_gates.map(gate => gate.gate_id))
    for (const action of actions) {
      if (action.status !== 'queued' && !(action.status === 'failed' && action.attempt < action.max_attempts)) continue
      const plan = gatePlanFromAction(action)
      if (plan === null || pendingIds.has(plan.gate_id)) continue
      if (this.serviceToken === null) {
        const park: ParkReason = {
          code: 'service_token_required',
          reason: 'Cannot reconcile a recovered full-auto Gate without the Kernel service credential',
          action_id: action.action_id,
          gate_id: plan.gate_id,
        }
        this.store.updateStatus(action.action_id, 'blocked', { attempt: action.attempt + 1, last_error: JSON.stringify(park) })
        this.lastPark = park
        detail.parked.push(park)
        detail.executed.push({ type: plan.type, idempotency_key: plan.idempotency_key, result: 'blocked' })
        reconciled += 1
        continue
      }
      try {
        const approved = await this.approveFixtureGate(projection.project.project_id, plan)
        if (approved.receipt.project_id !== projection.project.project_id
          || approved.receipt.gate_id !== plan.gate_id
          || approved.receipt.project_revision !== plan.expected_project_revision
          || approved.receipt.idempotency_key !== plan.idempotency_key
          || approved.gate.status !== 'approved') {
          throw new KernelApiError(409, 'full_auto_receipt_mismatch', 'replayed Kernel receipt does not match the recovered Action pins')
        }
        this.store.updateStatus(action.action_id, 'done', { attempt: action.attempt + 1, last_error: null })
        detail.executed.push({ type: plan.type, idempotency_key: plan.idempotency_key, result: 'done' })
        reconciled += 1
      } catch (error) {
        if (error instanceof KernelApiError && error.status >= 400 && error.status < 500) {
          const park: ParkReason = {
            code: error.code === 'orchestrator_token_required' ? 'orchestrator_token_required' : 'authority_rejected',
            reason: `${error.code}: ${error.message}`,
            action_id: action.action_id,
            gate_id: plan.gate_id,
          }
          this.store.updateStatus(action.action_id, 'blocked', { attempt: action.attempt + 1, last_error: JSON.stringify(park) })
          this.lastPark = park
          detail.parked.push(park)
          detail.executed.push({ type: plan.type, idempotency_key: plan.idempotency_key, result: 'blocked' })
          reconciled += 1
        } else {
          this.recordFailure(action, error)
          detail.executed.push({ type: plan.type, idempotency_key: plan.idempotency_key, result: 'failed' })
          reconciled += 1
        }
      }
    }
    return reconciled
  }

  /**
   * Recover the survey cross-database window. A no-result replay can only
   * succeed when the Kernel already committed the receipt; otherwise the
   * still-current action is left queued so the connector can run again.
   */
  private async reconcileCommittedSurveyActions(
    projection: KernelProjection,
    actions: Action[],
    detail: ProjectPollDetail,
  ): Promise<number> {
    if (this.dryRun) return 0
    let reconciled = 0
    for (const action of actions) {
      if (action.status !== 'queued' && !(action.status === 'failed' && action.attempt < action.max_attempts)) continue
      const plan = surveyPlanFromAction(action)
      if (plan === null) continue
      const current = projection.next_actions_v2.find(candidate => candidate.id === plan.action_id)
      const stillCurrent = projection.project.revision === plan.expected_project_revision
        && current?.code === 'survey_run' && current.revision === plan.action_revision
        && current.state === 'ready' && current.required === true && current.required_by === 'agent'
      try {
        const replay = await this.executeFixtureSurvey(projection.project.project_id, plan)
        if (replay.receipt.project_id !== projection.project.project_id
          || replay.receipt.action.id !== plan.action_id
          || replay.receipt.action.revision !== plan.action_revision
          || replay.receipt.project_revision !== plan.expected_project_revision
          || replay.receipt.idempotency_key !== plan.idempotency_key
          || replay.snapshot.snapshot_id !== replay.receipt.snapshot_id) {
          throw new KernelApiError(409, 'full_auto_receipt_mismatch', 'replayed survey receipt does not match the recovered Action pins')
        }
        this.store.updateStatus(action.action_id, 'done', { attempt: action.attempt + 1, last_error: null })
        detail.executed.push({ type: plan.type, idempotency_key: plan.idempotency_key, result: 'done' })
        reconciled += 1
      } catch (error) {
        if (error instanceof KernelApiError && error.code === 'full_auto_survey_result_required' && stillCurrent) {
          // The Kernel did not commit before the crash. Leave the recovered
          // row queued; executePlan will re-run the connector under same pins.
          continue
        }
        const park: ParkReason = {
          code: error instanceof KernelApiError
            && (error.code === 'revision_conflict' || error.code === 'full_auto_action_not_ready'
              || error.code === 'full_auto_survey_authority_changed')
            ? 'stale_projection'
            : error instanceof KernelApiError && error.code === 'service_token_required'
              ? 'service_token_required'
              : error instanceof KernelApiError && error.code === 'orchestrator_token_required'
                ? 'orchestrator_token_required'
              : 'postcondition_failed',
          reason: error instanceof KernelApiError ? `${error.code}: ${error.message}` : (error as Error).message,
          action_id: action.action_id,
          gate_id: null,
        }
        this.store.updateStatus(action.action_id, 'blocked', { attempt: action.attempt + 1, last_error: JSON.stringify(park) })
        this.lastPark = park
        detail.parked.push(park)
        detail.executed.push({ type: plan.type, idempotency_key: plan.idempotency_key, result: 'blocked' })
        reconciled += 1
      }
    }
    return reconciled
  }

  private async executePlan(projection: KernelProjection, plan: FullAutoPlan, detail: ProjectPollDetail): Promise<boolean> {
    const projectId = projection.project.project_id
    if (plan.kind === 'action-execute') {
      return this.executeSurveyPlan(projection, plan, detail)
    }
    const existing = this.store.get(projectId, plan.idempotency_key)
    if (existing !== null && (existing.status === 'done' || existing.status === 'blocked'
      || (existing.status === 'failed' && existing.attempt >= existing.max_attempts))) {
      detail.skipped.push(`${plan.type} (already ${existing.status})`)
      return false
    }
    if (this.dryRun) {
      if (plan.kind === 'park') detail.parked.push(plan.park)
      detail.executed.push({ type: plan.type, idempotency_key: plan.idempotency_key, result: plan.kind === 'park' ? 'blocked' : 'done' })
      return true
    }
    const action = existing ?? ActionStore.newAction({
      project_id: projectId,
      phase: projection.project.status,
      type: plan.type,
      idempotency_key: plan.idempotency_key,
      max_attempts: this.maxAttempts,
      last_error: null,
    })
    if (existing === null) this.store.insert(action)
    if (plan.kind === 'park') {
      const serialized = JSON.stringify(plan.park)
      this.store.updateStatus(action.action_id, 'blocked', { attempt: action.attempt + 1, last_error: serialized })
      this.lastPark = plan.park
      detail.parked.push(plan.park)
      detail.executed.push({ type: plan.type, idempotency_key: plan.idempotency_key, result: 'blocked' })
      this.log(`parked ${projectId}: ${plan.park.code} — ${plan.park.reason}`)
      return true
    }

    if (this.serviceToken === null) {
      const park: ParkReason = {
        code: 'service_token_required',
        reason: 'Kernel service credential is unavailable; full-auto Gate approval is parked until DSH restarts with its private service token',
        action_id: null,
        gate_id: plan.gate_id,
      }
      this.store.updateStatus(action.action_id, 'blocked', { attempt: action.attempt + 1, last_error: JSON.stringify(park) })
      this.lastPark = park
      detail.parked.push(park)
      detail.executed.push({ type: plan.type, idempotency_key: plan.idempotency_key, result: 'blocked' })
      this.log(`parked ${projectId}: ${park.code} — ${park.reason}`)
      return true
    }
    if (this.orchestratorToken === null) {
      const park: ParkReason = {
        code: 'orchestrator_token_required',
        reason: 'Managed orchestrator credential is unavailable; full-auto Gate approval is parked until the sidecar restarts the worker',
        action_id: null,
        gate_id: plan.gate_id,
      }
      this.store.updateStatus(action.action_id, 'blocked', { attempt: action.attempt + 1, last_error: JSON.stringify(park) })
      this.lastPark = park
      detail.parked.push(park)
      detail.executed.push({ type: plan.type, idempotency_key: plan.idempotency_key, result: 'blocked' })
      this.log(`parked ${projectId}: ${park.code} — ${park.reason}`)
      return true
    }

    this.store.updateStatus(action.action_id, 'running', { attempt: action.attempt + 1, last_error: null })
    try {
      const approved = await this.approveFixtureGate(projectId, plan)
      if (approved.receipt.project_id !== projectId || approved.receipt.gate_id !== plan.gate_id
        || approved.receipt.idempotency_key !== plan.idempotency_key || approved.gate.status !== 'approved') {
        throw new KernelApiError(409, 'full_auto_receipt_mismatch', 'Kernel returned a receipt that does not match the requested project/gate/idempotency pins')
      }
      const after = await this.getProjection(projectId)
      if (after.pending_gates.some(gate => gate.gate_id === plan.gate_id)) {
        const park: ParkReason = {
          code: 'postcondition_failed',
          reason: `Kernel receipt exists but Gate ${plan.gate_id} remains pending in the authoritative projection`,
          action_id: null,
          gate_id: plan.gate_id,
        }
        this.store.updateStatus(action.action_id, 'blocked', { last_error: JSON.stringify(park) })
        this.lastPark = park
        detail.parked.push(park)
        detail.executed.push({ type: plan.type, idempotency_key: plan.idempotency_key, result: 'blocked' })
        return true
      }
      this.store.updateStatus(action.action_id, 'done', { last_error: null })
      detail.executed.push({ type: plan.type, idempotency_key: plan.idempotency_key, result: 'done' })
      return true
    } catch (error) {
      if (error instanceof KernelApiError && error.status >= 400 && error.status < 500) {
        const park: ParkReason = {
          code: error.code === 'service_token_required'
            ? 'service_token_required'
            : error.code === 'orchestrator_token_required'
              ? 'orchestrator_token_required'
              : 'authority_rejected',
          reason: `${error.code}: ${error.message}`,
          action_id: null,
          gate_id: plan.gate_id,
        }
        this.store.updateStatus(action.action_id, 'blocked', { last_error: JSON.stringify(park) })
        this.lastPark = park
        detail.parked.push(park)
        detail.executed.push({ type: plan.type, idempotency_key: plan.idempotency_key, result: 'blocked' })
        this.log(`parked ${projectId}: ${park.code} — ${park.reason}`)
        return true
      }
      this.recordFailure(action, error)
      detail.executed.push({ type: plan.type, idempotency_key: plan.idempotency_key, result: 'failed' })
      return true
    }
  }

  private async executeSurveyPlan(
    projection: KernelProjection,
    plan: Extract<FullAutoPlan, { kind: 'action-execute' }>,
    detail: ProjectPollDetail,
  ): Promise<boolean> {
    const projectId = projection.project.project_id
    let pinnedPlan = plan
    let action: Action
    try {
      if (this.serviceToken === null || this.surveyExecutor === null) {
        action = this.store.get(projectId, plan.idempotency_key) ?? ActionStore.newAction({
          project_id: projectId,
          phase: projection.project.status,
          type: plan.type,
          idempotency_key: plan.idempotency_key,
          max_attempts: this.maxAttempts,
        })
        if (this.store.get(projectId, plan.idempotency_key) === null) this.store.insert(action)
      } else {
        const authority = await this.prepareFixtureSurvey(projectId, plan)
        if (authority.project_id !== projectId
          || authority.project_revision !== plan.expected_project_revision
          || authority.action.id !== plan.action_id
          || authority.action.revision !== plan.action_revision) {
          throw new KernelApiError(409, 'full_auto_survey_authority_mismatch', 'survey authority context does not match the requested project/action pins')
        }
        pinnedPlan = {
          ...plan,
          expected_authority_sha256: authority.authority_sha256,
          idempotency_key: `${plan.idempotency_key}:${authority.authority_sha256}`,
        }
        detail.planned[detail.planned.length - 1] = pinnedPlan
        const existing = this.store.get(projectId, pinnedPlan.idempotency_key)
        if (existing !== null && (existing.status === 'done' || existing.status === 'blocked'
          || (existing.status === 'failed' && existing.attempt >= existing.max_attempts))) {
          detail.skipped.push(`${pinnedPlan.type} (already ${existing.status})`)
          return false
        }
        action = existing ?? ActionStore.newAction({
          project_id: projectId,
          phase: projection.project.status,
          type: pinnedPlan.type,
          idempotency_key: pinnedPlan.idempotency_key,
          max_attempts: this.maxAttempts,
        })
        if (existing === null) this.store.insert(action)
      }
    } catch (error) {
      action = this.store.get(projectId, plan.idempotency_key) ?? ActionStore.newAction({
        project_id: projectId,
        phase: projection.project.status,
        type: plan.type,
        idempotency_key: plan.idempotency_key,
        max_attempts: this.maxAttempts,
      })
      if (this.store.get(projectId, plan.idempotency_key) === null) this.store.insert(action)
      const value: ParkReason = {
        code: error instanceof KernelApiError && error.code === 'service_token_required'
          ? 'service_token_required'
          : error instanceof KernelApiError && error.code === 'orchestrator_token_required'
            ? 'orchestrator_token_required'
            : 'stale_projection',
        reason: error instanceof KernelApiError ? `${error.code}: ${error.message}` : (error as Error).message,
        action_id: action.action_id,
        gate_id: null,
      }
      this.store.updateStatus(action.action_id, 'blocked', { attempt: action.attempt + 1, last_error: JSON.stringify(value) })
      this.lastPark = value
      detail.parked.push(value)
      detail.executed.push({ type: plan.type, idempotency_key: plan.idempotency_key, result: 'blocked' })
      return true
    }
    const park = (code: ParkCode, reason: string): true => {
      const value: ParkReason = { code, reason, action_id: action.action_id, gate_id: null }
      this.store.updateStatus(action.action_id, 'blocked', { attempt: action.attempt + 1, last_error: JSON.stringify(value) })
      this.lastPark = value
      detail.parked.push(value)
      detail.executed.push({ type: pinnedPlan.type, idempotency_key: pinnedPlan.idempotency_key, result: 'blocked' })
      this.log(`parked ${projectId}: ${value.code} — ${value.reason}`)
      return true
    }
    if (this.serviceToken === null) {
      return park('service_token_required', 'Kernel service credential is unavailable; canonical survey is parked until DSH restarts with its private service token')
    }
    if (this.orchestratorToken === null) {
      return park('orchestrator_token_required', 'Managed orchestrator credential is unavailable; canonical survey is parked until the sidecar restarts the worker')
    }
    if (this.surveyExecutor === null) {
      return park('unsupported_executor', 'the plugin did not register its canonical survey connector adapter; no corpus success was fabricated')
    }

    this.store.updateStatus(action.action_id, 'running', { attempt: action.attempt + 1, last_error: null })
    try {
      const query = projection.project.brief.problem.trim()
      if (query === '') return park('parameters_incomplete', 'the complete Research Brief problem is required as the canonical survey query')
      const result = FullAutoSurveyResultSchema.parse(await this.surveyExecutor(query))

      // Connector I/O can outlive the projection. Re-read before the Kernel
      // mutation and stop locally if any action/project pin moved.
      const current = await this.getProjection(projectId)
      const currentAction = current.next_actions_v2.find(candidate => candidate.id === plan.action_id)
      if (current.project.revision !== plan.expected_project_revision
        || currentAction?.code !== 'survey_run'
        || currentAction.revision !== plan.action_revision
        || currentAction.state !== 'ready'
        || currentAction.required !== true
        || currentAction.required_by !== 'agent') {
        return park('stale_projection', `survey_run pins changed during connector retrieval; expected project/action revision ${plan.expected_project_revision}/${plan.action_revision}`)
      }

      const executed = await this.executeFixtureSurvey(projectId, pinnedPlan, result)
      if (executed.receipt.project_id !== projectId
        || executed.receipt.action.id !== pinnedPlan.action_id
        || executed.receipt.action.revision !== pinnedPlan.action_revision
        || executed.receipt.project_revision !== pinnedPlan.expected_project_revision
        || executed.receipt.authority_sha256 !== pinnedPlan.expected_authority_sha256
        || executed.receipt.idempotency_key !== pinnedPlan.idempotency_key
        || executed.snapshot.snapshot_id !== executed.receipt.snapshot_id
        || executed.snapshot.project_id !== projectId
        || !executed.snapshot.frozen) {
        return park('postcondition_failed', 'Kernel survey receipt/snapshot does not match the requested project/action/revision pins')
      }
      const after = await this.getProjection(projectId)
      if (after.next_actions_v2.some(candidate => candidate.id === plan.action_id || candidate.code === 'survey_run')
        || after.counts.corpus_snapshots <= projection.counts.corpus_snapshots) {
        return park('postcondition_failed', 'Kernel survey receipt exists but the authoritative projection did not retire survey_run with a new corpus')
      }
      this.store.updateStatus(action.action_id, 'done', { last_error: null })
      detail.executed.push({ type: pinnedPlan.type, idempotency_key: pinnedPlan.idempotency_key, result: 'done' })
      return true
    } catch (error) {
      if (error instanceof KernelApiError && error.status >= 400 && error.status < 500) {
        return park(
          error.code === 'revision_conflict' || error.code === 'full_auto_action_not_ready'
            || error.code === 'full_auto_survey_authority_changed'
            ? 'stale_projection'
            : error.code === 'service_token_required'
              ? 'service_token_required'
              : error.code === 'orchestrator_token_required'
                ? 'orchestrator_token_required'
              : 'authority_rejected',
          `${error.code}: ${error.message}`,
        )
      }
      this.recordFailure(action, error)
      detail.executed.push({ type: pinnedPlan.type, idempotency_key: pinnedPlan.idempotency_key, result: 'failed' })
      return true
    }
  }

  private recordFailure(action: Action, error: unknown): void {
    const attempt = action.attempt + 1
    const message = error instanceof KernelApiError
      ? JSON.stringify({ code: error.code, reason: error.message })
      : JSON.stringify({ code: 'executor_failed', reason: (error as Error).message ?? String(error) })
    this.store.updateStatus(action.action_id, attempt >= action.max_attempts ? 'failed' : 'queued', { attempt, last_error: message })
    this.log(`action ${action.type} for ${action.project_id} failed (${attempt}/${action.max_attempts}): ${message}`)
  }

  async start(): Promise<void> {
    this.stopped = false
    this.running = true
    this.log(`polling ${this.kernelUrl} every ${this.pollMs}ms (fixture full-auto, dryRun=${this.dryRun})`)
    try {
      while (!this.stopped) {
        try {
          const result = await this.pollOnce()
          this.log(`round done: ${result.projects} project(s), ${result.planned} planned, ${result.executed} executed, ${result.errors.length} error(s)`)
        } catch (error) {
          this.log(`round failed: ${(error as Error).message}`)
        }
        if (this.stopped) break
        await new Promise<void>(resolve => {
          this.wake = resolve
          this.timer = setTimeout(resolve, this.pollMs)
        })
        this.timer = undefined
        this.wake = undefined
      }
    } finally {
      this.running = false
    }
  }

  stop(): void {
    this.stopped = true
    if (this.timer !== undefined) clearTimeout(this.timer)
    this.timer = undefined
    this.wake?.()
    this.wake = undefined
  }
}
