#!/usr/bin/env bash
# Reproduce the README MNIST case in an isolated Kernel with real local-Docker
# execution. The dataset and training programs are intentionally not vendored;
# point MNIST_FIXTURE_DIR at a directory containing baseline_cnn.js,
# train_cnn.js and mnist_subset.json. The script preserves its isolated state
# so the same project can be inspected and captured by the Scholar UI.
set -eu

REPO=$(cd "$(dirname "$0")/../.." && pwd)
FIXTURE=${MNIST_FIXTURE_DIR:?MNIST_FIXTURE_DIR is required}
KERNEL_BIN="$REPO/packages/research-kernel/lib/bin/kernel.js"
RUNNER_BIN="$REPO/workers/runner-gateway/lib/bin/runner.js"
WORK=${DSH_MNIST_WORK_ROOT:-$(mktemp -d /tmp/dsh-scholar-mnist-readme.XXXXXX)}
mkdir -p "$WORK"

for required in baseline_cnn.js train_cnn.js mnist_subset.json; do
  [ -f "$FIXTURE/$required" ] || { echo "missing $FIXTURE/$required" >&2; exit 2; }
done
[ -f "$KERNEL_BIN" ] || { echo "build research-kernel first" >&2; exit 2; }
[ -f "$RUNNER_BIN" ] || { echo "build runner-gateway first" >&2; exit 2; }

export DSH_SCHOLAR_SERVICE_TOKEN='mnist-readme-service-token-20260820'
api() { curl --fail-with-body -sS -H 'content-type: application/json' -H "x-service-token: $DSH_SCHOLAR_SERVICE_TOKEN" "$@"; }
human_decide() { api -H 'x-service-principal: standalone-human-bff' -X POST "$BASE/internal/human-gates/$1/decisions" -d "$2"; }
jfield() { node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{const v=JSON.parse(d);console.log(v$1 ?? '')})"; }

# shellcheck source=../code-snapshot-lib.sh
source "$REPO/evals/code-snapshot-lib.sh"
# shellcheck source=../../tests/security/formal-fixture-lib.sh
source "$REPO/tests/security/formal-fixture-lib.sh"

KERNEL_PID=''
RUNNER_PID=''
SUCCEEDED=0
cleanup_on_error() {
  status=$?
  if [ "$status" -ne 0 ]; then
    [ -n "$RUNNER_PID" ] && kill "$RUNNER_PID" 2>/dev/null || true
    [ -n "$KERNEL_PID" ] && kill "$KERNEL_PID" 2>/dev/null || true
    echo "MNIST run failed; isolated diagnostics preserved at $WORK" >&2
  fi
  exit "$status"
}
trap cleanup_on_error EXIT

docker info >/dev/null 2>&1 || { echo 'Docker is required' >&2; exit 2; }
IMG='node@sha256:c610fcdfb1d5b4740dd70c284ed3cb16bb857e0f7166196e36a5501df7a3aa32'
docker image inspect "$IMG" >/dev/null 2>&1 || { echo "pinned image $IMG is not installed" >&2; exit 2; }

DATA_SHA=$(sha256sum "$FIXTURE/mnist_subset.json" | cut -d' ' -f1)
EXPECTED_DATA_SHA='f8a1188e445be6a86fd8342c029d62a9e256fcb7b0158739b9da84b4a2b607e5'
[ "$DATA_SHA" = "$EXPECTED_DATA_SHA" ] || { echo "unexpected MNIST subset hash: $DATA_SHA" >&2; exit 2; }

formal_fixture_init_target_identity "$WORK" 'mnist-readme-runner-target-token-20260820'
for candidate in $((23000 + $$ % 500)) $((23600 + $$ % 500)) $((24200 + $$ % 500)); do
  PORT=$candidate
  nohup node "$KERNEL_BIN" --db "$WORK/kernel.db" --cas "$WORK/cas" --secret-root "$FORMAL_FIXTURE_SECRET_ROOT" --port "$PORT" >"$WORK/kernel.log" 2>&1 &
  KERNEL_PID=$!
  for _ in $(seq 1 80); do
    if kill -0 "$KERNEL_PID" 2>/dev/null && curl -fsS "http://127.0.0.1:$PORT/v1/health" >/dev/null 2>&1; then
      break 2
    fi
    sleep 0.1
  done
  kill "$KERNEL_PID" 2>/dev/null || true
  wait "$KERNEL_PID" 2>/dev/null || true
  KERNEL_PID=''
