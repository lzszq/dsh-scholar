/** Shared UI state + localStorage persistence (preferences, favourites,
 * notifications, chat sessions, terminal seq). Panels/modals read & write
 * the mutable `state` object; persistence helpers own their storage keys. */
import type { ChatAttachmentRef, ChatMessage, ChatSession, NotifEntry, TerminalLine } from './types'
import { ACCENTS, el, rootHost, trapFocus } from './ui'
import { getLocale, registerOverlayRebuild, t } from './i18n/index'
// UI-SIMPLE-01: the canonical tab key set lives in the pure nav model
// (nav.ts ALL_TAB_KEYS) so tab restore covers every panel incl. the More
// tabs (manuscript/terminal).
import { ALL_TAB_KEYS } from './nav'
import {
  appendStoredChatMessage,
  appendStoredChatHistory,
  consumeStoredChatQuote,
  deleteChatProjectSnapshot,
  listChatProjectSnapshotIds,
  loadChatProjectSnapshot,
  saveChatProjectSnapshot,
  type ChatProjectSnapshot,
  type ChatQuoteTarget,
} from './chat-project-store'
import { chatVisionTurnStore } from './chat-vision'
import { chatUploadStore } from './chat-upload-store'
import { browserTransport } from './chunked-upload'
import { chatTurnFlightStore } from './chat-turn-flight'
import { chatAttachmentFlightStore } from './chat-attachment-flight'
import { chatScopeCloseStore } from './chat-scope-close-store'
import { apiResult } from './api'

export let favProjects = new Set<string>()

export const state = {
  activeTab: 'phase',
  projectId: undefined as string | undefined,
  lastError: undefined as string | undefined,
  rerender: (() => {}) as () => void,
  navigationChanged: (() => {}) as () => void,
  refreshTimer: null as number | null,
  startRefreshTimer: (() => null) as () => number | null,
  notifHistory: [] as NotifEntry[],
  notifUnread: 0,
  chatMessages: [] as ChatMessage[],
  chatDraft: '',
  chatSessions: [] as ChatSession[],
  chatActiveId: null as string | null,
  chatHistory: [] as string[],
  historyIndex: -1,
  chatDetailIndex: -1,
  chatQuoteTarget: null as ChatQuoteTarget | null,
  chatSearchQuery: '',
  chatCommandsOnly: false,
  chatSessionSearchQuery: '',
  terminalRunId: null as string | null,
  terminalChannel: 'all' as 'all' | 'stdout' | 'stderr',
  terminalLines: [] as TerminalLine[],
  terminalLastSeq: 0,
  terminalRetainedSeq: 1,
  terminalTotalBytes: 0,
  terminalDroppedBytes: 0,
  terminalTruncated: false,
  terminalStatus: 'idle' as 'idle' | 'connecting' | 'live' | 'reconnecting' | 'exited',
  terminalExitCode: null as number | null,
  terminalExitSignal: null as string | null,
  terminalAbort: null as AbortController | null,
  terminalAutoScroll: true,
  terminalSearch: '',
  terminalAttempt: 0,
  terminalStreamEl: null as HTMLElement | null,
  terminalStatusEl: null as HTMLElement | null,
  terminalMetaEl: null as HTMLElement | null,
  terminalSaveTimer: undefined as number | undefined,
}

/* ─────────────────────────── theme (light default) ─────────────────────────── */

export const THEME_KEY = 'dsh-scholar-ui-theme'

export function readTheme(): 'light' | 'dark' {
  try {
    const saved = localStorage.getItem(THEME_KEY)
    return saved === 'dark' ? 'dark' : 'light'
  } catch {
    return 'light'
  }
}

export function writeTheme(theme: 'light' | 'dark' | string | undefined): void {
  try {
    localStorage.setItem(THEME_KEY, theme === 'dark' ? 'dark' : 'light')
  } catch { /* private mode */ }
}


/* ─────────────────────────── panel state ─────────────────────────── */

export const TAB_KEY = 'dsh-scholar-ui-tab'
export const TAB_IDS = [...ALL_TAB_KEYS]

/** Restore the last active tab (dsh-web session restore feel). */
export function tabLoad(): void {
  try {
    const saved = localStorage.getItem(TAB_KEY)
    if (saved !== null && TAB_IDS.some(id => id === saved)) state.activeTab = saved
  } catch { /* private mode */ }
}

