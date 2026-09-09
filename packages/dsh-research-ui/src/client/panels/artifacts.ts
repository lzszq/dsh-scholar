import type { ArtifactRow } from '../types'
import { api, authHeaders, base, overlayRoot } from '../api'
import { artifactContentPath, artifactDownloadName } from '../artifact-transfer'
import { artifactListPage } from '../artifact-list-model'
import { analysisSummary, type AnalysisSummary } from '../research-links'
import { readResearchArtifact } from '../research-artifact-read'
import {
  artifactPreviewPlan,
  ARTIFACT_TEXT_MAX_BYTES,
  formatJsonPreview,
  parseArtifactMarkdown,
  parseDelimitedPreview,
  readArtifactTextStream,
  type ArtifactTextPreview,
  type ArtifactDownloadReason,
  type ArtifactMarkdownBlock,
} from '../artifact-preview-model'
import { getLocaleRevision, registerOverlayRebuild, t, unregisterOverlayRebuild } from '../i18n/index'
import { copyText, el, fmtBytes, fmtId, openContextMenu, rootHost, showToast, trapFocus } from '../ui'
import { state } from '../state'
/** Artifact list filter (dsh-web search-as-you-type), persisted per render. */
export let artifactsQuery = ''
/** Artifact kind filter (dsh-web filter chips). */
export let artifactsKind = 'all'
let artifactsVisibleLimit = 15
let artifactsProjectId: string | null = null


/** Artifacts multi-select (dsh-web bulk download). */
export let artifactsSelecting = false
export let artifactsSelected = new Set<string>()

let activeArtifactPreview: { projectId: string; close: () => void } | null = null
let activeArtifactDetail: { projectId: string; close: () => void } | null = null
let artifactPreviewRequest: { projectId: string; controller: AbortController } | null = null
let artifactBulkDownload: { projectId: string; controller: AbortController } | null = null

function activeElementIn(root: ShadowRoot): HTMLElement | null {
  return root.activeElement instanceof HTMLElement ? root.activeElement : null
}

/** Close blob-backed preview state when leaving its project or unloading UI. */
export function retainArtifactPreviewForProject(projectId: string | undefined): void {
  if (artifactBulkDownload !== null && artifactBulkDownload.projectId !== projectId) {
    artifactBulkDownload.controller.abort()
    artifactBulkDownload = null
  }
  if (artifactPreviewRequest !== null && artifactPreviewRequest.projectId !== projectId) {
    artifactPreviewRequest.controller.abort()
    artifactPreviewRequest = null
  }
  if (activeArtifactPreview !== null && activeArtifactPreview.projectId !== projectId) {
    activeArtifactPreview.close()
  }
  if (activeArtifactDetail !== null && activeArtifactDetail.projectId !== projectId) {
    activeArtifactDetail.close()
  }
}

export function closeArtifactPreview(): void {
  artifactBulkDownload?.controller.abort()
  artifactBulkDownload = null
  artifactPreviewRequest?.controller.abort()
  artifactPreviewRequest = null
  activeArtifactPreview?.close()
  activeArtifactDetail?.close()
}