done
[ -n "$KERNEL_PID" ] || { echo 'Kernel failed to start' >&2; exit 2; }
BASE="http://127.0.0.1:$PORT"

nohup node "$RUNNER_BIN" --kernel "$BASE" --owner mnist-readme --poll-ms 200 --mode docker \
  --target-id "$FORMAL_FIXTURE_TARGET_ID" --target-token "$FORMAL_FIXTURE_RUNNER_TARGET_TOKEN" \
  --timeout-ms 180000 >"$WORK/runner.log" 2>&1 &
RUNNER_PID=$!
formal_fixture_wait_runner_ready "$BASE"

BRIEF=$(node -e 'process.stdout.write(JSON.stringify({problem:"Can a compact two-convolution network with per-channel normalization improve handwritten-digit test accuracy over a single-convolution baseline on a fixed MNIST subset?",scope:"Deterministic CPU-only reproduction on a 6,000-train/1,000-test subset; no augmentation or hyperparameter sweep.",questions:["Does the treatment improve paired-seed test accuracy?"],primary_metrics:["test_accuracy"],resources:"Local Docker CPU, three preregistered seeds",risks:["Subset results do not establish full-MNIST or state-of-the-art performance"],target_outputs:["accepted evidence","reproducible report"],target_venue:null,baseline_repo:"local immutable fixture",domain:"machine-learning"}))')
PROJECT_BODY=$(BRIEF="$BRIEF" node -e 'process.stdout.write(JSON.stringify({name:"MNIST handwritten-digit reproduction",workspace:"/work",brief:JSON.parse(process.env.BRIEF),creator_principal_id:"mnist-readme-pi",execution:{runner_profile_id:"profile_local_docker_cpu_v1"}}))')
PROJ=$(api -X POST "$BASE/v1/projects" -d "$PROJECT_BODY" | jfield '.project_id')
[ -n "$PROJ" ]

SCOPE_GATE=$(api -X POST "$BASE/v1/projects/$PROJ/gates" -d '{"type":"scope","title":"MNIST reproduction scope"}' | jfield '.gate_id')
human_decide "$SCOPE_GATE" '{"actor":"mnist-readme","principal":{"principal_id":"mnist-readme-pi"},"decision":"approved","reason":"Bounded CPU reproduction with immutable subset and preregistered seeds."}' >/dev/null
REV=$(api "$BASE/v1/projects/$PROJ" | jfield '.revision')
api -X POST "$BASE/v1/projects/$PROJ/transitions" -d "{\"to\":\"SURVEYING\",\"expected_revision\":$REV}" >/dev/null

NOW=$(date -u +%Y-%m-%dT%H:%M:%S.000Z)
CORPUS_BODY=$(NOW="$NOW" node -e 'process.stdout.write(JSON.stringify({queries:[{source:"openalex",query:"convolutional neural networks MNIST handwritten digit classification",run_at:process.env.NOW}],papers:[{paper_id:"user:lecun-mnist",title:"Gradient-Based Learning Applied to Document Recognition",authors:["Yann LeCun","Léon Bottou","Yoshua Bengio","Patrick Haffner"],year:1998,venue:"Proceedings of the IEEE",source:"user",identifiers:{},abstract:"Canonical reference for convolutional handwritten digit recognition.",retrieved_at:process.env.NOW}],source_status:"complete"}))')
CORPUS=$(api -X POST "$BASE/v1/projects/$PROJ/corpus" -d "$CORPUS_BODY")
CORPUS_ID=$(printf '%s' "$CORPUS" | jfield '.snapshot_id')

