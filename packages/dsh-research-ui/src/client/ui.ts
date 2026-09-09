/** Design system + DOM helpers shared by all panels and modals. */
import { getLocale, t } from './i18n/index'
import type { ContextMenuItem } from './types'
import { notifPersist } from './state'
import { state } from './state'

/* ─────────────────────────── design system ─────────────────────────── */

export const STATUS_META: Record<string, { tone: string }> = {
  // Status pill tones mirror the kernel's raw status ENUMS. Display text is
  // i18n'd via statusLabel() (status namespace, zh/en parity); unknown
  // enum/wire statuses fall back to the raw value verbatim
  // (acceptance-tests.md §8 line 115).
  // project phases
  DRAFT: { tone: 'slate' },
  SCOPED: { tone: 'blue' },
  SURVEYING: { tone: 'cyan' },
  IDEATING: { tone: 'violet' },
  IDEA_APPROVED: { tone: 'green' },
  BASELINE_REPRO: { tone: 'amber' },
  CONTRACT_APPROVED: { tone: 'green' },
  EXPERIMENTING: { tone: 'blue' },
  EVIDENCE_READY: { tone: 'cyan' },
  WRITING: { tone: 'violet' },
  REVIEWING: { tone: 'amber' },
  RELEASE_READY: { tone: 'amber' },
  RELEASED: { tone: 'green' },
  BLOCKED_GATE: { tone: 'red' },
  ARCHIVED: { tone: 'slate' },
  // gates
  pending: { tone: 'amber' },
  approved: { tone: 'green' },
  rejected: { tone: 'red' },
  // jobs
  queued: { tone: 'slate' },
  running: { tone: 'blue' },
  succeeded: { tone: 'green' },
  failed: { tone: 'red' },
  cancelled: { tone: 'slate' },
  retryable: { tone: 'amber' },
  // claims
  supported: { tone: 'green' },
  contradicted: { tone: 'red' },
  inconclusive: { tone: 'amber' },
  unverified: { tone: 'slate' },
  // generic
  none: { tone: 'slate' },
}

/**
 * Status display label in the CURRENT locale (status namespace). Known
 * statuses resolve through the dicts (zh/en parity is CI-enforced); an
 * unknown future enum falls back to the raw wire value verbatim (§8).
 */
export function statusLabel(status: string | undefined): string {
  if (status === undefined || status === '') return ''
  const key = `status.${status}`
  const text = t('status', key)
  return text === key ? status : text
}

/**
 * Pipeline step definitions in the CURRENT locale. A FUNCTION (not a
 * module-level snapshot) so a locale switch + panel re-render re-evaluates
 * every step label (acceptance §8 line 135 / §13.4).
 */
export function phasePipeline(): Array<[string, string]> {
  return [
    ['DRAFT', t('overview', 'overview.pipeline.draft')], ['SCOPED', t('overview', 'overview.pipeline.scoped')], ['SURVEYING', t('overview', 'overview.pipeline.survey')],
    ['IDEATING', t('overview', 'overview.pipeline.ideas')], ['IDEA_APPROVED', t('overview', 'overview.pipeline.ideaApproved')], ['CONTRACT_PENDING', t('overview', 'overview.pipeline.contract')],
    ['CONTRACT_APPROVED', t('overview', 'overview.pipeline.contractApproved')], ['BASELINE_REPRO', t('overview', 'overview.pipeline.baseline')], ['EXPERIMENTING', t('overview', 'overview.pipeline.run')], ['EVIDENCE_READY', t('overview', 'overview.pipeline.analyze')],
    ['WRITING', t('overview', 'overview.pipeline.write')], ['REVIEWING', t('overview', 'overview.pipeline.review')], ['RELEASE_READY', t('overview', 'overview.pipeline.package')],
    ['RELEASED', t('overview', 'overview.pipeline.released')],
  ]
}


export function fmtBytes(bytes: number | undefined): string {
  if (bytes === undefined || bytes === 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB']
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1)
  return `${(bytes / 1024 ** i).toFixed(i === 0 ? 0 : 1)} ${units[i]}`
}

export function fmtId(id: string | undefined, head = 12): string {
  if (id === undefined || id === '') return ''
  return id.length > head + 3 ? `${id.slice(0, head)}…` : id
}

export function shortType(type: string | undefined): string {
  if (type === undefined) return '—'
  return type.slice(0, 1).toUpperCase() + type.slice(1)
}

/* ─────────────────────────── DOM helpers ─────────────────────────── */

export function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag)
  if (className !== undefined) node.className = className
  if (text !== undefined) node.textContent = text
  return node
}

