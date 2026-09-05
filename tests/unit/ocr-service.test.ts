import { afterEach, describe, expect, it, vi } from 'vitest'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { tmpdir } from 'node:os'
import { execFileSync, spawn } from 'node:child_process'
import { DatabaseSync } from 'node:sqlite'
import {
  HttpMinerUTransport, ResearchKernel, readMinerUCredential, startKernelServer,
} from '@dsh-scholar/research-kernel'

const cleanup: Array<() => Promise<void> | void> = []
afterEach(async () => { for (const work of cleanup.splice(0).reverse()) await work(); vi.restoreAllMocks() })
const pause = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))
async function until(predicate: () => boolean, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) { if (Date.now() > deadline) throw new Error('OCR service condition timed out'); await pause(10) }
}
function fixture(model = 'flash') {
  const root = mkdtempSync(join(tmpdir(), 'dsh-ocr-service-'))
  cleanup.push(() => rmSync(root, { recursive: true, force: true }))
  const dbPath = join(root, 'kernel.db'), casRoot = join(root, 'cas'), secretRoot = join(root, 'secrets')
  mkdirSync(secretRoot)
  writeFileSync(join(secretRoot, 'mineru-token'), 'TEST-MINERU-SECRET', { mode: 0o600 })
  const options = { dbPath, casRoot, secretRoot, requireSignedManifest: false, providerUrlAllowlist: { hosts: ['mineru.net'] } }
  let kernel = new ResearchKernel(options)
  let closed = false
  cleanup.push(async () => { if (!closed) { await kernel.stopOcrWorker(); kernel.close() } })
  const project = kernel.createProjectForGrill({ name: 'Preserve existing research', creator_principal_id: 'pi-1', idempotency_key: 'project-key', request_hash: 'project-hash' }).project
  // A pre-existing workspace file, outside any transient OCR transport area.
  const workspace = join(root, 'existing-workspace')
  mkdirSync(workspace)
  writeFileSync(join(workspace, 'notes.md'), 'Do not replace my research notes.\n')
  kernel.registerProvider({
    provider_id: 'mineru', kind: 'mineru', display_name: 'MinerU', base_url: 'https://mineru.net/api/v4', enabled: true,
    credential: { scheme: 'file', name: 'mineru-token' }, capabilities: ['ocr', 'vision'],
    models: [{ model_id: 'flash', capabilities: ['ocr'] }, { model_id: 'pipeline', capabilities: ['ocr'] }, { model_id: 'vlm', capabilities: ['ocr', 'vision'] }],
  })
  kernel.setProjectModelBinding(project.project_id, { purpose: 'ocr', provider_id: 'mineru', model_id: model })
  const intake = kernel.beginIntake({ project_id: project.project_id, source_label: 'scan', owner: { principal_id: 'pi-1' } })
  const source = kernel.stageIntakeArtifact(intake.intake_id, { file_name: 'scan.pdf', media_type: 'application/pdf', content: Buffer.from('%PDF-1.7\npinned source') })
  kernel.scanIntake(intake.intake_id)
  const input = { source_artifact_id: source.artifact_id, provider_id: 'mineru', model_id: model, pages: [], language: 'auto' }
  const request = kernel.createOcrRequest(intake.intake_id, input, 'durable-ocr-key')
  const immutable = () => ({
    project: kernel.getProject(project.project_id),
    gates: kernel.db.prepare('SELECT * FROM gates ORDER BY gate_id').all(),
    evidence: kernel.db.prepare('SELECT * FROM evidence').all(),
    questions: kernel.db.prepare('SELECT * FROM intake_questions').all(),
    migrations: kernel.db.prepare('SELECT id, checksum FROM schema_migrations ORDER BY id').all(),
    workspace: readFileSync(join(workspace, 'notes.md'), 'utf8'),
    source: kernel.loadOcrSource(request).content.toString('hex'),
  })
  return {
    root, dbPath, casRoot, secretRoot, project, intake, request, input, immutable,
    get kernel() { return kernel },
    close() { if (!closed) { kernel.close(); closed = true } },
    reopen() { if (!closed) kernel.close(); kernel = new ResearchKernel(options); closed = false },
  }
}
async function serve(kernel: ResearchKernel) {
  const http = await startKernelServer({ kernel, port: 0, ocrWorker: { pollIntervalMs: 5, cancelPollIntervalMs: 5 } })
  cleanup.push(() => new Promise<void>(resolve => http.server.close(() => resolve())))
  return http
}

