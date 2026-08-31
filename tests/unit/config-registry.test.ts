/**
 * CONFIG-01 — canonical Config Registry unit tests (hardening-v0.2-status.md
 * §3 CONFIG-01; docs/config-registry.md; acceptance-tests.md §11 config-*).
 */
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import {
  CONFIG_REGISTRY, CONFIG_SCOPES, ConfigRegistryError, ExecutionConfig, IntegrityConfig,
  configKeysForScope, defaultConfigForScopes, generateCliHelp, generateJsonSchema,
  generateTemplateYaml, getConfigKey, isLoopbackHost, parseCli, pinConfig, validateConfig,
  zodToJsonSchema,
} from '@dsh-scholar/research-schemas'

describe('config registry — key coverage', () => {
  it('registry covers every current runtime config item', () => {
    const keys = new Set(CONFIG_REGISTRY.map(def => def.key))
    // ExecutionConfig + IntegrityConfig full field coverage.
    for (const key of Object.keys(ExecutionConfig.shape)) expect(keys.has(`execution.${key}`)).toBe(true)
    for (const key of Object.keys(IntegrityConfig.shape)) expect(keys.has(`integrity.${key}`)).toBe(true)
    // Kernel runtime config includes managed secrets, but its CLI exposes only
    // non-secret process options.
    for (const key of ['kernel.host', 'kernel.port', 'kernel.token', 'kernel.service_token', 'kernel.db', 'kernel.cas', 'kernel.secret_root', 'kernel.endpoint_file']) {
      expect(keys.has(key)).toBe(true)
    }
    // runner CLI (poll/heartbeat/timeout/cancel/owner/mode/kernel/key-file/token/service-token).
    for (const key of ['runner.poll_ms', 'runner.heartbeat_ms', 'runner.timeout_ms', 'runner.cancel_poll_ms', 'runner.owner', 'runner.mode', 'runner.kernel', 'runner.key_file', 'runner.token', 'runner.service_token', 'runner.target_token']) {
      expect(keys.has(key)).toBe(true)
    }
    // orchestrator CLI (kernel/db/poll-ms/once/dry-run).
    for (const key of ['orchestrator.kernel', 'orchestrator.db', 'orchestrator.poll_ms', 'orchestrator.once', 'orchestrator.dry_run']) {
      expect(keys.has(key)).toBe(true)
    }
    // Standalone runtime config includes its managed token file, but the CLI
    // exposes only non-secret process options (plus explicit --no-token).
    for (const key of ['standalone.host', 'standalone.port', 'standalone.token', 'standalone.principal', 'standalone.frame_ancestors', 'standalone.data_dir', 'standalone.kernel_port', 'standalone.kernel_data_dir', 'standalone.no_token']) {
      expect(keys.has(key)).toBe(true)
    }
    // images.lock path + digests + network_policy.
    for (const key of ['global.images_lock.path', 'global.images_lock.node_fixture', 'global.images_lock.texlive', 'execution.network_policy']) {
      expect(keys.has(key)).toBe(true)
    }
    // env aliases are declared where they exist (DSH_* series).
    const envs = new Map(CONFIG_REGISTRY.filter(def => def.env !== undefined).map(def => [def.key, def.env]))
    expect(envs.get('kernel.token')).toBe('DSH_SCHOLAR_KERNEL_TOKEN')
    expect(envs.get('kernel.service_token')).toBe('DSH_SCHOLAR_SERVICE_TOKEN')
    expect(envs.get('kernel.secret_root')).toBe('DSH_SCHOLAR_SECRET_ROOT')
    expect(envs.get('runner.token')).toBe('DSH_SCHOLAR_KERNEL_TOKEN')
    expect(envs.get('runner.service_token')).toBe('DSH_SCHOLAR_SERVICE_TOKEN')
    expect(envs.get('runner.target_token')).toBe('DSH_SCHOLAR_RUNNER_TARGET_TOKEN')
    expect(envs.get('kernel.endpoint_file')).toBe('DSH_SCHOLAR_KERNEL_ENDPOINT_FILE')
    expect(envs.get('global.images_lock.path')).toBe('DSH_IMAGES_LOCK')
    expect(envs.get('standalone.host')).toBe('DSH_SCHOLAR_STANDALONE_HOST')
    expect(envs.get('standalone.port')).toBe('DSH_SCHOLAR_STANDALONE_PORT')
    expect(envs.get('standalone.kernel_port')).toBe('DSH_SCHOLAR_STANDALONE_KERNEL_PORT')
    expect(envs.get('standalone.kernel_data_dir')).toBe('DSH_SCHOLAR_KERNEL_DATA')
    expect(envs.get('standalone.data_dir')).toBe('DSH_SCHOLAR_STANDALONE_DATA')
    expect(envs.get('standalone.frame_ancestors')).toBe('DSH_SCHOLAR_STANDALONE_FRAME_ANCESTORS')
  })

  it('registry invariants: unique keys, valid scopes, schema+default present', () => {
    const seen = new Set<string>()
    for (const def of CONFIG_REGISTRY) {
      expect(seen.has(def.key)).toBe(false)
      seen.add(def.key)
      expect(CONFIG_SCOPES).toContain(def.scope)
      expect(def.schema).toBeDefined()
      expect(def.default).toBeDefined()
      expect(def.description.length).toBeGreaterThan(0)
      expect(def.sources.length).toBeGreaterThan(0)
      if (def.secret === true) expect(typeof def.default).toBe('string')
    }
    // every key is reachable through the lookups
    expect(CONFIG_REGISTRY.length).toBe(configKeysForScope('global').length + configKeysForScope('project').length +
      configKeysForScope('job').length + configKeysForScope('runner-profile').length +
      configKeysForScope('orchestrator').length + configKeysForScope('kernel').length +
      configKeysForScope('standalone').length)
    for (const def of CONFIG_REGISTRY) expect(getConfigKey(def.key)?.key).toBe(def.key)
    expect(getConfigKey('does.not.exist')).toBeUndefined()
    expect(CONFIG_SCOPES).toEqual(['global', 'project', 'job', 'runner-profile', 'orchestrator', 'kernel', 'standalone'])
  })

  it('does not advertise methodology controls before a writable project-config consumer exists', () => {
    const deferred = [
      'methodology.assurance_level',
      'methodology.inner_loop_max_iterations',
      'methodology.synthesis_valid_cycles',
      'methodology.synthesis_stagnation_cycles',
      'methodology.reviewer_max_fanout',
      'knowledge_registry.enabled',
      'knowledge_registry.remote_sources',
      'knowledge_registry.max_active_packs',
      // Rollout is an append-only Kernel policy with project/execution pins,
      // not a file/env/UI Setting. Registering this key would create a
      // second, unused source of truth.
      'methodology.rollout_mode',
    ]
    const projectKeys = new Set(configKeysForScope('project').map(def => def.key))
    for (const key of deferred) {
      expect(projectKeys.has(key)).toBe(false)
      expect(getConfigKey(key)).toBeUndefined()
      expect(() => validateConfig({ [key]: key.endsWith('.enabled') ? true : 1 }, { scopes: ['project'] }))
        .toThrow(ConfigRegistryError)
    }
  })

  it('every zod schema accepts its own default and rejects a wrong type', () => {
    for (const def of CONFIG_REGISTRY) {
      expect(def.schema.safeParse(def.default).success).toBe(true)
      if (typeof def.default === 'number') {
        expect(def.schema.safeParse('nope').success).toBe(false)
      } else if (typeof def.default === 'boolean') {
        expect(def.schema.safeParse('nope').success).toBe(false)
      } else if (typeof def.default === 'string') {
        expect(def.schema.safeParse(42).success).toBe(false)
      }
    }
  })
})

