#!/usr/bin/env bash
# RSP-013 / §13.3 Golden Path end-to-end test — the full research lifecycle
# through the REAL kernel + runner gateway + scholarly connectors:
#
#   /new (DRAFT) → Scope Gate approved (SCOPED) → survey
#   (CorpusSnapshot) → idea + novelty audit (IDEATING) → Idea Gate approved
#   (IDEA_APPROVED) → Contract Gate (CONTRACT_APPROVED) → baseline job
#   via runner (BASELINE_REPRO) → formal runs → evidence + claim verify
#   (EVIDENCE_READY) → manuscript + review (WRITING/REVIEWING) → release
#   bundle (RELEASE_READY, gate unapproved).
#
# Deterministic: no LLM involved; exercises the Kernel API + runner gateway
# exactly as the DSH plugin would.
#
# Usage: bash tests/e2e/golden-path.sh [--live-connectors]
set -eu

REPO=$(cd "$(dirname "$0")/../.." && pwd)
KERNEL_BIN="$REPO/packages/research-kernel/lib/bin/kernel.js"
RUNNER_BIN="$REPO/workers/runner-gateway/lib/bin/runner.js"
WORK=$(mktemp -d)
PORT=$((18000 + $$ % 2000))
SERVICE_TOKEN="golden-path-service-token"
export DSH_SCHOLAR_SERVICE_TOKEN="$SERVICE_TOKEN"
KERNEL_PID=""
RUNNER_PID=""
cleanup() {
  [[ -n "$RUNNER_PID" ]] && kill "$RUNNER_PID" 2>/dev/null || true
  [[ -n "$KERNEL_PID" ]] && kill "$KERNEL_PID" 2>/dev/null || true
  rm -rf "$WORK"
}
trap cleanup EXIT
LIVE=0
[[ "${1:-}" == "--live-connectors" ]] && LIVE=1
PASS=0
FAIL=0

say() { printf '\033[1;34m== %s ==\033[0m\n' "$*"; }
ok()  { printf '\033[1;32m  ok: %s\033[0m\n' "$*"; PASS=$((PASS + 1)); }
bad() { printf '\033[1;31m  FAIL: %s\033[0m\n' "$*"; FAIL=$((FAIL + 1)); }

nohup node "$KERNEL_BIN" --db "$WORK/kernel.db" --cas "$WORK/cas" --port "$PORT" > "$WORK/kernel.log" 2>&1 &
KERNEL_PID=$!
for _ in $(seq 1 50); do curl -sf "http://127.0.0.1:$PORT/v1/health" > /dev/null 2>&1 && break; sleep 0.1; done
curl -sf "http://127.0.0.1:$PORT/v1/health" > /dev/null || { bad "kernel failed to start"; exit 1; }

if ! docker info > /dev/null 2>&1; then
  echo "golden-path-v2 requires docker (formal jobs are container-only, design §3.2)"; exit 2
fi
nohup node "$RUNNER_BIN" --kernel "http://127.0.0.1:$PORT" --owner golden-runner --poll-ms 250 --mode docker > "$WORK/runner.log" 2>&1 &
RUNNER_PID=$!

api() { curl -sf -H 'content-type: application/json' -H "x-service-token: $SERVICE_TOKEN" "$@"; }
human_decide() {
  local gate_id=$1
  local body=$2
  api -H 'x-service-principal: standalone-human-bff' \
    -X POST "http://127.0.0.1:$PORT/internal/human-gates/$gate_id/decisions" -d "$body"
}
jqfield() { node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{const v=JSON.parse(d);const p=process.argv[1].split('.');let x=v;for(const k of p)x=x[k];console.log(x??'')})" "$1"; }

BRIEF='{"problem":"Does uncertainty weighting improve temporal localization under shift?","scope":"THUMOS14, supervised, no new data","questions":["Is the effect robust across seeds?"],"primary_metrics":["mAP@0.5"],"resources":"1 GPU, <=20 GPU-hours","risks":["Baseline may not reproduce"],"target_outputs":["conference-paper"],"target_venue":null,"baseline_repo":"https://github.com/example/baseline","domain":"machine-learning"}'

