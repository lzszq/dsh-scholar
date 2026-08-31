/**
 * ONBOARD-01 — Agent tool surface for Research Intake (plugin tools).
 * (research-onboarding.md §2 authoritative boundary; acceptance-tests.md §21
 * init-resume-intake-grill; hardening-v0.2-status.md §3 ONBOARD-01).
 *
 * Covers the plugin-side prepare pipeline exposed to agents:
 *   research_intake_begin / stage / scan / propose
 * and the authoritative boundary that there is NO Human answer or adopt
 * tool — only the Human PI, via the authenticated BFF/UI, may answer/adopt.
 * Also covers the ACL (unknown
 * agent role=none deny on every intake write tool; the researcher/scholar
 * role allowed), and the stable error-code copy mapping (same machine codes
 * as the kernel, stable agent-facing text).
 */
import { describe, expect, it } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ResearchKernel } from '@dsh-scholar/research-kernel'
import { startKernelServer } from '../../packages/research-kernel/lib/server.js'
import { ResearchClient } from '@dsh-scholar/research-client'
import { INTAKE_ERROR_CODES } from '@dsh-scholar/research-schemas'
import { registerResearchTools, INTAKE_ERROR_COPY, intakeErrorText, INTAKE_MAX_FILE_BYTES, type ResearchToolContext } from '../../src/plugin/tools.js'
import { RoleRegistry, RESEARCH_TOOLS, ROLE_TOOLS, DEFAULT_ROLE, type ResearchRole } from '../../src/plugin/acl.js'

/** The prepare-only intake tool names (the Agent surface, no adopt). */
const INTAKE_TOOL_NAMES = [
  'research_intake_begin',
  'research_intake_stage',
  'research_intake_scan',
  'research_intake_propose',
] as const

function makeBrief() {
  return {
    problem: 'p', scope: 's', questions: [], primary_metrics: ['m'],
    resources: '', risks: [], target_outputs: ['paper'], target_venue: null,
    baseline_repo: null, domain: 'ml',
  }
}

function freshKernel(): ResearchKernel {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-intake-tools-'))
  return new ResearchKernel({ dbPath: join(dir, 'kernel.db'), casRoot: join(dir, 'cas'), requireSignedManifest: false })
}

/** Register the real plugin tools against the given client + roles; returns
 *  the registered defs (name/description/execute) for direct execution. */
function registerTools(client: ResearchClient, roles: RoleRegistry): Array<{ name: string; description: string; execute(args: Record<string, unknown>, exec: { agent?: { id?: string }; signal: AbortSignal }): Promise<Record<string, unknown>> }> {
  const registered: Array<{ name: string; description: string; execute(args: Record<string, unknown>, exec: { agent?: { id?: string }; signal: AbortSignal }): Promise<Record<string, unknown>> }> = []
  const cache = { get: async () => undefined, set: async () => undefined }
  const toolCtx = {
    client,
    cache,
    ctx: {},
    roles,
    modelFor: () => undefined,
  } as unknown as ResearchToolContext
  registerResearchTools({ tools: { register: t => registered.push(t as never) } }, toolCtx)
  return registered
}

/** Replica of the tools/pre-execute listener in src/plugin/index.ts (1:1). */
function preExecute(roles: RoleRegistry, exec: { agent?: { id?: string }; name: string }, next: () => Promise<unknown>): Promise<unknown> {
  const researchToolSet = new Set<string>(RESEARCH_TOOLS)
  const agentId = exec.agent?.id
  if (agentId !== undefined && researchToolSet.has(exec.name)) {
    const role = roles.get(agentId)
    if (!roles.allows(role, exec.name)) {
      return Promise.resolve({ kind: 'deny', reason: `research tool ${exec.name} is outside the ${role} role's tool surface (least privilege, design §4.1)` })
    }
  }
  return next()
}

