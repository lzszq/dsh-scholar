/**
 * TRAJ-01 / SUBAGENT-01 — standalone safe trajectory projection + subagent
 * topology unit tests (docs/trajectory-subagents.md, authoritative contract).
 *
 * Covers: read-only outbox projection (Research vs Session lanes, monotonic
 * event_seq, keyset pagination with cross-bucket tiebreaker), redaction
 * (tokens/secrets/absolute host paths never projected; statement truncation),
 * 10k-event bounded pagination, direct-child topology tree, exact-parent +
 * breadcrumb (cycle-safe, orphan fail-soft), read-only history, one-shot
 * READ-ONLY followup (state never changes), and principal/membership
 * enforcement on the HTTP surface.
 */
import { describe, expect, it } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ResearchKernel, KernelError } from '@dsh-scholar/research-kernel'
import { startKernelServer } from '../../packages/research-kernel/lib/server.js'
import { ConfiguredTestKernel } from './configured-test-kernel.js'

function freshKernel(): ResearchKernel {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-trajectory-test-'))
  return new ConfiguredTestKernel({ dbPath: join(dir, 'kernel.db'), casRoot: join(dir, 'cas'), requireSignedManifest: false })
}

function expectKernelError(fn: () => unknown, status: number, code: string): void {
  try {
    fn()
    throw new Error('expected KernelError to be thrown')
  } catch (error) {
    expect(error).toBeInstanceOf(KernelError)
    expect((error as KernelError).status).toBe(status)
    expect((error as KernelError).code).toBe(code)
  }
}

function makeBrief() {
  return {
    problem: 'p', scope: 's', questions: [], primary_metrics: ['m'],
    resources: '', risks: [], target_outputs: ['paper'], target_venue: null,
    baseline_repo: null, domain: 'ml',
  }
}

/** Insert a raw outbox row with an explicit per-aggregate event_seq
 * (tests the keyset cursor against numerically-equal seqs across buckets). */
function insertRawEvent(
  kernel: ResearchKernel,
  input: { event_id: string; project_id: string; kind: string; event_seq: number; aggregate_type: string | null; aggregate_id: string | null; created_at?: string },
): void {
  kernel.db.prepare(
    `INSERT INTO events (event_id, project_id, kind, payload, source, delivered, created_at,
       event_seq, event_version, aggregate_type, aggregate_id, aggregate_revision,
       request_id, session_id, attempts, last_error, next_attempt_at, dead_lettered_at)
     VALUES (?, ?, ?, '{}', 'test', 0, ?, ?, 1, ?, ?, NULL, NULL, NULL, 0, NULL, NULL, NULL)`,
  ).run(
    input.event_id, input.project_id, input.kind, input.created_at ?? '2026-01-01T00:00:00.000Z',
    input.event_seq, input.aggregate_type, input.aggregate_id,
  )
}

