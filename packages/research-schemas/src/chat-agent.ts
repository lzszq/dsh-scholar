/**
 * Private loopback contract between the standalone Scholar BFF and the DSH
 * plugin's model runtime. The browser never sees the bridge endpoint/token.
 * Model output is deliberately limited to conversation text or IdeaDrafts;
 * canonical mutations remain owned by the BFF + Research Kernel.
 */

import { z } from 'zod'
import { IdeaDraft } from './idea.js'

/** One hard envelope for browser → BFF → private loopback Agent requests. */
export const SCHOLAR_AGENT_MAX_BODY_BYTES = 16 * 1024 * 1024
export const SCHOLAR_CHAT_MAX_IMAGES = 20
export const SCHOLAR_CHAT_IMAGE_MEDIA_TYPES = [
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif',
] as const

const ChatHistoryItem = z.object({
  role: z.enum(['user', 'assistant']),
  text: z.string().min(1).max(2_000),
}).strict()

/** Transient browser-to-DSH image input. DSH AttachmentStore owns byte,
 * dimension, aggregate and media sniffing policy; Scholar only closes the
 * wire vocabulary and keeps the private bridge body bounded. */
export const ScholarChatImage = z.object({
  mediaType: z.enum(SCHOLAR_CHAT_IMAGE_MEDIA_TYPES),
  data: z.string().min(1).max(16 * 1024 * 1024),
  name: z.string().min(1).max(512).optional(),
}).strict()
export type ScholarChatImage = z.infer<typeof ScholarChatImage>
export const ScholarChatImages = z.array(ScholarChatImage).max(SCHOLAR_CHAT_MAX_IMAGES)

export const ScholarChatTurnRequest = z.object({
  project_id: z.string().trim().min(1).max(256),
  session_id: z.string().trim().min(1).max(256),
  text: z.string().trim().min(1).max(16_000),
  locale: z.enum(['zh', 'en']).default('zh'),
  history: z.array(ChatHistoryItem).max(12).default([]),
  images: ScholarChatImages.default([]),
}).strict()
export type ScholarChatTurnRequest = z.infer<typeof ScholarChatTurnRequest>

const ChatProjectContext = z.object({
  project_id: z.string().min(1).max(256),
  name: z.string().max(512).optional(),
  status: z.string().max(128).optional(),
  brief_status: z.string().max(128).optional(),
  brief: z.record(z.unknown()).optional(),
  next_actions_v2: z.array(z.record(z.unknown())).max(20).default([]),
}).strict()

const CorpusPaperContext = z.object({
  paper_id: z.string().min(1).max(512),
  title: z.string().min(1).max(1_000),
  year: z.number().int().optional(),
  abstract: z.string().max(2_000).default(''),
}).strict()

export const ScholarAgentRequest = z.discriminatedUnion('operation', [
  z.object({ operation: z.literal('list_models') }).strict(),
  z.object({
    operation: z.literal('resolve_model'),
    provider: z.string().min(1).max(256),
    model: z.string().min(1).max(1_024),
  }).strict(),
  z.object({
    operation: z.literal('conversation'),
    session_id: z.string().min(1).max(256),
    text: z.string().min(1).max(16_000),
    locale: z.enum(['zh', 'en']).default('zh'),
    project: ChatProjectContext,
    history: z.array(ChatHistoryItem).max(12).default([]),
    images: ScholarChatImages.default([]),
  }).strict(),
  z.object({
    operation: z.literal('generate_ideas'),
    session_id: z.string().min(1).max(256),
    text: z.string().min(1).max(16_000),
    locale: z.enum(['zh', 'en']).default('zh'),
    count: z.number().int().min(1).max(5),
    project: ChatProjectContext,
    corpus: z.object({
      snapshot_id: z.string().min(1).max(256),
      papers: z.array(CorpusPaperContext).min(1).max(30),
    }).strict(),
    history: z.array(ChatHistoryItem).max(12).default([]),
  }).strict(),
])
export type ScholarAgentRequest = z.infer<typeof ScholarAgentRequest>

export const ScholarAgentModel = z.object({
  id: z.string().min(1).max(1_281),
  provider: z.string().min(1).max(256),
  model: z.string().min(1).max(1_024),
  name: z.string().min(1).max(512),
  input_modalities: z.array(z.enum(['text', 'image'])).max(2).optional(),
}).strict()

export const ScholarAgentReply = z.discriminatedUnion('operation', [
  z.object({
    operation: z.literal('list_models'),
    models: z.array(ScholarAgentModel).max(200),
  }).strict(),
  z.object({
    operation: z.literal('resolve_model'),
    model: ScholarAgentModel,
  }).strict(),
  z.object({
    operation: z.literal('conversation'),
    assistant_text: z.string().min(1).max(20_000),
  }).strict(),
  z.object({
    operation: z.literal('generate_ideas'),
    ideas: z.array(IdeaDraft).min(1).max(5),
  }).strict(),
])
export type ScholarAgentReply = z.infer<typeof ScholarAgentReply>

export const SCHOLAR_AGENT_MODEL_FAILURE_CODES = [
  'model_stream_unavailable',
  'invalid_model_json',
  'wrong_model_operation',
  'wrong_idea_count',
  'duplicate_ideas',
  'foreign_corpus_reference',
  'vision_model_required',
  'vision_attachment_service_unavailable',
] as const
export type ScholarAgentModelFailureCode = typeof SCHOLAR_AGENT_MODEL_FAILURE_CODES[number]

export const SCHOLAR_AGENT_BRIDGE_FAILURE_CODES = [
  ...SCHOLAR_AGENT_MODEL_FAILURE_CODES,
  'vision_image_rejected',
  'payload_too_large',
  'schema_rejected',
  'request_rejected',
  'model_unavailable',
] as const
export type ScholarAgentBridgeFailureCode = typeof SCHOLAR_AGENT_BRIDGE_FAILURE_CODES[number]
const scholarAgentBridgeFailureCodeSet = new Set<string>(SCHOLAR_AGENT_BRIDGE_FAILURE_CODES)
export function isScholarAgentBridgeFailureCode(value: unknown): value is ScholarAgentBridgeFailureCode {
  return typeof value === 'string' && scholarAgentBridgeFailureCodeSet.has(value)
}

export const SCHOLAR_AGENT_BROWSER_FAILURE_CODES = [
  'vision_model_required',
  'vision_attachment_service_unavailable',
  'vision_image_rejected',
  'payload_too_large',
  'schema_rejected',
] as const
export type ScholarAgentBrowserFailureCode = typeof SCHOLAR_AGENT_BROWSER_FAILURE_CODES[number]
const scholarAgentBrowserFailureCodeSet = new Set<string>(SCHOLAR_AGENT_BROWSER_FAILURE_CODES)
export function isScholarAgentBrowserFailureCode(value: unknown): value is ScholarAgentBrowserFailureCode {
  return typeof value === 'string' && scholarAgentBrowserFailureCodeSet.has(value)
}

/** Parse the canonical provider/model selector. Only the first slash is a
 * separator because adapter-owned model ids may themselves contain slashes. */
export function parseScholarModelId(value: string): { provider: string; model: string } | null {
  const normalized = value.trim()
  const separator = normalized.indexOf('/')
  if (separator <= 0 || separator === normalized.length - 1) return null
  return { provider: normalized.slice(0, separator), model: normalized.slice(separator + 1) }
}
