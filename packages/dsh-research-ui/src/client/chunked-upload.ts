/**
 * CHUNK-01 — 浏览器批量分块上传队列状态机（init-grill-upload-models.md §3，
 * 规范性契约）。PURE 逻辑层（无 DOM）：
 *
 *   enqueueFiles / hashFile        → hashing → queued（客户端预计算 sha256，
 *                                   服务端 finalize 复算比对，从不信任）
 *   nextChunkRange / canonical response validation → uploading：按
 *                                   committed_offset 顺序推进；replayed 幂等
 *   pauseItem / resumeItem / retryItem / markFailed → paused/queued/failed
 *   queueSummary                    → 队列级总配额/进度/失败数/下一步
 *   chatAttachmentRef               → Chat 消息只保存 attachment/stage ref
 *
 * 上传驱动 `driveQueue` 接受注入的 transport（begin/append/finalize/abort），
 * 测试用 fake transport 跑全生命周期；浏览器接线（chat.ts composer 附件
 * 按钮/拖拽/粘贴 → browserTransport）属视觉层，NOT_RUN_MANUAL_PENDING。
 *
 * 服务端协议（research-kernel/chunked-upload.ts + server.ts）：
 *   POST   /v1/projects/{id}/intake/{iid}/upload-sessions      begin
 *   PUT    .../upload-sessions/{uid}/chunks                     append（原始字节
 *          头：Content-Range: bytes a-b/total + X-Chunk-SHA256）
 *   POST   .../upload-sessions/{uid}/finalize                   finalize
 *   POST   .../upload-sessions/{uid}/abort                      abort（幂等）
 *   GET    .../upload-sessions                                  list（断线续传）
 * @module dsh-research-ui/client/chunked-upload
 */

import type { ChatAttachmentRef } from './types'
import { authHeaders, base, ensureCsrfToken } from './api'
import { sha256 } from '@noble/hashes/sha2.js'

export type QueueItemState =
  | 'hashing'
  | 'queued'
  | 'uploading'
  | 'paused'
  | 'finalizing'
  | 'scanning'
  | 'needs_input'
  | 'ready'
  | 'quarantined'
  | 'failed'

/** 单文件队列项（批量队列：每文件独立状态 + committed offset）。 */
export interface UploadQueueItem {
  fileId: string
  fileName: string
  fileSize: number
  mediaType: string
  state: QueueItemState
  /** 服务端会话 id（begin 后赋值）。 */
  uploadId: string | null
  intakeId: string | null
  projectId: string | null
  /** 客户端 hashing 阶段预计算的整体 sha256（服务端 finalize 复算比对）。 */
  expectedSha256: string | null
  /** Server-negotiated chunk cap. Persisted for exact-offset resume. */
  chunkSize: number | null
  /** 已提交字节数（= 下一个可发送 chunk 的 offset）。 */
  committedOffset: number
  retryCount: number
  lastError: UploadFailure | null
}

export const UPLOAD_FAILURE_CODES = [
  'attachment_intake_unavailable',
  'upload_file_hash_mismatch',
  'upload_file_reselect_required',
  'upload_session_identity_mismatch',
  'upload_session_unavailable',
  'upload_session_aborted',
  'upload_session_expired',
  'upload_begin_failed',
  'upload_chunk_failed',
  'upload_finalize_failed',
  'upload_abort_failed',
  'upload_list_failed',
  'upload_protocol_invalid',
  'upload_hash_failed',
  'upload_hash_required',
  'upload_hash_missing',
  'upload_chunk_size_invalid',
  'upload_offset_regressed',
  'upload_cancelled',
  'upload_quarantined',
  'upload_needs_input',
  'upload_scan_failed',
  'upload_failed',
] as const

export type UploadFailureCode = typeof UPLOAD_FAILURE_CODES[number]

export interface UploadFailure {
  readonly code: UploadFailureCode
  readonly status?: number
}

const UPLOAD_FAILURE_CODE_SET = new Set<string>(UPLOAD_FAILURE_CODES)

export function isUploadFailure(value: unknown): value is UploadFailure {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const candidate = value as { code?: unknown; status?: unknown }
  const keys = Object.keys(candidate)
  return keys.every(key => key === 'code' || key === 'status')
    && typeof candidate.code === 'string' && UPLOAD_FAILURE_CODE_SET.has(candidate.code)
    && (candidate.status === undefined
      || (Number.isInteger(candidate.status) && (candidate.status as number) >= 100 && (candidate.status as number) <= 599))
}

