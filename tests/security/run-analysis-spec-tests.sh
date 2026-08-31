#!/usr/bin/env bash
# §12 (reconstruction-contracts.md) analysis-spec conformance + manuscript
# evidence-provenance tests — REAL end-to-end (kernel + runner --mode docker
# + node:22-alpine; no echo jobs, no forged metrics).
#
#   analysis-spec-effect-identity    effect_size == treatment_mean −
#                                    baseline_mean (±1e-9), asserted BOTH on
#                                    the full-precision recomputation from the
#                                    real container metrics AND on the
#                                    response numbers (§12: paired estimator
#                                    = treatment − baseline; effect_size is
#                                    the paired mean difference)
#   analysis-spec-direction          direction_ok semantics (§12: higher_is_
#                                    better + positive effect ⇒ true; the
#                                    stored difference is never sign-flipped)
#   analysis-spec-ci-rule            ci_low/ci_high recomputed from an
#                                    INDEPENDENT mirror of the §12 canonical
#                                    RNG rule — FNV-1a 32-bit over the UTF-8
#                                    canonical JSON (recursive key order) of
#                                    plan + ordered (seed-ascending) run IDs +
#                                    metric values, mulberry32, B=10,000,
#                                    index-based CI low=floor(0.025*(B−1)) /
#                                    high=ceil(0.975*(B−1)) — must equal the
#                                    response (worker internal consistency
#                                    with the golden vector rule; exact values
#                                    differ because the inputs differ)
#   analysis-repeat-byte-identical   POST /analysis twice → artifact content
#                                    byte-identical (kept from the existing
#                                    consistency suite)
#   manuscript-excludes-draft-evidence  public-route draft evidence + claim →
#                                    verify → inconclusive → manuscript
#                                    claims_used=0 and the claim statement is
#                                    absent from the text; a full verified →
#                                    accepted chain (analysis-worker identity,
#                                    real analysis artifact refs + real run
#                                    ids, verifier accept) → supported →
#                                    claims_used=1 and the statement appears
#
# Pipeline driven against REAL runs: 3 baseline jobs (baseline.js) + 3 formal
# jobs (train.js), seeds 1/2/3, bound to an approved contract whose
# stop_conditions.min_completed_seeds = 3 (§12 minimum_n is contract-driven)
# and a CAS code snapshot archived from a runtime COPY of
# evals/golden-path-v2/fixture-repo. The copy changes ONE constant in
# train.js — the treatment arm's seed coefficient 0.01 → 0.02 (baseline.js
# keeps 0.01) — so the paired effect is +0.01*seed and the bootstrap CI /
# p-value are NON-degenerate (a zero effect would make the determinism and
# CI-rule assertions vacuous). evals/ is untouched; the copy is created and
# archived at runtime.
#
# Usage: bash tests/security/run-analysis-spec-tests.sh
set -eu

REPO=$(cd "$(dirname "$0")/../.." && pwd)
if [ ! -f "$REPO/packages/research-kernel/lib/bin/kernel.js" ] && [ -f "$PWD/packages/research-kernel/lib/bin/kernel.js" ]; then
  REPO=$PWD
fi
if [ ! -f "$REPO/packages/research-kernel/lib/bin/kernel.js" ]; then
  echo "run-analysis-spec-tests: cannot locate repo root (tried '$REPO' and '$PWD')" >&2
  exit 1
fi
FIXTURE="$REPO/evals/golden-path-v2/fixture-repo"
KERNEL_BIN="$REPO/packages/research-kernel/lib/bin/kernel.js"
RUNNER_BIN="$REPO/workers/runner-gateway/lib/bin/runner.js"
WORK=$(mktemp -d)
PORT=""
KERNEL_PID=""
RUNNER_PID=""
PASS=0
FAIL=0

say() { printf '\033[1;34m== %s ==\033[0m\n' "$*"; }
ok()  { printf '\033[1;32m  ok: %s\033[0m\n' "$*"; PASS=$((PASS + 1)); }
bad() { printf '\033[1;31m  FAIL: %s\033[0m\n' "$*"; FAIL=$((FAIL + 1)); }
# §4 P0 (API-01/EVID-01): the kernel runs with the fixed eval service token;
# internal calls (verified/accept) carry x-service-token via the helper (same
# practice as run-evidence-tests.sh).
export DSH_SCHOLAR_SERVICE_TOKEN='dsh-scholar-eval-service-token'
api() { curl -sf -H 'content-type: application/json' -H "x-service-token: $DSH_SCHOLAR_SERVICE_TOKEN" "$@"; }
human_decide() { api -H 'x-service-principal: standalone-human-bff' -X POST "$BASE/internal/human-gates/$1/decisions" -d "$2"; }
# P0-4: code snapshots are workspace-bound — shared helpers seed the fixture
# into a project workspace and POST workspace_id + root_relative_path.
# shellcheck source=../../evals/code-snapshot-lib.sh
source "$REPO/evals/code-snapshot-lib.sh"
# shellcheck source=formal-fixture-lib.sh
source "$REPO/tests/security/formal-fixture-lib.sh"

jfield() { node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{try{const v=JSON.parse(d);console.log(v$1 ?? '')}catch(e){console.log('')}})" ; }