const run = async (roles: RoleRegistry, agentId: string | undefined, tool: string): Promise<'deny' | 'allow'> => {
  let calledNext = false
  const result = await preExecute(
    roles,
    { agent: agentId === undefined ? undefined : { id: agentId }, name: tool },
    async () => { calledNext = true; return 'NEXT' },
  )
  return result?.kind === 'deny' ? 'deny' : calledNext ? 'allow' : 'other'
}

async function withServer(kernel: ResearchKernel, fn: (base: string) => Promise<void>): Promise<void> {
  const { server, port } = await startKernelServer({ kernel, host: '127.0.0.1', port: 0 })
  try {
    await fn(`http://127.0.0.1:${port}`)
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()))
  }
}

/** All REQUIRED questions answered (deterministic defaults). */
function requiredAnswers(questions: Array<{ question_code: string; required: boolean; question_revision: number }>, phase = 'experiment'): Array<{ question_code: string; answer: string; question_revision: number }> {
  return questions.filter(q => q.required).map(q => ({
    question_code: q.question_code,
    answer: q.question_code === 'observed_phase_claim' ? phase : 'yes',
    question_revision: q.question_revision,
  }))
}

describe('ONBOARD-01 agent tool registration (research-onboarding.md §2)', () => {
  it('registers four prepare tools and no Human answer/adopt tool', () => {
    const client = { getProjectBySession: async () => null } as unknown as ResearchClient
    const registered = registerTools(client, new RoleRegistry())
    const names = registered.map(t => t.name)
    for (const name of INTAKE_TOOL_NAMES) {
      expect(names).toContain(name)
      expect(RESEARCH_TOOLS).toContain(name)
    }
    // The authoritative boundary: no accept/adopt tool exists anywhere.
    expect(names).not.toContain('research_intake_adopt')
    expect(names).not.toContain('research_intake_accept')
    expect(names).not.toContain('research_intake_answers')
    expect(RESEARCH_TOOLS).not.toContain('research_intake_adopt')
    expect(RESEARCH_TOOLS).not.toContain('research_intake_answers')
    expect(names.some(n => /intake.*(adopt|accept)/.test(n))).toBe(false)
  })

  it('describes every intake tool as PREPARE-ONLY with the PI-adopts note', () => {
    const client = { getProjectBySession: async () => null } as unknown as ResearchClient
    const registered = registerTools(client, new RoleRegistry())
    for (const name of INTAKE_TOOL_NAMES) {
      const tool = registered.find(t => t.name === name)
      expect(tool, `tool ${name} registered`).toBeDefined()
      const desc = tool?.description ?? ''
      expect(desc.toLowerCase()).toContain('prepare-only')
      expect(desc).toMatch(/PI|human/i)
      expect(desc).toMatch(/adopt/i)
    }
  })

  it('provides stable copy for every documented intake error code', () => {
    for (const code of INTAKE_ERROR_CODES) {
      expect(INTAKE_ERROR_COPY[code], `stable copy for ${code}`).toBeDefined()
      expect(INTAKE_ERROR_COPY[code]).not.toBe('')
    }
    // The tools' own guard codes are covered too.
    for (const code of ['principal_required', 'payload_too_large', 'invalid_file_name', 'idempotency_conflict', 'project_not_found']) {
      expect(INTAKE_ERROR_COPY[code]).toBeDefined()
    }
    // Fallback keeps the raw message for unknown codes.
    expect(intakeErrorText('some_unknown_code', 'raw detail')).toBe('raw detail')
    expect(INTAKE_MAX_FILE_BYTES).toBe(32 * 1024 * 1024)
  })
})