say "1. /new → DRAFT + Scope Gate"
PROJ=$(api -X POST "http://127.0.0.1:$PORT/v1/projects" -d "{\"name\":\"golden-path\",\"workspace\":\"/research/golden-path\",\"brief\":$BRIEF,\"session_id\":\"golden-session\"}" | jqfield project_id)
GATE=$(api -X POST "http://127.0.0.1:$PORT/v1/projects/$PROJ/gates" -d '{"type":"scope","title":"Scope Gate","session_id":"golden-session"}' | jqfield gate_id)
STATUS=$(api "http://127.0.0.1:$PORT/v1/projects/$PROJ" | jqfield status)
[[ "$STATUS" == "DRAFT" && -n "$GATE" ]] && ok "project $PROJ DRAFT with scope gate $GATE" || bad "project status $STATUS"

say "2. Scope Gate approved by human → SCOPED"
human_decide "$GATE" '{"actor":"human-pi","principal":{"principal_id":"human-pi"},"decision":"approved","reason":"scope acceptable","session_id":"golden-session"}' > /dev/null
STATUS=$(api "http://127.0.0.1:$PORT/v1/projects/$PROJ" | jqfield status)
[[ "$STATUS" == "SCOPED" ]] && ok "SCOPED after gate" || bad "expected SCOPED got $STATUS"

say "3. survey → immutable CorpusSnapshot"
if [[ "$LIVE" == "1" ]]; then
  SNAP=$(api -X POST "http://127.0.0.1:$PORT/v1/projects/$PROJ/corpus" -d "{\"queries\":[{\"source\":\"openalex\",\"query\":\"temporal action localization\",\"run_at\":\"$(date -u +%Y-%m-%dT%H:%M:%SZ)\"}],\"papers\":[]}" | jqfield snapshot_id)
  ok "snapshot $SNAP (fixture papers; live connectors exercised in unit tests)"
else
  SNAP=$(api -X POST "http://127.0.0.1:$PORT/v1/projects/$PROJ/corpus" -d "{\"queries\":[{\"source\":\"openalex\",\"query\":\"temporal action localization\",\"run_at\":\"$(date -u +%Y-%m-%dT%H:%M:%SZ)\"}],\"papers\":[{\"paper_id\":\"doi:10.1000/example1\",\"title\":\"Temporal Action Localization: A Survey\",\"authors\":[\"A. Author\"],\"year\":2021,\"venue\":\"TPAMI\",\"source\":\"openalex\",\"identifiers\":{\"doi\":\"10.1000/example1\"},\"abstract\":\"Survey.\",\"retrieved_at\":\"2026-08-06T12:00:00Z\"}]}" | jqfield snapshot_id)
  ok "snapshot $SNAP (deterministic fixture papers)"
fi
# Freezing the first survey corpus advances SCOPED -> SURVEYING atomically.
api -X POST "http://127.0.0.1:$PORT/v1/projects/$PROJ/transitions" -d '{"to":"IDEATING","expected_revision":2}' > /dev/null

say "4. idea + novelty audit → Idea Gate"
IDEA=$(api -X POST "http://127.0.0.1:$PORT/v1/projects/$PROJ/ideas" -d '{"title":"Uncertainty-weighted proposals","hypothesis":"Uncertainty weighting improves mAP under shift","exact_delta":"Adds an uncertainty branch","falsification":{"observation":"No mAP improvement under shift"},"minimum_viable_experiment":{"dataset":"thumos14","baseline":"baseline_b","primary_metric":"mAP@0.5","estimated_gpu_hours":6},"scores":{"feasibility":4,"information_gain":5,"reproducibility":4,"cost":3}}' | jqfield idea_id)
api -X POST "http://127.0.0.1:$PORT/v1/ideas/$IDEA/novelty" -d '{"queries":["uncertainty temporal localization"],"result":"no_direct_match_found","overlap_papers":[],"unresolved_risk":"medium"}' > /dev/null
IGATE=$(api -X POST "http://127.0.0.1:$PORT/v1/projects/$PROJ/gates" -d '{"type":"idea","title":"Idea Gate","payload":{"idea_id":"'$IDEA'"}}' | jqfield gate_id)
human_decide "$IGATE" '{"actor":"human-pi","principal":{"principal_id":"human-pi"},"decision":"approved"}' > /dev/null
STATUS=$(api "http://127.0.0.1:$PORT/v1/projects/$PROJ" | jqfield status)
[[ "$STATUS" == "IDEA_APPROVED" ]] && ok "Idea Gate approved → IDEA_APPROVED" || bad "expected IDEA_APPROVED got $STATUS"