export async function renderArtifacts(body: HTMLElement, projectId: string): Promise<void> {
  if (artifactsProjectId !== projectId) {
    artifactsProjectId = projectId
    artifactsVisibleLimit = 15
    artifactsQuery = ''
    artifactsKind = 'all'
  }
  const artifacts = (await api<ArtifactRow[]>(`/v1/projects/${encodeURIComponent(projectId)}/artifacts`)) ?? []
  const labelRow = el('div', 'row')
  labelRow.style.cssText = 'justify-content:space-between;align-items:center'
  labelRow.appendChild(el('div', 'section-label', t('artifacts', 'artifacts.section', { count: String(artifacts.length) })))
  if (artifacts.length > 0) {
    const selBtn = el('button', 'hbtn', artifactsSelecting ? t('artifacts', 'artifacts.selecting') : t('artifacts', 'artifacts.select'))
    selBtn.title = artifactsSelecting ? t('artifacts', 'artifacts.selecting.title') : t('artifacts', 'artifacts.select.title')
    selBtn.setAttribute('aria-pressed', artifactsSelecting ? 'true' : 'false')
    selBtn.style.cssText = 'padding:1px 10px;margin-bottom:2px'
    selBtn.onclick = () => {
      artifactsSelecting = !artifactsSelecting
      artifactsSelected.clear()
      state.rerender()
    }
    labelRow.appendChild(selBtn)
  }
  body.appendChild(labelRow)
  if (artifacts.length === 0) {
    body.appendChild(el('div', 'empty', t('artifacts', 'artifacts.empty')))
    return
  }
  // dsh-web search-as-you-type: filter the artifact list in place. Only
  // the list below is rebuilt, so the input keeps focus while typing.
  const searchInput = document.createElement('input')
  searchInput.type = 'text'
  searchInput.placeholder = t('artifacts', 'artifacts.filterPlaceholder')
  searchInput.setAttribute('aria-label', t('artifacts', 'artifacts.filterPlaceholder'))
  searchInput.value = artifactsQuery
  searchInput.style.cssText = 'flex:1;background:var(--bg-input);color:var(--text);border:1px solid var(--border);border-radius:8px;padding:5px 10px;font:11px/1.4 system-ui,sans-serif;outline:none;margin:2px 0 4px'
  searchInput.onfocus = () => { searchInput.style.borderColor = 'var(--accent)' }
  searchInput.onblur = () => { searchInput.style.borderColor = 'var(--border)' }
  body.appendChild(searchInput)

  // dsh-web filter chips: restrict by artifact kind (kinds present here).
  const kindCounts = new Map<string, number>()
  for (const a of artifacts) {
    const k = a.kind ?? '?'
    kindCounts.set(k, (kindCounts.get(k) ?? 0) + 1)
  }
  const kindChips = el('div')
  kindChips.style.cssText = 'display:flex;gap:4px;margin:2px 0 6px;flex-wrap:wrap'
  const kindDefs: Array<[string, string]> = [['all', t('artifacts', 'artifacts.kindAll', { count: String(artifacts.length) })], ...[...kindCounts.entries()].map(([k, n]) => [k, `${k} (${n})`] as [string, string])]
  const paintKindChips = (): void => {
    for (let i = 0; i < kindDefs.length; i++) {
      const b = kindChips.children[i] as HTMLElement | undefined
      if (b === undefined) continue
      const active = artifactsKind === kindDefs[i]![0]
      b.setAttribute('aria-pressed', active ? 'true' : 'false')
      b.style.cssText = `padding:2px 8px;font-size:10px${active ? ';border-color:var(--accent);color:var(--accent-text);background:var(--accent-soft)' : ''}`
    }
  }
  for (const [key, label] of kindDefs) {
    const chip = el('button', 'hbtn', label)
    chip.onclick = () => {
      artifactsKind = key
      artifactsVisibleLimit = 15
      paintKindChips()
      renderList()
    }
    kindChips.appendChild(chip)
  }
  paintKindChips()
  body.appendChild(kindChips)

  const listEl = el('div')
  body.appendChild(listEl)

  const renderList = (): void => {
    listEl.replaceChildren()
    // Bulk download bar.
    if (artifactsSelecting) {
      const bar = el('div', 'card')
      bar.style.cssText = 'padding:8px 10px;margin:4px 0;display:flex;align-items:center;gap:10px;border-color:var(--accent)'
      const count = el('span', 'mono', t('common', 'common.selected', { count: String(artifactsSelected.size) }))
      count.style.cssText = 'font-size:11px;color:var(--text)'
      const downloadSel = el('button', 'btn approve', t('artifacts', 'artifacts.downloadSelected'))
      downloadSel.disabled = artifactsSelected.size === 0
      downloadSel.onclick = async () => {
        artifactBulkDownload?.controller.abort()
        const controller = new AbortController()
        artifactBulkDownload = { projectId, controller }
        downloadSel.disabled = true
        let downloaded = 0
        // dsh-web names: prefer the artifact kind/name in the file name.
        const metaById = new Map<string, ArtifactRow>()
        for (const a of artifacts) if (a.artifact_id !== undefined) metaById.set(a.artifact_id, a)
        try {
          for (const id of artifactsSelected) {
            if (controller.signal.aborted) return
            const headers = await authHeaders()
            if (controller.signal.aborted) return
            const response = await fetch(`${base()}${artifactContentPath(projectId, id)}`, {
              signal: controller.signal,
              headers: { accept: 'application/octet-stream', ...headers },
            })
            if (!response.ok) continue
            const blob = await response.blob()
            if (controller.signal.aborted) return
            const url = URL.createObjectURL(blob)
            const a = el('a', 'dl', t('common', 'common.action.download'))
            a.href = url
            const meta = metaById.get(id) ?? { artifact_id: id }
            a.download = artifactDownloadName(meta, response.headers.get('content-disposition'))
            document.body.appendChild(a)
            a.click()
            a.remove()
            downloaded += 1
            setTimeout(() => URL.revokeObjectURL(url), 4000)
          }
        } catch {
          if (!controller.signal.aborted) showToast(rootHost(), t('artifacts', 'artifacts.preview.errorDownload'))
        } finally {
          if (artifactBulkDownload?.controller === controller) artifactBulkDownload = null
          if (downloadSel.isConnected) downloadSel.disabled = artifactsSelected.size === 0
        }
        if (controller.signal.aborted || state.projectId !== projectId) return
        showToast(rootHost(), t('artifacts', 'artifacts.downloadedToast', { count: String(downloaded) }))
        artifactsSelecting = false
        artifactsSelected.clear()
        state.rerender()
      }
      const doneSel = el('button', 'hbtn', t('artifacts', 'artifacts.done'))
      doneSel.onclick = () => {
        artifactBulkDownload?.controller.abort()
        artifactBulkDownload = null
        artifactsSelecting = false
        artifactsSelected.clear()
        state.rerender()
      }
      const allBtn = el('button', 'hbtn', t('artifacts', 'artifacts.all'))
      allBtn.title = t('artifacts', 'artifacts.all.title')
      allBtn.onclick = () => {
        for (const a of artifacts) if (a.artifact_id !== undefined) artifactsSelected.add(a.artifact_id)
        renderList()
      }
      bar.append(count, allBtn, downloadSel, doneSel)
      listEl.appendChild(bar)
    }
    const page = artifactListPage(artifacts, artifactsKind, artifactsQuery, artifactsVisibleLimit)
    const filtered = page.rows
    if (page.total > 0) {
      const notice = el('div', 'muted', t('artifacts', 'artifacts.showingMatches', { shown: String(filtered.length), total: String(page.total) }))
      notice.style.cssText = 'font-size:10px;padding:2px;text-align:center'
      listEl.appendChild(notice)
    }
    if (filtered.length === 0) {
      listEl.appendChild(el('div', 'empty', t('artifacts', 'artifacts.noMatch', { query: artifactsQuery.trim(), kind: artifactsKind !== 'all' ? ` (kind: ${artifactsKind})` : '' })))
      return
    }
    for (const artifact of filtered) {
      const row = el('div', 'artifact-row')
      if (artifactsSelecting && artifact.artifact_id !== undefined) {
        const box = el('span', 'ws-check', artifactsSelected.has(artifact.artifact_id) ? '☑' : '☐')
        box.style.cssText += ';cursor:pointer'
        box.onclick = (event) => {
          event.stopPropagation()
          if (artifact.artifact_id === undefined) return
          if (artifactsSelected.has(artifact.artifact_id)) artifactsSelected.delete(artifact.artifact_id)
          else artifactsSelected.add(artifact.artifact_id)
          renderList()
        }
        row.prepend(box)
        if (artifactsSelected.has(artifact.artifact_id)) row.style.outline = '1px solid var(--accent)'
      }
      row.appendChild(el('span', 'artifact-kind', (artifact.kind ?? '?').toUpperCase()))
      // dsh-web metadata: a human-readable name when the artifact has one.
      if (typeof artifact.metadata?.name === 'string' && artifact.metadata.name !== '') {
        const nameChip = el('span', 'artifact-kind', String(artifact.metadata.name).slice(0, 24))
        nameChip.style.cssText += ';color:var(--text-3)'
        row.appendChild(nameChip)
      }
      const name = el('span', 'grow', artifact.file_name || (typeof artifact.metadata?.file_name === 'string' ? artifact.metadata.file_name : '') || fmtId(artifact.artifact_id, 22))
      name.style.cssText = 'overflow-wrap:anywhere;min-width:0'
      name.title = artifact.artifact_id ?? ''
      row.appendChild(name)
      // dsh-web metadata: show the artifact kind detail (e.g. code-snapshot-archive).
      const metaKind = typeof artifact.metadata?.kind === 'string' && artifact.metadata.kind !== artifact.kind ? artifact.metadata.kind : ''
      if (metaKind !== '') {
        const chip = el('span', 'artifact-kind', metaKind.slice(0, 22))
        chip.style.cssText += ';color:var(--text-3)'
        row.appendChild(chip)
      }
      row.appendChild(el('span', 'muted', fmtBytes(artifact.size_bytes)))
      row.title = t('artifacts', 'artifacts.rowTitle')
      row.dataset.artifactId = artifact.artifact_id
      row.tabIndex = 0
      row.setAttribute('role', 'button')
      row.onclick = event => { void previewArtifact(projectId, artifact, event.currentTarget as HTMLElement) }
      row.onkeydown = event => {
        if (event.key !== 'Enter' && event.key !== ' ') return
        event.preventDefault()
        void previewArtifact(projectId, artifact, row)
      }
      // dsh-web context menu: preview / details / copy id.
      row.oncontextmenu = (event) => {
        event.preventDefault()
        event.stopPropagation()
        const root = document.querySelector('#dsh-scholar-ui')?.shadowRoot
        if (root == null || artifact.artifact_id === undefined) return
        const aid = artifact.artifact_id
        openContextMenu(root, event.clientX, event.clientY, [
          { label: t('artifacts', 'artifacts.detail.preview'), onPick: () => { void previewArtifact(projectId, artifact, row) } },
          { label: `⧉ ${t('common', 'common.action.details')}`, onPick: () => openArtifactDetailModal(root, projectId, artifact, row) },
          { label: t('common', 'common.action.copyId'), hint: aid, onPick: () => copyText(aid) },
        ])
      }
      row.ondblclick = (event) => {
        event.stopPropagation()
        const root = document.querySelector('#dsh-scholar-ui')?.shadowRoot
        if (root != null) openArtifactDetailModal(root, projectId, artifact, row)
      }
      listEl.appendChild(row)
    }
    if (page.hasMore) {
      const more = el('button', 'hbtn', t('artifacts', 'artifacts.loadMore', { count: String(page.total - filtered.length) }))
      more.onclick = () => { artifactsVisibleLimit += 15; renderList() }
      listEl.appendChild(more)
    }
  }
  searchInput.oninput = () => { artifactsQuery = searchInput.value; artifactsVisibleLimit = 15; renderList() }
  renderList()
}

