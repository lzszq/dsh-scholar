import type { ManuscriptBuild, ManuscriptFile, Projection } from '../types'
import { api, apiResult, authHeaders, base, type ApiErrorEnvelope } from '../api'
import { t } from '../i18n/index'
import { el, rootHost } from '../ui'
import { openSettingsModal } from '../modals/settings'
import { state, tabSave } from '../state'
import { terminalLoadSeq } from '../terminal'
import { isEditorDirty } from '../manuscript-dirty'
import { displayedManuscriptPdfIsStale, latestSucceededManuscriptBuild, manuscriptFailureModel, previewPanelModel, triggerPreviewAfterSave } from '../manuscript-flow'
import {
  methodologySummaryNode,
  type CompactMethodologyProjection,
} from '../methodology-projection'
/* ─────────────────────────── Manuscript Workbench ─────────────────────────── */

/**
 * dsh-web TeX Workbench (gui-plugin-plan §11): file tree + editor + build
 * diagnostics/PDF. Files carry version CAS (expected_version); 409 conflicts
 * surface a base/current/local banner instead of silent overwrites.
 */


export let msDocId: string | null = null
export let msFiles: ManuscriptFile[] = []
export let msRevision = 1
export let msOpenPath: string | null = null
export let msContent = ''
export let msSavedVersion = 0
export let msSavedContent = ''
export let msDirty = false
export let msConflict: string | null = null
let msErrorRecovery: 'reload' | 'settings' | 'retry' = 'reload'
let msErrorDetails = ''
let msSettingsKey: string | undefined
const msCompiling = new Set<string>()
const msSaving = new Set<string>()
const msReloading = new Set<string>()
let msMutationEpoch = 0
const msCompileRequests = new Map<string, { revision: number; key: string }>()
let msFailedOperation: 'save' | 'compile' | 'reload' = 'compile'
export function msMutationPending(): boolean { return msCompiling.size > 0 || msSaving.size > 0 || msReloading.size > 0 }
function msRecordFailure(error: ApiErrorEnvelope, status: number, operation: typeof msFailedOperation): void {
  const model = manuscriptFailureModel(error, status)
  msConflict = t('manuscript', model.key, { code: error.code ?? `HTTP ${status}` })
  msErrorRecovery = model.recovery
  msSettingsKey = model.key === 'manuscript.failure.runner'
    ? error.code?.startsWith('runner_target_') ? 'execution.runner_target_id' : 'execution.runner_profile_id'
    : undefined
  msFailedOperation = operation
  msErrorDetails = [error.message, error.code, status > 0 ? `HTTP ${status}` : '', error.request_id].filter(Boolean).join(' · ')
}
export let msBuilds: ManuscriptBuild[] = []
export let msBuildPoll: number | undefined
export let msPdfUrl: string | null = null
/** Document the main-build PDF blob was loaded for (blob lifetime guard). */
let msPdfDocId: string | null = null
let msPdfBuildId: string | null = null
// TEX-03 (P0-3): live-preview projection (GET /v1/documents/{id}/preview-builds).
export let msPreviews: ManuscriptBuild[] = []
export let msPreviewPending: { document_id: string; revision: number; debounce_ms: number } | null = null
export let msPreviewPoll: number | undefined
export let msPreviewPdfUrl: string | null = null
export let msPreviewPdfBuildId: string | null = null
/** Document the preview PDF blob was loaded for (blob lifetime guard). */
let msPreviewPdfDocId: string | null = null
let msProjectId: string | null = null
let msGeneration = 0
const msControllers = new Set<AbortController>()
let msBuildPollToken: symbol | null = null
let msPreviewPollToken: symbol | null = null

function msReleaseMainPdfUrl(): void {
  if (msPdfUrl !== null) URL.revokeObjectURL(msPdfUrl)
  msPdfUrl = null
  msPdfDocId = null
  msPdfBuildId = null
}

function msReleasePreviewPdfUrl(): void {
  if (msPreviewPdfUrl !== null) URL.revokeObjectURL(msPreviewPdfUrl)
  msPreviewPdfUrl = null
  msPreviewPdfBuildId = null
  msPreviewPdfDocId = null
}

function msReleasePdfUrls(): void {
  msReleaseMainPdfUrl()
  msReleasePreviewPdfUrl()
}

function msTrackController(): AbortController {
  const controller = new AbortController()
  msControllers.add(controller)
  return controller
}

function msReleaseController(controller: AbortController): void {
  msControllers.delete(controller)
}

function msContextIsCurrent(generation: number, documentId: string | null, projectId: string | null = msProjectId): boolean {
  return generation === msGeneration && documentId === msDocId && projectId === msProjectId
}

/** Stop the current render generation. Leaving the panel additionally frees
 * every PDF URL; a same-document rerender keeps the already loaded PDF. */
export function msCleanup(releaseUrls = false): void {
  msGeneration += 1
  if (msBuildPoll !== undefined) { window.clearInterval(msBuildPoll); msBuildPoll = undefined }
  if (msPreviewPoll !== undefined) { window.clearInterval(msPreviewPoll); msPreviewPoll = undefined }
  for (const controller of msControllers) controller.abort()
  msControllers.clear()
  msBuildPollToken = null
  msPreviewPollToken = null
  if (releaseUrls) {
    msReleasePdfUrls()
    msProjectId = null
  }
}

