import type {
  AdoptionReceiptLite, GrillAnswerViewLite, IntakeProjectionLite,
  NextActionV2, PhaseProposalLite, ProjectRow,
} from '../types'
import { api, apiMultipart, apiResult } from '../api'
import { registerOverlayRebuild, t } from '../i18n/index'
import { state } from '../state'
import { el, pill, rootHost, showToast, trapFocus } from '../ui'
import {
  INTAKE_PHASE_OPTIONS, INTAKE_PHASE_KEYS, activeIntakeId, intakeAdoptPayload, intakeAnswersPayload,
  intakeBeginPayload, intakeErrorText, intakeGuidance, intakeIdempotencyKey,
  intakeAnsweredCount, intakePhaseText, intakeQuestionState, intakeScanSummary,
  intakeStepModel, intakeUploadIssue, intakeVerdictText, intakeVerdictTone,
} from '../intake-flow'

/**
 * ONBOARD-01 intake wizard (acceptance-tests.md §8.1 / §21
 * init-resume-intake-grill): begin → stage → scan → grill → propose → adopt
 * against the REAL kernel intake surface. Every step re-derives from the
 * durable projection (GET .../intake/{iid}) so re-entry resumes exactly
 * where the server state is. Errors surface the stable machine code via
 * intake-flow intakeErrorText. Browser visual acceptance is recorded
 * NOT_RUN_MANUAL_PENDING (Playwright-class environment unavailable); the
 * DOM wiring below is the real path — no placeholder toast.
 */

/** Grill answer drafts survive locale-switch modal rebuilds (per intake). */
const grillDrafts = new Map<string, Record<string, string>>()

interface WizardCtx {
  root: ShadowRoot
  overlay: HTMLElement
  modal: HTMLElement
  content: HTMLElement
  err: HTMLElement
  projectId: string | null
  intakeId: string | null
  projection: IntakeProjectionLite | null
  guidanceV2: NextActionV2[] | null
  projectList: ProjectRow[]
  selectedProjectId: string
  newProjectName: string
  newProjectProblem: string
  sourceLabel: string
  targetPhase: string
  projectRevision: number | null
  busy: boolean
  lastError: string
}

export function openIntakeModal(root: ShadowRoot | null | undefined, opts?: { projectId?: string; intakeId?: string }): void {
  if (root == null) return
  const overlay = el('div', 'overlay')
  overlay.onclick = (event) => { if (event.target === overlay) overlay.remove() }
  const modal = el('div', 'modal')
  modal.style.cssText = 'width:680px;max-width:94vw'
  const header = el('div', 'modal-header', t('intake', 'intake.title'))
  const closeBtn = el('button', 'hbtn ghost', '×')
  closeBtn.setAttribute('aria-label', t('intake', 'intake.close'))
  closeBtn.onclick = () => { overlay.remove(); state.rerender() }
  header.appendChild(closeBtn)
  modal.appendChild(header)
  const err = el('div', 'error-banner')
  err.style.cssText = 'display:none;margin-bottom:10px;white-space:pre-wrap'
  modal.appendChild(err)
  const content = el('div')
  content.style.cssText = 'min-height:120px'
  modal.appendChild(content)
  overlay.appendChild(modal)
  root.appendChild(overlay)

  const ctx: WizardCtx = {
    root,
    overlay,
    modal,
    content,
    err,
    projectId: opts?.projectId ?? null,
    intakeId: opts?.intakeId ?? null,
    projection: null,
    guidanceV2: null,
    projectList: [],
    selectedProjectId: opts?.projectId ?? '',
    newProjectName: '',
    newProjectProblem: '',
    sourceLabel: '',
    targetPhase: '',
    projectRevision: null,
    busy: false,
    lastError: '',
  }

  const reopen = (): void => { overlay.remove(); openIntakeModal(root, { projectId: ctx.projectId ?? undefined, intakeId: ctx.intakeId ?? undefined }) }
  registerOverlayRebuild(overlay, reopen)
  trapFocus(overlay, closeBtn)
  void boot(ctx)
}

async function boot(ctx: WizardCtx): Promise<void> {
  ctx.projectList = (await api<ProjectRow[]>('/v1/projects')) ?? []
  if (ctx.projectId !== null && ctx.intakeId !== null) {
    await refresh(ctx)
  } else if (ctx.selectedProjectId !== '') {
    await refreshBeginResume(ctx)
  }
  render(ctx)
}

/** Re-fetch the durable projection + project revision + the authoritative
 *  next_actions_v2 (GUIDE-01 intake overlay) — resume support. */
