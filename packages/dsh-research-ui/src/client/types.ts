/** GUIDE-01 structured NextAction wire shape (kernel-authoritative). */
export interface NextActionV2 {
  id?: string
  code?: string
  label?: string
  reason?: string
  required?: true | string[]
  route?: string
  capability?: string
  revision?: number | null
  state?: 'ready' | 'blocked' | 'done'
  blocking?: boolean
  refs?: Array<{ kind?: string; id?: string }>
  required_by?: 'human' | 'agent' | 'runner'
}

/* ─────────────────────── ONBOARD-01 intake wire shapes ───────────────────────
 * Mirror research-schemas intake.ts with optional fields (same
 * dependency-light pattern as NextActionV2): the pure logic layer
 * (intake-flow.ts) and the wizard (modals/intake.ts) consume these. */

export interface IntakeSessionLite {
  intake_id?: string
  project_id?: string | null
  owner?: { principal_id?: string; auth_method?: string; session_id?: string | null }
  status?: string
  revision?: number
  source_label?: string
  target_phase?: string | null
  expires_at?: string
  scan_summary?: Record<string, unknown>
  created_at?: string
  updated_at?: string
  audit?: Array<{ at?: string; action?: string; detail?: string }>
}

export interface IntakeArtifactLite {
  artifact_id?: string
  intake_id?: string
  file_name?: string
  media_type?: string
  size_bytes?: number
  sha256?: string
  quarantine?: string
  scan_result?: Record<string, unknown>
  created_at?: string
}

export interface IntakeObservationLite {
  observation_id?: string
  intake_id?: string
  artifact_id?: string
  locator?: string
  detector?: string
  detector_version?: string
  value?: string
  warnings?: string[]
  trust?: string
  created_at?: string
}

export interface GrillAnswerViewLite {
  question_code?: string
  label_key?: string
  prompt?: string
  reason?: string
  required?: boolean
  depends_on?: string[]
  question_revision?: number
  question_type?: string
  answer?: string | null
  answered_at?: string | null
  answered_by?: string | null
  provenance?: string
}

export interface PhaseProposalLite {
  proposal_id?: string
  intake_id?: string
  revision?: number
  observed_phase?: string
  safe_project_status?: string
  confidence?: number
  plan?: string
  risks?: string[]
  pre_accept_checklist?: string[]
  unresolved_gaps?: string[]
  suggested_mappings?: Array<{ source_artifact_id?: string; target_kind?: string; note?: string }>
  required_gates?: string[]
  next_actions?: NextActionV2[]
  created_at?: string
}

export interface AdoptionReceiptLite {
  adoption_id?: string
  intake_id?: string
  project_id?: string
  proposal_revision?: number
  target_project_revision?: number
  created_object_refs?: string[]
  pending_gate_refs?: string[]
  draft_evidence_refs?: string[]
  idempotency_key?: string | null
  request_hash?: string
  adopted_by?: { principal_id?: string }
  adopted_at?: string
}

/** Full resumable intake state (GET /v1/projects/{id}/intake/{iid} —
 *  survives kernel restarts; every wizard step re-derives from it). */
export interface IntakeProjectionLite {
  session?: IntakeSessionLite
  artifacts?: IntakeArtifactLite[]
  observations?: IntakeObservationLite[]
  questions?: GrillAnswerViewLite[]
  proposal?: PhaseProposalLite | null
  receipt?: AdoptionReceiptLite | null
}

export interface Projection {
  project?: {
    project_id?: string; name?: string; status?: string; revision?: number; brief_status?: 'collecting' | 'confirmed'
    brief?: { problem?: string; primary_metrics?: string[] }
    constraints?: { max_model_cost_usd?: number; max_gpu_hours?: number; max_parallel_jobs?: number; datasets?: string; external_model_upload?: string }
    execution?: { runner_profile_id?: string | null; runner_target_id?: string; network_policy?: string; artifact_store?: string }
    integrity?: { require_baseline_reproduction?: boolean; require_experiment_contract?: boolean; require_claim_evidence_links?: boolean; require_clean_room_rerun?: boolean; allow_automatic_public_release?: boolean }
    history?: string[]
  }
  pending_gates?: Array<{ gate_id?: string; type?: string; title?: string; summary?: string; status?: string }>
  jobs?: Array<{ job_id?: string; kind?: string; status?: string; error?: string; contract_id?: string | null }>
  budget?: { model_cost_usd?: number; gpu_hours?: number; api_requests?: number }
  counts?: { ideas?: number; contracts?: number; claims?: number; evidence?: number; artifacts?: number; corpus_snapshots?: number }
  /** GUIDE-01: the only authoritative next-step projection. Missing or
   * malformed wire data is a safe empty state and never a label fallback. */
  next_actions_v2?: NextActionV2[]
}

