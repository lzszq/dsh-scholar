/**
 * Typed Research Kernel API client (design §8.3). All methods are
 * idempotency-aware where the Kernel requires it; a request to an unreachable
 * kernel fails fast with a `KernelUnavailableError`.
 * @module @dsh-scholar/research-client
 */

import type {
  AdoptionReceipt, ArtifactRecord, AssuranceAudit, AssuranceSemanticReviewReceipt, ChildExecutionIdentity, Claim, CorpusSnapshot, Decision, DirectionAdoption, DirectionProposal,
  EvidenceItem, ExperimentContract, Gate,
  GrillAnswerInput, GrillAnswerView, HumanPrincipal, IdeaCard, IntakeArtifact, IntakeProjection, IntakeSession,
  JobRecord, KernelEvent, KnowledgeActivationIntent, KnowledgeActivationRequest, KnowledgeCapability, KnowledgePackageEvaluation, KnowledgePackageRecord, ObservedPhase,
  PaperRef, PaperReproductionSpec, PhaseProposal, ProjectDeletionReceipt, ProtocolRevision,
  FrozenProtocolPin, JobSpecBound, ResearchIntent,
  ReproductionAttempt, ReproductionReportInput, ReproducibilityReport, ResearchProject, ResearchSynthesis,
  ReviewFinding, ReverseOutline, RunnerKey, SessionLink, WorkspaceNode,
  NegativeFinding, ResearchClaimProposal, ResearchRunOutcome, ResearchRunOutcomeWrite, RunOutcomeObservation, SynthesisRecordRequest,
  MethodTriad, MethodTriadDiagnostic, MethodTriadWrite,
  SectionGuideActivation, SectionGuideActivationWrite,
  WritingReviewerPanelAggregate, WritingReviewerPanelWrite,
  WritingPatchProposal, WritingPatchProposalWrite, WritingPatchApplication, WritingPatchApplyInput,
  WritingAssuranceAuditKind,
  MethodologyRolloutMode, MethodologyRolloutPolicy, ProjectMethodologyRolloutPin,
} from '@dsh-scholar/research-schemas'

export class KernelUnavailableError extends Error {
  constructor(endpoint: string, cause: unknown) {
    super(`research kernel unreachable at ${endpoint}: ${(cause as Error).message ?? String(cause)}`)
    this.name = 'KernelUnavailableError'
  }
}

export class KernelApiError extends Error {
  readonly status: number
  readonly code: string
  constructor(status: number, code: string, message: string) {
    super(`${code}: ${message}`)
    this.name = 'KernelApiError'
    this.status = status
    this.code = code
  }
}

export interface KernelClientOptions {
  endpoint: string
  token?: string
  /** §4 P0 (API-01/EVID-01): shared internal-route service identity. DSH
   * internal mutations additionally require the audience-bound token below. */
  serviceToken?: string
  /** Target-scoped heartbeat credential. It is sent only to the
   * RunnerTarget heartbeat route, never to general Kernel requests. */
  runnerTargetToken?: string
  /** DSH internal-route credential for create/link, Knowledge/Assurance and
   * native Pack reconcile; never sent to Runner processes or public routes. */
  dshPluginToken?: string
  /** Timeout for each request, ms. */
  timeoutMs?: number
}

/** Kernel-authoritative state for the seven-question name-only project Grill. */
export interface ProjectGrillProjection {
  project_id: string
  project_revision: number
  intake_id: string
  intake_revision: number
  question: {
    question_code: string
    question_revision: number
    prompt_key: string
    required: boolean
  } | null
  answers: Array<{
    question_code: string
    question_revision: number
    value: unknown
    disposition: string
    answered_by: string
    answered_at: string
  }>
  brief_preview: ResearchProject['brief']
  ready_to_confirm: boolean
}

export interface MethodologyRecordView<T> {
  project_id: string
  stream_revision: number
  recorded_revision: number
  record: T
}

export interface MethodologyRecordList<T> {
  project_id: string
  stream_revision: number
  records: Array<MethodologyRecordView<T>>
}

export interface MethodologyRegistryRecordView<T> {
  registry_revision: number
  recorded_revision: number
  record: T
}

export interface MethodologyRegistryRecordList<T> {
  registry_revision: number
  records: Array<MethodologyRegistryRecordView<T>>
}

export interface AssuranceAuditView {
  project_id: string
  revision: number
  recorded_revision: number
  acceptance_revision: number | null
  accepted_by: string | null
  accepted_at: string | null
  audit: AssuranceAudit
}

export interface AssuranceAuditList {
  project_id: string
  revision: number
  audits: AssuranceAuditView[]
}

export interface StoredKnowledgeActivation {
  activation_id: string
  project_id: string
  registry_revision: number
  request: KnowledgeActivationRequest
  resolution: Record<string, unknown>
  activated_at: string
}

export interface StoredKnowledgeDeactivation {
  deactivation_id: string
  project_id: string
  session_id: string
  activation_id: string
  reason: 'user-requested' | 'superseded' | 'no-longer-needed'
  deactivated_at: string
}

export interface KnowledgeDeliverySnapshot {
  context: {
    project_id: string
    session_id: string
    phase: string
    next_action_revision: number
    surface: 'scholar-chat' | 'assurance-reviewer'
  }
  deliveries: Array<{
    activation_id: string
    package_name: string
    package_version: string
    manifest_sha256: string
    payload_sha256: string
    trust: 'trusted-native-instruction' | 'untrusted-external-reference'
    effective_capabilities: KnowledgeCapability[]
    content: null | {
      schema_version: 1
      purpose: string
      surfaces: Array<'scholar-chat' | 'assurance-reviewer'>
      instructions: string[]
      prohibitions: string[]
    }
  }>
  suppressed: Array<{ activation_id: string; reason_codes: KnowledgeDeliverySuppressionReason[] }>
}

export type KnowledgeDeliverySuppressionReason =
  | 'activation_not_explicit' | 'package_not_found' | 'package_identity_mismatch'
  | 'evaluation_not_found' | 'evaluation_conflict' | 'package_rejected' | 'package_revoked'
  | 'license_not_activatable' | 'instruction_source_not_trusted' | 'channel_verdict_mismatch'
  | 'supply_chain_equivocation' | 'no_effective_capabilities'
  | 'wrong_project' | 'wrong_session' | 'stale_phase' | 'stale_next_action'
  | 'deactivated' | 'native_pack_missing' | 'native_integrity_failed' | 'surface_not_allowed'

export interface MethodologyCompactProjection {
  project_id: string
  revision: number
  assurance: { level: 'draft' | 'submission'; ready: boolean; reason_codes: string[] } | null
  protocol: { current_id: string; revision: number; status: 'draft' | 'frozen'; intent: ResearchIntent } | null
  synthesis: { current_id: string; fresh: boolean; stale_reasons: string[] } | null
  knowledge: {
    active_count: number
    package_names: string[]
    suppressed_count: number
    status: 'delivery-ready' | 'suppressed' | 'inactive'
  }
  writing: { outline_id: string; blocking_count: number; stale: boolean | null; reason_codes: string[] } | null
  manuscript: {
    revision: number
    method_triad: { triad_id: string; status: 'ready' | 'diagnostic_gap'; gap_codes: string[] } | null
    section_guide: { activation_id: string; section: string; state: 'active' | 'diagnostic_gap'; missing_inputs: string[] } | null
    reviewer_panel: {
      aggregate_id: string
      state: 'complete' | 'partial' | 'missing'
      complete_roles: string[]
      missing_roles: string[]
    } | null
    patches: {
      proposal_count: number
      application_count: number
      latest_proposal_id: string | null
      latest_application_id: string | null
    }
  }
  runs: {
    revision: number
    count: number
    negative_finding_count: number
    claim_proposal_count: number
    latest_run_ref: string | null
  }
  topology: {
    assurance_audit_count: number
    latest_audit_id: string | null
    research_node_count: number
    research_edge_count: number
  }
  next_recommendation: { code: string; label_key: string } | null
  rollout: {
    mode: MethodologyRolloutMode
    policy_revision: number
    project_pin_revision: number
    telemetry: {
      counters: Array<{ key: string; tags: Record<string, string>; value: number }>
      histograms: Array<{
        key: string; tags: Record<string, string>; count: number; sum: number; min: number | null; max: number | null
      }>
    }
  }
}

export interface ResearchGraphProjection {
  project_id: string
  nodes: Array<{
    id: string
    kind: 'protocol' | 'synthesis' | 'direction' | 'adoption' | 'artifact' | 'claim' | 'contract'
      | 'corpus-snapshot' | 'decision' | 'evidence' | 'run' | 'negative-finding' | 'claim-proposal'
      | 'code' | 'data' | 'environment'
    ref: string
    revision: number | null
    sha256: string | null
  }>
  edges: Array<{
    id: string
    from: string
    to: string
    kind: 'pins' | 'input_to' | 'supports_statement_in' | 'inferred_for' | 'proposes' | 'classifies_as' | 'decides'
    provenance: 'explicit' | 'inferred'
  }>
}

