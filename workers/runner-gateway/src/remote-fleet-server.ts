/**
 * RUN-REMOTE-01 — RemoteFleetServer：受控远端 Runner Fleet 的服务端
 * （docs/remote-runner-wire.md、execution-runtime.md §5.1、hardening-v0.2-status.md
 * §3 RUN-REMOTE-01）。
 *
 * 服务端职责（与本地 runner 同路径，保证 lease/run_id/Manifest 跨 Local/Remote
 * 一致）：
 *
 * - 注册/心跳：写入 AgentRegistry（health/capability/labels），回应服务端是否
 *   认可该 target（acknowledged）；
 * - claim：从 kernel 按既有 claimJobs 路径拉取 Job（同一 lease owner/
 *   generation/token/run_id），固定并签名 ExecutionPlan，按 agent 的
 *   target_id + capability 匹配分发；**无匹配 target 的任务留在 pending
 *   （retryable，绝不静默改派到其它 target / LocalDocker）**；
 * - 离线判定（agent 断连）：outstanding claim 由服务端保留（有界 spool，
 *   maxPendingJobs/maxOutstandingPerAgent），agent 恢复后可继续；lease 过期后
 *   kernel 拒绝旧 agent 的 frames/finalize/complete（既有 fencing，409
 *   lease_stale）——服务端原样转发 kernel 结果，不产生合成成功；
 * - frames：复用 kernel terminal frame 语义（全局 seq 单调、gap/exit、
 *   retention 记账、owner/token 精确匹配）；
 * - artifacts：staged + finalize 两段——stage 声明 sha256/size，finalize 携带
 *   内容，服务端复算 sha256 比对（不一致 → 409 cas_hash_mismatch，不落库）；
 * - complete：携带签名的 run_manifest + fencing 字段，转发 kernel completeJob；
 * - CAS：按 artifact id/sha 从 kernel CAS 拉取，响应携带服务端复算的 sha256
 *   （代理端复算比对，不一致 → 拒绝执行）。
 *
 * HTTP 面（attachRemoteFleetRoutes）：POST/GET /v1/agents/*，生产必须 mTLS
 * service identity；本地 wire 用 `x-service-token` 等价实现（与 kernel 内部
 * 路由同一机制，见 docs/remote-runner-wire.md §3）。
 * @module @dsh-scholar/runner-gateway/remote-fleet-server
 */

import { createHash, randomUUID } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { ResearchClient } from '@dsh-scholar/research-client'
import {
  AgentHeartbeatRequest as AgentHeartbeatRequestSchema,
  AgentClaimRequest as AgentClaimRequestSchema,
  AgentRegisterRequest as AgentRegisterRequestSchema,
  buildExecutionPlan,
  computeProfileConfigHash,
  getRunnerProfile,
  isTargetAvailable,
  matchesTargetCapability,
  RemoteArtifactFinalizeRequest as RemoteArtifactFinalizeRequestSchema,
  RemoteArtifactStageRequest as RemoteArtifactStageRequestSchema,
  RemoteCompleteRequest as RemoteCompleteRequestSchema,
  RemoteFramesRequest as RemoteFramesRequestSchema,
  RemoteRunHeartbeatRequest as RemoteRunHeartbeatRequestSchema,
  signExecutionPlan,
  type AgentHeartbeatRequest,
  type AgentHeartbeatResponse,
  type AgentClaim,
  type AgentClaimRequest,
  type AgentClaimResponse,
  type AgentRegisterRequest,
  type AgentRegisterResponse,
  type CasFetchResponse,
  type ExecutionPlan,
  type JobRecord,
  type JobArtifactCreateInput,
  type PlanSigningKey,
  type RemoteAgentRegistration,
  type RemoteArtifactFinalizeRequest,
  type RemoteArtifactFinalizeResponse,
  type RemoteArtifactStageRequest,
  type RemoteArtifactStageResponse,
  type RemoteCompleteRequest,
  type RemoteCompleteResponse,
  type RemoteFramesRequest,
  type RemoteFramesResponse,
  type RemoteRunHeartbeatRequest,
  type RemoteRunHeartbeatResponse,
  type RemoteWireErrorEnvelope,
} from '@dsh-scholar/research-schemas'
import type { AgentRegistry } from './agent-registry.js'
import { appendTerminalFramesWithLease } from './kernel-client.js'
import { canonicalJson } from './manifest-signing.js'

// ── kernel client 面（远程 fleet 复用本地 runner 同一 kernel 路径）─────────

/**
 * RemoteFleetServer 对 kernel 的依赖面。ResearchClient 结构性满足本接口；
 * 测试注入 FakeFleetKernel。frames 上传与本地 runner 同路径
 * （appendTerminalFramesWithLease 的 owner/token 头语义）。
 */
export interface FleetKernelClient {
  heartbeatRunnerTarget(
    targetId: string,
    input: { expected_revision: number; health: 'online' | 'offline' },
    targetToken: string,
  ): Promise<unknown>
  claimJobs(
    owner: string,
    limit: number,
    leaseTtlSeconds?: number,
    targetFilter?: {
      runner_target_kinds?: Array<'local-process' | 'local-docker' | 'remote-ssh'>
      runner_target_ids?: string[]
      include_unpinned?: boolean
    },
  ): Promise<JobRecord[]>
  registerJobArtifact(jobId: string, input: JobArtifactCreateInput): Promise<{ artifact_id: string; sha256?: string }>
  completeJob(input: {
    job_id: string
    owner: string
    status: 'succeeded' | 'failed' | 'cancelled'
    run_manifest?: Record<string, unknown>
    failure_class?: string | null
    error?: string
    lease_generation?: number | null
    lease_token?: string | null
  }): Promise<JobRecord>
  heartbeatJob(jobId: string, owner: string, leaseGeneration?: number | null, leaseToken?: string | null): Promise<JobRecord>
  getJob(jobId: string): Promise<JobRecord>
  /** Authoritative target snapshot used again immediately before a remote
   * claim crosses the fleet boundary. Optional only for legacy test clients
   * whose pre-registry plans carry no target revision/hash pins. */
  getRunnerTarget?(targetId: string): Promise<{
    target_id: string
    kind: 'local-process' | 'local-docker' | 'remote-ssh'
    enabled: boolean
    draining: boolean
    revision: number
    config_hash: string
  }>
  /**
   * CAS 拉取：**字节流**（Buffer，绝不经过 UTF-8 text 编解码——二进制内容
   * 往返无损，hardening §5 RUN-REMOTE-01 / acceptance remote-cas-binary-auth）。
   * null = 404 缺失；其余错误（含 401 等鉴权失败）原样抛出（fail fast）。
   */
  fetchArtifactBytes(projectId: string, sha256OrId: string): Promise<{ content: Buffer; media_type: string | null } | null>
  /** frames 上传（owner/token 随请求携带，kernel 精确匹配；与本地 runner 同一路径）。 */
  appendTerminalFrames(
    jobId: string,
    runId: string,
    frames: Array<{
      seq: number
      stream_seq?: number | null
      channel?: 'stdout' | 'stderr' | null
      text?: string | null
      byte_offset?: number | null
      byte_length?: number | null
      frame_kind: 'chunk' | 'gap' | 'exit'
      payload_json?: string
      lease_generation?: number
    }>,
    owner: string,
    leaseToken: string | null,
    maxLogBytes?: number,
  ): Promise<{ appended: number; last_seq: number; truncated?: boolean; total_bytes?: number; dropped_bytes?: number }>
}