export async function msLoadDocument(projectId: string, signal?: AbortSignal): Promise<{ document_id: string }> {
  // P0-3 (TEX-01): opening a manuscript is READ-ONLY — GET the existing
  // workspace first; only when nothing exists yet do we POST to create it.
  // A render/rerender therefore never writes: no regeneration, no revision
  // bump, no overwrite of saved content.
  const path = `/v1/projects/${encodeURIComponent(projectId)}/manuscript-drafts`
  const existing = await apiResult<{ document_id: string }>(path, { signal })
  if (existing.ok) return existing.data
  // Only the explicit absence contract may turn a read into first-time
  // creation. Auth, server and transport errors stay read-only/fail-closed.
  if (existing.status !== 404 || signal?.aborted === true) return { document_id: '' }
  return (await api<{ document_id: string }>(path, {
    method: 'POST',
    signal,
    body: JSON.stringify({}),
  })) ?? { document_id: '' }
}

export async function msLoadTree(): Promise<boolean> {
  if (msDocId === null) return false
  const documentId = msDocId
  const generation = msGeneration
  const projectId = msProjectId
  const controller = msTrackController()
  const result = await apiResult<{ document: { revision: number }; files: ManuscriptFile[] }>(`/v1/documents/${encodeURIComponent(documentId)}/tree`, { signal: controller.signal })
  msReleaseController(controller)
  if (!msContextIsCurrent(generation, documentId, projectId)) return false
  if (!result.ok) {
    msRecordFailure(result.error, result.status, 'reload')
    return false
  }
  msRevision = result.data.document.revision
  msFiles = result.data.files
  return true
}

export async function msOpenFile(path: string): Promise<void> {
  if (msDocId === null) return
  if (msDirty && msOpenPath !== null && msOpenPath !== path) {
    const keep = window.confirm(t('manuscript', 'manuscript.editor.discard', { path: msOpenPath }))
    if (!keep) return
  }
  const documentId = msDocId
  const generation = msGeneration
  const projectId = msProjectId
  const controller = msTrackController()
  const file = await api<{ path: string; version: number; content: string }>(`/v1/documents/${encodeURIComponent(documentId)}/file?path=${encodeURIComponent(path)}`, { signal: controller.signal })
  msReleaseController(controller)
  if (file === null || !msContextIsCurrent(generation, documentId, projectId)) return
  msOpenPath = path
  msContent = file.content
  msSavedVersion = file.version
  // §7 dirty baseline: the SAVED content from the file GET — the tree entry
  // carries no content, so it can never serve as the dirty baseline.
  msSavedContent = file.content
  msDirty = false
}

export async function msSaveFile(rerender = true): Promise<boolean> {
  if (msDocId === null || msOpenPath === null) return false
  const documentId = msDocId
  if (msSaving.has(documentId) || msReloading.has(documentId) || (rerender && msCompiling.has(documentId))) return false
  msSaving.add(documentId)
  msMutationEpoch += 1
  const openPath = msOpenPath
  const generation = msGeneration
  const projectId = msProjectId
  const savedContent = msContent
  try {
    const controller = msTrackController()
    const result = await apiResult<{ version: number; content_hash: string }>(`/v1/documents/${encodeURIComponent(documentId)}/file`, {
      method: 'PUT',
      signal: controller.signal,
      body: JSON.stringify({ path: openPath, content: savedContent, expected_version: msSavedVersion }),
    })
    msReleaseController(controller)
    if (!msContextIsCurrent(generation, documentId, projectId) || msOpenPath !== openPath) return false
    if (!result.ok) {
      msRecordFailure(result.error, result.status, 'save')
      return false
    }
    msSavedVersion = result.data.version
    // The server stored exactly the content we sent: that is the new baseline
    // (revert-to-saved must read clean, including a revert to '').
    msSavedContent = savedContent
    msDirty = msContent !== savedContent
    msConflict = null
    if (!await msLoadTree()) return false
    // P0-3 (TEX-03): save success triggers the live-preview hook ONCE. The
    // kernel owns the debounce (default 800ms) and coalesces rapid saves —
    // the client never schedules its own timer. Best-effort: a failed hook
    // call never fails the already-committed save.
    if (!msContextIsCurrent(generation, documentId, projectId)) return false
    // An explicit compile immediately follows this save; do not also queue a
    // preview or rerender away the in-flight compile context.
    if (!rerender) return true
    const previewController = msTrackController()
    try {
      await triggerPreviewAfterSave(documentId, id => api(`/v1/documents/${encodeURIComponent(id)}/preview-builds`, {
        method: 'POST',
        signal: previewController.signal,
        body: JSON.stringify({}),
      }))
    } finally {
      msReleaseController(previewController)
    }
    if (!msContextIsCurrent(generation, documentId, projectId) || msOpenPath !== openPath) return false
    await msPollPreviews()
    return msContextIsCurrent(generation, documentId, projectId)
  } finally {
    msSaving.delete(documentId)
    if (rerender && msContextIsCurrent(generation, documentId, projectId)) state.rerender()
  }
}

