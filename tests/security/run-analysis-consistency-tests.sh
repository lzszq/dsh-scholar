#!/usr/bin/env bash
# §6 P0 blocking tests: analysis determinism + Analysis-Artifact/chart/
# manuscript number consistency — REAL end-to-end (kernel + runner --mode
# docker + node:22-alpine; no echo jobs, no forged metrics).
#
#   analysis-repeat-byte-identical     POST /v1/projects/{id}/analysis twice
#                                      with the same inputs -> the analysis
#                                      ARTIFACT content is byte-identical
#                                      (paired bootstrap, §6: "输入相同输出
#                                      字节一致"; §12 seeded mulberry32/FNV-1a)
#   analysis-artifact-chart-consistent mean/baseline digits from the analysis
#                                      artifact appear verbatim in the chart
#                                      SVG text (§6 "Analysis Artifact、图表
#                                      和稿件数字一致", §11.3 chart)
#   analysis-artifact-manuscript-consistent  mean/effect/CI digits from the
#                                      analysis artifact appear verbatim in the
#                                      manuscript text (evidence rows)
#
# Pipeline driven against REAL runs: 3 baseline jobs (baseline.js) + 3 formal
# jobs (train.js), seeds 1/2/3, bound to an approved contract and a CAS code
# snapshot archived from a runtime COPY of evals/golden-path-v2/fixture-repo.
#
# Snapshot note (documented deviation): the archived copy changes ONE constant
# in train.js — the treatment arm's seed coefficient 0.01 -> 0.02 (baseline.js
# keeps 0.01) — so the paired effect is +0.01*seed and the bootstrap CI /
# p-value are NON-degenerate. A zero effect would make the byte-determinism
# assertion vacuous (CI always [0,0], p always 1). evals/ is untouched; the
# copy is created and archived at runtime. Baseline jobs run /work/baseline.js,
# formal jobs /work/train.js — both support the same --seed/--data/--output/
# --contract-id arg contract and write the §12.5 MetricsFileV1 with
# run_id = DSH_RUN_ID.
#
# Chart note (kernel §11.3 buildChartSvg): the SVG renders the baseline and
# treatment MEANS (± CI whiskers) — it does not render effect_size. Effect
# consistency is therefore asserted across the analysis artifact and the
# manuscript; mean/baseline consistency across analysis artifact + chart SVG.
#
# Usage: bash tests/security/run-analysis-consistency-tests.sh
set -eu

REPO=$(cd "$(dirname "$0")/../.." && pwd)
if [ ! -f "$REPO/packages/research-kernel/lib/bin/kernel.js" ] && [ -f "$PWD/packages/research-kernel/lib/bin/kernel.js" ]; then
  REPO=$PWD
fi
if [ ! -f "$REPO/packages/research-kernel/lib/bin/kernel.js" ]; then
  echo "run-analysis-consistency-tests: cannot locate repo root (tried '$REPO' and '$PWD')" >&2
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
# positive internal calls carry x-service-token via the helper (runners inherit
# the env var and authenticate their claim/runner-keys/recover calls themselves).
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

formal_fixture_init_target_identity "$WORK" 'analysis-consistency-target-token-v1'

echo "== prerequisites =="
if ! docker info > /dev/null 2>&1; then
  echo "run-analysis-consistency-tests: docker runtime not available (runner --mode docker is required) — run: sudo systemctl start docker" >&2
  exit 2
fi
ok "docker runtime reachable (server $(docker version --format '{{.Server.Version}}' 2>/dev/null || echo '?'))"
if ! docker image inspect node:22-alpine > /dev/null 2>&1; then
  docker pull node:22-alpine > /dev/null 2>&1 || { echo "run-analysis-consistency-tests: failed to pull node:22-alpine" >&2; exit 2; }
