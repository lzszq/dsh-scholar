/**
 * dsh-web local locale adapter (gui-plugin-plan §13.2): bind/getSnapshot/
 * subscribe/setLocale with zh/en dictionaries. Lookup order: active-locale
 * namespace → zh namespace → active-locale common → zh common → the raw key
 * (never an empty string). Missing keys (absent from EVERY dictionary) are
 * reported to the injected reporter and warn once per key in dev
 * (acceptance-tests.md §8: 缺 key 在开发模式 warning). Locale switching
 * (setLocale) bumps the revision, notifies listeners (the shell re-paints
 * chrome and re-renders panels) and rebuilds every registered open overlay
 * so tabs, pipeline, modals, Terminal and status all re-evaluate their
 * copy. A second install of the adapter in the same app instance is an
 * assembly error.
 */
import { zh as commonZh, en as commonEn } from './locales/common'
import { zh as standaloneZh, en as standaloneEn } from './locales/standalone'
import { zh as shellZh, en as shellEn } from './locales/shell'
import { zh as terminalZh, en as terminalEn } from './locales/terminal'
import { zh as manuscriptZh, en as manuscriptEn } from './locales/manuscript'
import { zh as overviewZh, en as overviewEn } from './locales/overview'
import { zh as runsZh, en as runsEn } from './locales/runs'
import { zh as artifactsZh, en as artifactsEn } from './locales/artifacts'
import { zh as evidenceZh, en as evidenceEn } from './locales/evidence'
import { zh as budgetZh, en as budgetEn } from './locales/budget'
import { zh as statusZh, en as statusEn } from './locales/status'
import { zh as intakeZh, en as intakeEn } from './locales/intake'
import { zh as grillGuideZh, en as grillGuideEn } from './locales/grill-guide'
import { zh as trajectoryZh, en as trajectoryEn } from './locales/trajectory'
import { zh as topologyZh, en as topologyEn } from './locales/topology'
import { zh as workspaceZh, en as workspaceEn } from './locales/workspace'
import { zh as ptyZh, en as ptyEn } from './locales/pty'
import { zh as methodologyZh, en as methodologyEn } from './locales/methodology'

export type Locale = 'zh' | 'en'

interface NamespaceDicts { [namespace: string]: Record<string, string> }
interface AllDicts { zh: NamespaceDicts; en: NamespaceDicts }

const DICTS: AllDicts = {
  zh: {
    common: commonZh as unknown as Record<string, string>,
    standalone: standaloneZh as unknown as Record<string, string>,
    shell: shellZh as unknown as Record<string, string>,
    terminal: terminalZh as unknown as Record<string, string>,
    manuscript: manuscriptZh as unknown as Record<string, string>,
    overview: overviewZh as unknown as Record<string, string>,
    runs: runsZh as unknown as Record<string, string>,
    artifacts: artifactsZh as unknown as Record<string, string>,
    evidence: evidenceZh as unknown as Record<string, string>,
    budget: budgetZh as unknown as Record<string, string>,
    status: statusZh as unknown as Record<string, string>,
    intake: intakeZh as unknown as Record<string, string>,
    'grill-guide': grillGuideZh as unknown as Record<string, string>,
    trajectory: trajectoryZh as unknown as Record<string, string>,
    topology: topologyZh as unknown as Record<string, string>,
    workspace: workspaceZh as unknown as Record<string, string>,
    pty: ptyZh as unknown as Record<string, string>,
    methodology: methodologyZh as unknown as Record<string, string>,
  },
  en: {
    common: commonEn as unknown as Record<string, string>,
    standalone: standaloneEn as unknown as Record<string, string>,
    shell: shellEn as unknown as Record<string, string>,
    terminal: terminalEn as unknown as Record<string, string>,
    manuscript: manuscriptEn as unknown as Record<string, string>,
    overview: overviewEn as unknown as Record<string, string>,
    runs: runsEn as unknown as Record<string, string>,
    artifacts: artifactsEn as unknown as Record<string, string>,
    evidence: evidenceEn as unknown as Record<string, string>,
    budget: budgetEn as unknown as Record<string, string>,
    status: statusEn as unknown as Record<string, string>,
    intake: intakeEn as unknown as Record<string, string>,
    'grill-guide': grillGuideEn as unknown as Record<string, string>,
    trajectory: trajectoryEn as unknown as Record<string, string>,
    topology: topologyEn as unknown as Record<string, string>,
    workspace: workspaceEn as unknown as Record<string, string>,
    pty: ptyEn as unknown as Record<string, string>,
    methodology: methodologyEn as unknown as Record<string, string>,
  },
}

