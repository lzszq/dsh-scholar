/**
 * PTY-01 (execution-runtime.md §6.1, hardening-v0.2-status.md §3/§4) —
 * Interactive Terminal session store + pure state machine (interface layer).
 *
 * This module owns the DURABLE session surface — the same authority a
 * LocalDockerPty or RemoteRunnerPty adapter will later attach a real
 * pseudo-terminal to. Everything here is pure logic over SQLite rows:
 *
 *   state machine:  open → attached → detached → closed
 *                   (attach/detach bump generation for reconnect;
 *                    permission revocation → detach;
 *                    idle TTL / lease expiry / explicit close → closed)
 *   control frames: client_seq is the idempotency key — the last applied
 *                   seq is stored per session; a duplicate seq replays
 *                   (no-op), a reordered/gapped seq is 409. Every frame is
 *                   audited (pty_frames, frame_kind='control').
 *   output frames:  append-only, server_seq monotonic per session
 *                   (output | exit | gap), bounded by retention_bytes —
 *                   evicted seqs are reported as a gap, never silently
 *                   dropped (mirrors terminal_frames retention).
 *   lease:          opaque token + expiry pinned at open.
 *
 * SECURITY BOUNDARY (execution-runtime.md §6.1): PTY output is auditable and
 * retained in a bounded window but is NOT a formal Job log. It can never
 * generate Metrics, a RunManifest, accepted Evidence or a Gate Decision —
 * this store has no write path to jobs/runs/evidence/gates/events, and the
 * kernel never routes pty frames into those tables. `pty-not-evidence`
 * (tests/unit/pty-session.test.ts) pins that invariant.
 *
 * The store is adapter-neutral: LocalPtyAdapter and remote adapters implement
 * the same spawn/control contract, while browser rendering remains outside
 * this durable authority module.
 * @module @dsh-scholar/research-kernel/pty-session
 */

import { DatabaseSync } from 'node:sqlite'
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import {
  PTY_DEFAULT_IDLE_TTL_S,
  PTY_DEFAULT_LEASE_TTL_S,
  PTY_DEFAULT_RETENTION_BYTES,
  randomId,
} from '@dsh-scholar/research-schemas'
import type {
  PtyContextSessions, PtyControlFrame, PtyControlRequest, PtyOpenRequest, PtyOutputFrame, PtySession, PtySignal,
} from '@dsh-scholar/research-schemas'
import { projectPtyContext, type PtyResolvedContext } from './pty-context.js'

export {
  PTY_DEFAULT_IDLE_TTL_S,
  PTY_DEFAULT_LEASE_TTL_S,
  PTY_DEFAULT_RETENTION_BYTES,
} from '@dsh-scholar/research-schemas'

/** Error raised by the PTY session store. `code` is the stable wire code. */
export class PtyError extends Error {
  readonly code: string
  constructor(code: string, message: string) {
    super(message)
    this.name = 'PtyError'
    this.code = code
  }
}

/**
 * The adapter contract a Local/Remote PTY implementation must satisfy.
 * The interface layer ships `NullPtyAdapter` (records delivery attempts,
 * delivers nothing); `spawn` returning `{ok:false}` closes the session with
 * close_reason='adapter_failed'. Adapters never leak Docker sockets, SSH
 * credentials, Kernel tokens or host paths to the wire.
 */
export interface PtyAdapter {
  readonly id: string // 'null' | 'local-docker' | 'remote-runner'
  spawn(plan: PtySpawnPlan): { ok: true } | { ok: false; error: string }
  write(sessionId: string, bytes: string): void
  resize(sessionId: string, cols: number, rows: number): void
  signal(sessionId: string, signal: PtySignal): void
  kill(sessionId: string): void
}

/** Everything an adapter needs to allocate the real tty — pinned at open. */
export interface PtySpawnPlan {
  pty_session_id: string
  project_id: string
  workspace_id: string
  preset: PtySession['preset']
  cwd: string // relative, validated root-relative
  cols: number
  rows: number
  profile: string
  target: string
  config_hash: string
  lease_token: string
}

/**
 * The shipped no-op adapter (interface layer): it accepts spawn plans and
 * records delivery attempts without allocating a real pseudo-terminal. A
 * LocalDockerPty / RemoteRunnerPty adapter replaces it via
 * `kernel.setPtyAdapter(...)`; until then `adapter_id='null'` and HTTP open
 * answers 501 (see server.ts). Control frames are still applied to the
 * state machine and audited — only byte delivery is absent.
 */
export class NullPtyAdapter implements PtyAdapter {
  readonly id = 'null'
  /** Delivery attempt log (test/audit surface). */
  readonly deliveries: Array<{ sessionId: string; kind: 'bytes' | 'resize' | 'signal' | 'kill'; detail: string }> = []
  spawn(): { ok: true } | { ok: false; error: string } {
    return { ok: true }
  }
  write(sessionId: string, bytes: string): void {
    this.deliveries.push({ sessionId, kind: 'bytes', detail: bytes })
  }
  resize(sessionId: string, cols: number, rows: number): void {
    this.deliveries.push({ sessionId, kind: 'resize', detail: `${cols}x${rows}` })
  }
  signal(sessionId: string, signal: PtySignal): void {
    this.deliveries.push({ sessionId, kind: 'signal', detail: signal })
  }
  kill(sessionId: string): void {
    this.deliveries.push({ sessionId, kind: 'kill', detail: '' })
  }
}