/** ResearchClient → FleetKernelClient 适配（frames 复用本地 runner 的 lease 头路径）。 */
export function createFleetKernelClient(client: ResearchClient): FleetKernelClient {
  return {
    // Never substitute the gateway's own identity for the connecting agent.
    heartbeatRunnerTarget: (targetId, input, token) => client.heartbeatRunnerTarget(targetId, input, token),
    claimJobs: (owner, limit, ttl, filter) => client.claimJobs(owner, limit, ttl, filter),
    registerJobArtifact: (jobId, input) => client.registerJobArtifact(jobId, input),
    completeJob: input => client.completeJob(input),
    heartbeatJob: (jobId, owner, gen, token) => client.heartbeatJob(jobId, owner, gen, token),
    getJob: jobId => client.getJob(jobId),
    getRunnerTarget: targetId => client.getRunnerTarget(targetId),
    fetchArtifactBytes: (projectId, sha) => client.fetchArtifactBytes(projectId, sha),
    appendTerminalFrames: (jobId, runId, frames, owner, token, maxLogBytes) =>
      appendTerminalFramesWithLease(client, jobId, runId, frames, owner, token, maxLogBytes),
  }
}

// ── 服务端错误面（HTTP 映射见 attachRemoteFleetRoutes）─────────────────────

/** fleet 服务端错误：status/code/retryable 与 wire 错误面一致。 */
export class FleetServerError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly retryable: boolean = false,
  ) {
    super(message)
    this.name = 'FleetServerError'
  }
}

/** wire 错误 envelope 构造（与 kernel errorEnvelope 同形状）。 */
export function fleetErrorEnvelope(error: unknown): RemoteWireErrorEnvelope {
  if (error instanceof FleetServerError) {
    return { code: error.code, message: error.message, retryable: error.retryable }
  }
  if (error instanceof Error && 'status' in error && 'code' in error) {
    const kernel = error as { status: number; code: string; message: string }
    return {
      code: kernel.code,
      message: kernel.message,
      retryable: kernel.status >= 500 || kernel.status === 429 || kernel.status === 409,
    }
  }
  return { code: 'internal', message: (error as Error).message ?? String(error), retryable: false }
}

/** kernel 错误 → FleetServerError（409 lease_stale 等 fencing 语义原样保留）。 */
export function mapKernelError(error: unknown): FleetServerError {
  if (error instanceof FleetServerError) return error
  if (error instanceof Error && 'status' in error && 'code' in error) {
    const kernel = error as { status: number; code: string; message: string }
    const retryable = kernel.status >= 500 || kernel.status === 429 || kernel.status === 409
    return new FleetServerError(kernel.status, kernel.code, kernel.message, retryable)
  }
  return new FleetServerError(502, 'kernel_unreachable', (error as Error).message ?? String(error), true)
}

// ── 服务端状态 ─────────────────────────────────────────────────────────────

/** 从 kernel claim 到但尚未分发给 agent 的任务（服务端有界 spool 的前端）。 */
interface PendingJob {
  claim_id: string
  job: JobRecord & { run_id?: string | null }
  plan: ExecutionPlan
  target_id: string
  claimed_at: string
}

/** 已分发（outstanding）的任务：agent 断连期间由服务端保留，恢复后可继续。 */
interface OutstandingClaim {
  claim_id: string
  agent_id: string
  job: JobRecord & { run_id?: string | null }
  plan: ExecutionPlan
  claimed_at: string
  /** lease 过期/协议拒绝后置 settled：旧 agent 的后续写入一律 409。 */
  settled: boolean
  settled_code: string | null
  /** Mutable lease observation, kept outside the signed immutable plan. */
  lease_expires_at: string | null
  settled_at?: number
  completion?: { request_hash: string; response: RemoteCompleteResponse }
}

/** staged artifact（finalize 前只持有 hash/size 声明）。 */
interface PendingStage {
  stage_id: string
  run_id: string
  project_id: string
  sha256: string
  size: number
  kind: RemoteArtifactStageRequest['kind']
  media_type: string | null
  file_name: string | null
  metadata: Record<string, unknown>
  created_at: string
  finalizing?: Promise<RemoteArtifactFinalizeResponse>
}

export interface RemoteFleetServerOptions {
  registry: AgentRegistry
  client: FleetKernelClient
  /** fleet 从 kernel claim 时使用的 lease owner（与本地 runner 同一身份面）。 */
  owner: string
  leaseTtlSeconds?: number
  timeoutMs?: number
  /** 固定并签名 plan（Ed25519）；未提供时 plan 不带签名（接口层允许，生产必须提供）。 */
  signingKey?: PlanSigningKey
  offlineAfterMs?: number
  /** 服务端保留的 pending 任务上限（有界 spool）。 */
  maxPendingJobs?: number
  /** 单个 agent 同时 outstanding 的 claim 上限。 */
  maxOutstandingPerAgent?: number
  /** stage 上限（finalize 前）。 */
  maxStages?: number
  /** finalize 内容上限（默认 32 MiB，与 UPLOAD-01 同一量级）。 */
  maxFinalizeBytes?: number
  /** Each receipt cache is bounded by both count and age; contains no bytes. */
  maxReceipts?: number
  receiptTtlMs?: number
  /** 从 Job 解析绑定的 target_id；默认取 payload.target_id（缺省 local-docker）。 */
  /** 显式时钟（测试确定性）。 */
  now?: () => number
}

export interface RemoteFleetServerStats {
  pending: number
  outstanding: number
  stages: number
  settled_receipts: number
  artifact_receipts: number
}

/**
 * RemoteFleetServer：接受注册/心跳/claim/frames/artifacts/complete/CAS，
 * 调用 kernel client 完成与本地 runner 同路径的 claim/frames/artifact/complete。
 */
export class RemoteFleetServer {
  readonly registry: AgentRegistry
  readonly owner: string
  private readonly client: FleetKernelClient
  private readonly leaseTtlSeconds: number
  private readonly timeoutMs: number
  private readonly signingKey: PlanSigningKey | undefined
  private readonly offlineAfterMs: number
  private readonly maxPendingJobs: number
  private readonly maxOutstandingPerAgent: number
  private readonly maxStages: number
  private readonly maxFinalizeBytes: number
  private readonly maxReceipts: number
  private readonly receiptTtlMs: number
  private readonly now: () => number

  /** 已 claim 但未分发的任务（FIFO）。 */
  private readonly pending: PendingJob[] = []
  /** 已分发任务：agent_id → run_id → claim。 */
  private readonly outstanding = new Map<string, Map<string, OutstandingClaim>>()
  private readonly stages = new Map<string, PendingStage>()
  /** Only live attempts are deduplicated. Kernel owns job-level retries. */
  private readonly claimedAttempts = new Set<string>()
  private readonly settledClaims = new Map<string, OutstandingClaim>()
  private readonly finalizedStages = new Map<string, { stage: PendingStage; response: RemoteArtifactFinalizeResponse; at: number }>()
  private pumping: Promise<number> | null = null
  private readonly agentIdentities = new Map<string, string>()

  constructor(options: RemoteFleetServerOptions) {
    this.registry = options.registry
    this.client = options.client
    this.owner = options.owner
    this.leaseTtlSeconds = options.leaseTtlSeconds ?? 300
    this.timeoutMs = options.timeoutMs ?? 60_000
    this.signingKey = options.signingKey
    this.offlineAfterMs = options.offlineAfterMs ?? 30_000
    this.maxPendingJobs = options.maxPendingJobs ?? 32
    this.maxOutstandingPerAgent = options.maxOutstandingPerAgent ?? 8
    this.maxStages = options.maxStages ?? 64
    this.maxFinalizeBytes = options.maxFinalizeBytes ?? 32 * 1024 * 1024
    this.maxReceipts = options.maxReceipts ?? 1024
    this.receiptTtlMs = options.receiptTtlMs ?? 15 * 60_000
    this.now = options.now ?? (() => Date.now())
  }

