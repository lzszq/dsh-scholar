/**
 * EXEC-ENV-02 Settings SecretRef form contract.
 *
 * The browser edits metadata only: all four supported fields must survive an
 * edit round-trip, while blank optional values are omitted from the request.
 * Secret values are deliberately absent from both the draft and payload.
 */
import { describe, expect, it } from 'vitest'
import {
  runnerTargetRuntimeDraft,
  runnerTargetRuntimePayload,
  runnerTargetSettingsOperation,
  runnerTargetSecretRefDraft,
  runnerTargetSecretRefPayload,
} from '../../packages/dsh-research-ui/src/client/runner-target-settings-model'

describe('runner target Settings SecretRef model', () => {
  it('preserves scheme/name/version/scope when editing an existing safe view', () => {
    const draft = runnerTargetSecretRefDraft({
      scheme: 'vault',
      name: 'research/lab-a/ssh-key',
      version: '42',
      scope: 'project:alpha',
      available: true,
    })

    expect(draft).toEqual({
      scheme: 'vault',
      name: 'research/lab-a/ssh-key',
      version: '42',
      scope: 'project:alpha',
    })
    expect(runnerTargetSecretRefPayload(draft)).toEqual(draft)
  })

  it('trims fields and omits blank optional metadata', () => {
    expect(runnerTargetSecretRefPayload({
      scheme: 'file',
      name: '  lab-a/endpoint.json  ',
      version: '   ',
      scope: '',
    })).toEqual({ scheme: 'file', name: 'lab-a/endpoint.json' })
  })

  it('rejects an empty reference name', () => {
    expect(runnerTargetSecretRefPayload({
      scheme: 'keyring',
      name: '   ',
      version: 'v1',
      scope: 'runner',
    })).toBeNull()
  })

  it('builds progressive local/Docker/NVIDIA/SSH runtime drafts', () => {
    const digest = 'registry.example/research@sha256:' + 'c'.repeat(64)
    expect(runnerTargetRuntimeDraft(undefined)).toEqual({ imageDigest: '', computeMode: 'cpu', devices: 'all' })
    expect(runnerTargetRuntimePayload('local-process', { imageDigest: digest, computeMode: 'nvidia', devices: '0' }))
      .toEqual({ ok: true, runtime: undefined })
    expect(runnerTargetRuntimePayload('local-docker', { imageDigest: digest, computeMode: 'cpu', devices: '' }))
      .toEqual({ ok: true, runtime: { image_digest: digest, compute: { mode: 'cpu' } } })
    expect(runnerTargetRuntimePayload('remote-ssh', { imageDigest: digest, computeMode: 'nvidia', devices: '0, 2' }))
      .toEqual({ ok: true, runtime: { image_digest: digest, compute: { mode: 'nvidia', devices: ['0', '2'] } } })
  })

  it('rejects mutable images and unsafe NVIDIA device selectors', () => {
    const digest = 'registry.example/research@sha256:' + 'd'.repeat(64)
    expect(runnerTargetRuntimePayload('local-docker', { imageDigest: 'research:latest', computeMode: 'cpu', devices: '' }))
      .toEqual({ ok: false, error: 'image' })
    expect(runnerTargetRuntimePayload('local-docker', { imageDigest: digest, computeMode: 'nvidia', devices: '0,0' }))
      .toEqual({ ok: false, error: 'devices' })
    expect(runnerTargetRuntimePayload('local-docker', { imageDigest: digest, computeMode: 'nvidia', devices: '0,,2' }))
      .toEqual({ ok: false, error: 'devices' })
    expect(runnerTargetRuntimePayload('local-docker', { imageDigest: digest, computeMode: 'nvidia', devices: '--privileged' }))
      .toEqual({ ok: false, error: 'devices' })
  })

  it('wraps create/update in the shared atomic Settings transaction operation', () => {
    const serviceIdentity = { scheme: 'file' as const, name: 'runner-targets/gpu.token' }
    expect(runnerTargetSettingsOperation({
      action: 'create',
      input: {
        target_id: 'gpu', display_name: 'GPU', kind: 'local-docker', service_identity: serviceIdentity,
        capabilities: [], enabled: true, draining: false,
      },
    })).toMatchObject({ kind: 'runner-target', action: 'create', input: { target_id: 'gpu' } })
    expect(runnerTargetSettingsOperation({
      action: 'update', target_id: 'gpu', patch: { expected_revision: 2, draining: true },
    })).toEqual({ kind: 'runner-target', action: 'update', target_id: 'gpu', patch: { expected_revision: 2, draining: true } })
  })
})
