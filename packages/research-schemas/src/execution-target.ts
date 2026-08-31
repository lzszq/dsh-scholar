/**
 * RUN-REMOTE-01 — ExecutionTarget 的 Schema/接口层（hardening-v0.2-status.md §3
 * RUN-REMOTE-01、docs/execution-runtime.md §5.1）。
 *
 * 本模块承载 ExecutionTarget 体系在 schema 层的全部契约：
 *
 * - `ExecutionPlan`：Kernel 固定的不可变执行计划（project/job/run/lease/
 *   profile/config/image digest/snapshot/artifact refs/limits/network/output
 *   contract + 签名）。target 不得改写——adapter 层负责冻结与 fingerprint
 *   断言（见 @dsh-scholar/runner-gateway 的 ExecutionTarget port）。
 * - `signExecutionPlan` / `verifyExecutionPlanSignature`：plan 签名（Ed25519，
 *   与 RunManifest §12.7 同源语义）。生产由 Kernel 签署、target 验签；当前
 *   接口层提供 helper 供测试与 gateway 使用。
 * - `RemoteAgentRegistration`：远端 Agent 注册记录。只含 opaque target_id、
 *   capability、labels、health 与 cert_fingerprint（指纹，非证书本身）。
 *   address/certificate/SSH bootstrap 只由服务端 Config/SecretRef 解析，
 *   schema 用 `.strict()` 让这些字段出现在注册记录/plan 时直接拒绝——
 *   Job/UI 永远只见 opaque profile/target ID 与安全健康摘要。
 * - `scheduledTarget`：纯函数调度决策。capability 匹配、offline 拒绝、
 *   无匹配 → 明确 retryable 错误；绑定 target offline 时在任何策略下
 *   都不回退 LocalDocker，更不回退 subprocess。
 *
 * 本轮为接口/schema 层：真实 mTLS 传输、远端 sandbox、spool、浏览器 UI
 * 不在本模块范围内（见 docs/hardening-v0.2-status.md RUN-REMOTE-01 行）。
 * @module @dsh-scholar/research-schemas/execution-target
 */

import { createHash, createPublicKey, sign, verify, type KeyObject } from 'node:crypto'
import { z } from 'zod'
import type { JobRecord } from './kernel.js'
import { computeProfileConfigHash, getRunnerProfile, PROFILE_CONFIG_HASH_RE } from './runner-profile.js'
import { RunnerTargetKind } from './runner-target.js'
import { DOCKER_IMAGE_DIGEST_RE, DockerCompute } from './runner-environment.js'

/** 本地 Docker target 的稳定 opaque id（Kernel/gateway/注册表共用）。 */
export const LOCAL_DOCKER_TARGET_ID = 'local-docker'

/** Job kind 枚举镜像 JobRecord.kind（Kernel 固定，plan 不可改写）。 */
export const ExecutionPlanKind = z.enum([
  'echo', 'smoke', 'baseline', 'pilot', 'formal', 'analysis', 'reproduce', 'latex-compile',
])
export type ExecutionPlanKind = z.infer<typeof ExecutionPlanKind>

/** Lease 绑定：plan 固定的 owner/generation/token，与 §12.6 fencing 一致。 */
export const LeaseBinding = z.object({
  owner: z.string().min(1),
  generation: z.number().int().positive(),
  token: z.string().min(1),
  expires_at: z.string().nullable(),
}).strict()
export type LeaseBinding = z.infer<typeof LeaseBinding>

/** 资源上限（§4.6.1 / RUN-02 容器基线；Kernel 固定，target 不得放宽）。 */
export const ExecutionLimits = z.object({
  timeout_ms: z.number().int().positive(),
  memory_mb: z.number().int().positive(),
  cpus: z.number().positive(),
  pids: z.number().int().positive(),
  max_log_bytes: z.number().int().positive(),
}).strict()
export type ExecutionLimits = z.infer<typeof ExecutionLimits>

/**
 * 网络策略。当前唯一合法值 `none`（security-baseline.md §5：host 网络/
 * 自动发布在 Config Registry security floor 层已被拒绝；plan 固定后
 * target 也不得改用其它网络）。
 */
