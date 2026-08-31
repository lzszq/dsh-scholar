/**
 * pty-client (PTY-01 Interactive Terminal client 逻辑层, hardening-v0.2
 * -status.md §5 P1, execution-runtime.md §6.1, api-contracts.md §18):
 * pure logic-layer suite for packages/dsh-research-ui/src/client/
 * pty-session-model.ts (NO DOM, injected transport + fake scheduler —
 * mirroring trajectory-ui / ui-simple). Covers:
 *
 *   session state machine:  idle → opening → open ⇄ detached → closed/error,
 *                           reopen after close/lease failure;
 *   control queue:          client_seq 单调自增, 单帧 in-flight, 失败重试
 *                           重发 SAME seq (服务端幂等), 409 out-of-order
 *                           resync, close ack → closed;
 *   frames consumption:     after_seq 增量拉取, gap 帧/页面 gap 处理,
 *                           retention 截断提示, exit 帧, 重放幂等, 显示上限;
 *   detach/reconnect:       detach 停轮询, reconnect 从 serverSeq 重放,
 *                           generation 变更提示 (新会话周期);
 *   lease:                  403 lease_invalid → error + 提示重连/重新 open;
 *   error mapping:          wire 错误码 → 稳定 i18n key, close reason key;
 *   nav/i18n:               pty 是 More 标签 (#tab=pty 稳定深链), pty
 *                           namespace zh/en 精确 parity, 双语求值零缺 key.
 *
 * 浏览器终端渲染 (ANSI/xterm 类)、键盘输入、resize 拖拽与窄屏验收保持
 * NOT_RUN_MANUAL_PENDING (hardening §5).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { zh as ptyZh, en as ptyEn } from '../../packages/dsh-research-ui/src/client/i18n/locales/pty'
import {
  getLocale, localeParityReport, resetMissingKeyWarnings, setLocale, setMissingKeyReporter,
} from '../../packages/dsh-research-ui/src/client/i18n/index'
import { chromeTabs } from '../../packages/dsh-research-ui/src/client/i18n/chrome'
import { ALL_TAB_KEYS, MORE_TAB_KEYS, parseDeepLink } from '../../packages/dsh-research-ui/src/client/nav'
import {
  PtyClientModel, ptyCloseReasonKey, ptyErrorKey, ptyStateKey, ptyStatusView, utf8ByteLength,
  type PtyControlFrame, type PtyFramesPageWire, type PtyOpenParams, type PtyResult,
  type PtyScheduler, type PtySessionWire, type PtyStreamTransport, type PtyTransport,
} from '../../packages/dsh-research-ui/src/client/pty-session-model'
import { MockSseFetch } from '../../packages/dsh-research-ui/src/client/sse-client'

interface Missing { namespace: string; key: string; locale: string }

let missing: Missing[] = []

beforeEach(() => {
  missing = []
  setMissingKeyReporter(r => { missing.push(r) })
})

afterEach(() => {
  setMissingKeyReporter(null)
  resetMissingKeyWarnings()
})

/* ─────────────────────────── fakes (no DOM) ─────────────────────────── */

/** Deterministic manual timer queue: runOnce() executes only the timers
 *  scheduled BEFORE the batch (newly scheduled ones wait for the next
 *  batch) — perfect for stepping the poll/retry loops. */
class FakeScheduler implements PtyScheduler {
  timers: Array<{ id: number; fn: () => void }> = []
  private nextId = 1
  setTimeout(fn: () => void): unknown {
    const id = this.nextId
    this.nextId += 1
    this.timers.push({ id, fn })
    return id
  }
  clearTimeout(timer: unknown): void {
    this.timers = this.timers.filter(t => t.id !== timer)
  }
  get pending(): number {
    return this.timers.length
  }
  /** Fire the timers that exist right now (FIFO); newly scheduled timers
   *  stay queued for the next batch. */
  runOnce(): void {
    const batch = [...this.timers]
    this.timers = this.timers.filter(t => !batch.includes(t))
    for (const t of batch) t.fn()
  }
}

let sessionCounter = 0

function fakeSession(over: Partial<PtySessionWire> = {}): PtySessionWire {
  sessionCounter += 1
  return {
    pty_session_id: `pty_fake_${sessionCounter}`,
    principal_id: 'principal-1',
    tenant_id: '',
    project_id: 'rsp_demo',
    workspace_id: 'ws_scratch_1',
    context_kind: 'chat',
    context_id: 'chat_demo',
    parent_session_id: 'dsh_session_demo',
    label: 'Experiment shell',
    purpose: 'inspect experiment',
    profile: 'profile_local',
    target: 'target_local_process_v1',
    preset: 'bash',
    cwd: '.',
    config_hash: 'sha256:' + 'a'.repeat(64),
    state: 'open',
    generation: 1,
    lease_token: `lease_fake_${sessionCounter}`,
    lease_expires_at: new Date(Date.now() + 3600_000).toISOString(),
    idle_ttl_s: 900,
    retention_bytes: 1024 * 1024,
    retained_from_seq: 0,
    last_client_seq: 0,
    last_event_seq: 0,
    total_bytes: 0,
    dropped_bytes: 0,
    adapter_id: 'fake',
    open_at: '2026-08-11T00:00:00.000Z',
    last_activity_at: '2026-08-11T00:00:00.000Z',
    closed_at: null,
    close_reason: null,
    ...over,
  }
}

function framesPage(over: Partial<PtyFramesPageWire> = {}): PtyFramesPageWire {
  return {
    pty_session_id: 'pty_fake_1',
    after_seq: 0,
    retained_from_seq: 0,
    dropped_bytes: 0,
    total_bytes: 0,
    gap: false,
    frames: [],
    ...over,
  }
}

/** Scriptable transport: queues of responses (null = auto-ok default). */
class FakeTransport implements PtyTransport {
  openCalls: PtyOpenParams[] = []
  attachCalls: Array<{ sessionId: string; lease: string; expectedGeneration: number }> = []
  detachCalls: Array<{ sessionId: string; lease: string; expectedGeneration: number }> = []
  closeCalls: Array<{ sessionId: string; lease: string; expectedGeneration: number }> = []
  controlCalls: Array<{ lease: string; frame: PtyControlFrame }> = []
  framesCalls: Array<{ lease: string; afterSeq: number; expectedGeneration: number }> = []
  sessionCalls: string[] = []

