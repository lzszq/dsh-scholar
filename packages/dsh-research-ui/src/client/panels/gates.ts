import type { ContextMenuItem, GateRow, Projection } from '../types'
import type { CompactMethodologyProjection } from '../methodology-projection'
import { renderReleaseReview } from './release-review'
import { api, apiResult, type ApiResult } from '../api'
import { gateDecisionErrorKey, gateDecisionRequest } from '../gate-decision'
import { gateDrafts } from '../gate-drafts'
import { t } from '../i18n/index'
import { state } from '../state'
import { copyText, el, fmtId, openContextMenu, pill, rootHost, shortType, showToast } from '../ui'
/** Gates multi-select (dsh-web bulk decisions). */
export let gatesSelecting = false
export let gatesSelected = new Set<string>()
const gateSubmissions = new Set<string>()
let gatesProjectId: string | null = null
export function gateMutationPending(): boolean { return gateSubmissions.size > 0 }

/** Gates filter (dsh-web search-as-you-type), persisted per render. */
export let gatesQuery = ''
/** Decided-gates section folded by default on busy projects. */
export let gatesDecidedOpen = true

function gateDecisionErrorText(error: Extract<ApiResult<unknown>, { ok: false }>['error'], status: number): string {
  return t('overview', gateDecisionErrorKey(error, status), { code: error.code ?? `HTTP ${status}` })
}

async function submitGateDecision(
  gateId: string,
  decision: 'approved' | 'rejected' | 'revised',
  reason?: string,
): Promise<ApiResult<Record<string, unknown>>> {
  if (gateSubmissions.has(gateId)) return { ok: false, status: 409, error: { code: 'gate_decision_pending' } }
  gateSubmissions.add(gateId)
  const request = gateDecisionRequest(gateId, decision, reason)
  try { return await apiResult<Record<string, unknown>>(request.path, request.init) }
  finally { gateSubmissions.delete(gateId) }
}


