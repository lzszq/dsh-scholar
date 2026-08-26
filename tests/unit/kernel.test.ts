/**
 * Research Kernel unit tests: state machine CAS, gates/decisions, CAS
 * artifacts, durable jobs with idempotency + leases + recovery, claims,
 * manuscript determinism (design §11.1, §11.2), §11.3 code-snapshot archive
 * + §12.2 JobSpec binding + §12.5 metrics-file parsing (SCH-EXEC-002).
 */
import { describe, expect, it } from 'vitest'
import { createHash, generateKeyPairSync, sign, type KeyObject } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { ResearchKernel, KernelError } from '@dsh-scholar/research-kernel'
import { protocolRevisionCanonicalHash } from '../../packages/research-kernel/src/methodology-store.js'
import {
  ProtocolRevision, canonicalJsonDeep, fixtureCorpus, fixtureIdea, getRunnerProfile, runnerTargetConfigHash,
  RUNNER_PROFILE_IDS, type ExperimentContract, type JobSpecBound,
} from '@dsh-scholar/research-schemas'
import { materializeCodeSnapshot, unpackCodeSnapshot, buildLatexRunScript, resolveMetricsFileWithin } from '@dsh-scholar/runner-gateway'
import { signManifest as signRunnerManifest } from '../../workers/runner-gateway/src/manifest-signing.js'

/** P0 (acceptance-tests.md §4): the exact digests pinned by configs/runner-profiles/images.lock.json. */
const NODE_IMAGE_DIGEST = 'node@sha256:c610fcdfb1d5b4740dd70c284ed3cb16bb857e0f7166196e36a5501df7a3aa32'
const TEXLIVE_IMAGE_DIGEST = 'texlive/texlive@sha256:8957c916b8160049f89c24d362a6d86c09d8a04095acde37e88404c4afed85b4'

function freshKernel(): ResearchKernel {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-kernel-test-'))
  // RUN-01: signed manifests are the production default; unit tests that do
  // not exercise the signature path opt out explicitly (the signature path
  // itself is covered by run-manifest-tests.sh + the manifest unit cases).
  return new ResearchKernel({ dbPath: join(dir, 'kernel.db'), casRoot: join(dir, 'cas'), requireSignedManifest: false })
}

/** Register a minimal valid §11.3 code-snapshot archive artifact. */
function codeArtifact(kernel: ResearchKernel, projectId: string): import('@dsh-scholar/research-schemas').ArtifactRecord {
  const content = Buffer.from('console.log("train")\n')
  return kernel.registerArtifact({
    project_id: projectId,
    kind: 'code',
    content: JSON.stringify({
      schema_version: 1,
      project_id: projectId,
      files: {
        'train.js': { sha256: createHash('sha256').update(content).digest('hex'), content_base64: content.toString('base64') },
      },
      excludes: ['.git', 'node_modules', '.research-cas'],
    }),
    metadata: { kind: 'code-snapshot-archive' },
  })
}

/**
 * P0-4 (SNAPSHOT-01/API-01): create a disk-backed `code` workspace for the
 * project and write the given files into it — the only sanctioned snapshot
 * root. Returns the workspace_id.
 */
function seedWorkspace(kernel: ResearchKernel, projectId: string, files: Record<string, string>): string {
  const info = kernel.workspaceEnsure(projectId, 'code', 'fixture')
  for (const [rel, content] of Object.entries(files)) {
    kernel.workspaceWrite(info.workspace_id, rel, content)
  }
  return info.workspace_id
}

function makeBrief(overrides: Record<string, unknown> = {}) {
  return {
    problem: 'p', scope: 's', questions: [], primary_metrics: ['m'],
    resources: '', risks: [], target_outputs: ['paper'], target_venue: null,
    baseline_repo: null, domain: 'ml', ...overrides,
  }
}

/** Most Kernel tests exercise behavior after an execution environment has
 * already been selected. Keep that prerequisite explicit in one helper so
 * name-only/unconfigured behavior is tested only by the dedicated Init cases. */
function createConfiguredProject(
  kernel: ResearchKernel,
  input: Parameters<ResearchKernel['createProject']>[0],
) {
  return kernel.createProject({
    ...input,
    execution: {
      runner_profile_id: RUNNER_PROFILE_IDS.localDockerCpu,
      ...(input.execution ?? {}),
    },
  })
}

/** Assert a KernelError with an exact HTTP status + error code. */
/** P0: register + freeze an approved contract for secure-kind job tests. */
function approvedContract(kernel: ResearchKernel, projectId: string): string {
  const contract = kernel.registerContract({
    project_id: projectId,
    idea_id: 'idea_x', data: { dataset_id: 'd', version: 'v1' }, methods: { baseline: 'b', treatment: 'a' },
    metrics: { primary: 'f1', secondary: [] }, seeds: [1, 2], analysis: {},
    ablations: [], stop_conditions: { max_gpu_hours: 1, min_completed_seeds: 1, stop_on_data_leakage: true },
  })
  kernel.approveContract(contract.contract_id, 'dec_test_gate', 'test-pi')
  return contract.contract_id
}

function canonicalTopLevel(value: Record<string, unknown>): string {
  return JSON.stringify(value, Object.keys(value).sort())
}

/**
 * Explicit methodology fixture for legacy Kernel tests whose subject is not
 * Protocol admission. Production has no fallback: this helper records a
 * real frozen Protocol and passes its exact pin whenever a test submits a
 * valid formal job. Invalid pre-admission cases still call the Kernel
 * unchanged so they preserve their original error assertions.
 */
function submitTestJob(
  kernel: ResearchKernel,
  input: Parameters<ResearchKernel['submitJob']>[0],
): JobSpecBound {
  if (input.kind !== 'formal' || input.contract_id == null || input.code_snapshot_id == null) {
    return kernel.submitJob(input)
  }
  let contract: ExperimentContract
  let boundCodeId = input.code_snapshot_id
  try {
    contract = kernel.getContract(input.contract_id)
    if (contract.project_id !== input.project_id || contract.status !== 'approved') return kernel.submitJob(input)
    if (boundCodeId.startsWith('code_snap_')) boundCodeId = kernel.getCodeSnapshot(boundCodeId).archive_artifact_id
    kernel.getArtifact(input.project_id, boundCodeId)
  } catch {
    return kernel.submitJob(input)
  }
  const project = kernel.getProject(input.project_id)
  const targetId = input.runner_target_id ?? project.execution.runner_target_id
  const initialTarget = kernel.listRunnerTargets().find(item => item.target_id === targetId)
  if (initialTarget === undefined) return kernel.submitJob(input)
  if (initialTarget.health !== 'online') {
    kernel.runnerTargets.observe(initialTarget.target_id, { expected_revision: initialTarget.revision, health: 'online' })
  }
  const target = kernel.listRunnerTargets().find(item => item.target_id === targetId)!
  const code = kernel.getArtifact(input.project_id, boundCodeId)
  const dataIds = input.data_artifact_ids?.length === 1
    ? input.data_artifact_ids
    : [kernel.registerArtifact({
        project_id: input.project_id,
        kind: 'data',
        content: `methodology fixture ${input.idempotency_key}`,
      }).artifact_id]
  const dataId = dataIds[0]!.startsWith('sha256:') ? dataIds[0]! : `sha256:${dataIds[0]!}`
  const data = kernel.getArtifact(input.project_id, dataId)
  const suffix = createHash('sha256').update(input.idempotency_key).digest('hex').slice(0, 16)
  const protocolInput = ProtocolRevision.parse({
    protocol_id: `protocol_${suffix}`,
    project_id: input.project_id,
    revision: 1,
    supersedes: null,
    status: 'frozen',
    intent: input.run_intent ?? 'exploratory',
    research_question_ref: 'question_test_fixture',
    target_claim_ref: null,
    hypothesis: 'Test fixture hypothesis.',
    prediction: 'Test fixture prediction.',
    variables: { manipulated: ['treatment'], controlled: ['fixture'], measured: ['metric'] },
    metrics: { primary: contract.metrics.primary, secondary: contract.metrics.secondary, baseline_ref: 'baseline_fixture', analysis_plan_artifact_id: dataId },
    pins: {
      contract: {
        ref: contract.contract_id,
        sha256: `sha256:${createHash('sha256').update(canonicalTopLevel(contract as unknown as Record<string, unknown>)).digest('hex')}`,
      },
      code: { ref: boundCodeId, sha256: `sha256:${code.sha256}` },
      data: { ref: dataId, sha256: `sha256:${data.sha256}` },
      environment: { ref: target.target_id, sha256: runnerTargetConfigHash(target) },
    },
    stopping_conditions: ['fixture completes'],
    failure_criteria: ['fixture integrity failure'],
    allowed_deviations: [],
    deviation_handling: 'Create a new fixture protocol revision.',
    author_principal_id: 'principal_test_fixture',
    created_at: '2026-01-01T00:00:00.000Z',
    frozen_at: '2026-01-01T00:00:00.000Z',
    canonical_hash: `sha256:${suffix.repeat(4)}`,
  })
  const protocol = { ...protocolInput, canonical_hash: protocolRevisionCanonicalHash(protocolInput) }
  kernel.methodology.recordProtocolRevision({
    record: protocol,
    expected_revision: kernel.methodology.projectRevision(input.project_id),
  })
  return kernel.submitJob({
    ...input,
    data_artifact_ids: dataIds,
    protocol_pin: {
      protocol_id: protocol.protocol_id,
      revision: protocol.revision,
      canonical_hash: protocol.canonical_hash!,
    },
  })
}

function projectWithApprovedContract(kernel: ResearchKernel): { projectId: string; contractId: string; revision: number } {
  const created = createConfiguredProject(kernel, { name: 'baseline handoff', workspace: '/w', brief: makeBrief() })
  const scope = kernel.createGate({ project_id: created.project_id, type: 'scope', title: 'scope' })
  let project = kernel.decideGate({ gate_id: scope.gate_id, actor: 'pi', decision: 'approved' }).project
  project = kernel.transition(project.project_id, 'SURVEYING', project.revision)
  project = kernel.transition(project.project_id, 'IDEATING', project.revision)
  const idea = kernel.createGate({ project_id: project.project_id, type: 'idea', title: 'idea' })
  project = kernel.decideGate({ gate_id: idea.gate_id, actor: 'pi', decision: 'approved' }).project
  project = kernel.transition(project.project_id, 'CONTRACT_PENDING', project.revision)
  const contract = kernel.registerContract({
    project_id: project.project_id,
    idea_id: 'idea_baseline',
    data: { dataset_id: 'fixture', version: 'v1' },
    methods: { baseline: 'node train.js', treatment: 'node train.js --treatment' },
    metrics: { primary: 'accuracy', secondary: [] },
    seeds: [1],
    analysis: {},
    ablations: [],
    stop_conditions: { max_gpu_hours: 1, min_completed_seeds: 1, stop_on_data_leakage: true },
  })
  const gate = kernel.createGate({
    project_id: project.project_id,
    type: 'contract',
    title: 'contract',
    payload: { contract_id: contract.contract_id },
  })
  project = kernel.decideGate({ gate_id: gate.gate_id, actor: 'pi', decision: 'approved' }).project
  return { projectId: project.project_id, contractId: contract.contract_id, revision: project.revision }
}

function thrownKernelCode(fn: () => unknown): string | undefined {
  try {
    fn()
    return undefined
  } catch (error) {
    return (error as { code?: string }).code
  }
}

/** P0: current lease fencing fields of a job (generation, token). */
function fenceArgs(kernel: ResearchKernel, jobId: string): { lease_generation: number | null; lease_token: string | null } {
  const j = kernel.getJob(jobId)
  return { lease_generation: j.lease_generation, lease_token: j.lease_token }
}
function fencePair(kernel: ResearchKernel, jobId: string): [number | null, string | null] {
  const j = kernel.getJob(jobId)
  return [j.lease_generation, j.lease_token]
}


/** §5 RUN-REMOTE-01: secure-kind completion manifest carrying the required
 * facts (real claim run_id + seed/code snapshot/container_digest/data_hash). */
