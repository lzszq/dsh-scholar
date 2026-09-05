/**
 * RUN-REMOTE-01 — RemoteRunnerAgent wire 协议 + 服务端/代理端（mock 传输）
 * （docs/remote-runner-wire.md、execution-runtime.md §5.1、hardening-v0.2-status.md
 * §3 RUN-REMOTE-01）。
 *
 * 覆盖（全部经 mock 传输——InMemoryFleetTransport 直连服务端处理器 + JSON
 * round-trip，另含真实 HTTP loopback + x-service-token 面）：
 * - 注册/心跳：acknowledged/accepted、未注册 404、draining 状态、capability
 *   更新、wire schema strict（address/certificate → 422）；
 * - claim 匹配（capability）：target_id 精确 + images 匹配；无匹配 target →
 *   任务留在 pending（retryable，绝不静默改派/LocalDocker）；断连恢复 resume
 *   同一 claim（同一 run_id/lease）；
 * - CAS 拉取 + hash 复算：响应 hash 不一致、寻址 hash 不一致 → 拒绝执行
 *   （executor 未被调用）；自洽 → 正常执行；
 * - frames：全局 seq 单调、stream_seq 按通道、exit 帧最后、每帧 lease_generation；
 * - artifacts staged + finalize：服务端复算 sha256，篡改 → 409 cas_hash_mismatch；
 *   size 不一致 → 409 cas_size_mismatch（不落库）；
 * - complete 带签名 manifest + fencing 字段：kernel 侧 §12.7 Ed25519 验签通过；
 * - 离线 → 本地有界 spool → 恢复后按序重放；spool 有界：frames 淘汰合成 gap
 *   （不静默丢弃）；不可淘汰条目挡住 → 本地失败（fail closed，无合成成功）；
 * - lease 过期被新 claim 抢占后：旧 agent 的 complete → 409 lease_stale，claim
 *   置 settled，后续 frames/complete 全拒，无合成成功；agent last_seen 超时 →
 *   claims 409 agent_offline（retryable），心跳恢复可用；
 * - HTTP 面：x-service-token 缺失/错误 → 403 service_token_required；正确 token
 *   全链路（register/heartbeat/claim/CAS/frames/artifacts/complete）可用。
 *
 * 真实 mTLS 证书链 / 真实远端 sandbox / 网络分区故障注入无环境，如实记录
 * （docs/acceptance-tests.md §4.2、hardening-v0.2-status.md §3 RUN-REMOTE-01）。
 */
import { createHash, createPublicKey, generateKeyPairSync, verify } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import {
  buildExecutionPlan,
  computeProfileConfigHash,
  getRunnerProfile,
  verifyExecutionPlanSignature,
  type AgentClaimRequest,
  type AgentClaimResponse,
  type AgentHeartbeatRequest,
  type AgentHeartbeatResponse,
  type AgentRegisterRequest,
  type AgentRegisterResponse,
  type CasFetchResponse,
  type JobRecord,
  type RemoteAgentRegistration,
  type RemoteArtifactFinalizeRequest,
  type RemoteArtifactFinalizeResponse,
  type RemoteArtifactStageRequest,
  type RemoteArtifactStageResponse,
  type RemoteCompleteRequest,
  type RemoteCompleteResponse,
  type RemoteFramesRequest,
  type RemoteFramesResponse,
} from '@dsh-scholar/research-schemas'
import {
  canonicalJson,
  createRemoteRunnerAgent,
  FailingFleetTransport,
  HttpRemoteFleetTransport,
  InMemoryAgentRegistry,
  defaultSubprocessExecutor,
  InMemoryFleetTransport,
  RemoteFleetServer,
  RemoteWireError,
  startFleetHttpServer,
  type AgentExecutor,
  type AgentExecutionContext,
  type FleetKernelClient,
  type RemoteFleetServerOptions,
  type RemoteFleetTransport,
  type RemoteRunnerAgentImpl,
  type RunnerSigningKey,
} from '@dsh-scholar/runner-gateway'

// ── Fake kernel（实现 FleetKernelClient；镜像 kernel 的 lease fencing 与
//    §12.7 manifest 验签语义）───────────────────────────────────────────────

const DIGEST = 'node@sha256:c610fcdfb1d5b4740dd70c284ed3cb16bb857e0f7166196e36a5501df7a3aa32'
const OTHER_DIGEST = 'other@sha256:0000000000000000000000000000000000000000000000000000000000000000'
const TARGET_CONFIG_HASH = `sha256:${'5'.repeat(64)}`
const REMOTE_PROFILE = getRunnerProfile('profile_local_docker_cpu_v1')!
/** secure kinds 的 output contract（metrics 路径；fake executor 据此写 MetricsFileV1）。 */
const OUT = { metrics: 'metrics.json' }

function kernelError(status: number, code: string, message: string): Error {
  return Object.assign(new Error(message), { status, code })
}

function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

function sha256HexBytes(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex')
}

interface RecordedFrame {
  job_id: string
  run_id: string
  frame: {
    seq: number
    stream_seq: number | null
    channel: 'stdout' | 'stderr' | null
    text: string | null
    byte_offset: number | null
    byte_length: number | null
    frame_kind: 'chunk' | 'gap' | 'exit'
    payload_json?: string
    lease_generation: number
  }
}

interface RecordedComplete {
  job_id: string
  status: string
  run_manifest?: Record<string, unknown>
  lease_generation: number | null
  lease_token: string | null
  error?: string
  failure_class?: string | null
}

/**
 * FakeFleetKernel：内存实现 FleetKernelClient。镜像 kernel 关键语义：
 * claim 时 lease_generation+1/新 token/run_id（每 attempt 一个）；frames
 * 单调（seq <= cursor 幂等跳过）+ lease_generation 精确匹配；completeJob
 * 严格 fencing（缺字段/错 generation/token → 409 lease_stale）+ §12.7
 * manifest 验签（payload_sha256 复算 + Ed25519 验签）；lease 过期 → retryable
 * （reclaim 生成新 generation）。
 */
class FakeFleetKernel implements FleetKernelClient {
  now: () => number = Date.now
  readonly jobs = new Map<string, JobRecord & { run_id?: string | null }>()
  /** artifact id（含 sha256: 前缀/裸 hex）→ {sha256, content}（**字节**，CAS 语义）。 */
  readonly artifacts = new Map<string, { sha256: string; content: Buffer }>()
  readonly frames: RecordedFrame[] = []
  readonly completes: RecordedComplete[] = []
  /** 已注册的 manifest 验签公钥（§12.7）。 */
  manifestPublicKeyPem: string | null = null
  /** secure kinds 的 required-facts 校验开关（默认开——镜像 kernel verifySecureRunFacts）。 */
  enforceSecureFacts = true
  runnerTarget = {
    target_id: 'remote-gpu-1', kind: 'remote-ssh' as const, enabled: true,
    draining: false, revision: 1, config_hash: TARGET_CONFIG_HASH,
  }

  async heartbeatRunnerTarget() {}

  async getRunnerTarget(targetId: string) {
    return { ...this.runnerTarget, target_id: targetId }
  }

  seedJob(overrides: Partial<JobRecord> & { job_id: string; project_id: string } & Record<string, unknown>): JobRecord & { run_id?: string | null } {
    const record: JobRecord & { run_id?: string | null } = {
      contract_id: null,
      idempotency_key: `ik_${overrides.job_id}`,
      kind: 'formal',
      command: ['python', 'run.py'],
      payload: {},
      status: 'queued',
      failure_class: null,
      lease_owner: null,
      lease_expires_at: null,
      heartbeat_at: null,
      lease_generation: 0,
      lease_token: null,
      attempts: 0,
      max_attempts: 3,
      run_manifest: null,
      error: '',
      created_at: '2026-08-11T00:00:00.000Z',
      updated_at: '2026-08-11T00:00:00.000Z',
      ...overrides,
    }
    record.payload = {
      project_config_pin: `sha256:${'3'.repeat(64)}`,
      runner_target_id: 'remote-gpu-1',
      runner_target_kind: 'remote-ssh',
      runner_target_revision: 1,
      runner_target_hash: TARGET_CONFIG_HASH,
      runner_profile_id: REMOTE_PROFILE.profile_id,
      profile_config_hash: computeProfileConfigHash(REMOTE_PROFILE),
      image_digest: DIGEST,
      runner_compute: { mode: 'cpu' },
      ...(record.payload ?? {}),
    }
    this.jobs.set(record.job_id, record)
    return record
  }

  seedCas(id: string, content: string | Buffer): string {
    const bytes = typeof content === 'string' ? Buffer.from(content, 'utf8') : content
    const sha = sha256HexBytes(bytes)
    this.artifacts.set(id, { sha256: sha, content: bytes })
    return sha
  }

  expireJob(jobId: string): void {
    const job = this.jobs.get(jobId)
    if (job === undefined) return
    this.jobs.set(jobId, { ...job, lease_expires_at: new Date(this.now() - 1).toISOString() })
  }

  framesFor(runId: string): RecordedFrame[] {
    return this.frames.filter(f => f.run_id === runId).sort((a, b) => a.frame.seq - b.frame.seq)
  }

  async claimJobs(owner: string, limit: number, ttl = 300): Promise<JobRecord[]> {
    for (const job of [...this.jobs.values()]) {
      if (job.status === 'running' && job.lease_expires_at !== null && Date.parse(job.lease_expires_at) <= this.now()) {
        this.jobs.set(job.job_id, { ...job, status: 'retryable', lease_owner: null, lease_expires_at: null })
      }
    }
    const out: Array<JobRecord & { run_id?: string | null }> = []
    const queue = [...this.jobs.values()].sort((a, b) => (a.created_at < b.created_at ? -1 : 1))
    for (const job of queue) {
      if (out.length >= limit) break
      if (job.status !== 'queued' && !(job.status === 'retryable' && job.attempts < job.max_attempts)) continue
      const generation = (job.lease_generation ?? 0) + 1
      const token = `lt_fake_${job.job_id}_${generation}`
      const claimed: JobRecord & { run_id?: string | null } = {
        ...job,
        status: 'running',
        lease_owner: owner,
        lease_generation: generation,
        lease_token: token,
        lease_expires_at: new Date(this.now() + ttl * 1000).toISOString(),
        attempts: job.attempts + 1,
        run_id: `run_fake_${job.job_id.slice(-8)}_${generation}`,
      }
      this.jobs.set(job.job_id, claimed)
      out.push(claimed)
    }
    return out
  }

