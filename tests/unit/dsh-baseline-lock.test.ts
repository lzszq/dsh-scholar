import { describe, expect, it } from 'vitest'
import { dshLockfileDrift, isExactSemver } from '../../scripts/dsh-baseline-lock.mjs'

const lockfile = `lockfileVersion: '9.0'

importers:

  .:
    devDependencies:
      '@deepseek-ai/dsh-commands':
        specifier: 0.1.1-rc.2
        version: 0.1.1-rc.2(peer@1.0.0)

  packages/example:
    dependencies: {}

packages:

  '@deepseek-ai/dsh-commands@0.1.1-rc.2': {}
`

describe('DSH baseline lockfile verification', () => {
  it('accepts stable and standard prerelease SemVer but rejects ranges and tags', () => {
    for (const version of ['0.1.1', '1.0.0', '0.1.2-alpha.2', '2.3.4-rc.1+build.7']) {
      expect(isExactSemver(version), version).toBe(true)
    }
    for (const version of ['latest', 'next', '^0.1.1', '0.1', 'v0.1.1', '01.2.3', '1.2.3-']) {
      expect(isExactSemver(version), version).toBe(false)
    }
  })

  it('accepts exact root and resolved package versions', () => {
    expect(dshLockfileDrift(lockfile, '0.1.1-rc.2', ['@deepseek-ai/dsh-commands'])).toEqual([])
    expect(dshLockfileDrift(
      lockfile.replaceAll("'@deepseek-ai/dsh-commands'", '"@deepseek-ai/dsh-commands"'),
      '0.1.1-rc.2',
      ['@deepseek-ai/dsh-commands'],
    )).toEqual([])
  })

  it('fails closed when either the root importer or resolved package drifts', () => {
    const drifted = lockfile
      .replace('specifier: 0.1.1-rc.2', 'specifier: 0.1.1-rc.9')
      .replace("dsh-commands@0.1.1-rc.2'", "dsh-commands@0.1.1-rc.8'")
    expect(dshLockfileDrift(drifted, '0.1.1-rc.2', ['@deepseek-ai/dsh-commands'])).toEqual([
      '@deepseek-ai/dsh-commands root lock entry is not 0.1.1-rc.2',
      '@deepseek-ai/dsh-commands package key resolves 0.1.1-rc.8, expected 0.1.1-rc.2',
    ])
  })

  it('detects every direct root DSH dependency, not only the manifest-provided list', () => {
    const extraDirect = lockfile.replace(
      '    devDependencies:',
      `    dependencies:\n      '@deepseek-ai/dsh-extra':\n        specifier: 9.9.9\n        version: 9.9.9\n    devDependencies:`,
    )
    expect(dshLockfileDrift(extraDirect, '0.1.1-rc.2', ['@deepseek-ai/dsh-commands'])).toContain(
      '@deepseek-ai/dsh-extra root lock entry is not 0.1.1-rc.2',
    )
  })
})
