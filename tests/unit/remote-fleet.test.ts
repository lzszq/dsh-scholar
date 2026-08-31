/**
 * RUN-REMOTE-01 接口层 — 远端 Agent 注册表 + 调度决策纯函数
 * （execution-runtime.md §5.1、hardening-v0.2-status.md §3 RUN-REMOTE-01）。
 *
 * 覆盖：
 * - RemoteAgentRegistration schema：opaque target_id/capability/health/
 *   cert_fingerprint；address/certificate/SSH bootstrap 出现在注册记录即
 *   解析失败（服务端 Config/SecretRef 专属，Job/UI 只见 opaque id 与安全摘要）；
 * - InMemoryAgentRegistry：注册、心跳更新 health/last_seen、offline 判定；
 * - capability 匹配（images/os/arch/runner_ver）；
 * - scheduledTarget 纯函数：capability 匹配、offline/draining 拒绝、
 *   无匹配 → 明确 retryable 错误、bound target 不可用在任何配置下都不
 *   回退 LocalDocker、policy 可配置（prefer local /
 *   local_only / allow_remote）；
 * - createRemoteRunnerAgent：接口层 stub fail-closed（真实 mTLS 传输未实现，
 *   任何执行调用明确抛错，绝不静默降级）。
 */
import { describe, expect, it } from 'vitest'
import {
  buildExecutionPlan,
  computeProfileConfigHash,
  DEFAULT_TARGET_SCHEDULING_POLICY,
  isTargetAvailable,
  getRunnerProfile,
  LOCAL_DOCKER_TARGET_ID,
  matchesTargetCapability,
  RemoteAgentRegistration,
  runnerVersionSatisfies,
  scheduledTarget,
  TargetSchedulingPolicy as TargetSchedulingPolicySchema,
  type ExecutionPlan as ExecutionPlanType,
  type JobRecord,
  type RemoteAgentRegistration as Registration,
  type TargetSchedulingPolicy,
} from '@dsh-scholar/research-schemas'
import {
  InMemoryAgentRegistry,
  localDockerRegistration,
  createRemoteRunnerAgent,
  RemoteRunnerAgentNotImplementedError,
} from '@dsh-scholar/runner-gateway'

const NOW = Date.parse('2026-08-11T12:00:00.000Z')
const REMOTE_PROFILE = getRunnerProfile('profile_local_docker_cpu_v1')!

function makeJob(overrides: Partial<JobRecord> = {}): JobRecord {
  return {
    job_id: 'job_remote_1',
    project_id: 'prj_test_1',
    contract_id: 'expc_test_1',
    idempotency_key: 'formal:expc_test_1:v1',
    kind: 'formal',
    command: ['python', 'run.py'],
    payload: {
      project_config_pin: `sha256:${'2'.repeat(64)}`,
      runner_target_id: 'remote-gpu-1',
      runner_target_kind: 'remote-ssh',
      runner_target_revision: 1,
      runner_target_hash: `sha256:${'b'.repeat(64)}`,
      runner_profile_id: REMOTE_PROFILE.profile_id,
      profile_config_hash: computeProfileConfigHash(REMOTE_PROFILE),
      image_digest: REMOTE_PROFILE.image,
      runner_compute: { mode: 'cpu' },
      seed: 11,
      output_contract: { metrics: 'metrics.json' },
    },
    status: 'running',
    failure_class: null,
    lease_owner: 'runner-1',
    lease_expires_at: null,
    heartbeat_at: null,
    lease_generation: 1,
    lease_token: 'tok-1',
    attempts: 1,
    max_attempts: 3,
    run_manifest: null,
    error: '',
    created_at: '2026-08-11T00:00:00.000Z',
    updated_at: '2026-08-11T00:00:00.000Z',
    ...overrides,
  }
}

function makePlan(overrides: Partial<ExecutionPlanType> = {}): ExecutionPlanType {
  const plan = buildExecutionPlan(makeJob(), {
    run_id: 'run_remote_1',
    lease: { owner: 'runner-1', generation: 1, token: 'tok-1', expires_at: null },
    timeout_ms: 60000,
    created_at: '2026-08-11T00:00:00.000Z',
  })
  return { ...plan, ...overrides }
}

