#!/usr/bin/env bash
# acceptance-tests.md §9 (DSH integration) + §17 (tool schema / canonical
# names): the research plugin's tool catalog, ACL, direct slash-command
# handlers, headless tools and skill provider resolution.
#
#   1. Tool catalog == reconstruction-contracts.md §17 canonical registry
#      (41 canonical names incl. dsh_scholar, session-bound methodology and
#      the ONBOARD-01 prepare surface);
#      removed claim_verify/analysis_build/release_bundle names stay absent.
#   2. No Human Decision / gate-decision tool exists; no intake adopt/accept
#      tool exists (research-onboarding.md §2.1 — Agent has no accept); ACL
#      denies unknown and unauthorized agents on every research write tool.
#   3. Tools work headless (no httpServer): registration + execution through
#      the kernel client/cache only.
#   4. /help|/list|/status|/gates|/jobs|/claims|/new|... are direct
#      descriptors with real handlers; the aggregate descriptor is absent.
#   5. Skill provider resolves the four groups from the PACKAGE ROOT skills/
#      (never lib/skills) and Brief -> domain/venue selection is deterministic;
#      npm pack ships the runtime skill assets.
#
# Usage: bash tests/security/run-dsh-plugin-tests.sh
set -eu

REPO=$(cd "$(dirname "$0")/../.." && pwd)
PLUGIN_LIB="$REPO/lib/plugin"
KERNEL_BIN="$REPO/packages/research-kernel/lib/bin/kernel.js"
if [ ! -f "$PLUGIN_LIB/tools.js" ]; then
  echo "dsh-plugin: plugin not built — run pnpm run build:plugin first" >&2
  exit 2
fi
if [ ! -f "$KERNEL_BIN" ]; then
  echo "dsh-plugin: research kernel not built — run pnpm --filter @dsh-scholar/research-kernel build first" >&2
  exit 2
fi

PASS=0
FAIL=0
say() { printf '\033[1;34m== %s ==\033[0m\n' "$*"; }
ok()  { printf '  ok: %s\n' "$*"; PASS=$((PASS + 1)); }
bad() { printf '  FAIL: %s\n' "$*"; FAIL=$((FAIL + 1)); }
jnode() { node --input-type=module "$@"; }
# probe <json> <js-expression>: exits 0 when the expression is truthy
probe() { printf '%s' "$1" | jnode -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{const j=JSON.parse(d);if(!($2))process.exit(1)})" > /dev/null 2>&1; }

WORK=$(mktemp -d)
KERNEL_PID=""
cleanup() {
  [ -n "$KERNEL_PID" ] && kill -9 "$KERNEL_PID" 2>/dev/null || true
  wait "$KERNEL_PID" 2>/dev/null || true
  rm -rf "$WORK"
}
trap cleanup EXIT

