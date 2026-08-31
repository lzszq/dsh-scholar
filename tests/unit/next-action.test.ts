/**
 * GUIDE-01 — structured NextAction projection tests (design §4.2, §14).
 *
 * Covers: per-phase base actions, code stability, required-gap semantics,
 * the structured single authority, unknown-state safe degradation,
 * pending-gate and budget-blocking overlay actions, failed-job retry/repair
 * overlay, and kernel-level projectProjection integration.
 */
import { describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  ResearchKernel, nextActionProjection, INTAKE_ACTIVE_STATUSES,
  type NextActionContext, type NextActionIntake, type NextActionJob,
} from '@dsh-scholar/research-kernel'
import {
  NEXT_ACTION_UNKNOWN_CODE, NextAction, ProjectStatus,
  fixtureContract, fixtureCorpus, fixtureEvidence, fixtureIdea, fixtureProject,
  DirectionAdoption, DirectionProposal, ResearchSynthesis,
  type Gate, type ResearchDirection, type ResearchProject,
} from '@dsh-scholar/research-schemas'

const PROJECT_ID = 'rsp_20260806_001'
const NOW = '2026-08-06T12:00:00.000Z'
const HASH = `sha256:${'a'.repeat(64)}` as const
const BASIS = {
  provenance: 'explicit' as const,
  statement: 'The direction follows from accepted evidence.',
  source_refs: [{ kind: 'evidence' as const, id: 'evidence_direction', sha256: HASH }],
}

function gate(type: Gate['type'], id = `gate_${type}_x1`): Gate {
  return {
    gate_id: id, project_id: PROJECT_ID, type, title: `${type} gate`, summary: '',
    payload: {}, status: 'pending', dsh_session_id: null, dsh_event_id: null,
    created_at: NOW, decided_at: null,
  }
}

function methodologyOverlay(
  direction: ResearchDirection,
  snapshot: { project_revision: number; next_action_revision: number },
  adoptions: DirectionAdoption[] = [],
  projectId = PROJECT_ID,
) {
  const synthesis = ResearchSynthesis.parse({
    synthesis_id: 'synth_next_action_1', project_id: projectId,
    window: { from_event_seq: 1, to_event_seq: 2 }, snapshot_pin: snapshot,
    inputs: { accepted_evidence_refs: ['evidence_direction'], verified_evidence_refs: [], run_refs: [], corpus_snapshot_refs: [] },
    findings: { supported: [BASIS], contradicted: [], negative: [], inconclusive: [], infrastructure_failures: [] },
    patterns: [], open_questions: [], constraints_learned: [], artifact_body_ref: 'artifact:direction-synthesis',
    direction_proposal_id: 'direction_next_action_1', confidence: 'high', generated_by: 'human', input_hash: HASH,
    status: 'reviewed', adoption_ref: null, created_at: NOW,
  })
  const proposal = DirectionProposal.parse({
    proposal_id: 'direction_next_action_1', project_id: projectId, synthesis_id: synthesis.synthesis_id,
    direction, rationale_artifact_id: 'artifact:direction-rationale', basis: [BASIS], snapshot_pin: snapshot,
    input_hash: HASH, status: 'proposed', created_at: NOW,
  })
  return { syntheses: [synthesis], proposals: [proposal], adoptions }
}

function adoptedMethodologyOverlay(
  direction: ResearchDirection,
  snapshot: { project_revision: number; next_action_revision: number },
  projectId = PROJECT_ID,
) {
  const overlay = methodologyOverlay(direction, snapshot, [], projectId)
  overlay.adoptions = [DirectionAdoption.parse({
    adoption_id: `adoption_${direction}_next_action`, proposal_id: overlay.proposals[0]!.proposal_id,
    project_id: projectId, decision: 'adopted', actor: { kind: 'human', ref: 'pi-direction' },
    gate_decision_ref: direction === 'pivot' || direction === 'broaden' ? 'dec_direction' : null,
    created_at: NOW,
  })]
  return {
    ...overlay,
    direction_gate_approvals: direction === 'pivot' || direction === 'broaden' ? [{
      decision_id: 'dec_direction',
      gate_id: 'gate_direction_adopted',
      project_id: projectId,
      decision: 'approved' as const,
      gate: {
        ...gate('direction', 'gate_direction_adopted'),
        project_id: projectId,
        status: 'approved' as const,
        decided_at: NOW,
        payload: {
          purpose: 'direction_adoption',
          proposal_id: overlay.proposals[0]!.proposal_id,
          source_synthesis_id: overlay.syntheses[0]!.synthesis_id,
          direction,
        },
      },
    }] : [],
  }
}

function job(partial: Partial<NextActionJob> & { job_id: string; kind: string; status: NextActionJob['status'] }): NextActionJob {
  return { failure_class: null, attempts: 0, max_attempts: 3, contract_id: null, created_at: NOW, ...partial }
}

function intake(partial: Partial<NextActionIntake> & { status: string }): NextActionIntake {
  return { intake_id: 'intk_1', status: partial.status, target_phase: 'experiment', artifact_count: 0, ...partial }
}

