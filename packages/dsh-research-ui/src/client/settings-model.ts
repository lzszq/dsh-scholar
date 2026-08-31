/**
 * UI-SIMPLE-01 Settings progressive disclosure model (acceptance-tests.md
 * §8 ui-settings, hardening-v0.2-status.md §3 UI-SIMPLE-01 / §5 P1
 * CONFIG-01/UI-02/UI-03): the pure-data Accordion section definitions
 * rendered by modals/settings.ts.
 *
 * Two layers, both PURE DATA — no DOM, no side effects:
 *
 * 1. `settingsSections()` — the static browser-level sections (connection /
 *    appearance / preferences / config provenance) plus the honest
 *    placeholders (runner / workspace / terminal / TeX / agent) used ONLY as
 *    the fallback when the kernel registry data is unavailable. Every
 *    section carries a stable `id`, i18n key pairs (`ns.key` form) evaluated
 *    by the DOM layer against the current locale, and
 *    `defaultCollapsed: true` (Accordion 默认折叠).
 *
 * 2. `settingsConfigModel()` — the CONFIG-01 dynamic model generated from
 *    `GET /v1/config/schema` (registry JSON Schema, leaf annotations
 *    x-dsh-key / x-dsh-scope / x-dsh-secret / x-dsh-security-floor / x-dsh-env /
 *    default / description) + `GET /v1/config/effective` (redacted
 *    plaintext + config_pin). One section per ConfigScope
 *    (global/project/job/runner-profile/orchestrator/kernel/standalone),
 *    every field carries the current (server-redacted) value, its scope,
 *    declared sources, secret/security-floor markers, allowed write layers,
 *    authoritative hot/restart verdict, schema default and validation
 *    metadata. These values are emitted by the canonical registry; the
 *    browser has no metadata mirror or source-based inference. Generic
 *    config, OCR and Runner editors submit the same strict Settings
 *    transaction contract with exact revision CAS.
 *
 * Unit tests assert the group ids, default-collapsed contract, key parity
 * (zh/en dictionaries), every row/field key resolving, the schema→field
 * mapping, secret masking, pin change detection, validation error codes and
 * the registry mirror — without a browser.
 */
import { t } from './i18n/index'

export interface SettingsRowDef {
  /** Stable row id (also the DOM data-row slot key for dynamic rows). */
  id: string
  /** `ns.key` i18n key for the row label. */
  labelKey: string
  /** `ns.key` i18n key for a static value; absent = dynamic slot. */
  valueKey?: string
  /** Interpolation params for valueKey. */
  valueParams?: Record<string, string>
  /** `ns.key` i18n key for an optional trailing action button label. */
  actionKey?: string
}

export interface SettingsSectionDef {
  /** Stable section id (DOM data-section key + expand-memory key). */
  id: string
  /** `ns.key` i18n key for the Accordion header title. */
  titleKey: string
  /** `ns.key` i18n key for the source / effective-status summary line. */
  summaryKey: string
  /** Accordion 默认折叠: every section starts collapsed. */
  defaultCollapsed: boolean
  /** 'content' = live rows (the modal fills dynamic slots); 'placeholder'
   *  = honest placeholder row for a not-yet-implemented surface. */
  kind: 'content' | 'placeholder'
  rows: SettingsRowDef[]
}

/** Stable section ids (order = Accordion order). */
export const SETTINGS_SECTION_IDS = [
  'connection', 'appearance', 'preferences',
  'runner', 'workspace', 'terminal', 'tex', 'agent', 'config',
] as const
export type SettingsSectionId = (typeof SETTINGS_SECTION_IDS)[number]

/** `ns.key` → evaluated string in the current locale (DOM helper contract;
 *  the model itself stays key-only so tests can assert parity). The dict
 *  key format is the full dotted key (`shell.settings.connection`), so the
 *  first segment is the namespace and the whole key is the lookup key. */
export function settingsKey(key: string, params?: Record<string, string>): string {
  const dot = key.indexOf('.')
  return dot < 0 ? key : t(key.slice(0, dot), key, params)
}

