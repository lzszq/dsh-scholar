import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// DOM doubles exercise the actual asynchronous panel controller and input
// handlers. They make no assertion about browser layout or screenshots.
const harness = vi.hoisted(() => {
  class Node {
    children: Node[] = []
    style: Record<string, string> = { cssText: '', display: '', borderColor: '' }
    dataset: Record<string, string> = {}
    attributes: Record<string, string> = {}
    value = ''
    textContent = ''
    disabled = false
    parentElement: Node | null = null
    title = ''
    oninput?: () => void
    onclick?: () => void
    constructor(readonly tagName: string) {}
    append(...nodes: Node[]): void { for (const node of nodes) this.appendChild(node) }
    appendChild(node: Node): Node { node.parentElement = this; this.children.push(node); return node }
    replaceChildren(...nodes: Node[]): void { this.children = []; this.append(...nodes) }
    focus(): void {}
    setAttribute(key: string, value: string): void { this.attributes[key] = value }
    querySelector(): null { return null }
    find(tag: string): Node | undefined {
      if (this.tagName === tag) return this
      for (const child of this.children) { const found = child.find(tag); if (found) return found }
    }
    all(tag: string): Node[] { return [...(this.tagName === tag ? [this] : []), ...this.children.flatMap(child => child.all(tag))] }
  }
  return {
    Node, result: vi.fn(), rerender: vi.fn(), revision: 3, version: 1, content: 'saved paper',
  }
})

vi.mock('../../packages/dsh-research-ui/src/client/api', () => ({
  apiResult: harness.result,
  api: async (path: string, init?: RequestInit) => { const result = await harness.result(path, init); return result.ok ? result.data : null },
  authHeaders: async () => ({}), base: () => '',
}))
vi.mock('../../packages/dsh-research-ui/src/client/ui', () => ({
  el: (tag: string, _class?: string, text?: string) => { const node = new harness.Node(tag); node.textContent = text ?? ''; return node },
  rootHost: () => null,
  pill: (status: string) => { const node = new harness.Node('span'); node.textContent = status; return node },
  shortType: (type: string) => type,
  fmtId: (id: string) => id,
  copyText: vi.fn(), openContextMenu: vi.fn(), showToast: vi.fn(),
}))
vi.mock('../../packages/dsh-research-ui/src/client/i18n/index', () => ({ t: (_namespace: string, key: string) => key }))
vi.mock('../../packages/dsh-research-ui/src/client/state', () => ({ state: { rerender: harness.rerender }, tabSave: vi.fn() }))
vi.mock('../../packages/dsh-research-ui/src/client/terminal', () => ({ terminalLoadSeq: vi.fn() }))
vi.mock('../../packages/dsh-research-ui/src/client/modals/settings', () => ({ openSettingsModal: vi.fn() }))
vi.mock('../../packages/dsh-research-ui/src/client/methodology-projection', () => ({ methodologySummaryNode: () => new harness.Node('section') }))
vi.mock('../../packages/dsh-research-ui/src/client/panels/release-review', () => ({ renderReleaseReview: vi.fn() }))

type Panel = typeof import('../../packages/dsh-research-ui/src/client/panels/manuscript')
let panel: Panel
let body: InstanceType<typeof harness.Node>
const ok = (data: unknown) => ({ ok: true, status: 200, data })
const build = () => ({ build_id: 'build-1', revision: harness.revision, status: 'queued', root_file: 'paper.tex', job_id: 'job-1', pdf_artifact: null, log_artifact: null, diagnostics: '[]' })

async function request(path: string, init?: RequestInit): Promise<unknown> {
  const method = init?.method ?? 'GET'
  if (path.endsWith('/manuscript-drafts')) return ok({ document_id: 'doc-cnn' })
  if (path.endsWith('/tree')) return ok({ document: { revision: harness.revision }, files: [{ path: 'paper.tex', version: harness.version, content_hash: 'hash' }] })
  if (path.includes('/file?')) return ok({ path: 'paper.tex', version: harness.version, content: harness.content })
  if (path.endsWith('/file') && method === 'PUT') {
    harness.content = JSON.parse(String(init?.body)).content
    harness.version += 1
    harness.revision += 1
    return ok({ version: harness.version, content_hash: 'saved-hash' })
  }
  if (path.endsWith('/preview-builds')) return ok({ pending: null, builds: [] })
  if (path.endsWith('/builds')) return ok(method === 'POST' ? { build: build() } : [])
  throw new Error(`Unexpected ${method} ${path}`)
}