  stats(): RemoteFleetServerStats {
    this.pruneExpiredState()
    let outstanding = 0
    for (const byRun of this.outstanding.values()) outstanding += byRun.size
    return {
      pending: this.pending.length, outstanding, stages: this.stages.size,
      settled_receipts: this.settledClaims.size, artifact_receipts: this.finalizedStages.size,
    }
  }

  // ── 注册 / 心跳 ──────────────────────────────────────────────────────────

  /** POST /v1/agents/register */
  async handleRegister(req: AgentRegisterRequest, targetToken = ''): Promise<AgentRegisterResponse> {
    const parsed = validateWire<AgentRegisterRequest>(AgentRegisterRequestSchema, req, 'AgentRegisterRequest')
    const current = this.registry.get(parsed.agent_id)
    if (current !== undefined && current.target_id !== parsed.target_id) {
      throw new FleetServerError(409, 'agent_target_conflict', 'agent id is already bound to a different target', false)
    }
    await this.observeTarget(parsed, targetToken)
    // Kernel authentication yields. Another Target may have registered this
    // Agent meanwhile; recheck the binding before publishing any local state.
    const verifiedCurrent = this.registry.get(parsed.agent_id)
    if (verifiedCurrent !== undefined && verifiedCurrent.target_id !== parsed.target_id) {
      throw new FleetServerError(409, 'agent_target_conflict', 'agent id is already bound to a different target', false)
    }
    this.registry.register({ ...parsed, health: { ...parsed.health, last_seen: new Date(this.now()).toISOString() } })
    this.agentIdentities.set(parsed.agent_id, createHash('sha256').update(targetToken).digest('hex'))
    return {
      schema_version: 1,
      acknowledged: true,
      target_id: req.target_id,
      agent_id: req.agent_id,
      offline_after_ms: this.offlineAfterMs,
    }
  }

  /** POST /v1/agents/{agent_id}/heartbeat —— 未注册 agent → 404（fail closed）。 */
  async handleHeartbeat(agentId: string, req: AgentHeartbeatRequest, targetToken = ''): Promise<AgentHeartbeatResponse> {
    const parsed = validateWire<AgentHeartbeatRequest>(AgentHeartbeatRequestSchema, req, 'AgentHeartbeatRequest')
    const current = this.registry.get(agentId)
    if (current === undefined) {
      throw new FleetServerError(404, 'agent_not_registered', `agent ${agentId} is not registered — register first`, true)
    }
    const registration: RemoteAgentRegistration = {
      ...current,
      capabilities: parsed.capabilities ?? current.capabilities,
      labels: parsed.labels ?? current.labels,
      health: { status: parsed.status ?? current.health.status, last_seen: new Date(this.now()).toISOString() },
    }
    await this.observeTarget(registration, targetToken)
    this.registry.register(registration)
    return {
      schema_version: 1,
      acknowledged: true,
      accepted: true,
      target_id: registration.target_id,
      offline_after_ms: this.offlineAfterMs,
    }
  }

  private async observeTarget(registration: RemoteAgentRegistration, token: string): Promise<void> {
    try {
      const target = await this.client.getRunnerTarget?.(registration.target_id)
      if (target === undefined || target.kind !== 'remote-ssh') {
        throw new FleetServerError(409, 'runner_target_kind_mismatch', 'remote agent requires a registered remote-ssh target', false)
      }
      await this.client.heartbeatRunnerTarget(target.target_id, {
        expected_revision: target.revision,
        health: registration.health.status === 'online' ? 'online' : 'offline',
      }, token)
    } catch (error) { throw mapKernelError(error) }
  }

  /** HTTP identity binding is established only after Kernel verifies the
   * target credential. A shared fleet service token cannot impersonate it. */
  authorizeAgent(agentId: string, targetToken: string): void {
    const identity = this.agentIdentities.get(agentId)
    if (identity !== undefined && identity !== createHash('sha256').update(targetToken).digest('hex')) {
      throw new FleetServerError(403, 'runner_target_identity_required', 'agent route requires its registered target identity', false)
    }
  }

  // ── claim ────────────────────────────────────────────────────────────────

  /**
   * POST /v1/agents/{agent_id}/claims。顺序：
   * 1. resume——agent 已有 outstanding 的 claim（断连恢复场景）原样返回；
   * 2. fresh——从 pending 匹配（target_id 精确 + capability）分发；
   * 3. pump——pending 不足时从 kernel 拉取（有界 maxPendingJobs），再匹配。
   * 无匹配 → 空 claims（正常轮询）；任务留在 pending（retryable，不静默改派）。
   */
  async handleClaims(agentId: string, req: AgentClaimRequest): Promise<AgentClaimResponse> {
    this.pruneExpiredState()
    const parsed = validateWire<AgentClaimRequest>(AgentClaimRequestSchema, req, 'AgentClaimRequest')
    const registration = this.registry.get(agentId)
    if (registration === undefined) {
      throw new FleetServerError(404, 'agent_not_registered', `agent ${agentId} is not registered — register first`, true)
    }
    if (!isTargetAvailable(registration, this.now(), this.offlineAfterMs)) {
      throw new FleetServerError(409, 'agent_offline', `agent ${agentId} is offline (last_seen stale) — claim rejected`, true)
    }
    const limit = parsed.limit ?? 1
    const claims: AgentClaim[] = []

    // 1) resume：服务端保留的 outstanding（settled 的不再返回）。
    const mine = this.outstanding.get(agentId)
    if (mine !== undefined) {
      for (const claim of mine.values()) {
        if (claim.settled) continue
        if (claims.length >= limit) break
        claims.push(this.toAgentClaim(claim))
      }
    }

    // 2) fresh：pending 匹配分发（有界）。
    const outstandingCount = mine?.size ?? 0
    if (claims.length < limit && outstandingCount < this.maxOutstandingPerAgent) {
      const room = Math.min(limit - claims.length, this.maxOutstandingPerAgent - outstandingCount)
      const matched = this.matchFromPending(agentId, registration, room)
      for (const claim of matched) claims.push(this.toAgentClaim(claim))
    }

    // 3) lazy pump：仍有容量且 pending 不足时从 kernel 拉取后再匹配一次。
    if (claims.length < limit && (this.outstanding.get(agentId)?.size ?? 0) < this.maxOutstandingPerAgent
      && this.pending.length < this.maxPendingJobs) {
      await this.pump(Math.max(1, Math.min(limit, this.maxPendingJobs - this.pending.length)))
      const room = Math.min(
        limit - claims.length,
        this.maxOutstandingPerAgent - (this.outstanding.get(agentId)?.size ?? 0),
      )
      const matched = this.matchFromPending(agentId, registration, Math.max(0, room))
      for (const claim of matched) claims.push(this.toAgentClaim(claim))
    }
    return { schema_version: 1, claims: await this.filterCurrentTargetClaims(agentId, claims) }
  }

