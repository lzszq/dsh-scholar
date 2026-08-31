#!/usr/bin/env bash
# ci-gate.sh — local CI gateway (CI-01 local substitute; GitHub Actions not used).
#
# One command runs every blocking surface of the repository in order and the
# final exit code is non-zero when any step failed (exit != 0 == BLOCKED):
#
#   1. check:dsh-baseline — one source of truth for the tested DSH version
#   2. pnpm build       — schemas, kernel, UI browser bundle and DSH plugin
#   3. pnpm test        — root unit tests (vitest run) + research-ui typecheck
#   4. verify-docs      — static verification + origin/main diff contract
#   5. whitespace diff — working tree and origin/main commit-range checks
#   6. security aggregator — CI=true bash tests/security/run-all-v2-blocking-tests.sh
#                         (fail-closed §19.2 suite; several scripts run real docker)
#   7. root plugin typecheck — pnpm --filter @dsh-scholar/research-plugin typecheck
#
# Options:
#   --skip-security   skip step 6 (docker-dependent aggregator). NOTE: this
#                     lowers blocking evidence — skipped steps are reported as
#                     SKIP and the command exits non-zero; forbidden with CI=true.
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

if [ "${CI:-}" = "true" ] && [ "$SKIP_SECURITY" -eq 1 ]; then
  echo "ci-gate: --skip-security is forbidden when CI=true" >&2
  exit 2
fi

TOTAL=7
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

# --- step 1/7: tested DSH version single source of truth --------------------
run_step 1 "check DSH compatibility baseline" pnpm run check:dsh-baseline

# --- step 2/7: production bundles -------------------------------------------
run_step 2 "pnpm build (schemas + kernel + UI + plugin)" pnpm run build

# --- step 3/7: root tests (vitest) + research-ui typecheck ------------------
run_step 3 "pnpm test (root: vitest + research-ui typecheck)" pnpm test

# --- step 4/7: docs static + change contract --------------------------------
run_step 4 "verify-docs (--diff-check origin/main)" node scripts/verify-docs.mjs --diff-check origin/main

# --- step 5/7: whitespace/conflict-marker checks -----------------------------
run_step 5 "git diff --check (working tree + origin/main range)" \
  bash -c 'git diff --check && git diff --check origin/main...HEAD'

# --- step 6/7: §19.2 security aggregator (fail-closed under CI=true) --------
if [ "$SKIP_SECURITY" -eq 1 ]; then
  skip_step 6 "security aggregator (CI=true)" "--skip-security given (docker-dependent)"
else
  echo
  echo "NOTE: step 6 runs the full §19.2 aggregator (~20 per-concern scripts,"
  echo "several with real docker runs) — it can take several minutes."
  run_step 6 "security aggregator (CI=true)" env CI=true bash tests/security/run-all-v2-blocking-tests.sh
fi

# --- step 7/7: root plugin typecheck -----------------------------------------
run_step 7 "root plugin typecheck (--filter @dsh-scholar/research-plugin)" \
  pnpm --filter @dsh-scholar/research-plugin typecheck

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
if [ "${#FAILED[@]}" -gt 0 ] || [ "${#SKIPPED[@]}" -gt 0 ]; then
  echo "ci-gate: GATE BLOCKED — exit 1 (FAIL or SKIP is not release evidence)"
  exit 1
fi
echo "ci-gate: GATE PASSED — exit 0"
exit 0