describe('config registry — validateConfig', () => {
  it('merges defaults for the requested scopes', () => {
    const resolved = validateConfig({}, { scopes: ['project'] })
    expect(resolved.effective['execution.runner_profile_id']).toBeNull()
    expect(resolved.effective['execution.network_policy']).toBe('allowlist')
    expect(resolved.effective['execution.artifact_store']).toBe('local-cas')
    expect(resolved.effective['integrity.require_baseline_reproduction']).toBe(true)
    expect(resolved.effective['integrity.require_clean_room_rerun']).toBe(false)
    expect(resolved.effective['integrity.require_signed_manifest']).toBe(false)
    // out-of-scope keys are NOT merged in
    expect(resolved.effective['kernel.port']).toBeUndefined()
    expect(resolved.effective['runner.poll_ms']).toBeUndefined()
  })

  it('overrides win over defaults and are validated', () => {
    const resolved = validateConfig({ 'execution.runner_profile_id': 'profile_local_docker_gpu_v1', 'runner.poll_ms': 3000 })
    expect(resolved.effective['execution.runner_profile_id']).toBe('profile_local_docker_gpu_v1')
    expect(resolved.effective['runner.poll_ms']).toBe(3000)
    expect(() => validateConfig({ 'runner.poll_ms': -5 })).toThrow(ConfigRegistryError)
    expect(() => validateConfig({ 'execution.runner_profile': 'local-docker-cpu' })).toThrow(/unknown config key/)
    expect(() => validateConfig({ 'kernel.port': 99999 })).toThrow(ConfigRegistryError)
    expect(validateConfig({}, { scopes: ['kernel'] }).effective).toMatchObject({
      'kernel.pty_idle_ttl_s': 900,
      'kernel.pty_retention_bytes': 1024 * 1024,
      'kernel.pty_lease_ttl_s': 3600,
    })
    expect(getConfigKey('kernel.pty_idle_ttl_s')?.write).toEqual({
      allowedScopes: ['runtime'], apply: 'hot', securityMerge: 'replace',
    })
    expect(() => validateConfig({ 'kernel.pty_idle_ttl_s': 0 }, { scopes: ['kernel'] })).toThrow(ConfigRegistryError)
    expect(() => validateConfig({ 'kernel.pty_retention_bytes': 1024 }, { scopes: ['kernel'] })).toThrow(ConfigRegistryError)
    expect(() => validateConfig({ 'kernel.pty_lease_ttl_s': 86_401 }, { scopes: ['kernel'] })).toThrow(ConfigRegistryError)
  })

  it('rejects unknown keys (and out-of-scope keys)', () => {
    expect(() => validateConfig({ 'execution.bogus': 1 })).toThrowError(/unknown config key/)
    try {
      validateConfig({ 'execution.bogus': 1 })
      expect.unreachable()
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigRegistryError)
      expect((error as ConfigRegistryError).code).toBe('unknown_config_key')
      expect((error as ConfigRegistryError).key).toBe('execution.bogus')
    }
    expect(() => validateConfig({ 'runner.poll_ms': 2000 }, { scopes: ['project'] })).toThrowError(/unknown config key/)
  })

  it('groups effective values by scope', () => {
    const resolved = validateConfig({}, { scopes: ['project', 'kernel'] })
    expect(resolved.byScope.project['execution.runner_profile_id']).toBeNull()
    expect(resolved.byScope.kernel['kernel.port']).toBe(7412)
    expect(Object.keys(resolved.byScope)).toEqual(CONFIG_SCOPES)
  })

  it('zod schemas of project keys agree with ExecutionConfig/IntegrityConfig defaults', () => {
    const resolved = validateConfig({}, { scopes: ['project'] })
    expect(ExecutionConfig.safeParse({}).success).toBe(false)
    const execution = ExecutionConfig.parse({ runner_profile_id: null })
    const integrity = IntegrityConfig.parse({})
    for (const [key, value] of Object.entries(execution)) {
      expect(resolved.effective[`execution.${key}`]).toEqual(value)
    }
    for (const [key, value] of Object.entries(integrity)) {
      expect(resolved.effective[`integrity.${key}`]).toEqual(value)
    }
  })
})

