/**
 * RUN-REMOTE-01 — RemoteRunnerAgent wire 协议（HTTP+JSON，docs/remote-runner-wire.md、
 * execution-runtime.md §5.1、hardening-v0.2-status.md §3 RUN-REMOTE-01）。
 *
 * 本模块是服务端（RemoteFleetServer，runner-gateway）与代理端（RemoteAgent 客户端）
 * 之间 wire 消息的全部 zod schema——同一份 schema 供两端共享，保证协议层可测。
 *
 * 端点总览（生产必须 mTLS service identity；本地 wire 用 `x-service-token`
 * 等价实现，与 kernel 内部路由同一机制，见 docs/remote-runner-wire.md §3）：
 *
 * - POST /v1/agents/register                     → AgentRegisterRequest/Response
 * - POST /v1/agents/{agent_id}/heartbeat         → AgentHeartbeatRequest/Response
 * - POST /v1/agents/{agent_id}/claims            → AgentClaimRequest/Response
 * - POST /v1/agents/{agent_id}/runs/{run_id}/frames     → RemoteFramesRequest/Response
 * - POST /v1/agents/{agent_id}/runs/{run_id}/artifacts  → RemoteArtifactStageRequest/
 *   RemoteArtifactFinalizeRequest/Response
 * - POST /v1/agents/{agent_id}/runs/{run_id}/complete   → RemoteCompleteRequest/Response
 * - GET  /v1/agents/{agent_id}/cas/{sha}?project_id=    → CasFetchResponse
 *
 * 协议语义（与本地 runner 同路径，保证 lease/run_id/Manifest 跨 Local/Remote 一致）：
 *
 * - claim 返回的 ExecutionPlan 携带签名与 lease generation/token；代理端必须
 *   验签（缺签名/验签失败 → 拒绝执行，fail closed）；
 * - frames 复用 kernel terminal frame 语义（全局 seq 单调、gap/exit frame、
 *   lease_generation 逐帧携带；owner/token 在请求级携带——kernel 对两者精确匹配，
 *   旧 generation/token → 409 lease_stale）；
 * - artifacts 分 staged + finalize 两段：stage 声明 sha256/size，finalize 携带
 *   内容，服务端复算 sha256，不一致 → 409 cas_hash_mismatch（不落库）；
 * - complete 携带签名的 run_manifest + fencing 字段（owner/generation/token）；
 *   lease 过期后旧 Agent 的 complete 被 kernel 拒绝（既有 fencing，409
 *   lease_stale）——代理端只能丢弃或保留本地诊断，不能完成 Job；
 * - CAS 拉取按 artifact id/sha 寻址，响应携带服务端计算的 sha256，代理端复算
 *   内容 hash 并与响应比对，不一致 → 拒绝执行（不静默降级）。
 *
 * 错误面统一为 `{ error: { code, message, retryable } }`（code 见
 * docs/remote-runner-wire.md §7）；retryable 的环境类错误（offline/
 * agent_offline/no_capable_target/capability_mismatch/transport_unreachable/
 * lease_stale…）由调用方留在队列/标记重试，绝不静默回退 LocalDocker/subprocess。
 * @module @dsh-scholar/research-schemas/remote-runner-wire
 */

import { z } from 'zod'
import { AgentHealthStatus, AgentCapabilities, ExecutionPlan, RemoteAgentRegistration } from './execution-target.js'

/** wire schema 版本（任何破坏性变更必须递增并保持向后兼容映射）。 */
export const REMOTE_WIRE_SCHEMA_VERSION = 1

// ── 注册 / 心跳 ────────────────────────────────────────────────────────────

/**
 * 注册请求 = RemoteAgentRegistration（opaque target_id/agent_id/capabilities/
 * labels/health/cert_fingerprint；`.strict()` 拒绝 address/certificate/SSH
 * bootstrap——连接信息只由服务端 Config/SecretRef 解析）。
 */
export const AgentRegisterRequest = RemoteAgentRegistration
export type AgentRegisterRequest = z.infer<typeof AgentRegisterRequest>

/** 注册响应：acknowledged=true 表示服务端认可该 target/agent 并纳入调度。 */
export const AgentRegisterResponse = z.object({
  schema_version: z.literal(REMOTE_WIRE_SCHEMA_VERSION),
  acknowledged: z.literal(true),
  target_id: z.string().min(1),
  agent_id: z.string().min(1),
  /** 服务端 offline 判定窗口（毫秒）；代理端可据此调整心跳周期。 */
  offline_after_ms: z.number().int().positive(),
}).strict()
export type AgentRegisterResponse = z.infer<typeof AgentRegisterResponse>

/** 心跳请求：status 可携带 draining 等状态变更；capabilities/labels 可更新。 */
export const AgentHeartbeatRequest = z.object({
  schema_version: z.literal(REMOTE_WIRE_SCHEMA_VERSION),
  status: AgentHealthStatus.optional(),
  capabilities: AgentCapabilities.optional(),
  labels: z.record(z.string()).optional(),
}).strict()
export type AgentHeartbeatRequest = z.infer<typeof AgentHeartbeatRequest>

