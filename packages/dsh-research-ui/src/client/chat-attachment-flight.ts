/**
 * Page-lifetime cancellation owner for attachment work keyed by the exact
 * project/session pair. Composer remounts reuse the same signal; an explicit
 * session close or project discard tombstones the scope before cancelling it,
 * so delayed Intake/hash/upload continuations cannot acquire a fresh signal.
 */
export class ChatAttachmentFlightStore {
  private readonly flights = new Map<string, { projectId: string; controller: AbortController }>()
  private readonly closedScopes = new Set<string>()
  private readonly closedProjects = new Set<string>()

  private key(projectId: string, sessionId: string): string {
    return JSON.stringify([projectId, sessionId])
  }

  signal(projectId: string, sessionId: string): AbortSignal | undefined {
    const key = this.key(projectId, sessionId)
    if (this.closedProjects.has(projectId) || this.closedScopes.has(key)) return undefined
    let flight = this.flights.get(key)
    if (flight === undefined) {
      flight = { projectId, controller: new AbortController() }
      this.flights.set(key, flight)
    }
    return flight.controller.signal
  }

  projectIds(): string[] {
    return [...new Set([...this.flights.values()].map(flight => flight.projectId))]
  }

  cancel(projectId: string, sessionId: string): boolean {
    const key = this.key(projectId, sessionId)
    this.closedScopes.add(key)
    const flight = this.flights.get(key)
    if (flight === undefined) return false
    this.flights.delete(key)
    flight.controller.abort()
    return true
  }

  cancelProject(projectId: string): number {
    this.closedProjects.add(projectId)
    let cancelled = 0
    for (const [key, flight] of this.flights) {
      if (flight.projectId !== projectId) continue
      this.closedScopes.add(key)
      this.flights.delete(key)
      flight.controller.abort()
      cancelled += 1
    }
    return cancelled
  }
}

export const chatAttachmentFlightStore = new ChatAttachmentFlightStore()