export interface ClaimRow { claim_id?: string; statement?: string; status?: string; confidence?: string; scope?: { dataset?: string; split?: string }; evidence?: { evidence_ids?: string[]; analysis_artifact?: string }; limitations?: string[]; history?: Array<{ status?: string; at?: string; reason?: string }> }
export interface EvidenceRow { evidence_id?: string; analysis_method?: string; result?: { primary_metric?: string; value?: number; effect_size?: number; ci_low?: number; ci_high?: number; n_seeds?: number }; artifact_refs?: string[]; run_ids?: string[]; provenance_status?: string }
export interface ArtifactRow {
  artifact_id?: string
  kind?: string
  size_bytes?: number
  metadata?: Record<string, unknown>
  media_type?: string
  file_name?: string | null
}
export interface GateRow { gate_id?: string; type?: string; title?: string; status?: string; summary?: string }
export interface ProjectRow { project_id?: string; name?: string; status?: string; revision?: number; updated_at?: string }

export type RunnerTargetKindLite = 'local-process' | 'local-docker' | 'remote-ssh'
export type RunnerTargetComputeLite =
  | { mode: 'cpu' }
  | { mode: 'nvidia'; devices: 'all' | string[] }
export interface RunnerTargetRuntimeLite {
  image_digest: string
  compute: RunnerTargetComputeLite
}
export interface SecretRefViewLite { scheme: 'keyring' | 'file' | 'vault'; name: string; version?: string; scope?: string; available: boolean }
export type ProviderKindLite = 'openai-compatible' | 'anthropic' | 'google' | 'local' | 'mineru' | 'custom'
export interface ProviderModelLite {
  model_id: string
  display_name?: string
  capabilities: Array<'chat' | 'vision' | 'ocr' | 'embedding'>
  revision: number
}
export interface ProviderSafeViewLite {
  provider_id: string
  display_name: string
  kind: ProviderKindLite
  base_url: string
  enabled: boolean
  capabilities: Array<'chat' | 'vision' | 'ocr' | 'embedding'>
  models: ProviderModelLite[]
  revision: number
  credential?: SecretRefViewLite
  created_by: string
  created_at: string
  updated_at: string
}
export interface ProjectModelBindingLite {
  project_id: string
  purpose: 'chat' | 'ocr' | 'vision'
  provider_id: string
  model_id: string
  provider_revision: number
  provider_config_hash: string
  revision: number
  updated_by: string
  updated_at: string
}
export interface RunnerTargetSafeViewLite {
  target_id: string
  display_name: string
  kind: RunnerTargetKindLite
  enabled: boolean
  draining: boolean
  capabilities: string[]
  runtime?: RunnerTargetRuntimeLite
  service_identity?: SecretRefViewLite
  connection?: { endpoint: SecretRefViewLite; credential: SecretRefViewLite; known_hosts: SecretRefViewLite }
  health: 'unknown' | 'online' | 'offline'
  last_seen_at: string | null
  revision: number
  config_hash: string
}

export interface ProjectExecutionSettingsLite {
  project_id: string
  name: string
  revision: number
  execution: {
    runner_target_id: string
    runner_profile_id: string | null
  }
}

export interface WorkspaceContentSearchResultLite {
  info: WorkspaceInfoLite
  hits: Array<{ path: string; match_count: number; matches: Array<{ line: number; snippet: string }> }>
  truncated: boolean
}

/* ── TRAJ-01/SUBAGENT-01 wire shapes (research-schemas/trajectory.ts
 *  contract, docs/trajectory-subagents.md §1/§3 — mirrored structurally so
 *  the browser bundle stays dependency-light). ── */

export type TrajectoryLaneKey = 'research' | 'session'

/** One projected, REDACTED trajectory entry (raw payload never leaves the
 *  kernel; `summary` is the allowlisted, truncated projection). */
export interface TrajectoryEntry {
  entry_id: string
  event_seq: number
  event_version?: number
  project_id: string
  aggregate_type?: string | null
  aggregate_id?: string | null
  kind: string
  lane: TrajectoryLaneKey
  source?: string
  occurred_at: string
  session_id?: string | null
  summary: string
  status?: string | null
}

/** Keyset-paginated trajectory page ((event_seq, event_id) cursor). */
export interface TrajectoryPage {
  project_id: string
  entries: TrajectoryEntry[]
  next_after_seq: number | null
  next_after_event_id: string | null
  has_more: boolean
  total: number
  limit: number
  lane: TrajectoryLaneKey | null
}

/** Research vs Session lanes for one project, each with its own cursor. */
export interface TrajectoryLanes {
  project_id: string
  research: TrajectoryPage
  session: TrajectoryPage
}

/** One topology node (direct children only; state/mode are wire enums). */
export interface TopologyNode {
  child_id: string
  project_id: string
  parent_id?: string | null
  label?: string | null
  summary?: string
  kind?: string
  mode?: string
  state?: string
  role?: string | null
  started_at: string
  ended_at?: string | null
  has_children: boolean
  children_count: number
  seq: number
  refs?: Array<{ kind: string; id: string }>
}

/** Direct children of one parent (or roots when parent_id is null). */
export interface TopologyChildren {
  project_id: string
  parent_id: string | null
  items: TopologyNode[]
  total: number
  next_after_seq: number | null
  has_more: boolean
}