# ── §17: canonical-only catalog + ACL + headless tools ────────────────────
say "canonical-only tool catalog / ACL / headless"
CATALOG=$(jnode - "$REPO" <<'EOF'
const repo = process.argv[2]
const { registerResearchTools } = await import(`${repo}/lib/plugin/tools.js`)
const { RoleRegistry, RESEARCH_TOOLS, ROLE_TOOLS, DEFAULT_ROLE } = await import(`${repo}/lib/plugin/acl.js`)

const CANONICAL = [
  'dsh_scholar',
  'research_project', 'research_phase', 'research_gate_request', 'research_budget',
  'research_status', 'literature_search', 'paper_resolve', 'corpus_snapshot',
  'research_methodology_status', 'research_assurance_run', 'research_protocol_record', 'research_synthesis_record',
  'research_writing_review_record', 'research_knowledge_activate', 'research_knowledge_deactivate',
  'passage_lookup', 'research_panel', 'idea_create', 'idea_compare', 'novelty_audit',
  'workspace_snapshot', 'patch_apply', 'baseline_prepare', 'test_run', 'baseline_verify',
  'experiment_register', 'experiment_submit', 'experiment_status', 'experiment_cancel',
  'evidence_note_create', 'claim_create', 'claim_verify_request', 'analysis_request',
  'manuscript_build', 'manuscript_review', 'release_bundle_request',
  // ONBOARD-01 intake prepare surface (research-onboarding.md §2): agents
  // begin/stage/scan/propose; Human answers/adopt are not Agent tools.
  'research_intake_begin', 'research_intake_stage', 'research_intake_scan',
  'research_intake_propose',
]
if (CANONICAL.length !== 41) throw new Error(`§17 registry has ${CANONICAL.length} entries, expected 41`)

const registered = []
// Tool defs capture `client` at registration time; one registration serves
// all probes. getProjectBySession is session-aware: only the headless probe
// session resolves to a project.
const stubClient = {
  getProjectBySession: async (sid) => sid === 'headless-session' ? { project_id: 'rsp_headless' } : null,
  projectProjection: async () => ({ project: { status: 'DRAFT' }, counts: { claims: 0 } }),
  verifyClaim: async () => ({ claim_id: 'claim_x', status: 'supported' }),
  createProject: async () => ({ project_id: 'rsp_x', brief: { domain: 'machine-learning', target_venue: null } }),
  // ONBOARD-01 intake prepare surface (headless probes below).
  beginIntake: async (projectId) => ({ intake_id: 'intk_headless', project_id: projectId, source_label: 'headless', status: 'draft' }),
}
const stubCache = { get: async () => undefined, set: async () => undefined }
const roles = new RoleRegistry()
registerResearchTools({ tools: { register: t => registered.push(t) } },
  { client: stubClient, cache: stubCache, ctx: {}, roles, modelFor: () => undefined })

const names = registered.map(t => t.name)
const problems = []

// 1. every §17 canonical name is registered
for (const c of CANONICAL) if (!names.includes(c)) problems.push(`missing canonical tool ${c}`)

// 2. obsolete names are absent: callers must use the canonical contract.
for (const obsolete of ['claim_verify', 'analysis_build', 'release_bundle']) {
  if (names.includes(obsolete)) problems.push(`obsolete tool ${obsolete} must not be registered`)
}

// 3. no Human Decision / gate-decision tool exists
const gateDecision = names.filter(n => /gate.*(decide|decision|approve)|(decide|decision).*gate/.test(n))
if (gateDecision.length > 0) problems.push(`gate-decision tools must not exist: ${gateDecision.join(',')}`)
const gateTool = registered.find(x => x.name === 'research_gate_request')
if (gateTool !== undefined) {
  const actions = gateTool.parameters?.properties?.action?.enum ?? []
  if (actions.some(a => String(a) === 'decide')) problems.push('research_gate_request must not expose action=decide')
}
const assuranceTool = registered.find(x => x.name === 'research_assurance_run')
if (assuranceTool === undefined) problems.push('research_assurance_run must be registered')
if (Object.prototype.hasOwnProperty.call(assuranceTool?.parameters?.properties ?? {}, 'project_id')) {
  problems.push('research_assurance_run must derive project scope from the exact DSH session')
}
// 3b. ONBOARD-01 (research-onboarding.md §2.1): the Agent has NO accept —
//     no adopt tool exists and every intake tool is prepare-only copy.
const intakeNames = names.filter(n => n.startsWith('research_intake'))
if (intakeNames.length !== 4) problems.push(`expected exactly 4 intake tools, got ${intakeNames.length}`)
if (intakeNames.some(n => /adopt|accept/.test(n))) problems.push(`adopt/accept intake tools must not exist: ${intakeNames.join(',')}`)
for (const n of intakeNames) {
  const t = registered.find(x => x.name === n)
  const desc = String(t?.description ?? '')
  if (!/prepare-only/i.test(desc)) problems.push(`${n} description lacks PREPARE-ONLY marker`)
  if (!/PI|human/i.test(desc)) problems.push(`${n} description lacks the PI-adopts note`)
}
// 4. ACL surface is canonical-only.
for (const n of names) if (!RESEARCH_TOOLS.includes(n)) problems.push(`RESEARCH_TOOLS missing ${n}`)
for (const c of CANONICAL) if (!RESEARCH_TOOLS.includes(c)) problems.push(`RESEARCH_TOOLS missing canonical ${c}`)
for (const role of Object.keys(ROLE_TOOLS)) {
  for (const t of ROLE_TOOLS[role]) {
    if (!CANONICAL.includes(t)) problems.push(`ROLE_TOOLS[${role}] has non-canonical ${t}`)
  }
}
// 4b. intake ACL: unknown/none denied on every intake tool; the researcher
//     (scholar) role may prepare (begin/stage/scan/propose); Human answers and
//     adoption remain on the trusted BFF boundary and no accept exists in
//     any role surface.
for (const n of intakeNames) {
  if (roles.allows(DEFAULT_ROLE, n)) problems.push(`unknown agent may call ${n}`)
  if (!roles.allows('scholar', n)) problems.push(`scholar (researcher) denied on ${n}`)
  if (roles.allows('writer', n)) problems.push(`writer must not call ${n}`)
}
for (const role of Object.keys(ROLE_TOOLS)) {
  if (ROLE_TOOLS[role].includes('research_intake_adopt')) problems.push(`ROLE_TOOLS[${role}] must not contain an adopt tool`)
}
// 5. unknown/root DSH Agent gets the bounded native-chat façade plus the
//    exact-session methodology surface; no arbitrary-project capability.
const rootTools = new Set(['dsh_scholar', 'research_methodology_status', 'research_protocol_record',
  'research_synthesis_record', 'research_writing_review_record', 'research_knowledge_activate', 'research_knowledge_deactivate', 'research_assurance_run'])
for (const n of names) {
  const allowed = roles.allows(DEFAULT_ROLE, n)
  if (rootTools.has(n) ? !allowed : allowed) problems.push(`unknown agent ACL mismatch on ${n}`)
}
if (roles.get('some-unknown-session') !== 'none') problems.push('unknown session role must be none')
if (roles.allows('writer', 'claim_verify_request')) problems.push('writer must not verify claims')
if (!roles.allows('statistician', 'claim_verify_request')) problems.push('statistician must verify claims')
if (roles.allows('statistician', 'claim_verify')) problems.push('obsolete claim_verify must be denied')
if (roles.allows('reviewer', 'analysis_request')) problems.push('reviewer must not run analysis_request')

// 6. headless: no httpServer anywhere — execute through kernel client/cache.
const statusTool = registered.find(x => x.name === 'research_status')
const headless = await statusTool.execute({}, { agent: { id: 'headless-session' }, signal: new AbortController().signal })
if (headless.ok !== true) problems.push('headless research_status execution failed')

// 7. intake tools run headless (no httpServer): research_intake_begin
//    resolves the session project and calls the stub beginIntake.
const intakeBeginTool = registered.find(x => x.name === 'research_intake_begin')
const intakeResult = await intakeBeginTool.execute(
  { source_label: 'headless-paper' },
  { agent: { id: 'headless-session' }, signal: new AbortController().signal })
if (intakeResult.ok !== true) problems.push('headless research_intake_begin execution failed')
if (intakeResult.intake?.intake_id !== 'intk_headless') problems.push('headless research_intake_begin did not reach the client beginIntake')

console.log(JSON.stringify({ names, problems }))
EOF
)

NAMES=$(printf '%s' "$CATALOG" | jnode -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>console.log(JSON.parse(d).names.join(',')))")
PROBLEMS=$(printf '%s' "$CATALOG" | jnode -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>console.log(JSON.parse(d).problems.join('|')))")
if [ -z "$PROBLEMS" ]; then
  ok "all 41 §17 canonical tools registered; obsolete names absent; ACL consistent"
else
  bad "catalog/ACL problems: $PROBLEMS"
