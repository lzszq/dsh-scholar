import {
  ScholarChatTurnRequest,
  type ScholarAgentRequest,
} from '@dsh-scholar/research-schemas/chat-agent'
import { requestScholarAgent, ScholarAgentBridgeError } from './chat-agent-client.js'

export interface StandaloneChatTurnResult {
  readonly status: number
  readonly payload: unknown
}

function failure(code: string, message: string): StandaloneChatTurnResult['payload'] {
  return { ok: false, error: { code, message } }
}

/** Domain handler for the standalone free-conversation route. HTTP admission
 * (bearer, origin, CSRF and body cap) stays in the server dispatcher; this
 * module owns request validation, authoritative project context and safe
 * bridge error mapping. */
export async function executeStandaloneChatTurn(
  raw: unknown,
  options: {
    dataDir: string
    kernelEndpoint: string
    upstreamAuthHeaders: Record<string, string>
    enforceMembership: boolean
    isProjectMember(projectId: string): Promise<boolean>
    fetchImpl?: typeof fetch
    requestAgent?: typeof requestScholarAgent
    signal?: AbortSignal
  },
): Promise<StandaloneChatTurnResult> {
  const parsed = ScholarChatTurnRequest.safeParse(raw)
  if (!parsed.success) {
    const imageFailure = parsed.error.issues.some(issue => issue.path[0] === 'images')
    return {
      status: 422,
      payload: failure(
        imageFailure ? 'vision_image_rejected' : 'validation_error',
        imageFailure ? 'image input was rejected' : 'project_id, session_id and text are required',
      ),
    }
  }
  const { project_id: projectId, session_id: sessionId, text, locale, history, images } = parsed.data
  if (options.enforceMembership && !(await options.isProjectMember(projectId))) {
    return { status: 404, payload: failure('project_not_found', 'project not found or access denied') }
  }
  const fetchImpl = options.fetchImpl ?? fetch
  const projectionResponse = await fetchImpl(
    `${options.kernelEndpoint}/v2/projects/${encodeURIComponent(projectId)}/projection`,
    { headers: { accept: 'application/json', ...options.upstreamAuthHeaders }, signal: options.signal },
  ).catch(error => {
    if (options.signal?.aborted === true) throw error
    return null
  })
  if (projectionResponse === null || !projectionResponse.ok) {
    return { status: 502, payload: failure('kernel_unreachable', 'research projection unavailable') }
  }
  let projection: { project?: Record<string, unknown>; next_actions_v2?: Array<Record<string, unknown>> }
  try {
    const decoded = await projectionResponse.json() as unknown
    if (decoded === null || typeof decoded !== 'object' || Array.isArray(decoded)) throw new Error('invalid projection')
    projection = decoded as typeof projection
  } catch (error) {
    if (options.signal?.aborted === true) throw error
    return { status: 502, payload: failure('kernel_unreachable', 'research projection unavailable') }
  }
  try {
    const reply = await (options.requestAgent ?? requestScholarAgent)(options.dataDir, {
      operation: 'conversation',
      session_id: sessionId,
      text,
      locale,
      project: {
        project_id: projectId,
        ...(typeof projection.project?.name === 'string' ? { name: projection.project.name } : {}),
        ...(typeof projection.project?.status === 'string' ? { status: projection.project.status } : {}),
        ...(typeof projection.project?.brief_status === 'string' ? { brief_status: projection.project.brief_status } : {}),
        ...(projection.project?.brief !== null && typeof projection.project?.brief === 'object'
          ? { brief: projection.project.brief as Record<string, unknown> } : {}),
        next_actions_v2: projection.next_actions_v2 ?? [],
      },
      history,
      images,
    } as ScholarAgentRequest, 45_000, options.signal)
    if (reply.operation !== 'conversation') throw new Error('wrong operation')
    return { status: 200, payload: reply }
  } catch (error) {
    if (options.signal?.aborted === true) throw error
    if (error instanceof ScholarAgentBridgeError && error.code === 'vision_model_required') {
      return { status: 422, payload: failure(error.code, 'select a model that declares image input') }
    }
    if (error instanceof ScholarAgentBridgeError && error.code === 'vision_image_rejected') {
      return { status: 422, payload: failure(error.code, 'image input was rejected') }
    }
    if (error instanceof ScholarAgentBridgeError && error.code === 'vision_attachment_service_unavailable') {
      return { status: 503, payload: failure(error.code, 'DSH image attachment service is unavailable') }
    }
    if (error instanceof ScholarAgentBridgeError && error.code === 'payload_too_large') {
      return { status: 413, payload: failure(error.code, 'payload too large') }
    }
    return { status: 503, payload: failure('model_unavailable', 'DSH model runtime is unavailable') }
  }
}
