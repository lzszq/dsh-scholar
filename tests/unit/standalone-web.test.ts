/**
 * Standalone web application server tests: option loading, token lifecycle,
 * proxy auth and CSRF posture (design §15.2/§15.3) on the only browser
 * delivery mode supported by DSH Scholar.
 * @module tests/unit/standalone-web.test
 */

import { describe, expect, it } from 'vitest'
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  loadOptions, bffError, bootstrapHtmlWithNonce, isProjectTrajectoryTopologyForward, standaloneContentSecurityPolicy,
  contractDraftFromIdea, ideaAuditQueries, ideaNoveltyAudit, parseStandaloneUnlockError, standaloneFrameAncestorSources,
  surveySnapshotBody, surveyWriteRoleAllowed,
} from '../../packages/dsh-research-ui/lib/standalone/server.js'
// @ts-expect-error re-export surface

describe('standalone web application', () => {
  it('derives a reviewable Contract draft from the approved idea MVE', () => {
    expect(contractDraftFromIdea({
      exact_delta: 'Replace the baseline head with temperature scaling.',
      minimum_viable_experiment: {
        dataset: 'CIFAR-10', baseline: 'ResNet-18', primary_metric: 'ECE', estimated_gpu_hours: 2.2,
      },
    })).toEqual({
      data: { dataset_id: 'CIFAR-10', version: 'official', split: 'official' },
      methods: { baseline: 'ResNet-18', treatment: 'Replace the baseline head with temperature scaling.' },
      metrics: { primary: 'ECE', secondary: [], direction: 'higher_is_better' },
      seeds: [11, 23, 47, 89, 101],
      analysis: { effect_size: 'mean_difference', interval: 'bootstrap_95', multiple_testing: 'holm' },
      ablations: [],
      stop_conditions: { max_gpu_hours: 3, min_completed_seeds: 5, stop_on_data_leakage: true },
    })
  })

  it('derives bounded idea counter-search queries and a strict audit from connector results', () => {
    const queries = ideaAuditQueries({
      title: '  CNN depth   effect  ',
      hypothesis: 'Two layers improve calibration.',
      exact_delta: 'Compare one versus two layers with matched parameters.',
    })
    expect(queries).toEqual([
      'CNN depth effect',
      'Two layers improve calibration.',
      'Compare one versus two layers with matched parameters.',
    ])
    expect(ideaNoveltyAudit(queries, [{
      hits: [{ paper: { paper_id: 'doi:10.1/a' } }, { paper: { paper_id: 'doi:10.1/a' } }],
      source_status: [{ status: 'ok' }],
    }], '2026-08-17T00:00:00.000Z')).toEqual({
      queries,
      result: 'overlap_found',
      overlap_papers: ['doi:10.1/a'],
      unresolved_risk: 'medium',
      audited_at: '2026-08-17T00:00:00.000Z',
    })
    expect(ideaNoveltyAudit(queries, [{ hits: [], source_status: [{ status: 'failed' }] }]).result).toBe('inconclusive')
  })

  it('loads options with defaults (port 18610, shared kernel 7412)', () => {
    const dir = join(tmpdir(), `dsh-standalone-defaults-${Date.now()}`)
    const o = loadOptions(['--data-dir', dir])
    expect(o.port).toBe(18610)
    expect(o.kernelPort).toBe(7412)
    expect(o.kernelDataDir).toContain('.dsh/research-kernel')
    expect(o.host).toBe('127.0.0.1')
    expect(o.principal).toBeNull()
    expect(o.frameAncestors).toContain('http://127.0.0.1:3080')
  })

  it('parses only an explicit principal; startup derives the stable default later', () => {
    const anonymousDir = join(tmpdir(), `dsh-standalone-principal-anon-${Date.now()}`)
    const principalDir = join(tmpdir(), `dsh-standalone-principal-explicit-${Date.now()}`)
    expect(loadOptions(['--data-dir', anonymousDir]).principal).toBeNull()
    expect(loadOptions(['--data-dir', principalDir, '--principal', 'ops-1']).principal).toBe('ops-1')
  })

  it('loads explicit --port / --kernel-port / --kernel-data-dir / --data-dir', () => {
    const dir = join(tmpdir(), 'dsh-standalone-opts-test')
    const kernelDir = join(tmpdir(), 'dsh-shared-kernel-opts-test')
    const o = loadOptions(['--port', '19000', '--kernel-port', '19001', '--kernel-data-dir', kernelDir, '--data-dir', dir, '--no-token'])
    expect(o.port).toBe(19000)
    expect(o.kernelPort).toBe(19001)
    expect(o.kernelDataDir).toBe(kernelDir)
    expect(o.dataDir).toBe(dir)
    expect(o.token).toBeNull()
  })

  it('persists a generated token under the data dir (0600)', () => {
    const dir = join(tmpdir(), `dsh-standalone-tok-${Date.now()}`)
    const o = loadOptions(['--data-dir', dir])
    expect(o.token).toBeTruthy()
    expect(o.token!.startsWith('dsh-')).toBe(true)
    const file = join(dir, 'standalone-token')
    expect(readFileSync(file, 'utf8').trim()).toBe(o.token)
    // Second load reuses the persisted token (stable identity).
    const o2 = loadOptions(['--data-dir', dir])
    expect(o2.token).toBe(o.token)
  })

  it('rejects a standalone token on argv without persisting the secret', () => {
    const dir = join(tmpdir(), `dsh-standalone-explicit-${Date.now()}`)
    expect(() => loadOptions(['--data-dir', dir, '--token', 'argv-secret-canary'])).toThrow(/unknown CLI flag/)
    expect(existsSync(join(dir, 'standalone-token'))).toBe(false)
  })

  it('repairs an existing token file to 0600 before reading it', () => {
    const dir = join(tmpdir(), `dsh-standalone-mode-${Date.now()}`)
    mkdirSync(dir, { recursive: true })
    const file = join(dir, 'standalone-token')
    writeFileSync(file, 'existing-secret', { mode: 0o644 })
    chmodSync(file, 0o644)
    expect(loadOptions(['--data-dir', dir]).token).toBe('existing-secret')
    expect(statSync(file).mode & 0o777).toBe(0o600)
  })

  it('rejects a symlink token path', () => {
    const dir = join(tmpdir(), `dsh-standalone-symlink-${Date.now()}`)
    mkdirSync(dir, { recursive: true })
    const target = join(dir, 'target-token')
    writeFileSync(target, 'do-not-follow')
    symlinkSync(target, join(dir, 'standalone-token'))
    expect(() => loadOptions(['--data-dir', dir])).toThrow(/regular file/)
  })

  it('--no-token disables auth on loopback', () => {
    const o = loadOptions(['--no-token'])
    expect(o.token).toBeNull()
  })

  it.each(['0.0.0.0', '192.168.1.9', 'example.test'])('rejects tokenless non-loopback host %s', host => {
    expect(() => loadOptions(['--host', host, '--no-token'])).toThrow(/loopback/)
  })

  it.each(['127.0.0.2', 'localhost', '::1'])('allows tokenless loopback host %s', host => {
    expect(loadOptions(['--host', host, '--no-token']).token).toBeNull()
  })

  it('loadOptions writes the data dir when token file is created', () => {
    const dir = join(tmpdir(), `dsh-standalone-mkdir-${Date.now()}`)
    expect(() => loadOptions(['--data-dir', dir])).not.toThrow()
    expect(existsSync(join(dir, 'standalone-token'))).toBe(true)
    // Re-run on the existing dir is idempotent.
    expect(() => loadOptions(['--data-dir', dir])).not.toThrow()
  })

  it('is exportable from the package surface', async () => {
    const mod = await import('../../packages/dsh-research-ui/lib/standalone/server.js')
    expect(typeof mod.startStandalone).toBe('function')
    expect(typeof mod.loadOptions).toBe('function')
    void mkdirSync
    void writeFileSync
  })

  it('builds a nonce CSP from exact configured loopback frame ancestors', () => {
    const sources = standaloneFrameAncestorSources('http://127.0.0.1:3080, http://localhost:3080/,http://[::1]:3080')
    expect(sources).toEqual(['http://127.0.0.1:3080', 'http://localhost:3080', 'http://[::1]:3080'])
    const csp = standaloneContentSecurityPolicy('nonce-value', sources)
    expect(csp).toContain("script-src 'self' 'nonce-nonce-value'")
    expect(csp).toContain("style-src 'self' 'nonce-nonce-value'")
    expect(csp).toContain("style-src-attr 'unsafe-inline'")
    expect(csp).not.toContain("style-src 'self' 'nonce-nonce-value' 'unsafe-inline'")
    expect(csp).toContain("object-src 'none'")
    expect(csp).toContain("frame-src 'self' blob:")
    expect(csp).toContain("media-src 'self' blob:")
    expect(csp).toContain("frame-ancestors 'self' http://127.0.0.1:3080")
    expect(csp).not.toContain('*')
  })

  it('passes the response nonce to runtime Shadow DOM styles', () => {
    const html = bootstrapHtmlWithNonce('runtime-style-nonce')
    expect(html).toContain('<style nonce="runtime-style-nonce">')
    expect(html).toContain('<script nonce="runtime-style-nonce"')
    expect(html).toContain('var cspNonce = document.currentScript')
    expect(html).toContain('apply({ styleNonce: cspNonce })')
    expect(html).not.toContain('notifyFrameReady')
  })

  it('allows explicit HTTPS embedders while rejecting remote plaintext origins', () => {
    expect(standaloneFrameAncestorSources('https://210.34.241.17,https://dsh.example.test/')).toEqual([
      'https://210.34.241.17',
      'https://dsh.example.test',
    ])
    expect(() => standaloneFrameAncestorSources('http://210.34.241.17')).toThrow(/HTTPS or loopback HTTP/)
  })

  it.each([
    '', 'http://127.0.0.1:*', 'http://example.test:3080',
    'http://user@127.0.0.1:3080', 'http://127.0.0.1:3080/path',
    'http://127.0.0.1:3080/?query=1',
  ])('rejects unsafe frame ancestor config %j', value => {
    expect(() => standaloneFrameAncestorSources(value)).toThrow()
  })

  it('BFF-native errors carry the api-contracts §2 envelope (ok:false + stable code)', () => {
    // Every BFF-native error body must expose the stable machine code the
    // client maps copy from (api-contracts.md §2 / §13): plain-string error
    // bodies degraded to client 'http_error'. Representative codes across
    // the documented HTTP→code table are pinned here.
    expect(bffError('rate_limited', 'rate limited')).toEqual({ ok: false, error: { code: 'rate_limited', message: 'rate limited' } })
    expect(bffError('csrf_rejected', 'cross-origin write rejected')).toEqual({ ok: false, error: { code: 'csrf_rejected', message: 'cross-origin write rejected' } })
    expect(bffError('payload_too_large', 'payload too large')).toEqual({ ok: false, error: { code: 'payload_too_large', message: 'payload too large' } })
    expect(bffError('unauthorized', 'unauthorized')).toEqual({ ok: false, error: { code: 'unauthorized', message: 'unauthorized' } })
    expect(bffError('role_forbidden', 'role forbidden')).toEqual({ ok: false, error: { code: 'role_forbidden', message: 'role forbidden' } })
    expect(bffError('project_not_found', 'project not found or access denied')).toEqual({ ok: false, error: { code: 'project_not_found', message: 'project not found or access denied' } })
    expect(bffError('kernel_unreachable', 'research kernel unavailable')).toEqual({ ok: false, error: { code: 'kernel_unreachable', message: 'research kernel unavailable' } })
    expect(bffError('connector_unavailable', 'survey connector unavailable')).toEqual({ ok: false, error: { code: 'connector_unavailable', message: 'survey connector unavailable' } })
    expect(bffError('invalid_json', 'bad request')).toEqual({ ok: false, error: { code: 'invalid_json', message: 'bad request' } })
  })

  it('normalizes structured and legacy unlock errors without stringifying objects', () => {
    expect(parseStandaloneUnlockError({ code: 'unauthorized', message: 'invalid token' })).toEqual({
      code: 'unauthorized', message: 'invalid token',
    })
    expect(parseStandaloneUnlockError('invalid token')).toEqual({ code: 'unauthorized', message: 'invalid token' })
    expect(parseStandaloneUnlockError({ code: 42, message: {} })).toEqual({ code: null, message: null })
  })

  it('survey snapshot preserves citation edges and never marks partial connector failure complete', () => {
    expect(surveySnapshotBody({
      queries: [{ source: 'openalex', query: 'object recognition', run_at: '2026-08-12T00:00:00.000Z' }],
      hits: [{ paper: { paper_id: 'doi:10.1/x', title: 'Paper' } }],
      citation_edges: [{ source_paper_id: 'doi:10.1/x', target_paper_id: 'doi:10.1/y', kind: 'reference' }],
      source_status: [{ source: 'openalex', status: 'ok' }, { source: 'arxiv', status: 'failed', error: 'private upstream detail' }],
    })).toEqual({
      queries: [{ source: 'openalex', query: 'object recognition', run_at: '2026-08-12T00:00:00.000Z' }],
      papers: [{ paper_id: 'doi:10.1/x', title: 'Paper' }],
      citation_edges: [{ source_paper_id: 'doi:10.1/x', target_paper_id: 'doi:10.1/y', kind: 'reference' }],
      source_status: 'pending',
    })
    expect(JSON.stringify(surveySnapshotBody({ queries: [], hits: [], citation_edges: [], source_status: [] }))).not.toContain('private upstream detail')
  })

  it('survey writes are allowed only for PI, operator and researcher roles', () => {
    expect(surveyWriteRoleAllowed('pi')).toBe(true)
    expect(surveyWriteRoleAllowed('operator')).toBe(true)
    expect(surveyWriteRoleAllowed('researcher')).toBe(true)
    expect(surveyWriteRoleAllowed('viewer')).toBe(false)
    expect(surveyWriteRoleAllowed('auditor')).toBe(false)
    expect(surveyWriteRoleAllowed(null)).toBe(false)
  })

  it('classifies every project Trajectory/Topology route that needs BFF principal forwarding', () => {
    for (const path of [
      '/v1/projects/rsp_1/trajectory',
      '/v1/projects/rsp_1/trajectory-lanes',
      '/v1/projects/rsp_1/topology',
      '/v1/projects/rsp_1/topology/children',
    ]) expect(isProjectTrajectoryTopologyForward(path)).toBe(true)
    expect(isProjectTrajectoryTopologyForward('/v1/projects/rsp_1/jobs')).toBe(false)
    expect(isProjectTrajectoryTopologyForward('/v1/topology/child_1')).toBe(false)
  })
})
