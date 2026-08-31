/**
 * SIDE-01 acceptance (docs/acceptance-tests.md §9) — kernel sidecar identity
 * and port-0 endpoint resolution, exercised against the REAL kernel binary
 * (packages/research-kernel/lib/bin/kernel.js; run the kernel build first).
 *
 * Covered here:
 * - port=0: sidecar uses only the actual port published by 0600
 *   runtime/endpoint.json; health works; the endpoint getter resolves.
 * - reuse on the same dataDir (same instance and across instances) is
 *   identity-verified and never spawns a second kernel.
 * - a kernel on the same port with a different dataDir/database identity is
 *   refused (sidecar_identity_mismatch) and never terminated.
 * - a kernel without runtime/endpoint.json (legacy) is refused
 *   (sidecar_identity_unknown) and never terminated.
 * - stop() removes only the endpoint.json owned by this instance's kernel.
 * - UiKernelSidecar (standalone) implements the same semantics.
 *
 * Tests run serially (vitest default within a file); every spawned kernel is
 * tracked and force-terminated in afterEach, so no orphans survive failures.
 */
import { describe, expect, it, afterEach } from 'vitest'
import { spawn, type ChildProcess } from 'node:child_process'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { KernelSidecar, SidecarIdentityError } from '../../src/plugin/sidecar.js'
import { UiKernelSidecar } from '../../packages/dsh-research-ui/src/standalone/sidecar.js'
import { dshOperatorPrincipal } from '@dsh-scholar/research-kernel'

const KERNEL_BIN = fileURLToPath(new URL('../../packages/research-kernel/lib/bin/kernel.js', import.meta.url))

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer()
    probe.on('error', reject)
    probe.listen(0, '127.0.0.1', () => {
      const port = (probe.address() as AddressInfo).port
      probe.close(() => resolve(port))
    })
  })
}

async function waitForHealth(url: string, process: ChildProcess, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (process.exitCode !== null || process.signalCode !== null) {
      const termination = process.signalCode === null ? `exit ${process.exitCode}` : `signal ${process.signalCode}`
      throw new Error(`kernel process exited before becoming healthy: ${url} (${termination})`)
    }
    try {
      const response = await fetch(`${url}/v1/health`)
      if (response.ok) return
    } catch {
      // not up yet
    }
    await sleep(200)
  }
  throw new Error(`kernel process did not become healthy in time: ${url}`)
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function terminate(pid: number): Promise<void> {
  if (!alive(pid)) return
  try { process.kill(pid, 'SIGTERM') } catch { return }
  const deadline = Date.now() + 3000
  while (Date.now() < deadline && alive(pid)) await sleep(100)
  if (alive(pid)) {
    try { process.kill(pid, 'SIGKILL') } catch { /* already gone */ }
    await sleep(100)
  }
}

async function waitForGone(pid: number, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline && alive(pid)) await sleep(50)
}

function readEndpoint(dataDir: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(dataDir, 'runtime', 'endpoint.json'), 'utf8')) as Record<string, unknown>
}

/** Every kernel pid spawned by the tests (sidecar or manual), swept in afterEach. */
const allPids: number[] = []
const tempDirs: string[] = []