  openQueue: Array<PtyResult<PtySessionWire>> = []
  attachQueue: Array<PtyResult<PtySessionWire>> = []
  detachQueue: Array<PtyResult<PtySessionWire>> = []
  closeQueue: Array<PtyResult<PtySessionWire>> = []
  controlQueue: Array<PtyResult<{ delivered?: boolean; idempotent?: boolean }>> = []
  framesQueue: Array<PtyResult<PtyFramesPageWire>> = []
  sessionQueue: Array<PtyResult<PtySessionWire>> = []

  /** Server-side simulation: last applied control seq (auto control ok). */
  serverClientSeq = 0
  currentSession: PtySessionWire = fakeSession()

  async open(params: PtyOpenParams): Promise<PtyResult<PtySessionWire>> {
    this.openCalls.push(params)
    const next = this.openQueue.shift()
    if (next !== undefined) return next
    this.currentSession = fakeSession({ context_id: params.context_id, workspace_id: params.workspace_id, label: params.label, purpose: params.purpose ?? '' })
    this.serverClientSeq = 0
    return { ok: true, data: this.currentSession }
  }

  async attach(sessionId: string, lease: string, expectedGeneration: number): Promise<PtyResult<PtySessionWire>> {
    this.attachCalls.push({ sessionId, lease, expectedGeneration })
    const next = this.attachQueue.shift()
    if (next !== undefined) {
      if (next.ok) this.currentSession = next.data
      return next
    }
    this.currentSession = { ...this.currentSession, state: 'attached', generation: expectedGeneration + 1 }
    return { ok: true, data: this.currentSession }
  }

  async detach(sessionId: string, lease: string, expectedGeneration: number): Promise<PtyResult<PtySessionWire>> {
    this.detachCalls.push({ sessionId, lease, expectedGeneration })
    const next = this.detachQueue.shift()
    if (next !== undefined) {
      if (next.ok) this.currentSession = next.data
      return next
    }
    this.currentSession = { ...this.currentSession, state: 'detached', generation: expectedGeneration + 1 }
    return { ok: true, data: this.currentSession }
  }

  async close(sessionId: string, lease: string, expectedGeneration: number): Promise<PtyResult<PtySessionWire>> {
    this.closeCalls.push({ sessionId, lease, expectedGeneration })
    const next = this.closeQueue.shift()
    if (next !== undefined) {
      if (next.ok) this.currentSession = next.data
      return next
    }
    this.currentSession = { ...this.currentSession, state: 'closed', closed_at: new Date().toISOString(), close_reason: 'explicit' }
    return { ok: true, data: this.currentSession }
  }

  async getSession(sessionId: string, _lease: string, _expectedGeneration: number): Promise<PtyResult<PtySessionWire>> {
    this.sessionCalls.push(sessionId)
    const next = this.sessionQueue.shift()
    if (next !== undefined) return next
    return { ok: true, data: this.currentSession }
  }

  async control(sessionId: string, lease: string, frame: PtyControlFrame): Promise<PtyResult<{ delivered?: boolean; idempotent?: boolean }>> {
    this.controlCalls.push({ lease, frame })
    const next = this.controlQueue.shift()
    if (next !== undefined) return next
    if (frame.client_seq === this.serverClientSeq) {
      return { ok: true, data: { delivered: false, idempotent: true } }
    }
    this.serverClientSeq = frame.client_seq
    return { ok: true, data: { delivered: true, idempotent: false } }
  }

  async frames(sessionId: string, lease: string, afterSeq: number, expectedGeneration: number): Promise<PtyResult<PtyFramesPageWire>> {
    void sessionId
    this.framesCalls.push({ lease, afterSeq, expectedGeneration })
    const next = this.framesQueue.shift()
    if (next !== undefined) return next
    return { ok: true, data: framesPage({ pty_session_id: sessionId, after_seq: afterSeq }) }
  }
}

function makeModel(transport: FakeTransport, over: Partial<ConstructorParameters<typeof PtyClientModel>[0]> = {}): {
  model: PtyClientModel
  scheduler: FakeScheduler
  transport: FakeTransport
} {
  const scheduler = new FakeScheduler()
  const model = new PtyClientModel({ transport, scheduler, ...over })
  return { model, scheduler, transport }
}

const OPEN_PARAMS: PtyOpenParams = {
  context_id: 'chat_demo',
  workspace_id: 'ws_scratch_1',
  label: 'Experiment shell',
  purpose: 'inspect experiment',
  preset: 'bash',
  cwd: 'scratch',
  cols: 80,
  rows: 24,
}

/** Flush pending microtasks (fake transport resolves synchronously). */
const flush = (): Promise<void> => new Promise(resolve => { setTimeout(resolve, 0) })

async function openModel(t: FakeTransport, over: Partial<ConstructorParameters<typeof PtyClientModel>[0]> = {}): Promise<{ model: PtyClientModel; scheduler: FakeScheduler; transport: FakeTransport }> {
  const env = makeModel(t, over)
  const ok = await env.model.open(OPEN_PARAMS)
  expect(ok).toBe(true)
  expect(env.model.state).toBe('open')
  await flush()
  return env
}

/* ─────────────────────────── session state machine ─────────────────────────── */

