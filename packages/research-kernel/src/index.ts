/**
 * @dsh-scholar/research-kernel — authoritative research state.
 * @module @dsh-scholar/research-kernel
 */

export { ResearchKernel, KernelError, validateUploadFileName, type KernelOptions, type IntegrityScanReport } from './kernel.js'
export { dshOperatorPrincipal } from './dsh-principal.js'
export {
  KernelSidecarLifecycle, SidecarIdentityError,
  type EndpointRecord, type KernelSidecarLifecycleOptions,
} from './sidecar-lifecycle.js'
export {
  FULL_AUTO_GATE_ALLOWLIST,
  FullAutoAuthorityReceiptSchema,
  FullAutoSurveyAuthorityContextSchema,
  FullAutoSurveyAuthorityReceiptSchema,
  FullAutoSurveyResultSchema,
  evaluateFullAutoGateAuthority,
  evaluateFullAutoSurveyAuthority,
  evaluateFullAutoSurveyAuthorityContext,
  fullAutoAuthorityHash,
  type FullAutoAuthorityEvaluation,
  type FullAutoAuthorityFailureCode,
  type FullAutoAuthorityInput,
  type FullAutoAuthorityReceipt,
  type FullAutoGateType,
  type FullAutoSurveyAuthorityEvaluation,
  type FullAutoSurveyAuthorityContext,
  type FullAutoSurveyAuthorityContextEvaluation,
  type FullAutoSurveyAuthorityContextInput,
  type FullAutoSurveyAuthorityInput,
  type FullAutoSurveyAuthorityReceipt,
  type FullAutoSurveyAuthorityReceiptBase,
  type FullAutoSurveyResult,
} from './full-auto.js'
export { assessRunnerEnvironment, RUNNER_TARGET_HEARTBEAT_TTL_MS, type RunnerEnvironmentAssessment, type RunnerEnvironmentFailure } from './runner-environment-readiness.js'
export {
  dispatchDeterministicAssuranceProducer,
  verifyAssurance,
  type DeterministicAssuranceCheck,
  type DeterministicAssuranceProducerResult,
  type AssuranceAuditAssessment,
  type AssuranceReason,
  type AssuranceVerificationReport,
} from './assurance.js'
export {
  ASSURANCE_DDL, AssuranceStore, AssuranceStoreError,
  type AcceptAssuranceAuditInput, type AssuranceAuditList, type AssuranceAuditView,
  type AssuranceProjectInput, type AssuranceProjectProjection, type RecordAssuranceAuditInput,
} from './assurance-store.js'
export {
  evaluateResearchMethodology,
  type DirectionAdoptionBlocker, type DirectionAdoptionReport,
  type InnerLoopBlocker, type InnerLoopStepReport,
  type ResearchMethodologyReport, type RunAdmissionBlocker, type RunAdmissionReport,
  type RunClassificationReport, type RunInterpretation,
  type SynthesisFreshnessReport, type SynthesisStaleReason,
  type SynthesisTriggerReason, type SynthesisTriggerReport,
} from './research-methodology.js'
export {
  buildResearchGraph,
  type ResearchGraphInput,
  type ResearchGraphProjection,
  type ResearchGraphNode,
  type ResearchGraphNodeKind,
  type ResearchGraphEdge,
  type ResearchGraphEdgeKind,
} from './research-graph.js'
export {
  resolveKnowledgeActivation,
  type KnowledgeActivationReason, type KnowledgeActivationResolution,
} from './knowledge-registry.js'
export {
  NATIVE_KNOWLEDGE_PACKS, findNativeKnowledgePack, nativeKnowledgeSha256, verifyNativeKnowledgePack,
  type NativeInstructionPayload, type NativeKnowledgePack, type NativePackIntegrityReason,
} from './native-knowledge-packs.js'
export {
  resolveKnowledgeDelivery,
  type KnowledgeDeliveryActivation, type KnowledgeDeliveryContext,
  type KnowledgeDeliveryDeactivation, type KnowledgeDeliveryItem,
  type KnowledgeDeliverySnapshot, type KnowledgeDeliverySuppressionReason,
} from './knowledge-delivery.js'
export {
  assessWritingMethodology,
  writingTexSha256,
  writingClaimEvidenceSha256,
  type ClaimEvidenceGap, type WritingFreshnessAssessment,
  type WritingMethodologyReport, type WritingStaleReason,
} from './writing-methodology.js'
export {
  activateSectionGuide, aggregateWritingReviewerPanel, assessMethodTriad, writingFileSha256,
} from './writing-review.js'
export {
  WRITING_REVIEW_DDL, WritingReviewStore, WritingReviewStoreError,
  type StoredMethodTriad, type WritingReviewRecordList, type WritingReviewRecordView,
} from './writing-review-store.js'
export {
  METHODOLOGY_DDL, MethodologyStore, MethodologyStoreError, protocolRevisionCanonicalHash,
  type DirectionAdoptionWrite, type DirectionProposalWrite,
  type KnowledgeActivationWrite, type KnowledgeDeactivationWrite, type KnowledgeEvaluationWrite,
  type KnowledgePackageWrite, type MethodologyRecordList,
  type MethodologyRecordView, type MethodologyRegistryRecordList,
  type MethodologyRegistryRecordView, type MethodologyWritingProjection,
  type ProtocolRevisionWrite, type ResearchSynthesisWrite,
  type ReverseOutlineWrite, type ReviewFindingWrite, type StoredKnowledgeActivation, type StoredKnowledgeDeactivation,
  type WritingProjectionInput,
} from './methodology-store.js'
export { WorkspaceModule } from './workspace-module.js'
export { createStartupBackup, type StartupBackupResult } from './backup.js'
export {
  adoptLegacyKernelData, kernelDatabaseNeedsMigration,
  type AdoptLegacyKernelDataOptions, type KernelDataAdoptionReceipt,
} from './data-upgrade.js'
export { nextActionProjection, INTAKE_ACTIVE_STATUSES, type NextActionContext, type NextActionJob, type NextActionIntake, type NextActionReproduction, type NextActionMethodology, type NextActionRunObservation, type NextActionSynthesisRequest, type NextActionRoute } from './next-action.js'
export {
  buildRunOutcomeObservation,
  buildSynthesisRecordRequest,
  canonicalManifestSha256,
  listRunOutcomeObservationLedger,
  listSynthesisRecordRequests,
  observesResearchOutcome,
} from './run-outcome-lifecycle.js'
export {
  assertSynthesisRequestAdmission,
  SynthesisAdmissionError,
} from './synthesis-admission.js'
export { REPRODUCTION_DDL, reproductionCanonicalJson, reproductionSha256 } from './reproduction.js'
export {
  compareMetric, compareMetrics, compareTable, compareTables, compareFigure, compareFigures, compareManuscript,
  comparisonGroupChecks, evaluateReportStatus, suggestFailureClass,
  type MetricActual, type TableExpected, type TableActual, type FigureExpected, type FigureActual,
  type ManuscriptExpected, type ManuscriptActual,
} from './reproduction-compare.js'
export {
  INTAKE_DDL, GRILL_TAXONOMY_VERSION, GRILL_QUESTION_REVISION, INTAKE_DEFAULT_TTL_MS, INTAKE_STAGED_TTL_MS,
  GRILL_QUESTION_BANK, questionsForTargetPhase, requiredQuestionCodes, scanIntakeArtifactStatic,
  artifactKindForFile, isImportableMetricsFile, parseMetricsFileV1, buildPhaseProposal, questionViews,
  SAFE_PHASE_LANDING, isTexMaterializableFile, isCodeMaterializableFile,
  TEX_MATERIALIZE_EXTENSIONS, CODE_MATERIALIZE_EXTENSIONS, ARCHIVE_SCAN_EXTENSIONS, INTAKE_ARCHIVE_EXTENSIONS,
  type GrillQuestionDef, type StaticScanVerdict, type PhaseLanding, type ParsedMetricsFile,
} from './intake.js'
export {
  scanArchive, extractArchiveEntries, archiveKindOf, ArchiveScanError, DEFAULT_ARCHIVE_LIMITS,
  type ArchiveKind, type ArchiveLimits, type ArchiveScanEntry, type ArchiveScanResult, type ArchiveScanErrorCode,
} from './archive-scan.js'
export { IMAGES_LOCK, getLockedDigest, validateImageDigest, type ImagesLock, type LockedImageKind, type SecureJobKind } from './images-lock.js'
export { parseLatexDiagnostics, type LatexDiagnostic } from './tex-diagnostics.js'
export { startKernelServer, runnerTargetTokenAccessAllowed, type KernelServerOptions } from './server.js'
export { ArtifactCas, type CasInventoryEntry } from './cas.js'
export { MetricsStore, HISTOGRAM_BUCKETS, type MetricsSnapshot, type CounterView, type HistogramView, type HistogramBucket, type MetricTags } from './metrics.js'
export {
  DEFAULT_METHODOLOGY_ROLLOUT_POLICY,
  METHODOLOGY_ROLLOUT_DDL,
  MethodologyRolloutStore,
  MethodologyRolloutStoreError,
} from './rollout-policy.js'
export { MethodologyTelemetry, type RedactedMethodologyMetrics } from './methodology-telemetry.js'
export {
  KnowledgeMethodologyCoordinator,
  SynthesisMethodologyCoordinator,
  WritingMethodologyCoordinator,
  type KnowledgeMethodologyPorts,
  type SynthesisMethodologyPorts,
  type WritingMethodologyPorts,
  type MethodologyFailure,
} from './methodology-coordinator.js'
export { openDatabase, SCHEMA_VERSION } from './store.js'
export {
  CONFIG_WRITE_DDL, ConfigWriteStore, ConfigWriteStoreError,
  type ConfigWriteProjectAuthority, type ConfigWriteStoreOptions,
} from './config-write-store.js'
export {
  SettingsWriteCoordinator,
  type SettingsWritePorts,
} from './settings-write-coordinator.js'
export { runMigrations, MIGRATIONS, checksumOf } from './migrations.js'
export { OCR_DDL, OcrStore, OcrStoreError, type PinnedOcrRequest } from './ocr-store.js'
export { deterministicAnalysisPort, type AnalysisPort } from './analysis-port.js'
export {
  MinerUOcrWorker, MinerUTransportError,
  type MinerUOcrTransport, type MinerUExtractInput, type MinerUExtractResult,
  type MinerUTransportBinding, type OcrSourceBytes, type OcrWorkerKernelPort,
} from './ocr-worker.js'
export {
  openPtySessionStore, PtySessionStore, PtyError, NullPtyAdapter,
  PTY_CURRENT_DDL, PTY_DDL, PTY_SESSIONS_TABLE_DDL,
  PTY_DEFAULT_IDLE_TTL_S, PTY_DEFAULT_RETENTION_BYTES, PTY_DEFAULT_LEASE_TTL_S,
  type PtyAdapter, type PtySpawnPlan, type PtyControlResult, type PtyAppendResult, type PtySessionRow,
} from './pty-session.js'
export {
  PtyContextError, resolvePtyContext, projectPtyContext,
  type PtyContextAuthoritySource, type PtyResolvedContext, type PtyTargetKind,
} from './pty-context.js'
export {
  LocalPtyAdapter, PTY_SHELL_PRESETS,
  type LocalPtyAdapterOptions, type PtyOutputInput,
} from './pty-local.js'
export {
  openWorkspaceStore, WorkspaceStore, WorkspaceError, normalizeWorkspacePath, mediaTypeOf, withImpliedDirs, EMPTY_CONTENT_HASH,
  matchWorkspaceGlob, HISTORY_KEEP_VERSIONS, WORKSPACE_MAX_FILE_BYTES,
  type WorkspaceStoreLike, type WorkspaceExpected, type WorkspaceIntegrityIssue, type WorkspaceIntegrityReport,
} from './workspace-store.js'
export { TexWorkspaceFacade, texWorkspaceId, texDocumentId, texInfoToWorkspaceInfo, texEntryToWorkspaceNode } from './tex-facade.js'
export {
  TrajectoryStore, laneForKind, redactTrajectorySummary, summaryForKind, statusForKind,
  TRAJECTORY_DDL, TRAJECTORY_PAGE_LIMIT_DEFAULT, TRAJECTORY_PAGE_LIMIT_MAX, TRAJECTORY_SUMMARY_MAX_CHARS,
  BREADCRUMB_MAX_DEPTH,
} from './trajectory.js'