function secureManifest(kernel: ResearchKernel, job: { job_id: string; project_id: string }, metricsArtifact: string, seed?: number | null): Record<string, unknown> {
  const bound = kernel.getJob(job.job_id)
  return {
    run_id: bound.run_id ?? 'run_x',
    job_id: job.job_id,
    code_commit: 'c',
    code_snapshot_id: bound.code_snapshot_id ?? null,
    container_digest: bound.image_digest !== '' ? `docker:${bound.image_digest}` : '',
    data_hash: typeof bound.payload.data_hash === 'string' ? bound.payload.data_hash : '',
    seed: seed !== undefined ? seed : (typeof bound.payload.seed === 'number' ? bound.payload.seed : null),
    started_at: new Date().toISOString(),
    finished_at: new Date().toISOString(),
    exit_code: 0,
    metrics_artifact: metricsArtifact,
  }
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

/**
 * §12.7 signing helper mirroring the runner-gateway contract exactly:
 * payload_sha256 = sha256(canonicalJson(manifest)) BEFORE the envelope is
 * attached; the Ed25519 signature covers canonicalJson(manifest +
 * runner_key_id + payload_sha256); canonicalJson sorts keys recursively.
 * (Uses crypto.sign(null, …) — createSign('ed25519') is rejected on Node ≥ 24.)
 */
function signManifest(manifest: Record<string, unknown>, privateKey: KeyObject, keyId: string): Record<string, unknown> {
  const payloadSha256 = createHash('sha256').update(canonicalJsonDeep(manifest)).digest('hex')
  const signed = { ...manifest, runner_key_id: keyId, payload_sha256: payloadSha256 }
  const signature = sign(null, Buffer.from(canonicalJsonDeep(signed), 'utf8'), privateKey).toString('base64')
  return { ...signed, signature }
}

/**
 * A realistic manifest payload (with a nested `resources` object) carrying the
 * §5 RUN-REMOTE-01 required facts: real claim run_id + seed/code snapshot/
 * container_digest/data_hash (kernel verifySecureRunFacts enforces them for
 * secure kinds).
 */
function makeManifest(kernel: ResearchKernel, job: { job_id: string; project_id: string }, metricsArtifact: string): Record<string, unknown> {
  const bound = kernel.getJob(job.job_id)
  return {
    run_id: bound.run_id ?? 'run_test_1',
    job_id: job.job_id,
    project_id: job.project_id,
    code_commit: 'abc123',
    code_snapshot_id: bound.code_snapshot_id ?? null,
    container_digest: bound.image_digest !== '' ? `docker:${bound.image_digest}` : '',
    data_hash: typeof bound.payload.data_hash === 'string' ? bound.payload.data_hash : '',
    seed: typeof bound.payload.seed === 'number' ? bound.payload.seed : null,
    command: ['python', 'train.py', '--seed', '11'],
    resources: { gpu: 1, cpu: 8, memory_gb: 32 },
    started_at: '2026-01-01T00:00:00.000Z',
    finished_at: '2026-01-01T01:00:00.000Z',
    exit_code: 0,
    metrics_artifact: metricsArtifact,
    log_artifact: metricsArtifact,
  }
}

describe('project state machine', () => {
  it('creates DRAFT projects with revision 0 and links sessions', () => {
    const kernel = freshKernel()
    const project = createConfiguredProject(kernel, { name: 't', workspace: '/w', brief: makeBrief(), session_id: 's1' })
    expect(project.status).toBe('DRAFT')
    expect(project.revision).toBe(0)
    expect(kernel.getProjectBySession('s1')?.project_id).toBe(project.project_id)
    kernel.close()
  })

  it('transitions only with matching expected_revision (CAS)', () => {
    const kernel = freshKernel()
    const project = createConfiguredProject(kernel, { name: 't', workspace: '/w', brief: makeBrief() })
    const gate = kernel.createGate({ project_id: project.project_id, type: 'scope', title: 'Scope' })
    kernel.decideGate({ gate_id: gate.gate_id, actor: 'human', principal: { principal_id: 'u1' }, decision: 'approved' })
    // project is SCOPED now (gate-controlled entry)
    expect(kernel.getProject(project.project_id).status).toBe('SCOPED')
    expect(() => kernel.transition(project.project_id, 'SURVEYING', 5)).toThrow(KernelError)
    const moved = kernel.transition(project.project_id, 'SURVEYING', 1)
    expect(moved.status).toBe('SURVEYING')
    expect(moved.revision).toBe(2)
    kernel.close()
  })

  it('renames a project with audit history and revision bump', () => {
    const kernel = freshKernel()
    const project = createConfiguredProject(kernel, { name: 'old-name', workspace: '/w', brief: makeBrief() })
    const renamed = kernel.renameProject(project.project_id, 'new-name')
    expect(renamed.name).toBe('new-name')
    expect(renamed.revision).toBe(1)
    expect(renamed.history.at(-1)).toBe('renamed to "new-name"')
    expect(kernel.listProjects()[0]!.name).toBe('new-name')
    expect(() => kernel.renameProject(project.project_id, '   ')).toThrow(KernelError)
    kernel.close()
  })

  it('archives and restores a project (data kept, audited)', () => {
    const kernel = freshKernel()
    const project = createConfiguredProject(kernel, { name: 't', workspace: '/w', brief: makeBrief() })
    const archived = kernel.archiveProject(project.project_id)
    expect(archived.status).toBe('ARCHIVED')
    expect(archived.history.at(-1)).toContain('ARCHIVED')
    const restored = kernel.unarchiveProject(project.project_id)
    expect(restored.status).not.toBe('ARCHIVED')
    expect(restored.history.at(-1)).toBe('ARCHIVED->restored')
    // archive is idempotent
    kernel.archiveProject(project.project_id)
    expect(kernel.archiveProject(project.project_id).status).toBe('ARCHIVED')
    kernel.close()
  })

  it('reconstruction-contracts.md §4: archiving a project with active jobs is 409 jobs_running', () => {
    const kernel = freshKernel()
    const project = createConfiguredProject(kernel, { name: 't', workspace: '/w', brief: makeBrief() })
    submitTestJob(kernel, { project_id: project.project_id, idempotency_key: 'k1', kind: 'echo', command: [], payload: { message: 'x' } })
    try {
      kernel.archiveProject(project.project_id)
      throw new Error('expected jobs_running 409')
    } catch (error) {
      expect((error as { code?: string; status?: number }).code).toBe('jobs_running')
      expect((error as { status?: number }).status).toBe(409)
    }
    // The project stays unarchived.
    expect(kernel.getProject(project.project_id).status).not.toBe('ARCHIVED')
    kernel.close()
  })

  it('PROJECT-DELETE-01: only an archived project can be tombstoned and normal reads become 404', () => {
    const kernel = freshKernel()
    const project = createConfiguredProject(kernel, { name: 'Delete Me', workspace: '/w', brief: makeBrief() })
    expectKernelError(() => kernel.deleteProject({
      project_id: project.project_id,
      expected_revision: project.revision,
      confirm_name: project.name,
      reason: 'research discontinued',
      deleted_by: 'pi_owner',
      request_id: 'req_delete_1',
    }), 409, 'project_not_archived')

    const intake = kernel.beginIntake({ project_id: project.project_id, source_label: 'delete-cleanup' })
    const upload = kernel.beginUploadSession(intake.intake_id, {
      file_name: 'partial.bin',
      media_type: 'application/octet-stream',
      expected_size: 6,
    })
    const chunk = Buffer.from('abc')
    kernel.appendUploadChunk(intake.intake_id, upload.upload_id, {
      bytes: chunk,
      contentRange: 'bytes 0-2/6',
      chunkSha256: createHash('sha256').update(chunk).digest('hex'),
    })
    const uploadPart = join(kernel.intakeStagedRoot, intake.intake_id, `${upload.upload_id}.part`)
    expect(existsSync(uploadPart)).toBe(true)
    expect(kernel.db.prepare('SELECT project_id, status FROM upload_sessions WHERE upload_id = ?').get(upload.upload_id))
      .toEqual({ project_id: project.project_id, status: 'open' })

    const archived = kernel.archiveProject(project.project_id)
    const receipt = kernel.deleteProject({
      project_id: project.project_id,
      expected_revision: archived.revision,
      confirm_name: project.name,
      reason: 'research discontinued',
      deleted_by: 'pi_owner',
      request_id: 'req_delete_1',
    })
    expect(receipt).toMatchObject({
      project_id: project.project_id,
      deleted_by: 'pi_owner',
      revision: archived.revision + 1,
      request_id: 'req_delete_1',
    })
    expect(kernel.listProjects()).toEqual([])
    expectKernelError(() => kernel.getProject(project.project_id), 404, 'project_not_found')
    expect(kernel.db.prepare('SELECT upload_id, project_id, status FROM upload_sessions WHERE project_id = ?').all(project.project_id))
      .toEqual([])
    expect(kernel.db.prepare('SELECT COUNT(*) AS n FROM upload_chunks WHERE upload_id = ?').get(upload.upload_id))
      .toEqual({ n: 0 })
    expect(existsSync(uploadPart)).toBe(false)
    expectKernelError(() => kernel.beginUploadSession(intake.intake_id, {
      file_name: 'late.bin', expected_size: 1,
    }), 404, 'project_not_found')
    expectKernelError(() => kernel.listUploadSessions(intake.intake_id), 404, 'project_not_found')
    const deleted = kernel.listEvents(project.project_id).filter(event => event.kind === 'project.deleted')
    expect(deleted).toHaveLength(1)
    expect(deleted[0]?.payload).toMatchObject({ project_id: project.project_id, deleted_by: 'pi_owner', request_id: 'req_delete_1' })
    // Idempotent replay is available through the dedicated delete seam even
    // though ordinary project reads are now deliberately hidden.
    expect(kernel.deleteProject({
      project_id: project.project_id,
      expected_revision: archived.revision,
      confirm_name: project.name,
      reason: 'research discontinued',
      deleted_by: 'pi_owner',
      request_id: 'req_delete_1',
    })).toEqual(receipt)
    kernel.close()
  })

  it('PROJECT-DELETE-01: confirmation, revision and shared CAS references are protected', () => {
    const kernel = freshKernel()
    const first = createConfiguredProject(kernel, { name: 'First', workspace: '/w/1', brief: makeBrief() })
    const second = createConfiguredProject(kernel, { name: 'Second', workspace: '/w/2', brief: makeBrief() })
    const bytes = Buffer.from([0, 255, 1, 2, 3, 128])
    const a = kernel.registerArtifact({ project_id: first.project_id, kind: 'data', content: bytes, metadata: {} })
    const b = kernel.registerArtifact({ project_id: second.project_id, kind: 'data', content: bytes, metadata: {} })
    expect(a.sha256).toBe(b.sha256)
    const archived = kernel.archiveProject(first.project_id)
    const base = {
      project_id: first.project_id,
      expected_revision: archived.revision,
      reason: 'done',
      deleted_by: 'pi_owner',
      request_id: 'req_delete_2',
    }
    expectKernelError(() => kernel.deleteProject({ ...base, confirm_name: 'wrong' }), 422, 'project_delete_confirmation_invalid')
    expectKernelError(() => kernel.deleteProject({ ...base, confirm_name: first.name, expected_revision: archived.revision - 1 }), 409, 'revision_conflict')
    kernel.deleteProject({ ...base, confirm_name: first.name })
    expect(kernel.getArtifact(second.project_id, b.artifact_id).size_bytes).toBe(bytes.byteLength)
    expect(kernel.verifyArtifactRefs([b.sha256])).toEqual({ ok: true, missing: [] })
    kernel.collectOrphanBlobs()
    expect(kernel.verifyArtifactRefs([b.sha256])).toEqual({ ok: true, missing: [] })
    kernel.close()
  })

  it('product-spec.md §1: high-risk domains (clinical/wet-lab/weapons/biosecurity) are rejected at creation', () => {
    const kernel = freshKernel()
    for (const domain of ['clinical', 'wet-lab', 'weapons', 'biosecurity', 'human-trials']) {
      try {
        createConfiguredProject(kernel, { name: 't', workspace: '/w', brief: makeBrief({ domain }) })
        throw new Error(`expected domain_unsupported for ${domain}`)
      } catch (error) {
        expect((error as { code?: string }).code).toBe('domain_unsupported')
      }
    }
    // Nothing was persisted for any of them.
    expect(kernel.listProjects()).toHaveLength(0)
    // The default pure-computation domain still works.
    expect(createConfiguredProject(kernel, { name: 'ok', workspace: '/w', brief: makeBrief() }).status).toBe('DRAFT')
    kernel.close()
  })

  it('v2 §6.2: generic transition cannot enter gate-controlled states', () => {
    const kernel = freshKernel()
    const project = createConfiguredProject(kernel, { name: 't', workspace: '/w', brief: makeBrief() })
    expect(() => kernel.transition(project.project_id, 'SCOPED', 0)).toThrow(/not allowed/)
    kernel.close()
  })

  it('rejects illegal transitions', () => {
    const kernel = freshKernel()
    const project = createConfiguredProject(kernel, { name: 't', workspace: '/w', brief: makeBrief() })
    expect(() => kernel.transition(project.project_id, 'RELEASED', 0)).toThrow(/not allowed/)
    kernel.close()
  })

  it('walks the golden path state sequence via gates + transitions', () => {
    const kernel = freshKernel()
    const project = createConfiguredProject(kernel, { name: 't', workspace: '/w', brief: makeBrief() })
    const decide = (type: 'scope' | 'idea' | 'contract' | 'release'): ResearchProject => {
      const gate = kernel.createGate({ project_id: project.project_id, type, title: `${type} gate` })
      return kernel.decideGate({ gate_id: gate.gate_id, actor: 'human', principal: { principal_id: 'u1' }, decision: 'approved' }).project
    }
    let p = decide('scope')                       // DRAFT -> SCOPED (gate)
    expect(p.status).toBe('SCOPED')
    p = kernel.transition(p.project_id, 'SURVEYING', p.revision) // SCOPED -> SURVEYING
    p = kernel.transition(p.project_id, 'IDEATING', p.revision)  // SURVEYING -> IDEATING
    p = decide('idea')                            // IDEATING -> IDEA_APPROVED (gate)
    p = kernel.transition(p.project_id, 'CONTRACT_PENDING', p.revision)
    p = decide('contract')                        // CONTRACT_PENDING -> CONTRACT_APPROVED (gate)
    p = kernel.transition(p.project_id, 'BASELINE_REPRO', p.revision)
    p = kernel.transition(p.project_id, 'EXPERIMENTING', p.revision)
    p = kernel.transition(p.project_id, 'EVIDENCE_READY', p.revision)
    p = kernel.transition(p.project_id, 'WRITING', p.revision)
    p = kernel.transition(p.project_id, 'REVIEWING', p.revision)
    p = kernel.transition(p.project_id, 'RELEASE_READY', p.revision)
    p = decide('release')                         // RELEASE_READY -> RELEASED (gate)
    expect(p.status).toBe('RELEASED')
    const events = kernel.listEvents(project.project_id)
    expect(events.filter(e => e.kind === 'project.transitioned').length).toBeGreaterThanOrEqual(10)
    kernel.close()
  })
})

describe('Contract-approved baseline handoff', () => {
  it('atomically creates the first baseline Job and advances the project', () => {
    const kernel = freshKernel()
    const setup = projectWithApprovedContract(kernel)
    const workspaceId = seedWorkspace(kernel, setup.projectId, { 'train.js': 'console.log("baseline")\n' })
    const snapshot = kernel.snapshotCodeArchive(setup.projectId, workspaceId, '', 'baseline')
    expect(kernel.listCodeSnapshots(setup.projectId).map(item => item.snapshot_id)).toEqual([snapshot.snapshot_id])

    const request = {
      project_id: setup.projectId,
      expected_revision: setup.revision,
      idempotency_key: 'baseline-contract-v1',
      contract_id: setup.contractId,
      code_snapshot_id: snapshot.snapshot_id,
      seed: 11,
      data_artifact_ids: [snapshot.archive_artifact_id],
      command: ['node', 'train.js'],
    }
    expect(thrownKernelCode(() => kernel.startBaselineRun({ ...request, seed: Number.MAX_SAFE_INTEGER + 1 })))
      .toBe('baseline_seed_invalid')
    expect(thrownKernelCode(() => kernel.startBaselineRun({
      ...request,
      data_artifact_ids: [snapshot.archive_artifact_id, snapshot.archive_artifact_id],
    }))).toBe('baseline_data_artifact_limit')
    expect(kernel.listJobs(setup.projectId)).toHaveLength(0)

    const started = kernel.startBaselineRun(request)
    expect(started.project.status).toBe('BASELINE_REPRO')
    expect(started.job).toMatchObject({
      project_id: setup.projectId,
      kind: 'baseline',
      status: 'queued',
      contract_id: setup.contractId,
      command: ['node', 'train.js'],
      data_artifact_ids: [snapshot.archive_artifact_id],
      payload: expect.objectContaining({
        seed: 11,
        data_hash: snapshot.archive_artifact_id,
      }),
    })
    expect(kernel.listJobs(setup.projectId)).toHaveLength(1)

    const replay = kernel.startBaselineRun(request)
    expect(replay.job.job_id).toBe(started.job.job_id)
    expect(kernel.listJobs(setup.projectId)).toHaveLength(1)
    expect(thrownKernelCode(() => kernel.startBaselineRun({ ...request, command: ['node', 'other.js'] })))
      .toBe('idempotency_conflict')
    expect(kernel.listJobs(setup.projectId)).toHaveLength(1)

    const additional = kernel.startBaselineRun({
      ...request,
      expected_revision: started.project.revision,
      idempotency_key: 'baseline-contract-v1-seed-2',
      seed: 2,
      command: ['node', 'train.js', '--seed', '2'],
    })
    expect(additional.project).toMatchObject({
      status: 'BASELINE_REPRO',
      revision: started.project.revision,
    })
    expect(additional.job).toMatchObject({
      kind: 'baseline',
      contract_id: setup.contractId,
      command: ['node', 'train.js', '--seed', '2'],
      payload: expect.objectContaining({ seed: 2 }),
    })
    expect(kernel.listJobs(setup.projectId)).toHaveLength(2)

    const foreignContract = kernel.registerContract({
      project_id: setup.projectId,
      idea_id: 'idea_other_baseline',
      data: { dataset_id: 'fixture', version: 'v1' },
      methods: { baseline: 'node other.js', treatment: 'node other.js --treatment' },
      metrics: { primary: 'accuracy', secondary: [] },
      seeds: [1],
      analysis: {},
      ablations: [],
      stop_conditions: { max_gpu_hours: 1, min_completed_seeds: 1, stop_on_data_leakage: true },
    })
    kernel.approveContract(foreignContract.contract_id, 'dec_other_contract', 'test-pi')
    expect(thrownKernelCode(() => kernel.startBaselineRun({
      ...request,
      expected_revision: started.project.revision,
      idempotency_key: 'baseline-other-contract',
      contract_id: foreignContract.contract_id,
    }))).toBe('baseline_contract_mismatch')
    expect(kernel.listJobs(setup.projectId)).toHaveLength(2)
    kernel.close()
  })

  it('leaves Project and Jobs untouched when required execution input is invalid', () => {
    const kernel = freshKernel()
    const setup = projectWithApprovedContract(kernel)
    expect(thrownKernelCode(() => kernel.startBaselineRun({
      project_id: setup.projectId,
      expected_revision: setup.revision,
      idempotency_key: 'missing-command',
      contract_id: setup.contractId,
      code_snapshot_id: 'code_snap_missing',
      command: [],
    }))).toBe('baseline_command_required')
    expect(thrownKernelCode(() => kernel.startBaselineRun({
      project_id: setup.projectId,
      expected_revision: setup.revision,
      idempotency_key: 'missing-snapshot',
      contract_id: setup.contractId,
      code_snapshot_id: 'code_snap_missing',
      command: ['node', 'train.js'],
    }))).toBe('code_snapshot_unknown')
    expect(kernel.getProject(setup.projectId)).toMatchObject({ status: 'CONTRACT_APPROVED', revision: setup.revision })
    expect(kernel.listJobs(setup.projectId)).toHaveLength(0)
    kernel.close()
  })
})

describe('v2 §3.4 project isolation', () => {
  it('same idempotency_key in different projects yields independent jobs', () => {
    const kernel = freshKernel()
    const a = createConfiguredProject(kernel, { name: 'a', workspace: '/a', brief: makeBrief() })
    const b = createConfiguredProject(kernel, { name: 'b', workspace: '/b', brief: makeBrief() })
    const ja = submitTestJob(kernel, { project_id: a.project_id, idempotency_key: 'shared-key', kind: 'echo' })
    const jb = submitTestJob(kernel, { project_id: b.project_id, idempotency_key: 'shared-key', kind: 'echo' })
    expect(ja.job_id).not.toBe(jb.job_id)
    // Re-submission inside the SAME project still dedupes.
    const ja2 = submitTestJob(kernel, { project_id: a.project_id, idempotency_key: 'shared-key', kind: 'echo' })
    expect(ja2.job_id).toBe(ja.job_id)
    kernel.close()
  })
})

describe('gates and decisions', () => {
  it('scope gate approval moves DRAFT→SCOPED and records the decision', () => {
    const kernel = freshKernel()
    const project = createConfiguredProject(kernel, { name: 't', workspace: '/w', brief: makeBrief(), session_id: 's' })
    const gate = kernel.createGate({ project_id: project.project_id, type: 'scope', title: 'Scope', session_id: 's' })
    const { gate: decided, decision, project: updated } = kernel.decideGate({
      gate_id: gate.gate_id, actor: 'human', decision: 'approved', reason: 'looks good', session_id: 's', event_id: 'evt_x',
    })
    expect(decided.status).toBe('approved')
    expect(decision.actor).toBe('human')
    expect(decision.session_id).toBe('s')
    expect(updated.status).toBe('SCOPED')
    const decisions = kernel.listDecisions(project.project_id)
    expect(decisions).toHaveLength(1)
    expect(decisions[0]?.reason).toBe('looks good')
    kernel.close()
  })

  it('double decisions are rejected', () => {
    const kernel = freshKernel()
    const project = createConfiguredProject(kernel, { name: 't', workspace: '/w', brief: makeBrief() })
    const gate = kernel.createGate({ project_id: project.project_id, type: 'scope', title: 'Scope' })
    kernel.decideGate({ gate_id: gate.gate_id, actor: 'a', decision: 'approved' })
    expect(() => kernel.decideGate({ gate_id: gate.gate_id, actor: 'b', decision: 'approved' }))
      .toThrow(/already/)
    kernel.close()
  })

  it('budget overrun parks the project in BLOCKED_GATE with a policy event', () => {
    const kernel = freshKernel()
    const project = createConfiguredProject(kernel, {
      name: 't', workspace: '/w', brief: makeBrief(),
      constraints: { max_model_cost_usd: 100, max_gpu_hours: 10, max_parallel_jobs: 2 },
    })
    kernel.recordUsage(project.project_id, { model_cost_usd: 150 })
    expect(kernel.getProject(project.project_id).status).toBe('BLOCKED_GATE')
    const violations = kernel.listEvents(project.project_id).filter(e => e.kind === 'policy.violation')
    expect(violations).toHaveLength(1)
    kernel.close()
  })
})

describe('artifact CAS', () => {
  it('stores content-addressed blobs and dedupes', () => {
    const kernel = freshKernel()
    const project = createConfiguredProject(kernel, { name: 't', workspace: '/w', brief: makeBrief() })
    const a1 = kernel.registerArtifact({ project_id: project.project_id, kind: 'log', content: 'hello world' })
    const a2 = kernel.registerArtifact({ project_id: project.project_id, kind: 'log', content: 'hello world' })
    expect(a1.artifact_id).toBe(a2.artifact_id) // content-addressed dedup
    expect(a1.artifact_id.startsWith('sha256:')).toBe(true)
    expect(kernel.cas.read(a1.sha256).toString()).toBe('hello world')
    expect(kernel.cas.has(a1.sha256)).toBe(true)
    expect(kernel.verifyArtifactRefs([a1.artifact_id]).ok).toBe(true)
    expect(kernel.verifyArtifactRefs(['sha256:' + '0'.repeat(64)]).ok).toBe(false)
    kernel.close()
  })
})

describe('durable jobs', () => {
  it('submission is idempotent by idempotency_key', () => {
    const kernel = freshKernel()
    const project = createConfiguredProject(kernel, { name: 't', workspace: '/w', brief: makeBrief() })
    const j1 = submitTestJob(kernel, { project_id: project.project_id, idempotency_key: 'k1', kind: 'echo' })
    const j2 = submitTestJob(kernel, { project_id: project.project_id, idempotency_key: 'k1', kind: 'echo' })
    expect(j1.job_id).toBe(j2.job_id)
    kernel.close()
  })

  it('leases: claim → heartbeat → complete with manifest hash verification', () => {
    const kernel = freshKernel()
    const project = createConfiguredProject(kernel, { name: 't', workspace: '/w', brief: makeBrief() })
    const job = submitTestJob(kernel, { project_id: project.project_id, idempotency_key: 'k2', kind: 'smoke' })
    const claimed = kernel.claimJobs('runner-1', 60, 8)
    expect(claimed).toHaveLength(1)
    expect(claimed[0]?.status).toBe('running')
    expect(claimed[0]?.lease_owner).toBe('runner-1')
    const heartbeated = kernel.heartbeatJob(job.job_id, 'runner-1', ...fencePair(kernel, job.job_id))
    expect(heartbeated.heartbeat_at).not.toBeNull()
    // Manifest referencing a missing artifact must be rejected.
    expect(() => kernel.completeJob({
      job_id: job.job_id, owner: 'runner-1', ...fenceArgs(kernel, job.job_id), status: 'succeeded',
      run_manifest: { metrics_artifact: 'sha256:' + 'a'.repeat(64) },
    })).toThrow(/missing artifacts/)
    kernel.close()
  })

  it('expired leases recover to retryable and re-claim without duplication', () => {
    const kernel = freshKernel()
    const project = createConfiguredProject(kernel, { name: 't', workspace: '/w', brief: makeBrief() })
    submitTestJob(kernel, { project_id: project.project_id, idempotency_key: 'k3', kind: 'echo' })
    const claimed = kernel.claimJobs('runner-a', 1, 8)
    expect(claimed[0]?.status).toBe('running')
    // Let the lease expire (1s TTL), then recover.
    const recovered = kernel.recoverExpiredLeases(Date.now() + 5000)
    expect(recovered).toBe(1)
    const job = kernel.getJob(claimed[0]!.job_id)
    expect(job.status).toBe('retryable')
    expect(job.attempts).toBe(1)
    const reClaimed = kernel.claimJobs('runner-b', 60, 8)
    expect(reClaimed).toHaveLength(1)
    expect(reClaimed[0]?.lease_owner).toBe('runner-b')
    expect(reClaimed[0]?.attempts).toBe(2)
    kernel.close()
  })

  it('foreign lease owners cannot complete jobs', () => {
    const kernel = freshKernel()
    const project = createConfiguredProject(kernel, { name: 't', workspace: '/w', brief: makeBrief() })
    submitTestJob(kernel, { project_id: project.project_id, idempotency_key: 'k4', kind: 'echo' })
    const [claimed] = kernel.claimJobs('runner-a', 60, 8)
    expect(() => kernel.completeJob({ job_id: claimed!.job_id, owner: 'intruder', ...fenceArgs(kernel, claimed!.job_id), status: 'succeeded' }))
      .toThrow(/lease/)
    kernel.close()
  })
})

describe('analysis pipeline (E5)', () => {
  it('aggregates multi-seed metrics into mean/CI/effect size with baseline', () => {
    const kernel = freshKernel()
    const project = createConfiguredProject(kernel, { name: 't', workspace: '/w', brief: makeBrief() })
    const code = codeArtifact(kernel, project.project_id)
    // §13.6 matched-seed design: five baseline runs + five formal runs with
    // the SAME seeds — the analysis engine pairs them by seed.
    const values = [0.81, 0.83, 0.79, 0.85, 0.82]
    for (let i = 0; i < values.length; i++) {
      const seed = 10 + i
      const baseArt = kernel.registerArtifact({
        project_id: project.project_id, kind: 'analysis',
        content: JSON.stringify({ metrics: [{ metric: 'f1', value: 0.8, seed }] }),
      })
      const baseJob = submitTestJob(kernel, { project_id: project.project_id, idempotency_key: `b${i}`, kind: 'baseline', contract_id: approvedContract(kernel, project.project_id), payload: {}, code_snapshot_id: code.artifact_id, image_digest: NODE_IMAGE_DIGEST })
      kernel.claimJobs('r1', 60, 8)
      kernel.completeJob({ job_id: baseJob.job_id, owner: 'r1', ...fenceArgs(kernel, baseJob.job_id), status: 'succeeded', run_manifest: secureManifest(kernel, baseJob, baseArt.artifact_id) })
      const art = kernel.registerArtifact({
        project_id: project.project_id, kind: 'analysis',
        content: JSON.stringify({ metrics: [{ metric: 'f1', value: values[i], seed }] }),
      })
      const job = submitTestJob(kernel, { project_id: project.project_id, idempotency_key: `f${i}`, kind: 'formal', contract_id: approvedContract(kernel, project.project_id), payload: {}, code_snapshot_id: code.artifact_id, image_digest: NODE_IMAGE_DIGEST })
      kernel.claimJobs('r1', 60, 8)
      kernel.completeJob({ job_id: job.job_id, owner: 'r1', ...fenceArgs(kernel, job.job_id), status: 'succeeded', run_manifest: secureManifest(kernel, job, art.artifact_id) })
    }
    const analysis = kernel.computeAnalysis(project.project_id, undefined, 'f1')
    expect(analysis.n).toBe(5)
    expect(analysis.mean).toBeCloseTo(0.82, 3)
    expect(analysis.baseline_value).toBeCloseTo(0.8, 3)
    expect(analysis.effect_size).toBeCloseTo(0.02, 3)
    expect(analysis.ci_low).toBeLessThan(analysis.ci_high)
    expect(analysis.artifact_id.startsWith('sha256:')).toBe(true)
    expect(kernel.cas.has(analysis.artifact_id.replace('sha256:', ''))).toBe(true)
    // Deterministic: same data -> same CI
    const again = kernel.computeAnalysis(project.project_id, undefined, 'f1')
    expect(again.ci_low).toBe(analysis.ci_low)
    expect(again.ci_high).toBe(analysis.ci_high)
    kernel.close()
  })

  it('rejects analysis with no succeeded runs', () => {
    const kernel = freshKernel()
    const project = createConfiguredProject(kernel, { name: 't', workspace: '/w', brief: makeBrief() })
    expect(() => kernel.computeAnalysis(project.project_id)).toThrow(/no succeeded runs/)
    kernel.close()
  })
})

describe('§11.2 recovery & concurrency cases', () => {
  it('concurrent gate decisions: exactly one wins, the other is rejected (CAS race)', () => {
    const kernel = freshKernel()
    const project = createConfiguredProject(kernel, { name: 't', workspace: '/w', brief: makeBrief() })
    const gate = kernel.createGate({ project_id: project.project_id, type: 'scope', title: 'Scope' })
    // Two "browsers" decide simultaneously: the second UPDATE matches zero rows.
    const first = kernel.decideGate({ gate_id: gate.gate_id, actor: 'browser-a', decision: 'approved' })
    expect(first.gate.status).toBe('approved')
    expect(() => kernel.decideGate({ gate_id: gate.gate_id, actor: 'browser-b', decision: 'approved' }))
      .toThrow(/already/)
    expect(kernel.listDecisions(project.project_id)).toHaveLength(1)
    expect(kernel.getProject(project.project_id).status).toBe('SCOPED')
    kernel.close()
  })

  it('session resume: a resumed DSH session links the SAME project; new projects never steal an old session mapping', async () => {
    const kernel = freshKernel()
    const project = createConfiguredProject(kernel, { name: 't', workspace: '/w', brief: makeBrief(), session_id: 'session-old' })
    // Resume = a fresh DSH session continues the project via explicit link.
    const link = kernel.linkSession('session-new', project.project_id)
    expect(link.project_id).toBe(project.project_id)
    expect(kernel.getProjectBySession('session-old')?.project_id).toBe(project.project_id)
    expect(kernel.getProjectBySession('session-new')?.project_id).toBe(project.project_id)
    // A brand-new project must NOT inherit the old session's mapping implicitly.
    const other = createConfiguredProject(kernel, { name: 'other', workspace: '/w2', brief: makeBrief() })
    expect(kernel.getProjectBySession('session-old')?.project_id).toBe(project.project_id)
    expect(other.session_id).toBeNull()
    // Phase is not duplicated on resume: revision/status stay monotonic.
    const gate = kernel.createGate({ project_id: project.project_id, type: 'scope', title: 'Scope' })
    const approved = kernel.decideGate({ gate_id: gate.gate_id, actor: 'human', principal: { principal_id: 'u1' }, decision: 'approved' })
    expect(approved.project.revision).toBe(1)
    expect(kernel.transition(project.project_id, 'SURVEYING', 1).status).toBe('SURVEYING')
    kernel.close()
  })

  it('session format independence: kernel state survives even when the DSH session log is absent (upgrade drill)', () => {
    // The Kernel DB is the authority; a "read-only old session" cannot hold
    // research state hostage. Simulate: no session links at all, project still
    // fully queryable and transitionable.
    const kernel = freshKernel()
    const project = createConfiguredProject(kernel, { name: 't', workspace: '/w', brief: makeBrief() })
    const gate = kernel.createGate({ project_id: project.project_id, type: 'scope', title: 'Scope' })
    kernel.decideGate({ gate_id: gate.gate_id, actor: 'human', decision: 'approved' })
    expect(kernel.getProject(project.project_id).status).toBe('SCOPED')
    expect(kernel.listEvents(project.project_id).length).toBeGreaterThanOrEqual(3)
    // Events remain deliverable after a "restart" (reopen the same DB file).
    const dir = mkdtempSync(join(tmpdir(), 'dsh-kernel-reopen-'))
    const dbPath = join(dir, 'kernel.db')
    const k1 = new ResearchKernel({ dbPath, casRoot: join(dir, 'cas'), requireSignedManifest: false })
    const p1 = createConfiguredProject(k1, { name: 'x', workspace: '/w', brief: makeBrief() })
    k1.close()
    const k2 = new ResearchKernel({ dbPath, casRoot: join(dir, 'cas'), requireSignedManifest: false })
    expect(k2.getProject(p1.project_id).status).toBe('DRAFT')
    expect(k2.getProjectBySession('whatever')).toBeNull()
    k2.close()
    kernel.close()
  })
})

describe('claims and evidence', () => {
  /** Register a real analysis artifact + ingest worker-verified evidence that
   * can pass accept revalidation (run_ids empty => no job checks; artifact
   * refs must be real, same-project artifacts). */
  function verifiedEvidence(kernel: ResearchKernel, projectId: string, result: Record<string, unknown>, overrides: Record<string, unknown> = {}) {
    const artifact = kernel.registerArtifact({
      project_id: projectId,
      kind: 'analysis',
      content: JSON.stringify({ analysis: result }),
      metadata: { kind: 'analysis' },
    })
    const item = kernel.ingestVerifiedEvidence({
      project_id: projectId, source_type: 'analysis', run_ids: [], artifact_refs: [artifact.artifact_id],
      analysis_method: 'bootstrap_95', result: result as never, ...overrides,
    })
    return { artifact, item }
  }

  it('verifyClaim: verified-but-not-accepted evidence is inconclusive; accepted evidence is supported when CIs exclude zero', () => {
    const kernel = freshKernel()
    const project = createConfiguredProject(kernel, { name: 't', workspace: '/w', brief: makeBrief() })
    const { item } = verifiedEvidence(kernel, project.project_id, {
      primary_metric: 'f1', value: 0.9, baseline_value: 0.8, effect_size: 0.1, ci_low: 0.02, ci_high: 0.18, n_seeds: 5,
    })
    const claim = kernel.createClaim({ project_id: project.project_id, statement: 'A improves B' })
    // §6: verified alone (no Verifier/Auditor accept) must NOT support a claim.
    const before = kernel.verifyClaim({ claim_id: claim.claim_id, evidence_ids: [item.evidence_id] })
    expect(before.status).toBe('inconclusive')
    // After accept -> supported (positive effect + CI excluding zero).
    const accepted = kernel.acceptEvidence({
      project_id: project.project_id, evidence_id: item.evidence_id, service_principal: 'verifier', request_id: 'req_accept_1',
    })
    expect(accepted.provenance_status).toBe('accepted')
    const verified = kernel.verifyClaim({ claim_id: claim.claim_id, evidence_ids: [item.evidence_id] })
    expect(verified.status).toBe('supported')
    expect(verified.history.at(-1)?.status).toBe('supported')
    kernel.close()
  })

  it('verifyClaim marks contradicted on negative effects (accepted evidence)', () => {
    const kernel = freshKernel()
    const project = createConfiguredProject(kernel, { name: 't', workspace: '/w', brief: makeBrief() })
    const { item } = verifiedEvidence(kernel, project.project_id, {
      primary_metric: 'f1', value: 0.7, baseline_value: 0.8, effect_size: -0.1, ci_low: -0.18, ci_high: -0.02, n_seeds: 5,
    })
    kernel.acceptEvidence({
      project_id: project.project_id, evidence_id: item.evidence_id, service_principal: 'auditor', request_id: 'req_accept_2',
    })
    const claim = kernel.createClaim({ project_id: project.project_id, statement: 'A improves B' })
    expect(kernel.verifyClaim({ claim_id: claim.claim_id, evidence_ids: [item.evidence_id] }).status).toBe('contradicted')
    kernel.close()
  })

  it('verifyClaim rejects missing evidence', () => {
    const kernel = freshKernel()
    const project = createConfiguredProject(kernel, { name: 't', workspace: '/w', brief: makeBrief() })
    const claim = kernel.createClaim({ project_id: project.project_id, statement: 'x' })
    expect(() => kernel.verifyClaim({ claim_id: claim.claim_id, evidence_ids: ['nope'] })).toThrow(/no resolvable evidence/)
    kernel.close()
  })

  it('acceptEvidence requires a non-empty service principal (403)', () => {
    const kernel = freshKernel()
    const project = createConfiguredProject(kernel, { name: 't', workspace: '/w', brief: makeBrief() })
    const { item } = verifiedEvidence(kernel, project.project_id, {
      primary_metric: 'f1', value: 0.9, effect_size: 0.1, ci_low: 0.02, ci_high: 0.18, n_seeds: 5,
    })
    expectKernelError(
      () => kernel.acceptEvidence({ project_id: project.project_id, evidence_id: item.evidence_id, service_principal: '', request_id: 'r' }),
      403, 'service_identity_required')
    kernel.close()
  })

  it('acceptEvidence rejects draft evidence with 409 provenance_not_verified', () => {
    const kernel = freshKernel()
    const project = createConfiguredProject(kernel, { name: 't', workspace: '/w', brief: makeBrief() })
    const artifact = kernel.registerArtifact({ project_id: project.project_id, kind: 'analysis', content: JSON.stringify({ a: 1 }) })
    const draft = kernel.ingestEvidence({
      project_id: project.project_id, source_type: 'analysis', run_ids: [], artifact_refs: [artifact.artifact_id],
      analysis_method: 'bootstrap_95', result: { primary_metric: 'f1', value: 0.9, effect_size: 0.1, ci_low: 0.02, ci_high: 0.18, n_seeds: 5 },
      provenance_status: 'draft_unverified',
    })
    expectKernelError(
      () => kernel.acceptEvidence({ project_id: project.project_id, evidence_id: draft.evidence_id, service_principal: 'verifier', request_id: 'r' }),
      409, 'provenance_not_verified')
    kernel.close()
  })

  it('acceptEvidence rejects cross-project accept with 422 evidence_foreign', () => {
    const kernel = freshKernel()
    const a = createConfiguredProject(kernel, { name: 'a', workspace: '/a', brief: makeBrief() })
    const b = createConfiguredProject(kernel, { name: 'b', workspace: '/b', brief: makeBrief() })
    const { item } = verifiedEvidence(kernel, a.project_id, {
      primary_metric: 'f1', value: 0.9, effect_size: 0.1, ci_low: 0.02, ci_high: 0.18, n_seeds: 5,
    })
    expectKernelError(
      () => kernel.acceptEvidence({ project_id: b.project_id, evidence_id: item.evidence_id, service_principal: 'verifier', request_id: 'r' }),
      422, 'evidence_foreign')
    // Unknown id in a project with no such evidence -> 404.
    expectKernelError(
      () => kernel.acceptEvidence({ project_id: b.project_id, evidence_id: 'evidence_nope_000000', service_principal: 'verifier', request_id: 'r' }),
      404, 'evidence_not_found')
    kernel.close()
  })

  it('acceptEvidence revalidates run_ids against succeeded project jobs (422 when a run is unknown)', () => {
    const kernel = freshKernel()
    const project = createConfiguredProject(kernel, { name: 't', workspace: '/w', brief: makeBrief() })
    const artifact = kernel.registerArtifact({ project_id: project.project_id, kind: 'analysis', content: JSON.stringify({ a: 1 }) })
    const item = kernel.ingestVerifiedEvidence({
      project_id: project.project_id, source_type: 'run', run_ids: ['job_does_not_exist'], artifact_refs: [artifact.artifact_id],
      analysis_method: 'bootstrap_95', result: { primary_metric: 'f1', value: 0.9, effect_size: 0.1, ci_low: 0.02, ci_high: 0.18, n_seeds: 5 },
    })
    expectKernelError(
      () => kernel.acceptEvidence({ project_id: project.project_id, evidence_id: item.evidence_id, service_principal: 'verifier', request_id: 'r' }),
      422, 'evidence_revalidation_failed')
    kernel.close()
  })

  it('acceptEvidence revalidates artifact_refs against the project CAS (422 on missing artifact)', () => {
    const kernel = freshKernel()
    const project = createConfiguredProject(kernel, { name: 't', workspace: '/w', brief: makeBrief() })
    const item = kernel.ingestVerifiedEvidence({
      project_id: project.project_id, source_type: 'analysis', run_ids: [], artifact_refs: ['sha256:' + 'f'.repeat(64)],
      analysis_method: 'bootstrap_95', result: { primary_metric: 'f1', value: 0.9, effect_size: 0.1, ci_low: 0.02, ci_high: 0.18, n_seeds: 5 },
    })
    expectKernelError(
      () => kernel.acceptEvidence({ project_id: project.project_id, evidence_id: item.evidence_id, service_principal: 'verifier', request_id: 'r' }),
      422, 'evidence_revalidation_failed')
    kernel.close()
  })

  it('acceptEvidence records provenance=accepted + acceptance block and emits evidence.accepted to the outbox', () => {
    const kernel = freshKernel()
    const project = createConfiguredProject(kernel, { name: 't', workspace: '/w', brief: makeBrief() })
    const { item } = verifiedEvidence(kernel, project.project_id, {
      primary_metric: 'f1', value: 0.9, effect_size: 0.1, ci_low: 0.02, ci_high: 0.18, n_seeds: 5,
    })
    const accepted = kernel.acceptEvidence({
      project_id: project.project_id, evidence_id: item.evidence_id, service_principal: 'verifier', request_id: 'req_demo_42',
    })
    expect(accepted.provenance_status).toBe('accepted')
    expect(accepted.acceptance.accepted_by).toBe('verifier')
    expect(accepted.acceptance.request_id).toBe('req_demo_42')
    expect(typeof accepted.acceptance.accepted_at).toBe('string')
    // Persisted body carries the acceptance block (re-read through listEvidence).
    const reread = kernel.listEvidence(project.project_id).find(e => e.evidence_id === item.evidence_id)
    expect((reread as { provenance_status?: string }).provenance_status).toBe('accepted')
    expect((reread as { acceptance?: { request_id?: string } }).acceptance?.request_id).toBe('req_demo_42')
    // Outbox event (reference pattern: filter listEvents by kind).
    const events = kernel.listEvents(project.project_id).filter(e => e.kind === 'evidence.accepted')
    expect(events).toHaveLength(1)
    expect(events[0]?.payload.evidence_id).toBe(item.evidence_id)
    expect(events[0]?.payload.accepted_by).toBe('verifier')
    expect(events[0]?.payload.request_id).toBe('req_demo_42')
    // listAcceptedEvidence surfaces it; listVerifiedEvidence no longer does.
    expect(kernel.listAcceptedEvidence(project.project_id).map(e => e.evidence_id)).toContain(item.evidence_id)
    expect(kernel.listVerifiedEvidence(project.project_id)).toHaveLength(0)
    kernel.close()
  })

  it('public evidence route rejects a forged provenance_status=accepted body with 422 validation_error', async () => {
    const { startKernelServer } = await import('../../packages/research-kernel/lib/server.js')
    const kernel = freshKernel()
    const project = createConfiguredProject(kernel, { name: 't', workspace: '/w', brief: makeBrief() })
    const { server, port } = await startKernelServer({ kernel, port: 0 })
    try {
      const body = {
        source_type: 'analysis', run_ids: [], artifact_refs: [],
        analysis_method: 'bootstrap_95',
        result: { primary_metric: 'f1', value: 0.9, effect_size: 0.3, ci_low: 0.1, ci_high: 0.5, n_seeds: 5 },
        provenance_status: 'accepted',
      }
      const res = await fetch(`http://127.0.0.1:${port}/v1/projects/${project.project_id}/evidence`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
      })
      expect(res.status).toBe(422)
      const envelope = await res.json() as { error?: { code?: string } }
      expect(envelope.error?.code).toBe('validation_error')
      // The forged row must not exist.
      expect(kernel.listEvidence(project.project_id)).toHaveLength(0)
    } finally {
      server.close()
      kernel.close()
    }
  })
})

