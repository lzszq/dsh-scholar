#!/usr/bin/env bash
# UPLOAD-01 (hardening §4 P1) HTTP acceptance: real curl -F multipart
# uploads against the kernel AND through the standalone BFF proxy.
#
#   upload-success            curl -F kind/data + file -> 201; artifact GET
#                             round-trips the exact bytes; sha256 is
#                             server-computed (hash binding)
#   upload-idempotent         same project+sha256+filename -> 200 reused:true
#                             (no duplicate artifact row / CAS blob)
#   upload-too-large          33 MiB file -> 413 payload_too_large, no row
#   upload-path-traversal     filename=../.. etc -> 422 invalid_file_name
#   upload-missing-file       no file part -> 422 missing_file
#   upload-invalid-kind       kind=banana -> 422 invalid_kind
#   upload-non-multipart      application/json body -> 415 unsupported_media_type
#   upload-unknown-project    404 project_not_found (no enumeration)
#   bff-upload-passthrough    multipart through the standalone BFF (bearer +
#                             same-origin) -> 201; bytes round-trip
#   bff-upload-idempotent     re-upload through the BFF -> 200 reused:true
#   bff-upload-authz          no bearer -> 401; foreign origin -> 403;
#                             unknown project -> 404
#
# Usage: bash tests/security/run-upload-tests.sh
set -eu

REPO=$(cd "$(dirname "$0")/../.." && pwd)
KERNEL_BIN="$REPO/packages/research-kernel/lib/bin/kernel.js"
SERVER_BIN="$REPO/packages/dsh-research-ui/lib/standalone/server.js"
if [ ! -f "$SERVER_BIN" ]; then
  echo "upload: standalone server not built — run pnpm --filter @dsh-scholar/research-ui build first" >&2
  exit 2
fi
WORK=$(mktemp -d)
PORT=$((20900 + $$ % 300))
PASS=0
FAIL=0
ok() { printf '  ok: %s\n' "$*"; PASS=$((PASS+1)); }
bad() { printf '  FAIL: %s\n' "$*"; FAIL=$((FAIL+1)); }

KERNEL_PID=""
BFF_PID=""
cleanup() {
  [ -n "$BFF_PID" ] && kill "$BFF_PID" 2>/dev/null || true
  [ -n "$KERNEL_PID" ] && kill "$KERNEL_PID" 2>/dev/null || true
  # Kill ONLY the standalone instances this test started (their argv carries
  # the $WORK data dir) — never a user's server.
  for pid in $(pgrep -f "standalone/server.js" 2>/dev/null || true); do
    if tr '\0' ' ' < "/proc/$pid/cmdline" 2>/dev/null | grep -qF "$WORK"; then
      kill "$pid" 2>/dev/null || true
    fi
  done
  rm -rf "$WORK"
}
trap cleanup EXIT

nohup node "$KERNEL_BIN" --db "$WORK/kernel.db" --cas "$WORK/cas" --port "$PORT" > "$WORK/kernel.log" 2>&1 &
KERNEL_PID=$!
for _ in $(seq 1 50); do
  curl -sf "http://127.0.0.1:$PORT/v1/health" > /dev/null 2>&1 && break
  sleep 0.1
done
if ! curl -sf "http://127.0.0.1:$PORT/v1/health" > /dev/null 2>&1; then
  echo "upload: kernel failed to start (see $WORK/kernel.log)" >&2
  exit 2
fi

api() { curl -sf -H 'content-type: application/json' "$@"; }
jqfield() { node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{try{const j=JSON.parse(d);console.log($1)}catch(e){console.log('')}})"; }

BRIEF='{"problem":"p","scope":"s","questions":[],"primary_metrics":["m"],"resources":"","risks":[],"target_outputs":["paper"],"target_venue":null,"baseline_repo":null,"domain":"ml"}'
PROJ=$(api -X POST "http://127.0.0.1:$PORT/v1/projects" -d "{\"name\":\"upload\",\"workspace\":\"/w\",\"brief\":$BRIEF}" | jqfield "j.project_id")
[ -n "$PROJ" ] || { echo "upload: could not create project" >&2; exit 2; }
ok "project $PROJ created"

# ── kernel direct: upload-success ──────────────────────────────────────────
printf 'research upload payload \x00\x01\x02 binary\xff' > "$WORK/payload.bin"
EXPECTED_SHA=$(sha256sum "$WORK/payload.bin" | cut -d' ' -f1)
UPLOAD_JSON=$(curl -s -X POST "http://127.0.0.1:$PORT/v1/projects/$PROJ/uploads" \
  -F "kind=data" -F "file=@$WORK/payload.bin;filename=payload.bin")
