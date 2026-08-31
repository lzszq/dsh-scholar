/** Fixture-only Durable Orchestrator acceptance seam (FULLAUTO-01). */
import { createServer, type Server } from 'node:http'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AddressInfo } from 'node:net'
import { describe, expect, it, vi } from 'vitest'
import { fixtureProject, type Gate, type NextAction, type ResearchProject } from '@dsh-scholar/research-schemas'
import {
  ActionStore,
  Engine,
  decideFullAutoPlans,
  planFullAutoProjection,
  type KernelProjection,
} from '../../workers/research-orchestrator/lib/index.js'

const FIXTURE = 'golden-path-v2'
const PROFILE = 'profile_local_docker_cpu_v1'
const TARGET = 'target_local_docker_v1'
const AUTHORITY_HASH = `sha256:${'b'.repeat(64)}`

function dbPath(): string {
  return join(mkdtempSync(join(tmpdir(), 'dsh-full-auto-orch-')), 'actions.db')
}

function project(overrides: Partial<ResearchProject> = {}): ResearchProject {
  return fixtureProject({
    project_id: 'rsp_auto_1',
    name: 'fixture auto',
    mode: 'full-auto',
    status: 'DRAFT',
    revision: 3,
    brief_status: 'confirmed',
    execution: {
      runner_profile_id: PROFILE,
      runner_target_id: TARGET,
      network_policy: 'allowlist',
      artifact_store: 'local-cas',
      fixture_id: FIXTURE,
    },
    ...overrides,
  })
}

function gate(type: Gate['type'], id = `gate_${type}_1`, payload: Record<string, unknown> = {}): Gate {
  return {
    gate_id: id,
    project_id: 'rsp_auto_1',
    type,
    title: `${type} Gate`,
    summary: '',
    payload,
    status: 'pending',
    dsh_session_id: null,
    dsh_event_id: null,
    created_at: '2026-08-20T00:00:00.000Z',
    decided_at: null,
  }
}

function action(input: Partial<NextAction> & Pick<NextAction, 'code'>): NextAction {
  return {
    id: `${input.code}:rsp_auto_1`,
    code: input.code,
    label: input.code,
    reason: '',
    required: true,
    route: 'overview',
    revision: 3,
    state: 'ready',
    blocking: true,
    refs: [],
    required_by: 'agent',
    ...input,
  }
}

function projection(input: {
  project?: ResearchProject
  gates?: Gate[]
  actions?: NextAction[]
} = {}): KernelProjection {
  const p = input.project ?? project()
  const actions = input.actions ?? []
  return {
    project: p,
    pending_gates: input.gates ?? [],
    jobs: [],
    budget: { project_id: p.project_id, model_cost_usd: 0, gpu_hours: 0, api_requests: 0, storage_bytes: 0, updated_at: p.updated_at },
    counts: { ideas: 0, contracts: 0, claims: 0, evidence: 0, artifacts: 0, corpus_snapshots: 0 },
    next_actions_v2: actions,
  }
}

function surveyResult(query: string) {
  const runAt = '2026-08-20T00:02:00.000Z'
  return {
    queries: [
      { source: 'openalex' as const, query, run_at: runAt },
      { source: 'crossref' as const, query, run_at: runAt },
      { source: 'arxiv' as const, query, run_at: runAt },
    ],
    papers: [],
    passages: [],
    citation_edges: [],
    source_status: 'complete' as const,
  }
}

function pinnedSurveyPlan(plan: ReturnType<typeof planFullAutoProjection>[number]) {
  if (plan?.kind !== 'action-execute') throw new Error('expected survey action plan')
  return {
    ...plan,
    expected_authority_sha256: AUTHORITY_HASH,
    idempotency_key: `${plan.idempotency_key}:${AUTHORITY_HASH}`,
  }
}

