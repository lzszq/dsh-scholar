/**
 * settings-model — CONFIG-01 dynamic Settings model (hardening-v0.2-status.md
 * §5 P1 CONFIG-01/UI-02/UI-03, docs/config-registry.md): the Settings
 * surface generated from GET /v1/config/schema + GET /v1/config/effective.
 *
 * The suite drives the model with the REAL registry artifacts
 * (research-schemas generateJsonSchema + validateConfig — the same shapes
 * the kernel serves), so the client-side schema→field projection, the
 * declared-sources mirror and the hot-reload inference are pinned to the
 * registry and can never drift. A synthetic fixture covers the edge cases
 * (enum/number/boolean/string kinds, bounds, pattern) and the validation /
 * server-error mapping machinery. i18n assertions (zh/en parity, zero
 * missing keys at runtime, static dictionary coverage) mirror the
 * ui-simple / i18n-runtime pattern — pure logic layer, no DOM.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { CONFIG_REGISTRY, CONFIG_SCOPES, generateJsonSchema, validateConfig } from '@dsh-scholar/research-schemas'
import { zh as shellZh, en as shellEn } from '../../packages/dsh-research-ui/src/client/i18n/locales/shell'
import {
  getLocale, localeParityReport, resetMissingKeyWarnings, setLocale, setMissingKeyReporter,
} from '../../packages/dsh-research-ui/src/client/i18n/index'
import {
  SETTINGS_CONFIG_SCOPES, SETTINGS_SECTION_IDS, SettingsConfigInputError, configPinChanged, mapSettingsServerErrors,
  settingsConfigModel, settingsConfigPin, settingsConfigTransaction,
  settingsConfigWrite, settingsFieldDisplay, settingsKey, settingsSectionsForData,
  settingsParseFieldValue, validateSettingsField,
} from '../../packages/dsh-research-ui/src/client/settings-model'
import type { SettingsConfigField, SettingsEffectiveWire, SettingsSchemaWire } from '../../packages/dsh-research-ui/src/client/settings-model'

interface Missing { namespace: string; key: string; locale: string }

let missing: Missing[] = []

beforeEach(() => {
  missing = []
  setMissingKeyReporter(r => { missing.push(r) })
})

afterEach(() => {
  setMissingKeyReporter(null)
  resetMissingKeyWarnings()
})

/** The real registry artifacts, exactly as the kernel serves them: the JSON
 *  Schema (all 7 scopes) + a deployment effective config validated with the
 *  kernel bin's scope set (global/project/kernel) — secrets redacted. */
function realModel(): { sections: ReturnType<typeof settingsConfigModel>; schema: SettingsSchemaWire; effective: SettingsEffectiveWire } {
  const resolved = validateConfig({
    'kernel.host': '127.0.0.1',
    'kernel.port': 7412,
    'kernel.token': 'supersecret',
    'kernel.service_token': 'svc-token',
    'kernel.db': '/tmp/dsh-test/kernel.db',
    'kernel.cas': '.research-cas',
    'kernel.endpoint_file': '',
    'kernel.require_signed_manifest': true,
  }, { scopes: ['global', 'project', 'kernel'] })
  const schema = generateJsonSchema() as unknown as SettingsSchemaWire
  const effective: SettingsEffectiveWire = {
    config_pin: resolved.pinHash,
    config: resolved.redacted,
    revisions: { global: 2, project: 4, runtime: { kernel: 7, 'runner-profile': 9, orchestrator: 0, standalone: 0 } },
  }
  return { sections: settingsConfigModel(schema, effective), schema, effective }
}

const fieldByKey = (sections: ReturnType<typeof settingsConfigModel>, key: string): SettingsConfigField => {
  const field = sections.flatMap(s => s.fields).find(f => f.key === key)
  expect(field).toBeDefined()
  return field as SettingsConfigField
}

