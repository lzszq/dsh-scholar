/** Durable canonical Settings writes (REVIEW-CONFIG-WRITE-03).
 *
 * This module owns only the layered config ledger. The ResearchKernel facade
 * supplies authorization and composes OCR/Runner resource operations around
 * `transact()` in the same SQLite transaction.
 */
import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import {
  CONFIG_REGISTRY,
  ConfigWriteTransactionInput,
  SecretRef,
  defaultConfigForScopes,
  getConfigKey,
  pinConfig,
  validateConfig,
  ConfigRegistryError,
  type ConfigEffectiveSafeView,
  type ConfigLayerSafeView,
  type ConfigPatchOperation,
  type ConfigWriteReceipt,
  type ConfigWriteScope,
} from '@dsh-scholar/research-schemas'

export const CONFIG_WRITE_DDL = `
CREATE TABLE IF NOT EXISTS config_write_layers (
  write_scope TEXT NOT NULL CHECK (write_scope IN ('global','project','runtime')),
  scope_id TEXT NOT NULL CHECK (scope_id <> ''),
  revision INTEGER NOT NULL CHECK (revision >= 0),
  config_json TEXT NOT NULL CHECK (json_valid(config_json) AND json_type(config_json) = 'object'),
  config_pin TEXT NOT NULL CHECK (
    length(config_pin) = 71
    AND substr(config_pin, 1, 7) = 'sha256:'
    AND substr(config_pin, 8) NOT GLOB '*[^0-9a-f]*'
  ),
  updated_by TEXT NOT NULL CHECK (updated_by <> ''),
  updated_at TEXT NOT NULL,
  PRIMARY KEY (write_scope, scope_id)
);
CREATE TABLE IF NOT EXISTS config_write_revisions (
  revision_id TEXT PRIMARY KEY,
  write_scope TEXT NOT NULL CHECK (write_scope IN ('global','project','runtime')),
  scope_id TEXT NOT NULL CHECK (scope_id <> ''),
  revision INTEGER NOT NULL CHECK (revision > 0),
  changes_json TEXT NOT NULL CHECK (json_valid(changes_json) AND json_type(changes_json) = 'object'),
  config_json TEXT NOT NULL CHECK (json_valid(config_json) AND json_type(config_json) = 'object'),
  config_pin TEXT NOT NULL CHECK (
    length(config_pin) = 71
    AND substr(config_pin, 1, 7) = 'sha256:'
    AND substr(config_pin, 8) NOT GLOB '*[^0-9a-f]*'
  ),
  updated_by TEXT NOT NULL CHECK (updated_by <> ''),
  updated_at TEXT NOT NULL,
  UNIQUE (write_scope, scope_id, revision),
  FOREIGN KEY (write_scope, scope_id) REFERENCES config_write_layers(write_scope, scope_id)
);
CREATE INDEX IF NOT EXISTS idx_config_write_revisions_layer
  ON config_write_revisions(write_scope, scope_id, revision);
`

interface ConfigLayerRow {
  write_scope: ConfigWriteScope
  scope_id: string
  revision: number
  config_json: string
  config_pin: string
  updated_by: string
  updated_at: string
}

interface PendingConfigLayer {
  operation: ConfigPatchOperation
  revision: number
  previous: Record<string, unknown>
  values: Record<string, unknown>
}

export interface ConfigWriteStoreOptions {
  /** Process-start config merged above built-ins for effective views. */
  baseConfig?: Readonly<Record<string, unknown>>
  /** Exact lock values used by validateConfig's digest security floor. */
  imagesLock?: Readonly<{ node_fixture?: string; texlive?: string }> | null
  /** The projects table is the sole project execution/integrity authority.
   * Config layers retain only Settings CAS/history and must never be read as
   * a second business-state source. All methods run on this store's current
   * SQLite transaction. */
  projectAuthority?: ConfigWriteProjectAuthority
}

