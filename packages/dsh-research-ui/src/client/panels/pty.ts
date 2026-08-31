/**
 * PTY-01 Interactive Terminal panel (hardening §5 P1, execution-runtime.md
 * §6.1): DOM assembly over pty-session-model.ts — the pure client logic
 * layer (state machine, control queue with client_seq idempotency, frames
 * consumption with after_seq/gap/retention, detach/reconnect generation,
 * lease-invalid handling). The panel is wired into the More navigation
 * (#tab=pty stable deep link) and renders:
 *
 *   - the open form: workspace picker (GET /v1/projects/{id}/workspaces),
 *     shell preset, relative cwd, cols/rows, pinned profile/target chips;
 *   - the session toolbar: resize, INT/TERM/KILL signals, detach/reconnect,
 *     close;
 *   - a real xterm-compatible Web Terminal: keyboard/paste/IME input is
 *     forwarded as PTY bytes, ANSI/VT and alternate-screen output is rendered
 *     incrementally, and container changes automatically resize the PTY;
 *   - the status line: session state, in/out seq, masked lease + expiry,
 *     generation, byte totals, frames-consumption copy (SSE stream
 *     connecting/live/reconnecting/disconnected or poll fallback —
 *     client/sse-client.ts), close-reason notices and stable error copy.
 *
 * All chrome copy goes through the `pty` i18n namespace (zh/en parity);
 * wire codes and enum values are displayed via mapped keys, never raw.
 */
import { Terminal, type ITheme } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { apiResult, authHeaders, base } from '../api'
import { t } from '../i18n/index'
import { el } from '../ui'
import {
  PtyClientModel, ptyStatusView,
  type PtyControlFrame, type PtyErrorEnvelope, type PtyFramesPageWire,
  type PtyDisplayEntry, type PtyOpenParams, type PtyPreset, type PtyResult, type PtySessionWire,
  type PtySignal, type PtyStreamTransport, type PtyTransport,
} from '../pty-session-model'
import {
  PtyContextTabsModel,
  type PtyContextDescriptor,
  type PtyContextSessionsWire,
  type PtyContextTransport,
} from '../pty-context-model'
import { createWebTerminalAdapter, type WebTerminalAdapter } from '../web-terminal-adapter'
import type { SseFetch } from '../sse-client'
import type { Projection, WorkspaceInfoLite } from '../types'

/** Preset allowlist — the only argv a PTY may ever run (server-enforced). */
const PRESETS: readonly PtyPreset[] = ['sh', 'bash', 'zsh', 'fish']
const SIGNALS: readonly PtySignal[] = ['INT', 'TERM', 'KILL']

/** Open-form selections (survive structural re-paints / locale switches). */
interface PtyFormState {
  workspaceId: string
  label: string
  purpose: string
  preset: PtyPreset
  cwd: string
  cols: string
  rows: string
}

interface PtyPanelState {
  context: PtyContextDescriptor
  models: Map<string, PtyClientModel>
  activeSessionId: string | null
  draftModel: PtyClientModel
  /** GET /v1/projects/{id}/workspaces result (lazy, per project). */
  workspaces: WorkspaceInfoLite[] | null
  workspacesLoading: boolean
  openInflight: boolean
  form: PtyFormState
  live: PtyLiveRefs | null
  rerender: (() => void) | null
}

/** Per-context panel state. A project may own many independent Research,
 * Chat and Subagent contexts; terminal input is never keyed by project. */
const panelStates = new Map<string, PtyPanelState>()

interface PtyProjectContextsState {
  tabs: PtyContextTabsModel
  loading: boolean
  loaded: boolean
}

const projectContexts = new Map<string, PtyProjectContextsState>()

function newSessionModel(): PtyClientModel {
  return new PtyClientModel({
    transport: ptyTransport(),
    stream: ptyStreamTransport(),
    pollIntervalMs: 1000,
    sessionRefreshEvery: 10,
    maxControlRetries: 3,
    maxDisplayFrames: 3000,
  })
}

function activeModel(st: PtyPanelState): PtyClientModel {
  return st.activeSessionId === null ? st.draftModel : (st.models.get(st.activeSessionId) ?? st.draftModel)
}

/** Live DOM refs for in-place stream/status paints between full renders. */
interface PtyLiveRefs {
  body: HTMLElement
  panel: HTMLElement
  sessionId: string
  terminal: Terminal
  terminalAdapter: WebTerminalAdapter
  terminalHost: HTMLElement
  terminalMeta: HTMLElement
  resizeObserver: ResizeObserver | null
  resizeFrame: number | null
  status: HTMLElement
  notice: HTMLElement
  error: HTMLElement
  sessionChip: HTMLElement
  note: HTMLElement
  resizeBtn: HTMLElement
  signalButtons: Map<PtySignal, HTMLElement>
  detachBtn: HTMLElement
  attachBtn: HTMLElement
  closeBtn: HTMLButtonElement
  reopenBtn: HTMLElement
}

function disposeTerminalView(st: PtyPanelState): void {
  const live = st.live
  if (live === null) return
  st.live = null
  activeModel(st).onChange = null
  live.resizeObserver?.disconnect()
  if (live.resizeFrame !== null) cancelAnimationFrame(live.resizeFrame)
  live.terminalAdapter.dispose()
}