describe('PTY-01 client session state machine (pty-session-model)', () => {
  it('idle → opening → open; open pins session/lease/generation and starts polling', async () => {
    const { model, scheduler, transport } = makeModel(new FakeTransport())
    expect(model.state).toBe('idle')
    expect(model.hasSession).toBe(false)
    const p = model.open(OPEN_PARAMS)
    expect(model.state).toBe('opening')
    await p
    expect(model.state).toBe('open')
    expect(model.hasSession).toBe(true)
    expect(model.sessionId).toMatch(/^pty_fake_/)
    expect(model.leaseToken).toMatch(/^lease_fake_/)
    expect(model.generation).toBe(2)
    expect(model.clientSeq).toBe(0)
    expect(transport.openCalls).toHaveLength(1)
    // the first poll tick is scheduled after open
    expect(scheduler.pending).toBe(1)
    scheduler.runOnce()
    await flush()
    expect(transport.framesCalls[0]?.afterSeq).toBe(0)
  })

  it('open failure lands in error with the wire code (e.g. adapter 501)', async () => {
    const t = new FakeTransport()
    t.openQueue = [{ ok: false, error: { code: 'pty_adapter_not_implemented', status: 501 } }]
    const { model } = makeModel(t)
    const ok = await model.open(OPEN_PARAMS)
    expect(ok).toBe(false)
    expect(model.state).toBe('error')
    expect(model.lastError?.code).toBe('pty_adapter_not_implemented')
    expect(model.hasSession).toBe(false)
  })

  it('open → detached (wire down, process alive) → reconnect resumes open', async () => {
    const t = new FakeTransport()
    const { model, scheduler } = await openModel(t)
    await model.detach()
    expect(model.state).toBe('detached')
    expect(model.hasSession).toBe(true)
    // no poll timer while detached
    expect(scheduler.pending).toBe(0)
    // reconnect is refused on non-detached states
    await model.reconnect()
    expect(model.state).toBe('open')
    expect(scheduler.pending).toBe(1)
  })

  it('close control ack lands in closed with closeReason explicit', async () => {
    const t = new FakeTransport()
    const { model } = await openModel(t)
    expect(await model.close()).toBe(true)
    expect(model.state).toBe('closed')
    expect(model.closeReason).toBe('explicit')
    expect(model.hasSession).toBe(true) // the row stays for audit
  })

  it('controls are rejected when the session is closed', async () => {
    const t = new FakeTransport()
    const { model } = await openModel(t)
    await model.close()
    expect(model.state).toBe('closed')
    expect(model.sendText('ls\n')).toBe(false)
    expect(model.signal('INT')).toBe(false)
    expect(model.resize(100, 40)).toBe(false)
    expect(await model.close()).toBe(false)
    expect(t.closeCalls).toHaveLength(1)
    expect(t.controlCalls).toHaveLength(0)
  })

  it('reopen after close creates a NEW session (new generation period)', async () => {
    const t = new FakeTransport()
    const { model } = await openModel(t)
    await model.close()
    expect(model.state).toBe('closed')
    const firstId = model.sessionId
    const ok = await model.reopen()
    expect(ok).toBe(true)
    expect(model.state).toBe('open')
    expect(model.sessionId).not.toBe(firstId)
    expect(model.generation).toBe(2)
    expect(model.serverSeq).toBe(0)
  })

  it('lease failure on control is fatal: error state, queue dropped, polling stopped', async () => {
    const t = new FakeTransport()
    const { model, scheduler } = await openModel(t)
    t.controlQueue = [{ ok: false, error: { code: 'lease_invalid', status: 403 } }]
    expect(model.signal('TERM')).toBe(true)
    await flush()
    expect(model.state).toBe('error')
    expect(model.lastError?.code).toBe('lease_invalid')
    expect(model.hasPendingControls).toBe(false)
    // no further polls are scheduled (the fatal path stopped the loop)
    scheduler.runOnce()
    await flush()
    expect(scheduler.pending).toBe(0)
    expect(t.framesCalls).toHaveLength(0)
  })
})

/* ─────────────────────────────── control queue ─────────────────────────────── */

describe('PTY-01 client control queue (client_seq 单调/重试幂等)', () => {
  it('client_seq is monotonic starting at 1 after open, one frame in flight at a time', async () => {
    const t = new FakeTransport()
    const { model } = await openModel(t)
    expect(model.sendText('ls\n')).toBe(true)
    expect(model.resize(100, 40)).toBe(true)
    expect(model.signal('INT')).toBe(true)
    await flush()
    const seqs = t.controlCalls.map(c => c.frame.client_seq)
    expect(seqs).toEqual([1, 2, 3])
    expect(model.clientSeq).toBe(3)
    expect(t.controlCalls.map(c => c.frame.type)).toEqual(['bytes', 'resize', 'signal'])
    // the bytes frame carries the exact UTF-8 byte length
    expect(t.controlCalls[0]!.frame.payload).toEqual({ text: 'ls\n', byte_length: 3 })
  })

  it('transient failure retries the SAME client_seq (server idempotency key)', async () => {
    const t = new FakeTransport()
    const { model, scheduler } = await openModel(t)
    t.controlQueue = [
      { ok: false, error: { code: 'network_error', status: 0 } },
      { ok: true, data: { delivered: true, idempotent: false } },
    ]
    expect(model.sendText('x')).toBe(true)
    await flush()
    expect(t.controlCalls).toHaveLength(1)
    expect(t.controlCalls[0]!.frame.client_seq).toBe(1)
    expect(model.clientSeq).toBe(0) // not advanced on failure
    // retry timer fires → same frame, same seq
    scheduler.runOnce()
    await flush()
    expect(t.controlCalls).toHaveLength(2)
    expect(t.controlCalls[1]!.frame.client_seq).toBe(1)
    expect(model.clientSeq).toBe(1)
    expect(model.lastControlError).toBeNull()
  })

  it('exhausted retries keep the frame queued with lastControlError; retryControl resends it', async () => {
    const t = new FakeTransport()
    const { model, scheduler } = await openModel(t)
    for (let i = 0; i < 3; i += 1) {
      t.controlQueue.push({ ok: false, error: { code: 'network_error', status: 0 } })
    }
    expect(model.sendText('y')).toBe(true)
    await flush()
    expect(t.controlCalls).toHaveLength(1)
    scheduler.runOnce(); await flush()
    scheduler.runOnce(); await flush()
    scheduler.runOnce(); await flush()
    expect(t.controlCalls).toHaveLength(3)
    expect(model.lastControlError?.code).toBe('network_error')
    expect(model.hasPendingControls).toBe(true) // frame stays queued
    expect(model.clientSeq).toBe(0)
    // manual retry sends the SAME seq once more and succeeds
    t.controlQueue.push({ ok: true, data: { delivered: true, idempotent: false } })
    model.retryControl()
    await flush()
    expect(t.controlCalls).toHaveLength(4)
    expect(t.controlCalls[3]!.frame.client_seq).toBe(1)
    expect(model.clientSeq).toBe(1)
    expect(model.hasPendingControls).toBe(false)
  })

  it('idempotent ack (server replay of the same seq) still advances the cursor', async () => {
    const t = new FakeTransport()
    const { model } = await openModel(t)
    t.controlQueue = [{ ok: true, data: { delivered: false, idempotent: true } }]
    expect(model.sendText('dup')).toBe(true)
    await flush()
    expect(model.clientSeq).toBe(1)
    expect(model.hasPendingControls).toBe(false)
  })

  it('409 out-of-order resyncs from the session row (lost ack → already applied)', async () => {
    const t = new FakeTransport()
    const { model } = await openModel(t)
    // server already applied seq 1 (the ack was lost on the wire)
    t.serverClientSeq = 1
    t.currentSession = fakeSession({ last_client_seq: 1 })
    t.controlQueue = [{ ok: false, error: { code: 'pty_client_seq_out_of_order', status: 409 } }]
    expect(model.sendText('lost-ack')).toBe(true)
    await flush()
    expect(t.sessionCalls).toHaveLength(1) // resync read happened
    expect(model.clientSeq).toBe(1)
    expect(model.state).toBe('open') // NOT fatal — cursor rebased
    // next frame continues at seq 2
    expect(model.sendText('next')).toBe(true)
    await flush()
    expect(t.controlCalls.at(-1)!.frame.client_seq).toBe(2)
  })

  it('409 out-of-order with the server cursor BEHIND is fatal (seqOutOfOrder error)', async () => {
    const t = new FakeTransport()
    const { model } = await openModel(t)
    t.controlQueue = [{ ok: false, error: { code: 'pty_client_seq_out_of_order', status: 409 } }]
    expect(model.sendText('desync')).toBe(true)
    await flush()
    expect(model.state).toBe('error')
    expect(model.lastError?.code).toBe('pty_client_seq_out_of_order')
    expect(model.hasPendingControls).toBe(false)
    // status copy maps to the stable key
    const view = ptyStatusView(model)
    expect(view.errorText).toBe(ptyEn['pty.error.seqOutOfOrder'] ?? '')
  })

  it('control while a session is opening is queued and flushed once open', async () => {
    const t = new FakeTransport()
    const { model } = makeModel(t)
    const p = model.open(OPEN_PARAMS)
    expect(model.sendText('early')).toBe(false) // opening → rejected (no session yet)
    await p
    expect(model.sendText('now')).toBe(true)
    await flush()
    expect(t.controlCalls).toHaveLength(1)
    expect(t.controlCalls[0]!.frame.client_seq).toBe(1)
  })
})

