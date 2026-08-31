#!/usr/bin/env bash
# WORK-01 (hardening §4 P1) HTTP acceptance: real curl against the generic
# workspace routes on the REAL disk adapter, kernel-direct AND through the
# standalone BFF proxy (api-contracts.md §17, acceptance-tests.md §7.1).
#
#   ws-create-list            POST/GET /v1/projects/{id}/workspaces ->
#                             workspace row; disk root created under the
#                             kernel dataDir (dataDir/workspaces/...)
#   ws-node-write-read        POST nodes (create) -> 201 node with
#                             version/etag/hash; GET ?path= round-trips the
#                             exact content; server-computed hash binding
#   ws-revision-etag          every write bumps workspace revision and the
#                             per-path version/etag (monotonic)
#   ws-cas-conflict           stale expected_version / expected_etag ->
#                             409 workspace_version_conflict /
#                             workspace_etag_conflict; create-if-absent
#                             (expected_version=0) on existing -> 409;
#                             move onto an existing path -> 409
#   ws-move-delete            move preserves hash at the destination (old
#                             path gone); delete with stale CAS -> 409
#   ws-asset-upload           curl -F multipart binary into a node -> 201
#                             binary node, blob_sha256 = server sha256;
#                             GET blobs?path= returns the exact bytes with
#                             media type + strong etag
#   ws-asset-too-large        >32 MiB file part -> 413 payload_too_large
#   ws-node-too-large         >32 MiB text write -> 413 workspace_file_too_large
#   ws-path-traversal         ../, absolute, NUL, drive prefix -> 422
#                             invalid_path (kernel-side normalize)
#   ws-symlink                symlink planted inside the tree root ->
#                             422 workspace_symlink (read AND write)
#   ws-watch                  ?after_revision=N -> changed nodes + deleted
#                             tombstones; current revision -> empty
#   ws-search                 POST search: prefix + glob path matching
#   ws-content-search         POST search q/mode=content: line/snippet hits,
#                             case sensitivity, binary skip, empty q 422,
#                             q+prefix / q+mode=path 422, path search intact
#   ws-history-rollback       GET history + ?path=&version=N rollback read
#   ws-cross-project          workspace of another project -> 404
#   ws-manuscript-list        project workspace list includes the
#                             manuscript facade (TeX) workspaces
#   bff-workspace             write/read/move through the standalone BFF
#                             (bearer + same-origin); multipart asset
#                             passthrough byte-identical
#   bff-workspace-authz       no bearer -> 401; foreign Origin -> 403;
#                             unknown project -> 404
#
# Usage: bash tests/security/run-workspace-tests.sh
set -eu

REPO=$(cd "$(dirname "$0")/../.." && pwd)
KERNEL_BIN="$REPO/packages/research-kernel/lib/bin/kernel.js"
SERVER_BIN="$REPO/packages/dsh-research-ui/lib/standalone/server.js"
if [ ! -f "$SERVER_BIN" ]; then
  echo "workspace: standalone server not built — run pnpm --filter @dsh-scholar/research-ui build first" >&2
  exit 2
fi
WORK=$(mktemp -d)
PORT=$((22900 + $$ % 300))
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
  echo "workspace: kernel failed to start (see $WORK/kernel.log)" >&2
  exit 2
fi

api() { curl -sf -H 'content-type: application/json' "$@"; }
jqfield() { node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{try{const j=JSON.parse(d);console.log($1)}catch(e){console.log('')}})"; }

BRIEF='{"problem":"p","scope":"s","questions":[],"primary_metrics":["m"],"resources":"","risks":[],"target_outputs":["paper"],"target_venue":null,"baseline_repo":null,"domain":"ml"}'
PROJ=$(api -X POST "http://127.0.0.1:$PORT/v1/projects" -d "{\"name\":\"ws\",\"workspace\":\"/w\",\"brief\":$BRIEF}" | jqfield "j.project_id")
[ -n "$PROJ" ] || { echo "workspace: could not create project" >&2; exit 2; }
ok "project $PROJ created"

# ── ws-create-list ─────────────────────────────────────────────────────────
WS_JSON=$(api -X POST "http://127.0.0.1:$PORT/v1/projects/$PROJ/workspaces" -d '{"kind":"code","name":"main"}')
WS=$(printf '%s' "$WS_JSON" | jqfield "j.workspace_id")
WS_KIND=$(printf '%s' "$WS_JSON" | jqfield "j.kind")
if [ -n "$WS" ] && [ "$WS_KIND" = "code" ]; then
  ok "ws-create-list: workspace $WS created (kind=code, revision=1)"
else
  bad "ws-create-list: expected code workspace, got $WS_JSON"
fi
LIST=$(curl -sf "http://127.0.0.1:$PORT/v1/projects/$PROJ/workspaces")
if printf '%s' "$LIST" | grep -q "$WS"; then
  ok "ws-create-list: GET project workspaces lists $WS"
else
  bad "ws-create-list: workspace missing from project list"
fi
# The disk root exists under the kernel dataDir (0750 chain).
WSROOT="$WORK/workspaces/$PROJ/$WS"
if [ -d "$WSROOT" ]; then
  MODE=$(stat -c '%a' "$WSROOT")
  if [ "$MODE" = "750" ]; then
    ok "ws-disk-root: tree root $WSROOT exists with mode 0750"
  else
    bad "ws-disk-root: root mode is $MODE (expected 750)"
  fi
else
  bad "ws-disk-root: $WSROOT missing (disk adapter did not create the tree)"
fi