function reg(overrides: Partial<Registration> = {}): Registration {
  return {
    schema_version: 1,
    target_id: 'remote-gpu-1',
    agent_id: 'agent-1',
    capabilities: { os: 'linux', arch: 'x64', runner_ver: '0.1.0', images: [] },
    labels: { rack: 'a' },
    health: { status: 'online', last_seen: new Date(NOW - 5_000).toISOString() },
    cert_fingerprint: 'sha256:abcd1234',
    ...overrides,
  }
}

describe('RemoteAgentRegistration schema（远端注册记录）', () => {
  it('合法注册记录解析（target_id/agent_id/capabilities/labels/health/cert_fingerprint）', () => {
    const parsed = RemoteAgentRegistration.parse(reg())
    expect(parsed.target_id).toBe('remote-gpu-1')
    expect(parsed.agent_id).toBe('agent-1')
    expect(parsed.capabilities).toEqual({ os: 'linux', arch: 'x64', runner_ver: '0.1.0', images: [] })
    expect(parsed.health.status).toBe('online')
    expect(parsed.cert_fingerprint).toBe('sha256:abcd1234')
  })

  it('.strict() 拒绝 address/certificate/SSH bootstrap——配置只由服务端 Config/SecretRef 解析', () => {
    expect(() => RemoteAgentRegistration.parse(reg({ address: '10.0.0.5:7443' } as never))).toThrow()
    expect(() => RemoteAgentRegistration.parse(reg({ certificate: '-----BEGIN CERT-----' } as never))).toThrow()
    expect(() => RemoteAgentRegistration.parse(reg({ ssh_bootstrap: 'user@host:22' } as never))).toThrow()
  })

  it('本地 target 可无证书指纹；远程约定必填（schema 层 nullable）', () => {
    const local = localDockerRegistration('0.1.0', new Date(NOW).toISOString())
    expect(local.cert_fingerprint).toBeNull()
    expect(RemoteAgentRegistration.parse(local).target_id).toBe(LOCAL_DOCKER_TARGET_ID)
  })
})

describe('InMemoryAgentRegistry（注册/心跳/offline 判定）', () => {
  it('register → get/list/getByTarget；upsert 不重复', () => {
    const registry = new InMemoryAgentRegistry()
    registry.register(reg())
    registry.register(reg({ agent_id: 'agent-2', health: { status: 'online', last_seen: new Date(NOW).toISOString() } }))
    expect(registry.get('agent-1')?.target_id).toBe('remote-gpu-1')
    expect(registry.getByTarget('remote-gpu-1')).toHaveLength(2)
    expect(registry.getByTarget('local-docker')).toHaveLength(0)
    expect(registry.list().map(r => r.agent_id)).toEqual(['agent-1', 'agent-2'])
    // 同一 agent 重复注册 = 更新（仍 1 条）
    registry.register(reg({ agent_id: 'agent-1', labels: { rack: 'b' } }))
    expect(registry.list()).toHaveLength(2)
    expect(registry.get('agent-1')?.labels).toEqual({ rack: 'b' })
    // remove
    expect(registry.remove('agent-1')).toBe(true)
    expect(registry.get('agent-1')).toBeUndefined()
  })

  it('heartbeat 刷新 last_seen 并可携带状态变更（online → draining）', () => {
    const registry = new InMemoryAgentRegistry()
    registry.register(reg({ health: { status: 'online', last_seen: new Date(NOW - 60_000).toISOString() } }))
    const updated = registry.heartbeat('agent-1', 'draining', NOW)
    expect(updated?.health.status).toBe('draining')
    expect(Date.parse(updated!.health.last_seen)).toBe(NOW)
    // 未注册 agent 心跳 → null
    expect(registry.heartbeat('ghost', 'online', NOW)).toBeNull()
  })

  it('offline 判定：未注册 / status 非 online / last_seen 超时均 offline；fresh online 可用', () => {
    const registry = new InMemoryAgentRegistry()
    registry.register(reg({ health: { status: 'online', last_seen: new Date(NOW - 5_000).toISOString() } }))
    expect(registry.isOffline('agent-1', NOW, 30_000)).toBe(false)
    expect(registry.isOffline('ghost', NOW, 30_000)).toBe(true) // fail closed
    registry.heartbeat('agent-1', 'offline', NOW)
    expect(registry.isOffline('agent-1', NOW, 30_000)).toBe(true)
    registry.heartbeat('agent-1', 'online', NOW - 60_000)
    expect(registry.isOffline('agent-1', NOW, 30_000)).toBe(true) // stale last_seen
  })

  it('isTargetAvailable 纯函数与注册表同规则', () => {
    expect(isTargetAvailable(reg({ health: { status: 'online', last_seen: new Date(NOW - 5_000).toISOString() } }), NOW, 30_000)).toBe(true)
    expect(isTargetAvailable(reg({ health: { status: 'offline', last_seen: new Date(NOW).toISOString() } }), NOW, 30_000)).toBe(false)
    expect(isTargetAvailable(reg({ health: { status: 'draining', last_seen: new Date(NOW).toISOString() } }), NOW, 30_000)).toBe(false)
    expect(isTargetAvailable(reg({ health: { status: 'online', last_seen: new Date(NOW - 60_000).toISOString() } }), NOW, 30_000)).toBe(false)
  })
})