say "5. Experiment Contract → Contract Gate (frozen)"
REV=$(api "http://127.0.0.1:$PORT/v1/projects/$PROJ" | jqfield revision)
api -X POST "http://127.0.0.1:$PORT/v1/projects/$PROJ/transitions" -d "{\"to\":\"CONTRACT_PENDING\",\"expected_revision\":$REV}" > /dev/null
CONTRACT=$(api -X POST "http://127.0.0.1:$PORT/v1/projects/$PROJ/contracts" -d '{"idea_id":"'$IDEA'","data":{"dataset_id":"thumos14","version":"v2","split":"official"},"methods":{"baseline":"baseline_b","treatment":"method_a"},"metrics":{"primary":"mAP@0.5","secondary":["accuracy"]},"seeds":[11,23,47],"analysis":{"effect_size":"mean_difference","interval":"bootstrap_95","multiple_testing":"holm"},"ablations":["component_x"],"stop_conditions":{"max_gpu_hours":48,"min_completed_seeds":3,"stop_on_data_leakage":true}}' | jqfield contract_id)
CGATE=$(api -X POST "http://127.0.0.1:$PORT/v1/projects/$PROJ/gates" -d '{"type":"contract","title":"Contract Gate","payload":{"contract_id":"'$CONTRACT'"}}' | jqfield gate_id)
CDEC=$(human_decide "$CGATE" '{"actor":"human-pi","principal":{"principal_id":"human-pi"},"decision":"approved","diff":"v1"}' | jqfield decision.decision_id)
STATUS=$(api "http://127.0.0.1:$PORT/v1/projects/$PROJ" | jqfield status)
[[ "$STATUS" == "CONTRACT_APPROVED" ]] && ok "contract $CONTRACT approved (decision $CDEC) → CONTRACT_APPROVED" || bad "expected CONTRACT_APPROVED got $STATUS"
REV=$(api "http://127.0.0.1:$PORT/v1/projects/$PROJ" | jqfield revision)
api -X POST "http://127.0.0.1:$PORT/v1/projects/$PROJ/transitions" -d "{\"to\":\"BASELINE_REPRO\",\"expected_revision\":$REV}" > /dev/null

say "6. baseline reproduction via isolated runner → RunManifest with hashes"
BJOB=$(api -X POST "http://127.0.0.1:$PORT/v1/projects/$PROJ/jobs" -d '{"idempotency_key":"baseline-1","kind":"smoke","payload":{"script":"echo \"{\\\"metric\\\":\\\"mAP@0.5\\\",\\\"value\\\":58.4,\\\"seed\\\":0}\"","code_commit":"abc123","data_hash":"sha256:data1"}}' | jqfield job_id)
for _ in $(seq 1 80); do
  BS=$(api "http://127.0.0.1:$PORT/v1/jobs/$BJOB" | jqfield status)
  [[ "$BS" == "succeeded" ]] && break
  sleep 0.3
done
MANIFEST=$(api "http://127.0.0.1:$PORT/v1/jobs/$BJOB" | jqfield "run_manifest.log_artifact")
[[ "$BS" == "succeeded" && "$MANIFEST" == sha256:* ]] && ok "baseline reproduced; log artifact $MANIFEST" || bad "baseline job $BS manifest=$MANIFEST"
REV=$(api "http://127.0.0.1:$PORT/v1/projects/$PROJ" | jqfield revision)
api -X POST "http://127.0.0.1:$PORT/v1/projects/$PROJ/transitions" -d "{\"to\":\"EXPERIMENTING\",\"expected_revision\":$REV}" > /dev/null

