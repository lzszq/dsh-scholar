import type { ProjectExecutionSettingsLite, ProjectModelBindingLite, Projection, ProviderSafeViewLite, RunnerTargetKindLite, RunnerTargetSafeViewLite, SecretRefViewLite } from '../types'
import { api, apiResult, base } from '../api'
import { getLocale, registerOverlayRebuild, setLocale, t } from '../i18n/index'
import { openShortcutsModal } from '../modals/commands'
import { accentColor, accentSet, autoRefreshEnabled, autoRefreshSet, chatClear, radiusSet, radiusValue, readTheme, state, textureSet, textureValue, writeTheme } from '../state'
import { ACCENTS, ACCENT_DARK, copyText, el, rootHost, showToast, trapFocus } from '../ui'
import { tokenProvider } from '../api'
import { RADII, TEXTURES } from '../state'
import {
  configPinChanged, settingsConfigModel, settingsConfigPin, settingsConfigWrite,
  mapSettingsServerErrors, SettingsConfigInputError, settingsConfigTransaction,
  settingsFieldDisplay, settingsKey, settingsSectionsForData,
} from '../settings-model'
import type { SettingsConfigField, SettingsEffectiveWire, SettingsSchemaWire } from '../settings-model'
import {
  DEFAULT_DOCKER_IMAGE_DIGEST,
  runnerTargetRuntimeDraft,
  runnerTargetRuntimePayload,
  runnerTargetSettingsOperation,
  runnerTargetSecretRefDraft,
  runnerTargetSecretRefPayload,
  type RunnerTargetSecretRefPayload,
  type RunnerTargetSecretRefScheme,
} from '../runner-target-settings-model'
import {
  MINERU_MODEL_IDS,
  mineruProvider,
  mineruSettingsOperation,
  mineruSettingsErrorKey,
  mineruSettingsDraft,
  type MineruModelId,
  type MineruSecretRefScheme,
  type MineruSettingsDraft,
} from '../mineru-settings-model'
import { budgetPageVisible, writeBudgetPageVisible } from '../navigation-preferences'
/* ─────────────────────────── settings modal ─────────────────────────── */

/**
 * dsh-web "Settings" counterpart with UI-SIMPLE-01 progressive disclosure
 * (acceptance-tests.md §8 ui-settings) + CONFIG-01 dynamic generation
 * (hardening §5 P1 CONFIG-01/UI-02/UI-03): every section is an Accordion
 * that starts COLLAPSED (defaultCollapsed in the pure settingsSections()
 * model), each item carries its source / effective-status line, and the
 * config surface is GENERATED from GET /v1/config/schema +
 * GET /v1/config/effective — one section per ConfigScope with every field
 * showing its current (server-redacted) value, scope, declared sources,
 * hot-reload verdict, security-floor marker and validation metadata.
 * Secrets are never echoed (the server effective view is already redacted;
 * the client only renders the set-but-hidden mask, never a plaintext). The
 * effective config pin is shown with a change hint. Writable fields use the
 * registry's exact write scope and submit one revision-CAS Settings
 * transaction; unavailable revision context removes the save action. When
 * registry data is unavailable the honest placeholder sections remain
 * (settingsSectionsForData(false)). Rows
 * without a static value are dynamic slots filled below with live controls
 * (kernel health, selects, toggles). All copy goes through t()/settingsKey()
 * — no hardcoded chrome (i18n §8).
 */
