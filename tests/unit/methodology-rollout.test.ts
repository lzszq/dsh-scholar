import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  MethodologyRolloutStoreError,
  ResearchKernel,
} from '@dsh-scholar/research-kernel'
import { startKernelServer } from '../../packages/research-kernel/src/server.js'
import { ResearchClient } from '../../packages/research-client/src/index.js'
import { NATIVE_KNOWLEDGE_PACKS } from '../../packages/research-kernel/src/native-knowledge-packs.js'

function paths(): { dbPath: string, casRoot: string } {
  const root = mkdtempSync(join(tmpdir(), 'dsh-methodology-rollout-'))
  return { dbPath: join(root, 'kernel.db'), casRoot: join(root, 'cas') }
}

function open(options = paths()): ResearchKernel {
  return new ResearchKernel({ ...options, requireSignedManifest: false })
}

function createProject(kernel: ResearchKernel, name = 'Rollout project') {
  return kernel.createProject({
    name,
    workspace: `/workspace/${name.toLowerCase().replaceAll(' ', '-')}`,
    creator_principal_id: 'pi',
    brief: {
      problem: 'measure a deterministic rollout',
      scope: 'one fixture',
      questions: ['does the policy stay pinned?'],
      primary_metrics: ['accuracy'],
      resources: '', risks: [], target_outputs: ['paper'],
      target_venue: null, baseline_repo: null, domain: 'ml',
    },
  })
}

