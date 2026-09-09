/**
 * status namespace: status pill / sidebar / search-row labels for project
 * phases, gate decisions, job states and evidence claims. Known project-phase
 * labels are user-facing semantics (SURVEYING is a ready phase, not an active
 * task); unknown wire values still stay raw. zh/en key sets must stay exactly
 * equal (localeParityReport / assertLocaleParity).
 */
export const zh = {
  // project phases
  'status.DRAFT': '草稿',
  'status.SCOPED': '已定范围',
  'status.SURVEYING': '调研已就绪',
  'status.IDEATING': '构思中',
  'status.IDEA_APPROVED': '构思通过',
  'status.CONTRACT_PENDING': '合同待审批',
  'status.BASELINE_REPRO': '基线复现',
  'status.CONTRACT_APPROVED': '契约通过',
  'status.EXPERIMENTING': '实验中',
  'status.EVIDENCE_READY': '证据就绪',
  'status.WRITING': '撰写中',
  'status.REVIEWING': '评审中',
  'status.RELEASE_READY': '待发布审批',
  'status.RELEASED': '已发布',
  'status.BLOCKED_GATE': '门禁阻断',
  'status.ARCHIVED': '已归档',
  // gates
  'status.pending': '待审批',
  'status.approved': '已批准',
  'status.rejected': '已拒绝',
  // jobs
  'status.queued': '排队中',
  'status.running': '运行中',
  'status.succeeded': '已成功',
  'status.failed': '失败',
  'status.cancelled': '已取消',
  'status.retryable': '可重试',
  // claims
  'status.supported': '支持',
  'status.contradicted': '反驳',
  'status.inconclusive': '无定论',
  'status.unverified': '未验证',
  // generic
  'status.none': '—',
} as const

export type StatusKey = keyof typeof zh

export const en: Record<StatusKey, string> = {
  // project phases (human-readable labels; unknown enums stay raw in ui.ts)
  'status.DRAFT': 'DRAFT',
  'status.SCOPED': 'SCOPED',
  'status.SURVEYING': 'SURVEY READY',
  'status.IDEATING': 'IDEATING',
  'status.IDEA_APPROVED': 'IDEA ✓',
  'status.CONTRACT_PENDING': 'CONTRACT PENDING',
  'status.BASELINE_REPRO': 'BASELINE',
  'status.CONTRACT_APPROVED': 'CONTRACT ✓',
  'status.EXPERIMENTING': 'EXPERIMENT',
  'status.EVIDENCE_READY': 'EVIDENCE',
  'status.WRITING': 'WRITING',
  'status.REVIEWING': 'REVIEW',
  'status.RELEASE_READY': 'Awaiting release approval',
  'status.RELEASED': 'RELEASED',
  'status.BLOCKED_GATE': 'BLOCKED',
  'status.ARCHIVED': 'ARCHIVED',
  // gates
  'status.pending': 'PENDING',
  'status.approved': 'APPROVED',
  'status.rejected': 'REJECTED',
  // jobs
  'status.queued': 'QUEUED',
  'status.running': 'RUNNING',
  'status.succeeded': 'SUCCEEDED',
  'status.failed': 'FAILED',
  'status.cancelled': 'CANCELLED',
  'status.retryable': 'RETRYABLE',
  // claims
  'status.supported': 'SUPPORTED',
  'status.contradicted': 'CONTRADICTED',
  'status.inconclusive': 'INCONCLUSIVE',
  'status.unverified': 'UNVERIFIED',
  // generic
  'status.none': '—',
}
