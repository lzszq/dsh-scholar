/**
 * RUN-REMOTE-01 — ExecutionTarget port + LocalDockerAdapter
 * (docs/execution-runtime.md §5.1, hardening-v0.2-status.md §3 RUN-REMOTE-01).
 *
 * Runner Gateway 只依赖 `ExecutionTarget` port：prepare(plan)、start(plan)、
 * attach(run)、cancel(run)、wait(run)。生产 Adapter 至少有 LocalDocker 与
 * RemoteRunnerAgent（后者见 ./remote-agent.ts，真实 mTLS 传输未实现，
 * 接口层 stub fail-closed）；Scheduler 是后续可选 Adapter。
 *
 * 适配层边界（本轮按 docs/hardening-v0.2-status.md RUN-REMOTE-01 的约定）：
 * executeJob 的编排 monolith（terminal frames / artifact / manifest /
 * metrics / complete 事务）不动；docker 执行路径经 LocalDockerAdapter
 * 收敛到 ExecutionTarget port——`execute()` = prepare → start → wait，
 * 底层仍调用既有 runDocker 执行引擎（行为不变）。subprocess 不是
 * ExecutionTarget：它是 trusted-smoke-fixture 专用的非 target 兼容层
 * （execution-runtime.md §1），远端/调度路径永不产生 subprocess。
 *
 * plan 不可变断言：prepare() 用 zod 解析 + 深度冻结 + fingerprint；
 * start() 复算 fingerprint，任何变异 → ExecutionPlanMutationError
 * （target 不得改写 plan）。
 * @module @dsh-scholar/runner-gateway/execution-target
 */

import {
  dockerGpuArgument,
  ExecutionPlan,
  executionPlanFingerprint,
  type ExecutionPlan as ExecutionPlanType,
} from '@dsh-scholar/research-schemas'

/** 一次执行的确定性结果（原有 RunOutcome，从 index.ts 迁入并 re-export）。 */
export interface RunOutcome {
  run_id: string
  exit_code: number
  started_at: string
  finished_at: string
  stdout: string
  stderr: string
  error?: string
}

/** prepare(plan) 的产物：target 侧对 plan 的冻结承诺。 */
export interface ExecutionPreparation {
  target_id: string
  /** plan 的 sha256 fingerprint（start() 用它与当前 plan 对账）。 */
  fingerprint: string
}

/** 一次已启动执行的句柄（attach/cancel/wait 都以它为参）。 */
export interface ExecutionRunHandle {
  handle_id: string
  target_id: string
  job_id: string
  run_id: string
  started_at: string
}

/** attach(run) 视图：当前执行状态（远端帧流接入点，见 remote-agent.ts）。 */
export interface ExecutionAttachment {
  run_id: string
  job_id: string
  target_id: string
  state: 'running' | 'done'
}

/**
 * ExecutionTarget port（execution-runtime.md §5.1）：Runner Gateway 唯一
 * 依赖。plan 为固定 ExecutionPlan；target 不得改写（adapter 断言）。
 * start 的可选 `context` 是 target 局部执行参数（不属于 plan）。
 */
export interface ExecutionTarget {
  readonly target_id: string
  /** 校验/冻结 plan 并承诺其 fingerprint。 */
  prepare(plan: ExecutionPlanType): Promise<ExecutionPreparation>
  /** 按 plan 启动执行；实现必须断言 plan 与 prepare 时一致。 */
  start(plan: ExecutionPlanType, context?: ExecutionTargetContext): Promise<ExecutionRunHandle>
  /** 附着到已启动执行（帧流/状态视图）。 */
  attach(run: ExecutionRunHandle): Promise<ExecutionAttachment>
  /** 终止执行（进程组/容器），返回是否确有执行在飞。 */
  cancel(run: ExecutionRunHandle): Promise<boolean>
  /** 等待执行终态并返回结果。 */
  wait(run: ExecutionRunHandle): Promise<RunOutcome>
}

/** target 层错误基类（环境类错误——调用方按 retryable 处理）。 */
export class ExecutionTargetError extends Error {}

/** plan 被改写（prepare 与 start 之间 fingerprint 不一致，或未先 prepare）。 */
export class ExecutionPlanMutationError extends ExecutionTargetError {
  constructor(message: string) {
    super(message)
    this.name = 'ExecutionPlanMutationError'
  }
}