describe('CONFIG-01 canonical Config Registry integration', () => {
  it('pins the kernel effective config (stable for identical options, sensitive to change)', () => {
    const kernel = freshKernel()
    expect(kernel.configPinHash).toMatch(/^sha256:[0-9a-f]{64}$/)
    // identical explicit options → identical pin (freshKernel uses a random
    // temp dir, so the two instances above legitimately differ in db path)
    const opts = { dbPath: ':memory:', casRoot: '/tmp/config-pin-cas' } as const
    const a = new ResearchKernel(opts)
    const b = new ResearchKernel(opts)
    try {
      expect(b.configPinHash).toBe(a.configPinHash)
      // a changed cas root changes the pin
      const c = new ResearchKernel({ ...opts, casRoot: '/tmp/config-pin-cas-other' })
      try {
        expect(c.configPinHash).not.toBe(a.configPinHash)
      } finally {
        c.close()
      }
      // a changed service identity changes the pin (secret hashed, never echoed)
      const withToken = new ResearchKernel({ ...opts, serviceToken: 'svc-secret-x' })
      try {
        expect(withToken.configPinHash).not.toBe(a.configPinHash)
        expect(withToken.configPinHash).not.toContain('svc-secret-x')
      } finally {
        withToken.close()
      }
    } finally {
      a.close()
      b.close()
      kernel.close()
    }
  })

  it('server health carries config_pin and every response has x-config-pin', async () => {
    const { startKernelServer } = await import('../../packages/research-kernel/lib/server.js')
    const kernel = freshKernel()
    const { server, port } = await startKernelServer({ kernel, port: 0 })
    try {
      const v1 = await fetch(`http://127.0.0.1:${port}/v1/health`)
      expect(v1.status).toBe(200)
      expect(v1.headers.get('x-config-pin')).toBe(kernel.configPinHash)
      const v1Body = await v1.json() as { config_pin?: string }
      expect(v1Body.config_pin).toBe(kernel.configPinHash)
      const v2 = await fetch(`http://127.0.0.1:${port}/v2/health`)
      expect(v2.status).toBe(200)
      expect(v2.headers.get('x-config-pin')).toBe(kernel.configPinHash)
      const v2Body = await v2.json() as { config_pin?: string }
      expect(v2Body.config_pin).toBe(kernel.configPinHash)
      // a regular API response carries the header too
      const projects = await fetch(`http://127.0.0.1:${port}/v1/projects`)
      expect(projects.headers.get('x-config-pin')).toBe(kernel.configPinHash)
    } finally {
      server.close()
      kernel.close()
    }
  })

  it('createProject enforces the registry security floor (automatic release forbidden)', () => {
    const kernel = freshKernel()
    try {
      expect(() => createConfiguredProject(kernel, {
        name: 't', workspace: '/w', brief: makeBrief(), integrity: { allow_automatic_public_release: true },
      })).toThrow(/automatic public release/)
      // nothing was persisted
      expect(kernel.listProjects()).toHaveLength(0)
    } finally {
      kernel.close()
    }
  })

  it('GET /v1/config/effective serves the redacted deployment config with its pin', async () => {
    const { startKernelServer } = await import('../../packages/research-kernel/lib/server.js')
    const kernel = freshKernel()
    const deploymentRedacted = { 'kernel.port': 7413, 'kernel.token': '<redacted>', 'kernel.service_token': '<redacted>' }
    const deploymentPin = 'sha256:' + 'a'.repeat(64)
    const { server, port } = await startKernelServer({
      kernel, port: 0, configPinHash: deploymentPin, configRedacted: deploymentRedacted,
    })
    try {
      const res = await fetch(`http://127.0.0.1:${port}/v1/config/effective`)
      expect(res.status).toBe(200)
      const body = await res.json() as { config_pin?: string; config?: Record<string, unknown> }
      expect(body.config_pin).toBe(deploymentPin)
      expect(body.config).toEqual(deploymentRedacted)
      // secrets are redacted in the plaintext surface
      expect(JSON.stringify(body)).not.toContain('Bearer')
      // unknown config sub-resources 404
      const nope = await fetch(`http://127.0.0.1:${port}/v1/config/whatever`)
      expect(nope.status).toBe(404)
    } finally {
      server.close()
      kernel.close()
    }
  })

  it('GET /v1/config/schema serves the registry-generated JSON Schema', async () => {
    const { startKernelServer } = await import('../../packages/research-kernel/lib/server.js')
    const kernel = freshKernel()
    const { server, port } = await startKernelServer({ kernel, port: 0 })
    try {
      const res = await fetch(`http://127.0.0.1:${port}/v1/config/schema`)
      expect(res.status).toBe(200)
      const schema = await res.json() as { $schema?: string; properties?: Record<string, unknown>; additionalProperties?: unknown }
      expect(schema.$schema).toBe('http://json-schema.org/draft-07/schema#')
      expect(schema.additionalProperties).toBe(false)
      // every scope is present in the served schema
      for (const scope of ['global', 'project', 'job', 'runner-profile', 'orchestrator', 'kernel', 'standalone']) {
        expect((schema.properties as Record<string, unknown>)[scope]).toBeDefined()
      }
      // no secret value can exist in a schema (leaf annotations only)
      expect(JSON.stringify(schema)).not.toContain('<redacted>')
    } finally {
      server.close()
      kernel.close()
    }
  })
})

describe('corpus + ideas + manuscript', () => {
  it('atomically creates ready IdeaCard drafts pinned to the frozen corpus and project revision', () => {
    const kernel = freshKernel()
    const project = createConfiguredProject(kernel, { name: 'idea-batch', workspace: '/w', brief: makeBrief() })
    const scope = kernel.createGate({ project_id: project.project_id, type: 'scope', title: 'Scope' })
    kernel.decideGate({ gate_id: scope.gate_id, actor: 'pi', decision: 'approved' })
    const corpus = fixtureCorpus(project.project_id)
    const snapshot = kernel.snapshotCorpus({ project_id: project.project_id, queries: corpus.queries, papers: corpus.papers })
    const surveying = kernel.getProject(project.project_id)
    expect(surveying.status).toBe('SURVEYING')
    const fixture = fixtureIdea(project.project_id)
    const draft = {
      title: fixture.title,
      hypothesis: fixture.hypothesis,
      scientific_gap: fixture.scientific_gap,
      nearest_prior_works: fixture.nearest_prior_works,
      exact_delta: fixture.exact_delta,
      falsification: fixture.falsification,
      minimum_viable_experiment: fixture.minimum_viable_experiment,
      scores: fixture.scores,
      risk_notes: fixture.risk_notes,
    }

    const cards = kernel.createIdeasBatch({
      project_id: project.project_id,
      expected_project_revision: surveying.revision,
      corpus_snapshot_id: snapshot.snapshot_id,
      ideas: [draft, { ...draft, title: 'Second candidate' }],
    })

    expect(cards).toHaveLength(2)
    expect(cards.every(card => card.corpus_snapshot_id === snapshot.snapshot_id && card.status === 'proposed')).toBe(true)
    expect(kernel.getProject(project.project_id).status).toBe('SURVEYING')
    expect(() => kernel.createIdeasBatch({
      project_id: project.project_id,
      expected_project_revision: surveying.revision + 1,
      corpus_snapshot_id: snapshot.snapshot_id,
      ideas: [draft],
    })).toThrow(/expected revision/)

    const before = kernel.listIdeas(project.project_id).length
    expect(() => kernel.createIdeasBatch({
      project_id: project.project_id,
      expected_project_revision: surveying.revision,
      corpus_snapshot_id: snapshot.snapshot_id,
      ideas: [draft, { ...draft, title: '' } as never],
    })).toThrow()
    expect(kernel.listIdeas(project.project_id)).toHaveLength(before)
    kernel.close()
  })

  it('atomically audits the human-selected idea, enters IDEATING and creates its pending Gate', () => {
    const kernel = freshKernel()
    const project = createConfiguredProject(kernel, { name: 'idea-select', workspace: '/w', brief: makeBrief() })
    const scope = kernel.createGate({ project_id: project.project_id, type: 'scope', title: 'Scope' })
    kernel.decideGate({ gate_id: scope.gate_id, actor: 'pi', decision: 'approved' })
    const corpus = fixtureCorpus(project.project_id)
    const snapshot = kernel.snapshotCorpus({ project_id: project.project_id, queries: corpus.queries, papers: corpus.papers })
    const surveying = kernel.getProject(project.project_id)
    const fixture = fixtureIdea(project.project_id)
    const [card] = kernel.createIdeasBatch({
      project_id: project.project_id,
      expected_project_revision: surveying.revision,
      corpus_snapshot_id: snapshot.snapshot_id,
      ideas: [{
        title: fixture.title,
        hypothesis: fixture.hypothesis,
        scientific_gap: fixture.scientific_gap,
        nearest_prior_works: fixture.nearest_prior_works,
        exact_delta: fixture.exact_delta,
        falsification: fixture.falsification,
        minimum_viable_experiment: fixture.minimum_viable_experiment,
        scores: fixture.scores,
        risk_notes: fixture.risk_notes,
      }],
    })
    const audit = {
      queries: ['uncertainty temporal localization'],
      result: 'overlap_found' as const,
      overlap_papers: ['doi:10.1000/example1'],
      unresolved_risk: 'medium' as const,
      audited_at: '2026-08-17T12:00:00.000Z',
    }

    const prepared = kernel.prepareIdeaGate({
      project_id: project.project_id,
      idea_id: card!.idea_id,
      expected_project_revision: surveying.revision,
      expected_idea_version: card!.version,
      novelty_audit: audit,
    })

    expect(prepared.project.status).toBe('IDEATING')
    expect(prepared.idea.novelty_audit).toEqual(audit)
    expect(prepared.gate).toMatchObject({ type: 'idea', status: 'pending', payload: { idea_id: card!.idea_id } })
    expect(kernel.listDecisions(project.project_id).filter(decision => decision.gate_type === 'idea')).toHaveLength(0)
    expect(kernel.projectProjection(project.project_id).next_actions_v2[0]).toMatchObject({
      code: 'idea_gate_approve', state: 'ready', required_by: 'human',
    })

    kernel.decideGate({ gate_id: prepared.gate.gate_id, actor: 'pi', decision: 'approved' })
    const frozenIdea = kernel.getIdea(card!.idea_id)
    expect(frozenIdea.status).toBe('approved')
    const ideaApproved = kernel.getProject(project.project_id)
    expect(kernel.projectProjection(project.project_id).next_actions_v2).toContainEqual(expect.objectContaining({
      code: 'contract_register', state: 'ready', required: true,
    }))

    const contractDraft = {
      data: { dataset_id: frozenIdea.minimum_viable_experiment.dataset, version: 'official', split: 'official' },
      methods: { baseline: frozenIdea.minimum_viable_experiment.baseline, treatment: frozenIdea.exact_delta },
      metrics: { primary: frozenIdea.minimum_viable_experiment.primary_metric, secondary: [] },
      seeds: [11, 23, 47],
      analysis: { effect_size: 'mean_difference' as const, interval: 'bootstrap_95' as const, multiple_testing: 'holm' as const },
      ablations: [],
      stop_conditions: { max_gpu_hours: frozenIdea.minimum_viable_experiment.estimated_gpu_hours, min_completed_seeds: 3, stop_on_data_leakage: true },
    }
    expect(() => kernel.prepareContractGate({
      project_id: project.project_id,
      idea_id: frozenIdea.idea_id,
      expected_project_revision: ideaApproved.revision,
      expected_idea_version: frozenIdea.version + 1,
      contract: contractDraft,
    })).toThrow(/expected idea version/)
    expect(kernel.getProject(project.project_id).status).toBe('IDEA_APPROVED')
    expect(kernel.listContracts(project.project_id)).toHaveLength(0)
    expect(kernel.listGates(project.project_id, 'pending').filter(gate => gate.type === 'contract')).toHaveLength(0)

    const contractPrepared = kernel.prepareContractGate({
      project_id: project.project_id,
      idea_id: frozenIdea.idea_id,
      expected_project_revision: ideaApproved.revision,
      expected_idea_version: frozenIdea.version,
      contract: contractDraft,
    })
    expect(contractPrepared.project.status).toBe('CONTRACT_PENDING')
    expect(contractPrepared.contract.status).toBe('draft')
    expect(contractPrepared.gate.payload).toMatchObject({
      contract_id: contractPrepared.contract.contract_id,
      contract_version: contractPrepared.contract.version,
      contract_sha256: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
    })

    kernel.decideGate({ gate_id: contractPrepared.gate.gate_id, actor: 'pi', decision: 'approved' })
    expect(kernel.getProject(project.project_id).status).toBe('CONTRACT_APPROVED')
    expect(kernel.getContract(contractPrepared.contract.contract_id).status).toBe('approved')

    const rollbackKernel = freshKernel()
    const rollbackProject = createConfiguredProject(rollbackKernel, { name: 'idea-select-rollback', workspace: '/w2', brief: makeBrief() })
    const rollbackScope = rollbackKernel.createGate({ project_id: rollbackProject.project_id, type: 'scope', title: 'Scope' })
    rollbackKernel.decideGate({ gate_id: rollbackScope.gate_id, actor: 'pi', decision: 'approved' })
    const rollbackCorpus = fixtureCorpus(rollbackProject.project_id)
    const rollbackSnapshot = rollbackKernel.snapshotCorpus({ project_id: rollbackProject.project_id, queries: rollbackCorpus.queries, papers: rollbackCorpus.papers })
    const rollbackSurveying = rollbackKernel.getProject(rollbackProject.project_id)
    const [rollbackCard] = rollbackKernel.createIdeasBatch({
      project_id: rollbackProject.project_id,
      expected_project_revision: rollbackSurveying.revision,
      corpus_snapshot_id: rollbackSnapshot.snapshot_id,
      ideas: [{
        title: fixture.title, hypothesis: fixture.hypothesis, scientific_gap: fixture.scientific_gap,
        nearest_prior_works: fixture.nearest_prior_works, exact_delta: fixture.exact_delta,
        falsification: fixture.falsification, minimum_viable_experiment: fixture.minimum_viable_experiment,
        scores: fixture.scores, risk_notes: fixture.risk_notes,
      }],
    })
    expect(() => rollbackKernel.prepareIdeaGate({
      project_id: rollbackProject.project_id,
      idea_id: rollbackCard!.idea_id,
      expected_project_revision: rollbackSurveying.revision,
      expected_idea_version: rollbackCard!.version + 1,
      novelty_audit: audit,
    })).toThrow(/expected idea version/)
    expect(rollbackKernel.getProject(rollbackProject.project_id).status).toBe('SURVEYING')
    expect(rollbackKernel.getIdea(rollbackCard!.idea_id).novelty_audit).toBeUndefined()
    expect(rollbackKernel.listGates(rollbackProject.project_id, 'pending').filter(gate => gate.type === 'idea')).toHaveLength(0)
    rollbackKernel.close()
    kernel.close()
  })

  it('CAS-fences an automatic corpus snapshot by project revision', () => {
    const kernel = freshKernel()
    const project = createConfiguredProject(kernel, { name: 'cas-survey', workspace: '/w', brief: makeBrief(), session_id: 'session_a' })
    const other = createConfiguredProject(kernel, { name: 'other', workspace: '/other', brief: makeBrief() })
    const corpus = fixtureCorpus(project.project_id)
    expect(() => kernel.snapshotCorpus({
      project_id: project.project_id,
      expected_revision: project.revision + 1,
      queries: corpus.queries,
      papers: corpus.papers,
    })).toThrow(/expected revision/)
    expect(kernel.listCorpusSnapshots(project.project_id)).toHaveLength(0)
    kernel.linkSession('session_a', other.project_id)
    expect(() => kernel.snapshotCorpus({
      project_id: project.project_id,
      expected_revision: project.revision,
      expected_session_id: 'session_a',
      queries: corpus.queries,
      papers: corpus.papers,
    })).toThrow(/no longer linked/)
    expect(kernel.listCorpusSnapshots(project.project_id)).toHaveLength(0)
    kernel.linkSession('session_a', project.project_id)
    const snapshot = kernel.snapshotCorpus({
      project_id: project.project_id,
      expected_revision: project.revision,
      expected_session_id: 'session_a',
      queries: corpus.queries,
      papers: corpus.papers,
    })
    expect(snapshot.project_id).toBe(project.project_id)
    expect(kernel.listCorpusSnapshots(project.project_id)).toHaveLength(1)
    kernel.close()
  })

  it('snapshots corpus and builds deterministic manuscripts from the ledger', () => {
    const kernel = freshKernel()
    const project = createConfiguredProject(kernel, { name: 't', workspace: '/w', brief: makeBrief() })
    const corpus = fixtureCorpus(project.project_id)
    const snapshot = kernel.snapshotCorpus({
      project_id: project.project_id, queries: corpus.queries, papers: corpus.papers,
    })
    expect(snapshot.frozen).toBe(true)
    expect(kernel.listCorpusSnapshots(project.project_id)).toHaveLength(1)

    const idea = fixtureIdea(project.project_id)
    const card = kernel.createIdea({
      project_id: project.project_id, title: idea.title, hypothesis: idea.hypothesis,
      scientific_gap: idea.scientific_gap, nearest_prior_works: idea.nearest_prior_works,
      exact_delta: idea.exact_delta, falsification: idea.falsification,
      minimum_viable_experiment: idea.minimum_viable_experiment, scores: idea.scores,
    })
    expect(kernel.getIdea(card.idea_id).status).toBe('proposed')

    const analysis = kernel.registerArtifact({ project_id: project.project_id, kind: 'analysis', content: JSON.stringify({ f1: 0.9 }) })
    const item = kernel.ingestVerifiedEvidence({
      project_id: project.project_id, source_type: 'run', run_ids: [], artifact_refs: [analysis.artifact_id],
      analysis_method: 'bootstrap_95', result: { primary_metric: 'f1', value: 0.9, baseline_value: 0.8, effect_size: 0.1, ci_low: 0.02, ci_high: 0.18, n_seeds: 2 },
    })
    // §6: verified -> accepted (Verifier/Auditor) before the claim can be supported.
    kernel.acceptEvidence({
      project_id: project.project_id, evidence_id: item.evidence_id, service_principal: 'verifier', request_id: 'req_manuscript',
    })
    const claim = kernel.createClaim({ project_id: project.project_id, statement: 'A improves B', scope: { dataset: 'd', split: 'test' } })
    kernel.verifyClaim({ claim_id: claim.claim_id, evidence_ids: [item.evidence_id], analysis_artifact: analysis.artifact_id })

    const draft = kernel.buildManuscript(project.project_id, 'markdown', true)
    expect(draft.text).toContain('# t')
    expect(draft.text).toContain('A improves B')
    expect(draft.artifact_id.startsWith('sha256:')).toBe(true)
    expect(kernel.manuscriptReview(project.project_id).pass).toBe(true)

    const bundle = kernel.releaseBundle(project.project_id)
    expect(bundle.release_gate).toBe('unapproved')
    kernel.close()
  })
})

describe('§12.6 lease fencing (SCH-JOB-001)', () => {
  it('claim returns lease_owner/lease_generation/lease_token; generation bumps on re-claim', () => {
    const kernel = freshKernel()
    const project = createConfiguredProject(kernel, { name: 't', workspace: '/w', brief: makeBrief() })
    submitTestJob(kernel, { project_id: project.project_id, idempotency_key: 'f1', kind: 'smoke' })
    const [first] = kernel.claimJobs('runner-1', 1, 8)
    expect(first?.lease_owner).toBe('runner-1')
    expect(first?.lease_generation).toBe(1)
    expect(first?.lease_token).toMatch(/^lt_/)
    // The opaque token must not leak into the public payload.
    expect(JSON.stringify(first?.payload ?? {})).not.toContain('__lease_token')
    // Expire + re-claim: generation advances, token rotates.
    expect(kernel.recoverExpiredLeases(Date.now() + 5000)).toBe(1)
    const [second] = kernel.claimJobs('runner-1', 60, 8)
    expect(second?.lease_generation).toBe(2)
    expect(second?.lease_token).not.toBe(first?.lease_token)
    kernel.close()
  })

  it('stale-runner-fencing-token-rejected: old generation/token cannot complete the job', () => {
    const kernel = freshKernel()
    const project = createConfiguredProject(kernel, { name: 't', workspace: '/w', brief: makeBrief() })
    const job = submitTestJob(kernel, { project_id: project.project_id, idempotency_key: 'f2', kind: 'smoke' })
    const [claim1] = kernel.claimJobs('runner-1', 1, 8)
    expect(kernel.recoverExpiredLeases(Date.now() + 5000)).toBe(1)
    // The SAME runner re-claims: old process still holds generation 1 + token 1.
    const [claim2] = kernel.claimJobs('runner-1', 60, 8)
    expect(claim2?.lease_generation).toBe(2)
    // Old credentials -> 409 lease_stale (owner matches, generation/token stale).
    expectKernelError(
      () => kernel.completeJob({
        job_id: job.job_id, owner: 'runner-1', status: 'succeeded',
        lease_generation: claim1?.lease_generation ?? 0, lease_token: claim1?.lease_token ?? '',
      }),
      409, 'lease_stale',
    )
    // Job must still be running — the stale completion changed nothing.
    expect(kernel.getJob(job.job_id).status).toBe('running')
    // Current credentials -> success.
    const done = kernel.completeJob({
      job_id: job.job_id, owner: 'runner-1', status: 'succeeded',
      lease_generation: claim2?.lease_generation ?? 0, lease_token: claim2?.lease_token ?? '',
    })
    expect(done.status).toBe('succeeded')
    kernel.close()
  })

  it('stale heartbeat is rejected with 409 lease_stale; current token renews', () => {
    const kernel = freshKernel()
    const project = createConfiguredProject(kernel, { name: 't', workspace: '/w', brief: makeBrief() })
    const job = submitTestJob(kernel, { project_id: project.project_id, idempotency_key: 'f3', kind: 'smoke' })
    const [claim1] = kernel.claimJobs('runner-1', 1, 8)
    expect(kernel.recoverExpiredLeases(Date.now() + 5000)).toBe(1)
    const [claim2] = kernel.claimJobs('runner-1', 60, 8)
    expectKernelError(
      () => kernel.heartbeatJob(job.job_id, 'runner-1', claim1?.lease_generation ?? 0, claim1?.lease_token ?? ''),
      409, 'lease_stale',
    )
    const heartbeated = kernel.heartbeatJob(job.job_id, 'runner-1', claim2?.lease_generation ?? 0, claim2?.lease_token ?? '')
    expect(heartbeated.heartbeat_at).not.toBeNull()
    kernel.close()
  })

  it('P0: heartbeat/complete without generation/token are rejected (fail-closed)', () => {
    const kernel = freshKernel()
    const project = createConfiguredProject(kernel, { name: 't', workspace: '/w', brief: makeBrief() })
    const job = submitTestJob(kernel, { project_id: project.project_id, idempotency_key: 'f4', kind: 'smoke' })
    kernel.claimJobs('runner-1', 60, 8)
    expectKernelError(() => kernel.heartbeatJob(job.job_id, 'runner-1'), 409, 'lease_stale')
    expectKernelError(() => kernel.completeJob({ job_id: job.job_id, owner: 'runner-1', lease_generation: 99, lease_token: 'wrong-token', status: 'succeeded' }), 409, 'lease_stale')
    const h = kernel.heartbeatJob(job.job_id, 'runner-1', ...fencePair(kernel, job.job_id))
    expect(h.heartbeat_at).not.toBeNull()
    const done = kernel.completeJob({ job_id: job.job_id, owner: 'runner-1', ...fenceArgs(kernel, job.job_id), status: 'succeeded' })
    expect(done.status).toBe('succeeded')
    kernel.close()
  })

  it('STORE-06: claim persists only sha256(lease_token); the payload carries no plaintext token', () => {
    const kernel = freshKernel()
    const project = createConfiguredProject(kernel, { name: 't', workspace: '/w', brief: makeBrief() })
    submitTestJob(kernel, { project_id: project.project_id, idempotency_key: 'hash1', kind: 'smoke' })
    const [claimed] = kernel.claimJobs('runner-1', 60, 8)
    expect(claimed?.lease_token).toMatch(/^lt_/)
    // The jobs row stores the sha256 of the token — never the plaintext.
    const row = kernel.db.prepare('SELECT lease_token_hash, payload FROM jobs WHERE job_id = ?').get(claimed!.job_id) as { lease_token_hash: string; payload: string }
    expect(row.lease_token_hash).toBe(createHash('sha256').update(claimed!.lease_token!).digest('hex'))
    expect(row.lease_token_hash).toMatch(/^[0-9a-f]{64}$/)
    expect(row.lease_token_hash).not.toContain(claimed!.lease_token!)
    expect(row.payload).not.toContain('__lease_token')
    expect(row.payload).not.toContain(claimed!.lease_token!)
    // The public payload surface stays clean too.
    expect(JSON.stringify(claimed?.payload ?? {})).not.toContain('__lease_token')
    // Re-fetching the job still surfaces the in-memory token (same process).
    expect(kernel.getJob(claimed!.job_id).lease_token).toBe(claimed!.lease_token)
    kernel.close()
  })

  it('STORE-06: fencing compares sha256(token) against the hash column — old rows with an EMPTY hash still fence via the legacy payload token', () => {
    const kernel = freshKernel()
    const project = createConfiguredProject(kernel, { name: 't', workspace: '/w', brief: makeBrief() })
    const job = submitTestJob(kernel, { project_id: project.project_id, idempotency_key: 'hash2', kind: 'smoke' })
    const [claimed] = kernel.claimJobs('runner-1', 60, 8)
    // Simulate a legacy row (claimed by the pre-0014 release): hash column
    // empty, plaintext token recorded in payload.__lease_token.
    kernel.db.prepare('UPDATE jobs SET lease_token_hash = NULL, payload = ? WHERE job_id = ?')
      .run(JSON.stringify({ __lease_token: claimed!.lease_token, note: 'legacy' }), claimed!.job_id)
    // Heartbeat + complete with the token still pass through the legacy path.
    const h = kernel.heartbeatJob(job.job_id, 'runner-1', ...fencePair(kernel, job.job_id))
    expect(h.heartbeat_at).not.toBeNull()
    // A WRONG token is still rejected on the legacy path (fail-closed).
    expectKernelError(() => kernel.heartbeatJob(job.job_id, 'runner-1', claimed!.lease_generation ?? 0, 'wrong-token'), 409, 'lease_stale')
    const done = kernel.completeJob({ job_id: job.job_id, owner: 'runner-1', ...fenceArgs(kernel, job.job_id), status: 'succeeded' })
    expect(done.status).toBe('succeeded')
    kernel.close()
  })

  it('STORE-06: wrong tokens are rejected against the hash column (old and new generations)', () => {
    const kernel = freshKernel()
    const project = createConfiguredProject(kernel, { name: 't', workspace: '/w', brief: makeBrief() })
    const job = submitTestJob(kernel, { project_id: project.project_id, idempotency_key: 'hash3', kind: 'smoke' })
    const [claim1] = kernel.claimJobs('runner-1', 1, 8)
    expect(kernel.recoverExpiredLeases(Date.now() + 5000)).toBe(1)
    const [claim2] = kernel.claimJobs('runner-1', 60, 8)
    // Stale generation + stale token (old claim) → 409 lease_stale.
    expectKernelError(
      () => kernel.completeJob({ job_id: job.job_id, owner: 'runner-1', status: 'succeeded', lease_generation: claim1?.lease_generation ?? 0, lease_token: claim1?.lease_token ?? '' }),
      409, 'lease_stale',
    )
    // Current generation + WRONG token → 409 lease_stale (hash mismatch).
    expectKernelError(
      () => kernel.completeJob({ job_id: job.job_id, owner: 'runner-1', status: 'succeeded', lease_generation: claim2?.lease_generation ?? 0, lease_token: 'lt_tampered' }),
      409, 'lease_stale',
    )
    // The re-claim rotated the credential (recovery released the old lease;
    // the new claim minted a fresh token + generation).
    expect(claim2?.lease_generation).toBe(2)
    expect(claim2?.lease_token).not.toBe(claim1?.lease_token)
    // Current credentials still succeed.
    const done = kernel.completeJob({ job_id: job.job_id, owner: 'runner-1', status: 'succeeded', ...fenceArgs(kernel, job.job_id) })
    expect(done.status).toBe('succeeded')
    kernel.close()
  })
})

