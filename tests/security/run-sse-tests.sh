#!/usr/bin/env bash
# ART-01 SSE real-streaming acceptance (acceptance-tests.md §5/§11/§21),
# probing lib/bin/kernel.js directly and through the standalone BFF proxy:
#
#   kernel-sse-real-body     GET /v1/jobs/{id}/terminal -> text/event-stream;
#                            subscribed + chunk events carry the APPENDED
#                            text bytes (真实 body, not empty event shells)
#   kernel-sse-live-tail     frames appended AFTER the connection is open
#                            reach the reader while the stream stays open
#                            (live push, not just replay)
#   kernel-sse-after-seq     after_seq=3 resumes at seq 4,5 — no duplicate,
#                            no missing (断线续传无重复无缺失)
#   kernel-sse-cross-project terminal read pinned to a foreign project_id
#                            -> 404 project_not_found (跨项目 AuthZ)
#   bff-sse-proxy-body       the same terminal SSE read through the
#                            standalone BFF proxy delivers real frames
#   bff-sse-no-token         no/wrong bearer token -> 401
#   bff-sse-cross-project    BFF job-membership check answers 404 BEFORE any
#                            SSE bytes are streamed
#
# §21 SSE real-time streams (api-contracts.md §22) — the three NEW stream
# endpoints, kernel-direct AND through the BFF:
#
#   kernel-pty-stream-live   /v1/pty/sessions/{id}/frames/stream: real echoed
#                            body, live tail, exit event ends the stream
#   kernel-pty-stream-after-seq  after_seq resume (no dup), retention gap
#                            event, 422/403/404/lease_invalid auth matrix
#   kernel-watch-stream      /v1/projects/{id}/workspaces/{wid}/watch/stream:
#                            change node + delete tombstone + revision
#                            advance, after_revision resume, 422/404/cross-
#                            project 404
#   kernel-trajectory-stream /v1/projects/{id}/trajectory/stream: research/
#                            session lane filter, live append, keyset
#                            after_seq resume, redacted summary, 422/404
#   bff-*-stream             the same three streams through the standalone
#                            BFF proxy (bearer 401, non-member 404 BEFORE
#                            any SSE bytes, x-principal-id injection)
#
# Fencing note: appendTerminalFrames requires frames to carry the claim's
# lease_generation (P0), so every run below claims the job first and reuses
# the claim's generation on all frames.
#
# Not covered (documented in the run report): revoke-on-disconnect and
# backpressure — neither the kernel nor the BFF implements them.
#
# Usage: bash tests/security/run-sse-tests.sh
set -eu

REPO=$(cd "$(dirname "$0")/../.." && pwd)
KERNEL_BIN="$REPO/packages/research-kernel/lib/bin/kernel.js"
SERVER_BIN="$REPO/packages/dsh-research-ui/lib/standalone/server.js"
if [ ! -f "$SERVER_BIN" ]; then
  echo "sse: standalone server not built — run pnpm --filter @dsh-scholar/research-ui build first" >&2
  exit 2
fi
WORK=$(mktemp -d)
PORT=""
KERNEL_PID=""
BFF_PID=""
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

jfield() { node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{try{const v=JSON.parse(d);console.log(v$1 ?? '')}catch(e){console.log('')}})" ; }

# sse_read <outfile> <hdrfile> <seconds> <url> [curl extra args...]
# Reads an SSE stream with --no-buffer. Open-ended streams are killed by
# timeout (exit 124 is expected and ignored); the body/headers land in the
# given files either way.
sse_read() {
  local out="$1" hdr="$2" secs="$3" url="$4"
  shift 4
  timeout "$secs" curl -sN --no-buffer -D "$hdr" -o "$out" "$@" "$url" > /dev/null 2>&1 || true
}

# ctype <hdrfile> -> normalized content-type value (lowercase, params stripped)
ctype() {
  tr -d '\r' < "$1" | grep -i '^content-type:' | head -1 \
    | sed 's/^[Cc]ontent-[Tt]ype:[[:space:]]*//' | sed 's/;.*//' | tr 'A-Z' 'a-z' | tr -d ' '
}

# sse_chunk_seqs <bodyfile> -> comma-joined seqs of chunk events, in order
sse_chunk_seqs() {
  [[ -f "$1" ]] || { echo ""; return; }
  node -e 'let d=require("fs").readFileSync(process.argv[1],"utf8");const out=[];for(const block of d.split("\n\n")){const e=block.split("\n").find(l=>l.startsWith("event: "));const data=block.split("\n").find(l=>l.startsWith("data: "));if(e&&e.slice(7)==="chunk"&&data){try{out.push(JSON.parse(data.slice(6)).seq)}catch{}}}console.log(out.join(","))' "$1"
}

# sse_events <bodyfile> [event-name] -> lines "event<TAB>data-json" in order
# (filtered to one event name when given; comment frames are ignored)
sse_events() {
  node -e '
    const fs = require("fs")
    const body = fs.readFileSync(process.argv[1], "utf8")
    const want = process.argv[2] ?? ""
    const out = []
    for (const block of body.split("\n\n")) {
      const lines = block.split("\n")
      const ev = lines.find(l => l.startsWith("event: "))
      if (!ev) continue
      const name = ev.slice(7)
      if (want !== "" && name !== want) continue
      const data = lines.find(l => l.startsWith("data: "))
      out.push(name + "\t" + (data ? data.slice(6) : ""))
    }
    console.log(out.join("\n"))
  ' "$1" "${2:-}"
}

# sse_seqs <bodyfile> <event-name> -> comma-joined `seq` fields, in order
sse_seqs() {
  [[ -f "$1" ]] || { echo ""; return; }
  node -e 'let d=require("fs").readFileSync(process.argv[1],"utf8");const out=[];for(const block of d.split("\n\n")){const e=block.split("\n").find(l=>l.startsWith("event: "));const data=block.split("\n").find(l=>l.startsWith("data: "));if(e&&e.slice(7)===process.argv[2]&&data){try{out.push(JSON.parse(data.slice(6)).seq)}catch{}}}console.log(out.join(","))' "$1" "$2"
}

# sse_has_text <bodyfile> <event-name> <substring> -> true when any event of
# that name carries a JSON `text` field containing the substring
sse_has_text() {
  [[ -f "$1" ]] || { echo "false"; return; }
  node -e 'let d=require("fs").readFileSync(process.argv[1],"utf8");for(const block of d.split("\n\n")){const e=block.split("\n").find(l=>l.startsWith("event: "));const data=block.split("\n").find(l=>l.startsWith("data: "));if(e&&e.slice(7)===process.argv[2]&&data){try{const j=JSON.parse(data.slice(6));const text=j.text??j.payload?.text??"";if(String(text).includes(process.argv[3])){console.log("true");process.exit(0)}}catch{}}}console.log("false")' "$1" "$2" "$3"
}

cleanup() {
  if [[ -n "$BFF_PID" ]]; then
    kill "$BFF_PID" 2>/dev/null || true
    for _ in $(seq 1 15); do
      kill -0 "$BFF_PID" 2>/dev/null || break
      sleep 0.2
    done
    kill -9 "$BFF_PID" 2>/dev/null || true
  fi
  # A kill -9'd BFF cannot run its sidecar shutdown, and the kernel it
  # spawned (identifiable by the $WORK/bff* data dir in its argv) would
  # otherwise survive; reap it by argv, never by broad pkill.
  for pid in $(pgrep -f "research-kernel/lib/bin/kernel.js" 2>/dev/null || true); do
    if tr '\0' ' ' < "/proc/$pid/cmdline" 2>/dev/null | grep -qF "$WORK/bff"; then
      kill -9 "$pid" 2>/dev/null || true
    fi
  done
  [[ -n "$KERNEL_PID" ]] && kill -9 "$KERNEL_PID" 2>/dev/null || true
  wait "$KERNEL_PID" 2>/dev/null || true
  wait "$BFF_PID" 2>/dev/null || true
  rm -rf "$WORK"
}
trap cleanup EXIT