/** Status pill: colored dot + label, tone-driven. */
export function pill(status: string | undefined): HTMLElement {
  const meta = STATUS_META[status ?? ''] ?? { tone: 'slate' as const }
  const node = el('span', 'pill')
  node.style.cssText = `display:inline-flex;align-items:center;gap:5px;font:600 10px/1.6 ui-monospace,SFMono-Regular,Menlo,monospace;letter-spacing:.4px;color:var(--tone-${meta.tone});background:var(--tone-${meta.tone}-bg);border:1px solid var(--tone-${meta.tone});border-radius:99px;padding:1px 8px;white-space:nowrap`
  const dot = el('span')
  dot.style.cssText = `width:6px;height:6px;border-radius:50%;background:var(--tone-${meta.tone});box-shadow:0 0 5px var(--tone-${meta.tone})`
  node.appendChild(dot)
  node.appendChild(document.createTextNode(statusLabel(status)))
  return node
}


export const ACCENTS: Record<string, string> = {
  blue: '#4176e6', violet: '#7c3aed', green: '#16a34a', amber: '#b45309',
}
export const ACCENT_DARK: Record<string, string> = {
  blue: '#679efe', violet: '#a78bfa', green: '#34d399', amber: '#fbbf24',
}

/** Custom accent colour (dsh-web theming), persisted. */

/* ─────────────────────────── toast notifications ─────────────────────────── */


/** Resolve the panel's shadow root from anywhere. */
export function rootHost(): ShadowRoot | null {
  const hostEl = document.querySelector('#dsh-scholar-ui')
  return hostEl !== null ? hostEl.shadowRoot : null
}

/** Restore composer focus after an async rerender and place the caret at EOF. */
export function focusChatComposerAtEnd(): void {
  const previous = rootHost()?.querySelector('textarea.chat-composer-input') as HTMLTextAreaElement | null
  const expectedValue = state.chatDraft
  const attempt = (remaining: number): void => {
    const textarea = rootHost()?.querySelector('textarea.chat-composer-input') as HTMLTextAreaElement | null
    if (textarea !== null && textarea !== previous && textarea.value === expectedValue) {
      textarea.focus()
      textarea.setSelectionRange(textarea.value.length, textarea.value.length)
      return
    }
    if (remaining > 0) window.setTimeout(() => { attempt(remaining - 1) }, 50)
  }
  window.setTimeout(() => { attempt(20) }, 0)
}


export function trapFocus(overlay: HTMLElement, trigger: HTMLElement | null): () => void {
  const focusRoot = overlay.getRootNode()
  const onKey = (event: KeyboardEvent): void => {
    if (event.key !== 'Tab') return
    const focusables = ([...overlay.querySelectorAll('button, a[href], input, select, textarea, [tabindex]:not([tabindex="-1"])')] as HTMLElement[])
      .filter(element => !element.hasAttribute('disabled') && !element.hasAttribute('hidden'))
    if (focusables.length === 0) return
    const first = focusables[0]!
    const last = focusables[focusables.length - 1]!
    const root = overlay.getRootNode() as Document | ShadowRoot
    const active = root.activeElement ?? document.activeElement
    if (event.shiftKey && active === first) {
      event.preventDefault()
      last.focus()
    } else if (!event.shiftKey && active === last) {
      event.preventDefault()
      first.focus()
    }
  }
  overlay.addEventListener('keydown', onKey)
  return () => {
    overlay.removeEventListener('keydown', onKey)
    if (trigger?.isConnected === true) {
      trigger.focus()
      return
    }
    if (!(focusRoot instanceof ShadowRoot)) return
    const artifactId = trigger?.dataset.artifactId
    const replacement = artifactId === undefined
      ? null
      : [...focusRoot.querySelectorAll<HTMLElement>('[data-artifact-id]')]
          .find(element => element.dataset.artifactId === artifactId) ?? null
    const fallback = replacement
      ?? focusRoot.querySelector<HTMLElement>('[aria-current="page"], button:not([disabled]), [tabindex="0"]')
    fallback?.focus()
  }
}

/** dsh-web context menu: a right-click popup menu with keyboard support
 * (↑/↓ navigate, Enter picks, Esc closes, click-away closes). The scrim is
 * transparent so the page stays visible; Escape is also handled globally. */