async function refresh(ctx: WizardCtx): Promise<void> {
  if (ctx.projectId === null || ctx.intakeId === null) return
  const pid = encodeURIComponent(ctx.projectId)
  const iid = encodeURIComponent(ctx.intakeId)
  const [projection, project, proj] = await Promise.all([
    api<IntakeProjectionLite>(`/v1/projects/${pid}/intake/${iid}`),
    api<{ revision?: number }>(`/v1/projects/${pid}`),
    api<{ next_actions_v2?: NextActionV2[] }>(`/v1/projects/${pid}/projection`).catch(() => null),
  ])
  if (projection !== null) {
    ctx.projection = projection
    if (typeof projection.session?.intake_id === 'string' && projection.session.intake_id !== '') {
      ctx.intakeId = projection.session.intake_id
    }
  }
  if (project?.revision !== undefined) ctx.projectRevision = project.revision
  const v2 = Array.isArray(proj?.next_actions_v2) ? proj.next_actions_v2 : null
  ctx.guidanceV2 = v2 !== null ? v2.filter(a => typeof a?.code === 'string' && a.code.startsWith('intake_')) : null
}

function setError(ctx: WizardCtx, code: string | undefined, message?: string): void {
  ctx.lastError = intakeErrorText(code, message)
  ctx.err.textContent = ctx.lastError
  ctx.err.style.display = ctx.lastError === '' ? 'none' : 'block'
}

function paintError(ctx: WizardCtx): void {
  ctx.err.textContent = ctx.lastError
  ctx.err.style.display = ctx.lastError === '' ? 'none' : 'block'
}

function busy(ctx: WizardCtx, on: boolean): void {
  ctx.busy = on
  render(ctx)
}

/* ─────────────────────────── step renderers ─────────────────────────── */

const PIPELINE = ['begin', 'stage', 'scan', 'grill', 'propose', 'adopt', 'done'] as const

function render(ctx: WizardCtx): void {
  paintError(ctx)
  const model = intakeStepModel(ctx.projection)
  const pipe = el('div', 'pipeline-wrap')
  pipe.style.cssText = 'margin:0 0 10px'
  const steps = el('div', 'pipeline')
  steps.style.cssText = 'min-width:0'
  const currentIdx = PIPELINE.indexOf(model.step)
  for (let i = 0; i < PIPELINE.length; i += 1) {
    const step = el('div', 'pstep')
    if (currentIdx > i) step.classList.add('done')
    if (currentIdx === i) step.classList.add('current')
    step.appendChild(el('span', 'dot'))
    step.appendChild(el('span', 'lbl', t('intake', `intake.step.${PIPELINE[i]}`)))
    steps.appendChild(step)
  }
  pipe.appendChild(steps)
  ctx.content.replaceChildren()
  ctx.content.appendChild(pipe)

  if (model.terminal !== null) {
    renderTerminal(ctx, model.terminal)
    return
  }
  switch (model.step) {
    case 'begin': renderBegin(ctx); break
    case 'stage': renderStage(ctx); break
    case 'scan': renderScan(ctx); break
    case 'grill': renderGrill(ctx); break
    case 'propose': renderPropose(ctx); break
    case 'adopt': renderAdopt(ctx); break
    case 'done': renderDone(ctx); break
  }
}

function sectionTitle(ctx: WizardCtx, key: string, params?: Record<string, string>): void {
  ctx.content.appendChild(el('div', 'section-label', t('intake', key, params)))
}

function renderGuidance(ctx: WizardCtx): void {
  const items = intakeGuidance(ctx.projection, ctx.guidanceV2)
  if (items.length === 0) return
  sectionTitle(ctx, 'intake.guidance.title')
  for (const item of items) {
    const row = el('div', 'row')
    row.style.cssText = 'padding:5px 0;gap:8px;align-items:flex-start'
    const badge = el('span', 'nax-code mono', item.code)
    badge.style.cssText = 'font:600 9px/1.6 ui-monospace,Menlo,monospace;color:var(--tone-blue);background:var(--tone-blue-bg);border:1px solid var(--tone-blue);border-radius:6px;padding:1px 6px;flex-shrink:0'
    const copy = el('div', 'grow')
    copy.appendChild(el('div', '', item.label))
    if (item.reason !== '') copy.appendChild(el('div', 'muted', item.reason))
    row.append(badge, copy)
    ctx.content.appendChild(row)
  }
}

