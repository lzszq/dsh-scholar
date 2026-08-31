import type { RunnerTargetKindLite, RunnerTargetRuntimeLite, SecretRefViewLite } from './types'

export const DEFAULT_DOCKER_IMAGE_DIGEST = 'node@sha256:c610fcdfb1d5b4740dd70c284ed3cb16bb857e0f7166196e36a5501df7a3aa32'
const IMAGE_DIGEST_RE = /^[^\s@]+@sha256:[0-9a-f]{64}$/

export interface RunnerTargetRuntimeDraft {
  imageDigest: string
  computeMode: 'cpu' | 'nvidia'
  devices: string
}

export function runnerTargetRuntimeDraft(runtime?: RunnerTargetRuntimeLite): RunnerTargetRuntimeDraft {
  return {
    imageDigest: runtime?.image_digest ?? '',
    computeMode: runtime?.compute.mode ?? 'cpu',
    devices: runtime?.compute.mode === 'nvidia'
      ? (runtime.compute.devices === 'all' ? 'all' : runtime.compute.devices.join(', '))
      : 'all',
  }
}

export function runnerTargetRuntimePayload(
  kind: RunnerTargetKindLite,
  draft: RunnerTargetRuntimeDraft,
): { ok: true; runtime: RunnerTargetRuntimeLite | undefined } | { ok: false; error: 'image' | 'devices' } {
  if (kind === 'local-process') return { ok: true, runtime: undefined }
  const imageDigest = draft.imageDigest.trim()
  if (!IMAGE_DIGEST_RE.test(imageDigest)) return { ok: false, error: 'image' }
  if (draft.computeMode === 'cpu') {
    return { ok: true, runtime: { image_digest: imageDigest, compute: { mode: 'cpu' } } }
  }
  const raw = draft.devices.trim()
  if (raw === 'all') {
    return { ok: true, runtime: { image_digest: imageDigest, compute: { mode: 'nvidia', devices: 'all' } } }
  }
  const devices = raw.split(',').map(value => value.trim())
  if (devices.length === 0 || devices.some(value => !/^(0|[1-9][0-9]*)$/.test(value)) || new Set(devices).size !== devices.length) {
    return { ok: false, error: 'devices' }
  }
  return { ok: true, runtime: { image_digest: imageDigest, compute: { mode: 'nvidia', devices } } }
}

export type RunnerTargetSecretRefScheme = SecretRefViewLite['scheme']

/** Browser-editable SecretRef metadata. Secret values are intentionally not
 * part of this model: the runner resolves them server-side. */
export interface RunnerTargetSecretRefDraft {
  scheme: RunnerTargetSecretRefScheme
  name: string
  version: string
  scope: string
}

export interface RunnerTargetSecretRefPayload {
  scheme: RunnerTargetSecretRefScheme
  name: string
  version?: string
  scope?: string
}

/** Create a lossless form draft from the server's safe metadata view. */
export function runnerTargetSecretRefDraft(
  ref?: Pick<SecretRefViewLite, 'scheme' | 'name' | 'version' | 'scope'>,
): RunnerTargetSecretRefDraft {
  return {
    scheme: ref?.scheme ?? 'file',
    name: ref?.name ?? '',
    version: ref?.version ?? '',
    scope: ref?.scope ?? '',
  }
}

/** Normalize a form draft for the strict kernel schema. Blank optional
 * metadata is omitted; a missing required name fails closed. */
export function runnerTargetSecretRefPayload(
  draft: RunnerTargetSecretRefDraft,
): RunnerTargetSecretRefPayload | null {
  const name = draft.name.trim()
  if (name === '') return null
  const version = draft.version.trim()
  const scope = draft.scope.trim()
  return {
    scheme: draft.scheme,
    name,
    ...(version === '' ? {} : { version }),
    ...(scope === '' ? {} : { scope }),
  }
}

export type RunnerTargetSettingsOperationInput =
  | {
      action: 'create'
      input: {
        target_id: string
        display_name: string
        kind: RunnerTargetKindLite
        enabled?: boolean
        draining?: boolean
        capabilities?: string[]
        service_identity: RunnerTargetSecretRefPayload
        runtime?: RunnerTargetRuntimeLite
        connection?: {
          endpoint: RunnerTargetSecretRefPayload
          credential: RunnerTargetSecretRefPayload
          known_hosts: RunnerTargetSecretRefPayload
        }
      }
    }
  | {
      action: 'update'
      target_id: string
      patch: Record<string, unknown> & { expected_revision: number }
    }

/** Wrap the dedicated target editor in the same transaction envelope used
 * by generated config and OCR settings. */
export function runnerTargetSettingsOperation(input: RunnerTargetSettingsOperationInput):
  RunnerTargetSettingsOperationInput & { kind: 'runner-target' } {
  return { kind: 'runner-target', ...input }
}
