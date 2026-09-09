import type { ArtifactRow } from './types'

/** Filter the complete catalog before limiting rendered rows. */
export function artifactListPage(artifacts: ArtifactRow[], kind: string, query: string, limit: number): {
  rows: ArtifactRow[]; total: number; hasMore: boolean
} {
  const q = query.trim().toLowerCase()
  const matches = artifacts.filter(artifact => {
    if (kind !== 'all' && artifact.kind !== kind) return false
    return q === '' || [artifact.kind, artifact.artifact_id, artifact.file_name, artifact.metadata?.kind, artifact.metadata?.name,
      artifact.metadata?.file_name, artifact.metadata?.job_id, artifact.metadata?.run_id, artifact.metadata?.metric]
      .some(value => typeof value === 'string' && value.toLowerCase().includes(q))
  }).reverse()
  const rows = matches.slice(0, Math.max(1, limit))
  return { rows, total: matches.length, hasMore: rows.length < matches.length }
}