describe('trajectory projection (kernel)', () => {
  it('projects redacted entries with monotonic seq, lanes and no raw payload', () => {
    const kernel = freshKernel()
    const project = kernel.createProject({ name: 't', workspace: '/w', brief: makeBrief(), creator_principal_id: 'trajectory-pi' })
    const pid = project.project_id
    kernel.createGate({ project_id: pid, type: 'scope', title: 'Scope gate' })
    kernel.submitJob({ project_id: pid, idempotency_key: 'k1', kind: 'echo' })
    kernel.registerArtifact({ project_id: pid, kind: 'log', content: 'x' })
    kernel.linkSession('sess-1', pid, { principal_id: 'trajectory-pi', tenant_id: '', issuer: 'kernel' })
    kernel.recordUsage(pid, { api_requests: 3 })
    const page = kernel.projectTrajectory(pid)
    // project.created + gate.created + job.submitted + artifact.registered +
    // session.linked + budget.updated
    expect(page.total).toBe(6)
    const kinds = page.entries.map(e => e.kind)
    expect(kinds).toContain('project.created')
    expect(kinds).toContain('gate.created')
    expect(kinds).toContain('job.submitted')
    expect(kinds).toContain('artifact.registered')
    expect(kinds).toContain('session.linked')
    expect(kinds).toContain('budget.updated')
    // Monotonic per-aggregate seq (project bucket) with event_id tiebreak.
    const seqs = page.entries.map(e => e.event_seq)
    for (let i = 1; i < seqs.length; i++) {
      expect(seqs[i]!).toBeGreaterThanOrEqual(seqs[i - 1]!)
    }
    // Lanes: research vs session (session.linked is observational).
    for (const e of page.entries) {
      expect(['research', 'session']).toContain(e.lane)
      if (e.kind === 'session.linked') expect(e.lane).toBe('session')
      if (e.kind === 'gate.created' || e.kind === 'job.submitted') expect(e.lane).toBe('research')
    }
    // Every entry is a redacted summary — the raw payload never travels.
    for (const e of page.entries) {
      expect('payload' in e).toBe(false)
      expect(e.summary).toBeTypeOf('string')
      expect(e.summary.length).toBeGreaterThan(0)
      expect(e.entry_id).toMatch(/^evt_/)
    }
    kernel.close()
  })

  it('returns both lanes with their own cursors and lane filtering', () => {
    const kernel = freshKernel()
    const project = kernel.createProject({ name: 't', workspace: '/w', brief: makeBrief(), creator_principal_id: 'trajectory-pi' })
    const pid = project.project_id
    kernel.createGate({ project_id: pid, type: 'scope', title: 'G' })
    kernel.linkSession('sess-2', pid, { principal_id: 'trajectory-pi', tenant_id: '', issuer: 'kernel' })
    const lanes = kernel.projectTrajectoryLanes(pid)
    expect(lanes.research.lane).toBe('research')
    expect(lanes.session.lane).toBe('session')
    expect(lanes.research.entries.map(e => e.kind)).toContain('gate.created')
    expect(lanes.research.entries.map(e => e.kind)).not.toContain('session.linked')
    expect(lanes.session.entries.map(e => e.kind)).toEqual(['session.linked'])
    expect(lanes.research.total + lanes.session.total).toBe(kernel.projectTrajectory(pid).total)
    // Per-lane continuation via the lane filter + the lane's own cursor.
    const researchOnly = kernel.projectTrajectory(pid, { lane: 'research' })
    expect(researchOnly.entries.every(e => e.lane === 'research')).toBe(true)
    kernel.close()
  })

  it('keyset pagination survives numerically-equal seqs across aggregate buckets', () => {
    const kernel = freshKernel()
    const project = kernel.createProject({ name: 't', workspace: '/w', brief: makeBrief() })
    const pid = project.project_id
    // project.created already holds project-bucket seq 1.
    insertRawEvent(kernel, { event_id: 'evt_n1', project_id: pid, kind: 'session.linked', event_seq: 1, aggregate_type: null, aggregate_id: null, created_at: '2026-01-01T00:00:01.000Z' })
    insertRawEvent(kernel, { event_id: 'evt_n2', project_id: pid, kind: 'session.linked', event_seq: 2, aggregate_type: null, aggregate_id: null, created_at: '2026-01-01T00:00:02.000Z' })
    insertRawEvent(kernel, { event_id: 'evt_p2', project_id: pid, kind: 'job.submitted', event_seq: 2, aggregate_type: 'project', aggregate_id: pid, created_at: '2026-01-01T00:00:03.000Z' })
    insertRawEvent(kernel, { event_id: 'evt_p3', project_id: pid, kind: 'job.submitted', event_seq: 3, aggregate_type: 'project', aggregate_id: pid, created_at: '2026-01-01T00:00:04.000Z' })
    // Order by (event_seq, event_id): evt_<created>(1, hex id sorts before
    // 'evt_n1' because digits sort before letters) < evt_n1(1) < evt_n2(2) <
    // evt_p2(2) < evt_p3(3)
    const all: string[] = []
    let cursor: { after_seq: number; after_event_id: string } | null = null
    for (let i = 0; i < 10; i++) {
      const page = kernel.projectTrajectory(pid, { limit: 3, ...cursor })
      all.push(...page.entries.map(e => e.entry_id))
      if (!page.has_more || page.next_after_seq === null || page.next_after_event_id === null) break
      cursor = { after_seq: page.next_after_seq, after_event_id: page.next_after_event_id }
    }
    // All five entries exactly once, in STABLE order — the seq-2 tie (evt_n2
    // vs evt_p2) is resumed by event_id, nothing dropped. The order is
    // (event_seq asc, entry_id asc); the seq-1 pair (project.created random
    // base32 id vs 'evt_n1') is id-ordered, so we assert monotonicity rather
    // than a fixed position (random ids may sort before or after 'evt_n1').
    expect(new Set(all).size).toBe(5)
    for (const named of ['evt_n1', 'evt_n2', 'evt_p2', 'evt_p3']) expect(all).toContain(named)
    const created = all.find(id => !['evt_n1', 'evt_n2', 'evt_p2', 'evt_p3'].includes(id))
    expect(created).toMatch(/^evt_[a-z2-7]{16,}$/)
    // Monotone (seq, id) order across the whole page sequence.
    const seqOf = (id: string): number => {
      if (id === 'evt_n1') return 1
      if (id === 'evt_n2' || id === 'evt_p2') return 2
      if (id === 'evt_p3') return 3
      return 1 // project.created
    }
    for (let i = 1; i < all.length; i++) {
      const a = all[i - 1]!, b = all[i]!
      const sa = seqOf(a), sb = seqOf(b)
      expect(sa < sb || (sa === sb && a < b)).toBe(true)
    }
    kernel.close()
  })

  it('redaction: tokens/secrets/absolute paths never appear; long statements truncated', () => {
    const kernel = freshKernel()
    const project = kernel.createProject({ name: 't', workspace: '/w', brief: makeBrief() })
    const pid = project.project_id
    const evil = 'token sk-1234567890abcdefghij secret xoxb-abcdefghijklmnopqrst ghp_abcdefghijklmnopqrstuvwx ' +
      'Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0 path /home/dev/Desktop/secret-dir/data.txt ' +
      'and /Users/operator/work/private/key.pem and /tmp/scratch/run1 and C:\\Users\\ops\\keys\\id_rsa'
    kernel.emit(pid, 'gate.created', { type: 'scope', title: evil })
    kernel.emit(pid, 'job.submitted', { job_id: 'job_x', kind: 'echo', env: { API_KEY: 'sk-super-secret-1234567890' } })
    const longTitle = 'statement '.repeat(60) // 540 chars
    kernel.emit(pid, 'gate.created', { type: 'contract', title: longTitle })
    const page = kernel.projectTrajectory(pid)
    for (const e of page.entries) {
      expect(e.summary).not.toContain('sk-1234567890abcdefghij')
      expect(e.summary).not.toContain('sk-super-secret')
      expect(e.summary).not.toContain('xoxb-')
      expect(e.summary).not.toContain('ghp_')
      expect(e.summary).not.toContain('Bearer eyJ')
      expect(e.summary).not.toContain('/home/dev/Desktop')
      expect(e.summary).not.toContain('/Users/operator')
      expect(e.summary).not.toContain('/tmp/scratch')
      expect(e.summary).not.toContain('C:\\Users')
      expect(e.summary.length).toBeLessThanOrEqual(240)
      expect('payload' in e).toBe(false)
    }
    // The long statement is truncated server-side (statement 长度截断).
    const contract = page.entries.find(e => e.kind === 'gate.created' && e.summary.includes('contract'))
    expect(contract).toBeDefined()
    expect(contract!.summary.endsWith('…')).toBe(true)
    expect(contract!.summary.length).toBe(240)
    kernel.close()
  })

  it('10k events: bounded pages, stable cursor, fast and memory-bounded', () => {
    const kernel = freshKernel()
    const project = kernel.createProject({ name: 't', workspace: '/w', brief: makeBrief() })
    const pid = project.project_id
    const insert = kernel.db.prepare(
      `INSERT INTO events (event_id, project_id, kind, payload, source, delivered, created_at,
         event_seq, event_version, aggregate_type, aggregate_id, aggregate_revision,
         request_id, session_id, attempts, last_error, next_attempt_at, dead_lettered_at)
       VALUES (?, ?, 'job.submitted', '{}', 'bulk', 0, ?, ?, 1, 'project', ?, NULL, NULL, NULL, 0, NULL, NULL, NULL)`,
    )
    kernel.db.exec('BEGIN')
    try {
      for (let i = 0; i < 10_000; i++) {
        const seq = i + 2 // project.created already took seq 1
        insert.run(`evt_bulk_${i}`, pid, `2026-01-01T00:${String(Math.floor(i / 60)).padStart(2, '0')}:${String(i % 60).padStart(2, '0')}.000Z`, seq, pid)
      }
      kernel.db.exec('COMMIT')
    } catch (error) {
      kernel.db.exec('ROLLBACK')
      throw error
    }
    const started = Date.now()
    const seen: string[] = []
    let cursor: { after_seq: number; after_event_id: string } | null = null
    let pages = 0
    for (let i = 0; i < 100; i++) {
      const page = kernel.projectTrajectory(pid, { limit: 500, ...cursor })
      pages += 1
      expect(page.entries.length).toBeLessThanOrEqual(500)
      seen.push(...page.entries.map(e => e.entry_id))
      if (!page.has_more || page.next_after_seq === null || page.next_after_event_id === null) break
      cursor = { after_seq: page.next_after_seq, after_event_id: page.next_after_event_id }
    }
    const elapsed = Date.now() - started
    // 10001 rows (10k bulk + project.created) in 21 pages × 500, no dup/loss.
    expect(pages).toBe(21)
    expect(new Set(seen).size).toBe(10_001)
    expect(kernel.projectTrajectory(pid).total).toBe(10_001)
    // Page size cap is enforced even when the caller asks for more.
    const capped = kernel.projectTrajectory(pid, { limit: 5000 })
    expect(capped.limit).toBe(500)
    expect(capped.entries.length).toBe(500)
    expect(elapsed).toBeLessThan(10_000)
    kernel.close()
  })
})