describe('capability 匹配', () => {
  const plan = makePlan()

  it('images 空 = 接受任何锁内 digest；列出时须包含 plan digest', () => {
    expect(matchesTargetCapability(plan, reg())).toBe(true)
    expect(matchesTargetCapability(plan, reg({ capabilities: { os: 'linux', arch: 'x64', runner_ver: '0.1.0', images: [plan.image.digest] } }))).toBe(true)
    expect(matchesTargetCapability(plan, reg({ capabilities: { os: 'linux', arch: 'x64', runner_ver: '0.1.0', images: ['other@sha256:0000000000000000000000000000000000000000000000000000000000000000'] } }))).toBe(false)
  })

  it('os/arch 约束匹配', () => {
    expect(matchesTargetCapability({ ...plan, platform: { os: 'linux', arch: null } }, reg())).toBe(true)
    expect(matchesTargetCapability({ ...plan, platform: { os: 'darwin', arch: null } }, reg())).toBe(false)
    expect(matchesTargetCapability({ ...plan, platform: { os: null, arch: 'arm64' } }, reg({ capabilities: { os: 'linux', arch: 'arm64', runner_ver: '0.1.0', images: [] } }))).toBe(true)
    expect(matchesTargetCapability({ ...plan, platform: { os: null, arch: 'arm64' } }, reg({ capabilities: { os: 'linux', arch: 'x64', runner_ver: '0.1.0', images: [] } }))).toBe(false)
  })

  it('runner 版本下限', () => {
    expect(runnerVersionSatisfies('0.2.0', '0.1.0')).toBe(true)
    expect(runnerVersionSatisfies('0.1.9', '0.1.10')).toBe(false)
    expect(runnerVersionSatisfies('1.2.3', '1.2.3')).toBe(true)
    expect(matchesTargetCapability({ ...plan, requires: { runner_version: '0.2.0' } }, reg())).toBe(false)
    expect(matchesTargetCapability({ ...plan, requires: { runner_version: '0.1.0' } }, reg())).toBe(true)
  })

  it('NVIDIA 请求要求 toolkit 与可用设备，all 不得匹配空设备 agent', () => {
    const gpuAll = { ...plan, compute: { mode: 'nvidia' as const, devices: 'all' as const } }
    const selected = { ...plan, compute: { mode: 'nvidia' as const, devices: ['0', '2'] } }
    const capabilities = { os: 'linux', arch: 'x64', runner_ver: '0.1.0', images: [] }
    expect(matchesTargetCapability(gpuAll, reg({ capabilities }))).toBe(false)
    expect(matchesTargetCapability(gpuAll, reg({ capabilities: { ...capabilities, nvidia: { toolkit_available: true, devices: [] } } }))).toBe(false)
    expect(matchesTargetCapability(gpuAll, reg({ capabilities: { ...capabilities, nvidia: { toolkit_available: true, devices: ['0'] } } }))).toBe(true)
    expect(matchesTargetCapability(selected, reg({ capabilities: { ...capabilities, nvidia: { toolkit_available: true, devices: ['0', '1'] } } }))).toBe(false)
    expect(matchesTargetCapability(selected, reg({ capabilities: { ...capabilities, nvidia: { toolkit_available: true, devices: ['0', '1', '2'] } } }))).toBe(true)
  })
})

