import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { generateKeyPairSync } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { ResearchClient } from '../../packages/research-client/src/index.js'
import { ResearchKernel, KernelError, canonicalManifestSha256 } from '../../packages/research-kernel/src/index.js'
import { startKernelServer } from '../../packages/research-kernel/src/server.js'
import { executeJob } from '../../workers/runner-gateway/src/index.js'
import {
  ResearchSynthesis,
  type ResearchRunOutcomeWrite,
  type SynthesisRecordRequest,
} from '@dsh-scholar/research-schemas'

const NOW = '2026-08-20T12:00:00.000Z'
const RUNNER_SERVICE_TOKEN = 'runner-outcome-fixture-service-token'

function brief() {
  return {
    problem: 'Classify completed experiment runs before drawing scientific conclusions.',
    scope: 'runner outcome lifecycle',
    questions: [],
    primary_metrics: ['accuracy'],
    resources: 'trusted local fixture',
    risks: [],
    target_outputs: ['paper'],
    target_venue: null,
    baseline_repo: null,
    domain: 'machine learning',
  }
}

function freshKernel(root: string): ResearchKernel {
  return new ResearchKernel({
    dbPath: join(root, 'kernel.db'),
    casRoot: join(root, 'cas'),
    serviceToken: RUNNER_SERVICE_TOKEN,
  })
}

function synthesisForRequest(request: SynthesisRecordRequest) {
  const hash = `sha256:${'a'.repeat(64)}` as const
  return ResearchSynthesis.parse({
    synthesis_id: 'synth_authority_bound_1',
    project_id: request.project_id,
    window: request.window,
    snapshot_pin: request.snapshot_pin,
    inputs: {
      accepted_evidence_refs: [],
      verified_evidence_refs: [],
      run_refs: [request.trigger_run_ref],
      corpus_snapshot_refs: [],
    },
    findings: {
      supported: [{
        provenance: 'explicit',
        statement: 'The classified run is the exact synthesis input.',
        source_refs: [{ kind: 'run', id: request.trigger_run_ref }],
      }],
      contradicted: [], negative: [], inconclusive: [], infrastructure_failures: [],
    },
    patterns: [], open_questions: [], constraints_learned: [],
    artifact_body_ref: 'artifact:synthesis-authority-bound',
    direction_proposal_id: null,
    confidence: 'medium',
    generated_by: 'agent',
    input_hash: hash,
    status: 'draft',
    adoption_ref: null,
    created_at: NOW,
  })
}