export async function openSettingsModal(root: ShadowRoot | null | undefined): Promise<void> {
  if (root == null) return
  const overlay = el('div', 'overlay')
  overlay.onclick = (event) => { if (event.target === overlay) overlay.remove() }
  const modal = el('div', 'modal')
  modal.style.cssText = 'width:680px;max-width:92vw'
  const header = el('div', 'modal-header', t('shell', 'shell.settings.title'))
  const closeBtn = el('button', 'hbtn ghost', '×')
  closeBtn.onclick = () => overlay.remove()
  header.appendChild(closeBtn)
  modal.appendChild(header)

  // Accordion expand memory (optional): sections start collapsed; only a
  // user-expanded section stays open across re-opens.
  const SETTINGS_OPEN_KEY = 'dsh-scholar-ui-settings-open'
  const settingsOpenLoad = (): Set<string> => {
    try {
      const raw = localStorage.getItem(SETTINGS_OPEN_KEY)
      const parsed = raw !== null ? JSON.parse(raw) as unknown : null
      return new Set(Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : [])
    } catch { /* private mode */ }
    return new Set()
  }
  const settingsOpenPersist = (open: Set<string>): void => {
    try { localStorage.setItem(SETTINGS_OPEN_KEY, JSON.stringify([...open])) } catch { /* private mode */ }
  }
  const openSections = settingsOpenLoad()

  // One kernel health probe serves the connection section; the CONFIG-01
  // surface (schema + effective) drives the dynamic config sections.
  const activeProjectId = state.projectId
  const effectiveQuery = new URLSearchParams()
  if (activeProjectId !== undefined) effectiveQuery.set('project_id', activeProjectId)
  const [health, schema, effective, runnerTargets, providerRead, activeProjectRead, modelBindingRead] = await Promise.all([
    api<{ ok?: boolean; instance?: string }>('/v1/health'),
    api<SettingsSchemaWire>('/v1/config/schema'),
    api<SettingsEffectiveWire>(`/v1/config/effective?${effectiveQuery.toString()}`),
    api<RunnerTargetSafeViewLite[]>('/v1/runner-targets'),
    apiResult<ProviderSafeViewLite[]>('/v1/providers'),
    activeProjectId === undefined
      ? Promise.resolve(null)
      : apiResult<ProjectExecutionSettingsLite>(`/v2/projects/${encodeURIComponent(activeProjectId)}`),
    activeProjectId === undefined
      ? Promise.resolve(null)
      : apiResult<ProjectModelBindingLite | null>(`/v1/projects/${encodeURIComponent(activeProjectId)}/model-binding`),
  ])
  const providers = providerRead.ok ? providerRead.data : null
  const activeProject = activeProjectRead === null ? null : activeProjectRead.ok ? activeProjectRead.data : null
  const activeProjectLoadFailed = activeProjectRead !== null && !activeProjectRead.ok
  const modelBinding = modelBindingRead === null ? null : modelBindingRead.ok ? modelBindingRead.data : null
  const modelBindingLoadFailed = modelBindingRead !== null && !modelBindingRead.ok
  const hasConfig = schema !== null && effective !== null &&
    typeof effective.config === 'object' && effective.config !== null
  const dynamicSections = hasConfig && schema !== null && effective !== null
    ? settingsConfigModel(schema, effective)
    : []

  /** One Accordion section (head + collapsible body, expand memory). */
  const makeAccordion = (id: string, title: string, summary: string, defaultCollapsed: boolean):
    { acc: HTMLElement; head: HTMLButtonElement; body: HTMLElement } => {
    const acc = el('div', 'settings-section')
    acc.dataset.section = id
    const open = openSections.has(id) || !defaultCollapsed
    acc.dataset.open = open ? 'true' : 'false'
    const head = el('button', 'settings-section-head')
    head.id = `settings-head-${id}`
    head.setAttribute('aria-expanded', open ? 'true' : 'false')
    head.setAttribute('aria-controls', `settings-body-${id}`)
    head.setAttribute('aria-label', t('shell', 'shell.settings.accordion.toggle', { title }))
    const caret = el('span', 'settings-section-caret', '▸')
    const titleEl = el('span', '', title)
    const summaryEl = el('span', 'settings-section-summary', summary)
    head.append(caret, titleEl, summaryEl)
    head.onclick = () => {
      const next = acc.dataset.open !== 'true'
      acc.dataset.open = next ? 'true' : 'false'
      head.setAttribute('aria-expanded', next ? 'true' : 'false')
      if (next) openSections.add(id)
      else openSections.delete(id)
      settingsOpenPersist(openSections)
    }
    acc.appendChild(head)
    const body = el('div', 'settings-section-body')
    body.id = `settings-body-${id}`
    acc.appendChild(body)
    return { acc, head, body }
  }

  // ── static sections (connection/appearance/preferences + config
  // provenance; placeholders only when the registry data is unavailable) ──
  for (const section of settingsSectionsForData(hasConfig)) {
    const { acc, body } = makeAccordion(section.id, settingsKey(section.titleKey), settingsKey(section.summaryKey), section.defaultCollapsed)
    for (const row of section.rows) {
      const rowEl = el('div', 'settings-row')
      rowEl.dataset.row = row.id
      rowEl.appendChild(el('span', 'settings-row-label', settingsKey(row.labelKey)))
      const slot = el('div', 'settings-row-slot')
      slot.dataset.slot = row.id
      if (row.valueKey !== undefined) {
        slot.appendChild(el('span', 'mono', settingsKey(row.valueKey, row.valueParams)))
      }
      if (row.actionKey !== undefined) {
        const btn = el('button', 'hbtn', settingsKey(row.actionKey))
        btn.dataset.action = row.id
        btn.style.cssText = 'padding:2px 10px'
        slot.appendChild(btn)
      }
      rowEl.appendChild(slot)
      body.appendChild(rowEl)
    }
    modal.appendChild(acc)
  }

  // OCR-CONFIG-01: one compact built-in Provider editor. The browser sends
  // only descriptor metadata and optional SecretRef metadata; no token value
  // is accepted by this form or returned by the Provider Registry.
  {
    const currentProvider = mineruProvider(providers)
    const initial = mineruSettingsDraft(currentProvider, modelBinding)
    const { acc, body } = makeAccordion(
      'models-ocr',
      t('shell', 'shell.settings.ocr.title'),
      t('shell', 'shell.settings.ocr.summary'),
      true,
    )
    const error = el('div', 'settings-readonly-note')
    error.setAttribute('role', 'alert')
    error.setAttribute('aria-live', 'assertive')
    error.style.cssText = 'display:none;color:var(--tone-red)'
    const setError = (message: string): void => {
      error.textContent = message
      error.style.display = message === '' ? 'none' : 'block'
    }
    body.appendChild(error)
    if (providers === null) {
      setError(t('shell', 'shell.settings.ocr.loadFailed'))
    } else {
      const form = el('div', 'settings-ocr-form')
      const status = el('div', 'settings-ocr-status')
      const providerIdentity = el('div', 'settings-ocr-copy')
      providerIdentity.append(
        el('div', 'settings-row-label', t('shell', 'shell.settings.ocr.provider')),
        el('div', 'muted', t('shell', 'shell.settings.ocr.providerHint')),
      )
      status.append(
        providerIdentity,
        el('span', 'settings-chip', currentProvider === undefined
          ? t('shell', 'shell.settings.ocr.unconfigured')
          : t('shell', 'shell.settings.ocr.configured', { revision: String(currentProvider.revision) })),
      )

      const providerName = document.createElement('input')
      providerName.className = 'field-input mono'
      providerName.value = 'MinerU'
      providerName.disabled = true
      providerName.setAttribute('aria-label', t('shell', 'shell.settings.ocr.provider'))

      const enabled = document.createElement('input')
      enabled.type = 'checkbox'
      enabled.checked = initial.enabled
      const enabledWrap = el('label', 'settings-ocr-toggle')
      enabledWrap.append(enabled, document.createTextNode(t('shell', 'shell.settings.ocr.enabled')))

      const field = (labelKey: string, control: HTMLElement, hintKey?: string): HTMLElement => {
        const wrapper = el('label', 'settings-ocr-field')
        wrapper.append(el('span', 'settings-ocr-field-label', t('shell', labelKey)), control)
        if (hintKey !== undefined) wrapper.appendChild(el('span', 'muted', t('shell', hintKey)))
        return wrapper
      }
      const textInput = (value: string, placeholder = ''): HTMLInputElement => {
        const input = document.createElement('input')
        input.className = 'field-input mono'
        input.value = value
        input.placeholder = placeholder
        return input
      }
      const baseUrl = textInput(initial.baseUrl)
      baseUrl.type = 'url'

      const model = document.createElement('select')
      model.className = 'field-input'
      model.disabled = activeProject === null || activeProjectLoadFailed || modelBindingLoadFailed
      for (const modelId of MINERU_MODEL_IDS) {
        const option = document.createElement('option')
        option.value = modelId
        option.textContent = t('shell', `shell.settings.ocr.model.${modelId}`)
        option.selected = modelId === initial.modelId
        model.appendChild(option)
      }

      const useCredential = document.createElement('input')
      useCredential.type = 'checkbox'
      useCredential.checked = initial.useCredential
      const credentialToggle = el('label', 'settings-ocr-toggle')
      credentialToggle.append(useCredential, document.createTextNode(t('shell', 'shell.settings.ocr.credentialToggle')))

      const credentialFields = el('div', 'settings-ocr-secret-grid')
      const scheme = document.createElement('select')
      scheme.className = 'field-input mono'
      for (const value of ['file', 'keyring', 'vault'] as const) {
        const option = document.createElement('option')
        option.value = value
        option.textContent = value
        option.selected = value === initial.credential.scheme
        scheme.appendChild(option)
      }
      const credentialName = textInput(initial.credential.name, t('shell', 'shell.settings.targets.ref.namePlaceholder'))
      const credentialVersion = textInput(initial.credential.version, t('shell', 'shell.settings.targets.ref.optionalPlaceholder'))
      const credentialScope = textInput(initial.credential.scope, t('shell', 'shell.settings.targets.ref.optionalPlaceholder'))
      credentialFields.append(
        field('shell.settings.targets.ref.scheme', scheme),
        field('shell.settings.targets.ref.name', credentialName),
        field('shell.settings.targets.ref.version', credentialVersion),
        field('shell.settings.targets.ref.scope', credentialScope),
      )
      const refreshCredential = (): void => { credentialFields.hidden = !useCredential.checked }
      useCredential.onchange = refreshCredential
      model.onchange = () => {
        if (model.value !== 'flash') useCredential.checked = true
        refreshCredential()
      }
      refreshCredential()

      const credentialState = currentProvider?.credential === undefined
        ? null
        : el('span', 'settings-chip', t('shell', currentProvider.credential.available
          ? 'shell.settings.ocr.credentialAvailable'
          : 'shell.settings.ocr.credentialUnavailable'))

      const save = el('button', 'btn primary settings-ocr-save', t('shell', 'shell.settings.ocr.save')) as HTMLButtonElement
      if (activeProjectLoadFailed || modelBindingLoadFailed) {
        save.disabled = true
        setError(t('shell', 'shell.settings.ocr.bindingLoadFailed'))
      }
      save.onclick = async () => {
        setError('')
        const draft: MineruSettingsDraft = {
          enabled: enabled.checked,
          baseUrl: baseUrl.value,
          modelId: model.value as MineruModelId,
          useCredential: useCredential.checked,
          credential: {
            scheme: scheme.value as MineruSecretRefScheme,
            name: credentialName.value,
            version: credentialVersion.value,
            scope: credentialScope.value,
          },
        }
        save.disabled = true
        try {
          if (activeProjectLoadFailed || modelBindingLoadFailed) {
            setError(t('shell', 'shell.settings.ocr.bindingLoadFailed'))
            return
          }
          const operation = mineruSettingsOperation(
            draft, currentProvider, modelBinding, activeProject?.project_id,
          )
          const result = await apiResult<{ operations: unknown[] }>('/v1/settings/transactions', {
            method: 'POST', body: JSON.stringify({ operations: [operation] }),
          })
          if (!result.ok) {
            setError(t('shell', mineruSettingsErrorKey(result.error.code)))
            return
          }
          overlay.remove()
          void openSettingsModal(root)
        } catch {
          setError(t('shell', 'shell.settings.ocr.saveFailed'))
        } finally {
          save.disabled = false
        }
      }
      const group = (titleKey: string): HTMLElement => {
        const section = el('section', 'settings-ocr-group')
        section.appendChild(el('h3', 'settings-ocr-group-title', t('shell', titleKey)))
        return section
      }
      const providerGroup = group('shell.settings.ocr.providerGroup')
      const providerGrid = el('div', 'settings-ocr-grid')
      providerGrid.append(
        field('shell.settings.ocr.provider', providerName),
        field('shell.settings.ocr.baseUrl', baseUrl, 'shell.settings.ocr.baseUrlHint'),
      )
      providerGroup.append(enabledWrap, providerGrid)

      const projectGroup = group('shell.settings.ocr.projectGroup')
      projectGroup.appendChild(field('shell.settings.ocr.model', model, 'shell.settings.ocr.modelHint'))
      if (activeProject === null && !activeProjectLoadFailed) {
        projectGroup.appendChild(el('div', 'settings-readonly-note', t('shell', 'shell.settings.ocr.noProject')))
      }

      const credentialGroup = group('shell.settings.ocr.credentialGroup')
      credentialGroup.append(credentialToggle, credentialFields)
      if (credentialState !== null) credentialGroup.appendChild(credentialState)
      credentialGroup.appendChild(el('div', 'settings-ocr-help', t('shell', 'shell.settings.ocr.credentialHint')))

      const footer = el('div', 'settings-ocr-footer')
      footer.append(
        el('div', 'settings-readonly-note', t('shell', 'shell.settings.ocr.executionPending')),
        save,
      )
      form.append(status, providerGroup, projectGroup, credentialGroup, footer)
      body.appendChild(form)
    }
    modal.appendChild(acc)
  }

  // A failed registry read must remain visible and retryable instead of
  // silently removing the whole experiment-environment section.
  if (runnerTargets === null) {
    const { acc, body } = makeAccordion(
      'runner-targets-unavailable',
      t('shell', 'shell.settings.targets.title'),
      t('shell', 'shell.settings.targets.loadFailed'),
      false,
    )
    const failure = el('div', 'settings-readonly-note', t('shell', 'shell.settings.targets.loadFailed'))
    failure.style.color = 'var(--tone-red)'
    const retry = el('button', 'hbtn', t('shell', 'shell.settings.targets.retry')) as HTMLButtonElement
    retry.onclick = () => { overlay.remove(); void openSettingsModal(root) }
    body.append(failure, retry)
    modal.appendChild(acc)
  }

  // EXEC-ENV-02: the persisted runner target registry is a writable,
  // dedicated accordion. It deliberately sits outside CONFIG-01: project
  // config selects an opaque target id, while this global operator surface
  // manages the actual local-process/local-docker/remote-ssh descriptors.
  if (runnerTargets !== null) {
    const { acc, body } = makeAccordion(
      'runner-targets',
      t('shell', 'shell.settings.targets.title'),
      t('shell', 'shell.settings.targets.summary', { count: String(runnerTargets.length) }),
      true,
    )
    const error = el('div', 'settings-readonly-note')
    error.style.cssText = 'display:none;color:var(--tone-red)'
    body.appendChild(error)
    const setError = (message: string): void => {
      error.textContent = message
      error.style.display = message === '' ? 'none' : 'block'
    }
    if (activeProject !== null) {
      const projectTarget = el('div', 'settings-row settings-row-stack')
      projectTarget.style.cssText = 'padding:10px;border:1px solid var(--border);border-radius:var(--radius-sm);gap:7px'
      projectTarget.append(
        el('div', 'settings-row-label', t('shell', 'shell.settings.targets.projectDefault')),
        el('div', 'muted', t('shell', 'shell.settings.targets.projectDefaultHint', { project: activeProject.name })),
      )
      const select = document.createElement('select')
      select.className = 'field-input'
      select.style.cssText = 'width:100%'
      for (const target of runnerTargets) {
        const option = document.createElement('option')
        option.value = target.target_id
        option.textContent = t('shell', 'shell.settings.targets.option', {
          name: target.display_name,
          kind: t('shell', `shell.settings.targets.kind.${target.kind}`),
          health: t('shell', `shell.settings.targets.health.${target.health}`),
        })
        option.selected = target.target_id === activeProject.execution.runner_target_id
        option.disabled = !target.enabled || target.draining || target.health === 'offline'
        select.appendChild(option)
      }
      const projectConfigRevision = effective?.revisions?.project
      projectTarget.appendChild(select)
      if (typeof projectConfigRevision === 'number') {
        const saveDefault = el('button', 'hbtn', t('shell', 'shell.settings.targets.saveProjectDefault')) as HTMLButtonElement
        saveDefault.onclick = async () => {
          setError('')
          saveDefault.disabled = true
          const result = await apiResult<{ operations: unknown[] }>('/v1/settings/transactions', {
            method: 'POST',
            body: JSON.stringify({ operations: [{
              kind: 'config',
              scope: 'project',
              scope_id: activeProject.project_id,
              expected_revision: projectConfigRevision,
              changes: { 'execution.runner_target_id': select.value },
            }] }),
          })
          saveDefault.disabled = false
          if (!result.ok) {
            setError(result.error.message ?? t('shell', 'shell.settings.targets.projectDefaultFailed'))
            return
          }
          overlay.remove()
          void state.rerender()
          void openSettingsModal(root)
        }
        projectTarget.appendChild(saveDefault)
      } else {
        projectTarget.appendChild(el('div', 'settings-readonly-note', t('shell', 'shell.settings.writeUnavailable')))
      }
      body.appendChild(projectTarget)
    } else {
      const noProject = el('div', 'settings-readonly-note', t('shell', 'shell.settings.targets.noActiveProject'))
      body.appendChild(noProject)
    }
    const textInput = (value: string, placeholder: string): HTMLInputElement => {
      const input = document.createElement('input')
      input.className = 'field-input mono'
      input.value = value
      input.placeholder = placeholder
      input.style.cssText = 'width:100%;box-sizing:border-box'
      return input
    }
    const kindSelect = (value: RunnerTargetKindLite): HTMLSelectElement => {
      const select = document.createElement('select')
      select.className = 'field-input'
      for (const kind of ['local-process', 'local-docker', 'remote-ssh'] as const) {
        const option = document.createElement('option')
        option.value = kind
        option.textContent = t('shell', `shell.settings.targets.kind.${kind}`)
        option.selected = kind === value
        select.appendChild(option)
      }
      return select
    }
    const secretRefEditor = (
      roleKey: string,
      ref?: SecretRefViewLite,
    ): { root: HTMLElement; payload: () => RunnerTargetSecretRefPayload | null } => {
      const draft = runnerTargetSecretRefDraft(ref)
      const root = el('div')
      root.style.cssText = 'padding:7px;border:1px solid var(--border);border-radius:var(--radius-sm)'
      root.appendChild(el('div', 'settings-row-label', t('shell', roleKey)))
      const grid = el('div')
      grid.style.cssText = 'display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:6px;margin-top:6px'
      const scheme = document.createElement('select')
      scheme.className = 'field-input mono'
      for (const value of ['file', 'keyring', 'vault'] as const) {
        const option = document.createElement('option')
        option.value = value
        option.textContent = value
        option.selected = value === draft.scheme
        scheme.appendChild(option)
      }
      const name = textInput(draft.name, t('shell', 'shell.settings.targets.ref.namePlaceholder'))
      const version = textInput(draft.version, t('shell', 'shell.settings.targets.ref.optionalPlaceholder'))
      const scope = textInput(draft.scope, t('shell', 'shell.settings.targets.ref.optionalPlaceholder'))
      const field = (labelKey: string, control: HTMLElement): HTMLElement => {
        const wrapper = el('label')
        wrapper.style.cssText = 'display:flex;flex-direction:column;gap:3px;min-width:0'
        wrapper.append(el('span', 'muted', t('shell', labelKey)), control)
        return wrapper
      }
      grid.append(
        field('shell.settings.targets.ref.scheme', scheme),
        field('shell.settings.targets.ref.name', name),
        field('shell.settings.targets.ref.version', version),
        field('shell.settings.targets.ref.scope', scope),
      )
      root.appendChild(grid)
      return {
        root,
        payload: () => runnerTargetSecretRefPayload({
          scheme: scheme.value as RunnerTargetSecretRefScheme,
          name: name.value,
          version: version.value,
          scope: scope.value,
        }),
      }
    }
    const targetForm = (
      target?: RunnerTargetSafeViewLite,
    ): { form: HTMLElement; save: HTMLButtonElement } => {
      const form = el('div', 'settings-row settings-row-stack')
      form.style.cssText = 'display:grid;grid-template-columns:minmax(0,1fr);width:100%;padding:10px;border:1px solid var(--border);border-radius:var(--radius-sm);gap:7px'
      const id = textInput(target?.target_id ?? '', t('shell', 'shell.settings.targets.idPlaceholder'))
      id.disabled = target !== undefined
      const name = textInput(target?.display_name ?? '', t('shell', 'shell.settings.targets.namePlaceholder'))
      const kind = kindSelect(target?.kind ?? 'local-docker')
      const caps = textInput(target?.capabilities.join(', ') ?? '', t('shell', 'shell.settings.targets.capabilitiesPlaceholder'))
      const runtimeDraft = runnerTargetRuntimeDraft(target?.runtime)
      const image = textInput(runtimeDraft.imageDigest || DEFAULT_DOCKER_IMAGE_DIGEST, t('shell', 'shell.settings.targets.image'))
      const compute = document.createElement('select')
      compute.className = 'field-input'
      for (const value of ['cpu', 'nvidia'] as const) {
        const option = document.createElement('option')
        option.value = value
        option.textContent = t('shell', `shell.settings.targets.compute.${value}`)
        option.selected = value === runtimeDraft.computeMode
        compute.appendChild(option)
      }
      const devices = textInput(runtimeDraft.devices, t('shell', 'shell.settings.targets.devices'))
      const runtimeFields = el('div')
      runtimeFields.style.cssText = 'display:grid;grid-template-columns:1fr;gap:7px;padding:8px;border:1px solid var(--border);border-radius:var(--radius-sm)'
      const labeled = (labelKey: string, control: HTMLElement, hintKey?: string): HTMLElement => {
        const wrapper = el('label')
        wrapper.style.cssText = 'display:flex;flex-direction:column;gap:4px;min-width:0'
        wrapper.append(el('span', 'settings-row-label', t('shell', labelKey)), control)
        if (hintKey !== undefined) wrapper.appendChild(el('span', 'muted', t('shell', hintKey)))
        return wrapper
      }
      const deviceField = labeled('shell.settings.targets.devices', devices, 'shell.settings.targets.devicesHint')
      runtimeFields.append(
        el('div', 'settings-row-label', t('shell', 'shell.settings.targets.runtime')),
        labeled('shell.settings.targets.image', image, 'shell.settings.targets.imageHint'),
        labeled('shell.settings.targets.compute', compute),
        deviceField,
      )
      const serviceIdentity = secretRefEditor(
        'shell.settings.targets.ref.serviceIdentity',
        target?.service_identity,
      )
      const identityFields = el('div')
      identityFields.style.cssText = 'display:grid;grid-template-columns:1fr;gap:6px'
      identityFields.append(
        el('span', 'muted', t('shell', 'shell.settings.targets.serviceIdentityHint')),
        serviceIdentity.root,
      )
      const endpoint = secretRefEditor('shell.settings.targets.ref.endpoint', target?.connection?.endpoint)
      const credential = secretRefEditor('shell.settings.targets.ref.credential', target?.connection?.credential)
      const knownHosts = secretRefEditor('shell.settings.targets.ref.knownHosts', target?.connection?.known_hosts)
      const remoteFields = el('div')
      remoteFields.style.cssText = 'display:grid;grid-template-columns:1fr;gap:6px'
      remoteFields.append(
        el('span', 'muted', t('shell', 'shell.settings.targets.secretRefHint')),
        endpoint.root,
        credential.root,
        knownHosts.root,
      )
      const refreshConditionalFields = (): void => {
        const localProcess = kind.value === 'local-process'
        runtimeFields.style.display = localProcess ? 'none' : 'grid'
        remoteFields.style.display = kind.value === 'remote-ssh' ? 'grid' : 'none'
        deviceField.style.display = !localProcess && compute.value === 'nvidia' ? 'flex' : 'none'
      }
      kind.onchange = refreshConditionalFields
      compute.onchange = refreshConditionalFields
      refreshConditionalFields()
      const flags = el('label', 'row')
      flags.style.cssText = 'gap:14px;font-size:11px'
      const enabled = document.createElement('input')
      enabled.type = 'checkbox'; enabled.checked = target?.enabled ?? true
      const draining = document.createElement('input')
      draining.type = 'checkbox'; draining.checked = target?.draining ?? false
      const enabledWrap = el('span', 'row'); enabledWrap.append(enabled, document.createTextNode(t('shell', 'shell.settings.targets.enabled')))
      const drainingWrap = el('span', 'row'); drainingWrap.append(draining, document.createTextNode(t('shell', 'shell.settings.targets.draining')))
      flags.append(enabledWrap, drainingWrap)
      const save = el('button', 'hbtn', target === undefined
        ? t('shell', 'shell.settings.targets.create')
        : t('common', 'common.action.save')) as HTMLButtonElement
      save.onclick = async () => {
        setError('')
        const targetKind = kind.value as RunnerTargetKindLite
        const runtimeResult = runnerTargetRuntimePayload(targetKind, {
          imageDigest: image.value,
          computeMode: compute.value as 'cpu' | 'nvidia',
          devices: devices.value,
        })
        if (!runtimeResult.ok) {
          setError(t('shell', runtimeResult.error === 'image'
            ? 'shell.settings.targets.runtimeImageInvalid'
            : 'shell.settings.targets.runtimeDevicesInvalid'))
          return
        }
        const serviceIdentityPayload = serviceIdentity.payload()
        if (serviceIdentityPayload === null) {
          setError(t('shell', 'shell.settings.targets.serviceIdentityInvalid'))
          return
        }
        let connection: { endpoint: RunnerTargetSecretRefPayload; credential: RunnerTargetSecretRefPayload; known_hosts: RunnerTargetSecretRefPayload } | undefined
        if (targetKind === 'remote-ssh') {
          const endpointRef = endpoint.payload()
          const credentialRef = credential.payload()
          const knownHostsRef = knownHosts.payload()
          if (endpointRef === null || credentialRef === null || knownHostsRef === null) {
            setError(t('shell', 'shell.settings.targets.secretRefInvalid'))
            return
          }
          connection = { endpoint: endpointRef, credential: credentialRef, known_hosts: knownHostsRef }
        }
        save.disabled = true
        const shared = {
          display_name: name.value.trim(),
          kind: targetKind,
          enabled: enabled.checked,
          draining: draining.checked,
          capabilities: caps.value.split(',').map(value => value.trim()).filter(Boolean),
          service_identity: serviceIdentityPayload,
          ...(runtimeResult.runtime !== undefined
            ? { runtime: runtimeResult.runtime }
            : { ...(target?.runtime !== undefined ? { runtime: null } : {}) }),
          ...(connection !== undefined ? { connection } : { ...(target?.connection !== undefined ? { connection: null } : {}) }),
        }
        const operation = target === undefined
          ? runnerTargetSettingsOperation({
            action: 'create',
            input: {
              target_id: id.value.trim(), display_name: shared.display_name, kind: shared.kind,
              enabled: shared.enabled, draining: shared.draining, capabilities: shared.capabilities,
              service_identity: shared.service_identity,
              ...(runtimeResult.runtime === undefined ? {} : { runtime: runtimeResult.runtime }),
              ...(connection === undefined ? {} : { connection }),
            },
          })
          : runnerTargetSettingsOperation({
            action: 'update', target_id: target.target_id,
            patch: { expected_revision: target.revision, ...shared },
          })
        const result = await apiResult<{ operations: unknown[] }>('/v1/settings/transactions', {
          method: 'POST', body: JSON.stringify({ operations: [operation] }),
        })
        save.disabled = false
        if (!result.ok) {
          setError(result.error?.message ?? t('shell', 'shell.settings.targets.saveFailed'))
          return
        }
        overlay.remove()
        void openSettingsModal(root)
      }
      form.append(
        id,
        name,
        labeled('shell.settings.targets.location', kind),
        identityFields,
        runtimeFields,
        remoteFields,
        labeled('shell.settings.targets.capabilities', caps),
        flags,
        save,
      )
      return { form, save }
    }
    for (const target of runnerTargets) {
      const row = el('div', 'settings-row settings-row-stack')
      row.style.cssText = 'gap:5px'
      const title = el('div', 'row')
      title.style.cssText = 'justify-content:space-between;width:100%'
      const identity = el('div')
      identity.append(
        el('div', 'settings-row-label', target.display_name),
        el('div', 'mono muted', t('shell', 'shell.settings.targets.identity', {
          id: target.target_id,
          kind: t('shell', `shell.settings.targets.kind.${target.kind}`),
          revision: String(target.revision),
        })),
      )
      const status = el('span', 'settings-chip', target.draining
        ? t('shell', 'shell.settings.targets.statusDraining')
        : target.enabled ? t('shell', `shell.settings.targets.health.${target.health}`) : t('shell', 'shell.settings.targets.statusDisabled'))
      title.append(identity, status)
      const meta = el('div', 'muted', target.capabilities.length > 0 ? target.capabilities.join(' · ') : '—')
      meta.style.cssText = 'font-size:10px'
      if (target.connection !== undefined) {
        const available = [target.connection.endpoint, target.connection.credential, target.connection.known_hosts].every(ref => ref.available)
        meta.appendChild(document.createTextNode(` · ${t('shell', available ? 'shell.settings.targets.secretsAvailable' : 'shell.settings.targets.secretsUnavailable')}`))
      }
      if (target.service_identity !== undefined) {
        meta.appendChild(document.createTextNode(` · ${t('shell', target.service_identity.available
          ? 'shell.settings.targets.identityAvailable'
          : 'shell.settings.targets.identityUnavailable')}`))
      }
      if (target.runtime !== undefined) {
        const computeLabel = target.runtime.compute.mode === 'cpu'
          ? t('shell', 'shell.settings.targets.compute.cpu')
          : `${t('shell', 'shell.settings.targets.compute.nvidia')} · ${target.runtime.compute.devices === 'all' ? 'all' : target.runtime.compute.devices.join(',')}`
        const imageLabel = `${target.runtime.image_digest.split('@')[0]}@…${target.runtime.image_digest.slice(-10)}`
        meta.appendChild(document.createTextNode(` · ${t('shell', 'shell.settings.targets.runtimeSummary', { image: imageLabel, compute: computeLabel })}`))
        meta.title = target.runtime.image_digest
      }
      const edit = el('button', 'hbtn', t('shell', 'shell.settings.targets.edit')) as HTMLButtonElement
      edit.style.cssText = 'align-self:flex-start;padding:2px 10px'
      const form = targetForm(target).form
      form.style.display = 'none'
      edit.onclick = () => { form.style.display = form.style.display === 'none' ? 'grid' : 'none' }
      row.append(title, meta, edit, form)
      body.appendChild(row)
    }
    const create = el('button', 'hbtn', t('shell', 'shell.settings.targets.add')) as HTMLButtonElement
    const createForm = targetForm().form
    createForm.style.display = 'none'
    create.onclick = () => { createForm.style.display = createForm.style.display === 'none' ? 'grid' : 'none' }
    body.append(create, createForm)
    modal.appendChild(acc)
  }

  // ── CONFIG-01 dynamic sections: one Accordion per ConfigScope generated
  // from /v1/config/schema + /v1/config/effective (replaces the runner /
  // workspace / terminal / tex / agent placeholders) ──
  if (dynamicSections.length > 0) {
    const configEdits = new Map<string, string>()
    const configFieldErrors = new Map<string, HTMLElement>()
    const allConfigFields = dynamicSections.flatMap(section => section.fields)
    /** One schema field row: label + value (secret-masked) + meta + desc. */
    const renderConfigField = (field: SettingsConfigField): HTMLElement => {
      const row = el('div', 'settings-row settings-row-stack')
      row.dataset.row = `config.${field.key}`
      row.appendChild(el('span', 'settings-row-label', settingsKey(field.labelKey)))
      const slot = el('div', 'settings-row-slot')
      const display = settingsFieldDisplay(field)
      const valueEl = el('span', 'mono settings-field-value')
      if (display.kind === 'secret') {
        // SecretRef future note: the server effective view is already
        // redacted; the client only renders the mask, never a plaintext.
        valueEl.textContent = t('shell', 'shell.settings.secretSet')
        valueEl.style.color = 'var(--text-2)'
        slot.appendChild(valueEl)
      } else if (display.kind === 'none') {
        valueEl.textContent = t('shell', 'shell.settings.valueNone')
        slot.appendChild(valueEl)
      } else {
        valueEl.textContent = String(display.value ?? '') || '—'
        if (display.kind === 'absent') {
          const note = el('span', 'muted', settingsKey('shell.settings.notInEffective'))
          note.style.cssText = 'font-size:10px'
          slot.append(valueEl, note)
        } else {
          slot.appendChild(valueEl)
        }
      }
      const writeScope = field.writeScopes.length === 1 ? field.writeScopes[0] : undefined
      const editable = effective?.revisions !== undefined && (
        writeScope === 'global'
        || (writeScope === 'project' && activeProject !== null)
        || writeScope === 'runtime'
      )
      if (editable) {
        let control: HTMLInputElement | HTMLSelectElement
        if (field.kind === 'enum') {
          control = document.createElement('select')
          for (const member of field.enumValues) {
            const option = document.createElement('option')
            option.value = String(member)
            option.textContent = String(member)
            option.selected = member === field.value
            control.appendChild(option)
          }
        } else if (field.kind === 'boolean') {
          control = document.createElement('select')
          for (const member of ['true', 'false']) {
            const option = document.createElement('option')
            option.value = member
            option.textContent = member
            option.selected = String(field.value) === member
            control.appendChild(option)
          }
        } else {
          control = document.createElement('input')
          control.type = field.kind === 'number' ? 'number' : 'text'
          if (field.minimum !== undefined) control.min = String(field.minimum)
          if (field.maximum !== undefined) control.max = String(field.maximum)
          control.value = field.secret ? '' : field.value === null ? 'null' : String(field.value ?? field.default ?? '')
          if (field.secret) control.placeholder = t('shell', 'shell.settings.secretRefPlaceholder')
        }
        control.className = 'field-input mono'
        control.dataset.configKey = field.key
        const remember = (): void => { configEdits.set(field.key, control.value) }
        control.addEventListener('input', remember)
        control.addEventListener('change', remember)
        slot.appendChild(control)
        const fieldError = el('div', 'settings-field-error')
        fieldError.style.cssText = 'display:none;color:var(--tone-red);font-size:11px'
        fieldError.setAttribute('aria-live', 'polite')
        configFieldErrors.set(field.key, fieldError)
        slot.appendChild(fieldError)
      }
      // meta chips: scope · sources · reload verdict · floor · env
      const meta = el('div', 'settings-field-meta')
      const chips: Array<{ text: string; color: string }> = [
        { text: t('shell', 'shell.settings.scopeLabel', { scope: settingsKey(`shell.settings.scope.${field.scope}`) }), color: '' },
        { text: t('shell', 'shell.settings.sourcesLabel', { sources: field.sources.join('/') }), color: '' },
        {
          text: field.reload === 'hot' ? t('shell', 'shell.settings.reloadHot') : t('shell', 'shell.settings.reloadRestart'),
          color: field.reload === 'hot' ? 'var(--tone-green)' : 'var(--tone-amber)',
        },
      ]
      if (field.securityFloor) chips.push({ text: t('shell', 'shell.settings.securityFloor'), color: 'var(--tone-red)' })
      if (field.env !== undefined) chips.push({ text: t('shell', 'shell.settings.envAlias', { env: field.env }), color: '' })
      for (const chip of chips) {
        const chipEl = el('span', 'settings-chip', chip.text)
        if (chip.color !== '') chipEl.style.color = chip.color
        meta.appendChild(chipEl)
      }
      slot.appendChild(meta)
      if (field.description !== '') {
        // raw registry description — wire/model text displayed verbatim (§8 line 115)
        slot.appendChild(el('div', 'settings-field-desc', field.description))
      }
      row.appendChild(slot)
      return row
    }

    const configSectionEl = modal.querySelector('[data-section="config"]')
    const holder = el('div')
    for (const section of dynamicSections) {
      if (section.fields.length === 0) continue
      const { acc, body } = makeAccordion(section.id, settingsKey(section.titleKey), settingsKey(section.summaryKey), true)
      for (const field of section.fields) body.appendChild(renderConfigField(field))
      holder.appendChild(acc)
    }
    const write = settingsConfigWrite()
    const footer = el('div', 'settings-readonly-note')
    footer.appendChild(el('span', '', settingsKey(write.noteKey)))
    const writeStatus = el('span', 'muted')
    writeStatus.setAttribute('aria-live', 'polite')
    footer.appendChild(writeStatus)
    const writeEndpoint = write.endpoint
    if (effective?.revisions === undefined) {
      writeStatus.textContent = t('shell', 'shell.settings.writeUnavailable')
    } else {
      const saveBtn = el('button', 'hbtn', t('common', 'common.action.save')) as HTMLButtonElement
      saveBtn.style.cssText = 'padding:2px 10px'
      saveBtn.onclick = async () => {
        writeStatus.textContent = ''
        for (const error of configFieldErrors.values()) {
          error.textContent = ''
          error.style.display = 'none'
        }
        if (configEdits.size === 0) {
          writeStatus.textContent = t('shell', 'shell.settings.noChanges')
          return
        }
        let transaction: ReturnType<typeof settingsConfigTransaction>
        try {
          transaction = settingsConfigTransaction(allConfigFields, configEdits, effective, {
            projectId: activeProject?.project_id,
          })
        } catch (error) {
          if (error instanceof SettingsConfigInputError) {
            const fieldError = configFieldErrors.get(error.key)
            if (fieldError !== undefined) {
              fieldError.textContent = t('shell', 'shell.settings.configSaveFailed')
              fieldError.style.display = 'block'
            }
          }
          writeStatus.textContent = t('shell', 'shell.settings.configSaveFailed')
          return
        }
        saveBtn.disabled = true
        const result = await apiResult<{
          config: null | { verdict: { restart_required: boolean; restart_required_keys: string[] } }
          operations: unknown[]
        }>(writeEndpoint, {
          method: 'POST', body: JSON.stringify(transaction),
        })
        saveBtn.disabled = false
        if (!result.ok) {
          const mapped = mapSettingsServerErrors(allConfigFields, result.error)
          for (const [key] of mapped.byKey) {
            const fieldError = configFieldErrors.get(key)
            if (fieldError !== undefined) {
              fieldError.textContent = t('shell', 'shell.settings.configSaveFailed')
              fieldError.style.display = 'block'
            }
          }
          writeStatus.textContent = result.error.message ?? t('shell', 'shell.settings.configSaveFailed')
          return
        }
        overlay.remove()
        const verdict = result.data.config?.verdict
        showToast(root, verdict?.restart_required === true
          ? t('shell', 'shell.settings.configSavedRestart', { keys: verdict.restart_required_keys.join(', ') })
          : t('shell', 'shell.settings.configSavedHot'))
        void openSettingsModal(root)
      }
      footer.appendChild(saveBtn)
    }
    holder.appendChild(footer)
    if (configSectionEl !== null) modal.insertBefore(holder, configSectionEl)
    else modal.appendChild(holder)
  }

  /** Dynamic-slot lookup: rows without a static value get live controls. */
  const slot = (sectionId: string, rowId: string): HTMLElement | null =>
    modal.querySelector(`[data-section="${sectionId}"] [data-slot="${rowId}"]`)
  const actionBtn = (rowId: string): HTMLElement | null =>
    modal.querySelector(`[data-action="${rowId}"]`)

  // ── connection: live kernel health, auth state, endpoint + token ──
  const kernelSlot = slot('connection', 'connection.kernel')
  if (kernelSlot !== null) {
    const up = health !== null && health.ok === true
    const value = el('span', 'mono', up
      ? t('common', 'common.status.connectedTo', { instance: health?.instance ?? '' })
      : t('common', 'common.status.unreachable'))
    value.style.cssText = 'font-size:11px'
    value.style.color = up ? 'var(--tone-green)' : 'var(--tone-red)'
    kernelSlot.appendChild(value)
  }
  const authSlot = slot('connection', 'connection.auth')
  if (authSlot !== null) {
    authSlot.appendChild(el('span', 'mono', tokenProvider !== undefined
      ? t('shell', 'shell.settings.authToken')
      : t('shell', 'shell.settings.authNone')))
  }
  const endpointSlot = slot('connection', 'connection.endpoint')
  if (endpointSlot !== null) {
    const bridgeEnd = `${location.origin}${base()}/v1`
    const value = el('span', 'mono', bridgeEnd)
    value.style.cssText = 'flex:1'
    const copy = el('button', 'hbtn', '⧉')
    copy.title = t('shell', 'shell.settings.copyEndpoint')
    copy.style.cssText = 'padding:1px 8px'
    copy.onclick = () => copyText(bridgeEnd)
    endpointSlot.append(value, copy)
  }
  // Access token row (standalone only); hidden without a token provider.
  const tokenRow = modal.querySelector('[data-section="connection"] [data-row="connection.token"]')
  if (tokenProvider !== undefined && tokenRow !== null) {
    const tokenSlot = slot('connection', 'connection.token')
    if (tokenSlot !== null) {
      const value = el('span', 'mono', '••••••••')
      const reveal = el('button', 'hbtn', t('common', 'common.action.show'))
      reveal.style.cssText = 'padding:1px 8px'
      reveal.onclick = async () => {
        const tok = await tokenProvider?.()
        value.textContent = tok ?? t('shell', 'shell.settings.tokenNone')
        reveal.remove()
      }
      const copyTok = el('button', 'hbtn', '⧉')
      copyTok.title = t('shell', 'shell.settings.copyToken')
      copyTok.style.cssText = 'padding:1px 8px'
      copyTok.onclick = async () => {
        const tok = await tokenProvider?.()
        if (tok != null) copyText(tok)
      }
      tokenSlot.append(value, reveal, copyTok)
    }
  } else {
    tokenRow?.remove()
  }

  // ── appearance: theme / accent / corners / texture ──
  const themeSlot = slot('appearance', 'appearance.theme')
  if (themeSlot !== null) {
    const value = el('span', 'mono', readTheme() === 'dark' ? 'dark' : 'light')
    const toggle = el('button', 'hbtn', t('common', 'common.action.toggle'))
    toggle.style.cssText = 'padding:1px 8px'
    toggle.onclick = () => {
      const next = readTheme() === 'dark' ? 'light' : 'dark'
      writeTheme(next)
      const hostEl = root.host as HTMLElement
      hostEl.dataset.theme = next
      value.textContent = next
      // Refresh the header button label too.
      document.dispatchEvent(new Event('dsh-scholar-theme-changed'))
    }
    themeSlot.append(value, toggle)
  }
  const accentSlot = slot('appearance', 'appearance.accent')
  if (accentSlot !== null) {
    const accentSelect = el('select', 'picker')
    accentSelect.style.cssText = 'flex:1;padding:3px 6px;font-size:11px;border-radius:7px'
    const currentAccent = (Object.entries(ACCENTS).find(([, v]) => v === accentColor())?.[0] ?? 'blue')
    for (const [name, color] of Object.entries(ACCENTS)) {
      const opt = el('option', '', `${name} (${color})`)
      opt.value = name
      accentSelect.appendChild(opt)
    }
    accentSelect.value = currentAccent
    accentSelect.onchange = () => {
      accentSet(accentSelect.value)
      const hostEl = document.querySelector('#dsh-scholar-ui') as HTMLElement | null
      const dark = hostEl?.dataset.theme === 'dark'
      const name = accentSelect.value
      const c = dark ? (ACCENT_DARK[name] ?? accentColor()) : accentColor()
      hostEl?.style.setProperty('--accent', c)
      hostEl?.style.setProperty('--accent-soft', `${c}1f`)
      hostEl?.style.setProperty('--accent-text', c)
      state.rerender()
    }
    accentSlot.appendChild(accentSelect)
  }
  const radiusSlot = slot('appearance', 'appearance.corners')
  if (radiusSlot !== null) {
    const radiusSelect = el('select', 'picker')
    radiusSelect.style.cssText = 'flex:1;padding:3px 6px;font-size:11px;border-radius:7px'
    const currentRadius = Object.entries(RADII).find(([, v]) => v === radiusValue())?.[0] ?? 'normal'
    for (const [name, val] of Object.entries(RADII)) {
      const opt = el('option', '', `${name} (${val})`)
      opt.value = name
      radiusSelect.appendChild(opt)
    }
    radiusSelect.value = currentRadius
    radiusSelect.onchange = () => {
      radiusSet(radiusSelect.value)
      const hostEl = document.querySelector('#dsh-scholar-ui') as HTMLElement | null
      hostEl?.style.setProperty('--panel-radius', radiusValue())
      state.rerender()
    }
    radiusSlot.appendChild(radiusSelect)
  }
  const textureSlot = slot('appearance', 'appearance.texture')
  if (textureSlot !== null) {
    const textureSelect = el('select', 'picker')
    textureSelect.style.cssText = 'flex:1;padding:3px 6px;font-size:11px;border-radius:7px'
    const currentTexture = textureValue()
    for (const name of Object.keys(TEXTURES)) {
      const opt = el('option', '', name)
      opt.value = name
      textureSelect.appendChild(opt)
    }
    textureSelect.value = currentTexture
    textureSelect.onchange = () => {
      textureSet(textureSelect.value)
      const hostEl = document.querySelector('#dsh-scholar-ui') as HTMLElement | null
      if (hostEl !== null) hostEl.dataset.texture = textureValue()
      state.rerender()
    }
    textureSlot.appendChild(textureSelect)
  }
  // ── preferences: language / auto-refresh / transcript / summary / actions ──
  const localeSlot = slot('preferences', 'preferences.language')
  if (localeSlot !== null) {
    const localeSelect = el('select', 'picker')
    localeSelect.style.cssText = 'flex:1;padding:3px 6px;font-size:11px;border-radius:7px'
    const localeCurrent = getLocale()
    for (const [code, label] of [['zh', t('shell', 'shell.locale.zh')], ['en', t('shell', 'shell.locale.en')]] as Array<[string, string]>) {
      const opt = el('option', '', label)
      opt.value = code
      localeSelect.appendChild(opt)
    }
    localeSelect.value = localeCurrent
    localeSelect.onchange = () => {
      const next = localeSelect.value === 'zh' ? 'zh' : 'en'
      // dsh-web i18n §13.4: setLocale re-paints the shell chrome, re-renders
      // the active panel and rebuilds every open overlay (this modal
      // included) via the overlay registry — no manual reopen needed.
      setLocale(next)
      document.dispatchEvent(new Event('dsh-scholar-locale-changed'))
    }
    localeSlot.appendChild(localeSelect)
  }
  const refreshSlot = slot('preferences', 'preferences.autoRefresh')
  if (refreshSlot !== null) {
    const value = el('span', 'mono', autoRefreshEnabled() ? t('shell', 'shell.settings.polling') : t('shell', 'shell.settings.off'))
    const toggle = el('button', 'hbtn', t('common', 'common.action.toggle'))
    toggle.style.cssText = 'padding:1px 8px'
    toggle.onclick = () => {
      const next = !autoRefreshEnabled()
      autoRefreshSet(next)
      if (next && state.refreshTimer === null) state.refreshTimer = state.startRefreshTimer()
      if (!next && state.refreshTimer !== null) {
        window.clearInterval(state.refreshTimer)
        state.refreshTimer = null
      }
      value.textContent = next ? t('shell', 'shell.settings.polling') : t('shell', 'shell.settings.off')
    }
    refreshSlot.append(value, toggle)
  }
  const budgetPageSlot = slot('preferences', 'preferences.budgetPage')
  if (budgetPageSlot !== null) {
    const toggle = el('label', 'settings-ocr-toggle')
    const checkbox = document.createElement('input')
    checkbox.type = 'checkbox'
    checkbox.checked = budgetPageVisible()
    checkbox.setAttribute('aria-label', t('shell', 'shell.settings.budgetPage'))
    const status = el('span', 'mono', checkbox.checked
      ? t('shell', 'shell.settings.budgetPage.visible')
      : t('shell', 'shell.settings.budgetPage.hidden'))
    checkbox.onchange = () => {
      writeBudgetPageVisible(checkbox.checked)
      status.textContent = checkbox.checked
        ? t('shell', 'shell.settings.budgetPage.visible')
        : t('shell', 'shell.settings.budgetPage.hidden')
      state.navigationChanged()
    }
    toggle.append(checkbox, document.createTextNode(t('shell', 'shell.settings.budgetPage.toggle')))
    budgetPageSlot.append(toggle, status)
  }
  const transcriptSlot = slot('preferences', 'preferences.transcript')
  if (transcriptSlot !== null) {
    const value = el('span', 'mono', t('shell', 'shell.settings.transcriptValue', { sessions: String(state.chatSessions.length), messages: String(state.chatMessages.length) }))
    const clearBtn = el('button', 'hbtn', t('common', 'common.action.clear'))
    clearBtn.style.cssText = 'padding:1px 8px'
    clearBtn.onclick = () => {
      chatClear()
      value.textContent = t('shell', 'shell.settings.zeroMessages')
      state.rerender()
    }
    transcriptSlot.append(value, clearBtn)
  }
  const summarySlot = slot('preferences', 'preferences.summary')
  if (summarySlot !== null) {
    const summaryBtn = el('button', 'hbtn', t('common', 'common.action.copyMarkdown'))
    summaryBtn.style.cssText = 'padding:2px 10px'
    summaryBtn.onclick = async () => {
      const id = state.projectId
      if (id === undefined) return
      const p = await api<Projection>(`/v1/projects/${encodeURIComponent(id)}/projection`)
      if (p === null || p.project === undefined) {
        summaryBtn.textContent = t('common', 'common.status.unavailable')
        return
      }
      const counts = p.counts ?? {}
      const lines = [
        `# ${p.project.name}`,
        '',
        `- Project: \`${id}\``,
        `- Phase: \`${p.project.status}\` (rev ${p.project.revision ?? 0})`,
        `- Problem: ${p.project.brief?.problem ?? '—'}`,
        `- Primary metrics: ${(p.project.brief?.primary_metrics ?? []).join(', ') || '—'}`,
        `- Corpus snapshots: ${counts.corpus_snapshots ?? 0} · Ideas: ${counts.ideas ?? 0} · Contracts: ${counts.contracts ?? 0}`,
        `- Claims: ${counts.claims ?? 0} · Evidence: ${counts.evidence ?? 0} · Artifacts: ${counts.artifacts ?? 0}`,
        `- Pending gates: ${(p.pending_gates ?? []).map(g => `${g.type} (${g.status})`).join(', ') || 'none'}`,
        `- Next: ${(p.next_actions_v2 ?? []).filter(action => action.state !== 'done').map(action => action.label ?? action.code ?? 'unknown').join('; ') || '—'}`,
      ]
      await navigator.clipboard.writeText(lines.join('\n'))
      summaryBtn.textContent = t('common', 'common.action.copied')
      setTimeout(() => { summaryBtn.textContent = t('common', 'common.action.copyMarkdown') }, 1800)
    }
    summarySlot.appendChild(summaryBtn)
  }
  const shortcutsBtn = actionBtn('preferences.shortcuts')
  shortcutsBtn?.addEventListener('click', () => { overlay.remove(); openShortcutsModal(root) })
  const aboutBtn = actionBtn('preferences.about')
  aboutBtn?.addEventListener('click', () => openAboutModal(root))
  const resetBtn = actionBtn('preferences.localData')
  if (resetBtn !== null) {
    resetBtn.classList.add('cancel')
    resetBtn.title = t('shell', 'shell.settings.resetTitle')
    resetBtn.onclick = () => {
      const toRemove: string[] = []
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i)
        // The access token survives a preference reset (no forced re-login).
        if (k !== null && k.startsWith('dsh-scholar-ui-') && k !== 'dsh-scholar-ui-token') toRemove.push(k)
      }
      for (const k of toRemove) localStorage.removeItem(k)
      overlay.remove()
      showToast(rootHost(), t('shell', 'shell.settings.resetDone'))
    }
  }

  // ── config provenance: exact-scope effective config pin from CONFIG-01,
  // with a change hint vs the last
  // seen pin (persisted locally — the pin changes with ANY config change,
  // including secrets, so a change means the running config moved) ──
  const pinSlot = slot('config', 'config.pin')
  if (pinSlot !== null) {
    const pin = effective !== null ? settingsConfigPin(effective) : undefined
    if (pin !== undefined) {
      pinSlot.appendChild(el('span', 'mono', t('shell', 'shell.settings.configPinValue', { pin })))
      const PIN_KEY = 'dsh-scholar-ui-config-pin'
      let previous: string | null = null
      try { previous = localStorage.getItem(PIN_KEY) } catch { /* private mode */ }
      if (configPinChanged(previous ?? undefined, pin)) {
        const hint = el('span', '', t('shell', 'shell.settings.configPinChanged'))
        hint.style.cssText = 'font-size:10.5px;color:var(--tone-amber)'
        pinSlot.appendChild(hint)
      }
      try { localStorage.setItem(PIN_KEY, pin) } catch { /* private mode */ }
    } else {
      pinSlot.appendChild(el('span', 'mono', t('shell', 'shell.settings.configPinNone')))
    }
  }

  overlay.appendChild(modal)
  root.appendChild(overlay)
  // dsh-web i18n §13.4: locale switch re-opens the settings modal in the
  // new locale (setLocale → relocalizeOpenOverlays).
  registerOverlayRebuild(overlay, () => { overlay.remove(); void openSettingsModal(root) })
  trapFocus(overlay, null)
}