function renderBegin(ctx: WizardCtx): void {
  sectionTitle(ctx, 'intake.begin.project')
  ctx.content.appendChild(el('div', 'muted', t('intake', 'intake.begin.projectHint')))
  const select = document.createElement('select')
  select.className = 'picker'
  const emptyOpt = el('option', '', t('intake', 'intake.begin.projectPlaceholder'))
  emptyOpt.value = ''
  select.appendChild(emptyOpt)
  for (const p of ctx.projectList) {
    if (p.project_id === undefined) continue
    const opt = el('option', '', `${p.name ?? p.project_id} · ${p.project_id}`)
    opt.value = p.project_id
    select.appendChild(opt)
  }
  select.value = ctx.selectedProjectId
  select.onchange = () => {
    ctx.selectedProjectId = select.value
    ctx.projectId = null
    ctx.intakeId = null
    ctx.projection = null
    ctx.guidanceV2 = null
    if (ctx.selectedProjectId !== '') void refreshBeginResume(ctx).then(() => render(ctx))
    else render(ctx)
  }
  ctx.content.appendChild(select)

  sectionTitle(ctx, 'intake.begin.createNew')
  fieldInput(ctx, t('intake', 'intake.begin.newProjectName'), ctx.newProjectName, (v) => { ctx.newProjectName = v })
  fieldInput(ctx, t('intake', 'intake.begin.newProjectProblem'), ctx.newProjectProblem, (v) => { ctx.newProjectProblem = v })

  sectionTitle(ctx, 'intake.begin.sourceLabel')
  fieldInput(ctx, t('intake', 'intake.begin.sourceLabelHint'), ctx.sourceLabel, (v) => { ctx.sourceLabel = v })

  sectionTitle(ctx, 'intake.begin.targetPhase')
  ctx.content.appendChild(el('div', 'muted', t('intake', 'intake.begin.targetPhaseHint')))
  const phaseSelect = document.createElement('select')
  phaseSelect.className = 'picker'
  const anyOpt = el('option', '', t('intake', 'intake.begin.anyPhase'))
  anyOpt.value = ''
  phaseSelect.appendChild(anyOpt)
  for (const phase of INTAKE_PHASE_OPTIONS) {
    const key = INTAKE_PHASE_KEYS[phase]
    const opt = el('option', '', key !== undefined ? t('intake', key) : phase)
    opt.value = phase
    phaseSelect.appendChild(opt)
  }
  phaseSelect.value = ctx.targetPhase
  phaseSelect.onchange = () => { ctx.targetPhase = phaseSelect.value }
  ctx.content.appendChild(phaseSelect)

  // resume hint for the selected project (active intake session found).
  if (ctx.selectedProjectId !== '' && ctx.intakeId !== null) {
    const resumeRow = el('div')
    resumeRow.style.cssText = 'margin-top:10px'
    resumeRow.appendChild(el('div', 'muted', t('intake', 'intake.begin.resumeAvailable')))
    const go = el('button', 'hbtn', t('intake', 'intake.begin.resumeCta'))
    go.style.cssText = 'margin-top:4px'
    go.onclick = () => { void refresh(ctx).then(() => render(ctx)) }
    resumeRow.appendChild(go)
    ctx.content.appendChild(resumeRow)
  }

  const cta = el('button', 'btn primary', t('intake', 'intake.begin.cta'))
  cta.style.cssText = 'margin-top:14px;padding:8px 22px'
  cta.disabled = ctx.busy
  cta.onclick = async () => {
    if (ctx.busy) return
    const source = ctx.sourceLabel.trim()
    if (source === '') {
      setError(ctx, 'validation_error', t('intake', 'intake.error.validation_error'))
      return
    }
    let pid = ctx.selectedProjectId
    busy(ctx, true)
    try {
      if (pid === '') {
        const name = ctx.newProjectName.trim()
        if (name === '') {
          setError(ctx, 'validation_error', t('intake', 'intake.error.validation_error'))
          ctx.busy = false
          render(ctx)
          return
        }
        const created = await api<{ project_id?: string }>('/v1/projects', {
          method: 'POST',
          body: JSON.stringify({
            name,
            workspace: `/research/${name}`,
            brief: {
              problem: ctx.newProjectProblem.trim() || 'To be specified during intake adoption.',
              scope: 'To be specified during intake adoption.',
              questions: [],
              primary_metrics: [],
              resources: '',
              risks: [],
              target_outputs: ['conference-paper'],
              target_venue: null,
              baseline_repo: null,
              domain: 'machine-learning',
            },
            mode: 'gate-only',
          }),
        })
        if (created === null || created.project_id === undefined) {
          setError(ctx, 'project_not_found', t('intake', 'intake.error.project_not_found'))
          ctx.busy = false
          render(ctx)
          return
        }
        pid = created.project_id
        ctx.projectList = [...ctx.projectList, { project_id: pid, name, status: 'DRAFT' }]
        ctx.selectedProjectId = pid
      }
      const result = await apiResult<{ intake_id?: string }>(`/v1/projects/${encodeURIComponent(pid)}/intake`, {
        method: 'POST',
        body: JSON.stringify(intakeBeginPayload(source, ctx.targetPhase === '' ? null : ctx.targetPhase)),
      })
      if (!result.ok || result.data.intake_id === undefined) {
        setError(ctx, result.ok ? 'validation_error' : result.error.code, result.ok ? undefined : result.error.message)
        ctx.busy = false
        render(ctx)
        return
      }
      ctx.projectId = pid
      ctx.intakeId = result.data.intake_id
      ctx.projection = null
      ctx.guidanceV2 = null
      await refresh(ctx)
      ctx.busy = false
      render(ctx)
    } catch {
      setError(ctx, 'network_error')
      ctx.busy = false
      render(ctx)
    }
  }
  ctx.content.appendChild(cta)
}

