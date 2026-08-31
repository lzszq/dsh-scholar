#!/usr/bin/env bash
# §19.2 P0 blocking tests: host-execution and fake-experiment defenses (v2).
#
#   formal-run-rejects-subprocess      formal job + subprocess runner -> failed
#   baseline-must-execute-real-code    baseline with empty command -> failed
#   formal-run-rejects-message-only    message-only (no command) -> failed
#   job-rejects-unapproved-contract    formal job without approved contract -> rejected
#   kernel-submit-rejects-subprocess   kernel rejects formal on isolated-subprocess profile
#   smoke-rejects-host-subprocess      untrusted smoke + subprocess runner -> failed,
#                                      host marker file must NOT exist (RUN-02)
#   smoke-trusted-fixture-ok           explicit payload.trusted_fixture=true smoke
#                                      + subprocess runner -> succeeded (RUN-02)
#
# Usage: bash tests/security/run-hardening-tests.sh
set -eu

REPO=$(cd "$(dirname "$0")/../.." && pwd)
KERNEL_BIN="$REPO/packages/research-kernel/lib/bin/kernel.js"
RUNNER_BIN="$REPO/workers/runner-gateway/lib/bin/runner.js"
WORK=$(mktemp -d)
PORT=$((19900 + $$ % 300))
PASS=0
FAIL=0
ok() { printf '  ok: %s\n' "$*"; PASS=$((PASS+1)); }
bad() { printf '  FAIL: %s\n' "$*"; FAIL=$((FAIL+1)); }
# §4 P0 (API-01/EVID-01): every kernel below is configured with the fixed
# eval service token (env DSH_SCHOLAR_SERVICE_TOKEN; runners inherit it and
# authenticate their claim/runner-keys/recover calls automatically). The
# curl helper attaches x-service-token so internal routes (approve) work;
# negative tests below use RAW curl without the header on purpose.
export DSH_SCHOLAR_SERVICE_TOKEN='dsh-scholar-eval-service-token'
api() { curl -sf -H 'content-type: application/json' -H "x-service-token: $DSH_SCHOLAR_SERVICE_TOKEN" "$@"; }

nohup node "$KERNEL_BIN" --db "$WORK/kernel.db" --cas "$WORK/cas" --port "$PORT" > "$WORK/kernel.log" 2>&1 &
KERNEL_PID=$!
for _ in $(seq 1 40); do curl -sf "http://127.0.0.1:$PORT/v1/health" > /dev/null 2>&1 && break; sleep 0.1; done
nohup node "$RUNNER_BIN" --kernel "http://127.0.0.1:$PORT" --owner harden --poll-ms 150 > "$WORK/runner.log" 2>&1 &
RUNNER_PID=$!
sleep 0.5

echo "== service-token auth matrix (claim route on a token-configured kernel) =="
NEG_NO=$(curl -s -o "$WORK/neg-no.json" -w '%{http_code}' -X POST "http://127.0.0.1:$PORT/v1/jobs-claim/run" -H 'content-type: application/json' -d '{"owner":"svc-neg","limit":1}')
NEG_ERR=$(node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{try{console.log(JSON.parse(d).error?.code??'')}catch(e){console.log('')}})" < "$WORK/neg-no.json")
NEG_BEARER=$(curl -s -o "$WORK/neg-bearer.json" -w '%{http_code}' -X POST "http://127.0.0.1:$PORT/v1/jobs-claim/run" -H 'content-type: application/json' -H "Authorization: Bearer $DSH_SCHOLAR_SERVICE_TOKEN" -d '{"owner":"svc-neg","limit":1}')
NEG_WRONG=$(curl -s -o "$WORK/neg-wrong.json" -w '%{http_code}' -X POST "http://127.0.0.1:$PORT/v1/jobs-claim/run" -H 'content-type: application/json' -H 'x-service-token: wrong-service-token' -d '{"owner":"svc-neg","limit":1}')
NEG_OK=$(curl -s -o "$WORK/neg-ok.json" -w '%{http_code}' -X POST "http://127.0.0.1:$PORT/v1/jobs-claim/run" -H 'content-type: application/json' -H "x-service-token: $DSH_SCHOLAR_SERVICE_TOKEN" -d '{"owner":"svc-neg","limit":1}')
if [[ "$NEG_NO" == "403" && "$NEG_ERR" == "service_token_required" ]]; then
  ok "claim without x-service-token -> HTTP 403 service_token_required"
else
  bad "claim without token: expected 403 service_token_required, got HTTP $NEG_NO (error=$NEG_ERR)"
fi
if [[ "$NEG_BEARER" == "403" ]]; then
  ok "claim with the token in Authorization (browser bearer) -> HTTP 403 (only x-service-token counts)"
else
  bad "claim with bearer token: expected 403, got HTTP $NEG_BEARER"
fi
if [[ "$NEG_WRONG" == "403" ]]; then
  ok "claim with a wrong x-service-token -> HTTP 403"
else
  bad "claim with wrong token: expected 403, got HTTP $NEG_WRONG"
fi
if [[ "$NEG_OK" == "200" ]]; then
  ok "claim with the correct x-service-token -> HTTP 200"
else
  bad "claim with correct token: expected 200, got HTTP $NEG_OK"
fi

BRIEF='{"problem":"p","scope":"s","questions":[],"primary_metrics":["m"],"resources":"","risks":[],"target_outputs":["paper"],"target_venue":null,"baseline_repo":null,"domain":"machine-learning"}'
PROJ=$(api -X POST "http://127.0.0.1:$PORT/v1/projects" -d "{\"name\":\"harden\",\"workspace\":\"/w\",\"brief\":$BRIEF,\"execution\":{\"runner_profile_id\":\"profile_local_docker_cpu_v1\",\"network_policy\":\"none\",\"artifact_store\":\"local-cas\"}}" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>console.log(JSON.parse(d).project_id))")
ok "project $PROJ on container profile"

# v2 §12.2: formal jobs require a REAL registered code snapshot.
CODE_ART=$(api -X POST "http://127.0.0.1:$PORT/v1/artifacts" -d "{\"project_id\":\"$PROJ\",\"kind\":\"code\",\"content_base64\":\"$(printf 'x=1' | base64 -w0)\"}" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>console.log(JSON.parse(d).artifact_id))")
ok "code snapshot artifact registered: $CODE_ART"