start_kernel() {
  local port
  for port in $((24000 + $$ % 300)) $((24500 + $$ % 300)) $((25000 + $$ % 300)); do
    PORT=$port
    nohup node "$KERNEL_BIN" --db "$WORK/kernel.db" --cas "$WORK/cas" --port "$PORT" > "$WORK/kernel.log" 2>&1 &
    KERNEL_PID=$!
    for _ in $(seq 1 50); do
      curl -sf "http://127.0.0.1:$PORT/v1/health" > /dev/null 2>&1 && return 0
      sleep 0.1
    done
    kill -9 "$KERNEL_PID" 2>/dev/null || true
    wait "$KERNEL_PID" 2>/dev/null || true
    KERNEL_PID=""
  done
  return 1
}

# start_bff -> the standalone BFF (with its own kernel sidecar) is ready.
# Sets BPORT/BFF_KPORT/BTOKEN/BFF_DATA; auth for /v1/* is Bearer $BTOKEN; the
# loopback operator principal is "alice". BFF_DATA is the BFF's dataDir — it
# holds the sidecar's 0600 kernel-token for direct-kernel calls (§5 P0-1).
start_bff() {
  local bport kport attempt
  for attempt in 1 2; do
    bport=$((26000 + ($$ + attempt * 37) % 400))
    kport=$((bport + 1))
    BPORT=$bport
    BFF_KPORT=$kport
    BFF_DATA="$WORK/bff$attempt"
    BTOKEN="sse-test-token-$$-$attempt"
    mkdir -p "$BFF_DATA"
    chmod 700 "$BFF_DATA"
    printf '%s' "$BTOKEN" > "$BFF_DATA/standalone-token"
    chmod 600 "$BFF_DATA/standalone-token"
    nohup node "$SERVER_BIN" --host 127.0.0.1 --port "$bport" --kernel-port "$kport" \
      --kernel-data-dir "$BFF_DATA" --data-dir "$BFF_DATA" --principal alice > "$WORK/bff.log" 2>&1 &
    BFF_PID=$!
    for _ in $(seq 1 100); do
      if ! kill -0 "$BFF_PID" 2>/dev/null; then break; fi
      if curl -sf -m 2 -X POST "http://127.0.0.1:$bport/api/token-check" -H 'content-type: application/json' \
          -d "{\"token\":\"$BTOKEN\"}" > /dev/null 2>&1; then return 0; fi
      sleep 0.2
    done
    kill -9 "$BFF_PID" 2>/dev/null || true
    wait "$BFF_PID" 2>/dev/null || true
    BFF_PID=""
    for pid in $(pgrep -f "research-kernel/lib/bin/kernel.js" 2>/dev/null || true); do
      if tr '\0' ' ' < "/proc/$pid/cmdline" 2>/dev/null | grep -qF "$WORK/bff$attempt"; then
        kill -9 "$pid" 2>/dev/null || true
      fi
    done
  done
  return 1
}

BRIEF='{"problem":"p","scope":"s","questions":[],"primary_metrics":["m"],"resources":"","risks":[],"target_outputs":["paper"],"target_venue":null,"baseline_repo":null,"domain":"ml"}'

# ── kernel direct ───────────────────────────────────────────────────────────
start_kernel || { echo "kernel failed to start"; exit 1; }
BASE="http://127.0.0.1:$PORT"
PROJ=$(api -X POST "$BASE/v1/projects" -d "{\"name\":\"sse\",\"workspace\":\"/w\",\"brief\":$BRIEF,\"execution\":{\"runner_profile_id\":\"profile_local_docker_cpu_v1\"}}" | jfield '.project_id')
[[ -n "$PROJ" ]] || { echo "failed to create project"; exit 1; }

J=$(api -X POST "$BASE/v1/projects/$PROJ/jobs" -d '{"idempotency_key":"sse-1","kind":"echo","payload":{"message":"sse"}}' | jfield '.job_id')
[[ -n "$J" ]] || { echo "failed to submit echo job"; exit 1; }
CLAIM=$(api -X POST "$BASE/v1/jobs-claim/run" -d '{"owner":"runner-sse","lease_ttl_seconds":60,"limit":8}')
G=$(printf '%s' "$CLAIM" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{const j=JSON.parse(d);const row=j.find(x=>x.job_id==='$J');console.log(row?row.lease_generation:'')})")
if [[ "$G" == "1" ]]; then
  ok "kernel claim: lease_generation=$G (frames must carry it, P0 fencing)"
else
  bad "kernel claim: expected lease_generation=1 (got '$G')"
  exit 1
fi
# frame <seq> <kind> [payload-json-object] -> frame JSON (payload_json is a STRING)
frame() {
  node -e 'const [, seq, kind, gen, payloadRaw] = process.argv; const payload = payloadRaw ? JSON.parse(payloadRaw) : {}; console.log(JSON.stringify({ seq: Number(seq), frame_kind: kind, lease_generation: Number(gen), ...(Object.keys(payload).length > 0 ? { payload_json: JSON.stringify(payload) } : {}) }))' "$1" "$2" "$G" "${3:-}"
}
# chunk <seq> <text>
chunk() {
  local seq="$1" text="$2"
  printf '{"seq":%s,"stream_seq":%s,"channel":"stdout","text":"%s","byte_offset":0,"byte_length":%s,"frame_kind":"chunk","lease_generation":%s}' "$seq" "$seq" "$text" "${#text}" "$G"
}
# append <run> <maxlog> <frames...> -> response body
append() {
  local run="$1" maxlog="$2"
  shift 2
  local frames=""
  for f in "$@"; do [[ -n "$frames" ]] && frames="$frames,"; frames="$frames$f"; done
  if [[ -n "$maxlog" ]]; then
    curl -s -X POST "$BASE/v1/jobs/$J/terminal-frames" -H 'content-type: application/json' -d "{\"run_id\":\"$run\",\"max_log_bytes\":$maxlog,\"frames\":[$frames]}"
  else
    curl -s -X POST "$BASE/v1/jobs/$J/terminal-frames" -H 'content-type: application/json' -d "{\"run_id\":\"$run\",\"frames\":[$frames]}"
  fi
}

say "Test 1: kernel-sse-real-body — text/event-stream with appended text bytes"
FRAMES=""
for i in 1 2 3 4 5; do
  [[ -n "$FRAMES" ]] && FRAMES="$FRAMES,"
  FRAMES="$FRAMES$(chunk "$i" "line$i")"
done
append run_direct "" "$FRAMES" > /dev/null
sse_read "$WORK/b1.txt" "$WORK/h1.txt" 2 "$BASE/v1/jobs/$J/terminal?after_seq=0&run_id=run_direct"
CT=$(ctype "$WORK/h1.txt")
if [[ "$CT" == "text/event-stream" ]]; then
  ok "response header content-type: $CT"
else
  bad "expected content-type text/event-stream, got '$CT'"
fi
SEQS=$(sse_chunk_seqs "$WORK/b1.txt")
if [[ "$SEQS" == "1,2,3,4,5" ]]; then
  ok "chunk seqs replayed in order: [$SEQS]"
else
  bad "expected chunk seqs 1,2,3,4,5, got [$SEQS]"
fi
if grep -qF 'event: subscribed' "$WORK/b1.txt" && grep -qF '"run_id":"run_direct"' "$WORK/b1.txt"; then
  ok "subscribed event carries the run_id"
else
  bad "subscribed event missing run_id"