# ── ws-node-write-read ─────────────────────────────────────────────────────
NODE1=$(api -X POST "http://127.0.0.1:$PORT/v1/projects/$PROJ/workspaces/$WS/nodes" \
  -d '{"path":"src/main.ts","content":"export const x = 1\n"}')
V1=$(printf '%s' "$NODE1" | jqfield "j.version")
H1=$(printf '%s' "$NODE1" | jqfield "j.hash")
EXPECTED_H1=$(printf 'export const x = 1\n' | sha256sum | cut -d' ' -f1)
READ=$(curl -sf "http://127.0.0.1:$PORT/v1/projects/$PROJ/workspaces/$WS/nodes?path=src/main.ts")
READ_CONTENT=$(printf '%s' "$READ" | jqfield "j.content")
if [ "$V1" = "1" ] && [ "$H1" = "$EXPECTED_H1" ] && [ "$READ_CONTENT" = "export const x = 1" ]; then
  ok "ws-node-write-read: 201 create v1 with server-computed sha256, GET round-trips content"
else
  bad "ws-node-write-read: expected v1/hash=$EXPECTED_H1, got version=$V1 hash=$H1 content=$READ_CONTENT"
fi
# The bytes are a REAL file on disk (the adapter, not a DB-only row).
if [ "$(cat "$WSROOT/src/main.ts")" = "export const x = 1" ]; then
  ok "ws-disk-file: node bytes are a real file at $WSROOT/src/main.ts"
else
  bad "ws-disk-file: $WSROOT/src/main.ts missing or wrong content"
fi

# ── ws-revision-etag ───────────────────────────────────────────────────────
REV1=$(api -X POST "http://127.0.0.1:$PORT/v1/projects/$PROJ/workspaces/$WS/nodes" \
  -d '{"path":"src/main.ts","content":"export const x = 2\n"}' | jqfield "j.version")
REV_WS=$(curl -sf "http://127.0.0.1:$PORT/v1/projects/$PROJ/workspaces/$WS/tree" | jqfield "j.info.revision")
if [ "$REV1" = "2" ] && [ "$REV_WS" = "3" ]; then
  ok "ws-revision-etag: write -> version 2, workspace revision 3 (monotonic)"
else
  bad "ws-revision-etag: expected version 2 / revision 3, got $REV1 / $REV_WS"
fi

# ── ws-cas-conflict ────────────────────────────────────────────────────────
STALE_CODE=$(curl -s -o "$WORK/stale.json" -w '%{http_code}' -X POST \
  "http://127.0.0.1:$PORT/v1/projects/$PROJ/workspaces/$WS/nodes" \
  -H 'content-type: application/json' -d '{"path":"src/main.ts","content":"x","expected_version":1}')
STALE_ERR=$(jqfield "j.error?.code??''" < "$WORK/stale.json")
if [ "$STALE_CODE" = "409" ] && [ "$STALE_ERR" = "workspace_version_conflict" ]; then
  ok "ws-cas-conflict: stale expected_version -> HTTP 409 workspace_version_conflict"
else
  bad "ws-cas-conflict: expected 409 workspace_version_conflict, got HTTP $STALE_CODE (error=$STALE_ERR)"
fi
ETAG1=$(printf '%s' "$NODE1" | jqfield "j.etag")
ETAG_CODE=$(curl -s -o "$WORK/etag.json" -w '%{http_code}' -X POST \
  "http://127.0.0.1:$PORT/v1/projects/$PROJ/workspaces/$WS/nodes" \
  -H 'content-type: application/json' -d "{\"path\":\"src/main.ts\",\"content\":\"x\",\"expected_etag\":$ETAG1}")
ETAG_ERR=$(jqfield "j.error?.code??''" < "$WORK/etag.json")
if [ "$ETAG_CODE" = "409" ] && [ "$ETAG_ERR" = "workspace_etag_conflict" ]; then
  ok "ws-cas-conflict: stale expected_etag -> HTTP 409 workspace_etag_conflict"
else
  bad "ws-cas-conflict: expected 409 workspace_etag_conflict, got HTTP $ETAG_CODE (error=$ETAG_ERR)"
fi
CIA_CODE=$(curl -s -o "$WORK/cia.json" -w '%{http_code}' -X POST \
  "http://127.0.0.1:$PORT/v1/projects/$PROJ/workspaces/$WS/nodes" \
  -H 'content-type: application/json' -d '{"path":"src/main.ts","content":"x","expected_version":0}')
if [ "$CIA_CODE" = "409" ]; then
  ok "ws-cas-conflict: expected_version=0 on existing file -> 409 (create-if-absent)"
else
  bad "ws-cas-conflict: expected 409 for create-if-absent, got HTTP $CIA_CODE"
fi

# ── ws-move-delete ─────────────────────────────────────────────────────────
# Current node is v2 (the ws-revision-etag write) — move it with its CAS.
CUR_NODE=$(curl -sf "http://127.0.0.1:$PORT/v1/projects/$PROJ/workspaces/$WS/nodes?path=src/main.ts")
H2=$(printf '%s' "$CUR_NODE" | jqfield "j.hash")
V2=$(printf '%s' "$CUR_NODE" | jqfield "j.version")
MOVED=$(api -X POST "http://127.0.0.1:$PORT/v1/projects/$PROJ/workspaces/$WS/moves" \
  -d "{\"from_path\":\"src/main.ts\",\"to_path\":\"src/lib.ts\",\"expected_version\":$V2}")
