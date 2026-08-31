import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ResearchKernel, writingFileSha256 } from '@dsh-scholar/research-kernel'
import { AssuranceSemanticReviewReceipt, type WritingReviewerRole } from '@dsh-scholar/research-schemas'

const roots: string[] = []
const sha = (character: string): `sha256:${string}` => `sha256:${character.repeat(64)}`

function openKernel(root?: string): { kernel: ResearchKernel; root: string } {
  const selected = root ?? mkdtempSync(join(tmpdir(), 'dsh-writing-patch-'))
  if (root === undefined) roots.push(selected)
  return {
    root: selected,
    kernel: new ResearchKernel({
      dbPath: join(selected, 'kernel.db'), casRoot: join(selected, 'cas'),
      requireSignedManifest: false, previewDebounceMs: 60_000,
    }),
  }
}

function projectWithDocument(kernel: ResearchKernel, name: string) {
  const project = kernel.createProject({
    name, workspace: '/work', creator_principal_id: 'pi-writing',
    brief: {
      problem: 'Evaluate a controlled method.', scope: 'One manuscript.', questions: [],
      primary_metrics: ['accuracy'], resources: '', risks: [], target_outputs: ['paper'],
      target_venue: null, baseline_repo: null, domain: 'machine learning',
    },
  })
  kernel.db.prepare("UPDATE projects SET status = 'WRITING', revision = 4 WHERE project_id = ?").run(project.project_id)
  const document = kernel.texEnsure(project.project_id)
  kernel.texWriteFile(document.document_id, 'paper.tex', '\\documentclass{article}\n\\begin{document}Old\\end{document}\n')
  return { project: kernel.getProject(project.project_id), document: kernel.tex.getDocument(document.document_id) }
}

