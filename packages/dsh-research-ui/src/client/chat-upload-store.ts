import {
  enqueueFiles,
  isUploadFailure,
  uploadFailure,
  type FileByteProvider,
  type UploadQueueItem,
  type UploadSessionProjection,
} from './chunked-upload'
import {
  ChatScopeTombstoneRegistry,
  chatScopeKey,
  chatScopeTombstoneRegistry,
} from './chat-scope-abort'

export type ChatUploadFile = Pick<File, 'name' | 'size' | 'type' | 'slice'>

interface UploadScope {
  readonly items: Map<string, UploadQueueItem>
  readonly files: Map<string, ChatUploadFile>
  readonly listeners: Set<() => void>
  readonly drivers: Map<string, symbol>
}

interface UploadQueueStorage {
  readonly length: number
  key(index: number): string | null
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

const UPLOAD_QUEUE_KEY_PREFIX = 'dsh-scholar-upload-queue-v1:'
const QUEUE_STATES = new Set([
  'hashing', 'queued', 'uploading', 'paused', 'finalizing', 'scanning',
  'needs_input', 'ready', 'quarantined', 'failed',
])

function defaultStorage(): UploadQueueStorage | null {
  try { return typeof localStorage === 'undefined' ? null : localStorage } catch { return null }
}

function parseStoredItem(value: unknown, projectId: string): UploadQueueItem | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null
  const item = value as Record<string, unknown>
  if (
    typeof item.fileId !== 'string' || typeof item.fileName !== 'string'
    || !Number.isSafeInteger(item.fileSize) || typeof item.mediaType !== 'string'
    || typeof item.state !== 'string' || !QUEUE_STATES.has(item.state)
    || (item.uploadId !== null && typeof item.uploadId !== 'string')
    || (item.intakeId !== null && typeof item.intakeId !== 'string')
    || (item.projectId !== null && typeof item.projectId !== 'string')
    || (item.expectedSha256 !== null && typeof item.expectedSha256 !== 'string')
    || (item.chunkSize !== null && (!Number.isSafeInteger(item.chunkSize) || (item.chunkSize as number) <= 0))
    || !Number.isSafeInteger(item.committedOffset) || (item.committedOffset as number) < 0
    || !Number.isSafeInteger(item.retryCount) || (item.retryCount as number) < 0
    || (item.lastError !== null && !isUploadFailure(item.lastError))
  ) return null
  if (
    (item.fileSize as number) < 0
    || (item.committedOffset as number) > (item.fileSize as number)
    || (item.projectId !== null && item.projectId !== projectId)
    || (typeof item.expectedSha256 === 'string' && !/^[a-f0-9]{64}$/i.test(item.expectedSha256))
    || (typeof item.chunkSize === 'number' && item.chunkSize > 32 * 1024 * 1024)
  ) return null
  return item as unknown as UploadQueueItem
}

/** Page-lifetime owner for attachment uploads keyed by exact project/session.
 * DOM renders are views only; replacing a composer cannot discard progress or
 * the File handles needed by pause/resume/retry. */
export class ChatUploadStore {
  private readonly scopes = new Map<string, UploadScope>()

  constructor(
    private readonly storage: UploadQueueStorage | null = defaultStorage(),
    private readonly tombstones = new ChatScopeTombstoneRegistry(),
  ) {}

  private key(projectId: string, sessionId: string): string {
    return chatScopeKey(projectId, sessionId)
  }

  private storageKey(projectId: string, sessionId: string): string {
    return `${UPLOAD_QUEUE_KEY_PREFIX}${encodeURIComponent(projectId)}:${encodeURIComponent(sessionId)}`
  }

  private load(projectId: string, sessionId: string): UploadScope | undefined {
    const key = this.key(projectId, sessionId)
    if (this.tombstones.closed(projectId, sessionId) || this.storage === null) return undefined
    try {
      const raw = this.storage.getItem(this.storageKey(projectId, sessionId))
      if (raw === null) return undefined
      const decoded = JSON.parse(raw) as unknown
      if (!Array.isArray(decoded)) return undefined
      const items: UploadQueueItem[] = decoded.flatMap(candidate => {
        const parsed = parseStoredItem(candidate, projectId)
        if (parsed === null) return []
        const needsBytes = ['hashing', 'queued', 'uploading', 'paused', 'finalizing'].includes(parsed.state)
        return [{
          ...parsed,
          ...(needsBytes ? {
            state: 'failed' as const,
            lastError: uploadFailure('upload_file_reselect_required'),
          } : {}),
        }]
      })
      if (items.length === 0) return undefined
      const scope: UploadScope = {
        items: new Map(items.map(item => [item.fileId, item])),
        files: new Map(),
        listeners: new Set(),
        drivers: new Map(),
      }
      this.scopes.set(key, scope)
      return scope
    } catch {
      return undefined
    }
  }

