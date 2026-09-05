/**
 * FLEET-01 — 生产 runner 二进制接线（docs/remote-runner-wire.md §9 生产接线、
 * hardening-v0.2-status.md §8 FLEET-01 行）。
 *
 * 把已完成的 wire 协议接入 runner-gateway 真实 CLI（bin/runner.ts）：
 *
 * - `--fleet-server <port>`：启动 RemoteFleetServer（HTTP + JSON wire——
 *   attachRemoteFleetRoutes 把 wire 消息挂到真实 HTTP 路由；鉴权复用现有
 *   x-service-token 机制，生产必须 mTLS，见 remote-runner-wire.md §3/§9）；
 *   注册表复用 agent-registry（InMemoryAgentRegistry），从 kernel 按既有
 *   claimJobs 路径拉取 Job、固定并签名 ExecutionPlan、按 target 分发；
 * - `--agent <fleet-url>`：启动 RemoteRunnerAgentImpl 客户端循环
 *   （register → heartbeat → poll claims → 执行 → frames/artifacts/complete），
 *   离线有界 spool 复用 AgentOutboundSpool；plan 验签公钥与 manifest 签名
 *   密钥分别经 `--fleet-public-key`/`--key-file` 配置（缺公钥 → fail closed）；
 * - 角色互斥：`resolveFleetMode` 按 parseCli 输出（只含显式提供的 flag）
 *   判定 `local`（默认，行为不变）| `fleet-server` | `agent`；两个 fleet
 *   角色不能同时出现，且与本地模式专属 flag（--mode）互斥。
 *
 * 本模块只做接线与 CLI 语义，不包含 wire 协议本身（remote-fleet-server.ts /
 * remote-agent.ts）。测试见 tests/unit/fleet-bin.test.ts。
 * @module @dsh-scholar/runner-gateway/fleet-cli
 */

import { randomUUID } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import type { ResearchClient } from '@dsh-scholar/research-client'
import { LOCAL_DOCKER_TARGET_ID, type RemoteAgentRegistration } from '@dsh-scholar/research-schemas'
import { InMemoryAgentRegistry, type AgentRegistry } from './agent-registry.js'
import {
  createRemoteRunnerAgent,
  HttpRemoteFleetTransport,
  type AgentExecutor,
  type RemoteRunnerAgent,
  type RemoteRunnerAgentImpl,
} from './remote-agent.js'
import { probeNvidiaCapabilities } from './docker-preflight.js'
import {
  attachRemoteFleetRoutes,
  createFleetKernelClient,
  RemoteFleetServer,
  type RemoteFleetHttpOptions,
  type RemoteFleetServerOptions,
} from './remote-fleet-server.js'
import type { RunnerSigningKey } from './manifest-signing.js'

/** runner 二进制三个互斥角色。 */
export type FleetCliMode = 'local' | 'fleet-server' | 'agent'

/** CLI 互斥校验失败（bin 打印后 exit 1）。 */
export class FleetCliConfigError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'FleetCliConfigError'
  }
}

/**
 * 按 parseCli 输出判定角色。parseCli 只返回显式提供的 flag，因此
 * `runner.fleet_server_port`/`runner.fleet_url` 的"存在"即该 flag 被提供：
 *
 * - 两者同时提供 → 错误（一个 runner 进程只服务一个 fleet 角色）；
 * - 任一 fleet 角色与 --mode 同给 → 错误（--mode 只对本地 claim 循环有意义，
 *   远端执行由 agent 侧 executor 决定，计划由 ExecutionPlan 固定）；
 * - 缺省 → local（既有行为完全不变）。
 */
export function resolveFleetMode(cli: Record<string, unknown>): FleetCliMode {
  const hasServer = 'runner.fleet_server_port' in cli
  const hasAgent = 'runner.fleet_url' in cli
  if (hasServer && hasAgent) {
    throw new FleetCliConfigError(
      '--fleet-server and --agent are mutually exclusive: one runner process serves exactly one fleet role (or the local claim loop)',
    )
  }
  if ((hasServer || hasAgent) && 'runner.mode' in cli) {
    throw new FleetCliConfigError(
      '--mode is only meaningful in local runner mode: fleet roles execute the signed ExecutionPlan on the agent side, never a local --mode loop',
    )
  }
  return hasServer ? 'fleet-server' : hasAgent ? 'agent' : 'local'
}