export interface ConfigWriteProjectAuthority {
  read(projectId: string): Readonly<Record<string, unknown>> | null
  list(): Array<{ project_id: string; config: Readonly<Record<string, unknown>> }>
  apply(input: {
    project_id: string
    changes: Readonly<Record<string, unknown>>
    actor: string
  }): Readonly<Record<string, unknown>>
}

export class ConfigWriteStoreError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly key?: string,
  ) {
    super(message)
    this.name = 'ConfigWriteStoreError'
  }
}

/** Read one owner runtime layer for process startup. This is deliberately a
 * strict raw read (secrets remain SecretRef metadata) rather than the public
 * redacted view: launchers consume it before constructing the real runtime.
 * A corrupt pin, foreign owner key or invalid value aborts startup. */
export function readRuntimeConfigForOwner(db: DatabaseSync, owner: string): Record<string, unknown> {
  const row = db.prepare(`SELECT config_json, config_pin FROM config_write_layers
    WHERE write_scope = 'runtime' AND scope_id = ?`).get(owner) as { config_json: string; config_pin: string } | undefined
  if (row === undefined) return {}
  const values = parseConfigJson(row.config_json, 'runtime', owner)
  if (pinConfig(values) !== row.config_pin) {
    throw new ConfigWriteStoreError(500, 'config_layer_corrupt', `runtime config layer ${owner} failed its content pin`)
  }
  const normalized: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(values)) {
    const definition = getConfigKey(key)
    if (definition === undefined || definition.scope !== owner || !definition.write.allowedScopes.includes('runtime')) {
      throw new ConfigWriteStoreError(500, 'config_runtime_scope_forbidden', `runtime config key ${key} does not belong to ${owner}`, key)
    }
    if (definition.secret === true) {
      const parsed = SecretRef.safeParse(value)
      if (!parsed.success) throw new ConfigWriteStoreError(500, 'secret_ref_required', `runtime config key ${key} is not a SecretRef`, key)
      normalized[key] = parsed.data
    } else {
      const parsed = definition.schema.safeParse(value)
      if (!parsed.success) throw new ConfigWriteStoreError(500, 'validation_error', `runtime config key ${key} is invalid`, key)
      normalized[key] = parsed.data
    }
  }
  return normalized
}

function nowIso(): string { return new Date().toISOString() }

function parseConfigJson(json: string, scope: ConfigWriteScope, scopeId: string): Record<string, unknown> {
  try {
    const value = JSON.parse(json) as unknown
    if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new TypeError('config must be an object')
    return value as Record<string, unknown>
  } catch {
    throw new ConfigWriteStoreError(500, 'config_layer_corrupt', `config layer ${scope}/${scopeId} is corrupt`)
  }
}

function safeSecretRef(value: unknown): unknown {
  const parsed = SecretRef.safeParse(value)
  return parsed.success ? { ...parsed.data, redacted: true } : '<redacted>'
}

function safeConfig(config: Readonly<Record<string, unknown>>): Record<string, unknown> {
  const safe: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(config)) {
    safe[key] = getConfigKey(key)?.secret === true ? safeSecretRef(value) : value
  }
  return safe
}

/** Re-validate durable bytes at every trust-boundary read. SQLite protects
 * shape constraints, but an offline restore/import can still carry a valid
 * JSON object whose pin, scope, value type or SecretRef metadata is wrong. */
function persistedLayerValues(row: ConfigLayerRow): Record<string, unknown> {
  const values = parseConfigJson(row.config_json, row.write_scope, row.scope_id)
  if (pinConfig(values) !== row.config_pin) {
    throw new ConfigWriteStoreError(500, 'config_layer_pin_mismatch',
      `config layer ${row.write_scope}/${row.scope_id} does not match its pin`)
  }
  for (const [key, value] of Object.entries(values)) {
    const definition = getConfigKey(key)
    if (definition === undefined
      || !definition.write.allowedScopes.includes(row.write_scope)
      || (row.write_scope === 'runtime' && definition.scope !== row.scope_id)) {
      throw new ConfigWriteStoreError(500, 'config_layer_corrupt',
        `config layer ${row.write_scope}/${row.scope_id} contains an invalid key`, key)
    }
    const parsed = definition.secret === true
      ? SecretRef.safeParse(value)
      : definition.schema.safeParse(value)
    if (!parsed.success) {
      throw new ConfigWriteStoreError(500, 'config_layer_corrupt',
        `config layer ${row.write_scope}/${row.scope_id} contains an invalid value`, key)
    }
  }
  return values
}