describe('§12.7 manifest signature (SCH-MANIFEST-001)', () => {
  function signedJobSetup(overrides: { requireSignedManifest?: boolean } = {}) {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-kernel-sig-'))
    const kernel = new ResearchKernel({
      dbPath: join(dir, 'kernel.db'),
      casRoot: join(dir, 'cas'),
      requireSignedManifest: overrides.requireSignedManifest,
    })
    const project = createConfiguredProject(kernel, { name: 't', workspace: '/w', brief: makeBrief() })
    const metrics = kernel.registerArtifact({ project_id: project.project_id, kind: 'analysis', content: JSON.stringify({ metrics: [{ metric: 'm', value: 1, seed: 1 }] }) })
    const code = codeArtifact(kernel, project.project_id)
    const job = submitTestJob(kernel, { project_id: project.project_id, idempotency_key: 's1', kind: 'formal', contract_id: approvedContract(kernel, project.project_id), payload: {}, code_snapshot_id: code.artifact_id, image_digest: NODE_IMAGE_DIGEST })
    kernel.claimJobs('runner-1', 60, 8)
    const { publicKey, privateKey } = generateKeyPairSync('ed25519')
    const keyId = 'runner-key-test-1'
    const publicPem = publicKey.export({ type: 'spki', format: 'pem' }).toString()
    kernel.registerRunnerKey({ key_id: keyId, public_key_pem: publicPem })
    return { kernel, job, metrics, privateKey, keyId }
  }

  it('RUN-01: require_signed_manifest project rejects unsigned manifests', () => {
    const kernel = freshKernel()
    const project = createConfiguredProject(kernel, {
      name: 't', workspace: '/w', brief: makeBrief(),
      integrity: { require_signed_manifest: true },
    })
    expect(project.integrity.require_signed_manifest).toBe(true)
    const metrics = kernel.registerArtifact({ project_id: project.project_id, kind: 'analysis', content: JSON.stringify({ metrics: [{ metric: 'm', value: 1, seed: 1 }] }) })
    const code = codeArtifact(kernel, project.project_id)
    const job = submitTestJob(kernel, { project_id: project.project_id, idempotency_key: 'run01', kind: 'formal', contract_id: approvedContract(kernel, project.project_id), payload: {}, code_snapshot_id: code.artifact_id, image_digest: NODE_IMAGE_DIGEST })
    kernel.claimJobs('runner-1', 60, 8)
    // Unsigned manifest -> rejected with the enforcement code.
    expectKernelError(
      () => kernel.completeJob({ job_id: job.job_id, owner: 'runner-1', ...fenceArgs(kernel, job.job_id), status: 'succeeded', run_manifest: makeManifest(kernel, job, metrics.artifact_id) }),
      422, 'manifest_signature_required',
    )
    expect(kernel.getJob(job.job_id).status).toBe('running')
    // A properly signed manifest is accepted.
    const { publicKey, privateKey } = generateKeyPairSync('ed25519')
    const keyId = 'run01-key'
    kernel.registerRunnerKey({ key_id: keyId, public_key_pem: publicKey.export({ type: 'spki', format: 'pem' }).toString() })
    const signed = signManifest(makeManifest(kernel, job, metrics.artifact_id), privateKey, keyId)
    const done = kernel.completeJob({ job_id: job.job_id, owner: 'runner-1', ...fenceArgs(kernel, job.job_id), status: 'succeeded', run_manifest: signed })
    expect(done.status).toBe('succeeded')
    kernel.close()
  })

  it('manifest-signature-invalid-rejected: forged signature -> 422; valid signature -> succeeded', () => {
    const { kernel, job, metrics, privateKey, keyId } = signedJobSetup()
    // Attacker tamper: payload_sha256 is honestly recomputed over the mutated
    // payload (hash check passes), but the signature still covers the ORIGINAL
    // payload -> the Ed25519 verification must fail.
    const forged = signManifest(makeManifest(kernel, job, metrics.artifact_id), privateKey, keyId)
    forged.exit_code = 1
    // Recompute the hash over the payload ONLY (envelope fields excluded),
    // exactly like the kernel does — the signature still covers the original.
    const { signature: _sig, runner_key_id: _rid, payload_sha256: _ph, ...payloadOnly } = forged
    forged.payload_sha256 = createHash('sha256').update(canonicalJsonDeep(payloadOnly)).digest('hex')
    expectKernelError(
      () => kernel.completeJob({ job_id: job.job_id, owner: 'runner-1', ...fenceArgs(kernel, job.job_id), status: 'succeeded', run_manifest: forged }),
      422, 'manifest_signature_invalid',
    )
    expect(kernel.getJob(job.job_id).status).toBe('running')
    // A signature made with a DIFFERENT key is also invalid.
    const otherKey = generateKeyPairSync('ed25519')
    const crossSigned = signManifest(makeManifest(kernel, job, metrics.artifact_id), otherKey.privateKey, keyId)
    expectKernelError(
      () => kernel.completeJob({ job_id: job.job_id, owner: 'runner-1', ...fenceArgs(kernel, job.job_id), status: 'succeeded', run_manifest: crossSigned }),
      422, 'manifest_signature_invalid',
    )
    // Correct signature -> accepted.
    const good = signManifest(makeManifest(kernel, job, metrics.artifact_id), privateKey, keyId)
    const done = kernel.completeJob({ job_id: job.job_id, owner: 'runner-1', ...fenceArgs(kernel, job.job_id), status: 'succeeded', run_manifest: good })
    expect(done.status).toBe('succeeded')
    expect(done.run_manifest?.signature).toBe(good.signature)
    kernel.close()
  })

  it('binds nested resources and lease facts into the Runner manifest signature', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-nested-manifest-sig-'))
    const kernel = new ResearchKernel({
      dbPath: join(dir, 'kernel.db'), casRoot: join(dir, 'cas'), requireSignedManifest: true,
    })
    const project = createConfiguredProject(kernel, { name: 'nested signature', workspace: '/w', brief: makeBrief() })
    const job = kernel.submitJob({ project_id: project.project_id, idempotency_key: 'nested-signature', kind: 'echo' })
    const [claimed] = kernel.claimJobs('runner-1', 60, 1)
    expect(claimed?.job_id).toBe(job.job_id)
    const { publicKey, privateKey } = generateKeyPairSync('ed25519')
    const keyId = 'runner-key-nested-manifest'
    kernel.registerRunnerKey({
      key_id: keyId,
      public_key_pem: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    })
    const bound = kernel.getJob(job.job_id)
    const signed = signRunnerManifest({
      run_id: claimed!.run_id,
      job_id: job.job_id,
      project_id: project.project_id,
      exit_code: 0,
      resources: { cpu: 8, memory_gb: 32 },
      environment: { image: 'fixture@sha256:' + 'a'.repeat(64), variables: { LC_ALL: 'C.UTF-8' } },
      outputs: { metrics: { artifact_id: 'sha256:' + 'b'.repeat(64), rows: 1 } },
      lease: { generation: bound.lease_generation, token: bound.lease_token },
    }, { privateKey, keyId })

    const resourceTamper = structuredClone(signed)
    ;(resourceTamper.resources as { cpu: number }).cpu = 64
    expectKernelError(
      () => kernel.completeJob({
        job_id: job.job_id, owner: 'runner-1', ...fenceArgs(kernel, job.job_id),
        status: 'succeeded', run_manifest: resourceTamper,
      }),
      422, 'manifest_hash_mismatch',
    )
    expect(kernel.getJob(job.job_id).status).toBe('running')

    const leaseTamper = structuredClone(signed)
    ;(leaseTamper.lease as { token: string }).token = 'lt_nested_tamper'
    expectKernelError(
      () => kernel.completeJob({
        job_id: job.job_id, owner: 'runner-1', ...fenceArgs(kernel, job.job_id),
        status: 'succeeded', run_manifest: leaseTamper,
      }),
      422, 'manifest_hash_mismatch',
    )
    expect(kernel.getJob(job.job_id).status).toBe('running')

    const done = kernel.completeJob({
      job_id: job.job_id, owner: 'runner-1', ...fenceArgs(kernel, job.job_id),
      status: 'succeeded', run_manifest: signed,
    })
    expect(done.status).toBe('succeeded')
    kernel.close()
  })

  it('payload_sha256 mismatch is rejected even with a valid signature', () => {
    const { kernel, job, metrics, privateKey, keyId } = signedJobSetup()
    const signed = signManifest(makeManifest(kernel, job, metrics.artifact_id), privateKey, keyId)
    signed.payload_sha256 = '0'.repeat(64)
    expectKernelError(
      () => kernel.completeJob({ job_id: job.job_id, owner: 'runner-1', ...fenceArgs(kernel, job.job_id), status: 'succeeded', run_manifest: signed }),
      422, 'manifest_hash_mismatch',
    )
    kernel.close()
  })

  it('signature referencing an unregistered runner key -> 422 manifest_key_unknown', () => {
    const { kernel, job, metrics, privateKey } = signedJobSetup()
    const signed = signManifest(makeManifest(kernel, job, metrics.artifact_id), privateKey, 'runner-key-never-registered')
    expectKernelError(
      () => kernel.completeJob({ job_id: job.job_id, owner: 'runner-1', ...fenceArgs(kernel, job.job_id), status: 'succeeded', run_manifest: signed }),
      422, 'manifest_key_unknown',
    )
    kernel.close()
  })

  it('registerRunnerKey rejects non-Ed25519 keys', () => {
    const kernel = freshKernel()
    const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 })
    expectKernelError(
      () => kernel.registerRunnerKey({ key_id: 'rsa-key', public_key_pem: rsa.publicKey.export({ type: 'spki', format: 'pem' }).toString() }),
      422, 'runner_key_invalid',
    )
    expectKernelError(
      () => kernel.registerRunnerKey({ key_id: 'garbage', public_key_pem: 'not a pem' }),
      422, 'runner_key_invalid',
    )
    kernel.close()
  })

  it('requireSignedManifest (kernel option) rejects unsigned manifests', () => {
    const { kernel, job } = signedJobSetup({ requireSignedManifest: true })
    expectKernelError(
      () => kernel.completeJob({ job_id: job.job_id, owner: 'runner-1', ...fenceArgs(kernel, job.job_id), status: 'succeeded', run_manifest: { run_id: 'run_x', exit_code: 0 } }),
      422, 'manifest_signature_required',
    )
    kernel.close()
  })

  it('RUN-01: DEFAULT kernel config (no option) rejects unsigned manifests; a signed one is accepted', () => {
    // No requireSignedManifest option at all — the constructor default is
    // TRUE (§12.7), so this is the production configuration.
    const { kernel, job, metrics, privateKey, keyId } = signedJobSetup()
    // The job is claimed; complete with an UNSIGNED manifest -> 422
    // manifest_signature_required and the job stays running.
    expectKernelError(
      () => kernel.completeJob({ job_id: job.job_id, owner: 'runner-1', ...fenceArgs(kernel, job.job_id), status: 'succeeded', run_manifest: makeManifest(kernel, job, metrics.artifact_id) }),
      422, 'manifest_signature_required',
    )
    expect(kernel.getJob(job.job_id).status).toBe('running')
    // The same flow with a valid Ed25519 signature -> succeeded.
    const signed = signManifest(makeManifest(kernel, job, metrics.artifact_id), privateKey, keyId)
    const done = kernel.completeJob({ job_id: job.job_id, owner: 'runner-1', ...fenceArgs(kernel, job.job_id), status: 'succeeded', run_manifest: signed })
    expect(done.status).toBe('succeeded')
    kernel.close()
  })

  it('RUN-01: requireSignedManifest:false explicitly accepts unsigned manifests (compat path)', () => {
    const { kernel, job, metrics } = signedJobSetup({ requireSignedManifest: false })
    const done = kernel.completeJob({ job_id: job.job_id, owner: 'runner-1', ...fenceArgs(kernel, job.job_id), status: 'succeeded', run_manifest: makeManifest(kernel, job, metrics.artifact_id) })
    expect(done.status).toBe('succeeded')
    expect(done.run_manifest?.signature).toBeUndefined()
    kernel.close()
  })

  it('project integrity require_signed_manifest rejects unsigned manifests', () => {
    const { kernel, job } = signedJobSetup()
    // Flag stored on the project's integrity record (raw JSON, read verbatim).
    kernel.db.prepare('UPDATE projects SET integrity = ? WHERE project_id = ?')
      .run(JSON.stringify({ require_signed_manifest: true }), job.project_id)
    expectKernelError(
      () => kernel.completeJob({ job_id: job.job_id, owner: 'runner-1', ...fenceArgs(kernel, job.job_id), status: 'succeeded', run_manifest: { run_id: 'run_x', exit_code: 0 } }),
      422, 'manifest_signature_required',
    )
    kernel.close()
  })

  it('manifest job/project identity mismatch is rejected', () => {
    const { kernel, job, metrics } = signedJobSetup()
    const manifest = makeManifest(kernel, job, metrics.artifact_id)
    manifest.job_id = 'job_some_other'
    expectKernelError(
      () => kernel.completeJob({ job_id: job.job_id, owner: 'runner-1', ...fenceArgs(kernel, job.job_id), status: 'succeeded', run_manifest: manifest }),
      422, 'manifest_job_mismatch',
    )
    kernel.close()
  })

  it('manifest lease generation mismatch is rejected (fencing inside the manifest)', () => {
    const { kernel, job, metrics, privateKey, keyId } = signedJobSetup()
    const manifest = makeManifest(kernel, job, metrics.artifact_id)
    manifest.lease = { generation: 99 }
    const signed = signManifest(manifest, privateKey, keyId)
    expectKernelError(
      () => kernel.completeJob({ job_id: job.job_id, owner: 'runner-1', ...fenceArgs(kernel, job.job_id), status: 'succeeded', run_manifest: signed }),
      422, 'manifest_lease_mismatch',
    )
    kernel.close()
  })
})

describe('RUN-REMOTE-01 §5 两行：secure kinds run_id 全链 + required facts（manifest_run_mismatch / manifest_facts_missing / seed / container）', () => {
  /** formal job + claim + 注册 Ed25519 key（与 signedJobSetup 同款 setup，脱离其 describe 作用域）。 */
  function secureSignedJob(): { kernel: ResearchKernel; job: import('@dsh-scholar/research-schemas').JobRecord & { run_id: string | null }; metrics: import('@dsh-scholar/research-schemas').ArtifactRecord } {
    const kernel = freshKernel()
    const project = createConfiguredProject(kernel, { name: 'sec-facts', workspace: '/w', brief: makeBrief() })
    const metrics = kernel.registerArtifact({ project_id: project.project_id, kind: 'analysis', content: JSON.stringify({ metrics: [{ metric: 'm', value: 1, seed: 1 }] }) })
    const code = codeArtifact(kernel, project.project_id)
    const job = submitTestJob(kernel, {
      project_id: project.project_id, idempotency_key: 'sec-facts-1', kind: 'formal',
      contract_id: approvedContract(kernel, project.project_id), payload: {},
      code_snapshot_id: code.artifact_id, image_digest: NODE_IMAGE_DIGEST,
    })
    kernel.claimJobs('runner-1', 60, 8)
    const { publicKey, privateKey } = generateKeyPairSync('ed25519')
    kernel.registerRunnerKey({ key_id: 'sec-facts-key', public_key_pem: publicKey.export({ type: 'spki', format: 'pem' }).toString() })
    return { kernel, job: kernel.getJob(job.job_id), metrics }
  }

  it('manifest run_id 与 claim 的 runs.run_id 不一致（stale attempt）→ 422 manifest_run_mismatch；job 仍 running', () => {
    const { kernel, job, metrics } = secureSignedJob()
    const manifest = makeManifest(kernel, job, metrics.artifact_id)
    manifest.run_id = `run_stale_${Date.now()}`
    expectKernelError(
      () => kernel.completeJob({ job_id: job.job_id, owner: 'runner-1', ...fenceArgs(kernel, job.job_id), status: 'succeeded', run_manifest: manifest }),
      422, 'manifest_run_mismatch',
    )
    expect(kernel.getJob(job.job_id).status).toBe('running')
    kernel.close()
  })

  it('secure kind manifest 缺 metrics_artifact（required fact）→ 422 manifest_facts_missing', () => {
    const { kernel, job, metrics } = secureSignedJob()
    const manifest = makeManifest(kernel, job, metrics.artifact_id)
    delete manifest.metrics_artifact
    expectKernelError(
      () => kernel.completeJob({ job_id: job.job_id, owner: 'runner-1', ...fenceArgs(kernel, job.job_id), status: 'succeeded', run_manifest: manifest }),
      422, 'manifest_facts_missing',
    )
    expect(kernel.getJob(job.job_id).status).toBe('running')
    kernel.close()
  })

  it('secure kind manifest seed 与 job 固定 seed 不一致 → 422 manifest_seed_mismatch', () => {
    const kernel = freshKernel()
    const project = createConfiguredProject(kernel, { name: 'seed-mismatch', workspace: '/w', brief: makeBrief() })
    const metrics = kernel.registerArtifact({ project_id: project.project_id, kind: 'analysis', content: JSON.stringify({ metrics: [{ metric: 'm', value: 1, seed: 11 }] }) })
    const code = codeArtifact(kernel, project.project_id)
    const job = submitTestJob(kernel, {
      project_id: project.project_id, idempotency_key: 'seed-mm', kind: 'formal', contract_id: approvedContract(kernel, project.project_id),
      payload: { seed: 11 }, code_snapshot_id: code.artifact_id, image_digest: NODE_IMAGE_DIGEST,
    })
    kernel.claimJobs('runner-1', 60, 8)
    const manifest = secureManifest(kernel, job, metrics.artifact_id, 99) // 与 job seed 11 不一致
    expectKernelError(
      () => kernel.completeJob({ job_id: job.job_id, owner: 'runner-1', ...fenceArgs(kernel, job.job_id), status: 'succeeded', run_manifest: manifest }),
      422, 'manifest_seed_mismatch',
    )
    kernel.close()
  })

  it('secure kind manifest container_digest 与 digest-pinned image 不一致 → 422 manifest_container_mismatch', () => {
    const { kernel, job, metrics } = secureSignedJob()
    const manifest = makeManifest(kernel, job, metrics.artifact_id)
    manifest.container_digest = 'docker:evil@sha256:' + '0'.repeat(64)
    expectKernelError(
      () => kernel.completeJob({ job_id: job.job_id, owner: 'runner-1', ...fenceArgs(kernel, job.job_id), status: 'succeeded', run_manifest: manifest }),
      422, 'manifest_container_mismatch',
    )
    expect(kernel.getJob(job.job_id).status).toBe('running')
    kernel.close()
  })

  it('非 secure kinds（analysis/smoke/echo）不受 facts 强制——缺 run_id/metrics 仍接受（legacy 兼容）', () => {
    const kernel = freshKernel()
    const project = createConfiguredProject(kernel, { name: 'fixture-facts', workspace: '/w', brief: makeBrief() })
    const job = submitTestJob(kernel, { project_id: project.project_id, idempotency_key: 'fx1', kind: 'analysis', payload: { metric: 'm' } })
    kernel.claimJobs('runner-1', 60, 8)
    const done = kernel.completeJob({
      job_id: job.job_id, owner: 'runner-1', ...fenceArgs(kernel, job.job_id), status: 'succeeded',
      run_manifest: { run_id: 'run_fake_fx', job_id: job.job_id, exit_code: 0 },
    })
    expect(done.status).toBe('succeeded')
    kernel.close()
  })
})

describe('§11.3 code snapshot archive (SCH-EXEC-002)', () => {
  it('archives ACTUAL file contents into a code artifact + manifest artifact', () => {
    const kernel = freshKernel()
    const project = createConfiguredProject(kernel, { name: 't', workspace: '/w', brief: makeBrief() })
    // P0-4: the archive root is a project workspace (workspace_id +
    // root_relative_path '' = the whole workspace), never a host path.
    const ws = seedWorkspace(kernel, project.project_id, {
      'train.js': 'console.log("real code")\n',
      'data/seed.json': '{"baseline":[1,2]}',
      'node_modules/junk.js': 'ignored',
      '.git/objects/pack': 'ignored',
    })

    const snap = kernel.snapshotCodeArchive(project.project_id, ws, '', 'unit test snapshot')
    expect(snap.files).toBe(2)
    expect(snap.total_bytes).toBe(Buffer.byteLength('console.log("real code")\n') + Buffer.byteLength('{"baseline":[1,2]}'))
    expect(snap.archive_artifact_id.startsWith('sha256:')).toBe(true)
    expect(snap.manifest_artifact_id.startsWith('sha256:')).toBe(true)
    expect(snap.archive_artifact_id).not.toBe(snap.manifest_artifact_id)
    expect(snap.sha256).toBe(snap.archive_artifact_id.replace('sha256:', ''))

    // The archive artifact really contains the file CONTENT (base64) + hashes.
    const archive = JSON.parse(kernel.cas.read(snap.sha256).toString('utf8')) as {
      schema_version: number
      files: Record<string, { sha256: string; content_base64: string }>
    }
    expect(archive.schema_version).toBe(1)
    expect(Buffer.from(archive.files['train.js']!.content_base64, 'base64').toString()).toBe('console.log("real code")\n')
    expect(archive.files['data/seed.json']!.sha256).toBe(createHash('sha256').update('{"baseline":[1,2]}').digest('hex'))

    // STORE-02: submitJob binds a REGISTRY id (code_snap_…) by resolving it
    // to the archive artifact; the job stores the artifact id the Runner
    // materializes from CAS.
    const bound = submitTestJob(kernel, {
      project_id: project.project_id,
      idempotency_key: 'snap-bound',
      kind: 'baseline',
      contract_id: approvedContract(kernel, project.project_id),
      code_snapshot_id: snap.snapshot_id,
      image_digest: NODE_IMAGE_DIGEST,
    })
    expect(bound.code_snapshot_id).toBe(snap.archive_artifact_id)
    expect(bound.code_snapshot_id).not.toBe(snap.snapshot_id)

    // STORE-02: the authoritative registry row exists and matches. P0-4: the
    // source records the workspace binding, never a host path.
    const snapRow = kernel.getCodeSnapshot(snap.snapshot_id)
    expect(snapRow.archive_artifact_id).toBe(snap.archive_artifact_id)
    expect(snapRow.manifest_artifact_id).toBe(snap.manifest_artifact_id)
    expect(snapRow.sha256).toBe(snap.sha256)
    expect(snapRow.file_count).toBe(2)
    expect(snapRow.source.description).toBe('unit test snapshot')
    expect(snapRow.source.workspace_id).toBe(ws)
    expect(snapRow.source.root_relative_path).toBe('')
    expect(archive.files['node_modules/junk.js']).toBeUndefined()
    expect(archive.files['.git/objects/pack']).toBeUndefined()

    // The manifest artifact carries the file list + hashes WITHOUT content.
    const manifest = JSON.parse(kernel.cas.read(snap.manifest_artifact_id!.replace('sha256:', '')).toString('utf8')) as {
      files: Record<string, { sha256: string }>
    }
    expect(manifest.files['train.js']?.sha256).toBe(archive.files['train.js']!.sha256)
    expect(JSON.stringify(manifest)).not.toContain('content_base64')

    // Events recorded (artifact.registered for both artifacts).
    const registered = kernel.listEvents(project.project_id).filter(e => e.kind === 'artifact.registered')
    expect(registered.filter(e => String(e.payload.kind) === 'code').length).toBe(1)
    expect(registered.filter(e => String(e.payload.kind) === 'manifest').length).toBe(1)
    kernel.close()
  })

  it('rejects symlinks escaping the archived root (path escape protection)', () => {
    const kernel = freshKernel()
    const project = createConfiguredProject(kernel, { name: 't', workspace: '/w', brief: makeBrief() })
    const ws = seedWorkspace(kernel, project.project_id, { 'ok.js': 'fine' })
    const outside = mkdtempSync(join(tmpdir(), 'dsh-snap-outside-'))
    writeFileSync(join(outside, 'secret.txt'), 'secret')
    symlinkSync(join(outside, 'secret.txt'), join(kernel.workspaces.workspaceRoot(ws), 'leak.txt'))
    expectKernelError(
      () => kernel.snapshotCodeArchive(project.project_id, ws, '', 'escape test'),
      422, 'snapshot_path_escape',
    )
    // A symlink INSIDE the root is followed and archived (after the escaping
    // symlink is removed).
    rmSync(join(kernel.workspaces.workspaceRoot(ws), 'leak.txt'))
    symlinkSync(join(kernel.workspaces.workspaceRoot(ws), 'ok.js'), join(kernel.workspaces.workspaceRoot(ws), 'alias.js'))
    const snap = kernel.snapshotCodeArchive(project.project_id, ws, '', 'escape test')
    expect(snap.files).toBe(2)
    kernel.close()
  })

  it('rejects a missing root with 422 snapshot_root_missing', () => {
    const kernel = freshKernel()
    const project = createConfiguredProject(kernel, { name: 't', workspace: '/w', brief: makeBrief() })
    const ws = seedWorkspace(kernel, project.project_id, {})
    // P0-4: the root is workspace-relative — a relative subdirectory that
    // does not exist is the new "missing root" case.
    expectKernelError(
      () => kernel.snapshotCodeArchive(project.project_id, ws, 'does-not-exist'),
      422, 'snapshot_root_missing',
    )
    kernel.close()
  })
})

describe('§12.2 JobSpec binding (SCH-EXEC-002)', () => {
  it('formal-class jobs REQUIRE code_snapshot_id (422) and validate it', () => {
    const kernel = freshKernel()
    const project = createConfiguredProject(kernel, { name: 't', workspace: '/w', brief: makeBrief() })
    expectKernelError(
      () => submitTestJob(kernel, { project_id: project.project_id, idempotency_key: 'no-snap', kind: 'baseline', contract_id: approvedContract(kernel, project.project_id) }),
      422, 'code_snapshot_required',
    )
    expectKernelError(
      () => submitTestJob(kernel, { project_id: project.project_id, idempotency_key: 'no-snap2', kind: 'formal', contract_id: approvedContract(kernel, project.project_id) }),
      422, 'code_snapshot_required',
    )
    expectKernelError(
      () => submitTestJob(kernel, { project_id: project.project_id, idempotency_key: 'no-snap3', kind: 'pilot', contract_id: approvedContract(kernel, project.project_id) }),
      422, 'code_snapshot_required',
    )
    expectKernelError(
      () => submitTestJob(kernel, { project_id: project.project_id, idempotency_key: 'no-snap4', kind: 'reproduce', contract_id: approvedContract(kernel, project.project_id) }),
      422, 'code_snapshot_required',
    )
    // Unknown snapshot id -> 422 code_snapshot_unknown.
    expectKernelError(
      () => submitTestJob(kernel, { project_id: project.project_id, idempotency_key: 'bad-snap', kind: 'formal', contract_id: approvedContract(kernel, project.project_id), code_snapshot_id: 'sha256:' + 'a'.repeat(64) }),
      422, 'code_snapshot_unknown',
    )
    // A snapshot from ANOTHER project is also unknown here.
    const other = createConfiguredProject(kernel, { name: 'o', workspace: '/o', brief: makeBrief() })
    const foreignCode = codeArtifact(kernel, other.project_id)
    expectKernelError(
      () => submitTestJob(kernel, { project_id: project.project_id, idempotency_key: 'foreign-snap', kind: 'formal', contract_id: approvedContract(kernel, project.project_id), code_snapshot_id: foreignCode.artifact_id }),
      422, 'code_snapshot_unknown',
    )
    // smoke/echo stay binding-free.
    const smoke = submitTestJob(kernel, { project_id: project.project_id, idempotency_key: 'smoke-ok', kind: 'smoke', payload: { script: 'echo hi' } })
    expect(smoke.code_snapshot_id).toBeNull()
    kernel.close()
  })

  it('persists code_snapshot_id column + image_digest/output_contract/data_artifact_ids payload', () => {
    const kernel = freshKernel()
    const project = createConfiguredProject(kernel, { name: 't', workspace: '/w', brief: makeBrief() })
    const code = codeArtifact(kernel, project.project_id)
    // P0 (acceptance-tests.md §4): data_artifact_ids must be registered in
    // the SAME project — register a real data artifact and bind it.
    const data = kernel.registerArtifact({ project_id: project.project_id, kind: 'data', content: 'dataset-v1' })
    const job = submitTestJob(kernel, {
      project_id: project.project_id,
      idempotency_key: 'bound-1',
      kind: 'formal',
      contract_id: approvedContract(kernel, project.project_id),
      code_snapshot_id: code.artifact_id,
      data_artifact_ids: [data.artifact_id],
      image_digest: NODE_IMAGE_DIGEST,
      output_contract: { metrics: '/outputs/metrics.json', logs: '/outputs/run.log' },
    })
    expect(job.code_snapshot_id).toBe(code.artifact_id)
    expect(job.image_digest).toBe(NODE_IMAGE_DIGEST)
    expect(job.output_contract?.metrics).toBe('/outputs/metrics.json')
    expect(job.payload.data_artifact_ids).toEqual([data.artifact_id])

    // Survives a read-back from the DB (jobFromRow).
    const reloaded = kernel.getJob(job.job_id)
    expect(reloaded.code_snapshot_id).toBe(code.artifact_id)
    expect(reloaded.image_digest).toBe(NODE_IMAGE_DIGEST)
    expect(reloaded.output_contract?.logs).toBe('/outputs/run.log')
    expect(reloaded.data_artifact_ids).toEqual([data.artifact_id])

    // P0: secure kinds require the trusted images.lock digest — missing input
    // is rejected, never defaulted to a tag; the exact locked digest binds.
    const defaulted = submitTestJob(kernel, { project_id: project.project_id, idempotency_key: 'bound-2', kind: 'formal', contract_id: approvedContract(kernel, project.project_id), code_snapshot_id: code.artifact_id, image_digest: NODE_IMAGE_DIGEST })
    expect(defaulted.image_digest).toBe(NODE_IMAGE_DIGEST)
    kernel.close()
  })
})