/** Exact-parent + breadcrumb (root → parent, self excluded) for one child. */
export interface ChildDetail {
  child_id: string
  project_id: string
  node: TopologyNode
  parent: TopologyNode | null
  breadcrumb: TopologyNode[]
}

/** Append-only per-child history row (started / state / followup). */
export interface ChildHistoryEntry {
  seq: number
  event_id: string
  child_id: string
  type: string
  occurred_at: string
  summary: string
}

export interface ChildHistoryPage {
  child_id: string
  project_id: string
  items: ChildHistoryEntry[]
  next_after_seq: number | null
  has_more: boolean
  total: number
}

/** One-shot READ-ONLY followup acceptance (message_id only, never executes). */
export interface FollowupReceipt {
  message_id: string
  child_id: string
  project_id: string
  accepted: boolean
  read_only: boolean
  state_unchanged: boolean
  note: string
}

/** Shared client data shapes (kernel projections + row shapes). */

export interface ContextMenuItem {
  label: string
  hint?: string
  danger?: boolean
  /** dsh-web menu grouping: a divider is drawn before this item. */
  divider?: boolean
  onPick: () => void
}

export interface TerminalLine { seq: number; channel: 'stdout' | 'stderr'; text: string }

export interface ChatMessage {
  role: 'user' | 'assistant' | 'error'
  text: string
  time: string
  /** dsh-web quote-reply: the quoted message, shown above the bubble. */
  quote?: { index: number; text: string }
  /** dsh-web pin: starred messages surface in a 📌 section at the top. */
  pinned?: boolean
  /** Tool-free model or deterministic router suggestion; always editable and never auto-run. */
  suggested_command?: string
  /**
   * INIT-GRILL-02 §2: chat 消息只保存 attachment/stage ref —— 附件进入同一
   * active Intake 的批量分块队列；消息本体不携带文件字节。
   */
  attachment?: ChatAttachmentRef
}

/** Chat 消息携带的附件/stage 引用（不携带字节；状态跟随队列）。 */
export interface ChatAttachmentRef {
  kind: 'intake-upload'
  upload_id: string
  intake_id: string
  project_id: string
  file_name: string
  state: 'queued' | 'uploading' | 'paused' | 'staged' | 'ready' | 'quarantined' | 'failed'
}

export interface ChatSession { project_id: string; id: string; name: string; messages: ChatMessage[]; lastActive?: number; archived?: boolean; unread?: number; pinned?: boolean }

export interface NotifEntry { text: string; time: string; ts?: number; count?: number }

/* ── WORK-01 workspace wire shapes (research-schemas/workspace.ts contract,
 *  api-contracts.md §17 — mirrored structurally so the browser bundle stays
 *  dependency-light, same pattern as Trajectory/Topology). ── */

export interface WorkspaceInfoLite {
  workspace_id: string
  project_id: string
  kind: string
  name: string
  revision: number
  created_at: string
  updated_at: string
}

/** One node of the workspace file tree (dirs are projected from path
 *  prefixes — only `file` nodes are stored server-side). `content` is
 *  present only for text reads; binary nodes carry blob_sha256 and are
 *  read-only for text writes (replaced via the binary upload path). */
export interface WorkspaceNodeLite {
  path: string
  kind: 'file' | 'dir'
  binary: boolean
  media: string
  size: number
  version: number
  etag: string
  hash: string
  content: string | null
  blob_sha256: string | null
  created_at: string
  updated_at: string
}

/** GET /v1/projects/{id}/workspaces/{wsid}/tree projection. */
export interface WorkspaceTreePayload {
  info: WorkspaceInfoLite
  nodes: WorkspaceNodeLite[]
}

/** One durable mutation op (workspace_ops ledger / history projection). */
export interface WorkspaceOpLite {
  seq: number
  op: string
  path: string
  from_path: string | null
  version: number | null
  sha256: string | null
  at: string
}

/** One workspace revision (history projection, newest first). */
export interface WorkspaceRevisionLite {
  workspace_id: string
  revision: number
  at: string
  ops: WorkspaceOpLite[]
}

/** GET /v1/projects/{id}/workspaces/{wsid}/nodes?after_revision=N watch
 *  feed: changed nodes + deleted-path tombstones. */
export interface WorkspaceListSincePayload {
  info: WorkspaceInfoLite
  nodes: WorkspaceNodeLite[]
  deleted: string[]
}

export interface ManuscriptFile { path: string; version: number; content_hash: string; content?: string }

export interface ManuscriptBuild {
  build_id: string
  revision: number
  root_file: string
  job_id: string | null
  status: string
  diagnostics: string
  pdf_artifact: string | null
  log_artifact: string | null
  /** TEX-03 (P0-3): preview builds are marked preview=true on every build
   *  surface (GET builds / GET builds/{id} / GET preview-builds). */
  preview?: boolean
  /** TEX-03: build.revision < document.revision → stale (server-computed). */
  stale?: boolean
  superseded_by?: string | null
  superseded_at?: string | null
}