describe('config registry — parseCli (binary CLI parsing)', () => {
  it('does not accept kernel, standalone, or runner secret credentials on argv', () => {
    for (const [scope, flag] of [
      ['kernel', '--token'],
      ['kernel', '--service-token'],
      ['standalone', '--token'],
      ['runner-profile', '--token'],
      ['runner-profile', '--service-token'],
      ['runner-profile', '--target-token'],
    ] as const) {
      expect(() => parseCli([flag, 'argv-secret-canary'], scope)).toThrowError(/unknown CLI flag/)
      expect(generateCliHelp(scope)).not.toContain(flag)
    }
  })

  it('kernel: every registry flag maps to its canonical key with typed values', () => {
    const parsed = parseCli(['--db', '/tmp/k.db', '--cas', '/tmp/cas', '--port', '7413', '--host', '0.0.0.0',
      '--secret-root', '/tmp/secrets', '--endpoint-file', '/tmp/ep.json'], 'kernel')
    expect(parsed).toEqual({
      'kernel.db': '/tmp/k.db',
      'kernel.cas': '/tmp/cas',
      'kernel.port': 7413,
      'kernel.host': '0.0.0.0',
      'kernel.secret_root': '/tmp/secrets',
      'kernel.endpoint_file': '/tmp/ep.json',
    })
    // absent flags are NOT merged with defaults — the caller's
    // validateConfig does that, so the bin keeps one default source.
    expect(parseCli([], 'kernel')).toEqual({})
    // --flag=value form works too
    expect(parseCli(['--port=7414'], 'kernel')['kernel.port']).toBe(7414)
  })

  it('runner: every registry flag maps to its canonical key', () => {
    expect(parseCli(['--kernel', 'http://127.0.0.1:9999', '--mode', 'docker', '--poll-ms', '150',
      '--timeout-ms', '30000', '--heartbeat-ms', '1500', '--cancel-poll-ms', '1000', '--owner', 'x',
      '--key-file', '/tmp/k.pem'], 'runner-profile')).toEqual({
      'runner.kernel': 'http://127.0.0.1:9999',
      'runner.mode': 'docker',
      'runner.poll_ms': 150,
      'runner.timeout_ms': 30000,
      'runner.heartbeat_ms': 1500,
      'runner.cancel_poll_ms': 1000,
      'runner.owner': 'x',
      'runner.key_file': '/tmp/k.pem',
    })
  })

  it('standalone: every registry flag maps to its canonical key (booleans included)', () => {
    expect(parseCli(['--host', '127.0.0.1', '--port', '18611', '--kernel-port', '17414',
      '--kernel-data-dir', '/tmp/kernel', '--data-dir', '/tmp/d', '--principal', 'ops-1', '--frame-ancestors', 'http://127.0.0.1:3080'], 'standalone')).toEqual({
      'standalone.host': '127.0.0.1',
      'standalone.port': 18611,
      'standalone.kernel_port': 17414,
      'standalone.kernel_data_dir': '/tmp/kernel',
      'standalone.data_dir': '/tmp/d',
      'standalone.principal': 'ops-1',
      'standalone.frame_ancestors': 'http://127.0.0.1:3080',
    })
    expect(parseCli(['--no-token'], 'standalone')).toEqual({ 'standalone.no_token': true })
  })

  it('orchestrator: every registry flag maps to its canonical key', () => {
    expect(parseCli(['--kernel', 'http://127.0.0.1:9999', '--db', '/tmp/a.db', '--poll-ms', '5000', '--once', '--dry-run'], 'orchestrator')).toEqual({
      'orchestrator.kernel': 'http://127.0.0.1:9999',
      'orchestrator.db': '/tmp/a.db',
      'orchestrator.poll_ms': 5000,
      'orchestrator.once': true,
      'orchestrator.dry_run': true,
    })
  })

  it('rejects unknown CLI flags with unknown_config_key (all scopes)', () => {
    for (const [argv, scope] of [
      [['--bogus'], 'kernel'],
      [['--nope', 'x'], 'runner-profile'],
      [['--what'], 'standalone'],
      [['--never'], 'orchestrator'],
    ] as const) {
      try {
        parseCli([...argv], scope)
        expect.unreachable(`should reject ${argv[0]}`)
      } catch (error) {
        expect(error).toBeInstanceOf(ConfigRegistryError)
        expect((error as ConfigRegistryError).code).toBe('unknown_config_key')
        expect((error as Error).message).toContain(argv[0])
      }
    }
  })

  it('rejects non-numeric number flags; value-level failures surface at validateConfig', () => {
    try {
      parseCli(['--port', 'abc'], 'kernel')
      expect.unreachable()
    } catch (error) {
      expect((error as ConfigRegistryError).code).toBe('validation_error')
      expect((error as Error).message).toContain('--port must be a number')
    }
    expect(() => validateConfig(parseCli(['--port', '99999'], 'kernel'), { scopes: ['kernel'] })).toThrow(ConfigRegistryError)
    expect(() => validateConfig(parseCli(['--mode', 'bogus'], 'runner-profile'), { scopes: ['runner-profile'] })).toThrow(/invalid value/)
  })

  it('secret flags never appear in error messages', () => {
    const secret = 'dsh-top-secret-value-99'
    try {
      parseCli(['--token', secret, '--bogus'], 'kernel')
      expect.unreachable()
    } catch (error) {
      expect((error as Error).message).not.toContain(secret)
    }
    try {
      parseCli(['--service-token', secret, '--poll-ms', 'x'], 'runner-profile')
      expect.unreachable()
    } catch (error) {
      expect((error as Error).message).not.toContain(secret)
    }
  })

  it('CLI-parsed configs feed validateConfig: defaults merge, pin changes with flags', () => {
    const base = validateConfig(parseCli([], 'kernel'), { scopes: ['kernel'] })
    expect(base.effective['kernel.port']).toBe(7412)
    const tweaked = validateConfig(parseCli(['--port', '7413'], 'kernel'), { scopes: ['kernel'] })
    expect(tweaked.effective['kernel.port']).toBe(7413)
    expect(tweaked.pinHash).not.toBe(base.pinHash)
    // A secret supplied through the managed env/file seam still changes the
    // pin one-way and remains redacted; it is never parsed from argv.
    const withSecret = validateConfig({ 'kernel.token': 'managed-secret' }, { scopes: ['kernel'] })
    expect(withSecret.pinHash).not.toBe(base.pinHash)
    expect(withSecret.redacted['kernel.token']).toBe('<redacted>')
    expect(JSON.stringify(withSecret.redacted)).not.toContain('managed-secret')
  })

  it('every scope flag is unique and parseCli round-trips the registry flag list', () => {
    for (const scope of CONFIG_SCOPES) {
      const flags = CONFIG_REGISTRY.filter(def => def.scope === scope && def.cli !== undefined).map(def => def.cli?.flag)
      expect(new Set(flags).size).toBe(flags.length)
      for (const flag of flags) {
        const def = CONFIG_REGISTRY.find(d => d.scope === scope && d.cli?.flag === flag)
        const value = def?.schema instanceof z.ZodBoolean ? `--${flag}` : def?.schema instanceof z.ZodNumber ? [`--${flag}`, '1'] : [`--${flag}`, 'v']
        const parsed = parseCli(Array.isArray(value) ? value : [value], scope)
        expect(Object.keys(parsed)).toEqual([def?.key])
      }
    }
  })
})