describe('production OCR consumer lifecycle', () => {
  it('starts the default production adapter with the HTTP runtime and preserves research data', async () => {
    const f = fixture('pipeline'), before = f.immutable()
    const extract = vi.spyOn(HttpMinerUTransport.prototype, 'extract').mockResolvedValue({ markdown: '# Normalized', observations: [] })
    await serve(f.kernel)
    await until(() => f.kernel.getOcrRequest(f.intake.intake_id, f.request.request_id).status === 'succeeded')
    expect(extract).toHaveBeenCalledOnce()
    expect(extract.mock.calls[0]![0]).toMatchObject({ request: { model_id: 'pipeline' }, source: { content: Buffer.from('%PDF-1.7\npinned source') }, signal: expect.any(AbortSignal) })
    expect(f.kernel.getOcrResult(f.intake.intake_id, f.request.request_id)).toMatchObject({ artifact: { text: '# Normalized', trust: 'observed_unverified' }, observations: [] })
    expect(f.immutable()).toEqual(before)
  })

  it('refuses changed provider pins and never invokes another transport/model', async () => {
    const f = fixture()
    const extract = vi.spyOn(HttpMinerUTransport.prototype, 'extract')
    f.kernel.updateProvider('mineru', { expected_revision: 1, enabled: false })
    await serve(f.kernel)
    await until(() => f.kernel.getOcrRequest(f.intake.intake_id, f.request.request_id).status === 'failed')
    expect(f.kernel.getOcrRequest(f.intake.intake_id, f.request.request_id)).toMatchObject({ safe_error: { code: 'provider_unavailable' } })
    expect(extract).not.toHaveBeenCalled()
  })

  it('aborts in-flight I/O on stop, requeues the same request, and resumes after reopening without data loss', async () => {
    const f = fixture(), before = f.immutable()
    let aborted = false
    const extract = vi.spyOn(HttpMinerUTransport.prototype, 'extract').mockImplementationOnce(({ signal }) => new Promise((_resolve, reject) => {
      signal!.addEventListener('abort', () => { aborted = true; reject(new Error('transport stopped')) }, { once: true })
    }))
    f.kernel.startOcrWorker({ pollIntervalMs: 5 })
    await until(() => extract.mock.calls.length === 1)
    await f.kernel.stopOcrWorker()
    expect(aborted).toBe(true)
    expect(f.kernel.getOcrRequest(f.intake.intake_id, f.request.request_id)).toMatchObject({ status: 'queued', attempts: 1 })
    f.reopen()
    extract.mockResolvedValue({ markdown: 'Recovered', observations: [] })
    await serve(f.kernel)
    await until(() => f.kernel.getOcrRequest(f.intake.intake_id, f.request.request_id).status === 'succeeded')
    expect(f.kernel.createOcrRequest(f.intake.intake_id, f.input, 'durable-ocr-key')).toMatchObject({ request_id: f.request.request_id, attempts: 2, status: 'succeeded' })
    expect(f.immutable()).toEqual(before)
    expect(f.kernel.db.prepare('SELECT COUNT(*) AS n FROM ocr_requests').get()).toMatchObject({ n: 1 })
  })

  it('aborts cancelled OCR work and cannot overwrite cancellation with a late result', async () => {
    const f = fixture()
    let aborted = false
    const extract = vi.spyOn(HttpMinerUTransport.prototype, 'extract').mockImplementationOnce(({ signal }) => new Promise(resolve => {
      signal!.addEventListener('abort', () => { aborted = true; resolve({ markdown: 'late output', observations: [] }) }, { once: true })
    }))
    await serve(f.kernel)
    await until(() => extract.mock.calls.length === 1)
    f.kernel.cancelOcrRequest(f.intake.intake_id, f.request.request_id)
    await until(() => aborted)
    await f.kernel.stopOcrWorker()
    expect(f.kernel.getOcrRequest(f.intake.intake_id, f.request.request_id).status).toBe('cancelled')
    expect(f.kernel.getOcrResult(f.intake.intake_id, f.request.request_id)).toBeNull()
  })

  it('resolves only contained 0600 regular-file credentials, with safe errors', () => {
    const f = fixture('vlm'), ref = { scheme: 'file' as const, name: 'mineru-token' }
    expect(readMinerUCredential(ref, f.secretRoot)).toBe('TEST-MINERU-SECRET')
    chmodSync(join(f.secretRoot, 'mineru-token'), 0o644)
    expect(() => readMinerUCredential(ref, f.secretRoot)).toThrow('provider_unavailable')
    chmodSync(join(f.secretRoot, 'mineru-token'), 0o600)
    symlinkSync(join(f.secretRoot, 'mineru-token'), join(f.secretRoot, 'link'))
    for (const candidate of [{ ...ref, name: '../secrets/mineru-token' }, { ...ref, name: 'link' }, { scheme: 'vault' as const, name: 'mineru-token' }]) {
      expect(() => readMinerUCredential(candidate, f.secretRoot)).toThrow('provider_unavailable')
    }
  })

  it('the actual Kernel binary consumes a queued request without a test scheduler', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-ocr-binary-'))
    cleanup.push(() => rmSync(root, { recursive: true, force: true }))
    const dbPath = join(root, 'kernel.db'), casRoot = join(root, 'cas')
    // Seed using the same native Node loader as the binary. Vitest rewrites
    // Function.toString(), which is part of historical migration checksums;
    // crossing those loaders would test checksum skew, not an upgrade.
    const seedFile = join(root, 'seed.mjs')
    writeFileSync(seedFile, `
      import { ResearchKernel } from ${JSON.stringify(pathToFileURL(resolve('packages/research-kernel/lib/index.js')).href)};
      import { join } from 'node:path';
      const root = process.argv[2];
      const kernel = new ResearchKernel({ dbPath: join(root, 'kernel.db'), casRoot: join(root, 'cas'), providerUrlAllowlist: { hosts: ['mineru.net'] } });
      const project = kernel.createProjectForGrill({ name: 'Existing research', creator_principal_id: 'pi', idempotency_key: 'project', request_hash: 'hash' }).project;
      kernel.registerProvider({ provider_id: 'mineru', kind: 'mineru', display_name: 'MinerU', base_url: 'https://mineru.net/api/v4', enabled: true, capabilities: ['ocr', 'vision'], models: [
        { model_id: 'flash', capabilities: ['ocr'] }, { model_id: 'pipeline', capabilities: ['ocr'] }, { model_id: 'vlm', capabilities: ['ocr', 'vision'] }
      ] });
      kernel.setProjectModelBinding(project.project_id, { purpose: 'ocr', provider_id: 'mineru', model_id: 'flash' });
      const intake = kernel.beginIntake({ project_id: project.project_id, source_label: 'scan', owner: { principal_id: 'pi' } });
      const source = kernel.stageIntakeArtifact(intake.intake_id, { file_name: 'scan.pdf', media_type: 'application/pdf', content: Buffer.from('%PDF-1.7\\nsource') });
      kernel.scanIntake(intake.intake_id);
      const request = kernel.createOcrRequest(intake.intake_id, { source_artifact_id: source.artifact_id, provider_id: 'mineru', model_id: 'flash', pages: [], language: 'auto' }, 'ocr-key');
      kernel.updateProvider('mineru', { expected_revision: 1, enabled: false });
      console.log(JSON.stringify({ requestId: request.request_id, project: kernel.db.prepare('SELECT * FROM projects').all(), migrations: kernel.db.prepare('SELECT id, checksum FROM schema_migrations ORDER BY id').all() }));
      kernel.close();
    `)
    const before = JSON.parse(execFileSync(process.execPath, [seedFile, root], { encoding: 'utf8' })) as { requestId: string; project: unknown; migrations: unknown }
    const endpoint = join(root, 'endpoint.json')
    const child = spawn(process.execPath, ['packages/research-kernel/lib/bin/kernel.js', '--db', dbPath, '--cas', casRoot, '--port', '0', '--endpoint-file', endpoint], {
      cwd: process.cwd(), stdio: ['ignore', 'ignore', 'pipe'], env: { PATH: process.env.PATH, DSH_SCHOLAR_SERVICE_TOKEN: 'isolated-test-service' },
    })
    let stderr = ''
    child.stderr.on('data', chunk => { stderr += String(chunk) })
    const exit = new Promise<number | null>((resolveExit, reject) => { child.once('exit', resolveExit); child.once('error', reject) })
    cleanup.push(async () => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM'); await exit })
    await until(() => {
      if (child.exitCode !== null || child.signalCode !== null) throw new Error(`Kernel binary exited: ${stderr}`)
      return existsSync(endpoint)
    }, 30_000)
    const db = new DatabaseSync(dbPath, { readOnly: true })
    try {
      await until(() => (db.prepare('SELECT status FROM ocr_requests WHERE request_id = ?').get(before.requestId) as { status: string }).status === 'failed')
      expect(db.prepare('SELECT attempts, safe_error_json FROM ocr_requests WHERE request_id = ?').get(before.requestId))
        .toMatchObject({ attempts: 1, safe_error_json: expect.stringContaining('provider_unavailable') })
      expect(db.prepare('SELECT * FROM projects').all()).toEqual(before.project)
      expect(db.prepare('SELECT id, checksum FROM schema_migrations ORDER BY id').all()).toEqual(before.migrations)
    } finally { db.close() }
    child.kill('SIGTERM')
    expect(await exit).toBe(0)
  }, 45_000)
})