/** Minimal authoritative-state context; per-test overrides win. */
function ctx(overrides: Partial<NextActionContext> & { status: ResearchProject['status'] }): NextActionContext {
  const project = fixtureProject({ status: overrides.status, project_id: PROJECT_ID })
  return {
    project,
    gates: [],
    jobs: [],
    budget: { project_id: PROJECT_ID, model_cost_usd: 0, gpu_hours: 0, api_requests: 0, updated_at: NOW },
    contracts: [],
    ideas: [],
    evidence: [],
    claims: [],
    corpus_snapshots: [],
    ...overrides,
  }
}

function freshKernel(): { kernel: ResearchKernel; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-next-action-test-'))
  const kernel = new ResearchKernel({ dbPath: join(dir, 'kernel.db'), casRoot: join(dir, 'cas'), requireSignedManifest: false })
  return { kernel, dir }
}

describe('GUIDE-01 NextAction projection (pure)', () => {
  it('projects a fresh governed Direction through the exact dedicated Gate', () => {
    const base = ctx({ status: 'EXPERIMENTING', contracts: [fixtureContract()] })
    const nextRevision = nextActionProjection(base).find(item => item.state === 'ready')!.revision!
    const exactGate: Gate = {
      ...gate('direction', 'gate_direction_exact'),
      payload: {
        purpose: 'direction_adoption', proposal_id: 'direction_next_action_1',
        source_synthesis_id: 'synth_next_action_1', direction: 'pivot',
      },
    }
    const actions = nextActionProjection({
      ...base,
      gates: [exactGate],
      methodology: methodologyOverlay('pivot', { project_revision: base.project.revision, next_action_revision: nextRevision }),
    } as NextActionContext)

    expect(actions.find(item => item.code === 'direction_gate_review')).toEqual(expect.objectContaining({
      state: 'ready', required: true, required_by: 'human', capability: 'pi', revision: nextRevision,
      refs: [
        { kind: 'gate', id: exactGate.gate_id },
        { kind: 'direction', id: 'direction_next_action_1' },
        { kind: 'synthesis', id: 'synth_next_action_1' },
      ],
    }))
  })

  it('fails closed with diagnostics when Direction project, NextAction or input pins are stale', () => {
    const base = ctx({ status: 'EXPERIMENTING', contracts: [fixtureContract()] })
    const nextRevision = nextActionProjection(base).find(item => item.state === 'ready')!.revision!
    const snapshot = { project_revision: base.project.revision, next_action_revision: nextRevision }
    const cases = [
      {
        required: 'direction_project_revision_changed',
        overlay: { ...methodologyOverlay('pivot', snapshot), proposals: [{ ...methodologyOverlay('pivot', snapshot).proposals[0]!, snapshot_pin: { ...snapshot, project_revision: snapshot.project_revision + 1 } }] },
      },
      {
        required: 'direction_next_action_revision_changed',
        overlay: { ...methodologyOverlay('pivot', snapshot), proposals: [{ ...methodologyOverlay('pivot', snapshot).proposals[0]!, snapshot_pin: { ...snapshot, next_action_revision: snapshot.next_action_revision + 1 } }] },
      },
      {
        required: 'direction_input_hash_changed',
        overlay: { ...methodologyOverlay('pivot', snapshot), proposals: [{ ...methodologyOverlay('pivot', snapshot).proposals[0]!, input_hash: `sha256:${'b'.repeat(64)}` as const }] },
      },
    ]

    for (const { overlay, required } of cases) {
      const actions = nextActionProjection({ ...base, methodology: overlay } as NextActionContext)
      expect(actions).toContainEqual(expect.objectContaining({
        code: 'direction_overlay_stale', state: 'blocked', required: expect.arrayContaining([required]),
      }))
      expect(actions.some(item => item.code === 'direction_gate_review' && item.state === 'ready')).toBe(false)
      expect(actions.some(item => item.code.startsWith('direction_') && item.required_by === 'agent' && item.state === 'ready')).toBe(false)
    }
  })

  it('never treats a wrong-bound or cross-project Direction Gate as reviewable', () => {
    const base = ctx({ status: 'EXPERIMENTING', contracts: [fixtureContract()] })
    const nextRevision = nextActionProjection(base).find(item => item.state === 'ready')!.revision!
    const snapshot = { project_revision: base.project.revision, next_action_revision: nextRevision }
    const wrongGate: Gate = {
      ...gate('direction', 'gate_direction_wrong'),
      payload: {
        purpose: 'direction_adoption', proposal_id: 'direction_next_action_1',
        source_synthesis_id: 'synth_wrong', direction: 'pivot',
      },
    }
    const wrongBinding = nextActionProjection({
      ...base, gates: [wrongGate], methodology: methodologyOverlay('pivot', snapshot),
    } as NextActionContext).find(item => item.code === 'direction_gate_review')
    expect(wrongBinding).toEqual(expect.objectContaining({
      state: 'blocked', required: ['direction_gate_binding_mismatch'],
    }))
    expect(wrongBinding?.refs).not.toContainEqual({ kind: 'gate', id: wrongGate.gate_id })

    const exactGate: Gate = {
      ...gate('direction', 'gate_direction_exact_a'),
      payload: {
        purpose: 'direction_adoption', proposal_id: 'direction_next_action_1',
        source_synthesis_id: 'synth_next_action_1', direction: 'pivot',
      },
    }
    const duplicateGate: Gate = { ...exactGate, gate_id: 'gate_direction_exact_b' }
    const ambiguous = nextActionProjection({
      ...base, gates: [exactGate, duplicateGate], methodology: methodologyOverlay('pivot', snapshot),
    } as NextActionContext).find(item => item.code === 'direction_gate_review')
    expect(ambiguous).toEqual(expect.objectContaining({
      state: 'blocked', required: ['direction_gate_ambiguous'], refs: expect.not.arrayContaining([
        { kind: 'gate', id: exactGate.gate_id },
        { kind: 'gate', id: duplicateGate.gate_id },
      ]),
    }))

    const foreign = methodologyOverlay('pivot', snapshot)
    foreign.proposals[0] = { ...foreign.proposals[0]!, project_id: 'rsp_foreign' }
    const crossProject = nextActionProjection({ ...base, gates: [wrongGate], methodology: foreign } as NextActionContext)
      .find(item => item.code === 'direction_overlay_invalid')
    expect(crossProject).toEqual(expect.objectContaining({
      state: 'blocked', required: expect.arrayContaining(['direction_project_binding_invalid']),
    }))
    expect(crossProject?.refs).not.toContainEqual({ kind: 'direction', id: 'direction_next_action_1' })
  })

  it('maps every adopted Direction to one deterministic revision-bound continuation', () => {
    const base = ctx({ status: 'EXPERIMENTING', contracts: [fixtureContract()] })
    const nextRevision = nextActionProjection(base).find(item => item.state === 'ready')!.revision!
    const snapshot = { project_revision: base.project.revision, next_action_revision: nextRevision }
    const cases: Array<[ResearchDirection, string, string, 'human' | 'agent']> = [
      ['deepen', 'direction_deepen_continue', 'runs', 'agent'],
      ['broaden', 'direction_broaden_intake', 'overview', 'human'],
      ['pivot', 'direction_pivot_intake', 'overview', 'human'],
      ['conclude', 'direction_conclude_prepare', 'evidence', 'agent'],
      ['pause', 'direction_pause_review', 'overview', 'human'],
    ]
    for (const [direction, code, route, requiredBy] of cases) {
      const overlay = adoptedMethodologyOverlay(direction, snapshot)
      const action = nextActionProjection({ ...base, methodology: overlay } as NextActionContext)
        .find(item => item.code === code)
      expect(action, direction).toEqual(expect.objectContaining({
        state: 'ready', required: true, required_by: requiredBy, route, revision: nextRevision,
        refs: [
          { kind: 'adoption', id: `adoption_${direction}_next_action` },
          { kind: 'direction', id: 'direction_next_action_1' },
          { kind: 'synthesis', id: 'synth_next_action_1' },
          { kind: 'project', id: PROJECT_ID },
        ],
      }))
    }
  })

  it('fails closed when a governed adoption receipt is wrong-bound on replay', () => {
    const base = ctx({ status: 'EXPERIMENTING', contracts: [fixtureContract()] })
    const nextRevision = nextActionProjection(base).find(item => item.state === 'ready')!.revision!
    const overlay = adoptedMethodologyOverlay('pivot', {
      project_revision: base.project.revision,
      next_action_revision: nextRevision,
    })
    overlay.direction_gate_approvals[0]!.gate.payload = {
      purpose: 'direction_adoption',
      proposal_id: 'direction_next_action_1',
      source_synthesis_id: 'synth_wrong',
      direction: 'pivot',
    }

    const actions = nextActionProjection({ ...base, methodology: overlay } as NextActionContext)
    expect(actions).toContainEqual(expect.objectContaining({
      code: 'direction_overlay_invalid',
      state: 'blocked',
      required: ['direction_adoption_gate_binding_invalid'],
    }))
    expect(actions.some(item => item.code === 'direction_pivot_intake')).toBe(false)
  })

  it('every known status yields ≥1 schema-valid action; code/id set is deterministic', () => {
    for (const status of ProjectStatus.options) {
      const actions = nextActionProjection(ctx({ status }))
      expect(actions.length).toBeGreaterThanOrEqual(1)
      for (const action of actions) {
        expect(NextAction.safeParse(action).success).toBe(true)
        expect(action.code.length).toBeGreaterThan(0)
        expect(['ready', 'blocked', 'done']).toContain(action.state)
        expect(['human', 'agent', 'runner']).toContain(action.required_by)
      }
      // Same input → identical ids/codes (stable machine projection).
      const again = nextActionProjection(ctx({ status }))
      expect(again.map(a => a.id)).toEqual(actions.map(a => a.id))
      expect(again.map(a => a.code)).toEqual(actions.map(a => a.code))
      // Known statuses never degrade to the unknown fallback.
      expect(actions[0]?.code).not.toBe(NEXT_ACTION_UNKNOWN_CODE)
    }
  })

  it('each phase projects its expected base action code(s)', () => {
    const cases: Array<[ResearchProject['status'], string[]]> = [
      ['DRAFT', ['scope_gate_submit']],
      ['SCOPED', ['survey_run']],
      ['SURVEYING', ['idea_generate', 'survey_run']],
      ['IDEATING', ['idea_gate_approve']],
      ['IDEA_APPROVED', ['contract_register']],
      ['CONTRACT_PENDING' as ResearchProject['status'], ['contract_register']],
      ['CONTRACT_APPROVED', ['baseline_reproduce']],
      ['BASELINE_REPRO', ['baseline_reproduce', 'pilot_formal_submit']],
      ['EXPERIMENTING', ['pilot_formal_submit', 'evidence_verify']],
      ['EVIDENCE_READY', ['manuscript_write']],
      ['WRITING', ['reviewer_run']],
      ['REVIEWING', ['release_bundle', 'release_gate']],
      ['RELEASE_READY', ['release_gate']],
      ['BLOCKED_GATE', ['gate_resolve']],
      ['FAILED', ['project_stop']],
      ['ARCHIVED', ['project_archived']],
      ['RELEASED', ['project_released']],
      ['STOPPED', ['project_stopped']],
    ]
    for (const [status, expectedCodes] of cases) {
      const actions = nextActionProjection(ctx({ status }))
      expect(actions.map(a => a.code)).toEqual(expectedCodes)
    }
  })

  it('stops asking to generate ideas once SURVEYING already has proposed candidates', () => {
    const actions = nextActionProjection(ctx({
      status: 'SURVEYING',
      ideas: [{ ...fixtureIdea(PROJECT_ID), status: 'proposed' }],
    }))
    expect(actions[0]).toMatchObject({
      code: 'idea_select',
      route: 'ideas',
      state: 'ready',
      required: true,
      required_by: 'human',
    })
    expect(actions[0]?.refs).toEqual([{ kind: 'idea', id: 'idea_003' }])
    expect(actions.some(action => action.code === 'idea_generate')).toBe(false)
  })

  it('keeps idea generation blocked until the latest corpus snapshot is frozen, complete, and non-empty', () => {
    const noCorpus = nextActionProjection(ctx({ status: 'SURVEYING' }))
    expect(noCorpus).toContainEqual(expect.objectContaining({
      code: 'idea_generate',
      state: 'blocked',
      required: ['frozen_nonempty_corpus_snapshot'],
    }))
    expect(noCorpus).toContainEqual(expect.objectContaining({
      code: 'survey_run', state: 'ready', required_by: 'agent', route: 'chat',
    }))

    const emptyCorpus = fixtureCorpus(PROJECT_ID)
    emptyCorpus.papers = []
    emptyCorpus.passages = []
    emptyCorpus.external_claims = []
    emptyCorpus.quality.total_papers = 0
    expect(nextActionProjection(ctx({ status: 'SURVEYING', corpus_snapshots: [emptyCorpus] })))
      .toContainEqual(expect.objectContaining({
        code: 'idea_generate',
        state: 'blocked',
        required: ['frozen_nonempty_corpus_snapshot'],
      }))

    const pendingCorpus = fixtureCorpus(PROJECT_ID)
    pendingCorpus.source_status = 'pending'
    expect(nextActionProjection(ctx({ status: 'SURVEYING', corpus_snapshots: [pendingCorpus] })))
      .toContainEqual(expect.objectContaining({
        code: 'idea_generate',
        state: 'blocked',
      }))

    expect(nextActionProjection(ctx({ status: 'SURVEYING', corpus_snapshots: [fixtureCorpus(PROJECT_ID)] })))
      .toContainEqual(expect.objectContaining({
        code: 'idea_generate',
        state: 'ready',
        required: true,
      }))
  })

  it('never deadlocks after Idea approval: contract draft is ready before contract-bound baseline', () => {
    const approvedIdea = { ...fixtureIdea(PROJECT_ID), status: 'approved' as const }
    const awaitingContract = nextActionProjection(ctx({ status: 'IDEA_APPROVED', ideas: [approvedIdea] }))
    expect(awaitingContract).toHaveLength(1)
    expect(awaitingContract[0]).toMatchObject({
      code: 'contract_register', state: 'ready', required: true, required_by: 'agent', route: 'contracts',
    })

    const withContract = nextActionProjection(ctx({
      status: 'IDEA_APPROVED', ideas: [approvedIdea], contracts: [fixtureContract()],
    }))
    expect(withContract.some(action => action.state === 'ready')).toBe(true)

    const pending = nextActionProjection(ctx({
      status: 'CONTRACT_PENDING' as ResearchProject['status'],
      ideas: [approvedIdea], contracts: [{ ...fixtureContract(), status: 'draft' }], gates: [gate('contract')],
    }))
    expect(pending.some(action => action.code === 'contract_gate_approve' && action.state === 'ready')).toBe(true)

    const rejected = nextActionProjection(ctx({
      status: 'CONTRACT_PENDING' as ResearchProject['status'],
      ideas: [approvedIdea], contracts: [{ ...fixtureContract(), status: 'draft' }], gates: [],
    }))
    expect(rejected).toContainEqual(expect.objectContaining({ code: 'contract_register', state: 'ready' }))

    const contractApproved = nextActionProjection(ctx({ status: 'CONTRACT_APPROVED', contracts: [fixtureContract()] }))
    expect(contractApproved).toContainEqual(expect.objectContaining({
      code: 'baseline_reproduce', state: 'ready', required: ['baseline_command'],
    }))

    const contractNeedsExecutionInputs = nextActionProjection(ctx({
      status: 'CONTRACT_APPROVED',
      contracts: [{ ...fixtureContract(), baseline_run: undefined, code_snapshot: undefined }],
      code_snapshots: [],
      runner_environment_ready: true,
    }))
    expect(contractNeedsExecutionInputs).toContainEqual(expect.objectContaining({
      code: 'baseline_reproduce',
      state: 'ready',
      required: ['baseline_command', 'code_snapshot'],
    }))

    const repro = nextActionProjection(ctx({ status: 'BASELINE_REPRO', contracts: [fixtureContract()] }))
    expect(repro.find(a => a.code === 'baseline_reproduce')?.state).toBe('ready')
    expect(repro.find(a => a.code === 'pilot_formal_submit')?.state).toBe('blocked')

    const reproDone = nextActionProjection(ctx({
      status: 'BASELINE_REPRO',
      contracts: [fixtureContract()],
      jobs: [job({ job_id: 'job_bl_1', kind: 'baseline', status: 'succeeded', contract_id: 'expc_007' })],
    }))
    expect(reproDone.find(a => a.code === 'baseline_reproduce')?.state).toBe('done')
    expect(reproDone.find(a => a.code === 'pilot_formal_submit')?.state).toBe('ready')
  })

  it('EXPERIMENTING: evidence_verify needs succeeded runs, done after accepted evidence', () => {
    const noRuns = nextActionProjection(ctx({ status: 'EXPERIMENTING', contracts: [fixtureContract()] }))
    expect(noRuns.find(a => a.code === 'evidence_verify')?.state).toBe('blocked')
    expect(noRuns.find(a => a.code === 'evidence_verify')?.required).toEqual(['succeeded_runs'])

    const withRuns = nextActionProjection(ctx({
      status: 'EXPERIMENTING', contracts: [fixtureContract()],
      jobs: [job({ job_id: 'job_f_1', kind: 'formal', status: 'succeeded', contract_id: 'expc_007' })],
    }))
    expect(withRuns.find(a => a.code === 'evidence_verify')?.state).toBe('ready')
    expect(withRuns.find(a => a.code === 'pilot_formal_submit')?.state).toBe('done')

    const withEvidence = nextActionProjection(ctx({
      status: 'EXPERIMENTING', contracts: [fixtureContract()],
      jobs: [job({ job_id: 'job_f_1', kind: 'formal', status: 'succeeded', contract_id: 'expc_007' })],
      evidence: [fixtureEvidence().evidence],
    }))
    expect(withEvidence.find(a => a.code === 'evidence_verify')?.state).toBe('done')
  })

  it('unknown/future status degrades safely: code=unknown, no throw, read-only', () => {
    const actions = nextActionProjection(ctx({ status: 'FUTURE_PHASE' as unknown as ResearchProject['status'] }))
    expect(actions).toHaveLength(1)
    expect(actions[0]?.code).toBe(NEXT_ACTION_UNKNOWN_CODE)
    expect(actions[0]?.state).toBe('blocked')
    expect(actions[0]?.required).toEqual(['state_mapping'])
    expect(actions[0]?.blocking).toBe(true)
    expect(actions[0]?.capability).toBeUndefined()
  })

  it('pending budget gate + exhausted budget → blocked budget_resolve; other pending gates → gate_decide', () => {
    const budgetGate = gate('budget')
    const blocked = nextActionProjection(ctx({
      status: 'BLOCKED_GATE',
      gates: [budgetGate],
      budget: { project_id: PROJECT_ID, model_cost_usd: 300, gpu_hours: 10, api_requests: 0, updated_at: NOW },
    }))
    const resolve = blocked.find(a => a.code === 'budget_resolve')
    expect(resolve).toBeDefined()
    expect(resolve?.state).toBe('blocked')
    expect(resolve?.blocking).toBe(true)
    expect(resolve?.required).toEqual(['budget_headroom'])
    expect(resolve?.refs).toContainEqual({ kind: 'gate', id: budgetGate.gate_id })
    expect(resolve?.reason).toContain('budget limits exceeded')
    // The generic gate_resolve base action stays alongside.
    expect(blocked.some(a => a.code === 'gate_resolve')).toBe(true)

    // Pending gates not referenced by a base action → gate_decide each.
    const surveying = nextActionProjection(ctx({ status: 'SURVEYING', gates: [gate('idea'), gate('contract')] }))
    expect(surveying.filter(a => a.code === 'gate_decide')).toHaveLength(2)

    // Base action references its own pending gate → no duplicate gate_decide.
    const draft = nextActionProjection(ctx({ status: 'DRAFT', gates: [gate('scope', 'gate_scope_1')] }))
    expect(draft.filter(a => a.code === 'gate_decide')).toHaveLength(0)
    expect(draft.find(a => a.code === 'scope_gate_submit')?.refs).toContainEqual({ kind: 'gate', id: 'gate_scope_1' })
  })

  it('failed/retryable jobs emit retry actions; exhausted attempts block with repair_decision', () => {
    const retryable = nextActionProjection(ctx({
      status: 'EXPERIMENTING', contracts: [fixtureContract()],
      jobs: [job({ job_id: 'job_b_1', kind: 'baseline', status: 'failed', failure_class: 'environment', attempts: 1 })],
    }))
    const retry = retryable.find(a => a.code === 'job_retry')
    expect(retry?.state).toBe('ready')
    expect(retry?.required).toBe(true)
    expect(retry?.blocking).toBe(false)
    expect(retry?.refs).toContainEqual({ kind: 'job', id: 'job_b_1' })
    expect(retry?.reason).toContain('environment')

    const exhausted = nextActionProjection(ctx({
      status: 'BASELINE_REPRO',
      jobs: [job({ job_id: 'job_b_2', kind: 'baseline', status: 'failed', failure_class: 'code_error', attempts: 3, max_attempts: 3 })],
    }))
    const repair = exhausted.find(a => a.code === 'job_retry')
    expect(repair?.state).toBe('blocked')
    expect(repair?.required).toEqual(['repair_decision'])
    expect(repair?.capability).toBe('pi')
  })
})