fi
if grep -qF '"text":"line1"' "$WORK/b1.txt" && grep -qF '"text":"line3"' "$WORK/b1.txt" \
   && grep -qF '"text":"line5"' "$WORK/b1.txt" && grep -qF '"channel":"stdout"' "$WORK/b1.txt"; then
  ok "real body: appended text bytes (line1..line5) present in the stream"
else
  bad "real body missing appended text bytes"
fi

say "Test 2: kernel-sse-live-tail — frames appended AFTER connect are pushed live"
(timeout 6 curl -sN --no-buffer -D "$WORK/h2.txt" -o "$WORK/b2.txt" \
  "$BASE/v1/jobs/$J/terminal?after_seq=0&run_id=run_live" > /dev/null 2>&1 || true) &
SSE_PID=$!
sleep 1.5
append run_live "" "$(chunk 1 live1)" "$(chunk 2 live2)" "$(chunk 3 live3)" "$(frame 4 exit)" > /dev/null
wait "$SSE_PID" 2>/dev/null || true
if grep -qF '"last_seq":0' "$WORK/b2.txt"; then
  ok "subscribed while the run was empty (last_seq=0) — frames arrived after connect"
else
  bad "expected to subscribe at the empty tail (last_seq=0)"
fi
SEQS=$(sse_chunk_seqs "$WORK/b2.txt")
if [[ "$SEQS" == "1,2,3" ]] && grep -qF '"text":"live1"' "$WORK/b2.txt" && grep -qF '"text":"live3"' "$WORK/b2.txt"; then
  ok "live chunks [$SEQS] pushed on the open connection"
else
  bad "live tail: expected chunks 1,2,3 with live text, got [$SEQS]"
fi
if grep -qF 'event: exit' "$WORK/b2.txt"; then
  ok "exit event ended the same connection after the live frames"
else
  bad "exit event missing after live frames"
fi

say "Test 3: kernel-sse-after-seq — after_seq=3 resumes at seq 4,5 (no dup, no miss)"
sse_read "$WORK/b3.txt" "$WORK/h3.txt" 2 "$BASE/v1/jobs/$J/terminal?after_seq=3&run_id=run_direct"
SEQS3=$(sse_chunk_seqs "$WORK/b3.txt")
if [[ "$SEQS3" == "4,5" ]]; then
  ok "after_seq=3 -> chunks [$SEQS3] (seq 1..3 not re-sent)"
else
  bad "after_seq=3: expected chunks 4,5, got [$SEQS3]"
fi
sse_read "$WORK/b5.txt" "$WORK/h5.txt" 2 "$BASE/v1/jobs/$J/terminal?after_seq=5&run_id=run_direct"
SEQS5=$(sse_chunk_seqs "$WORK/b5.txt")
if [[ -z "$SEQS5" ]]; then
  ok "after_seq=5 -> no chunk replayed"
else
  bad "after_seq=5: expected no chunks, got [$SEQS5]"
fi

say "Test 4: kernel-sse-cross-project — foreign project_id -> 404 project_not_found"
PROJ2=$(api -X POST "$BASE/v1/projects" -d "{\"name\":\"sse-foreign\",\"workspace\":\"/w\",\"brief\":$BRIEF}" | jfield '.project_id')
CODE=$(curl -s -o "$WORK/f4.json" -w '%{http_code}' "$BASE/v1/jobs/$J/terminal?project_id=$PROJ2&run_id=run_direct")
ERR=$(jfield '.error.code' < "$WORK/f4.json")
if [[ "$CODE" == "404" && "$ERR" == "project_not_found" ]]; then
  ok "terminal read with foreign project_id -> HTTP 404 ($ERR)"
else
  bad "expected 404 project_not_found, got HTTP $CODE ($ERR)"
fi
CODE=$(curl -s -o /dev/null -w '%{http_code}' -m 2 "$BASE/v1/jobs/$J/terminal?project_id=$PROJ&run_id=run_direct" || true)
if [[ "$CODE" == "200" ]]; then
  ok "terminal read with OWNING project_id -> HTTP 200"
else
  bad "owning project_id: expected 200, got HTTP $CODE"
fi

# ── kernel-direct SSE real-time streams (acceptance-tests.md §21) ────────────
# The three new stream endpoints (api-contracts.md §22) mirror the terminal
# SSE pattern: text/event-stream, after_seq/after_revision replay, live tail,
# named heartbeat, exit/close end for the pty stream. Data sources are the
# SAME stores the polling endpoints read (pty frames / workspace listSince /
# trajectory projection).
PTYOWNER='pty-sse'
PTYP=$(api -X POST "$BASE/v1/projects" -d "{\"name\":\"sse-pty\",\"workspace\":\"/w/pty\",\"creator_principal_id\":\"$PTYOWNER\",\"brief\":$BRIEF,\"execution\":{\"runner_profile_id\":\"profile_isolated_subprocess_v1\",\"runner_target_id\":\"target_local_process_v1\",\"network_policy\":\"none\",\"artifact_store\":\"local-cas\"}}" | jfield '.project_id')
PTYWS=$(api -X POST "$BASE/v1/projects/$PTYP/workspaces" -d '{"kind":"scratch","name":"s"}' | jfield '.workspace_id')
[[ -n "$PTYP" && -n "$PTYWS" ]] || { echo "failed to create pty-stream fixtures"; exit 1; }
PTY_CONTEXT=$(curl -s "$BASE/v1/pty/contexts?project_id=$PTYP" -H "x-principal-id: $PTYOWNER" \
  | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{const a=JSON.parse(d);console.log((Array.isArray(a)?a:[]).find(x=>x.context_kind==='research')?.context_id||'')})")

say "Test 8: kernel-pty-stream-live — pty frame stream: real body, live tail, exit end"
PTY_OPEN=$(curl -s -X POST "$BASE/v1/pty/sessions" -H 'content-type: application/json' -H "x-principal-id: $PTYOWNER" \
  -d "{\"context_id\":\"$PTY_CONTEXT\",\"workspace_id\":\"$PTYWS\",\"label\":\"kernel SSE shell\",\"purpose\":\"live stream test\",\"preset\":\"sh\",\"cwd\":\".\"}")
PTY_ID=$(printf '%s' "$PTY_OPEN" | jfield '.pty_session_id')
PTY_LEASE=$(printf '%s' "$PTY_OPEN" | jfield '.lease_token')
PTY_GEN=$(printf '%s' "$PTY_OPEN" | jfield '.generation')
if [[ -n "$PTY_ID" && -n "$PTY_LEASE" && -n "$PTY_GEN" ]]; then
  ok "pty session opened via kernel ($PTY_ID)"
else
  bad "pty session open (got: $(printf '%s' "$PTY_OPEN" | head -c 160))"
  exit 1
fi
(timeout 6 curl -sN --no-buffer -D "$WORK/hp1.txt" -o "$WORK/bp1.txt" \
  "$BASE/v1/pty/sessions/$PTY_ID/frames/stream?after_seq=0&expected_generation=$PTY_GEN" -H "x-principal-id: $PTYOWNER" -H "x-pty-lease: $PTY_LEASE" > /dev/null 2>&1 || true) &
PTY_SSE_PID=$!
sleep 1.2
CTL8=$(node -e "const text='echo SSE_LIVE_1; echo SSE_LIVE_2; echo SSE_LIVE_3; exit\\n'; console.log(JSON.stringify({expected_generation:Number('$PTY_GEN'),client_seq:1,type:'bytes',payload:{text,byte_length:text.length}}))")
CTL=$(curl -s -X POST "$BASE/v1/pty/sessions/$PTY_ID/control" -H 'content-type: application/json' -H "x-principal-id: $PTYOWNER" -H "x-pty-lease: $PTY_LEASE" -d "$CTL8")
wait "$PTY_SSE_PID" 2>/dev/null || true
CTP1=$(ctype "$WORK/hp1.txt")
if [[ "$CTP1" == "text/event-stream" ]]; then
  ok "pty stream content-type: $CTP1"
