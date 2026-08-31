import type { ProjectModelBindingLite, ProviderSafeViewLite } from './types'

export const MINERU_PROVIDER_ID = 'mineru'
export const MINERU_DEFAULT_BASE_URL = 'https://mineru.net/api/v4'
export const MINERU_MODEL_IDS = ['flash', 'pipeline', 'vlm'] as const

export type MineruModelId = typeof MINERU_MODEL_IDS[number]
export type MineruSecretRefScheme = 'file' | 'keyring' | 'vault'

export interface MineruSecretRefDraft {
  scheme: MineruSecretRefScheme
  name: string
  version: string
  scope: string
}

export interface MineruSettingsDraft {
  enabled: boolean
  baseUrl: string
  modelId: MineruModelId
  useCredential: boolean
  credential: MineruSecretRefDraft
}

export type MineruProviderWrite = {
  display_name: 'MinerU'
  kind: 'mineru'
  base_url: string
  enabled: boolean
  capabilities: ['ocr', 'vision']
  models: Array<{
    model_id: MineruModelId
    display_name: string
    capabilities: Array<'ocr' | 'vision'>
  }>
  credential?: {
    scheme: MineruSecretRefScheme
    name: string
    version?: string
    scope?: string
  } | null
}

export type MineruProviderCreate = MineruProviderWrite & { provider_id: typeof MINERU_PROVIDER_ID }
export type MineruProviderUpdate = MineruProviderWrite & { expected_revision: number }

const MODEL_CATALOG: MineruProviderWrite['models'] = [
  { model_id: 'flash', display_name: 'MinerU Flash', capabilities: ['ocr'] },
  { model_id: 'pipeline', display_name: 'MinerU Pipeline', capabilities: ['ocr'] },
  { model_id: 'vlm', display_name: 'MinerU VLM', capabilities: ['ocr', 'vision'] },
]

function isMineruModel(value: string): value is MineruModelId {
  return (MINERU_MODEL_IDS as readonly string[]).includes(value)
}

/** Only the official MinerU Open API is built in during OCR-CONFIG-01. */
export function normalizeMineruBaseUrl(value: string): string {
  const trimmed = value.trim()
  if (trimmed.includes('?') || trimmed.includes('#')) throw new TypeError('MinerU API URL must not contain query or fragment delimiters')
  let parsed: URL
  try { parsed = new URL(trimmed) } catch { throw new TypeError('invalid MinerU API URL') }
  const officialPath = parsed.pathname === '/api/v4' || parsed.pathname === '/api/v4/'
  if (parsed.origin !== 'https://mineru.net' || !officialPath
    || parsed.username !== '' || parsed.password !== '' || parsed.search !== '' || parsed.hash !== '') {
    throw new TypeError('MinerU API URL must use https://mineru.net/api/v4 without credentials, query or fragment')
  }
  return parsed.toString().replace(/\/$/, '')
}

export function mineruProvider(providers: readonly ProviderSafeViewLite[] | null): ProviderSafeViewLite | undefined {
  return providers?.find(provider => provider.provider_id === MINERU_PROVIDER_ID && provider.kind === 'mineru')
}

export function mineruSettingsDraft(
  provider?: ProviderSafeViewLite,
  binding?: ProjectModelBindingLite | null,
): MineruSettingsDraft {
  const boundModel = binding?.provider_id === MINERU_PROVIDER_ID && isMineruModel(binding.model_id)
    ? binding.model_id
    : 'flash'
  return {
    enabled: provider?.enabled ?? true,
    baseUrl: provider?.base_url ?? MINERU_DEFAULT_BASE_URL,
    modelId: boundModel,
    useCredential: provider?.credential !== undefined,
    credential: {
      scheme: provider?.credential?.scheme ?? 'file',
      name: provider?.credential?.name ?? '',
      version: provider?.credential?.version ?? '',
      scope: provider?.credential?.scope ?? '',
    },
  }
}

function credentialPayload(draft: MineruSettingsDraft): MineruProviderWrite['credential'] {
  if (!draft.useCredential) return null
  const name = draft.credential.name.trim()
  if (name === '') throw new TypeError('MinerU SecretRef name is required')
  return {
    scheme: draft.credential.scheme,
    name,
    ...(draft.credential.version.trim() === '' ? {} : { version: draft.credential.version.trim() }),
    ...(draft.credential.scope.trim() === '' ? {} : { scope: draft.credential.scope.trim() }),
  }
}

function sharedProviderWrite(draft: MineruSettingsDraft): MineruProviderWrite {
  const credential = credentialPayload(draft)
  if (draft.modelId !== 'flash' && credential === null) {
    throw new TypeError('MinerU Pipeline and VLM require a SecretRef')
  }
  return {
    display_name: 'MinerU',
    kind: 'mineru',
    base_url: normalizeMineruBaseUrl(draft.baseUrl),
    enabled: draft.enabled,
    capabilities: ['ocr', 'vision'],
    models: MODEL_CATALOG.map(model => ({ ...model, capabilities: [...model.capabilities] })),
    credential,
  }
}

