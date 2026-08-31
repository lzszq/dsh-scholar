/**
 * DSH Scholar — standalone web application server.
 *
 * Serves the DSH Scholar UI at its own origin, completely independent of
 * the `dsh web` host: it spawns (or reuses) the Research Kernel sidecar,
 * serves the built client bundle plus a minimal bootstrap page, proxies
 * `/v1/*` to the kernel and protects every state-changing call with a
 * loopback bearer token (design §15.2/§15.3).
 *
 * Usage:
 *   node lib/standalone/server.js [--port 18610] [--kernel-port 7412]
 *     [--data-dir <dir>] [--kernel-data-dir <dir>]
 *     [--host 127.0.0.1]
 *
 * On first start a token is generated and persisted under the data dir
 * (`standalone-token`); the browser asks for it once and keeps it
 * in localStorage. Token mode can be disabled with `--no-token` (loopback
 * only, not recommended).
 * @module @dsh-scholar/research-ui/standalone
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { createHash, randomBytes } from 'node:crypto'
import { Readable } from 'node:stream'
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { dirname } from 'node:path'
import { UiKernelSidecar } from './sidecar.js'
import { SettingsWriteTransactionInput, parseScholarModelId, validateConfig, parseCli, generateCliHelp, type CorpusSnapshot, type ExperimentContract, type NoveltyAudit, type ScholarAgentRequest } from '@dsh-scholar/research-schemas'
import { requestScholarAgent } from './chat-agent-client.js'
import { executeStandaloneChatTurn } from './chat-turn-route.js'
import { scholarModelUsability, type ScholarModelCatalogEntry } from '../shared/model-catalog.js'
import {
  MAX_BODY_BYTES,
  SlidingWindowRateLimiter,
  constantTimeEqual,
  createCsrfToken,
  isAllowedOrigin,
  isLoopbackHost,
  verifyCsrfToken,
  withinBodyLimit,
} from './security.js'
import { multiSourceSearch } from '@dsh-scholar/scholar-connectors'

export interface SurveyConnectorResult {
  queries: unknown[]
  hits: Array<{ paper: unknown }>
  citation_edges: unknown[]
  source_status: Array<{ source: string; status: 'ok' | 'failed'; error?: string }>
}

/** Convert connector output to the stable CorpusSnapshot write shape. Error
 * text stays server-side; any failed source makes aggregate coverage pending. */
export function surveySnapshotBody(result: SurveyConnectorResult): {
  queries: unknown[]
  papers: unknown[]
  citation_edges: unknown[]
  source_status: 'pending' | 'complete'
} {
  return {
    queries: result.queries,
    papers: result.hits.map(hit => hit.paper),
    citation_edges: result.citation_edges,
    source_status: result.source_status.some(source => source.status === 'failed') ? 'pending' : 'complete',
  }
}

/** Survey freezes project research data, so read-only project roles cannot
 * trigger it even though execution is initiated from Chat. */
export function surveyWriteRoleAllowed(role: string | null): boolean {
  return role === 'pi' || role === 'operator' || role === 'researcher'
}

export interface SettingsWriteAuthorizationTargets {
  requiresGlobalAdmin: boolean
  projectIds: string[]
}

/** Parse the exact Settings transaction once at the standalone trust
 * boundary and project the authorities it needs. The browser cannot hide a
 * project-scoped binding inside an otherwise global OCR save. */
export function settingsWriteAuthorizationTargets(raw: string): SettingsWriteAuthorizationTargets {
  const input = SettingsWriteTransactionInput.parse(JSON.parse(raw) as unknown)
  const projects = new Set<string>()
  let requiresGlobalAdmin = false
  for (const operation of input.operations) {
    if (operation.kind === 'config') {
      if (operation.scope === 'project') projects.add(operation.scope_id)
      else requiresGlobalAdmin = true
    } else if (operation.kind === 'ocr-mineru') {
      requiresGlobalAdmin = true
      if (operation.binding !== undefined) projects.add(operation.binding.project_id)
    } else {
      requiresGlobalAdmin = true
    }
  }
  return { requiresGlobalAdmin, projectIds: [...projects].sort() }
}

interface IdeaAuditCandidate {
  title: string
  hypothesis: string
  exact_delta: string
}

interface IdeaAuditSearchResult {
  hits: Array<{ paper: { paper_id?: unknown } }>
  source_status: Array<{ status: 'ok' | 'failed' }>
}

/** Bounded, deterministic counter-search queries derived from the selected candidate. */
export function ideaAuditQueries(idea: IdeaAuditCandidate): string[] {
  return [idea.title, idea.hypothesis, idea.exact_delta]
    .map(query => query.trim().replace(/\s+/g, ' ').slice(0, 512))
    .filter((query, index, all) => query !== '' && all.indexOf(query) === index)
    .slice(0, 3)
}

/** Convert connector evidence into the strict persisted NoveltyAudit shape. */
export function ideaNoveltyAudit(
  queries: string[],
  results: IdeaAuditSearchResult[],
  auditedAt = new Date().toISOString(),
): NoveltyAudit {
  const partial = results.some(result => result.source_status.some(source => source.status === 'failed'))
  const overlapPapers = [...new Set(results.flatMap(result => result.hits.flatMap(hit => {
    const paperId = hit.paper.paper_id
    return typeof paperId === 'string' && paperId !== '' ? [paperId] : []
  })))].slice(0, 20)
  return {
    queries,
    result: partial ? 'inconclusive' : overlapPapers.length === 0 ? 'no_direct_match_found' : 'overlap_found',
    overlap_papers: overlapPapers,
    unresolved_risk: partial ? 'high' : 'medium',
    audited_at: auditedAt,
  }
}

interface ContractIdeaCandidate {
  exact_delta: string
  minimum_viable_experiment: {
    dataset: string
    baseline: string
    primary_metric: string
    estimated_gpu_hours: number
  }
}

/** Deterministic first Contract draft; the Human Contract Gate reviews it. */
export function contractDraftFromIdea(idea: ContractIdeaCandidate): Omit<ExperimentContract,
  'contract_id' | 'version' | 'project_id' | 'idea_id' | 'status' | 'approval' | 'created_at' | 'updated_at'> {
  const seeds = [11, 23, 47, 89, 101]
  return {
    data: {
      dataset_id: idea.minimum_viable_experiment.dataset.trim(),
      version: 'official',
      split: 'official',
    },
    methods: {
      baseline: idea.minimum_viable_experiment.baseline.trim(),
      treatment: idea.exact_delta.trim(),
    },
    metrics: {
      primary: idea.minimum_viable_experiment.primary_metric.trim(),
      secondary: [],
      direction: 'higher_is_better',
    },
    seeds,
    analysis: {
      effect_size: 'mean_difference',
      interval: 'bootstrap_95',
      multiple_testing: 'holm',
    },
    ablations: [],
    stop_conditions: {
      max_gpu_hours: Math.max(1, Math.ceil(idea.minimum_viable_experiment.estimated_gpu_hours)),
      min_completed_seeds: seeds.length,
      stop_on_data_leakage: true,
    },
  }
}

const DEFAULT_PORT = 18610
const DEFAULT_KERNEL_PORT = 7412

/**
 * GOV-01/ONBOARD-01 (hardening §5 P1): explicit capability ROUTE TABLE for
 * PI-only writes, matched against the RAW pathname (segment-anchored, no
 * query params — the previous substring regex, made explicit). Governance
 * writes: transitions, gates, decisions, budget, approve, accept (existing)
 * PLUS intake ADOPT (POST /v1/projects/{id}/intake/{iid}/adopt — the PI
 * decision that converts a proposal into project state) and project
 * archive/unarchive. researcher/viewer/auditor → 403 role forbidden;
 * pi/operator are the only permitted roles. The same table is shared with
 * the kernel (research-kernel server.ts isPiOnlyWrite) so the two layers
 * can never drift apart.
 */
const PI_ONLY_WRITE_ROUTES: ReadonlyArray<RegExp> = [
  /(?:^|\/)transitions(?:\/|$)/,
  /(?:^|\/)gates(?:\/|$)/,
  /(?:^|\/)decisions(?:\/|$)/,
  /(?:^|\/)budget(?:\/|$)/,
  /(?:^|\/)approve(?:\/|$)/,
  /(?:^|\/)accept(?:\/|$)/,
  /(?:^|\/)intake\/[^/]+\/adopt(?:\/|$)/,
  /(?:^|\/)archive(?:\/|$)/,
  /(?:^|\/)unarchive(?:\/|$)/,
  // INIT-GRILL-02 §2: Grill confirm 是 PI-only（与 kernel 表逐字同步）。
  /(?:^|\/)grill\/confirm(?:\/|$)/,
  /(?:^|\/)idea-gate(?:\/|$)/,
  /(?:^|\/)contract-gate(?:\/|$)/,
]

function isPiOnlyWrite(pathname: string): boolean {
  return PI_ONLY_WRITE_ROUTES.some(re => re.test(pathname))
}

function isProjectDelete(method: string, pathname: string): boolean {
  return method === 'DELETE' && /^\/v(?:1|2)\/projects\/[^/]+\/?$/.test(pathname)
}

/** The subset of PI-only routes the KERNEL re-enforces from its own
 * project_members table (defense in depth): the BFF injects its
 * server-derived x-principal-id/x-principal-role on these forwards so the
 * kernel second layer can resolve the acting principal's role itself. */
const KERNEL_PI_ONLY_FORWARD_ROUTES: ReadonlyArray<RegExp> = [
  /(?:^|\/)intake\/[^/]+\/adopt(?:\/|$)/,
  /(?:^|\/)archive(?:\/|$)/,
  /(?:^|\/)unarchive(?:\/|$)/,
]

function isKernelPiOnlyForward(pathname: string): boolean {
  return KERNEL_PI_ONLY_FORWARD_ROUTES.some(re => re.test(pathname))
}

/** Intake Human mutations whose identity must come from the authenticated
 * standalone operator session, never the JSON body. */
function isIntakeHumanForward(method: string, pathname: string): boolean {
  return method === 'POST'
    && /^\/v1\/projects\/[^/]+\/intake\/[^/]+\/(?:answers|adopt|reject)$/.test(pathname)
}

/** The v1 SSE real-time stream routes (api-contracts.md §22) that sit under
 * a PATH project and demand the authenticated principal at the kernel
 * (requireProjectMember fail-closed): the BFF injects its server-derived
 * operator identity on these forwards exactly like /v1/topology. The pty
 * frames stream (/v1/pty/sessions/{id}/frames/stream) is already covered
 * by the /v1/pty/sessions prefix rule below. */
const SSE_STREAM_FORWARD_ROUTES: ReadonlyArray<RegExp> = [
  /^\/v1\/projects\/[^/]+\/workspaces\/[^/]+\/watch\/stream$/,
  /^\/v1\/projects\/[^/]+\/trajectory\/stream$/,
]

function isSseStreamForward(pathname: string): boolean {
  return SSE_STREAM_FORWARD_ROUTES.some(re => re.test(pathname))
}

/** Project-scoped Trajectory/Topology JSON routes that use the same Kernel
 * membership guard as their SSE/child counterparts. The browser cannot
 * supply identity; the standalone BFF derives it from its operator session. */
const PROJECT_TRAJECTORY_TOPOLOGY_FORWARD_ROUTES: ReadonlyArray<RegExp> = [
  /^\/v1\/projects\/[^/]+\/trajectory\/?$/,
  /^\/v1\/projects\/[^/]+\/trajectory-lanes\/?$/,
  /^\/v1\/projects\/[^/]+\/topology\/?$/,
  /^\/v1\/projects\/[^/]+\/topology\/children\/?$/,
]

export function isProjectTrajectoryTopologyForward(pathname: string): boolean {
  return PROJECT_TRAJECTORY_TOPOLOGY_FORWARD_ROUTES.some(re => re.test(pathname))
}

const MODEL_FILE = 'model.json'

interface LiveScholarModel extends ScholarModelCatalogEntry {
  id: string
  provider: string
  model: string
  name: string
}

/** Read the current DSH runtime catalog. No static model fallback is kept:
 * absent capability metadata is exactly why visual input must fail closed. */
async function readLiveScholarModels(dataDir: string): Promise<LiveScholarModel[] | null> {
  try {
    const reply = await requestScholarAgent(dataDir, { operation: 'list_models' }, 2_000)
    return reply.operation === 'list_models' ? reply.models : null
  } catch {
    return null
  }
}

/** Resolve one exact configured provider/model route. Model ids are opaque;
 * only the first slash separates the provider from the adapter-owned id. */
async function resolveLiveScholarModel(dataDir: string, qualified: string): Promise<LiveScholarModel | null> {
  const route = parseScholarModelId(qualified)
  if (route === null) return null
  try {
    const reply = await requestScholarAgent(dataDir, {
      operation: 'resolve_model',
      provider: route.provider,
      model: route.model,
    }, 2_000)
    return reply.operation === 'resolve_model' && reply.model.id === qualified
      ? { ...reply.model, available: true }
      : null
  } catch {
    return null
  }
}

/** Current model preference ('' = agent default / no override). */
function readModelPreference(dataDir: string): string {
  try {
    const raw = readFileSync(join(dataDir, MODEL_FILE), 'utf8')
    const parsed = JSON.parse(raw) as { model?: unknown }
    return typeof parsed.model === 'string' ? parsed.model : ''
  } catch {
    return ''
  }
}

/** Persist the model preference (0600, never logged). */
function writeModelPreference(dataDir: string, model: string): void {
  mkdirSync(dataDir, { recursive: true })
  const file = join(dataDir, MODEL_FILE)
  writeFileSync(file, JSON.stringify({ model, updated_at: new Date().toISOString() }, null, 2), { mode: 0o600 })
  chmodSync(file, 0o600)
}

const SESSION_FILE = 'session.json'

export interface OperatorSession {
  session_id: string
  principal_id: string
  tenant_id: string | null
  auth_method: 'dsh-session'
  created_at: string
  updated_at: string
}

export interface HumanGateDecisionBody {
  decision: 'approved' | 'rejected' | 'revised'
  reason?: string
  diff?: string
  principal: {
    principal_id: string
    tenant_id: string
    auth_method: 'dsh-session'
    session_id: string
  }
}

/** Human Gate errors always carry the server-generated correlation id, even
 * when the request is rejected before the Kernel is contacted. */