fi
IMG='node@sha256:c610fcdfb1d5b4740dd70c284ed3cb16bb857e0f7166196e36a5501df7a3aa32'
if ! docker image inspect "$IMG" > /dev/null 2>&1; then
  echo "run-analysis-consistency-tests: trusted image $IMG not present locally" >&2
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
DSH_SCHOLAR_RUNNER_TARGET_TOKEN="$FORMAL_FIXTURE_RUNNER_TARGET_TOKEN" nohup node "$RUNNER_BIN" --kernel "$BASE" --owner analysis-consistency --poll-ms 200 --mode docker --target-id "$FORMAL_FIXTURE_TARGET_ID" --timeout-ms 30000 > "$WORK/runner.log" 2>&1 &
RUNNER_PID=$!
if formal_fixture_wait_runner_ready "$BASE"; then
  ok "runner started and target-scoped heartbeat is online (mode=docker, poll-ms=200)"
else
  bad "runner target never became ready"; tail -20 "$WORK/runner.log" || true; exit 1
fi

echo "== project (execution.runner_profile_id=profile_local_docker_cpu_v1) + contract (frozen) =="
BRIEF='{"problem":"p","scope":"s","questions":[],"primary_metrics":["m1"],"resources":"","risks":[],"target_outputs":["paper"],"target_venue":null,"baseline_repo":"fixture-repo","domain":"machine-learning"}'
PROJ=$(api -X POST "$BASE/v1/projects" -d "{\"name\":\"analysis-consistency\",\"workspace\":\"/w\",\"brief\":$BRIEF,\"creator_principal_id\":\"analysis-consistency-pi\",\"execution\":{\"runner_profile_id\":\"profile_local_docker_cpu_v1\"}}" | jfield '.project_id')
[[ -n "$PROJ" ]] || { echo "failed to create project"; exit 1; }
ok "project $PROJ"

# Reach CONTRACT_PENDING through the real human-gated lifecycle. Baseline
# execution below must enter through the atomic baseline-runs endpoint; the
# fixture may not freeze a Contract on an unrelated DRAFT project.
G_SCOPE=$(api -X POST "$BASE/v1/projects/$PROJ/gates" -d '{"type":"scope","title":"Analysis consistency scope"}' | jfield '.gate_id')
human_decide "$G_SCOPE" '{"actor":"analysis-consistency","principal":{"principal_id":"analysis-consistency-pi"},"decision":"approved"}' > /dev/null
for PHASE in SURVEYING IDEATING; do
  REV=$(api "$BASE/v1/projects/$PROJ" | jfield '.revision')
  api -X POST "$BASE/v1/projects/$PROJ/transitions" -d "{\"to\":\"$PHASE\",\"expected_revision\":$REV}" > /dev/null
done
G_IDEA=$(api -X POST "$BASE/v1/projects/$PROJ/gates" -d '{"type":"idea","title":"Analysis consistency idea"}' | jfield '.gate_id')
human_decide "$G_IDEA" '{"actor":"analysis-consistency","principal":{"principal_id":"analysis-consistency-pi"},"decision":"approved"}' > /dev/null
REV=$(api "$BASE/v1/projects/$PROJ" | jfield '.revision')
api -X POST "$BASE/v1/projects/$PROJ/transitions" -d "{\"to\":\"CONTRACT_PENDING\",\"expected_revision\":$REV}" > /dev/null