fi
for C in claim_verify_request analysis_request release_bundle_request research_project research_gate_request research_budget research_intake_begin research_intake_stage research_intake_scan research_intake_propose; do
  case ",$NAMES," in
    *",$C,"*) ok "canonical tool $C registered" ;;
    *) bad "canonical tool $C missing" ;;
  esac
done
for A in claim_verify analysis_build release_bundle research_intake_answers; do
  case ",$NAMES," in
    *",$A,"*) bad "obsolete tool $A is still registered" ;;
    *) ok "obsolete tool $A absent" ;;
  esac
done
case ",$NAMES," in
  *",research_gate,"*|*",research_gate_decide,"*|*",gate_decide,"*) bad "gate-decision tool present in catalog" ;;
  *) ok "no gate-decision tool in catalog" ;;
esac
case ",$NAMES," in
  *",research_intake_adopt,"*|*",research_intake_accept,"*) bad "intake adopt/accept tool present in catalog (Agent has no accept)" ;;
  *) ok "no intake adopt/accept tool in catalog (research-onboarding §2.1)" ;;
esac
if probe "$CATALOG" "j.names.filter(n=>n.startsWith('research_intake')).length === 4"; then
  ok "exactly 4 intake prepare tools registered (begin/stage/scan/propose)"
else
  bad "intake prepare tool count wrong"
fi
if probe "$CATALOG" "!j.problems.some(p=>/unknown agent ACL mismatch/.test(p))"; then
  ok "unknown/root DSH Agent limited to the façade and exact-session methodology tools"
else
  bad "unknown agent ACL leak"
fi
if probe "$CATALOG" "!j.problems.some(p=>/headless/.test(p))"; then
  ok "research tools execute headless (no httpServer)"
else
  bad "headless execution failed"
fi
if probe "$CATALOG" "!j.problems.some(p=>/PREPARE-ONLY|intake tools|intake ACL|headless research_intake/.test(p))"; then
  ok "intake tools: prepare-only copy, ACL (none deny / scholar allow), headless begin all pass"
else
  bad "intake tool surface: $(printf '%s' "$CATALOG" | jnode -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>console.log(JSON.parse(d).problems.filter(p=>/PREPARE-ONLY|intake/.test(p)).join('|')))")"
fi

