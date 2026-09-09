/**
 * Compact, tolerant browser projection for methodology state.
 *
 * The Kernel remains authoritative. This Module only converts the compact
 * GET wire into localized rows for existing Overview, Manuscript and
 * Topology surfaces; it exposes no mutation and no new navigation surface.
 */

import { t } from './i18n/index'
import { el } from './ui'
import { runChatLine } from './modals/commands'

export type MethodologySurface = 'overview' | 'manuscript' | 'topology'
export type MethodologyTone = 'ok' | 'warning' | 'blocking' | 'neutral'

export interface CompactMethodologyProjection {
  project_id?: unknown
  revision?: unknown
  assurance?: {
    level?: unknown
    ready?: unknown
    reason_codes?: unknown
  } | null
  protocol?: {
    current_id?: unknown
    revision?: unknown
    status?: unknown
    intent?: unknown
  } | null
  synthesis?: {
    current_id?: unknown
    fresh?: unknown
    stale_reasons?: unknown
  } | null
  knowledge?: {
    active_count?: unknown
    package_names?: unknown
    suppressed_count?: unknown
    status?: unknown
  } | null
  writing?: {
    outline_id?: unknown
    blocking_count?: unknown
    stale?: unknown
    reason_codes?: unknown
  } | null
  topology?: {
    assurance_audit_count?: unknown
    latest_audit_id?: unknown
    research_node_count?: unknown
    research_edge_count?: unknown
  } | null
  next_recommendation?: {
    code?: unknown
    label_key?: unknown
  } | null
}

export interface MethodologySummaryRow {
  key: 'assurance' | 'protocol' | 'synthesis' | 'knowledge' | 'writing' | 'topology'
  label: string
  value: string
  tone: MethodologyTone
}

export interface MethodologyProjectionModel {
  title: string
  rows: MethodologySummaryRow[]
  recommendation: { code: string; label: string } | null
  unavailable: boolean
}

const RECOMMENDATION_KEYS: Readonly<Record<string, string>> = {
  review_writing: 'methodology.next.reviewWriting',
  configure_protocol: 'methodology.next.configureProtocol',
  run_assurance: 'methodology.next.runAssurance',
  activate_knowledge: 'methodology.next.activateKnowledge',
  run_synthesis: 'methodology.next.runSynthesis',
  direction_gate_review: 'methodology.next.directionGateReview',
  direction_deepen_continue: 'methodology.next.directionDeepenContinue',
  direction_broaden_intake: 'methodology.next.directionBroadenIntake',
  direction_pivot_intake: 'methodology.next.directionPivotIntake',
  direction_conclude_prepare: 'methodology.next.directionConcludePrepare',
  direction_pause_review: 'methodology.next.directionPauseReview',
  direction_overlay_stale: 'methodology.next.directionOverlayStale',
  direction_overlay_invalid: 'methodology.next.directionOverlayInvalid',
}

export function methodologyProjectionPath(projectId: string): string {
  return `/v2/projects/${encodeURIComponent(projectId)}/methodology`
}

function wireString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value : null
}

function wireCount(value: unknown): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : 0
}

function wireOptionalCount(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null
}

function wireStrings(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string' && item.trim() !== '')
    : []
}

function withReasons(value: string, reasons: unknown): string {
  const codes = wireStrings(reasons)
  return codes.length === 0 ? value : `${value} · ${codes.join(', ')}`
}

function assuranceRow(raw: CompactMethodologyProjection['assurance']): MethodologySummaryRow {
  const level = raw?.level === 'submission'
    ? t('methodology', 'methodology.value.submission')
    : raw?.level === 'draft'
      ? t('methodology', 'methodology.value.draft')
      : null
  const ready = raw?.ready === true
    ? t('methodology', 'methodology.value.ready')
    : raw?.ready === false
      ? t('methodology', 'methodology.value.notReady')
      : null
  const value = level !== null && ready !== null
    ? withReasons(`${level} · ${ready}`, raw?.reason_codes)
    : t('methodology', 'methodology.value.unavailable')
  return {
    key: 'assurance',
    label: t('methodology', 'methodology.label.assurance'),
    value,
    tone: raw?.ready === true ? 'ok' : raw?.ready === false ? 'blocking' : 'neutral',
  }
}

