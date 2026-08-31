/**
 * RUN-REMOTE-01 接口层 — ExecutionTarget port / LocalDockerAdapter 契约
 * （execution-runtime.md §5.1、hardening-v0.2-status.md §3 RUN-REMOTE-01）。
 *
 * 覆盖：
 * - ExecutionPlan schema：buildExecutionPlan 字段映射、缺字段/未知键拒绝
 *   （`.strict()`：plan 是固定契约，target 不得改写）；
 * - plan fingerprint 确定性 + 签名 round-trip / 篡改负向；
 * - LocalDockerAdapter 契约：plan 校验、plan 不可变断言（prepare↔start
 *   fingerprint 对账、变异抛 ExecutionPlanMutationError）、参数映射
 *   （buildLocalDockerArgs：--network none / 非 root / cap drop /
 *   read-only / digest / 挂载 / limits）、attach/cancel/wait 语义。
 *
 * 不做真实 docker：dockerRun 注入 fake，参数映射走纯函数。
 */
import { describe, expect, it } from 'vitest'
import { createHash, generateKeyPairSync, sign as nodeSign } from 'node:crypto'
import {
  buildExecutionPlan,
  canonicalPlanJson,
  computeProfileConfigHash,
  ExecutionPlan,
  executionPlanFingerprint,
  getRunnerProfile,
  RunManifest,
  signExecutionPlan,
  verifyExecutionPlanSignature,
  type JobRecord,
  type ExecutionPlan as ExecutionPlanType,
} from '@dsh-scholar/research-schemas'
import {
  LocalDockerAdapter,
  buildLocalDockerArgs,
  buildRunManifest,
  deepFreezePlan,
  ExecutionPlanMutationError,
  runnerTargetPinFailure,
  type DockerExecContext,
  type RunOutcome,
} from '@dsh-scholar/runner-gateway'

const PROJECT_CONFIG_PIN = `sha256:${'9'.repeat(64)}`
const CURRENT_PROFILE = getRunnerProfile('profile_local_docker_cpu_v1')!

describe('runner target spawn-time fencing', () => {
  const payload = {
    runner_target_id: 'docker-a',
    runner_target_kind: 'local-docker',
    runner_target_revision: 3,
    runner_target_hash: 'sha256:current',
  }
  const target = {
    target_id: 'docker-a', display_name: 'Docker A', kind: 'local-docker' as const,
    enabled: true, draining: false, capabilities: ['docker'], health: 'online' as const,
    revision: 3, config_hash: 'sha256:current',
  }

  it('accepts only the configured exact id and current registry revision/hash', async () => {
    const client = { getRunnerTarget: async () => target }
    await expect(runnerTargetPinFailure(client, payload, 'local-docker', 'docker-a')).resolves.toBeNull()
    await expect(runnerTargetPinFailure(client, payload, 'local-docker', 'docker-b')).resolves.toMatch(/refuses/)
    await expect(runnerTargetPinFailure({ getRunnerTarget: async () => ({ ...target, revision: 4 }) }, payload, 'local-docker', 'docker-a'))
      .resolves.toMatch(/changed after claim/)
    await expect(runnerTargetPinFailure({ getRunnerTarget: async () => ({ ...target, enabled: false }) }, payload, 'local-docker', 'docker-a'))
      .resolves.toMatch(/disabled at spawn time/)
  })
})

function makeJob(overrides: Partial<JobRecord> = {}): JobRecord {
  const base: JobRecord = {
    job_id: 'job_test_1',
    project_id: 'prj_test_1',
    contract_id: 'expc_test_1',
    idempotency_key: 'formal:expc_test_1:v1:code:data:macro_f1:11',
    kind: 'formal',
    command: ['python', 'run.py'],
    payload: {
      project_config_pin: PROJECT_CONFIG_PIN,
      runner_target_id: 'local-docker',
      runner_target_kind: 'local-docker',
      runner_target_revision: 1,
      runner_target_hash: `sha256:${'8'.repeat(64)}`,
      runner_profile_id: CURRENT_PROFILE.profile_id,
      profile_config_hash: computeProfileConfigHash(CURRENT_PROFILE),
      image_digest: CURRENT_PROFILE.image,
      runner_compute: { mode: 'cpu' },
      seed: 11,
      output_contract: { metrics: 'metrics.json' },
      contract_metrics: ['macro_f1', 'accuracy'],
      data_artifact_ids: ['sha256:abc'],
      code_commit: 'deadbeef',
    },
    status: 'running',
    failure_class: null,
    lease_owner: 'runner-1',
    lease_expires_at: '2026-08-11T00:00:00.000Z',
    heartbeat_at: '2026-08-11T00:00:00.000Z',
    lease_generation: 3,
    lease_token: 'tok-123',
    attempts: 1,
    max_attempts: 3,
    run_manifest: null,
    error: '',
    created_at: '2026-08-11T00:00:00.000Z',
    updated_at: '2026-08-11T00:00:00.000Z',
  }
  return { ...base, ...overrides, payload: { ...base.payload, ...(overrides.payload ?? {}) } }
}

