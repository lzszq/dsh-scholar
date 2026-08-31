import { describe, expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'

const repo = fileURLToPath(new URL('../..', import.meta.url))
const script = join(repo, 'tests/integration/run-dsh-private-registry-tests.sh')

function run(args: string[], env: Record<string, string> = {}) {
  return spawnSync('bash', [script, ...args], {
    cwd: repo,
    encoding: 'utf8',
    env: {
      PATH: process.env.PATH ?? '',
      ...env,
      DSH_PRIVATE_REGISTRY_URL: env.DSH_PRIVATE_REGISTRY_URL ?? '',
      DSH_PRIVATE_REGISTRY_TOKEN: env.DSH_PRIVATE_REGISTRY_TOKEN ?? '',
      NPM_TOKEN: '',
      DSH_PRIVATE_DSH_SPEC: env.DSH_PRIVATE_DSH_SPEC ?? '',
      DSH_SCHOLAR_PLUGIN_SPEC: env.DSH_SCHOLAR_PLUGIN_SPEC ?? '',
    },
  })
}

describe('private @deepseek-ai registry compatibility harness', () => {
  it('pins source-build DSH peers while keeping the published host surface optional', () => {
    const baseline = JSON.parse(readFileSync(join(repo, 'config/dsh-baseline.json'), 'utf8')) as {
      version: string
    }
    const manifest = JSON.parse(readFileSync(join(repo, 'package.json'), 'utf8')) as {
      peerDependencies: Record<string, string>
      peerDependenciesMeta: Record<string, { optional?: boolean }>
      devDependencies: Record<string, string>
    }
    const dshPeers = Object.keys(manifest.peerDependencies)
      .filter(name => name.startsWith('@deepseek-ai/'))

    expect(dshPeers.length).toBeGreaterThan(0)
    for (const name of dshPeers) {
      expect(manifest.peerDependenciesMeta[name]?.optional, name).toBe(true)
      expect(manifest.devDependencies[name], name).toBeDefined()
    }
    for (const name of dshPeers.filter(name => name.startsWith('@deepseek-ai/dsh-'))) {
      expect(manifest.peerDependencies[name], name).toBe(`^${baseline.version}`)
      expect(manifest.devDependencies[name], name).toBe(baseline.version)
    }

    const scripts = (manifest as typeof manifest & {
      scripts: Record<string, string>
    }).scripts
    expect(scripts.build).toMatch(/^pnpm -r .* && pnpm run build:plugin$/)
    expect(scripts.prepare).toBe('pnpm run build')

    const workspace = readFileSync(join(repo, 'pnpm-workspace.yaml'), 'utf8')
    expect(workspace).toMatch(/^autoInstallPeers: true$/m)
    const pinnedDshVersions = [...workspace.matchAll(/'@deepseek-ai\/dsh-[^'@]+@([^']+)'/g)]
      .map(match => match[1])
    expect(pinnedDshVersions.length).toBeGreaterThan(0)
    expect(new Set(pinnedDshVersions)).toEqual(new Set([baseline.version]))
  })

  it('is pending locally but fail-closed by default and in CI', () => {
    const local = run(['--allow-pending'])
    expect(local.status).toBe(0)
    expect(local.stdout).toContain('NOT_RUN_MANUAL_PENDING')
    expect(run([]).status).toBe(2)
    expect(run(['--allow-pending'], { CI: 'true' }).status).toBe(2)
  })

  it('requires an explicit exact DSH host spec instead of silently testing an obsolete default', () => {
    const result = run([], {
      DSH_PRIVATE_REGISTRY_URL: 'https://registry.example.test',
      DSH_PRIVATE_REGISTRY_TOKEN: 'short-lived-token',
      DSH_SCHOLAR_PLUGIN_SPEC: '@dsh-scholar/research-plugin@0.1.0',
    })
    expect(result.status).toBe(2)
    expect(result.stdout).toContain('DSH_PRIVATE_DSH_SPEC is not configured')
  })

  it('rejects an exact but non-baseline DSH host before contacting the registry', () => {
    const baseline = JSON.parse(readFileSync(join(repo, 'config/dsh-baseline.json'), 'utf8')) as {
      version: string
    }
    const mismatched = baseline.version === '0.1.0' ? '0.1.1' : '0.1.0'
    const result = run([], {
      DSH_PRIVATE_REGISTRY_URL: 'https://registry.example.test',
      DSH_PRIVATE_REGISTRY_TOKEN: 'short-lived-token',
      DSH_PRIVATE_DSH_SPEC: `@deepseek-ai/dsh@${mismatched}`,
      DSH_SCHOLAR_PLUGIN_SPEC: '@dsh-scholar/research-plugin@0.1.0',
      PNPM_BIN: '/definitely/not/a/pnpm/binary',
    })
    expect(result.status).toBe(2)
    expect(result.stderr).toContain(`must equal @deepseek-ai/dsh@${baseline.version}`)
    expect(result.stderr).not.toContain('/definitely/not/a/pnpm/binary')
  })

  it('rejects an unsafe registry before package execution and never prints the token', () => {
    const token = 'super-secret-registry-token'
    const result = run([], {
      DSH_PRIVATE_REGISTRY_URL: 'http://user:password@example.test',
      DSH_PRIVATE_REGISTRY_TOKEN: token,
      DSH_SCHOLAR_PLUGIN_SPEC: '@dsh-scholar/research-plugin@0.1.0',
    })
    expect(result.status).toBe(2)
    expect(`${result.stdout}${result.stderr}`).not.toContain(token)
    expect(result.stderr).toContain('https URL without userinfo')
  })

  it('rejects floating or checkout-relative Scholar plugin specs before package execution', () => {
    const base = {
      DSH_PRIVATE_REGISTRY_URL: 'https://registry.example.test',
      DSH_PRIVATE_REGISTRY_TOKEN: 'short-lived-token',
    }
    for (const spec of ['@dsh-scholar/research-plugin@latest', 'file:./research-plugin.tgz', '../dsh-scholar']) {
      const result = run([], { ...base, DSH_SCHOLAR_PLUGIN_SPEC: spec })
      expect(result.status).toBe(2)
      expect(result.stderr).toContain('must pin an exact @dsh-scholar/research-plugin version')
    }
  })

  it('keeps repository .npmrc free of registry credentials', () => {
    const path = join(repo, '.npmrc')
    if (!existsSync(path)) return
    const npmrc = readFileSync(path, 'utf8')
    expect(npmrc).not.toContain('_authToken')
    expect(npmrc).not.toMatch(/^@deepseek-ai:registry=/m)
  })
})
