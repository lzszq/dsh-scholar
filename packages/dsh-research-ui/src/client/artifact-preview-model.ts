import type { ArtifactRow } from './types'

export const ARTIFACT_TEXT_MAX_BYTES = 1024 * 1024
export const ARTIFACT_TEXT_MAX_CHARS = 100_000
export const ARTIFACT_JSON_MAX_FORMAT_DEPTH = 64
export const ARTIFACT_TABLE_MAX_ROWS = 100
export const ARTIFACT_TABLE_MAX_COLUMNS = 50
export const ARTIFACT_MARKDOWN_MAX_BLOCKS = 2_000
export const ARTIFACT_MARKDOWN_MAX_LIST_ITEMS = 2_000

export type ArtifactPreviewMode =
  | 'pdf'
  | 'image'
  | 'audio'
  | 'video'
  | 'markdown'
  | 'json'
  | 'table'
  | 'text'
  | 'download'

export type ArtifactDownloadReason = 'active' | 'office' | 'archive' | 'model' | 'scientific' | 'binary'

export interface ArtifactPreviewPlan {
  mode: ArtifactPreviewMode
  format: string
  mediaType: string
  extension: string
  readsText: boolean
  opensInTab: boolean
  downloadReason?: ArtifactDownloadReason
  delimiter?: ',' | '\t'
  ndjson?: boolean
}

const RASTER_MEDIA = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/avif', 'image/bmp'])
const AUDIO_MEDIA = new Set(['audio/mpeg', 'audio/wav', 'audio/x-wav', 'audio/ogg', 'audio/webm', 'audio/mp4', 'audio/flac', 'audio/aac', 'audio/opus'])
const VIDEO_MEDIA = new Set(['video/mp4', 'video/webm', 'video/ogg', 'video/quicktime'])
const ACTIVE_MEDIA = new Set(['text/html', 'application/xhtml+xml', 'image/svg+xml', 'application/xml', 'text/xml'])
const OFFICE_MEDIA = new Set([
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-powerpoint',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'application/vnd.oasis.opendocument.text',
  'application/vnd.oasis.opendocument.spreadsheet',
  'application/vnd.oasis.opendocument.presentation',
  'application/rtf',
])
const ARCHIVE_MEDIA = new Set([
  'application/zip', 'application/x-zip-compressed', 'application/x-tar',
  'application/gzip', 'application/x-gzip', 'application/x-7z-compressed',
  'application/vnd.rar', 'application/x-rar-compressed', 'application/x-bzip2',
  'application/x-xz', 'application/zstd',
])
const SCIENTIFIC_MEDIA = new Set([
  'application/vnd.apache.parquet', 'application/vnd.apache.arrow.file',
  'application/x-hdf5', 'application/x-netcdf', 'application/fits', 'image/fits',
])

const ACTIVE_EXTENSIONS = new Set(['html', 'htm', 'xhtml', 'svg', 'xml', 'xsl', 'xslt'])
const OFFICE_EXTENSIONS = new Set(['doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'odt', 'ods', 'odp', 'rtf'])
const ARCHIVE_EXTENSIONS = new Set(['zip', 'tar', 'gz', 'tgz', 'bz2', 'xz', '7z', 'rar', 'zst'])
const MODEL_EXTENSIONS = new Set(['pkl', 'pickle', 'pt', 'pth', 'onnx', 'safetensors', 'ckpt', 'joblib'])
const SCIENTIFIC_EXTENSIONS = new Set(['parquet', 'arrow', 'feather', 'fits', 'fit', 'fts', 'h5', 'hdf5', 'nc', 'cdf', 'npy', 'npz', 'mat'])
const RASTER_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'bmp'])
const AUDIO_EXTENSIONS = new Set(['mp3', 'wav', 'oga', 'ogg', 'flac', 'aac', 'm4a', 'opus'])
const VIDEO_EXTENSIONS = new Set(['mp4', 'webm', 'ogv', 'mov', 'm4v'])
const MARKDOWN_EXTENSIONS = new Set(['md', 'markdown', 'mdown', 'mkd', 'rmd', 'qmd'])
const JSON_EXTENSIONS = new Set(['json', 'jsonl', 'ndjson', 'ipynb', 'geojson'])
const TEXT_EXTENSIONS = new Set([
  'txt', 'log', 'tex', 'bib', 'sty', 'cls', 'yaml', 'yml', 'toml', 'ini', 'cfg', 'conf',
  'py', 'js', 'mjs', 'cjs', 'ts', 'tsx', 'jsx', 'c', 'cc', 'cpp', 'h', 'hpp', 'rs', 'go',
  'java', 'kt', 'swift', 'sh', 'bash', 'zsh', 'fish', 'ps1', 'sql', 'css', 'scss', 'less',
  'r', 'rb', 'php', 'lua', 'scala', 'ex', 'exs', 'erl', 'hrl', 'jl', 'm', 'rst', 'srt',
  'vtt', 'diff', 'patch', 'dockerfile', 'gitignore',
])