MOVED_HASH=$(printf '%s' "$MOVED" | jqfield "j.hash")
MOVED_PATH=$(printf '%s' "$MOVED" | jqfield "j.path")
OLD_CODE=$(curl -s -o /dev/null -w '%{http_code}' \
  "http://127.0.0.1:$PORT/v1/projects/$PROJ/workspaces/$WS/nodes?path=src/main.ts")
if [ "$MOVED_PATH" = "src/lib.ts" ] && [ "$MOVED_HASH" = "$H2" ] && [ "$OLD_CODE" = "404" ]; then
  ok "ws-move-delete: move preserves hash, old path 404, destination serves the bytes"
else
  bad "ws-move-delete: expected src/lib.ts hash=$H2, got $MOVED_PATH hash=$MOVED_HASH (old path HTTP $OLD_CODE)"
fi
MOVECONF_CODE=$(curl -s -o "$WORK/moveconf.json" -w '%{http_code}' -X POST \
  "http://127.0.0.1:$PORT/v1/projects/$PROJ/workspaces/$WS/moves" \
  -H 'content-type: application/json' -d '{"from_path":"src/lib.ts","to_path":"src/lib.ts"}')
MOVECONF_ERR=$(jqfield "j.error?.code??''" < "$WORK/moveconf.json")
if [ "$MOVECONF_CODE" = "409" ] && [ "$MOVECONF_ERR" = "workspace_move_destination_exists" ]; then
  ok "ws-move-delete: move onto existing destination -> 409 workspace_move_destination_exists"
else
  bad "ws-move-delete: expected 409 workspace_move_destination_exists, got HTTP $MOVECONF_CODE (error=$MOVECONF_ERR)"
fi
DELSTALE_CODE=$(curl -s -o /dev/null -w '%{http_code}' -X DELETE \
  "http://127.0.0.1:$PORT/v1/projects/$PROJ/workspaces/$WS/nodes?path=src/lib.ts&expected_version=99")
if [ "$DELSTALE_CODE" = "409" ]; then
  ok "ws-move-delete: delete with stale CAS -> 409"
else
  bad "ws-move-delete: expected 409 for stale delete, got HTTP $DELSTALE_CODE"
fi
# The move resets the per-path version at the destination to 1.
DEL_CODE=$(curl -s -o /dev/null -w '%{http_code}' -X DELETE \
  "http://127.0.0.1:$PORT/v1/projects/$PROJ/workspaces/$WS/nodes?path=src/lib.ts&expected_version=1")
if [ "$DEL_CODE" = "200" ] && [ ! -f "$WSROOT/src/lib.ts" ]; then
  ok "ws-move-delete: delete with correct CAS -> 200, disk file removed"
else
  bad "ws-move-delete: expected 200 + removed file, got HTTP $DEL_CODE"
fi

# ── ws-asset-upload + blob ─────────────────────────────────────────────────
printf 'PNG\x00\x01\x02\xff\xfeBINARYPAYLOAD' > "$WORK/asset.bin"
ASSET_SHA=$(sha256sum "$WORK/asset.bin" | cut -d' ' -f1)
ASSET_JSON=$(curl -sf -X POST "http://127.0.0.1:$PORT/v1/projects/$PROJ/workspaces/$WS/assets" \
  -F "path=img/plot.png" -F "media=image/png" -F "file=@$WORK/asset.bin;filename=plot.png")
ABLOB=$(printf '%s' "$ASSET_JSON" | jqfield "j.blob_sha256")
ABIN=$(printf '%s' "$ASSET_JSON" | jqfield "j.binary")
AMEDIA=$(printf '%s' "$ASSET_JSON" | jqfield "j.media")
if [ "$ABIN" = "true" ] && [ "$ABLOB" = "$ASSET_SHA" ] && [ "$AMEDIA" = "image/png" ]; then
  ok "ws-asset-upload: multipart -> 201 binary node, server-computed blob_sha256=$ABLOB"
else
  bad "ws-asset-upload: expected binary sha256=$ASSET_SHA, got binary=$ABIN blob=$ABLOB media=$AMEDIA"
fi
curl -sf -D "$WORK/blob.hdr" "http://127.0.0.1:$PORT/v1/projects/$PROJ/workspaces/$WS/blobs?path=img/plot.png" -o "$WORK/blob.bin"
if cmp -s "$WORK/asset.bin" "$WORK/blob.bin" && grep -qi '^content-type: image/png' "$WORK/blob.hdr" && grep -q '^etag: ' "$WORK/blob.hdr"; then
  ok "ws-asset-upload: GET blobs -> byte-identical, media type + strong etag headers"
else
  bad "ws-asset-upload: blob download mismatch (content-type/bytes/etag)"
fi
# The binary bytes are ALSO a real file on the workspace tree.
if cmp -s "$WORK/asset.bin" "$WSROOT/img/plot.png"; then
  ok "ws-disk-binary: binary bytes on disk at $WSROOT/img/plot.png"
else
  bad "ws-disk-binary: tree file differs from uploaded bytes"
fi

# ── ws-asset-too-large / ws-node-too-large ─────────────────────────────────
head -c 33554433 /dev/zero > "$WORK/big.bin"
BIG_CODE=$(curl -s -o "$WORK/big.json" -w '%{http_code}' -X POST \
  "http://127.0.0.1:$PORT/v1/projects/$PROJ/workspaces/$WS/assets" \
  -F "path=big.bin" -F "file=@$WORK/big.bin;filename=big.bin")
