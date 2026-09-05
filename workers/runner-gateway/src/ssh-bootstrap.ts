/**
 * EXEC-ENV-02 remote-SSH bootstrap adapter.
 *
 * SSH is used only to start the signed RemoteRunnerAgent on a configured
 * machine. Jobs still travel through RemoteFleetServer as immutable signed
 * ExecutionPlans; project input can never supply a host, key, ProxyCommand
 * or arbitrary remote shell command.
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { readFileSync, realpathSync, statSync } from 'node:fs'
import { resolve, sep } from 'node:path'

export interface SshSecretRefView {
  scheme: 'file' | 'keyring' | 'vault'
  name: string
  available: boolean
}

export interface RemoteSshTargetView {
  target_id: string
  kind: 'local-process' | 'local-docker' | 'remote-ssh'
  enabled: boolean
  draining: boolean
  service_identity?: SshSecretRefView
  connection?: {
    endpoint: SshSecretRefView
    credential: SshSecretRefView
    known_hosts: SshSecretRefView
  }
}

export interface RemoteSshEndpoint {
  host: string
  port: number
  user: string
}

export interface ResolvedSshBootstrap {
  target_id: string
  endpoint: RemoteSshEndpoint
  credential_file: string
  known_hosts_file: string
  target_identity_file: string
}

export class SshBootstrapError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SshBootstrapError'
  }
}

function resolveSecretFile(secretRoot: string, ref: SshSecretRefView, label: string): string {
  if (ref.scheme !== 'file') throw new SshBootstrapError(`${label} SecretRef scheme ${ref.scheme} has no resolver in this runner instance`)
  if (!ref.available) throw new SshBootstrapError(`${label} SecretRef is unavailable`)
  const root = realpathSync(secretRoot)
  const candidate = realpathSync(resolve(root, ref.name))
  if (candidate !== root && !candidate.startsWith(`${root}${sep}`)) {
    throw new SshBootstrapError(`${label} SecretRef escapes the configured secret root`)
  }
  if (!statSync(candidate).isFile()) throw new SshBootstrapError(`${label} SecretRef does not resolve to a regular file`)
  return candidate
}

export function parseRemoteSshEndpoint(text: string): RemoteSshEndpoint {
  let value: unknown
  try { value = JSON.parse(text) } catch { throw new SshBootstrapError('endpoint SecretRef is not valid JSON') }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new SshBootstrapError('endpoint must be a JSON object')
  const record = value as Record<string, unknown>
  const keys = Object.keys(record).sort()
  if (keys.join(',') !== 'host,port,user') throw new SshBootstrapError('endpoint accepts exactly host, port and user')
  if (typeof record.host !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9.:-]{0,252}$/.test(record.host)) {
    throw new SshBootstrapError('endpoint host is invalid')
  }
  if (!Number.isInteger(record.port) || (record.port as number) < 1 || (record.port as number) > 65535) {
    throw new SshBootstrapError('endpoint port must be an integer from 1 to 65535')
  }
  if (typeof record.user !== 'string' || !/^[A-Za-z_][A-Za-z0-9_-]{0,31}$/.test(record.user)) {
    throw new SshBootstrapError('endpoint user is invalid')
  }
  return { host: record.host, port: record.port as number, user: record.user }
}

/** Resolve server-side SecretRefs. The credential must not be group/world
 * accessible; endpoint and host-key files may be read-only shared config. */
export function resolveSshBootstrap(target: RemoteSshTargetView, secretRoot: string): ResolvedSshBootstrap {
  if (target.kind !== 'remote-ssh') throw new SshBootstrapError(`target ${target.target_id} is not remote-ssh`)
  if (!target.enabled || target.draining) throw new SshBootstrapError(`target ${target.target_id} is disabled or draining`)
  if (target.connection === undefined) throw new SshBootstrapError(`target ${target.target_id} has no SSH SecretRefs`)
  if (target.service_identity === undefined) throw new SshBootstrapError('target has no service identity SecretRef')
  const endpointFile = resolveSecretFile(secretRoot, target.connection.endpoint, 'endpoint')
  const credentialFile = resolveSecretFile(secretRoot, target.connection.credential, 'credential')
  const knownHostsFile = resolveSecretFile(secretRoot, target.connection.known_hosts, 'known_hosts')
  const targetIdentityFile = resolveSecretFile(secretRoot, target.service_identity, 'service identity')
  if ((statSync(credentialFile).mode & 0o077) !== 0) {
    throw new SshBootstrapError('credential file must not be group/world accessible (expected mode 0600 or stricter)')
  }
  if ((statSync(targetIdentityFile).mode & 0o777) !== 0o600) throw new SshBootstrapError('target identity file must have mode 0600')
  return {
    target_id: target.target_id,
    endpoint: parseRemoteSshEndpoint(readFileSync(endpointFile, 'utf8')),
    credential_file: credentialFile,
    known_hosts_file: knownHostsFile,
    target_identity_file: targetIdentityFile,
  }
}