  async appendTerminalFrames(
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
    _maxLogBytes?: number,
  ): Promise<{ appended: number; last_seq: number; truncated: boolean; total_bytes: number; dropped_bytes: number }> {
    const job = this.jobs.get(jobId)
    if (job === undefined) throw kernelError(404, 'job_not_found', `job ${jobId} not found`)
    this.assertLease(job, owner, leaseToken)
    const existing = this.frames.filter(f => f.job_id === jobId && f.run_id === runId)
    const cursor = existing.reduce((max, f) => Math.max(max, f.frame.seq), 0)
    let appended = 0
    let lastSeq = cursor
    for (const f of frames) {
      if (f.seq <= cursor) continue // 幂等回放/乱序跳过（kernel 语义）
      if (job.lease_generation !== null && job.lease_generation !== undefined
        && (f.lease_generation === undefined || f.lease_generation !== job.lease_generation)) {
        throw kernelError(409, 'lease_stale',
          `frame lease_generation ${String(f.lease_generation)} != job generation ${String(job.lease_generation)}`)
      }
      this.frames.push({
        job_id: jobId,
        run_id: runId,
        frame: {
          seq: f.seq,
          stream_seq: f.stream_seq ?? null,
          channel: f.channel ?? null,
          text: f.text ?? null,
          byte_offset: f.byte_offset ?? null,
          byte_length: f.byte_length ?? null,
          frame_kind: f.frame_kind,
          payload_json: f.payload_json,
          lease_generation: f.lease_generation ?? 0,
        },
      })
      appended += 1
      lastSeq = f.seq
    }
    return { appended, last_seq: lastSeq, truncated: false, total_bytes: 0, dropped_bytes: 0 }
  }

  async registerJobArtifact(_jobId: string, input: {
    project_id: string
    kind: string
    content_base64: string
    metadata?: Record<string, unknown>
    media_type?: string
    file_name?: string
  }): Promise<{ artifact_id: string; sha256: string }> {
    // **字节**哈希（不经过 UTF-8 编解码——二进制 round-trip 依赖此语义）。
    const content = Buffer.from(input.content_base64, 'base64')
    const sha = sha256HexBytes(content)
    this.artifacts.set(`sha256:${sha}`, { sha256: sha, content })
    this.artifacts.set(sha, { sha256: sha, content })
    return { artifact_id: `sha256:${sha}`, sha256: sha }
  }

  async completeJob(input: {
    job_id: string
    owner: string
    status: 'succeeded' | 'failed' | 'cancelled'
    run_manifest?: Record<string, unknown>
    failure_class?: string | null
    error?: string
    lease_generation?: number | null
    lease_token?: string | null
  }): Promise<JobRecord> {
    const job = this.jobs.get(input.job_id)
    if (job === undefined) throw kernelError(404, 'job_not_found', `job ${input.job_id} not found`)
    if (job.lease_owner !== null && job.lease_owner !== input.owner) {
      throw kernelError(409, 'lease_conflict', `job ${input.job_id} leased by ${job.lease_owner}`)
    }
    if (job.status !== 'running') {
      throw kernelError(409, 'job_not_running', `job ${input.job_id} is ${job.status}, not running`)
    }
    // §12.6 严格 fencing（与 kernel 一致：缺字段/错 generation/token → 409）。
    if (input.lease_generation === null || input.lease_generation === undefined || input.lease_token === null || input.lease_token === undefined) {
      throw kernelError(409, 'lease_stale',
        `job ${input.job_id} completion missing lease fencing fields: expected generation ${String(job.lease_generation)} token ${String(job.lease_token)}`)
    }
    if (job.lease_generation !== input.lease_generation || job.lease_token !== input.lease_token) {
      throw kernelError(409, 'lease_stale',
        `job ${input.job_id} lease is stale: expected generation ${String(job.lease_generation)} token ${String(job.lease_token)}, got generation ${String(input.lease_generation)} token ${String(input.lease_token)}`)
    }
    if (input.status === 'succeeded' && input.run_manifest === undefined && job.kind !== 'echo' && job.kind !== 'smoke') {
      throw kernelError(422, 'run_manifest_required', `job ${input.job_id} succeeded without a run manifest`)
    }
    if (input.run_manifest !== undefined) {
      this.verifyManifest(input.run_manifest)
      // §5 两行：镜像 kernel verifySecureRunFacts——secure kinds 的 run_id
      // 全链绑定 + required facts（缺一 422）。
      this.verifySecureFacts(input.run_manifest, job, input.status === 'succeeded')
    }
    this.completes.push({
      job_id: input.job_id,
      status: input.status,
      run_manifest: input.run_manifest,
      lease_generation: input.lease_generation,
      lease_token: input.lease_token,
      error: input.error,
      failure_class: input.failure_class ?? null,
    })
    const done: JobRecord = { ...job, status: input.status, run_manifest: input.run_manifest ?? null, error: input.error ?? '' }
    this.jobs.set(input.job_id, done)
    return done
  }

  async heartbeatJob(jobId: string, owner: string, generation?: number | null, token?: string | null): Promise<JobRecord> {
    const job = this.jobs.get(jobId)
    if (job === undefined) throw kernelError(404, 'job_not_found', `job ${jobId} not found`)
    this.assertLease(job, owner, token ?? '')
    const renewed = { ...job, lease_expires_at: new Date(this.now() + 300_000).toISOString() }
    this.jobs.set(jobId, renewed)
    return renewed
  }

  async getJob(jobId: string): Promise<JobRecord> {
    const job = this.jobs.get(jobId)
    if (job === undefined) throw kernelError(404, 'job_not_found', `job ${jobId} not found`)
    return job
  }

  async fetchArtifactBytes(_projectId: string, sha256OrId: string): Promise<{ content: Buffer; media_type: string | null } | null> {
    const direct = this.artifacts.get(sha256OrId)
    if (direct !== undefined) return { content: direct.content, media_type: null }
    const bare = sha256OrId.startsWith('sha256:') ? sha256OrId.slice('sha256:'.length) : sha256OrId
    const byBare = this.artifacts.get(bare)
    return byBare !== undefined ? { content: byBare.content, media_type: null } : null
  }

  /** §12.7：payload_sha256 复算 + Ed25519 验签（镜像 kernel verifyRunManifest）。 */
  private verifyManifest(manifest: Record<string, unknown>): void {
    const payloadSha256 = manifest.payload_sha256
    if (typeof payloadSha256 === 'string' && payloadSha256 !== '') {
      const { signature: _s, runner_key_id: _k, payload_sha256: _p, ...payload } = manifest
      const actual = sha256Hex(canonicalJson(payload))
      if (actual !== payloadSha256) {
        throw kernelError(422, 'manifest_hash_mismatch', `payload_sha256 mismatch: got ${actual}, manifest claims ${payloadSha256}`)
      }
    }
    if (typeof manifest.signature === 'string' && manifest.signature !== '') {
      if (this.manifestPublicKeyPem === null) {
        throw kernelError(422, 'manifest_key_unknown', 'runner key is not registered')
      }
      const { signature, ...signedPayload } = manifest
      const publicKey = createPublicKey(this.manifestPublicKeyPem)
      const valid = verify(null, Buffer.from(canonicalJson(signedPayload), 'utf8'), publicKey, Buffer.from(String(signature), 'base64'))
      if (!valid) throw kernelError(422, 'manifest_signature_invalid', 'run manifest signature verification failed')
    }
  }

  /**
   * §5 两行：镜像 kernel verifySecureRunFacts——secure kinds（baseline/pilot/
   * formal/reproduce/latex-compile）的 run_id 全链绑定 + succeeded required
   * facts（metrics_artifact/seed/code snapshot/container_digest/data_hash）。
   */
  private verifySecureFacts(manifest: Record<string, unknown>, job: JobRecord & { run_id?: string | null }, succeeded: boolean): void {
    if (!this.enforceSecureFacts) return
    const SECURE: readonly string[] = ['baseline', 'pilot', 'formal', 'reproduce', 'latex-compile']
    if (!SECURE.includes(job.kind)) return
    if (job.run_id !== undefined && job.run_id !== null && manifest.run_id !== job.run_id) {
      throw kernelError(422, 'manifest_run_mismatch',
        `run manifest run_id ${String(manifest.run_id)} does not match the claim's run_id ${job.run_id}`)
    }
    if (!succeeded) return
    if (typeof manifest.metrics_artifact !== 'string' || manifest.metrics_artifact === '') {
      throw kernelError(422, 'manifest_facts_missing', `run manifest for ${job.kind} job ${job.job_id} lacks metrics_artifact`)
    }
    const payload = job.payload as Record<string, unknown>
    const jobSeed = typeof payload.seed === 'number' && Number.isFinite(payload.seed) ? payload.seed : null
    if (jobSeed !== null && manifest.seed !== jobSeed) {
      throw kernelError(422, 'manifest_seed_mismatch',
        `run manifest seed ${String(manifest.seed)} does not match the job's fixed seed ${jobSeed}`)
    }
    if (job.code_snapshot_id !== null && job.code_snapshot_id !== undefined && job.code_snapshot_id !== ''
      && manifest.code_snapshot_id !== job.code_snapshot_id) {
      throw kernelError(422, 'manifest_snapshot_mismatch',
        `run manifest code_snapshot_id ${String(manifest.code_snapshot_id)} does not match the job's code snapshot ${job.code_snapshot_id}`)
    }
    const imageDigest = typeof payload.image_digest === 'string' ? payload.image_digest : ''
    if (imageDigest !== '' && manifest.container_digest !== `docker:${imageDigest}`) {
      throw kernelError(422, 'manifest_container_mismatch',
        `run manifest container_digest ${String(manifest.container_digest)} does not match docker:${imageDigest}`)
    }
    const jobDataHash = typeof payload.data_hash === 'string' && payload.data_hash !== '' ? payload.data_hash : null
    if (jobDataHash !== null && manifest.data_hash !== jobDataHash) {
      throw kernelError(422, 'manifest_data_mismatch',
        `run manifest data_hash ${String(manifest.data_hash)} does not match the job's data hash ${jobDataHash}`)
    }
  }

