import type { ArtifactRow, ClaimRow, EvidenceRow } from '../types'
import { api } from '../api'
import { t } from '../i18n/index'
import { copyText, el, fmtId, openContextMenu, pill, trapFocus } from '../ui'
import { state, tabSave } from '../state'
import { analysisRunReferences, resolveResearchRun, type ResearchJobLink } from '../research-links'
import { readResearchArtifact } from '../research-artifact-read'
import { openJobDetailModal } from './runs'
import { openResearchArtifact } from './artifacts'
/** Claims & evidence filter on the Evidence tab (dsh-web search-as-you-type). */
export let evidenceQuery = ''


export async function renderEvidence(body: HTMLElement, projectId: string): Promise<void> {
  const claims = (await api<ClaimRow[]>(`/v1/projects/${encodeURIComponent(projectId)}/claims`)) ?? []
  const evidence = (await api<EvidenceRow[]>(`/v1/projects/${encodeURIComponent(projectId)}/evidence`)) ?? []
  // dsh-web search-as-you-type: filters both sections in place; only the
  // list container is rebuilt so the input keeps focus.
  const searchInput = document.createElement('input')
  searchInput.type = 'text'
  searchInput.placeholder = t('evidence', 'evidence.filterPlaceholder')
  searchInput.setAttribute('aria-label', searchInput.placeholder)
  searchInput.value = evidenceQuery
  searchInput.style.cssText = 'flex:1;background:var(--bg-input);color:var(--text);border:1px solid var(--border);border-radius:8px;padding:5px 10px;font:11px/1.4 system-ui,sans-serif;outline:none;margin:2px 0 6px'
  searchInput.onfocus = () => { searchInput.style.borderColor = 'var(--accent)' }
  searchInput.onblur = () => { searchInput.style.borderColor = 'var(--border)' }
  body.appendChild(searchInput)
  const listEl = el('div')
  body.appendChild(listEl)
  const renderList = (): void => {
    listEl.replaceChildren()
    const q = evidenceQuery.trim().toLowerCase()
    const cq = q === '' ? claims : claims.filter(c =>
      (c.statement ?? '').toLowerCase().includes(q) ||
      (c.claim_id ?? '').toLowerCase().includes(q) ||
      (c.status ?? '').toLowerCase().includes(q) ||
      (c.confidence ?? '').toLowerCase().includes(q),
    )
    const eq = q === '' ? evidence : evidence.filter(e =>
      (e.result?.primary_metric ?? '').toLowerCase().includes(q) ||
      String(e.result?.value ?? '').includes(q) ||
      (e.evidence_id ?? '').toLowerCase().includes(q) ||
      (e.analysis_method ?? '').toLowerCase().includes(q) ||
      (Array.isArray(e.run_ids) ? e.run_ids.join(' ') : '').toLowerCase().includes(q),
    )
    listEl.appendChild(el('div', 'section-label', t('evidence', 'evidence.claims', { count: String(cq.length) })))
    if (cq.length === 0) {
      listEl.appendChild(el('div', 'empty', q === '' ? t('evidence', 'evidence.claims.empty') : t('evidence', 'evidence.claims.noMatch', { query: evidenceQuery.trim() })))
    }
    if (cq.length > 8) {
      const notice = el('div', 'muted', t('evidence', 'evidence.showingNewestClaims', { count: String(cq.length) }))
      notice.style.cssText = 'font-size:10px;padding:2px;text-align:center'
      listEl.appendChild(notice)
    }
    for (const claim of cq.slice(-8).reverse()) {
      const card = el('div', 'evidence-card')
      const top = el('div', 'row')
      top.appendChild(pill(claim.status))
      const conf = el('span', 'muted', claim.confidence !== undefined && claim.confidence !== '' ? claim.confidence : '')
      top.appendChild(conf)
      top.appendChild(el('span', 'grow'))
      // dsh-web drawer: one-click claim details (double-click too).
      const claimBtn = el('button', 'hbtn', '⧉')
      claimBtn.title = t('evidence', 'evidence.claimDetails')
      claimBtn.setAttribute('aria-label', claimBtn.title)
      claimBtn.style.cssText = 'padding:0 6px;font-size:9px;flex-shrink:0'
      claimBtn.onclick = (event) => {
        event.stopPropagation()
        const root = document.querySelector('#dsh-scholar-ui')?.shadowRoot
        if (root != null) openClaimDetailModal(root, claim)
      }
      top.appendChild(claimBtn)
      card.appendChild(top)
      card.title = t('evidence', 'evidence.claimRowTitle')
      card.ondblclick = (event) => {
        event.stopPropagation()
        const root = document.querySelector('#dsh-scholar-ui')?.shadowRoot
        if (root != null) openClaimDetailModal(root, claim)
      }
      // dsh-web context menu: details / copy id.
      card.oncontextmenu = (event) => {
        event.preventDefault()
        event.stopPropagation()
        const root = document.querySelector('#dsh-scholar-ui')?.shadowRoot
        if (root == null || claim.claim_id === undefined) return
        const cid = claim.claim_id
        openContextMenu(root, event.clientX, event.clientY, [
          { label: `⧉ ${t('common', 'common.action.details')}`, onPick: () => openClaimDetailModal(root, claim) },
          { label: t('evidence', 'evidence.copyClaimId'), hint: cid, onPick: () => copyText(cid) },
        ])
      }
      const stmt = el('div', 'grow', claim.statement ?? '')
      stmt.style.cssText = 'margin-top:5px;color:var(--text);font-size:11.5px'
      card.appendChild(stmt)
      const id = el('div', 'muted mono', fmtId(claim.claim_id))
      id.style.cssText = 'margin-top:4px;font-size:10px'
      card.appendChild(id)
      listEl.appendChild(card)
    }
    listEl.appendChild(el('div', 'section-label', t('evidence', 'evidence.evidence', { count: String(eq.length) })))
    if (eq.length === 0) {
      listEl.appendChild(el('div', 'empty', q === '' ? t('evidence', 'evidence.evidence.empty') : t('evidence', 'evidence.evidence.noMatch', { query: evidenceQuery.trim() })))
    }
    if (eq.length > 8) {
      const notice = el('div', 'muted', t('evidence', 'evidence.showingNewestEvidence', { count: String(eq.length) }))
      notice.style.cssText = 'font-size:10px;padding:2px;text-align:center'
      listEl.appendChild(notice)
    }
    for (const item of eq.slice(-8).reverse()) {
      const r = item.result
      const card = el('div', 'card')
      const row = el('div', 'row')
      const metric = el('span', 'evidence-metric', `${r?.primary_metric ?? '?'} = ${r?.value ?? '?'}`)
      row.appendChild(metric)
      const delta = el('span', 'evidence-delta')
      const effect = r?.effect_size
      if (effect !== undefined) {
        delta.textContent = `Δ${effect >= 0 ? '+' : ''}${effect}`
        delta.style.color = effect > 0 ? 'var(--tone-green)' : effect < 0 ? 'var(--tone-red)' : 'var(--tone-slate)'
      }
      row.appendChild(delta)
      row.appendChild(el('span', 'grow'))
      // gui-plugin-plan.md §10: provenance_status is displayed as-is (raw
      // wire value per the i18n rule "unknown enums render verbatim") —
      // never a hardcoded 'verified' pill. Accepted evidence gets green.
      const provenance = item.provenance_status ?? 'unknown'
      const badge = pill(provenance)
      badge.style.color = provenance === 'accepted' ? 'var(--tone-green)'
        : provenance === 'verified' ? 'var(--tone-blue)'
          : 'var(--tone-slate)'
      row.appendChild(badge)
      // dsh-web drawer: one-click evidence details (double-click still works).
      const detailsBtn = el('button', 'hbtn', '⧉')
      detailsBtn.title = t('evidence', 'evidence.evidenceDetails')
      detailsBtn.setAttribute('aria-label', detailsBtn.title)
      detailsBtn.style.cssText = 'padding:0 6px;font-size:9px;flex-shrink:0'
      detailsBtn.onclick = (event) => {
        event.stopPropagation()
        const root = document.querySelector('#dsh-scholar-ui')?.shadowRoot
        if (root != null) openEvidenceDetailModal(root, item)
      }
      row.appendChild(detailsBtn)
      card.appendChild(row)
      if (r?.baseline_value !== undefined) {
        card.appendChild(el('div', 'muted', t('evidence', 'evidence.comparison', { baseline: String(r.baseline_value), candidate: String(r.value ?? '—') })))
      }
      const refsCount = Array.isArray(item.artifact_refs) ? item.artifact_refs.length : 0
      const runsCount = Array.isArray(item.run_ids) ? item.run_ids.length : 0
      const meta = el('div', 'muted', t('evidence', 'evidence.ciLine', { lo: String(r?.ci_low ?? '?'), hi: String(r?.ci_high ?? '?'), n: String(r?.n_seeds ?? '?'), method: item.analysis_method ?? '?', runs: String(runsCount), refs: String(refsCount) }))
      meta.style.cssText = 'margin-top:4px'
      card.appendChild(meta)
      // dsh-web analysis depth: an effect-size bar (0-centred) per evidence.
      if (r?.effect_size !== undefined && r.ci_low !== undefined && r.ci_high !== undefined) {
        const bar = el('div')
        bar.style.cssText = 'position:relative;height:14px;margin-top:6px;background:var(--bg-3);border:1px solid var(--border);border-radius:6px;overflow:hidden'
        const lo = r.ci_low
        const hi = r.ci_high
        const eff = r.effect_size
        const span = Math.max(Math.abs(hi - lo), 0.0001)
        const zeroX = (0 - lo) / span * 100
        const effX = (eff - lo) / span * 100
        const width = Math.abs(effX - zeroX)
        const fill = el('div')
        fill.style.cssText = `position:absolute;top:0;bottom:0;left:${Math.min(zeroX, effX)}%;width:${width}%;background:${eff >= 0 ? 'var(--tone-green)' : 'var(--tone-red)'}`
        bar.appendChild(fill)
        const zero = el('div')
        zero.style.cssText = `position:absolute;top:0;bottom:0;left:${zeroX}%;width:1px;background:var(--text-3)`
        bar.appendChild(zero)
        const label = el('div', 'muted', t('evidence', 'evidence.effectLine', { eff: `${eff >= 0 ? '+' : ''}${eff}` }))
        label.style.cssText = 'font-size:9px;margin-top:2px;color:var(--text-3)'
        card.appendChild(bar)
        card.appendChild(label)
      }
      const id = el('div', 'muted mono', fmtId(item.evidence_id))
      id.style.cssText = 'margin-top:3px;font-size:10px'
      card.appendChild(id)
      card.title = t('evidence', 'evidence.evidenceRowTitle')
      card.ondblclick = (event) => {
        event.stopPropagation()
        const root = document.querySelector('#dsh-scholar-ui')?.shadowRoot
        if (root != null) openEvidenceDetailModal(root, item)
      }
      // dsh-web context menu: details / copy id.
      card.oncontextmenu = (event) => {
        event.preventDefault()
        event.stopPropagation()
        const root = document.querySelector('#dsh-scholar-ui')?.shadowRoot
        if (root == null || item.evidence_id === undefined) return
        const eid = item.evidence_id
        openContextMenu(root, event.clientX, event.clientY, [
          { label: `⧉ ${t('common', 'common.action.details')}`, onPick: () => openEvidenceDetailModal(root, item) },
          { label: t('common', 'common.action.copyId'), hint: eid, onPick: () => copyText(eid) },
        ])
      }
      listEl.appendChild(card)
    }
  }
  searchInput.oninput = () => { evidenceQuery = searchInput.value; renderList() }
  renderList()
}