function layerView(row: ConfigLayerRow | undefined, scope: ConfigWriteScope, scopeId: string): ConfigLayerSafeView {
  if (row === undefined) {
    return {
      scope, scope_id: scopeId, revision: 0, config: {}, config_pin: pinConfig({}),
      updated_by: null, updated_at: null,
    }
  }
  return {
    scope,
    scope_id: scopeId,
    revision: row.revision,
    config: safeConfig(persistedLayerValues(row)),
    config_pin: row.config_pin,
    updated_by: row.updated_by,
    updated_at: row.updated_at,
  }
}

function asStoreError(error: unknown): Error {
  if (error instanceof ConfigWriteStoreError) return error
  if (error instanceof ConfigRegistryError) {
    return new ConfigWriteStoreError(422, error.code, error.message, error.key)
  }
  // Domain authorities may return their own stable HTTP-shaped error (for
  // example runner_target_disabled). Preserve it so the canonical Settings
  // route does not erase a precise conflict into a generic config error.
  if (error instanceof Error
    && typeof (error as { status?: unknown }).status === 'number'
    && typeof (error as { code?: unknown }).code === 'string') return error
  return new ConfigWriteStoreError(422, 'config_patch_invalid', 'config patch does not match the canonical Settings schema')
}

export class ConfigWriteStore {
  private readonly baseConfig: Readonly<Record<string, unknown>>
  private readonly imagesLock: ConfigWriteStoreOptions['imagesLock']
  private readonly projectAuthority: ConfigWriteProjectAuthority | undefined

  constructor(private readonly db: DatabaseSync, options: ConfigWriteStoreOptions = {}) {
    this.baseConfig = options.baseConfig ?? {}
    this.imagesLock = options.imagesLock
    this.projectAuthority = options.projectAuthority
  }

  private row(scope: ConfigWriteScope, scopeId: string): ConfigLayerRow | undefined {
    return this.db.prepare(`SELECT write_scope, scope_id, revision, config_json, config_pin, updated_by, updated_at
      FROM config_write_layers WHERE write_scope = ? AND scope_id = ?`).get(scope, scopeId) as ConfigLayerRow | undefined
  }

  readLayer(scope: ConfigWriteScope, scopeId: string): ConfigLayerSafeView {
    if (scope === 'project') {
      const row = this.row(scope, scopeId)
      const layer = this.rawLayer(scope, scopeId)
      return {
        scope,
        scope_id: scopeId,
        revision: layer.revision,
        config: safeConfig(layer.values),
        config_pin: pinConfig(layer.values),
        updated_by: row?.updated_by ?? null,
        updated_at: row?.updated_at ?? null,
      }
    }
    return layerView(this.row(scope, scopeId), scope, scopeId)
  }

  listRevisions(scope: ConfigWriteScope, scopeId: string): Array<{
    revision_id: string
    scope: ConfigWriteScope
    scope_id: string
    revision: number
    changes: Record<string, unknown>
    config_pin: string
    updated_by: string
    updated_at: string
  }> {
    const rows = this.db.prepare(`SELECT revision_id, write_scope, scope_id, revision, changes_json, config_pin, updated_by, updated_at
      FROM config_write_revisions WHERE write_scope = ? AND scope_id = ? ORDER BY revision`).all(scope, scopeId) as unknown as Array<{
      revision_id: string; write_scope: ConfigWriteScope; scope_id: string; revision: number; changes_json: string
      config_pin: string; updated_by: string; updated_at: string
    }>
    return rows.map(row => ({
      revision_id: row.revision_id,
      scope: row.write_scope,
      scope_id: row.scope_id,
      revision: row.revision,
      changes: safeConfig(parseConfigJson(row.changes_json, row.write_scope, row.scope_id)),
      config_pin: row.config_pin,
      updated_by: row.updated_by,
      updated_at: row.updated_at,
    }))
  }

