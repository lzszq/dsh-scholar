/**
 * RunManifest 唯一构造器（hardening-v0.2-status.md §5 RUN-REMOTE-01 两行：
 * “remote 与 local 复用唯一 manifest builder”）。
 *
 * 本地 runner（index.ts executeJob）与远端 Agent（remote-agent.ts
 * executeClaim）必须产出同一形状的 canonical manifest 基座——run_id/
 * project_id/contract_id/job_id/config_pin/code_commit/code_snapshot_id/
 * container_digest/data_hash/seed/command/resources/started_at/finished_at/
 * exit_code。调用方再追加各自路径的 log_artifact/metrics_artifact/tex/
 * lease，并经 signManifest 签名（§12.7）。
 *
 * `seed` 是 §12.5 的 provenance fact（manifest.seed 与 job 固定 seed 一致，
 * kernel 对 secure kinds 校验）；`container_digest` 为 `docker:<digest>`
 * （secure kinds 必须 digest-pinned container）；`data_hash`/`code_commit`/
 * `code_snapshot_id` 为 snapshot facts（Job payload / ExecutionPlan 固定）。
 * @module @dsh-scholar/runner-gateway/run-manifest
 */

/** manifest 基座输入（本地 runner 与远端 Agent 各自提供等价字段）。 */
export interface RunManifestInput {
  run_id: string
  project_id: string
  job_id: string
  /** Exact Project effective config pin fixed in the claimed ExecutionPlan. */
  config_pin: string
  contract_id: string | null
  command: string[]
  code_commit: string
  code_snapshot_id: string | null
  /** `docker:<image-digest>`（docker/container 执行）或 ''（fixture）。 */
  container_digest: string
  data_hash: string
  /** §12.5 provenance seed（job/plan 固定；无 seed 为 null）。 */
  seed: number | null
  started_at: string
  finished_at: string
  exit_code: number
  /** Required so every adapter must attest the compute mode it executed. */
  compute: { mode: 'cpu' } | { mode: 'nvidia'; devices: 'all' | string[] }
}

/** 构造 canonical RunManifest 基座（local 与 remote 唯一实现）。 */
export function buildRunManifest(input: RunManifestInput): Record<string, unknown> {
  return {
    run_id: input.run_id,
    project_id: input.project_id,
    contract_id: input.contract_id,
    job_id: input.job_id,
    config_pin: input.config_pin,
    code_commit: input.code_commit,
    code_snapshot_id: input.code_snapshot_id ?? null,
    container_digest: input.container_digest,
    data_hash: input.data_hash,
    seed: input.seed,
    command: input.command,
    resources: input.compute.mode === 'nvidia'
      ? {
          gpu: input.compute.devices === 'all' ? 1 : input.compute.devices.length,
          gpu_mode: 'nvidia',
          gpu_devices: input.compute.devices,
          cpu: 1,
          memory_gb: 1,
        }
      // CPU has no device selector; omit GPU-specific metadata.
      : { gpu: 0, cpu: 1, memory_gb: 1 },
    started_at: input.started_at,
    finished_at: input.finished_at,
    exit_code: input.exit_code,
  }
}
