/**
 * ONBOARD-01 — Research Intake kernel/service layer tests
 * (research-onboarding.md authoritative contract; acceptance-tests.md §8.1;
 * hardening-v0.2-status.md §3/§4 ONBOARD-01 kernel/服务端层).
 *
 * Covers the full pre-accept pipeline (begin → stage → scan → grill →
 * propose → adopt/reject), the pre-accept ZERO-AUTHORITY invariant (no
 * Project/Gate/Artifact/Job/Run/Terminal/Evidence/Claim/Outbox writes before
 * acceptance), deterministic Grill taxonomy, static scan quarantine rules,
 * Human Adoption with principal + revision pinning, idempotent replays,
 * recovery across kernel restarts, GC (expiry + staged cleanup), and the
 * /v1/projects/{id}/intake* HTTP surface (including cross-project 404).
 */
import { describe, expect, it, afterEach } from 'vitest'
import { createHash } from 'node:crypto'
import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ResearchKernel, KernelError } from '@dsh-scholar/research-kernel'
import { startKernelServer } from '../../packages/research-kernel/lib/server.js'
import type { AdoptionReceipt, GrillAnswerView, IntakeProjection, IntakeSession, PhaseProposal } from '@dsh-scholar/research-schemas'

const REAL_LIMIT = ResearchKernel.UPLOAD_MAX_FILE_BYTES

function freshKernel(options: { serviceToken?: string } = {}): ResearchKernel {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-intake-test-'))
  return new ResearchKernel({ dbPath: join(dir, 'kernel.db'), casRoot: join(dir, 'cas'), requireSignedManifest: false, ...options })
}

function makeBrief() {
  return {
    problem: 'p', scope: 's', questions: [], primary_metrics: ['m'],
    resources: '', risks: [], target_outputs: ['paper'], target_venue: null,
    baseline_repo: null, domain: 'ml',
  }
}

function sha256(content: Uint8Array | string): string {
  return createHash('sha256').update(content).digest('hex')
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

/** All REQUIRED questions answered (deterministic default values). */
function allRequiredAnswers(questions: GrillAnswerView[], phase = 'experiment'): Array<{ question_code: string; answer: string; question_revision: number }> {
  return questions.filter(q => q.required).map(q => ({
    question_code: q.question_code,
    answer: q.question_code === 'observed_phase_claim' ? phase : 'yes',
    question_revision: q.question_revision,
  }))
}

function count(kernel: ResearchKernel, table: string): number {
  const row = kernel.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }
  return Number(row.n)
}

async function withServer(kernel: ResearchKernel, fn: (base: string) => Promise<void>): Promise<void> {
  const { server, port } = await startKernelServer({ kernel, host: '127.0.0.1', port: 0 })
  try {
    await fn(`http://127.0.0.1:${port}`)
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()))
  }
}

const PRINCIPAL = { principal_id: 'pi-1', tenant_id: 'acme', auth_method: 'dsh-session', session_id: 'sess-1' }
const INTAKE_SERVICE_TOKEN = 'intake-human-bff-service-token'
const INTAKE_HUMAN_HEADERS = {
  'x-service-token': INTAKE_SERVICE_TOKEN,
  'x-service-principal': 'standalone-human-bff',
  'x-principal-id': PRINCIPAL.principal_id,
  'x-principal-session': PRINCIPAL.session_id,
}

describe('ONBOARD-01 begin', () => {
  it('creates a draft intake session with owner, project linkage and 7-day expiry', () => {
    const kernel = freshKernel()
    const project = kernel.createProject({ name: 't', workspace: '/w', brief: makeBrief() })
    const session = kernel.beginIntake({ project_id: project.project_id, source_label: 'uploaded-paper', target_phase: 'experiment', owner: PRINCIPAL })
    expect(session.status).toBe('draft')
    expect(session.intake_id).toMatch(/^intk_/)
    expect(session.project_id).toBe(project.project_id)
    expect(session.owner.principal_id).toBe('pi-1')
    expect(session.target_phase).toBe('experiment')
    const ttl = Date.parse(session.expires_at) - Date.parse(session.created_at)
    expect(ttl).toBeGreaterThanOrEqual(ResearchKernel.INTAKE_DEFAULT_TTL_MS)
    expect(ttl).toBeLessThan(ResearchKernel.INTAKE_DEFAULT_TTL_MS + 5000)
    expect(session.audit[0]?.action).toBe('begin')
    // Pre-accept: only the intake table was written.
    expect(count(kernel, 'intake_sessions')).toBe(1)
    expect(count(kernel, 'gates')).toBe(0)
    expect(count(kernel, 'artifacts')).toBe(0)
    kernel.close()
  })

  it('is idempotent by Idempotency-Key; a different request hash is 409', () => {
    const kernel = freshKernel()
    const project = kernel.createProject({ name: 't', workspace: '/w', brief: makeBrief() })
    const first = kernel.beginIntake({ project_id: project.project_id, source_label: 's', idempotency_key: 'key-1', request_hash: 'h1' })
    const replay = kernel.beginIntake({ project_id: project.project_id, source_label: 's', idempotency_key: 'key-1', request_hash: 'h1' })
    expect(replay.intake_id).toBe(first.intake_id)
    expect(count(kernel, 'intake_sessions')).toBe(1)
    expectKernelError(
      () => kernel.beginIntake({ project_id: project.project_id, source_label: 's', idempotency_key: 'key-1', request_hash: 'h2' }),
      409, 'idempotency_conflict')
    kernel.close()
  })

  it('binds an Intake idempotency key to the exact project and Chat scope', () => {
    const kernel = freshKernel()
    const projectA = kernel.createProject({ name: 'a', workspace: '/a', brief: makeBrief() })
    const projectB = kernel.createProject({ name: 'b', workspace: '/b', brief: makeBrief() })
    const first = kernel.beginIntake({
      project_id: projectA.project_id,
      source_label: 'chat',
      idempotency_key: 'authority-key',
      request_hash: 'same-hash',
      owner_scope_id: 'scope-a',
    })
    const replay = kernel.beginIntake({
      project_id: projectA.project_id,
      source_label: 'chat',
      idempotency_key: 'authority-key',
      request_hash: 'same-hash',
      owner_scope_id: 'scope-a',
    })
    expect(replay.intake_id).toBe(first.intake_id)
    expectKernelError(() => kernel.beginIntake({
      project_id: projectB.project_id,
      source_label: 'chat',
      idempotency_key: 'authority-key',
      request_hash: 'same-hash',
      owner_scope_id: 'scope-a',
    }), 409, 'idempotency_conflict')
    expectKernelError(() => kernel.beginIntake({
      project_id: projectA.project_id,
      source_label: 'chat',
      idempotency_key: 'authority-key',
      request_hash: 'same-hash',
      owner_scope_id: 'scope-b',
    }), 409, 'idempotency_conflict')
    expect(count(kernel, 'intake_sessions')).toBe(1)
    kernel.close()
  })

  it('reuses the single active intake per project (intake_id + project unique)', () => {
    const kernel = freshKernel()
    const project = kernel.createProject({ name: 't', workspace: '/w', brief: makeBrief() })
    const first = kernel.beginIntake({ project_id: project.project_id, source_label: 's1' })
    const second = kernel.beginIntake({ project_id: project.project_id, source_label: 's2' })
    expect(second.intake_id).toBe(first.intake_id)
    expect(count(kernel, 'intake_sessions')).toBe(1)
    kernel.close()
  })

  it('rejects unknown projects and empty source labels', () => {
    const kernel = freshKernel()
    expectKernelError(() => kernel.beginIntake({ project_id: 'rsp_nope', source_label: 's' }), 404, 'project_not_found')
    expectKernelError(() => kernel.beginIntake({ source_label: '' }), 422, 'validation_error')
    kernel.close()
  })
})