/** Fetch the selected project's active intake (resume path). */
async function refreshBeginResume(ctx: WizardCtx): Promise<void> {
  if (ctx.selectedProjectId === '') return
  const list = await api<Array<{ intake_id?: string; status?: string }>>(`/v1/projects/${encodeURIComponent(ctx.selectedProjectId)}/intake`)
  const intakeId = activeIntakeId(list)
  if (intakeId !== null) {
    ctx.intakeId = intakeId
    ctx.projectId = ctx.selectedProjectId
    await refresh(ctx)
  }
}

function fieldInput(ctx: WizardCtx, placeholder: string, value: string, onChange: (v: string) => void): HTMLInputElement {
  const input = document.createElement('input')
  input.type = 'text'
  input.placeholder = placeholder
  input.value = value
  input.style.cssText = 'width:100%;box-sizing:border-box;background:var(--bg-input);color:var(--text);border:1px solid var(--border);border-radius:8px;padding:7px 11px;font:12px/1.4 system-ui,sans-serif;outline:none;margin-bottom:6px'
  input.onfocus = () => { input.style.borderColor = 'var(--accent)' }
  input.onblur = () => { input.style.borderColor = 'var(--border)' }
  input.oninput = () => { onChange(input.value) }
  ctx.content.appendChild(input)
  return input
}

function renderStage(ctx: WizardCtx): void {
  sectionTitle(ctx, 'intake.stage.title')
  ctx.content.appendChild(el('div', 'muted', t('intake', 'intake.stage.hint')))
  const artifacts = Array.isArray(ctx.projection?.artifacts) ? ctx.projection.artifacts : []
  if (artifacts.length === 0) {
    ctx.content.appendChild(el('div', 'empty', t('intake', 'intake.stage.empty')))
  }
  for (const artifact of artifacts) {
    const row = el('div', 'row')
    const tone = intakeVerdictTone(artifact)
    const toneClass = tone === 'clean' ? 'green' : tone === 'rejected' ? 'red' : tone === 'quarantined' ? 'amber' : 'slate'
    row.style.cssText = `padding:6px 0;border-bottom:1px dashed var(--border-2);border-left:2px solid var(--tone-${toneClass});gap:8px`
    row.appendChild(el('span', 'artifact-kind', intakeVerdictText(artifact)))
    const name = el('span', 'grow mono', artifact.file_name ?? '')
    name.style.cssText = 'font-size:11px;word-break:break-all'
    row.appendChild(name)
    row.appendChild(el('span', 'muted mono', t('intake', 'intake.stage.sizeBytes', { size: String(artifact.size_bytes ?? 0) })))
    row.appendChild(el('span', 'muted mono', t('intake', 'intake.stage.sha256', { hash: (artifact.sha256 ?? '').slice(0, 10) })))
    const del = el('button', 'hbtn', t('intake', 'intake.stage.delete'))
    del.style.cssText = 'padding:1px 8px;flex-shrink:0'
    del.onclick = async () => {
      if (ctx.busy || ctx.projectId === null || ctx.intakeId === null) return
      busy(ctx, true)
      const res = await apiResult<{ ok?: boolean }>(`/v1/projects/${encodeURIComponent(ctx.projectId)}/intake/${encodeURIComponent(ctx.intakeId)}/artifacts/${encodeURIComponent(artifact.artifact_id ?? '')}`, { method: 'DELETE' })
      if (!res.ok) setError(ctx, res.error.code, res.error.message)
      await refresh(ctx)
      ctx.busy = false
      render(ctx)
    }
    row.appendChild(del)
    ctx.content.appendChild(row)
  }

  const uploadRow = el('div', 'row')
  uploadRow.style.cssText = 'margin-top:12px;gap:8px'
  const fileInput = document.createElement('input')
  fileInput.type = 'file'
  fileInput.style.cssText = 'flex:1;min-width:0;font:11px/1.4 system-ui,sans-serif'
  const uploadBtn = el('button', 'btn primary', t('intake', 'intake.stage.fileCta'))
  uploadBtn.style.cssText = 'flex-shrink:0'
  uploadBtn.onclick = async () => {
    if (ctx.busy || ctx.projectId === null || ctx.intakeId === null) return
    const file = fileInput.files?.[0]
    const issue = intakeUploadIssue(file)
    if (issue !== null) {
      setError(ctx, issue)
      return
    }
    busy(ctx, true)
    const form = new FormData()
    form.append('file', file as Blob, (file as File).name)
    const res = await apiMultipart<{ artifact_id?: string; reused?: boolean }>(`/v1/projects/${encodeURIComponent(ctx.projectId)}/intake/${encodeURIComponent(ctx.intakeId)}/artifacts`, form)
    if (!res.ok) {
      setError(ctx, res.error.code, res.error.message)
    } else if (res.data.reused === true) {
      showToast(rootHost(), t('intake', 'intake.stage.reused'))
    }
    fileInput.value = ''
    await refresh(ctx)
    ctx.busy = false
    render(ctx)
  }
  uploadRow.append(fileInput, uploadBtn)
  ctx.content.appendChild(uploadRow)

  if (artifacts.length > 0) {
    const scanBtn = el('button', 'btn approve', t('intake', 'intake.stage.scanCta'))
    scanBtn.style.cssText = 'margin-top:10px'
    scanBtn.disabled = ctx.busy
    scanBtn.onclick = async () => {
      if (ctx.busy || ctx.projectId === null || ctx.intakeId === null) return
      busy(ctx, true)
      const res = await apiResult<IntakeProjectionLite>(`/v1/projects/${encodeURIComponent(ctx.projectId)}/intake/${encodeURIComponent(ctx.intakeId)}/scan`, { method: 'POST', body: '{}' })
      if (!res.ok) setError(ctx, res.error.code, res.error.message)
      await refresh(ctx)
      ctx.busy = false
      render(ctx)
    }
    ctx.content.appendChild(scanBtn)
  }
  renderGuidance(ctx)
}