export async function msReloadFile(): Promise<void> {
  if (msDocId === null || msOpenPath === null || msMutationPending()) return
  const documentId = msDocId
  msReloading.add(documentId)
  msMutationEpoch += 1
  const openPath = msOpenPath
  const generation = msGeneration
  const projectId = msProjectId
  try {
    const controller = msTrackController()
    const file = await apiResult<{ path: string; version: number; content: string }>(`/v1/documents/${encodeURIComponent(documentId)}/file?path=${encodeURIComponent(openPath)}`, { signal: controller.signal })
    msReleaseController(controller)
    if (!msContextIsCurrent(generation, documentId, projectId) || msOpenPath !== openPath) return
    if (!file.ok) {
      msRecordFailure(file.error, file.status, 'reload')
      return
    }
    const treeLoaded = await msLoadTree()
    if (!msContextIsCurrent(generation, documentId, projectId) || msOpenPath !== openPath) return
    if (treeLoaded && msFiles.find(f => f.path === openPath)?.version === file.data.version) {
      msContent = file.data.content
      msSavedVersion = file.data.version
      msSavedContent = file.data.content
      msDirty = false
      msConflict = null
      msErrorDetails = ''
    } else if (treeLoaded) {
      msRecordFailure({ code: 'document_version_conflict' }, 409, 'reload')
    }
  } finally {
    msReloading.delete(documentId)
    if (msContextIsCurrent(generation, documentId, projectId)) state.rerender()
  }
}

export async function msCompile(): Promise<void> {
  if (msDocId === null) return
  const documentId = msDocId
  if (msMutationPending() || msBuilds.some(build => build.preview !== true && ['queued', 'running'].includes(build.status))) return
  msCompiling.add(documentId)
  msMutationEpoch += 1
  const generation = msGeneration
  const projectId = msProjectId
  try {
    // §4 row 95 (TEX-01): a failed save (409 conflict) must TERMINATE the
    // compile — the workspace revision moved under us and the frozen manifest
    // would not match what the editor holds. Save first, abort on conflict.
    if (msDirty) {
      const saved = await msSaveFile(false)
      if (!saved || msConflict !== null || !msContextIsCurrent(generation, documentId, projectId)) return
      if (msDirty) {
        msRecordFailure({ code: 'editor_changed_during_save', message: t('manuscript', 'manuscript.failure.changed') }, 409, 'compile')
        return
      }
    }
    if (!msContextIsCurrent(generation, documentId, projectId)) return
    let request = msCompileRequests.get(documentId)
    if (request === undefined || request.revision !== msRevision) {
      request = { revision: msRevision, key: `latex-ui:${documentId}:${msRevision}:${crypto.randomUUID()}` }
      msCompileRequests.set(documentId, request)
    }
    const controller = msTrackController()
    const result = await apiResult<{ build: ManuscriptBuild }>(`/v1/documents/${encodeURIComponent(documentId)}/builds`, {
      method: 'POST',
      signal: controller.signal,
      body: JSON.stringify({ expected_document_revision: msRevision, root_file: 'paper.tex', idempotency_key: request.key }),
    })
    msReleaseController(controller)
    if (!msContextIsCurrent(generation, documentId, projectId)) return
    if (!result.ok) {
      msRecordFailure(result.error, result.status, 'compile')
      return
    }
    msConflict = null
    msErrorDetails = ''
    msCompileRequests.delete(documentId)
    msBuilds = [result.data.build, ...msBuilds.filter(build => build.build_id !== result.data.build.build_id)]
  } finally {
    msCompiling.delete(documentId)
    if (msContextIsCurrent(generation, documentId, projectId)) state.rerender()
  }
}

export async function msPollBuilds(): Promise<void> {
  if (msBuildPollToken !== null) return
  if (msMutationPending()) return
  const token = Symbol('manuscript-build-poll')
  msBuildPollToken = token
  try {
    await msPollBuildsOnce()
  } finally {
    if (msBuildPollToken === token) msBuildPollToken = null
  }
}

