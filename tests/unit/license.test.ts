import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const root = join(import.meta.dirname, '..', '..')
const manifests = [
  'package.json',
  'packages/analysis-engine/package.json',
  'packages/dsh-research-ui/package.json',
  'packages/research-client/package.json',
  'packages/research-kernel/package.json',
  'packages/research-schemas/package.json',
  'packages/scholar-connectors/package.json',
  'workers/analysis-worker/package.json',
  'workers/research-orchestrator/package.json',
  'workers/runner-gateway/package.json',
]

describe('REVIEW-LICENSE-03', () => {
  it('uses one BSD-3-Clause repository license across every publishable manifest', () => {
    for (const path of manifests) {
      const manifest = JSON.parse(readFileSync(join(root, path), 'utf8')) as { license?: string }
      expect(manifest.license, path).toBe('BSD-3-Clause')
    }
    const license = readFileSync(join(root, 'LICENSE'), 'utf8')
    expect(license).toContain('Redistribution and use in source and binary forms')
    expect(license).toContain('Neither the name of the copyright holder')
    expect(license).not.toContain('MIT License')
  })
})