# P0 (acceptance-tests.md §4): formal-class jobs must bind an approved
# contract — register + freeze one so the runner-layer rejection tests below
# exercise EXECUTION failure, not submission rejection.
CT=$(api -X POST "http://127.0.0.1:$PORT/v1/projects/$PROJ/contracts" -d '{"idea_id":"idea_harden","data":{"dataset_id":"harden"},"methods":{"baseline":"b","treatment":"a"},"metrics":{"primary":"m"},"seeds":[1]}' | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>console.log(JSON.parse(d).contract_id))")
api -X POST "http://127.0.0.1:$PORT/v1/projects/$PROJ/contracts/$CT/approve" -d '{"actor":"hardening-eval"}' > /dev/null
ok "contract $CT registered + approved (P0 binding)"

# ── P0-4 (hardening §5 SNAPSHOT-01/API-01): code-snapshot-approved-workspace-only ──

echo "== P0-4 code-snapshot-approved-workspace-only (SNAPSHOT-01/API-01) =="
# The archive root is resolved server-side from an approved project
# workspace — workspace_id + root_relative_path ('' = the whole workspace).
WS=$(api -X POST "http://127.0.0.1:$PORT/v1/projects/$PROJ/workspaces" -d '{"kind":"code","name":"snap-root"}' | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>console.log(JSON.parse(d).workspace_id))")
[[ "$WS" == ws_* ]] && ok "snapshot workspace $WS created (kind=code)" || bad "workspace creation failed: $WS"
api -X POST "http://127.0.0.1:$PORT/v1/projects/$PROJ/workspaces/$WS/nodes" -d '{"path":"main.js","content":"console.log(1)\n"}' > /dev/null
api -X POST "http://127.0.0.1:$PORT/v1/projects/$PROJ/workspaces/$WS/nodes" -d '{"path":"lib/util.js","content":"export const u=1\n"}' > /dev/null
SNAP_OK=$(curl -s -o "$WORK/snap-ok.json" -w '%{http_code}' -X POST "http://127.0.0.1:$PORT/v1/projects/$PROJ/code-snapshots" -H 'content-type: application/json' -d "{\"workspace_id\":\"$WS\",\"root_relative_path\":\"\",\"description\":\"hardening P0-4\"}")
SNAP_ART=$(node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{try{console.log(JSON.parse(d).archive_artifact_id)}catch(e){console.log('')}})" < "$WORK/snap-ok.json")
if [[ "$SNAP_OK" == "201" && "$SNAP_ART" == sha256:* ]]; then
  ok "POST code-snapshots {workspace_id, root_relative_path:''} -> 201 archive $SNAP_ART (whole workspace)"
else
  bad "workspace-root snapshot: expected 201 sha256 archive, got HTTP $SNAP_OK artifact='$SNAP_ART'"
fi
# root-relative SUBDIRECTORY snapshot (keys relative to that root).
SUB_OK=$(curl -s -o "$WORK/snap-sub.json" -w '%{http_code}' -X POST "http://127.0.0.1:$PORT/v1/projects/$PROJ/code-snapshots" -H 'content-type: application/json' -d "{\"workspace_id\":\"$WS\",\"root_relative_path\":\"lib\"}")
SUB_FILES=$(node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{try{console.log(JSON.parse(d).files)}catch(e){console.log('')}})" < "$WORK/snap-sub.json")
if [[ "$SUB_OK" == "201" && "$SUB_FILES" == "1" ]]; then
  ok "root-relative subdirectory snapshot (lib/) -> 201, 1 file archived"
else
  bad "subdirectory snapshot: expected 201 + 1 file, got HTTP $SUB_OK files='$SUB_FILES'"
fi
# The deprecated host-`path` shape is refused (422 validation_error).
OLD_SHAPE=$(curl -s -o "$WORK/snap-old.json" -w '%{http_code}' -X POST "http://127.0.0.1:$PORT/v1/projects/$PROJ/code-snapshots" -H 'content-type: application/json' -d '{"path":"/tmp/whatever","description":"old shape"}')
if [[ "$OLD_SHAPE" == "422" ]]; then
  ok "deprecated host-path body -> HTTP 422 (refused, not re-interpreted)"
else
  bad "old shape: expected 422, got HTTP $OLD_SHAPE"
fi
# Absolute / `..` / drive-prefix root_relative_path are rejected (invalid_path).
for BAD_REL in '/home/user' '../outside' 'C:evil'; do
  BAD_CODE=$(curl -s -o "$WORK/snap-bad.json" -w '%{http_code}' -X POST "http://127.0.0.1:$PORT/v1/projects/$PROJ/code-snapshots" -H 'content-type: application/json' -d "{\"workspace_id\":\"$WS\",\"root_relative_path\":\"$BAD_REL\"}")
  BAD_ERR=$(node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{try{console.log(JSON.parse(d).error?.code??'')}catch(e){console.log('')}})" < "$WORK/snap-bad.json")
  if [[ "$BAD_CODE" == "422" && "$BAD_ERR" == "invalid_path" ]]; then
    ok "root_relative_path '$BAD_REL' -> 422 invalid_path"
  else
    bad "root_relative_path '$BAD_REL': expected 422 invalid_path, got HTTP $BAD_CODE error=$BAD_ERR"
  fi
done
# Cross-project workspace is indistinguishable from a missing one (404).
P_FOREIGN=$(api -X POST "http://127.0.0.1:$PORT/v1/projects" -d "{\"name\":\"harden-foreign\",\"workspace\":\"/w\",\"brief\":$BRIEF}" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>console.log(JSON.parse(d).project_id))")
FOREIGN_CODE=$(curl -s -o "$WORK/snap-foreign.json" -w '%{http_code}' -X POST "http://127.0.0.1:$PORT/v1/projects/$P_FOREIGN/code-snapshots" -H 'content-type: application/json' -d "{\"workspace_id\":\"$WS\"}")
if [[ "$FOREIGN_CODE" == "404" ]]; then
  ok "workspace of ANOTHER project -> HTTP 404 workspace_not_found (no cross-project enumeration)"
else
  bad "cross-project workspace: expected 404, got HTTP $FOREIGN_CODE"
