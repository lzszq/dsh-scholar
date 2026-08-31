#!/usr/bin/env bash
# PACK-01 / DSH-01: install the real private DSH host in a clean home, add a
# published Scholar bundle through DSH's public CLI, compose it, then prove a
# boot can start and dispose. Credentials live only in a 0600 temp userconfig.
set -euo pipefail

ALLOW_PENDING=0
if [[ "${1:-}" == "--allow-pending" ]]; then
  ALLOW_PENDING=1
  shift
fi
if [[ "$#" -ne 0 ]]; then
  echo "usage: $0 [--allow-pending]" >&2
  exit 64
fi

REGISTRY_URL="${DSH_PRIVATE_REGISTRY_URL:-}"
REGISTRY_TOKEN="${DSH_PRIVATE_REGISTRY_TOKEN:-${NPM_TOKEN:-}}"
DSH_SPEC="${DSH_PRIVATE_DSH_SPEC:-}"
SCHOLAR_SPEC="${DSH_SCHOLAR_PLUGIN_SPEC:-}"
PROFILE="${DSH_PRIVATE_PROFILE:-web}"
BOOT_SECONDS="${DSH_PRIVATE_BOOT_SECONDS:-8}"
REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"

pending() {
  echo "NOT_RUN_MANUAL_PENDING dsh-private-registry-install: $1"
  if [[ "$ALLOW_PENDING" -eq 1 && "${CI:-}" != "true" ]]; then
    exit 0
  fi
  exit 2
}

