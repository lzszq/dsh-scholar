/**
 * @dsh-scholar/analysis-engine — deterministic statistics engine.
 *
 * Implements the Analysis Worker of DSH Scholar v2.0 (design doc §12.5, §13,
 * §17.3): MetricSpec / RunSet / AnalysisPlan validation, fixed-schema metrics
 * file parsing, and a deterministic paired mean-difference analysis with a
 * seeded percentile bootstrap 95% CI.
 *
 * Design constraints honored here (reconstruction-contracts.md §12 is the
 * authoritative formula source):
 *  - One analysis = one contract × one metric (enforced by the API shape:
 *    an AnalysisPlan carries a single contract_id and a single MetricSpec).
 *  - Deterministic: the bootstrap RNG is a mulberry32 stream seeded from
 *    FNV-1a 32-bit over the UTF-8 canonical JSON of the plan + ordered run
 *    IDs + metric values, so repeated runs of the same analysis produce
 *    identical results on the same platform.
 *  - Production-fixed: bootstrap resamples are fixed at 10,000; numeric
 *    result values keep 12 significant decimals (round-half-to-even).
 *  - Self-contained: this numerical core owns and validates its statistics
 *    input/output contract, so both the Kernel port and out-of-process worker
 *    execute exactly the same engine without depending on application-layer
 *    research authority schemas.
 */

// ---------------------------------------------------------------------------
// Types (design §13.2 RunSet, §13.3 AnalysisPlan, §13.4 EvidenceItem result,
//        §12.5 metrics file)
// ---------------------------------------------------------------------------

export type MetricDirection = 'higher_is_better' | 'lower_is_better'
export type MetricAggregation = 'mean'
export type PairedBy = 'seed'
export type Estimator = 'paired_mean_difference'
export type IntervalMethod = 'bootstrap_95'
export type MultipleTestingMethod = 'holm'

/** §13.3 metric spec embedded in an AnalysisPlan. */
export interface MetricSpec {
  name: string
  direction: MetricDirection
  aggregation: MetricAggregation
  unit?: string
}

/** §13.2 validation flags — provided by the caller, never recomputed here. */
export interface RunSetValidation {
  seeds_unique: boolean
  min_completed_met: boolean
  same_code_snapshot: boolean
  same_data_hash: boolean
}

/** §13.2 RunSet. */
export interface RunSet {
  run_set_id?: string
  project_id?: string
  contract_id: string
  method: string
  metric: string
  runs: string[]
  validation: RunSetValidation
}

/** §13.3 analysis method block. */
export interface AnalysisPlanMethod {
  estimator: Estimator
  interval: IntervalMethod
  resamples: number
}

/** §13.3 AnalysisPlan. */
export interface AnalysisPlan {
  analysis_plan_id?: string
  contract_id: string
  metric: MetricSpec
  paired_by: PairedBy
  baseline_run_set_id: string
  treatment_run_set_id: string
  method: AnalysisPlanMethod
  multiple_testing: MultipleTestingMethod
  minimum_n: number
}

/** A single run's observed metric value, as handed to the statistics core. */
export interface PerRunMetric {
  run_id: string
  seed: number | string
  metric_value: number
}

/**
 * §13.4 EvidenceItem `result` shape produced by computePairedAnalysis, plus
 * `paired_mean_difference` (the estimator's primary output) and
 * `direction_ok` (whether the observed effect is in the direction the metric
 * declares good).
 */
export interface PairedAnalysisResult {
  metric: string
  direction: MetricDirection
  baseline_mean: number
  treatment_mean: number
  paired_mean_difference: number
  effect_size: number
  ci_low: number
  ci_high: number
  n_pairs: number
  raw_p_value: number
  adjusted_p_value: number
  direction_ok: boolean
}

/** §12.5 fixed metrics-file schema after parsing (unit stripped). */
export interface ParsedMetricsFile {
  run_id: string
  contract_id: string
  seed: number
  metrics: Array<{ name: string; value: number }>
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function fail(message: string): never {
  throw new Error(message)
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.length > 0
}

function isFiniteNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v)
}

function isPositiveInteger(v: unknown): v is number {
  return isFiniteNumber(v) && Number.isInteger(v) && v >= 1
}

function mean(values: number[]): number {
  if (values.length === 0) fail('mean of empty sample')
  let sum = 0
  for (const v of values) sum += v
  return sum / values.length
}