function renderScan(ctx: WizardCtx): void {
  sectionTitle(ctx, 'intake.scan.title')
  const summary = intakeScanSummary(ctx.projection)
  ctx.content.appendChild(el('div', '', t('intake', 'intake.scan.summary', {
    count: String(summary.artifact_count),
    clean: String(summary.clean),
    quarantined: String(summary.quarantined),
    rejected: String(summary.rejected),
  })))
  const observations = Array.isArray(ctx.projection?.observations) ? ctx.projection.observations : []
  if (observations.length > 0) {
    sectionTitle(ctx, 'intake.scan.observation')
    for (const obs of observations) {
      const row = el('div', 'row')
      row.style.cssText = 'padding:4px 0;gap:8px;align-items:flex-start;border-bottom:1px dashed var(--border-2)'
      row.appendChild(el('span', 'artifact-kind', obs.detector ?? ''))
      row.appendChild(el('span', 'grow mono', obs.value ?? ''))
      ctx.content.appendChild(row)
    }
  }
  const rejected = (Array.isArray(ctx.projection?.artifacts) ? ctx.projection.artifacts : []).filter(a => a.quarantine === 'rejected')
  if (rejected.length > 0) {
    ctx.content.appendChild(el('div', 'warn', t('intake', 'intake.scan.rejectedNote')))
  }
  const scanBtn = el('button', 'btn approve', t('intake', 'intake.scan.cta'))
  scanBtn.style.cssText = 'margin-top:12px'
  scanBtn.disabled = ctx.busy
  scanBtn.onclick = async () => {
    if (ctx.busy || ctx.projectId === null || ctx.intakeId === null) return
    busy(ctx, true)
    const res = await apiResult<IntakeProjectionLite>(`/v1/projects/${encodeURIComponent(ctx.projectId)}/intake/${encodeURIComponent(ctx.intakeId)}/scan`, { method: 'POST', body: '{}' })
    if (!res.ok) setError(ctx, res.error.code, res.error.message)
    await refresh(ctx)
    ctx.busy = false
    render(ctx)
  }
  ctx.content.appendChild(scanBtn)
  renderGuidance(ctx)
}

function renderGrill(ctx: WizardCtx): void {
  const questions = Array.isArray(ctx.projection?.questions) ? ctx.projection.questions : []
  const { answered, total } = intakeAnsweredCount(questions)
  sectionTitle(ctx, 'intake.grill.title')
  ctx.content.appendChild(el('div', 'muted', t('intake', 'intake.grill.subtitle')))
  ctx.content.appendChild(el('div', 'muted', t('intake', 'intake.grill.answered', { answered: String(answered), total: String(total) })))
  const drafts = ctx.intakeId !== null ? (grillDrafts.get(ctx.intakeId) ?? {}) : {}
  for (const question of questions) {
    renderQuestion(ctx, question, drafts)
  }
  const saveBtn = el('button', 'btn primary', t('intake', 'intake.grill.save'))
  saveBtn.style.cssText = 'margin-top:12px'
  saveBtn.disabled = ctx.busy
  saveBtn.onclick = async () => {
    if (ctx.busy || ctx.projectId === null || ctx.intakeId === null) return
    const answers = questions
      .filter(q => typeof drafts[q.question_code ?? ''] === 'string' && drafts[q.question_code ?? ''] !== '')
      .map(q => ({
        question_code: q.question_code ?? '',
        answer: drafts[q.question_code ?? ''] as string,
        question_revision: q.question_revision ?? 1,
      }))
    if (answers.length === 0) {
      setError(ctx, 'question_required')
      return
    }
    busy(ctx, true)
    const res = await apiResult<IntakeProjectionLite>(`/v1/projects/${encodeURIComponent(ctx.projectId)}/intake/${encodeURIComponent(ctx.intakeId)}/answers`, {
      method: 'POST',
      body: JSON.stringify(intakeAnswersPayload(answers)),
    })
    if (!res.ok) {
      setError(ctx, res.error.code, res.error.message)
      ctx.busy = false
      render(ctx)
      return
    }
    showToast(rootHost(), t('intake', 'intake.grill.saved'))
    await refresh(ctx)
    ctx.busy = false
    render(ctx)
  }
  ctx.content.appendChild(saveBtn)
  const model = intakeStepModel(ctx.projection)
  if (model.canPropose) {
    const proposeBtn = el('button', 'btn approve', t('intake', 'intake.grill.proposeCta'))
    proposeBtn.style.cssText = 'margin-left:8px'
    proposeBtn.disabled = ctx.busy
    proposeBtn.onclick = async () => {
      if (ctx.busy || ctx.projectId === null || ctx.intakeId === null) return
      busy(ctx, true)
      const res = await apiResult<PhaseProposalLite>(`/v1/projects/${encodeURIComponent(ctx.projectId)}/intake/${encodeURIComponent(ctx.intakeId)}/propose`, { method: 'POST', body: '{}' })
      if (!res.ok) setError(ctx, res.error.code, res.error.message)
      await refresh(ctx)
      ctx.busy = false
      render(ctx)
    }
    saveBtn.after(proposeBtn)
  } else if (model.requiredOpen.length > 0) {
    ctx.content.appendChild(el('div', 'warn', t('intake', 'intake.grill.openRequired', { codes: model.requiredOpen.join(', ') })))
  }
  renderGuidance(ctx)
}