describe('CONFIG-01 dynamic Settings — schema/effective → field model', () => {
  it('groups every registry key into the seven ConfigScope sections in registry order', () => {
    const { sections } = realModel()
    expect(sections.map(s => s.id)).toEqual(SETTINGS_CONFIG_SCOPES.map(scope => `config-${scope}`))
    expect(sections.map(s => s.scope)).toEqual([...CONFIG_SCOPES])
    const fields = sections.flatMap(s => s.fields)
    // FULL coverage: every registry key becomes exactly one field.
    expect(fields.map(f => f.key).sort()).toEqual(CONFIG_REGISTRY.map(def => def.key).sort())
    expect(new Set(fields.map(f => f.key)).size).toBe(CONFIG_REGISTRY.length)
    // the reserved job scope has no keys yet (registry comment) but stays a
    // stable section so the surface exists before the keys land
    const job = sections.find(s => s.scope === 'job')
    expect(job?.fields).toEqual([])
  })

  it('projects kind/scope/secret/floor/env/default metadata from the schema leaves', () => {
    const { sections } = realModel()
    const networkPolicy = fieldByKey(sections, 'execution.network_policy')
    expect(networkPolicy.kind).toBe('enum')
    expect(networkPolicy.enumValues).toEqual(['allowlist', 'none'])
    expect(networkPolicy.scope).toBe('project')
    expect(networkPolicy.securityFloor).toBe(true)
    expect(networkPolicy.default).toBe('allowlist')
    const port = fieldByKey(sections, 'kernel.port')
    expect(port.kind).toBe('number')
    expect(port.minimum).toBe(0)
    expect(port.maximum).toBe(65535)
    const token = fieldByKey(sections, 'kernel.token')
    expect(token.kind).toBe('string')
    expect(token.secret).toBe(true)
    expect(token.env).toBe('DSH_SCHOLAR_KERNEL_TOKEN')
    const manifest = fieldByKey(sections, 'kernel.require_signed_manifest')
    expect(manifest.kind).toBe('boolean')
    expect(manifest.securityFloor).toBe(true)
    const digest = fieldByKey(sections, 'global.images_lock.node_fixture')
    expect(digest.pattern).toContain('sha256')
  })

  it('reads sources/write scopes/apply verdict directly from the generated schema (no client mirror)', () => {
    const { sections } = realModel()
    for (const def of CONFIG_REGISTRY) {
      const field = fieldByKey(sections, def.key)
      expect(field.sources).toEqual([...def.sources])
      expect(field.writeScopes).toEqual([...def.write.allowedScopes])
      expect(field.reload).toBe(def.write.apply)
    }
    expect(fieldByKey(sections, 'execution.network_policy')).toMatchObject({ writeScopes: ['project'], reload: 'hot' })
    expect(fieldByKey(sections, 'kernel.port')).toMatchObject({ writeScopes: [], reload: 'restart' })
    expect(fieldByKey(sections, 'kernel.require_signed_manifest')).toMatchObject({ writeScopes: ['runtime'], reload: 'restart' })
    expect(fieldByKey(sections, 'standalone.no_token')).toMatchObject({ writeScopes: [], reload: 'restart' })
  })

  it('values come from the effective config; secrets are already redacted server-side', () => {
    const { sections, effective } = realModel()
    // effective values flow through (defaults when unset — registry merge)
    expect(fieldByKey(sections, 'kernel.port').value).toBe(7412)
    expect(fieldByKey(sections, 'kernel.token').value).toBe('<redacted>')
    expect(fieldByKey(sections, 'execution.network_policy').value).toBe('allowlist')
    // the served pin surfaces unchanged
    expect(settingsConfigPin(effective)).toBe(effective.config_pin)
    expect(settingsConfigPin({})).toBeUndefined()
    expect(settingsConfigPin({ config_pin: '' })).toBeUndefined()
  })

  it('fields outside the kernel effective (other binaries) are marked absent with their default', () => {
    const { sections } = realModel()
    const poll = fieldByKey(sections, 'runner.poll_ms')
    expect(poll.presentInEffective).toBe(false)
    expect(poll.default).toBe(2000)
    expect(settingsFieldDisplay(poll)).toEqual({ kind: 'absent', value: 2000 })
    const kernelPort = fieldByKey(sections, 'kernel.port')
    expect(kernelPort.presentInEffective).toBe(true)
    expect(settingsFieldDisplay(kernelPort)).toEqual({ kind: 'value', value: 7412 })
    // A missing project profile stays explicitly unconfigured; Settings must
    // never present a local Docker choice as though the user selected it.
    const profileId = fieldByKey(sections, 'execution.runner_profile_id')
    expect(settingsFieldDisplay(profileId)).toEqual({ kind: 'none', value: null })
  })

  it('secret fields NEVER render a value — only the set-but-hidden mask kind', () => {
    const { sections } = realModel()
    for (const key of ['kernel.token', 'kernel.service_token']) {
      const display = settingsFieldDisplay(fieldByKey(sections, key))
      expect(display.kind).toBe('secret')
      expect(display.value).toBe('<redacted>')
    }
  })

  it('every field label / section title / summary resolves in BOTH zh and en dictionaries', () => {
    const { sections } = realModel()
    const dicts = { zh: shellZh, en: shellEn }
    const miss: string[] = []
    const check = (key: string): void => {
      for (const locale of ['zh', 'en'] as const) {
        if (!(key in dicts[locale])) miss.push(`${locale} missing ${key}`)
      }
    }
    for (const section of sections) {
      check(section.titleKey)
      check(section.summaryKey)
      for (const field of section.fields) check(field.labelKey)
    }
    expect(miss).toEqual([])
    expect(localeParityReport()).toEqual([])
  })

  it('evaluating the FULL dynamic model in both locales reports zero missing keys', () => {
    const { sections } = realModel()
    const chromeKeys: Array<{ key: string; params?: Record<string, string> }> = [
      { key: 'shell.settings.source.effective' },
      { key: 'shell.settings.scopeLabel', params: { scope: 'kernel' } },
      { key: 'shell.settings.sourcesLabel', params: { sources: 'cli/env/file' } },
      { key: 'shell.settings.reloadHot' },
      { key: 'shell.settings.reloadRestart' },
      { key: 'shell.settings.securityFloor' },
      { key: 'shell.settings.envAlias', params: { env: 'DSH_SCHOLAR_KERNEL_TOKEN' } },
      { key: 'shell.settings.secretSet' },
      { key: 'shell.settings.valueNone' },
      { key: 'shell.settings.valueDefault', params: { value: '2000' } },
      { key: 'shell.settings.notInEffective' },
      { key: 'shell.settings.configPinChanged' },
      { key: 'shell.settings.error.invalid_number' },
      { key: 'shell.settings.error.not_integer' },
      { key: 'shell.settings.error.below_min', params: { min: '0' } },
      { key: 'shell.settings.error.above_max', params: { max: '65535' } },
      { key: 'shell.settings.error.invalid_boolean' },
      { key: 'shell.settings.error.invalid_enum', params: { values: 'a, b' } },
      { key: 'shell.settings.error.too_short', params: { minLength: '3' } },
      { key: 'shell.settings.error.pattern_mismatch' },
    ]
    const evaluate = (): void => {
      for (const section of sections) {
        expect(settingsKey(section.titleKey)).not.toBe('')
        expect(settingsKey(section.summaryKey)).not.toBe('')
        for (const field of section.fields) {
          const label = settingsKey(field.labelKey)
          expect(label).not.toBe('')
          // zh/en labels differ in content (real translations, not the raw key)
          expect(label).not.toBe(field.labelKey)
        }
      }
      for (const { key, params } of chromeKeys) {
        const text = settingsKey(key, params)
        expect(text).not.toBe('')
        expect(text).not.toBe(key)
      }
      expect(settingsKey(settingsConfigWrite().noteKey)).not.toBe('')
    }
    setLocale('zh')
    evaluate()
    setLocale('en')
    evaluate()
    expect(missing).toEqual([])
    expect(getLocale()).toBe('en')
  })
})