CT=$(api -X POST "$BASE/v1/projects/$PROJ/contracts" -d '{"idea_id":"idea_consistency","data":{"dataset_id":"fixture","version":"v1","split":"official"},"methods":{"baseline":"baseline-engine","treatment":"treatment-engine"},"metrics":{"primary":"m1","secondary":["n_samples","m2"],"direction":"higher_is_better"},"seeds":[1,2,3],"analysis":{"effect_size":"mean_difference","interval":"bootstrap_95","multiple_testing":"holm"},"stop_conditions":{"max_gpu_hours":2,"min_completed_seeds":3,"stop_on_data_leakage":true}}' | jfield '.contract_id')
G_CONTRACT=$(api -X POST "$BASE/v1/projects/$PROJ/gates" -d "{\"type\":\"contract\",\"title\":\"Analysis consistency Contract\",\"payload\":{\"contract_id\":\"$CT\"}}" | jfield '.gate_id')
human_decide "$G_CONTRACT" '{"actor":"analysis-consistency","principal":{"principal_id":"analysis-consistency-pi"},"decision":"approved"}' > /dev/null
APPROVE=$(api "$BASE/v1/projects/$PROJ/contracts" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{const c=JSON.parse(d).find(x=>x.contract_id==='$CT');console.log(c?.status??'')})")
if [[ "$CT" == expc_* ]] && [[ "$APPROVE" == "approved" ]]; then
  ok "contract $CT registered + frozen (status=approved, metrics m1 primary / n_samples,m2 secondary, direction higher_is_better, seeds 1..3)"
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
SNAP=$(code_snapshot_api "$PORT" "$PROJ" "$AN_WS" "" "analysis-consistency fixture")
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
  'analysis-consistency-pi' 'protocol_analysis_consistency_v1' 'm1')
PROTOCOL_ID=$(printf '%s' "$PROTOCOL_JSON" | jfield '.record.protocol_id')
PROTOCOL_HASH=$(printf '%s' "$PROTOCOL_JSON" | jfield '.record.canonical_hash')
if [[ "$PROTOCOL_ID" == 'protocol_analysis_consistency_v1' && "$PROTOCOL_HASH" == sha256:* ]]; then
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

job_metric() { # <idempotency_key> <metric> — reads jobs JSON on stdin, prints the metric value
  KEY="$1" METRIC="$2" BASE="$BASE" PROJ="$PROJ" node --input-type=module -e '
    let d="";process.stdin.on("data",c=>d+=c).on("end",async()=>{
      const jobs=JSON.parse(d)
      const art=jobs.find(x=>x.idempotency_key===process.env.KEY)?.run_manifest?.metrics_artifact
      if(!art){process.stdout.write("");return}
      try{
        const res=await fetch(process.env.BASE+"/v1/artifacts/"+encodeURIComponent(art)+"?project_id="+process.env.PROJ)
        const parsed=JSON.parse(await res.text())
        const m=(parsed.metrics??[]).find(x=>(x.name??x.metric)===process.env.METRIC)
        process.stdout.write(m!==undefined?String(m.value):"")
      }catch{process.stdout.write("")}
    })'
}

