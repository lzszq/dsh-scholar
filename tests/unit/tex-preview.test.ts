/**
 * TEX-03 (execution-runtime.md §12.1, acceptance-tests.md §7 live-preview /
 * preview-vs-compile): server-side live LaTeX preview semantics.
 *
 *  - save success → debounced preview build (kernel-owned timer + durable
 *    tex_preview_pending row; POST /v1/documents/{id}/preview-builds hook);
 *  - a new revision's preview cancels queued previews and marks running
 *    previews superseded (superseded_by/superseded_at), old PDFs are stale
 *    (build.revision < document.revision → stale=true);
 *  - previews run the SAME fixed texlive image / no-network / no-shell-escape
 *    latex-compile runner path (payload.preview=true) but are NOT part of the
 *    authoritative manifest chain: no Evidence, no authoritative manifest;
 *  - an explicit Compile (authoritative latex-compile Job) supersedes every
 *    non-terminal preview and is never blocked or replaced by previews.
 */
import { describe, expect, it } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ResearchKernel, startKernelServer } from '@dsh-scholar/research-kernel'
import type { TexSnapshotManifest } from '@dsh-scholar/runner-gateway'
import { ConfiguredTestKernel } from './configured-test-kernel.js'

/** P0 (acceptance-tests.md §4): the exact texlive digest pinned by configs/runner-profiles/images.lock.json. */
const TEXLIVE_IMAGE_DIGEST = 'texlive/texlive@sha256:8957c916b8160049f89c24d362a6d86c09d8a04095acde37e88404c4afed85b4'

function freshKernel(opts: { previewDebounceMs?: number; previewAutoTrigger?: boolean } = {}): ResearchKernel {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-tex-preview-'))
  return new ConfiguredTestKernel({
    dbPath: join(dir, 'kernel.db'),
    casRoot: join(dir, 'cas'),
    requireSignedManifest: false,
    previewDebounceMs: opts.previewDebounceMs ?? 800,
    previewAutoTrigger: opts.previewAutoTrigger ?? false,
  })
}

function makeBrief() {
  return {
    problem: 'p', scope: 's', questions: [], primary_metrics: ['m'],
    resources: '', risks: [], target_outputs: ['paper'], target_venue: null,
    baseline_repo: null, domain: 'ml',
  }
}

function fenceArgs(kernel: ResearchKernel, jobId: string): { lease_generation: number | null; lease_token: string | null } {
  const j = kernel.getJob(jobId)
  return { lease_generation: j.lease_generation, lease_token: j.lease_token }
}

