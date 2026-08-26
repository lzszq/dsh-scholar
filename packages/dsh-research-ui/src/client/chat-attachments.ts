import { apiResult } from './api'
import {
  browserTransport,
  chatAttachmentRef,
  driveUpload,
  markHashed,
  pauseItem,
  resumeItem,
  retryItem,
  sha256File,
  type UploadQueueItem,
  type UploadSessionProjection,
} from './chunked-upload'
import { ChatVisionInputError, ChatVisionTurnStore, chatVisionBatch, chatVisionTurnStore, type BrowserImageFile, type QueuedChatVisionImage } from './chat-vision'
import { ChatUploadStore, chatUploadStore, type ChatUploadFile } from './chat-upload-store'
import { getLocale, t } from './i18n/index'
import { intakeBeginPayload } from './intake-flow'
import {
  chatPushToProjectSession,
  chatSessionExists,
  chatUpsertAttachmentForProjectSession,
} from './state'
import { el, rootHost, showToast } from './ui'
import { chatAttachmentFlightStore } from './chat-attachment-flight'

const UPLOAD_ERROR_KEYS: Readonly<Record<string, string>> = {
  attachment_intake_unavailable: 'shell.chat.upload.intakeUnavailable',
  upload_file_hash_mismatch: 'shell.chat.upload.hashMismatch',
  upload_file_reselect_required: 'shell.chat.upload.reselectRequired',
  upload_session_identity_mismatch: 'shell.chat.upload.identityMismatch',
  upload_session_unavailable: 'shell.chat.upload.sessionUnavailable',
  upload_session_aborted: 'shell.chat.upload.sessionAborted',
  upload_session_expired: 'shell.chat.upload.sessionExpired',
}

function uploadErrorText(error: string | null): string | null {
  if (error === null) return null
  const key = UPLOAD_ERROR_KEYS[error]
  return key === undefined ? error : t('shell', key)
}

export interface ChatAttachmentController {
  readonly button: HTMLButtonElement
  readonly fileInput: HTMLInputElement
  readonly queue: HTMLElement
  queuedVision(): QueuedChatVisionImage[]
  consumeVision(fileIds: readonly string[]): void
  render(): void
  mount(): void
  dispose(): void
}

export function admitChatAttachmentFiles<T extends BrowserImageFile & ChatUploadFile>(
  projectId: string,
  sessionId: string,
  files: readonly T[],
  stores: { uploads: ChatUploadStore; vision: ChatVisionTurnStore } = {
    uploads: chatUploadStore,
    vision: chatVisionTurnStore,
  },
): { items: UploadQueueItem[]; visionError: ChatVisionInputError | null } {
  let visualFiles: T[] = []
  let visionError: ChatVisionInputError | null = null
  try {
    visualFiles = chatVisionBatch(files)
  } catch (error) {
    visionError = error instanceof ChatVisionInputError
      ? error
      : new ChatVisionInputError('vision_image_rejected')
  }
  const items = stores.uploads.stage(projectId, sessionId, files)
  if (items.length === 0) return { items, visionError }
  const visualBatch = visualFiles.flatMap(file => {
    const item = items[files.indexOf(file)]
    return item === undefined ? [] : [{ fileId: item.fileId, file }]
  })
  if (visualBatch.length > 0) {
    try {
      stores.vision.stageBatch(projectId, sessionId, visualBatch)
    } catch (error) {
      visionError = error instanceof ChatVisionInputError
        ? error
        : new ChatVisionInputError('vision_image_rejected')
    }
  }
  return { items, visionError }
}

/** Owns Chat attachment admission, durable Intake upload recovery and its
 * compact queue UI. The Chat page only consumes the next-turn visual view;
 * it does not own upload drivers or File handles. */