export interface DirectionList {
  project_id: string
  stream_revision: number
  proposals: MethodologyRecordList<DirectionProposal>
  adoptions: MethodologyRecordList<DirectionAdoption>
}

export interface WritingReviewList {
  project_id: string
  stream_revision: number
  reverse_outlines: MethodologyRecordList<ReverseOutline>
  findings: MethodologyRecordList<ReviewFinding>
}

export interface MethodologyPackageRegistry {
  registry_revision: number
  packages: MethodologyRegistryRecordList<KnowledgePackageRecord>
  evaluations: MethodologyRegistryRecordList<KnowledgePackageEvaluation>
}

export interface ResearchRunOutcomeView {
  project_id: string
  run_stream_revision: number
  recorded_revision: number
  replayed: boolean
  outcome: ResearchRunOutcome
}

export interface ResearchRunOutcomeList {
  project_id: string
  run_stream_revision: number
  outcomes: ResearchRunOutcomeView[]
}

export interface RunOutcomeObservationList {
  project_id: string
  observations: RunOutcomeObservation[]
  pending: RunOutcomeObservation[]
  pending_count: number
}

export interface SynthesisRecordRequestList {
  project_id: string
  requests: SynthesisRecordRequest[]
  pending: SynthesisRecordRequest[]
}

export interface NegativeFindingList {
  project_id: string
  run_stream_revision: number
  findings: NegativeFinding[]
}

export interface ResearchClaimProposalList {
  project_id: string
  run_stream_revision: number
  proposals: ResearchClaimProposal[]
}

export interface WritingReviewRecordView<T> {
  project_id: string
  stream_revision: number
  recorded_revision: number
  record: T
}

export interface WritingReviewRecordList<T> {
  project_id: string
  stream_revision: number
  records: Array<WritingReviewRecordView<T>>
}

export interface StoredMethodTriad {
  triad: MethodTriad
  diagnostic: MethodTriadDiagnostic
}

export interface WritingPatchList {
  project_id: string
  stream_revision: number
  proposals: WritingReviewRecordList<WritingPatchProposal>
  applications: WritingReviewRecordList<WritingPatchApplication>
}

export class ResearchClient {
  readonly endpoint: string
  private readonly token: string | undefined
  private readonly serviceToken: string | undefined
  private readonly runnerTargetToken: string | undefined
  private readonly dshPluginToken: string | undefined
  private readonly timeoutMs: number

