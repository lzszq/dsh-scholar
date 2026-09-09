import { describe, expect, it } from 'vitest'
import { GateDraftStore } from '../../packages/dsh-research-ui/src/client/gate-drafts'
import { artifactListPage } from '../../packages/dsh-research-ui/src/client/artifact-list-model'
import { artifactPreviewPlan } from '../../packages/dsh-research-ui/src/client/artifact-preview-model'
import { manuscriptFailureModel } from '../../packages/dsh-research-ui/src/client/manuscript-flow'
import { nextActionCardModel, prioritizeNextActions } from '../../packages/dsh-research-ui/src/client/next-action-cards'
import { retryableJobIds, runMatchesFilter, runTimeoutSeconds } from '../../packages/dsh-research-ui/src/client/runs-model'
import { analysisRunReferences, analysisSummary, resolveResearchRun } from '../../packages/dsh-research-ui/src/client/research-links'
import { releaseBuildState } from '../../packages/dsh-research-ui/src/client/release-review-model'
import type { ArtifactRow, ManuscriptBuild, NextActionV2, Projection } from '../../packages/dsh-research-ui/src/client/types'

describe('Approval drafts survive refresh and navigation', () => {
  it('keeps text, whitespace and expansion for each project and gate, including a new view instance', () => {
    const entries = new Map<string, string>()
    const storage = { getItem: (key: string) => entries.get(key) ?? null, setItem: (key: string, value: string) => { entries.set(key, value) }, removeItem: (key: string) => { entries.delete(key) } }
    const drafts = new GateDraftStore(storage)
    drafts.update('cnn', 'release', { reason: '  体验评估草稿（未提交）  ', open: true })
    drafts.update('cnn', 'release', { open: false })
    const restored = new GateDraftStore(storage)
    expect(restored.get('cnn', 'release')).toEqual({ reason: '  体验评估草稿（未提交）  ', open: false })
    restored.update('cnn', 'release', { open: true })
    expect(restored.get('cnn', 'release').reason).toBe('  体验评估草稿（未提交）  ')
    expect(restored.get('other-project', 'release').reason).toBe('')
    expect(restored.get('cnn', 'contract').reason).toBe('')
    const copy = restored.get('cnn', 'release')
    copy.reason = 'mutated by a caller'
    expect(restored.get('cnn', 'release').reason).not.toBe(copy.reason)
    restored.clear('cnn', 'release')
    expect(new GateDraftStore(storage).get('cnn', 'release')).toEqual({ reason: '', open: false })
  })

  it('preserves live input when browser storage is unavailable', () => {
    const storage = { getItem: () => { throw new Error('blocked') }, setItem: () => { throw new Error('full') }, removeItem: () => { throw new Error('blocked') } }
    const drafts = new GateDraftStore(storage)
    drafts.update('cnn', 'gate', { reason: 'keep me', open: true })
    expect(drafts.get('cnn', 'gate')).toEqual({ reason: 'keep me', open: true })
    drafts.clear('cnn', 'gate')
    expect(drafts.get('cnn', 'gate').reason).toBe('')
  })
})

describe('Complete artifact search precedes pagination', () => {
  const artifacts: ArtifactRow[] = [
    { artifact_id: 'old-code', kind: 'code', file_name: 'cnn-training.py' },
    ...Array.from({ length: 21 }, (_, index) => ({ artifact_id: `analysis-${index}`, kind: 'analysis' })),
  ]
  it('finds the old code in the 22-artifact CNN catalog', () => {
    expect(artifactListPage(artifacts, 'code', '', 15)).toEqual({ rows: [artifacts[0]], total: 1, hasMore: false })
    expect(artifactListPage(artifacts, 'all', 'CNN-TRAINING', 15).rows).toEqual([artifacts[0]])
    expect(artifactListPage(artifacts, 'all', 'old-code', 15).rows).toEqual([artifacts[0]])
  })
  it('can reveal the full catalog without changing filter counts or input order', () => {
    expect(artifactListPage(artifacts, 'all', '', 15)).toMatchObject({ total: 22, hasMore: true })
    const complete = artifactListPage(artifacts, 'all', '', 30)
    expect(complete.rows).toHaveLength(22)
    expect(complete.rows.at(-1)?.artifact_id).toBe('old-code')
    expect(complete.hasMore).toBe(false)
    expect(artifacts[0]?.artifact_id).toBe('old-code')
  })
})

describe('Manuscript failures preserve the actual recovery cause', () => {
  it.each(['document_version_conflict', 'workspace_version_conflict'])('offers reload for %s', code => {
    expect(manuscriptFailureModel({ code }, 409)).toEqual({ key: 'manuscript.failure.conflict', recovery: 'reload' })
  })
  it.each([
    ['runner_profile_required', 422, 'runner', 'settings'],
    ['runner_target_offline', 409, 'runner', 'settings'],
    ['forbidden', 403, 'access', 'settings'],
    ['unauthorized', 401, 'access', 'settings'],
    ['network_error', 0, 'network', 'retry'],
    ['internal_error', 500, 'other', 'retry'],
    ['budget_exhausted', 409, 'other', 'retry'],
  ])('does not turn %s into a version conflict', (code, status, key, recovery) => {
    expect(manuscriptFailureModel({ code: String(code) }, Number(status))).toEqual({ key: `manuscript.failure.${key}`, recovery })
  })
})