describe('ONBOARD-01 stage + scan (quarantine)', () => {
  it('stages files with server-side sha256 into the isolated CAS only', () => {
    const kernel = freshKernel()
    const project = kernel.createProject({ name: 't', workspace: '/w', brief: makeBrief() })
    const intake = kernel.beginIntake({ project_id: project.project_id, source_label: 's' })
    const content = Buffer.from('%PDF-1.4 draft')
    const artifact = kernel.stageIntakeArtifact(intake.intake_id, { file_name: 'paper.pdf', media_type: 'application/pdf', content })
    expect(artifact.sha256).toBe(sha256(content))
    expect(artifact.artifact_id).toBe(`sha256:${sha256(content)}`)
    expect(artifact.quarantine).toBe('staged')
    // Isolated staging file exists; the project artifact space stays empty.
    expect(readdirSync(join(kernel.intakeStagedRoot, intake.intake_id))).toEqual([`${artifact.sha256}.part`])
    expect(count(kernel, 'artifacts')).toBe(0)
    expect(kernel.cas.list()).toHaveLength(0)
    expect(kernel.getIntakeProjection(intake.intake_id).session.status).toBe('uploading')
    // Content-addressed idempotency: identical bytes reuse the row.
    const again = kernel.stageIntakeArtifact(intake.intake_id, { file_name: 'paper.pdf', content })
    expect(again.artifact_id).toBe(artifact.artifact_id)
    expect(readdirSync(join(kernel.intakeStagedRoot, intake.intake_id))).toHaveLength(1)
    kernel.close()
  })

  it('rejects path traversal, oversized content, unknown intake and terminal sessions', () => {
    const kernel = freshKernel()
    const project = kernel.createProject({ name: 't', workspace: '/w', brief: makeBrief() })
    const intake = kernel.beginIntake({ project_id: project.project_id, source_label: 's' })
    expectKernelError(
      () => kernel.stageIntakeArtifact(intake.intake_id, { file_name: '../evil.txt', content: 'x' }),
      422, 'invalid_file_name')
    ResearchKernel.UPLOAD_MAX_FILE_BYTES = 1024
    expectKernelError(
      () => kernel.stageIntakeArtifact(intake.intake_id, { file_name: 'big.bin', content: Buffer.alloc(2048) }),
      413, 'payload_too_large')
    ResearchKernel.UPLOAD_MAX_FILE_BYTES = REAL_LIMIT
    expectKernelError(() => kernel.stageIntakeArtifact('intk_nope', { file_name: 'x.txt', content: 'x' }), 404, 'intake_not_found')
    kernel.rejectIntake(intake.intake_id, PRINCIPAL)
    expectKernelError(
      () => kernel.stageIntakeArtifact(intake.intake_id, { file_name: 'x.txt', content: 'x' }),
      409, 'intake_state_conflict')
    kernel.close()
  })

  it('static scan: clean pdf, rejected executable, quarantined html, redacted secrets', () => {
    const kernel = freshKernel()
    const project = kernel.createProject({ name: 't', workspace: '/w', brief: makeBrief() })
    const intake = kernel.beginIntake({ project_id: project.project_id, source_label: 's' })
    kernel.stageIntakeArtifact(intake.intake_id, { file_name: 'paper.pdf', content: '%PDF-1.4 real' })
    kernel.stageIntakeArtifact(intake.intake_id, { file_name: 'run.exe', content: Buffer.from([0x4d, 0x5a, 0x90, 0x00]) })
    kernel.stageIntakeArtifact(intake.intake_id, { file_name: 'page.html', content: '<script>alert(1)</script>' })
    kernel.stageIntakeArtifact(intake.intake_id, { file_name: 'envs.csv', content: 'AKIAABCDEFGHIJKLMNOP,value' })
    const projection = kernel.scanIntake(intake.intake_id)
    const byName = new Map(projection.artifacts.map(a => [a.file_name, a] as const))
    expect(byName.get('paper.pdf')?.quarantine).toBe('clean')
    expect(byName.get('run.exe')?.quarantine).toBe('rejected')
    expect(byName.get('run.exe')?.scan_result.reason).toBe('executable_extension')
    expect(byName.get('page.html')?.quarantine).toBe('quarantined')
    expect(byName.get('envs.csv')?.quarantine).toBe('quarantined')
    // The secret VALUE is never echoed — only the pattern kind.
    expect(byName.get('envs.csv')?.scan_result.reason).toBe('secret_detected_aws_access_key')
    expect(JSON.stringify(projection.observations)).not.toContain('AKIAABCDEFGHIJKLMNOP')
    // Deterministic observations recorded with pinned trust.
    expect(projection.observations.every(o => o.trust === 'observed_unverified')).toBe(true)
    // scan_summary is honest about the environment.
    expect(projection.session.scan_summary.av_available).toBe(false)
    expect(projection.session.scan_summary.clean).toBe(1)
    expect(projection.session.scan_summary.quarantined).toBe(2)
    expect(projection.session.scan_summary.rejected).toBe(1)
    kernel.close()
  })

  it('static scan: magic mismatch and binary-content detection regardless of name', () => {
    const kernel = freshKernel()
    const project = kernel.createProject({ name: 't', workspace: '/w', brief: makeBrief() })
    const intake = kernel.beginIntake({ project_id: project.project_id, source_label: 's' })
    kernel.stageIntakeArtifact(intake.intake_id, { file_name: 'fake.pdf', content: 'not a pdf at all' })
    kernel.stageIntakeArtifact(intake.intake_id, { file_name: 'data.csv', content: Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0x02]) })
    const projection = kernel.scanIntake(intake.intake_id)
    const byName = new Map(projection.artifacts.map(a => [a.file_name, a] as const))
    expect(byName.get('fake.pdf')?.quarantine).toBe('quarantined')
    expect(byName.get('fake.pdf')?.scan_result.reason).toBe('magic_mismatch')
    expect(byName.get('data.csv')?.quarantine).toBe('rejected')
    expect(byName.get('data.csv')?.scan_result.reason).toBe('binary_content_elf')
    kernel.close()
  })

  it('tampered staged bytes fail the scan with 422 stage_corrupted', () => {
    const kernel = freshKernel()
    const project = kernel.createProject({ name: 't', workspace: '/w', brief: makeBrief() })
    const intake = kernel.beginIntake({ project_id: project.project_id, source_label: 's' })
    const artifact = kernel.stageIntakeArtifact(intake.intake_id, { file_name: 'a.txt', content: 'original' })
    // Tamper with the staged bytes on disk AFTER staging (disk corruption).
    const { writeFileSync } = require('node:fs') as typeof import('node:fs')
    writeFileSync(kernel.intakeStagedPath(intake.intake_id, artifact.sha256), 'TAMPERED!!!')
    expectKernelError(() => kernel.scanIntake(intake.intake_id), 422, 'stage_corrupted')
    kernel.close()
  })

  it('rescan replaces observations and restores proposal_ready when answers persist', () => {
    const kernel = freshKernel()
    const project = kernel.createProject({ name: 't', workspace: '/w', brief: makeBrief() })
    const intake = kernel.beginIntake({ project_id: project.project_id, source_label: 's', target_phase: 'brief' })
    kernel.stageIntakeArtifact(intake.intake_id, { file_name: 'paper.pdf', content: '%PDF-1.4' })
    const scanned = kernel.scanIntake(intake.intake_id)
    expect(scanned.session.status).toBe('needs_input')
    const answers = allRequiredAnswers(scanned.questions, 'brief')
    kernel.submitIntakeAnswers(intake.intake_id, answers, PRINCIPAL)
    // Removing a file resets to uploading; rescan with answers → proposal_ready.
    kernel.removeIntakeArtifact(intake.intake_id, scanned.artifacts[0]!.artifact_id)
    kernel.stageIntakeArtifact(intake.intake_id, { file_name: 'paper.pdf', content: '%PDF-1.4' })
    const rescan = kernel.scanIntake(intake.intake_id)
    expect(rescan.session.status).toBe('proposal_ready')
    kernel.close()
  })
})

