/**
 * TeX Workspace store (execution-runtime.md §12, gui-plugin-plan §11):
 * versioned document files with CAS writes (expected_version), frozen
 * snapshots, and build records for latex-compile jobs. Text content lives
 * inline (v1); binary assets are planned via the CAS. The store owns a
 * second WAL connection to the kernel database.
 * @module @dsh-scholar/research-kernel/tex-workspace
 */

import { DatabaseSync } from 'node:sqlite'
import { createHash, randomUUID } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

export class TexError extends Error {
  readonly code: string
  constructor(code: string, message: string) {
    super(message)
    this.code = code
  }
}

/**
 * File kind classification (reconstruction-contracts.md §11 TexFileKind).
 * Text content lives inline (v1); binary assets are planned via the CAS.
 */
export type TexFileKind = 'tex' | 'bib' | 'sty' | 'cls' | 'image' | 'generated' | 'other'

/** RFC 2046 media type derived from the file extension (tree/GET 'media'). */
export function fileMediaType(path: string): string {
  const ext = path.slice(path.lastIndexOf('.') + 1).toLowerCase()
  switch (ext) {
    case 'tex': return 'text/x-tex'
    case 'bib': return 'text/x-bibtex'
    case 'sty': return 'text/x-tex'
    case 'cls': return 'text/x-tex'
    case 'png': case 'jpg': case 'jpeg': case 'gif': case 'pdf': case 'eps': case 'svg': return 'application/octet-stream'
    default: return 'text/plain'
  }
}

/** File kind derived from the extension (reconstruction-contracts.md §11). */
export function fileKindOf(path: string): TexFileKind {
  const ext = path.slice(path.lastIndexOf('.') + 1).toLowerCase()
  switch (ext) {
    case 'tex': return 'tex'
    case 'bib': return 'bib'
    case 'sty': return 'sty'
    case 'cls': return 'cls'
    case 'png': case 'jpg': case 'jpeg': case 'gif': case 'pdf': case 'eps': case 'svg': return 'image'
    default: return 'other'
  }
}

export interface TexFileEntry {
  path: string
  kind: TexFileKind
  media: string
  version: number
  content_hash: string
  content?: string
  created_at: string
}

export interface TexDocumentInfo {
  document_id: string
  project_id: string
  root_file: string
  revision: number
  created_at: string
  updated_at: string
}

export interface TexSnapshotManifest {
  schema_version: number
  document_id: string
  revision: number
  root_file: string
  files: Array<{ path: string; version: number; content_hash: string }>
  frozen_at: string
}

export type TexBuildStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled' | 'superseded'

/**
 * One TeX build record (authoritative latex-compile OR live preview,
 * execution-runtime.md §12/§12.1, TEX-03). Preview records are marked
 * `preview=true` and are NOT part of the authoritative manifest chain: they
 * never produce accepted Evidence and are superseded (queued → cancelled,
 * running → superseded) as soon as a newer preview build or an explicit
 * authoritative Compile exists (superseded_by/superseded_at).
 */
export interface TexBuild {
  build_id: string
  document_id: string
  revision: number
  root_file: string
  job_id: string | null
  status: TexBuildStatus
  diagnostics: string
  pdf_artifact: string | null
  log_artifact: string | null
  /** true when this build is a live preview (TEX-03); authoritative builds are false. */
  preview: boolean
  /** build_id of the newer preview / authoritative build that superseded this one. */
  superseded_by: string | null
  superseded_at: string | null
  created_at: string
  finished_at: string | null
}

/**
 * Durable debounced preview request (execution-runtime.md §12.1, TEX-03):
 * written when a save succeeds (or the preview-builds endpoint is called),
 * consumed by the kernel when the debounce fires. Survives kernel restarts
 * so preview state is always re-projectable — it never lives only in a
 * browser debounce timer.
 */
export interface TexPreviewPending {
  document_id: string
  /** Document revision observed at request time (the flush compiles the LATEST revision). */
  revision: number
  root_file: string
  engine: string
  debounce_ms: number
  requested_at: string
}