function completeReview(kernel: ResearchKernel, projectId: string, documentId: string) {
  kernel.linkSession('session_writing_review', projectId, {
    principal_id: 'pi-writing', tenant_id: '', issuer: 'kernel',
  })
  const roles: WritingReviewerRole[] = ['claim-evidence', 'citation', 'statistics', 'reproducibility']
  for (const role of roles) {
    kernel.registerChildLink({
      project_id: projectId, child_id: `child_${role.replace('-', '_')}`,
      parent_id: 'session_writing_review', mode: 'one-shot', role: 'reviewer', state: 'succeeded',
      execution_identity: {
        provider_ref: 'spawn', model_ref: `reviewer-${role}`, family_ref: 'writing-review-panel',
        config_hash: sha(String(roles.indexOf(role) + 1)),
      },
    })
  }
  const action = kernel.projectProjection(projectId).next_actions_v2.find(candidate => candidate.code === 'reviewer_run')!
  const receipt = AssuranceSemanticReviewReceipt.parse({
    panel_id: 'panel_method_review', project_id: projectId, session_id: 'session_writing_review',
    project_revision: kernel.getProject(projectId).revision,
    action_id: action.id, action_revision: action.revision,
    panel_hash: sha('a'), input_hash: sha('b'), state: 'complete', failures: [], independence: 'same-family',
    reviewers: roles.map((role, index) => ({
      reviewer_role: role, child_id: `child_${role.replace('-', '_')}`,
      summary: `${role} review`, notes: [], references: [], output_hash: sha(String(index + 1)),
    })),
  })
  const pin = kernel.currentWritingInputPin(projectId, documentId)
  return kernel.recordWritingReviewerPanel({
    aggregate_id: 'review_panel_method', input_pin: pin, semantic_review: receipt,
    created_at: '2026-08-20T00:00:00.000Z', expected_revision: 0,
  })
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('Human-controlled TeX patch application', () => {
  it('applies an exact reviewer proposal once, fences old previews and survives restart without changing project authority', () => {
    const { kernel, root } = openKernel()
    const { project, document } = projectWithDocument(kernel, 'writing apply')
    const beforeAuthority = {
      project: kernel.getProject(project.project_id), claims: kernel.listClaims(project.project_id),
      evidence: kernel.listEvidence(project.project_id), gates: kernel.listGates(project.project_id),
    }
    const panel = completeReview(kernel, project.project_id, document.document_id)
    const oldPreview = kernel.texCreateBuild(document.document_id, document.revision + 1, 'paper.tex', null, true)
    const inputPin = kernel.currentWritingInputPin(project.project_id, document.document_id)
    const compilePin = kernel.currentWritingCompilePin(project.project_id, document.document_id)
    const replacement = '\\documentclass{article}\n\\begin{document}Reviewed\\end{document}\n'
    const proposal = kernel.recordWritingPatchProposal({
      expected_revision: panel.stream_revision,
      record: {
        proposal_id: 'writing_patch_method', project_id: project.project_id,
        aggregate_id: panel.record.aggregate_id, reviewer_role: 'claim-evidence', reviewer_child_id: 'child_claim_evidence',
        input_pin: inputPin, compile_pin: compilePin, file_path: 'paper.tex',
        expected_file_sha256: writingFileSha256(kernel.texReadFile(document.document_id, 'paper.tex')!.content),
        replacement_content: replacement, replacement_sha256: writingFileSha256(replacement),
        rationale: 'Bind the reviewed wording to the exact manuscript snapshot.', status: 'proposed',
        created_at: '2026-08-20T00:00:01.000Z',
      },
    })
    kernel.addProjectMember({
      project_id: project.project_id, principal_id: 'writer-human', role: 'researcher', actor: 'pi-writing',
    })

    const applied = kernel.applyWritingPatch(project.project_id, proposal.record.proposal_id, {
      expected_revision: proposal.stream_revision,
      expected_document_revision: inputPin.document_revision,
      expected_tex_sha256: inputPin.tex_sha256,
      expected_claim_evidence_sha256: inputPin.claim_evidence_sha256,
      expected_compile_pin: compilePin,
    }, { principal_id: 'writer-human', auth_method: 'dsh-session', session_id: 'session_writing_review' })

    expect(applied.record).toMatchObject({
      proposal_id: 'writing_patch_method', project_id: project.project_id,
      input_pin: inputPin, file_path: 'paper.tex', file_version: 2,
      preview_requested_revision: inputPin.document_revision + 1,
    })
    expect(applied.record.output_pin.document_revision).toBe(inputPin.document_revision + 1)
    expect(kernel.texReadFile(document.document_id, 'paper.tex')?.content).toBe(replacement)
    expect(kernel.texGetBuild(oldPreview.build_id)).toMatchObject({ status: 'cancelled', superseded_by: applied.record.application_id })
    expect(kernel.texPreviewStatus(document.document_id).pending?.revision).toBe(applied.record.output_pin.document_revision)
    const replayed = kernel.applyWritingPatch(project.project_id, proposal.record.proposal_id, {
      expected_revision: proposal.stream_revision,
      expected_document_revision: inputPin.document_revision,
      expected_tex_sha256: inputPin.tex_sha256,
      expected_claim_evidence_sha256: inputPin.claim_evidence_sha256,
      expected_compile_pin: compilePin,
    }, { principal_id: 'writer-human', auth_method: 'dsh-session', session_id: 'session_writing_review' })
    expect(replayed.record.application_id).toBe(applied.record.application_id)
    expect(kernel.texReadFile(document.document_id, 'paper.tex')).toMatchObject({ version: 2, content: replacement })
    expect(kernel.getProject(project.project_id)).toEqual(beforeAuthority.project)
    expect(kernel.listClaims(project.project_id)).toEqual(beforeAuthority.claims)
    expect(kernel.listEvidence(project.project_id)).toEqual(beforeAuthority.evidence)
    expect(kernel.listGates(project.project_id)).toEqual(beforeAuthority.gates)
    kernel.close()

    const reopened = openKernel(root).kernel
    expect(reopened.writingReview.listPatchApplications(project.project_id).records).toHaveLength(1)
    expect(reopened.texReadFile(document.document_id, 'paper.tex')?.content).toBe(replacement)
    reopened.close()
  })

  it('fails closed for non-Human authority, stale document/hash/generation and cross-project proposals with zero TeX writes', () => {
    const { kernel } = openKernel()
    try {
      const first = projectWithDocument(kernel, 'writing guarded')
      const second = projectWithDocument(kernel, 'writing other')
      const panel = completeReview(kernel, first.project.project_id, first.document.document_id)
      const pin = kernel.currentWritingInputPin(first.project.project_id, first.document.document_id)
      const compilePin = kernel.currentWritingCompilePin(first.project.project_id, first.document.document_id)
      const original = kernel.texReadFile(first.document.document_id, 'paper.tex')!
      const replacement = original.content.replace('Old', 'New')
      const proposal = kernel.recordWritingPatchProposal({
        expected_revision: panel.stream_revision,
        record: {
          proposal_id: 'writing_patch_guarded', project_id: first.project.project_id,
          aggregate_id: panel.record.aggregate_id, reviewer_role: 'claim-evidence', reviewer_child_id: 'child_claim_evidence',
          input_pin: pin, compile_pin: compilePin, file_path: 'paper.tex',
          expected_file_sha256: writingFileSha256(original.content), replacement_content: replacement,
          replacement_sha256: writingFileSha256(replacement), rationale: 'review', status: 'proposed',
          created_at: '2026-08-20T00:00:01.000Z',
        },
      })
      const applyBase = {
        expected_revision: proposal.stream_revision, expected_document_revision: pin.document_revision,
        expected_tex_sha256: pin.tex_sha256, expected_claim_evidence_sha256: pin.claim_evidence_sha256,
        expected_compile_pin: compilePin,
      }

      expect(() => kernel.applyWritingPatch(
        first.project.project_id,
        proposal.record.proposal_id,
        applyBase,
        { principal_id: 'pi-writing', auth_method: 'agent' } as never,
      )).toThrow()
      expect(kernel.texReadFile(first.document.document_id, 'paper.tex')).toEqual(original)

      expect(() => kernel.applyWritingPatch(first.project.project_id, proposal.record.proposal_id, {
        ...applyBase, expected_tex_sha256: sha('f'),
      }, { principal_id: 'pi-writing', auth_method: 'local-human' })).toThrow(/input pin/i)
      expect(kernel.texReadFile(first.document.document_id, 'paper.tex')).toEqual(original)

      kernel.texCreateBuild(first.document.document_id, pin.document_revision, 'paper.tex', null, false)
      expect(() => kernel.applyWritingPatch(first.project.project_id, proposal.record.proposal_id, {
        ...applyBase,
      }, { principal_id: 'pi-writing', auth_method: 'local-human' })).toThrow(/compile generation/i)
      expect(kernel.texReadFile(first.document.document_id, 'paper.tex')).toEqual(original)

      expect(() => kernel.applyWritingPatch(second.project.project_id, proposal.record.proposal_id, {
        ...applyBase, expected_revision: 0,
      }, { principal_id: 'pi-writing', auth_method: 'local-human' })).toThrow(/not found/i)
      expect(kernel.writingReview.listPatchApplications(first.project.project_id).records).toEqual([])
      expect(kernel.writingReview.listPatchApplications(second.project.project_id).records).toEqual([])
      expect(kernel.methodologyTelemetry.redactedAggregate().counters).toEqual(expect.arrayContaining([
        expect.objectContaining({
          key: 'methodology.writing_patch.outcome_total',
          tags: { mode: 'internal-fixture', phase: 'apply', outcome: 'failure' },
          value: 4,
        }),
      ]))
    } finally {
      kernel.close()
    }
  })

  it('reconciles a durable application receipt after restart when the process fails after the TeX mutation', () => {
    const { kernel, root } = openKernel()
    const { project, document } = projectWithDocument(kernel, 'writing crash recovery')
    const panel = completeReview(kernel, project.project_id, document.document_id)
    const inputPin = kernel.currentWritingInputPin(project.project_id, document.document_id)
    const compilePin = kernel.currentWritingCompilePin(project.project_id, document.document_id)
    const original = kernel.texReadFile(document.document_id, 'paper.tex')!
    const replacement = original.content.replace('Old', 'Recovered')
    const proposal = kernel.recordWritingPatchProposal({
      expected_revision: panel.stream_revision,
      record: {
        proposal_id: 'writing_patch_crash', project_id: project.project_id,
        aggregate_id: panel.record.aggregate_id, reviewer_role: 'claim-evidence', reviewer_child_id: 'child_claim_evidence',
        input_pin: inputPin, compile_pin: compilePin, file_path: 'paper.tex',
        expected_file_sha256: writingFileSha256(original.content), replacement_content: replacement,
        replacement_sha256: writingFileSha256(replacement), rationale: 'recover the exact reviewed patch', status: 'proposed',
        created_at: '2026-08-20T00:00:02.000Z',
      },
    })
    kernel.db.exec(`CREATE TRIGGER fail_writing_application_receipt
      BEFORE INSERT ON writing_methodology_events
      WHEN NEW.event_kind = 'patch_application'
      BEGIN SELECT RAISE(ABORT, 'simulated_receipt_crash'); END`)

    expect(() => kernel.applyWritingPatch(project.project_id, proposal.record.proposal_id, {
      expected_revision: proposal.stream_revision,
      expected_document_revision: inputPin.document_revision,
      expected_tex_sha256: inputPin.tex_sha256,
      expected_claim_evidence_sha256: inputPin.claim_evidence_sha256,
      expected_compile_pin: compilePin,
    }, { principal_id: 'pi-writing', auth_method: 'local-human' })).toThrow(/simulated_receipt_crash/)
    expect(kernel.texReadFile(document.document_id, 'paper.tex')).toMatchObject({ version: original.version + 1, content: replacement })
    expect(kernel.writingReview.listPatchApplications(project.project_id).records).toEqual([])
    kernel.db.exec('DROP TRIGGER fail_writing_application_receipt')
    kernel.close()

    const reopened = openKernel(root).kernel
    const applications = reopened.writingReview.listPatchApplications(project.project_id).records
    expect(applications).toHaveLength(1)
    expect(applications[0]?.record).toMatchObject({
      proposal_id: proposal.record.proposal_id,
      file_path: 'paper.tex',
      file_version: original.version + 1,
      output_pin: { document_revision: inputPin.document_revision + 1 },
    })
    expect(reopened.texReadFile(document.document_id, 'paper.tex')).toMatchObject({ version: original.version + 1, content: replacement })
    expect(reopened.methodologyTelemetry.redactedAggregate().counters).toEqual(expect.arrayContaining([
      expect.objectContaining({
        key: 'methodology.writing_patch.outcome_total',
        tags: { mode: 'internal-fixture', phase: 'recovery', outcome: 'success' },
      }),
    ]))
    reopened.close()
  })

  it('completes a journaled patch after restart when the process stops before the TeX mutation', () => {
    const { kernel, root } = openKernel()
    const { project, document } = projectWithDocument(kernel, 'writing intent recovery')
    const panel = completeReview(kernel, project.project_id, document.document_id)
    const inputPin = kernel.currentWritingInputPin(project.project_id, document.document_id)
    const compilePin = kernel.currentWritingCompilePin(project.project_id, document.document_id)
    const original = kernel.texReadFile(document.document_id, 'paper.tex')!
    const replacement = original.content.replace('Old', 'Intent recovered')
    const proposal = kernel.recordWritingPatchProposal({
      expected_revision: panel.stream_revision,
      record: {
        proposal_id: 'writing_patch_intent_crash', project_id: project.project_id,
        aggregate_id: panel.record.aggregate_id, reviewer_role: 'claim-evidence', reviewer_child_id: 'child_claim_evidence',
        input_pin: inputPin, compile_pin: compilePin, file_path: 'paper.tex',
        expected_file_sha256: writingFileSha256(original.content), replacement_content: replacement,
        replacement_sha256: writingFileSha256(replacement), rationale: 'recover the journaled intent', status: 'proposed',
        created_at: '2026-08-20T00:00:03.000Z',
      },
    })
    kernel.db.exec(`CREATE TRIGGER fail_writing_tex_mutation
      BEFORE UPDATE ON tex_files
      BEGIN SELECT RAISE(ABORT, 'simulated_tex_crash'); END`)

    expect(() => kernel.applyWritingPatch(project.project_id, proposal.record.proposal_id, {
      expected_revision: proposal.stream_revision,
      expected_document_revision: inputPin.document_revision,
      expected_tex_sha256: inputPin.tex_sha256,
      expected_claim_evidence_sha256: inputPin.claim_evidence_sha256,
      expected_compile_pin: compilePin,
    }, { principal_id: 'pi-writing', auth_method: 'local-human' })).toThrow(/simulated_tex_crash/)
    expect(kernel.texReadFile(document.document_id, 'paper.tex')).toEqual(original)
    expect(kernel.writingReview.listPatchApplications(project.project_id).records).toEqual([])
    kernel.db.exec('DROP TRIGGER fail_writing_tex_mutation')
    kernel.close()

    const reopened = openKernel(root).kernel
    expect(reopened.texReadFile(document.document_id, 'paper.tex')).toMatchObject({ version: original.version + 1, content: replacement })
    expect(reopened.writingReview.listPatchApplications(project.project_id).records).toHaveLength(1)
    reopened.close()
  })
})
