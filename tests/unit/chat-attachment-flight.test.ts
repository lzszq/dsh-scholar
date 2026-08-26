import { describe, expect, it } from 'vitest'
import { ChatAttachmentFlightStore } from '../../packages/dsh-research-ui/src/client/chat-attachment-flight'

describe('Scholar Chat attachment continuation ownership', () => {
  it('survives composer remounts and tombstones an exact closed session', () => {
    const store = new ChatAttachmentFlightStore()
    const first = store.signal('project-a', 'session-a')!
    expect(store.signal('project-a', 'session-a')).toBe(first)
    expect(store.projectIds()).toEqual(['project-a'])

    expect(store.cancel('project-a', 'session-a')).toBe(true)
    expect(first.aborted).toBe(true)
    expect(store.signal('project-a', 'session-a')).toBeUndefined()
    expect(store.projectIds()).toEqual([])
  })

  it('cancels every continuation owned by a deleted project without touching another project', () => {
    const a = new ChatAttachmentFlightStore()
    const a1 = a.signal('project-a', 'session-1')!
    const a2 = a.signal('project-a', 'session-2')!
    const b = a.signal('project-b', 'session-1')!

    expect(a.cancelProject('project-a')).toBe(2)
    expect(a1.aborted).toBe(true)
    expect(a2.aborted).toBe(true)
    expect(b.aborted).toBe(false)
    expect(a.signal('project-a', 'new-session')).toBeUndefined()
    expect(a.projectIds()).toEqual(['project-b'])
  })
})
