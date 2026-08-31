import { describe, expect, it } from 'vitest'
import { admitChatAttachmentFiles, hashChatAttachmentFile } from '../../packages/dsh-research-ui/src/client/chat-attachments'
import { ChatUploadStore } from '../../packages/dsh-research-ui/src/client/chat-upload-store'
import { ChatVisionTurnStore } from '../../packages/dsh-research-ui/src/client/chat-vision'

function imageFile(name: string, type = 'image/png') {
  let reads = 0
  const bytes = new Uint8Array([1, 2, 3])
  return {
    name,
    type,
    size: bytes.byteLength,
    arrayBuffer: async () => { reads += 1; return bytes.buffer },
    slice(start = 0, end = bytes.byteLength) {
      return { arrayBuffer: async () => bytes.slice(start, end).buffer }
    },
    reads: () => reads,
  }
}

describe('Chat attachment admission', () => {
  it('maps whole-file read failures to upload_hash_failed without preserving raw prose', async () => {
    const file = {
      name: 'broken.pdf', type: 'application/pdf', size: 1,
      slice: () => ({ arrayBuffer: async () => { throw new Error('raw local path or browser prose') } }),
    }

    await expect(hashChatAttachmentFile(file)).rejects.toMatchObject({
      failure: { code: 'upload_hash_failed' }, message: 'upload_hash_failed',
    })
  })

  it('stages visual context synchronously and without reading bytes or waiting for Intake I/O', () => {
    const uploads = new ChatUploadStore(null)
    const vision = new ChatVisionTurnStore()
    const file = imageFile('figure.png')

    const result = admitChatAttachmentFiles('project-a', 'session-a', [file], { uploads, vision })

    expect(result.visionError).toBeNull()
    expect(result.items).toHaveLength(1)
    expect(vision.list('project-a', 'session-a')).toHaveLength(1)
    expect(file.reads()).toBe(0)
  })

  it('keeps research uploads while rejecting an unsupported visual batch atomically', () => {
    const uploads = new ChatUploadStore(null)
    const vision = new ChatVisionTurnStore()
    const png = imageFile('ok.png')
    const svg = imageFile('unsafe.svg', 'image/svg+xml')

    const result = admitChatAttachmentFiles('project-a', 'session-a', [png, svg], { uploads, vision })

    expect(result.visionError?.code).toBe('vision_image_rejected')
    expect(result.items).toHaveLength(2)
    expect(vision.list('project-a', 'session-a')).toEqual([])
    expect(png.reads()).toBe(0)
    expect(svg.reads()).toBe(0)
  })

  it('cannot recreate a closed exact-session upload or visual scope', () => {
    const uploads = new ChatUploadStore(null)
    const vision = new ChatVisionTurnStore()
    uploads.clear('project-a', 'session-a')

    const result = admitChatAttachmentFiles('project-a', 'session-a', [imageFile('late.png')], { uploads, vision })

    expect(result.items).toEqual([])
    expect(vision.list('project-a', 'session-a')).toEqual([])
  })
})
