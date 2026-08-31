/**
 * OBS-01 (reconstruction-contracts.md §18): MetricsStore + /internal/metrics.
 * Covers the minimal counter/histogram store semantics, the kernel key-path
 * instrumentation (counter growth after method calls), the loopback-only
 * HTTP surface (200 on loopback, 403 on non-loopback sources, no service
 * token required) and the no-secrets guarantee of the snapshot (no tokens,
 * paths or terminal/content bytes).
 * @module tests/unit/metrics.test
 */
import { describe, expect, it } from 'vitest'
import { mkdtempSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ResearchKernel, MetricsStore, HISTOGRAM_BUCKETS } from '@dsh-scholar/research-kernel'
import { ConfiguredTestKernel } from './configured-test-kernel.js'
import { multiSourceSearch, NULL_CACHE, type ConnectorMetrics } from '@dsh-scholar/scholar-connectors'
import { startKernelServer, handleInternalMetrics, metricsAccessAllowed, isLoopbackAddress } from '../../packages/research-kernel/lib/server.js'
import type { IncomingMessage, ServerResponse } from 'node:http'

function freshKernel(options: { serviceToken?: string } = {}): ResearchKernel {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-metrics-test-'))
  return new ConfiguredTestKernel({
    dbPath: join(dir, 'kernel.db'),
    casRoot: join(dir, 'cas'),
    requireSignedManifest: false,
    ...options,
  })
}

function makeBrief() {
  return {
    problem: 'p', scope: 's', questions: [], primary_metrics: ['m'],
    resources: '', risks: [], target_outputs: ['paper'], target_venue: null,
    baseline_repo: null, domain: 'ml',
  }
}

function counterValue(kernel: ResearchKernel, key: string, tags?: Record<string, string>): number {
  return kernel.metrics.snapshot().counters
    .filter(c => c.key === key && (tags === undefined || JSON.stringify(c.tags) === JSON.stringify(tags)))
    .reduce((sum, c) => sum + c.value, 0)
}

function histogramValue(kernel: ResearchKernel, key: string): { count: number; sum: number; min: number | null; max: number | null } | undefined {
  const h = kernel.metrics.snapshot().histograms.find(h => h.key === key)
  return h === undefined ? undefined : { count: h.count, sum: h.sum, min: h.min, max: h.max }
}

/** Minimal IncomingMessage stand-in for direct route-handler tests. */
function fakeReq(url: string, remoteAddress: string | undefined): IncomingMessage {
  return {
    method: 'GET',
    url,
    headers: {},
    socket: { remoteAddress },
  } as unknown as IncomingMessage
}

/** Minimal ServerResponse stand-in capturing the written status/body. */
function fakeRes(): { res: ServerResponse; status: number; body: string } {
  const captured = { status: 0, body: '' }
  const res = {
    writeHead(status: number) { captured.status = status; return res },
    end(body: string) { captured.body = String(body ?? '') },
    setHeader() { return res },
  } as unknown as ServerResponse
  return {
    res,
    get status() { return captured.status },
    get body() { return captured.body },
  }
}