export async function renderGates(body: HTMLElement, projectId: string, projection: Projection = {}, methodology?: CompactMethodologyProjection | null): Promise<void> {
  if (gatesProjectId !== projectId) {
    gatesProjectId = projectId; gatesQuery = ''; gatesSelecting = false; gatesSelected.clear()
  }
  const gates = (await api<GateRow[]>(`/v1/projects/${encodeURIComponent(projectId)}/gates`)) ?? []
  // dsh-web decision provenance: who decided each gate, when, and why.
  const decisions = (await api<Array<Record<string, unknown>>>(`/v1/projects/${encodeURIComponent(projectId)}/decisions`)) ?? []
  const pending = gates.filter(g => g.status === 'pending')
  const decided = gates.filter(g => g.status !== 'pending')
  if (pending.some(gate => gate.type?.toLowerCase().includes('release'))) await renderReleaseReview(body, projectId, projection, methodology)
  // dsh-web search-as-you-type: filters both sections; only the list
  // container is rebuilt so the input keeps focus.
  const searchInput = document.createElement('input')
  searchInput.type = 'text'
  searchInput.placeholder = t('overview', 'overview.gatesFilterPlaceholder')
  searchInput.setAttribute('aria-label', t('overview', 'overview.gatesFilterPlaceholder'))
  searchInput.value = gatesQuery
  searchInput.style.cssText = 'flex:1;background:var(--bg-input);color:var(--text);border:1px solid var(--border);border-radius:8px;padding:5px 10px;font:11px/1.4 system-ui,sans-serif;outline:none;margin:2px 0 6px'
  searchInput.onfocus = () => { searchInput.style.borderColor = 'var(--accent)' }
  searchInput.onblur = () => { searchInput.style.borderColor = 'var(--border)' }
  body.appendChild(searchInput)
  const listEl = el('div')
  body.appendChild(listEl)

  const renderList = (): void => {
    listEl.replaceChildren()
    const q = gatesQuery.trim().toLowerCase()
    const matches = (g: GateRow): boolean =>
      q === '' ||
      (g.type ?? '').toLowerCase().includes(q) ||
      (g.title ?? '').toLowerCase().includes(q) ||
      (g.status ?? '').toLowerCase().includes(q) ||
      (g.summary ?? '').toLowerCase().includes(q) ||
      (g.gate_id ?? '').toLowerCase().includes(q)
    const pFiltered = pending.filter(matches)
    const dFiltered = decided.filter(matches)
    const labelRow = el('div', 'row')
    labelRow.style.cssText = 'justify-content:space-between;align-items:center'
    labelRow.appendChild(el('div', 'section-label', t('overview', 'overview.awaiting', { count: String(pFiltered.length) })))
    if (pFiltered.length > 0) {
      const selBtn = el('button', 'hbtn', gatesSelecting ? `☑ ${t('common', 'common.action.selecting')}` : `☑ ${t('common', 'common.action.select')}`)
      selBtn.title = gatesSelecting ? t('artifacts', 'artifacts.selecting.title') : t('overview', 'overview.gatesSelectTitle')
      selBtn.setAttribute('aria-pressed', gatesSelecting ? 'true' : 'false')
      selBtn.style.cssText = 'padding:1px 10px;margin-bottom:2px'
      selBtn.onclick = () => {
        gatesSelecting = !gatesSelecting
        gatesSelected.clear()
        state.rerender()
      }
      labelRow.appendChild(selBtn)
    }
    listEl.appendChild(labelRow)
    if (pFiltered.length === 0) {
      listEl.appendChild(el('div', 'empty', q === ''
        ? t('overview', 'overview.gatesNoPending')
        : t('overview', 'overview.gatesNoMatch', { query: gatesQuery.trim() })))
    }
  // Bulk decide bar.
  if (gatesSelecting && pending.length > 0) {
    const bar = el('div', 'card border-amber')
    bar.style.cssText = 'padding:8px 10px;margin:4px 0;display:flex;align-items:center;gap:10px'
    const count = el('span', 'mono', t('common', 'common.selected', { count: String(gatesSelected.size) }))
    count.style.cssText = 'font-size:11px;color:var(--text)'
    const approveSel = el('button', 'btn approve', t('overview', 'overview.gatesApproveSelected'))
    approveSel.disabled = gatesSelected.size === 0
    approveSel.onclick = async () => {
      approveSel.disabled = rejectSel.disabled = true
      let firstFailure: Extract<ApiResult<Record<string, unknown>>, { ok: false }> | null = null
      for (const id of [...gatesSelected]) {
        const result = await submitGateDecision(id, 'approved', gateDrafts.get(projectId, id).reason.trim() || 'bulk approved from dsh Scholar panel')
        if (result.ok) gateDrafts.clear(projectId, id)
        if (!result.ok && firstFailure === null) firstFailure = result
      }
      if (firstFailure !== null) {
        state.lastError = gateDecisionErrorText(firstFailure.error, firstFailure.status)
      } else {
        state.lastError = undefined
        showToast(rootHost(), t('overview', 'overview.gatesApprovedToast', { count: String(gatesSelected.size) }))
      }
      gatesSelecting = false
      gatesSelected.clear()
      state.rerender()
    }
    const rejectSel = el('button', 'btn reject', t('overview', 'overview.gatesRejectSelected'))
    rejectSel.disabled = gatesSelected.size === 0
    rejectSel.onclick = async () => {
      approveSel.disabled = rejectSel.disabled = true
      let firstFailure: Extract<ApiResult<Record<string, unknown>>, { ok: false }> | null = null
      for (const id of [...gatesSelected]) {
        const result = await submitGateDecision(id, 'rejected', gateDrafts.get(projectId, id).reason.trim() || 'bulk rejected from dsh Scholar panel')
        if (result.ok) gateDrafts.clear(projectId, id)
        if (!result.ok && firstFailure === null) firstFailure = result
      }
      if (firstFailure !== null) {
        state.lastError = gateDecisionErrorText(firstFailure.error, firstFailure.status)
      } else {
        state.lastError = undefined
        showToast(rootHost(), t('overview', 'overview.gatesRejectedToast', { count: String(gatesSelected.size) }))
      }
      gatesSelecting = false
      gatesSelected.clear()
      state.rerender()
    }
    const doneSel = el('button', 'hbtn', t('artifacts', 'artifacts.done'))
    doneSel.onclick = () => {
      gatesSelecting = false
      gatesSelected.clear()
      state.rerender()
    }
    const allBtn = el('button', 'hbtn', t('artifacts', 'artifacts.all'))
    allBtn.title = t('overview', 'overview.gatesAllTitle')
    allBtn.onclick = () => {
      for (const g of pFiltered) if (g.gate_id !== undefined) gatesSelected.add(g.gate_id)
      renderList()
    }
    bar.append(count, allBtn, approveSel, rejectSel, doneSel)
    listEl.appendChild(bar)
  }
  for (const gate of pFiltered) {
    const card = el('div', 'card border-amber')
    const top = el('div', 'row')
    // Multi-select checkbox (pending gates only).
    if (gatesSelecting && gate.gate_id !== undefined) {
      const box = el('span', 'ws-check', gatesSelected.has(gate.gate_id) ? '☑' : '☐')
      box.style.cssText += ';cursor:pointer'
      box.onclick = (event) => {
        event.stopPropagation()
        if (gate.gate_id === undefined) return
        if (gatesSelected.has(gate.gate_id)) gatesSelected.delete(gate.gate_id)
        else gatesSelected.add(gate.gate_id)
        state.rerender()
      }
      top.prepend(box)
      if (gatesSelected.has(gate.gate_id)) card.style.outline = '1px solid var(--tone-amber)'
    }
    top.appendChild(el('span', 'pname', t('overview', 'overview.gateTypeLabel', { type: shortType(gate.type) })))
    top.appendChild(pill('pending'))
    card.appendChild(top)
    if (gate.title !== undefined && gate.title !== '') {
      const t = el('div', 'grow', gate.title)
      t.style.cssText = 'margin-top:4px;color:var(--text);font-size:11.5px'
      card.appendChild(t)
    }
    if (gate.summary !== undefined && gate.summary !== '') {
      const s = el('div', 'muted', gate.summary)
      s.style.cssText = 'margin-top:3px'
      card.appendChild(s)
    }
    // dsh-web traceability: the gate id (support / ledger lookups), copyable.
    if (gate.gate_id !== undefined && gate.gate_id !== '') {
      const gid = el('div', 'muted mono', fmtId(gate.gate_id, 26))
      gid.style.cssText = 'margin-top:3px;font-size:9px;cursor:pointer'
      gid.title = t('common', 'common.clickCopyGateId')
      gid.onclick = (event) => {
        event.stopPropagation()
        if (gate.gate_id !== undefined) copyText(gate.gate_id)
      }
      card.appendChild(gid)
    }
    const actions = el('div', 'gate-actions')
    actions.style.cssText = 'margin-top:10px;display:flex;gap:8px'
    const approve = el('button', 'btn approve', t('overview', 'overview.gatesApprove'))
    const reject = el('button', 'btn reject', t('overview', 'overview.gatesReject'))
    // dsh-web decision reason: optional free-text recorded in the ledger.
    const reasonRow = el('div')
    reasonRow.style.cssText = 'display:none;margin-top:8px;gap:6px;align-items:center'
    const reasonInput = document.createElement('input')
    const draft = gateDrafts.get(projectId, gate.gate_id ?? '')
    reasonRow.style.display = draft.open ? 'flex' : 'none'
    reasonInput.value = draft.reason
    reasonInput.type = 'text'
    reasonInput.placeholder = t('overview', 'overview.gatesReasonPlaceholder')
    reasonInput.setAttribute('aria-label', t('overview', 'overview.gatesReasonPlaceholder'))
    reasonInput.oninput = () => { gateDrafts.update(projectId, gate.gate_id ?? '', { reason: reasonInput.value }) }
    reasonInput.maxLength = 200
    reasonInput.style.cssText = 'flex:1;min-width:0;background:var(--bg-input);color:var(--text);border:1px solid var(--border);border-radius:8px;padding:5px 10px;font:11px/1.4 system-ui,sans-serif;outline:none'
    reasonInput.onfocus = () => { reasonInput.style.borderColor = 'var(--accent)' }
    reasonInput.onblur = () => { reasonInput.style.borderColor = 'var(--border)' }
    reasonRow.appendChild(reasonInput)
    const clearDraft = el('button', 'hbtn', t('overview', 'overview.gateDraftClear'))
    clearDraft.onclick = () => { gateDrafts.clear(projectId, gate.gate_id ?? ''); reasonInput.value = ''; gateDrafts.update(projectId, gate.gate_id ?? '', { open: true }) }
    reasonRow.appendChild(clearDraft)
    const reasonToggle = el('button', 'hbtn', t('overview', 'overview.gatesReason'))
    reasonToggle.title = t('overview', 'overview.gatesReasonTitle')
    reasonToggle.setAttribute('aria-expanded', String(draft.open))
    reasonToggle.style.cssText = 'padding:0 8px;font-size:10px'
    approve.disabled = reject.disabled = reasonInput.disabled = clearDraft.disabled = gateSubmissions.has(gate.gate_id ?? '')
    reasonToggle.onclick = () => {
      const open = reasonRow.style.display === 'none'
      reasonRow.style.display = open ? 'flex' : 'none'
      reasonToggle.setAttribute('aria-expanded', String(open))
      gateDrafts.update(projectId, gate.gate_id ?? '', { open })
      if (open) reasonInput.focus()
    }
    const act = async (decision: 'approved' | 'rejected', label: string): Promise<void> => {
      if (approve.disabled) return
      const reason = reasonInput.value.trim()
      approve.disabled = reject.disabled = reasonInput.disabled = clearDraft.disabled = true
      const result = await submitGateDecision(
        gate.gate_id ?? '',
        decision,
        reason !== '' ? reason : `${label} from dsh Scholar panel`,
      )
      if (!result.ok) {
        state.lastError = gateDecisionErrorText(result.error, result.status)
      } else {
        gateDrafts.clear(projectId, gate.gate_id ?? '')
        state.lastError = undefined
        // dsh-web confirmation: toast the decision outcome.
        const icon = decision === 'approved' ? '✓' : '✕'
        const verdict = decision === 'approved' ? t('overview', 'overview.gateApproved') : t('overview', 'overview.gateRejected')
        showToast(rootHost(), t('overview', 'overview.gateDecisionToast', { icon, type: shortType(gate.type), decision: verdict }))
      }
      state.rerender()
    }
    approve.onclick = () => { void act('approved', 'approved') }
    reject.onclick = () => { void act('rejected', 'rejected') }
    if (!gatesSelecting) {
      actions.append(approve, reject, reasonToggle)
      card.appendChild(actions)
      card.appendChild(reasonRow)
    }
    // dsh-web context menu: copy the gate id (or the whole decision line).
    card.oncontextmenu = (event) => {
      event.preventDefault()
      event.stopPropagation()
      const root = document.querySelector('#dsh-scholar-ui')?.shadowRoot
      if (root == null) return
      const items: ContextMenuItem[] = []
      if (gate.gate_id !== undefined) {
        items.push({ label: t('common', 'common.action.copyId'), hint: gate.gate_id, onPick: () => copyText(gate.gate_id!) })
      }
      items.push({
        label: t('common', 'common.action.copySummary'),
        onPick: () => copyText(`${shortType(gate.type)} Gate${gate.title !== undefined && gate.title !== '' ? ` — ${gate.title}` : ''}${gate.gate_id !== undefined ? ` (${gate.gate_id})` : ''}`),
      })
      openContextMenu(root, event.clientX, event.clientY, items)
    }
    listEl.appendChild(card)
  }
  if (dFiltered.length > 0) {
    // dsh-web collapsible sections: the decided list can be folded away.
    const decHeader = el('button')
    decHeader.setAttribute('aria-expanded', gatesDecidedOpen ? 'true' : 'false')
    decHeader.style.cssText = 'display:flex;align-items:center;gap:6px;border:0;background:none;cursor:pointer;color:var(--text);padding:2px 0'
    decHeader.appendChild(el('span', 'section-label', t('overview', 'overview.gatesDecided', { arrow: gatesDecidedOpen ? '▾' : '▸', count: String(dFiltered.length) })))
    decHeader.onclick = () => { gatesDecidedOpen = !gatesDecidedOpen; state.rerender() }
    listEl.appendChild(decHeader)
    if (gatesDecidedOpen) {
      const card = el('div', 'card')
      for (const gate of dFiltered) {
        const row = el('div', 'gate-row')
        const info = el('div', 'grow')
        const name = el('div', 'pname', t('overview', 'overview.gateTypeLabel', { type: shortType(gate.type) }))
        name.style.cssText = 'font-size:11.5px'
        info.appendChild(name)
        if (gate.title !== undefined && gate.title !== '') info.appendChild(el('div', 'muted', gate.title))
        // dsh-web decision provenance: actor + timestamp (+ reason on hover).
        const dec = decisions.find(d => d.gate_id === gate.gate_id)
        if (dec !== undefined) {
          const when = String(dec.decided_at ?? '').replace('T', ' ').slice(0, 16)
          const decisionWire = String(dec.decision ?? '?')
          const decision = decisionWire === 'approved'
            ? t('overview', 'overview.gateApproved')
            : decisionWire === 'rejected'
              ? t('overview', 'overview.gateRejected')
              : decisionWire === 'revised'
                ? t('overview', 'overview.gateRevised')
                : decisionWire
          const meta = el('div', 'muted', t('overview', 'overview.gateDecisionProvenance', {
            actor: String(dec.actor ?? '?'), decision, when: when || '—',
          }))
          meta.style.cssText = 'font-size:9.5px;margin-top:2px;color:var(--text-3)'
          const reason = String(dec.reason ?? '')
          if (reason !== '') meta.title = reason
          info.appendChild(meta)
        }
        row.appendChild(info)
        const draft = gateDrafts.get(projectId, gate.gate_id ?? '')
        if (draft.reason !== '') {
          const saved = el('div', 'muted', t('overview', 'overview.gateDraftDecided', { reason: draft.reason }))
          saved.style.cssText = 'white-space:pre-wrap;overflow-wrap:anywhere;margin-top:6px'
          const clear = el('button', 'hbtn', t('overview', 'overview.gateDraftClear'))
          clear.onclick = () => { gateDrafts.clear(projectId, gate.gate_id ?? ''); renderList() }
          info.append(saved, clear)
        }
        row.appendChild(pill(gate.status))
        card.appendChild(row)
      }
      listEl.appendChild(card)
    }
  }
  }
  searchInput.oninput = () => { gatesQuery = searchInput.value; renderList() }
  renderList()
}

/** Runs multi-select (dsh-web bulk cancel). */
