/** PTY-01 context-bound interface tests. */
import { describe, expect, it } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  PTY_DEFAULT_IDLE_TTL_S, PTY_DEFAULT_LEASE_TTL_S, PTY_DEFAULT_RETENTION_BYTES,
  PtyControlFrame, PtyControlRequest, PtyFramesPage, PtyOpenRequest, PtyOutputFrame, PtySession,
} from '../../packages/research-schemas/src/pty'
import { ResearchKernel } from '../../packages/research-kernel/src/kernel'
import type { PtyResolvedContext } from '../../packages/research-kernel/src/pty-context'
import { NullPtyAdapter, type PtyAdapter, type PtySpawnPlan } from '../../packages/research-kernel/src/pty-session'

function makeBrief() {
  return {
    problem: 'p', scope: 's', questions: [], primary_metrics: ['m'], resources: '', risks: [],
    target_outputs: ['paper'], target_venue: null, baseline_repo: null, domain: 'ml',
  }
}

class RecordingAdapter implements PtyAdapter {
  readonly id = 'local-pty'
  spawned: PtySpawnPlan[] = []
  deliveries: string[] = []
  spawnResult: { ok: true } | { ok: false; error: string } = { ok: true }
  spawn(plan: PtySpawnPlan) { this.spawned.push(plan); return this.spawnResult }
  write(_id: string, bytes: string): void { this.deliveries.push(`write:${bytes}`) }
  resize(_id: string, cols: number, rows: number): void { this.deliveries.push(`resize:${cols}x${rows}`) }
  signal(_id: string, signal: 'INT' | 'TERM' | 'KILL'): void { this.deliveries.push(`signal:${signal}`) }
  kill(_id: string): void { this.deliveries.push('kill') }
}

interface Fixture {
  kernel: ResearchKernel
  adapter: RecordingAdapter
  projectId: string
  workspaceId: string
  context: PtyResolvedContext
}

function fixture(adapter = new RecordingAdapter()): Fixture {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-pty-test-'))
  const kernel = new ResearchKernel({
    dbPath: join(dir, 'kernel.db'), casRoot: join(dir, 'cas'),
    requireSignedManifest: false, ptySweepIntervalMs: 0,
  })
  kernel.setPtyAdapter(adapter)
  const project = kernel.createProject({
    name: 'p', workspace: '/w', creator_principal_id: 'pi', creator_tenant_id: 'tenant',
    execution: {
      runner_profile_id: 'profile_isolated_subprocess_v1', runner_target_id: 'target_local_process_v1',
      network_policy: 'none', artifact_store: 'local-cas', fixture_id: null,
    },
    brief: makeBrief(),
  })
  const workspace = kernel.workspaceEnsure(project.project_id, 'scratch', 'scratch')
  const projected = kernel.ptyContexts(project.project_id, 'pi').find(item => item.context_kind === 'research')!
  return {
    kernel, adapter, projectId: project.project_id, workspaceId: workspace.workspace_id,
    context: kernel.ptyResolveContext(projected.context_id, 'pi'),
  }
}

function openRequest(contextId: string, workspaceId: string, overrides: Record<string, unknown> = {}) {
  return PtyOpenRequest.parse({
    context_id: contextId, workspace_id: workspaceId, label: 'research shell',
    purpose: 'inspect the active experiment', preset: 'bash', cwd: '.', cols: 100, rows: 32,
    ...overrides,
  })
}

function control(generation: number, seq: number, overrides: Record<string, unknown> = {}) {
  return PtyControlRequest.parse({
    expected_generation: generation, client_seq: seq, type: 'bytes',
    payload: { text: 'ls\n', byte_length: 3 }, ...overrides,
  })
}

