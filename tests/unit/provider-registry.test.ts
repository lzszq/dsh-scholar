/**
 * MODEL-01 — Model Provider 注册表与项目绑定（init-grill-upload-models.md
 * §4，规范性契约；api-contracts.md §19；hardening-v0.2-status.md §3
 * MODEL-01 行）。覆盖：
 *
 *  - CRUD + revision CAS（409 provider_revision_conflict）、enabled 启停；
 *  - SecretRef 严格 schema：value/token/password/credential 字段拒绝
 *    （422 secret_value_forbidden），未知键拒绝；
 *  - base URL SSRF/scheme 校验：非法 scheme、userinfo、私有/保留 IP、
 *    未 allowlist 的 DNS 主机、非 loopback 的 http → fail closed；
 *  - 列表/详情/绑定零 secret：序列化响应不含 value/token/password 键，
 *    credential 只回显 metadata + available 布尔；
 *  - 项目提交 provider/model ID：provider 存在且 enabled、模型在目录、
 *    能力匹配；快照 provider_revision + config_hash；绑定 revision CAS；
 *    删除 provider 清除引用它的绑定。
 */
import { describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ResearchKernel, KernelError, startKernelServer } from '@dsh-scholar/research-kernel'
import type { ProviderCreateInput, ProviderUpdateInput, SecretRef } from '@dsh-scholar/research-schemas'

function freshKernel(secretRoot: string | null = null, allowlist: { hosts?: string[]; allowLoopback?: boolean } = {}): ResearchKernel {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-provider-test-'))
  return new ResearchKernel({
    dbPath: join(dir, 'kernel.db'),
    casRoot: join(dir, 'cas'),
    requireSignedManifest: false,
    secretRoot,
    providerUrlAllowlist: allowlist,
  })
}

const SECRET_VALUE_KEYS = ['value', 'token', 'password', 'api_key', 'apikey']

/** 递归检查任意序列化对象不含 secret 值键（零 secret 断言）。 */
function assertNoSecretKeys(blob: unknown, path = '$'): void {
  if (Array.isArray(blob)) {
    blob.forEach((item, i) => assertNoSecretKeys(item, `${path}[${i}]`))
    return
  }
  if (typeof blob === 'object' && blob !== null) {
    for (const [key, value] of Object.entries(blob as Record<string, unknown>)) {
      if (SECRET_VALUE_KEYS.includes(key)) {
        throw new Error(`secret value key '${key}' leaked at ${path}.${key}`)
      }
      assertNoSecretKeys(value, `${path}.${key}`)
    }
  }
}

function providerInput(overrides: Partial<ProviderCreateInput> = {}): ProviderCreateInput {
  return {
    provider_id: 'prov_ocr',
    display_name: 'OCR Provider',
    kind: 'custom',
    base_url: 'https://models.example.com/v1',
    enabled: true,
    capabilities: ['ocr', 'vision'],
    models: [{ model_id: 'ocr-model-1', capabilities: ['ocr'] }, { model_id: 'vision-model-1', capabilities: ['vision'] }],
    credential: { scheme: 'file', name: 'my-ocr-key' },
    ...overrides,
  }
}

function expectKernelError(fn: () => unknown, status: number, code: string): void {
  try {
    fn()
    throw new Error('expected KernelError to be thrown')
  } catch (error) {
    expect(error).toBeInstanceOf(KernelError)
    expect((error as KernelError).status).toBe(status)
    expect((error as KernelError).code).toBe(code)
  }
}

function nameOnlyProject(kernel: ResearchKernel): string {
  return kernel.createProjectForGrill({
    name: 'provider research',
    creator_principal_id: 'pi-1',
    idempotency_key: `ik-${Math.random().toString(36).slice(2)}`,
    request_hash: 'h1',
  }).project.project_id
}

