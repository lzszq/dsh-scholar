export interface ScholarModelCatalogEntry {
  id: string
  name: string
  input_modalities?: readonly ('text' | 'image')[]
  available?: boolean
}

export interface ScholarModelUsability {
  text: 'supported' | 'unsupported' | 'unknown'
  visual: boolean
  selectable: boolean
}

/** Interpret DSH selector metadata without inventing capabilities.
 * Missing modalities are unknown; an explicit array is authoritative, so an
 * empty or image-only array cannot carry Scholar's mandatory text prompt. */
export function scholarModelUsability(model: ScholarModelCatalogEntry): ScholarModelUsability {
  const modalities = model.input_modalities
  const text = modalities === undefined
    ? 'unknown'
    : modalities.includes('text') ? 'supported' : 'unsupported'
  return {
    text,
    visual: text === 'supported' && modalities?.includes('image') === true,
    selectable: model.available !== false && text !== 'unsupported',
  }
}