export function tabSave(): void {
  try { localStorage.setItem(TAB_KEY, state.activeTab) } catch { /* private mode */ }
}

export const REFRESH_KEY = 'dsh-scholar-ui-refresh'

/** Auto-refresh toggle (8s polling), persisted. */
export function autoRefreshEnabled(): boolean {
  try { return localStorage.getItem(REFRESH_KEY) !== 'off' } catch { return true }
}
export function autoRefreshSet(on: boolean): void {
  try { localStorage.setItem(REFRESH_KEY, on ? 'on' : 'off') } catch { /* private mode */ }
}

export const ACCENT_KEY = 'dsh-scholar-ui-accent'
export function accentColor(): string {
  try { return ACCENTS[localStorage.getItem(ACCENT_KEY) ?? 'blue'] ?? ACCENTS.blue! } catch { return ACCENTS.blue! }
}
export function accentSet(name: string): void {
  try { localStorage.setItem(ACCENT_KEY, name in ACCENTS ? name : 'blue') } catch { /* private mode */ }
}

export const RADIUS_KEY = 'dsh-scholar-ui-radius'
export const RADII: Record<string, string> = { small: '8px', normal: '12px', large: '16px' }

/** Panel corner radius (dsh-web appearance preference), persisted. */
export function radiusValue(): string {
  try { return RADII[localStorage.getItem(RADIUS_KEY) ?? 'normal'] ?? RADII.normal! } catch { return RADII.normal! }
}
export function radiusSet(name: string): void {
  try { localStorage.setItem(RADIUS_KEY, name in RADII ? name : 'normal') } catch { /* private mode */ }
}

export const TEXTURE_KEY = 'dsh-scholar-ui-texture'
export const TEXTURES: Record<string, string> = { plain: 'plain', grid: 'grid', dots: 'dots' }

/** Panel background texture (dsh-web appearance), persisted. */
export function textureValue(): string {
  try { return TEXTURES[localStorage.getItem(TEXTURE_KEY) ?? 'plain'] ?? 'plain' } catch { return 'plain' }
}
export function textureSet(name: string): void {
  try { localStorage.setItem(TEXTURE_KEY, name in TEXTURES ? name : 'plain') } catch { /* private mode */ }
}

export const FAV_KEY = 'dsh-scholar-ui-favs'

export function tabFavs(): Set<string> {
  try {
    const raw = localStorage.getItem(FAV_KEY)
    if (raw === null) return new Set()
    const parsed = JSON.parse(raw) as unknown
    return new Set(Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : [])
  } catch {
    return new Set()
  }
}

export function tabPinned(key: string): boolean {
  return tabFavs().has(key)
}

export function tabTogglePin(key: string): void {
  const favs = tabFavs()
  if (favs.has(key)) favs.delete(key)
  else favs.add(key)
  try { localStorage.setItem(FAV_KEY, JSON.stringify([...favs])) } catch { /* private mode */ }
  state.rerender()
}

/** Project favourites (dsh-web starred projects), persisted. */
export const FAV_PROJECTS_KEY = 'dsh-scholar-ui-fav-projects'
export function favProjectsLoad(): void {
  try {
    const raw = localStorage.getItem(FAV_PROJECTS_KEY)
    if (raw !== null) favProjects = new Set(JSON.parse(raw) as string[])
  } catch { /* private mode */ }
}
export function favProjectsPersist(): void {
  try { localStorage.setItem(FAV_PROJECTS_KEY, JSON.stringify([...favProjects])) } catch { /* private mode */ }
}
export function favProjectToggle(id: string): void {
  if (favProjects.has(id)) favProjects.delete(id)
  else favProjects.add(id)
  favProjectsPersist()
}


/* ─────────────────────────── commands modal ─────────────────────────── */

export const FAV_CMDS_KEY = 'dsh-scholar-ui-favcmds'

/** Favourite command names (dsh-web quick commands), persisted. */
export function favCommands(): Set<string> {
  try {
    const raw = localStorage.getItem(FAV_CMDS_KEY)
    if (raw === null) return new Set()
    const parsed = JSON.parse(raw) as unknown
    return new Set(Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : [])
  } catch {
    return new Set()
  }
}