/** Tab-leave hygiene (index.ts): every open session detaches (the process
 *  keeps running server-side; the next visit reconnects via after_seq). */
export function ptyPanelDetachAll(): void {
  for (const st of panelStates.values()) {
    for (const model of st.models.values()) {
      if (model.state === 'open') void model.detach()
    }
    if (st.draftModel.state === 'open') void st.draftModel.detach()
    disposeTerminalView(st)
  }
}

function ensureState(context: PtyContextDescriptor): PtyPanelState {
  let st = panelStates.get(context.context_id)
  if (st === undefined) {
    st = {
      context,
      models: new Map(),
      activeSessionId: null,
      draftModel: newSessionModel(),
      workspaces: null,
      workspacesLoading: false,
      openInflight: false,
      form: { workspaceId: '', label: '', purpose: '', preset: 'bash', cwd: '', cols: '80', rows: '24' },
      live: null,
      rerender: null,
    }
    panelStates.set(context.context_id, st)
  } else {
    st.context = context
  }
  return st
}

/* ─────────────────────── real transport (apiResult) ─────────────────────── */

function mapResult<T>(r: { ok: true; data: T; status: number } | { ok: false; error: { code?: string; message?: string; retryable?: boolean }; status: number }): PtyResult<T> {
  if (r.ok) return { ok: true, data: r.data }
  const error: PtyErrorEnvelope = {
    code: r.error.code,
    message: r.error.message,
    status: r.status,
    retryable: r.error.retryable,
  }
  return { ok: false, error }
}

/** The BFF forwards /v1/pty/sessions/* and injects the operator identity;
 *  the lease token (x-pty-lease) is passed through for the kernel to verify
 *  (never stored, never rendered in full). */
function ptyTransport(): PtyTransport {
  return {
    async open(params: PtyOpenParams): Promise<PtyResult<PtySessionWire>> {
      return mapResult(await apiResult<PtySessionWire>('/v1/pty/sessions', {
        method: 'POST',
        body: JSON.stringify(params),
      }))
    },
    async attach(sessionId: string, lease: string, expectedGeneration: number): Promise<PtyResult<PtySessionWire>> {
      return mapResult(await apiResult<PtySessionWire>(
        `/v1/pty/sessions/${encodeURIComponent(sessionId)}/attach`,
        { method: 'POST', headers: { 'x-pty-lease': lease }, body: JSON.stringify({ expected_generation: expectedGeneration }) },
      ))
    },
    async detach(sessionId: string, lease: string, expectedGeneration: number): Promise<PtyResult<PtySessionWire>> {
      return mapResult(await apiResult<PtySessionWire>(
        `/v1/pty/sessions/${encodeURIComponent(sessionId)}/detach`,
        { method: 'POST', headers: { 'x-pty-lease': lease }, body: JSON.stringify({ expected_generation: expectedGeneration }) },
      ))
    },
    async close(sessionId: string, lease: string, expectedGeneration: number): Promise<PtyResult<PtySessionWire>> {
      return mapResult(await apiResult<PtySessionWire>(
        `/v1/pty/sessions/${encodeURIComponent(sessionId)}`,
        { method: 'DELETE', headers: { 'x-pty-lease': lease }, body: JSON.stringify({ expected_generation: expectedGeneration }) },
      ))
    },
    async getSession(sessionId: string, lease: string, expectedGeneration: number): Promise<PtyResult<PtySessionWire>> {
      return mapResult(await apiResult<PtySessionWire>(
        `/v1/pty/sessions/${encodeURIComponent(sessionId)}?expected_generation=${expectedGeneration}`,
        { headers: { 'x-pty-lease': lease } },
      ))
    },
    async control(sessionId: string, lease: string, frame: PtyControlFrame): Promise<PtyResult<{ delivered?: boolean; idempotent?: boolean }>> {
      return mapResult(await apiResult<{ delivered?: boolean; idempotent?: boolean }>(
        `/v1/pty/sessions/${encodeURIComponent(sessionId)}/control`,
        {
          method: 'POST',
          headers: { 'x-pty-lease': lease },
          body: JSON.stringify(frame),
        },
      ))
    },
    async frames(sessionId: string, lease: string, afterSeq: number, expectedGeneration: number): Promise<PtyResult<PtyFramesPageWire>> {
      return mapResult(await apiResult<PtyFramesPageWire>(
        `/v1/pty/sessions/${encodeURIComponent(sessionId)}/frames?after_seq=${afterSeq}&expected_generation=${expectedGeneration}`,
        { headers: { 'x-pty-lease': lease } },
      ))
    },
  }
}

function ptyContextTransport(): PtyContextTransport {
  return {
    async listContexts(projectId: string): Promise<PtyResult<PtyContextDescriptor[]>> {
      return mapResult(await apiResult<PtyContextDescriptor[]>(
        `/v1/pty/contexts?project_id=${encodeURIComponent(projectId)}`,
      ))
    },
    async listSessions(contextId: string): Promise<PtyResult<PtyContextSessionsWire>> {
      return mapResult(await apiResult<PtyContextSessionsWire>(
        `/v1/pty/contexts/${encodeURIComponent(contextId)}/sessions`,
      ))
    },
  }
}