describe('CONFIG-01 dynamic Settings — write mode, pin and section fallback', () => {
  it('the write surface targets the single atomic Settings transaction endpoint', () => {
    const write = settingsConfigWrite()
    expect(write.available).toBe(true)
    expect(write.endpoint).toBe('/v1/settings/transactions')
    for (const locale of ['zh', 'en'] as const) {
      setLocale(locale)
      const note = settingsKey(write.noteKey)
      expect(note).not.toBe('')
      expect(note).not.toBe(write.noteKey)
    }
  })

  it('groups only consumer-backed project/runtime edits with exact CAS revisions', () => {
    const { sections, effective } = realModel()
    const fields = sections.flatMap(section => section.fields)
    const transaction = settingsConfigTransaction(fields, new Map([
      ['execution.network_policy', 'none'],
      ['kernel.require_signed_manifest', 'false'],
    ]), effective, { projectId: 'rsp_config' })
    expect(transaction).toEqual({ operations: [
      {
        kind: 'config', scope: 'project', scope_id: 'rsp_config', expected_revision: 4,
        changes: { 'execution.network_policy': 'none' },
      },
      {
        kind: 'config', scope: 'runtime', scope_id: 'kernel', expected_revision: 7,
        changes: { 'kernel.require_signed_manifest': false },
      },
    ] })
    expect(() => settingsConfigTransaction(fields, new Map([
      ['standalone.no_token', 'true'],
    ]), effective, { projectId: 'rsp_config' })).toThrow(/not writable/)
  })

  it('parses typed controls and requires strict SecretRef JSON for secret fields', () => {
    const { sections, effective } = realModel()
    expect(settingsParseFieldValue(fieldByKey(sections, 'kernel.port'), '7413')).toBe(7413)
    expect(settingsParseFieldValue(fieldByKey(sections, 'execution.network_policy'), 'none')).toBe('none')
    expect(settingsParseFieldValue(fieldByKey(sections, 'integrity.require_clean_room_rerun'), 'true')).toBe(true)
    expect(settingsParseFieldValue(fieldByKey(sections, 'kernel.token'), '{"scheme":"file","name":"kernel/token"}')).toEqual({
      scheme: 'file', name: 'kernel/token',
    })
    expect(() => settingsParseFieldValue(fieldByKey(sections, 'kernel.token'), 'plaintext-token')).toThrow(/SecretRef/)
    expect(() => settingsParseFieldValue(fieldByKey(sections, 'kernel.token'), '{"scheme":"file","name":"x","value":"secret"}')).toThrow(/SecretRef/)
    try {
      settingsConfigTransaction(sections.flatMap(section => section.fields), new Map([
        ['execution.network_policy', 'internet'],
      ]), effective, { projectId: 'rsp_config' })
      expect.fail('expected a field-addressable Settings error')
    } catch (error) {
      expect(error).toBeInstanceOf(SettingsConfigInputError)
      expect(error).toMatchObject({ key: 'execution.network_policy', code: 'invalid_enum' })
    }
  })

  it('configPinChanged(): undefined/empty current is never a change; any real change is flagged', () => {
    expect(configPinChanged(undefined, undefined)).toBe(false)
    expect(configPinChanged('', '')).toBe(false)
    expect(configPinChanged(undefined, 'sha256:abc')).toBe(false) // first sighting
    expect(configPinChanged('sha256:abc', 'sha256:abc')).toBe(false)
    expect(configPinChanged('sha256:abc', 'sha256:def')).toBe(true)
    expect(configPinChanged('sha256:abc', '')).toBe(false)
  })

  it('settingsSectionsForData(): placeholders replaced by generated sections when data exists', () => {
    const withData = settingsSectionsForData(true)
    expect(withData.map(s => s.id)).toEqual(['connection', 'appearance', 'preferences', 'config'])
    for (const section of withData) expect(section.kind).toBe('content')
    const withoutData = settingsSectionsForData(false)
    expect(withoutData.map(s => s.id)).toEqual([...SETTINGS_SECTION_IDS])
    expect(withoutData.filter(s => s.kind === 'placeholder').map(s => s.id))
      .toEqual(['runner', 'workspace', 'terminal', 'tex', 'agent'])
  })
})

