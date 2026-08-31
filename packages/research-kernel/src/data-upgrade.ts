/**
 * One-time Research Kernel data adoption.
 *
 * Upgrade paths never make the UI read two databases. A retired Kernel is
 * snapshotted, migrated in isolation, merged transactionally into the one
 * canonical data directory, and recorded by source database id. The source
 * is never opened for writes and runtime credentials are never copied.
 * @module @dsh-scholar/research-kernel/data-upgrade
 */

import { createHash, randomUUID } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import {
  chmodSync, copyFileSync, existsSync, lstatSync, mkdtempSync,
  readFileSync, readdirSync, renameSync, rmSync, writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve, sep } from 'node:path'
import { createStartupBackup, type StartupBackupResult } from './backup.js'
import { mkdirMode } from './fs-modes.js'
import { openDatabase } from './store.js'
import { SCHEMA_VERSION } from './migrations.js'

const DB_FILE = 'kernel.db'
const IMPORT_DIR = 'data-imports'
const ADOPTION_FORMAT_VERSION = 5
const CAS_NAME = 'cas'
const COPY_ROOTS = [CAS_NAME, 'workspaces', 'pty-workspaces'] as const
const NON_PRODUCT_TABLES = new Set(['meta', 'schema_migrations'])
const MERGE_SIDE_EFFECT_TRIGGERS = [
  'methodology_project_rollout_on_create',
  'methodology_activation_rollout_consumption',
  'assurance_execution_rollout_consumption',
] as const

/** Parent-first order; every current product table is merged exactly once. */
const MERGE_TABLES = [
  'methodology_rollout_policies',
  'projects', 'project_members', 'budget',
  'gates', 'decisions', 'budget_block_provenance', 'full_auto_gate_idempotency', 'chat_scope_tombstones',
  'ideas', 'contracts', 'corpus_snapshots', 'code_snapshots',
  'jobs', 'runs', 'artifacts', 'evidence', 'claims', 'events', 'session_links', 'manuscripts',
  'methodology_project_rollout_events',
  'assurance_events', 'methodology_run_outcomes', 'methodology_project_events', 'methodology_registry_events',
  'writing_methodology_events', 'writing_patch_intents',
  'methodology_rollout_consumptions',
  'terminal_retention', 'terminal_frames',
  'tex_documents', 'tex_files', 'tex_snapshots', 'tex_snapshot_files', 'tex_builds', 'tex_preview_pending',
  'workspaces', 'workspace_nodes', 'workspace_ops', 'pty_sessions', 'pty_frames',
  'intake_sessions', 'intake_artifacts',
  'ocr_requests', 'ocr_result_artifacts', 'ocr_observations',
  'intake_observations', 'intake_questions',
  'child_links', 'child_history', 'child_followups',
  'model_providers', 'model_provider_models', 'upload_sessions', 'upload_chunks',
  'config_write_layers', 'config_write_revisions',
  'reproduction_specs', 'reproduction_attempts', 'reproduction_reports', 'reproduction_links',
  'runner_targets', 'runner_keys', 'project_grill_answers',
] as const

const PTY_CONTEXT_REQUIRED_COLUMNS = [
  'context_kind', 'context_id', 'parent_session_id', 'label', 'purpose',
] as const

type SqlValue = null | string | number | bigint | Uint8Array
type SqlRow = Record<string, SqlValue>

export interface KernelDataAdoptionReceipt {
  format_version: number
  status: 'imported' | 'already_imported'
  source_database_id: string
  source_data_dir: string
  target_data_dir: string
  source_snapshot_sha256: string
  imported_at: string
  rows_inserted: number
  rows_already_present: number
  operator_memberships_added: number
  files_copied: number
  files_already_present: number
  target_backup: StartupBackupResult | null
  adopting_operator_principal: string
  receipt_path: string
}

