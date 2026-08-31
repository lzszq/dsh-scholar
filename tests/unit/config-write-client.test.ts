import { createServer } from 'node:http'
import { afterEach, describe, expect, it } from 'vitest'
import { ResearchClient } from '@dsh-scholar/research-client'

const closers: Array<() => Promise<void>> = []
afterEach(async () => { for (const close of closers.splice(0)) await close() })

async function captureServer(): Promise<{
  endpoint: string
  requests: Array<{ method: string; url: string; body: unknown }>
}> {
  const requests: Array<{ method: string; url: string; body: unknown }> = []
  const server = createServer((request, response) => {
    const chunks: Buffer[] = []
    request.on('data', chunk => chunks.push(Buffer.from(chunk)))
    request.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8')
      requests.push({ method: request.method ?? '', url: request.url ?? '', body: raw === '' ? null : JSON.parse(raw) as unknown })
      response.writeHead(200, { 'content-type': 'application/json' })
      if (request.url?.startsWith('/v1/config/layers/') === true) {
        response.end(JSON.stringify({ scope: 'project', scope_id: 'rsp_cfg', revision: 3, config: {}, config_pin: 'sha256:a', updated_by: null, updated_at: null }))
      } else if (request.url?.startsWith('/v1/config/revisions/') === true) {
        response.end(JSON.stringify([]))
      } else if (request.url?.startsWith('/v1/config/effective') === true) {
        response.end(JSON.stringify({ schema_version: 1, config: {}, config_pin: 'sha256:b', revisions: { global: 0, project: 3, runtime: { kernel: 1 } }, provenance: {}, hot_applied_keys: [], restart_required_keys: [], restart_required: false }))
      } else {
        response.end(JSON.stringify({ config: null, operations: [] }))
      }
    })
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('missing address')
  closers.push(() => new Promise<void>((resolve, reject) => server.close(error => error === undefined ? resolve() : reject(error))))
  return { endpoint: `http://127.0.0.1:${address.port}`, requests }
}

describe('REVIEW-CONFIG-WRITE-03 typed ResearchClient', () => {
  it('reads exact layer/effective/revision views and submits one Settings transaction', async () => {
    const server = await captureServer()
    const client = new ResearchClient({ endpoint: server.endpoint })
    await client.configEffective({ project_id: 'rsp_cfg' })
    await client.configLayer('project', 'rsp_cfg')
    await client.configRevisions('project', 'rsp_cfg')
    await client.writeSettingsTransaction({ operations: [{
      kind: 'config', scope: 'project', scope_id: 'rsp_cfg', expected_revision: 3,
      changes: { 'execution.network_policy': 'none' },
    }] })

    expect(server.requests).toEqual([
      { method: 'GET', url: '/v1/config/effective?project_id=rsp_cfg', body: null },
      { method: 'GET', url: '/v1/config/layers/project/rsp_cfg', body: null },
      { method: 'GET', url: '/v1/config/revisions/project/rsp_cfg', body: null },
      {
        method: 'POST', url: '/v1/settings/transactions',
        body: { operations: [{
          kind: 'config', scope: 'project', scope_id: 'rsp_cfg', expected_revision: 3,
          changes: { 'execution.network_policy': 'none' },
        }] },
      },
    ])
  })
})