async function msPollBuildsOnce(): Promise<void> {
  if (msDocId === null) return
  const documentId = msDocId
  const generation = msGeneration
  const projectId = msProjectId
  const before = JSON.stringify(msBuilds)
  const mutationEpoch = msMutationEpoch
  const controller = msTrackController()
  const builds = await api<ManuscriptBuild[]>(`/v1/documents/${encodeURIComponent(documentId)}/builds`, { signal: controller.signal })
  msReleaseController(controller)
  if (!msContextIsCurrent(generation, documentId, projectId) || mutationEpoch !== msMutationEpoch || msMutationPending()) return
  if (builds !== null) msBuilds = builds
  const running = msBuilds.some(b => b.preview !== true && (b.status === 'queued' || b.status === 'running'))
  if (running) {
    if (msBuildPoll === undefined) {
      msBuildPoll = window.setInterval(() => { void msPollBuilds() }, 2000)
    }
  } else {
    if (msBuildPoll !== undefined) { window.clearInterval(msBuildPoll); msBuildPoll = undefined }
  }
  // PDF preview for the newest successful authoritative build. A succeeded
  // build with no PDF supersedes and clears the old PDF; searching only for
  // builds that already have a PDF would incorrectly present an old draft as
  // the current successful result.
  let pdfNow = false
  const ok = latestSucceededManuscriptBuild(msBuilds, 'authoritative')
  if (ok?.pdf_artifact === null && (msPdfUrl !== null || msPdfBuildId !== null)) {
    msReleaseMainPdfUrl()
    pdfNow = true
  } else if (ok !== null && ok.pdf_artifact !== null && msPdfBuildId !== ok.build_id) {
    const pdfController = msTrackController()
    try {
      const headers = await authHeaders()
      if (!msContextIsCurrent(generation, documentId, projectId)) return
      const response = await fetch(`${base()}/v1/artifacts/${encodeURIComponent(ok.pdf_artifact)}?project_id=${encodeURIComponent(projectId ?? '')}`, {
        signal: pdfController.signal,
        headers: { accept: 'application/octet-stream', ...headers },
      })
      if (response.ok) {
        const blob = await response.blob()
        if (!msContextIsCurrent(generation, documentId, projectId)) return
        const url = URL.createObjectURL(new Blob([blob], { type: 'application/pdf' }))
        if (!msContextIsCurrent(generation, documentId, projectId)) {
          URL.revokeObjectURL(url)
          return
        }
        if (msPdfUrl !== null) URL.revokeObjectURL(msPdfUrl)
        msPdfUrl = url
        msPdfDocId = documentId
        msPdfBuildId = ok.build_id
        pdfNow = true
      }
    } catch {
      // Cancellation is expected when the user switches document/panel;
      // transport/decode failures leave the previous projection untouched.
    } finally {
      msReleaseController(pdfController)
    }
  }
  // Rerender ONLY when something visibly changed. An unconditional
  // state.rerender here plus renderManuscript()'s trailing msPollBuilds() call
  // would form a hot loop: render → poll → state.rerender → render → … at
  // ~5 requests/cycle, exhausting the loopback rate limit in seconds.
  if (!msMutationPending() && !msDirty && (before !== JSON.stringify(msBuilds) || pdfNow)) state.rerender()
}

/** TEX-03 (P0-3): poll the live-preview projection (pending debounce +
 * preview builds). The PDF of the newest SUCCEEDED preview is loaded once
 * per build id; a newer succeeded build replaces it. Same hot-loop guard
 * as msPollBuilds: rerender only on visible change. */
export async function msPollPreviews(): Promise<void> {
  if (msPreviewPollToken !== null) return
  if (msMutationPending()) return
  const token = Symbol('manuscript-preview-poll')
  msPreviewPollToken = token
  try {
    await msPollPreviewsOnce()
  } finally {
    if (msPreviewPollToken === token) msPreviewPollToken = null
  }
}

async function msPollPreviewsOnce(): Promise<void> {
  if (msDocId === null) return
  const documentId = msDocId
  const generation = msGeneration
  const projectId = msProjectId
  const before = JSON.stringify({ p: msPreviewPending, b: msPreviews })
  const mutationEpoch = msMutationEpoch
  const controller = msTrackController()
  const status = await api<{ pending: { document_id: string; revision: number; debounce_ms: number } | null; builds: ManuscriptBuild[] }>(`/v1/documents/${encodeURIComponent(documentId)}/preview-builds`, { signal: controller.signal })
  msReleaseController(controller)
  if (!msContextIsCurrent(generation, documentId, projectId) || mutationEpoch !== msMutationEpoch || msMutationPending()) return
  if (status !== null) {
    msPreviewPending = status.pending
    msPreviews = status.builds
  }
  const busy = msPreviewPending !== null || msPreviews.some(b => b.status === 'queued' || b.status === 'running')
  if (busy) {
    if (msPreviewPoll === undefined) {
      msPreviewPoll = window.setInterval(() => { void msPollPreviews() }, 2000)
    }
  } else {
    if (msPreviewPoll !== undefined) { window.clearInterval(msPreviewPoll); msPreviewPoll = undefined }
  }
  let pdfNow = false
  const ok = latestSucceededManuscriptBuild(msPreviews, 'preview')
  if (ok?.pdf_artifact === null && (msPreviewPdfUrl !== null || msPreviewPdfBuildId !== null)) {
    msReleasePreviewPdfUrl()
    pdfNow = true
  } else if (ok !== null && ok.pdf_artifact !== null && msPreviewPdfBuildId !== ok.build_id) {
    const pdfController = msTrackController()
    try {
      const headers = await authHeaders()
      if (!msContextIsCurrent(generation, documentId, projectId)) return
      const response = await fetch(`${base()}/v1/artifacts/${encodeURIComponent(ok.pdf_artifact)}?project_id=${encodeURIComponent(projectId ?? '')}`, {
        signal: pdfController.signal,
        headers: { accept: 'application/octet-stream', ...headers },
      })
      if (response.ok) {
        const blob = await response.blob()
        if (!msContextIsCurrent(generation, documentId, projectId)) return
        const url = URL.createObjectURL(new Blob([blob], { type: 'application/pdf' }))
        if (!msContextIsCurrent(generation, documentId, projectId)) {
          URL.revokeObjectURL(url)
          return
        }
        if (msPreviewPdfUrl !== null) URL.revokeObjectURL(msPreviewPdfUrl)
        msPreviewPdfUrl = url
        msPreviewPdfBuildId = ok.build_id
        msPreviewPdfDocId = documentId
        pdfNow = true
      }
    } catch {
      // See msPollBuilds: stale/aborted PDF reads must not reject an
      // intentionally fire-and-forget poll or mutate the current document.
    } finally {
      msReleaseController(pdfController)
    }
  }
  if (!msMutationPending() && !msDirty && (before !== JSON.stringify({ p: msPreviewPending, b: msPreviews }) || pdfNow)) state.rerender()
}