function manifestIdentity(kernel: ResearchKernel, jobId: string): Record<string, unknown> {
  const job = kernel.getJob(jobId)
  return {
    run_id: job.run_id,
    job_id: job.job_id,
    project_id: job.project_id,
    contract_id: job.contract_id,
    config_pin: job.payload.project_config_pin,
    lease: { generation: job.lease_generation },
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function setupDoc(kernel: ResearchKernel): { project_id: string; document_id: string } {
  const project = kernel.createProject({ name: 't', workspace: '/w', brief: makeBrief() })
  const doc = kernel.texEnsure(project.project_id)
  kernel.texWriteFile(doc.document_id, 'paper.tex', '\\documentclass{article}\n\\begin{document}hi\\end{document}\n')
  return { project_id: project.project_id, document_id: doc.document_id }
}

type FlushResult = ReturnType<ResearchKernel['texFlushPreview']>

/** Synchronous flush: request a preview (with a debounce long enough that
 * the real timer never fires mid-test), then flush it immediately. */
function flushPreview(kernel: ResearchKernel, documentId: string): Extract<FlushResult, { action: 'created' }> {
  kernel.texRequestPreview(documentId, { debounce_ms: 60_000 })
  const result = kernel.texFlushPreview(documentId)
  expect(result.action).toBe('created')
  return result as Extract<FlushResult, { action: 'created' }>
}

describe('TEX-03 preview: debounce + build creation', () => {
  it('coalesces rapid requests into ONE flush after the debounce window', async () => {
    const kernel = freshKernel()
    const { document_id } = setupDoc(kernel)
    // Three save successes inside a 40ms window: only the LAST request's
    // revision matters and exactly one preview build is created.
    kernel.texRequestPreview(document_id, { debounce_ms: 40 })
    await sleep(15)
    kernel.texRequestPreview(document_id, { debounce_ms: 40 })
    await sleep(15)
    const last = kernel.texRequestPreview(document_id, { debounce_ms: 40 })
    expect(kernel.texPreviewStatus(document_id).pending?.revision).toBe(last.revision)
    await sleep(120)
    const status = kernel.texPreviewStatus(document_id)
    expect(status.pending).toBeNull()
    expect(status.builds).toHaveLength(1)
    expect(status.builds[0]!.status).toBe('queued')
    expect(status.builds[0]!.revision).toBe(last.revision)
    kernel.close()
  })

  it('flush creates a preview build on the SAME fixed-image latex-compile path, marked preview', () => {
    const kernel = freshKernel()
    const { document_id } = setupDoc(kernel)
    const result = flushPreview(kernel, document_id)
    // Build record: preview=true, queued, frozen input revision.
    expect(result.build!.preview).toBe(true)
    expect(result.build!.status).toBe('queued')
    expect(result.build!.revision).toBe(kernel.texTree(document_id).document.revision)
    expect(result.build!.job_id).toBe(result.job!.job_id)
    expect(result.build!.superseded_by).toBeNull()
    expect(result.build!.superseded_at).toBeNull()
    // Job: kind stays latex-compile (same runner path) but payload marks it
    // as a preview and the kernel injects the LOCKED texlive digest.
    expect(result.job!.kind).toBe('latex-compile')
    const payload = result.job!.payload as Record<string, unknown>
    expect(payload.preview).toBe(true)
    expect(payload.image_digest).toBe(TEXLIVE_IMAGE_DIGEST)
    expect(payload.engine).toBe('pdflatex')
    const manifest = payload.tex_snapshot as TexSnapshotManifest
    expect(manifest.revision).toBe(result.revision)
    expect(result.build!.revision).toBe(manifest.revision)
    // A fresh preview request for the same revision is deduplicated: the
    // flush consumes the request but finds a live preview at this revision
    // and does NOT create a second job.
    kernel.texRequestPreview(document_id, { debounce_ms: 60_000 })
    const again = kernel.texFlushPreview(document_id)
    expect(again.action).toBe('skipped_dup')
    expect(kernel.texPreviewStatus(document_id).builds).toHaveLength(1)
    // No pending request → noop.
    expect(kernel.texFlushPreview(document_id).action).toBe('noop')
    kernel.close()
  })

  it('preview engine outside the fixed whitelist is rejected at request time (422)', () => {
    const kernel = freshKernel()
    const { document_id } = setupDoc(kernel)
    try {
      kernel.texRequestPreview(document_id, { engine: 'rm -rf /' })
      throw new Error('expected KernelError')
    } catch (error) {
      expect((error as { code?: string }).code).toBe('engine_invalid')
    }
    expect(kernel.texPreviewStatus(document_id).pending).toBeNull()
    kernel.close()
  })

  it('auto-trigger (previewAutoTrigger) schedules a preview from the save-success event itself', async () => {
    const kernel = freshKernel({ previewAutoTrigger: true, previewDebounceMs: 30 })
    const { document_id } = setupDoc(kernel)
    // The writeFile above already armed the debounce; a second save coalesces.
    kernel.texWriteFile(document_id, 'paper.tex', '\\documentclass{article}\n\\begin{document}edited\\end{document}\n')
    await sleep(120)
    const status = kernel.texPreviewStatus(document_id)
    expect(status.pending).toBeNull()
    expect(status.builds).toHaveLength(1)
    expect(status.builds[0]!.revision).toBe(kernel.texTree(document_id).document.revision)
    kernel.close()
  })

  it('pending preview requests survive a kernel restart (durable projection)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-tex-preview-restart-'))
    const dbPath = join(dir, 'kernel.db')
    const casRoot = join(dir, 'cas')
    const kernelA = new ConfiguredTestKernel({ dbPath, casRoot, requireSignedManifest: false })
    const { document_id } = setupDoc(kernelA)
    // A long debounce: the request is still pending when the kernel dies.
    kernelA.texRequestPreview(document_id, { debounce_ms: 60_000 })
    kernelA.close()
    // The new kernel re-arms from the durable pending row.
    const kernelB = new ConfiguredTestKernel({ dbPath, casRoot, requireSignedManifest: false })
    try {
      expect(kernelB.texPreviewStatus(document_id).pending?.document_id).toBe(document_id)
      const result = kernelB.texFlushPreview(document_id) as Extract<FlushResult, { action: 'created' }>
      expect(result.action).toBe('created')
      expect(result.build!.preview).toBe(true)
      expect(kernelB.texPreviewStatus(document_id).pending).toBeNull()
    } finally {
      kernelB.close()
    }
  })
})

