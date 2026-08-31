/** Atomic Settings resource coordinator (REVIEW-CONFIG-WRITE-03). */
import type { DatabaseSync } from 'node:sqlite'
import {
  SettingsWriteTransactionInput,
  type OcrMineruSettingsOperation,
  type RunnerTargetSettingsOperation,
  type SettingsWriteTransactionReceipt,
} from '@dsh-scholar/research-schemas'
import { ConfigWriteStore, ConfigWriteStoreError } from './config-write-store.js'

export interface SettingsWritePorts {
  /** Must use the coordinator's current SQLite transaction. */
  writeOcr(operation: OcrMineruSettingsOperation, actor: string): unknown
  /** Must use the coordinator's current SQLite transaction. */
  writeRunnerTarget(operation: RunnerTargetSettingsOperation, actor: string): unknown
}

/**
 * One transaction boundary for generated config, MinerU Provider/binding and
 * Runner Target editors. The narrow ports keep resource validation in their
 * existing domain modules while preventing partial multi-resource saves.
 */
export class SettingsWriteCoordinator {
  constructor(
    private readonly db: DatabaseSync,
    private readonly config: ConfigWriteStore,
    private readonly ports: SettingsWritePorts,
  ) {}

  execute(raw: unknown, actor: string): SettingsWriteTransactionReceipt {
    if (actor.trim() === '') {
      throw new ConfigWriteStoreError(403, 'config_actor_required', 'Settings write requires an authenticated principal')
    }
    const input = SettingsWriteTransactionInput.parse(raw)
    const configOperations = input.operations.filter(operation => operation.kind === 'config')
    const ownsTransaction = !this.db.isTransaction
    if (ownsTransaction) this.db.exec('BEGIN IMMEDIATE')
    try {
      const configReceipt = configOperations.length === 0
        ? null
        : this.config.transact({ operations: configOperations }, actor)
      const operations: SettingsWriteTransactionReceipt['operations'] = []
      for (const [index, operation] of input.operations.entries()) {
        if (operation.kind === 'config') {
          const resource = configReceipt?.layers.find(layer =>
            layer.scope === operation.scope && layer.scope_id === operation.scope_id) ?? null
          operations.push({ index, kind: operation.kind, resource })
        } else if (operation.kind === 'ocr-mineru') {
          operations.push({ index, kind: operation.kind, resource: this.ports.writeOcr(operation, actor) })
        } else {
          operations.push({ index, kind: operation.kind, resource: this.ports.writeRunnerTarget(operation, actor) })
        }
      }
      if (ownsTransaction) this.db.exec('COMMIT')
      return { config: configReceipt, operations }
    } catch (error) {
      if (ownsTransaction && this.db.isTransaction) this.db.exec('ROLLBACK')
      throw error
    }
  }
}