function makePlan(overrides: Partial<ExecutionPlanType> = {}): ExecutionPlanType {
  return buildExecutionPlan(makeJob(), {
    run_id: 'run_1234567890ab',
    lease: { owner: 'runner-1', generation: 3, token: 'tok-123', expires_at: '2026-08-11T00:00:00.000Z' },
    timeout_ms: 60000,
    created_at: '2026-08-11T00:00:00.000Z',
    ...overrides,
  })
}

function fakeOutcome(runId = 'run_1234567890ab'): RunOutcome {
  return {
    run_id: runId,
    exit_code: 0,
    started_at: '2026-08-11T00:00:00.000Z',
    finished_at: '2026-08-11T00:00:01.000Z',
    stdout: 'ok',
    stderr: '',
  }
}

describe('ExecutionPlan schema（research-schemas）', () => {
  it('buildExecutionPlan 固定 project/job/run/lease/profile/config/image/snapshot/artifact/limits/network/output contract', () => {
    const job = makeJob()
    const plan = makePlan()
    expect(plan.schema_version).toBe(1)
    expect(plan.project_id).toBe(job.project_id)
    expect(plan.job_id).toBe(job.job_id)
    expect(plan.run_id).toBe('run_1234567890ab')
    expect(plan.kind).toBe('formal')
    expect(plan.config_pin).toBe(PROJECT_CONFIG_PIN)
    expect(plan.lease).toEqual({ owner: 'runner-1', generation: 3, token: 'tok-123', expires_at: '2026-08-11T00:00:00.000Z' })
    expect(plan.profile_id).toBe(CURRENT_PROFILE.profile_id)
    expect(plan.profile_config_hash).toBe(CURRENT_PROFILE.config_hash)
    expect(plan.target_id).toBe('local-docker')
    expect(plan.target_kind).toBe('local-docker')
    expect(plan.target_revision).toBe(1)
    expect(plan.target_config_hash).toBe(`sha256:${'8'.repeat(64)}`)
    expect(plan.image.digest).toBe(CURRENT_PROFILE.image)
    expect(plan.snapshot.code_snapshot_id).toBeNull()
    expect(plan.artifact_refs.data_artifact_ids).toEqual(['sha256:abc'])
    expect(plan.limits).toEqual({ timeout_ms: 60000, memory_mb: 1024, cpus: 1, pids: 256, max_log_bytes: 32 * 1024 * 1024 })
    expect(plan.network).toEqual({ policy: 'none' })
    expect(plan.output_contract).toEqual({
      metrics_path: 'metrics.json',
      contract_id: 'expc_test_1',
      seed: 11,
      contract_metrics: ['macro_f1', 'accuracy'],
      trusted_fixture: false,
    })
    expect(plan.command).toEqual(['python', 'run.py'])
    // schema 可解析（buildExecutionPlan 已 parse；再显式 parse 一次证明）
    expect(ExecutionPlan.parse(plan).plan_id).toBe(`plan_${job.job_id}`)
  })

  it('command override 进入 plan（TeX/smoke 的容器内脚本路径）', () => {
    const plan = buildExecutionPlan(makeJob({ kind: 'latex-compile', payload: {
      project_config_pin: PROJECT_CONFIG_PIN,
      runner_target_id: 'local-docker',
      runner_target_kind: 'local-docker',
      runner_target_revision: 1,
      runner_target_hash: `sha256:${'8'.repeat(64)}`,
      tex_snapshot: { schema_version: 1 },
    } }), {
      run_id: 'run_x',
      lease: { owner: 'o', generation: 1, token: 'tok-command', expires_at: null },
      timeout_ms: 60000,
      command: ['sh', '/work/run.sh'],
      created_at: '2026-08-11T00:00:00.000Z',
    })
    expect(plan.command).toEqual(['sh', '/work/run.sh'])
    expect(plan.snapshot.tex_snapshot).toEqual({ schema_version: 1 })
  })

  it('将 target kind/revision/hash 的不可变 pin 带入 ExecutionPlan', () => {
    const plan = buildExecutionPlan(makeJob({
      payload: {
        project_config_pin: PROJECT_CONFIG_PIN,
        runner_target_id: 'lab-gpu-1',
        runner_target_kind: 'remote-ssh',
        runner_target_revision: 7,
        runner_target_hash: `sha256:${'a'.repeat(64)}`,
      },
    }), {
      run_id: 'run_target_pin',
      lease: { owner: 'fleet', generation: 1, token: 'tok', expires_at: null },
      timeout_ms: 60000,
    })
    expect(plan).toMatchObject({
      target_id: 'lab-gpu-1', target_kind: 'remote-ssh', target_revision: 7,
      target_config_hash: `sha256:${'a'.repeat(64)}`,
    })
  })

  it('缺必需字段拒绝（plan 是固定契约）', () => {
    const plan = makePlan()
    const { run_id: _runId, ...missing } = plan
    expect(() => ExecutionPlan.parse(missing)).toThrow()
    const { compute: _compute, ...withoutCompute } = plan
    expect(() => ExecutionPlan.parse(withoutCompute)).toThrow()
    const { profile_config_hash: _profileHash, ...withoutProfileHash } = plan
    expect(() => ExecutionPlan.parse(withoutProfileHash)).toThrow()
    expect(() => ExecutionPlan.parse({ ...plan, lease: { owner: plan.lease.owner, generation: plan.lease.generation, expires_at: null } })).toThrow()
    const { memory_mb: _memory, ...partialLimits } = plan.limits
    expect(() => ExecutionPlan.parse({ ...plan, limits: partialLimits })).toThrow()
  })

  it('缺失或非法 project_config_pin 时拒绝构建，调用方不能覆盖 Kernel pin', () => {
    const withoutPin = makeJob()
    delete withoutPin.payload.project_config_pin
    expect(() => buildExecutionPlan(withoutPin, {
      run_id: 'run_missing_pin',
      lease: { owner: 'runner-1', generation: 3, token: 'tok-123', expires_at: null },
      timeout_ms: 60000,
    })).toThrow()

    const invalidPin = makeJob({ payload: { project_config_pin: 'sha256:not-a-pin' } })
    expect(() => buildExecutionPlan(invalidPin, {
      run_id: 'run_invalid_pin',
      lease: { owner: 'runner-1', generation: 3, token: 'tok-123', expires_at: null },
      timeout_ms: 60000,
    })).toThrow()

    const attemptedOverride = makePlan({ config_pin: `sha256:${'f'.repeat(64)}` })
    expect(attemptedOverride.config_pin).toBe(PROJECT_CONFIG_PIN)
  })

  it('缺失 target pin 时拒绝构建，调用方不能覆盖 Kernel target', () => {
    const incomplete = makeJob()
    delete incomplete.payload.runner_target_id
    expect(() => buildExecutionPlan(incomplete, {
      run_id: 'run_missing_target',
      lease: { owner: 'runner-1', generation: 3, token: 'tok-123', expires_at: null },
      timeout_ms: 60000,
    })).toThrow()

    const attemptedOverride = makePlan({ target_id: 'remote-caller-override' })
    expect(attemptedOverride.target_id).toBe('local-docker')
  })

  it('.strict() 拒绝计划外字段（address/certificate/凭据不得进入 plan）', () => {
    const plan = makePlan() as Record<string, unknown>
    expect(() => ExecutionPlan.parse({ ...plan, address: '10.0.0.5:7443' })).toThrow()
    expect(() => ExecutionPlan.parse({ ...plan, ssh_bootstrap: 'user@host' })).toThrow()
  })

  it('fingerprint 确定性：同内容同值，改任一字段即变', () => {
    const a = makePlan()
    const b = makePlan()
    expect(executionPlanFingerprint(a)).toBe(executionPlanFingerprint(b))
    const tampered = { ...a, image: { digest: 'node@sha256:0000000000000000000000000000000000000000000000000000000000000000' } }
    expect(executionPlanFingerprint(tampered)).not.toBe(executionPlanFingerprint(a))
  })

  it('签名 round-trip：有效、篡改拒绝、错误密钥拒绝、未签名拒绝', () => {
    const key = generateKeyPairSync('ed25519')
    const publicKeyPem = key.publicKey.export({ type: 'spki', format: 'pem' }).toString()
    const other = generateKeyPairSync('ed25519')
    const otherPem = other.publicKey.export({ type: 'spki', format: 'pem' }).toString()

    const signed = signExecutionPlan(makePlan(), { keyId: 'runner-key-1', privateKey: key.privateKey })
    expect(signed.signature).toBeTruthy()
    expect(signed.payload_sha256).toBeTruthy()
    expect(signed.signed_by).toBe('runner-key-1')
    expect(verifyExecutionPlanSignature(signed, publicKeyPem)).toEqual({ valid: true, reason: null })

    // 篡改（plan 内容改变）→ payload_sha256 不匹配
    const tampered = { ...signed, image: { digest: 'node@sha256:1111111111111111111111111111111111111111111111111111111111111111' } }
    const tamperedCheck = verifyExecutionPlanSignature(tampered, publicKeyPem)
    expect(tamperedCheck.valid).toBe(false)
    expect(tamperedCheck.reason).toContain('payload_sha256 mismatch')

    // 错误公钥 → Ed25519 验签失败
    const wrongKey = verifyExecutionPlanSignature(signed, otherPem)
    expect(wrongKey.valid).toBe(false)

    // 未签名 plan → fail closed
    const unsigned = verifyExecutionPlanSignature(makePlan(), publicKeyPem)
    expect(unsigned.valid).toBe(false)
    expect(unsigned.reason).toContain('not signed')
  })

  it('runner_compute 缺失或 malformed 时都 fail closed', () => {
    expect(makePlan().compute).toEqual({ mode: 'cpu' })
    const missing = makeJob({ payload: { runner_compute: undefined } })
    expect(() => buildExecutionPlan(missing, {
      run_id: 'run_missing_compute',
      lease: { owner: 'runner-1', generation: 1, token: 'tok', expires_at: null },
      timeout_ms: 1000,
    })).toThrow()
    const malformed = makeJob({ payload: { runner_compute: { mode: 'nvidia', devices: '--privileged' } } })
    expect(() => buildExecutionPlan(malformed, {
      run_id: 'run_bad_compute',
      lease: { owner: 'runner-1', generation: 1, token: 'tok', expires_at: null },
      timeout_ms: 1000,
    })).toThrow()
  })
})

