/** Official MinerU Open API adapter. Protocol sources and limits are recorded
 * in docs/init-grill-upload-models.md (review 2026-09-06). */
import { basename } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import type { OcrNormalizedObservation, OcrRequest } from '@dsh-scholar/research-schemas'
import { extractArchiveEntries, scanArchive } from './archive-scan.js'
import {
  MinerUTransportError, type MinerUExtractInput, type MinerUExtractResult,
  type MinerUOcrTransport, type MinerUTransportBinding,
} from './ocr-worker.js'
import { MINERU_API_ORIGIN, requestMinerU, validateMinerUUrl, type MinerUHttpRequest } from './mineru-http.js'

const JSON_LIMIT = 1024 * 1024
const MARKDOWN_LIMIT = 8 * 1024 * 1024
const ZIP_LIMIT = 32 * 1024 * 1024
const ARCHIVE_LIMITS = { maxEntries: 1000, maxTotalBytes: 64 * 1024 * 1024, maxFileBytes: 16 * 1024 * 1024, maxRatio: 100 }
const WAITING = new Set(['waiting-file', 'uploading', 'pending', 'running', 'converting'])
const LANGUAGES = new Set(['ch', 'ch_server', 'en', 'japan', 'korean', 'chinese_cht', 'ta', 'te', 'ka', 'el', 'th', 'latin', 'arabic', 'cyrillic', 'east_slavic', 'devanagari'])
const LANGUAGE_ALIASES: Record<string, string> = { auto: 'ch', 'zh-CN': 'ch', 'zh-TW': 'chinese_cht', zh: 'ch', ja: 'japan', ko: 'korean' }
function invalid(): never { throw Object.assign(new Error('invalid normalized MinerU result'), { code: 'ocr_result_invalid' }) }
function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return invalid()
  return value as Record<string, unknown>
}
function text(value: unknown): string { if (typeof value !== 'string' || value === '') return invalid(); return value }
function decode(bytes: Buffer): string {
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes) } catch { return invalid() }
}
function parseJson(bytes: Buffer): Record<string, unknown> {
  try { return record(JSON.parse(decode(bytes))) } catch { return invalid() }
}
function providerId(value: unknown): string {
  const id = text(value)
  if (!/^[a-zA-Z0-9_.-]{1,128}$/.test(id)) return invalid()
  return id
}

export interface MinerUTransportOptions {
  binding: MinerUTransportBinding
  /** Resolved server-side only; never included in request/response records. */
  token?: string
  request?: MinerUHttpRequest
  pollIntervalMs?: number
  timeoutMs?: number
}

export class HttpMinerUTransport implements MinerUOcrTransport {
  readonly binding: MinerUTransportBinding
  private readonly request: MinerUHttpRequest
  constructor(private readonly options: MinerUTransportOptions) {
    this.binding = Object.freeze({ ...options.binding })
    this.request = options.request ?? requestMinerU
  }