cleanup() {
  [[ -n "$RUNNER_PID" ]] && kill -9 "$RUNNER_PID" 2>/dev/null || true
  [[ -n "$KERNEL_PID" ]] && kill -9 "$KERNEL_PID" 2>/dev/null || true
  [[ -n "$RUNNER_PID" ]] && wait "$RUNNER_PID" 2>/dev/null || true
  [[ -n "$KERNEL_PID" ]] && wait "$KERNEL_PID" 2>/dev/null || true
  rm -rf "$WORK"
}
trap cleanup EXIT

formal_fixture_init_target_identity "$WORK" 'analysis-spec-target-token-v1-0001'

echo "== prerequisites =="
if ! docker info > /dev/null 2>&1; then
  echo "run-analysis-spec-tests: docker runtime not available (runner --mode docker is required) — run: sudo systemctl start docker" >&2
  exit 2
fi
ok "docker runtime reachable (server $(docker version --format '{{.Server.Version}}' 2>/dev/null || echo '?'))"
if ! docker image inspect node:22-alpine > /dev/null 2>&1; then
  docker pull node:22-alpine > /dev/null 2>&1 || { echo "run-analysis-spec-tests: failed to pull node:22-alpine" >&2; exit 2; }
fi
IMG='node@sha256:c610fcdfb1d5b4740dd70c284ed3cb16bb857e0f7166196e36a5501df7a3aa32'
if ! docker image inspect "$IMG" > /dev/null 2>&1; then
  echo "run-analysis-spec-tests: trusted image $IMG not present locally" >&2
  exit 2
fi
ok "node:22-alpine image present (trusted digest $IMG)"

echo "== kernel + runner (--mode docker, --poll-ms 200) on a random port =="
start_kernel() {
  local port
  for port in $((20000 + $$ % 400)) $((20500 + $$ % 400)) $((21000 + $$ % 400)); do
    PORT=$port
    nohup node "$KERNEL_BIN" --db "$WORK/kernel.db" --cas "$WORK/cas" --secret-root "$FORMAL_FIXTURE_SECRET_ROOT" --port "$PORT" > "$WORK/kernel.log" 2>&1 &
    KERNEL_PID=$!
    for _ in $(seq 1 50); do
      kill -0 "$KERNEL_PID" 2>/dev/null \
        && curl -sf "http://127.0.0.1:$PORT/v1/health" > /dev/null 2>&1 \
        && return 0
      sleep 0.1
    done
    kill -9 "$KERNEL_PID" 2>/dev/null || true
    wait "$KERNEL_PID" 2>/dev/null || true
    KERNEL_PID=""
  done
  return 1
}
start_kernel || { echo "kernel failed to start"; exit 1; }
BASE="http://127.0.0.1:$PORT"
ok "kernel healthy on port $PORT"
DSH_SCHOLAR_RUNNER_TARGET_TOKEN="$FORMAL_FIXTURE_RUNNER_TARGET_TOKEN" nohup node "$RUNNER_BIN" --kernel "$BASE" --owner analysis-spec --poll-ms 200 --mode docker --target-id "$FORMAL_FIXTURE_TARGET_ID" --timeout-ms 30000 > "$WORK/runner.log" 2>&1 &
RUNNER_PID=$!
if formal_fixture_wait_runner_ready "$BASE"; then
  ok "runner started and target-scoped heartbeat is online (mode=docker, poll-ms=200)"
else
  bad "runner target never became ready"; tail -20 "$WORK/runner.log" || true; exit 1
fi

echo "== project + contract (stop_conditions.min_completed_seeds=3, direction higher_is_better) =="
BRIEF='{"problem":"p","scope":"s","questions":[],"primary_metrics":["m1"],"resources":"","risks":[],"target_outputs":["paper"],"target_venue":null,"baseline_repo":"fixture-repo","domain":"machine-learning"}'
PROJ=$(api -X POST "$BASE/v1/projects" -d "{\"name\":\"analysis-spec\",\"workspace\":\"/w\",\"brief\":$BRIEF,\"creator_principal_id\":\"analysis-spec-pi\",\"execution\":{\"runner_profile_id\":\"profile_local_docker_cpu_v1\"}}" | jfield '.project_id')
[[ -n "$PROJ" ]] || { echo "failed to create project"; exit 1; }
ok "project $PROJ"

# Reach CONTRACT_PENDING through the authoritative gate lifecycle. This
# ensures every baseline below uses the same atomic handoff as the product.
G_SCOPE=$(api -X POST "$BASE/v1/projects/$PROJ/gates" -d '{"type":"scope","title":"Analysis spec scope"}' | jfield '.gate_id')
human_decide "$G_SCOPE" '{"actor":"analysis-spec","principal":{"principal_id":"analysis-spec-pi"},"decision":"approved"}' > /dev/null
for PHASE in SURVEYING IDEATING; do
  REV=$(api "$BASE/v1/projects/$PROJ" | jfield '.revision')
  api -X POST "$BASE/v1/projects/$PROJ/transitions" -d "{\"to\":\"$PHASE\",\"expected_revision\":$REV}" > /dev/null