describe('MODEL-01 provider CRUD + revision CAS', () => {
  it('requires a durable PI/operator for the atomic HTTP MinerU Provider and project binding Settings write', async () => {
    const kernel = freshKernel(null, { hosts: ['mineru.net'] })
    const projectId = nameOnlyProject(kernel)
    const { server, url } = await startKernelServer({ kernel, port: 0 })
    const body = {
      provider_id: 'mineru', display_name: 'MinerU', kind: 'mineru', base_url: 'https://mineru.net/api/v4',
      enabled: true, capabilities: ['ocr', 'vision'],
      models: [
        { model_id: 'flash', capabilities: ['ocr'] },
        { model_id: 'pipeline', capabilities: ['ocr'] },
        { model_id: 'vlm', capabilities: ['ocr', 'vision'] },
      ],
    }
    try {
      const binding = { project_id: projectId, model_id: 'flash', expected_provider_revision: 1 }
      const transaction = (input: unknown) => ({ operations: [{
        kind: 'ocr-mineru', provider: { action: 'create', input }, binding,
      }] })
      const secretValue = await fetch(`${url}/v1/settings/transactions`, {
        method: 'POST', headers: { 'content-type': 'application/json', 'x-principal-id': 'pi-1' },
        body: JSON.stringify(transaction({ ...body, credential: { scheme: 'file', name: 'mineru-token', token: 'INLINE-SECRET' } })),
      })
      expect(secretValue.status).toBe(422)
      expect(await secretValue.json()).toMatchObject({ error: { code: 'validation_error' } })
      const anonymous = await fetch(`${url}/v1/settings/transactions`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(transaction(body)),
      })
      expect(anonymous.status).toBe(422)
      const created = await fetch(`${url}/v1/settings/transactions`, {
        method: 'POST', headers: { 'content-type': 'application/json', 'x-principal-id': 'pi-1' }, body: JSON.stringify(transaction(body)),
      })
      expect(created.status).toBe(200)
      const receipt = await created.json()
      expect(receipt).toMatchObject({ operations: [{ resource: {
        provider: { provider_id: 'mineru' },
        binding: { provider_id: 'mineru', model_id: 'flash', updated_by: 'pi-1' },
      } }] })
      expect(receipt).not.toHaveProperty('credential')
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()))
      kernel.close()
    }
  })

  it('supports the built-in MinerU kind and no-auth Flash configuration', () => {
    const kernel = freshKernel(null, { hosts: ['mineru.net'] })
    const created = kernel.registerProvider(providerInput({
      provider_id: 'mineru', display_name: 'MinerU', kind: 'mineru',
      base_url: 'https://mineru.net/api/v4', capabilities: ['ocr', 'vision'],
      models: [
        { model_id: 'flash', capabilities: ['ocr'] },
        { model_id: 'pipeline', capabilities: ['ocr'] },
        { model_id: 'vlm', capabilities: ['ocr', 'vision'] },
      ],
      credential: undefined,
    }))
    expect(created.kind).toBe('mineru')
    expect(created.credential).toBeUndefined()
    expect(kernel.providerView(created)).not.toHaveProperty('credential')
    const row = kernel.db.prepare('SELECT credential_json FROM model_providers WHERE provider_id = ?').get('mineru') as { credential_json: string }
    expect(JSON.parse(row.credential_json)).toBeNull()
  })

  it('enforces the MinerU descriptor and precision credential server-side', () => {
    const kernel = freshKernel(null, { hosts: ['mineru.net'] })
    expectKernelError(() => kernel.registerProvider(providerInput({
      provider_id: 'mineru', kind: 'mineru', base_url: 'https://mineru.net/api/v4',
      capabilities: ['ocr', 'vision'], models: [{ model_id: 'pipeline', capabilities: ['ocr'] }], credential: undefined,
    })), 422, 'provider_contract_invalid')
    for (const base_url of [
      'https://mineru.net/not-api',
      'https://mineru.net/api/v4?token=inline',
      'https://mineru.net/api/v4?',
      'https://mineru.net/api/v4#secret',
      'https://mineru.net/api/v4#',
      'https://mineru.net:444/api/v4',
    ]) {
      expectKernelError(() => kernel.registerProvider(providerInput({
        provider_id: 'mineru', kind: 'mineru', base_url, capabilities: ['ocr', 'vision'],
        models: [
          { model_id: 'flash', capabilities: ['ocr'] },
          { model_id: 'pipeline', capabilities: ['ocr'] },
          { model_id: 'vlm', capabilities: ['ocr', 'vision'] },
        ], credential: undefined,
      })), 422, 'provider_contract_invalid')
    }
    kernel.registerProvider(providerInput({
      provider_id: 'mineru', display_name: 'MinerU', kind: 'mineru', base_url: 'https://mineru.net/api/v4',
      capabilities: ['ocr', 'vision'],
      models: [
        { model_id: 'flash', capabilities: ['ocr'] },
        { model_id: 'pipeline', capabilities: ['ocr'] },
        { model_id: 'vlm', capabilities: ['ocr', 'vision'] },
      ],
      credential: undefined,
    }))
    const projectId = nameOnlyProject(kernel)
    expectKernelError(() => kernel.setProjectModelBinding(projectId, {
      purpose: 'ocr', provider_id: 'mineru', model_id: 'pipeline', expected_provider_revision: 1,
    }), 422, 'provider_credential_required')
    expectKernelError(() => kernel.setProjectModelBinding(projectId, {
      purpose: 'ocr', provider_id: 'mineru', model_id: 'flash', expected_provider_revision: 2,
    }), 409, 'provider_revision_conflict')
    const bound = kernel.setProjectModelBinding(projectId, {
      purpose: 'ocr', provider_id: 'mineru', model_id: 'flash', expected_provider_revision: 1,
    })
    expect(bound.provider_revision).toBe(1)
    const credentialed = kernel.updateProvider('mineru', {
      expected_revision: 1, credential: { scheme: 'file', name: 'mineru-token' },
    })
    expectKernelError(() => kernel.setProjectModelBinding(projectId, {
      purpose: 'vision', provider_id: 'mineru', model_id: 'flash',
      expected_provider_revision: credentialed.revision, expected_revision: bound.revision,
    }), 422, 'provider_capability_missing')
    expectKernelError(() => kernel.setProjectModelBinding(projectId, {
      purpose: 'vision', provider_id: 'mineru', model_id: 'pipeline',
      expected_provider_revision: credentialed.revision, expected_revision: bound.revision,
    }), 422, 'provider_capability_missing')
    const vision = kernel.setProjectModelBinding(projectId, {
      purpose: 'vision', provider_id: 'mineru', model_id: 'vlm',
      expected_provider_revision: credentialed.revision, expected_revision: bound.revision,
    })
    expect(vision).toMatchObject({ purpose: 'vision', model_id: 'vlm', provider_revision: 2, revision: 2 })
  })

  it('registers a provider with its model catalog and bumps revision on update (CAS)', () => {
    const kernel = freshKernel(null, { hosts: ['models.example.com'] })
    const created = kernel.registerProvider(providerInput())
    expect(created.revision).toBe(1)
    expect(created.models).toHaveLength(2)
    expect(kernel.getProvider('prov_ocr').display_name).toBe('OCR Provider')

    // Wrong expected revision → 409 provider_revision_conflict.
    expectKernelError(
      () => kernel.updateProvider('prov_ocr', { expected_revision: 99, display_name: 'X' }),
      409, 'provider_revision_conflict',
    )
    // Correct CAS → revision 2, catalog replaced.
    const updated = kernel.updateProvider('prov_ocr', { expected_revision: 1, display_name: 'OCR v2', models: [{ model_id: 'ocr-model-1', capabilities: ['ocr'] }] })
    expect(updated.revision).toBe(2)
    expect(updated.display_name).toBe('OCR v2')
    expect(updated.models).toHaveLength(1)
    // Disable via PATCH-enabled flag.
    const disabled = kernel.updateProvider('prov_ocr', { expected_revision: 2, enabled: false })
    expect(disabled.enabled).toBe(false)
    // Duplicate provider → 409 provider_exists.
    expectKernelError(() => kernel.registerProvider(providerInput()), 409, 'provider_exists')
    // Delete with wrong revision → 409; correct → gone.
    expectKernelError(() => kernel.deleteProvider('prov_ocr', 2), 409, 'provider_revision_conflict')
    kernel.deleteProvider('prov_ocr', 3)
    expectKernelError(() => kernel.getProvider('prov_ocr'), 404, 'provider_unknown')
  })

  it('distinguishes explicit no-auth from corrupt credential metadata', () => {
    const kernel = freshKernel(null, { hosts: ['models.example.com'] })
    kernel.registerProvider(providerInput())
    const cleared = kernel.updateProvider('prov_ocr', { expected_revision: 1, credential: null })
    expect(cleared.credential).toBeUndefined()
    expect(kernel.providerView(cleared)).not.toHaveProperty('credential')
    kernel.db.prepare('UPDATE model_providers SET credential_json = ? WHERE provider_id = ?').run('{bad-json', 'prov_ocr')
    expectKernelError(() => kernel.getProvider('prov_ocr'), 500, 'provider_credential_corrupt')
  })

  it('rejects model capabilities the provider does not declare (422 provider_capability_missing)', () => {
    const kernel = freshKernel(null, { hosts: ['models.example.com'] })
    expectKernelError(
      () => kernel.registerProvider(providerInput({ models: [{ model_id: 'm1', capabilities: ['embedding'] }] })),
      422, 'provider_capability_missing',
    )
  })
})