/** Raw tex_builds row as stored (preview is 0/1 in SQLite). */
interface TexBuildRow extends Omit<TexBuild, 'preview'> {
  preview: number
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS tex_documents (
  document_id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  root_file TEXT NOT NULL DEFAULT 'paper.tex',
  revision INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS tex_files (
  document_id TEXT NOT NULL,
  path TEXT NOT NULL,
  version INTEGER NOT NULL,
  content TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (document_id, path)
);
CREATE INDEX IF NOT EXISTS idx_tex_files_doc ON tex_files(document_id);
CREATE TABLE IF NOT EXISTS tex_snapshots (
  document_id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  manifest TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (document_id, revision)
);
-- TEX-01 (§4 row 95): the snapshot is the MATERIALIZABLE byte source of a
-- build — every file's frozen content is stored alongside the manifest at
-- freeze time. The Runner fetches THESE bytes (revision-scoped), never the
-- current file, so a concurrent edit cannot leak into a compile.
CREATE TABLE IF NOT EXISTS tex_snapshot_files (
  document_id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  path TEXT NOT NULL,
  content TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  PRIMARY KEY (document_id, revision, path)
);
CREATE INDEX IF NOT EXISTS idx_tex_snapshot_files_doc ON tex_snapshot_files(document_id, revision);
CREATE TABLE IF NOT EXISTS tex_builds (
  build_id TEXT PRIMARY KEY,
  document_id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  root_file TEXT NOT NULL,
  job_id TEXT,
  status TEXT NOT NULL,
  diagnostics TEXT NOT NULL DEFAULT '[]',
  pdf_artifact TEXT,
  log_artifact TEXT,
  -- TEX-03 (§4 row 96 / execution-runtime.md §12.1): preview flag +
  -- supersede linkage for live preview builds.
  preview INTEGER NOT NULL DEFAULT 0,
  superseded_by TEXT,
  superseded_at TEXT,
  created_at TEXT NOT NULL,
  finished_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_tex_builds_doc ON tex_builds(document_id);
-- TEX-03: durable debounced preview request (survives kernel restarts).
CREATE TABLE IF NOT EXISTS tex_preview_pending (
  document_id TEXT PRIMARY KEY,
  revision INTEGER NOT NULL,
  root_file TEXT NOT NULL,
  engine TEXT NOT NULL DEFAULT 'pdflatex',
  debounce_ms INTEGER NOT NULL DEFAULT 800,
  requested_at TEXT NOT NULL
);
`

function nowIso(): string {
  return new Date().toISOString()
}

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex')
}

function normalizePath(path: string): string {
  const clean = path.replaceAll('\\', '/')
  if (clean.startsWith('/') || clean.includes('..')) {
    throw new TexError('invalid_path', `path must be root-relative without '..': ${path}`)
  }
  return clean
}

/** Create (or open) the TeX workspace store on the kernel database path. */
export function openTexWorkspace(dbPath: string): TexWorkspaceStore {
  return new TexWorkspaceStore(dbPath)
}

export class TexWorkspaceStore {
  private readonly db: DatabaseSync

  constructor(dbPath: string) {
    if (dbPath !== ':memory:') mkdirSync(dirname(dbPath), { recursive: true })
    this.db = new DatabaseSync(dbPath)
    this.db.exec('PRAGMA journal_mode = WAL')
    this.db.exec('PRAGMA foreign_keys = ON')
    this.db.exec(SCHEMA)
    // TEX-03 parity for databases opened directly (without the kernel
    // migration runner): CREATE IF NOT EXISTS does not add columns to an
    // existing tex_builds, so ensure them idempotently like migrations.ts.
    this.ensurePreviewColumns()
  }

  /** Additive TEX-03 columns/table on pre-migration databases (idempotent). */
  private ensurePreviewColumns(): void {
    const cols = this.db.prepare(`PRAGMA table_info(tex_builds)`).all() as unknown as Array<{ name: string }>
    const has = (name: string): boolean => cols.some(c => c.name === name)
    if (!has('preview')) this.db.exec('ALTER TABLE tex_builds ADD COLUMN preview INTEGER NOT NULL DEFAULT 0')
    if (!has('superseded_by')) this.db.exec('ALTER TABLE tex_builds ADD COLUMN superseded_by TEXT')
    if (!has('superseded_at')) this.db.exec('ALTER TABLE tex_builds ADD COLUMN superseded_at TEXT')
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS tex_preview_pending (
        document_id TEXT PRIMARY KEY,
        revision INTEGER NOT NULL,
        root_file TEXT NOT NULL,
        engine TEXT NOT NULL DEFAULT 'pdflatex',
        debounce_ms INTEGER NOT NULL DEFAULT 800,
        requested_at TEXT NOT NULL
      );
    `)
  }