/** UI-SIMPLE-01: Settings Accordion section definitions (pure data). */
export function settingsSections(): SettingsSectionDef[] {
  return [
    {
      id: 'connection',
      titleKey: 'shell.settings.connection',
      summaryKey: 'shell.settings.source.kernel',
      defaultCollapsed: true,
      kind: 'content',
      rows: [
        { id: 'connection.kernel', labelKey: 'shell.settings.kernel' },
        { id: 'connection.bridge', labelKey: 'shell.settings.bridge', valueKey: 'shell.settings.bridgeValue' },
        { id: 'connection.auth', labelKey: 'shell.settings.auth' },
        { id: 'connection.endpoint', labelKey: 'shell.settings.endpoint' },
        { id: 'connection.token', labelKey: 'shell.settings.token' },
      ],
    },
    {
      id: 'appearance',
      titleKey: 'shell.settings.appearance',
      summaryKey: 'shell.settings.source.localStorage',
      defaultCollapsed: true,
      kind: 'content',
      rows: [
        { id: 'appearance.theme', labelKey: 'shell.settings.theme' },
        { id: 'appearance.accent', labelKey: 'shell.settings.accent' },
        { id: 'appearance.corners', labelKey: 'shell.settings.corners' },
        { id: 'appearance.texture', labelKey: 'shell.settings.texture' },
      ],
    },
    {
      id: 'preferences',
      titleKey: 'shell.settings.preferences',
      summaryKey: 'shell.settings.source.localStorage',
      defaultCollapsed: true,
      kind: 'content',
      rows: [
        { id: 'preferences.language', labelKey: 'shell.settings.language' },
        { id: 'preferences.autoRefresh', labelKey: 'shell.settings.autoRefresh' },
        { id: 'preferences.budgetPage', labelKey: 'shell.settings.budgetPage' },
        { id: 'preferences.transcript', labelKey: 'shell.settings.transcript' },
        { id: 'preferences.summary', labelKey: 'shell.settings.summary' },
        { id: 'preferences.shortcuts', labelKey: 'shell.settings.help', actionKey: 'shell.settings.shortcuts' },
        { id: 'preferences.about', labelKey: 'shell.settings.about', actionKey: 'common.action.open' },
        { id: 'preferences.localData', labelKey: 'shell.settings.localData', actionKey: 'common.action.resetPreferences' },
      ],
    },
    {
      id: 'runner',
      titleKey: 'shell.settings.section.runner',
      summaryKey: 'shell.settings.source.project',
      defaultCollapsed: true,
      kind: 'placeholder',
      rows: [
        { id: 'runner.placeholder', labelKey: 'shell.settings.placeholder.label', valueKey: 'shell.settings.placeholder.value' },
      ],
    },
    {
      id: 'workspace',
      titleKey: 'shell.settings.section.workspace',
      summaryKey: 'shell.settings.source.kernel',
      defaultCollapsed: true,
      kind: 'placeholder',
      rows: [
        { id: 'workspace.placeholder', labelKey: 'shell.settings.placeholder.label', valueKey: 'shell.settings.placeholder.value' },
      ],
    },
    {
      id: 'terminal',
      titleKey: 'shell.settings.section.terminal',
      summaryKey: 'shell.settings.source.kernel',
      defaultCollapsed: true,
      kind: 'placeholder',
      rows: [
        { id: 'terminal.placeholder', labelKey: 'shell.settings.placeholder.label', valueKey: 'shell.settings.placeholder.value' },
      ],
    },
    {
      id: 'tex',
      titleKey: 'shell.settings.section.tex',
      summaryKey: 'shell.settings.source.kernel',
      defaultCollapsed: true,
      kind: 'placeholder',
      rows: [
        { id: 'tex.placeholder', labelKey: 'shell.settings.placeholder.label', valueKey: 'shell.settings.placeholder.value' },
      ],
    },
    {
      id: 'agent',
      titleKey: 'shell.settings.section.agent',
      summaryKey: 'shell.settings.source.registry',
      defaultCollapsed: true,
      kind: 'placeholder',
      rows: [
        { id: 'agent.placeholder', labelKey: 'shell.settings.placeholder.label', valueKey: 'shell.settings.placeholder.value' },
      ],
    },
    {
      id: 'config',
      titleKey: 'shell.settings.section.config',
      summaryKey: 'shell.settings.source.registry',
      defaultCollapsed: true,
      kind: 'content',
      rows: [
        { id: 'config.pin', labelKey: 'shell.settings.configPin' },
        { id: 'config.registry', labelKey: 'shell.settings.configRegistry', valueKey: 'shell.settings.configRegistryDoc' },
        { id: 'config.headers', labelKey: 'shell.settings.configHeadersLabel', valueKey: 'shell.settings.configHeaders' },
      ],
    },
  ]
}

