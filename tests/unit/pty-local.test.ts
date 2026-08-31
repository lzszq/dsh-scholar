/** PTY-01 real local pseudo-terminal coverage under the context contract. */
import { describe, expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LocalPtyAdapter, ResearchKernel, startKernelServer } from '@dsh-scholar/research-kernel'
import { PtyControlRequest, PtyOpenRequest } from '@dsh-scholar/research-schemas'
import type { PtyResolvedContext } from '../../packages/research-kernel/src/pty-context'
import type { PtySpawnPlan } from '../../packages/research-kernel/src/pty-session'

const probe = spawnSync('python3', ['--version'], { encoding: 'utf8', timeout: 10_000 })
const PTY_AVAILABLE = probe.error === undefined && probe.status === 0

function makeBrief() {
  return {
    problem: 'p', scope: 's', questions: [], primary_metrics: ['m'], resources: '', risks: [],
    target_outputs: ['paper'], target_venue: null, baseline_repo: null, domain: 'ml',
  }
}

function freshPtyKernel(python3 = 'python3'): { kernel: ResearchKernel; adapter: LocalPtyAdapter; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-pty-local-'))
  const kernel = new ResearchKernel({
    dbPath: join(dir, 'kernel.db'), casRoot: join(dir, 'cas'),
    requireSignedManifest: false, ptyIdleSweepMs: 0,
  })
  const adapter = new LocalPtyAdapter({
    python3,
    workspaceRoot: join(dir, 'pty-workspaces'),
    onOutput: (sessionId, frames) => { kernel.ptyAppendOutput(sessionId, frames) },
    log: () => {},
  })
  kernel.setPtyAdapter(adapter)
  return { kernel, adapter, dir }
}

function projectFixture(kernel: ResearchKernel, principal = 'pi'): {
  projectId: string
  workspaceId: string
  context: PtyResolvedContext
} {
  const project = kernel.createProject({
    name: 'p', workspace: '/w', creator_principal_id: principal,
    execution: {
      runner_profile_id: 'profile_isolated_subprocess_v1', runner_target_id: 'target_local_process_v1',
      network_policy: 'none', artifact_store: 'local-cas', fixture_id: null,
    },
    brief: makeBrief(),
  })
  const workspace = kernel.workspaceEnsure(project.project_id, 'scratch', 'scratch')
  const projected = kernel.ptyContexts(project.project_id, principal).find(item => item.context_kind === 'research')!
  return {
    projectId: project.project_id,
    workspaceId: workspace.workspace_id,
    context: kernel.ptyResolveContext(projected.context_id, principal),
  }
}

function openRequest(contextId: string, workspaceId: string, overrides: Record<string, unknown> = {}) {
  return PtyOpenRequest.parse({
    context_id: contextId, workspace_id: workspaceId, label: 'local shell',
    purpose: 'exercise the real local PTY', preset: 'bash', cwd: '.', cols: 80, rows: 24,
    ...overrides,
  })
}

function control(generation: number, seq: number, overrides: Record<string, unknown> = {}) {
  return PtyControlRequest.parse({
    expected_generation: generation, client_seq: seq, type: 'bytes',
    payload: { text: 'true\n', byte_length: 5 }, ...overrides,
  })
}

function markerCmd(marker: string): { text: string; byte_length: number } {
  const text = `echo "${marker}=$(printf ok)"\n`
  return { text, byte_length: Buffer.byteLength(text) }
}

async function waitForText(
  kernel: ResearchKernel,
  sessionId: string,
  context: PtyResolvedContext,
  generation: number,
  text: string,
  timeoutMs = 10_000,
): Promise<string[]> {
  const deadline = Date.now() + timeoutMs
  let last: string[] = []
  while (Date.now() < deadline) {
    const page = kernel.ptyFrames(sessionId, 0, context, generation)
    last = page.frames.filter(frame => frame.type === 'output')
      .map(frame => frame.type === 'output' ? frame.payload.text : '')
    if (last.join('').includes(text)) return last
    await sleep(50)
  }
  throw new Error(`timeout waiting for ${JSON.stringify(text)}; frames=${JSON.stringify(last)}`)
}

