import { t } from './i18n/index'
import type { Projection } from './types'

/** Retry availability comes from the same authority as Overview actions. */
export function retryableJobIds(p: Pick<Projection, 'jobs' | 'next_actions_v2'>): Set<string> {
  const ids = new Set((p.jobs ?? []).filter(job => job.status === 'retryable').flatMap(job => job.job_id ? [job.job_id] : []))
  for (const action of p.next_actions_v2 ?? []) {
    if (action.code !== 'job_retry' || action.state !== 'ready' || (Array.isArray(action.required) && action.required.length > 0)) continue
    for (const ref of action.refs ?? []) if (ref?.kind === 'job' && ref.id) ids.add(ref.id)
  }
  return ids
}

export function runMatchesFilter(job: NonNullable<Projection['jobs']>[number], filter: string, retryable: ReadonlySet<string>): boolean {
  return filter === 'all' || (filter === 'retryable' ? retryable.has(job.job_id ?? '') : job.status === filter)
}

export function runTimeoutSeconds(error: unknown): number | null {
  if (typeof error !== 'string') return null
  const match = /(?:timeout|timed out)[^\d]{0,30}(\d+)\s*ms/i.exec(error)
  return match === null ? null : Number(match[1]) / 1000
}

export type RunsEmptyStateKind = 'survey-ready' | 'baseline-setup' | 'empty' | 'no-match'

export interface RunsEmptyStateModel {
  kind: RunsEmptyStateKind
  showOverviewCta: boolean
}

const RUN_FILTER_KEYS = ['all', 'queued', 'running', 'retryable', 'succeeded', 'failed', 'cancelled'] as const

/** Resolve labels at render time so an open Runs panel follows locale changes. */
export function runsFilterDefinitions(): Array<[string, string]> {
  return RUN_FILTER_KEYS.map(key => [key, t('runs', `runs.filter.${key}`)])
}

/** Pure empty-state contract: research phases are not fabricated as Jobs. */
export function runsEmptyStateModel(
  projectStatus: string | undefined,
  corpusSnapshotCount: number,
  hasIdeaGenerateAction: boolean,
  hasBaselineReproduceAction: boolean,
  allJobsCount: number,
  visibleJobsCount: number,
): RunsEmptyStateModel | null {
  if (visibleJobsCount > 0) return null
  if (allJobsCount > 0) return { kind: 'no-match', showOverviewCta: false }
  if (projectStatus === 'CONTRACT_APPROVED' && hasBaselineReproduceAction) {
    return { kind: 'baseline-setup', showOverviewCta: false }
  }
  if (projectStatus === 'SURVEYING' && corpusSnapshotCount > 0 && hasIdeaGenerateAction) {
    return { kind: 'survey-ready', showOverviewCta: true }
  }
  return { kind: 'empty', showOverviewCta: false }
}
