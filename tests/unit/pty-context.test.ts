import { describe, expect, it } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  PtyAttachRequest,
  PtyContextKind,
  PtyContextSessions,
  PtyControlRequest,
  PtyFramesRequest,
  PtyOpenRequest,
} from '../../packages/research-schemas/src/pty'
import {
  PtyContextError,
  resolvePtyContext,
  type PtyContextAuthoritySource,
} from '../../packages/research-kernel/src/pty-context'
import {
  PtyError,
  PtySessionStore,
  type PtyAdapter,
} from '../../packages/research-kernel/src/pty-session'
import { ResearchKernel } from '../../packages/research-kernel/src/kernel'
import { startKernelServer } from '../../packages/research-kernel/src/server'

const sha = `sha256:${'a'.repeat(64)}`

function source(overrides: Partial<PtyContextAuthoritySource> = {}): PtyContextAuthoritySource {
  return {
    context_kind: 'chat',
    context_id: 'chat_01',
    project_id: 'rsp_01',
    owner_principal_id: 'human_01',
    tenant_id: 'tenant_01',
    parent_session_id: 'research_01',
    runner_profile_id: 'profile_docker_gpu',
    runner_target_id: 'target_gpu_01',
    target_kind: 'local-docker',
    target_available: true,
    target_supports_pty: true,
    ...overrides,
  }
}

function openRequest(overrides: Record<string, unknown> = {}) {
  return PtyOpenRequest.parse({
    context_id: 'chat_01',
    workspace_id: 'ws_01',
    label: 'training shell',
    purpose: 'inspect the active experiment',
    preset: 'bash',
    cwd: '.',
    cols: 100,
    rows: 32,
    ...overrides,
  })
}

function store(): PtySessionStore {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-pty-context-'))
  return new PtySessionStore(join(dir, 'pty.db'))
}

describe('REVIEW-PTY-CONTEXT-03 wire contract', () => {
  it('exposes only the canonical Research, Chat and Subagent context kinds', () => {
    expect(PtyContextKind.options).toEqual(['research', 'chat', 'subagent'])
    expect(PtyContextKind.safeParse('operator').success).toBe(false)
  })

  it('open accepts one opaque context id and rejects client-forged project, owner, parent, profile and target', () => {
    expect(openRequest().context_id).toBe('chat_01')
    for (const forged of [
      { project_id: 'rsp_evil' },
      { principal_id: 'evil' },
      { parent_session_id: 'evil' },
      { profile: 'local' },
      { target: 'local' },
    ]) {
      expect(() => openRequest(forged)).toThrow()
    }
  })

  it('every attach/control/frame operation carries an exact expected generation', () => {
    expect(PtyAttachRequest.parse({ expected_generation: 3 })).toEqual({ expected_generation: 3 })
    expect(PtyFramesRequest.parse({ after_seq: 7, expected_generation: 3 })).toEqual({ after_seq: 7, expected_generation: 3 })
    expect(PtyControlRequest.parse({
      expected_generation: 3,
      client_seq: 1,
      type: 'bytes',
      payload: { text: 'x', byte_length: 1 },
    }).expected_generation).toBe(3)
    expect(() => PtyAttachRequest.parse({})).toThrow()
    expect(() => PtyFramesRequest.parse({ after_seq: 0 })).toThrow()
  })
})

describe('REVIEW-PTY-CONTEXT-03 trusted context resolution', () => {
  it('derives project, owner, exact parent and execution target from server authority', () => {
    expect(resolvePtyContext('chat_01', source())).toEqual({
      context_kind: 'chat',
      context_id: 'chat_01',
      project_id: 'rsp_01',
      principal_id: 'human_01',
      tenant_id: 'tenant_01',
      parent_session_id: 'research_01',
      profile: 'profile_docker_gpu',
      target: 'target_gpu_01',
      target_kind: 'local-docker',
    })
    expect(() => resolvePtyContext('chat_other', source())).toThrowError(PtyContextError)
  })

  it('fails closed for offline or PTY-incompatible remote targets without local fallback', () => {
    for (const authority of [
      source({ target_kind: 'remote-ssh', target_available: false }),
      source({ target_kind: 'remote-ssh', target_supports_pty: false }),
    ]) {
      try {
        resolvePtyContext('chat_01', authority)
        throw new Error('expected resolution to fail')
      } catch (error) {
        expect(error).toBeInstanceOf(PtyContextError)
        expect((error as PtyContextError).code).toMatch(/^pty_target_(unavailable|unsupported)$/)
      }
    }
  })
})

