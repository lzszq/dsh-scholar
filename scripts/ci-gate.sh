#!/usr/bin/env bash
# ci-gate.sh — local CI gateway (CI-01 local substitute; GitHub Actions not used).
#
# One command runs every blocking surface of the repository in order and the
# final exit code is non-zero when any step failed (exit != 0 == BLOCKED):
#
#   1. check:dsh-baseline — one source of truth for the tested DSH version
#   2. pnpm build       — schemas, kernel, UI browser bundle and DSH plugin
#   3. pnpm test        — root unit tests (vitest run) + research-ui typecheck
#   4. verify-docs      — node scripts/verify-docs.mjs (structure/links/contract
#                         fragments + forbidden embedded surface + SELFMOD-01)
#   5. security aggregator — CI=true bash tests/security/run-all-v2-blocking-tests.sh
#                         (fail-closed §19.2 suite; several scripts run real docker)
#   6. root plugin typecheck — pnpm --filter @dsh-scholar/research-plugin typecheck
#                         (only when the root package.json declares a typecheck script)
#
# Options:
#   --skip-security   skip step 5 (docker-dependent aggregator). NOTE: this
#                     lowers blocking evidence — skipped steps are reported as
#                     SKIP and never counted as PASS.
#   --help | -h       print this usage and exit.
#
# Design:
#   * set -eu: unhandled errors abort; step failures are captured so the
#     PASS/FAIL summary table still covers every step, then the gate exits 1.
#   * Every step prints a distinct header, start/stop time and duration; the
#     aggregator (step 5) can take minutes, so progress is printed live.
set -eu

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

usage() {
  sed -n '2,30p' "$0" | sed 's/^# \{0,1\}//'
}

SKIP_SECURITY=0
for a in "$@"; do
  case "$a" in
    --skip-security) SKIP_SECURITY=1 ;;
    --help|-h) usage; exit 0 ;;
    *) echo "ci-gate: unknown option: $a" >&2; usage >&2; exit 2 ;;
  esac
done

TOTAL=6
PASSED=()
FAILED=()
SKIPPED=()
START="$(date +%s)"

run_step() {
  local num="$1" name="$2"
  shift 2
  local s
  s="$(date +%s)"
  echo
  echo "=== [$num/$TOTAL] $name ==="
  echo "--- ci-gate: starting at $(date +%H:%M:%S) ---"
  if "$@"; then
    local elapsed=$(( $(date +%s) - s ))
    echo "--- ci-gate: PASS  [$num/$TOTAL] $name (${elapsed}s, done at $(date +%H:%M:%S)) ---"
    PASSED+=("$name")
  else
    local rc=$?
    local elapsed=$(( $(date +%s) - s ))
    echo "--- ci-gate: FAIL  [$num/$TOTAL] $name (exit $rc after ${elapsed}s, done at $(date +%H:%M:%S)) ---"
    FAILED+=("$name")
  fi
}

skip_step() {
  local num="$1" name="$2" reason="$3"
  echo
  echo "=== [$num/$TOTAL] $name ==="
  echo "--- ci-gate: SKIP  [$num/$TOTAL] $name — $reason ---"
  echo "--- ci-gate: NOTE  skipped steps never count as PASS; evidence is reduced ---"
  SKIPPED+=("$name")
}

# --- step 1/6: tested DSH version single source of truth --------------------
run_step 1 "check DSH compatibility baseline" pnpm run check:dsh-baseline

# --- step 2/6: production bundles -------------------------------------------
run_step 2 "pnpm build (schemas + kernel + UI + plugin)" pnpm run build

# --- step 3/6: root tests (vitest) + research-ui typecheck ------------------
run_step 3 "pnpm test (root: vitest + research-ui typecheck)" pnpm test

# --- step 4/6: docs static verification -------------------------------------
run_step 4 "verify-docs (node scripts/verify-docs.mjs)" node scripts/verify-docs.mjs

# --- step 5/6: §19.2 security aggregator (fail-closed under CI=true) --------
if [ "$SKIP_SECURITY" -eq 1 ]; then
  skip_step 5 "security aggregator (CI=true)" "--skip-security given (docker-dependent)"
else
  echo
  echo "NOTE: step 5 runs the full §19.2 aggregator (~20 per-concern scripts,"
  echo "several with real docker runs) — it can take several minutes."
  run_step 5 "security aggregator (CI=true)" env CI=true bash tests/security/run-all-v2-blocking-tests.sh
fi

# --- step 6/6: root plugin typecheck (only if the script exists) -------------
if node -e "const p = require('./package.json'); process.exit(p.scripts && p.scripts.typecheck ? 0 : 1)"; then
  run_step 6 "root plugin typecheck (--filter @dsh-scholar/research-plugin)" \
    pnpm --filter @dsh-scholar/research-plugin typecheck
else
  skip_step 6 "root plugin typecheck (--filter @dsh-scholar/research-plugin)" \
    "root package.json declares no typecheck script"
fi

# --- summary -----------------------------------------------------------------
echo
echo "=== ci-gate summary ==="
printf '%-46s %s\n' "step" "result"
for s in "${PASSED[@]}"; do printf '%-46s %s\n' "$s" "PASS"; done
for s in "${FAILED[@]}"; do printf '%-46s %s\n' "$s" "FAIL"; done
for s in "${SKIPPED[@]}"; do printf '%-46s %s\n' "$s" "SKIP"; done
echo "total: ${#PASSED[@]} passed, ${#FAILED[@]} failed, ${#SKIPPED[@]} skipped"
ELAPSED=$(( $(date +%s) - START ))
printf 'elapsed: %s (%dm %02ds)\n' "${ELAPSED}s" "$(( ELAPSED / 60 ))" "$(( ELAPSED % 60 ))"
if [ "${#FAILED[@]}" -gt 0 ]; then
  echo "ci-gate: GATE BLOCKED — exit 1 (fix the FAIL steps above)"
  exit 1
fi
echo "ci-gate: GATE PASSED — exit 0"
exit 0