/** dsh-web claim drawer: statement, scope, evidence links and history. */
export function openClaimDetailModal(root: ShadowRoot, claim: ClaimRow, projectId = state.projectId): void {
  const overlay = el('div', 'overlay')
  overlay.onclick = (event) => { if (event.target === overlay) overlay.remove() }
  const modal = el('div', 'modal')
  modal.style.cssText = 'width:540px;max-width:92vw'
  modal.setAttribute('role', 'dialog')
  modal.setAttribute('aria-label', t('evidence', 'evidence.claimDetails'))
  const header = el('div', 'modal-header', `🧾 ${t('evidence', 'evidence.claimDetails')}`)
  const closeBtn = el('button', 'hbtn ghost', '×')
  closeBtn.setAttribute('aria-label', t('common', 'common.action.close'))
  closeBtn.onclick = () => overlay.remove()
  header.appendChild(closeBtn)
  modal.appendChild(header)

  const row = (label: string, value: string): void => {
    const r = el('div', 'row')
    r.style.cssText = 'padding:4px 0;align-items:flex-start'
    const l = el('span', '', label)
    l.style.cssText = 'width:110px;color:var(--text-2);font-size:11.5px;flex-shrink:0'
    const v = el('span', 'mono', value)
    v.style.cssText = 'font-size:11px;color:var(--text);word-break:break-word'
    r.append(l, v)
    modal.appendChild(r)
  }
  const titleRow = el('div', 'row')
  titleRow.style.cssText = 'align-items:center;gap:8px;margin-bottom:8px'
  titleRow.appendChild(el('span', 'artifact-kind', (claim.status ?? '?').toUpperCase()))
  titleRow.appendChild(el('span', 'pname', fmtId(claim.claim_id ?? '', 30)))
  modal.appendChild(titleRow)

  const stmt = el('div', 'grow', claim.statement ?? '')
  stmt.style.cssText = 'font-size:12px;color:var(--text);line-height:1.55;margin-bottom:8px'
  modal.appendChild(stmt)

  modal.appendChild(el('div', 'section-label', t('evidence', 'evidence.claim.title')))
  row(t('evidence', 'evidence.detailClaim'), String(claim.claim_id ?? '—'))
  row(t('evidence', 'evidence.detailStatus'), String(claim.status ?? '—'))
  row(t('evidence', 'evidence.detailConfidence'), String(claim.confidence ?? '—'))
  const scope = claim.scope
  if (scope !== undefined) {
    row(t('evidence', 'evidence.detailDataset'), String(scope.dataset ?? '—'))
    row(t('evidence', 'evidence.detailSplit'), String(scope.split ?? '—'))
  }
  const ev = claim.evidence
  if (ev !== undefined && (ev.evidence_ids ?? []).length > 0) {
    modal.appendChild(el('div', 'section-label', t('evidence', 'evidence.claim.supporting')))
    for (const id of ev.evidence_ids ?? []) {
      const link = el('button', 'hbtn', `${t('evidence', 'evidence.detailEvidence')} · ${fmtId(id, 28)}`)
      link.onclick = async () => {
        if (projectId === undefined) return
        const evidence = await api<EvidenceRow[]>(`/v1/projects/${encodeURIComponent(projectId)}/evidence`)
        if (state.projectId !== projectId || !overlay.isConnected) return
        const item = evidence?.find(candidate => candidate.evidence_id === id)
        if (item !== undefined) { overlay.remove(); openEvidenceDetailModal(root, item, projectId) }
        else link.textContent = t('evidence', 'evidence.referenceUnavailable')
      }
      modal.appendChild(link)
    }
    if (typeof ev.analysis_artifact === 'string' && ev.analysis_artifact !== '' && projectId !== undefined) {
      const link = el('button', 'hbtn', t('evidence', 'evidence.detailAnalysisArtifact'))
      link.onclick = () => { overlay.remove(); void openResearchArtifact(projectId, ev.analysis_artifact!) }
      modal.appendChild(link)
    }
  }
  const limitations = claim.limitations ?? []
  if (limitations.length > 0) {
    modal.appendChild(el('div', 'section-label', t('evidence', 'evidence.claim.limitations')))
    for (const l of limitations) modal.appendChild(el('div', 'muted', `· ${l}`))
  }
  const history = claim.history ?? []
  if (history.length > 0) {
    modal.appendChild(el('div', 'section-label', t('evidence', 'evidence.claim.history')))
    for (const h of history) {
      const hrow = el('div', 'row')
      hrow.style.cssText = 'padding:2px 0;align-items:flex-start'
      hrow.appendChild(el('span', 'artifact-kind', String(h.status ?? '?')))
      const when = String(h.at ?? '').replace('T', ' ').slice(0, 16)
      const meta = el('div', 'grow muted', [when, h.reason].filter(Boolean).join(' — '))
      hrow.appendChild(meta)
      modal.appendChild(hrow)
    }
  }
  overlay.appendChild(modal)
  root.appendChild(overlay)
  trapFocus(overlay, null)
}