export function artifactMediaEssence(value: string | null | undefined): string {
  return value?.split(';', 1)[0]?.trim().toLowerCase() ?? ''
}

export function artifactFileExtension(fileName: string | null | undefined): string {
  const base = fileName?.replaceAll('\\', '/').split('/').pop()?.trim().toLowerCase() ?? ''
  if (base === 'dockerfile') return 'dockerfile'
  if (base === '.gitignore') return 'gitignore'
  const dot = base.lastIndexOf('.')
  return dot > 0 && dot < base.length - 1 ? base.slice(dot + 1) : ''
}

function downloadPlan(mediaType: string, extension: string, format: string, reason: ArtifactDownloadReason): ArtifactPreviewPlan {
  return { mode: 'download', format, mediaType, extension, readsText: false, opensInTab: false, downloadReason: reason }
}

function extensionPlan(extension: string, mediaType: string, kind: string): ArtifactPreviewPlan | null {
  if (extension === 'pdf') return { mode: 'pdf', format: 'PDF', mediaType, extension, readsText: false, opensInTab: true }
  if (RASTER_EXTENSIONS.has(extension)) return { mode: 'image', format: extension.toUpperCase(), mediaType, extension, readsText: false, opensInTab: true }
  if (AUDIO_EXTENSIONS.has(extension)) return { mode: 'audio', format: extension.toUpperCase(), mediaType, extension, readsText: false, opensInTab: true }
  if (VIDEO_EXTENSIONS.has(extension)) return { mode: 'video', format: extension.toUpperCase(), mediaType, extension, readsText: false, opensInTab: true }
  if (MARKDOWN_EXTENSIONS.has(extension)) return { mode: 'markdown', format: 'Markdown', mediaType, extension, readsText: true, opensInTab: false }
  if (JSON_EXTENSIONS.has(extension)) {
    const ndjson = extension === 'jsonl' || extension === 'ndjson'
    return { mode: 'json', format: ndjson ? 'NDJSON' : (extension === 'ipynb' ? 'Jupyter Notebook' : 'JSON'), mediaType, extension, readsText: true, opensInTab: false, ndjson }
  }
  if (extension === 'csv' || extension === 'tsv') return { mode: 'table', format: extension.toUpperCase(), mediaType, extension, readsText: true, opensInTab: false, delimiter: extension === 'tsv' ? '\t' : ',' }
  if (extension === '' && ['manifest', 'analysis'].includes(kind)) {
    return { mode: 'json', format: 'JSON', mediaType, extension, readsText: true, opensInTab: false, ndjson: false }
  }
  if (extension === '' && kind === 'paper') {
    return { mode: 'markdown', format: 'Markdown', mediaType, extension, readsText: true, opensInTab: false }
  }
  if (TEXT_EXTENSIONS.has(extension) || ['code', 'log', 'compile-log', 'tex-source', 'bib'].includes(kind)) {
    return { mode: 'text', format: extension === '' ? (kind || 'Text') : extension.toUpperCase(), mediaType, extension, readsText: true, opensInTab: false }
  }
  return null
}