else
  bad "pty stream: expected text/event-stream, got '$CTP1'"
fi
if grep -qF 'event: subscribed' "$WORK/bp1.txt" && grep -qF "\"session_id\":\"$PTY_ID\"" "$WORK/bp1.txt"; then
  ok "pty stream subscribed event carries the session_id"
else
  bad "pty stream missing subscribed event"
fi
PTY_SEQS=$(sse_seqs "$WORK/bp1.txt" frame)
if [[ -n "$PTY_SEQS" ]] && printf '%s' "$PTY_SEQS" | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{const s=d.split(",").map(Number);console.log(s.every((v,i)=>i===0||v>s[i-1])?"asc":"no")})' | grep -q asc; then
  ok "pty frame seqs strictly increasing: [$PTY_SEQS]"
else
  bad "pty frame seqs not strictly increasing: [$PTY_SEQS]"
fi
if sse_has_text "$WORK/bp1.txt" frame SSE_LIVE_1 && sse_has_text "$WORK/bp1.txt" frame SSE_LIVE_3; then
  ok "live pty frames carry real echoed text (SSE_LIVE_1..SSE_LIVE_3)"
else
  bad "live pty frames missing echoed text"
fi
if grep -qF 'event: exit' "$WORK/bp1.txt"; then
  ok "exit event ended the pty stream after the live frames"
else
  bad "pty stream missing exit event"
fi

say "Test 9: kernel-pty-stream-after-seq — resume without duplicates; gap on eviction; auth matrix"
LAST_PTY=$(printf '%s' "$PTY_SEQS" | awk -F, '{print $NF}')
sse_read "$WORK/bp2.txt" "$WORK/hp2.txt" 2 "$BASE/v1/pty/sessions/$PTY_ID/frames/stream?after_seq=$LAST_PTY&expected_generation=$PTY_GEN" -H "x-principal-id: $PTYOWNER" -H "x-pty-lease: $PTY_LEASE"
PTY2_SEQS=$(sse_seqs "$WORK/bp2.txt" frame)
if [[ -z "$PTY2_SEQS" ]]; then
  ok "after_seq=$LAST_PTY -> no pty frame replayed"
else
  bad "after_seq=$LAST_PTY: expected no frames, got [$PTY2_SEQS]"
fi
EXIT_SEQ=$(sse_events "$WORK/bp1.txt" exit | head -1 | cut -f2 | jfield '.seq')
if [[ -n "$EXIT_SEQ" ]]; then
  sse_read "$WORK/bp3.txt" "$WORK/hp3.txt" 2 "$BASE/v1/pty/sessions/$PTY_ID/frames/stream?after_seq=$EXIT_SEQ&expected_generation=$PTY_GEN" -H "x-principal-id: $PTYOWNER" -H "x-pty-lease: $PTY_LEASE"
  if grep -q 'event: frame' "$WORK/bp3.txt" || grep -q 'event: exit' "$WORK/bp3.txt"; then
    bad "after exit seq $EXIT_SEQ: expected only subscribed, got more events"
  else
    ok "after_seq=$EXIT_SEQ (exit seq) -> stream replays nothing (exit is authoritative)"
  fi
else
  bad "could not extract exit seq"
fi
# Gap: a reader starting at 0 on an evicted window must see the gap event.
PTY_GAP=$(curl -s -X POST "$BASE/v1/pty/sessions" -H 'content-type: application/json' -H "x-principal-id: $PTYOWNER" \
  -d "{\"context_id\":\"$PTY_CONTEXT\",\"workspace_id\":\"$PTYWS\",\"label\":\"kernel SSE retention shell\",\"purpose\":\"bounded retention test\",\"preset\":\"sh\",\"cwd\":\".\"}")
PTY_GAP_ID=$(printf '%s' "$PTY_GAP" | jfield '.pty_session_id')
PTY_GAP_LEASE=$(printf '%s' "$PTY_GAP" | jfield '.lease_token')
PTY_GAP_GEN=$(printf '%s' "$PTY_GAP" | jfield '.generation')
if [[ -n "$PTY_GAP_ID" && -n "$PTY_GAP_LEASE" && -n "$PTY_GAP_GEN" ]]; then
  CTL9=$(node -e "const text=\"python3 -c \\\"print('G'*1100000)\\\"\\n\"; console.log(JSON.stringify({expected_generation:Number('$PTY_GAP_GEN'),client_seq:1,type:'bytes',payload:{text,byte_length:text.length}}))")
  curl -s -X POST "$BASE/v1/pty/sessions/$PTY_GAP_ID/control" -H 'content-type: application/json' -H "x-principal-id: $PTYOWNER" -H "x-pty-lease: $PTY_GAP_LEASE" \
    -d "$CTL9" > /dev/null
  sleep 1
  sse_read "$WORK/bpg.txt" "$WORK/hpg.txt" 2 "$BASE/v1/pty/sessions/$PTY_GAP_ID/frames/stream?after_seq=0&expected_generation=$PTY_GAP_GEN" -H "x-principal-id: $PTYOWNER" -H "x-pty-lease: $PTY_GAP_LEASE"
  GAPLINE=$(sse_events "$WORK/bpg.txt" gap | head -1)
  if [[ -n "$GAPLINE" ]]; then
    GF=$(printf '%s' "$GAPLINE" | cut -f2)
    GF1=$(printf '%s' "$GF" | jfield '.gap_from_seq'); GDB=$(printf '%s' "$GF" | jfield '.dropped_bytes')
    if [[ "$GF1" =~ ^[0-9]+$ && "$GF1" -ge 1 && "$GDB" =~ ^[0-9]+$ && "$GDB" -gt 0 ]]; then
      ok "gap event on evicted window (gap_from_seq=$GF1, dropped_bytes=$GDB)"
    else
      bad "gap event fields unexpected: $GF"
    fi
  else
    bad "expected gap event on evicted window"
  fi
else
  bad "retention pty session open for gap test"
fi
# Auth matrix mirrors the polling frames route (422/403/404, wrong lease 403).
R=$(curl -s -o "$WORK/bpn1.json" -w '%{http_code}' -H "x-pty-lease: $PTY_LEASE" "$BASE/v1/pty/sessions/$PTY_ID/frames/stream?after_seq=0&expected_generation=$PTY_GEN")
[[ "$R" == "422" && "$(jfield '.error.code' < "$WORK/bpn1.json")" == "principal_required" ]] \
  && ok "pty stream without principal -> 422 principal_required" || bad "no-principal pty stream expected 422, got HTTP $R"
R=$(curl -s -o "$WORK/bpn2.json" -w '%{http_code}' -H 'x-principal-id: evil' -H "x-pty-lease: $PTY_LEASE" "$BASE/v1/pty/sessions/$PTY_ID/frames/stream?after_seq=0&expected_generation=$PTY_GEN")
[[ "$R" == "403" && "$(jfield '.error.code' < "$WORK/bpn2.json")" == "pty_principal_mismatch" ]] \
  && ok "pty stream as non-owner -> 403 pty_principal_mismatch" || bad "non-owner pty stream expected 403, got HTTP $R"
R=$(curl -s -o "$WORK/bpn3.json" -w '%{http_code}' -H "x-principal-id: $PTYOWNER" "$BASE/v1/pty/sessions/pty_nope/frames/stream?after_seq=0&expected_generation=1")
[[ "$R" == "404" && "$(jfield '.error.code' < "$WORK/bpn3.json")" == "pty_session_not_found" ]] \
  && ok "unknown pty session stream -> 404 pty_session_not_found" || bad "unknown pty stream expected 404, got HTTP $R"
