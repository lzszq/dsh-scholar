import { describe, expect, it } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { createStartupBackup, KernelError, ResearchKernel } from '@dsh-scholar/research-kernel'

function fixture(): { kernel: ResearchKernel; dbPath: string; casRoot: string; projectId: string; intakeId: string; sourceId: string } {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-ocr-'))
  const dbPath = join(dir, 'kernel.db')
  const casRoot = join(dir, 'cas')
  const kernel = new ResearchKernel({ dbPath, casRoot, requireSignedManifest: false, providerUrlAllowlist: { hosts: ['mineru.net'] } })
  const projectId = kernel.createProjectForGrill({
    name: 'OCR lifecycle', creator_principal_id: 'pi-1', idempotency_key: `create-${dir}`, request_hash: 'create-v1',
  }).project.project_id
  kernel.registerProvider({
    provider_id: 'mineru', display_name: 'MinerU', kind: 'mineru', base_url: 'https://mineru.net/api/v4',
    enabled: true, capabilities: ['ocr', 'vision'], models: [
      { model_id: 'flash', capabilities: ['ocr'] },
      { model_id: 'pipeline', capabilities: ['ocr'] },
      { model_id: 'vlm', capabilities: ['ocr', 'vision'] },
    ],
  })
  kernel.setProjectModelBinding(projectId, { purpose: 'ocr', provider_id: 'mineru', model_id: 'flash', expected_provider_revision: 1 })
  const intake = kernel.beginIntake({ project_id: projectId, source_label: 'paper', owner: { principal_id: 'pi-1' } })
  const source = kernel.stageIntakeArtifact(intake.intake_id, {
    file_name: 'paper.pdf', media_type: 'application/pdf', content: Buffer.from('%PDF-1.7\nsource'),
  })
  kernel.scanIntake(intake.intake_id)
  return { kernel, dbPath, casRoot, projectId, intakeId: intake.intake_id, sourceId: source.artifact_id }
}

function expectCode(work: () => unknown, code: string): void {
  try {
    work()
    throw new Error('expected KernelError')
  } catch (error) {
    expect(error).toBeInstanceOf(KernelError)
    expect((error as KernelError).code).toBe(code)
  }
}

describe('REVIEW-OCR-03 request lifecycle', () => {
  it('pins the exact clean source, OCR binding, provider revision/hash, pages and language and replays only the same request', () => {
    const { kernel, intakeId, sourceId } = fixture()
    try {
      const input = { source_artifact_id: sourceId, provider_id: 'mineru', model_id: 'flash', pages: [1, 3], language: 'zh-CN' }
      const first = kernel.createOcrRequest(intakeId, input, 'ocr-key-1')
      expect(first).toMatchObject({
        intake_id: intakeId, source_artifact_id: sourceId, source_sha256: sourceId.slice(7),
        provider_id: 'mineru', model_id: 'flash', provider_revision: 1, binding_revision: 1,
        pages: [1, 3], language: 'zh-CN', status: 'queued', result_artifact_id: null, safe_error: null,
      })
      expect(first.provider_config_sha256).toMatch(/^[0-9a-f]{64}$/)
      expect(kernel.createOcrRequest(intakeId, input, 'ocr-key-1')).toEqual(first)
      expect(kernel.getOcrRequest(intakeId, first.request_id)).toEqual(first)
      expectCode(() => kernel.createOcrRequest(intakeId, { ...input, pages: [2] }, 'ocr-key-1'), 'idempotency_conflict')
      kernel.db.prepare('UPDATE intake_sessions SET expires_at = ? WHERE intake_id = ?')
        .run('2000-01-01T00:00:00.000Z', intakeId)
      expect(kernel.createOcrRequest(intakeId, input, 'ocr-key-1')).toEqual(first)
      expectCode(() => kernel.createOcrRequest(intakeId, { ...input, pages: [2] }, 'ocr-key-1'), 'idempotency_conflict')
    } finally { kernel.close() }
  })

  it('cancels without execution and requeues an interrupted running request after restart', () => {
    const f = fixture()
    const input = { source_artifact_id: f.sourceId, provider_id: 'mineru', model_id: 'flash', pages: [], language: 'auto' }
    const cancelled = f.kernel.createOcrRequest(f.intakeId, input, 'ocr-cancel')
    expect(f.kernel.cancelOcrRequest(f.intakeId, cancelled.request_id)).toMatchObject({ status: 'cancelled', attempts: 0 })
    expect(f.kernel.claimNextOcrRequest()).toBeNull()

    const interrupted = f.kernel.createOcrRequest(f.intakeId, input, 'ocr-restart')
    expect(f.kernel.claimNextOcrRequest()).toMatchObject({ request_id: interrupted.request_id, status: 'running', attempts: 1 })
    f.kernel.close()

    const backup = createStartupBackup({ dbPath: f.dbPath, casRoot: f.casRoot, instanceId: 'ocr-backup-test' })
    const snapshot = new DatabaseSync(backup.backup_path, { readOnly: true })
    expect(snapshot.prepare('SELECT status, source_artifact_id, provider_config_sha256 FROM ocr_requests WHERE request_id = ?').get(interrupted.request_id))
      .toMatchObject({ status: 'running', source_artifact_id: f.sourceId, provider_config_sha256: expect.stringMatching(/^[0-9a-f]{64}$/) })
    snapshot.close()

    const reopened = new ResearchKernel({
      dbPath: f.dbPath, casRoot: f.casRoot, requireSignedManifest: false, providerUrlAllowlist: { hosts: ['mineru.net'] },
    })
    try {
      expect(reopened.getOcrRequest(f.intakeId, interrupted.request_id)).toMatchObject({ status: 'queued', attempts: 1, result_artifact_id: null })
      expect(reopened.createOcrRequest(f.intakeId, input, 'ocr-restart')).toMatchObject({ request_id: interrupted.request_id, status: 'queued' })
      expect(reopened.claimNextOcrRequest()).toMatchObject({ request_id: interrupted.request_id, status: 'running', attempts: 2 })
    } finally { reopened.close() }
  })

  it('rejects missing/stale/disabled bindings and never falls back to another model', () => {
    const f = fixture()
    const base = { source_artifact_id: f.sourceId, provider_id: 'mineru', model_id: 'flash', pages: [], language: 'auto' }
    expectCode(() => f.kernel.createOcrRequest(f.intakeId, { ...base, model_id: 'pipeline' }, 'wrong-model'), 'ocr_binding_mismatch')
    f.kernel.updateProvider('mineru', { expected_revision: 1, enabled: false })
    expectCode(() => f.kernel.createOcrRequest(f.intakeId, base, 'disabled-provider'), 'provider_disabled')

    const secondProject = f.kernel.createProjectForGrill({
      name: 'No OCR binding', creator_principal_id: 'pi-1', idempotency_key: `unbound-${f.projectId}`, request_hash: 'unbound-v1',
    }).project.project_id
    const secondIntake = f.kernel.beginIntake({ project_id: secondProject, source_label: 'unbound', owner: { principal_id: 'pi-1' } })
    const secondSource = f.kernel.stageIntakeArtifact(secondIntake.intake_id, {
      file_name: 'scan.png', media_type: 'image/png', content: Buffer.from([0x89, 0x50, 0x4e, 0x47, 7]),
    })
    f.kernel.scanIntake(secondIntake.intake_id)
    expectCode(() => f.kernel.createOcrRequest(secondIntake.intake_id, {
      ...base, source_artifact_id: secondSource.artifact_id,
    }, 'missing-binding'), 'ocr_binding_required')
    f.kernel.close()
  })
})