  /** Last-moment registry fence for remote dispatch. A plan may have been
   * claimed while its target was enabled and then sit pending/outstanding;
   * never hand it to an agent after the target is drained or revised. */
  private async filterCurrentTargetClaims(agentId: string, claims: AgentClaim[]): Promise<AgentClaim[]> {
    const accepted: AgentClaim[] = []
    for (const claim of claims) {
      const plan = claim.plan
      let reason: string | null = null
      if (this.client.getRunnerTarget === undefined) {
        reason = `remote plan ${plan.plan_id} cannot revalidate target ${plan.target_id}`
      } else {
        try {
          const target = await this.client.getRunnerTarget(plan.target_id)
          if (!target.enabled || target.draining) {
            reason = `runner target ${plan.target_id} is ${target.draining ? 'draining' : 'disabled'} before remote dispatch`
          } else if (target.target_id !== plan.target_id || target.kind !== 'remote-ssh'
            || target.kind !== plan.target_kind || target.revision !== plan.target_revision
            || target.config_hash !== plan.target_config_hash) {
            reason = `runner target ${plan.target_id} changed after claim; remote dispatch pin is stale`
          }
        } catch (error) {
          const mapped = mapKernelError(error)
          if (mapped.status >= 500 || mapped.status === 429) throw mapped
          reason = `runner target ${plan.target_id} could not be revalidated before remote dispatch: ${(error as Error).message ?? String(error)}`
        }
      }
      if (reason === null) {
        accepted.push(claim)
        continue
      }
      const outstanding = this.requireOutstanding(agentId, plan.run_id)
      try {
        await this.client.completeJob({
          job_id: outstanding.job.job_id,
          owner: plan.lease.owner,
          status: 'failed',
          failure_class: 'environment',
          error: reason,
          lease_generation: plan.lease.generation,
          lease_token: plan.lease.token,
        })
        this.settle(outstanding, 'runner_target_stale')
      } catch (error) {
        const mapped = mapKernelError(error)
        if (mapped.status === 409) this.settle(outstanding, mapped.code)
        else throw mapped
      }
    }
    return accepted
  }

  /** 从 pending 匹配（target_id 精确 + capability）并登记 outstanding，返回分发结果。 */
  private matchFromPending(
    agentId: string,
    registration: RemoteAgentRegistration,
    room: number,
  ): OutstandingClaim[] {
    if (room <= 0) return []
    const matched: OutstandingClaim[] = []
    for (let i = 0; i < this.pending.length && matched.length < room;) {
      const candidate = this.pending[i]
      if (candidate === undefined) break
      if (candidate.target_id === registration.target_id && matchesTargetCapability(candidate.plan, registration)) {
        this.pending.splice(i, 1)
        const claim: OutstandingClaim = {
          claim_id: candidate.claim_id,
          agent_id: agentId,
          job: candidate.job,
          plan: candidate.plan,
          claimed_at: candidate.claimed_at,
          settled: false,
          settled_code: null,
          lease_expires_at: candidate.plan.lease.expires_at,
        }
        matched.push(claim)
        this.assign(claim)
      } else {
        i += 1
      }
    }
    return matched
  }

  /**
   * 从 kernel 按既有 claimJobs 路径拉取任务（同一 lease 语义），固定并签名
   * ExecutionPlan，进入 pending（有界）。返回新增数量。
   */
  async pump(limit = 4): Promise<number> {
    if (this.pumping !== null) return this.pumping
    this.pumping = this.pumpOnce(limit)
    try { return await this.pumping } finally { this.pumping = null }
  }

  private async pumpOnce(limit: number): Promise<number> {
    this.pruneExpiredState()
    const room = Math.min(limit, this.maxPendingJobs - this.pending.length)
    if (room <= 0) return 0
    let jobs: JobRecord[]
    try {
      // A fleet server only leases remote targets. Local process/Docker jobs
      // stay available for the corresponding local runner loop; unpinned
      // jobs are excluded from remote dispatch.
      jobs = await this.client.claimJobs(this.owner, room, this.leaseTtlSeconds, {
        runner_target_kinds: ['remote-ssh'],
        include_unpinned: false,
      })
    } catch (error) {
      throw mapKernelError(error)
    }
    let added = 0
    for (const job of jobs) {
      if (this.claimedAttempts.has(this.attemptKey(job))) continue
      let plan: ExecutionPlan
      try {
        plan = this.buildPlan(job)
      } catch (error) {
        const mapped = mapKernelError(error)
        try {
          await this.client.completeJob({
            job_id: job.job_id,
            owner: this.owner,
            status: 'failed',
            failure_class: 'environment',
            error: `remote execution plan rejected before dispatch: ${mapped.message}`,
            lease_generation: job.lease_generation,
            lease_token: job.lease_token,
          })
        } catch (completeError) {
          throw mapKernelError(completeError)
        }
        continue
      }
      this.claimedAttempts.add(this.attemptKey(job))
      this.pending.push({
        claim_id: `clm_${randomUUID().replaceAll('-', '').slice(0, 12)}`,
        job,
        plan,
        target_id: plan.target_id,
        claimed_at: new Date(this.now()).toISOString(),
      })
      added += 1
    }
    return added
  }

  // ── frames（复用 kernel terminal frame 语义）─────────────────────────────

  async handleRunHeartbeat(agentId: string, runId: string, req: RemoteRunHeartbeatRequest): Promise<RemoteRunHeartbeatResponse> {
    const parsed = validateWire<RemoteRunHeartbeatRequest>(RemoteRunHeartbeatRequestSchema, req, 'RemoteRunHeartbeatRequest')
    const claim = this.requireOutstanding(agentId, runId)
    this.assertClaimFence(claim, parsed)
    if (claim.settled) {
      if (claim.settled_code === 'job_cancelled') return { schema_version: 1, run_id: runId, status: 'cancelled', lease_expires_at: null }
      throw new FleetServerError(409, 'lease_stale', 'run is no longer active', false)
    }
    try {
      const current = await this.client.getJob(claim.job.job_id)
      if (current.status === 'cancelled' && current.lease_generation === claim.plan.lease.generation) {
        this.settle(claim, 'job_cancelled')
        return { schema_version: 1, run_id: runId, status: 'cancelled', lease_expires_at: null }
      }
      this.assertCurrentAttempt(claim, current)
      const renewed = await this.client.heartbeatJob(claim.job.job_id, parsed.lease.owner, parsed.lease.generation, parsed.lease.token)
      this.assertCurrentAttempt(claim, renewed)
      claim.lease_expires_at = renewed.lease_expires_at
      return { schema_version: 1, run_id: runId, status: 'running', lease_expires_at: renewed.lease_expires_at }
    } catch (error) {
      const mapped = mapKernelError(error)
      if (mapped.status === 409) this.settle(claim, 'lease_stale')
      throw mapped
    }
  }

  private assertClaimFence(claim: OutstandingClaim, request: RemoteRunHeartbeatRequest): void {
    if (request.claim_id !== claim.claim_id || request.job_id !== claim.job.job_id
      || request.lease.owner !== claim.plan.lease.owner || request.lease.generation !== claim.plan.lease.generation
      || request.lease.token !== claim.plan.lease.token) {
      throw new FleetServerError(409, 'lease_stale', 'request does not match the claimed attempt', false)
    }
  }

  private assertCurrentAttempt(claim: OutstandingClaim, job: JobRecord & { run_id?: string | null }): void {
    if (job.status !== 'running' || job.run_id !== claim.plan.run_id
      || job.lease_owner !== claim.plan.lease.owner || job.lease_generation !== claim.plan.lease.generation
      || job.lease_expires_at === null || Date.parse(job.lease_expires_at) <= this.now()) {
      throw new FleetServerError(409, 'lease_stale', 'Kernel no longer owns this active attempt', false)
    }
  }

