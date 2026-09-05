import { afterEach, describe, expect, it, vi } from 'vitest'
import { createHash, generateKeyPairSync } from 'node:crypto'
import { createServer } from 'node:http'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ResearchKernel, startKernelServer } from '@dsh-scholar/research-kernel'
import { ResearchClient } from '@dsh-scholar/research-client'
import { RunnerTargetCreateInput, type AgentClaim, type JobArtifactCreateInput } from '@dsh-scholar/research-schemas'
import {
  buildAgentRegistration, createFleetServer, createRemoteRunnerAgent, defaultSubprocessExecutor,
  HttpRemoteFleetTransport, RemoteWireError, startFleetServer, type RemoteRunnerAgentImpl,
} from '@dsh-scholar/runner-gateway'

const cleanups: Array<() => Promise<void> | void> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
  vi.restoreAllMocks()
})
const pause = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))
async function until(predicate: () => boolean, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('condition timed out')
    await pause(10)
  }
}

async function fixture(options: { leaseTtlSeconds?: number; offlineAfterMs?: number } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'dsh-remote-kernel-'))
  cleanups.push(() => rmSync(root, { recursive: true, force: true }))
  const secretRoot = join(root, 'secrets')
  mkdirSync(join(secretRoot, 'runner'), { recursive: true })
  const targetToken = 'test-target-a-identity-0000000000001'
  const otherToken = 'test-target-b-identity-0000000000002'
  for (const [name, value] of Object.entries({ 'a.token': targetToken, 'b.token': otherToken, endpoint: '{"host":"lab.example","port":22,"user":"runner"}', key: 'test-private-key', known_hosts: 'test-host-key' })) {
    writeFileSync(join(secretRoot, 'runner', name), value, { mode: 0o600 })
  }
  const kernel = new ResearchKernel({ dbPath: join(root, 'kernel.db'), casRoot: join(root, 'cas'), secretRoot, serviceToken: 'test-service', requireSignedManifest: false })
  cleanups.push(() => kernel.close())
  for (const name of ['a', 'b']) {
    kernel.registerRunnerTarget(RunnerTargetCreateInput.parse({
      target_id: `remote-${name}`, display_name: `Remote ${name}`, kind: 'remote-ssh', capabilities: ['linux', 'amd64', 'docker'],
      service_identity: { scheme: 'file', name: `runner/${name}.token` },
      connection: {
        endpoint: { scheme: 'file', name: 'runner/endpoint' }, credential: { scheme: 'file', name: 'runner/key' },
        known_hosts: { scheme: 'file', name: 'runner/known_hosts' },
      },
    }), 'test-operator')
  }
  const project = kernel.createProject({
    name: 'remote regression', workspace: join(root, 'project'),
    brief: { problem: 'p', scope: 's', questions: [], primary_metrics: ['m'], resources: '', risks: [], target_outputs: ['paper'], target_venue: null, baseline_repo: null, domain: 'ml' },
    execution: { runner_profile_id: 'profile_local_docker_cpu_v1', runner_target_id: 'remote-a' },
  })
  const http = await startKernelServer({ kernel, port: 0 })
  cleanups.push(() => new Promise<void>(resolve => http.server.close(() => resolve())))
  // A configured gateway token must never substitute for an absent agent token.
  const client = new ResearchClient({ endpoint: http.url, serviceToken: 'test-service', runnerTargetToken: targetToken })
  const keys = generateKeyPairSync('ed25519')
  const signingKey = { keyId: 'fleet-test-key', privateKey: keys.privateKey }
  const publicKeyPem = keys.publicKey.export({ type: 'spki', format: 'pem' }).toString()
  const fleet = createFleetServer(client, { owner: 'test-fleet', signingKey, ...options })
  const listener = await startFleetServer(fleet, { serviceToken: 'test-service' })
  cleanups.push(() => new Promise<void>(resolve => listener.server.close(() => resolve())))
  const transport = new HttpRemoteFleetTransport(listener.baseUrl, { serviceToken: 'test-service', runnerTargetToken: targetToken })
  const registration = buildAgentRegistration({ agentId: 'agent-a', targetId: 'remote-a', runnerVersion: '0.2.0' })
  const submit = (key: string) => kernel.submitJob({ project_id: project.project_id, idempotency_key: key, kind: 'echo' })
  return { root, kernel, project, client, fleet, transport, registration, submit, publicKeyPem, kernelUrl: http.url, baseUrl: listener.baseUrl, targetToken, otherToken }
}
const heartbeatRequest = (claim: AgentClaim) => ({
  schema_version: 1 as const, claim_id: claim.claim_id, job_id: claim.plan.job_id,
  lease: { owner: claim.lease.owner, generation: claim.lease.generation, token: claim.lease.token },
})