/* ─────────────────────────── about modal ─────────────────────────── */

/** dsh-web "About": version, architecture and feature-surface summary. */
export function openAboutModal(root: ShadowRoot | null | undefined): void {
  if (root == null) return
  const overlay = el('div', 'overlay')
  overlay.onclick = (event) => { if (event.target === overlay) overlay.remove() }
  const modal = el('div', 'modal')
  modal.style.cssText = 'width:520px;max-width:92vw'
  const header = el('div', 'modal-header', t('shell', 'shell.about.title'))
  const closeBtn = el('button', 'hbtn ghost', '×')
  closeBtn.onclick = () => overlay.remove()
  header.appendChild(closeBtn)
  modal.appendChild(header)

  const intro = el('div', 'muted', t('shell', 'shell.about.intro'))
  intro.style.cssText = 'font-size:12px;line-height:1.6'
  modal.appendChild(intro)

  const row = (label: string, value: string): void => {
    const r = el('div', 'row')
    r.style.cssText = 'padding:4px 0'
    const l = el('span', '', label)
    l.style.cssText = 'width:150px;color:var(--text-2);font-size:11.5px;flex-shrink:0'
    const v = el('span', 'mono', value)
    v.style.cssText = 'font-size:11px;color:var(--text);word-break:break-all'
    r.append(l, v)
    modal.appendChild(r)
  }
  modal.appendChild(el('div', 'section-label', t('shell', 'shell.about.version')))
  row(t('shell', 'shell.about.rowPlugin'), 'v0.2 (hardening branch)')
  row(t('shell', 'shell.about.rowSurface'), 'Research · Execution · Review · Operations')
  row(t('shell', 'shell.about.rowKernel'), 'Research Kernel (SQLite + CAS)')
  row(t('shell', 'shell.about.rowRunner'), 'docker isolation (baseline/pilot/formal/reproduce)')

  modal.appendChild(el('div', 'section-label', t('shell', 'shell.about.architecture')))
  const arch = el('div', 'muted', t('shell', 'shell.about.architectureText'))
  arch.style.cssText = 'font-size:11.5px;line-height:1.6'
  modal.appendChild(arch)

  modal.appendChild(el('div', 'section-label', t('shell', 'shell.about.safety')))
  const safety = el('div', 'muted', t('shell', 'shell.about.safetyText'))
  safety.style.cssText = 'font-size:11.5px;line-height:1.6'
  modal.appendChild(safety)

  const footer = el('div', 'muted', t('shell', 'shell.about.footer'))
  footer.style.cssText = 'margin-top:16px;font-size:10.5px'
  modal.appendChild(footer)

  overlay.appendChild(modal)
  root.appendChild(overlay)
  // dsh-web i18n §13.4: locale switch re-opens the about modal.
  registerOverlayRebuild(overlay, () => { overlay.remove(); openAboutModal(root) })
}