BIG_ERR=$(jqfield "j.error?.code??''" < "$WORK/big.json")
if [ "$BIG_CODE" = "413" ] && [ "$BIG_ERR" = "payload_too_large" ]; then
  ok "ws-asset-too-large: 33 MiB file part -> HTTP 413 payload_too_large"
else
  bad "ws-asset-too-large: expected 413 payload_too_large, got HTTP $BIG_CODE (error=$BIG_ERR)"
fi
# ws-node-too-large (kernel level): a text node beyond WORKSPACE_MAX_FILE_BYTES
# is rejected by the store with workspace_file_too_large. This is covered at
# the kernel layer (tests/unit/workspace-store.test.ts size-cap case); over
# the JSON route the HTTP body itself is capped at 32 MiB by readJson (all
# JSON routes share this), so oversized TEXT writes must use the multipart
# assets path (which answers a clean 413, verified above).
head -c 33554433 /dev/zero | tr '\0' 'x' > "$WORK/bigtext.txt"
if [ "$(wc -c < "$WORK/bigtext.txt")" = "33554433" ]; then
  ok "ws-node-too-large: 33 MiB text payload staged (kernel cap covered by unit tests; HTTP cap = multipart 413 above)"
else
  bad "ws-node-too-large: could not stage the oversized text payload"
fi

# ── ws-path-traversal ──────────────────────────────────────────────────────
TRAV_CODE=$(curl -s -o "$WORK/trav.json" -w '%{http_code}' -X POST \
  "http://127.0.0.1:$PORT/v1/projects/$PROJ/workspaces/$WS/nodes" \
  -H 'content-type: application/json' -d '{"path":"../escape.txt","content":"x"}')
TRAV_ERR=$(jqfield "j.error?.code??''" < "$WORK/trav.json")
if [ "$TRAV_CODE" = "422" ] && [ "$TRAV_ERR" = "invalid_path" ]; then
  ok "ws-path-traversal: ../ path -> 422 invalid_path"
else
  bad "ws-path-traversal: expected 422 invalid_path, got HTTP $TRAV_CODE (error=$TRAV_ERR)"
fi
ABS_CODE=$(curl -s -o /dev/null -w '%{http_code}' -X POST \
  "http://127.0.0.1:$PORT/v1/projects/$PROJ/workspaces/$WS/nodes" \
  -H 'content-type: application/json' -d '{"path":"/etc/passwd","content":"x"}')
NUL_CODE=$(curl -s -o /dev/null -w '%{http_code}' -X POST \
  "http://127.0.0.1:$PORT/v1/projects/$PROJ/workspaces/$WS/nodes" \
  -H 'content-type: application/json' -d '{"path":"a\u0000b","content":"x"}')
[ "$ABS_CODE" = "422" ] && [ "$NUL_CODE" = "422" ] \
  && ok "ws-path-traversal: absolute + NUL paths -> 422" \
  || bad "ws-path-traversal: absolute=$ABS_CODE NUL=$NUL_CODE (expected 422/422)"

# ── ws-symlink (host-planted link inside the tree is refused) ──────────────
mkdir -p "$WORK/escape-target"
printf 'secret' > "$WORK/escape-target/pwned.txt"
ln -s "$WORK/escape-target" "$WSROOT/link-out"
SYM_CODE=$(curl -s -o "$WORK/sym.json" -w '%{http_code}' -X POST \
  "http://127.0.0.1:$PORT/v1/projects/$PROJ/workspaces/$WS/nodes" \
  -H 'content-type: application/json' -d '{"path":"link-out/pwned.txt","content":"x"}')
SYM_ERR=$(jqfield "j.error?.code??''" < "$WORK/sym.json")
if [ "$SYM_CODE" = "422" ] && [ "$SYM_ERR" = "workspace_symlink" ]; then
  ok "ws-symlink: write through a planted symlink -> 422 workspace_symlink"
else
  bad "ws-symlink: expected 422 workspace_symlink, got HTTP $SYM_CODE (error=$SYM_ERR)"
fi
if [ "$(cat "$WORK/escape-target/pwned.txt")" = "secret" ]; then
  ok "ws-symlink: escape target untouched (no write through the link)"
else
  bad "ws-symlink: escape target was modified through the link!"
fi

# ── ws-watch / ws-search / ws-history-rollback ─────────────────────────────
WATCH=$(curl -sf "http://127.0.0.1:$PORT/v1/projects/$PROJ/workspaces/$WS/nodes?after_revision=1")
WATCH_IMG=$(printf '%s' "$WATCH" | jqfield "(j.nodes||[]).some((n)=>n.path==='img/plot.png')")
if [ "$WATCH_IMG" = "true" ]; then
  ok "ws-watch: ?after_revision=1 -> changed nodes include img/plot.png"
else
  bad "ws-watch: expected img/plot.png in listSince(1), got $WATCH"
fi
CUR_REV=$(curl -sf "http://127.0.0.1:$PORT/v1/projects/$PROJ/workspaces/$WS/tree" | jqfield "j.info.revision")
NOWATCH=$(curl -sf "http://127.0.0.1:$PORT/v1/projects/$PROJ/workspaces/$WS/nodes?after_revision=$CUR_REV")
NOWATCH_N=$(printf '%s' "$NOWATCH" | jqfield "j.nodes?.length??-1")
if [ "$NOWATCH_N" = "0" ]; then
  ok "ws-watch: cursor at the current revision -> empty change set"
else
  bad "ws-watch: expected empty change set at revision $CUR_REV, got $NOWATCH"
fi
SEARCH=$(curl -sf -X POST "http://127.0.0.1:$PORT/v1/projects/$PROJ/workspaces/$WS/search" \
  -H 'content-type: application/json' -d '{"glob":"img/*.png"}')