R=$(curl -s -o "$WORK/bpn4.json" -w '%{http_code}' -H "x-principal-id: $PTYOWNER" -H 'x-pty-lease: lease_wrong' "$BASE/v1/pty/sessions/$PTY_ID/frames/stream?after_seq=0&expected_generation=$PTY_GEN")
[[ "$R" == "403" && "$(jfield '.error.code' < "$WORK/bpn4.json")" == "lease_invalid" ]] \
  && ok "pty stream with wrong lease -> 403 lease_invalid" || bad "wrong-lease pty stream expected 403, got HTTP $R"

say "Test 10: kernel-watch-stream — workspace change/delete events + revision advance; after_revision resume; auth"
SWOWNER='sse-watch'
SWP=$(api -X POST "$BASE/v1/projects" -d "{\"name\":\"sse-watch\",\"workspace\":\"/w\",\"creator_principal_id\":\"$SWOWNER\",\"brief\":$BRIEF}" | jfield '.project_id')
SWID=$(api -X POST "$BASE/v1/projects/$SWP/workspaces" -d '{"kind":"code","name":"c"}' | jfield '.workspace_id')
[[ -n "$SWP" && -n "$SWID" ]] || { echo "failed to create watch fixtures"; exit 1; }
(timeout 5 curl -sN --no-buffer -D "$WORK/hw1.txt" -o "$WORK/bw1.txt" \
  "$BASE/v1/projects/$SWP/workspaces/$SWID/watch/stream?after_revision=0" -H "x-principal-id: $SWOWNER" > /dev/null 2>&1 || true) &
WATCH_PID=$!
sleep 1.2
curl -s -X POST "$BASE/v1/projects/$SWP/workspaces/$SWID/nodes" -H 'content-type: application/json' \
  -d '{"path":"w1.txt","content":"one"}' > /dev/null
curl -s -X POST "$BASE/v1/projects/$SWP/workspaces/$SWID/nodes" -H 'content-type: application/json' \
  -d '{"path":"w2.txt","content":"two"}' > /dev/null
curl -s -X DELETE "$BASE/v1/projects/$SWP/workspaces/$SWID/nodes?path=w1.txt" > /dev/null
wait "$WATCH_PID" 2>/dev/null || true
CTW=$(ctype "$WORK/hw1.txt")
if [[ "$CTW" == "text/event-stream" ]]; then
  ok "watch stream content-type: $CTW"
else
  bad "watch stream: expected text/event-stream, got '$CTW'"
fi
if grep -qF 'event: subscribed' "$WORK/bw1.txt" && grep -qF "\"workspace_id\":\"$SWID\"" "$WORK/bw1.txt" && grep -qF '"after_revision":0' "$WORK/bw1.txt"; then
  ok "watch stream subscribed event carries workspace_id + after_revision"
else
  bad "watch stream missing subscribed event"
fi
CHANGE_PATHS=$(sse_events "$WORK/bw1.txt" change | cut -f2 | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{const out=[];for(const l of d.split("\n")){if(!l.trim())continue;try{out.push(JSON.parse(l).node.path)}catch{}}console.log(out.join(","))})')
if printf '%s' "$CHANGE_PATHS" | grep -q 'w2.txt'; then
  ok "change events carry the touched nodes [$CHANGE_PATHS] (w1.txt may appear in an intermediate poll — listSince projects current state per path)"
else
  bad "expected a change event for w2.txt, got [$CHANGE_PATHS]"
fi
DEL_PATH=$(sse_events "$WORK/bw1.txt" delete | head -1 | cut -f2 | jfield '.path')
DEL_REV=$(sse_events "$WORK/bw1.txt" delete | head -1 | cut -f2 | jfield '.revision')
SUB_REV=$(grep -o '"revision":[0-9]*' "$WORK/bw1.txt" | head -1 | cut -d: -f2)
if [[ "$DEL_PATH" == "w1.txt" && -n "$DEL_REV" && -n "$SUB_REV" && "$DEL_REV" -gt "$SUB_REV" ]]; then
  ok "delete tombstone (w1.txt) with revision advance $SUB_REV -> $DEL_REV"
else
  bad "delete tombstone/revision advance: path='$DEL_PATH' rev='$DEL_REV' sub='$SUB_REV'"
fi
WSREV=$(api "$BASE/v1/projects/$SWP/workspaces" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{const a=JSON.parse(d);const w=a.find(x=>x.workspace_id==='$SWID');console.log(w?w.revision:'')})")
sse_read "$WORK/bw2.txt" "$WORK/hw2.txt" 2 "$BASE/v1/projects/$SWP/workspaces/$SWID/watch/stream?after_revision=$WSREV" -H "x-principal-id: $SWOWNER"
if grep -q 'event: change' "$WORK/bw2.txt" || grep -q 'event: delete' "$WORK/bw2.txt"; then
  bad "after_revision=$WSREV replayed old changes"
else
  ok "after_revision=$WSREV -> no change/delete replayed"
fi
R=$(curl -s -o "$WORK/bwn1.json" -w '%{http_code}' "$BASE/v1/projects/$SWP/workspaces/$SWID/watch/stream?after_revision=0")
[[ "$R" == "422" && "$(jfield '.error.code' < "$WORK/bwn1.json")" == "principal_required" ]] \
  && ok "watch stream without principal -> 422 principal_required" || bad "no-principal watch stream expected 422, got HTTP $R"
R=$(curl -s -o "$WORK/bwn2.json" -w '%{http_code}' -H 'x-principal-id: evil' "$BASE/v1/projects/$SWP/workspaces/$SWID/watch/stream?after_revision=0")
[[ "$R" == "404" && "$(jfield '.error.code' < "$WORK/bwn2.json")" == "project_not_found" ]] \
  && ok "watch stream as non-member -> 404 project_not_found" || bad "non-member watch stream expected 404, got HTTP $R"
SWP2=$(api -X POST "$BASE/v1/projects" -d "{\"name\":\"sse-watch-2\",\"workspace\":\"/w\",\"creator_principal_id\":\"$SWOWNER\",\"brief\":$BRIEF}" | jfield '.project_id')
R=$(curl -s -o "$WORK/bwn3.json" -w '%{http_code}' -H "x-principal-id: $SWOWNER" "$BASE/v1/projects/$SWP2/workspaces/$SWID/watch/stream?after_revision=0")
[[ "$R" == "404" && "$(jfield '.error.code' < "$WORK/bwn3.json")" == "workspace_not_found" ]] \
  && ok "cross-project watch stream -> 404 workspace_not_found" || bad "cross-project watch expected 404, got HTTP $R"

say "Test 11: kernel-trajectory-stream — entry replay, lane filter, live append, keyset resume; auth"
TJOWNER='sse-traj'
TJP=$(api -X POST "$BASE/v1/projects" -d "{\"name\":\"sse-traj\",\"workspace\":\"/w\",\"creator_principal_id\":\"$TJOWNER\",\"brief\":$BRIEF,\"execution\":{\"runner_profile_id\":\"profile_local_docker_cpu_v1\"}}" | jfield '.project_id')
[[ -n "$TJP" ]] || { echo "failed to create trajectory fixture"; exit 1; }
(timeout 5 curl -sN --no-buffer -D "$WORK/ht1.txt" -o "$WORK/bt1.txt" \
  "$BASE/v1/projects/$TJP/trajectory/stream?after_seq=0&lane=research" -H "x-principal-id: $TJOWNER" > /dev/null 2>&1 || true) &
TJ_PID=$!
sleep 1.2
J2=$(api -X POST "$BASE/v1/projects/$TJP/jobs" -d '{"idempotency_key":"sse-traj-1","kind":"echo","payload":{"message":"x"}}' | jfield '.job_id')
[[ -n "$J2" ]] || { bad "trajectory job submit"; }
api -X POST "$BASE/v1/projects/$TJP/session" -H "x-principal-id: $TJOWNER" -d '{"session_id":"sess_traj_1"}' > /dev/null
wait "$TJ_PID" 2>/dev/null || true
CTT=$(ctype "$WORK/ht1.txt")
if [[ "$CTT" == "text/event-stream" ]]; then
  ok "trajectory stream content-type: $CTT"