describe('CONFIG-01 dynamic Settings — local validation (write-path machinery)', () => {
  /** Synthetic fields covering every schema kind + constraint. */
  const fixture: SettingsConfigField[] = [
    {
      key: 'fixture.mode', labelKey: 'shell.settings.key.fixture.mode', scope: 'project', kind: 'enum',
      enumValues: ['a', 'b'], default: 'a', value: 'a', presentInEffective: true, secret: false,
      securityFloor: false, env: undefined, sources: ['http', 'ui', 'file'], writeScopes: ['project'], reload: 'hot',
      description: '', minimum: undefined, maximum: undefined, minLength: undefined, pattern: undefined,
    },
    {
      key: 'fixture.ports', labelKey: 'shell.settings.key.fixture.ports', scope: 'project', kind: 'number',
      enumValues: [], default: 7412, value: 7412, presentInEffective: true, secret: false,
      securityFloor: false, env: undefined, sources: ['http', 'ui', 'file'], writeScopes: ['project'], reload: 'hot',
      description: '', minimum: 0, maximum: 65535, minLength: undefined, pattern: undefined,
    },
    {
      key: 'fixture.flag', labelKey: 'shell.settings.key.fixture.flag', scope: 'project', kind: 'boolean',
      enumValues: [], default: false, value: false, presentInEffective: true, secret: false,
      securityFloor: false, env: undefined, sources: ['http', 'ui', 'file'], writeScopes: ['project'], reload: 'hot',
      description: '', minimum: undefined, maximum: undefined, minLength: undefined, pattern: undefined,
    },
    {
      key: 'fixture.code', labelKey: 'shell.settings.key.fixture.code', scope: 'project', kind: 'string',
      enumValues: [], default: '', value: '', presentInEffective: true, secret: false,
      securityFloor: false, env: undefined, sources: ['http', 'ui', 'file'], writeScopes: ['project'], reload: 'hot',
      description: '', minimum: undefined, maximum: undefined, minLength: 3, pattern: '^[a-z]+$',
    },
    {
      key: 'fixture.opaque', labelKey: 'shell.settings.key.fixture.opaque', scope: 'project', kind: 'unknown',
      enumValues: [], default: null, value: null, presentInEffective: true, secret: false,
      securityFloor: false, env: undefined, sources: ['http', 'ui', 'file'], writeScopes: ['project'], reload: 'hot',
      description: '', minimum: undefined, maximum: undefined, minLength: undefined, pattern: undefined,
    },
  ]
  const byKey = (key: string): SettingsConfigField => fixture.find(f => f.key === key) as SettingsConfigField

  it('numbers: finite integer within declared bounds', () => {
    const field = byKey('fixture.ports')
    expect(validateSettingsField(field, '7412')).toBeNull()
    expect(validateSettingsField(field, '0')).toBeNull()
    expect(validateSettingsField(field, ' 7412 ')).toBeNull()
    expect(validateSettingsField(field, 'abc')).toEqual({ code: 'invalid_number' })
    expect(validateSettingsField(field, '7412.5')).toEqual({ code: 'not_integer' })
    expect(validateSettingsField(field, '-1')).toEqual({ code: 'below_min', min: 0 })
    expect(validateSettingsField(field, '70000')).toEqual({ code: 'above_max', max: 65535 })
  })

  it('booleans accept only true/false', () => {
    const field = byKey('fixture.flag')
    expect(validateSettingsField(field, 'true')).toBeNull()
    expect(validateSettingsField(field, 'false')).toBeNull()
    expect(validateSettingsField(field, 'yes')).toEqual({ code: 'invalid_boolean' })
    expect(validateSettingsField(field, '1')).toEqual({ code: 'invalid_boolean' })
  })

  it('enums must be members and carry the member list', () => {
    const field = byKey('fixture.mode')
    expect(validateSettingsField(field, 'a')).toBeNull()
    expect(validateSettingsField(field, 'b')).toBeNull()
    expect(validateSettingsField(field, 'c')).toEqual({ code: 'invalid_enum', values: 'a, b' })
  })

  it('strings honour minLength and pattern', () => {
    const field = byKey('fixture.code')
    expect(validateSettingsField(field, 'abc')).toBeNull()
    expect(validateSettingsField(field, 'ab')).toEqual({ code: 'too_short', minLength: 3 })
    expect(validateSettingsField(field, 'ABC')).toEqual({ code: 'pattern_mismatch' })
  })

  it('unknown kinds pass local validation (server is authoritative)', () => {
    expect(validateSettingsField(byKey('fixture.opaque'), 'anything')).toBeNull()
  })
})

