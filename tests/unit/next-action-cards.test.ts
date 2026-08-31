/**
 * next-action-cards (gui-plugin-plan §5.1, api-contracts.md §21, audit #11):
 * the PURE Overview NextAction v2 card model —
 *
 *   nextActionCardModel(action, locale):  three-state tone (ready/blocked/
 *     done), blocked-with-gaps disablement, missing-precondition list
 *     (known codes translated, unknown codes verbatim), route mapping
 *     (kernel route → panel tab, ideas/contracts/release/overview converge
 *     on the Overview tab), unknown-code safe degradation (read-only, no
 *     CTA, kernel label fallback), blocking note, locale-driven title map;
 *   resolveNextActionInput(p):           structured projection only; empty,
 *     missing, or malformed v2 → safe none state without label fallback;
 *   static tables:                        every NEXT_ACTION_LABEL_KEYS /
 *     NEXT_ACTION_GAP_KEYS value exists in BOTH zh and en dictionaries and
 *     zero missing-key reports when every model is evaluated per locale.
 *
 * Pure logic-layer suite (no DOM), mirroring ui-simple/i18n-runtime.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { zh as overviewZh, en as overviewEn } from '../../packages/dsh-research-ui/src/client/i18n/locales/overview'
import {
  getLocale, localeParityReport, resetMissingKeyWarnings, setLocale, setMissingKeyReporter,
} from '../../packages/dsh-research-ui/src/client/i18n/index'
import {
  NEXT_ACTION_GAP_KEYS, NEXT_ACTION_LABEL_KEYS, NEXT_ACTION_UNKNOWN_CODE,
  nextActionCardModel, resolveNextActionInput,
} from '../../packages/dsh-research-ui/src/client/next-action-cards'
import type { NextActionV2 } from '../../packages/dsh-research-ui/src/client/types'

interface Missing { namespace: string; key: string; locale: string }

let missing: Missing[] = []

beforeEach(() => {
  missing = []
  setMissingKeyReporter(r => { missing.push(r) })
})

afterEach(() => {
  setMissingKeyReporter(null)
  resetMissingKeyWarnings()
})

/** Minimal valid action; per-test overrides win. */
function action(overrides: Partial<NextActionV2> & { code?: string }): NextActionV2 {
  return { code: 'survey_run', label: 'Run literature survey → corpus snapshot', reason: 'a corpus snapshot is required', state: 'ready', route: 'runs', required: true, blocking: true, ...overrides }
}

describe('nextActionCardModel: three-state tone + disablement', () => {
  it('ready → tone ready, enabled (highlighted CTA)', () => {
    setLocale('en')
    const m = nextActionCardModel(action({ state: 'ready' }))
    expect(m.tone).toBe('ready')
    expect(m.disabled).toBe(false)
    expect(m.stateLabel).toBe('Ready')
  })

  it('blocked with missing preconditions → tone blocked, disabled', () => {
    const m = nextActionCardModel(action({ state: 'blocked', required: ['approved_contract'] }))
    expect(m.tone).toBe('blocked')
    expect(m.disabled).toBe(true)
  })

  it('blocked without a gap list (preconditions met) → tone blocked but enabled', () => {
    const m = nextActionCardModel(action({ state: 'blocked', required: true }))
    expect(m.tone).toBe('blocked')
    expect(m.disabled).toBe(false)
  })

  it('done → tone done, disabled (grayed out), empty missing list', () => {
    const m = nextActionCardModel(action({ state: 'done' }))
    expect(m.tone).toBe('done')
    expect(m.disabled).toBe(true)
    expect(m.missingList).toEqual([])
  })

  it('missing state field degrades to ready', () => {
    const m = nextActionCardModel(action({ state: undefined }))
    expect(m.tone).toBe('ready')
    expect(m.disabled).toBe(false)
  })
})

describe('nextActionCardModel: missing-list mapping', () => {
  it('known gap codes are translated, unknown gap codes stay verbatim', () => {
    setLocale('zh')
    const m = nextActionCardModel(action({ state: 'blocked', required: ['approved_contract', 'some_future_gap'] }))
    expect(m.missingList).toEqual(['缺少已批准的实验合同', 'some_future_gap'])
    setLocale('en')
    const en = nextActionCardModel(action({ state: 'blocked', required: ['approved_contract', 'succeeded_runs'] }))
    expect(en.missingList).toEqual(['No approved experiment contract', 'No succeeded runs'])
  })

  it('required=true yields no missing list', () => {
    const m = nextActionCardModel(action({ required: true }))
    expect(m.missingList).toEqual([])
  })
})