  private assertLease(job: JobRecord & { run_id?: string | null }, owner: string, token: string | null): void {
    if (job.lease_owner !== null && job.lease_owner !== owner) {
      throw kernelError(409, 'lease_conflict', `job ${job.job_id} leased by ${job.lease_owner}`)
    }
    if (job.lease_owner !== null && job.lease_token !== null && job.lease_token !== token) {
      throw kernelError(409, 'lease_stale',
        `job ${job.job_id} lease mismatch: expected token ${job.lease_token}, got ${token ?? 'null'}`)
    }
  }
}

// ── 测试夹具 ───────────────────────────────────────────────────────────────

const NOW = Date.now()

function makeKeypair(keyId = 'runner-test-1'): { signingKey: RunnerSigningKey; publicKeyPem: string } {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519')
  return {
    signingKey: { keyId, privateKey },
    publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
  }
}

function makeRegistration(overrides: Partial<RemoteAgentRegistration> = {}): RemoteAgentRegistration {
  return {
    schema_version: 1,
    target_id: 'remote-gpu-1',
    agent_id: 'agent-gpu-1',
    capabilities: { os: 'linux', arch: 'x64', runner_ver: '0.2.0', images: [] },
    labels: { rack: 'a' },
    health: { status: 'online', last_seen: new Date(NOW - 1_000).toISOString() },
    cert_fingerprint: 'sha256:test-cert-fingerprint',
    ...overrides,
  }
}

function fakeExecutor(chunks: Array<{ channel: 'stdout' | 'stderr'; text: string }> = []): {
  executor: AgentExecutor
  callCount: () => number
} {
  let calls = 0
  const executor: AgentExecutor = async (plan, ctx: AgentExecutionContext) => {
    calls += 1
    let offset = 0
    for (const chunk of chunks) {
      ctx.onChunk?.(chunk.channel, chunk.text, offset, Buffer.byteLength(chunk.text, 'utf8'))
      offset += Buffer.byteLength(chunk.text, 'utf8')
    }
    // §12.5：模拟容器写回 MetricsFileV1（secure kinds 的 required fact——
    // 与本地 runner 同契约：file seed 恒有限、run/contract/seed 绑定一致）。
    if (plan.output_contract.metrics_path !== null && plan.output_contract.metrics_path !== '') {
      const outputsDir = join(ctx.cwd ?? '', 'outputs')
      mkdirSync(outputsDir, { recursive: true })
      const rel = plan.output_contract.metrics_path.replace(/^\/outputs\/?/, '')
      writeFileSync(join(outputsDir, rel), JSON.stringify({
        schema_version: 1,
        run_id: plan.run_id,
        ...(plan.output_contract.contract_id !== null ? { contract_id: plan.output_contract.contract_id } : {}),
        seed: plan.output_contract.seed ?? 0,
        metrics: [{ name: 'm', value: 1, unit: '' }],
      }))
    }
    return {
      run_id: plan.run_id,
      exit_code: 0,
      started_at: '2026-08-11T12:00:01.000Z',
      finished_at: '2026-08-11T12:00:02.000Z',
      stdout: chunks.filter(c => c.channel === 'stdout').map(c => c.text).join(''),
      stderr: chunks.filter(c => c.channel === 'stderr').map(c => c.text).join(''),
    }
  }
  return { executor, callCount: () => calls }
}

interface FleetFixture {
  kernel: FakeFleetKernel
  fleet: RemoteFleetServer
  registry: InMemoryAgentRegistry
  fleetKey: { signingKey: RunnerSigningKey; publicKeyPem: string }
  clock: { value: number }
}

function makeFleet(overrides: Partial<RemoteFleetServerOptions> = {}): FleetFixture {
  const kernel = new FakeFleetKernel()
  const registry = new InMemoryAgentRegistry()
  const clock = { value: NOW }
  kernel.now = () => clock.value
  const fleetKey = makeKeypair('fleet-key-1')
  const fleet = new RemoteFleetServer({
    registry,
    client: kernel,
    owner: 'fleet-owner',
    signingKey: fleetKey.signingKey,
    leaseTtlSeconds: 300,
    now: () => clock.value,
    ...overrides,
  })
  return { kernel, fleet, registry, fleetKey, clock }
}

interface AgentFixture {
  agent: RemoteRunnerAgentImpl
  transport: InMemoryFleetTransport
  agentKey: { signingKey: RunnerSigningKey; publicKeyPem: string }
}

/**
 * 构造标准 agent：InMemoryFleetTransport + fleet 公钥验签 + agent 私钥签名
 * manifest（kernel 以 agent 公钥验签）。
 */
function makeAgent(fixture: FleetFixture, options: { registration?: Partial<RemoteAgentRegistration>; executor?: AgentExecutor } = {}): AgentFixture {
  const transport = new InMemoryFleetTransport(fixture.fleet)
  const agentKey = makeKeypair('agent-key-1')
  fixture.kernel.manifestPublicKeyPem = agentKey.publicKeyPem
  const agent = createRemoteRunnerAgent(
    makeRegistration(options.registration),
    transport,
    {
      publicKeyPem: fixture.fleetKey.publicKeyPem,
      signingKey: agentKey.signingKey,
      executor: options.executor ?? fakeExecutor().executor,
    },
  ) as RemoteRunnerAgentImpl
  return { agent, transport, agentKey }
}

/** 标准跑一个 claim：register → claims → runClaim。 */
async function claimAndRun(agent: RemoteRunnerAgentImpl, expectCount = 1): Promise<string> {
  await agent.register()
  const claims = await agent.claimOnce(expectCount)
  expect(claims.length).toBe(expectCount)
  await agent.runClaim(claims[0]!)
  return claims[0]!.plan.run_id
}

// ── 注册 / 心跳 ────────────────────────────────────────────────────────────

describe('wire 注册/心跳（POST /v1/agents/register、/heartbeat）', () => {
  it('注册 acknowledged + 心跳 accepted；未注册 agent 心跳 → 404 agent_not_registered（fail closed）', async () => {
    const fixture = makeFleet()
    const transport = new InMemoryFleetTransport(fixture.fleet)
    const registered = await transport.register(makeRegistration())
    expect(registered.acknowledged).toBe(true)
    expect(registered.target_id).toBe('remote-gpu-1')
    expect(registered.offline_after_ms).toBe(30_000)

    const heartbeat = await transport.heartbeat('agent-gpu-1', { schema_version: 1 })
    expect(heartbeat.accepted).toBe(true)
    expect(heartbeat.target_id).toBe('remote-gpu-1')
    expect(fixture.registry.get('agent-gpu-1')?.health.status).toBe('online')

    await expect(transport.heartbeat('ghost-agent', { schema_version: 1 })).rejects.toMatchObject({
      status: 404,
      code: 'agent_not_registered',
    })
  })

  it('心跳可携带 draining 状态与 capability/labels 更新（服务端认可面）', async () => {
    const fixture = makeFleet()
    const transport = new InMemoryFleetTransport(fixture.fleet)
    await transport.register(makeRegistration())
    await transport.heartbeat('agent-gpu-1', { schema_version: 1, status: 'draining' })
    expect(fixture.registry.get('agent-gpu-1')?.health.status).toBe('draining')
    await transport.heartbeat('agent-gpu-1', {
      schema_version: 1,
      status: 'online',
      capabilities: { os: 'linux', arch: 'arm64', runner_ver: '0.3.0', images: [DIGEST] },
      labels: { rack: 'b' },
    })
    const updated = fixture.registry.get('agent-gpu-1')
    expect(updated?.capabilities.arch).toBe('arm64')
    expect(updated?.capabilities.runner_ver).toBe('0.3.0')
    expect(updated?.labels).toEqual({ rack: 'b' })
    expect(updated?.health.status).toBe('online')
  })

  it('wire schema .strict()：注册请求携带 address/certificate → 422 validation_error', async () => {
    const fixture = makeFleet()
    const transport = new InMemoryFleetTransport(fixture.fleet)
    await expect(transport.register({
      ...makeRegistration(),
      address: '10.0.0.5:7443',
    } as never)).rejects.toMatchObject({ status: 422, code: 'validation_error' })
    await expect(transport.register({
      ...makeRegistration(),
      certificate: '-----BEGIN CERT-----',
    } as never)).rejects.toMatchObject({ status: 422, code: 'validation_error' })
  })
})

// ── claim 匹配 / 不静默降级 ────────────────────────────────────────────────

