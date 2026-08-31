import { afterEach, describe, expect, it, vi } from 'vitest'
import { ResearchClient } from '@dsh-scholar/research-client'

afterEach(() => vi.unstubAllGlobals())

const request = {
  request_id: 'ocr_abc', project_id: 'rsp_1', intake_id: 'intk_1', source_artifact_id: `sha256:${'a'.repeat(64)}`,
  source_sha256: 'a'.repeat(64), source_media_type: 'application/pdf', source_file_name: 'paper.pdf',
  provider_id: 'mineru', model_id: 'flash', provider_revision: 1, provider_config_sha256: 'b'.repeat(64), binding_revision: 1,
  pages: [1], language: 'en', status: 'queued', result_artifact_id: null, safe_error: null,
  idempotency_key: 'idem-1', request_sha256: 'c'.repeat(64), attempts: 0,
  created_at: '2026-08-31T00:00:00.000Z', updated_at: '2026-08-31T00:00:00.000Z', started_at: null, finished_at: null,
}

describe('REVIEW-OCR-03 typed client', () => {
  it('uses the v2 intake create/read/cancel paths and forwards only the Idempotency-Key', async () => {
    const fetch = vi.fn().mockImplementation(async (url: string, init?: RequestInit) => new Response(JSON.stringify(
      init?.method === 'GET' ? { request, result: null } : request,
    ), { status: 200, headers: { 'content-type': 'application/json' } }))
    vi.stubGlobal('fetch', fetch)
    const client = new ResearchClient({ endpoint: 'http://127.0.0.1:7412', token: 'kernel-token' })
    const input = { source_artifact_id: request.source_artifact_id, provider_id: 'mineru', model_id: 'flash', pages: [1], language: 'en' }
    await expect(client.createOcrRequest('intk_1', input, 'idem-1')).resolves.toEqual(request)
    await expect(client.getOcrRequest('intk_1', 'ocr_abc')).resolves.toEqual({ request, result: null })
    await expect(client.cancelOcrRequest('intk_1', 'ocr_abc')).resolves.toEqual(request)
    expect(fetch.mock.calls.map(call => [call[0], (call[1] as RequestInit).method])).toEqual([
      ['http://127.0.0.1:7412/v2/intakes/intk_1/ocr-requests', 'POST'],
      ['http://127.0.0.1:7412/v2/intakes/intk_1/ocr-requests/ocr_abc', 'GET'],
      ['http://127.0.0.1:7412/v2/intakes/intk_1/ocr-requests/ocr_abc', 'DELETE'],
    ])
    const createHeaders = (fetch.mock.calls[0]![1] as RequestInit).headers as Record<string, string>
    expect(createHeaders).toMatchObject({ authorization: 'Bearer kernel-token', 'idempotency-key': 'idem-1' })
    expect(JSON.stringify(fetch.mock.calls)).not.toContain('endpoint')
    expect(JSON.stringify(fetch.mock.calls)).not.toContain('credential')
  })
})