ART_ID=$(printf '%s' "$UPLOAD_JSON" | jqfield "j.artifact_id")
ART_SHA=$(printf '%s' "$UPLOAD_JSON" | jqfield "j.sha256")
if [ "$ART_ID" = "sha256:$EXPECTED_SHA" ] && [ "$ART_SHA" = "$EXPECTED_SHA" ]; then
  ok "upload-success: 201 artifact $ART_ID with server-computed sha256 (hash binding)"
else
  bad "upload-success: expected artifact_id sha256:$EXPECTED_SHA, got $ART_ID (sha=$ART_SHA)"
fi

curl -sf "http://127.0.0.1:$PORT/v1/artifacts/$ART_ID?project_id=$PROJ" -o "$WORK/downloaded.bin"
if cmp -s "$WORK/payload.bin" "$WORK/downloaded.bin"; then
  ok "upload-roundtrip: artifact GET returns byte-identical content"
else
  bad "upload-roundtrip: downloaded bytes differ from uploaded bytes"
fi

# ── kernel direct: upload-idempotent ───────────────────────────────────────
REREAD=$(curl -s -w '\n%{http_code}' -X POST "http://127.0.0.1:$PORT/v1/projects/$PROJ/uploads" \
  -F "kind=data" -F "file=@$WORK/payload.bin;filename=payload.bin")
REREAD_CODE=$(printf '%s' "$REREAD" | tail -n1)
REREAD_BODY=$(printf '%s' "$REREAD" | sed '$d')
REREAD_ID=$(printf '%s' "$REREAD_BODY" | jqfield "j.artifact_id")
REREAD_REUSED=$(printf '%s' "$REREAD_BODY" | jqfield "j.reused")
if [ "$REREAD_CODE" = "200" ] && [ "$REREAD_REUSED" = "true" ] && [ "$REREAD_ID" = "$ART_ID" ]; then
  ok "upload-idempotent: re-upload -> HTTP 200 reused:true, same artifact $ART_ID"
else
  bad "upload-idempotent: expected 200+reused:true+$ART_ID, got HTTP $REREAD_CODE reused=$REREAD_REUSED id=$REREAD_ID"
fi

# ── kernel direct: upload-too-large ────────────────────────────────────────
head -c 33554433 /dev/zero > "$WORK/big.bin"
BIG_CODE=$(curl -s -o "$WORK/big.json" -w '%{http_code}' -X POST "http://127.0.0.1:$PORT/v1/projects/$PROJ/uploads" \
  -F "kind=data" -F "file=@$WORK/big.bin;filename=big.bin")
BIG_ERR=$(jqfield "j.error?.code??''" < "$WORK/big.json")
if [ "$BIG_CODE" = "413" ] && [ "$BIG_ERR" = "payload_too_large" ]; then
  ok "upload-too-large: 33 MiB file -> HTTP 413 payload_too_large"
else
  bad "upload-too-large: expected 413 payload_too_large, got HTTP $BIG_CODE (error=$BIG_ERR)"
fi

# ── kernel direct: upload-path-traversal ───────────────────────────────────
TRAV_CODE=$(curl -s -o "$WORK/trav.json" -w '%{http_code}' -X POST "http://127.0.0.1:$PORT/v1/projects/$PROJ/uploads" \
  -F "kind=data" -F "file=@$WORK/payload.bin;filename=../../evil.txt")
TRAV_ERR=$(jqfield "j.error?.code??''" < "$WORK/trav.json")
if [ "$TRAV_CODE" = "422" ] && [ "$TRAV_ERR" = "invalid_file_name" ]; then
  ok "upload-path-traversal: filename=../../evil.txt -> HTTP 422 invalid_file_name"
else
  bad "upload-path-traversal: expected 422 invalid_file_name, got HTTP $TRAV_CODE (error=$TRAV_ERR)"
fi
TRAV2_CODE=$(curl -s -o /dev/null -w '%{http_code}' -X POST "http://127.0.0.1:$PORT/v1/projects/$PROJ/uploads" \
  -F "kind=data" -F "file=@$WORK/payload.bin;filename=/etc/passwd")
[ "$TRAV2_CODE" = "422" ] && ok "upload-path-traversal: absolute filename -> 422" || bad "absolute filename: expected 422, got $TRAV2_CODE"

