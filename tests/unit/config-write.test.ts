import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  CONFIG_REGISTRY,
  SettingsWriteTransactionInput,
  defaultConfigForScopes,
  generateJsonSchema,
  pinConfig,
} from '@dsh-scholar/research-schemas'
import {
  CONFIG_WRITE_DDL,
  ConfigWriteStore,
  ConfigWriteStoreError,
  type ConfigWriteProjectAuthority,
} from '../../packages/research-kernel/src/config-write-store'
import { SettingsWriteCoordinator } from '../../packages/research-kernel/src/settings-write-coordinator'

const temporaryDirectories: string[] = []

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

function schemaLeaf(key: string): Record<string, unknown> {
  const schema = generateJsonSchema()
  const definition = CONFIG_REGISTRY.find(candidate => candidate.key === key)
  expect(definition).toBeDefined()
  const scope = definition!.scope
  const segments = key.split('.')
  const inner = segments[0] === scope ? segments.slice(1) : segments
  let node = (schema.properties as Record<string, Record<string, unknown>>)[scope]!
  for (const segment of inner) node = (node.properties as Record<string, Record<string, unknown>>)[segment]!
  return node
}

function configDatabase(path = ':memory:'): DatabaseSync {
  const db = new DatabaseSync(path)
  db.exec(CONFIG_WRITE_DDL)
  return db
}

function projectAuthority(projectIds: readonly string[]): ConfigWriteProjectAuthority & {
  configs: Map<string, Record<string, unknown>>
} {
  const defaults = defaultConfigForScopes(['project'])
  const configs = new Map(projectIds.map(projectId => [projectId, { ...defaults }]))
  return {
    configs,
    read: projectId => configs.get(projectId) ?? null,
    list: () => [...configs].map(([project_id, config]) => ({ project_id, config })),
    apply: ({ project_id, changes }) => {
      const current = configs.get(project_id)
      if (current === undefined) throw new ConfigWriteStoreError(404, 'project_not_found', 'project not found')
      const next = { ...current, ...changes }
      configs.set(project_id, next)
      return next
    },
  }
}

const TEST_PROJECT_IDS = ['rsp_config', 'rsp_airgap', 'rsp_durable', 'rsp_atomic', 'rsp_rollback'] as const

function configStore(db: DatabaseSync, authority = projectAuthority(TEST_PROJECT_IDS)): ConfigWriteStore {
  return new ConfigWriteStore(db, { projectAuthority: authority })
}

describe('REVIEW-CONFIG-WRITE-03 canonical generated write contract', () => {
  it('generates allowed write scopes, sources and an explicit apply verdict from each descriptor', () => {
    expect(schemaLeaf('execution.network_policy')).toMatchObject({
      'x-dsh-key': 'execution.network_policy',
      'x-dsh-write-scopes': ['project'],
      'x-dsh-sources': ['http', 'ui', 'file'],
      'x-dsh-apply': 'hot',
      'x-dsh-security-merge': 'more-restrictive-only',
    })
    expect(schemaLeaf('global.images_lock.path')).toMatchObject({
      'x-dsh-write-scopes': [],
      'x-dsh-apply': 'restart',
    })
    expect(schemaLeaf('kernel.token')).toMatchObject({
      'x-dsh-write-scopes': [],
      'x-dsh-secret-input': 'secret-ref',
      'x-dsh-apply': 'restart',
    })
    expect(schemaLeaf('kernel.require_signed_manifest')).toMatchObject({
      'x-dsh-write-scopes': ['runtime'],
      'x-dsh-apply': 'restart',
    })
    expect(schemaLeaf('standalone.no_token')).toMatchObject({
      'x-dsh-write-scopes': [],
    })
  })

  it('strictly describes config, OCR and Runner writes as one Settings transaction', () => {
    const parsed = SettingsWriteTransactionInput.parse({
      operations: [
        {
          kind: 'config', scope: 'project', scope_id: 'rsp_config', expected_revision: 2,
          changes: { 'execution.network_policy': 'none' },
        },
        {
          kind: 'ocr-mineru',
          provider: {
            action: 'update', provider_id: 'mineru', expected_revision: 3,
            patch: { enabled: true, credential: { scheme: 'file', name: 'mineru/token' } },
          },
          binding: {
            project_id: 'rsp_config', expected_revision: 1, expected_provider_revision: 4,
            model_id: 'vlm',
          },
        },
        {
          kind: 'runner-target', action: 'update', target_id: 'gpu-lab',
          patch: { expected_revision: 5, draining: true },
        },
      ],
    })
    expect(parsed.operations).toHaveLength(3)
    expect(() => SettingsWriteTransactionInput.parse({
      operations: [{
        kind: 'ocr-mineru',
        provider: {
          action: 'update', provider_id: 'mineru', expected_revision: 3,
          patch: { credential: { scheme: 'file', name: 'x', value: 'plaintext' } },
        },
      }],
    })).toThrow()
  })
})