  private rawLayer(scope: ConfigWriteScope, scopeId: string | undefined): { revision: number; values: Record<string, unknown> } {
    if (scopeId === undefined) return { revision: 0, values: {} }
    const row = this.row(scope, scopeId)
    if (scope === 'project') {
      const values = this.canonicalProjectConfig(scopeId)
      if (row !== undefined && pinConfig(persistedLayerValues(row)) !== pinConfig(values)) {
        throw new ConfigWriteStoreError(500, 'config_project_projection_diverged',
          `project config audit projection diverged for ${scopeId}`)
      }
      return { revision: row?.revision ?? 0, values }
    }
    return row === undefined
      ? { revision: 0, values: {} }
      : { revision: row.revision, values: persistedLayerValues(row) }
  }

  private canonicalProjectConfig(projectId: string): Record<string, unknown> {
    if (this.projectAuthority === undefined) {
      throw new ConfigWriteStoreError(503, 'project_config_authority_unavailable',
        'canonical project configuration authority is unavailable')
    }
    const snapshot = this.projectAuthority.read(projectId)
    if (snapshot === null) throw new ConfigWriteStoreError(404, 'project_not_found', 'project not found')
    return this.validateCanonicalProjectConfig(projectId, snapshot)
  }

  private validateCanonicalProjectConfig(
    projectId: string,
    snapshot: Readonly<Record<string, unknown>>,
  ): Record<string, unknown> {
    const required = CONFIG_REGISTRY.filter(definition => definition.scope === 'project').map(definition => definition.key)
    const missing = required.filter(key => !(key in snapshot))
    if (missing.length > 0) {
      throw new ConfigWriteStoreError(500, 'project_config_authority_invalid',
        `canonical project config is missing ${missing.join(', ')}`)
    }
    try {
      return validateConfig({ ...snapshot }, { scopes: ['project'] }).effective
    } catch {
      throw new ConfigWriteStoreError(500, 'project_config_authority_invalid',
        `canonical project config is invalid for ${projectId}`)
    }
  }

  private assertSecurityProjection(
    next: ReadonlyMap<string, PendingConfigLayer>,
  ): void {
    const globalLayers = this.rawLayers('global')
    const runtimeLayers = this.rawLayers('runtime')
    const projectLayers = new Map<string, Record<string, unknown>>()
    if (this.projectAuthority !== undefined) {
      for (const project of this.projectAuthority.list()) {
        if (projectLayers.has(project.project_id)) {
          throw new ConfigWriteStoreError(500, 'project_config_authority_invalid',
            `canonical project config duplicated ${project.project_id}`)
        }
        projectLayers.set(project.project_id, this.canonicalProjectConfig(project.project_id))
      }
    } else if (this.rawLayers('project').size > 0
      || [...next.values()].some(item => item.operation.scope === 'project')) {
      throw new ConfigWriteStoreError(503, 'project_config_authority_unavailable',
        'canonical project configuration authority is unavailable')
    }
    for (const item of next.values()) {
      if (item.operation.scope === 'global') {
        globalLayers.set(item.operation.scope_id, { revision: item.revision, values: item.values })
      } else if (item.operation.scope === 'runtime') {
        runtimeLayers.set(item.operation.scope_id, { revision: item.revision, values: item.values })
      } else {
        projectLayers.set(item.operation.scope_id, item.values)
      }
    }
    const globalValues = globalLayers.get('global')?.values ?? {}
    const runtimeValues: Record<string, unknown> = {}
    for (const layer of runtimeLayers.values()) Object.assign(runtimeValues, layer.values)
    const projects = projectLayers.size === 0 ? [{}] : [...projectLayers.values()]
    for (const project of projects) {
      const merged: Record<string, unknown> = { ...this.baseConfig, ...globalValues, ...project, ...runtimeValues }
      const validationInput = Object.fromEntries(Object.entries(merged).filter(([key]) => getConfigKey(key)?.secret !== true))
      validateConfig(validationInput, { imagesLock: this.imagesLock })
    }
  }