  /** POST /v1/agents/{agent_id}/runs/{run_id}/frames */
  async handleFrames(agentId: string, runId: string, req: RemoteFramesRequest): Promise<RemoteFramesResponse> {
    const parsed = validateWire<RemoteFramesRequest>(RemoteFramesRequestSchema, req, 'RemoteFramesRequest')
    const claim = this.requireOutstanding(agentId, runId)
    if (claim.settled) {
      throw new FleetServerError(409, claim.settled_code ?? 'lease_stale',
        `run ${runId} was settled (${claim.settled_code ?? 'lease_stale'}) — frames from a stale agent are rejected`, true)
    }
    if (req.owner !== claim.plan.lease.owner || req.lease_token !== claim.plan.lease.token) {
      throw new FleetServerError(409, 'lease_stale',
        `run ${runId} frames lease mismatch: expected owner ${claim.plan.lease.owner} token ${claim.plan.lease.token}, got owner ${req.owner} token ${req.lease_token}`, true)
    }
    try {
      const result = await this.client.appendTerminalFrames(
        claim.job.job_id, runId, parsed.frames, parsed.owner, parsed.lease_token, parsed.max_log_bytes,
      )
      return {
        schema_version: 1,
        appended: result.appended,
        last_seq: result.last_seq,
        truncated: result.truncated ?? false,
        total_bytes: result.total_bytes ?? 0,
        dropped_bytes: result.dropped_bytes ?? 0,
      }
    } catch (error) {
      const mapped = mapKernelError(error)
      if (mapped.code === 'lease_stale') this.settle(claim, 'lease_stale')
      throw mapped
    }
  }

  // ── artifacts（staged + finalize + sha256）───────────────────────────────

  /** POST /v1/agents/{agent_id}/runs/{run_id}/artifacts（stage 分支）。 */
  handleStageArtifact(agentId: string, runId: string, req: RemoteArtifactStageRequest): RemoteArtifactStageResponse {
    const parsed = validateWire<RemoteArtifactStageRequest>(RemoteArtifactStageRequestSchema, req, 'RemoteArtifactStageRequest')
    if (parsed.run_id !== runId) {
      throw new FleetServerError(422, 'run_id_mismatch',
        `stage run_id ${parsed.run_id} does not match the claim's run_id ${runId}`, false)
    }
    const claim = this.requireOutstanding(agentId, runId)
    if (claim.settled) {
      throw new FleetServerError(409, claim.settled_code ?? 'lease_stale',
        `run ${runId} was settled — artifact staging from a stale agent is rejected`, true)
    }
    const stageId = parsed.stage_id ?? `stg_${randomUUID().replaceAll('-', '').slice(0, 12)}`
    const next: PendingStage = {
      stage_id: stageId,
      run_id: runId,
      project_id: claim.job.project_id,
      sha256: parsed.sha256,
      size: parsed.size,
      kind: parsed.kind,
      media_type: parsed.media_type ?? null,
      file_name: parsed.file_name ?? null,
      metadata: parsed.metadata ?? {},
      created_at: new Date(this.now()).toISOString(),
    }
    const previous = this.stages.get(stageId) ?? this.finalizedStages.get(stageId)?.stage
    if (previous !== undefined) {
      const declaration = ({ created_at: _created, finalizing: _finalizing, ...value }: PendingStage) => canonicalJson(value)
      if (declaration(previous) !== declaration(next)) {
        throw new FleetServerError(409, 'stage_conflict', 'stage id is already bound to a different artifact declaration', false)
      }
      return { schema_version: 1, stage_id: stageId }
    }
    if (this.stages.size >= this.maxStages) {
      throw new FleetServerError(409, 'stage_capacity', `stage table is full (${this.maxStages}) — finalize pending stages first`, true)
    }
    this.stages.set(stageId, next)
    return { schema_version: 1, stage_id: stageId }
  }

  /** POST /v1/agents/{agent_id}/runs/{run_id}/artifacts（finalize 分支）。 */
  async handleFinalizeArtifact(agentId: string, runId: string, req: RemoteArtifactFinalizeRequest): Promise<RemoteArtifactFinalizeResponse> {
    const parsed = validateWire<RemoteArtifactFinalizeRequest>(RemoteArtifactFinalizeRequestSchema, req, 'RemoteArtifactFinalizeRequest')
    if (parsed.run_id !== runId) {
      throw new FleetServerError(422, 'run_id_mismatch',
        `finalize run_id ${parsed.run_id} does not match the claim's run_id ${runId}`, false)
    }
    const claim = this.requireOutstanding(agentId, runId)
    if (claim.settled) {
      throw new FleetServerError(409, claim.settled_code ?? 'lease_stale',
        `run ${runId} was settled — artifact finalize from a stale agent is rejected`, true)
    }
    const receipt = this.finalizedStages.get(parsed.stage_id)
    const stage = this.stages.get(parsed.stage_id) ?? receipt?.stage
    if (stage === undefined || stage.run_id !== runId) {
      throw new FleetServerError(404, 'stage_unknown', `stage ${parsed.stage_id} is unknown for run ${runId}`, false)
    }
    if (parsed.content_base64.length > this.maxFinalizeBytes * 2) {
      throw new FleetServerError(413, 'payload_too_large', `finalize content exceeds ${this.maxFinalizeBytes} bytes`, false)
    }
    const buf = Buffer.from(parsed.content_base64, 'base64')
    if (buf.length > this.maxFinalizeBytes) {
      throw new FleetServerError(413, 'payload_too_large', `finalize content exceeds ${this.maxFinalizeBytes} bytes`, false)
    }
    // 复算 sha256 并与 stage 声明比对——不一致拒绝（内容寻址完整性，不落库）。
    const actual = createHash('sha256').update(buf).digest('hex')
    if (actual !== stage.sha256) {
      throw new FleetServerError(409, 'cas_hash_mismatch',
        `finalize sha256 mismatch for stage ${parsed.stage_id}: got ${actual}, stage declared ${stage.sha256}`, false)
    }
    if (buf.length !== stage.size) {
      throw new FleetServerError(409, 'cas_size_mismatch',
        `finalize size mismatch for stage ${parsed.stage_id}: got ${buf.length}, stage declared ${stage.size}`, false)
    }
    if (receipt !== undefined) return { ...receipt.response, reused: true }
    if (stage.finalizing !== undefined) return stage.finalizing
    // Keep the declaration on upstream failure. Coalesce simultaneous retries
    // and retain a bounded receipt if the successful HTTP response is lost.
    stage.finalizing = (async (): Promise<RemoteArtifactFinalizeResponse> => {
      try {
        const record = await this.client.registerJobArtifact(claim.job.job_id, {
          project_id: claim.job.project_id,
          run_id: runId,
          owner: claim.plan.lease.owner,
          lease_generation: claim.plan.lease.generation,
          lease_token: claim.plan.lease.token,
          kind: stage.kind,
          content_base64: parsed.content_base64,
          metadata: { ...stage.metadata, run_id: runId, job_id: claim.job.job_id, source: 'remote-agent' },
          ...stage.media_type !== null ? { media_type: stage.media_type } : {},
          ...stage.file_name !== null ? { file_name: stage.file_name } : {},
        })
        const response: RemoteArtifactFinalizeResponse = {
          schema_version: 1, artifact_id: record.artifact_id, sha256: record.sha256 ?? actual, reused: false,
        }
        this.stages.delete(parsed.stage_id)
        const { finalizing: _finalizing, ...declaration } = stage
        this.finalizedStages.set(parsed.stage_id, { stage: declaration, response, at: this.now() })
        this.pruneReceipts()
        return response
      } catch (error) {
        throw mapKernelError(error)
      } finally {
        delete stage.finalizing
      }
    })()
    return stage.finalizing
  }

