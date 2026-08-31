/**
 * PACK-01 / SKILL-01 / UI-03 packaging tests: every published tarball is
 * complete (lib/, skills/, cordis.patch.yml), a clean consumer install
 * resolves from sibling tarballs through test-only overrides,
 * the installed plugin declares its DSH host peers, the consumer install is
 * hermetic (real extracted files, no original-checkout paths, optional host
 * peers never force-installed without a registry), every skill ships with
 * valid name/description frontmatter, and the standalone unlock page is
 * bilingual through data-i18n keys backed by the zh/en locale dictionaries.
 * Full host-boot assertions belong to the pending DSH fixture job (CI-01).
 *
 * CI-01 / hardening §5: every pnpm invocation goes through `resolvePnpm()`
 * (npm_execpath → PATH probe → explicit install hint), so the suite is
 * reproducible even when pnpm is not on PATH.
 */
import { describe, expect, it, beforeAll } from 'vitest'
import { execFileSync, spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { chmodSync, mkdtempSync, readFileSync, existsSync, writeFileSync, mkdirSync, readdirSync, realpathSync, lstatSync, statSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer } from 'node:net'
import type { AddressInfo } from 'node:net'
import { zh as standaloneZh, en as standaloneEn } from '../../packages/dsh-research-ui/src/client/i18n/locales/standalone'

const REPO = fileURLToPath(new URL('../..', import.meta.url))
const SKILLS = ['research-core', 'domain-machine-learning', 'domain-data-science', 'venue-templates']
const PACKAGE_NAMES = [
  'research-plugin', 'research-client', 'research-kernel', 'research-schemas', 'scholar-connectors',
  'research-orchestrator', 'runner-gateway', 'analysis-engine', 'analysis-worker',
]
/** Runtime graph a clean consumer actually receives: the plugin plus its
 * runtime dependencies. runner-gateway/analysis-worker are dev-only workers
 * of the plugin and legitimately absent from a consumer install. */
const RUNTIME_NAMES = [
  'research-plugin', 'research-client', 'research-kernel', 'research-schemas', 'scholar-connectors',
  'research-orchestrator', 'analysis-engine',
]
const HOST_PEERS = [
  '@deepseek-ai/cordis',
  '@deepseek-ai/schemastery',
  '@deepseek-ai/dsh-commands',
  '@deepseek-ai/dsh-llm',
  '@deepseek-ai/dsh-skill-filesystem',
  '@deepseek-ai/dsh-tools',
]
const OPTIONAL_HOST_PEERS = [
  '@deepseek-ai/cordis',
  '@deepseek-ai/schemastery',
  '@deepseek-ai/dsh-commands',
  '@deepseek-ai/dsh-llm',
  '@deepseek-ai/dsh-skill-filesystem',
  '@deepseek-ai/dsh-tools',
]
/** Sibling DSH host harness checkout (SELFMOD-01): must never be referenced
 * by a published artifact or a clean consumer install. */
const HARNESS = join(dirname(REPO), 'test-lzszq')

function run(cmd: string, args: string[], cwd: string): string {
  return execFileSync(cmd, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
}

/**
 * Resolve the pnpm executable (CI-01 / hardening-v0.2-status.md §5:
 * "package manager 版本与调用入口固定；当前 commit 证据可复现").
 *
 * 1. `process.env.npm_execpath` — when this process was started by pnpm (a
 *    `pnpm test`/lifecycle script, or any caller that exports it), npm sets
 *    it to the ACTUAL pnpm CLI entry (e.g. `.../pnpm.cjs`/`pnpm.mjs`). Using
 *    it first makes the suite work even when pnpm is NOT on PATH.
 * 2. PATH probe (`pnpm --version`) — covers `pnpm exec`-style invocations
 *    where npm_execpath is unset but pnpm is on PATH.
 * 3. Otherwise THROW an explicit install hint — never a bare ENOENT.
 */
let resolvedPnpm: string | null = null
function resolvePnpm(): string {
  if (resolvedPnpm !== null) return resolvedPnpm
  const fromNpm = process.env.npm_execpath
  if (fromNpm !== undefined && fromNpm !== '' && /[\\/]pnpm(?:\.cjs|\.js|\.mjs|\.cmd|\.exe)?$/i.test(fromNpm)) {
    resolvedPnpm = fromNpm
    return fromNpm
  }
  const probe = spawnSync('pnpm', ['--version'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  if (probe.error === undefined && probe.status === 0) {
    resolvedPnpm = 'pnpm'
    return 'pnpm'
  }
  throw new Error(
    'pnpm executable not found: run the tests through pnpm (`pnpm test`) so npm_execpath points at ' +
    'the pnpm CLI, or add pnpm to PATH (install with: npm i -g pnpm). ' +
    `(probe: pnpm --version ${probe.error !== undefined ? probe.error.message : `exited ${probe.status}`})`,
  )
}

/**
 * Child env for every spawned pnpm: when the resolver used `npm_execpath`
 * (the pnpm CLI lives OUTSIDE PATH), prepend a shim dir containing a `pnpm`
 * executable so nested lifecycle `pnpm` calls (e.g. the root `prepare` →
 * `pnpm run build:plugin`) resolve the SAME CLI — pnpm's own run-script
 * PATH injection only re-adds `node_modules/.bin`, not the pnpm bin dir.
 * When pnpm is on PATH this is a plain inherited env.
 */
let pnpmShimDir: string | null = null
function pnpmChildEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env }
  const resolved = resolvePnpm()
  if (resolved === 'pnpm') return env
  if (pnpmShimDir === null) {
    pnpmShimDir = mkdtempSync(join(tmpdir(), 'dsh-pnpm-shim-'))
    const shim = join(pnpmShimDir, 'pnpm')
    writeFileSync(shim, `#!/bin/sh\nexec node "${resolved}" "$@"\n`)
    chmodSync(shim, 0o755)
  }
  env.PATH = `${pnpmShimDir}${env.PATH !== undefined ? `:${env.PATH}` : ''}`
  return env
}

/** Run pnpm through the resolved executable (see resolvePnpm). */
function runPnpm(args: string[], cwd: string): string {
  return execFileSync(resolvePnpm(), args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: pnpmChildEnv() })
}

interface Packed {
  dir: string
  tarballs: Record<string, string> // npm name -> tgz path
}

async function packAll(): Promise<Packed> {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-pack-'))
  const tarballs: Record<string, string> = {}
  const targets: Array<[string, string]> = [
    [REPO, 'research-plugin'],
    [join(REPO, 'packages/research-client'), 'research-client'],
    [join(REPO, 'packages/research-kernel'), 'research-kernel'],
    [join(REPO, 'packages/research-schemas'), 'research-schemas'],
    [join(REPO, 'packages/analysis-engine'), 'analysis-engine'],
    [join(REPO, 'packages/scholar-connectors'), 'scholar-connectors'],
    [join(REPO, 'workers/research-orchestrator'), 'research-orchestrator'],
    [join(REPO, 'workers/runner-gateway'), 'runner-gateway'],
    [join(REPO, 'workers/analysis-worker'), 'analysis-worker'],
  ]
  for (const [cwd, name] of targets) {
    runPnpm(['pack', '--pack-destination', dir], cwd)
  }
  for (const f of readdirSync(dir)) {
    if (!f.endsWith('.tgz')) continue
    const m = /dsh-scholar-([a-z-]+)-\d+\.\d+\.\d+\.tgz/.exec(f)
    if (m !== null) tarballs[m[1]!] = join(dir, f)
  }
  return { dir, tarballs }
}

function tarList(tgz: string): string[] {
  return run('tar', ['-tzf', tgz], '/').split('\n').filter(Boolean)
}

/** Read a JSON file through the public tarball boundary. */
function tarJson(tgz: string, path: string): Record<string, unknown> {
  return JSON.parse(run('tar', ['-xOzf', tgz, path], '/')) as Record<string, unknown>
}

/** Write the clean Scholar-artifact consumer used by the local PACK-01 unit
 * seam. pnpm still resolves transitive semver specs through a registry even
 * when sibling tarballs are direct dependencies, so this registry-less seam
 * needs explicit tarball overrides. It proves artifact extraction/path
 * isolation only and MUST NOT be reported as private-host compatibility;
 * tests/integration/run-dsh-private-registry-tests.sh owns that public seam. */
function writeConsumerProject(consumer: string, packed: Packed): void {
  const tgz = (n: string) => packed.tarballs[n]!.replaceAll('\\', '/')
  writeFileSync(join(consumer, 'pnpm-workspace.yaml'), [
    'packages: []',
    'autoInstallPeers: false',
    'overrides:',
    `  '@dsh-scholar/research-client': file:${tgz('research-client')}`,
    `  '@dsh-scholar/research-kernel': file:${tgz('research-kernel')}`,
    `  '@dsh-scholar/research-schemas': file:${tgz('research-schemas')}`,
    `  '@dsh-scholar/analysis-engine': file:${tgz('analysis-engine')}`,
    `  '@dsh-scholar/scholar-connectors': file:${tgz('scholar-connectors')}`,
    `  '@dsh-scholar/research-orchestrator': file:${tgz('research-orchestrator')}`,
    `  '@dsh-scholar/analysis-worker': file:${tgz('analysis-worker')}`,
    '',
  ].join('\n'))
  writeFileSync(join(consumer, 'package.json'), JSON.stringify({
    name: 'pack-consumer', private: true, version: '0.0.0',
    dependencies: { '@dsh-scholar/research-plugin': `file:${tgz('research-plugin')}` },
  }, null, 2))
}

/** pnpm install in the consumer; returns the combined install log. */
function installConsumer(consumer: string): string {
  const r = spawnSync(resolvePnpm(), ['install'], { cwd: consumer, encoding: 'utf8', env: pnpmChildEnv() })
  const log = `${r.stdout ?? ''}\n${r.stderr ?? ''}`
  if (r.status !== 0) throw new Error(`consumer pnpm install failed (exit ${r.status ?? 'null'}):\n${log}`)
  return log
}

/** Fresh consumer with a completed install; returns { consumer, log }. */
function makeConsumer(packed: Packed): { consumer: string; log: string } {
  const consumer = mkdtempSync(join(tmpdir(), 'dsh-consumer-'))
  writeConsumerProject(consumer, packed)
  const log = installConsumer(consumer)
  return { consumer, log }
}

/** All files under a directory (recursive; symlinked directories inside
 * pnpm's virtual store are not descended into, symlinks to files kept). */
function listFiles(dir: string): string[] {
  const out: string[] = []
  const walk = (d: string): void => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name)
      if (e.isDirectory()) {
        walk(p)
      } else if (e.isSymbolicLink()) {
        let st
        try { st = statSync(p) } catch { continue }
        if (st.isDirectory()) continue
        out.push(p)
      } else {
        out.push(p)
      }
    }
  }
  walk(dir)
  return out
}

