import type { Projection } from '../types'
import { api, apiResult } from '../api'
import { t } from '../i18n/index'
import { openContractDetailModal, openIdeaDetailModal } from '../modals/detail'
import { state, tabSave } from '../state'
import { phasePipeline, copyText, el, fmtId, openContextMenu } from '../ui'
import { renderNextActionSection } from './overview'
import { isTabVisible } from '../nav'
import {
  methodologySummaryNode,
  type CompactMethodologyProjection,
} from '../methodology-projection'
/* ─────────────────────────── tab renderers ─────────────────────────── */

export async function renderPhase(
  body: HTMLElement,
  p: Projection,
  projectId?: string,
  methodology?: CompactMethodologyProjection | null,
): Promise<void> {
  const status = p.project?.status ?? ''
  // Evaluated per render against the CURRENT locale (§13.4).
  const pipelineDefs = phasePipeline()
  const statusIdx = pipelineDefs.findIndex(([k]) => k === status)
  const pipeline = el('div', 'pipeline-wrap')
  const steps = el('div', 'pipeline')
  for (const [key, label] of pipelineDefs) {
    const step = el('div', 'pstep')
    const idx = pipelineDefs.findIndex(([k]) => k === key)
    if (statusIdx < 0 || idx < statusIdx) step.classList.add('done')
    if (key === status) step.classList.add('current')
    step.appendChild(el('span', 'dot'))
    step.appendChild(el('span', 'lbl', label))
    steps.appendChild(step)
  }
  pipeline.appendChild(steps)
  // dsh-web progress: completion % of the pipeline.
  const statusIdx2 = statusIdx >= 0 ? statusIdx : pipelineDefs.length
  const pct = Math.round((statusIdx2 / pipelineDefs.length) * 100)
  const pctRow = el('div', 'muted')
  pctRow.style.cssText = 'font-size:10px;margin-top:6px;text-align:right'
  pctRow.textContent = t('overview', 'overview.progress', { pct: String(pct) })
  pipeline.appendChild(pctRow)
  body.appendChild(pipeline)

  // dsh-web summary row: problem + primary metrics.
  const brief = p.project?.brief
  if (brief !== undefined) {
    const sum = el('div', 'muted')
    sum.style.cssText = 'font-size:11px;margin-top:8px;line-height:1.5'
    const problem = typeof brief.problem === 'string' && brief.problem !== '' ? brief.problem : null
    const metrics = Array.isArray(brief.primary_metrics) && brief.primary_metrics.length > 0 ? brief.primary_metrics.join(', ') : null
    const parts: string[] = []
    if (problem !== null) parts.push(problem)
    if (metrics !== null) parts.push(`📊 ${metrics}`)
    if (parts.length > 0) sum.textContent = parts.join(' · ')
    body.appendChild(sum)
  }

  if (projectId !== undefined) body.appendChild(methodologySummaryNode(methodology, 'overview'))

  // GUIDE-01: only structured v2 cards are accepted. Missing or malformed
  // projections stay a safe empty state; labels never reconstruct a CTA.
  renderNextActionSection(body, p)

  // history (audit ledger: transitions, gate decisions, renames, archives)
  const history = (p.project?.history ?? [])
  // dsh-web timeline: show the newest 10 entries; a toggle reveals the rest.
  const historyShown = phaseHistoryAll ? history : history.slice(-10)
  // dsh-web quick-nav: jump to the relevant panel from the pipeline view.
  body.appendChild(el('div', 'section-label', t('overview', 'overview.quickView')))
  const quick = el('div', 'row')
  quick.style.cssText = 'gap:6px;flex-wrap:wrap'
  const jump = (label: string, tab: string): void => {
    const b = el('button', 'hbtn', label)
    b.style.cssText = 'padding:2px 10px;font-size:10.5px'
    b.onclick = () => {
      state.activeTab = tab
      tabSave()
      state.rerender()
    }
    quick.appendChild(b)
  }
  jump(t('overview', 'overview.jump.chat'), 'chat')
  jump(t('overview', 'overview.jump.approvals'), 'gates')
  jump(t('overview', 'overview.jump.runs'), 'runs')
  jump(t('overview', 'overview.jump.artifacts'), 'artifacts')
  jump(t('overview', 'overview.jump.evidence'), 'evidence')
  if (isTabVisible('budget')) jump(t('overview', 'overview.jump.budget'), 'budget')
  body.appendChild(quick)
  // dsh-web data panel: budget usage of this project.
  const budget = p.budget
  const maxUsd = p.project?.constraints?.max_model_cost_usd
  const maxGpu = p.project?.constraints?.max_gpu_hours
  if (budget !== undefined) {
    body.appendChild(el('div', 'section-label', t('overview', 'overview.budgetUsage')))
    const bcard = el('div', 'card')
    const addBar = (label: string, used: number, max: number | undefined, unit: string): void => {
      const row = el('div', 'budget-row')
      row.appendChild(el('span', 'blabel', label))
      const track = el('div', 'budget-track')
      const fill = el('div', 'budget-fill')
      const ratio = max !== undefined && max > 0 ? Math.min(used / max, 1) : 0
      const color = ratio >= 1 ? 'var(--tone-red)' : ratio >= 0.8 ? 'var(--tone-amber)' : 'var(--accent)'
      fill.style.cssText = `width:${Math.max(ratio * 100, used > 0 ? 4 : 0)}%;background:${color};box-shadow:0 0 6px ${color}`
      track.appendChild(fill)
      row.appendChild(track)
      const val = el('span', 'budget-val', max === undefined
        ? t('overview', 'overview.budgetValue', { used: String(used), unit })
        : t('overview', 'overview.budgetValueWithMax', { used: String(used), max: String(max), unit }))
      row.appendChild(val)
      bcard.appendChild(row)
    }
    addBar(t('overview', 'overview.modelLabel'), budget.model_cost_usd ?? 0, maxUsd, '$')
    addBar(t('overview', 'overview.gpuLabel'), budget.gpu_hours ?? 0, maxGpu, 'h')
    // The summary remains visible for governance, but the diagnostic Budget
    // page is only interactive when the user explicitly enabled it.
    if (isTabVisible('budget')) {
      bcard.style.cursor = 'pointer'
      bcard.title = t('overview', 'overview.budgetBarTitle')
      bcard.onclick = () => {
        state.activeTab = 'budget'
        tabSave()
        state.rerender()
      }
    }
    body.appendChild(bcard)
  }
  // dsh-web data panel: IdeaCards of this project.
  if (projectId !== undefined && (p.counts?.ideas ?? 0) > 0) {
    const ideas = (await api<Array<Record<string, unknown>>>(`/v1/projects/${encodeURIComponent(projectId)}/ideas`)) ?? []
    const canSelectIdea = status === 'SURVEYING' && (p.next_actions_v2 ?? []).some(action =>
      action.code === 'idea_select' && action.state === 'ready' && action.required_by === 'human')
    body.appendChild(el('div', 'section-label', t('overview', 'overview.ideaCards', { count: String(ideas.length) })))
    const card = el('div', 'card')
    for (const idea of ideas.slice(0, 5)) {
      const row = el('div', 'row')
      row.style.cssText = 'padding:4px 0;align-items:flex-start'
      row.appendChild(el('span', 'artifact-kind', String(idea.status ?? '?')))
      const bodyEl = el('div', 'grow')
      bodyEl.style.cssText = 'min-width:0'
      const title = el('div', '', String(idea.title ?? ''))
      title.style.cssText = 'font-size:11.5px;color:var(--text)'
      const id = el('div', 'muted mono', fmtId(String(idea.idea_id ?? '')))
      id.style.cssText = 'font-size:9px'
      bodyEl.append(title, id)
      row.appendChild(bodyEl)
      row.title = t('overview', 'overview.ideaRowTitle')
      row.ondblclick = (event) => {
        event.stopPropagation()
        const root = document.querySelector('#dsh-scholar-ui')?.shadowRoot
        if (root != null) openIdeaDetailModal(root, idea)
      }
      // dsh-web drawer: one-click idea details.
      const ideaBtn = el('button', 'hbtn', '⧉')
      ideaBtn.title = t('overview', 'overview.ideaDetails')
      ideaBtn.style.cssText = 'padding:0 6px;font-size:9px;flex-shrink:0'
      ideaBtn.onclick = (event) => {
        event.stopPropagation()
        const root = document.querySelector('#dsh-scholar-ui')?.shadowRoot
        if (root != null) openIdeaDetailModal(root, idea)
      }
      row.appendChild(ideaBtn)
      if (canSelectIdea && idea.status === 'proposed' && typeof idea.idea_id === 'string') {
        const selectBtn = el('button', 'hbtn', t('overview', 'overview.ideaSelect'))
        selectBtn.style.cssText = 'padding:0 8px;font-size:9px;flex-shrink:0'
        selectBtn.onclick = async event => {
          event.stopPropagation()
          selectBtn.disabled = true
          selectBtn.textContent = t('overview', 'overview.ideaSelecting')
          const result = await apiResult(`/api/chat/ideas/select`, {
            method: 'POST',
            body: JSON.stringify({ project_id: projectId, idea_id: idea.idea_id }),
          })
          if (!result.ok) {
            selectBtn.disabled = false
            selectBtn.textContent = t('overview', 'overview.ideaSelectFailed', { code: result.error.code ?? `http_${result.status}` })
            return
          }
          state.activeTab = 'gates'
          tabSave()
          state.rerender()
        }
        row.appendChild(selectBtn)
      }
      // dsh-web context menu: details / copy id.
      row.oncontextmenu = (event) => {
        event.preventDefault()
        event.stopPropagation()
        const root = document.querySelector('#dsh-scholar-ui')?.shadowRoot
        if (root == null) return
        const iid = String(idea.idea_id ?? '')
        openContextMenu(root, event.clientX, event.clientY, [
          { label: `⧉ ${t('common', 'common.action.details')}`, onPick: () => openIdeaDetailModal(root, idea) },
          ...(iid !== '' ? [{ label: t('common', 'common.action.copyId'), hint: iid, onPick: () => copyText(iid) }] : []),
        ])
      }
      card.appendChild(row)
    }
    if (ideas.length > 5) card.appendChild(el('div', 'muted', t('overview', 'overview.ideaMore', { count: String(ideas.length - 5) })))
    body.appendChild(card)
  } else if (projectId !== undefined) {
    // dsh-web empty state: no IdeaCards yet on this project.
    body.appendChild(el('div', 'section-label', t('overview', 'overview.ideaCards', { count: '0' })))
    body.appendChild(el('div', 'empty', t('overview', 'overview.ideaEmpty')))
  }
  // dsh-web data panel: ExperimentContracts of this project.
  if (projectId !== undefined && (p.counts?.contracts ?? 0) > 0) {
    const contracts = (await api<Array<Record<string, unknown>>>(`/v1/projects/${encodeURIComponent(projectId)}/contracts`)) ?? []
    body.appendChild(el('div', 'section-label', t('overview', 'overview.contracts', { count: String(contracts.length) })))
    const card = el('div', 'card')
    for (const c of contracts.slice(0, 5)) {
      const row = el('div', 'row')
      row.style.cssText = 'padding:4px 0;align-items:flex-start'
      row.appendChild(el('span', 'artifact-kind', String(c.status ?? '?')))
      const bodyEl = el('div', 'grow')
      bodyEl.style.cssText = 'min-width:0'
      const cRecord = c as Record<string, Record<string, unknown> | unknown>
      const methods = (typeof cRecord.methods === 'object' && cRecord.methods !== null ? cRecord.methods : {}) as Record<string, unknown>
      const title = el('div', '', `${t('overview', 'overview.contractComparison', {
        baseline: String(methods.baseline ?? '?'),
        treatment: String(methods.treatment ?? '?'),
      })}${typeof cRecord.version === 'number' ? ` · v${cRecord.version}` : ''}`)
      title.style.cssText = 'font-size:11.5px;color:var(--text)'
      const id = el('div', 'muted mono', fmtId(String(c.contract_id ?? '')))
      id.style.cssText = 'font-size:9px'
      bodyEl.append(title, id)
      row.appendChild(bodyEl)
      row.title = t('overview', 'overview.contractRowTitle')
      row.ondblclick = (event) => {
        event.stopPropagation()
        const root = document.querySelector('#dsh-scholar-ui')?.shadowRoot
        if (root != null) openContractDetailModal(root, c)
      }
      // dsh-web drawer: one-click contract details.
      const contractBtn = el('button', 'hbtn', '⧉')
      contractBtn.title = t('overview', 'overview.contractDetails')
      contractBtn.style.cssText = 'padding:0 6px;font-size:9px;flex-shrink:0'
      contractBtn.onclick = (event) => {
        event.stopPropagation()
        const root = document.querySelector('#dsh-scholar-ui')?.shadowRoot
        if (root != null) openContractDetailModal(root, c)
      }
      row.appendChild(contractBtn)
      // dsh-web context menu: details / copy id.
      row.oncontextmenu = (event) => {
        event.preventDefault()
        event.stopPropagation()
        const root = document.querySelector('#dsh-scholar-ui')?.shadowRoot
        if (root == null) return
        const cid = String(c.contract_id ?? '')
        openContextMenu(root, event.clientX, event.clientY, [
          { label: `⧉ ${t('common', 'common.action.details')}`, onPick: () => openContractDetailModal(root, c) },
          ...(cid !== '' ? [{ label: t('common', 'common.action.copyId'), hint: cid, onPick: () => copyText(cid) }] : []),
        ])
      }
      card.appendChild(row)
    }
    if (contracts.length > 5) card.appendChild(el('div', 'muted', t('overview', 'overview.contractMore', { count: String(contracts.length - 5) })))
    body.appendChild(card)
  }
  if (history.length > 0) {
    body.appendChild(el('div', 'section-label', t('overview', 'overview.auditHistory')))
    for (const h of historyShown) {
      const row = el('div', 'row')
      row.style.cssText = 'padding:2px 0;align-items:flex-start'
      // Pick an icon by the audit kind (dsh-web timeline feel).
      let icon = '·'
      if (h.includes('->')) icon = '➡️'
      else if (h.includes('renamed')) icon = '✎'
      else if (h.includes('archived')) icon = '🗄'
      else if (h.includes('approved')) icon = '✅'
      else if (h.includes('rejected')) icon = '⛔'
      row.appendChild(el('span', 'muted', icon))
      row.appendChild(el('span', 'grow muted', h))
      body.appendChild(row)
    }
    if (history.length > 10) {
      const toggleBtn = el('button', 'hbtn', phaseHistoryAll
        ? t('overview', 'overview.showLast10')
        : t('overview', 'overview.showAll', { count: String(history.length) }))
      toggleBtn.style.cssText = 'padding:1px 10px;margin-top:6px'
      toggleBtn.onclick = () => { phaseHistoryAll = !phaseHistoryAll; state.rerender() }
      body.appendChild(toggleBtn)
    }
  }
}


/** Phase tab audit history: newest-10 by default, toggle reveals all. */
export let phaseHistoryAll = false