describe('pty session (PTY-01 context-bound interface)', () => {
  it('pins authoritative fields from the resolved context and round-trips the schema', () => {
    const f = fixture()
    try {
      const session = f.kernel.ptyOpen(openRequest(f.context.context_id, f.workspaceId), { context: f.context })
      expect(session).toMatchObject({
        state: 'open', generation: 1, principal_id: 'pi', tenant_id: 'tenant',
        project_id: f.projectId, workspace_id: f.workspaceId,
        context_kind: 'research', context_id: f.context.context_id, parent_session_id: null,
        label: 'research shell', profile: 'profile_isolated_subprocess_v1',
        target: 'target_local_process_v1', preset: 'bash', cwd: '.', adapter_id: 'local-pty',
      })
      expect(session.config_hash).toMatch(/^(sha256:)?[0-9a-f]{64}$/)
      expect(session.lease_token).toMatch(/^lease_/)
      expect(PtySession.parse(f.kernel.ptyGet(session.pty_session_id, f.context, session.generation)))
        .toMatchObject({ pty_session_id: session.pty_session_id })
      expect(f.adapter.spawned).toHaveLength(1)
    } finally { f.kernel.close() }
  })

  it('hot-applies runtime PTY policy only to sessions opened after the write', () => {
    const f = fixture()
    try {
      const before = f.kernel.ptyOpen(openRequest(f.context.context_id, f.workspaceId, { label: 'before policy' }), { context: f.context })
      expect(before).toMatchObject({
        idle_ttl_s: PTY_DEFAULT_IDLE_TTL_S,
        retention_bytes: PTY_DEFAULT_RETENTION_BYTES,
      })
      expect((Date.parse(before.lease_expires_at!) - Date.parse(before.open_at)) / 1000)
        .toBeCloseTo(PTY_DEFAULT_LEASE_TTL_S, 0)

      const receipt = f.kernel.writeSettingsTransaction({ operations: [{
        kind: 'config', scope: 'runtime', scope_id: 'kernel', expected_revision: 0,
        changes: {
          'kernel.pty_idle_ttl_s': 45,
          'kernel.pty_retention_bytes': 8192,
          'kernel.pty_lease_ttl_s': 120,
        },
      }] }, 'pi')
      expect(receipt.config?.verdict).toEqual({
        hot_applied_keys: [
          'kernel.pty_idle_ttl_s',
          'kernel.pty_lease_ttl_s',
          'kernel.pty_retention_bytes',
        ],
        restart_required_keys: [],
        restart_required: false,
      })

      const after = f.kernel.ptyOpen(openRequest(f.context.context_id, f.workspaceId, { label: 'after policy' }), { context: f.context })
      expect(after).toMatchObject({ idle_ttl_s: 45, retention_bytes: 8192 })
      expect((Date.parse(after.lease_expires_at!) - Date.parse(after.open_at)) / 1000).toBeCloseTo(120, 0)
      expect(receipt.config?.effective.config).toMatchObject({
        'kernel.pty_idle_ttl_s': 45,
        'kernel.pty_retention_bytes': 8192,
        'kernel.pty_lease_ttl_s': 120,
      })
      expect(after.config_hash).toBe(f.kernel.configEffective(f.projectId).config_pin)
      expect(after.config_hash).not.toBe(before.config_hash)
      expect(f.adapter.spawned.at(-1)?.config_hash).toBe(after.config_hash)

      const unchanged = f.kernel.ptyGet(before.pty_session_id, f.context, before.generation)
      expect(unchanged).toMatchObject({
        idle_ttl_s: PTY_DEFAULT_IDLE_TTL_S,
        retention_bytes: PTY_DEFAULT_RETENTION_BYTES,
        lease_expires_at: before.lease_expires_at,
        config_hash: before.config_hash,
      })
      expect(() => f.kernel.writeSettingsTransaction({ operations: [{
        kind: 'config', scope: 'runtime', scope_id: 'kernel', expected_revision: 1,
        changes: { 'kernel.pty_retention_bytes': 1024 },
      }] }, 'pi')).toThrowError(expect.objectContaining({ code: 'validation_error' }))
      expect(f.kernel.configLayer('runtime', 'kernel').revision).toBe(1)
    } finally { f.kernel.close() }
  })

  it('fences every lifecycle transition with the exact generation', () => {
    const f = fixture()
    try {
      const opened = f.kernel.ptyOpen(openRequest(f.context.context_id, f.workspaceId), { context: f.context })
      const attached = f.kernel.ptyAttach(opened.pty_session_id, f.context, opened.generation)
      expect(attached).toMatchObject({ state: 'attached', generation: 2 })
      expect(() => f.kernel.ptyDetach(opened.pty_session_id, f.context, opened.generation))
        .toThrowError(expect.objectContaining({ code: 'pty_generation_stale' }))
      const detached = f.kernel.ptyDetach(opened.pty_session_id, f.context, attached.generation)
      const reattached = f.kernel.ptyAttach(opened.pty_session_id, f.context, detached.generation)
      const closed = f.kernel.ptyClose(opened.pty_session_id, f.context, reattached.generation)
      expect(closed).toMatchObject({ state: 'closed', close_reason: 'explicit' })
      expect(() => f.kernel.ptyAttach(opened.pty_session_id, f.context, closed.generation)).toThrowError(/expected open\/detached/)
      expect(f.kernel.ptyClose(opened.pty_session_id, f.context, closed.generation).state).toBe('closed')
    } finally { f.kernel.close() }
  })

  it('resets idle time on activity, closes on TTL, and revokes without killing the session', () => {
    const f = fixture()
    try {
      const first = f.kernel.ptyOpen(openRequest(f.context.context_id, f.workspaceId, { label: 'ttl' }), { context: f.context })
      f.kernel.db.prepare('UPDATE pty_sessions SET idle_ttl_s = 1, last_activity_at = ? WHERE pty_session_id = ?')
        .run(new Date(Date.now() - 60_000).toISOString(), first.pty_session_id)
      const touched = f.kernel.ptyTouch(first.pty_session_id, f.context, first.generation)
      const touchedAt = Date.parse(touched.last_activity_at)
      expect(f.kernel.ptySweepIdle(touchedAt + 500)).not.toContain(first.pty_session_id)
      expect(f.kernel.ptySweepIdle(touchedAt + 1_500)).toContain(first.pty_session_id)
      expect(f.kernel.ptyGet(first.pty_session_id, f.context, first.generation).close_reason).toBe('idle_ttl')
      const second = f.kernel.ptyOpen(openRequest(f.context.context_id, f.workspaceId, { label: 'revoke' }), { context: f.context })
      const attached = f.kernel.ptyAttach(second.pty_session_id, f.context, second.generation)
      const revoked = f.kernel.ptyRevoke(second.pty_session_id, f.context, attached.generation)
      expect(revoked).toMatchObject({ state: 'detached', close_reason: null, generation: 3 })
      expect(f.kernel.ptyRevoke(second.pty_session_id, f.context, revoked.generation).state).toBe('detached')
    } finally { f.kernel.close() }
  })

  it('keeps control sequencing idempotent and delivers resize/signal/close', () => {
    const f = fixture()
    try {
      const session = f.kernel.ptyOpen(openRequest(f.context.context_id, f.workspaceId), { context: f.context })
      expect(f.kernel.ptyControl(session.pty_session_id, control(1, 1), f.context))
        .toMatchObject({ idempotent: false, delivered: true })
      expect(f.kernel.ptyControl(session.pty_session_id, control(1, 1, {
        payload: { text: 'DIFFERENT', byte_length: 9 },
      }), f.context)).toMatchObject({ idempotent: true, delivered: false })
      expect(() => f.kernel.ptyControl(session.pty_session_id, control(1, 3), f.context))
        .toThrowError(expect.objectContaining({ code: 'pty_client_seq_out_of_order' }))
      f.kernel.ptyControl(session.pty_session_id, control(1, 2, { type: 'resize', payload: { cols: 132, rows: 43 } }), f.context)
      f.kernel.ptyControl(session.pty_session_id, control(1, 3, { type: 'signal', payload: { signal: 'INT' } }), f.context)
      f.kernel.ptyControl(session.pty_session_id, control(1, 4, { type: 'close', payload: {} }), f.context)
      expect(f.adapter.deliveries).toEqual(['write:ls\n', 'resize:132x43', 'signal:INT', 'kill'])
      expect(f.kernel.ptyGet(session.pty_session_id, f.context, 1).state).toBe('closed')
    } finally { f.kernel.close() }
  })

  it('replays output monotonically and reports bounded-retention gaps', () => {
    const f = fixture()
    try {
      const session = f.kernel.ptyOpen(openRequest(f.context.context_id, f.workspaceId), { context: f.context })
      f.kernel.db.prepare('UPDATE pty_sessions SET retention_bytes = 16 WHERE pty_session_id = ?').run(session.pty_session_id)
      f.kernel.ptyAppendOutput(session.pty_session_id, [
        { type: 'output', text: 'aaaaaaa\n', byte_length: 8 }, { type: 'output', text: 'bbbbbbb\n', byte_length: 8 },
        { type: 'output', text: 'ccccccc\n', byte_length: 8 }, { type: 'output', text: 'ddddddd\n', byte_length: 8 },
      ])
      const page = f.kernel.ptyFrames(session.pty_session_id, 0, f.context, session.generation)
      expect(PtyFramesPage.parse(page).gap).toBe(true)
      expect(page.frames[0]).toMatchObject({ type: 'gap', payload: { gap_from_seq: 1 } })
      expect(page.frames.filter(frame => frame.type === 'output').map(frame => frame.server_seq)).toEqual([3, 4])
      for (const frame of page.frames) expect(PtyOutputFrame.parse(frame).server_seq).toBeGreaterThan(0)
      const current = f.kernel.ptyGet(session.pty_session_id, f.context, session.generation)
      expect(f.kernel.ptyFrames(session.pty_session_id, current.retained_from_seq, f.context, session.generation).gap).toBe(false)
    } finally { f.kernel.close() }
  })

  it('rejects unsafe cwd and cross-project workspaces without client authority fields', () => {
    const f = fixture()
    try {
      for (const cwd of ['/etc', 'a/../../b', '..', 'C:\\x', 'a\\b']) {
        expect(() => f.kernel.ptyOpen(openRequest(f.context.context_id, f.workspaceId, { cwd }), { context: f.context }))
          .toThrowError(expect.objectContaining({ code: 'pty_open_invalid' }))
      }
      const other = f.kernel.createProject({ name: 'other', workspace: '/other', brief: makeBrief() })
      const foreign = f.kernel.workspaceEnsure(other.project_id, 'scratch', 'other')
      expect(() => f.kernel.ptyOpen(openRequest(f.context.context_id, foreign.workspace_id), { context: f.context }))
        .toThrowError(expect.objectContaining({ code: 'pty_context_mismatch' }))
      expect(() => openRequest(f.context.context_id, f.workspaceId, { project_id: f.projectId })).toThrow(/Unrecognized key/)
      expect(() => openRequest(f.context.context_id, f.workspaceId, { profile: 'forged' })).toThrow(/Unrecognized key/)
    } finally { f.kernel.close() }
  })

  it('keeps a failed spawn as a closed adapter_failed row in the exact context', () => {
    const adapter = new RecordingAdapter()
    adapter.spawnResult = { ok: false, error: 'process unavailable' }
    const f = fixture(adapter)
    try {
      expect(() => f.kernel.ptyOpen(openRequest(f.context.context_id, f.workspaceId), { context: f.context }))
        .toThrowError(expect.objectContaining({ code: 'pty_adapter_failed' }))
      expect(f.kernel.ptyListContext(f.context).sessions[0])
        .toMatchObject({ state: 'closed', close_reason: 'adapter_failed' })
    } finally { f.kernel.close() }
  })

  it('never exposes or accepts the removed plaintext lease fallback', () => {
    const f = fixture()
    try {
      const session = f.kernel.ptyOpen(openRequest(f.context.context_id, f.workspaceId), { context: f.context })
      const columns = (f.kernel.db.prepare("PRAGMA table_info('pty_sessions')").all() as unknown as Array<{ name: string }>).map(column => column.name)
      expect(columns).not.toContain('lease_token')
      f.kernel.db.prepare(`UPDATE pty_sessions SET lease_token_hash = '' WHERE pty_session_id = ?`).run(session.pty_session_id)
      expect(f.kernel.ptyVerifyLease(session.pty_session_id, 'obsolete-plaintext')).toBe(false)
      expect(f.kernel.ptyGet(session.pty_session_id, f.context, session.generation).lease_token).toBeNull()
    } finally { f.kernel.close() }
  })

  it('never promotes PTY traffic into formal research evidence', () => {
    const f = fixture()
    try {
      const session = f.kernel.ptyOpen(openRequest(f.context.context_id, f.workspaceId), { context: f.context })
      f.kernel.ptyControl(session.pty_session_id, control(session.generation, 1), f.context)
      f.kernel.ptyAppendOutput(session.pty_session_id, [
        { type: 'output', text: 'experiment result: 0.99\n', byte_length: 24 },
        { type: 'exit', exit_code: 0, signal: null },
      ])
      expect(f.kernel.listJobs(f.projectId)).toHaveLength(0)
      expect(f.kernel.listRuns(f.projectId)).toHaveLength(0)
      expect(f.kernel.listEvidence(f.projectId)).toHaveLength(0)
      expect(f.kernel.listClaims(f.projectId)).toHaveLength(0)
      expect(f.kernel.listGates(f.projectId)).toHaveLength(0)
      expect(f.kernel.listArtifacts(f.projectId)).toHaveLength(0)
      expect((f.kernel.db.prepare('SELECT COUNT(*) AS n FROM pty_frames').get() as { n: number }).n).toBeGreaterThan(0)
    } finally { f.kernel.close() }
  })

  it('validates current wire schemas strictly', () => {
    expect(() => openRequest('ctx', 'ws', { preset: 'powershell' })).toThrow()
    expect(() => openRequest('ctx', 'ws', { target: 'local' })).toThrow(/Unrecognized key/)
    expect(() => PtyControlRequest.parse({ client_seq: 1, type: 'bytes', payload: { text: 'x', byte_length: 1 } })).toThrow()
    expect(() => control(1, -1)).toThrow()
    expect(() => control(1, 1, { type: 'resize', payload: { cols: 0, rows: 24 } })).toThrow()
    expect(PtyControlFrame.parse({
      pty_session_id: 'pty_x', client_seq: 1, type: 'signal', payload: { signal: 'TERM' },
      created_at: new Date().toISOString(),
    }).type).toBe('signal')
    const adapter = new NullPtyAdapter()
    expect(adapter.id).toBe('null')
    expect(adapter.spawn({} as PtySpawnPlan)).toEqual({ ok: true })
  })
})
