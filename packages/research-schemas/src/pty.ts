/**
 * PTY-01 (hardening-v0.2-status.md §3/§4, execution-runtime.md §6.1) —
 * Interactive Terminal wire schemas.
 *
 * The Interactive Terminal is a separate Interface from the Run Terminal
 * (execution-runtime.md §6 vs §6.1). A PTY session is pinned at open time:
 * Principal, Project, Workspace, Runner profile/target, an allowlisted shell
 * preset, a RELATIVE cwd, the effective config hash and a session lease.
 * The wire never carries Docker sockets, SSH credentials, Kernel tokens or
 * host paths (execution-runtime.md §6.1).
 *
 * Two frame streams, one session:
 *
 * - PtyControlFrame — client → server, one per user action (bytes input,
 *   resize, INT/TERM/KILL signal, close). Each control frame carries a
 *   monotonically increasing `client_seq`; the server treats
 *   `client_seq` as the idempotency key (duplicate seq = replay, out-of-order
 *   seq = 409), exactly like the Job Idempotency-Key rule.
 * - PtyOutputFrame — server → client, append-only with a monotonic
 *   `server_seq` (output | exit | gap). Retention is bounded and explicit:
 *   the session row records `retained_from_seq` / `dropped_bytes`, and a
 *   reader requesting an evicted seq first receives a `gap` frame —
 *   mirroring terminal-frames retention semantics (execution-runtime.md §6).
 *
 * NOT a formal log: PTY output is auditable and retained in a bounded
 * window, but it can never generate Metrics, a RunManifest, accepted
 * Evidence or a Gate Decision (execution-runtime.md §6.1; enforced by the
 * kernel store layout + pty-session.test.ts `pty-not-evidence`).
 * @module @dsh-scholar/research-schemas/pty
 */

import { z } from 'zod'

/** Canonical defaults and writable bounds for server-owned PTY policy. */
export const PTY_DEFAULT_IDLE_TTL_S = 900
export const PTY_MIN_IDLE_TTL_S = 1
export const PTY_MAX_IDLE_TTL_S = 86_400
export const PTY_DEFAULT_RETENTION_BYTES = 1024 * 1024
export const PTY_MIN_RETENTION_BYTES = 4 * 1024
export const PTY_MAX_RETENTION_BYTES = 64 * 1024 * 1024
export const PTY_DEFAULT_LEASE_TTL_S = 3600
export const PTY_MIN_LEASE_TTL_S = 1
export const PTY_MAX_LEASE_TTL_S = 86_400

/** Authoritative session context. These values are resolved by the server
 * from its own Research/DSH session and topology stores; the browser only
 * carries the opaque context_id selected from a server projection. */
export const PtyContextKind = z.enum(['research', 'chat', 'subagent'])
export type PtyContextKind = z.infer<typeof PtyContextKind>

const PtyContextId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:@-]{0,255}$/)

/** Session lifecycle: open (created, no wire yet) → attached (wire up) →
 * detached (wire down, process alive) → closed (terminal). Permission
 * revocation detaches immediately; idle TTL expiry closes. */
export const PtyState = z.enum(['open', 'attached', 'detached', 'closed'])
export type PtyState = z.infer<typeof PtyState>

/** Signals a PTY adapter must be able to deliver (INT/TERM/KILL). */
export const PtySignal = z.enum(['INT', 'TERM', 'KILL'])
export type PtySignal = z.infer<typeof PtySignal>

/** Allowlisted shell presets — the only argv a PTY may ever run. The open
 * request references a preset, never an arbitrary command line. */
export const PtyShellPreset = z.enum(['sh', 'bash', 'zsh', 'fish'])
export type PtyShellPreset = z.infer<typeof PtyShellPreset>

/** Control frame kinds (client → server). */
export const PtyControlType = z.enum(['bytes', 'resize', 'signal', 'close'])
export type PtyControlType = z.infer<typeof PtyControlType>

/** Reason a session closed (audit field). */
export const PtyCloseReason = z.enum(['explicit', 'idle_ttl', 'permission_revoked', 'adapter_failed', 'lease_expired'])
export type PtyCloseReason = z.infer<typeof PtyCloseReason>

/**
 * A durable Interactive Terminal session row. All fields are pinned at open
 * time; `state`/`generation`/lease/activity are the only mutable surface and
 * every transition goes through the kernel state machine (pty-session.ts).
 */
