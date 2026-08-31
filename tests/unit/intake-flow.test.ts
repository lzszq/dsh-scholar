/**
 * intake-flow (acceptance-tests.md §8.1 / §21 init-resume-intake-grill,
 * hardening-v0.2-status.md §5 P1 ONBOARD-01/UPLOAD-01/GUIDE-01): the PURE
 * client logic layer of the intake wizard and the Start 三入口 selection —
 *
 *   nav.ts startScreenVisible/filterProjects/pickProject:  no projects[0]
 *     auto-selection — the Start screen stays until an EXPLICIT pick;
 *   intakeStepModel(projection):                          durable-projection →
 *     step state machine (every step recoverable/resumable);
 *   intakeErrorText(code, message):                       stable error-code
 *     copy — known codes map to zh/en i18n keys, unknown codes verbatim;
 *   intakeBeginPayload / intakeAnswersPayload / intakeAdoptPayload:
 *     principal-carrying bodies (BFF substitutes the session principal);
 *   intakeUploadIssue:                                    32 MiB + filename
 *     client-side pre-check (server re-enforces);
 *   intakeGuidance(projection, next_actions_v2):          per-step NextAction
 *     guidance — kernel intake_* overlay actions merged + deduped;
 *   i18n:                                                 intake namespace
 *     zh/en parity + zero missing-key reports.
 *
 * Pure logic-layer suite (no DOM), mirroring ui-simple/next-action-cards.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  getLocale, localeParityReport, resetMissingKeyWarnings, setLocale, setMissingKeyReporter,
} from '../../packages/dsh-research-ui/src/client/i18n/index'
import { zh as intakeZh, en as intakeEn } from '../../packages/dsh-research-ui/src/client/i18n/locales/intake'
import {
  startScreenVisible, filterProjects, pickProject,
} from '../../packages/dsh-research-ui/src/client/nav'
import {
  INTAKE_ACTIVE_STATUSES, INTAKE_ERROR_KEYS, INTAKE_MAX_FILE_BYTES,
  INTAKE_PHASE_OPTIONS, INTAKE_TERMINAL_STATUSES, activeIntakeId, intakeAdoptPayload,
  intakeAnsweredCount, intakeAnswersPayload, intakeBeginPayload,
  intakeErrorText, intakeGuidance, intakeIdempotencyKey, intakePhaseText,
  intakeProjectRefId, intakeRefId, intakeScanSummary, intakeStatusText,
  intakeStepModel, intakeUploadIssue, intakeVerdictText, intakeVerdictTone,
} from '../../packages/dsh-research-ui/src/client/intake-flow'
import type { GrillAnswerViewLite, IntakeProjectionLite, NextActionV2, ProjectRow } from '../../packages/dsh-research-ui/src/client/types'

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

const NOW = '2026-08-11T12:00:00.000Z'

describe('activeIntakeId', () => {
  it('selects only a resumable non-empty Intake', () => {
    expect(activeIntakeId([
      { intake_id: 'done', status: 'accepted' },
      { intake_id: '', status: 'draft' },
      { intake_id: 'live', status: 'uploading' },
    ])).toBe('live')
    expect(activeIntakeId([{ intake_id: 'done', status: 'accepted' }])).toBeNull()
    expect(activeIntakeId(null)).toBeNull()
  })
})

/** Minimal projection; per-test overrides win. */
function projection(status: string, overrides?: Partial<IntakeProjectionLite>): IntakeProjectionLite {
  return {
    session: {
      intake_id: 'intk_test123', project_id: 'rsp_1', status,
      target_phase: 'experiment', source_label: 'uploaded-paper',
      revision: 1, expires_at: '2099-01-01T00:00:00.000Z',
      created_at: NOW, updated_at: NOW, audit: [], scan_summary: {},
    },
    artifacts: [],
    observations: [],
    questions: [],
    proposal: null,
    receipt: null,
    ...overrides,
  }
}

function question(code: string, required: boolean, answer?: string | null): GrillAnswerViewLite {
  return {
    question_code: code, label_key: `grill.${code}`, prompt: `Prompt ${code}`,
    reason: '', required, depends_on: [], question_revision: 1,
    question_type: 'text', answer: answer ?? null, answered_at: null,
    answered_by: null, provenance: answer === undefined || answer === null ? 'unanswered' : 'human_assertion',
  }
}