export function uploadFailure(code: UploadFailureCode, status?: number): UploadFailure {
  return status === undefined ? { code } : { code, status }
}

export class UploadFailureError extends Error {
  constructor(readonly failure: UploadFailure) {
    super(failure.code)
    this.name = 'UploadFailureError'
  }
}

/** Stable, display-safe upload failure carried in queue state. Raw browser,
 * network and server error prose must never cross into the localized UI. */
export function uploadFailureReason(error: unknown, fallback: UploadFailureCode = 'upload_failed'): UploadFailure {
  if (error instanceof UploadFailureError) return error.failure
  if (isUploadFailure(error)) return error
  if (typeof DOMException !== 'undefined' && error instanceof DOMException && error.name === 'AbortError') {
    return uploadFailure('upload_cancelled')
  }
  return uploadFailure(fallback)
}

/** 队列摘要（总配额/进度/失败数/下一步 —— UI 队列级展示）。 */
export interface UploadQueueSummary {
  totalBytes: number
  committedBytes: number
  remainingBytes: number
  quotaBytes: number
  failedCount: number
  pausedCount: number
  activeCount: number
  readyCount: number
  nextStep: 'upload' | 'scan' | 'confirm' | 'idle'
}

/** 注入式传输（测试用 fake transport；浏览器用 browserTransport）。 */
export interface UploadBeginRequest {
  project_id: string
  intake_id: string
  file_name: string
  media_type: string
  expected_size: number
  expected_sha256?: string
  chunk_size?: number
  owner_scope_id?: string
  signal?: AbortSignal
}

export interface UploadBeginResult {
  upload_id: string
  intake_id: string
  project_id: string
  file_name: string
  media_type: string
  expected_size: number
  expected_sha256: string | null
  chunk_size: number
  committed_offset: number
}

export interface UploadAppendRequest {
  project_id: string
  upload_id: string
  intake_id: string
  start: number
  end: number
  total: number
  bytes: Uint8Array
  sha256: string
  signal?: AbortSignal
}

export interface UploadAppendResult {
  upload_id: string
  committed_offset: number
  replayed: boolean
}

export interface UploadTransport {
  beginSession(input: UploadBeginRequest): Promise<UploadBeginResult>
  appendChunk(input: UploadAppendRequest): Promise<UploadAppendResult>
  finalize(input: { project_id: string; upload_id: string; intake_id: string; signal?: AbortSignal }): Promise<unknown>
  abort(input: { project_id: string; upload_id: string; intake_id: string; signal?: AbortSignal }): Promise<unknown>
  /** Browser recovery seam. Upload drivers do not require it, while the
   * page-lifetime queue uses it to reconcile durable offsets after reload. */
  listSessions?(input: { project_id: string; intake_id: string; signal?: AbortSignal }): Promise<UploadSessionProjection[]>
}

export interface UploadSessionProjection {
  upload_id: string
  intake_id: string
  file_name: string
  media_type: string
  expected_size: number
  expected_sha256: string | null
  chunk_size: number
  committed_offset: number
  status: 'open' | 'finalized' | 'aborted' | 'expired'
}

const MAX_UPLOAD_CHUNK_SIZE = 32 * 1024 * 1024

/** Canonical validation for every successful begin boundary. Both the real
 * browser transport and the injected upload driver use this exact contract. */
function validateBeginResult(
  value: unknown,
  request: UploadBeginRequest,
  minimumCommittedOffset = 0,
): UploadBeginResult {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new UploadFailureError(uploadFailure('upload_protocol_invalid'))
  }
  const result = value as Partial<Record<keyof UploadBeginResult, unknown>>
  if (
    typeof result.upload_id !== 'string' || result.upload_id === ''
    || result.intake_id !== request.intake_id
    || result.project_id !== request.project_id
    || result.file_name !== request.file_name
    || result.media_type !== request.media_type
    || result.expected_size !== request.expected_size
    || result.expected_sha256 !== (request.expected_sha256 ?? null)
    || !Number.isSafeInteger(result.committed_offset)
    || (result.committed_offset as number) > request.expected_size
  ) throw new UploadFailureError(uploadFailure('upload_protocol_invalid'))
  if ((result.committed_offset as number) < minimumCommittedOffset) {
    throw new UploadFailureError(uploadFailure('upload_offset_regressed'))
  }
  if (
    !Number.isSafeInteger(result.chunk_size)
    || (result.chunk_size as number) <= 0
    || (result.chunk_size as number) > MAX_UPLOAD_CHUNK_SIZE
  ) throw new UploadFailureError(uploadFailure('upload_chunk_size_invalid'))
  return result as unknown as UploadBeginResult
}