else
  bad "trajectory stream: expected text/event-stream, got '$CTT'"
fi
if grep -qF 'event: subscribed' "$WORK/bt1.txt" && grep -qF "\"project_id\":\"$TJP\"" "$WORK/bt1.txt" && grep -qF '"lane":"research"' "$WORK/bt1.txt"; then
  ok "trajectory stream subscribed event carries project_id + lane"
else
  bad "trajectory stream missing subscribed event"
fi
TJ_KINDS=$(sse_events "$WORK/bt1.txt" entry | cut -f2 | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{const out=[];for(const l of d.split("\n")){if(!l.trim())continue;try{out.push(JSON.parse(l).kind)}catch{}}console.log(out.join(","))})')
if printf '%s' "$TJ_KINDS" | grep -q 'project.created' && printf '%s' "$TJ_KINDS" | grep -q 'job.submitted'; then
  ok "research lane entries live: [$TJ_KINDS] (project.created replayed, job.submitted appended live)"
else
  bad "trajectory research entries unexpected: [$TJ_KINDS]"
fi
TJ_SUMMARY=$(sse_events "$WORK/bt1.txt" entry | head -1 | cut -f2 | jfield '.summary')
if [[ -n "$TJ_SUMMARY" ]]; then
  ok "entry carries a redacted summary string"
else
  bad "entry summary missing"
fi
sse_read "$WORK/bt2.txt" "$WORK/ht2.txt" 2 "$BASE/v1/projects/$TJP/trajectory/stream?after_seq=0&lane=session" -H "x-principal-id: $TJOWNER"
SESS_KINDS=$(sse_events "$WORK/bt2.txt" entry | cut -f2 | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{const out=[];for(const l of d.split("\n")){if(!l.trim())continue;try{out.push(JSON.parse(l).kind)}catch{}}console.log(out.join(","))})')
if [[ "$SESS_KINDS" == "session.linked" ]]; then
  ok "session lane filter -> only session events: [$SESS_KINDS]"
else
  bad "session lane filter unexpected: [$SESS_KINDS]"
fi
TJ_LAST_SEQ=$(sse_events "$WORK/bt1.txt" entry | tail -1 | cut -f2 | jfield '.event_seq')
TJ_LAST_EID=$(sse_events "$WORK/bt1.txt" entry | tail -1 | cut -f2 | jfield '.entry_id')
sse_read "$WORK/bt3.txt" "$WORK/ht3.txt" 2 "$BASE/v1/projects/$TJP/trajectory/stream?after_seq=$TJ_LAST_SEQ&after_event_id=$TJ_LAST_EID&lane=research" -H "x-principal-id: $TJOWNER"
if grep -q 'event: entry' "$WORK/bt3.txt"; then
  bad "after_seq=$TJ_LAST_SEQ replayed entries"
else
  ok "after_seq=$TJ_LAST_SEQ (keyset incl. after_event_id) -> no entry replayed"
fi
R=$(curl -s -o "$WORK/btn1.json" -w '%{http_code}' "$BASE/v1/projects/$TJP/trajectory/stream?after_seq=0")
[[ "$R" == "422" && "$(jfield '.error.code' < "$WORK/btn1.json")" == "principal_required" ]] \
  && ok "trajectory stream without principal -> 422 principal_required" || bad "no-principal trajectory stream expected 422, got HTTP $R"
R=$(curl -s -o "$WORK/btn2.json" -w '%{http_code}' -H 'x-principal-id: evil' "$BASE/v1/projects/$TJP/trajectory/stream?after_seq=0")
[[ "$R" == "404" && "$(jfield '.error.code' < "$WORK/btn2.json")" == "project_not_found" ]] \
  && ok "trajectory stream as non-member -> 404 project_not_found" || bad "non-member trajectory stream expected 404, got HTTP $R"

# ── standalone BFF proxy ────────────────────────────────────────────────────
start_bff || { bad "standalone BFF failed to start"; }
BFF="http://127.0.0.1:$BPORT"
BAPI() { curl -sf -H "Authorization: Bearer $BTOKEN" -H 'content-type: application/json' "$@"; }

say "Test 5: bff-sse-proxy-body — terminal SSE through the standalone BFF proxy"
BP=$(BAPI -X POST "$BFF/v1/projects" \
  -d "{\"name\":\"sse-bff\",\"workspace\":\"/w\",\"creator_principal_id\":\"alice\",\"brief\":$BRIEF,\"execution\":{\"runner_profile_id\":\"profile_isolated_subprocess_v1\",\"runner_target_id\":\"target_local_process_v1\"}}" | jfield '.project_id')
if [[ -n "$BP" ]]; then
  ok "project created via proxy (creator alice) -> $BP"
else
  bad "project create via proxy"
fi
BJ=$(BAPI -X POST "$BFF/v1/projects/$BP/jobs" -d '{"idempotency_key":"sse-bff-1","kind":"echo","payload":{"message":"sse-bff"}}' | jfield '.job_id')
[[ -n "$BJ" ]] || { bad "job create via proxy"; }
CLAIMB=$(BAPI -X POST "$BFF/v1/jobs-claim/run" -d '{"owner":"runner-sse-bff","lease_ttl_seconds":60,"limit":8}')
BG=$(printf '%s' "$CLAIMB" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{const j=JSON.parse(d);const row=j.find(x=>x.job_id==='$BJ');console.log(row?row.lease_generation:'')})")
if [[ "$BG" == "1" ]]; then
  ok "claim via proxy: lease_generation=$BG"
else
  bad "claim via proxy: expected lease_generation=1 (got '$BG')"
  BG=1
fi
RB=$(curl -s -H "Authorization: Bearer $BTOKEN" -H 'content-type: application/json' \
  -X POST "$BFF/v1/jobs/$BJ/terminal-frames" \
  -d "{\"run_id\":\"run_bff\",\"frames\":[{\"seq\":1,\"stream_seq\":1,\"channel\":\"stdout\",\"text\":\"bff1\",\"byte_offset\":0,\"byte_length\":4,\"frame_kind\":\"chunk\",\"lease_generation\":$BG},{\"seq\":2,\"stream_seq\":2,\"channel\":\"stdout\",\"text\":\"bff2\",\"byte_offset\":0,\"byte_length\":4,\"frame_kind\":\"chunk\",\"lease_generation\":$BG},{\"seq\":3,\"stream_seq\":3,\"channel\":\"stdout\",\"text\":\"bff3\",\"byte_offset\":0,\"byte_length\":4,\"frame_kind\":\"chunk\",\"lease_generation\":$BG}]}")
if printf '%s' "$RB" | grep -q '"appended":3'; then
  ok "frames appended via proxy ($(printf '%s' "$RB" | jfield '.appended') frames)"
else
  bad "frames append via proxy: $RB"
fi
sse_read "$WORK/bb5.txt" "$WORK/hb5.txt" 3 "$BFF/v1/jobs/$BJ/terminal?after_seq=0&run_id=run_bff" -H "Authorization: Bearer $BTOKEN"
CT5=$(ctype "$WORK/hb5.txt")
if [[ "$CT5" == "text/event-stream" ]]; then
  ok "proxied SSE content-type: $CT5"
else
  bad "proxied SSE: expected content-type text/event-stream, got '$CT5'"
fi
SEQS5=$(sse_chunk_seqs "$WORK/bb5.txt")
if [[ "$SEQS5" == "1,2,3" ]] && grep -qF '"text":"bff1"' "$WORK/bb5.txt" && grep -qF '"text":"bff3"' "$WORK/bb5.txt"; then
  ok "proxied chunks [$SEQS5] with real text delivered through the BFF"
