/**
 * P0-3 (TEX-01/TEX-03) manuscript open/preview flow — PURE client logic
 * (no DOM, no fetch, no module state) so the read-only open decision and
 * the live-preview panel model are unit-testable without a browser.
 *
 *  - resolveOpenDocument: GET-first-then-create — a render/rerender never
 *    writes: the existing workspace is returned as-is and create() runs
 *    ONLY when the read-only GET found nothing.
 *  - previewPanelModel: maps the server preview projection
 *    ({ pending, builds[] } from GET /v1/documents/{id}/preview-builds)
 *    onto the minimal UI model: headline status text, stale flag and
 *    whether the newest succeeded preview has a downloadable PDF.
 */
import type { ManuscriptBuild } from './types'
import type { ApiErrorEnvelope } from './api'

export function manuscriptFailureModel(error: ApiErrorEnvelope, status: number): {
  key: string; recovery: 'reload' | 'settings' | 'retry'
} {
  if (error.code === 'document_version_conflict' || error.code === 'workspace_version_conflict') {
    return { key: 'manuscript.failure.conflict', recovery: 'reload' }
  }
  if (error.code === 'editor_changed_during_save') return { key: 'manuscript.failure.changed', recovery: 'retry' }
  if (error.code === 'network_error' || status === 0) return { key: 'manuscript.failure.network', recovery: 'retry' }
  if (status === 401 || status === 403) return { key: 'manuscript.failure.access', recovery: 'settings' }
  if (error.code?.startsWith('runner_') === true || error.code === 'container_execution_required'
    || error.code === 'image_digest_required' || error.code === 'tex_image_required') {
    return { key: 'manuscript.failure.runner', recovery: 'settings' }
  }
  return { key: 'manuscript.failure.other', recovery: 'retry' }
}

export interface OpenDocumentResult { document_id: string }

/**
 * The build endpoints return newest-first projections. Select the newest
 * succeeded build before looking at pdf_artifact: a succeeded build with no
 * PDF is authoritative evidence that an older PDF must be cleared.
 */
export function latestSucceededManuscriptBuild(
  builds: ManuscriptBuild[],
  projection: 'authoritative' | 'preview',
): ManuscriptBuild | null {
  return builds.find(build =>
    build.status === 'succeeded'
    && (projection === 'preview' || build.preview !== true),
  ) ?? null
}

/** Whether a currently displayed PDF no longer represents the editor/projection. */
export function displayedManuscriptPdfIsStale(
  builds: ManuscriptBuild[],
  displayedBuildId: string | null,
  documentRevision: number,
  projection: 'authoritative' | 'preview',
  editorDirty = false,
): boolean {
  if (displayedBuildId === null) return false
  const scoped = projection === 'authoritative'
    ? builds.filter(build => build.preview !== true)
    : builds
  const displayed = scoped.find(build => build.build_id === displayedBuildId)
  if (displayed === undefined) return true
  return editorDirty
    || displayed.revision < documentRevision
    || scoped[0]?.build_id !== displayedBuildId
}

/**
 * P0-3 (TEX-03): fire the save-success preview hook EXACTLY ONCE per
 * successful save. The kernel owns the debounce timer (default 800ms) and
 * coalesces rapid saves — the client never schedules its own timer and
 * never fires more than once per save. Best-effort: a failed hook call
 * returns false but must NOT fail the save (the write already committed).
 */
export async function triggerPreviewAfterSave(
  documentId: string,
  postPreview: (documentId: string) => Promise<unknown>,
): Promise<boolean> {
  if (documentId === '') return false
  return (await postPreview(documentId)) !== null
}

/**
 * P0-3 (TEX-01): open a manuscript read-only first; create only when
 * nothing exists yet. `getExisting` must be the strictly read-only GET
 * (server 404s when absent — never creates), `create` the POST that
 * generates on first use. A failed creation degrades to the caller's
 * "workspace unavailable" marker ('' — same contract as the previous
 * always-POST flow).
 */
export async function resolveOpenDocument(
  getExisting: () => Promise<OpenDocumentResult | null>,
  create: () => Promise<OpenDocumentResult | null>,
): Promise<OpenDocumentResult> {
  const existing = await getExisting()
  if (existing !== null) return existing
  return (await create()) ?? { document_id: '' }
}

export type PreviewHeadline =
  | 'manuscript.preview.pending'
  | 'manuscript.preview.queued'
  | 'manuscript.preview.running'
  | 'manuscript.preview.succeeded'
  | 'manuscript.preview.failed'
  | 'manuscript.preview.cancelled'
  | 'manuscript.preview.superseded'
  | 'manuscript.preview.none'
  | 'manuscript.preview.unknown'

export interface PreviewPanelModel {
  /** i18n key for the headline status text. */
  headline: PreviewHeadline
  /** Raw server status ('pending' | build status | 'none' | 'unknown'). */
  status: string
  /** Newest preview build is older than the document revision → stale PDF. */
  stale: boolean
  /** Newest preview build succeeded with a pdf_artifact → PDF link shown. */
  hasPdf: boolean
}

const KNOWN_BUILD_STATUSES = ['queued', 'running', 'succeeded', 'failed', 'cancelled', 'superseded'] as const

/**
 * P0-3 (TEX-03): minimal viable preview panel model from the server
 * projection. A durable pending debounce request headlines 'pending' (the
 * kernel owns the timer — UI reconnect/kernel restart re-project it).
 * Otherwise the NEWEST preview build's status drives the headline; stale
 * (build.revision < document.revision) and PDF availability come from it.
 * Unknown statuses fall back to a safe 'unknown' headline (never a raw
 * missing i18n key).
 */
export function previewPanelModel(
  pending: { revision: number } | null,
  builds: ManuscriptBuild[],
  documentRevision: number,
): PreviewPanelModel {
  if (pending !== null) {
    return { headline: 'manuscript.preview.pending', status: 'pending', stale: false, hasPdf: false }
  }
  const latest = builds[0]
  if (latest === undefined) {
    return { headline: 'manuscript.preview.none', status: 'none', stale: false, hasPdf: false }
  }
  const known = (KNOWN_BUILD_STATUSES as readonly string[]).includes(latest.status)
  return {
    headline: known ? `manuscript.preview.${latest.status}` as PreviewHeadline : 'manuscript.preview.unknown',
    status: latest.status,
    stale: latest.revision < documentRevision,
    hasPdf: latest.status === 'succeeded' && latest.pdf_artifact !== null,
  }
}