[[ -n "$REGISTRY_URL" ]] || pending "DSH_PRIVATE_REGISTRY_URL is not configured"
[[ -n "$REGISTRY_TOKEN" ]] || pending "DSH_PRIVATE_REGISTRY_TOKEN (or explicit NPM_TOKEN fallback) is not configured"
[[ -n "$SCHOLAR_SPEC" ]] || pending "DSH_SCHOLAR_PLUGIN_SPEC is not configured to a published/package artifact"
[[ "$REGISTRY_URL" =~ ^https://[^/@]+([/:][^@]*)?$ ]] || {
  echo "FAIL dsh-private-registry-install: registry must be an https URL without userinfo" >&2
  exit 2
}
[[ "$SCHOLAR_SPEC" =~ ^@dsh-scholar/research-plugin@[0-9]+\.[0-9]+\.[0-9]+([+-][0-9A-Za-z.-]+)?$ ]] || {
  echo "FAIL dsh-private-registry-install: DSH_SCHOLAR_PLUGIN_SPEC must pin an exact @dsh-scholar/research-plugin version" >&2
  exit 2
}
[[ -n "$DSH_SPEC" ]] || pending "DSH_PRIVATE_DSH_SPEC is not configured to the exact config/dsh-baseline.json version"
[[ "$DSH_SPEC" =~ ^@deepseek-ai/dsh@[0-9]+\.[0-9]+\.[0-9]+([+-][0-9A-Za-z.-]+)?$ ]] || {
  echo "FAIL dsh-private-registry-install: DSH_PRIVATE_DSH_SPEC must pin an exact @deepseek-ai/dsh version" >&2
  exit 2
}
BASELINE_VERSION="$(node -e 'const fs=require("node:fs"); const value=JSON.parse(fs.readFileSync(process.argv[1], "utf8")).version; if (typeof value !== "string") process.exit(2); process.stdout.write(value)' "$REPO_ROOT/config/dsh-baseline.json")" || {
  echo "FAIL dsh-private-registry-install: config/dsh-baseline.json has no valid version" >&2
  exit 2
}
EXPECTED_DSH_SPEC="@deepseek-ai/dsh@$BASELINE_VERSION"
[[ "$DSH_SPEC" == "$EXPECTED_DSH_SPEC" ]] || {
  echo "FAIL dsh-private-registry-install: DSH_PRIVATE_DSH_SPEC must equal $EXPECTED_DSH_SPEC" >&2
  exit 2
}
[[ "$BOOT_SECONDS" =~ ^[0-9]+$ ]] || {
  echo "FAIL dsh-private-registry-install: DSH_PRIVATE_BOOT_SECONDS must be a non-negative integer" >&2
  exit 2
}

if [[ -n "${PNPM_BIN:-}" ]]; then
  PNPM="$PNPM_BIN"
elif command -v pnpm >/dev/null 2>&1; then
  PNPM="$(command -v pnpm)"
else
  echo "FAIL dsh-private-registry-install: pnpm is required (or set PNPM_BIN)" >&2
  exit 127
fi

WORK="$(mktemp -d "${TMPDIR:-/tmp}/dsh-private-registry.XXXXXX")"
INSTALL_DIR="$WORK/launcher"
DSH_HOME_DIR="$WORK/dsh-home"
USERCONFIG="$WORK/npmrc"
LOG="$WORK/last-command.log"
BOOT_PID=""

cleanup() {
  if [[ -n "$BOOT_PID" ]] && kill -0 "$BOOT_PID" 2>/dev/null; then
    kill -TERM "$BOOT_PID" 2>/dev/null || true
    wait "$BOOT_PID" 2>/dev/null || true
  fi
  rm -rf -- "$WORK"
}
trap cleanup EXIT INT TERM

mkdir -p "$INSTALL_DIR" "$DSH_HOME_DIR"
chmod 700 "$WORK" "$INSTALL_DIR" "$DSH_HOME_DIR"

REGISTRY_BASE="${REGISTRY_URL%/}/"
AUTH_SCOPE="${REGISTRY_BASE#https://}"
umask 077
{
  printf 'registry=%s\n' "$REGISTRY_BASE"
  printf '@deepseek-ai:registry=%s\n' "$REGISTRY_BASE"
  printf '//%s:_authToken=%s\n' "$AUTH_SCOPE" "$REGISTRY_TOKEN"
  printf 'always-auth=true\n'
} >"$USERCONFIG"
chmod 600 "$USERCONFIG"

run_quiet() {
  local label="$1"
  shift
  : >"$LOG"
  if ! NPM_CONFIG_USERCONFIG="$USERCONFIG" npm_config_userconfig="$USERCONFIG" \
    DSH_HOME="$DSH_HOME_DIR" "$@" >"$LOG" 2>&1; then
    echo "FAIL dsh-private-registry-install: $label failed (command output withheld to protect registry credentials)" >&2
    exit 1
  fi
}

printf '{"name":"dsh-private-host-probe","private":true,"version":"0.0.0"}\n' >"$INSTALL_DIR/package.json"
run_quiet "private DSH install" "$PNPM" --dir "$INSTALL_DIR" add --save-exact "$DSH_SPEC"

DSH_BIN="$INSTALL_DIR/node_modules/.bin/dsh"
[[ -x "$DSH_BIN" ]] || {
  echo "FAIL dsh-private-registry-install: installed package exposes no dsh executable" >&2
  exit 1
}

HOST_REPORT="$WORK/host-report.json"
INSTALL_DIR="$INSTALL_DIR" DSH_SPEC="$DSH_SPEC" node --input-type=module - "$HOST_REPORT" <<'NODE'
import { realpathSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, sep } from 'node:path'
const installDir = process.env.INSTALL_DIR
const expected = process.env.DSH_SPEC.split('@').at(-1)
const require = createRequire(`${installDir}/probe.mjs`)
const manifestPath = require.resolve('@deepseek-ai/dsh/package.json')
const manifest = require(manifestPath)
const real = realpathSync(dirname(manifestPath))
if (!(real + sep).startsWith(realpathSync(installDir) + sep)) throw new Error(`DSH resolved outside clean install: ${real}`)
if (manifest.version !== expected) throw new Error(`DSH version drift: expected ${expected}, received ${manifest.version}`)
writeFileSync(process.argv[2], JSON.stringify({ name: manifest.name, version: manifest.version, realpath: real }))
NODE

# The installed CLI initializes the profile and its real private host graph.
run_quiet "DSH profile initialization" "$DSH_BIN" plugin --profile "$PROFILE" why @deepseek-ai/dsh-tools
run_quiet "Scholar plugin add" "$DSH_BIN" plugin --profile "$PROFILE" add --save-exact "$SCHOLAR_SPEC"
run_quiet "composed profile dump" "$DSH_BIN" --profile "$PROFILE" --dump-config
grep -q '@dsh-scholar/research-plugin' "$LOG" || {
  echo "FAIL dsh-private-registry-install: composed profile does not include @dsh-scholar/research-plugin" >&2
  exit 1
}

# A bounded real boot exercises Cordis apply. Surviving until the observation
# window and then exiting on SIGTERM is the public dispose/lifecycle seam.
: >"$LOG"
NPM_CONFIG_USERCONFIG="$USERCONFIG" npm_config_userconfig="$USERCONFIG" \
  DSH_HOME="$DSH_HOME_DIR" "$DSH_BIN" --profile "$PROFILE" >"$LOG" 2>&1 &
BOOT_PID=$!
deadline=$((SECONDS + BOOT_SECONDS))
while (( SECONDS < deadline )); do
  if ! kill -0 "$BOOT_PID" 2>/dev/null; then
    wait "$BOOT_PID" || true
    echo "FAIL dsh-private-registry-install: DSH/Cordis boot exited before the lifecycle window" >&2
    exit 1
  fi
  sleep 1
done
kill -TERM "$BOOT_PID"
wait "$BOOT_PID"
BOOT_PID=""

node --input-type=module - "$HOST_REPORT" <<'NODE'
import { readFileSync } from 'node:fs'
const host = JSON.parse(readFileSync(process.argv[2], 'utf8'))
process.stdout.write(`${JSON.stringify({
  status: 'PASS',
  scenario: 'dsh-private-registry-install',
  host: { name: host.name, version: host.version },
  clean_install: true,
  clean_dsh_home: true,
  profile_composed: true,
  cordis_apply_dispose: true,
  credentials_redacted: true,
})}\n`)
NODE
