#!/usr/bin/env bash
# RunnerTarget heartbeat identity binding: the shared internal token admits
# the route, but only the target-scoped 0600 SecretRef token may update that
# exact target. Caller-supplied principal/target/forwarded headers never grant
# access, and the plaintext header-token wire is direct-loopback only.
set -eu

REPO=$(cd "$(dirname "$0")/../.." && pwd)
KERNEL_BIN="$REPO/packages/research-kernel/lib/bin/kernel.js"
WORK=$(mktemp -d)
PORT=$((21300 + $$ % 300))
PASS=0
FAIL=0
ok() { printf '  ok: %s\n' "$*"; PASS=$((PASS+1)); }
bad() { printf '  FAIL: %s\n' "$*"; FAIL=$((FAIL+1)); }
cleanup() {
  if [[ -n "${KERNEL_PID:-}" ]]; then kill "$KERNEL_PID" 2>/dev/null || true; wait "$KERNEL_PID" 2>/dev/null || true; fi
  rm -rf "$WORK"
}
trap cleanup EXIT

mkdir -p "$WORK/secrets/runner"
TOKEN_A='security-target-a-token-000000001'
TOKEN_B='security-target-b-token-000000002'
printf %s "$TOKEN_A" > "$WORK/secrets/runner/a.token"
printf %s "$TOKEN_B" > "$WORK/secrets/runner/b.token"
chmod 600 "$WORK/secrets/runner/a.token" "$WORK/secrets/runner/b.token"
export DSH_SCHOLAR_SERVICE_TOKEN='security-shared-service-token'
NON_LOOPBACK_IP=$(hostname -I 2>/dev/null | tr ' ' '\n' | awk '/^[0-9]+\./ && $0 !~ /^127\./ { print; exit }')
if [[ -z "$NON_LOOPBACK_IP" ]]; then
  printf '  FAIL: no non-loopback address available for transport-boundary test\n'
  exit 1
fi
nohup node "$KERNEL_BIN" --db "$WORK/kernel.db" --cas "$WORK/cas" --secret-root "$WORK/secrets" --host 0.0.0.0 --port "$PORT" > "$WORK/kernel.log" 2>&1 &
KERNEL_PID=$!
for _ in $(seq 1 60); do curl -sf "http://127.0.0.1:$PORT/v1/health" >/dev/null 2>&1 && break; sleep 0.1; done
BASE="http://127.0.0.1:$PORT"
api() { curl -sf -H 'content-type: application/json' -H "x-service-token: $DSH_SCHOLAR_SERVICE_TOKEN" "$@"; }

# Establish an authoritative PI principal, then let it configure the global
# target allowlist. Secret values never cross this API.
api -X POST "$BASE/v1/projects" -d '{"name":"target identity admin","workspace":"/w","creator_principal_id":"identity-operator","brief":{"problem":"p","scope":"s","questions":[],"primary_metrics":["m"],"resources":"","risks":[],"target_outputs":["paper"],"target_venue":null,"baseline_repo":null,"domain":"security"},"execution":{"runner_profile_id":"profile_local_docker_cpu_v1","runner_target_id":"target_local_docker_v1"}}' >/dev/null
for id in a b; do
  api -X POST "$BASE/v1/settings/transactions" -H 'x-principal-id: identity-operator' \
    -d "{\"operations\":[{\"kind\":\"runner-target\",\"action\":\"create\",\"input\":{\"target_id\":\"target-$id\",\"display_name\":\"Target $id\",\"kind\":\"local-docker\",\"service_identity\":{\"scheme\":\"file\",\"name\":\"runner/$id.token\"}}}]}" >/dev/null
done

heartbeat() {
  local target=$1 token=${2:-} principal=${3:-}
  local headers=(-H 'content-type: application/json' -H "x-service-token: $DSH_SCHOLAR_SERVICE_TOKEN")
  [[ -n "$token" ]] && headers+=(-H "x-runner-target-token: $token")
  [[ -n "$principal" ]] && headers+=(-H "x-service-principal: $principal" -H "x-runner-target-id: $target")
  curl -s -o "$WORK/heartbeat.json" -w '%{http_code}' -X POST "${headers[@]}" \
    "$BASE/v1/runner-targets/$target/heartbeat" -d '{"expected_revision":1,"health":"online"}'
}

CODE=$(heartbeat target-a)
[[ "$CODE" == 403 ]] && ok 'shared service token alone cannot heartbeat a target' || bad "shared-only heartbeat returned $CODE"
CODE=$(heartbeat target-b "$TOKEN_A" target-b)
[[ "$CODE" == 403 ]] && ok 'target A identity cannot impersonate target B despite self-reported headers' || bad "cross-target heartbeat returned $CODE"
CODE=$(heartbeat target-a "$TOKEN_A")
[[ "$CODE" == 200 ]] && ok 'matching target-scoped identity updates its own target' || bad "matching heartbeat returned $CODE"
CODE=$(heartbeat target-a "$TOKEN_B")
[[ "$CODE" == 403 ]] && ok 'target B identity cannot update target A' || bad "reverse cross-target heartbeat returned $CODE"

# A valid pair of credentials is still rejected when it reaches the Kernel
# directly over a non-loopback socket. Spoofed proxy metadata is ignored; a
# production deployment must terminate authenticated mTLS at a trusted local
# peer before forwarding to this plaintext listener.
CODE=$(curl --noproxy '*' -s -o "$WORK/heartbeat.json" -w '%{http_code}' -X POST \
  -H 'content-type: application/json' \
  -H "x-service-token: $DSH_SCHOLAR_SERVICE_TOKEN" \
  -H "x-runner-target-token: $TOKEN_A" \
  -H 'x-forwarded-for: 127.0.0.1' \
  "http://$NON_LOOPBACK_IP:$PORT/v1/runner-targets/target-a/heartbeat" \
  -d '{"expected_revision":1,"health":"online"}')
ERROR_CODE=$(node -e "const fs=require('fs'); const v=JSON.parse(fs.readFileSync(process.argv[1],'utf8')); process.stdout.write(v.error?.code ?? '')" "$WORK/heartbeat.json")
[[ "$CODE" == 403 && "$ERROR_CODE" == loopback_only ]] \
  && ok 'valid target token and spoofed forwarding headers are rejected from a non-loopback peer' \
  || bad "non-loopback heartbeat returned HTTP $CODE error=$ERROR_CODE"

printf '%s passed, %s failed\n' "$PASS" "$FAIL"
[[ "$FAIL" -eq 0 && "$PASS" -eq 5 ]]