describe('MetricsStore (OBS-01 §18)', () => {
  it('counts with tags; distinct (key, tags) pairs are distinct series', () => {
    const m = new MetricsStore()
    m.count('job.claimed')
    m.count('job.claimed')
    m.count('job.claimed', { status: 'succeeded' })
    const snap = m.snapshot()
    expect(snap.counters).toHaveLength(2)
    const plain = snap.counters.find(c => Object.keys(c.tags).length === 0)
    const tagged = snap.counters.find(c => c.tags.status === 'succeeded')
    expect(plain?.value).toBe(2)
    expect(tagged?.value).toBe(1)
    expect(typeof snap.generated_at).toBe('string')
    expect(snap.uptime_ms).toBeGreaterThanOrEqual(0)
  })

  it('supports deltas and ignores non-positive deltas', () => {
    const m = new MetricsStore()
    m.count('lease.expiry', undefined, 3)
    m.count('lease.expiry', undefined, 0)
    m.count('lease.expiry', undefined, -1)
    const snap = m.snapshot()
    expect(snap.counters).toHaveLength(1)
    expect(snap.counters[0]!.value).toBe(3)
  })

  it('histograms keep exact count/sum/min/max plus cumulative buckets', () => {
    const m = new MetricsStore()
    m.observe('http.request.duration_ms', 5)
    m.observe('http.request.duration_ms', 15)
    m.observe('http.request.duration_ms', 3000)
    const snap = m.snapshot()
    const h = snap.histograms.find(h => h.key === 'http.request.duration_ms')
    expect(h).toBeDefined()
    expect(h!.count).toBe(3)
    expect(h!.sum).toBe(3020)
    expect(h!.min).toBe(5)
    expect(h!.max).toBe(3000)
    // Each observation lands in the FIRST bucket whose upper bound is >= it:
    // 5 -> le 5, 15 -> le 25, 3000 -> le 5000; nothing above the largest bound.
    expect(h!.buckets).toHaveLength(HISTOGRAM_BUCKETS.length)
    const bucketAt = (le: number) => h!.buckets.find(b => b.le === le)!.count
    expect(bucketAt(0.1)).toBe(0)
    expect(bucketAt(5)).toBe(1)
    expect(bucketAt(25)).toBe(1)
    expect(bucketAt(5000)).toBe(1)
    expect(h!.buckets.reduce((sum, b) => sum + b.count, 0)).toBe(3)
    expect(h!.inf).toBe(0)
  })

  it('keeps tag sets separate for histograms too', () => {
    const m = new MetricsStore()
    m.observe('http.request.duration_ms', 1, { method: 'GET' })
    m.observe('http.request.duration_ms', 2, { method: 'POST' })
    expect(m.snapshot().histograms).toHaveLength(2)
  })
})