  private persist(projectId: string, sessionId: string, scope: UploadScope): void {
    if (this.storage === null) return
    try {
      const key = this.storageKey(projectId, sessionId)
      if (scope.items.size === 0) this.storage.removeItem(key)
      else this.storage.setItem(key, JSON.stringify([...scope.items.values()]))
    } catch { /* private mode / quota */ }
  }

  private scope(projectId: string, sessionId: string, create = false): UploadScope | undefined {
    const key = this.key(projectId, sessionId)
    if (this.tombstones.closed(projectId, sessionId)) return undefined
    const current = this.scopes.get(key)
    if (current !== undefined) return current
    const restored = this.load(projectId, sessionId)
    if (restored !== undefined || !create) return restored
    const next: UploadScope = { items: new Map(), files: new Map(), listeners: new Set(), drivers: new Map() }
    this.scopes.set(key, next)
    return next
  }

  private notify(scope: UploadScope): void {
    for (const listener of scope.listeners) listener()
  }

  stage(projectId: string, sessionId: string, files: readonly ChatUploadFile[]): UploadQueueItem[] {
    const scope = this.scope(projectId, sessionId, true)
    if (scope === undefined) return []
    const fresh = enqueueFiles(files.map(file => ({ name: file.name, size: file.size, type: file.type })))
    const reused = new Set<string>()
    const items = fresh.map((item, index) => {
      const file = files[index]!
      const recovered = [...scope.items.values()].find(candidate =>
        !reused.has(candidate.fileId)
        && candidate.state === 'failed'
        && candidate.fileName === file.name
        && candidate.fileSize === file.size
        && candidate.mediaType === file.type,
      )
      const selected = recovered === undefined
        ? item
        : { ...recovered, state: 'hashing' as const, lastError: null }
      if (recovered !== undefined) reused.add(recovered.fileId)
      scope.items.set(selected.fileId, selected)
      scope.files.set(selected.fileId, file)
      return selected
    })
    this.persist(projectId, sessionId, scope)
    this.notify(scope)
    return items
  }

  list(projectId: string, sessionId: string): UploadQueueItem[] {
    return [...(this.scope(projectId, sessionId)?.items.values() ?? [])]
  }

  /** In-memory scopes are authoritative even when localStorage persistence
   * failed (private mode/quota). External project deletion reconciliation
   * must still find and release their File handles and active drivers. */
  projectIds(): string[] {
    const ids = new Set<string>()
    for (const key of this.scopes.keys()) {
      const [projectId] = JSON.parse(key) as [string, string]
      ids.add(projectId)
    }
    return [...ids]
  }

  update(projectId: string, sessionId: string, item: UploadQueueItem): boolean {
    const scope = this.scope(projectId, sessionId)
    if (scope === undefined || !scope.items.has(item.fileId)) return false
    scope.items.set(item.fileId, item)
    this.persist(projectId, sessionId, scope)
    this.notify(scope)
    return true
  }

  item(projectId: string, sessionId: string, fileId: string): UploadQueueItem | undefined {
    return this.scope(projectId, sessionId)?.items.get(fileId)
  }

  file(projectId: string, sessionId: string, fileId: string): ChatUploadFile | undefined {
    return this.scope(projectId, sessionId)?.files.get(fileId)
  }

  byteProvider(projectId: string, sessionId: string): FileByteProvider {
    return {
      read: async (fileId, start, end) => {
        const file = this.file(projectId, sessionId, fileId)
        return file === undefined ? null : new Uint8Array(await file.slice(start, end + 1).arrayBuffer())
      },
    }
  }

  releaseBytes(projectId: string, sessionId: string, fileId: string): void {
    this.scope(projectId, sessionId)?.files.delete(fileId)
  }

  hasBytes(projectId: string, sessionId: string, fileId: string): boolean {
    return this.scope(projectId, sessionId)?.files.has(fileId) === true
  }

