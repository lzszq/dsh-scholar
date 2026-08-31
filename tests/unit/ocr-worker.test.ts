import { describe, expect, it, vi } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MinerUOcrWorker, ResearchKernel } from '@dsh-scholar/research-kernel'

function fixture(): { kernel: ResearchKernel; intakeId: string; sourceId: string } {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-ocr-worker-'))
  const kernel = new ResearchKernel({ dbPath: join(dir, 'kernel.db'), casRoot: join(dir, 'cas'), requireSignedManifest: false, providerUrlAllowlist: { hosts: ['mineru.net'] } })
  const projectId = kernel.createProjectForGrill({ name: 'OCR worker', creator_principal_id: 'pi-1', idempotency_key: `p-${dir}`, request_hash: 'p1' }).project.project_id
  kernel.registerProvider({
    provider_id: 'mineru', display_name: 'MinerU', kind: 'mineru', base_url: 'https://mineru.net/api/v4', enabled: true,
    capabilities: ['ocr', 'vision'], models: [
      { model_id: 'flash', capabilities: ['ocr'] }, { model_id: 'pipeline', capabilities: ['ocr'] }, { model_id: 'vlm', capabilities: ['ocr', 'vision'] },
    ],
  })
  kernel.setProjectModelBinding(projectId, { purpose: 'ocr', provider_id: 'mineru', model_id: 'flash' })
  const intake = kernel.beginIntake({ project_id: projectId, source_label: 'scan', owner: { principal_id: 'pi-1' } })
  const source = kernel.stageIntakeArtifact(intake.intake_id, { file_name: 'scan.png', media_type: 'image/png', content: Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]) })
  kernel.scanIntake(intake.intake_id)
  return { kernel, intakeId: intake.intake_id, sourceId: source.artifact_id }
}