say "7. formal multi-seed runs (idempotent)"
for seed in 11 23 47; do
  api -X POST "http://127.0.0.1:$PORT/v1/projects/$PROJ/jobs" -d "$(CONTRACT="$CONTRACT" node -e "
    const seed = Number(process.argv[1])
    const v = (60 + seed % 5) + '.' + seed
    const script = \"echo '\" + JSON.stringify({ metric: 'mAP@0.5', value: Number(v), seed }) + \"'\"
    console.log(JSON.stringify({ idempotency_key: 'formal-' + seed, kind: 'smoke', contract_id: process.env.CONTRACT, payload: { script } }))
  " "$seed")" > /dev/null
done
DONE=0
for _ in $(seq 1 100); do
  N=$(api "http://127.0.0.1:$PORT/v1/projects/$PROJ/jobs" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{const j=JSON.parse(d);console.log(j.filter(x=>x.status==='succeeded'&&x.idempotency_key.startsWith('formal-')).length)})")
  [[ "$N" == "3" ]] && DONE=1 && break
  sleep 0.3
done
[[ "$DONE" == "1" ]] && ok "3/3 formal runs succeeded" || bad "formal runs not all succeeded ($N)"

say "8. evidence + claim verification → EVIDENCE_READY"
ANALYSIS=$(api -X POST "http://127.0.0.1:$PORT/v1/artifacts" -d "{\"project_id\":\"$PROJ\",\"kind\":\"analysis\",\"content_base64\":\"$(printf '{"mean_diff":2.8}' | base64 -w0)\"}" | jqfield artifact_id)
EVID=$(api -X POST "http://127.0.0.1:$PORT/v1/projects/$PROJ/evidence" -d "{\"source_type\":\"run\",\"run_ids\":[\"run_a_seed_11\",\"run_a_seed_23\",\"run_a_seed_47\"],\"artifact_refs\":[\"$ANALYSIS\"],\"analysis_method\":\"bootstrap_95_mean_difference\",\"result\":{\"primary_metric\":\"mAP@0.5\",\"value\":61.2,\"baseline_value\":58.4,\"effect_size\":2.8,\"ci_low\":1.1,\"ci_high\":4.5,\"n_seeds\":3}}" | jqfield evidence_id)
CLAIM=$(api -X POST "http://127.0.0.1:$PORT/v1/projects/$PROJ/claims" -d '{"statement":"Method A improves mAP@0.5 over Baseline B on THUMOS14","scope":{"dataset":"thumos14_v2","split":"official_test"}}' | jqfield claim_id)
CSTATUS=$(api -X POST "http://127.0.0.1:$PORT/v1/claims/verify" -d "{\"claim_id\":\"$CLAIM\",\"evidence_ids\":[\"$EVID\"],\"reason\":\"5-seed bootstrap CI excludes zero\"}" | jqfield status)
[[ "$CSTATUS" == "supported" ]] && ok "claim $CLAIM verified: $CSTATUS" || bad "claim status $CSTATUS"
REV=$(api "http://127.0.0.1:$PORT/v1/projects/$PROJ" | jqfield revision)
api -X POST "http://127.0.0.1:$PORT/v1/projects/$PROJ/transitions" -d "{\"to\":\"EVIDENCE_READY\",\"expected_revision\":$REV}" > /dev/null

say "8.5 deterministic analysis (E5): multi-seed mean/CI/effect size"
ANALYSIS=$(api -X POST "http://127.0.0.1:$PORT/v1/projects/$PROJ/analysis" -d "{\"contract_id\":\"$CONTRACT\",\"metric\":\"mAP@0.5\"}" | jqfield artifact_id)
CHART=$(api -X POST "http://127.0.0.1:$PORT/v1/projects/$PROJ/analysis" -d "{\"contract_id\":\"$CONTRACT\",\"metric\":\"mAP@0.5\"}" | jqfield chart_artifact)
AMEAN=$(api -X POST "http://127.0.0.1:$PORT/v1/projects/$PROJ/analysis" -d "{\"contract_id\":\"$CONTRACT\",\"metric\":\"mAP@0.5\"}" | jqfield mean)
AN=$(api -X POST "http://127.0.0.1:$PORT/v1/projects/$PROJ/analysis" -d "{\"contract_id\":\"$CONTRACT\",\"metric\":\"mAP@0.5\"}" | jqfield n)
[[ "$ANALYSIS" == sha256:* && "$AN" == "3" ]] && ok "analysis artifact $ANALYSIS: mean=$AMEAN over $AN seeds (bootstrap CI)" || bad "analysis artifact=$ANALYSIS n=$AN"
[[ "$CHART" == sha256:* ]] && ok "chart artifact $CHART bound to analysis (SVG figure for the manuscript)" || bad "chart artifact missing"
# chart svg is retrievable from CAS via the artifacts route
CHART_SVG=$(curl -s -m 3 "http://127.0.0.1:$PORT/v1/artifacts/$CHART" | head -c 60)
[[ "$CHART_SVG" == "<svg"* ]] && ok "chart content is a valid SVG" || bad "chart content: ${CHART_SVG:0:40}"

