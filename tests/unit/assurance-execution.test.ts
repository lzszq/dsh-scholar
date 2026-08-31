import { mkdtempSync, rmSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ResearchKernel, type AssuranceAuditView } from '@dsh-scholar/research-kernel'
import { AssuranceSemanticReviewReceipt } from '@dsh-scholar/research-schemas'
import { writingClaimEvidenceSha256 } from '../../packages/research-kernel/src/writing-methodology.js'

interface AssuranceExecutionKernel {
  runWritingAssurance(input: {
    project_id: string
    expected_revision: number
    audit_kind: 'writing' | 'claim-evidence'
    mode: 'deterministic'
    semantic_review: null
  }): AssuranceAuditView
}

const roots: string[] = []

function freshKernel(): ResearchKernel {
  const root = mkdtempSync(join(tmpdir(), 'dsh-assurance-execution-'))
  roots.push(root)
  return new ResearchKernel({
    dbPath: join(root, 'kernel.db'),
    casRoot: join(root, 'cas'),
    requireSignedManifest: false,
  })
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('writing assurance execution', () => {
  it('records deterministic revision/hash-bound findings without mutating project, TeX, Gate, or Release state', () => {
    const kernel = freshKernel()
    try {
      const project = kernel.createProject({
        name: 'assurance producer',
        workspace: '/work',
        creator_principal_id: 'pi-assurance',
        brief: {
          problem: 'Check the current manuscript.',
          scope: 'One draft.',
          questions: [],
          primary_metrics: [],
          resources: '',
          risks: [],
          target_outputs: ['paper'],
          target_venue: null,
          baseline_repo: null,
          domain: 'writing',
        },
      })
      const paper = kernel.registerArtifact({
        project_id: project.project_id,
        kind: 'paper',
        content: '# Draft\n\nA claim without evidence.',
        media_type: 'text/markdown',
        file_name: 'paper.md',
      })
      const before = {
        project: kernel.getProject(project.project_id),
        artifacts: kernel.listArtifacts(project.project_id),
        gates: kernel.listGates(project.project_id),
      }

      const result = (kernel as ResearchKernel & AssuranceExecutionKernel).runWritingAssurance({
        project_id: project.project_id,
        expected_revision: 0,
        audit_kind: 'writing',
        mode: 'deterministic',
        semantic_review: null,
      })

      expect(result).toMatchObject({
        project_id: project.project_id,
        revision: 1,
        recorded_revision: 1,
        acceptance_revision: null,
        audit: {
          project_id: project.project_id,
          audit_kind: 'writing',
          assurance_level: 'draft',
          target_refs: [{ kind: 'artifact', id: paper.artifact_id, revision: project.revision }],
          input_pins: [{ ref: `artifact:${paper.artifact_id}`, sha256: `sha256:${paper.sha256}` }],
          execution: { status: 'succeeded' },
          verdict: 'FAIL',
          reason_code: 'deterministic_checks_failed',
          review: { method: 'deterministic', independence: 'deterministic' },
          acceptance_status: 'pending',
        },
      })
      const findings = kernel.getArtifact(project.project_id, result.audit.findings_artifact_id)
      expect(findings).toMatchObject({
        kind: 'analysis',
        media_type: 'application/json',
        metadata: {
          kind: 'assurance-findings',
          audit_kind: 'writing',
          target_artifact_id: paper.artifact_id,
          target_project_revision: project.revision,
        },
      })
      expect(JSON.parse(kernel.cas.read(findings.sha256).toString('utf8'))).toMatchObject({
        schema_version: 1,
        audit_id: result.audit.audit_id,
        project_id: project.project_id,
        project_revision: project.revision,
        target: { artifact_id: paper.artifact_id, sha256: `sha256:${paper.sha256}` },
        deterministic: { producer: 'kernel:manuscript-review-v1', checks: expect.any(Array) },
        semantic_review: null,
      })
      expect(kernel.assurance.list(project.project_id).audits).toEqual([result])
      expect(kernel.rollout.consumptionPin(project.project_id, 'assurance-execution', result.audit.audit_id)).toMatchObject({
        project_id: project.project_id,
        subject_kind: 'assurance-execution',
        subject_id: result.audit.audit_id,
        policy_revision: 1,
        mode: 'internal-fixture',
      })
      expect(kernel.methodologyTelemetry.redactedAggregate().counters).toEqual(expect.arrayContaining([
        expect.objectContaining({
          key: 'methodology.assurance.execution_total',
          tags: expect.objectContaining({ mode: 'internal-fixture', audit_kind: 'writing', execution_status: 'succeeded', verdict: 'FAIL' }),
          value: 1,
        }),
      ]))

      expect(kernel.getProject(project.project_id)).toEqual(before.project)
      expect(kernel.listGates(project.project_id)).toEqual(before.gates)
      expect(kernel.listArtifacts(project.project_id).filter(item => item.kind === 'paper')).toEqual([paper])
      expect(kernel.listArtifacts(project.project_id).filter(item => item.kind === 'bundle')).toEqual([])
      expect(kernel.listArtifacts(project.project_id)).toHaveLength(before.artifacts.length + 1)
    } finally {
      kernel.close()
    }
  })

  it('returns provider-unavailable as an execution diagnostic with zero authority writes', () => {
    const kernel = freshKernel()
    try {
      const project = kernel.createProject({
        name: 'semantic assurance missing',
        workspace: '/work',
        creator_principal_id: 'pi-assurance',
        brief: {
          problem: 'Review a draft.', scope: 'One draft.', questions: [], primary_metrics: [],
          resources: '', risks: [], target_outputs: ['paper'], target_venue: null,
          baseline_repo: null, domain: 'writing',
        },
      })
      kernel.db.prepare("UPDATE projects SET status = 'WRITING', revision = 4 WHERE project_id = ?").run(project.project_id)
      kernel.registerArtifact({ project_id: project.project_id, kind: 'paper', content: '# Draft' })
      kernel.linkSession('session_semantic', project.project_id, {
        principal_id: 'pi-assurance', tenant_id: '', issuer: 'kernel',
      })
      const action = kernel.projectProjection(project.project_id).next_actions_v2[0]!
      const receipt = AssuranceSemanticReviewReceipt.parse({
        panel_id: 'panel_missing_provider',
        project_id: project.project_id,
        session_id: 'session_semantic',
        project_revision: 4,
        action_id: action.id,
        action_revision: action.revision,
        panel_hash: `sha256:${'a'.repeat(64)}`,
        input_hash: `sha256:${'b'.repeat(64)}`,
        state: 'missing',
        reviewers: [],
        failures: ['semantic_reviewer_unavailable'],
        independence: 'same-family',
      })

      const artifactsBefore = kernel.listArtifacts(project.project_id)
      const rolloutBefore = (kernel.db.prepare(
        'SELECT COUNT(*) AS n FROM methodology_project_rollout_events WHERE project_id = ?',
      ).get(project.project_id) as { n: number }).n
      expect(() => kernel.runWritingAssurance({
        project_id: project.project_id,
        expected_revision: 0,
        audit_kind: 'writing',
        mode: 'semantic',
        semantic_review: receipt,
      })).toThrow('semantic reviewer provider is unavailable; no Assurance record was written')

      expect(kernel.assurance.list(project.project_id)).toMatchObject({ revision: 0, audits: [] })
      expect(kernel.listArtifacts(project.project_id)).toEqual(artifactsBefore)
      expect((kernel.db.prepare(
        'SELECT COUNT(*) AS n FROM methodology_rollout_consumptions WHERE project_id = ?',
      ).get(project.project_id) as { n: number }).n).toBe(0)
      expect((kernel.db.prepare(
        'SELECT COUNT(*) AS n FROM methodology_project_rollout_events WHERE project_id = ?',
      ).get(project.project_id) as { n: number }).n).toBe(rolloutBefore)
      expect(kernel.methodologyTelemetry.redactedAggregate().counters).not.toEqual(expect.arrayContaining([
        expect.objectContaining({ key: 'methodology.reviewer.state_total', tags: { mode: 'internal-fixture', state: 'missing' } }),
      ]))
    } finally {
      kernel.close()
    }
  })

  it('requires every semantic finding to resolve to a succeeded reviewer child of the exact linked session', () => {
    const kernel = freshKernel()
    try {
      const project = kernel.createProject({
        name: 'semantic topology',
        workspace: '/work',
        creator_principal_id: 'pi-assurance',
        brief: {
          problem: 'Review a draft.', scope: 'One draft.', questions: [], primary_metrics: [],
          resources: '', risks: [], target_outputs: ['paper'], target_venue: null,
          baseline_repo: null, domain: 'writing',
        },
      })
      kernel.db.prepare("UPDATE projects SET status = 'WRITING', revision = 2 WHERE project_id = ?").run(project.project_id)
      kernel.registerArtifact({ project_id: project.project_id, kind: 'paper', content: '# Draft' })
      kernel.linkSession('session_semantic', project.project_id, {
        principal_id: 'pi-assurance', tenant_id: '', issuer: 'kernel',
      })
      kernel.registerChildLink({
        project_id: project.project_id,
        child_id: 'child_wrong_role',
        parent_id: 'session_semantic',
        mode: 'one-shot',
        role: 'writer',
        state: 'succeeded',
      })
      const action = kernel.projectProjection(project.project_id).next_actions_v2[0]!
      const receipt = AssuranceSemanticReviewReceipt.parse({
        panel_id: 'panel_invalid_topology',
        project_id: project.project_id,
        session_id: 'session_semantic',
        project_revision: 2,
        action_id: action.id,
        action_revision: action.revision,
        panel_hash: `sha256:${'a'.repeat(64)}`,
        input_hash: `sha256:${'b'.repeat(64)}`,
        state: 'partial',
        reviewers: [{
          reviewer_role: 'claim-evidence',
          child_id: 'child_wrong_role',
          summary: 'finding', notes: [], references: [],
          output_hash: `sha256:${'c'.repeat(64)}`,
        }],
        failures: ['remaining reviewer roles unavailable'],
        independence: 'same-family',
      })

      expect(() => kernel.runWritingAssurance({
        project_id: project.project_id,
        expected_revision: 0,
        audit_kind: 'writing',
        mode: 'semantic',
        semantic_review: receipt,
      })).toThrow('not a succeeded read-only reviewer child')
      expect(kernel.assurance.list(project.project_id)).toMatchObject({ revision: 0, audits: [] })
      expect(kernel.listArtifacts(project.project_id).filter(item => item.kind === 'analysis')).toEqual([])
    } finally {
      kernel.close()
    }
  })

  it('rejects a semantic reviewer without a durable provider/model identity', () => {
    const kernel = freshKernel()
    try {
      const project = kernel.createProject({
        name: 'semantic identity', workspace: '/work', creator_principal_id: 'pi-assurance',
        brief: {
          problem: 'Review a draft.', scope: 'One draft.', questions: [], primary_metrics: [], resources: '',
          risks: [], target_outputs: ['paper'], target_venue: null, baseline_repo: null, domain: 'writing',
        },
      })
      kernel.db.prepare("UPDATE projects SET status = 'WRITING', revision = 3 WHERE project_id = ?").run(project.project_id)
      kernel.registerArtifact({ project_id: project.project_id, kind: 'paper', content: '# Draft' })
      kernel.linkSession('session_semantic', project.project_id, {
        principal_id: 'pi-assurance', tenant_id: '', issuer: 'kernel',
      })
      kernel.registerChildLink({
        project_id: project.project_id, child_id: 'child_identity_missing', parent_id: 'session_semantic',
        mode: 'one-shot', role: 'reviewer', state: 'succeeded',
      })
      const action = kernel.projectProjection(project.project_id).next_actions_v2[0]!
      const receipt = AssuranceSemanticReviewReceipt.parse({
        panel_id: 'panel_identity_missing', project_id: project.project_id, session_id: 'session_semantic',
        project_revision: 3, action_id: action.id, action_revision: action.revision,
        panel_hash: `sha256:${'a'.repeat(64)}`, input_hash: `sha256:${'b'.repeat(64)}`,
        state: 'partial',
        reviewers: [{
          reviewer_role: 'claim-evidence', child_id: 'child_identity_missing', summary: 'finding',
          notes: [], references: [], output_hash: `sha256:${'c'.repeat(64)}`,
        }],
        failures: ['other reviewers unavailable'], independence: 'same-family',
      })
      expect(() => kernel.runWritingAssurance({
        project_id: project.project_id, expected_revision: 0, audit_kind: 'writing', mode: 'semantic', semantic_review: receipt,
      })).toThrow('no durable execution identity')
      expect(kernel.assurance.list(project.project_id)).toMatchObject({ revision: 0, audits: [] })
      expect(kernel.listArtifacts(project.project_id).filter(item => item.kind === 'analysis')).toEqual([])
    } finally {
      kernel.close()
    }
  })

  it('records verified partial fan-in with the reviewer topology node and provisional acceptance', () => {
    const kernel = freshKernel()
    try {
      const project = kernel.createProject({
        name: 'semantic partial', workspace: '/work', creator_principal_id: 'pi-assurance',
        brief: {
          problem: 'Review a draft.', scope: 'One draft.', questions: [], primary_metrics: [], resources: '',
          risks: [], target_outputs: ['paper'], target_venue: null, baseline_repo: null, domain: 'writing',
        },
      })
      kernel.db.prepare("UPDATE projects SET status = 'WRITING', revision = 3 WHERE project_id = ?").run(project.project_id)
      kernel.registerArtifact({ project_id: project.project_id, kind: 'paper', content: '# Draft' })
      kernel.linkSession('session_semantic', project.project_id, {
        principal_id: 'pi-assurance', tenant_id: '', issuer: 'kernel',
      })
      kernel.registerChildLink({
        project_id: project.project_id,
        child_id: 'child_reviewer_ok',
        parent_id: 'session_semantic',
        mode: 'one-shot',
        role: 'reviewer',
        state: 'succeeded',
        execution_identity: {
          provider_ref: 'spawn', model_ref: 'deepseek-v4', family_ref: 'deepseek',
          config_hash: `sha256:${'d'.repeat(64)}`,
        },
      })
      const action = kernel.projectProjection(project.project_id).next_actions_v2[0]!
      const receipt = AssuranceSemanticReviewReceipt.parse({
        panel_id: 'panel_partial_review', project_id: project.project_id, session_id: 'session_semantic',
        project_revision: 3, action_id: action.id, action_revision: action.revision,
        panel_hash: `sha256:${'a'.repeat(64)}`, input_hash: `sha256:${'b'.repeat(64)}`,
        state: 'partial',
        reviewers: [{
          reviewer_role: 'claim-evidence',
          child_id: 'child_reviewer_ok', summary: 'One bounded finding.', notes: [], references: [],
          output_hash: `sha256:${'c'.repeat(64)}`,
        }],
        failures: ['second reviewer unavailable'],
        independence: 'same-family',
      })

      const result = kernel.runWritingAssurance({
        project_id: project.project_id, expected_revision: 0, audit_kind: 'writing', mode: 'semantic', semantic_review: receipt,
      })

      expect(result.audit).toMatchObject({
        verdict: 'FAIL',
        reason_code: 'deterministic_checks_failed_semantic_partial',
        acceptance_status: 'provisional',
        review: {
          method: 'semantic', independence: 'same-model',
          reviewer_ref: 'panel_partial_review', topology_node_id: 'child_reviewer_ok',
        },
      })
    } finally {
      kernel.close()
    }
  })

  it('records a real immutable NOT_APPLICABLE finding only when the claim-evidence producer proves no claims exist', () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-assurance-na-reopen-'))
    roots.push(root)
    const dbPath = join(root, 'kernel.db')
    const casRoot = join(root, 'cas')
    let kernel = new ResearchKernel({ dbPath, casRoot, requireSignedManifest: false })
    const project = kernel.createProject({
      name: 'claim evidence applicability', workspace: '/work', creator_principal_id: 'pi-assurance',
      brief: {
        problem: 'Determine whether claim-evidence review applies.', scope: 'One draft.', questions: [],
        primary_metrics: [], resources: '', risks: [], target_outputs: ['paper'], target_venue: null,
        baseline_repo: null, domain: 'writing',
      },
    })
    const paper = kernel.registerArtifact({
      project_id: project.project_id, kind: 'paper', content: '# Draft\n\nNo research claims yet.',
      media_type: 'text/markdown', file_name: 'paper.md',
    })
    const before = {
      project: kernel.getProject(project.project_id),
      gates: kernel.listGates(project.project_id),
      bundles: kernel.listArtifacts(project.project_id).filter(item => item.kind === 'bundle'),
    }

    const missing = kernel.assurance.project({
      project_id: project.project_id,
      level: 'draft',
      required_audit_kinds: ['claim-evidence'],
      current_input_hashes: {},
    })
    expect(missing).toMatchObject({
      overall_assurance: 'blocked', missing_audit_kinds: ['claim-evidence'],
    })

    const result = kernel.runWritingAssurance({
      project_id: project.project_id,
      expected_revision: 0,
      audit_kind: 'claim-evidence',
      mode: 'deterministic',
      semantic_review: null,
    })

    expect(result.audit).toMatchObject({
      audit_kind: 'claim-evidence',
      execution: { status: 'succeeded' },
      verdict: 'NOT_APPLICABLE',
      reason_code: 'claim_evidence_no_claims',
      acceptance_status: 'provisional',
      review: {
        method: 'deterministic', independence: 'deterministic',
        executor_ref: 'kernel:claim-evidence-binding-v1',
      },
    })
    expect(result.audit.input_pins).toEqual([
      { ref: `artifact:${paper.artifact_id}`, sha256: `sha256:${paper.sha256}` },
      { ref: `claim-evidence:${project.project_id}`, sha256: writingClaimEvidenceSha256([]) },
    ])
    const findingsArtifact = kernel.getArtifact(project.project_id, result.audit.findings_artifact_id)
    const findingsBytes = kernel.cas.read(findingsArtifact.sha256)
    expect(createHash('sha256').update(findingsBytes).digest('hex')).toBe(findingsArtifact.sha256)
    expect(JSON.parse(findingsBytes.toString('utf8'))).toMatchObject({
      schema_version: 1,
      audit_id: result.audit.audit_id,
      audit_kind: 'claim-evidence',
      applicability: { applicable: false, reason_code: 'no_claims_registered' },
      input_pins: result.audit.input_pins,
      deterministic: { producer: 'kernel:claim-evidence-binding-v1', checks: [] },
    })
    expect(kernel.assurance.project({
      project_id: project.project_id,
      level: 'draft',
      required_audit_kinds: ['claim-evidence'],
      current_input_hashes: Object.fromEntries(result.audit.input_pins.map(pin => [pin.ref, pin.sha256])),
    })).toMatchObject({
      missing_audit_kinds: [], overall_assurance: 'provisional',
      audits: [{ audit_kind: 'claim-evidence', blocking: false }],
    })
    expect(kernel.getProject(project.project_id)).toEqual(before.project)
    expect(kernel.listGates(project.project_id)).toEqual(before.gates)
    expect(kernel.listArtifacts(project.project_id).filter(item => item.kind === 'bundle')).toEqual(before.bundles)

    kernel.close()
    kernel = new ResearchKernel({ dbPath, casRoot, requireSignedManifest: false })
    const reopened = kernel.assurance.get(project.project_id, result.audit.audit_id)
    expect(reopened.audit).toEqual(result.audit)
    expect(kernel.cas.read(findingsArtifact.sha256)).toEqual(findingsBytes)

    const claim = kernel.createClaim({ project_id: project.project_id, statement: 'Accuracy improves.' })
    const stale = kernel.assurance.project({
      project_id: project.project_id,
      level: 'draft',
      required_audit_kinds: ['claim-evidence'],
      current_input_hashes: {
        [`artifact:${paper.artifact_id}`]: `sha256:${paper.sha256}`,
        [`claim-evidence:${project.project_id}`]: writingClaimEvidenceSha256([
          { claim_ref: claim.claim_id, accepted_evidence_refs: [] },
        ]),
      },
    })
    expect(stale).toMatchObject({
      overall_assurance: 'blocked', missing_audit_kinds: [],
      audits: [{ audit_kind: 'claim-evidence', blocking: true, effective_acceptance_status: 'stale', reasons: ['input_hash_mismatch'] }],
    })
    kernel.close()
  })
})