describe('TEX-03 preview: supersede + stale semantics', () => {
  it('a new revision cancels the queued preview and its job; the old PDF goes stale', () => {
    const kernel = freshKernel()
    const { document_id } = setupDoc(kernel)
    const first = flushPreview(kernel, document_id)
    expect(first.build!.status).toBe('queued')
    // Save (revision bumps) → new preview request → flush.
    kernel.texWriteFile(document_id, 'paper.tex', '\\documentclass{article}\n\\begin{document}v2\\end{document}\n')
    const second = flushPreview(kernel, document_id)
    // The queued preview was CANCELLED (it never ran) and linked to the
    // newer preview build; its job is cancelled too.
    const old = kernel.texGetBuild(first.build!.build_id)
    expect(old.status).toBe('cancelled')
    expect(old.superseded_by).toBe(second.build!.build_id)
    expect(old.superseded_at).not.toBeNull()
    expect(old.finished_at).not.toBeNull()
    expect(kernel.getJob(first.build!.job_id!).status).toBe('cancelled')
    // The new preview is live and NOT stale; the old PDF is stale.
    const newView = kernel.texGetBuild(second.build!.build_id)
    expect(newView.status).toBe('queued')
    expect(newView.stale).toBe(false)
    expect(old.stale).toBe(true)
    kernel.close()
  })

  it('a running preview is marked superseded (not cancelled) when a newer preview lands', () => {
    const kernel = freshKernel()
    const { document_id } = setupDoc(kernel)
    const first = flushPreview(kernel, document_id)
    // The runner claims the job → the build record moves queued → running.
    const claimed = kernel.claimJobs('test-runner', 300, 8)
    expect(claimed.some(c => c.job_id === first.job!.job_id)).toBe(true)
    expect(kernel.texGetBuild(first.build!.build_id).status).toBe('running')
    kernel.texWriteFile(document_id, 'paper.tex', '\\documentclass{article}\n\\begin{document}v2\\end{document}\n')
    const second = flushPreview(kernel, document_id)
    const old = kernel.texGetBuild(first.build!.build_id)
    expect(old.status).toBe('superseded')
    expect(old.superseded_by).toBe(second.build!.build_id)
    expect(old.superseded_at).not.toBeNull()
    expect(kernel.getJob(first.job!.job_id).status).toBe('cancelled')
    // Superseded previews are FINAL: a late completion attempt is fenced out.
    try {
      kernel.completeJob({
        job_id: first.job!.job_id,
        owner: 'test-runner',
        ...fenceArgs(kernel, first.job!.job_id),
        status: 'succeeded',
        run_manifest: { ...manifestIdentity(kernel, first.job!.job_id), exit_code: 0, tex_diagnostics: [] },
      })
      throw new Error('expected job_not_running')
    } catch (error) {
      expect((error as { code?: string }).code).toBe('job_not_running')
    }
    expect(kernel.texGetBuild(first.build!.build_id).status).toBe('superseded')
    kernel.close()
  })

  it('terminal previews are left untouched by later supersedes (succeeded stays succeeded)', () => {
    const kernel = freshKernel()
    const { project_id, document_id } = setupDoc(kernel)
    const first = flushPreview(kernel, document_id)
    kernel.claimJobs('test-runner', 300, 8)
    const pdf = kernel.registerArtifact({ project_id, kind: 'pdf', content: '%PDF-1.4 done', media_type: 'application/pdf' })
    const log = kernel.registerArtifact({ project_id, kind: 'log', content: 'This is pdfTeX', media_type: 'text/plain' })
    kernel.completeJob({
      job_id: first.job!.job_id,
      owner: 'test-runner',
      ...fenceArgs(kernel, first.job!.job_id),
      status: 'succeeded',
      run_manifest: {
        // §5 RUN-REMOTE-01: secure kinds 必须携带 claim 的 run_id + metrics_artifact。
        ...manifestIdentity(kernel, first.job!.job_id),
        exit_code: 0,
        metrics_artifact: log.artifact_id,
        container_digest: `docker:${kernel.getJob(first.job!.job_id).image_digest}`,
        tex_pdf_artifact: pdf.artifact_id, tex_log_artifact: log.artifact_id,
        tex_diagnostics: [{ level: 'warning', message: 'Overfull \\hbox' }],
        tex: { document_id, revision: first.revision, root_file: 'paper.tex' },
      },
    })
    expect(kernel.texGetBuild(first.build!.build_id).status).toBe('succeeded')
    expect(kernel.texGetBuild(first.build!.build_id).pdf_artifact).toBe(pdf.artifact_id)
    // A newer revision's preview supersedes only non-terminal previews.
    kernel.texWriteFile(document_id, 'paper.tex', '\\documentclass{article}\n\\begin{document}v2\\end{document}\n')
    const second = flushPreview(kernel, document_id)
    const done = kernel.texGetBuild(first.build!.build_id)
    expect(done.status).toBe('succeeded')
    expect(done.superseded_by).toBeNull()
    // But its PDF is stale: the document moved on.
    expect(done.stale).toBe(true)
    expect(kernel.texGetBuild(second.build!.build_id).stale).toBe(false)
    kernel.close()
  })

  it('authoritative builds also expose the stale flag (build.revision < document.revision)', () => {
    const kernel = freshKernel()
    const { project_id, document_id } = setupDoc(kernel)
    const snap = kernel.texSnapshot(document_id)
    const job = kernel.submitJob({
      project_id,
      idempotency_key: `latex:${document_id}:${snap.revision}`,
      kind: 'latex-compile',
      payload: { tex_document_id: document_id, tex_revision: snap.revision },
    })
    const build = kernel.texCreateBuild(document_id, snap.revision, 'paper.tex', job.job_id)
    expect(kernel.texGetBuild(build.build_id).stale).toBe(false)
    kernel.texWriteFile(document_id, 'paper.tex', '\\documentclass{article}\n\\begin{document}v2\\end{document}\n')
    const view = kernel.texGetBuild(build.build_id)
    expect(view.revision).toBe(snap.revision)
    expect(view.stale).toBe(true)
    expect(kernel.texListBuilds(document_id)[0]!.stale).toBe(true)
    kernel.close()
  })
})