describe('REVIEW-CONFIG-WRITE-03 durable config write transaction', () => {
  it('does not create schema as a runtime fallback and exposes revision zero for every writable runtime owner', () => {
    const unmigrated = new DatabaseSync(':memory:')
    new ConfigWriteStore(unmigrated)
    expect((unmigrated.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name LIKE 'config_write_%'").get() as { n: number }).n).toBe(0)
    unmigrated.close()

    const db = configDatabase()
    expect(configStore(db).effective().revisions.runtime).toEqual({ kernel: 0 })
    db.close()
  })

  it('uses the canonical project row as the only project baseline and fails closed on projection divergence', () => {
    const db = configDatabase()
    const authority = projectAuthority(['rsp_canonical'])
    authority.configs.set('rsp_canonical', {
      ...authority.configs.get('rsp_canonical')!,
      'execution.network_policy': 'none',
    })
    const store = configStore(db, authority)
    expect(store.effective({ projectId: 'rsp_canonical' })).toMatchObject({
      revisions: { project: 0 },
      config: { 'execution.network_policy': 'none' },
    })
    store.transact({ operations: [{
      kind: 'config', scope: 'project', scope_id: 'rsp_canonical', expected_revision: 0,
      changes: { 'integrity.require_clean_room_rerun': true },
    }] }, 'principal_pi')
    expect(authority.configs.get('rsp_canonical')).toMatchObject({
      'integrity.require_clean_room_rerun': true,
    })

    authority.configs.get('rsp_canonical')!['integrity.require_clean_room_rerun'] = false
    expect(() => store.effective({ projectId: 'rsp_canonical' }))
      .toThrowError(expect.objectContaining({ code: 'config_project_projection_diverged' }))
    db.close()
  })

  it('atomically writes project and actually-consumed runtime layers with revision CAS and a deterministic effective pin', () => {
    const db = configDatabase()
    const store = configStore(db)
    const first = store.transact({
      operations: [
        {
          kind: 'config', scope: 'project', scope_id: 'rsp_config', expected_revision: 0,
          changes: { 'execution.network_policy': 'none', 'integrity.require_clean_room_rerun': true },
        },
        {
          kind: 'config', scope: 'runtime', scope_id: 'kernel', expected_revision: 0,
          changes: { 'kernel.require_signed_manifest': true },
        },
      ],
    }, 'principal_pi')

    expect(first.layers.map(layer => [layer.scope, layer.scope_id, layer.revision])).toEqual([
      ['project', 'rsp_config', 1], ['runtime', 'kernel', 1],
    ])
    expect(first.effective.config['execution.network_policy']).toBe('none')
    expect(first.effective.hot_applied_keys).toEqual([
      'execution.network_policy', 'integrity.require_clean_room_rerun',
    ])
    expect(first.effective.restart_required_keys).toEqual([
      'kernel.require_signed_manifest',
    ])
    expect(first.verdict).toEqual({
      hot_applied_keys: ['execution.network_policy', 'integrity.require_clean_room_rerun'],
      restart_required_keys: ['kernel.require_signed_manifest'],
      restart_required: true,
    })
    expect(first.effective.config_pin).toMatch(/^sha256:[0-9a-f]{64}$/)

    expect(() => store.transact({ operations: [{
      kind: 'config', scope: 'project', scope_id: 'rsp_config', expected_revision: 0,
      changes: { 'integrity.require_baseline_reproduction': false },
    }] }, 'principal_pi')).toThrowError(expect.objectContaining({ code: 'config_revision_conflict' }))
    expect(store.readLayer('project', 'rsp_config').revision).toBe(1)
  })

  it('rejects an unknown key, a wrong layer, invalid values and security-floor relaxation before any write', () => {
    const db = configDatabase()
    const store = configStore(db)
    const cases: Array<{ changes: Record<string, unknown>; code: string; scope?: 'project' | 'runtime' }> = [
      { changes: { 'not.registered': true }, code: 'unknown_config_key' },
      { changes: { 'kernel.port': 7413 }, code: 'config_scope_forbidden' },
      { changes: { 'execution.network_policy': 'internet' }, code: 'validation_error' },
      { changes: { 'integrity.allow_automatic_public_release': true }, code: 'security_floor_violation' },
      { changes: { 'runner.privileged': true }, code: 'config_scope_forbidden', scope: 'runtime' },
    ]
    for (const item of cases) {
      try {
        store.transact({ operations: [{
          kind: 'config', scope: item.scope ?? 'project', scope_id: item.scope === 'runtime' ? 'runner-profile' : 'rsp_config',
          expected_revision: 0, changes: item.changes,
        }] }, 'principal_pi')
        expect.fail(`expected ${item.code}`)
      } catch (error) {
        expect(error).toBeInstanceOf(ConfigWriteStoreError)
        expect((error as ConfigWriteStoreError).code).toBe(item.code)
      }
      expect(store.readLayer(item.scope ?? 'project', item.scope === 'runtime' ? 'runner-profile' : 'rsp_config').revision).toBe(0)
    }
  })

  it('rejects restart writes whose owner bootstrap has no real consumer', () => {
    const db = configDatabase()
    const store = configStore(db)
    expect(() => store.transact({ operations: [{
      kind: 'config', scope: 'runtime', scope_id: 'runner-profile', expected_revision: 0,
      changes: { 'runner.mode': 'docker' },
    }] }, 'principal_pi')).toThrowError(expect.objectContaining({ code: 'config_scope_forbidden' }))
    expect(() => store.transact({ operations: [{
      kind: 'config', scope: 'global', scope_id: 'global', expected_revision: 0,
      changes: { 'global.images_lock.path': '/etc/dsh/images.lock.json' },
    }] }, 'principal_pi')).toThrowError(expect.objectContaining({ code: 'config_scope_forbidden' }))
    expect(store.readLayer('runtime', 'runner-profile').revision).toBe(0)
    expect(store.readLayer('global', 'global').revision).toBe(0)
  })

  it('does not advertise or persist runtime secrets before an owner resolver consumes SecretRef metadata', () => {
    const db = configDatabase()
    const store = configStore(db)
    for (const value of ['plaintext-token', { scheme: 'file', name: 'kernel/token', scope: 'instance' }]) {
      expect(() => store.transact({ operations: [{
        kind: 'config', scope: 'runtime', scope_id: 'kernel', expected_revision: 0,
        changes: { 'kernel.token': value },
      }] }, 'principal_pi')).toThrowError(expect.objectContaining({ code: 'config_scope_forbidden', key: 'kernel.token' }))
    }
    expect(store.readLayer('runtime', 'kernel').revision).toBe(0)
  })

  it('fails closed when a durable layer pin or SecretRef metadata is corrupt', () => {
    const db = configDatabase()
    const store = configStore(db)
    store.transact({ operations: [{
      kind: 'config', scope: 'runtime', scope_id: 'kernel', expected_revision: 0,
      changes: { 'kernel.require_signed_manifest': true },
    }] }, 'principal_pi')

    db.prepare(`UPDATE config_write_layers SET config_pin = ?
      WHERE write_scope = 'runtime' AND scope_id = 'kernel'`).run(`sha256:${'0'.repeat(64)}`)
    expect(() => store.readLayer('runtime', 'kernel'))
      .toThrowError(expect.objectContaining({ code: 'config_layer_pin_mismatch' }))

    const corrupt = { 'kernel.token': { scheme: 'file', name: 'kernel/token' } }
    db.prepare(`UPDATE config_write_layers SET config_json = ?, config_pin = ?
      WHERE write_scope = 'runtime' AND scope_id = 'kernel'`).run(JSON.stringify(corrupt), pinConfig(corrupt))
    expect(() => store.effective())
      .toThrowError(expect.objectContaining({ code: 'config_layer_corrupt', key: 'kernel.token' }))
    db.close()
  })

  it('persists layer revisions and values across store reopen without a migration fallback', () => {
    const directory = mkdtempSync(join(tmpdir(), 'dsh-config-write-'))
    temporaryDirectories.push(directory)
    const path = join(directory, 'kernel.db')
    const firstDb = configDatabase(path)
    const authority = projectAuthority(['rsp_durable'])
    const first = configStore(firstDb, authority)
    first.transact({ operations: [{
      kind: 'config', scope: 'project', scope_id: 'rsp_durable', expected_revision: 0,
      changes: { 'integrity.require_clean_room_rerun': true },
    }] }, 'principal_pi')
    firstDb.close()

    const secondDb = new DatabaseSync(path)
    const second = configStore(secondDb, authority)
    expect(second.readLayer('project', 'rsp_durable')).toMatchObject({
      revision: 1,
      config: { 'integrity.require_clean_room_rerun': true },
    })
    expect(second.listRevisions('project', 'rsp_durable')).toHaveLength(1)
    secondDb.close()
  })

  it('does not commit when receipt construction fails', () => {
    const db = configDatabase()
    const store = configStore(db)
    store.effective = () => { throw new Error('receipt failed') }

    expect(() => store.transact({ operations: [{
      kind: 'config', scope: 'project', scope_id: 'rsp_config', expected_revision: 0,
      changes: { 'integrity.require_clean_room_rerun': true },
    }] }, 'principal_pi')).toThrowError(expect.objectContaining({ code: 'config_patch_invalid' }))
    expect((db.prepare('SELECT COUNT(*) AS n FROM config_write_layers').get() as { n: number }).n).toBe(0)
    expect((db.prepare('SELECT COUNT(*) AS n FROM config_write_revisions').get() as { n: number }).n).toBe(0)
    db.close()
  })
})

describe('REVIEW-CONFIG-WRITE-03 shared Settings transaction coordinator', () => {
  it('rejects an unauthenticated actor before invoking any Settings port', () => {
    const db = configDatabase()
    const writeRunnerTarget = () => { throw new Error('must not be called') }
    const coordinator = new SettingsWriteCoordinator(db, configStore(db), {
      writeOcr: () => { throw new Error('must not be called') },
      writeRunnerTarget,
    })

    expect(() => coordinator.execute({ operations: [{
      kind: 'runner-target', action: 'update', target_id: 'gpu',
      patch: { expected_revision: 1, draining: true },
    }] }, '   ')).toThrowError(expect.objectContaining({ code: 'config_actor_required' }))
    db.close()
  })

  it('commits config, OCR and Runner operations together and rolls all of them back on failure', () => {
    const db = configDatabase()
    db.exec('CREATE TABLE settings_probe (kind TEXT NOT NULL, value TEXT NOT NULL)')
    const store = configStore(db)
    let failRunner = false
    const coordinator = new SettingsWriteCoordinator(db, store, {
      writeOcr: operation => {
        db.prepare('INSERT INTO settings_probe(kind,value) VALUES (?,?)').run('ocr', operation.provider.action)
        return { provider_id: 'mineru' }
      },
      writeRunnerTarget: operation => {
        if (failRunner) throw new Error('runner failed')
        db.prepare('INSERT INTO settings_probe(kind,value) VALUES (?,?)').run('runner', operation.action)
        return { target_id: operation.action === 'create' ? operation.input.target_id : operation.target_id }
      },
    })
    const success = coordinator.execute({ operations: [
      {
        kind: 'config', scope: 'project', scope_id: 'rsp_atomic', expected_revision: 0,
        changes: { 'integrity.require_clean_room_rerun': true },
      },
      {
        kind: 'ocr-mineru',
        provider: {
          action: 'create', input: {
            provider_id: 'mineru', display_name: 'MinerU', kind: 'mineru', base_url: 'https://mineru.net/api/v4',
            enabled: true, capabilities: ['ocr', 'vision'], models: [],
          },
        },
      },
      {
        kind: 'runner-target', action: 'update', target_id: 'gpu', patch: { expected_revision: 1, draining: true },
      },
    ] }, 'principal_pi')
    expect(success.config?.layers[0]?.revision).toBe(1)
    expect(success.operations.map(operation => operation.kind)).toEqual(['config', 'ocr-mineru', 'runner-target'])

    failRunner = true
    expect(() => coordinator.execute({ operations: [
      {
        kind: 'config', scope: 'project', scope_id: 'rsp_rollback', expected_revision: 0,
        changes: { 'integrity.require_clean_room_rerun': true },
      },
      {
        kind: 'ocr-mineru',
        provider: {
          action: 'create', input: {
            provider_id: 'mineru', display_name: 'MinerU', kind: 'mineru', base_url: 'https://mineru.net/api/v4',
            enabled: true, capabilities: ['ocr', 'vision'], models: [],
          },
        },
      },
      {
        kind: 'runner-target', action: 'update', target_id: 'gpu', patch: { expected_revision: 1, draining: false },
      },
    ] }, 'principal_pi')).toThrow('runner failed')
    expect(store.readLayer('project', 'rsp_rollback').revision).toBe(0)
    expect((db.prepare("SELECT COUNT(*) AS n FROM settings_probe WHERE kind='ocr'").get() as { n: number }).n).toBe(1)
  })
})