export const ExecutionNetwork = z.object({
  policy: z.literal('none'),
}).strict()
export type ExecutionNetwork = z.infer<typeof ExecutionNetwork>

/** 输出契约（§12.5 MetricsFileV1）：metrics 路径 + contract/seed 绑定。 */
export const ExecutionOutputContract = z.object({
  /** output_contract.metrics 路径；secure kind 必须非空（RUN-01c）。 */
  metrics_path: z.string().nullable(),
  contract_id: z.string().nullable(),
  seed: z.number().int().nullable(),
  /** 允许的 metric 名（kernel 从 approved Contract 注入 payload.contract_metrics）。 */
  contract_metrics: z.array(z.string()),
  /**
   * smoke 显式 trusted fixture（execution-runtime.md §1）：subprocess 的唯一
   * 豁免（与本地 runner 的 payload.trusted_fixture 同一语义，固定进 plan 后
   * 远端 Agent 可判）。其余 kind 一律要求 digest-pinned container。
   */
  trusted_fixture: z.boolean(),
}).strict()
export type ExecutionOutputContract = z.infer<typeof ExecutionOutputContract>

/**
 * 固定镜像引用。secure 作业必须为 `<image>@sha256:<64hex>`（RUN-02，
 * kernel submitJob 强制 digest；缺 digest/tag/latest → 422），
 * latex-compile 由 kernel 注入锁内 texlive digest。target 不得改写。
 */
export const ExecutionImage = z.object({
  digest: z.string().regex(DOCKER_IMAGE_DIGEST_RE, 'image digest must be repository@sha256:<64 hex>'),
}).strict()
export type ExecutionImage = z.infer<typeof ExecutionImage>

/** 输入绑定：代码快照（CAS artifact id）与可选冻结 TeX snapshot。 */
export const ExecutionSnapshot = z.object({
  code_snapshot_id: z.string().nullable(),
  /** latex-compile 的冻结 TeX manifest（TEX-01：字节按 revision 从 snapshot store 取）。 */
  tex_snapshot: z.record(z.unknown()).nullable(),
}).strict()
export type ExecutionSnapshot = z.infer<typeof ExecutionSnapshot>

/**
 * 不可变 ExecutionPlan（execution-runtime.md §5.1）：Kernel 固定
 * project/job/run/lease/profile/config/image/snapshot/artifact/limits/
 * network/output contract 并签名，target 不得改写。`.strict()` 使未知键
 * 直接解析失败——plan 是固定契约，出现计划外字段即视为无效/被篡改。
 */