afterEach(async () => {
  for (const pid of allPids.splice(0)) await terminate(pid)
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('KernelSidecar (research-plugin) — SIDE-01', () => {
  it.each(['--token', '--service-token'])('rejects secret Kernel CLI flag %s without echoing its value', async flag => {
    const secret = 'argv-secret-canary-do-not-log'
    const child = spawn(process.execPath, [KERNEL_BIN, flag, secret], { stdio: ['ignore', 'pipe', 'pipe'] })
    let output = ''
    child.stdout?.on('data', chunk => { output += String(chunk) })
    child.stderr?.on('data', chunk => { output += String(chunk) })
    const exitCode = await new Promise<number | null>(resolve => child.once('exit', code => resolve(code)))
    expect(exitCode).not.toBe(0)
    expect(output).toContain(`unknown CLI flag '${flag}'`)
    expect(output).not.toContain(secret)
  })

  it('fails the health wait immediately when the child was terminated by a signal', async () => {
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })
    const exited = new Promise<void>(resolve => child.once('exit', () => resolve()))
    child.kill('SIGTERM')
    await exited

    const startedAt = Date.now()
    await expect(waitForHealth('http://127.0.0.1:1', child)).rejects.toThrow(/signal SIGTERM/)
    expect(Date.now() - startedAt).toBeLessThan(1_000)
  })

  it('does not scan or mutate retired data directories during ordinary startup', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'sidecar-canonical-only-'))
    const retiredDir = mkdtempSync(join(tmpdir(), 'sidecar-retired-source-'))
    tempDirs.push(dataDir, retiredDir)
    // This deliberately is not a valid database. The retired automatic
    // discovery path would try to adopt it and fail before boot; current
    // startup must ignore it entirely.
    writeFileSync(join(retiredDir, 'kernel.db'), 'retired data is not a runtime source')
    const previous = process.env.DSH_SCHOLAR_LEGACY_KERNEL_DIRS
    process.env.DSH_SCHOLAR_LEGACY_KERNEL_DIRS = retiredDir
    const sidecar = new KernelSidecar({ host: '127.0.0.1', port: 0, dataDir })
    try {
      await sidecar.start()
      const endpoint = readEndpoint(dataDir)
      allPids.push(endpoint.pid as number)
      expect((await fetch(`${sidecar.endpoint}/v1/health`)).ok).toBe(true)
      expect(readFileSync(join(retiredDir, 'kernel.db'), 'utf8')).toBe('retired data is not a runtime source')
    } finally {
      await sidecar.stop()
      if (previous === undefined) delete process.env.DSH_SCHOLAR_LEGACY_KERNEL_DIRS
      else process.env.DSH_SCHOLAR_LEGACY_KERNEL_DIRS = previous
    }
  })

  it('port=0 resolves the actual port from runtime/endpoint.json (0600), health works, second start reuses with identity verified', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'sidecar-port0-'))
    tempDirs.push(dataDir)
    const lines: string[] = []
    const sidecar = new KernelSidecar({ host: '127.0.0.1', port: 0, dataDir, log: line => lines.push(line) })
    try {
      await sidecar.start()
      // endpoint must resolve to a real port identical to endpoint.json
      const url = new URL(sidecar.endpoint)
      expect(Number(url.port)).toBeGreaterThan(0)
      const ep = readEndpoint(dataDir)
      expect(ep.port).toBe(Number(url.port))
      expect(ep.protocol).toBe('http')
      expect(ep.schema).toBe('v1')
      expect(ep.database).toBe('kernel.db')
      expect(ep.dataDir).toBe(dataDir)
      expect(typeof ep.pid).toBe('number')
      expect(statSync(join(dataDir, 'runtime', 'endpoint.json')).mode & 0o777).toBe(0o600)
      allPids.push(ep.pid as number)
      // health must be reachable on the resolved port
      expect((await fetch(`${sidecar.endpoint}/v1/health`)).ok).toBe(true)
      // second start without stop: reuse (in-memory child + file identity)
      const endpointBefore = sidecar.endpoint
      await sidecar.start()
      expect(sidecar.endpoint).toBe(endpointBefore)
      expect(lines.some(l => l.includes('identity verified'))).toBe(true)
      expect(readEndpoint(dataDir).port).toBe(Number(url.port))
    } finally {
      await sidecar.stop()
    }
  })

  it('respawns a fresh kernel after its own child is killed (port=0 re-resolves from the new endpoint.json)', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'sidecar-respawn-'))
    tempDirs.push(dataDir)
    const sidecar = new KernelSidecar({ host: '127.0.0.1', port: 0, dataDir, log: () => undefined })
    try {
      await sidecar.start()
      const firstPort = Number(new URL(sidecar.endpoint).port)
      const oldPid = readEndpoint(dataDir).pid as number
      allPids.push(oldPid)
      // kill the kernel out from under the sidecar (simulates a crash)
      process.kill(oldPid, 'SIGKILL')
      await waitForGone(oldPid)
      // start() again must spawn a fresh kernel and re-resolve the port
      await sidecar.start()
      const secondPort = Number(new URL(sidecar.endpoint).port)
      const ep = readEndpoint(dataDir)
      expect(ep.port).toBe(secondPort)
      expect(secondPort).toBeGreaterThan(0)
      expect(ep.pid).not.toBe(oldPid)
      expect((await fetch(`${sidecar.endpoint}/v1/health`)).ok).toBe(true)
      void firstPort
    } finally {
      await sidecar.stop()
    }
  })

  it('reuses a running kernel across sidecar instances on the same dataDir (identity verified, no new spawn)', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'sidecar-reuse-'))
    tempDirs.push(dataDir)
    const port = await freePort()
    const lines: string[] = []
    const sidecarA = new KernelSidecar({ host: '127.0.0.1', port, dataDir, log: line => lines.push(line) })
    await sidecarA.start()
    const pid = readEndpoint(dataDir).pid as number
    allPids.push(pid)
    try {
      const sidecarB = new KernelSidecar({ host: '127.0.0.1', port, dataDir, log: line => lines.push(line) })
      await sidecarB.start()
      expect(lines.some(l => l.includes('identity verified'))).toBe(true)
      // still the same kernel process, still on the same port
      expect(readEndpoint(dataDir).pid).toBe(pid)
      expect(alive(pid)).toBe(true)
      // B owns no child: stopping B must not kill or mislabel the kernel
      await sidecarB.stop()
      expect(alive(pid)).toBe(true)
      expect((await fetch(`http://127.0.0.1:${port}/v1/health`)).ok).toBe(true)
    } finally {
      await sidecarA.stop()
    }
    expect(alive(pid)).toBe(false)
  })

  it('refuses reuse when a kernel with a different dataDir identity holds the port and never terminates it', async () => {
    const dataDirA = mkdtempSync(join(tmpdir(), 'sidecar-mismatch-a-'))
    const dataDirB = mkdtempSync(join(tmpdir(), 'sidecar-mismatch-b-'))
    tempDirs.push(dataDirA, dataDirB)
    const port = await freePort()
    const sidecarA = new KernelSidecar({ host: '127.0.0.1', port, dataDir: dataDirA, log: () => undefined })
    await sidecarA.start()
    const pid = readEndpoint(dataDirA).pid as number
    allPids.push(pid)
    try {
      // SIDE-01 mismatch branch: B's runtime dir already contains an identity
      // record declaring the A kernel (dataDir=A, database=kernel.db) — i.e.
      // the file is present but its dataDir disagrees with B's own dataDir.
      mkdirSync(join(dataDirB, 'runtime'), { recursive: true })
      writeFileSync(join(dataDirB, 'runtime', 'endpoint.json'), readFileSync(join(dataDirA, 'runtime', 'endpoint.json')))
      const sidecarB = new KernelSidecar({ host: '127.0.0.1', port, dataDir: dataDirB, log: () => undefined })
      let error: unknown
      try {
        await sidecarB.start()
      } catch (caught) {
        error = caught
      }
      expect(error).toBeInstanceOf(SidecarIdentityError)
      const message = (error as Error).message
      expect(message).toMatch(/sidecar_identity_mismatch/)
      expect(message).toMatch(/dataDir/)
      // the foreign kernel must still be alive and healthy
      expect(alive(pid)).toBe(true)
      expect((await fetch(`http://127.0.0.1:${port}/v1/health`)).ok).toBe(true)
      // B must not have removed A's endpoint.json
      expect(readEndpoint(dataDirA).pid).toBe(pid)
    } finally {
      await sidecarA.stop()
    }
  })

  it('refuses to reuse a legacy kernel without runtime/endpoint.json (sidecar_identity_unknown) without killing it', { timeout: 45_000 }, async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'sidecar-legacy-'))
    tempDirs.push(dataDir)
    const port = await freePort()
    // legacy kernel: no --endpoint-file / env var → never publishes endpoint.json
    const kernel: ChildProcess = spawn(process.execPath, [
      KERNEL_BIN, '--db', join(dataDir, 'kernel.db'), '--cas', join(dataDir, 'cas'),
      '--host', '127.0.0.1', '--port', String(port),
    ], { stdio: ['ignore', 'ignore', 'pipe'] })
    const kernelPid = kernel.pid ?? -1
    allPids.push(kernelPid)
    await waitForHealth(`http://127.0.0.1:${port}`, kernel)
    expect(existsSync(join(dataDir, 'runtime', 'endpoint.json'))).toBe(false)
    const sidecar = new KernelSidecar({ host: '127.0.0.1', port, dataDir, log: () => undefined })
    await expect(sidecar.start()).rejects.toThrow(/sidecar_identity_unknown/)
    // the legacy kernel is untouched
    expect(alive(kernelPid)).toBe(true)
    expect((await fetch(`http://127.0.0.1:${port}/v1/health`)).ok).toBe(true)
  })

  it('stop() removes only the endpoint.json owned by its own kernel pid', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'sidecar-stop-'))
    tempDirs.push(dataDir)
    const port = await freePort()
    const sidecar = new KernelSidecar({ host: '127.0.0.1', port, dataDir, log: () => undefined })
    await sidecar.start()
    const file = join(dataDir, 'runtime', 'endpoint.json')
    const pid = readEndpoint(dataDir).pid as number
    allPids.push(pid)
    expect(existsSync(file)).toBe(true)
    await sidecar.stop()
    expect(existsSync(file)).toBe(false)

    // a file whose pid belongs to someone else must be left alone
    const foreignDir = mkdtempSync(join(tmpdir(), 'sidecar-stop-foreign-'))
    tempDirs.push(foreignDir)
    const port2 = await freePort()
    const sidecar2 = new KernelSidecar({ host: '127.0.0.1', port: port2, dataDir: foreignDir, log: () => undefined })
    await sidecar2.start()
    const foreignFile = join(foreignDir, 'runtime', 'endpoint.json')
    allPids.push(readEndpoint(foreignDir).pid as number)
    const record = JSON.parse(readFileSync(foreignFile, 'utf8')) as Record<string, unknown>
    writeFileSync(foreignFile, JSON.stringify({ ...record, pid: 99999999 }))
    await sidecar2.stop()
    expect(existsSync(foreignFile)).toBe(true)
  })
})