function ensureProjectContexts(projectId: string): PtyProjectContextsState {
  let state = projectContexts.get(projectId)
  if (state === undefined) {
    state = { tabs: new PtyContextTabsModel(ptyContextTransport()), loading: false, loaded: false }
    projectContexts.set(projectId, state)
  }
  return state
}

/** SSE frames-stream transport (client/sse-client.ts): the authenticated
 *  fetch wrapper — the model supplies the x-pty-lease header per connect
 *  and builds the after_seq URL itself. When the stream gives up (max
 *  reconnect attempts) the model falls back to the frames POLL above. */
function ptyStreamTransport(): PtyStreamTransport {
  const streamFetch: SseFetch = async (url, init) => {
    const response = await fetch(`${base()}${url}`, {
      ...init,
      headers: {
        ...(init.headers ?? {}),
        accept: 'text/event-stream',
        ...(await authHeaders()),
      },
    })
    return { ok: response.ok, status: response.status, body: response.body }
  }
  return {
    fetch: streamFetch,
    maxReconnectAttempts: 5,
  }
}

/* ────────────────────────────── paint helpers ────────────────────────────── */

function outputRow(entry: PtyDisplayEntry, model: PtyClientModel): HTMLElement {
  const row = el('div')
  row.style.cssText = 'white-space:pre'
  if (entry.kind === 'gap') {
    row.style.cssText += ';color:var(--tone-amber);font-weight:700'
    row.textContent = entry.gapFrom !== undefined && entry.gapTo !== undefined && entry.gapTo >= entry.gapFrom
      ? t('pty', 'pty.gap.frames', { from: String(entry.gapFrom), to: String(entry.gapTo), count: String(entry.droppedFrames ?? 0) })
      : t('pty', 'pty.gap.warning', { dropped: String(entry.droppedBytes ?? 0), retained: String(model.retainedFromSeq) })
  } else if (entry.kind === 'exit') {
    row.style.cssText += ';color:var(--text-3);font-weight:700'
    row.textContent = ptyStatusView(model).exitText
  }
  return row
}

/** Retention gaps and process exit are UI metadata, never ANSI input. */
function paintTerminalMeta(metaEl: HTMLElement, model: PtyClientModel): void {
  metaEl.replaceChildren()
  for (const entry of model.display) {
    if (entry.kind !== 'output') metaEl.appendChild(outputRow(entry, model))
  }
  metaEl.style.display = metaEl.childElementCount > 0 ? '' : 'none'
}

function paintStatusLine(statusEl: HTMLElement, model: PtyClientModel): void {
  const view = ptyStatusView(model)
  const parts = [view.stateText, view.seqText, view.leaseText, view.generationText, view.bytesText, view.streamText].filter(p => p !== '')
  statusEl.textContent = parts.join(' · ')
  statusEl.style.color = view.state === 'open'
    ? 'var(--tone-green)'
    : (view.state === 'error' ? 'var(--tone-red)' : 'var(--text-3)')
}

/** In-place dynamic paint (model.onChange): output stream + status line +
 *  notices + toolbar enablement — no structural rebuild (the 8s panel
 *  refresh re-paints structure). */
function terminalTheme(body: HTMLElement): ITheme {
  const styles = getComputedStyle(body)
  const color = (name: string, fallback: string): string => styles.getPropertyValue(name).trim() || fallback
  return {
    background: color('--bg-3', '#1b1b1c'),
    foreground: color('--text', '#f9fafb'),
    cursor: color('--text', '#f9fafb'),
    cursorAccent: color('--bg-3', '#1b1b1c'),
    selectionBackground: color('--accent-soft', '#34415b'),
    black: '#151517',
    red: color('--tone-red', '#f87171'),
    green: color('--tone-green', '#34d399'),
    yellow: color('--tone-amber', '#fbbf24'),
    blue: color('--tone-blue', '#4d9fff'),
    magenta: color('--tone-violet', '#a78bfa'),
    cyan: color('--tone-cyan', '#22d3ee'),
    white: color('--text', '#f9fafb'),
  }
}

function paintDynamic(st: PtyPanelState): void {
  const model = activeModel(st)
  const refs = st.live
  if (refs === null) return
  refs.terminalAdapter.render(model.display)
  paintTerminalMeta(refs.terminalMeta, model)
  paintStatusLine(refs.status, model)
  const view = ptyStatusView(model)
  refs.terminal.options.disableStdin = view.state !== 'open'
  refs.terminal.options.theme = terminalTheme(refs.body)
  refs.terminalHost.setAttribute('aria-label', t('pty', 'pty.streamAria'))
  refs.sessionChip.textContent = t('pty', 'pty.status.session', { id: model.sessionId ?? '' })
  refs.note.textContent = t('pty', 'pty.ansi.note')
  refs.detachBtn.textContent = t('pty', 'pty.action.detach')
  refs.detachBtn.title = t('pty', 'pty.action.detach')
  refs.attachBtn.textContent = t('pty', 'pty.action.attach')
  refs.attachBtn.title = t('pty', 'pty.action.attach')
  refs.closeBtn.textContent = t('pty', 'pty.action.close')
  refs.closeBtn.title = t('pty', 'pty.action.close')
  refs.reopenBtn.textContent = t('pty', 'pty.action.reopen')
  refs.reopenBtn.title = t('pty', 'pty.action.reopen')
  refs.resizeBtn.textContent = t('pty', 'pty.action.resize')
  for (const [signal, button] of refs.signalButtons) {
    button.textContent = t('pty', 'pty.action.signal', { signal })
  }
  refs.notice.textContent = view.noticeText
  refs.notice.style.display = view.noticeText !== '' ? '' : 'none'
  const errText = view.errorText !== '' ? view.errorText : view.controlErrorText
  refs.error.textContent = errText
  refs.error.style.display = errText !== '' ? '' : 'none'
  refs.detachBtn.style.display = view.state === 'open' ? '' : 'none'
  refs.attachBtn.style.display = view.state === 'detached' ? '' : 'none'
  refs.reopenBtn.style.display = view.state === 'closed' ? '' : 'none'
  refs.closeBtn.disabled = view.state !== 'open' && view.state !== 'detached'
  refs.closeBtn.style.opacity = refs.closeBtn.disabled ? '.45' : ''
}

