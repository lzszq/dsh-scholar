/**
 * Governance unit tests (hardening GOV-01, EVID-01): durable decision
 * principal, worker-only verified evidence, claim verification provenance.
 */
import { describe, expect, it } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ResearchKernel, KernelError } from '@dsh-scholar/research-kernel'
import { startKernelServer } from '../../packages/research-kernel/lib/server.js'

function freshKernel(options: { serviceToken?: string } = {}): ResearchKernel {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-gov-test-'))
  return new ResearchKernel({ dbPath: join(dir, 'kernel.db'), casRoot: join(dir, 'cas'), requireSignedManifest: false, serviceToken: options.serviceToken })
}

function makeBrief() {
  return {
    problem: 'p', scope: 's', questions: [], primary_metrics: ['m'],
    resources: '', risks: [], target_outputs: ['paper'], target_venue: null,
    baseline_repo: null, domain: 'ml',
  }
}

describe('governance: durable human principal (GOV-01)', () => {
  it('persists and re-reads the decision principal', () => {
    const kernel = freshKernel()
    const project = kernel.createProject({ name: 't', workspace: '/w', brief: makeBrief() })
    const gate = kernel.createGate({ project_id: project.project_id, type: 'scope', title: 'Scope' })
    kernel.decideGate({
      gate_id: gate.gate_id,
      actor: 'web-user',
      principal: { principal_id: 'ops-42', tenant_id: 'acme', auth_method: 'dsh-session', session_id: 'sess-7' },
      decision: 'approved',
      reason: 'scope acceptable',
    })
    const decisions = kernel.listDecisions(project.project_id)
    expect(decisions).toHaveLength(1)
    expect(decisions[0]!.principal?.principal_id).toBe('ops-42')
    expect(decisions[0]!.principal?.tenant_id).toBe('acme')
    expect(decisions[0]!.principal?.auth_method).toBe('dsh-session')
    expect(decisions[0]!.principal?.session_id).toBe('sess-7')
    // A fresh kernel over the same DB still sees the principal.
    kernel.close()
  })

  it('marks legacy decisions without a principal', () => {
    const kernel = freshKernel()
    const project = kernel.createProject({ name: 't', workspace: '/w', brief: makeBrief() })
    const gate = kernel.createGate({ project_id: project.project_id, type: 'scope', title: 'Scope' })
    kernel.decideGate({ gate_id: gate.gate_id, actor: 'legacy_unverified', decision: 'approved' })
    const decisions = kernel.listDecisions(project.project_id)
    expect(decisions[0]!.principal).toBeUndefined()
    kernel.close()
  })
})

describe('governance: gate target freeze (GOV-02)', () => {
  it('contract gate approval freezes the target contract atomically', () => {
    const kernel = freshKernel()
    const project = kernel.createProject({ name: 't', workspace: '/w', brief: makeBrief() })
    const gate = kernel.createGate({ project_id: project.project_id, type: 'scope', title: 'Scope' })
    kernel.decideGate({ gate_id: gate.gate_id, actor: 'web-user', principal: { principal_id: 'u1' }, decision: 'approved' })
    expect(kernel.getProject(project.project_id).status).toBe('SCOPED')
    // Walk to IDEA_APPROVED (contract gate's from-state) via the public
    // transition table + an idea gate.
    kernel.transition(project.project_id, 'SURVEYING', kernel.getProject(project.project_id).revision)
    kernel.transition(project.project_id, 'IDEATING', kernel.getProject(project.project_id).revision)
    const ideaGate = kernel.createGate({ project_id: project.project_id, type: 'idea', title: 'Idea Gate', payload: { idea_id: 'idea_x' } })
    kernel.decideGate({ gate_id: ideaGate.gate_id, actor: 'web-user', principal: { principal_id: 'u1' }, decision: 'approved' })
    expect(kernel.getProject(project.project_id).status).toBe('IDEA_APPROVED')
    // IDEA_APPROVED -> CONTRACT_PENDING (the contract gate's from-state).
    kernel.transition(project.project_id, 'CONTRACT_PENDING', kernel.getProject(project.project_id).revision)
    // A contract + its gate; approval must freeze the contract in the SAME
    // transaction as the decision.
    const contract = kernel.registerContract({
      project_id: project.project_id,
      idea_id: 'idea_x', data: { dataset_id: 'd', version: 'v1' }, methods: { baseline: 'b', treatment: 'a' },
      metrics: { primary: 'macro_f1', secondary: [] }, seeds: [1, 2], analysis: {},
      ablations: [], stop_conditions: { max_gpu_hours: 1, min_completed_seeds: 1, stop_on_data_leakage: true },
    })
    const cGate = kernel.createGate({ project_id: project.project_id, type: 'contract', title: 'Contract Gate', payload: { contract_id: contract.contract_id } })
    const decided = kernel.decideGate({ gate_id: cGate.gate_id, actor: 'web-user', principal: { principal_id: 'u1' }, decision: 'approved', diff: 'v1' })
    const frozen = kernel.getContract(contract.contract_id)
    expect(frozen.status).toBe('approved')
    expect(frozen.approval?.gate_decision_id).toBe(decided.decision.decision_id)
    expect(frozen.approval?.approved_by).toBe('web-user')
    // The project moved to the contract-approved state in the same txn.
    expect(kernel.getProject(project.project_id).status).toBe('CONTRACT_APPROVED')
    kernel.close()
  })
})