describe('ONBOARD-01 intake tool ACL (unknown=none deny, researcher allowed)', () => {
  it('denies every intake tool to unknown/unregistered agents (role none)', async () => {
    const roles = new RoleRegistry()
    // The four intake tools are write tools: role=none must be denied on each.
    for (const name of INTAKE_TOOL_NAMES) {
      expect(roles.allows(DEFAULT_ROLE, name), `${name} denied for none`).toBe(false)
    }
    // Through the pre-execute waterfall (agent session unknown → none).
    for (const name of INTAKE_TOOL_NAMES) {
      expect(await run(roles, 'some-unknown-agent', name)).toBe('deny')
    }
  })

  it('allows the researcher (scholar) role on begin/stage/scan/propose only', async () => {
    const roles = new RoleRegistry()
    roles.set('researcher-session', 'scholar')
    for (const name of INTAKE_TOOL_NAMES) {
      expect(roles.allows('scholar', name), `scholar allowed ${name}`).toBe(true)
      expect(ROLE_TOOLS.scholar).toContain(name)
      expect(await run(roles, 'researcher-session', name)).toBe('allow')
    }
    // No role has an adopt tool surface (nothing to allow, nothing to deny).
    for (const role of Object.keys(ROLE_TOOLS) as ResearchRole[]) {
      expect(ROLE_TOOLS[role]).not.toContain('research_intake_adopt')
      expect(ROLE_TOOLS[role]).not.toContain('research_intake_answers')
    }
  })

  it('keeps intake tools out of unrelated role surfaces and agent-less calls pass through', async () => {
    const roles = new RoleRegistry()
    for (const name of INTAKE_TOOL_NAMES) {
      expect(roles.allows('writer', name)).toBe(false)
      expect(roles.allows('operator', name)).toBe(false)
      expect(roles.allows('director', name)).toBe(false)
    }
    // Agent-less calls are not restricted by the ACL (tool-layer semantics).
    expect(await run(roles, undefined, 'research_intake_begin')).toBe('allow')
  })
})

describe('ONBOARD-01 intake tools end-to-end (real kernel + ResearchClient)', () => {
  it('begin (idempotent) → stage → scan → trusted Human answer → agent propose; no Human tool', async () => {
    const kernel = freshKernel()
    const project = kernel.createProject({
      name: 't',
      workspace: '/w',
      brief: makeBrief(),
      session_id: 'researcher-session',
      creator_principal_id: 'researcher-session',
    })
    await withServer(kernel, async (base) => {
      const client = new ResearchClient({ endpoint: base })
      const roles = new RoleRegistry()
      roles.set('researcher-session', 'scholar')
      const registered = registerTools(client, roles)
      const tool = (name: string) => {
        const t = registered.find(x => x.name === name)
        if (t === undefined) throw new Error(`tool ${name} not registered`)
        return t
      }
      const exec = (name: string, args: Record<string, unknown>) =>
        tool(name).execute(args, { agent: { id: 'researcher-session' }, signal: new AbortController().signal })

      // begin: creates the intake session; the second begin recovers the SAME
      // active session (one active intake per project — idempotent).
      const b1 = await exec('research_intake_begin', { source_label: 'uploaded-paper', target_phase: 'experiment' })
      expect(b1.ok).toBe(true)
      expect(b1.intake.intake_id).toMatch(/^intk_/)
      expect(b1.intake.status).toBe('draft')
      expect(String(b1.note)).toMatch(/PI/)
      const b2 = await exec('research_intake_begin', { source_label: 'uploaded-paper', target_phase: 'experiment' })
      expect(b2.intake.intake_id).toBe(b1.intake.intake_id)

      // stage: base64 bytes → isolated intake staging CAS (no artifact row).
      const staged = await exec('research_intake_stage', {
        intake_id: b1.intake.intake_id,
        file_name: 'paper.pdf',
        content_base64: Buffer.from('%PDF-1.4').toString('base64'),
        media_type: 'application/pdf',
      })
      expect(staged.ok).toBe(true)
      expect(staged.artifact.quarantine).toBe('staged')
      expect(staged.artifact.file_name).toBe('paper.pdf')

      // scan: deterministic static scan → needs_input with questions.
      const scanned = await exec('research_intake_scan', { intake_id: b1.intake.intake_id })
      expect(scanned.ok).toBe(true)
      expect(scanned.status).toBe('needs_input')
      expect(scanned.artifacts[0].quarantine).toBe('clean')
      expect(Array.isArray(scanned.questions)).toBe(true)

      expect(registered.some(t => t.name === 'research_intake_answers')).toBe(false)
      // Unit setup stands in for the separately tested trusted Human BFF
      // boundary; the Agent surface cannot perform this write.
      kernel.submitIntakeAnswers(
        b1.intake.intake_id,
        requiredAnswers(scanned.questions),
        { principal_id: 'human-test', auth_method: 'dsh-session', session_id: 'human-session' },
      )

      // propose: deterministic PhaseProposal; DRAFT safe status (the kernel
      // state machine never fabricates approved gates).
      const proposed = await exec('research_intake_propose', { intake_id: b1.intake.intake_id })
      expect(proposed.ok).toBe(true)
      expect(proposed.proposal.observed_phase).toBe('experiment')
      expect(proposed.proposal.safe_project_status).toBe('DRAFT')
      expect(proposed.proposal.revision).toBeGreaterThanOrEqual(1)
      expect(String(proposed.note)).toMatch(/PI|human/i)

      // The intake now waits for the Human PI — there is no adopt tool to
      // advance it from the agent surface.
      expect(registered.some(t => t.name === 'research_intake_adopt')).toBe(false)
    })
    kernel.close()
  })

  it('rejects a >32 MiB base64 stage client-side with the stable copy', async () => {
    const kernel = freshKernel()
    const project = kernel.createProject({ name: 't', workspace: '/w', brief: makeBrief() })
    await withServer(kernel, async (base) => {
      const client = new ResearchClient({ endpoint: base })
      const registered = registerTools(client, new RoleRegistry())
      const exec = (name: string, args: Record<string, unknown>) =>
        registered.find(x => x.name === name)!.execute(args, { agent: { id: 'researcher-session' }, signal: new AbortController().signal })
      const b = await exec('research_intake_begin', { project_id: project.project_id, source_label: 's', target_phase: 'brief' })
      await expect(exec('research_intake_stage', {
        project_id: project.project_id,
        intake_id: b.intake.intake_id,
        file_name: 'big.pdf',
        content_base64: Buffer.alloc(INTAKE_MAX_FILE_BYTES + 1, 1).toString('base64'),
      })).rejects.toThrow('intake payload_too_large: file exceeds the 32 MiB limit')
    })
    kernel.close()
  })
})