describe('GUIDE-01 intake overlay (ONBOARD-01 landing — intake_* actions)', () => {
  it('no active intakes → no intake_* actions (backward compatible)', () => {
    const actions = nextActionProjection(ctx({ status: 'DRAFT' }))
    expect(actions.some(a => a.code.startsWith('intake_'))).toBe(false)
  })

  it('every active intake status projects intake_resume + the status step overlay', () => {
    const cases: Array<[string, string[]]> = [
      ['draft', ['intake_resume']],
      ['uploading', ['intake_resume', 'intake_scan']],
      ['scanning', ['intake_resume']],
      ['needs_input', ['intake_resume', 'intake_answer']],
      ['grilling', ['intake_resume', 'intake_answer']],
      ['proposal_ready', ['intake_resume', 'intake_propose']],
      ['awaiting_human', ['intake_resume', 'intake_adopt']],
    ]
    for (const [status, expected] of cases) {
      const actions = nextActionProjection(ctx({
        status: 'DRAFT',
        intakes: [intake({ status, intake_id: 'intk_1', artifact_count: status === 'uploading' ? 1 : 0 })],
      }))
      const codes = actions.filter(a => a.code.startsWith('intake_')).map(a => a.code)
      expect(codes, status).toEqual(expected)
      for (const action of actions) {
        expect(NextAction.safeParse(action).success).toBe(true)
      }
      // 幂等稳定:同一输入产生同一 id/code 集合
      const again = nextActionProjection(ctx({
        status: 'DRAFT',
        intakes: [intake({ status, intake_id: 'intk_1', artifact_count: status === 'uploading' ? 1 : 0 })],
      }))
      expect(again.map(a => a.id)).toEqual(actions.map(a => a.id))
    }
  })

  it('intake_scan only when artifacts are staged; uploading with 0 files emits resume only', () => {
    const noArtifacts = nextActionProjection(ctx({ status: 'DRAFT', intakes: [intake({ status: 'uploading', artifact_count: 0 })] }))
    expect(noArtifacts.filter(a => a.code.startsWith('intake_')).map(a => a.code)).toEqual(['intake_resume'])
    const withArtifacts = nextActionProjection(ctx({ status: 'DRAFT', intakes: [intake({ status: 'uploading', artifact_count: 3 })] }))
    expect(withArtifacts.filter(a => a.code.startsWith('intake_')).map(a => a.code)).toEqual(['intake_resume', 'intake_scan'])
  })

  it('intake_adopt requires the pi capability and carries intake+project refs', () => {
    const actions = nextActionProjection(ctx({ status: 'DRAFT', intakes: [intake({ status: 'awaiting_human' })] }))
    const adopt = actions.find(a => a.code === 'intake_adopt')
    expect(adopt).toBeDefined()
    expect(adopt?.capability).toBe('pi')
    expect(adopt?.required_by).toBe('human')
    expect(adopt?.blocking).toBe(false)
    expect(adopt?.refs).toContainEqual({ kind: 'intake', id: 'intk_1' })
    expect(adopt?.refs).toContainEqual({ kind: 'project', id: PROJECT_ID })
    expect(adopt?.state).toBe('ready')
    // 每个 active intake 各有一条 resume(ref 绑定)
    const two = nextActionProjection(ctx({
      status: 'DRAFT',
      intakes: [intake({ status: 'draft', intake_id: 'intk_a' }), intake({ status: 'grilling', intake_id: 'intk_b' })],
    }))
    const resumes = two.filter(a => a.code === 'intake_resume')
    expect(resumes.map(a => a.refs.find(r => r.kind === 'intake')?.id)).toEqual(['intk_a', 'intk_b'])
  })

  it('terminal intakes (accepted/rejected/expired/failed) project nothing', () => {
    for (const status of ['accepted', 'rejected', 'expired', 'failed']) {
      const actions = nextActionProjection(ctx({ status: 'DRAFT', intakes: [intake({ status })] }))
      expect(actions.some(a => a.code.startsWith('intake_')), status).toBe(false)
    }
    // INTAKE_ACTIVE_STATUSES 导出与 schema 状态机一致
    expect(INTAKE_ACTIVE_STATUSES).toEqual([
      'draft', 'uploading', 'scanning', 'needs_input', 'grilling',
      'proposal_ready', 'awaiting_human',
    ])
  })
})

