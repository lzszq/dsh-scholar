/**
 * FLEET-01 — 生产 runner 二进制接线（docs/remote-runner-wire.md §9 生产接线、
 * hardening-v0.2-status.md §8 FLEET-01 行）。
 *
 * 覆盖（全部经真实 HTTP——startFleetServer 起 node:http listener +
 * HttpRemoteFleetTransport 客户端，mock 远端 = FakeFleetKernel）：
 * - CLI 角色判定与互斥：--fleet-server/--agent/缺省 local 三态；
 *   --fleet-server 与 --agent 同给 → FleetCliConfigError；fleet 角色与
 *   --mode 同给 → FleetCliConfigError（--mode 仅本地模式有意义）；
 *   registry 新增 fleet 键可解析/可校验（parseCli + validateConfig），
 *   未知 flag 仍 unknown_config_key；
 * - buildAgentRegistration/resolveTargetId/generateAgentId：安全摘要形状
 *   （opaque target/agent id、images 空 = 接受锁内 digest、cert_fingerprint
 *   null = 无 mTLS 如实记录）；
 * - startFleetServer：固定端口绑定 + baseUrl 可达 + x-service-token 鉴权
 *   （缺失 → 403 service_token_required）；
 * - 全链（真实 HTTP）：runFleetAgentMain 客户端循环 register → heartbeat →
 *   claim（含签名 plan 验签）→ 执行 → frames/artifacts/complete，Job 完成
 *   succeeded，frames/artifacts/complete 全部经 HTTP 送达；
 * - 离线 spool 恢复（HTTP 层）：断网期间 frames/stage/finalize/complete
 *   进本地有界 spool，恢复后按序重放完成 Job；
 * - 无匹配 target → 任务留在服务端 pending（retryable，不静默改派），
 *   匹配 target 的 agent 注册后拿到同一 Job。
 *
 * 真实 mTLS 证书链（CA/第二主机）无环境，如实记录（remote-runner-wire.md
 * §3/§9：生产必须 mTLS；本测试用 x-service-token 等价实现）。
 */
import { createHash, createPublicKey, generateKeyPairSync, verify } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { createServer as createHttpServer } from 'node:http'
import { createServer as createTcpServer } from 'node:net'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  ConfigRegistryError,
  computeProfileConfigHash,
  getRunnerProfile,
  parseCli,
  validateConfig,
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
  appendTerminalFramesWithLease,
  buildAgentRegistration,
  canonicalJson,
  createFleetKernelClient,
  createRemoteRunnerAgent,
  FailingFleetTransport,
  FleetCliConfigError,
  generateAgentId,
  HttpRemoteFleetTransport,
  InMemoryAgentRegistry,
  RemoteFleetServer,
  resolveFleetMode,
  resolveTargetId,
  runFleetAgentMain,
  startFleetServer,
  type AgentExecutor,
  type AgentExecutionContext,
  type FleetKernelClient,
  type RemoteFleetServerOptions,
  type RemoteFleetTransport,
  type RemoteRunnerAgentImpl,
  type RunnerSigningKey,
} from '@dsh-scholar/runner-gateway'
import { ResearchClient } from '@dsh-scholar/research-client'

// ── Fake kernel（实现 FleetKernelClient；镜像 kernel 的 lease fencing 与
//    §12.7 manifest 验签语义——与 remote-wire.test.ts 同一契约）───────────

const DIGEST = 'node@sha256:c610fcdfb1d5b4740dd70c284ed3cb16bb857e0f7166196e36a5501df7a3aa32'

function kernelError(status: number, code: string, message: string): Error {
  return Object.assign(new Error(message), { status, code })
}

function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

function sha256HexBytes(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex')
}

/** secure kinds 的 output contract（metrics 路径；fake executor 据此写 MetricsFileV1）。 */
const OUT = { metrics: 'metrics.json' }
const REMOTE_PROFILE = getRunnerProfile('profile_local_docker_cpu_v1')!

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
}

class FakeFleetKernel implements FleetKernelClient {
  now: () => number = Date.now
  readonly jobs = new Map<string, JobRecord & { run_id?: string | null }>()
  /** artifact id（含 sha256: 前缀/裸 hex）→ {sha256, content}（**字节**，CAS 语义）。 */
  readonly artifacts = new Map<string, { sha256: string; content: Buffer }>()
  /** secure kinds 的 required-facts 校验开关（默认开——镜像 kernel verifySecureRunFacts）。 */
  enforceSecureFacts = true
  readonly frames: RecordedFrame[] = []
  readonly completes: RecordedComplete[] = []
  manifestPublicKeyPem: string | null = null

