import { describe, expect, it } from 'vitest'
import { ChatTurnFlightStore } from '../../packages/dsh-research-ui/src/client/chat-turn-flight'

describe('Scholar Chat exact-session single-flight state', () => {
  it('survives composer remounts and isolates other projects and sessions', () => {
    const flights = new ChatTurnFlightStore()

    expect(flights.begin('project-a', 'chat-1')).toBe(true)
    expect(flights.active('project-a', 'chat-1')).toBe(true)
    expect(flights.begin('project-a', 'chat-1')).toBe(false)
    expect(flights.active('project-a', 'chat-2')).toBe(false)
    expect(flights.active('project-b', 'chat-1')).toBe(false)

    expect(flights.end('project-a', 'chat-2')).toBe(false)
    expect(flights.end('project-a', 'chat-1')).toBe(true)
    expect(flights.active('project-a', 'chat-1')).toBe(false)
    expect(flights.begin('project-a', 'chat-1')).toBe(true)
  })

  it('aborts an exact session or every flight owned by a deleted project', () => {
    const flights = new ChatTurnFlightStore()
    flights.begin('project-a', 'chat-1')
    flights.begin('project-a', 'chat-2')
    flights.begin('project-b', 'chat-1')
    const exact = flights.signal('project-a', 'chat-1')!
    const sibling = flights.signal('project-a', 'chat-2')!
    const foreign = flights.signal('project-b', 'chat-1')!

    expect(flights.cancel('project-a', 'chat-1')).toBe(true)
    expect(exact.aborted).toBe(true)
    expect(sibling.aborted).toBe(false)
    expect(flights.cancelProject('project-a')).toBe(1)
    expect(sibling.aborted).toBe(true)
    expect(foreign.aborted).toBe(false)
    expect(flights.active('project-b', 'chat-1')).toBe(true)
    expect(flights.projectIds()).toEqual(['project-b'])
  })
})
