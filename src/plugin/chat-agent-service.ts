import { randomBytes, timingSafeEqual } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { join } from 'node:path'
import { SCHOLAR_AGENT_MAX_BODY_BYTES, type ScholarAgentReply } from '@dsh-scholar/research-schemas'
import { isImageAdmissionError } from '@deepseek-ai/dsh-attachment'
import { isScholarAgentError } from './chat-agent-error.js'

// Matches the standalone BFF's bounded JSON envelope. Exact image count,
// decoded byte, dimensions and aggregate policy remain owned by AttachmentStore.
const MAX_BODY_BYTES = SCHOLAR_AGENT_MAX_BODY_BYTES

export interface ScholarAgentBridgeEndpoint {
  origin: string
  pid: number
  started_at: string
}

interface ScholarAgentBridgeDescriptor extends ScholarAgentBridgeEndpoint {
  token: string
}

export interface ScholarAgentBridgeOptions {
  dataDir: string
  handler: () => ((payload: unknown, signal?: AbortSignal) => Promise<ScholarAgentReply>) | undefined
  log?: (line: string) => void
}

// Cordis can overlap an old and a new plugin fiber during hot reload. Keep
// the live bridge instances ordered per shared data directory so disposing
// the newest fiber can republish the still-running predecessor instead of
// leaving a listener that the standalone BFF can no longer discover.
const LIVE_BRIDGES = Symbol.for('@dsh-scholar/research-plugin.live-agent-bridges')
const processGlobals = globalThis as unknown as Record<symbol, unknown>
const liveBridges = (processGlobals[LIVE_BRIDGES] ??= new Map<string, Set<ScholarAgentBridge>>()) as Map<string, Set<ScholarAgentBridge>>

function json(res: ServerResponse, status: number, body: unknown): void {
  const bytes = Buffer.from(JSON.stringify(body))
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': bytes.byteLength,
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  })
  res.end(bytes)
}

async function body(req: IncomingMessage): Promise<{ bytes: Buffer; tooLarge: boolean }> {
  const chunks: Buffer[] = []
  let size = 0
  let tooLarge = false
  for await (const chunk of req) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += bytes.byteLength
    if (size > MAX_BODY_BYTES) {
      tooLarge = true
      continue
    }
    if (!tooLarge) chunks.push(bytes)
  }
  return { bytes: tooLarge ? Buffer.alloc(0) : Buffer.concat(chunks), tooLarge }
}

function atomicPrivateFile(path: string, value: string): void {
  const temp = `${path}.tmp-${process.pid}-${randomBytes(6).toString('hex')}`
  writeFileSync(temp, value, { mode: 0o600, flag: 'wx' })
  try {
    // rename preserves the 0600 mode and atomically replaces the prior
    // complete descriptor; no post-publication operation may make start fail.
    renameSync(temp, path)
  } finally {
    rmSync(temp, { force: true })
  }
}

function bearer(req: IncomingMessage): string | null {
  const value = req.headers.authorization
  const match = typeof value === 'string' ? /^Bearer\s+(.+)$/i.exec(value) : null
  return match?.[1] ?? null
}

function tokenMatches(presented: string | null, expected: string): boolean {
  if (presented === null) return false
  const left = Buffer.from(presented)
  const right = Buffer.from(expected)
  return left.byteLength === right.byteLength && timingSafeEqual(left, right)
}

function safeFailureCode(error: unknown): string {
  if (isScholarAgentError(error)) return error.code
  if (isImageAdmissionError(error)) return 'vision_image_rejected'
  if (error instanceof Error && error.name === 'ZodError') return 'schema_rejected'
  return 'request_rejected'
}

/** Local authenticated HTTP bridge owned by the DSH plugin fiber. */
export class ScholarAgentBridge {
  private server: Server | null = null
  private token = ''
  private endpoint: ScholarAgentBridgeEndpoint | null = null
  private accepting = false
  private readonly activeRequests = new Set<AbortController>()
  private readonly descriptorFile: string

  constructor(private readonly options: ScholarAgentBridgeOptions) {
    this.descriptorFile = join(options.dataDir, 'agent-bridge.json')
  }

  private publish(): void {
    if (this.endpoint === null || this.token === '') throw new Error('Scholar agent bridge is not active')
    const descriptor: ScholarAgentBridgeDescriptor = { ...this.endpoint, token: this.token }
    atomicPrivateFile(this.descriptorFile, JSON.stringify(descriptor))
    rmSync(join(this.options.dataDir, 'agent-bridge-endpoint.json'), { force: true })
    rmSync(join(this.options.dataDir, 'agent-bridge-token'), { force: true })
  }