/** Result of applying one control frame. */
export interface PtyControlResult {
  frame: PtyControlFrame
  /** true when this exact client_seq was already applied (idempotent replay). */
  idempotent: boolean
  /** false when no adapter is attached (frame recorded, nothing delivered). */
  delivered: boolean
}

/** Result of appending output frames (bounded retention accounting). */
export interface PtyAppendResult {
  frames: PtyOutputFrame[]
  dropped_bytes: number
  evicted_up_to_seq: number | null
}

const nowIso = (): string => new Date().toISOString()
const nowMs = (): number => Date.now()

/** Current context-bound PTY session shape. There are no legacy defaults for
 * authority-bearing context, parent, or label fields. */
export const PTY_CONTEXT_SESSIONS_TABLE_DDL = `
CREATE TABLE IF NOT EXISTS pty_sessions (
  pty_session_id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  principal_id TEXT NOT NULL,
  tenant_id TEXT NOT NULL DEFAULT '',
  context_kind TEXT NOT NULL,
  context_id TEXT NOT NULL,
  parent_session_id TEXT,
  label TEXT NOT NULL,
  purpose TEXT NOT NULL DEFAULT '',
  profile TEXT NOT NULL,
  target TEXT NOT NULL,
  preset TEXT NOT NULL,
  cwd TEXT NOT NULL,
  config_hash TEXT NOT NULL,
  state TEXT NOT NULL,
  generation INTEGER NOT NULL,
  -- STORE-06: sha256 of the opaque lease token; the plaintext token is never
  -- persisted (legacy rows carry their old plaintext in lease_token below).
  lease_token TEXT,
  lease_token_hash TEXT NOT NULL DEFAULT '',
  lease_expires_at TEXT,
  idle_ttl_s INTEGER NOT NULL,
  retention_bytes INTEGER NOT NULL,
  retained_from_seq INTEGER NOT NULL DEFAULT 0,
  last_client_seq INTEGER NOT NULL DEFAULT 0,
  last_event_seq INTEGER NOT NULL DEFAULT 0,
  total_bytes INTEGER NOT NULL DEFAULT 0,
  dropped_bytes INTEGER NOT NULL DEFAULT 0,
  adapter_id TEXT NOT NULL DEFAULT 'none',
  open_at TEXT NOT NULL,
  last_activity_at TEXT NOT NULL,
  closed_at TEXT,
  close_reason TEXT,
  CHECK (state IN ('open','attached','detached','closed')),
  CHECK (preset IN ('sh','bash','zsh','fish')),
  CHECK (context_kind IN ('research','chat','subagent'))
);
`

/** Current context-bound PTY shape. Lease credentials are hash-only. */
export const PTY_CURRENT_CONTEXT_SESSIONS_TABLE_DDL = `
CREATE TABLE IF NOT EXISTS pty_sessions (
  pty_session_id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  principal_id TEXT NOT NULL,
  tenant_id TEXT NOT NULL DEFAULT '',
  context_kind TEXT NOT NULL,
  context_id TEXT NOT NULL,
  parent_session_id TEXT,
  label TEXT NOT NULL,
  purpose TEXT NOT NULL DEFAULT '',
  profile TEXT NOT NULL,
  target TEXT NOT NULL,
  preset TEXT NOT NULL,
  cwd TEXT NOT NULL,
  config_hash TEXT NOT NULL,
  state TEXT NOT NULL,
  generation INTEGER NOT NULL,
  lease_token_hash TEXT NOT NULL DEFAULT '',
  lease_expires_at TEXT,
  idle_ttl_s INTEGER NOT NULL,
  retention_bytes INTEGER NOT NULL,
  retained_from_seq INTEGER NOT NULL DEFAULT 0,
  last_client_seq INTEGER NOT NULL DEFAULT 0,
  last_event_seq INTEGER NOT NULL DEFAULT 0,
  total_bytes INTEGER NOT NULL DEFAULT 0,
  dropped_bytes INTEGER NOT NULL DEFAULT 0,
  adapter_id TEXT NOT NULL DEFAULT 'none',
  open_at TEXT NOT NULL,
  last_activity_at TEXT NOT NULL,
  closed_at TEXT,
  close_reason TEXT,
  CHECK (state IN ('open','attached','detached','closed')),
  CHECK (preset IN ('sh','bash','zsh','fish')),
  CHECK (context_kind IN ('research','chat','subagent'))
);
`

/**
 * Frozen post-0014/pre-context PTY shape. Released migration 0014 references
 * this constant by name. Keeping it context-less lets a database that still
 * has to run 0014 finish token hashing without inventing authority; migration
 * 0036 immediately discards those transient rows and creates the current
 * context-bound table above.
 */