describe('REVIEW-OCR-03 MinerU worker port', () => {
  it('normalizes successful output as observed_unverified provenance without writing Human answers, Gates or Evidence', async () => {
    const { kernel, intakeId, sourceId } = fixture()
    const request = kernel.createOcrRequest(intakeId, {
      source_artifact_id: sourceId, provider_id: 'mineru', model_id: 'flash', pages: [2], language: 'zh-CN',
    }, 'ocr-worker-success')
    const before = {
      gates: Number((kernel.db.prepare('SELECT COUNT(*) AS n FROM gates').get() as { n: number }).n),
      evidence: Number((kernel.db.prepare('SELECT COUNT(*) AS n FROM evidence').get() as { n: number }).n),
      answers: Number((kernel.db.prepare('SELECT COUNT(*) AS n FROM intake_questions WHERE answer IS NOT NULL').get() as { n: number }).n),
    }
    const extract = vi.fn().mockResolvedValue({
      markdown: '# 第 2 页\n识别文本',
      observations: [{ page: 2, locator: 'block:1', text: '识别文本', confidence: 0.93 }],
      raw_response: { token: 'must-not-persist', endpoint: 'https://secret.invalid' },
    })
    const completed = await new MinerUOcrWorker(kernel, {
      binding: {
        provider_id: request.provider_id, model_id: request.model_id, provider_revision: request.provider_revision,
        provider_config_sha256: request.provider_config_sha256,
      },
      extract,
    }).runOnce()
    expect(completed).toMatchObject({ request_id: request.request_id, status: 'succeeded', attempts: 1 })
    expect(extract).toHaveBeenCalledWith(expect.objectContaining({
      request: expect.objectContaining({ provider_id: 'mineru', model_id: 'flash', pages: [2], language: 'zh-CN' }),
      source: expect.objectContaining({ artifact_id: sourceId, media_type: 'image/png' }),
    }))
    const result = kernel.getOcrResult(intakeId, request.request_id)
    expect(result).toMatchObject({
      artifact: { source_artifact_id: sourceId, trust: 'observed_unverified', text: '# 第 2 页\n识别文本' },
      observations: [{ source_artifact_id: sourceId, page: 2, locator: 'block:1', confidence: 0.93, provider_id: 'mineru', model_id: 'flash', provider_revision: 1, trust: 'observed_unverified' }],
    })
    expect(JSON.stringify(result)).not.toContain('must-not-persist')
    expect(JSON.stringify(result)).not.toContain('secret.invalid')
    expect({
      gates: Number((kernel.db.prepare('SELECT COUNT(*) AS n FROM gates').get() as { n: number }).n),
      evidence: Number((kernel.db.prepare('SELECT COUNT(*) AS n FROM evidence').get() as { n: number }).n),
      answers: Number((kernel.db.prepare('SELECT COUNT(*) AS n FROM intake_questions WHERE answer IS NOT NULL').get() as { n: number }).n),
    }).toEqual(before)
    kernel.close()
  })

  it('fails closed when a provider result escapes the exact page pin', async () => {
    const { kernel, intakeId, sourceId } = fixture()
    const request = kernel.createOcrRequest(intakeId, {
      source_artifact_id: sourceId, provider_id: 'mineru', model_id: 'flash', pages: [2], language: 'en',
    }, 'ocr-page-pin')
    const completed = await new MinerUOcrWorker(kernel, { binding: {
      provider_id: request.provider_id, model_id: request.model_id, provider_revision: request.provider_revision,
      provider_config_sha256: request.provider_config_sha256,
    }, extract: async () => ({
      markdown: 'wrong page', observations: [{ page: 3, locator: 'block:1', text: 'wrong page', confidence: 0.99 }],
    }) }).runOnce()
    expect(completed).toMatchObject({ request_id: request.request_id, status: 'failed', safe_error: { code: 'result_invalid' }, result_artifact_id: null })
    expect(kernel.getOcrResult(intakeId, request.request_id)).toBeNull()
    kernel.close()
  })

  it('preserves low confidence without fallback and redacts arbitrary transport failures', async () => {
    const { kernel, intakeId, sourceId } = fixture()
    const low = kernel.createOcrRequest(intakeId, {
      source_artifact_id: sourceId, provider_id: 'mineru', model_id: 'flash', pages: [1], language: 'en',
    }, 'ocr-low-confidence')
    await new MinerUOcrWorker(kernel, { binding: {
      provider_id: low.provider_id, model_id: low.model_id, provider_revision: low.provider_revision,
      provider_config_sha256: low.provider_config_sha256,
    }, extract: async () => ({
      markdown: 'uncertain', observations: [{ page: 1, locator: 'block:low', text: 'uncertain', confidence: 0.01 }],
    }) }).runOnce()
    expect(kernel.getOcrResult(intakeId, low.request_id)?.observations[0]).toMatchObject({ confidence: 0.01, model_id: 'flash' })

    const failed = kernel.createOcrRequest(intakeId, {
      source_artifact_id: sourceId, provider_id: 'mineru', model_id: 'flash', pages: [], language: 'auto',
    }, 'ocr-transport-failure')
    const result = await new MinerUOcrWorker(kernel, { binding: {
      provider_id: failed.provider_id, model_id: failed.model_id, provider_revision: failed.provider_revision,
      provider_config_sha256: failed.provider_config_sha256,
    }, extract: async () => {
      throw new Error('Bearer TOP-SECRET at https://internal.example/private')
    } }).runOnce()
    expect(result).toMatchObject({ request_id: failed.request_id, status: 'failed', safe_error: { code: 'transport_failed', message: 'The OCR transport failed.' } })
    expect(JSON.stringify(result)).not.toContain('TOP-SECRET')
    expect(JSON.stringify(result)).not.toContain('internal.example')
    expect(kernel.getOcrResult(intakeId, failed.request_id)).toBeNull()
    kernel.close()
  })

  it('refuses a transport whose exact model/config pin differs and never invokes it', async () => {
    const { kernel, intakeId, sourceId } = fixture()
    const request = kernel.createOcrRequest(intakeId, {
      source_artifact_id: sourceId, provider_id: 'mineru', model_id: 'flash', pages: [], language: 'auto',
    }, 'ocr-transport-pin')
    const extract = vi.fn()
    const result = await new MinerUOcrWorker(kernel, {
      binding: {
        provider_id: 'mineru', model_id: 'flash', provider_revision: request.provider_revision,
        provider_config_sha256: 'f'.repeat(64),
      },
      extract,
    }).runOnce()
    expect(result).toMatchObject({ status: 'failed', safe_error: { code: 'provider_unavailable' }, result_artifact_id: null })
    expect(extract).not.toHaveBeenCalled()
    kernel.close()
  })
})
