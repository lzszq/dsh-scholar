import {
  ScholarAgentReply,
  ScholarChatTurnRequest,
  isScholarAgentBrowserFailureCode,
  type ScholarAgentBrowserFailureCode,
  type ScholarChatImage,
} from '@dsh-scholar/research-schemas/chat-agent'
import { authHeaders, base, ensureCsrfToken } from './api'

export interface ChatModelTurnRequest {
  sessionId: string
  text: string
  locale: 'zh' | 'en'
  project: {
    project_id: string
    name?: string
    status?: string
    brief_status?: string
    next_actions_v2?: unknown[]
  }
  history: Array<{ role: 'user' | 'assistant'; text: string }>
  images: readonly ScholarChatImage[]
}

export interface ChatModelTurnReply {
  assistantText: string
  suggestedCommand?: string
}

export type ChatModelTurn = (
  payload: ChatModelTurnRequest,
  options?: { signal?: AbortSignal },
) => Promise<ChatModelTurnReply | null>
export type ChatVisionFailureCode = ScholarAgentBrowserFailureCode | 'vision_model_unavailable'

export class ChatVisionError extends Error {
  constructor(readonly code: ChatVisionFailureCode) {
    super(code)
    this.name = 'ChatVisionError'
  }
}

/** Browser adapter for the shared browser→BFF DTO. Canonical project context
 * remains server-derived; this wire carries only the exact session turn. */
export const standaloneChatModel: ChatModelTurn = async (payload, options) => {
  const body = ScholarChatTurnRequest.parse({
    project_id: payload.project.project_id,
    session_id: payload.sessionId,
    text: payload.text,
    locale: payload.locale,
    history: payload.history,
    images: payload.images,
  })
  const response = await fetch(`${base()}/api/chat/turn`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(await authHeaders()), 'x-csrf-token': (await ensureCsrfToken()) ?? '' },
    body: JSON.stringify(body),
    signal: options?.signal,
  })
  const raw = await response.json().catch(() => null) as unknown
  if (!response.ok) {
    const code = typeof raw === 'object' && raw !== null
      && typeof (raw as { error?: { code?: unknown } }).error?.code === 'string'
      ? (raw as { error: { code: string } }).error.code
      : ''
    if (payload.images.length > 0) {
      throw new ChatVisionError(isScholarAgentBrowserFailureCode(code) ? code : 'vision_model_unavailable')
    }
    return null
  }
  const reply = ScholarAgentReply.safeParse(raw)
  if (!reply.success || reply.data.operation !== 'conversation') {
    if (payload.images.length > 0) throw new ChatVisionError('vision_model_unavailable')
    return null
  }
  return { assistantText: reply.data.assistant_text }
}