describe('REVIEW-PTY-CONTEXT-03 context-bound session store', () => {
  it('discovers an owned session by principal only and returns its project for durable authority lookup', () => {
    const pty = store()
    const authority = resolvePtyContext('chat_01', source())
    const session = pty.createContextSession(openRequest(), authority, { config_hash: sha })

    expect(pty.contextForOwner(session.pty_session_id, { principal_id: 'human_01' })).toEqual({
      project_id: 'rsp_01',
      context_kind: 'chat',
      context_id: 'chat_01',
      parent_session_id: 'research_01',
    })
    expect(() => pty.contextForOwner(session.pty_session_id, { principal_id: 'other' }))
      .toThrowError(expect.objectContaining({ code: 'pty_principal_mismatch' }))
    pty.close()
  })

  it('stores multiple labelled sessions per context and returns a deterministic active hint', () => {
    const pty = store()
    const authority = resolvePtyContext('chat_01', source())
    const first = pty.createContextSession(openRequest({ label: 'one' }), authority, { config_hash: sha })
    const second = pty.createContextSession(openRequest({ label: 'two' }), authority, { config_hash: sha })

    expect(first.context_kind).toBe('chat')
    expect(first.context_id).toBe('chat_01')
    expect(first.parent_session_id).toBe('research_01')
    expect(first.profile).toBe('profile_docker_gpu')
    expect(first.target).toBe('target_gpu_01')
    expect(second.pty_session_id).not.toBe(first.pty_session_id)

    const listed = PtyContextSessions.parse(pty.listContextSessions(authority))
    expect(listed.sessions.map(session => session.label)).toEqual(['two', 'one'])
    expect(listed.active_hint).toBe(second.pty_session_id)
    pty.close()
  })

  it('rejects stale generation, cross-context and wrong exact-parent capabilities before control', () => {
    const pty = store()
    const authority = resolvePtyContext('chat_01', source())
    const session = pty.createContextSession(openRequest(), authority, { config_hash: sha })
    const frame = {
      expected_generation: session.generation,
      client_seq: 1,
      type: 'bytes' as const,
      payload: { text: 'x', byte_length: 1 },
    }

    expect(() => pty.applyContextControl(session.pty_session_id, { ...frame, expected_generation: 99 }, authority, null))
      .toThrowError(expect.objectContaining({ code: 'pty_generation_stale' }))
    expect(() => pty.applyContextControl(session.pty_session_id, frame, { ...authority, context_id: 'chat_other' }, null))
      .toThrowError(expect.objectContaining({ code: 'pty_context_mismatch' }))
    expect(() => pty.applyContextControl(session.pty_session_id, frame, { ...authority, parent_session_id: 'research_other' }, null))
      .toThrowError(expect.objectContaining({ code: 'pty_exact_parent_mismatch' }))
    expect(pty.getSession(session.pty_session_id).last_client_seq).toBe(0)
    pty.close()
  })

  it('requires the current generation for attach, detach, frames and close', () => {
    const pty = store()
    const authority = resolvePtyContext('chat_01', source())
    const opened = pty.createContextSession(openRequest(), authority, { config_hash: sha })
    const attached = pty.attachContext(opened.pty_session_id, authority, opened.generation)
    expect(attached.generation).toBe(2)
    expect(() => pty.framesContext(opened.pty_session_id, 0, authority, opened.generation))
      .toThrowError(expect.objectContaining({ code: 'pty_generation_stale' }))
    const detached = pty.detachContext(opened.pty_session_id, authority, attached.generation)
    expect(detached.generation).toBe(3)
    expect(pty.framesContext(opened.pty_session_id, 0, authority, detached.generation).frames).toEqual([])
    expect(() => pty.closeContext(opened.pty_session_id, authority, attached.generation))
      .toThrowError(expect.objectContaining({ code: 'pty_generation_stale' }))
    expect(pty.closeContext(opened.pty_session_id, authority, detached.generation).state).toBe('closed')
    pty.close()
  })
})