describe('wire claim 匹配（POST /v1/agents/{id}/claims）', () => {
  it('target_id 精确 + capability 匹配才分发；无匹配 target → pending 保留（retryable，不静默改派）', async () => {
    const fixture = makeFleet()
    const kernel = fixture.kernel
    kernel.seedJob({ job_id: 'job_gpu_1', project_id: 'prj_1', payload: { runner_target_id: 'remote-gpu-1', image_digest: DIGEST } })

    // CPU agent（不同 target）轮询 → 空；任务留在 pending（不降级到 CPU/local）。
    const cpuAgent = createRemoteRunnerAgent(
      makeRegistration({ target_id: 'remote-cpu-1', agent_id: 'agent-cpu-1', capabilities: { os: 'linux', arch: 'x64', runner_ver: '0.2.0', images: [] } }),
      new InMemoryFleetTransport(fixture.fleet),
      { publicKeyPem: fixture.fleetKey.publicKeyPem, executor: fakeExecutor().executor },
    ) as RemoteRunnerAgentImpl
    await cpuAgent.register()
    expect(await cpuAgent.claimOnce(1)).toEqual([])
    expect(fixture.fleet.stats().pending).toBe(1) // 任务仍在 pending（retryable，等待匹配 target）

    // capability mismatch：GPU agent 只支持其它 digest → 空。
    const gpuWrongImage = createRemoteRunnerAgent(
      makeRegistration({ agent_id: 'agent-gpu-img', capabilities: { os: 'linux', arch: 'x64', runner_ver: '0.2.0', images: [OTHER_DIGEST] } }),
      new InMemoryFleetTransport(fixture.fleet),
      { publicKeyPem: fixture.fleetKey.publicKeyPem, executor: fakeExecutor().executor },
    ) as RemoteRunnerAgentImpl
    await gpuWrongImage.register()
    expect(await gpuWrongImage.claimOnce(1)).toEqual([])
    expect(fixture.fleet.stats().pending).toBe(1)

    // 匹配的 GPU agent → 拿到 claim：plan 签名可验、run_id/lease 与 kernel 一致。
    const gpuAgent = createRemoteRunnerAgent(
      makeRegistration(),
      new InMemoryFleetTransport(fixture.fleet),
      { publicKeyPem: fixture.fleetKey.publicKeyPem, executor: fakeExecutor().executor },
    ) as RemoteRunnerAgentImpl
    await gpuAgent.register()
    const claims = await gpuAgent.claimOnce(1)
    expect(claims).toHaveLength(1)
    const claim = claims[0]!
    expect(claim.plan.target_id).toBe('remote-gpu-1')
    expect(claim.plan.job_id).toBe('job_gpu_1')
    const kernelJob = kernel.jobs.get('job_gpu_1')!
    expect(claim.plan.run_id).toBe(kernelJob.run_id)
    expect(claim.plan.lease.generation).toBe(kernelJob.lease_generation)
    expect(claim.plan.lease.token).toBe(kernelJob.lease_token)
    expect(claim.lease).toEqual({
      owner: 'fleet-owner',
      generation: kernelJob.lease_generation,
      token: kernelJob.lease_token,
      expires_at: kernelJob.lease_expires_at,
    })
    expect(verifyExecutionPlanSignature(claim.plan, fixture.fleetKey.publicKeyPem).valid).toBe(true)
    expect(fixture.fleet.stats().pending).toBe(0)
  })

  it('revalidates a pinned remote target immediately before dispatch', async () => {
    const fixture = makeFleet()
    fixture.kernel.seedJob({
      job_id: 'job_stale_remote_target', project_id: 'prj_1',
      payload: {
        runner_target_id: 'remote-gpu-1', runner_target_kind: 'remote-ssh',
        runner_target_revision: 1, runner_target_hash: TARGET_CONFIG_HASH,
        image_digest: DIGEST,
      },
    })
    const { agent } = makeAgent(fixture)
    await agent.register()
    fixture.kernel.runnerTarget = { ...fixture.kernel.runnerTarget, revision: 2, config_hash: `sha256:${'6'.repeat(64)}` }
    await expect(agent.claimOnce(1)).resolves.toEqual([])
    expect(fixture.kernel.jobs.get('job_stale_remote_target')).toMatchObject({ status: 'failed' })
    expect(fixture.kernel.completes.at(-1)).toMatchObject({
      job_id: 'job_stale_remote_target', status: 'failed', failure_class: 'environment',
    })
  })

  it('closes the lease when remote ExecutionPlan construction rejects a pinned profile', async () => {
    const fixture = makeFleet()
    fixture.kernel.seedJob({
      job_id: 'job_bad_remote_profile', project_id: 'prj_1',
      payload: {
        runner_target_id: 'remote-gpu-1', runner_profile_id: 'profile_missing',
        profile_config_hash: 'sha256:not-a-profile', image_digest: DIGEST,
      },
    })
    const { agent } = makeAgent(fixture)
    await agent.register()
    await expect(agent.claimOnce(1)).resolves.toEqual([])
    expect(fixture.kernel.jobs.get('job_bad_remote_profile')).toMatchObject({ status: 'failed' })
    expect(fixture.kernel.completes.at(-1)).toMatchObject({
      job_id: 'job_bad_remote_profile', status: 'failed', failure_class: 'environment',
    })
  })

  it('agent 断连期间服务端保留 outstanding；恢复后 resume 返回同一 claim（同一 run_id/lease）', async () => {
    const fixture = makeFleet()
    fixture.kernel.seedJob({ job_id: 'job_resume', project_id: 'prj_1', payload: { runner_target_id: 'remote-gpu-1', image_digest: DIGEST } })
    const { agent } = makeAgent(fixture)
    await agent.register()
    const first = await agent.claimOnce(1)
    expect(first).toHaveLength(1)
    const runId = first[0]!.plan.run_id

    // 再次轮询（模拟断连恢复）：服务端原样返回同一 outstanding claim。
    const resumed = await agent.claimOnce(1)
    expect(resumed).toHaveLength(1)
    expect(resumed[0]!.plan.run_id).toBe(runId)
    expect(resumed[0]!.claim_id).toBe(first[0]!.claim_id)
    expect(resumed[0]!.plan.lease.generation).toBe(first[0]!.plan.lease.generation)
  })
})

// ── CAS 拉取 + hash 复算 ───────────────────────────────────────────────────

describe('wire CAS（GET /v1/agents/{id}/cas/{sha}）与 hash 复算', () => {
  it('CAS 响应 hash 与内容不一致 → 拒绝执行（executor 不被调用）；寻址 hash 不一致同样拒绝', async () => {
    const fixture = makeFleet()
    const kernel = fixture.kernel
    const archive = JSON.stringify({
      schema_version: 1,
      files: { 'run.py': { sha256: sha256Hex('print(1)'), content_base64: Buffer.from('print(1)').toString('base64') } },
    })
    const codeSha = sha256Hex(archive)
    kernel.seedCas(`sha256:${codeSha}`, archive)
    kernel.seedJob({
      job_id: 'job_cas_bad',
      project_id: 'prj_1',
      code_snapshot_id: `sha256:${codeSha}`,
      payload: { runner_target_id: 'remote-gpu-1', image_digest: DIGEST, output_contract: OUT },
    })

    // 篡改传输：响应声明的 sha256 与内容不符（模拟链路损坏/服务端撒谎）。
    let executorCalls = 0
    const tamperingTransport = new TamperingCasTransport(new InMemoryFleetTransport(fixture.fleet))
    const agent = createRemoteRunnerAgent(
      makeRegistration(),
      tamperingTransport,
      {
        publicKeyPem: fixture.fleetKey.publicKeyPem,
        executor: async (plan, _ctx) => {
          executorCalls += 1
          return { run_id: plan.run_id, exit_code: 0, started_at: '', finished_at: '', stdout: '', stderr: '' }
        },
      },
    ) as RemoteRunnerAgentImpl
    await agent.register()
    const claims = await agent.claimOnce(1)
    expect(claims).toHaveLength(1)
    await expect(agent.runClaim(claims[0]!)).rejects.toThrow(/CAS hash mismatch/)
    expect(executorCalls).toBe(0) // 不一致 → 拒绝执行（fail closed）

    // 寻址 hash 不一致：URL 声明的 id 是 64-hex，但内容 hash 与它不同。
    tamperingTransport.tamper = false
    const fakeAddress = 'b'.repeat(64)
    kernel.artifacts.set(`sha256:${fakeAddress}`, { sha256: sha256Hex('unrelated-bytes'), content: Buffer.from('unrelated-bytes', 'utf8') })
    kernel.seedJob({
      job_id: 'job_cas_addr',
      project_id: 'prj_1',
      code_snapshot_id: `sha256:${fakeAddress}`,
      payload: { runner_target_id: 'remote-gpu-1', image_digest: DIGEST, output_contract: OUT },
    })
    const claims2 = await agent.claimOnce(2)
    const addrClaim = claims2.find(c => c.plan.job_id === 'job_cas_addr')
    expect(addrClaim).toBeDefined()
    await expect(agent.runClaim(addrClaim!)).rejects.toThrow(/does not match the addressed hash/)
    expect(executorCalls).toBe(0)
  })

  it('CAS 输入自洽（响应 hash = 内容 hash = 寻址 hash）→ 正常执行', async () => {
    const fixture = makeFleet()
    const kernel = fixture.kernel
    const archive = JSON.stringify({
      schema_version: 1,
      files: { 'run.py': { sha256: sha256Hex('print(1)'), content_base64: Buffer.from('print(1)').toString('base64') } },
    })
    const codeSha = sha256Hex(archive)
    kernel.seedCas(`sha256:${codeSha}`, archive)
    kernel.seedJob({
      job_id: 'job_cas_ok',
      project_id: 'prj_1',
      code_snapshot_id: `sha256:${codeSha}`,
      payload: { runner_target_id: 'remote-gpu-1', image_digest: DIGEST, output_contract: OUT },
    })
    const { agent } = makeAgent(fixture)
    await claimAndRun(agent)
    expect(fixture.kernel.jobs.get('job_cas_ok')?.status).toBe('succeeded')
  })
})

// ── 全链路 happy path（frames/artifacts/complete）─────────────────────────

