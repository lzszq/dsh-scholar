import { authHeaders, base } from './api'
import { artifactContentPath } from './artifact-transfer'
import { readArtifactTextStream } from './artifact-preview-model'

/** Project-scoped, size-bounded JSON reads for research summaries. */
export async function readResearchArtifact(projectId: string, artifactId: string, signal?: AbortSignal): Promise<unknown> {
  if (!/^sha256:[a-f0-9]{64}$/.test(artifactId)) return null
  try {
    const response = await fetch(`${base()}${artifactContentPath(projectId, artifactId)}`, {
      signal, headers: { accept: 'application/json', ...(await authHeaders()) },
    })
    if (!response.ok) { void response.body?.cancel().catch(() => {}); return null }
    const content = await readArtifactTextStream(response.body, signal)
    if (signal?.aborted || content.tooLarge || content.binary || content.truncated) return null
    return JSON.parse(content.text) as unknown
  } catch { return null }
}