/** P0-3 (TEX-01): explicit regeneration — confirmed by the user, never
 * triggered by a render. The server freezes the CURRENT content as a
 * revision-scoped snapshot BEFORE rewriting, so the old bytes stay
 * revertable (GET /v1/documents/{id}/snapshot-files?revision=&path=). */
export async function msRegenerate(projectId: string): Promise<void> {
  if (!window.confirm(t('manuscript', 'manuscript.regenerate.confirm'))) return
  if (msDocId === null || msProjectId !== projectId) return
  const documentId = msDocId
  const generation = msGeneration
  const controller = msTrackController()
  const result = await api<{ document_id: string; revision: number }>(`/v1/projects/${encodeURIComponent(projectId)}/manuscript-drafts`, {
    method: 'POST',
    signal: controller.signal,
    body: JSON.stringify({ regenerate: true }),
  })
  msReleaseController(controller)
  if (!msContextIsCurrent(generation, documentId, projectId)) return
  if (result === null) {
    window.alert(t('manuscript', 'manuscript.regenerate.failed'))
    return
  }
  // The workspace changed under the editor: adopt the new document, reload
  // the tree and reopen the current file at the new bytes. The old preview
  // PDF belongs to the pre-regeneration revision — drop it (the next
  // preview poll shows the fresh projection).
  msReleasePdfUrls()
  msDocId = result.document_id
  await msLoadTree()
  if (!msContextIsCurrent(generation, result.document_id, projectId)) return
  if (msOpenPath !== null) {
    await msOpenFile(msOpenPath)
  } else {
    const root = msFiles.find(f => f.path === 'paper.tex') ?? msFiles[0]
    if (root !== undefined) await msOpenFile(root.path)
  }
  await msPollPreviews()
  if (!msContextIsCurrent(generation, result.document_id, projectId)) return
  state.rerender()
}

