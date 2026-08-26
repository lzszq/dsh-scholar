import { describe, expect, it, vi } from 'vitest'
import { createHarnessScholarAgent, scholarChatModelPreference } from '../../src/plugin/chat-agent'
import { ScholarAgentReply, ScholarAgentRequest } from '../../packages/research-schemas/src/chat-agent'

const project = {
  project_id: 'rsp_1', name: 'cnn test', status: 'SURVEYING', brief_status: 'confirmed',
  brief: { problem: 'improve low-data CNN robustness' }, next_actions_v2: [],
}

describe('Harness-backed Scholar agent boundary', () => {
  it('lets an explicit Scholar UI choice override the configured PI default and uses the default only for Auto', () => {
    expect(scholarChatModelPreference('deepseek/configured-pi', 'deepseek/user-selected')).toBe('deepseek/user-selected')
    expect(scholarChatModelPreference('deepseek/configured-pi', '')).toBe('deepseek/configured-pi')
    expect(scholarChatModelPreference(undefined, '')).toBe('')
  })

  it('projects the live DSH model catalog with explicit vision capabilities without invoking a model', async () => {
    const stream = vi.fn()
    const llm = {
      listProviders: () => [
        { id: 'deepseek-official', name: 'DeepSeek' },
        { id: 'lab', name: 'Lab' },
      ],
      listModels: async (provider: string) => provider === 'deepseek-official'
        ? [
            { provider, id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro', inputModalities: ['text'] },
            { provider, id: 'deepseek-vision', name: 'DeepSeek Vision', inputModalities: ['text', 'image'] },
          ]
        : [{ provider, id: 'lab-image', name: 'Lab Image', inputModalities: ['image'] }],
      stream,
    }
    const agent = createHarnessScholarAgent(llm as never, () => '')

    await expect(agent({ operation: 'list_models' })).resolves.toEqual({
      operation: 'list_models',
      models: [
        { id: 'deepseek-official/deepseek-v4-pro', provider: 'deepseek-official', model: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro', input_modalities: ['text'] },
        { id: 'deepseek-official/deepseek-vision', provider: 'deepseek-official', model: 'deepseek-vision', name: 'DeepSeek Vision', input_modalities: ['text', 'image'] },
        { id: 'lab/lab-image', provider: 'lab', model: 'lab-image', name: 'Lab Image', input_modalities: ['image'] },
      ],
    })
    expect(stream).not.toHaveBeenCalled()
  })

  it('preserves absent versus explicit-empty modality declarations without dropping the remaining live catalog', async () => {
    const agent = createHarnessScholarAgent({
      listProviders: () => [{ id: 'deepseek', name: 'DeepSeek' }],
      listModels: async () => [
        { provider: 'deepseek', id: 'unknown', name: 'Unknown' },
        { provider: 'deepseek', id: 'empty', name: 'Empty', inputModalities: [] },
      ],
      stream: vi.fn(),
    } as never, () => '')

    await expect(agent({ operation: 'list_models' })).resolves.toEqual({
      operation: 'list_models',
      models: [
        { id: 'deepseek/unknown', provider: 'deepseek', model: 'unknown', name: 'Unknown' },
        { id: 'deepseek/empty', provider: 'deepseek', model: 'empty', name: 'Empty', input_modalities: [] },
      ],
    })
  })

  it('drops one malformed catalog row without hiding valid models from the same provider', async () => {
    const agent = createHarnessScholarAgent({
      listProviders: () => [{ id: 'deepseek', name: 'DeepSeek' }],
      listModels: async () => [
        { provider: 'deepseek', id: '', name: 'Malformed' },
        { provider: 'deepseek', id: 'valid', name: 'Valid', inputModalities: ['text'] },
      ],
      stream: vi.fn(),
    } as never, () => '')

    await expect(agent({ operation: 'list_models' })).resolves.toEqual({
      operation: 'list_models',
      models: [{ id: 'deepseek/valid', provider: 'deepseek', model: 'valid', name: 'Valid', input_modalities: ['text'] }],
    })
  })

  it('accepts the full qualified id implied by the provider and opaque model limits', () => {
    const provider = 'p'.repeat(256)
    const model = 'm'.repeat(1_024)
    expect(ScholarAgentReply.safeParse({
      operation: 'resolve_model',
      model: { id: `${provider}/${model}`, provider, model, name: 'Boundary model' },
    }).success).toBe(true)
  })

  it('resolves exact opaque model metadata independently of advisory catalog membership', async () => {
    const resolveModelInfo = vi.fn(async (provider: string, model: string) => ({
      provider,
      id: model,
      name: 'Nested Vision',
      inputModalities: ['text', 'image'],
    }))
    const agent = createHarnessScholarAgent({
      listProviders: () => [{ id: 'deepseek', name: 'DeepSeek' }],
      listModels: async () => [],
      resolveModelInfo,
      stream: vi.fn(),
    } as never, () => '')

    await expect(agent({
      operation: 'resolve_model',
      provider: 'deepseek',
      model: 'org/nested-vision-model',
    })).resolves.toEqual({
      operation: 'resolve_model',
      model: {
        id: 'deepseek/org/nested-vision-model',
        provider: 'deepseek',
        model: 'org/nested-vision-model',
        name: 'Nested Vision',
        input_modalities: ['text', 'image'],
      },
    })
    expect(resolveModelInfo).toHaveBeenCalledWith('deepseek', 'org/nested-vision-model', undefined)
  })

  it('uses exact adapter metadata even when the selected route is present in the advisory catalog', async () => {
    const resolveModelInfo = vi.fn(async (provider: string, model: string) => ({
      provider,
      id: model,
      name: 'Exact Vision',
      inputModalities: ['text', 'image'] as const,
    }))
    const saveImages = vi.fn(async () => [{
      attachmentId: 'att_exact', mediaType: 'image/png', bytes: 5, width: 1, height: 1,
    }])
    const stream = vi.fn(async function * () {
      yield { type: 'text-delta', index: 0, text: 'exact metadata used' }
      yield { type: 'finish', reason: { kind: 'stop' } }
    })
    const agent = createHarnessScholarAgent({
      listProviders: () => [{ id: 'deepseek', name: 'DeepSeek' }],
      listModels: async () => [{
        provider: 'deepseek', id: 'vision', name: 'Stale Catalog Entry', inputModalities: ['text'],
      }],
      resolveModelInfo,
      stream,
    } as never, () => 'deepseek/vision', undefined, () => ({ saveImages } as never))

    await expect(agent({
      operation: 'conversation', session_id: 'chat_1', text: 'inspect', locale: 'en', project, history: [],
      images: [{ mediaType: 'image/png', data: Buffer.from('image').toString('base64') }],
    })).resolves.toMatchObject({ assistant_text: 'exact metadata used' })
    expect(resolveModelInfo).toHaveBeenCalledWith('deepseek', 'vision', undefined)
    expect(saveImages).toHaveBeenCalledOnce()
  })

  it('skips unavailable and explicitly image-only advisory entries when Auto selects a Scholar text model', async () => {
    const resolveModelInfo = vi.fn(async (provider: string, model: string) => {
      if (model === 'unavailable') throw new Error('adapter offline')
      if (model === 'image-only') return { provider, id: model, name: 'Image Only', inputModalities: ['image'] as const }
      return { provider, id: model, name: 'Text Model', inputModalities: ['text'] as const }
    })
    const stream = vi.fn(async function * () {
      yield { type: 'text-delta', index: 0, text: 'auto selected usable text model' }
      yield { type: 'finish', reason: { kind: 'stop' } }
    })
    const agent = createHarnessScholarAgent({
      listProviders: () => [{ id: 'deepseek', name: 'DeepSeek' }],
      listModels: async () => [
        { provider: 'deepseek', id: 'unavailable', name: 'Unavailable' },
        { provider: 'deepseek', id: 'image-only', name: 'Image Only', inputModalities: ['image'] },
        { provider: 'deepseek', id: 'text-model', name: 'Text Model', inputModalities: ['text'] },
      ],
      resolveModelInfo,
      stream,
    } as never, () => '')

    await expect(agent({
      operation: 'conversation', session_id: 'chat_1', text: 'continue', locale: 'en', project, history: [],
    })).resolves.toMatchObject({ assistant_text: 'auto selected usable text model' })
    expect(resolveModelInfo.mock.calls.map(call => call[1])).toEqual(['unavailable', 'image-only', 'text-model'])
    expect(stream).toHaveBeenCalledWith(expect.objectContaining({ provider: 'deepseek', model: 'text-model' }))
  })

  it('stops Auto resolution immediately after cancellation instead of probing another model', async () => {
    const controller = new AbortController()
    const resolveModelInfo = vi.fn(async (provider: string, model: string) => {
      if (model === 'first') {
        controller.abort()
        throw new DOMException('aborted', 'AbortError')
      }
      return { provider, id: model, name: 'Must Not Resolve', inputModalities: ['text'] as const }
    })
    const stream = vi.fn(async function * () {
      yield { type: 'text-delta', index: 0, text: 'must not run' }
      yield { type: 'finish', reason: { kind: 'stop' } }
    })
    const agent = createHarnessScholarAgent({
      listProviders: () => [{ id: 'deepseek', name: 'DeepSeek' }],
      listModels: async () => [
        { provider: 'deepseek', id: 'first', name: 'First' },
        { provider: 'deepseek', id: 'second', name: 'Second', inputModalities: ['text'] },
      ],
      resolveModelInfo,
      stream,
    } as never, () => '')

    await expect(agent({
      operation: 'conversation', session_id: 'chat_1', text: 'continue', locale: 'en', project, history: [],
    }, controller.signal)).rejects.toThrow('Harness model is unavailable')
    expect(resolveModelInfo.mock.calls.map(call => call[1])).toEqual(['first'])
    expect(stream).not.toHaveBeenCalled()
  })

  it('stops after an adapter returns metadata if the turn was cancelled during resolution', async () => {
    const controller = new AbortController()
    const resolveModelInfo = vi.fn(async (provider: string, model: string) => {
      controller.abort()
      return { provider, id: model, name: 'Late Model', inputModalities: ['text'] as const }
    })
    const stream = vi.fn(async function * () {
      yield { type: 'text-delta', index: 0, text: 'must not run' }
      yield { type: 'finish', reason: { kind: 'stop' } }
    })
    const agent = createHarnessScholarAgent({
      listProviders: () => [{ id: 'deepseek', name: 'DeepSeek' }],
      listModels: async () => [{ provider: 'deepseek', id: 'late', name: 'Late' }],
      resolveModelInfo,
      stream,
    } as never, () => '')

    await expect(agent({
      operation: 'conversation', session_id: 'chat_1', text: 'continue', locale: 'en', project, history: [],
    }, controller.signal)).rejects.toThrow('Harness model is unavailable')
    expect(resolveModelInfo).toHaveBeenCalledOnce()
    expect(stream).not.toHaveBeenCalled()
  })

  it('keeps visual bytes outside the deterministic IdeaCard generation contract', () => {
    expect(ScholarAgentRequest.safeParse({
      operation: 'generate_ideas', session_id: 'chat_1', text: '生成一个 idea', locale: 'zh', count: 1, project,
      corpus: { snapshot_id: 'corpus_1', papers: [{ paper_id: 'doi:10.1/test', title: 'Prior work', abstract: '' }] },
      history: [], images: [{ mediaType: 'image/png', data: 'aW1hZ2U=' }],
    }).success).toBe(false)
  })

  it('returns a validated free conversation reply without giving the model tools', async () => {
    let captured: Record<string, unknown> | undefined
    const llm = {
      listProviders: () => [{ id: 'deepseek', name: 'DeepSeek' }],
      listModels: async () => [{ provider: 'deepseek', id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro' }],
      resolveModelInfo: async (provider: string, model: string) => ({ provider, id: model, name: 'DeepSeek V4 Pro' }),
      stream: async function * (options: Record<string, unknown>) {
        captured = options
        yield { type: 'text-delta', index: 0, text: '可以先比较两个假设。' }
        yield { type: 'text-delta', index: 0, text: '下一步可输入 `/ideas` 查看已有想法。' }
        yield { type: 'finish', reason: { kind: 'stop' } }
      },
    }
    const agent = createHarnessScholarAgent(llm as never, () => 'deepseek/deepseek-v4-pro')
    await expect(agent({
      operation: 'conversation', session_id: 'chat_1', text: '聊聊研究方向', locale: 'zh', project, history: [],
    })).resolves.toEqual({
      operation: 'conversation', assistant_text: '可以先比较两个假设。下一步可输入 `/ideas` 查看已有想法。',
    })
    expect(captured?.tools).toBeUndefined()
    expect(captured?.provider).toBe('deepseek')
    expect(captured?.model).toBe('deepseek-v4-pro')
  })

  it('admits visual inputs through the DSH attachment store and sends durable image blocks only to an image-capable model', async () => {
    let captured: Record<string, unknown> | undefined
    const saved: Array<{ data: Uint8Array; mediaType: string; name?: string }> = []
    const llm = {
      listProviders: () => [{ id: 'deepseek', name: 'DeepSeek' }],
      listModels: async () => [{
        provider: 'deepseek', id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro',
        inputModalities: ['text', 'image'],
      }],
      resolveModelInfo: async (provider: string, model: string) => ({
        provider, id: model, name: 'DeepSeek V4 Pro', inputModalities: ['text', 'image'] as const,
      }),
      stream: async function * (options: Record<string, unknown>) {
        captured = options
        yield { type: 'text-delta', index: 0, text: '图中展示的是一条先下降后趋稳的训练损失曲线。' }
        yield { type: 'finish', reason: { kind: 'stop' } }
      },
    }
    const attachments = {
      saveImages: async (inputs: Array<{ data: Uint8Array; mediaType: string; name?: string }>) => {
        saved.push(...inputs)
        return inputs.map((input, index) => ({
          attachmentId: `att_${index}`,
          mediaType: input.mediaType,
          bytes: input.data.byteLength,
          width: 1,
          height: 1,
          ...(input.name === undefined ? {} : { name: input.name }),
        }))
      },
    }
    const agent = createHarnessScholarAgent(
      llm as never,
      () => 'deepseek/deepseek-v4-pro',
      undefined,
      () => attachments as never,
    )

    await expect(agent({
      operation: 'conversation', session_id: 'chat_1', text: '分析这张实验曲线', locale: 'zh', project, history: [],
      images: [{ mediaType: 'image/png', data: Buffer.from('image-bytes').toString('base64'), name: 'loss.png' }],
    })).resolves.toEqual({
      operation: 'conversation',
      assistant_text: '图中展示的是一条先下降后趋稳的训练损失曲线。',
    })

    expect(saved).toEqual([{ data: new Uint8Array(Buffer.from('image-bytes')), mediaType: 'image/png', name: 'loss.png' }])
    expect(captured?.messages).toEqual([
      expect.objectContaining({
        role: 'user',
        content: [
          expect.objectContaining({ type: 'text' }),
          {
            type: 'image',
            attachment: {
              attachmentId: 'att_0', mediaType: 'image/png', bytes: 11, width: 1, height: 1, name: 'loss.png',
            },
          },
        ],
      }),
    ])
  })

  it('rejects visual input before attachment persistence when the selected model does not declare image input', async () => {
    const saveImages = vi.fn()
    const llm = {
      listProviders: () => [{ id: 'deepseek', name: 'DeepSeek' }],
      listModels: async () => [{
        provider: 'deepseek', id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro', inputModalities: ['text'],
      }],
      resolveModelInfo: async (provider: string, model: string) => ({
        provider, id: model, name: 'DeepSeek V4 Pro', inputModalities: ['text'] as const,
      }),
      stream: async function * () {
        yield { type: 'text-delta', index: 0, text: 'must not run' }
      },
    }
    const agent = createHarnessScholarAgent(
      llm as never,
      () => 'deepseek/deepseek-v4-pro',
      undefined,
      () => ({ saveImages } as never),
    )

    await expect(agent({
      operation: 'conversation', session_id: 'chat_1', text: '分析图片', locale: 'zh', project, history: [],
      images: [{ mediaType: 'image/png', data: Buffer.from('image-bytes').toString('base64') }],
    })).rejects.toThrow('Selected Harness model does not accept image input')
    expect(saveImages).not.toHaveBeenCalled()
  })

  it('rejects an image-only model before attachment persistence because Scholar always sends a text prompt', async () => {
    const saveImages = vi.fn()
    const stream = vi.fn()
    const agent = createHarnessScholarAgent({
      listProviders: () => [{ id: 'lab', name: 'Lab' }],
      listModels: async () => [{ provider: 'lab', id: 'image-only', name: 'Image Only', inputModalities: ['image'] }],
      resolveModelInfo: async (provider: string, model: string) => ({
        provider, id: model, name: 'Image Only', inputModalities: ['image'] as const,
      }),
      stream,
    } as never, () => 'lab/image-only', undefined, () => ({ saveImages } as never))

    await expect(agent({
      operation: 'conversation', session_id: 'chat_1', text: 'inspect', locale: 'en', project, history: [],
      images: [{ mediaType: 'image/png', data: Buffer.from('image-bytes').toString('base64') }],
    })).rejects.toThrow('Selected Harness model does not accept text input')
    expect(saveImages).not.toHaveBeenCalled()
    expect(stream).not.toHaveBeenCalled()
  })

  it('accepts multiline Markdown as free conversation instead of requiring model JSON', async () => {
    const llm = {
      listProviders: () => [{ id: 'deepseek', name: 'DeepSeek' }],
      listModels: async () => [{ provider: 'deepseek', id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro' }],
      resolveModelInfo: async (provider: string, model: string) => ({ provider, id: model, name: 'DeepSeek V4 Pro' }),
      stream: async function * () {
        yield { type: 'text-delta', index: 0, text: '**取舍**\n\n1. 先检查可证伪性\n2. 再比较实验成本' }
        yield { type: 'finish', reason: { kind: 'stop' } }
      },
    }
    const agent = createHarnessScholarAgent(llm as never, () => 'deepseek/deepseek-v4-pro')
    await expect(agent({
      operation: 'conversation', session_id: 'chat_1', text: '聊聊研究方向', locale: 'zh', project, history: [],
    })).resolves.toEqual({
      operation: 'conversation',
      assistant_text: '**取舍**\n\n1. 先检查可证伪性\n2. 再比较实验成本',
    })
  })

  it('accepts exactly the requested number of structured IdeaDrafts', async () => {
    const draft = {
      title: 'Calibration-aware augmentation',
      hypothesis: 'Calibration-driven augmentation improves low-data robustness.',
      scientific_gap: { claims: ['Prior work does not optimize calibration.'], statement: 'Calibration is missing from augmentation selection.' },
      nearest_prior_works: [{ paper_id: 'doi:10.1/test', same: ['CNN'], different: ['No calibration objective'] }],
      exact_delta: 'Use calibration error to adapt augmentation strength.',
      falsification: { observation: 'No macro-F1 gain across three seeds.' },
      minimum_viable_experiment: { dataset: 'fixture', baseline: 'fixed augmentation', primary_metric: 'macro_f1', estimated_gpu_hours: 1, expected_runtime: '1 hour' },
      scores: { feasibility: 4, information_gain: 4, reproducibility: 5, cost: 2 },
      risk_notes: 'Calibration may overfit the validation split.',
    }
    const llm = {
      listProviders: () => [{ id: 'deepseek', name: 'DeepSeek' }],
      listModels: async () => [{ provider: 'deepseek', id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro' }],
      resolveModelInfo: async (provider: string, model: string) => ({ provider, id: model, name: 'DeepSeek V4 Pro' }),
      stream: async function * () {
        yield { type: 'text-delta', index: 0, text: JSON.stringify({ operation: 'generate_ideas', ideas: [draft, { ...draft, title: 'Second' }] }) }
        yield { type: 'finish', reason: { kind: 'stop' } }
      },
    }
    const agent = createHarnessScholarAgent(llm as never, () => 'deepseek/deepseek-v4-pro')
    await expect(agent({
      operation: 'generate_ideas', session_id: 'chat_1', text: '生成两个 idea', locale: 'zh', count: 2, project,
      corpus: { snapshot_id: 'corpus_1', papers: [{ paper_id: 'doi:10.1/test', title: 'Prior work', abstract: '' }] },
      history: [],
    })).resolves.toMatchObject({ operation: 'generate_ideas', ideas: [{ title: draft.title }, { title: 'Second' }] })
  })

  it('fails closed when the model returns the wrong count or an invalid draft', async () => {
    const llm = {
      listProviders: () => [{ id: 'deepseek', name: 'DeepSeek' }],
      listModels: async () => [{ provider: 'deepseek', id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro' }],
      resolveModelInfo: async (provider: string, model: string) => ({ provider, id: model, name: 'DeepSeek V4 Pro' }),
      stream: async function * () {
        yield { type: 'text-delta', index: 0, text: '{"operation":"generate_ideas","ideas":[]}' }
        yield { type: 'finish', reason: { kind: 'stop' } }
      },
    }
    const agent = createHarnessScholarAgent(llm as never, () => 'deepseek/deepseek-v4-pro')
    await expect(agent({
      operation: 'generate_ideas', session_id: 'chat_1', text: '生成三个 idea', locale: 'zh', count: 3, project,
      corpus: { snapshot_id: 'corpus_1', papers: [{ paper_id: 'doi:10.1/test', title: 'Prior work', abstract: '' }] },
      history: [],
    })).rejects.toThrow()
  })

  it('injects only resolver-issued trusted native instructions and labels external references untrusted', async () => {
    let captured: Record<string, unknown> | undefined
    const llm = {
      listProviders: () => [{ id: 'deepseek', name: 'DeepSeek' }],
      listModels: async () => [{ provider: 'deepseek', id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro' }],
      resolveModelInfo: async (provider: string, model: string) => ({ provider, id: model, name: 'DeepSeek V4 Pro' }),
      stream: async function * (options: Record<string, unknown>) {
        captured = options
        yield { type: 'text-delta', index: 0, text: 'reviewed' }
        yield { type: 'finish', reason: { kind: 'stop' } }
      },
    }
    const agent = createHarnessScholarAgent(llm as never, () => 'deepseek/deepseek-v4-pro', async request => ({
      context: {
        project_id: request.project.project_id, session_id: request.session_id,
        phase: 'WRITING', next_action_revision: 9, surface: 'scholar-chat',
      },
      deliveries: [{
        activation_id: 'activation_native', package_name: 'scholar.writing.reverse-outline', package_version: '1.0.0',
        manifest_sha256: `sha256:${'a'.repeat(64)}`, payload_sha256: `sha256:${'b'.repeat(64)}`,
        trust: 'trusted-native-instruction', effective_capabilities: ['project:read-manuscript-snapshot'],
        content: {
          schema_version: 1, purpose: 'diagnose structure', surfaces: ['scholar-chat'],
          instructions: ['Bind findings to the pinned manuscript.'],
          prohibitions: ['Do not mutate TeX.'],
        },
      }, {
        activation_id: 'activation_external', package_name: 'external.reference', package_version: '1.0.0',
        manifest_sha256: `sha256:${'c'.repeat(64)}`, payload_sha256: `sha256:${'d'.repeat(64)}`,
        trust: 'untrusted-external-reference', effective_capabilities: ['knowledge:retrieve'], content: null,
      }],
      suppressed: [],
    }))
    await agent({
      operation: 'conversation', session_id: 'chat_1', text: 'review', locale: 'en', project, history: [],
    })
    expect(captured?.system).toContain('Bind findings to the pinned manuscript.')
    expect(captured?.system).toContain('Do not mutate TeX.')
    expect(captured?.system).toContain('external.reference')
    expect(captured?.system).toContain('UNTRUSTED REFERENCE')
  })

  it('rejects an obsolete unqualified model preference instead of guessing a provider', async () => {
    const stream = vi.fn()
    const llm = {
      listProviders: () => [{ id: 'deepseek', name: 'DeepSeek' }],
      listModels: async () => [{ provider: 'deepseek', id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro', inputModalities: ['text'] }],
      stream,
    }
    const agent = createHarnessScholarAgent(llm as never, () => 'deepseek-v4-pro')

    await expect(agent({
      operation: 'conversation', session_id: 'chat_1', text: 'continue', locale: 'en', project, history: [],
    })).rejects.toThrow('Harness model is unavailable')
    expect(stream).not.toHaveBeenCalled()
  })

  it('fails closed rather than silently replacing an unavailable exact model with the catalog default', async () => {
    const stream = vi.fn(async function * () {
      yield { type: 'text-delta', index: 0, text: 'continued with current default' }
      yield { type: 'finish', reason: { kind: 'stop' } }
    })
    const agent = createHarnessScholarAgent({
      listProviders: () => [{ id: 'deepseek', name: 'DeepSeek' }],
      listModels: async () => [{ provider: 'deepseek', id: 'current', name: 'Current', inputModalities: ['text'] }],
      resolveModelInfo: vi.fn(async () => { throw new Error('model unavailable') }),
      stream,
    } as never, () => 'deepseek/removed')

    await expect(agent({
      operation: 'conversation', session_id: 'chat_1', text: 'continue', locale: 'en', project, history: [],
    })).rejects.toThrow('Harness model is unavailable')
    expect(stream).not.toHaveBeenCalled()
  })

  it('preserves an opaque nested model id and resolves the exact configured route even when it is absent from the advisory catalog', async () => {
    const resolveModelInfo = vi.fn(async (provider: string, model: string) => ({
      provider,
      id: model,
      name: 'Nested Vision Model',
      inputModalities: ['text', 'image'] as const,
    }))
    const stream = vi.fn(async function * () {
      yield { type: 'text-delta', index: 0, text: 'nested route reply' }
      yield { type: 'finish', reason: { kind: 'stop' } }
    })
    const agent = createHarnessScholarAgent({
      listProviders: () => [{ id: 'deepseek', name: 'DeepSeek' }],
      listModels: async () => [],
      resolveModelInfo,
      stream,
    } as never, () => 'deepseek/org/nested-vision-model')

    await expect(agent({
      operation: 'conversation', session_id: 'chat_1', text: 'inspect', locale: 'en', project, history: [],
    })).resolves.toMatchObject({ operation: 'conversation', assistant_text: 'nested route reply' })
    expect(resolveModelInfo).toHaveBeenCalledWith('deepseek', 'org/nested-vision-model', undefined)
    expect(stream).toHaveBeenCalledWith(expect.objectContaining({ provider: 'deepseek', model: 'org/nested-vision-model' }))
  })

  it('rejects an adapter resolution that changes the requested exact model identity', async () => {
    const stream = vi.fn()
    const agent = createHarnessScholarAgent({
      listProviders: () => [{ id: 'deepseek', name: 'DeepSeek' }],
      listModels: async () => [],
      resolveModelInfo: vi.fn(async () => ({ provider: 'deepseek', id: 'different', name: 'Different', inputModalities: ['text'] })),
      stream,
    } as never, () => 'deepseek/org/requested')

    await expect(agent({
      operation: 'conversation', session_id: 'chat_1', text: 'inspect', locale: 'en', project, history: [],
    })).rejects.toThrow('Harness model identity changed during resolution')
    expect(stream).not.toHaveBeenCalled()
  })
})