  /** Merge the server's durable offset/status into persisted browser metadata.
   * Bytes never enter storage; an open session without a live File handle is
   * shown as re-selectable instead of pretending it can continue. */
  reconcile(
    projectId: string,
    sessionId: string,
    serverSessions: readonly UploadSessionProjection[],
  ): UploadQueueItem[] {
    const scope = this.scope(projectId, sessionId)
    if (scope === undefined) return []
    const byId = new Map(serverSessions.map(session => [session.upload_id, session]))
    for (const [fileId, item] of scope.items) {
      if (item.uploadId === null || scope.drivers.has(fileId)) continue
      const server = byId.get(item.uploadId)
      if (server === undefined) {
        scope.items.set(fileId, {
          ...item,
          uploadId: null,
          committedOffset: 0,
          chunkSize: null,
          state: 'failed',
          lastError: { code: 'upload_session_unavailable' },
        })
        scope.files.delete(fileId)
        continue
      }
      let next: UploadQueueItem
      const identityMatches = server.intake_id === item.intakeId
        && server.file_name === item.fileName
        && server.media_type === item.mediaType
        && server.expected_size === item.fileSize
        && (item.expectedSha256 === null || server.expected_sha256 === item.expectedSha256)
      if (!identityMatches) {
        next = {
          ...item,
          uploadId: null,
          committedOffset: 0,
          chunkSize: null,
          state: 'failed',
          lastError: { code: 'upload_session_identity_mismatch' },
        }
        scope.files.delete(fileId)
      } else if (server.status === 'open') {
        const hasBytes = scope.files.has(fileId)
        next = {
          ...item,
          intakeId: server.intake_id,
          chunkSize: server.chunk_size,
          committedOffset: server.committed_offset,
          state: hasBytes ? 'paused' : 'failed',
          lastError: hasBytes ? null : { code: 'upload_file_reselect_required' },
        }
      } else if (server.status === 'finalized') {
        next = { ...item, committedOffset: item.fileSize, state: 'scanning', lastError: null }
        scope.files.delete(fileId)
      } else {
        next = {
          ...item,
          uploadId: null,
          committedOffset: 0,
          chunkSize: null,
          state: 'failed',
          lastError: { code: server.status === 'aborted' ? 'upload_session_aborted' : 'upload_session_expired' },
        }
        scope.files.delete(fileId)
      }
      scope.items.set(fileId, next)
    }
    this.persist(projectId, sessionId, scope)
    this.notify(scope)
    return [...scope.items.values()]
  }

  /** Claim the only browser driver allowed to advance one upload. This state
   * outlives composer renders, so pause/resume cannot start duplicate chunk
   * writers for the same server upload session. */
  beginDrive(projectId: string, sessionId: string, fileId: string): symbol | null {
    const scope = this.scope(projectId, sessionId)
    if (scope === undefined || !scope.items.has(fileId) || scope.drivers.has(fileId)) return null
    const token = Symbol(fileId)
    scope.drivers.set(fileId, token)
    return token
  }

  endDrive(projectId: string, sessionId: string, fileId: string, token: symbol): boolean {
    const scope = this.scope(projectId, sessionId)
    if (scope?.drivers.get(fileId) !== token) return false
    scope.drivers.delete(fileId)
    return true
  }

  subscribe(projectId: string, sessionId: string, listener: () => void): () => void {
    const scope = this.scope(projectId, sessionId, true)
    if (scope === undefined) return () => {}
    scope.listeners.add(listener)
    return () => scope.listeners.delete(listener)
  }

  clear(projectId: string, sessionId: string): UploadQueueItem[] {
    const key = this.key(projectId, sessionId)
    let items = [...(this.scopes.get(key)?.items.values() ?? [])]
    if (items.length === 0 && this.storage !== null) {
      try {
        const raw = this.storage.getItem(this.storageKey(projectId, sessionId))
        const decoded = raw === null ? [] : JSON.parse(raw) as unknown
        if (Array.isArray(decoded)) {
          items = decoded.flatMap(candidate => {
            const parsed = parseStoredItem(candidate, projectId)
            return parsed === null ? [] : [parsed]
          })
        }
      } catch { /* private mode / corrupt queue */ }
    }
    this.tombstones.seal(projectId, sessionId)
    this.scopes.delete(key)
    try { this.storage?.removeItem(this.storageKey(projectId, sessionId)) } catch { /* private mode */ }
    return items
  }

  clearProject(projectId: string): UploadQueueItem[] {
    const sessionIds = new Set<string>()
    for (const key of [...this.scopes.keys()]) {
      const [scopeProjectId] = JSON.parse(key) as [string, string]
      if (scopeProjectId === projectId) {
        const [, sessionId] = JSON.parse(key) as [string, string]
        sessionIds.add(sessionId)
      }
    }
    if (this.storage !== null) {
      try {
        const prefix = `${UPLOAD_QUEUE_KEY_PREFIX}${encodeURIComponent(projectId)}:`
        const keys = Array.from({ length: this.storage.length }, (_, index) => this.storage!.key(index))
        for (const key of keys) {
          if (key?.startsWith(prefix) !== true) continue
          try { sessionIds.add(decodeURIComponent(key.slice(prefix.length))) } catch { /* removed below */ }
        }
      } catch { /* private mode */ }
    }
    const discarded = [...sessionIds].flatMap(sessionId => this.clear(projectId, sessionId))
    this.tombstones.sealProject(projectId)
    if (this.storage !== null) {
      try {
        const prefix = `${UPLOAD_QUEUE_KEY_PREFIX}${encodeURIComponent(projectId)}:`
        const keys = Array.from({ length: this.storage.length }, (_, index) => this.storage!.key(index))
        for (const key of keys) if (key?.startsWith(prefix) === true) this.storage.removeItem(key)
      } catch { /* private mode */ }
    }
    return discarded
  }
}

export const chatUploadStore = new ChatUploadStore(defaultStorage(), chatScopeTombstoneRegistry)
