export interface GateDraft { reason: string; open: boolean }
interface DraftStorage { getItem(key: string): string | null; setItem(key: string, value: string): void; removeItem(key: string): void }

/** Drafts belong to a project and gate, independently of any rendered input. */
export class GateDraftStore {
  private readonly drafts = new Map<string, GateDraft>()
  constructor(private readonly storage?: DraftStorage) {}
  private key(projectId: string, gateId: string): string {
    return 'dsh-scholar-gate-draft:' + JSON.stringify([projectId, gateId])
  }
  get(projectId: string, gateId: string): GateDraft {
    const key = this.key(projectId, gateId)
    const cached = this.drafts.get(key)
    if (cached !== undefined) return { ...cached }
    try {
      const raw = this.storage?.getItem(key)
      const saved = raw == null ? null : JSON.parse(raw) as Partial<GateDraft>
      if (saved !== null && typeof saved.reason === 'string' && typeof saved.open === 'boolean') {
        const draft = { reason: saved.reason.slice(0, 200), open: saved.open }
        this.drafts.set(key, draft)
        return { ...draft }
      }
    } catch { /* Storage is optional; an unavailable store must not lose live input. */ }
    return { reason: '', open: false }
  }
  update(projectId: string, gateId: string, change: Partial<GateDraft>): GateDraft {
    const key = this.key(projectId, gateId)
    const draft = { ...this.get(projectId, gateId), ...change }
    draft.reason = draft.reason.slice(0, 200)
    this.drafts.set(key, draft)
    try { this.storage?.setItem(key, JSON.stringify(draft)) } catch { /* Keep the in-memory copy. */ }
    return { ...draft }
  }
  clear(projectId: string, gateId: string): void {
    const key = this.key(projectId, gateId)
    this.drafts.set(key, { reason: '', open: false })
    try { this.storage?.removeItem(key) } catch { /* Unavailable session storage. */ }
  }
}

export const gateDrafts = new GateDraftStore({
  getItem: key => sessionStorage.getItem(key),
  setItem: (key, value) => sessionStorage.setItem(key, value),
  removeItem: key => sessionStorage.removeItem(key),
})
