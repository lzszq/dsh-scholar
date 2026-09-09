/**
 * DSH Scholar — standalone GUI panel (browser half). Assembly entry:
 * apply() builds the shell, wires events, and dispatches to panel renderers
 * (panels/, chat/, sidebar/, terminal/, manuscript/, modals/). Rendering
 * lives inside a Shadow DOM; all interactive handlers attach via
 * addEventListener — no HTML-string sinks (design §15.4).
 * @module @dsh-scholar/research-ui/client
 */

import { t, getLocale, subscribeLocale, assertLocaleParity, registerOverlayRebuild } from './i18n/index'
import { chromeTabGroups, chromeTabs, chromeModelChoices, type ChromeModelCatalogEntry } from './i18n/chrome'
import { api, apiResult } from './api'
import { el, pill, copyText, ACCENTS, ACCENT_DARK, rootHost } from './ui'
import type { ProjectRow, Projection } from './types'
import { isTabKey, isTabVisible, navOrder, navShortcutIndex, parseDeepLink, reconcileVisibleNavigation, startActions, tabGroups, visibleTabKeys, type TabKey } from './nav'
import {
  DOCK_BOTTOM_MAX,
  DOCK_BOTTOM_MIN,
  DOCK_RIGHT_MAX,
  DOCK_RIGHT_MIN,
  createDockStore,
  effectiveDockPosition,
  mainTabAfterDock,
  updateDockLayout,
  type DockPosition,
} from './dock-layout'
import {
  state, readTheme, writeTheme, radiusValue, textureValue, accentColor,
  tabSave, tabLoad, autoRefreshEnabled,
  notifLoad, favProjectsLoad,
  chatActivateProject, chatDeactivateProject, chatDiscardProject, chatSyncActive, chatTrackedProjectIds,
  flushChatScopeCloseOutbox,
} from './state'
import { renderSidebar, sidebarSortLoad } from './sidebar'
import { disposeChatAttachments, renderChat } from './chat'
import { terminalDisconnect, renderTerminal } from './terminal'
import { renderPhase } from './panels/phase'
import { gateMutationPending, renderGates } from './panels/gates'
import { renderRuns } from './panels/runs'
import { closeArtifactPreview, renderArtifacts, retainArtifactPreviewForProject } from './panels/artifacts'
import { renderEvidence } from './panels/evidence'
import { renderBudget } from './panels/budget'
import { msCleanup, msMutationPending, renderManuscript } from './panels/manuscript'
import { renderTrajectory, stopTrajectoryStream } from './panels/trajectory'
import { renderTopology } from './panels/topology'
import { renderWorkspace, stopWorkspaceWatch } from './panels/workspace'
import { renderPty, ptyPanelDetachAll } from './panels/pty'
import {
  methodologyProjectionPath,
  type CompactMethodologyProjection,
} from './methodology-projection'
import { openSettingsModal } from './modals/settings'
import { openCommandsModal, openShortcutsModal } from './modals/commands'
import { openNotificationsModal, openSessionSearchModal, openProjectSwitcherModal } from './modals/search'
import { openNewProjectModal } from './modals/project'
import { openIntakeModal } from './modals/intake'
import xtermCss from '@xterm/xterm/css/xterm.css?inline'
import {
  RenderCoordinator,
  captureFocus,
  eventComesFromEditable,
  restoreFocus,
  shouldDeferBackgroundRefresh,
} from './focus-preservation'
import { ModelPreferenceCommit } from './model-preference'
import { chatTurnFlightStore } from './chat-turn-flight'
import { backgroundProjectScopesToProbe, projectIsAuthoritativelyGone, projectRenderTargetIsCurrent } from './project-liveness'

export { setStandaloneBridge } from './api'
/** Kernel reachability (dsh-web offline indicator). */
let kernelOnline = true
let lastKernelCheck = 0
/** First-paint skeleton (dsh-web loading feel). */
let booting = true

export interface ApplyOptions {
  /** Per-response CSP nonce supplied by the standalone bootstrap. */
  styleNonce?: string
}

/** Central a11y decorator for modal overlays (see apply). */
let modalObserver: MutationObserver | null = null