describe('GUIDE-01 kernel integration (projectProjection)', () => {
  it('rebuilds the same adopted pivot continuation after reopen without mutating Project authority', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-direction-reopen-'))
    const options = { dbPath: join(dir, 'kernel.db'), casRoot: join(dir, 'cas'), requireSignedManifest: false }
    const first = new ResearchKernel(options)
    try {
      const project = first.createProject({
        name: 'direction reopen', workspace: '/research/direction-reopen',
        brief: { problem: 'p', scope: 's', questions: [], primary_metrics: ['m'], resources: '', risks: [], target_outputs: ['paper'], target_venue: null, baseline_repo: null, domain: 'ml' },
      })
      const authorityBefore = first.getProject(project.project_id)
      const revision = first.projectProjection(project.project_id).next_actions_v2.find(item => item.state === 'ready')!.revision!
      const overlay = methodologyOverlay('pivot', {
        project_revision: project.revision, next_action_revision: revision,
      }, [], project.project_id)
      first.methodology.recordResearchSynthesis({ record: overlay.syntheses[0]!, expected_revision: 0 })
      first.methodology.recordDirectionProposal({ record: overlay.proposals[0]!, expected_revision: 1 })
      const gate = first.createGate({
        project_id: project.project_id, type: 'direction', title: 'Pivot review',
        payload: {
          purpose: 'direction_adoption', proposal_id: 'direction_next_action_1',
          source_synthesis_id: 'synth_next_action_1', direction: 'pivot',
        },
      })
      expect(first.projectProjection(project.project_id).next_actions_v2)
        .toContainEqual(expect.objectContaining({ code: 'direction_gate_review', state: 'ready' }))
      const decision = first.decideGate({
        gate_id: gate.gate_id, actor: 'pi-direction',
        principal: { principal_id: 'pi-direction', auth_method: 'dsh-session' }, decision: 'approved',
      }).decision
      first.methodology.recordDirectionAdoption({
        expected_revision: 2,
        record: DirectionAdoption.parse({
          adoption_id: 'adoption_pivot_reopen', proposal_id: 'direction_next_action_1', project_id: project.project_id,
          decision: 'adopted', actor: { kind: 'human', ref: 'pi-direction' },
          gate_decision_ref: decision.decision_id, created_at: NOW,
        }),
      })
      const continuation = first.projectProjection(project.project_id).next_actions_v2
        .find(item => item.code === 'direction_pivot_intake')!
      expect(first.getProject(project.project_id)).toEqual(authorityBefore)
      expect(first.listGates(project.project_id)).toHaveLength(1)
      first.close()

      const reopened = new ResearchKernel(options)
      try {
        expect(reopened.projectProjection(project.project_id).next_actions_v2
          .find(item => item.code === 'direction_pivot_intake')).toEqual(continuation)
        expect(reopened.getProject(project.project_id)).toEqual(authorityBefore)
        expect(reopened.listGates(project.project_id)).toHaveLength(1)
      } finally {
        reopened.close()
      }
    } finally {
      try { first.close() } catch { /* already closed */ }
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('reads the persisted Methodology stream into the authoritative Direction overlay', () => {
    const { kernel, dir } = freshKernel()
    try {
      const project = kernel.createProject({
        name: 'direction overlay', workspace: '/research/direction-overlay',
        brief: { problem: 'p', scope: 's', questions: [], primary_metrics: ['m'], resources: '', risks: [], target_outputs: ['paper'], target_venue: null, baseline_repo: null, domain: 'ml' },
      })
      const before = kernel.projectProjection(project.project_id)
      const revision = before.next_actions_v2.find(item => item.state === 'ready')!.revision!
      const methodology = methodologyOverlay('pivot', {
        project_revision: project.revision, next_action_revision: revision,
      }, [], project.project_id)
      kernel.methodology.recordResearchSynthesis({ record: methodology.syntheses[0]!, expected_revision: 0 })
      kernel.methodology.recordDirectionProposal({ record: methodology.proposals[0]!, expected_revision: 1 })
      const exactGate = kernel.createGate({
        project_id: project.project_id, type: 'direction', title: 'Pivot review',
        payload: {
          purpose: 'direction_adoption', proposal_id: 'direction_next_action_1',
          source_synthesis_id: 'synth_next_action_1', direction: 'pivot',
        },
      })

      expect(kernel.projectProjection(project.project_id).next_actions_v2)
        .toContainEqual(expect.objectContaining({
          code: 'direction_gate_review', state: 'ready',
          refs: expect.arrayContaining([{ kind: 'gate', id: exactGate.gate_id }]),
        }))
    } finally {
      kernel.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('DRAFT projects expose only structured scope_gate_submit', () => {
    const { kernel, dir } = freshKernel()
    try {
      const out = kernel.createProjectWithInitialGate({
        name: 'na', workspace: '/research/na',
        brief: { problem: 'p', scope: 's', questions: [], primary_metrics: ['m'], resources: '', risks: [], target_outputs: ['paper'], target_venue: null, baseline_repo: null, domain: 'ml' },
        idempotency_key: 'k1', request_hash: 'h1',
      })
      const projection = kernel.projectProjection(out.project.project_id)
      expect(projection.next_actions_v2.length).toBeGreaterThanOrEqual(1)
      expect(projection.next_actions_v2[0]?.code).toBe('scope_gate_submit')
      expect(projection.next_actions_v2[0]?.state).toBe('ready')
      expect(projection.next_actions_v2[0]?.route).toBe('gates')
      // No duplicate gate_decide for the initial scope gate.
      expect(projection.next_actions_v2.filter(a => a.code === 'gate_decide')).toHaveLength(0)
      expect(projection).not.toHaveProperty('next_actions')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('scope approval moves to SCOPED → survey_run; budget exhaustion blocks with budget_resolve', () => {
    const { kernel, dir } = freshKernel()
    try {
      const out = kernel.createProjectWithInitialGate({
        name: 'na', workspace: '/research/na',
        brief: { problem: 'p', scope: 's', questions: [], primary_metrics: ['m'], resources: '', risks: [], target_outputs: ['paper'], target_venue: null, baseline_repo: null, domain: 'ml' },
        idempotency_key: 'k2', request_hash: 'h2',
      })
      const projectId = out.project.project_id
      kernel.decideGate({ gate_id: out.gate.gate_id, actor: 'human-1', principal: { principal_id: 'human-1' }, decision: 'approved' })

      const scoped = kernel.projectProjection(projectId)
      expect(scoped.project.status).toBe('SCOPED')
      expect(scoped.next_actions_v2[0]?.code).toBe('survey_run')
      expect(scoped.next_actions_v2[0]?.route).toBe('chat')
      expect(scoped.next_actions_v2[0]?.required_by).toBe('agent')
      expect(scoped).not.toHaveProperty('next_actions')

      // Exceed the budget → BLOCKED_GATE + pending Budget Gate.
      kernel.recordUsage(projectId, { model_cost_usd: 300 })
      const blocked = kernel.projectProjection(projectId)
      expect(blocked.project.status).toBe('BLOCKED_GATE')
      const resolve = blocked.next_actions_v2.find(a => a.code === 'budget_resolve')
      expect(resolve).toBeDefined()
      expect(resolve?.state).toBe('blocked')
      expect(resolve?.required).toEqual(['budget_headroom'])
      expect(blocked.next_actions_v2.some(a => a.code === 'gate_resolve')).toBe(true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('an empty frozen survey advances SCOPED atomically but projects a repair survey instead of executable ideas', () => {
    const { kernel, dir } = freshKernel()
    try {
      const out = kernel.createProjectWithInitialGate({
        name: 'survey-flow', workspace: '/research/survey-flow',
        brief: { problem: 'object recognition', scope: 's', questions: [], primary_metrics: ['m'], resources: '', risks: [], target_outputs: ['paper'], target_venue: null, baseline_repo: null, domain: 'ml' },
        idempotency_key: 'survey-flow', request_hash: 'survey-flow',
      })
      const projectId = out.project.project_id
      kernel.decideGate({ gate_id: out.gate.gate_id, actor: 'human-1', principal: { principal_id: 'human-1' }, decision: 'approved' })
      const before = kernel.getProject(projectId)

      kernel.snapshotCorpus({
        project_id: projectId,
        queries: [{ source: 'openalex', query: 'object recognition', run_at: '2026-08-12T00:00:00.000Z' }],
        papers: [],
        source_status: 'complete',
      })

      const projection = kernel.projectProjection(projectId)
      expect(projection.project.status).toBe('SURVEYING')
      expect(projection.project.revision).toBe(before.revision + 1)
      expect(projection.next_actions_v2[0]?.code).toBe('idea_generate')
      expect(projection.next_actions_v2[0]?.state).toBe('blocked')
      expect(projection.next_actions_v2[0]?.required).toEqual(['frozen_nonempty_corpus_snapshot'])
      expect(projection.next_actions_v2).toContainEqual(expect.objectContaining({ code: 'survey_run', state: 'ready' }))
    } finally {
      kernel.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('an active intake session projects intake_* guidance in the projection', () => {
    const { kernel, dir } = freshKernel()
    try {
      const out = kernel.createProjectWithInitialGate({
        name: 'na', workspace: '/research/na',
        brief: { problem: 'p', scope: 's', questions: [], primary_metrics: ['m'], resources: '', risks: [], target_outputs: ['paper'], target_venue: null, baseline_repo: null, domain: 'ml' },
        idempotency_key: 'k3', request_hash: 'h3',
      })
      const projectId = out.project.project_id
      const session = kernel.beginIntake({
        project_id: projectId, source_label: 'uploaded-paper', target_phase: 'experiment',
        owner: { principal_id: 'human-1', auth_method: 'dsh-session' },
      })
      // draft → intake_resume
      let projection = kernel.projectProjection(projectId)
      expect(projection.next_actions_v2.find(a => a.code === 'intake_resume')).toBeDefined()
      expect(projection.next_actions_v2.find(a => a.code === 'intake_resume')?.refs)
        .toContainEqual({ kind: 'intake', id: session.intake_id })
      // stage a file → uploading → intake_resume + intake_scan
      kernel.stageIntakeArtifact(session.intake_id, { file_name: 'paper.txt', content: 'hello world' })
      projection = kernel.projectProjection(projectId)
      expect(projection.next_actions_v2.filter(a => a.code.startsWith('intake_')).map(a => a.code))
        .toEqual(['intake_resume', 'intake_scan'])
      // scan → needs_input (required questions unanswered) → intake_answer
      kernel.scanIntake(session.intake_id)
      projection = kernel.projectProjection(projectId)
      expect(projection.next_actions_v2.filter(a => a.code.startsWith('intake_')).map(a => a.code))
        .toEqual(['intake_resume', 'intake_answer'])
      expect(projection).not.toHaveProperty('next_actions')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