IDEA_BODY=$(CORPUS_ID="$CORPUS_ID" node -e 'process.stdout.write(JSON.stringify({corpus_snapshot_id:process.env.CORPUS_ID,title:"Two-convolution CNN with per-channel normalization",hypothesis:"The treatment raises paired-seed test accuracy over the single-convolution baseline on the fixed MNIST subset.",scientific_gap:{claims:["The treatment delta has not been verified under identical data, epochs and seeds."],statement:"Verify the treatment effect under identical data, epochs and seeds."},nearest_prior_works:[{paper_id:"user:lecun-mnist",same:["convolutional handwritten-digit classification"],different:["paired deterministic reproduction of the treatment delta"]}],exact_delta:"Add a second convolution and per-channel normalization while keeping data, epochs and seeds fixed.",falsification:{observation:"The paired-seed mean difference is non-positive or its 95% interval includes zero."},minimum_viable_experiment:{dataset:"mnist_subset_v1",baseline:"single_conv_cnn_5_epochs",primary_metric:"test_accuracy",estimated_gpu_hours:0,expected_runtime:"under five minutes on local CPU Docker"},scores:{feasibility:5,information_gain:4,reproducibility:5,cost:5},risk_notes:"Small deterministic subset; not a benchmark claim."}))')
IDEA=$(api -X POST "$BASE/v1/projects/$PROJ/ideas" -d "$IDEA_BODY")
IDEA_ID=$(printf '%s' "$IDEA" | jfield '.idea_id')
REV=$(api "$BASE/v1/projects/$PROJ" | jfield '.revision')
IDEA_PREPARE_BODY=$(REV="$REV" IDEA_ID="$IDEA_ID" NOW="$NOW" node -e 'process.stdout.write(JSON.stringify({idea_id:process.env.IDEA_ID,expected_project_revision:Number(process.env.REV),expected_idea_version:1,novelty_audit:{queries:["two convolution per-channel normalization MNIST paired seeds"],result:"no_direct_match_found",overlap_papers:[],unresolved_risk:"medium",audited_at:process.env.NOW}}))')
IDEA_GATE=$(api -H 'x-principal-id: mnist-readme-pi' -H 'x-principal-role: pi' -X POST "$BASE/v2/projects/$PROJ/idea-gate" -d "$IDEA_PREPARE_BODY" | jfield '.gate.gate_id')
human_decide "$IDEA_GATE" '{"actor":"mnist-readme","principal":{"principal_id":"mnist-readme-pi"},"decision":"approved","reason":"The delta is measurable and bounded."}' >/dev/null
REV=$(api "$BASE/v1/projects/$PROJ" | jfield '.revision')
api -X POST "$BASE/v1/projects/$PROJ/transitions" -d "{\"to\":\"CONTRACT_PENDING\",\"expected_revision\":$REV}" >/dev/null

CONTRACT_BODY=$(IDEA_ID="$IDEA_ID" DATA_SHA="$DATA_SHA" node -e 'process.stdout.write(JSON.stringify({idea_id:process.env.IDEA_ID,data:{dataset_id:"mnist_subset_v1",version:"sha256:"+process.env.DATA_SHA,split:"train-6000_test-1000_fixed"},methods:{baseline:"single_conv_cnn_5_epochs",treatment:"two_conv_channel_norm_cnn_5_epochs"},metrics:{primary:"test_accuracy",secondary:[],direction:"higher_is_better"},seeds:[11,23,47],analysis:{effect_size:"paired_mean_difference_percentage_points",interval:"bootstrap_95",multiple_testing:"none"},stop_conditions:{max_gpu_hours:0,min_completed_seeds:3,stop_on_data_leakage:true}}))')
CT=$(api -X POST "$BASE/v1/projects/$PROJ/contracts" -d "$CONTRACT_BODY" | jfield '.contract_id')
CONTRACT_GATE=$(api -X POST "$BASE/v1/projects/$PROJ/gates" -d "{\"type\":\"contract\",\"title\":\"Freeze MNIST experiment contract\",\"payload\":{\"contract_id\":\"$CT\"}}" | jfield '.gate_id')
human_decide "$CONTRACT_GATE" '{"actor":"mnist-readme","principal":{"principal_id":"mnist-readme-pi"},"decision":"approved","reason":"Dataset, methods, metric and seeds are frozen."}' >/dev/null

mkdir -p "$WORK/fixture"
cp "$FIXTURE/baseline_cnn.js" "$FIXTURE/train_cnn.js" "$FIXTURE/mnist_subset.json" "$WORK/fixture/"
WS=$(code_snapshot_seed_workspace "$PORT" "$PROJ" mnist-fixture "$WORK/fixture")
SNAPSHOT=$(code_snapshot_api "$PORT" "$PROJ" "$WS" '' 'MNIST 6k/1k deterministic fixture')
CODE_SNAPSHOT_ID=$(printf '%s' "$SNAPSHOT" | jfield '.snapshot_id')
CODE_ART=$(printf '%s' "$SNAPSHOT" | jfield '.archive_artifact_id')
DATA_ART=$(FILE="$WORK/fixture/mnist_subset.json" PROJ="$PROJ" node -e 'const fs=require("node:fs");process.stdout.write(JSON.stringify({project_id:process.env.PROJ,kind:"data",content_base64:fs.readFileSync(process.env.FILE).toString("base64"),media_type:"application/json",file_name:"mnist_subset.json",metadata:{dataset:"MNIST",split:"train-6000_test-1000_fixed"}}))' \
  | api -X POST "$BASE/v1/artifacts" -d @- | jfield '.artifact_id')

