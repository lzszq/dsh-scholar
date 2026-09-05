/**
 * RUN-REMOTE-01 — RemoteAgent 本地有界 spool（execution-runtime.md §5.1、
 * docs/remote-runner-wire.md §5.3）。
 *
 * 网络断开时代理端把 frames/artifact stage/finalize/complete 保存到有界 spool，
 * 恢复后按序重放。有界语义：
 *
 * - 只允许淘汰 `frames` 条目（chunk 数据可被 gap 替代，kernel 语义允许）；
 * - `exit_frame`/`artifact_*`/`complete` 条目不可淘汰（exit frame 必须在任务
 *   终态之前持久化——execution-runtime.md §6）——spool 满时 push 被拒绝，调用方必须
 *   把该 run 标记为本地失败（fail closed，不静默丢弃）；
 * - 淘汰 frames 条目时记录该 run 的 overflow 区间（fromSeq/toSeq/droppedBytes），
 *   重放前先发 gap frame（frame_kind='gap'，seq=fromSeq，payload 带 dropped
 *   区间与字节数）——kernel 的 retention 记账因此可见，不静默降级；
 * - maxEntries / maxBytes 双上限（默认 256 条 / 4 MiB）。
 * @module @dsh-scholar/runner-gateway/agent-spool
 */

import { randomUUID } from 'node:crypto'

/** spool 条目类型：frames 可淘汰；exit_frame/artifact_* / complete 不可淘汰。 */
export type AgentSpoolEntryKind = 'frames' | 'exit_frame' | 'artifact_stage' | 'artifact_finalize' | 'complete'

export interface AgentSpoolEntry<T = unknown> {
  id: string
  kind: AgentSpoolEntryKind
  agentId: string
  runId: string
  payload: T
  /** frames 条目的全局 seq 区间（gap 定位用；非 frames 条目为 0）。 */
  minSeq: number
  maxSeq: number
  byteSize: number
}

/** 淘汰 frames 时记录的 overflow 区间（重放前以 gap frame 上报）。 */
export interface AgentSpoolOverflowGap {
  runId: string
  fromSeq: number
  toSeq: number
  droppedBytes: number
}

export interface AgentSpoolOptions {
  maxEntries?: number
  maxBytes?: number
}

export interface AgentSpoolPushResult {
  accepted: boolean
  /** 拒绝原因（仅 accepted=false）。 */
  reason?: 'spool_overflow'
  /** 本次 push 触发的 frames 淘汰（重放前需先发 gap）。 */
  evicted: AgentSpoolOverflowGap[]
}

export interface AgentSpoolDrainResult {
  replayed: number
  remaining: number
  /** 传输再次失败（顺序保留，下次重试）。 */
  failed: boolean
}

/**
 * 有界 outbound spool：push 先尝试经 dispatch 直发；失败（传输不可达等
 * retryable 错误）入队；flush 按序重放。overflow 记录供 gap frame 合成。
 */
export class AgentOutboundSpool {
  private readonly entries: AgentSpoolEntry[] = []
  private readonly maxEntries: number
  private readonly maxBytes: number
  private bytes = 0
  /** runId → 待上报的 overflow 区间（按淘汰顺序累积合并）。 */
  private readonly overflowGaps = new Map<string, AgentSpoolOverflowGap>()

  constructor(options: AgentSpoolOptions = {}) {
    this.maxEntries = options.maxEntries ?? 256
    this.maxBytes = options.maxBytes ?? 4 * 1024 * 1024
  }

  get size(): number {
    return this.entries.length
  }

  get totalBytes(): number {
    return this.bytes
  }