describe('config registry — secrets and pin hash', () => {
  it('redacts secret values from plaintext output but commits them in the pin', () => {
    const secret = 'dsh-super-secret-token-123'
    const resolved = validateConfig({ 'kernel.service_token': secret })
    expect(resolved.redacted['kernel.service_token']).toBe('<redacted>')
    expect(resolved.effective['kernel.service_token']).toBe(secret)
    expect(JSON.stringify(resolved.redacted)).not.toContain(secret)
    // the pin commits the secret one-way: identical config → identical pin
    const again = validateConfig({ 'kernel.service_token': secret })
    expect(again.pinHash).toBe(resolved.pinHash)
    // changing the secret changes the pin
    const changed = validateConfig({ 'kernel.service_token': `${secret}-x` })
    expect(changed.pinHash).not.toBe(resolved.pinHash)
    // defaults for secret keys are redacted too
    expect(validateConfig({}).redacted['kernel.token']).toBe('<redacted>')
    expect(validateConfig({}).redacted['kernel.secret_root']).toBe('<redacted>')
    expect(validateConfig({}).redacted['standalone.token']).toBe('<redacted>')
    expect(validateConfig({}).redacted['runner.service_token']).toBe('<redacted>')
    expect(validateConfig({}).redacted['runner.target_token']).toBe('<redacted>')
  })

  it('pin hash is stable and sensitive to any change', () => {
    expect(pinConfig({ a: 1, b: 'x' })).toBe(pinConfig({ b: 'x', a: 1 }))
    expect(pinConfig({ a: 1, b: 'x' })).toMatch(/^sha256:[0-9a-f]{64}$/)
    expect(pinConfig({ a: 1, b: 'x' })).not.toBe(pinConfig({ a: 1, b: 'y' }))
    expect(pinConfig({ a: 1, b: 'x' })).not.toBe(pinConfig({ a: 1 }))
    const base = validateConfig({}).pinHash
    const tweaked = validateConfig({ 'runner.poll_ms': 3000 }).pinHash
    expect(tweaked).not.toBe(base)
    // revalidation is deterministic
    expect(validateConfig({ 'runner.poll_ms': 3000 }).pinHash).toBe(tweaked)
  })
})