fi
# Secret files are NEVER archived: 422 snapshot_secret_file, zero artifacts.
WS_SEC=$(api -X POST "http://127.0.0.1:$PORT/v1/projects/$PROJ/workspaces" -d '{"kind":"code","name":"snap-secret"}' | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>console.log(JSON.parse(d).workspace_id))")
api -X POST "http://127.0.0.1:$PORT/v1/projects/$PROJ/workspaces/$WS_SEC/nodes" -d '{"path":".env","content":"DSH_SERVICE_TOKEN=x"}' > /dev/null
api -X POST "http://127.0.0.1:$PORT/v1/projects/$PROJ/workspaces/$WS_SEC/nodes" -d '{"path":"train.js","content":"console.log(1)\n"}' > /dev/null
SEC_CODE=$(curl -s -o "$WORK/snap-sec.json" -w '%{http_code}' -X POST "http://127.0.0.1:$PORT/v1/projects/$PROJ/code-snapshots" -H 'content-type: application/json' -d "{\"workspace_id\":\"$WS_SEC\"}")
SEC_ERR=$(node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{try{const e=JSON.parse(d).error;console.log((e?.code??'')+'|'+(e?.message??''))}catch(e){console.log('')}})" < "$WORK/snap-sec.json")
if [[ "$SEC_CODE" == "422" && "$SEC_ERR" == snapshot_secret_file* && "$SEC_ERR" == *".env"* ]]; then
  ok "secret file (.env) in workspace -> 422 snapshot_secret_file listing the file: ${SEC_ERR#*|}"
else
  bad "secret-file snapshot: expected 422 snapshot_secret_file naming .env, got HTTP $SEC_CODE ($SEC_ERR)"
fi

echo "== kernel-submit-rejects-subprocess =="
P2=$(api -X POST "http://127.0.0.1:$PORT/v1/projects" -d "{\"name\":\"harden-sub\",\"workspace\":\"/w\",\"brief\":$BRIEF,\"execution\":{\"runner_profile_id\":\"profile_isolated_subprocess_v1\",\"runner_target_id\":\"target_local_process_v1\"}}" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>console.log(JSON.parse(d).project_id))")
CODE=$(curl -s -o /dev/null -w '%{http_code}' -X POST "http://127.0.0.1:$PORT/v1/projects/$P2/jobs" -H 'content-type: application/json' -d "{\"idempotency_key\":\"f1\",\"kind\":\"formal\",\"command\":[\"true\"],\"code_snapshot_id\":\"$CODE_ART\"}")
[[ "$CODE" == "422" ]] && ok "kernel rejects formal job on isolated-subprocess profile (422)" || bad "expected 422 got $CODE"

echo "== formal-run-rejects-subprocess (runner layer) =="
FORMAL_SUB=$(curl -s -o "$WORK/formal-sub.json" -w '%{http_code}' -X POST "http://127.0.0.1:$PORT/v1/projects/$PROJ/jobs" -H 'content-type: application/json' -d "{\"idempotency_key\":\"f2\",\"kind\":\"formal\",\"contract_id\":\"$CT\",\"image_digest\":\"node@sha256:c610fcdfb1d5b4740dd70c284ed3cb16bb857e0f7166196e36a5501df7a3aa32\",\"command\":[\"true\"],\"code_snapshot_id\":\"$CODE_ART\",\"runner_profile_id\":\"profile_isolated_subprocess_v1\",\"runner_target_id\":\"target_local_process_v1\"}")
FORMAL_ERR=$(node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{try{console.log(JSON.parse(d).error?.code??'')}catch(e){console.log('')}})" < "$WORK/formal-sub.json")
[[ "$FORMAL_SUB" == "422" && "$FORMAL_ERR" == "container_execution_required" ]] && ok "formal + subprocess override rejected at Kernel admission (422 container_execution_required)" || bad "formal subprocess expected 422 container_execution_required, got HTTP $FORMAL_SUB ($FORMAL_ERR)"

echo "== non-echo must-execute-real-code / message-only rejected =="
# RUN-02: smoke defaults to container — the subprocess runner only accepts
# smoke jobs explicitly marked payload.trusted_fixture=true (execution-runtime.md
# §1). This message-only fixture is marked trusted so the test exercises the
# empty-command invariant below, not the container gate.
J2=$(api -X POST "http://127.0.0.1:$PORT/v1/projects/$PROJ/jobs" -d '{"idempotency_key":"b1","kind":"smoke","runner_profile_id":"profile_isolated_subprocess_v1","runner_target_id":"target_local_process_v1","payload":{"trusted_fixture":true,"message":"{\"metric\":\"f1\",\"value\":0.8}"}}' | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>console.log(JSON.parse(d).job_id))")
for _ in $(seq 1 60); do
  S=$(api "http://127.0.0.1:$PORT/v1/jobs/$J2" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>console.log(JSON.parse(d).status))")
  [[ "$S" == "failed" ]] && break
  sleep 0.3
done
E2=$(api "http://127.0.0.1:$PORT/v1/jobs/$J2" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>console.log(JSON.parse(d).error))")
[[ "$E2" == *"empty command"* ]] && ok "non-echo empty command/message-only -> failed (no synthetic success)" || bad "expected empty-command failure got: $E2"
M2=$(api "http://127.0.0.1:$PORT/v1/jobs/$J2" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{const j=JSON.parse(d);console.log((j.run_manifest?.metrics_artifact??'none'))})")
[[ "$M2" == "none" ]] && ok "no metrics artifact for fake run" || bad "metrics artifact should be absent"

echo "== smoke-rejects-host-subprocess (RUN-02: smoke defaults to container) =="
# execution-runtime.md §1: only an EXPLICIT trusted-smoke-fixture
# (payload.trusted_fixture=true) may use the isolated subprocess. The script
# would `touch` a host marker file — if the runner ever executed it on the
# host, the marker would exist and the assertion below fails loudly.
MARKER="/tmp/dsh-smoke-host-executed-$RANDOM"
J3=$(api -X POST "http://127.0.0.1:$PORT/v1/projects/$PROJ/jobs" -d "{\"idempotency_key\":\"s1\",\"kind\":\"smoke\",\"runner_profile_id\":\"profile_isolated_subprocess_v1\",\"runner_target_id\":\"target_local_process_v1\",\"payload\":{\"script\":\"touch $MARKER\"}}" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>console.log(JSON.parse(d).job_id))")
for _ in $(seq 1 60); do
  S=$(api "http://127.0.0.1:$PORT/v1/jobs/$J3" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>console.log(JSON.parse(d).status))")
  [[ "$S" == "failed" ]] && break
  sleep 0.3