describe('nextActionCardModel: route mapping (kernel route → panel tab)', () => {
  it('survey_run opens project Chat with a prefilled slash command, even for an older kernel that says runs', () => {
    const m = nextActionCardModel(action({ code: 'survey_run', route: 'runs', required_by: 'agent' }), 'zh', {
      briefProblem: '  object   recognition under domain shift  ',
    })
    expect(m.route).toBe('chat')
    expect(m.requiredBy).toBe('agent')
    expect(m.commandDraft).toBe('/survey object recognition under domain shift')
  })

  it('survey_run without a Brief problem still opens Chat with an editable command prefix', () => {
    const m = nextActionCardModel(action({ code: 'survey_run', route: 'runs' }), 'en', {})
    expect(m.route).toBe('chat')
    expect(m.commandDraft).toBe('/survey ')
  })

  it('baseline handoff opens the guided Chat preparation command instead of an empty Runs page', () => {
    setLocale('zh')
    const m = nextActionCardModel(action({
      code: 'baseline_reproduce',
      route: 'runs',
      required: ['baseline_command', 'code_snapshot'],
      required_by: 'agent',
    }), 'zh')
    expect(m.route).toBe('runs')
    expect(m.commandDraft).toBe('/reproduce')
    expect(m.missingList).toEqual(['缺少可执行的基线命令（argv）', '缺少不可变代码快照'])
  })

  it('panel routes map to the same tab', () => {
    for (const route of ['gates', 'runs', 'evidence', 'manuscript', 'budget']) {
      const m = nextActionCardModel(action({ code: 'scope_gate_submit', route }))
      expect(m.route).toBe(route)
      expect(m.hasRoute).toBe(true)
    }
  })

  it('non-panel kernel routes converge on the Overview tab (phase)', () => {
    for (const route of ['ideas', 'contracts', 'release', 'overview']) {
      const m = nextActionCardModel(action({ code: 'idea_generate', route }))
      expect(m.route).toBe('phase')
      expect(m.hasRoute).toBe(true)
    }
  })

  it('unknown/future kernel routes fall back to the Overview tab', () => {
    const m = nextActionCardModel(action({ code: 'idea_generate', route: 'workspace' }))
    expect(m.route).toBe('phase')
  })

  it('missing route degrades to the Overview tab', () => {
    const m = nextActionCardModel(action({ code: 'idea_generate', route: undefined }))
    expect(m.route).toBe('phase')
  })

  it('done actions keep their route but stay disabled', () => {
    const m = nextActionCardModel(action({ code: 'scope_gate_submit', state: 'done', route: 'gates' }))
    expect(m.route).toBe('gates')
    expect(m.hasRoute).toBe(true)
    expect(m.disabled).toBe(true)
  })
})

describe('nextActionCardModel: unknown-code safe degradation (api-contracts §21)', () => {
  it('code unknown → read-only: no route CTA, disabled, isUnknown', () => {
    setLocale('zh')
    const m = nextActionCardModel(action({ code: NEXT_ACTION_UNKNOWN_CODE, label: 'Unknown project state — inspect project', state: 'blocked', required: ['state_mapping'], route: 'overview' }))
    expect(m.isUnknown).toBe(true)
    expect(m.hasRoute).toBe(false)
    expect(m.route).toBe('')
    expect(m.disabled).toBe(true)
    expect(m.missingList).toEqual(['未知状态 — 只读'])
  })

  it('missing code degrades to the unknown read-only card (mapped title)', () => {
    setLocale('en')
    const m = nextActionCardModel(action({ code: undefined, label: undefined }))
    expect(m.isUnknown).toBe(true)
    expect(m.disabled).toBe(true)
    expect(m.hasRoute).toBe(false)
    expect(m.title).toBe('Unknown project state — inspect project')
  })

  it('codes absent from the label table render the kernel label verbatim (wire data)', () => {
    setLocale('zh')
    const zh = nextActionCardModel(action({ code: 'gate_decide', label: 'Decide pending scope gate' }))
    expect(zh.title).toBe('Decide pending scope gate')
    setLocale('en')
    const en = nextActionCardModel(action({ code: 'job_retry', label: 'Retry failed job' }))
    expect(en.title).toBe('Retry failed job')
  })
})

describe('nextActionCardModel: i18n label mapping + blocking note', () => {
  it('known codes map through t() per locale; zh ≠ en titles', () => {
    setLocale('zh')
    const zh = nextActionCardModel(action({ code: 'scope_gate_submit' }))
    setLocale('en')
    const en = nextActionCardModel(action({ code: 'scope_gate_submit' }))
    expect(zh.title).toBe('完成范围 Gate')
    expect(en.title).toBe('Complete Scope Gate')
    expect(zh.title).not.toBe(en.title)
  })

  it('blocking=true carries the chrome note; blocking=false carries none', () => {
    setLocale('zh')
    const blocked = nextActionCardModel(action({ blocking: true }))
    expect(blocked.blockingNote).toContain('阻断')
    const free = nextActionCardModel(action({ blocking: false }))
    expect(free.blockingNote).toBe('')
  })

  it('reason text is the kernel wire text, verbatim', () => {
    const m = nextActionCardModel(action({ reason: 'gate g1 is pending' }))
    expect(m.reasonText).toBe('gate g1 is pending')
  })

  it('every NEXT_ACTION_LABEL_KEYS / NEXT_ACTION_GAP_KEYS value exists in BOTH dictionaries', () => {
    const miss: string[] = []
    for (const key of Object.values(NEXT_ACTION_LABEL_KEYS)) {
      if (!(key in overviewZh)) miss.push(`zh missing ${key}`)
      if (!(key in overviewEn)) miss.push(`en missing ${key}`)
    }
    for (const key of Object.values(NEXT_ACTION_GAP_KEYS)) {
      if (!(key in overviewZh)) miss.push(`zh missing ${key}`)
      if (!(key in overviewEn)) miss.push(`en missing ${key}`)
    }
    expect(miss).toEqual([])
    // static zh/en parity still holds (localeParityReport gate kept)
    expect(localeParityReport()).toEqual([])
  })

  it('evaluating every known code in BOTH locales reports zero missing keys', () => {
    const sample: NextActionV2[] = Object.keys(NEXT_ACTION_LABEL_KEYS).map(code => action({ code }))
    for (const locale of ['zh', 'en'] as const) {
      setLocale(locale)
      for (const a of sample) nextActionCardModel(a)
    }
    expect(missing).toEqual([])
    expect(getLocale()).toBe('en')
  })
})