describe('Overview and Runs share retry authority', () => {
  const retry: NextActionV2 = { code: 'job_retry', label: 'Retry failed job', state: 'ready', route: 'runs', required: true, refs: [{ kind: 'job', id: 'failed-job' }] }
  const projection: Projection = { jobs: [{ job_id: 'failed-job', status: 'failed' }, { job_id: 'ok-job', status: 'succeeded' }], next_actions_v2: [retry] }
  it('includes the failed job and routes directly to its details', () => {
    const ids = retryableJobIds(projection)
    expect(projection.jobs?.filter(job => runMatchesFilter(job, 'retryable', ids))).toEqual([{ job_id: 'failed-job', status: 'failed' }])
    expect(nextActionCardModel(retry).jobId).toBe('failed-job')
    expect(nextActionCardModel(retry).commandDraft).toBeNull()
    expect(retryableJobIds({ ...projection, next_actions_v2: [{ ...retry, state: 'blocked', required: ['budget_available'] }] }).size).toBe(0)
  })
  it('explains the observed timeout and prioritizes the blocking release action', () => {
    expect(runTimeoutSeconds('job timed out: timed out after 60000ms')).toBe(60)
    expect(runTimeoutSeconds('resource error 500')).toBeNull()
    const release: NextActionV2 = { code: 'release_gate', label: 'Release', state: 'ready', route: 'gates', required: true, blocking: true }
    const list = [retry, release]
    expect(prioritizeNextActions(list)).toEqual([release, retry])
    expect(list).toEqual([retry, release])
  })
})

describe('Research provenance and safe chart data', () => {
  it('resolves recorded job/manifest/artifact references without guessing seed aliases', () => {
    const jobs = [{ job_id: 'job-11', run_manifest: { run_id: 'run-actual-11' } }, { job_id: 'job-23' }]
    const artifacts = [{ metadata: { run_id: 'legacy-23', job_id: 'job-23' } }]
    expect(resolveResearchRun('job-11', jobs, artifacts)).toBe('job-11')
    expect(resolveResearchRun('run-actual-11', jobs, artifacts)).toBe('job-11')
    expect(resolveResearchRun('legacy-23', jobs, artifacts)).toBe('job-23')
    expect(resolveResearchRun('formal:cnn:11', jobs, artifacts)).toBeNull()
    expect(resolveResearchRun('legacy-23', jobs, [...artifacts, { metadata: { run_id: 'legacy-23', job_id: 'job-11' } }])).toBeNull()
  })
  it('renders only valid project-scoped numerical analysis', () => {
    const data = { project_id: 'cnn', analysis: { metric: 'test_accuracy', baseline_value: 92.4, mean: 96.8, effect_size: 4.4, ci_low: 1.2, ci_high: 8.6, n: 3 } }
    expect(analysisSummary(data, 'cnn')).toEqual({ metric: 'test_accuracy', baseline: 92.4, candidate: 96.8, effect: 4.4, low: 1.2, high: 8.6, n: 3 })
    expect(analysisSummary(data, 'other-project')).toBeNull()
    expect(analysisSummary({ ...data, analysis: { ...data.analysis, mean: Infinity } }, 'cnn')).toBeNull()
    expect(analysisSummary('<svg onload="alert(1)">', 'cnn')).toBeNull()
    const included = { ...data, analysis: { ...data.analysis, runs: [{ run_id: 'run-actual', job_id: 'job-actual', seed: 23 }] } }
    expect(analysisRunReferences(included, 'cnn')).toEqual([{ runId: 'run-actual', jobId: 'job-actual', seed: 23 }])
    expect(analysisRunReferences(included, 'other-project')).toEqual([])
  })
  it('reads old analysis/bundle JSON as inert text while keeping SVG download-only', () => {
    expect(artifactPreviewPlan({ kind: 'analysis', metadata: { generated_by: 'research-kernel.computeAnalysis' } }, 'application/octet-stream').mode).toBe('json')
    expect(artifactPreviewPlan({ kind: 'bundle', metadata: { kind: 'release-bundle' } }, 'application/octet-stream').mode).toBe('json')
    expect(artifactPreviewPlan({ kind: 'chart', media_type: 'image/svg+xml' }).mode).toBe('download')
    expect(artifactPreviewPlan({ kind: 'analysis', file_name: 'unsafe.svg', metadata: { generated_by: 'research-kernel.computeAnalysis' } }, 'application/octet-stream').mode).toBe('download')
  })
})

describe('Release review never advertises an outdated PDF as current', () => {
  const build = (overrides: Partial<ManuscriptBuild> = {}): ManuscriptBuild => ({ build_id: 'build', revision: 3, status: 'succeeded', root_file: 'paper.tex', job_id: 'job', pdf_artifact: 'pdf', log_artifact: null, diagnostics: '[]', ...overrides })
  it('distinguishes missing, in-progress, failed, stale and current builds', () => {
    expect(releaseBuildState(3, [])).toBe('missing')
    expect(releaseBuildState(3, [build({ preview: true })])).toBe('missing')
    expect(releaseBuildState(3, [build({ status: 'running' }), build()])).toBe('pending')
    expect(releaseBuildState(3, [build({ pdf_artifact: null }), build()])).toBe('failed')
    expect(releaseBuildState(4, [build()])).toBe('stale')
    expect(releaseBuildState(3, [build()])).toBe('ready')
  })
})
