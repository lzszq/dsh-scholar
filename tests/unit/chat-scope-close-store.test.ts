import { describe, expect, it } from 'vitest'
import { ChatScopeCloseStore } from '../../packages/dsh-research-ui/src/client/chat-scope-close-store'
import type { KeyValueStorage } from '../../packages/dsh-research-ui/src/client/chat-project-store'

function memoryStorage(seed = new Map<string, string>()): KeyValueStorage {
  return {
    getItem: key => seed.get(key) ?? null,
    setItem: (key, value) => { seed.set(key, value) },
    removeItem: key => { seed.delete(key) },
  }
}

describe('ChatScopeCloseStore', () => {
  it('persists pending closes across a page reload and removes an ACKed item', () => {
    const data = new Map<string, string>()
    const first = new ChatScopeCloseStore()
    expect(first.enqueue(memoryStorage(data), 'rsp_one', 's-one')).toBe(true)

    const reloaded = new ChatScopeCloseStore()
    reloaded.hydrate(memoryStorage(data))
    expect(reloaded.entries()).toEqual([{ projectId: 'rsp_one', sessionId: 's-one' }])
    reloaded.complete(memoryStorage(data), 'rsp_one', 's-one')
    expect(new ChatScopeCloseStore().entries()).toEqual([])
    const final = new ChatScopeCloseStore()
    final.hydrate(memoryStorage(data))
    expect(final.entries()).toEqual([])
  })

  it('retains a page-lifetime pending close when storage writes fail', () => {
    const store = new ChatScopeCloseStore()
    const broken: KeyValueStorage = {
      getItem: () => null,
      setItem: () => { throw new Error('quota') },
      removeItem: () => { throw new Error('private mode') },
    }
    expect(store.enqueue(broken, 'rsp_two', 's-two')).toBe(false)
    expect(store.entries()).toEqual([{ projectId: 'rsp_two', sessionId: 's-two' }])
    expect(store.projectIds()).toEqual(['rsp_two'])
  })
})