function protocolRow(raw: CompactMethodologyProjection['protocol']): MethodologySummaryRow {
  const id = wireString(raw?.current_id)
  const revision = wireCount(raw?.revision)
  if (id === null) {
    return {
      key: 'protocol',
      label: t('methodology', 'methodology.label.protocol'),
      value: t('methodology', 'methodology.value.protocolNone'),
      tone: 'neutral',
    }
  }
  const status = raw?.status === 'frozen'
    ? t('methodology', 'methodology.value.protocolFrozen')
    : raw?.status === 'draft'
      ? t('methodology', 'methodology.value.protocolDraft')
      : wireString(raw?.status)
  const intent = raw?.intent === 'confirmatory'
    ? t('methodology', 'methodology.value.intentConfirmatory')
    : raw?.intent === 'exploratory'
      ? t('methodology', 'methodology.value.intentExploratory')
      : wireString(raw?.intent)
  return {
    key: 'protocol',
    label: t('methodology', 'methodology.label.protocol'),
    value: [id, `rev ${revision}`, status, intent].filter(part => part !== null).join(' · '),
    tone: raw?.status === 'frozen' ? 'ok' : 'warning',
  }
}

function synthesisRow(raw: CompactMethodologyProjection['synthesis']): MethodologySummaryRow {
  const id = wireString(raw?.current_id)
  if (id === null) {
    return {
      key: 'synthesis',
      label: t('methodology', 'methodology.label.synthesis'),
      value: t('methodology', 'methodology.value.synthesisNone'),
      tone: 'neutral',
    }
  }
  const state = raw?.fresh === true
    ? t('methodology', 'methodology.value.fresh')
    : raw?.fresh === false
      ? t('methodology', 'methodology.value.stale')
      : t('methodology', 'methodology.value.unavailable')
  return {
    key: 'synthesis',
    label: t('methodology', 'methodology.label.synthesis'),
    value: withReasons(`${id} · ${state}`, raw?.stale_reasons),
    tone: raw?.fresh === true ? 'ok' : raw?.fresh === false ? 'warning' : 'neutral',
  }
}

function knowledgeRow(raw: CompactMethodologyProjection['knowledge']): MethodologySummaryRow {
  const count = wireCount(raw?.active_count)
  const packages = wireStrings(raw?.package_names)
  const countText = t('methodology', 'methodology.value.activeCount', { count: String(count) })
  const suppressed = wireCount(raw?.suppressed_count)
  const status = wireString(raw?.status)
  const statusText = status === 'delivery-ready'
    ? t('methodology', 'methodology.value.knowledgeDeliveryReady')
    : status === 'suppressed'
      ? t('methodology', 'methodology.value.knowledgeSuppressed', { count: String(suppressed) })
      : status === 'inactive' ? t('methodology', 'methodology.value.knowledgeInactive') : null
  const base = packages.length === 0 ? countText : `${countText} · ${packages.join(', ')}`
  return {
    key: 'knowledge',
    label: t('methodology', 'methodology.label.knowledge'),
    value: statusText === null ? base : `${base} · ${statusText}`,
    tone: status === 'delivery-ready' ? 'ok' : status === 'suppressed' ? 'warning' : 'neutral',
  }
}

function writingRow(raw: CompactMethodologyProjection['writing']): MethodologySummaryRow {
  const id = wireString(raw?.outline_id)
  if (id === null) {
    return {
      key: 'writing',
      label: t('methodology', 'methodology.label.writing'),
      value: t('methodology', 'methodology.value.writingNone'),
      tone: 'neutral',
    }
  }
  const blocking = wireCount(raw?.blocking_count)
  const freshness = raw?.stale === true
    ? t('methodology', 'methodology.value.stale')
    : raw?.stale === false
      ? t('methodology', 'methodology.value.fresh')
      : t('methodology', 'methodology.value.unavailable')
  const base = `${id} · ${t('methodology', 'methodology.value.blockingCount', { count: String(blocking) })} · ${freshness}`
  return {
    key: 'writing',
    label: t('methodology', 'methodology.label.writing'),
    value: withReasons(base, raw?.reason_codes),
    tone: blocking > 0 ? 'blocking' : raw?.stale === true ? 'warning' : raw?.stale === false ? 'ok' : 'neutral',
  }
}

function topologyRow(raw: CompactMethodologyProjection['topology']): MethodologySummaryRow {
  const count = wireCount(raw?.assurance_audit_count)
  const latest = wireString(raw?.latest_audit_id)
  const nodes = wireOptionalCount(raw?.research_node_count)
  const edges = wireOptionalCount(raw?.research_edge_count)
  if (count === 0 && latest === null && (nodes ?? 0) === 0 && (edges ?? 0) === 0) {
    return {
      key: 'topology',
      label: t('methodology', 'methodology.label.topology'),
      value: t('methodology', 'methodology.value.topologyNone'),
      tone: 'neutral',
    }
  }
  const countText = t('methodology', 'methodology.value.auditCount', { count: String(count) })
  const graphText = nodes === null || edges === null
    ? null
    : t('methodology', 'methodology.value.graphCount', { nodes: String(nodes), edges: String(edges) })
  return {
    key: 'topology',
    label: t('methodology', 'methodology.label.topology'),
    value: [
      countText,
      latest === null ? null : t('methodology', 'methodology.value.latest', { id: latest }),
      graphText,
    ].filter((value): value is string => value !== null).join(' · '),
    tone: 'neutral',
  }
}