describe('CONFIG-01 dynamic Settings — server error mapping (write-path machinery)', () => {
  it('maps only authoritative structured envelope keys onto fields', () => {
    const { sections } = realModel()
    const fields = sections.flatMap(s => s.fields)
    const validation = mapSettingsServerErrors(fields, {
      code: 'validation_error',
      key: 'execution.network_policy',
      message: 'invalid network policy',
    })
    expect(validation.byKey.get('execution.network_policy')?.code).toBe('validation_error')
    expect(validation.unmatched).toEqual([])
    const unknown = mapSettingsServerErrors(fields, {
      code: 'unknown_config_key',
      key: 'kernel.port',
      message: 'unknown config key',
    })
    expect(unknown.byKey.get('kernel.port')?.code).toBe('unknown_config_key')
    expect(unknown.unmatched).toEqual([])
  })

  it('does not infer a field key from human-readable error text', () => {
    const { sections } = realModel()
    const fields = sections.flatMap(s => s.fields)
    const mapped = mapSettingsServerErrors(fields, {
      code: 'security_floor_violation',
      message: 'runner.privileged=true is forbidden',
    })
    expect(mapped.byKey.size).toBe(0)
    expect(mapped.unmatched).toEqual([{
      key: '', code: 'security_floor_violation', message: 'runner.privileged=true is forbidden',
    }])
  })

  it('envelopes naming no known field land in unmatched (never a fake field error)', () => {
    const { sections } = realModel()
    const fields = sections.flatMap(s => s.fields)
    const unknownKey = mapSettingsServerErrors(fields, {
      code: 'unknown_config_key',
      key: 'bogus.key',
      message: 'unknown config key',
    })
    expect(unknownKey.byKey.size).toBe(0)
    expect(unknownKey.unmatched).toHaveLength(1)
    expect(unknownKey.unmatched[0]?.key).toBe('bogus.key')
    const http = mapSettingsServerErrors(fields, { code: 'http_error', message: 'HTTP 500' })
    expect(http.byKey.size).toBe(0)
    expect(http.unmatched).toHaveLength(1)
  })

  it('a structured envelope.key is honoured directly', () => {
    const { sections } = realModel()
    const fields = sections.flatMap(s => s.fields)
    const mapped = mapSettingsServerErrors(fields, { code: 'validation_error', key: 'kernel.port', message: 'x' })
    expect(mapped.byKey.get('kernel.port')?.code).toBe('validation_error')
    expect(mapped.unmatched).toEqual([])
  })
})