describe('append-only methodology rollout policy', () => {
  it('persists a safe default and automatically pins every new project', () => {
    const k = open()
    const policy = k.rollout.currentPolicy()
    expect(policy).toMatchObject({ revision: 1, mode: 'internal-fixture' })
    expect(policy.policy_hash).toMatch(/^sha256:[0-9a-f]{64}$/)

    const project = createProject(k)
    expect(k.rollout.projectPin(project.project_id)).toMatchObject({
      project_id: project.project_id,
      project_pin_revision: 1,
      policy_revision: policy.revision,
      policy_hash: policy.policy_hash,
      mode: 'internal-fixture',
      actor_ref: 'system:project-create',
    })
    k.close()
  })

  it('updates with CAS and explicitly re-pins an existing project to the current policy', () => {
    const k = open()
    const project = createProject(k)
    const previous = k.rollout.currentPolicy()
    const next = k.rollout.updatePolicy({
      mode: 'opt-in-dev',
      expected_revision: previous.revision,
      actor_ref: 'principal_operator',
    })
    expect(next).toMatchObject({ revision: 2, mode: 'opt-in-dev' })
    expect(next.policy_hash).not.toBe(previous.policy_hash)
    expect(k.rollout.projectPin(project.project_id).mode).toBe('internal-fixture')

    const pin = k.rollout.pinProject({
      project_id: project.project_id,
      expected_project_pin_revision: 1,
      expected_policy_revision: next.revision,
      expected_policy_hash: next.policy_hash,
      actor_ref: 'principal_pi',
    })
    expect(pin).toMatchObject({ project_pin_revision: 2, mode: 'opt-in-dev' })
    expect(() => k.rollout.pinProject({
      project_id: project.project_id,
      expected_project_pin_revision: 1,
      expected_policy_revision: next.revision,
      expected_policy_hash: next.policy_hash,
      actor_ref: 'principal_pi',
    })).toThrow(MethodologyRolloutStoreError)
    k.close()
  })

  it('survives restart and refuses mutation of policy and pin history', () => {
    const options = paths()
    const first = open(options)
    const project = createProject(first)
    const next = first.rollout.updatePolicy({
      mode: 'opt-in-user', expected_revision: 1, actor_ref: 'principal_operator',
    })
    first.rollout.pinProject({
      project_id: project.project_id,
      expected_project_pin_revision: 1,
      expected_policy_revision: next.revision,
      expected_policy_hash: next.policy_hash,
      actor_ref: 'principal_pi',
    })
    expect(() => first.db.exec("UPDATE methodology_rollout_policies SET mode = 'internal-fixture' WHERE policy_revision = 2"))
      .toThrow(/append_only/)
    expect(() => first.db.exec(`DELETE FROM methodology_project_rollout_events WHERE project_id = '${project.project_id}'`))
      .toThrow(/append_only/)
    expect(() => first.db.prepare(`INSERT INTO methodology_project_rollout_events
      (project_id, project_pin_revision, policy_revision, policy_hash, mode, actor_ref, pinned_at)
      VALUES (?, 3, 2, ?, 'opt-in-user', 'raw', ?)`)
      .run(project.project_id, `sha256:${'f'.repeat(64)}`, new Date().toISOString()))
      .toThrow(/policy_mismatch/)
    first.close()

    const reopened = open(options)
    expect(reopened.rollout.currentPolicy()).toEqual(next)
    expect(reopened.rollout.projectPin(project.project_id)).toMatchObject({
      project_pin_revision: 2,
      policy_revision: 2,
      policy_hash: next.policy_hash,
      mode: 'opt-in-user',
    })
    reopened.close()
  })

  it('exposes operator policy CAS, PI project pinning and a redacted compact projection', async () => {
    const k = open()
    const { project } = k.createProjectForGrill({
      name: 'Rollout HTTP', creator_principal_id: 'pi-rollout',
      idempotency_key: 'rollout-http', request_hash: 'rollout-http-hash',
    })
    k.addProjectMember({ project_id: project.project_id, principal_id: 'operator-rollout', role: 'operator', actor: 'pi-rollout' })
    const { server, url } = await startKernelServer({ kernel: k, port: 0 })
    try {
      const client = new ResearchClient({ endpoint: url })
      await expect(client.getMethodologyRolloutPolicy('outsider'))
        .rejects.toMatchObject({ status: 403, code: 'role_forbidden' })
      const initial = await client.getMethodologyRolloutPolicy('operator-rollout')
      const updated = await client.updateMethodologyRolloutPolicy('operator-rollout', {
        mode: 'opt-in-user', expected_revision: initial.revision,
      })
      expect(updated).toMatchObject({ revision: 2, mode: 'opt-in-user', actor_ref: 'operator-rollout' })

      const strict = await fetch(`${url}/v2/methodology/rollout-policy`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-principal-id': 'operator-rollout' },
        body: JSON.stringify({ mode: 'opt-in-user', expected_revision: 2, extra: 'rejected' }),
      })
      expect(strict.status).toBe(422)

      const pin = await client.pinProjectMethodologyRollout(project.project_id, 'pi-rollout', {
        expected_project_pin_revision: 1,
        expected_policy_revision: updated.revision,
        expected_policy_hash: updated.policy_hash,
      })
      expect(pin).toMatchObject({ project_id: project.project_id, mode: 'opt-in-user', actor_ref: 'pi-rollout' })

      const compact = await client.getMethodology(project.project_id, 'pi-rollout')
      expect(compact.rollout).toEqual({
        mode: 'opt-in-user',
        policy_revision: 2,
        project_pin_revision: 2,
        telemetry: { counters: [], histograms: [] },
      })
      expect(JSON.stringify(compact.rollout)).not.toMatch(/policy_hash|actor_ref|project_id|session_id|token|secret/i)
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()))
      k.close()
    }
  })

  it('pins Knowledge activation and records suppressed/revoked/deactivated delivery without identity labels', () => {
    const options = paths()
    const k = open(options)
    const project = createProject(k, 'Knowledge rollout')
    k.linkSession('session-rollout', project.project_id, {
      principal_id: 'pi', tenant_id: '', issuer: 'kernel',
    })
    k.methodology.reconcileNativeKnowledgePacks()
    const policy = k.rollout.updatePolicy({ mode: 'opt-in-dev', expected_revision: 1, actor_ref: 'operator' })
    k.rollout.pinProject({
      project_id: project.project_id,
      expected_project_pin_revision: 1,
      expected_policy_revision: policy.revision,
      expected_policy_hash: policy.policy_hash,
      actor_ref: 'pi',
    })
    const pack = NATIVE_KNOWLEDGE_PACKS[0]!
    const action = k.projectProjection(project.project_id).next_actions_v2.find(item => item.state === 'ready')
      ?? k.projectProjection(project.project_id).next_actions_v2.find(item => item.state !== 'done')
    const activation = k.activateKnowledgePackageFromAuthority({
      project_id: project.project_id,
      session_id: 'session-rollout',
      principal_id: 'pi',
      package_name: pack.record.manifest.name,
      package_version: pack.record.manifest.version,
      manifest_sha256: pack.record.manifest_sha256,
      payload_sha256: pack.record.manifest.payload_sha256,
      explicit_human_activation: true,
      expected_revision: 0,
      expected_registry_revision: 6,
      expected_project_revision: project.revision,
      expected_next_action_revision: action?.revision ?? project.revision,
    })
    expect(k.rollout.consumptionPin(project.project_id, 'knowledge-activation', activation.record.activation_id))
      .toMatchObject({ mode: 'opt-in-dev', policy_revision: 2 })

    expect(k.resolveKnowledgeDelivery({
      project_id: project.project_id,
      session_id: 'wrong-session-sensitive',
      phase: project.status,
      next_action_revision: project.revision,
      surface: 'scholar-chat',
    }).suppressed[0]?.reason_codes).toEqual(['wrong_session'])
    k.deactivateKnowledgePackage({
      request: {
        project_id: project.project_id,
        session_id: 'session-rollout',
        activation_id: activation.record.activation_id,
        explicit_human_deactivation: true,
        reason: 'user-requested',
      },
      expected_revision: 1,
    })
    const aggregate = k.methodologyTelemetry.redactedAggregate()
    expect(aggregate.counters).toEqual(expect.arrayContaining([
      expect.objectContaining({
        key: 'methodology.knowledge.delivery_total',
        tags: { mode: 'opt-in-dev', outcome: 'suppressed', reason: 'wrong_session' },
      }),
      expect.objectContaining({
        key: 'methodology.knowledge.lifecycle_total',
        tags: { mode: 'opt-in-dev', event: 'deactivated' },
      }),
    ]))
    expect(JSON.stringify(aggregate)).not.toMatch(/wrong-session-sensitive|Knowledge rollout|scholar\.assurance\.review/)
    k.close()
    const reopened = open(options)
    expect(reopened.rollout.consumptionPin(project.project_id, 'knowledge-activation', activation.record.activation_id))
      .toMatchObject({ mode: 'opt-in-dev', policy_revision: 2, policy_hash: policy.policy_hash })
    reopened.close()
  })
})