/** dsh-web artifact drawer: metadata of one CAS artifact. */
export function openArtifactDetailModal(
  root: ShadowRoot,
  projectId: string,
  artifact: ArtifactRow,
  trigger: HTMLElement | null = activeElementIn(root),
): void {
  activeArtifactDetail?.close()
  const overlay = el('div', 'overlay')
  overlay.dataset.overlayDismiss = 'event'
  let releaseFocus: (() => void) | null = null
  let overlayRegistration: number | null = null
  let closed = false
  const close = (): void => {
    if (closed) return
    closed = true
    if (overlayRegistration !== null) unregisterOverlayRebuild(overlayRegistration)
    overlay.remove()
    releaseFocus?.()
    releaseFocus = null
    if (activeArtifactDetail?.close === close) activeArtifactDetail = null
  }
  activeArtifactDetail = { projectId, close }
  overlay.addEventListener('dsh-overlay-dismiss', close)
  overlay.onclick = (event) => { if (event.target === overlay) close() }
  const modal = el('div', 'modal')
  modal.style.cssText = 'width:540px;max-width:92vw'
  modal.setAttribute('role', 'dialog')
  modal.setAttribute('aria-label', t('artifacts', 'artifacts.detailModal'))
  const header = el('div', 'modal-header', t('artifacts', 'artifacts.detailModal'))
  const closeBtn = el('button', 'hbtn ghost', '×')
  closeBtn.setAttribute('aria-label', t('common', 'common.action.close'))
  closeBtn.onclick = close
  header.appendChild(closeBtn)
  modal.appendChild(header)

  const row = (label: string, value: string): void => {
    const r = el('div', 'row')
    r.style.cssText = 'padding:4px 0;align-items:flex-start'
    const l = el('span', '', label)
    l.style.cssText = 'width:110px;color:var(--text-2);font-size:11.5px;flex-shrink:0'
    const v = el('span', 'mono', value)
    v.style.cssText = 'font-size:11px;color:var(--text);word-break:break-all'
    r.append(l, v)
    modal.appendChild(r)
  }
  const titleRow = el('div', 'row')
  titleRow.style.cssText = 'align-items:center;gap:8px;margin-bottom:8px'
  titleRow.appendChild(el('span', 'artifact-kind', (artifact.kind ?? '?').toUpperCase()))
  titleRow.appendChild(el('span', 'pname', fmtId(artifact.artifact_id ?? '', 30)))
  modal.appendChild(titleRow)

  modal.appendChild(el('div', 'section-label', t('artifacts', 'artifacts.detail.title')))
  row(t('artifacts', 'artifacts.detailArtifact'), String(artifact.artifact_id ?? '—'))
  row(t('artifacts', 'artifacts.detailKind'), String(artifact.kind ?? '—'))
  row(t('artifacts', 'artifacts.detailSize'), fmtBytes(artifact.size_bytes))
  const meta = artifact.metadata
  if (meta !== undefined && Object.keys(meta).length > 0) {
    modal.appendChild(el('div', 'section-label', t('artifacts', 'artifacts.detail.metadata')))
    for (const [k, v] of Object.entries(meta)) {
      row(k, typeof v === 'object' ? JSON.stringify(v) : String(v))
    }
  }
  const previewBtn = el('button', 'hbtn', t('artifacts', 'artifacts.detail.preview'))
  previewBtn.style.cssText = 'margin-top:12px'
  previewBtn.onclick = () => {
    close()
    void previewArtifact(projectId, artifact, trigger)
  }
  modal.appendChild(previewBtn)
  overlay.appendChild(modal)
  root.appendChild(overlay)
  releaseFocus = trapFocus(overlay, trigger)
  overlayRegistration = registerOverlayRebuild(overlay, () => {
    close()
    openArtifactDetailModal(root, projectId, artifact, trigger)
  })
  closeBtn.focus()
}