  private async handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!this.accepting) {
      json(res, 503, { error: { code: 'model_unavailable', message: 'Harness model is unavailable' } })
      return
    }
    if (req.method !== 'POST' || req.url !== '/v1/turn') {
      json(res, 404, { error: { code: 'not_found', message: 'not found' } })
      return
    }
    if (!tokenMatches(bearer(req), this.token)) {
      json(res, 401, { error: { code: 'unauthorized', message: 'unauthorized' } })
      return
    }
    const read = await body(req)
    if (read.tooLarge) {
      json(res, 413, { error: { code: 'payload_too_large', message: 'payload too large' } })
      return
    }
    let payload: unknown
    try { payload = JSON.parse(read.bytes.toString('utf8')) } catch {
      json(res, 400, { error: { code: 'invalid_json', message: 'bad request' } })
      return
    }
    const handler = this.options.handler()
    if (handler === undefined) {
      json(res, 503, { error: { code: 'model_unavailable', message: 'Harness model is unavailable' } })
      return
    }
    const controller = new AbortController()
    const abort = (): void => controller.abort()
    this.activeRequests.add(controller)
    req.once('aborted', abort)
    res.once('close', abort)
    try {
      json(res, 200, await handler(payload, controller.signal))
    } catch (error) {
      if (controller.signal.aborted || res.destroyed || res.writableEnded) return
      const failureCode = safeFailureCode(error)
      this.options.log?.(`Scholar agent request failed (${failureCode})`)
      // This response is visible only on the authenticated loopback bridge.
      // The BFF exposes only its closed, explicitly allowlisted safe subset.
      json(res, 502, { error: { code: failureCode, message: 'Harness model is unavailable' } })
    } finally {
      req.off('aborted', abort)
      res.off('close', abort)
      this.activeRequests.delete(controller)
    }
  }

  async start(): Promise<ScholarAgentBridgeEndpoint> {
    if (this.server !== null && this.endpoint !== null) return this.endpoint
    mkdirSync(this.options.dataDir, { recursive: true })
    this.token = randomBytes(32).toString('hex')
    this.accepting = true
    const server = createServer((req, res) => {
      void this.handleRequest(req, res).catch(error => {
        this.options.log?.(`Scholar agent request failed before dispatch (${safeFailureCode(error)})`)
        if (res.headersSent || res.writableEnded || res.destroyed || req.destroyed) {
          if (!res.destroyed) res.destroy()
          return
        }
        try {
          json(res, 400, { error: { code: 'request_rejected', message: 'bad request' } })
        } catch {
          if (!res.destroyed) res.destroy()
        }
      })
    })
    try {
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject)
        server.listen(0, '127.0.0.1', () => {
          server.off('error', reject)
          resolve()
        })
      })
    } catch (error) {
      this.accepting = false
      this.token = ''
      server.close()
      throw error
    }
    const address = server.address()
    if (address === null || typeof address === 'string') {
      server.close()
      throw new Error('Scholar agent bridge failed to bind loopback')
    }
    this.server = server
    this.endpoint = { origin: `http://127.0.0.1:${address.port}`, pid: process.pid, started_at: new Date().toISOString() }
    const siblings = liveBridges.get(this.options.dataDir) ?? new Set<ScholarAgentBridge>()
    siblings.add(this)
    liveBridges.set(this.options.dataDir, siblings)
    try {
      this.publish()
    } catch (error) {
      this.accepting = false
      siblings.delete(this)
      if (siblings.size === 0) liveBridges.delete(this.options.dataDir)
      this.server = null
      this.endpoint = null
      this.token = ''
      await new Promise<void>(resolve => server.close(() => resolve()))
      throw error
    }
    this.options.log?.('Scholar agent bridge ready')
    return this.endpoint
  }

  async stop(): Promise<void> {
    const server = this.server
    this.server = null
    this.accepting = false
    let ownsFiles = false
    try {
      if (existsSync(this.descriptorFile) && !lstatSync(this.descriptorFile).isSymbolicLink()) {
        const saved = JSON.parse(readFileSync(this.descriptorFile, 'utf8')) as { pid?: unknown; origin?: unknown }
        ownsFiles = saved.pid === this.endpoint?.pid && saved.origin === this.endpoint?.origin
      }
    } catch { ownsFiles = false }
    const siblings = liveBridges.get(this.options.dataDir)
    siblings?.delete(this)
    if (siblings?.size === 0) liveBridges.delete(this.options.dataDir)
    let publicationError: unknown
    try {
      if (ownsFiles) {
        const survivor = siblings === undefined ? undefined : [...siblings].at(-1)
        if (survivor !== undefined) {
          survivor.publish()
        } else {
          rmSync(this.descriptorFile, { force: true })
        }
      }
    } catch (error) {
      publicationError = error
      try { rmSync(this.descriptorFile, { force: true }) } catch { /* best effort: closing the listener remains mandatory */ }
    }
    for (const controller of this.activeRequests) controller.abort()
    this.activeRequests.clear()
    if (server !== null) {
      await new Promise<void>(resolve => {
        server.close(() => resolve())
        server.closeAllConnections()
      })
    }
    this.endpoint = null
    this.token = ''
    if (publicationError !== undefined) throw publicationError
  }
}