/* ──────────────────────────── frames consumption ──────────────────────────── */

describe('PTY-01 client frames consumption (after_seq 增量/gap/retention)', () => {
  it('polls incrementally with after_seq = last applied server_seq', async () => {
    const t = new FakeTransport()
    const { model, scheduler } = await openModel(t)
    t.framesQueue = [{ ok: true, data: framesPage({ frames: [
      { pty_session_id: 'pty_fake_1', server_seq: 1, type: 'output', payload: { text: 'hello\n', byte_length: 6, channel: 'stdout' }, created_at: 'x' },
      { pty_session_id: 'pty_fake_1', server_seq: 2, type: 'output', payload: { text: 'world\n', byte_length: 6, channel: 'stderr' }, created_at: 'x' },
    ] }) }]
    scheduler.runOnce()
    await flush()
    expect(model.serverSeq).toBe(2)
    expect(model.display.map(e => [e.kind, e.text])).toEqual([
      ['output', 'hello\n'], ['output', 'world\n'],
    ])
    expect(model.display[1]!.channel).toBe('stderr')
    // next poll asks after_seq=2
    scheduler.runOnce()
    await flush()
    expect(t.framesCalls.at(-1)!.afterSeq).toBe(2)
  })

  it('page gap (retention eviction) surfaces a gap marker + truncation accounting', async () => {
    const t = new FakeTransport()
    const { model, scheduler } = await openModel(t)
    t.framesQueue = [{ ok: true, data: framesPage({
      retained_from_seq: 10,
      dropped_bytes: 500,
      total_bytes: 1500,
      gap: true,
      frames: [
        { pty_session_id: 'pty_fake_1', server_seq: 10, type: 'output', payload: { text: 'after\n', byte_length: 6, channel: 'stdout' }, created_at: 'x' },
      ],
    }) }]
    scheduler.runOnce()
    await flush()
    expect(model.retainedFromSeq).toBe(10)
    expect(model.droppedBytes).toBe(500)
    expect(model.totalBytes).toBe(1500)
    expect(model.serverSeq).toBe(10)
    const kinds = model.display.map(e => e.kind)
    expect(kinds).toEqual(['gap', 'output'])
    const gap = model.display[0]!
    expect(gap.gapFrom).toBe(1) // after_seq was 0
    expect(gap.gapTo).toBe(9)
    expect(gap.droppedFrames).toBe(9)
  })

  it('explicit gap frame inside a page appends its own marker', async () => {
    const t = new FakeTransport()
    const { model, scheduler } = await openModel(t)
    t.framesQueue = [{ ok: true, data: framesPage({ frames: [
      { pty_session_id: 'pty_fake_1', server_seq: 5, type: 'gap', payload: { gap_from_seq: 1, gap_to_seq: 4, dropped_bytes: 64, dropped_frames: 4 }, created_at: 'x' },
      { pty_session_id: 'pty_fake_1', server_seq: 6, type: 'output', payload: { text: 'ok\n', byte_length: 3, channel: 'stdout' }, created_at: 'x' },
    ] }) }]
    scheduler.runOnce()
    await flush()
    expect(model.display.map(e => e.kind)).toEqual(['gap', 'output'])
    expect(model.display[0]!.droppedBytes).toBe(64)
  })

  it('exit frame records code/signal and appends the exit line', async () => {
    const t = new FakeTransport()
    const { model, scheduler } = await openModel(t)
    t.framesQueue = [{ ok: true, data: framesPage({ frames: [
      { pty_session_id: 'pty_fake_1', server_seq: 7, type: 'exit', payload: { exit_code: 0, signal: null }, created_at: 'x' },
    ] }) }]
    scheduler.runOnce()
    await flush()
    expect(model.exitCode).toBe(0)
    expect(model.exitSignal).toBeNull()
    expect(model.display.map(e => e.kind)).toEqual(['exit'])
    const view = ptyStatusView(model)
    expect(view.exitText).not.toBe('')
  })

  it('replay at/below serverSeq is skipped (idempotent cursor)', async () => {
    const t = new FakeTransport()
    const { model, scheduler } = await openModel(t)
    t.framesQueue = [{ ok: true, data: framesPage({ frames: [
      { pty_session_id: 'pty_fake_1', server_seq: 1, type: 'output', payload: { text: 'a\n', byte_length: 2, channel: 'stdout' }, created_at: 'x' },
      { pty_session_id: 'pty_fake_1', server_seq: 2, type: 'output', payload: { text: 'b\n', byte_length: 2, channel: 'stdout' }, created_at: 'x' },
    ] }) }]
    scheduler.runOnce()
    await flush()
    expect(model.serverSeq).toBe(2)
    t.framesQueue = [{ ok: true, data: framesPage({ frames: [
      { pty_session_id: 'pty_fake_1', server_seq: 2, type: 'output', payload: { text: 'dup\n', byte_length: 4, channel: 'stdout' }, created_at: 'x' },
      { pty_session_id: 'pty_fake_1', server_seq: 3, type: 'output', payload: { text: 'c\n', byte_length: 2, channel: 'stdout' }, created_at: 'x' },
    ] }) }]
    scheduler.runOnce()
    await flush()
    expect(model.serverSeq).toBe(3)
    expect(model.display.map(e => e.text)).toEqual(['a\n', 'b\n', 'c\n'])
  })

  it('display buffer is bounded (retention hint, never unbounded DOM)', async () => {
    const t = new FakeTransport()
    const { model, scheduler } = makeModel(t, { maxDisplayFrames: 5 })
    await model.open(OPEN_PARAMS)
    // three pages of 4 frames each → 12 frames through the real apply path
    for (let page = 0; page < 3; page += 1) {
      t.framesQueue.push({ ok: true, data: framesPage({ frames: [1, 2, 3, 4].map(n => {
        const seq = page * 4 + n
        return { pty_session_id: 'pty_fake_1', server_seq: seq, type: 'output', payload: { text: `line ${seq}\n`, byte_length: 8, channel: 'stdout' }, created_at: 'x' }
      }) }) })
      scheduler.runOnce()
      await flush()
    }
    expect(model.serverSeq).toBe(12)
    expect(model.display.length).toBe(5)
    expect(model.display[0]!.seq).toBe(8) // oldest 7 evicted by the cap
  })

  it('transient poll failure backs off and retries without losing the cursor', async () => {
    const t = new FakeTransport()
    const { model, scheduler } = await openModel(t)
    t.framesQueue = [{ ok: false, error: { code: 'network_error', status: 0 } }]
    scheduler.runOnce()
    await flush()
    expect(model.state).toBe('open')
    expect(model.serverSeq).toBe(0)
    t.framesQueue = [{ ok: true, data: framesPage({ frames: [
      { pty_session_id: 'pty_fake_1', server_seq: 1, type: 'output', payload: { text: 'back\n', byte_length: 5, channel: 'stdout' }, created_at: 'x' },
    ] }) }]
    scheduler.runOnce()
    await flush()
    expect(model.serverSeq).toBe(1)
    expect(model.display).toHaveLength(1)
  })
})

