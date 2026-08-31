import { describe, expect, it, vi } from 'vitest'
import { ChatAttachmentFlightStore } from '../../packages/dsh-research-ui/src/client/chat-attachment-flight'
import type { EnumerableKeyValueStorage } from '../../packages/dsh-research-ui/src/client/chat-project-store'
import { ChatScopeCloseStore } from '../../packages/dsh-research-ui/src/client/chat-scope-close-store'
import { ChatScopeLifecycle } from '../../packages/dsh-research-ui/src/client/chat-scope-lifecycle'
import { ChatScopeTombstoneRegistry } from '../../packages/dsh-research-ui/src/client/chat-scope-abort'
import { ChatTurnFlightStore } from '../../packages/dsh-research-ui/src/client/chat-turn-flight'
import { ChatUploadStore } from '../../packages/dsh-research-ui/src/client/chat-upload-store'
import { ChatVisionTurnStore } from '../../packages/dsh-research-ui/src/client/chat-vision'

class MemoryStorage implements EnumerableKeyValueStorage {
  readonly values = new Map<string, string>()
  get length(): number { return this.values.size }
  key(index: number): string | null { return [...this.values.keys()][index] ?? null }
  getItem(key: string): string | null { return this.values.get(key) ?? null }
  setItem(key: string, value: string): void { this.values.set(key, value) }
  removeItem(key: string): void { this.values.delete(key) }
}

function fixture(closeRemote: () => Promise<{ ok: boolean }>, storage: EnumerableKeyValueStorage = new MemoryStorage()) {
  const tombstones = new ChatScopeTombstoneRegistry()
  const turns = new ChatTurnFlightStore(tombstones)
  const attachments = new ChatAttachmentFlightStore(tombstones)
  const uploads = new ChatUploadStore(storage, tombstones)
  const vision = new ChatVisionTurnStore(tombstones)
  const outbox = new ChatScopeCloseStore()
  const removeLocal = vi.fn()
  const lifecycle = new ChatScopeLifecycle({
    uploads,
    attachments,
    turns,
    vision,
    outbox,
    tombstones,
    closeRemote,
    abortUpload: vi.fn(async () => ({ ok: true })),
  })
  return { lifecycle, turns, attachments, uploads, vision, outbox, removeLocal, storage }
}

