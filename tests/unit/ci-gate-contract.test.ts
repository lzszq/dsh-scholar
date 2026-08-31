import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { describe, expect, it } from 'vitest'

const repo = resolve(import.meta.dirname, '../..')

function runStubbedGate(args: string[] = []): { result: ReturnType<typeof spawnSync>; calls: string } {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-ci-gate-contract-'))
  const log = join(dir, 'calls.log')
  const stub = `#!/bin/sh\nprintf '%s %s\\n' "$(basename "$0")" "$*" >> "$CI_GATE_LOG"\nexit 0\n`
  for (const command of ['pnpm', 'node', 'git', 'env']) {
    const path = join(dir, command)
    writeFileSync(path, stub)
    chmodSync(path, 0o755)
  }
  try {
    const result = spawnSync('bash', ['scripts/ci-gate.sh', ...args], {
      cwd: repo,
      env: { ...process.env, CI: '', CI_GATE_LOG: log, PATH: `${dir}:${process.env.PATH ?? ''}` },
      encoding: 'utf8',
    })
    return { result, calls: readFileSync(log, 'utf8') }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

describe('release CI gate contract', () => {
  it('runs every release-blocking command, including docs and whitespace checks', () => {
    const { result, calls } = runStubbedGate()
    expect(result.status).toBe(0)
    expect(calls).toContain('pnpm run check:dsh-baseline')
    expect(calls).toContain('pnpm run build')
    expect(calls).toContain('pnpm test')
    expect(calls).toContain('node scripts/verify-docs.mjs --diff-check origin/main')
    expect(calls).toContain('git diff --check')
    expect(calls).toContain('git diff --check origin/main...HEAD')
    expect(calls).toContain('env CI=true bash tests/security/run-all-v2-blocking-tests.sh')
    expect(calls).toContain('pnpm --filter @dsh-scholar/research-plugin typecheck')
  })

  it('rejects security skipping when CI=true before running expensive steps', () => {
    const result = spawnSync('bash', ['scripts/ci-gate.sh', '--skip-security'], {
      cwd: repo,
      env: { ...process.env, CI: 'true' },
      encoding: 'utf8',
    })
    expect(result.status).toBe(2)
    expect(result.stderr).toContain('--skip-security is forbidden when CI=true')
  })

  it('reports a local security skip as blocked rather than release evidence', () => {
    const { result } = runStubbedGate(['--skip-security'])
    expect(result.status).toBe(1)
    expect(result.stdout).toContain('GATE BLOCKED')
    expect(result.stdout).toContain('1 skipped')
  })
})