  private rawLayers(scope: ConfigWriteScope): Map<string, { revision: number; values: Record<string, unknown> }> {
    const rows = this.db.prepare(`SELECT write_scope, scope_id, revision, config_json, config_pin, updated_by, updated_at
      FROM config_write_layers WHERE write_scope = ? ORDER BY scope_id`).all(scope) as unknown as ConfigLayerRow[]
    return new Map(rows.map(row => [row.scope_id, {
      revision: row.revision,
      values: persistedLayerValues(row),
    }]))
  }

  private changedKeys(scope: ConfigWriteScope, scopeId: string): string[] {
    const rows = this.db.prepare(`SELECT changes_json FROM config_write_revisions
      WHERE write_scope = ? AND scope_id = ? ORDER BY revision`).all(scope, scopeId) as Array<{ changes_json: string }>
    const keys = new Set<string>()
    for (const row of rows) {
      for (const key of Object.keys(parseConfigJson(row.changes_json, scope, scopeId))) keys.add(key)
    }
    return [...keys]
  }

  effective(context: { projectId?: string } = {}): ConfigEffectiveSafeView {
    const global = this.rawLayer('global', 'global')
    const project = this.rawLayer('project', context.projectId)
    const runtimes = this.rawLayers('runtime')
    const runtimeValues: Record<string, unknown> = {}
    for (const runtime of runtimes.values()) Object.assign(runtimeValues, runtime.values)
    const config: Record<string, unknown> = {
      ...defaultConfigForScopes(),
      ...this.baseConfig,
      ...global.values,
      ...project.values,
      ...runtimeValues,
    }
    // Persisted secrets are SecretRefs rather than runtime plaintext. They
    // are deliberately omitted from value-schema validation here; the
    // reference was strictly validated on write and the runtime resolver is
    // the only component allowed to turn it into a value.
    const validationInput = Object.fromEntries(Object.entries(config).filter(([key]) => getConfigKey(key)?.secret !== true))
    validateConfig(validationInput, { imagesLock: this.imagesLock })

    const provenance: ConfigEffectiveSafeView['provenance'] = {}
    for (const key of Object.keys(config)) provenance[key] = { scope: 'built-in', scope_id: 'built-in', revision: 0 }
    for (const key of Object.keys(global.values)) provenance[key] = { scope: 'global', scope_id: 'global', revision: global.revision }
    if (context.projectId !== undefined) {
      for (const key of Object.keys(project.values)) provenance[key] = { scope: 'project', scope_id: context.projectId, revision: project.revision }
    }
    for (const [runtimeId, runtime] of runtimes) {
      for (const key of Object.keys(runtime.values)) provenance[key] = { scope: 'runtime', scope_id: runtimeId, revision: runtime.revision }
    }
    const changedKeys = [...new Set([
      ...this.changedKeys('global', 'global'),
      ...(context.projectId === undefined ? [] : this.changedKeys('project', context.projectId)),
      ...[...runtimes.keys()].flatMap(runtimeId => this.changedKeys('runtime', runtimeId)),
    ])].sort()
    const hot = changedKeys.filter(key => getConfigKey(key)?.write.apply === 'hot')
    const restart = changedKeys.filter(key => getConfigKey(key)?.write.apply === 'restart')
    return {
      schema_version: 1,
      config: safeConfig(config),
      config_pin: pinConfig(config),
      revisions: {
        global: global.revision,
        project: context.projectId === undefined ? null : project.revision,
        runtime: Object.fromEntries(
          [...new Set(CONFIG_REGISTRY
            .filter(definition => definition.write.allowedScopes.includes('runtime'))
            .map(definition => definition.scope))]
            .sort()
            .map(owner => [owner, runtimes.get(owner)?.revision ?? 0]),
        ),
      },
      provenance,
      hot_applied_keys: hot,
      restart_required_keys: restart,
      restart_required: restart.length > 0,
    }
  }