/** 心跳响应：accepted=false 表示 agent 未注册（服务端不认可，代理端应重新注册）。 */
export const AgentHeartbeatResponse = z.object({
  schema_version: z.literal(REMOTE_WIRE_SCHEMA_VERSION),
  acknowledged: z.literal(true),
  accepted: z.boolean(),
  target_id: z.string().min(1),
  offline_after_ms: z.number().int().positive(),
}).strict()
export type AgentHeartbeatResponse = z.infer<typeof AgentHeartbeatResponse>

// ── claim ──────────────────────────────────────────────────────────────────

export const AgentClaimRequest = z.object({
  schema_version: z.literal(REMOTE_WIRE_SCHEMA_VERSION),
  /** 单次最多拉取数（1..8；默认 1）。 */
  limit: z.number().int().min(1).max(8).optional(),
}).strict()
export type AgentClaimRequest = z.infer<typeof AgentClaimRequest>

/**
 * 一个 claim：不可变 ExecutionPlan（含签名）＋显式 lease fencing 字段。
 * plan.lease 与 lease 字段恒一致（冗余暴露便于 wire 层日志/断言）。
 * claim_id 是服务端 outstanding 登记键：代理端在 frames/complete 中回带，
 * 服务端据此去重与保留（断连期间服务端保留任务，恢复后可继续）。
 */
export const AgentClaim = z.object({
  claim_id: z.string().min(1),
  plan: ExecutionPlan,
  lease: z.object({
    owner: z.string().min(1),
    generation: z.number().int().positive(),
    token: z.string().min(1),
    expires_at: z.string().nullable(),
  }).strict(),
  claimed_at: z.string(),
}).strict()
export type AgentClaim = z.infer<typeof AgentClaim>

/** claim 响应：claims 为空 = 当前没有匹配该 agent 的工作（正常轮询结果）。 */
export const AgentClaimResponse = z.object({
  schema_version: z.literal(REMOTE_WIRE_SCHEMA_VERSION),
  claims: z.array(AgentClaim).max(8),
}).strict()
export type AgentClaimResponse = z.infer<typeof AgentClaimResponse>

/** Running-attempt supervision. Every renewal carries the complete fence;
 * cancellation is read from the authoritative Kernel job. */
export const RemoteRunHeartbeatRequest = z.object({
  schema_version: z.literal(REMOTE_WIRE_SCHEMA_VERSION),
  claim_id: z.string().min(1),
  job_id: z.string().min(1),
  lease: z.object({
    owner: z.string().min(1),
    generation: z.number().int().positive(),
    token: z.string().min(1),
  }).strict(),
}).strict()
export type RemoteRunHeartbeatRequest = z.infer<typeof RemoteRunHeartbeatRequest>

export const RemoteRunHeartbeatResponse = z.object({
  schema_version: z.literal(REMOTE_WIRE_SCHEMA_VERSION),
  run_id: z.string().min(1),
  status: z.enum(['running', 'cancelled']),
  lease_expires_at: z.string().nullable(),
}).strict()
export type RemoteRunHeartbeatResponse = z.infer<typeof RemoteRunHeartbeatResponse>

// ── frames（复用 kernel terminal frame 语义）──────────────────────────────

/**
 * 单个 terminal frame——与 kernel terminalFramesSchema 的 frame 形状一致
 * （seq 全局单调、stream_seq 通道内单调、chunk/gap/exit、byte offset/length、
 * payload_json、lease_generation 逐帧携带）。
 */
export const RemoteFrame = z.object({
  seq: z.number().int().nonnegative(),
  stream_seq: z.number().int().nonnegative().nullable().optional(),
  channel: z.enum(['stdout', 'stderr']).nullable().optional(),
  text: z.string().nullable().optional(),
  byte_offset: z.number().int().nonnegative().nullable().optional(),
  byte_length: z.number().int().nonnegative().nullable().optional(),
  frame_kind: z.enum(['chunk', 'gap', 'exit']),
  payload_json: z.string().optional(),
  lease_generation: z.number().int().positive(),
}).strict()
export type RemoteFrame = z.infer<typeof RemoteFrame>

/** frames 上传请求（run_id 在 URL；owner/token 请求级携带，kernel 精确匹配）。 */
export const RemoteFramesRequest = z.object({
  schema_version: z.literal(REMOTE_WIRE_SCHEMA_VERSION),
  frames: z.array(RemoteFrame).min(1).max(256),
  owner: z.string().min(1),
  lease_token: z.string().min(1),
  max_log_bytes: z.number().int().positive().optional(),
}).strict()
export type RemoteFramesRequest = z.infer<typeof RemoteFramesRequest>

/** frames 上传响应（kernel appendTerminalFrames 同形状，含 retention 记账）。 */
export const RemoteFramesResponse = z.object({
  schema_version: z.literal(REMOTE_WIRE_SCHEMA_VERSION),
  appended: z.number().int().nonnegative(),
  last_seq: z.number().int().nonnegative(),
  truncated: z.boolean(),
  total_bytes: z.number().int().nonnegative(),
  dropped_bytes: z.number().int().nonnegative(),
}).strict()
export type RemoteFramesResponse = z.infer<typeof RemoteFramesResponse>