/** dsh-web evidence drawer: provenance + result of one evidence item. */
export function openEvidenceDetailModal(root: ShadowRoot, item: EvidenceRow, projectId = state.projectId): void {
  const overlay = el('div', 'overlay')
  overlay.onclick = (event) => { if (event.target === overlay) overlay.remove() }
  const modal = el('div', 'modal')
  modal.style.cssText = 'width:540px;max-width:92vw'
  modal.setAttribute('role', 'dialog')
  modal.setAttribute('aria-label', t('evidence', 'evidence.evidenceDetails'))
  const header = el('div', 'modal-header', t('evidence', 'evidence.detailsModal'))
  const closeBtn = el('button', 'hbtn ghost', '×')
  closeBtn.setAttribute('aria-label', t('common', 'common.action.close'))
  closeBtn.onclick = () => overlay.remove()
  header.appendChild(closeBtn)
  modal.appendChild(header)

  const row = (label: string, value: string): void => {
    const r = el('div', 'row')
    r.style.cssText = 'padding:4px 0;align-items:flex-start'
    const l = el('span', '', label)
    l.style.cssText = 'width:110px;color:var(--text-2);font-size:11.5px;flex-shrink:0'
    const v = el('span', 'mono', value)
    v.style.cssText = 'font-size:11px;color:var(--text);word-break:break-word'
    r.append(l, v)
    modal.appendChild(r)
  }
  const r = item.result
  modal.appendChild(el('div', 'section-label', t('evidence', 'evidence.detail.result')))
  row(t('evidence', 'evidence.detailMetric'), r?.primary_metric ?? '—')
  row(t('evidence', 'evidence.detailValue'), String(r?.value ?? '—'))
  if (r?.baseline_value !== undefined) row(t('artifacts', 'artifacts.chart.baseline'), String(r.baseline_value))
  row(t('evidence', 'evidence.detailEffect'), r?.effect_size !== undefined ? `Δ${r.effect_size >= 0 ? '+' : ''}${r.effect_size}` : '—')
  row(t('evidence', 'evidence.detailCi'), `[${r?.ci_low ?? '—'}, ${r?.ci_high ?? '—'}]`)
  row(t('evidence', 'evidence.detailNSeeds'), String(r?.n_seeds ?? '—'))
  modal.appendChild(el('div', 'section-label', t('evidence', 'evidence.detail.provenance')))
  row(t('evidence', 'evidence.detailEvidence'), String(item.evidence_id ?? '—'))
  row(t('evidence', 'evidence.detailMethod'), item.analysis_method ?? '—')
  if (projectId !== undefined) {
    const links = el('div', 'row')
    links.style.cssText = 'gap:8px;flex-wrap:wrap;margin-top:10px'
    const provenance = Promise.all([
      api<ResearchJobLink[]>(`/v1/projects/${encodeURIComponent(projectId)}/jobs`),
      api<ArtifactRow[]>(`/v1/projects/${encodeURIComponent(projectId)}/artifacts`),
    ])
    const included = el('div')
    included.style.cssText = 'width:100%;display:flex;gap:8px;flex-wrap:wrap'
    links.appendChild(included)
    void provenance.then(async ([jobs, artifacts]) => {
      if (jobs === null || artifacts === null || state.projectId !== projectId || !overlay.isConnected) return
      const analysisIds = (item.artifact_refs ?? []).filter(id => artifacts.some(artifact => artifact.artifact_id === id && artifact.kind === 'analysis'))
      const results = await Promise.all(analysisIds.slice(0, 8).map(id => readResearchArtifact(projectId, id)))
      if (state.projectId !== projectId || !overlay.isConnected) return
      const refs = new Map(results.flatMap(result => analysisRunReferences(result, projectId)).map(ref => [ref.runId, ref]))
      if (refs.size > 0) included.appendChild(el('div', 'section-label', t('evidence', 'evidence.includedRuns')))
      for (const ref of refs.values()) {
        if (!jobs.some(job => job.job_id === ref.jobId)) continue
        const link = el('button', 'hbtn', t('evidence', 'evidence.includedRun', { seed: ref.seed === null ? '—' : String(ref.seed), run: fmtId(ref.runId, 22) }))
        link.title = `${ref.runId} · ${ref.jobId}`
        link.onclick = () => { overlay.remove(); void openJobDetailModal(root, ref.jobId, projectId) }
        included.appendChild(link)
      }
    })
    for (const artifact of item.artifact_refs ?? []) {
      const link = el('button', 'hbtn', `${t('evidence', 'evidence.detailArtifacts')} · ${fmtId(artifact, 22)}`)
      link.title = artifact
      link.onclick = () => { overlay.remove(); void openResearchArtifact(projectId, artifact) }
      links.appendChild(link)
    }
    for (const reference of item.run_ids ?? []) {
      const link = el('button', 'hbtn', `${t('evidence', 'evidence.detailRun')} · ${reference}`)
      link.style.cssText = 'white-space:normal;overflow-wrap:anywhere;text-align:left'
      link.onclick = async () => {
        link.disabled = true
        const [jobs, artifacts] = await provenance
        if (state.projectId !== projectId || !overlay.isConnected) return
        link.disabled = false
        const jobId = resolveResearchRun(reference, jobs ?? [], artifacts ?? [])
        if (jobId !== null) { overlay.remove(); void openJobDetailModal(root, jobId, projectId); return }
        const notice = el('div', 'card', t('evidence', jobs === null || artifacts === null ? 'evidence.referenceUnavailable' : 'evidence.runUnresolved', { reference }))
        const runs = el('button', 'hbtn', t('runs', 'runs.openRunsTab'))
        runs.onclick = () => { overlay.remove(); state.activeTab = 'runs'; tabSave(); state.rerender() }
        notice.appendChild(runs)
        links.appendChild(notice)
      }
      links.appendChild(link)
    }
    modal.appendChild(links)
  }
  overlay.appendChild(modal)
  root.appendChild(overlay)
  trapFocus(overlay, null)
}

/** dsh-web budget drawer: constraints/execution/integrity of a project. */