export interface AdoptLegacyKernelDataOptions {
  sourceDataDir: string
  targetDataDir: string
  /** Stable server-side local operator identity; never supplied by a browser. */
  operatorPrincipal: string
  log?: (line: string) => void
}

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`
}

function sqlString(value: string): string {
  return `'${value.replaceAll("'", "''")}'`
}

function sha256File(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

function sameSqlValue(left: SqlValue, right: SqlValue): boolean {
  if (left instanceof Uint8Array || right instanceof Uint8Array) {
    return left instanceof Uint8Array && right instanceof Uint8Array
      && Buffer.from(left).equals(Buffer.from(right))
  }
  return left === right
}

function sameRow(left: SqlRow, right: SqlRow, columns: string[]): boolean {
  return columns.every(column => sameSqlValue(left[column] ?? null, right[column] ?? null))
}

function readDatabaseId(dbPath: string): string | null {
  if (!existsSync(dbPath)) return null
  try {
    const db = new DatabaseSync(dbPath, { readOnly: true })
    try {
      return (db.prepare("SELECT value FROM meta WHERE key = 'database_id'").get() as { value?: string } | undefined)?.value ?? null
    } finally {
      db.close()
    }
  } catch {
    return null
  }
}

function safeReceiptName(databaseId: string): string {
  return databaseId.replace(/[^A-Za-z0-9._-]/g, '_')
}

function readReceipt(path: string): KernelDataAdoptionReceipt | null {
  if (!existsSync(path)) return null
  const value = JSON.parse(readFileSync(path, 'utf8')) as Partial<KernelDataAdoptionReceipt>
  if (typeof value.source_database_id !== 'string' || typeof value.source_snapshot_sha256 !== 'string') {
    throw new Error(`kernel data adoption receipt is malformed: ${path}`)
  }
  return {
    ...value,
    format_version: typeof value.format_version === 'number' ? value.format_version : 0,
    adopting_operator_principal: typeof value.adopting_operator_principal === 'string' ? value.adopting_operator_principal : '',
  } as KernelDataAdoptionReceipt
}

function writeReceipt(path: string, receipt: KernelDataAdoptionReceipt): void {
  const temporary = `${path}.tmp-${process.pid}-${randomUUID()}`
  writeFileSync(temporary, `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600, flag: 'wx' })
  chmodSync(temporary, 0o600)
  renameSync(temporary, path)
}

interface CopyStats {
  copied: number
  existing: number
}

function copyRegularTree(source: string, target: string, rootName: string, stats: CopyStats): void {
  const sourceStat = lstatSync(source)
  if (sourceStat.isSymbolicLink()) throw new Error(`kernel data adoption refuses symlink: ${source}`)
  if (sourceStat.isDirectory()) {
    if (rootName === 'pty-workspaces' && basename(source) === '.dsh-pty-runtime') return
    mkdirMode(target, 0o700)
    for (const entry of readdirSync(source, { withFileTypes: true })) {
      copyRegularTree(join(source, entry.name), join(target, entry.name), rootName, stats)
    }
    return
  }
  if (!sourceStat.isFile()) throw new Error(`kernel data adoption supports regular files only: ${source}`)

  if (rootName === CAS_NAME && dirname(source).endsWith(`${sep}${CAS_NAME}`) && /^[0-9a-f]{64}$/.test(basename(source))) {
    const actual = sha256File(source)
    if (actual !== basename(source)) throw new Error(`kernel data adoption found corrupt CAS blob ${source}`)
  }
  mkdirMode(dirname(target), 0o700)
  if (existsSync(target)) {
    const targetStat = lstatSync(target)
    if (targetStat.isSymbolicLink() || !targetStat.isFile()) {
      throw new Error(`kernel data adoption target collision is not a regular file: ${target}`)
    }
    if (sourceStat.size !== targetStat.size || sha256File(source) !== sha256File(target)) {
      throw new Error(`kernel data adoption file conflict: ${target}`)
    }
    stats.existing += 1
    return
  }
  const temporary = `${target}.import-${process.pid}-${randomUUID()}`
  copyFileSync(source, temporary)
  chmodSync(temporary, sourceStat.mode & 0o777)
  renameSync(temporary, target)
  stats.copied += 1
}

function tableColumns(db: DatabaseSync, schema: string, table: string): Array<{ name: string; pk: number }> {
  return db.prepare(`PRAGMA ${quoteIdentifier(schema)}.table_info(${quoteIdentifier(table)})`).all() as Array<{ name: string; pk: number }>
}

function productTableInventory(db: DatabaseSync, schema: string): string[] {
  return (db.prepare(`SELECT name FROM ${quoteIdentifier(schema)}.sqlite_master
    WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name`).all() as Array<{ name: string }>)
    .map(row => row.name)
    .filter(name => !NON_PRODUCT_TABLES.has(name))
}

/** Fail loudly when a migration adds durable state without defining its adoption order. */
function assertCompleteMergeInventory(db: DatabaseSync): void {
  const expected = new Set<string>(MERGE_TABLES)
  for (const schema of ['main', 'legacy']) {
    const actual = productTableInventory(db, schema)
    const actualSet = new Set(actual)
    const missing = actual.filter(table => !expected.has(table))
    const stale = [...expected].filter(table => !actualSet.has(table)).sort()
    if (missing.length > 0 || stale.length > 0) {
      throw new Error(`kernel data adoption table inventory mismatch for ${schema}`
        + ` (unmerged=${missing.join(',') || 'none'}; absent=${stale.join(',') || 'none'})`)
    }
  }
}

interface PtyContextInventory {
  main: { sessions: number; frames: number }
  legacy: { sessions: number; frames: number }
}

/** PTY is transient, but a current context-bound source is still merged
 * exactly. Validate its authority-bearing shape and row accounting before
 * any insert, and reject orphan frames because pty_frames intentionally has
 * no formal-evidence foreign key. */
function assertPtyContextInventory(db: DatabaseSync): PtyContextInventory {
  const result = {} as PtyContextInventory
  for (const schema of ['main', 'legacy'] as const) {
    const columns = tableColumns(db, schema, 'pty_sessions').map(column => column.name)
    const missing = PTY_CONTEXT_REQUIRED_COLUMNS.filter(column => !columns.includes(column))
    if (missing.length > 0) {
      throw new Error(`PTY context inventory for ${schema}.pty_sessions is missing required column(s): ${missing.join(',')}`)
    }
    const sessions = Number((db.prepare(`SELECT COUNT(*) AS n FROM ${quoteIdentifier(schema)}.pty_sessions`).get() as { n: number }).n)
    const frames = Number((db.prepare(`SELECT COUNT(*) AS n FROM ${quoteIdentifier(schema)}.pty_frames`).get() as { n: number }).n)
    const orphans = Number((db.prepare(`SELECT COUNT(*) AS n
      FROM ${quoteIdentifier(schema)}.pty_frames AS frame
      LEFT JOIN ${quoteIdentifier(schema)}.pty_sessions AS session
        ON session.pty_session_id = frame.pty_session_id
      WHERE session.pty_session_id IS NULL`).get() as { n: number }).n)
    if (orphans > 0) {
      throw new Error(`kernel data adoption found ${orphans} orphan PTY frame(s) in ${schema}`)
    }
    result[schema] = { sessions, frames }
  }
  return result
}

/**
 * Raw ledger adoption must not fire business triggers that derive new rows.
 * Their exact source rows are merged later in the same transaction. SQLite
 * DDL is transactional, so a rollback restores every dropped trigger.
 */
function suspendMergeSideEffectTriggers(db: DatabaseSync): string[] {
  const placeholders = MERGE_SIDE_EFFECT_TRIGGERS.map(() => '?').join(', ')
  const rows = db.prepare(`SELECT name, sql FROM main.sqlite_master
    WHERE type = 'trigger' AND name IN (${placeholders}) ORDER BY name`)
    .all(...MERGE_SIDE_EFFECT_TRIGGERS) as Array<{ name: string; sql: string | null }>
  if (rows.length !== MERGE_SIDE_EFFECT_TRIGGERS.length || rows.some(row => row.sql === null)) {
    throw new Error('kernel data adoption is missing a required merge side-effect trigger')
  }
  for (const row of rows) db.exec(`DROP TRIGGER ${quoteIdentifier(row.name)}`)
  return rows.map(row => row.sql!)
}

function mergeTable(db: DatabaseSync, table: string): { inserted: number; existing: number } {
  const sourceColumns = tableColumns(db, 'legacy', table)
  const targetColumns = tableColumns(db, 'main', table)
  if (sourceColumns.length === 0 || targetColumns.length === 0) {
    throw new Error(`kernel data adoption schema is missing table ${table}`)
  }
  const sourceNames = sourceColumns.map(column => column.name)
  const targetNames = targetColumns.map(column => column.name)
  if (sourceNames.length !== targetNames.length || targetNames.some(column => !sourceNames.includes(column))) {
    throw new Error(`kernel data adoption schema mismatch for ${table}`)
  }
  const primaryKey = sourceColumns.filter(column => column.pk > 0).sort((a, b) => a.pk - b.pk).map(column => column.name)
  if (primaryKey.length === 0) throw new Error(`kernel data adoption table ${table} has no primary key`)

  const quotedTable = quoteIdentifier(table)
  // Additive SQLite migrations can produce the same logical schema with a
  // different physical column order. Always project in the target order.
  const columns = targetNames
  const quotedColumns = columns.map(quoteIdentifier)
  const sourceRows = db.prepare(`SELECT ${quotedColumns.join(', ')} FROM legacy.${quotedTable}`).all() as SqlRow[]
  const find = db.prepare(`SELECT ${quotedColumns.join(', ')} FROM main.${quotedTable} WHERE ${primaryKey.map(column => `${quoteIdentifier(column)} = ?`).join(' AND ')}`)
  const insert = db.prepare(`INSERT INTO main.${quotedTable} (${quotedColumns.join(', ')}) VALUES (${sourceNames.map(() => '?').join(', ')})`)
  let inserted = 0
  let existing = 0
  for (const row of sourceRows) {
    const key = primaryKey.map(column => row[column]!)
    const current = find.get(...key) as SqlRow | undefined
    if (current !== undefined) {
      // Built-in RunnerTarget health/revision is local runtime state. The
      // canonical target keeps its current row; custom target collisions are
      // treated like every other conflicting domain row.
      if (table === 'runner_targets' && typeof row.target_id === 'string' && row.target_id.startsWith('target_local_')) {
        existing += 1
        continue
      }
      if (!sameRow(row, current, columns)) {
        throw new Error(`kernel data adoption row conflict in ${table} (${key.map(String).join(', ')})`)
      }
      existing += 1
      continue
    }
    insert.run(...columns.map(column => row[column]!))
    inserted += 1
  }
  if (inserted + existing !== sourceRows.length) {
    throw new Error(`kernel data adoption row-count mismatch for ${table}`)
  }
  return { inserted, existing }
}

/**
 * Adopt one retired Kernel into the canonical target. Call only while the
 * target Kernel is stopped; an IMMEDIATE transaction rejects concurrent
 * writers. The receipt makes subsequent starts a constant-time no-op.
 */
export function adoptLegacyKernelData(options: AdoptLegacyKernelDataOptions): KernelDataAdoptionReceipt {
  const sourceDataDir = resolve(options.sourceDataDir)
  const targetDataDir = resolve(options.targetDataDir)
  const operatorPrincipal = options.operatorPrincipal.trim()
  if (operatorPrincipal === '') throw new Error('kernel data adoption requires a stable operator principal')
  if (sourceDataDir === targetDataDir) throw new Error('kernel data adoption source and target must differ')
  const sourceDbPath = join(sourceDataDir, DB_FILE)
  const targetDbPath = join(targetDataDir, DB_FILE)
  if (!existsSync(sourceDbPath)) throw new Error(`kernel data adoption source database does not exist: ${sourceDbPath}`)

  const originalDatabaseId = readDatabaseId(sourceDbPath)
  if (originalDatabaseId !== null) {
    const receiptPath = join(targetDataDir, IMPORT_DIR, `${safeReceiptName(originalDatabaseId)}.json`)
    const prior = readReceipt(receiptPath)
    if (prior !== null) {
      if (prior.format_version >= ADOPTION_FORMAT_VERSION) return { ...prior, status: 'already_imported', receipt_path: receiptPath }
    }
  }

  let targetBackup: StartupBackupResult | null = null
  if (existsSync(targetDbPath)) {
    targetBackup = createStartupBackup({
      dbPath: targetDbPath,
      casRoot: join(targetDataDir, CAS_NAME),
      instanceId: `data-adoption-${safeReceiptName(originalDatabaseId ?? 'unidentified-source')}`,
    })
  }
  mkdirMode(join(targetDataDir, IMPORT_DIR), 0o700)
  const stagingDir = mkdtempSync(join(tmpdir(), 'dsh-scholar-data-adoption-'))
  chmodSync(stagingDir, 0o700)
  const snapshotPath = join(stagingDir, DB_FILE)
  let targetDb: DatabaseSync | null = null
  try {
    const source = new DatabaseSync(sourceDbPath)
    try {
      source.exec(`VACUUM INTO ${sqlString(snapshotPath)}`)
    } finally {
      source.close()
    }
    chmodSync(snapshotPath, 0o600)
    const sourceSnapshotSha256 = sha256File(snapshotPath)
    const migratedCas = join(stagingDir, CAS_NAME)
    const migratedSource = openDatabase(snapshotPath, options.log, migratedCas)
    const sourceDatabaseId = (migratedSource.prepare("SELECT value FROM meta WHERE key = 'database_id'").get() as { value: string }).value
    migratedSource.close()

    const receiptPath = join(targetDataDir, IMPORT_DIR, `${safeReceiptName(sourceDatabaseId)}.json`)
    const prior = readReceipt(receiptPath)
    if (prior !== null) {
      if (prior.format_version >= ADOPTION_FORMAT_VERSION) return { ...prior, status: 'already_imported', receipt_path: receiptPath }
    }

    const copyStats: CopyStats = { copied: 0, existing: 0 }
    targetDb = openDatabase(targetDbPath, options.log, join(targetDataDir, CAS_NAME))
    targetDb.exec(`ATTACH DATABASE ${sqlString(snapshotPath)} AS legacy`)
    let rowsInserted = 0
    let rowsAlreadyPresent = 0
    let membershipsAdded = 0
    try {
      targetDb.exec('BEGIN IMMEDIATE')
      targetDb.exec('PRAGMA defer_foreign_keys = ON')
      try {
        assertCompleteMergeInventory(targetDb)
        const ptyBefore = assertPtyContextInventory(targetDb)
        const suspendedTriggers = suspendMergeSideEffectTriggers(targetDb)
        const ptyInserted = { sessions: 0, frames: 0 }
        for (const table of MERGE_TABLES) {
          const result = mergeTable(targetDb, table)
          rowsInserted += result.inserted
          rowsAlreadyPresent += result.existing
          if (table === 'pty_sessions') ptyInserted.sessions = result.inserted
          if (table === 'pty_frames') ptyInserted.frames = result.inserted
        }
        const ptyAfter = assertPtyContextInventory(targetDb)
        if (ptyAfter.main.sessions !== ptyBefore.main.sessions + ptyInserted.sessions
          || ptyAfter.main.frames !== ptyBefore.main.frames + ptyInserted.frames) {
          throw new Error('kernel data adoption PTY row-count reconciliation failed')
        }
        const now = new Date().toISOString()
        const grant = targetDb.prepare(`INSERT OR IGNORE INTO project_members
          (project_id, principal_id, tenant_id, role, created_at, updated_at)
          VALUES (?, ?, 'local', 'pi', ?, ?)`)
        // Historical DSH/plugin tokens created different local principals.
        // A data-adoption event is the one audited moment where the current
        // stable local operator takes ownership of the complete canonical
        // workbench, including rows that were already in the target.
        const canonicalProjectIds = (targetDb.prepare('SELECT project_id FROM projects ORDER BY project_id').all() as Array<{ project_id: string }>)
          .map(row => row.project_id)
        for (const projectId of canonicalProjectIds) {
          const result = grant.run(projectId, operatorPrincipal, now, now)
          membershipsAdded += Number(result.changes)
        }
        // A PTY adapter process and its in-memory lease token cannot survive
        // a Kernel move. Preserve the current context row/frames but close
        // the runtime through the existing lease-expiry vocabulary.
        const closePty = targetDb.prepare(`UPDATE pty_sessions SET state='closed', closed_at=COALESCE(closed_at, ?),
          close_reason=COALESCE(close_reason, 'lease_expired') WHERE pty_session_id=? AND state<>'closed'`)
        for (const row of targetDb.prepare('SELECT pty_session_id FROM legacy.pty_sessions').all() as Array<{ pty_session_id: string }>) {
          closePty.run(now, row.pty_session_id)
        }
        for (const sql of suspendedTriggers) targetDb.exec(sql)
        const violations = targetDb.prepare('PRAGMA foreign_key_check').all()
        if (violations.length > 0) throw new Error(`foreign key check failed (${violations.length} violation(s))`)
        targetDb.exec('COMMIT')
      } catch (error) {
        targetDb.exec('ROLLBACK')
        throw error
      }

      for (const rootName of COPY_ROOTS) {
        const sourceRoot = join(sourceDataDir, rootName)
        if (existsSync(sourceRoot)) copyRegularTree(sourceRoot, join(targetDataDir, rootName), rootName, copyStats)
      }
      if (existsSync(migratedCas)) copyRegularTree(migratedCas, join(targetDataDir, CAS_NAME), CAS_NAME, copyStats)

      const importedAt = new Date().toISOString()
      const receipt: KernelDataAdoptionReceipt = {
        format_version: ADOPTION_FORMAT_VERSION,
        status: 'imported',
        source_database_id: sourceDatabaseId,
        source_data_dir: sourceDataDir,
        target_data_dir: targetDataDir,
        source_snapshot_sha256: sourceSnapshotSha256,
        imported_at: importedAt,
        rows_inserted: rowsInserted,
        rows_already_present: rowsAlreadyPresent,
        operator_memberships_added: membershipsAdded,
        files_copied: copyStats.copied,
        files_already_present: copyStats.existing,
        target_backup: targetBackup,
        adopting_operator_principal: operatorPrincipal,
        receipt_path: receiptPath,
      }
      writeReceipt(receiptPath, receipt)
      options.log?.(`research-kernel: adopted ${sourceDatabaseId} from ${sourceDataDir} (${rowsInserted} rows, ${copyStats.copied} files)`)
      return receipt
    } finally {
      try { targetDb.exec('DETACH DATABASE legacy') } catch { /* connection close detaches it */ }
    }
  } catch (error) {
    throw new Error(`kernel data adoption failed for ${sourceDataDir}: ${(error as Error).message}`)
  } finally {
    targetDb?.close()
    rmSync(stagingDir, { recursive: true, force: true })
  }
}

/** Whether an existing canonical DB needs a backup-backed schema upgrade. */
export function kernelDatabaseNeedsMigration(dataDir: string): boolean {
  const dbPath = join(resolve(dataDir), DB_FILE)
  if (!existsSync(dbPath)) return false
  try {
    const db = new DatabaseSync(dbPath, { readOnly: true })
    try {
      const value = (db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as { value?: string } | undefined)?.value
      const version = Number(value)
      return !Number.isFinite(version) || version < SCHEMA_VERSION
    } finally {
      db.close()
    }
  } catch {
    // A pre-meta Kernel is necessarily older than the current schema.
    return true
  }
}