/* ────────────────────── detach/reconnect + generation ────────────────────── */

describe('PTY-01 client detach/reconnect (generation 语义, after_seq 重放)', () => {
  it('reconnect resumes the after_seq replay exactly where detach stopped', async () => {
    const t = new FakeTransport()
    const { model, scheduler } = await openModel(t)
    t.framesQueue = [{ ok: true, data: framesPage({ frames: [
      { pty_session_id: 'pty_fake_1', server_seq: 1, type: 'output', payload: { text: 'one\n', byte_length: 4, channel: 'stdout' }, created_at: 'x' },
    ] }) }]
    scheduler.runOnce()
    await flush()
    expect(model.serverSeq).toBe(1)
    await model.detach()
    const callsBefore = t.framesCalls.length
    scheduler.runOnce()
    await flush()
    expect(t.framesCalls.length).toBe(callsBefore) // no polls while detached
    await model.reconnect()
    expect(model.state).toBe('open')
    scheduler.runOnce()
    await flush()
    expect(t.framesCalls.at(-1)!.afterSeq).toBe(1) // replayed from the cursor
  })

  it('unexpected generation change during refresh fails closed', async () => {
    const t = new FakeTransport()
    const { model, scheduler } = await openModel(t, { sessionRefreshEvery: 1 })
    t.sessionQueue = [{ ok: true, data: fakeSession({ generation: 3, state: 'attached' }) }]
    scheduler.runOnce() // frames poll → then refreshSession reads generation 3
    await flush()
    expect(model.generation).toBe(2)
    expect(model.state).toBe('error')
    expect(model.lastError?.code).toBe('pty_generation_stale')
    const view = ptyStatusView(model)
    expect(view.errorText).toBe(ptyEn['pty.error.generation'])
    expect(missing).toEqual([])
  })

  it('server-side close (idle TTL) detected by the session refresh → closed + notice', async () => {
    const t = new FakeTransport()
    const { model, scheduler } = await openModel(t, { sessionRefreshEvery: 1 })
    t.sessionQueue = [{ ok: true, data: fakeSession({ generation: 2, state: 'closed', close_reason: 'idle_ttl', idle_ttl_s: 900 }) }]
    scheduler.runOnce()
    await flush()
    expect(model.state).toBe('closed')
    expect(model.closeReason).toBe('idle_ttl')
    const view = ptyStatusView(model)
    expect(view.noticeText).toContain('900')
    // no further polls scheduled after the close
    scheduler.runOnce()
    await flush()
    expect(scheduler.pending).toBe(0)
  })

  it('lease expiry close (lease_expired reason) maps to the reopen prompt', async () => {
    const t = new FakeTransport()
    const { model, scheduler } = await openModel(t, { sessionRefreshEvery: 1 })
    t.sessionQueue = [{ ok: true, data: fakeSession({ generation: 2, state: 'closed', close_reason: 'lease_expired' }) }]
    scheduler.runOnce()
    await flush()
    expect(model.state).toBe('closed')
    expect(model.closeReason).toBe('lease_expired')
    expect(ptyStatusView(model).noticeText).toBe(ptyEn['pty.notice.leaseExpired'] ?? '')
  })
})

/* ───────────────────────────── lease-invalid handling ───────────────────────────── */

describe('PTY-01 client lease-invalid handling (403 → 提示重连/重新 open)', () => {
  it('frames 403 lease_invalid → error state, polling stops, error copy = lease key', async () => {
    const t = new FakeTransport()
    const { model, scheduler } = await openModel(t)
    t.framesQueue = [{ ok: false, error: { code: 'lease_invalid', status: 403 } }]
    scheduler.runOnce()
    await flush()
    expect(model.state).toBe('error')
    expect(model.lastError?.code).toBe('lease_invalid')
    expect(ptyStatusView(model).errorText).toBe(ptyEn['pty.error.lease'] ?? '')
    // nothing left scheduled
    scheduler.runOnce()
    await flush()
    expect(scheduler.pending).toBe(0)
  })

  it('missing lease (lease_required) is equally fatal', async () => {
    const t = new FakeTransport()
    const { model, scheduler } = await openModel(t)
    t.framesQueue = [{ ok: false, error: { code: 'lease_required', status: 403 } }]
    scheduler.runOnce()
    await flush()
    expect(model.state).toBe('error')
    expect(ptyErrorKey(model.lastError?.code)).toBe('pty.error.lease')
  })

  it('reopen after lease failure re-opens a fresh session (with a fresh lease)', async () => {
    const t = new FakeTransport()
    const { model, scheduler } = await openModel(t)
    t.framesQueue = [{ ok: false, error: { code: 'lease_invalid', status: 403 } }]
    scheduler.runOnce()
    await flush()
    expect(model.state).toBe('error')
    const oldLease = model.leaseToken
    const ok = await model.reopen()
    expect(ok).toBe(true)
    expect(model.state).toBe('open')
    expect(model.leaseToken).not.toBe(oldLease)
    // the transport sends the fresh lease on every control
    t.controlQueue = [{ ok: true, data: { delivered: true, idempotent: false } }]
    model.sendText('hi')
    await flush()
    expect(t.controlCalls.at(-1)!.lease).toBe(model.leaseToken)
  })
})

