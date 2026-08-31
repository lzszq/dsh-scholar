/** Strict Settings write transaction wire (REVIEW-CONFIG-WRITE-03). */
import { z } from 'zod'
import { ProviderCreateInput, ProviderUpdateInput } from './provider.js'
import { RunnerTargetCreateInput, RunnerTargetUpdateInput } from './runner-target.js'

export const ConfigWriteScopeSchema = z.enum(['global', 'project', 'runtime'])
export type ConfigWriteScope = z.infer<typeof ConfigWriteScopeSchema>

const ScopeId = z.string().min(1).max(160).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/)

export const ConfigPatchOperation = z.object({
  kind: z.literal('config'),
  scope: ConfigWriteScopeSchema,
  scope_id: ScopeId,
  expected_revision: z.number().int().nonnegative().safe(),
  changes: z.record(z.string().min(1), z.unknown()).refine(value => Object.keys(value).length > 0, 'config patch must contain at least one change'),
}).strict().superRefine((value, ctx) => {
  if (value.scope === 'global' && value.scope_id !== 'global') {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['scope_id'], message: 'global config scope_id must be global' })
  }
})
export type ConfigPatchOperation = z.infer<typeof ConfigPatchOperation>

export const ConfigWriteTransactionInput = z.object({
  operations: z.array(ConfigPatchOperation).min(1).max(64),
}).strict()
export type ConfigWriteTransactionInput = z.infer<typeof ConfigWriteTransactionInput>

const ProviderCreateOperation = z.object({
  action: z.literal('create'),
  input: ProviderCreateInput,
}).strict()

const ProviderUpdateOperation = z.object({
  action: z.literal('update'),
  provider_id: z.string().min(1).max(128),
  expected_revision: z.number().int().positive().safe(),
  patch: ProviderUpdateInput.omit({ expected_revision: true }),
}).strict()

const OcrBindingWrite = z.object({
  project_id: z.string().min(1),
  model_id: z.enum(['flash', 'pipeline', 'vlm']),
  expected_provider_revision: z.number().int().positive().safe(),
  expected_revision: z.number().int().nonnegative().safe().optional(),
}).strict()

/** One operation intentionally owns Provider + project binding so a MinerU
 * save can never leave the Provider committed while its binding failed. */
export const OcrMineruSettingsOperation = z.object({
  kind: z.literal('ocr-mineru'),
  provider: z.union([ProviderCreateOperation, ProviderUpdateOperation]),
  binding: OcrBindingWrite.optional(),
}).strict().superRefine((value, ctx) => {
  const providerId = value.provider.action === 'create' ? value.provider.input.provider_id : value.provider.provider_id
  if (providerId !== 'mineru') {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['provider'], message: 'OCR Settings currently supports only the mineru provider' })
  }
})
export type OcrMineruSettingsOperation = z.infer<typeof OcrMineruSettingsOperation>

const RunnerTargetCreateOperation = z.object({
  kind: z.literal('runner-target'),
  action: z.literal('create'),
  input: RunnerTargetCreateInput,
}).strict()

const RunnerTargetUpdateOperation = z.object({
  kind: z.literal('runner-target'),
  action: z.literal('update'),
  target_id: z.string().min(1).max(120),
  patch: RunnerTargetUpdateInput,
}).strict()

export const RunnerTargetSettingsOperation = z.union([RunnerTargetCreateOperation, RunnerTargetUpdateOperation])
export type RunnerTargetSettingsOperation = z.infer<typeof RunnerTargetSettingsOperation>

export const SettingsWriteOperation = z.union([
  ConfigPatchOperation,
  OcrMineruSettingsOperation,
  RunnerTargetSettingsOperation,
])
export type SettingsWriteOperation = z.infer<typeof SettingsWriteOperation>

export const SettingsWriteTransactionInput = z.object({
  operations: z.array(SettingsWriteOperation).min(1).max(64),
}).strict()
export type SettingsWriteTransactionInput = z.infer<typeof SettingsWriteTransactionInput>

export interface ConfigLayerSafeView {
  scope: ConfigWriteScope
  scope_id: string
  revision: number
  config: Record<string, unknown>
  config_pin: string
  updated_by: string | null
  updated_at: string | null
}

export interface ConfigEffectiveSafeView {
  schema_version: 1
  config: Record<string, unknown>
  config_pin: string
  revisions: { global: number; project: number | null; runtime: Record<string, number> }
  provenance: Record<string, { scope: ConfigWriteScope | 'built-in'; scope_id: string; revision: number }>
  hot_applied_keys: string[]
  restart_required_keys: string[]
  restart_required: boolean
}

export interface ConfigWriteReceipt {
  layers: ConfigLayerSafeView[]
  effective: ConfigEffectiveSafeView
  verdict: {
    hot_applied_keys: string[]
    restart_required_keys: string[]
    restart_required: boolean
  }
}

export interface SettingsWriteTransactionReceipt {
  config: ConfigWriteReceipt | null
  operations: Array<{ index: number; kind: SettingsWriteOperation['kind']; resource: unknown }>
}