describe('ONBOARD-01 intake tools stable error-code copy', () => {
  it('maps intake_not_found, question_required and question_revision_conflict to stable copy', async () => {
    const kernel = freshKernel()
    const project = kernel.createProject({
      name: 't',
      workspace: '/w',
      brief: makeBrief(),
      session_id: 'researcher-session',
      creator_principal_id: 'researcher-session',
    })
    await withServer(kernel, async (base) => {
      const client = new ResearchClient({ endpoint: base })
      const registered = registerTools(client, new RoleRegistry())
      const exec = (name: string, args: Record<string, unknown>) =>
        registered.find(x => x.name === name)!.execute(args, { agent: { id: 'researcher-session' }, signal: new AbortController().signal })

      // Unknown intake → stable intake_not_found copy (cross-project 404).
      await expect(exec('research_intake_scan', { intake_id: 'intk_nope' }))
        .rejects.toThrow(`intake intake_not_found: ${INTAKE_ERROR_COPY.intake_not_found}`)

      const b = await exec('research_intake_begin', { source_label: 's', target_phase: 'experiment' })
      await exec('research_intake_stage', {
        intake_id: b.intake.intake_id,
        file_name: 'run.log',
        content_base64: Buffer.from('epoch=1 loss=0.1\n').toString('base64'),
        media_type: 'text/plain',
      })
      await exec('research_intake_scan', { intake_id: b.intake.intake_id })

      // Propose before answering → stable question_required copy.
      await expect(exec('research_intake_propose', { intake_id: b.intake.intake_id }))
        .rejects.toThrow(`intake question_required: ${INTAKE_ERROR_COPY.question_required}`)

      expect(registered.some(tool => tool.name === 'research_intake_answers')).toBe(false)
    })
    kernel.close()
  })
})