function recommendation(raw: CompactMethodologyProjection['next_recommendation']): MethodologyProjectionModel['recommendation'] {
  const code = wireString(raw?.code)
  if (code === null) return null
  const expectedKey = RECOMMENDATION_KEYS[code]
  if (expectedKey === undefined || raw?.label_key !== expectedKey) return null
  return { code, label: t('methodology', expectedKey) }
}

/** Build the smallest useful localized summary for an existing surface. */
export function methodologyProjectionModel(
  raw: CompactMethodologyProjection | null | undefined,
  surface: MethodologySurface,
): MethodologyProjectionModel {
  const projection = raw ?? {}
  const rows = surface === 'overview'
    ? [
        assuranceRow(projection.assurance),
        protocolRow(projection.protocol),
        synthesisRow(projection.synthesis),
        knowledgeRow(projection.knowledge),
      ]
    : surface === 'manuscript'
      ? [writingRow(projection.writing), assuranceRow(projection.assurance)]
      : [topologyRow(projection.topology), knowledgeRow(projection.knowledge)]
  return {
    title: t('methodology', 'methodology.title'),
    rows,
    recommendation: surface === 'overview' ? recommendation(projection.next_recommendation) : null,
    unavailable: raw == null,
  }
}

/** DOM assembly for the shared compact summary; all decisions stay in the model. */
export function methodologySummaryNode(
  projection: CompactMethodologyProjection | null | undefined,
  surface: MethodologySurface,
): HTMLElement {
  const model = methodologyProjectionModel(projection, surface)
  const section = el('section', 'methodology-summary')
  section.setAttribute('aria-label', t('methodology', 'methodology.aria'))
  section.style.cssText = 'margin:8px 0 12px;padding:8px 10px;border:1px solid var(--border);border-radius:10px;background:var(--bg-3)'

  const header = el('div', 'section-label', model.title)
  header.style.cssText += ';margin:0 0 6px'
  section.appendChild(header)

  if (model.unavailable) {
    const error = el('div', 'muted', t('methodology', 'methodology.error'))
    error.style.cssText = 'font-size:10.5px;color:var(--tone-amber)'
    section.appendChild(error)
    return section
  }

  const grid = el('div', 'methodology-summary-grid')
  grid.style.cssText = 'display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:6px 12px'
  const toneColor: Record<MethodologyTone, string> = {
    ok: 'var(--tone-green)',
    warning: 'var(--tone-amber)',
    blocking: 'var(--tone-red)',
    neutral: 'var(--text-3)',
  }
  for (const row of model.rows) {
    const item = el('div', `methodology-summary-row methodology-${row.tone}`)
    item.dataset.methodology = row.key
    item.style.cssText = 'display:grid;grid-template-columns:7px minmax(72px,auto) 1fr;gap:6px;align-items:start;min-width:0;font-size:10.5px'
    const dot = el('span')
    dot.setAttribute('aria-hidden', 'true')
    dot.style.cssText = `width:6px;height:6px;margin-top:5px;border-radius:50%;background:${toneColor[row.tone]}`
    const label = el('span', 'muted', row.label)
    const value = el('span', '', row.value)
    value.style.cssText = 'min-width:0;overflow-wrap:anywhere;color:var(--text)'
    item.append(dot, label, value)
    grid.appendChild(item)
  }
  section.appendChild(grid)

  if (model.recommendation !== null) {
    const next = el('div', 'methodology-summary-next')
    next.dataset.recommendation = model.recommendation.code
    next.style.cssText = 'margin-top:7px;padding-top:6px;border-top:1px dashed var(--border-2);font-size:10.5px;color:var(--text-2)'
    next.textContent = `${t('methodology', 'methodology.label.next')}: ${model.recommendation.label}`
    if (model.recommendation.code === 'configure_protocol') {
      const help = el('button', 'hbtn', t('methodology', 'methodology.protocol.review'))
      help.style.cssText = 'margin-left:8px'
      help.onclick = () => { runChatLine(t('methodology', 'methodology.protocol.draft')) }
      next.appendChild(help)
    }
    section.appendChild(next)
  }
  return section
}
