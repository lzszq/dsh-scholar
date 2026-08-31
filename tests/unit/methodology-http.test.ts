import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  DirectionProposal,
  KnowledgeActivationRequest,
  KnowledgePackageEvaluation,
  KnowledgePackageRecord,
  ProtocolRevision,
  ResearchSynthesis,
  ReviewFinding,
  ReverseOutline,
} from '@dsh-scholar/research-schemas'
import { ResearchClient, KernelApiError } from '../../packages/research-client/src/index.js'
import { ResearchKernel } from '../../packages/research-kernel/src/kernel.js'
import { protocolRevisionCanonicalHash } from '../../packages/research-kernel/src/methodology-store.js'
import { writingClaimEvidenceSha256, writingTexSha256 } from '../../packages/research-kernel/src/writing-methodology.js'
import { startKernelServer } from '../../packages/research-kernel/src/server.js'

const HASH_A = `sha256:${'a'.repeat(64)}`
const HASH_B = `sha256:${'b'.repeat(64)}`
const NOW = '2026-08-20T08:00:00.000Z'

function brief() {
  return {
    problem: 'Test the methodology HTTP seam.', scope: 'HTTP only', questions: ['Does it work?'],
    primary_metrics: ['correctness'], resources: 'local', risks: [], target_outputs: ['paper'],
    target_venue: null, baseline_repo: null, domain: 'software engineering',
  }
}

function protocol(projectId: string, protocolId = 'protocol_http_1') {
  const record = ProtocolRevision.parse({
    protocol_id: protocolId,
    project_id: projectId,
    revision: 1,
    supersedes: null,
    status: 'frozen',
    intent: 'confirmatory',
    research_question_ref: 'question:http',
    target_claim_ref: 'claim:http',
    hypothesis: 'The typed HTTP seam preserves methodology invariants.',
    prediction: 'Every supported route returns its append receipt.',
    variables: { manipulated: ['request'], controlled: ['database'], measured: ['response'] },
    metrics: { primary: 'correctness', secondary: [], baseline_ref: 'baseline:http', analysis_plan_artifact_id: 'artifact:plan' },
    pins: {
      contract: { ref: 'contract:http', sha256: HASH_A },
      code: { ref: 'code:http', sha256: HASH_A },
      data: { ref: 'data:http', sha256: HASH_A },
      environment: { ref: 'environment:http', sha256: HASH_A },
    },
    stopping_conditions: ['One complete route pass.'],
    failure_criteria: ['Any route violates its contract.'],
    allowed_deviations: [],
    deviation_handling: 'Freeze a new protocol revision.',
    author_principal_id: 'researcher-http',
    created_at: NOW,
    frozen_at: NOW,
    canonical_hash: HASH_A,
  })
  return { ...record, canonical_hash: protocolRevisionCanonicalHash(record) }
}

const BASIS = {
  provenance: 'explicit' as const,
  statement: 'The HTTP result is directly observed.',
  source_refs: [{ kind: 'evidence' as const, id: 'evidence_http', sha256: HASH_A }],
}

function synthesis(projectId: string, snapshotPin = { project_revision: 1, next_action_revision: 1 }) {
  return ResearchSynthesis.parse({
    synthesis_id: 'synth_http_1', project_id: projectId,
    window: { from_event_seq: 1, to_event_seq: 2 },
    snapshot_pin: snapshotPin,
    inputs: { accepted_evidence_refs: ['evidence_http'], verified_evidence_refs: ['evidence_http'], run_refs: ['run_http'], corpus_snapshot_refs: [] },
    findings: { supported: [BASIS], contradicted: [], negative: [], inconclusive: [], infrastructure_failures: [] },
    patterns: [], open_questions: [], constraints_learned: [],
    artifact_body_ref: 'artifact:synthesis', direction_proposal_id: 'direction_http_1', confidence: 'medium',
    generated_by: 'human', input_hash: HASH_A, status: 'reviewed', adoption_ref: null, created_at: NOW,
  })
}