export const PTY_SESSIONS_TABLE_DDL = `
CREATE TABLE IF NOT EXISTS pty_sessions (
  pty_session_id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  principal_id TEXT NOT NULL,
  tenant_id TEXT NOT NULL DEFAULT '',
  profile TEXT NOT NULL,
  target TEXT NOT NULL,
  preset TEXT NOT NULL,
  cwd TEXT NOT NULL,
  config_hash TEXT NOT NULL,
  state TEXT NOT NULL,
  generation INTEGER NOT NULL,
  lease_token TEXT,
  lease_token_hash TEXT NOT NULL DEFAULT '',
  lease_expires_at TEXT,
  idle_ttl_s INTEGER NOT NULL,
  retention_bytes INTEGER NOT NULL,
  retained_from_seq INTEGER NOT NULL DEFAULT 0,
  last_client_seq INTEGER NOT NULL DEFAULT 0,
  last_event_seq INTEGER NOT NULL DEFAULT 0,
  total_bytes INTEGER NOT NULL DEFAULT 0,
  dropped_bytes INTEGER NOT NULL DEFAULT 0,
  adapter_id TEXT NOT NULL DEFAULT 'none',
  open_at TEXT NOT NULL,
  last_activity_at TEXT NOT NULL,
  closed_at TEXT,
  close_reason TEXT,
  CHECK (state IN ('open','attached','detached','closed')),
  CHECK (preset IN ('sh','bash','zsh','fish'))
);
`

/** Exact DDL embedded by released migration 0036. Do not edit. */
export const PTY_DDL = `
${PTY_CONTEXT_SESSIONS_TABLE_DDL}
CREATE INDEX IF NOT EXISTS idx_pty_sessions_project ON pty_sessions(project_id);
CREATE INDEX IF NOT EXISTS idx_pty_sessions_context ON pty_sessions(project_id, context_kind, context_id, open_at);
-- Append-only frame ledger: control frames (client_seq) + output frames
-- (server_seq). client_seq is UNIQUE per session — the idempotency key.
CREATE TABLE IF NOT EXISTS pty_frames (
  pty_session_id TEXT NOT NULL,
  server_seq INTEGER NOT NULL,
  frame_kind TEXT NOT NULL CHECK (frame_kind IN ('control','output','exit','gap')),
  client_seq INTEGER,
  type TEXT NOT NULL,
  payload_json TEXT NOT NULL DEFAULT '{}',
  byte_length INTEGER,
  created_at TEXT NOT NULL,
  PRIMARY KEY (pty_session_id, server_seq)
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_pty_frames_client_seq ON pty_frames(pty_session_id, client_seq) WHERE client_seq IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_pty_frames_session_seq ON pty_frames(pty_session_id, server_seq);
`

/** Current store and migration DDL. */
export const PTY_CURRENT_DDL = `
${PTY_CURRENT_CONTEXT_SESSIONS_TABLE_DDL}
CREATE INDEX IF NOT EXISTS idx_pty_sessions_project ON pty_sessions(project_id);
CREATE INDEX IF NOT EXISTS idx_pty_sessions_context ON pty_sessions(project_id, context_kind, context_id, open_at);
-- Append-only frame ledger: control frames (client_seq) + output frames
-- (server_seq). client_seq is UNIQUE per session — the idempotency key.
CREATE TABLE IF NOT EXISTS pty_frames (
  pty_session_id TEXT NOT NULL,
  server_seq INTEGER NOT NULL,
  frame_kind TEXT NOT NULL CHECK (frame_kind IN ('control','output','exit','gap')),
  client_seq INTEGER,
  type TEXT NOT NULL,
  payload_json TEXT NOT NULL DEFAULT '{}',
  byte_length INTEGER,
  created_at TEXT NOT NULL,
  PRIMARY KEY (pty_session_id, server_seq)
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_pty_frames_client_seq ON pty_frames(pty_session_id, client_seq) WHERE client_seq IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_pty_frames_session_seq ON pty_frames(pty_session_id, server_seq);
`

export interface PtySessionRow {
  pty_session_id: string
  project_id: string
  workspace_id: string
  principal_id: string
  tenant_id: string
  context_kind: PtySession['context_kind']
  context_id: string
  parent_session_id: string | null
  label: string
  purpose: string
  profile: string
  target: string
  preset: string
  cwd: string
  config_hash: string
  state: string
  generation: number
  /** sha256 of the opaque lease token (STORE-06); '' when unknown. */
  lease_token_hash: string
  lease_expires_at: string | null
  idle_ttl_s: number
  retention_bytes: number
  retained_from_seq: number
  last_client_seq: number
  last_event_seq: number
  total_bytes: number
  dropped_bytes: number
  adapter_id: string
  open_at: string
  last_activity_at: string
  closed_at: string | null
  close_reason: string | null
}

/** Open the PTY session store on the kernel database path (own WAL
 * connection, same pattern as openTexWorkspace). */
export function openPtySessionStore(dbPath: string): PtySessionStore {
  return new PtySessionStore(dbPath)
}