describe('kernel key-path instrumentation (OBS-01)', () => {
  it('outbox append + dead-letter counters', () => {
    const kernel = freshKernel()
    const project = kernel.createProject({ name: 't', workspace: '/w', brief: makeBrief() })
    const before = counterValue(kernel, 'outbox.append')
    kernel.emit(project.project_id, 'job.updated', { job_id: 'j1' })
    expect(counterValue(kernel, 'outbox.append')).toBe(before + 1)
    const events = kernel.listEvents(project.project_id)
    const last = events[events.length - 1]!
    expect(kernel.deadLetterEvent(last.event_id)).toBe(true)
    expect(counterValue(kernel, 'outbox.dead_letter')).toBe(1)
    // Idempotent: an already dead-lettered event is not double counted.
    expect(kernel.deadLetterEvent(last.event_id)).toBe(false)
    expect(counterValue(kernel, 'outbox.dead_letter')).toBe(1)
    kernel.close()
  })

  it('job claim / complete counters', () => {
    const kernel = freshKernel()
    const project = kernel.createProject({ name: 't', workspace: '/w', brief: makeBrief() })
    const job = kernel.submitJob({ project_id: project.project_id, idempotency_key: 'm1', kind: 'echo' })
    const claimedBefore = counterValue(kernel, 'job.claimed')
    const claimed = kernel.claimJobs('runner-1', 300, 8)
    const mine = claimed.find(c => c.job_id === job.job_id)
    expect(mine).toBeDefined()
    expect(counterValue(kernel, 'job.claimed')).toBe(claimedBefore + 1)
    const leased = kernel.getJob(job.job_id)
    kernel.completeJob({
      job_id: job.job_id, owner: 'runner-1', status: 'succeeded',
      lease_generation: leased.lease_generation, lease_token: leased.lease_token,
    })
    expect(counterValue(kernel, 'job.completed', { status: 'succeeded' })).toBe(1)
    kernel.close()
  })

  it('lease expiry counter accumulates recovered jobs', () => {
    const kernel = freshKernel()
    const project = kernel.createProject({ name: 't', workspace: '/w', brief: makeBrief() })
    const job = kernel.submitJob({ project_id: project.project_id, idempotency_key: 'm2', kind: 'echo' })
    // Claim with a zero TTL so the lease is already expired.
    kernel.claimJobs('runner-1', 0, 8)
    expect(kernel.getJob(job.job_id).status).toBe('running')
    expect(kernel.recoverExpiredLeases()).toBeGreaterThanOrEqual(1)
    expect(counterValue(kernel, 'lease.expiry')).toBeGreaterThanOrEqual(1)
    // No stale leases -> no extra counter growth.
    const again = counterValue(kernel, 'lease.expiry')
    expect(kernel.recoverExpiredLeases()).toBe(0)
    expect(counterValue(kernel, 'lease.expiry')).toBe(again)
    kernel.close()
  })

  it('terminal dropped-bytes counter', () => {
    const kernel = freshKernel()
    const project = kernel.createProject({ name: 't', workspace: '/w', brief: makeBrief() })
    const job = kernel.submitJob({ project_id: project.project_id, idempotency_key: 'm3', kind: 'echo' })
    const frames = [1, 2, 3, 4].map(i => ({
      seq: i, stream_seq: i, channel: 'stdout', text: 'x'.repeat(100),
      byte_offset: 0, byte_length: 100, frame_kind: 'chunk',
    }))
    const res = kernel.appendTerminalFrames({ jobId: job.job_id, runId: 'run1', frames, maxLogBytes: 250 })
    expect(res.truncated).toBe(true)
    expect(res.dropped_bytes).toBeGreaterThan(0)
    expect(counterValue(kernel, 'terminal.dropped_bytes')).toBe(res.dropped_bytes)
    kernel.close()
  })

  it('CAS orphan GC counter', () => {
    const kernel = freshKernel()
    const project = kernel.createProject({ name: 't', workspace: '/w', brief: makeBrief() })
    kernel.registerArtifact({ project_id: project.project_id, kind: 'data', content: 'keep' })
    const o1 = kernel.cas.put('orphan-1')
    const o2 = kernel.cas.put('orphan-2')
    // Pin the blob mtimes to the past so the grace check is deterministic
    // (fs mtime granularity can round UP to the next tick otherwise).
    for (const o of [o1, o2]) {
      utimesSync(join(kernel.cas.root, o.sha256), new Date(Date.now() - 5000), new Date(Date.now() - 5000))
    }
    expect(kernel.collectOrphanBlobs(0)).toBe(2)
    expect(counterValue(kernel, 'cas.orphans_removed')).toBe(2)
    expect(kernel.collectOrphanBlobs(0)).toBe(0)
    expect(counterValue(kernel, 'cas.orphans_removed')).toBe(2)
    kernel.close()
  })

  it('TeX build completion counter', () => {
    const kernel = freshKernel()
    const project = kernel.createProject({ name: 't', workspace: '/w', brief: makeBrief() })
    const doc = kernel.texEnsure(project.project_id, 'paper.tex')
    const build = kernel.texCreateBuild(doc.document_id, 1, 'paper.tex', null)
    expect(counterValue(kernel, 'tex.build_completed')).toBe(0)
    kernel.texUpdateBuild(build.build_id, { status: 'running' })
    expect(counterValue(kernel, 'tex.build_completed')).toBe(0)
    kernel.texUpdateBuild(build.build_id, { status: 'succeeded', diagnostics: '[]' })
    expect(counterValue(kernel, 'tex.build_completed', { status: 'succeeded' })).toBe(1)
    kernel.close()
  })

  it('budget accounting counter + cost histogram', () => {
    const kernel = freshKernel()
    const project = kernel.createProject({ name: 't', workspace: '/w', brief: makeBrief() })
    kernel.recordUsage(project.project_id, { model_cost_usd: 1.25, api_requests: 3 })
    kernel.recordUsage(project.project_id, { model_cost_usd: 0.75 })
    expect(counterValue(kernel, 'budget.recorded')).toBe(2)
    const h = histogramValue(kernel, 'budget.model_cost_usd')
    expect(h?.count).toBe(2)
    expect(h?.sum).toBe(2)
    expect(h?.min).toBe(0.75)
    expect(h?.max).toBe(1.25)
    kernel.close()
  })

  it('connector source failures are counted through the metrics observer', async () => {
    const m = new MetricsStore()
    const metrics: ConnectorMetrics = { count: (key, tags) => m.count(key, tags) }
    const originalFetch = globalThis.fetch
    // All three sources fail -> three failure counters, one per source tag.
    globalThis.fetch = (async () => { throw new Error('network unreachable') }) as typeof fetch
    try {
      const result = await multiSourceSearch('transformer', { limit: 5 }, NULL_CACHE, metrics)
      expect(result.source_status.every(s => s.status === 'failed')).toBe(true)
    } finally {
      globalThis.fetch = originalFetch
    }
    const failures = m.snapshot().counters.filter(c => c.key === 'connector.source_failure')
    expect(failures).toHaveLength(3)
    for (const source of ['openalex', 'crossref', 'arxiv']) {
      expect(failures.some(f => f.tags.source === source && f.value === 1)).toBe(true)
    }
  })
})

