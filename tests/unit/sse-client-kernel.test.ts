/**
 * SSE-01/PTY-01/WORK-01/TRAJ-01 client ↔ kernel integration (client
 * logic layer over the REAL SSE endpoints — the join between the mock-
 * streamed unit suites and the server-side sse-streams.test.ts wire
 * tests):
 *
 *   PtyClientModel + SseClient   over GET /v1/pty/sessions/{id}/frames/stream
 *   WorkspaceWatchClient         over GET /v1/projects/{id}/workspaces/{wid}/watch/stream
 *   TrajectoryStreamClient       over GET /v1/projects/{id}/trajectory/stream
 *
 * The clients use their injected fetch transports against a real kernel
 * HTTP server (startKernelServer); the after_seq/after_revision cursors,
 * event names and payload shapes are exercised exactly as the server
 * emits them. This is the contract-fidelity check for the client SSE
 * consumption (轮询回退 is covered by the mock suites).
 */
import { describe, expect, it } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ResearchKernel } from '../../packages/research-kernel/src/kernel'
import type { PtyAdapter } from '../../packages/research-kernel/src/pty-session'
import { startKernelServer } from '../../packages/research-kernel/src/server'
import { PtyClientModel, type PtyResult, type PtySessionWire } from '../../packages/dsh-research-ui/src/client/pty-session-model'
import { WorkspaceWatchClient, applyWorkspaceListSince, initialWorkspaceTreeState } from '../../packages/dsh-research-ui/src/client/workspace-model'
import { TrajectoryStreamClient, applyTrajectoryStreamEntries, initialTrajectoryPageState } from '../../packages/dsh-research-ui/src/client/trajectory-model'
import type { WorkspaceListSincePayload } from '../../packages/dsh-research-ui/src/client/types'
import type { SseFetch } from '../../packages/dsh-research-ui/src/client/sse-client'

function freshKernel(): ResearchKernel {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-sse-client-kernel-'))
  return new ResearchKernel({ dbPath: join(dir, 'kernel.db'), casRoot: join(dir, 'cas'), requireSignedManifest: false })
}

function makeBrief(): Record<string, unknown> {
  return {
    problem: 'p', scope: 's', questions: [], primary_metrics: ['m'],
    resources: '', risks: [], target_outputs: ['paper'], target_venue: null,
    baseline_repo: null, domain: 'ml',
  }
}

/** A real fetch wrapper shaped as the client SseFetch (kernel auth via
 *  x-principal-id; the client passes RELATIVE urls). */
function sseFetch(base: string, principal: string): SseFetch {
  return async (url, init) => {
    const response = await fetch(`${base}${url}`, {
      ...init,
      headers: { ...(init.headers ?? {}), 'x-principal-id': principal },
    })
    return { ok: response.ok, status: response.status, body: response.body }
  }
}

const flush = (): Promise<void> => new Promise(resolve => { setTimeout(resolve, 0) })

/** Wait (real time) until a predicate on the model holds. */
async function until(fn: () => boolean, timeoutMs = 6000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (fn()) return
    if (Date.now() >= deadline) throw new Error('client integration timeout')
    await new Promise(resolve => setTimeout(resolve, 50))
  }
}