describe('scheduledTarget（调度决策纯函数）', () => {
  const online = reg()
  const local = localDockerRegistration('0.1.0', new Date(NOW - 5_000).toISOString())

  it('bound target online + capability 匹配 → 指派该 target', () => {
    const result = scheduledTarget(makePlan(), [online, local], DEFAULT_TARGET_SCHEDULING_POLICY, NOW)
    expect(result).toEqual({ assigned: true, target_id: 'remote-gpu-1' })
  })

  it('bound target offline → 明确 retryable（offline），绝不静默回退 local-docker', () => {
    const offline = reg({ health: { status: 'offline', last_seen: new Date(NOW - 5_000).toISOString() } })
    const localOnline = localDockerRegistration('0.1.0', new Date(NOW - 5_000).toISOString())
    const result = scheduledTarget(makePlan(), [offline, localOnline], DEFAULT_TARGET_SCHEDULING_POLICY, NOW)
    expect(result.assigned).toBe(false)
    if (!result.assigned) {
      expect(result.retryable).toBe(true)
      expect(result.reason).toBe('offline')
      expect(result.target_id).toBe('remote-gpu-1') // 仍是 bound target
    }
  })

  it('bound target draining → retryable draining', () => {
    const draining = reg({ health: { status: 'draining', last_seen: new Date(NOW - 5_000).toISOString() } })
    const result = scheduledTarget(makePlan(), [draining], DEFAULT_TARGET_SCHEDULING_POLICY, NOW)
    expect(result).toEqual({ assigned: false, retryable: true, reason: 'draining', target_id: 'remote-gpu-1' })
  })

  it('capability mismatch → 明确 retryable（capability_mismatch），不回退', () => {
    const mismatch = reg({ capabilities: { os: 'linux', arch: 'x64', runner_ver: '0.1.0', images: ['other@sha256:0000000000000000000000000000000000000000000000000000000000000000'] } })
    const result = scheduledTarget(makePlan(), [mismatch, local], DEFAULT_TARGET_SCHEDULING_POLICY, NOW)
    expect(result).toEqual({ assigned: false, retryable: true, reason: 'capability_mismatch', target_id: 'remote-gpu-1' })
  })

  it('bound target 无任何注册 → retryable no_capable_target（不静默降级）', () => {
    const result = scheduledTarget(makePlan(), [local], DEFAULT_TARGET_SCHEDULING_POLICY, NOW)
    expect(result).toEqual({ assigned: false, retryable: true, reason: 'no_capable_target', target_id: 'remote-gpu-1' })
  })

  it('旧 fallback policy 字段 strict 拒绝，bound target 永不跨 target 改派', () => {
    expect(() => TargetSchedulingPolicySchema.parse({
      ...DEFAULT_TARGET_SCHEDULING_POLICY,
      allow_bound_fallback_to_local: true,
    })).toThrow()
    expect(scheduledTarget(makePlan(), [local], DEFAULT_TARGET_SCHEDULING_POLICY, NOW))
      .toEqual({ assigned: false, retryable: true, reason: 'no_capable_target', target_id: 'remote-gpu-1' })
  })

  it('policy.local_only：bound 远端 target → retryable policy_blocked', () => {
    const policy: TargetSchedulingPolicy = { ...DEFAULT_TARGET_SCHEDULING_POLICY, local_only: true }
    const result = scheduledTarget(makePlan(), [online], policy, NOW)
    expect(result).toEqual({ assigned: false, retryable: true, reason: 'policy_blocked', target_id: 'remote-gpu-1' })
  })

  it('policy.allow_remote=false：远端 bound target 无候选 → no_capable_target', () => {
    const policy: TargetSchedulingPolicy = { ...DEFAULT_TARGET_SCHEDULING_POLICY, allow_remote: false }
    const result = scheduledTarget(makePlan(), [online], policy, NOW)
    expect(result.assigned).toBe(false)
    if (!result.assigned) expect(result.reason).toBe('no_capable_target')
  })

  it('bound local-docker：在线即指派；确定性排序（同输入同输出）', () => {
    const localPlan = makePlan({ target_id: LOCAL_DOCKER_TARGET_ID, profile_id: LOCAL_DOCKER_TARGET_ID })
    const local2 = localDockerRegistration('0.1.0', new Date(NOW - 5_000).toISOString())
    const a = scheduledTarget(localPlan, [local, local2], DEFAULT_TARGET_SCHEDULING_POLICY, NOW)
    const b = scheduledTarget(localPlan, [local, local2], DEFAULT_TARGET_SCHEDULING_POLICY, NOW)
    expect(a.assigned).toBe(true)
    expect(a).toEqual(b)
    expect(a.assigned && a.target_id).toBe(LOCAL_DOCKER_TARGET_ID)
  })

  it('离线/无匹配结果恒 retryable，且结果面永不出现 subprocess', () => {
    const offline = reg({ health: { status: 'offline', last_seen: new Date(NOW).toISOString() } })
    const result = scheduledTarget(makePlan(), [offline], DEFAULT_TARGET_SCHEDULING_POLICY, NOW)
    expect(result.assigned).toBe(false)
    if (!result.assigned) {
      expect(result.retryable).toBe(true)
      // 调度结果只能是 target_id 或 null——不存在 subprocess 选择
      expect(result.target_id).not.toBe('subprocess')
    }
    // assigned 结果也不可能指向 subprocess
    const ok = scheduledTarget(makePlan(), [online], DEFAULT_TARGET_SCHEDULING_POLICY, NOW)
    expect(ok.assigned && ok.target_id).not.toBe('subprocess')
  })
})