describe('wire 执行全链路（frames/artifacts/complete，mock 传输）', () => {
  it('frames 全局 seq 单调 + stream_seq 按通道 + exit 帧最后；log artifact staged+finalize；complete 带签名 manifest + fencing', async () => {
    const fixture = makeFleet()
    fixture.kernel.seedJob({
      job_id: 'job_happy',
      project_id: 'prj_1',
      contract_id: 'expc_1',
      payload: { runner_target_id: 'remote-gpu-1', image_digest: DIGEST, seed: 11, output_contract: OUT },
    })
    const { agent } = makeAgent(fixture, {
      executor: fakeExecutor([
        { channel: 'stdout', text: 'training...\n' },
        { channel: 'stdout', text: 'epoch 1\n' },
        { channel: 'stderr', text: 'warn\n' },
      ]).executor,
    })
    const runId = await claimAndRun(agent)

    // frames：seq 1..4 严格递增；stream_seq 按通道；exit 最后。
    const frames = fixture.kernel.framesFor(runId)
    expect(frames.map(f => f.frame.seq)).toEqual([1, 2, 3, 4])
    expect(frames[0]!.frame).toMatchObject({ channel: 'stdout', text: 'training...\n', stream_seq: 1, frame_kind: 'chunk' })
    expect(frames[1]!.frame).toMatchObject({ channel: 'stdout', text: 'epoch 1\n', stream_seq: 2, frame_kind: 'chunk' })
    expect(frames[2]!.frame).toMatchObject({ channel: 'stderr', text: 'warn\n', stream_seq: 1, frame_kind: 'chunk' })
    expect(frames[3]!.frame).toMatchObject({ frame_kind: 'exit' })
    const exitPayload = JSON.parse(frames[3]!.frame.payload_json ?? '{}') as Record<string, unknown>
    expect(exitPayload.exit_code).toBe(0)
    expect(exitPayload.timed_out).toBe(false)
    // 每帧携带 lease_generation（fencing）。
    for (const f of frames) expect(f.frame.lease_generation).toBe(1)

    // log artifact：staged + finalize 后 kernel 侧存在且 sha256 与内容一致。
    const kernelJob = fixture.kernel.jobs.get('job_happy')!
    const manifest = kernelJob.run_manifest as Record<string, unknown>
    expect(manifest).toBeDefined()
    const logArtifactId = manifest.log_artifact as string
    expect(logArtifactId).toMatch(/^sha256:[0-9a-f]{64}$/)
    const logRec = fixture.kernel.artifacts.get(logArtifactId)
    expect(logRec).toBeDefined()
    expect(sha256Hex(logRec!.content)).toBe(logArtifactId.slice('sha256:'.length))

    // complete：kernel 验签通过（manifest 带 signature/payload_sha256/signed_by + lease）。
    expect(fixture.kernel.completes).toHaveLength(1)
    const complete = fixture.kernel.completes[0]!
    expect(complete.status).toBe('succeeded')
    expect(complete.lease_generation).toBe(1)
    expect(complete.lease_token).toBe(kernelJob.lease_token)
    const runManifest = complete.run_manifest!
    expect(typeof runManifest.signature).toBe('string')
    expect(typeof runManifest.payload_sha256).toBe('string')
    expect(runManifest.signed_by).toBe('fleet-owner')
    expect(runManifest.lease).toEqual({ generation: 1 })
    expect(JSON.stringify(runManifest)).not.toContain(kernelJob.lease_token)
    expect(runManifest.run_id).toBe(runId)
    expect(runManifest.job_id).toBe('job_happy')
    expect(fixture.kernel.jobs.get('job_happy')?.status).toBe('succeeded')
  })

  it('artifact finalize 篡改（内容与 stage 声明 hash 不一致）→ 409 cas_hash_mismatch 不落库', async () => {
    const fixture = makeFleet()
    fixture.kernel.seedJob({ job_id: 'job_stage', project_id: 'prj_1', payload: { runner_target_id: 'remote-gpu-1', image_digest: DIGEST } })
    const { agent, transport } = makeAgent(fixture)
    await agent.register()
    const claims = await agent.claimOnce(1)
    const runId = claims[0]!.plan.run_id
    const staged = await transport.stageArtifact('agent-gpu-1', runId, {
      schema_version: 1,
      run_id: runId,
      sha256: 'c'.repeat(64),
      size: 5,
      kind: 'log',
      media_type: 'text/plain; charset=utf-8',
      file_name: 'x.log',
      metadata: { run_id: runId },
    })
    await expect(transport.finalizeArtifact('agent-gpu-1', runId, {
      schema_version: 1,
      run_id: runId,
      stage_id: staged.stage_id,
      content_base64: Buffer.from('hello').toString('base64'), // 内容 hash ≠ c*64
    })).rejects.toMatchObject({ status: 409, code: 'cas_hash_mismatch' })
    // size 不一致同样拒绝。
    const staged2 = await transport.stageArtifact('agent-gpu-1', runId, {
      schema_version: 1,
      run_id: runId,
      sha256: sha256Hex('hello'),
      size: 99,
      kind: 'log',
    })
    await expect(transport.finalizeArtifact('agent-gpu-1', runId, {
      schema_version: 1,
      run_id: runId,
      stage_id: staged2.stage_id,
      content_base64: Buffer.from('hello').toString('base64'),
    })).rejects.toMatchObject({ status: 409, code: 'cas_size_mismatch' })
    // 不落库。
    expect(fixture.kernel.artifacts.get('c'.repeat(64))).toBeUndefined()
  })
})

// ── 离线 → spool → 恢复重放 ────────────────────────────────────────────────

describe('wire 离线 spool（有界保存、恢复重放、gap 不静默丢弃）', () => {
  it('断网期间 frames/stage/finalize/complete 全部 spool；恢复后按序重放并完成 Job', async () => {
    const fixture = makeFleet()
    fixture.kernel.seedJob({ job_id: 'job_spool', project_id: 'prj_1', payload: { runner_target_id: 'remote-gpu-1', image_digest: DIGEST, output_contract: OUT } })
    const inner = new InMemoryFleetTransport(fixture.fleet)
    const failing = new FailingFleetTransport(inner)
    const agentKey = makeKeypair('agent-spool')
    fixture.kernel.manifestPublicKeyPem = agentKey.publicKeyPem
    const agent = createRemoteRunnerAgent(
      makeRegistration(),
      failing,
      {
        publicKeyPem: fixture.fleetKey.publicKeyPem,
        signingKey: agentKey.signingKey,
        executor: fakeExecutor([
          { channel: 'stdout', text: 'a\n' },
          { channel: 'stdout', text: 'b\n' },
          { channel: 'stderr', text: 'w\n' },
        ]).executor,
      },
    ) as RemoteRunnerAgentImpl

    await agent.register() // 在线
    const claims = await agent.claimOnce(1)
    expect(claims).toHaveLength(1)
    const runId = claims[0]!.plan.run_id

    failing.networkUp = false // 断网
    await agent.runClaim(claims[0]!)
    expect(agent.spoolStats().entries).toBeGreaterThan(0)
    expect(fixture.kernel.framesFor(runId)).toHaveLength(0) // 未送达
    expect(fixture.kernel.completes).toHaveLength(0)

    failing.networkUp = true // 恢复
    await agent.flushSpool()
    expect(agent.spoolStats().entries).toBe(0)
    const frames = fixture.kernel.framesFor(runId)
    expect(frames.map(f => f.frame.seq)).toEqual([1, 2, 3, 4])
    expect(fixture.kernel.completes).toHaveLength(1)
    expect(fixture.kernel.completes[0]!.status).toBe('succeeded')
    expect(fixture.kernel.jobs.get('job_spool')?.status).toBe('succeeded')
  })

  it('spool 有界：frames 条目可被淘汰并合成 gap（不静默丢弃）；exit_frame/complete 不可淘汰；恢复后 gap 先于幸存帧送达', async () => {
    const fixture = makeFleet()
    const kernel = fixture.kernel
    kernel.seedJob({ job_id: 'job_gap_r1', project_id: 'prj_1', payload: { runner_target_id: 'remote-gpu-1', image_digest: DIGEST, output_contract: OUT } })
    kernel.seedJob({ job_id: 'job_gap_r2', project_id: 'prj_1', payload: { runner_target_id: 'remote-gpu-1', image_digest: DIGEST, output_contract: OUT } })
    const inner = new InMemoryFleetTransport(fixture.fleet)
    const failing = new FailingFleetTransport(inner)
    const agentKey = makeKeypair('agent-gap')
    kernel.manifestPublicKeyPem = agentKey.publicKeyPem
    const chunks = Array.from({ length: 4 }, (_, i) => ({ channel: 'stdout' as const, text: `chunk-${i}\n` }))
    const agent = createRemoteRunnerAgent(
      makeRegistration(),
      failing,
      {
        publicKeyPem: fixture.fleetKey.publicKeyPem,
        signingKey: agentKey.signingKey,
        executor: fakeExecutor(chunks).executor,
        // manifest 已含完整 facts（code_commit/code_snapshot_id/container_
        // digest/data_hash/seed/metrics_artifact）——complete 条目比早期更大，
        // 字节预算相应上调（仍保证 R2 complete 入队时淘汰两个 run 的 chunks）。
        spool: { maxBytes: 3_200, maxEntries: 16 },
      },
    ) as RemoteRunnerAgentImpl
    await agent.register()

    // R1：frames 断网进 spool（chunks 可淘汰；exit_frame 不可淘汰）；
    // complete 因 spool 仍有本 run 条目而强制入队（顺序保证）——R1 未完成。
    failing.failMethod('uploadFrames')
    const claims1 = await agent.claimOnce(1)
    const run1 = claims1[0]!.plan.run_id
    await agent.runClaim(claims1[0]!)
    expect(kernel.jobs.get('job_gap_r1')?.status).toBe('running')
    expect(agent.spoolStats().entries).toBe(3) // chunks + exit_frame + complete

    // R2：frames 与 complete 均失败 → complete 强制入队触发淘汰（最旧 chunks）。
    // claimOnce(2)：resume 回放 R1（completedRuns 幂等，不重复执行）+ fresh R2。
    failing.failMethod('complete')
    const claims2 = await agent.claimOnce(2)
    const r2Claim = claims2.find(c => c.plan.job_id === 'job_gap_r2')
    expect(r2Claim).toBeDefined()
    const run2 = r2Claim!.plan.run_id
    // resume 回放的 R1 claim 直接返回已存结果（不重复执行）。
    await expect(agent.runClaim(claims2.find(c => c.plan.job_id === 'job_gap_r1')!)).resolves.toMatchObject({ exit_code: 0 })
    await agent.runClaim(r2Claim!)
    expect(agent.spoolStats().entries).toBeGreaterThan(0)

    // 恢复：flush → 先补 gap（淘汰区间），再按序重放 exit_frame 与 complete。
    failing.clearFailures()
    vi.spyOn(failing, 'uploadFrames').mockRejectedValueOnce(new RemoteWireError(0, 'transport_unreachable', 'gap response unavailable', true))
    await agent.flushSpool()
    expect(kernel.framesFor(run1)).toHaveLength(0)
    expect(kernel.completes.filter(c => c.job_id.startsWith('job_gap_r'))).toHaveLength(0)
    expect(agent.spoolStats().entries).toBeGreaterThan(0)
    await agent.flushSpool()
    expect(agent.spoolStats().entries).toBe(0)
    expect(kernel.jobs.get('job_gap_r1')?.status).toBe('succeeded')
    expect(kernel.jobs.get('job_gap_r2')?.status).toBe('succeeded')

    // 每个 run：chunks 被淘汰 → gap frame（seq=1，区间 1..4）而非静默丢弃；
    // exit frame（seq=5）幸存且在 gap 之后（seq 单调）；complete 最后送达。
    for (const runId of [run1, run2]) {
      const frames = kernel.framesFor(runId)
      const gap = frames.find(f => f.frame.frame_kind === 'gap')
      expect(gap).toBeDefined()
      expect(gap!.frame.seq).toBe(1)
      const gapPayload = JSON.parse(gap!.frame.payload_json ?? '{}') as Record<string, unknown>
      expect(gapPayload.reason).toBe('agent_spool_overflow')
      expect((gapPayload.dropped_bytes as number) ?? 0).toBeGreaterThan(0)
      expect(gapPayload.dropped_from_seq).toBe(1)
      expect(gapPayload.dropped_to_seq).toBe(4)
      const exit = frames.find(f => f.frame.frame_kind === 'exit')
      expect(exit).toBeDefined()
      expect(exit!.frame.seq).toBe(5)
      expect(exit!.frame.seq).toBeGreaterThan(gap!.frame.seq)
      // exit 之后没有任何 chunk（淘汰区间被 gap 覆盖，不静默丢失）。
      expect(frames.every(f => f.frame.frame_kind !== 'chunk')).toBe(true)
    }
    expect(kernel.completes.filter(c => c.job_id.startsWith('job_gap_r'))).toHaveLength(2)
  })

  it('spool 极小（不可淘汰条目挡住）→ push 被拒 → run 本地失败（fail closed，无合成成功）', async () => {
    const fixture = makeFleet()
    fixture.kernel.seedJob({ job_id: 'job_overflow', project_id: 'prj_1', payload: { runner_target_id: 'remote-gpu-1', image_digest: DIGEST, output_contract: OUT } })
    const failing2 = new FailingFleetTransport(new InMemoryFleetTransport(fixture.fleet))
    const agentKey2 = makeKeypair('agent-overflow')
    fixture.kernel.manifestPublicKeyPem = agentKey2.publicKeyPem
    const agent2 = createRemoteRunnerAgent(
      makeRegistration(),
      failing2,
      {
        publicKeyPem: fixture.fleetKey.publicKeyPem,
        signingKey: agentKey2.signingKey,
        executor: fakeExecutor([{ channel: 'stdout', text: 'x'.repeat(1_000) }]).executor,
        spool: { maxBytes: 64, maxEntries: 2 },
      },
    ) as RemoteRunnerAgentImpl
    await agent2.register()
    const claims2 = await agent2.claimOnce(1)
    failing2.networkUp = false
    await expect(agent2.runClaim(claims2[0]!)).rejects.toThrow(/outbound spool overflow/)
    expect(fixture.kernel.completes).toHaveLength(0)
    expect(fixture.kernel.jobs.get('job_overflow')?.status).toBe('running') // 未完成——无合成成功
  })
})