describe('SSE-01 client ↔ kernel integration (real SSE endpoints)', () => {
  it('PTY: PtyClientModel consumes the real frames/stream (live tail + exit end)', async () => {
    const kernel = freshKernel()
    const adapter: PtyAdapter = {
      id: 'local-pty',
      spawn: () => ({ ok: true }),
      write: () => {}, resize: () => {}, signal: () => {}, kill: () => {},
    }
    kernel.setPtyAdapter(adapter)
    const project = kernel.createProject({
      name: 'p', workspace: '/w', brief: makeBrief(), creator_principal_id: 'pi-1',
      execution: {
        runner_profile_id: 'profile_isolated_subprocess_v1',
        runner_target_id: 'target_local_process_v1',
        network_policy: 'none', artifact_store: 'local-cas', fixture_id: null,
      },
    } as never)
    const ws = kernel.workspaceEnsure(project.project_id, 'scratch', 's')
    const contextProjection = kernel.ptyContexts(project.project_id, 'pi-1')
      .find(candidate => candidate.context_kind === 'research')!
    const context = kernel.ptyResolveContext(contextProjection.context_id, 'pi-1')
    // A fresh kernel has no PTY adapter (HTTP open → 501); open the session
    // via the kernel API and let the model's transport serve that row — the
    // FRAMES STREAM (the part under test) is the real HTTP route.
    const session = kernel.ptyOpen({
      context_id: context.context_id,
      workspace_id: ws.workspace_id,
      label: 'SSE client shell',
      purpose: 'exercise the browser stream client',
      preset: 'bash',
      cwd: '.',
      cols: 80,
      rows: 24,
    }, { context })
    const { server, url } = await startKernelServer({ kernel, port: 0 })
    try {
      const base = url.replace(/\/$/, '')
      const fetchImpl = sseFetch(base, 'pi-1')
      const transport = {
        open: async (): Promise<PtyResult<PtySessionWire>> => ({ ok: true, data: session }),
        attach: async (sessionId: string, _lease: string, expectedGeneration: number): Promise<PtyResult<PtySessionWire>> => ({
          ok: true,
          data: kernel.ptyAttach(sessionId, context, expectedGeneration),
        }),
        detach: async (sessionId: string, _lease: string, expectedGeneration: number): Promise<PtyResult<PtySessionWire>> => ({
          ok: true,
          data: kernel.ptyDetach(sessionId, context, expectedGeneration),
        }),
        close: async (sessionId: string, _lease: string, expectedGeneration: number): Promise<PtyResult<PtySessionWire>> => ({
          ok: true,
          data: kernel.ptyClose(sessionId, context, expectedGeneration),
        }),
        getSession: async (sessionId: string, lease: string, expectedGeneration: number): Promise<PtyResult<PtySessionWire>> => {
          const response = await fetch(`${base}/v1/pty/sessions/${sessionId}?expected_generation=${expectedGeneration}`, {
            headers: { 'x-principal-id': 'pi-1', 'x-pty-lease': lease },
          })
          return response.ok ? { ok: true, data: await response.json() as PtySessionWire } : { ok: false, error: { code: 'http_error', status: response.status } }
        },
        control: async (): Promise<PtyResult<{ delivered?: boolean }>> => ({ ok: true, data: {} }),
        frames: async (): Promise<PtyResult<never>> => ({ ok: false, error: { code: 'http_error', status: 0 } }),
      }
      const model = new PtyClientModel({
        transport: transport as never,
        stream: { fetch: fetchImpl, maxReconnectAttempts: 2 },
        sessionRefreshEvery: 0,
      })
      const ok = await model.open({
        context_id: context.context_id,
        workspace_id: ws.workspace_id,
        label: 'SSE client shell',
        purpose: 'exercise the browser stream client',
        preset: 'bash',
        cwd: '.',
        cols: 80,
        rows: 24,
      })
      expect(ok).toBe(true)
      expect(model.framesMode).toBe('sse')
      await until(() => model.streamStatus === 'live')
      // live tail: append output while the client streams
      kernel.ptyAppendOutput(model.sessionId!, [
        { type: 'output', text: 'live-one\n', byte_length: 9 },
        { type: 'output', text: 'live-two\n', byte_length: 9 },
      ])
      await until(() => model.serverSeq >= 2)
      expect(model.display.map(e => e.text)).toEqual(['live-one\n', 'live-two\n'])
      // exit frame ends the stream server-side; the client reconnects
      // harmlessly and the cursor stays put
      kernel.ptyAppendOutput(model.sessionId!, [{ type: 'exit', exit_code: 0, signal: null }])
      await until(() => model.exitCode === 0)
      expect(model.serverSeq).toBe(3)
      model.dispose()
    } finally {
      server.close()
      kernel.close()
    }
  })

  it('WORK-01: WorkspaceWatchClient consumes the real watch/stream (change/delete per node)', async () => {
    const kernel = freshKernel()
    const project = kernel.createProject({ name: 'p', workspace: '/w', brief: makeBrief(), creator_principal_id: 'pi-1' } as never)
    const ws = kernel.workspaceEnsure(project.project_id, 'scratch', 's')
    const { server, url } = await startKernelServer({ kernel, port: 0 })
    try {
      const base = url.replace(/\/$/, '')
      const feeds: WorkspaceListSincePayload[] = []
      let tree = initialWorkspaceTreeState(ws.workspace_id)
      const client = new WorkspaceWatchClient({
        projectId: project.project_id,
        target: () => ({ workspaceId: ws.workspace_id, revision: tree.info?.revision ?? 0 }),
        fetchImpl: sseFetch(base, 'pi-1'),
        maxReconnectAttempts: 2,
        onFeed: (payload) => {
          feeds.push(payload)
          tree = applyWorkspaceListSince(tree, payload)
        },
      })
      client.start()
      await until(() => client.status === 'live')
      // real mutations on the kernel side
      kernel.workspaceWrite(ws.workspace_id, 'a.txt', 'hello', { principal: { principal_id: 'pi-1' } } as never)
      kernel.workspaceWrite(ws.workspace_id, 'dir/b.txt', 'world', { principal: { principal_id: 'pi-1' } } as never)
      await until(() => tree.nodes.some(n => n.path === 'dir/b.txt'))
      expect(tree.nodes.map(n => n.path)).toEqual(['a.txt', 'dir', 'dir/b.txt'])
      expect(tree.info!.revision).toBeGreaterThanOrEqual(2)
      // delete tombstone via the stream
      kernel.workspaceDelete(ws.workspace_id, 'a.txt', { principal: { principal_id: 'pi-1' } } as never)
      await until(() => !tree.nodes.some(n => n.path === 'a.txt'))
      expect(feeds.some(f => f.deleted.includes('a.txt'))).toBe(true)
      client.stop()
    } finally {
      server.close()
      kernel.close()
    }
  })

  it('TRAJ-01: TrajectoryStreamClient consumes the real trajectory/stream (lane-filtered entries)', async () => {
    const kernel = freshKernel()
    const project = kernel.createProject({ name: 'p', workspace: '/w', brief: makeBrief(), creator_principal_id: 'pi-1' } as never)
    const { server, url } = await startKernelServer({ kernel, port: 0 })
    try {
      const base = url.replace(/\/$/, '')
      // seed two lane-scoped events before connecting
      kernel.emit(project.project_id, 'job.submitted', { project_id: project.project_id, job_id: 'job_1', kind: 'echo' })
      kernel.emit(project.project_id, 'session.linked', { project_id: project.project_id, session_id: 'sess_1' })
      let research = initialTrajectoryPageState()
      const client = new TrajectoryStreamClient({
        projectId: project.project_id,
        lane: 'research',
        afterSeq: () => research.entries.at(-1)?.event_seq ?? 0,
        fetchImpl: sseFetch(base, 'pi-1'),
        maxReconnectAttempts: 2,
        onEntries: (entries) => { research = applyTrajectoryStreamEntries(research, entries) },
      })
      client.start()
      await until(() => client.status === 'live')
      // replay: the seeded research entry arrives, the session entry is
      // lane-filtered server-side
      await until(() => research.entries.length >= 1)
      expect(research.entries.every(e => e.lane === 'research')).toBe(true)
      expect(research.entries.map(e => e.kind)).toContain('job.submitted')
      // live tail: a new research entry while the stream is open
      kernel.emit(project.project_id, 'job.updated', { project_id: project.project_id, job_id: 'job_1', state: 'running' })
      await until(() => research.entries.some(e => e.kind === 'job.updated'))
      expect(research.entries.map(e => e.kind)).toContain('job.updated')
      client.stop()
    } finally {
      server.close()
      kernel.close()
    }
  })
})