export function favCommandToggle(name: string): void {
  const favs = favCommands()
  if (favs.has(name)) favs.delete(name)
  else favs.add(name)
  try { localStorage.setItem(FAV_CMDS_KEY, JSON.stringify([...favs])) } catch { /* private mode */ }
}

/** Execute a command line in the Chat tab (fill + run). */

/** dsh-web notification centre: toast history (persisted, 30 max). */
export const NOTIF_KEY = 'dsh-scholar-ui-notifs'
export const NOTIF_READ_KEY = 'dsh-scholar-ui-notifs-read'
/** Unread badge count (dsh-web notification dot). */
export function notifLoad(): void {
  try {
    const raw = localStorage.getItem(NOTIF_KEY)
    if (raw === null) return
    const parsed = JSON.parse(raw) as unknown
    if (Array.isArray(parsed)) {
      state.notifHistory = parsed.filter((n): n is NotifEntry => typeof n === 'object' && n !== null && typeof (n as { text?: unknown }).text === 'string').slice(-30)
    }
    const readRaw = localStorage.getItem(NOTIF_READ_KEY)
    state.notifUnread = readRaw === null ? 0 : Math.max(0, state.notifHistory.length - Number(readRaw))
  } catch { /* private mode */ }
}
export function notifPersist(): void {
  try { localStorage.setItem(NOTIF_KEY, JSON.stringify(state.notifHistory.slice(-30))) } catch { /* private mode */ }
}
export function notifClear(): void {
  state.notifHistory = []
  state.notifUnread = 0
  notifPersist()
  try { localStorage.setItem(NOTIF_READ_KEY, '0') } catch { /* private mode */ }
}
export function notifMarkRead(): void {
  state.notifUnread = 0
  try { localStorage.setItem(NOTIF_READ_KEY, String(state.notifHistory.length)) } catch { /* private mode */ }
}

/** dsh-web a11y: trap Tab focus inside a modal; Escape already handled
 * globally. Returns a cleanup that restores focus to the trigger. */



export const CHAT_STORAGE_KEY = 'dsh-scholar-ui-chat'
export const CHAT_MAX = 200
/** Multi-session chats (dsh-web session tabs), persisted. */
export const SESSIONS_KEY = 'dsh-scholar-ui-sessions'
let chatContextProjectId: string | null = null
const discardedChatProjects = new Set<string>()

export function activeChatProjectId(): string | null {
  return chatContextProjectId
}

/** Page scopes that may still own transcript/File/turn state even while a
 * different project is selected. Used only after an authoritative list read. */
export function chatTrackedProjectIds(): string[] {
  const ids = new Set<string>(chatContextProjectId === null ? [] : [chatContextProjectId])
  try {
    for (const projectId of listChatProjectSnapshotIds(localStorage)) ids.add(projectId)
    chatScopeCloseStore.hydrate(localStorage)
  } catch { /* private mode */ }
  for (const projectId of chatUploadStore.projectIds()) ids.add(projectId)
  for (const projectId of chatVisionTurnStore.projectIds()) ids.add(projectId)
  for (const projectId of chatTurnFlightStore.projectIds()) ids.add(projectId)
  for (const projectId of chatAttachmentFlightStore.projectIds()) ids.add(projectId)
  for (const projectId of chatScopeCloseStore.projectIds()) ids.add(projectId)
  return [...ids]
}

function currentChatSnapshot(projectId: string): ChatProjectSnapshot {
  return {
    projectId,
    sessions: state.chatSessions,
    activeId: state.chatActiveId,
    draft: state.chatDraft,
    history: state.chatHistory,
    detailIndex: state.chatDetailIndex,
    quoteTarget: state.chatQuoteTarget,
    searchQuery: state.chatSearchQuery,
    commandsOnly: state.chatCommandsOnly,
    sessionSearchQuery: state.chatSessionSearchQuery,
  }
}

function resetChatContext(): void {
  state.chatSessions = []
  state.chatActiveId = null
  state.chatMessages = []
  state.chatDraft = ''
  state.chatHistory = []
  state.historyIndex = -1
  state.chatDetailIndex = -1
  state.chatQuoteTarget = null
  state.chatSearchQuery = ''
  state.chatCommandsOnly = false
  state.chatSessionSearchQuery = ''
}

