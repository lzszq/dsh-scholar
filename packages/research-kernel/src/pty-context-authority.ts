/**
 * Server-side PTY context authority.
 *
 * A browser may name only an opaque context id that it previously obtained
 * from the context projection.  This module resolves that id from durable
 * project membership, DSH session links and exact-parent child topology.
 * It never accepts project, principal, parent, profile or target values from
 * a request body and it deliberately does not infer ownership for old
 * session_links rows whose principal is NULL.
 */

import { createHash } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import type { ResearchProject, RunnerTargetDescriptor } from '@dsh-scholar/research-schemas'
import {
  PtyContextError,
  projectPtyContext,
  resolvePtyContext,
  type PtyResolvedContext,
} from './pty-context.js'

interface SessionLinkAuthorityRow {
  session_id: string
  project_id: string
  principal_id: string | null
  tenant_id: string | null
}

interface ChildAuthorityRow {
  child_id: string
  project_id: string
  parent_id: string | null
}

export interface PtyContextAuthorityDeps {
  getProject(projectId: string): ResearchProject
  getProjectMember(projectId: string, principalId: string): { tenant_id: string } | null
  getRunnerTarget(targetId: string): RunnerTargetDescriptor | null
  activeAdapterId(): string | null
}

/** Principal-scoped and opaque: two members of the same project never share
 * a Research context or see one another's terminal tabs. */
export function researchPtyContextId(projectId: string, principalId: string): string {
  const ownerHash = createHash('sha256').update(principalId, 'utf8').digest('hex').slice(0, 24)
  return `research:${projectId}:${ownerHash}`
}

function adapterIdForTarget(kind: RunnerTargetDescriptor['kind']): string {
  if (kind === 'local-process') return 'local-pty'
  if (kind === 'local-docker') return 'local-docker'
  return 'remote-runner'
}

export class PtyContextAuthority {
  constructor(
    private readonly db: DatabaseSync,
    private readonly deps: PtyContextAuthorityDeps,
  ) {}

  /** Safe context projection for one current project member. */
  list(projectId: string, principalId: string): ReturnType<typeof projectPtyContext>[] {
    const member = this.requireMember(projectId, principalId)
    const contexts: PtyResolvedContext[] = [this.build({
      context_kind: 'research',
      context_id: researchPtyContextId(projectId, principalId),
      project_id: projectId,
      principal_id: principalId,
      tenant_id: member.tenant_id,
      parent_session_id: null,
    })]

    const links = this.sessionLinksForProject(projectId)
      .filter(link => link.principal_id === principalId)
      .sort((a, b) => a.session_id.localeCompare(b.session_id))
    for (const link of links) {
      contexts.push(this.build({
        context_kind: 'chat',
        context_id: link.session_id,
        project_id: projectId,
        principal_id: principalId,
        tenant_id: link.tenant_id ?? '',
        parent_session_id: null,
      }))
    }

    const children = this.childrenForProject(projectId)
    const childById = new Map(children.map(child => [child.child_id, child]))
    const linkById = new Map(links.map(link => [link.session_id, link]))
    for (const child of children.sort((a, b) => a.child_id.localeCompare(b.child_id))) {
      const root = this.findRootLink(child, childById, linkById)
      if (root === null) continue
      contexts.push(this.build({
        context_kind: 'subagent',
        context_id: child.child_id,
        project_id: projectId,
        principal_id: principalId,
        tenant_id: root.tenant_id ?? '',
        parent_session_id: child.parent_id,
      }))
    }
    return contexts.map(projectPtyContext)
  }