describe('Start 三入口选择逻辑 (nav.ts — no projects[0] auto-select)', () => {
  const projects: ProjectRow[] = [
    { project_id: 'rsp_1', name: 'shift-localization', status: 'DRAFT', updated_at: NOW },
    { project_id: 'rsp_2', name: 'baseline-repro', status: 'SCOPED', updated_at: NOW },
    { project_id: 'rsp_3', name: 'shift-localization', status: 'DRAFT', updated_at: NOW },
  ]

  it('startScreenVisible: Start 屏显示当且仅当未选中项目(绝不自动跳 projects[0])', () => {
    expect(startScreenVisible(undefined)).toBe(true)
    expect(startScreenVisible('')).toBe(true)
    expect(startScreenVisible('rsp_1')).toBe(false)
  })

  it('filterProjects: name/id 子串过滤;空 query 返回全量副本', () => {
    expect(filterProjects(projects, '')).toHaveLength(3)
    expect(filterProjects(projects, 'shift')).toHaveLength(2)
    expect(filterProjects(projects, 'RSP_2')).toHaveLength(1)
    expect(filterProjects(projects, 'zzz')).toHaveLength(0)
    // query 空白处理:trim 后为空 = 全量
    expect(filterProjects(projects, '   ')).toHaveLength(3)
  })

  it('pickProject: 精确 id 优先,唯一 name 次之,歧义/无匹配返回 null(不回退)', () => {
    expect(pickProject(projects, 'rsp_1')).toBe('rsp_1')
    expect(pickProject(projects, 'baseline-repro')).toBe('rsp_2')
    // 重名 → 歧义 → null(用户必须显式选择)
    expect(pickProject(projects, 'shift-localization')).toBeNull()
    expect(pickProject(projects, 'rsp_9')).toBeNull()
    expect(pickProject(projects, '')).toBeNull()
    expect(pickProject(projects, '   ')).toBeNull()
  })
})

describe('intake 流程状态机 (intakeStepModel — 每步可恢复)', () => {
  it('会话状态 → 向导步骤的完整映射', () => {
    const cases: Array<[string, string]> = [
      ['draft', 'stage'],
      ['uploading', 'stage'],
      ['scanning', 'scan'],
      ['needs_input', 'grill'],
      ['grilling', 'grill'],
      ['proposal_ready', 'propose'],
      ['awaiting_human', 'adopt'],
      ['accepting', 'adopt'],
      ['accepted', 'done'],
    ]
    for (const [status, step] of cases) {
      const model = intakeStepModel(projection(status))
      expect(model.step, status).toBe(step)
      expect(model.terminal).toBeNull()
      expect(model.status).toBe(status)
      expect(model.statusText).not.toBe('')
    }
    // 无会话 → begin(status 空文案)
    expect(intakeStepModel(null).step).toBe('begin')
    expect(intakeStepModel(undefined).step).toBe('begin')
    expect(intakeStepModel({}).step).toBe('begin')
    expect(intakeStepModel({}).statusText).toBe('')
  })

  it('终态 (rejected/expired/failed) 携带 terminal 标记,不再可继续', () => {
    for (const status of INTAKE_TERMINAL_STATUSES) {
      const model = intakeStepModel(projection(status))
      expect(model.terminal).toBe(status)
    }
    // 每个 active 状态都可继续(与内核 INTAKE_ACTIVE_STATUSES 对齐)
    expect(INTAKE_ACTIVE_STATUSES).toEqual([
      'draft', 'uploading', 'scanning', 'needs_input', 'grilling',
      'proposal_ready', 'awaiting_human',
    ])
  })

  it('resume:全链路投影逐步推进,任何一步都从投影恢复', () => {
    const staged = projection('uploading', { artifacts: [{ artifact_id: 'sha256:aa', file_name: 'a.pdf', size_bytes: 10, sha256: 'a'.repeat(64), quarantine: 'staged', scan_result: {}, created_at: NOW }] })
    const scanned = projection('needs_input', {
      artifacts: [{
        artifact_id: 'sha256:aa', file_name: 'a.pdf', size_bytes: 10, sha256: 'a'.repeat(64),
        quarantine: 'clean', scan_result: { verdict: 'clean' }, created_at: NOW,
      }],
      session: { ...staged.session!, status: 'needs_input', scan_summary: { artifact_count: 1, clean: 1, quarantined: 0, rejected: 0, av_available: false } },
      questions: [question('owner_scope_license', true), question('seed', true)],
    })
    const answered = projection('proposal_ready', {
      session: { ...scanned.session!, status: 'proposal_ready' },
      artifacts: scanned.artifacts,
      questions: [question('owner_scope_license', true, 'me'), question('seed', true, '42')],
    })
    const proposed = projection('awaiting_human', {
      session: { ...answered.session!, status: 'awaiting_human' },
      questions: answered.questions,
      proposal: { proposal_id: 'proposal_x', intake_id: 'intk_test123', revision: 1, observed_phase: 'experiment', safe_project_status: 'DRAFT', confidence: 0.7, plan: 'p', risks: [], pre_accept_checklist: ['c'], unresolved_gaps: [], suggested_mappings: [], required_gates: [], next_actions: [], created_at: NOW },
    })
    const adopted = projection('accepted', {
      session: { ...proposed.session!, status: 'accepted' },
      proposal: proposed.proposal,
      receipt: { adoption_id: 'adopt_1', intake_id: 'intk_test123', project_id: 'rsp_1', proposal_revision: 1, target_project_revision: 0, created_object_refs: [], pending_gate_refs: [], draft_evidence_refs: [], idempotency_key: null, request_hash: '', adopted_by: { principal_id: 'human-1' }, adopted_at: NOW },
    })
    expect(intakeStepModel(staged).step).toBe('stage')
    expect(intakeStepModel(scanned).step).toBe('grill')
    expect(intakeStepModel(scanned).canPropose).toBe(false)
    expect(intakeStepModel(scanned).requiredOpen).toEqual(['owner_scope_license', 'seed'])
    expect(intakeStepModel(answered).step).toBe('propose')
    expect(intakeStepModel(answered).canPropose).toBe(true)
    expect(intakeStepModel(answered).requiredOpen).toEqual([])
    expect(intakeStepModel(proposed).step).toBe('adopt')
    expect(intakeStepModel(adopted).step).toBe('done')
    // 每步标题键齐全(begin 之外的步骤键映射)
    expect(intakeStepModel(staged).stepTitleKey).toBe('intake.step.stage')
    expect(intakeStepModel(scanned).stepTitleKey).toBe('intake.step.grill')
    expect(intakeStepModel(proposed).stepTitleKey).toBe('intake.step.adopt')
  })

  it('answered count helper', () => {
    expect(intakeAnsweredCount([])).toEqual({ answered: 0, total: 0 })
    const p = projection('grilling', { questions: [question('a', true, 'x'), question('b', false, null)] })
    expect(intakeAnsweredCount(p.questions)).toEqual({ answered: 1, total: 2 })
  })
})