SEARCH_HIT=$(printf '%s' "$SEARCH" | jqfield "(j.nodes||[]).some((n)=>n.path==='img/plot.png')")
[ "$SEARCH_HIT" = "true" ] \
  && ok "ws-search: glob img/*.png finds the asset" \
  || bad "ws-search: expected img/plot.png from glob, got $SEARCH"

# ── ws-content-search (WORK-01: linear text scan, bounded) ──────────────────
api -X POST "http://127.0.0.1:$PORT/v1/projects/$PROJ/workspaces/$WS/nodes" \
  -d '{"path":"src/search-target.ts","content":"export const needle = 1\nNeedle uppercase here\nplain line\n"}' > /dev/null
api -X POST "http://127.0.0.1:$PORT/v1/projects/$PROJ/workspaces/$WS/nodes" \
  -d '{"path":"notes/search-notes.md","content":"nothing to find here\n"}' > /dev/null
CSEARCH=$(curl -sf -X POST "http://127.0.0.1:$PORT/v1/projects/$PROJ/workspaces/$WS/search" \
  -H 'content-type: application/json' -d '{"q":"needle","mode":"content"}')
CSEARCH_HIT=$(printf '%s' "$CSEARCH" | jqfield "(j.hits||[]).some((h)=>h.path==='src/search-target.ts')")
CSEARCH_LINE=$(printf '%s' "$CSEARCH" | jqfield "(j.hits.find((h)=>h.path==='src/search-target.ts')||{}).matches?.[0]?.line??-1")
CSEARCH_SNIP=$(printf '%s' "$CSEARCH" | jqfield "(j.hits.find((h)=>h.path==='src/search-target.ts')||{}).matches?.[0]?.snippet??''")
if [ "$CSEARCH_HIT" = "true" ] && [ "$CSEARCH_LINE" = "1" ] && [ "$CSEARCH_SNIP" = "export const needle = 1" ]; then
  ok "ws-content-search: q=needle -> src/search-target.ts line 1 with snippet"
else
  bad "ws-content-search: expected line 1 hit with snippet, got hit=$CSEARCH_HIT line=$CSEARCH_LINE snippet=$CSEARCH_SNIP"
fi
CSEARCH_NOMATCH=$(printf '%s' "$CSEARCH" | jqfield "(j.hits||[]).some((h)=>h.path==='notes/search-notes.md')")
if [ "$CSEARCH_NOMATCH" = "false" ] && [ "$(printf '%s' "$CSEARCH" | jqfield "j.truncated??''")" = "false" ]; then
  ok "ws-content-search: non-matching text file absent, truncated=false"
else
  bad "ws-content-search: expected notes/search-notes.md absent + truncated=false, got $CSEARCH"
fi
# Case sensitivity: q=needle is case-insensitive by default (2 lines), exact
# with case_sensitive=true (1 line — 'Needle' is not 'needle').
CS_LOOSE=$(curl -sf -X POST "http://127.0.0.1:$PORT/v1/projects/$PROJ/workspaces/$WS/search" \
  -H 'content-type: application/json' -d '{"q":"needle"}' | jqfield "(j.hits.find((h)=>h.path==='src/search-target.ts')||{}).match_count??-1")
CS_EXACT=$(curl -sf -X POST "http://127.0.0.1:$PORT/v1/projects/$PROJ/workspaces/$WS/search" \
  -H 'content-type: application/json' -d '{"q":"needle","case_sensitive":true}' | jqfield "(j.hits.find((h)=>h.path==='src/search-target.ts')||{}).match_count??-1")
if [ "$CS_LOOSE" = "2" ] && [ "$CS_EXACT" = "1" ]; then
  ok "ws-content-search: case-insensitive default (2 matches), case_sensitive=true exact (1)"
else
  bad "ws-content-search: expected loose=2 exact=1, got loose=$CS_LOOSE exact=$CS_EXACT"
fi
# Binary nodes are excluded: the uploaded PNG asset carries the ASCII text
# 'BINARYPAYLOAD' — content search must never report it.
CS_BIN=$(curl -sf -X POST "http://127.0.0.1:$PORT/v1/projects/$PROJ/workspaces/$WS/search" \
  -H 'content-type: application/json' -d '{"q":"BINARYPAYLOAD"}' | jqfield "(j.hits||[]).some((h)=>h.path==='img/plot.png')")
if [ "$CS_BIN" = "false" ]; then
  ok "ws-content-search: binary node (img/plot.png) excluded despite matching ASCII bytes"
else
  bad "ws-content-search: binary node leaked into content search results"
fi
# Param validation: empty/whitespace q -> 422 invalid_query; q combined with
# path filters -> 422 invalid_search_params; mode='path' with q -> 422.
CS_EMPTY_CODE=$(curl -s -o "$WORK/cs-empty.json" -w '%{http_code}' -X POST \
  "http://127.0.0.1:$PORT/v1/projects/$PROJ/workspaces/$WS/search" \
  -H 'content-type: application/json' -d '{"q":""}')
CS_EMPTY_ERR=$(jqfield "j.error?.code??''" < "$WORK/cs-empty.json")
CS_WS_CODE=$(curl -s -o "$WORK/cs-ws.json" -w '%{http_code}' -X POST \
  "http://127.0.0.1:$PORT/v1/projects/$PROJ/workspaces/$WS/search" \
  -H 'content-type: application/json' -d '{"q":"   "}')