# ── kernel direct: upload-missing-file / invalid-kind / non-multipart / unknown project ──
MISS_CODE=$(curl -s -o "$WORK/miss.json" -w '%{http_code}' -X POST "http://127.0.0.1:$PORT/v1/projects/$PROJ/uploads" -F "kind=data")
MISS_ERR=$(jqfield "j.error?.code??''" < "$WORK/miss.json")
[ "$MISS_CODE" = "422" ] && [ "$MISS_ERR" = "missing_file" ] \
  && ok "upload-missing-file: no file part -> 422 missing_file" \
  || bad "upload-missing-file: expected 422 missing_file, got HTTP $MISS_CODE (error=$MISS_ERR)"

KIND_CODE=$(curl -s -o "$WORK/kind.json" -w '%{http_code}' -X POST "http://127.0.0.1:$PORT/v1/projects/$PROJ/uploads" \
  -F "kind=banana" -F "file=@$WORK/payload.bin;filename=x.bin")
KIND_ERR=$(jqfield "j.error?.code??''" < "$WORK/kind.json")
[ "$KIND_CODE" = "422" ] && [ "$KIND_ERR" = "invalid_kind" ] \
  && ok "upload-invalid-kind: kind=banana -> 422 invalid_kind" \
  || bad "upload-invalid-kind: expected 422 invalid_kind, got HTTP $KIND_CODE (error=$KIND_ERR)"

MIME_CODE=$(curl -s -o "$WORK/mime.json" -w '%{http_code}' -X POST "http://127.0.0.1:$PORT/v1/projects/$PROJ/uploads" \
  -H 'content-type: application/json' -d '{}')
MIME_ERR=$(jqfield "j.error?.code??''" < "$WORK/mime.json")
[ "$MIME_CODE" = "415" ] && [ "$MIME_ERR" = "unsupported_media_type" ] \
  && ok "upload-non-multipart: application/json body -> 415 unsupported_media_type" \
  || bad "upload-non-multipart: expected 415 unsupported_media_type, got HTTP $MIME_CODE (error=$MIME_ERR)"

UNK_CODE=$(curl -s -o "$WORK/unk.json" -w '%{http_code}' -X POST "http://127.0.0.1:$PORT/v1/projects/rsp_does_not_exist/uploads" \
  -F "kind=data" -F "file=@$WORK/payload.bin;filename=x.bin")
UNK_ERR=$(jqfield "j.error?.code??''" < "$WORK/unk.json")
[ "$UNK_CODE" = "404" ] && [ "$UNK_ERR" = "project_not_found" ] \
  && ok "upload-unknown-project: -> 404 project_not_found (no enumeration)" \
  || bad "upload-unknown-project: expected 404 project_not_found, got HTTP $UNK_CODE (error=$UNK_ERR)"

# ── standalone BFF proxy ───────────────────────────────────────────────────
BPORT=$((21900 + $$ % 400))
BKPORT=$((BPORT + 1))
BTOKEN="upload-test-token-$$"
mkdir -p "$WORK/bff"
chmod 700 "$WORK/bff"
printf '%s' "$BTOKEN" > "$WORK/bff/standalone-token"
chmod 600 "$WORK/bff/standalone-token"
nohup node "$SERVER_BIN" --host 127.0.0.1 --port "$BPORT" --kernel-port "$BKPORT" \
  --kernel-data-dir "$WORK/bff" --data-dir "$WORK/bff" --principal alice > "$WORK/bff.log" 2>&1 &
BFF_PID=$!
bff_ready=0
for _ in $(seq 1 100); do
  if ! kill -0 "$BFF_PID" 2>/dev/null; then break; fi
  if curl -sf -m 2 -X POST "http://127.0.0.1:$BPORT/api/token-check" -H 'content-type: application/json' \
      -d "{\"token\":\"$BTOKEN\"}" > /dev/null 2>&1; then bff_ready=1; break; fi
  sleep 0.2
done
if [ "$bff_ready" != "1" ]; then
  echo "upload: standalone BFF failed to start (see $WORK/bff.log)" >&2
  exit 2
fi
OK_ORIGIN="Origin: http://127.0.0.1:$BPORT"
AUTH="Authorization: Bearer $BTOKEN"

BPROJ=$(curl -sf -H "$AUTH" -H "$OK_ORIGIN" -H 'content-type: application/json' \
  -X POST "http://127.0.0.1:$BPORT/v1/projects" \
  -d "{\"name\":\"upload-bff\",\"workspace\":\"/w\",\"brief\":$BRIEF}" | jqfield "j.project_id")