describe('TEX-03 preview: authoritative separation', () => {
  it('an explicit Compile supersedes every non-terminal preview and is never blocked by previews', () => {
    const kernel = freshKernel()
    const { project_id, document_id } = setupDoc(kernel)
    const first = flushPreview(kernel, document_id)
    kernel.claimJobs('test-runner', 300, 8)
    expect(kernel.texGetBuild(first.build!.build_id).status).toBe('running')
    // Explicit authoritative Compile: freezes its OWN manifest at the
    // current revision and creates the authoritative build row.
    const snap = kernel.texSnapshot(document_id)
    const authJob = kernel.submitJob({
      project_id,
      idempotency_key: `latex:${document_id}:${snap.revision}:pdflatex`,
      kind: 'latex-compile',
      command: ['pdflatex', '-interaction=nonstopmode', 'paper.tex'],
      payload: { tex_document_id: document_id, tex_revision: snap.revision, tex_snapshot: snap.manifest },
    })
    const authBuild = kernel.texCreateBuild(document_id, snap.revision, 'paper.tex', authJob.job_id)
    const superseded = kernel.texSupersedePreviews(document_id, authBuild.build_id)
    expect(superseded.map(b => b.build_id)).toContain(first.build!.build_id)
    const old = kernel.texGetBuild(first.build!.build_id)
    expect(old.status).toBe('superseded')
    expect(old.superseded_by).toBe(authBuild.build_id)
    expect(kernel.getJob(first.job!.job_id).status).toBe('cancelled')
    // The authoritative job is untouched by previews.
    expect(kernel.getJob(authJob.job_id).status).toBe('queued')
    // A later preview request while the authoritative compile is active is
    // skipped — previews never queue a redundant container run behind it.
    kernel.texRequestPreview(document_id, { debounce_ms: 5 })
    const skipped = kernel.texFlushPreview(document_id)
    expect(skipped.action).toBe('skipped_authoritative')
    // No live (queued/running) preview remains: the superseded one is final.
    expect(kernel.texPreviewStatus(document_id).builds.filter(b => b.status === 'queued' || b.status === 'running')).toHaveLength(0)
    kernel.close()
  })

  it('preview completions produce NO Evidence and no claims (not part of the manifest chain)', () => {
    const kernel = freshKernel()
    const { project_id, document_id } = setupDoc(kernel)
    const preview = flushPreview(kernel, document_id)
    kernel.claimJobs('test-runner', 300, 8)
    const pdf = kernel.registerArtifact({ project_id, kind: 'pdf', content: '%PDF-1.4 preview', media_type: 'application/pdf' })
    const log = kernel.registerArtifact({ project_id, kind: 'log', content: 'log', media_type: 'text/plain' })
    kernel.completeJob({
      job_id: preview.job!.job_id,
      owner: 'test-runner',
      ...fenceArgs(kernel, preview.job!.job_id),
      status: 'succeeded',
      run_manifest: {
        ...manifestIdentity(kernel, preview.job!.job_id),
        exit_code: 0,
        metrics_artifact: log.artifact_id,
        container_digest: `docker:${kernel.getJob(preview.job!.job_id).image_digest}`,
        tex_pdf_artifact: pdf.artifact_id, tex_log_artifact: log.artifact_id,
        tex_diagnostics: [],
        tex: { document_id, revision: preview.revision, root_file: 'paper.tex' },
      },
    })
    const build = kernel.texGetBuild(preview.build!.build_id)
    expect(build.status).toBe('succeeded')
    expect(build.pdf_artifact).toBe(pdf.artifact_id)
    expect(build.log_artifact).toBe(log.artifact_id)
    expect(build.preview).toBe(true)
    // A successful preview still writes NO Evidence and NO claims — previews
    // never enter the authoritative ledger.
    expect(kernel.listEvidence(project_id)).toHaveLength(0)
    expect(kernel.listClaims(project_id)).toHaveLength(0)
    // And the authoritative surface stays separate: a fresh authoritative
    // compile freezes its own manifest revision, not the preview's.
    const snap = kernel.texSnapshot(document_id)
    expect(snap.revision).toBe(build.revision)
    const authJob = kernel.submitJob({
      project_id,
      idempotency_key: `latex:${document_id}:${snap.revision}`,
      kind: 'latex-compile',
      payload: { tex_document_id: document_id, tex_revision: snap.revision, tex_snapshot: snap.manifest },
    })
    const authBuild = kernel.texCreateBuild(document_id, snap.revision, 'paper.tex', authJob.job_id)
    expect(authBuild.preview).toBe(false)
    expect((authJob.payload as Record<string, unknown>).preview).toBeUndefined()
    expect((authJob.payload as Record<string, unknown>).tex_revision).toBe(snap.revision)
    expect(kernel.texListBuilds(document_id).map(b => b.build_id)).toEqual([authBuild.build_id])
    kernel.close()
  })
})