done
G_IDEA=$(api -X POST "$BASE/v1/projects/$PROJ/gates" -d '{"type":"idea","title":"Analysis spec idea"}' | jfield '.gate_id')
human_decide "$G_IDEA" '{"actor":"analysis-spec","principal":{"principal_id":"analysis-spec-pi"},"decision":"approved"}' > /dev/null
REV=$(api "$BASE/v1/projects/$PROJ" | jfield '.revision')
api -X POST "$BASE/v1/projects/$PROJ/transitions" -d "{\"to\":\"CONTRACT_PENDING\",\"expected_revision\":$REV}" > /dev/null

CT=$(api -X POST "$BASE/v1/projects/$PROJ/contracts" -d '{"idea_id":"idea_spec","data":{"dataset_id":"fixture","version":"v1","split":"official"},"methods":{"baseline":"baseline-engine","treatment":"treatment-engine"},"metrics":{"primary":"m1","secondary":["n_samples","m2"],"direction":"higher_is_better"},"seeds":[1,2,3],"analysis":{"effect_size":"mean_difference","interval":"bootstrap_95","multiple_testing":"holm"},"stop_conditions":{"max_gpu_hours":2,"min_completed_seeds":3,"stop_on_data_leakage":true}}' | jfield '.contract_id')
G_CONTRACT=$(api -X POST "$BASE/v1/projects/$PROJ/gates" -d "{\"type\":\"contract\",\"title\":\"Analysis spec Contract\",\"payload\":{\"contract_id\":\"$CT\"}}" | jfield '.gate_id')
human_decide "$G_CONTRACT" '{"actor":"analysis-spec","principal":{"principal_id":"analysis-spec-pi"},"decision":"approved"}' > /dev/null
APPROVE=$(api "$BASE/v1/projects/$PROJ/contracts" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{const c=JSON.parse(d).find(x=>x.contract_id==='$CT');console.log(c?.status??'')})")
if [[ "$CT" == expc_* ]] && [[ "$APPROVE" == "approved" ]]; then
  ok "contract $CT registered + frozen (status=approved, direction higher_is_better, seeds 1..3, min_completed_seeds=3)"
else
  bad "contract registration/approval failed: id='$CT' status='$APPROVE'"
fi

echo "== code snapshot: runtime copy of fixture-repo (train.js treatment arm: seed coeff 0.02) =="
cp -r "$FIXTURE" "$WORK/fixture"
sed -i 's/0.5 + 0.01 \* seed + 0.1 \* weightedSum/0.5 + 0.02 * seed + 0.1 * weightedSum/' "$WORK/fixture/train.js"
if grep -q '0.02 \* seed + 0.1 \* weightedSum' "$WORK/fixture/train.js" && grep -q '0.01 \* seed + 0.1 \* weightedSum' "$WORK/fixture/baseline.js"; then
  ok "snapshot source prepared: baseline.js (0.01 coeff) vs train.js (0.02 coeff) -> nonzero paired effect"
else
  bad "snapshot source preparation failed (train.js patch not applied)"
fi
# P0-4 (SNAPSHOT-01/API-01): seed the fixture into an approved project
# workspace and archive via workspace_id + root_relative_path (server-
# side root resolution — the old host-`path` shape is refused with 422).
AN_WS=$(code_snapshot_seed_workspace "$PORT" "$PROJ" "fixture" "$WORK/fixture")
SNAP=$(code_snapshot_api "$PORT" "$PROJ" "$AN_WS" "" "analysis-spec fixture")
CODE_ART=$(printf '%s' "$SNAP" | jfield '.archive_artifact_id')
if [[ "$CODE_ART" == sha256:* ]]; then
  ok "code snapshot archived from CAS: $CODE_ART"
else
  bad "code snapshot archive failed: $SNAP"
fi

DATA_ART=$(formal_fixture_register_data_file "$BASE" "$PROJ" "$WORK/fixture/data/seed-data.json")
[[ "$DATA_ART" == sha256:* ]] || { bad "immutable data artifact registration failed: $DATA_ART"; exit 1; }
ok "immutable data artifact registered: $DATA_ART"
PROTOCOL_JSON=$(formal_fixture_register_protocol "$BASE" "$PROJ" "$CT" "$CODE_ART" "$DATA_ART" \
  'analysis-spec-pi' 'protocol_analysis_spec_v1' 'm1')
PROTOCOL_ID=$(printf '%s' "$PROTOCOL_JSON" | jfield '.record.protocol_id')
PROTOCOL_HASH=$(printf '%s' "$PROTOCOL_JSON" | jfield '.record.canonical_hash')
if [[ "$PROTOCOL_ID" == 'protocol_analysis_spec_v1' && "$PROTOCOL_HASH" == sha256:* ]]; then
  ok "exact frozen Protocol registered before confirmatory jobs: $PROTOCOL_ID@$PROTOCOL_HASH"
else
  bad "frozen Protocol registration failed: $PROTOCOL_JSON"; exit 1
fi

# ── helpers ──────────────────────────────────────────────────────────────────

wait_job() { # <idempotency_key> — echoes terminal status (succeeded|failed|cancelled|timeout)
  for _ in $(seq 1 240); do
    S=$(api "$BASE/v1/projects/$PROJ/jobs" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{const j=JSON.parse(d).find(x=>x.idempotency_key==='$1');console.log(j?.status??'missing')})")
    case "$S" in succeeded|failed|cancelled) echo "$S"; return 0;; esac
    sleep 0.25
  done
  echo "timeout"
  return 1
}

