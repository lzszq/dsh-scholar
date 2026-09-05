import { afterEach, describe, expect, it, vi } from 'vitest'
import { createServer, type IncomingMessage } from 'node:http'
import { deflateRawSync } from 'node:zlib'
import type { OcrRequest } from '@dsh-scholar/research-schemas'
import {
  HttpMinerUTransport, normalizeMinerUArchive, validateMinerUAddress, validateMinerUUrl,
  type MinerUHttpInput, type MinerUHttpRequest,
} from '@dsh-scholar/research-kernel'

const cleanup: Array<() => Promise<void> | void> = []
afterEach(async () => { for (const work of cleanup.splice(0).reverse()) await work(); vi.restoreAllMocks() })
const binding = { provider_id: 'mineru' as const, model_id: 'flash', provider_revision: 1, provider_config_sha256: 'a'.repeat(64) }
function request(model = 'flash', pages: number[] = []): OcrRequest {
  return {
    request_id: 'ocr_test_1', intake_id: 'intake-test', project_id: 'project-test',
    source_artifact_id: `sha256:${'b'.repeat(64)}`, source_sha256: 'b'.repeat(64),
    source_media_type: 'application/pdf', source_file_name: 'paper.pdf',
    provider_id: 'mineru', model_id: model, provider_revision: 1, provider_config_sha256: binding.provider_config_sha256,
    binding_revision: 1, pages, language: 'zh-CN', status: 'running', result_artifact_id: null, safe_error: null,
    idempotency_key: 'ocr-key', request_sha256: 'c'.repeat(64), attempts: 1,
    created_at: '', updated_at: '', started_at: '', finished_at: null,
  }
}
function input(model = 'flash', pages: number[] = []) {
  return { request: request(model, pages), source: {
    artifact_id: `sha256:${'b'.repeat(64)}`, sha256: 'b'.repeat(64), media_type: 'application/pdf',
    file_name: 'paper.pdf', content: Buffer.from('%PDF-1.7\nfixture'),
  } }
}

// Independent ZIP producer, sufficient for the published full.md/layout.json
// fixtures and malformed-member regressions (no dependency on our reader).
function zip(files: Record<string, string>): Buffer {
  const parts: Buffer[] = [], entries: Buffer[] = []
  let offset = 0
  for (const [path, content] of Object.entries(files)) {
    const name = Buffer.from(path), bytes = Buffer.from(content), compressed = deflateRawSync(bytes)
    let crc = 0xffffffff
    for (const byte of bytes) { crc ^= byte; for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1)) }
    crc = (crc ^ 0xffffffff) >>> 0
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50); local.writeUInt16LE(20, 4); local.writeUInt16LE(8, 8)
    local.writeUInt32LE(crc, 14); local.writeUInt32LE(compressed.length, 18); local.writeUInt32LE(bytes.length, 22); local.writeUInt16LE(name.length, 26)
    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50); central.writeUInt16LE(0x0314, 4); central.writeUInt16LE(20, 6); central.writeUInt16LE(8, 10)
    central.writeUInt32LE(crc, 16); central.writeUInt32LE(compressed.length, 20); central.writeUInt32LE(bytes.length, 24)
    central.writeUInt16LE(name.length, 28); central.writeUInt32LE((0o100644 << 16) >>> 0, 38); central.writeUInt32LE(offset, 42)
    parts.push(local, name, compressed); entries.push(central, name); offset += local.length + name.length + compressed.length
  }
  const directory = Buffer.concat(entries), end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50); end.writeUInt16LE(Object.keys(files).length, 8); end.writeUInt16LE(Object.keys(files).length, 10)
  end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16)
  return Buffer.concat([...parts, directory, end])
}
async function body(req: IncomingMessage) {
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(Buffer.from(chunk))
  return Buffer.concat(chunks)
}

/** The adapter sends the real protocol through a loopback HTTP fixture.
 * This mapping is injected only at the I/O seam; it does not change the
 * production fixed-origin/HTTPS/connection-time DNS checks. */