# ── §9 DSH-01: unknown Agent ACL deny + pre-execute semantics + disposer ─────
# Isolated fixture: unknown/unregistered agent ids resolve to role 'none'
# (DEFAULT_ROLE) and every research write tool is denied; known roles keep
# their documented surface (director = PI); agent-less calls pass through
# (tool-layer semantics); the plugin's ctx.effect disposer stops the sidecar.
say "DSH-01: unknown-agent deny / pre-execute waterfall / plugin disposer"
DSH01=$(jnode - "$REPO" <<'EOF'
const repo = process.argv[2]
const { DSH_SESSION_METHODOLOGY_TOOLS, RESEARCH_HUMAN_CONFIRMATION_TOOLS, RoleRegistry, RESEARCH_TOOLS, DEFAULT_ROLE, ROLE_TOOLS } = await import(`${repo}/lib/plugin/acl.js`)
const { apply, KernelSidecar } = await import(`${repo}/lib/plugin/index.js`)
const { ResearchClient } = await import(`${repo}/packages/research-client/lib/index.js`)

const problems = []

// 1. DEFAULT_ROLE = none; unknown sessions resolve to none; none has only the
//    bounded façade plus exact-session methodology tools.
if (DEFAULT_ROLE !== 'none') problems.push('DEFAULT_ROLE must be none')
const roles = new RoleRegistry()
if (roles.get('some-unknown-agent-42') !== 'none') problems.push('unknown session role must resolve to none')
const rootTools = new Set(['dsh_scholar', ...DSH_SESSION_METHODOLOGY_TOOLS])
if (ROLE_TOOLS.none.length !== rootTools.size || ROLE_TOOLS.none.some(tool => !rootTools.has(tool))) problems.push('none role surface contains an unbounded tool')
for (const tool of RESEARCH_TOOLS) {
  const allowed = roles.allows(DEFAULT_ROLE, tool)
  if (rootTools.has(tool) ? !allowed : allowed) problems.push(`unknown agent ACL mismatch on ${tool}`)
}
if (!RESEARCH_HUMAN_CONFIRMATION_TOOLS.includes('research_knowledge_activate')) problems.push('Knowledge activation must require Host confirmation')
if (!RESEARCH_HUMAN_CONFIRMATION_TOOLS.includes('research_knowledge_deactivate')) problems.push('Knowledge deactivation must require Host confirmation')
if (!RESEARCH_HUMAN_CONFIRMATION_TOOLS.includes('research_assurance_run')) problems.push('Assurance execution must require Host confirmation')

// 2. pre-execute waterfall replicated 1:1 from src/plugin/index.ts (the
//    tools/pre-execute listener): agent-id calls on research tools go
//    through RoleRegistry.allows and are denied outside the role surface;
//    agent-less calls and non-research tools pass through to next().
const researchToolSet = new Set(RESEARCH_TOOLS)
const humanConfirmationToolSet = new Set(RESEARCH_HUMAN_CONFIRMATION_TOOLS)
const preExecute = async (exec, next) => {
  const agentId = exec.agent?.id
  if (agentId !== undefined && researchToolSet.has(exec.name)) {
    const role = roles.get(agentId)
    if (!roles.allows(role, exec.name)) {
      return { kind: 'deny', reason: `research tool ${exec.name} is outside the ${role} role's tool surface` }
    }
    if (humanConfirmationToolSet.has(exec.name)) return { kind: 'ask', reason: 'Human confirmation required' }
  }
  return next()
}
const run = async (agentId, tool) => {
  let calledNext = false
  const result = await preExecute(
    { agent: agentId === undefined ? undefined : { id: agentId }, name: tool },
    () => { calledNext = true; return 'NEXT' },
  )
  return result?.kind === 'deny' ? 'deny' : calledNext ? 'allow' : 'other'
}

// unknown/root Agent: façade + exact-session methodology tools allowed;
// Knowledge activation and Assurance execution pause for explicit Host confirmation.
for (const tool of RESEARCH_TOOLS) {
  const outcome = await run('unknown-agent-abc', tool)
  const expected = humanConfirmationToolSet.has(tool) ? 'other' : rootTools.has(tool) ? 'allow' : 'deny'
  if (outcome !== expected) problems.push(`unknown agent ACL mismatch on ${tool}: got ${outcome}, expected ${expected}`)
}
// known role (director = the PI surface, docs/dsh-integration.md §4):
// every canonical tool in its surface is allowed.
roles.set('pi-session', 'director')
for (const tool of ROLE_TOOLS.director) {
  const expected = humanConfirmationToolSet.has(tool) ? 'other' : 'allow'
  if (await run('pi-session', tool) !== expected) problems.push(`director denied on ${tool}`)
}
if (await run('pi-session', 'claim_verify') !== 'allow') problems.push('non-registered tools must pass through this plugin ACL')
// statistician: claim_verify_request allowed; project creation denied.
roles.set('stat-session', 'statistician')
if (await run('stat-session', 'claim_verify_request') !== 'allow') problems.push('statistician denied claim_verify_request')
if (await run('stat-session', 'research_project') !== 'deny') problems.push('statistician must not create projects')
// writer: manuscript_build allowed; research writes denied.
roles.set('writer-session', 'writer')
if (await run('writer-session', 'manuscript_build') !== 'allow') problems.push('writer denied manuscript_build')
if (await run('writer-session', 'research_project') !== 'deny') problems.push('writer must not create projects')
// no agent id: tool-layer semantics — ACL never restricts agent-less calls.
if (await run(undefined, 'research_project') !== 'allow') problems.push('agent-less call must pass through the ACL')
if (await run(undefined, 'claim_verify_request') !== 'allow') problems.push('agent-less claim_verify_request must pass through')
// non-research tools are outside the ACL surface.
if (await run('unknown-agent-abc', 'web_fetch') !== 'allow') problems.push('non-research tool must pass through')

// 3. register disposer: apply() registers ctx.effect -> sidecar.stop();
//    a simulated dispose must invoke it (acceptance §9 "插件停止清理
//    tool/listener/sidecar ownership").
let startCalled = 0
let stopCalled = 0
const origStart = KernelSidecar.prototype.start
const origStop = KernelSidecar.prototype.stop
const origReconcileNative = ResearchClient.prototype.reconcileNativeKnowledgePacks
KernelSidecar.prototype.start = async function () { startCalled += 1 }
KernelSidecar.prototype.stop = async function () { stopCalled += 1 }
ResearchClient.prototype.reconcileNativeKnowledgePacks = async function () { return { registry_revision: 6, package_names: [] } }
const cleanups = []
const ctx = {
  logger: () => ({ info() {}, error() {}, warn() {} }),
  provide() {},
  plugin: async () => ({}),
  on() {},
  effect(fn) { const d = fn(); if (typeof d === 'function') cleanups.push(d) },
  tools: { register() {} },
  commands: { register() {} },
}
try {
  // apply is ASYNC (hardening §4 row 100): Cordis awaits it, so the probe
  // must await it too — start must complete before anything is published.
  await apply(ctx, { kernel: { host: '127.0.0.1', port: 7412, dataDir: process.env.DSH01_DATA ?? '/tmp/dsh01' }, cacheDir: process.env.DSH01_CACHE ?? '/tmp/dsh01-cache' })
  if (startCalled < 1) problems.push('apply must start the kernel sidecar')
  for (const cleanup of cleanups) await cleanup()
  if (stopCalled < 1) problems.push('plugin dispose must stop the kernel sidecar (disposer missing)')
} finally {
  KernelSidecar.prototype.start = origStart
  KernelSidecar.prototype.stop = origStop
  ResearchClient.prototype.reconcileNativeKnowledgePacks = origReconcileNative
}

console.log(JSON.stringify({ problems }))
EOF
)
if [ -z "$DSH01" ]; then
  bad "DSH-01 probe script produced no output"
else
  if probe "$DSH01" "j.problems.length === 0"; then
    ok "unknown/root Agent limited to bounded DSH session tools; known roles keep their surface"
  else
    bad "DSH-01 ACL: $(printf '%s' "$DSH01" | jnode -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>console.log(JSON.parse(d).problems.join('|')))")"
  fi
  if probe "$DSH01" "!j.problems.some(p=>/unknown agent ACL mismatch/.test(p))"; then
    ok "unknown/root Agent limited to façade and exact-session methodology tools (DSH-01)"
  else
    bad "unknown-agent ACL leak"
  fi
  if probe "$DSH01" "!j.problems.some(p=>/agent-less/.test(p))"; then
    ok "agent-less tool calls pass through the ACL (tool-layer semantics)"
  else
    bad "agent-less call restricted by ACL"
  fi
  if probe "$DSH01" "!j.problems.some(p=>/dispose/.test(p))"; then
    ok "plugin disposer stops the kernel sidecar (register cleanup)"
  else
    bad "plugin disposer missing sidecar stop"
  fi
fi

