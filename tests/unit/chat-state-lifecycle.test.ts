import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  chatActivateProject,
  chatDeactivateProject,
  chatDiscardProject,
  chatPushToProjectSession,
  chatSessionClose,
  chatUpsertAttachmentForProjectSession,
  state,
} from '../../packages/dsh-research-ui/src/client/state'

class MemoryStorage implements Storage {
  private readonly values = new Map<string, string>()
  get length(): number { return this.values.size }
  clear(): void { this.values.clear() }
  getItem(key: string): string | null { return this.values.get(key) ?? null }
  key(index: number): string | null { return [...this.values.keys()][index] ?? null }
  removeItem(key: string): void { this.values.delete(key) }
  setItem(key: string, value: string): void { this.values.set(key, value) }
}

afterEach(() => {
  chatDeactivateProject()
  vi.unstubAllGlobals()
  state.chatSessions = []
  state.chatMessages = []
  state.chatActiveId = null
})

describe('Chat state lifecycle write fence', () => {
  it('hydrates a persisted close into the global tombstone before awaiting the network', async () => {
    vi.resetModules()
    const storage = new MemoryStorage()
    const projectId = `project-hydrated-${crypto.randomUUID()}`
    const sessionId = `session-hydrated-${crypto.randomUUID()}`
    storage.setItem('dsh-scholar.chat-scope-close.v1', JSON.stringify([{ projectId, sessionId }]))
    const projectStore = await import('../../packages/dsh-research-ui/src/client/chat-project-store')
    projectStore.saveChatProjectSnapshot(storage, {
      projectId,
      sessions: [{ project_id: projectId, id: sessionId, name: 'Recovered', messages: [] }],
      activeId: sessionId,
      draft: '', history: [], detailIndex: -1, quoteTarget: null,
      searchQuery: '', commandsOnly: false, sessionSearchQuery: '',
    })
    vi.stubGlobal('localStorage', storage)
    let releaseClose: ((response: Response) => void) | undefined
    let signalCloseStarted: (() => void) | undefined
    const closeStarted = new Promise<void>(resolve => { signalCloseStarted = resolve })
    vi.stubGlobal('fetch', vi.fn((input: string | URL | Request) => {
      if (String(input).endsWith('/api/session/csrf')) {
        return Promise.resolve(new Response(JSON.stringify({ csrf_token: 'test-csrf' }), {
          status: 200, headers: { 'content-type': 'application/json' },
        }))
      }
      return new Promise<Response>(resolve => {
        releaseClose = resolve
        signalCloseStarted?.()
      })
    }))
    const freshState = await import('../../packages/dsh-research-ui/src/client/state')

    freshState.chatActivateProject(projectId)

    expect(freshState.chatPushToProjectSession(projectId, sessionId, {
      role: 'assistant', text: 'late transcript', time: 'now',
    })).toBe(false)
    expect(freshState.chatUpsertAttachmentForProjectSession(projectId, sessionId, {
      role: 'user', text: 'late attachment', time: 'now',
      attachment: {
        kind: 'intake-upload', project_id: projectId, intake_id: 'intake-1',
        upload_id: 'upload-1', file_name: 'late.pdf', state: 'staged',
      },
    })).toBe(false)

    await closeStarted
    releaseClose!(new Response(JSON.stringify({ error: { code: 'not_found' } }), {
      status: 404, headers: { 'content-type': 'application/json' },
    }))
    await freshState.flushChatScopeCloseOutbox(projectId)
    freshState.chatDeactivateProject()
  })

  it('rejects transcript and attachment writes immediately after exact-session close', () => {
    vi.stubGlobal('localStorage', new MemoryStorage())
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: { code: 'not_found' } }), {
      status: 404,
      headers: { 'content-type': 'application/json' },
    })))
    const projectId = `project-late-write-${crypto.randomUUID()}`
    chatActivateProject(projectId)
    const sessionId = state.chatActiveId!

    chatSessionClose(sessionId)

    expect(chatPushToProjectSession(projectId, sessionId, {
      role: 'assistant', text: 'late answer', time: 'now',
    })).toBe(false)
    expect(chatUpsertAttachmentForProjectSession(projectId, sessionId, {
      role: 'user', text: 'late attachment', time: 'now',
      attachment: {
        kind: 'intake-upload', project_id: projectId, intake_id: 'intake-1',
        upload_id: 'upload-1', file_name: 'late.pdf', state: 'staged',
      },
    })).toBe(false)
  })

  it('rejects transcript and attachment writes for every session after project discard', () => {
    vi.stubGlobal('localStorage', new MemoryStorage())
    const projectId = `project-discard-${crypto.randomUUID()}`
    chatActivateProject(projectId)
    const first = state.chatActiveId!
    state.chatSessions.push({ project_id: projectId, id: 'session-second', name: 'Chat 2', messages: [] })

    chatDiscardProject(projectId)

    for (const sessionId of [first, 'session-second']) {
      expect(chatPushToProjectSession(projectId, sessionId, {
        role: 'assistant', text: 'late answer', time: 'now',
      })).toBe(false)
      expect(chatUpsertAttachmentForProjectSession(projectId, sessionId, {
        role: 'user', text: 'late attachment', time: 'now',
        attachment: {
          kind: 'intake-upload', project_id: projectId, intake_id: 'intake-1',
          upload_id: 'upload-1', file_name: 'late.pdf', state: 'staged',
        },
      })).toBe(false)
    }
  })
})
