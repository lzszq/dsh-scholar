import type { ArtifactRow } from './types'

export interface ResearchJobLink {
  job_id?: string
  run_manifest?: { run_id?: string } | null
  payload?: { run_id?: string } | null
}

/** Resolve only recorded identifiers. Similar names or seed suffixes are not provenance. */
export function resolveResearchRun(reference: string, jobs: ResearchJobLink[], artifacts: ArtifactRow[]): string | null {
  const exactJob = jobs.find(job => job.job_id === reference)
  if (exactJob?.job_id) return exactJob.job_id
  const direct = new Set(jobs.filter(job => job.run_manifest?.run_id === reference || job.payload?.run_id === reference)
    .flatMap(job => job.job_id ? [job.job_id] : []))
  if (direct.size > 0) return direct.size === 1 ? [...direct][0]! : null
  const candidates = new Set(artifacts.filter(artifact => artifact.metadata?.run_id === reference)
    .map(artifact => artifact.metadata?.job_id).filter((id): id is string => typeof id === 'string' && jobs.some(job => job.job_id === id)))
  return candidates.size === 1 ? [...candidates][0]! : null
}

export interface AnalysisSummary {
  metric: string; baseline: number; candidate: number; effect: number; low: number; high: number; n: number
}

export interface AnalysisRunReference { jobId: string; runId: string; seed: number | null }

/** Immutable analysis files preserve the actual jobs included in the result. */
export function analysisRunReferences(value: unknown, projectId: string): AnalysisRunReference[] {
  if (analysisSummary(value, projectId) === null) return []
  const runs = (value as { analysis: { runs?: unknown } }).analysis.runs
  if (!Array.isArray(runs)) return []
  return runs.slice(0, 500).flatMap((run: unknown) => {
    if (typeof run !== 'object' || run === null) return []
    const record = run as Record<string, unknown>
    if (typeof record.job_id !== 'string' || typeof record.run_id !== 'string' || !record.job_id || !record.run_id) return []
    return [{ jobId: record.job_id, runId: record.run_id, seed: typeof record.seed === 'number' && Number.isSafeInteger(record.seed) ? record.seed : null }]
  })
}

/** The chart fallback is an inert data table, never an SVG/HTML injection. */
export function analysisSummary(value: unknown, projectId: string): AnalysisSummary | null {
  if (typeof value !== 'object' || value === null) return null
  const record = value as Record<string, unknown>
  if (record.project_id !== projectId || typeof record.analysis !== 'object' || record.analysis === null) return null
  const a = record.analysis as Record<string, unknown>
  if (typeof a.metric !== 'string' || a.metric.length > 200) return null
  if (![a.baseline_value, a.mean, a.effect_size, a.ci_low, a.ci_high, a.n].every(value => typeof value === 'number' && Number.isFinite(value))) return null
  if (!Number.isInteger(a.n) || (a.n as number) < 1 || (a.ci_low as number) > (a.ci_high as number)) return null
  return { metric: a.metric, baseline: a.baseline_value as number, candidate: a.mean as number, effect: a.effect_size as number,
    low: a.ci_low as number, high: a.ci_high as number, n: a.n as number }
}