describe('MODEL-01 SecretRef strict schema (value/token/password 拒绝)', () => {
  it('rejects value/token/password/credential fields with 422 secret_value_forbidden', () => {
    const kernel = freshKernel(null, { hosts: ['models.example.com'] })
    const base = providerInput()
    for (const forbidden of ['value', 'token', 'password', 'api_key', 'credential']) {
      const credential = { scheme: 'file', name: 'k', [forbidden]: 'SUPER-SECRET' } as unknown as SecretRef
      expectKernelError(
        () => kernel.registerProvider({ ...base, credential }),
        422, 'secret_value_forbidden',
      )
    }
  })

  it('never stores or echoes a secret value: serialized provider rows/responses are key-clean', () => {
    const kernel = freshKernel(null, { hosts: ['models.example.com'] })
    const created = kernel.registerProvider(providerInput())
    // The stored credential_json is the metadata ONLY.
    const row = kernel.db.prepare('SELECT credential_json FROM model_providers WHERE provider_id = ?').get('prov_ocr') as { credential_json: string }
    expect(JSON.parse(row.credential_json)).toEqual({ scheme: 'file', name: 'my-ocr-key' })
    assertNoSecretKeys(created)
    assertNoSecretKeys(kernel.listProviders())
    assertNoSecretKeys(kernel.providerView(created))
    // Provider 名/secret 引用属于配置数据，可回显；值类键永不出现。
    expect(kernel.providerView(created).credential.name).toBe('my-ocr-key')
  })

  it('file-scheme availability reflects server-side existence; keyring/vault are honestly false', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-secret-root-'))
    mkdirSync(join(dir, 'secrets'), { recursive: true })
    writeFileSync(join(dir, 'secrets', 'my-ocr-key'), 'dummy')
    const kernel = freshKernel(join(dir, 'secrets'), { hosts: ['models.example.com'] })
    const created = kernel.registerProvider(providerInput())
    expect(kernel.providerView(created).credential.available).toBe(true)
    const missing = kernel.registerProvider(providerInput({
      provider_id: 'prov_missing',
      credential: { scheme: 'file', name: 'no-such-file' },
    }))
    expect(kernel.providerView(missing).credential.available).toBe(false)
    const vault = kernel.registerProvider(providerInput({
      provider_id: 'prov_vault',
      credential: { scheme: 'vault', name: 'vault-ref' },
    }))
    // keyring/vault：本实例无 resolver → false（如实记录，不伪装）。
    expect(kernel.providerView(vault).credential.available).toBe(false)
  })
})