done
C3=$(api "http://127.0.0.1:$PORT/v1/jobs/$J3" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{const j=JSON.parse(d);console.log((j.failure_class??'')+'|'+(j.error??''))})")
if [[ "$C3" == environment* && "$C3" == *"trusted-smoke-fixture"* ]]; then
  ok "untrusted smoke + subprocess runner -> failed/environment (trusted-smoke-fixture): ${C3#*|}"
else
  bad "untrusted smoke expected environment + trusted-smoke-fixture message, got: $C3"
fi
if [ ! -e "$MARKER" ]; then
  ok "host marker $MARKER absent — smoke script never executed on the host"
else
  bad "host marker $MARKER EXISTS — smoke script executed on the host!"
fi

echo "== smoke-trusted-fixture-ok (RUN-02: explicit trusted fixture may use subprocess) =="
J4=$(api -X POST "http://127.0.0.1:$PORT/v1/projects/$PROJ/jobs" -d '{"idempotency_key":"s2","kind":"smoke","runner_profile_id":"profile_isolated_subprocess_v1","runner_target_id":"target_local_process_v1","payload":{"trusted_fixture":true,"script":"echo \"{\\\"metric\\\":\\\"f1\\\",\\\"value\\\":0.5}\""}}' | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>console.log(JSON.parse(d).job_id))")
for _ in $(seq 1 60); do
  S=$(api "http://127.0.0.1:$PORT/v1/jobs/$J4" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>console.log(JSON.parse(d).status))")
  [[ "$S" == "succeeded" ]] && break
  sleep 0.3
done
M4=$(api "http://127.0.0.1:$PORT/v1/jobs/$J4" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{const j=JSON.parse(d);console.log((j.run_manifest?.metrics_artifact??'none'))})")
if [[ "$S" == "succeeded" && "$M4" == sha256:* ]]; then
  ok "trusted smoke fixture + subprocess runner -> succeeded, script metrics artifact $M4"
else
  bad "trusted smoke expected succeeded + metrics artifact, got status=$S metrics=$M4"
fi
# Docker mode smoke (unmarked) is covered by evals/docker-eval.sh and
# evals/release-bundle/run-release-eval.sh (both run smoke scripts with
# --mode docker) — no separate case needed here.

echo "== SCH-JOB-001/002: subprocess heartbeat renews lease; cancel terminates the real process =="
# Dedicated kernel+runner pair with fast heartbeat/cancel polling (the main
# pair keeps default timings). No docker needed: subprocess execution must
# honor the same durable-job contract (§12.6).
PORT2=$((PORT + 1))
nohup node "$KERNEL_BIN" --db "$WORK/kernel2.db" --cas "$WORK/cas2" --port "$PORT2" > "$WORK/kernel2.log" 2>&1 &
KERNEL2_PID=$!
for _ in $(seq 1 40); do curl -sf "http://127.0.0.1:$PORT2/v1/health" > /dev/null 2>&1 && break; sleep 0.1; done
nohup node "$RUNNER_BIN" --kernel "http://127.0.0.1:$PORT2" --owner harden2 --poll-ms 150 --timeout-ms 30000 --heartbeat-ms 1500 --cancel-poll-ms 1000 > "$WORK/runner2.log" 2>&1 &
RUNNER2_PID=$!
sleep 0.5
PROJ2=$(api -X POST "http://127.0.0.1:$PORT2/v1/projects" -d "{\"name\":\"harden2\",\"workspace\":\"/w\",\"brief\":$BRIEF,\"execution\":{\"runner_profile_id\":\"profile_isolated_subprocess_v1\",\"runner_target_id\":\"target_local_process_v1\"}}" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>console.log(JSON.parse(d).project_id))")
ok "durable-jobs project $PROJ2"

# Long-running subprocess (node timeout 90s; the runner's 30s timeout would
# only fire if cancel failed — the assertions below would then fail loudly).
# The marker is split across variables so pgrep never matches this script.
# RUN-02: the subprocess runner requires the explicit trusted-smoke-fixture
# marker for smoke jobs (execution-runtime.md §1).
M1="zzq-cancel"; M2="marker-98765"
JL=$(api -X POST "http://127.0.0.1:$PORT2/v1/projects/$PROJ2/jobs" -d "{\"idempotency_key\":\"h-cancel\",\"kind\":\"smoke\",\"payload\":{\"trusted_fixture\":true,\"script\":\"node -e \\\"setTimeout(function(){},90000); //$M1-$M2\\\"\"}}" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>console.log(JSON.parse(d).job_id))")
S=""
for _ in $(seq 1 40); do
  S=$(api "http://127.0.0.1:$PORT2/v1/jobs/$JL" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>console.log(JSON.parse(d).status))")
  [[ "$S" == "running" ]] && break; sleep 0.25
done
[[ "$S" == "running" ]] && ok "long subprocess job running ($JL)" || bad "long subprocess job not running: $S"

H1=$(api "http://127.0.0.1:$PORT2/v1/jobs/$JL" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>console.log(JSON.parse(d).heartbeat_at??''))")
HB=no
for _ in $(seq 1 30); do
  H2=$(api "http://127.0.0.1:$PORT2/v1/jobs/$JL" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>console.log(JSON.parse(d).heartbeat_at??''))")
  [[ -n "$H2" && "$H2" != "$H1" ]] && HB=yes && break
  sleep 0.3
done
[[ "$HB" == "yes" ]] && ok "subprocess heartbeat renewed lease while running ($H1 → $H2)" || bad "subprocess heartbeat_at never advanced (H1=$H1)"

# Find the REAL executing process (the marker lives in node's argv).
CHILD=""
for _ in $(seq 1 50); do
  CHILD=$(pgrep -f "$M1-$M2" | head -1 || true)
  [ -n "$CHILD" ] && break
  sleep 0.2
done
[[ -n "$CHILD" ]] && ok "execution process found (pid $CHILD)" || bad "no execution process found"

CSTATUS=$(api -X POST "http://127.0.0.1:$PORT2/v1/jobs/$JL/cancel" -d '{"actor":"harden","reason":"cancel must terminate execution"}' | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>console.log(JSON.parse(d).status))")
[[ "$CSTATUS" == "cancelled" ]] && ok "kernel accepted cancel → job cancelled" || bad "cancel returned $CSTATUS"
GONE=no
for _ in $(seq 1 40); do
  if ! pgrep -f "$M1-$M2" > /dev/null 2>&1; then GONE=yes; break; fi
  sleep 0.3