export const PtySession = z.object({
  pty_session_id: z.string().regex(/^pty_[a-z0-9_]+$/),
  /** Human/agent principal that opened the session (durable identity). */
  principal_id: z.string().min(1),
  tenant_id: z.string().default(''),
  project_id: z.string().min(1),
  workspace_id: z.string().min(1),
  /** Trusted context binding, fixed when the PTY is opened. */
  context_kind: PtyContextKind,
  context_id: PtyContextId,
  parent_session_id: PtyContextId.nullable(),
  /** Human-readable tab metadata; neither field grants authority. */
  label: z.string().trim().min(1).max(96),
  purpose: z.string().trim().max(512).default(''),
  /** Opaque Runner profile/target ids — resolved server-side only. */
  profile: z.string().min(1),
  target: z.string().min(1),
  preset: PtyShellPreset,
  /** Root-relative cwd inside the workspace; never a host path. */
  cwd: z.string().min(1),
  /**
   * sha256 pin of the effective Config Schema at open time (canonical pin
   * format `sha256:<hex>`, see config-registry.pinConfig).
   */
  config_hash: z.string().regex(/^(sha256:)?[0-9a-f]{64}$/, 'config_hash must be a sha256 hex digest (optionally sha256:-prefixed)'),
  state: PtyState.default('open'),
  /** Bumped on every attach/detach — reconnect uses generation + after_seq. */
  generation: z.number().int().nonnegative().default(1),
  /** Session lease (PTY-01): opaque token + expiry, pinned at open.
   * STORE-06 (storage-migrations.md §4): only the sha256 of the token is
   * persisted (pty_sessions.lease_token_hash); the plaintext is returned at
   * open and kept in kernel memory, so a session read back after a kernel
   * restart surfaces null. */
  lease_token: z.string().min(1).nullable(),
  lease_expires_at: z.string().nullable().default(null),
  /** Server-owned idle TTL pinned from the effective Config Registry at open. */
  idle_ttl_s: z.number().int().min(PTY_MIN_IDLE_TTL_S).max(PTY_MAX_IDLE_TTL_S).default(PTY_DEFAULT_IDLE_TTL_S),
  /** Server-owned bounded output retention pinned at open. */
  retention_bytes: z.number().int().min(PTY_MIN_RETENTION_BYTES).max(PTY_MAX_RETENTION_BYTES).default(PTY_DEFAULT_RETENTION_BYTES),
  /** Output frames below this seq were evicted (retention); readers get a
   * gap. 0 = nothing evicted yet (reading from seq 0 is a clean replay). */
  retained_from_seq: z.number().int().nonnegative().default(0),
  /** Last applied control client_seq (idempotency cursor). */
  last_client_seq: z.number().int().nonnegative().default(0),
  /** Last allocated output server_seq. */
  last_event_seq: z.number().int().nonnegative().default(0),
  /** Total output bytes retained (bounded by retention_bytes). */
  total_bytes: z.number().int().nonnegative().default(0),
  /** Output bytes dropped by retention eviction. */
  dropped_bytes: z.number().int().nonnegative().default(0),
  /** Adapter identity selected by the Kernel from the current runner target. */
  adapter_id: z.string().default('none'),
  open_at: z.string(),
  last_activity_at: z.string(),
  closed_at: z.string().nullable().default(null),
  close_reason: PtyCloseReason.nullable().default(null),
})
export type PtySession = z.infer<typeof PtySession>

/** POST /v1/pty/sessions body (PTY-01 open contract). `cwd` is relative;
 * config hash, idle/retention policy and lease policy are server-owned and
 * therefore deliberately absent from this strict browser request. */
export const PtyOpenRequest = z.object({
  /** The only authority-bearing reference accepted from the browser. The
   * server resolves project/owner/parent/profile/target from this id. */
  context_id: PtyContextId,
  workspace_id: z.string().min(1),
  label: z.string().trim().min(1).max(96),
  purpose: z.string().trim().max(512).default(''),
  preset: PtyShellPreset,
  cwd: z.string().min(1),
  cols: z.number().int().positive().max(500).default(80),
  rows: z.number().int().positive().max(300).default(24),
}).strict()
export type PtyOpenRequest = z.infer<typeof PtyOpenRequest>

/** Safe context projection returned to the browser. Principal identity and
 * credentials are intentionally absent. */
export const PtyContext = z.object({
  context_kind: PtyContextKind,
  context_id: PtyContextId,
  project_id: z.string().min(1),
  parent_session_id: PtyContextId.nullable(),
  runner_profile_id: z.string().min(1),
  runner_target_id: z.string().min(1),
  target_kind: z.enum(['local-process', 'local-docker', 'remote-ssh']),
}).strict()
export type PtyContext = z.infer<typeof PtyContext>

/** One context's recoverable PTY tabs. active_hint is a non-authoritative UI
 * hint (the newest usable session), never an implicit control target. */
export const PtyContextSessions = z.object({
  context: PtyContext,
  sessions: z.array(PtySession),
  active_hint: z.string().nullable(),
}).strict()
export type PtyContextSessions = z.infer<typeof PtyContextSessions>

/** Attach/detach/close fencing body. A generation is mandatory; omitting it
 * can never mean "use latest". */
export const PtyAttachRequest = z.object({
  expected_generation: z.number().int().positive(),
}).strict()
export type PtyAttachRequest = z.infer<typeof PtyAttachRequest>

export const PtyDetachRequest = PtyAttachRequest
export type PtyDetachRequest = z.infer<typeof PtyDetachRequest>