describe('Chat scope lifecycle coordinator', () => {
  it('seals a session before I/O and never reopens it when durable storage fails', async () => {
    const broken: EnumerableKeyValueStorage = {
      get length() { return 0 },
      key: () => null,
      getItem: () => null,
      setItem: () => { throw new Error('quota') },
      removeItem: () => { throw new Error('private mode') },
    }
    const f = fixture(async () => ({ ok: false }), broken)
    expect(f.turns.begin('project-a', 'session-a')).toBe(true)

    f.lifecycle.closeSession({
      storage: broken, projectId: 'project-a', sessionId: 'session-a', removeLocal: f.removeLocal,
    })
    await f.lifecycle.flush(broken, f.removeLocal)

    expect(f.lifecycle.sessionClosed('project-a', 'session-a')).toBe(true)
    expect(f.turns.begin('project-a', 'session-a')).toBe(false)
    expect(f.attachments.signal('project-a', 'session-a')).toBeUndefined()
    expect(f.uploads.stage('project-a', 'session-a', [])).toEqual([])
    f.vision.stage('project-a', 'session-a', 'image-1', {
      name: 'late.png', type: 'image/png', size: 1, arrayBuffer: async () => new ArrayBuffer(1),
    })
    expect(f.vision.list('project-a', 'session-a')).toEqual([])
    expect(f.removeLocal).not.toHaveBeenCalled()
    expect(f.outbox.entries()).toEqual([{ projectId: 'project-a', sessionId: 'session-a' }])
  })

  it('retains the close outbox on a non-authoritative route 404', async () => {
    const f = fixture(async () => ({ ok: false }))
    f.lifecycle.closeSession({
      storage: f.storage, projectId: 'project-a', sessionId: 'session-a', removeLocal: f.removeLocal,
    })
    await f.lifecycle.flush(f.storage, f.removeLocal)

    expect(f.outbox.entries()).toEqual([{ projectId: 'project-a', sessionId: 'session-a' }])
    // Durable storage permits immediate UI removal, but a 404 must not ACK or
    // erase the retry intent a second time.
    expect(f.removeLocal).toHaveBeenCalledTimes(1)
  })

  it('retains the close outbox when the network request rejects', async () => {
    const f = fixture(async () => { throw new Error('network down') })
    f.lifecycle.closeSession({
      storage: f.storage, projectId: 'project-a', sessionId: 'session-a', removeLocal: f.removeLocal,
    })
    await expect(f.lifecycle.flush(f.storage, f.removeLocal)).resolves.toBeUndefined()

    expect(f.lifecycle.sessionClosed('project-a', 'session-a')).toBe(true)
    expect(f.outbox.entries()).toEqual([{ projectId: 'project-a', sessionId: 'session-a' }])
  })

  it('completes the outbox only after the Kernel acknowledges the tombstone', async () => {
    const f = fixture(async () => ({ ok: true }))
    f.lifecycle.closeSession({
      storage: f.storage, projectId: 'project-a', sessionId: 'session-a', removeLocal: f.removeLocal,
    })
    await f.lifecycle.flush(f.storage, f.removeLocal)

    expect(f.outbox.entries()).toEqual([])
    expect(f.removeLocal).toHaveBeenCalledTimes(2)
  })

  it('seals a persisted close before replay waits for the network', async () => {
    const storage = new MemoryStorage()
    const persisted = new ChatScopeCloseStore()
    expect(persisted.enqueue(storage, 'project-a', 'session-a')).toBe(true)
    let resolveClose: ((result: { ok: boolean }) => void) | undefined
    const f = fixture(() => new Promise(resolve => { resolveClose = resolve }), storage)
    expect(f.turns.begin('project-a', 'session-a')).toBe(true)
    const attachmentSignal = f.attachments.signal('project-a', 'session-a')
    f.uploads.stage('project-a', 'session-a', [{
      name: 'paper.pdf', size: 1, type: 'application/pdf',
      slice: () => ({ arrayBuffer: async () => new ArrayBuffer(1) }),
    }])
    f.vision.stage('project-a', 'session-a', 'image-1', {
      name: 'plot.png', type: 'image/png', size: 1, arrayBuffer: async () => new ArrayBuffer(1),
    })

    const flushing = f.lifecycle.flush(storage, f.removeLocal)

    expect(f.lifecycle.sessionClosed('project-a', 'session-a')).toBe(true)
    expect(f.turns.begin('project-a', 'session-a')).toBe(false)
    expect(attachmentSignal?.aborted).toBe(true)
    expect(f.attachments.signal('project-a', 'session-a')).toBeUndefined()
    expect(f.uploads.stage('project-a', 'session-a', [])).toEqual([])
    expect(f.vision.list('project-a', 'session-a')).toEqual([])
    resolveClose?.({ ok: true })
    await flushing
  })

  it('seals every resource in every session when a project is discarded', () => {
    const f = fixture(async () => ({ ok: true }))
    for (const sessionId of ['session-a', 'session-b']) {
      expect(f.turns.begin('project-a', sessionId)).toBe(true)
      f.attachments.signal('project-a', sessionId)
      f.uploads.stage('project-a', sessionId, [{
        name: `${sessionId}.pdf`, size: 1, type: 'application/pdf',
        slice: () => ({ arrayBuffer: async () => new ArrayBuffer(1) }),
      }])
      f.vision.stage('project-a', sessionId, `image-${sessionId}`, {
        name: `${sessionId}.png`, type: 'image/png', size: 1, arrayBuffer: async () => new ArrayBuffer(1),
      })
    }

    f.lifecycle.discardProject(f.storage, 'project-a')

    for (const sessionId of ['session-a', 'session-b']) {
      expect(f.lifecycle.sessionClosed('project-a', sessionId)).toBe(true)
      expect(f.turns.begin('project-a', sessionId)).toBe(false)
      expect(f.attachments.signal('project-a', sessionId)).toBeUndefined()
      expect(f.uploads.stage('project-a', sessionId, [])).toEqual([])
      expect(f.vision.list('project-a', sessionId)).toEqual([])
    }
  })
})
