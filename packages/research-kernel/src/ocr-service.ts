/** Single-consumer OCR service owned by the Kernel HTTP runtime. */
import { lstatSync, openSync, closeSync, fstatSync, readFileSync, realpathSync, constants } from 'node:fs'
import { relative, resolve, sep } from 'node:path'
import type { OcrRequest, SecretRef } from '@dsh-scholar/research-schemas'
import type { ResearchKernel } from './kernel.js'
import { MinerUOcrWorker, MinerUTransportError, type MinerUOcrTransport } from './ocr-worker.js'
import { HttpMinerUTransport } from './mineru-transport.js'
import { validateBuiltInProviderContract } from './provider.js'

/** File-backed API tokens only. Reject traversal, symlinks and loose modes
 * before reading; expose no credential through the Kernel HTTP facade. */
export function readMinerUCredential(ref: SecretRef, secretRoot: string | null): string {
  let fd: number | undefined
  try {
    if (ref.scheme !== 'file' || !secretRoot) throw new Error()
    if (ref.name.startsWith('/') || ref.name.includes('\\') || ref.name.split('/').some(part => part === '..' || part === '.')) throw new Error()
    const root = realpathSync(secretRoot)
    const path = resolve(root, ref.name)
    const rel = relative(root, path)
    if (!rel || rel === '..' || rel.startsWith(`..${sep}`) || rel.startsWith(sep) || realpathSync(path) !== path) throw new Error()
    if (lstatSync(path).isSymbolicLink()) throw new Error()
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    const info = fstatSync(fd)
    if (!info.isFile() || (info.mode & 0o777) !== 0o600 || info.size === 0 || info.size > 16 * 1024) throw new Error()
    const token = readFileSync(fd, 'utf8').trim()
    if (!token || /[\r\n\x00-\x1f\x7f]/.test(token)) throw new Error()
    return token
  } catch { throw new MinerUTransportError('provider_unavailable') }
  finally { if (fd !== undefined) closeSync(fd) }
}

export interface MinerUOcrServiceOptions {
  pollIntervalMs?: number
  cancelPollIntervalMs?: number
  /** Explicit adapter seam for isolated contract tests/embedded runtimes. */
  transportFactory?: (request: OcrRequest) => MinerUOcrTransport | Promise<MinerUOcrTransport>
}

export class MinerUOcrService {
  private timer: ReturnType<typeof setTimeout> | undefined
  private monitor: ReturnType<typeof setInterval> | undefined
  private active: { request: OcrRequest | null; abort: AbortController } | null = null
  private inflight: Promise<void> | null = null
  private stopped = false

  constructor(private readonly kernel: ResearchKernel, private readonly options: MinerUOcrServiceOptions = {}) {
    this.schedule(0)
  }

  private transport(request: OcrRequest): MinerUOcrTransport | Promise<MinerUOcrTransport> {
    if (this.options.transportFactory !== undefined) return this.options.transportFactory(request)
    const provider = this.kernel.getProvider(request.provider_id)
    validateBuiltInProviderContract(provider)
    if (!provider.enabled || provider.kind !== 'mineru' || provider.revision !== request.provider_revision
      || this.kernel.providerHash(provider) !== request.provider_config_sha256
      || !provider.models.some(model => model.model_id === request.model_id && model.capabilities.includes('ocr'))) {
      throw new MinerUTransportError('provider_unavailable')
    }
    // Flash explicitly uses the anonymous lightweight endpoint. An available
    // credential must not accidentally turn it into a different model.
    const token = request.model_id === 'flash' ? undefined
      : provider.credential === undefined ? undefined : readMinerUCredential(provider.credential, this.kernel.secretRoot)
    return new HttpMinerUTransport({
      binding: { provider_id: 'mineru', model_id: request.model_id, provider_revision: provider.revision, provider_config_sha256: request.provider_config_sha256 },
      token,
    })
  }

  private schedule(ms: number): void {
    if (this.stopped) return
    this.timer = setTimeout(() => {
      this.timer = undefined
      this.inflight = this.tick().catch(() => { /* durable request state is retained; the next tick may retry */ })
      void this.inflight.finally(() => {
        this.inflight = null
        this.schedule(this.options.pollIntervalMs ?? 1000)
      })
    }, ms)
    this.timer.unref()
  }

  private async tick(): Promise<void> {
    if (this.stopped) return
    const active = { request: null as OcrRequest | null, abort: new AbortController() }
    this.active = active
    const worker = new MinerUOcrWorker(this.kernel, request => {
      active.request = request
      return this.transport(request)
    })
    this.monitor = setInterval(() => {
      if (this.stopped || active.request === null || active.abort.signal.aborted) return
      try {
        if (this.kernel.getOcrRequest(active.request.intake_id, active.request.request_id).status !== 'running') active.abort.abort()
      } catch { active.abort.abort() }
    }, this.options.cancelPollIntervalMs ?? 250)
    this.monitor.unref()
    try { await worker.runOnce(active.abort.signal) }
    finally {
      if (this.monitor !== undefined) clearInterval(this.monitor)
      this.monitor = undefined
      this.active = null
    }
  }

  /** Abort and release synchronously before any caller closes SQLite; await
   * the remaining transport cleanup when performing graceful shutdown. */
  stop(): Promise<void> {
    if (!this.stopped) {
      this.stopped = true
      if (this.timer !== undefined) clearTimeout(this.timer)
      if (this.monitor !== undefined) clearInterval(this.monitor)
      this.timer = undefined
      this.monitor = undefined
      this.active?.abort.abort()
      if (this.active?.request !== null && this.active?.request !== undefined) {
        this.kernel.releaseOcrRequest(this.active.request.request_id)
      }
    }
    return this.inflight ?? Promise.resolve()
  }
}