async function waitForExit(
  kernel: ResearchKernel,
  sessionId: string,
  context: PtyResolvedContext,
  generation: number,
  timeoutMs = 10_000,
): Promise<{ exit_code: number | null; signal: string | null }> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const exit = kernel.ptyFrames(sessionId, 0, context, generation).frames.find(frame => frame.type === 'exit')
    if (exit?.type === 'exit') return { exit_code: exit.payload.exit_code, signal: exit.payload.signal }
    await sleep(50)
  }
  throw new Error('timeout waiting for pty exit frame')
}

async function sleep(ms: number): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, ms))
}

describe('LocalPtyAdapter (PTY-01 real pseudo-terminal)', () => {
  it.skipIf(!PTY_AVAILABLE)('opens a real tty, writes, resizes, detaches, reconnects and closes', async () => {
    const { kernel, adapter, dir } = freshPtyKernel()
    try {
      expect(adapter.available).toBe(true)
      expect(adapter.python3Path).toBe('python3')
      expect(existsSync(join(dir, 'pty-workspaces', '.dsh-pty-runtime', 'pty-bridge.py'))).toBe(true)
      const f = projectFixture(kernel)
      const opened = kernel.ptyOpen(openRequest(f.context.context_id, f.workspaceId), { context: f.context })
      expect(opened).toMatchObject({ adapter_id: 'local-pty', state: 'open' })
      expect(opened.config_hash).toBe(kernel.configEffective(f.projectId).config_pin)
      const attached = kernel.ptyAttach(opened.pty_session_id, f.context, opened.generation)
      kernel.ptyControl(opened.pty_session_id, control(attached.generation, 1, {
        payload: { text: 'echo PTY-ROUNDTRIP-$((40+2))\n', byte_length: 30 },
      }), f.context)
      expect((await waitForText(kernel, opened.pty_session_id, f.context, attached.generation, 'PTY-ROUNDTRIP-42')).join(''))
        .toContain('PTY-ROUNDTRIP-42')
      kernel.ptyControl(opened.pty_session_id, control(attached.generation, 2, {
        type: 'resize', payload: { cols: 132, rows: 43 },
      }), f.context)
      kernel.ptyControl(opened.pty_session_id, control(attached.generation, 3, {
        payload: { text: 'stty size\n', byte_length: 10 },
      }), f.context)
      expect((await waitForText(kernel, opened.pty_session_id, f.context, attached.generation, '43 132')).join(''))
        .toContain('43 132')
      kernel.ptyControl(opened.pty_session_id, control(attached.generation, 4, {
        payload: {
          text: 'sleep 1; echo "DETACHED=$(printf ok)"\n',
          byte_length: Buffer.byteLength('sleep 1; echo "DETACHED=$(printf ok)"\n'),
        },
      }), f.context)
      const detached = kernel.ptyDetach(opened.pty_session_id, f.context, attached.generation)
      await waitForText(kernel, opened.pty_session_id, f.context, detached.generation, 'DETACHED=ok')
      const reattached = kernel.ptyAttach(opened.pty_session_id, f.context, detached.generation)
      const frames = kernel.ptyFrames(opened.pty_session_id, 0, f.context, reattached.generation).frames
      expect(new Set(frames.map(frame => frame.server_seq)).size).toBe(frames.length)
      kernel.ptyClose(opened.pty_session_id, f.context, reattached.generation)
      const deadline = Date.now() + 5_000
      while (adapter.liveSessions > 0 && Date.now() < deadline) await sleep(50)
      expect(adapter.liveSessions).toBe(0)
    } finally { kernel.close() }
  })

  it.skipIf(!PTY_AVAILABLE)('delivers INT/TERM to the foreground job and KILL to the shell', async () => {
    const { kernel } = freshPtyKernel()
    try {
      const f = projectFixture(kernel)
      const opened = kernel.ptyOpen(openRequest(f.context.context_id, f.workspaceId), { context: f.context })
      const attached = kernel.ptyAttach(opened.pty_session_id, f.context, opened.generation)
      let seq = 1
      kernel.ptyControl(opened.pty_session_id, control(attached.generation, seq++, {
        payload: { text: 'sleep 60\n', byte_length: 9 },
      }), f.context)
      await sleep(500)
      kernel.ptyControl(opened.pty_session_id, control(attached.generation, seq++, {
        type: 'signal', payload: { signal: 'INT' },
      }), f.context)
      await sleep(600)
      kernel.ptyControl(opened.pty_session_id, control(attached.generation, seq++, { payload: markerCmd('INT-SURVIVED') }), f.context)
      await waitForText(kernel, opened.pty_session_id, f.context, attached.generation, 'INT-SURVIVED=ok')
      kernel.ptyControl(opened.pty_session_id, control(attached.generation, seq++, {
        payload: { text: 'sleep 60\n', byte_length: 9 },
      }), f.context)
      await sleep(500)
      kernel.ptyControl(opened.pty_session_id, control(attached.generation, seq++, {
        type: 'signal', payload: { signal: 'TERM' },
      }), f.context)
      await sleep(600)
      kernel.ptyControl(opened.pty_session_id, control(attached.generation, seq++, { payload: markerCmd('TERM-SURVIVED') }), f.context)
      await waitForText(kernel, opened.pty_session_id, f.context, attached.generation, 'TERM-SURVIVED=ok')
      kernel.ptyControl(opened.pty_session_id, control(attached.generation, seq, {
        type: 'signal', payload: { signal: 'KILL' },
      }), f.context)
      expect((await waitForExit(kernel, opened.pty_session_id, f.context, attached.generation)).signal).toBe('SIGKILL')
      kernel.ptyClose(opened.pty_session_id, f.context, attached.generation)
    } finally { kernel.close() }
  })

  it.skipIf(!PTY_AVAILABLE)('closes the real process when idle TTL expires', async () => {
    const { kernel, adapter } = freshPtyKernel()
    try {
      const f = projectFixture(kernel)
      const opened = kernel.ptyOpen(openRequest(f.context.context_id, f.workspaceId), { context: f.context })
      const attached = kernel.ptyAttach(opened.pty_session_id, f.context, opened.generation)
      kernel.db.prepare('UPDATE pty_sessions SET idle_ttl_s = 1 WHERE pty_session_id = ?').run(opened.pty_session_id)
      kernel.ptyControl(opened.pty_session_id, control(attached.generation, 1, { payload: markerCmd('TTL') }), f.context)
      await waitForText(kernel, opened.pty_session_id, f.context, attached.generation, 'TTL=ok')
      const active = kernel.ptyGet(opened.pty_session_id, f.context, attached.generation)
      expect(kernel.ptySweepIdle(Date.parse(active.last_activity_at) + 1_500)).toContain(opened.pty_session_id)
      expect(kernel.ptyGet(opened.pty_session_id, f.context, attached.generation)).toMatchObject({ state: 'closed', close_reason: 'idle_ttl' })
      const deadline = Date.now() + 5_000
      while (adapter.liveSessions > 0 && Date.now() < deadline) await sleep(50)
      expect(adapter.liveSessions).toBe(0)
    } finally { kernel.close() }
  })

  it.skipIf(!PTY_AVAILABLE)('whitelists environment variables and redirects HOME into the workspace', async () => {
    const original = {
      kernel: process.env.DSH_SCHOLAR_KERNEL_TOKEN,
      service: process.env.DSH_SCHOLAR_SERVICE_TOKEN,
      model: process.env.OPENAI_API_KEY,
    }
    process.env.DSH_SCHOLAR_KERNEL_TOKEN = 'kernel-secret'
    process.env.DSH_SCHOLAR_SERVICE_TOKEN = 'service-secret'
    process.env.OPENAI_API_KEY = 'model-secret'
    const { kernel, adapter, dir } = freshPtyKernel()
    try {
      const f = projectFixture(kernel)
      const opened = kernel.ptyOpen(openRequest(f.context.context_id, f.workspaceId), { context: f.context })
      const attached = kernel.ptyAttach(opened.pty_session_id, f.context, opened.generation)
      const command = [
        'echo "TOKEN=[${DSH_SCHOLAR_KERNEL_TOKEN:-none}]"',
        'echo "SERVICE=[${DSH_SCHOLAR_SERVICE_TOKEN:-none}]"',
        'echo "MODEL=[${OPENAI_API_KEY:-none}]"',
        'echo "HOME=$HOME"', 'echo "TERM=$TERM"', 'echo "PATH=$(command -v ls)"',
      ].join('; ') + '\n'
      kernel.ptyControl(opened.pty_session_id, control(attached.generation, 1, {
        payload: { text: command, byte_length: Buffer.byteLength(command) },
      }), f.context)
      const output = (await waitForText(kernel, opened.pty_session_id, f.context, attached.generation, 'MODEL=[none]')).join('')
      expect(output).toContain('TOKEN=[none]')
      expect(output).toContain('SERVICE=[none]')
      expect(output).toContain(`HOME=${join(dir, 'pty-workspaces', f.workspaceId)}`)
      expect(output).not.toContain('/home/')
      expect(output).toContain('TERM=xterm-256color')
      expect(adapter.workspaceRoot).toBe(join(dir, 'pty-workspaces'))
      kernel.ptyClose(opened.pty_session_id, f.context, attached.generation)
    } finally {
      if (original.kernel === undefined) delete process.env.DSH_SCHOLAR_KERNEL_TOKEN
      else process.env.DSH_SCHOLAR_KERNEL_TOKEN = original.kernel
      if (original.service === undefined) delete process.env.DSH_SCHOLAR_SERVICE_TOKEN
      else process.env.DSH_SCHOLAR_SERVICE_TOKEN = original.service
      if (original.model === undefined) delete process.env.OPENAI_API_KEY
      else process.env.OPENAI_API_KEY = original.model
      kernel.close()
    }
  })

  it.skipIf(!PTY_AVAILABLE)('rejects escaped cwd, unknown presets and an unavailable bridge without fallback', () => {
    const first = freshPtyKernel()
    try {
      const f = projectFixture(first.kernel)
      const plan: PtySpawnPlan = {
        pty_session_id: 'pty_bad_cwd', project_id: f.projectId, workspace_id: f.workspaceId,
        preset: 'bash', cwd: '../../../etc', cols: 80, rows: 24,
        profile: 'profile_isolated_subprocess_v1', target: 'target_local_process_v1',
        config_hash: first.kernel.configPinHash, lease_token: 'lease_x',
      }
      expect(first.adapter.spawn(plan).ok).toBe(false)
      expect(first.adapter.spawn({ ...plan, cwd: '.', preset: 'powershell' as never }).ok).toBe(false)
      expect(() => first.kernel.ptyOpen(openRequest(f.context.context_id, f.workspaceId, { cwd: '/etc' }), { context: f.context }))
        .toThrowError(expect.objectContaining({ code: 'pty_open_invalid' }))
    } finally { first.kernel.close() }

    const dead = freshPtyKernel('/nonexistent/python3')
    try {
      const f = projectFixture(dead.kernel)
      expect(() => dead.kernel.ptyOpen(openRequest(f.context.context_id, f.workspaceId), { context: f.context }))
        .toThrowError(expect.objectContaining({ code: 'pty_adapter_failed' }))
      expect(dead.kernel.ptyListContext(f.context).sessions[0]).toMatchObject({ close_reason: 'adapter_failed' })
    } finally { dead.kernel.close() }
  })

  it.skipIf(!PTY_AVAILABLE)('keeps real PTY traffic outside formal evidence tables', async () => {
    const { kernel } = freshPtyKernel()
    try {
      const f = projectFixture(kernel)
      const opened = kernel.ptyOpen(openRequest(f.context.context_id, f.workspaceId), { context: f.context })
      const attached = kernel.ptyAttach(opened.pty_session_id, f.context, opened.generation)
      kernel.ptyControl(opened.pty_session_id, control(attached.generation, 1, { payload: markerCmd('METRIC-0.99') }), f.context)
      await waitForText(kernel, opened.pty_session_id, f.context, attached.generation, 'METRIC-0.99=ok')
      kernel.ptyControl(opened.pty_session_id, control(attached.generation, 2, { type: 'close', payload: {} }), f.context)
      expect(kernel.listJobs(f.projectId)).toHaveLength(0)
      expect(kernel.listRuns(f.projectId)).toHaveLength(0)
      expect(kernel.listEvidence(f.projectId)).toHaveLength(0)
      expect(kernel.listClaims(f.projectId)).toHaveLength(0)
      expect(kernel.listGates(f.projectId)).toHaveLength(0)
      expect(kernel.listArtifacts(f.projectId)).toHaveLength(0)
      expect((kernel.db.prepare('SELECT COUNT(*) AS n FROM terminal_frames').get() as { n: number }).n).toBe(0)
      expect((kernel.db.prepare('SELECT COUNT(*) AS n FROM pty_frames').get() as { n: number }).n).toBeGreaterThan(0)
    } finally { kernel.close() }
  })

  it.skipIf(!PTY_AVAILABLE)('serves real PTY open/control/frames over current HTTP fencing', async () => {
    const { kernel } = freshPtyKernel()
    const f = projectFixture(kernel, 'pi-1')
    const { server, url } = await startKernelServer({ kernel, host: '127.0.0.1', port: 0 })
    const post = (value: Record<string, unknown>, headers: Record<string, string> = {}) => ({
      method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(value),
    })
    const request = openRequest(f.context.context_id, f.workspaceId)
    try {
      const noPrincipal = await fetch(`${url}/v1/pty/sessions`, post(request))
      expect(noPrincipal.status).toBe(422)
      expect(((await noPrincipal.json()) as { error: { code: string } }).error.code).toBe('principal_required')
      const nonMember = await fetch(`${url}/v1/pty/sessions`, post(request, { 'x-principal-id': 'outsider' }))
      expect(nonMember.status).toBe(404)
      const openedResponse = await fetch(`${url}/v1/pty/sessions`, post(request, { 'x-principal-id': 'pi-1' }))
      expect(openedResponse.status).toBe(201)
      const opened = await openedResponse.json() as {
        pty_session_id: string; principal_id: string; adapter_id: string; generation: number; lease_token: string
      }
      const leaseHeaders = { 'x-principal-id': 'pi-1', 'x-pty-lease': opened.lease_token }
      const attachedResponse = await fetch(`${url}/v1/pty/sessions/${opened.pty_session_id}/attach`, post(
        { expected_generation: opened.generation }, leaseHeaders,
      ))
      expect(attachedResponse.status).toBe(200)
      const attached = await attachedResponse.json() as { generation: number }
      const wrongOwner = await fetch(`${url}/v1/pty/sessions/${opened.pty_session_id}/control`, post(
        control(attached.generation, 1), { 'x-principal-id': 'outsider', 'x-pty-lease': opened.lease_token },
      ))
      expect(wrongOwner.status).toBe(403)
      const command = markerCmd('HTTP-PTY')
      const controlled = await fetch(`${url}/v1/pty/sessions/${opened.pty_session_id}/control`, post(
        control(attached.generation, 1, { payload: command }), leaseHeaders,
      ))
      expect(controlled.status).toBe(200)
      expect(((await controlled.json()) as { delivered: boolean }).delivered).toBe(true)
      const deadline = Date.now() + 10_000
      let text = ''
      while (Date.now() < deadline) {
        const response = await fetch(
          `${url}/v1/pty/sessions/${opened.pty_session_id}/frames?after_seq=0&expected_generation=${attached.generation}`,
          { headers: leaseHeaders },
        )
        const page = await response.json() as { frames: Array<{ type: string; payload: { text?: string } }> }
        text = page.frames.filter(frame => frame.type === 'output').map(frame => frame.payload.text ?? '').join('')
        if (text.includes('HTTP-PTY=ok')) break
        await sleep(50)
      }
      expect(text).toContain('HTTP-PTY=ok')
      const close = await fetch(`${url}/v1/pty/sessions/${opened.pty_session_id}/control`, post(
        control(attached.generation, 2, { type: 'close', payload: {} }), leaseHeaders,
      ))
      expect(close.status).toBe(200)
      const after = await fetch(
        `${url}/v1/pty/sessions/${opened.pty_session_id}?expected_generation=${attached.generation}`,
        { headers: leaseHeaders },
      )
      expect((await after.json() as { state: string }).state).toBe('closed')
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()))
      kernel.close()
    }
  })
})