/**
 * Resolve a conservative preview mode. Active/binary extensions always win
 * over a conflicting MIME type; extension/kind promotion is allowed only
 * when the server supplied no type or application/octet-stream.
 */
export function artifactPreviewPlan(artifact: ArtifactRow, servedContentType?: string | null): ArtifactPreviewPlan {
  const servedMediaType = artifactMediaEssence(servedContentType)
  const registeredMediaType = artifactMediaEssence(artifact.media_type)
  // An empty response header is equivalent to a missing one. Keep the
  // registered MIME as a second safety signal even when a proxy supplies a
  // different response type: active/binary metadata must never be promoted
  // into a text or native renderer by a weaker served type.
  const mediaType = servedMediaType === '' ? registeredMediaType : servedMediaType
  const extension = artifactFileExtension(artifact.file_name)
  const kind = artifact.kind?.toLowerCase() ?? ''
  const jsonReleaseBundle = kind === 'bundle' && artifact.metadata?.kind === 'release-bundle'
    && ['', 'application/octet-stream', 'application/json'].includes(mediaType)

  if (ACTIVE_EXTENSIONS.has(extension) || ACTIVE_MEDIA.has(mediaType) || ACTIVE_MEDIA.has(registeredMediaType)) return downloadPlan(mediaType, extension, extension === 'svg' || mediaType === 'image/svg+xml' || registeredMediaType === 'image/svg+xml' ? 'SVG' : 'HTML/XML', 'active')
  if (OFFICE_EXTENSIONS.has(extension) || OFFICE_MEDIA.has(mediaType) || OFFICE_MEDIA.has(registeredMediaType)) return downloadPlan(mediaType, extension, 'Office/ODF', 'office')
  if (ARCHIVE_EXTENSIONS.has(extension) || ARCHIVE_MEDIA.has(mediaType) || ARCHIVE_MEDIA.has(registeredMediaType) || (kind === 'bundle' && !jsonReleaseBundle)) return downloadPlan(mediaType, extension, 'Archive', 'archive')
  if (MODEL_EXTENSIONS.has(extension) || kind === 'model') return downloadPlan(mediaType, extension, 'Model', 'model')
  if (SCIENTIFIC_EXTENSIONS.has(extension) || SCIENTIFIC_MEDIA.has(mediaType) || SCIENTIFIC_MEDIA.has(registeredMediaType)) return downloadPlan(mediaType, extension, 'Scientific data', 'scientific')

  if (mediaType === 'application/pdf') return { mode: 'pdf', format: 'PDF', mediaType, extension, readsText: false, opensInTab: true }
  if (RASTER_MEDIA.has(mediaType)) return { mode: 'image', format: mediaType.slice('image/'.length).toUpperCase(), mediaType, extension, readsText: false, opensInTab: true }
  if (AUDIO_MEDIA.has(mediaType)) return { mode: 'audio', format: mediaType.slice('audio/'.length).toUpperCase(), mediaType, extension, readsText: false, opensInTab: true }
  if (VIDEO_MEDIA.has(mediaType)) return { mode: 'video', format: mediaType.slice('video/'.length).toUpperCase(), mediaType, extension, readsText: false, opensInTab: true }
  if (mediaType === 'text/markdown' || mediaType === 'text/x-markdown') return { mode: 'markdown', format: 'Markdown', mediaType, extension, readsText: true, opensInTab: false }
  if (mediaType === 'application/x-ndjson' || mediaType === 'application/jsonl') return { mode: 'json', format: 'NDJSON', mediaType, extension, readsText: true, opensInTab: false, ndjson: true }
  if (mediaType === 'application/json' && (extension === 'jsonl' || extension === 'ndjson')) return { mode: 'json', format: 'NDJSON', mediaType, extension, readsText: true, opensInTab: false, ndjson: true }
  if (mediaType === 'application/json' || mediaType.endsWith('+json')) return { mode: 'json', format: 'JSON', mediaType, extension, readsText: true, opensInTab: false, ndjson: false }
  if (mediaType === 'text/csv' || mediaType === 'text/tab-separated-values') return { mode: 'table', format: mediaType === 'text/csv' ? 'CSV' : 'TSV', mediaType, extension, readsText: true, opensInTab: false, delimiter: mediaType === 'text/csv' ? ',' : '\t' }
  if (mediaType === 'text/plain') {
    const inferred = extensionPlan(extension, mediaType, kind)
    if (inferred !== null && ['markdown', 'json', 'table', 'text'].includes(inferred.mode)) return inferred
  }
  if (mediaType.startsWith('text/') || ['application/yaml', 'application/x-yaml', 'application/toml', 'application/sql'].includes(mediaType)) {
    return { mode: 'text', format: extension === '' ? 'Text' : extension.toUpperCase(), mediaType, extension, readsText: true, opensInTab: false }
  }

  if (mediaType === '' || mediaType === 'application/octet-stream') {
    if ((artifact.kind === 'analysis' && artifact.metadata?.generated_by === 'research-kernel.computeAnalysis')
      || (artifact.kind === 'bundle' && artifact.metadata?.kind === 'release-bundle')) {
      return { mode: 'json', format: 'JSON', mediaType, extension, readsText: true, opensInTab: false, ndjson: false }
    }
    const inferred = extensionPlan(extension, mediaType, kind)
    if (inferred !== null) return inferred
  }
  return downloadPlan(mediaType, extension, 'Binary', 'binary')
}