/** Canonical validation for every successful append boundary. A replay may
 * report an authoritative offset beyond the requested old range, but every
 * response must still make bounded forward progress. */
function validateAppendResult(value: unknown, request: UploadAppendRequest): UploadAppendResult {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new UploadFailureError(uploadFailure('upload_protocol_invalid'))
  }
  const result = value as Partial<Record<keyof UploadAppendResult, unknown>>
  if (Number.isSafeInteger(result.committed_offset) && (result.committed_offset as number) <= request.start) {
    throw new UploadFailureError(uploadFailure('upload_offset_regressed'))
  }
  if (
    result.upload_id !== request.upload_id
    || !Number.isSafeInteger(result.committed_offset)
    || (result.committed_offset as number) < request.end + 1
    || (result.committed_offset as number) > request.total
    || typeof result.replayed !== 'boolean'
    || (result.replayed === false && result.committed_offset !== request.end + 1)
  ) throw new UploadFailureError(uploadFailure('upload_protocol_invalid'))
  return result as UploadAppendResult
}

let fileIdCounter = 0

/** 新建队列项（hashing 初始态）。 */
export function enqueueFiles(
  files: Array<{ name: string; size: number; type?: string }>,
): UploadQueueItem[] {
  return files.map(file => ({
    fileId: `f${Date.now().toString(36)}-${(fileIdCounter += 1).toString(36)}`,
    fileName: file.name,
    fileSize: file.size,
    mediaType: file.type ?? 'application/octet-stream',
    state: 'hashing',
    uploadId: null,
    intakeId: null,
    projectId: null,
    expectedSha256: null,
    chunkSize: null,
    committedOffset: 0,
    retryCount: 0,
    lastError: null,
  }))
}

/** 文件 hashing（客户端预计算；失败 → failed）。 */
export function markHashed(item: UploadQueueItem, sha256: string): UploadQueueItem {
  return { ...item, state: 'queued', expectedSha256: sha256, lastError: null }
}

export function markQueued(item: UploadQueueItem): UploadQueueItem {
  return { ...item, state: 'queued', lastError: null }
}

/** begin 成功：绑定服务端会话，进入 uploading。 */
export function markUploading(
  item: UploadQueueItem,
  uploadId: string,
  intakeId: string,
  projectId: string,
  chunkSize: number,
): UploadQueueItem {
  return { ...item, state: 'uploading', uploadId, intakeId, projectId, chunkSize, lastError: null }
}

/** 下一个待发送 chunk 范围（[start, end]，end 含）；已传完 → null。 */
export function nextChunkRange(item: UploadQueueItem, chunkSize: number): { start: number; end: number } | null {
  if (item.committedOffset >= item.fileSize) return null
  const end = Math.min(item.committedOffset + chunkSize - 1, item.fileSize - 1)
  return { start: item.committedOffset, end }
}

export function markFinalizing(item: UploadQueueItem): UploadQueueItem {
  return { ...item, state: 'finalizing' }
}

/** finalize 成功 → staged（等待 scan；scan 结果由服务端投影）。 */
export function markStaged(item: UploadQueueItem): UploadQueueItem {
  return { ...item, state: 'scanning', committedOffset: item.fileSize }
}

/** 扫描/确认结果（服务端 intake 投影回填）。 */
export function markScanResult(item: UploadQueueItem, verdict: 'clean' | 'quarantined' | 'needs_input' | 'failed'): UploadQueueItem {
  switch (verdict) {
    case 'clean': return { ...item, state: 'ready', lastError: null }
    case 'quarantined': return { ...item, state: 'quarantined', lastError: uploadFailure('upload_quarantined') }
    case 'needs_input': return { ...item, state: 'needs_input', lastError: uploadFailure('upload_needs_input') }
    case 'failed': return { ...item, state: 'failed', lastError: uploadFailure('upload_scan_failed') }
  }
}

export function pauseItem(item: UploadQueueItem): UploadQueueItem {
  return item.state === 'uploading' || item.state === 'queued' ? { ...item, state: 'paused' } : item
}