done
[[ "$GONE" == "yes" ]] && ok "execution process terminated after cancel" || bad "execution process still alive after cancel!"
sleep 1
FINAL=$(api "http://127.0.0.1:$PORT2/v1/jobs/$JL" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>console.log(JSON.parse(d).status))")
[[ "$FINAL" == "cancelled" ]] && ok "subprocess job stays cancelled after runner teardown" || bad "job status after cancel: $FINAL"

kill "$RUNNER2_PID" "$KERNEL2_PID" 2>/dev/null || true

# ── P0-2 (hardening §5 API-01/PTY-01): direct-Kernel PTY fencing ───────────
# The pty wire demands the authenticated principal + session OWNER on every
# operation and the session lease on control: header missing is NEVER a pass.
# (The kernel answers 422 principal_required / 403 pty_principal_mismatch /
# 403 lease_required / 403 lease_invalid; unknown sessions stay 404.)
echo "== direct-kernel pty fencing (principal + owner + lease) =="
PTYP=$(api -X POST "http://127.0.0.1:$PORT/v1/projects" -d "{\"name\":\"pty-fence\",\"workspace\":\"/w/pty\",\"creator_principal_id\":\"pty-owner\",\"brief\":$BRIEF,\"execution\":{\"runner_profile_id\":\"profile_isolated_subprocess_v1\",\"runner_target_id\":\"target_local_process_v1\",\"network_policy\":\"none\",\"artifact_store\":\"local-cas\"}}" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>console.log(JSON.parse(d).project_id))")
[[ -n "$PTYP" ]] && ok "pty-fence project created ($PTYP)" || bad "pty-fence project create"
PTYWS=$(api -X POST "http://127.0.0.1:$PORT/v1/projects/$PTYP/workspaces" -d '{"kind":"scratch","name":"s"}' | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>console.log(JSON.parse(d).workspace_id||''))")
[[ -n "$PTYWS" ]] && ok "pty-fence workspace created ($PTYWS)" || bad "pty-fence workspace create"
PTY_CONTEXT=$(curl -s "http://127.0.0.1:$PORT/v1/pty/contexts?project_id=$PTYP" -H 'x-principal-id: pty-owner' \
  | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{const a=JSON.parse(d);console.log((Array.isArray(a)?a:[]).find(x=>x.context_kind==='research')?.context_id||'')})")
PTY_OPEN=$(curl -s -X POST "http://127.0.0.1:$PORT/v1/pty/sessions" -H 'content-type: application/json' -H 'x-principal-id: pty-owner' \
  -d "{\"context_id\":\"$PTY_CONTEXT\",\"workspace_id\":\"$PTYWS\",\"label\":\"hardening owner shell\",\"purpose\":\"PTY fencing test\",\"preset\":\"sh\",\"cwd\":\".\"}")
PTY_ID=$(printf '%s' "$PTY_OPEN" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>console.log(JSON.parse(d).pty_session_id||''))")
PTY_LEASE=$(printf '%s' "$PTY_OPEN" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>console.log(JSON.parse(d).lease_token||''))")
PTY_GEN=$(printf '%s' "$PTY_OPEN" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>console.log(JSON.parse(d).generation||''))")
if [[ -n "$PTY_ID" && -n "$PTY_LEASE" && -n "$PTY_GEN" ]]; then
  ok "pty session opened via kernel ($PTY_ID, lease pinned at open)"
else
  bad "pty open via kernel (got: $(printf '%s' "$PTY_OPEN" | head -c 160))"
fi

code_of() { node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{try{console.log(JSON.parse(d).error?.code||'')}catch(e){console.log('')}})"; }
# GET session / frames / control without principal -> 422 principal_required.
for PTY_URL in "$PORT/v1/pty/sessions/$PTY_ID?expected_generation=$PTY_GEN" "$PORT/v1/pty/sessions/$PTY_ID/frames?after_seq=0&expected_generation=$PTY_GEN"; do
  OUT=$(curl -s -w '\n%{http_code}' -H "x-pty-lease: $PTY_LEASE" "http://127.0.0.1:$PTY_URL")
  R=$(printf '%s' "$OUT" | tail -1); C=$(printf '%s' "$OUT" | sed '$d' | code_of)
  [[ "$R" == "422" && "$C" == "principal_required" ]] && ok "GET $PTY_URL without principal -> 422 principal_required" || bad "no-principal GET expected 422 principal_required, got HTTP $R ($C)"
done
OUT=$(curl -s -w '\n%{http_code}' -X POST -H 'content-type: application/json' -H "x-pty-lease: $PTY_LEASE" -d "{\"expected_generation\":$PTY_GEN,\"client_seq\":1,\"type\":\"bytes\",\"payload\":{\"text\":\"x\",\"byte_length\":1}}" "http://127.0.0.1:$PORT/v1/pty/sessions/$PTY_ID/control")
R=$(printf '%s' "$OUT" | tail -1); C=$(printf '%s' "$OUT" | sed '$d' | code_of)
[[ "$R" == "422" && "$C" == "principal_required" ]] && ok "control without principal -> 422 principal_required" || bad "no-principal control expected 422, got HTTP $R ($C)"
# Wrong owner -> 403 pty_principal_mismatch on GET / frames / control.
for PTY_URL in "$PORT/v1/pty/sessions/$PTY_ID?expected_generation=$PTY_GEN" "$PORT/v1/pty/sessions/$PTY_ID/frames?after_seq=0&expected_generation=$PTY_GEN"; do
  OUT=$(curl -s -w '\n%{http_code}' -H 'x-principal-id: evil' -H "x-pty-lease: $PTY_LEASE" "http://127.0.0.1:$PTY_URL")
  R=$(printf '%s' "$OUT" | tail -1); C=$(printf '%s' "$OUT" | sed '$d' | code_of)
  [[ "$R" == "403" && "$C" == "pty_principal_mismatch" ]] && ok "GET $PTY_URL as non-owner -> 403 pty_principal_mismatch" || bad "non-owner GET expected 403, got HTTP $R ($C)"
