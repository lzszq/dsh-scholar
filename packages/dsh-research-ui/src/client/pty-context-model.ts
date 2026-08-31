import type { PtyResult, PtySessionWire } from './pty-session-model'

export type PtyContextKind = 'research' | 'chat' | 'subagent'
export type PtyTargetKind = 'local-process' | 'local-docker' | 'remote-ssh'

export interface PtyContextDescriptor {
  context_kind: PtyContextKind
  context_id: string
  project_id: string
  parent_session_id: string | null
  runner_profile_id: string
  runner_target_id: string
  target_kind: PtyTargetKind
}

export interface PtyContextSessionsWire {
  context: PtyContextDescriptor
  sessions: PtySessionWire[]
  active_hint: string | null
}

export interface PtyContextTransport {
  listContexts(projectId: string): Promise<PtyResult<PtyContextDescriptor[]>>
  listSessions(contextId: string): Promise<PtyResult<PtyContextSessionsWire>>
}

/** Context/tab selection is independent of a live terminal controller. It
 * prevents a context switch from retaining the previous input target and
 * validates server active hints against the exact returned context. */
export class PtyContextTabsModel {
  readonly transport: PtyContextTransport
  contexts: PtyContextDescriptor[] = []
  selectedContextId: string | null = null
  lastError: { code: string; status: number } | null = null

  private readonly sessionsById = new Map<string, PtySessionWire>()
  private readonly sessionIdsByContext = new Map<string, string[]>()
  private readonly activeByContext = new Map<string, string | null>()

  constructor(transport: PtyContextTransport) {
    this.transport = transport
  }

  get selectedContext(): PtyContextDescriptor | null {
    return this.contexts.find(context => context.context_id === this.selectedContextId) ?? null
  }

  get activeSessionId(): string | null {
    return this.selectedContextId === null ? null : (this.activeByContext.get(this.selectedContextId) ?? null)
  }

  get activeSession(): PtySessionWire | null {
    const id = this.activeSessionId
    return id === null ? null : (this.sessionsById.get(id) ?? null)
  }

  sessions(contextId: string = this.selectedContextId ?? ''): PtySessionWire[] {
    return (this.sessionIdsByContext.get(contextId) ?? [])
      .map(id => this.sessionsById.get(id))
      .filter((session): session is PtySessionWire => session !== undefined)
  }

  session(sessionId: string): PtySessionWire | null {
    return this.sessionsById.get(sessionId) ?? null
  }

  async loadProject(projectId: string): Promise<boolean> {
    this.selectedContextId = null
    this.contexts = []
    this.sessionsById.clear()
    this.sessionIdsByContext.clear()
    this.activeByContext.clear()
    const result = await this.transport.listContexts(projectId)
    if (!result.ok) {
      this.lastError = { code: result.error.code ?? 'http_error', status: result.error.status ?? 0 }
      return false
    }
    this.contexts = result.data.filter(context => context.project_id === projectId)
    this.lastError = null
    return true
  }

  async selectContext(contextId: string): Promise<boolean> {
    const context = this.contexts.find(item => item.context_id === contextId)
    if (context === undefined) throw new Error('unknown PTY context')

    // Clear the active input target before any asynchronous load. A delayed
    // response can never leave the previous context controllable.
    this.selectedContextId = contextId
    this.activeByContext.set(contextId, null)
    const result = await this.transport.listSessions(contextId)
    if (this.selectedContextId !== contextId) return false
    if (!result.ok) {
      this.lastError = { code: result.error.code ?? 'http_error', status: result.error.status ?? 0 }
      return false
    }
    if (result.data.context.context_id !== contextId
      || result.data.context.project_id !== context.project_id
      || result.data.context.context_kind !== context.context_kind
      || result.data.context.parent_session_id !== context.parent_session_id) {
      this.lastError = { code: 'pty_context_mismatch', status: 409 }
      return false
    }

    const ids: string[] = []
    for (const session of result.data.sessions) {
      if (session.context_id !== contextId
        || session.project_id !== context.project_id
        || session.context_kind !== context.context_kind
        || session.parent_session_id !== context.parent_session_id) {
        this.lastError = { code: 'pty_context_mismatch', status: 409 }
        return false
      }
      this.sessionsById.set(session.pty_session_id, session)
      ids.push(session.pty_session_id)
    }
    this.sessionIdsByContext.set(contextId, ids)
    const hint = result.data.active_hint
    this.activeByContext.set(contextId, hint !== null && ids.includes(hint) ? hint : (ids[0] ?? null))
    this.lastError = null
    return true
  }

  selectSession(sessionId: string): void {
    const contextId = this.selectedContextId
    if (contextId === null) throw new Error('no PTY context is selected')
    const session = this.sessionsById.get(sessionId)
    if (session === undefined) throw new Error('unknown PTY session')
    if (session.context_id !== contextId) throw new Error('cannot select a session from another PTY context')
    this.activeByContext.set(contextId, sessionId)
  }

  /** Fold a freshly opened session into its exact context and make it active. */
  addOpened(session: PtySessionWire): void {
    const contextId = this.selectedContextId
    if (contextId === null || session.context_id !== contextId) {
      throw new Error('opened PTY does not belong to the selected context')
    }
    this.sessionsById.set(session.pty_session_id, session)
    const ids = this.sessionIdsByContext.get(contextId) ?? []
    this.sessionIdsByContext.set(contextId, [session.pty_session_id, ...ids.filter(id => id !== session.pty_session_id)])
    this.activeByContext.set(contextId, session.pty_session_id)
  }
}