describe('config registry — security floor', () => {
  it('forbids privileged containers, docker socket and host networking', () => {
    for (const bad of [
      { 'runner.privileged': true },
      { 'runner.docker_socket': true },
      { 'runner.network': 'host' },
    ]) {
      try {
        validateConfig(bad)
        expect.unreachable(`should reject ${JSON.stringify(bad)}`)
      } catch (error) {
        expect(error).toBeInstanceOf(ConfigRegistryError)
        expect((error as ConfigRegistryError).code).toBe('security_floor_violation')
      }
    }
    // safe defaults pass
    expect(validateConfig({}).pinHash).toMatch(/^sha256:/)
  })

  it('forbids automatic public release (security-baseline.md §1)', () => {
    try {
      validateConfig({ 'integrity.allow_automatic_public_release': true })
      expect.unreachable()
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigRegistryError)
      expect((error as ConfigRegistryError).code).toBe('security_floor_violation')
      expect((error as Error).message).toContain('automatic public release')
    }
    // the schema default (false) passes
    expect(validateConfig({ 'integrity.allow_automatic_public_release': false }).pinHash).toMatch(/^sha256:/)
  })

  it('network_policy=none forbids any container network other than none', () => {
    // 'bridge' is legal under allowlist in container (docker) mode…
    expect(validateConfig({ 'execution.network_policy': 'allowlist', 'runner.network': 'bridge', 'runner.mode': 'docker' }).pinHash).toMatch(/^sha256:/)
    try {
      validateConfig({ 'execution.network_policy': 'none', 'runner.network': 'bridge', 'runner.mode': 'docker' })
      expect.unreachable()
    } catch (error) {
      expect((error as ConfigRegistryError).code).toBe('security_floor_violation')
      expect((error as Error).message).toContain('network_policy=none')
    }
    // host networking is a violation regardless of policy
    try {
      validateConfig({ 'execution.network_policy': 'allowlist', 'runner.network': 'host', 'runner.mode': 'docker' })
      expect.unreachable()
    } catch (error) {
      expect((error as ConfigRegistryError).code).toBe('security_floor_violation')
    }
    // none + none is legal
    expect(validateConfig({ 'execution.network_policy': 'none', 'runner.network': 'none' }).pinHash).toMatch(/^sha256:/)
  })

  it('subprocess mode forbids any container network config other than none', () => {
    // subprocess has no containers: bridge/host network config is a
    // fail-closed misconfiguration (execution-runtime.md §1); the default
    // (mode subprocess + network none) and docker+bridge stay legal.
    try {
      validateConfig({ 'runner.mode': 'subprocess', 'runner.network': 'bridge' })
      expect.unreachable('should reject subprocess + bridge')
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigRegistryError)
      expect((error as ConfigRegistryError).code).toBe('security_floor_violation')
      expect((error as Error).message).toContain('runner.mode=subprocess')
    }
    // host is banned regardless (its own floor rule fires first)
    try {
      validateConfig({ 'runner.mode': 'subprocess', 'runner.network': 'host' })
      expect.unreachable('should reject subprocess + host')
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigRegistryError)
      expect((error as ConfigRegistryError).code).toBe('security_floor_violation')
    }
    expect(validateConfig({ 'runner.mode': 'subprocess', 'runner.network': 'none' }).pinHash).toMatch(/^sha256:/)
    expect(validateConfig({ 'runner.mode': 'docker', 'runner.network': 'bridge' }).pinHash).toMatch(/^sha256:/)
    expect(validateConfig({ 'runner.mode': 'subprocess' }).pinHash).toMatch(/^sha256:/)
  })

  it('tokenless standalone mode is loopback-only', () => {
    try {
      validateConfig({ 'standalone.no_token': true, 'standalone.host': '0.0.0.0' })
      expect.unreachable()
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigRegistryError)
      expect((error as ConfigRegistryError).code).toBe('security_floor_violation')
      expect((error as Error).message).toMatch(/loopback/)
    }
    for (const host of ['127.0.0.1', 'localhost', '::1']) {
      expect(validateConfig({ 'standalone.no_token': true, 'standalone.host': host }).pinHash).toMatch(/^sha256:/)
    }
    expect(isLoopbackHost('127.8.9.10')).toBe(true)
    expect(isLoopbackHost('192.168.1.1')).toBe(false)
    expect(isLoopbackHost('::1')).toBe(true)
  })

  it('image digests must match the trusted images.lock entries when a lock is supplied', () => {
    const lock = { node_fixture: 'node@sha256:' + 'a'.repeat(64), texlive: 'texlive/texlive@sha256:' + 'b'.repeat(64) }
    // shape-only validation passes a well-formed digest
    expect(validateConfig({ 'global.images_lock.node_fixture': 'node@sha256:' + 'c'.repeat(64) }).pinHash).toMatch(/^sha256:/)
    expect(() => validateConfig({ 'global.images_lock.node_fixture': 'node:22-alpine' })).toThrow(/digest/)
    // with a lock, a foreign digest is a security-floor violation
    try {
      validateConfig({ 'global.images_lock.node_fixture': 'node@sha256:' + 'c'.repeat(64) }, { imagesLock: lock })
      expect.unreachable()
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigRegistryError)
      expect((error as ConfigRegistryError).code).toBe('security_floor_violation')
      expect((error as Error).message).toContain('images.lock node_fixture')
    }
    // exact lock entries pass
    const ok = validateConfig({ 'global.images_lock.node_fixture': lock.node_fixture, 'global.images_lock.texlive': lock.texlive }, { imagesLock: lock })
    expect(ok.pinHash).toMatch(/^sha256:/)
  })

  it('registers the floor keys as security-floor flagged', () => {
    const floor = CONFIG_REGISTRY.filter(def => def.securityFloor === true).map(def => def.key)
    for (const key of ['runner.privileged', 'runner.docker_socket', 'runner.network', 'execution.network_policy',
      'standalone.no_token', 'global.images_lock.node_fixture', 'global.images_lock.texlive',
      'kernel.require_signed_manifest', 'integrity.allow_automatic_public_release', 'runner.mode']) {
      expect(floor).toContain(key)
    }
  })
})