describe('child topology (kernel)', () => {
  it('records child links and lists exact direct children with counts', () => {
    const kernel = freshKernel()
    const project = kernel.createProject({ name: 't', workspace: '/w', brief: makeBrief() })
    const pid = project.project_id
    const root = kernel.registerChildLink({ project_id: pid, child_id: 'sess_root', label: 'scholar-panel', summary: 'root panel summary', mode: 'one-shot' })
    expect(root.state).toBe('running')
    const c1 = kernel.registerChildLink({ project_id: pid, child_id: 'sess_c1', parent_id: root.child_id, label: 'scholar-classics', summary: 'classics findings', mode: 'one-shot' })
    const c2 = kernel.registerChildLink({ project_id: pid, child_id: 'sess_c2', parent_id: root.child_id, label: 'scholar-frontier', summary: 'frontier findings', mode: 'continuable' })
    kernel.registerChildLink({ project_id: pid, child_id: 'sess_g1', parent_id: c1.child_id, label: 'curator', summary: 'dedup check', mode: 'one-shot' })
    kernel.registerChildLink({ project_id: pid, child_id: 'sess_other', label: 'independent', summary: 'no parent', mode: 'one-shot' })

    // Roots: children whose parent_id is NULL (top-level links — in the
    // plugin flow these are the children whose parent agent session is not
    // itself a registered child).
    const roots = kernel.projectTopology(pid)
    expect(roots.total).toBe(2)
    expect(roots.items.map(n => n.child_id)).toEqual(['sess_root', 'sess_other'])
    expect(roots.items[0]!.has_children).toBe(true)
    expect(roots.items[0]!.children_count).toBe(2)
    expect(roots.items[1]!.has_children).toBe(false)
    // Exact direct children of the root — the grandchild is NOT listed here.
    const kids = kernel.projectTopology(pid, { parent_id: root.child_id })
    expect(kids.total).toBe(2)
    expect(kids.items.map(n => n.child_id)).toEqual(['sess_c1', 'sess_c2'])
    const c1Node = kids.items.find(n => n.child_id === 'sess_c1')!
    expect(c1Node.has_children).toBe(true)
    expect(c1Node.children_count).toBe(1)
    expect(c1Node.mode).toBe('one-shot')
    expect(c1Node.summary).toBe('classics findings')
    const c2Node = kids.items.find(n => n.child_id === 'sess_c2')!
    expect(c2Node.mode).toBe('continuable')
    expect(c2Node.has_children).toBe(false)
    const grand = kernel.projectTopology(pid, { parent_id: c1.child_id })
    expect(grand.items.map(n => n.child_id)).toEqual(['sess_g1'])
    // Outbox: child start events are session-lane observational events.
    const events = kernel.listEvents(pid)
    const started = events.filter(e => e.kind === 'trajectory.child.started')
    expect(started.length).toBe(5)
    for (const e of started) {
      expect(kernel.projectTrajectory(pid).entries.find(x => x.entry_id === e.event_id)?.lane).toBe('session')
    }
    kernel.close()
  })

  it('exact-parent + breadcrumb; cycle-safe and orphan fail-soft', () => {
    const kernel = freshKernel()
    const project = kernel.createProject({ name: 't', workspace: '/w', brief: makeBrief() })
    const pid = project.project_id
    const root = kernel.registerChildLink({ project_id: pid, child_id: 'sess_root', label: 'root', mode: 'one-shot' })
    const mid = kernel.registerChildLink({ project_id: pid, child_id: 'sess_mid', parent_id: root.child_id, label: 'mid', mode: 'one-shot' })
    const leaf = kernel.registerChildLink({ project_id: pid, child_id: 'sess_leaf', parent_id: mid.child_id, label: 'leaf', mode: 'one-shot' })

    const detail = kernel.getChildDetail(leaf.child_id)
    expect(detail.project_id).toBe(pid)
    expect(detail.parent?.child_id).toBe(mid.child_id)
    expect(detail.breadcrumb.map(n => n.child_id)).toEqual([root.child_id, mid.child_id])
    // Root child: no parent, empty breadcrumb.
    const rootDetail = kernel.getChildDetail(root.child_id)
    expect(rootDetail.parent).toBeNull()
    expect(rootDetail.breadcrumb).toEqual([])
    // Orphan fail-soft: parent session never registered → parent null.
    kernel.registerChildLink({ project_id: pid, child_id: 'sess_orphan', parent_id: 'sess_ghost', label: 'orphan', mode: 'one-shot' })
    const orphan = kernel.getChildDetail('sess_orphan')
    expect(orphan.parent).toBeNull()
    expect(orphan.breadcrumb).toEqual([])
    // Cycle-safe: a → b → a terminates with a bounded breadcrumb.
    kernel.registerChildLink({ project_id: pid, child_id: 'sess_cyc_a', parent_id: 'sess_cyc_b', label: 'a', mode: 'one-shot' })
    kernel.registerChildLink({ project_id: pid, child_id: 'sess_cyc_b', parent_id: 'sess_cyc_a', label: 'b', mode: 'one-shot' })
    const cyc = kernel.getChildDetail('sess_cyc_a')
    expect(cyc.breadcrumb.length).toBeLessThanOrEqual(32)
    // Unknown child → 404.
    expectKernelError(() => kernel.getChildDetail('sess_missing'), 404, 'child_not_found')
    expect(kernel.childProjectId('sess_missing')).toBeNull()
    kernel.close()
  })

  it('state transitions pin ended_at once; re-registration never resurrects', () => {
    const kernel = freshKernel()
    const project = kernel.createProject({ name: 't', workspace: '/w', brief: makeBrief() })
    const pid = project.project_id
    kernel.registerChildLink({ project_id: pid, child_id: 'sess_s', label: 'worker', mode: 'one-shot' })
    const running = kernel.getChildLink('sess_s')
    expect(running.state).toBe('running')
    const succeeded = kernel.updateChildState('sess_s', 'succeeded', 'finished cleanly')
    expect(succeeded.state).toBe('succeeded')
    expect(succeeded.ended_at).not.toBeNull()
    // Terminal state is monotonic; retry uses a new child node.
    expectKernelError(() => kernel.updateChildState('sess_s', 'inactive'), 409, 'child_state_terminal')
    expect(kernel.updateChildState('sess_s', 'succeeded')).toEqual(succeeded)
    // Re-registration (e.g. plugin reload) preserves the terminal state.
    const re = kernel.registerChildLink({ project_id: pid, child_id: 'sess_s', label: 'worker', summary: 'fresh summary', mode: 'one-shot' })
    expect(re.state).toBe('succeeded')
    expect(re.ended_at).not.toBeNull()
    expect(re.summary).toBe('fresh summary')
    expectKernelError(() => kernel.updateChildState('sess_missing', 'failed'), 404, 'child_not_found')
    kernel.registerChildLink({ project_id: pid, child_id: 'sess_cancelled', label: 'cancelled worker', mode: 'one-shot' })
    const cancelled = kernel.updateChildState('sess_cancelled', 'cancelled', 'parent aborted')
    expect(cancelled.state).toBe('cancelled')
    expect(cancelled.ended_at).not.toBeNull()
    expectKernelError(() => kernel.updateChildState('sess_cancelled', 'failed'), 409, 'child_state_terminal')
    kernel.close()
  })

  it('history is read-only and paginated; followup is one-shot read-only and never changes state', () => {
    const kernel = freshKernel()
    const project = kernel.createProject({ name: 't', workspace: '/w', brief: makeBrief() })
    const pid = project.project_id
    kernel.registerChildLink({ project_id: pid, child_id: 'sess_h', label: 'panelist', summary: 'initial', mode: 'continuable' })
    kernel.updateChildState('sess_h', 'succeeded')
    const before = kernel.getChildLink('sess_h').state

    // History is read-only: reading it must not change any state.
    const history = kernel.childHistory('sess_h')
    expect(history.total).toBe(2)
    expect(history.items.map(i => i.type)).toEqual(['started', 'state'])
    expect(history.items[0]!.summary).toContain('started')
    expect(history.items[1]!.summary).toContain('succeeded')
    expect(kernel.getChildLink('sess_h').state).toBe(before)

    // Followup: one-shot READ-ONLY — message recorded, message_id returned,
    // state untouched, history gains a followup entry.
    const receipt = kernel.childFollowup('sess_h', 'please expand the frontier section with more refs')
    expect(receipt.accepted).toBe(true)
    expect(receipt.read_only).toBe(true)
    expect(receipt.state_unchanged).toBe(true)
    expect(receipt.message_id).toMatch(/^msg_[a-z2-7]{16,}$/)
    expect(kernel.getChildLink('sess_h').state).toBe(before)
    const after = kernel.childHistory('sess_h')
    expect(after.total).toBe(3)
    const followupEntry = after.items.find(i => i.type === 'followup')
    expect(followupEntry).toBeDefined()
    expect(followupEntry!.summary).toContain(receipt.message_id)
    // The outbox records the followup (session lane).
    const followupEvent = kernel.listEvents(pid).find(e => e.kind === 'trajectory.child.followup')
    expect(followupEvent).toBeDefined()
    expect(followupEvent!.payload.message_id).toBe(receipt.message_id)
    // History pagination with the per-child seq cursor.
    const page2 = kernel.childHistory('sess_h', { after_seq: after.items[1]!.seq })
    expect(page2.items.map(i => i.type)).toEqual(['followup'])
    expect(page2.has_more).toBe(false)
    // Unknown child → 404 for history and followup.
    expectKernelError(() => kernel.childHistory('sess_missing'), 404, 'child_not_found')
    expectKernelError(() => kernel.childFollowup('sess_missing', 'hi'), 404, 'child_not_found')
    kernel.close()
  })

  it('redacts child summaries at write time (truncation + secrets)', () => {
    const kernel = freshKernel()
    const project = kernel.createProject({ name: 't', workspace: '/w', brief: makeBrief() })
    const pid = project.project_id
    const long = 'findings '.repeat(200)
    kernel.registerChildLink({
      project_id: pid, child_id: 'sess_red', label: 'panelist',
      summary: `${long} token sk-1234567890abcdefghij path /home/dev/Desktop/x/secret.txt`,
      mode: 'one-shot',
    })
    const link = kernel.getChildLink('sess_red')
    expect(link.summary.length).toBeLessThanOrEqual(240)
    expect(link.summary).not.toContain('sk-1234567890abcdefghij')
    expect(link.summary).not.toContain('/home/dev/Desktop')
    // Topology node view is redacted the same way.
    const node = kernel.projectTopology(pid, { parent_id: null }).items[0]!
    expect(node.summary).not.toContain('sk-1234567890abcdefghij')
    kernel.close()
  })
})