describe('GET /internal/metrics endpoint (OBS-01)', () => {
  it('serves a JSON snapshot only with the configured service token and loopback peer', async () => {
    const serviceToken = 'st_internal_secret'
    const kernel = freshKernel({ serviceToken })
    const project = kernel.createProject({ name: 't', workspace: '/w', brief: makeBrief() })
    kernel.recordUsage(project.project_id, { model_cost_usd: 0.5 })
    const { server, port } = await startKernelServer({ kernel, port: 0 })
    try {
      const missing = await fetch(`http://127.0.0.1:${port}/internal/metrics`)
      expect(missing.status).toBe(403)
      expect((await missing.json() as { error: { code: string } }).error.code).toBe('service_token_required')
      const response = await fetch(`http://127.0.0.1:${port}/internal/metrics`, {
        headers: { 'x-service-token': serviceToken },
      })
      expect(response.status).toBe(200)
      expect(response.headers.get('content-type')).toContain('application/json')
      const body = await response.json() as {
        generated_at: string; uptime_ms: number; counters: Array<{ key: string; tags: Record<string, string>; value: number }>; histograms: unknown[]
      }
      expect(body.generated_at).toBeTruthy()
      expect(body.uptime_ms).toBeGreaterThanOrEqual(0)
      expect(body.counters.some(c => c.key === 'budget.recorded' && c.value === 1)).toBe(true)
      // The request counter is recorded on response FINISH, so the first
      // snapshot cannot contain its own request — the second one can.
      const second = await fetch(`http://127.0.0.1:${port}/internal/metrics`, {
        headers: { 'x-service-token': serviceToken },
      })
      expect(second.status).toBe(200)
      const body2 = await second.json() as { counters: Array<{ key: string; tags: Record<string, string>; value: number }> }
      expect(body2.counters.some(c => c.key === 'http.request' && c.tags.status === '200')).toBe(true)
    } finally {
      server.close()
      kernel.close()
    }
  })

  it('rejects non-loopback sources with 403 loopback_only', () => {
    const kernel = freshKernel()
    const captured = fakeRes()
    const handled = handleInternalMetrics(fakeReq('/internal/metrics', '10.1.2.3'), captured.res, kernel, '0.0.0.0')
    expect(handled).toBe(true)
    expect(captured.status).toBe(403)
    expect(captured.body).toContain('loopback_only')
    kernel.close()
  })

  it('allows loopback sources even when the server binds a non-loopback host', () => {
    const kernel = freshKernel()
    const captured = fakeRes()
    const handled = handleInternalMetrics(fakeReq('/internal/metrics', '::ffff:127.0.0.1'), captured.res, kernel, '0.0.0.0')
    expect(handled).toBe(true)
    expect(captured.status).toBe(200)
    expect(captured.body).toContain('"counters"')
    kernel.close()
  })

  it('does not hijack other routes', () => {
    const kernel = freshKernel()
    const captured = fakeRes()
    const handled = handleInternalMetrics(fakeReq('/v1/health', '127.0.0.1'), captured.res, kernel, '0.0.0.0')
    expect(handled).toBe(false)
    expect(captured.status).toBe(0)
    kernel.close()
  })

  it('loopback predicate: IPv4/IPv6/mapped forms, bound-host fallback', () => {
    expect(isLoopbackAddress('127.0.0.1')).toBe(true)
    expect(isLoopbackAddress('::1')).toBe(true)
    expect(isLoopbackAddress('::ffff:127.0.0.1')).toBe(true)
    expect(isLoopbackAddress('10.0.0.7')).toBe(false)
    expect(isLoopbackAddress(undefined)).toBe(false)
    // remote loopback always allowed
    expect(metricsAccessAllowed('127.0.0.1', '0.0.0.0')).toBe(true)
    expect(metricsAccessAllowed('::1', '0.0.0.0')).toBe(true)
    // non-loopback remote rejected on a non-loopback bound host
    expect(metricsAccessAllowed('10.0.0.7', '0.0.0.0')).toBe(false)
    expect(metricsAccessAllowed('192.168.1.9', '::')).toBe(false)
    expect(metricsAccessAllowed(undefined, '0.0.0.0')).toBe(false)
    // loopback-bound server accepts any peer (all peers are local)
    expect(metricsAccessAllowed('10.0.0.7', '127.0.0.1')).toBe(true)
    expect(metricsAccessAllowed('10.0.0.7', '::1')).toBe(true)
    expect(metricsAccessAllowed('10.0.0.7', 'localhost')).toBe(true)
  })
})