describe('intake_* overlay actions (ONBOARD-01 landing — wizard CTA)', () => {
  it('intake codes map to route "intake" with intake/project refs extracted', () => {
    setLocale('zh')
    const m = nextActionCardModel(action({
      code: 'intake_adopt', label: 'Adopt intake proposal (PI)', state: 'ready', route: 'overview',
      refs: [{ kind: 'intake', id: 'intk_1' }, { kind: 'project', id: 'rsp_9' }],
    }))
    expect(m.route).toBe('intake')
    expect(m.hasRoute).toBe(true)
    expect(m.intakeId).toBe('intk_1')
    expect(m.intakeProjectId).toBe('rsp_9')
    expect(m.disabled).toBe(false)
    // 标题经字典翻译(zh),不是内核 label 原样
    expect(m.title).toBe(overviewZh['overview.nextaction.code.intake_adopt'])
    setLocale('en')
    expect(nextActionCardModel(action({ code: 'intake_scan', refs: [{ kind: 'intake', id: 'i' }] })).title)
      .toBe(overviewEn['overview.nextaction.code.intake_scan'])
  })

  it('intake codes without refs degrade safely (no ids, route still intake)', () => {
    const m = nextActionCardModel(action({ code: 'intake_resume' }))
    expect(m.route).toBe('intake')
    expect(m.hasRoute).toBe(true)
    expect(m.intakeId).toBeNull()
    expect(m.intakeProjectId).toBeNull()
  })

  it('non-intake codes never get intake ids', () => {
    const m = nextActionCardModel(action({ code: 'survey_run', refs: [{ kind: 'intake', id: 'intk_1' }] }))
    expect(m.intakeId).toBeNull()
    expect(m.route).toBe('chat')
  })
})

describe('resolveNextActionInput: structured projection only', () => {
  it('returns valid structured actions', () => {
    const input = resolveNextActionInput({ next_actions_v2: [{ code: 'survey_run' }] })
    expect(input).toEqual({ actions: [{ code: 'survey_run' }] })
  })

  it('empty v2 array produces the safe none state', () => {
    const input = resolveNextActionInput({ next_actions_v2: [] })
    expect(input).toEqual({ actions: [] })
  })

  it('missing v2 produces a safe empty state', () => {
    expect(resolveNextActionInput({})).toEqual({ actions: [] })
  })

  it('malformed v2 never recovers an executable action from labels', () => {
    const input = resolveNextActionInput({ next_actions_v2: ['bad', 42] as unknown as NextActionV2[] })
    expect(input).toEqual({ actions: [] })
  })
})

describe('nextActionCardModel: required_by chip (USAGE_GUIDE §11)', () => {
  it('human/agent/runner required_by resolve to the wire value', () => {
    expect(nextActionCardModel(action({ required_by: 'human' })).requiredBy).toBe('human')
    expect(nextActionCardModel(action({ required_by: 'agent' })).requiredBy).toBe('agent')
    expect(nextActionCardModel(action({ required_by: 'runner' })).requiredBy).toBe('runner')
  })

  it('missing or unknown required_by degrades to null (no chip)', () => {
    expect(nextActionCardModel(action({ required_by: undefined })).requiredBy).toBeNull()
    expect(nextActionCardModel(action({ required_by: 'gpt' as never })).requiredBy).toBeNull()
  })

  it('required_by labels exist in both zh and en dictionaries', () => {
    for (const who of ['human', 'agent', 'runner'] as const) {
      const key = `overview.nextaction.requiredBy.${who}`
      expect(overviewZh[key]).toBeTruthy()
      expect(overviewEn[key]).toBeTruthy()
    }
    setLocale('zh')
    expect(nextActionCardModel(action({ required_by: 'human' })).requiredBy).toBe('human')
    setLocale('en')
    expect(nextActionCardModel(action({ required_by: 'runner' })).requiredBy).toBe('runner')
  })

  it('rendering key resolves without missing-key warnings', () => {
    setLocale('zh')
    const zh = nextActionCardModel(action({ required_by: 'human' }))
    expect(zh.requiredBy).toBe('human')
    setLocale('en')
    nextActionCardModel(action({ required_by: 'agent' }))
    expect(missing.filter(r => r.key.startsWith('overview.nextaction.requiredBy'))).toEqual([])
  })
})