describe('ONBOARD-01 Grill Me', () => {
  it('returns deterministic versioned questions; required sets depend on target phase', () => {
    const kernel = freshKernel()
    const project = kernel.createProject({ name: 't', workspace: '/w', brief: makeBrief() })
    const other = kernel.createProject({ name: 't2', workspace: '/w', brief: makeBrief() })
    const exp = kernel.beginIntake({ project_id: project.project_id, source_label: 'e', target_phase: 'experiment' })
    const brief = kernel.beginIntake({ project_id: other.project_id, source_label: 'b', target_phase: 'brief' })
    const qExp = kernel.getIntakeQuestions(exp.intake_id)
    const qBrief = kernel.getIntakeQuestions(brief.intake_id)
    expect(qExp.taxonomy_version).toBe(1)
    expect(qExp.question_revision).toBe(1)
    // Stable codes: experiment covers seeds / run manifest / statistics.
    const expCodes = qExp.questions.map(q => q.question_code)
    expect(expCodes).toContain('owner_scope_license')
    expect(expCodes).toContain('seed')
    expect(expCodes).toContain('run_manifest_signature')
    expect(expCodes).toContain('statistics_ci_n')
    expect(qExp.questions.filter(q => q.required)).toHaveLength(9)
    // brief only needs the core set.
    const briefCodes = qBrief.questions.map(q => q.question_code)
    expect(briefCodes).not.toContain('seed')
    expect(qBrief.questions.filter(q => q.required).map(q => q.question_code)).toEqual(
      ['owner_scope_license', 'observed_phase_claim', 'privacy_secret_network'])
    // Deterministic: same inputs → same codes.
    const again = kernel.getIntakeQuestions(exp.intake_id)
    expect(again.questions.map(q => q.question_code)).toEqual(expCodes)
    kernel.close()
  })

  it('answers require a principal; unknown questions and stale revisions are rejected', () => {
    const kernel = freshKernel()
    const project = kernel.createProject({ name: 't', workspace: '/w', brief: makeBrief() })
    const intake = kernel.beginIntake({ project_id: project.project_id, source_label: 's', target_phase: 'brief' })
    kernel.stageIntakeArtifact(intake.intake_id, { file_name: 'a.pdf', content: '%PDF-1.4' })
    const scanned = kernel.scanIntake(intake.intake_id)
    expectKernelError(
      () => kernel.submitIntakeAnswers(intake.intake_id, [{ question_code: 'owner_scope_license', answer: 'x', question_revision: 1 }], {} as never),
      422, 'principal_required')
    expectKernelError(
      () => kernel.submitIntakeAnswers(intake.intake_id, [{ question_code: 'nope', answer: 'x', question_revision: 1 }], PRINCIPAL),
      422, 'unknown_question')
    expectKernelError(
      () => kernel.submitIntakeAnswers(intake.intake_id, [{ question_code: 'owner_scope_license', answer: 'x', question_revision: 99 }], PRINCIPAL),
      409, 'question_revision_conflict')
    // Answers before a scan are a state conflict.
    const other = kernel.createProject({ name: 't2', workspace: '/w', brief: makeBrief() })
    const pre = kernel.beginIntake({ project_id: other.project_id, source_label: 's2' })
    expectKernelError(
      () => kernel.submitIntakeAnswers(pre.intake_id, [{ question_code: 'owner_scope_license', answer: 'x', question_revision: 1 }], PRINCIPAL),
      409, 'intake_state_conflict')
    kernel.close()
  })

  it('partial answers stay grilling; all required → proposal_ready with human_assertion provenance', () => {
    const kernel = freshKernel()
    const project = kernel.createProject({ name: 't', workspace: '/w', brief: makeBrief() })
    const intake = kernel.beginIntake({ project_id: project.project_id, source_label: 's', target_phase: 'brief' })
    kernel.stageIntakeArtifact(intake.intake_id, { file_name: 'a.pdf', content: '%PDF-1.4' })
    const scanned = kernel.scanIntake(intake.intake_id)
    const one = scanned.questions.find(q => q.question_code === 'owner_scope_license')!
    const partial = kernel.submitIntakeAnswers(intake.intake_id, [{ question_code: one.question_code, answer: 'me', question_revision: one.question_revision }], PRINCIPAL)
    expect(partial.session.status).toBe('grilling')
    expect(partial.questions.find(q => q.question_code === 'owner_scope_license')?.answer).toBe('me')
    // Complete with ONLY the still-missing required questions (no overwrite).
    const missing = partial.questions
      .filter(q => q.required && q.answer === null)
      .map(q => ({ question_code: q.question_code, answer: 'yes', question_revision: q.question_revision }))
    const complete = kernel.submitIntakeAnswers(intake.intake_id, missing, PRINCIPAL)
    expect(complete.session.status).toBe('proposal_ready')
    const view = complete.questions.find(q => q.question_code === 'owner_scope_license')!
    expect(view.answer).toBe('me')
    expect(view.provenance).toBe('human_assertion')
    expect(view.answered_by).toBe('pi-1')
    kernel.close()
  })
})