describe('MODEL-01 base URL SSRF/scheme validation (fail closed)', () => {
  const ALLOW = { hosts: ['models.example.com'], allowLoopback: true }

  it('rejects non-https schemes, userinfo and malformed URLs', () => {
    const kernel = freshKernel(null, ALLOW)
    expectKernelError(
      () => kernel.registerProvider(providerInput({ base_url: 'ftp://models.example.com/v1' })),
      422, 'provider_url_scheme_invalid',
    )
    expectKernelError(
      () => kernel.registerProvider(providerInput({ base_url: 'https://user:pass@models.example.com/v1' })),
      422, 'provider_url_userinfo_rejected',
    )
    expectKernelError(
      () => kernel.registerProvider(providerInput({ base_url: 'not a url' })),
      422, 'provider_url_malformed',
    )
  })

  it('rejects private/reserved IP literals (SSRF) and unallowlisted DNS hosts', () => {
    // No allowLoopback here: loopback IPs must be explicitly allowlisted,
    // otherwise they are private-range SSRF targets like any other.
    const kernel = freshKernel(null, { hosts: ['models.example.com'] })
    for (const evil of ['https://10.0.0.1/v1', 'https://192.168.1.1/v1', 'https://127.0.0.1/v1', 'https://169.254.169.254/latest/meta-data', 'https://[::1]/v1', 'https://[fe80::1]/v1']) {
      expectKernelError(
        () => kernel.registerProvider(providerInput({ provider_id: `evil_${evil.length}`, base_url: evil })),
        422, 'provider_url_ssrf_rejected',
      )
    }
    expectKernelError(
      () => kernel.registerProvider(providerInput({ provider_id: 'dns_evil', base_url: 'https://internal.corp.local/v1' })),
      422, 'provider_url_ssrf_rejected',
    )
  })

  it('accepts allowlisted DNS https hosts and allowlisted loopback http', () => {
    const kernel = freshKernel(null, ALLOW)
    const ok = kernel.registerProvider(providerInput({ base_url: 'https://models.example.com/v1' }))
    expect(ok.base_url).toBe('https://models.example.com/v1')
    const loopback = kernel.registerProvider(providerInput({ provider_id: 'prov_local', base_url: 'http://127.0.0.1:8080/v1' }))
    expect(loopback.base_url).toBe('http://127.0.0.1:8080/v1')
    // http to a NON-loopback host stays rejected even with allowLoopback.
    expectKernelError(
      () => kernel.registerProvider(providerInput({ provider_id: 'http_evil', base_url: 'http://models.example.com/v1' })),
      422, 'provider_url_scheme_invalid',
    )
  })
})