else
  bad "proxied chunks: expected 1,2,3 with bff text, got [$SEQS5]"
fi
if grep -qF 'event: subscribed' "$WORK/bb5.txt" && grep -qF '"run_id":"run_bff"' "$WORK/bb5.txt"; then
  ok "proxied stream carries the subscribed event with run_id"
else
  bad "proxied stream missing subscribed event"
fi

say "Test 6: bff-sse-no-token — terminal SSE without the bearer -> 401"
CODE=$(curl -s -o "$WORK/b6.json" -w '%{http_code}' "$BFF/v1/jobs/$BJ/terminal?run_id=run_bff" || true)
if [[ "$CODE" == "401" ]]; then
  ok "no token -> HTTP 401"
else
  bad "no token: expected 401, got HTTP $CODE"
fi
CODE=$(curl -s -o /dev/null -w '%{http_code}' -H "Authorization: Bearer wrong-token" "$BFF/v1/jobs/$BJ/terminal?run_id=run_bff" || true)
if [[ "$CODE" == "401" ]]; then
  ok "wrong bearer -> HTTP 401"
else
  bad "wrong bearer: expected 401, got HTTP $CODE"
fi

say "Test 7: bff-sse-cross-project — non-member job terminal -> 404 before streaming"
# Foreign project owned by bob, created directly on the BFF's kernel; the BFF
# (principal alice) must answer 404 WITHOUT proxying any SSE bytes. Direct
# kernel calls carry the sidecar's kernel-token bearer (§5 P0-1 — the
# sidecar-spawned kernel demands it).
BFFKTOKEN=$(tr -d '\n' < "$BFF_DATA/kernel-token" 2>/dev/null || true)
FP=$(curl -sf -H 'content-type: application/json' -H "Authorization: Bearer $BFFKTOKEN" -X POST "http://127.0.0.1:$BFF_KPORT/v1/projects" \
  -d "{\"name\":\"sse-foreign-b\",\"workspace\":\"/w\",\"creator_principal_id\":\"bob\",\"brief\":$BRIEF,\"execution\":{\"runner_profile_id\":\"profile_isolated_subprocess_v1\",\"runner_target_id\":\"target_local_process_v1\"}}" | jfield '.project_id')
FJ=$(curl -sf -H 'content-type: application/json' -H "Authorization: Bearer $BFFKTOKEN" -X POST "http://127.0.0.1:$BFF_KPORT/v1/projects/$FP/jobs" \
  -d '{"idempotency_key":"sse-bff-foreign","kind":"echo","payload":{"message":"x"}}' | jfield '.job_id')
if [[ -n "$FP" && -n "$FJ" ]]; then
  ok "foreign job created on the BFF kernel (owner bob) -> $FJ"
else
  bad "foreign job create on BFF kernel"
fi
CODE=$(curl -s -o "$WORK/b7.json" -w '%{http_code}' -H "Authorization: Bearer $BTOKEN" "$BFF/v1/jobs/$FJ/terminal")
ERR=$(jfield '.error.code' < "$WORK/b7.json")
if [[ "$CODE" == "404" && "$ERR" == "project_not_found" ]]; then
  ok "non-member terminal via BFF -> HTTP 404 ($ERR) before any SSE bytes"
else
  bad "expected 404 project_not_found via BFF, got HTTP $CODE ($ERR)"
fi
if grep -q 'event: ' "$WORK/b7.json" 2>/dev/null; then
  bad "non-member response leaked SSE bytes"
else
  ok "non-member response body is a plain error (no SSE events)"
fi

# ── BFF passthrough of the three real-time streams (api-contracts.md §22) ───
# The standalone BFF handles the new stream routes exactly like the terminal
# SSE: bearer (401), CSRF GET exemption, membership BEFORE streaming (404
# with no SSE bytes), x-service-token + x-principal-id injection.
say "Test 12: bff-watch-stream — workspace watch stream through the BFF proxy"
BWID=$(BAPI -X POST "$BFF/v1/projects/$BP/workspaces" -d '{"kind":"code","name":"c"}' | jfield '.workspace_id')
if [[ -n "$BWID" ]]; then
  ok "workspace created via proxy -> $BWID"
else
  bad "workspace create via proxy"
fi
(timeout 5 curl -sN --no-buffer -D "$WORK/hw1b.txt" -o "$WORK/bw1b.txt" \
  "$BFF/v1/projects/$BP/workspaces/$BWID/watch/stream?after_revision=0" -H "Authorization: Bearer $BTOKEN" > /dev/null 2>&1 || true) &
BWATCH_PID=$!
sleep 1.2
BAPI -X POST "$BFF/v1/projects/$BP/workspaces/$BWID/nodes" -d '{"path":"bff.txt","content":"hello"}' > /dev/null
wait "$BWATCH_PID" 2>/dev/null || true
CTW1=$(ctype "$WORK/hw1b.txt")
if [[ "$CTW1" == "text/event-stream" ]] && grep -qF 'event: subscribed' "$WORK/bw1b.txt"; then
  ok "proxied watch stream content-type $CTW1 + subscribed"
else
  bad "proxied watch stream: expected text/event-stream + subscribed, got '$CTW1'"
fi
BCHANGE=$(sse_events "$WORK/bw1b.txt" change | head -1 | cut -f2 | jfield '.node.path')
if [[ "$BCHANGE" == "bff.txt" ]]; then
  ok "proxied change event carries the node written through the proxy"
else
  bad "proxied change event: expected bff.txt, got '$BCHANGE'"
fi
CODE=$(curl -s -o "$WORK/bw1c.json" -w '%{http_code}' "$BFF/v1/projects/$BP/workspaces/$BWID/watch/stream?after_revision=0" || true)
if [[ "$CODE" == "401" ]]; then
  ok "proxied watch stream without token -> HTTP 401"
else
  bad "no-token watch stream: expected 401, got HTTP $CODE"
fi
# Non-member: bob's workspace on the BFF kernel -> 404 before any SSE bytes.
FWS=$(curl -sf -H 'content-type: application/json' -H "Authorization: Bearer $BFFKTOKEN" -X POST "http://127.0.0.1:$BFF_KPORT/v1/projects/$FP/workspaces" \
  -d '{"kind":"code","name":"c"}' | jfield '.workspace_id')
CODE=$(curl -s -o "$WORK/bw1d.json" -w '%{http_code}' -H "Authorization: Bearer $BTOKEN" "$BFF/v1/projects/$FP/workspaces/$FWS/watch/stream?after_revision=0")
ERR=$(jfield '.error.code' < "$WORK/bw1d.json")
if [[ "$CODE" == "404" && "$ERR" == "project_not_found" ]]; then
  ok "non-member watch stream via BFF -> HTTP 404 ($ERR) before any SSE bytes"
else
  bad "non-member watch stream expected 404, got HTTP $CODE ($ERR)"
fi
if grep -q 'event: ' "$WORK/bw1d.json" 2>/dev/null; then
  bad "non-member watch response leaked SSE bytes"
else
  ok "non-member watch response body is a plain error (no SSE events)"
fi

say "Test 13: bff-trajectory-stream — trajectory stream through the BFF proxy"
(timeout 4 curl -sN --no-buffer -D "$WORK/ht1b.txt" -o "$WORK/bt1b.txt" \
  "$BFF/v1/projects/$BP/trajectory/stream?after_seq=0&lane=research" -H "Authorization: Bearer $BTOKEN" > /dev/null 2>&1 || true) &