describe('governance: gate type flows & gate-controlled states (acceptance-tests.md §2)', () => {
  it('all five gate types have independent flows with their approval mapping', () => {
    const kernel = freshKernel()
    const project = kernel.createProject({ name: 't', workspace: '/w', brief: makeBrief() })
    // scope: DRAFT -> SCOPED
    const scope = kernel.createGate({ project_id: project.project_id, type: 'scope', title: 'Scope' })
    kernel.decideGate({ gate_id: scope.gate_id, actor: 'u1', principal: { principal_id: 'u1' }, decision: 'approved' })
    expect(kernel.getProject(project.project_id).status).toBe('SCOPED')
    // idea: IDEATING -> IDEA_APPROVED
    kernel.transition(project.project_id, 'SURVEYING', kernel.getProject(project.project_id).revision)
    kernel.transition(project.project_id, 'IDEATING', kernel.getProject(project.project_id).revision)
    const idea = kernel.createGate({ project_id: project.project_id, type: 'idea', title: 'Idea' })
    kernel.decideGate({ gate_id: idea.gate_id, actor: 'u1', principal: { principal_id: 'u1' }, decision: 'approved' })
    expect(kernel.getProject(project.project_id).status).toBe('IDEA_APPROVED')
    // contract: CONTRACT_PENDING -> CONTRACT_APPROVED (freezes the contract)
    kernel.transition(project.project_id, 'CONTRACT_PENDING', kernel.getProject(project.project_id).revision)
    const contract = kernel.registerContract({
      project_id: project.project_id,
      idea_id: 'idea_x', data: { dataset_id: 'd' }, methods: { baseline: 'b', treatment: 'a' },
      metrics: { primary: 'macro_f1' }, seeds: [1], analysis: {}, ablations: [], stop_conditions: {},
    })
    const contractGate = kernel.createGate({ project_id: project.project_id, type: 'contract', title: 'Contract', payload: { contract_id: contract.contract_id } })
    kernel.decideGate({ gate_id: contractGate.gate_id, actor: 'u1', principal: { principal_id: 'u1' }, decision: 'approved' })
    expect(kernel.getProject(project.project_id).status).toBe('CONTRACT_APPROVED')
    expect(kernel.getContract(contract.contract_id).status).toBe('approved')
    // release: RELEASE_READY -> RELEASED (the mapping exists and migrates)
    for (const to of ['BASELINE_REPRO', 'EXPERIMENTING', 'EVIDENCE_READY', 'WRITING', 'REVIEWING', 'RELEASE_READY'] as const) {
      kernel.transition(project.project_id, to, kernel.getProject(project.project_id).revision)
    }
    expect(kernel.getProject(project.project_id).status).toBe('RELEASE_READY')
    const release = kernel.createGate({ project_id: project.project_id, type: 'release', title: 'Release' })
    kernel.decideGate({ gate_id: release.gate_id, actor: 'u1', principal: { principal_id: 'u1' }, decision: 'approved' })
    expect(kernel.getProject(project.project_id).status).toBe('RELEASED')
    // budget: policy-created, payload-declared resume (budget-gate.test.ts
    // covers the full resume semantics) — assert its own flow here: a budget
    // gate cannot approve from an arbitrary state.
    const gates = kernel.listGates(project.project_id)
    expect(gates.map(g => g.type)).toEqual(['scope', 'idea', 'contract', 'release'])
    expect(gates.every(g => g.status === 'approved')).toBe(true)
    kernel.close()
  })

  it('the four gate-controlled states reject generic transitions with 422', () => {
    const kernel = freshKernel()
    const project = kernel.createProject({ name: 't', workspace: '/w', brief: makeBrief() })
    const attempt = (to: string): void => {
      try {
        kernel.transition(project.project_id, to as never, kernel.getProject(project.project_id).revision)
        throw new Error(`expected 422 for generic transition to ${to}`)
      } catch (error) {
        expect(error).toBeInstanceOf(KernelError)
        expect((error as KernelError).status).toBe(422)
        expect((error as KernelError).code).toBe('invalid_transition')
      }
    }
    // DRAFT -> SCOPED: not in TRANSITION_TABLE (gate-controlled).
    attempt('SCOPED')
    // Walk to IDEATING; IDEATING -> IDEA_APPROVED: gate-controlled.
    const scope = kernel.createGate({ project_id: project.project_id, type: 'scope', title: 'Scope' })
    kernel.decideGate({ gate_id: scope.gate_id, actor: 'u1', principal: { principal_id: 'u1' }, decision: 'approved' })
    kernel.transition(project.project_id, 'SURVEYING', kernel.getProject(project.project_id).revision)
    kernel.transition(project.project_id, 'IDEATING', kernel.getProject(project.project_id).revision)
    attempt('IDEA_APPROVED')
    // IDEA_APPROVED -> CONTRACT_PENDING, then CONTRACT_APPROVED remains gate-controlled.
    const idea = kernel.createGate({ project_id: project.project_id, type: 'idea', title: 'Idea' })
    kernel.decideGate({ gate_id: idea.gate_id, actor: 'u1', principal: { principal_id: 'u1' }, decision: 'approved' })
    kernel.transition(project.project_id, 'CONTRACT_PENDING', kernel.getProject(project.project_id).revision)
    attempt('CONTRACT_APPROVED')
    const contract = kernel.registerContract({
      project_id: project.project_id,
      idea_id: 'idea_x', data: { dataset_id: 'd' }, methods: { baseline: 'b', treatment: 'a' },
      metrics: { primary: 'macro_f1' }, seeds: [1], analysis: {}, ablations: [], stop_conditions: {},
    })
    const contractGate = kernel.createGate({
      project_id: project.project_id, type: 'contract', title: 'Contract', payload: { contract_id: contract.contract_id },
    })
    kernel.decideGate({ gate_id: contractGate.gate_id, actor: 'u1', principal: { principal_id: 'u1' }, decision: 'approved' })
    kernel.transition(project.project_id, 'BASELINE_REPRO', kernel.getProject(project.project_id).revision)
    // Walk to RELEASE_READY; RELEASE_READY -> RELEASED: gate-controlled.
    for (const to of ['EXPERIMENTING', 'EVIDENCE_READY', 'WRITING', 'REVIEWING', 'RELEASE_READY'] as const) {
      kernel.transition(project.project_id, to, kernel.getProject(project.project_id).revision)
    }
    attempt('RELEASED')
    // The gates remain the ONLY path into those states: a pending release
    // gate at RELEASE_READY approves into RELEASED (no generic transition).
    const release = kernel.createGate({ project_id: project.project_id, type: 'release', title: 'Release' })
    kernel.decideGate({ gate_id: release.gate_id, actor: 'u1', principal: { principal_id: 'u1' }, decision: 'approved' })
    expect(kernel.getProject(project.project_id).status).toBe('RELEASED')
    kernel.close()
  })
})