export function resumeItem(item: UploadQueueItem): UploadQueueItem {
  return item.state === 'paused' ? { ...item, state: 'uploading' } : item
}

/** 重试：保留 committed offset（服务端会话续传；无会话则重新 queued）。 */
export function retryItem(item: UploadQueueItem): UploadQueueItem {
  if (item.state !== 'failed') return item
  if (item.uploadId !== null) return { ...item, state: 'uploading', retryCount: item.retryCount + 1, lastError: null }
  return { ...item, state: 'queued', retryCount: item.retryCount + 1, lastError: null }
}

export function markFailed(
  item: UploadQueueItem,
  error: unknown,
  fallback: UploadFailureCode = 'upload_failed',
): UploadQueueItem {
  return { ...item, state: 'failed', lastError: uploadFailureReason(error, fallback) }
}

/** Chat 消息 attachment/stage ref（消息只保存 ref，不保存字节）。 */
export function chatAttachmentRef(item: UploadQueueItem): ChatAttachmentRef | null {
  if (item.uploadId === null || item.intakeId === null || item.projectId === null) return null
  return {
    kind: 'intake-upload',
    upload_id: item.uploadId,
    intake_id: item.intakeId,
    project_id: item.projectId,
    file_name: item.fileName,
    state: item.state === 'paused' ? 'paused'
      : item.state === 'ready' ? 'ready'
        : item.state === 'quarantined' ? 'quarantined'
          : item.state === 'failed' ? 'failed'
            : item.state === 'scanning' || item.state === 'finalizing' ? 'staged'
              : item.state === 'uploading' || item.state === 'queued' ? 'uploading'
                : 'queued',
  }
}

/** 队列级摘要（总配额/进度/失败数/下一步）。 */
export function queueSummary(items: UploadQueueItem[], quotaBytes: number): UploadQueueSummary {
  let totalBytes = 0
  let committedBytes = 0
  let failedCount = 0
  let pausedCount = 0
  let activeCount = 0
  let readyCount = 0
  let needsInput = false
  for (const item of items) {
    totalBytes += item.fileSize
    committedBytes += item.committedOffset
    if (item.state === 'failed') failedCount += 1
    if (item.state === 'paused') pausedCount += 1
    if (item.state === 'hashing' || item.state === 'queued' || item.state === 'uploading' || item.state === 'finalizing' || item.state === 'scanning') activeCount += 1
    if (item.state === 'ready') readyCount += 1
    if (item.state === 'needs_input' || item.state === 'quarantined') needsInput = true
  }
  const remainingBytes = Math.max(0, totalBytes - committedBytes)
  const allCommitted = remainingBytes === 0 && items.length > 0
  let nextStep: UploadQueueSummary['nextStep'] = 'idle'
  if (items.length === 0) nextStep = 'idle'
  else if (allCommitted && (needsInput || failedCount > 0 || pausedCount > 0)) nextStep = 'confirm'
  else if (allCommitted && readyCount > 0) nextStep = 'scan'
  else if (allCommitted) nextStep = 'confirm'
  else nextStep = 'upload'
  return {
    totalBytes,
    committedBytes,
    remainingBytes,
    quotaBytes,
    failedCount,
    pausedCount,
    activeCount,
    readyCount,
    nextStep,
  }
}

/** sha256（十六进制）—— Node/browser 通用（crypto.subtle 或注入实现）。 */
export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const subtle = globalThis.crypto?.subtle
  if (subtle === undefined) throw new Error('crypto.subtle unavailable')
  const digest = await subtle.digest('SHA-256', bytes as unknown as ArrayBuffer)
  return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('')
}

export interface SliceableUploadFile {
  readonly size: number
  slice(start?: number, end?: number): { arrayBuffer(): Promise<ArrayBuffer> }
}

/** Incremental whole-file SHA-256. Only one bounded slice is resident at a
 * time, so the browser's memory use does not grow with a multi-GiB upload. */
export async function sha256File(file: SliceableUploadFile, chunkSize = 8 * 1024 * 1024, signal?: AbortSignal): Promise<string> {
  if (!Number.isSafeInteger(chunkSize) || chunkSize <= 0 || chunkSize > 32 * 1024 * 1024) {
    throw new Error('invalid hash chunk size')
  }
  const hasher = sha256.create()
  for (let start = 0; start < file.size; start += chunkSize) {
    if (signal?.aborted === true) throw signal.reason ?? new Error('upload cancelled')
    const end = Math.min(start + chunkSize, file.size)
    hasher.update(new Uint8Array(await file.slice(start, end).arrayBuffer()))
  }
  if (signal?.aborted === true) throw signal.reason ?? new Error('upload cancelled')
  return [...hasher.digest()].map(byte => byte.toString(16).padStart(2, '0')).join('')
}

