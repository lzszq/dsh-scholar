import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { ChatUploadStore } from '../../packages/dsh-research-ui/src/client/chat-upload-store'
import { markHashed, sha256File } from '../../packages/dsh-research-ui/src/client/chunked-upload'

function uploadFile(name: string, bytes: Uint8Array, reads: Array<[number, number]> = []) {
  return {
    name,
    size: bytes.byteLength,
    type: 'application/octet-stream',
    slice(start = 0, end = bytes.byteLength) {
      reads.push([start, end])
      return { arrayBuffer: async () => bytes.slice(start, end).buffer }
    },
  }
}

class MemoryStorage {
  private readonly values = new Map<string, string>()
  get length(): number { return this.values.size }
  key(index: number): string | null { return [...this.values.keys()][index] ?? null }
  getItem(key: string): string | null { return this.values.get(key) ?? null }
  setItem(key: string, value: string): void { this.values.set(key, value) }
  removeItem(key: string): void { this.values.delete(key) }
}

describe('ChatUploadStore', () => {
  it('keeps exact-session queue state and bytes across composer renders', async () => {
    const store = new ChatUploadStore()
    const file = uploadFile('paper.pdf', new Uint8Array([1, 2, 3, 4]))
    const [queued] = store.stage('project-a', 'session-a', [file])
    expect(queued).toBeDefined()
    store.update('project-a', 'session-a', markHashed(queued!, 'abc'))

    expect(store.list('project-a', 'session-a')[0]).toMatchObject({ state: 'queued', expectedSha256: 'abc' })
    expect(await store.byteProvider('project-a', 'session-a').read(queued!.fileId, 1, 2)).toEqual(new Uint8Array([2, 3]))
    expect(store.list('project-a', 'other')).toEqual([])
  })

  it('clears session/project File ownership and rejects late updates', () => {
    const store = new ChatUploadStore()
    const [a] = store.stage('project-a', 'session-a', [uploadFile('a', new Uint8Array([1]))])
    store.stage('project-a', 'session-b', [uploadFile('b', new Uint8Array([2]))])
    store.stage('project-b', 'session-a', [uploadFile('c', new Uint8Array([3]))])

    store.clear('project-a', 'session-a')
    expect(store.update('project-a', 'session-a', markHashed(a!, 'late'))).toBe(false)
    expect(store.stage('project-a', 'session-a', [uploadFile('late', new Uint8Array([9]))])).toEqual([])
    const discarded = store.clearProject('project-a')
    expect(discarded).toHaveLength(1)
    expect(store.list('project-a', 'session-b')).toEqual([])
    expect(store.stage('project-a', 'new-session', [uploadFile('late', new Uint8Array([9]))])).toEqual([])
    expect(store.list('project-b', 'session-a')).toHaveLength(1)
  })

  it('persists metadata, reconciles the server offset, and reuses the exact item after file re-selection', () => {
    const storage = new MemoryStorage()
    const first = new ChatUploadStore(storage)
    const file = uploadFile('paper.pdf', new Uint8Array([1, 2, 3, 4]))
    const [item] = first.stage('project-a', 'session-a', [file])
    first.update('project-a', 'session-a', {
      ...markHashed(item!, 'a'.repeat(64)),
      uploadId: 'upl-1', intakeId: 'intake-1', projectId: 'project-a', committedOffset: 2,
    })

    const reloaded = new ChatUploadStore(storage)
    expect(reloaded.list('project-a', 'session-a')[0]).toMatchObject({
      fileId: item!.fileId, uploadId: 'upl-1', state: 'failed', committedOffset: 2,
    })
    reloaded.reconcile('project-a', 'session-a', [{
      upload_id: 'upl-1', intake_id: 'intake-1', file_name: 'paper.pdf',
      media_type: 'application/octet-stream', expected_size: 4,
      expected_sha256: 'a'.repeat(64), chunk_size: 2, committed_offset: 3, status: 'open',
    }])
    expect(reloaded.list('project-a', 'session-a')[0]).toMatchObject({ state: 'failed', committedOffset: 3 })

    const [resumed] = reloaded.stage('project-a', 'session-a', [file])
    expect(resumed).toMatchObject({ fileId: item!.fileId, uploadId: 'upl-1', state: 'hashing', committedOffset: 3 })
    expect(reloaded.hasBytes('project-a', 'session-a', item!.fileId)).toBe(true)
  })

  it('drops corrupt persisted offsets instead of resuming an unsafe range', () => {
    const storage = new MemoryStorage()
    storage.setItem('dsh-scholar-upload-queue-v1:project-a:session-a', JSON.stringify([{
      fileId: 'file-1', fileName: 'paper.pdf', fileSize: 4, mediaType: 'application/pdf',
      state: 'paused', uploadId: 'upl-1', intakeId: 'intake-1', projectId: 'project-a',
      expectedSha256: 'a'.repeat(64), chunkSize: 2, committedOffset: 5, retryCount: 0, lastError: null,
    }]))

    expect(new ChatUploadStore(storage).list('project-a', 'session-a')).toEqual([])
  })

  it('resets an unavailable or mismatched server session before re-selection', () => {
    const storage = new MemoryStorage()
    const store = new ChatUploadStore(storage)
    const [item] = store.stage('project-a', 'session-a', [uploadFile('paper.pdf', new Uint8Array([1, 2, 3, 4]))])
    store.update('project-a', 'session-a', {
      ...markHashed(item!, 'a'.repeat(64)), uploadId: 'upl-1', intakeId: 'intake-1',
      projectId: 'project-a', committedOffset: 2,
    })
    store.releaseBytes('project-a', 'session-a', item!.fileId)

    expect(store.reconcile('project-a', 'session-a', [])[0]).toMatchObject({
      uploadId: null, committedOffset: 0, state: 'failed', lastError: 'upload_session_unavailable',
    })

    const [reselected] = store.stage('project-a', 'session-a', [uploadFile('paper.pdf', new Uint8Array([1, 2, 3, 4]))])
    store.update('project-a', 'session-a', {
      ...reselected!, uploadId: 'upl-2', intakeId: 'intake-1', projectId: 'project-a',
      expectedSha256: 'a'.repeat(64), committedOffset: 2,
    })
    expect(store.reconcile('project-a', 'session-a', [{
      upload_id: 'upl-2', intake_id: 'foreign-intake', file_name: 'paper.pdf',
      media_type: 'application/octet-stream', expected_size: 4,
      expected_sha256: 'a'.repeat(64), chunk_size: 2, committed_offset: 2, status: 'open',
    }])[0]).toMatchObject({
      uploadId: null, committedOffset: 0, state: 'failed', lastError: 'upload_session_identity_mismatch',
    })
  })

  it('retains queue and File handles when another project scope is opened', async () => {
    const store = new ChatUploadStore(new MemoryStorage())
    const file = uploadFile('paper.pdf', new Uint8Array([1, 2, 3]))
    const [item] = store.stage('project-a', 'session-a', [file])
    store.stage('project-b', 'session-b', [uploadFile('other.pdf', new Uint8Array([4]))])

    expect(store.list('project-a', 'session-a')).toHaveLength(1)
    expect(await store.byteProvider('project-a', 'session-a').read(item!.fileId, 0, 2)).toEqual(new Uint8Array([1, 2, 3]))
    expect(new Set(store.projectIds())).toEqual(new Set(['project-a', 'project-b']))
  })

  it('enumerates in-memory owners when persistence throws, so external deletion can release Files', () => {
    const storage = new MemoryStorage()
    storage.setItem = () => { throw new Error('quota exceeded') }
    const store = new ChatUploadStore(storage)
    store.stage('background-project', 'session-a', [uploadFile('paper.pdf', new Uint8Array([1]))])

    expect(store.projectIds()).toEqual(['background-project'])
    expect(store.clearProject('background-project')).toHaveLength(1)
    expect(store.projectIds()).toEqual([])
  })

  it('permits only one upload driver per exact file scope', () => {
    const store = new ChatUploadStore()
    const [item] = store.stage('project-a', 'session-a', [uploadFile('paper.pdf', new Uint8Array([1]))])
    const first = store.beginDrive('project-a', 'session-a', item!.fileId)

    expect(first).toBeTypeOf('symbol')
    expect(store.beginDrive('project-a', 'session-a', item!.fileId)).toBeNull()
    expect(store.endDrive('project-a', 'session-a', item!.fileId, Symbol('wrong'))).toBe(false)
    expect(store.endDrive('project-a', 'session-a', item!.fileId, first!)).toBe(true)
    expect(store.beginDrive('project-a', 'session-a', item!.fileId)).toBeTypeOf('symbol')
  })

  it('hashes a file incrementally with bounded slices', async () => {
    const bytes = new Uint8Array(25).map((_, index) => index)
    const reads: Array<[number, number]> = []
    const digest = await sha256File(uploadFile('large.bin', bytes, reads), 8)

    expect(digest).toBe(createHash('sha256').update(bytes).digest('hex'))
    expect(reads).toEqual([[0, 8], [8, 16], [16, 24], [24, 25]])
  })
})