done
OUT=$(curl -s -w '\n%{http_code}' -X POST -H 'content-type: application/json' -H 'x-principal-id: evil' -H "x-pty-lease: $PTY_LEASE" -d "{\"expected_generation\":$PTY_GEN,\"client_seq\":1,\"type\":\"bytes\",\"payload\":{\"text\":\"x\",\"byte_length\":1}}" "http://127.0.0.1:$PORT/v1/pty/sessions/$PTY_ID/control")
R=$(printf '%s' "$OUT" | tail -1); C=$(printf '%s' "$OUT" | sed '$d' | code_of)
[[ "$R" == "403" && "$C" == "pty_principal_mismatch" ]] && ok "control as non-owner -> 403 pty_principal_mismatch" || bad "non-owner control expected 403, got HTTP $R ($C)"
# Control without lease -> 403 lease_required; with wrong lease -> 403 lease_invalid.
OUT=$(curl -s -w '\n%{http_code}' -X POST -H 'content-type: application/json' -H 'x-principal-id: pty-owner' -d "{\"expected_generation\":$PTY_GEN,\"client_seq\":1,\"type\":\"bytes\",\"payload\":{\"text\":\"x\",\"byte_length\":1}}" "http://127.0.0.1:$PORT/v1/pty/sessions/$PTY_ID/control")
R=$(printf '%s' "$OUT" | tail -1); C=$(printf '%s' "$OUT" | sed '$d' | code_of)
[[ "$R" == "403" && "$C" == "lease_required" ]] && ok "control without lease -> 403 lease_required" || bad "no-lease control expected 403 lease_required, got HTTP $R ($C)"
OUT=$(curl -s -w '\n%{http_code}' -X POST -H 'content-type: application/json' -H 'x-principal-id: pty-owner' -H 'x-pty-lease: lease_wrong' -d "{\"expected_generation\":$PTY_GEN,\"client_seq\":1,\"type\":\"bytes\",\"payload\":{\"text\":\"x\",\"byte_length\":1}}" "http://127.0.0.1:$PORT/v1/pty/sessions/$PTY_ID/control")
R=$(printf '%s' "$OUT" | tail -1); C=$(printf '%s' "$OUT" | sed '$d' | code_of)
[[ "$R" == "403" && "$C" == "lease_invalid" ]] && ok "control with wrong lease -> 403 lease_invalid" || bad "wrong-lease control expected 403 lease_invalid, got HTTP $R ($C)"
# Frames: lease optional, but a wrong lease is 403 lease_invalid.
OUT=$(curl -s -w '\n%{http_code}' -H 'x-principal-id: pty-owner' -H 'x-pty-lease: lease_wrong' "http://127.0.0.1:$PORT/v1/pty/sessions/$PTY_ID/frames?after_seq=0&expected_generation=$PTY_GEN")
R=$(printf '%s' "$OUT" | tail -1); C=$(printf '%s' "$OUT" | sed '$d' | code_of)
[[ "$R" == "403" && "$C" == "lease_invalid" ]] && ok "frames with wrong lease -> 403 lease_invalid" || bad "wrong-lease frames expected 403 lease_invalid, got HTTP $R ($C)"
# Cross-project control: a session of ANOTHER project (owned by pty-owner2)
# is 403 for pty-owner — ownership is pinned at open, not project membership.
PTYP2=$(api -X POST "http://127.0.0.1:$PORT/v1/projects" -d "{\"name\":\"pty-fence-2\",\"workspace\":\"/w/pty2\",\"creator_principal_id\":\"pty-owner2\",\"brief\":$BRIEF,\"execution\":{\"runner_profile_id\":\"profile_isolated_subprocess_v1\",\"runner_target_id\":\"target_local_process_v1\",\"network_policy\":\"none\",\"artifact_store\":\"local-cas\"}}" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>console.log(JSON.parse(d).project_id))")
PTYWS2=$(api -X POST "http://127.0.0.1:$PORT/v1/projects/$PTYP2/workspaces" -d '{"kind":"scratch","name":"s"}' | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>console.log(JSON.parse(d).workspace_id||''))")
PTY_CONTEXT2=$(curl -s "http://127.0.0.1:$PORT/v1/pty/contexts?project_id=$PTYP2" -H 'x-principal-id: pty-owner2' \
  | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{const a=JSON.parse(d);console.log((Array.isArray(a)?a:[]).find(x=>x.context_kind==='research')?.context_id||'')})")
PTY_OPEN2=$(curl -s -X POST "http://127.0.0.1:$PORT/v1/pty/sessions" -H 'content-type: application/json' -H 'x-principal-id: pty-owner2' \
  -d "{\"context_id\":\"$PTY_CONTEXT2\",\"workspace_id\":\"$PTYWS2\",\"label\":\"hardening other shell\",\"purpose\":\"cross-project fencing test\",\"preset\":\"sh\",\"cwd\":\".\"}")
PTY_ID2=$(printf '%s' "$PTY_OPEN2" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>console.log(JSON.parse(d).pty_session_id||''))")
PTY_LEASE2=$(printf '%s' "$PTY_OPEN2" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>console.log(JSON.parse(d).lease_token||''))")
PTY_GEN2=$(printf '%s' "$PTY_OPEN2" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>console.log(JSON.parse(d).generation||''))")
if [[ -n "$PTY_ID2" ]]; then
  OUT=$(curl -s -w '\n%{http_code}' -X POST -H 'content-type: application/json' -H 'x-principal-id: pty-owner' -H "x-pty-lease: $PTY_LEASE2" -d "{\"expected_generation\":$PTY_GEN2,\"client_seq\":1,\"type\":\"bytes\",\"payload\":{\"text\":\"x\",\"byte_length\":1}}" "http://127.0.0.1:$PORT/v1/pty/sessions/$PTY_ID2/control")
  R=$(printf '%s' "$OUT" | tail -1); C=$(printf '%s' "$OUT" | sed '$d' | code_of)
  [[ "$R" == "403" && "$C" == "pty_principal_mismatch" ]] && ok "cross-project control (other owner) -> 403 pty_principal_mismatch" || bad "cross-project control expected 403, got HTTP $R ($C)"
else
  bad "second pty session open for cross-project test"
fi
# Unknown session id with a valid principal -> 404 (no enumeration).
OUT=$(curl -s -w '\n%{http_code}' -H 'x-principal-id: pty-owner' "http://127.0.0.1:$PORT/v1/pty/sessions/pty_nope?expected_generation=1")
R=$(printf '%s' "$OUT" | tail -1); C=$(printf '%s' "$OUT" | sed '$d' | code_of)
[[ "$R" == "404" && "$C" == "pty_session_not_found" ]] && ok "unknown pty session id -> 404 pty_session_not_found" || bad "unknown session expected 404, got HTTP $R ($C)"
# Owner + correct lease still controls the session (positive control).
OUT=$(curl -s -w '\n%{http_code}' -X POST -H 'content-type: application/json' -H 'x-principal-id: pty-owner' -H "x-pty-lease: $PTY_LEASE" -d "{\"expected_generation\":$PTY_GEN,\"client_seq\":1,\"type\":\"bytes\",\"payload\":{\"text\":\"ok\",\"byte_length\":2}}" "http://127.0.0.1:$PORT/v1/pty/sessions/$PTY_ID/control")
R=$(printf '%s' "$OUT" | tail -1)
[[ "$R" == "200" ]] && ok "owner + correct lease control -> 200" || bad "owner control expected 200, got HTTP $R"


