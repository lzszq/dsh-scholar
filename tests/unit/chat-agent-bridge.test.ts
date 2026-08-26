import { afterEach, describe, expect, it, vi } from 'vitest'
import { chmodSync, existsSync, lstatSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ScholarAgentBridge } from '../../src/plugin/chat-agent-service'
import { requestScholarAgent, ScholarAgentBridgeError } from '../../packages/dsh-research-ui/src/standalone/chat-agent-client'
import { ScholarAgentError } from '../../src/plugin/chat-agent-error'

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('private Scholar agent bridge', () => {
  it('keeps endpoint credentials private and carries only validated local model turns', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'scholar-agent-bridge-'))
    dirs.push(dataDir)
    const service = new ScholarAgentBridge({
      dataDir,
      handler: () => async payload => {
        const request = payload as { operation?: string; text?: string }
        return { operation: 'conversation', assistant_text: `answer:${request.text}` }
      },
    })
    await service.start()
    const descriptorFile = join(dataDir, 'agent-bridge.json')
    expect(lstatSync(descriptorFile).mode & 0o777).toBe(0o600)
    expect(existsSync(join(dataDir, 'agent-bridge-endpoint.json'))).toBe(false)
    expect(existsSync(join(dataDir, 'agent-bridge-token'))).toBe(false)

    await expect(requestScholarAgent(dataDir, {
      operation: 'conversation', session_id: 'chat_1', text: 'hello', locale: 'en',
      project: { project_id: 'rsp_1', next_actions_v2: [] }, history: [], images: [],
    })).resolves.toEqual({ operation: 'conversation', assistant_text: 'answer:hello' })

    await service.stop()
    expect(existsSync(descriptorFile)).toBe(false)
  })

  it('fails closed while the DSH llm service is unavailable', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'scholar-agent-bridge-'))
    dirs.push(dataDir)
    const service = new ScholarAgentBridge({ dataDir, handler: () => undefined })
    await service.start()
    await expect(requestScholarAgent(dataDir, {
      operation: 'conversation', session_id: 'chat_1', text: 'hello', locale: 'en',
      project: { project_id: 'rsp_1', next_actions_v2: [] }, history: [], images: [],
    }, 2_000)).rejects.toThrow()
    await service.stop()
  })

  it('aborts the exact model turn when the response disconnects after a complete request body', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'scholar-agent-bridge-'))
    dirs.push(dataDir)
    let started!: () => void
    const entered = new Promise<void>(resolve => { started = resolve })
    let observedAbort!: () => void
    const aborted = new Promise<void>(resolve => { observedAbort = resolve })
    const service = new ScholarAgentBridge({
      dataDir,
      handler: () => async (_payload, signal) => {
        started()
        await new Promise<void>((_resolve, reject) => signal?.addEventListener('abort', () => {
          observedAbort()
          reject(new Error('aborted'))
        }, { once: true }))
        return { operation: 'conversation', assistant_text: 'unreachable' }
      },
    })
    await service.start()
    const request = requestScholarAgent(dataDir, {
      operation: 'conversation', session_id: 'chat_1', text: 'hello', locale: 'en',
      project: { project_id: 'rsp_1', next_actions_v2: [] }, history: [], images: [],
    }, 25).catch(error => error as Error)

    await entered
    await expect(request).resolves.toBeInstanceOf(Error)
    await aborted
    await service.stop()
  })

  it('propagates an upstream browser/session cancellation to the bridge request', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'scholar-agent-bridge-'))
    dirs.push(dataDir)
    let started!: () => void
    const entered = new Promise<void>(resolve => { started = resolve })
    let observedAbort!: () => void
    const aborted = new Promise<void>(resolve => { observedAbort = resolve })
    const service = new ScholarAgentBridge({
      dataDir,
      handler: () => async (_payload, signal) => {
        started()
        await new Promise<void>((_resolve, reject) => signal?.addEventListener('abort', () => {
          observedAbort()
          reject(new Error('aborted'))
        }, { once: true }))
        return { operation: 'conversation', assistant_text: 'unreachable' }
      },
    })
    await service.start()
    const controller = new AbortController()
    const pending = requestScholarAgent(dataDir, {
      operation: 'conversation', session_id: 'chat_1', text: 'hello', locale: 'en',
      project: { project_id: 'rsp_1', next_actions_v2: [] }, history: [], images: [],
    }, 5_000, controller.signal).catch(error => error as Error)

    await entered
    controller.abort()
    await aborted
    await expect(pending).resolves.toBeInstanceOf(Error)
    await service.stop()
  })

  it('stops accepting, aborts active turns and completes disposal even when the model ignores cancellation', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'scholar-agent-bridge-'))
    dirs.push(dataDir)
    let started!: () => void
    const entered = new Promise<void>(resolve => { started = resolve })
    let observedAbort = false
    const service = new ScholarAgentBridge({
      dataDir,
      handler: () => async (_payload, signal) => {
        started()
        await new Promise<void>(() => signal?.addEventListener('abort', () => {
          observedAbort = true
        }, { once: true }))
        return { operation: 'conversation', assistant_text: 'unreachable' }
      },
    })
    await service.start()
    const request = requestScholarAgent(dataDir, {
      operation: 'conversation', session_id: 'chat_1', text: 'hello', locale: 'en',
      project: { project_id: 'rsp_1', next_actions_v2: [] }, history: [], images: [],
    }).catch(error => error as Error)

    await entered
    await expect(Promise.race([
      service.stop().then(() => 'stopped'),
      new Promise(resolve => setTimeout(() => resolve('timed-out'), 1_000)),
    ])).resolves.toBe('stopped')
    expect(observedAbort).toBe(true)
    await expect(request).resolves.toBeInstanceOf(Error)
    expect(existsSync(join(dataDir, 'agent-bridge.json'))).toBe(false)
  })

  it('carries a bounded multi-megabyte visual turn over loopback and preserves only safe vision failure codes', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'scholar-agent-bridge-'))
    dirs.push(dataDir)
    let receivedBytes = 0
    let rejectVision = false
    const service = new ScholarAgentBridge({
      dataDir,
      handler: () => async payload => {
        if (rejectVision) throw new ScholarAgentError('vision_model_required', 'message text is not protocol')
        const request = payload as { images?: Array<{ data?: string }> }
        receivedBytes = Buffer.from(request.images?.[0]?.data ?? '', 'base64').byteLength
        return { operation: 'conversation', assistant_text: 'visual answer' }
      },
    })
    await service.start()
    const imageData = Buffer.alloc(1_200_000, 7).toString('base64')
    const request = {
      operation: 'conversation' as const, session_id: 'chat_1', text: 'inspect', locale: 'en' as const,
      project: { project_id: 'rsp_1', next_actions_v2: [] }, history: [],
      images: [{ mediaType: 'image/png' as const, data: imageData, name: 'large.png' }],
    }

    await expect(requestScholarAgent(dataDir, request)).resolves.toEqual({
      operation: 'conversation', assistant_text: 'visual answer',
    })
    expect(receivedBytes).toBe(1_200_000)

    rejectVision = true
    await expect(requestScholarAgent(dataDir, request)).rejects.toMatchObject<Partial<ScholarAgentBridgeError>>({
      name: 'ScholarAgentBridgeError', code: 'vision_model_required',
    })
    await service.stop()
  })

  it('preserves payload_too_large instead of disguising an oversized visual envelope as model unavailability', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'scholar-agent-bridge-'))
    dirs.push(dataDir)
    const service = new ScholarAgentBridge({
      dataDir,
      handler: () => async () => ({ operation: 'conversation', assistant_text: 'must not run' }),
    })
    await service.start()
    const request = {
      operation: 'conversation' as const, session_id: 'chat_1', text: 'inspect', locale: 'en' as const,
      project: { project_id: 'rsp_1', next_actions_v2: [] }, history: [],
      images: [{ mediaType: 'image/png' as const, data: 'A'.repeat(16 * 1024 * 1024), name: 'too-large.png' }],
    }

    await expect(requestScholarAgent(dataDir, request)).rejects.toMatchObject<Partial<ScholarAgentBridgeError>>({
      name: 'ScholarAgentBridgeError', code: 'payload_too_large',
    })
    await service.stop()
  })

  it('maps a typed Scholar agent failure by code instead of coupling the protocol to its message text', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'scholar-agent-bridge-'))
    dirs.push(dataDir)
    const service = new ScholarAgentBridge({
      dataDir,
      handler: () => async () => { throw new ScholarAgentError('vision_model_required', 'arbitrary diagnostic') },
    })
    await service.start()

    await expect(requestScholarAgent(dataDir, {
      operation: 'conversation', session_id: 'chat_1', text: 'inspect', locale: 'en',
      project: { project_id: 'rsp_1', next_actions_v2: [] }, history: [], images: [],
    })).rejects.toMatchObject<Partial<ScholarAgentBridgeError>>({ code: 'vision_model_required' })
    await service.stop()
  })

  it('restores the surviving bridge metadata after an overlapping plugin reload disposes the newer instance', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'scholar-agent-bridge-'))
    dirs.push(dataDir)
    const older = new ScholarAgentBridge({
      dataDir,
      handler: () => async () => ({ operation: 'conversation', assistant_text: 'older' }),
    })
    vi.resetModules()
    const { ScholarAgentBridge: ReloadedScholarAgentBridge } = await import('../../src/plugin/chat-agent-service')
    const newer = new ReloadedScholarAgentBridge({
      dataDir,
      handler: () => async () => ({ operation: 'conversation', assistant_text: 'newer' }),
    })
    await older.start()
    await newer.start()
    const request = {
      operation: 'conversation' as const, session_id: 'chat_1', text: 'hello', locale: 'en' as const,
      project: { project_id: 'rsp_1', next_actions_v2: [] }, history: [], images: [],
    }

    await expect(requestScholarAgent(dataDir, request)).resolves.toMatchObject({ assistant_text: 'newer' })
    await newer.stop()
    await expect(requestScholarAgent(dataDir, request)).resolves.toMatchObject({ assistant_text: 'older' })

    await older.stop()
    expect(existsSync(join(dataDir, 'agent-bridge.json'))).toBe(false)
  })

  it('keeps the previous complete descriptor when replacement publication fails', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'scholar-agent-bridge-'))
    dirs.push(dataDir)
    const older = new ScholarAgentBridge({
      dataDir,
      handler: () => async () => ({ operation: 'conversation', assistant_text: 'older' }),
    })
    const newer = new ScholarAgentBridge({
      dataDir,
      handler: () => async () => ({ operation: 'conversation', assistant_text: 'newer' }),
    })
    await older.start()
    const request = {
      operation: 'conversation' as const, session_id: 'chat_1', text: 'hello', locale: 'en' as const,
      project: { project_id: 'rsp_1', next_actions_v2: [] }, history: [], images: [],
    }

    chmodSync(dataDir, 0o500)
    try {
      await expect(newer.start()).rejects.toThrow()
    } finally {
      chmodSync(dataDir, 0o700)
    }
    await expect(requestScholarAgent(dataDir, request)).resolves.toMatchObject({ assistant_text: 'older' })
    await older.stop()
  })
})