// ── lease 过期 fencing ─────────────────────────────────────────────────────

describe('wire lease 过期 fencing（旧 agent 不能完成 Job）', () => {
  it('lease 过期并被新 claim 抢占后，旧 agent 的 complete → 409 lease_stale；claim 置 settled，后续写入全拒', async () => {
    const fixture = makeFleet()
    const kernel = fixture.kernel
    kernel.seedJob({ job_id: 'job_fence', project_id: 'prj_1', payload: { runner_target_id: 'remote-gpu-1', image_digest: DIGEST, output_contract: OUT } })
    const { agent, transport } = makeAgent(fixture)
    await agent.register()
    const claims = await agent.claimOnce(1)
    const runId = claims[0]!.plan.run_id
    const oldToken = claims[0]!.plan.lease.token

    // lease 过期 → 另一 fleet 实例（同 owner）重新 claim → generation 2。
    fixture.clock.value = NOW + 301_000
    kernel.expireJob('job_fence')
    const reclaimed = await kernel.claimJobs('fleet-owner', 1)
    expect(reclaimed).toHaveLength(1)
    expect(reclaimed[0]!.lease_generation).toBe(2)
    expect(reclaimed[0]!.lease_token).not.toBe(oldToken)

    // 旧 agent 的 complete → 服务端转发 kernel → 409 lease_stale（既有 fencing）。
    await expect(agent.runClaim(claims[0]!)).rejects.toThrow(/lease_stale/)
    expect(kernel.completes).toHaveLength(0) // 没有合成成功
    expect(kernel.jobs.get('job_fence')?.status).toBe('running') // 未被旧 agent 完成
    expect(kernel.jobs.get('job_fence')?.lease_generation).toBe(2)

    // claim 已 settled：旧 agent 的 frames/complete 之后一律 409 lease_stale。
    await expect(transport.uploadFrames('agent-gpu-1', runId, {
      schema_version: 1,
      frames: [{ seq: 1, frame_kind: 'chunk', channel: 'stdout', text: 'late', byte_offset: 0, byte_length: 4, lease_generation: 1 }],
      owner: 'fleet-owner',
      lease_token: oldToken,
    })).rejects.toMatchObject({ status: 409, code: 'lease_stale' })
    await expect(transport.complete('agent-gpu-1', runId, {
      schema_version: 1,
      claim_id: claims[0]!.claim_id,
      run_id: runId,
      job_id: 'job_fence',
      status: 'succeeded',
      run_manifest: { run_id: runId, signed_by: 'fleet-owner' },
      lease: { owner: 'fleet-owner', generation: 1, token: oldToken },
    })).rejects.toMatchObject({ status: 409, code: 'lease_stale' })
  })

  it('agent last_seen 超时 → claims 被拒（409 agent_offline，retryable）；心跳恢复后可用', async () => {
    const fixture = makeFleet()
    fixture.kernel.seedJob({ job_id: 'job_offline', project_id: 'prj_1', payload: { runner_target_id: 'remote-gpu-1', image_digest: DIGEST } })
    const { agent } = makeAgent(fixture)
    await agent.register()
    fixture.clock.value = NOW + 60_000 // 超过 offline_after_ms（30s）
    await expect(agent.claimOnce(1)).rejects.toMatchObject({ status: 409, code: 'agent_offline' })
    await agent.heartbeat() // 心跳恢复 last_seen
    const claims = await agent.claimOnce(1)
    expect(claims).toHaveLength(1)
  })
})

// ── HTTP 面（x-service-token；生产必须 mTLS）───────────────────────────────

describe('wire HTTP 面（attachRemoteFleetRoutes + HttpRemoteFleetTransport）', () => {
  it('service token 保护：缺失/错误 token → 403 service_token_required；正确 token 全链路可用', async () => {
    const fixture = makeFleet()
    fixture.kernel.seedJob({ job_id: 'job_http', project_id: 'prj_1', payload: { runner_target_id: 'remote-gpu-1', image_digest: DIGEST, output_contract: OUT } })
    const { server, baseUrl } = await startFleetHttpServer(fixture.fleet, { serviceToken: 'svc-tok-1' })
    try {
      // 错误 token / 无 token → 403。
      const badTransport = new HttpRemoteFleetTransport(baseUrl, { serviceToken: 'wrong' })
      await expect(badTransport.register(makeRegistration())).rejects.toMatchObject({
        status: 403,
        code: 'service_token_required',
      })
      const noToken = new HttpRemoteFleetTransport(baseUrl)
      await expect(noToken.heartbeat('agent-gpu-1', { schema_version: 1 })).rejects.toMatchObject({ status: 403 })

      // 正确 token → 注册/心跳/claim/CAS/frames/artifacts/complete 全链路（agent 端到端）。
      const httpTransport = new HttpRemoteFleetTransport(baseUrl, { serviceToken: 'svc-tok-1' })
      const archive = JSON.stringify({
        schema_version: 1,
        files: { 'run.py': { sha256: sha256Hex('print(1)'), content_base64: Buffer.from('print(1)').toString('base64') } },
      })
      const codeSha = fixture.kernel.seedCas(`sha256:${sha256Hex(archive)}`, archive)
      const agentKey = makeKeypair('agent-http')
      fixture.kernel.manifestPublicKeyPem = agentKey.publicKeyPem
      const agent = createRemoteRunnerAgent(
        makeRegistration(),
        httpTransport,
        {
          publicKeyPem: fixture.fleetKey.publicKeyPem,
          signingKey: agentKey.signingKey,
          executor: fakeExecutor([{ channel: 'stdout', text: 'http-ok\n' }]).executor,
        },
      ) as RemoteRunnerAgentImpl
      await agent.register()
      await agent.heartbeat()
      const claims = await agent.claimOnce(1)
      expect(claims).toHaveLength(1)
      // CAS 经 HTTP 拉取并复算。
      const cas = await httpTransport.fetchCas('agent-gpu-1', `sha256:${codeSha}`, 'prj_1')
      expect(cas).not.toBeNull()
      expect(cas!.sha256).toBe(codeSha)
      // 完整执行（frames + artifacts + complete 全部经真实 HTTP）。
      await agent.runClaim(claims[0]!)
      expect(fixture.kernel.jobs.get('job_http')?.status).toBe('succeeded')
      expect(fixture.kernel.completes[0]?.status).toBe('succeeded')
    } finally {
      server.close()
    }
  })
})


// ── §5 两行：secure kinds 容器化 / manifest facts / run_id 绑定 / bytes CAS ──

