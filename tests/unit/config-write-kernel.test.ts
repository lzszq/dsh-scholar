import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ResearchKernel, startKernelServer } from '@dsh-scholar/research-kernel'
import { PtyOpenRequest } from '@dsh-scholar/research-schemas'

const cleanup: Array<() => Promise<void> | void> = []
afterEach(async () => {
  for (const dispose of cleanup.splice(0).reverse()) await dispose()
})

function fixture(): { kernel: ResearchKernel; projectId: string; principal: string } {
  const root = mkdtempSync(join(tmpdir(), 'dsh-config-kernel-'))
  const kernel = new ResearchKernel({
    dbPath: join(root, 'kernel.db'),
    casRoot: join(root, 'cas'),
    requireSignedManifest: false,
    providerUrlAllowlist: { hosts: ['mineru.net'] },
  })
  cleanup.push(() => { kernel.close(); rmSync(root, { recursive: true, force: true }) })
  const principal = 'principal_config_pi'
  const project = kernel.createProject({
    name: 'canonical settings',
    workspace: '/workspace',
    creator_principal_id: principal,
    creator_tenant_id: 'tenant_config',
    brief: {
      problem: 'p', scope: 's', questions: [], primary_metrics: ['m'], resources: '', risks: [],
      target_outputs: ['paper'], target_venue: null, baseline_repo: null, domain: 'ml',
    },
  })
  return { kernel, projectId: project.project_id, principal }
}