export function humanGateBffError(requestId: string, code: string, message: string): {
  error: { code: string; message: string; request_id: string }
} {
  return { error: { code, message, request_id: requestId } }
}

/** Normalize a Kernel rejection before it crosses the Human BFF. Known 4xx
 * domain errors remain actionable; every 5xx message is fixed and generic so
 * paths, SQL and credentials can never be reflected into the browser. */
export function humanGateUpstreamError(requestId: string, status: number, payload: unknown): {
  error: { code: string; message: string; request_id: string }
} {
  const envelope = payload !== null && typeof payload === 'object' ? payload as Record<string, unknown> : {}
  const error = envelope.error !== null && typeof envelope.error === 'object'
    ? envelope.error as Record<string, unknown>
    : {}
  const candidate = error.code
  const code = typeof candidate === 'string' && /^[a-z][a-z0-9_]{0,63}$/.test(candidate)
    ? candidate
    : status >= 500 ? 'kernel_error' : 'request_rejected'
  const message = status >= 500
    ? 'research request failed'
    : typeof error.message === 'string' && error.message.length <= 500
      ? error.message
      : 'research request rejected'
  return humanGateBffError(requestId, code, message)
}

/** Build the only Gate Decision body allowed to cross the Human BFF.
 * Client actor/principal/session/request identity fields are deliberately
 * ignored; identity always comes from the durable operator session. */
export function humanGateDecisionBody(input: unknown, session: OperatorSession): HumanGateDecisionBody | null {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) return null
  const value = input as Record<string, unknown>
  const decision = value.decision
  if (decision !== 'approved' && decision !== 'rejected' && decision !== 'revised') return null
  if (value.reason !== undefined && typeof value.reason !== 'string') return null
  if (value.diff !== undefined && typeof value.diff !== 'string') return null
  return {
    decision,
    ...(typeof value.reason === 'string' ? { reason: value.reason } : {}),
    ...(typeof value.diff === 'string' ? { diff: value.diff } : {}),
    principal: {
      principal_id: session.principal_id,
      tenant_id: session.tenant_id ?? '',
      auth_method: session.auth_method,
      session_id: session.session_id,
    },
  }
}

/**
 * GOV-01 principal resolver (local scope): derive the operator's DURABLE
 * session identity from the loopback bearer credential. The session id is
 * deterministic (sha256 of principal + a per-data-dir secret), persisted
 * 0600 under the data dir, and stable across standalone restarts — the
 * "Session link 在重启后恢复" property. An external IdP can replace this
 * resolver later; the durable principal/tenant/auth_method/session shape is
 * the contract the kernel already persists on decisions.
 */
export function operatorSession(dataDir: string, principalId: string): OperatorSession {
  const file = join(dataDir, SESSION_FILE)
  const now = new Date().toISOString()
  const existing = ((): OperatorSession | null => {
    try {
      const parsed = JSON.parse(readFileSync(file, 'utf8')) as Partial<OperatorSession>
      if (typeof parsed.session_id === 'string' && typeof parsed.principal_id === 'string') {
        return { session_id: parsed.session_id, principal_id: parsed.principal_id, tenant_id: null, auth_method: 'dsh-session', created_at: parsed.created_at ?? now, updated_at: parsed.updated_at ?? now }
      }
    } catch { /* absent or malformed — recreate */ }
    return null
  })()
  if (existing !== null && existing.principal_id === principalId) {
    return existing
  }
  const session: OperatorSession = {
    session_id: `sess_${createHash('sha256').update(`${principalId}:${dataDir}`).digest('hex').slice(0, 16)}`,
    principal_id: principalId,
    tenant_id: null,
    auth_method: 'dsh-session',
    created_at: now,
    updated_at: now,
  }
  try {
    mkdirSync(dataDir, { recursive: true })
    const tmp = `${file}.tmp`
    writeFileSync(tmp, JSON.stringify(session, null, 2), { mode: 0o600 })
    chmodSync(tmp, 0o600)
    renameSync(tmp, file)
  } catch { /* read-only data dir — session still derived deterministically */ }
  return session
}

interface StandaloneOptions {
  host: string
  port: number
  kernelPort: number
  /** Authoritative Kernel storage, shared with the DSH plugin instance. */
  kernelDataDir: string
  /** Standalone BFF-only state (browser token, session and model choice). */
  dataDir: string
  token: string | null
  /** API-01: loopback operator identity. When set, the BFF enforces project
   * membership on project-scoped /v1 routes (non-member -> 404). */
  principal: string | null
  /** Exact HTTPS or loopback-HTTP DSH origins allowed to embed the page. */
  frameAncestors: string
}

export function standaloneFrameAncestorSources(value: string): string[] {
  const sources: string[] = []
  for (const raw of value.split(',').map(item => item.trim()).filter(item => item !== '')) {
    if (raw.includes('*')) throw new Error('frame ancestors must not contain wildcards')
    let parsed: URL
    try { parsed = new URL(raw) } catch { throw new Error(`invalid frame ancestor origin: ${raw}`) }
    if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && isLoopbackHost(parsed.hostname))) {
      throw new Error(`frame ancestor must use HTTPS or loopback HTTP: ${raw}`)
    }
    if (parsed.username !== '' || parsed.password !== '' || parsed.pathname !== '/' || parsed.search !== '' || parsed.hash !== '') {
      throw new Error(`frame ancestor must be an exact origin without credentials/path/query/fragment: ${raw}`)
    }
    if (!sources.includes(parsed.origin)) sources.push(parsed.origin)
  }
  if (sources.length === 0) throw new Error('at least one frame ancestor origin is required')
  return sources
}

export function standaloneContentSecurityPolicy(nonce: string, frameAncestors: readonly string[]): string {
  return [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}'`,
    `style-src 'self' 'nonce-${nonce}'`,
    "style-src-attr 'unsafe-inline'",
    "img-src 'self' blob: data:",
    "media-src 'self' blob:",
    "frame-src 'self' blob:",
    "connect-src 'self'",
    "font-src 'self' data:",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    `frame-ancestors 'self' ${frameAncestors.join(' ')}`,
  ].join('; ')
}

export function bootstrapHtmlWithNonce(nonce: string): string {
  return BOOTSTRAP_HTML
    .replaceAll('<script', `<script nonce="${nonce}"`)
    .replace('<style>', `<style nonce="${nonce}">`)
}

/** Constant-time token comparison (values never appear in logs). */
function tokenMatches(provided: string | undefined, expected: string): boolean {
  return constantTimeEqual(provided, expected)
}

/**
 * API-01/GOV-01 (hardening §4 P0): JSON write bodies are normalized so the
 * kernel only ever records the SESSION-derived operator principal. Identity
 * fields the client supplies are overwritten with the BFF-resolved identity
 * or removed — a client can never claim another creator, actor, tenant or
 * session. `principal_id` is deliberately NOT in the set: project member
 * routes legitimately add OTHER principals (e.g. POST /v1/projects/{id}/members).
 * Applied to POST/PATCH/PUT bodies only; non-JSON bodies pass through untouched.
 */
function normalizeIdentityBody(raw: string, principalId: string, sessionId: string, seedCreator: boolean): string {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return raw
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return raw
  const body = parsed as Record<string, unknown>
  let changed = false
  if ('creator_principal_id' in body) {
    body.creator_principal_id = principalId
    changed = true
  }
  if ('creator_tenant_id' in body) {
    // The tenant comes from the session only (operatorSession tenant_id is
    // null) — a client-forged tenant is dropped, never forwarded.
    delete body.creator_tenant_id
    changed = true
  }
  if ('actor' in body) {
    body.actor = principalId
    changed = true
  }
  if ('principal' in body) {
    // Full session-derived principal; the client's claimed tenant_id,
    // auth_method and session_id are never forwarded. tenant_id is '' on
    // the wire (kernel decisionSchema requires a string; operatorSession
    // keeps tenant_id null — an empty tenant is the session truth).
    body.principal = { principal_id: principalId, tenant_id: '', auth_method: 'dsh-session', session_id: sessionId }
    changed = true
  }
  if ('session_id' in body) {
    // A forged session is dropped; the kernel binds the BFF-forwarded
    // x-principal-session instead (server.ts GOV-01 resolver).
    delete body.session_id
    changed = true
  }
  if (seedCreator && !('creator_principal_id' in body)) {
    // Project create: the BFF seeds the creator PI membership from the
    // authenticated session even when the client omits the field.
    body.creator_principal_id = principalId
    changed = true
  }
  return changed ? JSON.stringify(body) : raw
}

function secureExistingTokenFile(tokenFile: string): void {
  const stat = lstatSync(tokenFile)
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new Error('standalone token path must be a regular file')
  }
  chmodSync(tokenFile, 0o600)
}

function readBody(req: IncomingMessage): Promise<{ body: string; tooLarge: boolean }> {
  return new Promise(resolve => {
    const chunks: Buffer[] = []
    let total = 0
    let settled = false
    const done = (value: { body: string; tooLarge: boolean }): void => {
      if (!settled) {
        settled = true
        resolve(value)
      }
    }
    req.on('data', (chunk: Buffer) => {
      if (settled) return // keep draining after the cap so the caller can
      // receive the explicit 413 instead of a connection-reset error.
      total += chunk.length
      if (!withinBodyLimit(total)) {
        done({ body: '', tooLarge: true })
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => done({ body: Buffer.concat(chunks).toString('utf8'), tooLarge: false }))
    req.on('error', () => done({ body: '', tooLarge: false }))
    req.on('close', () => done({ body: '', tooLarge: false }))
  })
}

/**
 * UPLOAD-01: raw-bytes body reader for multipart passthrough — a string
 * conversion would corrupt binary file content. `limit` is the kernel's
 * upload body cap (32 MiB file + bounded multipart envelope overhead), so
 * the BFF rejects oversized uploads with 413 before forwarding; the kernel
 * enforces the same cap again (defense in depth).
 */
function readBodyBytes(req: IncomingMessage, limit: number): Promise<{ buffer: Buffer; tooLarge: boolean }> {
  return new Promise(resolve => {
    const chunks: Buffer[] = []
    let total = 0
    let settled = false
    const done = (value: { buffer: Buffer; tooLarge: boolean }): void => {
      if (!settled) {
        settled = true
        resolve(value)
      }
    }
    req.on('data', (chunk: Buffer) => {
      if (settled) return // past the cap: keep draining (bounded memory) so
      // the client can still read our 413 response — destroying the socket
      // here would surface as a client-side connection error instead.
      total += chunk.length
      if (!withinBodyLimit(total, limit)) {
        done({ buffer: Buffer.alloc(0), tooLarge: true })
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => done({ buffer: Buffer.concat(chunks), tooLarge: false }))
    req.on('error', () => done({ buffer: Buffer.alloc(0), tooLarge: false }))
    req.on('close', () => done({ buffer: Buffer.alloc(0), tooLarge: false }))
  })
}

/**
 * UPLOAD-01: multipart uploads are capped at the kernel's 32 MiB file limit
 * plus a bounded envelope allowance (headers + boundaries) — same budget as
 * the kernel's uploads.ts UPLOAD_MAX_BODY_BYTES.
 */
const UPLOAD_MAX_BODY_BYTES = (32 + 1) * 1024 * 1024

/** JSON error responses never carry internal paths/env (design §15.2). */
function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  })
  res.end(JSON.stringify(payload))
}

/**
 * BFF-native error body (api-contracts.md §2 envelope): stable machine
 * `code` + safe English `message`, `ok:false` at the surface. Kernel-proxied
 * responses keep their own wire envelope (`{error:{code,message,...}}` per
 * reconstruction-contracts.md) — the BFF never rewrites upstream bodies.
 * Message texts are preserved so surface consumers (and the security test
 * suite's substring assertions) see the same copy as before.
 */
export function bffError(code: string, message: string): { ok: false; error: { code: string; message: string } } {
  return { ok: false, error: { code, message } }
}

/** Normalize both the current error envelope and the pre-envelope string. */
export function parseStandaloneUnlockError(error: unknown): { code: string | null; message: string | null } {
  if (typeof error === 'string') {
    return { code: error === 'invalid token' ? 'unauthorized' : null, message: error }
  }
  if (typeof error !== 'object' || error === null || Array.isArray(error)) return { code: null, message: null }
  const value = error as Record<string, unknown>
  return {
    code: typeof value.code === 'string' ? value.code : null,
    message: typeof value.message === 'string' ? value.message : null,
  }
}

const PARSE_STANDALONE_UNLOCK_ERROR_SOURCE = parseStandaloneUnlockError.toString()

const BOOTSTRAP_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title data-i18n="standalone.pageTitle">dsh Scholar</title>
<script>
  // Unlock-page locale (gui-plugin-plan §13.4 / acceptance §8): pick BEFORE
  // first paint, same choice order as the client adapter: persisted
  // dsh.locale → navigator.languages → navigator.language → zh.
  (function () {
    var LOCALE_KEY = 'dsh.locale';
    function pickLocale() {
      try {
        var saved = localStorage.getItem(LOCALE_KEY);
        if (saved === 'zh' || saved === 'en') return saved;
      } catch (e) {}
      var candidates = [];
      if (typeof navigator !== 'undefined') {
        if (Array.isArray(navigator.languages)) candidates = candidates.concat(navigator.languages);
        if (typeof navigator.language === 'string' && navigator.language !== '') candidates.push(navigator.language);
      }
      for (var i = 0; i < candidates.length; i++) {
        var base = String(candidates[i]).toLowerCase().split('-')[0] || '';
        if (base === 'zh') return 'zh';
        if (base === 'en') return 'en';
      }
      return 'zh';
    }
    window.__BOOT_LOCALE__ = pickLocale();
    document.documentElement.lang = window.__BOOT_LOCALE__;
    // Inline zh/en dictionaries for the token gate (server-rendered page).
    // Keys mirror the client standalone namespace (i18n/locales/standalone.ts)
    // so the unlock page and the locale dictionaries stay in lockstep.
    var ZH = {
      'standalone.pageTitle': 'dsh Scholar',
      'standalone.brand.name': 'Scholar',
      'standalone.brand.meta': '工作区',
      'standalone.operatorAccess': '操作员访问',
      'standalone.welcomeBack': '欢迎回来。',
      'standalone.intro': '打开你的证据工作区。人类门控决策将记录你的操作员身份。',
      'standalone.accessToken': '访问令牌',
      'standalone.openWorkspace': '打开工作区',
      'standalone.invalidToken': '令牌无效',
      'standalone.serverUnreachable': '服务器不可达',
      'standalone.bundleFailed': '客户端加载失败',
      'standalone.tokenHint': '你的令牌在本地服务器启动时生成,只保留在本机。',
      'standalone.theme.dark': '深色',
      'standalone.theme.light': '浅色',
    };
    var EN = {
      'standalone.pageTitle': 'dsh Scholar',
      'standalone.brand.name': 'Scholar',
      'standalone.brand.meta': 'Workspace',
      'standalone.operatorAccess': 'Operator access',
      'standalone.welcomeBack': 'Welcome back.',
      'standalone.intro': 'Open your evidence workspace. Human gate decisions are recorded with your operator identity.',
      'standalone.accessToken': 'Access token',
      'standalone.openWorkspace': 'Open workspace',
      'standalone.invalidToken': 'Invalid token',
      'standalone.serverUnreachable': 'Server unreachable',
      'standalone.bundleFailed': 'Client bundle failed to load',
      'standalone.tokenHint': 'Your token is generated when the local server starts and remains on this machine.',
      'standalone.theme.dark': 'Dark',
      'standalone.theme.light': 'Light',
    };
    var DICT = window.__BOOT_LOCALE__ === 'zh' ? ZH : EN;
    window.__BOOT_DICT__ = DICT;
    window.__BOOT_MSG__ = function (key) { return DICT[key] || key; };
    // The swap needs the body; run now if present, else on first paint.
    function applyI18n() {
      document.querySelectorAll('[data-i18n]').forEach(function (n) {
        var key = n.getAttribute('data-i18n');
        if (key && DICT[key]) n.textContent = DICT[key];
      });
      var ph = document.getElementById('token-input');
      if (ph) ph.placeholder = DICT['standalone.accessToken'];
    }
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', applyI18n);
    } else {
      applyI18n();
    }
  })();