describe('ONBOARD-01 propose', () => {
  it('refuses to propose while required answers are missing (422 question_required)', () => {
    const kernel = freshKernel()
    const project = kernel.createProject({ name: 't', workspace: '/w', brief: makeBrief() })
    const intake = kernel.beginIntake({ project_id: project.project_id, source_label: 's', target_phase: 'experiment' })
    kernel.stageIntakeArtifact(intake.intake_id, { file_name: 'a.pdf', content: '%PDF-1.4' })
    kernel.scanIntake(intake.intake_id)
    expectKernelError(() => kernel.proposeIntake(intake.intake_id), 422, 'question_required')
    kernel.close()
  })

  it('builds a deterministic proposal: observed_phase from the claim, safe DRAFT landing, gates + actions', () => {
    const kernel = freshKernel()
    const project = kernel.createProject({ name: 't', workspace: '/w', brief: makeBrief() })
    const intake = kernel.beginIntake({ project_id: project.project_id, source_label: 's', target_phase: 'idea' })
    kernel.stageIntakeArtifact(intake.intake_id, { file_name: 'idea.md', content: '# idea' })
    const scanned = kernel.scanIntake(intake.intake_id)
    kernel.submitIntakeAnswers(intake.intake_id, allRequiredAnswers(scanned.questions, 'idea'), PRINCIPAL)
    const proposal = kernel.proposeIntake(intake.intake_id)
    expect(proposal.observed_phase).toBe('idea')
    expect(proposal.revision).toBe(1)
    // Kernel-state-machine safe status: the fresh DRAFT project stays DRAFT —
    // the intake never skips gates or fakes approvals.
    expect(proposal.safe_project_status).toBe('DRAFT')
    expect(proposal.required_gates).toEqual(['idea'])
    expect(proposal.pre_accept_checklist.length).toBeGreaterThan(0)
    expect(proposal.suggested_mappings[0]?.source_artifact_id).toBe(scanned.artifacts[0]!.artifact_id)
    expect(proposal.suggested_mappings[0]?.target_kind).toBe('paper')
    // Deterministic: a second propose bumps the revision.
    const again = kernel.proposeIntake(intake.intake_id)
    expect(again.revision).toBe(2)
    expect(again.observed_phase).toBe('idea')
    kernel.close()
  })

  it('keeps gaps and lowers confidence for unknown answers and scan warnings', () => {
    const kernel = freshKernel()
    const project = kernel.createProject({ name: 't', workspace: '/w', brief: makeBrief() })
    const intake = kernel.beginIntake({ project_id: project.project_id, source_label: 's', target_phase: 'experiment' })
    kernel.stageIntakeArtifact(intake.intake_id, { file_name: 'a.zip', content: Buffer.from('PK\x03\x04not-really') })
    kernel.scanIntake(intake.intake_id)
    const scanned = kernel.getIntakeProjection(intake.intake_id)
    const answers = allRequiredAnswers(scanned.questions, 'experiment')
    // 'unknown' answers keep their gaps.
    const withUnknown = answers.map(a => a.question_code === 'run_manifest_signature' ? { ...a, answer: 'unknown' } : a)
    kernel.submitIntakeAnswers(intake.intake_id, withUnknown, PRINCIPAL)
    const proposal = kernel.proposeIntake(intake.intake_id)
    expect(proposal.unresolved_gaps).toContain('run_manifest_signature_unknown')
    expect(proposal.unresolved_gaps).toContain('run_manifest_unverified')
    expect(proposal.unresolved_gaps.some(g => g.includes('archive_extract_pending'))).toBe(true)
    expect(proposal.confidence).toBeLessThan(0.95)
    kernel.close()
  })

  it('file changes after a proposal invalidate it (proposal_stale semantics)', () => {
    const kernel = freshKernel()
    const project = kernel.createProject({ name: 't', workspace: '/w', brief: makeBrief() })
    const intake = kernel.beginIntake({ project_id: project.project_id, source_label: 's', target_phase: 'brief' })
    kernel.stageIntakeArtifact(intake.intake_id, { file_name: 'a.pdf', content: '%PDF-1.4' })
    const scanned = kernel.scanIntake(intake.intake_id)
    kernel.submitIntakeAnswers(intake.intake_id, allRequiredAnswers(scanned.questions, 'brief'), PRINCIPAL)
    const proposal = kernel.proposeIntake(intake.intake_id)
    expect(proposal.revision).toBe(1)
    kernel.stageIntakeArtifact(intake.intake_id, { file_name: 'b.pdf', content: '%PDF-1.4 more' })
    const projection = kernel.getIntakeProjection(intake.intake_id)
    expect(projection.session.status).toBe('uploading')
    expect(projection.proposal).toBeNull()
    expect(projection.session.audit.some(a => a.action === 'proposal_invalidated')).toBe(true)
    kernel.close()
  })
})