describe('Runner completion → classification → synthesis request lifecycle', () => {
  const kernels: ResearchKernel[] = []
  afterEach(() => {
    for (const kernel of kernels.splice(0)) {
      try { kernel.close() } catch { /* already closed */ }
    }
  })

  it('hashes every nested resource, environment, and output fact while accepting key reordering', () => {
    const manifest = {
      run_id: 'run_nested_hash',
      resources: { cpu: 8, memory_gb: 32 },
      environment: { image: 'fixture@sha256:' + 'a'.repeat(64), variables: { LC_ALL: 'C.UTF-8' } },
      outputs: { metrics: { artifact_id: 'sha256:' + 'b'.repeat(64), rows: 1 } },
    }
    const hash = canonicalManifestSha256(manifest)
    expect(canonicalManifestSha256({
      outputs: { metrics: { rows: 1, artifact_id: 'sha256:' + 'b'.repeat(64) } },
      environment: { variables: { LC_ALL: 'C.UTF-8' }, image: 'fixture@sha256:' + 'a'.repeat(64) },
      resources: { memory_gb: 32, cpu: 8 },
      run_id: 'run_nested_hash',
    })).toBe(hash)
    expect(canonicalManifestSha256({ ...manifest, resources: { ...manifest.resources, cpu: 64 } })).not.toBe(hash)
    expect(canonicalManifestSha256({
      ...manifest,
      environment: { ...manifest.environment, variables: { LC_ALL: 'en_US.UTF-8' } },
    })).not.toBe(hash)
    expect(canonicalManifestSha256({
      ...manifest,
      outputs: { metrics: { ...manifest.outputs.metrics, rows: 2 } },
    })).not.toBe(hash)
  })

  it('runs a real local fixture, persists only an unclassified observation, then projects classification and synthesis work', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-outcome-loop-'))
    let kernel = freshKernel(root)
    kernels.push(kernel)
    const project = kernel.createProject({
      name: 'outcome loop',
      workspace: '/work',
      brief: brief(),
      creator_principal_id: 'pi-loop',
      execution: {
        runner_profile_id: 'profile_isolated_subprocess_v1',
        runner_target_id: 'target_local_process_v1',
      },
    })
    const job = kernel.submitJob({
      project_id: project.project_id,
      idempotency_key: 'outcome-local-fixture',
      kind: 'echo',
      payload: { message: 'fixture completed without a scientific interpretation' },
      run_intent: 'exploratory',
      created_by_principal_id: 'pi-loop',
    })
    const { server, url } = await startKernelServer({ kernel, port: 0 })
    try {
      const client = new ResearchClient({ endpoint: url, serviceToken: RUNNER_SERVICE_TOKEN })
      expect((await fetch(`${url}/v2/projects/${project.project_id}/run-outcome-observations`)).status).toBe(422)
      expect((await fetch(`${url}/v2/projects/${project.project_id}/run-outcome-observations`, {
        headers: { 'x-principal-id': 'outsider' },
      })).status).toBe(404)
      const { privateKey, publicKey } = generateKeyPairSync('ed25519')
      await client.registerRunnerKey({
        key_id: 'runner-local-fixture',
        public_key_pem: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
      })
      const [claimed] = await client.claimJobs('local-fixture-runner', 1, 300, {
        runner_target_kinds: ['local-process'],
        runner_target_ids: ['target_local_process_v1'],
      })
      expect(claimed?.job_id).toBe(job.job_id)
      await expect(executeJob({ ...claimed!, run_id: null } as typeof claimed, {
        client,
        owner: 'local-fixture-runner',
        mode: 'subprocess',
        targetId: 'target_local_process_v1',
      })).rejects.toThrow('missing the Kernel claim run_id')
      await expect(executeJob({ ...claimed!, lease_token: null }, {
        client,
        owner: 'local-fixture-runner',
        mode: 'subprocess',
        targetId: 'target_local_process_v1',
      })).rejects.toThrow('missing the Kernel claim lease fencing fields')
      const completed = await executeJob(claimed!, {
        client,
        owner: 'local-fixture-runner',
        mode: 'subprocess',
        targetId: 'target_local_process_v1',
        signingKey: { keyId: 'runner-local-fixture', privateKey },
      })
      expect(completed.job.status).toBe('succeeded')

      const observations = await client.listRunOutcomeObservations(project.project_id, 'pi-loop')
      expect(observations).toMatchObject({
        project_id: project.project_id,
        pending_count: 1,
        observations: [{
          project_id: project.project_id,
          job_id: job.job_id,
          run_id: claimed!.run_id,
          attempt_no: 1,
          lease_generation: 1,
          job_execution: 'succeeded',
          intent: 'exploratory',
          protocol_pin: null,
        }],
      })
      expect(observations.observations[0]!.manifest_sha256).toMatch(/^sha256:[0-9a-f]{64}$/)
      expect(kernel.methodology.listResearchRunOutcomes(project.project_id).outcomes).toEqual([])
      expect(kernel.methodology.listNegativeFindings(project.project_id).findings).toEqual([])
      expect(kernel.methodology.listResearchClaimProposals(project.project_id).proposals).toEqual([])
      expect(kernel.getProject(project.project_id).status).toBe(project.status)
      expect(kernel.projectProjection(project.project_id).next_actions_v2).toEqual(expect.arrayContaining([
        expect.objectContaining({
          code: 'run_outcome_classify',
          state: 'ready',
          required_by: 'agent',
          refs: expect.arrayContaining([{ kind: 'run', id: claimed!.run_id }]),
        }),
      ]))

      const unclassified = kernel.listEvents(project.project_id).filter(event => event.kind === 'research.run.unclassified')
      expect(unclassified).toHaveLength(1)
      expect(unclassified[0]!.payload).toMatchObject(observations.observations[0]!)

      const classificationWrite: ResearchRunOutcomeWrite = {
        record: {
          run_ref: claimed!.run_id!,
          project_id: project.project_id,
          outcome: 'positive',
          validity: 'valid',
          analysis_artifact_id: null,
          evidence_refs: [],
          recorded_at: NOW,
        },
        claim_proposal: {
          proposal_id: 'claim_proposal_local_fixture',
          statement: 'The fixture observation is only an exploratory hypothesis proposal.',
        },
        expected_revision: 0,
      }
      kernel.db.exec(`
        CREATE TRIGGER fail_synthesis_request
        BEFORE INSERT ON events
        WHEN NEW.kind = 'research.synthesis.requested'
        BEGIN SELECT RAISE(ABORT, 'fixture_synthesis_outbox_failure'); END;
      `)
      await expect(client.recordResearchRun(project.project_id, 'pi-loop', classificationWrite)).rejects.toBeDefined()
      expect(kernel.methodology.listResearchRunOutcomes(project.project_id).outcomes).toEqual([])
      expect(kernel.listRunOutcomeObservations(project.project_id).pending_count).toBe(1)
      kernel.db.exec('DROP TRIGGER fail_synthesis_request')

      const receipt = await client.recordResearchRun(project.project_id, 'pi-loop', classificationWrite)
      expect(receipt.outcome).toMatchObject({
        run: {
          run_ref: claimed!.run_id,
          project_id: project.project_id,
          job_execution: 'succeeded',
          intent: 'exploratory',
          outcome: 'positive',
          validity: 'valid',
          protocol_pin: null,
        },
        classification: { interpretation: 'hypothesis_proposal', claim_authority: 'proposal_only' },
        negative_finding: null,
        claim_proposal: { proposal_kind: 'hypothesis', authority: 'proposal_only' },
      })
      expect(kernel.projectProjection(project.project_id).next_actions_v2).toEqual(expect.arrayContaining([
        expect.objectContaining({ code: 'synthesis_record', state: 'ready', required_by: 'agent' }),
      ]))
      expect(kernel.projectProjection(project.project_id).next_actions_v2.some(action => action.code === 'run_outcome_classify')).toBe(false)
      expect(kernel.listEvents(project.project_id).filter(event => event.kind === 'research.run.classified')).toEqual([
        expect.objectContaining({
          payload: expect.objectContaining({ classified_by_principal_id: 'pi-loop' }),
        }),
      ])
      expect(kernel.getProject(project.project_id).status).toBe(project.status)
      expect(kernel.listClaims(project.project_id)).toEqual([])
      expect(kernel.listAcceptedEvidence(project.project_id)).toEqual([])

      const [request] = (await client.listSynthesisRecordRequests(project.project_id, 'pi-loop')).pending
      expect(request).toBeDefined()
      const validSynthesis = synthesisForRequest(request!)
      await expect(client.recordSynthesis(project.project_id, 'pi-loop', {
        request_id: 'synthesis_request_missing',
        record: validSynthesis,
        expected_revision: 0,
      })).rejects.toMatchObject({ status: 422, code: 'synthesis_request_not_pending' })
      expect(kernel.methodology.listResearchSyntheses(project.project_id).records).toEqual([])

      await expect(client.recordSynthesis(project.project_id, 'pi-loop', {
        request_id: request!.request_id,
        record: { ...validSynthesis, window: { ...validSynthesis.window, from_event_seq: validSynthesis.window.from_event_seq + 1 } },
        expected_revision: 0,
      })).rejects.toMatchObject({ status: 422, code: 'synthesis_request_binding_mismatch' })
      expect(kernel.methodology.listResearchSyntheses(project.project_id).records).toEqual([])

      await expect(client.recordSynthesis(project.project_id, 'pi-loop', {
        request_id: request!.request_id,
        record: { ...validSynthesis, inputs: { ...validSynthesis.inputs, run_refs: ['run_unbound'] } },
        expected_revision: 0,
      })).rejects.toMatchObject({ status: 422, code: 'synthesis_request_binding_mismatch' })
      expect(kernel.methodology.listResearchSyntheses(project.project_id).records).toEqual([])

      await client.recordSynthesis(project.project_id, 'pi-loop', {
        request_id: request!.request_id,
        record: validSynthesis,
        expected_revision: 0,
      })
      expect(kernel.listSynthesisRecordRequests(project.project_id).pending).toEqual([])
      expect(kernel.projectProjection(project.project_id).next_actions_v2.some(action => action.code === 'synthesis_record')).toBe(false)
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()))
    }

    kernel.close()
    kernels.splice(kernels.indexOf(kernel), 1)
    kernel = freshKernel(root)
    kernels.push(kernel)
    expect(kernel.listRunOutcomeObservations(project.project_id)).toMatchObject({ pending_count: 0 })
    expect(kernel.listSynthesisRecordRequests(project.project_id).pending).toEqual([])
    expect(kernel.methodology.listResearchSyntheses(project.project_id).records).toHaveLength(1)
  })

  it('rolls back completion if the observation outbox append fails, and fences stale attempts without observations', () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-outcome-atomic-'))
    const kernel = freshKernel(root)
    kernels.push(kernel)
    const project = kernel.createProject({
      name: 'atomic outcome', workspace: '/work', brief: brief(), creator_principal_id: 'pi-atomic',
      execution: { runner_profile_id: 'profile_isolated_subprocess_v1', runner_target_id: 'target_local_process_v1' },
    })
    const job = kernel.submitJob({ project_id: project.project_id, idempotency_key: 'atomic', kind: 'echo' })
    const [first] = kernel.claimJobs('runner-atomic', 0, 1, { runner_target_ids: ['target_local_process_v1'] })
    expect(first?.job_id).toBe(job.job_id)
    expect(kernel.recoverExpiredLeases(Date.now() + 1_000)).toBe(1)
    const [second] = kernel.claimJobs('runner-atomic', 300, 1, { runner_target_ids: ['target_local_process_v1'] })
    expect(second?.attempts).toBe(2)

    expect(() => kernel.completeJob({
      job_id: job.job_id,
      owner: 'runner-atomic',
      status: 'succeeded',
      lease_generation: first!.lease_generation,
      lease_token: first!.lease_token,
    })).toThrowError(expect.objectContaining<Partial<KernelError>>({ status: 409, code: 'lease_stale' }))
    expect(kernel.listRunOutcomeObservations(project.project_id).observations).toEqual([])

    kernel.db.exec(`
      CREATE TRIGGER fail_unclassified_observation
      BEFORE INSERT ON events
      WHEN NEW.kind = 'research.run.unclassified'
      BEGIN SELECT RAISE(ABORT, 'fixture_outbox_failure'); END;
    `)
    expect(() => kernel.completeJob({
      job_id: job.job_id,
      owner: 'runner-atomic',
      status: 'succeeded',
      lease_generation: second!.lease_generation,
      lease_token: second!.lease_token,
    })).toThrow('fixture_outbox_failure')
    expect(kernel.getJob(job.job_id).status).toBe('running')
    expect(kernel.getRun(project.project_id, second!.run_id!).finished_at).toBeNull()
    expect(kernel.listRunOutcomeObservations(project.project_id).observations).toEqual([])

    kernel.db.exec('DROP TRIGGER fail_unclassified_observation')
    kernel.completeJob({
      job_id: job.job_id,
      owner: 'runner-atomic',
      status: 'succeeded',
      lease_generation: second!.lease_generation,
      lease_token: second!.lease_token,
    })
    expect(kernel.listRunOutcomeObservations(project.project_id)).toMatchObject({
      pending_count: 1,
      observations: [{ run_id: second!.run_id, attempt_no: 2, lease_generation: 2 }],
    })
    expect(kernel.listEvents(project.project_id).filter(event => event.kind === 'research.run.unclassified')).toHaveLength(1)
  })

  it('rejects classification when a nested manifest fact changed after observation and preserves the pending receipt', () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-outcome-manifest-stale-'))
    const kernel = new ResearchKernel({
      dbPath: join(root, 'kernel.db'), casRoot: join(root, 'cas'), requireSignedManifest: false,
    })
    kernels.push(kernel)
    const project = kernel.createProject({
      name: 'nested manifest fence', workspace: '/work', brief: brief(), creator_principal_id: 'pi-manifest',
      execution: {
        runner_profile_id: 'profile_isolated_subprocess_v1',
        runner_target_id: 'target_local_process_v1',
      },
    })
    const job = kernel.submitJob({
      project_id: project.project_id,
      idempotency_key: 'nested-manifest-fence',
      kind: 'echo',
      run_intent: 'exploratory',
    })
    const [claimed] = kernel.claimJobs('runner-manifest', 300, 1, {
      runner_target_ids: ['target_local_process_v1'],
    })
    expect(claimed?.job_id).toBe(job.job_id)
    const bound = kernel.getJob(job.job_id)
    const manifest = {
      run_id: claimed!.run_id,
      job_id: job.job_id,
      project_id: project.project_id,
      contract_id: null,
      config_pin: bound.payload.project_config_pin,
      lease: { generation: claimed!.lease_generation },
      resources: { cpu: 8, memory_gb: 32 },
      environment: { image: 'fixture@sha256:' + 'a'.repeat(64), variables: { LC_ALL: 'C.UTF-8' } },
      outputs: { metrics: { artifact_id: 'sha256:' + 'b'.repeat(64), rows: 1 } },
    }
    kernel.completeJob({
      job_id: job.job_id,
      owner: 'runner-manifest',
      lease_generation: claimed!.lease_generation,
      lease_token: claimed!.lease_token,
      status: 'succeeded',
      run_manifest: manifest,
    })

    const changed = structuredClone(manifest)
    changed.resources.cpu = 64
    kernel.db.prepare('UPDATE jobs SET run_manifest = ? WHERE job_id = ?')
      .run(JSON.stringify(changed), job.job_id)
    const classification: ResearchRunOutcomeWrite = {
      record: {
        run_ref: claimed!.run_id!,
        project_id: project.project_id,
        outcome: 'positive',
        validity: 'valid',
        analysis_artifact_id: null,
        evidence_refs: [],
        recorded_at: NOW,
      },
      claim_proposal: {
        proposal_id: 'claim_proposal_nested_manifest',
        statement: 'Nested manifest authority must stay bound to its original observation.',
      },
      expected_revision: 0,
    }
    expect(() => kernel.recordResearchRunOutcome(classification, 'pi-manifest'))
      .toThrowError(expect.objectContaining<Partial<KernelError>>({
        status: 409,
        code: 'research_run_observation_stale',
      }))
    expect(kernel.methodology.listResearchRunOutcomes(project.project_id).outcomes).toEqual([])
    expect(kernel.listEvents(project.project_id).filter(event => event.kind === 'research.run.classified')).toEqual([])
    expect(kernel.listRunOutcomeObservations(project.project_id).pending_count).toBe(1)

    kernel.db.prepare('UPDATE jobs SET run_manifest = ? WHERE job_id = ?')
      .run(JSON.stringify(manifest), job.job_id)
    expect(kernel.recordResearchRunOutcome(classification, 'pi-manifest').outcome.run.run_ref).toBe(claimed!.run_id)
  })
})