/* ─────────────────── CONFIG-01 dynamic Settings model ─────────────────── */

/** Wire shape of GET /v1/config/schema (registry-generated JSON Schema,
 *  draft-07; leaf annotations from config-registry.ts generateJsonSchema). */
export interface SettingsSchemaWire {
  $schema?: string
  title?: string
  properties?: Record<string, Record<string, unknown>>
  additionalProperties?: boolean
}

/** Wire shape of GET /v1/config/effective (redacted plaintext + pin). */
export interface SettingsEffectiveWire {
  config_pin?: string
  config?: Record<string, unknown>
  generated_at?: string
  revisions?: { global: number; project: number | null; runtime: Record<string, number> }
}

/** Field value kinds the registry's zod subset can declare. */
export type SettingsConfigKind = 'string' | 'number' | 'boolean' | 'enum' | 'unknown'

export type SettingsConfigReload = 'hot' | 'restart'
export type SettingsConfigWriteScope = 'global' | 'project' | 'runtime'

/** One schema leaf projected into the Settings surface. */
export interface SettingsConfigField {
  /** Canonical dotted registry key (stable DOM data-key). */
  key: string
  /** `shell.settings.key.<key>` — evaluated per locale. */
  labelKey: string
  /** ConfigScope the key belongs to. */
  scope: string
  kind: SettingsConfigKind
  /** Enum members when kind === 'enum'. */
  enumValues: readonly unknown[]
  /** Schema default (registry `default` annotation). */
  default: unknown
  /** Effective value — ALREADY server-redacted (secrets are `<redacted>`);
   *  the client never receives plaintext secrets. */
  value: unknown
  /** Whether the key is part of the served effective config (the kernel's
   *  effective covers global/project/kernel scopes; the other scopes are
   *  other binaries — their fields show the schema default instead). */
  presentInEffective: boolean
  /** Registry secret marker (masked display, never echoed). */
  secret: boolean
  /** Registry security-floor marker (relaxing/pinning key). */
  securityFloor: boolean
  /** DSH_* env alias when the registry declares one. */
  env: string | undefined
  /** Declared configuration sources emitted by the registry. */
  sources: readonly string[]
  /** Durable layers at which the field may be changed. */
  writeScopes: readonly SettingsConfigWriteScope[]
  /** Authoritative apply verdict emitted by the registry. */
  reload: SettingsConfigReload
  /** Raw registry description (wire text — displayed verbatim, §8 line 115). */
  description: string
  /** Schema numeric bounds / string constraints (used by local validation). */
  minimum: number | undefined
  maximum: number | undefined
  minLength: number | undefined
  pattern: string | undefined
}

/** One ConfigScope group of the Settings surface (id `config-<scope>`). */
export interface SettingsConfigSection {
  id: string
  scope: string
  titleKey: string
  summaryKey: string
  fields: SettingsConfigField[]
}

/** Stable ConfigScope order (mirrors research-schemas CONFIG_SCOPES). */
export const SETTINGS_CONFIG_SCOPES = [
  'global', 'project', 'job', 'runner-profile', 'orchestrator', 'kernel', 'standalone',
] as const

/** The single atomic endpoint shared by generated config, OCR and Runner
 * editors. */
export interface SettingsConfigWriteMode {
  available: true
  noteKey: string
  endpoint: string
}

export function settingsConfigWrite(): SettingsConfigWriteMode {
  return { available: true, noteKey: 'shell.settings.writeHint', endpoint: '/v1/settings/transactions' }
}

/** True when the effective pin changed since the previously seen pin (the
 *  modal persists the last pin and surfaces the change hint). */
export function configPinChanged(previous: string | undefined, current: string | undefined): boolean {
  if (current === undefined || current === '') return false
  return previous !== undefined && previous !== '' && previous !== current
}

function schemaLeafKind(leaf: Record<string, unknown>): SettingsConfigKind {
  if (Array.isArray(leaf.enum) && leaf.enum.length > 0) return 'enum'
  const type = leaf.type
  if (type === 'integer' || type === 'number') return 'number'
  if (type === 'boolean') return 'boolean'
  if (type === 'string') return 'string'
  return 'unknown'
}

/** Collect canonical x-dsh-key leaf nodes from the served JSON Schema. The
 * browser never reconstructs domain identifiers from presentation nesting. */