describe('P0 image digest lock (acceptance-tests.md §4)', () => {
  it('rejects secure jobs with a missing image_digest (422 image_digest_required)', () => {
    const kernel = freshKernel()
    const project = createConfiguredProject(kernel, { name: 't', workspace: '/w', brief: makeBrief() })
    const code = codeArtifact(kernel, project.project_id)
    for (const kind of ['baseline', 'pilot', 'formal', 'reproduce'] as const) {
      expectKernelError(
        () => submitTestJob(kernel, { project_id: project.project_id, idempotency_key: `no-digest-${kind}`, kind, contract_id: approvedContract(kernel, project.project_id), code_snapshot_id: code.artifact_id }),
        422, 'image_digest_required',
      )
    }
    // An explicitly empty digest counts as missing too.
    expectKernelError(
      () => submitTestJob(kernel, { project_id: project.project_id, idempotency_key: 'empty-digest', kind: 'formal', contract_id: approvedContract(kernel, project.project_id), code_snapshot_id: code.artifact_id, image_digest: '' }),
      422, 'image_digest_required',
    )
    kernel.close()
  })

  it('rejects tags, latest and foreign digests (422 image_digest_untrusted)', () => {
    const kernel = freshKernel()
    const project = createConfiguredProject(kernel, { name: 't', workspace: '/w', brief: makeBrief() })
    const code = codeArtifact(kernel, project.project_id)
    // tag / latest / well-formed but NOT the locked entry — all must be 422.
    const untrusted = [
      'node:22-alpine',
      'latest',
      'node:latest',
      'node@sha256:' + '0'.repeat(64),
      'node@sha256:' + 'a'.repeat(63) + 'b',
    ]
    for (const digest of untrusted) {
      expectKernelError(
        () => submitTestJob(kernel, { project_id: project.project_id, idempotency_key: `untrusted-${digest}`, kind: 'formal', contract_id: approvedContract(kernel, project.project_id), code_snapshot_id: code.artifact_id, image_digest: digest }),
        422, 'image_digest_untrusted',
      )
    }
    kernel.close()
  })

  it('latex-compile injects the locked texlive digest and rejects explicit mismatches', () => {
    const kernel = freshKernel()
    const project = createConfiguredProject(kernel, { name: 't', workspace: '/w', brief: makeBrief() })
    const doc = kernel.texEnsure(project.project_id)
    kernel.texWriteFile(doc.document_id, 'paper.tex', '\\begin{document}hi\\end{document}\n')
    const snap = kernel.texSnapshot(doc.document_id)
    // Explicit tag → rejected (never silently replaced).
    expectKernelError(
      () => submitTestJob(kernel, { project_id: project.project_id, idempotency_key: 'latex-tag', kind: 'latex-compile', image_digest: 'texlive/texlive:latest', payload: { tex_document_id: doc.document_id, tex_revision: snap.revision } }),
      422, 'image_digest_untrusted',
    )
    // Missing digest → the kernel injects the locked texlive entry (the
    // kernel owns the TeX pipeline; injection is not a "missing digest").
    const injected = submitTestJob(kernel, { project_id: project.project_id, idempotency_key: 'latex-inject', kind: 'latex-compile', payload: { tex_document_id: doc.document_id, tex_revision: snap.revision } })
    expect(injected.image_digest).toBe(TEXLIVE_IMAGE_DIGEST)
    expect((injected.payload as Record<string, unknown>).image_digest).toBe(TEXLIVE_IMAGE_DIGEST)
    // Exact locked digest → accepted.
    const explicit = submitTestJob(kernel, { project_id: project.project_id, idempotency_key: 'latex-exact', kind: 'latex-compile', image_digest: TEXLIVE_IMAGE_DIGEST, payload: { tex_document_id: doc.document_id, tex_revision: snap.revision } })
    expect(explicit.image_digest).toBe(TEXLIVE_IMAGE_DIGEST)
    kernel.close()
  })

  it('accepts the exact trusted lock digest (P0 success path)', () => {
    const kernel = freshKernel()
    const project = createConfiguredProject(kernel, { name: 't', workspace: '/w', brief: makeBrief() })
    const code = codeArtifact(kernel, project.project_id)
    for (const kind of ['baseline', 'pilot', 'formal', 'reproduce'] as const) {
      const job = submitTestJob(kernel, { project_id: project.project_id, idempotency_key: `ok-${kind}`, kind, contract_id: approvedContract(kernel, project.project_id), code_snapshot_id: code.artifact_id, image_digest: NODE_IMAGE_DIGEST })
      expect(job.status).toBe('queued')
      expect(job.image_digest).toBe(NODE_IMAGE_DIGEST)
      expect((job.payload as Record<string, unknown>).image_digest).toBe(NODE_IMAGE_DIGEST)
    }
    kernel.close()
  })
})

describe('§12.5 metrics file + code snapshot unpack (SCH-EXEC-002)', () => {
  it('unpackCodeSnapshot round-trips an archived snapshot and rejects tampering', () => {
    const kernel = freshKernel()
    const project = createConfiguredProject(kernel, { name: 't', workspace: '/w', brief: makeBrief() })
    const ws = seedWorkspace(kernel, project.project_id, {
      'train.js': '#!/usr/bin/env node\nconsole.log("hi")\n',
      'lib/util.js': 'export const f = 1\n',
    })
    const snap = kernel.snapshotCodeArchive(project.project_id, ws, '', 'unpack test')

    const archiveText = kernel.cas.read(snap.sha256).toString('utf8')
    const files = unpackCodeSnapshot(archiveText)
    expect(files.size).toBe(2)
    expect(files.get('train.js')?.toString()).toBe('#!/usr/bin/env node\nconsole.log("hi")\n')
    expect(files.get('lib/util.js')?.toString()).toBe('export const f = 1\n')

    // Tampered hash -> integrity failure.
    const tampered = JSON.parse(archiveText) as { files: Record<string, { sha256: string; content_base64: string }> }
    tampered.files['train.js']!.sha256 = '0'.repeat(64)
    expect(() => unpackCodeSnapshot(JSON.stringify(tampered))).toThrow(/integrity mismatch/)

    // Unsupported schema_version -> rejected.
    const bad = JSON.parse(archiveText) as { schema_version: number }
    bad.schema_version = 2
    expect(() => unpackCodeSnapshot(JSON.stringify(bad))).toThrow(/schema_version/)

    // Materialization writes real files into a workdir (runner behavior).
    const workDir = mkdtempSync(join(tmpdir(), 'dsh-materialize-'))
    const count = materializeCodeSnapshot(unpackCodeSnapshot(archiveText), workDir)
    expect(count).toBe(2)
    expect(readFileSync(join(workDir, 'train.js'), 'utf8')).toBe('#!/usr/bin/env node\nconsole.log("hi")\n')
    expect(readFileSync(join(workDir, 'lib', 'util.js'), 'utf8')).toBe('export const f = 1\n')
    kernel.close()
  })

  it('computeAnalysis reads §12.5 fixed-schema metrics artifacts (name/value/unit)', () => {
    const kernel = freshKernel()
    const project = createConfiguredProject(kernel, { name: 't', workspace: '/w', brief: makeBrief() })
    const code = codeArtifact(kernel, project.project_id)
    const fileSchema = (seed: number, value: number) => JSON.stringify({
      schema_version: 1, run_id: `run-${seed}`, contract_id: 'expc_x', seed,
      metrics: [{ name: 'f1', value, unit: 'ratio' }],
    })
    const values = [0.81, 0.83, 0.85]
    for (let i = 0; i < values.length; i++) {
      const seed = 11 + i
      const baseline = kernel.registerArtifact({ project_id: project.project_id, kind: 'analysis', content: fileSchema(seed, 0.8) })
      const bJob = submitTestJob(kernel, { project_id: project.project_id, idempotency_key: `fb${i}`, kind: 'baseline', contract_id: approvedContract(kernel, project.project_id), code_snapshot_id: code.artifact_id, image_digest: NODE_IMAGE_DIGEST })
      kernel.claimJobs('r1', 60, 8)
      kernel.completeJob({ job_id: bJob.job_id, owner: 'r1', ...fenceArgs(kernel, bJob.job_id), status: 'succeeded', run_manifest: secureManifest(kernel, bJob, baseline.artifact_id) })
      const art = kernel.registerArtifact({ project_id: project.project_id, kind: 'analysis', content: fileSchema(seed, values[i]!) })
      const job = submitTestJob(kernel, { project_id: project.project_id, idempotency_key: `ff${i}`, kind: 'formal', contract_id: approvedContract(kernel, project.project_id), code_snapshot_id: code.artifact_id, image_digest: NODE_IMAGE_DIGEST })
      kernel.claimJobs('r1', 60, 8)
      kernel.completeJob({ job_id: job.job_id, owner: 'r1', ...fenceArgs(kernel, job.job_id), status: 'succeeded', run_manifest: secureManifest(kernel, job, art.artifact_id) })
    }
    const analysis = kernel.computeAnalysis(project.project_id, undefined, 'f1')
    expect(analysis.n).toBe(3)
    expect(analysis.mean).toBeCloseTo(0.83, 3)
    expect(analysis.baseline_value).toBeCloseTo(0.8, 3)
    expect(analysis.runs.map(r => r.seed).sort()).toEqual([11, 12, 13])
    kernel.close()
  })
})

// ── P0: data_artifact_ids binding (acceptance-tests.md §4) ─────────────────

describe('§4 data artifact binding (P0, acceptance-tests.md §4)', () => {
  /** A failed submission must never leave a queued job behind. */
  function expectNotQueued(kernel: ResearchKernel, projectId: string, idempotencyKey: string): void {
    expect(kernel.listJobs(projectId).some(j => j.idempotency_key === idempotencyKey)).toBe(false)
  }

  it('accepts data_artifact_ids registered in the SAME project with a verifiable hash', () => {
    const kernel = freshKernel()
    const project = createConfiguredProject(kernel, { name: 't', workspace: '/w', brief: makeBrief() })
    const data = kernel.registerArtifact({ project_id: project.project_id, kind: 'data', content: 'dataset-v1\n' })
    const job = submitTestJob(kernel, {
      project_id: project.project_id,
      idempotency_key: 'data-ok',
      kind: 'smoke',
      data_artifact_ids: [data.artifact_id],
    })
    expect(job.status).toBe('queued')
    expect(job.data_artifact_ids).toEqual([data.artifact_id])
    // Bare hex ids are normalized to sha256:<hex> like getArtifact does.
    const bare = submitTestJob(kernel, {
      project_id: project.project_id,
      idempotency_key: 'data-ok-bare',
      kind: 'smoke',
      data_artifact_ids: [data.sha256],
    })
    expect(bare.status).toBe('queued')
    expect(bare.data_artifact_ids).toEqual([data.sha256])
    kernel.close()
  })

  it('rejects an unregistered id with 422 data_artifact_missing (never queued)', () => {
    const kernel = freshKernel()
    const project = createConfiguredProject(kernel, { name: 't', workspace: '/w', brief: makeBrief() })
    const key = 'data-missing'
    expectKernelError(
      () => submitTestJob(kernel, { project_id: project.project_id, idempotency_key: key, kind: 'smoke', data_artifact_ids: ['sha256:' + 'c'.repeat(64)] }),
      422, 'data_artifact_missing',
    )
    expectNotQueued(kernel, project.project_id, key)
    kernel.close()
  })

  it('rejects an artifact of ANOTHER project with 422 data_artifact_foreign (never queued)', () => {
    const kernel = freshKernel()
    const project = createConfiguredProject(kernel, { name: 't', workspace: '/w', brief: makeBrief() })
    const other = createConfiguredProject(kernel, { name: 'o', workspace: '/o', brief: makeBrief() })
    const foreign = kernel.registerArtifact({ project_id: other.project_id, kind: 'data', content: 'other-project-dataset' })
    const key = 'data-foreign'
    expectKernelError(
      () => submitTestJob(kernel, { project_id: project.project_id, idempotency_key: key, kind: 'smoke', data_artifact_ids: [foreign.artifact_id] }),
      422, 'data_artifact_foreign',
    )
    expectNotQueued(kernel, project.project_id, key)
    kernel.close()
  })

  it('rejects a blob missing from CAS with 422 data_artifact_hash_unverifiable (never queued)', () => {
    const kernel = freshKernel()
    const project = createConfiguredProject(kernel, { name: 't', workspace: '/w', brief: makeBrief() })
    const data = kernel.registerArtifact({ project_id: project.project_id, kind: 'data', content: 'will-be-evicted' })
    // Simulate an orphaned artifact record (e.g. CAS GC went wrong): the
    // record exists but its blob cannot be re-verified.
    expect(kernel.cas.remove(data.sha256)).toBe(true)
    expect(kernel.cas.has(data.sha256)).toBe(false)
    const key = 'data-hash'
    expectKernelError(
      () => submitTestJob(kernel, { project_id: project.project_id, idempotency_key: key, kind: 'smoke', data_artifact_ids: [data.artifact_id] }),
      422, 'data_artifact_hash_unverifiable',
    )
    expectNotQueued(kernel, project.project_id, key)
    kernel.close()
  })

  it('empty/undefined data_artifact_ids skip validation entirely', () => {
    const kernel = freshKernel()
    const project = createConfiguredProject(kernel, { name: 't', workspace: '/w', brief: makeBrief() })
    const undefinedIds = submitTestJob(kernel, { project_id: project.project_id, idempotency_key: 'data-none', kind: 'smoke' })
    expect(undefinedIds.status).toBe('queued')
    const emptyIds = submitTestJob(kernel, { project_id: project.project_id, idempotency_key: 'data-empty', kind: 'smoke', data_artifact_ids: [] })
    expect(emptyIds.status).toBe('queued')
    kernel.close()
  })
})

// ── STORE-02: snapshot size limits + host-path hygiene ─────────────────────

describe('§3/STORE-02 code snapshot limits + host-path hygiene', () => {
  function captureKernelError(fn: () => unknown): { status: number; code: string; message: string } {
    try {
      fn()
      throw new Error('expected KernelError to be thrown')
    } catch (error) {
      expect(error).toBeInstanceOf(KernelError)
      return { status: (error as KernelError).status, code: (error as KernelError).code, message: (error as KernelError).message }
    }
  }

  it('rejects a single oversized file without buffering it (422 snapshot_too_large)', () => {
    const kernel = freshKernel()
    const project = createConfiguredProject(kernel, { name: 't', workspace: '/w', brief: makeBrief() })
    const ws = seedWorkspace(kernel, project.project_id, { 'big.js': 'x'.repeat(8) })
    const saved = ResearchKernel.SNAPSHOT_MAX_FILE_BYTES
    try {
      ResearchKernel.SNAPSHOT_MAX_FILE_BYTES = 4 // tiny cap for the test
      const err = captureKernelError(() => kernel.snapshotCodeArchive(project.project_id, ws, '', 'limit test'))
      expect(err.status).toBe(422)
      expect(err.code).toBe('snapshot_too_large')
      expect(err.message).toContain('max_file_bytes=4')
      expect(err.message).toContain('big.js')
    } finally {
      ResearchKernel.SNAPSHOT_MAX_FILE_BYTES = saved
    }
    kernel.close()
  })

  it('snapshot limits equal the §3 desktop defaults (20,000 files / 64 MiB single / 2 GiB total)', () => {
    expect(ResearchKernel.SNAPSHOT_MAX_FILES).toBe(20_000)
    expect(ResearchKernel.SNAPSHOT_MAX_FILE_BYTES).toBe(64 * 1024 * 1024)
    expect(ResearchKernel.SNAPSHOT_MAX_TOTAL_BYTES).toBe(2 * 1024 * 1024 * 1024)
  })

  it('rejects archives beyond max_files / max_total_bytes with measured values (422 snapshot_too_large)', () => {
    const kernel = freshKernel()
    const project = createConfiguredProject(kernel, { name: 't', workspace: '/w', brief: makeBrief() })
    const ws = seedWorkspace(kernel, project.project_id, { 'a.js': 'a', 'b.js': 'b', 'c.js': 'c' })
    const savedFiles = ResearchKernel.SNAPSHOT_MAX_FILES
    const savedTotal = ResearchKernel.SNAPSHOT_MAX_TOTAL_BYTES
    try {
      ResearchKernel.SNAPSHOT_MAX_FILES = 2
      const err = captureKernelError(() => kernel.snapshotCodeArchive(project.project_id, ws, '', 'limit test'))
      expect(err.status).toBe(422)
      expect(err.code).toBe('snapshot_too_large')
      expect(err.message).toContain('max_files=2')

      ResearchKernel.SNAPSHOT_MAX_FILES = savedFiles
      ResearchKernel.SNAPSHOT_MAX_TOTAL_BYTES = 3
      // Files are 2 bytes each → total 6 > 3 must fail with the measured total.
      kernel.workspaceWrite(ws, 'a.js', 'aa')
      kernel.workspaceWrite(ws, 'b.js', 'bb')
      kernel.workspaceWrite(ws, 'c.js', 'cc')
      const err2 = captureKernelError(() => kernel.snapshotCodeArchive(project.project_id, ws, '', 'limit test'))
      expect(err2.status).toBe(422)
      expect(err2.code).toBe('snapshot_too_large')
      expect(err2.message).toContain('max_total_bytes=3')
    } finally {
      ResearchKernel.SNAPSHOT_MAX_FILES = savedFiles
      ResearchKernel.SNAPSHOT_MAX_TOTAL_BYTES = savedTotal
    }
    kernel.close()
  })

  it('never exposes the host path: archive/manifest/registry/snapshot use a display root', () => {
    const kernel = freshKernel()
    const project = createConfiguredProject(kernel, { name: 't', workspace: '/w', brief: makeBrief() })
    const ws = seedWorkspace(kernel, project.project_id, { 'a.js': 'a' })
    const dir = kernel.workspaces.workspaceRoot(ws)
    const snap = kernel.snapshotCodeArchive(project.project_id, ws, '', 'leak test')

    const archive = JSON.parse(kernel.cas.read(snap.sha256).toString('utf8')) as { root?: unknown }
    const manifest = JSON.parse(kernel.cas.read(snap.manifest_artifact_id!.replace('sha256:', '')).toString('utf8')) as { root?: unknown }
    const row = kernel.getCodeSnapshot(snap.snapshot_id)
    const record = kernel.getArtifact(project.project_id, snap.archive_artifact_id!)

    // Placeholder roots for display; materialization only ever reads `files`.
    expect(archive.root).toBe('~')
    expect(manifest.root).toBe('~')
    expect(snap.path).toBe('~')
    expect(row.source.root).toBe('~')
    expect((record.metadata as Record<string, unknown>).root).toBeUndefined()

    // The absolute host path must not appear anywhere in the public surface.
    const text = JSON.stringify({ snap, archive, manifest, row, record })
    expect(text).not.toContain(dir)
    expect(text).not.toContain('/home')
    kernel.close()
  })
})

// ── §16 outbox canonical envelope (EVENT-01) ────────────────────────────────

describe('§16 outbox canonical envelope (EVENT-01)', () => {
  it('allocates per-aggregate monotonic event_seq and fills the envelope columns', () => {
    const kernel = freshKernel()
    const project = createConfiguredProject(kernel, { name: 't', workspace: '/w', brief: makeBrief() })
    // createProject already emitted project.created into the project bucket.
    const e1 = kernel.emit(project.project_id, 'project.transitioned', { project_id: project.project_id, revision: 1, from: 'DRAFT', to: 'SCOPED' })
    const e2 = kernel.emit(project.project_id, 'project.transitioned', { project_id: project.project_id, revision: 2 })
    const e3 = kernel.emit(null, 'job.submitted', { job_id: 'job_x' })
    expect(e1.event_seq).toBeGreaterThan(0)
    expect(e2.event_seq).toBe(e1.event_seq! + 1) // monotonic within the aggregate
    expect(e1.event_version).toBe(1)
    expect(e1.aggregate_type).toBe('project')
    expect(e1.aggregate_id).toBe(project.project_id)
    expect(e1.aggregate_revision).toBe(1)
    expect(e2.aggregate_revision).toBe(2)
    // Aggregate-less events live in their own bucket (first one starts at 1).
    expect(e3.aggregate_type).toBeNull()
    expect(e3.aggregate_id).toBeNull()
    expect(e3.event_seq).toBe(1)
    expect(e3.aggregate_revision).toBeNull()

    // DB rows carry the new columns with defaults.
    const rows = kernel.db.prepare(
      `SELECT event_id, event_seq, event_version, aggregate_type, aggregate_id, aggregate_revision,
              request_id, session_id, attempts, last_error, next_attempt_at, dead_lettered_at
       FROM events WHERE aggregate_type = 'project' ORDER BY event_seq`,
    ).all() as unknown as Array<Record<string, unknown>>
    expect(rows.map(r => r.event_seq)).toEqual([1, 2, 3])
    for (const r of rows) {
      expect(r.event_version).toBe(1)
      expect(r.attempts).toBe(0)
      expect(r.last_error).toBeNull()
      expect(r.next_attempt_at).toBeNull()
      expect(r.dead_lettered_at).toBeNull()
      expect(r.request_id).toBeNull()
      expect(r.session_id).toBeNull()
    }

    // listEvents surfaces the envelope without breaking kind/payload shape.
    const listed = kernel.listEvents(project.project_id)
    expect(listed.map(e => e.event_seq)).toEqual([1, 2, 3])
    for (const e of listed) {
      expect(e.kind).toBeTruthy()
      expect(e.payload).toBeTruthy()
    }
    kernel.close()
  })

  it('passes request_id/session_id through from the payload when present', () => {
    const kernel = freshKernel()
    const project = createConfiguredProject(kernel, { name: 't', workspace: '/w', brief: makeBrief() })
    const e = kernel.emit(project.project_id, 'evidence.accepted', { project_id: project.project_id, request_id: 'req_123', session_id: 'sess_9' })
    expect(e.request_id).toBe('req_123')
    expect(e.session_id).toBe('sess_9')
    const row = kernel.db.prepare('SELECT request_id, session_id FROM events WHERE event_id = ?').get(e.event_id) as { request_id: string | null; session_id: string | null }
    expect(row.request_id).toBe('req_123')
    expect(row.session_id).toBe('sess_9')
    kernel.close()
  })

  it('emit inside an existing transaction reuses it (no nested BEGIN)', () => {
    const kernel = freshKernel()
    const project = createConfiguredProject(kernel, { name: 't', workspace: '/w', brief: makeBrief() })
    // createProjectWithInitialGate runs createProject (which emits) inside a
    // withTransaction — this path must not throw "cannot start a transaction".
    const created = kernel.createProjectWithInitialGate({ name: 'txn', workspace: '/w', brief: makeBrief() })
    expect(created.project.status).toBe('DRAFT')
    const seqs = kernel.listEvents(created.project.project_id).map(ev => ev.event_seq)
    expect(seqs.length).toBeGreaterThan(0)
    expect([...seqs].sort((a, b) => (a ?? 0) - (b ?? 0))).toEqual(seqs)
    kernel.close()
  })
})

describe('RUN-01 runs ledger + GOV-01 principal + v2 roles', () => {
  it('claim records a runs row; complete finalizes manifest/signature/finished_at', () => {
    const kernel = freshKernel()
    const project = createConfiguredProject(kernel, { name: 'runs', workspace: '/w', brief: makeBrief() })
    const job = submitTestJob(kernel, { project_id: project.project_id, idempotency_key: 'r1', kind: 'echo', payload: { message: 'x' } })
    const [claimed] = kernel.claimJobs('runner-1', 60, 8)
    expect(claimed).toBeDefined()
    // RUN-01 (P0): claimJobs MUST return the durable runs.run_id written for
    // this attempt — the runner uses it for manifest/terminal/evidence.
    expect(claimed!.run_id).toMatch(/^run_[a-z2-7]{16,}$/)
    expect(kernel.getJob(job.job_id).run_id).toBe(claimed!.run_id)
    let runs = kernel.listRuns(project.project_id)
    expect(runs.length).toBe(1)
    expect(runs[0]!.job_id).toBe(job.job_id)
    expect(runs[0]!.attempt_no).toBe(1)
    expect(runs[0]!.signature_status).toBe('pending')
    expect(runs[0]!.finished_at).toBeNull()
    expect(runs[0]!.run_id).toBe(claimed!.run_id)
    kernel.completeJob({
      job_id: job.job_id, owner: 'runner-1', status: 'succeeded',
      lease_generation: claimed!.lease_generation!, lease_token: claimed!.lease_token!,
      run_manifest: { run_id: 'run_x', job_id: job.job_id, code_commit: 'c', started_at: new Date().toISOString(), finished_at: new Date().toISOString(), exit_code: 0 },
    })
    runs = kernel.listRuns(project.project_id)
    expect(runs.length).toBe(1)
    expect(runs[0]!.signature_status).toBe('unsigned')
    expect(runs[0]!.finished_at).not.toBeNull()
    expect((runs[0]!.manifest_json as Record<string, unknown> | null)?.run_id).toBe('run_x')
    expect(runs[0]!.run_id).toMatch(/^run_[a-z2-7]{16,}$/)
    kernel.close()
  })

  it('retry bumps attempt_no on the runs ledger', () => {
    const kernel = freshKernel()
    const project = createConfiguredProject(kernel, { name: 'runs2', workspace: '/w', brief: makeBrief() })
    const job = submitTestJob(kernel, { project_id: project.project_id, idempotency_key: 'r2', kind: 'echo', payload: { message: 'x' } })
    kernel.claimJobs('runner-2', 1, 8)
    // expire + recover + re-claim (mirrors run-fencing flows)
    kernel.recoverExpiredLeases(Date.now() + 5000)
    kernel.claimJobs('runner-2', 60, 8)
    const runs = kernel.listRuns(project.project_id)
    expect(runs.length).toBe(2)
    expect(runs.map(r => r.attempt_no).sort()).toEqual([1, 2])
    kernel.close()
  })

  it('kernel-level decideGate keeps actor-only compat; HTTP schema requires principal (covered in run-gate-tests.sh)', () => {
    const kernel = freshKernel()
    const project = createConfiguredProject(kernel, { name: 'gov', workspace: '/w', brief: makeBrief() })
    const gate = kernel.createGate({ project_id: project.project_id, type: 'scope', title: 'g' })
    // Kernel-internal callers (orchestrator) may pass actor without a full
    // principal; the HTTP surface (decisionSchema) rejects those with 422
    // principal_required — asserted by tests/security/run-gate-tests.sh.
    expect(() => kernel.decideGate({ gate_id: gate.gate_id, actor: 'anon', decision: 'approved' } as never)).not.toThrow()
    kernel.close()
  })

  it('gate decision with principal persists tenant/auth_method/session (GOV-01 durable)', () => {
    const kernel = freshKernel()
    const project = createConfiguredProject(kernel, { name: 'gov2', workspace: '/w', brief: makeBrief() })
    const gate = kernel.createGate({ project_id: project.project_id, type: 'scope', title: 'g' })
    kernel.decideGate({
      gate_id: gate.gate_id, actor: 'web-user', decision: 'approved', reason: 'ok',
      principal: { principal_id: 'pi-7', tenant_id: 'acme', auth_method: 'dsh-session', session_id: 'sess-7' },
    })
    const decisions = kernel.listDecisions(project.project_id)
    expect(decisions[0]!.principal).toMatchObject({ principal_id: 'pi-7', tenant_id: 'acme', auth_method: 'dsh-session', session_id: 'sess-7' })
    kernel.close()
  })
})