/* ────────────────────────────── open form ────────────────────────────── */

async function loadWorkspaces(st: PtyPanelState, projectId: string): Promise<void> {
  if (st.workspaces !== null || st.workspacesLoading) return
  st.workspacesLoading = true
  const list = await apiResult<WorkspaceInfoLite[]>(`/v1/projects/${encodeURIComponent(projectId)}/workspaces`)
  st.workspacesLoading = false
  if (list.ok && Array.isArray(list.data)) st.workspaces = list.data
}

function paintOpenForm(body: HTMLElement, st: PtyPanelState, projection: Projection, projectId: string): void {
  const model = activeModel(st)
  disposeTerminalView(st)
  body.replaceChildren()
  const panel = el('div')
  const view = ptyStatusView(model)
  if (model.state === 'error' && model.lastError !== null) {
    const banner = el('div', 'error-banner')
    banner.textContent = view.errorText
    const reopen = el('button', 'hbtn', t('pty', 'pty.action.reopen'))
    reopen.style.cssText = 'margin-left:8px'
    reopen.onclick = () => { void model.reopen().then(() => paintFull(body, st, projection, projectId)) }
    banner.appendChild(reopen)
    panel.appendChild(banner)
  }

  const card = el('div', 'card')
  card.style.cssText = 'max-width:680px;margin:0'
  card.appendChild(el('div', 'section-label', t('pty', 'pty.form.title')))
  const desc = el('div', 'muted', t('pty', 'pty.form.desc'))
  desc.style.cssText = 'font-size:10.5px;margin-bottom:10px;max-width:620px'
  card.appendChild(desc)

  const labelRow = el('div', 'row')
  labelRow.style.cssText = 'align-items:center;gap:8px;margin-bottom:8px;flex-wrap:wrap'
  const labelText = el('span', '', t('pty', 'pty.form.label'))
  labelText.style.cssText = 'width:110px;color:var(--text-2);font-size:11px;flex-shrink:0'
  const labelInput = document.createElement('input')
  labelInput.type = 'text'
  labelInput.maxLength = 96
  labelInput.value = st.form.label
  labelInput.placeholder = t('pty', 'pty.form.labelPlaceholder')
  labelInput.style.cssText = 'flex:1;min-width:200px;background:var(--bg-input);color:var(--text);border:1px solid var(--border);border-radius:8px;padding:5px 8px;font:11px/1.4 system-ui,sans-serif;outline:none'
  labelInput.oninput = () => { st.form.label = labelInput.value }
  labelRow.append(labelText, labelInput)
  card.appendChild(labelRow)

  const purposeRow = el('div', 'row')
  purposeRow.style.cssText = 'align-items:center;gap:8px;margin-bottom:8px;flex-wrap:wrap'
  const purposeText = el('span', '', t('pty', 'pty.form.purpose'))
  purposeText.style.cssText = 'width:110px;color:var(--text-2);font-size:11px;flex-shrink:0'
  const purposeInput = document.createElement('input')
  purposeInput.type = 'text'
  purposeInput.maxLength = 512
  purposeInput.value = st.form.purpose
  purposeInput.placeholder = t('pty', 'pty.form.purposePlaceholder')
  purposeInput.style.cssText = labelInput.style.cssText
  purposeInput.oninput = () => { st.form.purpose = purposeInput.value }
  purposeRow.append(purposeText, purposeInput)
  card.appendChild(purposeRow)

  // workspace picker (WORK-01 GET /v1/projects/{id}/workspaces).
  const wsRow = el('div', 'row')
  wsRow.style.cssText = 'align-items:center;gap:8px;margin-bottom:8px;flex-wrap:wrap'
  const wsLabel = el('span', '', t('pty', 'pty.form.workspace'))
  wsLabel.style.cssText = 'width:110px;color:var(--text-2);font-size:11px;flex-shrink:0'
  const wsSelect = el('select', 'picker')
  wsSelect.style.cssText = 'flex:1;min-width:200px;margin:0;padding:5px 8px;font-size:11px'
  wsSelect.setAttribute('aria-label', t('pty', 'pty.form.workspaceAria'))
  const wsPlaceholder = el('option', '', t('pty', 'pty.form.workspace'))
  wsPlaceholder.value = ''
  wsSelect.appendChild(wsPlaceholder)
  if (st.workspaces === null) {
    void loadWorkspaces(st, projectId).then(() => { const model = activeModel(st); if (model.state === 'idle' || model.state === 'error') paintFull(body, st, projection, projectId) })
  }
  for (const ws of st.workspaces ?? []) {
    const opt = el('option', '', `${ws.kind} · ${ws.name}`)
    opt.value = ws.workspace_id
    wsSelect.appendChild(opt)
  }
  if (st.workspaces !== null && st.workspaces.length === 0) {
    const empty = el('div', 'empty', t('pty', 'pty.form.workspaceEmpty'))
    empty.style.cssText = 'flex:1;padding:4px 2px'
    wsRow.append(wsLabel, empty)
  } else {
    wsSelect.value = st.form.workspaceId
    wsSelect.onchange = () => { st.form.workspaceId = wsSelect.value }
    wsRow.append(wsLabel, wsSelect)
  }
  card.appendChild(wsRow)

  // preset select.
  const presetRow = el('div', 'row')
  presetRow.style.cssText = 'align-items:center;gap:8px;margin-bottom:8px;flex-wrap:wrap'
  const presetLabel = el('span', '', t('pty', 'pty.form.preset'))
  presetLabel.style.cssText = 'width:110px;color:var(--text-2);font-size:11px;flex-shrink:0'
  const presetSelect = el('select', 'picker')
  presetSelect.style.cssText = 'flex:1;min-width:120px;margin:0;padding:5px 8px;font-size:11px'
  presetSelect.setAttribute('aria-label', t('pty', 'pty.form.presetAria'))
  for (const preset of PRESETS) {
    const opt = el('option', '', preset)
    opt.value = preset
    presetSelect.appendChild(opt)
  }
  presetSelect.value = st.form.preset
  presetSelect.onchange = () => { st.form.preset = presetSelect.value as PtyPreset }
  presetRow.append(presetLabel, presetSelect)
  card.appendChild(presetRow)

  // cwd input (root-relative; '' = workspace root).
  const cwdRow = el('div', 'row')
  cwdRow.style.cssText = 'align-items:center;gap:8px;margin-bottom:8px;flex-wrap:wrap'
  const cwdLabel = el('span', '', t('pty', 'pty.form.cwd'))
  cwdLabel.style.cssText = 'width:110px;color:var(--text-2);font-size:11px;flex-shrink:0'
  const cwdInput = document.createElement('input')
  cwdInput.type = 'text'
  cwdInput.value = st.form.cwd
  cwdInput.placeholder = t('pty', 'pty.form.cwdPlaceholder')
  cwdInput.style.cssText = 'flex:1;min-width:200px;background:var(--bg-input);color:var(--text);border:1px solid var(--border);border-radius:8px;padding:5px 8px;font:11px/1.4 system-ui,sans-serif;outline:none'
  cwdInput.oninput = () => { st.form.cwd = cwdInput.value }
  cwdRow.append(cwdLabel, cwdInput)
  card.appendChild(cwdRow)

  // cols/rows.
  const sizeRow = el('div', 'row')
  sizeRow.style.cssText = 'align-items:center;gap:8px;margin-bottom:8px;flex-wrap:wrap'
  const sizeLabel = el('span', '', t('pty', 'pty.form.cols'))
  sizeLabel.style.cssText = 'width:110px;color:var(--text-2);font-size:11px;flex-shrink:0'
  const colsInput = document.createElement('input')
  colsInput.type = 'number'
  colsInput.min = '1'
  colsInput.max = '500'
  colsInput.value = st.form.cols
  colsInput.style.cssText = 'width:64px;background:var(--bg-input);color:var(--text);border:1px solid var(--border);border-radius:8px;padding:5px 8px;font:11px/1.4 ui-monospace,Menlo,monospace;outline:none'
  colsInput.oninput = () => { st.form.cols = colsInput.value }
  const x = el('span', 'muted', '×')
  const rowsInput = document.createElement('input')
  rowsInput.type = 'number'
  rowsInput.min = '1'
  rowsInput.max = '300'
  rowsInput.value = st.form.rows
  rowsInput.style.cssText = 'width:64px;background:var(--bg-input);color:var(--text);border:1px solid var(--border);border-radius:8px;padding:5px 8px;font:11px/1.4 ui-monospace,Menlo,monospace;outline:none'
  rowsInput.oninput = () => { st.form.rows = rowsInput.value }
  const rowsLabel = el('span', '', t('pty', 'pty.form.rows'))
  rowsLabel.style.cssText = 'color:var(--text-2);font-size:11px'
  sizeRow.append(sizeLabel, colsInput, x, rowsInput, rowsLabel)
  card.appendChild(sizeRow)

  // pinned profile/target (opaque ids resolved server-side).
  const pinnedRow = el('div', 'row')
  pinnedRow.style.cssText = 'align-items:center;gap:8px;margin-bottom:10px;flex-wrap:wrap'
  const profile = st.context.runner_profile_id
  const target = st.context.runner_target_id
  const profileChip = el('span', 'artifact-kind', `${t('pty', 'pty.form.profile')}: ${profile}`)
  const targetChip = el('span', 'artifact-kind', `${t('pty', 'pty.form.target')}: ${target}`)
  pinnedRow.append(profileChip, targetChip)
  card.appendChild(pinnedRow)

  const openBtn = el('button', 'btn approve', st.openInflight ? t('pty', 'pty.form.opening') : t('pty', 'pty.form.open'))
  openBtn.style.cssText = 'padding:7px 20px'
  openBtn.disabled = st.openInflight
  openBtn.onclick = () => {
    const wsId = st.form.workspaceId !== '' ? st.form.workspaceId : (st.workspaces?.[0]?.workspace_id ?? '')
    if (wsId === '' || st.form.label.trim() === '') return
    const params: PtyOpenParams = {
      context_id: st.context.context_id,
      workspace_id: wsId,
      label: st.form.label.trim(),
      purpose: st.form.purpose.trim(),
      preset: st.form.preset,
      cwd: st.form.cwd.trim() !== '' ? st.form.cwd.trim() : '.',
      cols: Math.max(1, Math.min(500, Number(st.form.cols) || 80)),
      rows: Math.max(1, Math.min(300, Number(st.form.rows) || 24)),
    }
    st.openInflight = true
    openBtn.disabled = true
    openBtn.textContent = t('pty', 'pty.form.opening')
    void model.open(params).then(opened => {
      st.openInflight = false
      if (opened && model.sessionId !== null) {
        st.models.set(model.sessionId, model)
        st.activeSessionId = model.sessionId
      }
      if (st.rerender !== null) st.rerender()
      else paintFull(body, st, projection, projectId)
    })
  }
  card.appendChild(openBtn)
  panel.appendChild(card)
  body.appendChild(panel)
}