export interface ArtifactTextPreview {
  text: string
  truncated: boolean
  tooLarge: boolean
  binary: boolean
}

export async function readArtifactTextPreview(source: { size: number; text: () => Promise<string> }): Promise<ArtifactTextPreview> {
  if (source.size > ARTIFACT_TEXT_MAX_BYTES) return { text: '', truncated: true, tooLarge: true, binary: false }
  const raw = await source.text()
  if (raw.slice(0, 8192).includes('\0')) return { text: '', truncated: false, tooLarge: false, binary: true }
  const truncated = raw.length > ARTIFACT_TEXT_MAX_CHARS
  return { text: truncated ? raw.slice(0, ARTIFACT_TEXT_MAX_CHARS) : raw, truncated, tooLarge: false, binary: false }
}

interface ArtifactByteStreamReader {
  read: () => Promise<{ done: boolean; value?: Uint8Array }>
  cancel: (reason?: unknown) => Promise<void>
  releaseLock?: () => void
}

interface ArtifactByteStream {
  getReader: () => ArtifactByteStreamReader
}

/**
 * Read an HTTP text body with a hard byte budget even when Content-Length is
 * missing or false. The reader is cancelled as soon as the next chunk would
 * exceed the preview limit; callers can then offer a fresh authenticated
 * download without retaining the oversized body in memory.
 */
export async function readArtifactTextStream(
  source: ArtifactByteStream | null,
  signal?: AbortSignal,
): Promise<ArtifactTextPreview> {
  if (source === null) return { text: '', truncated: false, tooLarge: false, binary: false }
  const reader = source.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  let aborted = signal?.aborted === true
  const cancelForAbort = (): void => {
    aborted = true
    void reader.cancel('artifact preview aborted').catch(() => {})
  }
  signal?.addEventListener('abort', cancelForAbort, { once: true })
  try {
    if (aborted) throw new Error('artifact preview aborted')
    while (true) {
      const { done, value } = await reader.read()
      if (aborted) throw new Error('artifact preview aborted')
      if (done) break
      if (value === undefined || value.byteLength === 0) continue
      if (size + value.byteLength > ARTIFACT_TEXT_MAX_BYTES) {
        await reader.cancel('artifact preview byte limit exceeded').catch(() => {})
        return { text: '', truncated: true, tooLarge: true, binary: false }
      }
      chunks.push(value)
      size += value.byteLength
    }
  } finally {
    signal?.removeEventListener('abort', cancelForAbort)
    reader.releaseLock?.()
  }
  const bytes = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  const raw = new TextDecoder().decode(bytes)
  if (raw.slice(0, 8192).includes('\0')) return { text: '', truncated: false, tooLarge: false, binary: true }
  const truncated = raw.length > ARTIFACT_TEXT_MAX_CHARS
  return { text: truncated ? raw.slice(0, ARTIFACT_TEXT_MAX_CHARS) : raw, truncated, tooLarge: false, binary: false }
}