function authorityKernel(): { kernel: ResearchKernel; projectId: string; workspaceId: string } {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-pty-authority-'))
  const kernel = new ResearchKernel({ dbPath: join(dir, 'kernel.db'), casRoot: join(dir, 'cas'), ptySweepIntervalMs: 0 })
  const project = kernel.createProject({
    name: 'PTY authority',
    workspace: '/research/pty-authority',
    creator_principal_id: 'human_01',
    creator_tenant_id: 'tenant_01',
    execution: {
      runner_profile_id: 'profile_isolated_subprocess_v1',
      runner_target_id: 'target_local_process_v1',
      network_policy: 'none',
      artifact_store: 'local-cas',
      fixture_id: null,
    },
    brief: {
      problem: 'exercise trusted PTY contexts', scope: 'test', questions: [], primary_metrics: [], resources: '', risks: [],
      target_outputs: ['conference-paper'], target_venue: null, baseline_repo: null, domain: 'machine-learning',
    },
  })
  kernel.linkSession('chat_01', project.project_id, {
    principal_id: 'human_01', tenant_id: 'tenant_01', issuer: 'dsh-plugin',
  })
  kernel.registerChildLink({
    child_id: 'child_01', project_id: project.project_id, parent_id: 'chat_01',
    label: 'survey', kind: 'subagent', mode: 'continuable', state: 'running',
  })
  const workspace = kernel.workspaceEnsure(project.project_id, 'code', 'code')
  const adapter: PtyAdapter = {
    id: 'local-pty',
    spawn: () => ({ ok: true }),
    write: () => {}, resize: () => {}, signal: () => {}, kill: () => {},
  }
  kernel.setPtyAdapter(adapter)
  return { kernel, projectId: project.project_id, workspaceId: workspace.workspace_id }
}