describe('错误码映射 (intakeErrorText — 稳定错误码文案)', () => {
  it('每个已知错误码都有 zh/en 键且文案非空', () => {
    const zhKeys = Object.keys(intakeZh)
    const enKeys = Object.keys(intakeEn)
    for (const [code, key] of Object.entries(INTAKE_ERROR_KEYS)) {
      expect(zhKeys, `${code} → ${key}`).toContain(key)
      expect(enKeys, `${code} → ${key}`).toContain(key)
      expect(intakeZh[key]).not.toBe('')
      expect(intakeEn[key]).not.toBe('')
    }
  })

  it('已知码 → "code — 译文";未知码 → 原样保留(code + 服务端消息)', () => {
    setLocale('zh')
    const known = intakeErrorText('question_required')
    expect(known).toContain('question_required')
    expect(known).toContain(intakeZh['intake.error.question_required']!)
    setLocale('en')
    expect(intakeErrorText('question_required')).toContain(intakeEn['intake.error.question_required']!)
    // 未知码:机器码原样(不译不伪造),附服务端消息
    const unknown = intakeErrorText('future_intake_code', 'server says no')
    expect(unknown).toContain('future_intake_code')
    expect(unknown).toContain('server says no')
    expect(intakeErrorText('future_intake_code')).toBe('future_intake_code')
    // 空码 → 只显示消息
    expect(intakeErrorText(undefined, 'boom')).toBe('boom')
  })

  it('网络/认证层稳定码也有文案', () => {
    for (const code of ['network_error', 'unauthorized', 'payload_too_large', 'principal_required', 'proposal_stale']) {
      expect(intakeErrorText(code)).toContain(code)
      expect(intakeErrorText(code).length).toBeGreaterThan(code.length + 2)
    }
  })
})