export const LOCALE_KEY = 'dsh.locale'

let activeLocale: Locale = resolveLocale()
let localeRevision = 0
const localeListeners = new Set<() => void>()

/**
 * Pure locale-choice logic (§13.2 / acceptance §8): persisted locale wins,
 * then the browser's regional locales (in preference order), then zh.
 * `saved` is the raw persisted value ('' or 'null' when absent), `candidates`
 * the browser locale list. Regional variants map to their base locale
 * (zh-CN → zh, en-US → en). Kept pure so unit tests can assert the
 * precedence without a DOM.
 */
export function pickLocale(saved: string | null, candidates: readonly string[]): Locale {
  if (saved === 'zh' || saved === 'en') return saved
  for (const c of candidates) {
    const base = c.toLowerCase().split('-')[0] ?? ''
    if (base === 'zh' || base === 'zh-hans') return 'zh'
    if (base === 'en') return 'en'
  }
  return 'zh'
}

/** Choice order (§13.2): persisted dsh.locale → navigator.languages →
 * navigator.language → zh; regional variants map to their base locale. */
export function resolveLocale(): Locale {
  let saved: string | null = null
  try {
    saved = localStorage.getItem(LOCALE_KEY)
  } catch { /* private mode */ }
  const candidates: string[] = []
  if (typeof navigator !== 'undefined') {
    if (Array.isArray(navigator.languages)) candidates.push(...navigator.languages)
    if (typeof navigator.language === 'string' && navigator.language !== '') candidates.push(navigator.language)
  }
  return pickLocale(saved, candidates)
}

export function getLocale(): Locale {
  return activeLocale
}

export function getLocaleRevision(): number {
  return localeRevision
}

export function subscribeLocale(fn: () => void): () => void {
  localeListeners.add(fn)
  return () => { localeListeners.delete(fn) }
}

export function setLocale(locale: Locale): void {
  activeLocale = locale
  localeRevision += 1
  try { localStorage.setItem(LOCALE_KEY, locale) } catch { /* private mode */ }
  try { document.documentElement.lang = locale } catch { /* sandboxed */ }
  for (const fn of [...localeListeners]) fn()
  // dsh-web i18n §13.4: every open modal re-opens in the new locale; the
  // shell listener above re-paints tabs/header and re-renders panels.
  relocalizeOpenOverlays()
}

/* ─────────────────────── missing-key reporting (dev) ─────────────────────── */

/** One fully-missing key (absent from every dictionary) at runtime. */
export interface MissingKeyReport { namespace: string; key: string; locale: Locale }

export type MissingKeyReporter = (report: MissingKeyReport) => void

/** Injectable collector — tests capture runtime misses without a console. */
let missingKeyReporter: MissingKeyReporter | null = null
/** Per-key dedupe for the dev console warning (the reporter sees every miss). */
const warnedMissingKeys = new Set<string>()

export function setMissingKeyReporter(reporter: MissingKeyReporter | null): void {
  missingKeyReporter = reporter
}

export function resetMissingKeyWarnings(): void {
  warnedMissingKeys.clear()
}

/**
 * Dev-mode probe for Node/Vitest. The shipped browser client is a CJS
 * ModuleLoader bundle, so it deliberately does not inspect import.meta.env;
 * parity and injected-reporting remain the browser/build authorities.
 */
export function isLocaleDevMode(): boolean {
  try {
    if (typeof process !== 'undefined' && process.env?.NODE_ENV !== 'production') return true
  } catch { /* sandboxed */ }
  return false
}