describe('wire §5 修复（secure kinds 容器化 / manifest facts / run_id 绑定 / bytes CAS）', () => {
  it('secure kind + 远端无 docker → environment 失败 complete（绝不 subprocess 执行）', async () => {
    const fixture = makeFleet()
    fixture.kernel.seedJob({
      job_id: 'job_env', project_id: 'prj_1',
      payload: { runner_target_id: 'remote-gpu-1', image_digest: DIGEST, output_contract: OUT },
    })
    const agentKey = makeKeypair('agent-env')
    fixture.kernel.manifestPublicKeyPem = agentKey.publicKeyPem
    const agent = createRemoteRunnerAgent(
      makeRegistration(),
      new InMemoryFleetTransport(fixture.fleet),
      {
        publicKeyPem: fixture.fleetKey.publicKeyPem,
        signingKey: agentKey.signingKey,
        dockerProbe: async () => false, // 远端无容器运行时
      },
    ) as RemoteRunnerAgentImpl
    await agent.register()
    const claims = await agent.claimOnce(1)
    const outcome = await agent.runClaim(claims[0]!)
    expect(outcome.exit_code).toBe(-1)
    expect(outcome.error).toMatch(/environment:/)
    const job = fixture.kernel.jobs.get('job_env')!
    expect(job.status).toBe('failed')
    expect(fixture.kernel.completes[0]!.status).toBe('failed')
    expect(fixture.kernel.completes[0]!.failure_class).toBe('environment')
    // 没有任何宿主 subprocess 执行——secure kind 只允许 digest-pinned container。
    expect(fixture.kernel.framesFor(claims[0]!.plan.run_id).length).toBeGreaterThan(0) // exit frame 仍上报
    expect(fixture.kernel.completes[0]!.error).toMatch(/environment/)
  })

  it('secure kind + docker 可用 → digest-pinned container 参数（与本地 docker 路径一致）并成功', async () => {
    const fixture = makeFleet()
    fixture.kernel.seedJob({
      job_id: 'job_dkr', project_id: 'prj_1',
      payload: { runner_target_id: 'remote-gpu-1', image_digest: DIGEST, output_contract: OUT, seed: 7 },
    })
    const agentKey = makeKeypair('agent-dkr')
    fixture.kernel.manifestPublicKeyPem = agentKey.publicKeyPem
    const captured: string[][] = []
    const agent = createRemoteRunnerAgent(
      makeRegistration(),
      new InMemoryFleetTransport(fixture.fleet),
      {
        publicKeyPem: fixture.fleetKey.publicKeyPem,
        signingKey: agentKey.signingKey,
        dockerProbe: async () => true,
        containerRun: async (plan, args, ctx) => {
          captured.push(args)
          // 模拟容器写回 MetricsFileV1（secure kind 的 required fact）。
          const outputsDir = join(ctx.cwd ?? '', 'outputs')
          mkdirSync(outputsDir, { recursive: true })
          writeFileSync(join(outputsDir, 'metrics.json'), JSON.stringify({
            schema_version: 1,
            run_id: plan.run_id,
            ...(plan.output_contract.contract_id !== null ? { contract_id: plan.output_contract.contract_id } : {}),
            seed: 7,
            metrics: [{ name: 'm', value: 1, unit: '' }],
          }))
          return {
            run_id: plan.run_id, exit_code: 0,
            started_at: '2026-08-11T12:00:01.000Z', finished_at: '2026-08-11T12:00:02.000Z',
            stdout: '', stderr: '',
          }
        },
      },
    ) as RemoteRunnerAgentImpl
    await agent.register()
    const claims = await agent.claimOnce(1)
    const plan = claims[0]!.plan
    await agent.runClaim(claims[0]!)
    expect(captured).toHaveLength(1)
    const args = captured[0]!
    // digest-pinned image + 完整容器基线（与本地 docker 路径逐项一致）。
    expect(args).toContain(plan.image.digest)
    expect(args).toContain('--network')
    expect(args).toContain('none')
    expect(args).toContain('--read-only')
    expect(args).toContain('--cap-drop')
    expect(args).toContain('--security-opt')
    expect(args).toContain('no-new-privileges')
    expect(args).toContain('65534:65534')
    expect(args).toContain('--pids-limit')
    expect(args.some(a => a.startsWith('DSH_RUN_ID='))).toBe(true)
    expect(fixture.kernel.jobs.get('job_dkr')?.status).toBe('succeeded')
    const manifest = fixture.kernel.jobs.get('job_dkr')!.run_manifest as Record<string, unknown>
    // manifest facts 与 local 同源（唯一 builder）。
    expect(manifest.run_id).toBe(plan.run_id)
    expect(manifest.container_digest).toBe(`docker:${DIGEST}`)
    expect(manifest.seed).toBe(7)
    expect(manifest.metrics_artifact).toMatch(/^sha256:[0-9a-f]{64}$/)
    expect(manifest.code_snapshot_id).toBeNull()
    expect(manifest.data_hash).toBe('')
    expect(manifest.job_id).toBe('job_dkr')
  })

  it('defaultSubprocessExecutor：secure kind / 未标记 trusted_fixture 的 smoke → environment 失败（不 spawn）', async () => {
    const base: JobRecord = {
      job_id: 'job_sec', project_id: 'prj_1', contract_id: null, idempotency_key: 'ik',
      kind: 'formal', command: ['echo', 'host-marker'],
      payload: {
        project_config_pin: `sha256:${'3'.repeat(64)}`,
        runner_target_id: 'remote-gpu-1',
        runner_target_kind: 'remote-ssh',
        runner_target_revision: 1,
        runner_target_hash: TARGET_CONFIG_HASH,
        runner_profile_id: REMOTE_PROFILE.profile_id,
        profile_config_hash: computeProfileConfigHash(REMOTE_PROFILE),
        image_digest: DIGEST,
        runner_compute: { mode: 'cpu' },
      },
      status: 'queued', failure_class: null, lease_owner: null, lease_expires_at: null,
      heartbeat_at: null, lease_generation: 0, lease_token: null, attempts: 0, max_attempts: 3,
      run_manifest: null, error: '', created_at: '2026-08-11T00:00:00.000Z', updated_at: '2026-08-11T00:00:00.000Z',
    }
    const opts = {
      run_id: 'run_sec', lease: { owner: 'o', generation: 1, token: 'tok-sec', expires_at: null },
      timeout_ms: 60000, created_at: '2026-08-11T00:00:00.000Z',
    }
    const secure = await defaultSubprocessExecutor(buildExecutionPlan(base, opts), {})
    expect(secure.exit_code).toBe(-1)
    expect(secure.error).toMatch(/environment:.*host subprocess is prohibited/)

    const untrustedSmoke = await defaultSubprocessExecutor(
      buildExecutionPlan({ ...base, kind: 'smoke', command: ['echo', 'marker'] }, opts),
      {},
    )
    expect(untrustedSmoke.exit_code).toBe(-1)
    expect(untrustedSmoke.error).toMatch(/trusted-smoke-fixture/)

    // 显式 trusted smoke fixture → subprocess 执行成功（唯一豁免）。
    const trusted = await defaultSubprocessExecutor(
      buildExecutionPlan(
        {
          ...base,
          kind: 'smoke',
          command: ['echo', 'trusted-ok'],
          payload: { ...base.payload, trusted_fixture: true },
        },
        opts,
      ),
      {},
    )
    expect(trusted.exit_code).toBe(0)
    expect(trusted.stdout).toContain('trusted-ok')
  })

  it('complete 顶层 run_id 与 claim 不一致 → 422 run_id_mismatch（stale attempt 拒绝）；manifest run_id 不一致同样 422', async () => {
    const fixture = makeFleet()
    fixture.kernel.seedJob({
      job_id: 'job_stale', project_id: 'prj_1',
      payload: { runner_target_id: 'remote-gpu-1', image_digest: DIGEST, output_contract: OUT },
    })
    const { transport } = makeAgent(fixture)
    await transport.register(makeRegistration())
    const claims = await transport.claims('agent-gpu-1', { schema_version: 1, limit: 1 })
    const runId = claims.claims[0]!.plan.run_id
    const lease = { owner: 'fleet-owner', generation: 1, token: claims.claims[0]!.plan.lease.token }
    const staleComplete = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
      schema_version: 1,
      claim_id: claims.claims[0]!.claim_id,
      run_id: runId,
      job_id: 'job_stale',
      status: 'succeeded',
      run_manifest: { run_id: runId, job_id: 'job_stale', exit_code: 0, metrics_artifact: 'sha256:' + 'a'.repeat(64) },
      lease,
      ...overrides,
    })
    // 顶层 run_id = 旧 attempt 的 id → 422 run_id_mismatch。
    await expect(transport.complete('agent-gpu-1', runId, staleComplete({ run_id: 'run_stale_old' }) as never))
      .rejects.toMatchObject({ status: 422, code: 'run_id_mismatch' })
    // manifest.run_id = 旧 attempt → 422（fleet 层 run_id_mismatch）。
    await expect(transport.complete('agent-gpu-1', runId, staleComplete({ run_manifest: { run_id: 'run_stale_old', job_id: 'job_stale', exit_code: 0 } }) as never))
      .rejects.toMatchObject({ status: 422, code: 'run_id_mismatch' })
  })

  it('complete 的 manifest 缺 required facts → 422（fleet 层镜像 kernel 校验）', async () => {
    const fixture = makeFleet()
    fixture.kernel.seedJob({
      job_id: 'job_facts', project_id: 'prj_1',
      payload: { runner_target_id: 'remote-gpu-1', image_digest: DIGEST, output_contract: OUT },
    })
    const { transport } = makeAgent(fixture)
    await transport.register(makeRegistration())
    const claims = await transport.claims('agent-gpu-1', { schema_version: 1, limit: 1 })
    const runId = claims.claims[0]!.plan.run_id
    const lease = { owner: 'fleet-owner', generation: 1, token: claims.claims[0]!.plan.lease.token }
    const completeWith = (manifest: Record<string, unknown>): Promise<unknown> => transport.complete('agent-gpu-1', runId, {
      schema_version: 1,
      claim_id: claims.claims[0]!.claim_id,
      run_id: runId,
      job_id: 'job_facts',
      status: 'succeeded',
      run_manifest: manifest,
      lease,
    } as never)
    // 缺 metrics_artifact → 422 manifest_facts_missing。
    await expect(completeWith({ run_id: runId, job_id: 'job_facts', exit_code: 0, container_digest: `docker:${DIGEST}` }))
      .rejects.toMatchObject({ status: 422, code: 'manifest_facts_missing' })
    // metrics_artifact 空串同样缺失。
    await expect(completeWith({ run_id: runId, job_id: 'job_facts', exit_code: 0, metrics_artifact: '' }))
      .rejects.toMatchObject({ status: 422, code: 'manifest_facts_missing' })
    // container_digest 与 digest-pinned image 不一致 → 422 manifest_container_mismatch。
    await expect(completeWith({ run_id: runId, job_id: 'job_facts', exit_code: 0, metrics_artifact: 'sha256:' + 'a'.repeat(64), container_digest: 'docker:evil@sha256:' + '0'.repeat(64) }))
      .rejects.toMatchObject({ status: 422, code: 'manifest_container_mismatch' })
  })

  it('CAS bytes round-trip：随机二进制（NUL/0xFF）逐字节一致；project binding 拒绝越权 project', async () => {
    const fixture = makeFleet()
    const bytes = Buffer.from([0x00, 0xff, 0x10, 0x7f, 0x00, 0x80, 0x01, 0xfe, 0x00, 0x00, 0x41, 0xc3, 0x28])
    const dataSha = sha256HexBytes(bytes)
    fixture.kernel.seedCas(`sha256:${dataSha}`, bytes)
    fixture.kernel.seedJob({
      job_id: 'job_bin', project_id: 'prj_1',
      payload: { runner_target_id: 'remote-gpu-1', image_digest: DIGEST, output_contract: OUT },
      data_artifact_ids: [`sha256:${dataSha}`],
    })
    const { agent, transport } = makeAgent(fixture)
    await agent.register()
    const claims = await agent.claimOnce(1)
    // CAS 内容逐字节一致（不经过 text()/UTF-8 round-trip；claim 未 settle 时可拉）。
    const cas = await transport.fetchCas('agent-gpu-1', `sha256:${dataSha}`, 'prj_1')
    expect(cas).not.toBeNull()
    expect(Buffer.from(cas!.content_base64, 'base64')).toEqual(bytes)
    expect(cas!.sha256).toBe(dataSha)
    // agent 拉取并复算 hash（字节语义——UTF-8 编解码会损坏 → 拒绝执行）。
    await agent.runClaim(claims[0]!)
    expect(fixture.kernel.jobs.get('job_bin')?.status).toBe('succeeded')
    // caller 声明 project_id 不能越过 claim 所属项目 → 403 cas_project_forbidden
    // （完成后的 claim 已 settle，也不再放行）。
    await expect(transport.fetchCas('agent-gpu-1', `sha256:${dataSha}`, 'prj_foreign'))
      .rejects.toMatchObject({ status: 403, code: 'cas_project_forbidden' })
  })
})