/** 递归深度冻结（plan 不可变断言的一部分；被冻结对象的写操作在 strict 模式抛 TypeError）。 */
export function deepFreezePlan<T>(value: T): T {
  if (typeof value === 'object' && value !== null) {
    for (const key of Object.keys(value as Record<string, unknown>)) {
      deepFreezePlan((value as Record<string, unknown>)[key])
    }
    Object.freeze(value)
  }
  return value
}

/** 实时 chunk 回调（execution-runtime.md §6）。 */
export type OnChunkFn = (channel: 'stdout' | 'stderr', text: string, byteOffset: number, byteLength: number) => void

/**
 * start(plan) 的 target 局部执行参数——不属于 Kernel 固定的 plan
 * （workdir/signal/onChunk/env 是 gateway 运行环境，非执行契约）。
 */
export interface ExecutionTargetContext {
  cwd?: string
  signal?: AbortSignal
  onChunk?: OnChunkFn
  runEnv?: Record<string, string>
}

/** docker 执行引擎（index.ts runDocker 的适配器注入形态）。 */
export interface DockerExecContext {
  command: string[]
  cwd: string
  jobId: string
  signal?: AbortSignal
  onChunk?: OnChunkFn
  runId: string
  runEnv: Record<string, string>
}

export type DockerRunFn = (plan: ExecutionPlanType, exec: DockerExecContext) => Promise<RunOutcome>

export type CancelRunFn = (jobId: string) => boolean

/** buildLocalDockerArgs 的输入（纯参数映射）。 */
export interface LocalDockerArgsInput {
  plan: ExecutionPlanType
  cwd: string
  containerName: string
  env: Record<string, string>
  command: string[]
}

/**
 * plan → `docker run` 参数映射（纯函数，测试无需真实 docker）。
 * 与既有容器安全基线逐项一致（execution-runtime.md §5）：
 * --rm / --network none / --user 65534:65534 / --read-only / --cap-drop ALL /
 * --security-opt no-new-privileges / pids/memory/cpus 取自 plan.limits /
 * 输入只读挂载 + outputs 可写挂载 / --tmpfs /tmp / 固定 image digest。
 */
export function buildLocalDockerArgs(input: LocalDockerArgsInput): string[] {
  const { plan, cwd, containerName, env, command } = input
  const envArgs: string[] = []
  for (const [k, v] of Object.entries(env)) envArgs.push('-e', `${k}=${v}`)
  const gpu = dockerGpuArgument(plan.compute)
  const gpuArgs = gpu === null ? [] : ['--gpus', gpu]
  return [
    'run', '--rm', '--name', containerName,
    // §3.2/§12.3 (RUN-02): 完整容器基线。
    '--network', 'none',
    '--user', '65534:65534',
    '--read-only',
    '--cap-drop', 'ALL',
    '--security-opt', 'no-new-privileges',
    '--pids-limit', String(plan.limits.pids),
    '--memory', `${plan.limits.memory_mb}m`,
    '--cpus', String(plan.limits.cpus),
    ...gpuArgs,
    '--workdir', '/work',
    ...envArgs,
    // 输入区只读；/outputs 是唯一 rw 挂载（§12.2/§12.5 output contract）。
    '-v', `${cwd}:/work:ro`,
    '-v', `${cwd}/outputs:/outputs`,
    '--tmpfs', '/tmp:size=64m',
    // 固定 image digest（RUN-02：target 不得改写 plan.image.digest）。
    plan.image.digest,
    ...command,
  ]
}

/** LocalDockerAdapter 的 run 句柄（内部携带执行承诺）。 */
export interface LocalRunHandle extends ExecutionRunHandle {
  outcome: Promise<RunOutcome>
  state: 'running' | 'done'
}

/**
 * LocalDockerAdapter：ExecutionTarget port 的本地实现。包装既有 docker
 * 执行引擎（runDocker，见 index.ts），行为不变；plan 校验/冻结/fingerprint
 * 断言在本 adapter；docker 参数映射为纯函数 buildLocalDockerArgs。
 */
export class LocalDockerAdapter implements ExecutionTarget {
  readonly target_id: string