  // ── complete（manifest 签名 + fencing）───────────────────────────────────

  /**
   * POST /v1/agents/{agent_id}/runs/{run_id}/complete。
   * 转发 kernel completeJob（run_manifest 签名由 kernel 按 §12.7 验签；
   * generation/token 由 kernel 精确匹配）。lease 过期后旧 agent 的 complete
   * 被 kernel 拒绝（409 lease_stale）→ 本方法抛 FleetServerError(409)，
   * 该 claim 置 settled——旧 agent 只能丢弃或保留本地诊断，不能完成 Job。
   *
   * **run_id 全链绑定**（hardening §5 两行 / acceptance remote-identity-
   * fencing-manifest）：complete 顶层 run_id 必须与 claim 的 plan.run_id
   * 一致（旧 attempt 的 complete → 422 run_id_mismatch）；run_manifest 的
   * run_id 同样必须一致（kernel 侧再按 runs 行校验）。
   */
  async handleComplete(agentId: string, runId: string, req: RemoteCompleteRequest): Promise<RemoteCompleteResponse> {
    const parsed = validateWire<RemoteCompleteRequest>(RemoteCompleteRequestSchema, req, 'RemoteCompleteRequest')
    const claim = this.requireOutstanding(agentId, runId)
    if (parsed.run_id !== claim.plan.run_id) {
      throw new FleetServerError(422, 'run_id_mismatch',
        `complete run_id ${parsed.run_id} does not match the claim's run_id ${claim.plan.run_id} — job/run/manifest run_id chain broken`, false)
    }
    const manifestRunId = (parsed.run_manifest as Record<string, unknown> | undefined)?.run_id
    if (manifestRunId !== undefined && manifestRunId !== claim.plan.run_id) {
      throw new FleetServerError(422, 'run_id_mismatch',
        `run manifest run_id ${String(manifestRunId)} does not match the claim's run_id ${claim.plan.run_id} — job/run/manifest run_id chain broken`, false)
    }
    this.assertClaimFence(claim, parsed)
    const requestHash = createHash('sha256').update(canonicalJson(parsed)).digest('hex')
    if (claim.settled) {
      if (claim.completion?.request_hash === requestHash) return claim.completion.response
      throw new FleetServerError(409, claim.settled_code ?? 'lease_stale', 'run is already settled', false)
    }
    try {
      const completed = await this.client.completeJob({
        job_id: claim.job.job_id,
        owner: parsed.lease.owner,
        status: parsed.status,
        run_manifest: parsed.run_manifest,
        failure_class: parsed.failure_class ?? null,
        error: parsed.error ?? undefined,
        lease_generation: parsed.lease.generation,
        lease_token: parsed.lease.token,
      })
      const finalStatus: 'succeeded' | 'failed' | 'cancelled' =
        completed.status === 'succeeded' || completed.status === 'failed' || completed.status === 'cancelled'
          ? completed.status
          : 'failed'
      const response: RemoteCompleteResponse = { schema_version: 1, accepted: true, job_id: completed.job_id, status: finalStatus, code: null }
      claim.completion = { request_hash: requestHash, response }
      this.settle(claim, null)
      return response
    } catch (error) {
      const mapped = mapKernelError(error)
      if (mapped.code === 'lease_stale' || mapped.status === 409) this.settle(claim, mapped.code)
      throw mapped
    }
  }

  // ── CAS ──────────────────────────────────────────────────────────────────

  /**
   * GET /v1/agents/{agent_id}/cas/{sha}?project_id=
   * - project binding：agent 必须持有该 project 的 outstanding claim——
   *   caller 声明 project_id 不能越过 claim 所属项目（acceptance
   *   remote-cas-binary-auth；未绑定 → 403 cas_project_forbidden）；
   * - 字节流：CAS 内容以 Buffer 传递（kernel 原生字节 → base64），不经过
   *   UTF-8 text 编解码——随机二进制/PDF/压缩包/NUL 往返 hash/size 一致；
   * - kernel 鉴权失败（401）原样抛出（fail fast，不静默当 cas_missing）。
   */
  async handleCas(agentId: string, sha: string, projectId: string): Promise<CasFetchResponse> {
    if (this.registry.get(agentId) === undefined) {
      throw new FleetServerError(404, 'agent_not_registered', `agent ${agentId} is not registered`, true)
    }
    if (projectId === '') {
      throw new FleetServerError(422, 'missing_project_id', 'cas fetch requires ?project_id=', false)
    }
    // §5 两行 / acceptance remote-cas-binary-auth：caller 声明的 project_id
    // 必须落在该 agent 的 claim 绑定内（agent 只应拉取自己 claim 的 run 的
    // 输入；settled 的旧 claim 不再放行）。
    const byRun = this.outstanding.get(agentId)
    const bound = byRun !== undefined
      && [...byRun.values()].some(c => !c.settled && c.plan.project_id === projectId)
    if (!bound) {
      throw new FleetServerError(403, 'cas_project_forbidden',
        `agent ${agentId} has no outstanding claim in project ${projectId} — cas fetch cannot escape the claimed project`, false)
    }
    let fetched: { content: Buffer; media_type: string | null } | null
    try {
      fetched = await this.client.fetchArtifactBytes(projectId, sha)
    } catch (error) {
      throw mapKernelError(error)
    }
    if (fetched === null) {
      throw new FleetServerError(404, 'cas_missing', `artifact ${sha} not found in project ${projectId}`, true)
    }
    return {
      sha256: createHash('sha256').update(fetched.content).digest('hex'),
      content_base64: fetched.content.toString('base64'),
      ...fetched.media_type !== null && fetched.media_type !== '' ? { media_type: fetched.media_type } : {},
    }
  }

  // ── 内部 ─────────────────────────────────────────────────────────────────

