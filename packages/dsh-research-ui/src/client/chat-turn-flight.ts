/** Page-lifetime ownership for one in-flight turn per exact project/session.
 * It intentionally survives composer remounts but not a hard reload. */
export class ChatTurnFlightStore {
  private readonly flights = new Map<string, { projectId: string; controller: AbortController }>()

  private key(projectId: string, sessionId: string): string {
    return JSON.stringify([projectId, sessionId])
  }

  active(projectId: string, sessionId: string): boolean {
    return this.flights.has(this.key(projectId, sessionId))
  }

  anyActive(): boolean {
    return this.flights.size > 0
  }

  projectIds(): string[] {
    return [...new Set([...this.flights.values()].map(flight => flight.projectId))]
  }

  begin(projectId: string, sessionId: string): boolean {
    const key = this.key(projectId, sessionId)
    if (this.flights.has(key)) return false
    this.flights.set(key, { projectId, controller: new AbortController() })
    return true
  }

  signal(projectId: string, sessionId: string): AbortSignal | undefined {
    return this.flights.get(this.key(projectId, sessionId))?.controller.signal
  }

  end(projectId: string, sessionId: string): boolean {
    return this.flights.delete(this.key(projectId, sessionId))
  }

  cancel(projectId: string, sessionId: string): boolean {
    const key = this.key(projectId, sessionId)
    const flight = this.flights.get(key)
    if (flight === undefined) return false
    this.flights.delete(key)
    flight.controller.abort()
    return true
  }

  cancelProject(projectId: string): number {
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

export const chatTurnFlightStore = new ChatTurnFlightStore()