// ── artifacts（staged + finalize + sha256）─────────────────────────────────

/** stage 请求：只声明 hash/size/元数据，不携带内容。 */
export const RemoteArtifactStageRequest = z.object({
  schema_version: z.literal(REMOTE_WIRE_SCHEMA_VERSION),
  run_id: z.string().min(1),
  /** 客户端可选预生成的 stage id（缺省服务端生成）。 */
  stage_id: z.string().min(1).optional(),
  /** 内容 sha256（64 位小写 hex）；finalize 时服务端复算比对。 */
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  size: z.number().int().positive(),
  kind: z.enum(['code', 'pdf', 'data', 'log', 'model', 'chart', 'paper', 'analysis', 'manifest', 'bundle']),
  media_type: z.string().min(1).optional(),
  file_name: z.string().min(1).optional(),
  metadata: z.record(z.unknown()).optional(),
}).strict()
export type RemoteArtifactStageRequest = z.infer<typeof RemoteArtifactStageRequest>

export const RemoteArtifactStageResponse = z.object({
  schema_version: z.literal(REMOTE_WIRE_SCHEMA_VERSION),
  stage_id: z.string().min(1),
}).strict()
export type RemoteArtifactStageResponse = z.infer<typeof RemoteArtifactStageResponse>

/** finalize 请求：携带内容，服务端复算 sha256 与 stage 声明比对（不一致拒绝）。 */
export const RemoteArtifactFinalizeRequest = z.object({
  schema_version: z.literal(REMOTE_WIRE_SCHEMA_VERSION),
  run_id: z.string().min(1),
  stage_id: z.string().min(1),
  content_base64: z.string().min(1),
}).strict()
export type RemoteArtifactFinalizeRequest = z.infer<typeof RemoteArtifactFinalizeRequest>

export const RemoteArtifactFinalizeResponse = z.object({
  schema_version: z.literal(REMOTE_WIRE_SCHEMA_VERSION),
  artifact_id: z.string().min(1),
  sha256: z.string().min(1),
  /** 相同内容已存在并被复用（CAS 幂等）。 */
  reused: z.boolean(),
}).strict()
export type RemoteArtifactFinalizeResponse = z.infer<typeof RemoteArtifactFinalizeResponse>

// ── complete（manifest 签名 + fencing）─────────────────────────────────────

/**
 * complete 请求：签名的 run_manifest + fencing 字段。run_manifest 必须携带
 * signature/payload_sha256/signed_by（§12.7；kernel 验签），并携带
 * lease.generation/token 供 kernel 核对——旧 generation/token → 409
 * lease_stale，代理端不能完成 Job。
 */
export const RemoteCompleteRequest = z.object({
  schema_version: z.literal(REMOTE_WIRE_SCHEMA_VERSION),
  claim_id: z.string().min(1),
  run_id: z.string().min(1),
  job_id: z.string().min(1),
  status: z.enum(['succeeded', 'failed', 'cancelled']),
  failure_class: z.string().nullable().optional(),
  error: z.string().nullable().optional(),
  /** canonical RunManifest（含 signature/payload_sha256/signed_by/lease）。 */
  run_manifest: z.record(z.unknown()),
  lease: z.object({
    owner: z.string().min(1),
    generation: z.number().int().positive(),
    token: z.string().min(1),
  }).strict(),
}).strict()
export type RemoteCompleteRequest = z.infer<typeof RemoteCompleteRequest>

export const RemoteCompleteResponse = z.object({
  schema_version: z.literal(REMOTE_WIRE_SCHEMA_VERSION),
  accepted: z.boolean(),
  job_id: z.string().min(1),
  status: z.enum(['succeeded', 'failed', 'cancelled']),
  /** accepted=false 时的稳定错误码（如 lease_stale）。 */
  code: z.string().nullable().default(null),
}).strict()
export type RemoteCompleteResponse = z.infer<typeof RemoteCompleteResponse>

// ── CAS ────────────────────────────────────────────────────────────────────

/**
 * CAS 拉取响应：content_base64 + 服务端对内容的 sha256。代理端必须复算内容
 * hash 并与 sha256 比对，不一致 → 拒绝执行（内容寻址完整性校验）。
 * 当 URL 中的 `sha` 本身是 64-hex 或 sha256:<hex> 时，代理端还须断言
 * response.sha256 与 URL 寻址 hash 一致。
 */
export const CasFetchResponse = z.object({
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  content_base64: z.string().min(1),
  media_type: z.string().optional(),
}).strict()
export type CasFetchResponse = z.infer<typeof CasFetchResponse>

// ── 通用错误面 ─────────────────────────────────────────────────────────────

/** wire 错误 envelope（与 kernel errorEnvelope 同形状：code/message/retryable）。 */
export const RemoteWireErrorEnvelope = z.object({
  code: z.string().min(1),
  message: z.string().min(1),
  retryable: z.boolean(),
}).strict()
export type RemoteWireErrorEnvelope = z.infer<typeof RemoteWireErrorEnvelope>
