import { apiResult } from './api'
import { chatAttachmentFlightStore, type ChatAttachmentFlightStore } from './chat-attachment-flight'
import {
  deleteChatProjectSnapshot,
  listChatProjectSnapshotIds,
  type EnumerableKeyValueStorage,
} from './chat-project-store'
import {
  type ChatScopeTombstoneRegistry,
  chatScopeKey,
  chatScopeTombstoneRegistry,
} from './chat-scope-abort'
import { chatScopeCloseStore, type ChatScopeCloseStore } from './chat-scope-close-store'
import { chatTurnFlightStore, type ChatTurnFlightStore } from './chat-turn-flight'
import { chatUploadStore, type ChatUploadStore } from './chat-upload-store'
import { chatVisionTurnStore, type ChatVisionTurnStore } from './chat-vision'
import { browserTransport, type UploadQueueItem, type UploadTransport } from './chunked-upload'

interface CloseResult {
  ok: boolean
}

export interface ChatScopeLifecycleDependencies {
  uploads: ChatUploadStore
  attachments: ChatAttachmentFlightStore
  turns: ChatTurnFlightStore
  vision: ChatVisionTurnStore
  outbox: ChatScopeCloseStore
  tombstones: ChatScopeTombstoneRegistry
  closeRemote(projectId: string, sessionId: string): Promise<CloseResult>
  abortUpload(input: Parameters<UploadTransport['abort']>[0]): Promise<unknown>
}

interface CloseSessionInput {
  storage: EnumerableKeyValueStorage
  projectId: string
  sessionId: string
  removeLocal(projectId: string, sessionId: string): void
}

/**
 * One owner for destructive Chat session/project lifecycle. It seals the
 * page-lifetime scope before any asynchronous I/O and owns outbox replay,
 * server acknowledgement and upload compensation.
 */
export class ChatScopeLifecycle {
  private readonly closeRequests = new Map<string, Promise<boolean>>()

  constructor(private readonly dependencies: ChatScopeLifecycleDependencies) {}

  sessionClosed(projectId: string, sessionId: string): boolean {
    return this.dependencies.tombstones.closed(projectId, sessionId)
  }

  trackedProjectIds(storage: EnumerableKeyValueStorage, currentProjectId: string | null): string[] {
    const ids = new Set<string>(currentProjectId === null ? [] : [currentProjectId])
    try {
      for (const projectId of listChatProjectSnapshotIds(storage)) ids.add(projectId)
      this.dependencies.outbox.hydrate(storage)
    } catch { /* private mode */ }
    for (const projectId of this.dependencies.uploads.projectIds()) ids.add(projectId)
    for (const projectId of this.dependencies.vision.projectIds()) ids.add(projectId)
    for (const projectId of this.dependencies.turns.projectIds()) ids.add(projectId)
    for (const projectId of this.dependencies.attachments.projectIds()) ids.add(projectId)
    for (const projectId of this.dependencies.outbox.projectIds()) ids.add(projectId)
    return [...ids]
  }

  closeSession(input: CloseSessionInput): void {
    const { storage, projectId, sessionId, removeLocal } = input
    const discarded = this.sealSession(projectId, sessionId)

    let durable = false
    try { durable = this.dependencies.outbox.enqueue(storage, projectId, sessionId) } catch { /* keep visible until ACK */ }
    if (durable) removeLocal(projectId, sessionId)
    void this.requestClose(storage, projectId, sessionId, removeLocal)

    this.abortDiscardedUploads(projectId, discarded)
  }

  async flush(storage: EnumerableKeyValueStorage, removeLocal: CloseSessionInput['removeLocal'], projectId?: string): Promise<void> {
    try { this.dependencies.outbox.hydrate(storage) } catch { /* page-lifetime entries remain */ }
    const requests = this.dependencies.outbox.entries(projectId).map(item => {
      const discarded = this.sealSession(item.projectId, item.sessionId)
      this.abortDiscardedUploads(item.projectId, discarded)
      return this.requestClose(storage, item.projectId, item.sessionId, removeLocal)
    })
    await Promise.all(requests)
  }

  discardProject(storage: EnumerableKeyValueStorage, projectId: string): void {
    this.dependencies.tombstones.sealProject(projectId)
    this.dependencies.attachments.cancelProject(projectId)
    this.dependencies.turns.cancelProject(projectId)
    this.dependencies.vision.clearProject(projectId)
    this.dependencies.uploads.clearProject(projectId)
    try { this.dependencies.outbox.clearProject(storage, projectId) } catch { /* project authority already deleted */ }
    try { deleteChatProjectSnapshot(storage, projectId) } catch { /* private mode */ }
  }

  private sealSession(projectId: string, sessionId: string): UploadQueueItem[] {
    this.dependencies.tombstones.seal(projectId, sessionId)
    const discarded = this.dependencies.uploads.clear(projectId, sessionId)
    this.dependencies.attachments.cancel(projectId, sessionId)
    this.dependencies.turns.cancel(projectId, sessionId)
    this.dependencies.vision.clear(projectId, sessionId)
    return discarded
  }

  private abortDiscardedUploads(projectId: string, discarded: readonly UploadQueueItem[]): void {
    for (const item of discarded) {
      if (item.uploadId === null || item.intakeId === null || item.projectId !== projectId) continue
      void this.dependencies.abortUpload({
        project_id: projectId,
        intake_id: item.intakeId,
        upload_id: item.uploadId,
      }).catch(() => {})
    }
  }

  private requestClose(
    storage: EnumerableKeyValueStorage,
    projectId: string,
    sessionId: string,
    removeLocal: CloseSessionInput['removeLocal'],
  ): Promise<boolean> {
    const key = chatScopeKey(projectId, sessionId)
    const existing = this.closeRequests.get(key)
    if (existing !== undefined) return existing
    const request = (async (): Promise<boolean> => {
      let result: CloseResult
      try {
        result = await this.dependencies.closeRemote(projectId, sessionId)
      } catch {
        return false
      }
      // A route-level 404 is deliberately not an ACK: membership denial and
      // physical project absence have the same non-enumerating response.
      if (!result.ok) return false
      try { this.dependencies.outbox.complete(storage, projectId, sessionId) } catch { /* stale replay is idempotent */ }
      removeLocal(projectId, sessionId)
      return true
    })().finally(() => { this.closeRequests.delete(key) })
    this.closeRequests.set(key, request)
    return request
  }
}

export const chatScopeLifecycle = new ChatScopeLifecycle({
  uploads: chatUploadStore,
  attachments: chatAttachmentFlightStore,
  turns: chatTurnFlightStore,
  vision: chatVisionTurnStore,
  outbox: chatScopeCloseStore,
  tombstones: chatScopeTombstoneRegistry,
  closeRemote: async (projectId, sessionId) => {
    const result = await apiResult<{ ok: true }>(
      `/v1/projects/${encodeURIComponent(projectId)}/chat-scopes/${encodeURIComponent(sessionId)}/tombstone`,
      { method: 'POST', body: '{}' },
    )
    return { ok: result.ok }
  },
  abortUpload: input => browserTransport().abort(input),
})