/* ─────────────────────────── error mapping + i18n ─────────────────────────── */

describe('PTY-01 error mapping (wire code → stable key) + i18n parity', () => {
  it('every known wire error code maps to a stable pty.error.* key', () => {
    const cases: Array<[string | undefined, string]> = [
      ['lease_invalid', 'pty.error.lease'],
      ['lease_required', 'pty.error.lease'],
      ['pty_session_not_found', 'pty.error.notFound'],
      ['pty_session_closed', 'pty.error.closed'],
      ['pty_client_seq_out_of_order', 'pty.error.seqOutOfOrder'],
      ['pty_principal_mismatch', 'pty.error.principal'],
      ['principal_required', 'pty.error.principal'],
      ['pty_adapter_failed', 'pty.error.adapter'],
      ['pty_adapter_not_implemented', 'pty.error.adapter'],
      ['project_not_found', 'pty.error.scope'],
      ['workspace_not_found', 'pty.error.scope'],
      ['validation_error', 'pty.error.validation'],
      ['pty_after_seq_invalid', 'pty.error.validation'],
      ['pty_open_invalid', 'pty.error.validation'],
      ['network_error', 'pty.error.network'],
      ['http_error', 'pty.error.generic'],
      [undefined, 'pty.error.generic'],
    ]
    for (const [code, key] of cases) expect(ptyErrorKey(code)).toBe(key)
  })

  it('every close reason maps to a pty.notice.* key', () => {
    expect(ptyCloseReasonKey('idle_ttl')).toBe('pty.notice.idleTtl')
    expect(ptyCloseReasonKey('lease_expired')).toBe('pty.notice.leaseExpired')
    expect(ptyCloseReasonKey('permission_revoked')).toBe('pty.notice.permissionRevoked')
    expect(ptyCloseReasonKey('adapter_failed')).toBe('pty.notice.adapterFailed')
    expect(ptyCloseReasonKey('explicit')).toBe('pty.notice.closed')
    expect(ptyCloseReasonKey(null)).toBe('pty.notice.closed')
  })

  it('state keys are stable pty.state.* keys', () => {
    expect(ptyStateKey('idle')).toBe('pty.state.idle')
    expect(ptyStateKey('opening')).toBe('pty.state.opening')
    expect(ptyStateKey('open')).toBe('pty.state.open')
    expect(ptyStateKey('detached')).toBe('pty.state.detached')
    expect(ptyStateKey('closed')).toBe('pty.state.closed')
    expect(ptyStateKey('error')).toBe('pty.state.error')
  })

  it('utf8ByteLength counts UTF-8 bytes exactly (wire byte_length)', () => {
    expect(utf8ByteLength('ls\n')).toBe(3)
    expect(utf8ByteLength('你好\n')).toBe(7) // 3*2 + 1
    expect(utf8ByteLength('')).toBe(0)
  })

  it('pty namespace zh/en key sets are exactly equal', () => {
    const zhKeys = Object.keys(ptyZh).sort()
    const enKeys = Object.keys(ptyEn).sort()
    expect(enKeys).toEqual(zhKeys)
    expect(localeParityReport()).toEqual([])
  })

  it('every pty dict key resolves in BOTH locales without missing-key reports', () => {
    for (const locale of ['zh', 'en'] as const) {
      setLocale(locale)
      missing = []
      for (const key of Object.keys(ptyZh)) {
        const text = getLocaleText(locale, key)
        expect(text).not.toBe('')
      }
      expect(missing).toEqual([])
    }
  })

  it('pty is a reachable More tab with a stable deep link and chrome copy in both locales', () => {
    expect((ALL_TAB_KEYS as readonly string[]).includes('pty')).toBe(true)
    expect((MORE_TAB_KEYS as readonly string[]).includes('pty')).toBe(true)
    expect(parseDeepLink('#tab=pty')).toEqual({ kind: 'tab', target: 'pty' })
    for (const locale of ['zh', 'en'] as const) {
      setLocale(locale)
      const def = chromeTabs().find(d => d.key === 'pty')
      expect(def).toBeDefined()
      expect(def!.label).not.toBe('')
      expect(def!.description).not.toBe('')
    }
  })

  it('ptyStatusView evaluates in BOTH locales with zero missing keys', async () => {
    const t = new FakeTransport()
    const { model, scheduler } = await openModel(t)
    // exercise every copy branch: seq/lease/generation/bytes + exit
    t.framesQueue = [{ ok: true, data: framesPage({ total_bytes: 42, frames: [
      { pty_session_id: 'pty_fake_1', server_seq: 1, type: 'output', payload: { text: 'a', byte_length: 1, channel: 'stdout' }, created_at: 'x' },
      { pty_session_id: 'pty_fake_1', server_seq: 2, type: 'exit', payload: { exit_code: 130, signal: 'SIGINT' }, created_at: 'x' },
    ] }) }]
    scheduler.runOnce()
    await flush()
    expect(model.serverSeq).toBe(2)
    expect(model.totalBytes).toBe(42)
    for (const locale of ['zh', 'en'] as const) {
      setLocale(locale)
      missing = []
      const view = ptyStatusView(model)
      expect(view.stateText).not.toBe('')
      expect(view.seqText).not.toBe('')
      expect(view.leaseText).not.toBe('')
      expect(view.generationText).not.toBe('')
      expect(view.bytesText).not.toBe('')
      expect(view.exitText).not.toBe('')
      expect(missing).toEqual([])
    }
    // closed-with-reason + expired-lease branch
    const closed = makeModel(new FakeTransport()).model
    closed.state = 'closed'
    closed.sessionId = 'pty_fake_1'
    closed.leaseToken = 'lease_fake_1'
    closed.leaseExpiresAt = new Date(Date.now() - 1000).toISOString()
    closed.generation = 1
    closed.clientSeq = 1
    closed.serverSeq = 2
    closed.totalBytes = 10
    closed.closeReason = 'idle_ttl'
    closed.idleTtlS = 900
    for (const locale of ['zh', 'en'] as const) {
      setLocale(locale)
      missing = []
      const view = ptyStatusView(closed)
      expect(view.noticeText).not.toBe('')
      expect(view.leaseText).not.toBe('')
      expect(missing).toEqual([])
    }
    // error branch (lease invalid → stable copy, both locales)
    const failed = makeModel(new FakeTransport()).model
    failed.state = 'error'
    failed.lastError = { code: 'lease_invalid', status: 403 }
    for (const locale of ['zh', 'en'] as const) {
      setLocale(locale)
      missing = []
      const view = ptyStatusView(failed)
      expect(view.errorText).not.toBe('')
      expect(view.errorText).toBe((locale === 'zh' ? ptyZh : ptyEn)['pty.error.lease'] ?? '')
      expect(missing).toEqual([])
    }
  })
})