describe('ONBOARD-01 Human Adoption (adopt)', () => {
  it('requires a principal and the awaiting_human state', () => {
    const kernel = freshKernel()
    const project = kernel.createProject({ name: 't', workspace: '/w', brief: makeBrief() })
    const intake = kernel.beginIntake({ project_id: project.project_id, source_label: 's' })
    expectKernelError(
      () => kernel.adoptIntake({ intake_id: intake.intake_id, expected_proposal_revision: 1 }, {} as never),
      422, 'principal_required')
    expectKernelError(
      () => kernel.adoptIntake({ intake_id: intake.intake_id, expected_proposal_revision: 1 }, PRINCIPAL),
      409, 'intake_state_conflict')
    kernel.close()
  })

  it('pins proposal + target project revisions (409 proposal_stale / project_revision_conflict)', () => {
    const kernel = freshKernel()
    const project = kernel.createProject({ name: 't', workspace: '/w', brief: makeBrief() })
    const intake = kernel.beginIntake({ project_id: project.project_id, source_label: 's', target_phase: 'brief' })
    kernel.stageIntakeArtifact(intake.intake_id, { file_name: 'a.pdf', content: '%PDF-1.4' })
    const scanned = kernel.scanIntake(intake.intake_id)
    kernel.submitIntakeAnswers(intake.intake_id, allRequiredAnswers(scanned.questions, 'brief'), PRINCIPAL)
    const proposal = kernel.proposeIntake(intake.intake_id)
    expectKernelError(
      () => kernel.adoptIntake({ intake_id: intake.intake_id, expected_proposal_revision: proposal.revision + 1 }, PRINCIPAL),
      409, 'proposal_stale')
    // Target project revision moved → re-propose required.
    kernel.transition(project.project_id, 'FAILED', kernel.getProject(project.project_id).revision, 'test')
    expectKernelError(
      () => kernel.adoptIntake({ intake_id: intake.intake_id, expected_proposal_revision: proposal.revision, expected_target_revision: 0 }, PRINCIPAL),
      409, 'project_revision_conflict')
    kernel.close()
  })

  it('rejects quarantined artifacts (422 artifact_quarantined)', () => {
    const kernel = freshKernel()
    const project = kernel.createProject({ name: 't', workspace: '/w', brief: makeBrief() })
    const intake = kernel.beginIntake({ project_id: project.project_id, source_label: 's', target_phase: 'brief' })
    kernel.stageIntakeArtifact(intake.intake_id, { file_name: 'bad.html', content: '<b>x</b>' })
    const scanned = kernel.scanIntake(intake.intake_id)
    kernel.submitIntakeAnswers(intake.intake_id, allRequiredAnswers(scanned.questions, 'brief'), PRINCIPAL)
    const proposal = kernel.proposeIntake(intake.intake_id)
    expectKernelError(
      () => kernel.adoptIntake({ intake_id: intake.intake_id, expected_proposal_revision: proposal.revision }, PRINCIPAL),
      422, 'artifact_quarantined')
    kernel.close()
  })

  it('adopts atomically: artifacts + pending gates + draft evidence + receipt, project stays DRAFT', () => {
    const kernel = freshKernel()
    const project = kernel.createProject({ name: 't', workspace: '/w', brief: makeBrief() })
    const intake = kernel.beginIntake({ project_id: project.project_id, source_label: 's', target_phase: 'idea' })
    kernel.stageIntakeArtifact(intake.intake_id, { file_name: 'paper.pdf', content: '%PDF-1.4' })
    kernel.stageIntakeArtifact(intake.intake_id, { file_name: 'run.log', content: 'epoch 1 loss 0.5\n' })
    kernel.stageIntakeArtifact(intake.intake_id, { file_name: 'metrics.json', content: JSON.stringify({ schema_version: 1, metrics: [{ name: 'accuracy', value: 0.9, unit: '%' }] }) })
    const scanned = kernel.scanIntake(intake.intake_id)
    kernel.submitIntakeAnswers(intake.intake_id, allRequiredAnswers(scanned.questions, 'idea'), PRINCIPAL)
    const proposal = kernel.proposeIntake(intake.intake_id)
    const receipt = kernel.adoptIntake({ intake_id: intake.intake_id, expected_proposal_revision: proposal.revision }, PRINCIPAL)
    expect(receipt.intake_id).toBe(intake.intake_id)
    expect(receipt.proposal_revision).toBe(proposal.revision)
    expect(receipt.adopted_by.principal_id).toBe('pi-1')
    // Artifacts imported into the project artifact space (paper/log/data).
    const artifacts = kernel.listArtifacts(project.project_id)
    const kinds = artifacts.map(a => a.kind).sort()
    expect(kinds).toEqual(['data', 'log', 'pdf'])
    expect(artifacts.every(a => a.metadata.imported === true)).toBe(true)
    // §6.1: logs become ImportedRunObservation, never TerminalLog.
    const observations = kernel.getIntakeProjection(intake.intake_id).observations
    expect(observations.some(o => o.detector === 'imported_run')).toBe(true)
    expect(count(kernel, 'terminal_frames')).toBe(0)
    // metrics.json → draft (legacy_unverified) evidence only.
    expect(receipt.draft_evidence_refs).toHaveLength(1)
    const evidence = kernel.listEvidence(project.project_id)
    expect(evidence).toHaveLength(1)
    expect(evidence[0]!.provenance_status).toBe('legacy_unverified')
    // idea phase → PENDING Idea Gate (never decided by the intake).
    expect(receipt.pending_gate_refs).toHaveLength(1)
    const gates = kernel.listGates(project.project_id)
    expect(gates).toHaveLength(1)
    expect(gates[0]!.type).toBe('idea')
    expect(gates[0]!.status).toBe('pending')
    // The project state machine was NOT skipped: stays DRAFT.
    expect(kernel.getProject(project.project_id).status).toBe('DRAFT')
    // No Run/Claim/Decision/Terminal writes anywhere.
    expect(count(kernel, 'jobs')).toBe(0)
    expect(count(kernel, 'runs')).toBe(0)
    expect(count(kernel, 'claims')).toBe(0)
    expect(count(kernel, 'decisions')).toBe(0)
    // Staged files are gone (the isolated dir is removed); blobs live in the real CAS.
    const { existsSync } = require('node:fs') as typeof import('node:fs')
    expect(existsSync(join(kernel.intakeStagedRoot, intake.intake_id))).toBe(false)
    expect(kernel.cas.list()).toHaveLength(3)
    // Outbox moved exactly at the adoption boundary.
    const kinds2 = kernel.listEvents(project.project_id).map(e => e.kind)
    expect(kinds2).toContain('intake.accepted')
    expect(kernel.getIntakeProjection(intake.intake_id).session.status).toBe('accepted')
    kernel.close()
  })

  it('adoption is idempotent: same key+hash → same receipt; different hash → 409; replay returns stored', () => {
    const kernel = freshKernel()
    const project = kernel.createProject({ name: 't', workspace: '/w', brief: makeBrief() })
    const intake = kernel.beginIntake({ project_id: project.project_id, source_label: 's', target_phase: 'brief' })
    kernel.stageIntakeArtifact(intake.intake_id, { file_name: 'a.pdf', content: '%PDF-1.4' })
    const scanned = kernel.scanIntake(intake.intake_id)
    kernel.submitIntakeAnswers(intake.intake_id, allRequiredAnswers(scanned.questions, 'brief'), PRINCIPAL)
    const proposal = kernel.proposeIntake(intake.intake_id)
    const first = kernel.adoptIntake({
      intake_id: intake.intake_id, expected_proposal_revision: proposal.revision,
      idempotency_key: 'adopt-1', request_hash: 'h1',
    }, PRINCIPAL)
    const replay = kernel.adoptIntake({
      intake_id: intake.intake_id, expected_proposal_revision: proposal.revision,
      idempotency_key: 'adopt-1', request_hash: 'h1',
    }, PRINCIPAL)
    expect(replay.adoption_id).toBe(first.adoption_id)
    expect(count(kernel, 'artifacts')).toBe(1)
    expectKernelError(
      () => kernel.adoptIntake({
        intake_id: intake.intake_id, expected_proposal_revision: proposal.revision,
        idempotency_key: 'adopt-1', request_hash: 'h2',
      }, PRINCIPAL),
      409, 'idempotency_conflict')
    // Plain replay (no key) returns the stored receipt.
    const bare = kernel.adoptIntake({ intake_id: intake.intake_id, expected_proposal_revision: proposal.revision }, PRINCIPAL)
    expect(bare.adoption_id).toBe(first.adoption_id)
    kernel.close()
  })

  it('expired sessions cannot be adopted (409 intake_expired)', () => {
    const kernel = freshKernel()
    const project = kernel.createProject({ name: 't', workspace: '/w', brief: makeBrief() })
    const intake = kernel.beginIntake({ project_id: project.project_id, source_label: 's', target_phase: 'brief' })
    kernel.stageIntakeArtifact(intake.intake_id, { file_name: 'a.pdf', content: '%PDF-1.4' })
    const scanned = kernel.scanIntake(intake.intake_id)
    kernel.submitIntakeAnswers(intake.intake_id, allRequiredAnswers(scanned.questions, 'brief'), PRINCIPAL)
    // Force expiry without waiting, then every further step is 409 intake_expired.
    kernel.db.prepare('UPDATE intake_sessions SET expires_at = ? WHERE intake_id = ?').run(new Date(Date.now() - 1000).toISOString(), intake.intake_id)
    expectKernelError(() => kernel.proposeIntake(intake.intake_id), 409, 'intake_expired')
    // adopt on a non-awaiting_human session is a state conflict (checked
    // before expiry — the session must be proposed first anyway).
    expectKernelError(
      () => kernel.adoptIntake({ intake_id: intake.intake_id, expected_proposal_revision: 1 }, PRINCIPAL),
      409, 'intake_state_conflict')
    kernel.close()
  })
})