export function createChatAttachmentController(options: {
  projectId: string
  sessionId: string
  composer: HTMLElement
  textInput: HTMLTextAreaElement
}): ChatAttachmentController {
  const { projectId, sessionId, composer, textInput } = options
  const button = el('button', 'hbtn chat-attach-button', `📎 ${t('shell', 'shell.chat.attachButton')}`)
  button.title = t('shell', 'shell.chat.attachTitle')
  button.setAttribute('aria-label', t('shell', 'shell.chat.attachTitle'))
  const fileInput = document.createElement('input')
  fileInput.type = 'file'
  fileInput.multiple = true
  fileInput.setAttribute('aria-label', t('shell', 'shell.chat.attachTitle'))
  fileInput.style.display = 'none'
  const queue = el('div', 'chat-composer-tools')
  queue.style.cssText = 'display:none;flex-wrap:wrap;gap:4px;align-items:center;font-size:10px'
  const transport = browserTransport()
  const signal = chatAttachmentFlightStore.signal(projectId, sessionId)

  const pushRef = (item: UploadQueueItem): void => {
    const ref = chatAttachmentRef(item)
    if (ref === null || ref.project_id !== projectId || chatUploadStore.item(projectId, sessionId, item.fileId) === undefined) return
    chatUpsertAttachmentForProjectSession(projectId, sessionId, {
      role: 'user',
      text: `📎 ${item.fileName}`,
      time: new Date().toLocaleTimeString(getLocale()),
      attachment: ref,
    })
  }

  const onUploadState = (item: UploadQueueItem): boolean => {
    if (!chatUploadStore.update(projectId, sessionId, item)) return false
    pushRef(item)
    return true
  }

  const continueUpload = async (item: UploadQueueItem): Promise<UploadQueueItem | null> => {
    const driveToken = chatUploadStore.beginDrive(projectId, sessionId, item.fileId)
    if (driveToken === null) return null
    try {
      const finished = await driveUpload(item, transport, {
        readBytes: (fileId, start, end) => chatUploadStore.byteProvider(projectId, sessionId).read(fileId, start, end),
        onState: onUploadState,
        shouldContinue: current => {
          const stored = chatUploadStore.item(projectId, sessionId, current.fileId)
          return stored !== undefined && stored.state !== 'paused'
        },
        signal,
        ownerScopeId: sessionId,
      })
      if (!chatUploadStore.update(projectId, sessionId, finished)) return null
      pushRef(finished)
      if (finished.state !== 'failed' && finished.state !== 'paused') {
        chatUploadStore.releaseBytes(projectId, sessionId, finished.fileId)
      }
      return finished
    } finally {
      chatUploadStore.endDrive(projectId, sessionId, item.fileId, driveToken)
    }
  }

  const render = (): void => {
    queue.replaceChildren()
    const queueItems = chatUploadStore.list(projectId, sessionId)
    const visionItems = chatVisionTurnStore.list(projectId, sessionId)
    const pendingVisionFileIds = new Set(visionItems.map(item => item.fileId))
    if (queueItems.length === 0 && visionItems.length === 0) {
      queue.style.display = 'none'
      return
    }
    queue.style.display = 'flex'
    if (pendingVisionFileIds.size > 0) {
      queue.appendChild(el('span', 'muted', t('shell', 'shell.chat.vision.pending', { count: String(pendingVisionFileIds.size) })))
    }
    for (const item of queueItems) {
      const marker = item.state === 'failed' ? '✗' : item.state === 'ready' ? '✓' : item.state === 'paused' ? '⏸' : item.state === 'uploading' ? '⏳' : '•'
      const pct = item.fileSize > 0 ? Math.round((item.committedOffset / item.fileSize) * 100) : 0
      const visual = pendingVisionFileIds.has(item.fileId) ? ' 👁' : ''
      const progress = item.committedOffset < item.fileSize ? `${pct}%` : ''
      const chipLabel = [`${marker}${visual}`, item.fileName, progress].filter(Boolean).join(' ')
      const chip = el('span', 'artifact-kind', chipLabel)
      chip.title = uploadErrorText(item.lastError) ?? item.state
      const actions = el('span')
      if (item.state === 'uploading' || item.state === 'queued') {
        const pause = el('button', 'hbtn', '⏸')
        pause.title = t('shell', 'shell.chat.attachPause')
        pause.style.cssText = 'padding:0 4px;font-size:9px'
        pause.onclick = () => {
          const paused = pauseItem(item)
          chatUploadStore.update(projectId, sessionId, paused)
          pushRef(paused)
        }
        actions.appendChild(pause)
      } else if (item.state === 'paused') {
        const resume = el('button', 'hbtn', '▶')
        resume.title = t('shell', 'shell.chat.attachResume')
        resume.style.cssText = 'padding:0 4px;font-size:9px'
        resume.onclick = () => {
          const resumed = resumeItem(item)
          chatUploadStore.update(projectId, sessionId, resumed)
          void continueUpload(resumed)
        }
        actions.appendChild(resume)
      } else if (item.state === 'failed' && item.retryCount < 3) {
        const retry = el('button', 'hbtn', '↻')
        retry.title = t('shell', 'shell.chat.attachRetry')
        retry.style.cssText = 'padding:0 4px;font-size:9px'
        retry.onclick = () => {
          if (item.uploadId === null || item.intakeId === null || !chatUploadStore.hasBytes(projectId, sessionId, item.fileId)) {
            fileInput.click()
            return
          }
          const retried = retryItem(item)
          chatUploadStore.update(projectId, sessionId, retried)
          void continueUpload(retried)
        }
        actions.appendChild(retry)
      }
      if (pendingVisionFileIds.has(item.fileId)) {
        const removeVisual = el('button', 'hbtn', '×')
        removeVisual.title = t('shell', 'shell.chat.vision.remove', { name: item.fileName })
        removeVisual.setAttribute('aria-label', removeVisual.title)
        removeVisual.style.cssText = 'padding:0 4px;font-size:9px'
        removeVisual.onclick = () => {
          chatVisionTurnStore.remove(projectId, sessionId, item.fileId)
          render()
        }
        actions.appendChild(removeVisual)
      }
      chip.appendChild(actions)
      queue.appendChild(chip)
    }
    const uploadFileIds = new Set(queueItems.map(item => item.fileId))
    for (const item of visionItems) {
      if (uploadFileIds.has(item.fileId)) continue
      const chip = el('span', 'artifact-kind', `• 👁 ${item.file.name}`)
      chip.title = t('shell', 'shell.chat.vision.pending', { count: '1' })
      const removeVisual = el('button', 'hbtn', '×')
      removeVisual.title = t('shell', 'shell.chat.vision.remove', { name: item.file.name })
      removeVisual.setAttribute('aria-label', removeVisual.title)
      removeVisual.style.cssText = 'padding:0 4px;font-size:9px;margin-left:4px'
      removeVisual.onclick = () => {
        chatVisionTurnStore.remove(projectId, sessionId, item.fileId)
        render()
      }
      chip.appendChild(removeVisual)
      queue.appendChild(chip)
    }
  }

  let unsubscribe: (() => void) | null = null
  const bindView = (): void => {
    if (unsubscribe !== null) return
    unsubscribe = chatUploadStore.subscribe(projectId, sessionId, () => {
      if (!queue.isConnected) {
        unsubscribe?.()
        unsubscribe = null
        return
      }
      render()
    })
  }

  let intakeRequest: Promise<string | null> | null = null
  const ensureIntake = async (): Promise<string | null> => {
    if (signal === undefined || signal.aborted) return null
    if (intakeRequest !== null) return intakeRequest
    intakeRequest = (async () => {
      // Always enter through scoped begin. Kernel atomically selects only an
      // unscoped or exact-scope active Intake, or creates a new scoped one.
      const created = await apiResult<{ intake_id?: string }>(`/v1/projects/${encodeURIComponent(projectId)}/intake`, {
        method: 'POST',
        body: JSON.stringify({
          ...intakeBeginPayload('Scholar chat attachments', null),
          owner_scope_id: sessionId,
        }),
        signal,
      })
      if (signal.aborted) return null
      return created.ok && typeof created.data.intake_id === 'string' ? created.data.intake_id : null
    })()
    try {
      return await intakeRequest
    } finally {
      intakeRequest = null
    }
  }

  const attachFiles = async (files: File[]): Promise<void> => {
    if (!chatSessionExists(projectId, sessionId)) return
    const admitted = admitChatAttachmentFiles(projectId, sessionId, files)
    if (admitted.visionError !== null) {
      const key = admitted.visionError.code === 'payload_too_large'
        ? 'shell.chat.vision.payloadTooLarge' : 'shell.chat.vision.imageRejected'
      showToast(rootHost(), t('shell', key))
    }
    const { items } = admitted
    if (items.length === 0) return
    bindView()
    render()

    const needsIntake = items.some(item => item.intakeId === null)
    const intakeId = needsIntake ? await ensureIntake() : null
    if (!chatSessionExists(projectId, sessionId)) return
    if (needsIntake && intakeId === null) {
      for (const item of items) {
        if (item.intakeId !== null) continue
        chatUploadStore.update(projectId, sessionId, { ...item, state: 'failed', lastError: 'attachment_intake_unavailable' })
      }
      showToast(rootHost(), t('shell', 'shell.chat.attachIntakeFailed'))
    }
    for (const item of items) {
      if (!chatSessionExists(projectId, sessionId)) return
      const itemIntakeId = item.intakeId ?? intakeId
      if (itemIntakeId === null) continue
      const file = files[items.indexOf(item)]
      if (file === undefined) continue
      let hashed = item
      try {
        const digest = await sha256File(file, undefined, signal)
        if (!chatSessionExists(projectId, sessionId)) return
        if (item.expectedSha256 !== null && item.expectedSha256 !== digest) {
          chatUploadStore.update(projectId, sessionId, {
            ...item, state: 'failed', lastError: 'upload_file_hash_mismatch',
          })
          chatUploadStore.releaseBytes(projectId, sessionId, item.fileId)
          continue
        }
        hashed = markHashed(item, digest)
      } catch (error) {
        chatUploadStore.update(projectId, sessionId, { ...item, state: 'failed', lastError: (error as Error).message })
        continue
      }
      hashed = { ...hashed, intakeId: itemIntakeId, projectId }
      if (!chatUploadStore.update(projectId, sessionId, hashed)) return
      const finished = await continueUpload(hashed)
      if (!chatSessionExists(projectId, sessionId)) return
      if (finished?.state === 'failed') {
        chatPushToProjectSession(projectId, sessionId, {
          role: 'error',
          text: t('shell', 'shell.chat.attachFailed', {
            name: finished.fileName,
            reason: uploadErrorText(finished.lastError) ?? t('shell', 'shell.chat.upload.unknown'),
          }),
          time: new Date().toLocaleTimeString(getLocale()),
        }, true)
      } else if (finished?.state === 'scanning') {
        chatPushToProjectSession(projectId, sessionId, {
          role: 'assistant',
          text: t('shell', 'shell.chat.attachStaged', { name: finished.fileName }),
          time: new Date().toLocaleTimeString(getLocale()),
        }, true)
      }
    }
  }

  const recover = async (): Promise<void> => {
    if (transport.listSessions === undefined) return
    const intakeIds = [...new Set(chatUploadStore.list(projectId, sessionId)
      .flatMap(item => item.intakeId === null ? [] : [item.intakeId]))]
    for (const intakeId of intakeIds) {
      let sessions: UploadSessionProjection[]
      try {
        sessions = await transport.listSessions({ project_id: projectId, intake_id: intakeId, signal })
      } catch {
        continue
      }
      if (!chatSessionExists(projectId, sessionId)) return
      chatUploadStore.reconcile(projectId, sessionId, sessions)
    }
  }

  button.onclick = () => fileInput.click()
  fileInput.onchange = () => {
    const picked = [...(fileInput.files ?? [])]
    fileInput.value = ''
    if (picked.length > 0) void attachFiles(picked)
  }

  return {
    button,
    fileInput,
    queue,
    queuedVision: () => chatVisionTurnStore.list(projectId, sessionId),
    consumeVision: fileIds => {
      chatVisionTurnStore.consume(projectId, sessionId, fileIds)
      render()
    },
    render,
    mount: () => {
      composer.ondragover = event => { event.preventDefault(); composer.style.borderColor = 'var(--accent)' }
      composer.ondragleave = () => { composer.style.borderColor = '' }
      composer.ondrop = event => {
        event.preventDefault()
        composer.style.borderColor = ''
        const dropped = [...(event.dataTransfer?.files ?? [])]
        if (dropped.length > 0) void attachFiles(dropped)
      }
      textInput.onpaste = event => {
        const pasted = [...(event.clipboardData?.files ?? [])]
        if (pasted.length > 0) {
          event.preventDefault()
          void attachFiles(pasted)
        }
      }
      if (chatUploadStore.list(projectId, sessionId).length > 0) bindView()
      render()
      void recover()
    },
    dispose: () => {
      unsubscribe?.()
      unsubscribe = null
      composer.ondragover = null
      composer.ondragleave = null
      composer.ondrop = null
      textInput.onpaste = null
      fileInput.onchange = null
    },
  }
}