function collectSchemaLeaves(
  node: Record<string, unknown>,
  out: Array<{ key: string; leaf: Record<string, unknown> }>,
): void {
  if (typeof node['x-dsh-scope'] === 'string' && typeof node['x-dsh-key'] === 'string') {
    out.push({ key: node['x-dsh-key'], leaf: node })
    return
  }
  const props = node.properties
  if (typeof props !== 'object' || props === null) return
  for (const child of Object.values(props as Record<string, unknown>)) {
    if (typeof child === 'object' && child !== null) {
      collectSchemaLeaves(child as Record<string, unknown>, out)
    }
  }
}

/** Effective config pin of the served payload ('' → undefined). */
export function settingsConfigPin(effective: SettingsEffectiveWire): string | undefined {
  const pin = effective.config_pin
  return pin !== undefined && pin !== '' ? pin : undefined
}

/** Build the full dynamic Settings model from the two CONFIG-01 endpoints.
 *  Pure — no DOM, no fetch; the modal passes the wire payloads. */
export function settingsConfigModel(
  schema: SettingsSchemaWire,
  effective: SettingsEffectiveWire,
): SettingsConfigSection[] {
  const leaves: Array<{ key: string; leaf: Record<string, unknown> }> = []
  const props = schema.properties
  if (typeof props === 'object' && props !== null) {
    for (const node of Object.values(props)) {
      if (typeof node === 'object' && node !== null) {
        collectSchemaLeaves(node as Record<string, unknown>, leaves)
      }
    }
  }
  const config = effective.config ?? {}
  const byScope = new Map<string, SettingsConfigField[]>()
  for (const scope of SETTINGS_CONFIG_SCOPES) byScope.set(scope, [])
  for (const { key, leaf } of leaves) {
    const scope = typeof leaf['x-dsh-scope'] === 'string' ? leaf['x-dsh-scope'] as string : ''
    const sources = Array.isArray(leaf['x-dsh-sources'])
      ? leaf['x-dsh-sources'].filter((value): value is string => typeof value === 'string')
      : []
    const writeScopes = Array.isArray(leaf['x-dsh-write-scopes'])
      ? leaf['x-dsh-write-scopes'].filter((value): value is SettingsConfigWriteScope =>
        value === 'global' || value === 'project' || value === 'runtime')
      : []
    const field: SettingsConfigField = {
      key,
      labelKey: `shell.settings.key.${key}`,
      scope,
      kind: schemaLeafKind(leaf),
      enumValues: Array.isArray(leaf.enum) ? leaf.enum : [],
      default: leaf.default,
      value: Object.prototype.hasOwnProperty.call(config, key) ? config[key] : undefined,
      presentInEffective: Object.prototype.hasOwnProperty.call(config, key),
      secret: leaf['x-dsh-secret'] === true,
      securityFloor: leaf['x-dsh-security-floor'] === true,
      env: typeof leaf['x-dsh-env'] === 'string' ? leaf['x-dsh-env'] : undefined,
      sources,
      writeScopes,
      reload: leaf['x-dsh-apply'] === 'hot' ? 'hot' : 'restart',
      description: typeof leaf.description === 'string' ? leaf.description : '',
      minimum: typeof leaf.minimum === 'number' ? leaf.minimum : undefined,
      maximum: typeof leaf.maximum === 'number' ? leaf.maximum : undefined,
      minLength: typeof leaf.minLength === 'number' ? leaf.minLength : undefined,
      pattern: typeof leaf.pattern === 'string' ? leaf.pattern : undefined,
    }
    const bucket = byScope.get(scope)
    if (bucket !== undefined) bucket.push(field)
  }
  const sections: SettingsConfigSection[] = []
  for (const scope of SETTINGS_CONFIG_SCOPES) {
    const fields = byScope.get(scope) ?? []
    sections.push({
      id: `config-${scope}`,
      scope,
      titleKey: `shell.settings.scope.${scope}`,
      summaryKey: 'shell.settings.source.effective',
      fields,
    })
  }
  return sections
}

/** Sections for the Settings modal given registry-data availability. With
 *  CONFIG-01 data the runner/workspace/terminal/tex/agent placeholder
 *  sections are replaced by the schema-generated scope sections (rendered by
 *  the DOM layer between preferences and the config-provenance section);
 *  without the data the honest placeholders remain. */