export function apply(options: ApplyOptions = {}): void {
  closeArtifactPreview()
  msCleanup(true)
  // dsh-web i18n: locale resolves before the first render (§13.4); the
  // document lang reflects the active locale and chrome re-paints on
  // change (subscription installed at the end of apply(), once every
  // paint target exists).
  assertLocaleParity()
  try { document.documentElement.lang = getLocale() } catch { /* sandboxed */ }
  const host = document.createElement('div')
  host.id = 'dsh-scholar-ui'
  host.style.cssText = 'position:fixed;inset:0;z-index:9999;font:14px/1.5 system-ui,sans-serif'
  const root = host.attachShadow({ mode: 'open' })
  // Theme: LIGHT is the default; persisted per browser. Accent: custom.
  host.dataset.theme = readTheme()
  host.style.setProperty('--panel-radius', radiusValue())
  host.dataset.texture = textureValue()
  // Custom accent (dsh-web theming): override the CSS variable directly.
  // Dark-theme accent variants (dsh-web theming): brighter in dark mode.
  const applyAccent = (): void => {
    const name = (Object.entries(ACCENTS).find(([, v]) => v === accentColor())?.[0] ?? 'blue')
    const c = host.dataset.theme === 'dark' ? (ACCENT_DARK[name] ?? accentColor()) : accentColor()
    // Custom properties live on the host element (ShadowRoot has no .style).
    host.style.setProperty('--accent', c)
    host.style.setProperty('--accent-soft', name === 'blue'
      ? (host.dataset.theme === 'dark' ? '#34415b' : '#edf3fe')
      : `${c}1f`)
    host.style.setProperty('--accent-text', c)
  }
  applyAccent()

  // dsh-web a11y: every modal overlay gets role=dialog + aria-modal + a
  // label derived from its header. One central observer keeps new modals
  // compliant automatically (Escape already closes .overlay globally).
  if (modalObserver !== null) modalObserver.disconnect()
  modalObserver = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      for (const node of mutation.addedNodes) {
        if (!(node instanceof HTMLElement)) continue
        const overlays = node.classList.contains('overlay') ? [node] : [...node.querySelectorAll('.overlay')]
        for (const overlay of overlays) {
          overlay.setAttribute('role', 'dialog')
          overlay.setAttribute('aria-modal', 'true')
          const header = overlay.querySelector('.modal-header')
          const label = header?.textContent?.replace('×', '').trim()
          overlay.setAttribute('aria-label', label !== undefined && label !== '' ? label : t('shell', 'shell.dialog.ariaFallback'))
        }
      }
    }
  })
  modalObserver.observe(root, { childList: true, subtree: true })

  const style = el('style')
  if (typeof options.styleNonce === 'string' && options.styleNonce !== '') {
    style.nonce = options.styleNonce
  }
  style.textContent = `${xtermCss}

:host { all: initial; }
/* Design tokens — LIGHT is the default theme. */
:host { color-scheme: light; }
:host([data-theme="dark"]) { color-scheme: dark; }
:host {
  --bg: #ffffff; --bg-2: #ffffff; --bg-3: #f9fafb;
  --bg-input: #ffffff; --bg-hover: rgba(38,49,72,.06);
  --border: rgba(0,0,0,.10); --border-2: rgba(0,0,0,.04); --border-strong: rgba(0,0,0,.16);
  --text: #0f1115; --text-2: #61666b; --text-3: #81858c;
  --accent: #4176e6; --accent-soft: #edf3fe; --accent-text: #4176e6;
  --header-grad: #ffffff;
  --sidebar-fill: #f9fafb; --sidebar-selected: #ebeef2; --selector-fill: #f1f3f5; --bubble-bg: #edf3fe;
  --shadow: 0 0 1px rgba(0,0,0,.2),0 0 4px rgba(0,0,0,.02),0 12px 32px rgba(0,0,0,.08);
  --shadow-soft: 0 4px 10px rgba(0,0,0,.02),0 2px 4px rgba(0,0,0,.04);
  --tone-slate: #64748b; --tone-blue: #2563eb; --tone-cyan: #0891b2;
  --tone-violet: #7c3aed; --tone-green: #16a34a; --tone-amber: #b45309; --tone-red: #dc2626;
  --tone-slate-bg: #e8edf4; --tone-blue-bg: #dbe7fd; --tone-cyan-bg: #d5f1f6;
  --tone-violet-bg: #ece2fc; --tone-green-bg: #d9f2e2; --tone-amber-bg: #fbe9d0; --tone-red-bg: #fbe0de;
}
:host([data-theme="dark"]) {
  --bg: #151517; --bg-2: #232324; --bg-3: #1b1b1c;
  --bg-input: #2c2c2e; --bg-hover: rgba(255,255,255,.08);
  --border: rgba(255,255,255,.12); --border-2: rgba(255,255,255,.06); --border-strong: rgba(255,255,255,.20);
  --text: #f9fafb; --text-2: #cfd3d6; --text-3: #adb2b8;
  --accent: #679efe; --accent-soft: #34415b; --accent-text: #679efe;
  --header-grad: #151517;
  --sidebar-fill: #1b1b1c; --sidebar-selected: #35363a; --selector-fill: #1b1b1c; --bubble-bg: #2c2c2e;
  --shadow: 0 0 1px rgba(0,0,0,.24),0 4px 12px rgba(0,0,0,.06),0 16px 48px rgba(0,0,0,.16);
  --shadow-soft: none;
  --tone-slate: #8b93a7; --tone-blue: #4d9fff; --tone-cyan: #22d3ee;
  --tone-violet: #a78bfa; --tone-green: #34d399; --tone-amber: #fbbf24; --tone-red: #f87171;
  --tone-slate-bg: #232b3d; --tone-blue-bg: #1c3352; --tone-cyan-bg: #123a44;
  --tone-violet-bg: #31275a; --tone-green-bg: #1e3a2f; --tone-amber-bg: #3d2f14; --tone-red-bg: #4a1f24;
}

* { box-sizing: border-box; margin: 0; }
.panel { display:flex; flex-direction:column; height:100%; max-height:inherit; background:var(--bg); color:var(--text); border:0; border-radius:0; overflow:hidden; box-shadow:none; font:13px/1.5 system-ui,sans-serif; }
.header { display:flex; align-items:center; gap:8px; padding:14px 20px; background:var(--header-grad); border-bottom:1px solid var(--border); }
.header .logo { font-size:18px; filter:drop-shadow(0 0 6px var(--accent)); }
.header .title { font:700 15px/1 system-ui,sans-serif; color:var(--text); letter-spacing:.2px; }
.header .spacer { flex:1; }
.hbtn { border:1px solid var(--border); background:var(--bg-2); color:var(--text-2); border-radius:8px; padding:3px 9px; cursor:pointer; font:600 11px/1.6 system-ui,sans-serif; }
.hbtn:hover { background:var(--bg-hover); color:var(--text); border-color:var(--border-strong); }
.hbtn:active { transform:translateY(1px); }
.hbtn.ghost { border:0; background:none; color:var(--text-3); font-size:15px; padding:2px 6px; }
.hbtn.ghost:hover { color:var(--text); background:var(--bg-hover); }
.tabs { display:flex; gap:2px; padding:0 20px; background:var(--bg-3); border-bottom:1px solid var(--border); }
.tab { flex:1; border:0; background:none; color:var(--text-2); padding:12px 2px 11px; cursor:pointer; font:600 12px/1 system-ui,sans-serif; border-bottom:2px solid transparent; letter-spacing:.3px; }
.tab:hover { color:var(--text-2); }
.tab.active { color:var(--text); border-bottom-color:var(--accent); }
.tab.pinned { color:var(--tone-amber); }
.tab.pinned.active { color:var(--tone-amber); border-bottom-color:var(--tone-amber); }
.body { flex:1; overflow-y:auto; padding:18px 22px 14px; scrollbar-width:thin; scrollbar-color:var(--border) transparent; }
.body::-webkit-scrollbar { width:8px; }
.body::-webkit-scrollbar-thumb { background:var(--border); border-radius:4px; }
.picker { width:100%; margin-bottom:11px; background:var(--bg-input); color:var(--text); border:1px solid var(--border); border-radius:9px; padding:8px 11px; font:600 12px/1.4 system-ui,sans-serif; outline:none; }
.picker:focus { border-color:var(--accent); }
.section-label { font:700 10px/1.4 system-ui,sans-serif; color:var(--text-3); text-transform:uppercase; letter-spacing:1px; margin:14px 0 6px; }
.section-label:first-child { margin-top:0; }
.project-title { display:flex; align-items:center; gap:8px; margin-bottom:10px; }
.project-title .pname { font:700 13px/1.3 system-ui,sans-serif; color:var(--text); }
.project-title .pid { font:500 10px/1.4 ui-monospace,Menlo,monospace; color:var(--text-3); }
.empty { color:var(--text-3); font-size:11px; padding:10px 2px; font-style:italic; }
.card { background:var(--bg-2); border:1px solid var(--border); border-radius:10px; padding:10px 12px; margin:6px 0; }
.card.border-amber { border-color:var(--tone-amber); }
.card.border-red { border-color:var(--tone-red); }
.card.border-green { border-color:var(--tone-green); }
/* GUIDE-01 NextAction v2 cards (panels/overview.ts): tone classes ready /
   blocked / done drive the three-state visual language (audit #11). */
.nax.ready { border-color:var(--tone-green); }
.nax.blocked { border-color:var(--tone-amber); }
.nax.done { opacity:.55; border-color:var(--border); }
.nax-head .nax-code { font:600 9px/1.6 ui-monospace,SFMono-Regular,Menlo,monospace; letter-spacing:.4px; color:var(--tone-blue); background:var(--tone-blue-bg); border:1px solid var(--tone-blue); border-radius:6px; padding:1px 6px; white-space:nowrap; max-width:42%; overflow:hidden; text-overflow:ellipsis; }
.nax-title { font:600 12px/1.5 system-ui,sans-serif; color:var(--text); }
.nax-state { font:600 9.5px/1.6 ui-monospace,SFMono-Regular,Menlo,monospace; letter-spacing:.3px; border-radius:99px; padding:1px 8px; white-space:nowrap; flex-shrink:0; }
.nax-state-ready { color:var(--tone-green); background:var(--tone-green-bg); border:1px solid var(--tone-green); }
.nax-state-blocked { color:var(--tone-amber); background:var(--tone-amber-bg); border:1px solid var(--tone-amber); }
.nax-state-done { color:var(--tone-slate); background:var(--tone-slate-bg); border:1px solid var(--tone-slate); }
.nax-go-ready { border-color:var(--tone-green); color:var(--tone-green); background:var(--tone-green-bg); }
.error-banner { background:var(--tone-red-bg); border:1px solid var(--tone-red); color:var(--tone-red); border-radius:9px; padding:8px 10px; margin-bottom:8px; font-size:11px; word-break:break-all; }
.row { display:flex; align-items:center; gap:8px; }
.grow { flex:1; min-width:0; }
.muted { color:var(--text-2); font-size:11px; }
.mono { font-family:ui-monospace,Menlo,monospace; font-size:10.5px; }
.btn { border:0; border-radius:8px; padding:6px 14px; cursor:pointer; font:700 11.5px/1 system-ui,sans-serif; letter-spacing:.3px; }
.btn:active { transform:translateY(1px); }
.btn.approve { background:linear-gradient(180deg,#2f9e44,#238636); color:#fff; box-shadow:0 0 10px var(--tone-green); }
.btn.approve:hover { filter:brightness(1.12); }
.btn.reject { background:linear-gradient(180deg,#e03131,#c92a2a); color:#fff; box-shadow:0 0 8px var(--tone-red); }
.btn.reject:hover { filter:brightness(1.12); }
.btn.cancel { background:var(--tone-red-bg); border:1px solid var(--tone-red); color:var(--tone-red); border-radius:7px; padding:3px 10px; font-size:11px; }
.btn.cancel:hover { background:var(--tone-red-bg); }
.gate-row { display:flex; align-items:center; justify-content:space-between; gap:10px; padding:9px 0; border-bottom:1px dashed var(--border-2); }
.gate-row:last-child { border-bottom:0; }
.gate-actions { display:flex; gap:7px; flex-shrink:0; }
/* pipeline */
.pipeline { display:flex; gap:0; margin:4px 0 2px; }
.pstep { flex:1; display:flex; flex-direction:column; align-items:center; gap:5px; min-width:0; position:relative; }
.pstep .dot { width:11px; height:11px; border-radius:50%; background:var(--bg-3); border:2px solid var(--border); z-index:1; transition:all .2s; }
.pstep.done .dot { background:var(--tone-green-bg); border-color:var(--tone-green); box-shadow:0 0 6px var(--tone-green); }
.pstep.done .dot::after { content:'✓'; position:absolute; top:-9px; font-size:8px; color:var(--tone-green); }
.pstep.current .dot { background:var(--accent); border-color:var(--accent); box-shadow:0 0 8px var(--accent); animation:pulse 1.6s ease-in-out infinite; }
.pstep .lbl { font:600 8px/1 ui-monospace,Menlo,monospace; color:var(--text-3); letter-spacing:.2px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; max-width:100%; }
.pstep.done .lbl, .pstep.current .lbl { color:var(--text-2); }
.pstep.current .lbl { color:var(--accent-text); }
.pipeline .pstep + .pstep::before { content:''; position:absolute; top:4px; right:50%; width:100%; height:2px; background:var(--border); z-index:0; }
.pipeline .pstep.done + .pstep::before, .pipeline .pstep.done.done + .pstep::before { background:linear-gradient(90deg,var(--tone-green),var(--border)); }
.pipeline .pstep.current + .pstep::before { background:linear-gradient(90deg,var(--accent),var(--border)); }
@keyframes pulse { 0%,100% { box-shadow:0 0 4px var(--accent); } 50% { box-shadow:0 0 12px var(--accent); } }
.pipeline-wrap { background:var(--bg-3); border:1px solid var(--border); border-radius:10px; padding:12px 8px 8px; margin-bottom:4px; }
/* metrics / budget */
.budget-row { display:flex; align-items:center; gap:9px; padding:5px 0; }
.budget-row .blabel { width:86px; color:var(--text-2); font-size:11px; flex-shrink:0; }
.budget-track { flex:1; height:7px; background:var(--bg-3); border-radius:99px; overflow:hidden; }
.budget-fill { height:100%; border-radius:99px; transition:width .3s; }
.budget-val { width:120px; text-align:right; color:var(--text); font:600 11px/1 ui-monospace,Menlo,monospace; flex-shrink:0; }
.count-chips { display:flex; flex-wrap:wrap; gap:6px; margin-top:8px; }
.chip { display:inline-flex; align-items:center; gap:5px; background:var(--bg-input); border:1px solid var(--border); border-radius:99px; padding:3px 9px; font-size:10.5px; color:var(--text-2); }
.chip b { color:var(--text); font-weight:700; }
/* evidence */
.evidence-card { background:var(--bg-2); border:1px solid var(--border); border-radius:10px; padding:10px 12px; margin:6px 0; }
.evidence-metric { font:700 15px/1 ui-monospace,Menlo,monospace; color:var(--text); }
.evidence-delta { font:600 11px/1 ui-monospace,Menlo,monospace; }
.stamp { margin-top:10px; color:var(--text-3); font-size:10px; text-align:right; font-family:ui-monospace,Menlo,monospace; }
/* preview modal */
.overlay { position:fixed; inset:0; background:rgba(10,15,30,.55); z-index:10000; display:flex; align-items:center; justify-content:center; padding:40px; }
.modal { background:var(--bg-2); border:1px solid var(--border); border-radius:12px; max-width:740px; max-height:72vh; overflow:auto; padding:14px 16px; color:var(--text); font:12px/1.5 system-ui,sans-serif; box-shadow:0 20px 70px rgba(10,15,30,.4); }
.modal-header { font:700 12px/1.4 system-ui,sans-serif; margin-bottom:10px; display:flex; justify-content:space-between; align-items:center; gap:10px; }
.modal pre { white-space:pre-wrap; word-break:break-all; font-family:ui-monospace,Menlo,monospace; font-size:11px; margin:0; color:var(--text); }
.modal img, .modal embed { max-width:100%; max-height:60vh; background:#fff; border-radius:8px; }
.warn { background:var(--tone-red-bg); color:var(--tone-red); border-radius:8px; padding:7px 10px; margin-top:8px; font-size:11px; }
.dl { color:var(--accent); text-decoration:underline; font-size:11px; }
.artifact-row { display:flex; align-items:center; gap:8px; padding:6px 8px; border-bottom:1px dashed var(--border-2); cursor:pointer; border-radius:6px; }
.artifact-row:hover { background:var(--bg-hover); }
.artifact-row:last-child { border-bottom:0; }
.artifact-kind { font:600 9.5px/1.6 ui-monospace,Menlo,monospace; color:var(--text-2); background:var(--bg-3); border:1px solid var(--border); border-radius:5px; padding:1px 6px; flex-shrink:0; }
/* dsh-web-style layout: left project sidebar + a main/dock work area. */
.panel.row { flex-direction:row; align-items:stretch; gap:0; }
.workspace-shell { flex:1; display:flex; min-width:0; min-height:0; height:100%; overflow:hidden; }
.workspace-shell[data-dock-position="right"] { flex-direction:row; }
.workspace-shell[data-dock-position="bottom"] { flex-direction:column; }
.main { flex:1; display:flex; flex-direction:column; min-width:0; min-height:0; height:100%; overflow:hidden; }
.dock-surface { flex:none; display:flex; flex-direction:column; min-width:0; min-height:0; overflow:hidden; background:var(--bg); }
.workspace-shell[data-dock-position="right"] .dock-surface { width:min(var(--dock-right-size,420px),calc(100% - 280px)); border-left:1px solid var(--border); }
.workspace-shell[data-dock-position="bottom"] .dock-surface { height:min(var(--dock-bottom-size,320px),calc(100% - 180px)); border-top:1px solid var(--border); }
.dock-surface[hidden],.dock-resizer[hidden] { display:none; }
.dock-resizer { flex:none; position:relative; z-index:8; background:transparent; touch-action:none; }
.workspace-shell[data-dock-position="right"] .dock-resizer { width:6px; margin-left:-3px; margin-right:-3px; cursor:col-resize; }
.workspace-shell[data-dock-position="bottom"] .dock-resizer { height:6px; margin-top:-3px; margin-bottom:-3px; cursor:row-resize; }
.dock-resizer::after { content:''; position:absolute; border-radius:99px; background:var(--border-strong); opacity:0; transition:opacity .12s; }
.workspace-shell[data-dock-position="right"] .dock-resizer::after { width:2px; inset:6px 2px; }
.workspace-shell[data-dock-position="bottom"] .dock-resizer::after { height:2px; inset:2px 6px; }
.dock-resizer:hover::after,.dock-resizer:focus-visible::after,.dock-resizer.dragging::after { opacity:1; background:var(--accent); }
.dock-header { flex:none; min-height:42px; display:flex; align-items:center; gap:6px; padding:6px 8px; background:var(--bg-3); border-bottom:1px solid var(--border-2); }
.dock-title { min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; color:var(--text); font:600 12px/18px system-ui,sans-serif; }
.dock-panel-picker { min-width:0; flex:1; height:30px; border:1px solid var(--border); border-radius:8px; padding:2px 26px 2px 8px; background:var(--bg-input); color:var(--text); font:500 11px/18px system-ui,sans-serif; }
.dock-header-actions { flex:none; display:flex; align-items:center; gap:2px; }
.dock-action { min-width:28px; min-height:28px; padding:2px 6px; }
.dock-action[aria-pressed="true"] { color:var(--accent-text); background:var(--accent-soft); }
.dock-body { flex:1; min-width:0; min-height:0; overflow:auto; padding:12px; scrollbar-gutter:stable; }
.dock-body .project-title { position:relative; top:auto; margin:-12px -12px 12px; padding:8px 12px; }
.dock-body .view-intro { margin-bottom:12px; }
.dock-body .view-description,.dock-body .view-group { display:none; }
.dock-body.chat-active { display:flex; flex-direction:column; overflow:hidden; padding-bottom:0; }
.dock-body.chat-active > .project-title,.dock-body.chat-active > .view-intro { flex:none; }
.dock-body.chat-active > .chat-shell { flex:1; height:auto; min-height:0; }
.dock-body.chat-active > .stamp { display:none; }
.dock-chat-dock { padding:8px 12px 10px; }
.view-actions { display:flex; align-items:center; flex-wrap:wrap; justify-content:flex-end; gap:5px; }
.view-actions .hbtn { white-space:nowrap; }
.sidebar { width:230px; flex-shrink:0; display:flex; flex-direction:column; background:var(--bg-3); border-right:1px solid var(--border); overflow:hidden; }
.sidebar-head { display:flex; align-items:center; justify-content:space-between; padding:12px 14px; border-bottom:1px solid var(--border); }
.sidebar-title { font:700 11px/1 system-ui,sans-serif; color:var(--text-2); letter-spacing:.8px; text-transform:uppercase; }
.sidebar-new { border:1px solid var(--border); background:var(--bg-2); color:var(--text); border-radius:8px; padding:3px 10px; cursor:pointer; font:600 11px/1.6 system-ui,sans-serif; }
.sidebar-new:hover { background:var(--bg-hover); border-color:var(--border-strong); }
.sidebar-list { flex:1; overflow-y:auto; padding:6px; scrollbar-width:thin; scrollbar-color:var(--border) transparent; }
.ws-item { display:flex; align-items:center; gap:8px; width:100%; border:0; background:none; color:var(--text); text-align:left; padding:8px 10px; border-radius:8px; cursor:pointer; margin-bottom:2px; }
.ws-item:hover { background:var(--bg-hover); }
.ws-item.active { background:var(--accent-soft); box-shadow:inset 2px 0 0 var(--accent); }
.ws-dot { width:8px; height:8px; border-radius:50%; flex-shrink:0; background:var(--tone-slate); }
.ws-name { flex:1; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; font:600 12px/1.3 system-ui,sans-serif; }
.ws-status { font:600 8.5px/1 ui-monospace,Menlo,monospace; color:var(--text-3); letter-spacing:.3px; flex-shrink:0; }
.ws-rename { color:var(--text-3); font-size:12px; padding:0 4px; cursor:pointer; flex-shrink:0; }
.ws-rename:hover { color:var(--accent); }
.ws-item:hover .ws-rename { display:inline; }
.ws-item:hover .ws-item > span[style*="display:none"] { display:flex; }
.ws-item.blocked { border:1px solid var(--tone-red); background:var(--tone-red-bg); }
.ws-item.blocked .ws-name { color:var(--tone-red); font-weight:700; }
.ws-item.selected { outline:1px solid var(--accent); background:var(--accent-soft); }
.ws-check { font-size:12px; color:var(--text-2); flex-shrink:0; }
.sidebar-foot { padding:10px 12px; border-top:1px solid var(--border); color:var(--text-3); font-size:10px; }
.sidebar.collapsed { width:44px; }
.sidebar.collapsed .sidebar-head { justify-content:center; padding:12px 6px; }
.sidebar.collapsed .sidebar-title, .sidebar.collapsed .sidebar-new, .sidebar.collapsed .sidebar input,
.sidebar.collapsed .ws-name, .sidebar.collapsed .ws-status, .sidebar.collapsed .sidebar-foot { display:none; }
.sidebar.collapsed .ws-item { justify-content:center; padding:8px 0; }
.sidebar.collapsed .ws-dot { width:10px; height:10px; }
.main.expanded { flex:1; }
/* dsh-web background texture preferences. */
:host([data-texture="grid"]) .panel { background-image: linear-gradient(var(--border-2) 1px, transparent 1px), linear-gradient(90deg, var(--border-2) 1px, transparent 1px); background-size: 22px 22px; }
:host([data-texture="dots"]) .panel { background-image: radial-gradient(var(--border-2) 1px, transparent 1px); background-size: 18px 18px; }
/* dsh-web a11y: visible keyboard focus everywhere. */
:host(:focus-visible), .panel :focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; border-radius: 4px; }
/* dsh-web mobile: full-viewport panel, scrollable tabs, compact chrome. */
@media (max-width: 640px) {
  :host { position: fixed; inset: 0; }
  .panel { border-radius: 0; border: 0; }
  .sidebar { width: 180px; }
  .sidebar.collapsed { width: 36px; }
  .tabs { overflow-x: auto; }
  .tab { flex: 0 0 auto; padding-left: 10px; padding-right: 10px; }
  .header .hbtn { padding-left: 6px; padding-right: 6px; }
  .header select.picker { display: none; }
  .body { padding: 12px 10px 8px; }
  .chat-table { font-size: 9.5px; }
}

/* DSH Web visual baseline: the same surfaces, type rhythm and conversation chrome. */
.panel { border:0; letter-spacing:0; font-family:-apple-system,BlinkMacSystemFont,'Segoe UI','PingFang SC','Hiragino Sans GB','Microsoft YaHei','Helvetica Neue',Helvetica,Arial,sans-serif; }
.mono,.project-title .pid,.stamp,.modal pre { font-family:'SF Mono','JetBrains Mono','Fira Code',Consolas,'Liberation Mono',Menlo,Courier,'PingFang SC','Microsoft YaHei'; }
.body input[type="text"] { border-radius:22px !important; padding:8px 14px !important; font:400 13px/20px -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif !important; }
.header { flex:none; min-height:48px; gap:10px; padding:8px 28px 4px 20px; border-bottom:0; box-shadow:none; position:sticky; top:0; z-index:6; }
.brand { display:flex; align-items:center; gap:8px; min-width:0; }
.brand-mark { width:auto; height:auto; display:inline; flex:0 0 auto; border-radius:0; background:none; color:var(--text); box-shadow:none; font:700 17px/20px -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif; letter-spacing:-.05em; }
.brand-copy { display:flex; align-items:baseline; flex-direction:row; gap:6px; min-width:0; }
.header .title { font:500 14px/20px -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif; letter-spacing:0; }
.brand-subtitle { color:var(--text-3); font:400 12px/18px -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif; text-transform:none; letter-spacing:0; white-space:nowrap; }
.header-actions { display:flex; align-items:center; justify-content:flex-end; gap:4px; min-width:0; }
.kernel-dot { width:7px; height:7px; border-radius:50%; display:inline-block; flex:0 0 auto; box-shadow:none; }
.mode-badge { display:inline-flex; align-items:center; gap:6px; height:28px; padding:0 8px; border:0; border-radius:8px; color:var(--text-2); background:transparent; font:500 12px/18px -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif; white-space:nowrap; }
.mode-badge::before { content:''; width:6px; height:6px; border-radius:50%; background:var(--tone-green); box-shadow:none; }
.hbtn { min-height:28px; border-color:transparent; border-radius:8px; padding:3px 8px; background:transparent; color:var(--text-2); font:500 12px/18px -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif; letter-spacing:0; box-shadow:none; transition:background-color .1s cubic-bezier(.4,0,.2,1),color .1s cubic-bezier(.4,0,.2,1),opacity .1s cubic-bezier(.4,0,.2,1); }
.hbtn:hover { transform:none; background:var(--bg-hover); color:var(--text); border-color:transparent; }
.hbtn:active { transform:none; }
.hbtn.icon-btn { min-width:28px; padding:3px 6px; font-size:15px; }
.chat-model-select { flex:none; width:auto; max-width:190px; min-height:28px; margin:0 4px 0 0; padding:3px 24px 3px 8px; border:0; border-radius:8px; background-color:var(--bg-hover); color:var(--text-2); font:500 11px/18px -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif; }
.tabs { flex:none; min-height:44px; align-items:stretch; gap:6px; padding:0 28px; overflow-x:auto; overflow-y:hidden; background:var(--bg); border-bottom:1px solid var(--border); scrollbar-width:none; }
.tabs::-webkit-scrollbar { display:none; }
.tab { position:relative; flex:0 0 auto; min-height:35px; padding:8px 0 11px; border:0; border-radius:0; color:var(--text-3); background:transparent; font:500 13px/16px -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif; letter-spacing:0; transition:color .1s cubic-bezier(.4,0,.2,1); }
.tab:hover { color:var(--text); background:transparent; }
.tab.active { color:var(--accent-text); background:transparent; border-bottom:3px solid var(--accent); }
.category-tab { display:flex; align-items:center; gap:8px; min-height:44px; padding:8px 12px 10px; }
.category-name { color:var(--text-3); font:600 10px/16px -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif; letter-spacing:.06em; text-transform:uppercase; }
.category-current { color:var(--text-2); font:500 13px/18px -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif; }
.category-caret { color:var(--text-3); font-size:10px; }
.category-tab.active .category-name,.category-tab.active .category-current { color:var(--accent-text); }
.body { min-height:0; background:var(--bg); padding:20px 24px 16px; scrollbar-gutter:stable; }
.body.chat-active { display:flex; flex-direction:column; overflow:hidden; padding-bottom:0; }
.body.chat-active > .project-title,
.body.chat-active > .view-intro { flex:none; }
.body.chat-active > .project-title { position:relative; top:auto; }
.body.chat-active > .chat-shell { flex:1; height:auto; min-height:0; }
.body.chat-active > .stamp { display:none; }
.body.chat-active > .welcome,
.body.chat-active > .skeleton { flex:1; min-height:0; overflow-y:auto; }
.project-title { position:sticky; top:-20px; z-index:2; margin:-20px -24px 20px; padding:8px 24px; min-height:44px; background:var(--bg); border-bottom:1px solid var(--border-2); backdrop-filter:none; }
.project-heading { display:flex; align-items:center; flex-direction:row; gap:5px; min-width:0; }
.project-kicker { color:var(--text-3); font:400 13px/20px -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif; text-transform:none; letter-spacing:0; }
.project-kicker::after { content:' /'; color:var(--text-3); }
.project-title .pname { font:500 14px/20px -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif; letter-spacing:0; }
.project-title .pid { margin-left:auto; background:transparent; border:1px solid transparent; }
.project-title .pid:hover { background:var(--bg-hover); color:var(--text-2); }
.view-intro { display:flex; align-items:flex-start; justify-content:space-between; gap:16px; margin:0 0 16px; }
.view-copy { min-width:0; }
.view-title { color:var(--text); font:500 18px/26px -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif; }
.view-description { margin-top:2px; color:var(--text-2); font:400 13px/20px -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif; }
.view-group { flex:none; margin-top:2px; padding:4px 8px; border-radius:8px; background:var(--bg-hover); color:var(--text-3); font:500 10px/16px -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif; text-transform:uppercase; letter-spacing:.05em; }
.section-label { margin:20px 0 8px; color:var(--text-3); font:500 12px/18px -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif; text-transform:none; letter-spacing:0; }
.card,.evidence-card { border-color:var(--border-2); border-radius:12px; padding:12px 16px; margin:8px 0; box-shadow:none; transition:background-color .1s cubic-bezier(.4,0,.2,1),border-color .1s cubic-bezier(.4,0,.2,1); }
.card:hover,.evidence-card:hover { border-color:var(--border); box-shadow:none; }
.card.border-amber { border-left:2px solid var(--tone-amber); border-top-color:var(--border-2); border-right-color:var(--border-2); border-bottom-color:var(--border-2); }
.card.border-red { border-left:2px solid var(--tone-red); border-top-color:var(--border-2); border-right-color:var(--border-2); border-bottom-color:var(--border-2); }
.card.border-green { border-left:2px solid var(--tone-green); border-top-color:var(--border-2); border-right-color:var(--border-2); border-bottom-color:var(--border-2); }
.btn { min-height:34px; border-radius:8px; padding:7px 14px; font:500 13px/20px -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif; letter-spacing:0; box-shadow:none; transition:background-color .1s cubic-bezier(.4,0,.2,1),opacity .1s cubic-bezier(.4,0,.2,1); }
.btn.primary { background:var(--accent); color:#fff; box-shadow:none; }
.btn.approve { background:var(--tone-green); box-shadow:none; }
.btn.reject { background:transparent; color:var(--tone-red); border:1px solid var(--tone-red); box-shadow:none; }
.btn.reject:hover { background:var(--tone-red-bg); }
.pipeline-wrap { overflow-x:auto; overflow-y:hidden; border-color:var(--border-2); border-radius:12px; padding:16px 12px 10px; background:var(--bg-2); box-shadow:none; scrollbar-width:thin; scrollbar-color:var(--border) transparent; scrollbar-gutter:stable; }
.pipeline { min-width:780px; }
.manuscript-layout { container-type:inline-size; min-width:0; }
.manuscript-layout-grid { display:grid; grid-template-columns:minmax(0,1fr); gap:12px; align-items:start; }
@container (min-width:900px) {
  .manuscript-layout-grid { grid-template-columns:160px minmax(250px,1fr) minmax(280px,1fr); }
}
.pstep { gap:7px; }
.pstep .dot { width:10px; height:10px; background:var(--bg-2); }
.pstep .lbl { font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif; font-size:9px; line-height:12px; letter-spacing:0; }
.pstep.done .dot { box-shadow:none; }
.pstep.current .dot { box-shadow:0 0 0 3px var(--accent-soft); animation:none; }
.budget-track { height:8px; background:var(--bg-3); box-shadow:0 0 0 1px var(--border-2) inset; }
.budget-fill { box-shadow:none !important; }
.chip { background:var(--bg-2); border-color:var(--border); border-radius:999px; padding:4px 10px; box-shadow:none; }
.artifact-kind { border:0; border-radius:6px; padding:2px 7px; background:var(--bg-3); color:var(--text-2); letter-spacing:0; }
.artifact-row { min-height:40px; padding:8px; border-bottom-style:solid; }
.empty { margin:8px 0; padding:20px 12px; border:0; border-radius:0; background:transparent; text-align:center; font-style:normal; }
.error-banner,.connection-banner { border:0; border-radius:8px; box-shadow:none; }
.overlay { background:rgba(0,0,0,.24); backdrop-filter:blur(2px); }
:host([data-theme="dark"]) .overlay { background:rgba(0,0,0,.5); }
.modal { border-color:var(--border-2); border-radius:24px; padding:0 24px 24px; box-shadow:var(--shadow); }
.modal-header { position:sticky; top:0; z-index:1; min-height:60px; margin:0 -24px 16px; padding:12px 14px 8px 24px; background:var(--bg-2); border-bottom:0; border-radius:24px 24px 0 0; font:500 16px/24px -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif; }
.sidebar { width:261px; padding:6px 12px; background:var(--sidebar-fill); border-right:1px solid var(--border-2); color:var(--text); transition:width .3s cubic-bezier(.4,0,.2,1); }
.sidebar-brand-row { flex:none; display:flex; align-items:center; gap:8px; height:60px; padding:8px 4px; margin-bottom:16px; overflow:hidden; }
.sidebar-wordmark { color:var(--text); font:700 18px/22px -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif; letter-spacing:-.06em; }
.sidebar-product { color:var(--text-3); font:500 12px/18px -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif; }
.sidebar-brand-row .sidebar-toggle { flex:none; margin-left:auto; }
.sidebar-head { min-height:36px; padding:0 0 0 12px; margin-bottom:4px; border-bottom:0; border-radius:12px; }
.sidebar-title { color:var(--text-3); font:400 13px/20px -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif; letter-spacing:0; text-transform:none; }
.sidebar-new { min-width:28px; min-height:28px; padding:3px 6px; border:0; border-radius:50%; background:transparent; color:var(--text-2); font:500 12px/18px -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif; }
.sidebar-new:hover { background:var(--bg-hover); border-color:transparent; }
.sidebar-search { flex:none; height:38px; margin:0 2px 12px !important; padding:0 14px !important; border:1px solid var(--border) !important; border-radius:24px !important; background:var(--selector-fill) !important; color:var(--text) !important; font:400 14px/20px -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif !important; }
.sidebar-groups { display:flex; gap:4px; margin:0 2px 8px; padding:3px; border-radius:12px; background:var(--selector-fill); }
.sidebar-filter { flex:1; min-height:28px; padding:3px 6px; border:0; border-radius:8px; background:transparent; color:var(--text-3); font:500 11px/18px -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif; cursor:pointer; }
.sidebar-filter:hover { background:var(--bg-hover); color:var(--text); }
.sidebar-filter.active { background:var(--bg-2); color:var(--text); box-shadow:var(--shadow-soft); }
.sidebar-list { padding:0 0 12px; scrollbar-gutter:stable; }
.ws-item { position:relative; min-height:54px; gap:6px; padding:7px 8px; margin-bottom:4px; border-radius:8px; }
.ws-item:hover { background:var(--bg-hover); }
.ws-item.active { background:var(--sidebar-selected); box-shadow:none; }
.ws-item.blocked { border:0; background:var(--tone-red-bg); }
.ws-dot { width:8px; height:8px; box-shadow:none; }
.ws-text { flex:1; min-width:0; display:flex; flex-direction:column; gap:2px; }
.ws-name { flex:none; font:400 14px/20px -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif; }
.ws-status { color:var(--text-3); font:400 10px/16px -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif; letter-spacing:0; }
.sidebar-foot { padding:8px 0 0; border-top:1px solid var(--border-2); }
.sidebar.collapsed { width:56px; padding:18px 10px 6px; }
.sidebar.collapsed .sidebar-brand-row { height:36px; justify-content:center; padding:0; margin-bottom:12px; }
.sidebar.collapsed .sidebar-wordmark,.sidebar.collapsed .sidebar-product,.sidebar.collapsed .sidebar-session-label,.sidebar.collapsed .sidebar-title,.sidebar.collapsed .sidebar-head > :not(:last-child),.sidebar.collapsed .sidebar-groups { display:none; }
.sidebar.collapsed .sidebar-brand-row .sidebar-toggle { margin-left:0; }
.sidebar.collapsed .sidebar-head { justify-content:center; padding:0; }
.sidebar.collapsed .sidebar-list { padding:0; }
.sidebar.collapsed .ws-item { width:36px; min-height:36px; justify-content:center; padding:0; }
.sidebar.collapsed .ws-item > :not(.ws-dot) { display:none; }
.welcome { min-height:calc(100vh - 132px); display:flex; flex-direction:column; align-items:center; justify-content:center; gap:12px; padding:40px 24px; text-align:center; }
.welcome-mark { width:auto; height:auto; display:inline; border-radius:0; background:none; color:var(--accent); box-shadow:none; font:500 24px/32px -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif; }
.welcome-eyebrow { color:var(--text-3); font:400 13px/20px -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif; text-transform:none; letter-spacing:0; }
.welcome h1 { margin:0; color:var(--text); font:500 26px/32px -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif; letter-spacing:0; }
.welcome-copy { max-width:560px; color:var(--text-2); font:400 14px/22px -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif; }
.welcome-steps { display:flex; justify-content:center; gap:8px; width:min(800px,100%); margin:8px 0 4px; text-align:left; }
.welcome-step { display:flex; align-items:center; gap:8px; min-height:32px; padding:6px 10px; border:0; border-radius:12px; background:var(--bg-hover); color:var(--text-2); box-shadow:none; font-size:12px; line-height:18px; }
.welcome-step-num { display:none; }
.chat-shell { display:flex; flex-direction:row; height:100%; min-height:420px; }
.chat-column { flex:1; display:flex; flex-direction:column; min-width:0; min-height:0; overflow:hidden; }
.chat-session-tabs { flex:none; display:flex; gap:8px; align-items:center; overflow-x:auto; flex-wrap:nowrap; max-width:100%; margin:0 -24px 8px; padding:0 24px 8px; border-bottom:1px solid var(--border-2); scrollbar-gutter:stable; }
.chat-search-row { flex:none; display:flex; align-items:center; gap:6px; margin-bottom:8px; overflow-x:auto; padding-bottom:2px; scrollbar-gutter:stable; }
.chat-stream-wrap { flex:1; display:flex; flex-direction:column; position:relative; min-height:0; overflow:hidden; }
.chat-stream { flex:1; min-height:0; overflow-y:auto; display:flex; flex-direction:column; gap:16px; padding:16px 24px 24px; scrollbar-gutter:stable; }
.chat-message { word-break:break-word; cursor:pointer; font:400 16px/24px -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif; }
.chat-message.user { align-self:flex-end; max-width:calc(100% - 88px); padding:10px 16px; border:0; border-radius:22px; background:var(--bubble-bg); color:var(--text); }
.chat-message.assistant { align-self:center; width:min(840px,100%); padding:0; border:0; border-radius:0; background:transparent; color:var(--text); }
.chat-message.error { align-self:center; width:min(840px,100%); padding:8px 12px; border:0; border-radius:8px; background:var(--tone-red-bg); color:var(--tone-red); }
.chat-message.selected { outline:2px solid var(--accent); outline-offset:4px; }
.chat-grill-turn-host { align-self:center; width:min(840px,100%); }
.chat-grill-turn-host:empty { display:none; }
.chat-grill-turn { width:100%; padding:14px 16px; border:1px solid var(--accent); border-radius:14px; background:var(--accent-soft); color:var(--text); }
.chat-running { align-self:center; width:min(840px,100%); display:flex; align-items:center; gap:8px; color:var(--text-2); font:400 14px/22px -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif; }
.chat-dock { flex:none; position:relative; z-index:4; width:100%; padding:8px 24px 12px; border-top:1px solid var(--border-2); background:var(--bg); }
.chat-dock[hidden] { display:none; }
.chat-quote { width:100%; max-width:840px; margin-left:auto; margin-right:auto; }
.chat-composer-row { flex:none; display:flex; align-items:flex-end; gap:8px; width:100%; max-width:840px; margin:0 auto; padding:0; }
.chat-composer { flex:1; display:flex; flex-direction:column; gap:8px; padding:10px 10px 8px 16px; border:1px solid var(--border); border-radius:20px; background:var(--bg-input); box-shadow:var(--shadow-soft); }
.chat-composer-input { width:100%; height:48px; min-height:48px; max-height:48px; padding:4px 0 0; resize:none; overflow-y:auto; border:0; outline:0; background:transparent; color:var(--text); font:400 16px/24px -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif; scrollbar-gutter:stable; }
.chat-composer-input::placeholder { color:var(--text-3); }
.chat-composer-actions { display:flex; align-items:center; justify-content:space-between; gap:12px; }
.chat-composer-tools { display:flex; align-items:center; gap:4px; min-width:0; }
.chat-attach-button { flex:none; padding:4px 10px; border-color:var(--accent); color:var(--accent); font-size:11px; font-weight:600; }
.chat-attach-hint { overflow:hidden; color:var(--text-3); font-size:10px; white-space:nowrap; text-overflow:ellipsis; }
.chat-send { flex:none; display:grid; place-items:center; width:34px; height:34px; padding:0; border:0; border-radius:999px; background:var(--accent); color:#fff; font:600 18px/1 -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif; cursor:pointer; }
.chat-send:hover { filter:brightness(1.08); }
.chat-send:disabled { opacity:.4; cursor:default; }
.chat-completions { position:absolute; left:50%; bottom:calc(100% - 8px); z-index:7; width:min(800px,calc(100% - 48px)); max-width:800px; margin:0 !important; transform:translateX(-50%); border-radius:12px !important; box-shadow:var(--shadow); }
.skeleton { display:flex; flex-direction:column; gap:12px; padding:18px; }
.skeleton-bar { height:14px; border-radius:7px; background:linear-gradient(90deg,var(--bg-3),var(--bg-hover),var(--bg-3)); background-size:200% 100%; animation:shimmer 1.5s linear infinite; }
@keyframes shimmer { to { background-position:-200% 0; } }
@media (max-width: 1024px) {
  .header-secondary,.mode-badge { display:none; }
  .sidebar { width:240px; }
  .chat-message.assistant,.chat-message.error,.chat-grill-turn-host { width:min(712px,100%); }
  .chat-composer-row { max-width:712px; }
}
@media (max-width: 720px) {
  .brand-subtitle,.header-command .long-label,.header-refresh .long-label,.header-notifications .long-label { display:none; }
  .header { padding:8px 10px; }
  .header-actions { gap:4px; }
  .tabs { padding-left:8px; padding-right:8px; overflow-x:auto; }
  .category-tab { padding-left:10px; padding-right:10px; }
  .body { padding:16px 12px 10px; }
  .project-title { position:relative; top:auto; margin:-16px -12px 14px; padding:11px 12px; flex-wrap:wrap; }
  .project-title .pid { width:100%; margin-left:0; }
  .chat-dock { padding:8px 12px 10px; }
  .chat-model-select { max-width:132px; }
  .welcome { min-height:calc(100vh - 120px); padding:32px 10px; }
  .welcome-steps { flex-direction:column; }
  .overlay { padding:14px; }
  .dock-title { display:none; }
  .dock-body { padding:10px; }
  .dock-body .project-title { margin:-10px -10px 10px; padding:8px 10px; }
}
/* UI-SIMPLE-01: Start 三卡 (acceptance §8 ui-start) */
.start-screen { min-height:calc(100vh - 132px); display:flex; flex-direction:column; align-items:center; justify-content:center; gap:10px; padding:40px 24px; text-align:center; }
.start-cards { display:flex; gap:12px; width:min(780px,100%); margin-top:14px; flex-wrap:wrap; justify-content:center; }
.start-card { flex:1 1 200px; min-width:190px; display:flex; flex-direction:column; gap:6px; align-items:flex-start; text-align:left; border:1px solid var(--border-2); border-radius:14px; background:var(--bg-2); padding:16px 18px; cursor:pointer; color:var(--text); box-shadow:var(--shadow-soft); transition:border-color .1s,transform .1s; }
.start-card:hover { border-color:var(--accent); transform:translateY(-1px); }
.start-card:focus-visible { outline:2px solid var(--accent); outline-offset:1px; }
.start-card-label { font:600 14px/1.4 -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif; }
.start-card-desc { color:var(--text-2); font:400 11.5px/1.6 -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif; }
/* Category menus keep every route inside its own information-architecture group. */
.more-menu { position:fixed; min-width:240px; background:var(--bg-2); border:1px solid var(--border-strong); border-radius:12px; padding:6px; box-shadow:0 12px 40px rgba(0,0,0,.35); z-index:10002; font:12px/1.4 system-ui,sans-serif; color:var(--text); display:flex; flex-direction:column; gap:2px; }
.more-item { display:flex; align-items:center; justify-content:space-between; gap:12px; width:100%; border:0; background:none; color:var(--text); text-align:left; padding:8px 10px; border-radius:8px; cursor:pointer; font:inherit; }
.more-item:hover { background:var(--bg-hover); }
.more-item.active { background:var(--accent-soft); color:var(--accent-text); }
.more-item .muted { font-size:10px; max-width:130px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
/* UI-SIMPLE-01: Settings progressive disclosure (acceptance §8 ui-settings) */
.settings-section { border:1px solid var(--border-2); border-radius:12px; margin:8px 0; background:var(--bg-3); overflow:hidden; }
.settings-section-head { display:flex; align-items:center; gap:8px; width:100%; border:0; background:none; color:var(--text); padding:10px 12px; cursor:pointer; font:600 12px/1.4 -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif; text-align:left; }
.settings-section-head:hover { background:var(--bg-hover); }
.settings-section-caret { color:var(--text-3); font-size:10px; transition:transform .15s; flex:none; }
.settings-section[data-open="true"] .settings-section-caret { transform:rotate(90deg); }
.settings-section-summary { margin-left:auto; color:var(--text-3); font:400 10px/1.4 -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif; max-width:55%; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.settings-section-body { display:none; padding:2px 12px 10px; border-top:1px solid var(--border-2); }
.settings-section[data-open="true"] .settings-section-body { display:block; }
.settings-row { display:flex; align-items:center; gap:9px; padding:6px 0; min-height:30px; }
.settings-row-label { width:120px; color:var(--text-2); font-size:11.5px; flex-shrink:0; }
.settings-row-slot { flex:1; min-width:0; display:flex; align-items:center; gap:8px; }
.settings-row-slot .mono { font-size:10.5px; word-break:break-all; }
/* CONFIG-01 dynamic field rows: stacked value + meta + description */
.settings-row-stack { align-items:flex-start; }
.settings-row-stack .settings-row-slot { flex-direction:column; align-items:stretch; gap:3px; padding:2px 0; }
.settings-field-value { font-size:11px; word-break:break-all; }
.settings-field-meta { display:flex; flex-wrap:wrap; gap:6px; margin-top:2px; }
.settings-chip { font:400 10px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace; color:var(--text-3); background:var(--bg-hover); border:1px solid var(--border-2); border-radius:6px; padding:0 6px; }
.settings-field-desc { color:var(--text-3); font-size:10.5px; line-height:1.5; }
.settings-readonly-note { display:flex; align-items:center; gap:10px; justify-content:space-between; border:1px dashed var(--border-2); border-radius:10px; padding:8px 12px; margin:8px 0; color:var(--text-2); font-size:11px; }
/* OCR-UI-01: grouped, responsive MinerU configuration; never reuse the
   single-row settings layout for a multi-field form. */
.settings-ocr-form { display:flex; flex-direction:column; gap:12px; min-width:0; padding:10px 0 2px; }
.settings-ocr-status { display:flex; align-items:flex-start; justify-content:space-between; gap:12px; min-width:0; }
.settings-ocr-copy { min-width:0; }
.settings-ocr-copy .settings-row-label { width:auto; margin-bottom:2px; color:var(--text); font-weight:600; }
.settings-ocr-group { display:flex; flex-direction:column; gap:10px; min-width:0; margin:0; padding:12px; border:1px solid var(--border-2); border-radius:12px; background:var(--bg-2); }
.settings-ocr-group-title { margin:0; color:var(--text); font:600 12px/1.4 -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif; }
.settings-ocr-grid,.settings-ocr-secret-grid { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:10px 12px; min-width:0; }
.settings-ocr-field { display:flex; flex-direction:column; gap:4px; min-width:0; }
.settings-ocr-field-label { color:var(--text-2); font-size:11.5px; }
.settings-ocr-field .field-input { width:100%; min-width:0; box-sizing:border-box; }
.settings-ocr-field .muted { font-size:10.5px; line-height:1.5; }
.settings-ocr-toggle { display:flex; align-items:center; gap:8px; width:max-content; max-width:100%; color:var(--text); font-size:11.5px; }
.settings-ocr-secret-grid { padding-top:2px; }
.settings-ocr-secret-grid[hidden] { display:none; }
.settings-ocr-help { color:var(--text-3); font-size:10.5px; line-height:1.5; }
.settings-ocr-footer { display:flex; flex-direction:column; align-items:flex-end; gap:4px; }
.settings-ocr-footer .settings-readonly-note { align-self:stretch; margin:0; }
.settings-ocr-save { min-width:132px; }
@media (max-width:720px) {
  .settings-ocr-grid,.settings-ocr-secret-grid { grid-template-columns:minmax(0,1fr); }
  .settings-ocr-status { flex-direction:column; }
  .settings-ocr-footer { align-items:stretch; }
  .settings-ocr-save { width:100%; }
}
`
  root.appendChild(style)

  const panel = el('div', 'panel')
  root.appendChild(panel)

  // The standalone workspace keeps the project navigator on the left. Every
  // research page can additionally occupy the presentation-only panel dock.
  const main = el('div', 'main')
  const sidebar = el('div', 'sidebar')
  const workspaceShell = el('div', 'workspace-shell')
  panel.classList.add('row')
  sidebar.setAttribute('role', 'navigation')
  sidebar.setAttribute('aria-label', t('shell', 'shell.sidebar.ariaLabel'))
  panel.appendChild(sidebar)
  panel.appendChild(workspaceShell)
  workspaceShell.appendChild(main)
  const dockStore = createDockStore({
    getItem: key => localStorage.getItem(key),
    setItem: (key, value) => { localStorage.setItem(key, value) },
  })
  let dockLayout = dockStore.load()
  const deactivatePanelTransport = (key: TabKey): void => {
    if (key === 'terminal' && state.terminalStatus !== 'idle') terminalDisconnect()
    else if (key === 'workspace') stopWorkspaceWatch()
    else if (key === 'trajectory') stopTrajectoryStream()
    else if (key === 'pty') ptyPanelDetachAll()
    else if (key === 'manuscript') msCleanup(true)
  }

  // ── header ──
  const header = el('div', 'header')
  const brand = el('div', 'brand')
  const brandMark = el('span', 'brand-mark', '')
  brand.appendChild(brandMark)
  const brandCopy = el('div', 'brand-copy')
  const brandName = el('span', 'title', '')
  const brandMeta = el('span', 'brand-subtitle', '')
  brandCopy.append(brandName, brandMeta)
  brand.appendChild(brandCopy)
  header.appendChild(brand)
  // dsh-web kernel status: live dot (green when the kernel answers, red
  // when the bridge is down; amber while checking). Tracked state lets the
  // locale paint re-evaluate the title without a new health probe.
  let kernelChecked = false
  let kernelOk = true
  let kernelInstance = ''
  const paintKernelDot = (): void => {
    kernelDot.style.background = !kernelChecked ? 'var(--tone-amber)' : (kernelOk ? 'var(--tone-green)' : 'var(--tone-red)')
    kernelDot.title = !kernelChecked
      ? t('shell', 'shell.kernel.status.checking')
      : (kernelOk
          ? t('shell', 'shell.kernelConnected', { instance: kernelInstance })
          : t('shell', 'shell.kernelUnreachableClick'))
    kernelDot.setAttribute('aria-label', t('shell', 'shell.kernel.status'))
  }
  const kernelDot = el('span', 'kernel-dot')
  kernelDot.style.cursor = 'pointer'
  kernelDot.onclick = () => { void openSettingsModal(root) }
  paintKernelDot()
  header.appendChild(kernelDot)
  const spacer = el('span', 'spacer')
  header.appendChild(spacer)
  const themeBtn = el('button', 'hbtn header-theme')
  themeBtn.setAttribute('aria-keyshortcuts', 'Control+Shift+T Meta+Shift+T')
  const paintTheme = (): void => {
    const dark = host.dataset.theme === 'dark'
    themeBtn.textContent = dark ? t('shell', 'shell.theme.light') : t('shell', 'shell.theme.dark')
    themeBtn.title = dark ? t('shell', 'shell.theme.switchLight') : t('shell', 'shell.theme.switchDark')
    themeBtn.setAttribute('aria-label', t('shell', 'shell.theme.toggle'))
  }
  themeBtn.onclick = () => {
    host.dataset.theme = host.dataset.theme === 'dark' ? 'light' : 'dark'
    writeTheme(host.dataset.theme)
    paintTheme()
    applyAccent()
  }
  paintTheme()
  const refresh = el('button', 'hbtn header-refresh')
  const refreshLabel = el('span', 'long-label', '')
  refresh.append(el('span', '', '↻'), refreshLabel)
  refresh.title = t('shell', 'shell.refresh.now')
  refresh.setAttribute('aria-label', t('common', 'common.action.refresh'))
  const commandsBtn = el('button', 'hbtn header-command')
  const commandsLabel = el('span', 'long-label', '')
  commandsBtn.append(el('span', '', '⌘K'), commandsLabel)
  commandsBtn.title = t('shell', 'shell.commands.titleAttr')
  commandsBtn.setAttribute('aria-keyshortcuts', 'Control+K Meta+K')
  commandsBtn.onclick = () => { openCommandsModal(root) }
  const shortcutsBtn = el('button', 'hbtn header-secondary', '')
  shortcutsBtn.onclick = () => { openShortcutsModal(root) }
  const bellBtn = el('button', 'hbtn header-notifications')
  const bellLabel = el('span', 'long-label', '')
  bellBtn.append(el('span', '', '○'), bellLabel)
  bellBtn.onclick = () => { openNotificationsModal(root) }
  const modeBadge = el('span', 'mode-badge')
  // dsh-web "Collapse sidebar": toggles the workspace sidebar width
  // (persisted, dsh-web layout memory).
  const SIDEBAR_KEY = 'dsh-scholar-ui-sidebar'
  let sidebarCollapsed = false
  try { sidebarCollapsed = localStorage.getItem(SIDEBAR_KEY) === 'collapsed' } catch { /* private mode */ }
  const sidebarPersist = (): void => {
    try { localStorage.setItem(SIDEBAR_KEY, sidebarCollapsed ? 'collapsed' : 'expanded') } catch { /* private mode */ }
  }
  const sidebarToggle = el('button', 'hbtn icon-btn sidebar-toggle', '‹')
  sidebarToggle.title = t('shell', 'shell.sidebar.toggle')
  sidebarToggle.setAttribute('aria-expanded', 'true')
  sidebarToggle.setAttribute('aria-label', t('shell', 'shell.sidebar.toggleAria'))
  sidebarToggle.onclick = () => {
    sidebarCollapsed = !sidebarCollapsed
    sidebarPersist()
    if (sidebar !== null) sidebar.classList.toggle('collapsed', sidebarCollapsed)
    if (main !== null) main.classList.toggle('expanded', sidebarCollapsed)
    sidebarToggle.textContent = sidebarCollapsed ? '›' : '‹'
    sidebarToggle.setAttribute('aria-expanded', String(!sidebarCollapsed))
    void render()
  }
  // Research-agent model seat. It belongs to the chat composer rather than
  // global header chrome; the server still persists it through /api/model.
  const modelSelect = el('select', 'chat-model-select')
  modelSelect.disabled = true
  const modelPreference = new ModelPreferenceCommit()
  let runtimeModels: ChromeModelCatalogEntry[] = []
  const syncModelSelectDisabled = (): void => {
    modelSelect.disabled = modelPreference.busy() || chatTurnFlightStore.anyActive()
  }
  modelSelect.onchange = () => {
    const chosen = modelSelect.value
    const commit = modelPreference.select(chosen, async value => {
      const saved = await api<{ ok?: boolean }>('/api/model', {
        method: 'PUT',
        body: JSON.stringify({ model: value }),
      })
      return saved?.ok === true
    })
    syncModelSelectDisabled()
    void commit.then(saved => {
      syncModelSelectDisabled()
      if (!saved) {
        modelSelect.value = modelPreference.acknowledged()
        modelSelect.title = t('shell', 'shell.model.error')
        setTimeout(() => { modelSelect.title = t('shell', 'shell.model.label') }, 3000)
      }
    })
  }
  const paintModelSelect = (): void => {
    const modelValue = modelSelect.value
    modelSelect.replaceChildren()
    for (const choice of chromeModelChoices(runtimeModels)) {
      const opt = el('option', '', choice.label)
      opt.value = choice.id
      opt.disabled = choice.disabled === true
      modelSelect.append(opt)
    }
    modelSelect.value = modelValue
    modelSelect.setAttribute('aria-label', t('shell', 'shell.model.ariaLabel'))
    modelSelect.title = t('shell', 'shell.model.label')
  }
  paintModelSelect()
  void api<{ ok?: boolean; model?: string; models?: ChromeModelCatalogEntry[] }>('/api/model').then(state => {
    if (state?.ok === true && typeof state.model === 'string') {
      runtimeModels = Array.isArray(state.models) ? state.models : []
      paintModelSelect()
      if (modelPreference.initialize(state.model)) modelSelect.value = state.model
    }
  }).catch(() => { /* keep auto default */ }).finally(() => {
    syncModelSelectDisabled()
  })
  const headerActions = el('div', 'header-actions')
  headerActions.append(modeBadge, commandsBtn, shortcutsBtn, bellBtn, themeBtn, refresh)
  header.appendChild(headerActions)
  main.appendChild(header)

  // ── category navigation ──
  // Every feature lives inside its semantic category. This keeps the top bar
  // compact without hiding unrelated routes behind a generic "More" bucket.
  const tabs = el('div', 'tabs')
  tabs.setAttribute('role', 'navigation')
  tabs.setAttribute('aria-label', t('shell', 'shell.tabs.ariaLabel'))
  const categoryButtons = new Map<number, HTMLButtonElement>()
  const syncHash = (tab: string): void => {
    try { history.replaceState(null, '', `#tab=${tab}`) } catch { /* sandboxed iframe */ }
  }
  const activateTab = (key: string): void => {
    if (!isTabVisible(key)) return
    // A page has one live renderer. Opening its full-page route first removes
    // the same page from the dock, avoiding duplicate Chat/PTY/TeX state.
    if (dockLayout.openPanel === key) {
      deactivatePanelTransport(key)
      dockLayout = updateDockLayout(dockLayout, { type: 'close' })
      dockStore.save(dockLayout)
    }
    state.activeTab = key
    tabSave()
    syncHash(key)
    void render()
  }
  const activateNavEntry = (entry: { key: string; kind?: string }): void => {
    if (entry.kind === 'modal') {
      openSettingsModal(root)
      return
    }
    activateTab(entry.key)
  }
  const openCategoryMenu = (groupIndex: number): void => {
    const group = chromeTabGroups()[groupIndex]
    const anchor = categoryButtons.get(groupIndex)
    if (group === undefined || anchor === undefined) return
    const scrim = el('div', 'ctx-scrim')
    scrim.style.cssText = 'position:fixed;inset:0;z-index:10001;background:transparent'
    const menu = el('div', 'more-menu category-menu')
    menu.setAttribute('role', 'menu')
    menu.setAttribute('aria-label', group.label)
    const appendEntry = (entry: { key: string; label: string; description: string; deepLink: string; kind?: string }): void => {
      const item = el('button', 'more-item')
      item.setAttribute('role', 'menuitem')
      item.dataset.categoryKey = entry.key
      item.dataset.deepLink = entry.deepLink
      item.id = `category-${entry.key}`
      const selected = entry.kind !== 'modal' && entry.key === state.activeTab
      item.classList.toggle('active', selected)
      if (selected) item.setAttribute('aria-current', 'page')
      const shortcut = navShortcutIndex(entry.key)
      if (shortcut >= 1 && shortcut <= 9) {
        item.title = t('shell', 'shell.tab.title', {
          label: entry.label,
          key: `Alt+${shortcut}`,
        })
      }
      const label = el('span', '', entry.label)
      const desc = el('span', 'muted', entry.description)
      item.append(label, desc)
      item.onclick = () => {
        scrim.remove()
        activateNavEntry(entry)
      }
      menu.appendChild(item)
    }
    for (const entry of group.tabs) {
      appendEntry({ ...entry, deepLink: `#tab=${entry.key}` })
    }
    if (groupIndex === chromeTabGroups().length - 1) {
      const settings = tabGroups().more.find(entry => entry.key === 'settings')
      if (settings !== undefined) appendEntry(settings)
    }
    scrim.onclick = () => scrim.remove()
    scrim.oncontextmenu = (event) => { event.preventDefault(); scrim.remove() }
    scrim.appendChild(menu)
    root.appendChild(scrim)
    // Anchor under the category, flipping at the right viewport edge.
    const rect = anchor.getBoundingClientRect()
    menu.style.left = `${Math.max(4, Math.min(rect.left, window.innerWidth - menu.offsetWidth - 8))}px`
    menu.style.top = `${rect.bottom + 6}px`
    registerOverlayRebuild(scrim, () => { scrim.remove(); openCategoryMenu(groupIndex) })
  }
  for (const [groupIndex, group] of chromeTabGroups().entries()) {
    const button = el('button', 'tab category-tab', '')
    button.dataset.category = String(groupIndex)
    button.setAttribute('aria-haspopup', 'menu')
    button.setAttribute('aria-expanded', 'false')
    button.onclick = () => openCategoryMenu(groupIndex)
    categoryButtons.set(groupIndex, button)
    tabs.appendChild(button)
  }
  main.appendChild(tabs)

  // ── body + picker ──
  const body = el('div', 'body')
  body.id = 'panel-body'
  body.tabIndex = -1
  body.setAttribute('role', 'region')
  body.setAttribute('aria-label', t('shell', 'shell.panelBody.aria'))
  main.appendChild(body)
  // Chat owns a main-level footer, outside the scrollable panel body. Keeping
  // one persistent dock prevents textarea content from changing its anchor.
  const chatDock = el('div', 'chat-dock')
  chatDock.hidden = true
  main.appendChild(chatDock)

  // ── UI-DOCK-01: one live, movable sidebar panel (right or bottom) ──
  // The shell owns placement and lifecycle; page renderers only receive their
  // content host. Moving the surface changes flex geometry without remounting
  // the page, so live streams, editor selection and draft DOM stay intact.
  const dockResize = el('div', 'dock-resizer')
  dockResize.tabIndex = 0
  dockResize.setAttribute('role', 'separator')
  const dockSurface = el('aside', 'dock-surface')
  dockSurface.hidden = true
  dockSurface.setAttribute('role', 'complementary')
  const dockHeader = el('div', 'dock-header')
  const dockTitle = el('span', 'dock-title')
  const dockPicker = el('select', 'dock-panel-picker')
  const dockHeaderActions = el('div', 'dock-header-actions')
  const dockRight = el('button', 'hbtn dock-action', '⇥')
  const dockBottom = el('button', 'hbtn dock-action', '⇓')
  const dockMain = el('button', 'hbtn dock-action', '↗')
  const dockClose = el('button', 'hbtn dock-action', '×')
  dockHeaderActions.append(dockRight, dockBottom, dockMain, dockClose)
  dockHeader.append(dockTitle, dockPicker, dockHeaderActions)
  const dockBody = el('div', 'body dock-body')
  dockBody.id = 'dock-panel-body'
  dockBody.tabIndex = -1
  dockBody.setAttribute('role', 'region')
  const dockChatDock = el('div', 'chat-dock dock-chat-dock')
  dockChatDock.hidden = true
  dockSurface.append(dockHeader, dockBody, dockChatDock)
  workspaceShell.append(dockResize, dockSurface)

  const saveDock = (): void => { dockStore.save(dockLayout) }
  const applyNavigationVisibility = (): void => {
    const next = reconcileVisibleNavigation(state.activeTab, dockLayout.openPanel)
    if (next.activeTab !== state.activeTab) {
      if (isTabKey(state.activeTab)) deactivatePanelTransport(state.activeTab)
      state.activeTab = next.activeTab
      tabSave()
      syncHash(next.activeTab)
    }
    if (next.dockPanel !== dockLayout.openPanel) {
      if (dockLayout.openPanel !== null) deactivatePanelTransport(dockLayout.openPanel)
      dockLayout = updateDockLayout(dockLayout, { type: 'close' })
      saveDock()
    }
  }
  const currentDockPosition = (): DockPosition => effectiveDockPosition(dockLayout, window.innerWidth)
  const applyDockGeometry = (): void => {
    const visible = dockLayout.openPanel !== null && state.projectId !== undefined
    const position = currentDockPosition()
    workspaceShell.dataset.dockPosition = position
    workspaceShell.style.setProperty('--dock-right-size', `${dockLayout.rightSize}px`)
    workspaceShell.style.setProperty('--dock-bottom-size', `${dockLayout.bottomSize}px`)
    dockSurface.hidden = !visible
    dockResize.hidden = !visible
    dockSurface.dataset.position = position
    dockSurface.dataset.panel = dockLayout.openPanel ?? ''
    dockRight.setAttribute('aria-pressed', String(dockLayout.position === 'right'))
    dockBottom.setAttribute('aria-pressed', String(dockLayout.position === 'bottom'))
    dockResize.setAttribute('aria-orientation', position === 'right' ? 'vertical' : 'horizontal')
    const size = position === 'right' ? dockLayout.rightSize : dockLayout.bottomSize
    dockResize.setAttribute('aria-valuenow', String(size))
    dockResize.setAttribute('aria-valuemin', String(position === 'right' ? DOCK_RIGHT_MIN : DOCK_BOTTOM_MIN))
    dockResize.setAttribute('aria-valuemax', String(position === 'right' ? DOCK_RIGHT_MAX : DOCK_BOTTOM_MAX))
    if (dockLayout.openPanel !== null) dockPicker.value = dockLayout.openPanel
  }
  const setDockPosition = (position: DockPosition): void => {
    dockLayout = updateDockLayout(dockLayout, { type: 'move', position })
    saveDock()
    applyDockGeometry()
  }
  const openDock = (panelKey: TabKey, position?: DockPosition): void => {
    if (!isTabVisible(panelKey)) return
    const previousDock = dockLayout.openPanel
    if (previousDock !== null && previousDock !== panelKey) deactivatePanelTransport(previousDock)
    if (state.activeTab === panelKey) deactivatePanelTransport(panelKey)
    if (position !== undefined) dockLayout = updateDockLayout(dockLayout, { type: 'move', position })
    dockLayout = updateDockLayout(dockLayout, { type: 'open', panel: panelKey })
    const nextMain = mainTabAfterDock(state.activeTab as TabKey, panelKey)
    if (nextMain !== state.activeTab) {
      state.activeTab = nextMain
      tabSave()
      syncHash(nextMain)
    }
    saveDock()
    applyDockGeometry()
    void render().then(() => dockBody.focus())
  }
  const closeDock = (focusMain = true): void => {
    if (dockLayout.openPanel === null) return
    deactivatePanelTransport(dockLayout.openPanel)
    dockLayout = updateDockLayout(dockLayout, { type: 'close' })
    saveDock()
    applyDockGeometry()
    void render().then(() => { if (focusMain) body.focus() })
  }
  const moveDockToMain = (): void => {
    const panelKey = dockLayout.openPanel
    if (panelKey === null) return
    deactivatePanelTransport(panelKey)
    dockLayout = updateDockLayout(dockLayout, { type: 'close' })
    saveDock()
    state.activeTab = panelKey
    tabSave()
    syncHash(panelKey)
    applyDockGeometry()
    void render().then(() => body.focus())
  }
  const paintDockChrome = (): void => {
    const current = dockLayout.openPanel
    const currentLabel = chromeTabs().find(item => item.key === current)?.label ?? ''
    dockTitle.textContent = t('shell', 'shell.dock.title')
    dockSurface.setAttribute('aria-label', t('shell', 'shell.dock.region', { panel: currentLabel }))
    dockBody.setAttribute('aria-label', t('shell', 'shell.dock.content', { panel: currentLabel }))
    dockPicker.setAttribute('aria-label', t('shell', 'shell.dock.panelPicker'))
    dockPicker.title = t('shell', 'shell.dock.panelPicker')
    const selected = dockPicker.value || current || ''
    dockPicker.replaceChildren()
    for (const key of visibleTabKeys()) {
      const def = chromeTabs().find(item => item.key === key)
      const option = el('option', '', def?.label ?? key)
      option.value = key
      dockPicker.appendChild(option)
    }
    dockPicker.value = selected
    dockRight.title = t('shell', 'shell.dock.moveRight')
    dockRight.setAttribute('aria-label', t('shell', 'shell.dock.moveRight'))
    dockBottom.title = t('shell', 'shell.dock.moveBottom')
    dockBottom.setAttribute('aria-label', t('shell', 'shell.dock.moveBottom'))
    dockMain.title = t('shell', 'shell.dock.openMain')
    dockMain.setAttribute('aria-label', t('shell', 'shell.dock.openMain'))
    dockClose.title = t('shell', 'shell.dock.close')
    dockClose.setAttribute('aria-label', t('shell', 'shell.dock.close'))
    dockResize.setAttribute('aria-label', t('shell', 'shell.dock.resize'))
    applyDockGeometry()
  }
  dockPicker.onchange = () => {
    if (isTabVisible(dockPicker.value)) openDock(dockPicker.value)
  }
  dockRight.onclick = () => setDockPosition('right')
  dockBottom.onclick = () => setDockPosition('bottom')
  dockMain.onclick = () => moveDockToMain()
  dockClose.onclick = () => closeDock()
  dockResize.onkeydown = (event) => {
    const position = currentDockPosition()
    const current = position === 'right' ? dockLayout.rightSize : dockLayout.bottomSize
    const min = position === 'right' ? DOCK_RIGHT_MIN : DOCK_BOTTOM_MIN
    const max = position === 'right' ? DOCK_RIGHT_MAX : DOCK_BOTTOM_MAX
    let next: number | null = null
    if (event.key === 'Home') next = min
    else if (event.key === 'End') next = max
    else if (position === 'right' && event.key === 'ArrowLeft') next = current + 24
    else if (position === 'right' && event.key === 'ArrowRight') next = current - 24
    else if (position === 'bottom' && event.key === 'ArrowUp') next = current + 24
    else if (position === 'bottom' && event.key === 'ArrowDown') next = current - 24
    if (next === null) return
    event.preventDefault()
    dockLayout = updateDockLayout(dockLayout, { type: 'resize', position, size: next })
    saveDock()
    applyDockGeometry()
  }
  dockResize.onpointerdown = (event) => {
    if (dockLayout.openPanel === null) return
    event.preventDefault()
    const position = currentDockPosition()
    const startPoint = position === 'right' ? event.clientX : event.clientY
    const startSize = position === 'right' ? dockLayout.rightSize : dockLayout.bottomSize
    dockResize.classList.add('dragging')
    const move = (nextEvent: PointerEvent): void => {
      const point = position === 'right' ? nextEvent.clientX : nextEvent.clientY
      dockLayout = updateDockLayout(dockLayout, { type: 'resize', position, size: startSize - (point - startPoint) })
      applyDockGeometry()
    }
    const up = (): void => {
      dockResize.classList.remove('dragging')
      saveDock()
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      window.removeEventListener('pointercancel', up)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
    window.addEventListener('pointercancel', up)
  }
  paintDockChrome()

  const styleTabs = (): void => {
    body.classList.toggle('chat-active', state.activeTab === 'chat')
    const groups = chromeTabGroups()
    for (const [groupIndex, button] of categoryButtons) {
      const group = groups[groupIndex]
      if (group === undefined) continue
      const active = group.tabs.find(entry => entry.key === state.activeTab)
      const selected = active !== undefined
      button.classList.toggle('active', selected)
      if (selected) button.setAttribute('aria-current', 'page')
      else button.removeAttribute('aria-current')
      button.replaceChildren(el('span', 'category-name', group.label))
      if (active !== undefined) button.appendChild(el('span', 'category-current', active.label))
      button.appendChild(el('span', 'category-caret', '⌄'))
      button.title = active !== undefined ? `${group.label} · ${active.label}` : group.label
      button.setAttribute('aria-label', active !== undefined ? `${group.label}: ${active.label}` : group.label)
    }
  }

  // dsh-web document title: reflect the active tab + project in the tab
  // title so the plugin is identifiable among many tabs (ignored when the
  // plugin runs inside a sandboxed iframe where the title is read-only).
  // Evaluated against the CURRENT locale; paintChrome() re-runs it on
  // locale switch so the title switches in the same tick (§8 line 135).
  let lastProjectName: string | undefined
  const syncTitle = (projectName: string | undefined): void => {
    lastProjectName = projectName
    try {
      const tabLabel = chromeTabs().find(t => t.key === state.activeTab)?.label ?? 'overview'
      const project = projectName !== undefined && projectName !== '' ? ` · ${projectName}` : ''
      document.title = t('shell', 'shell.documentTitle', { project, tab: tabLabel })
    } catch { /* sandboxed iframe */ }
  }

  // UI-SIMPLE-01 Start 三卡 handlers (acceptance §8 ui-start): the cards
  // are definitions from nav.ts startActions(); the DOM layer maps their
  // stable route targets to concrete actions. 'import' is the REAL
  // ONBOARD-01 intake wizard (begin → stage → scan → grill → propose →
  // adopt, modals/intake.ts) — no placeholder toast.
  const handleStartAction = (route: string): void => {
    if (route === 'new-project') {
      openNewProjectModal(root)
      return
    }
    if (route === 'open-project') {
      openProjectSwitcherModal(root)
      return
    }
    openIntakeModal(root)
  }

  type LoadedProjection = Projection & { project: NonNullable<Projection['project']> }

  /** The registry adapter seam shared by the full-page main slot and Dock. */
  const renderPage = async (
    targetBody: HTMLElement,
    targetChatDock: HTMLElement,
    key: TabKey,
    projection: LoadedProjection,
    methodology: CompactMethodologyProjection | null,
    projectId: string,
    docked: boolean,
  ): Promise<void> => {
    // A live xterm owns cursor, alternate-screen and IME state. Periodic shell
    // refreshes update it in place instead of replacing its DOM subtree.
    if (key === 'pty' && targetBody.dataset.panel === 'pty') {
      renderPty(targetBody, projection, projectId)
      return
    }
    targetBody.replaceChildren()
    targetBody.dataset.panel = key
    targetBody.classList.toggle('chat-active', key === 'chat')
    if (key !== 'chat') {
      disposeChatAttachments(targetChatDock)
      targetChatDock.hidden = true
      targetChatDock.replaceChildren()
    }

    const title = el('div', 'project-title')
    const pname = el('span', 'pname', projection.project.name ?? projectId)
    const projectHeading = el('div', 'project-heading')
    projectHeading.append(el('span', 'project-kicker', t('shell', 'shell.brand.name')), pname)
    const pid = el('span', 'pid', t('shell', 'shell.projectIdLine', { id: projectId, rev: String(projection.project.revision ?? 0) }))
    pid.style.cssText += ';cursor:pointer;border-radius:6px;padding:1px 4px'
    pid.title = t('common', 'common.clickCopyProjectId')
    pid.onclick = () => { copyText(projectId) }
    title.append(projectHeading, pill(projection.project.status), pid)
    targetBody.appendChild(title)

    const activeDef = chromeTabs().find(def => def.key === key)
    const activeGroup = chromeTabGroups().find(group => group.tabs.some(def => def.key === key))
    if (activeDef !== undefined && activeGroup !== undefined) {
      const intro = el('div', 'view-intro')
      const copy = el('div', 'view-copy')
      copy.append(el('h2', 'view-title', activeDef.label), el('div', 'view-description', activeDef.description))
      const actions = el('div', 'view-actions')
      if (!docked) {
        const right = el('button', 'hbtn', t('shell', 'shell.dock.actionRight'))
        right.title = t('shell', 'shell.dock.actionRightTitle', { panel: activeDef.label })
        right.setAttribute('aria-label', right.title)
        right.onclick = () => openDock(key, 'right')
        const bottom = el('button', 'hbtn', t('shell', 'shell.dock.actionBottom'))
        bottom.title = t('shell', 'shell.dock.actionBottomTitle', { panel: activeDef.label })
        bottom.setAttribute('aria-label', bottom.title)
        bottom.onclick = () => openDock(key, 'bottom')
        actions.append(right, bottom)
      }
      actions.appendChild(el('span', 'view-group', activeGroup.label))
      intro.append(copy, actions)
      targetBody.appendChild(intro)
    }

    switch (key) {
      case 'chat': await renderChat(
        targetBody,
        targetChatDock,
        projectId,
        modelSelect,
        docked ? 'dock' : 'main',
        () => modelPreference.barrier(),
        syncModelSelectDisabled,
      ); break
      case 'phase': await renderPhase(targetBody, projection, projectId, methodology); break
      case 'gates': await renderGates(targetBody, projectId, projection, methodology); break
      case 'runs': renderRuns(targetBody, projection); break
      case 'terminal': renderTerminal(targetBody, projection, projectId); break
      case 'artifacts': await renderArtifacts(targetBody, projectId); break
      case 'evidence': await renderEvidence(targetBody, projectId); break
      case 'budget': renderBudget(targetBody, projection); break
      case 'manuscript': await renderManuscript(targetBody, projection, projectId, methodology); break
      case 'trajectory': await renderTrajectory(targetBody, projectId); break
      case 'topology': await renderTopology(targetBody, projectId, methodology); break
      case 'workspace': await renderWorkspace(targetBody, projectId); break
      case 'pty': renderPty(targetBody, projection, projectId); break
      default: {
        const unreachable: never = key
        return unreachable
      }
    }
    const stampText = `${t('common', 'common.updatedAt')} ${new Date().toLocaleTimeString(getLocale())}${state.lastError !== undefined ? ` · ⚠ ${state.lastError}` : ''}`
    targetBody.appendChild(el('div', 'stamp', stampText))
  }

  const renderOnce = async (): Promise<void> => {
    retainArtifactPreviewForProject(state.projectId)
    applyNavigationVisibility()
    styleTabs()
    // Keep the live chat dock mounted during chat refreshes. Hiding it before
    // the async project requests complete makes the body gain its height for a
    // frame, which visibly shifts the whole conversation while typing.
    if (state.activeTab !== 'chat') {
      disposeChatAttachments(chatDock)
      chatDock.hidden = true
      chatDock.replaceChildren()
    }
    if (dockLayout.openPanel !== 'chat') {
      disposeChatAttachments(dockChatDock)
      dockChatDock.hidden = true
      dockChatDock.replaceChildren()
    }
    // dsh-web skeleton: placeholders while the first paint loads.
    if (booting) {
      const skel = el('div', 'skeleton')
      for (let i = 0; i < 4; i++) {
        const bar = el('div', 'skeleton-bar')
        bar.style.width = `${92 - i * 12}%`
        skel.appendChild(bar)
      }
      body.replaceChildren(skel)
    }
    // dsh-web offline indicator: throttled kernel health probe.
    const now = Date.now()
    if (now - lastKernelCheck > 5000) {
      lastKernelCheck = now
      const health = await api<{ ok?: boolean; instance?: string }>('/v1/health')
      kernelOnline = health !== null && health.ok === true
      // dsh-web status dot: reflect bridge health immediately.
      kernelChecked = true
      kernelOk = kernelOnline
      kernelInstance = health?.instance ?? ''
      paintKernelDot()
    }
    // Project list drives the standalone workspace sidebar.
    const projectsResult = await apiResult<ProjectRow[]>('/v1/projects')
    const projects = projectsResult.ok ? projectsResult.data : []
    if (projectsResult.ok) {
      void flushChatScopeCloseOutbox()
      const backgroundScopes = backgroundProjectScopesToProbe(chatTrackedProjectIds(), state.projectId, projects)
      const probes = await Promise.all(backgroundScopes.map(async projectId => ({
        projectId,
        result: await apiResult<Projection>(`/v1/projects/${encodeURIComponent(projectId)}/projection`),
      })))
      for (const probe of probes) {
        if (!probe.result.ok && probe.result.status === 404) chatDiscardProject(probe.projectId)
      }
    }
    // dsh-web session ordering: most recently active first (by updated_at).
    projects.sort((a, b) => String(b.updated_at ?? '').localeCompare(String(a.updated_at ?? '')))
    if (!kernelOnline) {
      const banner = el('div', 'connection-banner')
      banner.style.cssText = 'position:sticky;top:0;z-index:5;display:flex;align-items:center;justify-content:center;gap:8px;padding:8px 12px;background:var(--tone-red-bg);color:var(--tone-red);font:650 11px/1.4 system-ui,sans-serif'
      banner.appendChild(el('span', '', '⚠'))
      const text = el('span', '', t('shell', 'shell.kernelUnreachable'))
      banner.appendChild(text)
      const retry = el('button', 'hbtn', t('common', 'common.action.retryNow'))
      retry.style.cssText = 'padding:1px 8px'
      retry.onclick = () => {
        lastKernelCheck = 0
        void render()
      }
      banner.appendChild(retry)
      body.prepend(banner)
    }
    // §5 P1 (ONBOARD-01): NO auto-selection of projects[0] — the Start
    // screen (Init / Resume / Import) stays until the user EXPLICITLY picks
    // a project (startScreenVisible in nav.ts is the pure contract).
    const target = state.projectId
    let projection: LoadedProjection | null = null
    let methodology: CompactMethodologyProjection | null = null
    if (target !== undefined) {
      const [fetchedResult, methodologyFetched] = await Promise.all([
        apiResult<Projection>(`/v1/projects/${encodeURIComponent(target)}/projection`),
        api<CompactMethodologyProjection>(methodologyProjectionPath(target)),
      ])
      methodology = methodologyFetched
      const fetched = fetchedResult.ok ? fetchedResult.data : null
      const targetGone = projectIsAuthoritativelyGone(target, projectsResult.ok, projects, fetchedResult.status)
      // Destructive cleanup belongs to the deleted target even if the user
      // selected another project while this request was in flight.
      if (targetGone) chatDiscardProject(target)
      // The queued render for the newer selection owns all visible state.
      // Never let an older response clear it or write the old project back.
      if (!projectRenderTargetIsCurrent(target, state.projectId)) return
      if (fetched === null || fetched.project === undefined) {
        projection = null
        // A deleted project is absent from the authoritative list and all
        // ordinary reads return 404. Only an authoritative list + projection
        // result may trigger destructive local cleanup; transport/server
        // failures retain the transcript and upload queue for recovery.
        if (targetGone) state.projectId = undefined
      }
      else {
        state.projectId = fetched.project.project_id
        projection = { ...fetched, project: fetched.project }
      }
    }
    if (projection !== null && booting) booting = false
    // Capture after network awaits and immediately before structural paints.
    // ShadowRoot.activeElement identifies the real editor inside this UI;
    // document.activeElement would only identify the outer host.
    const focusSnapshot = captureFocus(root)
    retainArtifactPreviewForProject(state.projectId)
    try {
    syncTitle(projection?.project?.name)
    if (state.projectId === undefined) chatDeactivateProject()
    else chatActivateProject(state.projectId)
    renderSidebar(sidebar, projects, state.projectId, (id) => { state.projectId = id; void render() }, sidebarToggle)
    if (state.projectId === undefined) {
      deactivatePanelTransport('terminal')
      deactivatePanelTransport('workspace')
      deactivatePanelTransport('trajectory')
      deactivatePanelTransport('pty')
      deactivatePanelTransport('manuscript')
      syncTitle(undefined)
      // UI-SIMPLE-01 Start 三卡 (acceptance §8 ui-start, §5 P1 ONBOARD-01):
      // the first screen offers exactly three primary actions — 新建研究 /
      // 打开已有项目 / 上传·接入 — defined by the pure nav.ts startActions()
      // model (labels re-evaluate per locale; codes/routes are the stable
      // contract). Existing projects stay in the persistent sidebar, so the
      // landing content does not duplicate its search and project list.
      const start = el('div', 'welcome start-screen')
      start.appendChild(el('div', 'welcome-mark', '⌁'))
      start.appendChild(el('h1', '', t('shell', 'shell.start.title')))
      start.appendChild(el('div', 'welcome-eyebrow', t('shell', 'shell.start.subtitle')))
      const cards = el('div', 'start-cards')
      for (const action of startActions()) {
        const card = el('button', 'start-card')
        card.dataset.start = action.code
        card.dataset.route = action.route
        card.setAttribute('aria-label', `${action.label} — ${action.description}`)
        card.append(
          el('span', 'start-card-label', action.label),
          el('span', 'start-card-desc', action.description),
        )
        card.onclick = () => handleStartAction(action.route)
        cards.appendChild(card)
      }
      start.appendChild(cards)
      disposeChatAttachments(chatDock)
      chatDock.hidden = true
      chatDock.replaceChildren()
      dockBody.replaceChildren()
      disposeChatAttachments(dockChatDock)
      dockChatDock.replaceChildren()
      applyDockGeometry()
      body.replaceChildren(start)
      return
    }
    const activeTarget = state.projectId
    if (activeTarget === undefined) return
    if (projection === null) {
      deactivatePanelTransport('terminal')
      deactivatePanelTransport('workspace')
      deactivatePanelTransport('trajectory')
      deactivatePanelTransport('pty')
      deactivatePanelTransport('manuscript')
      disposeChatAttachments(chatDock)
      chatDock.hidden = true
      chatDock.replaceChildren()
      dockBody.replaceChildren()
      disposeChatAttachments(dockChatDock)
      dockChatDock.replaceChildren()
      applyDockGeometry()
      body.replaceChildren(el('div', 'error-banner', t('shell', 'shell.kernelUnreachableProject', { project: activeTarget })))
      return
    }
    if (dockLayout.openPanel === state.activeTab) {
      state.activeTab = mainTabAfterDock(state.activeTab as TabKey, dockLayout.openPanel)
      tabSave()
      syncHash(state.activeTab)
    }
    const dockedPanel = dockLayout.openPanel
    const panelVisible = (key: TabKey): boolean => state.activeTab === key || dockedPanel === key
    // dsh-web terminal hygiene: leaving the Terminal tab closes the stream
    // (state stays for the return; a new visit reconnects from lastSeq).
    if (!panelVisible('terminal') && state.terminalStatus !== 'idle') terminalDisconnect()
    // WORK-01: leaving the Workspace tab stops its watch stream + poll
    // fallback (the panel state survives; the next visit restarts it).
    if (!panelVisible('workspace')) stopWorkspaceWatch()
    // TRAJ-01: leaving the Trajectory tab closes both lane streams (SSE +
    // pagination fallback) — same hygiene as stopWorkspaceWatch.
    if (!panelVisible('trajectory')) stopTrajectoryStream()
    // Artifact previews/details and downloads are panel-owned; hiding the
    // panel must cancel them even when the active project did not change.
    if (!panelVisible('artifacts')) closeArtifactPreview()
    // TEX-03: PDF fetch/polls belong to the visible Manuscript document.
    // Leaving the panel invalidates late callbacks and releases Blob URLs.
    if (!panelVisible('manuscript')) msCleanup(true)
    // PTY-01: leaving the PTY tab detaches the session wire (the process
    // keeps running server-side; the next visit reconnects via after_seq).
    if (!panelVisible('pty')) ptyPanelDetachAll()
    await renderPage(body, chatDock, state.activeTab as TabKey, projection, methodology, activeTarget, false)
    applyDockGeometry()
    paintDockChrome()
    if (dockedPanel !== null) {
      await renderPage(dockBody, dockChatDock, dockedPanel, projection, methodology, activeTarget, true)
    } else {
      dockBody.replaceChildren()
      disposeChatAttachments(dockChatDock)
      dockChatDock.hidden = true
      dockChatDock.replaceChildren()
    }
    paintBell()
    } finally {
      restoreFocus(root, focusSnapshot)
    }
  }

  const renderCoordinator = new RenderCoordinator(renderOnce, () => {
    if (msMutationPending() || gateMutationPending()) return true
    const active = root.activeElement
    return active instanceof HTMLElement
      && shouldDeferBackgroundRefresh(active.tagName, active.isContentEditable)
  })
  const render = (): Promise<void> => renderCoordinator.request('interactive')
  const renderInBackground = (): Promise<void> => renderCoordinator.request('background')

  refresh.onclick = () => { void render() }
  // dsh-web notification dot: unread count on the bell (99+ capped).
  const paintBell = (): void => {
    bellBtn.replaceChildren(
      el('span', '', state.notifUnread > 0 ? String(state.notifUnread > 99 ? '99+' : state.notifUnread) : '○'),
      el('span', 'long-label', state.notifUnread > 0 ? ` ${t('shell', 'shell.activity.new')}` : ` ${t('shell', 'shell.activity')}`),
    )
    bellBtn.title = state.notifUnread > 0
      ? t('shell', 'shell.notifications.unread', { count: String(state.notifUnread) })
      : t('shell', 'shell.notifications')
  }
  paintBell()
  // ── locale-aware chrome paint (§13.4 / acceptance §8 line 135) ──
  // Re-evaluates every once-built chrome node (header, tabs, selects, aria,
  // document title) against the CURRENT locale. Runs once at init and again
  // on every locale switch; copy sources are the pure chrome model
  // (i18n/chrome.ts) so the DOM layer only applies evaluated strings.
  const paintChrome = (): void => {
    sidebar.setAttribute('aria-label', t('shell', 'shell.sidebar.ariaLabel'))
    body.setAttribute('aria-label', t('shell', 'shell.panelBody.aria'))
    brandMark.textContent = t('shell', 'shell.brand.mark')
    brandName.textContent = t('shell', 'shell.brand.name')
    brandMeta.textContent = t('shell', 'shell.brand.meta')
    paintKernelDot()
    paintTheme()
    refreshLabel.textContent = ` ${t('common', 'common.action.refresh')}`
    refresh.title = t('shell', 'shell.refresh.now')
    refresh.setAttribute('aria-label', t('common', 'common.action.refresh'))
    commandsLabel.textContent = ` ${t('shell', 'shell.commands.label')}`
    commandsBtn.title = t('shell', 'shell.commands.titleAttr')
    shortcutsBtn.textContent = t('shell', 'shell.shortcuts.button')
    shortcutsBtn.title = t('shell', 'shell.shortcuts.titleAttr')
    modeBadge.textContent = t('shell', 'shell.mode.humanGates')
    modeBadge.title = t('shell', 'shell.mode.humanGates.title')
    sidebarToggle.title = t('shell', 'shell.sidebar.toggle')
    sidebarToggle.setAttribute('aria-label', t('shell', 'shell.sidebar.toggleAria'))
    paintBell()
    paintModelSelect()
    styleTabs()
    paintDockChrome()
    tabs.setAttribute('aria-label', t('shell', 'shell.tabs.ariaLabel'))
    syncTitle(lastProjectName)
  }
  paintChrome()
  state.rerender = () => { void render() }
  state.navigationChanged = () => {
    applyNavigationVisibility()
    paintChrome()
    void render()
  }
  // dsh-web i18n: locale switch re-paints the static chrome AND re-renders
  // the active panel (panels/terminal/status pills evaluate t() per render,
  // so the body follows the new locale in the same tick); setLocale itself
  // rebuilds every open overlay (i18n/index.ts overlay registry).
  subscribeLocale(() => {
    paintChrome()
    state.rerender()
  })
  // UI-SIMPLE-01 deep links (acceptance §8 ui-routes): `#tab=<key>` for
  // every panel tab and `#settings` for the Settings modal survive reload
  // and back/forward; existing query routing is untouched (parseDeepLink
  // strips `?…`). Unknown hashes are a no-op.
  const applyDeepLink = (renderNow: boolean): void => {
    let link: ReturnType<typeof parseDeepLink> = null
    try { link = parseDeepLink(location.hash) } catch { /* sandboxed */ }
    if (link === null) return
    if (link.kind === 'tab') {
      if (renderNow) activateTab(link.target)
      else if (isTabVisible(link.target)) {
        state.activeTab = link.target
        tabSave()
      }
    } else if (link.target === 'settings') {
      openSettingsModal(root)
    }
  }
  const onHashChange = (): void => applyDeepLink(true)
  window.addEventListener('hashchange', onHashChange)
  tabLoad()
  applyNavigationVisibility()
  applyDeepLink(false)
  notifLoad()
  favProjectsLoad()
  sidebarSortLoad()
  void render()
  state.startRefreshTimer = (): number | null => {
    if (!autoRefreshEnabled()) return null
    return window.setInterval(() => {
      // dsh-web behaviour: pause background refreshes while the tab is
      // hidden (CPU/battery friendly); one refresh fires on return.
      if (document.hidden) return
      void renderInBackground()
    }, 8000)
  }
  state.refreshTimer = state.startRefreshTimer()
  root.addEventListener('focusout', () => {
    // A focus move inside the same form settles after this event. Flush at
    // most one coalesced poll only when no editable control remains focused.
    queueMicrotask(() => { void renderCoordinator.releaseDeferredBackgroundRefresh() })
  })
  // dsh-web behaviour: catch up immediately when the tab becomes visible
  // again (the interval above skips while hidden).
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) void renderInBackground()
  })
  // dsh-web global shortcuts: Cmd/Ctrl+K opens the command palette (when
  // not typing in an input/textarea); Cmd/Ctrl+Shift+T toggles the theme;
  // a bare "/" (not typing) focuses the chat composer.
  const onKey = (event: KeyboardEvent): void => {
    const typing = eventComesFromEditable(event)
    const chatVisible = state.activeTab === 'chat' || dockLayout.openPanel === 'chat'
    if (event.metaKey || event.ctrlKey) {
      if (event.key.toLowerCase() === 'k' && !typing) {
        event.preventDefault()
        openCommandsModal(root)
      } else if (event.key.toLowerCase() === 'f' && event.shiftKey && !typing && chatVisible) {
        // dsh-web cross-session search: Ctrl/Cmd+Shift+F.
        event.preventDefault()
        openSessionSearchModal(root)
      } else if (event.key.toLowerCase() === 'p' && !typing) {
        // dsh-web quick project switcher: Ctrl/Cmd+P.
        event.preventDefault()
        openProjectSwitcherModal(root)
      } else if (event.key.toLowerCase() === 't' && event.shiftKey && !typing) {
        event.preventDefault()
        host.dataset.theme = host.dataset.theme === 'dark' ? 'light' : 'dark'
        writeTheme(host.dataset.theme)
        paintTheme()
        applyAccent()
      } else if (/^[1-9]$/.test(event.key) && !typing && chatVisible) {
        // dsh-web session navigation: Ctrl+1..9 selects the Nth session.
        event.preventDefault()
        const idx = Number(event.key) - 1
        const target = state.chatSessions[idx]
        if (target !== undefined) {
          state.chatActiveId = target.id
          state.chatDraft = ''
          chatSyncActive()
          state.rerender()
        }
      } else if (event.key === 'Tab' && !typing && chatVisible && state.chatSessions.length > 1) {
        // dsh-web session navigation: Ctrl+Tab cycles chat sessions.
        event.preventDefault()
        const idx = state.chatSessions.findIndex(s => s.id === state.chatActiveId)
        const next = state.chatSessions[(idx + 1) % state.chatSessions.length]
        if (next !== undefined) {
          state.chatActiveId = next.id
          state.chatDraft = ''
          chatSyncActive()
          state.rerender()
        }
      } else if ((event.key === 'ArrowUp' || event.key === 'ArrowDown') && !typing && chatVisible && state.chatMessages.length > 0) {
        // dsh-web keyboard navigation: Ctrl+ArrowUp/Down walks messages
        // and selects them into the details panel.
        event.preventDefault()
        const dir = event.key === 'ArrowUp' ? -1 : 1
        const next = state.chatDetailIndex < 0
          ? (dir < 0 ? state.chatMessages.length - 1 : 0)
          : Math.min(state.chatMessages.length - 1, Math.max(0, state.chatDetailIndex + dir))
        state.chatDetailIndex = next
        state.rerender()
      }
      return
    }
    // dsh-web transcript nav: Home/End select the first/last message.
    if ((event.key === 'Home' || event.key === 'End') && !typing && chatVisible && state.chatMessages.length > 0) {
      event.preventDefault()
      state.chatDetailIndex = event.key === 'Home' ? 0 : state.chatMessages.length - 1
      state.rerender()
      return
    }
    // dsh-web help: '?' opens the shortcut reference.
    if (event.key === '?' && !typing) {
      event.preventDefault()
      openShortcutsModal(root)
      return
    }
    // dsh-web behavior: typing "/" anywhere (not already typing) jumps to
    // the chat composer with a leading slash.
    if (event.key === '/' && !typing) {
      event.preventDefault()
      state.chatDraft = '/'
      activateTab('chat')
      // Focus the composer once the chat tab has rendered.
      setTimeout(() => {
        const ta = root.querySelector('.chat-composer-input') as HTMLTextAreaElement | null
        if (ta !== null) {
          ta.focus()
          ta.setSelectionRange(ta.value.length, ta.value.length)
        }
      }, 120)
    }
    // dsh-web behavior: Escape closes any open modal/overlay, the message
    // details panel and any pending quote.
    if (event.key === 'Escape' && !typing) {
      const ctx = root.querySelectorAll('.ctx-scrim')
      if (ctx.length > 0) {
        ctx[ctx.length - 1]?.remove()
        return
      }
      const overlays = root.querySelectorAll('.overlay')
      if (overlays.length > 0) {
        const latest = overlays[overlays.length - 1]
        if (latest instanceof HTMLElement && latest.dataset.artifactPreview === 'true') closeArtifactPreview()
        else if (latest instanceof HTMLElement && latest.dataset.overlayDismiss === 'event') {
          latest.dispatchEvent(new Event('dsh-overlay-dismiss'))
        } else latest?.remove()
      } else if (state.chatDetailIndex >= 0) {
        state.chatDetailIndex = -1
        state.rerender()
      } else if (state.chatQuoteTarget?.session_id === state.chatActiveId) {
        state.chatQuoteTarget = null
        state.rerender()
      }
      return
    }
    // dsh-web keyboard navigation: Alt+1..9 walks the flat nav order
    // (primary tabs → More entries → Settings modal; nav.ts navOrder()).
    if (event.altKey && /^[1-9]$/.test(event.key) && !typing) {
      event.preventDefault()
      const idx = Number(event.key) - 1
      const target = navOrder()[idx]
      if (target !== undefined) {
        if (target === 'settings') openSettingsModal(root)
        else activateTab(target)
      }
    }
  }
  window.addEventListener('keydown', onKey)
  // Responsive: narrow viewports auto-collapse the sidebar (dsh-web shell).
  const onResize = (): void => {
    const narrow = window.innerWidth < 920
    // Narrow viewports force-collapse; wide ones keep the user's choice
    // (persisted layout memory).
    if (narrow && !sidebarCollapsed) {
      sidebarCollapsed = true
      sidebar.classList.add('collapsed')
      if (main !== null) main.classList.add('expanded')
      sidebarToggle.textContent = '›'
      sidebarToggle.setAttribute('aria-expanded', 'false')
    }
    applyDockGeometry()
  }
  if (sidebarCollapsed && sidebar !== null) {
    sidebar.classList.add('collapsed')
    if (main !== null) main.classList.add('expanded')
    sidebarToggle.textContent = '›'
    sidebarToggle.setAttribute('aria-expanded', 'false')
  }
  onResize()
  window.addEventListener('resize', onResize)
  window.addEventListener('beforeunload', () => {
    closeArtifactPreview()
    msCleanup(true)
    if (state.refreshTimer !== null) window.clearInterval(state.refreshTimer)
    state.refreshTimer = null
    window.removeEventListener('keydown', onKey)
    window.removeEventListener('resize', onResize)
    window.removeEventListener('hashchange', onHashChange)
  }, { once: true })
  document.body.appendChild(host)
}