describe('UiKernelSidecar (research-ui standalone) — SIDE-01 parity', () => {
  it('port=0 + identity-verified reuse behave like the plugin sidecar', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'sidecar-ui-'))
    tempDirs.push(dataDir)
    const lines: string[] = []
    const sidecar = new UiKernelSidecar({ host: '127.0.0.1', port: 0, dataDir, log: line => lines.push(line) })
    try {
      await sidecar.start()
      const url = new URL(sidecar.endpoint)
      expect(Number(url.port)).toBeGreaterThan(0)
      const ep = readEndpoint(dataDir)
      expect(ep.port).toBe(Number(url.port))
      expect(ep.protocol).toBe('http')
      expect(ep.schema).toBe('v1')
      expect(ep.database).toBe('kernel.db')
      expect(ep.dataDir).toBe(dataDir)
      allPids.push(ep.pid as number)
      expect((await fetch(`${sidecar.endpoint}/v1/health`)).ok).toBe(true)
      await sidecar.start()
      expect(sidecar.endpoint).toBe(url.origin)
      expect(lines.some(l => l.includes('identity verified'))).toBe(true)
    } finally {
      await sidecar.stop()
    }
  })

  it('refuses a foreign-dataDir kernel on the same port', async () => {
    const dataDirA = mkdtempSync(join(tmpdir(), 'sidecar-ui-mismatch-a-'))
    const dataDirB = mkdtempSync(join(tmpdir(), 'sidecar-ui-mismatch-b-'))
    tempDirs.push(dataDirA, dataDirB)
    const port = await freePort()
    const sidecarA = new UiKernelSidecar({ host: '127.0.0.1', port, dataDir: dataDirA, log: () => undefined })
    await sidecarA.start()
    const pid = readEndpoint(dataDirA).pid as number
    allPids.push(pid)
    try {
      // same fixture as the plugin-side mismatch test: B's runtime dir holds
      // the identity record of the A kernel (dataDir=A), conflicting with B.
      mkdirSync(join(dataDirB, 'runtime'), { recursive: true })
      writeFileSync(join(dataDirB, 'runtime', 'endpoint.json'), readFileSync(join(dataDirA, 'runtime', 'endpoint.json')))
      const sidecarB = new UiKernelSidecar({ host: '127.0.0.1', port, dataDir: dataDirB, log: () => undefined })
      await expect(sidecarB.start()).rejects.toThrow(/sidecar_identity_mismatch/)
      expect(alive(pid)).toBe(true)
      expect((await fetch(`http://127.0.0.1:${port}/v1/health`)).ok).toBe(true)
    } finally {
      await sidecarA.stop()
    }
  })
})