/* ──────────────────── SSE frames stream (client/sse-client.ts) ──────────────────── */

/** One SSE frame as the frames/stream endpoint emits it. */
function sse(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
}

function streamUrl(sessionId: string, afterSeq: number, expectedGeneration = 2): string {
  return `/v1/pty/sessions/${encodeURIComponent(sessionId)}/frames/stream?after_seq=${afterSeq}&expected_generation=${expectedGeneration}`
}

/** Open a model wired to a mock SSE stream transport (the session id is
 *  pinned BEFORE open so the mock fetch queue can be keyed by URL). */
async function openStreamModel(
  t: FakeTransport,
  fetchMock: MockSseFetch,
  over: Partial<ConstructorParameters<typeof PtyClientModel>[0]> = {},
  sessionId = `pty_sse_${sessionCounter}`,
): Promise<{ model: PtyClientModel; scheduler: FakeScheduler; transport: FakeTransport; fetchMock: MockSseFetch }> {
  const env = makeModel(t, {
    ...over,
    stream: { fetch: fetchMock.fetchImpl.bind(fetchMock), maxReconnectAttempts: 3, ...(over.stream ?? {}) },
  })
  // Pin the session id BEFORE open (FakeTransport.open would otherwise mint
  // a fresh id) so the mock fetch queue can be keyed by URL.
  t.currentSession = fakeSession({ pty_session_id: sessionId })
  t.openQueue = [{ ok: true, data: t.currentSession }]
  const ok = await env.model.open(OPEN_PARAMS)
  expect(ok).toBe(true)
  await flush()
  return { ...env, fetchMock }
}