  async extract(input: MinerUExtractInput): Promise<MinerUExtractResult> {
    const stop = new AbortController()
    const timeout = setTimeout(() => stop.abort(), this.options.timeoutMs ?? 10 * 60_000)
    timeout.unref()
    const signal = input.signal === undefined ? stop.signal : AbortSignal.any([stop.signal, input.signal])
    try {
      const model = this.binding.model_id
      if (!['flash', 'pipeline', 'vlm'].includes(model)) throw new MinerUTransportError('provider_unavailable')
      if (model !== 'flash' && !this.options.token) throw new MinerUTransportError('provider_unavailable')
      const limit = (model === 'flash' ? 10 : 200) * 1024 * 1024
      if (input.source.content.length === 0 || input.source.content.length > limit) throw new MinerUTransportError('provider_rejected')
      const language = LANGUAGE_ALIASES[input.request.language] ?? input.request.language
      if (!LANGUAGES.has(language)) throw new MinerUTransportError('provider_rejected')
      const pages = input.request.pages
      const pdf = input.source.media_type === 'application/pdf'
      // The upstream page parameter applies to PDFs only. Do not pretend to
      // select arbitrary pages of an image or another unsupported document.
      if (!pdf && (pages.length > 1 || (pages.length === 1 && pages[0] !== 1))) throw new MinerUTransportError('provider_rejected')
      if (model === 'flash' && (pages.length > 20 || pages.some((page, i) => i > 0 && page !== pages[i - 1]! + 1))) {
        throw new MinerUTransportError('provider_rejected')
      }
      const fileName = basename(input.source.file_name.replaceAll('\\', '/'))
      const json = async (path: string, body?: Record<string, unknown>): Promise<Record<string, unknown>> => {
        const url = validateMinerUUrl(`${MINERU_API_ORIGIN}${path}`, true).toString()
        const response = parseJson(await this.request({
          url, method: body === undefined ? 'GET' : 'POST', signal, maxResponseBytes: JSON_LIMIT,
          headers: {
            'content-type': 'application/json',
            ...(model === 'flash' ? {} : { authorization: `Bearer ${this.options.token}` }),
          },
          ...(body === undefined ? {} : { body: Buffer.from(JSON.stringify(body)) }),
        }))
        if (response.code !== 0) throw new MinerUTransportError(response.code === -10001 || response.code === -60007 || response.code === -60009 ? 'provider_unavailable' : 'provider_rejected')
        return record(response.data)
      }
      const submitted = model === 'flash'
        ? await json('/api/v1/agent/parse/file', {
            file_name: fileName, language, is_ocr: true,
            ...(pdf && pages.length > 0 ? { page_range: pages.length === 1 ? String(pages[0]) : `${pages[0]}-${pages.at(-1)}` } : {}),
          })
        : await json('/api/v4/file-urls/batch', {
            model_version: model, language,
            files: [{ name: fileName, data_id: input.request.request_id, is_ocr: true,
              ...(pdf && pages.length > 0 ? { page_ranges: pages.join(',') } : {}) }],
          })
      const id = providerId(model === 'flash' ? submitted.task_id : submitted.batch_id)
      const urls = submitted.file_urls
      if (model !== 'flash' && (!Array.isArray(urls) || urls.length !== 1)) return invalid()
      const uploadUrl = validateMinerUUrl(text(model === 'flash' ? submitted.file_url : (urls as unknown[])[0]), false).toString()
      await this.request({ url: uploadUrl, method: 'PUT', body: input.source.content, signal, maxResponseBytes: JSON_LIMIT })
      while (!signal.aborted) {
        const data = await json(model === 'flash' ? `/api/v1/agent/parse/${id}` : `/api/v4/extract-results/batch/${id}`)
        if (model === 'flash' ? data.task_id !== id : data.batch_id !== id) return invalid()
        let result = data
        if (model !== 'flash') {
          if (!Array.isArray(data.extract_result) || data.extract_result.length !== 1) return invalid()
          result = record(data.extract_result[0])
          if (result.data_id !== input.request.request_id || result.file_name !== fileName) return invalid()
        }
        if (result.state === 'failed') throw new MinerUTransportError('provider_rejected')
        if (result.state === 'done') {
          const url = validateMinerUUrl(text(model === 'flash' ? result.markdown_url : result.full_zip_url), false).toString()
          const bytes = await this.request({ url, method: 'GET', signal, maxResponseBytes: model === 'flash' ? MARKDOWN_LIMIT : ZIP_LIMIT })
          if (model === 'flash') return { markdown: decode(bytes), observations: [] }
          return normalizeMinerUArchive(bytes, input.request)
        }
        if (typeof result.state !== 'string' || !WAITING.has(result.state)) return invalid()
        await sleep(this.options.pollIntervalMs ?? 2000, undefined, { signal })
      }
      throw new MinerUTransportError('provider_unavailable')
    } catch (error) {
      if (stop.signal.aborted && !input.signal?.aborted) throw new MinerUTransportError('provider_unavailable')
      throw error
    } finally {
      clearTimeout(timeout)
      stop.abort()
    }
  }
}

/** Read bounded archive members in memory, never extract to project paths.
 * Only provider-reported span scores become observations. Missing page/score
 * data stays absent; neither Markdown heuristics nor default confidence=1
 * manufacture provenance for Flash or VLM results. */
export function normalizeMinerUArchive(bytes: Buffer, request: OcrRequest): MinerUExtractResult {
  try {
    const scan = scanArchive(bytes, 'mineru.zip', ARCHIVE_LIMITS)
    const markdownFiles = scan.entries.filter(entry => basename(entry.path) === 'full.md')
    const layouts = scan.entries.filter(entry => basename(entry.path) === 'layout.json' || entry.path.endsWith('_middle.json'))
    if (markdownFiles.length !== 1 || markdownFiles[0]!.size_bytes > MARKDOWN_LIMIT || layouts.length > 1) return invalid()
    const wanted = [markdownFiles[0]!.path, ...layouts.map(entry => entry.path)]
    const files = extractArchiveEntries(bytes, 'mineru.zip', wanted, ARCHIVE_LIMITS)
    const markdown = decode(files.get(wanted[0]!)!)
    const observations: OcrNormalizedObservation[] = []
    if (layouts.length > 0) {
      const layout = parseJson(files.get(layouts[0]!.path)!)
      if (!Array.isArray(layout.pdf_info)) return invalid()
      layout.pdf_info.forEach((value, pageIndex) => {
        const info = record(value)
        if (!Number.isInteger(info.page_idx) || (info.page_idx as number) < 0) return invalid()
        const page = (info.page_idx as number) + 1
        if (request.pages.length > 0 && !request.pages.includes(page)) return invalid()
        const visit = (node: unknown, pointer: string, depth: number): void => {
          if (depth > 20 || observations.length >= 100_000) return invalid()
          if (Array.isArray(node)) { node.forEach((item, index) => visit(item, `${pointer}/${index}`, depth + 1)); return }
          if (node === null || typeof node !== 'object') return
          const block = node as Record<string, unknown>
          if (typeof block.content === 'string' && block.content !== '' && typeof block.score === 'number') {
            if (!Number.isFinite(block.score) || block.score < 0 || block.score > 1) return invalid()
            observations.push({ page, locator: `${layouts[0]!.path}#${pointer}`, text: block.content, confidence: block.score })
          }
          for (const key of ['blocks', 'lines', 'spans']) {
            if (block[key] !== undefined) visit(block[key], `${pointer}/${key}`, depth + 1)
          }
        }
        const blockKey = Array.isArray(info.para_blocks) ? 'para_blocks' : 'preproc_blocks'
        visit(info[blockKey], `/pdf_info/${pageIndex}/${blockKey}`, 0)
      })
    }
    return { markdown, observations }
  } catch { return invalid() }
}
