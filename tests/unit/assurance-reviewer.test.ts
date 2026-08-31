import { describe, expect, it, vi } from 'vitest'
import type { StagePanelDependencies, StagePanelResult } from '../../src/plugin/stage-subagents.js'
import { runWritingSemanticReview } from '../../src/plugin/assurance-reviewer.js'

const HASH = 'a'.repeat(64)

function panel(overrides: Partial<StagePanelResult['panel']> = {}): StagePanelResult {
  return {
    ok: true,
    panel: {
      panel_id: 'panel_review_1',
      kind: 'reviewer',
      stage: 'review',
      project_id: 'rsp_review',
      session_id: 'session_exact',
      action_id: 'reviewer_run:4',
      action_code: 'reviewer_run',
      project_revision: 4,
      action_revision: 4,
      policy_hash: HASH,
      config_hash: HASH,
      input_hash: HASH,
      members: [{
        label: 'claim-evidence',
        child_id: 'child_reviewer_1',
        state: 'succeeded',
        stop_reason: 'completed',
        output_kind: 'review_finding',
        structured: {
          summary: 'One claim needs a stronger evidence link.',
          notes: ['The current result is descriptive.'],
          references: ['claim_1'],
        },
        output_hash: HASH,
      }],
      failures: [],
      stale: false,
      ...overrides,
    },
    budget_recorded: { api_requests: 1 },
    note: 'complete',
  }
}

function dependencies() {
  return {
    client: {
      getProjectBySession: vi.fn(async () => ({ project_id: 'rsp_review' })),
      projectProjection: vi.fn(async () => ({
        project: {
          project_id: 'rsp_review',
          name: 'review',
          status: 'REVIEWING',
          revision: 4,
          constraints: { max_model_cost_usd: 100, max_gpu_hours: 10 },
        },
        pending_gates: [],
        budget: {},
        next_actions_v2: [{
          id: 'reviewer_run:4',
          code: 'reviewer_run',
          revision: 4,
          state: 'ready',
          required_by: 'agent',
        }],
      })),
      registerChildLinkFromSession: vi.fn(),
      updateChildStateFromSession: vi.fn(),
      recordUsage: vi.fn(),
    },
    runtime: {} as StagePanelDependencies['runtime'],
    roles: { set: vi.fn(), delete: vi.fn() },
    projectScopes: new Map<string, string>(),
    modelFor: vi.fn(),
  } satisfies StagePanelDependencies
}

describe('read-only semantic assurance reviewer seam', () => {
  it('adapts StageSubagent partial fan-in to a hash-bound same-family receipt', async () => {
    const execute = vi.fn(async () => panel({ failures: ['child_reviewer_2: unavailable'] }))
    const receipt = await runWritingSemanticReview({
      sessionId: 'session_exact',
      parent: { id: 'session_exact' },
      signal: new AbortController().signal,
      hostConfirmation: { callId: 'call-assurance-1', rootCallId: 'root-assurance-1' },
    }, {
      coordinator: { execute },
      panel: dependencies(),
    })

    expect(execute).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 'session_exact',
      parent: { id: 'session_exact' },
      kind: 'reviewer',
    }), expect.any(Object))
    expect(receipt).toMatchObject({
      panel_id: 'panel_review_1',
      project_id: 'rsp_review',
      session_id: 'session_exact',
      project_revision: 4,
      action_id: 'reviewer_run:4',
      action_revision: 4,
      state: 'partial',
      independence: 'same-family',
      reviewers: [{
        reviewer_role: 'claim-evidence',
        child_id: 'child_reviewer_1',
        summary: 'One claim needs a stronger evidence link.',
        output_hash: `sha256:${HASH}`,
      }],
      failures: ['child_reviewer_2: unavailable'],
      input_hash: `sha256:${HASH}`,
    })
    expect(receipt.panel_hash).toMatch(/^sha256:[0-9a-f]{64}$/)
  })

  it('fails closed as missing without leaking provider errors when the panel cannot run', async () => {
    const execute = vi.fn(async () => {
      throw new Error('Bearer secret-provider-token at /home/dev/private')
    })
    const receipt = await runWritingSemanticReview({
      sessionId: 'session_exact',
      parent: { id: 'session_exact' },
      signal: new AbortController().signal,
      hostConfirmation: { callId: 'call-assurance-2', rootCallId: 'root-assurance-2' },
    }, {
      coordinator: { execute },
      panel: dependencies(),
    })

    expect(receipt).toMatchObject({
      project_id: 'rsp_review',
      session_id: 'session_exact',
      project_revision: 4,
      action_id: 'reviewer_run:4',
      action_revision: 4,
      state: 'missing',
      independence: 'same-family',
      reviewers: [],
      failures: ['semantic_reviewer_unavailable'],
    })
    expect(JSON.stringify(receipt)).not.toContain('secret-provider-token')
    expect(JSON.stringify(receipt)).not.toContain('/home/dev/private')
  })

  it('delivers exact-session native reviewer instructions through the bounded panel task', async () => {
    const execute = vi.fn(async () => panel())
    await runWritingSemanticReview({
      sessionId: 'session_exact', parent: { id: 'session_exact' }, signal: new AbortController().signal,
      hostConfirmation: { callId: 'call-assurance-3', rootCallId: 'root-assurance-3' },
    }, {
      coordinator: { execute }, panel: dependencies(),
      delivery: {
        resolve: vi.fn(async () => ({
          context: { project_id: 'rsp_review', session_id: 'session_exact', phase: 'REVIEWING', next_action_revision: 4, surface: 'assurance-reviewer' },
          deliveries: [{
            activation_id: 'activation_1', package_name: 'scholar.assurance.review', package_version: '1.0.0',
            manifest_sha256: `sha256:${HASH}`, payload_sha256: `sha256:${HASH}`,
            trust: 'trusted-native-instruction', effective_capabilities: ['proposal:review-finding'],
            content: { schema_version: 1, purpose: 'review', surfaces: ['assurance-reviewer'], instructions: ['Label missing evidence explicitly.'], prohibitions: ['Do not mutate TeX.'] },
          }], suppressed: [],
        })),
      },
    })
    expect(execute).toHaveBeenCalledWith(expect.objectContaining({
      task: expect.stringContaining('Label missing evidence explicitly.'),
      completion: expect.stringContaining('Do not mutate TeX.'),
    }), expect.any(Object))
  })
})