  /** 淘汰最旧 frames 条目直到同时满足字节与条数目标；返回是否达成。 */
  private evictFrames(targetBytes: number, targetEntries: number): boolean {
    let freed = 0
    let removed = 0
    const victims: AgentSpoolEntry[] = []
    for (let i = 0; i < this.entries.length && (freed < targetBytes || removed < targetEntries); i++) {
      const entry = this.entries[i]
      if (entry === undefined || entry.kind !== 'frames') continue // exit_frame/artifact/complete 不可淘汰
      freed += entry.byteSize
      removed += 1
      victims.push(entry)
    }
    for (const victim of victims) {
      const index = this.entries.indexOf(victim)
      if (index >= 0) this.entries.splice(index, 1)
      this.bytes -= victim.byteSize
      // 累积 overflow 区间：同一 run 相邻淘汰合并区间。
      const existing = this.overflowGaps.get(victim.runId)
      if (existing === undefined) {
        this.overflowGaps.set(victim.runId, {
          runId: victim.runId, fromSeq: victim.minSeq, toSeq: victim.maxSeq, droppedBytes: victim.byteSize,
        })
      } else {
        existing.fromSeq = Math.min(existing.fromSeq, victim.minSeq)
        existing.toSeq = Math.max(existing.toSeq, victim.maxSeq)
        existing.droppedBytes += victim.byteSize
      }
    }
    return freed >= targetBytes && removed >= targetEntries
  }

  /**
   * 入队一个条目。条目字节数 = JSON 序列化长度（近似 wire 开销）。
   * 空间不足时先淘汰最旧 frames 条目；仍不足（被不可淘汰条目挡住）→ 拒绝。
   */
  push(entry: Omit<AgentSpoolEntry, 'id'>): AgentSpoolPushResult {
    const byteSize = entry.byteSize > 0 ? entry.byteSize : Buffer.byteLength(JSON.stringify(entry.payload), 'utf8')
    const full: AgentSpoolEntry = { id: `sp_${randomUUID().replaceAll('-', '').slice(0, 12)}`, ...entry, byteSize }
    const targetBytes = Math.max(0, this.bytes + byteSize - this.maxBytes)
    const targetEntries = Math.max(0, this.entries.length + 1 - this.maxEntries)
    if (targetBytes > 0 || targetEntries > 0) {
      const ok = this.evictFrames(targetBytes, targetEntries)
      if (!ok) {
        return { accepted: false, reason: 'spool_overflow', evicted: this.overflowGapList() }
      }
    }
    this.entries.push(full)
    this.bytes += byteSize
    return { accepted: true, evicted: [] }
  }

  /** 待上报的 overflow 区间（flush 前取走并清空）。 */
  takeOverflowGaps(): AgentSpoolOverflowGap[] {
    const gaps = [...this.overflowGaps.values()]
    this.overflowGaps.clear()
    return gaps
  }

  private overflowGapList(): AgentSpoolOverflowGap[] {
    return [...this.overflowGaps.values()]
  }

  /**
   * 按序重放。任何 dispatch 失败立即停止（顺序保留），返回 remaining。
   * 调用方负责在重放前先上报 overflow gap（见 remote-agent.ts flushSpool）。
   */
  async drain(dispatch: (entry: AgentSpoolEntry) => Promise<unknown>): Promise<AgentSpoolDrainResult> {
    let replayed = 0
    while (this.entries.length > 0) {
      const entry = this.entries[0]
      if (entry === undefined) break
      try {
        await dispatch(entry)
      } catch {
        return { replayed, remaining: this.entries.length, failed: true }
      }
      this.entries.shift()
      this.bytes -= entry.byteSize
      replayed += 1
    }
    return { replayed, remaining: this.entries.length, failed: false }
  }

  /** 是否仍有该 run 的条目（complete 发送顺序保证用）。 */
  hasEntriesFor(runId: string, kinds?: AgentSpoolEntryKind[]): boolean {
    return this.entries.some(e => e.runId === runId && (kinds === undefined || kinds.includes(e.kind)))
  }

  /** Evicted frames still need an acknowledged gap before later frames. */
  hasOverflowGapFor(runId: string): boolean {
    return this.overflowGaps.has(runId)
  }

  /** 清空（进程退出/诊断用）。 */
  clear(): void {
    this.entries.length = 0
    this.bytes = 0
    this.overflowGaps.clear()
  }
}
