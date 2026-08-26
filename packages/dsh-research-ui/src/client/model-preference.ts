/**
 * Acknowledgement barrier for the persisted Scholar model seat.
 *
 * Selection writes are serialized and the chat composer may only cross the
 * barrier after the latest write has succeeded. A failed write leaves the
 * last server-acknowledged value intact so the selector can roll back instead
 * of showing a model that the DSH-side agent will not use.
 */
export class ModelPreferenceCommit {
  private acknowledgedValue: string
  private pending: Promise<boolean> = Promise.resolve(true)
  private selectionStarted = false
  private pendingWrites = 0

  constructor(initial = '') {
    this.acknowledgedValue = initial
  }

  /** Apply the initial server read only while no user write has started. */
  initialize(value: string): boolean {
    if (this.selectionStarted) return false
    this.acknowledgedValue = value
    this.pending = Promise.resolve(true)
    return true
  }

  acknowledged(): string {
    return this.acknowledgedValue
  }

  busy(): boolean {
    return this.pendingWrites > 0
  }

  select(value: string, persist: (value: string) => Promise<boolean>): Promise<boolean> {
    this.selectionStarted = true
    this.pendingWrites += 1
    const predecessor = this.pending.catch(() => false)
    const committed = predecessor
      .then(() => persist(value))
      .then(ok => {
        if (ok) this.acknowledgedValue = value
        return ok
      })
      .catch(() => false)
    this.pending = committed
    return committed.finally(() => { this.pendingWrites -= 1 })
  }

  barrier(): Promise<boolean> {
    return this.pending
  }
}