  private validateChange(operation: ConfigPatchOperation, key: string, value: unknown): unknown {
    const definition = getConfigKey(key)
    if (definition === undefined) {
      throw new ConfigWriteStoreError(422, 'unknown_config_key', `unknown config key ${JSON.stringify(key)}`, key)
    }
    if (!definition.write.allowedScopes.includes(operation.scope)) {
      throw new ConfigWriteStoreError(422, 'config_scope_forbidden', `config key ${key} cannot be written at ${operation.scope} scope`, key)
    }
    if (operation.scope === 'runtime') {
      const owner = definition.scope
      if (operation.scope_id !== owner) {
        throw new ConfigWriteStoreError(422, 'config_runtime_scope_forbidden',
          `config key ${key} belongs to runtime ${owner}, not ${operation.scope_id}`, key)
      }
    }
    if (definition.secret === true) {
      const parsed = SecretRef.safeParse(value)
      if (!parsed.success) {
        throw new ConfigWriteStoreError(422, 'secret_ref_required', `config key ${key} accepts only SecretRef metadata`, key)
      }
      return parsed.data
    }
    const parsed = definition.schema.safeParse(value)
    if (!parsed.success) {
      throw new ConfigWriteStoreError(422, 'validation_error', `invalid value for config key ${key}`, key)
    }
    return parsed.data
  }

