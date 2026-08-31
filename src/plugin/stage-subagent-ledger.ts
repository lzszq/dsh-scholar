import { chmodSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

export type PanelExecutionState =
  | 'reserving'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'cancelled'
  | 'stale'
  | 'unknown'

export interface FourBucketUsage {
  input_tokens: number | null
  output_tokens: number | null
  cache_read_tokens: number | null
  cache_write_tokens: number | null
}

export interface DurablePanelAttempt {
  attempt_id: string
  perspective_index: number
  label: string
  child_id: string | null
  state: 'starting' | 'running' | 'succeeded' | 'failed' | 'cancelled' | 'unknown'
  started_at: string
  ended_at: string | null
  duration_ms: number | null
  usage: FourBucketUsage
  model_cost_usd: number | null
  output_hash: string | null
}

export interface PanelAdmission {
  panelId: string
  scopedKey: string
  inputHash: string
  projectId: string
  sessionId: string
  actionKey: string
  attempt: number
  confirmation: {
    receipt_id: string
    host_call_id: string
    root_call_id: string
    binding_hash: string
    confirmed_at: string
  }
  frozen: Record<string, unknown>
  reservedApiRequests: number
}

export type AdmissionDecision =
  | { kind: 'admitted'; admission: PanelAdmission }
  | { kind: 'replay'; result: unknown }
  | { kind: 'conflict'; reason: string }
  | { kind: 'blocked'; reason: string }

interface ExecutionRow {
  panel_id: string
  scoped_key: string
  input_hash: string
  project_id: string
  session_id: string
  action_key: string
  attempt: number
  state: PanelExecutionState
  result_json: string | null
}

const TERMINAL_STATES = new Set<PanelExecutionState>(['succeeded', 'failed', 'cancelled', 'stale'])

function nowIso(): string {
  return new Date().toISOString()
}

function assertCount(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${label} must be a non-negative safe integer`)
}

/**
 * Durable plugin-side execution ledger for the DSH public Subagent seam.
 *
 * The Kernel remains the research authority. This ledger owns only the facts
 * that the Kernel cannot infer: one Host approval, one paid fan-out admission,
 * exact child attempts, four-bucket provider usage and restart recovery. An
 * interrupted paid execution becomes `unknown`; opening the ledger never
 * replays it.
 */
export class StageSubagentLedger {
  private readonly db: DatabaseSync
  private closed = false

  constructor(readonly path: string) {
    if (path !== ':memory:') {
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
      chmodSync(dirname(path), 0o700)
    }
    this.db = new DatabaseSync(path)
    if (path !== ':memory:') chmodSync(path, 0o600)
    this.db.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000; PRAGMA journal_mode = DELETE; PRAGMA synchronous = FULL;')
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS stage_panel_confirmations (
        receipt_id TEXT PRIMARY KEY,
        host_call_id TEXT NOT NULL UNIQUE,
        root_call_id TEXT NOT NULL,
        binding_hash TEXT NOT NULL,
        project_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        action_key TEXT NOT NULL,
        confirmed_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS stage_panel_executions (
        panel_id TEXT PRIMARY KEY,
        scoped_key TEXT NOT NULL UNIQUE,
        input_hash TEXT NOT NULL,
        project_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        action_key TEXT NOT NULL,
        attempt INTEGER NOT NULL,
        confirmation_id TEXT NOT NULL,
        state TEXT NOT NULL CHECK (state IN ('reserving','running','succeeded','failed','cancelled','stale','unknown')),
        frozen_json TEXT NOT NULL,
        reserved_api_requests INTEGER NOT NULL,
        result_json TEXT,
        started_at TEXT NOT NULL,
        ended_at TEXT,
        duration_ms INTEGER,
        FOREIGN KEY (confirmation_id) REFERENCES stage_panel_confirmations(receipt_id),
        UNIQUE (action_key, attempt)
      );
      CREATE INDEX IF NOT EXISTS idx_stage_panel_action_state
        ON stage_panel_executions(action_key, state, attempt);
      CREATE TABLE IF NOT EXISTS stage_panel_children (
        panel_id TEXT NOT NULL,
        perspective_index INTEGER NOT NULL,
        attempt_id TEXT NOT NULL UNIQUE,
        label TEXT NOT NULL,
        child_id TEXT,
        state TEXT NOT NULL CHECK (state IN ('starting','running','succeeded','failed','cancelled','unknown')),
        started_at TEXT NOT NULL,
        ended_at TEXT,
        duration_ms INTEGER,
        usage_json TEXT,
        model_cost_usd REAL,
        output_hash TEXT,
        PRIMARY KEY (panel_id, perspective_index),
        FOREIGN KEY (panel_id) REFERENCES stage_panel_executions(panel_id) ON DELETE CASCADE
      );
    `)
    this.recoverInterrupted()
  }

  static memory(): StageSubagentLedger {
    return new StageSubagentLedger(':memory:')
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    this.db.close()
  }

  private transaction<T>(body: () => T): T {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const result = body()
      this.db.exec('COMMIT')
      return result
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  private recoverInterrupted(): void {
    const endedAt = nowIso()
    this.transaction(() => {
      this.db.prepare(`
        UPDATE stage_panel_children
        SET state = 'unknown', ended_at = ?,
            duration_ms = MAX(0, CAST((julianday(?) - julianday(started_at)) * 86400000 AS INTEGER))
        WHERE state IN ('starting','running')
      `).run(endedAt, endedAt)
      this.db.prepare(`
        UPDATE stage_panel_executions
        SET state = 'unknown', ended_at = ?,
            duration_ms = MAX(0, CAST((julianday(?) - julianday(started_at)) * 86400000 AS INTEGER))
        WHERE state IN ('reserving','running')
      `).run(endedAt, endedAt)
    })
  }

  admit(input: {
    panelId: string
    scopedKey: string
    inputHash: string
    projectId: string
    sessionId: string
    actionKey: string
    confirmationReceiptId: string
    hostCallId: string
    rootCallId: string
    confirmationBindingHash: string
    frozen: Record<string, unknown>
    reservedApiRequests: number
  }): AdmissionDecision {
    assertCount(input.reservedApiRequests, 'reservedApiRequests')
    return this.transaction(() => {
      const existing = this.db.prepare(`
        SELECT panel_id, scoped_key, input_hash, project_id, session_id, action_key,
               attempt, state, result_json
        FROM stage_panel_executions WHERE scoped_key = ?
      `).get(input.scopedKey) as unknown as ExecutionRow | undefined
      if (existing !== undefined) {
        if (existing.input_hash !== input.inputHash) {
          return { kind: 'conflict', reason: 'panel idempotency_key conflicts with different input' }
        }
        if (existing.result_json !== null && TERMINAL_STATES.has(existing.state)) {
          return { kind: 'replay', result: JSON.parse(existing.result_json) as unknown }
        }
        return {
          kind: 'blocked',
          reason: existing.state === 'unknown'
            ? 'panel execution was interrupted; paid work is unknown and will not be replayed automatically'
            : 'panel execution is already in progress for this idempotency key',
        }
      }

      const callReceipt = this.db.prepare('SELECT binding_hash FROM stage_panel_confirmations WHERE host_call_id = ?')
        .get(input.hostCallId) as { binding_hash: string } | undefined
      if (callReceipt !== undefined) {
        return { kind: 'conflict', reason: 'Host confirmation call was already consumed by another panel' }
      }

      const actionRows = this.db.prepare(`
        SELECT panel_id, state, attempt FROM stage_panel_executions
        WHERE action_key = ? ORDER BY attempt DESC
      `).all(input.actionKey) as unknown as Array<{ panel_id: string; state: PanelExecutionState; attempt: number }>
      const blocking = actionRows.find(row => row.state === 'reserving' || row.state === 'running'
        || row.state === 'unknown' || row.state === 'succeeded')
      if (blocking !== undefined) {
        return {
          kind: 'blocked',
          reason: blocking.state === 'unknown'
            ? 'the current action has an interrupted panel with unknown paid work'
            : 'a stage subagent panel already exists for the current action',
        }
      }
      const attempt = (actionRows[0]?.attempt ?? 0) + 1
      const confirmedAt = nowIso()
      this.db.prepare(`
        INSERT INTO stage_panel_confirmations
          (receipt_id, host_call_id, root_call_id, binding_hash, project_id, session_id, action_key, confirmed_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        input.confirmationReceiptId, input.hostCallId, input.rootCallId, input.confirmationBindingHash,
        input.projectId, input.sessionId, input.actionKey, confirmedAt,
      )
      this.db.prepare(`
        INSERT INTO stage_panel_executions
          (panel_id, scoped_key, input_hash, project_id, session_id, action_key, attempt,
           confirmation_id, state, frozen_json, reserved_api_requests, started_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'reserving', ?, ?, ?)
      `).run(
        input.panelId, input.scopedKey, input.inputHash, input.projectId, input.sessionId,
        input.actionKey, attempt, input.confirmationReceiptId, JSON.stringify(input.frozen),
        input.reservedApiRequests, confirmedAt,
      )
      return {
        kind: 'admitted',
        admission: {
          panelId: input.panelId,
          scopedKey: input.scopedKey,
          inputHash: input.inputHash,
          projectId: input.projectId,
          sessionId: input.sessionId,
          actionKey: input.actionKey,
          attempt,
          confirmation: {
            receipt_id: input.confirmationReceiptId,
            host_call_id: input.hostCallId,
            root_call_id: input.rootCallId,
            binding_hash: input.confirmationBindingHash,
            confirmed_at: confirmedAt,
          },
          frozen: input.frozen,
          reservedApiRequests: input.reservedApiRequests,
        },
      }
    })
  }

  markBudgetCharged(panelId: string): void {
    const changed = this.db.prepare(`
      UPDATE stage_panel_executions SET state = 'running'
      WHERE panel_id = ? AND state = 'reserving'
    `).run(panelId).changes
    if (changed !== 1) throw new Error('panel budget reservation is no longer admissible')
  }

  failAdmission(panelId: string, result: unknown): void {
    const endedAt = nowIso()
    this.db.prepare(`
      UPDATE stage_panel_executions
      SET state = 'failed', result_json = ?, ended_at = ?,
          duration_ms = MAX(0, CAST((julianday(?) - julianday(started_at)) * 86400000 AS INTEGER))
      WHERE panel_id = ? AND state IN ('reserving','running')
    `).run(JSON.stringify(result), endedAt, endedAt, panelId)
  }

  markUnknown(panelId: string): void {
    const endedAt = nowIso()
    this.db.prepare(`
      UPDATE stage_panel_executions
      SET state = 'unknown', ended_at = ?,
          duration_ms = MAX(0, CAST((julianday(?) - julianday(started_at)) * 86400000 AS INTEGER))
      WHERE panel_id = ? AND state IN ('reserving','running')
    `).run(endedAt, endedAt, panelId)
  }

  startChild(panelId: string, perspectiveIndex: number, attemptId: string, label: string): string {
    assertCount(perspectiveIndex, 'perspectiveIndex')
    const startedAt = nowIso()
    this.db.prepare(`
      INSERT INTO stage_panel_children
        (panel_id, perspective_index, attempt_id, label, state, started_at)
      VALUES (?, ?, ?, ?, 'starting', ?)
    `).run(panelId, perspectiveIndex, attemptId, label, startedAt)
    return startedAt
  }

  bindChild(panelId: string, perspectiveIndex: number, childId: string): void {
    const changed = this.db.prepare(`
      UPDATE stage_panel_children SET child_id = ?, state = 'running'
      WHERE panel_id = ? AND perspective_index = ? AND state = 'starting'
    `).run(childId, panelId, perspectiveIndex).changes
    if (changed !== 1) throw new Error('panel child attempt is no longer startable')
  }

  finishChild(input: {
    panelId: string
    perspectiveIndex: number
    state: 'succeeded' | 'failed' | 'cancelled'
    usage: FourBucketUsage
    modelCostUsd: number | null
    outputHash: string | null
  }): { endedAt: string; durationMs: number } {
    const endedAt = nowIso()
    const row = this.db.prepare(`
      SELECT started_at FROM stage_panel_children WHERE panel_id = ? AND perspective_index = ?
    `).get(input.panelId, input.perspectiveIndex) as { started_at: string } | undefined
    if (row === undefined) throw new Error('panel child attempt was not registered')
    const durationMs = Math.max(0, Date.parse(endedAt) - Date.parse(row.started_at))
    const changed = this.db.prepare(`
      UPDATE stage_panel_children
      SET state = ?, ended_at = ?, duration_ms = ?, usage_json = ?, model_cost_usd = ?, output_hash = ?
      WHERE panel_id = ? AND perspective_index = ? AND state IN ('starting','running')
    `).run(
      input.state, endedAt, durationMs, JSON.stringify(input.usage), input.modelCostUsd,
      input.outputHash, input.panelId, input.perspectiveIndex,
    ).changes
    if (changed !== 1) throw new Error('panel child attempt is no longer finishable')
    return { endedAt, durationMs }
  }

  attempts(panelId: string): DurablePanelAttempt[] {
    const rows = this.db.prepare(`
      SELECT attempt_id, perspective_index, label, child_id, state, started_at,
             ended_at, duration_ms, usage_json, model_cost_usd, output_hash
      FROM stage_panel_children WHERE panel_id = ? ORDER BY perspective_index
    `).all(panelId) as unknown as Array<{
      attempt_id: string
      perspective_index: number
      label: string
      child_id: string | null
      state: DurablePanelAttempt['state']
      started_at: string
      ended_at: string | null
      duration_ms: number | null
      usage_json: string | null
      model_cost_usd: number | null
      output_hash: string | null
    }>
    return rows.map(row => ({
      attempt_id: row.attempt_id,
      perspective_index: row.perspective_index,
      label: row.label,
      child_id: row.child_id,
      state: row.state,
      started_at: row.started_at,
      ended_at: row.ended_at,
      duration_ms: row.duration_ms,
      usage: row.usage_json === null
        ? { input_tokens: null, output_tokens: null, cache_read_tokens: null, cache_write_tokens: null }
        : JSON.parse(row.usage_json) as FourBucketUsage,
      model_cost_usd: row.model_cost_usd,
      output_hash: row.output_hash,
    }))
  }

  complete(panelId: string, state: Extract<PanelExecutionState, 'succeeded' | 'failed' | 'cancelled' | 'stale'>, result: unknown): void {
    const endedAt = nowIso()
    const changed = this.db.prepare(`
      UPDATE stage_panel_executions
      SET state = ?, result_json = ?, ended_at = ?,
          duration_ms = MAX(0, CAST((julianday(?) - julianday(started_at)) * 86400000 AS INTEGER))
      WHERE panel_id = ? AND state = 'running'
    `).run(state, JSON.stringify(result), endedAt, endedAt, panelId).changes
    if (changed !== 1) throw new Error('panel execution is no longer completable')
  }
}