wait_job() {
  key=$1
  for _ in $(seq 1 1200); do
    status=$(api "$BASE/v1/projects/$PROJ/jobs" | KEY="$key" node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{const j=JSON.parse(d).find(x=>x.idempotency_key===process.env.KEY);process.stdout.write(j?.status??"missing")})')
    case "$status" in succeeded|failed|cancelled) printf '%s' "$status"; return 0;; esac
    sleep 0.25
  done
  printf timeout
}

submit_baseline() {
  seed=$1
  REV=$(api "$BASE/v1/projects/$PROJ" | jfield '.revision')
  BODY=$(REV="$REV" SEED="$seed" CT="$CT" SNAP="$CODE_SNAPSHOT_ID" DATA="$DATA_ART" IMG="$IMG" node -e 'process.stdout.write(JSON.stringify({expected_revision:Number(process.env.REV),idempotency_key:"mnist-baseline-"+process.env.SEED,contract_id:process.env.CT,code_snapshot_id:process.env.SNAP,seed:Number(process.env.SEED),data_artifact_ids:[process.env.DATA],image_digest:process.env.IMG,output_contract:{metrics:"/outputs/metrics.json",logs:"/outputs/run.log"},command:["node","/work/baseline_cnn.js","--seed",process.env.SEED,"--data","/work/mnist_subset.json","--output","/outputs/metrics.json","--contract-id",process.env.CT]}))')
  api -X POST "$BASE/v1/projects/$PROJ/baseline-runs" -d "$BODY" >/dev/null
  [ "$(wait_job "mnist-baseline-$seed")" = succeeded ]
}

for seed in 11 23 47; do
  echo "running baseline seed=$seed"
  submit_baseline "$seed"
done

REV=$(api "$BASE/v1/projects/$PROJ" | jfield '.revision')
api -X POST "$BASE/v1/projects/$PROJ/transitions" -d "{\"to\":\"EXPERIMENTING\",\"expected_revision\":$REV}" >/dev/null

PROTOCOL=$(formal_fixture_register_protocol "$BASE" "$PROJ" "$CT" "$CODE_ART" "$DATA_ART" 'mnist-readme-pi' 'protocol_mnist_readme_v1' 'test_accuracy')
PROTOCOL_HASH=$(printf '%s' "$PROTOCOL" | jfield '.record.canonical_hash')

submit_formal() {
  seed=$1
  BODY=$(SEED="$seed" CT="$CT" SNAP="$CODE_SNAPSHOT_ID" DATA="$DATA_ART" IMG="$IMG" PHASH="$PROTOCOL_HASH" node -e 'process.stdout.write(JSON.stringify({idempotency_key:"mnist-formal-"+process.env.SEED,kind:"formal",contract_id:process.env.CT,code_snapshot_id:process.env.SNAP,data_artifact_ids:[process.env.DATA],payload:{seed:Number(process.env.SEED),data_hash:process.env.DATA},image_digest:process.env.IMG,run_intent:"confirmatory",protocol_pin:{protocol_id:"protocol_mnist_readme_v1",revision:1,canonical_hash:process.env.PHASH},output_contract:{metrics:"/outputs/metrics.json",logs:"/outputs/run.log"},command:["node","/work/train_cnn.js","--seed",process.env.SEED,"--data","/work/mnist_subset.json","--output","/outputs/metrics.json","--contract-id",process.env.CT]}))')
  api -X POST "$BASE/v1/projects/$PROJ/jobs" -d "$BODY" >/dev/null
  [ "$(wait_job "mnist-formal-$seed")" = succeeded ]
}

for seed in 11 23 47; do
  echo "running treatment seed=$seed"
  submit_formal "$seed"
done