  /**
   * Run `fn` inside ONE SQLite transaction on THIS connection (the tex store
   * owns its own WAL connection — the kernel's withTransaction cannot span
   * it). Every multi-statement mutation (writeFile/deleteFile/moveFile) goes
   * through here so a mid-write failure rolls back as a unit: no half-written
   * file rows, no revision bump without the file write (TEX-SAVE,
   * storage-migrations.md §5/§7).
   *
   * Nested calls (moveFile → writeFile) reuse the already-open transaction:
   * node:sqlite forbids nested BEGIN, so `isTransaction` makes the inner
   * call join the outer one and the OUTER caller commits/rolls back both as a
   * single unit.
   */
  private withTx<T>(fn: () => T): T {
    if (this.db.isTransaction) return fn()
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const result = fn()
      this.db.exec('COMMIT')
      return result
    } catch (error) {
      try { this.db.exec('ROLLBACK') } catch { /* already rolled back */ }
      throw error
    }
  }

  close(): void {
    this.db.close()
  }

  /**
   * P0-3 (TEX-01): read-only document lookup — the caller can decide
   * whether first-generation is needed WITHOUT creating a document row.
   * null when the project has no TeX document yet.
   */
  findDocument(projectId: string): TexDocumentInfo | null {
    const row = this.db.prepare('SELECT * FROM tex_documents WHERE project_id = ?').get(projectId) as TexDocumentInfo | undefined
    return row ?? null
  }

  ensureDocument(projectId: string, rootFile = 'paper.tex'): TexDocumentInfo {
    const row = this.db.prepare('SELECT * FROM tex_documents WHERE project_id = ?').get(projectId) as TexDocumentInfo | undefined
    if (row !== undefined) return row
    const document: TexDocumentInfo = {
      document_id: `doc_${randomUUID().slice(0, 12)}`,
      project_id: projectId,
      root_file: normalizePath(rootFile),
      revision: 1,
      created_at: nowIso(),
      updated_at: nowIso(),
    }
    this.db.prepare('INSERT INTO tex_documents (document_id, project_id, root_file, revision, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(document.document_id, document.project_id, document.root_file, document.revision, document.created_at, document.updated_at)
    return document
  }

  getDocument(documentId: string): TexDocumentInfo {
    const row = this.db.prepare('SELECT * FROM tex_documents WHERE document_id = ?').get(documentId) as TexDocumentInfo | undefined
    if (row === undefined) throw new TexError('document_not_found', `tex document ${documentId} not found`)
    return row
  }

  /** Bump the document revision (every mutation), returns the new revision. */
  private bumpRevision(documentId: string): number {
    const doc = this.getDocument(documentId)
    const next = doc.revision + 1
    this.db.prepare('UPDATE tex_documents SET revision = ?, updated_at = ? WHERE document_id = ?')
      .run(next, nowIso(), documentId)
    return next
  }

  tree(documentId: string): { document: TexDocumentInfo; files: TexFileEntry[] } {
    const document = this.getDocument(documentId)
    const rows = this.db.prepare('SELECT path, version, content, content_hash, created_at FROM tex_files WHERE document_id = ? ORDER BY path')
      .all(documentId) as unknown as Array<{ path: string; version: number; content: string; content_hash: string; created_at: string }>
    return {
      document,
      // tree/GET contract (acceptance-tests.md §7): each entry carries
      // path/kind/media/version so the UI can classify and version files.
      files: rows.map(r => ({
        path: r.path,
        kind: fileKindOf(r.path),
        media: fileMediaType(r.path),
        version: r.version,
        content_hash: r.content_hash,
        created_at: r.created_at,
      })),
    }
  }

  readFile(documentId: string, path: string): { path: string; kind: TexFileKind; media: string; version: number; content: string; content_hash: string } | null {
    const row = this.db.prepare('SELECT path, version, content, content_hash FROM tex_files WHERE document_id = ? AND path = ?')
      .get(documentId, normalizePath(path)) as { path: string; version: number; content: string; content_hash: string } | undefined
    if (row === null || row === undefined) return null
    return { ...row, kind: fileKindOf(row.path), media: fileMediaType(row.path) }
  }

  /**
   * CAS write. expected_version semantics (acceptance-tests.md §7):
   *   - undefined  → unchecked write (create or overwrite);
   *   - 0          → create-if-absent: the file must NOT exist yet (the UI
   *     "new file" flow sends 0); missing → create at version 1, existing →
   *     409 document_version_conflict (0 never equals a stored version >= 1);
   *   - N > 0      → must match the stored version, else 409; missing file
   *     with N > 0 is also a 409 (cannot write a nonexistent version).
   * Conflict → TexError 409.
   */
  writeFile(documentId: string, path: string, content: string, expectedVersion?: number): { version: number; content_hash: string } {
    const clean = normalizePath(path)
    this.getDocument(documentId)
    // TEX-SAVE: file row + document revision bump are ONE transaction — an
    // error anywhere (CAS check is outside; writes below are inside) rolls
    // the whole write back instead of leaving a half-write.
    return this.withTx(() => {
      const existing = this.db.prepare('SELECT version, content FROM tex_files WHERE document_id = ? AND path = ?')
        .get(documentId, clean) as { version: number; content: string } | undefined
      if (existing === undefined) {
        if (expectedVersion !== undefined && expectedVersion !== 0) {
          throw new TexError('document_version_conflict', `file ${clean} does not exist (expected version ${expectedVersion})`)
        }
        const hash = sha256(content)
        this.db.prepare('INSERT INTO tex_files (document_id, path, version, content, content_hash, created_at) VALUES (?, ?, 1, ?, ?, ?)')
          .run(documentId, clean, content, hash, nowIso())
        this.bumpRevision(documentId)
        return { version: 1, content_hash: hash }
      }
      if (expectedVersion !== undefined && expectedVersion !== existing.version) {
        throw new TexError('document_version_conflict',
          `file ${clean} version ${existing.version} does not match expected version ${expectedVersion} — reload and merge`)
      }
      const hash = sha256(content)
      this.db.prepare('UPDATE tex_files SET version = version + 1, content = ?, content_hash = ?, created_at = ? WHERE document_id = ? AND path = ?')
        .run(content, hash, nowIso(), documentId, clean)
      this.bumpRevision(documentId)
      return { version: existing.version + 1, content_hash: hash }
    })
  }

  /**
   * Delete requires the file to exist. expected_version semantics: undefined
   * = unchecked delete; 0 = never matches a stored version (>= 1) → 409
   * document_version_conflict ("reload before deleting"); N > 0 must match.
   */
  deleteFile(documentId: string, path: string, expectedVersion?: number): void {
    const clean = normalizePath(path)
    const existing = this.db.prepare('SELECT version FROM tex_files WHERE document_id = ? AND path = ?')
      .get(documentId, clean) as { version: number } | undefined
    if (existing === undefined) throw new TexError('file_not_found', `file ${clean} not found`)
    if (expectedVersion !== undefined && expectedVersion !== existing.version) {
      throw new TexError('document_version_conflict', `file ${clean} version changed; reload before deleting`)
    }
    // TEX-SAVE: delete + revision bump are one transaction.
    this.withTx(() => {
      this.db.prepare('DELETE FROM tex_files WHERE document_id = ? AND path = ?').run(documentId, clean)
      this.bumpRevision(documentId)
    })
  }

  /**
   * Move = write the destination (create-if-absent, no expected version) plus
   * delete the source. expected_version guards the SOURCE: undefined =
   * unchecked; 0 = never matches a stored version (>= 1) → 409; N > 0 must
   * match the source version.
   */
  moveFile(documentId: string, fromPath: string, toPath: string, expectedVersion?: number): void {
    const from = normalizePath(fromPath)
    const to = normalizePath(toPath)
    const file = this.readFile(documentId, from)
    if (file === null) throw new TexError('file_not_found', `file ${from} not found`)
    if (expectedVersion !== undefined && expectedVersion !== file.version) {
      throw new TexError('document_version_conflict', `file ${from} version changed; reload before moving`)
    }
    // TEX-SAVE: destination write + source delete + revision bump are ONE
    // transaction (writeFile reuses it via isTransaction — no nested BEGIN).
    // A failure anywhere rolls back the whole move: no orphan destination,
    // no vanished source, no revision bump without the move.
    this.withTx(() => {
      this.writeFile(documentId, to, file.content)
      this.db.prepare('DELETE FROM tex_files WHERE document_id = ? AND path = ?').run(documentId, from)
      this.bumpRevision(documentId)
    })
  }

  history(documentId: string): Array<{ revision: number; at: string }> {
    this.getDocument(documentId)
    // Per-file history, newest first. tex_files has no `revision` column —
    // the file VERSION is the per-file CAS counter (bug fix surfaced by the
    // WORK-01 facade, which maps this onto workspace revisions).
    const rows = this.db.prepare('SELECT DISTINCT version, created_at FROM tex_files WHERE document_id = ? ORDER BY version DESC LIMIT 20')
      .all(documentId) as unknown as Array<{ version: number; created_at: string }>
    const doc = this.getDocument(documentId)
    return rows.length > 0 ? rows.map(r => ({ revision: r.version, at: r.created_at })) : [{ revision: doc.revision, at: doc.updated_at }]
  }

  /**
   * Freeze the current file set into a snapshot manifest (build input).
   * TEX-01 (§4 row 95): the freeze ALSO stores every file's content bytes in
   * tex_snapshot_files at this revision — the snapshot is the materializable
   * source for latex-compile. The manifest stays hash-only (tree/GET and
   * build payload contracts); bytes are read back via snapshotFile().
   * The document-revision CAS still applies: a stale expectedRevision → 409.
   */
  snapshot(documentId: string, expectedRevision?: number): { revision: number; manifest: TexSnapshotManifest } {
    const document = this.getDocument(documentId)
    if (expectedRevision !== undefined && expectedRevision !== document.revision) {
      throw new TexError('document_version_conflict',
        `document revision ${document.revision} does not match expected revision ${expectedRevision} — save before building`)
    }
    const rows = this.db.prepare('SELECT path, version, content, content_hash FROM tex_files WHERE document_id = ? ORDER BY path')
      .all(documentId) as unknown as Array<{ path: string; version: number; content: string; content_hash: string }>
    const manifest: TexSnapshotManifest = {
      schema_version: 1,
      document_id: documentId,
      revision: document.revision,
      root_file: document.root_file,
      files: rows.map(r => ({ path: r.path, version: r.version, content_hash: r.content_hash })),
      frozen_at: nowIso(),
    }
    // Manifest + frozen bytes are one atomic freeze: either both land or
    // neither (a partial snapshot must never be materializable).
    this.db.exec('BEGIN')
    try {
      this.db.prepare('INSERT OR REPLACE INTO tex_snapshots (document_id, revision, manifest, created_at) VALUES (?, ?, ?, ?)')
        .run(documentId, document.revision, JSON.stringify(manifest), manifest.frozen_at)
      this.db.prepare('DELETE FROM tex_snapshot_files WHERE document_id = ? AND revision = ?').run(documentId, document.revision)
      const insert = this.db.prepare('INSERT INTO tex_snapshot_files (document_id, revision, path, content, content_hash) VALUES (?, ?, ?, ?, ?)')
      for (const r of rows) insert.run(documentId, document.revision, r.path, r.content, r.content_hash)
      this.db.exec('COMMIT')
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
    return { revision: document.revision, manifest }
  }

  /**
   * TEX-01: read the FROZEN bytes of one snapshot file at a given revision.
   * Returns null when the revision/path is not in the snapshot store (the
   * runner treats null as a hard materialization failure — never a fallback
   * to the current file). Path is root-relative with the usual traversal
   * rejection.
   */
  snapshotFile(documentId: string, revision: number, path: string): { path: string; content: string; content_hash: string } | null {
    this.getDocument(documentId)
    const row = this.db.prepare('SELECT path, content, content_hash FROM tex_snapshot_files WHERE document_id = ? AND revision = ? AND path = ?')
      .get(documentId, revision, normalizePath(path)) as { path: string; content: string; content_hash: string } | undefined
    return row ?? null
  }

  /** Map a raw row (preview 0/1) to the public TexBuild shape. */
  private buildFromRow(row: TexBuildRow): TexBuild {
    return { ...row, preview: row.preview === 1 }
  }

  createBuild(documentId: string, revision: number, rootFile: string, jobId: string | null, preview = false): TexBuild {
    // A replayed HTTP submission returns the same durable job. Reuse its
    // build as well; another queued row would never receive a completion.
    if (jobId !== null && jobId !== '') {
      const existing = this.db.prepare('SELECT * FROM tex_builds WHERE job_id = ? ORDER BY created_at ASC LIMIT 1').get(jobId) as TexBuildRow | undefined
      if (existing !== undefined) {
        if (existing.document_id !== documentId || existing.revision !== revision || existing.root_file !== rootFile || (existing.preview === 1) !== preview) {
          throw new TexError('build_idempotency_conflict', 'this job is already associated with different build inputs')
        }
        return this.buildFromRow(existing)
      }
    }
    const build: TexBuild = {
      build_id: `build_${randomUUID().slice(0, 12)}`,
      document_id: documentId,
      revision,
      root_file: rootFile,
      job_id: jobId,
      status: 'queued',
      diagnostics: '[]',
      pdf_artifact: null,
      log_artifact: null,
      preview,
      superseded_by: null,
      superseded_at: null,
      created_at: nowIso(),
      finished_at: null,
    }
    this.db.prepare('INSERT INTO tex_builds (build_id, document_id, revision, root_file, job_id, status, diagnostics, pdf_artifact, log_artifact, preview, superseded_by, superseded_at, created_at, finished_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(build.build_id, build.document_id, build.revision, build.root_file, build.job_id, build.status, build.diagnostics, build.pdf_artifact, build.log_artifact, build.preview ? 1 : 0, build.superseded_by, build.superseded_at, build.created_at, build.finished_at)
    return build
  }

  updateBuild(buildId: string, patch: {
    status?: TexBuild['status']
    diagnostics?: string
    pdf_artifact?: string | null
    log_artifact?: string | null
    job_id?: string | null
    preview?: boolean
    superseded_by?: string | null
    superseded_at?: string | null
  }): TexBuild {
    const current = this.getBuild(buildId)
    const next: TexBuild = {
      ...current,
      ...patch,
      status: patch.status ?? current.status,
      diagnostics: patch.diagnostics ?? current.diagnostics,
      pdf_artifact: patch.pdf_artifact !== undefined ? patch.pdf_artifact : current.pdf_artifact,
      log_artifact: patch.log_artifact !== undefined ? patch.log_artifact : current.log_artifact,
      job_id: patch.job_id !== undefined ? patch.job_id : current.job_id,
      preview: patch.preview !== undefined ? patch.preview : current.preview,
      superseded_by: patch.superseded_by !== undefined ? patch.superseded_by : current.superseded_by,
      superseded_at: patch.superseded_at !== undefined ? patch.superseded_at : current.superseded_at,
      finished_at: (patch.status === 'succeeded' || patch.status === 'failed' || patch.status === 'cancelled' || patch.status === 'superseded') ? (current.finished_at ?? nowIso()) : current.finished_at,
    }
    this.db.prepare('UPDATE tex_builds SET status = ?, diagnostics = ?, pdf_artifact = ?, log_artifact = ?, job_id = ?, preview = ?, superseded_by = ?, superseded_at = ?, finished_at = ? WHERE build_id = ?')
      .run(next.status, next.diagnostics, next.pdf_artifact, next.log_artifact, next.job_id, next.preview ? 1 : 0, next.superseded_by, next.superseded_at, next.finished_at, buildId)
    return next
  }

  getBuild(buildId: string): TexBuild {
    const row = this.db.prepare('SELECT * FROM tex_builds WHERE build_id = ?').get(buildId) as TexBuildRow | undefined
    if (row === undefined) throw new TexError('build_not_found', `tex build ${buildId} not found`)
    return this.buildFromRow(row)
  }

  listBuilds(documentId: string): TexBuild[] {
    this.getDocument(documentId)
    const rows = this.db.prepare('SELECT * FROM tex_builds WHERE document_id = ? ORDER BY created_at DESC').all(documentId) as unknown as TexBuildRow[]
    return rows.map(r => this.buildFromRow(r))
  }

  /** TEX-03: live preview builds of a document, newest first. */
  listPreviews(documentId: string): TexBuild[] {
    this.getDocument(documentId)
    const rows = this.db.prepare('SELECT * FROM tex_builds WHERE document_id = ? AND preview = 1 ORDER BY created_at DESC').all(documentId) as unknown as TexBuildRow[]
    return rows.map(r => this.buildFromRow(r))
  }

  /**
   * TEX-03 (§12.1): supersede every non-terminal preview build of the
   * document when a newer preview or an authoritative Compile exists.
   * queued previews are cancelled (their job never ran), running previews
   * are marked `superseded`; both get superseded_by/superseded_at and a
   * finished_at. Terminal records (succeeded/failed/cancelled/superseded)
   * are left untouched — they simply become stale via the revision check.
   * The superseding build itself is never selected (a fresh preview is
   * queued when this runs). Returns the affected builds so the caller can
   * cancel their jobs.
   */
  supersedePreviews(documentId: string, supersederBuildId: string): TexBuild[] {
    const rows = this.db.prepare("SELECT * FROM tex_builds WHERE document_id = ? AND preview = 1 AND status IN ('queued','running') AND build_id != ? ORDER BY created_at")
      .all(documentId, supersederBuildId) as unknown as TexBuildRow[]
    const affected: TexBuild[] = []
    const now = nowIso()
    for (const row of rows) {
      const status: TexBuild['status'] = row.status === 'queued' ? 'cancelled' : 'superseded'
      this.db.prepare('UPDATE tex_builds SET status = ?, superseded_by = ?, superseded_at = ?, finished_at = ? WHERE build_id = ?')
        .run(status, supersederBuildId, now, now, row.build_id)
      affected.push(this.buildFromRow({ ...row, status, superseded_by: supersederBuildId, superseded_at: now, finished_at: now }))
    }
    return affected
  }

  // ── preview request scheduler (TEX-03 / execution-runtime.md §12.1) ──────

  /** Record a debounced preview request (upsert per document; the debounce
   * timer is owned by the kernel, the row is durable across restarts). */
  requestPreview(documentId: string, debounceMs: number, rootFile?: string, engine?: string): TexPreviewPending {
    const document = this.getDocument(documentId)
    const pending: TexPreviewPending = {
      document_id: documentId,
      revision: document.revision,
      root_file: rootFile !== undefined && rootFile !== '' ? rootFile : document.root_file,
      engine: engine !== undefined && engine !== '' ? engine : 'pdflatex',
      debounce_ms: debounceMs,
      requested_at: nowIso(),
    }
    this.db.prepare(`INSERT INTO tex_preview_pending (document_id, revision, root_file, engine, debounce_ms, requested_at) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(document_id) DO UPDATE SET revision = excluded.revision, root_file = excluded.root_file, engine = excluded.engine, debounce_ms = excluded.debounce_ms, requested_at = excluded.requested_at`)
      .run(pending.document_id, pending.revision, pending.root_file, pending.engine, pending.debounce_ms, pending.requested_at)
    return pending
  }

  getPendingPreview(documentId: string): TexPreviewPending | null {
    const row = this.db.prepare('SELECT * FROM tex_preview_pending WHERE document_id = ?').get(documentId) as TexPreviewPending | undefined
    return row ?? null
  }

  listPendingPreviews(): TexPreviewPending[] {
    return this.db.prepare('SELECT * FROM tex_preview_pending ORDER BY requested_at').all() as unknown as TexPreviewPending[]
  }

  /** Read + delete the pending request (a flush consumes exactly one). */
  consumePendingPreview(documentId: string): TexPreviewPending | null {
    const pending = this.getPendingPreview(documentId)
    if (pending !== null) this.db.prepare('DELETE FROM tex_preview_pending WHERE document_id = ?').run(documentId)
    return pending
  }
}