# ── hardening §4 row 100: REAL cordis host fixture (minimal host) ───────────
# The DSH host itself (bundle boot) is not available in this test env, so the
# fixture boots a MINIMAL CORDIS HOST with the real cordis 4.0.0-rc.7 Context
# and the REAL @deepseek-ai ToolRuntime / CommandRuntime / SkillRegistry (the
# exact registries the plugin registers into in production). This exercises
# the REAL lifecycle machinery: async apply awaited by cordis, effect-model
# disposal of tools/commands/listeners/services/skills, and the sidecar
# disposer — no faked lifecycle. Covered here (hardening §4 row 100 closing
# conditions):
#   - port=0: apply() awaits sidecar.start(); ctx.research.endpoint is the
#     REAL bound port published in 0600 runtime/endpoint.json and the client
#     works against the real kernel (list/create/list projects);
#   - dual instances in ONE process: each instance owns its kernel/dataDir/
#     endpoint/roles/cache; tool execution resolves the RIGHT instance's
#     client (no module-level tool-context ref), roles and ACL listeners are
#     per-instance (granting a role in B never leaks into A);
#   - reload: cordis update() unloads (kills the old kernel, unregisters
#     tools) then re-applies — no duplicate registration (still exactly 41
#     tools / 1 skill provider), data persists in the same dataDir;
#   - dispose: sidecar kernel dead, endpoint.json removed, port released,
#     tools/commands/skills/pre-execute listeners all gone, the other
#     instance is unaffected; re-applying on the same root works and
#     registers exactly once again.
say "DSH-01/SIDE-01: minimal cordis host fixture (async apply / port=0 / dual instance / reload / dispose)"
HOSTFIX=$(jnode - "$REPO" <<'EOF'
const repo = process.argv[2]
const { createRequire } = await import('node:module')
const { join } = await import('node:path')
// Cordis is a DSH host peer dep; resolve the SAME module instance the
// @deepseek-ai registries use (vendor/cordis via dsh-tools' node_modules) so
// this fixture exercises the real cordis effect/lifecycle machinery.
const require = createRequire(`${repo}/node_modules/@deepseek-ai/dsh-tools/package.json`)
const { Context } = require('@deepseek-ai/cordis')
const { ToolRuntime } = await import(`${repo}/node_modules/@deepseek-ai/dsh-tools/lib/index.js`)
const { CommandRuntime } = await import(`${repo}/node_modules/@deepseek-ai/dsh-commands/lib/index.js`)
const { SkillRegistry } = await import(`${repo}/node_modules/@deepseek-ai/dsh-skill/lib/index.js`)
// Keep this fixture on the current Harness canonical provider. The former
// dsh-settings-local workspace was removed/renamed; loading the real
// dsh-settings-file provider ensures the required settings service is active.
const { default: SettingsFile } = await import(`${repo}/node_modules/@deepseek-ai/dsh-settings-file/lib/index.js`)
const pluginMod = await import(`${repo}/lib/plugin/index.js`)
const { readFileSync, mkdtempSync, rmSync, existsSync } = await import('node:fs')
const { tmpdir } = await import('node:os')

const problems = []
const tempDirs = []
const trackedPids = []
let handleA
let handleB
let handleA2
const alive = (pid) => { try { process.kill(pid, 0); return true } catch { return false } }
const terminate = (pid) => { if (!alive(pid)) return; try { process.kill(pid, 'SIGKILL') } catch { /* gone */ } }
const readEp = (dataDir) => JSON.parse(readFileSync(join(dataDir, 'runtime', 'endpoint.json'), 'utf8'))
const projectBrief = { problem: 'test problem', scope: 'test scope', questions: [], primary_metrics: [], resources: '', risks: [], target_outputs: ['conference-paper'], target_venue: null, baseline_repo: null, domain: 'machine-learning' }

/** Minimal host: real cordis root + the real DSH registries the plugin uses. */
async function makeHost(dataDir) {
  const root = new Context()
  root.provide('systemPrompt', { tools() {}, section() {} })
  await root.plugin(ToolRuntime, { mode: 'native' })
  await root.plugin(CommandRuntime)
  await root.plugin(SkillRegistry)
  await root.plugin(SettingsFile, { path: join(dataDir, 'settings.yaml'), watch: false })
  root.provide('subagents', { start: async () => { throw new Error('fixture has no subagent backend') } })
  // userQuestions is a required Host dependency: Scholar deliberately reuses
  // the native DSH question UI for Brief/Grill. A minimal host that omits it
  // leaves the plugin fiber pending and cannot assert lifecycle behavior.
  root.provide('userQuestions', { ask: async () => { throw new Error('fixture has no interactive question backend') } })
  return root
}

/** Dispatch tools/pre-execute the way dsh-tools does (waterfall + next). */
async function runAcl(root, agentId, tool) {
  let nextCalled = false
  const result = await root.waterfall('tools/pre-execute', { name: tool, agent: { id: agentId } },
    async () => { nextCalled = true; return 'NEXT' })
  return result?.kind === 'deny' ? 'deny' : nextCalled ? 'allow' : 'other'
}

try {
  const dirA = mkdtempSync(join(tmpdir(), 'dsh-hostfix-a-'))
  const dirB = mkdtempSync(join(tmpdir(), 'dsh-hostfix-b-'))
  tempDirs.push(dirA, dirB)
  const cfgA = { kernel: { host: '127.0.0.1', port: 0, dataDir: dirA }, unattended: true }
  const cfgB = { kernel: { host: '127.0.0.1', port: 0, dataDir: dirB }, unattended: true }
  const rootA = await makeHost(dirA)
  const rootB = await makeHost(dirB)

  // ── apply A and B (async apply is awaited by cordis) ─────────────────────
  handleA = await rootA.plugin(pluginMod, cfgA)
  handleB = await rootB.plugin(pluginMod, cfgB)

  // ── port=0: endpoint is the REAL bound port, client usable ───────────────
  const epA = new URL(rootA.research.endpoint)
  const epB = new URL(rootB.research.endpoint)
  const epFileA = readEp(dirA)
  const epFileB = readEp(dirB)
  trackedPids.push(epFileA.pid, epFileB.pid)
  if (!(Number(epA.port) > 0 && Number(epA.port) === epFileA.port)) problems.push('port0 endpoint A not resolved from runtime/endpoint.json')
  if (!(Number(epB.port) > 0 && Number(epB.port) === epFileB.port)) problems.push('port0 endpoint B not resolved from runtime/endpoint.json')
  if (epA.origin === epB.origin) problems.push('dual instance endpoints must differ (port=0)')
  if (epFileA.pid === epFileB.pid) problems.push('dual instance kernels must be distinct processes')
  if (rootA.research.client.endpoint !== epA.origin) problems.push('client endpoint must be the resolved real port')
  // This lifecycle probe needs durable data, not a DSH session authority.
  // Session binding is exercised below through the authenticated internal
  // create/link route; a generic create must never invent an unauthenticated
  // session link merely to seed the fixture.
  const projA = await rootA.research.client.createProject({
    name: 'proj-a', workspace: '/research/proj-a', brief: projectBrief,
    creator_principal_id: 'fixture:cordis-a',
  })
  if ((await rootA.research.client.listProjects()).length < 1) problems.push('client not usable against the real kernel after start (instance A)')

  // ── tools / commands / skills registered exactly once ────────────────────
  const toolsA = rootA.tools.schemas().map(s => s.name)
  if (toolsA.length !== 41) problems.push(`instance A tool count ${toolsA.length} != 41`)
  if (rootA.tools.get('research_project') === undefined) problems.push('research_project tool not registered')
  const expectedCommands = ['help','new','list','status','gates','jobs','claims','survey','ideas','reproduce','contract','run','evidence','write','review','release-bundle','release']
  const registeredCommands = rootA.commands.list({}).map(c => c.name).sort()
  if (registeredCommands.join(',') !== expectedCommands.slice().sort().join(',')) problems.push(`direct command descriptors mismatch: ${registeredCommands.join(',')}`)
  if (registeredCommands.includes('research')) problems.push('aggregate research descriptor must not be registered')
  const skillNamesA = (await rootA.skills.list()).map(skill => skill.name)
  if (skillNamesA.length !== 4) problems.push(`instance A research skills ${skillNamesA.length} != 4`)

  // ── dual-instance isolation: tool execution resolves the RIGHT client ────
  const exec = { agent: { id: 'agent-x' }, signal: new AbortController().signal }
  const listA = await rootA.tools.get('research_project').execute({ action: 'list' }, exec)
  const listB = await rootB.tools.get('research_project').execute({ action: 'list' }, exec)
  if (!listA.projects.some(p => p.project_id === projA.project_id)) problems.push('instance A tool must see kernel A data')
  if (listB.projects.some(p => p.project_id === projA.project_id)) problems.push('instance B tool must NOT see kernel A data (tool context cross-talk)')
  // roles registry isolation
  rootA.research.roles.set('sess-x', 'director')
  if (rootB.research.roles.get('sess-x') !== 'none') problems.push('role registries must be per-instance')
  // ACL listener isolation: granting a role in B never affects A
  if (await runAcl(rootA, 'unknown-u', 'research_project') !== 'deny') problems.push('unknown agent must be denied on instance A')
  rootB.research.roles.set('unknown-u', 'director')
  if (await runAcl(rootA, 'unknown-u', 'research_project') !== 'deny') problems.push('granting a role in instance B must not leak into A (ACL cross-talk)')
  if (await runAcl(rootB, 'unknown-u', 'research_project') !== 'allow') problems.push('director role must allow research_project on instance B')

  // ── reload via cordis update(): unload then re-apply, no duplicates ──────
  const oldPid = epFileA.pid
  await handleA.update(cfgA)
  const epFileA2 = readEp(dirA)
  trackedPids.push(epFileA2.pid)
  if (alive(oldPid)) problems.push('reload must stop the old kernel (sidecar disposer)')
  if (epFileA2.pid === oldPid) problems.push('reload must spawn/reuse a fresh kernel instance')
  if (rootA.tools.schemas().length !== 41) problems.push(`reload re-registered tools (${rootA.tools.schemas().length} != 41, duplicate risk)`)
  if ((await rootA.skills.list()).length !== 4) problems.push('reload leaked or lost research skills')
  if (!(await rootA.research.client.listProjects()).some(p => p.project_id === projA.project_id)) problems.push('reload must keep kernel data (same dataDir)')
  if ((rootA.events._hooks['tools/pre-execute'] ?? []).length !== 1) problems.push('reload must not duplicate the pre-execute listener')

  // ── dispose: everything released, port freed, B unaffected ───────────────
  const lastEndpoint = rootA.research.endpoint
  await handleA.dispose()
  handleA = undefined
  if (rootA.research !== undefined) problems.push('dispose must remove the research service')
  if (alive(epFileA2.pid)) problems.push('dispose must stop the kernel sidecar child')
  if (existsSync(join(dirA, 'runtime', 'endpoint.json'))) problems.push('dispose must remove the owned endpoint.json')
  if (rootA.tools.get('research_project') !== undefined || rootA.tools.schemas().length !== 0) problems.push('dispose must unregister every research tool')
  if (rootA.commands.list({}).length !== 0) problems.push('dispose must unregister every direct slash command')
  if ((await rootA.skills.list()).length !== 0) problems.push('dispose must unregister the research skill provider')
  if ((rootA.events._hooks['tools/pre-execute'] ?? []).length !== 0) problems.push('dispose must remove the pre-execute listener')
  const healthAfter = await fetch(`${lastEndpoint}/v1/health`).then(r => r.ok).catch(() => false)
  if (healthAfter) problems.push('dispose must release the kernel port (health still answering)')
  // the sibling instance is untouched
  if (rootB.tools.schemas().length !== 41) problems.push('disposing A must not affect B tools')
  if (rootB.research === undefined) problems.push('disposing A must not affect B research service')

  // ── re-apply on the same root: usable again, still exactly once ──────────
  handleA2 = await rootA.plugin(pluginMod, cfgA)
  const epFileA3 = readEp(dirA)
  trackedPids.push(epFileA3.pid)
  if (rootA.tools.schemas().length !== 41) problems.push(`re-apply tool count ${rootA.tools.schemas().length} != 41`)
  if (!(await rootA.research.client.listProjects()).some(p => p.project_id === projA.project_id)) problems.push('re-apply must restore the client against the same dataDir')
  await handleA2.dispose()
  handleA2 = undefined
  await handleB.dispose()
  handleB = undefined
} catch (error) {
  problems.push(`fixture error: ${error instanceof Error ? error.message : String(error)}`)
} finally {
  // Always unload active plugin fibers before killing tracked children. This
  // also closes the plugin-owned Chat agent bridge and prevents a successful
  // lifecycle fixture from hanging the Node event loop.
  for (const handle of [handleA2, handleA, handleB]) {
    try { await handle?.dispose() } catch { /* diagnostic cleanup only */ }
  }
  for (const pid of trackedPids) terminate(pid)
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true })
}