describe('REVIEW-CONFIG-WRITE-03 Kernel authority integration', () => {
  it('applies a persisted Kernel runtime layer only after reopening the same authoritative database', () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-config-restart-'))
    const dbPath = join(root, 'kernel.db')
    const casRoot = join(root, 'cas')
    const first = new ResearchKernel({ dbPath, casRoot, requireSignedManifest: false })
    expect(first.requireSignedManifest).toBe(false)
    const desired = first.writeSettingsTransaction({ operations: [{
      kind: 'config', scope: 'runtime', scope_id: 'kernel', expected_revision: 0,
      changes: { 'kernel.require_signed_manifest': true },
    }] }, 'principal_config_pi')
    expect(desired.config?.verdict).toMatchObject({
      restart_required_keys: ['kernel.require_signed_manifest'], restart_required: true,
    })
    expect(first.requireSignedManifest).toBe(false)
    const desiredPin = desired.config!.effective.config_pin
    first.close()

    const second = new ResearchKernel({ dbPath, casRoot, requireSignedManifest: false })
    try {
      expect(second.requireSignedManifest).toBe(true)
      expect(second.configPinHash).toBe(desiredPin)
      expect(second.configEffective().config['kernel.require_signed_manifest']).toBe(true)
    } finally {
      second.close()
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('keeps hot PTY runtime policy durable across restart and applies it to the next open', () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-config-pty-restart-'))
    const dbPath = join(root, 'kernel.db')
    const casRoot = join(root, 'cas')
    const first = new ResearchKernel({ dbPath, casRoot, requireSignedManifest: false })
    const project = first.createProject({
      name: 'durable pty policy', workspace: '/workspace',
      creator_principal_id: 'principal_config_pi', creator_tenant_id: 'tenant_config',
      execution: {
        runner_profile_id: 'profile_isolated_subprocess_v1',
        runner_target_id: 'target_local_process_v1',
        network_policy: 'none', artifact_store: 'local-cas', fixture_id: null,
      },
      brief: {
        problem: 'p', scope: 's', questions: [], primary_metrics: ['m'], resources: '', risks: [],
        target_outputs: ['paper'], target_venue: null, baseline_repo: null, domain: 'ml',
      },
    })
    const workspace = first.workspaceEnsure(project.project_id, 'scratch', 'scratch')
    const receipt = first.writeSettingsTransaction({ operations: [{
      kind: 'config', scope: 'runtime', scope_id: 'kernel', expected_revision: 0,
      changes: {
        'kernel.pty_idle_ttl_s': 75,
        'kernel.pty_retention_bytes': 16384,
        'kernel.pty_lease_ttl_s': 180,
      },
    }] }, 'principal_config_pi')
    expect(receipt.config?.verdict.restart_required).toBe(false)
    first.close()

    const second = new ResearchKernel({ dbPath, casRoot, requireSignedManifest: false })
    try {
      second.setPtyAdapter({
        id: 'local-pty',
        spawn: () => ({ ok: true }),
        write: () => {},
        resize: () => {},
        signal: () => {},
        kill: () => {},
      })
      expect(second.configEffective(project.project_id).config).toMatchObject({
        'kernel.pty_idle_ttl_s': 75,
        'kernel.pty_retention_bytes': 16384,
        'kernel.pty_lease_ttl_s': 180,
      })
      const projected = second.ptyContexts(project.project_id, 'principal_config_pi')
        .find(item => item.context_kind === 'research')!
      const context = second.ptyResolveContext(projected.context_id, 'principal_config_pi')
      const opened = second.ptyOpen(PtyOpenRequest.parse({
        context_id: context.context_id,
        workspace_id: workspace.workspace_id,
        label: 'after restart',
        preset: 'bash',
        cwd: '.',
      }), { context, adapter: null })
      expect(opened).toMatchObject({ idle_ttl_s: 75, retention_bytes: 16384 })
      expect((Date.parse(opened.lease_expires_at!) - Date.parse(opened.open_at)) / 1000).toBeCloseTo(180, 0)
      expect(opened.config_hash).toBe(second.configEffective(project.project_id).config_pin)
    } finally {
      second.close()
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('writes the canonical project row and its Settings CAS projection in one transaction', () => {
    const { kernel, projectId, principal } = fixture()
    const before = kernel.getProject(projectId)

    const receipt = kernel.writeSettingsTransaction({ operations: [{
      kind: 'config',
      scope: 'project',
      scope_id: projectId,
      expected_revision: 0,
      changes: {
        'execution.runner_target_id': 'target_local_process_v1',
        'integrity.require_clean_room_rerun': true,
      },
    }] }, principal)

    const project = kernel.getProject(projectId)
    expect(project.revision).toBe(before.revision + 1)
    expect(project.execution).toMatchObject({
      runner_target_id: 'target_local_process_v1',
      runner_profile_id: 'profile_isolated_subprocess_v1',
    })
    expect(project.integrity.require_clean_room_rerun).toBe(true)
    expect(kernel.configLayer('project', projectId)).toMatchObject({
      revision: 1,
      config: {
        'execution.runner_target_id': 'target_local_process_v1',
        'execution.runner_profile_id': 'profile_isolated_subprocess_v1',
        'integrity.require_clean_room_rerun': true,
      },
    })
    expect(receipt.config?.verdict).toEqual({
      hot_applied_keys: [
        'execution.runner_profile_id',
        'execution.runner_target_id',
        'integrity.require_clean_room_rerun',
      ],
      restart_required_keys: [],
      restart_required: false,
    })
    expect(kernel.configRevisions('project', projectId)).toHaveLength(1)

    const job = kernel.submitJob({
      project_id: projectId, idempotency_key: 'project-config-pin', kind: 'echo',
    })
    expect(job.payload.project_config_pin).toBe(receipt.config?.effective.config_pin)
    expect(job.payload.project_config_pin).toBe(kernel.configEffective(projectId).config_pin)
  })

  it('rolls back the real Project, config ledger and Provider when a later resource operation fails', () => {
    const { kernel, projectId, principal } = fixture()
    const before = kernel.getProject(projectId)
    expect(() => kernel.writeSettingsTransaction({ operations: [
      {
        kind: 'config', scope: 'project', scope_id: projectId, expected_revision: 0,
        changes: { 'execution.network_policy': 'none' },
      },
      {
        kind: 'ocr-mineru', provider: { action: 'create', input: {
          provider_id: 'mineru', display_name: 'MinerU', kind: 'mineru',
          base_url: 'https://mineru.net/api/v4', enabled: true,
          capabilities: ['ocr', 'vision'],
          models: [
            { model_id: 'flash', capabilities: ['ocr'] },
            { model_id: 'pipeline', capabilities: ['ocr'] },
            { model_id: 'vlm', capabilities: ['ocr', 'vision'] },
          ],
        } },
      },
      {
        kind: 'runner-target', action: 'update', target_id: 'target_missing',
        patch: { expected_revision: 1, draining: true },
      },
    ] }, principal)).toThrowError(expect.objectContaining({ code: 'runner_target_unknown' }))

    expect(kernel.getProject(projectId)).toEqual(before)
    expect(kernel.configLayer('project', projectId)).toMatchObject({ revision: 0, config: {} })
    expect(kernel.configRevisions('project', projectId)).toEqual([])
    expect(() => kernel.getProvider('mineru')).toThrowError(expect.objectContaining({ code: 'provider_unknown' }))
  })

  it('serves the canonical write/read routes and removes the obsolete project execution mutation', async () => {
    const { kernel, projectId, principal } = fixture()
    const { server, url } = await startKernelServer({ kernel, port: 0 })
    cleanup.push(() => new Promise<void>((resolve, reject) => server.close(error => error === undefined ? resolve() : reject(error))))
    const headers = { 'content-type': 'application/json', 'x-principal-id': principal }

    const write = await fetch(`${url}/v1/settings/transactions`, {
      method: 'POST', headers,
      body: JSON.stringify({ operations: [{
        kind: 'config', scope: 'project', scope_id: projectId, expected_revision: 0,
        changes: { 'execution.network_policy': 'none' },
      }] }),
    })
    expect(write.status).toBe(200)

    const layer = await fetch(`${url}/v1/config/layers/project/${projectId}`, {
      headers: { 'x-principal-id': principal },
    })
    expect(layer.status).toBe(200)
    expect(await layer.json()).toMatchObject({ revision: 1, config: { 'execution.network_policy': 'none' } })

    const effective = await fetch(`${url}/v1/config/effective?project_id=${projectId}`, {
      headers: { 'x-principal-id': principal },
    })
    expect(effective.status).toBe(200)
    expect(await effective.json()).toMatchObject({ revisions: { project: 1 }, config: { 'execution.network_policy': 'none' } })

    expect((await fetch(`${url}/v1/projects/${projectId}/model-binding`)).status).toBe(422)
    expect((await fetch(`${url}/v1/projects/${projectId}/model-binding`, {
      headers: { 'x-principal-id': 'principal_outsider' },
    })).status).toBe(404)
    const binding = await fetch(`${url}/v1/projects/${projectId}/model-binding`, {
      headers: { 'x-principal-id': principal },
    })
    expect(binding.status).toBe(200)
    expect(await binding.json()).toBeNull()

    const invalid = await fetch(`${url}/v1/settings/transactions`, {
      method: 'POST', headers,
      body: JSON.stringify({ operations: [{
        kind: 'config', scope: 'project', scope_id: projectId, expected_revision: 1,
        changes: { 'kernel.port': 7413 },
      }] }),
    })
    expect(invalid.status).toBe(422)
    expect(await invalid.json()).toMatchObject({
      error: { code: 'config_scope_forbidden', key: 'kernel.port' },
    })

    const obsolete = [
      [`${url}/v2/projects/${projectId}/execution`, 'PATCH'],
      [`${url}/v1/providers`, 'POST'],
      [`${url}/v1/providers/mineru`, 'PATCH'],
      [`${url}/v1/providers/mineru`, 'DELETE'],
      [`${url}/v1/runner-targets`, 'POST'],
      [`${url}/v1/runner-targets/target_local_docker_v1`, 'PATCH'],
      [`${url}/v1/projects/${projectId}/model-binding`, 'PUT'],
      [`${url}/v1/projects/${projectId}/model-binding`, 'POST'],
    ] as const
    for (const [endpoint, method] of obsolete) {
      const response = await fetch(endpoint, { method, headers, body: '{}' })
      const responseBody = await response.text()
      expect(response.status, `${method} ${endpoint}: ${responseBody}`).toBe(404)
    }
  })
})