# ── REPRO-01 (docs/reproduction-contracts.md §4): reproduction API + verifier
# service identity + cross-project AuthZ (HTTP integration) ────────────────

echo "== REPRO-01 reproduction-spec/report HTTP surface =="
# Creator principal becomes the first PI member (createProject creator path),
# so v2 routes with x-principal-id resolve membership for the same principal.
REPRO_PI="repro-pi"
REPRO_PROJ=$(api -X POST "http://127.0.0.1:$PORT/v1/projects" -d "{\"name\":\"repro-http\",\"workspace\":\"/w/repro\",\"creator_principal_id\":\"$REPRO_PI\",\"brief\":$BRIEF}" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>console.log(JSON.parse(d).project_id))")
[[ "$REPRO_PROJ" == rsp_* ]] && ok "reproduction project $REPRO_PROJ created (creator PI member)" || bad "reproduction project creation failed: $REPRO_PROJ"

# POST /v2/projects/{id}/reproduction-specs — 422 without a principal.
OUT=$(curl -s -w '\n%{http_code}' -X POST -H 'content-type: application/json' -d '{"paper_ref":{"doi":"10.48550/arXiv.2401.12345"},"claims_to_reproduce":[{"claim_ref":"c1"}]}' "http://127.0.0.1:$PORT/v2/projects/$REPRO_PROJ/reproduction-specs")
R=$(printf '%s' "$OUT" | tail -1); C=$(printf '%s' "$OUT" | sed '$d' | code_of)
[[ "$R" == "422" && "$C" == "principal_required" ]] && ok "POST reproduction-specs without principal -> 422 principal_required" || bad "spec-create no-principal expected 422, got HTTP $R ($C)"

# Invalid paper ref -> 422 invalid_paper_ref (zero rows).
OUT=$(curl -s -w '\n%{http_code}' -X POST -H 'content-type: application/json' -H "x-principal-id: $REPRO_PI" -d '{"paper_ref":{"doi":"nope"},"claims_to_reproduce":[{"claim_ref":"c1"}]}' "http://127.0.0.1:$PORT/v2/projects/$REPRO_PROJ/reproduction-specs")
R=$(printf '%s' "$OUT" | tail -1); C=$(printf '%s' "$OUT" | sed '$d' | code_of)
[[ "$R" == "422" && "$C" == "invalid_paper_ref" ]] && ok "POST reproduction-specs with bad DOI -> 422 invalid_paper_ref" || bad "bad-DOI expected 422 invalid_paper_ref, got HTTP $R ($C)"

# Valid create -> 201 with spec_id/status=draft.
SPEC_JSON=$(curl -s -X POST -H 'content-type: application/json' -H "x-principal-id: $REPRO_PI" -d '{"paper_ref":{"doi":"10.48550/arXiv.2401.12345"},"claims_to_reproduce":[{"claim_ref":"c1","locator":"Table 2"}]}' "http://127.0.0.1:$PORT/v2/projects/$REPRO_PROJ/reproduction-specs")
SPEC_ID=$(printf '%s' "$SPEC_JSON" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>console.log(JSON.parse(d).spec_id||''))")
SPEC_STATUS=$(printf '%s' "$SPEC_JSON" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>console.log(JSON.parse(d).status||''))")
[[ "$SPEC_ID" == repro_* && "$SPEC_STATUS" == "draft" ]] && ok "POST reproduction-specs (DOI) -> 201 $SPEC_ID status=draft" || bad "spec create expected 201 draft, got id='$SPEC_ID' status='$SPEC_STATUS'"

# Confirm the spec (PATCH revision CAS), then start an attempt (201 + lease token).
OUT=$(curl -s -w '\n%{http_code}' -X PATCH -H 'content-type: application/json' -H "x-principal-id: $REPRO_PI" -d '{"expected_revision":1,"patch":{"status":"confirmed"}}' "http://127.0.0.1:$PORT/v2/projects/$REPRO_PROJ/reproduction-specs/$SPEC_ID")
R=$(printf '%s' "$OUT" | tail -1)
[[ "$R" == "200" ]] && ok "PATCH reproduction-specs/{spec} confirm -> 200" || bad "spec confirm expected 200, got HTTP $R"
OUT=$(curl -s -w '\n%{http_code}' -X PATCH -H 'content-type: application/json' -H "x-principal-id: $REPRO_PI" -d '{"expected_revision":1,"patch":{"status":"confirmed"}}' "http://127.0.0.1:$PORT/v2/projects/$REPRO_PROJ/reproduction-specs/$SPEC_ID")
R=$(printf '%s' "$OUT" | tail -1); C=$(printf '%s' "$OUT" | sed '$d' | code_of)
[[ "$R" == "409" && "$C" == "reproduction_revision_conflict" ]] && ok "PATCH with stale revision -> 409 reproduction_revision_conflict" || bad "stale PATCH expected 409, got HTTP $R ($C)"

AT_JSON=$(curl -s -X POST -H 'content-type: application/json' -H "x-principal-id: $REPRO_PI" -d '{"reason":"hardening http attempt"}' "http://127.0.0.1:$PORT/v2/projects/$REPRO_PROJ/reproduction-specs/$SPEC_ID/attempts")
AT_ID=$(printf '%s' "$AT_JSON" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{const o=JSON.parse(d);console.log(o.attempt?.attempt_id||'')})")
AT_GEN=$(printf '%s' "$AT_JSON" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{const o=JSON.parse(d);console.log(o.generation||'')})")
AT_LEASE=$(printf '%s' "$AT_JSON" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{const o=JSON.parse(d);console.log(o.lease_token||'')})")
[[ "$AT_ID" == repa_* && "$AT_GEN" == "1" && "${#AT_LEASE}" == "48" ]] && ok "POST reproduction-specs/{spec}/attempts -> 201 attempt $AT_ID gen 1 + lease token" || bad "attempt start expected 201, got id='$AT_ID' gen='$AT_GEN' lease='${#AT_LEASE}'"

