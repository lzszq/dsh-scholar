import type { KeyValueStorage } from './chat-project-store'

export interface PendingChatScopeClose {
  projectId: string
  sessionId: string
}

const STORAGE_KEY = 'dsh-scholar.chat-scope-close.v1'
const SAFE_ID = /^[A-Za-z0-9._:-]{1,160}$/

function keyOf(projectId: string, sessionId: string): string {
  return `${projectId}\u0000${sessionId}`
}

function valid(value: unknown): value is PendingChatScopeClose {
  if (typeof value !== 'object' || value === null) return false
  const item = value as PendingChatScopeClose
  return SAFE_ID.test(item.projectId) && SAFE_ID.test(item.sessionId)
}

/** Durable browser outbox for the idempotent Kernel Chat-scope tombstone.
 * Memory remains authoritative for this page when storage is unavailable;
 * callers only remove the local session before the server ACK when enqueue()
 * confirms that a reload-safe copy was persisted. */
export class ChatScopeCloseStore {
  private readonly pending = new Map<string, PendingChatScopeClose>()
  private hydrated = false

  hydrate(storage: KeyValueStorage): void {
    if (this.hydrated) return
    this.hydrated = true
    try {
      const raw = storage.getItem(STORAGE_KEY)
      const parsed = raw === null ? [] : JSON.parse(raw) as unknown
      if (!Array.isArray(parsed)) return
      for (const item of parsed) {
        if (valid(item)) this.pending.set(keyOf(item.projectId, item.sessionId), item)
      }
    } catch { /* corrupt/private storage: retain page-lifetime memory only */ }
  }

  enqueue(storage: KeyValueStorage, projectId: string, sessionId: string): boolean {
    this.hydrate(storage)
    if (!SAFE_ID.test(projectId) || !SAFE_ID.test(sessionId)) return false
    this.pending.set(keyOf(projectId, sessionId), { projectId, sessionId })
    return this.persist(storage)
  }

  complete(storage: KeyValueStorage, projectId: string, sessionId: string): void {
    this.hydrate(storage)
    this.pending.delete(keyOf(projectId, sessionId))
    this.persist(storage)
  }

  clearProject(storage: KeyValueStorage, projectId: string): void {
    this.hydrate(storage)
    for (const [key, item] of this.pending) {
      if (item.projectId === projectId) this.pending.delete(key)
    }
    this.persist(storage)
  }

  entries(projectId?: string): PendingChatScopeClose[] {
    return [...this.pending.values()].filter(item => projectId === undefined || item.projectId === projectId)
  }

  projectIds(): string[] {
    return [...new Set([...this.pending.values()].map(item => item.projectId))]
  }

  private persist(storage: KeyValueStorage): boolean {
    try {
      if (this.pending.size === 0) storage.removeItem(STORAGE_KEY)
      else storage.setItem(STORAGE_KEY, JSON.stringify([...this.pending.values()]))
      return true
    } catch {
      return false
    }
  }
}

export const chatScopeCloseStore = new ChatScopeCloseStore()
