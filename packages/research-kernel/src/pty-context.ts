/**
 * Trusted PTY context resolution.
 *
 * Browser requests name an opaque context id. The HTTP/BFF layer resolves
 * that id through authoritative Research session / Chat / topology stores
 * and passes the resulting source record here. This module deliberately has
 * no "project context" fallback: an unavailable or incompatible configured
 * target is an error, including remote SSH targets.
 */

import type { PtyContext, PtyContextKind } from '@dsh-scholar/research-schemas'

export type PtyTargetKind = 'local-process' | 'local-docker' | 'remote-ssh'

/** Server-owned source record. No value in this object may originate from a
 * browser request body except the lookup key used to find it. */
export interface PtyContextAuthoritySource {
  context_kind: PtyContextKind
  context_id: string
  project_id: string
  owner_principal_id: string
  tenant_id?: string
  parent_session_id: string | null
  runner_profile_id: string
  runner_target_id: string
  target_kind: PtyTargetKind
  target_available: boolean
  target_supports_pty: boolean
}

/** Immutable authority consumed by the PTY store and adapter planner. */
export interface PtyResolvedContext {
  context_kind: PtyContextKind
  context_id: string
  project_id: string
  principal_id: string
  tenant_id: string
  parent_session_id: string | null
  profile: string
  target: string
  target_kind: PtyTargetKind
}

export class PtyContextError extends Error {
  readonly code: string

  constructor(code: string, message: string) {
    super(message)
    this.name = 'PtyContextError'
    this.code = code
  }
}

/** Resolve one exact context. Unknown/mismatched ids, unavailable targets and
 * targets without PTY capability all fail closed; no local default exists. */
export function resolvePtyContext(contextId: string, source: PtyContextAuthoritySource): PtyResolvedContext {
  if (contextId === '' || source.context_id !== contextId) {
    throw new PtyContextError('pty_context_not_found', 'PTY context is unknown or no longer available')
  }
  if (!source.target_available) {
    throw new PtyContextError('pty_target_unavailable', `PTY target ${source.runner_target_id} is unavailable`)
  }
  if (!source.target_supports_pty) {
    throw new PtyContextError('pty_target_unsupported', `PTY target ${source.runner_target_id} does not support interactive terminals`)
  }
  return {
    context_kind: source.context_kind,
    context_id: source.context_id,
    project_id: source.project_id,
    principal_id: source.owner_principal_id,
    tenant_id: source.tenant_id ?? '',
    parent_session_id: source.parent_session_id,
    profile: source.runner_profile_id,
    target: source.runner_target_id,
    target_kind: source.target_kind,
  }
}

/** Safe browser projection. Owner and tenant identity never leave the
 * server authority boundary. */
export function projectPtyContext(context: PtyResolvedContext): PtyContext {
  return {
    context_kind: context.context_kind,
    context_id: context.context_id,
    project_id: context.project_id,
    parent_session_id: context.parent_session_id,
    runner_profile_id: context.profile,
    runner_target_id: context.target,
    target_kind: context.target_kind,
  }
}