  async getRunnerTarget(targetId: string) {
    return {
      target_id: targetId,
      kind: 'remote-ssh' as const,
      enabled: true,
      draining: false,
      revision: 1,
      config_hash: `sha256:${'7'.repeat(64)}`,
    }
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
      project_config_pin: `sha256:${'4'.repeat(64)}`,
      runner_target_id: 'remote-gpu-1',
      runner_target_kind: 'remote-ssh',
      runner_target_revision: 1,
      runner_target_hash: `sha256:${'7'.repeat(64)}`,
      runner_profile_id: REMOTE_PROFILE.profile_id,
      profile_config_hash: computeProfileConfigHash(REMOTE_PROFILE),
      image_digest: REMOTE_PROFILE.image,
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

  framesFor(runId: string): RecordedFrame[] {
    return this.frames.filter(f => f.run_id === runId).sort((a, b) => a.frame.seq - b.frame.seq)
  }

  async claimJobs(owner: string, limit: number, ttl = 300): Promise<JobRecord[]> {
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
      if (f.seq <= cursor) continue
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

  async registerArtifact(input: {
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

const NOW = Date.parse('2026-08-11T12:00:00.000Z')

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
    // §12.5：模拟容器写回 MetricsFileV1（secure kinds 的 required fact）。
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

/** 等待条件成立（轮询；超时抛错）。 */
async function waitFor(predicate: () => boolean, timeoutMs = 10_000, label = 'condition'): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  throw new Error(`timed out waiting for ${label}`)
}

/** 找一个空闲端口（先 bind :0 取端口再关闭；测试专用，微小竞态可接受）。 */
async function freePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const probe = createTcpServer()
    probe.once('error', reject)
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address()
      if (address === null || typeof address === 'string') {
        probe.close()
        reject(new Error('probe failed to bind'))
        return
      }
      const port = address.port
      probe.close(() => resolve(port))
    })
  })
}

// ── CLI 角色判定与互斥 ────────────────────────────────────────────────────

describe('FLEET-01 CLI 角色判定（resolveFleetMode + parseCli + registry）', () => {
  it('缺省 local；--fleet-server → fleet-server；--agent → agent', () => {
    expect(resolveFleetMode(parseCli([], 'runner-profile'))).toBe('local')
    expect(resolveFleetMode(parseCli(['--fleet-server', '7415'], 'runner-profile'))).toBe('fleet-server')
    expect(resolveFleetMode(parseCli(['--agent', 'http://127.0.0.1:7415'], 'runner-profile'))).toBe('agent')
    // 附带 agent 专属 flag 不改变角色。
    expect(resolveFleetMode(parseCli(
      ['--agent', 'http://127.0.0.1:7415', '--agent-id', 'a-1', '--target-id', 't-1', '--fleet-public-key', '/tmp/k.pem'],
      'runner-profile',
    ))).toBe('agent')
  })

  it('--fleet-server 与 --agent 同给 → FleetCliConfigError（互斥）', () => {
    expect(() => resolveFleetMode(parseCli(
      ['--fleet-server', '7415', '--agent', 'http://127.0.0.1:7416'],
      'runner-profile',
    ))).toThrow(FleetCliConfigError)
    expect(() => resolveFleetMode(parseCli(
      ['--fleet-server', '7415', '--agent', 'http://127.0.0.1:7416'],
      'runner-profile',
    ))).toThrow(/mutually exclusive/)
  })

  it('fleet 角色与 --mode 同给 → FleetCliConfigError（--mode 仅本地模式有意义）', () => {
    for (const fleetFlags of [['--fleet-server', '7415'], ['--agent', 'http://127.0.0.1:7415']]) {
      expect(() => resolveFleetMode(parseCli([...fleetFlags, '--mode', 'docker'], 'runner-profile')))
        .toThrow(/only meaningful in local runner mode/)
    }
  })

  it('registry：fleet 键可解析、可校验、默认合并、未知 flag 仍拒绝', () => {
    const cli = parseCli(
      ['--fleet-server', '7415', '--agent-id', 'a-1', '--target-id', 't-1', '--fleet-public-key', '/tmp/k.pem'],
      'runner-profile',
    )
    expect(cli['runner.fleet_server_port']).toBe(7415)
    expect(cli['runner.agent_id']).toBe('a-1')
    const resolved = validateConfig(cli, { scopes: ['runner-profile'] })
    expect(resolved.effective['runner.fleet_server_port']).toBe(7415)
    expect(resolved.effective['runner.fleet_url']).toBe('') // 未提供 → 默认
    expect(resolved.effective['runner.agent_id']).toBe('a-1')
    expect(resolved.effective['runner.fleet_target_id']).toBe('t-1')
    expect(resolved.effective['runner.fleet_public_key']).toBe('/tmp/k.pem')
    expect(resolved.pinHash).toMatch(/^sha256:/)
    // 端口越界 → validateConfig 层 validation_error（parseCli 只做数字转换）。
    expect(() => validateConfig(parseCli(['--fleet-server', '99999'], 'runner-profile'), { scopes: ['runner-profile'] }))
      .toThrow(ConfigRegistryError)
    // 未知 flag 仍 unknown_config_key（fleet 键之外没有新 flag 面）。
    expect(() => parseCli(['--fleet-serve'], 'runner-profile')).toThrow(/unknown CLI flag/)
  })

  it('buildAgentRegistration/resolveTargetId/generateAgentId：安全摘要形状与缺省', () => {
    const registration = buildAgentRegistration({
      agentId: 'agent-cli-1',
      targetId: 'remote-gpu-1',
      runnerVersion: '0.1.0',
      labels: { rack: 'b' },
    })
    expect(registration.target_id).toBe('remote-gpu-1')
    expect(registration.agent_id).toBe('agent-cli-1')
    expect(registration.capabilities.images).toEqual([]) // 接受锁内 digest
    expect(registration.capabilities.runner_ver).toBe('0.1.0')
    expect(registration.health.status).toBe('online')
    expect(registration.cert_fingerprint).toBeNull() // 无 mTLS 如实记录
    expect(registration.labels).toMatchObject({ role: 'remote-agent', rack: 'b' })
    expect(resolveTargetId('')).toBe('local-docker')
    expect(resolveTargetId(undefined)).toBe('local-docker')
    expect(resolveTargetId('t-1')).toBe('t-1')
    expect(generateAgentId()).toMatch(/^agent-[0-9a-f]{8}$/)
    expect(generateAgentId()).not.toBe(generateAgentId())
  })
})