export const ExecutionPlan = z.object({
  schema_version: z.literal(1),
  plan_id: z.string().min(1),
  project_id: z.string().min(1),
  job_id: z.string().min(1),
  /** Kernel durable runs 行的 run_id（RUN-01：每次 attempt 一个，跨 target 一致）。 */
  run_id: z.string().min(1),
  kind: ExecutionPlanKind,
  command: z.array(z.string()),
  /** opaque runner profile id（Config/SecretRef 解析在服务端；Job/UI 只见 opaque id）。 */
  profile_id: z.string().min(1),
  /**
   * §12.2 data binding hash（Job payload.data_hash 固定进 plan；缺省 ''）。
   * 远端 manifest 的 data_hash 与本地 runner 同源——target 不得改写。
   */
  data_hash: z.string(),
  /** §12.2 code commit（Job payload.code_commit 固定进 plan；缺省 ''）。 */
  code_commit: z.string(),
  /**
   * profile 记录本身的 config hash pin（domain-model.md §9.1：Job 固定
   * profile/config hash；target 按注册表复算校验，不一致拒绝执行）。
   * Every current plan carries the exact registered profile hash.
   */
  profile_config_hash: z.string().regex(PROFILE_CONFIG_HASH_RE, 'profile_config_hash must be sha256:<64 hex>'),
  /** Kernel Job pin 中的 opaque target id。 */
  target_id: z.string().min(1),
  /** 当前 Target registry pin；三项必须完整存在。 */
  target_kind: RunnerTargetKind,
  target_revision: z.number().int().positive(),
  target_config_hash: z.string().regex(PROFILE_CONFIG_HASH_RE, 'target_config_hash must be sha256:<64 hex>'),
  lease: LeaseBinding,
  /** Kernel 提交 Job 时固定的 exact Project effective config pin（CONFIG-01）。 */
  config_pin: z.string().regex(PROFILE_CONFIG_HASH_RE, 'config_pin must be sha256:<64 hex>'),
  image: ExecutionImage,
  /** Typed accelerator request; arbitrary Docker flags/devices are not part of the plan. */
  compute: DockerCompute,
  snapshot: ExecutionSnapshot,
  artifact_refs: z.object({
    data_artifact_ids: z.array(z.string()),
  }).strict(),
  limits: ExecutionLimits,
  network: ExecutionNetwork,
  /** 可选平台约束（capability 匹配用；null = 不限）。 */
  platform: z.object({
    os: z.string().nullable(),
    arch: z.string().nullable(),
  }).strict(),
  /** 可选 runner 版本下限（capability 匹配用；null = 不限）。 */
  requires: z.object({
    runner_version: z.string().nullable(),
  }).strict(),
  output_contract: ExecutionOutputContract,
  // ── 签名（§5.1：plan 固定并签名）───────────────────────────────────────
  /** Ed25519 base64 签名；未签名时 null（接口层允许，生产由 Kernel 强制）。 */
  signature: z.string().nullable(),
  /** 签名前 canonical JSON 的 sha256。 */
  payload_sha256: z.string().nullable(),
  /** 签名者 id（Kernel 的 runner key id 或内核身份）。 */
  signed_by: z.string().nullable(),
  created_at: z.string(),
}).strict()
export type ExecutionPlan = z.infer<typeof ExecutionPlan>

/**
 * canonical JSON：递归按键名排序、无空白。与 runner 的 canonicalJson
 * （顶层排序）不同——plan 是嵌套对象，签名必须对嵌套键也确定。
 */