beforeEach(async () => {
  vi.resetModules()
  harness.result.mockReset().mockImplementation(request)
  harness.rerender.mockReset()
  harness.revision = 3; harness.version = 1; harness.content = 'saved paper'
  vi.stubGlobal('document', { querySelector: () => null, createElement: (tag: string) => new harness.Node(tag) })
  vi.stubGlobal('window', { setInterval: vi.fn(() => 1), clearInterval: vi.fn(), confirm: vi.fn(() => true) })
  panel = await import('../../packages/dsh-research-ui/src/client/panels/manuscript')
  body = new harness.Node('main')
  await panel.renderManuscript(body as unknown as HTMLElement, {}, 'cnn')
  await panel.msPollBuilds()
  await panel.msPollPreviews()
  harness.result.mockClear()
  harness.rerender.mockClear()
})
afterEach(() => { panel?.msCleanup(true); vi.unstubAllGlobals() })

function writes(suffix: string): Array<[string, RequestInit]> {
  return harness.result.mock.calls.filter(([path, init]) => path.endsWith(suffix) && init?.method === 'POST') as Array<[string, RequestInit]>
}
function edit(text: string): void {
  const editor = body.find('textarea')!
  editor.value = text
  editor.oninput!()
}

describe('Manuscript controller regressions', () => {
  it('submits a clean document once and holds background repaint while submitting', async () => {
    let resolveBuild!: (value: unknown) => void
    harness.result.mockImplementation((path, init) => path.endsWith('/builds') && init?.method === 'POST'
      ? new Promise(resolve => { resolveBuild = resolve }) : request(path, init))
    const compile = panel.msCompile()
    expect(panel.msMutationPending()).toBe(true)
    await panel.msCompile()
    expect(writes('/builds')).toHaveLength(1)
    expect(JSON.parse(String(writes('/builds')[0]?.[1].body))).toMatchObject({ expected_document_revision: 3 })
    expect(harness.rerender).not.toHaveBeenCalled()
    resolveBuild(ok({ build: build() }))
    await compile
    expect(panel.msMutationPending()).toBe(false)
    expect(panel.msBuilds[0]?.job_id).toBe('job-1')
    expect(harness.rerender).toHaveBeenCalledOnce()
  })

  it('enables Save on input, saves with CAS, then compiles the new revision without a competing preview', async () => {
    edit('updated paper')
    expect(panel.msDirty).toBe(true)
    expect(body.all('button').find(button => button.textContent === 'manuscript.action.save')?.disabled).toBe(false)
    await panel.msCompile()
    const save = harness.result.mock.calls.find(([, init]) => init?.method === 'PUT')
    expect(JSON.parse(String(save?.[1].body))).toEqual({ path: 'paper.tex', content: 'updated paper', expected_version: 1 })
    expect(JSON.parse(String(writes('/builds')[0]?.[1].body)).expected_document_revision).toBe(4)
    expect(writes('/preview-builds')).toHaveLength(0)
    expect(panel.msDirty).toBe(false)
    expect(panel.msContent).toBe('updated paper')
  })

  it('keeps local edits and stops compilation when save has a real version conflict', async () => {
    edit('local paper')
    harness.result.mockImplementation((path, init) => init?.method === 'PUT'
      ? Promise.resolve({ ok: false, status: 409, error: { code: 'document_version_conflict' } }) : request(path, init))
    await panel.msCompile()
    expect(writes('/builds')).toHaveLength(0)
    expect(panel.msConflict).toBe('manuscript.failure.conflict')
    expect(panel.msContent).toBe('local paper')
    expect(panel.msDirty).toBe(true)
    expect(panel.msMutationPending()).toBe(false)
  })

  it('shows the actual missing runner configuration on a clean compile', async () => {
    harness.result.mockImplementation((path, init) => path.endsWith('/builds') && init?.method === 'POST'
      ? Promise.resolve({ ok: false, status: 422, error: { code: 'runner_profile_required' } }) : request(path, init))
    await panel.msCompile()
    expect(panel.msConflict).toBe('manuscript.failure.runner')
    expect(panel.msBuilds).toHaveLength(0)
  })

  it('reloads both file version and document revision before the next compile', async () => {
    harness.content = 'new server paper'; harness.version = 2; harness.revision = 7
    await panel.msReloadFile()
    expect(panel.msContent).toBe('new server paper')
    expect(panel.msSavedVersion).toBe(2)
    expect(panel.msRevision).toBe(7)
    await panel.msCompile()
    expect(JSON.parse(String(writes('/builds')[0]?.[1].body)).expected_document_revision).toBe(7)
  })

  it('refreshes externally changed clean content but preserves dirty edits and their CAS version', async () => {
    harness.content = 'changed on the server'; harness.version = 2; harness.revision = 5
    const refreshed = new harness.Node('main')
    await panel.renderManuscript(refreshed as unknown as HTMLElement, {}, 'cnn')
    expect(panel.msContent).toBe('changed on the server')
    expect(panel.msSavedVersion).toBe(2)
    body = refreshed
    edit('local edits')
    harness.content = 'changed again'; harness.version = 3; harness.revision = 6
    await panel.renderManuscript(new harness.Node('main') as unknown as HTMLElement, {}, 'cnn')
    expect(panel.msContent).toBe('local edits')
    expect(panel.msSavedVersion).toBe(2)
    expect(panel.msDirty).toBe(true)
  })

  it('does not discard edits or clear recovery when reloading the document tree fails', async () => {
    edit('uncommitted paper')
    harness.result.mockImplementation((path, init) => path.endsWith('/tree')
      ? Promise.resolve({ ok: false, status: 503, error: { code: 'unavailable' } }) : request(path, init))
    await panel.msReloadFile()
    expect(panel.msContent).toBe('uncommitted paper')
    expect(panel.msDirty).toBe(true)
    expect(panel.msConflict).toBe('manuscript.failure.other')
  })

  it('retries an uncertain request with the same idempotency key', async () => {
    let submissions = 0
    harness.result.mockImplementation((path, init) => {
      if (path.endsWith('/builds') && init?.method === 'POST' && ++submissions === 1) {
        return Promise.resolve({ ok: false, status: 0, error: { code: 'network_error' } })
      }
      return request(path, init)
    })
    await panel.msCompile()
    await panel.msCompile()
    const keys = writes('/builds').map(([, init]) => JSON.parse(String(init.body)).idempotency_key)
    expect(keys).toHaveLength(2)
    expect(keys[0]).toMatch(/^latex-ui:doc-cnn:3:/)
    expect(keys[1]).toBe(keys[0])
  })

  it('ignores a stale build poll that completes after a new compile submission', async () => {
    let resolvePoll!: (value: unknown) => void
    harness.result.mockImplementation((path, init) => path.endsWith('/builds') && init?.method !== 'POST'
      ? new Promise(resolve => { resolvePoll = resolve }) : request(path, init))
    const poll = panel.msPollBuilds()
    await panel.msCompile()
    resolvePoll(ok([]))
    await poll
    expect(panel.msBuilds[0]?.build_id).toBe('build-1')
  })
})