describe('请求载荷 (Human 身份仅由 BFF 可信 header 提供)', () => {
  it('begin payload: source_label 必填,target_phase 可空', () => {
    expect(intakeBeginPayload('uploaded-paper', 'experiment')).toEqual({ source_label: 'uploaded-paper', target_phase: 'experiment' })
    expect(intakeBeginPayload('uploaded-paper', null)).toEqual({ source_label: 'uploaded-paper' })
    expect(intakeBeginPayload('uploaded-paper', undefined)).toEqual({ source_label: 'uploaded-paper' })
    expect(intakeBeginPayload('uploaded-paper', '')).toEqual({ source_label: 'uploaded-paper' })
  })

  it('answers payload: 仅含答案与 revision', () => {
    const body = intakeAnswersPayload([{ question_code: 'seed', answer: '42', question_revision: 1 }])
    expect(body).not.toHaveProperty('principal')
    expect(body.answers).toEqual([{ question_code: 'seed', answer: '42', question_revision: 1 }])
  })

  it('adopt payload: 仅钉定 proposal revision;可选 target revision;幂等键稳定', () => {
    const body = intakeAdoptPayload({ proposal_id: 'p', intake_id: 'i', revision: 3, observed_phase: 'experiment', safe_project_status: 'DRAFT', confidence: 0.5, created_at: NOW } as IntakeProjectionLite['proposal'], 7)
    expect(body).not.toHaveProperty('principal')
    expect(body.expected_proposal_revision).toBe(3)
    expect(body.expected_target_revision).toBe(7)
    // 无 proposal → 0(zod positive 会 422,向导仅在 awaiting_human 调用)
    expect(intakeAdoptPayload(null).expected_proposal_revision).toBe(0)
    expect(intakeAdoptPayload(null, 2).expected_target_revision).toBe(2)
    expect(intakeIdempotencyKey('intk_x')).toBe('ui-adopt-intk_x')
    expect(intakeIdempotencyKey('intk_x')).toBe(intakeIdempotencyKey('intk_x'))
  })
})

describe('上传校验 (intakeUploadIssue — 32MiB + 文件名,服务端再强制)', () => {
  it('≤32MiB 且合法文件名 → 通过', () => {
    expect(intakeUploadIssue({ name: 'paper.pdf', size: INTAKE_MAX_FILE_BYTES })).toBeNull()
    expect(intakeUploadIssue({ name: 'paper.pdf', size: 0 })).toBeNull()
  })

  it('>32MiB → payload_too_large;非法名 → invalid_file_name;缺失 → missing_file', () => {
    expect(intakeUploadIssue({ name: 'big.bin', size: INTAKE_MAX_FILE_BYTES + 1 })).toBe('intake.error.payload_too_large')
    expect(intakeUploadIssue({ name: '../evil.pdf', size: 10 })).toBe('intake.error.invalid_file_name')
    expect(intakeUploadIssue({ name: 'a\\b.pdf', size: 10 })).toBe('intake.error.invalid_file_name')
    expect(intakeUploadIssue({ name: 'a\u0000b.pdf', size: 10 })).toBe('intake.error.invalid_file_name')
    expect(intakeUploadIssue({ name: '', size: 10 })).toBe('intake.error.invalid_file_name')
    expect(intakeUploadIssue(null)).toBe('intake.error.missing_file')
    expect(intakeUploadIssue(undefined)).toBe('intake.error.missing_file')
  })
})

describe('NextAction 引导映射 (intakeGuidance — 每步投影结构化引导)', () => {
  it('状态派生引导:每个 active 状态给出正确 code 集合', () => {
    expect(intakeGuidance(null)).toEqual([])
    expect(intakeGuidance(projection('accepted'))).toEqual([])
    expect(intakeGuidance(projection('rejected'))).toEqual([])
    expect(intakeGuidance(projection('draft'))).toEqual([{ code: 'intake_resume', label: expect.any(String), reason: expect.any(String), tone: 'ready', intakeId: 'intk_test123' }])
    const uploading = projection('uploading', { artifacts: [{ artifact_id: 'sha256:aa', file_name: 'a.pdf', size_bytes: 1, sha256: 'a'.repeat(64), quarantine: 'staged', scan_result: {}, created_at: NOW }] })
    expect(intakeGuidance(uploading).map(i => i.code)).toEqual(['intake_resume', 'intake_scan'])
    for (const status of ['needs_input', 'grilling']) {
      expect(intakeGuidance(projection(status)).map(i => i.code)).toEqual(['intake_resume', 'intake_answer'])
    }
    expect(intakeGuidance(projection('proposal_ready')).map(i => i.code)).toEqual(['intake_resume', 'intake_propose'])
    expect(intakeGuidance(projection('awaiting_human')).map(i => i.code)).toEqual(['intake_resume', 'intake_adopt'])
  })

  it('next_actions_v2 intake 动作并入引导(去重,状态 tone 保留)', () => {
    const v2: NextActionV2[] = [
      { code: 'intake_adopt', label: 'Adopt intake proposal (PI)', state: 'done', refs: [{ kind: 'intake', id: 'intk_test123' }] },
      { code: 'intake_scan', label: 'Scan staged intake files', state: 'blocked' },
    ]
    // awaiting_human:状态派生已有 resume+adopt;v2 的 adopt 去重(done 不覆盖),scan 追加
    const items = intakeGuidance(projection('awaiting_human'), v2)
    expect(items.map(i => i.code)).toEqual(['intake_resume', 'intake_adopt', 'intake_scan'])
    expect(items.find(i => i.code === 'intake_scan')?.tone).toBe('blocked')
    expect(items.find(i => i.code === 'intake_adopt')?.tone).toBe('ready')
    // 非 intake code 永不进入引导
    const mixed = intakeGuidance(projection('awaiting_human'), [{ code: 'survey_run', label: 'x', state: 'ready' }])
    expect(mixed.map(i => i.code)).toEqual(['intake_resume', 'intake_adopt'])
  })

  it('refs 提取:intake/project id 解析', () => {
    expect(intakeRefId([{ kind: 'intake', id: 'intk_1' }, { kind: 'project', id: 'rsp_1' }])).toBe('intk_1')
    expect(intakeProjectRefId([{ kind: 'intake', id: 'intk_1' }, { kind: 'project', id: 'rsp_1' }])).toBe('rsp_1')
    expect(intakeRefId([])).toBeNull()
    expect(intakeProjectRefId(undefined)).toBeNull()
  })
})

