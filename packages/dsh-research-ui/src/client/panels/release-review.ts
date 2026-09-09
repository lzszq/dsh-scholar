import type { ArtifactRow, ClaimRow, ManuscriptBuild, Projection } from '../types'
import { apiResult } from '../api'
import { t } from '../i18n/index'
import { el, fmtId } from '../ui'
import { state, tabSave } from '../state'
import type { CompactMethodologyProjection } from '../methodology-projection'
import { releaseBuildState } from '../release-review-model'
import { openResearchArtifact } from './artifacts'

/** Read-only context for the human release decision. Failures stay visible. */
export async function renderReleaseReview(
  body: HTMLElement, projectId: string, projection: Projection, methodology?: CompactMethodologyProjection | null,
): Promise<void> {
  const section = el('section', 'card')
  section.setAttribute('aria-label', t('overview', 'overview.releaseReview.title'))
  section.style.cssText = 'padding:12px;margin:8px 0 14px'
  section.appendChild(el('div', 'section-label', t('overview', 'overview.releaseReview.title')))
  section.appendChild(el('div', 'muted', t('overview', 'overview.releaseReview.version', {
    name: projection.project?.name ?? projectId, revision: String(projection.project?.revision ?? '—'),
  })))
  section.appendChild(el('div', 'muted', t('overview', 'overview.releaseReview.scope')))
  body.appendChild(section)
  const path = `/v1/projects/${encodeURIComponent(projectId)}`
  const [artifacts, claims, document] = await Promise.all([
    apiResult<ArtifactRow[]>(`${path}/artifacts`),
    apiResult<ClaimRow[]>(`${path}/claims`),
    apiResult<{ document_id: string }>(`${path}/manuscript-drafts`),
  ])
  const note = (text: string): void => {
    const row = el('div', 'muted', text)
    row.style.cssText = 'margin:6px 0;overflow-wrap:anywhere'
    section.appendChild(row)
  }
  const action = (label: string, tab: string): void => {
    const button = el('button', 'hbtn', label)
    button.style.cssText = 'margin:4px 6px 4px 0'
    button.onclick = () => { state.activeTab = tab; tabSave(); state.rerender() }
    section.appendChild(button)
  }
  if (document.ok) {
    const docPath = `/v1/documents/${encodeURIComponent(document.data.document_id)}`
    const [tree, builds] = await Promise.all([
      apiResult<{ document: { revision: number } }>(`${docPath}/tree`),
      apiResult<ManuscriptBuild[]>(`${docPath}/builds`),
    ])
    if (tree.ok && builds.ok) {
      note(t('overview', 'overview.releaseReview.manuscript', { revision: String(tree.data.document.revision) }))
      note(t('overview', `overview.releaseReview.build.${releaseBuildState(tree.data.document.revision, builds.data)}`))
    } else note(t('overview', 'overview.releaseReview.unavailable'))
  } else note(t('overview', document.status === 404 ? 'overview.releaseReview.noManuscript' : 'overview.releaseReview.unavailable'))
  action(t('overview', 'overview.releaseReview.openManuscript'), 'manuscript')
  if (artifacts.ok) {
    const bundle = [...artifacts.data].reverse().find(artifact => artifact.kind === 'bundle' && artifact.metadata?.kind === 'release-bundle')
    if (bundle?.artifact_id) {
      const id = bundle.artifact_id
      const button = el('button', 'hbtn', `${t('overview', 'overview.releaseReview.openBundle')} · ${fmtId(id, 22)}`)
      button.onclick = () => { void openResearchArtifact(projectId, id) }
      section.appendChild(button)
    } else note(t('overview', 'overview.releaseReview.noBundle'))
  } else note(t('overview', 'overview.releaseReview.unavailable'))
  if (claims.ok) {
    const supported = claims.data.filter(claim => claim.status === 'supported')
    if (supported.length === 0) note(t('overview', 'overview.releaseReview.noClaims'))
    for (const claim of supported.slice(0, 3)) note(claim.statement ?? claim.claim_id ?? '')
  } else note(t('overview', 'overview.releaseReview.unavailable'))
  action(t('overview', 'overview.releaseReview.openEvidence'), 'evidence')
  if (methodology == null) note(t('overview', 'overview.releaseReview.unavailable'))
  else if (methodology.protocol?.status !== 'frozen') note(t('overview', 'overview.releaseReview.protocol'))
  const failed = projection.jobs?.filter(job => job.status === 'failed').length ?? 0
  if (failed > 0) {
    note(t('overview', 'overview.releaseReview.failedRuns', { count: String(failed) }))
    action(t('runs', 'runs.openRunsTab'), 'runs')
  }
}