function jsonLexemes(text: string): string[] {
  const tokens: string[] = []
  for (let index = 0; index < text.length;) {
    const char = text[index]!
    if (/\s/.test(char)) { index += 1; continue }
    if ('{}[],:'.includes(char)) { tokens.push(char); index += 1; continue }
    if (char === '"') {
      const start = index
      index += 1
      let escaped = false
      while (index < text.length) {
        const current = text[index]!
        index += 1
        if (escaped) { escaped = false; continue }
        if (current === '\\') { escaped = true; continue }
        if (current === '"') break
      }
      tokens.push(text.slice(start, index))
      continue
    }
    const start = index
    while (index < text.length && !/[\s{}\[\],:]/.test(text[index]!)) index += 1
    tokens.push(text.slice(start, index))
  }
  return tokens
}

/** Pretty-print validated JSON without round-tripping number/key lexemes. */
function formatJsonLexically(text: string): string | null {
  const tokens = jsonLexemes(text)
  let depth = 0
  let output = ''
  const indent = (): string => '  '.repeat(depth)
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index]!
    if (token === '{' || token === '[') {
      output += token
      depth += 1
      if (depth > ARTIFACT_JSON_MAX_FORMAT_DEPTH) return null
      if (tokens[index + 1] !== (token === '{' ? '}' : ']')) output += `\n${indent()}`
    } else if (token === '}' || token === ']') {
      depth = Math.max(0, depth - 1)
      if (tokens[index - 1] !== (token === '}' ? '{' : '[')) output += `\n${indent()}`
      output += token
    } else if (token === ',') {
      output += `,\n${indent()}`
    } else if (token === ':') {
      output += ': '
    } else {
      output += token
    }
    if (output.length > ARTIFACT_TEXT_MAX_CHARS) return null
  }
  return output
}

export function formatJsonPreview(text: string, ndjson = false): { text: string; valid: boolean } {
  try {
    if (!ndjson) {
      JSON.parse(text)
      return { text: formatJsonLexically(text) ?? text, valid: true }
    }
    const lines = text.split(/\r?\n/).map(line => line.trim()).filter(line => line !== '')
    for (const line of lines) JSON.parse(line)
    const formatted = lines.map(line => formatJsonLexically(line) ?? line).join('\n')
    return { text: formatted.length > ARTIFACT_TEXT_MAX_CHARS ? text : formatted, valid: true }
  } catch {
    return { text, valid: false }
  }
}

export interface ArtifactTablePreview {
  rows: string[][]
  truncated: boolean
}

/** Bounded RFC4180-style parser. Cells remain inert strings (including formulas). */
export function parseDelimitedPreview(text: string, delimiter: ',' | '\t'): ArtifactTablePreview {
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let quoted = false
  let truncated = false
  const pushField = (): void => {
    if (row.length < ARTIFACT_TABLE_MAX_COLUMNS) row.push(field)
    else truncated = true
    field = ''
  }
  const pushRow = (): boolean => {
    pushField()
    if (rows.length < ARTIFACT_TABLE_MAX_ROWS) rows.push(row)
    else truncated = true
    row = []
    return rows.length >= ARTIFACT_TABLE_MAX_ROWS
  }
  for (let i = 0; i < text.length; i++) {
    const char = text[i]!
    if (quoted) {
      if (char === '"' && text[i + 1] === '"') { field += '"'; i += 1 }
      else if (char === '"') quoted = false
      else field += char
      continue
    }
    if (char === '"' && field === '') { quoted = true; continue }
    if (char === delimiter) { pushField(); continue }
    if (char === '\n') { if (pushRow()) { if (i < text.length - 1) truncated = true; break }; continue }
    if (char === '\r' && text[i + 1] === '\n') continue
    field += char
  }
  if (row.length > 0 || field !== '') pushRow()
  return { rows, truncated }
}