describe('trajectory/topology HTTP surface', () => {
  it('enforces principal + project membership fail-closed on every route', async () => {
    const kernel = freshKernel()
    const project = kernel.createProject({ name: 't', workspace: '/w', brief: makeBrief(), creator_principal_id: 'princ-1' })
    const pid = project.project_id
    kernel.addProjectMember({ project_id: pid, principal_id: 'princ-2', role: 'researcher', actor: 'princ-1' })
    kernel.registerChildLink({ project_id: pid, child_id: 'sess_web', label: 'panelist', summary: 'summary', mode: 'one-shot' })
    const { server, port } = await startKernelServer({ kernel, port: 0 })
    const base = `http://127.0.0.1:${port}`
    try {
      const get = (path: string, principal?: string): Promise<Response> =>
        fetch(`${base}${path}`, { headers: principal !== undefined ? { 'x-principal-id': principal } : {} })
      const post = (path: string, body: unknown, principal?: string): Promise<Response> =>
        fetch(`${base}${path}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...principal !== undefined ? { 'x-principal-id': principal } : {} },
          body: JSON.stringify(body),
        })

      // Missing principal → 422 principal_required (fail-closed).
      const anon = await get(`/v1/projects/${pid}/trajectory`)
      expect(anon.status).toBe(422)
      expect((await anon.json() as { error: { code: string } }).error.code).toBe('principal_required')
      const anonTopo = await get(`/v1/projects/${pid}/topology`)
      expect(anonTopo.status).toBe(422)
      const anonChild = await get('/v1/topology/sess_web')
      expect(anonChild.status).toBe(422)

      // Non-member → 404 project_not_found (no enumeration).
      const stranger = await get(`/v1/projects/${pid}/trajectory`, 'stranger')
      expect(stranger.status).toBe(404)
      const strangerChild = await get('/v1/topology/sess_web', 'stranger')
      expect(strangerChild.status).toBe(404)

      // Member → 200 projection + lanes + topology.
      const okTraj = await get(`/v1/projects/${pid}/trajectory`, 'princ-2')
      expect(okTraj.status).toBe(200)
      const traj = await okTraj.json() as { project_id: string; entries: Array<{ kind: string }> }
      expect(traj.project_id).toBe(pid)
      const lanes = await get(`/v1/projects/${pid}/trajectory-lanes`, 'princ-2')
      expect(lanes.status).toBe(200)
      const topo = await get(`/v1/projects/${pid}/topology`, 'princ-2')
      expect(topo.status).toBe(200)

      // Register a child via HTTP (member) → 201; anonymous → 422.
      const reg = await post(`/v1/projects/${pid}/topology/children`, { child_id: 'sess_http', label: 'http-child', summary: 's', mode: 'one-shot' }, 'princ-2')
      expect(reg.status).toBe(201)
      const regAnon = await post(`/v1/projects/${pid}/topology/children`, { child_id: 'sess_anon', label: 'x' })
      expect(regAnon.status).toBe(422)

      // Child detail/history/followup: member 200, unknown child 404.
      const detail = await get('/v1/topology/sess_http', 'princ-2')
      expect(detail.status).toBe(200)
      expect((await detail.json() as { project_id: string }).project_id).toBe(pid)
      const history = await get('/v1/topology/sess_http/history', 'princ-2')
      expect(history.status).toBe(200)
      const followup = await post('/v1/topology/sess_http/followup', { message: 'read-only followup' }, 'princ-2')
      expect(followup.status).toBe(200)
      const receipt = await followup.json() as { state_unchanged: boolean; message_id: string }
      expect(receipt.state_unchanged).toBe(true)
      expect(receipt.message_id).toMatch(/^msg_/)
      const unknownChild = await get('/v1/topology/sess_missing', 'princ-2')
      expect(unknownChild.status).toBe(404)
      expect((await unknownChild.json() as { error: { code: string } }).error.code).toBe('child_not_found')
      // State transition route (PATCH) is principal-gated too.
      const state = await fetch(`${base}/v1/topology/sess_http/state`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json', 'x-principal-id': 'princ-2' },
        body: JSON.stringify({ state: 'succeeded' }),
      })
      expect(state.status).toBe(200)
      const stateAnon = await fetch(`${base}/v1/topology/sess_http/state`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ state: 'failed' }),
      })
      expect(stateAnon.status).toBe(422)
    } finally {
      server.close()
      kernel.close()
    }
  })

  it('lets only the exact linked DSH parent service write observational lifecycle', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-topology-service-'))
    const kernel = new ConfiguredTestKernel({
      dbPath: join(dir, 'kernel.db'),
      casRoot: join(dir, 'cas'),
      requireSignedManifest: false,
      serviceToken: 'service-secret',
    })
    const project = kernel.createProject({ name: 't', workspace: '/w', brief: makeBrief(), session_id: 'parent-session' })
    const otherProject = kernel.createProject({ name: 'other', workspace: '/w2', brief: makeBrief(), session_id: 'other-session' })
    const { server, port } = await startKernelServer({ kernel, port: 0, token: 'bearer-secret' })
    const base = 'http://127.0.0.1:' + port
    const request = (path: string, method: 'POST' | 'PATCH', body: unknown, headers: Record<string, string> = {}): Promise<Response> =>
      fetch(base + path, {
        method,
        headers: {
          'content-type': 'application/json',
          authorization: 'Bearer bearer-secret',
          'x-service-token': 'service-secret',
          'x-service-principal': 'dsh-plugin',
          ...headers,
        },
        body: JSON.stringify(body),
      })
    try {
      const wrongToken = await request('/internal/projects/' + project.project_id + '/topology/children', 'POST', {
        child_id: 'child-wrong-token', parent_id: 'parent-session', session_id: 'parent-session',
      }, { 'x-service-token': 'wrong' })
      expect(wrongToken.status).toBe(403)

      const encodedInternal = await request('/%69nternal/projects/' + project.project_id + '/topology/children', 'POST', {
        child_id: 'child-encoded-path', parent_id: 'parent-session', session_id: 'parent-session',
      }, { 'x-service-token': '' })
      expect(encodedInternal.status).toBe(403)

      const duplicateSlash = await request('/internal//projects/' + project.project_id + '/topology/children', 'POST', {
        child_id: 'child-duplicate-path', parent_id: 'parent-session', session_id: 'parent-session',
      }, { 'x-service-token': '' })
      expect(duplicateSlash.status).toBe(403)

      const wrongParent = await request('/internal/projects/' + project.project_id + '/topology/children', 'POST', {
        child_id: 'child-wrong-parent', parent_id: 'other-session', session_id: 'parent-session',
      })
      expect(wrongParent.status).toBe(403)

      const registered = await request('/internal/projects/' + project.project_id + '/topology/children', 'POST', {
        child_id: 'child-service', parent_id: 'parent-session', session_id: 'parent-session',
        label: 'survey/classics', summary: 'safe', mode: 'one-shot', role: 'scholar', state: 'running',
      })
      expect(registered.status).toBe(201)

      const rebound = await request('/internal/projects/' + otherProject.project_id + '/topology/children', 'POST', {
        child_id: 'child-service', parent_id: 'other-session', session_id: 'other-session',
        label: 'foreign', summary: 'must not replace ownership', state: 'running',
      })
      expect(rebound.status).toBe(409)
      expect((await rebound.json() as { error: { code: string } }).error.code).toBe('child_link_conflict')

      const wrongStateSession = await request('/internal/topology/child-service/state', 'PATCH', {
        session_id: 'other-session', state: 'cancelled',
      })
      expect(wrongStateSession.status).toBe(409)

      const cancelled = await request('/internal/topology/child-service/state', 'PATCH', {
        session_id: 'parent-session', state: 'cancelled', detail: 'parent aborted',
      })
      expect(cancelled.status).toBe(200)
      expect((await cancelled.json() as { state: string }).state).toBe('cancelled')

      const revived = await request('/internal/topology/child-service/state', 'PATCH', {
        session_id: 'parent-session', state: 'failed',
      })
      expect(revived.status).toBe(409)
      expect((await revived.json() as { error: { code: string } }).error.code).toBe('child_state_terminal')
    } finally {
      server.close()
      kernel.close()
    }
  })

  it('pagination and lane filtering work over HTTP with member principal', async () => {
    const kernel = freshKernel()
    const project = kernel.createProject({ name: 't', workspace: '/w', brief: makeBrief(), creator_principal_id: 'princ-1' })
    const pid = project.project_id
    for (let i = 0; i < 12; i++) kernel.createGate({ project_id: pid, type: 'scope', title: `gate ${i}` })
    const { server, port } = await startKernelServer({ kernel, port: 0 })
    try {
      const headers = { 'x-principal-id': 'princ-1' }
      const page1 = await fetch(`http://127.0.0.1:${port}/v1/projects/${pid}/trajectory?limit=5`, { headers })
      expect(page1.status).toBe(200)
      const p1 = await page1.json() as { entries: Array<{ entry_id: string }>; next_after_seq: number; next_after_event_id: string; has_more: boolean }
      expect(p1.entries.length).toBe(5)
      expect(p1.has_more).toBe(true)
      const page2 = await fetch(`http://127.0.0.1:${port}/v1/projects/${pid}/trajectory?limit=5&after_seq=${p1.next_after_seq}&after_event_id=${p1.next_after_event_id}`, { headers })
      const p2 = await page2.json() as { entries: Array<{ entry_id: string }>; has_more: boolean }
      expect(p2.entries.length).toBe(5)
      const ids = new Set([...p1.entries.map(e => e.entry_id), ...p2.entries.map(e => e.entry_id)])
      expect(ids.size).toBe(10)
      // Lane filter over HTTP.
      const research = await fetch(`http://127.0.0.1:${port}/v1/projects/${pid}/trajectory?lane=research&limit=3`, { headers })
      const r = await research.json() as { lane: string; entries: Array<{ lane: string }> }
      expect(r.lane).toBe('research')
      expect(r.entries.every(e => e.lane === 'research')).toBe(true)
      // Malformed limit falls back to the default cap (200), never crashes.
      const bad = await fetch(`http://127.0.0.1:${port}/v1/projects/${pid}/trajectory?limit=abc`, { headers })
      expect(bad.status).toBe(200)
    } finally {
      server.close()
      kernel.close()
    }
  })
})