describe('governance: concurrent decision (acceptance-tests.md §2)', () => {
  it('two parallel decisions on one gate: exactly one succeeds, the other 409', async () => {
    const kernel = freshKernel({ serviceToken: 'human-bff-secret' })
    const project = kernel.createProject({ name: 't', workspace: '/w', brief: makeBrief() })
    const gate = kernel.createGate({ project_id: project.project_id, type: 'scope', title: 'Scope' })
    const { server, port } = await startKernelServer({ kernel, port: 0 })
    try {
      const url = `http://127.0.0.1:${port}/internal/human-gates/${gate.gate_id}/decisions`
      const body = JSON.stringify({ actor: 'human-a', principal: { principal_id: 'p-a' }, decision: 'approved' })
      const headers = {
        'content-type': 'application/json',
        'x-service-token': 'human-bff-secret',
        'x-service-principal': 'standalone-human-bff',
      }
      const [r1, r2] = await Promise.all([
        fetch(url, { method: 'POST', headers, body }),
        fetch(url, { method: 'POST', headers, body }),
      ])
      const statuses = [r1.status, r2.status].sort((a, b) => a - b)
      expect(statuses).toEqual([200, 409])
      const loser = r1.status === 409 ? r1 : r2
      const envelope = await loser.json() as { error?: { code?: string } }
      expect(envelope.error?.code).toBe('gate_already_decided')
      const decisions = kernel.listDecisions(project.project_id)
      expect(decisions).toHaveLength(1)
      expect(decisions[0]!.principal?.principal_id).toBe('p-a')
      expect(kernel.getGate(gate.gate_id).status).toBe('approved')
    } finally {
      server.close()
      kernel.close()
    }
  })
})