describe('scan 摘要 / verdict / 阶段与状态文案', () => {
  it('scanSummary 默认与数值回退', () => {
    expect(intakeScanSummary(null)).toEqual({ artifact_count: 0, clean: 0, quarantined: 0, rejected: 0, av_available: false })
    const p = projection('needs_input', { session: { intake_id: 'i', status: 'needs_input', scan_summary: { artifact_count: 2, clean: 1, quarantined: 1, rejected: 0, av_available: false } } })
    const s = intakeScanSummary(p)
    expect(s.artifact_count).toBe(2)
    expect(s.clean).toBe(1)
    expect(s.quarantined).toBe(1)
    expect(s.rejected).toBe(0)
    expect(s.av_available).toBe(false)
  })

  it('verdict 文案与 tone', () => {
    expect(intakeVerdictTone({ quarantine: 'clean' })).toBe('clean')
    expect(intakeVerdictTone({ quarantine: 'rejected' })).toBe('rejected')
    expect(intakeVerdictTone({ quarantine: 'quarantined' })).toBe('quarantined')
    expect(intakeVerdictTone({ quarantine: 'staged' })).toBe('staged')
    expect(intakeVerdictTone({})).toBe('staged')
    for (const q of ['staged', 'scanning', 'clean', 'quarantined', 'rejected']) {
      expect(intakeVerdictText({ quarantine: q })).not.toBe('')
    }
    expect(intakeVerdictText({ quarantine: 'future-verdict' })).toBe('future-verdict')
  })

  it('阶段与状态文案:已知值随 locale 求值,未知值原样', () => {
    setLocale('zh')
    const zhPhase = intakePhaseText('experiment')
    const zhStatus = intakeStatusText('grilling')
    setLocale('en')
    const enPhase = intakePhaseText('experiment')
    const enStatus = intakeStatusText('grilling')
    expect(zhPhase).not.toBe(enPhase)
    expect(zhStatus).not.toBe(enStatus)
    expect(intakePhaseText('future-phase')).toBe('future-phase')
    expect(intakeStatusText('future-status')).toBe('future-status')
    expect(intakePhaseText(null)).not.toBe('')
    expect(intakeStatusText(undefined)).toBe('')
    expect(INTAKE_PHASE_OPTIONS.length).toBe(10)
  })
})

describe('i18n:intake 命名空间 zh/en parity + 零缺 key', () => {
  it('zh/en 键集精确一致(与 localeParityReport 同口径)', () => {
    expect(Object.keys(intakeZh).sort()).toEqual(Object.keys(intakeEn).sort())
    expect(localeParityReport()).toEqual([])
  })

  it('在两种 locale 下求值全部模型,零缺 key', () => {
    for (const locale of ['zh', 'en'] as const) {
      setLocale(locale)
      for (const status of [...INTAKE_ACTIVE_STATUSES, ...INTAKE_TERMINAL_STATUSES, 'accepted']) {
        intakeStepModel(projection(status))
        intakeGuidance(projection(status))
      }
      intakeErrorText('question_required')
      intakePhaseText('experiment')
      intakeStatusText('grilling')
      intakeVerdictText({ quarantine: 'clean' })
      for (const phase of INTAKE_PHASE_OPTIONS) intakePhaseText(phase)
    }
    expect(missing).toEqual([])
    expect(getLocale()).toBe('en')
  })
})