/** Switch the browser-only transcript to one project, persisting the old one. */
export function chatActivateProject(projectId: string): void {
  if (chatContextProjectId === projectId) return
  if (chatContextProjectId !== null) {
    chatSessionsPersist()
  }
  resetChatContext()
  chatContextProjectId = projectId
  const snapshot = loadChatProjectSnapshot(localStorage, projectId)
  state.chatSessions = snapshot.sessions
  state.chatActiveId = snapshot.activeId
  state.chatDraft = snapshot.draft
  state.chatHistory = snapshot.history
  state.chatDetailIndex = snapshot.detailIndex
  state.chatQuoteTarget = snapshot.quoteTarget
  state.chatSearchQuery = snapshot.searchQuery
  state.chatCommandsOnly = snapshot.commandsOnly
  state.chatSessionSearchQuery = snapshot.sessionSearchQuery
  chatSessionEnsure()
  try { chatScopeCloseStore.hydrate(localStorage) } catch { /* private mode */ }
  void flushChatScopeCloseOutbox(projectId)
}

export function chatDeactivateProject(): void {
  if (chatContextProjectId !== null) {
    chatSessionsPersist()
  }
  chatContextProjectId = null
  resetChatContext()
}

/** Current session's messages (state.chatMessages mirrors the active session). */


export function chatSyncActive(): void {
  const active = state.chatSessions.find(s => s.id === state.chatActiveId && s.project_id === chatContextProjectId)
  state.chatMessages = active !== undefined ? active.messages : []
  if (active !== undefined) {
    active.lastActive = Date.now()
    // dsh-web pinned sessions stay at the top; the rest by recent activity.
    state.chatSessions.sort((a, b) =>
      ((b.pinned === true ? 1 : 0) - (a.pinned === true ? 1 : 0)) || ((b.lastActive ?? 0) - (a.lastActive ?? 0)),
    )
  }
}
export function chatSessionsPersist(): void {
  if (chatContextProjectId === null) return
  try {
    saveChatProjectSnapshot(localStorage, currentChatSnapshot(chatContextProjectId))
  } catch { /* private mode */ }
}
export function chatSessionEnsure(): void {
  const projectId = chatContextProjectId
  if (projectId === null) return
  state.chatSessions = state.chatSessions.filter(session => session.project_id === projectId)
  if (state.chatSessions.length === 0) {
    const id = `s-${crypto.randomUUID()}`
    state.chatSessions = [{ project_id: projectId, id, name: 'Chat 1', messages: [] }]
    state.chatActiveId = id
  }
  if (state.chatActiveId === null || !state.chatSessions.some(s => s.id === state.chatActiveId)) {
    state.chatActiveId = state.chatSessions[0]!.id
  }
  chatSyncActive()
}
export function chatSessionNew(): void {
  if (chatContextProjectId === null) return
  const id = `s-${crypto.randomUUID()}`
  state.chatSessions.push({ project_id: chatContextProjectId, id, name: `Chat ${state.chatSessions.length + 1}`, messages: [] })
  state.chatActiveId = id
  state.chatDraft = ''
  chatSyncActive()
  chatSessionsPersist()
  state.rerender()
}
const chatScopeCloseRequests = new Map<string, Promise<boolean>>()

function removeChatSessionLocally(projectId: string, id: string): void {
  if (chatContextProjectId !== projectId) {
    try {
      const snapshot = loadChatProjectSnapshot(localStorage, projectId)
      const idx = snapshot.sessions.findIndex(session => session.id === id && session.project_id === projectId)
      if (idx < 0) return
      snapshot.sessions.splice(idx, 1)
      if (snapshot.activeId === id) snapshot.activeId = snapshot.sessions[Math.min(idx, snapshot.sessions.length - 1)]?.id ?? null
      if (snapshot.quoteTarget?.session_id === id) snapshot.quoteTarget = null
      saveChatProjectSnapshot(localStorage, snapshot)
    } catch { /* outbox retry remains authoritative */ }
    return
  }
  const idx = state.chatSessions.findIndex(session => session.id === id && session.project_id === projectId)
  if (idx < 0) return
  if (state.chatQuoteTarget?.session_id === id) state.chatQuoteTarget = null
  state.chatSessions.splice(idx, 1)
  if (state.chatSessions.length === 0) chatSessionEnsure()
  if (state.chatActiveId === id) {
    state.chatActiveId = state.chatSessions[Math.min(idx, state.chatSessions.length - 1)]!.id
    state.chatDraft = ''
  }
  chatSyncActive()
  chatSessionsPersist()
  state.rerender()
}

