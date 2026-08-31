import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { adoptLegacyKernelData } from '../../packages/research-kernel/src/data-upgrade.js'
import { openDatabase } from '../../packages/research-kernel/src/store.js'
import { defaultConfigForScopes, pinConfig } from '@dsh-scholar/research-schemas'

const roots: string[] = []

function makeRoot(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix))
  roots.push(root)
  return root
}

function insertProject(db: DatabaseSync, projectId: string, name: string): void {
  db.prepare(`INSERT INTO projects (
    project_id, name, workspace, mode, status, revision, brief, constraints,
    execution, integrity, created_at, updated_at, history
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    projectId, name, `/workspace/${projectId}`, 'gate-only', 'DRAFT', 0,
    JSON.stringify({ problem: '', scope: '', questions: [], primary_metrics: [], resources: '', risks: [], target_outputs: [], target_venue: null, baseline_repo: null, domain: 'ml' }),
    JSON.stringify({ budget_usd: 0, gpu_hours: 0, deadline: null, allowed_datasets: [], forbidden_actions: [] }),
    JSON.stringify({ runner_profile_id: null, runner_target_id: 'target_local_docker_v1', network_policy: 'allowlist', artifact_store: 'local-cas', fixture_id: null }),
    JSON.stringify({ code_snapshot_required: true, env_lock_required: true, data_hash_required: true, seed_required: true, signatures_required: true }),
    '2026-08-20T00:00:00.000Z', '2026-08-20T00:00:00.000Z', '[]',
  )
}

const SENTINEL_PROJECT_ID = 'legacy-methodology-project'
const SENTINEL_AT = '2026-08-20T03:00:00.000Z'
const SENTINEL_HASH = `sha256:${'a'.repeat(64)}`

function seedCurrentSchemaLedgers(db: DatabaseSync): string[] {
  insertProject(db, SENTINEL_PROJECT_ID, 'Legacy methodology project')
  db.prepare(`INSERT INTO artifacts
    (artifact_id, project_id, kind, size_bytes, sha256, metadata, created_at)
    VALUES (?, ?, 'assurance-findings', 0, ?, '{}', ?)`)
    .run('artifact_assurance_findings', SENTINEL_PROJECT_ID, SENTINEL_HASH, SENTINEL_AT)
  db.prepare(`INSERT INTO gates
    (gate_id, project_id, type, title, summary, payload, status, created_at)
    VALUES (?, ?, 'budget', 'Legacy budget gate', '', '{}', 'approved', ?)`)
    .run('gate_legacy_budget', SENTINEL_PROJECT_ID, SENTINEL_AT)
  db.prepare(`INSERT INTO decisions
    (decision_id, gate_id, project_id, gate_type, actor, decision, reason, diff, decided_at)
    VALUES (?, ?, ?, 'budget', 'human', 'approved', '', '', ?)`)
    .run('decision_legacy_budget', 'gate_legacy_budget', SENTINEL_PROJECT_ID, SENTINEL_AT)

  const audit = {
    audit_id: 'audit_legacy_1',
    project_id: SENTINEL_PROJECT_ID,
    findings_artifact_id: 'artifact_assurance_findings',
    acceptance_status: 'pending',
  }
  db.prepare(`INSERT INTO assurance_events
    (project_id, revision, event_type, audit_id, audit_json, findings_artifact_id, actor_ref, created_at)
    VALUES (?, 1, 'audit_recorded', ?, ?, ?, NULL, ?)`)
    .run(SENTINEL_PROJECT_ID, audit.audit_id, JSON.stringify(audit), audit.findings_artifact_id, SENTINEL_AT)

  const outcome = { run: { project_id: SENTINEL_PROJECT_ID, run_ref: 'run_legacy_1' } }
  db.prepare(`INSERT INTO methodology_run_outcomes
    (project_id, revision, run_ref, outcome_json, created_at) VALUES (?, 1, ?, ?, ?)`)
    .run(SENTINEL_PROJECT_ID, outcome.run.run_ref, JSON.stringify(outcome), SENTINEL_AT)

  const synthesis = { project_id: SENTINEL_PROJECT_ID, synthesis_id: 'synthesis_legacy_1' }
  db.prepare(`INSERT INTO methodology_project_events
    (project_id, revision, event_kind, record_id, parent_id, record_json, created_at)
    VALUES (?, 1, 'research_synthesis', ?, NULL, ?, ?)`)
    .run(SENTINEL_PROJECT_ID, synthesis.synthesis_id, JSON.stringify(synthesis), SENTINEL_AT)

  const knowledge = {
    manifest: { name: 'legacy.method', version: '1.0.0', payload_sha256: SENTINEL_HASH },
    manifest_sha256: SENTINEL_HASH,
  }
  db.prepare(`INSERT INTO methodology_registry_events
    (revision, event_kind, record_id, package_name, package_version, manifest_sha256, payload_sha256, record_json, created_at)
    VALUES (1, 'package_registered', 'package_legacy_1', 'legacy.method', '1.0.0', ?, ?, ?, ?)`)
    .run(SENTINEL_HASH, SENTINEL_HASH, JSON.stringify(knowledge), SENTINEL_AT)

  db.prepare(`INSERT INTO writing_methodology_events
    (project_id, revision, event_kind, record_id, parent_id, record_json, created_at)
    VALUES (?, 1, 'method_triad', 'triad_legacy_1', NULL, '{}', ?)`)
    .run(SENTINEL_PROJECT_ID, SENTINEL_AT)

  db.prepare(`INSERT INTO methodology_rollout_policies
    (policy_revision, mode, policy_hash, actor_ref, created_at)
    VALUES (2, 'opt-in-dev', ?, 'principal:legacy', ?)`)
    .run(SENTINEL_HASH, SENTINEL_AT)
  db.prepare(`INSERT INTO methodology_project_rollout_events
    (project_id, project_pin_revision, policy_revision, policy_hash, mode, actor_ref, pinned_at)
    VALUES (?, 2, 2, ?, 'opt-in-dev', 'principal:legacy', ?)`)
    .run(SENTINEL_PROJECT_ID, SENTINEL_HASH, SENTINEL_AT)
  db.prepare(`INSERT INTO methodology_rollout_consumptions
    (project_id, subject_kind, subject_id, policy_revision, policy_hash, mode, pinned_at)
    VALUES (?, 'assurance-execution', 'manual_legacy_consumption', 2, ?, 'opt-in-dev', ?)`)
    .run(SENTINEL_PROJECT_ID, SENTINEL_HASH, SENTINEL_AT)

  db.prepare(`INSERT INTO budget_block_provenance
    (gate_id, project_id, resume_to, project_revision, payload_sha256, created_at)
    VALUES ('gate_legacy_budget', ?, 'contract', 0, ?, ?)`)
    .run(SENTINEL_PROJECT_ID, SENTINEL_HASH, SENTINEL_AT)
  db.prepare(`INSERT INTO writing_patch_intents
    (application_id, proposal_id, project_id, intent_json, state, created_at, completed_at)
    VALUES ('application_legacy_1', 'proposal_legacy_1', ?, '{}', 'pending', ?, NULL)`)
    .run(SENTINEL_PROJECT_ID, SENTINEL_AT)
  db.prepare(`INSERT INTO full_auto_gate_idempotency
    (idempotency_key, request_sha256, project_id, gate_id, expected_project_revision, decision_id, receipt_json, created_at)
    VALUES ('full-auto:legacy', ?, ?, 'gate_legacy_budget', 0, 'decision_legacy_budget', '{}', ?)`)
    .run(SENTINEL_HASH, SENTINEL_PROJECT_ID, SENTINEL_AT)

  const projectConfig = {
    ...defaultConfigForScopes(['project']),
    'integrity.require_clean_room_rerun': true,
  }
  const projectConfigPin = pinConfig(projectConfig)
  db.prepare(`UPDATE projects SET execution = ?, integrity = ? WHERE project_id = ?`).run(
    JSON.stringify({
      runner_profile_id: projectConfig['execution.runner_profile_id'],
      runner_target_id: projectConfig['execution.runner_target_id'],
      network_policy: projectConfig['execution.network_policy'],
      artifact_store: projectConfig['execution.artifact_store'],
      fixture_id: projectConfig['execution.fixture_id'],
    }),
    JSON.stringify({
      require_baseline_reproduction: projectConfig['integrity.require_baseline_reproduction'],
      require_experiment_contract: projectConfig['integrity.require_experiment_contract'],
      require_claim_evidence_links: projectConfig['integrity.require_claim_evidence_links'],
      require_clean_room_rerun: projectConfig['integrity.require_clean_room_rerun'],
      allow_automatic_public_release: projectConfig['integrity.allow_automatic_public_release'],
      require_signed_manifest: projectConfig['integrity.require_signed_manifest'],
    }),
    SENTINEL_PROJECT_ID,
  )
  db.prepare(`INSERT INTO config_write_layers
    (write_scope, scope_id, revision, config_json, config_pin, updated_by, updated_at)
    VALUES ('project', ?, 1, ?, ?, 'principal:legacy', ?)`).run(
    SENTINEL_PROJECT_ID,
    JSON.stringify(projectConfig),
    projectConfigPin,
    SENTINEL_AT,
  )
  db.prepare(`INSERT INTO config_write_revisions
    (revision_id, write_scope, scope_id, revision, changes_json, config_json, config_pin, updated_by, updated_at)
    VALUES ('cfgrev_legacy_1', 'project', ?, 1, ?, ?, ?, 'principal:legacy', ?)`).run(
    SENTINEL_PROJECT_ID,
    JSON.stringify({ 'integrity.require_clean_room_rerun': true }),
    JSON.stringify(projectConfig),
    projectConfigPin,
    SENTINEL_AT,
  )

  return [
    'assurance_events',
    'methodology_run_outcomes',
    'methodology_project_events',
    'methodology_registry_events',
    'writing_methodology_events',
    'methodology_rollout_policies',
    'methodology_project_rollout_events',
    'methodology_rollout_consumptions',
    'budget_block_provenance',
    'writing_patch_intents',
    'full_auto_gate_idempotency',
    'config_write_layers',
    'config_write_revisions',
  ]
}

describe('kernel data adoption', () => {
  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
  })

  it('backs up and merges a legacy kernel exactly once without modifying the source', () => {
    const root = makeRoot('dsh-data-upgrade-')
    const sourceDataDir = join(root, 'legacy')
    const targetDataDir = join(root, 'shared')
    mkdirSync(sourceDataDir, { recursive: true })
    mkdirSync(targetDataDir, { recursive: true })

    const source = openDatabase(join(sourceDataDir, 'kernel.db'))
    insertProject(source, 'legacy-project', 'Legacy project')
    source.prepare('INSERT INTO project_members (project_id, principal_id, tenant_id, role, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run('legacy-project', 'old-operator', 'local', 'pi', '2026-08-20T00:00:00.000Z', '2026-08-20T00:00:00.000Z')
    const sourceDatabaseId = (source.prepare("SELECT value FROM meta WHERE key = 'database_id'").get() as { value: string }).value
    source.close()

    const target = openDatabase(join(targetDataDir, 'kernel.db'))
    insertProject(target, 'current-project', 'Current project')
    target.close()

    const blob = Buffer.from('legacy artifact bytes')
    const blobHash = createHash('sha256').update(blob).digest('hex')
    mkdirSync(join(sourceDataDir, 'cas'), { recursive: true })
    writeFileSync(join(sourceDataDir, 'cas', blobHash), blob)
    mkdirSync(join(sourceDataDir, 'workspaces', 'legacy-workspace'), { recursive: true })
    writeFileSync(join(sourceDataDir, 'workspaces', 'legacy-workspace', 'notes.md'), '# preserved\n')
    const sourceHashBefore = createHash('sha256').update(readFileSync(join(sourceDataDir, 'kernel.db'))).digest('hex')

    const first = adoptLegacyKernelData({ sourceDataDir, targetDataDir, operatorPrincipal: 'stable-operator' })
    expect(first.status).toBe('imported')
    expect(first.format_version).toBe(5)
    expect(first.adopting_operator_principal).toBe('stable-operator')
    expect(first.source_database_id).toBe(sourceDatabaseId)
    expect(first.rows_inserted).toBeGreaterThan(0)
    expect(existsSync(first.receipt_path)).toBe(true)
    expect(existsSync(join(targetDataDir, 'backups'))).toBe(true)

    const merged = new DatabaseSync(join(targetDataDir, 'kernel.db'), { readOnly: true })
    expect((merged.prepare('SELECT COUNT(*) AS n FROM projects').get() as { n: number }).n).toBe(2)
    expect(merged.prepare('SELECT role FROM project_members WHERE project_id = ? AND principal_id = ?').get('legacy-project', 'stable-operator')).toEqual(expect.objectContaining({ role: 'pi' }))
    expect(merged.prepare('SELECT role FROM project_members WHERE project_id = ? AND principal_id = ?').get('current-project', 'stable-operator')).toEqual(expect.objectContaining({ role: 'pi' }))
    merged.close()
    expect(readFileSync(join(targetDataDir, 'cas', blobHash))).toEqual(blob)
    expect(readFileSync(join(targetDataDir, 'workspaces', 'legacy-workspace', 'notes.md'), 'utf8')).toBe('# preserved\n')
    expect(createHash('sha256').update(readFileSync(join(sourceDataDir, 'kernel.db'))).digest('hex')).toBe(sourceHashBefore)

    // An older receipt is not trusted to have merged the complete current
    // schema. Re-adoption is idempotent, backup-first, and replaces it only
    // after rows and files have both been verified.
    const oldReceipt = JSON.parse(readFileSync(first.receipt_path, 'utf8')) as Record<string, unknown>
    oldReceipt.format_version = 4
    writeFileSync(first.receipt_path, `${JSON.stringify(oldReceipt)}\n`)
    const membershipDb = new DatabaseSync(join(targetDataDir, 'kernel.db'))
    membershipDb.prepare('DELETE FROM project_members WHERE project_id = ? AND principal_id = ?').run('current-project', 'stable-operator')
    membershipDb.close()

    const second = adoptLegacyKernelData({ sourceDataDir, targetDataDir, operatorPrincipal: 'stable-operator' })
    expect(second.status).toBe('imported')
    expect(second.format_version).toBe(5)
    const afterSecond = new DatabaseSync(join(targetDataDir, 'kernel.db'), { readOnly: true })
    expect((afterSecond.prepare('SELECT COUNT(*) AS n FROM projects').get() as { n: number }).n).toBe(2)
    expect(afterSecond.prepare('SELECT role FROM project_members WHERE project_id = ? AND principal_id = ?').get('current-project', 'stable-operator')).toEqual(expect.objectContaining({ role: 'pi' }))
    afterSecond.close()
    expect(adoptLegacyKernelData({ sourceDataDir, targetDataDir, operatorPrincipal: 'stable-operator' }).status).toBe('already_imported')
  })

  it('rejects migration checksum drift instead of repairing a legacy snapshot', () => {
    const root = makeRoot('dsh-data-upgrade-checksum-')
    const sourceDataDir = join(root, 'legacy')
    const targetDataDir = join(root, 'shared')
    mkdirSync(sourceDataDir, { recursive: true })
    mkdirSync(targetDataDir, { recursive: true })
    const source = openDatabase(join(sourceDataDir, 'kernel.db'))
    insertProject(source, 'checksum-project', 'Checksum drift')
    source.prepare("UPDATE schema_migrations SET checksum = ? WHERE id = '0008_outbox_envelope'")
      .run('obsolete-checksum')
    source.close()
    openDatabase(join(targetDataDir, 'kernel.db')).close()

    expect(() => adoptLegacyKernelData({ sourceDataDir, targetDataDir, operatorPrincipal: 'stable-operator' }))
      .toThrow(/checksum mismatch/i)
    const target = new DatabaseSync(join(targetDataDir, 'kernel.db'), { readOnly: true })
    expect((target.prepare('SELECT COUNT(*) AS n FROM projects').get() as { n: number }).n).toBe(0)
    target.close()
  })

  it('adopts every persistent ledger added by schema 0028 through 0037 and survives reopen', () => {
    const root = makeRoot('dsh-data-upgrade-current-schema-')
    const sourceDataDir = join(root, 'legacy')
    const targetDataDir = join(root, 'shared')
    mkdirSync(sourceDataDir, { recursive: true })
    mkdirSync(targetDataDir, { recursive: true })

    const source = openDatabase(join(sourceDataDir, 'kernel.db'))
    const sentinelTables = seedCurrentSchemaLedgers(source)
    source.close()
    openDatabase(join(targetDataDir, 'kernel.db')).close()

    adoptLegacyKernelData({ sourceDataDir, targetDataDir, operatorPrincipal: 'stable-operator' })

    const reopened = openDatabase(join(targetDataDir, 'kernel.db'))
    try {
      for (const table of sentinelTables) {
        expect(
          (reopened.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n,
          `${table} must survive adoption and reopen`,
        ).toBeGreaterThan(table === 'methodology_rollout_policies' ? 1 : 0)
      }
      const exactRows: Array<[string, string, string | number]> = [
        ['assurance_events', 'audit_id', 'audit_legacy_1'],
        ['methodology_run_outcomes', 'run_ref', 'run_legacy_1'],
        ['methodology_project_events', 'record_id', 'synthesis_legacy_1'],
        ['methodology_registry_events', 'record_id', 'package_legacy_1'],
        ['writing_methodology_events', 'record_id', 'triad_legacy_1'],
        ['methodology_rollout_policies', 'policy_revision', 2],
        ['methodology_project_rollout_events', 'project_pin_revision', 2],
        ['methodology_rollout_consumptions', 'subject_id', 'manual_legacy_consumption'],
        ['budget_block_provenance', 'gate_id', 'gate_legacy_budget'],
        ['writing_patch_intents', 'application_id', 'application_legacy_1'],
        ['full_auto_gate_idempotency', 'idempotency_key', 'full-auto:legacy'],
        ['config_write_layers', 'scope_id', SENTINEL_PROJECT_ID],
        ['config_write_revisions', 'revision_id', 'cfgrev_legacy_1'],
      ]
      for (const [table, key, value] of exactRows) {
        expect(reopened.prepare(`SELECT 1 AS present FROM ${table} WHERE ${key} = ?`).get(value), `${table} sentinel`)
          .toEqual({ present: 1 })
      }
      expect(reopened.prepare(`SELECT policy_revision FROM methodology_rollout_consumptions
        WHERE project_id = ? AND subject_kind = 'assurance-execution' AND subject_id = 'audit_legacy_1'`)
        .get(SENTINEL_PROJECT_ID)).toEqual({ policy_revision: 1 })
      expect((reopened.prepare(`SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'trigger' AND name IN (
        'methodology_project_rollout_on_create',
        'methodology_activation_rollout_consumption',
        'assurance_execution_rollout_consumption'
      )`).get() as { n: number }).n).toBe(3)
    } finally {
      reopened.close()
    }
  })

  it('accounts for current PTY context rows and closes the non-surviving runtime lease after adoption', () => {
    const root = makeRoot('dsh-data-upgrade-pty-context-')
    const sourceDataDir = join(root, 'legacy')
    const targetDataDir = join(root, 'shared')
    mkdirSync(sourceDataDir, { recursive: true })
    mkdirSync(targetDataDir, { recursive: true })
    const now = '2026-08-31T04:00:00.000Z'

    const source = openDatabase(join(sourceDataDir, 'kernel.db'))
    insertProject(source, 'pty-project', 'PTY project')
    source.prepare(`INSERT INTO pty_sessions (
      pty_session_id, project_id, workspace_id, principal_id, tenant_id,
      context_kind, context_id, parent_session_id, label, purpose,
      profile, target, preset, cwd, config_hash, state, generation,
      lease_token_hash, idle_ttl_s, retention_bytes, open_at, last_activity_at)
      VALUES ('pty_adopt_1','pty-project','ws-pty','pi-pty','local',
        'chat','chat-context-1','dsh-parent-1','Training shell','inspect metrics',
        'profile-1','target_local_docker_v1','bash','.','${'a'.repeat(64)}','attached',3,
        '${'b'.repeat(64)}',900,1048576,?,?)`).run(now, now)
    source.prepare(`INSERT INTO pty_frames
      (pty_session_id,server_seq,frame_kind,type,payload_json,byte_length,created_at)
      VALUES ('pty_adopt_1',1,'output','stdout','{"data":"kept"}',4,?)`).run(now)
    source.close()
    openDatabase(join(targetDataDir, 'kernel.db')).close()

    adoptLegacyKernelData({ sourceDataDir, targetDataDir, operatorPrincipal: 'stable-operator' })
    const merged = openDatabase(join(targetDataDir, 'kernel.db'))
    expect(merged.prepare(`SELECT context_kind,context_id,parent_session_id,label,purpose,state,close_reason
      FROM pty_sessions WHERE pty_session_id='pty_adopt_1'`).get()).toEqual({
      context_kind: 'chat', context_id: 'chat-context-1', parent_session_id: 'dsh-parent-1',
      label: 'Training shell', purpose: 'inspect metrics', state: 'closed', close_reason: 'lease_expired',
    })
    expect((merged.prepare("SELECT COUNT(*) AS n FROM pty_sessions WHERE context_id='chat-context-1'").get() as { n: number }).n).toBe(1)
    expect((merged.prepare("SELECT COUNT(*) AS n FROM pty_frames WHERE pty_session_id='pty_adopt_1'").get() as { n: number }).n).toBe(1)
    merged.close()
  })

  it('fails the PTY adoption inventory when a current required context column is absent', () => {
    const root = makeRoot('dsh-data-upgrade-pty-shape-')
    const sourceDataDir = join(root, 'legacy')
    const targetDataDir = join(root, 'shared')
    mkdirSync(sourceDataDir, { recursive: true })
    mkdirSync(targetDataDir, { recursive: true })
    openDatabase(join(sourceDataDir, 'kernel.db')).close()
    const target = openDatabase(join(targetDataDir, 'kernel.db'))
    target.exec('ALTER TABLE pty_sessions DROP COLUMN purpose')
    target.close()

    expect(() => adoptLegacyKernelData({ sourceDataDir, targetDataDir, operatorPrincipal: 'stable-operator' }))
      .toThrow(/PTY context inventory.*purpose/i)
  })

  it('rejects orphan PTY frames before the adoption transaction can commit', () => {
    const root = makeRoot('dsh-data-upgrade-pty-orphan-')
    const sourceDataDir = join(root, 'legacy')
    const targetDataDir = join(root, 'shared')
    mkdirSync(sourceDataDir, { recursive: true })
    mkdirSync(targetDataDir, { recursive: true })
    const source = openDatabase(join(sourceDataDir, 'kernel.db'))
    source.prepare(`INSERT INTO pty_frames
      (pty_session_id,server_seq,frame_kind,type,payload_json,byte_length,created_at)
      VALUES ('pty_missing',1,'output','stdout','{}',0,'2026-08-31T05:00:00.000Z')`).run()
    source.close()
    openDatabase(join(targetDataDir, 'kernel.db')).close()

    expect(() => adoptLegacyKernelData({ sourceDataDir, targetDataDir, operatorPrincipal: 'stable-operator' }))
      .toThrow(/orphan PTY frame/i)
    const target = openDatabase(join(targetDataDir, 'kernel.db'))
    expect((target.prepare('SELECT COUNT(*) AS n FROM pty_frames').get() as { n: number }).n).toBe(0)
    target.close()
  })

  it('backs up the target before a source snapshot migration can fail', () => {
    const root = makeRoot('dsh-data-upgrade-backup-order-')
    const sourceDataDir = join(root, 'legacy')
    const targetDataDir = join(root, 'shared')
    mkdirSync(sourceDataDir, { recursive: true })
    mkdirSync(targetDataDir, { recursive: true })
    const source = openDatabase(join(sourceDataDir, 'kernel.db'))
    source.prepare("UPDATE meta SET value = '999' WHERE key = 'schema_version'").run()
    source.close()
    openDatabase(join(targetDataDir, 'kernel.db')).close()

    expect(() => adoptLegacyKernelData({ sourceDataDir, targetDataDir, operatorPrincipal: 'stable-operator' }))
      .toThrow(/schema version mismatch/)
    expect(existsSync(join(targetDataDir, 'backups'))).toBe(true)
  })

  it('does not copy files before a conflicting database merge has committed', () => {
    const root = makeRoot('dsh-data-upgrade-db-conflict-')
    const sourceDataDir = join(root, 'legacy')
    const targetDataDir = join(root, 'shared')
    mkdirSync(join(sourceDataDir, 'workspaces', 'legacy-workspace'), { recursive: true })
    mkdirSync(targetDataDir, { recursive: true })
    writeFileSync(join(sourceDataDir, 'workspaces', 'legacy-workspace', 'notes.md'), 'must-not-copy')
    const source = openDatabase(join(sourceDataDir, 'kernel.db'))
    insertProject(source, 'conflicting-project', 'Legacy name')
    const sourceDatabaseId = (source.prepare("SELECT value FROM meta WHERE key = 'database_id'").get() as { value: string }).value
    source.close()
    const target = openDatabase(join(targetDataDir, 'kernel.db'))
    insertProject(target, 'conflicting-project', 'Current name')
    target.close()

    expect(() => adoptLegacyKernelData({ sourceDataDir, targetDataDir, operatorPrincipal: 'stable-operator' }))
      .toThrow(/row conflict in projects/)
    expect(existsSync(join(targetDataDir, 'workspaces', 'legacy-workspace', 'notes.md'))).toBe(false)
    expect(existsSync(join(targetDataDir, 'data-imports', `${sourceDatabaseId}.json`))).toBe(false)
  })

  it('can safely retry after a late file conflict without writing an early receipt', () => {
    const root = makeRoot('dsh-data-upgrade-file-retry-')
    const sourceDataDir = join(root, 'legacy')
    const targetDataDir = join(root, 'shared')
    mkdirSync(join(sourceDataDir, 'workspaces', 'legacy-workspace'), { recursive: true })
    mkdirSync(join(targetDataDir, 'workspaces', 'legacy-workspace'), { recursive: true })
    writeFileSync(join(sourceDataDir, 'workspaces', 'legacy-workspace', 'a-copied.md'), 'copied once')
    writeFileSync(join(sourceDataDir, 'workspaces', 'legacy-workspace', 'z-conflict.md'), 'source')
    writeFileSync(join(targetDataDir, 'workspaces', 'legacy-workspace', 'z-conflict.md'), 'target')
    const source = openDatabase(join(sourceDataDir, 'kernel.db'))
    insertProject(source, 'retry-project', 'Retry project')
    const sourceDatabaseId = (source.prepare("SELECT value FROM meta WHERE key = 'database_id'").get() as { value: string }).value
    source.close()
    openDatabase(join(targetDataDir, 'kernel.db')).close()

    expect(() => adoptLegacyKernelData({ sourceDataDir, targetDataDir, operatorPrincipal: 'stable-operator' }))
      .toThrow(/file conflict/)
    expect(existsSync(join(targetDataDir, 'data-imports', `${sourceDatabaseId}.json`))).toBe(false)
    const afterConflict = new DatabaseSync(join(targetDataDir, 'kernel.db'), { readOnly: true })
    expect((afterConflict.prepare('SELECT COUNT(*) AS n FROM projects WHERE project_id = ?').get('retry-project') as { n: number }).n).toBe(1)
    afterConflict.close()

    writeFileSync(join(targetDataDir, 'workspaces', 'legacy-workspace', 'z-conflict.md'), 'source')
    const receipt = adoptLegacyKernelData({ sourceDataDir, targetDataDir, operatorPrincipal: 'stable-operator' })
    expect(receipt.status).toBe('imported')
    expect(readFileSync(join(targetDataDir, 'workspaces', 'legacy-workspace', 'a-copied.md'), 'utf8')).toBe('copied once')
    const reopened = openDatabase(join(targetDataDir, 'kernel.db'))
    expect((reopened.prepare('SELECT COUNT(*) AS n FROM projects WHERE project_id = ?').get('retry-project') as { n: number }).n).toBe(1)
    reopened.close()
  })
})
