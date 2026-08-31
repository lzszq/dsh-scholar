import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  cachedGrillGuide,
  clearCachedGrillGuide,
  executeChatCommand,
  executeChatTurn,
} from '../../packages/dsh-research-ui/src/client/chat'
import { state } from '../../packages/dsh-research-ui/src/client/state'

function json(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}

afterEach(() => {
  clearCachedGrillGuide()
  vi.unstubAllGlobals()
  state.chatMessages = []
  state.chatSessions = []
  state.chatActiveId = null
  state.projectId = undefined
  state.rerender = () => {}
})

describe('project-scoped free conversation', () => {
  it('does not encode pending images for a slash command', async () => {
    const loadImages = vi.fn(async () => { throw new Error('must not encode') })

    const result = await executeChatTurn('/help', 'prj_1', undefined, loadImages)

    expect(result.text).toContain('/new <name>')
    expect(loadImages).not.toHaveBeenCalled()
  })

  it('records a collecting Brief answer from the ordinary Chat composer without duplicating the next question', async () => {
    const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const path = String(input)
      if (path.endsWith('/grill') && init?.method !== 'POST') {
        return json({
          project_id: 'prj_1', project_revision: 1, intake_id: 'int_1', intake_revision: 1,
          question: { question_code: 'brief.problem', question_revision: 1, prompt_key: 'grill.question.problem', required: true },
          answers: [], brief_preview: { problem: '', scope: '', primary_metrics: [], target_outputs: [] },
          ready_to_confirm: false,
        })
      }
      if (path.endsWith('/grill/answers')) {
        return json({
          project_id: 'prj_1', project_revision: 1, intake_id: 'int_1', intake_revision: 2,
          question: { question_code: 'brief.scope', question_revision: 1, prompt_key: 'grill.question.scope', required: true },
          answers: [{
            question_code: 'brief.problem', question_revision: 2, value: '提升低资源 OCR', disposition: 'answered',
            answered_by: 'local-operator', answered_at: '2026-08-17T00:00:00.000Z',
          }],
          brief_preview: { problem: '提升低资源 OCR', scope: '', primary_metrics: [], target_outputs: [] },
          ready_to_confirm: false,
        })
      }
      throw new Error(`unexpected request: ${path}`)
    })
    vi.stubGlobal('fetch', fetch)
    const host = vi.fn()

    const result = await executeChatTurn('提升低资源 OCR', 'prj_1', host)

    expect(result.text).toMatch(/已记录|recorded/i)
    expect(result.text).not.toContain('研究范围是什么')
    expect(host).not.toHaveBeenCalled()
    const post = fetch.mock.calls.find(([, init]) => init?.method === 'POST')
    expect(JSON.parse(String(post?.[1]?.body))).toEqual({
      question_code: 'brief.problem', question_revision: 1, value: '提升低资源 OCR', disposition: 'answered',
    })
  })

  it('uses an optional model adapter with a bounded project projection and keeps slash suggestions editable', async () => {
    const fetch = vi.fn(async (input: string | URL | Request) => {
      const path = String(input)
      if (path.endsWith('/grill')) {
        return json({
          project_revision: 2,
          intake_revision: 2,
          question: null,
          brief_preview: { problem: '', scope: '', primary_metrics: [], target_outputs: [] },
          ready_to_confirm: false,
        })
      }
      return json({
        project: { project_id: 'prj_1', name: 'Demo', status: 'SCOPED', brief_status: 'confirmed' },
        next_actions_v2: [{
          code: 'survey_run', label: 'Run survey', reason: 'Corpus required',
          state: 'blocked', required: ['scope_gate'], required_by: 'agent', route: 'chat',
        }],
      })
    })
    vi.stubGlobal('fetch', fetch)
    state.chatSessions = [{
      project_id: 'prj_1', id: 'session-1', name: 'Chat 1',
      messages: [{ role: 'assistant', text: 'Prior project-scoped context', time: 'earlier' }],
    }]
    state.chatActiveId = 'session-1'
    state.chatMessages = state.chatSessions[0]!.messages
    const host = vi.fn().mockResolvedValue({
      assistantText: '我可以先帮你收窄检索问题。',
      suggestedCommand: '/research should-be-rejected',
    })

    const result = await executeChatTurn('调研 temporal localization', 'prj_1', host)

    expect(result.text).toContain('我可以先帮你收窄检索问题。')
    expect(result.text).toContain('survey_run')
    expect(result.suggestedCommand).toBe('/survey temporal localization')
    expect(host).toHaveBeenCalledWith(expect.objectContaining({
      text: '调研 temporal localization',
      project: expect.objectContaining({ project_id: 'prj_1', status: 'SCOPED', brief_status: 'confirmed' }),
      history: [{ role: 'assistant', text: 'Prior project-scoped context' }],
    }))
    expect(fetch).toHaveBeenCalledTimes(3)
  })

  it('turns an explicit ready idea request into generated persisted cards instead of the empty list response', async () => {
    const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const path = String(input)
      if (path.endsWith('/grill')) {
        return json({
          project_revision: 3, intake_revision: 2, question: null,
          brief_preview: { problem: 'CNN robustness', scope: 'low data', primary_metrics: ['macro_f1'], target_outputs: [] },
          ready_to_confirm: false,
        })
      }
      if (path.endsWith('/api/chat/ideas') && init?.method === 'POST') {
        return json({
          ok: true, snapshot_id: 'corpus_1',
          ideas: [1, 2, 3].map(index => ({ idea_id: `idea_${index}`, title: `Candidate ${index}` })),
        })
      }
      if (path.includes('/v2/projects/prj_1/projection')) {
        return json({
          project: { project_id: 'prj_1', name: 'cnn test', status: 'SURVEYING', revision: 3, brief_status: 'confirmed' },
          next_actions_v2: [{
            code: 'idea_generate', label: 'Generate ideas', reason: 'Corpus ready',
            state: 'ready', required: true, required_by: 'agent', route: 'ideas',
          }],
        })
      }
      throw new Error(`unexpected request: ${path}`)
    })
    vi.stubGlobal('fetch', fetch)
    const host = vi.fn()

    const result = await executeChatTurn('生成几个idea，用来进行研究', 'prj_1', host)

    expect(result.text).toMatch(/生成并保存 3 个 IdeaCard|Generated and saved 3 IdeaCards/)
    expect(result.text).not.toContain('No IdeaCards')
    expect(host).not.toHaveBeenCalled()
    const write = fetch.mock.calls.find(([input]) => String(input).endsWith('/api/chat/ideas'))
    expect(JSON.parse(String(write?.[1]?.body))).toMatchObject({
      project_id: 'prj_1', text: '生成几个idea，用来进行研究', count: 3,
    })
  })

  it('routes explicit idea selection through counter-search preparation and then shows the pending Gate', async () => {
    const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const path = String(input)
      if (path.endsWith('/api/chat/ideas/select') && init?.method === 'POST') {
        return json({
          idea: { idea_id: 'idea_1', title: 'Candidate 1', novelty_audit: { result: 'overlap_found' } },
          gate: { gate_id: 'gate_idea_1', type: 'idea', status: 'pending', payload: { idea_id: 'idea_1' } },
          project: { project_id: 'prj_1', status: 'IDEATING', revision: 4 },
        })
      }
      if (path.includes('/v2/projects/prj_1/projection')) {
        return json({
          project: { project_id: 'prj_1', status: 'IDEATING', revision: 4 },
          next_actions_v2: [{
            code: 'idea_gate_approve', label: 'Approve idea', reason: 'Gate pending',
            state: 'ready', required: true, required_by: 'human', route: 'gates',
          }],
        })
      }
      throw new Error(`unexpected request: ${path}`)
    })
    vi.stubGlobal('fetch', fetch)

    const result = await executeChatTurn('/ideas select idea_1', 'prj_1')

    expect(result.text).toMatch(/Candidate 1/)
    expect(result.text).toContain('gate_idea_1')
    expect(result.text).toContain('idea_gate_approve')
    const write = fetch.mock.calls.find(([input]) => String(input).endsWith('/api/chat/ideas/select'))
    expect(JSON.parse(String(write?.[1]?.body))).toEqual({ project_id: 'prj_1', idea_id: 'idea_1' })
  })

  it('turns /reproduce without JSON into a project-aware baseline preparation guide with zero writes', async () => {
    const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const path = String(input)
      if (path.includes('/v1/projects/prj_1/projection')) {
        return json({
          project: { project_id: 'prj_1', status: 'CONTRACT_APPROVED', revision: 7 },
          next_actions_v2: [{
            code: 'baseline_reproduce', label: 'Reproduce baseline', reason: 'prepare inputs',
            state: 'ready', required: ['baseline_command', 'code_snapshot'], required_by: 'agent', route: 'runs',
          }],
        })
      }
      if (path.endsWith('/v1/projects/prj_1/contracts')) {
        return json([{ contract_id: 'expc_1', status: 'approved' }])
      }
      if (path.endsWith('/v1/projects/prj_1/code-snapshots')) return json([])
      if (path.includes('/v2/projects/prj_1/projection')) {
        return json({ project: { project_id: 'prj_1', status: 'CONTRACT_APPROVED' }, next_actions_v2: [] })
      }
      throw new Error(`unexpected request: ${path}`)
    })
    vi.stubGlobal('fetch', fetch)

    const result = await executeChatTurn('/reproduce', 'prj_1')

    expect(result.text).toContain('baseline_command, code_snapshot')
    expect(result.text).toContain('expc_1')
    expect(result.text).toContain('<code-snapshot-id>')
    expect(fetch.mock.calls.some(([, init]) => init?.method === 'POST')).toBe(false)
  })

  it('starts a complete baseline request through the atomic handoff endpoint', async () => {
    const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const path = String(input)
      if (path.includes('/v1/projects/prj_1/projection')) {
        return json({ project: { project_id: 'prj_1', status: 'CONTRACT_APPROVED', revision: 7 }, next_actions_v2: [] })
      }
      if (path.endsWith('/v1/projects/prj_1/contracts')) return json([{ contract_id: 'expc_1', status: 'approved' }])
      if (path.endsWith('/v1/projects/prj_1/code-snapshots')) return json([{ snapshot_id: 'code_snap_1' }])
      if (path.endsWith('/v1/projects/prj_1/baseline-runs') && init?.method === 'POST') {
        return json({ project: { status: 'BASELINE_REPRO' }, job: { job_id: 'job_1', status: 'queued' } })
      }
      if (path.includes('/v2/projects/prj_1/projection')) {
        return json({ project: { project_id: 'prj_1', status: 'BASELINE_REPRO' }, next_actions_v2: [] })
      }
      throw new Error(`unexpected request: ${path}`)
    })
    vi.stubGlobal('fetch', fetch)

    const result = await executeChatTurn(
      '/reproduce {"contract_id":"expc_1","code_snapshot_id":"code_snap_1","command":["node","train.js"]}',
      'prj_1',
    )

    expect(result.text).toContain('job_1')
    const write = fetch.mock.calls.find(([input]) => String(input).endsWith('/baseline-runs'))
    expect(JSON.parse(String(write?.[1]?.body))).toMatchObject({
      expected_revision: 7,
      contract_id: 'expc_1',
      code_snapshot_id: 'code_snap_1',
      command: ['node', 'train.js'],
    })
    expect(JSON.parse(String(write?.[1]?.body))).not.toHaveProperty('kind')
  })

  it('falls back to deterministic phase guidance when the model adapter is unavailable', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => String(input).endsWith('/grill')
      ? json({
        project_revision: 2, intake_revision: 2, question: null,
        brief_preview: { problem: '', scope: '', primary_metrics: [], target_outputs: [] },
        ready_to_confirm: false,
      })
      : json({
        project: { project_id: 'prj_1', status: 'SCOPED', brief_status: 'confirmed' },
        next_actions_v2: [{
          code: 'survey_run', label: 'Run survey', reason: 'Corpus required',
          state: 'blocked', required: ['scope_gate'], required_by: 'agent', route: 'chat',
        }],
      })))
    const host = vi.fn().mockRejectedValue(new Error('provider detail must not leak'))

    const result = await executeChatTurn('我想讨论主指标的选择', 'prj_1', host)

    expect(result.text).toMatch(/自由对话|discuss this freely/i)
    expect(result.text).toContain('survey_run')
    expect(result.text).not.toContain('provider detail')
    expect(result.suggestedCommand).toBeUndefined()
  })

  it('uses the standalone DSH model bridge for ordinary project conversation by default', async () => {
    const controller = new AbortController()
    const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const path = String(input)
      if (path.endsWith('/grill')) {
        return json({
          project_revision: 2, intake_revision: 2, question: null,
          brief_preview: { problem: '', scope: '', primary_metrics: [], target_outputs: [] },
          ready_to_confirm: false,
        })
      }
      if (path.endsWith('/api/chat/turn') && init?.method === 'POST') {
        return json({ operation: 'conversation', assistant_text: '可以从校准误差和长尾鲁棒性两个方向展开。' })
      }
      if (path.includes('/v2/projects/prj_1/projection')) {
        return json({
          project: { project_id: 'prj_1', status: 'SURVEYING', brief_status: 'confirmed' },
          next_actions_v2: [{
            code: 'idea_generate', label: 'Generate ideas', reason: 'Corpus ready',
            state: 'ready', required: true, required_by: 'agent', route: 'ideas',
          }],
        })
      }
      throw new Error(`unexpected request: ${path}`)
    })
    vi.stubGlobal('fetch', fetch)

    const result = await executeChatTurn(
      '我们先讨论一下哪些方向最值得做', 'prj_1', undefined, async () => [], undefined, controller.signal,
    )

    expect(result.text).toContain('校准误差和长尾鲁棒性')
    const modelCall = fetch.mock.calls.find(([input]) => String(input).endsWith('/api/chat/turn'))
    expect(modelCall).toBeDefined()
    expect(modelCall?.[1]?.signal).toBe(controller.signal)
    expect(JSON.parse(String(modelCall?.[1]?.body))).toMatchObject({
      project_id: 'prj_1', text: '我们先讨论一下哪些方向最值得做',
    })
  })

  it('forwards transient visual context only with a free conversation turn', async () => {
    const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const path = String(input)
      if (path.endsWith('/grill')) {
        return json({
          project_revision: 2, intake_revision: 2, question: null,
          brief_preview: { problem: '', scope: '', primary_metrics: [], target_outputs: [] },
          ready_to_confirm: false,
        })
      }
      if (path.endsWith('/api/chat/turn') && init?.method === 'POST') {
        return json({ operation: 'conversation', assistant_text: 'The chart plateaus after epoch 8.' })
      }
      if (path.includes('/v2/projects/prj_1/projection')) {
        return json({
          project: { project_id: 'prj_1', status: 'SURVEYING', brief_status: 'confirmed' },
          next_actions_v2: [],
        })
      }
      throw new Error(`unexpected request: ${path}`)
    })
    vi.stubGlobal('fetch', fetch)
    const images = [{ mediaType: 'image/png' as const, data: 'aW1hZ2U=', name: 'curve.png' }]

    const result = await executeChatTurn('What does this chart show?', 'prj_1', undefined, async () => images)

    expect(result.consumedVisualInputs).toBe(true)
    const modelCall = fetch.mock.calls.find(([input]) => String(input).endsWith('/api/chat/turn'))
    expect(JSON.parse(String(modelCall?.[1]?.body))).toMatchObject({ images })
  })

  it('keeps visual context pending and explains when the selected model is text-only', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
      const path = String(input)
      if (path.endsWith('/grill')) {
        return json({
          project_revision: 2, intake_revision: 2, question: null,
          brief_preview: { problem: '', scope: '', primary_metrics: [], target_outputs: [] },
          ready_to_confirm: false,
        })
      }
      if (path.endsWith('/api/chat/turn')) {
        return new Response(JSON.stringify({ ok: false, error: { code: 'vision_model_required', message: 'safe' } }), {
          status: 422,
          headers: { 'content-type': 'application/json' },
        })
      }
      return json({
        project: { project_id: 'prj_1', status: 'SURVEYING', brief_status: 'confirmed' },
        next_actions_v2: [],
      })
    }))

    const result = await executeChatTurn('分析图片', 'prj_1', undefined, async () => [
      { mediaType: 'image/png', data: 'aW1hZ2U=', name: 'curve.png' },
    ])

    expect(result.text).toMatch(/模型.*图片|model.*image/i)
    expect(result.consumedVisualInputs).toBeUndefined()
  })

  it('never turns a failed visual request into an ordinary deterministic text answer', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
      const path = String(input)
      if (path.endsWith('/grill')) {
        return json({
          project_revision: 2, intake_revision: 2, question: null,
          brief_preview: { problem: '', scope: '', primary_metrics: [], target_outputs: [] },
          ready_to_confirm: false,
        })
      }
      if (path.endsWith('/api/chat/turn')) {
        return new Response(JSON.stringify({ ok: false, error: { code: 'model_unavailable', message: 'safe' } }), {
          status: 503,
          headers: { 'content-type': 'application/json' },
        })
      }
      return json({
        project: { project_id: 'prj_1', status: 'SURVEYING', brief_status: 'confirmed' },
        next_actions_v2: [],
      })
    }))

    const result = await executeChatTurn('分析图片', 'prj_1', undefined, async () => [
      { mediaType: 'image/png', data: 'aW1hZ2U=', name: 'curve.png' },
    ])

    expect(result.text).toMatch(/视觉模型.*不可用|vision model.*unavailable/i)
    expect(result.text).not.toMatch(/自由对话|discuss this freely/i)
    expect(result.consumedVisualInputs).toBeUndefined()
  })

  it('treats a plain browser image-encoding failure as a visual failure', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
      const path = String(input)
      if (path.endsWith('/grill')) {
        return json({
          project_revision: 2, intake_revision: 2, question: null,
          brief_preview: { problem: '', scope: '', primary_metrics: [], target_outputs: [] },
          ready_to_confirm: false,
        })
      }
      return json({
        project: { project_id: 'prj_1', status: 'SURVEYING', brief_status: 'confirmed' },
        next_actions_v2: [],
      })
    }))

    const result = await executeChatTurn('分析图片', 'prj_1', undefined, async () => {
      throw new Error('File.arrayBuffer failed')
    })

    expect(result.text).toMatch(/视觉模型.*不可用|vision model.*unavailable/i)
    expect(result.text).not.toMatch(/自由对话|discuss this freely/i)
    expect(result.consumedVisualInputs).toBeUndefined()
  })

  it('does not let a delayed /new response replace a newer project focus', async () => {
    let releaseCreate!: (response: Response) => void
    const create = new Promise<Response>(resolve => { releaseCreate = resolve })
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
      if (String(input).endsWith('/v2/projects')) return create
      throw new Error(`unexpected request: ${String(input)}`)
    }))
    state.projectId = 'prj_a'

    const pending = executeChatCommand('/new delayed-project', 'prj_a')
    state.projectId = 'prj_b'
    releaseCreate(json({ project: { project_id: 'prj_c', name: 'delayed-project', status: 'DRAFT' } }))
    await pending

    expect(state.projectId).toBe('prj_b')
  })

  it('does not let a delayed /new Grill read rerender over a newer project focus', async () => {
    let signalGrillStarted!: () => void
    const grillStarted = new Promise<void>(resolve => { signalGrillStarted = resolve })
    let releaseGrill!: (response: Response) => void
    const grill = new Promise<Response>(resolve => { releaseGrill = resolve })
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
      const path = String(input)
      if (path.endsWith('/v2/projects')) {
        return json({ project: { project_id: 'prj_c', name: 'delayed-grill', status: 'DRAFT' } })
      }
      if (path.endsWith('/v2/projects/prj_c/grill')) {
        signalGrillStarted()
        return grill
      }
      throw new Error(`unexpected request: ${path}`)
    }))
    const rerender = vi.fn()
    state.rerender = rerender
    state.projectId = 'prj_a'

    const pending = executeChatCommand('/new delayed-grill', 'prj_a')
    await grillStarted
    state.projectId = 'prj_b'
    releaseGrill(json({
      project_revision: 1, intake_revision: 1, question: null,
      brief_preview: { problem: '', scope: '', primary_metrics: [], target_outputs: [] },
      ready_to_confirm: false,
    }))
    await pending

    expect(state.projectId).toBe('prj_b')
    expect(rerender).not.toHaveBeenCalled()
    expect(cachedGrillGuide('prj_c')).toBeNull()
  })

  it('enters the new project Grill normally when focus has not changed', async () => {
    const fetch = vi.fn(async (input: string | URL | Request) => {
      const path = String(input)
      if (path.endsWith('/v2/projects')) {
        return json({ project: { project_id: 'prj_c', name: 'normal-grill', status: 'DRAFT' } })
      }
      if (path.endsWith('/v2/projects/prj_c/grill')) {
        return json({
          project_revision: 1, intake_revision: 1,
          question: { question_code: 'brief.problem', question_revision: 1, prompt_key: 'grill.question.problem', required: true },
          brief_preview: { problem: '', scope: '', primary_metrics: [], target_outputs: [] },
          ready_to_confirm: false,
        })
      }
      throw new Error(`unexpected request: ${path}`)
    })
    vi.stubGlobal('fetch', fetch)
    const rerender = vi.fn()
    state.rerender = rerender
    state.projectId = 'prj_a'

    const result = await executeChatCommand('/new normal-grill', 'prj_a')

    expect(result).toMatch(/normal-grill/)
    expect(state.projectId).toBe('prj_c')
    expect(fetch.mock.calls.some(([input]) => String(input).endsWith('/v2/projects/prj_c/grill'))).toBe(true)
    expect(rerender).toHaveBeenCalledTimes(1)
    expect(cachedGrillGuide('prj_c')?.projection.question).toMatchObject({
      question_code: 'brief.problem', prompt_key: 'grill.question.problem',
    })
  })

  it('freezes the originating session history before asynchronous project reads', async () => {
    let releaseGrill!: (response: Response) => void
    const grill = new Promise<Response>(resolve => { releaseGrill = resolve })
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
      if (String(input).endsWith('/grill')) return grill
      return json({
        project: { project_id: 'prj_a', status: 'SCOPED', brief_status: 'confirmed' },
        next_actions_v2: [],
      })
    }))
    state.chatSessions = [{
      project_id: 'prj_a', id: 'session-a', name: 'Chat A',
      messages: [{ role: 'user', text: 'project A history', time: 'now' }],
    }]
    state.chatMessages = state.chatSessions[0]!.messages
    state.chatActiveId = 'session-a'
    const host = vi.fn().mockResolvedValue({ assistantText: 'answer for A' })

    const pending = executeChatTurn('question for A', 'prj_a', host)
    state.chatMessages = [{ role: 'user', text: 'project B private history', time: 'later' }]
    state.chatActiveId = 'session-b'
    releaseGrill(json({
      project_revision: 2, intake_revision: 2, question: null,
      brief_preview: { problem: '', scope: '', primary_metrics: [], target_outputs: [] },
      ready_to_confirm: false,
    }))
    await pending

    expect(host).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 'session-a',
      project: expect.objectContaining({ project_id: 'prj_a' }),
      history: [{ role: 'user', text: 'project A history' }],
    }))
    expect(JSON.stringify(host.mock.calls)).not.toContain('project B private history')
  })

  it('appends guidance for the explicit command target rather than the active project', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
      const path = String(input)
      if (path.includes('/v1/projects/prj_b/projection')) {
        return json({ project: { project_id: 'prj_b', name: 'B', status: 'SURVEYING', revision: 3 }, next_actions_v2: [] })
      }
      if (path.includes('/v2/projects/prj_b/projection')) {
        return json({
          project: { project_id: 'prj_b', name: 'B', status: 'SURVEYING' },
          next_actions_v2: [{
            code: 'idea_generate', label: 'Generate ideas', reason: 'Corpus ready',
            state: 'ready', required: true, required_by: 'agent', route: 'ideas',
          }],
        })
      }
      throw new Error(`unexpected project request: ${path}`)
    }))

    const result = await executeChatTurn('/status prj_b', 'prj_a')

    expect(result.text).toContain('**B**')
    expect(result.text).toContain('idea_generate')
    expect(result.text).not.toContain('prj_a')
  })
})