function requestChatScopeClose(projectId: string, sessionId: string): Promise<boolean> {
  const key = `${projectId}\u0000${sessionId}`
  const existing = chatScopeCloseRequests.get(key)
  if (existing !== undefined) return existing
  const request = (async (): Promise<boolean> => {
    const result = await apiResult<{ ok: true }>(
      `/v1/projects/${encodeURIComponent(projectId)}/chat-scopes/${encodeURIComponent(sessionId)}/tombstone`,
      { method: 'POST', body: '{}' },
    )
    // A deleted project is a stronger tombstone; no retry is needed.
    if (!result.ok && result.status !== 404) return false
    try { chatScopeCloseStore.complete(localStorage, projectId, sessionId) } catch { /* stale outbox replays idempotently */ }
    removeChatSessionLocally(projectId, sessionId)
    return true
  })().finally(() => { chatScopeCloseRequests.delete(key) })
  chatScopeCloseRequests.set(key, request)
  return request
}

export async function flushChatScopeCloseOutbox(projectId?: string): Promise<void> {
  try { chatScopeCloseStore.hydrate(localStorage) } catch { /* page-lifetime entries remain */ }
  await Promise.all(chatScopeCloseStore.entries(projectId).map(item => requestChatScopeClose(item.projectId, item.sessionId)))
}

export function chatSessionClose(id: string): void {
  const projectId = chatContextProjectId
  if (projectId === null || !state.chatSessions.some(session => session.id === id && session.project_id === projectId)) return
  // Publish every page-lifetime tombstone before any asynchronous close I/O.
  const discarded = chatUploadStore.clear(projectId, id)
  chatAttachmentFlightStore.cancel(projectId, id)
  chatTurnFlightStore.cancel(projectId, id)
  chatVisionTurnStore.clear(projectId, id)
  let durable = false
  try { durable = chatScopeCloseStore.enqueue(localStorage, projectId, id) } catch { /* keep the visible session until server ACK */ }
  if (durable) removeChatSessionLocally(projectId, id)
  void requestChatScopeClose(projectId, id)
  const transport = browserTransport()
  for (const item of discarded) {
    if (item.uploadId === null || item.intakeId === null || item.projectId !== projectId) continue
    void transport.abort({ project_id: projectId, intake_id: item.intakeId, upload_id: item.uploadId }).catch(() => {})
  }
}

/** Exact project/session liveness fence for delayed model, Intake and upload
 * continuations. Project switches persist the session; explicit close makes
 * it disappear and therefore rejects all late writes. */
export function chatSessionExists(projectId: string, sessionId: string): boolean {
  if (discardedChatProjects.has(projectId)) return false
  if (chatContextProjectId === projectId) {
    return state.chatSessions.some(session => session.project_id === projectId && session.id === sessionId)
  }
  try {
    return loadChatProjectSnapshot(localStorage, projectId).sessions.some(
      session => session.project_id === projectId && session.id === sessionId,
    )
  } catch {
    return false
  }
}

/** Explicit destructive cleanup; ordinary navigation deliberately retains
 * the page-lifetime File handles and persisted queue metadata. */
export function chatDiscardProject(projectId: string): void {
  discardedChatProjects.add(projectId)
  chatAttachmentFlightStore.cancelProject(projectId)
  chatTurnFlightStore.cancelProject(projectId)
  chatVisionTurnStore.clearProject(projectId)
  // Project deletion is authoritative in the Kernel, which removes every
  // open server-side stage before the project becomes unreadable. The browser
  // only owns its local queue and must not issue doomed post-tombstone aborts.
  chatUploadStore.clearProject(projectId)
  try { chatScopeCloseStore.clearProject(localStorage, projectId) } catch { /* project authority already deleted */ }
  try { deleteChatProjectSnapshot(localStorage, projectId) } catch { /* private mode */ }
  if (chatContextProjectId === projectId) {
    chatContextProjectId = null
    resetChatContext()
  }
}
export function chatSessionSelect(id: string): void {
  if (state.chatSessions.some(s => s.id === id)) {
    state.chatActiveId = id
    state.chatDraft = ''
    const session = state.chatSessions.find(s => s.id === id)
    if (session !== undefined) session.unread = 0
    chatSyncActive()
    state.rerender()
  }
}