describe('Approval panel refresh regressions', () => {
  async function approvals(project = 'cnn', status = 'pending') {
    harness.result.mockImplementation((path, init) => path.endsWith('/gates')
      ? Promise.resolve(ok([{ gate_id: 'release-gate', type: 'ReleaseGate', status }]))
      : path.endsWith('/decisions') ? Promise.resolve(ok([])) : request(path, init))
    const gates = await import('../../packages/dsh-research-ui/src/client/panels/gates')
    const node = new harness.Node('main')
    await gates.renderGates(node as unknown as HTMLElement, project)
    return node
  }
  const reason = (node: InstanceType<typeof harness.Node>) => node.all('input').find(input => input.attributes['aria-label'] === 'overview.gatesReasonPlaceholder')!
  const button = (node: InstanceType<typeof harness.Node>, text: string) => node.all('button').find(button => button.textContent === text)!
  async function draft() {
    const node = await approvals()
    button(node, 'overview.gatesReason').onclick!()
    reason(node).value = '体验评估草稿（未提交）'
    reason(node).oninput!()
    return node
  }

  it('retains the actual reason input and expansion through two refreshes and a project round trip', async () => {
    await draft()
    for (let index = 0; index < 2; index++) {
      const refreshed = await approvals()
      expect(reason(refreshed).value).toBe('体验评估草稿（未提交）')
      expect(reason(refreshed).parentElement?.style.display).toBe('flex')
    }
    expect(reason(await approvals('another-project')).value).toBe('')
    expect(reason(await approvals()).value).toBe('体验评估草稿（未提交）')
  })

  it.each([false, true])('clears only a successful decision (success=%s)', async success => {
    const node = await draft()
    harness.rerender.mockClear()
    harness.result.mockResolvedValue(success ? ok({}) : { ok: false, status: 409, error: { code: 'revision_conflict' } })
    button(node, 'overview.gatesApprove').onclick!()
    await vi.waitFor(() => expect(harness.rerender).toHaveBeenCalledOnce())
    const { gateDrafts } = await import('../../packages/dsh-research-ui/src/client/gate-drafts')
    expect(gateDrafts.get('cnn', 'release-gate').reason).toBe(success ? '' : '体验评估草稿（未提交）')
  })

  it('keeps an unsubmitted draft visible when another actor has decided the gate', async () => {
    await draft()
    const decided = await approvals('cnn', 'approved')
    expect(decided.all('div').some(node => node.textContent === 'overview.gateDraftDecided')).toBe(true)
    button(decided, 'overview.gateDraftClear').onclick!()
    const { gateDrafts } = await import('../../packages/dsh-research-ui/src/client/gate-drafts')
    expect(gateDrafts.get('cnn', 'release-gate').reason).toBe('')
  })
})