JOBS=$(api "$BASE/v1/projects/$PROJ/jobs")
printf '%s' "$JOBS" >"$WORK/jobs.json"
RUNS=$(api "$BASE/v1/projects/$PROJ/runs")
printf '%s' "$RUNS" >"$WORK/runs.json"
ANALYSIS=$(api -X POST "$BASE/v1/projects/$PROJ/analysis" -d '{"metric":"test_accuracy"}')
printf '%s' "$ANALYSIS" >"$WORK/analysis.json"
MEAN=$(printf '%s' "$ANALYSIS" | jfield '.mean')
BASELINE=$(printf '%s' "$ANALYSIS" | jfield '.baseline_value')
EFFECT=$(printf '%s' "$ANALYSIS" | jfield '.effect_size')
CI_LOW=$(printf '%s' "$ANALYSIS" | jfield '.ci_low')
CI_HIGH=$(printf '%s' "$ANALYSIS" | jfield '.ci_high')
ANALYSIS_ART=$(printf '%s' "$ANALYSIS" | jfield '.artifact_id')
CHART_ART=$(printf '%s' "$ANALYSIS" | jfield '.chart_artifact')

RUN_IDS=$(WORK="$WORK" node -e 'const j=JSON.parse(require("node:fs").readFileSync(process.env.WORK+"/jobs.json","utf8"));process.stdout.write(JSON.stringify(j.filter(x=>x.idempotency_key.startsWith("mnist-formal-")).sort((a,b)=>a.idempotency_key.localeCompare(b.idempotency_key)).map(x=>x.run_manifest.run_id)))')
EV_BODY=$(PROJ="$PROJ" RUN_IDS="$RUN_IDS" ART="$ANALYSIS_ART" MEAN="$MEAN" BASELINE="$BASELINE" EFFECT="$EFFECT" LO="$CI_LOW" HI="$CI_HIGH" node -e 'process.stdout.write(JSON.stringify({project_id:process.env.PROJ,source_type:"analysis",run_ids:JSON.parse(process.env.RUN_IDS),artifact_refs:[process.env.ART],analysis_method:"paired-percentile-bootstrap-95",result:{primary_metric:"test_accuracy",value:Number(process.env.MEAN),baseline_value:Number(process.env.BASELINE),effect_size:Number(process.env.EFFECT),ci_low:Number(process.env.LO),ci_high:Number(process.env.HI),n_seeds:3},uncertainty:"Fixed 6,000/1,000 subset, three seeds, CPU-only; not a full-MNIST or SOTA claim."}))')
EVIDENCE=$(api -H 'x-service-principal: analysis-worker' -X POST "$BASE/v1/projects/$PROJ/evidence/verified" -d "$EV_BODY")
EVIDENCE_ID=$(printf '%s' "$EVIDENCE" | jfield '.evidence_id')
api -H 'x-service-principal: verifier' -X POST "$BASE/v1/projects/$PROJ/evidence/$EVIDENCE_ID/accept" -d '{"request_id":"mnist-readme-evidence-accept"}' >/dev/null

CLAIM_BODY=$(node -e 'process.stdout.write(JSON.stringify({statement:"On the fixed MNIST 6,000/1,000 subset, the two-convolution network with per-channel normalization improves paired-seed test accuracy over the single-convolution baseline.",scope:{dataset:"mnist_subset_v1",split:"train-6000_test-1000_fixed",seeds:[11,23,47]}}))')
CLAIM_ID=$(api -X POST "$BASE/v1/projects/$PROJ/claims" -d "$CLAIM_BODY" | jfield '.claim_id')
VERIFY_BODY=$(EVIDENCE_ID="$EVIDENCE_ID" ANALYSIS_ART="$ANALYSIS_ART" node -e 'process.stdout.write(JSON.stringify({evidence_ids:[process.env.EVIDENCE_ID],analysis_artifact:process.env.ANALYSIS_ART,reason:"Accepted paired-seed analysis with an interval excluding zero."}))')
api -X POST "$BASE/v1/claims/verify" -d "$(CLAIM_ID="$CLAIM_ID" VERIFY_BODY="$VERIFY_BODY" node -e 'const body=JSON.parse(process.env.VERIFY_BODY);process.stdout.write(JSON.stringify({claim_id:process.env.CLAIM_ID,...body}))')" >/dev/null

REV=$(api "$BASE/v1/projects/$PROJ" | jfield '.revision')
api -X POST "$BASE/v1/projects/$PROJ/transitions" -d "{\"to\":\"EVIDENCE_READY\",\"expected_revision\":$REV}" >/dev/null
REV=$(api "$BASE/v1/projects/$PROJ" | jfield '.revision')
api -X POST "$BASE/v1/projects/$PROJ/transitions" -d "{\"to\":\"WRITING\",\"expected_revision\":$REV}" >/dev/null
MANUSCRIPT=$(api -X POST "$BASE/v1/projects/$PROJ/manuscripts/build" -d '{"format":"markdown"}')
printf '%s' "$MANUSCRIPT" >"$WORK/manuscript.json"