</script>
<style>
  :root { color-scheme: light; --bg:#ffffff; --surface:#ffffff; --border:rgba(0,0,0,.10); --text:#0f1115; --muted:#61666b; --faint:#81858c; --accent:#4176e6; --accent-soft:#edf3fe; }
  :root[data-theme="dark"] { color-scheme: dark; }
  :root[data-theme="dark"] { --bg:#151517; --surface:#232324; --border:rgba(255,255,255,.12); --text:#f9fafb; --muted:#cfd3d6; --faint:#adb2b8; --accent:#679efe; --accent-soft:#34415b; }
  * { box-sizing:border-box; }
  body { margin:0; min-height:100vh; overflow:hidden; background:var(--bg); color:var(--text); font:14px/22px -apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Hiragino Sans GB","Microsoft YaHei","Helvetica Neue",Helvetica,Arial,sans-serif; }
  #boot-screen { position:fixed; inset:0; display:flex; align-items:center; justify-content:center; padding:24px; z-index:9998; }
  .card { position:relative; width:min(380px,100%); overflow:hidden; padding:24px; background:var(--surface); border:1px solid var(--border); border-radius:24px; box-shadow:0 0 1px rgba(0,0,0,.2),0 0 4px rgba(0,0,0,.02),0 12px 32px rgba(0,0,0,.08); }
  .brand { display:flex; align-items:baseline; gap:8px; margin-bottom:28px; }
  .brand-mark { color:var(--text); font:700 19px/22px -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif; letter-spacing:-.06em; }
  .brand-name { color:var(--text); font:500 14px/20px -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif; }
  .brand-meta { margin-top:0; color:var(--faint); font:400 12px/18px -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif; }
  .eyebrow { margin-bottom:8px; color:var(--accent); font:500 13px/20px -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif; }
  .card h1 { margin:0 0 8px; color:var(--text); font:500 26px/32px -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif; letter-spacing:0; }
  .card p { margin:0 0 24px; color:var(--muted); font-size:14px; line-height:22px; }
  .field-label { display:block; margin:0 0 7px; color:var(--text); font:500 13px/20px -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif; }
  .card input { width:100%; height:44px; background:transparent; color:var(--text); border:1px solid var(--border); border-radius:22px; padding:7px 14px; font:400 14px/22px 'SF Mono','JetBrains Mono','Fira Code',Consolas,'Liberation Mono',Menlo,Courier,sans-serif; outline:none; margin-bottom:10px; box-shadow:none; }
  .card input:focus { border-color:var(--border); box-shadow:none; }
  .card button { width:100%; min-height:40px; background:var(--accent); color:#fff; border:0; border-radius:20px; padding:9px 14px; font:500 14px/22px -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif; cursor:pointer; box-shadow:none; transition:background-color .1s cubic-bezier(.4,0,.2,1),opacity .1s cubic-bezier(.4,0,.2,1); }
  .card button:hover { filter:brightness(1.08); transform:none; }
  .card button:active { transform:none; }
  .err { color:#dc2626; font-size:11px; margin-top:10px; min-height:16px; }
  :root[data-theme="dark"] .err { color:#f87171; }
  .hint { display:flex; align-items:flex-start; gap:8px; margin-top:16px; padding-top:16px; border-top:1px solid var(--border); color:var(--faint); font-size:10.5px; }
  .hint-dot { width:7px; height:7px; flex:0 0 auto; margin-top:5px; border-radius:50%; background:#22c55e; box-shadow:none; }
  .theme-toggle { position:fixed; top:18px; right:20px; z-index:9999; min-height:32px; background:transparent; color:var(--muted); border:0; border-radius:8px; padding:5px 10px; cursor:pointer; font:500 12px/18px -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif; }
  .theme-toggle:hover { color:var(--text); }
  @media (max-width:520px) { .card { padding:28px 22px; border-radius:20px; } .card h1 { font-size:26px; } .theme-toggle { top:10px; right:10px; } }
</style>
</head>
<body>
<button id="theme-toggle" class="theme-toggle">Dark</button>
<div id="boot-screen">
  <div class="card">
    <div class="brand"><span class="brand-mark">dsh</span><span class="brand-name" data-i18n="standalone.brand.name">Scholar</span><span class="brand-meta" data-i18n="standalone.brand.meta">Workspace</span></div>
    <div class="eyebrow" data-i18n="standalone.operatorAccess">Operator access</div>
    <h1 data-i18n="standalone.welcomeBack">Welcome back.</h1>
    <p data-i18n="standalone.intro">Open your evidence workspace. Human gate decisions are recorded with your operator identity.</p>
    <form id="token-form">
      <label class="field-label" for="token-input" data-i18n="standalone.accessToken">Access token</label>
      <input id="token-input" type="password" placeholder="Access token" autocomplete="off">
      <button id="token-submit" type="submit" data-i18n="standalone.openWorkspace">Open workspace</button>
      <div class="err" id="token-err"></div>
    </form>
    <div class="hint"><span class="hint-dot"></span><span data-i18n="standalone.tokenHint">Your token is generated when the local server starts and remains on this machine.</span></div>
  </div>
</div>
<script>
  // The client bundle registers through a small classic-script handoff.
  window.__ModuleLoader__ = {
    load: function (mod) {
      window.__DSH_SCHOLAR_UI__ = mod.factory(function (specifier) {
        throw new Error('standalone bundle has no dependencies: ' + specifier);
      });
    },
  };
</script>
<script src="/client.js"></script>
<script>
  (function () {
    var cspNonce = document.currentScript && document.currentScript.nonce
      ? document.currentScript.nonce
      : undefined;
    ${PARSE_STANDALONE_UNLOCK_ERROR_SOURCE}
    var THEME_KEY = 'dsh-scholar-ui-theme';
    var TOKEN_KEY = 'dsh-scholar-ui-token';
    var root = document.documentElement;
    var toggle = document.getElementById('theme-toggle');
    function readTheme() { try { return localStorage.getItem(THEME_KEY) === 'dark' ? 'dark' : 'light'; } catch (e) { return 'light'; } }
    function paintTheme() {
      var dark = readTheme() === 'dark';
      root.setAttribute('data-theme', dark ? 'dark' : 'light');
      toggle.textContent = dark ? window.__BOOT_MSG__('standalone.theme.light') : window.__BOOT_MSG__('standalone.theme.dark');
    }
    toggle.addEventListener('click', function () {
      var next = readTheme() === 'dark' ? 'light' : 'dark';
      try { localStorage.setItem(THEME_KEY, next); } catch (e) {}
      paintTheme();
    });
    paintTheme();
    var boot = document.getElementById('boot-screen');
    var input = document.getElementById('token-input');
    var err = document.getElementById('token-err');
    var form = document.getElementById('token-form');
    var saved = null;
    try { saved = localStorage.getItem(TOKEN_KEY); } catch (e) {}
    function unlock(token) {
      fetch('/api/token-check', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: token }) })
        .then(function (r) { return r.json(); })
        .then(function (j) {
          if (j.ok === true) {
            try { localStorage.setItem(TOKEN_KEY, token); } catch (e) {}
            boot.style.display = 'none';
            startPanel(token);
          } else {
            // Known server error codes map to the localized dictionary;
            // unknown wire text is shown verbatim (acceptance §8 raw text).
            var parsedError = parseStandaloneUnlockError(j.error);
            var errKey = parsedError.code === 'unauthorized' ? 'standalone.invalidToken' : null;
            err.textContent = errKey !== null
              ? window.__BOOT_MSG__(errKey)
              : (parsedError.message || window.__BOOT_MSG__('standalone.invalidToken'));
          }
        })
        .catch(function () { err.textContent = window.__BOOT_MSG__('standalone.serverUnreachable'); });
    }
    function startPanel(token) {
      if (window.__DSH_SCHOLAR_UI__ && window.__DSH_SCHOLAR_UI__.apply) {
        window.__DSH_SCHOLAR_UI__.setStandaloneBridge({
          base: '',
          token: function () { return Promise.resolve(token); },
        });
        window.__DSH_SCHOLAR_UI__.apply({ styleNonce: cspNonce });
      } else {
        err.textContent = window.__BOOT_MSG__('standalone.bundleFailed');
        boot.style.display = 'flex';
      }
    }
    if (saved) { unlock(saved); }
    else { boot.style.display = 'flex'; }
    form.addEventListener('submit', function (e) { e.preventDefault(); unlock(input.value.trim()); });
    input.focus();
  })();
</script>
</body>
</html>`

export function loadOptions(argv: string[]): StandaloneOptions {
  // CONFIG-01: the standalone CLI surface is parsed by the canonical Config
  // Registry (parseCli) — flags, defaults and validation are the registry's
  // single source of truth; the --no-token loopback floor is enforced here
  // (identical message to the registry's own check in startStandalone) so
  // CLI behavior is unchanged and rejection still happens before listen.
  const values = parseCli(argv, 'standalone')
  const host = (values['standalone.host'] as string | undefined) ?? '127.0.0.1'
  if (values['standalone.no_token'] === true && !isLoopbackHost(host)) {
    throw new Error('--no-token requires an explicit loopback --host (127.0.0.0/8, ::1, or localhost)')
  }
  const dataDir = (values['standalone.data_dir'] as string | undefined) ?? join(process.env.DSH_HOME ?? join(homedir(), '.dsh-scholar-standalone'), 'research-ui-standalone')
  const kernelDataDir = (values['standalone.kernel_data_dir'] as string | undefined)
    ?? join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'research-kernel')
  let token: string | null = null
  if (values['standalone.no_token'] !== true) {
    const tokenFile = join(dataDir, 'standalone-token')
    const tokenFileExists = existsSync(tokenFile)
    if (tokenFileExists) secureExistingTokenFile(tokenFile)
    if (tokenFileExists) {
      token = readFileSync(tokenFile, 'utf8').trim()
      if (token === '') throw new Error('standalone token file must not be empty')
    } else {
      token = `dsh-${randomBytes(18).toString('hex')}`
      mkdirSync(dataDir, { recursive: true })
      writeFileSync(tokenFile, token, { mode: 0o600, flag: 'wx' })
      chmodSync(tokenFile, 0o600)
    }
  }
  return {
    host,
    port: (values['standalone.port'] as number | undefined) ?? DEFAULT_PORT,
    kernelPort: (values['standalone.kernel_port'] as number | undefined) ?? DEFAULT_KERNEL_PORT,
    kernelDataDir,
    dataDir,
    token,
    principal: ((values['standalone.principal'] as string | undefined) ?? null) as string | null,
    frameAncestors: (values['standalone.frame_ancestors'] as string | undefined) ?? 'http://127.0.0.1:3080,http://localhost:3080,http://[::1]:3080',
  }
}

export async function startStandalone(options: StandaloneOptions): Promise<void> {
  const sidecar = new UiKernelSidecar({
    host: '127.0.0.1',
    port: options.kernelPort,
    dataDir: options.kernelDataDir,
    log: line => console.error(line),
  })
  // Token authentication proves access to this local BFF; Human actions
  // additionally need one stable server-side Principal. Both the DSH plugin
  // and standalone derive it from the same protected sidecar credential, so
  // upgrades and entry-point changes do not create a new project namespace.
  // An explicit --principal remains available for controlled deployments.
  if (options.token !== null && options.principal === null) {
    options = { ...options, principal: sidecar.operatorPrincipal }
  }
  // CONFIG-01: the standalone effective config is validated through the
  // canonical Config Registry BEFORE anything binds — unknown keys, invalid
  // values and security-floor violations fail fast (the registry enforces
  // the --no-token loopback floor for programmatic callers as well; the
  // error message is identical to loadOptions' so CLI behavior is unchanged).
  const resolvedConfig = validateConfig({
    'standalone.host': options.host,
    'standalone.port': options.port,
    'standalone.kernel_port': options.kernelPort,
    'standalone.kernel_data_dir': options.kernelDataDir,
    'standalone.data_dir': options.dataDir,
    'standalone.token': options.token ?? '',
    'standalone.no_token': options.token === null,
    'standalone.principal': options.principal ?? '',
    'standalone.frame_ancestors': options.frameAncestors,
  }, { scopes: ['standalone'] })
  const configPin = resolvedConfig.pinHash
  const frameAncestorSources = standaloneFrameAncestorSources(options.frameAncestors)
  console.error(`[standalone] config pin ${configPin} (${options.host}:${options.port}, kernel=${options.kernelPort})`)
  try {
    await sidecar.start()
  } catch (error) {
    await sidecar.stop()
    throw error
  }
  // `options.principal` is now either explicit or the stable credential-bound
  // local operator. It is never accepted from a browser request.
  const endpoint = sidecar.endpoint
  // §4 P0 (API-01/EVID-01): the kernel's internal-route service identity.
  // The BFF is a service process holding the 0600 dataDir token; it attaches
  // x-service-token to upstream kernel calls so internal routes (claim,
  // runner-keys, recover, verified/accept, approve) keep working through the
  // proxy while the browser never sees or supplies the credential.
  const serviceToken = sidecar.serviceToken
  // §5 P0-1 (hardening API-01/SIDE-01): the kernel's PUBLIC bearer token
  // (0600 <dataDir>/kernel-token, same file the sidecar injected into the
  // kernel). EVERY upstream request — proxy and internal lookups alike —
  // carries `Authorization: Bearer <kernelToken>`; the browser never sees
  // or supplies it (the browser authenticates to the BFF with its own token).
  const kernelToken = sidecar.kernelToken
  /** Headers shared by every upstream kernel request: the BFF's own service
   * identity + public bearer. Never forwarded from the client. */
  const upstreamAuthHeaders: Record<string, string> = {
    authorization: `Bearer ${kernelToken}`,
    'x-service-token': serviceToken,
  }

  // The client bundle ships from this package's lib/client.js.
  const bundlePath = join(dirname(fileURLToPath(import.meta.url)), '..', 'client.js')

  const limiter = new SlidingWindowRateLimiter()

  // SEC-UI-01 CSRF: one in-memory session token per process. Every
  // state-changing /api write must echo it in `x-csrf-token`; the Origin
  // check stays as a second layer. Never logged, never persisted.
  const csrfToken = createCsrfToken()
  function csrfHeader(req: IncomingMessage): string | undefined {
    const value = req.headers['x-csrf-token']
    return typeof value === 'string' ? value : Array.isArray(value) ? value[0] : undefined
  }

  // API-01 BFF AuthZ: the loopback operator identity maps to one principal
  // (reconstruction-contracts.md §7 "standalone local identity 仅在 loopback
  // 映射为单一 pi"). Project-scoped routes first resolve membership via the
  // kernel's authoritative project_members table; missing project AND
  // insufficient membership both answer 404 (no enumeration, api-contracts §1).
  // GOV-01/P0-2 (hardening §5): membership is queried FRESH on every request —
  // no Promise/result cache (a revoked member must lose access on the very
  // next request; acceptance-tests.md §21 membership-revocation-no-stale-cache).
  async function projectMembers(projectId: string): Promise<Array<{ principal_id: string; role: string }> | null> {
    return fetch(`${endpoint}/v1/projects/${encodeURIComponent(projectId)}/members`, {
      headers: { accept: 'application/json', ...upstreamAuthHeaders },
    }).then(async (r) => {
      if (!r.ok) return null
      return (await r.json()) as Array<{ principal_id: string; role: string }>
    }).catch(() => null)
  }
  async function isProjectMember(projectId: string): Promise<boolean> {
    if (options.principal === null) return true
    const members = await projectMembers(projectId)
    if (members === null) return false
    return members.some(m => m.principal_id === options.principal)
  }
  /** API-01: the loopback operator's role in a project, or null (not a
   * member / lookup failed). Feeds the role capability layer and the
   * x-principal-role header injected for kernel v2. */
  async function projectRole(projectId: string): Promise<string | null> {
    if (options.principal === null) return null
    const members = await projectMembers(projectId)
    if (members === null) return null
    return members.find(m => m.principal_id === options.principal)?.role ?? null
  }
  /** Global registry writes are allowed only when the authenticated local
   * principal is currently a PI/operator in at least one authoritative
   * project membership. This is evaluated fresh per write: a browser session
   * is never unconditionally promoted to operator and revocation is immediate. */
  async function globalConfigRole(): Promise<'pi' | 'operator' | null> {
    if (options.principal === null) return null
    const projects = await fetch(`${endpoint}/v1/projects`, {
      headers: { accept: 'application/json', ...upstreamAuthHeaders },
    }).then(async response => response.ok ? await response.json() as Array<{ project_id?: string }> : [])
      .catch(() => [] as Array<{ project_id?: string }>)
    let pi = false
    for (const project of projects) {
      if (typeof project.project_id !== 'string') continue
      const role = (await projectMembers(project.project_id))
        ?.find(member => member.principal_id === options.principal)?.role
      if (role === 'operator') return 'operator'
      if (role === 'pi') pi = true
    }
    return pi ? 'pi' : null
  }
  // Job-scoped routes (/v1/jobs/:id/*, e.g. the terminal SSE) resolve the
  // job's project through the kernel first — the BFF checks membership
  // BEFORE streaming (api-contracts.md §9: job_log_read + membership).
  const jobProjectCache = new Map<string, Promise<string | null>>()
  async function jobProjectId(jobId: string): Promise<string | null> {
    const key = `j:${jobId}`
    let hit = jobProjectCache.get(key)
    if (hit === undefined) {
      hit = fetch(`${endpoint}/v1/jobs/${encodeURIComponent(jobId)}`, {
        headers: { accept: 'application/json', ...upstreamAuthHeaders },
      }).then(async (r) => {
        if (!r.ok) return null
        const j = await r.json() as { project_id?: string }
        return typeof j.project_id === 'string' ? j.project_id : null
      }).catch(() => null)
      jobProjectCache.set(key, hit)
    }
    return hit
  }
  function jobIdFromPath(pathname: string): string | null {
    const parts = pathname.split('/').filter(Boolean).map(decodeURIComponent)
    if (parts.length >= 3 && parts[0] === 'v1' && parts[1] === 'jobs') return parts[2] ?? null
    return null
  }
  // SUBAGENT-01 (trajectory-subagents.md §7): child-scoped topology routes
  // (/v1/topology/{child_id}*) resolve the child's project through the
  // kernel first — the BFF checks membership BEFORE forwarding, mirroring
  // the job-scoped rule (trajectory/topology reads require project
  // membership; unknown child AND non-member are the same 404).
  const childProjectCache = new Map<string, Promise<string | null>>()
  async function childProjectId(childId: string): Promise<string | null> {
    const key = `c:${childId}`
    let hit = childProjectCache.get(key)
    if (hit === undefined) {
      hit = fetch(`${endpoint}/v1/topology/${encodeURIComponent(childId)}`, {
        headers: { accept: 'application/json', ...upstreamAuthHeaders, ...options.principal !== null ? { 'x-principal-id': options.principal } : {} },
      }).then(async (r) => {
        if (!r.ok) return null
        const detail = await r.json() as { project_id?: string }
        return typeof detail.project_id === 'string' ? detail.project_id : null
      }).catch(() => null)
      childProjectCache.set(key, hit)
    }
    return hit
  }
  function childIdFromPath(pathname: string): string | null {
    const parts = pathname.split('/').filter(Boolean).map(decodeURIComponent)
    if (parts.length >= 3 && parts[0] === 'v1' && parts[1] === 'topology') return parts[2] ?? null
    return null
  }
  function projectIdFromPath(pathname: string): string | null {
    const parts = pathname.split('/').filter(Boolean).map(decodeURIComponent)
    // Only /v1|v2/projects/{id} carries a PROJECT id in this position — gate
    // ids and job ids are resolved through the kernel (see gateProjectId
    // below), never misread as projects.
    if (parts.length >= 3 && (parts[0] === 'v1' || parts[0] === 'v2') && parts[1] === 'projects') return parts[2] ?? null
    return null
  }
  // API-01/PTY-01 (hardening §5 P0-2): global-id routes — Artifact,
  // Document/TeX, PTY session and global events carry a resource id (or a
  // query project) instead of a path project. Each class resolves the
  // OWNING project through the kernel BEFORE forwarding (one authoritative
  // resolver per class); unknown ids, resolution failures and foreign
  // projects all answer 404 at the BFF (no enumeration, fail-closed) and
  // the kernel re-validates the actual read/write. Resolution results are
  // NOT cached: the resource→project mapping is immutable, but keeping the
  // round-trip per request keeps revocation semantics identical to the
  // uncached membership lookup above (simple, authoritative).
  /** Artifact: /v1/artifacts/{id} (GET/HEAD). Prefers an explicit
   * ?project_id= (kernel project-scoped lookup, membership checked here);
   * otherwise HEAD the kernel route and read the authoritative
   * x-project-id response header (no body bytes are transferred). A 409
   * ambiguous blob (multiple projects, no query) resolves to null → 404. */
  async function artifactProjectId(artifactId: string, projectQuery: string | null): Promise<string | null> {
    if (projectQuery !== null && projectQuery !== '') return projectQuery
    return fetch(`${endpoint}/v1/artifacts/${encodeURIComponent(artifactId)}`, {
      method: 'HEAD',
      headers: { accept: 'application/json', ...upstreamAuthHeaders },
    }).then(async (r) => {
      if (!r.ok) return null
      const header = r.headers.get('x-project-id')
      return typeof header === 'string' && header !== '' ? header : null
    }).catch(() => null)
  }
  /** Document/TeX: /v1/documents/{id}/* resolves via the kernel's own
   * document projection (GET …/tree → document.project_id). Unknown or
   * malformed document ids resolve to null → 404. */
  async function documentProjectId(documentId: string): Promise<string | null> {
    return fetch(`${endpoint}/v1/documents/${encodeURIComponent(documentId)}/tree`, {
      headers: { accept: 'application/json', ...upstreamAuthHeaders },
    }).then(async (r) => {
      if (!r.ok) return null
      const tree = await r.json() as { document?: { project_id?: unknown } }
      return typeof tree.document?.project_id === 'string' && tree.document.project_id !== '' ? tree.document.project_id : null
    }).catch(() => null)
  }
  /** PTY session: /v1/pty/sessions/{id}* resolves via the kernel's
   * authority-only HEAD route. The session GET is generation + lease fenced
   * and is therefore not an ownership-discovery API. */
  async function ptySessionProjectId(sessionId: string): Promise<string | null> {
    return fetch(`${endpoint}/v1/pty/sessions/${encodeURIComponent(sessionId)}`, {
      method: 'HEAD',
      headers: { accept: 'application/json', ...upstreamAuthHeaders, ...options.principal !== null ? { 'x-principal-id': options.principal } : {} },
    }).then((r) => {
      if (!r.ok) return null
      const projectId = r.headers.get('x-project-id')
      return projectId !== null && projectId !== '' ? projectId : null
    }).catch(() => null)
  }
  /** Global events: /v1/events requires an explicit ?project_id= (the
   * kernel's listEvents is otherwise cross-project); absent scope → null →
   * 404 fail-closed. */
  async function eventsProjectId(search: URLSearchParams): Promise<string | null> {
    const projectId = search.get('project_id')
    return projectId !== null && projectId !== '' ? projectId : null
  }
  /** Dispatch one global-id route class to its authoritative resolver. */
  async function globalResourceProject(pathname: string, search: URLSearchParams, method: string): Promise<string | null> {
    const parts = pathname.split('/').filter(Boolean).map(decodeURIComponent)
    if (parts.length >= 1 && parts[0] === 'v1') {
      if (method === 'GET' && parts[1] === 'config' && parts[2] === 'effective' && parts.length === 3) {
        const projectId = search.get('project_id')
        return projectId !== null && projectId !== '' ? projectId : null
      }
      if (method === 'GET' && parts[1] === 'config'
        && (parts[2] === 'layers' || parts[2] === 'revisions')
        && parts[3] === 'project' && parts[4] !== undefined && parts[4] !== '') {
        return parts[4]
      }
      if (parts[1] === 'events' && parts.length === 2) {
        return eventsProjectId(search)
      }
      if (parts.length >= 3) {
        if (parts[1] === 'artifacts' && (method === 'GET' || method === 'HEAD')) {
          return artifactProjectId(parts[2] ?? '', search.get('project_id'))
        }
        if (parts[1] === 'documents' && parts[2] !== undefined && parts[2] !== '') {
          return documentProjectId(parts[2]!)
        }
        if (parts[1] === 'pty' && parts[2] === 'sessions' && parts[3] !== undefined && parts[3] !== '') {
          return ptySessionProjectId(parts[3]!)
        }
      }
    }
    return null
  }
  /** True when the path is one of the global-id classes the BFF resolves
   * (mirrors globalResourceProject's match conditions) — used to answer 404
   * for unresolvable ids instead of forwarding. */
  function isGlobalIdRoute(pathname: string, method: string): boolean {
    const parts = pathname.split('/').filter(Boolean)
    if (parts.length >= 1 && parts[0] === 'v1') {
      if (parts[1] === 'events' && parts.length === 2) return true
      if (parts.length >= 3) {
        if (parts[1] === 'artifacts' && (method === 'GET' || method === 'HEAD')) return true
        if (parts[1] === 'documents' && parts[2] !== undefined && parts[2] !== '') return true
        if (parts[1] === 'pty' && parts[2] === 'sessions' && parts[3] !== undefined && parts[3] !== '') return true
      }
    }
    return false
  }
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      try {
      // CONFIG-01: every BFF response carries the effective-config pin so the
      // running object can be correlated with the config that produced it.
      res.setHeader('x-config-pin', configPin)
      if (!limiter.allow(req.socket.remoteAddress ?? 'unknown')) {
        sendJson(res, 429, bffError('rate_limited', 'rate limited'))
        return
      }
      const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`)
      const method = (req.method ?? 'GET').toUpperCase()

      // Bootstrap page.
      if (method === 'GET' && url.pathname === '/') {
        const nonce = randomBytes(18).toString('base64url')
        res.writeHead(200, {
          'content-type': 'text/html; charset=utf-8',
          'cache-control': 'no-store',
          'content-security-policy': standaloneContentSecurityPolicy(nonce, frameAncestorSources),
          'x-content-type-options': 'nosniff',
        })
        res.end(bootstrapHtmlWithNonce(nonce))
        return
      }
      // Favicon: 204 so the browser does not log a 404 per request.
      if (method === 'GET' && (url.pathname === '/favicon.ico' || url.pathname === '/favicon.svg')) {
        res.writeHead(204, { 'cache-control': 'no-store' })
        res.end()
        return
      }
      // Standalone client bundle.
      if (method === 'GET' && url.pathname === '/client.js') {
        const bundle = readFileSync(bundlePath)
        res.writeHead(200, {
          'content-type': 'application/javascript; charset=utf-8',
          'cache-control': 'no-store',
          'x-content-type-options': 'nosniff',
        })
        res.end(bundle)
        return
      }
      // Token verification for the unlock screen.
      if (method === 'POST' && url.pathname === '/api/token-check') {
        const { body, tooLarge } = await readBody(req)
        if (tooLarge) {
          sendJson(res, 413, bffError('payload_too_large', 'payload too large'))
          return
        }
        if (options.token === null) {
          sendJson(res, 200, { ok: true, tokenless: true })
          return
        }
        let presented: string | undefined
        try {
          const candidate = (JSON.parse(body) as { token?: unknown }).token
          presented = typeof candidate === 'string' ? candidate : undefined
        } catch {
          presented = undefined
        }
        if (tokenMatches(presented, options.token)) {
          sendJson(res, 200, { ok: true })
        } else {
          sendJson(res, 401, bffError('unauthorized', 'invalid token'))
        }
        return
      }

      // CSRF session token (SEC-UI-01): issued after bearer authentication.
      // The client fetches it once at startup and echoes it back on every
      // state-changing /api request via the x-csrf-token header.
      if (method === 'GET' && url.pathname === '/api/session/csrf') {
        if (options.token !== null) {
          const auth = req.headers.authorization
          const match = typeof auth === 'string' ? /^Bearer\s+(.+)$/i.exec(auth) : null
          if (!tokenMatches(match?.[1], options.token)) {
            sendJson(res, 401, bffError('unauthorized', 'unauthorized'))
            return
          }
        }
        sendJson(res, 200, { ok: true, csrf_token: csrfToken })
        return
      }

      const humanGateMatch = /^\/bff\/research\/gates\/([^/]+)\/decision$/.exec(url.pathname)

      // API-01/GOV-01: token mode must always carry an effective local
      // Principal. startStandalone derives it from the protected shared
      // sidecar credential when --principal is absent; this branch remains a
      // defense-in-depth guard for invalid programmatic construction.
      if (
        options.token !== null &&
        options.principal === null &&
        url.pathname !== '/v1/health' &&
        url.pathname !== '/v2/health' &&
        !(method === 'POST' && humanGateMatch !== null)
      ) {
        sendJson(res, 401, bffError('principal_required', 'principal required'))
        return
      }

      // GOV-01: browser Gate decisions use a dedicated Human BFF route.
      // The browser submits business fields only; this adapter resolves the
      // Gate's project, checks fresh membership/role, injects the durable
      // Principal + request id, then calls the service-only Kernel bridge.
      if (method === 'POST' && humanGateMatch !== null) {
        const requestId = `req_${randomBytes(12).toString('hex')}`
        if (options.token !== null) {
          const auth = req.headers.authorization
          const match = typeof auth === 'string' ? /^Bearer\s+(.+)$/i.exec(auth) : null
          if (!tokenMatches(match?.[1], options.token)) {
            sendJson(res, 401, humanGateBffError(requestId, 'unauthorized', 'unauthorized'))
            return
          }
        }
        if (!verifyCsrfToken(csrfHeader(req), csrfToken)) {
          sendJson(res, 403, humanGateBffError(requestId, 'csrf_rejected', 'missing or invalid csrf token'))
          return
        }
        if (!isAllowedOrigin(req.headers.origin, req.headers.host)) {
          sendJson(res, 403, humanGateBffError(requestId, 'csrf_rejected', 'cross-origin write rejected'))
          return
        }
        if (options.principal === null) {
          sendJson(res, 401, humanGateBffError(requestId, 'principal_required', 'principal required'))
          return
        }
        let gateId = ''
        try {
          gateId = decodeURIComponent(humanGateMatch[1] ?? '')
        } catch {
          sendJson(res, 400, humanGateBffError(requestId, 'invalid_gate_id', 'invalid gate id'))
          return
        }
        if (gateId === '' || gateId.includes('/')) {
          sendJson(res, 400, humanGateBffError(requestId, 'invalid_gate_id', 'invalid gate id'))
          return
        }
        const gateProjectId = await fetch(`${endpoint}/v1/gates/${encodeURIComponent(gateId)}`, {
          headers: { accept: 'application/json', ...upstreamAuthHeaders },
        }).then(async response => {
          if (!response.ok) return null
          const gate = await response.json() as { project_id?: unknown }
          return typeof gate.project_id === 'string' && gate.project_id !== '' ? gate.project_id : null
        }).catch(() => null)
        if (gateProjectId === null || !(await isProjectMember(gateProjectId))) {
          sendJson(res, 404, humanGateBffError(requestId, 'project_not_found', 'project not found or access denied'))
          return
        }
        const role = await projectRole(gateProjectId)
        if (role !== 'pi' && role !== 'operator') {
          sendJson(res, 403, humanGateBffError(requestId, 'role_forbidden', 'role forbidden'))
          return
        }
        const read = await readBody(req)
        if (read.tooLarge) {
          sendJson(res, 413, humanGateBffError(requestId, 'payload_too_large', 'payload too large'))
          return
        }
        let parsed: unknown
        try {
          parsed = JSON.parse(read.body)
        } catch {
          sendJson(res, 400, humanGateBffError(requestId, 'invalid_json', 'bad request'))
          return
        }
        const opSession = operatorSession(options.dataDir, options.principal)
        const decisionBody = humanGateDecisionBody(parsed, opSession)
        if (decisionBody === null) {
          sendJson(res, 422, humanGateBffError(requestId, 'validation_error', 'invalid gate decision'))
          return
        }
        let upstream: Response
        try {
          upstream = await fetch(`${endpoint}/internal/human-gates/${encodeURIComponent(gateId)}/decisions`, {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              accept: 'application/json',
              ...upstreamAuthHeaders,
              'x-service-principal': 'standalone-human-bff',
              'x-principal-id': opSession.principal_id,
              'x-principal-role': role,
              'x-principal-session': opSession.session_id,
              'x-request-id': requestId,
            },
            body: JSON.stringify(decisionBody),
          })
        } catch {
          sendJson(res, 502, humanGateBffError(requestId, 'kernel_unreachable', 'research kernel unavailable'))
          return
        }
        let payload: unknown
        try {
          payload = await upstream.json()
        } catch {
          sendJson(res, 502, humanGateBffError(requestId, 'kernel_error', 'invalid kernel response'))
          return
        }
        if (!upstream.ok) {
          sendJson(res, upstream.status, humanGateUpstreamError(requestId, upstream.status, payload))
          return
        }
        sendJson(res, upstream.status, payload)
        return
      }

      // Model preference: the research agent's model seat. The standalone
      // persists the choice under the data dir (`model.json`, 0600) and
      // exposes it to the DSH-side plugin via the same file, so a selection
      // made in this UI is what the research agent uses for the primary role.
      // 'auto' (or empty) means the agent default — no override.
      if (method === 'GET' && url.pathname === '/api/model') {
        if (options.token !== null) {
          const auth = req.headers.authorization
          const match = typeof auth === 'string' ? /^Bearer\s+(.+)$/i.exec(auth) : null
          if (!tokenMatches(match?.[1], options.token)) {
            sendJson(res, 401, bffError('unauthorized', 'unauthorized'))
            return
          }
        }
        const liveModels = await readLiveScholarModels(options.dataDir)
        const saved = readModelPreference(options.dataDir)
        const savedRoute = parseScholarModelId(saved)
        const models = liveModels === null ? [] : [...liveModels]
        if (savedRoute !== null) {
          const resolved = await resolveLiveScholarModel(options.dataDir, saved)
          const catalogIndex = models.findIndex(candidate => candidate.id === saved)
          const catalogEntry = catalogIndex < 0 ? undefined : models[catalogIndex]
          const selected: LiveScholarModel = resolved ?? {
            id: saved,
            provider: savedRoute.provider,
            model: savedRoute.model,
            name: catalogEntry?.name ?? saved,
            ...(catalogEntry?.input_modalities === undefined ? {} : { input_modalities: [...catalogEntry.input_modalities] }),
            available: false,
          }
          if (catalogIndex < 0) models.push(selected)
          else models[catalogIndex] = selected
        }
        sendJson(res, 200, {
          ok: true,
          model: savedRoute === null ? '' : saved,
          available: liveModels !== null,
          models,
        })
        return
      }
      if (method === 'PUT' && url.pathname === '/api/model') {
        if (options.token !== null) {
          const auth = req.headers.authorization
          const match = typeof auth === 'string' ? /^Bearer\s+(.+)$/i.exec(auth) : null
          if (!tokenMatches(match?.[1], options.token)) {
            sendJson(res, 401, bffError('unauthorized', 'unauthorized'))
            return
          }
        }
        // SEC-UI-01: session CSRF token required on /api writes.
        if (!verifyCsrfToken(csrfHeader(req), csrfToken)) {
          sendJson(res, 403, bffError('csrf_rejected', 'missing or invalid csrf token'))
          return
        }
        if (!isAllowedOrigin(req.headers.origin, req.headers.host)) {
          sendJson(res, 403, bffError('csrf_rejected', 'cross-origin write rejected'))
          return
        }
        const { body, tooLarge } = await readBody(req)
        if (tooLarge) {
          sendJson(res, 413, bffError('payload_too_large', 'payload too large'))
          return
        }
        let model = ''
        try {
          const parsed = JSON.parse(body) as { model?: unknown }
          model = typeof parsed.model === 'string' ? parsed.model.trim() : ''
        } catch {
          sendJson(res, 400, bffError('invalid_json', 'bad request'))
          return
        }
        if (model !== '' && model !== 'auto') {
          if (await readLiveScholarModels(options.dataDir) === null) {
            sendJson(res, 503, bffError('model_unavailable', 'DSH model runtime is unavailable'))
            return
          }
          if (parseScholarModelId(model) === null) {
            sendJson(res, 422, bffError('validation_error', `unknown model '${model}'`))
            return
          }
          const resolved = await resolveLiveScholarModel(options.dataDir, model)
          if (resolved === null) {
            sendJson(res, 422, bffError('validation_error', `unknown model '${model}'`))
            return
          }
          if (!scholarModelUsability(resolved).selectable) {
            sendJson(res, 422, bffError('validation_error', `model '${model}' does not accept Scholar text input`))
            return
          }
        }
        try {
          writeModelPreference(options.dataDir, model === 'auto' ? '' : model)
          sendJson(res, 200, { ok: true, model: model === 'auto' ? '' : model })
        } catch {
          sendJson(res, 500, bffError('internal_error', 'model preference write failed'))
        }
        return
      }

      // Project-scoped free conversation. The browser sends only its text and
      // bounded visible history; the BFF reloads the authoritative projection
      // and the DSH plugin's private loopback bridge performs the tool-free
      // model call. No model reply can write Kernel state on this route.
      if (method === 'POST' && url.pathname === '/api/chat/turn') {
        if (options.token !== null) {
          const auth = req.headers.authorization
          const match = typeof auth === 'string' ? /^Bearer\s+(.+)$/i.exec(auth) : null
          if (!tokenMatches(match?.[1], options.token)) {
            sendJson(res, 401, bffError('unauthorized', 'unauthorized'))
            return
          }
        }
        if (!verifyCsrfToken(csrfHeader(req), csrfToken) || !isAllowedOrigin(req.headers.origin, req.headers.host)) {
          sendJson(res, 403, bffError('csrf_rejected', 'missing, invalid or cross-origin CSRF request'))
          return
        }
        const read = await readBody(req)
        if (read.tooLarge) {
          sendJson(res, 413, bffError('payload_too_large', 'payload too large'))
          return
        }
        let raw: unknown
        try {
          raw = JSON.parse(read.body) as unknown
        } catch {
          sendJson(res, 400, bffError('invalid_json', 'bad request'))
          return
        }
        const controller = new AbortController()
        const abortTurn = (): void => controller.abort()
        req.once('aborted', abortTurn)
        res.once('close', abortTurn)
        try {
          const result = await executeStandaloneChatTurn(raw, {
            dataDir: options.dataDir,
            kernelEndpoint: endpoint,
            upstreamAuthHeaders,
            enforceMembership: options.principal !== null,
            isProjectMember,
            signal: controller.signal,
          })
          if (!controller.signal.aborted && !res.destroyed) sendJson(res, result.status, result.payload)
        } finally {
          req.removeListener('aborted', abortTurn)
          res.removeListener('close', abortTurn)
        }
        return
      }

      // Explicit, ready-only IdeaCard generation. The BFF revalidates the
      // authoritative NextAction and frozen corpus before asking the model,
      // then the Kernel atomically attaches project/revision/provenance and
      // writes all generated drafts. The model cannot choose those fields.
      if (method === 'POST' && url.pathname === '/api/chat/ideas') {
        if (options.token !== null) {
          const auth = req.headers.authorization
          const match = typeof auth === 'string' ? /^Bearer\s+(.+)$/i.exec(auth) : null
          if (!tokenMatches(match?.[1], options.token)) {
            sendJson(res, 401, bffError('unauthorized', 'unauthorized'))
            return
          }
        }
        if (!verifyCsrfToken(csrfHeader(req), csrfToken) || !isAllowedOrigin(req.headers.origin, req.headers.host)) {
          sendJson(res, 403, bffError('csrf_rejected', 'missing, invalid or cross-origin CSRF request'))
          return
        }
        const read = await readBody(req)
        if (read.tooLarge) {
          sendJson(res, 413, bffError('payload_too_large', 'payload too large'))
          return
        }
        let raw: Record<string, unknown>
        try {
          const parsed = JSON.parse(read.body) as unknown
          if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('invalid')
          raw = parsed as Record<string, unknown>
        } catch {
          sendJson(res, 400, bffError('invalid_json', 'bad request'))
          return
        }
        const projectId = typeof raw.project_id === 'string' ? raw.project_id.trim() : ''
        const sessionId = typeof raw.session_id === 'string' ? raw.session_id.trim() : ''
        const text = typeof raw.text === 'string' ? raw.text.trim() : ''
        const count = typeof raw.count === 'number' && Number.isInteger(raw.count) ? raw.count : 3
        const locale: 'zh' | 'en' = raw.locale === 'en' ? 'en' : 'zh'
        if (projectId === '' || projectId.length > 256 || sessionId === '' || sessionId.length > 256 || text === '' || text.length > 16_000 || count < 1 || count > 5) {
          sendJson(res, 422, bffError('validation_error', 'project_id, session_id, text and count (1-5) are required'))
          return
        }
        if (options.principal !== null) {
          const role = await projectRole(projectId)
          if (role === null) {
            sendJson(res, 404, bffError('project_not_found', 'project not found or access denied'))
            return
          }
          if (!surveyWriteRoleAllowed(role)) {
            sendJson(res, 403, bffError('role_forbidden', 'role forbidden'))
            return
          }
        }
        const [projectionResponse, corpusResponse] = await Promise.all([
          fetch(`${endpoint}/v2/projects/${encodeURIComponent(projectId)}/projection`, {
            headers: { accept: 'application/json', ...upstreamAuthHeaders },
          }).catch(() => null),
          fetch(`${endpoint}/v1/projects/${encodeURIComponent(projectId)}/corpus-snapshots`, {
            headers: { accept: 'application/json', ...upstreamAuthHeaders },
          }).catch(() => null),
        ])
        if (projectionResponse === null || corpusResponse === null || !projectionResponse.ok || !corpusResponse.ok) {
          sendJson(res, 502, bffError('kernel_unreachable', 'research context unavailable'))
          return
        }
        const projection = await projectionResponse.json() as {
          project?: { revision?: number } & Record<string, unknown>
          next_actions_v2?: Array<Record<string, unknown>>
        }
        const ready = (projection.next_actions_v2 ?? []).some(action => action.code === 'idea_generate'
          && action.state === 'ready' && action.required === true && action.required_by === 'agent')
        if (!ready || typeof projection.project?.revision !== 'number') {
          sendJson(res, 409, bffError('action_not_ready', 'idea generation is not the current ready Agent action'))
          return
        }
        let snapshots: CorpusSnapshot[]
        try {
          const rawSnapshots = await corpusResponse.json() as unknown
          if (!Array.isArray(rawSnapshots)) throw new Error('invalid corpus response')
          snapshots = rawSnapshots as CorpusSnapshot[]
        } catch {
          sendJson(res, 502, bffError('kernel_error', 'invalid research context response'))
          return
        }
        const snapshot = snapshots.filter(item => item.project_id === projectId && item.frozen && item.papers.length > 0)
          .sort((a, b) => a.created_at.localeCompare(b.created_at)).at(-1)
        if (snapshot === undefined) {
          sendJson(res, 409, bffError('corpus_required', 'a non-empty frozen corpus snapshot is required'))
          return
        }
        let reply: Awaited<ReturnType<typeof requestScholarAgent>>
        try {
          reply = await requestScholarAgent(options.dataDir, {
            operation: 'generate_ideas',
            session_id: sessionId,
            text,
            locale,
            count,
            project: {
              project_id: projectId,
              ...(typeof projection.project.name === 'string' ? { name: projection.project.name } : {}),
              ...(typeof projection.project.status === 'string' ? { status: projection.project.status } : {}),
              ...(typeof projection.project.brief_status === 'string' ? { brief_status: projection.project.brief_status } : {}),
              ...(projection.project.brief !== null && typeof projection.project.brief === 'object'
                ? { brief: projection.project.brief as Record<string, unknown> } : {}),
              next_actions_v2: projection.next_actions_v2 ?? [],
            },
            corpus: {
              snapshot_id: snapshot.snapshot_id,
              papers: snapshot.papers.slice(0, 30).map(paper => ({
                paper_id: paper.paper_id,
                title: paper.title,
                year: paper.year,
                abstract: paper.abstract.slice(0, 2_000),
              })),
            },
            history: [],
          } as ScholarAgentRequest)
          if (reply.operation !== 'generate_ideas') throw new Error('wrong operation')
        } catch {
          sendJson(res, 503, bffError('model_unavailable', 'DSH model runtime is unavailable'))
          return
        }
        let createdResponse: Response
        try {
          createdResponse = await fetch(`${endpoint}/v1/projects/${encodeURIComponent(projectId)}/ideas/batch`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', accept: 'application/json', ...upstreamAuthHeaders },
            body: JSON.stringify({
              expected_project_revision: projection.project.revision,
              corpus_snapshot_id: snapshot.snapshot_id,
              ideas: reply.ideas,
            }),
          })
        } catch {
          sendJson(res, 502, bffError('kernel_unreachable', 'research kernel unavailable'))
          return
        }
        const created = await createdResponse.json().catch(() => null) as { ideas?: unknown[] } | null
        if (!createdResponse.ok || !Array.isArray(created?.ideas)) {
          sendJson(res, createdResponse.status >= 400 && createdResponse.status < 500 ? createdResponse.status : 502,
            bffError('idea_write_failed', 'generated IdeaCards could not be committed'))
          return
        }
        sendJson(res, 200, { ok: true, snapshot_id: snapshot.snapshot_id, ideas: created.ideas })
        return
      }

      // Human candidate selection: perform the selected idea's real
      // counter-search first, then let the Kernel atomically persist the
      // audit, enter IDEATING and create the payload-bound pending Gate.
      if (method === 'POST' && url.pathname === '/api/chat/ideas/select') {
        if (options.token !== null) {
          const auth = req.headers.authorization
          const match = typeof auth === 'string' ? /^Bearer\s+(.+)$/i.exec(auth) : null
          if (!tokenMatches(match?.[1], options.token)) {
            sendJson(res, 401, bffError('unauthorized', 'unauthorized'))
            return
          }
        }
        if (!verifyCsrfToken(csrfHeader(req), csrfToken) || !isAllowedOrigin(req.headers.origin, req.headers.host)) {
          sendJson(res, 403, bffError('csrf_rejected', 'missing, invalid or cross-origin CSRF request'))
          return
        }
        const read = await readBody(req)
        if (read.tooLarge) {
          sendJson(res, 413, bffError('payload_too_large', 'payload too large'))
          return
        }
        let projectId = ''
        let ideaId = ''
        try {
          const parsed = JSON.parse(read.body) as { project_id?: unknown; idea_id?: unknown }
          projectId = typeof parsed.project_id === 'string' ? parsed.project_id.trim() : ''
          ideaId = typeof parsed.idea_id === 'string' ? parsed.idea_id.trim() : ''
        } catch {
          sendJson(res, 400, bffError('invalid_json', 'bad request'))
          return
        }
        if (projectId === '' || ideaId === '' || projectId.length > 256 || ideaId.length > 256) {
          sendJson(res, 422, bffError('validation_error', 'project_id and idea_id are required'))
          return
        }
        const role = await projectRole(projectId)
        if (role === null) {
          sendJson(res, 404, bffError('project_not_found', 'project not found or access denied'))
          return
        }
        if (role !== 'pi' && role !== 'operator') {
          sendJson(res, 403, bffError('role_forbidden', 'role forbidden'))
          return
        }
        const [projectionResponse, ideaResponse] = await Promise.all([
          fetch(`${endpoint}/v2/projects/${encodeURIComponent(projectId)}/projection`, {
            headers: { accept: 'application/json', ...upstreamAuthHeaders },
          }).catch(() => null),
          fetch(`${endpoint}/v1/ideas/${encodeURIComponent(ideaId)}`, {
            headers: { accept: 'application/json', ...upstreamAuthHeaders },
          }).catch(() => null),
        ])
        if (projectionResponse === null || ideaResponse === null || !projectionResponse.ok || !ideaResponse.ok) {
          sendJson(res, 404, bffError('idea_not_found', 'selected idea or project was not found'))
          return
        }
        const projection = await projectionResponse.json() as {
          project?: { revision?: unknown; status?: unknown }
          next_actions_v2?: Array<Record<string, unknown>>
        }
        const idea = await ideaResponse.json() as Record<string, unknown>
        const projectRevision = projection.project?.revision
        const ideaVersion = idea.version
        const ready = (projection.next_actions_v2 ?? []).some(action => action.code === 'idea_select'
          && action.state === 'ready' && action.required === true && action.required_by === 'human')
        if (!ready || projection.project?.status !== 'SURVEYING'
          || typeof projectRevision !== 'number' || !Number.isInteger(projectRevision)
          || idea.project_id !== projectId || idea.status !== 'proposed'
          || typeof ideaVersion !== 'number' || !Number.isInteger(ideaVersion)
          || typeof idea.title !== 'string' || typeof idea.hypothesis !== 'string' || typeof idea.exact_delta !== 'string') {
          sendJson(res, 409, bffError('idea_selection_not_ready', 'the selected idea is not ready for the Idea Gate'))
          return
        }
        const queries = ideaAuditQueries({ title: idea.title, hypothesis: idea.hypothesis, exact_delta: idea.exact_delta })
        let audit: NoveltyAudit
        try {
          const searches = await Promise.all(queries.map(query => multiSourceSearch(query, { limit: 5 })))
          audit = ideaNoveltyAudit(queries, searches as IdeaAuditSearchResult[])
        } catch {
          sendJson(res, 502, bffError('connector_unavailable', 'novelty audit connector unavailable'))
          return
        }
        const opSession = operatorSession(options.dataDir, options.principal ?? '')
        let preparedResponse: Response
        try {
          preparedResponse = await fetch(`${endpoint}/v2/projects/${encodeURIComponent(projectId)}/idea-gate`, {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              accept: 'application/json',
              ...upstreamAuthHeaders,
              'x-principal-id': opSession.principal_id,
              'x-principal-role': role,
              'x-principal-session': opSession.session_id,
            },
            body: JSON.stringify({
              idea_id: ideaId,
              expected_project_revision: projectRevision,
              expected_idea_version: ideaVersion,
              novelty_audit: audit,
            }),
          })
        } catch {
          sendJson(res, 502, bffError('kernel_unreachable', 'research kernel unavailable'))
          return
        }
        const prepared = await preparedResponse.json().catch(() => null) as Record<string, unknown> | null
        if (!preparedResponse.ok || prepared === null) {
          const envelope = prepared?.error !== null && typeof prepared?.error === 'object'
            ? prepared.error as Record<string, unknown>
            : {}
          const candidate = envelope.code
          const code = typeof candidate === 'string' && /^[a-z][a-z0-9_]{0,63}$/.test(candidate)
            ? candidate
            : 'idea_selection_failed'
          sendJson(res, preparedResponse.status >= 400 && preparedResponse.status < 500 ? preparedResponse.status : 502,
            bffError(code, 'selected IdeaCard could not enter the Idea Gate'))
          return
        }
        sendJson(res, 200, prepared)
        return
      }

      // Agent-authored Contract draft from the frozen, Human-approved Idea.
      // The browser performs one BFF write; the Kernel owns the atomic
      // Contract + CONTRACT_PENDING + payload-bound Contract Gate handoff.
      if (method === 'POST' && url.pathname === '/api/chat/contracts/draft') {
        if (options.token !== null) {
          const auth = req.headers.authorization
          const match = typeof auth === 'string' ? /^Bearer\s+(.+)$/i.exec(auth) : null
          if (!tokenMatches(match?.[1], options.token)) {
            sendJson(res, 401, bffError('unauthorized', 'unauthorized'))
            return
          }
        }
        if (!verifyCsrfToken(csrfHeader(req), csrfToken) || !isAllowedOrigin(req.headers.origin, req.headers.host)) {
          sendJson(res, 403, bffError('csrf_rejected', 'missing, invalid or cross-origin CSRF request'))
          return
        }
        const read = await readBody(req)
        if (read.tooLarge) {
          sendJson(res, 413, bffError('payload_too_large', 'payload too large'))
          return
        }
        let projectId = ''
        try {
          const parsed = JSON.parse(read.body) as { project_id?: unknown }
          projectId = typeof parsed.project_id === 'string' ? parsed.project_id.trim() : ''
        } catch {
          sendJson(res, 400, bffError('invalid_json', 'bad request'))
          return
        }
        if (projectId === '' || projectId.length > 256) {
          sendJson(res, 422, bffError('validation_error', 'project_id is required'))
          return
        }
        const role = await projectRole(projectId)
        if (role === null) {
          sendJson(res, 404, bffError('project_not_found', 'project not found or access denied'))
          return
        }
        if (role !== 'pi' && role !== 'operator') {
          sendJson(res, 403, bffError('role_forbidden', 'role forbidden'))
          return
        }
        const [projectionResponse, ideasResponse] = await Promise.all([
          fetch(`${endpoint}/v2/projects/${encodeURIComponent(projectId)}/projection`, {
            headers: { accept: 'application/json', ...upstreamAuthHeaders },
          }).catch(() => null),
          fetch(`${endpoint}/v1/projects/${encodeURIComponent(projectId)}/ideas`, {
            headers: { accept: 'application/json', ...upstreamAuthHeaders },
          }).catch(() => null),
        ])
        if (projectionResponse === null || ideasResponse === null || !projectionResponse.ok || !ideasResponse.ok) {
          sendJson(res, 404, bffError('project_not_found', 'project not found or access denied'))
          return
        }
        const projection = await projectionResponse.json() as {
          project?: { revision?: unknown; status?: unknown }
          next_actions_v2?: Array<Record<string, unknown>>
        }
        const ideas = await ideasResponse.json() as unknown
        const projectRevision = projection.project?.revision
        const ready = (projection.next_actions_v2 ?? []).some(action => action.code === 'contract_register'
          && action.state === 'ready' && action.required === true && action.required_by === 'agent')
        const approved = Array.isArray(ideas)
          ? ideas.filter((idea): idea is Record<string, unknown> => typeof idea === 'object' && idea !== null && idea.status === 'approved')
          : []
        const idea = approved.length === 1 ? approved[0]! : null
        const mve = idea?.minimum_viable_experiment
        if (!ready || (projection.project?.status !== 'IDEA_APPROVED' && projection.project?.status !== 'CONTRACT_PENDING')
          || typeof projectRevision !== 'number' || !Number.isInteger(projectRevision)
          || idea === null || idea.project_id !== projectId || typeof idea.idea_id !== 'string'
          || typeof idea.version !== 'number' || !Number.isInteger(idea.version)
          || typeof idea.exact_delta !== 'string' || idea.exact_delta.trim() === ''
          || typeof mve !== 'object' || mve === null
          || typeof (mve as Record<string, unknown>).dataset !== 'string' || String((mve as Record<string, unknown>).dataset).trim() === ''
          || typeof (mve as Record<string, unknown>).baseline !== 'string' || String((mve as Record<string, unknown>).baseline).trim() === ''
          || typeof (mve as Record<string, unknown>).primary_metric !== 'string' || String((mve as Record<string, unknown>).primary_metric).trim() === ''
          || typeof (mve as Record<string, unknown>).estimated_gpu_hours !== 'number'
          || !Number.isFinite((mve as Record<string, unknown>).estimated_gpu_hours)) {
          sendJson(res, 409, bffError('contract_draft_not_ready', 'the approved idea is not ready for Contract drafting'))
          return
        }
        const contract = contractDraftFromIdea(idea as unknown as ContractIdeaCandidate)
        const opSession = operatorSession(options.dataDir, options.principal ?? '')
        let preparedResponse: Response
        try {
          preparedResponse = await fetch(`${endpoint}/v2/projects/${encodeURIComponent(projectId)}/contract-gate`, {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              accept: 'application/json',
              ...upstreamAuthHeaders,
              'x-principal-id': opSession.principal_id,
              'x-principal-role': role,
              'x-principal-session': opSession.session_id,
            },
            body: JSON.stringify({
              idea_id: idea.idea_id,
              expected_project_revision: projectRevision,
              expected_idea_version: idea.version,
              contract,
            }),
          })
        } catch {
          sendJson(res, 502, bffError('kernel_unreachable', 'research kernel unavailable'))
          return
        }
        const prepared = await preparedResponse.json().catch(() => null) as Record<string, unknown> | null
        if (!preparedResponse.ok || prepared === null) {
          const envelope = prepared?.error !== null && typeof prepared?.error === 'object'
            ? prepared.error as Record<string, unknown>
            : {}
          const candidate = envelope.code
          const code = typeof candidate === 'string' && /^[a-z][a-z0-9_]{0,63}$/.test(candidate)
            ? candidate
            : 'contract_draft_failed'
          sendJson(res, preparedResponse.status >= 400 && preparedResponse.status < 500 ? preparedResponse.status : 502,
            bffError(code, 'Experiment Contract draft could not enter the Contract Gate'))
          return
        }
        sendJson(res, 200, prepared)
        return
      }

      // Chat /survey: the browser client cannot run the scholar
      // connectors (OpenAlex/Crossref/arXiv fetchers), so the standalone
      // server performs the multi-source search + corpus snapshot on its
      // behalf (same semantics as the DSH Agent /survey command).
      if (method === 'POST' && url.pathname === '/api/chat/survey') {
        if (options.token !== null) {
          const auth = req.headers.authorization
          const match = typeof auth === 'string' ? /^Bearer\s+(.+)$/i.exec(auth) : null
          if (!tokenMatches(match?.[1], options.token)) {
            sendJson(res, 401, bffError('unauthorized', 'unauthorized'))
            return
          }
        }
        // SEC-UI-01: session CSRF token required on /api writes.
        if (!verifyCsrfToken(csrfHeader(req), csrfToken)) {
          sendJson(res, 403, bffError('csrf_rejected', 'missing or invalid csrf token'))
          return
        }
        if (!isAllowedOrigin(req.headers.origin, req.headers.host)) {
          sendJson(res, 403, bffError('csrf_rejected', 'cross-origin write rejected'))
          return
        }
        const read = await readBody(req)
        if (read.tooLarge) {
          sendJson(res, 413, bffError('payload_too_large', 'payload too large'))
          return
        }
        const { body } = read
        let projectId = ''
        let query = ''
        try {
          const parsed = JSON.parse(body) as { project_id?: unknown; query?: unknown }
          projectId = typeof parsed.project_id === 'string' ? parsed.project_id : ''
          query = typeof parsed.query === 'string' ? parsed.query.trim() : ''
        } catch {
          sendJson(res, 400, bffError('invalid_json', 'bad request'))
          return
        }
        if (projectId === '' || query === '') {
          sendJson(res, 400, bffError('project_required', 'project_id and query required'))
          return
        }
        // SEC-UI-01 fail-closed: with a loopback operator principal, membership
        // is enforced BEFORE the connector runs or the corpus is written —
        // unknown/foreign project -> 404, no side effects.
        if (options.principal !== null) {
          const role = await projectRole(projectId)
          if (role === null) {
            sendJson(res, 404, bffError('project_not_found', 'project not found or access denied'))
            return
          }
          if (!surveyWriteRoleAllowed(role)) {
            sendJson(res, 403, bffError('role_forbidden', 'role forbidden'))
            return
          }
        }
        try {
          const result = await multiSourceSearch(query, { limit: 20 })
          const snapshotResponse = await fetch(`${endpoint}/v1/projects/${encodeURIComponent(projectId)}/corpus`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', accept: 'application/json', ...upstreamAuthHeaders },
            body: JSON.stringify(surveySnapshotBody(result)),
          })
          if (!snapshotResponse.ok) {
            sendJson(res, 502, bffError('kernel_unreachable', 'corpus snapshot failed'))
            return
          }
          const snapshot = (await snapshotResponse.json()) as { snapshot_id?: string; papers?: unknown[] }
          sendJson(res, 200, {
            ok: true,
            snapshot_id: snapshot.snapshot_id,
            papers: Array.isArray(snapshot.papers) ? snapshot.papers.length : 0,
            removed: result.dedup_removed,
            sources: result.source_status.map(source => ({ source: source.source, status: source.status })),
            top: result.hits.slice(0, 5).map(h => ({ paper_id: h.paper.paper_id, title: h.paper.title, year: h.paper.year })),
          })
      } catch {
        sendJson(res, 502, bffError('connector_unavailable', 'survey connector unavailable'))
        }
        return
      }

      // Kernel proxy: everything under /v1/* and /v2/* (v2 = BFF surface).
      if (url.pathname.startsWith('/v1/') || url.pathname.startsWith('/v2/')) {
        // Auth: bearer token required when token mode is on.
        if (options.token !== null) {
          const auth = req.headers.authorization
          const match = typeof auth === 'string' ? /^Bearer\s+(.+)$/i.exec(auth) : null
          if (!tokenMatches(match?.[1], options.token)) {
            sendJson(res, 401, bffError('unauthorized', 'unauthorized'))
            return
          }
        }
        // CSRF: state-changing same-origin writes.
        if (method !== 'GET' && method !== 'HEAD' && method !== 'OPTIONS') {
          if (!isAllowedOrigin(req.headers.origin, req.headers.host)) {
            sendJson(res, 403, bffError('csrf_rejected', 'cross-origin write rejected'))
            return
          }
        }
        // API-01 BFF AuthZ: project-scoped routes require membership of the
        // loopback operator identity; unknown project OR non-member -> 404
        // (no enumeration, api-contracts §1). Job-scoped routes resolve the
        // owning project through the kernel first — the BFF checks membership
        // BEFORE streaming (api-contracts.md §9: job_log_read + membership).
        let memberProjectId: string | null = null
        if (options.principal !== null) {
          memberProjectId = projectIdFromPath(url.pathname)
          if (memberProjectId === null) {
            const jobId = jobIdFromPath(url.pathname)
            if (jobId !== null) memberProjectId = await jobProjectId(jobId)
          }
          if (memberProjectId === null) {
            const childId = childIdFromPath(url.pathname)
            if (childId !== null) memberProjectId = await childProjectId(childId)
          }
          if (memberProjectId === null) {
            // API-01/PTY-01 (hardening §5 P0-2): global-id routes — artifact,
            // document/TeX, pty session and global events ids carry no path
            // project; the BFF resolves the owning project through the kernel
            // (per-class authoritative resolver above) and answers 404 for
            // unknown ids AND foreign projects BEFORE forwarding — no
            // enumeration, same fail-closed contract as project-scoped routes.
            memberProjectId = await globalResourceProject(url.pathname, url.searchParams, method)
            if (memberProjectId === null && isGlobalIdRoute(url.pathname, method)) {
              // Unresolvable global-id route → 404, never forwarded: the
              // kernel's GET /v1/events WITHOUT ?project_id= is a CROSS-PROJECT
              // dump, unknown document ids would answer kernel 422, and an
              // ambiguous artifact (409) leaks nothing. Unknown id and foreign
              // project are the same 404 at this surface.
              sendJson(res, 404, { error: { code: 'project_not_found', message: 'project not found or access denied' } })
              return
            }
          }
          if (memberProjectId !== null && !(await isProjectMember(memberProjectId)) && !isProjectDelete(method, url.pathname)) {
            sendJson(res, 404, { error: { code: 'project_not_found', message: 'project not found or access denied' } })
            return
          }
          // The projects LIST is filtered to the operator's memberships.
          if (url.pathname === '/v1/projects' && method === 'GET') {
            const upstreamList = await fetch(`${endpoint}/v1/projects`, { headers: { accept: 'application/json', ...upstreamAuthHeaders } })
            if (!upstreamList.ok) {
              sendJson(res, 502, bffError('kernel_unreachable', 'research kernel unavailable'))
              return
            }
            const all = (await upstreamList.json()) as Array<{ project_id: string }>
            const allowed: Array<Record<string, unknown>> = []
            for (const p of all) {
              const members = await projectMembers(p.project_id)
              if (members !== null && members.some(m => m.principal_id === options.principal)) allowed.push(p as unknown as Record<string, unknown>)
            }
            sendJson(res, 200, allowed)
            return
          }
          // API-01 role capabilities (defense in depth, kernel v2 semantics):
          // viewer/auditor are read-only; researcher cannot perform governance
          // writes — the PI-only capability route table (transitions/gates/
          // decisions/budget/approve/accept PLUS intake adopt and project
          // archive/unarchive, hardening §5 P1 GOV-01/ONBOARD-01);
          // pi/operator are unrestricted. Enforced BEFORE forwarding with a
          // stable body ({ok:false,error:'role forbidden'}) that never leaks
          // internal detail. The role comes from the BFF's own membership
          // lookup — the client never supplies it.
          if (memberProjectId !== null && method !== 'GET' && method !== 'HEAD' && method !== 'OPTIONS') {
            const role = await projectRole(memberProjectId)
            if (role !== null) {
              const projectDelete = isProjectDelete(method, url.pathname)
              if (role === 'viewer' || role === 'auditor' || (role === 'operator' && projectDelete)
                || (role === 'researcher' && (isPiOnlyWrite(url.pathname) || projectDelete))) {
                sendJson(res, 403, bffError('role_forbidden', 'role forbidden'))
                return
              }
            }
          }
        }
        // UPLOAD-01 (hardening §4 P1): multipart uploads pass through as RAW
        // BYTES with their ORIGINAL content-type (the boundary must survive
        // the proxy). A string conversion would corrupt binary file content
        // and a rewritten content-type would lose the boundary. Everything
        // else keeps the JSON-only path (normalized identity, canonical
        // application/json). The body cap for multipart is the kernel's
        // upload budget (32 MiB file + envelope overhead); oversized
        // uploads are rejected here with 413 before reaching the kernel.
        const incomingContentType = req.headers['content-type']
        const isMultipart = typeof incomingContentType === 'string' && incomingContentType.trim().toLowerCase().startsWith('multipart/form-data')
        // CHUNK-01 (init-grill-upload-models.md §3): chunked upload append is
        // a RAW-BYTES PUT (application/octet-stream) whose Content-Range and
        // X-Chunk-SHA256 headers must survive the proxy — treated like
        // multipart (original content-type + Buffer body, no UTF-8 round-trip).
        const isChunkAppend = method === 'PUT' && /^\/v1\/projects\/[^/]+\/intake\/[^/]+\/upload-sessions\/[^/]+\/chunks$/.test(url.pathname)
        let body: string | Buffer | undefined
        if (method !== 'GET' && method !== 'HEAD') {
          if (isMultipart || isChunkAppend) {
            // Chunk cap: the kernel's hard chunk max is 32 MiB (+ envelope).
            const read = await readBodyBytes(req, isChunkAppend ? 32 * 1024 * 1024 + 4096 : UPLOAD_MAX_BODY_BYTES)
            if (read.tooLarge) {
              sendJson(res, 413, bffError('payload_too_large', 'payload too large'))
              return
            }
            body = read.buffer
          } else {
            const read = await readBody(req)
            if (read.tooLarge) {
              sendJson(res, 413, bffError('payload_too_large', 'payload too large'))
              return
            }
            body = read.body
          }
        }
        // API-01/GOV-01 (hardening §4 P0): the authenticated operator session
        // is derived ONCE per request — it both normalizes identity fields in
        // write bodies and supplies x-principal-session for the kernel.
        // (Multipart bodies are never JSON, so identity normalization is a
        // no-op there; the kernel binds the project from the URL path.)
        const opSession = options.principal !== null ? operatorSession(options.dataDir, options.principal) : null
        if (opSession !== null && typeof body === 'string' && (method === 'POST' || method === 'PATCH' || method === 'PUT')) {
          const seedCreator = url.pathname === '/v1/projects' || url.pathname === '/v2/projects'
          body = normalizeIdentityBody(body, opSession.principal_id, opSession.session_id, seedCreator)
        }
        // api-contracts.md §1: mutation/creation headers pass through
        // (Idempotency-Key, X-Request-Id). Client-supplied identity is never
        // trusted on any surface: on /v1 the standalone enforces membership
        // itself, and on /v2 the identity headers below are overwritten with
        // the server-derived principal/role (never taken from the client).
        const proxyHeaders: Record<string, string> = isMultipart || isChunkAppend
          ? { 'content-type': incomingContentType ?? 'application/octet-stream', accept: 'application/json' }
          : { 'content-type': 'application/json', accept: 'application/json' }
        // §5 P0-1 (hardening API-01/SIDE-01): the BFF's OWN kernel bearer
        // (0600 dataDir/kernel-token) — the kernel demands it on every
        // non-health route. The browser's token never reaches the kernel;
        // the BFF substitutes its service credential here.
        proxyHeaders['authorization'] = `Bearer ${kernelToken}`
        // §4 P0 (API-01/EVID-01): internal routes demand the service token.
        // The BFF injects its OWN credential (server-derived, 0600 file) and
        // never forwards a client-supplied x-service-token; the kernel
        // ignores the header on non-internal routes.
        proxyHeaders['x-service-token'] = serviceToken
        // PTY-01 (hardening §5 P0-2): x-pty-lease (the opaque session lease
        // pinned at open) passes through so control/frames can present it —
        // the KERNEL validates it against the session owner; the BFF never
        // reads or mints it. Idempotency-Key/X-Request-Id keep passing
        // through per api-contracts.md §1.
        for (const name of ['idempotency-key', 'x-request-id', 'x-pty-lease']) {
          const value = req.headers[name]
          if (typeof value === 'string' && value !== '') proxyHeaders[name] = value
        }
        // Artifact previews and downloads rely on conditional/range reads.
        // Forward only the standard read headers; browser identity headers
        // remain server-derived below.
        if ((method === 'GET' || method === 'HEAD') && /^\/v1\/artifacts\/[^/]+$/.test(url.pathname)) {
          for (const name of ['range', 'if-none-match']) {
            const value = req.headers[name]
            if (typeof value === 'string' && value !== '') proxyHeaders[name] = value
          }
        }
        // CHUNK-01: chunk protocol headers pass through (the kernel validates
        // offset contiguity + per-chunk sha256; the BFF never reads them).
        if (isChunkAppend) {
          const contentRange = req.headers['content-range']
          const chunkSha = req.headers['x-chunk-sha256']
          if (typeof contentRange === 'string' && contentRange !== '') proxyHeaders['content-range'] = contentRange
          if (typeof chunkSha === 'string' && chunkSha !== '') proxyHeaders['x-chunk-sha256'] = chunkSha
        }
        // API-01 v2 identity forwarding: on /v2/* the BFF injects the
        // loopback operator identity (x-principal-id) plus the role it
        // resolved from project membership (x-principal-role:
        // pi|researcher|operator|auditor|viewer) so kernel handleV2 can
        // enforce membership and apply the role policy. Both headers are
        // derived server-side from the BFF's own membership lookup — a
        // client-supplied value is never trusted. Non-project-scoped v2
        // routes (e.g. /v2/health) still pass through; the identity header
        // is inert there and lets the kernel filter the /v2 list.
        if (options.principal !== null && url.pathname.startsWith('/v2/')) {
          proxyHeaders['x-principal-id'] = options.principal
          if (memberProjectId !== null) {
            const role = await projectRole(memberProjectId)
            if (role !== null) proxyHeaders['x-principal-role'] = role
          }
        }
        // WRITING-PRINCIPAL-02: canonical TeX patch application is a Human
        // BFF operation. The Kernel accepts the identity only when this
        // server-owned audience accompanies the session-derived principal;
        // browser-supplied service/audience headers are never forwarded.
        if (options.principal !== null && method === 'POST'
          && /^\/v2\/projects\/[^/]+\/writing-patches\/[^/]+\/apply$/.test(url.pathname)) {
          proxyHeaders['x-service-principal'] = 'standalone-human-bff'
        }
        // v2 shape (domain-model.md §9): job submission records the durable
        // submitter principal (jobs.created_by_principal_id). On the v1 jobs
        // route the BFF injects the loopback operator identity the same way
        // it does for /v2/* — server-derived, never client-supplied; the
        // kernel route falls back to the body override for internal callers
        // and NULL when neither is present.
        if (options.principal !== null && method === 'POST' && /^\/v1\/projects\/[^/]+\/(?:jobs|baseline-runs)$/.test(url.pathname)) {
          proxyHeaders['x-principal-id'] = options.principal
        }
        // REVIEW-CONFIG-WRITE-03: a single Settings transaction can combine
        // global/runtime administration with one or more project-scoped
        // config/binding operations. Parse it at the trusted BFF boundary,
        // authorize every referenced project, and derive the global role
        // independently. The kernel repeats these checks from durable state.
        if (options.principal !== null && method === 'POST' && url.pathname === '/v1/settings/transactions') {
          let targets: SettingsWriteAuthorizationTargets
          try {
            if (typeof body !== 'string') throw new TypeError('Settings transaction must be JSON')
            targets = settingsWriteAuthorizationTargets(body)
          } catch {
            sendJson(res, 422, bffError('validation_error', 'invalid Settings transaction'))
            return
          }
          let forwardedRole: 'pi' | 'operator' | null = null
          for (const projectId of targets.projectIds) {
            const role = await projectRole(projectId)
            if (role === null) {
              sendJson(res, 404, bffError('project_not_found', 'project not found or access denied'))
              return
            }
            if (role !== 'pi' && role !== 'operator') {
              sendJson(res, 403, bffError('role_forbidden', 'Settings writes require PI or operator role'))
              return
            }
            if (role === 'operator') forwardedRole = 'operator'
            else if (forwardedRole === null) forwardedRole = 'pi'
          }
          if (targets.requiresGlobalAdmin) {
            const role = await globalConfigRole()
            if (role === null) {
              sendJson(res, 403, bffError('role_forbidden', 'global Settings writes require PI or operator role'))
              return
            }
            forwardedRole = role
          }
          proxyHeaders['x-principal-id'] = options.principal
          if (forwardedRole !== null) proxyHeaders['x-principal-role'] = forwardedRole
        }
        // Config effective/layer/revision reads are redacted, but a
        // project-scoped view still requires current durable membership in
        // the Kernel. The browser never supplies its own principal header.
        if (options.principal !== null && url.pathname.startsWith('/v1/config/')) {
          proxyHeaders['x-principal-id'] = options.principal
        }
        if (options.principal !== null
          && method === 'GET'
          && /^\/v1\/projects\/[^/]+\/model-binding$/.test(url.pathname)) {
          proxyHeaders['x-principal-id'] = options.principal
        }
        // PTY-SESSION-02: the browser supplies only an opaque context_id.
        // Project, membership, role, runner binding and parent authority are
        // re-resolved by the Kernel. The BFF contributes only its trusted
        // principal and never parses an obsolete project_id from the body.
        if (options.principal !== null && url.pathname.startsWith('/v1/pty/')) {
          proxyHeaders['x-principal-id'] = options.principal
        }
        // API-01/PTY-01 (hardening §5 P0-2): POST /v1/artifacts is a
        // global-id WRITE — the target project lives in the body, not the
        // path. Mirror the pty-open rule: membership of the operator in the
        // body's project is enforced BEFORE forwarding (unknown/foreign
        // project → 404, no artifact row, no CAS bytes) and viewer/auditor
        // cannot register artifacts (403, same role policy).
        if (options.principal !== null && method === 'POST' && url.pathname === '/v1/artifacts') {
          let artifactProjectIdBody: string | null = null
          if (typeof body === 'string' && body !== '') {
            try {
              const parsed = JSON.parse(body) as { project_id?: unknown }
              if (typeof parsed.project_id === 'string' && parsed.project_id !== '') artifactProjectIdBody = parsed.project_id
            } catch { /* invalid JSON → the kernel answers 422 validation_error */ }
          }
          if (artifactProjectIdBody !== null) {
            if (!(await isProjectMember(artifactProjectIdBody))) {
              sendJson(res, 404, { error: { code: 'project_not_found', message: 'project not found or access denied' } })
              return
            }
            const artifactRole = await projectRole(artifactProjectIdBody)
            if (artifactRole === 'viewer' || artifactRole === 'auditor') {
              sendJson(res, 403, bffError('role_forbidden', 'role forbidden'))
              return
            }
          }
        }
        // TRAJ-01/SUBAGENT-01 (trajectory-subagents.md §7): the kernel
        // demands the authenticated principal for BOTH project-scoped JSON
        // routes and child/global topology routes. Membership was already
        // checked above; identity is derived server-side and a browser-
        // supplied x-principal-id is never forwarded.
        if (options.principal !== null && (
          isProjectTrajectoryTopologyForward(url.pathname) ||
          url.pathname.startsWith('/v1/topology/')
        )) {
          proxyHeaders['x-principal-id'] = options.principal
        }
        // API-01/§22 (acceptance-tests.md §21 SSE 实时流替代轮询): the new
        // v1 SSE stream routes under a PATH project (workspace watch/stream,
        // trajectory/stream) enforce principal + membership fail-closed at
        // the kernel (requireProjectMember) — inject the loopback operator
        // identity like /v1/topology. BFF membership was already enforced
        // above via projectIdFromPath BEFORE any stream byte; the pty
        // frames stream is covered by the /v1/pty/sessions rule.
        if (options.principal !== null && isSseStreamForward(url.pathname)) {
          proxyHeaders['x-principal-id'] = options.principal
        }
        // GOV-01/ONBOARD-01 (hardening §5 P1): the PI-only v1 routes (intake
        // adopt, project archive/unarchive) are double-checked by the KERNEL,
        // which resolves the acting principal's role from its OWN
        // project_members table (researcher/viewer/auditor → 403
        // role_forbidden, unknown principal → 404, missing identity → 422
        // principal_required — never a single BFF layer). The BFF therefore
        // injects its server-derived operator identity on these forwards;
        // the role header is a hint for the kernel's fast path, the kernel
        // membership lookup is the authority.
        if (options.principal !== null && (
          method === 'POST' && isKernelPiOnlyForward(url.pathname)
          || isProjectDelete(method, url.pathname)
          || isIntakeHumanForward(method, url.pathname)
        )) {
          proxyHeaders['x-principal-id'] = options.principal
          if (memberProjectId !== null) {
            const role = await projectRole(memberProjectId)
            if (role !== null) proxyHeaders['x-principal-role'] = role
          }
        }
        // Intake answer/adopt/reject are Human-only BFF writes. The shared
        // service token admits the service process; this fixed audience plus
        // the durable principal/session headers proves the Human channel.
        if (isIntakeHumanForward(method, url.pathname)) {
          proxyHeaders['x-service-principal'] = 'standalone-human-bff'
        }
        // GOV-01 principal resolver: the authenticated operator session is a
        // DURABLE identity derived from the bearer token (session.json,
        // 0600, stable across restarts — "Session link 在重启后恢复"). Every
        // forwarded request carries x-principal-session so kernel decisions
        // record the session_id (durable principal, acceptance-tests.md §2).
        if (opSession !== null) {
          proxyHeaders['x-principal-session'] = opSession.session_id
        }
        const upstream = await fetch(`${endpoint}${url.pathname}${url.search}`, {
          method,
          headers: proxyHeaders,
          // Multipart bodies are Buffers — pass a Uint8Array copy (never a
          // string, which would corrupt binary file content).
          body: body === undefined ? undefined
            : typeof body === 'string' ? body
              : new Uint8Array(body),
        })
        // Preserve the HTTP Range contract for Artifact reads.  A 416 is a
        // normal byte-serving response (with `Content-Range: bytes */N`),
        // not a JSON kernel error to be collapsed into the generic envelope.
        const artifactRangeNotSatisfiable = upstream.status === 416 &&
          (method === 'GET' || method === 'HEAD') &&
          /^\/v1\/artifacts\/[^/]+$/.test(url.pathname)
        if (artifactRangeNotSatisfiable) {
          const headers: Record<string, string> = {
            'cache-control': upstream.headers.get('cache-control') ?? 'no-store',
            'x-content-type-options': 'nosniff',
          }
          for (const name of ['content-range', 'accept-ranges', 'etag']) {
            const value = upstream.headers.get(name)
            if (value !== null) headers[name] = value
          }
          res.writeHead(416, headers)
          res.end()
          return
        }
        if (upstream.status >= 400) {
          let code = upstream.status >= 500 ? 'kernel_error' : 'request_rejected'
          if (upstream.status < 500) {
            try {
              const payload = await upstream.json() as { error?: { code?: unknown } }
              const candidate = payload.error?.code
              if (typeof candidate === 'string' && /^[a-z][a-z0-9_]{0,63}$/.test(candidate)) code = candidate
            } catch { /* malformed upstream error stays generic */ }
          }
          sendJson(res, upstream.status, { error: { code, message: 'research request rejected' } })
          return
        }
        const headers: Record<string, string> = {
          'cache-control': upstream.headers.get('cache-control') ?? 'no-store',
          'x-content-type-options': 'nosniff',
        }
        for (const name of ['content-type', 'content-length', 'content-disposition', 'content-range', 'accept-ranges', 'etag', 'last-modified']) {
          const value = upstream.headers.get(name)
          if (value !== null) headers[name] = value
        }
        res.writeHead(upstream.status, headers)
        if (upstream.body === null) {
          res.end()
        } else {
          const source = Readable.fromWeb(upstream.body as unknown as Parameters<typeof Readable.fromWeb>[0])
          const abortSource = (): void => { source.destroy() }
          req.once('aborted', abortSource)
          res.once('error', abortSource)
          res.once('close', () => {
            if (!res.writableEnded) abortSource()
          })
          source.once('error', () => {
            if (!res.destroyed) res.destroy()
          })
          source.pipe(res)
        }
        return
      }

      sendJson(res, 404, bffError('not_found', 'not found'))
      } catch (error) {
        if (res.headersSent || res.writableEnded || res.destroyed) {
          if (!res.destroyed) res.destroy(error instanceof Error ? error : undefined)
          return
        }
        sendJson(res, 500, bffError('internal_error', 'research request failed'))
      }
    })().catch(error => {
      if (!res.destroyed) res.destroy(error instanceof Error ? error : undefined)
    })
  })

  try {
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error): void => reject(error)
      server.once('error', onError)
      server.listen(options.port, options.host, () => {
        server.off('error', onError)
        resolve()
      })
    })
  } catch (error) {
    await sidecar.stop()
    throw error
  }
  console.log(`[research-ui-standalone] serving at http://${options.host}:${options.port}`)
  console.log(`[research-ui-standalone] kernel at ${endpoint}`)
  if (options.token !== null) {
    console.log('[research-ui-standalone] token auth enabled; read the 0600 standalone-token file')
  } else {
    console.log(`[research-ui-standalone] token auth DISABLED (loopback only)`)
  }

  const shutdown = (): void => {
    server.close(() => { void sidecar.stop().then(() => process.exit(0)) })
    setTimeout(() => process.exit(0), 3000).unref()
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
}

// Direct execution: `node lib/standalone/server.js ...`
if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  // CONFIG-01: `--help` prints the registry-generated CLI help (no server
  // start, no token file writes).
  if (process.argv.includes('--help') || process.argv.includes('-h')) {
    console.log(`DSH Scholar standalone web application server (design §15.2/§15.3)\nUsage: node lib/standalone/server.js [options]\n\n${generateCliHelp('standalone')}`)
    process.exit(0)
  }
  // SEC-UI-01: startup failures (incl. argument validation) exit non-zero
  // with the STABLE message only — never a raw stack trace that would leak
  // internal paths into the service log.
  let options: StandaloneOptions
  try {
    options = loadOptions(process.argv.slice(2))
  } catch (error) {
    console.error(`[research-ui-standalone] fatal: ${(error as Error).message}`)
    process.exit(1)
  }
  void startStandalone(options).catch(error => {
    console.error(`[research-ui-standalone] fatal: ${(error as Error).message}`)
    process.exit(1)
  })
}