function renderQuestion(ctx: WizardCtx, question: GrillAnswerViewLite, drafts: Record<string, string>): void {
  const code = question.question_code ?? ''
  const card = el('div', 'card')
  const head = el('div', 'row')
  head.style.cssText = 'gap:8px;align-items:flex-start'
  const badge = el('span', 'artifact-kind', code)
  const prompt = el('span', 'grow', question.prompt ?? '')
  prompt.style.cssText = 'font-size:11.5px;color:var(--text)'
  head.append(badge, prompt)
  const req = question.required === true
  const reqPill = el('span', 'nax-state', req ? t('intake', 'intake.grill.required') : t('intake', 'intake.grill.optional'))
  reqPill.style.cssText = `font:600 9px/1.6 ui-monospace,Menlo,monospace;border-radius:99px;padding:1px 8px;${req ? 'color:var(--tone-amber);background:var(--tone-amber-bg);border:1px solid var(--tone-amber)' : 'color:var(--text-3);background:var(--bg-3);border:1px solid var(--border)'}`
  head.appendChild(reqPill)
  card.appendChild(head)
  if (typeof question.reason === 'string' && question.reason !== '') {
    card.appendChild(el('div', 'muted', question.reason))
  }
  const input = document.createElement('textarea')
  input.rows = 2
  input.placeholder = t('intake', 'intake.grill.answer')
  input.value = typeof question.answer === 'string' ? question.answer : (drafts[code] ?? '')
  input.style.cssText = 'width:100%;box-sizing:border-box;margin-top:6px;background:var(--bg-input);color:var(--text);border:1px solid var(--border);border-radius:8px;padding:6px 10px;font:12px/1.4 system-ui,sans-serif;outline:none;resize:vertical'
  input.oninput = () => { drafts[code] = input.value; if (ctx.intakeId !== null) grillDrafts.set(ctx.intakeId, { ...drafts }) }
  card.appendChild(input)
  if (intakeQuestionState(question) === 'answered') {
    const meta = el('div', 'muted', t('intake', 'intake.grill.saved'))
    meta.style.cssText = 'font-size:10px;margin-top:4px'
    card.appendChild(meta)
  }
  ctx.content.appendChild(card)
}