/* ────────────────────────────── session view ────────────────────────────── */

function paintSession(body: HTMLElement, st: PtyPanelState, projection: Projection, projectId: string): void {
  const model = activeModel(st)
  const view = ptyStatusView(model)
  const sessionId = model.sessionId ?? ''
  const existing = st.live
  if (existing !== null && existing.body === body && existing.sessionId === sessionId && body.contains(existing.panel)) {
    paintDynamic(st)
    existing.terminalAdapter.fit()
    if (model.state === 'detached' && model.hasSession) model.reconnect()
    return
  }
  disposeTerminalView(st)
  body.replaceChildren()
  const panel = el('div')
  panel.dataset.webTerminalSession = sessionId
  panel.style.cssText = 'display:flex;flex-direction:column;min-height:300px;height:min(66vh,620px)'

  // toolbar row 1: session identity + lifecycle actions.
  const toolbar = el('div', 'row')
  toolbar.style.cssText = 'align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:6px'
  const sessionChip = el('span', 'artifact-kind', t('pty', 'pty.status.session', { id: sessionId }))
  const detachBtn = el('button', 'hbtn', t('pty', 'pty.action.detach'))
  detachBtn.title = t('pty', 'pty.action.detach')
  detachBtn.onclick = () => { void model.detach().then(() => paintFull(body, st, projection, projectId)) }
  const attachBtn = el('button', 'hbtn', t('pty', 'pty.action.attach'))
  attachBtn.title = t('pty', 'pty.action.attach')
  attachBtn.onclick = () => { void model.reconnect().then(() => paintFull(body, st, projection, projectId)) }
  const closeBtn = el('button', 'hbtn', t('pty', 'pty.action.close'))
  closeBtn.title = t('pty', 'pty.action.close')
  closeBtn.onclick = () => { void model.close().then(() => paintFull(body, st, projection, projectId)) }
  const reopenBtn = el('button', 'hbtn', t('pty', 'pty.action.reopen'))
  reopenBtn.title = t('pty', 'pty.action.reopen')
  reopenBtn.onclick = () => { void model.reopen().then(() => paintFull(body, st, projection, projectId)) }
  reopenBtn.style.display = view.state === 'closed' ? '' : 'none'
  toolbar.append(sessionChip, detachBtn, attachBtn, closeBtn, reopenBtn)
  panel.appendChild(toolbar)

  // toolbar row 2: resize + signals.
  const controls = el('div', 'row')
  controls.style.cssText = 'align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:6px'
  const colsInput = document.createElement('input')
  colsInput.type = 'number'
  colsInput.min = '1'
  colsInput.max = '500'
  colsInput.value = String(model.lastOpenParams?.cols ?? 80)
  colsInput.style.cssText = 'width:56px;background:var(--bg-input);color:var(--text);border:1px solid var(--border);border-radius:8px;padding:3px 6px;font:11px/1.4 ui-monospace,Menlo,monospace;outline:none'
  const rowsInput = document.createElement('input')
  rowsInput.type = 'number'
  rowsInput.min = '1'
  rowsInput.max = '300'
  rowsInput.value = String(model.lastOpenParams?.rows ?? 24)
  rowsInput.style.cssText = 'width:56px;background:var(--bg-input);color:var(--text);border:1px solid var(--border);border-radius:8px;padding:3px 6px;font:11px/1.4 ui-monospace,Menlo,monospace;outline:none'
  const resizeBtn = el('button', 'hbtn', t('pty', 'pty.action.resize'))
  resizeBtn.onclick = () => {
    const cols = Number(colsInput.value) || 80
    const rows = Number(rowsInput.value) || 24
    model.resize(cols, rows)
  }
  controls.append(colsInput, el('span', 'muted', '×'), rowsInput, resizeBtn)
  const signalButtons = new Map<PtySignal, HTMLElement>()
  for (const sig of SIGNALS) {
    const btn = el('button', 'hbtn', t('pty', 'pty.action.signal', { signal: sig }))
    btn.style.cssText = 'border-color:var(--tone-amber);color:var(--tone-amber)'
    btn.onclick = () => { model.signal(sig) }
    signalButtons.set(sig, btn)
    controls.appendChild(btn)
  }
  panel.appendChild(controls)

  // Web Terminal boundary note: interactive PTY, not authoritative Run log.
  const note = el('div', 'muted', t('pty', 'pty.ansi.note'))
  note.style.cssText = 'font-size:10px;margin-bottom:6px'
  panel.appendChild(note)

  // xterm viewport. The emulator owns cursor/selection/IME/ANSI/TUI state;
  // only gap and exit metadata is painted in ordinary DOM below it.
  const terminalFrame = el('div', 'web-terminal-frame')
  terminalFrame.style.cssText = 'position:relative;flex:1;min-height:180px;overflow:hidden;background:var(--bg-3);border:1px solid var(--border);border-radius:10px;padding:8px'
  const terminalHost = el('div', 'web-terminal-host')
  terminalHost.style.cssText = 'width:100%;height:100%;min-width:0;min-height:0'
  terminalHost.setAttribute('role', 'application')
  terminalHost.setAttribute('aria-label', t('pty', 'pty.streamAria'))
  terminalFrame.appendChild(terminalHost)
  panel.appendChild(terminalFrame)
  const terminalMeta = el('div')
  terminalMeta.style.cssText = 'display:none;margin-top:5px;font:10px/1.4 ui-monospace,Menlo,monospace'
  terminalMeta.setAttribute('aria-live', 'polite')
  panel.appendChild(terminalMeta)

  // status line + notices + errors.
  const statusRow = el('div', 'row')
  statusRow.style.cssText = 'margin-top:8px;gap:10px;font-size:10px;color:var(--text-3);flex-wrap:wrap'
  const statusEl = el('span', 'artifact-kind', '')
  statusEl.setAttribute('aria-label', t('pty', 'pty.status.aria'))
  paintStatusLine(statusEl, model)
  const noticeEl = el('span', '', '')
  noticeEl.style.cssText = 'color:var(--tone-amber);font-weight:700'
  noticeEl.style.display = view.noticeText !== '' ? '' : 'none'
  noticeEl.textContent = view.noticeText
  statusRow.append(statusEl, noticeEl)
  panel.appendChild(statusRow)
  const errorEl = el('div', 'error-banner')
  errorEl.style.cssText = 'display:none;margin-top:8px'
  const errText = view.errorText !== '' ? view.errorText : view.controlErrorText
  if (errText !== '') {
    errorEl.textContent = errText
    errorEl.style.display = ''
  }
  if (view.controlErrorText !== '' && view.errorText === '') {
    const retry = el('button', 'hbtn', t('pty', 'pty.action.retry'))
    retry.style.cssText = 'margin-left:8px'
    retry.onclick = () => { model.retryControl(); paintFull(body, st, projection, projectId) }
    errorEl.appendChild(retry)
  }
  panel.appendChild(errorEl)

  body.appendChild(panel)

  const terminal = new Terminal({
    allowProposedApi: false,
    allowTransparency: false,
    convertEol: false,
    cursorBlink: true,
    disableStdin: view.state !== 'open',
    drawBoldTextInBrightColors: true,
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
    fontSize: 12,
    lineHeight: 1.2,
    minimumContrastRatio: 4.5,
    rightClickSelectsWord: true,
    screenReaderMode: false,
    scrollback: 3000,
    scrollOnUserInput: true,
    theme: terminalTheme(body),
  })
  const fitAddon = new FitAddon()
  terminal.loadAddon(fitAddon)
  terminal.open(terminalHost)
  const terminalAdapter = createWebTerminalAdapter({
    terminal,
    sendText: text => model.sendText(text),
    resize: (cols, rows) => {
      colsInput.value = String(cols)
      rowsInput.value = String(rows)
      return model.state === 'open' ? model.resize(cols, rows) : false
    },
    fit: () => {
      try { fitAddon.fit() } catch { /* hidden/zero-size surface; next resize retries */ }
    },
  })
  terminalHost.onclick = () => terminalAdapter.focus()

  let liveRef: PtyLiveRefs | null = null
  const scheduleFit = (): void => {
    if (liveRef === null || st.live !== liveRef || liveRef.resizeFrame !== null) return
    liveRef.resizeFrame = requestAnimationFrame(() => {
      if (liveRef === null || st.live !== liveRef) return
      liveRef.resizeFrame = null
      liveRef.terminalAdapter.fit()
    })
  }
  const resizeObserver = typeof ResizeObserver === 'function' ? new ResizeObserver(scheduleFit) : null
  const live: PtyLiveRefs = {
    body,
    panel,
    sessionId,
    terminal,
    terminalAdapter,
    terminalHost,
    terminalMeta,
    resizeObserver,
    resizeFrame: null,
    status: statusEl,
    notice: noticeEl,
    error: errorEl,
    sessionChip,
    note,
    resizeBtn,
    signalButtons,
    detachBtn,
    attachBtn,
    closeBtn,
    reopenBtn,
  }
  liveRef = live
  st.live = live
  resizeObserver?.observe(terminalFrame)
  terminalAdapter.render(model.display)
  paintTerminalMeta(terminalMeta, model)
  scheduleFit()
  model.onChange = () => paintDynamic(st)
  // Reconnect a detached session (tab return): after_seq replay resumes.
    if (model.state === 'detached' && model.hasSession && model.leaseToken !== null) void model.reconnect()
}

