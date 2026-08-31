import { describe, expect, it, vi } from 'vitest'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  DEFAULT_STAGE_SUBAGENT_CONFIG,
  STAGE_PANEL_POLICIES,
  StageSubagentCoordinator,
  parsePanelPerspectives,
  type StagePanelClient,
  type StagePanelInput,
  type SubagentRuntimeLike,
} from '../../src/plugin/stage-subagents.js'
import { StageSubagentLedger } from '../../src/plugin/stage-subagent-ledger.js'
import { stageProjectScopeDenial } from '../../src/plugin/acl.js'

function projection(overrides: Record<string, unknown> = {}) {
  return {
    project: {
      project_id: 'rsp_panel',
      name: 'Panel project',
      status: 'SCOPED',
      revision: 4,
      constraints: { max_model_cost_usd: 250, max_gpu_hours: 120 },
    },
    pending_gates: [],
    budget: { model_cost_usd: 0, gpu_hours: 0, api_requests: 0 },
    next_actions_v2: [{
      id: 'survey_run:rsp_panel',
      code: 'survey_run',
      revision: 4,
      state: 'ready' as const,
      required_by: 'agent' as const,
    }],
    ...overrides,
  }
}

function clientWith(projections: ReturnType<typeof projection>[] = [projection(), projection()]): StagePanelClient & {
  getProjectBySession: ReturnType<typeof vi.fn>
  projectProjection: ReturnType<typeof vi.fn>
  registerChildLinkFromSession: ReturnType<typeof vi.fn>
  updateChildStateFromSession: ReturnType<typeof vi.fn>
  recordUsage: ReturnType<typeof vi.fn>
} {
  let index = 0
  return {
    getProjectBySession: vi.fn().mockResolvedValue({ project_id: 'rsp_panel' }),
    projectProjection: vi.fn().mockImplementation(async () => projections[Math.min(index++, projections.length - 1)]),
    registerChildLinkFromSession: vi.fn().mockResolvedValue({}),
    updateChildStateFromSession: vi.fn().mockResolvedValue({}),
    recordUsage: vi.fn().mockResolvedValue({}),
  }
}

function input(overrides: Partial<StagePanelInput> = {}): StagePanelInput {
  return {
    projectId: 'rsp_panel',
    sessionId: 'parent-session',
    parent: { id: 'parent-session' },
    signal: new AbortController().signal,
    kind: 'scholar',
    perspectives: [{ label: 'classics' }, { label: 'frontier' }],
    task: 'Survey the field from independent perspectives.',
    idempotencyKey: 'panel-turn-1',
    hostConfirmation: { callId: 'call-panel-turn-1', rootCallId: 'root-panel-turn-1' },
    ...overrides,
  }
}

function coordinator(overrides: Partial<typeof DEFAULT_STAGE_SUBAGENT_CONFIG> = {}): StageSubagentCoordinator {
  return new StageSubagentCoordinator({
    ...DEFAULT_STAGE_SUBAGENT_CONFIG,
    enabled: true,
    ...overrides,
  }, StageSubagentLedger.memory())
}

function dependencies(client: StagePanelClient, runtime: SubagentRuntimeLike) {
  return {
    client,
    runtime,
    roles: { set: vi.fn(), delete: vi.fn() },
    projectScopes: new Map<string, string>(),
    modelFor: vi.fn().mockReturnValue('model-for-panel'),
  }
}

function run(id: string, stopReason = 'completed', structured: unknown = {
  summary: 'safe summary',
  notes: ['note'],
  references: ['doi:10.1/example'],
}) {
  const dispose = vi.fn().mockResolvedValue(undefined)
  return {
    id,
    result: Promise.resolve({ stopReason, structured, output: [{ type: 'text', text: 'raw output must not be returned' }] }),
    dispose,
  }
}

