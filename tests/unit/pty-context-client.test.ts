import { describe, expect, it } from 'vitest'
import {
  PtyClientModel,
  type PtyControlFrame,
  type PtyFramesPageWire,
  type PtyOpenParams,
  type PtyResult,
  type PtySessionWire,
  type PtyTransport,
} from '../../packages/dsh-research-ui/src/client/pty-session-model'
import {
  PtyContextTabsModel,
  type PtyContextDescriptor,
  type PtyContextSessionsWire,
  type PtyContextTransport,
} from '../../packages/dsh-research-ui/src/client/pty-context-model'

const OPEN: PtyOpenParams = {
  context_id: 'chat_a',
  workspace_id: 'ws_a',
  label: 'analysis',
  purpose: 'inspect results',
  preset: 'bash',
  cwd: '.',
  cols: 80,
  rows: 24,
}

function session(overrides: Partial<PtySessionWire> = {}): PtySessionWire {
  return {
    pty_session_id: 'pty_a',
    principal_id: 'human_a',
    tenant_id: '',
    project_id: 'rsp_a',
    workspace_id: 'ws_a',
    context_kind: 'chat',
    context_id: 'chat_a',
    parent_session_id: 'research_a',
    label: 'analysis',
    purpose: 'inspect results',
    profile: 'profile_remote',
    target: 'target_remote',
    preset: 'bash',
    cwd: '.',
    config_hash: `sha256:${'a'.repeat(64)}`,
    state: 'open',
    generation: 1,
    lease_token: 'lease_a',
    lease_expires_at: '2099-01-01T00:00:00.000Z',
    idle_ttl_s: 900,
    retention_bytes: 1024,
    retained_from_seq: 0,
    last_client_seq: 0,
    last_event_seq: 0,
    total_bytes: 0,
    dropped_bytes: 0,
    adapter_id: 'remote-runner',
    open_at: '2026-08-31T00:00:00.000Z',
    last_activity_at: '2026-08-31T00:00:00.000Z',
    closed_at: null,
    close_reason: null,
    ...overrides,
  }
}

class Transport implements PtyTransport {
  controls: PtyControlFrame[] = []
  framesGenerations: number[] = []
  attaches: number[] = []
  detaches: number[] = []

  async open(params: PtyOpenParams): Promise<PtyResult<PtySessionWire>> {
    expect(params).toEqual(OPEN)
    return { ok: true, data: session() }
  }

  async attach(_id: string, _lease: string, expectedGeneration: number): Promise<PtyResult<PtySessionWire>> {
    this.attaches.push(expectedGeneration)
    return { ok: true, data: session({ state: 'attached', generation: expectedGeneration + 1 }) }
  }

  async detach(_id: string, _lease: string, expectedGeneration: number): Promise<PtyResult<PtySessionWire>> {
    this.detaches.push(expectedGeneration)
    return { ok: true, data: session({ state: 'detached', generation: expectedGeneration + 1 }) }
  }

  async close(_id: string, _lease: string, expectedGeneration: number): Promise<PtyResult<PtySessionWire>> {
    return { ok: true, data: session({ state: 'closed', generation: expectedGeneration, close_reason: 'explicit' }) }
  }

  async getSession(): Promise<PtyResult<PtySessionWire>> {
    return { ok: true, data: session({ state: 'attached', generation: 2 }) }
  }

  async control(_id: string, _lease: string, frame: PtyControlFrame): Promise<PtyResult<{ delivered?: boolean }>> {
    this.controls.push(frame)
    return { ok: true, data: { delivered: true } }
  }

  async frames(_id: string, _lease: string, afterSeq: number, expectedGeneration: number): Promise<PtyResult<PtyFramesPageWire>> {
    this.framesGenerations.push(expectedGeneration)
    return { ok: true, data: {
      pty_session_id: 'pty_a', after_seq: afterSeq, retained_from_seq: 0,
      dropped_bytes: 0, total_bytes: 0, gap: false, frames: [],
    } }
  }
}

describe('REVIEW-PTY-CONTEXT-03 client fencing', () => {
  it('opens by opaque context, attaches explicitly, and sends the current generation on every operation', async () => {
    const transport = new Transport()
    const model = new PtyClientModel({ transport, sessionRefreshEvery: 0 })
    expect(await model.open(OPEN)).toBe(true)
    expect(transport.attaches).toEqual([1])
    expect(model.generation).toBe(2)
    expect(model.sendText('x')).toBe(true)
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(transport.controls[0]).toMatchObject({ expected_generation: 2, client_seq: 1 })
    expect(await model.detach()).toBe(true)
    expect(transport.detaches).toEqual([2])
    expect(model.generation).toBe(3)
    expect(await model.reconnect()).toBe(true)
    expect(transport.attaches).toEqual([1, 3])
    expect(model.generation).toBe(4)
    model.dispose()
  })

  it('surfaces unavailable remote targets and never substitutes local', async () => {
    const transport = new Transport()
    transport.open = async () => ({ ok: false, error: { code: 'pty_target_unavailable', status: 409 } })
    const model = new PtyClientModel({ transport })
    expect(await model.open(OPEN)).toBe(false)
    expect(model.lastError?.code).toBe('pty_target_unavailable')
    expect(model.lastOpenParams?.context_id).toBe('chat_a')
  })
})

const CHAT_A: PtyContextDescriptor = {
  context_kind: 'chat', context_id: 'chat_a', project_id: 'rsp_a', parent_session_id: 'research_a',
  runner_profile_id: 'profile_remote', runner_target_id: 'target_remote', target_kind: 'remote-ssh',
}
const SUB_B: PtyContextDescriptor = {
  context_kind: 'subagent', context_id: 'child_b', project_id: 'rsp_a', parent_session_id: 'chat_a',
  runner_profile_id: 'profile_remote', runner_target_id: 'target_remote', target_kind: 'remote-ssh',
}

class ContextTransport implements PtyContextTransport {
  async listContexts(): Promise<PtyResult<PtyContextDescriptor[]>> {
    return { ok: true, data: [CHAT_A, SUB_B] }
  }
  async listSessions(contextId: string): Promise<PtyResult<PtyContextSessionsWire>> {
    const context = contextId === 'chat_a' ? CHAT_A : SUB_B
    const item = session({
      pty_session_id: contextId === 'chat_a' ? 'pty_a' : 'pty_b',
      context_kind: context.context_kind,
      context_id: context.context_id,
      parent_session_id: context.parent_session_id,
      lease_token: null,
    })
    return { ok: true, data: { context, sessions: [item], active_hint: item.pty_session_id } }
  }
}

describe('REVIEW-PTY-CONTEXT-03 context tabs', () => {
  it('keeps independent active PTYs per context and never reuses the previous input target', async () => {
    const model = new PtyContextTabsModel(new ContextTransport())
    expect(await model.loadProject('rsp_a')).toBe(true)
    expect(await model.selectContext('chat_a')).toBe(true)
    expect(model.activeSessionId).toBe('pty_a')
    expect(await model.selectContext('child_b')).toBe(true)
    expect(model.activeSessionId).toBe('pty_b')
    expect(model.session('pty_a')?.context_id).toBe('chat_a')
    expect(model.activeSession?.context_id).toBe('child_b')
    expect(() => model.selectSession('pty_a')).toThrowError(/another PTY context/)
  })
})
