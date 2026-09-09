import type { ManuscriptBuild } from './types'

/** A PDF is reviewable only when the latest authoritative build matches the document. */
export function releaseBuildState(revision: number, builds: ManuscriptBuild[]): 'missing' | 'pending' | 'failed' | 'stale' | 'ready' {
  const latest = builds.find(build => build.preview !== true)
  if (latest === undefined) return 'missing'
  if (latest.status === 'queued' || latest.status === 'running') return 'pending'
  if (latest.status !== 'succeeded' || !latest.pdf_artifact) return 'failed'
  return latest.revision === revision ? 'ready' : 'stale'
}