describe('deepFreezePlan（plan 不可变断言）', () => {
  it('冻结后写操作抛 TypeError', () => {
    const plan = makePlan()
    const frozen = deepFreezePlan(plan)
    expect(Object.isFrozen(frozen)).toBe(true)
    expect(() => { (frozen as Record<string, unknown>).image = 'tampered' }).toThrow(TypeError)
    expect(() => { (frozen.image as Record<string, unknown>).digest = 'tampered' }).toThrow(TypeError)
  })
})

describe('LocalDockerAdapter（ExecutionTarget port 本地实现）', () => {
  it('execute() = prepare → start → wait：dockerRun 收到 plan 派生的参数', async () => {
    const received: Array<{ plan: ExecutionPlanType; exec: DockerExecContext }> = []
    const adapter = new LocalDockerAdapter({
      jobId: 'job_test_1',
      targetId: 'local-docker',
      dockerRun: async (plan, exec) => {
        received.push({ plan, exec })
        return fakeOutcome(plan.run_id)
      },
      cancel: () => true,
    })
    const plan = makePlan()
    const outcome = await adapter.execute(plan, { cwd: '/tmp/work', runEnv: { DSH_RUN_ID: plan.run_id } })

    expect(outcome.exit_code).toBe(0)
    expect(received).toHaveLength(1)
    const { plan: gotPlan, exec } = received[0]!
    // 参数一律取自 plan（target 不得改写）：command/run_id 来自 plan
    expect(exec.command).toEqual(plan.command)
    expect(exec.runId).toBe(plan.run_id)
    expect(exec.jobId).toBe('job_test_1')
    expect(exec.cwd).toBe('/tmp/work')
    expect(exec.runEnv).toEqual({ DSH_RUN_ID: plan.run_id })
    // dockerRun receives the exact schema-validated current plan.
    expect(gotPlan.limits.timeout_ms).toBe(60000)
    expect(gotPlan.image.digest).toBe(plan.image.digest)
  })

  it('拒绝发给其他 target 或非 local-docker kind 的计划', async () => {
    const adapter = new LocalDockerAdapter({
      jobId: 'j-target', targetId: 'target_local_docker_v1',
      dockerRun: async () => fakeOutcome(), cancel: () => false,
    })
    await expect(adapter.prepare(makePlan())).rejects.toThrow(/refuses plan pinned/)
    const wrongKind = buildExecutionPlan(makeJob({ payload: {
      project_config_pin: PROJECT_CONFIG_PIN,
      runner_target_id: 'target_local_docker_v1',
      runner_target_kind: 'remote-ssh', runner_target_revision: 1,
      runner_target_hash: `sha256:${'b'.repeat(64)}`,
    } }), {
      run_id: 'run_wrong_kind', lease: { owner: 'o', generation: 1, token: 'tok-wrong-kind', expires_at: null },
      timeout_ms: 60000,
    })
    await expect(adapter.prepare(wrongKind)).rejects.toThrow(/refuses remote-ssh/)
  })

  it('start() 未先 prepare() → ExecutionPlanMutationError', async () => {
    const adapter = new LocalDockerAdapter({ jobId: 'j1', targetId: 'local-docker', dockerRun: async () => fakeOutcome(), cancel: () => false })
    await expect(adapter.start(makePlan())).rejects.toThrow(ExecutionPlanMutationError)
  })

  it('plan 在 prepare() 与 start() 之间被改写 → ExecutionPlanMutationError（plan 不可变断言）', async () => {
    const adapter = new LocalDockerAdapter({ jobId: 'j1', targetId: 'local-docker', dockerRun: async () => fakeOutcome(), cancel: () => false })
    const original = makePlan()
    await adapter.prepare(original)
    // 构造内容改变的新 plan 对象（模拟改写）
    const mutated = buildExecutionPlan(makeJob({ payload: {
      image_digest: 'node@sha256:2222222222222222222222222222222222222222222222222222222222222222',
    } }), {
      run_id: original.run_id,
      lease: original.lease,
      timeout_ms: original.limits.timeout_ms,
      created_at: original.created_at,
    })
    await expect(adapter.start(mutated)).rejects.toThrow(ExecutionPlanMutationError)
    // 未改写的同一 plan 正常启动
    const run = await adapter.start(original)
    await expect(adapter.wait(run)).resolves.toMatchObject({ exit_code: 0 })
  })

  it('attach/cancel/wait 语义：running → done；cancel 命中真实执行', async () => {
    let resolveOutcome!: (r: RunOutcome) => void
    const adapter = new LocalDockerAdapter({
      jobId: 'job_cancel_1',
      targetId: 'local-docker',
      dockerRun: () => new Promise<RunOutcome>(resolve => { resolveOutcome = resolve }),
      cancel: jobId => jobId === 'job_cancel_1',
    })
    const plan = makePlan()
    await adapter.prepare(plan)
    const run = await adapter.start(plan)
    expect(run.job_id).toBe('job_cancel_1')
    expect((await adapter.attach(run)).state).toBe('running')
    await expect(adapter.cancel(run)).resolves.toBe(true)
    resolveOutcome(fakeOutcome())
    await expect(adapter.wait(run)).resolves.toMatchObject({ run_id: 'run_1234567890ab' })
    expect((await adapter.attach(run)).state).toBe('done')
  })

  it('buildLocalDockerArgs 参数映射与容器安全基线一致（plan → docker run）', () => {
    const plan = makePlan()
    const args = buildLocalDockerArgs({
      plan,
      cwd: '/tmp/work',
      containerName: 'dsh-scholar-test1234',
      env: { DSH_RUN_ID: plan.run_id },
      command: plan.command,
    })
    expect(args[0]).toBe('run')
    const flag = (name: string): string | undefined => {
      const i = args.indexOf(name)
      return i >= 0 ? args[i + 1] : undefined
    }
    // 完整基线（execution-runtime.md §5）
    expect(args).toContain('--rm')
    expect(flag('--network')).toBe('none')
    expect(flag('--user')).toBe('65534:65534')
    expect(args).toContain('--read-only')
    expect(flag('--cap-drop')).toBe('ALL')
    expect(flag('--security-opt')).toBe('no-new-privileges')
    expect(flag('--pids-limit')).toBe(String(plan.limits.pids))
    expect(flag('--memory')).toBe(`${plan.limits.memory_mb}m`)
    expect(flag('--cpus')).toBe(String(plan.limits.cpus))
    expect(args).toContain('-e')
    expect(args).toContain('DSH_RUN_ID=run_1234567890ab')
    // 输入只读挂载 + outputs 唯一 rw 挂载 + tmpfs + 固定 digest
    expect(args).toContain('-v')
    expect(args).toContain('/tmp/work:/work:ro')
    expect(args).toContain('/tmp/work/outputs:/outputs')
    expect(args).toContain('--tmpfs')
    expect(args).toContain('/tmp:size=64m')
    expect(args).toContain(plan.image.digest)
    // 命令尾随（plan.command，target 不得改写）
    expect(args.slice(args.indexOf(plan.image.digest) + 1)).toEqual(plan.command)
  })

  it('maps typed NVIDIA requests to one safe --gpus argument and leaves CPU plans untouched', () => {
    const cpuArgs = buildLocalDockerArgs({
      plan: makePlan(), cwd: '/tmp/work', containerName: 'cpu', env: {}, command: ['true'],
    })
    expect(cpuArgs).not.toContain('--gpus')

    const allPlan = buildExecutionPlan(makeJob({ payload: { runner_compute: { mode: 'nvidia', devices: 'all' } } }), {
      run_id: 'run_gpu_all', lease: { owner: 'runner-1', generation: 3, token: 'tok-123', expires_at: null }, timeout_ms: 60000,
    })
    const allArgs = buildLocalDockerArgs({
      plan: allPlan, cwd: '/tmp/work', containerName: 'gpu-all', env: {}, command: ['true'],
    })
    expect(allArgs.slice(allArgs.indexOf('--gpus'), allArgs.indexOf('--gpus') + 2)).toEqual(['--gpus', 'all'])

    const selectedPlan = buildExecutionPlan(makeJob({ payload: { runner_compute: { mode: 'nvidia', devices: ['0', '2'] } } }), {
      run_id: 'run_gpu_selected', lease: { owner: 'runner-1', generation: 3, token: 'tok-123', expires_at: null }, timeout_ms: 60000,
    })
    const selectedArgs = buildLocalDockerArgs({
      plan: selectedPlan, cwd: '/tmp/work', containerName: 'gpu-selected', env: {}, command: ['true'],
    })
    expect(selectedArgs.slice(selectedArgs.indexOf('--gpus'), selectedArgs.indexOf('--gpus') + 2))
      .toEqual(['--gpus', 'device=0,2'])
  })
})

