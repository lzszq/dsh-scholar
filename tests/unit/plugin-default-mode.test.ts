/** DSH-visible project creation honors the plugin row's defaultMode. */
import { describe, expect, it } from 'vitest'
import { parseCommand } from '@deepseek-ai/dsh-commands'
import type { ResearchClient } from '@dsh-scholar/research-client'
import { registerResearchTools, type ResearchToolContext } from '../../src/plugin/tools.js'
import { registerResearchCommands, type CommandContext } from '../../src/plugin/commands.js'

const BRIEF = {
  problem: 'compatibility',
  scope: 'plugin config',
  questions: [],
  primary_metrics: [],
  resources: '',
  risks: [],
  target_outputs: ['paper'],
  target_venue: null,
  baseline_repo: null,
  domain: 'machine-learning',
}

describe('DSH plugin defaultMode', () => {
  it('uses a Scholar-specific release command instead of DSH Web reserved /export', () => {
    const commands = new Map<string, unknown>()
    const ctx = {
      commands: { register: (definition: { name: string }) => commands.set(definition.name, definition) },
    }

    registerResearchCommands(ctx as never, {
      client: {} as ResearchClient,
      cache: { get: async () => undefined, set: async () => undefined },
      unattended: false,
      operatorPrincipal: 'dsh:test-operator',
    } as CommandContext)

    expect(commands.has('export')).toBe(false)
    expect(commands.has('release-bundle')).toBe(true)
  })

  it('applies full-auto to research_project create when the tool call omits mode', async () => {
    let createdMode: unknown
    const client = {
      createProject: async (input: { mode?: string }) => {
        createdMode = input.mode
        return { project_id: 'rsp_fixture', name: 'fixture', brief: BRIEF }
      },
    } as unknown as ResearchClient
    const registered: Array<{ name: string; execute(args: Record<string, unknown>, exec: { agent?: { id: string }; signal: AbortSignal }): Promise<unknown> }> = []
    const toolContext = {
      client,
      cache: { get: async () => undefined, set: async () => undefined },
      ctx: {},
      roles: { set() {} },
      modelFor: () => undefined,
      defaultMode: 'full-auto',
      operatorPrincipal: 'dsh:test-operator',
    } as unknown as ResearchToolContext

    registerResearchTools({ tools: { register: tool => registered.push(tool as never) } }, toolContext)
    const create = registered.find(tool => tool.name === 'research_project')
    expect(create).toBeDefined()
    await create?.execute({
      action: 'create',
      name: 'fixture',
      brief_json: JSON.stringify(BRIEF),
      fixture_id: 'golden-path-v2',
      runner_profile_id: 'profile_local_docker_cpu_v1',
      runner_target_id: 'target_local_docker_v1',
    }, { agent: { id: 'pi' }, signal: new AbortController().signal })

    expect(createdMode).toBe('full-auto')
  })

  it('applies full-auto to /new when the command omits a per-project mode', async () => {
    let createdMode: unknown
    const client = {
      createProject: async (input: { mode?: string }) => {
        createdMode = input.mode
        return { project_id: 'rsp_command', name: 'fixture', status: 'DRAFT', brief: BRIEF }
      },
      createGate: async () => ({ gate_id: 'gate_scope' }),
    } as unknown as ResearchClient
    const commands = new Map<string, { handler(invocation: { agent: { id: string }; rawInput: string }): Promise<unknown> }>()
    const ctx = {
      commands: { register: (definition: { name: string; handler(invocation: { agent: { id: string }; rawInput: string }): Promise<unknown> }) => commands.set(definition.name, definition) },
    }

    registerResearchCommands(ctx as never, {
      client,
      cache: { get: async () => undefined, set: async () => undefined },
      unattended: false,
      defaultMode: 'full-auto',
      operatorPrincipal: 'dsh:test-operator',
    } as CommandContext)
    await commands.get('new')?.handler({
      agent: { id: 'pi' },
      rawInput: `fixture ${JSON.stringify({ ...BRIEF, fixture_id: 'golden-path-v2', runner_profile_id: 'profile_local_docker_cpu_v1', runner_target_id: 'target_local_docker_v1' })}`,
    })

    expect(createdMode).toBe('full-auto')
  })

  it('starts an approved baseline only through the atomic baseline-runs client method', async () => {
    let request: Record<string, unknown> | undefined
    let genericSubmits = 0
    const client = {
      startBaselineRun: async (input: Record<string, unknown>) => {
        request = input
        return {
          project: { project_id: 'rsp_atomic', status: 'BASELINE_REPRO', revision: 8 },
          job: { job_id: 'job_atomic', kind: 'baseline', status: 'queued' },
        }
      },
      submitJob: async () => {
        genericSubmits += 1
        throw new Error('generic submit must not be used')
      },
    } as unknown as ResearchClient
    const registered: Array<{
      name: string
      description: string
      parameters?: { required?: string[] }
      execute(args: Record<string, unknown>, exec: { agent?: { id: string }; signal: AbortSignal }): Promise<unknown>
    }> = []
    registerResearchTools({ tools: { register: tool => registered.push(tool as never) } }, {
      client,
      cache: { get: async () => undefined, set: async () => undefined },
      ctx: {}, roles: { set() {} }, modelFor: () => undefined,
      operatorPrincipal: 'dsh:test-operator',
    } as unknown as ResearchToolContext)

    const baseline = registered.find(tool => tool.name === 'baseline_prepare')
    expect(baseline?.description).toContain('Atomically')
    for (const key of ['expected_revision', 'idempotency_key', 'contract_id', 'code_snapshot_id', 'command_json']) {
      expect(baseline?.parameters?.required).toContain(key)
    }
    const result = await baseline?.execute({
      project_id: 'rsp_atomic',
      expected_revision: 7,
      idempotency_key: 'baseline:contract-1',
      contract_id: 'contract-1',
      code_snapshot_id: 'snap-1',
      seed: 11,
      data_artifact_id: `sha256:${'b'.repeat(64)}`,
      command_json: '["python","train.py"]',
      runner_target_id: 'target-remote-1',
      image_digest: `node@sha256:${'a'.repeat(64)}`,
      output_contract_json: '{"metrics":"/outputs/metrics.json","logs":"/outputs/run.log"}',
    }, { agent: { id: 'pi' }, signal: new AbortController().signal })

    expect(genericSubmits).toBe(0)
    expect(request).toEqual({
      project_id: 'rsp_atomic',
      expected_revision: 7,
      idempotency_key: 'baseline:contract-1',
      contract_id: 'contract-1',
      code_snapshot_id: 'snap-1',
      seed: 11,
      data_artifact_ids: [`sha256:${'b'.repeat(64)}`],
      command: ['python', 'train.py'],
      runner_target_id: 'target-remote-1',
      image_digest: `node@sha256:${'a'.repeat(64)}`,
      output_contract: { metrics: '/outputs/metrics.json', logs: '/outputs/run.log' },
    })
    expect(result).toMatchObject({ ok: true, job: { job_id: 'job_atomic' }, project: { status: 'BASELINE_REPRO' } })
  })

  it('creates a name-only project from DSH rawInput with its separator whitespace', async () => {
    let created: { session_id: string; name: string; idempotency_key: string } | undefined
    const client = {
      createProjectForDshSession: async (input: { session_id: string; name: string; idempotency_key: string }) => {
        created = input
        return {
          project: { project_id: 'rsp_name_only', name: input.name, status: 'DRAFT', brief_status: 'collecting' },
          intake: {}, budget: {}, membership: [], link: {},
        }
      },
    } as unknown as ResearchClient
    const commands = new Map<string, { handler(invocation: { agent: { id: string }; rawInput: string }): Promise<unknown> }>()
    const ctx = {
      commands: { register: (definition: { name: string; handler(invocation: { agent: { id: string }; rawInput: string }): Promise<unknown> }) => commands.set(definition.name, definition) },
    }

    registerResearchCommands(ctx as never, {
      client,
      cache: { get: async () => undefined, set: async () => undefined },
      unattended: false,
      operatorPrincipal: 'dsh:test-operator',
    } as CommandContext)
    const parsed = parseCommand('/new demo')
    expect(parsed).toEqual({ name: 'new', rawInput: ' demo' })
    const result = await commands.get('new')?.handler({
      agent: { id: 'pi' },
      rawInput: parsed!.rawInput,
    })

    expect(result).toMatchObject({ kind: 'success' })
    expect(created).toMatchObject({
      session_id: 'pi',
      name: 'demo',
      idempotency_key: expect.stringMatching(/^dsh-create:/),
    })
  })
})
