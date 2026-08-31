/**
 * NextAction — structured "what to do next" guidance projected by the
 * Kernel (GUIDE-01, design §4.2 Projection API, domain-model.md §14).
 *
 * The projection is a PURE function of authoritative state (project status,
 * pending gates, jobs, budget, contracts, ideas, evidence, claims) — never a
 * UI-local list. Every action carries a stable machine `code` plus the
 * context a UI/agent needs to render it safely:
 *
 * - `state` is the action's readiness from the project's perspective:
 *   - `ready`   — this is the current next step and can be executed now;
 *   - `blocked` — the action cannot execute until the `required` gaps are
 *     filled (the gap list names the missing preconditions);
 *   - `done`    — the step is already satisfied (terminal states, steps
 *     completed earlier in the phase).
 * - `required` is `true` when all preconditions are met, otherwise the list
 *   of missing precondition codes (e.g. `['approved_contract']`).
 * - `route` is the UI tab / operation path the action maps to
 *   (`chat` | `gates` | `runs` | `evidence` | `manuscript` | `budget` | `ideas` |
 *   `contracts` | `release` | `overview`).
 * - `revision` is the revision of the dependency object the action is
 *   pinned to (project revision for gate decisions, contract version for
 *   run actions, idea version for idea gates) — `null` when not applicable.
 * - `capability` is the role/permission required to perform the action
 *   (e.g. `researcher`, `pi`); absent means no extra capability beyond the
 *   project role.
 * - `blocking` marks actions that gate phase completion (pending human
 *   gates, budget exhaustion).
 * - `refs` name the concrete authoritative objects involved (gate/job/
 *   contract/idea ids).
 * - `required_by` says who must perform the action: `human` | `agent` |
 *   `runner`.
 *
 * This structure is the only next-step authority; consumers must not infer
 * mutations from display labels. A status with no mapping degrades to
 * `code: 'unknown'` (see
 * `NEXT_ACTION_UNKNOWN_CODE`) — a read-only label, never a mutation CTA.
 * @module @dsh-scholar/research-schemas
 */

import { z } from 'zod'

/** Machine code emitted when a project status has no NextAction mapping yet. */
export const NEXT_ACTION_UNKNOWN_CODE = 'unknown'

/** Readiness of a NextAction from the project's perspective (GUIDE-01). */
export const NextActionState = z.enum(['ready', 'blocked', 'done'])
export type NextActionState = z.infer<typeof NextActionState>

/** Who must perform the action: a human decision, an agent step or a runner. */
export const NextActionRequiredBy = z.enum(['human', 'agent', 'runner'])
export type NextActionRequiredBy = z.infer<typeof NextActionRequiredBy>

/** Reference to the authoritative object an action operates on. */
export const NextActionRef = z.object({
  /** Object kind: `gate` | `job` | `contract` | `idea` | `evidence` | `budget` … */
  kind: z.string().min(1),
  id: z.string().min(1),
})
export type NextActionRef = z.infer<typeof NextActionRef>

/**
 * One structured "next step" produced by the Kernel projection (GUIDE-01).
 * `id` is stable per action instance: `${code}:${projectId}` for the
 * phase-level action, `${code}:${projectId}:${refId}` for ref-bound overlays
 * (pending gates, failed jobs).
 */
export const NextAction = z.object({
  id: z.string().min(1),
  /** Stable machine code (e.g. `scope_gate_submit`, `survey_run`). */
  code: z.string().min(1),
  /** i18n key or English default label; display-only, never mutation authority. */
  label: z.string().min(1),
  /** Why this action is the next step right now. */
  reason: z.string().default(''),
  /** `true` when preconditions are met; otherwise the list of missing codes. */
  required: z.union([z.literal(true), z.array(z.string())]).default(true),
  /** UI tab / operation path the action maps to. */
  route: z.string().default(''),
  /** Role/permission required to perform the action (optional). */
  capability: z.string().optional(),
  /** Revision of the dependency object the action is pinned to (null = n/a). */
  revision: z.number().int().nonnegative().nullable().default(null),
  /** `ready` | `blocked` | `done`. */
  state: NextActionState.default('ready'),
  /** True when this action gates phase completion (pending gate, budget). */
  blocking: z.boolean().default(true),
  /** Concrete authoritative objects involved. */
  refs: z.array(NextActionRef).default([]),
  /** Who must perform the action. */
  required_by: NextActionRequiredBy.default('human'),
})
export type NextAction = z.infer<typeof NextAction>
