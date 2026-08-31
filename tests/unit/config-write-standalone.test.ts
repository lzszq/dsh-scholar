import { describe, expect, it } from 'vitest'
import { settingsWriteAuthorizationTargets } from '../../packages/dsh-research-ui/src/standalone/server'

describe('REVIEW-CONFIG-WRITE-03 standalone BFF authorization projection', () => {
  it('derives every project authority and the global-admin requirement from one strict transaction', () => {
    expect(settingsWriteAuthorizationTargets(JSON.stringify({ operations: [
      {
        kind: 'config', scope: 'project', scope_id: 'rsp_project', expected_revision: 0,
        changes: { 'execution.network_policy': 'none' },
      },
      {
        kind: 'ocr-mineru',
        provider: {
          action: 'update', provider_id: 'mineru', expected_revision: 1,
          patch: { enabled: true },
        },
        binding: {
          project_id: 'rsp_ocr', model_id: 'flash', expected_provider_revision: 2,
        },
      },
      {
        kind: 'config', scope: 'runtime', scope_id: 'kernel', expected_revision: 0,
        changes: { 'kernel.port': 7413 },
      },
    ] }))).toEqual({
      requiresGlobalAdmin: true,
      projectIds: ['rsp_ocr', 'rsp_project'],
    })
  })

  it('keeps a project-only config patch project-scoped and rejects malformed envelopes', () => {
    expect(settingsWriteAuthorizationTargets(JSON.stringify({ operations: [{
      kind: 'config', scope: 'project', scope_id: 'rsp_only', expected_revision: 3,
      changes: { 'integrity.require_clean_room_rerun': true },
    }] }))).toEqual({ requiresGlobalAdmin: false, projectIds: ['rsp_only'] })
    expect(() => settingsWriteAuthorizationTargets('{bad-json')).toThrow()
    expect(() => settingsWriteAuthorizationTargets(JSON.stringify({ operations: [{
      kind: 'config', scope: 'tenant', scope_id: 'x', expected_revision: 0, changes: { x: true },
    }] }))).toThrow()
  })
})