describe('signed manifest compute provenance', () => {
  const base = {
    run_id: 'run_manifest', project_id: 'prj_manifest', contract_id: null, job_id: 'job_manifest',
    config_pin: PROJECT_CONFIG_PIN,
    command: ['true'], code_commit: '', code_snapshot_id: null,
    container_digest: 'docker:node@sha256:' + 'c'.repeat(64), data_hash: '', seed: null,
    started_at: '2026-08-15T00:00:00.000Z', finished_at: '2026-08-15T00:00:01.000Z', exit_code: 0,
  }

  it('records the exact config pin and selected compute resources', () => {
    expect(buildRunManifest({ ...base, compute: { mode: 'cpu' } }).config_pin).toBe(PROJECT_CONFIG_PIN)
    expect(buildRunManifest({ ...base, compute: { mode: 'cpu' } }).resources)
      .toEqual({ gpu: 0, cpu: 1, memory_gb: 1 })
    expect(buildRunManifest({ ...base, compute: { mode: 'nvidia', devices: ['0', '2'] } }).resources)
      .toEqual({ gpu: 2, gpu_mode: 'nvidia', gpu_devices: ['0', '2'], cpu: 1, memory_gb: 1 })
  })

  it('accepts only lease generation and rejects a plaintext lease token', () => {
    const manifest = { ...buildRunManifest({ ...base, compute: { mode: 'cpu' } }), contract_id: 'expc_manifest', code_commit: 'commit_manifest' }
    expect(RunManifest.parse({ ...manifest, lease: { generation: 3 } }).lease).toEqual({ generation: 3 })
    expect(() => RunManifest.parse({ ...manifest, lease: { generation: 3, token: 'lt_secret' } })).toThrow()
  })
})