[ -n "$BPROJ" ] || { echo "upload: BFF project create failed" >&2; exit 2; }
ok "BFF project $BPROJ created (membership seeded for alice)"

# bff-upload-passthrough: multipart through the proxy with bearer + same-origin.
BUPLOAD_JSON=$(curl -sf -H "$AUTH" -H "$OK_ORIGIN" -X POST "http://127.0.0.1:$BPORT/v1/projects/$BPROJ/uploads" \
  -F "kind=log" -F "file=@$WORK/payload.bin;filename=bff-payload.bin")
BART_ID=$(printf '%s' "$BUPLOAD_JSON" | jqfield "j.artifact_id")
BART_SHA=$(printf '%s' "$BUPLOAD_JSON" | jqfield "j.sha256")
if [ "$BART_ID" = "sha256:$EXPECTED_SHA" ] && [ "$BART_SHA" = "$EXPECTED_SHA" ]; then
  ok "bff-upload-passthrough: multipart through BFF -> 201 hash-bound artifact $BART_ID"
else
  bad "bff-upload-passthrough: expected sha256:$EXPECTED_SHA via BFF, got $BART_ID (sha=$BART_SHA)"
fi
curl -sf -H "$AUTH" "http://127.0.0.1:$BPORT/v1/artifacts/$BART_ID?project_id=$BPROJ" -o "$WORK/bff-downloaded.bin"
cmp -s "$WORK/payload.bin" "$WORK/bff-downloaded.bin" \
  && ok "bff-upload-roundtrip: artifact GET through BFF byte-identical" \
  || bad "bff-upload-roundtrip: bytes differ through BFF"

# bff-upload-idempotent: re-upload through the BFF returns the original.
BRE_JSON=$(curl -sf -H "$AUTH" -H "$OK_ORIGIN" -X POST "http://127.0.0.1:$BPORT/v1/projects/$BPROJ/uploads" \
  -F "kind=log" -F "file=@$WORK/payload.bin;filename=bff-payload.bin")
BRE_ID=$(printf '%s' "$BRE_JSON" | jqfield "j.artifact_id")
BRE_REUSED=$(printf '%s' "$BRE_JSON" | jqfield "j.reused")
[ "$BRE_ID" = "$BART_ID" ] && [ "$BRE_REUSED" = "true" ] \
  && ok "bff-upload-idempotent: BFF re-upload -> same artifact, reused:true" \
  || bad "bff-upload-idempotent: expected $BART_ID reused:true, got $BRE_ID reused=$BRE_REUSED"

# bff-upload-authz: bearer required, origin required, membership enforced.
NOAUTH_CODE=$(curl -s -o /dev/null -w '%{http_code}' -X POST "http://127.0.0.1:$BPORT/v1/projects/$BPROJ/uploads" \
  -F "kind=data" -F "file=@$WORK/payload.bin;filename=x.bin")
[ "$NOAUTH_CODE" = "401" ] \
  && ok "bff-upload-authz: no bearer -> 401" \
  || bad "bff-upload-authz: expected 401 without bearer, got HTTP $NOAUTH_CODE"

XORIGIN_CODE=$(curl -s -o /dev/null -w '%{http_code}' -H "$AUTH" -H 'Origin: http://evil.example' \
  -X POST "http://127.0.0.1:$BPORT/v1/projects/$BPROJ/uploads" \
  -F "kind=data" -F "file=@$WORK/payload.bin;filename=x.bin")
[ "$XORIGIN_CODE" = "403" ] \
  && ok "bff-upload-authz: foreign Origin -> 403 (write CSRF layer kept)" \
  || bad "bff-upload-authz: expected 403 for foreign origin, got HTTP $XORIGIN_CODE"

BFOREIGN_CODE=$(curl -s -o /dev/null -w '%{http_code}' -H "$AUTH" -H "$OK_ORIGIN" \
  -X POST "http://127.0.0.1:$BPORT/v1/projects/rsp_does_not_exist/uploads" \
  -F "kind=data" -F "file=@$WORK/payload.bin;filename=x.bin")
[ "$BFOREIGN_CODE" = "404" ] \
  && ok "bff-upload-authz: unknown project through BFF -> 404 (membership fail-closed)" \
  || bad "bff-upload-authz: expected 404 for unknown project, got HTTP $BFOREIGN_CODE"

echo
echo "upload-tests: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ] || exit 1