interface FakeKernel {
  url: string
  close: () => Promise<void>
  requests: Array<{ method: string; path: string; headers: Record<string, string | string[] | undefined>; body: unknown }>
  state: { projection: KernelProjection; surveyAuthoritySha256: string }
}

async function fakeKernel(initial: KernelProjection, options: { extraProjectionField?: boolean } = {}): Promise<FakeKernel> {
  const state = { projection: initial, surveyAuthoritySha256: AUTHORITY_HASH }
  const requests: FakeKernel['requests'] = []
  const receipts = new Map<string, unknown>()
  const surveyReceipts = new Map<string, unknown>()
  const server: Server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    const chunks: Buffer[] = []
    for await (const chunk of req) chunks.push(chunk as Buffer)
    const raw = Buffer.concat(chunks).toString('utf8')
    const body = raw === '' ? null : JSON.parse(raw)
    requests.push({ method: req.method ?? 'GET', path: url.pathname, headers: req.headers, body })
    const send = (status: number, value: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' })
      res.end(JSON.stringify(value))
    }
    if (req.method === 'GET' && url.pathname === '/v1/projects') return send(200, [state.projection.project])
    if (req.method === 'GET' && url.pathname.endsWith('/projection')) {
      return send(200, options.extraProjectionField ? { ...state.projection, injected: true } : state.projection)
    }
    const match = url.pathname.match(/^\/internal\/projects\/([^/]+)\/full-auto-gates\/([^/]+)\/approve$/)
    if (req.method === 'POST' && match !== null) {
      if (req.headers['x-service-token'] !== 'service-token' || req.headers['x-service-principal'] !== 'research-orchestrator'
        || req.headers['x-orchestrator-token'] !== 'orchestrator-token') {
        return send(403, { error: { code: 'orchestrator_token_required', message: 'denied' } })
      }
      const gateId = decodeURIComponent(match[2]!)
      const request = body as { expected_project_revision: number; idempotency_key: string }
      const replay = receipts.get(request.idempotency_key)
      if (replay !== undefined) return send(200, replay)
      const pending = state.projection.pending_gates.find(item => item.gate_id === gateId)
      if (pending === undefined) return send(409, { error: { code: 'gate_already_decided', message: 'gone' } })
      const decidedGate = { ...pending, status: 'approved' as const, decided_at: '2026-08-20T00:01:00.000Z' }
      const before = state.projection.project
      const after = project({ ...before, status: pending.type === 'scope' ? 'SCOPED' : before.status, revision: before.revision + 1 })
      state.projection = projection({
        project: after,
        gates: state.projection.pending_gates.filter(item => item.gate_id !== gateId),
        actions: [action({ code: 'survey_run', revision: after.revision })],
      })
      const response = {
        gate: decidedGate,
        project: after,
        decision: { decision_id: 'dec_auto_1', gate_id: gateId, decision: 'approved' },
        receipt: {
          authority: 'full_auto_service', project_id: before.project_id,
          project_revision: request.expected_project_revision, gate_id: gateId,
          gate_type: pending.type, idempotency_key: request.idempotency_key,
        },
      }
      receipts.set(request.idempotency_key, response)
      return send(200, response)
    }
    const surveyMatch = url.pathname.match(/^\/internal\/projects\/([^/]+)\/full-auto-actions\/survey-run$/)
    const surveyAuthorityMatch = url.pathname.match(/^\/internal\/projects\/([^/]+)\/full-auto-actions\/survey-run\/authority$/)
    if (req.method === 'POST' && surveyAuthorityMatch !== null) {
      if (req.headers['x-service-token'] !== 'service-token' || req.headers['x-service-principal'] !== 'research-orchestrator'
        || req.headers['x-orchestrator-token'] !== 'orchestrator-token') {
        return send(403, { error: { code: 'orchestrator_token_required', message: 'denied' } })
      }
      const request = body as { expected_project_revision: number; action_id: string; action_revision: number }
      const before = state.projection.project
      const current = state.projection.next_actions_v2.find(item => item.id === request.action_id)
      if (before.revision !== request.expected_project_revision || current?.code !== 'survey_run'
        || current.revision !== request.action_revision) {
        return send(409, { error: { code: 'full_auto_action_not_ready', message: 'stale survey pins' } })
      }
      return send(200, {
        schema_version: 1,
        authority: 'full_auto_service',
        principal_id: 'service:research-orchestrator',
        project_id: before.project_id,
        project_revision: request.expected_project_revision,
        action: { id: request.action_id, code: 'survey_run', revision: request.action_revision, object_sha256: AUTHORITY_HASH },
        query: before.brief.problem,
        query_sha256: AUTHORITY_HASH,
        fixture: { fixture_id: FIXTURE, profile_sha256: AUTHORITY_HASH },
        runner_profile: { profile_id: PROFILE, config_hash: 'profile-hash' },
        runner_target: { target_id: TARGET, revision: 1, config_hash: 'target-hash' },
        budget: { model_cost_usd: 0, gpu_hours: 0, api_requests: 0, storage_bytes: 0, object_sha256: AUTHORITY_HASH },
        protocol_pin: null,
        authority_sha256: state.surveyAuthoritySha256,
      })
    }
    if (req.method === 'POST' && surveyMatch !== null) {
      if (req.headers['x-service-token'] !== 'service-token' || req.headers['x-service-principal'] !== 'research-orchestrator'
        || req.headers['x-orchestrator-token'] !== 'orchestrator-token') {
        return send(403, { error: { code: 'orchestrator_token_required', message: 'denied' } })
      }
      const request = body as {
        expected_project_revision: number
        action_id: string
        action_revision: number
        expected_authority_sha256: string
        idempotency_key: string
        result?: ReturnType<typeof surveyResult>
      }
      const replay = surveyReceipts.get(request.idempotency_key)
      if (replay !== undefined) return send(200, replay)
      if (request.expected_authority_sha256 !== state.surveyAuthoritySha256) {
        return send(409, { error: { code: 'full_auto_survey_authority_changed', message: 'authority pins changed' } })
      }
      if (request.result === undefined) {
        return send(422, { error: { code: 'full_auto_survey_result_required', message: 'connector result required' } })
      }
      const before = state.projection.project
      const current = state.projection.next_actions_v2.find(item => item.id === request.action_id)
      if (before.revision !== request.expected_project_revision || current?.code !== 'survey_run'
        || current.revision !== request.action_revision) {
        return send(409, { error: { code: 'full_auto_action_not_ready', message: 'stale survey pins' } })
      }
      const snapshotId = 'corpus_snap_auto_1'
      const hash = `sha256:${'a'.repeat(64)}`
      const snapshot = {
        snapshot_id: snapshotId,
        project_id: before.project_id,
        schema_version: 1,
        source_status: request.result.source_status,
        queries: request.result.queries,
        papers: request.result.papers,
        passages: request.result.passages,
        citation_edges: request.result.citation_edges,
        external_claims: [],
        quality: { total_papers: request.result.papers.length, dedup_ratio: 0, coverage_note: '' },
        created_at: '2026-08-20T00:03:00.000Z',
        frozen: true,
      }
      const after = project({ ...before, status: 'SURVEYING', revision: before.revision + 1 })
      state.projection = {
        ...projection({ project: after, actions: [action({ code: 'idea_generate', revision: after.revision })] }),
        counts: { ...state.projection.counts, corpus_snapshots: state.projection.counts.corpus_snapshots + 1 },
      }
      const response = {
        snapshot,
        project: after,
        receipt: {
          schema_version: 1,
          authority: 'full_auto_service',
          principal_id: 'service:research-orchestrator',
          project_id: before.project_id,
          project_revision: request.expected_project_revision,
          action: { id: request.action_id, code: 'survey_run', revision: request.action_revision, object_sha256: hash },
          query: before.brief.problem,
          query_sha256: hash,
          result_sha256: hash,
          fixture: { fixture_id: FIXTURE, profile_sha256: hash },
          runner_profile: { profile_id: PROFILE, config_hash: 'profile-hash' },
          runner_target: { target_id: TARGET, revision: 1, config_hash: 'target-hash' },
          budget: {
            model_cost_usd: 0, gpu_hours: 0, api_requests: 0, storage_bytes: 0, object_sha256: hash,
          },
          protocol_pin: null,
          authority_sha256: request.expected_authority_sha256,
          snapshot_id: snapshotId,
          idempotency_key: request.idempotency_key,
          issued_at: '2026-08-20T00:03:00.000Z',
        },
      }
      surveyReceipts.set(request.idempotency_key, response)
      return send(200, response)
    }
    return send(404, { error: { code: 'not_found', message: url.pathname } })
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve())
  })
  const address = server.address() as AddressInfo
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: () => new Promise(resolve => server.close(() => resolve())),
    requests,
    state,
  }
}