describe('MODEL-01 project binding (opaque provider/model ID only)', () => {
  it('binds a project to provider/model and snapshots provider revision + config hash', () => {
    const kernel = freshKernel(null, { hosts: ['models.example.com'] })
    const provider = kernel.registerProvider(providerInput())
    const projectId = nameOnlyProject(kernel)
    const binding = kernel.setProjectModelBinding(projectId, { purpose: 'ocr', provider_id: 'prov_ocr', model_id: 'ocr-model-1' })
    expect(binding.provider_id).toBe('prov_ocr')
    expect(binding.model_id).toBe('ocr-model-1')
    expect(binding.purpose).toBe('ocr')
    expect(binding.provider_revision).toBe(provider.revision)
    expect(binding.provider_config_hash).toMatch(/^[0-9a-f]{64}$/)
    expect(binding.revision).toBe(1)
    const read = kernel.getProjectModelBinding(projectId)
    expect(read?.model_id).toBe('ocr-model-1')
    assertNoSecretKeys(read)
  })

  it('rejects unknown provider / disabled provider / unknown model / missing capability', () => {
    const kernel = freshKernel(null, { hosts: ['models.example.com'] })
    kernel.registerProvider(providerInput())
    const projectId = nameOnlyProject(kernel)
    expectKernelError(() => kernel.setProjectModelBinding(projectId, { purpose: 'ocr', provider_id: 'prov_nope', model_id: 'x' }), 404, 'provider_unknown')
    expectKernelError(() => kernel.setProjectModelBinding(projectId, { purpose: 'ocr', provider_id: 'prov_ocr', model_id: 'no-such-model' }), 422, 'model_unknown')
    expectKernelError(() => kernel.setProjectModelBinding(projectId, { purpose: 'chat', provider_id: 'prov_ocr', model_id: 'ocr-model-1' }), 422, 'provider_capability_missing')
    kernel.updateProvider('prov_ocr', { expected_revision: 1, enabled: false })
    expectKernelError(() => kernel.setProjectModelBinding(projectId, { purpose: 'ocr', provider_id: 'prov_ocr', model_id: 'ocr-model-1' }), 422, 'provider_disabled')
  })

  it('binding changes use revision CAS (409 binding_revision_conflict)', () => {
    const kernel = freshKernel(null, { hosts: ['models.example.com'] })
    kernel.registerProvider(providerInput())
    const projectId = nameOnlyProject(kernel)
    kernel.setProjectModelBinding(projectId, { purpose: 'ocr', provider_id: 'prov_ocr', model_id: 'ocr-model-1' })
    expectKernelError(
      () => kernel.setProjectModelBinding(projectId, { purpose: 'ocr', provider_id: 'prov_ocr', model_id: 'ocr-model-1', expected_revision: 5 }),
      409, 'binding_revision_conflict',
    )
    const rebound = kernel.setProjectModelBinding(projectId, { purpose: 'vision', provider_id: 'prov_ocr', model_id: 'vision-model-1', expected_revision: 1 })
    expect(rebound.revision).toBe(2)
    expect(rebound.purpose).toBe('vision')
  })

  it('deleting a provider clears bindings that referenced it (fail closed)', () => {
    const kernel = freshKernel(null, { hosts: ['models.example.com'] })
    kernel.registerProvider(providerInput())
    const projectId = nameOnlyProject(kernel)
    kernel.setProjectModelBinding(projectId, { purpose: 'ocr', provider_id: 'prov_ocr', model_id: 'ocr-model-1' })
    kernel.deleteProvider('prov_ocr', 1)
    expect(kernel.getProjectModelBinding(projectId)).toBeNull()
  })
})