/** Rename a chat session via an in-app dialog (dsh-web dialogs — no
 * browser prompts), persisted. */
export function chatSessionRename(id: string): void {
  const session = state.chatSessions.find(s => s.id === id)
  if (session === undefined) return
  const root = rootHost()
  if (root == null) return
  const overlay = el('div', 'overlay')
  overlay.onclick = (event) => { if (event.target === overlay) overlay.remove() }
  const modal = el('div', 'modal')
  modal.style.cssText = 'width:440px;max-width:92vw'
  modal.setAttribute('role', 'dialog')
  modal.setAttribute('aria-label', t('shell', 'shell.renameSession.title'))
  const header = el('div', 'modal-header', t('shell', 'shell.renameSession.title'))
  const closeBtn = el('button', 'hbtn ghost', '×')
  closeBtn.onclick = () => overlay.remove()
  header.appendChild(closeBtn)
  modal.appendChild(header)
  const hint = el('div', 'muted', t('shell', 'shell.renameSession.hint', { name: session.name }))
  hint.style.cssText = 'margin-bottom:10px;font-size:11.5px'
  modal.appendChild(hint)
  const input = document.createElement('input')
  input.type = 'text'
  input.value = session.name
  input.style.cssText = 'width:100%;box-sizing:border-box;background:var(--bg-input);color:var(--text);border:1px solid var(--border);border-radius:8px;padding:8px 11px;font:12px/1.4 system-ui,sans-serif;outline:none'
  input.onfocus = () => { input.style.borderColor = 'var(--accent)' }
  input.onblur = () => { input.style.borderColor = 'var(--border)' }
  modal.appendChild(input)
  const err = el('div', 'error-banner')
  err.style.cssText = 'display:none;margin-top:10px'
  modal.appendChild(err)
  const actions = el('div', 'row')
  actions.style.cssText = 'justify-content:flex-end;gap:8px;margin-top:14px'
  const cancel = el('button', 'hbtn', t('budget', 'budget.modal.cancel'))
  cancel.onclick = () => overlay.remove()
  const save = el('button', 'btn approve', t('common', 'common.action.save'))
  save.style.cssText = 'padding:7px 18px'
  const saveName = (): void => {
    const clean = input.value.trim()
    if (clean === '') {
      err.textContent = t('common', 'common.nameRequired')
      err.style.display = 'block'
      return
    }
    session.name = clean.slice(0, 40)
    chatSessionsPersist()
    overlay.remove()
    state.rerender()
  }
  save.onclick = saveName
  input.onkeydown = (event) => { if (event.key === 'Enter') { event.preventDefault(); saveName() } }
  actions.append(cancel, save)
  modal.appendChild(actions)
  overlay.appendChild(modal)
  root.appendChild(overlay)
  // dsh-web i18n §13.4: locale switch re-opens the rename dialog (the typed
  // name is preserved via session.name captured below).
  registerOverlayRebuild(overlay, () => { overlay.remove(); chatSessionRename(id) })
  input.focus()
  input.select()
  trapFocus(overlay, null)
}

/** Archive a chat session (dsh-web session actions); messages are kept. */
export function chatSessionArchive(id: string): void {
  const session = state.chatSessions.find(s => s.id === id)
  if (session === undefined) return
  session.archived = !session.archived
  if (!session.archived) {
    // dsh-web restore: a restored session is no longer unread.
    session.unread = 0
  }
  if (session.archived && state.chatActiveId === id) {
    const next = state.chatSessions.find(s => s.id !== id && !s.archived) ?? state.chatSessions.find(s => s.id !== id)
    if (next !== undefined) {
      state.chatActiveId = next.id
      state.chatDraft = ''
    }
  }
  chatSyncActive()
  chatSessionsPersist()
  state.rerender()
}
/** Command history for ↑/↓ navigation (dsh-web shell feel), persisted. */
export const HISTORY_KEY = 'dsh-scholar-ui-history'

export function historyLoad(): void {
  // Project activation restores this together with the transcript.
}