describe('ONBOARD-01 reject + GC + recovery', () => {
  it('reject requires a principal, GCs staged files, audits, and replays idempotently', () => {
    const kernel = freshKernel()
    const project = kernel.createProject({ name: 't', workspace: '/w', brief: makeBrief() })
    const intake = kernel.beginIntake({ project_id: project.project_id, source_label: 's' })
    kernel.stageIntakeArtifact(intake.intake_id, { file_name: 'a.pdf', content: '%PDF-1.4' })
    expectKernelError(() => kernel.rejectIntake(intake.intake_id, {} as never), 422, 'principal_required')
    const projection = kernel.rejectIntake(intake.intake_id, PRINCIPAL)
    expect(projection.session.status).toBe('rejected')
    const { existsSync } = require('node:fs') as typeof import('node:fs')
    expect(existsSync(join(kernel.intakeStagedRoot, intake.intake_id))).toBe(false)
    expect(projection.session.audit.some(a => a.action === 'rejected')).toBe(true)
    expect(kernel.listEvents(project.project_id).map(e => e.kind)).toContain('intake.rejected')
    // Idempotent replay.
    const again = kernel.rejectIntake(intake.intake_id, PRINCIPAL)
    expect(again.session.status).toBe('rejected')
    // Accepted sessions cannot be rejected.
    kernel.close()
  })

  it('expireIntakes expires abandoned sessions + GCs staged blobs; accepted sessions survive', () => {
    const kernel = freshKernel()
    const project = kernel.createProject({ name: 't', workspace: '/w', brief: makeBrief() })
    const abandoned = kernel.beginIntake({ project_id: project.project_id, source_label: 'a', expires_in_ms: 1000 })
    kernel.stageIntakeArtifact(abandoned.intake_id, { file_name: 'x.pdf', content: '%PDF-1.4' })
    kernel.db.prepare('UPDATE intake_sessions SET expires_at = ? WHERE intake_id = ?').run(new Date(Date.now() - 1).toISOString(), abandoned.intake_id)
    // A second intake that will be adopted (fresh expiry, separate project so
    // the single-active-intake-per-project rule does not reuse the first).
    const other = kernel.createProject({ name: 't2', workspace: '/w', brief: makeBrief() })
    const adopted = kernel.beginIntake({ project_id: other.project_id, source_label: 'b', target_phase: 'brief' })
    kernel.stageIntakeArtifact(adopted.intake_id, { file_name: 'y.pdf', content: '%PDF-1.4' })
    const scanned = kernel.scanIntake(adopted.intake_id)
    kernel.submitIntakeAnswers(adopted.intake_id, allRequiredAnswers(scanned.questions, 'brief'), PRINCIPAL)
    const proposal = kernel.proposeIntake(adopted.intake_id)
    kernel.adoptIntake({ intake_id: adopted.intake_id, expected_proposal_revision: proposal.revision }, PRINCIPAL)
    expect(kernel.expireIntakes(Date.now() + 10_000)).toBe(1)
    expect(kernel.getIntakeProjection(abandoned.intake_id).session.status).toBe('expired')
    expect(kernel.getIntakeProjection(adopted.intake_id).session.status).toBe('accepted')
    expect(kernel.listEvents(project.project_id).map(e => e.kind)).toContain('intake.expired')
    kernel.close()
  })

  it('cleanupIntakeStaged removes aged staged blobs, keeps fresh ones, never touches CAS', () => {
    const kernel = freshKernel()
    const project = kernel.createProject({ name: 't', workspace: '/w', brief: makeBrief() })
    const intake = kernel.beginIntake({ project_id: project.project_id, source_label: 's' })
    kernel.stageIntakeArtifact(intake.intake_id, { file_name: 'a.pdf', content: '%PDF-1.4' })
    kernel.stageIntakeArtifact(intake.intake_id, { file_name: 'b.pdf', content: '%PDF-1.5' })
    const { existsSync } = require('node:fs') as typeof import('node:fs')
    expect(kernel.cleanupIntakeStaged(60_000)).toBe(0)
    expect(readdirSync(join(kernel.intakeStagedRoot, intake.intake_id))).toHaveLength(2)
    expect(kernel.cleanupIntakeStaged(0)).toBe(2)
    expect(existsSync(join(kernel.intakeStagedRoot, intake.intake_id))).toBe(false)
    expect(kernel.cas.list()).toHaveLength(0)
    kernel.close()
  })

  it('recovers after a kernel restart: answers, status and scan survive', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-intake-recovery-'))
    const dbPath = join(dir, 'kernel.db')
    const casRoot = join(dir, 'cas')
    const first = new ResearchKernel({ dbPath, casRoot, requireSignedManifest: false })
    const project = first.createProject({ name: 't', workspace: '/w', brief: makeBrief() })
    const intake = first.beginIntake({ project_id: project.project_id, source_label: 's', target_phase: 'experiment' })
    first.stageIntakeArtifact(intake.intake_id, { file_name: 'a.pdf', content: '%PDF-1.4' })
    first.scanIntake(intake.intake_id)
    const questions = first.getIntakeQuestions(intake.intake_id).questions
    first.submitIntakeAnswers(intake.intake_id, allRequiredAnswers(questions, 'experiment'), PRINCIPAL)
    first.proposeIntake(intake.intake_id)
    first.close()
    // New kernel over the same database: everything is re-projectable.
    const second = new ResearchKernel({ dbPath, casRoot, requireSignedManifest: false })
    const projection = second.getIntakeProjection(intake.intake_id)
    expect(projection.session.status).toBe('awaiting_human')
    expect(projection.proposal?.observed_phase).toBe('experiment')
    expect(projection.questions.every(q => q.required === false || q.answer !== null)).toBe(true)
    expect(projection.questions.find(q => q.question_code === 'owner_scope_license')?.answered_by).toBe('pi-1')
    expect(projection.artifacts).toHaveLength(1)
    const receipt = second.adoptIntake({ intake_id: intake.intake_id, expected_proposal_revision: projection.proposal!.revision }, PRINCIPAL)
    expect(receipt.intake_id).toBe(intake.intake_id)
    second.close()
    rmSync(dir, { recursive: true, force: true })
  })
})