export function settingsSectionsForData(hasConfig: boolean): SettingsSectionDef[] {
  const all = settingsSections()
  if (!hasConfig) return all
  return all.filter(section => !section.rows.some(row => row.id.endsWith('.placeholder')))
}

export interface SettingsConfigWriteContext {
  projectId?: string
}

export interface SettingsConfigTransactionInput {
  operations: Array<{
    kind: 'config'
    scope: SettingsConfigWriteScope
    scope_id: string
    expected_revision: number
    changes: Record<string, unknown>
  }>
}

export class SettingsConfigInputError extends TypeError {
  constructor(readonly key: string, readonly code: string) {
    super(`invalid Settings value for ${key}: ${code}`)
    this.name = 'SettingsConfigInputError'
  }
}

/** Parse one generated control into the canonical JSON value. Secret fields
 * accept strict SecretRef JSON metadata only; plaintext is never a valid
 * browser Settings value. */
export function settingsParseFieldValue(field: SettingsConfigField, raw: string): unknown {
  const input = raw.trim()
  if (field.secret) {
    let parsed: unknown
    try { parsed = JSON.parse(input) as unknown } catch { throw new TypeError('SecretRef must be JSON metadata') }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new TypeError('SecretRef must be an object')
    const record = parsed as Record<string, unknown>
    const keys = Object.keys(record)
    if (keys.some(key => !['scheme', 'name', 'version', 'scope'].includes(key))
      || !['file', 'keyring', 'vault'].includes(String(record.scheme))
      || typeof record.name !== 'string' || record.name.trim() === ''
      || (record.version !== undefined && typeof record.version !== 'string')
      || (record.scope !== undefined && typeof record.scope !== 'string')) {
      throw new TypeError('SecretRef accepts only scheme, name, version and scope metadata')
    }
    return {
      scheme: record.scheme,
      name: record.name.trim(),
      ...(record.version === undefined || record.version === '' ? {} : { version: record.version }),
      ...(record.scope === undefined || record.scope === '' ? {} : { scope: record.scope }),
    }
  }
  if (input === 'null' && field.default === null) return null
  const error = validateSettingsField(field, input)
  if (error !== null) throw new TypeError(error.code)
  if (field.kind === 'number') return Number(input)
  if (field.kind === 'boolean') return input === 'true'
  if (field.kind === 'enum' || field.kind === 'string') return input
  throw new TypeError(`config field ${field.key} has no editable control`)
}

/** Build one atomic multi-layer config transaction from dirty generated
 * controls. Missing revisions/context and read-only fields fail closed. */
export function settingsConfigTransaction(
  fields: readonly SettingsConfigField[],
  edits: ReadonlyMap<string, string>,
  effective: SettingsEffectiveWire,
  context: SettingsConfigWriteContext,
): SettingsConfigTransactionInput {
  const revisions = effective.revisions
  if (revisions === undefined) throw new TypeError('config revisions are unavailable')
  const groups = new Map<string, { scope: SettingsConfigWriteScope; scope_id: string; expected_revision: number; changes: Record<string, unknown> }>()
  for (const [key, raw] of edits) {
    const field = fields.find(candidate => candidate.key === key)
    if (field === undefined) throw new TypeError(`unknown config field ${key}`)
    if (field.writeScopes.length !== 1) throw new TypeError(`config field ${key} is not writable`)
    const scope = field.writeScopes[0]!
    const scopeId = scope === 'global' ? 'global' : scope === 'project' ? context.projectId : field.scope
    const revision = scope === 'global' ? revisions.global : scope === 'project' ? revisions.project : revisions.runtime[scopeId ?? '']
    if (scopeId === undefined || revision === null) throw new TypeError(`config ${scope} write context is unavailable`)
    if (revision === undefined) throw new TypeError(`config ${scope}/${scopeId} revision is unavailable`)
    const groupKey = `${scope}\u0000${scopeId}`
    let group = groups.get(groupKey)
    if (group === undefined) {
      group = { scope, scope_id: scopeId, expected_revision: revision, changes: {} }
      groups.set(groupKey, group)
    }
    if (group.scope_id !== scopeId) throw new TypeError(`config ${scope} write context is ambiguous`)
    try {
      group.changes[key] = settingsParseFieldValue(field, raw)
    } catch (error) {
      const knownCode = error instanceof TypeError && /^[a-z_]+$/.test(error.message)
        ? error.message
        : field.secret ? 'secret_ref_required' : 'validation_error'
      throw new SettingsConfigInputError(key, knownCode)
    }
  }
  const order: Readonly<Record<SettingsConfigWriteScope, number>> = { global: 0, project: 1, runtime: 2 }
  return {
    operations: [...groups.values()]
      .sort((left, right) => order[left.scope] - order[right.scope] || left.scope_id.localeCompare(right.scope_id))
      .map(group => ({ kind: 'config' as const, ...group })),
  }
}