describe('TEX-03 preview: HTTP surface', () => {
  it('POST/GET /v1/documents/{id}/preview-builds + authoritative separation over HTTP', async () => {
    const kernel = freshKernel()
    const { server, url } = await startKernelServer({ kernel, host: '127.0.0.1', port: 0 })
    try {
      const projResp = await fetch(`${url}/v1/projects`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 't', workspace: '/w', brief: makeBrief() }),
      })
      const project = (await projResp.json()) as { project_id: string }
      const docResp = await fetch(`${url}/v1/projects/${project.project_id}/manuscript-drafts`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
      })
      const doc = (await docResp.json()) as { document_id: string }
      await fetch(`${url}/v1/documents/${doc.document_id}/file`, {
        method: 'PUT', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ path: 'paper.tex', content: '\\documentclass{article}\n\\begin{document}A\\end{document}\n' }),
      })
      // Save-success hook: POST preview-builds returns the durable pending
      // record with the debounce window.
      const reqResp = await fetch(`${url}/v1/documents/${doc.document_id}/preview-builds`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ debounce_ms: 40 }),
      })
      expect(reqResp.status).toBe(200)
      const req = (await reqResp.json()) as { pending: { document_id: string; debounce_ms: number; revision: number } }
      expect(req.pending.document_id).toBe(doc.document_id)
      expect(req.pending.debounce_ms).toBe(40)
      // While the debounce is pending the projection exposes it.
      let status = (await (await fetch(`${url}/v1/documents/${doc.document_id}/preview-builds`)).json()) as {
        pending: { document_id: string } | null; builds: Array<{ status: string; preview: boolean }>
      }
      expect(status.pending?.document_id).toBe(doc.document_id)
      // Bad engine → 422 before any pending state is created.
      const badResp = await fetch(`${url}/v1/documents/${doc.document_id}/preview-builds`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ engine: 'rm -rf /' }),
      })
      expect(badResp.status).toBe(422)
      expect(((await badResp.json()) as { error: { code: string } }).error.code).toBe('engine_invalid')
      // Wait for the debounce → the preview build materializes.
      await sleep(150)
      status = (await (await fetch(`${url}/v1/documents/${doc.document_id}/preview-builds`)).json()) as {
        pending: { document_id: string } | null; builds: Array<{ build_id: string; status: string; preview: boolean; stale: boolean; revision: number; job_id: string | null }>
      }
      expect(status.pending).toBeNull()
      expect(status.builds).toHaveLength(1)
      expect(status.builds[0]).toMatchObject({ status: 'queued', preview: true, stale: false })
      expect(status.builds[0]!.job_id).not.toBeNull()
      // The authoritative builds surface is SEPARATE: no previews there.
      const builds = (await (await fetch(`${url}/v1/documents/${doc.document_id}/builds`)).json()) as Array<{ preview: boolean }>
      expect(builds).toHaveLength(0)
      // GET a single build (authoritative or preview) carries the fields.
      const single = (await (await fetch(`${url}/v1/documents/${doc.document_id}/builds/${status.builds[0]!.build_id}`)).json()) as {
        preview: boolean; status: string; stale: boolean; job_id: string | null
      }
      expect(single).toMatchObject({ preview: true, status: 'queued', stale: false })
      expect(single.job_id).toBe(status.builds[0]!.job_id)
      // Explicit Compile → 201, and it supersedes the preview over HTTP.
      const rev = ((await (await fetch(`${url}/v1/documents/${doc.document_id}/tree`)).json()) as { document: { revision: number } }).document.revision
      const authResp = await fetch(`${url}/v1/documents/${doc.document_id}/builds`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ expected_document_revision: rev, root_file: 'paper.tex' }),
      })
      expect(authResp.status).toBe(201)
      const auth = (await authResp.json()) as { build: { build_id: string; preview: boolean }; job: { job_id: string; kind: string } }
      expect(auth.build.preview).toBe(false)
      expect(auth.job.kind).toBe('latex-compile')
      const after = (await (await fetch(`${url}/v1/documents/${doc.document_id}/preview-builds`)).json()) as {
        builds: Array<{ status: string; superseded_by: string | null; stale: boolean }>
      }
      expect(after.builds[0]!.status).toBe('cancelled')
      expect(after.builds[0]!.superseded_by).toBe(auth.build.build_id)
      expect(after.builds[0]!.stale).toBe(false) // document revision did not move since the preview froze
      // Authoritative list shows exactly the authoritative build.
      const authList = (await (await fetch(`${url}/v1/documents/${doc.document_id}/builds`)).json()) as Array<{ build_id: string; preview: boolean; stale: boolean }>
      expect(authList.map(b => b.build_id)).toEqual([auth.build.build_id])
      expect(authList[0]!.preview).toBe(false)
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()))
      kernel.close()
    }
  })
})