/** Download link backed by a blob URL (used for non-previewable types). */
export function downloadLink(blob: Blob, name: string, trackedUrls?: string[]): HTMLElement {
  const link = el('a', 'dl', t('common', 'common.action.downloadFile'))
  const url = URL.createObjectURL(blob)
  trackedUrls?.push(url)
  link.href = url
  link.download = name
  return link
}

interface AuthenticatedArtifactDownloadAction {
  element: HTMLElement
  cancel: () => void
}

function authenticatedArtifactDownloadButton(
  projectId: string,
  artifact: ArtifactRow,
  fallbackName: string,
  errorHost: HTMLElement,
): AuthenticatedArtifactDownloadAction {
  const button = el('button', 'hbtn', t('common', 'common.action.downloadFile'))
  let activeController: AbortController | null = null
  button.onclick = async () => {
    activeController?.abort()
    const controller = new AbortController()
    activeController = controller
    button.disabled = true
    let url: string | null = null
    try {
      const artifactId = artifact.artifact_id ?? ''
      const response = await fetch(`${base()}${artifactContentPath(projectId, artifactId)}`, {
        signal: controller.signal,
        headers: { accept: 'application/octet-stream', ...(await authHeaders()) },
      })
      if (!response.ok) throw new Error('artifact_download_failed')
      const blob = await response.blob()
      if (controller.signal.aborted) return
      url = URL.createObjectURL(blob)
      const link = el('a', 'dl', t('common', 'common.action.download'))
      link.href = url
      link.download = artifactDownloadName(artifact, response.headers.get('content-disposition')) || fallbackName
      document.body.appendChild(link)
      link.click()
      link.remove()
    } catch {
      if (controller.signal.aborted) return
      if (errorHost.isConnected && errorHost.querySelector('[data-artifact-download-error]') === null) {
        const alert = artifactPreviewAlert(t('artifacts', 'artifacts.preview.errorDownload'))
        alert.dataset.artifactDownloadError = 'true'
        errorHost.appendChild(alert)
      }
    } finally {
      const revokeUrl = url
      if (revokeUrl !== null) window.setTimeout(() => URL.revokeObjectURL(revokeUrl), 4_000)
      if (activeController === controller) activeController = null
      if (button.isConnected) button.disabled = false
    }
  }
  return {
    element: button,
    cancel: () => {
      activeController?.abort()
      activeController = null
    },
  }
}

