#!/usr/bin/env bash
# OPS-01 + SEC-UI-01 acceptance: standalone startup reliability and
# token/loopback HTTP surface.
#
#   OPS-01: CLI host/port/dataDir/token parsing, real-URL + token-check
#           readiness, failure -> non-zero exit with log tail, cleanup.
#   SEC-UI-01: --no-token requires loopback (direct + start-standalone-ui.sh);
#           token file 0600 / non-symlink / non-empty; /api/token-check 401
#           on wrong token; /v1/* requires the bearer; cross-origin writes
#           rejected; same 127/8 origin allowed; CSRF session token required
#           on /api writes; /api/chat/survey membership fail-closed with
#           unchanged Corpus Snapshot/Outbox counts; token never in server
#           log or kernel/server argv (0600 token-file handoff); stable
#           error bodies without internal paths/env detail.
#   DATA-UPGRADE-01/GOV-01: token startup WITHOUT --principal derives the
#           same stable server-side local principal as the DSH plugin;
#           browser-forged creator/actor/tenant/principal/session values are
#           overwritten and cannot escape the membership boundary.
#
# Usage: bash tests/security/run-standalone-http-tests.sh
set -eu

REPO=$(cd "$(dirname "$0")/../.." && pwd)
SERVER_BIN="$REPO/packages/dsh-research-ui/lib/standalone/server.js"
if [ ! -f "$SERVER_BIN" ]; then
  echo "standalone-http: server not built — run pnpm --filter @dsh-scholar/research-ui build first" >&2
  exit 2
fi

PASS=0
FAIL=0
ok() { echo "  ok: $*"; PASS=$((PASS+1)); }
fail() { echo "  FAIL: $*"; FAIL=$((FAIL+1)); }

WORK=$(mktemp -d)
# Kill ONLY the standalone instances this test started (their argv carries the
# $WORK data dir) — never a user's server (e.g. the 8443-facing 18610
# instance). A broad `pkill -f standalone/server.js` here would take the
# user's UI down on every run.
kill_test_servers() {
  for pid in $(pgrep -f "standalone/server.js" 2>/dev/null || true); do
    if tr '\0' ' ' < "/proc/$pid/cmdline" 2>/dev/null | grep -qF "$WORK"; then
      kill "$pid" 2>/dev/null || true
    fi
  done
}
trap 'kill_test_servers; rm -rf "$WORK"' EXIT

seed_standalone_token() {
  token_dir=$1
  token_value=$2
  mkdir -p "$token_dir"
  chmod 700 "$token_dir"
  token_tmp="$token_dir/.standalone-token.test.$$"
  printf '%s' "$token_value" > "$token_tmp"
  chmod 600 "$token_tmp"
  mv -f "$token_tmp" "$token_dir/standalone-token"
}

# ── OPS-01: custom CLI args + readiness + cleanup ──────────────────────────
WEB_PORT=$((21000 + RANDOM % 5000))
KERNEL_PORT=$((WEB_PORT + 1))
DATA="$WORK/data"
TOKEN="accept-token-$(date +%s)"
LOG="$WORK/server.log"
seed_standalone_token "$DATA" "$TOKEN"
node "$SERVER_BIN" --host 127.0.0.1 --port "$WEB_PORT" --kernel-port "$KERNEL_PORT" \
  --kernel-data-dir "$DATA" --data-dir "$DATA" --principal ops-1 > "$LOG" 2>&1 &
SPID=$!

ready=0
for _ in $(seq 1 60); do
  if [ -f "$DATA/standalone-token" ] && curl -sf -m 2 -X POST "http://127.0.0.1:$WEB_PORT/api/token-check" \
    -H 'content-type: application/json' -d "{\"token\":\"$TOKEN\"}" > /dev/null 2>&1; then
    ready=1
    break
  fi
  sleep 0.5
done
[ "$ready" = 1 ] && ok "OPS: custom host/port/dataDir/token reachable with token-check readiness" || fail "OPS: readiness (log: $(tail -3 "$LOG" | tr '\n' ' '))"

# ── SEC-UI-01: token file hardening ────────────────────────────────────────
MODE=$(stat -c %a "$DATA/standalone-token" 2>/dev/null || echo "?")
[ "$MODE" = "600" ] && ok "SEC: token file 0600 (got $MODE)" || fail "SEC: token file mode $MODE"
[ -L "$DATA/standalone-token" ] && fail "SEC: token file is a symlink" || ok "SEC: token file not a symlink"
[ -s "$DATA/standalone-token" ] && ok "SEC: token file non-empty" || fail "SEC: token file empty"
[ "$(tr -d '\n' < "$DATA/standalone-token")" = "$TOKEN" ] && ok "SEC: server reads the pre-provisioned token file" || fail "SEC: token file mismatch"

# ── SEC-UI-01: token-check 401/200 ─────────────────────────────────────────
R=$(curl -s -o /dev/null -w '%{http_code}' -X POST "http://127.0.0.1:$WEB_PORT/api/token-check" -H 'content-type: application/json' -d '{"token":"wrong"}')
[ "$R" = "401" ] && ok "SEC: token-check wrong token -> 401" || fail "SEC: token-check wrong -> $R"
R=$(curl -s -o /dev/null -w '%{http_code}' -X POST "http://127.0.0.1:$WEB_PORT/api/token-check" -H 'content-type: application/json' -d "{\"token\":\"$TOKEN\"}")
[ "$R" = "200" ] && ok "SEC: token-check right token -> 200" || fail "SEC: token-check right -> $R"

# ── SEC-UI-01: CSRF session token gate on /api writes ───────────────────────
R=$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$WEB_PORT/api/session/csrf")
[ "$R" = "401" ] && ok "SEC: GET /api/session/csrf without token -> 401" || fail "SEC: csrf no-token -> $R"
CSRF=$(curl -s -H "Authorization: Bearer $TOKEN" "http://127.0.0.1:$WEB_PORT/api/session/csrf" \
  | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{const j=JSON.parse(d);console.log(j.csrf_token||'')})")
if printf '%s' "$CSRF" | grep -qE '^[0-9a-f]{64}$'; then
  ok "SEC: GET /api/session/csrf issues a 32-byte hex token"
else
  fail "SEC: csrf token malformed -> '$CSRF'"
fi
CSRF2=$(curl -s -H "Authorization: Bearer $TOKEN" "http://127.0.0.1:$WEB_PORT/api/session/csrf" \
  | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{const j=JSON.parse(d);console.log(j.csrf_token||'')})")
[ "$CSRF2" = "$CSRF" ] && ok "SEC: csrf token stable per process" || fail "SEC: csrf token rotated unexpectedly"
R=$(curl -s -o /dev/null -w '%{http_code}' -X PUT "http://127.0.0.1:$WEB_PORT/api/model" \
  -H "Authorization: Bearer $TOKEN" -H "Origin: http://127.0.0.1:$WEB_PORT" -H 'content-type: application/json' -d '{"model":"deepseek-v4-flash"}')
[ "$R" = "403" ] && ok "SEC: PUT /api/model without csrf -> 403" || fail "SEC: PUT model no-csrf -> $R"
R=$(curl -s -o /dev/null -w '%{http_code}' -X PUT "http://127.0.0.1:$WEB_PORT/api/model" \
  -H "Authorization: Bearer $TOKEN" -H "Origin: http://127.0.0.1:$WEB_PORT" -H 'x-csrf-token: deadbeef' -H 'content-type: application/json' -d '{"model":"deepseek-v4-flash"}')
[ "$R" = "403" ] && ok "SEC: PUT /api/model wrong csrf -> 403" || fail "SEC: PUT model bad-csrf -> $R"
R=$(curl -s -o /dev/null -w '%{http_code}' -X POST "http://127.0.0.1:$WEB_PORT/api/chat/survey" \
  -H "Authorization: Bearer $TOKEN" -H "Origin: http://127.0.0.1:$WEB_PORT" -H 'content-type: application/json' -d '{"project_id":"x","query":"y"}')
[ "$R" = "403" ] && ok "SEC: survey without csrf -> 403" || fail "SEC: survey no-csrf -> $R"
R=$(curl -s -o /dev/null -w '%{http_code}' -X POST "http://127.0.0.1:$WEB_PORT/api/chat/survey" \
  -H "Authorization: Bearer $TOKEN" -H "Origin: http://127.0.0.1:$WEB_PORT" -H 'x-csrf-token: deadbeef' -H 'content-type: application/json' -d '{"project_id":"x","query":"y"}')
[ "$R" = "403" ] && ok "SEC: survey wrong csrf -> 403" || fail "SEC: survey bad-csrf -> $R"