export function canonicalPlanJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(v => canonicalPlanJson(v)).join(',')}]`
  }
  if (typeof value === 'object' && value !== null) {
    const record = value as Record<string, unknown>
    const keys = Object.keys(record).sort()
    return `{${keys.map(k => `${JSON.stringify(k)}:${canonicalPlanJson(record[k])}`).join(',')}}`
  }
  return JSON.stringify(value)
}

/** plan 的确定性 fingerprint（sha256 over canonical JSON）——adapter 用它断言 plan 不可变。 */
export function executionPlanFingerprint(plan: ExecutionPlan): string {
  return createHash('sha256').update(canonicalPlanJson(plan)).digest('hex')
}

/** plan 签名密钥（Ed25519；§12.7 同源语义）。 */
export interface PlanSigningKey {
  /** 稳定公开身份，例如 `runner-<hex>`。 */
  keyId: string
  /** Ed25519 私钥。 */
  privateKey: KeyObject
}

/**
 * 签署 ExecutionPlan：payload_sha256 覆盖签名前的 canonical JSON（不含
 * payload_sha256/signature），signature 是对含 payload_sha256/signed_by 的
 * canonical JSON 的一次性 Ed25519 签名。返回新 plan 对象，不改写入参。
 */
export function signExecutionPlan(plan: ExecutionPlan, key: PlanSigningKey): ExecutionPlan {
  const unsigned = { ...plan, payload_sha256: null, signature: null, signed_by: null }
  const payloadSha256 = createHash('sha256').update(canonicalPlanJson(unsigned)).digest('hex')
  const signed = { ...unsigned, payload_sha256: payloadSha256, signed_by: key.keyId }
  const signature = sign(null, Buffer.from(canonicalPlanJson(signed), 'utf8'), key.privateKey).toString('base64')
  return { ...signed, signature }
}

export interface PlanSignatureVerification {
  valid: boolean
  reason: string | null
}

/**
 * 校验 plan 签名：Ed25519 验签 + payload_sha256 复算比对。任何一步失败
 * 返回 `{valid:false, reason}`——调用方必须 fail closed（不得执行）。
 */
export function verifyExecutionPlanSignature(plan: ExecutionPlan, publicKeyPem: string): PlanSignatureVerification {
  if (plan.signature === null || plan.payload_sha256 === null) {
    return { valid: false, reason: 'plan is not signed (signature/payload_sha256 missing)' }
  }
  const unsigned = { ...plan, payload_sha256: null, signature: null, signed_by: null }
  const actualPayloadSha256 = createHash('sha256').update(canonicalPlanJson(unsigned)).digest('hex')
  if (actualPayloadSha256 !== plan.payload_sha256) {
    return { valid: false, reason: 'payload_sha256 mismatch (plan content changed after signing)' }
  }
  try {
    const publicKey = createPublicKey(publicKeyPem)
    const signedPayload = { ...plan, signature: null }
    const ok = verify(null, Buffer.from(canonicalPlanJson(signedPayload), 'utf8'), publicKey, Buffer.from(plan.signature, 'base64'))
    if (!ok) return { valid: false, reason: 'Ed25519 signature verification failed' }
  } catch (error) {
    return { valid: false, reason: `signature verification error: ${(error as Error).message}` }
  }
  return { valid: true, reason: null }
}

/** buildExecutionPlan 的调用方选项（Kernel 未来即由此固定 plan）。 */
export interface BuildExecutionPlanOptions {
  run_id: string
  lease: { owner: string; generation: number; token: string; expires_at: string | null }
  timeout_ms: number
  command?: string[]
  created_at?: string
}

/**
 * 从 Kernel 的 JobRecord 固定 ExecutionPlan（接口层由 gateway 派生；
 * 生产路径上 Kernel 在 claim/提交时签署同一 plan，target 只读）。
 */
export function buildExecutionPlan(job: JobRecord, options: BuildExecutionPlanOptions): ExecutionPlan {
  const payload = job.payload as Record<string, unknown> | undefined
  const outputContract = payload?.output_contract
  const metricsPath = typeof outputContract === 'object' && outputContract !== null
    ? (outputContract as Record<string, unknown>).metrics
    : undefined
  const dataArtifactIds = Array.isArray(payload?.data_artifact_ids)
    ? (payload.data_artifact_ids as unknown[]).map(String)
    : []
  const contractMetrics = Array.isArray(payload?.contract_metrics)
    ? (payload.contract_metrics as unknown[]).filter((x): x is string => typeof x === 'string')
    : []
  const seed = typeof payload?.seed === 'number' && Number.isFinite(payload.seed) ? payload.seed : null
  const projectConfigPin = z.string()
    .regex(PROFILE_CONFIG_HASH_RE, 'project_config_pin must be sha256:<64 hex>')
    .parse(payload?.project_config_pin)
  const targetId = z.string().min(1).parse(payload?.runner_target_id)
  const targetKind = RunnerTargetKind.parse(payload?.runner_target_kind)
  const targetRevision = z.number().int().positive().parse(payload?.runner_target_revision)
  const targetConfigHash = z.string()
    .regex(PROFILE_CONFIG_HASH_RE, 'runner_target_hash must be sha256:<64 hex>')
    .parse(payload?.runner_target_hash)
  const profileId = z.string().min(1).parse(payload?.runner_profile_id)
  const profileConfigHash = z.string()
    .regex(PROFILE_CONFIG_HASH_RE, 'profile_config_hash must be sha256:<64 hex>')
    .parse(payload?.profile_config_hash)
  const profile = getRunnerProfile(profileId)
  if (profile === null) throw new Error(`runner profile ${profileId} is not registered`)
  if (computeProfileConfigHash(profile) !== profileConfigHash) {
    throw new Error(`runner profile ${profileId} config hash does not match the Job pin`)
  }
  const imageDigest = z.string()
    .regex(/^[^@\s]+@sha256:[0-9a-f]{64}$/, 'image_digest must be repository@sha256:<64 hex>')
    .parse(payload?.image_digest)
  const payloadCompute = DockerCompute.parse(payload?.runner_compute)
  const plan: ExecutionPlan = {
    schema_version: 1,
    plan_id: `plan_${job.job_id}`,
    project_id: job.project_id,
    job_id: job.job_id,
    run_id: options.run_id,
    kind: job.kind,
    command: options.command ?? job.command,
    profile_id: profile.profile_id,
    profile_config_hash: profile.config_hash,
    target_id: targetId,
    target_kind: targetKind,
    target_revision: targetRevision,
    target_config_hash: targetConfigHash,
    data_hash: typeof payload?.data_hash === 'string' ? payload.data_hash : '',
    code_commit: typeof payload?.code_commit === 'string' ? payload.code_commit : '',
    lease: {
      owner: options.lease.owner,
      generation: options.lease.generation,
      token: options.lease.token,
      expires_at: options.lease.expires_at,
    },
    config_pin: projectConfigPin,
    image: { digest: imageDigest },
    compute: payloadCompute,
    snapshot: {
      code_snapshot_id: (job as JobRecord & { code_snapshot_id?: string | null }).code_snapshot_id ?? null,
      tex_snapshot: job.kind === 'latex-compile' ? (payload?.tex_snapshot as Record<string, unknown> | undefined) ?? null : null,
    },
    artifact_refs: { data_artifact_ids: dataArtifactIds },
    // 资源上限与网络策略取自已解析 profile 记录（domain-model.md §9.1：
    // profile 是 docker 参数来源；缺省值与现状字节级一致）。
    limits: {
      timeout_ms: options.timeout_ms,
      memory_mb: profile.limits.memory_mb,
      cpus: profile.limits.cpus,
      pids: profile.limits.pids,
      max_log_bytes: 32 * 1024 * 1024,
    },
    network: { policy: profile.network_policy },
    platform: { os: null, arch: null },
    requires: { runner_version: null },
    output_contract: {
      metrics_path: typeof metricsPath === 'string' && metricsPath !== '' ? metricsPath : null,
      contract_id: job.contract_id,
      seed,
      contract_metrics: contractMetrics,
      trusted_fixture: (payload as Record<string, unknown> | undefined)?.trusted_fixture === true,
    },
    signature: null,
    payload_sha256: null,
    signed_by: null,
    created_at: options.created_at ?? new Date().toISOString(),
  }
  return ExecutionPlan.parse(plan)
}

// ── 远端 Agent 注册表 schema ──────────────────────────────────────────────

/** Agent 健康状态；draining = 不再接受新 Job（可收尾存量）。 */
export const AgentHealthStatus = z.enum(['online', 'offline', 'draining'])
export type AgentHealthStatus = z.infer<typeof AgentHealthStatus>

export const AgentCapabilities = z.object({
  os: z.enum(['linux', 'darwin', 'windows']).default('linux'),
  arch: z.enum(['x64', 'arm64']).default('x64'),
  /** runner 版本（形如 `0.1.0`；调度按需与 plan.requires.runner_version 比较）。 */
  runner_ver: z.string().min(1),
  /** 支持的镜像 digest 列表；空数组 = 接受任何 Kernel 锁内 digest。 */
  images: z.array(z.string()).default([]),
  /** Observed NVIDIA support; null means the agent cannot accept NVIDIA plans. */
  nvidia: z.object({
    toolkit_available: z.boolean(),
    devices: z.array(z.string().regex(/^(0|[1-9][0-9]*)$/)).default([]),
  }).strict().nullable().optional(),
})
export type AgentCapabilities = z.infer<typeof AgentCapabilities>

export const AgentHealth = z.object({
  status: AgentHealthStatus.default('online'),
  /** ISO 时间；超过 offline_after_ms 未更新即判定 offline。 */
  last_seen: z.string(),
})
export type AgentHealth = z.infer<typeof AgentHealth>

/**
 * 远端 Agent 注册记录（execution-runtime.md §5.1）。`.strict()`：
 * address/certificate/SSH bootstrap/凭据等字段出现在注册记录里即解析失败
 * ——它们只由服务端 Config/SecretRef 解析，Job/UI/调度面永远只见 opaque
 * target_id 与安全健康摘要。cert_fingerprint 只登记指纹（远程必填；
 * 本地 target 可置 null 表示无 mTLS 证书）。
 */
export const RemoteAgentRegistration = z.object({
  schema_version: z.literal(1),
  /** opaque target id（与 ExecutionPlan.target_id 对齐）。 */
  target_id: z.string().min(1),
  /** 具体 Agent 实例 id（同一 target 可有多个 agent）。 */
  agent_id: z.string().min(1),
  capabilities: AgentCapabilities,
  labels: z.record(z.string()).default({}),
  health: AgentHealth,
  /** mTLS 证书指纹（远程 Agent 必填；本地 target 为 null）。 */
  cert_fingerprint: z.string().nullable().default(null),
}).strict()
export type RemoteAgentRegistration = z.infer<typeof RemoteAgentRegistration>

// ── 调度决策纯函数 ─────────────────────────────────────────────────────────

export const TargetUnavailableReason = z.enum([
  'offline',
  'draining',
  'capability_mismatch',
  'no_capable_target',
  'policy_blocked',
])
export type TargetUnavailableReason = z.infer<typeof TargetUnavailableReason>

/**
 * 调度结果。`assigned:false` 时恒 `retryable:true` 并携带 reason——
 * 调用方必须把任务留在队列/标记 retryable，绝不静默降级（不回退
 * LocalDocker，更不回退 subprocess）。
 */
export type TargetSelection =
  | { assigned: true; target_id: string }
  | { assigned: false; retryable: true; reason: TargetUnavailableReason; target_id: string | null }

/** 调度 policy（可配置，如 prefer local）。 */
export const TargetSchedulingPolicy = z.object({
  /** 候选可用时优先 local-docker（确定性选择）。 */
  prefer_local: z.boolean().default(true),
  /** 只允许 local-docker（等价于关闭远端 fleet）。 */
  local_only: z.boolean().default(false),
  /** 允许远端 target 参与调度。 */
  allow_remote: z.boolean().default(true),
  /** last_seen 超过该毫秒数判定 offline。 */
  offline_after_ms: z.number().int().positive().default(30_000),
}).strict()
export type TargetSchedulingPolicy = z.infer<typeof TargetSchedulingPolicy>

export const DEFAULT_TARGET_SCHEDULING_POLICY: TargetSchedulingPolicy = {
  prefer_local: true,
  local_only: false,
  allow_remote: true,
  offline_after_ms: 30_000,
}

/** offline 判定：status 非 online 或 last_seen 超过 offline_after_ms。 */
export function isTargetAvailable(registration: RemoteAgentRegistration, now: number, offlineAfterMs: number): boolean {
  if (registration.health.status !== 'online') return false
  const lastSeen = Date.parse(registration.health.last_seen)
  if (!Number.isFinite(lastSeen)) return false
  return now - lastSeen <= offlineAfterMs
}

/** 与 isTargetAvailable 互补（测试/日志用）。 */
export function isTargetOffline(registration: RemoteAgentRegistration, now: number, offlineAfterMs: number): boolean {
  return !isTargetAvailable(registration, now, offlineAfterMs)
}

/** 简单语义化版本比较（major.minor.patch 数值比较；非法版本视为 0）。 */
export function runnerVersionSatisfies(actual: string, required: string): boolean {
  const parse = (v: string): number[] => v.split('.').map(part => {
    const n = Number.parseInt(part, 10)
    return Number.isFinite(n) ? n : 0
  })
  const a = parse(actual)
  const r = parse(required)
  const len = Math.max(a.length, r.length)
  for (let i = 0; i < len; i++) {
    const av = a[i] ?? 0
    const rv = r[i] ?? 0
    if (av > rv) return true
    if (av < rv) return false
  }
  return true
}

/** capability 匹配：镜像 digest、os/arch、runner 版本下限。 */
export function matchesTargetCapability(plan: ExecutionPlan, registration: RemoteAgentRegistration): boolean {
  const caps = registration.capabilities
  if (caps.images.length > 0 && !caps.images.includes(plan.image.digest)) return false
  if (plan.platform.os !== null && caps.os !== plan.platform.os) return false
  if (plan.platform.arch !== null && caps.arch !== plan.platform.arch) return false
  if (plan.requires.runner_version !== null && !runnerVersionSatisfies(caps.runner_ver, plan.requires.runner_version)) return false
  if (plan.compute.mode === 'nvidia') {
    if (caps.nvidia == null || !caps.nvidia.toolkit_available) return false
    if (plan.compute.devices === 'all' && caps.nvidia.devices.length === 0) return false
    if (plan.compute.devices !== 'all' && plan.compute.devices.some(device => !caps.nvidia?.devices.includes(device))) return false
  }
  return true
}

/** 确定性排序：local 优先（prefer_local）、target_id、agent_id。 */
function rankCandidates(
  registrations: RemoteAgentRegistration[],
  preferLocal: boolean,
): RemoteAgentRegistration[] {
  return [...registrations].sort((a, b) => {
    if (preferLocal) {
      const al = a.target_id === LOCAL_DOCKER_TARGET_ID ? 0 : 1
      const bl = b.target_id === LOCAL_DOCKER_TARGET_ID ? 0 : 1
      if (al !== bl) return al - bl
    }
    if (a.target_id !== b.target_id) return a.target_id < b.target_id ? -1 : 1
    return a.agent_id < b.agent_id ? -1 : a.agent_id > b.agent_id ? 1 : 0
  })
}

/**
 * 调度决策纯函数（execution-runtime.md §5.1）：`scheduledTarget(plan,
 * registrations, policy) → target_id | null`。实现：
 *
 * - capability 匹配（镜像/os/arch/runner 版本）；
 * - offline/draining 拒绝（health.status 与 last_seen 时效）；
 * - 无匹配 → 明确 retryable 错误（reason 区分 offline/draining/
 *   capability_mismatch/no_capable_target/policy_blocked），绝不静默回退
 *   subprocess；bound target 不可用时也不回退 LocalDocker；
 * - policy 可配置（prefer local / local_only / allow_remote）。
 *
 * `now` 显式传入保证确定性（测试固定时间；生产传 Date.now()）。
 */
export function scheduledTarget(
  plan: ExecutionPlan,
  registrations: readonly RemoteAgentRegistration[],
  policy: TargetSchedulingPolicy = DEFAULT_TARGET_SCHEDULING_POLICY,
  now: number = Date.now(),
): TargetSelection {
  // policy 拦截：local_only 下 bound 远端 target 直接 policy_blocked。
  if (policy.local_only && plan.target_id !== LOCAL_DOCKER_TARGET_ID) {
    return { assigned: false, retryable: true, reason: 'policy_blocked', target_id: plan.target_id }
  }
  let candidates = registrations.filter(r => r.target_id === plan.target_id)
  if (!policy.allow_remote) {
    candidates = candidates.filter(r => r.target_id === LOCAL_DOCKER_TARGET_ID)
  }
  if (candidates.length === 0) {
    return { assigned: false, retryable: true, reason: 'no_capable_target', target_id: plan.target_id }
  }
  const available = candidates.filter(r => isTargetAvailable(r, now, policy.offline_after_ms))
  if (available.length === 0) {
    const reason: TargetUnavailableReason = candidates.some(r => r.health.status === 'draining') ? 'draining' : 'offline'
    return { assigned: false, retryable: true, reason, target_id: plan.target_id }
  }
  const capable = available.filter(r => matchesTargetCapability(plan, r))
  if (capable.length === 0) {
    return { assigned: false, retryable: true, reason: 'capability_mismatch', target_id: plan.target_id }
  }
  const pick = rankCandidates(capable, policy.prefer_local)[0]
  if (pick === undefined) {
    return { assigned: false, retryable: true, reason: 'no_capable_target', target_id: plan.target_id }
  }
  return { assigned: true, target_id: pick.target_id }
}

/** plan 的 lease 绑定 → fencing 字段（未来远端 frames/finalize/complete 复用）。 */
export function planLeaseFencing(plan: ExecutionPlan): { owner: string; generation: number; token: string | null } {
  return { owner: plan.lease.owner, generation: plan.lease.generation, token: plan.lease.token }
}