  /** Resolve an exact context for every open/read/control/list operation. */
  resolve(contextId: string, principalId: string): PtyResolvedContext {
    const research = /^research:(rsp_[a-z0-9_]+):([0-9a-f]{24})$/.exec(contextId)
    if (research !== null) {
      const projectId = research[1]!
      const expected = researchPtyContextId(projectId, principalId)
      if (expected !== contextId) throw this.notFound()
      const member = this.requireMember(projectId, principalId)
      return this.build({
        context_kind: 'research', context_id: contextId, project_id: projectId,
        principal_id: principalId, tenant_id: member.tenant_id, parent_session_id: null,
      })
    }

    const link = this.db.prepare(`SELECT session_id, project_id, principal_id, tenant_id
      FROM session_links WHERE session_id = ?`).get(contextId) as SessionLinkAuthorityRow | undefined
    const child = this.db.prepare('SELECT child_id, project_id, parent_id FROM child_links WHERE child_id = ?')
      .get(contextId) as ChildAuthorityRow | undefined
    if (link !== undefined && child !== undefined) {
      throw new PtyContextError('pty_context_ambiguous', 'PTY context id resolves to more than one authority record')
    }
    if (link !== undefined) {
      if (link.principal_id === null || link.principal_id !== principalId) throw this.notFound()
      this.requireMember(link.project_id, principalId)
      return this.build({
        context_kind: 'chat', context_id: link.session_id, project_id: link.project_id,
        principal_id: principalId, tenant_id: link.tenant_id ?? '', parent_session_id: null,
      })
    }
    if (child !== undefined) {
      this.requireMember(child.project_id, principalId)
      const children = this.childrenForProject(child.project_id)
      const links = this.sessionLinksForProject(child.project_id)
        .filter(candidate => candidate.principal_id === principalId)
      const root = this.findRootLink(
        child,
        new Map(children.map(candidate => [candidate.child_id, candidate])),
        new Map(links.map(candidate => [candidate.session_id, candidate])),
      )
      if (root === null) throw this.notFound()
      return this.build({
        context_kind: 'subagent', context_id: child.child_id, project_id: child.project_id,
        principal_id: principalId, tenant_id: root.tenant_id ?? '', parent_session_id: child.parent_id,
      })
    }
    throw this.notFound()
  }

  private requireMember(projectId: string, principalId: string): { tenant_id: string } {
    const member = this.deps.getProjectMember(projectId, principalId)
    if (member === null) throw this.notFound()
    return member
  }

  private build(base: {
    context_kind: PtyResolvedContext['context_kind']
    context_id: string
    project_id: string
    principal_id: string
    tenant_id: string
    parent_session_id: string | null
  }): PtyResolvedContext {
    const project = this.deps.getProject(base.project_id)
    const profile = project.execution.runner_profile_id
    if (profile === null) {
      throw new PtyContextError('pty_profile_unconfigured', 'configure a Runner profile before opening an interactive terminal')
    }
    const target = this.deps.getRunnerTarget(project.execution.runner_target_id)
    if (target === null) throw new PtyContextError('pty_target_unavailable', 'the configured PTY target no longer exists')
    const adapterId = this.deps.activeAdapterId()
    return resolvePtyContext(base.context_id, {
      context_kind: base.context_kind,
      context_id: base.context_id,
      project_id: base.project_id,
      owner_principal_id: base.principal_id,
      tenant_id: base.tenant_id,
      parent_session_id: base.parent_session_id,
      runner_profile_id: profile,
      runner_target_id: target.target_id,
      target_kind: target.kind,
      target_available: target.enabled && !target.draining && (target.kind !== 'remote-ssh' || target.health === 'online'),
      target_supports_pty: adapterId !== null && adapterId === adapterIdForTarget(target.kind),
    })
  }

  private sessionLinksForProject(projectId: string): SessionLinkAuthorityRow[] {
    return this.db.prepare(`SELECT session_id, project_id, principal_id, tenant_id
      FROM session_links WHERE project_id = ?`).all(projectId) as unknown as SessionLinkAuthorityRow[]
  }

  private childrenForProject(projectId: string): ChildAuthorityRow[] {
    return this.db.prepare('SELECT child_id, project_id, parent_id FROM child_links WHERE project_id = ?')
      .all(projectId) as unknown as ChildAuthorityRow[]
  }

  /** Follow exact parent links until a durable same-project DSH Chat root is
   * reached. Orphans and cycles have no PTY authority. */
  private findRootLink(
    child: ChildAuthorityRow,
    childById: Map<string, ChildAuthorityRow>,
    linkById: Map<string, SessionLinkAuthorityRow>,
  ): SessionLinkAuthorityRow | null {
    const visited = new Set<string>([child.child_id])
    let parent = child.parent_id
    while (parent !== null) {
      const root = linkById.get(parent)
      if (root !== undefined && root.project_id === child.project_id && root.principal_id !== null) return root
      const ancestor = childById.get(parent)
      if (ancestor === undefined || ancestor.project_id !== child.project_id || visited.has(ancestor.child_id)) return null
      visited.add(ancestor.child_id)
      parent = ancestor.parent_id
    }
    return null
  }

  private notFound(): PtyContextError {
    return new PtyContextError('pty_context_not_found', 'PTY context is unknown or access was revoked')
  }
}