  constructor(options: KernelClientOptions) {
    this.endpoint = options.endpoint.replace(/\/+$/, '')
    this.token = options.token
    this.serviceToken = options.serviceToken
    this.runnerTargetToken = options.runnerTargetToken
    this.dshPluginToken = options.dshPluginToken
    this.timeoutMs = options.timeoutMs ?? 15000
  }

  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
    headers: Record<string, string> = {},
    signal?: AbortSignal,
  ): Promise<T> {
    const controller = new AbortController()
    const abortFromCaller = (): void => { controller.abort() }
    if (signal?.aborted === true) controller.abort()
    else signal?.addEventListener('abort', abortFromCaller, { once: true })
    const timer = setTimeout(() => controller.abort(), this.timeoutMs)
    try {
      const response = await fetch(`${this.endpoint}${path}`, {
        method,
        headers: {
          'content-type': 'application/json',
          ...this.token !== undefined ? { authorization: `Bearer ${this.token}` } : {},
          ...this.serviceToken !== undefined ? { 'x-service-token': this.serviceToken } : {},
          ...headers,
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
      })
      if (!response.ok) {
        // api-contracts.md §1: the server envelope carries the STABLE machine
        // code in error.code and the human message in error.message — expose
        // both faithfully (error.code = machine code, error.message =
        // `${code}: ${message}`), so callers can map stable copy per code.
        let code = ''
        let message = ''
        try {
          const parsed = await response.json() as { error?: { code?: string; message?: string } }
          code = parsed.error?.code ?? ''
          message = parsed.error?.message ?? ''
        } catch { /* keep empty */ }
        if (code === '') code = `http_${response.status}`
        if (message === '') message = `request ${method} ${path} failed`
        throw new KernelApiError(response.status, code, message)
      }
      try {
        return (await response.json()) as T
      } catch (error) {
        // A successful status does not prove the commit receipt reached the
        // caller. Treat truncated/aborted JSON as transport loss so the DSH
        // create path can perform a replay-only reconciliation.
        throw new KernelUnavailableError(this.endpoint, error)
      }
    } catch (error) {
      if (error instanceof KernelApiError || error instanceof KernelUnavailableError) throw error
      throw new KernelUnavailableError(this.endpoint, error)
    } finally {
      clearTimeout(timer)
      signal?.removeEventListener('abort', abortFromCaller)
    }
  }

  /**
   * Raw-body request (multipart uploads): identical error semantics to
   * {@link request} (KernelUnavailableError / KernelApiError with the stable
   * server error code), but the caller supplies the exact body bytes and the
   * content-type header instead of a JSON payload.
   */
  private async requestRaw<T>(method: string, path: string, body: Uint8Array, headers: Record<string, string> = {}): Promise<T> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.timeoutMs)
    let response: Response
    try {
      response = await fetch(`${this.endpoint}${path}`, {
        method,
        headers: {
          ...this.token !== undefined ? { authorization: `Bearer ${this.token}` } : {},
          ...this.serviceToken !== undefined ? { 'x-service-token': this.serviceToken } : {},
          ...headers,
        },
        body: body as BodyInit,
        signal: controller.signal,
      })
    } catch (error) {
      throw new KernelUnavailableError(this.endpoint, error)
    } finally {
      clearTimeout(timer)
    }
    if (!response.ok) {
      let code = ''
      let message = ''
      try {
        const parsed = await response.json() as { error?: { code?: string; message?: string } }
        code = parsed.error?.code ?? ''
        message = parsed.error?.message ?? ''
      } catch { /* keep empty */ }
      if (code === '') code = `http_${response.status}`
      if (message === '') message = `request ${method} ${path} failed`
      throw new KernelApiError(response.status, code, message)
    }
    return (await response.json()) as T
  }

  health(): Promise<{ ok: boolean; instance: string }> {
    return this.request('GET', '/v1/health')
  }

  // ── methodology / knowledge (api-contracts.md §24) ──────────────────────

  getMethodology(projectId: string, principalId: string, signal?: AbortSignal): Promise<MethodologyCompactProjection> {
    return this.request('GET', `/v2/projects/${encodeURIComponent(projectId)}/methodology`, undefined, { 'x-principal-id': principalId }, signal)
  }

  getMethodologyGraph(projectId: string, principalId: string): Promise<ResearchGraphProjection> {
    return this.request('GET', `/v2/projects/${encodeURIComponent(projectId)}/methodology/graph`, undefined, { 'x-principal-id': principalId })
  }

  getMethodologyRolloutPolicy(principalId: string): Promise<MethodologyRolloutPolicy> {
    return this.request('GET', '/v2/methodology/rollout-policy', undefined, { 'x-principal-id': principalId })
  }

  updateMethodologyRolloutPolicy(
    principalId: string,
    input: { mode: MethodologyRolloutMode; expected_revision: number },
  ): Promise<MethodologyRolloutPolicy> {
    return this.request('POST', '/v2/methodology/rollout-policy', input, { 'x-principal-id': principalId })
  }

  pinProjectMethodologyRollout(
    projectId: string,
    principalId: string,
    input: {
      expected_project_pin_revision: number
      expected_policy_revision: number
      expected_policy_hash: string
    },
  ): Promise<ProjectMethodologyRolloutPin> {
    return this.request('POST', `/v2/projects/${encodeURIComponent(projectId)}/rollout-policy`, input, { 'x-principal-id': principalId })
  }

  listAssuranceAudits(projectId: string, principalId: string): Promise<AssuranceAuditList> {
    return this.request('GET', `/v2/projects/${encodeURIComponent(projectId)}/assurance-audits`, undefined, { 'x-principal-id': principalId })
  }

  runWritingAssurance(
    projectId: string,
    principalId: string,
    input: { expected_revision: number; audit_kind: WritingAssuranceAuditKind; mode: 'deterministic'; semantic_review: null },
    signal?: AbortSignal,
  ): Promise<AssuranceAuditView> {
    return this.request(
      'POST',
      `/v2/projects/${encodeURIComponent(projectId)}/assurance-executions`,
      input,
      { 'x-principal-id': principalId },
      signal,
    )
  }

  runWritingAssuranceForDshSession(
    sessionId: string,
    input:
      | { expected_revision: number; audit_kind: WritingAssuranceAuditKind; mode: 'deterministic'; semantic_review: null }
      | { expected_revision: number; audit_kind: WritingAssuranceAuditKind; mode: 'semantic'; semantic_review: AssuranceSemanticReviewReceipt },
    signal?: AbortSignal,
  ): Promise<AssuranceAuditView> {
    return this.request(
      'POST',
      `/internal/dsh-sessions/${encodeURIComponent(sessionId)}/assurance-executions`,
      input,
      {
        'x-service-principal': 'dsh-plugin',
        ...this.dshPluginToken !== undefined ? { 'x-dsh-plugin-token': this.dshPluginToken } : {},
      },
      signal,
    )
  }

  acceptAssuranceAudit(projectId: string, auditId: string, principalId: string, expectedRevision: number): Promise<AssuranceAuditView> {
    return this.request(
      'POST',
      `/v2/projects/${encodeURIComponent(projectId)}/assurance-audits/${encodeURIComponent(auditId)}/accept`,
      { expected_revision: expectedRevision },
      { 'x-principal-id': principalId },
    )
  }

  recordResearchRun(
    projectId: string,
    principalId: string,
    input: ResearchRunOutcomeWrite,
  ): Promise<ResearchRunOutcomeView> {
    return this.request('POST', `/v2/projects/${encodeURIComponent(projectId)}/research-runs`, input, { 'x-principal-id': principalId })
  }

  listResearchRuns(projectId: string, principalId: string): Promise<ResearchRunOutcomeList> {
    return this.request('GET', `/v2/projects/${encodeURIComponent(projectId)}/research-runs`, undefined, { 'x-principal-id': principalId })
  }

  listRunOutcomeObservations(projectId: string, principalId: string): Promise<RunOutcomeObservationList> {
    return this.request('GET', `/v2/projects/${encodeURIComponent(projectId)}/run-outcome-observations`, undefined, { 'x-principal-id': principalId })
  }

  listSynthesisRecordRequests(projectId: string, principalId: string): Promise<SynthesisRecordRequestList> {
    return this.request('GET', `/v2/projects/${encodeURIComponent(projectId)}/synthesis-requests`, undefined, { 'x-principal-id': principalId })
  }

  listNegativeFindings(projectId: string, principalId: string): Promise<NegativeFindingList> {
    return this.request('GET', `/v2/projects/${encodeURIComponent(projectId)}/negative-findings`, undefined, { 'x-principal-id': principalId })
  }

  listResearchClaimProposals(projectId: string, principalId: string): Promise<ResearchClaimProposalList> {
    return this.request('GET', `/v2/projects/${encodeURIComponent(projectId)}/claim-proposals`, undefined, { 'x-principal-id': principalId })
  }

  listMethodTriads(projectId: string, principalId: string): Promise<WritingReviewRecordList<StoredMethodTriad>> {
    return this.request('GET', `/v2/projects/${encodeURIComponent(projectId)}/method-triads`, undefined, { 'x-principal-id': principalId })
  }

  recordMethodTriad(projectId: string, principalId: string, input: MethodTriadWrite): Promise<WritingReviewRecordView<StoredMethodTriad>> {
    return this.request('POST', `/v2/projects/${encodeURIComponent(projectId)}/method-triads`, input, { 'x-principal-id': principalId })
  }

  listSectionGuides(projectId: string, principalId: string): Promise<WritingReviewRecordList<SectionGuideActivation>> {
    return this.request('GET', `/v2/projects/${encodeURIComponent(projectId)}/section-guides`, undefined, { 'x-principal-id': principalId })
  }

  activateSectionGuide(projectId: string, principalId: string, input: SectionGuideActivationWrite): Promise<WritingReviewRecordView<SectionGuideActivation>> {
    return this.request('POST', `/v2/projects/${encodeURIComponent(projectId)}/section-guides`, input, { 'x-principal-id': principalId })
  }

  listWritingReviewerPanels(projectId: string, principalId: string): Promise<WritingReviewRecordList<WritingReviewerPanelAggregate>> {
    return this.request('GET', `/v2/projects/${encodeURIComponent(projectId)}/reviewer-panels`, undefined, { 'x-principal-id': principalId })
  }

  recordWritingReviewerPanel(projectId: string, principalId: string, input: WritingReviewerPanelWrite): Promise<WritingReviewRecordView<WritingReviewerPanelAggregate>> {
    return this.request('POST', `/v2/projects/${encodeURIComponent(projectId)}/reviewer-panels`, input, { 'x-principal-id': principalId })
  }

  listWritingPatches(projectId: string, principalId: string): Promise<WritingPatchList> {
    return this.request('GET', `/v2/projects/${encodeURIComponent(projectId)}/writing-patches`, undefined, { 'x-principal-id': principalId })
  }

  proposeWritingPatch(projectId: string, principalId: string, input: WritingPatchProposalWrite): Promise<WritingReviewRecordView<WritingPatchProposal>> {
    return this.request('POST', `/v2/projects/${encodeURIComponent(projectId)}/writing-patches`, input, { 'x-principal-id': principalId })
  }

  applyWritingPatch(
    projectId: string,
    proposalId: string,
    principalId: string,
    input: WritingPatchApplyInput,
  ): Promise<WritingReviewRecordView<WritingPatchApplication>> {
    return this.request(
      'POST',
      `/v2/projects/${encodeURIComponent(projectId)}/writing-patches/${encodeURIComponent(proposalId)}/apply`,
      input,
      { 'x-principal-id': principalId },
    )
  }

  listProtocols(projectId: string, principalId: string): Promise<MethodologyRecordList<ProtocolRevision>> {
    return this.request('GET', `/v2/projects/${encodeURIComponent(projectId)}/protocols`, undefined, { 'x-principal-id': principalId })
  }

  recordProtocol(
    projectId: string,
    principalId: string,
    input: { record: ProtocolRevision; expected_revision: number },
  ): Promise<MethodologyRecordView<ProtocolRevision>> {
    return this.request('POST', `/v2/projects/${encodeURIComponent(projectId)}/protocols`, input, { 'x-principal-id': principalId })
  }

  listSyntheses(projectId: string, principalId: string): Promise<MethodologyRecordList<ResearchSynthesis>> {
    return this.request('GET', `/v2/projects/${encodeURIComponent(projectId)}/syntheses`, undefined, { 'x-principal-id': principalId })
  }

  recordSynthesis(
    projectId: string,
    principalId: string,
    input: { request_id: string; record: ResearchSynthesis; expected_revision: number },
  ): Promise<MethodologyRecordView<ResearchSynthesis>> {
    return this.request('POST', `/v2/projects/${encodeURIComponent(projectId)}/syntheses`, input, { 'x-principal-id': principalId })
  }

  listDirections(projectId: string, principalId: string): Promise<DirectionList> {
    return this.request('GET', `/v2/projects/${encodeURIComponent(projectId)}/directions`, undefined, { 'x-principal-id': principalId })
  }

  recordDirection(
    projectId: string,
    principalId: string,
    input: { record: DirectionProposal; expected_revision: number },
  ): Promise<MethodologyRecordView<DirectionProposal>> {
    return this.request('POST', `/v2/projects/${encodeURIComponent(projectId)}/directions`, input, { 'x-principal-id': principalId })
  }

  adoptDirection(
    projectId: string,
    proposalId: string,
    principalId: string,
    input: {
      adoption_id: string
      decision: 'adopted' | 'rejected'
      gate_decision_ref: string | null
      created_at: string
      expected_revision: number
    },
  ): Promise<MethodologyRecordView<DirectionAdoption>> {
    return this.request(
      'POST',
      `/v2/projects/${encodeURIComponent(projectId)}/directions/${encodeURIComponent(proposalId)}/adopt`,
      input,
      { 'x-principal-id': principalId },
    )
  }

  listKnowledgeActivations(projectId: string, principalId: string): Promise<MethodologyRecordList<StoredKnowledgeActivation>> {
    return this.request('GET', `/v2/projects/${encodeURIComponent(projectId)}/knowledge-activations`, undefined, { 'x-principal-id': principalId })
  }

  activateKnowledgePackage(
    projectId: string,
    principalId: string,
    sessionId: string,
    input: KnowledgeActivationIntent,
  ): Promise<MethodologyRecordView<StoredKnowledgeActivation>> {
    return this.request('POST', `/v2/projects/${encodeURIComponent(projectId)}/knowledge-activations`, input, {
      'x-principal-id': principalId,
      'x-principal-session': sessionId,
    })
  }

  activateKnowledgePackageForDshSession(
    sessionId: string,
    input: KnowledgeActivationIntent,
  ): Promise<MethodologyRecordView<StoredKnowledgeActivation>> {
    return this.request(
      'POST',
      `/internal/dsh-sessions/${encodeURIComponent(sessionId)}/knowledge-activations`,
      input,
      {
        'x-service-principal': 'dsh-plugin',
        ...this.dshPluginToken !== undefined ? { 'x-dsh-plugin-token': this.dshPluginToken } : {},
      },
    )
  }

  reconcileNativeKnowledgePacks(): Promise<{ registry_revision: number; package_names: string[] }> {
    return this.request('POST', '/internal/methodology/native-packs/reconcile', {}, {
      'x-service-principal': 'dsh-plugin',
      ...this.dshPluginToken !== undefined ? { 'x-dsh-plugin-token': this.dshPluginToken } : {},
    })
  }

  deactivateKnowledgePackage(
    projectId: string,
    activationId: string,
    principalId: string,
    input: {
      request: {
        project_id: string
        session_id: string
        activation_id: string
        explicit_human_deactivation: true
        reason: 'user-requested' | 'superseded' | 'no-longer-needed'
      }
      expected_revision: number
    },
  ): Promise<MethodologyRecordView<StoredKnowledgeDeactivation>> {
    return this.request(
      'POST',
      `/v2/projects/${encodeURIComponent(projectId)}/knowledge-activations/${encodeURIComponent(activationId)}/deactivate`,
      input,
      { 'x-principal-id': principalId },
    )
  }

  getKnowledgeDelivery(
    projectId: string,
    principalId: string,
    input: { session_id: string; surface: 'scholar-chat' | 'assurance-reviewer' },
    signal?: AbortSignal,
  ): Promise<KnowledgeDeliverySnapshot> {
    const query = new URLSearchParams({ session_id: input.session_id, surface: input.surface })
    return this.request(
      'GET',
      `/v2/projects/${encodeURIComponent(projectId)}/knowledge-delivery?${query.toString()}`,
      undefined,
      { 'x-principal-id': principalId },
      signal,
    )
  }

  listWritingReviews(projectId: string, principalId: string): Promise<WritingReviewList> {
    return this.request('GET', `/v2/projects/${encodeURIComponent(projectId)}/writing-reviews`, undefined, { 'x-principal-id': principalId })
  }

  recordReverseOutline(
    projectId: string,
    principalId: string,
    input: { record: ReverseOutline; expected_revision: number },
  ): Promise<MethodologyRecordView<ReverseOutline>> {
    return this.request(
      'POST',
      `/v2/projects/${encodeURIComponent(projectId)}/writing-reviews`,
      { kind: 'reverse-outline', ...input },
      { 'x-principal-id': principalId },
    )
  }

  recordReviewFinding(
    projectId: string,
    principalId: string,
    input: { record: ReviewFinding; expected_revision: number },
  ): Promise<MethodologyRecordView<ReviewFinding>> {
    return this.request(
      'POST',
      `/v2/projects/${encodeURIComponent(projectId)}/writing-reviews`,
      { kind: 'review-finding', ...input },
      { 'x-principal-id': principalId },
    )
  }

  listMethodologyPackages(principalId: string): Promise<MethodologyPackageRegistry> {
    return this.request('GET', '/v2/methodology/packages', undefined, { 'x-principal-id': principalId })
  }

  registerMethodologyPackage(
    principalId: string,
    input: { record: KnowledgePackageRecord; expected_revision: number },
  ): Promise<MethodologyRegistryRecordView<KnowledgePackageRecord>> {
    return this.request('POST', '/v2/methodology/packages', input, { 'x-principal-id': principalId })
  }

  evaluateMethodologyPackage(
    packageName: string,
    packageVersion: string,
    principalId: string,
    input: { record: KnowledgePackageEvaluation; expected_revision: number },
  ): Promise<MethodologyRegistryRecordView<KnowledgePackageEvaluation>> {
    return this.request(
      'POST',
      `/v2/methodology/packages/${encodeURIComponent(packageName)}/${encodeURIComponent(packageVersion)}/evaluations`,
      input,
      { 'x-principal-id': principalId },
    )
  }

  // ── paper reproduction (docs/reproduction-contracts.md §4) ───────────────

  /** REPRO-01: create (or idempotently restore) a PaperReproductionSpec. */
  createReproductionSpec(input: {
    project_id: string
    paper_ref: PaperRef
    source_locator?: string
    source_artifact_id?: string | null
    reproduction_level?: string
    claims_to_reproduce?: unknown[]
    code_source?: unknown | null
    data_inputs?: unknown[]
    execution_binding?: unknown | null
    environment_lock?: unknown
    expected_outputs?: string[]
    metric_comparators?: unknown[]
    idempotency_key?: string
  }): Promise<PaperReproductionSpec> {
    return this.request('POST', `/v2/projects/${input.project_id}/reproduction-specs`, input)
  }

  listReproductionSpecs(projectId: string): Promise<PaperReproductionSpec[]> {
    return this.request('GET', `/v2/projects/${projectId}/reproduction-specs`)
  }

  getReproductionSpec(projectId: string, specId: string): Promise<PaperReproductionSpec> {
    return this.request('GET', `/v2/projects/${projectId}/reproduction-specs/${specId}`)
  }

  /** REPRO-01: revision-CAS patch of a spec (stale revision → 409). */
  updateReproductionSpec(projectId: string, specId: string, input: {
    expected_revision: number
    patch: Record<string, unknown>
  }): Promise<PaperReproductionSpec> {
    return this.request('PATCH', `/v2/projects/${projectId}/reproduction-specs/${specId}`, input)
  }

  /** REPRO-01: start one attempt — returns attempt + generation + lease
   *  token (the token is the caller's fencing credential for the report). */
  startReproductionAttempt(projectId: string, specId: string, input: {
    submitter_principal?: string
    reason?: string
    job_id?: string | null
    run_id?: string | null
    code_snapshot_id?: string | null
    approved_contract_version?: number | null
    idempotency_key?: string
  }): Promise<{ attempt: ReproductionAttempt; generation: number; lease_token: string | null }> {
    return this.request('POST', `/v2/projects/${projectId}/reproduction-specs/${specId}/attempts`, input)
  }

  getReproductionAttempt(projectId: string, attemptId: string): Promise<ReproductionAttempt> {
    return this.request('GET', `/v2/projects/${projectId}/reproduction-attempts/${attemptId}`)
  }

  /**
   * REPRO-01 §4: verifier service path — record the immutable report on an
   * attempt. Only reachable with the service token (x-service-token) plus
   * x-service-principal: verifier; the report is fenced by the attempt
   * generation + lease token from startReproductionAttempt.
   */
  reportReproductionAttempt(attemptId: string, input: ReproductionReportInput & {
    idempotency_key?: string
  }): Promise<ReproducibilityReport> {
    const { idempotency_key: idem, ...report } = input
    return this.request('POST', `/internal/reproduction-attempts/${attemptId}/reports`, report, {
      'x-service-principal': 'verifier',
      ...(idem !== undefined && idem !== '' ? { 'idempotency-key': idem } : {}),
    })
  }

  getReproductionReport(projectId: string, reportId: string): Promise<ReproducibilityReport> {
    return this.request('GET', `/v2/projects/${projectId}/reproduction-reports/${reportId}`)
  }

  // ── projects ─────────────────────────────────────────────────────────────

  createProject(input: {
    name: string
    workspace: string
    brief: unknown
    mode?: 'gate-only' | 'full-auto'
    constraints?: Record<string, unknown>
    execution?: Record<string, unknown>
    integrity?: Record<string, unknown>
    session_id?: string | null
    creator_principal_id?: string
    creator_tenant_id?: string
  }): Promise<ResearchProject> {
    return this.request('POST', '/v1/projects', input)
  }

  /** DSH-CREATE-LINK-01: service-only, name-only Init that atomically binds
   * the calling Host session. The principal is derived by the Kernel; callers
   * can provide neither a principal nor an arbitrary project id. */
  createProjectForDshSession(input: {
    session_id: string
    name: string
    idempotency_key: string
    /** Read an already committed idempotency receipt; never create if absent. */
    replay_only?: boolean
  }, signal?: AbortSignal): Promise<{
    project: ResearchProject
    intake: IntakeSession
    budget: Record<string, unknown>
    membership: Array<Record<string, unknown>>
    link: SessionLink
  }> {
    return this.request(
      'POST',
      `/internal/dsh-sessions/${encodeURIComponent(input.session_id)}/projects`,
      { name: input.name },
      {
        'x-service-principal': 'dsh-plugin',
        ...this.dshPluginToken !== undefined ? { 'x-dsh-plugin-token': this.dshPluginToken } : {},
        'idempotency-key': input.idempotency_key,
        ...input.replay_only === true ? { 'x-idempotency-replay-only': '1' } : {},
      },
      signal,
    )
  }

  /** Operator-owned projects offered by the DSH session binding panel. */
  listProjectsForDshSession(sessionId: string, signal?: AbortSignal): Promise<ResearchProject[]> {
    return this.request(
      'GET',
      `/internal/dsh-sessions/${encodeURIComponent(sessionId)}/project-options`,
      undefined,
      {
        'x-service-principal': 'dsh-plugin',
        ...this.dshPluginToken !== undefined ? { 'x-dsh-plugin-token': this.dshPluginToken } : {},
      },
      signal,
    )
  }

  /** Exclusively bind an existing operator-owned project to one DSH session. */
  linkProjectForDshSession(
    sessionId: string,
    projectId: string,
    signal?: AbortSignal,
  ): Promise<SessionLink> {
    return this.request(
      'POST',
      `/internal/dsh-sessions/${encodeURIComponent(sessionId)}/project-link`,
      { project_id: projectId },
      {
        'x-service-principal': 'dsh-plugin',
        ...this.dshPluginToken !== undefined ? { 'x-dsh-plugin-token': this.dshPluginToken } : {},
      },
      signal,
    )
  }

  listProjects(): Promise<ResearchProject[]> {
    return this.request('GET', '/v1/projects')
  }

  getProject(projectId: string): Promise<ResearchProject> {
    return this.request('GET', `/v1/projects/${projectId}`)
  }

  renameProject(projectId: string, name: string): Promise<ResearchProject> {
    return this.request('PATCH', `/v1/projects/${projectId}`, { name })
  }

  archiveProject(projectId: string): Promise<ResearchProject> {
    return this.request('POST', `/v1/projects/${projectId}/archive`)
  }

  unarchiveProject(projectId: string): Promise<ResearchProject> {
    return this.request('POST', `/v1/projects/${projectId}/unarchive`)
  }

  deleteProject(projectId: string, input: {
    expected_revision: number
    confirm_name: string
    reason: string
    principal_id: string
    request_id: string
  }): Promise<ProjectDeletionReceipt> {
    const { principal_id, request_id, ...body } = input
    return this.request('DELETE', `/v1/projects/${projectId}`, body, {
      'x-principal-id': principal_id,
      'x-request-id': request_id,
    })
  }

  projectProjection(projectId: string, signal?: AbortSignal): Promise<{
    project: ResearchProject
    pending_gates: Gate[]
    jobs: Array<{ job_id: string; kind: string; status: string }>
    budget: Record<string, unknown>
    counts: Record<string, number>
    next_actions: string[]
    /** GUIDE-01: structured next-step projection (kernel-authoritative). */
    next_actions_v2: Array<{
      id: string
      code: string
      label: string
      reason: string
      required: true | string[]
      route: string
      capability?: string
      revision: number | null
      state: 'ready' | 'blocked' | 'done'
      blocking: boolean
      refs: Array<{ kind: string; id: string }>
      required_by: 'human' | 'agent' | 'runner'
    }>
  }> {
    return this.request('GET', `/v1/projects/${encodeURIComponent(projectId)}/projection`, undefined, {}, signal)
  }

  /** Read the current question in a name-only project's deterministic Grill. */
  projectGrill(projectId: string, signal?: AbortSignal): Promise<ProjectGrillProjection> {
    return this.request('GET', `/v2/projects/${encodeURIComponent(projectId)}/grill`, undefined, {}, signal)
  }

  /** Persist one human answer selected through Scholar Chat or DSH's native question UI. */
  answerProjectGrill(projectId: string, input: {
    question_code: string
    question_revision: number
    value?: unknown
    disposition: 'answered' | 'skipped' | 'unknown'
  }, principalId: string, signal?: AbortSignal): Promise<ProjectGrillProjection> {
    return this.request('POST', `/v2/projects/${encodeURIComponent(projectId)}/grill/answers`, input, {
      'x-principal-id': principalId,
    }, signal)
  }

  transition(projectId: string, to: string, expectedRevision: number, reason?: string): Promise<ResearchProject> {
    return this.request('POST', `/v1/projects/${projectId}/transitions`, { to, expected_revision: expectedRevision, reason })
  }

  linkSession(sessionId: string, projectId: string): Promise<SessionLink> {
    return this.request('POST', `/v1/projects/${projectId}/session`, { session_id: sessionId })
  }

  getProjectBySession(sessionId: string, signal?: AbortSignal): Promise<ResearchProject | null> {
    return this.request('GET', `/v1/session-links/${encodeURIComponent(sessionId)}`, undefined, {}, signal)
  }

  // ── gates ────────────────────────────────────────────────────────────────

  createGate(input: { project_id: string; type: string; title: string; summary?: string; payload?: Record<string, unknown>; session_id?: string | null }): Promise<Gate> {
    return this.request('POST', `/v1/projects/${input.project_id}/gates`, input)
  }

  listGates(projectId: string): Promise<Gate[]> {
    return this.request('GET', `/v1/projects/${projectId}/gates`)
  }

  // ── artifacts ────────────────────────────────────────────────────────────

  registerArtifact(input: { project_id: string; kind: string; content_base64: string; metadata?: Record<string, unknown>; media_type?: string; file_name?: string }): Promise<ArtifactRecord> {
    return this.request('POST', '/v1/artifacts', input)
  }

  listArtifacts(projectId: string): Promise<ArtifactRecord[]> {
    return this.request('GET', `/v1/projects/${projectId}/artifacts`)
  }

  // ── onboarding intake (ONBOARD-01, research-onboarding.md) ────────────────
  // Agent-facing prepare pipeline: begin → stage → scan → answers → propose.
  // Adoption (adopt/reject) is NOT exposed here — the Agent surface stops at
  // propose (research-onboarding.md §2; only the Human PI/BFF path adopts).

  /** Create (or recover the single active) Intake session for a project. */
  beginIntake(projectId: string, input: {
    source_label: string
    target_phase?: ObservedPhase | null
    expires_in_ms?: number
    idempotency_key?: string
    request_hash?: string
  }): Promise<IntakeSession> {
    return this.request('POST', `/v1/projects/${projectId}/intake`, {
      source_label: input.source_label,
      target_phase: input.target_phase ?? null,
      expires_in_ms: input.expires_in_ms,
      idempotency_key: input.idempotency_key,
      request_hash: input.request_hash,
    })
  }

  listIntakes(projectId: string): Promise<IntakeSession[]> {
    return this.request('GET', `/v1/projects/${projectId}/intake`)
  }

  /** Full resumable intake state (session + artifacts + observations + questions + proposal). */
  intakeProjection(projectId: string, intakeId: string): Promise<IntakeProjection> {
    return this.request('GET', `/v1/projects/${projectId}/intake/${encodeURIComponent(intakeId)}`)
  }

  /**
   * Stage ONE file into the isolated intake staging CAS (multipart, ≤32 MiB,
   * server-computed sha256; identical bytes are content-addressed idempotent).
   * The client decodes base64 and builds the multipart body itself — no
   * project artifact row is written before adoption (pre-accept zero authority).
   */
  stageIntakeArtifact(projectId: string, intakeId: string, input: {
    file_name: string
    content_base64: string
    media_type?: string
  }): Promise<IntakeArtifact> {
    const bytes = Buffer.from(input.content_base64, 'base64')
    const boundary = `----dshScholarIntake${Date.now().toString(36)}${Math.random().toString(36).slice(2, 12)}`
    const mediaType = input.media_type ?? 'application/octet-stream'
    const crlf = Buffer.from('\r\n')
    const enc = (text: string): Buffer => Buffer.from(text, 'utf8')
    const chunks: Buffer[] = []
    const pushField = (name: string, value: string): void => {
      chunks.push(enc(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`))
    }
    pushField('file_name', input.file_name)
    pushField('media_type', mediaType)
    chunks.push(enc(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${input.file_name.replaceAll('"', '')}"\r\nContent-Type: ${mediaType}\r\n\r\n`))
    chunks.push(bytes, crlf, enc(`--${boundary}--\r\n`))
    const body = Buffer.concat(chunks)
    return this.requestRaw('POST', `/v1/projects/${projectId}/intake/${encodeURIComponent(intakeId)}/artifacts`, body, {
      'content-type': `multipart/form-data; boundary=${boundary}`,
    })
  }

  /** Deterministic static security scan; returns the resumable projection. */
  scanIntake(projectId: string, intakeId: string): Promise<IntakeProjection> {
    return this.request('POST', `/v1/projects/${projectId}/intake/${encodeURIComponent(intakeId)}/scan`)
  }

  /** Deterministic Grill Me question set for the session's target phase. */
  intakeQuestions(projectId: string, intakeId: string): Promise<{ questions: GrillAnswerView[] }> {
    return this.request('GET', `/v1/projects/${projectId}/intake/${encodeURIComponent(intakeId)}/questions`)
  }

  /** Record Grill Me answers (provenance recorded server-side per principal). */
  submitIntakeAnswers(projectId: string, intakeId: string, answers: GrillAnswerInput[], principal: HumanPrincipal): Promise<IntakeProjection> {
    return this.request('POST', `/v1/projects/${projectId}/intake/${encodeURIComponent(intakeId)}/answers`, { answers, principal })
  }

  /** Deterministic PhaseProposal; the intake then waits for a Human PI. */
  proposeIntake(projectId: string, intakeId: string): Promise<PhaseProposal> {
    return this.request('POST', `/v1/projects/${projectId}/intake/${encodeURIComponent(intakeId)}/propose`)
  }

  // ── ideas / contracts / corpus ───────────────────────────────────────────

  createIdea(input: Record<string, unknown>): Promise<IdeaCard> {
    return this.request('POST', `/v1/projects/${String(input.project_id)}/ideas`, input)
  }

  registerContract(input: Record<string, unknown>): Promise<ExperimentContract> {
    return this.request('POST', `/v1/projects/${String(input.project_id)}/contracts`, input)
  }

  snapshotCorpus(input: Record<string, unknown>): Promise<CorpusSnapshot> {
    return this.request('POST', `/v1/projects/${String(input.project_id)}/corpus`, input)
  }

  /**
   * §11.3 (SCH-EXEC-002): archive a project workspace's ACTUAL file contents
   * into a content-addressed `code` artifact (+ `manifest` artifact). The
   * Runner materializes jobs from this snapshot — never from agent host dirs.
   * P0-4 (SNAPSHOT-01/API-01): only `workspace_id` + a root-relative path are
   * accepted; `rootRelativePath` '' (default) archives the whole workspace.
   * The deprecated host-`path` shape is refused by the server (422).
   */
  snapshotCodeArchive(projectId: string, workspaceId: string, rootRelativePath = '', description?: string): Promise<{
    snapshot_id: string
    project_id: string
    path: string
    description: string
    archive_artifact_id: string
    manifest_artifact_id: string
    submodules_artifact_id: string | null
    lockfiles: string[]
    files: number
    total_bytes: number
    sha256: string
    created_at: string
  }> {
    return this.request('POST', `/v1/projects/${projectId}/code-snapshots`, { workspace_id: workspaceId, root_relative_path: rootRelativePath, description })
  }

  /** Read one project-scoped text node through the authoritative Workspace interface. */
  readWorkspaceNode(projectId: string, workspaceId: string, path: string): Promise<WorkspaceNode> {
    return this.request('GET', `/v1/projects/${encodeURIComponent(projectId)}/workspaces/${encodeURIComponent(workspaceId)}/nodes?path=${encodeURIComponent(path)}`)
  }

  /** CAS-write one text node; version 0 means create-if-absent. */
  writeWorkspaceNode(
    projectId: string,
    workspaceId: string,
    input: { path: string; content: string; expected_version?: number; expected_etag?: string },
  ): Promise<WorkspaceNode> {
    return this.request('POST', `/v1/projects/${encodeURIComponent(projectId)}/workspaces/${encodeURIComponent(workspaceId)}/nodes`, input)
  }

  /** CAS-delete one text node from a project-scoped workspace. */
  deleteWorkspaceNode(
    projectId: string,
    workspaceId: string,
    path: string,
    expected?: { version?: number; etag?: string },
  ): Promise<{ ok: true }> {
    const query = new URLSearchParams({ path })
    if (expected?.version !== undefined) query.set('expected_version', String(expected.version))
    if (expected?.etag !== undefined) query.set('expected_etag', expected.etag)
    return this.request('DELETE', `/v1/projects/${encodeURIComponent(projectId)}/workspaces/${encodeURIComponent(workspaceId)}/nodes?${query.toString()}`)
  }

  // ── jobs ─────────────────────────────────────────────────────────────────

  submitJob(input: {
    project_id: string
    idempotency_key: string
    kind: string
    command?: string[]
    payload?: Record<string, unknown>
    contract_id?: string | null
    // §12.2 JobSpec binding (SCH-EXEC-002).
    code_snapshot_id?: string | null
    data_artifact_ids?: string[]
    image_digest?: string
    output_contract?: { metrics: string; logs: string }
    runner_profile_id?: string | null
    runner_target_id?: string | null
    protocol_pin?: FrozenProtocolPin | null
    run_intent?: ResearchIntent
  }): Promise<JobSpecBound> {
    return this.request('POST', `/v1/projects/${input.project_id}/jobs`, input)
  }

  /**
   * Start a contract-bound baseline through the dedicated atomic endpoint.
   * The first run advances CONTRACT_APPROVED to BASELINE_REPRO in the same
   * transaction; additional matched-seed runs for that contract are created
   * through this method as well and never through generic Job submission.
   */
  startBaselineRun(input: {
    project_id: string
    expected_revision: number
    idempotency_key: string
    contract_id: string
    code_snapshot_id: string
    seed?: number
    data_artifact_ids?: string[]
    command: string[]
    runner_target_id?: string | null
    image_digest?: string
    output_contract?: { metrics: string; logs: string }
  }): Promise<{ project: ResearchProject; job: JobRecord }> {
    const { project_id: projectId, ...body } = input
    return this.request('POST', `/v1/projects/${encodeURIComponent(projectId)}/baseline-runs`, body)
  }

  getJob(jobId: string): Promise<JobRecord> {
    return this.request('GET', `/v1/jobs/${jobId}`)
  }

  listJobs(projectId: string): Promise<JobRecord[]> {
    return this.request('GET', `/v1/projects/${projectId}/jobs`)
  }

  completeJob(input: {
    job_id: string
    owner: string
    status: 'succeeded' | 'failed' | 'cancelled'
    run_manifest?: Record<string, unknown>
    failure_class?: string | null
    error?: string
    /** §12.6 lease fencing: pass the values returned by claimJobs to prove liveness. */
    lease_generation?: number | null
    lease_token?: string | null
  }): Promise<JobRecord> {
    return this.request('POST', `/v1/jobs/${input.job_id}/status`, input)
  }

  /** §12.6: heartbeat carries the claim's generation/token when available. */
  heartbeatJob(jobId: string, owner: string, leaseGeneration?: number | null, leaseToken?: string | null): Promise<JobRecord> {
    return this.request('POST', `/v1/jobs/${jobId}/heartbeat`, {
      owner,
      lease_generation: leaseGeneration ?? null,
      lease_token: leaseToken ?? null,
    })
  }

  cancelJob(jobId: string, actor: string, reason?: string): Promise<JobRecord> {
    return this.request('POST', `/v1/jobs/${jobId}/cancel`, { actor, reason })
  }

  /** execution-runtime.md §6: upload a batch of terminal frames (Runner side). */
  appendTerminalFrames(jobId: string, runId: string, frames: Array<{
    seq: number
    stream_seq?: number | null
    channel?: 'stdout' | 'stderr' | null
    text?: string | null
    byte_offset?: number | null
    byte_length?: number | null
    frame_kind: 'chunk' | 'gap' | 'exit'
    lease_generation?: number
    payload_json?: string
  }>): Promise<{ appended: number; last_seq: number }> {
    return this.request('POST', `/v1/jobs/${jobId}/terminal-frames`, { run_id: runId, frames })
  }

  claimJobs(
    owner: string,
    limit = 1,
    leaseTtlSeconds = 300,
    targetFilter?: {
      runner_target_kinds?: Array<'local-process' | 'local-docker' | 'remote-ssh'>
      runner_target_ids?: string[]
      include_unpinned?: boolean
    },
  ): Promise<JobRecord[]> {
    return this.request('POST', '/v1/jobs-claim/run', {
      owner,
      limit,
      lease_ttl_seconds: leaseTtlSeconds,
      ...(targetFilter ?? {}),
    })
  }

  /** §12.7: register a runner Ed25519 public key for manifest verification. */
  registerRunnerKey(input: { key_id: string; public_key_pem: string }): Promise<RunnerKey> {
    return this.request('POST', '/v1/runner-keys', input)
  }

  listRunnerKeys(): Promise<RunnerKey[]> {
    return this.request('GET', '/v1/runner-keys')
  }

  getRunnerTarget(targetId: string): Promise<{
    target_id: string
    display_name: string
    kind: 'local-process' | 'local-docker' | 'remote-ssh'
    enabled: boolean
    draining: boolean
    capabilities: string[]
    service_identity?: {
      scheme: 'file' | 'keyring' | 'vault'
      name: string
      version?: string
      scope?: string
      available: boolean
    }
    connection?: {
      endpoint: { scheme: 'file' | 'keyring' | 'vault'; name: string; version?: string; scope?: string; available: boolean }
      credential: { scheme: 'file' | 'keyring' | 'vault'; name: string; version?: string; scope?: string; available: boolean }
      known_hosts: { scheme: 'file' | 'keyring' | 'vault'; name: string; version?: string; scope?: string; available: boolean }
    }
    health: 'unknown' | 'online' | 'offline'
    revision: number
    config_hash: string
  }> {
    return this.request('GET', `/v1/runner-targets/${encodeURIComponent(targetId)}`)
  }

  heartbeatRunnerTarget(
    targetId: string,
    input: { expected_revision: number; health: 'online' | 'offline' },
  ): Promise<{
    target_id: string
    health: 'unknown' | 'online' | 'offline'
    last_seen_at: string | null
    revision: number
  }> {
    return this.request(
      'POST',
      `/v1/runner-targets/${encodeURIComponent(targetId)}/heartbeat`,
      input,
      this.runnerTargetToken === undefined ? {} : { 'x-runner-target-token': this.runnerTargetToken },
    )
  }

  recoverExpiredLeases(): Promise<{ recovered: number }> {
    return this.request('POST', '/v1/recover/leases')
  }

  // ── claims / evidence ────────────────────────────────────────────────────

  createClaim(input: { project_id: string; statement: string; scope?: Record<string, unknown> }): Promise<Claim> {
    return this.request('POST', `/v1/projects/${input.project_id}/claims`, input)
  }

  ingestEvidence(input: Record<string, unknown> & { provenance_status?: 'draft_unverified' | 'legacy_unverified' | 'verified' }): Promise<EvidenceItem> {
    return this.request('POST', `/v1/projects/${String(input.project_id)}/evidence`, input)
  }

  /**
   * §4 P0 (EVID-01): internal Analysis-Worker path — ingest evidence with
   * provenance 'verified'. Only reachable with the service token
   * (x-service-token) plus x-service-principal: analysis-worker; the public
   * route rejects 'verified' provenance (422).
   */
  ingestVerifiedEvidence(input: Record<string, unknown>): Promise<EvidenceItem> {
    return this.request('POST', `/v1/projects/${String(input.project_id)}/evidence/verified`, input, {
      'x-service-principal': 'analysis-worker',
    })
  }

  /**
   * §4 P0 (EVID-01): internal Verifier/Auditor path — transition verified →
   * accepted after full revalidation. Requires the service token plus
   * x-service-principal: verifier|auditor (defaults to verifier).
   */
  acceptEvidence(projectId: string, evidenceId: string, input: { request_id?: string; service_principal?: 'verifier' | 'auditor' } = {}): Promise<EvidenceItem> {
    const { service_principal: principal, ...body } = input
    return this.request('POST', `/v1/projects/${projectId}/evidence/${evidenceId}/accept`, body, {
      'x-service-principal': principal ?? 'verifier',
    })
  }

  /**
   * §4 P0 (API-01): internal orchestrator path — freeze a contract by the
   * simulate-Human-Gate-Decision approve route. Requires the service token.
   */
  approveContract(projectId: string, contractId: string, actor: string): Promise<ExperimentContract> {
    return this.request('POST', `/v1/projects/${projectId}/contracts/${contractId}/approve`, { actor })
  }

  verifyClaim(input: { claim_id: string; evidence_ids: string[]; analysis_artifact?: string; reason?: string }): Promise<Claim> {
    return this.request('POST', '/v1/claims/verify', input)
  }

  // ── ideas / corpus / manuscript ───────────────────────────────────────────

  listIdeas(projectId: string): Promise<IdeaCard[]> {
    return this.request('GET', `/v1/projects/${projectId}/ideas`)
  }

  getIdea(ideaId: string): Promise<IdeaCard> {
    return this.request('GET', `/v1/ideas/${ideaId}`)
  }

  updateIdeaNovelty(ideaId: string, audit: {
    queries: string[]
    result: 'no_direct_match_found' | 'overlap_found' | 'inconclusive'
    overlap_papers?: string[]
    unresolved_risk?: 'low' | 'medium' | 'high'
  }): Promise<IdeaCard> {
    return this.request('POST', `/v1/ideas/${ideaId}/novelty`, audit)
  }

  corpusSnapshots(projectId: string): Promise<CorpusSnapshot[]> {
    return this.request('GET', `/v1/projects/${projectId}/corpus-snapshots`)
  }

  buildManuscript(projectId: string, format: 'markdown' | 'latex', includeLimitations: boolean): Promise<{
    manuscript_id: string
    format: string
    text: string
    artifact_id: string
    claims_used: number
    bibtex: string
  }> {
    return this.request('POST', `/v1/projects/${projectId}/manuscripts/build`, { format, include_limitations: includeLimitations })
  }

  manuscriptReview(projectId: string): Promise<{
    checks: Array<{ check: string; status: 'pass' | 'warn' | 'fail'; detail: string }>
    pass: boolean
  }> {
    return this.request('GET', `/v1/projects/${projectId}/manuscript-review`)
  }

  releaseBundle(projectId: string): Promise<{
    bundle_id: string
    artifact_id: string
    contents: string[]
    release_gate: 'unapproved'
  }> {
    return this.request('POST', `/v1/projects/${projectId}/release-bundle`)
  }

  computeAnalysis(projectId: string, contractId?: string, metric?: string): Promise<{
    artifact_id: string
    contract_id: string | null
    metric: string
    runs: Array<{ run_id: string; job_id: string; value: number; seed?: number }>
    mean: number
    sd: number
    n: number
    ci_low: number
    ci_high: number
    baseline_value: number | null
    effect_size: number | null
  }> {
    return this.request('POST', `/v1/projects/${projectId}/analysis`, { contract_id: contractId, metric })
  }

  /** Read an artifact blob (text) from the CAS (project-scoped, v2 §7.4). */
  async fetchArtifact(projectId: string, sha256OrId: string): Promise<string | null> {
    const id = sha256OrId.startsWith('sha256:') ? sha256OrId : `sha256:${sha256OrId}`
    try {
      const response = await fetch(`${this.endpoint}/v1/artifacts/${encodeURIComponent(id)}?project_id=${encodeURIComponent(projectId)}`, {
        // §5 P0-1 (hardening API-01/SIDE-01): token-configured kernels reject
        // bearer-less requests with 401 — the client must authenticate here
        // exactly like the typed request() path above.
        headers: { ...this.token !== undefined ? { authorization: `Bearer ${this.token}` } : {} },
        signal: AbortSignal.timeout(10000),
      })
      if (!response.ok) return null
      return await response.text()
    } catch {
      return null
    }
  }

  /**
   * RUN-REMOTE-01（hardening §5 两行 / acceptance remote-cas-binary-auth）：
   * **字节流** CAS 拉取——`arrayBuffer()` 原样返回，绝不经过 `text()`/
   * UTF-8 编解码（随机二进制/PDF/压缩包/NUL 字节往返无损）。404 → null；
   * 其余非 2xx（含 token-configured kernel 的 401）抛 KernelApiError——
   * 调用方 fail fast，不把鉴权失败误判为 cas_missing。
   */
  async fetchArtifactBytes(projectId: string, sha256OrId: string): Promise<{ content: Buffer; media_type: string | null } | null> {
    const id = sha256OrId.startsWith('sha256:') ? sha256OrId : `sha256:${sha256OrId}`
    let response: Response
    try {
      response = await fetch(`${this.endpoint}/v1/artifacts/${encodeURIComponent(id)}?project_id=${encodeURIComponent(projectId)}`, {
        headers: { ...this.token !== undefined ? { authorization: `Bearer ${this.token}` } : {} },
        signal: AbortSignal.timeout(15000),
      })
    } catch (error) {
      throw new KernelUnavailableError(this.endpoint, error)
    }
    if (response.status === 404) return null
    if (!response.ok) {
      let detail = ''
      try {
        const parsed = await response.json() as { error?: { code?: string; message?: string } }
        detail = parsed.error?.message ?? ''
      } catch { /* keep empty */ }
      throw new KernelApiError(response.status, detail || `http_${response.status}`, detail || `request GET artifact ${id} failed`)
    }
    const mediaType = response.headers.get('content-type')
    return { content: Buffer.from(await response.arrayBuffer()), media_type: mediaType }
  }

  /** TeX workspace file content at the given path (TEX-02 runner materialization). */
  async getDocumentFile(documentId: string, path: string): Promise<{ path: string; version: number; content: string } | null> {
    try {
      const response = await fetch(`${this.endpoint}/v1/documents/${encodeURIComponent(documentId)}/file?path=${encodeURIComponent(path)}`, {
        headers: { accept: 'application/json', ...this.token !== undefined ? { authorization: `Bearer ${this.token}` } : {} },
        signal: AbortSignal.timeout(15000),
      })
      if (!response.ok) return null
      return await response.json() as { path: string; version: number; content: string }
    } catch {
      return null
    }
  }

  /**
   * TEX-01 (§4 row 95): FROZEN snapshot file bytes at a given revision —
   * the latex-compile build input. The Runner materializes from THIS, never
   * from getDocumentFile (the current file may have moved on since freeze).
   * null → the snapshot revision/path is not materializable: fail closed.
   */
  async getDocumentSnapshotFile(documentId: string, revision: number, path: string): Promise<{ path: string; content: string; content_hash: string } | null> {
    try {
      const response = await fetch(`${this.endpoint}/v1/documents/${encodeURIComponent(documentId)}/snapshot-files?revision=${revision}&path=${encodeURIComponent(path)}`, {
        headers: { accept: 'application/json', ...this.token !== undefined ? { authorization: `Bearer ${this.token}` } : {} },
        signal: AbortSignal.timeout(15000),
      })
      if (!response.ok) return null
      return await response.json() as { path: string; content: string; content_hash: string }
    } catch {
      return null
    }
  }

  // ── budget / events ──────────────────────────────────────────────────────

  recordUsage(projectId: string, usage: { model_cost_usd?: number; gpu_hours?: number; api_requests?: number }): Promise<Record<string, unknown>> {
    return this.request('POST', `/v1/projects/${projectId}/budget`, usage)
  }

  listEvents(projectId?: string): Promise<KernelEvent[]> {
    return this.request('GET', projectId === undefined ? '/v1/events' : `/v1/projects/${projectId}/events`)
  }

  // ── trajectory & subagent topology (TRAJ-01/SUBAGENT-01) ────────────────

  /** Read-only, redacted outbox projection (keyset pagination; single page
   * ≤ 500). `lane` filters Research vs Session; pass `next_after_seq` +
   * `next_after_event_id` from the previous page to continue. */
  projectTrajectory(projectId: string, opts: {
    after_seq?: number
    after_event_id?: string
    limit?: number
    lane?: 'research' | 'session'
  } = {}): Promise<{
    project_id: string
    entries: Array<{
      entry_id: string
      event_seq: number
      event_version: number
      project_id: string
      aggregate_type: string | null
      aggregate_id: string | null
      kind: string
      lane: 'research' | 'session'
      source: string
      occurred_at: string
      session_id: string | null
      summary: string
      status: string | null
    }>
    next_after_seq: number | null
    next_after_event_id: string | null
    has_more: boolean
    total: number
    limit: number
    lane: 'research' | 'session' | null
  }> {
    const query = new URLSearchParams()
    if (opts.after_seq !== undefined) query.set('after_seq', String(opts.after_seq))
    if (opts.after_event_id !== undefined) query.set('after_event_id', opts.after_event_id)
    if (opts.limit !== undefined) query.set('limit', String(opts.limit))
    if (opts.lane !== undefined) query.set('lane', opts.lane)
    const suffix = query.size > 0 ? `?${query.toString()}` : ''
    return this.request('GET', `/v1/projects/${projectId}/trajectory${suffix}`)
  }

  /** Research + Session lanes for one project (both always returned). */
  projectTrajectoryLanes(projectId: string, opts: { limit?: number } = {}): Promise<Record<string, unknown>> {
    const query = opts.limit !== undefined ? `?limit=${opts.limit}` : ''
    return this.request('GET', `/v1/projects/${projectId}/trajectory-lanes${query}`)
  }

  /** Exact direct children of a parent (or roots when parent_id omitted). */
  projectTopology(projectId: string, opts: {
    parent_id?: string | null
    after_seq?: number
    limit?: number
  } = {}): Promise<{
    project_id: string
    parent_id: string | null
    items: Array<{
      child_id: string
      project_id: string
      parent_id: string | null
      label: string | null
      summary: string
      kind: 'subagent' | 'task'
      mode: 'one-shot' | 'continuable' | 'read-only'
      state: string
      role: string | null
      started_at: string
      ended_at: string | null
      has_children: boolean
      children_count: number
      seq: number
      refs: Array<{ kind: string; id: string }>
    }>
    total: number
    next_after_seq: number | null
    has_more: boolean
  }> {
    const query = new URLSearchParams()
    if (opts.parent_id !== undefined && opts.parent_id !== null) query.set('parent_id', opts.parent_id)
    if (opts.after_seq !== undefined) query.set('after_seq', String(opts.after_seq))
    if (opts.limit !== undefined) query.set('limit', String(opts.limit))
    const suffix = query.size > 0 ? `?${query.toString()}` : ''
    return this.request('GET', `/v1/projects/${projectId}/topology${suffix}`)
  }

  /** Exact parent + breadcrumb for one child (opaque deep-link id). */
  childDetail(childId: string): Promise<{
    child_id: string
    project_id: string
    node: Record<string, unknown>
    parent: Record<string, unknown> | null
    breadcrumb: Array<Record<string, unknown>>
  }> {
    return this.request('GET', `/v1/topology/${encodeURIComponent(childId)}`)
  }

  /** Read-only per-child history (started/state/followup) — never activates
   * the child. */
  childHistory(childId: string, opts: { after_seq?: number; limit?: number } = {}): Promise<{
    child_id: string
    project_id: string
    items: Array<{
      seq: number
      event_id: string
      child_id: string
      type: string
      occurred_at: string
      summary: string
    }>
    next_after_seq: number | null
    has_more: boolean
    total: number
  }> {
    const query = new URLSearchParams()
    if (opts.after_seq !== undefined) query.set('after_seq', String(opts.after_seq))
    if (opts.limit !== undefined) query.set('limit', String(opts.limit))
    const suffix = query.size > 0 ? `?${query.toString()}` : ''
    return this.request('GET', `/v1/topology/${encodeURIComponent(childId)}/history${suffix}`)
  }

  /** One-shot READ-ONLY followup: records the message and returns
   * message_id WITHOUT executing it — child state never changes. */
  childFollowup(childId: string, message: string): Promise<{
    message_id: string
    child_id: string
    project_id: string
    accepted: boolean
    read_only: boolean
    state_unchanged: boolean
    note: string
  }> {
    return this.request('POST', `/v1/topology/${encodeURIComponent(childId)}/followup`, { message })
  }

  /** Record a spawned subagent child (research_panel wiring; the kernel
   * surface + unit tests cover the contract this round). */
  registerChildLink(input: {
    child_id: string
    parent_id?: string | null
    label?: string | null
    summary?: string
    kind?: 'subagent' | 'task'
    mode?: 'one-shot' | 'continuable' | 'read-only'
    role?: string | null
    state?: 'running' | 'inactive' | 'diagnostic' | 'succeeded' | 'failed' | 'cancelled' | 'redacted' | 'unknown'
  } & { project_id: string }): Promise<Record<string, unknown>> {
    const { project_id: projectId, ...body } = input
    return this.request('POST', `/v1/projects/${projectId}/topology/children`, body)
  }

  /** Transition a child's state (append-only history + outbox). */
  updateChildState(childId: string, state: 'running' | 'inactive' | 'diagnostic' | 'succeeded' | 'failed' | 'cancelled' | 'redacted' | 'unknown', detail?: string): Promise<Record<string, unknown>> {
    return this.request('PATCH', `/v1/topology/${encodeURIComponent(childId)}/state`, { state, ...detail === undefined ? {} : { detail } })
  }

  /** DSH host lifecycle bridge, fenced by service identity + exact linked
   * session. This does not impersonate a Human project principal. */
  registerChildLinkFromSession(input: {
    project_id: string
    child_id: string
    parent_id: string
    label?: string | null
    summary?: string
    kind?: 'subagent' | 'task'
    mode?: 'one-shot' | 'continuable' | 'read-only'
    role?: string | null
    state?: 'running'
    execution_identity?: ChildExecutionIdentity
  }, sessionId: string, signal?: AbortSignal): Promise<Record<string, unknown>> {
    const { project_id: projectId, ...body } = input
    return this.request(
      'POST',
      `/internal/projects/${encodeURIComponent(projectId)}/topology/children`,
      { ...body, session_id: sessionId },
      { 'x-service-principal': 'dsh-plugin' },
      signal,
    )
  }

  updateChildStateFromSession(
    childId: string,
    state: 'succeeded' | 'failed' | 'cancelled',
    sessionId: string,
    detail?: string,
    signal?: AbortSignal,
  ): Promise<Record<string, unknown>> {
    return this.request(
      'PATCH',
      `/internal/topology/${encodeURIComponent(childId)}/state`,
      { state, session_id: sessionId, ...detail === undefined ? {} : { detail } },
      { 'x-service-principal': 'dsh-plugin' },
      signal,
    )
  }
}
