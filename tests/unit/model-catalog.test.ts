import { describe, expect, it } from 'vitest'
import { scholarModelUsability } from '../../packages/dsh-research-ui/src/shared/model-catalog'

describe('Scholar model catalog usability', () => {
  it('keeps unknown capability distinct from an explicit no-text declaration', () => {
    expect(scholarModelUsability({
      id: 'lab/unknown', name: 'Unknown',
    })).toEqual({ text: 'unknown', visual: false, selectable: true })

    expect(scholarModelUsability({
      id: 'lab/none', name: 'None', input_modalities: [],
    })).toEqual({ text: 'unsupported', visual: false, selectable: false })

    expect(scholarModelUsability({
      id: 'lab/image-only', name: 'Image Only', input_modalities: ['image'],
    })).toEqual({ text: 'unsupported', visual: false, selectable: false })

    expect(scholarModelUsability({
      id: 'lab/vision', name: 'Vision', input_modalities: ['text', 'image'],
    })).toEqual({ text: 'supported', visual: true, selectable: true })
  })
})
