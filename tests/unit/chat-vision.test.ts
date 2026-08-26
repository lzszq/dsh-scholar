import { describe, expect, it, vi } from 'vitest'
import {
  ChatVisionInputError,
  ChatVisionTurnStore,
  chatVisionBatch,
  encodeChatVisionImages,
  isChatVisionImage,
} from '../../packages/dsh-research-ui/src/client/chat-vision'

describe('Scholar Chat visual input', () => {
  it('encodes supported browser images as canonical base64 without persisting bytes in Chat state', async () => {
    const bytes = new Uint8Array([0, 1, 2, 253, 254, 255])
    const file = {
      name: 'curve.png',
      type: 'image/png',
      size: bytes.byteLength,
      arrayBuffer: vi.fn(async () => bytes.buffer),
    }

    await expect(encodeChatVisionImages([file])).resolves.toEqual([
      { mediaType: 'image/png', data: 'AAEC/f7/', name: 'curve.png' },
    ])
    expect(file.arrayBuffer).toHaveBeenCalledOnce()
  })

  it('recognizes only the raster media types admitted by DSH and rejects mixed batches before reading bytes', async () => {
    const pdf = { name: 'paper.pdf', type: 'application/pdf', size: 128, arrayBuffer: vi.fn() }
    expect(isChatVisionImage({ type: 'image/jpeg' })).toBe(true)
    expect(isChatVisionImage(pdf)).toBe(false)
    await expect(encodeChatVisionImages([pdf])).rejects.toMatchObject<Partial<ChatVisionInputError>>({
      name: 'ChatVisionInputError', code: 'vision_image_rejected',
    })
    expect(pdf.arrayBuffer).not.toHaveBeenCalled()
  })

  it('keeps exact-session visual inputs across Chat renders until the successful turn consumes them', () => {
    const store = new ChatVisionTurnStore()
    const first = { name: 'curve.png', type: 'image/png', size: 8, arrayBuffer: vi.fn() }
    const second = { name: 'table.jpg', type: 'image/jpeg', size: 8, arrayBuffer: vi.fn() }

    store.stage('project-a', 'session-1', 'file-1', first)
    store.stage('project-a', 'session-1', 'file-2', second)

    // A new render reads the same project/session scope. Upload progress and
    // transcript repainting must not consume the next turn's visual inputs.
    expect(store.list('project-a', 'session-1')).toEqual([
      { fileId: 'file-1', file: first },
      { fileId: 'file-2', file: second },
    ])
    expect(store.list('project-a', 'session-2')).toEqual([])
    expect(store.list('project-b', 'session-1')).toEqual([])

    store.remove('project-a', 'session-1', 'file-1')
    expect(store.list('project-a', 'session-1')).toEqual([{ fileId: 'file-2', file: second }])
    store.consume('project-a', 'session-1', ['file-2'])
    expect(store.list('project-a', 'session-1')).toEqual([])
  })

  it('rejects an oversized or over-count visual queue before reading any browser bytes', async () => {
    const large = {
      name: 'too-large.png', type: 'image/png', size: 16 * 1024 * 1024,
      arrayBuffer: vi.fn(async () => new ArrayBuffer(0)),
    }
    await expect(encodeChatVisionImages([large])).rejects.toMatchObject<Partial<ChatVisionInputError>>({
      name: 'ChatVisionInputError', code: 'payload_too_large',
    })
    expect(large.arrayBuffer).not.toHaveBeenCalled()

    const files = Array.from({ length: 21 }, (_, index) => ({
      name: `${index}.png`, type: 'image/png', size: 1,
      arrayBuffer: vi.fn(async () => new Uint8Array([index]).buffer),
    }))
    await expect(encodeChatVisionImages(files)).rejects.toMatchObject<Partial<ChatVisionInputError>>({
      name: 'ChatVisionInputError', code: 'payload_too_large',
    })
    expect(files.every(file => file.arrayBuffer.mock.calls.length === 0)).toBe(true)
  })

  it('preflights a newly selected visual batch atomically before any item can enter the exact-session queue', () => {
    const store = new ChatVisionTurnStore()
    const files = Array.from({ length: 21 }, (_, index) => ({
      fileId: `file-${index}`,
      file: {
        name: `${index}.png`, type: 'image/png', size: 1,
        arrayBuffer: vi.fn(async () => new Uint8Array([index]).buffer),
      },
    }))

    expect(() => store.stageBatch('project-a', 'session-a', files)).toThrowError(expect.objectContaining({
      name: 'ChatVisionInputError', code: 'payload_too_large',
    }))
    expect(store.list('project-a', 'session-a')).toEqual([])
    expect(files.every(item => item.file.arrayBuffer.mock.calls.length === 0)).toBe(true)
  })

  it('rejects every visual candidate when a supported image is selected with an unsupported image media type', () => {
    const png = { name: 'ok.png', type: 'image/png', size: 1, arrayBuffer: vi.fn() }
    const svg = { name: 'bad.svg', type: 'image/svg+xml', size: 1, arrayBuffer: vi.fn() }
    const pdf = { name: 'paper.pdf', type: 'application/pdf', size: 1, arrayBuffer: vi.fn() }

    expect(() => chatVisionBatch([png, svg, pdf])).toThrowError(expect.objectContaining({
      name: 'ChatVisionInputError', code: 'vision_image_rejected',
    }))
    expect(png.arrayBuffer).not.toHaveBeenCalled()
    expect(svg.arrayBuffer).not.toHaveBeenCalled()
  })

  it('releases every File handle owned by a project when the live project is left', () => {
    const store = new ChatVisionTurnStore()
    const file = { name: 'a.png', type: 'image/png', size: 1, arrayBuffer: vi.fn() }
    store.stage('project-a', 'session-a', 'a', file)
    store.stage('project-a', 'session-b', 'b', file)
    store.stage('project-b', 'session-a', 'c', file)

    expect(new Set(store.projectIds())).toEqual(new Set(['project-a', 'project-b']))

    store.clearProject('project-a')
    expect(store.list('project-a', 'session-a')).toEqual([])
    expect(store.list('project-a', 'session-b')).toEqual([])
    expect(store.list('project-b', 'session-a')).toHaveLength(1)
    expect(store.projectIds()).toEqual(['project-b'])
  })
})
