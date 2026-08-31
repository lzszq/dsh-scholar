/**
 * Explicit migration framework tests (storage-migrations.md §8):
 * ordered/checksummed/idempotent steps, transactional rollback, legacy v1
 * import against the committed fixture tests/fixtures/databases/v1-kernel.db.
 */
import { describe, expect, it, afterEach } from 'vitest'
import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync, copyFileSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import { openDatabase, SCHEMA_VERSION, runMigrations, MIGRATIONS, checksumOf } from '@dsh-scholar/research-kernel'

const FIXTURE = fileURLToPath(new URL('../fixtures/databases/v1-kernel.db', import.meta.url))

/** Baseline migration count at load — the rollback test appends a failing
 * migration; afterEach restores this exact set. */
const BASELINE_MIGRATIONS = MIGRATIONS.length

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex')
}

function tmpDbPath(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-migrations-'))
  return join(dir, 'kernel.db')
}

function tableInfo(db: DatabaseSync, table: string): Array<{ name: string; pk: number }> {
  return db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string; pk: number }>
}

describe('explicit migrations', () => {
  afterEach(() => {
    // The rollback test appends a failing migration; always restore.
    while (MIGRATIONS.length > BASELINE_MIGRATIONS) MIGRATIONS.pop()
  })

  it('opens with WAL + foreign_keys + bounded busy_timeout (storage-migrations.md §2)', () => {
    // File-backed DB: WAL is reported as 'wal' (in-memory DBs report 'memory').
    const db = openDatabase(tmpDbPath())
    const journal = (db.prepare('PRAGMA journal_mode').get() as { journal_mode: string }).journal_mode
    const foreignKeys = (db.prepare('PRAGMA foreign_keys').get() as { foreign_keys: number }).foreign_keys
    const busyTimeout = (db.prepare('PRAGMA busy_timeout').get() as { timeout: number }).timeout
    expect(journal.toLowerCase()).toBe('wal')
    expect(foreignKeys).toBe(1)
    expect(busyTimeout).toBe(5000)
    db.close()
  })

  it('bumps a fresh database to SCHEMA_VERSION with all steps recorded', () => {
    const db = openDatabase(':memory:')
    expect(SCHEMA_VERSION).toBe(35)
    const meta = Object.fromEntries((db.prepare('SELECT key, value FROM meta').all() as Array<{ key: string; value: string }>).map(r => [r.key, r.value]))
    expect(meta.schema_version).toBe('35')
    expect(meta.database_id).toBeTruthy()
    expect(meta.created_at).toBeTruthy()
    const applied = db.prepare('SELECT id, checksum, report_json FROM schema_migrations ORDER BY id').all() as Array<{ id: string; checksum: string; report_json: string }>
    expect(applied.map(r => r.id)).toEqual(['0001_schema_v2_initial', '0002_import_legacy_v1', '0003_terminal_tex_i18n_capabilities', '0004_artifact_media_type', '0005_code_snapshots', '0006_project_members', '0007_project_idempotency_keys', '0008_outbox_envelope', '0009_runs_snapshot_nullable', '0010_preview_builds', '0011_pty_workspace', '0012_intake', '0013_trajectory_topology', '0014_lease_token_hash', '0016_v2_shape_alignment', '0017_v1_legacy_marks', '0018_workspace_recovery_quarantine', '0019_project_deletion_tombstone', '0020_project_brief_status', '0021_provider_chunked_upload', '0022_reproduction_contracts', '0023_runner_target_registry', '0024_topology_cancelled_state', '0025_runner_target_runtime', '0026_runner_target_service_identity', '0027_project_execution_shape', '0028_methodology_knowledge_layer', '0029_research_run_outcomes', '0030_writing_review_methodology', '0031_correctness_hardening', '0032_methodology_rollout_policy', '0033_full_auto_global_idempotency', '0034_upload_abort_ownership', '0035_ocr_requests', '0036_pty_context_reset', '0037_config_write_layers', '0038_remove_plaintext_lease_storage'])
    expect(tableInfo(db, 'runner_targets').map(column => column.name)).toContain('runtime_json')
    expect(tableInfo(db, 'runner_targets').map(column => column.name)).toContain('service_identity_json')
    for (const row of applied) expect(row.checksum).toMatch(/^[0-9a-f]{64}$/)
    // 0002 on a fresh DB: nothing to import (row counters still reported).
    expect(JSON.parse(applied[1]!.report_json)).toEqual({ rows: { manuscripts_converted: 0 } })
    // All product tables exist.
    for (const t of ['projects', 'gates', 'decisions', 'ideas', 'contracts', 'corpus_snapshots', 'artifacts', 'jobs', 'runner_keys', 'runner_targets', 'evidence', 'claims', 'events', 'session_links', 'budget', 'manuscripts', 'terminal_frames', 'terminal_retention', 'tex_documents', 'tex_files', 'tex_snapshots', 'tex_builds', 'project_members', 'code_snapshots', 'runs', 'pty_sessions', 'pty_frames', 'workspaces', 'workspace_nodes', 'workspace_ops', 'intake_sessions', 'intake_artifacts', 'intake_observations', 'intake_questions', 'child_links', 'child_history', 'child_followups', 'upload_sessions', 'upload_chunks', 'model_providers', 'model_provider_models', 'reproduction_specs', 'reproduction_attempts', 'reproduction_reports', 'reproduction_links', 'assurance_events', 'methodology_project_events', 'methodology_registry_events', 'methodology_run_outcomes', 'writing_methodology_events', 'budget_block_provenance', 'writing_patch_intents', 'methodology_rollout_policies', 'methodology_project_rollout_events', 'methodology_rollout_consumptions', 'full_auto_gate_idempotency', 'ocr_requests', 'ocr_result_artifacts', 'ocr_observations', 'config_write_layers', 'config_write_revisions']) {
      expect(tableInfo(db, t).length, `table ${t}`).toBeGreaterThan(0)
    }
    expect((db.prepare('SELECT target_id, kind FROM runner_targets ORDER BY target_id').all() as Array<{ target_id: string; kind: string }>)).toEqual([
      { target_id: 'target_local_docker_v1', kind: 'local-docker' },
      { target_id: 'target_local_process_v1', kind: 'local-process' },
    ])
    // 0011 (PTY-01/WORK-01): the pty + workspace tables carry the interface
    // layer columns (state machine, client_seq idempotency, retention).
    const ptySessionCols = tableInfo(db, 'pty_sessions').map(c => c.name)
    for (const c of ['pty_session_id', 'principal_id', 'workspace_id', 'context_kind', 'context_id', 'parent_session_id', 'label', 'purpose', 'profile', 'target', 'preset', 'cwd', 'config_hash', 'state', 'generation', 'lease_token_hash', 'idle_ttl_s', 'retention_bytes', 'retained_from_seq', 'last_client_seq', 'last_event_seq', 'closed_at']) {
      expect(ptySessionCols, `pty_sessions.${c}`).toContain(c)
    }
    expect(ptySessionCols).not.toContain('lease_token')
    // 0014 (STORE-06): jobs carries the lease-token hash column (the
    // plaintext token is never persisted — payload.__lease_token is gone).
    const jobCols = tableInfo(db, 'jobs').map(c => c.name)
    expect(jobCols).toContain('lease_token_hash')
    // 0016 (v2 shape): jobs.created_by_principal_id + budget.storage_bytes.
    expect(jobCols).toContain('created_by_principal_id')
    const budgetCols = tableInfo(db, 'budget').map(c => c.name)
    expect(budgetCols).toContain('storage_bytes')
    // 0017 (MIG-V1): the three legacy-mark columns exist on fresh databases.
    for (const c of ['synthetic_fixture', 'signature_status', 'legacy_log_artifact']) {
      expect(jobCols, `jobs.${c}`).toContain(c)
    }
    const workspaceNodeCols = tableInfo(db, 'workspace_nodes').map(c => c.name)
    for (const c of ['workspace_id', 'path', 'version', 'binary', 'media', 'size_bytes', 'content', 'blob_sha256', 'content_hash']) {
      expect(workspaceNodeCols, `workspace_nodes.${c}`).toContain(c)
    }
    // EVENT-01/§16: the events outbox carries the canonical envelope columns.
    const eventCols = tableInfo(db, 'events').map(c => c.name)
    for (const c of ['event_seq', 'event_version', 'aggregate_type', 'aggregate_id', 'aggregate_revision', 'request_id', 'session_id', 'attempts', 'last_error', 'next_attempt_at', 'dead_lettered_at']) {
      expect(eventCols, `events.${c}`).toContain(c)
    }
    const seqIndex = db.prepare(`PRAGMA index_list('events')`).all() as Array<{ name: string; unique: number }>
    expect(seqIndex.some(i => i.name === 'idx_events_aggregate_seq' && i.unique === 1)).toBe(true)
    // STORE-01 parity: session_links gained the durable principal columns.
    const sessionCols = tableInfo(db, 'session_links').map(c => c.name)
    for (const c of ['principal_id', 'tenant_id', 'issuer']) expect(sessionCols).toContain(c)
    // 0010 (TEX-03): tex_builds carries the preview/supersede linkage and
    // the debounced preview scheduler's durable pending table exists.
    const buildCols = tableInfo(db, 'tex_builds').map(c => c.name)
    for (const c of ['preview', 'superseded_by', 'superseded_at']) expect(buildCols).toContain(c)
    expect(tableInfo(db, 'tex_preview_pending').length).toBeGreaterThan(0)
    db.close()
  })

  it('is idempotent across re-opens of the same database file', () => {
    const path = tmpDbPath()
    const db1 = openDatabase(path)
    const before = (db1.prepare('SELECT id FROM schema_migrations ORDER BY id').all() as Array<{ id: string }>).map(r => r.id)
    db1.close()
    const db2 = openDatabase(path)
    const after = (db2.prepare('SELECT id FROM schema_migrations ORDER BY id').all() as Array<{ id: string }>).map(r => r.id)
    expect(after).toEqual(before)
    const version = (db2.prepare('SELECT value FROM meta WHERE key = ?').get('schema_version') as { value: string }).value
    expect(version).toBe('35')
    db2.close()
    rmSync(path, { recursive: false, force: true })
  })

  it('0029 upgrades an existing methodology database without rebuilding the project stream', () => {
    const path = tmpDbPath()
    const db = openDatabase(path)
    const methodologySql = (db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'methodology_project_events'").get() as { sql: string }).sql
    db.exec(`DROP TABLE methodology_run_outcomes;
      DELETE FROM schema_migrations WHERE id = '0029_research_run_outcomes';
      UPDATE meta SET value = '25' WHERE key = 'schema_version';`)
    db.close()

    const upgraded = openDatabase(path)
    expect((upgraded.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as { value: string }).value).toBe('35')
    expect((upgraded.prepare("SELECT COUNT(*) AS n FROM schema_migrations WHERE id = '0029_research_run_outcomes'").get() as { n: number }).n).toBe(1)
    expect(tableInfo(upgraded, 'methodology_run_outcomes').map(column => column.name)).toEqual([
      'project_id', 'revision', 'run_ref', 'outcome_json', 'created_at',
    ])
    expect((upgraded.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'methodology_project_events'").get() as { sql: string }).sql).toBe(methodologySql)
    upgraded.close()
  })

  it('0030 upgrades an existing methodology database with an independent append-only writing stream', () => {
    const path = tmpDbPath()
    const db = openDatabase(path)
    const methodologySql = (db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'methodology_project_events'").get() as { sql: string }).sql
    db.exec(`DROP TABLE writing_methodology_events;
      DELETE FROM schema_migrations WHERE id = '0030_writing_review_methodology';
      UPDATE meta SET value = '26' WHERE key = 'schema_version';`)
    db.close()

    const upgraded = openDatabase(path)
    expect((upgraded.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as { value: string }).value).toBe('35')
    expect((upgraded.prepare("SELECT COUNT(*) AS n FROM schema_migrations WHERE id = '0030_writing_review_methodology'").get() as { n: number }).n).toBe(1)
    expect(tableInfo(upgraded, 'writing_methodology_events').map(column => column.name)).toEqual([
      'project_id', 'revision', 'event_kind', 'record_id', 'parent_id', 'record_json', 'created_at',
    ])
    expect((upgraded.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'methodology_project_events'").get() as { sql: string }).sql).toBe(methodologySql)
    upgraded.close()
  })

  it('0032 installs the rollout policy and backfills every existing project without rewriting project state', () => {
    const path = tmpDbPath()
    const db = openDatabase(path)
    const before = {
      project: db.prepare('SELECT * FROM projects WHERE project_id = ?').get('missing'),
      migrationCount: (db.prepare('SELECT COUNT(*) AS n FROM schema_migrations').get() as { n: number }).n,
    }
    const now = '2026-08-20T00:00:00.000Z'
    db.prepare(`INSERT INTO projects
      (project_id, name, workspace, mode, status, revision, brief, constraints, execution, integrity, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, 1, '{}', '{}', '{}', '{}', ?, ?)`)
      .run('p-before-rollout', 'Existing', '/work/existing', 'gate-only', 'DRAFT', now, now)
    db.prepare(`INSERT INTO methodology_project_events
      (project_id, revision, event_kind, record_id, parent_id, record_json, created_at)
      VALUES (?, 1, 'knowledge_activation', 'activation_before_rollout', NULL, ?, ?)`)
      .run('p-before-rollout', JSON.stringify({ project_id: 'p-before-rollout', activation_id: 'activation_before_rollout' }), now)
    db.exec(`
      DROP TRIGGER methodology_activation_rollout_consumption;
      DROP TRIGGER methodology_activation_requires_rollout_pin;
      DROP TRIGGER assurance_execution_rollout_consumption;
      DROP TRIGGER assurance_execution_requires_rollout_pin;
      DROP TRIGGER methodology_project_rollout_on_create;
      DROP TRIGGER methodology_rollout_consumptions_no_delete;
      DROP TRIGGER methodology_rollout_consumptions_no_update;
      DROP TRIGGER methodology_project_rollout_events_no_delete;
      DROP TRIGGER methodology_project_rollout_events_no_update;
      DROP TRIGGER methodology_rollout_policies_no_delete;
      DROP TRIGGER methodology_rollout_policies_no_update;
      DROP TABLE methodology_rollout_consumptions;
      DROP TABLE methodology_project_rollout_events;
      DROP TABLE methodology_rollout_policies;
      DELETE FROM schema_migrations WHERE id = '0032_methodology_rollout_policy';
      UPDATE meta SET value = '28' WHERE key = 'schema_version';
    `)
    db.close()

    const upgraded = openDatabase(path)
    expect((upgraded.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as { value: string }).value).toBe('35')
    expect((upgraded.prepare("SELECT COUNT(*) AS n FROM schema_migrations WHERE id = '0032_methodology_rollout_policy'").get() as { n: number }).n).toBe(1)
    expect((upgraded.prepare(`SELECT policy_revision, mode, actor_ref FROM methodology_project_rollout_events
      WHERE project_id = 'p-before-rollout'`).get())).toEqual({
      policy_revision: 1, mode: 'internal-fixture', actor_ref: 'system:migration-0032',
    })
    expect((upgraded.prepare(`SELECT subject_kind, subject_id, policy_revision, mode
      FROM methodology_rollout_consumptions WHERE project_id = 'p-before-rollout'`).get())).toEqual({
      subject_kind: 'knowledge-activation', subject_id: 'activation_before_rollout',
      policy_revision: 1, mode: 'internal-fixture',
    })
    expect((upgraded.prepare('SELECT name, status, revision FROM projects WHERE project_id = ?').get('p-before-rollout')))
      .toEqual({ name: 'Existing', status: 'DRAFT', revision: 1 })
    expect((upgraded.prepare('SELECT COUNT(*) AS n FROM schema_migrations').get() as { n: number }).n)
      .toBe(before.migrationCount)
    upgraded.close()
  })

  it('0033 adds the global full-auto approval idempotency ledger without rewriting projects', () => {
    const path = tmpDbPath()
    const db = openDatabase(path)
    const now = '2026-08-20T00:00:00.000Z'
    db.prepare(`INSERT INTO projects
      (project_id, name, workspace, mode, status, revision, brief, constraints, execution, integrity, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, 7, '{}', '{}', '{}', '{}', ?, ?)`)
      .run('p-before-global-idem', 'Existing', '/work/existing', 'full-auto', 'DRAFT', now, now)
    db.exec(`
      DROP TABLE full_auto_gate_idempotency;
      DELETE FROM schema_migrations WHERE id = '0033_full_auto_global_idempotency';
      UPDATE meta SET value = '29' WHERE key = 'schema_version';
    `)
    db.close()

    const upgraded = openDatabase(path)
    expect((upgraded.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as { value: string }).value).toBe('35')
    expect((upgraded.prepare("SELECT COUNT(*) AS n FROM schema_migrations WHERE id = '0033_full_auto_global_idempotency'").get() as { n: number }).n).toBe(1)
    expect(tableInfo(upgraded, 'full_auto_gate_idempotency').map(column => column.name)).toEqual([
      'idempotency_key', 'request_sha256', 'project_id', 'gate_id', 'expected_project_revision',
      'decision_id', 'receipt_json', 'created_at',
    ])
    expect(upgraded.prepare('SELECT name, status, revision FROM projects WHERE project_id = ?').get('p-before-global-idem'))
      .toEqual({ name: 'Existing', status: 'DRAFT', revision: 7 })
    upgraded.close()
  })

  it('0034 adds upload artifact ownership without changing existing upload state', () => {
    const path = tmpDbPath()
    const db = openDatabase(path)
    const now = '2026-08-26T00:00:00.000Z'
    db.prepare(`INSERT INTO upload_sessions
      (upload_id, intake_id, project_id, file_name, expected_size, chunk_size, status, created_at, updated_at, expires_at)
      VALUES ('upl-before-0034', 'intake-old', 'project-old', 'paper.pdf', 4, 4, 'open', ?, ?, ?)`)
      .run(now, now, now)
    db.exec(`
      ALTER TABLE upload_sessions DROP COLUMN owns_artifact;
      ALTER TABLE upload_sessions DROP COLUMN owner_scope_id;
      ALTER TABLE intake_sessions DROP COLUMN owner_scope_id;
      DROP TABLE chat_scope_tombstones;
      DELETE FROM schema_migrations WHERE id = '0034_upload_abort_ownership';
      UPDATE meta SET value = '30' WHERE key = 'schema_version';
    `)
    db.close()

    const upgraded = openDatabase(path)
    expect((upgraded.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as { value: string }).value).toBe('35')
    expect(tableInfo(upgraded, 'upload_sessions').map(column => column.name)).toContain('owns_artifact')
    expect(tableInfo(upgraded, 'upload_sessions').map(column => column.name)).toContain('owner_scope_id')
    expect(tableInfo(upgraded, 'intake_sessions').map(column => column.name)).toContain('owner_scope_id')
    expect(tableInfo(upgraded, 'chat_scope_tombstones').map(column => column.name))
      .toEqual(['project_id', 'scope_id', 'closed_at'])
    expect(upgraded.prepare('SELECT status, committed_offset, owns_artifact FROM upload_sessions WHERE upload_id = ?')
      .get('upl-before-0034')).toEqual({ status: 'open', committed_offset: 0, owns_artifact: 0 })
    upgraded.close()
  })

  it('0035 adds isolated OCR lifecycle tables without rewriting Intake source state', () => {
    const path = tmpDbPath()
    const db = openDatabase(path)
    const now = '2026-08-31T00:00:00.000Z'
    db.prepare(`INSERT INTO projects
      (project_id, name, workspace, mode, status, revision, brief, constraints, execution, integrity, created_at, updated_at)
      VALUES ('p-before-ocr', 'OCR', '/work/ocr', 'gate-only', 'DRAFT', 1, '{}', '{}', '{}', '{}', ?, ?)`).run(now, now)
    db.prepare(`INSERT INTO intake_sessions
      (intake_id, project_id, owner_principal_id, status, revision, source_label, expires_at, created_at, updated_at)
      VALUES ('intk-before-ocr', 'p-before-ocr', 'pi-1', 'needs_input', 3, 'paper', ?, ?, ?)`).run(now, now, now)
    db.prepare(`INSERT INTO intake_artifacts
      (intake_id, artifact_id, file_name, media_type, size_bytes, sha256, quarantine, created_at)
      VALUES ('intk-before-ocr', ?, 'paper.pdf', 'application/pdf', 4, ?, 'clean', ?)`).run(`sha256:${'a'.repeat(64)}`, 'a'.repeat(64), now)
    db.exec(`
      DROP TABLE ocr_observations;
      DROP TABLE ocr_result_artifacts;
      DROP TABLE ocr_requests;
      DELETE FROM schema_migrations WHERE id = '0035_ocr_requests';
      UPDATE meta SET value = '31' WHERE key = 'schema_version';
    `)
    db.close()

    const upgraded = openDatabase(path)
    expect((upgraded.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as { value: string }).value).toBe('35')
    expect((upgraded.prepare("SELECT COUNT(*) AS n FROM schema_migrations WHERE id = '0035_ocr_requests'").get() as { n: number }).n).toBe(1)
    expect(upgraded.prepare("SELECT status, revision FROM intake_sessions WHERE intake_id = 'intk-before-ocr'").get())
      .toEqual({ status: 'needs_input', revision: 3 })
    expect(upgraded.prepare("SELECT quarantine, sha256 FROM intake_artifacts WHERE intake_id = 'intk-before-ocr'").get())
      .toEqual({ quarantine: 'clean', sha256: 'a'.repeat(64) })
    expect(tableInfo(upgraded, 'ocr_requests').map(column => column.name)).toContain('provider_config_sha256')
    expect(tableInfo(upgraded, 'ocr_result_artifacts').map(column => column.name)).toContain('trust')
    expect(tableInfo(upgraded, 'ocr_observations').map(column => column.name)).toContain('confidence')
    upgraded.close()
  })

  it('0036 destructively resets legacy context-less PTY state without changing research data', () => {
    const path = tmpDbPath()
    const db = openDatabase(path)
    const now = '2026-08-31T01:00:00.000Z'
    db.prepare(`INSERT INTO projects
      (project_id, name, workspace, mode, status, revision, brief, constraints, execution, integrity, created_at, updated_at)
      VALUES ('p-pty-upgrade', 'PTY upgrade sentinel', '/work/pty', 'gate-only', 'DRAFT', 7, '{"question":"keep"}', '{}', '{}', '{}', ?, ?)`).run(now, now)
    db.prepare(`INSERT INTO workspaces
      (workspace_id, project_id, kind, name, revision, created_at, updated_at)
      VALUES ('ws-pty-upgrade', 'p-pty-upgrade', 'code', 'Code', 4, ?, ?)`).run(now, now)
    db.prepare(`INSERT INTO artifacts
      (project_id, artifact_id, kind, size_bytes, sha256, metadata, created_at, media_type, file_name)
      VALUES ('p-pty-upgrade', 'sha256:${'a'.repeat(64)}', 'dataset', 4, '${'a'.repeat(64)}', '{"sentinel":true}', ?, 'application/octet-stream', 'keep.bin')`).run(now)
    db.prepare(`INSERT INTO tex_documents
      (document_id, project_id, root_file, revision, created_at, updated_at)
      VALUES ('tex-pty-upgrade', 'p-pty-upgrade', 'paper.tex', 5, ?, ?)`).run(now, now)
    const sentinels = {
      project: db.prepare("SELECT * FROM projects WHERE project_id='p-pty-upgrade'").get(),
      workspace: db.prepare("SELECT * FROM workspaces WHERE workspace_id='ws-pty-upgrade'").get(),
      artifact: db.prepare("SELECT * FROM artifacts WHERE project_id='p-pty-upgrade'").get(),
      tex: db.prepare("SELECT * FROM tex_documents WHERE document_id='tex-pty-upgrade'").get(),
    }
    db.exec(`
      DROP TABLE pty_frames;
      DROP TABLE pty_sessions;
      CREATE TABLE pty_sessions (
        pty_session_id TEXT PRIMARY KEY, project_id TEXT NOT NULL, workspace_id TEXT NOT NULL,
        principal_id TEXT NOT NULL, tenant_id TEXT NOT NULL DEFAULT '', profile TEXT NOT NULL,
        target TEXT NOT NULL, preset TEXT NOT NULL, cwd TEXT NOT NULL, config_hash TEXT NOT NULL,
        state TEXT NOT NULL, generation INTEGER NOT NULL, lease_token TEXT,
        lease_token_hash TEXT NOT NULL DEFAULT '', lease_expires_at TEXT,
        idle_ttl_s INTEGER NOT NULL, retention_bytes INTEGER NOT NULL,
        retained_from_seq INTEGER NOT NULL DEFAULT 0, last_client_seq INTEGER NOT NULL DEFAULT 0,
        last_event_seq INTEGER NOT NULL DEFAULT 0, total_bytes INTEGER NOT NULL DEFAULT 0,
        dropped_bytes INTEGER NOT NULL DEFAULT 0, adapter_id TEXT NOT NULL DEFAULT 'none',
        open_at TEXT NOT NULL, last_activity_at TEXT NOT NULL, closed_at TEXT, close_reason TEXT
      );
      CREATE TABLE pty_frames (
        pty_session_id TEXT NOT NULL, server_seq INTEGER NOT NULL, frame_kind TEXT NOT NULL,
        client_seq INTEGER, type TEXT NOT NULL, payload_json TEXT NOT NULL DEFAULT '{}',
        byte_length INTEGER, created_at TEXT NOT NULL, PRIMARY KEY (pty_session_id, server_seq)
      );
      INSERT INTO pty_sessions
        (pty_session_id,project_id,workspace_id,principal_id,tenant_id,profile,target,preset,cwd,
         config_hash,state,generation,lease_token_hash,idle_ttl_s,retention_bytes,open_at,last_activity_at)
        VALUES ('pty-legacy','p-pty-upgrade','ws-pty-upgrade','pi-1','local','local','target-local',
          'bash','.', '${'b'.repeat(64)}','attached',3,'${'c'.repeat(64)}',900,1048576,
          '${now}','${now}');
      INSERT INTO pty_frames
        (pty_session_id,server_seq,frame_kind,type,payload_json,byte_length,created_at)
        VALUES ('pty-legacy',1,'output','stdout','{"data":"legacy"}',6,'${now}');
      DELETE FROM schema_migrations WHERE id IN ('0036_pty_context_reset','0038_remove_plaintext_lease_storage');
      UPDATE meta SET value = '32' WHERE key = 'schema_version';
    `)
    db.close()

    const upgraded = openDatabase(path)
    expect((upgraded.prepare("SELECT value FROM meta WHERE key='schema_version'").get() as { value: string }).value).toBe('35')
    expect((upgraded.prepare('SELECT COUNT(*) AS n FROM pty_sessions').get() as { n: number }).n).toBe(0)
    expect((upgraded.prepare('SELECT COUNT(*) AS n FROM pty_frames').get() as { n: number }).n).toBe(0)
    const columns = tableInfo(upgraded, 'pty_sessions').map(column => column.name)
    for (const column of ['context_kind', 'context_id', 'parent_session_id', 'label', 'purpose']) {
      expect(columns).toContain(column)
    }
    const indexes = upgraded.prepare("PRAGMA index_list('pty_sessions')").all() as Array<{ name: string }>
    expect(indexes.map(index => index.name)).toContain('idx_pty_sessions_context')
    const report = JSON.parse((upgraded.prepare("SELECT report_json FROM schema_migrations WHERE id='0036_pty_context_reset'").get() as { report_json: string }).report_json) as { rows: Record<string, number> }
    expect(report.rows).toMatchObject({ pty_sessions_discarded: 1, pty_frames_discarded: 1, pty_sessions: 0, pty_frames: 0 })
    expect(upgraded.prepare("SELECT * FROM projects WHERE project_id='p-pty-upgrade'").get()).toEqual(sentinels.project)
    expect(upgraded.prepare("SELECT * FROM workspaces WHERE workspace_id='ws-pty-upgrade'").get()).toEqual(sentinels.workspace)
    expect(upgraded.prepare("SELECT * FROM artifacts WHERE project_id='p-pty-upgrade'").get()).toEqual(sentinels.artifact)
    expect(upgraded.prepare("SELECT * FROM tex_documents WHERE document_id='tex-pty-upgrade'").get()).toEqual(sentinels.tex)
    upgraded.close()
  })

  it('0036 preserves current context-bound PTY rows', () => {
    const path = tmpDbPath()
    const db = openDatabase(path)
    const now = '2026-08-31T02:00:00.000Z'
    db.exec('ALTER TABLE pty_sessions ADD COLUMN lease_token TEXT')
    db.prepare(`INSERT INTO pty_sessions (
      pty_session_id, project_id, workspace_id, principal_id, tenant_id,
      context_kind, context_id, parent_session_id, label, purpose,
      profile, target, preset, cwd, config_hash, state, generation,
      lease_token, lease_token_hash, lease_expires_at, idle_ttl_s, retention_bytes,
      open_at, last_activity_at)
      VALUES ('pty-current','p-current','ws-current','pi-current','local',
        'chat','ctx-current','dsh-session-current','Experiment shell','inspect',
        'profile-current','target-current','bash','.','${'d'.repeat(64)}','detached',4,
        NULL,'${'e'.repeat(64)}',NULL,900,1048576,?,?)`).run(now, now)
    db.prepare(`INSERT INTO pty_frames
      (pty_session_id, server_seq, frame_kind, type, payload_json, byte_length, created_at)
      VALUES ('pty-current', 1, 'output', 'stdout', '{"data":"kept"}', 4, ?)`)
      .run(now)
    db.exec(`
      DELETE FROM schema_migrations WHERE id IN ('0036_pty_context_reset','0038_remove_plaintext_lease_storage');
      UPDATE meta SET value = '32' WHERE key = 'schema_version';
    `)
    db.close()

    const upgraded = openDatabase(path)
    expect((upgraded.prepare("SELECT value FROM meta WHERE key='schema_version'").get() as { value: string }).value).toBe('35')
    const report = JSON.parse((upgraded.prepare("SELECT report_json FROM schema_migrations WHERE id='0036_pty_context_reset'").get() as { report_json: string }).report_json) as { rows: Record<string, number> }
    expect(report.rows).toMatchObject({ pty_sessions_discarded: 0, pty_frames_discarded: 0, pty_sessions: 1, pty_frames: 1 })
    expect(upgraded.prepare("SELECT context_kind,context_id,parent_session_id,label,purpose FROM pty_sessions WHERE pty_session_id='pty-current'").get())
      .toEqual({ context_kind: 'chat', context_id: 'ctx-current', parent_session_id: 'dsh-session-current', label: 'Experiment shell', purpose: 'inspect' })
    expect((upgraded.prepare("SELECT COUNT(*) AS n FROM pty_frames WHERE pty_session_id='pty-current'").get() as { n: number }).n).toBe(1)
    upgraded.close()
  })

  it('0036 rejects the removed operator PTY context instead of preserving a fallback authority', () => {
    const path = tmpDbPath()
    const db = openDatabase(path)
    const now = '2026-08-31T02:30:00.000Z'
    db.exec('ALTER TABLE pty_sessions ADD COLUMN lease_token TEXT')
    db.exec('PRAGMA ignore_check_constraints = ON')
    db.prepare(`INSERT INTO pty_sessions (
      pty_session_id, project_id, workspace_id, principal_id, tenant_id,
      context_kind, context_id, parent_session_id, label, purpose,
      profile, target, preset, cwd, config_hash, state, generation,
      lease_token, lease_token_hash, lease_expires_at, idle_ttl_s, retention_bytes,
      open_at, last_activity_at)
      VALUES ('pty-operator','p-current','ws-current','pi-current','local',
        'operator','operator-current',NULL,'Obsolete fallback','must not survive',
        'profile-current','target-current','bash','.','${'f'.repeat(64)}','detached',2,
        NULL,'${'a'.repeat(64)}',NULL,900,1048576,?,?)`).run(now, now)
    db.exec(`
      PRAGMA ignore_check_constraints = OFF;
      DELETE FROM schema_migrations WHERE id IN ('0036_pty_context_reset','0038_remove_plaintext_lease_storage');
      UPDATE meta SET value = '32' WHERE key = 'schema_version';
    `)
    db.close()

    const upgraded = openDatabase(path)
    expect((upgraded.prepare("SELECT COUNT(*) AS n FROM pty_sessions WHERE context_kind='operator'").get() as { n: number }).n).toBe(0)
    const report = JSON.parse((upgraded.prepare("SELECT report_json FROM schema_migrations WHERE id='0036_pty_context_reset'").get() as { report_json: string }).report_json) as { rows: Record<string, number> }
    expect(report.rows).toMatchObject({ pty_sessions_discarded: 1, pty_sessions: 0 })
    upgraded.close()
  })

  it('0037 adds the config write ledger without rewriting canonical project rows', () => {
    const path = tmpDbPath()
    const db = openDatabase(path)
    const now = '2026-08-31T03:00:00.000Z'
    db.prepare(`INSERT INTO projects
      (project_id, name, workspace, mode, status, revision, brief, constraints, execution, integrity, created_at, updated_at)
      VALUES ('p-config-upgrade', 'Config upgrade sentinel', '/work/config', 'gate-only', 'DRAFT', 9,
        '{"question":"keep"}', '{}',
        '{"runner_profile_id":null,"runner_target_id":"target_local_docker_v1","network_policy":"none","artifact_store":"local-cas","fixture_id":null}',
        '{"require_baseline_reproduction":true,"require_clean_room_rerun":false,"require_claim_evidence":true,"allow_automatic_public_release":false,"required_code_snapshot_id":null,"required_environment_lock_artifact_id":null}',
        ?, ?)`).run(now, now)
    const before = db.prepare("SELECT * FROM projects WHERE project_id='p-config-upgrade'").get()
    db.exec(`
      DROP TABLE config_write_revisions;
      DROP TABLE config_write_layers;
      DELETE FROM schema_migrations WHERE id = '0037_config_write_layers';
      UPDATE meta SET value = '33' WHERE key = 'schema_version';
    `)
    db.close()

    const upgraded = openDatabase(path)
    expect(upgraded.prepare("SELECT * FROM projects WHERE project_id='p-config-upgrade'").get()).toEqual(before)
    expect(tableInfo(upgraded, 'config_write_layers').map(column => column.name)).toContain('config_pin')
    expect(tableInfo(upgraded, 'config_write_revisions').map(column => column.name)).toContain('changes_json')
    expect((upgraded.prepare('SELECT COUNT(*) AS n FROM config_write_layers').get() as { n: number }).n).toBe(0)
    expect((upgraded.prepare('SELECT COUNT(*) AS n FROM config_write_revisions').get() as { n: number }).n).toBe(0)
    expect((upgraded.prepare("SELECT value FROM meta WHERE key='schema_version'").get() as { value: string }).value).toBe('35')
    upgraded.close()
  })

  it('upgrades topology cancelled state without losing existing history or followups', () => {
    const db = openDatabase(':memory:')
    const now = '2026-08-15T00:00:00.000Z'
    db.prepare(`INSERT INTO projects
      (project_id, name, workspace, mode, status, revision, brief, constraints, execution, integrity, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, 1, '{}', '{}', '{}', '{}', ?, ?)`)
      .run('p-topology', 'Topology', '/w', 'gate-only', 'DRAFT', now, now)
    db.prepare(`INSERT INTO child_links
      (child_id, project_id, parent_id, label, summary, kind, mode, state, role, created_at, updated_at)
      VALUES (?, ?, ?, ?, '', 'subagent', 'one-shot', 'running', 'scholar', ?, ?)`)
      .run('child-old', 'p-topology', 'parent-old', 'old', now, now)
    db.prepare(`INSERT INTO child_history (child_id, seq, event_id, event_type, payload, occurred_at)
      VALUES ('child-old', 1, 'evt-old', 'started', '{}', ?)`)
      .run(now)
    db.prepare(`INSERT INTO child_followups (message_id, child_id, project_id, request, request_hash, status, created_at)
      VALUES ('msg-old', 'child-old', 'p-topology', 'inspect', 'hash-old', 'accepted_read_only', ?)`)
      .run(now)

    // Rewind only the 0024 shape to reproduce a schema-20 database that
    // already contains dependent topology rows.
    db.exec(`PRAGMA foreign_keys = OFF;
      CREATE TABLE child_links_old (child_id TEXT PRIMARY KEY, project_id TEXT NOT NULL, parent_id TEXT, label TEXT, summary TEXT NOT NULL DEFAULT '', kind TEXT NOT NULL DEFAULT 'subagent', mode TEXT NOT NULL DEFAULT 'one-shot', state TEXT NOT NULL DEFAULT 'running', role TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, ended_at TEXT, FOREIGN KEY (project_id) REFERENCES projects(project_id), CHECK (kind IN ('subagent','task')), CHECK (mode IN ('one-shot','continuable','read-only')), CHECK (state IN ('running','inactive','diagnostic','succeeded','failed','redacted','unknown')));
      INSERT INTO child_links_old SELECT * FROM child_links;
      DROP TABLE child_links;
      ALTER TABLE child_links_old RENAME TO child_links;
      PRAGMA foreign_keys = ON`)
    db.prepare("DELETE FROM schema_migrations WHERE id = '0024_topology_cancelled_state'").run()
    db.prepare("UPDATE meta SET value = '20' WHERE key = 'schema_version'").run()

    runMigrations(db)
    expect((db.prepare('SELECT state FROM child_links WHERE child_id = ?').get('child-old') as { state: string }).state).toBe('running')
    expect((db.prepare('SELECT event_id FROM child_history WHERE child_id = ?').get('child-old') as { event_id: string }).event_id).toBe('evt-old')
    expect((db.prepare('SELECT message_id FROM child_followups WHERE child_id = ?').get('child-old') as { message_id: string }).message_id).toBe('msg-old')
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([])
    db.prepare("UPDATE child_links SET state = 'cancelled' WHERE child_id = 'child-old'").run()
    db.close()
  })

  it('0025 adds nullable runtime_json without rewriting legacy runner targets', () => {
    const db = openDatabase(':memory:')
    const before = db.prepare(`SELECT target_id, kind, revision, capabilities_json, connection_json
      FROM runner_targets ORDER BY target_id`).all()

    db.exec('ALTER TABLE runner_targets DROP COLUMN runtime_json')
    db.prepare("DELETE FROM schema_migrations WHERE id = '0025_runner_target_runtime'").run()
    db.prepare("UPDATE meta SET value = '21' WHERE key = 'schema_version'").run()

    runMigrations(db)
    expect(tableInfo(db, 'runner_targets').map(column => column.name)).toContain('runtime_json')
    expect(db.prepare('SELECT runtime_json FROM runner_targets').all())
      .toEqual([{ runtime_json: null }, { runtime_json: null }])
    expect(db.prepare(`SELECT target_id, kind, revision, capabilities_json, connection_json
      FROM runner_targets ORDER BY target_id`).all()).toEqual(before)
    expect((db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as { value: string }).value).toBe('35')
    db.close()
  })

  it('0026 adds target-scoped service identities and configures only built-in targets', () => {
    const db = openDatabase(':memory:')
    db.exec('ALTER TABLE runner_targets DROP COLUMN service_identity_json')
    db.prepare("DELETE FROM schema_migrations WHERE id = '0026_runner_target_service_identity'").run()
    db.prepare("UPDATE meta SET value = '22' WHERE key = 'schema_version'").run()

    runMigrations(db)
    const identities = db.prepare(`SELECT target_id, service_identity_json FROM runner_targets ORDER BY target_id`).all() as Array<{
      target_id: string
      service_identity_json: string | null
    }>
    expect(identities.map(row => ({ target_id: row.target_id, identity: JSON.parse(row.service_identity_json ?? 'null') }))).toEqual([
      { target_id: 'target_local_docker_v1', identity: { scheme: 'file', name: 'runner-targets/target_local_docker_v1.token', scope: 'instance' } },
      { target_id: 'target_local_process_v1', identity: { scheme: 'file', name: 'runner-targets/target_local_process_v1.token', scope: 'instance' } },
    ])
    expect((db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as { value: string }).value).toBe('35')
    db.close()
  })

  it('0027 canonicalizes legacy project execution without silently selecting a runner profile', () => {
    const db = openDatabase(':memory:')
    db.prepare("UPDATE projects SET execution = ? WHERE project_id = ?").run(
      JSON.stringify({
        runner_profile: 'local-docker-cpu',
        runner_target_id: 'target_local_docker_v1',
        network_policy: 'allowlist',
        artifact_store: 'local-cas',
      }),
      'missing-project',
    )
    db.prepare(`INSERT INTO projects (
      project_id, name, workspace, mode, status, revision, brief, constraints,
      execution, integrity, created_at, updated_at, history
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      'legacy-execution', 'Legacy execution', '/workspace/legacy', 'gate-only', 'DRAFT', 0,
      JSON.stringify({ problem: '', scope: '', questions: [], primary_metrics: [], resources: '', risks: [], target_outputs: [], target_venue: null, baseline_repo: null, domain: 'ml' }),
      JSON.stringify({ budget_usd: 0, gpu_hours: 0, deadline: null, allowed_datasets: [], forbidden_actions: [] }),
      JSON.stringify({ runner_profile: 'local-docker-cpu', runner_target_id: 'target_local_docker_v1', network_policy: 'allowlist', artifact_store: 'local-cas' }),
      JSON.stringify({ code_snapshot_required: true, env_lock_required: true, data_hash_required: true, seed_required: true, signatures_required: true }),
      '2026-08-20T00:00:00.000Z', '2026-08-20T00:00:00.000Z', '[]',
    )
    db.prepare("DELETE FROM schema_migrations WHERE id = '0027_project_execution_shape'").run()
    db.prepare("UPDATE meta SET value = '23' WHERE key = 'schema_version'").run()

    runMigrations(db)

    const execution = JSON.parse((db.prepare("SELECT execution FROM projects WHERE project_id = 'legacy-execution'").get() as { execution: string }).execution) as Record<string, unknown>
    expect(execution).toEqual({
      runner_profile_id: null,
      runner_target_id: 'target_local_docker_v1',
      network_policy: 'allowlist',
      artifact_store: 'local-cas',
      fixture_id: null,
    })
    expect(execution).not.toHaveProperty('runner_profile')
    db.close()
  })

  it('fails loudly when a released migration checksum changes', () => {
    const path = tmpDbPath()
    const db1 = openDatabase(path)
    db1.prepare("UPDATE schema_migrations SET checksum = 'deadbeef' WHERE id = ?").run('0001_schema_v2_initial')
    db1.close()
    expect(() => openDatabase(path)).toThrow(/checksum mismatch/)
    rmSync(path, { recursive: false, force: true })
  })

  it('fails loudly when the database is newer than the code', () => {
    const db = new DatabaseSync(':memory:')
    db.exec(`CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE schema_migrations (id TEXT PRIMARY KEY, checksum TEXT NOT NULL, applied_at TEXT NOT NULL, report_json TEXT NOT NULL)`)
    db.prepare("INSERT INTO meta (key, value) VALUES ('schema_version', '99')").run()
    expect(() => runMigrations(db)).toThrow(/downgrade/)
    db.close()
  })

  it('rolls a failed migration back and leaves schema_version untouched', () => {
    const db = new DatabaseSync(':memory:')
    MIGRATIONS.push({
      id: '9999_test_failure',
      description: 'test-only failing migration',
      body: 'boom',
      up: (d) => { d.exec('CREATE TABLE boom_t (x TEXT)'); throw new Error('boom') },
    })
    expect(() => runMigrations(db)).toThrow(/9999_test_failure failed: boom/)
    expect(tableInfo(db, 'boom_t').length).toBe(0)
    const version = db.prepare('SELECT value FROM meta WHERE key = ?').get('schema_version') as { value: string } | undefined
    expect(version).toBeUndefined()
    const applied = db.prepare('SELECT id FROM schema_migrations').all() as Array<{ id: string }>
    expect(applied.some(r => r.id === '9999_test_failure')).toBe(false)
    db.close()
  })

  it('imports a legacy v1 fixture: data preserved and upgraded in place', () => {
    const path = tmpDbPath()
    copyFileSync(FIXTURE, path)
    const db = openDatabase(path)
    expect((db.prepare('SELECT value FROM meta WHERE key = ?').get('schema_version') as { value: string }).value).toBe('35')
    // Projects preserved.
    const projects = db.prepare('SELECT project_id, name FROM projects ORDER BY project_id').all() as Array<{ project_id: string; name: string }>
    expect(projects).toEqual([{ project_id: 'p_legacy1', name: 'Legacy Study' }, { project_id: 'p_legacy2', name: 'Legacy Study B' }])
    // Decisions keep rows; durable principal columns exist and stay NULL for legacy actors.
    const decCols = tableInfo(db, 'decisions').map(c => c.name)
    for (const c of ['principal_id', 'principal_tenant_id', 'principal_auth_method', 'principal_session_id']) {
      expect(decCols).toContain(c)
    }
    const decision = db.prepare('SELECT decision_id, actor, decision, principal_id FROM decisions WHERE decision_id = ?').get('dec_legacy1') as { decision_id: string; actor: string; decision: string; principal_id: string | null }
    expect(decision.actor).toBe('legacy-operator')
    expect(decision.decision).toBe('approved')
    expect(decision.principal_id).toBeNull()
    // Artifacts become project-scoped (composite PK), rows intact.
    const artPk = tableInfo(db, 'artifacts').filter(c => c.pk > 0).length
    expect(artPk).toBe(2)
    // ART-02: media_type/file_name columns exist with sensible defaults.
    const artCols = tableInfo(db, 'artifacts').map(c => c.name)
    expect(artCols).toContain('media_type')
    expect(artCols).toContain('file_name')
    const artifacts = db.prepare('SELECT artifact_id, project_id FROM artifacts ORDER BY project_id').all() as Array<{ artifact_id: string; project_id: string }>
    expect(artifacts).toEqual([{ artifact_id: 'art_x', project_id: 'p_legacy1' }, { artifact_id: 'art_y', project_id: 'p_legacy2' }])
    // Jobs gained lease fencing + snapshot binding columns; row intact.
    const jobCols = tableInfo(db, 'jobs').map(c => c.name)
    expect(jobCols).toContain('lease_generation')
    expect(jobCols).toContain('code_snapshot_id')
    const job = db.prepare('SELECT job_id, idempotency_key, status FROM jobs WHERE job_id = ?').get('job_legacy1') as { job_id: string; idempotency_key: string; status: string }
    expect(job.idempotency_key).toBe('legacy-key-1')
    expect(job.status).toBe('succeeded')
    const jobIdx = db.prepare(`PRAGMA index_list('jobs')`).all() as Array<{ name: string; unique: number }>
    expect(jobIdx.some(i => i.name === 'idx_jobs_project_idempotency' && i.unique === 1)).toBe(true)
    // Evidence is legacy_unverified.
    const evidence = db.prepare('SELECT provenance_status FROM evidence WHERE evidence_id = ?').get('ev_legacy1') as { provenance_status: string }
    expect(evidence.provenance_status).toBe('legacy_unverified')
    // Manuscripts preserved AND converted into the initial TeX workspace.
    const manuscript = db.prepare('SELECT body FROM manuscripts WHERE manuscript_id = ?').get('ms_legacy1') as { body: string }
    expect(manuscript.body).toContain('Legacy manuscript body')
    const docId = `doc_${sha256('ms_legacy1').slice(0, 12)}`
    const doc = db.prepare('SELECT document_id, project_id, root_file, revision FROM tex_documents WHERE document_id = ?').get(docId) as { document_id: string; project_id: string; root_file: string; revision: number }
    expect(doc.project_id).toBe('p_legacy1')
    expect(doc.root_file).toBe('paper.tex')
    expect(doc.revision).toBe(1)
    const file = db.prepare('SELECT path, version, content FROM tex_files WHERE document_id = ?').get(docId) as { path: string; version: number; content: string }
    expect(file.path).toBe('paper.tex')
    expect(file.version).toBe(1)
    expect(file.content).toBe(manuscript.body)
    // Re-open: still idempotent and consistent.
    db.close()
    const db2 = openDatabase(path)
    expect((db2.prepare('SELECT COUNT(*) AS n FROM schema_migrations').get() as { n: number }).n).toBe(37)
    expect((db2.prepare('SELECT value FROM meta WHERE key = ?').get('schema_version') as { value: string }).value).toBe('35')
    db2.close()
    rmSync(path, { recursive: false, force: true })
  })

  it('upgrades a pre-outbox events table: new columns, defaults and seq backfill', () => {
    // Simulate a database produced by the PREVIOUS release (schema v6, no
    // outbox columns): open with the current code, then rewind the events
    // table + migration record + schema_version to the old shape.
    const db = openDatabase(':memory:')
    db.prepare('INSERT INTO events (event_id, project_id, kind, payload, source, delivered, created_at) VALUES (?, ?, ?, ?, ?, 0, ?)')
      .run('evt_preoutbox_1', 'p1', 'project.created', '{}', 'kernel', '2026-01-01T00:00:00.000Z')
    db.prepare('INSERT INTO events (event_id, project_id, kind, payload, source, delivered, created_at) VALUES (?, ?, ?, ?, ?, 0, ?)')
      .run('evt_preoutbox_2', 'p1', 'gate.created', '{}', 'kernel', '2026-01-01T00:00:01.000Z')
    const outboxCols = ['event_seq', 'event_version', 'aggregate_type', 'aggregate_id', 'aggregate_revision',
      'request_id', 'session_id', 'attempts', 'last_error', 'next_attempt_at', 'dead_lettered_at']
    db.exec('DROP INDEX IF EXISTS idx_events_aggregate_seq')
    // 0013 (TRAJ-01) added a keyset index over the outbox columns — it is
    // part of the simulated "old shape" removal too.
    db.exec('DROP INDEX IF EXISTS idx_events_project_seq')
    for (const c of outboxCols) db.exec(`ALTER TABLE events DROP COLUMN ${c}`)
    db.exec("DELETE FROM schema_migrations WHERE id = '0008_outbox_envelope'")
    db.prepare("UPDATE meta SET value = '6' WHERE key = 'schema_version'").run()
    runMigrations(db)
    // Version bumped; outbox columns re-added by the new migration.
    expect((db.prepare('SELECT value FROM meta WHERE key = ?').get('schema_version') as { value: string }).value).toBe('35')
    const cols = tableInfo(db, 'events').map(c => c.name)
    for (const c of outboxCols) expect(cols).toContain(c)
    // Existing rows get default envelope values + a stable backfilled seq.
    const rows = db.prepare('SELECT event_id, event_seq, event_version, aggregate_type, aggregate_id, aggregate_revision, attempts, last_error, next_attempt_at, dead_lettered_at FROM events ORDER BY event_id').all() as Array<Record<string, unknown>>
    expect(rows).toEqual([
      { event_id: 'evt_preoutbox_1', event_seq: 1, event_version: 1, aggregate_type: null, aggregate_id: null, aggregate_revision: null, attempts: 0, last_error: null, next_attempt_at: null, dead_lettered_at: null },
      { event_id: 'evt_preoutbox_2', event_seq: 2, event_version: 1, aggregate_type: null, aggregate_id: null, aggregate_revision: null, attempts: 0, last_error: null, next_attempt_at: null, dead_lettered_at: null },
    ])
    // New envelope writes keep allocating past the backfilled seq.
    db.prepare(`INSERT INTO events (event_id, project_id, kind, payload, source, delivered, created_at, event_seq, event_version, aggregate_type, aggregate_id, aggregate_revision, request_id, session_id, attempts, last_error, next_attempt_at, dead_lettered_at)
      VALUES (?, ?, ?, '{}', 'kernel', 0, ?, ?, 1, 'project', 'p1', NULL, NULL, NULL, 0, NULL, NULL, NULL)`)
      .run('evt_post_1', 'p1', 'project.renamed', '2026-01-01T00:00:02.000Z', 3)
    const post = db.prepare('SELECT event_seq, aggregate_type, aggregate_id FROM events WHERE event_id = ?').get('evt_post_1') as { event_seq: number; aggregate_type: string; aggregate_id: string }
    expect(post.event_seq).toBe(3)
    expect(post.aggregate_type).toBe('project')
    expect(post.aggregate_id).toBe('p1')
    db.close()
  })

  it('0014 (STORE-06): legacy rows get lease_token_hash backfilled from payload.__lease_token', () => {
    // Simulate a database produced by the PREVIOUS release (schema v12, no
    // lease_token_hash): open with the current code, then rewind the jobs
    // table + migration record + schema_version to the old shape.
    const db = openDatabase(':memory:')
    db.prepare(`INSERT INTO jobs (job_id, project_id, idempotency_key, kind, command, payload, status, lease_owner, lease_expires_at, lease_generation, attempts, max_attempts, created_at, updated_at)
      VALUES (?, ?, ?, 'smoke', '[]', ?, 'running', 'legacy-runner', '2026-02-01T00:00:00.000Z', 1, 1, 3, ?, ?)`)
      .run('job_legacy_lease', 'p1', 'legacy-key', JSON.stringify({ __lease_token: 'lt_legacysecret', data: 1 }), '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')
    db.exec("DELETE FROM schema_migrations WHERE id IN ('0014_lease_token_hash','0038_remove_plaintext_lease_storage')")
    db.exec('ALTER TABLE jobs DROP COLUMN lease_token_hash')
    db.prepare("UPDATE meta SET value = '12' WHERE key = 'schema_version'").run()
    runMigrations(db)
    // 0014 hashes the historical row; 0038 completes the current migration
    // chain by removing the reserved plaintext payload key.
    const row = db.prepare('SELECT lease_token_hash, payload FROM jobs WHERE job_id = ?').get('job_legacy_lease') as { lease_token_hash: string; payload: string }
    expect(row.lease_token_hash).toBe(sha256('lt_legacysecret'))
    expect(row.lease_token_hash).toMatch(/^[0-9a-f]{64}$/)
    expect(JSON.parse(row.payload)).toEqual({ data: 1 })
    // Rows without a token keep NULL (no hash to derive).
    db.prepare(`INSERT INTO jobs (job_id, project_id, idempotency_key, kind, command, payload, status, attempts, max_attempts, created_at, updated_at)
      VALUES (?, ?, ?, 'smoke', '[]', '{}', 'queued', 0, 3, ?, ?)`)
      .run('job_never_claimed', 'p1', 'other-key', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')
    const never = db.prepare('SELECT lease_token_hash FROM jobs WHERE job_id = ?').get('job_never_claimed') as { lease_token_hash: string | null }
    expect(never.lease_token_hash).toBeNull()
    db.close()
  })

  it('0014 then 0036 upgrades a plaintext context-less PTY without inventing authority', () => {
    const db = openDatabase(':memory:')
    // Rewind pty_sessions to the pre-0014 shape (plaintext NOT NULL, no
    // hash column) and drop the 0014 record.
    db.exec('DROP TABLE pty_sessions')
    db.exec(`CREATE TABLE pty_sessions (
      pty_session_id TEXT PRIMARY KEY, project_id TEXT NOT NULL, workspace_id TEXT NOT NULL,
      principal_id TEXT NOT NULL, tenant_id TEXT NOT NULL DEFAULT '', profile TEXT NOT NULL,
      target TEXT NOT NULL, preset TEXT NOT NULL, cwd TEXT NOT NULL, config_hash TEXT NOT NULL,
      state TEXT NOT NULL, generation INTEGER NOT NULL, lease_token TEXT NOT NULL,
      lease_expires_at TEXT, idle_ttl_s INTEGER NOT NULL, retention_bytes INTEGER NOT NULL,
      retained_from_seq INTEGER NOT NULL DEFAULT 0, last_client_seq INTEGER NOT NULL DEFAULT 0,
      last_event_seq INTEGER NOT NULL DEFAULT 0, total_bytes INTEGER NOT NULL DEFAULT 0,
      dropped_bytes INTEGER NOT NULL DEFAULT 0, adapter_id TEXT NOT NULL DEFAULT 'none',
      open_at TEXT NOT NULL, last_activity_at TEXT NOT NULL, closed_at TEXT, close_reason TEXT,
      CHECK (state IN ('open','attached','detached','closed')), CHECK (preset IN ('sh','bash','zsh','fish'))
    )`)
    db.prepare(`INSERT INTO pty_sessions (pty_session_id, project_id, workspace_id, principal_id, tenant_id, profile, target, preset, cwd, config_hash, state, generation, lease_token, lease_expires_at, idle_ttl_s, retention_bytes, open_at, last_activity_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run('pty_legacy1', 'p1', 'ws1', 'pi1', 't1', 'local-docker-cpu', 'tgt', 'bash', 'scratch', 'sha256:deadbeef', 'open', 1, 'lease_legacysecret', '2026-02-01T00:00:00.000Z', 900, 1048576, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')
    db.prepare(`INSERT INTO pty_frames
      (pty_session_id, server_seq, frame_kind, type, payload_json, byte_length, created_at)
      VALUES ('pty_legacy1', 1, 'output', 'stdout', '{"data":"old"}', 3, '2026-01-01T00:00:00.000Z')`).run()
    db.exec("DELETE FROM schema_migrations WHERE id IN ('0014_lease_token_hash','0036_pty_context_reset','0038_remove_plaintext_lease_storage')")
    db.prepare("UPDATE meta SET value = '12' WHERE key = 'schema_version'").run()
    runMigrations(db)
    // 0014 can complete its released hash rebuild against the frozen legacy
    // DDL. 0036 then drops the transient row/frame instead of fabricating a
    // Research/Chat/Subagent context from project/profile/target fields.
    const cols = tableInfo(db, 'pty_sessions').map(c => c.name)
    for (const column of ['lease_token_hash', 'context_kind', 'context_id', 'parent_session_id', 'label', 'purpose']) {
      expect(cols).toContain(column)
    }
    expect(cols).not.toContain('lease_token')
    expect((db.prepare('SELECT COUNT(*) AS n FROM pty_sessions').get() as { n: number }).n).toBe(0)
    expect((db.prepare('SELECT COUNT(*) AS n FROM pty_frames').get() as { n: number }).n).toBe(0)
    const report = JSON.parse((db.prepare("SELECT report_json FROM schema_migrations WHERE id='0036_pty_context_reset'").get() as { report_json: string }).report_json) as { rows: Record<string, number> }
    expect(report.rows).toMatchObject({ pty_sessions_discarded: 1, pty_frames_discarded: 1 })
    const idx = db.prepare(`PRAGMA index_list('pty_sessions')`).all() as Array<{ name: string }>
    expect(idx.some(i => i.name === 'idx_pty_sessions_project')).toBe(true)
    expect(idx.some(i => i.name === 'idx_pty_sessions_context')).toBe(true)
    db.close()
  })

  it('0038 removes plaintext lease storage while preserving current PTY sessions and frames', () => {
    const db = openDatabase(':memory:')
    const token = 'lease_upgrade_secret'
    const oldManifest = JSON.stringify({
      run_id: 'run_upgrade_0038', job_id: 'job_upgrade_0038',
      lease: { generation: 1, token }, runner_key_id: 'runner-old',
      payload_sha256: 'old-payload-hash', signature: 'old-signature', exit_code: 0,
    })
    db.prepare(`INSERT INTO jobs (job_id, project_id, idempotency_key, kind, command, payload, status, lease_owner, lease_expires_at, lease_generation, attempts, max_attempts, run_manifest, signature_status, created_at, updated_at)
      VALUES (?, ?, ?, 'smoke', '[]', ?, 'running', 'runner-upgrade', '2026-02-01T00:00:00.000Z', 1, 1, 3, ?, 'signed', ?, ?)`).run(
      'job_upgrade_0038', 'p1', 'upgrade-0038', JSON.stringify({ __lease_token: token, data: 7 }), oldManifest,
      '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z',
    )
    db.prepare(`INSERT INTO runs
      (run_id, project_id, job_id, attempt_no, contract_id, snapshot_sha256, manifest_json, signature_status, started_at, finished_at)
      VALUES ('run_upgrade_0038', 'p1', 'job_upgrade_0038', 1, NULL, NULL, ?, 'signed', ?, ?)`)
      .run(oldManifest, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:01.000Z')
    db.exec('ALTER TABLE pty_sessions ADD COLUMN lease_token TEXT')
    db.prepare(`INSERT INTO pty_sessions (
      pty_session_id, project_id, workspace_id, principal_id, tenant_id,
      context_kind, context_id, parent_session_id, label, purpose,
      profile, target, preset, cwd, config_hash, state, generation,
      lease_token_hash, lease_expires_at, idle_ttl_s, retention_bytes,
      open_at, last_activity_at, lease_token
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      'pty_upgrade_0038', 'p1', 'ws_upgrade', 'pi1', 'tenant1',
      'chat', 'session_upgrade', null, 'Upgrade shell', 'preserve me',
      'local-process', 'target_local_process_v1', 'bash', '', 'sha256:config', 'open', 4,
      '', '2026-02-01T00:00:00.000Z', 900, 1048576,
      '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', 'pty-secret',
    )
    db.prepare(`INSERT INTO pty_frames
      (pty_session_id, server_seq, frame_kind, type, payload_json, byte_length, created_at)
      VALUES (?, 1, 'output', 'stdout', '{"data":"kept"}', 4, ?)`).run(
      'pty_upgrade_0038', '2026-01-01T00:00:01.000Z',
    )
    db.exec("DELETE FROM schema_migrations WHERE id = '0038_remove_plaintext_lease_storage'")
    db.prepare("UPDATE meta SET value = '34' WHERE key = 'schema_version'").run()

    runMigrations(db)

    const job = db.prepare('SELECT payload, lease_token_hash, run_manifest, signature_status FROM jobs WHERE job_id = ?').get('job_upgrade_0038') as { payload: string; lease_token_hash: string; run_manifest: string; signature_status: string }
    expect(JSON.parse(job.payload)).toEqual({ data: 7 })
    expect(job.lease_token_hash).toBe(sha256(token))
    const jobManifest = JSON.parse(job.run_manifest) as Record<string, unknown>
    expect(jobManifest.lease).toEqual({ generation: 1 })
    expect(jobManifest).not.toHaveProperty('signature')
    expect(jobManifest).not.toHaveProperty('runner_key_id')
    expect(jobManifest).not.toHaveProperty('payload_sha256')
    expect(job.signature_status).toBe('credential_redacted')
    const run = db.prepare('SELECT manifest_json, signature_status FROM runs WHERE run_id = ?').get('run_upgrade_0038') as { manifest_json: string; signature_status: string }
    expect(JSON.parse(run.manifest_json)).toEqual(jobManifest)
    expect(run.signature_status).toBe('credential_redacted')
    const columns = tableInfo(db, 'pty_sessions').map(column => column.name)
    expect(columns).not.toContain('lease_token')
    expect(db.prepare('SELECT label, purpose, generation, lease_token_hash FROM pty_sessions WHERE pty_session_id = ?').get('pty_upgrade_0038')).toEqual({
      label: 'Upgrade shell', purpose: 'preserve me', generation: 4, lease_token_hash: sha256('pty-secret'),
    })
    expect(db.prepare('SELECT payload_json FROM pty_frames WHERE pty_session_id = ? AND server_seq = 1').get('pty_upgrade_0038')).toEqual({ payload_json: '{"data":"kept"}' })
    const report = JSON.parse((db.prepare("SELECT report_json FROM schema_migrations WHERE id = '0038_remove_plaintext_lease_storage'").get() as { report_json: string }).report_json) as { rows: Record<string, number> }
    expect(report.rows).toMatchObject({
      jobs_scrubbed: 1, job_manifests_scrubbed: 1, run_manifests_scrubbed: 1,
      job_hashes_backfilled: 1, pty_hashes_backfilled: 1,
      pty_sessions_preserved: 1, pty_frames_preserved: 1,
    })
    db.close()
  })

  it('0038 rolls back when plaintext and persisted lease hash conflict', () => {
    const db = openDatabase(':memory:')
    db.prepare(`INSERT INTO jobs (job_id, project_id, idempotency_key, kind, command, payload, status, lease_owner, lease_expires_at, lease_generation, lease_token_hash, attempts, max_attempts, created_at, updated_at)
      VALUES (?, ?, ?, 'smoke', '[]', ?, 'running', 'runner-upgrade', '2026-02-01T00:00:00.000Z', 1, ?, 1, 3, ?, ?)`).run(
      'job_conflict_0038', 'p1', 'conflict-0038', JSON.stringify({ __lease_token: 'token-a', data: 8 }), sha256('token-b'),
      '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z',
    )
    db.exec('ALTER TABLE pty_sessions ADD COLUMN lease_token TEXT')
    db.exec("DELETE FROM schema_migrations WHERE id = '0038_remove_plaintext_lease_storage'")
    db.prepare("UPDATE meta SET value = '34' WHERE key = 'schema_version'").run()

    expect(() => runMigrations(db)).toThrow(/plaintext lease token conflicts with its hash/)
    expect(JSON.parse((db.prepare('SELECT payload FROM jobs WHERE job_id = ?').get('job_conflict_0038') as { payload: string }).payload)).toEqual({ __lease_token: 'token-a', data: 8 })
    expect((db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as { value: string }).value).toBe('34')
    expect(db.prepare("SELECT 1 FROM schema_migrations WHERE id = '0038_remove_plaintext_lease_storage'").get()).toBeUndefined()
    expect(tableInfo(db, 'pty_sessions').map(column => column.name)).toContain('lease_token')
    db.close()
  })

  it('0038 rolls back instead of redacting a signed manifest whose token conflicts with the Job hash', () => {
    const db = openDatabase(':memory:')
    const manifest = JSON.stringify({
      run_id: 'run_manifest_conflict_0038', job_id: 'job_manifest_conflict_0038',
      lease: { generation: 1, token: 'token-a' },
      runner_key_id: 'runner-old', payload_sha256: 'old-hash', signature: 'old-signature',
    })
    db.prepare(`INSERT INTO jobs
      (job_id, project_id, idempotency_key, kind, command, payload, status,
       lease_owner, lease_expires_at, lease_generation, lease_token_hash,
       attempts, max_attempts, run_manifest, signature_status, created_at, updated_at)
      VALUES (?, ?, ?, 'smoke', '[]', '{}', 'running', 'runner-upgrade', ?, 1, ?, 1, 3, ?, 'signed', ?, ?)`)
      .run(
        'job_manifest_conflict_0038', 'p1', 'manifest-conflict-0038',
        '2026-02-01T00:00:00.000Z', sha256('token-b'), manifest,
        '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z',
      )
    db.prepare(`INSERT INTO runs
      (run_id, project_id, job_id, attempt_no, manifest_json, signature_status, started_at)
      VALUES ('run_manifest_conflict_0038', 'p1', 'job_manifest_conflict_0038', 1, ?, 'signed', ?)`)
      .run(manifest, '2026-01-01T00:00:00.000Z')
    db.prepare("DELETE FROM schema_migrations WHERE id = '0038_remove_plaintext_lease_storage'").run()
    db.prepare("UPDATE meta SET value = '34' WHERE key = 'schema_version'").run()

    expect(() => runMigrations(db)).toThrow(/run_manifest plaintext lease token conflicts with its Job hash/)
    expect(db.prepare('SELECT run_manifest, signature_status FROM jobs WHERE job_id = ?').get('job_manifest_conflict_0038'))
      .toEqual({ run_manifest: manifest, signature_status: 'signed' })
    expect(db.prepare('SELECT manifest_json, signature_status FROM runs WHERE run_id = ?').get('run_manifest_conflict_0038'))
      .toEqual({ manifest_json: manifest, signature_status: 'signed' })
    expect((db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as { value: string }).value).toBe('34')
    db.close()
  })

  it('STORE-08: 0003 stays a released migration — checksum binds the function source which references the shared DDL constants', () => {
    const m = MIGRATIONS.find(x => x.id === '0003_terminal_tex_i18n_capabilities')
    expect(m).toBeDefined()
    // RELEASED-MIGRATION FREEZE (reverted inline-snapshot experiment): the
    // canonical body is the up source, which executes the shared
    // TERMINAL_DDL/TEX_DDL constants by name — that is the behaviour that
    // was released, and the checksums recorded on existing databases bind
    // this exact source text. Editing the body would break every existing
    // database ("released migrations are immutable").
    expect(m!.body).toContain('db.exec(TERMINAL_DDL)')
    expect(m!.body).toContain('db.exec(TEX_DDL)')
    expect(m!.body).not.toMatch(/TERMINAL_DDL_0003|TEX_DDL_0003/)
    // The recorded checksum is a pure function of id + body: any edit to the
    // released body changes the checksum (immutability is enforced), and the
    // constants referenced BY NAME are part of the released behaviour — they
    // must only grow through new migrations, never be edited in place.
    expect(checksumOf(m!)).toBe(sha256(`${m!.id}\n${m!.body}`))
    expect(checksumOf({ ...m!, body: m!.body + '\n-- shared TEX_DDL evolved elsewhere\n' })).not.toBe(checksumOf(m!))
    expect(checksumOf({ ...m!, body: m!.body.replace('db.exec(TERMINAL_DDL)', 'db.exec(TERMINAL_DDL_X)') })).not.toBe(checksumOf(m!))
    // 0003 still converges the terminal/TeX tables on a fresh database via
    // the shared constants (CREATE IF NOT EXISTS is idempotent).
    const db = openDatabase(':memory:')
    expect(tableInfo(db, 'tex_snapshot_files').length).toBeGreaterThan(0)
    expect(tableInfo(db, 'tex_preview_pending').length).toBeGreaterThan(0)
    db.close()
  })

  it('keeps the committed v1 fixture asset present and buildable', () => {
    expect(existsSync(FIXTURE)).toBe(true)
    // The regeneration script must exist so the binary asset is reproducible.
    const script = fileURLToPath(new URL('../fixtures/databases/build-v1-fixture.mjs', import.meta.url))
    expect(existsSync(script)).toBe(true)
  })

  it('0017 (MIG-V1): v1 fixture import marks synthetic_fixture / unsigned_legacy and materializes the final log Artifact', () => {
    const path = tmpDbPath()
    const casDir = mkdtempSync(join(tmpdir(), 'dsh-mig-cas-'))
    copyFileSync(FIXTURE, path)
    const db = openDatabase(path, undefined, casDir)
    expect((db.prepare('SELECT value FROM meta WHERE key = ?').get('schema_version') as { value: string }).value).toBe('35')
    // STORE-08 rule: the canonical body binds the up source AND the helpers
    // it executes — editing either changes the recorded checksum.
    const m17 = MIGRATIONS.find(x => x.id === '0017_v1_legacy_marks')
    expect(m17).toBeDefined()
    expect(m17!.body).toContain('manifestHasSignature')
    expect(m17!.body).toContain('composeLegacyLog')
    // Columns exist after the upgrade.
    const jobCols = tableInfo(db, 'jobs').map(c => c.name)
    for (const c of ['synthetic_fixture', 'signature_status', 'legacy_log_artifact']) expect(jobCols).toContain(c)
    // §9 synthetic_fixture: v1 echo/smoke jobs are fixture runs.
    const echo = db.prepare('SELECT synthetic_fixture, signature_status, legacy_log_artifact FROM jobs WHERE job_id = ?').get('job_echo1') as { synthetic_fixture: number; signature_status: string | null; legacy_log_artifact: string | null }
    expect(echo.synthetic_fixture).toBe(1)
    const smoke = db.prepare('SELECT synthetic_fixture FROM jobs WHERE job_id = ?').get('job_smoke1') as { synthetic_fixture: number }
    expect(smoke.synthetic_fixture).toBe(1)
    // Non-fixture legacy rows stay 0 (the kind-scoped backfill never touches them).
    const baseline = db.prepare('SELECT synthetic_fixture FROM jobs WHERE job_id = ?').get('job_legacy1') as { synthetic_fixture: number }
    expect(baseline.synthetic_fixture).toBe(0)
    // §9 unsigned_legacy: unsigned manifest + succeeded-without-manifest.
    const manifest1 = db.prepare('SELECT signature_status FROM jobs WHERE job_id = ?').get('job_manifest1') as { signature_status: string | null }
    expect(manifest1.signature_status).toBe('legacy_unsigned')
    const noManifest = db.prepare('SELECT signature_status FROM jobs WHERE job_id = ?').get('job_legacy1') as { signature_status: string | null }
    expect(noManifest.signature_status).toBe('legacy_unsigned')
    // §9 legacy log → final log Artifact: kind='log' artifact + CAS blob +
    // durable reference on the job. No terminal frames are fabricated.
    expect(echo.legacy_log_artifact).toMatch(/^sha256:[0-9a-f]{64}$/)
    const logArtifact = db.prepare("SELECT artifact_id, kind, size_bytes, sha256, media_type, file_name, metadata FROM artifacts WHERE project_id = ? AND kind = 'log'").get('p_legacy1') as {
      artifact_id: string; kind: string; size_bytes: number; sha256: string; media_type: string; file_name: string; metadata: string
    }
    expect(logArtifact.artifact_id).toBe(echo.legacy_log_artifact)
    expect(logArtifact.kind).toBe('log')
    expect(logArtifact.media_type).toBe('text/plain; charset=utf-8')
    expect(logArtifact.file_name).toBe('legacy-run-job_echo1.log')
    expect(JSON.parse(logArtifact.metadata)).toMatchObject({ legacy_log: true, source: 'v1 payload', job_id: 'job_echo1' })
    // The blob physically exists in CAS and its content hash matches the row.
    const blob = readFileSync(join(casDir, logArtifact.sha256), 'utf8')
    expect(blob).toContain('=== dsh-scholar legacy run (job job_echo1, kind echo) ===')
    expect(blob).toContain('--- stdout ---')
    expect(blob).toContain('echo fixture output line 1')
    expect(blob).toContain('--- stderr ---')
    expect(blob).toContain('echo fixture stderr line')
    expect(createHash('sha256').update(blob, 'utf8').digest('hex')).toBe(logArtifact.sha256)
    expect(logArtifact.size_bytes).toBe(Buffer.byteLength(blob, 'utf8'))
    // Re-open: idempotent — same marks, no duplicate artifacts, version stable.
    db.close()
    const db2 = openDatabase(path, undefined, casDir)
    expect((db2.prepare('SELECT COUNT(*) AS n FROM schema_migrations').get() as { n: number }).n).toBe(37)
    const echo2 = db2.prepare('SELECT synthetic_fixture, signature_status, legacy_log_artifact FROM jobs WHERE job_id = ?').get('job_echo1') as { synthetic_fixture: number; signature_status: string | null; legacy_log_artifact: string | null }
    expect(echo2.synthetic_fixture).toBe(1)
    expect(echo2.signature_status).toBeNull()
    expect(echo2.legacy_log_artifact).toBe(echo.legacy_log_artifact)
    expect((db2.prepare("SELECT COUNT(*) AS n FROM artifacts WHERE kind = 'log'").get() as { n: number }).n).toBe(1)
    db2.close()
    rmSync(path, { recursive: false, force: true })
    rmSync(casDir, { recursive: true, force: true })
  })

  it('0017 (MIG-V1): backfills are idempotent and never touch post-0017 rows', () => {
    const casDir = mkdtempSync(join(tmpdir(), 'dsh-mig-cas-'))
    const db = openDatabase(':memory:', undefined, casDir)
    // Legacy-shaped rows (as written by a pre-0017 release).
    db.prepare(`INSERT INTO jobs (job_id, project_id, contract_id, idempotency_key, kind, command, payload, status, failure_class, lease_owner, lease_expires_at, lease_generation, attempts, max_attempts, run_manifest, error, created_at, updated_at)
      VALUES (?, ?, ?, ?, 'baseline', '[]', '{}', 'succeeded', NULL, NULL, NULL, 1, 1, 3, ?, '', ?, ?)`)
      .run('job_pre_unsigned', 'p1', null, 'pre-key-1', JSON.stringify({ job_id: 'job_pre_unsigned', exit_code: 0 }), '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')
    db.prepare(`INSERT INTO runs (run_id, project_id, job_id, attempt_no, contract_id, snapshot_sha256, manifest_json, signature_status, started_at, finished_at)
      VALUES (?, 'p1', 'job_pre_unsigned', 1, NULL, NULL, NULL, 'unsigned', ?, ?)`)
      .run('run_pre_unsigned', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:01.000Z')
    // Rewind 0017 (simulate a database produced by the PREVIOUS release) and
    // re-run: the legacy rows must be marked.
    db.exec("DELETE FROM schema_migrations WHERE id = '0017_v1_legacy_marks'")
    db.prepare("UPDATE meta SET value = '14' WHERE key = 'schema_version'").run()
    runMigrations(db, undefined, casDir)
    const pre = db.prepare('SELECT signature_status FROM jobs WHERE job_id = ?').get('job_pre_unsigned') as { signature_status: string | null }
    expect(pre.signature_status).toBe('legacy_unsigned')
    const preRun = db.prepare('SELECT signature_status FROM runs WHERE run_id = ?').get('run_pre_unsigned') as { signature_status: string }
    expect(preRun.signature_status).toBe('legacy_unsigned')
    // Post-0017 rows: governed by the NEW regime — the backfills must not touch them.
    db.prepare(`INSERT INTO jobs (job_id, project_id, contract_id, idempotency_key, kind, command, payload, status, failure_class, lease_owner, lease_expires_at, lease_generation, attempts, max_attempts, run_manifest, error, created_at, updated_at, synthetic_fixture, signature_status, legacy_log_artifact)
      VALUES (?, 'p1', NULL, 'new-key-1', 'baseline', '[]', '{}', 'succeeded', NULL, NULL, NULL, 1, 1, 3, ?, '', ?, ?, 0, NULL, NULL)`)
      .run('job_new_signed', JSON.stringify({ job_id: 'job_new_signed', exit_code: 0, signature: 'sig-test', runner_key_id: 'k1' }), '2026-02-01T00:00:00.000Z', '2026-02-01T00:00:00.000Z')
    db.prepare(`INSERT INTO runs (run_id, project_id, job_id, attempt_no, contract_id, snapshot_sha256, manifest_json, signature_status, started_at, finished_at)
      VALUES ('run_new_signed', 'p1', 'job_new_signed', 1, NULL, NULL, ?, 'signed', ?, ?)`)
      .run(JSON.stringify({ job_id: 'job_new_signed', signature: 'sig-test' }), '2026-02-01T00:00:00.000Z', '2026-02-01T00:00:01.000Z')
    db.prepare(`INSERT INTO runs (run_id, project_id, job_id, attempt_no, contract_id, snapshot_sha256, manifest_json, signature_status, started_at, finished_at)
      VALUES ('run_new_pending', 'p1', 'job_new_signed', 2, NULL, NULL, NULL, 'pending', ?, NULL)`)
      .run('2026-02-01T00:00:00.000Z')
    // A fixture job created by the post-0017 kernel (already marked 1).
    db.prepare(`INSERT INTO jobs (job_id, project_id, idempotency_key, kind, command, payload, status, attempts, max_attempts, error, created_at, updated_at, synthetic_fixture)
      VALUES (?, 'p1', 'new-echo-1', 'echo', '[]', '{}', 'queued', 0, 3, '', ?, ?, 1)`)
      .run('job_new_echo', '2026-02-01T00:00:00.000Z', '2026-02-01T00:00:00.000Z')
    // Second rewind re-run: idempotent backfill, new rows untouched.
    db.exec("DELETE FROM schema_migrations WHERE id = '0017_v1_legacy_marks'")
    db.prepare("UPDATE meta SET value = '14' WHERE key = 'schema_version'").run()
    runMigrations(db, undefined, casDir)
    const newJob = db.prepare('SELECT signature_status, synthetic_fixture FROM jobs WHERE job_id = ?').get('job_new_signed') as { signature_status: string | null; synthetic_fixture: number }
    expect(newJob.signature_status).toBeNull()
    expect(newJob.synthetic_fixture).toBe(0)
    const newRunSigned = db.prepare('SELECT signature_status FROM runs WHERE run_id = ?').get('run_new_signed') as { signature_status: string }
    expect(newRunSigned.signature_status).toBe('signed')
    const newRunPending = db.prepare('SELECT signature_status FROM runs WHERE run_id = ?').get('run_new_pending') as { signature_status: string }
    expect(newRunPending.signature_status).toBe('pending')
    const newEcho = db.prepare('SELECT synthetic_fixture FROM jobs WHERE job_id = ?').get('job_new_echo') as { synthetic_fixture: number }
    expect(newEcho.synthetic_fixture).toBe(1)
    // Legacy rows keep their marks.
    const pre2 = db.prepare('SELECT signature_status FROM jobs WHERE job_id = ?').get('job_pre_unsigned') as { signature_status: string | null }
    expect(pre2.signature_status).toBe('legacy_unsigned')
    db.close()
    rmSync(casDir, { recursive: true, force: true })
  })

  it('0017 (MIG-V1): without a CAS root the legacy log is marked, not materialized', () => {
    const path = tmpDbPath()
    copyFileSync(FIXTURE, path)
    const db = openDatabase(path)
    const echo = db.prepare('SELECT legacy_log_artifact FROM jobs WHERE job_id = ?').get('job_echo1') as { legacy_log_artifact: string | null }
    expect(echo.legacy_log_artifact).toBe('legacy:in-payload')
    // No phantom artifact row referencing a missing blob (integrity stays clean).
    expect((db.prepare("SELECT COUNT(*) AS n FROM artifacts WHERE kind = 'log'").get() as { n: number }).n).toBe(0)
    db.close()
    rmSync(path, { recursive: false, force: true })
  })

  it('0018 (WORK-01 §5 P2): workspaces.quarantine column, idempotent rewind, durable marker survives re-open', () => {
    const path = tmpDbPath()
    const db = openDatabase(path)
    // Fresh databases carry the column (0018 runs after 0011's released DDL).
    const wsCols = tableInfo(db, 'workspaces').map(c => c.name)
    expect(wsCols).toContain('quarantine')
    // A quarantined row (as written by the recovery scan) reads back intact.
    db.prepare("INSERT INTO workspaces (workspace_id, project_id, kind, name, revision, created_at, updated_at, quarantine) VALUES (?, 'p1', 'code', 'w', 1, ?, ?, ?)")
      .run('ws_q1', '2026-08-11T00:00:00.000Z', '2026-08-11T00:00:00.000Z', 'row a.txt (v1) has no disk bytes')
    // Rewind 0018 (simulate a database produced by the PREVIOUS release):
    // re-running adds the column back and touches nothing else.
    db.exec("DELETE FROM schema_migrations WHERE id = '0018_workspace_recovery_quarantine'")
    db.prepare("UPDATE meta SET value = '15' WHERE key = 'schema_version'").run()
    runMigrations(db)
    expect((db.prepare('SELECT value FROM meta WHERE key = ?').get('schema_version') as { value: string }).value).toBe('35')
    const q = db.prepare('SELECT quarantine FROM workspaces WHERE workspace_id = ?').get('ws_q1') as { quarantine: string | null }
    expect(q.quarantine).toContain('a.txt')
    // The report row counts the quarantined marker (idempotent).
    const m18 = MIGRATIONS.find(x => x.id === '0018_workspace_recovery_quarantine')
    expect(m18?.body).toContain('ensureColumn')
    db.close()
    rmSync(path, { recursive: false, force: true })
  })

  it('0019 (PROJECT-DELETE-01): adds the project tombstone and unique request receipt columns', () => {
    const path = tmpDbPath()
    const db = openDatabase(path)
    const columns = tableInfo(db, 'projects').map(column => column.name)
    for (const name of ['deleted_at', 'deleted_by', 'deletion_reason', 'deletion_request_id']) {
      expect(columns).toContain(name)
    }
    const indexes = db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'projects'")
      .all() as unknown as Array<{ name: string }>
    expect(indexes.map(index => index.name)).toContain('idx_projects_deletion_request')
    db.close()
    rmSync(path, { recursive: false, force: true })
  })
})