function shellQuote(value: string): string { return `'${value.replaceAll("'", `'\"'\"'`)}'` }

/** Build OpenSSH argv with strict pinned-host verification. No caller can
 * inject ProxyCommand, LocalCommand, forwarding or a remote executable. */
export function buildSshBootstrapArgs(input: {
  resolved: ResolvedSshBootstrap
  fleetUrl: string
  agentId: string
  connectTimeoutMs: number
}): string[] {
  const fleet = new URL(input.fleetUrl)
  if (fleet.protocol !== 'https:' && fleet.protocol !== 'http:') throw new SshBootstrapError('fleet URL must use http or https')
  if (!Number.isInteger(input.connectTimeoutMs) || input.connectTimeoutMs < 1000) throw new SshBootstrapError('SSH connect timeout must be at least 1000ms')
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/.test(input.agentId)) throw new SshBootstrapError('agent id is invalid')
  const { endpoint, credential_file: credential, known_hosts_file: knownHosts, target_id: targetId } = input.resolved
  const remote = [
    'umask 077',
    'key_file=$(mktemp "${TMPDIR:-/tmp}/dsh-scholar-fleet-key.XXXXXX")',
    'manifest_key_file=$(mktemp "${TMPDIR:-/tmp}/dsh-scholar-manifest-key.XXXXXX")',
    'trap \'rm -f "$key_file" "$manifest_key_file"\' EXIT HUP INT TERM',
    'IFS= read -r fleet_key_b64',
    'IFS= read -r manifest_key_b64',
    'IFS= read -r service_token_b64',
    'IFS= read -r target_token_b64',
    'printf %s "$fleet_key_b64" | base64 -d > "$key_file"',
    'printf %s "$manifest_key_b64" | base64 -d > "$manifest_key_file"',
    'export DSH_SCHOLAR_SERVICE_TOKEN="$(printf %s "$service_token_b64" | base64 -d)"',
    'export DSH_SCHOLAR_RUNNER_TARGET_TOKEN="$(printf %s "$target_token_b64" | base64 -d)"',
    `dsh-scholar-runner --agent ${shellQuote(fleet.toString())} --agent-id ${shellQuote(input.agentId)} --target-id ${shellQuote(targetId)} --fleet-public-key "$key_file" --key-file "$manifest_key_file"`,
    'exit_code=$?',
    'rm -f "$key_file" "$manifest_key_file"',
    'exit "$exit_code"',
  ].join('; ')
  return [
    '-T',
    '-o', 'BatchMode=yes',
    '-o', 'StrictHostKeyChecking=yes',
    '-o', `UserKnownHostsFile=${knownHosts}`,
    '-o', 'IdentitiesOnly=yes',
    '-o', `ConnectTimeout=${Math.ceil(input.connectTimeoutMs / 1000)}`,
    '-o', 'ServerAliveInterval=15',
    '-o', 'ServerAliveCountMax=3',
    '-i', credential,
    '-p', String(endpoint.port),
    `${endpoint.user}@${endpoint.host}`,
    remote,
  ]
}

export interface SshBootstrapHandle {
  child: ChildProcessWithoutNullStreams
  completion: Promise<number>
}

/** Start and supervise the remote agent. The plan-verification public key and
 * a short-lived manifest signing key travel only inside encrypted SSH stdin
 * and are installed as 0600 temp files; SSH credentials never leave the
 * bootstrap host. Child stderr is endpoint-redacted before operator logs. */
export function startSshAgentBootstrap(input: {
  resolved: ResolvedSshBootstrap
  fleetUrl: string
  agentId: string
  connectTimeoutMs: number
  fleetPublicKeyPem: string
  manifestPrivateKeyPem: string
  serviceToken?: string
  spawnProcess?: typeof spawn
  onStdout?: (text: string) => void
  onStderr?: (text: string) => void
}): SshBootstrapHandle {
  const args = buildSshBootstrapArgs(input)
  const targetToken = readFileSync(input.resolved.target_identity_file, 'utf8').trim()
  if (Buffer.byteLength(targetToken) < 32 || Buffer.byteLength(targetToken) > 4096 || /[\r\n]/.test(targetToken)) {
    throw new SshBootstrapError('target identity token is invalid')
  }
  const spawnProcess = input.spawnProcess ?? spawn
  const child = spawnProcess('ssh', args, { stdio: ['pipe', 'pipe', 'pipe'] }) as ChildProcessWithoutNullStreams
  child.stdin.end([input.fleetPublicKeyPem, input.manifestPrivateKeyPem, input.serviceToken ?? '', targetToken]
    .map(value => Buffer.from(value).toString('base64')).join('\n') + '\n')
  child.stdout.on('data', chunk => input.onStdout?.(String(chunk)))
  child.stderr.on('data', chunk => {
    const endpoint = input.resolved.endpoint
    const redacted = String(chunk).replaceAll(`${endpoint.user}@${endpoint.host}`, '[remote]').replaceAll(endpoint.host, '[remote-host]')
    input.onStderr?.(redacted)
  })
  const completion = new Promise<number>((resolveCompletion, reject) => {
    child.once('error', reject)
    child.once('close', code => resolveCompletion(code ?? 1))
  })
  return { child, completion }
}