  private buildPlan(job: JobRecord & { run_id?: string | null }): ExecutionPlan {
    if (typeof job.run_id !== 'string' || job.run_id === '') {
      throw new FleetServerError(422, 'run_id_missing', `job ${job.job_id} is missing the Kernel claim run_id`, false)
    }
    const runId = job.run_id
    if (typeof job.lease_generation !== 'number' || job.lease_generation < 1
      || typeof job.lease_token !== 'string' || job.lease_token === '') {
      throw new FleetServerError(422, 'lease_fence_missing',
        `job ${job.job_id} is missing its current lease generation/token`, false)
    }
    const leaseGeneration = job.lease_generation
    const leaseToken = job.lease_token
    const payload = job.payload as Record<string, unknown> | undefined
    const targetId = typeof payload?.runner_target_id === 'string' && payload.runner_target_id !== ''
      ? payload.runner_target_id
      : null
    if (targetId === null) {
      throw new FleetServerError(422, 'runner_target_pin_missing',
        `job ${job.job_id} is missing runner_target_id`, false)
    }
    if (typeof payload?.image_digest !== 'string' || payload.image_digest === '') {
      throw new FleetServerError(422, 'image_digest_missing', `job ${job.job_id} is missing its digest-pinned image`, false)
    }
    // domain-model.md §9.1: secure jobs 固定 opaque profile id + config hash。
    // 服务端按注册表复算校验——未知 id / hash 不一致 → retryable 环境错误
    // （任务留在 pending，绝不带病分发到远端 target）。
    const payloadProfileId = typeof payload?.runner_profile_id === 'string' && payload.runner_profile_id !== ''
      ? payload.runner_profile_id
      : null
    if (payloadProfileId !== null) {
      const pinnedHash = typeof payload?.profile_config_hash === 'string' && payload.profile_config_hash !== ''
        ? payload.profile_config_hash
        : null
      const candidate = getRunnerProfile(payloadProfileId)
      if (candidate === null) {
        throw new FleetServerError(422, 'runner_profile_unknown',
          `job ${job.job_id} pins unknown runner profile ${JSON.stringify(payloadProfileId)} (domain-model.md §9.1)`, true)
      }
      const computed = computeProfileConfigHash(candidate)
      if (pinnedHash === null || computed !== pinnedHash) {
        throw new FleetServerError(409, 'profile_config_hash_mismatch',
          `job ${job.job_id} profile config hash mismatch: job pins ${pinnedHash ?? '(none)'}, registry computes ${computed} (domain-model.md §9.1)`, true)
      }
    } else {
      throw new FleetServerError(422, 'runner_profile_missing',
        `job ${job.job_id} is missing its current runner profile pin`, false)
    }
    const plan = buildExecutionPlan(job, {
      run_id: runId,
      lease: {
        owner: this.owner,
        generation: leaseGeneration,
        token: leaseToken,
        expires_at: job.lease_expires_at,
      },
      timeout_ms: this.timeoutMs,
    })
    // plan 由 fleet 服务端固定并签名；未配置签名密钥时保持未签名（生产必须配置）。
    return this.signingKey !== undefined ? signExecutionPlan(plan, this.signingKey) : plan
  }

  private toAgentClaim(claim: OutstandingClaim): AgentClaim {
    return {
      claim_id: claim.claim_id,
      plan: claim.plan,
      lease: {
        owner: claim.plan.lease.owner,
        generation: claim.plan.lease.generation,
        token: claim.plan.lease.token,
        expires_at: claim.lease_expires_at,
      },
      claimed_at: claim.claimed_at,
    }
  }

  private assign(claim: OutstandingClaim): void {
    let byRun = this.outstanding.get(claim.agent_id)
    if (byRun === undefined) {
      byRun = new Map()
      this.outstanding.set(claim.agent_id, byRun)
    }
    byRun.set(claim.plan.run_id, claim)
  }

  private requireOutstanding(agentId: string, runId: string): OutstandingClaim {
    this.pruneExpiredState()
    const claim = this.outstanding.get(agentId)?.get(runId) ?? this.settledClaims.get(runId)
    if (claim === undefined || claim.agent_id !== agentId) {
      throw new FleetServerError(404, 'claim_unknown', `no outstanding claim for agent ${agentId} run ${runId}`, true)
    }
    return claim
  }

  private settle(claim: OutstandingClaim, code: string | null): void {
    if (claim.settled) return
    claim.settled = true
    claim.settled_code = code
    claim.settled_at = this.now()
    const mine = this.outstanding.get(claim.agent_id)
    mine?.delete(claim.plan.run_id)
    if (mine?.size === 0) this.outstanding.delete(claim.agent_id)
    this.claimedAttempts.delete(this.attemptKey(claim.job))
    this.settledClaims.set(claim.plan.run_id, claim)
    for (const [id, stage] of this.stages) {
      if (stage.run_id === claim.plan.run_id) this.stages.delete(id)
    }
    this.pruneReceipts()
  }

  private attemptKey(job: JobRecord & { run_id?: string | null }): string {
    return JSON.stringify([job.job_id, job.run_id, job.lease_generation])
  }

  private pruneReceipts(): void {
    const cutoff = this.now() - this.receiptTtlMs
    for (const [id, claim] of this.settledClaims) {
      if ((claim.settled_at ?? 0) <= cutoff || this.settledClaims.size > this.maxReceipts) this.settledClaims.delete(id)
    }
    for (const [id, receipt] of this.finalizedStages) {
      if (receipt.at <= cutoff || this.finalizedStages.size > this.maxReceipts) this.finalizedStages.delete(id)
    }
  }

  /** Expired attempts must release capacity before checking queue limits. */
  private pruneExpiredState(): void {
    const now = this.now()
    for (let i = this.pending.length - 1; i >= 0; i--) {
      const entry = this.pending[i]
      if (entry === undefined) continue
      const expiresAt = entry.plan.lease.expires_at
      if (expiresAt !== null && expiresAt !== '' && Date.parse(expiresAt) <= now) {
        this.pending.splice(i, 1)
        this.claimedAttempts.delete(this.attemptKey(entry.job))
      }
    }
    for (const mine of this.outstanding.values()) {
      for (const claim of mine.values()) {
        if (claim.lease_expires_at !== null && Date.parse(claim.lease_expires_at) <= now) this.settle(claim, 'lease_stale')
      }
    }
    this.pruneReceipts()
  }
}

// ── HTTP 面（x-service-token 等价实现；生产必须 mTLS）──────────────────────

export interface RemoteFleetHttpOptions {
  /** 与 kernel 内部路由同一机制：配置后所有 /v1/agents/* 要求 x-service-token。 */
  serviceToken?: string
  maxBodyBytes?: number
}

function readJsonBody(req: IncomingMessage, maxBytes: number): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let total = 0
    let settled = false
    req.on('data', (chunk: Buffer) => {
      total += chunk.length
      if (total > maxBytes) {
        if (settled) return
        settled = true
        reject(new FleetServerError(413, 'payload_too_large', `request body exceeds ${maxBytes} bytes`, false))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      if (settled) return
      settled = true
      if (chunks.length === 0) {
        resolve(undefined)
        return
      }
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')))
      } catch (error) {
        reject(new FleetServerError(400, 'invalid_json', `malformed JSON body: ${(error as Error).message}`, false))
      }
    })
    req.on('error', error => {
      if (!settled) {
        settled = true
        reject(error)
      }
    })
  })
}

function serviceTokenEquals(provided: string, expected: string): boolean {
  const a = createHash('sha256').update(provided).digest()
  const b = createHash('sha256').update(expected).digest()
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a[i]! ^ b[i]!
  return diff === 0
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body)
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(payload) })
  res.end(payload)
}

/** 按消息名用对应 zod schema 校验（全部 .strict()），失败 → 422 validation_error。 */
function validateWire<T>(schema: { parse: (value: unknown) => unknown }, value: unknown, message: string): T {
  try {
    return schema.parse(value) as T
  } catch (error) {
    const issues = error instanceof Error && 'issues' in error
      ? (error as { issues: Array<{ path: Array<string | number>; message: string }> }).issues
        .map(i => `${i.path.join('.') || '<root>'}: ${i.message}`).join('; ')
      : (error as Error).message
    throw new FleetServerError(422, 'validation_error', `${message}: ${issues}`, false)
  }
}