// ── 篡改 CAS 传输辅助 ──────────────────────────────────────────────────────

/** 包装传输：可把 CAS 响应声明的 hash 换成错误值（模拟链路损坏）。 */
class TamperingCasTransport implements RemoteFleetTransport {
  readonly kind = 'tampering-cas'
  tamper = true
  constructor(private readonly inner: RemoteFleetTransport) {}

  register(req: AgentRegisterRequest): Promise<AgentRegisterResponse> {
    return this.inner.register(req)
  }
  heartbeat(agentId: string, req: AgentHeartbeatRequest): Promise<AgentHeartbeatResponse> {
    return this.inner.heartbeat(agentId, req)
  }
  claims(agentId: string, req: AgentClaimRequest): Promise<AgentClaimResponse> {
    return this.inner.claims(agentId, req)
  }
  uploadFrames(agentId: string, runId: string, req: RemoteFramesRequest): Promise<RemoteFramesResponse> {
    return this.inner.uploadFrames(agentId, runId, req)
  }
  stageArtifact(agentId: string, runId: string, req: RemoteArtifactStageRequest): Promise<RemoteArtifactStageResponse> {
    return this.inner.stageArtifact(agentId, runId, req)
  }
  finalizeArtifact(agentId: string, runId: string, req: RemoteArtifactFinalizeRequest): Promise<RemoteArtifactFinalizeResponse> {
    return this.inner.finalizeArtifact(agentId, runId, req)
  }
  complete(agentId: string, runId: string, req: RemoteCompleteRequest): Promise<RemoteCompleteResponse> {
    return this.inner.complete(agentId, runId, req)
  }
  async fetchCas(agentId: string, sha: string, projectId: string): Promise<CasFetchResponse | null> {
    const response = await this.inner.fetchCas(agentId, sha, projectId)
    if (response === null || !this.tamper) return response
    return { ...response, sha256: 'f'.repeat(64) } // 声明 hash ≠ 内容 hash
  }
}

// Review 2026-09-06: exercise the failures hidden by single-run happy paths.
describe('remote lifecycle regression', () => {
  it('replays a finalize whose success response was lost and completes through Agent spool', async () => {
    const fixture = makeFleet()
    fixture.kernel.seedJob({ job_id: 'lost-finalize', project_id: 'prj_1', payload: { output_contract: OUT } })
    const { agent, transport } = makeAgent(fixture, { executor: fakeExecutor([{ channel: 'stdout', text: 'spool\n' }]).executor })
    const finalize = transport.finalizeArtifact.bind(transport)
    const registered = vi.spyOn(fixture.kernel, 'registerJobArtifact')
    vi.spyOn(transport, 'finalizeArtifact').mockImplementationOnce(async (...args) => {
      await finalize(...args)
      throw new RemoteWireError(0, 'transport_unreachable', 'response lost after commit', true)
    })
    await claimAndRun(agent)
    expect(fixture.kernel.jobs.get('lost-finalize')?.status).toBe('succeeded')
    expect(agent.spoolStats().entries).toBe(0)
    expect(registered).toHaveBeenCalledTimes(2) // log + metrics, each exactly once
  })

  it('preserves a failed stage before finalize and replays a lost complete response', async () => {
    const fixture = makeFleet()
    fixture.kernel.seedJob({ job_id: 'stage-order', project_id: 'prj_1', payload: { output_contract: OUT } })
    const { agent, transport } = makeAgent(fixture, { executor: fakeExecutor([{ channel: 'stdout', text: 'spool\n' }]).executor })
    vi.spyOn(transport, 'stageArtifact').mockRejectedValueOnce(new RemoteWireError(503, 'unavailable', 'stage unavailable', true))
    const complete = transport.complete.bind(transport)
    vi.spyOn(transport, 'complete').mockImplementationOnce(async (...args) => {
      await complete(...args)
      throw new RemoteWireError(0, 'transport_unreachable', 'complete response lost', true)
    })
    await claimAndRun(agent)
    await agent.flushSpool()
    expect(fixture.kernel.jobs.get('stage-order')?.status).toBe('succeeded')
    expect(fixture.kernel.completes).toHaveLength(1)
    expect(agent.spoolStats().entries).toBe(0)
  })

  it('bounds terminal receipts separately and expires them without retaining capacity', async () => {
    const fixture = makeFleet({ maxReceipts: 2, receiptTtlMs: 1000 })
    const { agent } = makeAgent(fixture, { executor: fakeExecutor([{ channel: 'stdout', text: 'ok\n' }]).executor })
    await agent.register()
    for (let i = 0; i < 5; i++) {
      fixture.kernel.seedJob({ job_id: `receipt-${i}`, project_id: 'prj_1', payload: { output_contract: OUT } })
      const [claim] = await agent.claimOnce()
      await agent.runClaim(claim!)
      expect(fixture.fleet.stats().settled_receipts).toBeLessThanOrEqual(2)
      expect(fixture.fleet.stats().artifact_receipts).toBeLessThanOrEqual(2)
    }
    fixture.clock.value += 1001
    expect(fixture.fleet.stats()).toMatchObject({ outstanding: 0, stages: 0, settled_receipts: 0, artifact_receipts: 0 })
  })
  it('releases capacity after every completion, including beyond the default eight claims', async () => {
    const fixture = makeFleet()
    const { agent } = makeAgent(fixture, { executor: fakeExecutor([{ channel: 'stdout', text: 'ok\n' }]).executor })
    await agent.register()
    for (let i = 0; i < 12; i++) {
      fixture.kernel.seedJob({ job_id: `capacity-${i}`, project_id: 'prj_1', payload: { output_contract: OUT } })
      const claims = await agent.claimOnce()
      expect(claims, `claim ${i + 1}`).toHaveLength(1)
      await agent.runClaim(claims[0]!)
      expect(fixture.kernel.jobs.get(`capacity-${i}`)?.status).toBe('succeeded')
      expect(fixture.fleet.stats().outstanding).toBe(0)
    }
  })

  it('prunes a full pending queue and dispatches a recovered attempt of the same job', async () => {
    const fixture = makeFleet({ maxPendingJobs: 1 })
    fixture.kernel.seedJob({ job_id: 'recovered', project_id: 'prj_1' })
    expect(await fixture.fleet.pump()).toBe(1)
    const first = fixture.kernel.jobs.get('recovered')!
    fixture.clock.value += 301_000
    expect(await fixture.fleet.pump()).toBe(1)
    const { agent } = makeAgent(fixture)
    await agent.register()
    await agent.heartbeat()
    const claims = await agent.claimOnce()
    expect(claims).toHaveLength(1)
    expect(claims[0]!.plan.run_id).not.toBe(first.run_id)
    expect(claims[0]!.lease.generation).toBe(2)
    expect(fixture.fleet.stats()).toMatchObject({ pending: 0, outstanding: 1 })
  })

  it('retries a failed finalize and returns a receipt after a lost successful response', async () => {
    const fixture = makeFleet()
    fixture.kernel.seedJob({ job_id: 'finalize-retry', project_id: 'prj_1' })
    const { agent } = makeAgent(fixture)
    await agent.register()
    const [claim] = await agent.claimOnce()
    const runId = claim!.plan.run_id
    const content = 'retryable artifact'
    const request: RemoteArtifactFinalizeRequest = {
      schema_version: 1, run_id: runId, stage_id: 'stable-stage', content_base64: Buffer.from(content).toString('base64'),
    }
    fixture.fleet.handleStageArtifact(agent.agent_id, runId, {
      schema_version: 1, run_id: runId, stage_id: request.stage_id, sha256: sha256Hex(content), size: Buffer.byteLength(content), kind: 'log',
    })
    const register = vi.spyOn(fixture.kernel, 'registerJobArtifact').mockRejectedValueOnce(kernelError(503, 'temporarily_unavailable', 'try again'))
    await expect(fixture.fleet.handleFinalizeArtifact(agent.agent_id, runId, request)).rejects.toMatchObject({ status: 503, retryable: true })
    const response = await fixture.fleet.handleFinalizeArtifact(agent.agent_id, runId, request)
    const replay = await fixture.fleet.handleFinalizeArtifact(agent.agent_id, runId, request)
    expect(replay).toMatchObject({ artifact_id: response.artifact_id, sha256: response.sha256, reused: true })
    expect(register).toHaveBeenCalledTimes(2)
    expect(fixture.fleet.stats().stages).toBe(0)
  })

  it('coalesces concurrent finalizes and rejects reuse of a stage id for different metadata', async () => {
    const fixture = makeFleet()
    fixture.kernel.seedJob({ job_id: 'finalize-concurrent', project_id: 'prj_1' })
    const { agent } = makeAgent(fixture)
    await agent.register()
    const [claim] = await agent.claimOnce()
    const runId = claim!.plan.run_id
    const stage: RemoteArtifactStageRequest = {
      schema_version: 1, run_id: runId, stage_id: 'same-stage', sha256: sha256Hex('abc'), size: 3, kind: 'log',
    }
    fixture.fleet.handleStageArtifact(agent.agent_id, runId, stage)
    expect(() => fixture.fleet.handleStageArtifact(agent.agent_id, runId, { ...stage, kind: 'data' }))
      .toThrow(expect.objectContaining({ code: 'stage_conflict' }))
    const register = vi.spyOn(fixture.kernel, 'registerJobArtifact')
    const finalize: RemoteArtifactFinalizeRequest = { schema_version: 1, run_id: runId, stage_id: stage.stage_id!, content_base64: 'YWJj' }
    const responses = await Promise.all([
      fixture.fleet.handleFinalizeArtifact(agent.agent_id, runId, finalize),
      fixture.fleet.handleFinalizeArtifact(agent.agent_id, runId, finalize),
    ])
    expect(responses[0]!.artifact_id).toBe(responses[1]!.artifact_id)
    expect(register).toHaveBeenCalledTimes(1)
  })
})