/**
 * 代理端注册记录（安全摘要：opaque target_id/agent_id/capabilities/labels/
 * health/cert_fingerprint——连接信息只由服务端 Config/SecretRef 解析）。
 * images 为空 = 接受任何 Kernel 锁内 digest（与 localDockerRegistration
 * 同一语义）；cert_fingerprint=null = 无 mTLS（本地 wire，生产必须替换）。
 * os/arch 从宿主平台映射到 wire 枚举（未知平台按 schema 默认 linux/x64）。
 */
export function buildAgentRegistration(options: {
  agentId: string
  targetId: string
  runnerVersion: string
  labels?: Record<string, string>
  nvidia?: { toolkit_available: true; devices: string[] } | null
}): RemoteAgentRegistration {
  return {
    schema_version: 1,
    target_id: options.targetId,
    agent_id: options.agentId,
    capabilities: {
      os: process.platform === 'darwin' ? 'darwin' : process.platform === 'win32' ? 'windows' : 'linux',
      arch: process.arch === 'arm64' ? 'arm64' : 'x64',
      runner_ver: options.runnerVersion,
      images: [],
      nvidia: options.nvidia ?? null,
    },
    labels: { role: 'remote-agent', ...options.labels },
    health: { status: 'online', last_seen: new Date().toISOString() },
    cert_fingerprint: null,
  }
}

// ── fleet server 主流程 ────────────────────────────────────────────────────

export interface StartFleetServerOptions extends RemoteFleetHttpOptions {
  /** 监听端口（0 = 临时端口，baseUrl 携带实际端口）。 */
  port?: number
  /** 监听 host（默认 127.0.0.1；生产部署须显式绑定可达接口 + mTLS）。 */
  host?: string
}

/**
 * 把 /v1/agents/* 路由挂到真实 node http listener 并监听。返回 server +
 * baseUrl（port=0 时 baseUrl 为实际绑定端口）。
 */
export async function startFleetServer(
  fleet: RemoteFleetServer,
  options: StartFleetServerOptions = {},
): Promise<{ server: Server; baseUrl: string }> {
  const server = createServer()
  attachRemoteFleetRoutes(server, fleet, options)
  const host = options.host ?? '127.0.0.1'
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(options.port ?? 0, host, () => resolve())
  })
  const address = server.address()
  if (address === null || typeof address === 'string') {
    throw new Error('fleet server failed to bind')
  }
  return { server, baseUrl: `http://${host}:${address.port}` }
}

/** 构造 fleet 服务端（注册表复用 agent-registry；kernel client 复用本地
 * runner 同一 ResearchClient 路径——lease/run_id/Manifest 跨 Local/Remote
 * 一致）。owner 缺省 fleet-<id>（与本地 runner 的 owner 缺省同一风格）。 */
export function createFleetServer(
  client: ResearchClient,
  options: Omit<RemoteFleetServerOptions, 'registry' | 'client' | 'owner'> & {
    registry?: AgentRegistry
    owner?: string
  } = {},
): RemoteFleetServer {
  return new RemoteFleetServer({
    registry: options.registry ?? new InMemoryAgentRegistry(),
    client: createFleetKernelClient(client),
    owner: options.owner ?? `fleet-${randomUUID().replaceAll('-', '').slice(0, 8)}`,
    ...options,
  })
}

// ── fleet agent 主流程 ─────────────────────────────────────────────────────

