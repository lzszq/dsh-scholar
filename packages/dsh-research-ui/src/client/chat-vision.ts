import {
  SCHOLAR_AGENT_MAX_BODY_BYTES,
  SCHOLAR_CHAT_IMAGE_MEDIA_TYPES,
  SCHOLAR_CHAT_MAX_IMAGES,
  type ScholarChatImage,
} from '@dsh-scholar/research-schemas/chat-agent'
import {
  ChatScopeTombstoneRegistry,
  chatScopeKey,
  chatScopeTombstoneRegistry,
} from './chat-scope-abort'

const CHAT_VISION_MEDIA_TYPES = new Set<ScholarChatImage['mediaType']>([
  ...SCHOLAR_CHAT_IMAGE_MEDIA_TYPES,
])

export interface BrowserImageFile {
  readonly name: string
  readonly type: string
  readonly size: number
  arrayBuffer(): Promise<ArrayBuffer>
}

export interface QueuedChatVisionImage {
  readonly fileId: string
  readonly file: BrowserImageFile
}

// Reserve space for text, bounded history, JSON structure and server-derived
// project context before the private bridge applies its final exact check.
const CHAT_VISION_ENVELOPE_RESERVE_BYTES = 256 * 1024
const CHAT_VISION_MAX_BASE64_BYTES = SCHOLAR_AGENT_MAX_BODY_BYTES - CHAT_VISION_ENVELOPE_RESERVE_BYTES

export class ChatVisionInputError extends Error {
  constructor(readonly code: 'payload_too_large' | 'vision_image_rejected') {
    super(code)
    this.name = 'ChatVisionInputError'
  }
}

function estimatedWireBytes(files: readonly BrowserImageFile[]): number {
  return files.reduce((sum, file) => {
    const base64Bytes = 4 * Math.ceil(file.size / 3)
    return sum + base64Bytes + new TextEncoder().encode(file.name).byteLength + 96
  }, 0)
}

function assertBrowserBatch(files: readonly BrowserImageFile[]): void {
  if (files.length > SCHOLAR_CHAT_MAX_IMAGES || estimatedWireBytes(files) > CHAT_VISION_MAX_BASE64_BYTES) {
    throw new ChatVisionInputError('payload_too_large')
  }
}

/**
 * Live, exact-session ownership for the next free conversation turn.
 *
 * File bytes deliberately remain memory-only, but unlike render-local state
 * they survive Chat transcript/upload repainting. A hard reload drops the
 * store fail-closed; only a successful visual turn or an explicit session
 * close removes entries during the live page lifetime.
 */
export class ChatVisionTurnStore {
  private readonly scopes = new Map<string, Map<string, BrowserImageFile>>()

  constructor(private readonly tombstones = new ChatScopeTombstoneRegistry()) {}

  stage(projectId: string, sessionId: string, fileId: string, file: BrowserImageFile): void {
    this.stageBatch(projectId, sessionId, [{ fileId, file }])
  }

  stageBatch(projectId: string, sessionId: string, items: readonly QueuedChatVisionImage[]): void {
    if (this.tombstones.closed(projectId, sessionId)) return
    const key = chatScopeKey(projectId, sessionId)
    const next = new Map(this.scopes.get(key) ?? [])
    for (const { fileId, file } of items) {
      if (!isChatVisionImage(file)) throw new ChatVisionInputError('vision_image_rejected')
      next.set(fileId, file)
    }
    assertBrowserBatch([...next.values()])
    if (next.size > 0) this.scopes.set(key, next)
  }

  list(projectId: string, sessionId: string): QueuedChatVisionImage[] {
    if (this.tombstones.closed(projectId, sessionId)) return []
    const scope = this.scopes.get(chatScopeKey(projectId, sessionId))
    return scope === undefined
      ? []
      : [...scope].map(([fileId, file]) => ({ fileId, file }))
  }

  projectIds(): string[] {
    const ids = new Set<string>()
    for (const key of this.scopes.keys()) {
      const [projectId] = JSON.parse(key) as [string, string]
      ids.add(projectId)
    }
    return [...ids]
  }

  consume(projectId: string, sessionId: string, fileIds: readonly string[]): void {
    const key = chatScopeKey(projectId, sessionId)
    const scope = this.scopes.get(key)
    if (scope === undefined) return
    for (const fileId of fileIds) scope.delete(fileId)
    if (scope.size === 0) this.scopes.delete(key)
  }

  remove(projectId: string, sessionId: string, fileId: string): void {
    this.consume(projectId, sessionId, [fileId])
  }

  clear(projectId: string, sessionId: string): void {
    this.scopes.delete(chatScopeKey(projectId, sessionId))
  }

  clearProject(projectId: string): void {
    for (const key of this.scopes.keys()) {
      const [scopeProjectId] = JSON.parse(key) as [string, string]
      if (scopeProjectId === projectId) this.scopes.delete(key)
    }
  }
}

export const chatVisionTurnStore = new ChatVisionTurnStore(chatScopeTombstoneRegistry)

export function isChatVisionImage(file: Pick<BrowserImageFile, 'type'>): file is Pick<BrowserImageFile, 'type'> & { type: ScholarChatImage['mediaType'] } {
  return CHAT_VISION_MEDIA_TYPES.has(file.type as ScholarChatImage['mediaType'])
}

/** Select one atomic visual batch from a general attachment batch. Non-image
 * research materials are ignored, while any unsupported image rejects every
 * visual candidate before a byte is read. */
export function chatVisionBatch<T extends BrowserImageFile>(files: readonly T[]): T[] {
  const candidates = files.filter(file => file.type.startsWith('image/'))
  if (candidates.some(file => !isChatVisionImage(file))) throw new ChatVisionInputError('vision_image_rejected')
  assertBrowserBatch(candidates)
  return candidates
}

function canonicalBase64(bytes: Uint8Array): string {
  let binary = ''
  for (let offset = 0; offset < bytes.byteLength; offset += 8_192) {
    binary += String.fromCharCode(...bytes.subarray(offset, Math.min(offset + 8_192, bytes.byteLength)))
  }
  return btoa(binary)
}

/** Encode only the current turn's visual context. The returned bytes are sent
 * to the private BFF bridge and never stored in Chat state/localStorage; DSH's
 * AttachmentStore performs authoritative admission and durable publication. */
export async function encodeChatVisionImages(files: readonly BrowserImageFile[]): Promise<ScholarChatImage[]> {
  if (files.some(file => !isChatVisionImage(file))) throw new ChatVisionInputError('vision_image_rejected')
  assertBrowserBatch(files)
  const result: ScholarChatImage[] = []
  let actualWireBytes = 0
  for (const file of files) {
    const data = canonicalBase64(new Uint8Array(await file.arrayBuffer()))
    actualWireBytes += data.length + new TextEncoder().encode(file.name).byteLength + 96
    if (actualWireBytes > CHAT_VISION_MAX_BASE64_BYTES) throw new ChatVisionInputError('payload_too_large')
    result.push({
      mediaType: file.type as ScholarChatImage['mediaType'],
      data,
      ...(file.name === '' ? {} : { name: file.name }),
    })
  }
  return result
}