/** Every installed copy of an @dsh-scholar package in the consumer: the
 * direct top-level link plus the transitive copies pnpm keeps inside its
 * isolated virtual store (node_modules/.pnpm). */
function findInstalled(consumer: string, name: string): string[] {
  const out: string[] = []
  const direct = join(consumer, 'node_modules', '@dsh-scholar', name)
  if (existsSync(direct)) out.push(direct)
  const virtualStore = join(consumer, 'node_modules', '.pnpm')
  if (existsSync(virtualStore)) {
    for (const entry of readdirSync(virtualStore)) {
      const p = join(virtualStore, entry, 'node_modules', '@dsh-scholar', name)
      if (existsSync(p)) out.push(p)
    }
  }
  return out
}

/** A free loopback TCP port (released immediately — small race, acceptable
 * for test-only binds). */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer()
    srv.once('error', reject)
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address() as AddressInfo
      srv.close(() => resolve(addr.port))
    })
  })
}

/** Poll the standalone homepage until the server answers (or the child dies). */
async function fetchHomepage(port: number, child: ChildProcess, getErr: () => string): Promise<{ html: string; headers: Headers }> {
  const deadline = Date.now() + 45_000
  let lastErr = 'not yet reachable'
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`standalone server exited (${child.exitCode}) before serving: ${getErr()}`)
    }
    try {
      const res = await fetch(`http://127.0.0.1:${port}/`)
      if (res.ok) return { html: await res.text(), headers: res.headers }
      lastErr = `http ${res.status}`
    } catch (error) {
      lastErr = error instanceof Error ? error.message : String(error)
    }
    await new Promise(resolve => setTimeout(resolve, 250))
  }
  throw new Error(`standalone server did not serve the homepage within 45s: ${lastErr}; ${getErr()}`)
}