function parseWireSchema(body: unknown, message: string): unknown {
  const schemas: Record<string, { parse: (value: unknown) => unknown }> = {
    AgentRegisterRequest: AgentRegisterRequestSchema,
    AgentHeartbeatRequest: AgentHeartbeatRequestSchema,
    AgentClaimRequest: AgentClaimRequestSchema,
    RemoteFramesRequest: RemoteFramesRequestSchema,
    RemoteArtifactStageRequest: RemoteArtifactStageRequestSchema,
    RemoteArtifactFinalizeRequest: RemoteArtifactFinalizeRequestSchema,
    RemoteCompleteRequest: RemoteCompleteRequestSchema,
    RemoteRunHeartbeatRequest: RemoteRunHeartbeatRequestSchema,
    CasShaParam: {
      parse: (value: unknown) => {
        const record = value as Record<string, unknown>
        if (typeof record.sha !== 'string' || record.sha === '') throw new Error('sha is required')
        return { sha: record.sha }
      },
    },
  }
  const schema = schemas[message]
  if (schema === undefined) throw new FleetServerError(500, 'internal', `unknown wire message ${message}`, false)
  try {
    return schema.parse(body)
  } catch (error) {
    const issues = error instanceof Error && 'issues' in error
      ? (error as { issues: Array<{ path: Array<string | number>; message: string }> }).issues
        .map(i => `${i.path.join('.') || '<root>'}: ${i.message}`).join('; ')
      : (error as Error).message
    throw new FleetServerError(422, 'validation_error', issues, false)
  }
}

function httpStatusFor(error: unknown): number {
  if (error instanceof FleetServerError) return error.status
  if (error instanceof Error && 'status' in error && typeof (error as { status: unknown }).status === 'number') {
    return (error as { status: number }).status
  }
  return 500
}

/**
 * 把 /v1/agents/* 路由挂到 node http server（独立 listener；若与其它路由
 * 共用一个 server，只处理 /v1/agents/ 前缀并让其它 listener 处理其余路径）。
 * 配置 serviceToken 后所有路由要求 x-service-token（本地 wire 等价实现；
 * 生产必须替换为 mTLS service identity——见 docs/remote-runner-wire.md §3）。
 */
export function attachRemoteFleetRoutes(
  server: Server,
  fleet: RemoteFleetServer,
  options: RemoteFleetHttpOptions = {},
): void {
  const serviceToken = options.serviceToken
  const maxBodyBytes = options.maxBodyBytes ?? 32 * 1024 * 1024

  server.on('request', (req: IncomingMessage, res: ServerResponse) => {
    let url: URL
    try {
      url = new URL(req.url ?? '/', 'http://127.0.0.1')
    } catch {
      return // 非本路由（其它 listener 处理）
    }
    const pathname = url.pathname
    if (!pathname.startsWith('/v1/agents/')) return
    // 路径段需解码（cas/{sha} 携带 sha256:<hex>，客户端 encodeURIComponent）。
    let parts: string[]
    try {
      parts = pathname.split('/').filter(Boolean).map(decodeURIComponent)
    } catch {
      sendJson(res, 400, { error: { code: 'invalid_encoding', message: 'malformed percent-encoding in path', retryable: false } })
      return
    }
    const method = req.method ?? 'GET'
    void (async () => {
      try {
        if (serviceToken !== undefined) {
          const provided = req.headers['x-service-token']
          if (typeof provided !== 'string' || !serviceTokenEquals(provided, serviceToken)) {
            sendJson(res, 403, {
              error: {
                code: 'service_token_required',
                message: 'fleet route requires x-service-token (service identity); production requires mTLS (see docs/remote-runner-wire.md §3)',
                retryable: false,
              },
            })
            return
          }
        }
        // /v1/agents/register
        if (method === 'POST' && parts.length === 3 && parts[1] === 'agents' && parts[2] === 'register') {
          const body = await readJsonBody(req, maxBodyBytes)
          const parsed = parseWireSchema(body, 'AgentRegisterRequest') as AgentRegisterRequest
          const targetToken = req.headers['x-runner-target-token']
          sendJson(res, 200, await fleet.handleRegister(parsed, typeof targetToken === 'string' ? targetToken : ''))
          return
        }
        const agentId = parts[2]
        if (agentId === undefined) throw new FleetServerError(404, 'not_found', 'unknown fleet route', false)
        const targetToken = req.headers['x-runner-target-token']
        const identity = typeof targetToken === 'string' ? targetToken : ''
        fleet.authorizeAgent(agentId, identity)
        // /v1/agents/{id}/heartbeat | claims
        if (method === 'POST' && parts.length === 4) {
          if (parts[3] === 'heartbeat') {
            const body = await readJsonBody(req, maxBodyBytes)
            const parsed = parseWireSchema(body, 'AgentHeartbeatRequest') as AgentHeartbeatRequest
            sendJson(res, 200, await fleet.handleHeartbeat(agentId, parsed, identity))
            return
          }
          if (parts[3] === 'claims') {
            const body = await readJsonBody(req, maxBodyBytes)
            const parsed = parseWireSchema(body, 'AgentClaimRequest') as AgentClaimRequest
            sendJson(res, 200, await fleet.handleClaims(agentId, parsed))
            return
          }
        }
        // /v1/agents/{id}/cas/{sha}?project_id=
        if (method === 'GET' && parts.length === 5 && parts[3] === 'cas') {
          const parsed = parseWireSchema({ sha: parts[4] }, 'CasShaParam') as { sha: string }
          const projectId = url.searchParams.get('project_id') ?? ''
          sendJson(res, 200, await fleet.handleCas(agentId, parsed.sha, projectId))
          return
        }
        // /v1/agents/{id}/runs/{run_id}/frames | artifacts | complete
        if (method === 'POST' && parts.length === 6 && parts[3] === 'runs') {
          const runId = parts[4]!
          const sub = parts[5]
          if (sub === 'heartbeat') {
            const body = await readJsonBody(req, maxBodyBytes)
            const parsed = parseWireSchema(body, 'RemoteRunHeartbeatRequest') as RemoteRunHeartbeatRequest
            sendJson(res, 200, await fleet.handleRunHeartbeat(agentId, runId, parsed))
            return
          }
          if (sub === 'frames') {
            const body = await readJsonBody(req, maxBodyBytes)
            const parsed = parseWireSchema(body, 'RemoteFramesRequest') as RemoteFramesRequest
            sendJson(res, 200, await fleet.handleFrames(agentId, runId, parsed))
            return
          }
          if (sub === 'artifacts') {
            const body = await readJsonBody(req, maxBodyBytes)
            const record = typeof body === 'object' && body !== null ? body as Record<string, unknown> : {}
            if (typeof record.content_base64 === 'string' && typeof record.stage_id === 'string') {
              const parsed = parseWireSchema(body, 'RemoteArtifactFinalizeRequest') as RemoteArtifactFinalizeRequest
              sendJson(res, 200, await fleet.handleFinalizeArtifact(agentId, runId, parsed))
            } else {
              const parsed = parseWireSchema(body, 'RemoteArtifactStageRequest') as RemoteArtifactStageRequest
              sendJson(res, 200, fleet.handleStageArtifact(agentId, runId, parsed))
            }
            return
          }
          if (sub === 'complete') {
            const body = await readJsonBody(req, maxBodyBytes)
            const parsed = parseWireSchema(body, 'RemoteCompleteRequest') as RemoteCompleteRequest
            sendJson(res, 200, await fleet.handleComplete(agentId, runId, parsed))
            return
          }
        }
        throw new FleetServerError(404, 'not_found', `unknown fleet route ${method} ${pathname}`, false)
      } catch (error) {
        sendJson(res, httpStatusFor(error), { error: fleetErrorEnvelope(error) })
      }
    })()
  })
}

/** 便捷：启动独立 HTTP 服务（监听 127.0.0.1:0），返回 server + baseUrl。 */
export async function startFleetHttpServer(
  fleet: RemoteFleetServer,
  options: RemoteFleetHttpOptions = {},
): Promise<{ server: Server; baseUrl: string }> {
  const server = createServer()
  attachRemoteFleetRoutes(server, fleet, options)
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('fleet server failed to bind')
  return { server, baseUrl: `http://127.0.0.1:${address.port}` }
}