/**
 * 上传驱动：顺序发送 chunk（begin → append → finalize）。失败重试
 * （retryCount < maxRetries）。返回最终队列。PURE 于 transport 与
 * readBytes —— 测试注入 fake transport + fake bytes 即可全生命周期验证。
 */
export async function driveUpload(
  item: UploadQueueItem,
  transport: UploadTransport,
  options: {
    chunkSize?: number
    maxRetries?: number
    /** Return false when the exact-session owner rejected this late state. */
    onState?: (item: UploadQueueItem) => boolean | void
    readBytes?: (fileId: string, start: number, end: number) => Promise<Uint8Array | null>
    /** 每 chunk 前询问是否继续；返回 false → 暂停（pauseItem）并返回。 */
    shouldContinue?: (item: UploadQueueItem) => boolean
    /** Exact-session cancellation, shared across composer remounts. */
    signal?: AbortSignal
    /** Durable server-side scope bound to this Chat session. */
    ownerScopeId?: string
  } = {},
): Promise<UploadQueueItem> {
  let chunkSize = item.chunkSize ?? options.chunkSize ?? 8 * 1024 * 1024
  const maxRetries = options.maxRetries ?? 3
  const readBytes = options.readBytes ?? (() => Promise.resolve(null))
  let current = item
  const emit = (next: UploadQueueItem): boolean => {
    current = next
    return options.onState?.(next) !== false
  }
  const shouldContinue = (next: UploadQueueItem): boolean =>
    options.signal?.aborted !== true && (options.shouldContinue?.(next) ?? true)
  const abortRejectedSession = async (next: UploadQueueItem): Promise<void> => {
    if (next.uploadId === null || next.intakeId === null || next.projectId === null) return
    await transport.abort({
      project_id: next.projectId,
      upload_id: next.uploadId,
      intake_id: next.intakeId,
    }).catch(() => {})
  }

  if (current.state === 'hashing') emit(markFailed(current, uploadFailure('upload_hash_required')))
  if (current.state === 'failed') return current
  if (current.uploadId === null) {
    if (current.expectedSha256 === null) {
      emit(markFailed(current, uploadFailure('upload_hash_missing')))
      return current
    }
    try {
      const request: UploadBeginRequest = {
        project_id: current.projectId ?? '',
        intake_id: current.intakeId ?? '',
        file_name: current.fileName,
        media_type: current.mediaType,
        expected_size: current.fileSize,
        expected_sha256: current.expectedSha256,
        chunk_size: chunkSize,
        owner_scope_id: options.ownerScopeId,
        signal: options.signal,
      }
      const session = validateBeginResult(await transport.beginSession(request), request, current.committedOffset)
      chunkSize = session.chunk_size
      const begun = {
        ...markUploading(
          current,
          session.upload_id,
          current.intakeId ?? '',
          current.projectId ?? '',
          chunkSize,
        ),
        committedOffset: session.committed_offset,
      }
      if (!shouldContinue(begun)) {
        const paused = { ...begun, state: 'paused' as const }
        if (!emit(paused)) await abortRejectedSession(paused)
        return current
      }
      if (!emit(begun)) {
        await abortRejectedSession(begun)
        return current
      }
    } catch (error) {
      emit(markFailed(current, error, 'upload_begin_failed'))
      return current
    }
  } else {
    emit({ ...current, state: 'uploading' })
  }

  const uploadId = current.uploadId!
  const intakeId = current.intakeId ?? ''
  const projectId = current.projectId ?? ''
  while (current.committedOffset < current.fileSize) {
    if (!shouldContinue(current)) {
      emit(pauseItem(current))
      return current
    }
    const range = nextChunkRange(current, chunkSize)
    if (range === null) break
    let chunk: Uint8Array | null
    let sha: string
    try {
      chunk = await readBytes(current.fileId, range.start, range.end)
      if (chunk === null) {
        emit(markFailed(current, uploadFailure('upload_file_reselect_required')))
        return current
      }
      sha = await sha256Hex(chunk)
    } catch (error) {
      emit(markFailed(current, error, 'upload_chunk_failed'))
      return current
    }
    let attempts = 0
    for (;;) {
      try {
        const request: UploadAppendRequest = {
          project_id: projectId,
          upload_id: uploadId,
          intake_id: intakeId,
          start: range.start,
          end: range.end,
          total: current.fileSize,
          bytes: chunk,
          sha256: sha,
          signal: options.signal,
        }
        const result = validateAppendResult(await transport.appendChunk(request), request)
        const appended = { ...current, committedOffset: result.committed_offset }
        // A user can pause while appendChunk is in flight. Re-check the
        // external exact-session state before publishing the response so the
        // driver's stale "uploading" snapshot cannot overwrite that pause.
        if (!shouldContinue(appended)) {
          emit({ ...appended, state: 'paused' })
          return current
        }
        emit(appended)
        break
      } catch (error) {
        const failure = uploadFailureReason(error, 'upload_chunk_failed')
        if (failure.code === 'upload_protocol_invalid' || failure.code === 'upload_offset_regressed') {
          emit(markFailed(current, failure))
          return current
        }
        attempts += 1
        if (attempts > maxRetries) {
          emit(markFailed(current, error, 'upload_chunk_failed'))
          return current
        }
        if (!shouldContinue(current)) {
          emit({ ...current, state: 'paused', lastError: null })
          return current
        }
        emit({ ...current, lastError: failure })
      }
    }
  }

  if (!shouldContinue(current)) {
    emit({ ...current, state: 'paused' })
    return current
  }
  try {
    emit(markFinalizing(current))
    await transport.finalize({ project_id: projectId, upload_id: uploadId, intake_id: intakeId, signal: options.signal })
    // A close can race a finalize that the server already accepted. Reconcile
    // it with an idempotent abort before returning; the Kernel removes only a
    // still-staged artifact owned by this upload.
    if (!shouldContinue(current)) {
      await abortRejectedSession(current)
      return current
    }
    emit(markStaged(current))
    return current
  } catch (error) {
    if (options.signal?.aborted === true) {
      await abortRejectedSession(current)
      return current
    }
    emit(markFailed(current, error, 'upload_finalize_failed'))
    return current
  }
}