describe('remote lifecycle through the real Kernel and HTTP', () => {
  it('keeps a real child running across a truncated heartbeat response and retries renewal', async () => {
    const f = await fixture()
    const broken = createServer((req, res) => {
      req.resume()
      res.writeHead(200, { 'content-type': 'application/json' })
      res.write('{"schema_version":')
      setTimeout(() => res.destroy(), 20)
    })
    await new Promise<void>(resolve => broken.listen(0, '127.0.0.1', resolve))
    cleanups.push(() => new Promise<void>(resolve => { broken.close(resolve); broken.closeAllConnections() }))
    const truncated = new HttpRemoteFleetTransport(`http://127.0.0.1:${(broken.address() as { port: number }).port}`)
    const originalRenew = f.transport.heartbeatRun.bind(f.transport)
    let renewals = 0
    vi.spyOn(f.transport, 'heartbeatRun').mockImplementationOnce((...args) => truncated.heartbeatRun(...args))
      .mockImplementation(async (...args) => { const result = await originalRenew(...args); renewals++; return result })
    let childPid: number | undefined
    const agent = createRemoteRunnerAgent(f.registration, f.transport, {
      publicKeyPem: f.publicKeyPem, supervisionIntervalMs: 20,
      executor: (plan, context) => defaultSubprocessExecutor(plan, {
        ...context, onChunk: (channel, text, offset, bytes) => {
          if (channel === 'stdout') childPid = Number(text.trim())
          context.onChunk?.(channel, text, offset, bytes)
        },
      }),
    }) as RemoteRunnerAgentImpl
    await agent.register()
    const job = f.kernel.submitJob({
      project_id: f.project.project_id, idempotency_key: 'truncated-renewal', kind: 'smoke',
      command: [process.execPath, '-e', 'console.log(process.pid); setInterval(() => {}, 1000)'], payload: { trusted_fixture: true },
    })
    const [claim] = await agent.claimOnce()
    const stop = new AbortController()
    const result = agent.runClaim(claim!, { signal: stop.signal }).catch(error => error)
    cleanups.push(async () => { stop.abort(); await result })
    await until(() => childPid !== undefined && renewals >= 2)
    expect(() => process.kill(childPid!, 0)).not.toThrow()
    expect(f.kernel.getJob(job.job_id)).toMatchObject({ status: 'running', attempts: 1 })
    await f.client.cancelJob(job.job_id, 'test-operator')
    expect(await result).toMatchObject({ code: 'job_cancelled' })
    expect(() => process.kill(childPid!, 0)).toThrow()
  })

  it.each([64, 130])('preserves %i log chunks and exit order across a one-request outage', async chunkCount => {
    const f = await fixture()
    const lines = Array.from({ length: chunkCount }, (_, index) => `line ${index + 1}\n`)
    const agent = createRemoteRunnerAgent(f.registration, f.transport, {
      publicKeyPem: f.publicKeyPem,
      executor: async (_plan, context) => {
        const at = new Date().toISOString()
        let offset = 0
        for (const line of lines) { context.onChunk?.('stdout', line, offset, Buffer.byteLength(line)); offset += Buffer.byteLength(line) }
        return { exit_code: 0, stdout: lines.join(''), stderr: '', started_at: at, finished_at: at }
      },
    }) as RemoteRunnerAgentImpl
    await agent.register()
    const job = f.submit(`frame-order-${chunkCount}`)
    const [claim] = await agent.claimOnce()
    vi.spyOn(f.transport, 'uploadFrames').mockRejectedValueOnce(new RemoteWireError(0, 'transport_unreachable', 'one-request outage', true))
    await agent.runClaim(claim!)
    const stored = f.kernel.db.prepare('SELECT seq, frame_kind, text FROM terminal_frames WHERE job_id = ? ORDER BY seq').all(job.job_id)
    expect(stored.map(row => row.seq)).toEqual(Array.from({ length: chunkCount + 1 }, (_, index) => index + 1))
    expect(stored.filter(row => row.frame_kind === 'chunk').map(row => row.text).join('')).toBe(lines.join(''))
    expect(stored.at(-1)).toMatchObject({ frame_kind: 'exit' })
    expect(agent.spoolStats().entries).toBe(0)
    expect(f.kernel.getJob(job.job_id).status).toBe('succeeded')
  })

  it('rejects a finalize when cancellation wins after Fleet dispatch but before Kernel registration', async () => {
    const f = await fixture()
    await f.transport.register(f.registration)
    const job = f.submit('artifact-cancel-race')
    const [claim] = (await f.transport.claims('agent-a', { schema_version: 1 })).claims
    const content = Buffer.from('late artifact')
    const sha = createHash('sha256').update(content).digest('hex')
    const stage = await f.transport.stageArtifact('agent-a', claim!.plan.run_id, {
      schema_version: 1, run_id: claim!.plan.run_id, stage_id: 'cancel-race', sha256: sha, size: content.length, kind: 'log',
    })
    const original = f.client.registerJobArtifact.bind(f.client)
    vi.spyOn(f.client, 'registerJobArtifact').mockImplementationOnce(async (...args) => {
      f.kernel.cancelJob(job.job_id, 'test-operator')
      return original(...args)
    })
    const eventsBefore = f.kernel.db.prepare("SELECT COUNT(*) AS n FROM events WHERE kind = 'artifact.registered'").get()
    await expect(f.transport.finalizeArtifact('agent-a', claim!.plan.run_id, {
      schema_version: 1, run_id: claim!.plan.run_id, stage_id: stage.stage_id, content_base64: content.toString('base64'),
    })).rejects.toMatchObject({ status: 409, code: 'lease_stale' })
    expect(f.kernel.getJob(job.job_id).status).toBe('cancelled')
    expect(f.kernel.db.prepare('SELECT * FROM artifacts WHERE sha256 = ?').all(sha)).toHaveLength(0)
    expect(f.kernel.cas.has(sha)).toBe(false)
    expect(f.kernel.db.prepare("SELECT COUNT(*) AS n FROM events WHERE kind = 'artifact.registered'").get()).toEqual(eventsBefore)
  })

  it('requires service authentication and exact live attempt fields before reusing or writing a job artifact', async () => {
    const f = await fixture()
    await f.transport.register(f.registration)
    const job = f.submit('artifact-fences')
    const [claim] = (await f.transport.claims('agent-a', { schema_version: 1 })).claims
    const input: JobArtifactCreateInput = {
      project_id: f.project.project_id, run_id: claim!.plan.run_id, owner: claim!.lease.owner,
      lease_generation: claim!.lease.generation, lease_token: claim!.lease.token,
      kind: 'log', content_base64: Buffer.from('fenced output').toString('base64'),
    }
    const bare = new ResearchClient({ endpoint: f.kernelUrl })
    await expect(bare.registerJobArtifact(job.job_id, input)).rejects.toMatchObject({ status: 403 })
    const originalRegister = f.kernel.registerArtifact.bind(f.kernel)
    const persist = vi.spyOn(f.kernel, 'registerArtifact').mockImplementation(value => {
      expect(f.kernel.db.isTransaction).toBe(true)
      return originalRegister(value)
    })
    const record = await f.client.registerJobArtifact(job.job_id, input)
    expect(JSON.stringify(record)).not.toContain(claim!.lease.token)
    expect(record.metadata).toMatchObject({ job_id: job.job_id, run_id: claim!.plan.run_id })
    expect((await f.client.registerJobArtifact(job.job_id, input)).artifact_id).toBe(record.artifact_id)
    for (const mismatch of [
      { project_id: 'foreign-project' }, { run_id: 'foreign-run' }, { owner: 'foreign-owner' },
      { lease_generation: input.lease_generation + 1 }, { lease_token: 'wrong-token' },
    ]) {
      await expect(f.client.registerJobArtifact(job.job_id, { ...input, ...mismatch })).rejects.toMatchObject({ status: 409, code: 'lease_stale' })
    }
    const { lease_token: _token, ...missing } = input
    await expect(f.client.registerJobArtifact(job.job_id, missing as JobArtifactCreateInput)).rejects.toMatchObject({ status: 422 })
    f.kernel.db.prepare('UPDATE jobs SET lease_expires_at = ? WHERE job_id = ?').run(new Date(Date.now() - 1000).toISOString(), job.job_id)
    await expect(f.client.registerJobArtifact(job.job_id, input)).rejects.toMatchObject({ status: 409, code: 'lease_stale' })
    expect(persist).toHaveBeenCalledTimes(2)
  })

  it('authenticates target heartbeats before registry updates and makes a previously unprobed target submittable', async () => {
    const f = await fixture()
    expect(() => f.submit('before-heartbeat')).toThrow(expect.objectContaining({ code: 'runner_target_unprobed' }))
    const sharedOnly = new HttpRemoteFleetTransport(f.baseUrl, { serviceToken: 'test-service' })
    await expect(sharedOnly.register(f.registration)).rejects.toMatchObject({ status: 403, code: 'runner_target_identity_required' })
    expect(f.fleet.registry.get('agent-a')).toBeUndefined()
    expect(f.kernel.getRunnerTarget('remote-a')).toMatchObject({ health: 'unknown', last_seen_at: null })
    await f.transport.register(f.registration)
    expect(f.kernel.getRunnerTarget('remote-a')).toMatchObject({ health: 'online', revision: 1, last_seen_at: expect.any(String) })
    expect(f.submit('after-heartbeat').status).toBe('queued')
    const impostor = new HttpRemoteFleetTransport(f.baseUrl, { serviceToken: 'test-service', runnerTargetToken: f.otherToken })
    const seen = f.kernel.getRunnerTarget('remote-a').last_seen_at
    await expect(impostor.heartbeat('agent-a', { schema_version: 1 })).rejects.toMatchObject({ status: 403 })
    await expect(impostor.claims('agent-a', { schema_version: 1 })).rejects.toMatchObject({ status: 403 })
    await expect(f.transport.register({ ...f.registration, agent_id: 'agent-b', target_id: 'remote-b' })).rejects.toMatchObject({ status: 403 })
    expect(f.kernel.getRunnerTarget('remote-a').last_seen_at).toBe(seen)
    await f.transport.heartbeat('agent-a', { schema_version: 1, status: 'offline' })
    expect(f.kernel.getRunnerTarget('remote-a').health).toBe('offline')
    await f.transport.heartbeat('agent-a', { schema_version: 1, status: 'online' })
    expect(f.kernel.getRunnerTarget('remote-a').health).toBe('online')
    expect(JSON.stringify(f.fleet.registry.list())).not.toContain(f.targetToken)
  })

  it('dispatches the new run/generation after an expired pending attempt is recovered', async () => {
    const f = await fixture({ leaseTtlSeconds: 1 })
    await f.transport.register(f.registration)
    const job = f.submit('recover-pending')
    expect(await f.fleet.pump()).toBe(1)
    const old = f.kernel.getJob(job.job_id)
    await pause(1100)
    expect(f.kernel.recoverExpiredLeases()).toBe(1)
    expect(await f.fleet.pump()).toBe(1)
    const response = await f.transport.claims('agent-a', { schema_version: 1 })
    expect(response.claims).toHaveLength(1)
    expect(response.claims[0]!.plan.run_id).not.toBe(old.run_id)
    expect(response.claims[0]!.lease.generation).toBe(2)
    expect(f.fleet.stats()).toMatchObject({ pending: 0, outstanding: 1 })
    expect(f.kernel.getJob(job.job_id)).toMatchObject({ attempts: 2, lease_generation: 2 })
  })

  it('cannot rebind one Agent to another Target through simultaneous authenticated registrations', async () => {
    const f = await fixture()
    const original = f.client.heartbeatRunnerTarget.bind(f.client)
    let arrivals = 0
    let release!: () => void
    const bothVerified = new Promise<void>(resolve => { release = resolve })
    vi.spyOn(f.client, 'heartbeatRunnerTarget').mockImplementation(async (...args) => {
      const result = await original(...args)
      if (++arrivals === 2) release()
      await bothVerified
      return result
    })
    const other = new HttpRemoteFleetTransport(f.baseUrl, { serviceToken: 'test-service', runnerTargetToken: f.otherToken })
    const registrations = await Promise.allSettled([
      f.transport.register({ ...f.registration, agent_id: 'agent-racing' }),
      other.register({ ...f.registration, agent_id: 'agent-racing', target_id: 'remote-b' }),
    ])
    expect(registrations.filter(result => result.status === 'fulfilled')).toHaveLength(1)
    expect(registrations.find(result => result.status === 'rejected')).toMatchObject({
      reason: { status: 409, code: 'agent_target_conflict' },
    })
    const winner = f.fleet.registry.get('agent-racing')!
    const rejected = winner.target_id === 'remote-a' ? other : f.transport
    await expect(rejected.claims('agent-racing', { schema_version: 1 })).rejects.toMatchObject({ status: 403 })
  })

  it('keeps Agent/Target and Job leases fresh while a real child runs, then propagates API cancellation', async () => {
    const f = await fixture({ leaseTtlSeconds: 1, offlineAfterMs: 150 })
    let childPid: number | undefined
    const agent = createRemoteRunnerAgent(f.registration, f.transport, {
      publicKeyPem: f.publicKeyPem, heartbeatIntervalMs: 25, supervisionIntervalMs: 30, pollIntervalMs: 10,
      executor: (plan, context) => defaultSubprocessExecutor(plan, {
        ...context, onChunk: (channel, text, offset, bytes) => {
          if (channel === 'stdout') childPid = Number(text.trim())
          context.onChunk?.(channel, text, offset, bytes)
        },
      }),
    }) as RemoteRunnerAgentImpl
    await agent.register()
    const job = f.kernel.submitJob({
      project_id: f.project.project_id, idempotency_key: 'long-running', kind: 'smoke',
      command: [process.execPath, '-e', 'console.log(process.pid); setInterval(() => {}, 1000)'], payload: { trusted_fixture: true },
    })
    const stop = new AbortController()
    const polling = agent.runPollLoop(stop.signal)
    cleanups.push(async () => { stop.abort(); await polling })
    await until(() => childPid !== undefined)
    const initial = f.kernel.getJob(job.job_id)
    await pause(1150)
    expect(f.fleet.registry.isOffline('agent-a', Date.now(), 150)).toBe(false)
    expect(Date.now() - Date.parse(f.kernel.getRunnerTarget('remote-a').last_seen_at!)).toBeLessThan(500)
    expect(f.kernel.recoverExpiredLeases()).toBe(0)
    const renewed = f.kernel.getJob(job.job_id)
    expect(renewed).toMatchObject({ attempts: 1, lease_generation: initial.lease_generation, run_id: initial.run_id })
    expect(Date.parse(renewed.lease_expires_at!)).toBeGreaterThan(Date.now() + 1000)
    await f.client.cancelJob(job.job_id, 'test-operator', 'cancel long run')
    await until(() => { try { process.kill(childPid!, 0); return false } catch { return true } })
    expect(f.kernel.getJob(job.job_id)).toMatchObject({ status: 'cancelled', lease_owner: null })
    stop.abort()
    await polling
    const lastSeen = f.kernel.getRunnerTarget('remote-a').last_seen_at
    await pause(100)
    expect(f.kernel.getRunnerTarget('remote-a').last_seen_at).toBe(lastSeen)
    expect(f.fleet.stats().outstanding).toBe(0)
  })

  it('fences old attempt renewal after recovery and refuses to renew a cancelled Kernel job', async () => {
    const f = await fixture({ leaseTtlSeconds: 1 })
    await f.transport.register(f.registration)
    const job = f.submit('old-outstanding')
    const old = (await f.transport.claims('agent-a', { schema_version: 1 })).claims[0]!
    await pause(1100)
    expect(f.kernel.recoverExpiredLeases()).toBe(1)
    const fresh = (await f.transport.claims('agent-a', { schema_version: 1 })).claims[0]!
    expect(fresh.lease.generation).toBe(2)
    await expect(f.transport.heartbeatRun('agent-a', old.plan.run_id, heartbeatRequest(old))).rejects.toMatchObject({ status: 409, code: 'lease_stale' })
    await expect(f.transport.heartbeatRun('agent-a', fresh.plan.run_id, { ...heartbeatRequest(fresh), lease: old.lease })).rejects.toMatchObject({ status: 422 })
    f.kernel.cancelJob(job.job_id, 'operator')
    await expect(f.client.heartbeatJob(job.job_id, fresh.lease.owner, fresh.lease.generation, fresh.lease.token)).rejects.toMatchObject({ status: 409, code: 'job_not_running' })
    expect(f.kernel.getJob(job.job_id).lease_owner).toBeNull()
  })

  it('stops the real child at lease expiry even when renewal is stuck, aborting supervision without publishing output', async () => {
    const f = await fixture({ leaseTtlSeconds: 1 })
    let childPid: number | undefined
    let renewalSignal: AbortSignal | undefined
    const renewal = vi.spyOn(f.transport, 'heartbeatRun').mockImplementation((_agent, _run, _request, signal) => {
      renewalSignal = signal
      return new Promise((_resolve, reject) => {
        signal!.addEventListener('abort', () => reject(signal!.reason), { once: true })
      })
    })
    const complete = vi.spyOn(f.transport, 'complete')
    const finalize = vi.spyOn(f.transport, 'finalizeArtifact')
    const agent = createRemoteRunnerAgent(f.registration, f.transport, {
      publicKeyPem: f.publicKeyPem, supervisionIntervalMs: 20,
      executor: (plan, context) => defaultSubprocessExecutor(plan, {
        ...context, onChunk: (channel, text, offset, bytes) => {
          if (channel === 'stdout') childPid = Number(text.trim())
          context.onChunk?.(channel, text, offset, bytes)
        },
      }),
    }) as RemoteRunnerAgentImpl
    await agent.register()
    const job = f.kernel.submitJob({
      project_id: f.project.project_id, idempotency_key: 'renewal-stuck', kind: 'smoke',
      command: [process.execPath, '-e', 'console.log(process.pid); setInterval(() => {}, 1000)'], payload: { trusted_fixture: true },
    })
    const claim = (await f.transport.claims('agent-a', { schema_version: 1 })).claims[0]!
    const stop = new AbortController()
    const result = agent.runClaim(claim, { signal: stop.signal }).catch(error => error)
    cleanups.push(async () => { stop.abort(); await result })
    await until(() => childPid !== undefined && renewalSignal !== undefined)
    expect(await result).toMatchObject({ code: 'lease_stale' })
    expect(() => process.kill(childPid!, 0)).toThrow()
    expect(renewalSignal!.aborted).toBe(true)
    expect(complete).not.toHaveBeenCalled()
    expect(finalize).not.toHaveBeenCalled()
    expect(f.kernel.getJob(job.job_id).status).toBe('running')
    expect(f.kernel.recoverExpiredLeases()).toBe(1)
    expect(f.fleet.stats().outstanding).toBe(0)
    await pause(100)
    expect(renewal).toHaveBeenCalledTimes(1)
  })
})
