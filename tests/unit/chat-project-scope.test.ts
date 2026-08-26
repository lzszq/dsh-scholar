import { beforeEach, describe, expect, it } from 'vitest'
import type { ChatMessage, ChatSession } from '../../packages/dsh-research-ui/src/client/types'
import {
  appendStoredChatMessage,
  appendStoredChatHistory,
  chatProjectStorageKeys,
  consumeStoredChatQuote,
  deleteChatProjectSnapshot,
  listChatProjectSnapshotIds,
  loadChatProjectSnapshot,
  saveChatProjectSnapshot,
  type ChatProjectSnapshot,
  type KeyValueStorage,
} from '../../packages/dsh-research-ui/src/client/chat-project-store'

class MemoryStorage implements KeyValueStorage {
  readonly values = new Map<string, string>()
  get length(): number { return this.values.size }
  key(index: number): string | null { return [...this.values.keys()][index] ?? null }
  getItem(key: string): string | null { return this.values.get(key) ?? null }
  setItem(key: string, value: string): void { this.values.set(key, value) }
  removeItem(key: string): void { this.values.delete(key) }
}

function snapshot(projectId: string, text: string): ChatProjectSnapshot {
  const session: ChatSession = {
    project_id: projectId,
    id: 'same-name',
    name: 'Chat 1',
    messages: [{ role: 'user', text, time: '10:00' }],
  }
  return {
    projectId,
    sessions: [session],
    activeId: session.id,
    draft: `${projectId}-draft`,
    history: [`/${projectId}`],
    detailIndex: -1,
    quoteTarget: null,
    searchQuery: '',
    commandsOnly: false,
    sessionSearchQuery: '',
  }
}

describe('CHAT-SCOPE-01 project-scoped browser persistence', () => {
  let storage: MemoryStorage
  beforeEach(() => { storage = new MemoryStorage() })

  it('uses distinct keys and restores only the requested project', () => {
    const a = snapshot('project A/1', 'alpha')
    const b = snapshot('project B/2', 'beta')
    saveChatProjectSnapshot(storage, a)
    saveChatProjectSnapshot(storage, b)

    expect(chatProjectStorageKeys(a.projectId).sessions).not.toBe(chatProjectStorageKeys(b.projectId).sessions)
    expect(loadChatProjectSnapshot(storage, a.projectId)).toMatchObject({
      projectId: a.projectId,
      activeId: 'same-name',
      draft: 'project A/1-draft',
      sessions: [{ project_id: a.projectId, messages: [{ text: 'alpha' }] }],
    })
    expect(loadChatProjectSnapshot(storage, b.projectId).sessions[0]?.messages[0]?.text).toBe('beta')
  })

  it('fails closed on foreign sessions and attachment references', () => {
    const keys = chatProjectStorageKeys('project-a')
    storage.setItem(keys.sessions, JSON.stringify([
      snapshot('project-b', 'foreign').sessions[0],
      {
        ...snapshot('project-a', 'own').sessions[0],
        messages: [
          { role: 'user', text: 'bad', time: '10:00', attachment: { kind: 'intake-upload', project_id: 'project-b', intake_id: 'i', upload_id: 'u', file_name: 'x', state: 'staged' } },
          { role: 'assistant', text: 'safe', time: '10:01' },
        ],
      },
    ]))
    storage.setItem(keys.active, 'same-name')

    const loaded = loadChatProjectSnapshot(storage, 'project-a')
    expect(loaded.sessions).toHaveLength(1)
    expect(loaded.sessions[0]?.messages.map(message => message.text)).toEqual(['safe'])
  })

  it('writes a delayed reply to its origin project/session without touching another project', () => {
    saveChatProjectSnapshot(storage, snapshot('project-a', 'alpha'))
    saveChatProjectSnapshot(storage, snapshot('project-b', 'beta'))
    const reply: ChatMessage = { role: 'assistant', text: 'late A result', time: '10:02' }

    expect(appendStoredChatMessage(storage, 'project-a', 'same-name', reply, true)).toBe(true)
    expect(loadChatProjectSnapshot(storage, 'project-a').sessions[0]?.messages.at(-1)?.text).toBe('late A result')
    expect(loadChatProjectSnapshot(storage, 'project-b').sessions[0]?.messages.map(message => message.text)).toEqual(['beta'])
  })

  it('writes delayed command history to the originating project after navigation', () => {
    saveChatProjectSnapshot(storage, snapshot('project-a', 'alpha'))
    saveChatProjectSnapshot(storage, snapshot('project-b', 'beta'))

    expect(appendStoredChatHistory(storage, 'project-a', '/status project-a')).toBe(true)
    expect(loadChatProjectSnapshot(storage, 'project-a').history).toEqual(['/project-a', '/status project-a'])
    expect(loadChatProjectSnapshot(storage, 'project-b').history).toEqual(['/project-b'])
  })

  it('consumes a delayed quote only from its exact origin project and session', () => {
    const a = snapshot('project-a', 'alpha')
    a.quoteTarget = { session_id: 'same-name', index: 0, text: 'alpha' }
    const b = snapshot('project-b', 'beta')
    b.quoteTarget = { session_id: 'same-name', index: 0, text: 'beta' }
    saveChatProjectSnapshot(storage, a)
    saveChatProjectSnapshot(storage, b)

    expect(consumeStoredChatQuote(storage, 'project-a', 'other-session', a.quoteTarget)).toBe(false)
    expect(consumeStoredChatQuote(storage, 'project-a', 'same-name', a.quoteTarget)).toBe(true)
    expect(loadChatProjectSnapshot(storage, 'project-a').quoteTarget).toBeNull()
    expect(loadChatProjectSnapshot(storage, 'project-b').quoteTarget).toEqual(b.quoteTarget)
  })

  it('ignores the old global transcript keys instead of guessing a project', () => {
    storage.setItem('dsh-scholar-ui-chat', JSON.stringify([{ role: 'user', text: 'legacy secret', time: 'x' }]))
    storage.setItem('dsh-scholar-ui-sessions', JSON.stringify([snapshot('unknown', 'legacy secret').sessions[0]]))
    expect(loadChatProjectSnapshot(storage, 'project-a').sessions).toEqual([])
  })

  it('removes every project-scoped transcript key on destructive deletion', () => {
    saveChatProjectSnapshot(storage, snapshot('project-a', 'private transcript'))
    saveChatProjectSnapshot(storage, snapshot('project-b', 'retained transcript'))

    deleteChatProjectSnapshot(storage, 'project-a')

    expect(loadChatProjectSnapshot(storage, 'project-a').sessions).toEqual([])
    expect(loadChatProjectSnapshot(storage, 'project-b').sessions[0]?.messages[0]?.text).toBe('retained transcript')
  })

  it('enumerates background project scopes for external deletion reconciliation', () => {
    saveChatProjectSnapshot(storage, snapshot('project A/1', 'alpha'))
    saveChatProjectSnapshot(storage, snapshot('project-b', 'beta'))
    storage.setItem('unrelated', 'value')
    storage.setItem('dsh-scholar-ui-chat-v1:sessions:%E0%A4%A', 'malformed escape')

    expect(new Set(listChatProjectSnapshotIds(storage))).toEqual(new Set(['project A/1', 'project-b']))
    deleteChatProjectSnapshot(storage, 'project A/1')
    expect(listChatProjectSnapshotIds(storage)).toEqual(['project-b'])
  })
})