/** dsh-web Manuscript page: tree | editor | diagnostics+PDF. */
export async function renderManuscript(
  body: HTMLElement,
  _p: Projection,
  projectId: string,
  methodology?: CompactMethodologyProjection | null,
): Promise<void> {
  msCleanup()
  const generation = msGeneration
  msProjectId = projectId
  const host = document.querySelector('#dsh-scholar-ui') as HTMLElement | null
  host?.setAttribute('data-project', projectId)
  const controller = msTrackController()
  const doc = await msLoadDocument(projectId, controller.signal)
  msReleaseController(controller)
  if (generation !== msGeneration || msProjectId !== projectId) return
  if (doc.document_id === '') {
    body.appendChild(el('div', 'error-banner', t('manuscript', 'manuscript.workspaceUnavailable')))
    return
  }
  const firstLoad = msDocId !== doc.document_id
  if (firstLoad) {
    msReleasePdfUrls()
    msFiles = []
    msRevision = 1
    msOpenPath = null
    msContent = ''
    msSavedVersion = 0
    msSavedContent = ''
    msDirty = false
    msConflict = null
    msErrorDetails = ''
    msBuilds = []
    msPreviews = []
    msPreviewPending = null
  }
  msDocId = doc.document_id
  await msLoadTree()
  if (!msContextIsCurrent(generation, doc.document_id, projectId)) return
  if (firstLoad) {
    const root = msFiles.find(f => f.path === 'paper.tex') ?? msFiles[0]
    if (root !== undefined) await msOpenFile(root.path)
  } else if (!msDirty && msOpenPath !== null && msFiles.find(file => file.path === msOpenPath)?.version !== msSavedVersion) {
    // A background tree refresh must not pair a new document revision with
    // old clean editor bytes. Dirty content still uses its original CAS base.
    await msOpenFile(msOpenPath)
  }
  if (!msContextIsCurrent(generation, doc.document_id, projectId)) return
  const docId = msDocId

  // Header: document, revision, save state, actions.
  const header = el('div', 'row')
  header.style.cssText = 'justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px;margin-bottom:8px'
  const title = el('span', 'pname', t('manuscript', 'manuscript.header.doc', { id: docId.slice(0, 16), rev: String(msRevision) }) + (msDirty ? t('manuscript', 'manuscript.header.unsaved') : ''))
  title.style.cssText = 'font-size:12px'
  header.appendChild(title)
  const actions = el('div', 'row')
  actions.style.cssText = 'gap:6px;flex-wrap:wrap'
  const saveBtn = el('button', 'hbtn', t('manuscript', 'manuscript.action.save'))
  saveBtn.disabled = !msDirty || msMutationPending()
  saveBtn.onclick = () => { saveBtn.disabled = true; void msSaveFile() }
  const compileBtn = el('button', 'btn approve', t('manuscript', 'manuscript.action.compile'))
  compileBtn.style.cssText = 'padding:4px 14px'
  // §4 row 95: prevent duplicate submits while a build is queued/running.
  compileBtn.disabled = msMutationPending() || msBuilds.some(b => b.preview !== true && (b.status === 'queued' || b.status === 'running'))
  compileBtn.onclick = () => {
    compileBtn.disabled = true
    compileBtn.textContent = t('manuscript', 'manuscript.action.submitting')
    void msCompile()
  }
  const refreshBtn = el('button', 'hbtn', '⟳')
  refreshBtn.title = t('manuscript', 'manuscript.action.refresh')
  refreshBtn.setAttribute('aria-label', refreshBtn.title)
  refreshBtn.onclick = () => { void msLoadTree().then(() => state.rerender()) }
  // P0-3 (TEX-01): regeneration is EXPLICIT and confirmed — rendering,
  // saving and polling never rewrite the workspace.
  const regenBtn = el('button', 'hbtn', t('manuscript', 'manuscript.action.regenerate'))
  regenBtn.title = t('manuscript', 'manuscript.action.regenerate')
  regenBtn.onclick = () => { void msRegenerate(projectId) }
  actions.append(saveBtn, compileBtn, refreshBtn, regenBtn)
  header.appendChild(actions)
  body.appendChild(header)

  body.appendChild(methodologySummaryNode(methodology, 'manuscript'))

  if (msConflict !== null) {
    const banner = el('div', 'card border-red')
    banner.style.cssText = 'display:flex;align-items:center;gap:10px;margin-bottom:8px;flex-wrap:wrap'
    banner.setAttribute('role', 'alert')
    banner.appendChild(el('span', 'grow', `⚠ ${msConflict}`))
    const recoveryKey = msErrorRecovery === 'reload' ? 'manuscript.action.reload' : msErrorRecovery === 'settings' ? 'manuscript.action.settings' : 'manuscript.action.retry'
    const reloadBtn = el('button', 'hbtn', t('manuscript', recoveryKey))
    reloadBtn.onclick = () => {
      if (msErrorRecovery === 'reload') {
        if (msDirty && !window.confirm(t('manuscript', 'manuscript.editor.discard', { path: msOpenPath ?? '' }))) return
        void msReloadFile()
      } else if (msErrorRecovery === 'settings') {
        void openSettingsModal(rootHost(), msSettingsKey)
      } else {
        reloadBtn.disabled = true
        if (msFailedOperation === 'save') void msSaveFile()
        else if (msFailedOperation === 'reload') void msReloadFile()
        else void msCompile()
      }
    }
    banner.appendChild(reloadBtn)
    if (msErrorDetails !== '') {
      const details = el('details')
      details.style.cssText = 'width:100%;font-size:11px;overflow-wrap:anywhere'
      details.append(el('summary', '', t('manuscript', 'manuscript.failure.details')), el('div', 'muted', msErrorDetails))
      banner.appendChild(details)
    }
    body.appendChild(banner)
  }

  const layout = el('div', 'manuscript-layout')
  const columns = el('div', 'manuscript-layout-grid')
  layout.appendChild(columns)
  body.appendChild(layout)

  // File tree.
  const treeCol = el('div')
  treeCol.style.cssText = 'min-width:0;border:1px solid var(--border);border-radius:10px;padding:8px;overflow-y:auto;max-height:640px'
  treeCol.appendChild(el('div', 'section-label', t('manuscript', 'manuscript.files')))
  for (const f of msFiles) {
    const row = el('button')
    row.style.cssText = 'display:flex;align-items:center;gap:6px;width:100%;border:0;background:none;color:var(--text);text-align:left;padding:4px 6px;border-radius:6px;cursor:pointer;font:11px/1.4 ui-monospace,Menlo,monospace'
    if (f.path === msOpenPath) row.style.cssText += ';background:var(--accent-soft)'
    row.onmouseenter = () => { if (f.path !== msOpenPath) row.style.background = 'var(--bg-hover)' }
    row.onmouseleave = () => { row.style.background = f.path === msOpenPath ? 'var(--accent-soft)' : 'none' }
    row.appendChild(el('span', '', f.path))
    row.appendChild(el('span', 'muted', `v${f.version}`))
    row.style.cssText += ';justify-content:space-between'
    row.onclick = () => { void msOpenFile(f.path).then(() => state.rerender()) }
    treeCol.appendChild(row)
  }
  const newFileBtn = el('button', 'hbtn', t('manuscript', 'manuscript.action.newFile'))
  newFileBtn.style.cssText = 'margin-top:8px;width:100%'
  newFileBtn.onclick = () => {
    const name = window.prompt(t('manuscript', 'manuscript.newFilePrompt'), 'section.tex')
    if (name === null || name.trim() === '') return
    void api(`/v1/documents/${encodeURIComponent(docId)}/file`, {
      method: 'PUT',
      body: JSON.stringify({ path: name.trim(), content: '', expected_version: 0 }),
    }).then(() => msLoadTree()).then(() => state.rerender())
  }
  treeCol.appendChild(newFileBtn)
  columns.appendChild(treeCol)

  // Editor.
  const editorCol = el('div')
  editorCol.style.cssText = 'flex:1;display:flex;flex-direction:column;min-width:0'
  const editorHead = el('div', 'row')
  editorHead.style.cssText = 'justify-content:space-between;align-items:center;margin-bottom:4px'
  editorHead.appendChild(el('span', 'muted', msOpenPath !== null ? `${msOpenPath} · v${msSavedVersion}` : t('manuscript', 'manuscript.editor.noFile')))
  const closeEdit = el('button', 'hbtn ghost', '×')
  closeEdit.title = t('manuscript', 'manuscript.editor.close')
  closeEdit.setAttribute('aria-label', closeEdit.title)
  closeEdit.onclick = () => {
    if (msDirty && !window.confirm(t('manuscript', 'manuscript.editor.discard', { path: msOpenPath ?? '' }))) return
    msOpenPath = null; msContent = ''; msSavedContent = ''; msDirty = false; state.rerender()
  }
  editorHead.appendChild(closeEdit)
  editorCol.appendChild(editorHead)
  if (msOpenPath !== null) {
    const ta = el('textarea')
    ta.value = msContent
    ta.setAttribute('aria-label', msOpenPath)
    ta.spellcheck = false
    ta.style.cssText = 'flex:1;resize:none;background:var(--bg-input);color:var(--text);border:1px solid var(--border);border-radius:10px;padding:10px 12px;font:11.5px/1.6 ui-monospace,Menlo,monospace;outline:none;min-height:420px;white-space:pre'
    ta.oninput = () => {
      msContent = ta.value
      // §7 dirty-before-compile: compare against the SAVED content — clearing
      // a non-empty file ('' !== saved) must read dirty; reverting to the
      // saved bytes (including '') must read clean.
      msDirty = isEditorDirty(ta.value, msSavedContent)
      saveBtn.disabled = !msDirty || msMutationPending()
      title.textContent = t('manuscript', 'manuscript.header.doc', { id: docId.slice(0, 16), rev: String(msRevision) }) + (msDirty ? t('manuscript', 'manuscript.header.unsaved') : '')
      // Mark the PDF stale in place. Re-rendering here would replace the
      // textarea and break focus, selection and IME composition.
      const stale = body.querySelector<HTMLElement>('[data-manuscript-main-pdf-stale]')
      if (stale !== null) {
        stale.hidden = !displayedManuscriptPdfIsStale(msBuilds, msPdfBuildId, msRevision, 'authoritative', msDirty)
      }
    }
    ta.onkeydown = (event) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') {
        event.preventDefault()
        void msSaveFile()
      }
    }
    editorCol.appendChild(ta)
  } else {
    editorCol.appendChild(el('div', 'empty', t('manuscript', 'manuscript.editor.empty')))
  }
  columns.appendChild(editorCol)

  // Diagnostics + PDF preview.
  const rightCol = el('div')
  rightCol.style.cssText = 'min-width:0;border:1px solid var(--border);border-radius:10px;padding:8px;overflow-y:auto;max-height:640px'
  // TEX-03 (P0-3): live preview — save success triggers the debounced
  // preview-builds hook; this section shows the projected status
  // (pending/queued/running/succeeded/failed/cancelled/superseded + stale)
  // and the newest succeeded preview's PDF. Browser-visual acceptance of
  // the auto-refresh chain stays NOT_RUN_MANUAL_PENDING (no Playwright).
  rightCol.appendChild(el('div', 'section-label', t('manuscript', 'manuscript.preview.title')))
  const previewModel = previewPanelModel(msPreviewPending, msPreviews, msRevision)
  const previewLine = el('div', 'muted')
  previewLine.style.cssText = 'font-size:10.5px;margin:2px 0 6px'
  previewLine.textContent = t('manuscript', previewModel.headline)
  rightCol.appendChild(previewLine)
  // The iframe shows the last SUCCEEDED preview PDF; it is stale whenever the
  // newest preview moved past it (newer queued/running/succeeded revision or
  // the document revision itself advanced past the PDF's build).
  const pdfStale = previewModel.stale || (
    msPreviewPdfUrl !== null
    && (
      previewModel.status !== 'succeeded'
      || displayedManuscriptPdfIsStale(msPreviews, msPreviewPdfBuildId, msRevision, 'preview')
    )
  )
  if (pdfStale) {
    const stale = el('span', 'muted')
    stale.style.cssText = 'color:var(--tone-amber);font-size:10px;font-weight:700'
    stale.textContent = t('manuscript', 'manuscript.preview.stale')
    rightCol.appendChild(stale)
  }
  if (msPreviewPdfUrl !== null) {
    const frame = document.createElement('iframe')
    frame.src = msPreviewPdfUrl
    frame.title = t('manuscript', 'manuscript.preview.title')
    frame.style.cssText = 'width:100%;height:280px;border:1px solid var(--border);border-radius:8px'
    rightCol.appendChild(frame)
    const dl = el('button', 'hbtn', t('manuscript', 'manuscript.preview.download'))
    dl.style.cssText = 'margin:6px 0 10px'
    dl.onclick = () => {
      const a = el('a', 'dl', t('common', 'common.action.download'))
      a.href = msPreviewPdfUrl ?? ''
      a.download = 'paper.preview.pdf'
      document.body.appendChild(a)
      a.click()
      a.remove()
    }
    rightCol.appendChild(dl)
  }
  rightCol.appendChild(el('div', 'section-label', t('manuscript', 'manuscript.builds')))
  if (msBuilds.length === 0) {
    rightCol.appendChild(el('div', 'muted', t('manuscript', 'manuscript.builds.none')))
  }
  for (const b of msBuilds.filter(build => build.preview !== true).slice(0, 6)) {
    const card = el('div', 'card')
    card.style.cssText = 'padding:6px 8px;margin:4px 0'
    const head = el('div', 'row')
    head.style.cssText = 'justify-content:space-between'
    head.appendChild(el('span', 'artifact-kind', b.status.toUpperCase()))
    // Input revision of THIS build (freshness baseline): the kernel freezes
    // the manifest at b.revision; document moves past it make the PDF stale.
    head.appendChild(el('span', 'muted', t('manuscript', 'manuscript.buildMeta', { rev: String(b.revision), build: b.build_id.slice(0, 12) })))
    card.appendChild(head)
    if (b.revision < msRevision) {
      const stale = el('span', 'muted')
      stale.style.cssText = 'color:var(--tone-amber);font-size:10px;font-weight:700'
      stale.textContent = t('manuscript', 'manuscript.builds.stale')
      card.appendChild(stale)
    }
    if (b.job_id !== null && b.job_id !== '') {
      // §4 row 95: cross-link the build to its latex-compile Job's live
      // Terminal (SSE GET /v1/jobs/{job_id}/terminal; same job_id as the
      // Runs/Terminal tab).
      const termBtn = el('button', 'hbtn', '🖥')
      termBtn.title = t('manuscript', 'manuscript.builds.openTerminal')
      termBtn.setAttribute('aria-label', termBtn.title)
      termBtn.style.cssText = 'padding:0 6px;font-size:9px;flex-shrink:0'
      termBtn.onclick = () => {
        state.terminalRunId = b.job_id!
        state.terminalLines = []
        state.terminalLastSeq = 0
        state.terminalTotalBytes = 0
        state.terminalDroppedBytes = 0
        state.terminalTruncated = false
        state.terminalExitCode = null
        state.terminalExitSignal = null
        state.terminalStatus = 'idle'
        terminalLoadSeq()
        state.activeTab = 'terminal'
        tabSave()
        state.rerender()
      }
      card.appendChild(termBtn)
    }
    let diagnostics: Array<{ level: string; message: string }> = []
    try { diagnostics = JSON.parse(b.diagnostics) as Array<{ level: string; message: string }> } catch { /* empty */ }
    if (diagnostics.length > 0) {
      const levels: Record<string, string> = { error: 'var(--tone-red)', warning: 'var(--tone-amber)', info: 'var(--text-3)' }
      for (const d of diagnostics.slice(0, 8)) {
        const row = el('div', 'muted')
        row.style.cssText = `font-size:10.5px;color:${levels[d.level] ?? 'var(--text-3)'};margin-top:2px;white-space:pre-wrap;word-break:break-word`
        row.textContent = `${d.level}: ${d.message}`
        card.appendChild(row)
      }
      if (diagnostics.length > 8) card.appendChild(el('div', 'muted', t('manuscript', 'manuscript.builds.more', { count: String(diagnostics.length - 8) })))
    }
    rightCol.appendChild(card)
  }
  if (msPdfUrl !== null) {
    rightCol.appendChild(el('div', 'section-label', t('manuscript', 'manuscript.pdf.title')))
    const stale = el('span', 'muted')
    stale.dataset.manuscriptMainPdfStale = 'true'
    stale.style.cssText = 'color:var(--tone-amber);font-size:10px;font-weight:700;margin-bottom:4px'
    stale.textContent = t('manuscript', 'manuscript.builds.stale')
    stale.hidden = !displayedManuscriptPdfIsStale(msBuilds, msPdfBuildId, msRevision, 'authoritative', msDirty)
    rightCol.appendChild(stale)
    const frame = document.createElement('iframe')
    frame.src = msPdfUrl
    frame.title = t('manuscript', 'manuscript.pdf.title')
    frame.style.cssText = 'width:100%;height:420px;border:1px solid var(--border);border-radius:8px'
    rightCol.appendChild(frame)
    const dl = el('button', 'hbtn', t('manuscript', 'manuscript.pdf.download'))
    dl.style.cssText = 'margin-top:6px'
    dl.onclick = () => {
      const a = el('a', 'dl', t('common', 'common.action.download'))
      a.href = msPdfUrl ?? ''
      a.download = 'paper.pdf'
      document.body.appendChild(a)
      a.click()
      a.remove()
    }
    rightCol.appendChild(dl)
  }
  columns.appendChild(rightCol)

  void msPollBuilds()
  void msPollPreviews()
}
