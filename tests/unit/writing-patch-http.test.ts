import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { AssuranceSemanticReviewReceipt, type WritingReviewerRole } from '@dsh-scholar/research-schemas'
import { ResearchClient } from '../../packages/research-client/src/index.js'
import { ResearchKernel } from '../../packages/research-kernel/src/kernel.js'
import { startKernelServer } from '../../packages/research-kernel/src/server.js'
import { writingFileSha256 } from '../../packages/research-kernel/src/writing-review.js'

const roots: string[] = []
const hash = (character: string): `sha256:${string}` => `sha256:${character.repeat(64)}`

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('v2 writing methodology and Human TeX patch HTTP seam', () => {
  it('provides typed CAS routes, durable AuthZ, strict actor binding and compact manuscript visibility', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-writing-http-'))
    roots.push(root)
    const kernel = new ResearchKernel({
      dbPath: join(root, 'kernel.db'), casRoot: join(root, 'cas'),
      requireSignedManifest: false, previewDebounceMs: 60_000, serviceToken: 'writing-service-secret',
    })
    const project = kernel.createProject({
      name: 'writing http', workspace: '/work', creator_principal_id: 'pi-http',
      brief: {
        problem: 'Write from measurable evidence.', scope: 'One paper.', questions: [], primary_metrics: ['accuracy'],
        resources: '', risks: [], target_outputs: ['paper'], target_venue: null, baseline_repo: null, domain: 'writing',
      },
    })
    kernel.db.prepare("UPDATE projects SET status = 'WRITING', revision = 4 WHERE project_id = ?").run(project.project_id)
    kernel.addProjectMember({ project_id: project.project_id, principal_id: 'writer-http', role: 'researcher', actor: 'pi-http' })
    kernel.addProjectMember({ project_id: project.project_id, principal_id: 'viewer-http', role: 'viewer', actor: 'pi-http' })
    const document = kernel.texEnsure(project.project_id)
    kernel.texWriteFile(document.document_id, 'paper.tex', '\\documentclass{article}\n\\begin{document}Old\\end{document}\n')
    const inputPin = kernel.currentWritingInputPin(project.project_id, document.document_id)
    kernel.linkSession('session_http_review', project.project_id, {
      principal_id: 'pi-http', tenant_id: '', issuer: 'kernel',
    })
    const roles: WritingReviewerRole[] = ['claim-evidence', 'citation', 'statistics', 'reproducibility']
    for (const role of roles) {
      kernel.registerChildLink({
        project_id: project.project_id, child_id: `child_http_${role.replace('-', '_')}`,
        parent_id: 'session_http_review', mode: 'one-shot', role: 'reviewer', state: 'succeeded',
        execution_identity: {
          provider_ref: 'spawn', model_ref: `reviewer-${role}`, family_ref: 'writing-review-panel',
          config_hash: hash(String(roles.indexOf(role) + 1)),
        },
      })
    }
    const action = kernel.projectProjection(project.project_id).next_actions_v2.find(candidate => candidate.code === 'reviewer_run')!
    const semanticReview = AssuranceSemanticReviewReceipt.parse({
      panel_id: 'panel_http_writing', project_id: project.project_id, session_id: 'session_http_review',
      project_revision: 4, action_id: action.id, action_revision: action.revision,
      panel_hash: hash('a'), input_hash: hash('b'), state: 'complete', failures: [], independence: 'same-family',
      reviewers: roles.map((role, index) => ({
        reviewer_role: role, child_id: `child_http_${role.replace('-', '_')}`,
        summary: `${role} review`, notes: [], references: [], output_hash: hash(String(index + 1)),
      })),
    })
    const { server, url } = await startKernelServer({ kernel, port: 0, token: 'writing-kernel-secret' })
    try {
      const client = new ResearchClient({ endpoint: url, token: 'writing-kernel-secret' })
      const triadInput = {
        expected_revision: 0,
        record: {
          triad_id: 'triad_http_method', input_pin: inputPin,
          motivation: 'The baseline misses the controlled failure.', design: 'The design isolates the mechanism.',
          technical_advantage: { statement: 'The method improves accuracy.', measurable_evidence_refs: [] },
          status: 'diagnostic' as const, created_at: '2026-08-20T00:00:00.000Z',
        },
      }
      await expect(client.recordMethodTriad(project.project_id, 'viewer-http', triadInput))
        .rejects.toMatchObject({ status: 403, code: 'role_forbidden' })
      const triad = await client.recordMethodTriad(project.project_id, 'writer-http', triadInput)
      expect(triad.record.diagnostic).toMatchObject({ status: 'diagnostic_gap' })

      const guide = await client.activateSectionGuide(project.project_id, 'writer-http', {
        expected_revision: triad.stream_revision,
        request: {
          activation_id: 'section_guide_http_method', input_pin: inputPin, section: 'method',
          available_inputs: [], created_at: '2026-08-20T00:00:01.000Z',
        },
      })
      expect(guide.record).toMatchObject({ channel: 'instruction', state: 'diagnostic_gap' })
      expect(guide.record.available_inputs).toContain('research_problem')

      const panel = await client.recordWritingReviewerPanel(project.project_id, 'writer-http', {
        aggregate_id: 'review_panel_http_method', input_pin: inputPin, semantic_review: semanticReview,
        created_at: '2026-08-20T00:00:02.000Z', expected_revision: guide.stream_revision,
      })
      expect(panel.record).toMatchObject({ state: 'complete' })
      expect(kernel.methodologyTelemetry.redactedAggregate().counters).toEqual(expect.arrayContaining([
        expect.objectContaining({
          key: 'methodology.reviewer.state_total',
          tags: { mode: 'internal-fixture', state: 'complete' },
        }),
      ]))

      const currentFile = kernel.texReadFile(document.document_id, 'paper.tex')!
      const replacement = currentFile.content.replace('Old', 'Reviewed')
      const compilePin = kernel.currentWritingCompilePin(project.project_id, document.document_id)
      const proposal = await client.proposeWritingPatch(project.project_id, 'writer-http', {
        expected_revision: panel.stream_revision,
        record: {
          proposal_id: 'writing_patch_http_method', project_id: project.project_id,
          aggregate_id: panel.record.aggregate_id, reviewer_role: 'claim-evidence', reviewer_child_id: 'child_http_claim_evidence',
          input_pin: inputPin, compile_pin: compilePin, file_path: 'paper.tex',
          expected_file_sha256: writingFileSha256(currentFile.content), replacement_content: replacement,
          replacement_sha256: writingFileSha256(replacement), rationale: 'Apply reviewed wording.', status: 'proposed',
          created_at: '2026-08-20T00:00:03.000Z',
        },
      })
      const apply = {
        expected_revision: proposal.stream_revision, expected_document_revision: inputPin.document_revision,
        expected_tex_sha256: inputPin.tex_sha256, expected_claim_evidence_sha256: inputPin.claim_evidence_sha256,
        expected_compile_pin: compilePin,
      }
      const applyPath = `${url}/v2/projects/${project.project_id}/writing-patches/${proposal.record.proposal_id}/apply`
      const postApply = (payload: unknown, headers: Record<string, string>) => fetch(applyPath, {
        method: 'POST',
        headers: {
          'content-type': 'application/json', authorization: 'Bearer writing-kernel-secret', ...headers,
        },
        body: JSON.stringify(payload),
      })
      const directBearer = await postApply(apply, { 'x-principal-id': 'writer-http' })
      expect(directBearer.status).toBe(403)
      expect(await directBearer.json()).toMatchObject({ error: { code: 'writing_patch_trusted_session_required' } })

      const forged = await postApply({
        ...apply, actor: { principal_id: 'writer-http', auth_method: 'dsh-session' }, auth_method: 'dsh-session',
      }, {
        'x-service-token': 'writing-service-secret', 'x-service-principal': 'standalone-human-bff',
        'x-principal-id': 'writer-http', 'x-principal-session': 'session_http_review',
      })
      expect(forged.status).toBe(422)
      expect(kernel.writingReview.listPatchApplications(project.project_id).records).toHaveLength(0)

      const serviceActor = await postApply(apply, {
        'x-service-token': 'writing-service-secret', 'x-service-principal': 'research-orchestrator',
        'x-principal-id': 'writer-http', 'x-principal-session': 'session_http_review',
      })
      expect(serviceActor.status).toBe(403)

      const appliedResponse = await postApply(apply, {
        'x-service-token': 'writing-service-secret', 'x-service-principal': 'standalone-human-bff',
        'x-principal-id': 'writer-http', 'x-principal-session': 'session_http_review',
      })
      expect(appliedResponse.status).toBe(201)
      const applied = await appliedResponse.json() as Awaited<ReturnType<ResearchClient['applyWritingPatch']>>
      expect(applied.record).toMatchObject({
        proposal_id: proposal.record.proposal_id,
        file_version: 2,
        actor: {
          principal_id: 'writer-http',
          auth_method: 'dsh-session',
          session_id: 'session_http_review',
        },
      })
      expect(kernel.texReadFile(document.document_id, 'paper.tex')?.content).toBe(replacement)
      expect(kernel.methodologyTelemetry.redactedAggregate().counters).toEqual(expect.arrayContaining([
        expect.objectContaining({
          key: 'methodology.writing_patch.outcome_total',
          tags: { mode: 'internal-fixture', phase: 'apply', outcome: 'success' },
        }),
      ]))

      const listed = await client.listWritingPatches(project.project_id, 'writer-http')
      expect(listed.proposals.records).toHaveLength(1)
      expect(listed.applications.records).toHaveLength(1)
      const compact = await client.getMethodology(project.project_id, 'writer-http')
      expect(compact.manuscript).toMatchObject({
        revision: 5,
        method_triad: { triad_id: 'triad_http_method', status: 'diagnostic_gap' },
        reviewer_panel: { aggregate_id: 'review_panel_http_method', state: 'complete' },
        patches: { proposal_count: 1, application_count: 1, latest_application_id: applied.record.application_id },
      })
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()))
      kernel.close()
    }
  })
})