expect_m1() { # <seed> <seed-coeff> — deterministic m1 from the fixture data file
  SEED="$1" COEFF="$2" DATA="$WORK/fixture/data/seed-data.json" node -e '
    const d=JSON.parse(require("node:fs").readFileSync(process.env.DATA,"utf8"))
    const ws=d.baseline.reduce((a,b,i)=>a+b*d.weights[i],0)
    process.stdout.write(String(0.5+Number(process.env.COEFF)*Number(process.env.SEED)+0.1*ws))'
}

approx() { # <actual> <expected> — within 1e-9
  A="$1" E="$2" node -e 'process.exit(Math.abs(Number(process.env.A)-Number(process.env.E))<1e-9?0:1)'
}

submit_job() { # <idempotency_key> <kind> <fixture-js> <seed> — real command job
  local key="$1" kind="$2" js="$3" seed="$4"
  if [ "$kind" = "baseline" ]; then
    local revision
    revision=$(api "$BASE/v1/projects/$PROJ" | jfield '.revision')
    KEY="$key" SNAP="$CODE_ART" CT="$CT" SEED="$seed" JS="$js" REV="$revision" node -e 'process.stdout.write(JSON.stringify({expected_revision:Number(process.env.REV),idempotency_key:process.env.KEY,code_snapshot_id:process.env.SNAP,contract_id:process.env.CT,image_digest:"node@sha256:c610fcdfb1d5b4740dd70c284ed3cb16bb857e0f7166196e36a5501df7a3aa32",output_contract:{metrics:"/outputs/metrics.json",logs:"/outputs/run.log"},command:["sh","-c","node /work/"+process.env.JS+" --seed "+process.env.SEED+" --data /work/data/seed-data.json --output /outputs/metrics.json --contract-id \"$DSH_CONTRACT_ID\""]}))' \
      | api -X POST "$BASE/v1/projects/$PROJ/baseline-runs" -d @- \
      | jfield '.job.status'
  else
    KEY="$key" KIND="$kind" SNAP="$CODE_ART" CT="$CT" DATA_ART="$DATA_ART" PROTOCOL_ID="$PROTOCOL_ID" PROTOCOL_HASH="$PROTOCOL_HASH" SEED="$seed" JS="$js" node -e 'process.stdout.write(JSON.stringify({idempotency_key:process.env.KEY,kind:process.env.KIND,code_snapshot_id:process.env.SNAP,data_artifact_ids:[process.env.DATA_ART],contract_id:process.env.CT,image_digest:"node@sha256:c610fcdfb1d5b4740dd70c284ed3cb16bb857e0f7166196e36a5501df7a3aa32",run_intent:"confirmatory",protocol_pin:{protocol_id:process.env.PROTOCOL_ID,revision:1,canonical_hash:process.env.PROTOCOL_HASH},output_contract:{metrics:"/outputs/metrics.json",logs:"/outputs/run.log"},command:["sh","-c","node /work/"+process.env.JS+" --seed "+process.env.SEED+" --data /work/data/seed-data.json --output /outputs/metrics.json --contract-id \"$DSH_CONTRACT_ID\""]}))' \
      | api -X POST "$BASE/v1/projects/$PROJ/jobs" -d @- \
      | jfield '.status'
  fi
}

echo "== baseline jobs (kind=baseline, baseline.js, seeds 1/2/3, real node in docker) =="
for BSEED in 1 2 3; do
  ST=$(submit_job "spec-baseline-$BSEED" "baseline" "baseline.js" "$BSEED")
  S=$(wait_job "spec-baseline-$BSEED" || echo timeout)
  if [[ "$S" == "succeeded" ]]; then
    ok "baseline job seed=$BSEED succeeded (queued=$ST)"
  else
    bad "baseline job seed=$BSEED status=$S"; tail -5 "$WORK/runner.log" || true
  fi
done

echo "== formal jobs (kind=formal, train.js, seeds 1/2/3, real node in docker) =="
for FSEED in 1 2 3; do
  ST=$(submit_job "spec-formal-$FSEED" "formal" "train.js" "$FSEED")
  S=$(wait_job "spec-formal-$FSEED" || echo timeout)
  if [[ "$S" == "succeeded" ]]; then
    ok "formal job seed=$FSEED succeeded (queued=$ST)"
  else
    bad "formal job seed=$FSEED status=$S"; tail -5 "$WORK/runner.log" || true
  fi
done