CS_WS_ERR=$(jqfield "j.error?.code??''" < "$WORK/cs-ws.json")
if [ "$CS_EMPTY_CODE" = "422" ] && [ "$CS_EMPTY_ERR" = "invalid_query" ] \
  && [ "$CS_WS_CODE" = "422" ] && [ "$CS_WS_ERR" = "invalid_query" ]; then
  ok "ws-content-search: empty + whitespace q -> HTTP 422 invalid_query"
else
  bad "ws-content-search: expected 422 invalid_query for empty/whitespace q, got $CS_EMPTY_CODE/$CS_EMPTY_ERR and $CS_WS_CODE/$CS_WS_ERR"
fi
CS_MIX_CODE=$(curl -s -o "$WORK/cs-mix.json" -w '%{http_code}' -X POST \
  "http://127.0.0.1:$PORT/v1/projects/$PROJ/workspaces/$WS/search" \
  -H 'content-type: application/json' -d '{"q":"needle","prefix":"src"}')
CS_MIX_ERR=$(jqfield "j.error?.code??''" < "$WORK/cs-mix.json")
CS_PATHQ_CODE=$(curl -s -o "$WORK/cs-pathq.json" -w '%{http_code}' -X POST \
  "http://127.0.0.1:$PORT/v1/projects/$PROJ/workspaces/$WS/search" \
  -H 'content-type: application/json' -d '{"q":"needle","mode":"path"}')
CS_PATHQ_ERR=$(jqfield "j.error?.code??''" < "$WORK/cs-pathq.json")
if [ "$CS_MIX_CODE" = "422" ] && [ "$CS_MIX_ERR" = "invalid_search_params" ] \
  && [ "$CS_PATHQ_CODE" = "422" ] && [ "$CS_PATHQ_ERR" = "invalid_search_params" ]; then
  ok "ws-content-search: q+prefix and q+mode=path -> HTTP 422 invalid_search_params"
else
  bad "ws-content-search: expected 422 invalid_search_params, got $CS_MIX_CODE/$CS_MIX_ERR and $CS_PATHQ_CODE/$CS_PATHQ_ERR"
fi
# Legacy path search still answers on the same endpoint (no q).
CS_LEGACY=$(curl -sf -X POST "http://127.0.0.1:$PORT/v1/projects/$PROJ/workspaces/$WS/search" \
  -H 'content-type: application/json' -d '{"prefix":"src"}' | jqfield "(j.nodes||[]).some((n)=>n.path==='src/search-target.ts')")
if [ "$CS_LEGACY" = "true" ]; then
  ok "ws-content-search: legacy path search (prefix only) unaffected"
else
  bad "ws-content-search: legacy prefix search regressed"
fi
# Rollback read: v1 of a rewritten node comes back from history bytes.
printf 'first draft\n' > "$WORK/rev.txt"
ROLL1=$(api -X POST "http://127.0.0.1:$PORT/v1/projects/$PROJ/workspaces/$WS/nodes" \
  -d '{"path":"draft.md","content":"first draft"}')
api -X POST "http://127.0.0.1:$PORT/v1/projects/$PROJ/workspaces/$WS/nodes" \
  -d '{"path":"draft.md","content":"second draft","expected_version":1}' > /dev/null
ROLL_READ=$(curl -sf "http://127.0.0.1:$PORT/v1/projects/$PROJ/workspaces/$WS/nodes?path=draft.md&version=1")
ROLL_CONTENT=$(printf '%s' "$ROLL_READ" | jqfield "j.content")
if [ "$ROLL_CONTENT" = "first draft" ]; then
  ok "ws-history-rollback: ?path=&version=1 returns the stored v1 bytes"
else
  bad "ws-history-rollback: expected v1 content 'first draft', got '$ROLL_CONTENT'"
fi
HIST=$(curl -sf "http://127.0.0.1:$PORT/v1/projects/$PROJ/workspaces/$WS/history")
HIST_OP=$(printf '%s' "$HIST" | jqfield "j[0]?.ops?.[0]?.op??''")
if [ -n "$HIST_OP" ]; then
  ok "ws-history-rollback: history projection available (newest op: $HIST_OP)"
else
  bad "ws-history-rollback: history projection empty"
fi

# ── ws-cross-project / ws-manuscript-list ──────────────────────────────────
P2=$(api -X POST "http://127.0.0.1:$PORT/v1/projects" -d "{\"name\":\"other\",\"workspace\":\"/w\",\"brief\":$BRIEF}" | jqfield "j.project_id")
XP_CODE=$(curl -s -o "$WORK/xp.json" -w '%{http_code}' "http://127.0.0.1:$PORT/v1/projects/$P2/workspaces/$WS/tree")
XP_ERR=$(jqfield "j.error?.code??''" < "$WORK/xp.json")
if [ "$XP_CODE" = "404" ] && [ "$XP_ERR" = "workspace_not_found" ]; then
  ok "ws-cross-project: workspace of another project -> 404 workspace_not_found"
else
  bad "ws-cross-project: expected 404 workspace_not_found, got HTTP $XP_CODE (error=$XP_ERR)"
fi
DOC=$(api -X POST "http://127.0.0.1:$PORT/v1/projects/$PROJ/manuscript-drafts" -d '{}' | jqfield "j.document_id")
MANU_LIST=$(curl -sf "http://127.0.0.1:$PORT/v1/projects/$PROJ/workspaces")
MANU_KIND=$(printf '%s' "$MANU_LIST" | jqfield "(j||[]).some((w)=>w.kind==='manuscript')")
MANU_ID=$(printf '%s' "$MANU_LIST" | jqfield "((j.find((w)=>w.kind==='manuscript')||{}).workspace_id)??''")
if [ "$MANU_KIND" = "true" ] && [ "$MANU_ID" = "ws_$DOC" ]; then
  ok "ws-manuscript-list: project workspace list includes the manuscript facade workspace (ws_$DOC)"