function renderPropose(ctx: WizardCtx): void {
  const proposal = ctx.projection?.proposal ?? null
  sectionTitle(ctx, 'intake.propose.title')
  if (proposal === null) {
    const gen = el('button', 'btn approve', t('intake', 'intake.propose.regenerate'))
    gen.disabled = ctx.busy
    gen.onclick = async () => {
      if (ctx.busy || ctx.projectId === null || ctx.intakeId === null) return
      busy(ctx, true)
      const res = await apiResult<PhaseProposalLite>(`/v1/projects/${encodeURIComponent(ctx.projectId)}/intake/${encodeURIComponent(ctx.intakeId)}/propose`, { method: 'POST', body: '{}' })
      if (!res.ok) setError(ctx, res.error.code, res.error.message)
      await refresh(ctx)
      ctx.busy = false
      render(ctx)
    }
    ctx.content.appendChild(gen)
    renderGuidance(ctx)
    return
  }
  const rows: Array<[string, string]> = [
    [t('intake', 'intake.propose.observedPhase'), intakePhaseText(proposal.observed_phase)],
    [t('intake', 'intake.propose.safeStatus'), String(proposal.safe_project_status ?? '')],
    [t('intake', 'intake.propose.confidence'), `${Math.round((proposal.confidence ?? 0) * 100)}%`],
  ]
  for (const [label, value] of rows) {
    const row = el('div', 'row')
    row.style.cssText = 'padding:4px 0;gap:10px;align-items:flex-start'
    const l = el('span', '', label)
    l.style.cssText = 'width:150px;color:var(--text-2);font-size:11px;flex-shrink:0'
    const v = el('span', 'grow', value)
    v.style.cssText = 'font-size:11px;word-break:break-word'
    row.append(l, v)
    ctx.content.appendChild(row)
  }
  sectionTitle(ctx, 'intake.propose.plan')
  ctx.content.appendChild(el('div', '', proposal.plan ?? ''))
  if ((proposal.risks ?? []).length > 0) {
    sectionTitle(ctx, 'intake.propose.risks')
    for (const risk of proposal.risks ?? []) ctx.content.appendChild(el('div', 'muted', `• ${risk}`))
  }
  if ((proposal.pre_accept_checklist ?? []).length > 0) {
    sectionTitle(ctx, 'intake.propose.checklist')
    for (const item of proposal.pre_accept_checklist ?? []) ctx.content.appendChild(el('div', '', `☐ ${item}`))
  }
  if ((proposal.required_gates ?? []).length > 0) {
    sectionTitle(ctx, 'intake.propose.gates')
    ctx.content.appendChild(el('div', 'muted', (proposal.required_gates ?? []).join(', ')))
  }
  if ((proposal.unresolved_gaps ?? []).length > 0) {
    sectionTitle(ctx, 'intake.propose.gaps')
    for (const gap of proposal.unresolved_gaps ?? []) ctx.content.appendChild(el('div', 'muted mono', `• ${gap}`))
  }
  if ((proposal.suggested_mappings ?? []).length > 0) {
    sectionTitle(ctx, 'intake.propose.mappings')
    for (const mapping of proposal.suggested_mappings ?? []) {
      ctx.content.appendChild(el('div', 'muted mono', `${mapping.source_artifact_id ?? ''} → ${mapping.target_kind ?? ''}`))
    }
  }
  const actions = el('div', 'row')
  actions.style.cssText = 'margin-top:14px;gap:8px;justify-content:flex-end'
  const adoptBtn = el('button', 'btn approve', t('intake', 'intake.propose.adoptCta'))
  adoptBtn.disabled = ctx.busy
  adoptBtn.onclick = async () => {
    if (ctx.busy || ctx.projectId === null || ctx.intakeId === null) return
    busy(ctx, true)
    const body = intakeAdoptPayload(proposal, ctx.projectRevision ?? undefined)
    body.idempotency_key = intakeIdempotencyKey(ctx.intakeId)
    const res = await apiResult<AdoptionReceiptLite>(`/v1/projects/${encodeURIComponent(ctx.projectId)}/intake/${encodeURIComponent(ctx.intakeId)}/adopt`, {
      method: 'POST',
      body: JSON.stringify(body),
    })
    if (!res.ok) setError(ctx, res.error.code, res.error.message)
    await refresh(ctx)
    ctx.busy = false
    render(ctx)
  }
  const rejectBtn = el('button', 'btn reject', t('intake', 'intake.propose.rejectCta'))
  rejectBtn.disabled = ctx.busy
  rejectBtn.onclick = async () => {
    if (ctx.busy || ctx.projectId === null || ctx.intakeId === null) return
    busy(ctx, true)
    const res = await apiResult<{ ok?: boolean }>(`/v1/projects/${encodeURIComponent(ctx.projectId)}/intake/${encodeURIComponent(ctx.intakeId)}/reject`, {
      method: 'POST',
      body: '{}',
    })
    if (!res.ok) setError(ctx, res.error.code, res.error.message)
    await refresh(ctx)
    ctx.busy = false
    render(ctx)
  }
  const regenBtn = el('button', 'hbtn', t('intake', 'intake.propose.regenerate'))
  regenBtn.disabled = ctx.busy
  regenBtn.onclick = async () => {
    if (ctx.busy || ctx.projectId === null || ctx.intakeId === null) return
    busy(ctx, true)
    const res = await apiResult<PhaseProposalLite>(`/v1/projects/${encodeURIComponent(ctx.projectId)}/intake/${encodeURIComponent(ctx.intakeId)}/propose`, { method: 'POST', body: '{}' })
    if (!res.ok) setError(ctx, res.error.code, res.error.message)
    await refresh(ctx)
    ctx.busy = false
    render(ctx)
  }
  actions.append(regenBtn, rejectBtn, adoptBtn)
  ctx.content.appendChild(actions)
  renderGuidance(ctx)
}