// ── HTTP 传输（真实 node:http listener）───────────────────────────────────

describe('FLEET-01 HTTP 传输（startFleetServer 真实 listener + HttpRemoteFleetTransport）', () => {
  it('固定端口绑定 + baseUrl 可达 + x-service-token 缺失 → 403 service_token_required', async () => {
    const fixture = makeFleet()
    const port = await freePort()
    const { server, baseUrl } = await startFleetServer(fixture.fleet, { port, serviceToken: 'svc-tok' })
    try {
      expect(baseUrl).toBe(`http://127.0.0.1:${port}`)
      const transport = new HttpRemoteFleetTransport(baseUrl)
      await expect(transport.register(makeRegistration())).rejects.toMatchObject({
        status: 403,
        code: 'service_token_required',
      })
      const authed = new HttpRemoteFleetTransport(baseUrl, { serviceToken: 'svc-tok' })
      const response = await authed.register(makeRegistration())
      expect(response.acknowledged).toBe(true)
      expect(fixture.registry.get('agent-gpu-1')).toBeDefined()
    } finally {
      server.close()
    }
  })

  it('无匹配 target → 任务留在服务端 pending（retryable，不静默改派）；匹配 agent 后拿到同一 Job', async () => {
    const fixture = makeFleet()
    fixture.kernel.seedJob({ job_id: 'job_nomatch', project_id: 'prj_1', payload: { runner_target_id: 'other-target', image_digest: DIGEST } })
    const { server, baseUrl } = await startFleetServer(fixture.fleet)
    try {
      const wrongAgent = createRemoteRunnerAgent(
        makeRegistration({ target_id: 'remote-gpu-1', agent_id: 'agent-wrong' }),
        new HttpRemoteFleetTransport(baseUrl),
        { publicKeyPem: fixture.fleetKey.publicKeyPem, executor: fakeExecutor().executor },
      ) as RemoteRunnerAgentImpl
      await wrongAgent.register()
      const claims = await wrongAgent.claimOnce(1)
      expect(claims).toHaveLength(0) // 无匹配 → 空 claim
      expect(fixture.kernel.jobs.get('job_nomatch')?.status).toBe('running') // 已被服务端 claim 保留
      expect(fixture.fleet.stats().pending).toBe(1) // 任务留在 pending（retryable）
      expect(fixture.kernel.completes).toHaveLength(0) // 未静默改派/未执行

      // 匹配 target 的 agent 注册后拿到同一 Job（同一 claim_id/run_id/lease）。
      const rightAgent = createRemoteRunnerAgent(
        makeRegistration({ target_id: 'other-target', agent_id: 'agent-right' }),
        new HttpRemoteFleetTransport(baseUrl),
        { publicKeyPem: fixture.fleetKey.publicKeyPem, executor: fakeExecutor().executor },
      ) as RemoteRunnerAgentImpl
      await rightAgent.register()
      const matched = await rightAgent.claimOnce(1)
      expect(matched).toHaveLength(1)
      expect(matched[0]!.plan.job_id).toBe('job_nomatch')
      expect(matched[0]!.plan.target_id).toBe('other-target')
    } finally {
      server.close()
    }
  })

  it('全链（真实 HTTP）：runFleetAgentMain 客户端循环 register→heartbeat→claim→执行→frames/artifacts/complete', async () => {
    const fixture = makeFleet()
    fixture.kernel.seedJob({ job_id: 'job_cli', project_id: 'prj_1', payload: { runner_target_id: 'local-docker', image_digest: DIGEST, output_contract: OUT } })
    const { server, baseUrl } = await startFleetServer(fixture.fleet)
    try {
      const agentKey = makeKeypair('agent-cli')
      fixture.kernel.manifestPublicKeyPem = agentKey.publicKeyPem
      const controller = new AbortController()
      const runPromise = runFleetAgentMain({
        fleetUrl: baseUrl,
        agentId: 'agent-cli-1',
        targetId: 'local-docker',
        runnerVersion: '0.1.0',
        publicKeyPem: fixture.fleetKey.publicKeyPem,
        signingKey: agentKey.signingKey,
        executor: fakeExecutor([
          { channel: 'stdout', text: 'cli-ok\n' },
          { channel: 'stderr', text: 'cli-warn\n' },
        ]).executor,
        pollIntervalMs: 25,
        signal: controller.signal,
      })
      await waitFor(() => fixture.kernel.jobs.get('job_cli')?.status === 'succeeded', 15_000, 'job_cli succeeded')
      controller.abort()
      await runPromise
      // frames/artifacts/complete 全部经真实 HTTP 送达。
      const runId = fixture.kernel.completes[0]?.run_manifest?.run_id as string | undefined
      expect(runId).toBeDefined()
      const frames = fixture.kernel.framesFor(runId!)
      expect(frames.map(f => f.frame.seq)).toEqual([1, 2, 3])
      expect(frames[2]!.frame.frame_kind).toBe('exit')
      expect(fixture.kernel.completes).toHaveLength(1)
      expect(fixture.kernel.completes[0]!.status).toBe('succeeded')
      expect(fixture.kernel.completes[0]!.lease_generation).toBeGreaterThan(0)
      expect(fixture.registry.get('agent-cli-1')).toBeDefined()
    } finally {
      server.close()
    }
  })

  it('离线 spool 恢复（HTTP 层）：断网期间全量进本地有界 spool，恢复后按序重放完成 Job', async () => {
    const fixture = makeFleet()
    fixture.kernel.seedJob({ job_id: 'job_spool_http', project_id: 'prj_1', payload: { runner_target_id: 'remote-gpu-1', image_digest: DIGEST, output_contract: OUT } })
    const { server, baseUrl } = await startFleetServer(fixture.fleet)
    try {
      const failing = new FailingFleetTransport(new HttpRemoteFleetTransport(baseUrl))
      const agentKey = makeKeypair('agent-spool-http')
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
          ]).executor,
        },
      ) as RemoteRunnerAgentImpl
      await agent.register() // 在线
      const claims = await agent.claimOnce(1)
      expect(claims).toHaveLength(1)
      const runId = claims[0]!.plan.run_id

      failing.networkUp = false // 断网（HTTP 层 transport_unreachable）
      await agent.runClaim(claims[0]!)
      expect(agent.spoolStats().entries).toBeGreaterThan(0)
      expect(fixture.kernel.framesFor(runId)).toHaveLength(0) // 未送达
      expect(fixture.kernel.completes).toHaveLength(0)
      expect(fixture.kernel.jobs.get('job_spool_http')?.status).toBe('running') // 无合成成功

      failing.networkUp = true // 恢复 → 按序重放
      await agent.flushSpool()
      expect(agent.spoolStats().entries).toBe(0)
      expect(fixture.kernel.completes).toHaveLength(1)
      expect(fixture.kernel.completes[0]!.status).toBe('succeeded')
      expect(fixture.kernel.jobs.get('job_spool_http')?.status).toBe('succeeded')
      expect(fixture.kernel.framesFor(runId).map(f => f.frame.seq)).toEqual([1, 2, 3])
    } finally {
      server.close()
    }
  })

  it('未注册 agent 的 claims → 404 agent_not_registered（HTTP 层 fail closed）', async () => {
    const fixture = makeFleet()
    const { server, baseUrl } = await startFleetServer(fixture.fleet)
    try {
      const transport = new HttpRemoteFleetTransport(baseUrl)
      await expect(transport.claims('agent-ghost', { schema_version: 1, limit: 1 })).rejects.toMatchObject({
        status: 404,
        code: 'agent_not_registered',
      })
    } finally {
      server.close()
    }
  })

  it('kernel Bearer fail fast + CAS bytes round-trip：无 token 的 fleet 对 token-required kernel 立即 401（非 retryable，不静默当 cas_missing）；带 token 字节往返一致', async () => {
    // 真实 HTTP kernel stub：要求 Authorization: Bearer，否则 401；artifact 以
    // 原始字节响应（含 NUL/0xFF——UTF-8 text round-trip 会损坏）。
    const bytes = Buffer.from([0x00, 0xff, 0x9c, 0x01, 0x00, 0x80, 0x0a, 0x0d, 0xfe, 0x41])
    const seen: Array<{ path: string; authed: boolean }> = []
    const kernelServer = createHttpServer((req, res) => {
      const authed = req.headers.authorization === 'Bearer kt-1'
      seen.push({ path: req.url ?? '', authed })
      if (!authed) {
        res.writeHead(401, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: { code: 'unauthorized', message: 'missing bearer token', retryable: false } }))
        return
      }
      if ((req.method ?? 'GET') === 'POST' && (req.url ?? '').startsWith('/v1/jobs-claim/run')) {
        const job: JobRecord & { run_id?: string | null } = {
          job_id: 'job_bearer', project_id: 'prj_1', contract_id: null, idempotency_key: 'ik-bearer',
          kind: 'formal', command: [], payload: {
            project_config_pin: `sha256:${'4'.repeat(64)}`,
            runner_target_id: 'remote-gpu-1',
            runner_target_kind: 'remote-ssh',
            runner_target_revision: 1,
            runner_target_hash: `sha256:${'7'.repeat(64)}`,
            runner_profile_id: REMOTE_PROFILE.profile_id,
            profile_config_hash: computeProfileConfigHash(REMOTE_PROFILE),
            image_digest: DIGEST,
            runner_compute: { mode: 'cpu' },
            output_contract: OUT,
          },
          status: 'running', failure_class: null, lease_owner: 'fleet-owner', lease_expires_at: '2099-01-01T00:00:00.000Z',
          heartbeat_at: null, lease_generation: 1, lease_token: 'lt-1', attempts: 1, max_attempts: 3,
          run_manifest: null, error: '', created_at: '2026-08-11T00:00:00.000Z', updated_at: '2026-08-11T00:00:00.000Z',
          run_id: 'run_bearer_1',
        }
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify([job]))
        return
      }
      if ((req.method ?? 'GET') === 'GET' && (req.url ?? '').startsWith('/v1/runner-targets/')) {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({
          target_id: 'remote-gpu-1', kind: 'remote-ssh', enabled: true, draining: false,
          revision: 1, config_hash: `sha256:${'7'.repeat(64)}`,
        }))
        return
      }
      res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': String(bytes.byteLength) })
      res.end(bytes)
    })
    await new Promise<void>(resolve => kernelServer.listen(0, '127.0.0.1', resolve))
    const address = kernelServer.address()
    if (address === null || typeof address === 'string') throw new Error('bind failed')
    const endpoint = `http://127.0.0.1:${address.port}`
    try {
      // 1) ResearchClient 层：fetchArtifactBytes 对 401 抛 KernelApiError（fail
      //    fast，不返回 null 冒充 cas_missing）；legacy text 变体保持 null。
      const bareClient = new ResearchClient({ endpoint })
      await expect(bareClient.fetchArtifactBytes('prj_1', 'sha256:aa')).rejects.toMatchObject({ status: 401 })
      expect(await bareClient.fetchArtifact('prj_1', 'sha256:aa')).toBeNull()

      // 2) fleet 层 fail fast：无 kernel token 的 fleet server 在 claim/pump
      //    即被 kernel 401 拒绝（非 retryable kernel_unauthorized——任务绝不
      //    滞留 pending 假装可执行；也不是 cas_missing 404）。
      const noToken = new RemoteFleetServer({
        registry: new InMemoryAgentRegistry(),
        client: createFleetKernelClient(new ResearchClient({ endpoint })),
        owner: 'fleet-owner',
        now: () => NOW,
      })
      noToken.handleRegister(makeRegistration())
      await expect(noToken.handleClaims('agent-gpu-1', { schema_version: 1, limit: 1 }))
        .rejects.toMatchObject({ status: 401, retryable: false })
      expect(seen.some(r => r.path.startsWith('/v1/jobs-claim/'))).toBe(true)

      // 3) 带 kernel token：claim 成功 + CAS 字节往返 hash/size 完全一致。
      const withToken = new RemoteFleetServer({
        registry: new InMemoryAgentRegistry(),
        client: createFleetKernelClient(new ResearchClient({ endpoint, token: 'kt-1' })),
        owner: 'fleet-owner',
        now: () => NOW,
      })
      withToken.handleRegister(makeRegistration())
      const claims2 = await withToken.handleClaims('agent-gpu-1', { schema_version: 1, limit: 1 })
      expect(claims2.claims).toHaveLength(1)
      const cas = await withToken.handleCas('agent-gpu-1', `sha256:${bytes.toString('hex')}`, 'prj_1')
      expect(cas.content_base64).toBe(bytes.toString('base64'))
      expect(cas.sha256).toBe(createHash('sha256').update(bytes).digest('hex'))
      expect(Buffer.from(cas.content_base64, 'base64')).toEqual(bytes)
      const artifactSeen = seen.filter(r => r.path.startsWith('/v1/artifacts/'))
      expect(artifactSeen.length).toBeGreaterThan(0)
      // 最后一条 artifact 请求来自带 token 的 client → 必须带 Bearer。
      expect(artifactSeen[artifactSeen.length - 1]!.authed).toBe(true)
    } finally {
      kernelServer.close()
    }
  })

  it('appendTerminalFramesWithLease：request 绑定 client（timeoutMs 回归），lease 头/体原样送达', async () => {
    // 回归：kernel-client.ts 曾以未绑定方式调用 client.request——this 为
    // undefined，抛 "Cannot read properties of undefined (reading
    // 'timeoutMs')"，本地 runner 的 .catch() 掩盖为帧静默丢失，fleet 服务端
    // 则表现为 502 kernel_unreachable（真实 kernel e2e 中帧永远无法送达）。
    const received: { path: string; headers: Record<string, string | string[] | undefined>; body: unknown }[] = []
    const kernelServer = createHttpServer((req, res) => {
      const chunks: Buffer[] = []
      req.on('data', (c: Buffer) => chunks.push(c))
      req.on('end', () => {
        received.push({
          path: req.url ?? '',
          headers: req.headers as Record<string, string | string[] | undefined>,
          body: JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'),
        })
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ appended: 1, last_seq: 1, truncated: false, total_bytes: 3, dropped_bytes: 0 }))
      })
    })
    await new Promise<void>(resolve => kernelServer.listen(0, '127.0.0.1', resolve))
    const address = kernelServer.address()
    if (address === null || typeof address === 'string') throw new Error('bind failed')
    try {
      const client = new ResearchClient({ endpoint: `http://127.0.0.1:${address.port}`, token: 'kt', serviceToken: 'st' })
      const result = await appendTerminalFramesWithLease(
        client, 'job_rt', 'run_rt',
        [{ seq: 1, frame_kind: 'chunk', channel: 'stdout', text: 'hi', lease_generation: 2 }],
        'runner-rt', 'lt_rt', 4096,
      )
      expect(result.appended).toBe(1)
      expect(received).toHaveLength(1)
      expect(received[0]!.path).toBe('/v1/jobs/job_rt/terminal-frames')
      expect(received[0]!.headers['x-lease-owner']).toBe('runner-rt')
      expect(received[0]!.headers['x-lease-token']).toBe('lt_rt')
      expect(received[0]!.headers['x-service-token']).toBe('st')
      const body = received[0]!.body as { run_id: string; max_log_bytes: number; frames: unknown[] }
      expect(body.run_id).toBe('run_rt')
      expect(body.max_log_bytes).toBe(4096)
      expect((body.frames[0] as { seq: number }).seq).toBe(1)
    } finally {
      kernelServer.close()
    }
  })
})