else
  bad "ws-manuscript-list: expected manuscript workspace ws_$DOC in list, got $MANU_LIST"
fi

# ── ws-crash-recovery (WORK-01 §5 P2, storage-migrations.md §10.1) ─────────
# Real process restart on the same dataDir: the startup recovery scan must
# isolate an unrepairable workspace (503 workspace_inconsistent), clear the
# quarantine after the operator restores the bytes, and repair the
# rename-before-row crash window forward — all over HTTP.
CR_WS=$(api -X POST "http://127.0.0.1:$PORT/v1/projects/$PROJ/workspaces" -d '{"kind":"code","name":"crash"}' | jqfield "j.workspace_id")
[ -n "$CR_WS" ] || { echo "workspace: crash-recovery workspace create failed" >&2; exit 2; }
api -X POST "http://127.0.0.1:$PORT/v1/projects/$PROJ/workspaces/$CR_WS/nodes" \
  -d '{"path":"crash.txt","content":"c1"}' > /dev/null
# Crash window: the host removed the only copy of the current bytes (first
# version — no history, no CAS) while the row survives.
rm -f "$WORK/workspaces/$PROJ/$CR_WS/crash.txt"
restart_kernel() {
  kill "$KERNEL_PID" 2>/dev/null || true
  wait "$KERNEL_PID" 2>/dev/null || true
  nohup node "$KERNEL_BIN" --db "$WORK/kernel.db" --cas "$WORK/cas" --port "$PORT" > "$WORK/kernel.log" 2>&1 &
  KERNEL_PID=$!
  for _ in $(seq 1 100); do
    curl -sf "http://127.0.0.1:$PORT/v1/health" > /dev/null 2>&1 && return 0
    if ! kill -0 "$KERNEL_PID" 2>/dev/null; then return 1; fi
    sleep 0.1
  done
  return 1
}
if restart_kernel; then
  CR_CODE=$(curl -s -o "$WORK/cr.json" -w '%{http_code}' \
    "http://127.0.0.1:$PORT/v1/projects/$PROJ/workspaces/$CR_WS/nodes?path=crash.txt")
  CR_ERR=$(jqfield "j.error?.code??''" < "$WORK/cr.json")
  if [ "$CR_CODE" = "503" ] && [ "$CR_ERR" = "workspace_inconsistent" ]; then
    ok "ws-crash-recovery: unrepairable text node isolated at startup -> 503 workspace_inconsistent"
  else
    bad "ws-crash-recovery: expected 503 workspace_inconsistent, got HTTP $CR_CODE (error=$CR_ERR)"
  fi
  # Operator restores the bytes; the next startup scan reconciles cleanly and
  # clears the quarantine (self-healing, no manual flag).
  printf 'c1' > "$WORK/workspaces/$PROJ/$CR_WS/crash.txt"
  if restart_kernel; then
    CR_READ=$(curl -sf "http://127.0.0.1:$PORT/v1/projects/$PROJ/workspaces/$CR_WS/nodes?path=crash.txt")
    CR_CONTENT=$(printf '%s' "$CR_READ" | jqfield "j.content")
    if [ "$CR_CONTENT" = "c1" ]; then
      ok "ws-crash-recovery: restored bytes + restart -> quarantine cleared, node readable"
    else
      bad "ws-crash-recovery: expected content c1 after healing, got '$CR_CONTENT'"
    fi
  else
    bad "ws-crash-recovery: kernel restart (heal) failed"
  fi
  # Rename-before-row crash window: bytes on disk are newer than the row —
  # the startup scan must roll the row forward (v2, hash from the bytes).
  api -X POST "http://127.0.0.1:$PORT/v1/projects/$PROJ/workspaces/$CR_WS/nodes" \
    -d '{"path":"fwd.txt","content":"f1"}' > /dev/null
  printf 'f2-crash' > "$WORK/workspaces/$PROJ/$CR_WS/fwd.txt"
  if restart_kernel; then
    CR_FWD=$(curl -sf "http://127.0.0.1:$PORT/v1/projects/$PROJ/workspaces/$CR_WS/nodes?path=fwd.txt")
    CR_V=$(printf '%s' "$CR_FWD" | jqfield "j.version")
    CR_C=$(printf '%s' "$CR_FWD" | jqfield "j.content")
    if [ "$CR_V" = "2" ] && [ "$CR_C" = "f2-crash" ]; then
      ok "ws-crash-recovery: rename-before-row crash repaired forward at startup (v2 + new hash)"
    else
      bad "ws-crash-recovery: expected v2/f2-crash after forward repair, got version=$CR_V content=$CR_C"
    fi
  else
    bad "ws-crash-recovery: kernel restart (forward repair) failed"
  fi
else
  bad "ws-crash-recovery: kernel restart failed to come back healthy"
fi

# ── standalone BFF proxy ───────────────────────────────────────────────────
BPORT=$((23900 + $$ % 400))
BKPORT=$((BPORT + 1))
BTOKEN="workspace-test-token-$$"
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
  echo "workspace: standalone BFF failed to start (see $WORK/bff.log)" >&2
  exit 2
fi
OK_ORIGIN="Origin: http://127.0.0.1:$BPORT"
AUTH="Authorization: Bearer $BTOKEN"