function renderAdopt(ctx: WizardCtx): void {
  const proposal = ctx.projection?.proposal ?? null
  sectionTitle(ctx, 'intake.propose.title')
  if (proposal !== null) {
    ctx.content.appendChild(el('div', 'muted', `${t('intake', 'intake.propose.observedPhase')}: ${intakePhaseText(proposal.observed_phase)}`))
  }
  const actions = el('div', 'row')
  actions.style.cssText = 'margin-top:14px;gap:8px;justify-content:flex-end'
  const adoptBtn = el('button', 'btn approve', ctx.busy ? t('intake', 'intake.propose.adopting') : t('intake', 'intake.propose.adoptCta'))
  adoptBtn.disabled = ctx.busy
  adoptBtn.onclick = async () => {
    if (ctx.busy || ctx.projectId === null || ctx.intakeId === null) return
    busy(ctx, true)
    const body = intakeAdoptPayload(proposal, ctx.projectRevision ?? undefined)
    body.idempotency_key = intakeIdempotencyKey(ctx.intakeId)
    const res = await apiResult<AdoptionReceiptLite>(`/v1/projects/${encodeURIComponent(ctx.projectId)}/intake/${encodeURIComponent(ctx.intakeId)}/adopt`, {
      method: 'POST',
      body: JSON.stringify(body),
    })
    if (!res.ok) setError(ctx, res.error.code, res.error.message)
    await refresh(ctx)
    ctx.busy = false
    render(ctx)
  }
  const rejectBtn = el('button', 'btn reject', t('intake', 'intake.propose.rejectCta'))
  rejectBtn.disabled = ctx.busy
  rejectBtn.onclick = async () => {
    if (ctx.busy || ctx.projectId === null || ctx.intakeId === null) return
    busy(ctx, true)
    const res = await apiResult<{ ok?: boolean }>(`/v1/projects/${encodeURIComponent(ctx.projectId)}/intake/${encodeURIComponent(ctx.intakeId)}/reject`, {
      method: 'POST',
      body: '{}',
    })
    if (!res.ok) setError(ctx, res.error.code, res.error.message)
    await refresh(ctx)
    ctx.busy = false
    render(ctx)
  }
  actions.append(rejectBtn, adoptBtn)
  ctx.content.appendChild(actions)
  renderGuidance(ctx)
}

function renderDone(ctx: WizardCtx): void {
  const receipt = ctx.projection?.receipt ?? null
  sectionTitle(ctx, 'intake.adopt.title')
  if (receipt !== null) {
    ctx.content.appendChild(el('div', 'section-label', t('intake', 'intake.adopt.receipt')))
    const rows: Array<[string, string]> = [
      ['adoption_id', receipt.adoption_id ?? ''],
      ['intake_id', receipt.intake_id ?? ''],
      ['project_id', receipt.project_id ?? ''],
      [t('intake', 'intake.adopt.adoptedBy'), receipt.adopted_by?.principal_id ?? ''],
      ['proposal_revision', String(receipt.proposal_revision ?? '')],
      ['target_project_revision', String(receipt.target_project_revision ?? '')],
    ]
    for (const [label, value] of rows) {
      const row = el('div', 'row')
      row.style.cssText = 'padding:3px 0;gap:10px'
      const l = el('span', 'muted mono', label)
      l.style.cssText = 'width:150px;flex-shrink:0'
      const v = el('span', 'grow mono', value)
      v.style.cssText = 'font-size:10.5px;word-break:break-all'
      row.append(l, v)
      ctx.content.appendChild(row)
    }
    if ((receipt.created_object_refs ?? []).length > 0) {
      sectionTitle(ctx, 'intake.adopt.artifacts')
      for (const ref of receipt.created_object_refs ?? []) ctx.content.appendChild(el('div', 'muted mono', `• ${ref}`))
    }
    if ((receipt.pending_gate_refs ?? []).length > 0) {
      sectionTitle(ctx, 'intake.adopt.gates')
      for (const ref of receipt.pending_gate_refs ?? []) ctx.content.appendChild(el('div', 'muted mono', `• ${ref}`))
    }
    if ((receipt.draft_evidence_refs ?? []).length > 0) {
      sectionTitle(ctx, 'intake.adopt.evidence')
      for (const ref of receipt.draft_evidence_refs ?? []) ctx.content.appendChild(el('div', 'muted mono', `• ${ref}`))
    }
  }
  const actions = el('div', 'row')
  actions.style.cssText = 'margin-top:14px;gap:8px;justify-content:flex-end'
  if (ctx.projectId !== null) {
    const open = el('button', 'hbtn', t('intake', 'intake.adopt.openProject'))
    open.onclick = () => {
      ctx.overlay.remove()
      state.projectId = ctx.projectId ?? undefined
      state.rerender()
    }
    actions.appendChild(open)
  }
  const done = el('button', 'btn primary', t('intake', 'intake.adopt.doneCta'))
  done.onclick = () => { ctx.overlay.remove(); state.rerender() }
  actions.appendChild(done)
  ctx.content.appendChild(actions)
}

function renderTerminal(ctx: WizardCtx, kind: string): void {
  const key = `intake.terminal.${kind}`
  ctx.content.appendChild(el('div', 'warn', t('intake', key)))
  ctx.content.appendChild(pill(ctx.projection?.session?.status))
  const close = el('button', 'btn primary', t('intake', 'intake.close'))
  close.style.cssText = 'margin-top:14px'
  close.onclick = () => { ctx.overlay.remove(); state.rerender() }
  ctx.content.appendChild(close)
}
