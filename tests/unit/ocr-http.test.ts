import { describe, expect, it } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ResearchKernel } from '@dsh-scholar/research-kernel'
import { startKernelServer } from '../../packages/research-kernel/lib/server.js'

function fixture(): {
  kernel: ResearchKernel
  projectId: string
  intakeId: string
  sourceId: string
} {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-ocr-http-'))
  const kernel = new ResearchKernel({
    dbPath: join(dir, 'kernel.db'),
    casRoot: join(dir, 'cas'),
    requireSignedManifest: false,
    providerUrlAllowlist: { hosts: ['mineru.net'] },
  })
  const project = kernel.createProjectForGrill({
    name: 'OCR HTTP',
    creator_principal_id: 'pi-1',
    idempotency_key: `project-${dir}`,
    request_hash: 'project-v1',
  }).project
  kernel.registerProvider({
    provider_id: 'mineru',
    display_name: 'MinerU',
    kind: 'mineru',
    base_url: 'https://mineru.net/api/v4',
    enabled: true,
    capabilities: ['ocr', 'vision'],
    models: [
      { model_id: 'flash', capabilities: ['ocr'] },
      { model_id: 'pipeline', capabilities: ['ocr'] },
      { model_id: 'vlm', capabilities: ['ocr', 'vision'] },
    ],
  })
  kernel.setProjectModelBinding(project.project_id, {
    purpose: 'ocr',
    provider_id: 'mineru',
    model_id: 'flash',
  })
  const intake = kernel.beginIntake({
    project_id: project.project_id,
    source_label: 'paper',
    owner: { principal_id: 'pi-1' },
  })
  const source = kernel.stageIntakeArtifact(intake.intake_id, {
    file_name: 'paper.pdf',
    media_type: 'application/pdf',
    content: Buffer.from('%PDF-1.7\nsource'),
  })
  kernel.scanIntake(intake.intake_id)
  return { kernel, projectId: project.project_id, intakeId: intake.intake_id, sourceId: source.artifact_id }
}

async function withServer(kernel: ResearchKernel, work: (base: string) => Promise<void>): Promise<void> {
  const { server, port } = await startKernelServer({ kernel, host: '127.0.0.1', port: 0 })
  try {
    await work(`http://127.0.0.1:${port}`)
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()))
  }
}

describe('REVIEW-OCR-03 HTTP contract', () => {
  it('creates, reads and cancels one intake-scoped request without alternate routes', async () => {
    const f = fixture()
    try {
      await withServer(f.kernel, async (base) => {
        const headers = {
          'content-type': 'application/json',
          'x-principal-id': 'pi-1',
          'x-principal-role': 'pi',
        }
        const body = JSON.stringify({
          source_artifact_id: f.sourceId,
          provider_id: 'mineru',
          model_id: 'flash',
          pages: [1],
          language: 'zh-CN',
        })
        const missingKey = await fetch(`${base}/v2/intakes/${f.intakeId}/ocr-requests`, {
          method: 'POST', headers, body,
        })
        expect(missingKey.status).toBe(422)
        expect(await missingKey.json()).toMatchObject({ error: { code: 'idempotency_key_required' } })

        const createdResponse = await fetch(`${base}/v2/intakes/${f.intakeId}/ocr-requests`, {
          method: 'POST', headers: { ...headers, 'idempotency-key': 'ocr-http-1' }, body,
        })
        expect(createdResponse.status).toBe(201)
        const created = await createdResponse.json() as { request_id: string; project_id: string; status: string }
        expect(created).toMatchObject({ project_id: f.projectId, status: 'queued' })

        const readResponse = await fetch(`${base}/v2/intakes/${f.intakeId}/ocr-requests/${created.request_id}`, { headers })
        expect(readResponse.status).toBe(200)
        expect(await readResponse.json()).toMatchObject({
          request: { request_id: created.request_id, intake_id: f.intakeId },
          result: null,
        })

        const cancelledResponse = await fetch(`${base}/v2/intakes/${f.intakeId}/ocr-requests/${created.request_id}`, {
          method: 'DELETE', headers,
        })
        expect(cancelledResponse.status).toBe(200)
        expect(await cancelledResponse.json()).toMatchObject({ request_id: created.request_id, status: 'cancelled' })

        const trailing = await fetch(`${base}/v2/intakes/${f.intakeId}/ocr-requests/${created.request_id}/extra`, { headers })
        expect(trailing.status).toBe(404)
        expect(await trailing.json()).toMatchObject({ error: { code: 'not_found' } })
      })
    } finally {
      f.kernel.close()
    }
  })

  it('derives project membership from the intake and fails closed for outsiders', async () => {
    const f = fixture()
    try {
      await withServer(f.kernel, async (base) => {
        const response = await fetch(`${base}/v2/intakes/${f.intakeId}/ocr-requests`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'idempotency-key': 'ocr-outsider',
            'x-principal-id': 'outsider',
            'x-principal-role': 'researcher',
          },
          body: JSON.stringify({
            source_artifact_id: f.sourceId,
            provider_id: 'mineru',
            model_id: 'flash',
            pages: [],
            language: 'auto',
          }),
        })
        expect(response.status).toBe(404)
        expect(await response.json()).toMatchObject({ error: { code: 'project_not_found' } })
        expect(f.kernel.db.prepare('SELECT COUNT(*) AS n FROM ocr_requests').get()).toMatchObject({ n: 0 })
      })
    } finally {
      f.kernel.close()
    }
  })
})