describe('createRemoteRunnerAgent（接口层 stub）', () => {
  it('暴露 registration/target_id/agent_id；所有执行与注册方法 fail-closed 抛 NotImplemented', async () => {
    const agent = createRemoteRunnerAgent(reg())
    expect(agent.target_id).toBe('remote-gpu-1')
    expect(agent.agent_id).toBe('agent-1')
    expect(agent.registration.cert_fingerprint).toBe('sha256:abcd1234')

    const plan = makePlan()
    await expect(agent.prepare(plan)).rejects.toThrow(RemoteRunnerAgentNotImplementedError)
    await expect(agent.start(plan)).rejects.toThrow(RemoteRunnerAgentNotImplementedError)
    await expect(agent.attach({ handle_id: 'h', target_id: 't', job_id: 'j', run_id: 'r', started_at: '' })).rejects.toThrow(RemoteRunnerAgentNotImplementedError)
    await expect(agent.cancel({ handle_id: 'h', target_id: 't', job_id: 'j', run_id: 'r', started_at: '' })).rejects.toThrow(RemoteRunnerAgentNotImplementedError)
    await expect(agent.wait({ handle_id: 'h', target_id: 't', job_id: 'j', run_id: 'r', started_at: '' })).rejects.toThrow(RemoteRunnerAgentNotImplementedError)
    await expect(agent.register()).rejects.toThrow(RemoteRunnerAgentNotImplementedError)
    await expect(agent.heartbeat()).rejects.toThrow(RemoteRunnerAgentNotImplementedError)
  })

  it('错误消息明确：不静默回退 LocalDocker/subprocess', async () => {
    const agent = createRemoteRunnerAgent(reg())
    try {
      await agent.start(makePlan())
      throw new Error('expected throw')
    } catch (error) {
      expect(error).toBeInstanceOf(RemoteRunnerAgentNotImplementedError)
      expect((error as Error).message).toContain('no fallback to LocalDocker or subprocess')
    }
  })
})

describe('Config/SecretRef 边界（Job/UI 只见 opaque id 与安全摘要）', () => {
  it('plan 携带 opaque target_id/profile_id；连接信息字段被 schema 拒绝', () => {
    const plan = makePlan()
    expect(plan.target_id).toBe('remote-gpu-1')
    expect(plan.profile_id).toBe(REMOTE_PROFILE.profile_id)
    // 注册记录/plan 面不得出现 address/certificate（前面 schema 用例已覆盖拒绝）
    const asRecord = plan as unknown as Record<string, unknown>
    expect('address' in asRecord).toBe(false)
    expect('certificate' in asRecord).toBe(false)
    expect('ssh_bootstrap' in asRecord).toBe(false)
  })
})