console.log(JSON.stringify({ problems }))
EOF
)
if [ -z "$HOSTFIX" ]; then
  bad "host fixture probe script produced no output"
else
  if probe "$HOSTFIX" "j.problems.length === 0"; then
    ok "minimal cordis host: async apply / port=0 endpoint / dual instance / reload / dispose all pass"
  else
    bad "host fixture: $(printf '%s' "$HOSTFIX" | jnode -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>console.log(JSON.parse(d).problems.join('|')))")"
  fi
  if probe "$HOSTFIX" "!j.problems.some(p=>/port0/.test(p)||/endpoint/.test(p)||/client endpoint/.test(p))"; then
    ok "port=0: apply awaits start; endpoint is the resolved real port and the client is usable"
  else
    bad "port=0 endpoint resolution failed"
  fi
  if probe "$HOSTFIX" "!j.problems.some(p=>/cross-talk/.test(p)||/per-instance/.test(p)||/leak into A/.test(p)||/distinct/.test(p))"; then
    ok "dual instances: endpoints/kernels/roles/ACL/tool client all isolated in one process"
  else
    bad "dual-instance isolation failed"
  fi
  if probe "$HOSTFIX" "!j.problems.some(p=>/reload/.test(p)||/re-registered/.test(p)||/duplicate/.test(p))"; then
    ok "reload (cordis update): old kernel stopped, tools/skills/listeners not duplicated, data persists"
  else
    bad "reload leaked or duplicated resources"
  fi
  if probe "$HOSTFIX" "!j.problems.some(p=>/dispose/.test(p)||/unregister/.test(p)||/release the kernel port/.test(p)||/affect B/.test(p))"; then
    ok "dispose: sidecar stopped, port released, tools/commands/skills/listeners released, sibling unaffected"
  else
    bad "dispose left residual resources"
  fi
  if probe "$HOSTFIX" "!j.problems.some(p=>/re-apply/.test(p))"; then
    ok "re-apply on the same root registers exactly once and stays usable"
  else
    bad "re-apply failed"
  fi