describe('metrics snapshot hygiene (OBS-01)', () => {
  it('never contains tokens, paths or content bytes', () => {
    const secretToken = 'st_super_secret_service_token'
    const kernel = freshKernel({ serviceToken: secretToken })
    const dir = tmpdir()
    const project = kernel.createProject({ name: 't', workspace: '/w', brief: makeBrief() })
    const job = kernel.submitJob({ project_id: project.project_id, idempotency_key: 'm-sec', kind: 'echo' })
    kernel.claimJobs('runner-1', 300, 8)
    const leased = kernel.getJob(job.job_id)
    const leaseToken = leased.lease_token!
    expect(leaseToken.startsWith('lt_')).toBe(true)
    // Terminal content + an artifact payload + a budget record — all must
    // stay out of the metrics surface.
    kernel.appendTerminalFrames({
      jobId: job.job_id, runId: 'run_secret',
      frames: [{ seq: 1, frame_kind: 'chunk', channel: 'stdout', stream_seq: 1, text: 'TOP-SECRET-TERMINAL-CONTENT', byte_offset: 0, byte_length: 26, lease_generation: leased.lease_generation }],
    })
    kernel.registerArtifact({ project_id: project.project_id, kind: 'data', content: 'SECRET-ARTIFACT-CONTENT' })
    kernel.recordUsage(project.project_id, { model_cost_usd: 9.99 })
    const serialized = JSON.stringify(kernel.metrics.snapshot())
    expect(serialized).not.toContain(secretToken)
    expect(serialized).not.toContain(leaseToken)
    expect(serialized).not.toContain('TOP-SECRET-TERMINAL-CONTENT')
    expect(serialized).not.toContain('SECRET-ARTIFACT-CONTENT')
    // No absolute paths (tmpdir) and no job/project ids in the surface.
    expect(serialized).not.toContain(dir)
    expect(serialized).not.toContain(job.job_id)
    expect(serialized).not.toContain(project.project_id)
    // And every series key is one of the fixed instrumentation keys.
    const keys = new Set(kernel.metrics.snapshot().counters.map(c => c.key))
    for (const key of keys) {
      expect(key).toMatch(/^(http\.request|outbox\.(append|dead_letter)|job\.(claimed|completed)|lease\.expiry|terminal\.dropped_bytes|cas\.orphans_removed|tex\.build_completed|budget\.recorded|connector\.source_failure)$/)
    }
    kernel.close()
  })
})