export const PtyCloseRequest = PtyAttachRequest
export type PtyCloseRequest = z.infer<typeof PtyCloseRequest>

/** One control frame sent by the client (full wire record). */
export const PtyControlFrame = z.discriminatedUnion('type', [
  z.object({
    pty_session_id: z.string().min(1),
    client_seq: z.number().int().nonnegative(),
    type: z.literal('bytes'),
    /** UTF-8-safe text (sanitized before the wire, like run terminal chunks). */
    payload: z.object({ text: z.string(), byte_length: z.number().int().nonnegative() }).strict(),
    created_at: z.string(),
  }),
  z.object({
    pty_session_id: z.string().min(1),
    client_seq: z.number().int().nonnegative(),
    type: z.literal('resize'),
    payload: z.object({ cols: z.number().int().positive().max(500), rows: z.number().int().positive().max(300) }).strict(),
    created_at: z.string(),
  }),
  z.object({
    pty_session_id: z.string().min(1),
    client_seq: z.number().int().nonnegative(),
    type: z.literal('signal'),
    payload: z.object({ signal: PtySignal }).strict(),
    created_at: z.string(),
  }),
  z.object({
    pty_session_id: z.string().min(1),
    client_seq: z.number().int().nonnegative(),
    type: z.literal('close'),
    payload: z.object({}).strict(),
    created_at: z.string(),
  }),
])
export type PtyControlFrame = z.infer<typeof PtyControlFrame>

/** POST /v1/pty/sessions/{id}/control body (no session id / timestamps —
 * the server fills them). */
export const PtyControlRequest = z.discriminatedUnion('type', [
  z.object({
    expected_generation: z.number().int().positive(),
    client_seq: z.number().int().nonnegative(),
    type: z.literal('bytes'),
    payload: z.object({ text: z.string(), byte_length: z.number().int().nonnegative() }).strict(),
  }).strict(),
  z.object({
    expected_generation: z.number().int().positive(),
    client_seq: z.number().int().nonnegative(),
    type: z.literal('resize'),
    payload: z.object({ cols: z.number().int().positive().max(500), rows: z.number().int().positive().max(300) }).strict(),
  }).strict(),
  z.object({
    expected_generation: z.number().int().positive(),
    client_seq: z.number().int().nonnegative(),
    type: z.literal('signal'),
    payload: z.object({ signal: PtySignal }).strict(),
  }).strict(),
  z.object({
    expected_generation: z.number().int().positive(),
    client_seq: z.number().int().nonnegative(),
    type: z.literal('close'),
    payload: z.object({}).strict(),
  }).strict(),
])
export type PtyControlRequest = z.infer<typeof PtyControlRequest>

/** Poll/SSE replay cursor plus the exact session generation the caller has
 * attached. Generation changes are explicit reconnect boundaries. */
export const PtyFramesRequest = z.object({
  after_seq: z.number().int().nonnegative(),
  expected_generation: z.number().int().positive(),
}).strict()
export type PtyFramesRequest = z.infer<typeof PtyFramesRequest>

/** One output frame produced by the server (append-only, server_seq
 * monotonic per session). */
export const PtyOutputFrame = z.discriminatedUnion('type', [
  z.object({
    pty_session_id: z.string().min(1),
    server_seq: z.number().int().nonnegative(),
    type: z.literal('output'),
    payload: z.object({
      text: z.string(),
      byte_length: z.number().int().nonnegative(),
      channel: z.enum(['stdout', 'stderr']).default('stdout'),
    }).strict(),
    created_at: z.string(),
  }),
  z.object({
    pty_session_id: z.string().min(1),
    server_seq: z.number().int().nonnegative(),
    type: z.literal('exit'),
    payload: z.object({
      exit_code: z.number().int().nullable().default(null),
      signal: z.string().nullable().default(null),
    }).strict(),
    created_at: z.string(),
  }),
  z.object({
    pty_session_id: z.string().min(1),
    server_seq: z.number().int().nonnegative(),
    type: z.literal('gap'),
    payload: z.object({
      /** First seq the client asked for but retention already evicted. */
      gap_from_seq: z.number().int().nonnegative(),
      gap_to_seq: z.number().int().nonnegative(),
      dropped_bytes: z.number().int().nonnegative(),
      dropped_frames: z.number().int().nonnegative(),
    }).strict(),
    created_at: z.string(),
  }),
])
export type PtyOutputFrame = z.infer<typeof PtyOutputFrame>

/** GET /v1/pty/sessions/{id}/frames?after_seq= response projection. */
export const PtyFramesPage = z.object({
  pty_session_id: z.string().min(1),
  after_seq: z.number().int().nonnegative(),
  retained_from_seq: z.number().int().nonnegative(),
  dropped_bytes: z.number().int().nonnegative(),
  total_bytes: z.number().int().nonnegative(),
  /** true when after_seq < retained_from_seq — the client must resync. */
  gap: z.boolean(),
  frames: z.array(PtyOutputFrame),
})
export type PtyFramesPage = z.infer<typeof PtyFramesPage>
