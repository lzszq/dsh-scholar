import { describe, expect, it } from 'vitest'
import { gateDecisionErrorKey, gateDecisionRequest } from '../../packages/dsh-research-ui/src/client/gate-decision'
import {
  humanGateBffError, humanGateDecisionBody, humanGateUpstreamError, type OperatorSession,
} from '../../packages/dsh-research-ui/src/standalone/server'

const session: OperatorSession = {
  session_id: 'sess_real',
  principal_id: 'pi-real',
  tenant_id: null,
  auth_method: 'dsh-session',
  created_at: '2026-08-12T00:00:00.000Z',
  updated_at: '2026-08-12T00:00:00.000Z',
}

describe('Human Gate Decision BFF', () => {
  it('builds a browser request with business fields only', () => {
    const request = gateDecisionRequest('gate_a b', 'approved', 'reviewed')
    expect(request.path).toBe('/bff/research/gates/gate_a%20b/decision')
    expect(request.init.method).toBe('POST')
    expect(JSON.parse(String(request.init.body))).toEqual({ decision: 'approved', reason: 'reviewed' })
    expect(String(request.init.body)).not.toMatch(/actor|principal|session/)
  })

  it('ignores forged browser identity and injects the durable session Principal', () => {
    expect(humanGateDecisionBody({
      decision: 'approved',
      reason: 'ok',
      actor: 'evil-actor',
      principal: { principal_id: 'evil', session_id: 'sess_forged' },
      session_id: 'sess_forged',
      request_id: 'req_forged',
    }, session)).toEqual({
      decision: 'approved',
      reason: 'ok',
      principal: {
        principal_id: 'pi-real',
        tenant_id: '',
        auth_method: 'dsh-session',
        session_id: 'sess_real',
      },
    })
  })

  it('rejects malformed business payloads before the Kernel bridge', () => {
    expect(humanGateDecisionBody({ decision: 'allow' }, session)).toBeNull()
    expect(humanGateDecisionBody({ decision: 'rejected', reason: 123 }, session)).toBeNull()
    expect(humanGateDecisionBody(null, session)).toBeNull()
  })

  it('keeps a server request id on Human BFF preflight errors', () => {
    expect(humanGateBffError('req_gate_preflight', 'project_not_found', 'project not found')).toEqual({
      error: {
        code: 'project_not_found',
        message: 'project not found',
        request_id: 'req_gate_preflight',
      },
    })
  })

  it('redacts unknown upstream 5xx messages while preserving safe 4xx domain errors', () => {
    const canary = 'secret=/srv/private/kernel.db SQL=SELECT * FROM credentials'
    expect(humanGateUpstreamError('req_gate_500', 500, {
      error: { code: 'internal_error', message: canary },
    })).toEqual({
      error: { code: 'internal_error', message: 'research request failed', request_id: 'req_gate_500' },
    })
    expect(JSON.stringify(humanGateUpstreamError('req_gate_500', 500, {
      error: { code: 'internal_error', message: canary },
    }))).not.toContain(canary)
    expect(humanGateUpstreamError('req_gate_422', 422, {
      error: { code: 'validation_error', message: 'invalid gate decision' },
    })).toEqual({
      error: { code: 'validation_error', message: 'invalid gate decision', request_id: 'req_gate_422' },
    })
  })

  it('classifies identity, authorization, conflict, validation and network failures separately', () => {
    expect(gateDecisionErrorKey({ code: 'principal_required' }, 422)).toBe('overview.gateFailureIdentity')
    expect(gateDecisionErrorKey({ code: 'role_forbidden' }, 403)).toBe('overview.gateFailureRole')
    expect(gateDecisionErrorKey({ code: 'project_not_found' }, 404)).toBe('overview.gateFailureNotFound')
    expect(gateDecisionErrorKey({ code: 'gate_already_decided' }, 409)).toBe('overview.gateFailureConflict')
    expect(gateDecisionErrorKey({ code: 'validation_error' }, 422)).toBe('overview.gateFailureValidation')
    expect(gateDecisionErrorKey({ code: 'network_error' }, 0)).toBe('overview.gateFailureNetwork')
    expect(gateDecisionErrorKey({ code: 'kernel_error' }, 502)).toBe('overview.gateFailureCode')
  })
})