BTJ_PID=$!
sleep 1.5
BAPI -X POST "$BFF/v1/projects/$BP/jobs" -d '{"idempotency_key":"sse-bff-traj","kind":"echo","payload":{"message":"t"}}' > /dev/null
wait "$BTJ_PID" 2>/dev/null || true
CTT1=$(ctype "$WORK/ht1b.txt")
BTJ_KINDS=$(sse_events "$WORK/bt1b.txt" entry | cut -f2 | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{const out=[];for(const l of d.split("\n")){if(!l.trim())continue;try{out.push(JSON.parse(l).kind)}catch{}}console.log(out.join(","))})')
if [[ "$CTT1" == "text/event-stream" ]] && printf '%s' "$BTJ_KINDS" | grep -q 'job.submitted'; then
  ok "proxied trajectory stream ($CTT1) delivered live job.submitted entry"
else
  bad "proxied trajectory stream: ctype='$CTT1' kinds=[$BTJ_KINDS]"
fi
CODE=$(curl -s -o "$WORK/bt1c.json" -w '%{http_code}' "$BFF/v1/projects/$BP/trajectory/stream?after_seq=0" || true)
if [[ "$CODE" == "401" ]]; then
  ok "proxied trajectory stream without token -> HTTP 401"
else
  bad "no-token trajectory stream: expected 401, got HTTP $CODE"
fi
CODE=$(curl -s -o "$WORK/bt1d.json" -w '%{http_code}' -H "Authorization: Bearer $BTOKEN" "$BFF/v1/projects/$FP/trajectory/stream?after_seq=0")
ERR=$(jfield '.error.code' < "$WORK/bt1d.json")
if [[ "$CODE" == "404" && "$ERR" == "project_not_found" ]] && ! grep -q 'event: ' "$WORK/bt1d.json" 2>/dev/null; then
  ok "non-member trajectory stream via BFF -> HTTP 404 before any SSE bytes"
else
  bad "non-member trajectory stream expected 404, got HTTP $CODE ($ERR)"
fi

say "Test 14: bff-pty-stream — pty frame stream through the BFF proxy"
BP_CONTEXT=$(BAPI "$BFF/v1/pty/contexts?project_id=$BP" \
  | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{const a=JSON.parse(d);console.log((Array.isArray(a)?a:[]).find(x=>x.context_kind==='research')?.context_id||'')})")
BP_OPEN=$(BAPI -X POST "$BFF/v1/pty/sessions" \
  -d "{\"context_id\":\"$BP_CONTEXT\",\"workspace_id\":\"$BWID\",\"label\":\"BFF SSE shell\",\"purpose\":\"proxy stream test\",\"preset\":\"sh\",\"cwd\":\".\"}")
BP_ID=$(printf '%s' "$BP_OPEN" | jfield '.pty_session_id')
BP_LEASE=$(printf '%s' "$BP_OPEN" | jfield '.lease_token')
BP_GEN=$(printf '%s' "$BP_OPEN" | jfield '.generation')
if [[ -n "$BP_ID" && -n "$BP_LEASE" && -n "$BP_GEN" ]]; then
  ok "pty session opened via BFF proxy ($BP_ID)"
else
  bad "pty session open via BFF (got: $(printf '%s' "$BP_OPEN" | head -c 160))"
fi
(timeout 6 curl -sN --no-buffer -D "$WORK/hp1b.txt" -o "$WORK/bp1b.txt" \
  "$BFF/v1/pty/sessions/$BP_ID/frames/stream?after_seq=0&expected_generation=$BP_GEN" -H "Authorization: Bearer $BTOKEN" -H "x-pty-lease: $BP_LEASE" > /dev/null 2>&1 || true) &
BPTY_PID=$!
sleep 1.2
CTL14=$(node -e "const text='echo BFF_LIVE_1; echo BFF_LIVE_2; exit\\n'; console.log(JSON.stringify({expected_generation:Number('$BP_GEN'),client_seq:1,type:'bytes',payload:{text,byte_length:text.length}}))")
curl -s -X POST "$BFF/v1/pty/sessions/$BP_ID/control" -H 'content-type: application/json' -H "Authorization: Bearer $BTOKEN" -H "x-pty-lease: $BP_LEASE" \
  -d "$CTL14" > /dev/null
wait "$BPTY_PID" 2>/dev/null || true
CTP1B=$(ctype "$WORK/hp1b.txt")
if [[ "$CTP1B" == "text/event-stream" ]] && grep -qF 'event: subscribed' "$WORK/bp1b.txt" && grep -qF "\"session_id\":\"$BP_ID\"" "$WORK/bp1b.txt"; then
  ok "proxied pty stream content-type $CTP1B + subscribed with session_id"
else
  bad "proxied pty stream: expected text/event-stream + subscribed, got '$CTP1B'"
fi
if sse_has_text "$WORK/bp1b.txt" frame BFF_LIVE_1 && sse_has_text "$WORK/bp1b.txt" frame BFF_LIVE_2; then
  ok "proxied pty frames carry real echoed text (BFF_LIVE_1..2)"
else
  bad "proxied pty frames missing echoed text"
fi
if grep -qF 'event: exit' "$WORK/bp1b.txt"; then
  ok "proxied pty stream ended with the exit event"
else
  bad "proxied pty stream missing exit event"
fi
CODE=$(curl -s -o "$WORK/bp1c.json" -w '%{http_code}' -H "x-pty-lease: $BP_LEASE" "$BFF/v1/pty/sessions/$BP_ID/frames/stream?after_seq=0&expected_generation=$BP_GEN" || true)
if [[ "$CODE" == "401" ]]; then
  ok "proxied pty stream without token -> HTTP 401"
else
  bad "no-token pty stream: expected 401, got HTTP $CODE"
fi
# Non-member: bob's pty session on the BFF kernel -> 404 before any SSE bytes.
FPTY_CONTEXT=$(curl -s -H "Authorization: Bearer $BFFKTOKEN" -H 'x-principal-id: bob' "http://127.0.0.1:$BFF_KPORT/v1/pty/contexts?project_id=$FP" \
  | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{const a=JSON.parse(d);console.log((Array.isArray(a)?a:[]).find(x=>x.context_kind==='research')?.context_id||'')})")
FPTY_OPEN=$(curl -s -H 'content-type: application/json' -H "Authorization: Bearer $BFFKTOKEN" -H 'x-principal-id: bob' -X POST "http://127.0.0.1:$BFF_KPORT/v1/pty/sessions" \
  -d "{\"context_id\":\"$FPTY_CONTEXT\",\"workspace_id\":\"$FWS\",\"label\":\"foreign SSE shell\",\"purpose\":\"cross-project test\",\"preset\":\"sh\",\"cwd\":\".\"}")
FPTY_ID=$(printf '%s' "$FPTY_OPEN" | jfield '.pty_session_id')
FPTY_LEASE=$(printf '%s' "$FPTY_OPEN" | jfield '.lease_token')
FPTY_GEN=$(printf '%s' "$FPTY_OPEN" | jfield '.generation')
if [[ -n "$FPTY_ID" ]]; then
  CODE=$(curl -s -o "$WORK/bp1d.json" -w '%{http_code}' -H "Authorization: Bearer $BTOKEN" -H "x-pty-lease: $FPTY_LEASE" "$BFF/v1/pty/sessions/$FPTY_ID/frames/stream?after_seq=0&expected_generation=$FPTY_GEN")
  ERR=$(jfield '.error.code' < "$WORK/bp1d.json")
  if [[ "$CODE" == "404" && "$ERR" == "project_not_found" ]] && ! grep -q 'event: ' "$WORK/bp1d.json" 2>/dev/null; then
    ok "non-member pty stream via BFF -> HTTP 404 before any SSE bytes"
  else
    bad "non-member pty stream expected 404, got HTTP $CODE ($ERR)"
  fi
else
  bad "foreign pty session open on BFF kernel"
fi

say "Note: revoke-on-disconnect and backpressure are NOT covered — the kernel and BFF do not implement them"
say "Summary: $PASS passed, $FAIL failed"
[[ "$FAIL" -eq 0 ]] || exit 1