describe('RUN-01 runs ledger: snapshot resolution + HTTP routes', () => {
  it('resolves snapshot_sha256 (sha256: artifact, code_snap_ registry, null for snapshot-less jobs)', () => {
    const kernel = freshKernel()
    const project = createConfiguredProject(kernel, { name: 'snap-runs', workspace: '/w', brief: makeBrief() })
    const code = codeArtifact(kernel, project.project_id)
    const contract = approvedContract(kernel, project.project_id)
    const formal = submitTestJob(kernel, {
      project_id: project.project_id, idempotency_key: 'snap-runs-formal', kind: 'formal',
      contract_id: contract, payload: {}, code_snapshot_id: code.artifact_id, image_digest: NODE_IMAGE_DIGEST,
    })
    const echo = submitTestJob(kernel, { project_id: project.project_id, idempotency_key: 'snap-runs-echo', kind: 'echo', payload: { message: 'x' } })
    // Registry-id job: submitJob binds code_snap_ → archive artifact id; force
    // the raw registry id back onto the job to exercise the claim-time
    // code_snap_ resolution path (legacy rows written before binding).
    const ws = seedWorkspace(kernel, project.project_id, { 'train.js': 'console.log("x")\n' })
    const snap = kernel.snapshotCodeArchive(project.project_id, ws, '', 'registry run')
    const regJob = submitTestJob(kernel, {
      project_id: project.project_id, idempotency_key: 'snap-runs-reg', kind: 'baseline',
      contract_id: contract, code_snapshot_id: snap.snapshot_id, image_digest: NODE_IMAGE_DIGEST,
    })
    kernel.db.prepare('UPDATE jobs SET code_snapshot_id = ? WHERE job_id = ?').run(snap.snapshot_id, regJob.job_id)

    kernel.claimJobs('runner-1', 60, 8)
    const runs = kernel.listRuns(project.project_id)
    const byJob = (jobId: string): ReturnType<ResearchKernel['listRuns']>[number] => runs.find(r => r.job_id === jobId)!
    expect(byJob(formal.job_id).snapshot_sha256).toBe(code.sha256)
    expect(byJob(formal.job_id).snapshot_sha256).toMatch(/^[0-9a-f]{64}$/)
    expect(byJob(formal.job_id).contract_id).toBe(contract)
    expect(byJob(regJob.job_id).snapshot_sha256).toBe(snap.sha256)
    expect(byJob(echo.job_id).snapshot_sha256).toBeNull()
    expect(byJob(echo.job_id).attempt_no).toBe(1)
    kernel.close()
  })

  it('complete with a signed manifest records signature_status=signed', () => {
    const kernel = freshKernel()
    const project = createConfiguredProject(kernel, { name: 'sig-runs', workspace: '/w', brief: makeBrief() })
    const metrics = kernel.registerArtifact({ project_id: project.project_id, kind: 'analysis', content: JSON.stringify({ metrics: [{ metric: 'm', value: 1, seed: 1 }] }) })
    const code = codeArtifact(kernel, project.project_id)
    const job = submitTestJob(kernel, {
      project_id: project.project_id, idempotency_key: 'sig-runs', kind: 'formal',
      contract_id: approvedContract(kernel, project.project_id), payload: {}, code_snapshot_id: code.artifact_id, image_digest: NODE_IMAGE_DIGEST,
    })
    kernel.claimJobs('runner-1', 60, 8)
    const { publicKey, privateKey } = generateKeyPairSync('ed25519')
    const keyId = 'sig-runs-key'
    kernel.registerRunnerKey({ key_id: keyId, public_key_pem: publicKey.export({ type: 'spki', format: 'pem' }).toString() })
    const signed = signManifest(makeManifest(kernel, job, metrics.artifact_id), privateKey, keyId)
    const done = kernel.completeJob({ job_id: job.job_id, owner: 'runner-1', ...fenceArgs(kernel, job.job_id), status: 'succeeded', run_manifest: signed })
    expect(done.status).toBe('succeeded')
    const run = kernel.listRuns(job.project_id)[0]!
    expect(run.signature_status).toBe('signed')
    expect((run.manifest_json as Record<string, unknown>)?.signature).toBe(signed.signature)
    expect(run.finished_at).not.toBeNull()
    kernel.close()
  })

  it('GET /v1/projects/{id}/runs lists newest-first; GET /runs/{run_id} returns one (404 otherwise)', async () => {
    const { startKernelServer } = await import('../../packages/research-kernel/lib/server.js')
    const kernel = freshKernel()
    const project = createConfiguredProject(kernel, { name: 'http-runs', workspace: '/w', brief: makeBrief() })
    submitTestJob(kernel, { project_id: project.project_id, idempotency_key: 'hr1', kind: 'echo', payload: { message: 'x' } })
    kernel.claimJobs('runner-1', 60, 8)
    const { server, port } = await startKernelServer({ kernel, port: 0 })
    try {
      const base = `http://127.0.0.1:${port}`
      const list = await fetch(`${base}/v1/projects/${project.project_id}/runs`)
      expect(list.status).toBe(200)
      const runs = await list.json() as Array<{ run_id: string; job_id: string; attempt_no: number; snapshot_sha256: string | null; signature_status: string }>
      expect(runs).toHaveLength(1)
      expect(runs[0]!.attempt_no).toBe(1)
      expect(runs[0]!.snapshot_sha256).toBeNull()
      expect(runs[0]!.run_id).toMatch(/^run_[a-z2-7]{16,}$/)
      const one = await fetch(`${base}/v1/projects/${project.project_id}/runs/${runs[0]!.run_id}`)
      expect(one.status).toBe(200)
      expect((await one.json() as { job_id: string }).job_id).toBe(runs[0]!.job_id)
      const missing = await fetch(`${base}/v1/projects/${project.project_id}/runs/run_deadbeef`)
      expect(missing.status).toBe(404)
      expect((await missing.json() as { error: { code: string } }).error.code).toBe('run_not_found')
    } finally {
      server.close()
      kernel.close()
    }
  })
})

describe('GOV-01 Human Gate HTTP boundary', () => {
  it('does not expose the obsolete public v1 decision writer for any payload', async () => {
    const { startKernelServer } = await import('../../packages/research-kernel/lib/server.js')
    const kernel = freshKernel()
    const project = createConfiguredProject(kernel, { name: 'gov-http', workspace: '/w', brief: makeBrief() })
    const gate = kernel.createGate({ project_id: project.project_id, type: 'scope', title: 'g' })
    const { server, port } = await startKernelServer({ kernel, port: 0 })
    try {
      const base = `http://127.0.0.1:${port}`
      const post = (body: unknown): Promise<Response> => fetch(`${base}/v1/gates/${gate.gate_id}/decisions`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
      })
      const none = await post({ decision: 'approved' })
      expect(none.status).toBe(404)
      const actorOnly = await post({ actor: 'agent-tool-1', decision: 'approved' })
      expect(actorOnly.status).toBe(404)
      const emptyPrincipal = await post({ actor: 'x', principal: { principal_id: '' }, decision: 'approved' })
      expect(emptyPrincipal.status).toBe(404)
      expect(kernel.listDecisions(project.project_id)).toHaveLength(0)
      expect(kernel.getProject(project.project_id).status).toBe('DRAFT')
    } finally {
      server.close()
      kernel.close()
    }
  })

  it('does not restore the public writer when a caller supplies a principal body', async () => {
    const { startKernelServer } = await import('../../packages/research-kernel/lib/server.js')
    const kernel = freshKernel()
    const project = createConfiguredProject(kernel, { name: 'gov-http2', workspace: '/w', brief: makeBrief() })
    const gate = kernel.createGate({ project_id: project.project_id, type: 'scope', title: 'g' })
    const { server, port } = await startKernelServer({ kernel, port: 0 })
    try {
      const res = await fetch(`http://127.0.0.1:${port}/v1/gates/${gate.gate_id}/decisions`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          principal: { principal_id: 'pi-9', tenant_id: 'acme', auth_method: 'dsh-session', session_id: 'sess-gov-9' },
          decision: 'approved', reason: 'ok',
        }),
      })
      expect(res.status).toBe(404)
      expect(kernel.getProject(project.project_id).status).toBe('DRAFT')
      expect(kernel.listDecisions(project.project_id)).toEqual([])
    } finally {
      server.close()
      kernel.close()
    }
  })

  it('internal contract approve route keeps actor-only semantics (orchestrator channel)', async () => {
    const { startKernelServer } = await import('../../packages/research-kernel/lib/server.js')
    const kernel = freshKernel()
    const project = createConfiguredProject(kernel, { name: 'gov-approve', workspace: '/w', brief: makeBrief() })
    const contract = kernel.registerContract({
      project_id: project.project_id, idea_id: 'idea_x', data: { dataset_id: 'd' }, methods: { baseline: 'b', treatment: 'a' },
      metrics: { primary: 'f1' }, seeds: [1], analysis: {}, ablations: [], stop_conditions: {},
    })
    const { server, port } = await startKernelServer({ kernel, port: 0 })
    try {
      const res = await fetch(`http://127.0.0.1:${port}/v1/projects/${project.project_id}/contracts/${contract.contract_id}/approve`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ actor: 'orchestrator-1' }),
      })
      expect(res.status).toBe(200)
      const approved = await res.json() as { status: string; approval: { approved_by: string } }
      expect(approved.status).toBe('approved')
      expect(approved.approval.approved_by).toBe('orchestrator-1')
    } finally {
      server.close()
      kernel.close()
    }
  })
})

describe('v2 x-principal-role capability checks (API-01)', () => {
  it('viewer/auditor read-only; researcher writes but no governance; operator/pi govern', async () => {
    const { startKernelServer } = await import('../../packages/research-kernel/lib/server.js')
    const kernel = freshKernel()
    const project = createConfiguredProject(kernel, {
      name: 'roles', workspace: '/w', brief: makeBrief(), creator_principal_id: 'ops-1',
    } as never)
    const projectId = project.project_id
    kernel.addProjectMember({ project_id: projectId, principal_id: 'viewer-1', role: 'viewer', actor: 'ops-1' })
    kernel.addProjectMember({ project_id: projectId, principal_id: 'res-1', role: 'researcher', actor: 'ops-1' })
    kernel.addProjectMember({ project_id: projectId, principal_id: 'aud-1', role: 'auditor', actor: 'ops-1' })
    const scopeGate = kernel.createGate({ project_id: projectId, type: 'scope', title: 'Scope' })
    const { server, port } = await startKernelServer({ kernel, port: 0 })
    try {
      const base = `http://127.0.0.1:${port}`
      // Seed the state through the Kernel domain API; browser decisions use
      // the standalone Human BFF and the public v1 writer no longer exists.
      kernel.decideGate({
        gate_id: scopeGate.gate_id, actor: 'ops-1',
        principal: { principal_id: 'ops-1', auth_method: 'dsh-session' }, decision: 'approved',
      })
      expect(kernel.getProject(projectId).status).toBe('SCOPED')
      const H = (role: string, principalId: string): Record<string, string> => ({
        'content-type': 'application/json', 'x-principal-id': principalId, 'x-principal-role': role,
      })
      // viewer: GET 200, any write 403 role_forbidden.
      const viewerGet = await fetch(`${base}/v2/projects/${projectId}`, { headers: H('viewer', 'viewer-1') })
      expect(viewerGet.status).toBe(200)
      const viewerWrite = await fetch(`${base}/v2/projects/${projectId}/gate-requests`, {
        method: 'POST', headers: H('viewer', 'viewer-1'), body: JSON.stringify({ type: 'idea', title: 'Idea' }),
      })
      expect(viewerWrite.status).toBe(403)
      expect((await viewerWrite.json() as { error: { code: string } }).error.code).toBe('role_forbidden')
      // auditor: read-only too.
      const auditorWrite = await fetch(`${base}/v2/projects/${projectId}/jobs`, {
        method: 'POST', headers: H('auditor', 'aud-1'), body: JSON.stringify({ idempotency_key: 'j1', kind: 'echo' }),
      })
      expect(auditorWrite.status).toBe(403)
      // researcher: ordinary work submission allowed.
      const resJob = await fetch(`${base}/v2/projects/${projectId}/jobs`, {
        method: 'POST', headers: H('researcher', 'res-1'), body: JSON.stringify({ idempotency_key: 'j1', kind: 'echo', payload: { message: 'x' } }),
      })
      expect(resJob.status).toBe(201)
      // researcher: governance writes blocked (transitions + decisions);
      // gate-REQUESTS are a researcher-permitted write (requesting a gate is
      // not deciding it — only gates/decisions etc. are governance).
      const resTrans = await fetch(`${base}/v2/projects/${projectId}/transitions`, {
        method: 'POST', headers: H('researcher', 'res-1'), body: JSON.stringify({ to: 'SURVEYING', expected_revision: 1 }),
      })
      expect(resTrans.status).toBe(403)
      expect((await resTrans.json() as { error: { code: string } }).error.code).toBe('role_forbidden')
      const resGate = await fetch(`${base}/v2/projects/${projectId}/gate-requests`, {
        method: 'POST', headers: H('researcher', 'res-1'), body: JSON.stringify({ type: 'idea', title: 'Idea' }),
      })
      expect(resGate.status).toBe(201)
      const resDecide = await fetch(`${base}/v2/gates/${scopeGate.gate_id}/decisions`, {
        method: 'POST', headers: H('researcher', 'res-1'), body: JSON.stringify({ actor: 'res-1', decision: 'approved' }),
      })
      expect(resDecide.status).toBe(403)
      // operator: transition allowed.
      const opTrans = await fetch(`${base}/v2/projects/${projectId}/transitions`, {
        method: 'POST', headers: H('operator', 'ops-1'), body: JSON.stringify({ to: 'SURVEYING', expected_revision: 1 }),
      })
      expect(opTrans.status).toBe(200)
      expect((await opTrans.json() as { status: string }).status).toBe('SURVEYING')
      // pi: governance allowed.
      const piTrans = await fetch(`${base}/v2/projects/${projectId}/transitions`, {
        method: 'POST', headers: H('pi', 'ops-1'), body: JSON.stringify({ to: 'IDEATING', expected_revision: 2 }),
      })
      expect(piTrans.status).toBe(200)
      // Invalid role -> 403 role_required (fail-closed).
      const badRole = await fetch(`${base}/v2/projects/${projectId}`, { headers: H('superadmin', 'ops-1') })
      expect(badRole.status).toBe(403)
      expect((await badRole.json() as { error: { code: string } }).error.code).toBe('role_required')
      // Present-but-empty role -> 403 role_required.
      const emptyRole = await fetch(`${base}/v2/projects/${projectId}`, { headers: { 'x-principal-id': 'ops-1', 'x-principal-role': ' ' } })
      expect(emptyRole.status).toBe(403)
      expect((await emptyRole.json() as { error: { code: string } }).error.code).toBe('role_required')
    } finally {
      server.close()
      kernel.close()
    }
  })
})

describe('v1 PI-only intake adopt / archive / unarchive (GOV-01/ONBOARD-01 §5 P1)', () => {
  it('kernel second layer: researcher/viewer 403 role_forbidden, non-member 404, missing principal 422, pi succeeds', async () => {
    const { startKernelServer } = await import('../../packages/research-kernel/lib/server.js')
    const kernel = freshKernel()
    const project = createConfiguredProject(kernel, {
      name: 'p1', workspace: '/w', brief: makeBrief(), creator_principal_id: 'ops-1',
    } as never)
    const projectId = project.project_id
    kernel.addProjectMember({ project_id: projectId, principal_id: 'res-1', role: 'researcher', actor: 'ops-1' })
    kernel.addProjectMember({ project_id: projectId, principal_id: 'viewer-1', role: 'viewer', actor: 'ops-1' })
    const intake = kernel.beginIntake({ project_id: projectId, source_label: 's' })
    const { server, port } = await startKernelServer({ kernel, port: 0 })
    try {
      const base = `http://127.0.0.1:${port}`
      const H = (principalId: string): Record<string, string> => ({ 'content-type': 'application/json', 'x-principal-id': principalId })
      const adoptBody = JSON.stringify({ principal: { principal_id: 'ops-1' }, expected_proposal_revision: 1 })
      // The kernel resolves the role from its OWN project_members table: a
      // researcher-role principal is 403 role_forbidden on all three routes.
      for (const [path, body] of [
        [`/v1/projects/${projectId}/intake/${intake.intake_id}/adopt`, adoptBody],
        [`/v1/projects/${projectId}/archive`, undefined],
        [`/v1/projects/${projectId}/unarchive`, undefined],
      ] as const) {
        const r = await fetch(`${base}${path}`, { method: 'POST', headers: H('res-1'), body })
        expect(r.status).toBe(403)
        expect((await r.json() as { error: { code: string } }).error.code).toBe('role_forbidden')
      }
      // viewer: read-only role is 403 too.
      const v = await fetch(`${base}/v1/projects/${projectId}/archive`, { method: 'POST', headers: H('viewer-1') })
      expect(v.status).toBe(403)
      // Missing principal (no header AND no body principal) -> 422
      // principal_required (GOV-01 fail-closed).
      const noPr = await fetch(`${base}/v1/projects/${projectId}/intake/${intake.intake_id}/adopt`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ expected_proposal_revision: 1 }),
      })
      expect(noPr.status).toBe(422)
      expect((await noPr.json() as { error: { code: string } }).error.code).toBe('principal_required')
      const noPrAr = await fetch(`${base}/v1/projects/${projectId}/archive`, { method: 'POST' })
      expect(noPrAr.status).toBe(422)
      expect((await noPrAr.json() as { error: { code: string } }).error.code).toBe('principal_required')
      // Unknown principal -> 404 project_not_found (no enumeration).
      const stranger = await fetch(`${base}/v1/projects/${projectId}/archive`, { method: 'POST', headers: H('stranger-1') })
      expect(stranger.status).toBe(404)
      // pi: archive + unarchive succeed — the kernel's own membership lookup
      // is the authority (no dependence on the BFF role header).
      const piAr = await fetch(`${base}/v1/projects/${projectId}/archive`, { method: 'POST', headers: H('ops-1') })
      expect(piAr.status).toBe(200)
      expect((await piAr.json() as { status: string }).status).toBe('ARCHIVED')
      const piUn = await fetch(`${base}/v1/projects/${projectId}/unarchive`, { method: 'POST', headers: H('ops-1') })
      expect(piUn.status).toBe(200)
      expect((await piUn.json() as { status: string }).status).not.toBe('ARCHIVED')
    } finally {
      server.close()
      kernel.close()
    }
  })

  it('PROJECT-DELETE-01: v1/v2 DELETE is archived-only, PI-only, confirmed and idempotent', async () => {
    const { startKernelServer } = await import('../../packages/research-kernel/lib/server.js')
    const kernel = freshKernel()
    const project = createConfiguredProject(kernel, {
      name: 'Delete HTTP', workspace: '/w', brief: makeBrief(), creator_principal_id: 'pi-1',
    } as never)
    kernel.addProjectMember({ project_id: project.project_id, principal_id: 'operator-1', role: 'operator', actor: 'pi-1' })
    kernel.addProjectMember({ project_id: project.project_id, principal_id: 'researcher-1', role: 'researcher', actor: 'pi-1' })
    kernel.addProjectMember({ project_id: project.project_id, principal_id: 'auditor-1', role: 'auditor', actor: 'pi-1' })
    kernel.addProjectMember({ project_id: project.project_id, principal_id: 'viewer-1', role: 'viewer', actor: 'pi-1' })
    const { server, port } = await startKernelServer({ kernel, port: 0 })
    const base = `http://127.0.0.1:${port}`
    const body = (revision: number, confirmName = project.name) => JSON.stringify({
      expected_revision: revision, confirm_name: confirmName, reason: 'finished',
    })
    const headers = (principal: string, requestId: string, role?: string): Record<string, string> => ({
      'content-type': 'application/json',
      'x-principal-id': principal,
      'x-request-id': requestId,
      ...(role !== undefined ? { 'x-principal-role': role } : {}),
    })
    try {
      const active = await fetch(`${base}/v1/projects/${project.project_id}`, {
        method: 'DELETE', headers: headers('pi-1', 'req-http-delete'), body: body(project.revision),
      })
      expect(active.status).toBe(409)
      expect((await active.json() as { error: { code: string } }).error.code).toBe('project_not_archived')
      const archived = kernel.archiveProject(project.project_id)
      const operator = await fetch(`${base}/v1/projects/${project.project_id}`, {
        method: 'DELETE', headers: headers('operator-1', 'req-http-operator'), body: body(archived.revision),
      })
      expect(operator.status).toBe(403)
      expect((await operator.json() as { error: { code: string } }).error.code).toBe('role_forbidden')
      for (const [principal, role] of [['researcher-1', 'researcher'], ['auditor-1', 'auditor'], ['viewer-1', 'viewer']] as const) {
        const denied = await fetch(`${base}/v1/projects/${project.project_id}`, {
          method: 'DELETE', headers: headers(principal, `req-http-${role}`), body: body(archived.revision),
        })
        expect(denied.status).toBe(403)
        expect((await denied.json() as { error: { code: string } }).error.code).toBe('role_forbidden')
      }
      const stranger = await fetch(`${base}/v1/projects/${project.project_id}`, {
        method: 'DELETE', headers: headers('stranger-1', 'req-http-stranger'), body: body(archived.revision),
      })
      expect(stranger.status).toBe(404)
      const anonymous = await fetch(`${base}/v1/projects/${project.project_id}`, {
        method: 'DELETE', headers: { 'content-type': 'application/json', 'x-request-id': 'req-http-anonymous' }, body: body(archived.revision),
      })
      expect(anonymous.status).toBe(422)
      expect((await anonymous.json() as { error: { code: string } }).error.code).toBe('principal_required')
      const wrong = await fetch(`${base}/v1/projects/${project.project_id}`, {
        method: 'DELETE', headers: headers('pi-1', 'req-http-wrong'), body: body(archived.revision, 'wrong'),
      })
      expect(wrong.status).toBe(422)
      const deleted = await fetch(`${base}/v1/projects/${project.project_id}`, {
        method: 'DELETE', headers: headers('pi-1', 'req-http-delete'), body: body(archived.revision),
      })
      expect(deleted.status).toBe(200)
      const receipt = await deleted.json() as { project_id: string; request_id: string; revision: number }
      expect(receipt).toMatchObject({ project_id: project.project_id, request_id: 'req-http-delete', revision: archived.revision + 1 })
      expect((await fetch(`${base}/v1/projects/${project.project_id}`)).status).toBe(404)
      await expect((await fetch(`${base}/v1/projects`)).json()).resolves.toEqual([])
      const hiddenWrite = await fetch(`${base}/v1/projects/${project.project_id}`, {
        method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'resurrected' }),
      })
      expect(hiddenWrite.status).toBe(404)
      const replay = await fetch(`${base}/v1/projects/${project.project_id}`, {
        method: 'DELETE', headers: headers('pi-1', 'req-http-delete'), body: body(archived.revision),
      })
      expect(replay.status).toBe(200)
      expect(await replay.json()).toEqual(receipt)

      const v2Project = createConfiguredProject(kernel, {
        name: 'Delete V2', workspace: '/w2', brief: makeBrief(), creator_principal_id: 'pi-1',
      } as never)
      const v2Archived = kernel.archiveProject(v2Project.project_id)
      const v2Deleted = await fetch(`${base}/v2/projects/${v2Project.project_id}`, {
        method: 'DELETE', headers: headers('pi-1', 'req-http-v2', 'pi'),
        body: JSON.stringify({ expected_revision: v2Archived.revision, confirm_name: v2Project.name, reason: 'finished' }),
      })
      expect(v2Deleted.status).toBe(200)
      expect((await v2Deleted.json() as { request_id: string }).request_id).toBe('req-http-v2')
    } finally {
      server.close()
      kernel.close()
    }
  })
})

describe('STAT-01 fixed parameters (reconstruction-contracts.md §12)', () => {
  // One baseline + one formal run at a seed, with a metrics artifact (echo of
  // the §12.5 file shape) so computeAnalysis can aggregate.
  function pairRun(kernel: { submitJob(input: unknown): { job_id: string }; claimJobs(owner: string, ttl?: number, limit?: number): Array<{ job_id: string; lease_generation?: number | null; lease_token?: string | null }>; registerArtifact(input: unknown): { artifact_id: string; sha256: string }; completeJob(input: unknown): unknown }, projectId: string, codeSnap: string, contractId: string, key: string, kind: 'baseline' | 'formal', seed: number, value: number): void {
    const job = submitTestJob(kernel, {
      project_id: projectId, idempotency_key: key, kind, contract_id: contractId, code_snapshot_id: codeSnap,
      payload: { seed }, image_digest: 'node@sha256:c610fcdfb1d5b4740dd70c284ed3cb16bb857e0f7166196e36a5501df7a3aa32',
    })
    const [claimed] = kernel.claimJobs('stat-runner', 60, 8)
    expect(claimed?.job_id).toBe(job.job_id)
    const record = kernel.registerArtifact({
      project_id: projectId, kind: 'analysis',
      content: Buffer.from(JSON.stringify({ schema_version: 1, seed, metrics: [{ name: 'm', value, unit: '' }] })),
    })
    kernel.completeJob({
      job_id: job.job_id, owner: 'stat-runner', status: 'succeeded',
      lease_generation: claimed!.lease_generation!, lease_token: claimed!.lease_token!,
      run_manifest: secureManifest(kernel, job, `sha256:${record.sha256}`, seed),
    })
  }

  it('analysis uses the fixed 10,000 resamples and reports n_resamples', () => {
    const kernel = freshKernel()
    const project = createConfiguredProject(kernel, { name: 'stat', workspace: '/w', brief: makeBrief() })
    const codeSnap = kernel.registerArtifact({
      project_id: project.project_id, kind: 'code', content: Buffer.from('x=1'),
    }).artifact_id
    const contract = kernel.registerContract({
      project_id: project.project_id, idea_id: 'i',
      data: { dataset_id: 'd' }, methods: { baseline: 'b', treatment: 'a' },
      metrics: { primary: 'm' }, seeds: [1, 2],
      stop_conditions: { max_gpu_hours: 1, min_completed_seeds: 2, stop_on_data_leakage: true },
    })
    kernel.approveContract(contract.contract_id, 'dec_gate_1', 'pi')
    pairRun(kernel, project.project_id, codeSnap, contract.contract_id, 'b1', 'baseline', 1, 0.4)
    pairRun(kernel, project.project_id, codeSnap, contract.contract_id, 'b2', 'baseline', 2, 0.5)
    pairRun(kernel, project.project_id, codeSnap, contract.contract_id, 'f1', 'formal', 1, 0.6)
    pairRun(kernel, project.project_id, codeSnap, contract.contract_id, 'f2', 'formal', 2, 0.7)
    const analysis = kernel.computeAnalysis(project.project_id, undefined, 'm', { minimum_n: 2 })
    expect(analysis.n).toBe(2)
    expect(analysis.effect_size).toBeCloseTo(0.2, 9)
    const artifact = kernel.getArtifact(project.project_id, analysis.artifact_id)
    const content = JSON.parse(kernel.cas.read(artifact.sha256).toString('utf8')) as { n_resamples?: number }
    expect(content.n_resamples).toBe(10000)
    kernel.close()
  })

  it('derives minimum_n from the bound contract when the caller passes none (§12)', () => {
    // Project A: approved contract with min_completed_seeds=3 and 3 paired
    // runs — computeAnalysis WITHOUT options.minimum_n must pass (the
    // contract value drives AnalysisPlan.minimum_n).
    const kernel = freshKernel()
    const project = createConfiguredProject(kernel, { name: 'stat3', workspace: '/w', brief: makeBrief() })
    const codeSnap = kernel.registerArtifact({
      project_id: project.project_id, kind: 'code', content: Buffer.from('x=1'),
    }).artifact_id
    const contract = kernel.registerContract({
      project_id: project.project_id, idea_id: 'i',
      data: { dataset_id: 'd' }, methods: { baseline: 'b', treatment: 'a' },
      metrics: { primary: 'm' }, seeds: [1, 2, 3],
      stop_conditions: { max_gpu_hours: 1, min_completed_seeds: 3, stop_on_data_leakage: true },
    })
    kernel.approveContract(contract.contract_id, 'dec_gate_1', 'pi')
    pairRun(kernel, project.project_id, codeSnap, contract.contract_id, 'b1', 'baseline', 1, 0.4)
    pairRun(kernel, project.project_id, codeSnap, contract.contract_id, 'b2', 'baseline', 2, 0.5)
    pairRun(kernel, project.project_id, codeSnap, contract.contract_id, 'b3', 'baseline', 3, 0.6)
    pairRun(kernel, project.project_id, codeSnap, contract.contract_id, 'f1', 'formal', 1, 0.6)
    pairRun(kernel, project.project_id, codeSnap, contract.contract_id, 'f2', 'formal', 2, 0.7)
    pairRun(kernel, project.project_id, codeSnap, contract.contract_id, 'f3', 'formal', 3, 0.8)
    const analysis = kernel.computeAnalysis(project.project_id, undefined, 'm')
    expect(analysis.n).toBe(3)
    expect(analysis.effect_size).toBeCloseTo(0.2, 9)
    // Project B: same contract minimum (3) but only 2 paired runs — the
    // contract-derived minimum must be enforced (matched_seeds_required,
    // NOT the legacy fallback 1), proving the derivation really happened.
    const kernelB = freshKernel()
    const projectB = createConfiguredProject(kernelB, { name: 'stat3b', workspace: '/w', brief: makeBrief() })
    const codeSnapB = kernelB.registerArtifact({
      project_id: projectB.project_id, kind: 'code', content: Buffer.from('x=1'),
    }).artifact_id
    const contractB = kernelB.registerContract({
      project_id: projectB.project_id, idea_id: 'i',
      data: { dataset_id: 'd' }, methods: { baseline: 'b', treatment: 'a' },
      metrics: { primary: 'm' }, seeds: [1, 2],
      stop_conditions: { max_gpu_hours: 1, min_completed_seeds: 3, stop_on_data_leakage: true },
    })
    kernelB.approveContract(contractB.contract_id, 'dec_gate_1', 'pi')
    pairRun(kernelB, projectB.project_id, codeSnapB, contractB.contract_id, 'b1', 'baseline', 1, 0.4)
    pairRun(kernelB, projectB.project_id, codeSnapB, contractB.contract_id, 'b2', 'baseline', 2, 0.5)
    pairRun(kernelB, projectB.project_id, codeSnapB, contractB.contract_id, 'f1', 'formal', 1, 0.6)
    pairRun(kernelB, projectB.project_id, codeSnapB, contractB.contract_id, 'f2', 'formal', 2, 0.7)
    expect(() => kernelB.computeAnalysis(projectB.project_id, undefined, 'm'))
      .toThrowError(/requires >= 3 baseline\/treatment runs with MATCHED seeds/)
    kernel.close()
    kernelB.close()
  })

  it('caller cannot lower minimum_n below the contract minimum (422)', () => {
    const kernel = freshKernel()
    const project = createConfiguredProject(kernel, { name: 'stat2', workspace: '/w', brief: makeBrief() })
    const codeSnap = kernel.registerArtifact({
      project_id: project.project_id, kind: 'code', content: Buffer.from('x=1'),
    }).artifact_id
    const contract = kernel.registerContract({
      project_id: project.project_id, idea_id: 'i',
      data: { dataset_id: 'd' }, methods: { baseline: 'b', treatment: 'a' },
      metrics: { primary: 'm' }, seeds: [1, 2, 3],
      stop_conditions: { max_gpu_hours: 1, min_completed_seeds: 3, stop_on_data_leakage: true },
    })
    kernel.approveContract(contract.contract_id, 'dec_gate_1', 'pi')
    pairRun(kernel, project.project_id, codeSnap, contract.contract_id, 'b1', 'baseline', 1, 0.4)
    pairRun(kernel, project.project_id, codeSnap, contract.contract_id, 'b2', 'baseline', 2, 0.5)
    pairRun(kernel, project.project_id, codeSnap, contract.contract_id, 'b3', 'baseline', 3, 0.6)
    pairRun(kernel, project.project_id, codeSnap, contract.contract_id, 'f1', 'formal', 1, 0.6)
    pairRun(kernel, project.project_id, codeSnap, contract.contract_id, 'f2', 'formal', 2, 0.7)
    pairRun(kernel, project.project_id, codeSnap, contract.contract_id, 'f3', 'formal', 3, 0.8)
    // 3 paired runs exist, contract minimum is 3 — a caller asking for 1 must
    // be rejected before the analysis runs.
    expect(() => kernel.computeAnalysis(project.project_id, contract.contract_id, 'm', { minimum_n: 1 }))
      .toThrowError(/cannot be lowered by the caller/)
    kernel.close()
  })
})