  constructor(
    private readonly deps: {
      jobId: string
      dockerRun: DockerRunFn
      cancel: CancelRunFn
      /** Exact opaque registry id configured for this adapter. */
      targetId: string
    },
  ) {
    this.target_id = deps.targetId
  }

  private preparedFingerprint: string | null = null

  /** 校验并冻结 plan，记录 fingerprint——plan 不可变的断言基准。 */
  async prepare(plan: ExecutionPlanType): Promise<ExecutionPreparation> {
    const parsed = ExecutionPlan.parse(plan) // schema 校验失败即抛（计划外字段/缺字段）
    if (parsed.target_id !== this.target_id) {
      throw new ExecutionTargetError(`local Docker target ${this.target_id} refuses plan pinned to ${parsed.target_id}`)
    }
    if (parsed.target_kind !== null && parsed.target_kind !== 'local-docker') {
      throw new ExecutionTargetError(`local Docker target refuses ${parsed.target_kind} plan ${parsed.plan_id}`)
    }
    this.preparedFingerprint = executionPlanFingerprint(deepFreezePlan(parsed))
    return { target_id: this.target_id, fingerprint: this.preparedFingerprint }
  }

  /**
   * 按 plan 启动 docker 执行。先断言 plan 与 prepare 时一致
   * （复算 fingerprint，任何变异 → ExecutionPlanMutationError），
   * 再调用注入的 docker 引擎。`context` 是本 adapter 的局部执行参数
   * （workdir/signal/onChunk/env），不属于 Kernel 固定的 plan；
   * command/run_id 一律取自 plan（target 不得改写）。
   */
  async start(plan: ExecutionPlanType, context: ExecutionTargetContext = {}): Promise<LocalRunHandle> {
    if (this.preparedFingerprint === null) {
      throw new ExecutionPlanMutationError('start() called before prepare() — target requires a prepared plan')
    }
    const parsed = ExecutionPlan.parse(plan) // 归一化默认值后与 prepare 基准对账
    const fingerprint = executionPlanFingerprint(parsed)
    if (fingerprint !== this.preparedFingerprint) {
      throw new ExecutionPlanMutationError(
        'ExecutionPlan mutated between prepare() and start() — targets never rewrite the plan',
      )
    }
    const { jobId, dockerRun } = this.deps
    const startedAt = new Date().toISOString()
    const exec: DockerExecContext = {
      command: parsed.command,
      cwd: context.cwd ?? process.cwd(),
      jobId,
      signal: context.signal,
      onChunk: context.onChunk,
      runId: parsed.run_id,
      runEnv: context.runEnv ?? {},
    }
    const run: LocalRunHandle = {
      handle_id: `handle_${jobId}`,
      target_id: this.target_id,
      job_id: jobId,
      run_id: parsed.run_id,
      started_at: startedAt,
      outcome: Promise.resolve() as unknown as Promise<RunOutcome>,
      state: 'running',
    }
    run.outcome = dockerRun(parsed, exec).then(result => {
      run.state = 'done'
      return result
    })
    return run
  }

  /** attach(run)：本地执行的附着视图（远端帧流接入点见 remote-agent.ts）。 */
  async attach(run: ExecutionRunHandle): Promise<ExecutionAttachment> {
    const local = run as LocalRunHandle
    return { run_id: local.run_id, job_id: local.job_id, target_id: local.target_id, state: local.state }
  }

  /** cancel(run)：终止真实执行（进程组 SIGKILL + docker rm -f，§12.6）。 */
  async cancel(run: ExecutionRunHandle): Promise<boolean> {
    return this.deps.cancel(run.job_id)
  }

  /** wait(run)：等待执行终态。 */
  async wait(run: ExecutionRunHandle): Promise<RunOutcome> {
    return (run as LocalRunHandle).outcome
  }

  /**
   * 便捷组合 prepare → start → wait（gateway 单 target 模式用）。
   * 不改变既有 docker 执行行为——只是把同一路径收敛到 port 上。
   */
  async execute(plan: ExecutionPlanType, context: ExecutionTargetContext = {}): Promise<RunOutcome> {
    await this.prepare(plan)
    const run = await this.start(plan, context)
    return this.wait(run)
  }
}