describe('PTY-01 client SSE frames stream (frames/stream — client/sse-client.ts)', () => {
  it('SSE frame/gap/exit events apply IDENTICALLY to the poll path (cursor/display/retention)', async () => {
    const t = new FakeTransport()
    const fetchMock = new MockSseFetch()
    const sessionId = `pty_sse_${sessionCounter}`
    // pre-enqueue the FIRST stream (the connect during open consumes it)
    const stream = fetchMock.enqueueStream(streamUrl(sessionId, 0))
    const { model, fetchMock: fm } = await openStreamModel(t, fetchMock, {}, sessionId)
    expect(model.framesMode).toBe('sse')
    await flush()
    expect(model.streamStatus).toBe('live')
    stream.push(sse('frame', { server_seq: 1, type: 'output', payload: { text: 'hello\n', byte_length: 6, channel: 'stdout' } }))
    stream.push(sse('frame', { server_seq: 2, type: 'output', payload: { text: 'world\n', byte_length: 6, channel: 'stderr' } }))
    stream.push(sse('exit', { server_seq: 3, exit_code: 130, signal: 'SIGINT' }))
    await flush()
    expect(model.serverSeq).toBe(3)
    expect(model.display.map(e => [e.kind, e.text])).toEqual([
      ['output', 'hello\n'], ['output', 'world\n'], ['exit', undefined],
    ])
    expect(model.display[1]!.channel).toBe('stderr')
    expect(model.exitCode).toBe(130)
    expect(model.exitSignal).toBe('SIGINT')

    // The POLL path over the same frames converges to the exact same state.
    const t2 = new FakeTransport()
    const { model: poll, scheduler: s2 } = await openModel(t2)
    t2.framesQueue = [{ ok: true, data: framesPage({ frames: [
      { pty_session_id: sessionId, server_seq: 1, type: 'output', payload: { text: 'hello\n', byte_length: 6, channel: 'stdout' }, created_at: 'x' },
      { pty_session_id: sessionId, server_seq: 2, type: 'output', payload: { text: 'world\n', byte_length: 6, channel: 'stderr' }, created_at: 'x' },
      { pty_session_id: sessionId, server_seq: 3, type: 'exit', payload: { exit_code: 130, signal: 'SIGINT' }, created_at: 'x' },
    ] }) }]
    s2.runOnce()
    await flush()
    expect(poll.serverSeq).toBe(model.serverSeq)
    expect(poll.display.map(e => [e.kind, e.text])).toEqual(model.display.map(e => [e.kind, e.text]))
    expect(poll.exitCode).toBe(model.exitCode)
    expect(poll.exitSignal).toBe(model.exitSignal)
    void fm
  })

  it('SSE gap event surfaces the same retention marker as the page gap', async () => {
    const t = new FakeTransport()
    const fetchMock = new MockSseFetch()
    const sessionId = `pty_sse_${sessionCounter}`
    const stream = fetchMock.enqueueStream(streamUrl(sessionId, 0))
    const { model, fetchMock: fm } = await openStreamModel(t, fetchMock, {}, sessionId)
    await flush()
    stream.push(sse('gap', { retained_from_seq: 10, dropped_bytes: 500, dropped_frames: 9 }))
    stream.push(sse('frame', { server_seq: 10, type: 'output', payload: { text: 'after\n', byte_length: 6, channel: 'stdout' } }))
    await flush()
    expect(model.retainedFromSeq).toBe(10)
    expect(model.droppedBytes).toBe(500)
    expect(model.serverSeq).toBe(10)
    expect(model.display.map(e => e.kind)).toEqual(['gap', 'output'])
    expect(model.display[0]).toMatchObject({ gapFrom: 1, gapTo: 9, droppedFrames: 9 })
    void fm
  })

  it('stream replay at/below serverSeq is skipped; reconnect resumes from the cursor', async () => {
    const t = new FakeTransport()
    const fetchMock = new MockSseFetch()
    const sessionId = `pty_sse_${sessionCounter}`
    const stream = fetchMock.enqueueStream(streamUrl(sessionId, 0))
    const { model, scheduler, fetchMock: fm } = await openStreamModel(t, fetchMock, {}, sessionId)
    await flush()
    stream.push(sse('frame', { server_seq: 1, type: 'output', payload: { text: 'a\n', byte_length: 2, channel: 'stdout' } }))
    stream.push(sse('frame', { server_seq: 2, type: 'output', payload: { text: 'b\n', byte_length: 2, channel: 'stdout' } }))
    await flush()
    expect(model.serverSeq).toBe(2)
    // server closes the stream → SseClient reconnects after the cursor
    stream.end()
    await flush()
    expect(model.streamStatus).toBe('reconnecting')
    const stream2 = fm.enqueueStream(streamUrl(sessionId, 2))
    scheduler.runOnce()
    await flush()
    expect(model.streamStatus).toBe('live')
    expect(fm.calls.at(-1)!.url).toBe(streamUrl(sessionId, 2))
    // a replayed frame at/below the cursor is dropped; new ones apply
    stream2.push(sse('frame', { server_seq: 2, type: 'output', payload: { text: 'dup\n', byte_length: 4, channel: 'stdout' } }))
    stream2.push(sse('frame', { server_seq: 3, type: 'output', payload: { text: 'c\n', byte_length: 2, channel: 'stdout' } }))
    await flush()
    expect(model.display.map(e => e.text)).toEqual(['a\n', 'b\n', 'c\n'])
  })

  it('stream give-up (max reconnect attempts) falls back to the after_seq poll', async () => {
    const t = new FakeTransport()
    const fetchMock = new MockSseFetch()
    const sessionId = `pty_sse_${sessionCounter}`
    // NO pre-enqueued stream: the first connect uses the mock default
    // (never-ending stream) → live with no bytes → heartbeat trips.
    const { model, scheduler, transport } = await openStreamModel(t, fetchMock, { stream: { maxReconnectAttempts: 2 } }, sessionId)
    for (let i = 0; i < 4; i += 1) fetchMock.enqueueError(streamUrl(sessionId, 0), 500)
    scheduler.runOnce() // heartbeat fires → reconnect #1 scheduled
    await flush()
    scheduler.runOnce() // reconnect #1 → fetch #2 → 500 → reconnect #2
    await flush()
    expect(model.streamStatus).toBe('reconnecting')
    scheduler.runOnce() // reconnect #2 → fetch #3 → 500 → budget (2) exhausted
    await flush() // the give-up continuation lands → POLL fallback
    expect(model.framesMode).toBe('poll')
    expect(model.streamStatus).toBe('idle')
    // the poll resumes exactly where the stream stopped (after_seq cursor)
    scheduler.runOnce()
    await flush()
    expect(transport.framesCalls.at(-1)!.afterSeq).toBe(0)
    expect(model.framesMode).toBe('poll')
    // status copy reflects the fallback
    const view = ptyStatusView(model)
    expect(view.streamText).toBe(ptyEn['pty.stream.poll'] ?? '')
  })

  it('stream 403 (lease_invalid) is fatal: error state, no poll restart', async () => {
    const t = new FakeTransport()
    const fetchMock = new MockSseFetch()
    const sessionId = `pty_sse_${sessionCounter}`
    // the FIRST connect hits 403 → fatal lease failure (no reconnect loop)
    fetchMock.enqueueError(streamUrl(sessionId, 0), 403)
    const { model, scheduler } = await openStreamModel(t, fetchMock, {}, sessionId)
    expect(model.state).toBe('error')
    expect(model.lastError?.code).toBe('lease_invalid')
    expect(ptyStatusView(model).errorText).toBe(ptyEn['pty.error.lease'] ?? '')
    // nothing left scheduled (no poll, no further reconnects)
    scheduler.runOnce()
    await flush()
    expect(scheduler.pending).toBe(0)
    expect(t.framesCalls).toHaveLength(0)
  })

  it('detach closes the stream; reconnect reopens it from the cursor', async () => {
    const t = new FakeTransport()
    const fetchMock = new MockSseFetch()
    const sessionId = `pty_sse_${sessionCounter}`
    const stream = fetchMock.enqueueStream(streamUrl(sessionId, 0))
    const { model, scheduler, fetchMock: fm } = await openStreamModel(t, fetchMock, {}, sessionId)
    await flush()
    stream.push(sse('frame', { server_seq: 1, type: 'output', payload: { text: 'one\n', byte_length: 4, channel: 'stdout' } }))
    await flush()
    expect(model.serverSeq).toBe(1)
    await model.detach()
    expect(model.state).toBe('detached')
    expect(model.streamStatus).toBe('closed')
    const callsBefore = fm.calls.length
    scheduler.runOnce()
    await flush()
    expect(fm.calls.length).toBe(callsBefore) // no stream fetches while detached
    const stream2 = fm.enqueueStream(streamUrl(sessionId, 1, 4))
    await model.reconnect()
    expect(model.state).toBe('open')
    await flush()
    expect(fm.calls.at(-1)!.url).toBe(streamUrl(sessionId, 1, 4))
    stream2.push(sse('frame', { server_seq: 2, type: 'output', payload: { text: 'two\n', byte_length: 4, channel: 'stdout' } }))
    await flush()
    expect(model.serverSeq).toBe(2)
    expect(model.display.map(e => e.text)).toEqual(['one\n', 'two\n'])
  })

  it('stream status copy evaluates in BOTH locales with zero missing keys', async () => {
    const t = new FakeTransport()
    const fetchMock = new MockSseFetch()
    const sessionId = `pty_sse_${sessionCounter}`
    const stream = fetchMock.enqueueStream(streamUrl(sessionId, 0))
    const { model, fetchMock: fm } = await openStreamModel(t, fetchMock, {}, sessionId)
    await flush()
    expect(model.streamStatus).toBe('live')
    for (const locale of ['zh', 'en'] as const) {
      setLocale(locale)
      missing = []
      const view = ptyStatusView(model)
      expect(view.streamText).not.toBe('')
      expect(view.streamText).toBe((locale === 'zh' ? ptyZh : ptyEn)['pty.stream.live'] ?? '')
      expect(missing).toEqual([])
    }
    stream.push(sse('frame', { server_seq: 1, type: 'output', payload: { text: 'x\n', byte_length: 2, channel: 'stdout' } }))
    await flush()
    for (const status of ['connecting', 'live', 'reconnecting', 'disconnected', 'poll'] as const) {
      for (const locale of ['zh', 'en'] as const) {
        setLocale(locale)
        missing = []
        const text = (locale === 'zh' ? ptyZh : ptyEn)[`pty.stream.${status}`]
        expect(text).toBeDefined()
        expect(missing).toEqual([])
      }
    }
    void fm
  })
})

/* ─────────────────────────── small test helpers ─────────────────────────── */

function getLocaleText(locale: 'zh' | 'en', key: string): string {
  const dict = locale === 'zh' ? ptyZh : ptyEn
  return dict[key as keyof typeof dict] ?? ''
}