describe('full-auto projection planner', () => {
  it('does nothing for gate-only projects', () => {
    expect(planFullAutoProjection(projection({ project: project({ mode: 'gate-only' }) }))).toEqual([])
  })

  it.each(['scope', 'idea', 'contract', 'budget'] as const)('plans exact %s Gate approval from the pending Gate', type => {
    const plans = planFullAutoProjection(projection({ gates: [gate(type)] }))
    expect(plans).toEqual([expect.objectContaining({
      kind: 'gate-approve', gate_id: `gate_${type}_1`, gate_type: type,
      expected_project_revision: 3,
    })])
  })

  it('parks Release and Direction instead of calling an automatic decision path', () => {
    expect(planFullAutoProjection(projection({ gates: [gate('release')] }))[0]).toMatchObject({
      kind: 'park', park: { code: 'release_never_automatic', gate_id: 'gate_release_1' },
    })
    expect(planFullAutoProjection(projection({ gates: [gate('direction')] }))[0]).toMatchObject({
      kind: 'park', park: { code: 'human_action_required', gate_id: 'gate_direction_1' },
    })
  })

  it('parks Brief confirmation, missing parameters, Human actions and unsupported agent executors with typed reasons', () => {
    expect(planFullAutoProjection(projection({ project: project({ brief_status: 'collecting' }) }))[0]).toMatchObject({ park: { code: 'brief_confirmation_required' } })
    expect(planFullAutoProjection(projection({ actions: [action({ code: 'baseline_reproduce', required: ['baseline_command'] })] }))[0]).toMatchObject({ park: { code: 'parameters_incomplete' } })
    expect(planFullAutoProjection(projection({ actions: [action({ code: 'intake_adopt', required_by: 'human' })] }))[0]).toMatchObject({ park: { code: 'human_action_required' } })
    expect(planFullAutoProjection(projection({ actions: [action({ code: 'survey_run' })] }))[0]).toMatchObject({
      kind: 'action-execute', action_code: 'survey_run', action_id: 'survey_run:rsp_auto_1',
      expected_project_revision: 3,
    })
    expect(planFullAutoProjection(projection({ actions: [action({ code: 'survey_run', state: 'blocked', reason: 'protocol missing' })] }))[0])
      .toMatchObject({ park: { code: 'action_not_ready', reason: expect.stringContaining('protocol missing') } })
  })

  it('does not re-plan a durable done/blocked row and retries only below the attempt cap', () => {
    const p = projection({ gates: [gate('scope')] })
    const plan = planFullAutoProjection(p)[0]!
    expect(decideFullAutoPlans(p, [{ idempotency_key: plan.idempotency_key, status: 'done', attempt: 1, max_attempts: 3 }])).toEqual([])
    expect(decideFullAutoPlans(p, [{ idempotency_key: plan.idempotency_key, status: 'blocked', attempt: 1, max_attempts: 3 }])).toEqual([])
    expect(decideFullAutoPlans(p, [{ idempotency_key: plan.idempotency_key, status: 'failed', attempt: 2, max_attempts: 3 }])).toHaveLength(1)
    expect(decideFullAutoPlans(p, [{ idempotency_key: plan.idempotency_key, status: 'failed', attempt: 3, max_attempts: 3 }])).toEqual([])
  })
})

