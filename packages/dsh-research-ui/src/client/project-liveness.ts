/**
 * Decide whether a selected project is authoritatively unavailable.
 * Destructive browser cleanup requires both a successful project-list read
 * and a 404 for the selected projection; transient failures preserve local
 * transcripts and upload recovery metadata.
 */
export function projectIsAuthoritativelyGone(
  projectId: string,
  projectListAvailable: boolean,
  projects: ReadonlyArray<{ project_id?: string }>,
  projectionStatus: number,
): boolean {
  return projectListAvailable
    && projectionStatus === 404
    && !projects.some(project => project.project_id === projectId)
}

/** An async render may commit only while its frozen project target remains
 * selected. A newer user selection owns the next queued render. */
export function projectRenderTargetIsCurrent(
  frozenProjectId: string,
  currentProjectId: string | undefined,
): boolean {
  return currentProjectId === frozenProjectId
}

/** Background scopes absent from a successful authoritative list require an
 * individual 404 probe before destructive cleanup. */
export function backgroundProjectScopesToProbe(
  trackedProjectIds: readonly string[],
  selectedProjectId: string | undefined,
  projects: ReadonlyArray<{ project_id?: string }>,
): string[] {
  const listed = new Set(projects.map(project => project.project_id))
  return [...new Set(trackedProjectIds)].filter(
    projectId => projectId !== selectedProjectId && !listed.has(projectId),
  )
}