# expect_m1 <seed> <seed-coeff> — deterministic m1 from the fixture data file,
# identical arithmetic to the in-container fixture (0.5 + coeff*seed + 0.1*ws).
expect_m1() {
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
  ST=$(submit_job "ac-baseline-$BSEED" "baseline" "baseline.js" "$BSEED")
  S=$(wait_job "ac-baseline-$BSEED" || echo timeout)
  if [[ "$S" == "succeeded" ]]; then
    ok "baseline job seed=$BSEED succeeded (queued=$ST)"
  else
    bad "baseline job seed=$BSEED status=$S"; tail -5 "$WORK/runner.log" || true
  fi
done

echo "== formal jobs (kind=formal, train.js, seeds 1/2/3, real node in docker) =="
for FSEED in 1 2 3; do
  ST=$(submit_job "ac-formal-$FSEED" "formal" "train.js" "$FSEED")
  S=$(wait_job "ac-formal-$FSEED" || echo timeout)
  if [[ "$S" == "succeeded" ]]; then
    ok "formal job seed=$FSEED succeeded (queued=$ST)"
  else
    bad "formal job seed=$FSEED status=$S"; tail -5 "$WORK/runner.log" || true
  fi
done

echo "== metrics really computed in the container (deterministic fixture expectations) =="
jobs_api() { api "$BASE/v1/projects/$PROJ/jobs"; }
jobs_api > "$WORK/jobs.json"
B1=$(job_metric "ac-baseline-1" "m1" < "$WORK/jobs.json")
F1=$(job_metric "ac-formal-1" "m1" < "$WORK/jobs.json")
if [ -n "$B1" ] && [ -n "$F1" ] && approx "$B1" "$(expect_m1 1 0.01)" && approx "$F1" "$(expect_m1 1 0.02)"; then
  ok "baseline-1 m1=$B1 (expected $(expect_m1 1 0.01)), formal-1 m1=$F1 (expected $(expect_m1 1 0.02)) — real computation"
else
  bad "container metric mismatch: baseline-1='$B1' formal-1='$F1' (expected $(expect_m1 1 0.01) / $(expect_m1 1 0.02))"
fi

echo "== analysis #1: POST /v1/projects/$PROJ/analysis (metric m1) =="
AN1=$(api -X POST "$BASE/v1/projects/$PROJ/analysis" -d '{"metric":"m1"}')
printf '%s' "$AN1" > "$WORK/analysis1.json"
MEAN=$(printf '%s' "$AN1" | jfield '.mean')
EFF=$(printf '%s' "$AN1" | jfield '.effect_size')
BASE_V=$(printf '%s' "$AN1" | jfield '.baseline_value')
N=$(printf '%s' "$AN1" | jfield '.n')
DIR_OK=$(printf '%s' "$AN1" | jfield '.direction_ok')
ART1=$(printf '%s' "$AN1" | jfield '.artifact_id')
CHART_ART=$(printf '%s' "$AN1" | jfield '.chart_artifact')
EXP_MEAN=$(node -e "const f=(Number('$(expect_m1 1 0.02)')+Number('$(expect_m1 2 0.02)')+Number('$(expect_m1 3 0.02)'))/3;console.log(String(Math.round(f*1e4)/1e4))")
EXP_EFF=$(node -e "console.log(String(Math.round((Number('$(expect_m1 1 0.02)')-Number('$(expect_m1 1 0.01)')+Number('$(expect_m1 2 0.02)')-Number('$(expect_m1 2 0.01)')+Number('$(expect_m1 3 0.02)')-Number('$(expect_m1 3 0.01)'))/3*1e4)/1e4))")
if [[ "$MEAN" == "$EXP_MEAN" ]] && [[ "$EFF" == "$EXP_EFF" ]] && [[ "$N" == "3" ]] && [[ "$DIR_OK" == "true" ]] && [[ "$ART1" == sha256:* ]] && [[ "$CHART_ART" == sha256:* ]]; then
  ok "analysis #1: mean=$MEAN (expected $EXP_MEAN), effect_size=$EFF (expected $EXP_EFF), n=$N, direction_ok=true, artifact=$ART1, chart=$CHART_ART"
else
  bad "analysis #1 assertions failed: mean=$MEAN (expected $EXP_MEAN) effect=$EFF (expected $EXP_EFF) n=$N direction_ok=$DIR_OK"
fi
CI_LO=$(printf '%s' "$AN1" | jfield '.ci_low')
CI_HI=$(printf '%s' "$AN1" | jfield '.ci_high')
if [ -n "$CI_LO" ] && [ -n "$CI_HI" ] && node -e "process.exit(Number('$CI_LO')<Number('$CI_HI')&&Number('$CI_LO')>0?0:1)"; then
  ok "bootstrap CI non-degenerate: [$CI_LO, $CI_HI] (seeded percentile bootstrap over real diffs)"
else
  bad "bootstrap CI degenerate or missing: ci_low='$CI_LO' ci_high='$CI_HI'"
fi

echo "== analysis #2: same inputs again -> artifact content must be byte-identical =="
AN2=$(api -X POST "$BASE/v1/projects/$PROJ/analysis" -d '{"metric":"m1"}')
printf '%s' "$AN2" > "$WORK/analysis2.json"
ART2=$(printf '%s' "$AN2" | jfield '.artifact_id')
curl -sf "$BASE/v1/artifacts/$ART1?project_id=$PROJ" -o "$WORK/analysis-artifact-1.json"
curl -sf "$BASE/v1/artifacts/$ART2?project_id=$PROJ" -o "$WORK/analysis-artifact-2.json"
if cmp -s "$WORK/analysis-artifact-1.json" "$WORK/analysis-artifact-2.json"; then
  ok "analysis artifact content byte-identical across two runs (cmp: $(wc -c < "$WORK/analysis-artifact-1.json") bytes, artifact_id $ART1 vs $ART2)"
else
  bad "analysis artifact content DIFFERS between two identical analysis calls (paired bootstrap not deterministic)"
fi
M2=$(printf '%s' "$AN2" | jfield '.mean')
E2=$(printf '%s' "$AN2" | jfield '.effect_size')
C2L=$(printf '%s' "$AN2" | jfield '.ci_low')
C2H=$(printf '%s' "$AN2" | jfield '.ci_high')
if [[ "$M2" == "$MEAN" ]] && [[ "$E2" == "$EFF" ]] && [[ "$C2L" == "$CI_LO" ]] && [[ "$C2H" == "$CI_HI" ]]; then
  ok "analysis #2 response numbers identical to #1 (mean=$M2 effect=$E2 ci=[$C2L,$C2H])"
else
  bad "analysis #2 response numbers drifted: mean=$M2 effect=$E2 ci=[$C2L,$C2H] (expected $MEAN/$EFF/[$CI_LO,$CI_HI])"
fi

echo "== consistency: analysis artifact <-> chart SVG (mean/baseline digits, §6 §11.3) =="
curl -sf "$BASE/v1/artifacts/$CHART_ART?project_id=$PROJ" -o "$WORK/chart.svg"
# the kernel renders the chart from the SAME rounded numbers: labels are
# toFixed(4) of the means; the analysis artifact carries the 4-decimal rounded
# values — the shared digit prefixes must appear in both.
SVG_TREAT=$(node -e "console.log((Number('$MEAN')).toFixed(4))")
SVG_BASE=$(node -e "console.log((Number('$BASE_V')).toFixed(4))")
if grep -Fq "$MEAN" "$WORK/analysis-artifact-1.json" && grep -Fq "treatment: $SVG_TREAT" "$WORK/chart.svg"; then
  ok "mean digits '$MEAN' present in analysis artifact AND chart SVG ('treatment: $SVG_TREAT')"
else
  bad "mean digits '$MEAN' / 'treatment: $SVG_TREAT' missing from analysis artifact or chart SVG"
fi
if grep -Fq "$BASE_V" "$WORK/analysis-artifact-1.json" && grep -Fq "baseline: $SVG_BASE" "$WORK/chart.svg"; then
  ok "baseline digits '$BASE_V' present in analysis artifact AND chart SVG ('baseline: $SVG_BASE')"
else
  bad "baseline digits '$BASE_V' / 'baseline: $SVG_BASE' missing from analysis artifact or chart SVG"
fi

echo "== consistency: analysis artifact <-> manuscript (mean/effect/CI digits, §6) =="
# Evidence carries the analysis artifact's numbers via the Analysis-Worker
# verified route (x-service-principal: analysis-worker, §6 EVID-01); the
# manuscript Results table renders them verbatim.
RUN_IDS_JSON=$(WORK="$WORK" node --input-type=module -e '
  const fs=await import("node:fs")
  const jobs=JSON.parse(fs.readFileSync(process.env.WORK+"/jobs.json","utf8"))
  const keys=["ac-formal-1","ac-formal-2","ac-formal-3"]
  console.log(JSON.stringify(keys.map(k=>jobs.find(j=>j.idempotency_key===k)?.run_manifest?.run_id).filter(Boolean)))')
EV_BODY=$(PROJ="$PROJ" MEAN="$MEAN" BASE_V="$BASE_V" EFF="$EFF" CI_LO="$CI_LO" CI_HI="$CI_HI" ART="$ART1" RUN_IDS="$RUN_IDS_JSON" node -e 'process.stdout.write(JSON.stringify({project_id:process.env.PROJ,source_type:"analysis",run_ids:JSON.parse(process.env.RUN_IDS),artifact_refs:[process.env.ART],analysis_method:"percentile-bootstrap-95",result:{primary_metric:"m1",value:Number(process.env.MEAN),baseline_value:Number(process.env.BASE_V),effect_size:Number(process.env.EFF),ci_low:Number(process.env.CI_LO),ci_high:Number(process.env.CI_HI),n_seeds:3}}))')
EV=$(curl -sf -H 'content-type: application/json' -H "x-service-token: $DSH_SCHOLAR_SERVICE_TOKEN" -H 'x-service-principal: analysis-worker' -X POST "$BASE/v1/projects/$PROJ/evidence/verified" -d "$EV_BODY")
EV_ID=$(printf '%s' "$EV" | jfield '.evidence_id')
if [[ "$EV_ID" == evidence_* ]]; then
  ok "evidence ingested via the Analysis-Worker verified route with the analysis artifact numbers (artifact_refs=[$ART1])"
else
  bad "evidence ingestion failed: $EV"
fi

echo "== Phase-3 outcome closure: real terminal Docker Job -> immutable research-run record =="
FORMAL_JOB_ID=$(WORK="$WORK" node --input-type=module -e '
  const fs=await import("node:fs")
  const jobs=JSON.parse(fs.readFileSync(process.env.WORK+"/jobs.json","utf8"))
  process.stdout.write(jobs.find(job=>job.idempotency_key==="ac-formal-1")?.job_id??"")')
FORMAL_RUN_ID=$(WORK="$WORK" node --input-type=module -e '
  const fs=await import("node:fs")
  const jobs=JSON.parse(fs.readFileSync(process.env.WORK+"/jobs.json","utf8"))
  process.stdout.write(jobs.find(job=>job.idempotency_key==="ac-formal-1")?.run_manifest?.run_id??"")')
OBSERVATIONS=$(curl -sf -H "x-service-token: $DSH_SCHOLAR_SERVICE_TOKEN" -H 'x-principal-id: analysis-consistency-pi' "$BASE/v2/projects/$PROJ/run-outcome-observations")
OBSERVATION_MATCH=$(RUN="$FORMAL_RUN_ID" JOB="$FORMAL_JOB_ID" node -e '
  let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{
    const ledger=JSON.parse(d)
    process.stdout.write(String(ledger.pending.some(item=>item.run_id===process.env.RUN&&item.job_id===process.env.JOB&&item.job_execution==="succeeded"&&item.intent==="confirmatory")))
  })' <<<"$OBSERVATIONS")
if [[ "$OBSERVATION_MATCH" == 'true' ]]; then
  ok "terminal Docker Job produced an exact pending execution-only observation (job=$FORMAL_JOB_ID run=$FORMAL_RUN_ID)"
else
  bad "terminal Docker Job observation missing or misbound: job=$FORMAL_JOB_ID run=$FORMAL_RUN_ID ledger=$OBSERVATIONS"
fi
# Scientific classification contains caller-authored outcome fields only.
# execution/intent/Protocol/attempt/manifest are re-derived from the exact
# pending observation and therefore cannot be echoed or overridden here.
OUTCOME_BODY=$(PROJ="$PROJ" RUN="$FORMAL_RUN_ID" ART="$ART1" EVIDENCE="$EV_ID" node -e '
  process.stdout.write(JSON.stringify({record:{run_ref:process.env.RUN,project_id:process.env.PROJ,outcome:"positive",validity:"valid",analysis_artifact_id:process.env.ART,evidence_refs:[process.env.EVIDENCE],recorded_at:new Date().toISOString()},claim_proposal:null,expected_revision:0}))')
OUTCOME_STATUS=$(curl -sS -o "$WORK/outcome.json" -w '%{http_code}' -H 'content-type: application/json' -H "x-service-token: $DSH_SCHOLAR_SERVICE_TOKEN" -H 'x-principal-id: analysis-consistency-pi' -X POST "$BASE/v2/projects/$PROJ/research-runs" -d "$OUTCOME_BODY")
OUTCOME=$(<"$WORK/outcome.json")
if [[ "$OUTCOME_STATUS" == '201' ]] \
  && [[ "$(printf '%s' "$OUTCOME" | jfield '.outcome.classification.interpretation')" == 'evidence_candidate' ]] \
  && [[ "$(printf '%s' "$OUTCOME" | jfield '.outcome.negative_finding')" == '' ]] \
  && [[ "$(printf '%s' "$OUTCOME" | jfield '.outcome.claim_proposal')" == '' ]]; then
  ok "terminal confirmatory Docker Job recorded as evidence_candidate without auto-creating a NegativeFinding or Claim"
else
  bad "terminal Docker Job outcome closure failed: HTTP $OUTCOME_STATUS body=$OUTCOME"
fi
OUTCOME_REPLAY_STATUS=$(curl -sS -o "$WORK/outcome-replay.json" -w '%{http_code}' -H 'content-type: application/json' -H "x-service-token: $DSH_SCHOLAR_SERVICE_TOKEN" -H 'x-principal-id: analysis-consistency-pi' -X POST "$BASE/v2/projects/$PROJ/research-runs" -d "$OUTCOME_BODY")
OUTCOME_REPLAY=$(<"$WORK/outcome-replay.json")
OUTCOME_LIST=$(curl -sf -H "x-service-token: $DSH_SCHOLAR_SERVICE_TOKEN" -H 'x-principal-id: analysis-consistency-pi' "$BASE/v2/projects/$PROJ/research-runs")
if [[ "$OUTCOME_REPLAY_STATUS" == '201' ]] \
  && [[ "$(printf '%s' "$OUTCOME_REPLAY" | jfield '.replayed')" == 'true' ]] \
  && [[ "$(printf '%s' "$OUTCOME_LIST" | jfield '.outcomes.length')" == '1' ]]; then
  ok "exact outcome replay is idempotent and the append-only project stream contains one record"
else
  bad "outcome replay/list mismatch: HTTP $OUTCOME_REPLAY_STATUS replay=$OUTCOME_REPLAY list=$OUTCOME_LIST"
fi
MS=$(api -X POST "$BASE/v1/projects/$PROJ/manuscripts/build" -d '{"format":"markdown"}')
printf '%s' "$MS" > "$WORK/manuscript.json"
printf '%s' "$MS" | jfield '.text' > "$WORK/manuscript.md"
if grep -Fq "| m1 | $MEAN | $BASE_V | $EFF |" "$WORK/manuscript.md"; then
  ok "manuscript row carries the analysis numbers verbatim: '| m1 | $MEAN | $BASE_V | $EFF |'"
else
  bad "manuscript missing analysis row '| m1 | $MEAN | $BASE_V | $EFF |'"
fi
if grep -Fq "$CI_LO" "$WORK/manuscript.md" && grep -Fq "$CI_HI" "$WORK/manuscript.md"; then
  ok "manuscript carries the analysis CI digits verbatim: $CI_LO / $CI_HI"
else
  bad "manuscript missing CI digits $CI_LO / $CI_HI"
fi
if grep -Fq "$MEAN" "$WORK/manuscript.md"; then
  ok "manuscript carries the analysis mean digits '$MEAN'"
else
  bad "manuscript missing mean digits '$MEAN'"
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
