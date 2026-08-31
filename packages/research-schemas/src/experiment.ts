/**
 * Experiment-layer schemas: ExperimentContract (pre-registered, frozen after
 * approval), RunManifest (runner-signed), CodeSnapshot (design §4.6, §6.4-6.5).
 * @module @dsh-scholar/research-schemas
 */

import { z } from 'zod'
import { FrozenProtocolPin, ResearchIntent } from './methodology.js'

/** Pre-registered experiment contract; immutable once approved (ADR-004). */
export const ExperimentContract = z.object({
  contract_id: z.string().regex(/^expc_[a-z0-9_]+$/),
  version: z.number().int().positive().default(1),
  project_id: z.string().min(1),
  idea_id: z.string().min(1),
  baseline_run: z.string().optional(),
  code_snapshot: z.string().optional(), // sha256:...
  data: z.object({
    dataset_id: z.string().min(1),
    version: z.string().default('official'),
    split: z.string().default('official'),
    preprocessing_hash: z.string().optional(),
  }),
  methods: z.object({
    baseline: z.string().min(1),
    treatment: z.string().min(1),
  }),
  metrics: z.object({
    primary: z.string().min(1),
    secondary: z.array(z.string()).default([]),
    /** MetricSpec direction (§12): higher-is-better or lower-is-better. */
    direction: z.enum(['higher_is_better', 'lower_is_better']).default('higher_is_better'),
  }),
  seeds: z.array(z.number().int()).default([11, 23, 47, 89, 101]),
  analysis: z.object({
    effect_size: z.string().default('mean_difference'),
    interval: z.string().default('bootstrap_95'),
    multiple_testing: z.string().default('holm'),
  }).default({}),
  ablations: z.array(z.string()).default([]),
  stop_conditions: z.object({
    max_gpu_hours: z.number().nonnegative().default(48),
    min_completed_seeds: z.number().int().nonnegative().default(5),
    stop_on_data_leakage: z.boolean().default(true),
  }).default({}),
  status: z.enum(['draft', 'approved', 'superseded', 'rejected']).default('draft'),
  approval: z.object({
    gate_decision_id: z.string().optional(),
    approved_at: z.string().optional(),
    approved_by: z.string().optional(),
  }).optional(),
  created_at: z.string(),
  updated_at: z.string(),
})
export type ExperimentContract = z.infer<typeof ExperimentContract>

/**
 * Immutable code snapshot reference (content-addressed, design §11.3).
 * v2 (SCH-EXEC-002): the snapshot MUST carry the ACTUAL content —
 * `archive_artifact_id` points at the CAS artifact holding the file contents
 * (JSON `{schema_version, files: {rel: {sha256, content_base64}}}`) and
 * `manifest_artifact_id` at the lightweight file manifest. The Runner only
 * ever materializes from the Artifact Store — never from agent host dirs.
 * `commit`/`hash`/`path` remain optional for legacy manifest-style records.
 */
export const CodeSnapshot = z.object({
  snapshot_id: z.string().min(1),
  project_id: z.string().min(1),
  commit: z.string().optional(),
  hash: z.string().optional(), // sha256:... (legacy manifest hash)
  path: z.string().optional(), // archived root path
  description: z.string().default(''),
  // §11.3: actual content materialized from CAS.
  archive_artifact_id: z.string().optional(), // sha256:... code artifact with file contents
  manifest_artifact_id: z.string().optional(), // sha256:... manifest artifact (file list + hashes)
  submodules_artifact_id: z.string().nullable().optional(),
  lockfiles: z.array(z.string()).default([]),
  files: z.number().int().nonnegative().optional(), // archived file count
  total_bytes: z.number().int().nonnegative().optional(), // raw content bytes
  sha256: z.string().optional(), // sha256 of the archive content itself
  created_at: z.string(),
})
export type CodeSnapshot = z.infer<typeof CodeSnapshot>

/**
 * §12.2 JobSpec binding attached to a durable job (v2 SCH-EXEC-002).
 * `code_snapshot_id` is persisted in the jobs table column; the remaining
 * fields travel in `payload` (image_digest, output_contract, data_artifact_ids)
 * — see ResearchKernel.submitJob. The Runner materializes the code snapshot
 * from CAS and reads the metrics file at `output_contract.metrics`.
 */
export const JobSpecBinding = z.object({
  code_snapshot_id: z.string().nullable().default(null),
  data_artifact_ids: z.array(z.string()).default([]),
  image_digest: z.string().default(''), // P0 (acceptance-tests.md §4): pinned to the trusted images.lock entry by the kernel; tags/latest/missing are 422
  output_contract: z.object({
    metrics: z.string().default('/outputs/metrics.json'),
    logs: z.string().default('/outputs/run.log'),
  }).optional(),
  // domain-model.md §9.1: Job 固定 opaque runner profile id + profile 记录
  // config hash（kernel submitJob 注入 payload；runner 按注册表复算校验，
  // 不一致 → environment 失败不执行）。缺省 null = legacy job（无 pin）。
  runner_profile_id: z.string().nullable().default(null),
  profile_config_hash: z.string().nullable().default(null),
  /** Methodology protocol admission pin. Formal or confirmatory jobs require
   * an exact frozen revision; exploratory fixture/analysis jobs may be null. */
  protocol_pin: FrozenProtocolPin.nullable().default(null),
  run_intent: ResearchIntent.default('exploratory'),
})
export type JobSpecBinding = z.infer<typeof JobSpecBinding>

/** A durable job record carrying the §12.2 JobSpec binding fields. */
export type JobSpecBound = import('./kernel.js').JobRecord & JobSpecBinding

/** Job failure classification with automatic decision mapping (design §4.6.2). */
export const FailureClass = z.enum([
  'environment',
  'resources',
  'code_error',
  'data_issue',
  'no_improvement',
  'unstable_results',
  'budget_exhausted',
  'unknown',
])
export type FailureClass = z.infer<typeof FailureClass>

/** Run manifest — generated and signed by the Runner; agents cannot edit (design §6.5). */
export const RunManifest = z.object({
  run_id: z.string().min(1),
  config_pin: z.string().regex(/^sha256:[0-9a-f]{64}$/),
  contract_id: z.string().min(1).nullable(),
  job_id: z.string().min(1),
  project_id: z.string().min(1),
  code_commit: z.string(),
  container_digest: z.string().default(''),
  data_hash: z.string().default(''),
  command: z.array(z.string()).default([]),
  resources: z.object({
    gpu: z.number().int().nonnegative().default(0),
    cpu: z.number().int().nonnegative().default(1),
    memory_gb: z.number().nonnegative().default(1),
  }).default({}),
  started_at: z.string(),
  finished_at: z.string().optional(),
  exit_code: z.number().int(),
  failure_class: FailureClass.optional(),
  metrics_artifact: z.string().optional(), // sha256:...
  log_artifact: z.string().optional(), // sha256:...
  checkpoint_artifact: z.string().optional(), // sha256:...
  signed_by: z.string().default('runner-gateway'),
  /** §12.6: only the lease generation is provenance; the plaintext token is never persisted. */
  lease: z.object({ generation: z.number().int().positive() }).strict(),
  /** §12.7: Ed25519 envelope — runner_key_id + payload hash + signature. */
  runner_key_id: z.string().optional(),
  payload_sha256: z.string().optional(),
  signature: z.string().optional(),
})
export type RunManifest = z.infer<typeof RunManifest>