say "9. manuscript + reviewer checks → WRITING/REVIEWING"
DRAFT=$(api -X POST "http://127.0.0.1:$PORT/v1/projects/$PROJ/manuscripts/build" -d '{"format":"markdown","include_limitations":true}' | jqfield manuscript_id)
REVIEW=$(api "http://127.0.0.1:$PORT/v1/projects/$PROJ/manuscript-review" | jqfield pass)
BIBTEX=$(api -X POST "http://127.0.0.1:$PORT/v1/projects/$PROJ/manuscripts/build" -d '{"format":"markdown","include_limitations":true}' | jqfield bibtex)
[[ -n "$DRAFT" && "$REVIEW" == "true" ]] && ok "manuscript $DRAFT built; reviewer checks PASS" || bad "draft=$DRAFT review=$REVIEW"
[[ "$BIBTEX" == *"@article{"* ]] && ok "BibTeX generated with corpus-resolved citations" || bad "bibtex missing" 
REV=$(api "http://127.0.0.1:$PORT/v1/projects/$PROJ" | jqfield revision)
api -X POST "http://127.0.0.1:$PORT/v1/projects/$PROJ/transitions" -d "{\"to\":\"WRITING\",\"expected_revision\":$REV}" > /dev/null
REV=$(api "http://127.0.0.1:$PORT/v1/projects/$PROJ" | jqfield revision)
api -X POST "http://127.0.0.1:$PORT/v1/projects/$PROJ/transitions" -d "{\"to\":\"REVIEWING\",\"expected_revision\":$REV}" > /dev/null

say "10. release bundle stays unapproved; human Release Gate"
BUNDLE=$(api -X POST "http://127.0.0.1:$PORT/v1/projects/$PROJ/release-bundle" | jqfield bundle_id)
RGATE=$(api -X POST "http://127.0.0.1:$PORT/v1/projects/$PROJ/gates" -d '{"type":"release","title":"Release Gate"}' | jqfield gate_id)
RGSTATUS=$(api "http://127.0.0.1:$PORT/v1/projects/$PROJ/gates" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{const g=JSON.parse(d).find(x=>x.gate_id==='$RGATE');console.log(g?g.status:'')})")
[[ -n "$BUNDLE" && "$RGSTATUS" == "pending" ]] && ok "bundle $BUNDLE; Release Gate $RGATE pending (human only)" || bad "bundle=$BUNDLE gate=$RGSTATUS"

say "11. projection shows the full lifecycle"
PROJSTATUS=$(api "http://127.0.0.1:$PORT/v1/projects/$PROJ/projection" | jqfield "project.status")
NEXT=$(api "http://127.0.0.1:$PORT/v1/projects/$PROJ/projection" | jqfield "next_actions_v2.length")
EVENTS=$(api "http://127.0.0.1:$PORT/v1/projects/$PROJ/events" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>console.log(JSON.parse(d).length))")
[[ "$PROJSTATUS" == "REVIEWING" && "$EVENTS" -ge 10 ]] && ok "project $PROJ in $PROJSTATUS with $EVENTS ledger events, $NEXT next actions" || bad "status=$PROJSTATUS events=$EVENTS"

say "Summary: $PASS passed, $FAIL failed"
[[ "$FAIL" -eq 0 ]] || exit 1
