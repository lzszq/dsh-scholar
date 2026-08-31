import {
  ChatScopeAbortRegistry,
  ChatScopeTombstoneRegistry,
  chatScopeTombstoneRegistry,
} from './chat-scope-abort'

/** Page-lifetime ownership for one in-flight turn per exact project/session.
 * It intentionally survives composer remounts but not a hard reload. */
export class ChatTurnFlightStore {
  private readonly registry: ChatScopeAbortRegistry

  constructor(tombstones = new ChatScopeTombstoneRegistry()) {
    this.registry = new ChatScopeAbortRegistry(tombstones)
  }

  active(projectId: string, sessionId: string): boolean {
    return this.registry.active(projectId, sessionId)
  }

  anyActive(): boolean {
    return this.registry.anyActive()
  }

  projectIds(): string[] {
    return this.registry.projectIds()
  }

  begin(projectId: string, sessionId: string): boolean {
    return this.registry.beginExclusive(projectId, sessionId)
  }

  signal(projectId: string, sessionId: string): AbortSignal | undefined {
    return this.registry.signal(projectId, sessionId)
  }

  end(projectId: string, sessionId: string): boolean {
    return this.registry.end(projectId, sessionId)
  }

  cancel(projectId: string, sessionId: string): boolean {
    return this.registry.seal(projectId, sessionId)
  }

  cancelProject(projectId: string): number {
    return this.registry.sealProject(projectId)
  }

}

export const chatTurnFlightStore = new ChatTurnFlightStore(chatScopeTombstoneRegistry)