# ── SEC-UI-01: /v1/* requires the bearer ───────────────────────────────────
R=$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$WEB_PORT/v1/projects")
[ "$R" = "401" ] && ok "SEC: /v1/projects without token -> 401" || fail "SEC: no-token /v1/projects -> $R"
R=$(curl -s -o /dev/null -w '%{http_code}' -H "Authorization: Bearer wrong" "http://127.0.0.1:$WEB_PORT/v1/projects")
[ "$R" = "401" ] && ok "SEC: /v1/projects bad bearer -> 401" || fail "SEC: bad bearer -> $R"
R=$(curl -s -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $TOKEN" "http://127.0.0.1:$WEB_PORT/v1/projects")
[ "$R" = "200" ] && ok "SEC: /v1/projects good bearer -> 200" || fail "SEC: good bearer -> $R"

# ── §5 P0-1 (hardening API-01/SIDE-01): kernel bearer on the sidecar port ──
# The standalone sidecar always generates/REUSES a 0600 <dataDir>/kernel-token
# (random 32 hex) and injects it into the kernel via DSH_SCHOLAR_KERNEL_TOKEN.
# Direct access to the sidecar kernel port (bypassing the BFF) must be locked:
# missing/wrong bearer -> 401 on reads AND writes; health exempt; the service
# token (x-service-token, internal routes) is a separate layer and never
# substitutes for the ordinary bearer on public routes.
KTOKEN=$(tr -d '\n' < "$DATA/kernel-token" 2>/dev/null || true)
STOKEN=$(tr -d '\n' < "$DATA/service-token" 2>/dev/null || true)
KMODE=$(stat -c %a "$DATA/kernel-token" 2>/dev/null || echo "?")
[ "$KMODE" = "600" ] && ok "KERNEL-AUTH: kernel-token file 0600 (got $KMODE)" || fail "KERNEL-AUTH: kernel-token mode $KMODE"
[ -L "$DATA/kernel-token" ] && fail "KERNEL-AUTH: kernel-token is a symlink" || ok "KERNEL-AUTH: kernel-token not a symlink"
if printf '%s' "$KTOKEN" | grep -qE '^[0-9a-f]{32}$'; then
  ok "KERNEL-AUTH: kernel-token is a random 32-hex token"
else
  fail "KERNEL-AUTH: kernel-token malformed -> '$KTOKEN'"
fi
R=$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$KERNEL_PORT/v1/projects")
[ "$R" = "401" ] && ok "KERNEL-AUTH: direct kernel READ without bearer -> 401" || fail "KERNEL-AUTH: direct read no bearer -> $R"
R=$(curl -s -o /dev/null -w '%{http_code}' -X POST "http://127.0.0.1:$KERNEL_PORT/v1/projects" -H 'content-type: application/json' -d '{"name":"x","workspace":"/w"}')
[ "$R" = "401" ] && ok "KERNEL-AUTH: direct kernel WRITE without bearer -> 401" || fail "KERNEL-AUTH: direct write no bearer -> $R"
R=$(curl -s -o /dev/null -w '%{http_code}' -H "Authorization: Bearer wrong" "http://127.0.0.1:$KERNEL_PORT/v1/projects")
[ "$R" = "401" ] && ok "KERNEL-AUTH: wrong bearer -> 401" || fail "KERNEL-AUTH: wrong bearer -> $R"
R=$(curl -s -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $KTOKEN" "http://127.0.0.1:$KERNEL_PORT/v1/projects")
[ "$R" = "200" ] && ok "KERNEL-AUTH: direct kernel read with the kernel-token bearer -> 200" || fail "KERNEL-AUTH: kernel-token bearer -> $R"
R=$(curl -s -o /dev/null -w '%{http_code}' -H "x-service-token: $STOKEN" "http://127.0.0.1:$KERNEL_PORT/v1/projects")
[ "$R" = "401" ] && ok "KERNEL-AUTH: x-service-token alone cannot unlock public routes -> 401" || fail "KERNEL-AUTH: service token on public route -> $R"
R=$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$KERNEL_PORT/v1/health")
[ "$R" = "200" ] && ok "KERNEL-AUTH: health without bearer -> 200 (exempt)" || fail "KERNEL-AUTH: health -> $R"
R=$(curl -s -o /dev/null -w '%{http_code}' -X POST "http://127.0.0.1:$KERNEL_PORT/v1/jobs-claim/run" \
  -H 'content-type: application/json' -H "Authorization: Bearer $KTOKEN" -d '{"owner":"neg","limit":1}')
[ "$R" = "403" ] && ok "KERNEL-AUTH: internal route with bearer only -> 403 service_token_required" || fail "KERNEL-AUTH: internal bearer only -> $R"
R=$(curl -s -o /dev/null -w '%{http_code}' -X POST "http://127.0.0.1:$KERNEL_PORT/v1/jobs-claim/run" \
  -H 'content-type: application/json' -H "Authorization: Bearer $KTOKEN" -H "x-service-token: $STOKEN" -d '{"owner":"ok","limit":1}')
[ "$R" = "200" ] && ok "KERNEL-AUTH: internal route with bearer + service token -> 200" || fail "KERNEL-AUTH: internal both -> $R"

# ── SEC-UI-01: cross-origin writes rejected, same-127/8 allowed ───────────
# (Origin stays a SECOND layer on top of the CSRF token.)
R=$(curl -s -o /dev/null -w '%{http_code}' -X POST "http://127.0.0.1:$WEB_PORT/api/chat/survey" \
  -H "Authorization: Bearer $TOKEN" -H "x-csrf-token: $CSRF" -H 'Origin: http://evil.example' -H 'content-type: application/json' -d '{}')
[ "$R" = "403" ] && ok "SEC: foreign Origin + valid csrf -> 403" || fail "SEC: foreign origin -> $R"
R=$(curl -s -o /dev/null -w '%{http_code}' -X POST "http://127.0.0.1:$WEB_PORT/api/chat/survey" \
  -H "Authorization: Bearer $TOKEN" -H "x-csrf-token: $CSRF" -H "Origin: http://127.0.0.1:$WEB_PORT" -H 'content-type: application/json' -d '{}')
[ "$R" = "400" ] && ok "SEC: same-origin (127/8 + port) + csrf passes gate (got $R)" || fail "SEC: same-origin -> $R"
# A DIFFERENT loopback port is a different origin — CSRF must reject it.
R=$(curl -s -o /dev/null -w '%{http_code}' -X POST "http://127.0.0.1:$WEB_PORT/api/chat/survey" \
  -H "Authorization: Bearer $TOKEN" -H "x-csrf-token: $CSRF" -H "Origin: http://127.0.0.1:$(($WEB_PORT + 100))" -H 'content-type: application/json' -d '{}')
[ "$R" = "403" ] && ok "SEC: cross-port loopback origin + valid csrf -> 403" || fail "SEC: cross-port origin -> $R"

# ── model preference seat (/api/model): catalog + persist + authz ──────────
R=$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$WEB_PORT/api/model")
[ "$R" = "401" ] && ok "MODEL: /api/model without token -> 401" || fail "MODEL: no-token /api/model -> $R"
printf '%s\n' '{"model":"obsolete-unqualified-model"}' > "$DATA/model.json"
M=$(curl -s -H "Authorization: Bearer $TOKEN" "http://127.0.0.1:$WEB_PORT/api/model")
if echo "$M" | grep -q '"available":false' && echo "$M" | grep -q '"models":\[\]' && echo "$M" | grep -q '"model":""' && echo "$M" | grep -q '"ok":true'; then
  ok "MODEL: GET without DSH bridge -> unavailable catalog and obsolete preference is inert"
else
  fail "MODEL: GET /api/model payload -> $M"
fi
R=$(curl -s -o /dev/null -w '%{http_code}' -X PUT "http://127.0.0.1:$WEB_PORT/api/model" \
  -H "Authorization: Bearer $TOKEN" -H "Origin: http://127.0.0.1:$WEB_PORT" -H "x-csrf-token: $CSRF" -H 'content-type: application/json' -d '{"model":"deepseek-v4-pro"}')
[ "$R" = "503" ] && ok "MODEL: model selection without live DSH catalog -> 503" || fail "MODEL: unavailable catalog selection -> $R"
M=$(curl -s -H "Authorization: Bearer $TOKEN" "http://127.0.0.1:$WEB_PORT/api/model")
echo "$M" | grep -q '"model":""' && ok "MODEL: unavailable selection leaves preference unchanged" || fail "MODEL: re-read -> $M"
R=$(curl -s -o /dev/null -w '%{http_code}' -X PUT "http://127.0.0.1:$WEB_PORT/api/model" \
  -H "Authorization: Bearer $TOKEN" -H "Origin: http://127.0.0.1:$WEB_PORT" -H "x-csrf-token: $CSRF" -H 'content-type: application/json' -d '{"model":"gpt-unknown"}')
[ "$R" = "503" ] && ok "MODEL: unknown model cannot bypass unavailable live catalog -> 503" || fail "MODEL: unknown model -> $R"
R=$(curl -s -o /dev/null -w '%{http_code}' -X PUT "http://127.0.0.1:$WEB_PORT/api/model" \
  -H "Authorization: Bearer $TOKEN" -H "Origin: http://127.0.0.1:$WEB_PORT" -H "x-csrf-token: $CSRF" -H 'content-type: application/json' -d '{"model":"auto"}')
[ "$R" = "200" ] && ok "MODEL: auto reset remains available without model bridge" || fail "MODEL: auto reset -> $R"
R=$(curl -s -o /dev/null -w '%{http_code}' -X PUT "http://127.0.0.1:$WEB_PORT/api/model" \
  -H "Authorization: Bearer $TOKEN" -H "x-csrf-token: $CSRF" -H 'Origin: http://evil.example' -H 'content-type: application/json' -d '{"model":"deepseek-v4-flash"}')
[ "$R" = "403" ] && ok "MODEL: foreign-origin PUT + valid csrf -> 403" || fail "MODEL: foreign origin -> $R"

# ── ART-01: binary round-trip through the same-origin proxy ────────────────
P=$(curl -s -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -X POST "http://127.0.0.1:$WEB_PORT/v1/projects" \
  -d '{"name":"art-rt","workspace":"/w/art-rt","mode":"gate-only","brief":{"problem":"p","scope":"s","questions":[],"primary_metrics":["m"],"resources":"","risks":[],"target_outputs":["paper"],"target_venue":null,"baseline_repo":null,"domain":"ml"}}' \
  | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{const j=JSON.parse(d);console.log(j.project_id||'')})")
[ -n "$P" ] && ok "ART-01: project via proxy ($P)" || fail "ART-01: project create via proxy" 
# Register a binary artifact (fake PDF bytes) via the proxy and fetch it back:
# media type, exact bytes and the ETag must survive the Web-stream proxy.
PDF_B64=$(printf '%%PDF-1.4 fake-binary-\\x00-\\xff-bytes' | base64 | tr -d '\n')
ART=$(curl -s -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -X POST "http://127.0.0.1:$WEB_PORT/v1/artifacts" \
  -d "{\"project_id\":\"$P\",\"kind\":\"pdf\",\"content_base64\":\"$PDF_B64\",\"media_type\":\"application/pdf\",\"file_name\":\"roundtrip.pdf\"}" \
  | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{const j=JSON.parse(d);console.log(j.artifact_id||j.error?.code||'')})")
if [ -z "$ART" ]; then
  fail "ART-01: artifact register via proxy"
else
  ok "ART-01: artifact registered via proxy ($ART)"
  HDR=$(curl -sI -H "Authorization: Bearer $TOKEN" "http://127.0.0.1:$WEB_PORT/v1/artifacts/$ART?project_id=$P")
  echo "$HDR" | grep -qi "content-type: application/pdf" && ok "ART-01: proxied pdf content-type" || fail "ART-01: proxied content-type ($(echo "$HDR" | grep -i content-type || true))"
  echo "$HDR" | grep -qi "etag: \"sha256:" && ok "ART-01: proxied etag present" || fail "ART-01: proxied etag missing"
  echo "$HDR" | grep -qi 'content-disposition: inline; filename="roundtrip.pdf"' && ok "ART-01: proxied download name" || fail "ART-01: proxied content-disposition missing"
  GOT=$(curl -s -H "Authorization: Bearer $TOKEN" "http://127.0.0.1:$WEB_PORT/v1/artifacts/$ART?project_id=$P" | base64 | tr -d '\n')
  [ "$GOT" = "$PDF_B64" ] && ok "ART-01: proxied bytes round-trip intact" || fail "ART-01: bytes mismatch"
  RANGE_HEADERS="$WORK/artifact-range.headers"
  RANGE_BODY="$WORK/artifact-range.body"
  RANGE_CODE=$(curl -sS -D "$RANGE_HEADERS" -o "$RANGE_BODY" -w '%{http_code}' \
    -H "Authorization: Bearer $TOKEN" -H 'Range: bytes=0-3' \
    "http://127.0.0.1:$WEB_PORT/v1/artifacts/$ART?project_id=$P")
  [ "$RANGE_CODE" = "206" ] && ok "ART-01: proxied Range request -> 206" || fail "ART-01: proxied Range request -> $RANGE_CODE"
  grep -qi '^content-range: bytes 0-3/' "$RANGE_HEADERS" && ok "ART-01: proxied Content-Range present" || fail "ART-01: proxied Content-Range missing"
  [ "$(cat "$RANGE_BODY")" = '%PDF' ] && ok "ART-01: proxied Range bytes exact" || fail "ART-01: proxied Range bytes mismatch"
  UNSAT_HEADERS="$WORK/artifact-range-unsat.headers"
  UNSAT_CODE=$(curl -sS -D "$UNSAT_HEADERS" -o /dev/null -w '%{http_code}' \
    -H "Authorization: Bearer $TOKEN" -H 'Range: bytes=999999-1000000' \
    "http://127.0.0.1:$WEB_PORT/v1/artifacts/$ART?project_id=$P")
  [ "$UNSAT_CODE" = "416" ] && ok "ART-01: unsatisfiable proxied Range -> 416" || fail "ART-01: unsatisfiable proxied Range -> $UNSAT_CODE"
  grep -qi '^content-range: bytes \*/' "$UNSAT_HEADERS" && ok "ART-01: 416 Content-Range present" || fail "ART-01: 416 Content-Range missing"

  P2=$(curl -s -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \
    -X POST "http://127.0.0.1:$WEB_PORT/v1/projects" \
    -d '{"name":"art-rt-2","workspace":"/w/art-rt-2","mode":"gate-only","brief":{"problem":"p","scope":"s","questions":[],"primary_metrics":["m"],"resources":"","risks":[],"target_outputs":["paper"],"target_venue":null,"baseline_repo":null,"domain":"ml"}}' \
    | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{const j=JSON.parse(d);console.log(j.project_id||'')})")
  ART2=$(curl -s -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \
    -X POST "http://127.0.0.1:$WEB_PORT/v1/artifacts" \
    -d "{\"project_id\":\"$P2\",\"kind\":\"pdf\",\"content_base64\":\"$PDF_B64\",\"media_type\":\"application/pdf\",\"file_name\":\"roundtrip-2.pdf\"}" \
    | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{const j=JSON.parse(d);console.log(j.artifact_id||'')})")
  [ -n "$P2" ] && [ "$ART2" = "$ART" ] && ok "ART-UI-01: two projects share one CAS blob id" || fail "ART-UI-01: shared CAS fixture"
  UNSCOPED=$(curl -s -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $TOKEN" "http://127.0.0.1:$WEB_PORT/v1/artifacts/$ART")
  [ "$UNSCOPED" = "404" ] && ok "ART-UI-01: ambiguous unscoped artifact fails closed" || fail "ART-UI-01: ambiguous unscoped artifact -> $UNSCOPED"
  SCOPED2=$(curl -s -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $TOKEN" "http://127.0.0.1:$WEB_PORT/v1/artifacts/$ART?project_id=$P2")
  [ "$SCOPED2" = "200" ] && ok "ART-UI-01: selected project scope resolves shared blob" || fail "ART-UI-01: selected project scope -> $SCOPED2"
fi

# ── API-01: BFF membership enforcement (--principal) ───────────────────────
MEM_WEB=$((WEB_PORT + 700))
MEM_KERNEL=$((WEB_PORT + 701))
MEM_DATA="$WORK/memdata"
seed_standalone_token "$MEM_DATA" "$TOKEN"
node "$SERVER_BIN" --host 127.0.0.1 --port "$MEM_WEB" --kernel-port "$MEM_KERNEL" \
  --kernel-data-dir "$MEM_DATA" --data-dir "$MEM_DATA" --principal ops-1 > "$WORK/mem.log" 2>&1 &
MEM_PID=$!
memready=0
for _ in $(seq 1 60); do
  if curl -sf -m 2 -X POST "http://127.0.0.1:$MEM_WEB/api/token-check" -H 'content-type: application/json' -d "{\"token\":\"$TOKEN\"}" > /dev/null 2>&1; then memready=1; break; fi
  sleep 0.5
done
[ "$memready" = 1 ] && ok "API-01: BFF with --principal starts" || fail "API-01: BFF start"
if [ "$memready" = 1 ]; then
  # ops-1 creates a project (creator PI seeded via the kernel API field).
  MP=$(curl -s -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' -X POST "http://127.0.0.1:$MEM_WEB/v1/projects" \
    -d '{"name":"mem-rt","workspace":"/w/mem","mode":"gate-only","creator_principal_id":"ops-1","execution":{"runner_profile_id":"profile_isolated_subprocess_v1","runner_target_id":"target_local_process_v1"},"brief":{"problem":"p","scope":"s","questions":[],"primary_metrics":["m"],"resources":"","risks":[],"target_outputs":["paper"],"target_venue":null,"baseline_repo":null,"domain":"ml"}}' \
    | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{const j=JSON.parse(d);console.log(j.project_id||'')})")
  [ -n "$MP" ] && ok "API-01: member-created project ($MP)" || fail "API-01: create"
  R=$(curl -s -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $TOKEN" "http://127.0.0.1:$MEM_WEB/v1/projects/$MP")
  [ "$R" = "200" ] && ok "API-01: PI reads own project -> 200" || fail "API-01: PI read -> $R"
  R=$(curl -s -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $TOKEN" "http://127.0.0.1:$MEM_WEB/v1/projects/$MP/jobs")
  [ "$R" = "200" ] && ok "API-01: PI reads project jobs -> 200" || fail "API-01: PI jobs -> $R"
  TOPOLOGY=$(curl -s -w '\n%{http_code}' -H "Authorization: Bearer $TOKEN" "http://127.0.0.1:$MEM_WEB/v1/projects/$MP/topology?limit=100")
  TOPOLOGY_CODE=$(printf '%s' "$TOPOLOGY" | tail -1)
  TOPOLOGY_SHAPE=$(printf '%s' "$TOPOLOGY" | sed '$d' | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{try{const j=JSON.parse(d);console.log(Array.isArray(j.items)&&j.project_id==='$MP'?'children':'invalid')}catch{console.log('invalid')}})")
  [ "$TOPOLOGY_CODE" = "200" ] && [ "$TOPOLOGY_SHAPE" = "children" ] && ok "SUBAGENT-01: member project topology BFF injects principal -> 200" || fail "SUBAGENT-01: member topology bridge -> status=$TOPOLOGY_CODE shape=$TOPOLOGY_SHAPE"
  R=$(curl -s -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $TOKEN" -H 'x-principal-id: forged-browser-user' "http://127.0.0.1:$MEM_WEB/v1/projects/$MP/topology")
  [ "$R" = "200" ] && ok "SUBAGENT-01: browser-forged topology principal ignored; server identity still works" || fail "SUBAGENT-01: forged topology principal affected BFF -> $R"
  R=$(curl -s -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $TOKEN" "http://127.0.0.1:$MEM_WEB/v1/projects/$MP/trajectory?limit=100")
  [ "$R" = "200" ] && ok "TRAJ-01: member project trajectory BFF injects principal -> 200" || fail "TRAJ-01: member trajectory bridge -> $R"
  R=$(curl -s -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $TOKEN" "http://127.0.0.1:$MEM_WEB/v1/projects/$MP/trajectory-lanes?limit=100")
  [ "$R" = "200" ] && ok "TRAJ-01: member project trajectory lanes BFF injects principal -> 200" || fail "TRAJ-01: member trajectory lanes bridge -> $R"
  L=$(curl -s -H "Authorization: Bearer $TOKEN" "http://127.0.0.1:$MEM_WEB/v1/projects" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{const a=JSON.parse(d);console.log(a.some(p=>p.project_id==='$MP')?'included':'missing')})")
  [ "$L" = "included" ] && ok "API-01: project list includes member project" || fail "API-01: list filter -> $L"
fi
# A second BFF with a DIFFERENT principal must not see the project (404).
node "$SERVER_BIN" --host 127.0.0.1 --port "$((MEM_WEB + 2))" --kernel-port "$MEM_KERNEL" \
  --kernel-data-dir "$MEM_DATA" --data-dir "$MEM_DATA" --principal other-user > "$WORK/mem2.log" 2>&1 &
MEM2_PID=$!
for _ in $(seq 1 60); do
  if curl -sf -m 2 -X POST "http://127.0.0.1:$((MEM_WEB + 2))/api/token-check" -H 'content-type: application/json' -d "{\"token\":\"$TOKEN\"}" > /dev/null 2>&1; then break; fi
  sleep 0.5
done
if [ -n "$MP" ]; then
  R=$(curl -s -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $TOKEN" "http://127.0.0.1:$((MEM_WEB + 2))/v1/projects/$MP")
  [ "$R" = "404" ] && ok "API-01: non-member project read -> 404" || fail "API-01: non-member read -> $R"
  R=$(curl -s -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $TOKEN" "http://127.0.0.1:$((MEM_WEB + 2))/v1/projects/$MP/jobs")
  [ "$R" = "404" ] && ok "API-01: non-member project jobs -> 404" || fail "API-01: non-member jobs -> $R"
  R=$(curl -s -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $TOKEN" "http://127.0.0.1:$((MEM_WEB + 2))/v1/projects/$MP/topology")
  [ "$R" = "404" ] && ok "SUBAGENT-01: non-member project topology -> 404" || fail "SUBAGENT-01: non-member topology -> $R"
  R=$(curl -s -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $TOKEN" "http://127.0.0.1:$((MEM_WEB + 2))/v1/projects/$MP/trajectory-lanes")
  [ "$R" = "404" ] && ok "TRAJ-01: non-member project trajectory lanes -> 404" || fail "TRAJ-01: non-member trajectory lanes -> $R"
  L=$(curl -s -H "Authorization: Bearer $TOKEN" "http://127.0.0.1:$((MEM_WEB + 2))/v1/projects" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{const a=JSON.parse(d);console.log(a.some(p=>p.project_id==='$MP')?'leaked':'filtered')})")
  [ "$L" = "filtered" ] && ok "API-01: non-member project list filtered" || fail "API-01: list leak -> $L"
  # Unknown project id also 404 (no enumeration).
  R=$(curl -s -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $TOKEN" "http://127.0.0.1:$((MEM_WEB + 2))/v1/projects/rsp_nonexistent")
  [ "$R" = "404" ] && ok "API-01: unknown project -> 404" || fail "API-01: unknown -> $R"
fi
# ── §9: job-scoped routes (terminal SSE) check membership before streaming ──
if [ "$memready" = 1 ] && [ -n "$MP" ]; then
  # Submit a job on the member project, then verify the terminal SSE route.
  JID=$(curl -s -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' -X POST "http://127.0.0.1:$MEM_WEB/v1/projects/$MP/jobs" \
    -d '{"idempotency_key":"mem-job-1","kind":"echo","payload":{"message":"hi"}}' | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{const j=JSON.parse(d);console.log(j.job_id||'')})")
  [ -n "$JID" ] && ok "API-01: member job created ($JID)" || fail "API-01: job create"
  R=$(curl -s -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $TOKEN" "http://127.0.0.1:$MEM_WEB/v1/jobs/$JID/terminal" -m 5 || true)
  [ "$R" = "200" ] && ok "API-01: PI opens terminal SSE -> 200" || fail "API-01: PI terminal -> $R"
  R=$(curl -s -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $TOKEN" "http://127.0.0.1:$((MEM_WEB + 2))/v1/jobs/$JID/terminal" -m 5 || true)
  [ "$R" = "404" ] && ok "API-01: non-member terminal SSE -> 404" || fail "API-01: non-member terminal -> $R"
fi

# ── SEC-UI-01: /api/chat/survey membership fail-closed ──────────────────────
# With --principal ops-1, survey on a FOREIGN project must 404 BEFORE the
# connector runs or the corpus is written: snapshot/outbox counts unchanged.
if [ "$memready" = 1 ] && [ -n "$MP" ]; then
  MEMCSRF=$(curl -s -H "Authorization: Bearer $TOKEN" "http://127.0.0.1:$MEM_WEB/api/session/csrf" \
    | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{const j=JSON.parse(d);console.log(j.csrf_token||'')})")
  [ -n "$MEMCSRF" ] && ok "SEC: BFF issues its own csrf token for survey" || fail "SEC: BFF csrf fetch"
  # Project B exists on the kernel but ops-1 is NOT a member (foreign PI).
  # Direct kernel calls authenticate with the MEM kernel's own token file
  # (§5 P0-1: sidecar-spawned kernels always demand the bearer).
  MEMKTOKEN=$(tr -d '\n' < "$MEM_DATA/kernel-token" 2>/dev/null || true)
  MEMSTOKEN=$(tr -d '\n' < "$MEM_DATA/service-token" 2>/dev/null || true)
  PB=$(curl -s -H 'content-type: application/json' -H "Authorization: Bearer $MEMKTOKEN" -X POST "http://127.0.0.1:$MEM_KERNEL/v1/projects" \
    -d '{"name":"foreign-b","workspace":"/w/foreign-b","mode":"gate-only","creator_principal_id":"ops-other","brief":{"problem":"p","scope":"s","questions":[],"primary_metrics":["m"],"resources":"","risks":[],"target_outputs":["paper"],"target_venue":null,"baseline_repo":null,"domain":"ml"}}' \
    | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{const j=JSON.parse(d);console.log(j.project_id||'')})")
  [ -n "$PB" ] && ok "SEC: foreign project B created on kernel ($PB)" || fail "SEC: foreign project B create"
  # A separate member-owned SCOPED project exercises the real survey phase
  # closure without changing MP, which is reused by the role matrix below.
  SP=$(curl -s -H 'content-type: application/json' -H "Authorization: Bearer $MEMKTOKEN" -X POST "http://127.0.0.1:$MEM_KERNEL/v1/projects" \
    -d '{"name":"survey-scoped","workspace":"/w/survey-scoped","mode":"gate-only","creator_principal_id":"ops-1","brief":{"problem":"object recognition","scope":"s","questions":[],"primary_metrics":["m"],"resources":"","risks":[],"target_outputs":["paper"],"target_venue":null,"baseline_repo":null,"domain":"ml"}}' \
    | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{const j=JSON.parse(d);console.log(j.project_id||'')})")
  SG=$(curl -s -H 'content-type: application/json' -H "Authorization: Bearer $MEMKTOKEN" -X POST "http://127.0.0.1:$MEM_KERNEL/v1/projects/$SP/gates" \
    -d '{"type":"scope","title":"survey scope"}' | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{const j=JSON.parse(d);console.log(j.gate_id||'')})")
  R=$(curl -s -o /dev/null -w '%{http_code}' -H 'content-type: application/json' -H "Authorization: Bearer $MEMKTOKEN" \
    -H "x-service-token: $MEMSTOKEN" -H 'x-service-principal: standalone-human-bff' \
    -X POST "http://127.0.0.1:$MEM_KERNEL/internal/human-gates/$SG/decisions" \
    -d '{"actor":"ops-1","principal":{"principal_id":"ops-1","auth_method":"dsh-session","session_id":"sess_survey"},"decision":"approved"}')
  [ -n "$SP" ] && [ -n "$SG" ] && [ "$R" = "200" ] && ok "GUIDE-01: scoped survey fixture ready ($SP)" || fail "GUIDE-01: scoped survey fixture -> project=$SP gate=$SG status=$R"
  R=$(curl -s -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $TOKEN" "http://127.0.0.1:$MEM_WEB/v1/projects/$PB")
  [ "$R" = "404" ] && ok "SEC: ops-1 cannot read foreign project B -> 404" || fail "SEC: B read -> $R"
  count_json() { curl -s -H "Authorization: Bearer $MEMKTOKEN" "http://127.0.0.1:$MEM_KERNEL/v1/projects/$1/$2" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{try{const a=JSON.parse(d);console.log(Array.isArray(a)?a.length:'ERR')}catch(e){console.log('ERR')}})"; }
  B_SNAP_BEFORE=$(count_json "$PB" corpus-snapshots)
  B_EVT_BEFORE=$(count_json "$PB" events)
  A_SNAP_BEFORE=$(count_json "$SP" corpus-snapshots)
  A_EVT_BEFORE=$(count_json "$SP" events)
  BODY=$(curl -s -X POST "http://127.0.0.1:$MEM_WEB/api/chat/survey" \
    -H "Authorization: Bearer $TOKEN" -H "x-csrf-token: $MEMCSRF" -H "Origin: http://127.0.0.1:$MEM_WEB" \
    -H 'content-type: application/json' -d "{\"project_id\":\"$PB\",\"query\":\"temporal action localization\"}")
  case "$BODY" in
    *'"ok":false'*'project not found or access denied'*) ok "SEC: foreign project survey -> 404 fail-closed body" ;;
    *) fail "SEC: foreign survey body -> $BODY" ;;
  esac
  R=$(curl -s -o /dev/null -w '%{http_code}' -X POST "http://127.0.0.1:$MEM_WEB/api/chat/survey" \
    -H "Authorization: Bearer $TOKEN" -H "x-csrf-token: $MEMCSRF" -H "Origin: http://127.0.0.1:$MEM_WEB" \
    -H 'content-type: application/json' -d "{\"project_id\":\"$PB\",\"query\":\"temporal action localization\"}")
  [ "$R" = "404" ] && ok "SEC: foreign project survey -> 404" || fail "SEC: foreign survey -> $R"
  [ "$(count_json "$PB" corpus-snapshots)" = "$B_SNAP_BEFORE" ] && ok "SEC: foreign survey leaves B corpus snapshot count unchanged ($B_SNAP_BEFORE)" || fail "SEC: B snapshot count changed"
  [ "$(count_json "$PB" events)" = "$B_EVT_BEFORE" ] && ok "SEC: foreign survey leaves B outbox/events count unchanged ($B_EVT_BEFORE)" || fail "SEC: B events changed"
  BODY=$(curl -s -X POST "http://127.0.0.1:$MEM_WEB/api/chat/survey" \
    -H "Authorization: Bearer $TOKEN" -H "x-csrf-token: $MEMCSRF" -H "Origin: http://127.0.0.1:$MEM_WEB" \
    -H 'content-type: application/json' -d '{"project_id":"rsp_nonexistent","query":"temporal action localization"}')
  case "$BODY" in
    *'"ok":false'*'project not found or access denied'*) ok "SEC: unknown project survey -> 404 fail-closed body" ;;
    *) fail "SEC: unknown survey body -> $BODY" ;;
  esac
  # Member's OWN SCOPED project: survey writes one snapshot and atomically
  # advances to SURVEYING (corpus + transition produce two Outbox events).
  R=$(curl -s -o /dev/null -w '%{http_code}' -X POST "http://127.0.0.1:$MEM_WEB/api/chat/survey" \
    -H "Authorization: Bearer $TOKEN" -H "x-csrf-token: $MEMCSRF" -H "Origin: http://127.0.0.1:$MEM_WEB" \
    -H 'content-type: application/json' -d "{\"project_id\":\"$SP\",\"query\":\"temporal action localization\"}" -m 90)
  [ "$R" = "200" ] && ok "SEC: member project survey -> 200" || fail "SEC: member survey -> $R"
  [ "$(count_json "$SP" corpus-snapshots)" = "$((A_SNAP_BEFORE + 1))" ] && ok "SEC: member survey writes exactly one corpus snapshot ($((A_SNAP_BEFORE + 1)))" || fail "SEC: A snapshot count after survey"
  [ "$(count_json "$SP" events)" = "$((A_EVT_BEFORE + 2))" ] && ok "GUIDE-01: survey emits corpus + transition events ($((A_EVT_BEFORE + 2)))" || fail "GUIDE-01: survey event count"
  SURVEY_PROJ=$(curl -s -H "Authorization: Bearer $TOKEN" "http://127.0.0.1:$MEM_WEB/v1/projects/$SP/projection")
  SURVEY_FLOW=$(printf '%s' "$SURVEY_PROJ" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{const j=JSON.parse(d);console.log(j.project?.status==='SURVEYING'&&j.next_actions_v2?.[0]?.code==='idea_generate'?'advanced':'stale')})")
  [ "$SURVEY_FLOW" = "advanced" ] && ok "GUIDE-01: survey projection advances to SURVEYING/idea_generate" || fail "GUIDE-01: stale survey projection -> $SURVEY_FLOW"
  SNAP_SHAPE=$(curl -s -H "Authorization: Bearer $MEMKTOKEN" "http://127.0.0.1:$MEM_KERNEL/v1/projects/$SP/corpus-snapshots" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{const a=JSON.parse(d),s=a[a.length-1];console.log((s&&(s.source_status==='complete'||s.source_status==='pending')&&Array.isArray(s.citation_edges))?'preserved':'missing')})")
  [ "$SNAP_SHAPE" = "preserved" ] && ok "GUIDE-01: survey preserves aggregate source status + citation edges" || fail "GUIDE-01: survey snapshot shape -> $SNAP_SHAPE"
  # Stable error codes: the fail-closed body never echoes internal detail.
  for NEEDLE in '/home/' '/dev/' 'http://' 'at ' 'env'; do
    if printf '%s' "$BODY" | grep -qF "$NEEDLE"; then
      fail "SEC: fail-closed body leaks '$NEEDLE' -> $BODY"
    else
      ok "SEC: fail-closed body has no '$NEEDLE'"
    fi
  done
fi

# ── API-01/v2: BFF role resolution + x-principal-role injection ─────────────
# Kernel v2 semantics: x-principal-role ∈ {pi,researcher,operator,auditor,
# viewer}; viewer/auditor read-only, researcher no governance writes
# (transitions/gates/decisions/budget/approve/accept), pi/operator full.
# The BFF resolves the loopback operator's role from project membership and
# injects x-principal-id + x-principal-role on project-scoped /v2 requests —
# the client never sends either header. Behavioral proof of the injection:
# the viewer write 403 only appears when the BFF resolved+enforced the role.
if [ "$memready" = 1 ] && [ -n "$MP" ]; then
  # Memberships are created on the KERNEL directly (actor = PI ops-1).
  for ROLE_MEMBER in "viewer-1:viewer" "researcher-1:researcher" "auditor-1:auditor"; do
    MID=${ROLE_MEMBER%%:*}
    MROLE=${ROLE_MEMBER##*:}
    R=$(curl -s -o /dev/null -w '%{http_code}' -H 'content-type: application/json' \
      -H "Authorization: Bearer $MEMKTOKEN" \
      -X POST "http://127.0.0.1:$MEM_KERNEL/v1/projects/$MP/members" \
      -d "{\"principal_id\":\"$MID\",\"role\":\"$MROLE\",\"actor\":\"ops-1\"}")
    [ "$R" = "200" ] && ok "API-01: kernel member $MID/$MROLE added" || fail "API-01: add member $MID -> $R"
  done
  # One BFF per role (each BFF maps one loopback operator identity); all
  # reuse the same kernel sidecar (identity-verified, SIDE-01).
  VROLE_WEB=$((MEM_WEB + 3)); RROLE_WEB=$((MEM_WEB + 4)); AROLE_WEB=$((MEM_WEB + 5))
  node "$SERVER_BIN" --host 127.0.0.1 --port "$VROLE_WEB" --kernel-port "$MEM_KERNEL" \
    --kernel-data-dir "$MEM_DATA" --data-dir "$MEM_DATA" --principal viewer-1 > "$WORK/viewer.log" 2>&1 &
  VROLE_PID=$!
  node "$SERVER_BIN" --host 127.0.0.1 --port "$RROLE_WEB" --kernel-port "$MEM_KERNEL" \
    --kernel-data-dir "$MEM_DATA" --data-dir "$MEM_DATA" --principal researcher-1 > "$WORK/researcher.log" 2>&1 &
  RROLE_PID=$!
  node "$SERVER_BIN" --host 127.0.0.1 --port "$AROLE_WEB" --kernel-port "$MEM_KERNEL" \
    --kernel-data-dir "$MEM_DATA" --data-dir "$MEM_DATA" --principal auditor-1 > "$WORK/auditor.log" 2>&1 &
  AROLE_PID=$!
  for P in "$VROLE_WEB" "$RROLE_WEB" "$AROLE_WEB"; do
    for _ in $(seq 1 60); do
      if curl -sf -m 2 -X POST "http://127.0.0.1:$P/api/token-check" -H 'content-type: application/json' -d "{\"token\":\"$TOKEN\"}" > /dev/null 2>&1; then break; fi
      sleep 0.5
    done
  done
  ok "API-01: role BFFs (viewer/researcher/auditor) started"
  VROLE_CSRF=$(curl -s -H "Authorization: Bearer $TOKEN" "http://127.0.0.1:$VROLE_WEB/api/session/csrf" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{const j=JSON.parse(d);console.log(j.csrf_token||'')})")
  AROLE_CSRF=$(curl -s -H "Authorization: Bearer $TOKEN" "http://127.0.0.1:$AROLE_WEB/api/session/csrf" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{const j=JSON.parse(d);console.log(j.csrf_token||'')})")
  ROLE_SURVEY_BEFORE=$(count_json "$MP" corpus-snapshots)
  R=$(curl -s -o /dev/null -w '%{http_code}' -X POST "http://127.0.0.1:$VROLE_WEB/api/chat/survey" \
    -H "Authorization: Bearer $TOKEN" -H "x-csrf-token: $VROLE_CSRF" -H "Origin: http://127.0.0.1:$VROLE_WEB" \
    -H 'content-type: application/json' -d "{\"project_id\":\"$MP\",\"query\":\"must not run\"}")
  [ "$R" = "403" ] && ok "API-01: viewer survey write -> 403 before connector" || fail "API-01: viewer survey -> $R"
  R=$(curl -s -o /dev/null -w '%{http_code}' -X POST "http://127.0.0.1:$AROLE_WEB/api/chat/survey" \
    -H "Authorization: Bearer $TOKEN" -H "x-csrf-token: $AROLE_CSRF" -H "Origin: http://127.0.0.1:$AROLE_WEB" \
    -H 'content-type: application/json' -d "{\"project_id\":\"$MP\",\"query\":\"must not run\"}")
  [ "$R" = "403" ] && ok "API-01: auditor survey write -> 403 before connector" || fail "API-01: auditor survey -> $R"
  [ "$(count_json "$MP" corpus-snapshots)" = "$ROLE_SURVEY_BEFORE" ] && ok "API-01: read-only survey attempts have zero corpus side effects" || fail "API-01: read-only survey changed corpus"
  # PI (ops-1): non-project-scoped passthrough + v2 reads + governance writes.
  R=$(curl -s -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $TOKEN" "http://127.0.0.1:$MEM_WEB/v2/health")
  [ "$R" = "200" ] && ok "API-01: /v2/health passthrough (no project scope) -> 200" || fail "API-01: v2 health -> $R"
  R=$(curl -s -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $TOKEN" "http://127.0.0.1:$MEM_WEB/v2/projects/$MP")
  [ "$R" = "200" ] && ok "API-01: PI v2 project read -> 200" || fail "API-01: PI v2 read -> $R"
  PROJ=$(curl -s -H "Authorization: Bearer $TOKEN" "http://127.0.0.1:$MEM_WEB/v2/projects/$MP/projection")
  case "$PROJ" in
    *'"membership":"pi"'*) ok "API-01: projection membership=pi proves x-principal-id reached the kernel" ;;
    *) fail "API-01: projection membership -> $PROJ" ;;
  esac
  R=$(curl -s -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \
    -X POST "http://127.0.0.1:$MEM_WEB/v2/projects/$MP/gate-requests" \
    -d '{"type":"idea","title":"role matrix idea"}')
  [ "$R" = "201" ] && ok "API-01: PI v2 gate-request -> 201" || fail "API-01: PI v2 gate-request -> $R"
  # Wrong expected_revision: the BFF must let the PI through so the KERNEL
  # answers 409 — proves governance writes are not blocked at the BFF.
  R=$(curl -s -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \
    -X POST "http://127.0.0.1:$MEM_WEB/v2/projects/$MP/transitions" -d '{"to":"active","expected_revision":999999}')
  [ "$R" = "409" ] && ok "API-01: PI v2 transition reaches the kernel (409 revision_conflict)" || fail "API-01: PI v2 transition -> $R"
  # viewer-1: read-only. The 403 for a client request WITHOUT any role header
  # is the behavioral proof that the BFF resolved the role and enforced it.
  R=$(curl -s -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $TOKEN" "http://127.0.0.1:$VROLE_WEB/v2/projects/$MP")
  [ "$R" = "200" ] && ok "API-01: viewer v2 read -> 200" || fail "API-01: viewer v2 read -> $R"
  VBODY=$(curl -s -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \
    -X POST "http://127.0.0.1:$VROLE_WEB/v2/projects/$MP/gate-requests" -d '{"type":"idea","title":"viewer write"}')
  case "$VBODY" in
    *'"ok":false'*'role forbidden'*) ok "API-01: viewer v2 write -> 403 role forbidden (BFF-injected role)" ;;
    *) fail "API-01: viewer v2 write body -> $VBODY" ;;
  esac
  R=$(curl -s -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \
    -X POST "http://127.0.0.1:$VROLE_WEB/v2/projects/$MP/transitions" -d '{"to":"active","expected_revision":0}')
  [ "$R" = "403" ] && ok "API-01: viewer v2 transition -> 403" || fail "API-01: viewer v2 transition -> $R"
  R=$(curl -s -o /dev/null -w '%{http_code}' -X POST -H "Authorization: Bearer $TOKEN" "http://127.0.0.1:$VROLE_WEB/v1/projects/$MP/archive")
  [ "$R" = "403" ] && ok "API-01: viewer v1 write -> 403 (BFF defense in depth)" || fail "API-01: viewer v1 write -> $R"
  L=$(curl -s -H "Authorization: Bearer $TOKEN" "http://127.0.0.1:$VROLE_WEB/v2/projects" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{const a=JSON.parse(d);console.log(a.items&&a.items.some(p=>p.project_id==='$MP')&&!a.items.some(p=>p.project_id==='$PB')?'filtered':'leaked')})")
  [ "$L" = "filtered" ] && ok "API-01: v2 list filtered to viewer memberships (no foreign project)" || fail "API-01: viewer v2 list -> $L"
  # researcher-1: reads OK, governance writes 403, other writes pass.
  R=$(curl -s -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $TOKEN" "http://127.0.0.1:$RROLE_WEB/v2/projects/$MP")
  [ "$R" = "200" ] && ok "API-01: researcher v2 read -> 200" || fail "API-01: researcher v2 read -> $R"
  R=$(curl -s -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \
    -X POST "http://127.0.0.1:$RROLE_WEB/v2/projects/$MP/transitions" -d '{"to":"active","expected_revision":0}')
  [ "$R" = "403" ] && ok "API-01: researcher governance write (transitions) -> 403" || fail "API-01: researcher transition -> $R"
  R=$(curl -s -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \
    -X POST "http://127.0.0.1:$RROLE_WEB/v2/projects/$MP/gate-requests" -d '{"type":"idea","title":"researcher gate request"}')
  [ "$R" = "201" ] && ok "API-01: researcher gate-request (non-governance write) -> 201" || fail "API-01: researcher gate-request -> $R"
  # auditor-1: read-only like viewer.
  R=$(curl -s -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $TOKEN" "http://127.0.0.1:$AROLE_WEB/v2/projects/$MP")
  [ "$R" = "200" ] && ok "API-01: auditor v2 read -> 200" || fail "API-01: auditor v2 read -> $R"
  R=$(curl -s -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \
    -X POST "http://127.0.0.1:$AROLE_WEB/v2/projects/$MP/gate-requests" -d '{"type":"idea","title":"auditor write"}')
  [ "$R" = "403" ] && ok "API-01: auditor v2 write -> 403" || fail "API-01: auditor v2 write -> $R"
  # non-member (other-user BFF): v2 404 — membership precedes role, no enumeration.
  R=$(curl -s -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $TOKEN" "http://127.0.0.1:$((MEM_WEB + 2))/v2/projects/$MP")
  [ "$R" = "404" ] && ok "API-01: non-member v2 read -> 404" || fail "API-01: non-member v2 read -> $R"
  R=$(curl -s -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \
    -X POST "http://127.0.0.1:$((MEM_WEB + 2))/v2/projects/$MP/gate-requests" -d '{"type":"idea","title":"x"}')
  [ "$R" = "404" ] && ok "API-01: non-member v2 write -> 404 (membership first)" || fail "API-01: non-member v2 write -> $R"
  R=$(curl -s -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $TOKEN" "http://127.0.0.1:$MEM_WEB/v2/projects/rsp_nonexistent")
  [ "$R" = "404" ] && ok "API-01: unknown v2 project -> 404" || fail "API-01: unknown v2 project -> $R"
  # Stable error body: the role-forbidden response never leaks internal detail.
  for NEEDLE in '/home/' '/dev/' '/usr/' 'http://' 'env' ' at '; do
    if printf '%s' "$VBODY" | grep -qF "$NEEDLE"; then
      fail "API-01: role-forbidden body leaks '$NEEDLE' -> $VBODY"
    else
      ok "API-01: role-forbidden body has no '$NEEDLE'"
    fi
  done
  # ── hardening §5 P1 (GOV-01/ONBOARD-01): PI-only adopt/archive/unarchive ──
  # Explicit capability route table: intake ADOPT and project archive/
  # unarchive are PI/operator-only decisions. researcher/viewer/auditor get
  # 403 at the BFF ('role forbidden', never forwarded) AND at the KERNEL
  # (role_forbidden, resolved from the kernel's OWN project_members table —
  # never a single BFF layer); a missing principal at the kernel is 422
  # principal_required (GOV-01 fail-closed). The BFF injects its
  # server-derived x-principal-id/x-principal-role on these forwards so the
  # kernel second layer can enforce.
  echo "== §5 P1: PI-only intake adopt / project archive / unarchive =="
  KAPI2() { curl -s -H 'content-type: application/json' -H "Authorization: Bearer $MEMKTOKEN" "$@"; }
  # BFF layer negatives on MP (researcher-1/viewer-1/auditor-1 are members).
  R=$(curl -s -o /dev/null -w '%{http_code}' -X POST -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \
    "http://127.0.0.1:$RROLE_WEB/v1/projects/$MP/intake/intk_nonexistent/adopt" -d '{}')
  [ "$R" = "403" ] && ok "P1: researcher intake adopt -> 403 (BFF route table)" || fail "P1: researcher adopt -> $R"
  R=$(curl -s -o /dev/null -w '%{http_code}' -X POST -H "Authorization: Bearer $TOKEN" "http://127.0.0.1:$RROLE_WEB/v1/projects/$MP/archive")
  [ "$R" = "403" ] && ok "P1: researcher project archive -> 403 (BFF route table)" || fail "P1: researcher archive -> $R"
  R=$(curl -s -o /dev/null -w '%{http_code}' -X POST -H "Authorization: Bearer $TOKEN" "http://127.0.0.1:$RROLE_WEB/v1/projects/$MP/unarchive")
  [ "$R" = "403" ] && ok "P1: researcher project unarchive -> 403 (BFF route table)" || fail "P1: researcher unarchive -> $R"
  R=$(curl -s -o /dev/null -w '%{http_code}' -X POST -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \
    "http://127.0.0.1:$VROLE_WEB/v1/projects/$MP/intake/intk_nonexistent/adopt" -d '{}')
  [ "$R" = "403" ] && ok "P1: viewer intake adopt -> 403" || fail "P1: viewer adopt -> $R"
  R=$(curl -s -o /dev/null -w '%{http_code}' -X POST -H "Authorization: Bearer $TOKEN" "http://127.0.0.1:$AROLE_WEB/v1/projects/$MP/unarchive")
  [ "$R" = "403" ] && ok "P1: auditor project unarchive -> 403" || fail "P1: auditor unarchive -> $R"
  RB=$(curl -s -X POST -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \
    "http://127.0.0.1:$RROLE_WEB/v1/projects/$MP/intake/intk_nonexistent/adopt" -d '{}')
  case "$RB" in
    *'"ok":false'*'role forbidden'*) ok "P1: researcher adopt body is the stable role-forbidden shape" ;;
    *) fail "P1: researcher adopt body -> $RB" ;;
  esac
  # Dedicated project for the kernel second layer + PI positive path.
  PROJ2=$(KAPI2 -X POST "http://127.0.0.1:$MEM_KERNEL/v1/projects" \
    -d '{"name":"p1-intake-pi","workspace":"/w/p1","mode":"gate-only","creator_principal_id":"ops-1","brief":{"problem":"p","scope":"s","questions":[],"primary_metrics":["m"],"resources":"","risks":[],"target_outputs":["paper"],"target_venue":null,"baseline_repo":null,"domain":"ml"}}' \
    | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{const j=JSON.parse(d);console.log(j.project_id||'')})")
  [ -n "$PROJ2" ] && ok "P1: PI-only project created on kernel ($PROJ2)" || fail "P1: PI-only project create"
  R=$(curl -s -o /dev/null -w '%{http_code}' -H 'content-type: application/json' -H "Authorization: Bearer $MEMKTOKEN" \
    -X POST "http://127.0.0.1:$MEM_KERNEL/v1/projects/$PROJ2/members" \
    -d '{"principal_id":"researcher-1","role":"researcher","actor":"ops-1"}')
  [ "$R" = "200" ] && ok "P1: researcher-1 added to PI-only project (role researcher)" || fail "P1: add researcher-1 -> $R"
  # Kernel second layer (direct kernel calls with the kernel bearer): a
  # researcher-role x-principal-id is 403 role_forbidden on adopt/archive/
  # unarchive; a non-member principal is 404 (no enumeration); no identity at
  # all is 422 principal_required.
  IID=$(KAPI2 -X POST "http://127.0.0.1:$MEM_KERNEL/v1/projects/$PROJ2/intake" -d '{"source_label":"p1-intake"}' \
    | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{const j=JSON.parse(d);console.log(j.intake_id||'')})")
  [ -n "$IID" ] && ok "P1: intake session begun on kernel ($IID)" || fail "P1: intake begin"
  R=$(curl -s -o /dev/null -w '%{http_code}' -H 'content-type: application/json' -H "Authorization: Bearer $MEMKTOKEN" -H 'x-principal-id: researcher-1' \
    -H "x-service-token: $MEMSTOKEN" -H 'x-service-principal: standalone-human-bff' -H 'x-principal-session: session-researcher-1' \
    -X POST "http://127.0.0.1:$MEM_KERNEL/v1/projects/$PROJ2/intake/$IID/adopt" \
    -d '{"expected_proposal_revision":1}')
  [ "$R" = "403" ] && ok "P1: kernel direct adopt as researcher -> 403 role_forbidden" || fail "P1: kernel researcher adopt -> $R"
  R=$(curl -s -o /dev/null -w '%{http_code}' -X POST -H "Authorization: Bearer $MEMKTOKEN" -H 'x-principal-id: researcher-1' \
    "http://127.0.0.1:$MEM_KERNEL/v1/projects/$PROJ2/archive")
  [ "$R" = "403" ] && ok "P1: kernel direct archive as researcher -> 403" || fail "P1: kernel researcher archive -> $R"
  R=$(curl -s -o /dev/null -w '%{http_code}' -X POST -H "Authorization: Bearer $MEMKTOKEN" -H 'x-principal-id: researcher-1' \
    "http://127.0.0.1:$MEM_KERNEL/v1/projects/$PROJ2/unarchive")
  [ "$R" = "403" ] && ok "P1: kernel direct unarchive as researcher -> 403" || fail "P1: kernel researcher unarchive -> $R"
  R=$(curl -s -o /dev/null -w '%{http_code}' -H 'content-type: application/json' -H "Authorization: Bearer $MEMKTOKEN" \
    -H "x-service-token: $MEMSTOKEN" -H 'x-service-principal: standalone-human-bff' \
    -X POST "http://127.0.0.1:$MEM_KERNEL/v1/projects/$PROJ2/intake/$IID/adopt" -d '{"expected_proposal_revision":1}')
  [ "$R" = "422" ] && ok "P1: kernel direct adopt without principal -> 422 principal_required" || fail "P1: kernel no-principal adopt -> $R"
  R=$(curl -s -o /dev/null -w '%{http_code}' -X POST -H "Authorization: Bearer $MEMKTOKEN" \
    "http://127.0.0.1:$MEM_KERNEL/v1/projects/$PROJ2/archive")
  [ "$R" = "422" ] && ok "P1: kernel direct archive without principal -> 422 principal_required" || fail "P1: kernel no-principal archive -> $R"
  R=$(curl -s -o /dev/null -w '%{http_code}' -H 'content-type: application/json' -H "Authorization: Bearer $MEMKTOKEN" -H 'x-principal-id: viewer-1' \
    -H "x-service-token: $MEMSTOKEN" -H 'x-service-principal: standalone-human-bff' -H 'x-principal-session: session-viewer-1' \
    -X POST "http://127.0.0.1:$MEM_KERNEL/v1/projects/$PROJ2/intake/$IID/adopt" \
    -d '{"expected_proposal_revision":1}')
  [ "$R" = "404" ] && ok "P1: kernel direct adopt as non-member -> 404 (no enumeration)" || fail "P1: kernel non-member adopt -> $R"
  # PI positive path through the BFF: the full intake pipeline on PROJ2, then
  # the PI (ops-1) adopts — the BFF forwards with x-principal-id/x-principal-role
  # and the kernel's own membership lookup lets pi through.
  printf 'intake artifact bytes' > "$WORK/p1-intake.txt"
  # Multipart raw-bytes passthrough (UPLOAD-01): NO content-type override —
  # curl -F owns the multipart boundary header.
  ST=$(curl -s -X POST -H "Authorization: Bearer $TOKEN" \
    "http://127.0.0.1:$MEM_WEB/v1/projects/$PROJ2/intake/$IID/artifacts" \
    -F "file=@$WORK/p1-intake.txt;filename=paper.txt" -F 'media_type=text/plain')
  case "$ST" in
    *'"artifact_id"'*) ok "P1: intake artifact staged via BFF" ;;
    *) fail "P1: stage artifact -> $(printf '%s' "$ST" | head -c 160)" ;;
  esac
  R=$(curl -s -o /dev/null -w '%{http_code}' -X POST -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \
    "http://127.0.0.1:$MEM_WEB/v1/projects/$PROJ2/intake/$IID/scan")
  [ "$R" = "200" ] && ok "P1: intake scan -> 200" || fail "P1: scan -> $R"
  ANS=$(curl -s -H "Authorization: Bearer $MEMKTOKEN" "http://127.0.0.1:$MEM_KERNEL/v1/projects/$PROJ2/intake/$IID/questions" \
    | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{const q=(JSON.parse(d).questions)||[];const a=q.filter(x=>x.required).map(x=>({question_code:x.question_code,answer:x.question_code==='observed_phase_claim'?'brief':'yes',question_revision:x.question_revision}));console.log(JSON.stringify({answers:a}))})")
  R=$(curl -s -o /dev/null -w '%{http_code}' -X POST -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \
    "http://127.0.0.1:$MEM_WEB/v1/projects/$PROJ2/intake/$IID/answers" -d "$ANS")
  [ "$R" = "200" ] && ok "P1: intake grill answers -> 200" || fail "P1: answers -> $R"
  PROPOSAL=$(curl -s -o "$WORK/p1-propose.json" -w '%{http_code}' -X POST -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \
    "http://127.0.0.1:$MEM_WEB/v1/projects/$PROJ2/intake/$IID/propose")
  PREV=$(node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{try{const j=JSON.parse(d);console.log(j.revision||'')}catch(e){console.log('')}})" < "$WORK/p1-propose.json")
  [ "$PROPOSAL" = "201" ] && [ -n "$PREV" ] && ok "P1: intake propose -> 201 (revision $PREV)" || fail "P1: propose -> $PROPOSAL ($(head -c 120 "$WORK/p1-propose.json"))"
  ADOPT=$(curl -s -o "$WORK/p1-adopt.json" -w '%{http_code}' -X POST -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \
    "http://127.0.0.1:$MEM_WEB/v1/projects/$PROJ2/intake/$IID/adopt" \
    -d "{\"expected_proposal_revision\":$PREV}")
  RECEIPT=$(node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{try{const j=JSON.parse(d);console.log(j.adoption_id||'')}catch(e){console.log('')}})" < "$WORK/p1-adopt.json")
  [ "$ADOPT" = "200" ] && [ -n "$RECEIPT" ] && ok "P1: PI intake adopt via BFF -> 200 (receipt $RECEIPT)" || fail "P1: PI adopt -> $ADOPT ($(head -c 120 "$WORK/p1-adopt.json"))"
  # PI/operator archive + unarchive success through the BFF (200, not 403).
  R=$(curl -s -o /dev/null -w '%{http_code}' -X POST -H "Authorization: Bearer $TOKEN" "http://127.0.0.1:$MEM_WEB/v1/projects/$PROJ2/archive")
  [ "$R" = "200" ] && ok "P1: PI project archive via BFF -> 200" || fail "P1: PI archive -> $R"
  R=$(curl -s -o /dev/null -w '%{http_code}' -X POST -H "Authorization: Bearer $TOKEN" "http://127.0.0.1:$MEM_WEB/v1/projects/$PROJ2/unarchive")
  [ "$R" = "200" ] && ok "P1: PI project unarchive via BFF -> 200" || fail "P1: PI unarchive -> $R"
  # Revocation is immediate on the NEW kernel gate too: remove researcher-1
  # from PROJ2 — the kernel's next adopt with that principal answers 404
  # (membership/role re-resolved per request, no stale authorization).
  R=$(curl -s -o /dev/null -w '%{http_code}' -H 'content-type: application/json' -H "Authorization: Bearer $MEMKTOKEN" \
    -X DELETE "http://127.0.0.1:$MEM_KERNEL/v1/projects/$PROJ2/members/researcher-1" -d '{"actor":"ops-1"}')
  [ "$R" = "200" ] && ok "P1: researcher-1 removed from PI-only project" || fail "P1: remove researcher-1 -> $R"
  R=$(curl -s -o /dev/null -w '%{http_code}' -H 'content-type: application/json' -H "Authorization: Bearer $MEMKTOKEN" -H 'x-principal-id: researcher-1' \
    -H "x-service-token: $MEMSTOKEN" -H 'x-service-principal: standalone-human-bff' -H 'x-principal-session: session-researcher-1' \
    -X POST "http://127.0.0.1:$MEM_KERNEL/v1/projects/$PROJ2/intake/$IID/adopt" \
    -d '{"expected_proposal_revision":1}')
  [ "$R" = "404" ] && ok "P1: revoked researcher adopt -> 404 on the very next request (no stale membership)" || fail "P1: revoked researcher adopt -> $R"
fi

# ── hardening §5 P0-2 (API-01/PTY-01): global-id routes are project-resolved
# before forwarding (artifact/document/pty/events) + immediate revocation ────
# A member BFF (ops-1) must answer 404 for artifacts/documents/pty sessions/
# events of a FOREIGN project (no enumeration), 200 for its own, and 404 for
# guessed ids. The pty lease passes through the proxy and the KERNEL enforces
# it (control without the lease -> 403 lease_required). Removing a member
# revokes access on the NEXT request (membership is never cached).
if [ "$memready" = 1 ] && [ -n "$MP" ]; then
  echo "== P0-2: global-id project resolution (artifact/document/pty/events) + revocation =="
  MEMKTOKEN=$(tr -d '\n' < "$MEM_DATA/kernel-token" 2>/dev/null || true)
  KAPI() { curl -s -H 'content-type: application/json' -H "Authorization: Bearer $MEMKTOKEN" "$@"; }
  BAPI() { curl -s -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' "$@"; }
  # Foreign project owned by p0-2-foreign (kernel direct) — ops-1 is NOT a member.
  FB=$(KAPI -X POST "http://127.0.0.1:$MEM_KERNEL/v1/projects" \
    -d '{"name":"p02-foreign","workspace":"/w/p02f","mode":"gate-only","creator_principal_id":"p0-2-foreign","execution":{"runner_profile_id":"profile_isolated_subprocess_v1","runner_target_id":"target_local_process_v1"},"brief":{"problem":"p","scope":"s","questions":[],"primary_metrics":["m"],"resources":"","risks":[],"target_outputs":["paper"],"target_venue":null,"baseline_repo":null,"domain":"ml"}}' \
    | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{const j=JSON.parse(d);console.log(j.project_id||'')})")
  [ -n "$FB" ] && ok "P0-2: foreign project created on kernel ($FB)" || fail "P0-2: foreign project create"
  # Artifacts: one in the foreign project, one in the member project.
  ART_FB=$(KAPI -X POST "http://127.0.0.1:$MEM_KERNEL/v1/artifacts" \
    -d "{\"project_id\":\"$FB\",\"kind\":\"data\",\"content_base64\":\"$(printf 'foreign' | base64 -w0)\"}" \
    | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{const j=JSON.parse(d);console.log(j.artifact_id||'')})")
  ART_MP=$(BAPI -X POST "http://127.0.0.1:$MEM_WEB/v1/artifacts" \
    -d "{\"project_id\":\"$MP\",\"kind\":\"data\",\"content_base64\":\"$(printf 'member' | base64 -w0)\"}" \
    | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{const j=JSON.parse(d);console.log(j.artifact_id||'')})")
  [ -n "$ART_FB" ] && ok "P0-2: foreign artifact registered ($ART_FB)" || fail "P0-2: foreign artifact register"
  [ -n "$ART_MP" ] && ok "P0-2: member artifact registered via BFF ($ART_MP)" || fail "P0-2: member artifact register"
  R=$(curl -s -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $TOKEN" "http://127.0.0.1:$MEM_WEB/v1/artifacts/$ART_FB")
  [ "$R" = "404" ] && ok "P0-2: non-member artifact GET -> 404" || fail "P0-2: non-member artifact -> $R"
  R=$(curl -s -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $TOKEN" "http://127.0.0.1:$MEM_WEB/v1/artifacts/$ART_FB?project_id=$FB")
  [ "$R" = "404" ] && ok "P0-2: non-member artifact GET with foreign project_id -> 404" || fail "P0-2: foreign artifact query -> $R"
  R=$(curl -s -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $TOKEN" "http://127.0.0.1:$MEM_WEB/v1/artifacts/$ART_MP")
  [ "$R" = "200" ] && ok "P0-2: member artifact GET -> 200" || fail "P0-2: member artifact -> $R"
  R=$(curl -s -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $TOKEN" "http://127.0.0.1:$MEM_WEB/v1/artifacts/art_does_not_exist")
  [ "$R" = "404" ] && ok "P0-2: guessed artifact id -> 404" || fail "P0-2: guessed artifact -> $R"
  # Registering an artifact INTO a foreign project through the BFF must 404
  # (body project is checked like the pty-open rule) — no cross-project write.
  R=$(curl -s -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \
    -X POST "http://127.0.0.1:$MEM_WEB/v1/artifacts" \
    -d "{\"project_id\":\"$FB\",\"kind\":\"data\",\"content_base64\":\"$(printf 'x' | base64 -w0)\"}")
  [ "$R" = "404" ] && ok "P0-2: artifact register into foreign project via BFF -> 404" || fail "P0-2: artifact register foreign -> $R"
  # Documents (TeX): manuscript-drafts generates a document; the BFF resolves
  # /v1/documents/{id}/* through the kernel and enforces membership.
  DOC_FB=$(KAPI -X POST "http://127.0.0.1:$MEM_KERNEL/v1/projects/$FB/manuscript-drafts" -d '{}' \
    | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{const j=JSON.parse(d);console.log(j.document_id||'')})")
  DOC_MP=$(BAPI -X POST "http://127.0.0.1:$MEM_WEB/v1/projects/$MP/manuscript-drafts" -d '{}' \
    | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{const j=JSON.parse(d);console.log(j.document_id||'')})")
  [ -n "$DOC_FB" ] && ok "P0-2: foreign document created ($DOC_FB)" || fail "P0-2: foreign document create"
  [ -n "$DOC_MP" ] && ok "P0-2: member document created via BFF ($DOC_MP)" || fail "P0-2: member document create"
  R=$(curl -s -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $TOKEN" "http://127.0.0.1:$MEM_WEB/v1/documents/$DOC_FB/tree")
  [ "$R" = "404" ] && ok "P0-2: non-member document tree -> 404" || fail "P0-2: non-member doc tree -> $R"
  R=$(curl -s -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \
    -X PUT "http://127.0.0.1:$MEM_WEB/v1/documents/$DOC_FB/file?path=paper.tex" -d '{"path":"paper.tex","content":"x"}')
  [ "$R" = "404" ] && ok "P0-2: non-member document write -> 404" || fail "P0-2: non-member doc write -> $R"
  R=$(curl -s -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $TOKEN" "http://127.0.0.1:$MEM_WEB/v1/documents/$DOC_MP/tree")
  [ "$R" = "200" ] && ok "P0-2: member document tree -> 200" || fail "P0-2: member doc tree -> $R"
  R=$(curl -s -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $TOKEN" "http://127.0.0.1:$MEM_WEB/v1/documents/doc_does_not_exist/tree")
  [ "$R" = "404" ] && ok "P0-2: guessed document id -> 404" || fail "P0-2: guessed doc -> $R"
  # PTY sessions: foreign session must 404 at the BFF; the member session is
  # readable and controllable (the BFF injects the operator principal; the
  # client's x-pty-lease passes through and the KERNEL enforces it).
  FBWS=$(KAPI -X POST "http://127.0.0.1:$MEM_KERNEL/v1/projects/$FB/workspaces" -d '{"kind":"scratch","name":"s"}' \
    | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{const j=JSON.parse(d);console.log(j.workspace_id||'')})")
  FBCTX=$(curl -s "http://127.0.0.1:$MEM_KERNEL/v1/pty/contexts?project_id=$FB" \
    -H "Authorization: Bearer $MEMKTOKEN" -H 'x-principal-id: p0-2-foreign' \
    | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{const a=JSON.parse(d);console.log((Array.isArray(a)?a:[]).find(x=>x.context_kind==='research')?.context_id||'')})")
  PTY_FB=$(curl -s -X POST "http://127.0.0.1:$MEM_KERNEL/v1/pty/sessions" -H 'content-type: application/json' \
    -H "Authorization: Bearer $MEMKTOKEN" -H 'x-principal-id: p0-2-foreign' \
    -d "{\"context_id\":\"$FBCTX\",\"workspace_id\":\"$FBWS\",\"label\":\"foreign\",\"purpose\":\"authz test\",\"preset\":\"sh\",\"cwd\":\".\"}" \
    | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{const j=JSON.parse(d);console.log(j.pty_session_id||'')})")
  MPWS=$(BAPI -X POST "http://127.0.0.1:$MEM_WEB/v1/projects/$MP/workspaces" -d '{"kind":"scratch","name":"s"}' \
    | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{const j=JSON.parse(d);console.log(j.workspace_id||'')})")
  MPCTX=$(BAPI "http://127.0.0.1:$MEM_WEB/v1/pty/contexts?project_id=$MP" \
    | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{const a=JSON.parse(d);console.log((Array.isArray(a)?a:[]).find(x=>x.context_kind==='research')?.context_id||'')})")
  PTY_OPEN_MP=$(curl -s -X POST "http://127.0.0.1:$MEM_WEB/v1/pty/sessions" -H 'content-type: application/json' \
    -H "Authorization: Bearer $TOKEN" \
    -d "{\"context_id\":\"$MPCTX\",\"workspace_id\":\"$MPWS\",\"label\":\"member\",\"purpose\":\"authz test\",\"preset\":\"sh\",\"cwd\":\".\"}")
  PTY_MP=$(printf '%s' "$PTY_OPEN_MP" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{const j=JSON.parse(d);console.log(j.pty_session_id||'')})")
  PTY_LEASE_MP=$(printf '%s' "$PTY_OPEN_MP" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{const j=JSON.parse(d);console.log(j.lease_token||'')})")
  PTY_GEN_MP=$(printf '%s' "$PTY_OPEN_MP" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{const j=JSON.parse(d);console.log(j.generation||'')})")
  [ -n "$PTY_FB" ] && ok "P0-2: foreign pty session opened on kernel ($PTY_FB)" || fail "P0-2: foreign pty open"
  [ -n "$PTY_MP" ] && [ -n "$PTY_LEASE_MP" ] && ok "P0-2: member pty session opened via BFF ($PTY_MP)" || fail "P0-2: member pty open ($(printf '%s' "$PTY_OPEN_MP" | head -c 160))"
  R=$(curl -s -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $TOKEN" "http://127.0.0.1:$MEM_WEB/v1/pty/sessions/$PTY_FB")
  [ "$R" = "404" ] && ok "P0-2: non-member pty session read -> 404" || fail "P0-2: non-member pty read -> $R"
  R=$(curl -s -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $TOKEN" -H "x-pty-lease: $PTY_LEASE_MP" "http://127.0.0.1:$MEM_WEB/v1/pty/sessions/$PTY_MP?expected_generation=$PTY_GEN_MP")
  [ "$R" = "200" ] && ok "P0-2: member pty session read -> 200" || fail "P0-2: member pty read -> $R"
  R=$(curl -s -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $TOKEN" "http://127.0.0.1:$MEM_WEB/v1/pty/sessions/pty_does_not_exist")
  [ "$R" = "404" ] && ok "P0-2: guessed pty session id -> 404" || fail "P0-2: guessed pty -> $R"
  R=$(curl -s -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \
    -H "x-pty-lease: $PTY_LEASE_MP" \
    -X POST "http://127.0.0.1:$MEM_WEB/v1/pty/sessions/$PTY_MP/control" \
    -d "{\"client_seq\":1,\"expected_generation\":$PTY_GEN_MP,\"type\":\"bytes\",\"payload\":{\"text\":\"ls\\n\",\"byte_length\":3}}")
  [ "$R" = "200" ] && ok "P0-2: member pty control with lease through BFF -> 200" || fail "P0-2: member pty control -> $R"
  R=$(curl -s -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \
    -X POST "http://127.0.0.1:$MEM_WEB/v1/pty/sessions/$PTY_MP/control" \
    -d "{\"client_seq\":2,\"expected_generation\":$PTY_GEN_MP,\"type\":\"bytes\",\"payload\":{\"text\":\"x\",\"byte_length\":1}}")
  [ "$R" = "403" ] && ok "P0-2: pty control without lease via BFF -> 403 (kernel lease_required)" || fail "P0-2: pty control no-lease -> $R"
  # Global events: project-scoped through the BFF; no scope -> 404 fail-closed.
  R=$(curl -s -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $TOKEN" "http://127.0.0.1:$MEM_WEB/v1/events?project_id=$FB")
  [ "$R" = "404" ] && ok "P0-2: foreign project events -> 404" || fail "P0-2: foreign events -> $R"
  R=$(curl -s -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $TOKEN" "http://127.0.0.1:$MEM_WEB/v1/events?project_id=$MP")
  [ "$R" = "200" ] && ok "P0-2: member project events -> 200" || fail "P0-2: member events -> $R"
  R=$(curl -s -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $TOKEN" "http://127.0.0.1:$MEM_WEB/v1/events")
  [ "$R" = "404" ] && ok "P0-2: unscoped global events -> 404 fail-closed" || fail "P0-2: unscoped events -> $R"
  # Revocation is IMMEDIATE: a fresh member BFF reads the project + its
  # documents, then the member is removed on the kernel and the SAME BFF
  # answers 404 on the next request (membership is never cached).
  R=$(curl -s -o /dev/null -w '%{http_code}' -H 'content-type: application/json' -H "Authorization: Bearer $MEMKTOKEN" \
    -X POST "http://127.0.0.1:$MEM_KERNEL/v1/projects/$MP/members" \
    -d '{"principal_id":"p0-2-role","role":"researcher","actor":"ops-1"}')
  [ "$R" = "200" ] && ok "P0-2: p0-2-role member added" || fail "P0-2: add member p0-2-role -> $R"
  REV_WEB=$((MEM_WEB + 6))
  node "$SERVER_BIN" --host 127.0.0.1 --port "$REV_WEB" --kernel-port "$MEM_KERNEL" \
    --kernel-data-dir "$MEM_DATA" --data-dir "$MEM_DATA" --principal p0-2-role > "$WORK/revoke.log" 2>&1 &
  REV_PID=$!
  for _ in $(seq 1 60); do
    if curl -sf -m 2 -X POST "http://127.0.0.1:$REV_WEB/api/token-check" -H 'content-type: application/json' -d "{\"token\":\"$TOKEN\"}" > /dev/null 2>&1; then break; fi
    sleep 0.5
  done
  R=$(curl -s -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $TOKEN" "http://127.0.0.1:$REV_WEB/v1/projects/$MP")
  [ "$R" = "200" ] && ok "P0-2: member p0-2-role reads project -> 200" || fail "P0-2: p0-2-role read -> $R"
  R=$(curl -s -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $TOKEN" "http://127.0.0.1:$REV_WEB/v1/documents/$DOC_MP/tree")
  [ "$R" = "200" ] && ok "P0-2: member p0-2-role reads project document -> 200" || fail "P0-2: p0-2-role doc -> $R"
  R=$(curl -s -o /dev/null -w '%{http_code}' -H 'content-type: application/json' -H "Authorization: Bearer $MEMKTOKEN" \
    -X DELETE "http://127.0.0.1:$MEM_KERNEL/v1/projects/$MP/members/p0-2-role" -d '{"actor":"ops-1"}')
  [ "$R" = "200" ] && ok "P0-2: p0-2-role member removed on kernel" || fail "P0-2: remove member -> $R"
  R=$(curl -s -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $TOKEN" "http://127.0.0.1:$REV_WEB/v1/projects/$MP")
  [ "$R" = "404" ] && ok "P0-2: revoked member read -> 404 on the very next request (no stale cache)" || fail "P0-2: revoked read -> $R"
  R=$(curl -s -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $TOKEN" "http://127.0.0.1:$REV_WEB/v1/documents/$DOC_MP/tree")
  [ "$R" = "404" ] && ok "P0-2: revoked member document read -> 404 (global-id route too)" || fail "P0-2: revoked doc -> $R"
  kill "$REV_PID" 2>/dev/null || true
  ok "P0-2: revocation BFF cleaned up"
fi

kill ${VROLE_PID:-} ${RROLE_PID:-} ${AROLE_PID:-} "$MEM_PID" "$MEM2_PID" 2>/dev/null || true
for _ in $(seq 1 15); do
  if ! ss -ltn 2>/dev/null | grep -qE ":$MEM_WEB |:$((MEM_WEB + 2)) |:$((MEM_WEB + 3)) |:$((MEM_WEB + 4)) |:$((MEM_WEB + 5)) "; then break; fi
  sleep 0.5
done
ok "API-01: BFF instances cleaned up"

# ── §9: legacy DSH bridge paths must 404 (no SPA/v1 fallback) ─────────────
for PTH in /research-api /research-ui-api /research-api/anything /research-ui-api/x /research-ui-api/v1/projects; do
  R=$(curl -s -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $TOKEN" "http://127.0.0.1:$WEB_PORT$PTH")
  [ "$R" = "404" ] && ok "SEC: $PTH -> 404" || fail "SEC: $PTH -> $R"
  # Must be a real JSON 404 — never the SPA bootstrap HTML and never a
  # fallback to the /v1 kernel proxy (which would answer 200/401/502).
  BODY=$(curl -s -H "Authorization: Bearer $TOKEN" "http://127.0.0.1:$WEB_PORT$PTH")
  case "$BODY" in
    *'"ok":false'*|*'"error"'*) ok "SEC: $PTH body is a JSON error (not SPA fallback)" ;;
    *) fail "SEC: $PTH body is not a JSON 404: ${BODY:0:60}" ;;
  esac
done
# POST on the legacy bridge paths must also 404 (no accidental proxy).
R=$(curl -s -o /dev/null -w '%{http_code}' -X POST -H "Authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' -d '{}' "http://127.0.0.1:$WEB_PORT/research-api/projects")
[ "$R" = "404" ] && ok "SEC: POST /research-api/projects -> 404" || fail "SEC: POST /research-api -> $R"

# ── §9.1: the standalone token must never reach the kernel argv ────────────
KPID_BY_PORT=$(ss -ltnp 2>/dev/null | grep ":$KERNEL_PORT " | grep -oP 'pid=\K[0-9]+' | head -1)
if [ -n "$KPID_BY_PORT" ]; then
  if tr '\0' ' ' < "/proc/$KPID_BY_PORT/cmdline" 2>/dev/null | grep -q "$TOKEN"; then
    fail "SEC: standalone token leaked into kernel argv"
  else
    ok "SEC: token absent from kernel argv"
  fi
else
  fail "SEC: kernel pid not found for argv check"
fi

# ── §9.1: the token must never be written to the server log ────────────────
if grep -q "$TOKEN" "$LOG" 2>/dev/null; then
  fail "SEC: standalone token leaked into server log"
else
  ok "SEC: token absent from server log"
fi

# ── API-01/v2: Idempotency-Key + X-Request-Id pass through the proxy ──────
R=$(curl -s -o /dev/null -w '%{http_code}' -X POST -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -H 'idempotency-key: v2-proxy-idem-1' -H 'x-request-id: req_proxy_1' \
  "http://127.0.0.1:$WEB_PORT/v2/projects" \
  -d '{"name":"v2-rt","workspace":"/w/v2rt","mode":"gate-only","creator_principal_id":"ops-1","brief":{"problem":"p","scope":"s","questions":[],"primary_metrics":["m"],"resources":"","risks":[],"target_outputs":["paper"],"target_venue":null,"baseline_repo":null,"domain":"ml"}}')
[ "$R" = "201" ] && ok "API-01: v2 create via proxy (idem-key forwarded) -> 201" || fail "API-01: v2 create via proxy -> $R"
R=$(curl -s -o /dev/null -w '%{http_code}' -X POST -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -H 'idempotency-key: v2-proxy-idem-1' \
  "http://127.0.0.1:$WEB_PORT/v2/projects" \
  -d '{"name":"v2-rt","workspace":"/w/v2rt","mode":"gate-only","creator_principal_id":"ops-1","brief":{"problem":"p","scope":"s","questions":[],"primary_metrics":["m"],"resources":"","risks":[],"target_outputs":["paper"],"target_venue":null,"baseline_repo":null,"domain":"ml"}}')
[ "$R" = "201" ] && ok "API-01: v2 idempotent replay via proxy -> 201" || fail "API-01: v2 replay -> $R"

# ── SEC-UI-01: stable error codes (no connector URL / internal paths) ───────
# Survey on a nonexistent project WITH a principal: the BFF answers 404
# fail-closed BEFORE the connector runs — the body never echoes internal
# detail.
BODY=$(curl -s -X POST "http://127.0.0.1:$WEB_PORT/api/chat/survey" \
  -H "Authorization: Bearer $TOKEN" -H "x-csrf-token: $CSRF" -H "Origin: http://127.0.0.1:$WEB_PORT" \
  -H 'content-type: application/json' -d '{"project_id":"rsp_nonexistent","query":"temporal action localization"}' -m 90)
case "$BODY" in
  *'"ok":false'*'project not found or access denied'*) ok "SEC: survey 404 fail-closed body is generic" ;;
  *) fail "SEC: survey fail-closed body -> $BODY" ;;
esac
BODY=$(curl -s -H "Authorization: Bearer $TOKEN" "http://127.0.0.1:$WEB_PORT/v1/projects/rsp_nonexistent")
case "$BODY" in
  *'"code"'*'"message"'*) ok "SEC: proxy 404 body is structured and generic" ;;
  *) fail "SEC: proxy 404 body -> $BODY" ;;
esac
for NEEDLE in '/home/' '/dev/' '/usr/' 'http://' 'https://' 'env' ' at '; do
  if printf '%s' "$BODY" | grep -qF "$NEEDLE"; then
    fail "SEC: error body leaks '$NEEDLE' -> $BODY"
  else
    ok "SEC: error body has no '$NEEDLE'"
  fi
done

# ── OPS-01: clean shutdown frees both ports ────────────────────────────────
kill "$SPID" 2>/dev/null || true
for _ in $(seq 1 20); do
  if ! ss -ltn 2>/dev/null | grep -qE ":$WEB_PORT |:$KERNEL_PORT "; then break; fi
  sleep 0.5
done
if ss -ltn 2>/dev/null | grep -qE ":$WEB_PORT |:$KERNEL_PORT "; then
  fail "OPS: ports still bound after kill"
  kill_test_servers
else
  ok "OPS: kill frees web+kernel ports"
fi

# ── OPS-01: startup failure on occupied port -> non-zero + log tail ────────
CONFLICT_PORT=$((WEB_PORT + 500))
node -e "require('node:net').createServer().listen($CONFLICT_PORT, '127.0.0.1', () => { setTimeout(() => process.exit(0), 15000) })" &
BLOCKER=$!
sleep 0.7
FLOG="$WORK/fail.log"
if node "$SERVER_BIN" --host 127.0.0.1 --port "$CONFLICT_PORT" --kernel-port "$((CONFLICT_PORT + 1))" \
  --kernel-data-dir "$WORK/faildata" --data-dir "$WORK/faildata" > "$FLOG" 2>&1; then
  fail "OPS: occupied port did NOT fail"
else
  ok "OPS: occupied port exits non-zero"
  if grep -qiE "EADDRINUSE|listen.*EADDRINUSE|address already in use" "$FLOG"; then
    ok "OPS: log tail reports the bind failure"
  else
    fail "OPS: log lacks bind failure detail (got: $(tail -2 "$FLOG" | tr '\n' ' '))"
  fi
fi
kill "$BLOCKER" 2>/dev/null || true

# ── SEC-UI-01: --no-token on non-loopback rejected ─────────────────────────
# §9.1: --no-token accepts ONLY localhost / ::1 / 127.0.0.0/8. Every
# non-loopback combination (wildcard, LAN, hostname) must fail in loadOptions
# BEFORE listen — nothing may bind.
for BAD_HOST in 0.0.0.0 192.168.1.9 10.0.0.5 example.test; do
  NLOG="$WORK/notoken-$BAD_HOST.log"
  if node "$SERVER_BIN" --host "$BAD_HOST" --port "$((CONFLICT_PORT + 100))" --kernel-port "$((CONFLICT_PORT + 101))" \
    --kernel-data-dir "$WORK/ntdata-$BAD_HOST" --data-dir "$WORK/ntdata-$BAD_HOST" --no-token > "$NLOG" 2>&1; then
    fail "SEC: --no-token on $BAD_HOST accepted"
  else
    ok "SEC: --no-token on $BAD_HOST rejected before listen"
  fi
  R=$(curl -s -o /dev/null -w '%{http_code}' -m 2 "http://127.0.0.1:$((CONFLICT_PORT + 100))/" 2>/dev/null || true)
  [ "$R" = "000" ] && ok "SEC: rejected $BAD_HOST server not listening" || fail "SEC: rejected $BAD_HOST server responded $R"
done
# Loopback 127.0.0.0/8 outside 127.0.0.1 stays allowed with --no-token.
NLOG="$WORK/notoken-lo.log"
node "$SERVER_BIN" --host 127.0.0.2 --port "$((CONFLICT_PORT + 100))" --kernel-port "$((CONFLICT_PORT + 101))" \
  --kernel-data-dir "$WORK/ntdata-lo" --data-dir "$WORK/ntdata-lo" --no-token > "$NLOG" 2>&1 &
NOTOKEN_PID=$!
sleep 1
if kill -0 "$NOTOKEN_PID" 2>/dev/null; then
  ok "SEC: --no-token on 127.0.0.2 (127/8) accepted"
else
  fail "SEC: --no-token on 127.0.0.2 rejected (log: $(tail -2 "$NLOG" | tr '\n' ' '))"
fi
kill "$NOTOKEN_PID" 2>/dev/null || true

# ── SEC-UI-01: start-standalone-ui.sh --no-token host combos ────────────────
# §9.1: the SUPPORTED launcher must fail the same way before anything binds,
# with a stable error message that contains no internal path.
for BAD_HOST in 0.0.0.0 192.168.1.9 example.test; do
  SLOG="$WORK/script-nt-$BAD_HOST.log"
  if DSH_SCHOLAR_STANDALONE_PORT="$((CONFLICT_PORT + 110))" DSH_SCHOLAR_STANDALONE_KERNEL_PORT="$((CONFLICT_PORT + 111))" \
      DSH_SCHOLAR_KERNEL_DATA="$WORK/script-ntdata-$BAD_HOST/kernel" \
      DSH_SCHOLAR_STANDALONE_DATA="$WORK/script-ntdata-$BAD_HOST" \
      bash "$REPO/scripts/start-standalone-ui.sh" --host "$BAD_HOST" --no-token > "$SLOG" 2>&1; then
    fail "SEC: script --no-token on $BAD_HOST accepted"
  else
    ok "SEC: script --no-token on $BAD_HOST fails non-zero"
  fi
  if grep -q "loopback" "$SLOG"; then
    ok "SEC: script $BAD_HOST error names the loopback requirement"
  else
    fail "SEC: script $BAD_HOST error message (got: $(tail -3 "$SLOG" | tr '\n' ' '))"
  fi
  if grep -qE "/home/|/dev/|/usr/|\.ts[0-9]?:" "$SLOG"; then
    fail "SEC: script $BAD_HOST error leaks an internal path"
  else
    ok "SEC: script $BAD_HOST error has no internal path"
  fi
  R=$(curl -s -o /dev/null -w '%{http_code}' -m 2 "http://127.0.0.1:$((CONFLICT_PORT + 110))/" 2>/dev/null || true)
  [ "$R" = "000" ] && ok "SEC: script rejected $BAD_HOST not listening" || fail "SEC: script rejected $BAD_HOST responded $R"
done

# ── SEC-UI-01: script --no-token on loopback starts and readies ─────────────
SLOOP_WEB=$((CONFLICT_PORT + 120))
SLOOP_KERNEL=$((CONFLICT_PORT + 121))
SLOOP_DATA="$WORK/script-lo-data"
if DSH_SCHOLAR_KERNEL_DATA="$SLOOP_DATA/kernel" DSH_SCHOLAR_STANDALONE_DATA="$SLOOP_DATA" \
    bash "$REPO/scripts/start-standalone-ui.sh" --host 127.0.0.1 --port "$SLOOP_WEB" --kernel-port "$SLOOP_KERNEL" \
    --data-dir "$SLOOP_DATA/research-ui-standalone" --no-token > "$WORK/script-lo.log" 2>&1; then
  ok "SEC: script --no-token on 127.0.0.1 exits 0 after readiness"
else
  fail "SEC: script --no-token loopback did not become ready (log: $(tail -3 "$WORK/script-lo.log" | tr '\n' ' '))"
fi
SLOOP_PID=$(ss -ltnp 2>/dev/null | grep ":$SLOOP_WEB " | grep -oP 'pid=\K[0-9]+' | head -1 || true)
if [ -n "$SLOOP_PID" ]; then
  kill "$SLOOP_PID" 2>/dev/null || true
  for _ in $(seq 1 15); do
    if ! ss -ltn 2>/dev/null | grep -qE ":$SLOOP_WEB |:$SLOOP_KERNEL "; then break; fi
    sleep 0.5
  done
  ok "SEC: script --no-token instance cleaned up"
else
  fail "SEC: script --no-token server pid not found for cleanup"
  kill_test_servers
fi

# ── SEC-UI-01: script rejects secret argv; managed file stays authoritative ─
# §9.1: token mode reads a pre-provisioned/server-generated 0600 file. The
# launcher must reject secret argv rather than retaining a compatibility shim.
SECRET="secret-token-xyz-$(date +%s)"
SWEB=$((CONFLICT_PORT + 130))
SKERNEL=$((CONFLICT_PORT + 131))
SDATA="$WORK/script-tok-data"
if DSH_SCHOLAR_KERNEL_DATA="$SDATA/kernel" DSH_SCHOLAR_STANDALONE_DATA="$SDATA" \
    bash "$REPO/scripts/start-standalone-ui.sh" --host 127.0.0.1 --port "$SWEB" --kernel-port "$SKERNEL" \
    --data-dir "$SDATA/research-ui-standalone" --token "$SECRET" > "$WORK/script-token-reject.log" 2>&1; then
  fail "SEC: obsolete script --token was accepted"
else
  ok "SEC: obsolete script --token is rejected"
fi
if grep -q "$SECRET" "$WORK/script-token-reject.log" 2>/dev/null; then
  fail "SEC: launcher echoed the token in its own output"
else
  ok "SEC: launcher output does not contain the token"
fi

seed_standalone_token "$SDATA/research-ui-standalone" "$SECRET"
if DSH_SCHOLAR_KERNEL_DATA="$SDATA/kernel" DSH_SCHOLAR_STANDALONE_DATA="$SDATA" \
    bash "$REPO/scripts/start-standalone-ui.sh" --host 127.0.0.1 --port "$SWEB" --kernel-port "$SKERNEL" \
    --data-dir "$SDATA/research-ui-standalone" > "$WORK/script-tok.log" 2>&1; then
  ok "SEC: script starts from the pre-provisioned 0600 token file"
else
  fail "SEC: managed-file token startup failed (log: $(tail -3 "$WORK/script-tok.log" | tr '\n' ' '))"
fi
if grep -q "$SECRET" "$SDATA/standalone.log" 2>/dev/null; then
  fail "SEC: token leaked into standalone.log"
else
  ok "SEC: standalone.log does not contain the token"
fi
[ "$(stat -c %a "$SDATA/research-ui-standalone/standalone-token" 2>/dev/null || echo '?')" = "600" ] \
  && ok "SEC: managed token file remains 0600" || fail "SEC: script token file mode"
[ "$(tr -d '\n' < "$SDATA/research-ui-standalone/standalone-token")" = "$SECRET" ] \
  && ok "SEC: launcher preserves the pre-provisioned token" || fail "SEC: script token file mismatch"
R=$(curl -s -o /dev/null -w '%{http_code}' -X POST "http://127.0.0.1:$SWEB/api/token-check" -H 'content-type: application/json' -d "{\"token\":\"$SECRET\"}")
[ "$R" = "200" ] && ok "SEC: script-started server accepts the token" || fail "SEC: script token-check -> $R"
for PORT in "$SWEB" "$SKERNEL"; do
  PID=$(ss -ltnp 2>/dev/null | grep ":$PORT " | grep -oP 'pid=\K[0-9]+' | head -1 || true)
  if [ -z "$PID" ]; then
    fail "SEC: no pid found on port $PORT for argv scan"
    continue
  fi
  if tr '\0' ' ' < "/proc/$PID/cmdline" 2>/dev/null | grep -q "$SECRET"; then
    fail "SEC: token leaked into argv of pid $PID (port $PORT)"
  else
    ok "SEC: token absent from argv of pid $PID (port $PORT)"
  fi
done
# Cleanup the script-started instance (setsid process group).
SWEB_PID=$(ss -ltnp 2>/dev/null | grep ":$SWEB " | grep -oP 'pid=\K[0-9]+' | head -1 || true)
if [ -n "$SWEB_PID" ]; then
  kill -- "-$SWEB_PID" 2>/dev/null || kill "$SWEB_PID" 2>/dev/null || true
  for _ in $(seq 1 15); do
    if ! ss -ltn 2>/dev/null | grep -qE ":$SWEB |:$SKERNEL "; then break; fi
    sleep 0.5
  done
  ok "SEC: script token instance cleaned up"
else
  fail "SEC: script token server pid not found for cleanup"
  kill_test_servers
fi

# ── GOV-01: session-derived principal resolver (x-principal-session) ────────
# The BFF derives a DURABLE operator session (session.json, 0600) from the
# bearer credential and forwards x-principal-session; a gate decision made
# through the BFF must record that session_id, and the session file must be
# stable across calls (restart persistence by construction — deterministic).
echo "== GOV-01: session-derived principal resolver =="
SPRINC_WEB=$((WEB_PORT + 900))
SPRINC_KERNEL=$((WEB_PORT + 901))
SPRINC_DATA="$WORK/sprinc-data"
seed_standalone_token "$SPRINC_DATA" "$TOKEN"
node "$SERVER_BIN" --host 127.0.0.1 --port "$SPRINC_WEB" --kernel-port "$SPRINC_KERNEL" \
  --kernel-data-dir "$SPRINC_DATA" --data-dir "$SPRINC_DATA" --principal sprinc-ops > "$WORK/sprinc.log" 2>&1 &
SPRINC_PID=$!
sprinc_ready=0
for _ in $(seq 1 60); do
  if curl -sf -m 2 -X POST "http://127.0.0.1:$SPRINC_WEB/api/token-check" -H 'content-type: application/json' -d "{\"token\":\"$TOKEN\"}" > /dev/null 2>&1; then sprinc_ready=1; break; fi
  sleep 0.5
done
[ "$sprinc_ready" = 1 ] && ok "GOV-01: BFF with --principal sprinc-ops starts" || fail "GOV-01: BFF start"
if [ "$sprinc_ready" = 1 ]; then
  SPRINC_CSRF=$(curl -s -H "Authorization: Bearer $TOKEN" "http://127.0.0.1:$SPRINC_WEB/api/session/csrf" \
    | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{const j=JSON.parse(d);console.log(j.csrf_token||'')})")
  [ -n "$SPRINC_CSRF" ] && ok "GOV-01: Human BFF CSRF token issued" || fail "GOV-01: Human BFF CSRF token missing"
  SP=$(curl -s -H "Authorization: Bearer $TOKEN" -H "Origin: http://127.0.0.1:$SPRINC_WEB" -H 'content-type: application/json' -X POST "http://127.0.0.1:$SPRINC_WEB/v1/projects" \
    -d '{"name":"sprinc","workspace":"/w","mode":"gate-only","creator_principal_id":"sprinc-ops","brief":{"problem":"p","scope":"s","questions":[],"primary_metrics":["m"],"resources":"","risks":[],"target_outputs":["paper"],"target_venue":null,"baseline_repo":null,"domain":"ml"}}' \
    | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>console.log(JSON.parse(d).project_id||''))")
  SG=$(curl -s -H "Authorization: Bearer $TOKEN" -H "Origin: http://127.0.0.1:$SPRINC_WEB" -H 'content-type: application/json' -X POST "http://127.0.0.1:$SPRINC_WEB/v1/projects/$SP/gates" -d '{"type":"scope","title":"sprinc gate"}' \
    | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>console.log(JSON.parse(d).gate_id||''))")
  DEC_BODY=$(curl -s -w '\n%{http_code}' -H "Authorization: Bearer $TOKEN" -H "x-csrf-token: $SPRINC_CSRF" -H "Origin: http://127.0.0.1:$SPRINC_WEB" -H 'content-type: application/json' -X POST "http://127.0.0.1:$SPRINC_WEB/bff/research/gates/$SG/decision" \
    -d '{"decision":"approved"}')
  CODE=$(printf '%s' "$DEC_BODY" | tail -1)
  [ "$CODE" = "200" ] && ok "GOV-01: gate decision through BFF -> 200" || fail "GOV-01: decision -> $CODE body=$(printf '%s' "$DEC_BODY" | head -c 200)"
  SESS=$(curl -s -H "Authorization: Bearer $TOKEN" "http://127.0.0.1:$SPRINC_WEB/v1/projects/$SP/decisions" \
    | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{const a=JSON.parse(d);console.log(a[0]?.principal?.session_id||'')})")
  [ -n "$SESS" ] && [ "${SESS#sess_}" != "$SESS" ] && ok "GOV-01: decision records session_id=$SESS (durable principal)" || fail "GOV-01: session_id missing -> '$SESS'"
  SESS_FILE="$SPRINC_DATA/session.json"
  [ -f "$SESS_FILE" ] && [ "$(stat -c %a "$SESS_FILE")" = "600" ] && ok "GOV-01: session.json exists 0600" || fail "GOV-01: session.json missing/wrong mode"
  FILE_SESS=$(node -e "console.log(JSON.parse(require('fs').readFileSync('$SESS_FILE','utf8')).session_id||'')" 2>/dev/null)
  [ -n "$FILE_SESS" ] && [ "$FILE_SESS" = "$SESS" ] && ok "GOV-01: forwarded session matches session.json (stable identity)" || fail "GOV-01: session mismatch file=$FILE_SESS forwarded=$SESS"

  # ── API-01/GOV-01 (hardening §4 P0): client-forged identity is rewritten ──
  # A gate decision whose body claims a foreign actor/principal/tenant/session
  # must be recorded with the SESSION-derived principal: the BFF rewrites
  # actor→sprinc-ops, principal→{principal_id:sprinc-ops,tenant_id:null,
  # auth_method:dsh-session,session_id:<real>} and drops the forged top-level
  # session_id (the kernel then binds the forwarded x-principal-session).
  FG=$(curl -s -H "Authorization: Bearer $TOKEN" -H "Origin: http://127.0.0.1:$SPRINC_WEB" -H 'content-type: application/json' \
    -X POST "http://127.0.0.1:$SPRINC_WEB/v1/projects/$SP/gates" -d '{"type":"scope","title":"forged identity gate"}' \
    | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>console.log(JSON.parse(d).gate_id||''))")
  [ -n "$FG" ] && ok "GOV-01: forgery gate created ($FG)" || fail "GOV-01: forgery gate create"
  FDEC=$(curl -s -w '\n%{http_code}' -H "Authorization: Bearer $TOKEN" -H "x-csrf-token: $SPRINC_CSRF" -H "Origin: http://127.0.0.1:$SPRINC_WEB" -H 'content-type: application/json' \
    -X POST "http://127.0.0.1:$SPRINC_WEB/bff/research/gates/$FG/decision" \
    -d '{"actor":"evil-actor","principal":{"principal_id":"evil","tenant_id":"evil-tenant","auth_method":"forged","session_id":"sess_forged"},"session_id":"sess_forged","decision":"approved"}')
  CODE=$(printf '%s' "$FDEC" | tail -1)
  [ "$CODE" = "200" ] && ok "GOV-01: forged-identity decision accepted (identity rewritten by BFF) -> 200" || fail "GOV-01: forged decision -> $CODE body=$(printf '%s' "$FDEC" | head -c 200)"
  FROW=$(curl -s -H "Authorization: Bearer $TOKEN" "http://127.0.0.1:$SPRINC_WEB/v1/projects/$SP/decisions" \
    | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{const a=JSON.parse(d);const r=a.find(x=>x.gate_id==='$FG');console.log(JSON.stringify(r||{}))})")
  SESS_PAT="\"session_id\":\"$SESS\""
  case "$FROW" in
    *'"actor":"sprinc-ops"'*'"principal_id":"sprinc-ops"'*'"tenant_id":""'*'"auth_method":"dsh-session"'*"$SESS_PAT"*)
      ok "GOV-01: forged actor/principal/tenant/session rewritten to session identity" ;;
    *) fail "GOV-01: forged decision row -> $FROW" ;;
  esac
  case "$FROW" in
    *'evil'*|*'sess_forged'*) fail "GOV-01: forged identity leaked into decision -> $FROW" ;;
    *) ok "GOV-01: no forged identity in decision row" ;;
  esac
  # A project CREATE claiming a foreign creator/tenant: the BFF rewrites
  # creator_principal_id to the session principal and drops creator_tenant_id,
  # so the kernel seeds sprinc-ops (never the forged PI) as the pi member.
  PF=$(curl -s -H "Authorization: Bearer $TOKEN" -H "Origin: http://127.0.0.1:$SPRINC_WEB" -H 'content-type: application/json' \
    -X POST "http://127.0.0.1:$SPRINC_WEB/v1/projects" \
    -d '{"name":"forged-create","workspace":"/w/forged","mode":"gate-only","creator_principal_id":"evil-pi","creator_tenant_id":"evil-tenant","brief":{"problem":"p","scope":"s","questions":[],"primary_metrics":["m"],"resources":"","risks":[],"target_outputs":["paper"],"target_venue":null,"baseline_repo":null,"domain":"ml"}}' \
    | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>console.log(JSON.parse(d).project_id||''))")
  [ -n "$PF" ] && ok "GOV-01: forged-creator v1 create -> project $PF" || fail "GOV-01: forged-creator v1 create"
  MEMS=$(curl -s -H "Authorization: Bearer $TOKEN" "http://127.0.0.1:$SPRINC_WEB/v1/projects/$PF/members" \
    | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{const a=JSON.parse(d);console.log(a.map(m=>m.principal_id+':'+m.role).join(','))})")
  [ "$MEMS" = "sprinc-ops:pi" ] && ok "GOV-01: creator membership seeded from session (sprinc-ops:pi, not evil-pi)" || fail "GOV-01: forged creator membership -> '$MEMS'"
  # v2 create with the same forged creator/tenant: 201, membership from session.
  V2BODY=$(curl -s -X POST -H "Authorization: Bearer $TOKEN" -H "Origin: http://127.0.0.1:$SPRINC_WEB" -H 'content-type: application/json' \
    -H 'idempotency-key: v2-forge-1' \
    "http://127.0.0.1:$SPRINC_WEB/v2/projects" \
    -d '{"name":"v2-forged","workspace":"/w/v2forged","mode":"gate-only","creator_principal_id":"evil-pi","creator_tenant_id":"evil-tenant","brief":{"problem":"p","scope":"s","questions":[],"primary_metrics":["m"],"resources":"","risks":[],"target_outputs":["paper"],"target_venue":null,"baseline_repo":null,"domain":"ml"}}')
  case "$V2BODY" in
    *'"principal_id":"sprinc-ops"'*'"role":"pi"'*) ok "GOV-01: v2 create membership from session (sprinc-ops:pi)" ;;
    *) fail "GOV-01: v2 create membership -> $(printf '%s' "$V2BODY" | head -c 200)" ;;
  esac
  case "$V2BODY" in
    *'evil'*) fail "GOV-01: v2 forged creator leaked -> $(printf '%s' "$V2BODY" | head -c 200)" ;;
    *) ok "GOV-01: v2 create carries no forged identity" ;;
  esac
  kill_test_servers
fi

# ── DATA-UPGRADE-01/GOV-01: default token startup derives one stable local ─
# Principal from the protected shared sidecar credential. The browser cannot
# submit or override it, and projects created through this entry point remain
# visible after switching between standalone and the DSH plugin.
echo "== DATA-UPGRADE-01: stable server-derived principal (default token startup) =="
FC_WEB=$((WEB_PORT + 800))
FC_KERNEL=$((WEB_PORT + 801))
FC_DATA="$WORK/fc-data"
seed_standalone_token "$FC_DATA" "$TOKEN"
node "$SERVER_BIN" --host 127.0.0.1 --port "$FC_WEB" --kernel-port "$FC_KERNEL" \
  --kernel-data-dir "$FC_DATA" --data-dir "$FC_DATA" > "$WORK/fc.log" 2>&1 &
FC_PID=$!
fcready=0
for _ in $(seq 1 60); do
  if curl -sf -m 2 -X POST "http://127.0.0.1:$FC_WEB/api/token-check" -H 'content-type: application/json' -d "{\"token\":\"$TOKEN\"}" > /dev/null 2>&1; then fcready=1; break; fi
  sleep 0.5
done
[ "$fcready" = 1 ] && ok "FC: default token startup derives a stable server-side principal" || fail "FC: default startup readiness (log: $(tail -3 "$WORK/fc.log" | tr '\n' ' '))"
if [ "$fcready" = 1 ]; then
  R=$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$FC_WEB/")
  [ "$R" = "200" ] && ok "FC: GET / bootstrap page (allowlisted) -> 200" || fail "FC: bootstrap -> $R"
  R=$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$FC_WEB/client.js")
  [ "$R" = "200" ] && ok "FC: GET /client.js static bundle (allowlisted) -> 200" || fail "FC: client.js -> $R"
  R=$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$FC_WEB/favicon.ico")
  [ "$R" = "204" ] && ok "FC: GET /favicon.ico static (allowlisted) -> 204" || fail "FC: favicon -> $R"
  R=$(curl -s -o /dev/null -w '%{http_code}' -X POST "http://127.0.0.1:$FC_WEB/api/token-check" -H 'content-type: application/json' -d "{\"token\":\"$TOKEN\"}")
  [ "$R" = "200" ] && ok "FC: POST /api/token-check (allowlisted) -> 200" || fail "FC: token-check -> $R"
  FC_CSRF_BODY=$(curl -s -H "Authorization: Bearer $TOKEN" "http://127.0.0.1:$FC_WEB/api/session/csrf")
  FC_CSRF=$(printf '%s' "$FC_CSRF_BODY" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>console.log(JSON.parse(d).csrf_token||''))")
  R=$([ -n "$FC_CSRF" ] && printf 200 || printf 500)
  [ "$R" = "200" ] && ok "FC: GET /api/session/csrf (allowlisted) -> 200" || fail "FC: csrf -> $R"
  for HEALTH in /v1/health /v2/health; do
    R=$(curl -s -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $TOKEN" "http://127.0.0.1:$FC_WEB$HEALTH")
    [ "$R" = "200" ] && ok "FC: $HEALTH (allowlisted) -> 200" || fail "FC: $HEALTH -> $R"
  done
  R=$(curl -s -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $TOKEN" "http://127.0.0.1:$FC_WEB/v1/projects")
  [ "$R" = "200" ] && ok "FC: stable principal can list its projects" || fail "FC: project list -> $R"
  FC_PROJECT=$(curl -s -H "Authorization: Bearer $TOKEN" -H "x-csrf-token: $FC_CSRF" \
    -H "Origin: http://127.0.0.1:$FC_WEB" -H 'content-type: application/json' \
    -X POST "http://127.0.0.1:$FC_WEB/v1/projects" \
    -d '{"name":"stable-principal-project","workspace":"/w/stable","mode":"gate-only","creator_principal_id":"evil-pi","brief":{"problem":"p","scope":"s","questions":[],"primary_metrics":["m"],"resources":"","risks":[],"target_outputs":["paper"],"target_venue":null,"baseline_repo":null,"domain":"ml"}}' \
    | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>console.log(JSON.parse(d).project_id||''))")
  [ -n "$FC_PROJECT" ] && ok "FC: project create succeeds without explicit --principal" || fail "FC: stable-principal project create"
  FC_MEMBERS=$(curl -s -H "Authorization: Bearer $TOKEN" "http://127.0.0.1:$FC_WEB/v1/projects/$FC_PROJECT/members")
  case "$FC_MEMBERS" in
    *'"principal_id":"dsh:'*'"role":"pi"'*) ok "FC: membership uses credential-derived dsh: principal" ;;
    *) fail "FC: derived principal membership -> $FC_MEMBERS" ;;
  esac
  case "$FC_MEMBERS" in
    *'evil-pi'*) fail "FC: browser-forged creator became a member -> $FC_MEMBERS" ;;
    *) ok "FC: browser cannot override the derived principal" ;;
  esac
  FC_LIST=$(curl -s -H "Authorization: Bearer $TOKEN" "http://127.0.0.1:$FC_WEB/v1/projects")
  case "$FC_LIST" in
    *"$FC_PROJECT"*) ok "FC: newly created project remains visible to the stable principal" ;;
    *) fail "FC: created project missing from stable-principal list -> $(printf '%s' "$FC_LIST" | head -c 160)" ;;
  esac
  [ -f "$FC_DATA/session.json" ] && ok "FC: operator session is bound to the stable principal" || fail "FC: stable principal session.json missing"
  R=$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$FC_WEB/v1/projects")
  [ "$R" = "401" ] && ok "FC: /v1/projects without token -> 401" || fail "FC: no-token list -> $R"
  kill "$FC_PID" 2>/dev/null || true
  for _ in $(seq 1 15); do
    if ! ss -ltn 2>/dev/null | grep -qE ":$FC_WEB |:$FC_KERNEL "; then break; fi
    sleep 0.5
  done
  ok "FC: stable-principal instance cleaned up"
fi

echo "== standalone http acceptance: $PASS passed, $FAIL failed =="
[ "$FAIL" -eq 0 ] || exit 1