PROJECT=$(api "$BASE/v1/projects/$PROJ")
REVISION=$(printf '%s' "$PROJECT" | jfield '.revision')
WORK="$WORK" PROJ="$PROJ" REVISION="$REVISION" PORT="$PORT" KERNEL_PID="$KERNEL_PID" DATA_SHA="$DATA_SHA" CODE_SNAPSHOT_ID="$CODE_SNAPSHOT_ID" CODE_ART="$CODE_ART" DATA_ART="$DATA_ART" CT="$CT" PROTOCOL_HASH="$PROTOCOL_HASH" ANALYSIS_ART="$ANALYSIS_ART" CHART_ART="$CHART_ART" EVIDENCE_ID="$EVIDENCE_ID" CLAIM_ID="$CLAIM_ID" MEAN="$MEAN" BASELINE="$BASELINE" EFFECT="$EFFECT" CI_LOW="$CI_LOW" CI_HIGH="$CI_HIGH" IMG="$IMG" node - <<'NODE'
const fs = require('node:fs')
const jobs = JSON.parse(fs.readFileSync(process.env.WORK + '/jobs.json', 'utf8'))
const runs = JSON.parse(fs.readFileSync(process.env.WORK + '/runs.json', 'utf8'))
const runsByJob = new Map(runs.map(run => [run.job_id, run]))
const rows = jobs.filter(j => j.idempotency_key.startsWith('mnist-')).sort((a, b) => a.idempotency_key.localeCompare(b.idempotency_key)).map(j => ({
  job_id: j.job_id,
  run_id: j.run_manifest?.run_id ?? null,
  kind: j.kind,
  seed: j.run_manifest?.seed ?? null,
  status: j.status,
  attempt_no: runsByJob.get(j.job_id)?.attempt_no ?? null,
  signature_status: runsByJob.get(j.job_id)?.signature_status ?? null,
  metrics_artifact: j.run_manifest?.metrics_artifact ?? null,
}))
const report = {
  generated_at: new Date().toISOString(),
  project_id: process.env.PROJ,
  project_revision: Number(process.env.REVISION),
  kernel_port: Number(process.env.PORT),
  kernel_pid: Number(process.env.KERNEL_PID),
  dataset: { name: 'MNIST deterministic subset', train: 6000, test: 1000, sha256: `sha256:${process.env.DATA_SHA}` },
  execution: { runner_profile_id: 'profile_local_docker_cpu_v1', runner_target_id: 'target_local_docker_v1', image_digest: process.env.IMG, seeds: [11, 23, 47] },
  pins: { contract_id: process.env.CT, code_snapshot_id: process.env.CODE_SNAPSHOT_ID, code_archive_sha256: process.env.CODE_ART, data_artifact_id: process.env.DATA_ART, protocol_id: 'protocol_mnist_readme_v1', protocol_sha256: process.env.PROTOCOL_HASH },
  result: { metric: 'test_accuracy', unit: 'percent', baseline_mean: Number(process.env.BASELINE), treatment_mean: Number(process.env.MEAN), paired_effect: Number(process.env.EFFECT), ci95: [Number(process.env.CI_LOW), Number(process.env.CI_HIGH)], n: 3 },
  evidence: { analysis_artifact_id: process.env.ANALYSIS_ART, chart_artifact_id: process.env.CHART_ART, evidence_id: process.env.EVIDENCE_ID, status: 'accepted', claim_id: process.env.CLAIM_ID },
  jobs: rows,
}
fs.writeFileSync(process.env.WORK + '/report.json', JSON.stringify(report, null, 2) + '\n')
fs.writeFileSync(process.env.WORK + '/state.json', JSON.stringify({ work: process.env.WORK, project_id: process.env.PROJ, port: Number(process.env.PORT), kernel_pid: Number(process.env.KERNEL_PID) }, null, 2) + '\n')
NODE

kill "$RUNNER_PID" 2>/dev/null || true
wait "$RUNNER_PID" 2>/dev/null || true
RUNNER_PID=''
SUCCEEDED=1
trap - EXIT
echo "MNIST reproduction completed"
echo "STATE=$WORK/state.json"
echo "REPORT=$WORK/report.json"
cat "$WORK/report.json"
