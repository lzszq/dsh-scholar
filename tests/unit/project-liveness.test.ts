import { describe, expect, it } from 'vitest'
import { backgroundProjectScopesToProbe, projectIsAuthoritativelyGone, projectRenderTargetIsCurrent } from '../../packages/dsh-research-ui/src/client/project-liveness.js'

describe('project liveness cleanup fence', () => {
  it('clears local project state only after authoritative absence and a 404', () => {
    expect(projectIsAuthoritativelyGone('rsp_1', true, [], 404)).toBe(true)
    expect(projectIsAuthoritativelyGone('rsp_1', true, [{ project_id: 'rsp_1' }], 404)).toBe(false)
    expect(projectIsAuthoritativelyGone('rsp_1', false, [], 404)).toBe(false)
    expect(projectIsAuthoritativelyGone('rsp_1', true, [], 500)).toBe(false)
    expect(projectIsAuthoritativelyGone('rsp_1', true, [], 0)).toBe(false)
  })

  it('rejects a stale async render after the user selects another project', () => {
    expect(projectRenderTargetIsCurrent('rsp_a', 'rsp_a')).toBe(true)
    expect(projectRenderTargetIsCurrent('rsp_a', 'rsp_b')).toBe(false)
    expect(projectRenderTargetIsCurrent('rsp_a', undefined)).toBe(false)
  })

  it('probes only background scopes absent from a successful project list', () => {
    expect(backgroundProjectScopesToProbe(
      ['rsp_a', 'rsp_b', 'rsp_gone', 'rsp_gone'],
      'rsp_b',
      [{ project_id: 'rsp_a' }, { project_id: 'rsp_b' }],
    )).toEqual(['rsp_gone'])
  })
})