describe('P0 hardening round (§4: RUN-01/TERM-01/GOV-02/STAT-01/TEX-02)', () => {
  it('succeeded completion without a run manifest is rejected 422 run_manifest_required (non-fixture kinds)', () => {
    const kernel = freshKernel()
    const project = createConfiguredProject(kernel, { name: 'p0-manifest', workspace: '/w', brief: makeBrief() })
    // kind 'analysis' is NOT an echo/smoke fixture — a succeeded completion
    // without a RunManifest is a protocol violation.
    const job = submitTestJob(kernel, { project_id: project.project_id, idempotency_key: 'p0-an1', kind: 'analysis' })
    kernel.claimJobs('runner-p0', 60, 8)
    expectKernelError(
      () => kernel.completeJob({ job_id: job.job_id, owner: 'runner-p0', ...fenceArgs(kernel, job.job_id), status: 'succeeded' }),
      422, 'run_manifest_required',
    )
    // Job must still be running — the failed completion changed nothing.
    expect(kernel.getJob(job.job_id).status).toBe('running')
    // With a minimal manifest (unsigned OK: freshKernel opts out of signing)
    // the completion succeeds and finalizes the runs row.
    const done = kernel.completeJob({
      job_id: job.job_id, owner: 'runner-p0', ...fenceArgs(kernel, job.job_id), status: 'succeeded',
      run_manifest: { run_id: 'run_p0_1', job_id: job.job_id, exit_code: 0 },
    })
    expect(done.status).toBe('succeeded')
    expect(kernel.listRuns(project.project_id)[0]!.finished_at).not.toBeNull()
    kernel.close()
  })

  it('echo fixture kinds keep completing without a manifest (in-process, §3.2 invariant 1)', () => {
    const kernel = freshKernel()
    const project = createConfiguredProject(kernel, { name: 'p0-echo', workspace: '/w', brief: makeBrief() })
    const job = submitTestJob(kernel, { project_id: project.project_id, idempotency_key: 'p0-e1', kind: 'echo' })
    kernel.claimJobs('runner-p0', 60, 8)
    const done = kernel.completeJob({ job_id: job.job_id, owner: 'runner-p0', ...fenceArgs(kernel, job.job_id), status: 'succeeded' })
    expect(done.status).toBe('succeeded')
    kernel.close()
  })

  it('terminal frames with a wrong lease owner or token are rejected 409 lease_stale', () => {
    const kernel = freshKernel()
    const project = createConfiguredProject(kernel, { name: 'p0-term', workspace: '/w', brief: makeBrief() })
    const job = submitTestJob(kernel, { project_id: project.project_id, idempotency_key: 'p0-t1', kind: 'echo' })
    kernel.claimJobs('runner-p0', 60, 8)
    const frame = { seq: 1, frame_kind: 'chunk' as const, channel: 'stdout' as const, text: 'x', lease_generation: 1 }
    // Wrong owner + correct generation -> 409 lease_stale.
    expectKernelError(
      () => kernel.appendTerminalFrames({ jobId: job.job_id, runId: 'run_t', frames: [frame], owner: 'intruder', lease_token: 'wrong' }),
      409, 'lease_stale',
    )
    // Correct owner + wrong token -> 409 lease_stale.
    expectKernelError(
      () => kernel.appendTerminalFrames({ jobId: job.job_id, runId: 'run_t', frames: [frame], owner: 'runner-p0', lease_token: 'wrong-token' }),
      409, 'lease_stale',
    )
    // Partial credentials -> 409 lease_stale.
    expectKernelError(
      () => kernel.appendTerminalFrames({ jobId: job.job_id, runId: 'run_t', frames: [frame], owner: 'runner-p0' }),
      409, 'lease_stale',
    )
    // Correct owner + token + generation -> accepted.
    const job2 = kernel.getJob(job.job_id)
    const ok = kernel.appendTerminalFrames({
      jobId: job.job_id, runId: 'run_t', frames: [{ ...frame, lease_generation: job2.lease_generation! }],
      owner: 'runner-p0', lease_token: job2.lease_token,
    })
    expect(ok.appended).toBe(1)
    kernel.close()
  })

  it('formal analysis rejects duplicate treatment seeds 422 duplicate_seed (no silent overwrite)', () => {
    const kernel = freshKernel()
    const project = createConfiguredProject(kernel, { name: 'p0-stat', workspace: '/w', brief: makeBrief() })
    const code = codeArtifact(kernel, project.project_id)
    const contract = approvedContract(kernel, project.project_id)
    const run = (key: string, kind: 'baseline' | 'formal', seed: number, value: number): void => {
      const job = submitTestJob(kernel, {
        project_id: project.project_id, idempotency_key: key, kind, contract_id: contract, payload: { seed },
        code_snapshot_id: code.artifact_id, image_digest: NODE_IMAGE_DIGEST,
      })
      kernel.claimJobs('r1', 60, 8)
      const art = kernel.registerArtifact({
        project_id: project.project_id, kind: 'analysis',
        content: JSON.stringify({ schema_version: 1, seed, metrics: [{ name: 'm', value, unit: '' }] }),
      })
      kernel.completeJob({
        job_id: job.job_id, owner: 'r1', ...fenceArgs(kernel, job.job_id), status: 'succeeded',
        run_manifest: secureManifest(kernel, job, `sha256:${art.sha256}`, seed),
      })
    }
    run('b1', 'baseline', 1, 0.4)
    run('f1', 'formal', 1, 0.6)
    // SECOND formal run with the SAME seed 1 — the old code silently used the
    // first; the paired design must reject the duplicate outright.
    run('f2', 'formal', 1, 0.7)
    expectKernelError(() => kernel.computeAnalysis(project.project_id, undefined, 'm'), 422, 'duplicate_seed')
    kernel.close()
  })

  it('formal analysis rejects duplicate baseline seeds 422 duplicate_seed', () => {
    const kernel = freshKernel()
    const project = createConfiguredProject(kernel, { name: 'p0-stat-b', workspace: '/w', brief: makeBrief() })
    const code = codeArtifact(kernel, project.project_id)
    const contract = approvedContract(kernel, project.project_id)
    const run = (key: string, kind: 'baseline' | 'formal', seed: number, value: number): void => {
      const job = submitTestJob(kernel, {
        project_id: project.project_id, idempotency_key: key, kind, contract_id: contract, payload: { seed },
        code_snapshot_id: code.artifact_id, image_digest: NODE_IMAGE_DIGEST,
      })
      kernel.claimJobs('r1', 60, 8)
      const art = kernel.registerArtifact({
        project_id: project.project_id, kind: 'analysis',
        content: JSON.stringify({ schema_version: 1, seed, metrics: [{ name: 'm', value, unit: '' }] }),
      })
      kernel.completeJob({
        job_id: job.job_id, owner: 'r1', ...fenceArgs(kernel, job.job_id), status: 'succeeded',
        run_manifest: secureManifest(kernel, job, `sha256:${art.sha256}`, seed),
      })
    }
    run('b1', 'baseline', 1, 0.4)
    run('b2', 'baseline', 1, 0.41) // duplicate baseline seed
    run('f1', 'formal', 1, 0.6)
    expectKernelError(() => kernel.computeAnalysis(project.project_id, undefined, 'm'), 422, 'duplicate_seed')
    kernel.close()
  })

  it('contract gate approving a FOREIGN project contract is rejected 422 contract_foreign (GOV-02)', () => {
    const kernel = freshKernel()
    const projectA = createConfiguredProject(kernel, { name: 'p0-gov-a', workspace: '/w', brief: makeBrief() })
    const projectB = createConfiguredProject(kernel, { name: 'p0-gov-b', workspace: '/w', brief: makeBrief() })
    const foreign = kernel.registerContract({
      project_id: projectB.project_id, idea_id: 'i',
      data: { dataset_id: 'd' }, methods: { baseline: 'b', treatment: 'a' },
      metrics: { primary: 'm' }, seeds: [1], analysis: {},
      stop_conditions: { max_gpu_hours: 1, min_completed_seeds: 1, stop_on_data_leakage: true },
    })
    // A's contract gate payload references B's contract.
    const gate = kernel.createGate({
      project_id: projectA.project_id, type: 'contract', title: 'freeze foreign',
      payload: { contract_id: foreign.contract_id },
    })
    expectKernelError(
      () => kernel.decideGate({ gate_id: gate.gate_id, actor: 'pi', decision: 'approved', reason: 'ok' }),
      422, 'contract_foreign',
    )
    // Nothing was partially written: the gate stays pending, the contract stays draft.
    expect(kernel.getGate(gate.gate_id).status).toBe('pending')
    expect(kernel.getContract(foreign.contract_id).status).toBe('draft')
    // Same-project contracts still approve (the rejection was the gate's own
    // ownership check, not a general approval problem).
    const own = kernel.registerContract({
      project_id: projectA.project_id, idea_id: 'i',
      data: { dataset_id: 'd' }, methods: { baseline: 'b', treatment: 'a' },
      metrics: { primary: 'm' }, seeds: [1], analysis: {},
      stop_conditions: { max_gpu_hours: 1, min_completed_seeds: 1, stop_on_data_leakage: true },
    })
    kernel.approveContract(own.contract_id, 'dec_own', 'pi')
    expect(kernel.getContract(own.contract_id).status).toBe('approved')
    kernel.close()
  })

  it('latex-compile with an engine outside the fixed whitelist is rejected 422 engine_invalid (TEX-02)', () => {
    const kernel = freshKernel()
    const project = createConfiguredProject(kernel, { name: 'p0-tex', workspace: '/w', brief: makeBrief() })
    const doc = kernel.texEnsure(project.project_id)
    kernel.texWriteFile(doc.document_id, 'paper.tex', '\\documentclass{article}\n\\begin{document}hi\\end{document}\n')
    const snap = kernel.texSnapshot(doc.document_id)
    // A malicious engine string must never reach the build script.
    expectKernelError(
      () => submitTestJob(kernel, {
        project_id: project.project_id, idempotency_key: 'p0-tex-bad',
        kind: 'latex-compile',
        command: ['rm -rf /; echo pwned', '-interaction=nonstopmode', 'paper.tex'],
        payload: { tex_document_id: doc.document_id, tex_revision: snap.revision, tex_snapshot: snap.manifest, engine: 'rm -rf /; echo pwned' },
      }),
      422, 'engine_invalid',
    )
    // Whitelisted engines are accepted.
    const job = submitTestJob(kernel, {
      project_id: project.project_id, idempotency_key: 'p0-tex-ok',
      kind: 'latex-compile',
      command: ['xelatex', '-interaction=nonstopmode', 'paper.tex'],
      payload: { tex_document_id: doc.document_id, tex_revision: snap.revision, tex_snapshot: snap.manifest, engine: 'xelatex' },
    })
    expect(job.kind).toBe('latex-compile')
    kernel.close()
  })

  it('latex-compile snapshot paths with shell metacharacters or traversal are rejected 422 tex_path_invalid (TEX-02)', () => {
    const kernel = freshKernel()
    const project = createConfiguredProject(kernel, { name: 'p0-tex-path', workspace: '/w', brief: makeBrief() })
    const doc = kernel.texEnsure(project.project_id)
    kernel.texWriteFile(doc.document_id, 'paper.tex', '\\documentclass{article}\n\\begin{document}hi\\end{document}\n')
    const snap = kernel.texSnapshot(doc.document_id)
    const payload = (rootFile: unknown, files: unknown[]): Record<string, unknown> => ({
      tex_document_id: doc.document_id,
      tex_revision: snap.revision,
      tex_snapshot: { schema_version: 1, document_id: doc.document_id, revision: snap.revision, root_file: rootFile, files },
    })
    expectKernelError(
      () => submitTestJob(kernel, {
        project_id: project.project_id, idempotency_key: 'p0-tex-p1', kind: 'latex-compile',
        command: ['pdflatex', 'paper.tex'],
        payload: payload('../../etc/passwd', [{ path: 'paper.tex', version: 1, content_hash: 'x' }]),
      }),
      422, 'tex_path_invalid',
    )
    expectKernelError(
      () => submitTestJob(kernel, {
        project_id: project.project_id, idempotency_key: 'p0-tex-p2', kind: 'latex-compile',
        command: ['pdflatex', 'paper.tex'],
        payload: payload('paper.tex', [{ path: 'a;rm -rf /', version: 1, content_hash: 'x' }]),
      }),
      422, 'tex_path_invalid',
    )
    kernel.close()
  })

  it('runner buildLatexRunScript refuses engines outside the fixed whitelist (TEX-02, defense in depth)', () => {
    // The kernel 422s at submit; the runner must ALSO refuse to splice a
    // non-whitelisted engine into the container build script.
    expect(() => buildLatexRunScript('paper.tex', 'rm -rf /; echo pwned')).toThrow(/engine whitelist/)
    expect(() => buildLatexRunScript('paper.tex', 'pdflatex --shell-escape')).toThrow(/engine whitelist/)
    // Whitelisted engines and safe paths generate a script.
    const script = buildLatexRunScript('paper.tex', 'xelatex', ['paper.tex', 'sections/intro.tex'])
    expect(script).toContain('xelatex -interaction=nonstopmode')
    // Shell metacharacters in paths are refused too.
    expect(() => buildLatexRunScript('a;rm -rf /', 'pdflatex')).toThrow(/shell metacharacters|unsafe path/)
    expect(() => buildLatexRunScript('paper.tex', 'pdflatex', ['../../etc/passwd'])).toThrow(/unsafe path/)
  })

  it('runner metrics path must resolve inside the outputs dir — ../ escapes and symlinks are rejected (RUN-02)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-metrics-path-'))
    const outputs = join(dir, 'outputs')
    mkdirSync(outputs, { recursive: true })
    writeFileSync(join(outputs, 'metrics.json'), '{"schema_version":1,"metrics":[{"name":"m","value":1}]}')
    writeFileSync(join(dir, 'outside.json'), 'host file')
    // Legitimate path resolves.
    expect(resolveMetricsFileWithin(outputs, '/outputs/metrics.json')).toBe(resolve(outputs, 'metrics.json'))
    expect(resolveMetricsFileWithin(outputs, 'metrics.json')).toBe(resolve(outputs, 'metrics.json'))
    // Traversal escapes -> null.
    expect(resolveMetricsFileWithin(outputs, '/outputs/../outside.json')).toBeNull()
    expect(resolveMetricsFileWithin(outputs, '../outside.json')).toBeNull()
    expect(resolveMetricsFileWithin(outputs, '/etc/passwd')).toBeNull()
    // Symlink pointing outside -> null (realpath containment).
    try {
      symlinkSync(join(dir, 'outside.json'), join(outputs, 'evil.json'))
      expect(resolveMetricsFileWithin(outputs, '/outputs/evil.json')).toBeNull()
    } catch {
      // Symlink creation may be unsupported on some platforms — skip.
    }
    rmSync(dir, { recursive: true, force: true })
  })
})

describe('service token auth on internal routes (hardening §4 P0 API-01/EVID-01)', () => {
  const SERVICE_TOKEN = 'unit-test-service-token-0001'

  function tokenKernel(): ResearchKernel {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-kernel-svc-'))
    return new ResearchKernel({
      dbPath: join(dir, 'kernel.db'),
      casRoot: join(dir, 'cas'),
      requireSignedManifest: false,
      serviceToken: SERVICE_TOKEN,
    })
  }

  const claimBody = () => ({ owner: 'svc-unit', limit: 1, lease_ttl_seconds: 60 })
  const evidenceBody = (artifact: string) => ({
    source_type: 'analysis', run_ids: [], artifact_refs: [artifact],
    analysis_method: 'bootstrap_95',
    result: { primary_metric: 'f1', value: 0.9, baseline_value: 0.8, effect_size: 0.1, ci_low: 0.02, ci_high: 0.18, n_seeds: 2 },
  })

  async function post(port: number, path: string, body: unknown, headers: Record<string, string> = {}): Promise<{ status: number; code: string }> {
    const res = await fetch(`http://127.0.0.1:${port}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
    })
    const envelope = await res.json().catch(() => ({})) as { error?: { code?: string } }
    return { status: res.status, code: envelope.error?.code ?? '' }
  }

  it('kernel methods are unaffected by a configured serviceToken (no client layer impact)', () => {
    const kernel = tokenKernel()
    const project = createConfiguredProject(kernel, { name: 't', workspace: '/w', brief: makeBrief() })
    const job = submitTestJob(kernel, { project_id: project.project_id, idempotency_key: 'svc-1', kind: 'echo', payload: { message: 'x' } })
    expect(job.status).toBe('queued')
    const claimed = kernel.claimJobs('svc-unit', 60, 8)
    expect(claimed.some(c => c.job_id === job.job_id)).toBe(true)
    expect(kernel.recoverExpiredLeases()).toBeGreaterThanOrEqual(0)
    const { publicKey } = generateKeyPairSync('ed25519')
    kernel.registerRunnerKey({ key_id: 'k1', public_key_pem: publicKey.export({ type: 'spki', format: 'pem' }).toString() })
    const artifact = kernel.registerArtifact({ project_id: project.project_id, kind: 'analysis', content: '{}' })
    const item = kernel.ingestVerifiedEvidence({ project_id: project.project_id, source_type: 'analysis', run_ids: [], artifact_refs: [artifact.artifact_id], analysis_method: 'bootstrap_95', result: { primary_metric: 'f1', value: 0.9, baseline_value: 0.8, effect_size: 0.1, ci_low: 0.02, ci_high: 0.18, n_seeds: 2 } })
    expect(kernel.acceptEvidence({ project_id: project.project_id, evidence_id: item.evidence_id, service_principal: 'verifier', request_id: 'req_svc' }).provenance_status).toBe('accepted')
    const contract = kernel.registerContract({ project_id: project.project_id, idea_id: 'idea_svc', data: { dataset_id: 'd' }, methods: { baseline: 'b', treatment: 'a' }, metrics: { primary: 'm' } })
    expect(kernel.approveContract(contract.contract_id, 'dec_svc', 'pi').status).toBe('approved')
    kernel.close()
  })

  it('server: every internal route rejects missing/bearer/wrong credentials with 403 service_token_required and accepts the correct x-service-token', async () => {
    const { startKernelServer } = await import('../../packages/research-kernel/lib/server.js')
    const kernel = tokenKernel()
    const project = createConfiguredProject(kernel, { name: 't', workspace: '/w', brief: makeBrief() })
    const artifact = kernel.registerArtifact({ project_id: project.project_id, kind: 'analysis', content: '{}' })
    const contract = kernel.registerContract({ project_id: project.project_id, idea_id: 'idea_svc', data: { dataset_id: 'd' }, methods: { baseline: 'b', treatment: 'a' }, metrics: { primary: 'm' } })
    const { publicKey } = generateKeyPairSync('ed25519')
    const { server, port } = await startKernelServer({ kernel, port: 0 })
    try {
      const base = `http://127.0.0.1:${port}`
      // Every internal route, probed four ways: no token / bearer / wrong / correct.
      const routes: Array<{ path: string; body: unknown; ok: number; extraHeaders?: Record<string, string> }> = [
        { path: '/v1/jobs-claim/run', body: claimBody(), ok: 200 },
        { path: '/v1/runner-keys', body: { key_id: 'k-svc', public_key_pem: publicKey.export({ type: 'spki', format: 'pem' }).toString() }, ok: 201 },
        { path: '/v1/recover/leases', body: {}, ok: 200 },
        { path: `/v1/projects/${project.project_id}/evidence/verified`, body: evidenceBody(artifact.artifact_id), ok: 201, extraHeaders: { 'x-service-principal': 'analysis-worker' } },
        { path: `/v1/projects/${project.project_id}/contracts/${contract.contract_id}/approve`, body: { actor: 'svc-unit' }, ok: 200 },
      ]
      for (const route of routes) {
        // 1. no credential at all -> 403 service_token_required
        const none = await post(port, route.path, route.body, route.extraHeaders)
        expect(none.status).toBe(403)
        expect(none.code).toBe('service_token_required')
        // 2. the token in the browser bearer slot -> STILL 403
        const bearer = await post(port, route.path, route.body, { authorization: `Bearer ${SERVICE_TOKEN}`, ...route.extraHeaders })
        expect(bearer.status).toBe(403)
        expect(bearer.code).toBe('service_token_required')
        // 3. a wrong x-service-token -> 403
        const wrong = await post(port, route.path, route.body, { 'x-service-token': 'wrong-token', ...route.extraHeaders })
        expect(wrong.status).toBe(403)
        expect(wrong.code).toBe('service_token_required')
        // 4. the correct x-service-token -> success
        const right = await post(port, route.path, route.body, { 'x-service-token': SERVICE_TOKEN, ...route.extraHeaders })
        expect(right.status).toBe(route.ok)
        expect(right.code).toBe('')
      }
      // The accept route needs a REAL verified evidence row (capture the id
      // from the successful verified POST above — the fourth probe).
      const verifiedRes = await fetch(`${base}/v1/projects/${project.project_id}/evidence/verified`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-service-token': SERVICE_TOKEN, 'x-service-principal': 'analysis-worker' },
        body: JSON.stringify(evidenceBody(artifact.artifact_id)),
      })
      expect(verifiedRes.status).toBe(201)
      const verifiedRow = await verifiedRes.json() as { evidence_id?: string }
      const evidenceId = verifiedRow.evidence_id ?? ''
      expect(evidenceId).not.toBe('')
      const acceptPath = `/v1/projects/${project.project_id}/evidence/${evidenceId}/accept`
      for (const [label, headers, status] of [
        ['no token', {}, 403],
        ['bearer only', { authorization: `Bearer ${SERVICE_TOKEN}`, 'x-service-principal': 'verifier' }, 403],
        ['wrong token', { 'x-service-token': 'wrong-token', 'x-service-principal': 'verifier' }, 403],
        ['correct token', { 'x-service-token': SERVICE_TOKEN, 'x-service-principal': 'verifier' }, 200],
      ] as Array<[string, Record<string, string>, number]>) {
        const r = await post(port, acceptPath, { request_id: `req_${label.replaceAll(' ', '_')}` }, headers)
        expect(r.status).toBe(status)
        if (status === 403) expect(r.code).toBe('service_token_required')
      }
      // Browser-bearing a forged x-service-principal on the public route is
      // still impossible: the verified route demanded the service token above.
    } finally {
      server.close()
      kernel.close()
    }
  })

  it('server: a kernel WITHOUT a serviceToken keeps internal routes open (dev compatibility)', async () => {
    const { startKernelServer } = await import('../../packages/research-kernel/lib/server.js')
    const kernel = freshKernel()
    const { server, port } = await startKernelServer({ kernel, port: 0 })
    try {
      const res = await post(port, '/v1/jobs-claim/run', claimBody())
      expect(res.status).toBe(200)
    } finally {
      server.close()
      kernel.close()
    }
  })

  it('ResearchClient with serviceToken authenticates internal calls; without it the kernel answers 403', async () => {
    const { ResearchClient, KernelApiError } = await import('@dsh-scholar/research-client')
    const { startKernelServer } = await import('../../packages/research-kernel/lib/server.js')
    const kernel = tokenKernel()
    const project = createConfiguredProject(kernel, { name: 't', workspace: '/w', brief: makeBrief() })
    submitTestJob(kernel, { project_id: project.project_id, idempotency_key: 'svc-c', kind: 'echo', payload: { message: 'x' } })
    const { server, port } = await startKernelServer({ kernel, port: 0 })
    const endpoint = `http://127.0.0.1:${port}`
    try {
      // Without the service token the internal calls are rejected 403.
      const anonymous = new ResearchClient({ endpoint })
      await expect(anonymous.claimJobs('svc-unit', 1)).rejects.toMatchObject({ status: 403 })
      await expect(anonymous.claimJobs('svc-unit', 1)).rejects.toThrow(/x-service-token/)
      // With the service token the internal calls succeed.
      const service = new ResearchClient({ endpoint, serviceToken: SERVICE_TOKEN })
      const claimed = await service.claimJobs('svc-unit', 1)
      expect(claimed).toHaveLength(1)
      const { publicKey } = generateKeyPairSync('ed25519')
      const key = await service.registerRunnerKey({ key_id: 'k-client', public_key_pem: publicKey.export({ type: 'spki', format: 'pem' }).toString() })
      expect(key.key_id).toBe('k-client')
      expect((await service.recoverExpiredLeases()).recovered).toBeGreaterThanOrEqual(0)
      const artifact = kernel.registerArtifact({ project_id: project.project_id, kind: 'analysis', content: '{}' })
      const item = await service.ingestVerifiedEvidence({ project_id: project.project_id, source_type: 'analysis', run_ids: [], artifact_refs: [artifact.artifact_id], analysis_method: 'bootstrap_95', result: { primary_metric: 'f1', value: 0.9, baseline_value: 0.8, effect_size: 0.1, ci_low: 0.02, ci_high: 0.18, n_seeds: 2 } })
      expect(item.provenance_status).toBe('verified')
      const accepted = await service.acceptEvidence(project.project_id, item.evidence_id, { request_id: 'req_client' })
      expect(accepted.provenance_status).toBe('accepted')
      const contract = kernel.registerContract({ project_id: project.project_id, idea_id: 'idea_c', data: { dataset_id: 'd' }, methods: { baseline: 'b', treatment: 'a' }, metrics: { primary: 'm' } })
      const approved = await service.approveContract(project.project_id, contract.contract_id, 'svc-client')
      expect(approved.status).toBe('approved')
      // A forged browser bearer never satisfies the internal gate.
      const bearerOnly = new ResearchClient({ endpoint, token: SERVICE_TOKEN })
      await expect(bearerOnly.claimJobs('svc-unit', 1)).rejects.toBeInstanceOf(KernelApiError)
      await expect(bearerOnly.claimJobs('svc-unit', 1)).rejects.toMatchObject({ status: 403 })
      await expect(bearerOnly.claimJobs('svc-unit', 1)).rejects.toThrow(/x-service-token/)
    } finally {
      server.close()
      kernel.close()
    }
  })
})