/**
 * 从 fileId 索引的 File 集合读取 [start,end] 字节。
 * 测试注入 fakeFileBytes 提供者；浏览器用 File.slice。
 */
export interface FileByteProvider {
  read(fileId: string, start: number, end: number): Promise<Uint8Array | null>
}

async function uploadResponseJson(response: Response): Promise<unknown> {
  try {
    return await response.json() as unknown
  } catch {
    throw new UploadFailureError(uploadFailure('upload_protocol_invalid'))
  }
}

/**
 * 浏览器传输：走同源 /v1 内核面（BFF 全量透传 + membership/CSRF 保持）。
 * begin/finalize/abort 为 JSON；append 为原始字节 PUT（Content-Range +
 * X-Chunk-SHA256 头）。服务端协议见 research-kernel/chunked-upload.ts。
 * 真实浏览器交互（附件按钮/拖拽/粘贴）属视觉层 NOT_RUN_MANUAL_PENDING。
 */
export function browserTransport(input: {
  fetchImpl?: typeof fetch
  authHeadersImpl?: () => Promise<Record<string, string>>
  baseImpl?: () => string
  csrfImpl?: () => Promise<string | undefined>
} = {}): UploadTransport {
  const fetchImpl = input.fetchImpl ?? fetch
  const auth = input.authHeadersImpl ?? authHeaders
  const baseUrl = input.baseImpl ?? base
  const csrf = input.csrfImpl ?? ensureCsrfToken
  const headers = async (): Promise<Record<string, string>> => ({
    ...(await auth()),
    'x-csrf-token': (await csrf()) ?? '',
  })
  return {
    async beginSession(body) {
      const response = await fetchImpl(`${baseUrl()}/v1/projects/${encodeURIComponent(body.project_id)}/intake/${encodeURIComponent(body.intake_id)}/upload-sessions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(await headers()) },
        body: JSON.stringify({
          file_name: body.file_name,
          media_type: body.media_type,
          expected_size: body.expected_size,
          expected_sha256: body.expected_sha256,
          chunk_size: body.chunk_size,
          owner_scope_id: body.owner_scope_id,
        }),
        signal: body.signal,
      })
      if (!response.ok) throw new UploadFailureError(uploadFailure('upload_begin_failed', response.status))
      return validateBeginResult(await uploadResponseJson(response), body)
    },
    async appendChunk({ project_id, upload_id, intake_id, start, end, total, bytes, sha256, signal }) {
      const response = await fetchImpl(
        `${baseUrl()}/v1/projects/${encodeURIComponent(project_id)}/intake/${encodeURIComponent(intake_id)}/upload-sessions/${encodeURIComponent(upload_id)}/chunks`,
        {
          method: 'PUT',
          headers: {
            'content-type': 'application/octet-stream',
            'content-range': `bytes ${start}-${end}/${total}`,
            'x-chunk-sha256': sha256,
            ...(await headers()),
          },
          body: bytes as unknown as BodyInit,
          signal,
        },
      )
      if (!response.ok) throw new UploadFailureError(uploadFailure('upload_chunk_failed', response.status))
      const request: UploadAppendRequest = { project_id, upload_id, intake_id, start, end, total, bytes, sha256, signal }
      return validateAppendResult(await uploadResponseJson(response), request)
    },
    async finalize({ project_id, upload_id, intake_id, signal }) {
      const response = await fetchImpl(
        `${baseUrl()}/v1/projects/${encodeURIComponent(project_id)}/intake/${encodeURIComponent(intake_id)}/upload-sessions/${encodeURIComponent(upload_id)}/finalize`,
        { method: 'POST', headers: { 'content-type': 'application/json', ...(await headers()) }, body: '{}', signal },
      )
      if (!response.ok) throw new UploadFailureError(uploadFailure('upload_finalize_failed', response.status))
      return uploadResponseJson(response)
    },
    async abort({ project_id, upload_id, intake_id, signal }) {
      const response = await fetchImpl(
        `${baseUrl()}/v1/projects/${encodeURIComponent(project_id)}/intake/${encodeURIComponent(intake_id)}/upload-sessions/${encodeURIComponent(upload_id)}/abort`,
        { method: 'POST', headers: { 'content-type': 'application/json', ...(await headers()) }, body: '{}', signal },
      )
      if (!response.ok) throw new UploadFailureError(uploadFailure('upload_abort_failed', response.status))
      return uploadResponseJson(response)
    },
    async listSessions({ project_id, intake_id, signal }) {
      const response = await fetchImpl(
        `${baseUrl()}/v1/projects/${encodeURIComponent(project_id)}/intake/${encodeURIComponent(intake_id)}/upload-sessions`,
        { headers: { accept: 'application/json', ...(await auth()) }, signal },
      )
      if (!response.ok) throw new UploadFailureError(uploadFailure('upload_list_failed', response.status))
      const body = await uploadResponseJson(response)
      if (!Array.isArray(body)) throw new UploadFailureError(uploadFailure('upload_protocol_invalid'))
      return body.flatMap((candidate): UploadSessionProjection[] => {
        if (candidate === null || typeof candidate !== 'object') return []
        const value = candidate as Record<string, unknown>
        if (
          typeof value.upload_id !== 'string' || typeof value.intake_id !== 'string'
          || typeof value.file_name !== 'string' || typeof value.media_type !== 'string'
          || !Number.isSafeInteger(value.expected_size) || (value.expected_size as number) < 0
          || !Number.isSafeInteger(value.chunk_size) || (value.chunk_size as number) <= 0
          || (value.chunk_size as number) > 32 * 1024 * 1024
          || !Number.isSafeInteger(value.committed_offset) || (value.committed_offset as number) < 0
          || (value.committed_offset as number) > (value.expected_size as number)
          || (value.expected_sha256 !== null && typeof value.expected_sha256 !== 'string')
          || (typeof value.expected_sha256 === 'string' && !/^[a-f0-9]{64}$/i.test(value.expected_sha256))
          || !['open', 'finalized', 'aborted', 'expired'].includes(String(value.status))
        ) return []
        return [{
          upload_id: value.upload_id,
          intake_id: value.intake_id,
          file_name: value.file_name,
          media_type: value.media_type,
          expected_size: value.expected_size as number,
          expected_sha256: value.expected_sha256 as string | null,
          chunk_size: value.chunk_size as number,
          committed_offset: value.committed_offset as number,
          status: value.status as UploadSessionProjection['status'],
        }]
      })
    },
  }
}