export interface FleetAgentMainOptions {
  /** fleet 服务端 base URL（--agent）。 */
  fleetUrl: string
  /** x-service-token（本地 wire 等价实现；生产必须 mTLS）。 */
  serviceToken?: string
  /** Target-scoped identity, forwarded to Kernel only in an HTTP header. */
  runnerTargetToken?: string
  agentId: string
  targetId: string
  runnerVersion: string
  labels?: Record<string, string>
  /** 服务端签名 ExecutionPlan 的验签公钥 PEM；缺省 → 拒签/拒执行（fail closed）。 */
  publicKeyPem?: string
  /** 代理端签名 run_manifest 的 Ed25519 密钥（kernel 侧须已注册其公钥）。 */
  signingKey?: RunnerSigningKey
  /** 注入执行器（默认 subprocess sandbox；生产可换 docker 路径）。 */
  executor?: AgentExecutor
  /** claim 轮询间隔（ms）。 */
  pollIntervalMs?: number
  heartbeatIntervalMs?: number
  supervisionIntervalMs?: number
  /** 注册重试上限（ms；fleet 服务端可能尚未就绪）。 */
  registerMaxWaitMs?: number
  signal?: AbortSignal
  /** 注册成功回调（bin 打印 agent 身份用）。 */
  onRegistered?: (agent: RemoteRunnerAgent) => void
  /** 单步错误回调（轮询循环内错误不终止循环）。 */
  onError?: (error: unknown) => void
}

/**
 * 代理端主循环：register（带重试，fleet 服务端未就绪时退避）→
 * runPollLoop（heartbeat → flush spool → claim → 执行；单步错误不终止）。
 * 返回执行的 run 数。
 */
export async function runFleetAgentMain(options: FleetAgentMainOptions): Promise<number> {
  const transport = new HttpRemoteFleetTransport(options.fleetUrl, {
    serviceToken: options.serviceToken,
    runnerTargetToken: options.runnerTargetToken,
  })
  const registration = buildAgentRegistration({
    agentId: options.agentId,
    targetId: options.targetId,
    runnerVersion: options.runnerVersion,
    labels: options.labels,
    nvidia: await probeNvidiaCapabilities(),
  })
  const agent = createRemoteRunnerAgent(registration, transport, {
    publicKeyPem: options.publicKeyPem,
    signingKey: options.signingKey,
    executor: options.executor,
    pollIntervalMs: options.pollIntervalMs,
    heartbeatIntervalMs: options.heartbeatIntervalMs,
    supervisionIntervalMs: options.supervisionIntervalMs,
  }) as RemoteRunnerAgentImpl

  await registerWithRetry(agent, options.registerMaxWaitMs ?? 60_000, options.signal)
  options.onRegistered?.(agent)
  return agent.runPollLoop(options.signal)
}

/** 注册重试（fleet 服务端与 runner 同时启动场景）；超时 fail fast（不
 * 静默降级为无注册轮询——未注册 agent 的 claims 恒 404）。 */
async function registerWithRetry(agent: RemoteRunnerAgent, maxWaitMs: number, signal?: AbortSignal): Promise<void> {
  const deadline = Date.now() + maxWaitMs
  let firstError: string | undefined
  while (Date.now() < deadline) {
    try {
      await agent.register()
      return
    } catch (error) {
      if (signal?.aborted === true) throw error
      firstError = (error as Error).message
      await delay(1_000, signal)
    }
  }
  throw new FleetCliConfigError(
    `agent ${agent.agent_id} could not register with the fleet server after ${maxWaitMs}ms: ${firstError ?? 'unknown error'}`,
  )
}

/** LOCAL_DOCKER_TARGET_ID 与 target 缺省解析（CLI 空值 → local-docker）。 */
export function resolveTargetId(value: string | undefined): string {
  return value !== undefined && value !== '' ? value : LOCAL_DOCKER_TARGET_ID
}

/** 生成缺省 agent id（agent-<8 hex>，与 runner-<8 hex> 同一风格）。 */
export function generateAgentId(): string {
  return `agent-${randomUUID().replaceAll('-', '').slice(0, 8)}`
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise(resolve => {
    if (signal?.aborted === true) {
      resolve()
      return
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = (): void => {
      clearTimeout(timer)
      resolve()
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}