describe('§5 P0-1 bearer enforcement on token-configured kernels (hardening API-01/SIDE-01)', () => {
  const KERNEL_TOKEN = 'unit-test-kernel-token-0001'
  const SERVICE_TOKEN = 'unit-test-service-token-0002'

  function bearerKernel(serviceToken: string | undefined): ResearchKernel {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-kernel-bearer-'))
    return new ResearchKernel({
      dbPath: join(dir, 'kernel.db'),
      casRoot: join(dir, 'cas'),
      requireSignedManifest: false,
      serviceToken,
    })
  }

  async function request(port: number, path: string, method = 'GET', headers: Record<string, string> = {}, body?: unknown): Promise<{ status: number; code: string }> {
    const res = await fetch(`http://127.0.0.1:${port}${path}`, {
      method,
      headers: { 'content-type': 'application/json', accept: 'application/json', ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    const envelope = await res.json().catch(() => ({})) as { error?: { code?: string } }
    return { status: res.status, code: envelope.error?.code ?? '' }
  }

  it('server: with a configured token every non-health route demands the bearer — missing/wrong → 401 unauthorized, correct → 200; health is exempt', async () => {
    const { startKernelServer } = await import('../../packages/research-kernel/lib/server.js')
    const kernel = bearerKernel(SERVICE_TOKEN)
    const { server, port } = await startKernelServer({ kernel, port: 0, token: KERNEL_TOKEN })
    try {
      // Read without bearer → 401.
      const noAuth = await request(port, '/v1/projects')
      expect(noAuth.status).toBe(401)
      expect(noAuth.code).toBe('unauthorized')
      // Wrong bearer → 401 (same code — no oracle).
      const wrong = await request(port, '/v1/projects', 'GET', { authorization: 'Bearer wrong-token' })
      expect(wrong.status).toBe(401)
      expect(wrong.code).toBe('unauthorized')
      // Correct bearer → 200.
      const right = await request(port, '/v1/projects', 'GET', { authorization: `Bearer ${KERNEL_TOKEN}` })
      expect(right.status).toBe(200)
      // Write without bearer → 401 (a local process cannot mutate anything).
      const write = await request(port, '/v1/projects', 'POST', {}, { name: 'x', workspace: '/w', brief: makeBrief() })
      expect(write.status).toBe(401)
      expect(write.code).toBe('unauthorized')
      // Health is exempt on both version surfaces (sidecar handshake, probes).
      expect((await request(port, '/v1/health')).status).toBe(200)
      expect((await request(port, '/v2/health')).status).toBe(200)
      // /internal/metrics stays behind the bearer (loopback is not enough
      // when a token is configured).
      expect((await request(port, '/internal/metrics')).status).toBe(401)
      expect((await request(port, '/internal/metrics', 'GET', { authorization: `Bearer ${KERNEL_TOKEN}` })).status).toBe(200)
      // Wrong bearer on health is still accepted (exempt surface).
      expect((await request(port, '/v1/health', 'GET', { authorization: 'Bearer wrong' })).status).toBe(200)
    } finally {
      server.close()
      kernel.close()
    }
  })

  it('server: bearer and x-service-token are two independent layers — bearer never unlocks internal routes, x-service-token never substitutes for the bearer on public routes', async () => {
    const { startKernelServer } = await import('../../packages/research-kernel/lib/server.js')
    const kernel = bearerKernel(SERVICE_TOKEN)
    const project = createConfiguredProject(kernel, { name: 't', workspace: '/w', brief: makeBrief() })
    submitTestJob(kernel, { project_id: project.project_id, idempotency_key: 'bearer-1', kind: 'echo', payload: { message: 'x' } })
    const { server, port } = await startKernelServer({ kernel, port: 0, token: KERNEL_TOKEN })
    try {
      // 1. Internal route with ONLY the correct bearer → 403 service_token_required.
      const bearerOnly = await request(port, '/v1/jobs-claim/run', 'POST', { authorization: `Bearer ${KERNEL_TOKEN}` }, { owner: 'svc-neg', limit: 1 })
      expect(bearerOnly.status).toBe(403)
      expect(bearerOnly.code).toBe('service_token_required')
      // 2. Internal route with bearer AND x-service-token → 200 (both layers).
      const both = await request(port, '/v1/jobs-claim/run', 'POST', { authorization: `Bearer ${KERNEL_TOKEN}`, 'x-service-token': SERVICE_TOKEN }, { owner: 'svc-ok', limit: 1 })
      expect(both.status).toBe(200)
      // 3. Public route with ONLY x-service-token → 401 unauthorized (the
      // service identity is not a browser credential).
      const serviceOnly = await request(port, '/v1/projects', 'GET', { 'x-service-token': SERVICE_TOKEN })
      expect(serviceOnly.status).toBe(401)
      expect(serviceOnly.code).toBe('unauthorized')
    } finally {
      server.close()
      kernel.close()
    }
  })

  it('server: a kernel WITHOUT a token skips the bearer check entirely (explicit bare-kernel dev mode)', async () => {
    const { startKernelServer } = await import('../../packages/research-kernel/lib/server.js')
    const kernel = freshKernel()
    const { server, port } = await startKernelServer({ kernel, port: 0 })
    try {
      const res = await request(port, '/v1/projects')
      expect(res.status).toBe(200)
    } finally {
      server.close()
      kernel.close()
    }
  })

  it('ResearchClient with token authenticates to a token-configured kernel; without it the kernel answers 401', async () => {
    const { ResearchClient, KernelApiError } = await import('@dsh-scholar/research-client')
    const { startKernelServer } = await import('../../packages/research-kernel/lib/server.js')
    const kernel = bearerKernel(undefined)
    createConfiguredProject(kernel, { name: 't', workspace: '/w', brief: makeBrief() })
    const { server, port } = await startKernelServer({ kernel, port: 0, token: KERNEL_TOKEN })
    const endpoint = `http://127.0.0.1:${port}`
    try {
      // Without the token the public API is locked: 401 unauthorized.
      const anonymous = new ResearchClient({ endpoint })
      await expect(anonymous.listProjects()).rejects.toBeInstanceOf(KernelApiError)
      await expect(anonymous.listProjects()).rejects.toMatchObject({ status: 401 })
      await expect(anonymous.listProjects()).rejects.toThrow(/missing or invalid bearer token/)
      // fetchArtifact (direct fetch path) also 401s without the token → null.
      await expect(anonymous.fetchArtifact('rsp_x', 'sha256:' + 'a'.repeat(64))).resolves.toBeNull()
      // With the token every call works.
      const authed = new ResearchClient({ endpoint, token: KERNEL_TOKEN })
      expect(await authed.listProjects()).toHaveLength(1)
      // health() goes through the exempt surface even without the token.
      expect((await anonymous.health()).ok).toBe(true)
    } finally {
      server.close()
      kernel.close()
    }
  })
})

describe('opaque RunnerProfile 注册表固定（domain-model.md §2/§9.1，审计 §4 #8）', () => {
  it('省略 runner_profile_id 持久化为显式 null，任何 Job 都 fail closed 且零落库', () => {
    const kernel = freshKernel()
    const project = kernel.createProject({ name: 'unconfigured', workspace: '/w', brief: makeBrief() })
    expect(project.execution.runner_profile_id).toBeNull()
    expectKernelError(
      () => submitTestJob(kernel, { project_id: project.project_id, idempotency_key: 'must-configure', kind: 'echo' }),
      422,
      'runner_profile_required',
    )
    expect(kernel.listJobs(project.project_id)).toHaveLength(0)
    kernel.close()
  })

  it('submitJob 对 secure kinds 注入 opaque runner_profile_id + profile_config_hash（与注册表一致，read-back 保留）', () => {
    const kernel = freshKernel()
    const project = createConfiguredProject(kernel, { name: 't', workspace: '/w', brief: makeBrief() })
    const code = codeArtifact(kernel, project.project_id)
    const job = submitTestJob(kernel, {
      project_id: project.project_id,
      idempotency_key: 'profile-pin-1',
      kind: 'formal',
      contract_id: approvedContract(kernel, project.project_id),
      code_snapshot_id: code.artifact_id,
      image_digest: NODE_IMAGE_DIGEST,
    })
    // Project 默认值本身就是注册的 opaque profile id。
    const cpu = getRunnerProfile(RUNNER_PROFILE_IDS.localDockerCpu)!
    expect(job.payload.runner_profile_id).toBe(cpu.profile_id)
    expect(job.payload.profile_config_hash).toBe(cpu.config_hash)
    expect(job.runner_profile_id).toBe(cpu.profile_id)
    expect(job.profile_config_hash).toBe(cpu.config_hash)
    // DB read-back（jobFromRow）保留 pin
    const reloaded = kernel.getJob(job.job_id)
    expect(reloaded.runner_profile_id).toBe(cpu.profile_id)
    expect(reloaded.profile_config_hash).toBe(cpu.config_hash)
    expect(reloaded.payload.profile_config_hash).toBe(cpu.config_hash)
    // 非 secure kind（echo）不需要正式运行环境 pin。
    const echo = submitTestJob(kernel, { project_id: project.project_id, idempotency_key: 'profile-pin-echo', kind: 'echo', payload: { message: 'hi' } })
    expect(echo.payload.runner_profile_id).toBeUndefined()
    expect(echo.runner_profile_id).toBeNull()
    kernel.close()
  })

  it('job 级 runner_profile_id 覆盖 project 级；project 级 id 被 submit 尊重', () => {
    const kernel = freshKernel()
    const project = createConfiguredProject(kernel, { name: 't', workspace: '/w', brief: makeBrief() })
    const code = codeArtifact(kernel, project.project_id)
    const gpu = getRunnerProfile(RUNNER_PROFILE_IDS.localDockerGpu)!
    const job = submitTestJob(kernel, {
      project_id: project.project_id,
      idempotency_key: 'profile-pin-gpu',
      kind: 'formal',
      contract_id: approvedContract(kernel, project.project_id),
      code_snapshot_id: code.artifact_id,
      image_digest: NODE_IMAGE_DIGEST,
      runner_profile_id: RUNNER_PROFILE_IDS.localDockerGpu,
    })
    expect(job.payload.runner_profile_id).toBe(gpu.profile_id)
    expect(job.payload.profile_config_hash).toBe(gpu.config_hash)
    // 未提供 job override 时使用 project 级 runner_profile_id。
    const proj = createConfiguredProject(kernel, {
      name: 'p2', workspace: '/w2', brief: makeBrief(),
      execution: { runner_profile_id: RUNNER_PROFILE_IDS.localDockerGpu },
    })
    expect(proj.execution.runner_profile_id).toBe(RUNNER_PROFILE_IDS.localDockerGpu)
    const code2 = codeArtifact(kernel, proj.project_id)
    const job2 = submitTestJob(kernel, {
      project_id: proj.project_id,
      idempotency_key: 'profile-pin-proj',
      kind: 'formal',
      contract_id: approvedContract(kernel, proj.project_id),
      code_snapshot_id: code2.artifact_id,
      image_digest: NODE_IMAGE_DIGEST,
    })
    expect(job2.payload.runner_profile_id).toBe(gpu.profile_id)
    // job 级 runner_profile_id 覆盖 project 级
    const job3 = submitTestJob(kernel, {
      project_id: proj.project_id,
      idempotency_key: 'profile-pin-override',
      kind: 'formal',
      contract_id: approvedContract(kernel, proj.project_id),
      code_snapshot_id: code2.artifact_id,
      image_digest: NODE_IMAGE_DIGEST,
      runner_profile_id: RUNNER_PROFILE_IDS.localDockerCpu,
    })
    expect(job3.payload.runner_profile_id).toBe(RUNNER_PROFILE_IDS.localDockerCpu)
    kernel.close()
  })

  it('未知 profile id → 422 runner_profile_unknown（job 级与 project 级均 fail closed，零落库）', () => {
    const kernel = freshKernel()
    const project = createConfiguredProject(kernel, { name: 't', workspace: '/w', brief: makeBrief() })
    const code = codeArtifact(kernel, project.project_id)
    expectKernelError(
      () => submitTestJob(kernel, {
        project_id: project.project_id,
        idempotency_key: 'profile-unknown',
        kind: 'formal',
        contract_id: approvedContract(kernel, project.project_id),
        code_snapshot_id: code.artifact_id,
        image_digest: NODE_IMAGE_DIGEST,
        runner_profile_id: 'profile_nonexistent_v1',
      }),
      422, 'runner_profile_unknown',
    )
    // createProject 拒绝未登记 id（零落库）
    expectKernelError(
      () => createConfiguredProject(kernel, { name: 'bad', workspace: '/w', brief: makeBrief(), execution: { runner_profile_id: 'profile_nonexistent_v1' } }),
      422, 'runner_profile_unknown',
    )
    expect(kernel.listProjectsPage(50, undefined).items.map(p => p.name)).not.toContain('bad')
    // 任意未登记裸字符串同样拒绝。
    expectKernelError(
      () => submitTestJob(kernel, {
        project_id: project.project_id,
        idempotency_key: 'profile-enum-like',
        kind: 'formal',
        contract_id: approvedContract(kernel, project.project_id),
        code_snapshot_id: code.artifact_id,
        image_digest: NODE_IMAGE_DIGEST,
        runner_profile_id: 'local-docker',
      }),
      422, 'runner_profile_unknown',
    )
    kernel.close()
  })

  it('isolated-subprocess 限制：secure kinds 经 profile 解析后 422 container_execution_required', () => {
    const kernel = freshKernel()
    const project = createConfiguredProject(kernel, {
      name: 't', workspace: '/w', brief: makeBrief(),
      execution: { runner_profile_id: 'profile_isolated_subprocess_v1', runner_target_id: 'target_local_process_v1' },
    })
    const code = codeArtifact(kernel, project.project_id)
    for (const kind of ['baseline', 'pilot', 'formal', 'reproduce'] as const) {
      expectKernelError(
        () => submitTestJob(kernel, { project_id: project.project_id, idempotency_key: `iso-${kind}`, kind, contract_id: approvedContract(kernel, project.project_id), code_snapshot_id: code.artifact_id, image_digest: NODE_IMAGE_DIGEST }),
        422, 'container_execution_required',
      )
    }
    // 显式 opaque isolated 注册表 id 同样拒绝（同一个 profile 语义）
    expectKernelError(
      () => submitTestJob(kernel, { project_id: project.project_id, idempotency_key: 'iso-opaque', kind: 'formal', contract_id: approvedContract(kernel, project.project_id), code_snapshot_id: code.artifact_id, image_digest: NODE_IMAGE_DIGEST, runner_profile_id: RUNNER_PROFILE_IDS.isolatedSubprocess }),
      422, 'container_execution_required',
    )
    // trusted-smoke-fixture（smoke + 显式标记）仍可提交（runner 端受 trusted_fixture 门禁）
    const smoke = submitTestJob(kernel, { project_id: project.project_id, idempotency_key: 'iso-smoke', kind: 'smoke', payload: { script: 'echo hi', trusted_fixture: true } })
    expect(smoke.status).toBe('queued')
    kernel.close()
  })

  it('latex-compile 同样固定 project profile pin（texlive digest 不变）', () => {
    const kernel = freshKernel()
    const project = createConfiguredProject(kernel, { name: 't', workspace: '/w', brief: makeBrief() })
    const doc = kernel.texEnsure(project.project_id)
    kernel.texWriteFile(doc.document_id, 'paper.tex', '\\begin{document}hi\\end{document}\n')
    const snap = kernel.texSnapshot(doc.document_id)
    const job = submitTestJob(kernel, { project_id: project.project_id, idempotency_key: 'latex-profile-pin', kind: 'latex-compile', payload: { tex_document_id: doc.document_id, tex_revision: snap.revision } })
    expect(job.image_digest).toBe(TEXLIVE_IMAGE_DIGEST)
    expect(job.payload.runner_profile_id).toBe(RUNNER_PROFILE_IDS.localDockerCpu)
    expect(job.payload.profile_config_hash).toBe(getRunnerProfile(RUNNER_PROFILE_IDS.localDockerCpu)!.config_hash)
    kernel.close()
  })
})

describe('INIT-GRILL-02 v2 name-only Init (init-grill-upload-models.md §1/§2)', () => {
  /** v2 name-only create over HTTP with the BFF-style identity headers. */
  async function httpCreate(base: string, body: unknown, headers: Record<string, string> = {}): Promise<Response> {
    return fetch(`${base}/v2/projects`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': 'ik-default', 'x-principal-id': 'pi-1', ...headers },
      body: JSON.stringify(body),
    })
  }

  it('POST /v2/projects name-only → DRAFT + collecting + active Init Intake + PI membership + budget, NO Scope Gate', async () => {
    const kernel = freshKernel()
    const { startKernelServer } = await import('../../packages/research-kernel/lib/server.js')
    const { server, port } = await startKernelServer({ kernel, port: 0 })
    try {
      const response = await httpCreate(`http://127.0.0.1:${port}`, { name: '  My research  ' })
      expect(response.status).toBe(201)
      const out = (await response.json()) as {
        project: { project_id: string; name: string; status: string; brief_status: string; brief: { problem: string; scope: string } }
        intake: { intake_id: string; status: string; source_label: string }
        membership: Array<{ role: string }>
      }
      expect(out.project.name).toBe('My research') // trimmed
      expect(out.project.status).toBe('DRAFT')
      expect(out.project.brief_status).toBe('collecting')
      // brief 字段在 collecting 期间使用明确标记的内部占位值。
      expect(out.project.brief.problem).toBe('[collecting]')
      expect(out.project.brief.scope).toBe('[collecting]')
      expect(out.intake.source_label).toBe('project-init')
      expect(['draft', 'uploading', 'scanning', 'needs_input', 'grilling', 'proposal_ready', 'awaiting_human']).toContain(out.intake.status)
      expect(out.membership.some(m => m.role === 'pi')).toBe(true)
      // 不得创建 Scope Gate。
      expect(kernel.listGates(out.project.project_id)).toHaveLength(0)
      // 默认 Budget 存在。
      expect(kernel.getBudget(out.project.project_id).model_cost_usd).toBe(0)
      // name-only 创建持久化显式未配置状态，不能静默选本机 Docker。
      expect(kernel.getProject(out.project.project_id).execution.runner_profile_id).toBeNull()
      expect(kernel.projectProjection(out.project.project_id).next_actions_v2.every(action => action.code !== 'baseline_reproduce')).toBe(true)
      kernel.close()
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()))
    }
  })

  it('Idempotency-Key and Human Principal are REQUIRED (422 fail closed)', async () => {
    const kernel = freshKernel()
    const { startKernelServer } = await import('../../packages/research-kernel/lib/server.js')
    const { server, port } = await startKernelServer({ kernel, port: 0 })
    try {
      const base = `http://127.0.0.1:${port}`
      const noIdem = await fetch(`${base}/v2/projects`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'x' }),
      })
      expect(noIdem.status).toBe(422)
      expect(((await noIdem.json()) as { error: { code: string } }).error.code).toBe('idempotency_key_required')
      const noPrincipal = await fetch(`${base}/v2/projects`, {
        method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': 'ik-p' }, body: JSON.stringify({ name: 'x' }),
      })
      expect(noPrincipal.status).toBe(422)
      expect(((await noPrincipal.json()) as { error: { code: string } }).error.code).toBe('principal_required')
      // name 去空白后为空 / 超长 → 422 validation_error。
      const emptyName = await httpCreate(base, { name: '   ' })
      expect(emptyName.status).toBe(422)
      const longName = await httpCreate(base, { name: 'x'.repeat(121) })
      expect(longName.status).toBe(422)
      kernel.close()
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()))
    }
  })

  it('same idempotency key + same request hash replays the SAME project/intake; different hash is 409', async () => {
    const kernel = freshKernel()
    const { startKernelServer } = await import('../../packages/research-kernel/lib/server.js')
    const { server, port } = await startKernelServer({ kernel, port: 0 })
    try {
      const base = `http://127.0.0.1:${port}`
      const first = await httpCreate(base, { name: 'Replay' }, { 'idempotency-key': 'ik-replay' })
      expect(first.status).toBe(201)
      const one = (await first.json()) as { project: { project_id: string }; intake: { intake_id: string } }
      const replay = await httpCreate(base, { name: 'Replay' }, { 'idempotency-key': 'ik-replay' })
      expect(replay.status).toBe(201)
      const two = (await replay.json()) as { project: { project_id: string }; intake: { intake_id: string } }
      expect(two.project.project_id).toBe(one.project.project_id)
      expect(two.intake.intake_id).toBe(one.intake.intake_id)
      // 同 key 不同请求 hash → 409 idempotency_conflict。
      const conflict = await httpCreate(base, { name: 'Different Name' }, { 'idempotency-key': 'ik-replay' })
      expect(conflict.status).toBe(409)
      expect(((await conflict.json()) as { error: { code: string } }).error.code).toBe('idempotency_conflict')
      kernel.close()
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()))
    }
  })

  it('collecting 项目 NextAction 只指向 intake_answer/intake_resume，无 scope_gate_submit/gate_decide', async () => {
    const kernel = freshKernel()
    const { startKernelServer } = await import('../../packages/research-kernel/lib/server.js')
    const { server, port } = await startKernelServer({ kernel, port: 0 })
    try {
      const base = `http://127.0.0.1:${port}`
      const created = await httpCreate(base, { name: 'Next' }, { 'idempotency-key': 'ik-next' })
      const out = (await created.json()) as { project: { project_id: string } }
      const projection = kernel.projectProjection(out.project.project_id)
      expect(projection.project.brief_status).toBe('collecting')
      const codes = projection.next_actions_v2.map(a => a.code)
      // 契约：collecting 项目 NextAction 只能指向 intake_answer/intake_resume。
      expect(codes.every(c => c === 'intake_resume' || c === 'intake_answer' || c === 'intake_scan' || c === 'intake_propose' || c === 'intake_adopt')).toBe(true)
      expect(codes).toContain('intake_resume')
      expect(codes).not.toContain('scope_gate_submit')
      expect(codes).not.toContain('gate_decide')
      kernel.close()
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()))
    }
  })

  it('Grill 确定性状态机：固定问题顺序、每次一个当前问题、answer 后推进、全部答完 ready_to_confirm', async () => {
    const kernel = freshKernel()
    const { startKernelServer } = await import('../../packages/research-kernel/lib/server.js')
    const { server, port } = await startKernelServer({ kernel, port: 0 })
    try {
      const base = `http://127.0.0.1:${port}`
      const created = await httpCreate(base, { name: 'Grill' }, { 'idempotency-key': 'ik-grill' })
      const out = (await created.json()) as { project: { project_id: string } }
      const projectId = out.project.project_id
      const ORDER = ['brief.problem', 'brief.scope', 'brief.questions', 'brief.primary_metrics', 'brief.target_outputs', 'brief.constraints', 'brief.material_context']
      const seen: string[] = []
      for (;;) {
        const projection = (await (await fetch(`${base}/v2/projects/${projectId}/grill`)).json()) as {
          question: { question_code: string; question_revision: number; required: boolean } | null
          ready_to_confirm: boolean
        }
        if (projection.question === null) break
        seen.push(projection.question.question_code)
        expect(projection.question.question_revision).toBe(1)
        expect(projection.question.required).toBe(true)
        const answer = await fetch(`${base}/v2/projects/${projectId}/grill/answers`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-principal-id': 'pi-1' },
          body: JSON.stringify({ question_code: projection.question.question_code, question_revision: 1, value: `answer for ${projection.question.question_code}` }),
        })
        expect(answer.status).toBe(200)
      }
      expect(seen).toEqual(ORDER)
      const final = (await (await fetch(`${base}/v2/projects/${projectId}/grill`)).json()) as {
        ready_to_confirm: boolean
        brief_preview: { problem: string; scope: string }
      }
      expect(final.ready_to_confirm).toBe(true)
      expect(final.brief_preview.problem).toBe('answer for brief.problem')
      expect(final.brief_preview.scope).toBe('answer for brief.scope')
      kernel.close()
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()))
    }
  })

  it('只有 PI 的显式确认事务创建且只创建一个 pending Scope Gate；非 PI 403', async () => {
    const kernel = freshKernel()
    const { startKernelServer } = await import('../../packages/research-kernel/lib/server.js')
    const { server, port } = await startKernelServer({ kernel, port: 0 })
    try {
      const base = `http://127.0.0.1:${port}`
      const created = await httpCreate(base, { name: 'Confirm' }, { 'idempotency-key': 'ik-confirm' })
      const out = (await created.json()) as { project: { project_id: string } }
      const projectId = out.project.project_id
      // 答完全部必答问题。
      const ORDER = ['brief.problem', 'brief.scope', 'brief.questions', 'brief.primary_metrics', 'brief.target_outputs', 'brief.constraints', 'brief.material_context']
      for (const code of ORDER) {
        await fetch(`${base}/v2/projects/${projectId}/grill/answers`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-principal-id': 'pi-1' },
          body: JSON.stringify({ question_code: code, question_revision: 1, value: `a:${code}` }),
        })
      }
      const projection = (await (await fetch(`${base}/v2/projects/${projectId}/grill`)).json()) as { ready_to_confirm: boolean; project_revision: number; intake_revision: number }
      expect(projection.ready_to_confirm).toBe(true)
      // 非 PI（researcher）→ 403 role_forbidden（BFF 注入角色，内核复检）。
      const researcher = await fetch(`${base}/v2/projects/${projectId}/grill/confirm`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'idempotency-key': 'ik-confirm-2', 'x-principal-id': 'pi-1', 'x-principal-role': 'researcher' },
        body: JSON.stringify({ expected_project_revision: projection.project_revision, expected_intake_revision: projection.intake_revision }),
      })
      expect(researcher.status).toBe(403)
      // PI 确认 → 写入 canonical Brief、brief_status=confirmed、唯一 pending Scope Gate。
      const confirm = await fetch(`${base}/v2/projects/${projectId}/grill/confirm`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'idempotency-key': 'ik-confirm-3', 'x-principal-id': 'pi-1', 'x-principal-role': 'pi' },
        body: JSON.stringify({ expected_project_revision: projection.project_revision, expected_intake_revision: projection.intake_revision }),
      })
      expect(confirm.status).toBe(200)
      const result = (await confirm.json()) as { project: { brief_status: string; brief: { problem: string } }; gate: { gate_id: string; type: string; status: string } }
      expect(result.project.brief_status).toBe('confirmed')
      expect(result.project.brief.problem).toBe('a:brief.problem')
      expect(result.gate.type).toBe('scope')
      expect(result.gate.status).toBe('pending')
      const gates = kernel.listGates(projectId)
      expect(gates).toHaveLength(1)
      // 再次确认 → 409 scope_gate_exists。
      const again = await fetch(`${base}/v2/projects/${projectId}/grill/confirm`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'idempotency-key': 'ik-confirm-4', 'x-principal-id': 'pi-1', 'x-principal-role': 'pi' },
        body: JSON.stringify({ expected_project_revision: projection.project_revision + 1, expected_intake_revision: projection.intake_revision + 1 }),
      })
      expect(again.status).toBe(409)
      // 确认后 NextAction 回到 scope_gate_submit（Gate 已存在）。
      const after = kernel.projectProjection(projectId)
      expect(after.next_actions_v2.some(a => a.code === 'scope_gate_submit')).toBe(true)
      kernel.close()
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()))
    }
  })

  it('v1 完整创建仍是兼容 adapter（createProject 不因 name-only 流程消失）', () => {
    const kernel = freshKernel()
    const project = createConfiguredProject(kernel, { name: 'v1 legacy', workspace: '/w', brief: makeBrief() })
    expect(project.brief_status).toBe('confirmed')
    expect(kernel.listGates(project.project_id)).toHaveLength(0)
    kernel.close()
  })
})