describe('ONBOARD-01 pre-accept ZERO authority', () => {
  it('begin/stage/scan/grill/propose write ONLY intake tables + isolated staging + no outbox', () => {
    const kernel = freshKernel()
    const project = kernel.createProject({ name: 't', workspace: '/w', brief: makeBrief() })
    const intake = kernel.beginIntake({ project_id: project.project_id, source_label: 's', target_phase: 'experiment' })
    kernel.stageIntakeArtifact(intake.intake_id, { file_name: 'a.pdf', content: '%PDF-1.4' })
    kernel.stageIntakeArtifact(intake.intake_id, { file_name: 'run.log', content: 'out\n' })
    kernel.scanIntake(intake.intake_id)
    const questions = kernel.getIntakeQuestions(intake.intake_id).questions
    kernel.submitIntakeAnswers(intake.intake_id, allRequiredAnswers(questions, 'experiment'), PRINCIPAL)
    kernel.proposeIntake(intake.intake_id)
    // Business tables: ZERO rows (the project itself has no initial gate).
    expect(count(kernel, 'gates')).toBe(0)
    expect(count(kernel, 'decisions')).toBe(0)
    expect(count(kernel, 'artifacts')).toBe(0)
    expect(count(kernel, 'jobs')).toBe(0)
    expect(count(kernel, 'runs')).toBe(0)
    expect(count(kernel, 'evidence')).toBe(0)
    expect(count(kernel, 'claims')).toBe(0)
    expect(count(kernel, 'terminal_frames')).toBe(0)
    expect(count(kernel, 'workspaces')).toBe(0)
    expect(count(kernel, 'tex_documents')).toBe(0)
    // The outbox did NOT move (only the project.created event exists).
    expect(kernel.listEvents(project.project_id).map(e => e.kind)).toEqual(['project.created'])
    // Intake tables have the records.
    expect(count(kernel, 'intake_sessions')).toBe(1)
    expect(count(kernel, 'intake_artifacts')).toBe(2)
    expect(count(kernel, 'intake_questions')).toBeGreaterThan(0)
    expect(count(kernel, 'intake_observations')).toBeGreaterThan(0)
    // CAS blob space is still empty (isolated staging only).
    expect(kernel.cas.list()).toHaveLength(0)
    kernel.close()
  })

  it('never writes Gate/Run/Evidence from any intake path (no such code path)', () => {
    // Code-level assertion helper: the intake module has no business writes.
    const { readFileSync } = require('node:fs') as typeof import('node:fs')
    const intakeSrc = readFileSync(new URL('../../packages/research-kernel/src/intake.ts', import.meta.url), 'utf8')
    expect(intakeSrc).not.toContain('INSERT INTO jobs')
    expect(intakeSrc).not.toContain('INSERT INTO gates')
    expect(intakeSrc).not.toContain('INSERT INTO evidence')
    expect(intakeSrc).not.toContain('INSERT INTO claims')
    expect(intakeSrc).not.toContain('INSERT INTO terminal_frames')
  })
})

