/**
 * TeX kernel acceptance tests (acceptance-tests.md §7, kernel-layer items):
 *  - structured diagnostics with file/line (latex error, undefined citation,
 *    missing file) — direct parser + kernel log-artifact enrichment at
 *    latex-compile completion (TEX-DIAG);
 *  - compile freezes the current manifest: later edits cannot change the
 *    frozen snapshot (dirty-before-compile / freeze semantics);
 *  - build history replays log/PDF artifacts (CAS download);
 *  - freshness info for stale-PDF detection (build.revision vs
 *    document.revision).
 */
import { describe, expect, it } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ResearchKernel, parseLatexDiagnostics, type LatexDiagnostic } from '@dsh-scholar/research-kernel'
import type { TexSnapshotManifest } from '@dsh-scholar/runner-gateway'
import { ConfiguredTestKernel } from './configured-test-kernel.js'

function freshKernel(): ResearchKernel {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-tex-kernel-'))
  return new ConfiguredTestKernel({ dbPath: join(dir, 'kernel.db'), casRoot: join(dir, 'cas'), requireSignedManifest: false })
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

/** Realistic pdflatex log: classic `!` errors, -file-line-error prefix,
 * undefined citation/reference warnings, Overfull noise. */
const SAMPLE_LOG = [
  'This is pdfTeX, Version 3.141592653 (TeX Live 2024)',
  '(./paper.tex',
  'LaTeX2e <2024-11-01> patch level 3',
  '(./sections/intro.tex',
  '! Undefined control sequence.',
  'l.12 \\foobar',
  ')',
  '! LaTeX Error: File `missing.sty\' not found.',
  ')',
  './paper.tex:20: LaTeX Warning: Citation `knuth84\' on page 1 undefined on input line 20.',
  'LaTeX Warning: Reference `fig:plot\' on page 1 undefined on input line 21.',
  'Overfull \\hbox (12.3pt too wide) in paragraph at lines 20--21',
  '',
].join('\n')

describe('tex diagnostics: file/line + structured kinds (§7)', () => {
  it('parses file:line locations and structured kinds from a pdflatex log', () => {
    const diag = parseLatexDiagnostics(SAMPLE_LOG)
    // 1. classic ! error inside sections/intro.tex with l.<n> line
    const first = diag.find(d => d.message.includes('Undefined control sequence'))
    expect(first).toBeDefined()
    expect(first!.level).toBe('error')
    expect(first!.kind).toBe('latex_error')
    expect(first!.file).toBe('sections/intro.tex')
    expect(first!.line).toBe(12)
    // 2. missing file -> structured missing_file diagnostic
    const missing = diag.find(d => d.kind === 'missing_file')
    expect(missing).toBeDefined()
    expect(missing!.level).toBe('error')
    expect(missing!.missing).toBe('missing.sty')
    expect(missing!.file).toBe('missing.sty')
    // 3. undefined citation -> warning with citation + line (file:line prefix)
    const citation = diag.find(d => d.kind === 'undefined_citation')
    expect(citation).toBeDefined()
    expect(citation!.level).toBe('warning')
    expect(citation!.citation).toBe('knuth84')
    expect(citation!.file).toBe('paper.tex')
    expect(citation!.line).toBe(20)
    // 4. undefined reference -> warning with citation + line
    const reference = diag.find(d => d.kind === 'undefined_reference')
    expect(reference).toBeDefined()
    expect(reference!.citation).toBe('fig:plot')
    expect(reference!.line).toBe(21)
    // 5. Overfull stays a plain warning
    const overfull = diag.find(d => d.message.includes('Overfull'))
    expect(overfull!.level).toBe('warning')
    expect(overfull!.kind).toBe('warning')
    // No-match log -> empty (bounded, no crash)
    expect(parseLatexDiagnostics('nothing here')).toEqual([])
    expect(parseLatexDiagnostics(SAMPLE_LOG).length).toBeLessThanOrEqual(200)
  })

  it('parses the -file-line-error prefix as an error with file/line', () => {
    const diag = parseLatexDiagnostics('./paper.tex:12: Undefined control sequence.\nl.12 \\foobar\n')
    expect(diag[0]).toMatchObject({
      level: 'error', kind: 'latex_error', file: 'paper.tex', line: 12,
    } satisfies Partial<LatexDiagnostic>)
  })

  it('kernel enriches tex_builds diagnostics from the log artifact at completion', () => {
    const kernel = freshKernel()
    const project = kernel.createProject({ name: 't', workspace: '/w', brief: makeBrief() })
    const doc = kernel.texEnsure(project.project_id)
    kernel.texWriteFile(doc.document_id, 'paper.tex', '\\documentclass{article}\n\\begin{document}hi\\end{document}\n')
    const snap = kernel.texSnapshot(doc.document_id)
    const job = kernel.submitJob({
      project_id: project.project_id,
      idempotency_key: 'tex-diag-1',
      kind: 'latex-compile',
      command: ['pdflatex', '-file-line-error', 'paper.tex'],
      payload: { tex_document_id: doc.document_id, tex_revision: snap.revision, tex_snapshot: snap.manifest },
    })
    const build = kernel.texCreateBuild(doc.document_id, snap.revision, 'paper.tex', job.job_id)
    kernel.claimJobs('test-runner', 300, 8)
    const log = kernel.registerArtifact({
      project_id: project.project_id, kind: 'log', content: SAMPLE_LOG, media_type: 'text/plain',
    })
    const pdf = kernel.registerArtifact({ project_id: project.project_id, kind: 'pdf', content: '%PDF-1.4 diag', media_type: 'application/pdf' })
    kernel.completeJob({
      job_id: job.job_id,
      owner: 'test-runner',
      ...fenceArgs(kernel, job.job_id),
      status: 'succeeded',
      run_manifest: {
        // §5 RUN-REMOTE-01: secure kinds 必须携带 claim 的 run_id + metrics_artifact。
        ...manifestIdentity(kernel, job.job_id),
        exit_code: 0,
        metrics_artifact: log.artifact_id,
        container_digest: `docker:${kernel.getJob(job.job_id).image_digest}`,
        tex_pdf_artifact: pdf.artifact_id,
        tex_log_artifact: log.artifact_id,
        // The runner's first-pass diagnostics LACK file/line — the kernel
        // must replace them with the enriched log-artifact parse.
        tex_diagnostics: [{ level: 'error', message: 'Undefined control sequence' }],
        tex: { document_id: doc.document_id, revision: snap.revision, root_file: 'paper.tex' },
      },
    })
    const stored = kernel.texGetBuild(build.build_id)
    const parsed = JSON.parse(stored.diagnostics) as LatexDiagnostic[]
    expect(parsed.length).toBeGreaterThan(0)
    const err = parsed.find(d => d.message.includes('Undefined control sequence'))
    expect(err).toBeDefined()
    expect(err!.file).toBe('sections/intro.tex')
    expect(err!.line).toBe(12)
    expect(parsed.some(d => d.kind === 'missing_file' && d.missing === 'missing.sty')).toBe(true)
    expect(parsed.some(d => d.kind === 'undefined_citation' && d.citation === 'knuth84' && d.line === 20)).toBe(true)
    // Fallback: when the manifest carries diagnostics but no log artifact,
    // the manifest diagnostics are stored unchanged.
    const job2 = kernel.submitJob({
      project_id: project.project_id,
      idempotency_key: 'tex-diag-2',
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
      run_manifest: { ...manifestIdentity(kernel, job2.job_id), exit_code: 1, tex_diagnostics: [{ level: 'error', message: 'halted' }] },
    })
    const stored2 = JSON.parse(kernel.texGetBuild(build2.build_id).diagnostics) as LatexDiagnostic[]
    expect(stored2).toEqual([{ level: 'error', message: 'halted' }])
    kernel.close()
  })
})

describe('tex compile freeze & replay (§7)', () => {
  it('compile freezes the manifest: later edits cannot change the frozen snapshot', () => {
    const kernel = freshKernel()
    const project = kernel.createProject({ name: 't', workspace: '/w', brief: makeBrief() })
    const doc = kernel.texEnsure(project.project_id)
    const original = '\\documentclass{article}\n\\begin{document}A\\end{document}\n'
    kernel.texWriteFile(doc.document_id, 'paper.tex', original)
    const snap = kernel.texSnapshot(doc.document_id)
    const job = kernel.submitJob({
      project_id: project.project_id,
      idempotency_key: 'tex-freeze-1',
      kind: 'latex-compile',
      command: ['pdflatex', 'paper.tex'],
      payload: { tex_document_id: doc.document_id, tex_revision: snap.revision, tex_snapshot: snap.manifest },
    })
    const frozen = (job.payload as Record<string, unknown>).tex_snapshot as TexSnapshotManifest
    const frozenHash = frozen.files[0]!.content_hash
    expect(frozen.revision).toBe(snap.revision)
    // A later edit bumps the document revision…
    kernel.texWriteFile(doc.document_id, 'paper.tex', original.replace('A', 'CHANGED'))
    expect(kernel.texTree(doc.document_id).document.revision).toBeGreaterThan(snap.revision)
    // …the frozen manifest in the job payload is immutable…
    const stored = (kernel.getJob(job.job_id).payload as Record<string, unknown>).tex_snapshot as TexSnapshotManifest
    expect(stored.revision).toBe(snap.revision)
    expect(stored.files[0]!.content_hash).toBe(frozenHash)
    // …a re-freeze at the OLD revision conflicts (409 document_version_conflict)…
    expect(() => kernel.texSnapshot(doc.document_id, snap.revision)).toThrow(/does not match/)
    // …and submitting a NEW compile at the old revision is rejected too.
    expect(() => kernel.submitJob({
      project_id: project.project_id,
      idempotency_key: 'tex-freeze-2',
      kind: 'latex-compile',
      command: ['pdflatex', 'paper.tex'],
      payload: { tex_document_id: doc.document_id, tex_revision: snap.revision, tex_snapshot: snap.manifest },
    })).toThrow(/does not match/)
    // The new revision snapshots separately; the frozen one is untouched.
    const snap2 = kernel.texSnapshot(doc.document_id)
    expect(snap2.revision).toBe(snap.revision + 1)
    kernel.close()
  })

  it('save conflict (409) terminates compile: stale-revision submit is rejected, no job and no build row', () => {
    const kernel = freshKernel()
    const project = kernel.createProject({ name: 't', workspace: '/w', brief: makeBrief() })
    const doc = kernel.texEnsure(project.project_id)
    kernel.texWriteFile(doc.document_id, 'paper.tex', '\\documentclass{article}\n\\begin{document}A\\end{document}\n')
    const snap = kernel.texSnapshot(doc.document_id)
    // The "other editor" concurrently saved: the local editor's save would
    // 409 (expected_version stale) and the document revision moved on.
    kernel.texWriteFile(doc.document_id, 'paper.tex', '\\documentclass{article}\n\\begin{document}B\\end{document}\n')
    // A NEW compile at the STALE frozen revision must be rejected by the
    // document-revision CAS at submit time (409 document_version_conflict).
    const jobsBefore = kernel.listJobs(project.project_id).length
    try {
      kernel.submitJob({
        project_id: project.project_id,
        idempotency_key: 'tex-save409-1',
        kind: 'latex-compile',
        command: ['pdflatex', 'paper.tex'],
        payload: { tex_document_id: doc.document_id, tex_revision: snap.revision, tex_snapshot: snap.manifest },
      })
      throw new Error('expected conflict')
    } catch (error) {
      const code = (error as { code?: string }).code
      expect(code).toBe('document_version_conflict')
    }
    // No job queued, no build row: the compile cannot produce output.
    expect(kernel.listJobs(project.project_id).length).toBe(jobsBefore)
    expect(kernel.texListBuilds(doc.document_id)).toHaveLength(0)
    kernel.close()
  })

  it('rejects a latex-compile whose carried manifest revision does not match tex_revision', () => {
    const kernel = freshKernel()
    const project = kernel.createProject({ name: 't', workspace: '/w', brief: makeBrief() })
    const doc = kernel.texEnsure(project.project_id)
    kernel.texWriteFile(doc.document_id, 'paper.tex', '\\documentclass{article}\n\\begin{document}A\\end{document}\n')
    const snap = kernel.texSnapshot(doc.document_id)
    // Manifest frozen at R, but the job claims revision R+1: the build row
    // would label one revision while the runner compiles another — rejected.
    try {
      kernel.submitJob({
        project_id: project.project_id,
        idempotency_key: 'tex-rev-mismatch-1',
        kind: 'latex-compile',
        command: ['pdflatex', 'paper.tex'],
        payload: {
          tex_document_id: doc.document_id,
          tex_revision: snap.revision + 1,
          tex_snapshot: snap.manifest,
        },
      })
      throw new Error('expected conflict')
    } catch (error) {
      const code = (error as { code?: string }).code
      expect(code).toBe('document_version_conflict')
    }
    // The mismatched compile did not mutate the snapshot store.
    expect(kernel.texSnapshotFile(doc.document_id, snap.revision, 'paper.tex')?.content_hash)
      .toBe(snap.manifest.files[0]!.content_hash)
    kernel.close()
  })

  it('compile freezes MATERIALIZABLE bytes: edits during the build cannot change the compiled input (TEX-01)', () => {
    const kernel = freshKernel()
    const project = kernel.createProject({ name: 't', workspace: '/w', brief: makeBrief() })
    const doc = kernel.texEnsure(project.project_id)
    const original = '\\documentclass{article}\n\\begin{document}FROZEN\\end{document}\n'
    kernel.texWriteFile(doc.document_id, 'paper.tex', original)
    const snap = kernel.texSnapshot(doc.document_id)
    const job = kernel.submitJob({
      project_id: project.project_id,
      idempotency_key: 'tex-frozen-bytes-1',
      kind: 'latex-compile',
      command: ['pdflatex', 'paper.tex'],
      payload: { tex_document_id: doc.document_id, tex_revision: snap.revision, tex_snapshot: snap.manifest },
    })
    // Simulate an edit landing AFTER the freeze but BEFORE/DURING the build:
    // the runner materializes from the kernel's snapshot store…
    kernel.texWriteFile(doc.document_id, 'paper.tex', original.replace('FROZEN', 'EDITED MID-BUILD'))
    const frozen = kernel.texSnapshotFile(doc.document_id, snap.revision, 'paper.tex')
    // …and gets exactly the frozen revision bytes, hash-identical to the
    // manifest the job carries — never the post-freeze current file.
    const carried = (job.payload as Record<string, unknown>).tex_snapshot as TexSnapshotManifest
    expect(frozen?.content).toBe(original)
    expect(frozen?.content_hash).toBe(carried.files[0]!.content_hash)
    kernel.close()
  })

  it('build history replays the log and PDF artifacts', () => {
    const kernel = freshKernel()
    const project = kernel.createProject({ name: 't', workspace: '/w', brief: makeBrief() })
    const doc = kernel.texEnsure(project.project_id)
    kernel.texWriteFile(doc.document_id, 'paper.tex', '\\documentclass{article}\n\\begin{document}hi\\end{document}\n')
    const snap = kernel.texSnapshot(doc.document_id)
    const job = kernel.submitJob({
      project_id: project.project_id,
      idempotency_key: 'tex-history-1',
      kind: 'latex-compile',
      command: ['pdflatex', 'paper.tex'],
      payload: { tex_document_id: doc.document_id, tex_revision: snap.revision, tex_snapshot: snap.manifest },
    })
    const build = kernel.texCreateBuild(doc.document_id, snap.revision, 'paper.tex', job.job_id)
    kernel.claimJobs('test-runner', 300, 8)
    const pdfBytes = '%PDF-1.4 replay-history'
    const logBytes = 'This is pdfTeX, Version 3.141592653'
    const pdf = kernel.registerArtifact({ project_id: project.project_id, kind: 'pdf', content: pdfBytes, media_type: 'application/pdf', file_name: 'paper.pdf' })
    const log = kernel.registerArtifact({ project_id: project.project_id, kind: 'log', content: logBytes, media_type: 'text/plain' })
    kernel.completeJob({
      job_id: job.job_id,
      owner: 'test-runner',
      ...fenceArgs(kernel, job.job_id),
      status: 'succeeded',
      run_manifest: {
        ...manifestIdentity(kernel, job.job_id), exit_code: 0, metrics_artifact: log.artifact_id,
        container_digest: `docker:${kernel.getJob(job.job_id).image_digest}`,
        tex_pdf_artifact: pdf.artifact_id,
        tex_log_artifact: log.artifact_id,
        tex_diagnostics: [],
        tex: { document_id: doc.document_id, revision: snap.revision, root_file: 'paper.tex' },
      },
    })
    // Build history: the completed build lists with its frozen revision and
    // both artifact ids; both artifacts download the exact bytes from CAS.
    const builds = kernel.texListBuilds(doc.document_id)
    const row = builds.find(b => b.build_id === build.build_id)
    expect(row).toBeDefined()
    expect(row!.status).toBe('succeeded')
    expect(row!.revision).toBe(snap.revision)
    const pdfRecord = kernel.getArtifact(project.project_id, row!.pdf_artifact!)
    expect(kernel.cas.read(pdfRecord.sha256).toString('utf8')).toBe(pdfBytes)
    const logRecord = kernel.getArtifact(project.project_id, row!.log_artifact!)
    expect(kernel.cas.read(logRecord.sha256).toString('utf8')).toBe(logBytes)
    kernel.close()
  })

  it('exposes freshness info for stale-PDF detection (build revision vs document revision)', () => {
    const kernel = freshKernel()
    const project = kernel.createProject({ name: 't', workspace: '/w', brief: makeBrief() })
    const doc = kernel.texEnsure(project.project_id)
    kernel.texWriteFile(doc.document_id, 'paper.tex', '\\documentclass{article}\n\\begin{document}hi\\end{document}\n')
    const snap = kernel.texSnapshot(doc.document_id)
    const job = kernel.submitJob({
      project_id: project.project_id,
      idempotency_key: 'tex-stale-1',
      kind: 'latex-compile',
      command: ['pdflatex', 'paper.tex'],
      payload: { tex_document_id: doc.document_id, tex_revision: snap.revision, tex_snapshot: snap.manifest },
    })
    const build = kernel.texCreateBuild(doc.document_id, snap.revision, 'paper.tex', job.job_id)
    kernel.claimJobs('test-runner', 300, 8)
    const metrics = kernel.registerArtifact({ project_id: project.project_id, kind: 'analysis', content: JSON.stringify({ metrics: [] }) })
    kernel.completeJob({
      job_id: job.job_id,
      owner: 'test-runner',
      ...fenceArgs(kernel, job.job_id),
      status: 'succeeded',
      run_manifest: { ...manifestIdentity(kernel, job.job_id), exit_code: 0, metrics_artifact: metrics.artifact_id, container_digest: `docker:${kernel.getJob(job.job_id).image_digest}`, tex_diagnostics: [] },
    })
    // The build froze the then-current revision; after a source edit the
    // document revision moves ahead — the kernel exposes both so a UI can
    // mark the old PDF stale.
    const buildRow = kernel.texGetBuild(build.build_id)
    const revisionAtBuild = kernel.texTree(doc.document_id).document.revision
    expect(revisionAtBuild).toBe(buildRow.revision)
    kernel.texWriteFile(doc.document_id, 'paper.tex', '\\documentclass{article}\n\\begin{document}edited after build\\end{document}\n')
    const currentRevision = kernel.texTree(doc.document_id).document.revision
    expect(currentRevision).toBeGreaterThan(buildRow.revision)
    expect(kernel.texGetBuild(build.build_id).revision).toBe(buildRow.revision) // history stays frozen
    kernel.close()
  })
})