export type ArtifactMarkdownBlock =
  | { kind: 'heading'; level: 1 | 2 | 3; text: string }
  | { kind: 'paragraph'; text: string }
  | { kind: 'quote'; text: string }
  | { kind: 'list'; ordered: boolean; items: string[] }
  | { kind: 'code'; language: string; text: string }
  | { kind: 'table'; headers: string[]; rows: string[][] }

function splitMarkdownTableRow(line: string): { cells: string[]; truncated: boolean } {
  const cells = line.trim().replace(/^\||\|$/g, '').split('|').map(cell => cell.trim())
  return { cells: cells.slice(0, ARTIFACT_TABLE_MAX_COLUMNS), truncated: cells.length > ARTIFACT_TABLE_MAX_COLUMNS }
}

/** Small, allowlisted Markdown block parser. Raw HTML is always inert text. */
export function parseArtifactMarkdown(text: string): { blocks: ArtifactMarkdownBlock[]; truncated: boolean } {
  const lines = text.split(/\r?\n/)
  const blocks: ArtifactMarkdownBlock[] = []
  let truncated = false
  let listItemCount = 0
  const add = (block: ArtifactMarkdownBlock): boolean => {
    if (blocks.length >= ARTIFACT_MARKDOWN_MAX_BLOCKS) { truncated = true; return false }
    blocks.push(block)
    return true
  }
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? ''
    if (line.trim() === '') continue
    const fence = /^```([^\s`]*)\s*$/.exec(line)
    if (fence !== null) {
      const code: string[] = []
      i += 1
      while (i < lines.length && !/^```\s*$/.test(lines[i] ?? '')) { code.push(lines[i] ?? ''); i += 1 }
      if (!add({ kind: 'code', language: fence[1] ?? '', text: code.join('\n') })) break
      continue
    }
    const heading = /^(#{1,3})\s+(.+)$/.exec(line)
    if (heading !== null) {
      if (!add({ kind: 'heading', level: heading[1]!.length as 1 | 2 | 3, text: heading[2]! })) break
      continue
    }
    if (line.startsWith('> ')) { if (!add({ kind: 'quote', text: line.slice(2) })) break; continue }
    const list = /^\s*(?:(\d+)[.)]|[-*+])\s+(.+)$/.exec(line)
    if (list !== null) {
      const ordered = list[1] !== undefined
      const items: string[] = []
      const pushItem = (item: string): void => {
        if (listItemCount < ARTIFACT_MARKDOWN_MAX_LIST_ITEMS) {
          items.push(item)
          listItemCount += 1
        } else truncated = true
      }
      pushItem(list[2]!)
      while (i + 1 < lines.length) {
        const next = /^\s*(?:(\d+)[.)]|[-*+])\s+(.+)$/.exec(lines[i + 1] ?? '')
        if (next === null || (next[1] !== undefined) !== ordered) break
        i += 1
        pushItem(next[2]!)
      }
      if (items.length > 0 && !add({ kind: 'list', ordered, items })) break
      continue
    }
    const separator = lines[i + 1]
    if (line.includes('|') && separator !== undefined && /^\s*\|?\s*:?-{3,}/.test(separator)) {
      const header = splitMarkdownTableRow(line)
      if (header.truncated) truncated = true
      const rows: string[][] = []
      i += 1
      while (i + 1 < lines.length && (lines[i + 1] ?? '').includes('|')) {
        const parsed = splitMarkdownTableRow(lines[i + 1] ?? '')
        if (rows.length < ARTIFACT_TABLE_MAX_ROWS) rows.push(parsed.cells)
        else truncated = true
        if (parsed.truncated) truncated = true
        i += 1
      }
      if (!add({ kind: 'table', headers: header.cells, rows })) break
      continue
    }
    if (!add({ kind: 'paragraph', text: line })) break
  }
  return { blocks, truncated }
}
