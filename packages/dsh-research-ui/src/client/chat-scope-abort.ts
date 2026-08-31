/** Stable identity for one browser-owned Scholar Chat scope. */
export function chatScopeKey(projectId: string, sessionId: string): string {
  return JSON.stringify([projectId, sessionId])
}

/** Single page-lifetime authority for closed Chat sessions and projects. */
export class ChatScopeTombstoneRegistry {
  private readonly closedScopes = new Set<string>()
  private readonly closedProjects = new Set<string>()

  closed(projectId: string, sessionId: string): boolean {
    return this.closedProjects.has(projectId) || this.closedScopes.has(chatScopeKey(projectId, sessionId))
  }

  seal(projectId: string, sessionId: string): void {
    this.closedScopes.add(chatScopeKey(projectId, sessionId))
  }

  sealProject(projectId: string): void {
    this.closedProjects.add(projectId)
  }
}

export const chatScopeTombstoneRegistry = new ChatScopeTombstoneRegistry()

/**
 * Resource-local AbortController ownership backed by the page-lifetime shared
 * tombstone authority. Turns and attachments keep independent in-flight maps,
 * while a closed session/project is observed consistently by every resource.
 */
export class ChatScopeAbortRegistry {
  private readonly flights = new Map<string, { projectId: string; controller: AbortController }>()

  constructor(private readonly tombstones = new ChatScopeTombstoneRegistry()) {}

  active(projectId: string, sessionId: string): boolean {
    return this.flights.has(chatScopeKey(projectId, sessionId))
  }

  anyActive(): boolean {
    return this.flights.size > 0
  }

  projectIds(): string[] {
    return [...new Set([...this.flights.values()].map(flight => flight.projectId))]
  }

  beginExclusive(projectId: string, sessionId: string): boolean {
    const key = chatScopeKey(projectId, sessionId)
    if (this.tombstones.closed(projectId, sessionId) || this.flights.has(key)) return false
    this.flights.set(key, { projectId, controller: new AbortController() })
    return true
  }

  signalOrBegin(projectId: string, sessionId: string): AbortSignal | undefined {
    const key = chatScopeKey(projectId, sessionId)
    if (this.tombstones.closed(projectId, sessionId)) return undefined
    let flight = this.flights.get(key)
    if (flight === undefined) {
      flight = { projectId, controller: new AbortController() }
      this.flights.set(key, flight)
    }
    return flight.controller.signal
  }

  signal(projectId: string, sessionId: string): AbortSignal | undefined {
    return this.flights.get(chatScopeKey(projectId, sessionId))?.controller.signal
  }

  end(projectId: string, sessionId: string): boolean {
    return this.flights.delete(chatScopeKey(projectId, sessionId))
  }

  seal(projectId: string, sessionId: string): boolean {
    const key = chatScopeKey(projectId, sessionId)
    this.tombstones.seal(projectId, sessionId)
    const flight = this.flights.get(key)
    if (flight === undefined) return false
    this.flights.delete(key)
    flight.controller.abort()
    return true
  }

  sealProject(projectId: string): number {
    this.tombstones.sealProject(projectId)
    let cancelled = 0
    for (const [key, flight] of this.flights) {
      if (flight.projectId !== projectId) continue
      this.flights.delete(key)
      flight.controller.abort()
      cancelled += 1
    }
    return cancelled
  }
}