describe('stage-aware research_panel coordinator', () => {
  it('defines an explicit fail-closed policy for every one of the ten research stages', () => {
    expect(Object.keys(STAGE_PANEL_POLICIES)).toEqual([
      'init', 'survey', 'idea', 'reproduce', 'contract', 'experiment',
      'evidence', 'writing', 'review', 'release',
    ])
    expect(Object.fromEntries(Object.entries(STAGE_PANEL_POLICIES).map(([stage, policy]) => [stage, policy.actions])))
      .toEqual({
        init: ['intake_resume'],
        survey: ['survey_run'],
        idea: ['idea_generate'],
        reproduce: ['baseline_reproduce'],
        contract: ['contract_register'],
        experiment: ['pilot_formal_submit'],
        evidence: ['evidence_verify'],
        writing: ['manuscript_write'],
        review: ['reviewer_run'],
        release: ['release_bundle'],
      })
  })

  it('admits every declared stage only for its exact status, action, actor and panel kind', async () => {
    const cases = [
      ['init', 'DRAFT', 'intake_resume', 'human', 'initializer'],
      ['survey', 'SCOPED', 'survey_run', 'agent', 'scholar'],
      ['idea', 'SURVEYING', 'idea_generate', 'agent', 'idea-panel'],
      ['reproduce', 'CONTRACT_APPROVED', 'baseline_reproduce', 'agent', 'reproducer'],
      ['contract', 'IDEA_APPROVED', 'contract_register', 'agent', 'architect'],
      ['experiment', 'BASELINE_REPRO', 'pilot_formal_submit', 'agent', 'experiment-planner'],
      ['evidence', 'EXPERIMENTING', 'evidence_verify', 'agent', 'statistician'],
      ['writing', 'EVIDENCE_READY', 'manuscript_write', 'agent', 'writer'],
      ['review', 'WRITING', 'reviewer_run', 'agent', 'reviewer'],
      ['release', 'REVIEWING', 'release_bundle', 'agent', 'releaser'],
    ] as const
    for (const [stage, status, code, requiredBy, kind] of cases) {
      const current = projection({
        project: {
          project_id: 'rsp_panel', name: 'Panel project', status, revision: 4,
          constraints: { max_model_cost_usd: 250, max_gpu_hours: 120 },
        },
        next_actions_v2: [{ id: `${code}:rsp_panel`, code, revision: 4, state: 'ready', required_by: requiredBy }],
      })
      const runtime = { start: vi.fn().mockResolvedValue(run(`child-${stage}`)) } as unknown as SubagentRuntimeLike
      const result = await coordinator().execute(input({
        kind,
        perspectives: [{ label: stage }],
        idempotencyKey: `stage-${stage}`,
        hostConfirmation: { callId: `call-stage-${stage}`, rootCallId: `root-stage-${stage}` },
      }), dependencies(clientWith([current, current]), runtime))
      expect(result.panel.stage).toBe(stage)
      expect(runtime.start).toHaveBeenCalledOnce()
    }
  })

  it('denies explicit project and job references outside the child project scope', async () => {
    const projectForJob = vi.fn(async (jobId: string) => jobId === 'job-local' ? 'rsp_panel' : 'rsp_foreign')
    await expect(stageProjectScopeDenial('rsp_panel', { project_id: 'rsp_panel' }, projectForJob)).resolves.toBeUndefined()
    await expect(stageProjectScopeDenial('rsp_panel', { project_id: 'rsp_foreign' }, projectForJob)).resolves.toContain('project_id')
    await expect(stageProjectScopeDenial('rsp_panel', { job_id: 'job-foreign' }, projectForJob)).resolves.toContain('job_id')
    await expect(stageProjectScopeDenial('rsp_panel', { job_id: 'job-local' }, projectForJob)).resolves.toBeUndefined()
  })
  it('strictly validates bounded perspective objects', () => {
    expect(parsePanelPerspectives([{ label: ' a ', role: ' classics ' }], 2))
      .toEqual([{ label: 'a', role: 'classics' }])
    expect(() => parsePanelPerspectives([], 2)).toThrow('1-2 perspectives')
    expect(() => parsePanelPerspectives([{ label: 'a', extra: true }], 2)).toThrow('unknown field')
    expect(() => parsePanelPerspectives([{ label: 'a' }, { label: 'b' }, { label: 'c' }], 2)).toThrow('1-2 perspectives')
  })

  it('fails closed before spawn when disabled, cross-session, gated or wrong-stage', async () => {
    const start = vi.fn()
    const runtime = { start } as unknown as SubagentRuntimeLike
    const client = clientWith()

    await expect(new StageSubagentCoordinator(DEFAULT_STAGE_SUBAGENT_CONFIG, StageSubagentLedger.memory())
      .execute(input(), dependencies(client, runtime))).rejects.toThrow('disabled')
    await expect(coordinator().execute(input({ sessionId: 'foreign-session' }), dependencies(client, runtime)))
      .rejects.toThrow('exact DSH session')
    await expect(coordinator().execute(input({ projectId: 'rsp_foreign' }), dependencies(client, runtime)))
      .rejects.toThrow('not linked')

    const gated = clientWith([projection({ pending_gates: [{ gate_id: 'gate_1', type: 'idea', status: 'pending' }] })])
    await expect(coordinator().execute(input(), dependencies(gated, runtime))).rejects.toThrow('Human Gate')

    const wrong = clientWith([projection({
      next_actions_v2: [{ id: 'idea_generate:rsp_panel', code: 'idea_generate', revision: 4, state: 'ready', required_by: 'agent' }],
    })])
    await expect(coordinator().execute(input(), dependencies(wrong, runtime))).rejects.toThrow('not allowed')
    expect(start).not.toHaveBeenCalled()
  })

  it('requires a registry-issued Host confirmation before reserving budget or spawning', async () => {
    const runtime = { start: vi.fn() } as unknown as SubagentRuntimeLike
    const client = clientWith()

    await expect(coordinator().execute(
      input({ hostConfirmation: undefined as never }),
      dependencies(client, runtime),
    )).rejects.toThrow('valid DSH Host confirmation identity')

    expect(client.getProjectBySession).not.toHaveBeenCalled()
    expect(client.projectProjection).not.toHaveBeenCalled()
    expect(client.recordUsage).not.toHaveBeenCalled()
    expect(runtime.start).not.toHaveBeenCalled()
  })

  it('rejects an invalid or exhausted authoritative budget before durable admission', async () => {
    const runtime = { start: vi.fn() } as unknown as SubagentRuntimeLike
    const invalidClient = clientWith([projection({
      budget: { model_cost_usd: 'unknown', gpu_hours: 0, api_requests: 0 },
    })])
    await expect(coordinator().execute(input(), dependencies(invalidClient, runtime)))
      .rejects.toThrow('budget projection is invalid')
    expect(invalidClient.recordUsage).not.toHaveBeenCalled()

    const exhaustedClient = clientWith([projection({
      budget: { model_cost_usd: 250, gpu_hours: 0, api_requests: 0 },
    })])
    await expect(coordinator().execute(input(), dependencies(exhaustedClient, runtime)))
      .rejects.toThrow('no headroom')
    expect(exhaustedClient.recordUsage).not.toHaveBeenCalled()
    expect(runtime.start).not.toHaveBeenCalled()
  })

  it('runs bounded one-shot children, writes topology lifecycle, disposes and records actual requests', async () => {
    const first = run('child-1', 'completed', {
      summary: 'token=super-secret /home/dev/private/result',
      notes: ['n1'],
      references: ['doi:10.1/a'],
    })
    const second = run('child-2')
    const start = vi.fn()
      .mockResolvedValueOnce(first)
      .mockResolvedValueOnce(second)
    const runtime = { start } as unknown as SubagentRuntimeLike
    const client = clientWith()
    const deps = dependencies(client, runtime)

    const result = await coordinator().execute(input(), deps)

    expect(result.panel).toMatchObject({
      kind: 'scholar',
      stage: 'survey',
      project_id: 'rsp_panel',
      session_id: 'parent-session',
      action_code: 'survey_run',
      project_revision: 4,
      stale: false,
    })
    expect(result.panel.members).toHaveLength(2)
    expect(JSON.stringify(result)).not.toContain('super-secret')
    expect(JSON.stringify(result)).not.toContain('/home/dev')
    expect(JSON.stringify(result)).not.toContain('raw output must not be returned')
    expect(result.panel.members[0]?.structured.summary).toContain('[redacted]')
    expect(result.panel.policy_hash).toMatch(/^[0-9a-f]{64}$/)
    expect(result.panel.input_hash).toMatch(/^[0-9a-f]{64}$/)
    expect(result.panel.confirmation_receipt).toMatchObject({
      host_call_id: 'call-panel-turn-1',
      root_call_id: 'root-panel-turn-1',
    })
    expect(result.panel.attempt).toBe(1)
    expect(result.panel.attempts).toHaveLength(2)

    expect(start).toHaveBeenCalledTimes(2)
    for (const call of start.mock.calls) {
      expect(call[0]).toBe('spawn')
      expect(call[1]).toMatchObject({
        parent: { id: 'parent-session' },
        agentOptions: { model: 'model-for-panel' },
        maxDepth: 1,
        toolFilter: { allow: ['literature_search', 'paper_resolve', 'passage_lookup', 'research_status'] },
      })
      expect(call[1].prompt[0].text).toContain('Never approve a Gate')
      expect(call[1].prompt[0].text).not.toContain('idea_create')
    }
    expect(client.registerChildLinkFromSession).toHaveBeenCalledTimes(2)
    expect(client.registerChildLinkFromSession).toHaveBeenCalledWith(expect.objectContaining({
      project_id: 'rsp_panel',
      child_id: 'child-1',
      parent_id: 'parent-session',
      mode: 'one-shot',
      state: 'running',
    }), 'parent-session', expect.anything())
    expect(client.updateChildStateFromSession).toHaveBeenCalledWith('child-1', 'succeeded', 'parent-session', expect.stringContaining('stop_reason=completed; attempt_id='), expect.anything())
    expect(client.updateChildStateFromSession).toHaveBeenCalledWith('child-2', 'succeeded', 'parent-session', expect.stringContaining('stop_reason=completed; attempt_id='), expect.anything())
    expect(first.dispose).toHaveBeenCalledOnce()
    expect(second.dispose).toHaveBeenCalledOnce()
    expect(client.recordUsage).toHaveBeenCalledTimes(2)
    expect(client.recordUsage).toHaveBeenNthCalledWith(1, 'rsp_panel', { api_requests: 1 })
    expect(client.recordUsage).toHaveBeenNthCalledWith(2, 'rsp_panel', { api_requests: 1 })
    expect(result.budget_recorded).toEqual({
      api_requests: 2,
      usage: { input_tokens: null, output_tokens: null, cache_read_tokens: null, cache_write_tokens: null },
      model_cost_usd: null,
    })
  })

  it('maps failed and aborted children to terminal topology states and always disposes', async () => {
    const failed = run('child-failed', 'error')
    const aborted = run('child-aborted', 'aborted')
    const runtime = {
      start: vi.fn().mockResolvedValueOnce(failed).mockResolvedValueOnce(aborted),
    } as unknown as SubagentRuntimeLike
    const client = clientWith()

    const result = await coordinator().execute(input(), dependencies(client, runtime))

    expect(result.panel.members).toEqual([])
    expect(result.panel.failures).toHaveLength(2)
    expect(client.updateChildStateFromSession).toHaveBeenCalledWith('child-failed', 'failed', 'parent-session', expect.any(String), expect.anything())
    expect(client.updateChildStateFromSession).toHaveBeenCalledWith('child-aborted', 'cancelled', 'parent-session', expect.any(String), expect.anything())
    expect(failed.dispose).toHaveBeenCalledOnce()
    expect(aborted.dispose).toHaveBeenCalledOnce()
    expect(client.recordUsage).toHaveBeenCalledTimes(2)
  })

  it('reconciles durable local-session usage even when the run result rejects', async () => {
    const dispose = vi.fn().mockResolvedValue(undefined)
    const child = {
      id: 'child-infrastructure-failure',
      localAgent: {
        session: {
          events: [{
            type: 'assistant/message',
            data: { usage: { inputTokens: 8, outputTokens: 3, cacheReadTokens: 2, cacheWriteTokens: 1 } },
          }],
        },
      },
      result: Promise.reject(new Error('provider result channel failed')),
      dispose,
    }
    const runtime = { start: vi.fn().mockResolvedValue(child) } as unknown as SubagentRuntimeLike
    const result = await coordinator().execute(
      input({ perspectives: [{ label: 'failure-accounting' }] }),
      dependencies(clientWith(), runtime),
    )

    expect(result.panel.members).toEqual([])
    expect(result.panel.attempts[0]?.usage).toEqual({
      input_tokens: 8,
      output_tokens: 3,
      cache_read_tokens: 2,
      cache_write_tokens: 1,
    })
    expect(dispose).toHaveBeenCalledOnce()
  })

  it('enforces plugin-wide concurrency and stable idempotent replay', async () => {
    let resolveFirst!: (value: { stopReason: string; structured: unknown; output: never[] }) => void
    const firstResult = new Promise<{ stopReason: string; structured: unknown; output: never[] }>(resolve => { resolveFirst = resolve })
    const first = { id: 'child-1', result: firstResult, dispose: vi.fn().mockResolvedValue(undefined) }
    const second = run('child-2')
    const runtime = {
      start: vi.fn().mockResolvedValueOnce(first).mockResolvedValueOnce(second),
    } as unknown as SubagentRuntimeLike
    const client = clientWith()
    const deps = dependencies(client, runtime)
    const owner = coordinator({ maxConcurrency: 1 })

    const pending = owner.execute(input(), deps)
    await vi.waitFor(() => expect(runtime.start).toHaveBeenCalledTimes(1))
    resolveFirst({ stopReason: 'completed', structured: { summary: 'first' }, output: [] })
    const result = await pending
    expect(runtime.start).toHaveBeenCalledTimes(2)

    const replay = await owner.execute(input(), deps)
    expect(replay).toEqual(result)
    expect(runtime.start).toHaveBeenCalledTimes(2)
    await expect(owner.execute(input({ task: 'different input' }), deps)).rejects.toThrow('idempotency_key conflicts')
    expect(runtime.start).toHaveBeenCalledTimes(2)
    await expect(owner.execute(input({
      idempotencyKey: 'another-key',
      hostConfirmation: { callId: 'call-another-key', rootCallId: 'root-panel-turn-1' },
    }), deps)).rejects.toThrow('already exists for the current action')
  })

  it('replays a terminal panel from the durable ledger after coordinator restart without charging or spawning again', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-scholar-panel-'))
    const path = join(dir, 'ledger.db')
    try {
      const firstLedger = new StageSubagentLedger(path)
      const firstRuntime = { start: vi.fn().mockResolvedValue(run('child-durable')) } as unknown as SubagentRuntimeLike
      const afterOwnCharge = projection({
        budget: { model_cost_usd: 0, gpu_hours: 0, api_requests: 1 },
      })
      const firstClient = clientWith([projection(), afterOwnCharge])
      const firstOwner = new StageSubagentCoordinator({
        ...DEFAULT_STAGE_SUBAGENT_CONFIG,
        enabled: true,
      }, firstLedger)
      const original = await firstOwner.execute(input({ perspectives: [{ label: 'durable' }] }), dependencies(firstClient, firstRuntime))
      firstLedger.close()

      const secondLedger = new StageSubagentLedger(path)
      const secondRuntime = { start: vi.fn() } as unknown as SubagentRuntimeLike
      const secondClient = clientWith([afterOwnCharge])
      const replay = await new StageSubagentCoordinator({
        ...DEFAULT_STAGE_SUBAGENT_CONFIG,
        enabled: true,
      }, secondLedger).execute(input({ perspectives: [{ label: 'durable' }] }), dependencies(secondClient, secondRuntime))

      expect(replay).toEqual(original)
      expect(secondRuntime.start).not.toHaveBeenCalled()
      expect(secondClient.recordUsage).not.toHaveBeenCalled()
      secondLedger.close()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('persists only hashes and safe pins, never raw prompt secrets or host paths', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-scholar-panel-safe-ledger-'))
    const path = join(dir, 'ledger.db')
    const secret = 'sk-panel-persistence-canary-1234567890'
    const hostPath = '/home/dev/private/panel-notes.txt'
    try {
      const ledger = new StageSubagentLedger(path)
      const runtime = { start: vi.fn().mockResolvedValue(run('child-safe-ledger')) } as unknown as SubagentRuntimeLike
      await new StageSubagentCoordinator({
        ...DEFAULT_STAGE_SUBAGENT_CONFIG,
        enabled: true,
      }, ledger).execute(input({
        perspectives: [{ label: `review ${hostPath}`, role: `credential ${secret}` }],
        task: `Authorization: Bearer ${secret}; inspect ${hostPath}`,
        completion: `Do not persist ${secret}`,
      }), dependencies(clientWith(), runtime))
      ledger.close()

      const storedBytes = readFileSync(path).toString('utf8')
      expect(storedBytes).not.toContain(secret)
      expect(storedBytes).not.toContain(hostPath)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('recovers an interrupted paid panel as unknown and never auto-replays it after restart', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-scholar-panel-crash-'))
    const path = join(dir, 'ledger.db')
    const abort = new AbortController()
    const unresolved = new Promise<{ stopReason: string; structured: unknown; output: never[] }>(() => undefined)
    const firstRun = { id: 'child-interrupted', result: unresolved, dispose: vi.fn().mockResolvedValue(undefined) }
    const firstRuntime = { start: vi.fn().mockResolvedValue(firstRun) } as unknown as SubagentRuntimeLike
    const firstLedger = new StageSubagentLedger(path)
    const pending = new StageSubagentCoordinator({
      ...DEFAULT_STAGE_SUBAGENT_CONFIG,
      enabled: true,
    }, firstLedger).execute(
      input({ perspectives: [{ label: 'interrupted' }], signal: abort.signal }),
      dependencies(clientWith(), firstRuntime),
    )
    try {
      await vi.waitFor(() => expect(firstRuntime.start).toHaveBeenCalledOnce())

      // Opening the same durable ledger is the cold-start recovery seam: any
      // reserving/running paid attempt is frozen as unknown before admission.
      const restartedLedger = new StageSubagentLedger(path)
      const restartedRuntime = { start: vi.fn() } as unknown as SubagentRuntimeLike
      await expect(new StageSubagentCoordinator({
        ...DEFAULT_STAGE_SUBAGENT_CONFIG,
        enabled: true,
      }, restartedLedger).execute(
        input({ perspectives: [{ label: 'interrupted' }] }),
        dependencies(clientWith(), restartedRuntime),
      )).rejects.toThrow('interrupted; paid work is unknown')
      expect(restartedRuntime.start).not.toHaveBeenCalled()
      restartedLedger.close()
    } finally {
      abort.abort(new Error('test process terminated'))
      await expect(pending).rejects.toThrow()
      firstLedger.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('freezes an ambiguous budget reservation and blocks every paid retry for the same action', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-scholar-panel-budget-'))
    const path = join(dir, 'ledger.db')
    try {
      const firstLedger = new StageSubagentLedger(path)
      const firstRuntime = { start: vi.fn() } as unknown as SubagentRuntimeLike
      const firstClient = clientWith()
      firstClient.recordUsage.mockRejectedValueOnce(new Error('connection closed after request write'))
      await expect(new StageSubagentCoordinator({
        ...DEFAULT_STAGE_SUBAGENT_CONFIG,
        enabled: true,
      }, firstLedger).execute(
        input({ perspectives: [{ label: 'budget-ambiguous' }] }),
        dependencies(firstClient, firstRuntime),
      )).rejects.toThrow('budget reservation outcome is unknown')
      expect(firstRuntime.start).not.toHaveBeenCalled()
      firstLedger.close()

      const restartedLedger = new StageSubagentLedger(path)
      const restartedRuntime = { start: vi.fn() } as unknown as SubagentRuntimeLike
      const restartedClient = clientWith()
      const restarted = new StageSubagentCoordinator({
        ...DEFAULT_STAGE_SUBAGENT_CONFIG,
        enabled: true,
      }, restartedLedger)
      await expect(restarted.execute(
        input({ perspectives: [{ label: 'budget-ambiguous' }] }),
        dependencies(restartedClient, restartedRuntime),
      )).rejects.toThrow('interrupted; paid work is unknown')
      await expect(restarted.execute(input({
        perspectives: [{ label: 'budget-ambiguous' }],
        idempotencyKey: 'budget-retry-new-key',
        hostConfirmation: { callId: 'call-budget-retry', rootCallId: 'root-panel-turn-1' },
      }), dependencies(restartedClient, restartedRuntime))).rejects.toThrow('interrupted panel with unknown paid work')
      expect(restartedRuntime.start).not.toHaveBeenCalled()
      expect(restartedClient.recordUsage).not.toHaveBeenCalled()
      restartedLedger.close()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('persists one-time Host confirmation consumption and increments a deliberate retry attempt', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-scholar-panel-confirmation-'))
    const path = join(dir, 'ledger.db')
    try {
      const firstLedger = new StageSubagentLedger(path)
      const firstRuntime = { start: vi.fn().mockResolvedValue(run('child-failed', 'error')) } as unknown as SubagentRuntimeLike
      const first = await new StageSubagentCoordinator({
        ...DEFAULT_STAGE_SUBAGENT_CONFIG,
        enabled: true,
      }, firstLedger).execute(
        input({ perspectives: [{ label: 'first-attempt' }] }),
        dependencies(clientWith(), firstRuntime),
      )
      expect(first.panel.attempt).toBe(1)
      expect(first.panel.failures).toHaveLength(1)
      firstLedger.close()

      const restartedLedger = new StageSubagentLedger(path)
      const restartedRuntime = { start: vi.fn().mockResolvedValue(run('child-retry')) } as unknown as SubagentRuntimeLike
      const restarted = new StageSubagentCoordinator({
        ...DEFAULT_STAGE_SUBAGENT_CONFIG,
        enabled: true,
      }, restartedLedger)
      await expect(restarted.execute(input({
        perspectives: [{ label: 'retry' }],
        idempotencyKey: 'retry-consumed-confirmation',
      }), dependencies(clientWith(), restartedRuntime))).rejects.toThrow('Host confirmation call was already consumed')
      expect(restartedRuntime.start).not.toHaveBeenCalled()

      const retry = await restarted.execute(input({
        perspectives: [{ label: 'retry' }],
        idempotencyKey: 'retry-new-confirmation',
        hostConfirmation: { callId: 'call-panel-turn-2', rootCallId: 'root-panel-turn-2' },
      }), dependencies(clientWith(), restartedRuntime))
      expect(retry.panel.attempt).toBe(2)
      expect(retry.panel.members[0]?.attempt).toBe(2)
      expect(retry.panel.confirmation_receipt).toMatchObject({
        host_call_id: 'call-panel-turn-2',
        root_call_id: 'root-panel-turn-2',
      })
      expect(restartedRuntime.start).toHaveBeenCalledOnce()
      restartedLedger.close()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('records four disjoint public-session token buckets, duration and complete snapshot pins without estimating cost', async () => {
    const child = {
      ...run('child-accounted'),
      localAgent: {
        session: {
          events: [
            {
              type: 'assistant/message',
              data: { usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 4, cacheWriteTokens: 2 } },
            },
            {
              type: 'assistant/message',
              data: { usage: { inputTokens: 3, outputTokens: 2, cacheReadTokens: 1 } },
            },
          ],
        },
      },
    }
    const runtime = { start: vi.fn().mockResolvedValue(child) } as unknown as SubagentRuntimeLike
    const pinned = projection({
      project: {
        project_id: 'rsp_panel', name: 'Panel project', status: 'SCOPED', revision: 4,
        constraints: { max_model_cost_usd: 250, max_gpu_hours: 120 },
        execution: { runner_profile_id: 'profile_gpu', runner_target_id: 'target_ssh' },
      },
      next_actions_v2: [{
        id: 'survey_run:rsp_panel', code: 'survey_run', revision: 4, state: 'ready', required_by: 'agent',
        refs: [{ kind: 'corpus_snapshot', id: 'corpus_7' }, { kind: 'code_snapshot', id: 'code_3' }],
      }],
    })
    const accountedClient = clientWith([pinned, pinned])
    const result = await coordinator().execute(
      input({ perspectives: [{ label: 'accounting' }] }),
      dependencies(accountedClient, runtime),
    )

    expect(result.budget_recorded).toEqual({
      api_requests: 1,
      usage: { input_tokens: 13, output_tokens: 7, cache_read_tokens: 5, cache_write_tokens: 2 },
      model_cost_usd: null,
    })
    expect(result.panel.members[0]).toMatchObject({
      attempt: 1,
      usage: { input_tokens: 13, output_tokens: 7, cache_read_tokens: 5, cache_write_tokens: 2 },
      model_cost_usd: null,
    })
    expect(result.panel.members[0]?.duration_ms).toBeGreaterThanOrEqual(0)
    expect(result.panel.snapshot).toMatchObject({
      project_revision: 4,
      action_code: 'survey_run',
      action_state: 'ready',
      action_required_by: 'agent',
      budget_at_admission: { model_cost_usd: 0, gpu_hours: 0, api_requests: 0 },
      constraints_at_admission: { max_model_cost_usd: 250, max_gpu_hours: 120 },
      reserved_api_requests: 1,
      runner_profile_id: 'profile_gpu',
      runner_target_id: 'target_ssh',
      provider_ref: 'spawn',
      model_ref: 'model-for-panel',
    })
    expect(result.panel.snapshot.refs).toEqual([
      { kind: 'code_snapshot', id: 'code_3' },
      { kind: 'corpus_snapshot', id: 'corpus_7' },
    ])
    expect(accountedClient.recordUsage).toHaveBeenNthCalledWith(1, 'rsp_panel', { api_requests: 1 })
    expect(accountedClient.recordUsage).toHaveBeenCalledTimes(1)
  })

  it('marks fan-in results stale when revision or NextAction changes', async () => {
    const runtime = { start: vi.fn().mockResolvedValue(run('child-1')) } as unknown as SubagentRuntimeLike
    const changed = projection({
      project: {
        project_id: 'rsp_panel',
        name: 'Panel project',
        status: 'SURVEYING',
        revision: 5,
        constraints: { max_model_cost_usd: 250, max_gpu_hours: 120 },
      },
      next_actions_v2: [{ id: 'idea_generate:rsp_panel', code: 'idea_generate', revision: 5, state: 'ready', required_by: 'agent' }],
    })
    const client = clientWith([projection(), changed])

    const result = await coordinator().execute(input({ perspectives: [{ label: 'one' }] }), dependencies(client, runtime))
    expect(result.panel.stale).toBe(true)
    expect(result.panel.members).toEqual([])
    expect(result.panel.failures).toContain('panel findings discarded because the project/session/action changed during fan-in')
    expect(result.note).toContain('were discarded')
  })

  it('rejects oversized or open structured output without leaking raw content', async () => {
    const invalid = run('child-invalid', 'completed', { summary: 'safe', extra: 'secret' })
    const runtime = { start: vi.fn().mockResolvedValue(invalid) } as unknown as SubagentRuntimeLike
    const client = clientWith()

    const result = await coordinator().execute(input({ perspectives: [{ label: 'one' }] }), dependencies(client, runtime))
    expect(result.panel.members).toEqual([])
    expect(result.panel.failures[0]).toContain('unknown field')
    expect(client.updateChildStateFromSession).toHaveBeenCalledWith('child-invalid', 'failed', 'parent-session', expect.any(String), expect.anything())
    expect(invalid.dispose).toHaveBeenCalledOnce()
  })

  it('redacts prompt inputs and treats timeout as cancelled even if the provider completes late', async () => {
    let resolveResult!: (value: { stopReason: string; structured: unknown; output: never[] }) => void
    const lateResult = new Promise<{ stopReason: string; structured: unknown; output: never[] }>(resolve => { resolveResult = resolve })
    const child = { id: 'child-timeout', result: lateResult, dispose: vi.fn().mockResolvedValue(undefined) }
    const runtime = { start: vi.fn().mockResolvedValue(child) } as unknown as SubagentRuntimeLike
    const client = clientWith()
    const pending = coordinator({ timeoutMs: 10 }).execute(input({
      perspectives: [{ label: '/home/dev/private' }],
      task: 'Authorization: Basic abcdefghijklmnop -----BEGIN PRIVATE KEY-----\nsecret\n-----END PRIVATE KEY-----',
    }), dependencies(client, runtime))
    const result = await pending
    resolveResult({ stopReason: 'completed', structured: { summary: 'late' }, output: [] })

    const prompt = (runtime.start as ReturnType<typeof vi.fn>).mock.calls[0]?.[1].prompt[0].text as string
    expect(prompt).not.toContain('abcdefghijklmnop')
    expect(prompt).not.toContain('BEGIN PRIVATE KEY')
    expect(prompt).not.toContain('/home/dev')
    expect(result.panel.members).toEqual([])
    expect(client.updateChildStateFromSession).toHaveBeenCalledWith('child-timeout', 'cancelled', 'parent-session', expect.any(String), expect.anything())
    expect(child.dispose).toHaveBeenCalledOnce()
  })

  it('does not let a hanging topology update block child disposal or the panel forever', async () => {
    const child = run('child-update-hangs')
    const runtime = { start: vi.fn().mockResolvedValue(child) } as unknown as SubagentRuntimeLike
    const client = clientWith()
    client.updateChildStateFromSession.mockImplementation(() => new Promise(() => undefined))
    const deps = dependencies(client, runtime)

    const pending = coordinator({ timeoutMs: 10 }).execute(input({ perspectives: [{ label: 'one' }] }), deps)
    await vi.waitFor(() => expect(child.dispose).toHaveBeenCalledOnce())
    const result = await pending

    expect(result.panel.members).toEqual([])
    expect(result.panel.failures[0]).toContain('topology update timed out')
    expect(deps.projectScopes.size).toBe(0)
    expect(deps.roles.delete).toHaveBeenCalledWith('child-update-hangs')
  })
})