describe('governance: evidence provenance (EVID-01)', () => {
  it('claim verification ignores draft/legacy/verified evidence and needs accepted rows (§6)', () => {
    const kernel = freshKernel()
    const project = kernel.createProject({ name: 't', workspace: '/w', brief: makeBrief() })
    const artifact = kernel.registerArtifact({ project_id: project.project_id, kind: 'analysis', content: JSON.stringify({ f1: 0.9 }) })
    // Draft (public) evidence: must NOT support a claim.
    const draft = kernel.ingestEvidence({
      project_id: project.project_id, source_type: 'analysis', run_ids: [],
      artifact_refs: [artifact.artifact_id], analysis_method: 'bootstrap_95',
      result: { primary_metric: 'f1', value: 0.9, effect_size: 0.3, ci_low: 0.1, ci_high: 0.5, n_seeds: 3 },
      provenance_status: 'draft_unverified',
    })
    const claim = kernel.createClaim({
      project_id: project.project_id,
      statement: 'A improves f1',
      scope: { dataset: 'd', split: 'official' },
    })
    const verdictDraft = kernel.verifyClaim({ claim_id: claim.claim_id, evidence_ids: [draft.evidence_id] })
    expect(verdictDraft.status).toBe('inconclusive')
    // Worker-verified evidence alone (no Verifier/Auditor accept): STILL
    // inconclusive — only accepted evidence may support a Claim (§6).
    const verified = kernel.ingestVerifiedEvidence({
      project_id: project.project_id, source_type: 'analysis', run_ids: [],
      artifact_refs: [artifact.artifact_id], analysis_method: 'bootstrap_95',
      result: { primary_metric: 'f1', value: 0.9, effect_size: 0.3, ci_low: 0.1, ci_high: 0.5, n_seeds: 3 },
    })
    const verdictVerified = kernel.verifyClaim({ claim_id: claim.claim_id, evidence_ids: [verified.evidence_id] })
    expect(verdictVerified.status).toBe('inconclusive')
    // After the Verifier/Auditor accept transition the claim is supported.
    const accepted = kernel.acceptEvidence({
      project_id: project.project_id, evidence_id: verified.evidence_id, service_principal: 'auditor', request_id: 'req_gov_1',
    })
    expect(accepted.provenance_status).toBe('accepted')
    const verdictAccepted = kernel.verifyClaim({ claim_id: claim.claim_id, evidence_ids: [verified.evidence_id] })
    expect(verdictAccepted.status).toBe('supported')
    kernel.close()
  })

  it('public HTTP route rejects verified/accepted; the worker route needs the analysis-worker service identity', async () => {
    const serviceToken = 'governance-worker-service-token'
    const kernel = freshKernel({ serviceToken })
    const project = kernel.createProject({ name: 't', workspace: '/w', brief: makeBrief() })
    const artifact = kernel.registerArtifact({ project_id: project.project_id, kind: 'analysis', content: JSON.stringify({ f1: 0.9 }) })
    const { server, port } = await startKernelServer({ kernel, port: 0 })
    try {
      const body = {
        source_type: 'analysis', run_ids: [],
        artifact_refs: [artifact.artifact_id],
        analysis_method: 'bootstrap_95',
        result: { primary_metric: 'f1', value: 0.9, effect_size: 0.3, ci_low: 0.1, ci_high: 0.5, n_seeds: 3 },
      }
      // Forged provenance_status=verified on the public route -> 422.
      const publicVerified = await fetch(`http://127.0.0.1:${port}/v1/projects/${project.project_id}/evidence`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...body, provenance_status: 'verified' }),
      })
      expect(publicVerified.status).toBe(422)
      // Forged provenance_status=accepted on the public route -> 422.
      const publicAccepted = await fetch(`http://127.0.0.1:${port}/v1/projects/${project.project_id}/evidence`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...body, provenance_status: 'accepted' }),
      })
      expect(publicAccepted.status).toBe(422)
      // The worker route WITHOUT the service identity -> 403 (public cannot masquerade).
      const noIdentity = await fetch(`http://127.0.0.1:${port}/v1/projects/${project.project_id}/evidence/verified`, {
        method: 'POST', headers: { 'content-type': 'application/json', 'x-service-token': serviceToken }, body: JSON.stringify(body),
      })
      expect(noIdentity.status).toBe(403)
      const noIdentityBody = await noIdentity.json() as { error?: { code?: string } }
      expect(noIdentityBody.error?.code).toBe('service_identity_required')
      // With x-service-principal: analysis-worker -> 201 verified.
      const workerRes = await fetch(`http://127.0.0.1:${port}/v1/projects/${project.project_id}/evidence/verified`, {
        method: 'POST', headers: { 'content-type': 'application/json', 'x-service-token': serviceToken, 'x-service-principal': 'analysis-worker' },
        body: JSON.stringify(body),
      })
      expect(workerRes.status).toBe(201)
      const item = await workerRes.json() as { provenance_status?: string; evidence_id?: string }
      expect(item.provenance_status).toBe('verified')
      // Accept without a service identity -> 403; with verifier -> 200 accepted.
      const acceptNoIdentity = await fetch(`http://127.0.0.1:${port}/v1/projects/${project.project_id}/evidence/${item.evidence_id}/accept`, {
        method: 'POST', headers: { 'content-type': 'application/json', 'x-service-token': serviceToken }, body: JSON.stringify({ request_id: 'req_gov_2' }),
      })
      expect(acceptNoIdentity.status).toBe(403)
      const acceptRes = await fetch(`http://127.0.0.1:${port}/v1/projects/${project.project_id}/evidence/${item.evidence_id}/accept`, {
        method: 'POST', headers: { 'content-type': 'application/json', 'x-service-token': serviceToken, 'x-service-principal': 'verifier' },
        body: JSON.stringify({ request_id: 'req_gov_2' }),
      })
      expect(acceptRes.status).toBe(200)
      const accepted = await acceptRes.json() as { provenance_status?: string; acceptance?: { request_id?: string } }
      expect(accepted.provenance_status).toBe('accepted')
      expect(accepted.acceptance?.request_id).toBe('req_gov_2')
    } finally {
      server.close()
      kernel.close()
    }
  })
})