fi

# ── §9: direct slash-command handlers against a real kernel ────────────────
say "direct research commands (kernel-backed)"
PORT=$((21500 + $$ % 400))
SERVICE_TOKEN='plugin-fixture-service-token'
DSH_PLUGIN_TOKEN='plugin-fixture-dsh-token'
DSH_SCHOLAR_SERVICE_TOKEN="$SERVICE_TOKEN" DSH_SCHOLAR_DSH_PLUGIN_TOKEN="$DSH_PLUGIN_TOKEN" \
  nohup node "$KERNEL_BIN" --db "$WORK/kernel.db" --cas "$WORK/cas" --port "$PORT" > "$WORK/kernel.log" 2>&1 &
KERNEL_PID=$!
READY=0
for _ in $(seq 1 50); do
  if curl -sf "http://127.0.0.1:$PORT/v1/health" > /dev/null 2>&1; then READY=1; break; fi
  sleep 0.1
done
if [ "$READY" = 1 ]; then
  ok "research kernel healthy"
else
  bad "kernel did not start"
  exit 1
fi

CMDS=$(jnode - "$REPO" "$PORT" "$SERVICE_TOKEN" "$DSH_PLUGIN_TOKEN" <<'EOF'
const repo = process.argv[2]
const port = process.argv[3]
const serviceToken = process.argv[4]
const dshPluginToken = process.argv[5]
const { registerResearchCommands } = await import(`${repo}/lib/plugin/commands.js`)
const { ResearchClient } = await import('@dsh-scholar/research-client')

const client = new ResearchClient({
  endpoint: `http://127.0.0.1:${port}`,
  serviceToken,
  dshPluginToken,
})
const captured = new Map()
registerResearchCommands({ commands: { register: def => { captured.set(def.name, def) } } },
  { client, cache: {}, unattended: false, operatorPrincipal: 'fixture:plugin-operator' })
// DSH commands hand the handler the text AFTER the slash command name
// (parseCommand: rawInput = line.slice(match[0].length)).
const run = async (name, rawInput = '', agentId = 'plugin-test-agent') => {
  const def = captured.get(name)
  if (def === undefined) return { kind: 'not-registered', text: name }
  return def.handler({ agent: { id: agentId }, rawInput })
}

const results = {}
results.help = await run('help')
results.listEmpty = await run('list')
results.claimsNoProject = await run('claims', '', 'plugin-unbound-agent')
// Name-only creation must use the same authenticated internal route as the
// real plugin and atomically link this exact DSH session.
results.new = await run('new', 'mlproj-empty', 'plugin-name-only-agent')
const nameOnlyId = /rsp_[a-z0-9_]+/.exec(results.new.text)?.[0] ?? ''
// A complete Brief is a distinct command invocation/session. It exercises
// deterministic skill selection and the initial Scope Gate without trying
// to rebind the already-linked name-only session.
results.newConfigured = await run(
  'new',
  'mlproj {"domain":"machine-learning","target_venue":"iclr-2026"}',
  'plugin-configured-agent',
)
const projId = /rsp_[a-z0-9_]+/.exec(results.newConfigured.text)?.[0] ?? ''
results.status = await run('status', projId, 'plugin-configured-agent')
results.gates = await run('gates', projId, 'plugin-configured-agent')
results.jobs = await run('jobs', projId, 'plugin-configured-agent')
results.claims = await run('claims', projId, 'plugin-configured-agent')
results.list = await run('list')
results.aggregate = await run('research', 'help')
console.log(JSON.stringify({ results, projId, nameOnlyId, commandNames: [...captured.keys()].sort() }))
EOF
)
if [ -z "$CMDS" ]; then
  bad "subcommand probe script produced no output"