export function mineruProviderCreate(draft: MineruSettingsDraft): MineruProviderCreate {
  const shared = sharedProviderWrite(draft)
  if (shared.credential === null) delete shared.credential
  return { provider_id: MINERU_PROVIDER_ID, ...shared }
}

export function mineruProviderUpdate(draft: MineruSettingsDraft, expectedRevision: number): MineruProviderUpdate {
  if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1) throw new TypeError('invalid MinerU provider revision')
  return { expected_revision: expectedRevision, ...sharedProviderWrite(draft) }
}

export function mineruBindingWrite(
  draft: MineruSettingsDraft,
  binding: ProjectModelBindingLite | null | undefined,
  expectedProviderRevision: number,
): {
  purpose: 'ocr'
  provider_id: typeof MINERU_PROVIDER_ID
  model_id: MineruModelId
  expected_provider_revision: number
  expected_revision?: number
} {
  if (!draft.enabled) throw new TypeError('MinerU must be enabled before binding')
  if (draft.modelId !== 'flash' && !draft.useCredential) throw new TypeError('MinerU Pipeline and VLM require a SecretRef')
  if (!Number.isSafeInteger(expectedProviderRevision) || expectedProviderRevision < 1) throw new TypeError('invalid MinerU provider revision')
  return {
    purpose: 'ocr',
    provider_id: MINERU_PROVIDER_ID,
    model_id: draft.modelId,
    expected_provider_revision: expectedProviderRevision,
    ...(binding === null || binding === undefined ? {} : { expected_revision: binding.revision }),
  }
}

/** One Settings transaction operation for the global MinerU descriptor and
 * optional project OCR binding. The provider's post-write revision is pinned
 * before the request leaves the browser. */
export function mineruSettingsOperation(
  draft: MineruSettingsDraft,
  provider: ProviderSafeViewLite | undefined,
  binding: ProjectModelBindingLite | null | undefined,
  projectId?: string,
): {
  kind: 'ocr-mineru'
  provider:
    | { action: 'create'; input: MineruProviderCreate }
    | { action: 'update'; provider_id: 'mineru'; expected_revision: number; patch: MineruProviderWrite }
  binding?: {
    project_id: string
    model_id: MineruModelId
    expected_provider_revision: number
    expected_revision?: number
  }
} {
  const nextProviderRevision = provider === undefined ? 1 : provider.revision + 1
  const providerOperation = provider === undefined
    ? { action: 'create' as const, input: mineruProviderCreate(draft) }
    : (() => {
        const { expected_revision, ...patch } = mineruProviderUpdate(draft, provider.revision)
        return { action: 'update' as const, provider_id: MINERU_PROVIDER_ID as typeof MINERU_PROVIDER_ID, expected_revision, patch }
      })()
  const projectBinding = projectId === undefined || !draft.enabled
    ? undefined
    : {
        project_id: projectId,
        model_id: draft.modelId,
        expected_provider_revision: nextProviderRevision,
        ...(binding === null || binding === undefined ? {} : { expected_revision: binding.revision }),
      }
  // Run the existing strict binding validation before returning the atomic
  // wrapper (its provider revision is deliberately the post-write revision).
  if (projectBinding !== undefined) mineruBindingWrite(draft, binding, nextProviderRevision)
  return {
    kind: 'ocr-mineru',
    provider: providerOperation,
    ...(projectBinding === undefined ? {} : { binding: projectBinding }),
  }
}

export type MineruSettingsErrorKey =
  | 'shell.settings.ocr.saveFailed'
  | 'shell.settings.ocr.error.permission'
  | 'shell.settings.ocr.error.providerRevision'
  | 'shell.settings.ocr.error.bindingRevision'
  | 'shell.settings.ocr.error.url'
  | 'shell.settings.ocr.error.credential'
  | 'shell.settings.ocr.error.contract'
  | 'shell.settings.ocr.error.network'

export function mineruSettingsErrorKey(code: string | undefined): MineruSettingsErrorKey {
  switch (code) {
    case 'role_forbidden': return 'shell.settings.ocr.error.permission'
    case 'provider_revision_conflict': return 'shell.settings.ocr.error.providerRevision'
    case 'binding_revision_conflict': return 'shell.settings.ocr.error.bindingRevision'
    case 'provider_url_scheme_invalid':
    case 'provider_url_userinfo_rejected':
    case 'provider_url_ssrf_rejected':
    case 'provider_url_malformed': return 'shell.settings.ocr.error.url'
    case 'provider_credential_required':
    case 'secret_ref_invalid':
    case 'secret_value_forbidden': return 'shell.settings.ocr.error.credential'
    case 'provider_contract_invalid': return 'shell.settings.ocr.error.contract'
    case 'network_error': return 'shell.settings.ocr.error.network'
    default: return 'shell.settings.ocr.saveFailed'
  }
}