echo "== metrics really computed in the container (deterministic fixture expectations) =="
api "$BASE/v1/projects/$PROJ/jobs" > "$WORK/jobs.json"
B1=$(WORK="$WORK" BASE="$BASE" PROJ="$PROJ" node --input-type=module -e '
  const fs=await import("node:fs")
  const jobs=JSON.parse(fs.readFileSync(process.env.WORK+"/jobs.json","utf8"))
  const j=jobs.find(x=>x.idempotency_key==="spec-baseline-1")
  const res=await fetch(process.env.BASE+"/v1/artifacts/"+encodeURIComponent(j?.run_manifest?.metrics_artifact)+"?project_id="+process.env.PROJ)
  const m=(JSON.parse(await res.text()).metrics??[]).find(x=>(x.name??x.metric)==="m1")
  process.stdout.write(m!==undefined?String(m.value):"")')
F1=$(WORK="$WORK" BASE="$BASE" PROJ="$PROJ" node --input-type=module -e '
  const fs=await import("node:fs")
  const jobs=JSON.parse(fs.readFileSync(process.env.WORK+"/jobs.json","utf8"))
  const j=jobs.find(x=>x.idempotency_key==="spec-formal-1")
  const res=await fetch(process.env.BASE+"/v1/artifacts/"+encodeURIComponent(j?.run_manifest?.metrics_artifact)+"?project_id="+process.env.PROJ)
  const m=(JSON.parse(await res.text()).metrics??[]).find(x=>(x.name??x.metric)==="m1")
  process.stdout.write(m!==undefined?String(m.value):"")')
if [ -n "$B1" ] && [ -n "$F1" ] && approx "$B1" "$(expect_m1 1 0.01)" && approx "$F1" "$(expect_m1 1 0.02)"; then
  ok "baseline-1 m1=$B1 (expected $(expect_m1 1 0.01)), formal-1 m1=$F1 (expected $(expect_m1 1 0.02)) — real computation"
else
  bad "container metric mismatch: baseline-1='$B1' formal-1='$F1' (expected $(expect_m1 1 0.01) / $(expect_m1 1 0.02))"
fi

echo "== analysis #1 + #2: POST /v1/projects/$PROJ/analysis (metric m1, no contract_id) =="
AN1=$(api -X POST "$BASE/v1/projects/$PROJ/analysis" -d '{"metric":"m1"}')
printf '%s' "$AN1" > "$WORK/analysis1.json"
MEAN=$(printf '%s' "$AN1" | jfield '.mean')
EFF=$(printf '%s' "$AN1" | jfield '.effect_size')
BASE_V=$(printf '%s' "$AN1" | jfield '.baseline_value')
N=$(printf '%s' "$AN1" | jfield '.n')
DIR_OK=$(printf '%s' "$AN1" | jfield '.direction_ok')
ADJ_P=$(printf '%s' "$AN1" | jfield '.adjusted_p_value')
CI_LO=$(printf '%s' "$AN1" | jfield '.ci_low')
CI_HI=$(printf '%s' "$AN1" | jfield '.ci_high')
ART1=$(printf '%s' "$AN1" | jfield '.artifact_id')
CHART_ART=$(printf '%s' "$AN1" | jfield '.chart_artifact')
if [[ -n "$MEAN" ]] && [[ "$N" == "3" ]] && [[ "$ART1" == sha256:* ]] && [[ "$CHART_ART" == sha256:* ]]; then
  ok "analysis #1: mean=$MEAN baseline=$BASE_V effect=$EFF n=$N direction_ok=$DIR_OK ci=[$CI_LO,$CI_HI] artifact=$ART1"
else
  bad "analysis #1 malformed: mean='$MEAN' baseline='$BASE_V' effect='$EFF' n='$N' direction_ok='$DIR_OK'"
fi

AN2=$(api -X POST "$BASE/v1/projects/$PROJ/analysis" -d '{"metric":"m1"}')
printf '%s' "$AN2" > "$WORK/analysis2.json"
ART2=$(printf '%s' "$AN2" | jfield '.artifact_id')
curl -sf "$BASE/v1/artifacts/$ART1?project_id=$PROJ" -o "$WORK/analysis-artifact-1.json"
curl -sf "$BASE/v1/artifacts/$ART2?project_id=$PROJ" -o "$WORK/analysis-artifact-2.json"
if cmp -s "$WORK/analysis-artifact-1.json" "$WORK/analysis-artifact-2.json"; then
  ok "analysis repeat: artifact content byte-identical across two calls (cmp: $(wc -c < "$WORK/analysis-artifact-1.json") bytes, $ART1 vs $ART2)"
else
  bad "analysis artifact content DIFFERS between two identical analysis calls (paired bootstrap not deterministic)"
fi
if [[ "$(printf '%s' "$AN2" | jfield '.mean')" == "$MEAN" ]] && [[ "$(printf '%s' "$AN2" | jfield '.effect_size')" == "$EFF" ]] && [[ "$(printf '%s' "$AN2" | jfield '.ci_low')" == "$CI_LO" ]] && [[ "$(printf '%s' "$AN2" | jfield '.ci_high')" == "$CI_HI" ]]; then
  ok "analysis repeat: response numbers identical across calls"
else
  bad "analysis #2 response numbers drifted vs #1"
fi

echo "== §12 spec conformance: independent mirror of the canonical RNG rule =="
# The mirror re-implements reconstruction-contracts.md §12 from scratch over
# the REAL metrics the container wrote: canonical JSON (recursive key order)
# of the exact plan the kernel hands the worker (contract_id 'auto', metric
# m1 higher_is_better, run set ids kernel-baseline/kernel-treatment,
# resamples 10000, minimum_n 3) plus ordered (seed-ascending) run IDs and
# metric values; FNV-1a 32-bit over the UTF-8 bytes; mulberry32; B=10,000
# resamples; index-based CI low=floor(0.025*(B-1)) / high=ceil(0.975*(B-1)).
cat > "$WORK/mirror.mjs" <<'EOF'
function canonicalJson(v) {
  if (v === null) return 'null'
  if (typeof v === 'string') return JSON.stringify(v)
  if (typeof v === 'number') return Object.is(v, -0) ? '0' : String(v)
  if (typeof v === 'boolean') return v ? 'true' : 'false'
  if (Array.isArray(v)) return '[' + v.map(canonicalJson).join(',') + ']'
  if (typeof v === 'object') {
    const rec = v
    const keys = Object.keys(rec).filter((k) => rec[k] !== undefined).sort()
    return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonicalJson(rec[k])).join(',') + '}'
  }
  throw new Error('mirror: unsupported canonical JSON value')
}
function fnv1a32Bytes(bytes) {
  let h = 0x811c9dc5
  for (let i = 0; i < bytes.length; i++) { h ^= bytes[i]; h = Math.imul(h, 0x01000193) }
  return h >>> 0
}
function mulberry32(seed) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
const fs = await import('node:fs')
const jobs = JSON.parse(fs.readFileSync(process.env.WORK + '/jobs.json', 'utf8'))
const B = 10000
const group = {}
for (const kind of ['baseline', 'treatment']) group[kind] = []
for (const j of jobs) {
  if (j.status !== 'succeeded' || !j.run_manifest?.metrics_artifact) continue
  const kind = j.kind === 'baseline' ? 'baseline' : j.kind === 'formal' ? 'treatment' : null
  if (!kind) continue
  const res = await fetch(process.env.BASE + '/v1/artifacts/' + encodeURIComponent(j.run_manifest.metrics_artifact) + '?project_id=' + process.env.PROJ)
  const parsed = JSON.parse(await res.text())
  const m = (parsed.metrics ?? []).find((x) => (x.name ?? x.metric) === 'm1')
  if (m === undefined || parsed.seed === undefined) continue
  group[kind].push({ seed: parsed.seed, value: m.value })
}
for (const kind of ['baseline', 'treatment']) group[kind].sort((a, b) => a.seed - b.seed)
// the exact AnalysisPlan the kernel passes to the worker (§12), POST without contract_id
const plan = {
  contract_id: 'auto',
  metric: { name: 'm1', direction: 'higher_is_better', aggregation: 'mean' },
  paired_by: 'seed',
  baseline_run_set_id: 'kernel-baseline',
  treatment_run_set_id: 'kernel-treatment',
  method: { estimator: 'paired_mean_difference', interval: 'bootstrap_95', resamples: B },
  multiple_testing: 'holm',
  minimum_n: 3,
}
const seedDoc = {
  plan,
  baseline: { run_ids: group.baseline.map((r) => 'baseline-' + r.seed), metric_values: group.baseline.map((r) => r.value) },
  treatment: { run_ids: group.treatment.map((r) => 'treatment-' + r.seed), metric_values: group.treatment.map((r) => r.value) },
}
const seed = fnv1a32Bytes(new TextEncoder().encode(canonicalJson(seedDoc)))
const rng = mulberry32(seed)
const n = group.baseline.length
const diffs = group.treatment.map((t, i) => t.value - group.baseline[i].value)
const meanT = group.treatment.reduce((a, r) => a + r.value, 0) / n
const meanB = group.baseline.reduce((a, r) => a + r.value, 0) / n
const eff = diffs.reduce((a, b) => a + b, 0) / n
const means = new Array(B)
for (let r = 0; r < B; r++) {
  let s = 0
  for (let i = 0; i < n; i++) s += diffs[Math.floor(rng() * n)]
  means[r] = s / n
}
means.sort((a, b) => a - b)
const lo = means[Math.floor(0.025 * (B - 1))]
const hi = means[Math.ceil(0.975 * (B - 1))]
const round4 = (x) => Math.round(x * 10000) / 10000
process.stdout.write(JSON.stringify({
  mean4: String(round4(meanT)), base4: String(round4(meanB)), eff4: String(round4(eff)),
  ci_low4: String(round4(lo)), ci_high4: String(round4(hi)),
  diff_ok: Math.abs(eff - (meanT - meanB)) < 1e-9 ? 1 : 0,
  effect_positive: eff > 0 ? 1 : 0,
  seed, n,
}))
EOF
MIRROR=$(WORK="$WORK" BASE="$BASE" PROJ="$PROJ" node "$WORK/mirror.mjs")
M_MEAN4=$(printf '%s' "$MIRROR" | jfield '.mean4')
M_BASE4=$(printf '%s' "$MIRROR" | jfield '.base4')
M_EFF4=$(printf '%s' "$MIRROR" | jfield '.eff4')
M_CI_LO4=$(printf '%s' "$MIRROR" | jfield '.ci_low4')
M_CI_HI4=$(printf '%s' "$MIRROR" | jfield '.ci_high4')
M_DIFF_OK=$(printf '%s' "$MIRROR" | jfield '.diff_ok')
M_EFF_POS=$(printf '%s' "$MIRROR" | jfield '.effect_positive')
M_SEED=$(printf '%s' "$MIRROR" | jfield '.seed')
M_N=$(printf '%s' "$MIRROR" | jfield '.n')

if [[ "$M_DIFF_OK" == "1" ]] && [[ "$M_N" == "3" ]]; then
  ok "estimator identity (full precision): |mean(treatment−baseline) − (mean_t − mean_b)| < 1e-9 (seed=$M_SEED, n=$M_N)"
else
  bad "estimator identity violated: diff_ok=$M_DIFF_OK n=$M_N (seed=$M_SEED)"
fi
if [[ "$MEAN" == "$M_MEAN4" ]] && [[ "$BASE_V" == "$M_BASE4" ]] && [[ "$EFF" == "$M_EFF4" ]]; then
  ok "response numbers equal the mirror recomputation: mean=$MEAN baseline=$BASE_V effect=$EFF"
else
  bad "response/mirror mismatch: mean=$MEAN/$M_MEAN4 baseline=$BASE_V/$M_BASE4 effect=$EFF/$M_EFF4"
fi
RESP_DIFF=$(EFF="$EFF" MEAN="$MEAN" BASE_V="$BASE_V" node -e 'process.exit(Math.abs(Number(process.env.EFF)-(Number(process.env.MEAN)-Number(process.env.BASE_V)))<1e-9?0:1)') && R_DIFF_OK=1 || R_DIFF_OK=0
if [[ "$R_DIFF_OK" == "1" ]]; then
  ok "response-level identity: |effect_size − (treatment_mean − baseline_mean)| < 1e-9 (§12: effect_size IS the paired mean difference)"
else
  bad "response-level identity violated: effect=$EFF mean=$MEAN baseline=$BASE_V"
fi
if [[ "$DIR_OK" == "true" ]] && [[ "$M_EFF_POS" == "1" ]]; then
  ok "direction_ok semantics: higher_is_better + positive effect ⇒ direction_ok=true (stored difference never sign-flipped)"
else
  bad "direction_ok semantics violated: direction_ok=$DIR_OK effect_positive=$M_EFF_POS"
fi
if [[ "$CI_LO" == "$M_CI_LO4" ]] && [[ "$CI_HI" == "$M_CI_HI4" ]] && node -e "process.exit(Number('$CI_LO')<Number('$CI_HI')?0:1)"; then
  ok "CI matches the §12 canonical RNG rule (independent mirror): ci=[$CI_LO,$CI_HI] (mirror [$M_CI_LO4,$M_CI_HI4], B=10000, floor/ceil indices)"
else
  bad "CI does NOT match the §12 canonical RNG rule: response [$CI_LO,$CI_HI] vs mirror [$M_CI_LO4,$M_CI_HI4]"
fi
if [ -n "$ADJ_P" ] && node -e "process.exit(Number('$ADJ_P')>0&&Number('$ADJ_P')<=1?0:1)"; then
  ok "adjusted_p_value in (0,1]: $ADJ_P (Holm, identity for one metric)"
else
  bad "adjusted_p_value out of range or missing: '$ADJ_P'"
fi

echo "== manuscript excludes draft evidence; accepted chain reaches the manuscript =="
# draft (public route) evidence carrying the analysis numbers — even with a
# real-looking effect + CI, draft_unverified provenance must never support a
# claim, so the manuscript keeps claims_used=0 and the statement is absent.
E_DRAFT=$(api -X POST "$BASE/v1/projects/$PROJ/evidence" -d '{"source_type":"analysis","run_ids":[],"artifact_refs":[],"analysis_method":"bootstrap-95","result":{"primary_metric":"m1","value":'"$MEAN"',"baseline_value":'"$BASE_V"',"effect_size":'"$EFF"',"ci_low":'"$CI_LO"',"ci_high":'"$CI_HI"',"n_seeds":3}}' | jfield '.evidence_id')
[[ "$E_DRAFT" == evidence_* ]] || { bad "draft evidence id '$E_DRAFT'"; exit 1; }
CLAIM_DRAFT_STMT="DRAFTCLAIM: the treatment improves m1 (draft evidence only)"
C_DRAFT=$(api -X POST "$BASE/v1/projects/$PROJ/claims" -d '{"statement":"'"$CLAIM_DRAFT_STMT"'","scope":{"dataset":"d1","split":"test"}}' | jfield '.claim_id')
S_DRAFT=$(api -X POST "$BASE/v1/claims/verify" -d "{\"claim_id\":\"$C_DRAFT\",\"evidence_ids\":[\"$E_DRAFT\"]}" | jfield '.status')
if [[ "$S_DRAFT" == "inconclusive" ]]; then
  ok "draft evidence + claim -> verify inconclusive (provenance gates claims, not numbers)"
else
  bad "draft evidence claim became '$S_DRAFT' (expected inconclusive)"
fi
MS1=$(api -X POST "$BASE/v1/projects/$PROJ/manuscripts/build" -d '{"format":"markdown"}')
printf '%s' "$MS1" | jfield '.text' > "$WORK/manuscript1.md"
CU1=$(printf '%s' "$MS1" | jfield '.claims_used')
if [[ "$CU1" == "0" ]] && ! grep -Fq "$CLAIM_DRAFT_STMT" "$WORK/manuscript1.md"; then
  ok "manuscript with only draft evidence: claims_used=$CU1 and the draft claim statement is absent from the text"
else
  bad "manuscript leaked draft evidence claim: claims_used='$CU1' (statement present: $(grep -Fc "$CLAIM_DRAFT_STMT" "$WORK/manuscript1.md" || true))"
fi

# full verified -> accepted chain: Analysis-Worker identity + REAL analysis
# artifact refs + REAL run ids; verifier accept revalidates them (§6).
RUN_IDS_JSON=$(WORK="$WORK" node --input-type=module -e '
  const fs=await import("node:fs")
  const jobs=JSON.parse(fs.readFileSync(process.env.WORK+"/jobs.json","utf8"))
  const keys=["spec-formal-1","spec-formal-2","spec-formal-3"]
  console.log(JSON.stringify(keys.map(k=>jobs.find(j=>j.idempotency_key===k)?.run_manifest?.run_id).filter(Boolean)))')
EV=$(PROJ="$PROJ" MEAN="$MEAN" BASE_V="$BASE_V" EFF="$EFF" CI_LO="$CI_LO" CI_HI="$CI_HI" ART="$ART1" RUN_IDS="$RUN_IDS_JSON" node -e 'process.stdout.write(JSON.stringify({project_id:process.env.PROJ,source_type:"analysis",run_ids:JSON.parse(process.env.RUN_IDS),artifact_refs:[process.env.ART],analysis_method:"percentile-bootstrap-95",result:{primary_metric:"m1",value:Number(process.env.MEAN),baseline_value:Number(process.env.BASE_V),effect_size:Number(process.env.EFF),ci_low:Number(process.env.CI_LO),ci_high:Number(process.env.CI_HI),n_seeds:3}}))')
EV_ID=$(curl -sf -H 'content-type: application/json' -H "x-service-token: $DSH_SCHOLAR_SERVICE_TOKEN" -H 'x-service-principal: analysis-worker' -X POST "$BASE/v1/projects/$PROJ/evidence/verified" -d "$EV" | jfield '.evidence_id')
[[ "$EV_ID" == evidence_* ]] || { bad "verified evidence id '$EV_ID'"; exit 1; }
A_STATUS=$(api -X POST "$BASE/v1/projects/$PROJ/evidence/$EV_ID/accept" -H 'x-service-principal: verifier' -d '{"request_id":"req-spec-accept"}' | jfield '.provenance_status')
if [[ "$A_STATUS" == "accepted" ]]; then
  ok "verified evidence $EV_ID accepted by verifier (artifact_refs=[$ART1], run_ids real, revalidated)"
else
  bad "accept failed (provenance='$A_STATUS')"
fi
CLAIM_ACCEPT_STMT="ACCEPTEDCLAIM: the treatment improves m1 (verified and accepted evidence)"
C_ACCEPT=$(api -X POST "$BASE/v1/projects/$PROJ/claims" -d '{"statement":"'"$CLAIM_ACCEPT_STMT"'","scope":{"dataset":"d1","split":"test"}}' | jfield '.claim_id')
S_ACCEPT=$(api -X POST "$BASE/v1/claims/verify" -d "{\"claim_id\":\"$C_ACCEPT\",\"evidence_ids\":[\"$EV_ID\"]}" | jfield '.status')
if [[ "$S_ACCEPT" == "supported" ]]; then
  ok "accepted evidence + claim -> verify supported (CI excludes zero, effect > 0)"
else
  bad "accepted evidence claim became '$S_ACCEPT' (expected supported)"
fi
MS2=$(api -X POST "$BASE/v1/projects/$PROJ/manuscripts/build" -d '{"format":"markdown"}')
printf '%s' "$MS2" | jfield '.text' > "$WORK/manuscript2.md"
CU2=$(printf '%s' "$MS2" | jfield '.claims_used')
if [[ "$CU2" == "1" ]] && grep -Fq "$CLAIM_ACCEPT_STMT" "$WORK/manuscript2.md" && ! grep -Fq "$CLAIM_DRAFT_STMT" "$WORK/manuscript2.md"; then
  ok "manuscript with accepted chain: claims_used=$CU2, accepted claim statement present, draft claim statement still absent"
else
  bad "manuscript claims mismatch: claims_used='$CU2' (accepted stmt present: $(grep -Fc "$CLAIM_ACCEPT_STMT" "$WORK/manuscript2.md" || true), draft stmt present: $(grep -Fc "$CLAIM_DRAFT_STMT" "$WORK/manuscript2.md" || true))"
fi

echo "== cleanup =="
[[ -n "$RUNNER_PID" ]] && kill -9 "$RUNNER_PID" 2>/dev/null || true
[[ -n "$KERNEL_PID" ]] && kill -9 "$KERNEL_PID" 2>/dev/null || true
[[ -n "$RUNNER_PID" ]] && wait "$RUNNER_PID" 2>/dev/null || true
[[ -n "$KERNEL_PID" ]] && wait "$KERNEL_PID" 2>/dev/null || true
RUNNER_PID=""
KERNEL_PID=""
rm -rf "$WORK"
say "Summary: $PASS passed, $FAIL failed"
[[ "$FAIL" -eq 0 ]] || exit 1
