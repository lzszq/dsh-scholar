import { describe, expect, it, vi } from 'vitest'
import { ModelPreferenceCommit } from '../../packages/dsh-research-ui/src/client/model-preference'

describe('acknowledged Scholar model preference', () => {
  it('does not let a late initial read replace an in-flight user selection or its send barrier', async () => {
    let persistResult: ((value: boolean) => void) | undefined
    const preference = new ModelPreferenceCommit()
    const selected = preference.select('deepseek/vision', () => new Promise<boolean>(resolve => { persistResult = resolve }))

    expect(preference.initialize('deepseek/stale-server-value')).toBe(false)
    let released = false
    const barrier = preference.barrier().then(value => { released = true; return value })
    await vi.waitFor(() => { expect(persistResult).toBeTypeOf('function') })
    expect(released).toBe(false)

    persistResult?.(true)
    await expect(selected).resolves.toBe(true)
    await expect(barrier).resolves.toBe(true)
    expect(preference.acknowledged()).toBe('deepseek/vision')
  })

  it('holds an immediate send behind the in-flight persistence acknowledgement', async () => {
    let acknowledge: ((value: boolean) => void) | undefined
    const persist = vi.fn(() => new Promise<boolean>(resolve => { acknowledge = resolve }))
    const preference = new ModelPreferenceCommit('deepseek/text')

    const commit = preference.select('deepseek/org/vision', persist)
    let released = false
    const barrier = preference.barrier().then(value => { released = true; return value })

    await vi.waitFor(() => { expect(acknowledge).toBeTypeOf('function') })
    expect(released).toBe(false)
    expect(preference.acknowledged()).toBe('deepseek/text')

    acknowledge?.(true)
    await expect(commit).resolves.toBe(true)
    await expect(barrier).resolves.toBe(true)
    expect(preference.acknowledged()).toBe('deepseek/org/vision')
  })

  it('keeps the last acknowledged selection when persistence fails', async () => {
    const preference = new ModelPreferenceCommit('deepseek/text')

    await expect(preference.select('deepseek/org/vision', async () => false)).resolves.toBe(false)
    await expect(preference.barrier()).resolves.toBe(false)
    expect(preference.acknowledged()).toBe('deepseek/text')
  })
})