function direction(
  projectId: string,
  snapshotPin = { project_revision: 1, next_action_revision: 1 },
  kind: 'deepen' | 'broaden' | 'pivot' | 'conclude' | 'pause' = 'deepen',
) {
  return DirectionProposal.parse({
    proposal_id: 'direction_http_1', project_id: projectId, synthesis_id: 'synth_http_1', direction: kind,
    rationale_artifact_id: 'artifact:direction', basis: [BASIS],
    snapshot_pin: snapshotPin, input_hash: HASH_A,
    status: 'proposed', created_at: NOW,
  })
}

function knowledgePackage() {
  return KnowledgePackageRecord.parse({
    manifest: {
      schema_version: 1, name: 'scholar.http-review', version: '1.0.0', channel: 'instruction',
      source: { transport: 'local', origin: 'scholar-native', path: 'skills/http-review', revision: 'a'.repeat(40) },
      payload_sha256: HASH_A,
      license: { status: 'SCHOLAR_OWNED', spdx: 'MIT', evidence_sha256: HASH_A, attribution_refs: [] },
      requested_capabilities: ['project:read-accepted-evidence'],
      input_schema_id: 'scholar.http-review.input.v1', output_schema_id: 'scholar.http-review.output.v1',
      side_effect: 'proposal-only',
    },
    manifest_sha256: HASH_B,
  })
}

function knowledgeEvaluation() {
  return KnowledgePackageEvaluation.parse({
    package_name: 'scholar.http-review', package_version: '1.0.0', manifest_sha256: HASH_B,
    payload_sha256: HASH_A, verdict: 'approved', granted_capabilities: ['project:read-accepted-evidence'],
  })
}

function activation(projectId: string) {
  return KnowledgeActivationRequest.parse({
    project_id: projectId, session_id: 'session_http', package_name: 'scholar.http-review', package_version: '1.0.0',
    manifest_sha256: HASH_B, payload_sha256: HASH_A, phase: 'WRITING', next_action_revision: 1,
    explicit_human_activation: true,
    principal_capabilities: ['project:read-accepted-evidence'],
    next_action_capabilities: ['project:read-accepted-evidence'],
    project_policy_capabilities: ['project:read-accepted-evidence'],
  })
}

function outline(projectId: string, inputPin = {
  project_id: projectId, document_id: 'paper_http', document_revision: 1,
  tex_sha256: HASH_A, claim_evidence_sha256: HASH_A,
}) {
  return ReverseOutline.parse({
    outline_id: 'outline_http_1',
    input_pin: inputPin,
    section_ref: 'section:method', section_thesis: 'The method is auditable.', paragraphs: [], issues: [],
    status: 'diagnostic', created_at: NOW,
  })
}

function finding(projectId: string, inputPin = {
  project_id: projectId, document_id: 'paper_http', document_revision: 1,
  tex_sha256: HASH_A, claim_evidence_sha256: HASH_A,
}) {
  return ReviewFinding.parse({
    finding_id: 'finding_http_1',
    input_pin: inputPin,
    kind: 'flow', severity: 'blocking', message: 'Explain the authority boundary.', evidence_refs: [],
    resolution_status: 'open', status: 'diagnostic', created_at: NOW,
  })
}