describe('config registry — generated artifacts', () => {
  it('JSON Schema nests every registry key with type/enum/default and parity annotations', () => {
    const schema = generateJsonSchema()
    const text = JSON.stringify(schema)
    expect(schema.$schema).toBe('http://json-schema.org/draft-07/schema#')
    expect(schema.additionalProperties).toBe(false)
    const rootProps = (schema.properties as Record<string, { properties?: Record<string, unknown> }>)
    for (const def of CONFIG_REGISTRY) {
      // JSON Schema nests by SCOPE first; inner segments are the key minus
      // the scope name when the key starts with it (execution.*/integrity.*
      // are subgroups of the project scope and keep their prefix).
      const keySegments = def.key.split('.')
      const segments = keySegments[0] === def.scope ? keySegments.slice(1) : keySegments
      let node = rootProps[def.scope]
      expect(node, `scope ${def.scope} for ${def.key}`).toBeDefined()
      for (const segment of segments) {
        node = (node?.properties ?? {})[segment] as typeof node
      }
      expect(node, `leaf ${def.key}`).toBeDefined()
      expect(node?.type).toBeDefined()
      expect(node?.description).toBe(def.description)
      expect(node?.default).toEqual(def.default)
      expect(node?.['x-dsh-scope']).toBe(def.scope)
      if (def.secret === true) expect(node?.['x-dsh-secret']).toBe(true)
      if (def.securityFloor === true) expect(node?.['x-dsh-security-floor']).toBe(true)
    }
    // enum keys carry an enum; the network enum lists the floor modes
    const net = rootProps['runner-profile']?.properties?.runner?.properties?.network as { enum?: string[] }
    expect(net.enum).toEqual(['none', 'bridge', 'host'])
    expect(text).not.toContain('<redacted>')
  })

  it('template YAML lists every key with its default and markers', () => {
    const yaml = generateTemplateYaml()
    for (const def of CONFIG_REGISTRY) {
      const segments = def.key.split('.')
      const last = segments.at(-1) as string
      const renderedDefault = typeof def.default === 'string'
        ? def.default === ''
          ? "''"
          : /^[A-Za-z0-9._:/@-]+$/.test(def.default)
            ? def.default
            : JSON.stringify(def.default)
        : def.default === null
          ? 'null'
          : JSON.stringify(def.default)
      expect(yaml).toContain(`${last}: ${renderedDefault}`)
      expect(yaml).toContain(def.description)
    }
    for (const scope of CONFIG_SCOPES) expect(yaml).toContain(`${scope}:`)
    expect(yaml).toContain('GENERATED from packages/research-schemas/src/config-registry.ts')
    // secret keys carry the marker and appear as leaf lines (no dotted key in YAML)
    expect(yaml).toContain('kernel:')
    expect(yaml).toContain('token: ')
    expect(yaml).toContain('secret')
    // scope filter works
    const projectOnly = generateTemplateYaml({ scopes: ['project'] })
    expect(projectOnly).toContain('execution:')
    expect(projectOnly).toContain('integrity:')
    expect(projectOnly).not.toContain('poll_ms')
  })

  it('CLI help text is generated per scope from the registry flags', () => {
    const kernelHelp = generateCliHelp('kernel')
    expect(kernelHelp).toContain('--port')
    expect(kernelHelp).not.toContain('--token')
    expect(kernelHelp).not.toContain('--service-token')
    expect(kernelHelp).toContain('[secret]')
    const runnerHelp = generateCliHelp('runner-profile')
    for (const flag of ['--poll-ms', '--heartbeat-ms', '--timeout-ms', '--cancel-poll-ms', '--mode', '--owner']) {
      expect(runnerHelp).toContain(flag)
    }
    for (const secretFlag of ['--token', '--service-token', '--target-token']) {
      expect(runnerHelp).not.toContain(secretFlag)
    }
    const standaloneHelp = generateCliHelp('standalone')
    for (const flag of ['--host', '--port', '--principal', '--no-token']) {
      expect(standaloneHelp).toContain(flag)
    }
    expect(standaloneHelp).not.toContain('--token')
    const orchestratorHelp = generateCliHelp('orchestrator')
    for (const flag of ['--kernel', '--db', '--poll-ms', '--once', '--dry-run']) {
      expect(orchestratorHelp).toContain(flag)
    }
    // boolean flags render a boolean type hint
    expect(orchestratorHelp).toContain('--once <boolean>')
    expect(standaloneHelp).toContain('--no-token <boolean>')
  })

  it('zodToJsonSchema fails loud on unsupported types', () => {
    expect(() => zodToJsonSchema(z.record(z.unknown()))).toThrow(/unsupported zod type/)
  })
})
