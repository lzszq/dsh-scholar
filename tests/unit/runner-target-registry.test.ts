import { describe, expect, it } from 'vitest'
import { chmodSync, mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { KernelError, ResearchKernel, runnerTargetTokenAccessAllowed, startKernelServer } from '@dsh-scholar/research-kernel'
import { KernelApiError, ResearchClient } from '@dsh-scholar/research-client'
import { ConfiguredTestKernel } from './configured-test-kernel.js'
import {
  RunnerTargetCreateInput,
  RunnerTargetDescriptor,
  RunnerTargetUpdateInput,
  runnerTargetConfigHash,
  runnerTargetSafeView,
} from '../../packages/research-schemas/src/runner-target'

const remoteInput = {
  target_id: 'target_remote_lab_a',
  display_name: 'Lab A',
  kind: 'remote-ssh' as const,
  enabled: true,
  draining: false,
  capabilities: ['linux', 'amd64', 'docker'],
  service_identity: { scheme: 'file' as const, name: 'runner/lab-a-heartbeat.token', scope: 'instance' as const },
  connection: {
    endpoint: { scheme: 'file' as const, name: 'runner/lab-a-endpoint.json', scope: 'instance' as const },
    credential: { scheme: 'vault' as const, name: 'runner/lab-a-key', version: '3', scope: 'instance' as const },
    known_hosts: { scheme: 'file' as const, name: 'runner/lab-a-known-hosts', scope: 'instance' as const },
  },
}

describe('EXEC-ENV-02 configurable runner targets', () => {
  it('accepts the target-token wire only from the direct loopback peer', () => {
    expect(runnerTargetTokenAccessAllowed('127.0.0.1')).toBe(true)
    expect(runnerTargetTokenAccessAllowed('::1')).toBe(true)
    expect(runnerTargetTokenAccessAllowed('::ffff:127.0.0.1')).toBe(true)
    expect(runnerTargetTokenAccessAllowed('10.0.0.7')).toBe(false)
    expect(runnerTargetTokenAccessAllowed('::ffff:10.0.0.7')).toBe(false)
    expect(runnerTargetTokenAccessAllowed(undefined)).toBe(false)
  })

  it('models local process, local Docker and remote SSH explicitly', () => {
    expect(RunnerTargetCreateInput.parse({
      target_id: 'target_local_process_v1', display_name: 'Local process', kind: 'local-process',
      enabled: true, draining: false, capabilities: ['trusted-smoke-fixture'],
      service_identity: { scheme: 'file', name: 'runner/local-process.token' },
    }).kind).toBe('local-process')
    expect(RunnerTargetCreateInput.parse({
      target_id: 'target_local_docker_v1', display_name: 'Local Docker', kind: 'local-docker',
      enabled: true, draining: false, capabilities: ['docker'],
      service_identity: { scheme: 'file', name: 'runner/local-docker.token' },
    }).kind).toBe('local-docker')
    expect(RunnerTargetCreateInput.parse(remoteInput).kind).toBe('remote-ssh')
    expect(() => RunnerTargetCreateInput.parse({
      target_id: 'identity-missing', display_name: 'Identity missing', kind: 'local-docker',
    })).toThrow()
  })

  it('models digest-pinned CPU/NVIDIA Docker runtime without arbitrary flags', () => {
    const digest = 'registry.example/research@sha256:' + 'a'.repeat(64)
    expect(RunnerTargetCreateInput.parse({
      target_id: 'docker-cpu', display_name: 'Docker CPU', kind: 'local-docker',
      service_identity: { scheme: 'file', name: 'runner/docker-cpu.token' },
      runtime: { image_digest: digest, compute: { mode: 'cpu' } },
    }).runtime).toEqual({ image_digest: digest, compute: { mode: 'cpu' } })
    expect(RunnerTargetCreateInput.parse({
      ...remoteInput,
      runtime: { image_digest: digest, compute: { mode: 'nvidia', devices: ['2', '0'] } },
    }).runtime?.compute).toEqual({ mode: 'nvidia', devices: ['0', '2'] })
    for (const runtime of [
      { image_digest: 'registry.example/research:latest', compute: { mode: 'cpu' } },
      { image_digest: digest, compute: { mode: 'nvidia', devices: [] } },
      { image_digest: digest, compute: { mode: 'nvidia', devices: ['0', '0'] } },
      { image_digest: digest, compute: { mode: 'nvidia', devices: ['--device=/dev/nvidia0'] } },
      { image_digest: digest, compute: { mode: 'cpu' }, flags: ['--privileged'] },
    ]) {
      expect(() => RunnerTargetCreateInput.parse({
      target_id: 'bad-docker', display_name: 'Bad Docker', kind: 'local-docker', runtime,
        service_identity: { scheme: 'file', name: 'runner/bad-docker.token' },
      })).toThrow()
    }
    expect(() => RunnerTargetCreateInput.parse({
      target_id: 'bad-local', display_name: 'Bad local', kind: 'local-process',
      service_identity: { scheme: 'file', name: 'runner/bad-local.token' },
      runtime: { image_digest: digest, compute: { mode: 'cpu' } },
    })).toThrow()
  })

  it('rejects inline SSH endpoints, credentials and arbitrary bootstrap commands', () => {
    for (const forbidden of [
      { ...remoteInput, hostname: '10.0.0.5' },
      { ...remoteInput, private_key: 'SECRET' },
      { ...remoteInput, proxy_command: 'nc %h %p' },
      { ...remoteInput, connection: { ...remoteInput.connection, credential: { ...remoteInput.connection.credential, value: 'SECRET' } } },
    ]) expect(() => RunnerTargetCreateInput.parse(forbidden)).toThrow()
  })

  it('requires revision CAS for updates', () => {
    expect(RunnerTargetUpdateInput.parse({ expected_revision: 2, draining: true })).toEqual({ expected_revision: 2, draining: true })
    expect(() => RunnerTargetUpdateInput.parse({ draining: true })).toThrow()
  })

  it('returns only SecretRef metadata/availability and a stable config hash', () => {
    const now = '2026-08-12T00:00:00.000Z'
    const descriptor = RunnerTargetDescriptor.parse({ ...remoteInput, revision: 1, created_by: 'pi', created_at: now, updated_at: now })
    expect(runnerTargetConfigHash(descriptor)).toMatch(/^sha256:[0-9a-f]{64}$/)
    const view = runnerTargetSafeView(descriptor, () => false)
    expect(view.connection?.credential).toEqual({ ...remoteInput.connection.credential, available: false })
    expect(JSON.stringify(view)).not.toContain('SECRET')
  })

  it('persists targets, applies revision CAS and pins the selected target into jobs', () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-targets-'))
    const secretRoot = join(root, 'secrets')
    mkdirSync(join(secretRoot, 'runner'), { recursive: true })
    writeFileSync(join(secretRoot, 'runner/endpoint.json'), '{"host":"lab.example","port":22,"user":"runner"}')
    writeFileSync(join(secretRoot, 'runner/key'), 'test-key')
    writeFileSync(join(secretRoot, 'runner/known_hosts'), 'lab.example ssh-ed25519 test')
    const kernel = new ConfiguredTestKernel({ dbPath: join(root, 'kernel.db'), casRoot: join(root, 'cas'), secretRoot })
    try {
      expect(kernel.listRunnerTargets().map(target => target.target_id)).toEqual([
        'target_local_docker_v1',
        'target_local_process_v1',
      ])
      const created = kernel.registerRunnerTarget(RunnerTargetCreateInput.parse({
        ...remoteInput,
        target_id: 'lab-a',
        capabilities: [...remoteInput.capabilities, 'nvidia'],
        runtime: {
          image_digest: 'registry.example/research@sha256:' + 'b'.repeat(64),
          compute: { mode: 'nvidia', devices: 'all' },
        },
        connection: {
          endpoint: { scheme: 'file', name: 'runner/endpoint.json' },
          credential: { scheme: 'file', name: 'runner/key' },
          known_hosts: { scheme: 'file', name: 'runner/known_hosts' },
        },
      }), 'operator-1')
      expect(kernel.runnerTargetView(created).connection?.known_hosts.available).toBe(true)
      expect(kernel.runnerTargetView(created).runtime?.compute).toEqual({ mode: 'nvidia', devices: 'all' })
      expect(() => kernel.updateRunnerTarget('lab-a', { expected_revision: 2, draining: true })).toThrowError(KernelError)
      const observed = kernel.observeRunnerTarget('lab-a', { expected_revision: 1, health: 'online' })
      expect(observed.health).toBe('online')
      expect(observed.last_seen_at).not.toBeNull()
      expect(() => kernel.observeRunnerTarget('lab-a', { expected_revision: 2, health: 'online' })).toThrowError(KernelError)
      const project = kernel.createProject({
        name: 'remote', workspace: '/w',
        brief: { problem: 'p', scope: 's', questions: [], primary_metrics: ['m'], resources: '', risks: [], target_outputs: ['paper'], target_venue: null, baseline_repo: null, domain: 'ml' },
        execution: { runner_target_id: 'lab-a' },
      })
      const job = kernel.submitJob({ project_id: project.project_id, idempotency_key: 'remote-1', kind: 'echo' })
      expect(job.payload).toMatchObject({
        runner_target_id: 'lab-a',
        runner_target_kind: 'remote-ssh',
        runner_target_revision: 1,
        image_digest: 'registry.example/research@sha256:' + 'b'.repeat(64),
        runner_compute: { mode: 'nvidia', devices: 'all' },
      })
      expect(job.payload.runner_target_hash).toMatch(/^sha256:[0-9a-f]{64}$/)
    } finally {
      kernel.close()
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('CAS-configures the current project default target and preserves Job override precedence', () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-project-target-'))
    const kernel = new ConfiguredTestKernel({ dbPath: join(root, 'kernel.db'), casRoot: join(root, 'cas') })
    try {
      const project = kernel.createProject({
        name: 'target selection', workspace: '/w',
        brief: { problem: 'p', scope: 's', questions: [], primary_metrics: ['m'], resources: '', risks: [], target_outputs: ['paper'], target_venue: null, baseline_repo: null, domain: 'ml' },
      })
      kernel.writeSettingsTransaction({ operations: [{
        kind: 'config', scope: 'project', scope_id: project.project_id, expected_revision: 0,
        changes: { 'execution.runner_target_id': 'target_local_process_v1' },
      }] }, 'operator')
      const configured = kernel.getProject(project.project_id)
      expect(configured.execution.runner_target_id).toBe('target_local_process_v1')
      expect(configured.execution.runner_profile_id).toBe('profile_isolated_subprocess_v1')
      expect(configured.revision).toBe(project.revision + 1)
      expect(() => kernel.writeSettingsTransaction({ operations: [{
        kind: 'config', scope: 'project', scope_id: project.project_id, expected_revision: 0,
        changes: { 'execution.runner_target_id': 'target_local_docker_v1' },
      }] }, 'operator')).toThrowError(KernelError)
      expect(() => kernel.writeSettingsTransaction({ operations: [{
        kind: 'config', scope: 'project', scope_id: project.project_id, expected_revision: 1,
        changes: { 'execution.runner_target_id': 'target_missing' },
      }] }, 'operator')).toThrowError(KernelError)
      kernel.updateRunnerTarget('target_local_docker_v1', { expected_revision: 1, enabled: false })
      expect(() => kernel.writeSettingsTransaction({ operations: [{
        kind: 'config', scope: 'project', scope_id: project.project_id, expected_revision: 1,
        changes: { 'execution.runner_target_id': 'target_local_docker_v1' },
      }] }, 'operator')).toThrowError(KernelError)
      kernel.updateRunnerTarget('target_local_docker_v1', { expected_revision: 2, enabled: true })

      const projectDefault = kernel.submitJob({
        project_id: project.project_id, idempotency_key: 'project-default', kind: 'echo',
      })
      expect(projectDefault.payload.runner_target_id).toBe('target_local_process_v1')
      const overridden = kernel.submitJob({
        project_id: project.project_id, idempotency_key: 'job-override', kind: 'echo',
        runner_target_id: 'target_local_docker_v1', runner_profile_id: 'profile_local_docker_cpu_v1',
      })
      expect(overridden.payload.runner_target_id).toBe('target_local_docker_v1')
    } finally {
      kernel.close()
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('claims only jobs compatible with the runner target kind', () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-target-claim-'))
    const kernel = new ConfiguredTestKernel({ dbPath: join(root, 'kernel.db'), casRoot: join(root, 'cas') })
    try {
      const localProcess = kernel.createProject({
        name: 'process', workspace: '/process',
        brief: { problem: 'p', scope: 's', questions: [], primary_metrics: ['m'], resources: '', risks: [], target_outputs: ['paper'], target_venue: null, baseline_repo: null, domain: 'ml' },
        execution: { runner_profile_id: 'profile_isolated_subprocess_v1', runner_target_id: 'target_local_process_v1' },
      })
      const localDocker = kernel.createProject({
        name: 'docker', workspace: '/docker',
        brief: { problem: 'p', scope: 's', questions: [], primary_metrics: ['m'], resources: '', risks: [], target_outputs: ['paper'], target_venue: null, baseline_repo: null, domain: 'ml' },
      })
      const processJob = kernel.submitJob({ project_id: localProcess.project_id, idempotency_key: 'p', kind: 'echo' })
      const dockerJob = kernel.submitJob({ project_id: localDocker.project_id, idempotency_key: 'd', kind: 'echo' })
      expect(kernel.claimJobs('process-runner', 60, 8, { runner_target_kinds: ['local-process'] }).map(job => job.job_id)).toEqual([processJob.job_id])
      expect(kernel.claimJobs('docker-runner', 60, 8, { runner_target_kinds: ['local-docker'] }).map(job => job.job_id)).toEqual([dockerJob.job_id])
    } finally {
      kernel.close()
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('claims an exact target id and does not let stale candidates consume the claim limit', () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-target-exact-'))
    const kernel = new ConfiguredTestKernel({ dbPath: join(root, 'kernel.db'), casRoot: join(root, 'cas') })
    try {
      for (const targetId of ['docker-a', 'docker-b']) {
        kernel.registerRunnerTarget(RunnerTargetCreateInput.parse({
          target_id: targetId,
          display_name: targetId,
          kind: 'local-docker',
          capabilities: ['docker'],
          service_identity: { scheme: 'file', name: `runner/${targetId}.token` },
        }), 'operator-1')
      }
      const projectA = kernel.createProject({
        name: 'docker a', workspace: '/docker-a',
        brief: { problem: 'p', scope: 's', questions: [], primary_metrics: ['m'], resources: '', risks: [], target_outputs: ['paper'], target_venue: null, baseline_repo: null, domain: 'ml' },
        execution: { runner_target_id: 'docker-a' },
      })
      const projectB = kernel.createProject({
        name: 'docker b', workspace: '/docker-b',
        brief: { problem: 'p', scope: 's', questions: [], primary_metrics: ['m'], resources: '', risks: [], target_outputs: ['paper'], target_venue: null, baseline_repo: null, domain: 'ml' },
        execution: { runner_target_id: 'docker-b' },
      })
      const staleA = kernel.submitJob({ project_id: projectA.project_id, idempotency_key: 'a-stale', kind: 'echo' })
      const jobB = kernel.submitJob({ project_id: projectB.project_id, idempotency_key: 'b', kind: 'echo' })
      kernel.updateRunnerTarget('docker-a', { expected_revision: 1, display_name: 'docker a revision 2' })
      const freshA = kernel.submitJob({ project_id: projectA.project_id, idempotency_key: 'a-fresh', kind: 'echo' })

      expect(kernel.claimJobs('runner-a', 60, 1, {
        runner_target_kinds: ['local-docker'], runner_target_ids: ['docker-a'],
      }).map(job => job.job_id)).toEqual([freshA.job_id])
      expect(kernel.getJob(staleA.job_id).status).toBe('queued')
      expect(kernel.getJob(jobB.job_id).status).toBe('queued')
      expect(kernel.claimJobs('runner-b', 60, 1, {
        runner_target_kinds: ['local-docker'], runner_target_ids: ['docker-b'],
      }).map(job => job.job_id)).toEqual([jobB.job_id])
    } finally {
      kernel.close()
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('fails closed when project target state or target/profile kind is invalid', () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-target-project-validation-'))
    const kernel = new ConfiguredTestKernel({ dbPath: join(root, 'kernel.db'), casRoot: join(root, 'cas') })
    const create = (execution: Record<string, unknown>) => kernel.createProject({
      name: 'invalid target', workspace: '/invalid',
      brief: { problem: 'p', scope: 's', questions: [], primary_metrics: ['m'], resources: '', risks: [], target_outputs: ['paper'], target_venue: null, baseline_repo: null, domain: 'ml' },
      execution,
    } as never)
    try {
      expect(() => create({ runner_target_id: 'target_missing' })).toThrowError(KernelError)
      expect(() => create({ runner_target_id: 'target_local_process_v1' })).toThrowError(KernelError)
      kernel.updateRunnerTarget('target_local_docker_v1', { expected_revision: 1, enabled: false })
      expect(() => create({ runner_target_id: 'target_local_docker_v1' })).toThrowError(KernelError)
      expect(kernel.listProjects()).toHaveLength(0)
    } finally {
      kernel.close()
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('exposes redacted reads and routes target writes through the PI/operator Settings transaction', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-target-http-'))
    const kernel = new ConfiguredTestKernel({ dbPath: join(root, 'kernel.db'), casRoot: join(root, 'cas') })
    const project = kernel.createProject({
      name: 'target administrators', workspace: '/w', creator_principal_id: 'pi',
      brief: { problem: 'p', scope: 's', questions: [], primary_metrics: ['m'], resources: '', risks: [], target_outputs: ['paper'], target_venue: null, baseline_repo: null, domain: 'ml' },
    } as never)
    kernel.addProjectMember({ project_id: project.project_id, principal_id: 'op', role: 'operator', actor: 'pi' })
    const { server, url } = await startKernelServer({ kernel, port: 0 })
    try {
      expect((await fetch(`${url}/v1/runner-targets`)).status).toBe(200)
      const body = {
        target_id: 'http-local', display_name: 'HTTP local', kind: 'local-process',
        service_identity: { scheme: 'file', name: 'runner/http-local.token' },
      }
      const createBody = { operations: [{ kind: 'runner-target', action: 'create', input: body }] }
      const denied = await fetch(`${url}/v1/settings/transactions`, {
        method: 'POST', headers: { 'content-type': 'application/json', 'x-principal-id': 'outsider', 'x-principal-role': 'operator' }, body: JSON.stringify(createBody),
      })
      expect(denied.status).toBe(403)
      const created = await fetch(`${url}/v1/settings/transactions`, {
        method: 'POST', headers: { 'content-type': 'application/json', 'x-principal-id': 'op', 'x-principal-role': 'operator' }, body: JSON.stringify(createBody),
      })
      expect(created.status).toBe(200)
      expect(await created.json()).toMatchObject({ operations: [{ resource: { target_id: 'http-local', revision: 1, kind: 'local-process' } }] })
      const updated = await fetch(`${url}/v1/settings/transactions`, {
        method: 'POST', headers: { 'content-type': 'application/json', 'x-principal-id': 'pi', 'x-principal-role': 'pi' },
        body: JSON.stringify({ operations: [{
          kind: 'runner-target', action: 'update', target_id: 'http-local', patch: { expected_revision: 1, draining: true },
        }] }),
      })
      expect(updated.status).toBe(200)
      expect(await updated.json()).toMatchObject({ operations: [{ resource: { target_id: 'http-local', revision: 2, draining: true } }] })
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()))
      kernel.close()
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('exposes a PI/operator-only project target Settings operation', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-project-target-http-'))
    const kernel = new ConfiguredTestKernel({ dbPath: join(root, 'kernel.db'), casRoot: join(root, 'cas') })
    const project = kernel.createProject({
      name: 'HTTP selection', workspace: '/w',
      brief: { problem: 'p', scope: 's', questions: [], primary_metrics: ['m'], resources: '', risks: [], target_outputs: ['paper'], target_venue: null, baseline_repo: null, domain: 'ml' },
      creator_principal_id: 'pi-1',
    } as never)
    kernel.addProjectMember({ project_id: project.project_id, principal_id: 'researcher-1', role: 'researcher', actor: 'pi-1' })
    const { server, url } = await startKernelServer({ kernel, port: 0 })
    const patchTarget = (principal: string, role: string, expectedRevision: number): Promise<Response> => fetch(
      `${url}/v1/settings/transactions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-principal-id': principal, 'x-principal-role': role },
        body: JSON.stringify({ operations: [{
          kind: 'config', scope: 'project', scope_id: project.project_id, expected_revision: expectedRevision,
          changes: { 'execution.runner_target_id': 'target_local_process_v1' },
        }] }),
      },
    )
    try {
      expect((await patchTarget('researcher-1', 'researcher', 0)).status).toBe(403)
      const updated = await patchTarget('pi-1', 'pi', 0)
      expect(updated.status).toBe(200)
      expect(kernel.getProject(project.project_id)).toMatchObject({
        revision: project.revision + 1,
        execution: { runner_target_id: 'target_local_process_v1', runner_profile_id: 'profile_isolated_subprocess_v1' },
      })
      expect((await patchTarget('pi-1', 'pi', 0)).status).toBe(409)
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()))
      kernel.close()
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('binds revision-fenced heartbeats to the target-scoped service identity', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-target-heartbeat-'))
    const secretRoot = join(root, 'secrets')
    mkdirSync(join(secretRoot, 'runner'), { recursive: true })
    const tokenA = 'target-a-identity-token-0000000001'
    const tokenB = 'target-b-identity-token-0000000002'
    writeFileSync(join(secretRoot, 'runner/a.token'), tokenA, { mode: 0o600 })
    writeFileSync(join(secretRoot, 'runner/b.token'), tokenB, { mode: 0o600 })
    const kernel = new ConfiguredTestKernel({
      dbPath: join(root, 'kernel.db'), casRoot: join(root, 'cas'), secretRoot, serviceToken: 'runner-service',
    })
    kernel.registerRunnerTarget(RunnerTargetCreateInput.parse({
      target_id: 'heartbeat-a', display_name: 'Heartbeat A', kind: 'local-docker', capabilities: ['docker'],
      service_identity: { scheme: 'file', name: 'runner/a.token' },
    }), 'operator')
    kernel.registerRunnerTarget(RunnerTargetCreateInput.parse({
      target_id: 'heartbeat-b', display_name: 'Heartbeat B', kind: 'local-docker', capabilities: ['docker'],
      service_identity: { scheme: 'file', name: 'runner/b.token' },
    }), 'operator')
    const { server, url } = await startKernelServer({ kernel, port: 0 })
    const heartbeat = (targetId: string, headers: Record<string, string>, expectedRevision = 1): Promise<Response> => fetch(
      `${url}/v1/runner-targets/${targetId}/heartbeat`, {
        method: 'POST', headers: { 'content-type': 'application/json', ...headers },
        body: JSON.stringify({ expected_revision: expectedRevision, health: 'online' }),
      },
    )
    try {
      expect((await heartbeat('heartbeat-a', {})).status).toBe(403)
      expect((await heartbeat('heartbeat-a', { 'x-service-token': 'runner-service' })).status).toBe(403)
      expect((await heartbeat('heartbeat-a', {
        'x-service-token': 'runner-service', 'x-runner-target-token': 'wrong-target-token-00000000000000',
      })).status).toBe(403)
      // A valid credential for target A cannot observe target B, regardless
      // of any self-reported principal/target-like header.
      expect((await heartbeat('heartbeat-b', {
        'x-service-token': 'runner-service', 'x-runner-target-token': tokenA,
        'x-service-principal': 'heartbeat-b', 'x-runner-target-id': 'heartbeat-b',
      })).status).toBe(403)
      const observed = await heartbeat('heartbeat-a', {
        'x-service-token': 'runner-service', 'x-runner-target-token': tokenA,
      })
      expect(observed.status).toBe(200)
      expect(await observed.json()).toMatchObject({
        target_id: 'heartbeat-a', revision: 1, health: 'online',
      })
      expect((await heartbeat('heartbeat-a', {
        'x-service-token': 'runner-service', 'x-runner-target-token': tokenA,
      }, 2)).status).toBe(409)
      const clientA = new ResearchClient({
        endpoint: url, serviceToken: 'runner-service', runnerTargetToken: tokenA,
      })
      await expect(clientA.heartbeatRunnerTarget('heartbeat-a', {
        expected_revision: 1, health: 'offline',
      })).resolves.toMatchObject({ target_id: 'heartbeat-a', health: 'offline' })
      await expect(clientA.heartbeatRunnerTarget('heartbeat-b', {
        expected_revision: 1, health: 'online',
      })).rejects.toMatchObject<Partial<KernelApiError>>({ status: 403, code: 'runner_target_identity_required' })
      expect(JSON.stringify(kernel.runnerTargetView(kernel.getRunnerTarget('heartbeat-a')))).not.toContain(tokenA)
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()))
      kernel.close()
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('rejects service-identity files that are symlinks, outside secretRoot, or not 0600', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-target-identity-file-'))
    const secretRoot = join(root, 'secrets')
    mkdirSync(join(secretRoot, 'runner'), { recursive: true })
    const token = 'target-file-identity-token-00000001'
    const loose = join(secretRoot, 'runner/loose.token')
    writeFileSync(loose, token, { mode: 0o600 })
    chmodSync(loose, 0o644)
    writeFileSync(join(root, 'outside.token'), token, { mode: 0o600 })
    symlinkSync(join(root, 'outside.token'), join(secretRoot, 'runner/link.token'))
    const kernel = new ConfiguredTestKernel({
      dbPath: join(root, 'kernel.db'), casRoot: join(root, 'cas'), secretRoot, serviceToken: 'runner-service',
    })
    for (const [targetId, name] of [['loose', 'runner/loose.token'], ['link', 'runner/link.token']] as const) {
      kernel.registerRunnerTarget(RunnerTargetCreateInput.parse({
        target_id: targetId, display_name: targetId, kind: 'local-docker',
        service_identity: { scheme: 'file', name },
      }), 'operator')
    }
    const { server, url } = await startKernelServer({ kernel, port: 0 })
    try {
      for (const targetId of ['loose', 'link']) {
        const response = await fetch(`${url}/v1/runner-targets/${targetId}/heartbeat`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json', 'x-service-token': 'runner-service', 'x-runner-target-token': token,
          },
          body: JSON.stringify({ expected_revision: 1, health: 'online' }),
        })
        expect(response.status).toBe(403)
        expect((await response.json()) as unknown).toMatchObject({ error: { code: 'runner_target_identity_required' } })
      }
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()))
      kernel.close()
      rmSync(root, { recursive: true, force: true })
    }
  })
})