  /**
   * Apply one global/project/runtime patch per layer atomically. The method
   * joins an existing DatabaseSync transaction, allowing the Kernel Settings
   * coordinator to include OCR Provider/binding and Runner Target operations
   * in the same commit.
   */
  transact(raw: unknown, actor: string): ConfigWriteReceipt {
    let input: ConfigWriteTransactionInput
    try { input = ConfigWriteTransactionInput.parse(raw) } catch (error) { throw asStoreError(error) }
    if (actor.trim() === '') throw new ConfigWriteStoreError(403, 'config_actor_required', 'config write requires an authenticated principal')
    const seenTargets = new Set<string>()
    for (const operation of input.operations) {
      const target = `${operation.scope}\u0000${operation.scope_id}`
      if (seenTargets.has(target)) throw new ConfigWriteStoreError(422, 'config_patch_duplicate', 'a config transaction may patch each layer once')
      if (operation.scope !== 'runtime' && [...seenTargets].some(existing => existing.startsWith(`${operation.scope}\u0000`))) {
        throw new ConfigWriteStoreError(422, 'config_transaction_context_ambiguous', `a config transaction may target one ${operation.scope} layer`)
      }
      seenTargets.add(target)
    }

    const ownsTransaction = !this.db.isTransaction
    if (ownsTransaction) this.db.exec('BEGIN IMMEDIATE')
    try {
      const next = new Map<string, PendingConfigLayer>()
      for (const operation of input.operations) {
        const current = this.rawLayer(operation.scope, operation.scope_id)
        if (current.revision !== operation.expected_revision) {
          throw new ConfigWriteStoreError(409, 'config_revision_conflict',
            `config layer ${operation.scope}/${operation.scope_id} revision changed`)
        }
        const values = { ...current.values }
        for (const [key, value] of Object.entries(operation.changes)) values[key] = this.validateChange(operation, key, value)
        next.set(`${operation.scope}\u0000${operation.scope_id}`, {
          operation,
          revision: current.revision + 1,
          previous: current.values,
          values,
        })
      }

      // Validate the requested projection before invoking the canonical
      // project authority, so known policy failures perform no domain write.
      this.assertSecurityProjection(next)
      for (const item of next.values()) {
        if (item.operation.scope !== 'project') continue
        const authority = this.projectAuthority
        if (authority === undefined) {
          throw new ConfigWriteStoreError(503, 'project_config_authority_unavailable',
            'canonical project configuration authority is unavailable')
        }
        const normalizedChanges = Object.fromEntries(
          Object.keys(item.operation.changes).map(key => [key, item.values[key]]),
        )
        const applied = authority.apply({
          project_id: item.operation.scope_id,
          changes: normalizedChanges,
          actor,
        })
        const appliedConfig = this.validateCanonicalProjectConfig(item.operation.scope_id, applied)
        const canonical = this.canonicalProjectConfig(item.operation.scope_id)
        if (pinConfig(appliedConfig) !== pinConfig(canonical)) {
          throw new ConfigWriteStoreError(500, 'project_config_authority_invalid',
            `canonical project apply/read mismatch for ${item.operation.scope_id}`)
        }
        for (const [key, value] of Object.entries(item.values)) {
          if (key in item.operation.changes && !Object.is(canonical[key], value)) {
            throw new ConfigWriteStoreError(500, 'project_config_authority_invalid',
              `canonical project config did not apply ${key}`, key)
          }
        }
        // The authority may derive related fields (for example choosing a
        // compatible runner profile when the target changes). Persist that
        // exact canonical snapshot in the CAS/audit projection.
        item.values = canonical
      }
      this.assertSecurityProjection(next)

      const now = nowIso()
      const transactionChangedKeys = new Set<string>()
      for (const item of next.values()) {
        const { operation, revision, values } = item
        const pin = pinConfig(values)
        const actualChanges = Object.fromEntries(Object.entries(values)
          .filter(([key, value]) => !Object.is(item.previous[key], value)))
        for (const key of Object.keys(actualChanges)) transactionChangedKeys.add(key)
        const result = this.db.prepare(`INSERT INTO config_write_layers
          (write_scope, scope_id, revision, config_json, config_pin, updated_by, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(write_scope, scope_id) DO UPDATE SET
            revision=excluded.revision, config_json=excluded.config_json, config_pin=excluded.config_pin,
            updated_by=excluded.updated_by, updated_at=excluded.updated_at
          WHERE config_write_layers.revision = ?`).run(
          operation.scope, operation.scope_id, revision, JSON.stringify(values), pin, actor, now,
          operation.expected_revision,
        )
        if (Number(result.changes) !== 1) throw new ConfigWriteStoreError(409, 'config_revision_conflict', 'config layer changed during commit')
        this.db.prepare(`INSERT INTO config_write_revisions
          (revision_id, write_scope, scope_id, revision, changes_json, config_json, config_pin, updated_by, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
          `cfgrev_${randomUUID()}`, operation.scope, operation.scope_id, revision,
          JSON.stringify(actualChanges),
          JSON.stringify(values), pin, actor, now,
        )
      }
      const projectId = input.operations.find(operation => operation.scope === 'project')?.scope_id
      const changedKeys = [...transactionChangedKeys].sort()
      const hot = changedKeys.filter(key => getConfigKey(key)?.write.apply === 'hot')
      const restart = changedKeys.filter(key => getConfigKey(key)?.write.apply === 'restart')
      const receipt: ConfigWriteReceipt = {
        layers: input.operations.map(operation => this.readLayer(operation.scope, operation.scope_id)),
        effective: this.effective({ projectId }),
        verdict: {
          hot_applied_keys: hot,
          restart_required_keys: restart,
          restart_required: restart.length > 0,
        },
      }
      // Receipt construction performs integrity checks against the canonical
      // project authority. Keep those checks inside the transaction so an
      // error can never be reported after the mutation was already committed.
      if (ownsTransaction) this.db.exec('COMMIT')
      return receipt
    } catch (error) {
      if (ownsTransaction && this.db.isTransaction) this.db.exec('ROLLBACK')
      throw asStoreError(error)
    }
  }
}