export function historyPush(line: string): void {
  if (line === '') return
  if (state.chatHistory[state.chatHistory.length - 1] === line) return
  state.chatHistory.push(line)
  state.chatHistory = state.chatHistory.slice(-50)
  state.historyIndex = -1
  chatSessionsPersist()
}

export function historyPushToProject(projectId: string, line: string): boolean {
  if (chatContextProjectId === projectId) {
    historyPush(line)
    return true
  }
  try {
    return appendStoredChatHistory(localStorage, projectId, line)
  } catch {
    return false
  }
}

/** Restore transcripts persisted in localStorage (dsh-web session tabs). */
export function chatLoad(projectId?: string): void {
  if (projectId !== undefined) chatActivateProject(projectId)
}

export function chatPersist(): void {
  chatSessionsPersist()
}

export function chatClear(): void {
  state.chatMessages = []
  chatSyncActive()
  chatPersist()
}

export function chatPush(role: ChatMessage['role'], text: string, quote?: { index: number; text: string }, attachment?: ChatAttachmentRef): void {
  if (chatContextProjectId === null) return
  if (attachment !== undefined && attachment.project_id !== chatContextProjectId) return
  const msg: ChatMessage = { role, text, time: new Date().toLocaleTimeString(getLocale()) }
  if (quote !== undefined) msg.quote = quote
  if (attachment !== undefined) msg.attachment = attachment
  state.chatMessages.push(msg)
  // dsh-web session unread: bump every session other than the active one
  // (assistant replies that land while the user is elsewhere).
  chatPersist()
}

/** Write a delayed result to the exact project/session that launched it. */
export function chatPushToProjectSession(projectId: string, sessionId: string | null, message: ChatMessage, markUnread = true): boolean {
  if (sessionId === null) return false
  if (message.attachment !== undefined && message.attachment.project_id !== projectId) return false
  if (chatContextProjectId === projectId) {
    const session = state.chatSessions.find(candidate => candidate.project_id === projectId && candidate.id === sessionId)
    if (session === undefined) return false
    session.messages.push(message)
    session.messages = session.messages.slice(-CHAT_MAX)
    if (markUnread && sessionId !== state.chatActiveId) session.unread = (session.unread ?? 0) + 1
    if (sessionId === state.chatActiveId) state.chatMessages = session.messages
    chatSessionsPersist()
    return true
  }
  try { return appendStoredChatMessage(localStorage, projectId, sessionId, message, markUnread) } catch { return false }
}

/** Clear a quote only after its exact project/session turn was accepted. */
export function consumeChatQuoteForProjectSession(
  projectId: string,
  sessionId: string,
  expected: ChatQuoteTarget | null,
): boolean {
  if (expected === null || expected.session_id !== sessionId) return false
  if (chatContextProjectId === projectId) {
    const current = state.chatQuoteTarget
    if (
      current === null || current.session_id !== sessionId
      || current.index !== expected.index || current.text !== expected.text
    ) return false
    state.chatQuoteTarget = null
    chatSessionsPersist()
    return true
  }
  try { return consumeStoredChatQuote(localStorage, projectId, sessionId, expected) } catch { return false }
}

export function chatUpsertAttachmentForProjectSession(projectId: string, sessionId: string | null, message: ChatMessage): boolean {
  if (sessionId === null || message.attachment === undefined || message.attachment.project_id !== projectId) return false
  const update = (snapshot: ChatProjectSnapshot): boolean => {
    const session = snapshot.sessions.find(candidate => candidate.project_id === projectId && candidate.id === sessionId)
    if (session === undefined) return false
    const index = session.messages.findIndex(candidate => candidate.attachment?.upload_id === message.attachment?.upload_id)
    if (index >= 0) session.messages[index] = message
    else session.messages.push(message)
    session.messages = session.messages.slice(-CHAT_MAX)
    return true
  }
  if (chatContextProjectId === projectId) {
    const snapshot = currentChatSnapshot(projectId)
    if (!update(snapshot)) return false
    if (sessionId === state.chatActiveId) chatSyncActive()
    chatSessionsPersist()
    return true
  }
  try {
    const snapshot = loadChatProjectSnapshot(localStorage, projectId)
    if (!update(snapshot)) return false
    saveChatProjectSnapshot(localStorage, snapshot)
    return true
  } catch { return false }
}


/** Chat transcript search (dsh-web session search feel). */