function artifactPreviewAlert(message: string): HTMLElement {
  const alert = el('div', 'warn', message)
  alert.setAttribute('role', 'alert')
  alert.setAttribute('aria-live', 'assertive')
  return alert
}

function attachNativePreviewError(target: HTMLElement, host: HTMLElement, unsupported = false): void {
  const alert = artifactPreviewAlert(t('artifacts', 'artifacts.preview.errorDecode'))
  alert.hidden = !unsupported
  target.addEventListener('error', () => { alert.hidden = false }, { once: true })
  host.appendChild(alert)
}

function artifactPreviewMetadata(format: string, mediaType: string, size: number): HTMLElement {
  const meta = el('div', 'card')
  meta.style.cssText = 'padding:8px 10px;margin:8px 0;display:grid;grid-template-columns:max-content minmax(0,1fr);gap:4px 10px'
  const add = (label: string, value: string): void => {
    const key = el('span', 'muted', label)
    const content = el('span', 'mono', value)
    content.style.wordBreak = 'break-all'
    meta.append(key, content)
  }
  add(t('artifacts', 'artifacts.preview.format'), format)
  add(t('artifacts', 'artifacts.preview.mediaType'), mediaType === '' ? 'application/octet-stream' : mediaType)
  add(t('artifacts', 'artifacts.preview.size'), fmtBytes(size))
  return meta
}

function renderArtifactTable(rows: string[][], headers?: string[]): HTMLElement {
  if (rows.length === 0 && (headers === undefined || headers.length === 0)) return el('div', 'empty', t('artifacts', 'artifacts.preview.tableEmpty'))
  const wrap = el('div')
  wrap.style.cssText = 'overflow:auto;max-height:56vh;border:1px solid var(--border);border-radius:8px;margin:8px 0'
  const table = document.createElement('table')
  table.style.cssText = 'border-collapse:collapse;width:max-content;min-width:100%;font:11px/1.45 ui-monospace,monospace'
  const appendRow = (values: string[], heading: boolean): void => {
    const tr = document.createElement('tr')
    for (const value of values) {
      const cell = document.createElement(heading ? 'th' : 'td')
      cell.textContent = value
      cell.style.cssText = `padding:5px 8px;border:1px solid var(--border);text-align:left;white-space:pre-wrap;max-width:360px;overflow-wrap:anywhere${heading ? ';position:sticky;top:0;background:var(--bg-elevated);z-index:1' : ''}`
      tr.appendChild(cell)
    }
    table.appendChild(tr)
  }
  if (headers !== undefined) appendRow(headers, true)
  else if (rows.length > 0) appendRow(rows.shift() ?? [], true)
  for (const row of rows) appendRow(row, false)
  wrap.appendChild(table)
  return wrap
}

function renderArtifactMarkdownBlock(block: ArtifactMarkdownBlock): HTMLElement {
  if (block.kind === 'heading') {
    const heading = document.createElement(`h${block.level}`)
    heading.textContent = block.text
    return heading
  }
  if (block.kind === 'quote') {
    const quote = document.createElement('blockquote')
    quote.textContent = block.text
    quote.style.cssText = 'margin:8px 0;padding:4px 10px;border-left:3px solid var(--accent);color:var(--text-2)'
    return quote
  }
  if (block.kind === 'list') {
    const list = document.createElement(block.ordered ? 'ol' : 'ul')
    for (const item of block.items) {
      const li = document.createElement('li')
      li.textContent = item
      list.appendChild(li)
    }
    return list
  }
  if (block.kind === 'code') {
    const pre = el('pre', 'pre')
    if (block.language !== '') {
      const label = el('div', 'muted', block.language)
      label.style.cssText = 'font-size:10px;margin-bottom:4px'
      pre.appendChild(label)
    }
    const code = document.createElement('code')
    code.textContent = block.text
    pre.appendChild(code)
    return pre
  }
  if (block.kind === 'table') return renderArtifactTable(block.rows.map(row => [...row]), block.headers)
  const paragraph = document.createElement('p')
  paragraph.textContent = block.text
  paragraph.style.cssText = 'white-space:pre-wrap;overflow-wrap:anywhere'
  return paragraph
}