/** Full structural paint (tab render / refresh / open-close transitions). */
function paintFull(body: HTMLElement, st: PtyPanelState, projection: Projection, projectId: string): void {
  const model = activeModel(st)
  if (model.state === 'idle' || model.state === 'opening' || model.state === 'error') {
    if (model.state === 'opening') st.openInflight = true
    paintOpenForm(body, st, projection, projectId)
    return
  }
  st.openInflight = false
  paintSession(body, st, projection, projectId)
}

function restoreListedSessions(st: PtyPanelState, sessions: PtySessionWire[]): void {
  for (const session of sessions) {
    if (st.models.has(session.pty_session_id)) continue
    const model = newSessionModel()
    model.restore(session)
    st.models.set(session.pty_session_id, model)
  }
}

function renderSelectedContext(body: HTMLElement, projection: Projection, projectId: string, projectState: PtyProjectContextsState): void {
  const tabs = projectState.tabs
  const context = tabs.selectedContext
  if (context === null) {
    body.replaceChildren(el('div', 'empty', t('pty', 'pty.context.none')))
    return
  }
  const st = ensureState(context)
  restoreListedSessions(st, tabs.sessions(context.context_id))
  if (st.activeSessionId === null && tabs.activeSessionId !== null) st.activeSessionId = tabs.activeSessionId
  st.rerender = () => renderPty(body, projection, projectId)

  body.replaceChildren()
  const contextRow = el('div', 'row')
  contextRow.style.cssText = 'gap:8px;align-items:center;flex-wrap:wrap;margin-bottom:8px'
  const contextSelect = el('select', 'picker')
  contextSelect.style.cssText = 'min-width:220px;margin:0;padding:5px 8px;font-size:11px'
  contextSelect.setAttribute('aria-label', t('pty', 'pty.context.selectAria'))
  for (const item of tabs.contexts) {
    const option = el('option', '', `${item.context_kind} · ${item.context_id}`)
    option.value = item.context_id
    contextSelect.appendChild(option)
  }
  contextSelect.value = context.context_id
  contextSelect.onchange = () => {
    disposeTerminalView(st)
    void tabs.selectContext(contextSelect.value).then(() => renderPty(body, projection, projectId))
  }
  const contextTarget = el('span', 'artifact-kind', `${context.runner_profile_id} · ${context.runner_target_id}`)
  const newButton = el('button', 'hbtn', t('pty', 'pty.context.newTerminal'))
  newButton.onclick = () => {
    disposeTerminalView(st)
    st.activeSessionId = null
    st.draftModel.dispose()
    st.draftModel = newSessionModel()
    st.form.label = ''
    st.form.purpose = ''
    renderPty(body, projection, projectId)
  }
  contextRow.append(contextSelect, contextTarget, newButton)
  body.appendChild(contextRow)

  const sessionRow = el('div', 'row')
  sessionRow.style.cssText = 'gap:6px;align-items:center;flex-wrap:wrap;margin-bottom:8px'
  for (const session of tabs.sessions(context.context_id)) {
    const button = el('button', session.pty_session_id === st.activeSessionId ? 'hbtn active' : 'hbtn', session.label)
    button.title = session.purpose
    button.onclick = () => {
      disposeTerminalView(st)
      tabs.selectSession(session.pty_session_id)
      st.activeSessionId = session.pty_session_id
      renderPty(body, projection, projectId)
    }
    sessionRow.appendChild(button)
  }
  for (const [sessionId, model] of st.models) {
    if (tabs.session(sessionId) !== null || model.sessionId === null) continue
    const button = el('button', sessionId === st.activeSessionId ? 'hbtn active' : 'hbtn', model.lastOpenParams?.label ?? sessionId)
    button.onclick = () => {
      disposeTerminalView(st)
      st.activeSessionId = sessionId
      renderPty(body, projection, projectId)
    }
    sessionRow.appendChild(button)
  }
  body.appendChild(sessionRow)

  const surface = el('div')
  surface.style.cssText = 'min-width:0'
  body.appendChild(surface)
  paintFull(surface, st, projection, projectId)
  const model = activeModel(st)
  if (model.state === 'detached' && model.hasSession && model.leaseToken !== null) void model.reconnect()
}

/** Panel entry: first resolves server-owned Research/Chat/Subagent contexts,
 * then renders independent per-context terminal tabs. */
export function renderPty(body: HTMLElement, projection: Projection, projectId: string): void {
  const state = ensureProjectContexts(projectId)
  if (!state.loaded) {
    if (!state.loading) {
      state.loading = true
      void state.tabs.loadProject(projectId).then(async loaded => {
        state.loading = false
        state.loaded = loaded
        if (loaded && state.tabs.contexts.length > 0) await state.tabs.selectContext(state.tabs.contexts[0]!.context_id)
        renderPty(body, projection, projectId)
      })
    }
    body.replaceChildren(el('div', 'empty', t('pty', 'pty.context.loading')))
    return
  }
  renderSelectedContext(body, projection, projectId, state)
}