async function wire(model: string) {
  const seen: Array<{ url: string; method: string; headers: Record<string, string>; bytes: Buffer }> = []
  let polls = 0
  const archive = zip({
    'full.md': '# Extracted\nText on page 2',
    'layout.json': JSON.stringify({ pdf_info: [{ page_idx: 1, para_blocks: [{ lines: [{ spans: [
      { type: 'text', content: 'Text on page 2', score: 0.37 }, { type: 'text', content: 'No reported confidence' },
    ] }] }] }] }),
  })
  const server = createServer((req, res) => {
    void (async () => {
      const data = await body(req)
      const path = new URL(req.url!, 'http://localhost').pathname
      let output: unknown
      if (path === '/api/v1/agent/parse/file') output = { task_id: 'task-1', file_url: 'https://oss-mineru.openxlab.org.cn/upload?signature=test' }
      else if (path === '/api/v4/file-urls/batch') output = { batch_id: 'batch-1', file_urls: ['https://mineru.oss-cn-shanghai.aliyuncs.com/upload?signature=test'] }
      else if (path === '/upload') { res.end(''); return }
      else if (path === '/api/v1/agent/parse/task-1') output = { task_id: 'task-1', state: ++polls === 1 ? 'running' : 'done', markdown_url: 'https://cdn-mineru.openxlab.org.cn/result/full.md' }
      else if (path === '/api/v4/extract-results/batch/batch-1') output = { batch_id: 'batch-1', extract_result: [
        { data_id: 'ocr_test_1', file_name: 'paper.pdf', state: ++polls === 1 ? 'pending' : 'done', full_zip_url: 'https://cdn-mineru.openxlab.org.cn/result.zip' },
      ] }
      else if (path === '/result/full.md') { res.end('# Flash markdown'); return }
      else if (path === '/result.zip') { res.end(archive); return }
      else { res.writeHead(404); res.end(data); return }
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({ code: 0, data: output }))
    })().catch(error => { res.writeHead(500); res.end(String(error)) })
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  cleanup.push(() => new Promise<void>(resolve => server.close(() => resolve())))
  const port = (server.address() as { port: number }).port
  const network: MinerUHttpRequest = async params => {
    const url = new URL(params.url)
    seen.push({ url: params.url, method: params.method, headers: params.headers ?? {}, bytes: params.body ?? Buffer.alloc(0) })
    const response = await fetch(`http://127.0.0.1:${port}${url.pathname}${url.search}`, {
      method: params.method, headers: params.headers, body: params.body, signal: params.signal,
    })
    if (!response.ok) throw new Error('fixture rejected request')
    return Buffer.from(await response.arrayBuffer())
  }
  return { seen, adapter: new HttpMinerUTransport({ binding: { ...binding, model_id: model }, token: 'SECRET-MINERU-TOKEN', request: network, pollIntervalMs: 1 }) }
}

describe('MinerU official protocol adapter (local contract fixture, not provider acceptance)', () => {
  it('uses the anonymous Flash signed-upload protocol and does not invent observations', async () => {
    const { seen, adapter } = await wire('flash')
    const result = await adapter.extract(input('flash', [2, 3]))
    expect(result).toEqual({ markdown: '# Flash markdown', observations: [] })
    expect(seen[0]!.url).toBe('https://mineru.net/api/v1/agent/parse/file')
    expect(JSON.parse(seen[0]!.bytes.toString())).toEqual({ file_name: 'paper.pdf', language: 'ch', is_ocr: true, page_range: '2-3' })
    expect(seen.filter(call => call.method === 'PUT')[0]!.bytes).toEqual(input().source.content)
    expect(seen.every(call => call.headers.authorization === undefined)).toBe(true)
  })

  it.each(['pipeline', 'vlm'])('pins %s and sends credentials only to the API origin', async model => {
    const { seen, adapter } = await wire(model)
    const result = await adapter.extract(input(model, [2]))
    expect(JSON.parse(seen[0]!.bytes.toString())).toEqual({
      model_version: model, language: 'ch', files: [{ name: 'paper.pdf', data_id: 'ocr_test_1', is_ocr: true, page_ranges: '2' }],
    })
    expect(result).toMatchObject({ markdown: '# Extracted\nText on page 2', observations: [
      { page: 2, text: 'Text on page 2', confidence: 0.37, locator: expect.stringContaining('/pdf_info/0/') },
    ] })
    expect(result.observations).toHaveLength(1)
    for (const call of seen) {
      expect(call.headers.authorization).toBe(new URL(call.url).origin === 'https://mineru.net' ? 'Bearer SECRET-MINERU-TOKEN' : undefined)
    }
  })

  it('rejects unsupported Flash page selections and missing precision credentials before uploading', async () => {
    const network = vi.fn()
    const flash = new HttpMinerUTransport({ binding, request: network })
    await expect(flash.extract(input('flash', [1, 3]))).rejects.toMatchObject({ code: 'provider_rejected' })
    await expect(new HttpMinerUTransport({ binding: { ...binding, model_id: 'vlm' }, request: network }).extract(input('vlm')))
      .rejects.toMatchObject({ code: 'provider_unavailable' })
    expect(network).not.toHaveBeenCalled()
  })

  it('refuses untrusted transfer destinations before forwarding document bytes or credentials', async () => {
    const network = vi.fn(async () => Buffer.from(JSON.stringify({ code: 0, data: { task_id: 'task-1', file_url: 'https://127.0.0.1/private' } })))
    await expect(new HttpMinerUTransport({ binding, request: network }).extract(input())).rejects.toMatchObject({ code: 'provider_rejected' })
    expect(network).toHaveBeenCalledTimes(1)
    for (const url of ['http://cdn-mineru.openxlab.org.cn/a', 'https://cdn-mineru.openxlab.org.cn.attacker.test/a', 'https://user:secret@mineru.net/a', 'https://mineru.net:8443/a']) {
      expect(() => validateMinerUUrl(url, false)).toThrow()
    }
    for (const address of ['127.0.0.1', '10.2.3.4', '169.254.169.254', '::1', 'fc00::1', '::ffff:127.0.0.1']) {
      expect(() => validateMinerUAddress(address)).toThrow()
    }
    expect(() => validateMinerUAddress('8.8.8.8')).not.toThrow()
  })

  it('bounds polling and aborts promptly on timeout or cancellation', async () => {
    const network = vi.fn(async (params: MinerUHttpInput) => Buffer.from(JSON.stringify({ code: 0, data:
      params.method === 'POST' ? { task_id: 'task-1', file_url: 'https://oss-mineru.openxlab.org.cn/upload' }
        : { task_id: 'task-1', state: 'running' },
    })))
    await expect(new HttpMinerUTransport({ binding, request: network, pollIntervalMs: 1000, timeoutMs: 30 }).extract(input()))
      .rejects.toMatchObject({ code: 'provider_unavailable' })
    const stop = new AbortController()
    const promise = new HttpMinerUTransport({ binding, request: network, pollIntervalMs: 1000 }).extract({ ...input(), signal: stop.signal })
    stop.abort()
    await expect(promise).rejects.toBeDefined()
  })

  it('rejects foreign batch results, corrupt archives, traversal and observations outside exact page pins', async () => {
    const network = vi.fn(async (params: MinerUHttpInput) => Buffer.from(JSON.stringify({ code: 0, data:
      params.method === 'POST' ? { batch_id: 'batch-1', file_urls: ['https://oss-mineru.openxlab.org.cn/upload'] }
        : { batch_id: 'batch-1', extract_result: [{ data_id: 'foreign', file_name: 'paper.pdf', state: 'done' }] },
    })))
    await expect(new HttpMinerUTransport({ binding: { ...binding, model_id: 'vlm' }, token: 'secret', request: network }).extract(input('vlm')))
      .rejects.toMatchObject({ code: 'ocr_result_invalid' })
    for (const archive of [Buffer.from('not a zip'), zip({ '../full.md': 'escape' }), zip({
      'full.md': 'wrong page', 'layout.json': JSON.stringify({ pdf_info: [{ page_idx: 2 }] }),
    })]) {
      expect(() => normalizeMinerUArchive(archive, request('pipeline', [2]))).toThrow(expect.objectContaining({ code: 'ocr_result_invalid' }))
    }
  })
})