function downloadReasonMessage(reason: ArtifactDownloadReason | undefined): string {
  return t('artifacts', `artifacts.preview.download.${reason ?? 'binary'}`)
}

function showArtifactPreviewFailure(
  root: ShadowRoot,
  projectId: string,
  artifactId: string,
  triggerOverride?: HTMLElement | null,
): void {
  closeArtifactPreview()
  const trigger = triggerOverride === undefined
    ? activeElementIn(root)
    : triggerOverride
  const overlay = el('div', 'overlay')
  overlay.dataset.artifactPreview = 'true'
  let closed = false
  let releaseFocus: (() => void) | null = null
  let overlayRegistration: number | null = null
  const close = (): void => {
    if (closed) return
    closed = true
    if (overlayRegistration !== null) unregisterOverlayRebuild(overlayRegistration)
    overlay.remove()
    releaseFocus?.()
    releaseFocus = null
    if (activeArtifactPreview?.close === close) activeArtifactPreview = null
  }
  activeArtifactPreview = { projectId, close }
  overlay.onclick = event => { if (event.target === overlay) close() }
  const modal = el('div', 'modal')
  modal.setAttribute('role', 'dialog')
  modal.setAttribute('aria-modal', 'true')
  const header = el('div', 'modal-header', `📦 ${fmtId(artifactId, 28)}`)
  const closeBtn = el('button', 'hbtn ghost', '×')
  closeBtn.setAttribute('aria-label', t('artifacts', 'artifacts.preview.close'))
  closeBtn.onclick = close
  header.appendChild(closeBtn)
  modal.append(header, artifactPreviewAlert(t('artifacts', 'artifacts.preview.errorFetch')))
  overlay.appendChild(modal)
  root.appendChild(overlay)
  releaseFocus = trapFocus(overlay, trigger)
  overlayRegistration = registerOverlayRebuild(overlay, () => {
    close()
    showArtifactPreviewFailure(root, projectId, artifactId, trigger)
  })
  closeBtn.focus()
}

/**
 * Fetch an artifact blob through the bridge and show it in a modal.
 * Security (design §15.4): untrusted artifacts are never rendered through
 * HTML-string sinks. PDF/raster/audio/video use authenticated blob URLs;
 * active documents and unknown binaries are download-only; structured text
 * is parsed into allowlisted DOM nodes with bounded input.
 */