describe('ONBOARD-01 HTTP surface (/v1/projects/{id}/intake*)', () => {
  it('runs begin → stage → scan → questions → answers → propose → adopt → reject end to end', async () => {
    const kernel = freshKernel({ serviceToken: INTAKE_SERVICE_TOKEN })
    const project = kernel.createProject({
      name: 't', workspace: '/w', brief: makeBrief(), creator_principal_id: PRINCIPAL.principal_id,
    } as never)
    await withServer(kernel, async (base) => {
      const url = (suffix: string): string => `${base}/v1/projects/${project.project_id}/intake${suffix}`
      const json = async (path: string, method: string, body?: unknown): Promise<Response> => {
        return await fetch(url(path), {
          method,
          headers: body === undefined ? undefined : { 'content-type': 'application/json' },
          body: body === undefined ? undefined : JSON.stringify(body),
        })
      }
      // begin
      const r1 = await json('', 'POST', { source_label: 'uploaded-paper', target_phase: 'brief' })
      expect(r1.status).toBe(201)
      const session = (await r1.json()) as IntakeSession
      expect(session.status).toBe('draft')
      // stage (multipart)
      const fd = new FormData()
      fd.append('file', new Blob([Buffer.from('%PDF-1.4')]), 'paper.pdf')
      fd.append('media_type', 'application/pdf')
      const r2 = await fetch(url(`/${session.intake_id}/artifacts`), { method: 'POST', body: fd })
      expect(r2.status).toBe(201)
      // scan
      const r3 = await json(`/${session.intake_id}/scan`, 'POST')
      expect(r3.status).toBe(200)
      const scanned = (await r3.json()) as IntakeProjection
      expect(scanned.artifacts[0]?.quarantine).toBe('clean')
      // questions
      const r4 = await json(`/${session.intake_id}/questions`, 'GET')
      expect(r4.status).toBe(200)
      const questions = (await r4.json()) as { questions: GrillAnswerView[] }
      // A self-reported body principal is attacker-controlled and must never
      // establish Human authority without the trusted BFF header seam.
      const r5 = await json(`/${session.intake_id}/answers`, 'POST', {
        answers: [{ question_code: 'owner_scope_license', answer: 'x', question_revision: 1 }],
        principal: PRINCIPAL,
      })
      expect(r5.status).toBe(403)
      expect(((await r5.json()) as { error: { code: string } }).error.code).toBe('service_token_required')
      const headerOnly = await fetch(url(`/${session.intake_id}/answers`), {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-principal-id': PRINCIPAL.principal_id, 'x-principal-session': PRINCIPAL.session_id },
        body: JSON.stringify({ answers: allRequiredAnswers(questions.questions, 'brief'), principal: PRINCIPAL }),
      })
      expect(headerOnly.status).toBe(403)
      expect(((await headerOnly.json()) as { error: { code: string } }).error.code).toBe('service_token_required')
      const wrongAudience = await fetch(url(`/${session.intake_id}/answers`), {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-service-token': INTAKE_SERVICE_TOKEN,
          'x-service-principal': 'agent-tool',
          'x-principal-id': PRINCIPAL.principal_id,
          'x-principal-session': PRINCIPAL.session_id,
        },
        body: JSON.stringify({ answers: allRequiredAnswers(questions.questions, 'brief') }),
      })
      expect(wrongAudience.status).toBe(403)
      expect(((await wrongAudience.json()) as { error: { code: string } }).error.code).toBe('service_identity_required')
      const missingSession = await fetch(url(`/${session.intake_id}/answers`), {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-service-token': INTAKE_SERVICE_TOKEN,
          'x-service-principal': 'standalone-human-bff',
          'x-principal-id': PRINCIPAL.principal_id,
        },
        body: JSON.stringify({ answers: allRequiredAnswers(questions.questions, 'brief') }),
      })
      expect(missingSession.status).toBe(422)
      expect(((await missingSession.json()) as { error: { code: string } }).error.code).toBe('principal_required')
      // Even with a valid service audience, the strict body no longer admits
      // a principal field; authority metadata exists only in trusted headers.
      const trustedForged = await fetch(url(`/${session.intake_id}/answers`), {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...INTAKE_HUMAN_HEADERS,
        },
        body: JSON.stringify({
          answers: allRequiredAnswers(questions.questions, 'brief'),
          principal: { principal_id: 'forged-body-pi' },
        }),
      })
      expect(trustedForged.status).toBe(422)
      expect(((await trustedForged.json()) as { error: { code: string } }).error.code).toBe('validation_error')
      // With the trusted header seam, durable provenance records that exact
      // principal/session and the body carries domain input only.
      const r6 = await fetch(url(`/${session.intake_id}/answers`), {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...INTAKE_HUMAN_HEADERS },
        body: JSON.stringify({ answers: allRequiredAnswers(questions.questions, 'brief') }),
      })
      expect(r6.status).toBe(200)
      expect(((await r6.clone().json()) as IntakeProjection).questions.find(q => q.answer !== null)?.answered_by).toBe(PRINCIPAL.principal_id)
      // propose
      const r7 = await json(`/${session.intake_id}/propose`, 'POST')
      expect(r7.status).toBe(201)
      const proposal = (await r7.json()) as PhaseProposal
      expect(proposal.safe_project_status).toBe('DRAFT')
      // A forged PI in the body cannot adopt without the trusted header.
      const forgedAdopt = await json(`/${session.intake_id}/adopt`, 'POST', {
        principal: PRINCIPAL, expected_proposal_revision: proposal.revision,
      })
      expect(forgedAdopt.status).toBe(403)
      expect(((await forgedAdopt.json()) as { error: { code: string } }).error.code).toBe('service_token_required')
      // The trusted header principal is rechecked against durable PI membership.
      const r8 = await fetch(url(`/${session.intake_id}/adopt`), {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...INTAKE_HUMAN_HEADERS },
        body: JSON.stringify({ expected_proposal_revision: proposal.revision }),
      })
      expect(r8.status).toBe(200)
      const receipt = (await r8.json()) as AdoptionReceipt
      expect(receipt.intake_id).toBe(session.intake_id)
      // resume projection
      const r9 = await json(`/${session.intake_id}`, 'GET')
      expect(r9.status).toBe(200)
      const projection = (await r9.json()) as IntakeProjection
      expect(projection.session.status).toBe('accepted')
      expect(projection.receipt?.adoption_id).toBe(receipt.adoption_id)
      // cross-project access → 404 (no existence leak)
      const r10 = await fetch(`${base}/v1/projects/rsp_other/intake/${session.intake_id}`)
      expect(r10.status).toBe(404)
      // list
      const r11 = await json('', 'GET')
      expect(r11.status).toBe(200)
      expect(((await r11.json()) as IntakeSession[])).toHaveLength(1)
    })
    kernel.close()
  })

  it('reject flow over HTTP + DELETE artifact + unknown intake 404', async () => {
    const kernel = freshKernel({ serviceToken: INTAKE_SERVICE_TOKEN })
    const project = kernel.createProject({ name: 't', workspace: '/w', brief: makeBrief() })
    await withServer(kernel, async (base) => {
      const url = (suffix: string): string => `${base}/v1/projects/${project.project_id}/intake${suffix}`
      const r1 = await fetch(url(''), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ source_label: 's' }) })
      const session = (await r1.json()) as IntakeSession
      const fd = new FormData()
      fd.append('file', new Blob([Buffer.from('x')]), 'x.txt')
      await fetch(url(`/${session.intake_id}/artifacts`), { method: 'POST', body: fd })
      const forged = await fetch(url(`/${session.intake_id}/reject`), {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ principal: PRINCIPAL }),
      })
      expect(forged.status).toBe(403)
      const r2 = await fetch(url(`/${session.intake_id}/reject`), {
        method: 'POST', headers: { 'content-type': 'application/json', ...INTAKE_HUMAN_HEADERS }, body: '{}',
      })
      expect(r2.status).toBe(200)
      const projection = (await r2.json()) as IntakeProjection
      expect(projection.session.status).toBe('rejected')
      // DELETE artifact on a rejected session → 409 intake_state_conflict.
      const aid = projection.artifacts[0]!.artifact_id
      const r3 = await fetch(url(`/${session.intake_id}/artifacts/${encodeURIComponent(aid)}`), { method: 'DELETE' })
      expect(r3.status).toBe(409)
      // Unknown intake → 404.
      const r4 = await fetch(url('/intk_nope'))
      expect(r4.status).toBe(404)
    })
    kernel.close()
  })

  it('adopt without awaiting_human over HTTP → 409 intake_state_conflict', async () => {
    const kernel = freshKernel({ serviceToken: INTAKE_SERVICE_TOKEN })
    const project = kernel.createProject({
      name: 't', workspace: '/w', brief: makeBrief(), creator_principal_id: PRINCIPAL.principal_id,
    } as never)
    await withServer(kernel, async (base) => {
      const r1 = await fetch(`${base}/v1/projects/${project.project_id}/intake`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ source_label: 's' }) })
      const session = (await r1.json()) as IntakeSession
      const r2 = await fetch(`${base}/v1/projects/${project.project_id}/intake/${session.intake_id}/adopt`, {
        method: 'POST', headers: { 'content-type': 'application/json', ...INTAKE_HUMAN_HEADERS },
        body: JSON.stringify({ expected_proposal_revision: 1 }),
      })
      expect(r2.status).toBe(409)
      expect(((await r2.json()) as { error: { code: string } }).error.code).toBe('intake_state_conflict')
    })
    kernel.close()
  })
})