describe('REVIEW-PTY-CONTEXT-03 durable authority and HTTP lifecycle', () => {
  it('projects principal-scoped Research, durable Chat and exact-parent Subagent contexts', () => {
    const { kernel, projectId } = authorityKernel()
    try {
      const contexts = kernel.ptyContexts(projectId, 'human_01')
      expect(contexts.map(context => context.context_kind)).toEqual(['research', 'chat', 'subagent'])
      expect(contexts.find(context => context.context_kind === 'chat')?.context_id).toBe('chat_01')
      expect(contexts.find(context => context.context_kind === 'subagent')).toMatchObject({
        context_id: 'child_01', parent_session_id: 'chat_01', project_id: projectId,
      })
      expect(() => kernel.ptyContexts(projectId, 'outsider')).toThrowError(expect.objectContaining({ code: 'pty_context_not_found' }))

      kernel.db.prepare(`INSERT INTO session_links
        (session_id, project_id, linked_at, principal_id, tenant_id, issuer) VALUES (?, ?, ?, NULL, NULL, NULL)`)
        .run('old_unowned_link', projectId, new Date().toISOString())
      expect(kernel.ptyContexts(projectId, 'human_01').some(context => context.context_id === 'old_unowned_link')).toBe(false)
    } finally {
      kernel.close()
    }
  })

  it('serves context list/open/attach/read/frames/detach/close with lease and generation fencing', async () => {
    const { kernel, projectId, workspaceId } = authorityKernel()
    const { server, url } = await startKernelServer({ kernel, port: 0 })
    const owner = { 'x-principal-id': 'human_01' }
    try {
      const contextsResponse = await fetch(`${url}/v1/pty/contexts?project_id=${encodeURIComponent(projectId)}`, { headers: owner })
      expect(contextsResponse.status).toBe(200)
      const contexts = await contextsResponse.json() as Array<{ context_id: string; context_kind: string }>
      const chat = contexts.find(context => context.context_kind === 'chat')!

      const openedResponse = await fetch(`${url}/v1/pty/sessions`, {
        method: 'POST', headers: { ...owner, 'content-type': 'application/json' },
        body: JSON.stringify({ context_id: chat.context_id, workspace_id: workspaceId, label: 'one', purpose: 'test', preset: 'bash', cwd: '.', cols: 80, rows: 24 }),
      })
      expect(openedResponse.status).toBe(201)
      const opened = await openedResponse.json() as { pty_session_id: string; generation: number; lease_token: string }
      const leaseHeaders = { ...owner, 'content-type': 'application/json', 'x-pty-lease': opened.lease_token }

      expect((await fetch(`${url}/v1/pty/sessions/${opened.pty_session_id}`, { headers: { ...owner, 'x-pty-lease': opened.lease_token } })).status).toBe(422)
      const attachedResponse = await fetch(`${url}/v1/pty/sessions/${opened.pty_session_id}/attach`, {
        method: 'POST', headers: leaseHeaders, body: JSON.stringify({ expected_generation: opened.generation }),
      })
      expect(attachedResponse.status).toBe(200)
      const attached = await attachedResponse.json() as { generation: number }
      expect(attached.generation).toBe(opened.generation + 1)

      expect((await fetch(`${url}/v1/pty/sessions/${opened.pty_session_id}/frames?after_seq=0&expected_generation=${opened.generation}`, {
        headers: { ...owner, 'x-pty-lease': opened.lease_token },
      })).status).toBe(409)
      expect((await fetch(`${url}/v1/pty/sessions/${opened.pty_session_id}/frames?after_seq=0&expected_generation=${attached.generation}`, {
        headers: { ...owner, 'x-pty-lease': opened.lease_token },
      })).status).toBe(200)

      const listed = await fetch(`${url}/v1/pty/contexts/${encodeURIComponent(chat.context_id)}/sessions`, { headers: owner })
      expect(listed.status).toBe(200)
      expect((await listed.json() as { sessions: unknown[] }).sessions).toHaveLength(1)

      const detachedResponse = await fetch(`${url}/v1/pty/sessions/${opened.pty_session_id}/detach`, {
        method: 'POST', headers: leaseHeaders, body: JSON.stringify({ expected_generation: attached.generation }),
      })
      const detached = await detachedResponse.json() as { generation: number }
      expect(detachedResponse.status).toBe(200)
      const closed = await fetch(`${url}/v1/pty/sessions/${opened.pty_session_id}`, {
        method: 'DELETE', headers: leaseHeaders, body: JSON.stringify({ expected_generation: detached.generation }),
      })
      expect(closed.status).toBe(200)
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()))
      kernel.close()
    }
  })

  it('lets read-only members discover contexts but rejects terminal_write before spawning a PTY', async () => {
    const { kernel, projectId, workspaceId } = authorityKernel()
    kernel.addProjectMember({
      project_id: projectId,
      principal_id: 'viewer_01',
      tenant_id: 'tenant_01',
      role: 'viewer',
      actor: 'human_01',
    })
    const { server, url } = await startKernelServer({ kernel, port: 0 })
    const viewer = { 'x-principal-id': 'viewer_01' }
    try {
      const contextsResponse = await fetch(`${url}/v1/pty/contexts?project_id=${encodeURIComponent(projectId)}`, { headers: viewer })
      expect(contextsResponse.status).toBe(200)
      const contexts = await contextsResponse.json() as Array<{ context_id: string; context_kind: string }>
      const research = contexts.find(context => context.context_kind === 'research')!
      const before = kernel.db.prepare('SELECT COUNT(*) AS n FROM pty_sessions').get() as { n: number }
      const opened = await fetch(`${url}/v1/pty/sessions`, {
        method: 'POST', headers: { ...viewer, 'content-type': 'application/json' },
        body: JSON.stringify({ context_id: research.context_id, workspace_id: workspaceId, label: 'forbidden', purpose: 'test', preset: 'bash', cwd: '.' }),
      })
      expect(opened.status).toBe(403)
      expect((await opened.json() as { error: { code: string } }).error.code).toBe('role_forbidden')
      const after = kernel.db.prepare('SELECT COUNT(*) AS n FROM pty_sessions').get() as { n: number }
      expect(after.n).toBe(before.n)
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()))
      kernel.close()
    }
  })
})