describe('v2 methodology HTTP and typed client', () => {
  const kernels: ResearchKernel[] = []
  afterEach(() => { for (const kernel of kernels.splice(0)) kernel.close() })

  it('is fail-closed, exposes all project resources, and derives decision actors from membership', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-methodology-http-'))
    const kernel = new ResearchKernel({ dbPath: join(dir, 'kernel.db'), casRoot: join(dir, 'cas') })
    kernels.push(kernel)
    const project = kernel.createProject({ name: 'methodology-http', workspace: '/work', brief: brief(), creator_principal_id: 'pi-http' })
    const projectId = project.project_id
    kernel.addProjectMember({ project_id: projectId, principal_id: 'researcher-http', role: 'researcher', actor: 'pi-http' })
    kernel.addProjectMember({ project_id: projectId, principal_id: 'viewer-http', role: 'viewer', actor: 'pi-http' })
    const { server, url } = await startKernelServer({ kernel, port: 0 })
    try {
      const client = new ResearchClient({ endpoint: url })
      expect((await fetch(`${url}/v2/projects/${projectId}/methodology`)).status).toBe(422)
      expect((await fetch(`${url}/v2/projects/${projectId}/methodology`, { headers: { 'x-principal-id': 'outsider' } })).status).toBe(404)

      await expect(client.recordProtocol(projectId, 'viewer-http', { record: protocol(projectId), expected_revision: 0 }))
        .rejects.toMatchObject({ status: 403, code: 'role_forbidden' })
      const first = await client.getMethodology(projectId, 'pi-http')
      expect(first).toMatchObject({ project_id: projectId, revision: 0, protocol: null })
      expect(first.next_recommendation).toEqual({ code: 'configure_protocol', label_key: 'methodology.next.configureProtocol' })

      await client.recordProtocol(projectId, 'researcher-http', { record: protocol(projectId), expected_revision: 0 })
      await expect(client.recordProtocol(projectId, 'researcher-http', { record: protocol(projectId, 'protocol_http_stale'), expected_revision: 0 }))
        .rejects.toMatchObject({ status: 409, code: 'methodology_revision_conflict' })
      const signedProtocol = protocol(projectId, 'protocol_http_tampered')
      await expect(client.recordProtocol(projectId, 'researcher-http', {
        record: { ...signedProtocol, prediction: 'Caller changed the prediction after hashing.' },
        expected_revision: 1,
      })).rejects.toMatchObject({ status: 422, code: 'methodology_protocol_hash_mismatch' })
      const strict = await fetch(`${url}/v2/projects/${projectId}/protocols`, {
        method: 'POST', headers: { 'content-type': 'application/json', 'x-principal-id': 'researcher-http' },
        body: JSON.stringify({ record: protocol(projectId, 'protocol_http_extra'), expected_revision: 1, unexpected: true }),
      })
      expect(strict.status).toBe(422)
      expect((await strict.json() as { error: { code: string } }).error.code).toBe('validation_error')

      const currentProject = kernel.getProject(projectId)
      const currentActions = kernel.projectProjection(projectId).next_actions_v2
      const currentSnapshot = {
        project_revision: currentProject.revision,
        next_action_revision: currentActions.find(action => action.state === 'ready')?.revision
          ?? currentActions.find(action => action.state !== 'done')?.revision
          ?? currentProject.revision,
      }
      // Direction HTTP coverage starts from a trusted, already-persisted
      // synthesis fixture. Public synthesis writes are exercised through the
      // real deterministic request lifecycle in run-outcome-lifecycle.test.
      kernel.methodology.recordResearchSynthesis({
        record: synthesis(projectId, currentSnapshot), expected_revision: 1,
      })
      await client.recordDirection(projectId, 'researcher-http', {
        record: direction(projectId, currentSnapshot), expected_revision: 2,
      })
      const adopted = await client.adoptDirection(projectId, 'direction_http_1', 'pi-http', {
        adoption_id: 'adoption_http_1', decision: 'rejected', gate_decision_ref: null, created_at: NOW, expected_revision: 3,
      })
      expect(adopted.record.actor).toEqual({ kind: 'human', ref: 'pi-http' })
      expect((await client.listDirections(projectId, 'pi-http')).adoptions.records).toHaveLength(1)
      const graph = await client.getMethodologyGraph(projectId, 'pi-http')
      expect(graph).toMatchObject({ project_id: projectId })
      expect(graph.edges).toEqual(expect.arrayContaining([
        expect.objectContaining({ from: 'synthesis:synth_http_1', to: 'direction:direction_http_1', kind: 'proposes' }),
        expect.objectContaining({ from: 'direction:direction_http_1', to: 'adoption:adoption_http_1', kind: 'decides' }),
      ]))

      kernel.registerArtifact({ project_id: projectId, kind: 'paper', content: '# Methodology draft' })
      const producedAudit = await client.runWritingAssurance(projectId, 'researcher-http', {
        expected_revision: 0, audit_kind: 'writing', mode: 'deterministic', semantic_review: null,
      })
      await expect(client.acceptAssuranceAudit(projectId, producedAudit.audit.audit_id, 'researcher-http', 1))
        .rejects.toMatchObject({ status: 403, code: 'role_forbidden' })
      expect((await client.acceptAssuranceAudit(projectId, producedAudit.audit.audit_id, 'pi-http', 1)).accepted_by).toBe('pi-http')
      expect(await client.getMethodology(projectId, 'pi-http')).toMatchObject({
        assurance: { level: 'draft', ready: false, reason_codes: ['verdict_blocking'] },
      })
      expect(kernel.methodologyTelemetry.redactedAggregate().counters).toEqual(expect.arrayContaining([
        expect.objectContaining({
          key: 'methodology.synthesis.outcome_total',
          tags: expect.objectContaining({ mode: 'internal-fixture', event: 'freshness' }),
        }),
      ]))

      expect((await client.listKnowledgeActivations(projectId, 'pi-http')).records).toEqual([])
      expect((await client.listWritingReviews(projectId, 'pi-http')).reverse_outlines.records).toEqual([])
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()))
    }
  })

  it('requires durable Operator authority for the global registry and projects activated knowledge and writing state', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-methodology-registry-http-'))
    const kernel = new ResearchKernel({ dbPath: join(dir, 'kernel.db'), casRoot: join(dir, 'cas') })
    kernels.push(kernel)
    const project = kernel.createProject({ name: 'registry-http', workspace: '/work', brief: brief(), creator_principal_id: 'pi-http' })
    const projectId = project.project_id
    kernel.addProjectMember({ project_id: projectId, principal_id: 'operator-http', role: 'operator', actor: 'pi-http' })
    const { server, url } = await startKernelServer({ kernel, port: 0 })
    try {
      const client = new ResearchClient({ endpoint: url })
      await expect(client.listMethodologyPackages('pi-http')).rejects.toBeInstanceOf(KernelApiError)
      const registered = await client.registerMethodologyPackage('operator-http', { record: knowledgePackage(), expected_revision: 0 })
      expect(registered.registry_revision).toBe(1)
      await client.evaluateMethodologyPackage('scholar.http-review', '1.0.0', 'operator-http', {
        record: knowledgeEvaluation(), expected_revision: 1,
      })
      expect((await client.listMethodologyPackages('operator-http')).evaluations.records).toHaveLength(1)

      await client.recordProtocol(projectId, 'pi-http', { record: protocol(projectId), expected_revision: 0 })
      kernel.linkSession('session_http', projectId, {
        principal_id: 'pi-http', tenant_id: '', issuer: 'kernel',
      })
      const activationProject = kernel.getProject(projectId)
      const activationAction = kernel.projectProjection(projectId).next_actions_v2.find(item => item.state === 'ready')
        ?? kernel.projectProjection(projectId).next_actions_v2.find(item => item.state !== 'done')
      await client.activateKnowledgePackage(projectId, 'pi-http', 'session_http', {
        package_name: 'scholar.http-review', package_version: '1.0.0',
        manifest_sha256: HASH_B, payload_sha256: HASH_A, explicit_human_activation: true,
        expected_revision: 1, expected_registry_revision: 2,
        expected_project_revision: activationProject.revision,
        expected_next_action_revision: activationAction?.revision ?? activationProject.revision,
      })
      expect(await client.getKnowledgeDelivery(projectId, 'pi-http', {
        session_id: 'session_http', surface: 'scholar-chat',
      })).toMatchObject({
        deliveries: [],
        suppressed: [{ reason_codes: ['native_pack_missing'] }],
      })
      const document = kernel.texEnsure(projectId)
      kernel.texWriteFile(document.document_id, 'paper.tex', '\\documentclass{article}\n')
      const currentDocument = kernel.tex.getDocument(document.document_id)
      const inputPin = {
        project_id: projectId,
        document_id: document.document_id,
        document_revision: currentDocument.revision,
        tex_sha256: writingTexSha256(kernel.tex.tree(document.document_id).files),
        claim_evidence_sha256: writingClaimEvidenceSha256([]),
      }
      await client.recordReverseOutline(projectId, 'pi-http', { record: outline(projectId, inputPin), expected_revision: 2 })
      await client.recordReviewFinding(projectId, 'pi-http', { record: finding(projectId, inputPin), expected_revision: 3 })

      const projection = await client.getMethodology(projectId, 'pi-http')
      expect(projection).toMatchObject({
        project_id: projectId,
        revision: 4,
        protocol: { current_id: 'protocol_http_1', revision: 1, status: 'frozen', intent: 'confirmatory' },
        knowledge: { active_count: 0, package_names: [], suppressed_count: 1, status: 'suppressed' },
        writing: { outline_id: 'outline_http_1', blocking_count: 1, stale: false, reason_codes: [] },
      })
      kernel.texWriteFile(document.document_id, 'paper.tex', '\\documentclass{article}\n% changed\n', 1)
      expect(await client.getMethodology(projectId, 'pi-http')).toMatchObject({
        writing: {
          outline_id: 'outline_http_1', blocking_count: 0, stale: true,
          reason_codes: expect.arrayContaining(['document_revision_changed', 'tex_hash_changed']),
        },
      })
      const activationReceipt = (await client.listKnowledgeActivations(projectId, 'pi-http')).records[0]!
      await client.deactivateKnowledgePackage(projectId, activationReceipt.record.activation_id, 'pi-http', {
        request: {
          project_id: projectId,
          session_id: 'session_http',
          activation_id: activationReceipt.record.activation_id,
          explicit_human_deactivation: true,
          reason: 'no-longer-needed',
        },
        expected_revision: 4,
      })
      expect((await client.getKnowledgeDelivery(projectId, 'pi-http', {
        session_id: 'session_http', surface: 'scholar-chat',
      })).suppressed[0]?.reason_codes).toEqual(['deactivated'])
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()))
    }
  })

  it('requires the service token, fixed DSH audience, and dedicated plugin credential to reconcile native packs', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-native-reconcile-http-'))
    const kernel = new ResearchKernel({
      dbPath: join(dir, 'kernel.db'),
      casRoot: join(dir, 'cas'),
      serviceToken: 'methodology-service-secret',
      dshPluginToken: 'methodology-dsh-secret',
    })
    kernels.push(kernel)
    const project = kernel.createProject({
      name: 'native-reconcile-http', workspace: '/work', brief: brief(), creator_principal_id: 'pi-http',
    })
    kernel.addProjectMember({
      project_id: project.project_id, principal_id: 'operator-http', role: 'operator', actor: 'pi-http',
    })
    const { server, url } = await startKernelServer({ kernel, port: 0 })
    try {
      const endpoint = `${url}/internal/methodology/native-packs/reconcile`
      const request = (headers: Record<string, string>) => fetch(endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...headers },
        body: '{}',
      })
      const errorCode = async (response: Response): Promise<string> =>
        ((await response.json()) as { error: { code: string } }).error.code

      const missingService = await request({
        'x-service-principal': 'dsh-plugin',
        'x-dsh-plugin-token': 'methodology-dsh-secret',
      })
      expect(missingService.status).toBe(403)
      expect(await errorCode(missingService)).toBe('service_token_required')

      const sharedTokenOnly = await request({
        'x-service-token': 'methodology-service-secret',
        'x-service-principal': 'dsh-plugin',
      })
      expect(sharedTokenOnly.status).toBe(403)
      expect(await errorCode(sharedTokenOnly)).toBe('dsh_plugin_token_required')

      const wrongPluginToken = await request({
        'x-service-token': 'methodology-service-secret',
        'x-service-principal': 'dsh-plugin',
        'x-dsh-plugin-token': 'wrong-dsh-secret',
      })
      expect(wrongPluginToken.status).toBe(403)
      expect(await errorCode(wrongPluginToken)).toBe('dsh_plugin_token_required')

      const wrongAudience = await request({
        'x-service-token': 'methodology-service-secret',
        'x-service-principal': 'research-orchestrator',
        'x-dsh-plugin-token': 'methodology-dsh-secret',
      })
      expect(wrongAudience.status).toBe(403)
      expect(await errorCode(wrongAudience)).toBe('service_identity_required')

      const operator = new ResearchClient({ endpoint: url })
      expect((await operator.listMethodologyPackages('operator-http')).registry_revision).toBe(0)

      const sharedOnlyClient = new ResearchClient({
        endpoint: url,
        serviceToken: 'methodology-service-secret',
      })
      await expect(sharedOnlyClient.reconcileNativeKnowledgePacks()).rejects.toMatchObject({
        status: 403,
        code: 'dsh_plugin_token_required',
      })
      expect((await operator.listMethodologyPackages('operator-http')).registry_revision).toBe(0)

      const plugin = new ResearchClient({
        endpoint: url,
        serviceToken: 'methodology-service-secret',
        dshPluginToken: 'methodology-dsh-secret',
      })
      const reconciled = await plugin.reconcileNativeKnowledgePacks()
      expect(reconciled.package_names).toHaveLength(3)
      expect((await operator.listMethodologyPackages('operator-http')).registry_revision).toBe(reconciled.registry_revision)
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()))
    }
  })

  it('accepts only a same-project Human-approved Direction Gate bound to the exact proposal and synthesis', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-direction-gate-http-'))
    const kernel = new ResearchKernel({ dbPath: join(dir, 'kernel.db'), casRoot: join(dir, 'cas') })
    kernels.push(kernel)
    const project = kernel.createProject({ name: 'direction-gate-http', workspace: '/work', brief: brief(), creator_principal_id: 'pi-http' })
    const projectId = project.project_id
    const snapshot = { project_revision: project.revision, next_action_revision: project.revision }
    kernel.methodology.recordResearchSynthesis({ record: synthesis(projectId, snapshot), expected_revision: 0 })
    kernel.methodology.recordDirectionProposal({ record: direction(projectId, snapshot, 'pivot'), expected_revision: 1 })
    // A wrong-type approved receipt is still needed for the adoption
    // negative case. Use an already-satisfied Scope Gate; Budget Gates are
    // now valid only when created with durable budget-block provenance.
    kernel.db.prepare("UPDATE projects SET status = 'SCOPED' WHERE project_id = ?").run(projectId)
    const wrongGate = kernel.createGate({
      project_id: projectId,
      type: 'scope',
      title: 'Wrong gate type',
      payload: {
        purpose: 'direction_adoption', proposal_id: 'direction_http_1',
        source_synthesis_id: 'synth_http_1', direction: 'pivot',
      },
    })
    const wrongDecision = kernel.decideGate({
      gate_id: wrongGate.gate_id,
      actor: 'pi-http',
      principal: { principal_id: 'pi-http', auth_method: 'dsh-session' },
      decision: 'approved',
    }).decision
    const directionPayload = {
      purpose: 'direction_adoption' as const,
      proposal_id: 'direction_http_1',
      source_synthesis_id: 'synth_http_1',
      direction: 'pivot' as const,
    }
    const approveDirectionGate = (
      title: string,
      payload: typeof directionPayload,
      principal: { principal_id: string; auth_method: string } = { principal_id: 'pi-http', auth_method: 'dsh-session' },
    ) => {
      const gate = kernel.createGate({ project_id: projectId, type: 'direction', title, payload })
      const decision = kernel.decideGate({ gate_id: gate.gate_id, actor: principal.principal_id, principal, decision: 'approved' }).decision
      return { gate, decision }
    }
    const unbound = approveDirectionGate('Unbound after approval', directionPayload)
    kernel.db.prepare('UPDATE gates SET payload = ? WHERE gate_id = ?').run('{}', unbound.gate.gate_id)
    const wrongProposal = approveDirectionGate('Wrong proposal', { ...directionPayload, proposal_id: 'direction_other' })
    const wrongSynthesis = approveDirectionGate('Wrong synthesis', { ...directionPayload, source_synthesis_id: 'synth_other' })
    const nonHuman = approveDirectionGate('Agent decision', directionPayload, { principal_id: 'pi-http', auth_method: 'agent' })
    const rejectedGate = kernel.createGate({ project_id: projectId, type: 'direction', title: 'Rejected', payload: directionPayload })
    const rejected = kernel.decideGate({
      gate_id: rejectedGate.gate_id, actor: 'pi-http',
      principal: { principal_id: 'pi-http', auth_method: 'dsh-session' }, decision: 'rejected', reason: 'not yet',
    }).decision
    const foreignProject = kernel.createProject({ name: 'foreign-direction-gate', workspace: '/foreign', brief: brief(), creator_principal_id: 'pi-foreign' })
    const foreignGate = kernel.createGate({ project_id: foreignProject.project_id, type: 'direction', title: 'Foreign', payload: directionPayload })
    const foreign = kernel.decideGate({
      gate_id: foreignGate.gate_id, actor: 'pi-foreign',
      principal: { principal_id: 'pi-foreign', auth_method: 'dsh-session' }, decision: 'approved',
    }).decision
    const correct = approveDirectionGate('Exact binding', directionPayload)
    const { server, url } = await startKernelServer({ kernel, port: 0 })
    try {
      const client = new ResearchClient({ endpoint: url })
      for (const [name, decisionRef] of [
        ['wrong_gate', wrongDecision.decision_id],
        ['unbound', unbound.decision.decision_id],
        ['wrong_proposal', wrongProposal.decision.decision_id],
        ['wrong_synthesis', wrongSynthesis.decision.decision_id],
        ['non_human', nonHuman.decision.decision_id],
        ['foreign', foreign.decision_id],
        ['rejected', rejected.decision_id],
      ] as const) {
        await expect(client.adoptDirection(projectId, 'direction_http_1', 'pi-http', {
          adoption_id: `adoption_${name}`, decision: 'adopted',
          gate_decision_ref: decisionRef, created_at: NOW, expected_revision: 2,
        }), name).rejects.toMatchObject({ status: 422 })
        expect((await client.listDirections(projectId, 'pi-http')).adoptions.records, `${name} must be zero-write`).toEqual([])
      }

      const adopted = await client.adoptDirection(projectId, 'direction_http_1', 'pi-http', {
        adoption_id: 'adoption_exact_binding', decision: 'adopted',
        gate_decision_ref: correct.decision.decision_id, created_at: NOW, expected_revision: 2,
      })
      expect(adopted.record).toMatchObject({
        proposal_id: 'direction_http_1', decision: 'adopted',
        gate_decision_ref: correct.decision.decision_id,
      })
      expect(kernel.projectProjection(projectId).next_actions_v2).toContainEqual(expect.objectContaining({
        code: 'direction_pivot_intake', state: 'ready', required_by: 'human', route: 'overview',
      }))
      expect((await client.getMethodology(projectId, 'pi-http')).next_recommendation).toEqual({
        code: 'direction_pivot_intake', label_key: 'methodology.next.directionPivotIntake',
      })
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()))
    }
  })
})