function notifyMissingKey(namespace: string, key: string, locale: Locale): void {
  missingKeyReporter?.({ namespace, key, locale })
  const uid = `${namespace}.${key}`
  if (warnedMissingKeys.has(uid)) return
  warnedMissingKeys.add(uid)
  if (isLocaleDevMode()) {
    const hint = namespace === 'common' ? 'locales/common.ts' : `locales/${namespace}.ts`
    // eslint-disable-next-line no-console
    console.warn(`[dsh-scholar i18n] missing key "${namespace}.${key}" (locale=${locale}); add it to ${hint} (zh/en parity required)`)
  }
}

export function t(namespace: string, key: string, params?: Record<string, string>): string {
  const active = DICTS[activeLocale]?.[namespace] ?? {}
  const zhNs = DICTS.zh?.[namespace] ?? {}
  const activeCommon = DICTS[activeLocale]?.common ?? {}
  const zhCommon = DICTS.zh.common ?? {}
  const found = active[key] ?? zhNs[key] ?? activeCommon[key] ?? zhCommon[key]
  if (found === undefined) {
    notifyMissingKey(namespace, key, activeLocale)
    return key
  }
  let text = found
  if (params !== undefined) {
    for (const [name, value] of Object.entries(params)) {
      text = text.replaceAll(`{${name}}`, value)
    }
  }
  return text
}

/* ─────────────────── open-overlay rebuild registry (§13.4) ─────────────────── */

/**
 * Modals register their overlay + a reopen closure when they mount. On
 * locale switch setLocale() re-runs every registration whose overlay is
 * still connected (registrations for overlays the user already closed are
 * pruned). The overlay type is structural (`{ isConnected: boolean }`) so
 * Node-level tests can register fakes without a DOM.
 */
export interface OverlayRegistration {
  overlay: { isConnected: boolean } | null
  rebuild: () => void
}

const overlayRebuilds = new Map<number, OverlayRegistration>()
let nextOverlayId = 1

/** Register an open overlay for locale-switch rebuild; returns the id. */
export function registerOverlayRebuild(overlay: { isConnected: boolean } | null, rebuild: () => void): number {
  const id = nextOverlayId
  nextOverlayId += 1
  overlayRebuilds.set(id, { overlay, rebuild })
  return id
}

export function unregisterOverlayRebuild(id: number): void {
  overlayRebuilds.delete(id)
}

/** Rebuild every still-open overlay in the current locale (prunes stale
 *  registrations); returns the number of overlays rebuilt. */
export function relocalizeOpenOverlays(): number {
  let rebuilt = 0
  for (const [id, reg] of [...overlayRebuilds]) {
    if (reg.overlay !== null && reg.overlay.isConnected !== true) {
      overlayRebuilds.delete(id)
      continue
    }
    rebuilt += 1
    reg.rebuild()
  }
  return rebuilt
}

/** Static check: zh/en key sets must be exactly equal per namespace.
 * Returns the list of violations (empty when parity holds). */
export function localeParityReport(): string[] {
  const violations: string[] = []
  for (const ns of Object.keys(DICTS.zh)) {
    const zhKeys = Object.keys(DICTS.zh[ns] ?? {}).sort()
    const enKeys = Object.keys(DICTS.en[ns] ?? {}).sort()
    const onlyZh = zhKeys.filter(k => !enKeys.includes(k))
    const onlyEn = enKeys.filter(k => !zhKeys.includes(k))
    if (onlyZh.length === 0 && onlyEn.length === 0) continue
    const detail = [
      ...onlyZh.map(k => `  zh-only: ${k}`),
      ...onlyEn.map(k => `  en-only: ${k}`),
    ].join('\n')
    violations.push(`i18n parity violation in namespace "${ns}":\n${detail}`)
  }
  return violations
}

/** Dev-mode warning + hard failure (acceptance §8: missing keys warn in
 * development and fail the build/CI). */
export function assertLocaleParity(): void {
  const violations = localeParityReport()
  if (violations.length === 0) return
  const msg = violations.join('\n')
  if (isLocaleDevMode()) {
    // eslint-disable-next-line no-console
    console.warn('[dsh-scholar i18n] ' + msg)
  }
  throw new Error(msg)
}