/* ── local validation + server-error mapping (write-path machinery) ────── */

/** Structured local validation failure for one field's raw input. `code`
 *  maps to `shell.settings.error.<code>` (params carry the bounds). */
export interface SettingsFieldValidationError {
  code: 'invalid_number' | 'not_integer' | 'below_min' | 'above_max' | 'invalid_boolean' | 'invalid_enum' | 'too_short' | 'pattern_mismatch'
  min?: number
  max?: number
  minLength?: number
  values?: string
}

/** Local pre-submit validation of a raw string input against the field's
 *  schema-derived constraints (registry zod semantics). Returns null when
 *  the input is valid. Numbers must be finite integers within the declared
 *  bounds; booleans accept true/false; enums must be members; strings
 *  honour minLength/pattern. */
export function validateSettingsField(field: SettingsConfigField, raw: string): SettingsFieldValidationError | null {
  const input = raw.trim()
  if (field.kind === 'number') {
    const value = Number(input)
    if (!Number.isFinite(value)) return { code: 'invalid_number' }
    if (!Number.isInteger(value)) return { code: 'not_integer' }
    if (field.minimum !== undefined && value < field.minimum) return { code: 'below_min', min: field.minimum }
    if (field.maximum !== undefined && value > field.maximum) return { code: 'above_max', max: field.maximum }
    return null
  }
  if (field.kind === 'boolean') {
    return input === 'true' || input === 'false' ? null : { code: 'invalid_boolean' }
  }
  if (field.kind === 'enum') {
    return field.enumValues.includes(input)
      ? null
      : { code: 'invalid_enum', values: field.enumValues.map(v => String(v)).join(', ') }
  }
  if (field.kind === 'string') {
    if (field.minLength !== undefined && input.length < field.minLength) return { code: 'too_short', minLength: field.minLength }
    if (field.pattern !== undefined) {
      try {
        if (!new RegExp(field.pattern).test(input)) return { code: 'pattern_mismatch' }
      } catch { /* invalid regex from the schema — treat as no constraint */ }
    }
    return null
  }
  return null
}

/** One server-reported error mapped onto a Settings field. */
export interface SettingsServerFieldError {
  key: string
  code: string
  message: string
}

export interface SettingsServerErrorMap {
  byKey: Map<string, SettingsServerFieldError>
  /** Envelope entries that name no known field (e.g. an unknown key the
   *  registry rejected — surfaced as a general note, never a fake field). */
  unmatched: SettingsServerFieldError[]
}

/** Map a kernel error envelope ({code, message, key}) onto Settings fields.
 * The structured key is authoritative; display text is never parsed as a
 * second protocol. */
export function mapSettingsServerErrors(
  fields: readonly SettingsConfigField[],
  envelope: { code?: string; message?: string; key?: string },
): SettingsServerErrorMap {
  const byKey = new Map<string, SettingsServerFieldError>()
  const unmatched: SettingsServerFieldError[] = []
  const code = envelope.code ?? 'http_error'
  const message = envelope.message ?? ''
  const knownKeys = new Set(fields.map(f => f.key))
  const key = envelope.key
  const entry = { key: key ?? '', code, message }
  if (key !== undefined && knownKeys.has(key)) byKey.set(key, entry)
  else unmatched.push(entry)
  return { byKey, unmatched }
}

/** Display kind of one field's value (the DOM layer translates the kinds;
 *  the model stays locale-free). Secrets never show a value — only the
 *  set-but-hidden mask (shell.settings.secretSet); absent keys show the
 *  schema default. */
export type SettingsValueDisplayKind = 'secret' | 'none' | 'absent' | 'value'

export function settingsFieldDisplay(field: SettingsConfigField): { kind: SettingsValueDisplayKind; value: unknown } {
  if (field.secret && field.presentInEffective) return { kind: 'secret', value: field.value }
  if (!field.presentInEffective) return { kind: 'absent', value: field.default }
  if (field.value === null || field.value === undefined) return { kind: 'none', value: null }
  return { kind: 'value', value: field.value }
}