describe('packaging (PACK-01/SKILL-01)', () => {
  let packed: Packed
  let rootManifest: Record<string, unknown>

  beforeAll(async () => {
    packed = await packAll()
    rootManifest = JSON.parse(readFileSync(join(REPO, 'package.json'), 'utf8')) as Record<string, unknown>
  }, 240_000)

  it('packs every publishable package', () => {
    for (const name of PACKAGE_NAMES) {
      expect(packed.tarballs[name], `tarball for ${name}`).toBeTruthy()
    }
  })

  it('plugin tarball ships lib, all four skills, patch and README', () => {
    const files = tarList(packed.tarballs['research-plugin']!)
    expect(files).toContain('package/lib/index.js')
    expect(files).toContain('package/lib/client.js')
    expect(files).toContain('package/cordis.patch.yml')
    expect(files).toContain('package/README.md')
    for (const s of SKILLS) expect(files).toContain(`package/skills/${s}/SKILL.md`)
  })

  it('every package tarball ships its compiled lib entry', () => {
    for (const name of PACKAGE_NAMES.filter(n => n !== 'research-plugin')) {
      const files = tarList(packed.tarballs[name]!)
      expect(files.some(f => f.startsWith('package/lib/') && f.endsWith('.js')), `${name} has lib`).toBe(true)
      expect(files).toContain('package/package.json')
    }
  })

  it('packed runtime manifests are registry-installable without checkout-relative dependencies', () => {
    for (const name of PACKAGE_NAMES) {
      const manifest = tarJson(packed.tarballs[name]!, 'package/package.json')
      const dependencies = manifest['dependencies'] as Record<string, string> | undefined
      for (const [dependency, specifier] of Object.entries(dependencies ?? {})) {
        expect(
          /^(?:file|link|workspace):/.test(specifier),
          `${name} dependency ${dependency} must be a registry version in the packed manifest (received ${specifier})`,
        ).toBe(false)
      }
    }
  })

  it('plugin manifest declares its DSH host peers and a prepare build step', () => {
    const peers = rootManifest['peerDependencies'] as Record<string, string>
    for (const host of HOST_PEERS) {
      expect(peers?.[host], `peer ${host}`).toBeTruthy()
    }
    const optional = rootManifest['peerDependenciesMeta'] as Record<string, unknown>
    for (const host of OPTIONAL_HOST_PEERS) {
      expect(optional?.[host], `optional peer ${host}`).toMatchObject({ optional: true })
    }
    const files = rootManifest['files'] as string[]
    for (const entry of ['lib', 'skills', 'cordis.patch.yml', 'README.md']) expect(files).toContain(entry)
    expect(rootManifest['exports']).toMatchObject({ './client': { default: './lib/client.js' } })
    expect(rootManifest['dsh']).toMatchObject({
      client: {
        platform: 'web',
        inject: expect.arrayContaining([
          '@deepseek-ai/dsh-client-runtime',
          '@deepseek-ai/dsh-client-ui-settings-plugins',
          '@deepseek-ai/dsh-client-ui-settings',
        ]),
      },
    })
    expect(peers?.['@deepseek-ai/dsh-settings']).toBeTruthy()
    expect((rootManifest['scripts'] as Record<string, string>)['prepare']).toContain('build')
  })

  it('clean consumer install resolves every @dsh-scholar tarball and lands skills on disk', () => {
    const { consumer } = makeConsumer(packed)
    // Locate the installed plugin package dir.
    const pluginPkg = join(consumer, 'node_modules', '@dsh-scholar', 'research-plugin')
    expect(existsSync(join(pluginPkg, 'package.json'))).toBe(true)
    for (const s of SKILLS) {
      const skill = join(pluginPkg, 'skills', s, 'SKILL.md')
      expect(existsSync(skill), `installed skill ${s}`).toBe(true)
      const head = readFileSync(skill, 'utf8').slice(0, 400)
      expect(head).toContain(`name: ${s}`)
      expect(head).toContain('description:')
    }
    // The packed manifest inside node_modules declares the host peers too.
    const installed = JSON.parse(readFileSync(join(pluginPkg, 'package.json'), 'utf8')) as Record<string, unknown>
    const peers = installed['peerDependencies'] as Record<string, string>
    expect(peers?.['@deepseek-ai/dsh-skill-filesystem']).toBeTruthy()
  }, 240_000)

  it('PACK-01: installed @dsh-scholar packages are real extracted files, not links into the original checkout', () => {
    const { consumer } = makeConsumer(packed)
    for (const name of RUNTIME_NAMES) {
      const copies = findInstalled(consumer, name)
      expect(copies.length, `installed ${name} (top-level or virtual store)`).toBeGreaterThan(0)
      for (const installed of copies) {
        // Resolve through pnpm's isolated-linker symlinks: the content must
        // live in the consumer's own tree, never back in the repo/workspace
        // or the sibling DSH harness checkout.
        const real = realpathSync(installed)
        expect(real.startsWith(REPO), `${name} resolved into the original repo checkout (${real})`).toBe(false)
        expect(real.startsWith(HARNESS), `${name} resolved into the DSH harness checkout (${real})`).toBe(false)
        // And the shipped files must be real files, not symlinks.
        const pkgJson = join(real, 'package.json')
        expect(lstatSync(pkgJson).isFile(), `${name} package.json is a real file`).toBe(true)
        const manifest = JSON.parse(readFileSync(pkgJson, 'utf8')) as Record<string, unknown>
        const main = manifest['main']
        if (typeof main === 'string') {
          expect(lstatSync(join(real, main)).isFile(), `${name} main entry ${main} is a real file`).toBe(true)
        }
      }
    }
  }, 240_000)

  it('PACK-01: consumer lockfile and modules carry no original-checkout paths', () => {
    const { consumer } = makeConsumer(packed)
    const targets: string[] = []
    targets.push(join(consumer, 'pnpm-lock.yaml'))
    for (const rel of ['node_modules/.pnpm/lock.yaml', 'node_modules/.modules.yaml']) {
      const f = join(consumer, rel)
      if (existsSync(f)) targets.push(f)
    }
    // Every file pnpm materialized (top-level links, virtual store copies).
    const nm = join(consumer, 'node_modules')
    if (existsSync(nm)) targets.push(...listFiles(nm))
    expect(targets.length).toBeGreaterThan(0)
    for (const f of targets) {
      const text = readFileSync(f, 'utf8')
      expect(text.includes(REPO), `${f} references the original repo path`).toBe(false)
      expect(text.includes(HARNESS), `${f} references the DSH harness checkout`).toBe(false)
    }
  }, 240_000)

  it('PACK-01: optional DSH host peers are never force-installed without a registry', () => {
    const { consumer, log } = makeConsumer(packed)
    // No pnpm error and no failed registry fetch in the install log: with
    // autoInstallPeers off the @deepseek-ai/* hosts must not be resolved at
    // all, so an install in a registry-less environment cannot fail on them.
    expect(log.includes('ERR_PNPM'), 'install log contains no ERR_PNPM').toBe(false)
    expect(log).not.toMatch(/ENOTFOUND|ECONNREFUSED|ECONNRESET|ETIMEDOUT|ETARGET|EPROTO|fetch failed|network error/i)
    expect(existsSync(join(consumer, 'node_modules', '@deepseek-ai')), 'no @deepseek-ai dir materialized').toBe(false)
    const lock = readFileSync(join(consumer, 'pnpm-lock.yaml'), 'utf8')
    // The lockfile may only *declare* the host peers inside the plugin's
    // snapshot (peerDependencies / peerDependenciesMeta); it must never
    // contain a resolved package entry for them.
    const resolvedHosts = lock.split('\n').filter(line => /^  '@deepseek-ai\//.test(line))
    expect(resolvedHosts, 'lockfile never resolves host peers').toEqual([])
    if (existsSync(join(consumer, 'node_modules', '.pnpm'))) {
      const storeEntries = readdirSync(join(consumer, 'node_modules', '.pnpm'))
      expect(storeEntries.some(e => e.includes('@deepseek-ai+')), 'virtual store holds no host-peer copies').toBe(false)
    }
    // The installed manifest still declares them as optional host peers.
    const installed = JSON.parse(readFileSync(join(consumer, 'node_modules', '@dsh-scholar', 'research-plugin', 'package.json'), 'utf8')) as Record<string, unknown>
    const peers = installed['peerDependencies'] as Record<string, string>
    const meta = installed['peerDependenciesMeta'] as Record<string, unknown>
    for (const host of OPTIONAL_HOST_PEERS) {
      expect(peers?.[host], `installed peer ${host}`).toBeTruthy()
      expect(meta?.[host], `installed optional peer ${host}`).toMatchObject({ optional: true })
    }
  }, 240_000)

  it('skills carry valid frontmatter (SKILL-01 discovery)', () => {
    for (const s of SKILLS) {
      const raw = readFileSync(join(REPO, 'skills', s, 'SKILL.md'), 'utf8')
      expect(raw.startsWith('---\n'), `${s} frontmatter opens`).toBe(true)
      const close = raw.indexOf('\n---\n', 4)
      expect(close, `${s} frontmatter closes`).toBeGreaterThan(0)
      const fm = raw.slice(4, close)
      expect(fm).toMatch(new RegExp(`^name:\\s*${s.replaceAll('-', '-')}\\s*$`, 'm'))
      expect(fm).toMatch(/^description:\s*\S.+$/m)
      expect(raw.slice(close + 5).trim().length).toBeGreaterThan(50)
    }
  })
})

describe('standalone unlock page i18n (UI-03)', () => {
  it('serves a bilingual unlock page whose data-i18n keys exist in the zh/en dictionaries', async () => {
    // Serve the SHIPPED artifact (lib/standalone/server.js), rebuilding it
    // (and the kernel sidecar it spawns) when the source is newer or the
    // build output is absent — mirrors the CI build step.
    const uiPkg = join(REPO, 'packages', 'dsh-research-ui')
    const uiSrc = join(uiPkg, 'src', 'standalone', 'server.ts')
    const uiLib = join(uiPkg, 'lib', 'standalone', 'server.js')
    const kernelBin = join(REPO, 'packages', 'research-kernel', 'lib', 'bin', 'kernel.js')
    if (!existsSync(uiLib) || statSync(uiLib).mtimeMs < statSync(uiSrc).mtimeMs) {
      runPnpm(['--filter', '@dsh-scholar/research-ui', 'build'], REPO)
    }
    if (!existsSync(kernelBin)) {
      runPnpm(['--filter', '@dsh-scholar/research-kernel', 'build'], REPO)
    }
    const webPort = await freePort()
    const kernelPort = await freePort()
    const dataDir = mkdtempSync(join(tmpdir(), 'dsh-ui3-'))
    const kernelDataDir = join(dataDir, 'kernel')
    const child = spawn(process.execPath, [
      uiLib, '--no-token', '--host', '127.0.0.1', '--port', String(webPort),
      '--kernel-port', String(kernelPort), '--kernel-data-dir', kernelDataDir,
      '--data-dir', join(dataDir, 'bff'),
    ], { stdio: ['ignore', 'pipe', 'pipe'] })
    let serverErr = ''
    child.stderr?.on('data', (d: Buffer) => { serverErr += String(d) })
    try {
      const { html, headers } = await fetchHomepage(webPort, child, () => serverErr)

      // The HTML response owns the preview security policy. It must allow
      // only the Blob-backed passive renderers and exact loopback embedders,
      // and every inline bootstrap block must carry the response nonce.
      const csp = headers.get('content-security-policy') ?? ''
      expect(headers.get('x-content-type-options')).toBe('nosniff')
      expect(csp).toContain("object-src 'none'")
      expect(csp).toContain("frame-src 'self' blob:")
      expect(csp).toContain("media-src 'self' blob:")
      expect(csp).toContain("frame-ancestors 'self' http://127.0.0.1:3080 http://localhost:3080 http://[::1]:3080")
      expect(csp).not.toContain(':*')
      const nonce = /script-src 'self' 'nonce-([^']+)'/.exec(csp)?.[1]
      expect(nonce).toBeTruthy()
      expect(html.match(new RegExp(`<script nonce="${nonce}"`, 'g'))?.length).toBeGreaterThan(0)
      expect(html).toContain(`<style nonce="${nonce}">`)

      // Token-gate copy is keyed through data-i18n attributes.
      for (const key of ['standalone.pageTitle', 'standalone.brand.name', 'standalone.brand.meta', 'standalone.operatorAccess', 'standalone.welcomeBack', 'standalone.intro', 'standalone.accessToken', 'standalone.openWorkspace', 'standalone.tokenHint']) {
        expect(html.includes(`data-i18n="${key}"`), `unlock page carries data-i18n ${key}`).toBe(true)
      }
      // Error/toggle strings are resolved through the inline dictionary.
      for (const key of ['standalone.invalidToken', 'standalone.serverUnreachable', 'standalone.bundleFailed', 'standalone.theme.dark', 'standalone.theme.light']) {
        expect(html.includes(`'${key}'`), `unlock script resolves ${key} via the dictionary`).toBe(true)
      }
      expect(html).toContain('parseStandaloneUnlockError')
      expect(html).not.toContain('dsh-scholar/frame-ready')
      expect(html).toContain('<form id="token-form"')
      expect(html).not.toContain('(j.error ||')
      // html lang follows the same persisted-locale logic as the client
      // adapter (acceptance §8: persisted dsh.locale → navigator.languages → zh).
      expect(html.includes(`document.documentElement.lang = window.__BOOT_LOCALE__`), 'lang switches with the boot locale').toBe(true)
      expect(html.includes(`'dsh.locale'`), 'persisted locale key is read').toBe(true)
      expect(html.includes('navigator.languages'), 'browser locales are consulted').toBe(true)
      // Product branding is one canonical wordmark in both the fallback
      // markup and locale dictionaries; technical Research Kernel naming is
      // outside this unlock-page assertion.
      expect(html).toContain('>Scholar</span>')
      expect(html).toContain("'standalone.pageTitle': 'dsh Scholar'")
      expect(html).not.toContain('>Research</span>')
      expect(html).not.toContain('Research OS')
      // The legacy flat keys must not come back.
      for (const legacy of ['data-i18n="err.invalid"', 'data-i18n="label.token"', 'data-i18n="submit.open"', 'data-i18n="placeholder.token"', 'data-i18n="hint"']) {
        expect(html.includes(legacy), `legacy key ${legacy} removed`).toBe(false)
      }
      // Every standalone.* key the page uses must exist in BOTH dictionaries,
      // and the dictionaries must be exactly key-parallel.
      const used = new Set<string>()
      for (const m of html.matchAll(/['"]standalone\.[A-Za-z.]+['"]/g)) used.add(m[0].slice(1, -1))
      expect(used.size).toBeGreaterThan(0)
      for (const key of used) {
        expect(standaloneZh[key as keyof typeof standaloneZh], `zh dict has ${key}`).toBeTruthy()
        expect(standaloneEn[key as keyof typeof standaloneEn], `en dict has ${key}`).toBeTruthy()
      }
      expect(Object.keys(standaloneZh).sort()).toEqual(Object.keys(standaloneEn).sort())
    } finally {
      child.kill('SIGTERM')
      await new Promise<void>(resolve => {
        const killTimer = setTimeout(() => { child.kill('SIGKILL'); resolve() }, 3000)
        child.once('exit', () => { clearTimeout(killTimer); resolve() })
      })
      rmSync(dataDir, { recursive: true, force: true })
    }
  }, 240_000)
})