describe('durable full-auto engine', () => {
  it('uses bounded fresh replans to approve Scope, run the canonical survey, then park the unsupported next action', async () => {
    const fake = await fakeKernel(projection({ gates: [gate('scope')] }))
    const engine = new Engine({
      kernelUrl: fake.url,
      dbPath: dbPath(),
      token: 'kernel-token',
      serviceToken: 'service-token',
      orchestratorToken: 'orchestrator-token',
      owner: 'owner-a',
      surveyExecutor: async query => surveyResult(query),
    })
    try {
      const first = await engine.pollOnce()
      expect(first.details[0]?.executed).toEqual([
        expect.objectContaining({ result: 'done', type: 'full-auto-gate:scope' }),
        expect.objectContaining({ result: 'done', type: 'full-auto-action:survey_run' }),
        expect.objectContaining({ result: 'blocked', type: 'park:idea_generate' }),
      ])
      const post = fake.requests.find(request => request.method === 'POST')!
      expect(post.headers.authorization).toBe('Bearer kernel-token')
      expect(post.headers['x-service-token']).toBe('service-token')
      expect(post.headers['x-service-principal']).toBe('research-orchestrator')
      expect(post.headers['x-orchestrator-token']).toBe('orchestrator-token')
      expect(post.body).toMatchObject({ expected_project_revision: 3, idempotency_key: 'full-auto-gate:gate_scope_1:r3' })
      expect(engine.store.listByProject('rsp_auto_1')).toEqual([
        expect.objectContaining({ type: 'full-auto-gate:scope', status: 'done' }),
        expect.objectContaining({ type: 'full-auto-action:survey_run', status: 'done' }),
        expect.objectContaining({ type: 'park:idea_generate', status: 'blocked' }),
      ])

      const second = await engine.pollOnce()
      expect(second.details[0]?.executed).toEqual([])
      expect(fake.requests.filter(request => request.method === 'POST')).toHaveLength(3)
    } finally {
      engine.close()
      await fake.close()
    }
  })

  it('strictly rejects an unknown projection field and performs zero writes', async () => {
    const fake = await fakeKernel(projection({ gates: [gate('scope')] }), { extraProjectionField: true })
    const engine = new Engine({ kernelUrl: fake.url, dbPath: dbPath(), token: 'kernel-token', serviceToken: 'service-token', orchestratorToken: 'orchestrator-token' })
    try {
      const result = await engine.pollOnce()
      expect(result.errors[0]).toContain('Unrecognized key')
      expect(engine.store.list()).toHaveLength(0)
      expect(fake.requests.some(request => request.method === 'POST')).toBe(false)
    } finally {
      engine.close()
      await fake.close()
    }
  })

  it('recovers a running row from the same SQLite file and reconciles it through the idempotent Kernel endpoint', async () => {
    const file = dbPath()
    const p = projection({ gates: [gate('scope')] })
    const plan = planFullAutoProjection(p)[0]!
    const seed = new ActionStore({ dbPath: file })
    seed.insert(ActionStore.newAction({
      project_id: 'rsp_auto_1', phase: 'DRAFT', type: plan.type,
      idempotency_key: plan.idempotency_key, status: 'running', attempt: 0,
    }))
    seed.close()
    const fake = await fakeKernel(p)
    const engine = new Engine({ kernelUrl: fake.url, dbPath: file, token: 'kernel-token', serviceToken: 'service-token', orchestratorToken: 'orchestrator-token' })
    try {
      expect(engine.store.get('rsp_auto_1', plan.idempotency_key)?.status).toBe('queued')
      await engine.pollOnce()
      expect(engine.store.get('rsp_auto_1', plan.idempotency_key)?.status).toBe('done')
      expect(fake.requests.filter(request => request.method === 'POST')).toHaveLength(1)
    } finally {
      engine.close()
      await fake.close()
    }
  })

  it('replays a committed Kernel receipt after a crash between the Kernel write and ActionStore completion', async () => {
    const file = dbPath()
    const p = projection({ gates: [gate('scope')] })
    const plan = planFullAutoProjection(p)[0]!
    const fake = await fakeKernel(p)
    const first = await fetch(`${fake.url}/internal/projects/rsp_auto_1/full-auto-gates/gate_scope_1/approve`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json', authorization: 'Bearer kernel-token',
        'x-service-token': 'service-token', 'x-service-principal': 'research-orchestrator',
        'x-orchestrator-token': 'orchestrator-token',
      },
      body: JSON.stringify({ expected_project_revision: 3, idempotency_key: plan.idempotency_key }),
    })
    expect(first.status).toBe(200)
    const seed = new ActionStore({ dbPath: file })
    seed.insert(ActionStore.newAction({
      project_id: 'rsp_auto_1', phase: 'DRAFT', type: plan.type,
      idempotency_key: plan.idempotency_key, status: 'running', attempt: 1,
    }))
    seed.close()

    const engine = new Engine({ kernelUrl: fake.url, dbPath: file, token: 'kernel-token', serviceToken: 'service-token', orchestratorToken: 'orchestrator-token' })
    try {
      const result = await engine.pollOnce()
      expect(result.details[0]?.executed).toContainEqual(expect.objectContaining({
        type: 'full-auto-gate:scope', result: 'done',
      }))
      expect(engine.store.get('rsp_auto_1', plan.idempotency_key)).toMatchObject({ status: 'done' })
      expect(fake.requests.filter(request => request.method === 'POST')).toHaveLength(2)
    } finally {
      engine.close()
      await fake.close()
    }
  })

  it('reopens a crashed survey Action and reconciles the committed corpus receipt without rerunning connectors', async () => {
    const file = dbPath()
    const scoped = projection({
      project: project({ status: 'SCOPED', revision: 3 }),
      actions: [action({ code: 'survey_run', revision: 3 })],
    })
    const plan = pinnedSurveyPlan(planFullAutoProjection(scoped)[0]!)
    const fake = await fakeKernel(scoped)
    const committed = await fetch(`${fake.url}/internal/projects/rsp_auto_1/full-auto-actions/survey-run`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json', authorization: 'Bearer kernel-token',
        'x-service-token': 'service-token', 'x-service-principal': 'research-orchestrator',
        'x-orchestrator-token': 'orchestrator-token',
      },
      body: JSON.stringify({
        expected_project_revision: 3,
        action_id: 'survey_run:rsp_auto_1',
        action_revision: 3,
        expected_authority_sha256: plan.expected_authority_sha256,
        idempotency_key: plan.idempotency_key,
        result: surveyResult(scoped.project.brief.problem),
      }),
    })
    expect(committed.status).toBe(200)
    const seed = new ActionStore({ dbPath: file })
    seed.insert(ActionStore.newAction({
      project_id: 'rsp_auto_1', phase: 'SCOPED', type: plan.type,
      idempotency_key: plan.idempotency_key, status: 'running', attempt: 1,
    }))
    seed.close()
    const connector = vi.fn(async (query: string) => surveyResult(query))
    const engine = new Engine({
      kernelUrl: fake.url, dbPath: file, token: 'kernel-token', serviceToken: 'service-token',
      orchestratorToken: 'orchestrator-token', surveyExecutor: connector,
    })
    try {
      const result = await engine.pollOnce()
      expect(result.details[0]?.executed).toContainEqual(expect.objectContaining({
        type: 'full-auto-action:survey_run', result: 'done',
      }))
      expect(engine.store.get('rsp_auto_1', plan.idempotency_key)).toMatchObject({ status: 'done' })
      expect(connector).not.toHaveBeenCalled()
      expect(fake.state.projection.counts.corpus_snapshots).toBe(1)
      expect(fake.requests.filter(request => request.path.endsWith('/full-auto-actions/survey-run'))).toHaveLength(2)
    } finally {
      engine.close()
      await fake.close()
    }
  })

  it('parks a stale survey pin after connector I/O and performs zero corpus mutation', async () => {
    const scoped = projection({
      project: project({ status: 'SCOPED', revision: 3 }),
      actions: [action({ code: 'survey_run', revision: 3 })],
    })
    const fake = await fakeKernel(scoped)
    const engine = new Engine({
      kernelUrl: fake.url,
      dbPath: dbPath(),
      token: 'kernel-token',
      serviceToken: 'service-token',
      orchestratorToken: 'orchestrator-token',
      surveyExecutor: async query => {
        const changed = project({ ...fake.state.projection.project, status: 'SCOPED', revision: 4 })
        fake.state.projection = projection({ project: changed, actions: [action({ code: 'survey_run', revision: 4 })] })
        return surveyResult(query)
      },
    })
    try {
      const result = await engine.pollOnce()
      expect(result.details[0]?.parked).toContainEqual(expect.objectContaining({ code: 'stale_projection' }))
      expect(engine.store.listByProject('rsp_auto_1')).toEqual([
        expect.objectContaining({ type: 'full-auto-action:survey_run', status: 'blocked' }),
      ])
      expect(fake.requests.some(request => request.path.endsWith('/full-auto-actions/survey-run'))).toBe(false)
      expect(fake.state.projection.counts.corpus_snapshots).toBe(0)
    } finally {
      engine.close()
      await fake.close()
    }
  })

  it('pins the pre-connector authority hash and parks runner/budget/protocol drift at the Kernel CAS', async () => {
    const scoped = projection({
      project: project({ status: 'SCOPED', revision: 3 }),
      actions: [action({ code: 'survey_run', revision: 3 })],
    })
    const fake = await fakeKernel(scoped)
    const engine = new Engine({
      kernelUrl: fake.url,
      dbPath: dbPath(),
      token: 'kernel-token',
      serviceToken: 'service-token',
      orchestratorToken: 'orchestrator-token',
      surveyExecutor: async query => {
        fake.state.surveyAuthoritySha256 = `sha256:${'c'.repeat(64)}`
        return surveyResult(query)
      },
    })
    try {
      const result = await engine.pollOnce()
      expect(result.details[0]?.parked).toContainEqual(expect.objectContaining({
        code: 'stale_projection',
        reason: expect.stringContaining('full_auto_survey_authority_changed'),
      }))
      expect(engine.store.listByProject('rsp_auto_1')).toEqual([
        expect.objectContaining({
          type: 'full-auto-action:survey_run',
          status: 'blocked',
          idempotency_key: expect.stringContaining(AUTHORITY_HASH),
        }),
      ])
      const mutation = fake.requests.find(request => request.path.endsWith('/full-auto-actions/survey-run'))
      expect(mutation?.body).toMatchObject({ expected_authority_sha256: AUTHORITY_HASH })
      expect(fake.state.projection.counts.corpus_snapshots).toBe(0)
    } finally {
      engine.close()
      await fake.close()
    }
  })

  it('parks typed Release policy durably without any Kernel mutation', async () => {
    const fake = await fakeKernel(projection({ gates: [gate('release')] }))
    const file = dbPath()
    const engine = new Engine({ kernelUrl: fake.url, dbPath: file, token: 'kernel-token', serviceToken: 'service-token', orchestratorToken: 'orchestrator-token' })
    try {
      const result = await engine.pollOnce()
      expect(result.details[0]?.parked).toEqual([expect.objectContaining({ code: 'release_never_automatic' })])
      expect(fake.requests.some(request => request.method === 'POST')).toBe(false)
      const saved = engine.store.listByProject('rsp_auto_1')[0]!
      expect(saved.status).toBe('blocked')
      expect(JSON.parse(saved.last_error ?? '{}')).toMatchObject({ code: 'release_never_automatic' })
    } finally {
      engine.close()
      await fake.close()
    }
  })

  it('parks a missing service credential instead of retrying or falling back', async () => {
    const fake = await fakeKernel(projection({ gates: [gate('scope')] }))
    const engine = new Engine({ kernelUrl: fake.url, dbPath: dbPath(), token: 'kernel-token', orchestratorToken: 'orchestrator-token' })
    try {
      const result = await engine.pollOnce()
      expect(result.details[0]?.parked).toEqual([expect.objectContaining({ code: 'service_token_required' })])
      expect(fake.requests.some(request => request.method === 'POST')).toBe(false)
      expect(engine.store.listByProject('rsp_auto_1')[0]).toMatchObject({ status: 'blocked', attempt: 1 })
    } finally {
      engine.close()
      await fake.close()
    }
  })

  it('parks missing or wrong managed-orchestrator credentials without leaking them', async () => {
    const missingFake = await fakeKernel(projection({ gates: [gate('scope')] }))
    const missing = new Engine({
      kernelUrl: missingFake.url, dbPath: dbPath(), token: 'kernel-token', serviceToken: 'service-token',
    })
    try {
      const result = await missing.pollOnce()
      expect(result.details[0]?.parked).toEqual([expect.objectContaining({ code: 'orchestrator_token_required' })])
      expect(missingFake.requests.some(request => request.method === 'POST')).toBe(false)
    } finally {
      missing.close()
      await missingFake.close()
    }

    const wrongFake = await fakeKernel(projection({ gates: [gate('scope')] }))
    const logs: string[] = []
    const wrongSecret = 'wrong-orchestrator-secret'
    const wrong = new Engine({
      kernelUrl: wrongFake.url, dbPath: dbPath(), token: 'kernel-token', serviceToken: 'service-token',
      orchestratorToken: wrongSecret,
    }, line => logs.push(line))
    try {
      const result = await wrong.pollOnce()
      expect(result.details[0]?.parked).toEqual([expect.objectContaining({ code: 'orchestrator_token_required' })])
      expect(wrongFake.requests.filter(request => request.method === 'POST')).toHaveLength(1)
      expect(wrongFake.state.projection.pending_gates).toHaveLength(1)
      expect(logs.join('\n')).not.toContain(wrongSecret)
    } finally {
      wrong.close()
      await wrongFake.close()
    }
  })

  it('one live lease owner drives a project and close releases it for takeover', async () => {
    const fake = await fakeKernel(projection({ gates: [gate('scope')] }))
    const file = dbPath()
    const first = new Engine({ kernelUrl: fake.url, dbPath: file, token: 'kernel-token', serviceToken: 'service-token', orchestratorToken: 'orchestrator-token', owner: 'first' })
    const second = new Engine({ kernelUrl: fake.url, dbPath: file, token: 'kernel-token', serviceToken: 'service-token', orchestratorToken: 'orchestrator-token', owner: 'second' })
    try {
      await first.pollOnce()
      const skipped = await second.pollOnce()
      expect(skipped.details[0]?.skipped[0]).toContain('lease held')
      first.close()
      const takeover = await second.pollOnce()
      expect(takeover.details[0]?.skipped).toEqual([])
    } finally {
      try { first.close() } catch { /* already closed */ }
      second.close()
      await fake.close()
    }
  })
})
