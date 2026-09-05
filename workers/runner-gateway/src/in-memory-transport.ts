/**
 * RUN-REMOTE-01 — InMemoryFleetTransport：mock 传输（docs/remote-runner-wire.md §8）。
 *
 * 直接把代理端 wire 调用转给 RemoteFleetServer 的内存实现，但请求/响应都经过
 * JSON 序列化 round-trip（模拟 HTTP+JSON wire），任何 schema 漂移都会在此暴露；
 * 服务端错误（FleetServerError）按 HTTP 语义映射为 RemoteWireError
 * （status/code/retryable），与 HttpRemoteFleetTransport 行为一致。
 *
 * 用途：单元测试（不依赖真实远端/mTLS）与本地 loopback 调试。
 * @module @dsh-scholar/runner-gateway/in-memory-transport
 */

import type {
  AgentClaimRequest,
  AgentClaimResponse,
  AgentHeartbeatRequest,
  AgentHeartbeatResponse,
  AgentRegisterRequest,
  AgentRegisterResponse,
  CasFetchResponse,
  RemoteArtifactFinalizeRequest,
  RemoteArtifactFinalizeResponse,
  RemoteArtifactStageRequest,
  RemoteArtifactStageResponse,
  RemoteCompleteRequest,
  RemoteCompleteResponse,
  RemoteFramesRequest,
  RemoteFramesResponse,
  RemoteRunHeartbeatRequest,
  RemoteRunHeartbeatResponse,
} from '@dsh-scholar/research-schemas'
import { FleetServerError, type RemoteFleetServer } from './remote-fleet-server.js'
import { RemoteWireError, type RemoteFleetTransport } from './remote-agent.js'

/** JSON round-trip（模拟 HTTP 序列化；丢弃 undefined，触发 zod 默认值路径）。 */
function wireClone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

/**
 * mock 传输：注册/心跳/claim/frames/artifacts/complete/CAS 全部经由
 * RemoteFleetServer 处理器，错误映射与 HTTP 传输一致。
 */
export class InMemoryFleetTransport implements RemoteFleetTransport {
  readonly kind = 'in-memory'

  constructor(private readonly fleet: RemoteFleetServer) {}

  private async wrap<T>(fn: () => T | Promise<T>): Promise<T> {
    try {
      return await fn()
    } catch (error) {
      if (error instanceof FleetServerError) {
        throw new RemoteWireError(error.status, error.code, error.message, error.retryable)
      }
      throw error
    }
  }

  register(req: AgentRegisterRequest): Promise<AgentRegisterResponse> {
    return this.wrap(() => this.fleet.handleRegister(wireClone(req)))
  }

  heartbeat(agentId: string, req: AgentHeartbeatRequest): Promise<AgentHeartbeatResponse> {
    return this.wrap(() => this.fleet.handleHeartbeat(agentId, wireClone(req)))
  }

  claims(agentId: string, req: AgentClaimRequest): Promise<AgentClaimResponse> {
    return this.wrap(() => this.fleet.handleClaims(agentId, wireClone(req)))
  }

  heartbeatRun(agentId: string, runId: string, req: RemoteRunHeartbeatRequest): Promise<RemoteRunHeartbeatResponse> {
    return this.wrap(() => this.fleet.handleRunHeartbeat(agentId, runId, wireClone(req)))
  }

  uploadFrames(agentId: string, runId: string, req: RemoteFramesRequest): Promise<RemoteFramesResponse> {
    return this.wrap(() => this.fleet.handleFrames(agentId, runId, wireClone(req)))
  }

  stageArtifact(agentId: string, runId: string, req: RemoteArtifactStageRequest): Promise<RemoteArtifactStageResponse> {
    return this.wrap(() => this.fleet.handleStageArtifact(agentId, runId, wireClone(req)))
  }

  finalizeArtifact(agentId: string, runId: string, req: RemoteArtifactFinalizeRequest): Promise<RemoteArtifactFinalizeResponse> {
    return this.wrap(() => this.fleet.handleFinalizeArtifact(agentId, runId, wireClone(req)))
  }

  complete(agentId: string, runId: string, req: RemoteCompleteRequest): Promise<RemoteCompleteResponse> {
    return this.wrap(() => this.fleet.handleComplete(agentId, runId, wireClone(req)))
  }

  async fetchCas(agentId: string, sha: string, projectId: string): Promise<CasFetchResponse | null> {
    try {
      return await this.wrap(() => this.fleet.handleCas(agentId, sha, projectId))
    } catch (error) {
      if (error instanceof RemoteWireError && error.code === 'cas_missing') return null
      throw error
    }
  }
}

/**
 * 可控故障注入包装：networkUp=false 时所有调用抛
 * RemoteWireError(0,'transport_unreachable',retryable)——模拟断网
 * （代理端据此走本地 spool；恢复后重放）。也支持按方法名注入失败。
 */
export class FailingFleetTransport implements RemoteFleetTransport {
  readonly kind = 'failing'
  networkUp = true
  private readonly failingMethods = new Set<string>()

  constructor(private readonly inner: RemoteFleetTransport) {}

  /** 让指定方法失败（如 'complete'）；空字符串 = 全部方法。 */
  failMethod(method: string): void {
    this.failingMethods.add(method)
  }

  clearFailures(): void {
    this.failingMethods.clear()
  }

  private guard(method: string): void {
    if (!this.networkUp || this.failingMethods.has(method) || this.failingMethods.has('')) {
      throw new RemoteWireError(0, 'transport_unreachable', `simulated network partition (method ${method})`, true)
    }
  }

  register(req: AgentRegisterRequest): Promise<AgentRegisterResponse> {
    this.guard('register')
    return this.inner.register(req)
  }

  heartbeat(agentId: string, req: AgentHeartbeatRequest): Promise<AgentHeartbeatResponse> {
    this.guard('heartbeat')
    return this.inner.heartbeat(agentId, req)
  }

  claims(agentId: string, req: AgentClaimRequest): Promise<AgentClaimResponse> {
    this.guard('claims')
    return this.inner.claims(agentId, req)
  }

  heartbeatRun(agentId: string, runId: string, req: RemoteRunHeartbeatRequest, signal?: AbortSignal): Promise<RemoteRunHeartbeatResponse> {
    this.guard('heartbeatRun')
    return this.inner.heartbeatRun(agentId, runId, req, signal)
  }

  uploadFrames(agentId: string, runId: string, req: RemoteFramesRequest): Promise<RemoteFramesResponse> {
    this.guard('uploadFrames')
    return this.inner.uploadFrames(agentId, runId, req)
  }

  stageArtifact(agentId: string, runId: string, req: RemoteArtifactStageRequest): Promise<RemoteArtifactStageResponse> {
    this.guard('stageArtifact')
    return this.inner.stageArtifact(agentId, runId, req)
  }

  finalizeArtifact(agentId: string, runId: string, req: RemoteArtifactFinalizeRequest): Promise<RemoteArtifactFinalizeResponse> {
    this.guard('finalizeArtifact')
    return this.inner.finalizeArtifact(agentId, runId, req)
  }

  complete(agentId: string, runId: string, req: RemoteCompleteRequest): Promise<RemoteCompleteResponse> {
    this.guard('complete')
    return this.inner.complete(agentId, runId, req)
  }

  async fetchCas(agentId: string, sha: string, projectId: string): Promise<CasFetchResponse | null> {
    this.guard('fetchCas')
    return this.inner.fetchCas(agentId, sha, projectId)
  }
}