else
  for SUB in help listEmpty new status gates jobs claims list; do
    if probe "$CMDS" "j.results['$SUB'] && j.results['$SUB'].kind === 'success'"; then
      ok "/$SUB has a real handler"
    else
      bad "/$SUB handler failed"
    fi
  done
  if probe "$CMDS" "j.results.claimsNoProject && j.results.claimsNoProject.kind === 'error' && /session-linked/.test(j.results.claimsNoProject.text)"; then
    ok "/claims without project -> explicit error (real handler, not help)"
  else
    bad "/claims missing-project path"
  fi
  if probe "$CMDS" "j.nameOnlyId !== '' && /collecting|Grill Me/.test(j.results.new.text)"; then
    ok "name-only /new uses authenticated atomic create/link and starts Grill"
  else
    bad "name-only /new did not create the collecting session project"
  fi
  if probe "$CMDS" "j.results.newConfigured.kind === 'success' && /domain-machine-learning/.test(j.results.newConfigured.text) && /venue-templates/.test(j.results.newConfigured.text)"; then
    ok "new echoes deterministic domain/venue skill selection"
  else
    bad "new lacks deterministic skill selection"
  fi
  if probe "$CMDS" "/scope/.test(j.results.gates.text)"; then
    ok "gates returns real kernel gate data (scope gate)"
  else
    bad "gates handler returned no gate data"
  fi
  if probe "$CMDS" "/0 claim/.test(j.results.claims.text)"; then
    ok "claims returns real kernel ledger data (counts)"
  else
    bad "claims handler returned no ledger data"
  fi
  if probe "$CMDS" "j.results.aggregate.kind === 'not-registered' && !j.commandNames.includes('research')"; then
    ok "aggregate command descriptor is not registered or advertised"
  else
    bad "aggregate command descriptor leaked into DSH"
  fi
  if probe "$CMDS" "j.projId !== '' && /rsp_/.test(j.results.status.text)"; then
    ok "status returns the real project projection"
  else
    bad "status handler returned no projection"
  fi
fi

# ── §9: skills — package-root resolution + deterministic selection + pack ──
say "skills: package-root provider, deterministic selection, npm pack"
SKILLS=$(jnode - "$REPO" <<'EOF'
const repo = process.argv[2]
const { resolveSkillRoot, resolveSkillDirs, selectSkillPacks, selectedSkillNames, SKILL_GROUPS } = await import(`${repo}/lib/plugin/skills.js`)
const { existsSync } = await import('node:fs')
const { dirname, sep } = await import('node:path')
const root = resolveSkillRoot()
const problems = []
if (!root.endsWith(sep + 'skills')) problems.push(`skill root not package-root skills/: ${root}`)
if (!existsSync(root)) problems.push(`skill root missing: ${root}`)
for (const name of SKILL_GROUPS) {
  if (!existsSync(`${root}/${name}/SKILL.md`)) problems.push(`skill group missing: ${name}`)
}
if (existsSync(`${dirname(root)}/lib/skills`)) problems.push('lib/skills must not exist')
const dirs = resolveSkillDirs()
if (dirs.length !== 4) problems.push(`expected 4 skill dirs, got ${dirs.length}`)
const cases = [
  [{ domain: 'machine-learning', target_venue: 'iclr-2026' }, ['research-core', 'domain-machine-learning', 'venue-templates']],
  [{ domain: 'ML', target_venue: null }, ['research-core', 'domain-machine-learning']],
  [{ domain: 'data-science', target_venue: null }, ['research-core', 'domain-data-science']],
  [{ domain: 'tabular data science', target_venue: 'conference' }, ['research-core', 'domain-data-science', 'venue-templates']],
  [{ domain: 'physics', target_venue: 'some-journal-of-x' }, ['research-core', 'venue-templates']],
  [{ domain: 'physics', target_venue: null }, ['research-core']],
  [null, ['research-core']],
]
for (const [brief, expected] of cases) {
  const got = selectedSkillNames(brief)
  if (JSON.stringify(got) !== JSON.stringify(expected)) {
    problems.push(`selection ${JSON.stringify(brief)} -> ${got.join(',')} expected ${expected.join(',')}`)
  }
  if (JSON.stringify(got) !== JSON.stringify(selectedSkillNames(brief))) {
    problems.push(`selection not deterministic for ${JSON.stringify(brief)}`)
  }
}
console.log(JSON.stringify({ problems, dirs: dirs.map(d => d.name) }))
EOF
)
if probe "$SKILLS" "j.problems.length === 0"; then
  ok "skill provider resolves the four groups from the package root (no lib/skills)"
else
  bad "skill resolution: $(printf '%s' "$SKILLS" | jnode -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>console.log(JSON.parse(d).problems.join('|')))")"
fi
if probe "$SKILLS" "j.dirs.length === 4"; then
  ok "all four skill groups discoverable (research-core + 2 domains + venue)"
else
  bad "skill groups incomplete"
fi

PACKLIST=$(cd "$REPO" && npm pack --dry-run 2>&1 | sed -n '/Tarball Contents/,/Tarball Details/p' | grep -E 'skills/(research-core|domain-machine-learning|domain-data-science|venue-templates)/SKILL.md' || true)
for S in research-core domain-machine-learning domain-data-science venue-templates; do
  if printf '%s' "$PACKLIST" | grep -q "skills/$S/SKILL.md"; then
    ok "npm pack ships skills/$S/SKILL.md"
  else
    bad "npm pack missing skills/$S/SKILL.md"
  fi
done

echo "== dsh-plugin tests: $PASS passed, $FAIL failed =="
[ "$FAIL" -eq 0 ] || exit 1
