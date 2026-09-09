/**
 * TEX-02 chain tests: frozen TeX snapshot → latex-compile job payload →
 * runner materialization (hash-verified, traversal-safe) → build script →
 * completion manifest → tex_builds row finalized with PDF/log/diagnostics.
 * The container image run itself is covered by evals/latex-compile-e2e.sh
 * (needs docker + the fixed TeX image).
 */
import { describe, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { ResearchKernel, startKernelServer } from '@dsh-scholar/research-kernel'
import { ConfiguredTestKernel } from './configured-test-kernel.js'
import {
  materializeTexWorkspace, parseLatexDiagnostics, buildLatexRunScript,
  type TexSnapshotManifest,
} from '@dsh-scholar/runner-gateway'

function freshKernel(): ResearchKernel {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-texbuild-test-'))
  return new ConfiguredTestKernel({ dbPath: join(dir, 'kernel.db'), casRoot: join(dir, 'cas'), requireSignedManifest: false })
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

function makeBrief() {
  return {
    problem: 'p', scope: 's', questions: [], primary_metrics: ['m'],
    resources: '', risks: [], target_outputs: ['paper'], target_venue: null,
    baseline_repo: null, domain: 'ml',
  }
}

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex')
}

/** P0 (acceptance-tests.md §4): the exact texlive digest pinned by configs/runner-profiles/images.lock.json. */
const TEXLIVE_IMAGE_DIGEST = 'texlive/texlive@sha256:8957c916b8160049f89c24d362a6d86c09d8a04095acde37e88404c4afed85b4'

describe('latex-compile chain (TEX-02)', () => {
  it('replays one compile request without creating an orphan queued build', async () => {
    const kernel = freshKernel()
    const project = kernel.createProject({ name: 'compile-replay', workspace: '/w', brief: makeBrief() })
    const doc = kernel.texEnsure(project.project_id)
    kernel.texWriteFile(doc.document_id, 'paper.tex', '\\documentclass{article}\n\\begin{document}hi\\end{document}\n')
    const revision = kernel.texTree(doc.document_id).document.revision
    const { server, url } = await startKernelServer({ kernel, host: '127.0.0.1', port: 0 })
    try {
      const profilesResponse = await fetch(`${url}/v1/runner-profiles`)
      expect(profilesResponse.status).toBe(200)
      expect(await profilesResponse.json()).toContainEqual(expect.objectContaining({
        profile_id: 'profile_local_docker_cpu_v1', runner_mode: 'local-docker', enabled: true,
      }))
      const submit = async (idempotencyKey: string) => {
        const response = await fetch(`${url}/v1/documents/${doc.document_id}/builds`, {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ expected_document_revision: revision, idempotency_key: idempotencyKey }),
        })
        expect(response.status).toBe(201)
        return await response.json() as { build: { build_id: string; status: string }; job: { job_id: string } }
      }
      const first = await submit('one-user-compile')
      kernel.texUpdateBuild(first.build.build_id, { status: 'failed', diagnostics: '[{"level":"error","message":"test failure"}]' })
      const replay = await submit('one-user-compile')
      expect(replay.job.job_id).toBe(first.job.job_id)
      expect(replay.build.build_id).toBe(first.build.build_id)
      expect(replay.build.status).toBe('failed')
      expect(kernel.texListBuilds(doc.document_id)).toHaveLength(1)
      const retry = await submit('new-user-compile')
      expect(retry.job.job_id).not.toBe(first.job.job_id)
      expect(retry.build.status).toBe('queued')
      expect(kernel.texListBuilds(doc.document_id)).toHaveLength(2)
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()))
      kernel.close()
    }
  })

  it('submitJob carries the frozen snapshot manifest for latex-compile', () => {
    const kernel = freshKernel()
    const project = kernel.createProject({ name: 't', workspace: '/w', brief: makeBrief() })
    const doc = kernel.texEnsure(project.project_id)
    kernel.texWriteFile(doc.document_id, 'paper.tex', '\\documentclass{article}\n\\begin{document}hi\\end{document}\n')
    const snap = kernel.texSnapshot(doc.document_id)
    expect(snap.manifest.files.length).toBe(1)
    const job = kernel.submitJob({
      project_id: project.project_id,
      idempotency_key: 'latex:t:1',
      kind: 'latex-compile',
      command: ['pdflatex', '-interaction=nonstopmode', 'paper.tex'],
      payload: { tex_document_id: doc.document_id, tex_revision: snap.revision, tex_snapshot: snap.manifest },
    })
    expect(job.kind).toBe('latex-compile')
    const payload = job.payload as Record<string, unknown>
    expect(payload.tex_document_id).toBe(doc.document_id)
    // P0: the kernel injects the LOCKED texlive digest — never a tag.
    expect(payload.image_digest).toBe(TEXLIVE_IMAGE_DIGEST)
    const manifest = payload.tex_snapshot as TexSnapshotManifest
    expect(manifest.document_id).toBe(doc.document_id)
    expect(manifest.files[0]!.path).toBe('paper.tex')
    expect(manifest.files[0]!.content_hash).toBe(sha256('\\documentclass{article}\n\\begin{document}hi\\end{document}\n'))
    kernel.close()
  })

  it('materializes the FROZEN snapshot bytes with hash verification and traversal protection (TEX-01)', async () => {
    const workDir = mkdtempSync(join(tmpdir(), 'dsh-texmat-'))
    mkdirSync(join(workDir, 'sections'), { recursive: true })
    const content = '\\section{Intro}\n'
    const manifest: TexSnapshotManifest = {
      schema_version: 1,
      document_id: 'doc_t',
      revision: 3,
      root_file: 'paper.tex',
      files: [
        { path: 'paper.tex', version: 3, content_hash: sha256('\\documentclass{article}\n') },
        { path: 'sections/intro.tex', version: 2, content_hash: sha256(content) },
      ],
    }
    // The runner talks ONLY to the kernel's snapshot store (revision-scoped
    // bytes) — there is no current-file read at all.
    const fakeClient = {
      getDocumentSnapshotFile: async (docId: string, revision: number, path: string) => {
        if (docId !== 'doc_t' || revision !== 3) return null
        if (path === 'paper.tex') return { path, content: '\\documentclass{article}\n', content_hash: sha256('\\documentclass{article}\n') }
        if (path === 'sections/intro.tex') return { path, content, content_hash: sha256(content) }
        return null
      },
    }
    const count = await materializeTexWorkspace(fakeClient, manifest, workDir)
    expect(count).toBe(2)
    expect(readFile(join(workDir, 'paper.tex'))).toBe('\\documentclass{article}\n')
    expect(readFile(join(workDir, 'sections/intro.tex'))).toBe(content)
    // Negative TEX-01: a snapshot revision with no frozen bytes fails closed
    // (the runner must NOT fall back to the current file)…
    const stale: TexSnapshotManifest = { ...manifest, revision: 4 }
    await expect(materializeTexWorkspace(fakeClient, stale, workDir)).rejects.toThrow(/revision 4/)
    // …an unreadable path is a hard error…
    const missing: TexSnapshotManifest = { ...manifest, files: [{ path: 'gone.tex', version: 1, content_hash: '' }] }
    await expect(materializeTexWorkspace(fakeClient, missing, workDir)).rejects.toThrow(/unreadable from kernel/)
    // …and snapshot bytes that do not match the manifest hash are rejected
    // (frozen bytes are still hash-verified against the manifest).
    const tamperedClient = {
      ...fakeClient,
      getDocumentSnapshotFile: async (docId: string, revision: number, path: string) => {
        if (docId !== 'doc_t' || revision !== 3) return null
        if (path === 'paper.tex') return { path, content: 'TAMPERED', content_hash: sha256('TAMPERED') }
        return null
      },
    }
    await expect(materializeTexWorkspace(tamperedClient, manifest, workDir)).rejects.toThrow(/integrity mismatch/)
    // Traversal path rejected before any fetch.
    const evil: TexSnapshotManifest = { ...manifest, files: [{ path: '../escape.tex', version: 1, content_hash: '' }] }
    await expect(materializeTexWorkspace(fakeClient, evil, workDir)).rejects.toThrow(/unsafe path/)
    // Unsafe root_file rejected.
    const badRoot: TexSnapshotManifest = { ...manifest, root_file: 'a; rm -rf /' }
    await expect(materializeTexWorkspace(fakeClient, badRoot, workDir)).rejects.toThrow(/unsafe/)
  })

  it('parses pdflatex diagnostics into structured entries', () => {
    const log = [
      'This is pdfTeX, Version 3.141592653',
      '! Undefined control sequence.',
      'l.5 \\foobar',
      '',
      'LaTeX Warning: Citation `x\' on page 1 undefined on input line 9.',
      'Overfull \\hbox (12.3pt too wide) in paragraph at lines 20--21',
      'Underfull \\vbox (badness 10000)',
      '',
    ].join('\n')
    const diag = parseLatexDiagnostics(log)
    expect(diag.length).toBe(3)
    expect(diag[0]).toMatchObject({ level: 'error' })
    expect(diag[0]!.message).toContain('Undefined control sequence')
    expect(diag[1]!.message).toContain('Overfull')
    expect(diag[2]!.message).toContain('Underfull')
    expect(parseLatexDiagnostics('nothing here')).toEqual([])
  })

  it('builds the fixed-image compile script (pdflatex×3 + bibtex → /outputs)', () => {
    const script = buildLatexRunScript('paper.tex', 'pdflatex', ['paper.tex', 'sections/intro.tex'])
    expect(script).toContain('cp -R "/work/paper.tex" "$OUT/work/"')
    expect(script).toContain('cp -R "/work/sections/intro.tex" "$OUT/work/"')
    // The /work tree must never be copied wholesale: its /outputs sub-mount
    // would make cp recurse into its own destination.
    expect(script).not.toContain('cp -R /work/.')
    expect(script).toContain('chmod 777 "$OUT/work"')
    expect(script).toContain('cd "$OUT/work"')
    expect(script).toContain('pdflatex -interaction=nonstopmode -halt-on-error -file-line-error -recorder -no-shell-escape "$ROOT.tex"')
    expect(script).toContain('bibtex "$ROOT"')
    expect(script).toContain('cp "$ROOT.pdf" "$OUT/paper.pdf"')
    expect(script).toContain('cp "$ROOT.log" "$OUT/tex.log"')
    expect(script).toContain('"$ROOT.aux"')
  })

  it('HTTP routes accept expected_version=0 as create-if-absent (acceptance-tests.md §7 ui-new-file)', async () => {
    const kernel = freshKernel()
    const { server, url } = await startKernelServer({ kernel, host: '127.0.0.1', port: 0 })
    try {
      // Project + TeX workspace.
      const projResp = await fetch(`${url}/v1/projects`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 't', workspace: '/w', brief: makeBrief() }),
      })
      expect(projResp.status).toBe(201)
      const project = (await projResp.json()) as { project_id: string }
      const docResp = await fetch(`${url}/v1/projects/${project.project_id}/manuscript-drafts`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
      })
      expect(docResp.status).toBe(200)
      const doc = (await docResp.json()) as { document_id: string }

      // PUT with expected_version=0 on a fresh path: must NOT be 422 — the UI
      // "new file" flow sends 0 (create-if-absent) and a positive-only schema
      // would reject it.
      const createResp = await fetch(`${url}/v1/documents/${doc.document_id}/file`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ path: 'sections/notes.tex', content: '\\section{Notes}\n', expected_version: 0 }),
      })
      expect(createResp.status).toBe(200)
      const created = (await createResp.json()) as { version: number; content_hash: string }
      expect(created.version).toBe(1)

      // tree/GET: path/kind/media/version present and correct.
      const treeResp = await fetch(`${url}/v1/documents/${doc.document_id}/tree`)
      expect(treeResp.status).toBe(200)
      const tree = (await treeResp.json()) as { files: Array<{ path: string; kind: string; media: string; version: number }> }
      expect(tree.files.find(f => f.path === 'sections/notes.tex')).toMatchObject({
        path: 'sections/notes.tex', kind: 'tex', media: 'text/x-tex', version: 1,
      })

      // Same path again with 0 → 409 create-if-absent conflict.
      const conflictResp = await fetch(`${url}/v1/documents/${doc.document_id}/file`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ path: 'sections/notes.tex', content: 'x', expected_version: 0 }),
      })
      expect(conflictResp.status).toBe(409)
      expect(((await conflictResp.json()) as { error: { code: string } }).error.code).toBe('document_version_conflict')

      // expected_version = current version → 200, new revision (version 2).
      const saveResp = await fetch(`${url}/v1/documents/${doc.document_id}/file`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ path: 'sections/notes.tex', content: '\\section{Notes v2}\n', expected_version: 1 }),
      })
      expect(saveResp.status).toBe(200)
      expect(((await saveResp.json()) as { version: number }).version).toBe(2)

      // expected_version = stale version → 409.
      const staleResp = await fetch(`${url}/v1/documents/${doc.document_id}/file`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ path: 'sections/notes.tex', content: 'x', expected_version: 1 }),
      })
      expect(staleResp.status).toBe(409)
      expect(((await staleResp.json()) as { error: { code: string } }).error.code).toBe('document_version_conflict')

      // DELETE ?expected_version=0 must survive the query parse (0 never
      // matches a stored version ≥ 1) → 409, not an unchecked delete.
      const delResp = await fetch(`${url}/v1/documents/${doc.document_id}/file?path=${encodeURIComponent('sections/notes.tex')}&expected_version=0`, { method: 'DELETE' })
      expect(delResp.status).toBe(409)
      expect(((await delResp.json()) as { error: { code: string } }).error.code).toBe('document_version_conflict')
      // The conflict left the file intact at version 2.
      const after = await fetch(`${url}/v1/documents/${doc.document_id}/file?path=${encodeURIComponent('sections/notes.tex')}`)
      expect(((await after.json()) as { version: number }).version).toBe(2)
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()))
      kernel.close()
    }
  })

  it('HTTP GET /v1/documents/{id}/snapshot-files serves FROZEN bytes at the frozen revision (TEX-01)', async () => {
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
      const original = '\\documentclass{article}\n\\begin{document}FROZEN\\end{document}\n'
      await fetch(`${url}/v1/documents/${doc.document_id}/file`, {
        method: 'PUT', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ path: 'paper.tex', content: original }),
      })
      const snapResp = await fetch(`${url}/v1/documents/${doc.document_id}/snapshots`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
      })
      expect(snapResp.status).toBe(200)
      const snap = (await snapResp.json()) as { revision: number; manifest: { files: Array<{ path: string; content_hash: string }> } }
      // The CURRENT file moves on after freeze…
      await fetch(`${url}/v1/documents/${doc.document_id}/file`, {
        method: 'PUT', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ path: 'paper.tex', content: original.replace('FROZEN', 'CHANGED') }),
      })
      // …the snapshot-files route still serves the FROZEN bytes, hash-verified.
      const frozenResp = await fetch(`${url}/v1/documents/${doc.document_id}/snapshot-files?revision=${snap.revision}&path=${encodeURIComponent('paper.tex')}`)
      expect(frozenResp.status).toBe(200)
      const frozen = (await frozenResp.json()) as { content: string; content_hash: string }
      expect(frozen.content).toBe(original)
      const paperEntry = snap.manifest.files.find(f => f.path === 'paper.tex')
      expect(paperEntry).toBeDefined()
      expect(frozen.content_hash).toBe(paperEntry!.content_hash)
      // Unknown path / revision → 404; bad params → 422 (fail-closed, never
      // a fallback to the current file).
      expect((await fetch(`${url}/v1/documents/${doc.document_id}/snapshot-files?revision=${snap.revision}&path=${encodeURIComponent('nope.tex')}`)).status).toBe(404)
      expect((await fetch(`${url}/v1/documents/${doc.document_id}/snapshot-files?revision=999&path=${encodeURIComponent('paper.tex')}`)).status).toBe(404)
      expect((await fetch(`${url}/v1/documents/${doc.document_id}/snapshot-files?revision=abc&path=${encodeURIComponent('paper.tex')}`)).status).toBe(422)
      expect((await fetch(`${url}/v1/documents/${doc.document_id}/snapshot-files?path=${encodeURIComponent('paper.tex')}`)).status).toBe(422)
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()))
      kernel.close()
    }
  })

  it('HTTP: a save conflict (409) then compile at the stale revision is rejected — no job, no build row', async () => {
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
      const snapResp = await fetch(`${url}/v1/documents/${doc.document_id}/snapshots`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
      })
      const snap = (await snapResp.json()) as { revision: number }
      // Concurrent save (the "other editor") bumps the document revision —
      // the local editor's own save would 409 on expected_version.
      await fetch(`${url}/v1/documents/${doc.document_id}/file`, {
        method: 'PUT', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ path: 'paper.tex', content: '\\documentclass{article}\n\\begin{document}B\\end{document}\n' }),
      })
      // Compile with the STALE expected_document_revision must be rejected
      // (409 document_version_conflict) BEFORE any job is created.
      const buildResp = await fetch(`${url}/v1/documents/${doc.document_id}/builds`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ expected_document_revision: snap.revision, root_file: 'paper.tex' }),
      })
      expect(buildResp.status).toBe(409)
      expect(((await buildResp.json()) as { error: { code: string } }).error.code).toBe('document_version_conflict')
      // No latex-compile job was queued and no build row exists: the compile
      // cannot produce a PDF for the stale revision.
      const jobsResp = await fetch(`${url}/v1/projects/${project.project_id}/jobs`)
      const jobs = (await jobsResp.json()) as Array<{ kind: string }>
      expect(jobs.filter(j => j.kind === 'latex-compile')).toHaveLength(0)
      const buildsResp = await fetch(`${url}/v1/documents/${doc.document_id}/builds`)
      expect(((await buildsResp.json()) as unknown[])).toHaveLength(0)
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()))
      kernel.close()
    }
  })

  it('finalizes the tex_builds row on latex-compile completion', () => {
    const kernel = freshKernel()
    const project = kernel.createProject({ name: 't', workspace: '/w', brief: makeBrief() })
    const doc = kernel.texEnsure(project.project_id)
    kernel.texWriteFile(doc.document_id, 'paper.tex', '\\documentclass{article}\n\\begin{document}hi\\end{document}\n')
    const snap = kernel.texSnapshot(doc.document_id)
    const job = kernel.submitJob({
      project_id: project.project_id,
      idempotency_key: 'latex:t:2',
      kind: 'latex-compile',
      command: ['pdflatex', 'paper.tex'],
      payload: { tex_document_id: doc.document_id, tex_revision: snap.revision, tex_snapshot: snap.manifest },
    })
    const build = kernel.texCreateBuild(doc.document_id, snap.revision, 'paper.tex', job.job_id)
    expect(build.status).toBe('queued')
    // The runner claims the job, registers the outcome artifacts, completes.
    kernel.claimJobs('test-runner', 300, 8)
    const pdf = kernel.registerArtifact({ project_id: project.project_id, kind: 'pdf', content: '%PDF-1.4 fake', media_type: 'application/pdf', file_name: 'paper.pdf' })
    const log = kernel.registerArtifact({ project_id: project.project_id, kind: 'log', content: '! Undefined control sequence.\nl.5 \\foobar\n', media_type: 'text/plain' })
    const done = kernel.completeJob({
      job_id: job.job_id,
      owner: 'test-runner',
      ...fenceArgs(kernel, job.job_id),
      status: 'succeeded',
      run_manifest: {
        // §5 RUN-REMOTE-01: secure kinds 的 manifest 必须携带 claim 的 run_id
        // + metrics_artifact（local runner 对 latex-compile 同样注册 metrics
        // artifact——kernel verifySecureRunFacts 强制）。
        ...manifestIdentity(kernel, job.job_id),
        exit_code: 0,
        metrics_artifact: log.artifact_id,
        container_digest: `docker:${kernel.getJob(job.job_id).image_digest}`,
        tex_pdf_artifact: pdf.artifact_id,
        tex_log_artifact: log.artifact_id,
        tex_diagnostics: [{ level: 'error', message: 'Undefined control sequence' }],
        tex: { document_id: doc.document_id, revision: snap.revision, root_file: 'paper.tex' },
      },
    })
    expect(done.status).toBe('succeeded')
    const updated = kernel.texGetBuild(build.build_id)
    expect(updated.status).toBe('succeeded')
    expect(updated.pdf_artifact).toBe(pdf.artifact_id)
    expect(updated.log_artifact).toBe(log.artifact_id)
    expect(updated.finished_at).not.toBeNull()
    const parsed = JSON.parse(updated.diagnostics) as Array<{ level: string; message: string }>
    expect(parsed[0]!.level).toBe('error')
    // Failure finalizes as failed.
    const job2 = kernel.submitJob({
      project_id: project.project_id,
      idempotency_key: 'latex:t:3',
      kind: 'latex-compile',
      command: ['pdflatex', 'paper.tex'],
      payload: { tex_document_id: doc.document_id, tex_revision: snap.revision, tex_snapshot: snap.manifest },
    })
    const build2 = kernel.texCreateBuild(doc.document_id, snap.revision, 'paper.tex', job2.job_id)
    kernel.claimJobs('test-runner', 300, 8)
    kernel.completeJob({
      job_id: job2.job_id,
      owner: 'test-runner',
      ...fenceArgs(kernel, job2.job_id),
      status: 'failed',
      failure_class: 'code_error',
      error: 'pdflatex halted on error',
      run_manifest: { ...manifestIdentity(kernel, job2.job_id), exit_code: 1, tex_diagnostics: [{ level: 'error', message: 'halted' }] },
    })
    expect(kernel.texGetBuild(build2.build_id).status).toBe('failed')
    kernel.close()
  })
})

function readFile(p: string): string {
  return require('node:fs').readFileSync(p, 'utf8')
}
