import { describe, expect, it } from 'vitest'
import {
  executeStandaloneChatTurn,
} from '../../packages/dsh-research-ui/src/standalone/chat-turn-route'
import {
  ScholarAgentBridgeError,
} from '../../packages/dsh-research-ui/src/standalone/chat-agent-client'

const request = {
  project_id: 'rsp_1',
  session_id: 'chat_1',
  text: 'Discuss the next experiment',
  locale: 'en' as const,
  history: [],
  images: [],
}

function options(overrides: Partial<Parameters<typeof executeStandaloneChatTurn>[1]> = {}) {
  return {
    dataDir: '/private/scholar',
    kernelEndpoint: 'http://127.0.0.1:9010',
    upstreamAuthHeaders: { authorization: 'Bearer upstream' },
    enforceMembership: false,
    isProjectMember: async () => true,
    fetchImpl: async () => new Response(JSON.stringify({
      project: { project_id: 'rsp_1', name: 'Authoritative', status: 'IDEATION' },
      next_actions_v2: [{ code: 'idea_generate' }],
    }), { status: 200, headers: { 'content-type': 'application/json' } }),
    requestAgent: async (_dataDir, value) => ({
      operation: 'conversation' as const,
      assistant_text: `reply:${value.operation === 'conversation' ? value.project.name : ''}`,
    }),
    ...overrides,
  }
}

describe('standalone free-conversation route', () => {
  it('enforces membership before projection or model access', async () => {
    let touchedUpstream = false
    const result = await executeStandaloneChatTurn(request, options({
      enforceMembership: true,
      isProjectMember: async () => false,
      fetchImpl: async () => { touchedUpstream = true; throw new Error('must not fetch') },
    }))

    expect(result).toMatchObject({ status: 404, payload: { error: { code: 'project_not_found' } } })
    expect(touchedUpstream).toBe(false)
  })

  it('fails closed on unavailable or malformed authoritative projections', async () => {
    const unavailable = await executeStandaloneChatTurn(request, options({
      fetchImpl: async () => new Response('{}', { status: 503 }),
    }))
    const malformed = await executeStandaloneChatTurn(request, options({
      fetchImpl: async () => new Response('not json', { status: 200 }),
    }))

    expect(unavailable).toMatchObject({ status: 502, payload: { error: { code: 'kernel_unreachable' } } })
    expect(malformed).toMatchObject({ status: 502, payload: { error: { code: 'kernel_unreachable' } } })
  })

  it('uses authoritative project context and carries the caller cancellation signal', async () => {
    const controller = new AbortController()
    let projectionSignal: AbortSignal | null | undefined
    let agentSignal: AbortSignal | undefined
    const result = await executeStandaloneChatTurn(request, options({
      signal: controller.signal,
      fetchImpl: async (_input, init) => {
        projectionSignal = init?.signal
        return new Response(JSON.stringify({
          project: { name: 'Server Project', status: 'RUNNING', brief_status: 'confirmed' },
          next_actions_v2: [],
        }), { status: 200 })
      },
      requestAgent: async (_dataDir, value, _timeout, signal) => {
        agentSignal = signal
        expect(value).toMatchObject({
          operation: 'conversation',
          project: { project_id: 'rsp_1', name: 'Server Project', status: 'RUNNING', brief_status: 'confirmed' },
        })
        return { operation: 'conversation', assistant_text: 'model answer' }
      },
    }))

    expect(result).toEqual({ status: 200, payload: { operation: 'conversation', assistant_text: 'model answer' } })
    expect(projectionSignal).toBe(controller.signal)
    expect(agentSignal).toBe(controller.signal)
  })

  it.each([
    ['vision_model_required', 422],
    ['vision_image_rejected', 422],
    ['vision_attachment_service_unavailable', 503],
    ['payload_too_large', 413],
  ] as const)('maps bridge code %s to HTTP %s', async (code, status) => {
    const result = await executeStandaloneChatTurn(request, options({
      requestAgent: async () => { throw new ScholarAgentBridgeError(code) },
    }))

    expect(result).toMatchObject({ status, payload: { error: { code } } })
  })
})