# Verifier report surface: service token + verifier principal fencing.
REP_PATH="/internal/reproduction-attempts/$AT_ID/reports"
REP_BODY="{\"attempt_generation\":$AT_GEN,\"lease_token\":\"$AT_LEASE\",\"paper_refs\":[\"10.48550/arXiv.2401.12345\"],\"claim_refs\":[\"c1\"],\"status\":\"pass\",\"preflight\":{\"ok\":true,\"checks\":[\"digest pinned\"],\"blocked\":false,\"reason\":\"\"},\"runtime_verified\":{\"exit_code\":0,\"execution_succeeded\":true,\"run_manifest_signed\":true,\"lease_fenced\":true},\"environment\":{},\"run_manifest_refs\":[\"sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\"],\"paper_comparisons\":{},\"run_comparisons\":{},\"checks\":[{\"check_id\":\"metric:m1\",\"kind\":\"metric\",\"name\":\"mAP\",\"status\":\"pass\",\"required\":true,\"detail\":\"ok\"}],\"missing_outputs\":[],\"extra_outputs\":[],\"failure_class\":null,\"stable_error_code\":\"\",\"retryable\":false,\"generated_by\":\"reproduction-verifier\",\"tool_versions\":{\"verifier\":\"hardening-1.0\"}}"
OUT=$(curl -s -w '\n%{http_code}' -X POST -H 'content-type: application/json' -H 'x-service-principal: verifier' -d "$REP_BODY" "http://127.0.0.1:$PORT$REP_PATH")
R=$(printf '%s' "$OUT" | tail -1); C=$(printf '%s' "$OUT" | sed '$d' | code_of)
[[ "$R" == "403" && "$C" == "service_token_required" ]] && ok "internal report without x-service-token -> 403 service_token_required" || bad "report no-token expected 403 service_token_required, got HTTP $R ($C)"
OUT=$(curl -s -w '\n%{http_code}' -X POST -H 'content-type: application/json' -H "x-service-token: $DSH_SCHOLAR_SERVICE_TOKEN" -H 'x-service-principal: analysis-worker' -d "$REP_BODY" "http://127.0.0.1:$PORT$REP_PATH")
R=$(printf '%s' "$OUT" | tail -1); C=$(printf '%s' "$OUT" | sed '$d' | code_of)
[[ "$R" == "403" && "$C" == "service_identity_required" ]] && ok "internal report with non-verifier principal -> 403 service_identity_required" || bad "report bad-principal expected 403, got HTTP $R ($C)"
OUT=$(curl -s -w '\n%{http_code}' -X POST -H 'content-type: application/json' -H "x-service-token: $DSH_SCHOLAR_SERVICE_TOKEN" -H 'x-service-principal: verifier' -d "$REP_BODY" "http://127.0.0.1:$PORT$REP_PATH")
R=$(printf '%s' "$OUT" | tail -1); C=$(printf '%s' "$OUT" | sed '$d' | code_of)
[[ "$R" == "201" ]] && ok "internal report with token + verifier -> 201" || bad "report ok expected 201, got HTTP $R ($C)"
REP_ID=$(printf '%s' "$OUT" | sed '$d' | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{try{console.log(JSON.parse(d).report_id||'')}catch(e){console.log('')}})")
REP_HASH=$(printf '%s' "$OUT" | sed '$d' | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{try{console.log(JSON.parse(d).report_hash||'')}catch(e){console.log('')}})")
[[ "$REP_ID" == repr_* && "${#REP_HASH}" == "64" ]] && ok "report 201 carries report_id + 64-hex report_hash (CAS)" || bad "report payload missing report_id/hash: id='$REP_ID' hash='${#REP_HASH}'"
# Wrong lease token on a fresh report attempt -> 409 lease_stale.
OUT=$(curl -s -w '\n%{http_code}' -X POST -H 'content-type: application/json' -H "x-service-token: $DSH_SCHOLAR_SERVICE_TOKEN" -H 'x-service-principal: verifier' -d "${REP_BODY/\"$AT_LEASE\"/\"wrong-token\"}" "http://127.0.0.1:$PORT$REP_PATH")
R=$(printf '%s' "$OUT" | tail -1); C=$(printf '%s' "$OUT" | sed '$d' | code_of)
[[ "$R" == "409" && "$C" == "lease_stale" ]] && ok "internal report with wrong lease token -> 409 lease_stale" || bad "report wrong-lease expected 409 lease_stale, got HTTP $R ($C)"
# GET report in-project 200; cross-project 404 (no enumeration).
OUT=$(curl -s -w '\n%{http_code}' -H "x-principal-id: $REPRO_PI" "http://127.0.0.1:$PORT/v2/projects/$REPRO_PROJ/reproduction-reports/$REP_ID")
R=$(printf '%s' "$OUT" | tail -1)
[[ "$R" == "200" ]] && ok "GET v2 reproduction-reports/{report} in-project -> 200" || bad "GET report expected 200, got HTTP $R"
REPRO_PROJ2=$(api -X POST "http://127.0.0.1:$PORT/v1/projects" -d "{\"name\":\"repro-http-2\",\"workspace\":\"/w/repro2\",\"creator_principal_id\":\"$REPRO_PI\",\"brief\":$BRIEF}" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>console.log(JSON.parse(d).project_id))")
OUT=$(curl -s -w '\n%{http_code}' -H "x-principal-id: $REPRO_PI" "http://127.0.0.1:$PORT/v2/projects/$REPRO_PROJ2/reproduction-reports/$REP_ID")
R=$(printf '%s' "$OUT" | tail -1); C=$(printf '%s' "$OUT" | sed '$d' | code_of)
[[ "$R" == "404" && "$C" == "reproduction_report_not_found" ]] && ok "GET report cross-project -> 404 reproduction_report_not_found" || bad "cross-project report expected 404, got HTTP $R ($C)"

kill "$RUNNER_PID" "$KERNEL_PID" 2>/dev/null || true
rm -rf "$WORK"
echo "hardening-tests: $PASS passed, $FAIL failed"
[[ "$FAIL" -eq 0 ]] || exit 1

# §OPS-01/SEC-UI-01: standalone startup reliability + token/loopback HTTP.
bash "$REPO/tests/security/run-standalone-http-tests.sh"
