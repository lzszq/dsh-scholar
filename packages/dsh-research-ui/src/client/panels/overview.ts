/**
 * Overview tab (phase panel) — NextAction v2 card assembly (gui-plugin-plan
 * §5.1, audit item #11). All display decisions live in the PURE model
 * (next-action-cards.ts, unit-tested); this file only maps the model to DOM
 * nodes and wires the route CTA through the existing navigation mechanism
 * (state.activeTab + tabSave + rerender, plus the stable `#tab=<key>` deep
 * link from nav.ts that parseDeepLink/hashchange consume).
 */
import type { NextActionV2, Projection } from '../types'
import { el, rootHost } from '../ui'
import { t } from '../i18n/index'
import { chromeTabs } from '../i18n/chrome'
import { state, tabSave } from '../state'
import { DEEP_LINK_TAB_PREFIX, isTabVisible } from '../nav'
import { nextActionCardModel, prioritizeNextActions, resolveNextActionInput, type NextActionCardModel } from '../next-action-cards'
import { openJobDetailModal } from './runs'
import { openIntakeModal } from '../modals/intake'
import { runChatLine } from '../modals/commands'

/** Navigate to a panel tab through the existing nav mechanism: direct tab
 *  switch (immediate) + the stable deep link (survives reload/back-forward).
 *  Intake actions (route 'intake') open the intake wizard modal instead. */
function navigateTo(model: NextActionCardModel): void {
  if (model.jobId !== null) {
    const root = rootHost()
    if (root !== null) void openJobDetailModal(root, model.jobId)
    return
  }
  if (model.commandDraft !== null) {
    runChatLine(model.commandDraft)
    return
  }
  if (model.route === 'intake') {
    openIntakeModal(rootHost(), {
      projectId: model.intakeProjectId ?? undefined,
      intakeId: model.intakeId ?? undefined,
    })
    return
  }
  // Budget governance remains reachable through Approvals while the optional
  // diagnostic Budget page is hidden.
  const tab = model.route === 'budget' && !isTabVisible('budget') ? 'gates' : model.route
  state.activeTab = tab
  tabSave()
  state.rerender()
  try {
    const link = `${DEEP_LINK_TAB_PREFIX}${tab}`
    if (location.hash !== link) location.hash = link
  } catch { /* sandboxed */ }
}

/** One card node from a pure model (light DOM assembly — no logic here). */
export function nextActionCardNode(model: NextActionCardModel): HTMLElement {
  const card = el('div', `card nax ${model.tone}`)
  // head row: code badge + resolved title + state pill.
  const head = el('div', 'row nax-head')
  head.style.cssText = 'gap:8px;align-items:flex-start'
  const badge = el('span', 'nax-code mono', model.code)
  const title = el('span', 'grow nax-title', model.title)
  head.append(badge, title)
  const pill = el('span', `nax-state nax-state-${model.tone}`, model.stateLabel)
  head.appendChild(pill)
  // required-by chip (USAGE_GUIDE §11): who must perform this action
  // (kernel `required_by` wire field; no chip when not declared).
  if (model.requiredBy !== null) {
    const who = el('span', 'nax-who mono', t('overview', `overview.nextaction.requiredBy.${model.requiredBy}`))
    who.style.cssText = 'flex:none;font-size:9.5px;color:var(--text-2);border:1px solid var(--border-2);border-radius:99px;padding:1px 8px;margin-left:4px'
    head.appendChild(who)
  }
  card.appendChild(head)
  // reason row: kernel wire text, verbatim (data, not chrome).
  if (model.reasonText !== '') {
    const reason = el('div', 'muted nax-reason', model.reasonText)
    reason.style.cssText = 'margin-top:6px;line-height:1.5'
    card.appendChild(reason)
  }
  // blocked card: click reveals the missing-precondition list (a11y title
  // on the card; the button below is disabled while gaps are open).
  if (model.tone === 'blocked' && model.missingList.length > 0) {
    const gaps = el('div', 'nax-gaps')
    gaps.style.cssText = 'display:none;margin-top:8px;padding:8px 10px;border:1px dashed var(--tone-amber);border-radius:8px;background:var(--tone-amber-bg)'
    const gapLabel = el('div', '', t('overview', 'overview.nextaction.required'))
    gapLabel.style.cssText = 'font-weight:600;font-size:10.5px;color:var(--tone-amber);margin-bottom:4px'
    const list = el('ul', 'nax-gap-list')
    list.style.cssText = 'margin:0;padding-left:16px'
    for (const gap of model.missingList) list.appendChild(el('li', 'nax-gap', gap))
    gaps.append(gapLabel, list)
    card.appendChild(gaps)
    card.title = t('overview', 'overview.nextaction.showGaps')
    card.style.cursor = 'pointer'
    card.onclick = () => { gaps.style.display = gaps.style.display === 'none' ? 'block' : 'none' }
  }
  // blocking note: phase cannot advance before this step.
  if (model.blockingNote !== '') {
    const note = el('div', 'muted nax-blocking', model.blockingNote)
    note.style.cssText = 'margin-top:6px;font-size:10.5px;color:var(--tone-amber)'
    card.appendChild(note)
  }
  // route CTA: jump to the mapped panel tab; done/blocked-with-gaps
  // actions are grayed out (disabled attribute).
  if (model.hasRoute) {
    const foot = el('div', 'row nax-foot')
    foot.style.cssText = 'margin-top:8px;justify-content:flex-end'
    const destination = model.route === 'budget' && !isTabVisible('budget') ? 'gates' : model.route
    const tabLabel = destination === 'intake'
      ? t('intake', 'intake.title')
      : (chromeTabs().find(tab => tab.key === destination)?.label ?? destination)
    const go = el('button', 'hbtn nax-go', t('overview', 'overview.nextaction.open', { tab: tabLabel }))
    if (model.disabled) {
      go.disabled = true
      go.style.cssText += ';opacity:.45;cursor:not-allowed'
    }
    go.onclick = () => { navigateTo(model) }
    foot.appendChild(go)
    card.appendChild(foot)
  }
  return card
}

/**
 * Render the Overview "next actions" section from the structured authority.
 * Empty or malformed input renders the safe none state.
 */
export function renderNextActionSection(body: HTMLElement, p: Projection): void {
  body.appendChild(el('div', 'section-label', t('overview', 'overview.nextActions')))
  const input = resolveNextActionInput(p)
  if (input.actions.length === 0) {
    body.appendChild(el('div', 'empty', t('overview', 'overview.nextActions.none')))
    return
  }
  for (const [index, action] of prioritizeNextActions(input.actions).entries()) {
    if (index === 1) body.appendChild(el('div', 'section-label', t('overview', 'overview.nextActions.other')))
    const card = nextActionCardNode(nextActionCardModel(action, undefined, {
      briefProblem: p.project?.brief?.problem,
    }))
    if (index === 0 && action.state !== 'done') card.style.borderColor = 'var(--accent)'
    body.appendChild(card)
  }
}

/** Convenience export for callers that already resolved the input. */
export function nextActionCardNodes(actions: NextActionV2[]): HTMLElement[] {
  return actions.map(action => nextActionCardNode(nextActionCardModel(action)))
}