describe('§5 P0-1 kernel bearer token (hardening API-01/SIDE-01) — 0600 kernel-token file + enforced Bearer on the spawned kernel', () => {
  const tokenFile = (dataDir: string) => join(dataDir, 'kernel-token')
  const hex32 = /^[0-9a-f]{32}$/

  async function request(port: number, path: string, method = 'GET', headers: Record<string, string> = {}, body?: unknown): Promise<{ status: number; code: string }> {
    const res = await fetch(`http://127.0.0.1:${port}${path}`, {
      method,
      headers: { 'content-type': 'application/json', ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    const envelope = await res.json().catch(() => ({})) as { error?: { code?: string } }
    return { status: res.status, code: envelope.error?.code ?? '' }
  }

  it('all sidecar token files share the same fail-closed regular-file contract', () => {
    const cases: Array<{ file: string; read: (sidecar: KernelSidecar) => string }> = [
      { file: 'kernel-token', read: sidecar => sidecar.kernelToken },
      { file: 'service-token', read: sidecar => sidecar.serviceToken },
      { file: 'dsh-plugin-token', read: sidecar => sidecar.dshPluginToken },
      { file: 'orchestrator-token', read: sidecar => sidecar.orchestratorToken },
    ]
    for (const [index, testCase] of cases.entries()) {
      const symlinkDir = mkdtempSync(join(tmpdir(), `sidecar-token-symlink-${index}-`))
      tempDirs.push(symlinkDir)
      writeFileSync(join(symlinkDir, 'target'), 'must-not-be-read', { mode: 0o600 })
      symlinkSync(join(symlinkDir, 'target'), join(symlinkDir, testCase.file))
      const symlinkSidecar = new KernelSidecar({ dataDir: symlinkDir })
      expect(() => testCase.read(symlinkSidecar)).toThrow(/must be a regular file/)

      const emptyDir = mkdtempSync(join(tmpdir(), `sidecar-token-empty-${index}-`))
      tempDirs.push(emptyDir)
      writeFileSync(join(emptyDir, testCase.file), '', { mode: 0o600 })
      const emptySidecar = new KernelSidecar({ dataDir: emptyDir })
      expect(() => testCase.read(emptySidecar)).toThrow(/must not be empty/)
    }
  })

  it('KernelSidecar: creates a 0600 kernel-token file (random 32 hex), reuses it, injects it into the kernel, and the kernel enforces the bearer', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'sidecar-kt-'))
    tempDirs.push(dataDir)
    const port = await freePort()
    const logs: string[] = []
    const sidecar = new KernelSidecar({ host: '127.0.0.1', port, dataDir, log: line => logs.push(line) })
    await sidecar.start()
    const pid = readEndpoint(dataDir).pid as number
    allPids.push(pid)
    try {
      // token file: regular file, 0600, 32 hex, non-empty, not a symlink.
      const file = tokenFile(dataDir)
      const token = readFileSync(file, 'utf8').trim()
      expect(token).toMatch(hex32)
      expect(statSync(file).mode & 0o777).toBe(0o600)
      expect(lstatSync(file).isSymbolicLink()).toBe(false)
      // the sidecar's getter agrees with the file.
      expect(sidecar.kernelToken).toBe(token)
      const dshPluginFile = join(dataDir, 'dsh-plugin-token')
      const dshPluginToken = readFileSync(dshPluginFile, 'utf8').trim()
      expect(dshPluginToken).toMatch(hex32)
      expect(statSync(dshPluginFile).mode & 0o777).toBe(0o600)
      expect(lstatSync(dshPluginFile).isSymbolicLink()).toBe(false)
      expect(sidecar.dshPluginToken).toBe(dshPluginToken)
      expect(dshPluginToken).not.toBe(readFileSync(join(dataDir, 'service-token'), 'utf8').trim())
      const orchestratorFile = join(dataDir, 'orchestrator-token')
      const orchestratorToken = readFileSync(orchestratorFile, 'utf8').trim()
      expect(orchestratorToken).toMatch(hex32)
      expect(statSync(orchestratorFile).mode & 0o777).toBe(0o600)
      expect(lstatSync(orchestratorFile).isSymbolicLink()).toBe(false)
      expect(sidecar.orchestratorToken).toBe(orchestratorToken)
      expect(orchestratorToken).not.toBe(token)
      expect(orchestratorToken).not.toBe(sidecar.serviceToken)
      expect(orchestratorToken).not.toBe(dshPluginToken)
      expect(readFileSync(`/proc/${pid}/cmdline`, 'utf8')).not.toContain(orchestratorToken)
      expect(logs.join('\n')).not.toContain(orchestratorToken)
      expect(JSON.stringify(readEndpoint(dataDir))).not.toContain(orchestratorToken)
      // direct read without the bearer -> 401 (the local-process hole is closed).
      const noAuth = await request(port, '/v1/projects')
      expect(noAuth.status).toBe(401)
      expect(noAuth.code).toBe('unauthorized')
      // wrong bearer -> 401.
      expect((await request(port, '/v1/projects', 'GET', { authorization: 'Bearer wrong' })).status).toBe(401)
      // write without the bearer -> 401.
      const write = await request(port, '/v1/projects', 'POST', {}, { name: 'x', workspace: '/w' })
      expect(write.status).toBe(401)
      // the file token authenticates (read + write).
      expect((await request(port, '/v1/projects', 'GET', { authorization: `Bearer ${token}` })).status).toBe(200)
      // Direct DSH create/link needs all three credentials; the spawned
      // kernel received the route-specific token only through env.
      expect((await request(port, '/internal/dsh-sessions/sidecar_session/projects', 'POST', {
        authorization: `Bearer ${token}`,
        'x-service-token': sidecar.serviceToken,
        'x-service-principal': 'dsh-plugin',
        'idempotency-key': 'sidecar-create-no-plugin',
      }, { name: 'Denied' })).status).toBe(403)
      expect((await request(port, '/internal/dsh-sessions/sidecar_session/projects', 'POST', {
        authorization: `Bearer ${token}`,
        'x-service-token': sidecar.serviceToken,
        'x-dsh-plugin-token': dshPluginToken,
        'x-service-principal': 'dsh-plugin',
        'idempotency-key': 'sidecar-create-ok',
      }, { name: 'Sidecar Direct Create' })).status).toBe(201)
      // health stays exempt (sidecar handshake without a token still works).
      expect((await request(port, '/v1/health')).status).toBe(200)
    } finally {
      await sidecar.stop()
    }
  })

  it('KernelSidecar: the token is reused across instances on the same dataDir and survives stop(); an explicit token option seeds the file', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'sidecar-kt-reuse-'))
    tempDirs.push(dataDir)
    const port = await freePort()
    const sidecarA = new KernelSidecar({ host: '127.0.0.1', port, dataDir, log: () => undefined })
    await sidecarA.start()
    const pid = readEndpoint(dataDir).pid as number
    allPids.push(pid)
    const token = readFileSync(tokenFile(dataDir), 'utf8').trim()
    const orchestratorToken = readFileSync(join(dataDir, 'orchestrator-token'), 'utf8').trim()
    await sidecarA.stop()
    // stop() removes the endpoint.json but NOT the kernel-token file.
    expect(existsSync(tokenFile(dataDir))).toBe(true)
    expect(existsSync(join(dataDir, 'runtime', 'endpoint.json'))).toBe(false)
    // a fresh sidecar on the same dataDir reuses the same token.
    const sidecarB = new KernelSidecar({ host: '127.0.0.1', port, dataDir, log: () => undefined })
    await sidecarB.start()
    allPids.push(readEndpoint(dataDir).pid as number)
    try {
      expect(sidecarB.kernelToken).toBe(token)
      expect(sidecarB.orchestratorToken).toBe(orchestratorToken)
      // the respawned kernel demands the SAME token.
      expect((await request(port, '/v1/projects', 'GET', { authorization: `Bearer ${token}` })).status).toBe(200)
      expect((await request(port, '/v1/projects')).status).toBe(401)
    } finally {
      await sidecarB.stop()
    }
    // an explicit token option seeds a fresh dataDir's kernel-token file.
    const seedDir = mkdtempSync(join(tmpdir(), 'sidecar-kt-seed-'))
    tempDirs.push(seedDir)
    const seedPort = await freePort()
    const seeded = new KernelSidecar({ host: '127.0.0.1', port: seedPort, dataDir: seedDir, token: 'explicit-seed-token', log: () => undefined })
    await seeded.start()
    allPids.push(readEndpoint(seedDir).pid as number)
    try {
      expect(readFileSync(tokenFile(seedDir), 'utf8').trim()).toBe('explicit-seed-token')
      expect(seeded.kernelToken).toBe('explicit-seed-token')
      expect((await request(seedPort, '/v1/projects', 'GET', { authorization: 'Bearer explicit-seed-token' })).status).toBe(200)
      expect((await request(seedPort, '/v1/projects')).status).toBe(401)
    } finally {
      await seeded.stop()
    }
  })

  it('UiKernelSidecar: same kernel-token contract — 0600 file, injected token, bearer enforced, health exempt', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'sidecar-ui-kt-'))
    tempDirs.push(dataDir)
    const port = await freePort()
    const sidecar = new UiKernelSidecar({ host: '127.0.0.1', port, dataDir, log: () => undefined })
    await sidecar.start()
    const pid = readEndpoint(dataDir).pid as number
    allPids.push(pid)
    try {
      const token = readFileSync(tokenFile(dataDir), 'utf8').trim()
      expect(token).toMatch(hex32)
      expect(statSync(tokenFile(dataDir)).mode & 0o777).toBe(0o600)
      expect(sidecar.kernelToken).toBe(token)
      const dshPluginToken = readFileSync(join(dataDir, 'dsh-plugin-token'), 'utf8').trim()
      expect(dshPluginToken).toMatch(hex32)
      expect(statSync(join(dataDir, 'dsh-plugin-token')).mode & 0o777).toBe(0o600)
      expect(sidecar.operatorPrincipal).toBe(dshOperatorPrincipal(dshPluginToken))
      const orchestratorToken = readFileSync(join(dataDir, 'orchestrator-token'), 'utf8').trim()
      expect(orchestratorToken).toMatch(hex32)
      expect(statSync(join(dataDir, 'orchestrator-token')).mode & 0o777).toBe(0o600)
      expect(sidecar.orchestratorToken).toBe(orchestratorToken)
      expect((await request(port, '/v1/projects')).status).toBe(401)
      expect((await request(port, '/v1/projects', 'GET', { authorization: `Bearer ${token}` })).status).toBe(200)
      expect((await request(port, '/v1/projects', 'POST', {}, { name: 'x', workspace: '/w' })).status).toBe(401)
      expect((await request(port, '/v1/health')).status).toBe(200)
      // service-token file is still written independently (two layers).
      expect(existsSync(join(dataDir, 'service-token'))).toBe(true)
      expect(readFileSync(join(dataDir, 'service-token'), 'utf8').trim()).not.toBe(token)
    } finally {
      await sidecar.stop()
    }
  })
})