export function openContextMenu(root: ShadowRoot, x: number, y: number, items: ContextMenuItem[]): void {
  const scrim = el('div', 'ctx-scrim')
  scrim.style.cssText = 'position:fixed;inset:0;z-index:10001;background:transparent'
  const menu = el('div')
  menu.setAttribute('role', 'menu')
  menu.setAttribute('aria-label', t('common', 'common.contextMenuAria'))
  menu.style.cssText = 'position:fixed;min-width:200px;background:var(--bg-2);border:1px solid var(--border-strong);border-radius:10px;padding:4px;box-shadow:0 12px 40px rgba(0,0,0,.35);z-index:10002;font:12px/1.4 system-ui,sans-serif;color:var(--text)'
  const menuButtons: HTMLButtonElement[] = []
  for (const it of items) {
    if (it.divider === true) {
      const sep = el('div')
      sep.style.cssText = 'height:1px;background:var(--border-2);margin:4px 6px'
      menu.appendChild(sep)
    }
    const btn = el('button')
    btn.setAttribute('role', 'menuitem')
    btn.style.cssText = 'display:flex;align-items:center;justify-content:space-between;gap:14px;width:100%;border:0;background:none;color:var(--text);text-align:left;padding:6px 10px;border-radius:7px;cursor:pointer;font:inherit'
    if (it.danger === true) btn.style.color = 'var(--tone-red)'
    const label = el('span', '', it.label)
    btn.appendChild(label)
    if (it.hint !== undefined) {
      const hint = el('span', 'muted', it.hint)
      hint.style.cssText = 'font-size:10px;max-width:120px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap'
      btn.appendChild(hint)
    }
    btn.onmouseenter = () => { btn.style.background = 'var(--bg-hover)' }
    btn.onmouseleave = () => { btn.style.background = 'none' }
    btn.onclick = () => { scrim.remove(); it.onPick() }
    menu.appendChild(btn)
    menuButtons.push(btn)
  }
  scrim.onclick = () => scrim.remove()
  scrim.oncontextmenu = (event) => { event.preventDefault(); scrim.remove() }
  scrim.appendChild(menu)
  root.appendChild(scrim)
  // Position near the cursor, flipping at the right/bottom viewport edges.
  const mw = menu.offsetWidth
  const mh = menu.offsetHeight
  menu.style.left = `${Math.max(4, Math.min(x, window.innerWidth - mw - 8))}px`
  menu.style.top = `${Math.max(4, Math.min(y, window.innerHeight - mh - 8))}px`
  // Keyboard navigation (dsh-web menu feel).
  let idx = 0
  menuButtons[0]?.focus()
  menu.addEventListener('keydown', (event) => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      idx = (idx + (event.key === 'ArrowDown' ? 1 : -1) + menuButtons.length) % menuButtons.length
      menuButtons[idx]?.focus()
    } else if (event.key === 'Escape') {
      event.preventDefault()
      scrim.remove()
    }
  })
}

/** Copy text to the clipboard with a toast confirmation and a fallback for
 * non-secure contexts (dsh-web "copy" affordance). */
export function copyText(text: string): void {
  const confirm = (): void => {
    const root = rootHost()
    if (root != null) {
      const preview = text.length > 48 ? `${text.slice(0, 48)}…` : text
      showToast(root, t('common', 'common.copiedToClipboard', { preview }))
    }
  }
  const fallback = (): void => {
    const ta = document.createElement('textarea')
    ta.value = text
    ta.style.cssText = 'position:fixed;opacity:0'
    document.body.appendChild(ta)
    ta.select()
    try { document.execCommand('copy') } catch { /* ignore */ }
    ta.remove()
    confirm()
  }
  if (navigator.clipboard !== undefined && navigator.clipboard.writeText !== undefined) {
    navigator.clipboard.writeText(text).then(confirm).catch(fallback)
  } else {
    fallback()
  }
}

/** dsh-web toast: a transient status pill bottom-center (2.4s), recorded.
 * Identical toasts inside a 60s window aggregate into a ×N counter (dsh-web
 * notification aggregation) instead of flooding the history. */
export function showToast(root: ShadowRoot | null, text: string): void {
  const now = Date.now()
  const last = state.notifHistory[state.notifHistory.length - 1]
  if (last !== undefined && last.text === text && (last.ts ?? 0) > now - 60000) {
    last.count = (last.count ?? 1) + 1
    last.time = new Date().toLocaleTimeString(getLocale())
  } else {
    state.notifHistory.push({ text, time: new Date().toLocaleTimeString(getLocale()), ts: now })
  }
  notifPersist()
  state.notifUnread += 1
  if (root == null) return
  const existing = root.querySelector('.toast')
  existing?.remove()
  const toast = el('div', 'toast', text)
  toast.setAttribute('role', 'status')
  toast.setAttribute('aria-live', 'polite')
  // dsh-web toast: click to dismiss it early.
  toast.style.cssText = 'position:fixed;left:50%;bottom:20px;transform:translateX(-50%);z-index:10001;background:var(--bg-2);border:1px solid var(--border-strong);color:var(--text);border-radius:99px;padding:6px 16px;font:600 11.5px/1.4 system-ui,sans-serif;box-shadow:0 8px 30px rgba(0,0,0,.3);cursor:pointer;max-width:70vw;overflow:hidden;text-overflow:ellipsis;white-space:nowrap'
  toast.onclick = () => toast.remove()
  root.appendChild(toast)
  setTimeout(() => toast.remove(), 2400)
}

/** dsh-web notification centre modal. */