export class PtySessionStore {
  private readonly db: DatabaseSync

  constructor(dbPath: string) {
    if (dbPath !== ':memory:') mkdirSync(dirname(dbPath), { recursive: true })
    this.db = new DatabaseSync(dbPath)
    this.db.exec('PRAGMA journal_mode = WAL')
    this.db.exec(PTY_CURRENT_DDL)
  }

  close(): void {
    this.db.close()
  }

  /** Map a raw row to the public session shape. */
  private sessionFromRow(row: PtySessionRow): PtySession {
    return {
      pty_session_id: row.pty_session_id,
      principal_id: row.principal_id,
      tenant_id: row.tenant_id,
      project_id: row.project_id,
      workspace_id: row.workspace_id,
      context_kind: row.context_kind,
      context_id: row.context_id,
      parent_session_id: row.parent_session_id,
      label: row.label,
      purpose: row.purpose,
      profile: row.profile,
      target: row.target,
      preset: row.preset as PtySession['preset'],
      cwd: row.cwd,
      config_hash: row.config_hash,
      state: row.state as PtySession['state'],
      generation: row.generation,
      // The plaintext lease exists only in createContextSession's immediate
      // return value. Durable reads are hash-only.
      lease_token: null,
      lease_expires_at: row.lease_expires_at,
      idle_ttl_s: row.idle_ttl_s,
      retention_bytes: row.retention_bytes,
      retained_from_seq: row.retained_from_seq,
      last_client_seq: row.last_client_seq,
      last_event_seq: row.last_event_seq,
      total_bytes: row.total_bytes,
      dropped_bytes: row.dropped_bytes,
      adapter_id: row.adapter_id,
      open_at: row.open_at,
      last_activity_at: row.last_activity_at,
      closed_at: row.closed_at,
      close_reason: row.close_reason as PtySession['close_reason'],
    }
  }

  private getRow(sessionId: string): PtySessionRow {
    const row = this.db.prepare('SELECT * FROM pty_sessions WHERE pty_session_id = ?').get(sessionId) as PtySessionRow | undefined
    if (row === undefined) throw new PtyError('pty_session_not_found', `pty session ${sessionId} not found`)
    return row
  }

  getSession(sessionId: string): PtySession {
    return this.sessionFromRow(this.getRow(sessionId))
  }

  /** Minimal owner-checked discovery used only to locate current context
   * authority. It does not authorize read/control by itself. */
  contextForOwner(sessionId: string, principal: { principal_id: string }): {
    project_id: string
    context_kind: PtySession['context_kind']
    context_id: string
    parent_session_id: string | null
  } {
    const session = this.getSession(sessionId)
    if (session.principal_id !== principal.principal_id) {
      throw new PtyError('pty_principal_mismatch', 'PTY session is owned by another principal')
    }
    return {
      project_id: session.project_id,
      context_kind: session.context_kind,
      context_id: session.context_id,
      parent_session_id: session.parent_session_id,
    }
  }

  /** Internal lifecycle-only enumeration. UI/API discovery is exclusively
   * listContextSessions(); this cannot express the removed project singleton
   * projection and is used only to tear down child processes at shutdown. */
  listAllSessionsForShutdown(): PtySession[] {
    const rows = this.db.prepare('SELECT * FROM pty_sessions ORDER BY open_at DESC').all() as unknown as PtySessionRow[]
    return rows.map(r => this.sessionFromRow(r))
  }

  /** List the exact context's terminal tabs. Authority is server-derived;
   * callers cannot widen the query with a project id. */
  listContextSessions(context: PtyResolvedContext): PtyContextSessions {
    const rows = this.db.prepare(`SELECT * FROM pty_sessions
      WHERE project_id = ? AND context_kind = ? AND context_id = ?
      ORDER BY open_at DESC, rowid DESC`)
      .all(context.project_id, context.context_kind, context.context_id) as unknown as PtySessionRow[]
    const sessions = rows.map(row => this.sessionFromRow(row))
    for (const session of sessions) this.assertContextAccess(session.pty_session_id, context, session.generation, { allowExpired: true })
    return {
      context: projectPtyContext(context),
      sessions,
      active_hint: sessions.find(session => session.state !== 'closed')?.pty_session_id ?? null,
    }
  }

