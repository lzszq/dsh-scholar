import {
  ChatScopeAbortRegistry,
  ChatScopeTombstoneRegistry,
  chatScopeTombstoneRegistry,
} from './chat-scope-abort'

/**
 * Page-lifetime cancellation owner for attachment work keyed by the exact
 * project/session pair. Composer remounts reuse the same signal; an explicit
 * session close or project discard tombstones the scope before cancelling it,
 * so delayed Intake/hash/upload continuations cannot acquire a fresh signal.
 */
export class ChatAttachmentFlightStore {
  private readonly registry: ChatScopeAbortRegistry

  constructor(tombstones = new ChatScopeTombstoneRegistry()) {
    this.registry = new ChatScopeAbortRegistry(tombstones)
  }

  signal(projectId: string, sessionId: string): AbortSignal | undefined {
    return this.registry.signalOrBegin(projectId, sessionId)
  }

  projectIds(): string[] {
    return this.registry.projectIds()
  }

  cancel(projectId: string, sessionId: string): boolean {
    return this.registry.seal(projectId, sessionId)
  }

  cancelProject(projectId: string): number {
    return this.registry.sealProject(projectId)
  }
}

export const chatAttachmentFlightStore = new ChatAttachmentFlightStore(chatScopeTombstoneRegistry)