/**
 * Canonical JSON (reconstruction-contracts.md §2): UTF-8 text, object keys
 * recursively sorted lexicographically, arrays keep order, no extra
 * whitespace, finite JSON numbers only, -0 serialized as 0, undefined
 * properties omitted. Signature/hash/RNG seeds all use this same encoding.
 */
function canonicalJson(value: unknown): string {
  if (value === null) return 'null'
  if (typeof value === 'string') return JSON.stringify(value)
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) fail('canonical JSON: non-finite number')
    return Object.is(value, -0) ? '0' : String(value)
  }
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(',')}]`
  }
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>
    const keys = Object.keys(record)
      .filter((k) => record[k] !== undefined)
      .sort()
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(record[k])}`).join(',')}}`
  }
  fail('canonical JSON: unsupported value type')
}

/** FNV-1a 32-bit hash over raw bytes — stable across processes and platforms. */
function fnv1a32Bytes(bytes: Uint8Array): number {
  let h = 0x811c9dc5
  for (let i = 0; i < bytes.length; i++) {
    h ^= bytes[i] as number
    h = Math.imul(h, 0x01000193)
  }
  return h >>> 0
}

/**
 * Exact decimal expansion of a finite IEEE-754 double:
 * value = (±1) × digits × 10^exp10, digits a non-empty digit string with no
 * leading zeros (trailing zeros folded into exp10). Every double has a
 * terminating decimal expansion, so this is exact.
 */
function exactDecimal(value: number): { negative: boolean; digits: string; exp10: number } {
  if (!Number.isFinite(value)) fail('exactDecimal: non-finite value')
  if (value === 0) return { negative: Object.is(value, -0), digits: '0', exp10: 0 }
  const view = new DataView(new ArrayBuffer(8))
  view.setFloat64(0, value)
  const bits = view.getBigUint64(0)
  const negative = (bits >> 63n) === 1n
  const expBits = Number((bits >> 52n) & 0x7ffn)
  const fraction = bits & 0xfffffffffffffn
  let mantissa: bigint
  let exp2: number
  if (expBits === 0) {
    // subnormal: value = fraction × 2^-1074
    mantissa = fraction
    exp2 = -1074
  } else {
    // value = (1.fraction) × 2^(expBits - 1023) = mantissa × 2^(expBits - 1075)
    mantissa = fraction | 0x10000000000000n
    exp2 = expBits - 1075
  }
  let digits: string
  let exp10: number
  if (exp2 >= 0) {
    digits = (mantissa << BigInt(exp2)).toString()
    exp10 = 0
  } else {
    // value = mantissa × 2^exp2 = mantissa × 5^(-exp2) × 10^exp2 (exact integer digits)
    digits = (mantissa * 5n ** BigInt(-exp2)).toString()
    exp10 = exp2
  }
  while (digits.length > 1 && digits.endsWith('0')) {
    digits = digits.slice(0, -1)
    exp10 += 1
  }
  return { negative, digits, exp10 }
}

/** Rounds an exact digit string to `significant` digits, round-half-to-even. */
function roundDigitsHalfEven(digits: string, significant: number): string {
  if (digits.length <= significant) return digits
  const keep = digits.slice(0, significant)
  const rest = digits.slice(significant)
  let roundUp = false
  const firstRest = rest.charCodeAt(0) - 48
  if (firstRest > 5) roundUp = true
  else if (firstRest === 5) {
    const anyNonZero = /[1-9]/.test(rest.slice(1))
    if (anyNonZero) roundUp = true
    else roundUp = ((keep.charCodeAt(keep.length - 1) - 48) % 2) === 1 // exact tie → even
  }
  if (!roundUp) return keep
  const out: string[] = []
  let carry = 1
  for (let i = keep.length - 1; i >= 0; i--) {
    const d = (keep.charCodeAt(i) - 48) + carry
    if (d === 10) {
      out.unshift('0')
      carry = 1
    } else {
      out.unshift(String(d))
      carry = 0
    }
  }
  if (carry === 1) out.unshift('1')
  return out.join('')
}

/**
 * §12 result-number rule: every numeric value of the result JSON is kept at
 * 12 significant decimal digits before serialization, round-half-to-even,
 * and -0 is serialized as 0.
 */
function round12(value: number): number {
  if (value === 0) return 0
  const { negative, digits, exp10 } = exactDecimal(value)
  const rounded = roundDigitsHalfEven(digits, 12)
  // digits × 10^exp10 == rounded × 10^(exp10 + digits.length − rounded.length)
  const exponent = exp10 + digits.length - rounded.length
  const num = Number(`${negative ? '-' : ''}${rounded}e${exponent}`)
  return num === 0 ? 0 : num
}

/** mulberry32 PRNG — deterministic given the same 32-bit seed. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/**
 * Holm step-down multiple-testing adjustment (reconstruction-contracts.md
 * §12: `multiple_testing: holm`; ties ordered by metric name ascending,
 * adjusted p monotone step-down, capped at 1). For a single comparison this
 * engine analyzes one contract × one metric at a time, so it is the identity
 * — kept for API fidelity so callers can adjust across plans exactly as the
 * spec prescribes. `names` (one per p-value, e.g. metric names) breaks ties
 * by ascending name, per §12.
 */
export function holmAdjust(pValues: number[], names?: string[]): number[] {
  if (pValues.length === 0) fail('holmAdjust: empty p-value list')
  if (names !== undefined && names.length !== pValues.length) {
    fail('holmAdjust: names length must equal p-values length')
  }
  const m = pValues.length
  const indexed = pValues
    .map((p, i) => ({ p, name: names?.[i] ?? '', i }))
    .sort((a, b) => a.p - b.p || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
  const adjusted = new Array<number>(m)
  // Classic Holm step-down: process from the smallest p; the adjusted value
  // is the running maximum of the Bonferroni steps (monotone, capped at 1).
  let running = 0
  for (let k = 0; k < m; k++) {
    const entry = indexed[k] as { p: number; i: number }
    const step = Math.min(1, (m - k) * entry.p)
    running = Math.max(running, step)
    adjusted[entry.i] = running
  }
  return adjusted
}

// ---------------------------------------------------------------------------
// Validation (§13.2, §13.3)
// ---------------------------------------------------------------------------

/** Validates a MetricSpec; returns it narrowed, throws on invalid input. */
export function validateMetricSpec(value: unknown): MetricSpec {
  if (!isRecord(value)) fail('metric must be an object')
  if (!isNonEmptyString(value.name)) fail('metric.name must be a non-empty string')
  if (value.direction !== 'higher_is_better' && value.direction !== 'lower_is_better') {
    fail(`metric.direction must be 'higher_is_better' or 'lower_is_better', got ${JSON.stringify(value.direction)}`)
  }
  if (value.aggregation !== 'mean') {
    fail(`metric.aggregation must be 'mean' (only supported aggregation), got ${JSON.stringify(value.aggregation)}`)
  }
  if (value.unit !== undefined && typeof value.unit !== 'string') {
    fail('metric.unit must be a string when present')
  }
  return value as unknown as MetricSpec
}

/**
 * Validates a RunSet. `validation.min_completed_met` (and the other flags)
 * are provided by the caller as booleans — this engine only checks their
 * type, it never recomputes them.
 */
export function validateRunSet(value: unknown): RunSet {
  if (!isRecord(value)) fail('run_set must be an object')
  if (!isNonEmptyString(value.contract_id)) fail('run_set.contract_id must be a non-empty string')
  if (!isNonEmptyString(value.method)) fail('run_set.method must be a non-empty string')
  if (!isNonEmptyString(value.metric)) fail('run_set.metric must be a non-empty string')
  if (!Array.isArray(value.runs) || value.runs.length === 0) {
    fail('run_set.runs must be a non-empty array of run ids')
  }
  for (const r of value.runs) {
    if (!isNonEmptyString(r)) fail('run_set.runs entries must be non-empty strings')
  }
  if (!isRecord(value.validation)) fail('run_set.validation must be an object')
  const v = value.validation
  for (const key of ['seeds_unique', 'min_completed_met', 'same_code_snapshot', 'same_data_hash'] as const) {
    if (typeof v[key] !== 'boolean') {
      fail(`run_set.validation.${key} must be a boolean (caller-provided), got ${JSON.stringify(v[key])}`)
    }
  }
  return value as unknown as RunSet
}

/** Validates an AnalysisPlan; returns it narrowed, throws on invalid input. */
export function validateAnalysisPlan(value: unknown): AnalysisPlan {
  if (!isRecord(value)) fail('analysis_plan must be an object')
  if (!isNonEmptyString(value.contract_id)) fail('analysis_plan.contract_id must be a non-empty string')
  validateMetricSpec(value.metric)
  if (value.paired_by !== 'seed') fail(`analysis_plan.paired_by must be 'seed', got ${JSON.stringify(value.paired_by)}`)
  if (!isNonEmptyString(value.baseline_run_set_id)) fail('analysis_plan.baseline_run_set_id must be a non-empty string')
  if (!isNonEmptyString(value.treatment_run_set_id)) fail('analysis_plan.treatment_run_set_id must be a non-empty string')
  if (value.baseline_run_set_id === value.treatment_run_set_id) {
    fail('analysis_plan.baseline_run_set_id and treatment_run_set_id must differ')
  }
  if (!isRecord(value.method)) fail('analysis_plan.method must be an object')
  const m = value.method
  if (m.estimator !== 'paired_mean_difference') {
    fail(`analysis_plan.method.estimator must be 'paired_mean_difference', got ${JSON.stringify(m.estimator)}`)
  }
  if (m.interval !== 'bootstrap_95') {
    fail(`analysis_plan.method.interval must be 'bootstrap_95', got ${JSON.stringify(m.interval)}`)
  }
  // §12: bootstrap resamples are DEFAULT and PRODUCTION-FIXED at 10,000 — an
  // explicit value must equal 10,000 (the canonical AnalysisPlan type is
  // literal `resamples: 10000`; formal resamples cannot be arbitrarily
  // rewritten, §22 analysis.*). Absent means 10,000.
  if (m.resamples === undefined) {
    // defaulted to 10,000 by computePairedAnalysis
  } else if (!isPositiveInteger(m.resamples) || m.resamples !== 10000) {
    fail(`analysis_plan.method.resamples must be 10000 (production-fixed, §12), got ${JSON.stringify(m.resamples)}`)
  }
  if (value.multiple_testing !== 'holm') {
    fail(`analysis_plan.multiple_testing must be 'holm', got ${JSON.stringify(value.multiple_testing)}`)
  }
  if (!isPositiveInteger(value.minimum_n)) fail('analysis_plan.minimum_n must be a positive integer')
  return value as unknown as AnalysisPlan
}

// ---------------------------------------------------------------------------
// Metrics file parsing (§12.5)
// ---------------------------------------------------------------------------

/**
 * Parses a §12.5 fixed-schema metrics file (as produced by a Runner from the
 * container's metrics.json — never from arbitrary stdout text):
 *
 *   { "schema_version": 1, "run_id", "contract_id", "seed",
 *     "metrics": [{"name", "value", "unit"}] }
 *
 * Invalid schemas are rejected with an Error — never silently tolerated.
 * The returned shape strips `unit` (informational only).
 */
export function parseMetricsFile(content: string): ParsedMetricsFile {
  if (typeof content !== 'string') fail('metrics file content must be a string')
  let raw: unknown
  try {
    raw = JSON.parse(content)
  } catch (err) {
    fail(`metrics file is not valid JSON: ${(err as Error).message}`)
  }
  if (!isRecord(raw)) fail('metrics file must be a JSON object')
  if (raw.schema_version !== 1) fail('metrics file schema_version must be 1')
  if (!isNonEmptyString(raw.run_id)) fail('metrics file run_id must be a non-empty string')
  if (!isNonEmptyString(raw.contract_id)) fail('metrics file contract_id must be a non-empty string')
  if (!isFiniteNumber(raw.seed)) fail('metrics file seed must be a finite number')
  if (!Array.isArray(raw.metrics) || raw.metrics.length === 0) {
    fail('metrics file metrics must be a non-empty array')
  }
  const metrics: Array<{ name: string; value: number }> = []
  const seenNames = new Set<string>()
  for (const m of raw.metrics) {
    if (!isRecord(m)) fail('metrics file metric entries must be objects')
    if (!isNonEmptyString(m.name)) fail('metrics file metric name must be a non-empty string')
    // §12: each metric name is unique in a MetricsFileV1.
    if (seenNames.has(m.name)) fail(`metrics file has duplicate metric name "${String(m.name)}"`)
    seenNames.add(m.name)
    if (!isFiniteNumber(m.value)) fail(`metrics file metric "${String(m.name)}" value must be a finite number`)
    if (m.unit !== undefined && typeof m.unit !== 'string') {
      fail(`metrics file metric "${String(m.name)}" unit must be a string`)
    }
    metrics.push({ name: m.name as string, value: m.value as number })
  }
  return {
    run_id: raw.run_id as string,
    contract_id: raw.contract_id as string,
    seed: raw.seed as number,
    metrics,
  }
}

// ---------------------------------------------------------------------------
// Statistics core (§13.3, §13.4, §13.6)
// ---------------------------------------------------------------------------

/** Indexes per-run metrics by seed; rejects malformed entries and duplicates. */
function indexRuns(runs: PerRunMetric[], label: string): Map<string, PerRunMetric> {
  if (!Array.isArray(runs)) fail(`${label} must be an array of per-run metrics`)
  const map = new Map<string, PerRunMetric>()
  for (const run of runs) {
    if (!isRecord(run)) fail(`${label} entries must be objects {run_id, seed, metric_value}`)
    if (!isNonEmptyString(run.run_id)) fail(`${label} entry run_id must be a non-empty string`)
    const seed = run.seed
    if (typeof seed !== 'number' && typeof seed !== 'string') {
      fail(`${label} entry seed must be a number or a string`)
    }
    if (typeof seed === 'string' && seed.length === 0) fail(`${label} entry seed must be a non-empty string`)
    if (!isFiniteNumber(run.metric_value)) fail(`${label} entry metric_value must be a finite number`)
    const key = String(seed)
    if (map.has(key)) fail(`${label} has duplicate seed ${key} (run_set.validation.seeds_unique must be true)`)
    map.set(key, run as PerRunMetric)
  }
  return map
}

/**
 * Deterministic paired analysis of one contract × one metric
 * (reconstruction-contracts.md §12 — the authoritative formulas).
 *
 * Pairs baseline and treatment runs by seed, keeping only seeds present on
 * BOTH sides. Throws if the number of paired runs is below `plan.minimum_n`.
 * Computes, exactly per §12:
 *   - baseline_mean / treatment_mean over the paired runs (IEEE-754 double);
 *   - paired_mean_difference: mean of per-seed (treatment − baseline) diffs;
 *     lower_is_better only affects direction_ok, never the stored difference;
 *   - effect_size = paired_mean_difference (future standardized effects need
 *     a new schema version);
 *   - bootstrap 95% CI: `resamples` (= 10,000, production-fixed) resamples of
 *     the n_pairs differences with replacement, each replaced by its mean,
 *     sorted; low index = floor(0.025*(B−1)), high index = ceil(0.975*(B−1));
 *   - RNG: mulberry32 seeded with FNV-1a 32-bit over the UTF-8 bytes of the
 *     canonical JSON (recursive key order, §2) of the plan + ordered
 *     (seed-ascending) run IDs + metric values of both sides;
 *   - two-sided bootstrap p: pLow=(1+count(boot<=0))/(B+1),
 *     pHigh=(1+count(boot>=0))/(B+1), raw_p=min(1, 2*min(pLow,pHigh));
 *     a zero paired difference forces direction_ok=false and raw p=1;
 *   - adjusted_p_value: Holm step-down (identity for one metric; ties broken
 *     by metric name);
 *   - direction_ok: effect in the direction the metric declares good
 *     (higher_is_better ⇒ difference > 0; lower_is_better ⇒ difference < 0;
 *     zero ⇒ false);
 *   - every numeric result value is kept at 12 significant decimal digits
 *     (round-half-to-even) before serialization; -0 serializes as 0.
 */
export function computePairedAnalysis(
  plan: AnalysisPlan,
  baselineRuns: PerRunMetric[],
  treatmentRuns: PerRunMetric[],
): PairedAnalysisResult {
  const validatedPlan = validateAnalysisPlan(plan)
  const baseline = indexRuns(baselineRuns, 'baseline_runs')
  const treatment = indexRuns(treatmentRuns, 'treatment_runs')

  // Only seeds present on both sides are paired (§12: matched-seed design);
  // the pairing is canonicalized by seed ascending.
  const pairedSeeds = [...baseline.keys()].filter((seed) => treatment.has(seed)).sort()

  const nPairs = pairedSeeds.length
  if (nPairs < validatedPlan.minimum_n) {
    fail(
      `minimum_n not met: ${nPairs} paired runs found (minimum_n = ${validatedPlan.minimum_n})`,
    )
  }

  const baselineValues: number[] = []
  const treatmentValues: number[] = []
  const diffs: number[] = []
  for (const seed of pairedSeeds) {
    const b = baseline.get(seed) as PerRunMetric
    const t = treatment.get(seed) as PerRunMetric
    baselineValues.push(b.metric_value)
    treatmentValues.push(t.metric_value)
    diffs.push(t.metric_value - b.metric_value) // §12: treatment − baseline
  }

  const baselineMean = mean(baselineValues)
  const treatmentMean = mean(treatmentValues)
  const pairedMeanDifference = mean(diffs)

  // §12 RNG seed: FNV-1a 32-bit over the UTF-8 canonical JSON (recursive key
  // order, no extra whitespace — §2 "canonical JSON") of the plan plus the
  // ordered (seed-ascending) run IDs and metric values of both sides. The
  // same analysis is therefore bit-for-bit reproducible.
  const orderedSide = (side: Map<string, PerRunMetric>, values: number[]): { run_ids: string[]; metric_values: number[] } => {
    const runIds: string[] = []
    for (const seed of pairedSeeds) {
      runIds.push((side.get(seed) as PerRunMetric).run_id)
    }
    return { run_ids: runIds, metric_values: [...values] }
  }
  const seedDocument = {
    plan: validatedPlan,
    baseline: orderedSide(baseline, baselineValues),
    treatment: orderedSide(treatment, treatmentValues),
  }
  const rngSeed = fnv1a32Bytes(new TextEncoder().encode(canonicalJson(seedDocument)))
  const rng = mulberry32(rngSeed)

  // §12: bootstrap resamples are default and production-fixed at 10,000.
  const resamples = validatedPlan.method.resamples ?? 10000
  const B = resamples
  const bootstrapMeans = new Array<number>(B)
  let countLeZero = 0
  let countGeZero = 0
  for (let r = 0; r < B; r++) {
    let sum = 0
    for (let i = 0; i < nPairs; i++) {
      sum += diffs[Math.floor(rng() * nPairs)] as number
    }
    const bootMean = sum / nPairs
    bootstrapMeans[r] = bootMean
    if (bootMean <= 0) countLeZero++
    if (bootMean >= 0) countGeZero++
  }
  bootstrapMeans.sort((a, b) => a - b)

  // §12 95% percentile CI: index-based, not interpolated.
  const ciLow = bootstrapMeans[Math.floor(0.025 * (B - 1))] as number
  const ciHigh = bootstrapMeans[Math.ceil(0.975 * (B - 1))] as number

  // §12 two-sided bootstrap p-value:
  //   pLow  = (1 + count(boot <= 0)) / (B + 1)
  //   pHigh = (1 + count(boot >= 0)) / (B + 1)
  //   raw_p = min(1, 2 * min(pLow, pHigh)); zero difference ⇒ raw p = 1.
  let rawP: number
  if (pairedMeanDifference === 0) {
    rawP = 1
  } else {
    const pLow = (1 + countLeZero) / (B + 1)
    const pHigh = (1 + countGeZero) / (B + 1)
    rawP = Math.min(1, 2 * Math.min(pLow, pHigh))
  }
  const adjustedP = (holmAdjust([rawP], [validatedPlan.metric.name]) as [number])[0] as number

  const direction = validatedPlan.metric.direction
  const directionOk =
    direction === 'higher_is_better' ? pairedMeanDifference > 0 : pairedMeanDifference < 0

  // §12: key order strictly follows the PairedAnalysisResult declaration;
  // numeric values keep 12 significant decimals (round-half-to-even), -0 → 0.
  return {
    metric: validatedPlan.metric.name,
    direction,
    baseline_mean: round12(baselineMean),
    treatment_mean: round12(treatmentMean),
    paired_mean_difference: round12(pairedMeanDifference),
    effect_size: round12(pairedMeanDifference),
    ci_low: round12(ciLow),
    ci_high: round12(ciHigh),
    n_pairs: nPairs,
    raw_p_value: round12(rawP),
    adjusted_p_value: round12(adjustedP),
    direction_ok: directionOk,
  }
}