  /** Current PTY open path. Project, owner, exact parent, profile and target
   * all come from trusted context resolution; the wire request contributes
   * only context id plus non-authoritative terminal presentation/options. */
  createContextSession(request: PtyOpenRequest, context: PtyResolvedContext, opts: {
    config_hash: string
    idle_ttl_s?: number
    retention_bytes?: number
    lease_ttl_s?: number
    adapter_id?: string
  }): PtySession {
    if (request.context_id !== context.context_id) {
      throw new PtyError('pty_context_mismatch', 'PTY open context does not match the resolved authority')
    }
    const at = nowIso()
    const leaseToken = `lease_${randomBytes(16).toString('hex')}`
    const session: PtySession = {
      pty_session_id: randomId('pty'),
      principal_id: context.principal_id,
      tenant_id: context.tenant_id,
      project_id: context.project_id,
      workspace_id: request.workspace_id,
      context_kind: context.context_kind,
      context_id: context.context_id,
      parent_session_id: context.parent_session_id,
      label: request.label,
      purpose: request.purpose,
      profile: context.profile,
      target: context.target,
      preset: request.preset,
      cwd: request.cwd,
      config_hash: opts.config_hash,
      state: 'open',
      generation: 1,
      lease_token: leaseToken,
      lease_expires_at: new Date(nowMs() + (opts.lease_ttl_s ?? PTY_DEFAULT_LEASE_TTL_S) * 1000).toISOString(),
      idle_ttl_s: opts.idle_ttl_s ?? PTY_DEFAULT_IDLE_TTL_S,
      retention_bytes: opts.retention_bytes ?? PTY_DEFAULT_RETENTION_BYTES,
      retained_from_seq: 0,
      last_client_seq: 0,
      last_event_seq: 0,
      total_bytes: 0,
      dropped_bytes: 0,
      adapter_id: opts.adapter_id ?? 'none',
      open_at: at,
      last_activity_at: at,
      closed_at: null,
      close_reason: null,
    }
    this.db.prepare(`INSERT INTO pty_sessions (
      pty_session_id, project_id, workspace_id, principal_id, tenant_id,
      context_kind, context_id, parent_session_id, label, purpose,
      profile, target, preset, cwd, config_hash, state, generation,
      lease_token_hash, lease_expires_at, idle_ttl_s, retention_bytes, retained_from_seq,
      last_client_seq, last_event_seq, total_bytes, dropped_bytes, adapter_id, open_at, last_activity_at, closed_at, close_reason)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(session.pty_session_id, session.project_id, session.workspace_id, session.principal_id, session.tenant_id,
        session.context_kind, session.context_id, session.parent_session_id, session.label, session.purpose,
        session.profile, session.target, session.preset, session.cwd, session.config_hash, session.state, session.generation,
        createHash('sha256').update(leaseToken).digest('hex'), session.lease_expires_at,
        session.idle_ttl_s, session.retention_bytes, session.retained_from_seq, session.last_client_seq,
        session.last_event_seq, session.total_bytes, session.dropped_bytes, session.adapter_id, session.open_at,
        session.last_activity_at, session.closed_at, session.close_reason)
    return session
  }

  /** Fail-closed owner/context/exact-parent/generation/lease-expiry fence.
   * This consumes only server-derived authority. */
  assertContextAccess(sessionId: string, context: PtyResolvedContext, expectedGeneration: number, opts: { allowExpired?: boolean } = {}): PtySession {
    const session = this.getSession(sessionId)
    if (session.principal_id !== context.principal_id || session.tenant_id !== context.tenant_id) {
      throw new PtyError('pty_principal_mismatch', 'PTY session is owned by another principal')
    }
    if (session.project_id !== context.project_id
      || session.context_kind !== context.context_kind
      || session.context_id !== context.context_id) {
      throw new PtyError('pty_context_mismatch', 'PTY session belongs to another context')
    }
    if (session.parent_session_id !== context.parent_session_id) {
      throw new PtyError('pty_exact_parent_mismatch', 'PTY context is no longer attached to the exact parent session')
    }
    if (session.generation !== expectedGeneration) {
      throw new PtyError('pty_generation_stale', `expected PTY generation ${session.generation}, got ${expectedGeneration}`)
    }
    if (opts.allowExpired !== true && session.lease_expires_at !== null
      && new Date(session.lease_expires_at).getTime() <= nowMs()) {
      throw new PtyError('pty_lease_expired', 'PTY lease has expired')
    }
    return session
  }

  attachContext(sessionId: string, context: PtyResolvedContext, expectedGeneration: number): PtySession {
    this.assertContextAccess(sessionId, context, expectedGeneration)
    return this.attach(sessionId)
  }

  detachContext(sessionId: string, context: PtyResolvedContext, expectedGeneration: number): PtySession {
    this.assertContextAccess(sessionId, context, expectedGeneration)
    return this.detach(sessionId)
  }

  revokeContext(sessionId: string, context: PtyResolvedContext, expectedGeneration: number): PtySession {
    this.assertContextAccess(sessionId, context, expectedGeneration)
    return this.revoke(sessionId)
  }

  closeContext(sessionId: string, context: PtyResolvedContext, expectedGeneration: number): PtySession {
    this.assertContextAccess(sessionId, context, expectedGeneration)
    return this.closeSession(sessionId)
  }

  applyContextControl(sessionId: string, request: PtyControlRequest, context: PtyResolvedContext, adapter: PtyAdapter | null): PtyControlResult {
    this.assertContextAccess(sessionId, context, request.expected_generation)
    return this.applyControl(sessionId, request, adapter)
  }

  framesContext(sessionId: string, afterSeq: number, context: PtyResolvedContext, expectedGeneration: number): ReturnType<PtySessionStore['frames']> {
    this.assertContextAccess(sessionId, context, expectedGeneration)
    return this.frames(sessionId, afterSeq)
  }

  /**
   * Pure state machine transition. `expected` lists the states this
   * transition may leave; anything else is a 409 (the session is already
   * somewhere else — reload, like the project revision CAS). Every
   * attach/detach bumps `generation` so reconnects can fence with
   * generation + after_seq (acceptance pty-reconnect-seq).
   */
  private transition(sessionId: string, expected: PtySession['state'][], next: PtySession['state'], opts: {
    bumpGeneration?: boolean
    reason?: PtySession['close_reason']
    activity?: boolean
  } = {}): PtySession {
    const row = this.getRow(sessionId)
    if (!expected.includes(row.state as PtySession['state'])) {
      throw new PtyError('pty_state_conflict',
        `pty session ${sessionId} is ${row.state}; expected ${expected.join('/')} for transition to ${next}`)
    }
    const generation = row.generation + (opts.bumpGeneration === true ? 1 : 0)
    const closedAt = next === 'closed' ? (row.closed_at ?? nowIso()) : row.closed_at
    const closeReason = next === 'closed' ? (opts.reason ?? row.close_reason ?? 'explicit') : row.close_reason
    this.db.prepare(`UPDATE pty_sessions SET state = ?, generation = ?, last_activity_at = ?, closed_at = ?, close_reason = ? WHERE pty_session_id = ?`)
      .run(next, generation, opts.activity === true ? nowIso() : row.last_activity_at, closedAt, closeReason, sessionId)
    return this.getSession(sessionId)
  }

  /** open|detached → attached (wire up). Generation bumps for reconnect. */
  attach(sessionId: string): PtySession {
    return this.transition(sessionId, ['open', 'detached'], 'attached', { bumpGeneration: true, activity: true })
  }

  /** attached → detached (wire down; the process keeps running — a PTY
   * disconnect never kills the process, execution-runtime.md §6.1). */
  detach(sessionId: string, reason?: PtySession['close_reason']): PtySession {
    return this.transition(sessionId, ['attached'], 'detached', { bumpGeneration: true, activity: true, reason })
  }

  /** Permission revocation: detach immediately (or no-op when already
   * detached/open); the session itself stays until close/TTL. */
  revoke(sessionId: string): PtySession {
    const row = this.getRow(sessionId)
    if (row.state === 'attached') {
      return this.transition(sessionId, ['attached'], 'detached', { bumpGeneration: true, activity: true, reason: 'permission_revoked' })
    }
    return this.sessionFromRow(row)
  }

  /** Explicit close from ANY non-terminal state (idempotent). */
  closeSession(sessionId: string, reason: PtySession['close_reason'] = 'explicit'): PtySession {
    const row = this.getRow(sessionId)
    if (row.state === 'closed') return this.sessionFromRow(row) // idempotent close
    return this.transition(sessionId, ['open', 'attached', 'detached'], 'closed', { reason })
  }

  /** Lease expired → close (idempotent on already-closed rows). */
  expireLease(sessionId: string): PtySession {
    return this.closeSession(sessionId, 'lease_expired')
  }

  /**
   * Idle TTL sweep (kernel calls this on a timer / at open): every
   * non-closed session whose last_activity_at + idle_ttl_s is in the past
   * is closed with close_reason='idle_ttl'. Returns the closed ids.
   */
  sweepIdle(now: number = nowMs()): string[] {
    const rows = this.db.prepare("SELECT pty_session_id, last_activity_at, idle_ttl_s FROM pty_sessions WHERE state != 'closed'").all() as unknown as Array<{
      pty_session_id: string; last_activity_at: string; idle_ttl_s: number
    }>
    const closed: string[] = []
    for (const row of rows) {
      const deadline = new Date(row.last_activity_at).getTime() + row.idle_ttl_s * 1000
      if (deadline < now) {
        this.transition(row.pty_session_id, ['open', 'attached', 'detached'], 'closed', { reason: 'idle_ttl' })
        closed.push(row.pty_session_id)
      }
    }
    return closed
  }

  /**
   * Apply one control frame — the client_seq idempotency rule:
   *
   *   seq == last_client_seq + 1  → apply (record + deliver to the adapter)
   *   seq == last_client_seq      → idempotent replay (already applied)
   *   anything else               → 409 pty_client_seq_out_of_order
   *
   * `close` control additionally runs the session close transition. Every
   * applied frame is audited in pty_frames (frame_kind='control').
   */
  applyControl(sessionId: string, request: PtyControlRequest, adapter: PtyAdapter | null): PtyControlResult {
    const row = this.getRow(sessionId)
    if (row.state === 'closed') {
      throw new PtyError('pty_session_closed', `pty session ${sessionId} is closed`)
    }
    if (request.client_seq === row.last_client_seq) {
      // Idempotent replay of the last applied frame — no-op, no side effects.
      const prev = this.db.prepare("SELECT * FROM pty_frames WHERE pty_session_id = ? AND client_seq = ?")
        .get(sessionId, request.client_seq) as Record<string, unknown> | undefined
      return {
        frame: prev === undefined
          ? this.buildControlFrame(sessionId, request, row.last_event_seq, true)
          : JSON.parse(prev.payload_json as string) as PtyControlFrame,
        idempotent: true,
        delivered: false,
      }
    }
    if (request.client_seq !== row.last_client_seq + 1) {
      throw new PtyError('pty_client_seq_out_of_order',
        `pty session ${sessionId}: expected client_seq ${row.last_client_seq + 1}, got ${request.client_seq}`)
    }
    const serverSeq = row.last_event_seq + 1
    const frame = this.buildControlFrame(sessionId, request, serverSeq, false)
    let delivered = false
    if (request.type === 'close') {
      // Explicit close control: record the frame, then run the close
      // transition (still auditable, idempotent on repeat closes).
      this.insertFrame(sessionId, serverSeq, 'control', request.client_seq, request.type, JSON.stringify(frame), null)
      this.transition(sessionId, ['open', 'attached', 'detached'], 'closed', { reason: 'explicit', activity: true })
      return { frame, idempotent: false, delivered: false }
    }
    if (adapter !== null) {
      try {
        if (request.type === 'bytes') adapter.write(sessionId, request.payload.text)
        else if (request.type === 'resize') adapter.resize(sessionId, request.payload.cols, request.payload.rows)
        else if (request.type === 'signal') adapter.signal(sessionId, request.payload.signal)
        delivered = true
      } catch {
        // Delivery failures never lose the audit frame; the adapter surfaces
        // its own error channel. The session stays alive (process is fine).
        delivered = false
      }
    }
    this.insertFrame(sessionId, serverSeq, 'control', request.client_seq, request.type, JSON.stringify(frame), null)
    this.db.prepare('UPDATE pty_sessions SET last_client_seq = ?, last_event_seq = ?, last_activity_at = ? WHERE pty_session_id = ?')
      .run(request.client_seq, serverSeq, nowIso(), sessionId)
    return { frame, idempotent: false, delivered }
  }

  private buildControlFrame(sessionId: string, request: PtyControlRequest, serverSeq: number, replay: boolean): PtyControlFrame {
    const base = {
      pty_session_id: sessionId,
      client_seq: request.client_seq,
      created_at: nowIso(),
    }
    switch (request.type) {
      case 'bytes':
        return { ...base, type: 'bytes', payload: { text: request.payload.text, byte_length: request.payload.byte_length } }
      case 'resize':
        return { ...base, type: 'resize', payload: { cols: request.payload.cols, rows: request.payload.rows } }
      case 'signal':
        return { ...base, type: 'signal', payload: { signal: request.payload.signal } }
      case 'close':
        return { ...base, type: 'close', payload: {} }
    }
  }

  /**
   * Append output frames (the adapter's onChunk/exit path). server_seq is
   * allocated max+1 per session (monotonic, gap-free). Retention is bounded:
   * once total_bytes exceeds retention_bytes, the OLDEST output frames are
   * evicted, retained_from_seq advances and dropped_bytes accumulates — a
   * reader that missed the eviction receives a `gap` frame (not silence).
   * Frames are recorded with a byte_length so retention accounting is exact.
   */
  appendOutput(sessionId: string, frames: Array<{ type: 'output' | 'exit'; text?: string; byte_length?: number; channel?: 'stdout' | 'stderr'; exit_code?: number | null; signal?: string | null }>): PtyAppendResult {
    const row = this.getRow(sessionId)
    if (row.state === 'closed') {
      throw new PtyError('pty_session_closed', `pty session ${sessionId} is closed — no further output`)
    }
    const out: PtyOutputFrame[] = []
    let serverSeq = row.last_event_seq
    const at = nowIso()
    for (const f of frames) {
      serverSeq += 1
      const frame: PtyOutputFrame = f.type === 'exit'
        ? { pty_session_id: sessionId, server_seq: serverSeq, type: 'exit', payload: { exit_code: f.exit_code ?? null, signal: f.signal ?? null }, created_at: at }
        : { pty_session_id: sessionId, server_seq: serverSeq, type: 'output', payload: { text: f.text ?? '', byte_length: f.byte_length ?? Buffer.byteLength(f.text ?? '', 'utf8'), channel: f.channel ?? 'stdout' }, created_at: at }
      const kind = f.type === 'exit' ? 'exit' : 'output'
      this.insertFrame(sessionId, serverSeq, kind, null, frame.type, JSON.stringify(frame), frame.type === 'output' ? frame.payload.byte_length : null)
      out.push(frame)
    }
    const addedBytes = out.filter(f => f.type === 'output').reduce((sum, f) => sum + f.payload.byte_length, 0)
    const total = row.total_bytes + addedBytes
    // Retention eviction: drop the oldest output frames until within budget.
    let evictedUpTo: number | null = null
    let dropped = 0
    if (total > row.retention_bytes) {
      const evict = total - row.retention_bytes
      const candidates = this.db.prepare(
        "SELECT server_seq, COALESCE(byte_length, 0) AS byte_length FROM pty_frames WHERE pty_session_id = ? AND frame_kind = 'output' AND server_seq >= ? ORDER BY server_seq").all(
        sessionId, row.retained_from_seq) as unknown as Array<{ server_seq: number; byte_length: number }>
      let freed = 0
      for (const c of candidates) {
        if (freed >= evict) break
        freed += c.byte_length
        evictedUpTo = c.server_seq
        dropped += c.byte_length
      }
      if (evictedUpTo !== null) {
        this.db.prepare('DELETE FROM pty_frames WHERE pty_session_id = ? AND server_seq <= ?').run(sessionId, evictedUpTo)
        this.db.prepare('UPDATE pty_sessions SET retained_from_seq = ?, total_bytes = ?, dropped_bytes = ?, last_event_seq = ?, last_activity_at = ? WHERE pty_session_id = ?')
          .run(evictedUpTo + 1, Math.max(0, total - freed), row.dropped_bytes + dropped, serverSeq, at, sessionId)
      } else {
        this.db.prepare('UPDATE pty_sessions SET total_bytes = ?, last_event_seq = ?, last_activity_at = ? WHERE pty_session_id = ?')
          .run(total, serverSeq, at, sessionId)
      }
    } else {
      this.db.prepare('UPDATE pty_sessions SET total_bytes = ?, last_event_seq = ?, last_activity_at = ? WHERE pty_session_id = ?')
        .run(total, serverSeq, at, sessionId)
    }
    return { frames: out, dropped_bytes: dropped, evicted_up_to_seq: evictedUpTo }
  }

  /**
   * PTY-01 (hardening §5 P0-2): constant-time lease verification for
   * read/control/frames. Sessions persist ONLY the sha256 of the opaque token
   * (STORE-06 lease_token_hash). There is deliberately no plaintext
   * compatibility path. A missing hash fails closed. The token is
   * compared via sha256+timingSafeEqual so the comparison never leaks timing
   * information about the stored value.
   */
  verifyLease(sessionId: string, token: string): boolean {
    const row = this.getRow(sessionId)
    if (row.lease_expires_at !== null && new Date(row.lease_expires_at).getTime() <= nowMs()) return false
    if (!/^[0-9a-f]{64}$/.test(row.lease_token_hash)) return false
    const expected = Buffer.from(row.lease_token_hash, 'hex')
    const provided = createHash('sha256').update(token).digest()
    return timingSafeEqual(expected, provided)
  }

  /** Touch activity (e.g. an attach heartbeats the idle TTL). */
  touch(sessionId: string): PtySession {
    this.db.prepare('UPDATE pty_sessions SET last_activity_at = ? WHERE pty_session_id = ?').run(nowIso(), sessionId)
    return this.getSession(sessionId)
  }

  private insertFrame(sessionId: string, serverSeq: number, kind: string, clientSeq: number | null, type: string, payloadJson: string, byteLength: number | null): void {
    this.db.prepare('INSERT INTO pty_frames (pty_session_id, server_seq, frame_kind, client_seq, type, payload_json, byte_length, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(sessionId, serverSeq, kind, clientSeq, type, payloadJson, byteLength, nowIso())
  }

  /**
   * Read output frames after a client cursor. When `afterSeq` fell below
   * retained_from_seq (evicted), the page reports gap=true with a synthetic
   * gap frame describing exactly what was dropped — the client must resync
   * (acceptance pty-reconnect-seq / retention-gap).
   */
  frames(sessionId: string, afterSeq: number): { pty_session_id: string; after_seq: number; retained_from_seq: number; dropped_bytes: number; total_bytes: number; gap: boolean; frames: PtyOutputFrame[] } {
    const row = this.getRow(sessionId)
    const gap = afterSeq < row.retained_from_seq
    const rows = this.db.prepare('SELECT * FROM pty_frames WHERE pty_session_id = ? AND server_seq > ? AND frame_kind != \'control\' ORDER BY server_seq').all(sessionId, afterSeq) as unknown as Array<Record<string, unknown>>
    const frames: PtyOutputFrame[] = []
    for (const r of rows) {
      const parsed = JSON.parse(r.payload_json as string) as PtyOutputFrame
      frames.push(parsed)
    }
    if (gap) {
      frames.unshift({
        pty_session_id: sessionId,
        server_seq: row.retained_from_seq,
        type: 'gap',
        payload: {
          gap_from_seq: afterSeq + 1,
          gap_to_seq: row.retained_from_seq - 1,
          dropped_bytes: row.dropped_bytes,
          dropped_frames: Math.max(0, row.retained_from_seq - 1 - afterSeq),
        },
        created_at: nowIso(),
      })
    }
    return {
      pty_session_id: sessionId,
      after_seq: afterSeq,
      retained_from_seq: row.retained_from_seq,
      dropped_bytes: row.dropped_bytes,
      total_bytes: row.total_bytes,
      gap,
      frames,
    }
  }

  /** Count of frames (audit/测试 helper). */
  frameCount(sessionId: string): number {
    return (this.db.prepare('SELECT COUNT(*) AS n FROM pty_frames WHERE pty_session_id = ?').get(sessionId) as { n: number }).n
  }
}
