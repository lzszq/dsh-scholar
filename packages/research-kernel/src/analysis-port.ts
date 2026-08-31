/**
 * Narrow deterministic-analysis port used by the authoritative Kernel.
 *
 * The process-oriented analysis worker is an outer adapter. Both it and the
 * Kernel's in-process composition use the lower-level analysis engine, so
 * the Kernel never imports or depends on a worker package.
 */
import {
  computePairedAnalysis,
  type AnalysisPlan,
  type PairedAnalysisResult,
  type PerRunMetric,
} from '@dsh-scholar/analysis-engine'

export interface AnalysisPort {
  computePaired(
    plan: AnalysisPlan,
    baselineRuns: PerRunMetric[],
    treatmentRuns: PerRunMetric[],
  ): PairedAnalysisResult
}

/** Default desktop composition. Tests and alternate deployments can inject
 * another exact-contract adapter without coupling the Kernel to transport or
 * worker lifecycle concerns. */
export const deterministicAnalysisPort: AnalysisPort = {
  computePaired: computePairedAnalysis,
}