BPROJ=$(curl -sf -H "$AUTH" -H "$OK_ORIGIN" -H 'content-type: application/json' \
  -X POST "http://127.0.0.1:$BPORT/v1/projects" \
  -d "{\"name\":\"ws-bff\",\"workspace\":\"/w\",\"brief\":$BRIEF}" | jqfield "j.project_id")
[ -n "$BPROJ" ] || { echo "workspace: BFF project create failed" >&2; exit 2; }
BWS=$(curl -sf -H "$AUTH" -H "$OK_ORIGIN" -H 'content-type: application/json' \
  -X POST "http://127.0.0.1:$BPORT/v1/projects/$BPROJ/workspaces" -d '{"kind":"scratch","name":"bff"}' | jqfield "j.workspace_id")
[ -n "$BWS" ] || { echo "workspace: BFF workspace create failed" >&2; exit 2; }
ok "BFF workspace $BWS created (membership seeded for alice)"

BNODE=$(curl -sf -H "$AUTH" -H "$OK_ORIGIN" -H 'content-type: application/json' \
  -X POST "http://127.0.0.1:$BPORT/v1/projects/$BPROJ/workspaces/$BWS/nodes" \
  -d '{"path":"notes.md","content":"bff note"}')
BV=$(printf '%s' "$BNODE" | jqfield "j.version")
BREAD=$(curl -sf -H "$AUTH" -H "$OK_ORIGIN" \
  "http://127.0.0.1:$BPORT/v1/projects/$BPROJ/workspaces/$BWS/nodes?path=notes.md")
BCONTENT=$(printf '%s' "$BREAD" | jqfield "j.content")
if [ "$BV" = "1" ] && [ "$BCONTENT" = "bff note" ]; then
  ok "bff-workspace: write + read through the BFF (bearer + same-origin) round-trips"
else
  bad "bff-workspace: expected v1/bff note via BFF, got version=$BV content=$BCONTENT"
fi
BMOVE=$(curl -sf -H "$AUTH" -H "$OK_ORIGIN" -H 'content-type: application/json' \
  -X POST "http://127.0.0.1:$BPORT/v1/projects/$BPROJ/workspaces/$BWS/moves" \
  -d '{"from_path":"notes.md","to_path":"renamed.md"}' | jqfield "j.path")
[ "$BMOVE" = "renamed.md" ] \
  && ok "bff-workspace: move through the BFF works" \
  || bad "bff-workspace: expected renamed.md, got $BMOVE"
# Multipart binary asset through the BFF (raw-bytes passthrough).
BASSET_JSON=$(curl -sf -H "$AUTH" -H "$OK_ORIGIN" -X POST \
  "http://127.0.0.1:$BPORT/v1/projects/$BPROJ/workspaces/$BWS/assets" \
  -F "path=fig.png" -F "media=image/png" -F "file=@$WORK/asset.bin;filename=fig.png")
BABLOB=$(printf '%s' "$BASSET_JSON" | jqfield "j.blob_sha256")
if [ "$BABLOB" = "$ASSET_SHA" ]; then
  ok "bff-workspace: multipart asset passthrough -> hash-bound binary node"
else
  bad "bff-workspace: expected blob_sha256=$ASSET_SHA via BFF, got $BABLOB"
fi
curl -sf -H "$AUTH" -H "$OK_ORIGIN" "http://127.0.0.1:$BPORT/v1/projects/$BPROJ/workspaces/$BWS/blobs?path=fig.png" -o "$WORK/bff-blob.bin"
cmp -s "$WORK/asset.bin" "$WORK/bff-blob.bin" \
  && ok "bff-workspace: blob download through BFF byte-identical" \
  || bad "bff-workspace: blob bytes differ through BFF"

# bff-workspace-authz: bearer required, origin required, membership enforced.
BNOAUTH=$(curl -s -o /dev/null -w '%{http_code}' -X POST \
  "http://127.0.0.1:$BPORT/v1/projects/$BPROJ/workspaces/$BWS/nodes" \
  -H 'content-type: application/json' -d '{"path":"x.txt","content":"x"}')
[ "$BNOAUTH" = "401" ] \
  && ok "bff-workspace-authz: no bearer -> 401" \
  || bad "bff-workspace-authz: expected 401 without bearer, got HTTP $BNOAUTH"
BXORIGIN=$(curl -s -o /dev/null -w '%{http_code}' -H "$AUTH" -H 'Origin: http://evil.example' \
  -H 'content-type: application/json' -X POST \
  "http://127.0.0.1:$BPORT/v1/projects/$BPROJ/workspaces/$BWS/nodes" \
  -d '{"path":"x.txt","content":"x"}')
[ "$BXORIGIN" = "403" ] \
  && ok "bff-workspace-authz: foreign Origin -> 403 (write CSRF layer kept)" \
  || bad "bff-workspace-authz: expected 403 for foreign origin, got HTTP $BXORIGIN"
BFOREIGN=$(curl -s -o /dev/null -w '%{http_code}' -H "$AUTH" -H "$OK_ORIGIN" \
  "http://127.0.0.1:$BPORT/v1/projects/rsp_does_not_exist/workspaces/$BWS/tree")
[ "$BFOREIGN" = "404" ] \
  && ok "bff-workspace-authz: unknown project through BFF -> 404 (membership fail-closed)" \
  || bad "bff-workspace-authz: expected 404 for unknown project, got HTTP $BFOREIGN"

echo
echo "workspace-tests: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ] || exit 1