export async function previewArtifact(
  projectId: string,
  artifact: ArtifactRow,
  triggerOverride?: HTMLElement | null,
): Promise<void> {
  const artifactId = artifact.artifact_id ?? ''
  if (artifactId === '') return
  const root = overlayRoot ?? (document.querySelector('#dsh-scholar-ui')?.shadowRoot ?? null)
  if (root == null) return
  artifactPreviewRequest?.controller.abort()
  artifactPreviewRequest = null
  activeArtifactPreview?.close()
  const trigger = triggerOverride === undefined
    ? activeElementIn(root)
    : triggerOverride
  const controller = new AbortController()
  artifactPreviewRequest = { projectId, controller }
  const ownedBlobUrls: string[] = []
  const previewLocaleRevision = getLocaleRevision()
  try {
    const response = await fetch(`${base()}${artifactContentPath(projectId, artifactId)}`, {
      signal: controller.signal,
      headers: { accept: 'application/octet-stream', ...(await authHeaders()) },
    })
    if (controller.signal.aborted) return
    if (!response.ok) {
      if (artifactPreviewRequest?.controller === controller) artifactPreviewRequest = null
      showArtifactPreviewFailure(root, projectId, artifactId, trigger)
      return
    }
    const servedContentType = response.headers.get('content-type')
    const plan = artifactPreviewPlan(artifact, servedContentType)
    const rawLength = response.headers.get('content-length')
    const parsedLength = rawLength === null ? Number.NaN : Number.parseInt(rawLength, 10)
    const responseSize = Number.isFinite(parsedLength) && parsedLength >= 0 ? parsedLength : (artifact.size_bytes ?? 0)
    let chartSummary: AnalysisSummary | null = null
    const analysisId = artifact.metadata?.analysis_artifact
    if (artifact.kind === 'chart' && typeof analysisId === 'string' && /^sha256:[a-f0-9]{64}$/.test(analysisId)) {
      chartSummary = analysisSummary(await readResearchArtifact(projectId, analysisId, controller.signal), projectId)
      if (controller.signal.aborted) return
    }
    const deferBody = plan.mode === 'download' || (plan.readsText && responseSize > ARTIFACT_TEXT_MAX_BYTES)
    let blob: Blob | null = null
    let textPreview: ArtifactTextPreview | null = null
    if (deferBody) {
      void response.body?.cancel().catch(() => {})
    } else if (plan.readsText) {
      textPreview = await readArtifactTextStream(response.body, controller.signal)
      if (controller.signal.aborted) return
    } else {
      blob = await response.blob()
      if (controller.signal.aborted) return
    }
    if (getLocaleRevision() !== previewLocaleRevision) return previewArtifact(projectId, artifact, trigger)
    const downloadName = artifactDownloadName(artifact, response.headers.get('content-disposition'))
    const overlay = el('div', 'overlay')
    overlay.dataset.artifactPreview = 'true'
    const blobUrls = ownedBlobUrls
    let openableUrl: string | null = null
    let closed = false
    let releaseFocus: (() => void) | null = null
    let overlayRegistration: number | null = null
    let cancelDeferredDownload = (): void => {}
    const close = (): void => {
      if (closed) return
      closed = true
      if (artifactPreviewRequest?.controller === controller) {
        controller.abort()
        artifactPreviewRequest = null
      }
      if (overlayRegistration !== null) unregisterOverlayRebuild(overlayRegistration)
      cancelDeferredDownload()
      for (const url of blobUrls) URL.revokeObjectURL(url)
      overlay.remove()
      releaseFocus?.()
      releaseFocus = null
      if (activeArtifactPreview?.close === close) activeArtifactPreview = null
    }
    activeArtifactPreview = { projectId, close }
    overlay.onclick = (event) => { if (event.target === overlay) close() }
    const modal = el('div', 'modal')
    modal.setAttribute('role', 'dialog')
    modal.setAttribute('aria-modal', 'true')
    const contentType = plan.mediaType
    const header = el('div', 'modal-header', `📦 ${artifactId.slice(0, 28)}${artifactId.length > 28 ? '…' : ''}`)
    if (contentType !== '') {
      // dsh-web metadata: show the served content type in the header.
      const chip = el('span', 'artifact-kind', contentType.slice(0, 24))
      chip.style.cssText += ';color:var(--text-3);font-size:9px'
      header.appendChild(chip)
    }
    const closeBtn = el('button', 'hbtn ghost', '×')
    closeBtn.setAttribute('aria-label', t('artifacts', 'artifacts.preview.close'))
    closeBtn.onclick = close
    header.appendChild(closeBtn)
    modal.appendChild(header)
    modal.appendChild(artifactPreviewMetadata(plan.format, contentType, blob?.size ?? responseSize))
    if (chartSummary !== null) {
      modal.appendChild(el('div', 'section-label', t('artifacts', 'artifacts.chart.summary', { metric: chartSummary.metric })))
      modal.appendChild(renderArtifactTable([
        [t('artifacts', 'artifacts.chart.baseline'), String(chartSummary.baseline)],
        [t('artifacts', 'artifacts.chart.candidate'), String(chartSummary.candidate)],
        [t('artifacts', 'artifacts.chart.effect'), String(chartSummary.effect)],
        [t('artifacts', 'artifacts.chart.interval'), `[${chartSummary.low}, ${chartSummary.high}]`],
        [t('artifacts', 'artifacts.chart.seeds'), String(chartSummary.n)],
      ]))
      const source = el('button', 'hbtn', t('artifacts', 'artifacts.chart.source'))
      source.onclick = () => { close(); void openResearchArtifact(projectId, String(analysisId)) }
      modal.appendChild(source)
    }

    if (plan.mode === 'download' || (plan.readsText && (deferBody || textPreview?.tooLarge === true))) {
      if (chartSummary === null) modal.appendChild(artifactPreviewAlert(
        plan.mode === 'download'
          ? downloadReasonMessage(plan.downloadReason)
          : t('artifacts', 'artifacts.preview.tooLarge'),
      ))
      const download = authenticatedArtifactDownloadButton(projectId, artifact, downloadName, modal)
      cancelDeferredDownload = download.cancel
      modal.appendChild(download.element)
    } else if (blob !== null && plan.mode === 'image') {
      const url = URL.createObjectURL(blob)
      blobUrls.push(url)
      openableUrl = url
      const img = document.createElement('img')
      img.src = url
      img.alt = artifactId
      img.style.cssText = 'display:block;max-width:100%;max-height:60vh;margin:0 auto;object-fit:contain'
      modal.appendChild(img)
      attachNativePreviewError(img, modal)
      modal.appendChild(downloadLink(blob, downloadName, blobUrls))
    } else if (blob !== null && plan.mode === 'pdf') {
      const pdfBlob = blob.type === 'application/pdf' ? blob : blob.slice(0, blob.size, 'application/pdf')
      const url = URL.createObjectURL(pdfBlob)
      blobUrls.push(url)
      openableUrl = url
      const frame = document.createElement('iframe')
      frame.src = url
      frame.title = t('artifacts', 'artifacts.preview.pdfTitle')
      frame.style.cssText = 'width:100%;height:60vh;border:1px solid var(--border);border-radius:8px'
      modal.appendChild(frame)
      attachNativePreviewError(frame, modal)
      modal.appendChild(downloadLink(blob, downloadName, blobUrls))
    } else if (blob !== null && (plan.mode === 'audio' || plan.mode === 'video')) {
      const url = URL.createObjectURL(blob)
      blobUrls.push(url)
      openableUrl = url
      const media = document.createElement(plan.mode)
      media.src = url
      media.controls = true
      media.preload = 'metadata'
      media.style.cssText = plan.mode === 'video' ? 'display:block;width:100%;max-height:60vh;background:#000' : 'display:block;width:100%;margin:12px 0'
      modal.appendChild(media)
      attachNativePreviewError(media, modal, contentType !== '' && media.canPlayType(contentType) === '')
      modal.appendChild(downloadLink(blob, downloadName, blobUrls))
    } else if (textPreview !== null) {
      try {
        const content = textPreview
        if (controller.signal.aborted) return
        if (getLocaleRevision() !== previewLocaleRevision) return previewArtifact(projectId, artifact, trigger)
        if (content.tooLarge) {
          modal.appendChild(artifactPreviewAlert(t('artifacts', 'artifacts.preview.tooLarge')))
        } else if (content.binary) {
          modal.appendChild(artifactPreviewAlert(t('artifacts', 'artifacts.preview.binaryDetected')))
        } else if (plan.mode === 'json') {
          const formatted = formatJsonPreview(content.text, plan.ndjson === true)
          if (!formatted.valid) modal.appendChild(artifactPreviewAlert(t('artifacts', 'artifacts.preview.invalidJson')))
          modal.appendChild(el('pre', 'pre', formatted.text))
          if (content.truncated) modal.appendChild(el('div', 'muted', t('artifacts', 'artifacts.truncated')))
        } else if (plan.mode === 'table') {
          const table = parseDelimitedPreview(content.text, plan.delimiter ?? ',')
          modal.appendChild(renderArtifactTable(table.rows.map(row => [...row])))
          if (content.truncated || table.truncated) modal.appendChild(el('div', 'muted', t('artifacts', 'artifacts.truncated')))
        } else if (plan.mode === 'markdown') {
          const markdown = parseArtifactMarkdown(content.text)
          const preview = el('div', 'card')
          preview.style.cssText = 'padding:12px;max-height:60vh;overflow:auto'
          for (const block of markdown.blocks) preview.appendChild(renderArtifactMarkdownBlock(block))
          modal.appendChild(preview)
          if (content.truncated || markdown.truncated) modal.appendChild(el('div', 'muted', t('artifacts', 'artifacts.truncated')))
        } else {
          modal.appendChild(el('pre', 'pre', content.text))
          if (content.truncated) modal.appendChild(el('div', 'muted', t('artifacts', 'artifacts.truncated')))
        }
      } catch {
        if (controller.signal.aborted) return
        modal.appendChild(artifactPreviewAlert(t('artifacts', 'artifacts.preview.errorRead')))
      }
      if (controller.signal.aborted) return
      const download = authenticatedArtifactDownloadButton(projectId, artifact, downloadName, modal)
      cancelDeferredDownload = download.cancel
      modal.appendChild(download.element)
    } else {
      modal.appendChild(artifactPreviewAlert(t('artifacts', 'artifacts.preview.errorRead')))
    }
    // dsh-web depth: open blob-backed previews in their own browser tab.
    const previewUrl = openableUrl
    if (previewUrl !== null) {
      const openTab = el('button', 'hbtn', t('artifacts', 'artifacts.detail.openTab'))
      openTab.title = t('artifacts', 'artifacts.detail.openTab.title')
      openTab.style.cssText = 'margin-top:10px'
      openTab.onclick = () => {
        window.open(previewUrl, '_blank', 'noopener,noreferrer')
      }
      modal.appendChild(openTab)
    }
    overlay.appendChild(modal)
    root.appendChild(overlay)
    releaseFocus = trapFocus(overlay, trigger)
    overlayRegistration = registerOverlayRebuild(overlay, () => {
      close()
      void previewArtifact(projectId, artifact, trigger)
    })
    closeBtn.focus()
    if (artifactPreviewRequest?.controller === controller) artifactPreviewRequest = null
  } catch {
    if (controller.signal.aborted) return
    if (artifactPreviewRequest?.controller === controller) artifactPreviewRequest = null
    for (const url of ownedBlobUrls) URL.revokeObjectURL(url)
    showArtifactPreviewFailure(root, projectId, artifactId, trigger)
  }
}

/** Resolve metadata before previewing so scoped links retain media safety rules. */
export async function openResearchArtifact(projectId: string, artifactId: string): Promise<void> {
  const artifacts = await api<ArtifactRow[]>(`/v1/projects/${encodeURIComponent(projectId)}/artifacts`)
  if (state.projectId !== projectId) return
  const artifact = artifacts?.find(candidate => candidate.artifact_id === artifactId)
  if (artifact === undefined) {
    showToast(rootHost(), t('artifacts', 'artifacts.referenceUnavailable'))
    return
  }
  await previewArtifact(projectId, artifact)
}
