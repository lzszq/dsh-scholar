/** OCR-CONFIG-01 — MinerU Settings payloads stay explicit and secret-free. */
import { describe, expect, it } from 'vitest'
import {
  MINERU_DEFAULT_BASE_URL,
  mineruSettingsOperation,
  mineruBindingWrite,
  mineruProviderCreate,
  mineruProviderUpdate,
  mineruSettingsErrorKey,
  mineruSettingsDraft,
  normalizeMineruBaseUrl,
} from '../../packages/dsh-research-ui/src/client/mineru-settings-model'
import type { ProjectModelBindingLite, ProviderSafeViewLite } from '../../packages/dsh-research-ui/src/client/types'

const configured: ProviderSafeViewLite = {
  provider_id: 'mineru', display_name: 'MinerU', kind: 'mineru',
  base_url: MINERU_DEFAULT_BASE_URL, enabled: true,
  capabilities: ['ocr', 'vision'],
  models: [
    { model_id: 'flash', display_name: 'MinerU Flash', capabilities: ['ocr'], revision: 1 },
    { model_id: 'pipeline', display_name: 'MinerU Pipeline', capabilities: ['ocr'], revision: 1 },
    { model_id: 'vlm', display_name: 'MinerU VLM', capabilities: ['ocr', 'vision'], revision: 1 },
  ],
  revision: 3,
  credential: { scheme: 'file', name: 'mineru-token', available: true },
  created_by: 'pi-1', created_at: '2026-08-14T00:00:00.000Z', updated_at: '2026-08-14T00:00:00.000Z',
}

const binding: ProjectModelBindingLite = {
  project_id: 'rsp_1', purpose: 'ocr', provider_id: 'mineru', model_id: 'vlm',
  provider_revision: 3, provider_config_hash: 'a'.repeat(64), revision: 2,
  updated_by: 'pi-1', updated_at: '2026-08-14T00:00:00.000Z',
}

describe('OCR-CONFIG-01 MinerU Settings model', () => {
  it('creates a no-auth Flash descriptor with the fixed catalog', () => {
    const payload = mineruProviderCreate(mineruSettingsDraft())
    expect(payload).toMatchObject({
      provider_id: 'mineru', kind: 'mineru', base_url: 'https://mineru.net/api/v4', enabled: true,
      capabilities: ['ocr', 'vision'],
    })
    expect(payload.models.map(model => model.model_id)).toEqual(['flash', 'pipeline', 'vlm'])
    expect(payload).not.toHaveProperty('credential')
    expect(JSON.stringify(payload)).not.toMatch(/token|password|api_key|value/i)
  })

  it('round-trips only SecretRef metadata and binds opaque IDs with revision CAS', () => {
    const draft = mineruSettingsDraft(configured, binding)
    expect(draft).toMatchObject({ modelId: 'vlm', useCredential: true, credential: { name: 'mineru-token' } })
    const update = mineruProviderUpdate(draft, configured.revision)
    expect(update).toMatchObject({
      expected_revision: 3,
      credential: { scheme: 'file', name: 'mineru-token' },
    })
    expect(mineruBindingWrite(draft, binding, 4)).toEqual({
      purpose: 'ocr', provider_id: 'mineru', model_id: 'vlm', expected_provider_revision: 4, expected_revision: 2,
    })
    expect(update.credential).not.toHaveProperty('available')
  })

  it('submits Provider and project binding as one atomic Settings operation', () => {
    const draft = mineruSettingsDraft(configured, binding)
    expect(mineruSettingsOperation(draft, configured, binding, 'rsp_1')).toEqual({
      kind: 'ocr-mineru',
      provider: {
        action: 'update', provider_id: 'mineru', expected_revision: 3,
        patch: expect.objectContaining({ kind: 'mineru', credential: { scheme: 'file', name: 'mineru-token' } }),
      },
      binding: {
        project_id: 'rsp_1', model_id: 'vlm', expected_provider_revision: 4, expected_revision: 2,
      },
    })
  })

  it('clears a SecretRef explicitly and rejects precision models without one', () => {
    const flash = { ...mineruSettingsDraft(configured, binding), modelId: 'flash' as const, useCredential: false }
    expect(mineruProviderUpdate(flash, 3)).toHaveProperty('credential', null)
    expect(() => mineruProviderUpdate({ ...flash, modelId: 'pipeline' }, 3)).toThrow(/SecretRef/)
    expect(() => mineruBindingWrite({ ...flash, modelId: 'vlm' }, binding, 4)).toThrow(/SecretRef/)
  })

  it('accepts only the official MinerU HTTPS API origin', () => {
    expect(normalizeMineruBaseUrl(' https://mineru.net/api/v4/ ')).toBe(MINERU_DEFAULT_BASE_URL)
    for (const unsafe of [
      'http://mineru.net/api/v4',
      'https://user:secret@mineru.net/api/v4',
      'https://mineru.net/api/v4?token=x',
      'https://mineru.net/api/v4?',
      'https://mineru.net/api/v4#',
      'https://mineru.net/not-api',
      'https://mineru.net:444/api/v4',
      'https://attacker.example/api/v4',
    ]) expect(() => normalizeMineruBaseUrl(unsafe)).toThrow()
  })

  it('maps stable server codes to localized chrome keys', () => {
    expect(mineruSettingsErrorKey('role_forbidden')).toBe('shell.settings.ocr.error.permission')
    expect(mineruSettingsErrorKey('provider_revision_conflict')).toBe('shell.settings.ocr.error.providerRevision')
    expect(mineruSettingsErrorKey('provider_credential_required')).toBe('shell.settings.ocr.error.credential')
    expect(mineruSettingsErrorKey('network_error')).toBe('shell.settings.ocr.error.network')
    expect(mineruSettingsErrorKey('future_error')).toBe('shell.settings.ocr.saveFailed')
  })
})
