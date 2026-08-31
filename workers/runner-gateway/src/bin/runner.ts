#!/usr/bin/env node
/**
 * Runner gateway scheduler entry: claims jobs from the Kernel, executes them
 * in isolation, heartbeats leases, uploads artifacts and finalizes manifests.
 *
 * Durable Jobs (design §12.6): while a job executes, a heartbeat loop renews
 * the lease every `--heartbeat-ms`; a cancel watcher polls the job status and
 * calls cancelRun() so a cancel request terminates the REAL subprocess /
 * container, not just the lease. RunManifests are Ed25519-signed (§12.7);
 * the public key is registered with the kernel when it exposes
 * POST /v1/runner-keys before any claim or execution can begin.
 *
 * FLEET-01 (docs/remote-runner-wire.md §9 生产接线): the same binary also
 * serves the two fleet roles — `--fleet-server <port>` runs RemoteFleetServer
 * (HTTP + JSON wire, x-service-token auth, production must mTLS) and
 * `--agent <fleet-url>` runs the RemoteRunnerAgentImpl client loop
 * (register → heartbeat → poll claims → execute → frames/artifacts/complete,
 * offline spool). The roles are mutually exclusive with each other and with
 * the local claim loop (`--mode` is local-only); `resolveFleetMode` enforces
 * this before any cycle starts.
 *
 * Usage: node lib/bin/runner.js --kernel http://127.0.0.1:7412
 *   [--mode subprocess|docker] [--poll-ms 2000] [--owner <id>]
 *   [--timeout-ms 60000] [--heartbeat-ms 15000] [--cancel-poll-ms 5000]
 *   [--key-file <path>]
 *   [--fleet-server <port>] | [--agent <fleet-url> [--agent-id <id>]
 *   [--target-id <id>] [--fleet-public-key <pem-path>]]
 *
 * CONFIG-01: the CLI surface is parsed by the canonical Config Registry
 * (parseCli) — flags, defaults and validation are the registry's single
 * source of truth; `--help` prints the registry-generated help text.
 * @module @dsh-scholar/runner-gateway/bin
 */

import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, randomUUID } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { ResearchClient } from '@dsh-scholar/research-client'
import {
  cancelRun,
  createFleetServer,
  executeJob,
  FleetCliConfigError,
  generateAgentId,
  heartbeatLoop,
  resolveFleetMode,
  resolveTargetId,
  runFleetAgentMain,
  resolveSshBootstrap,
  startSshAgentBootstrap,
  startFleetServer,
  type RunnerMode,
  type RunnerSigningKey,
} from '../index.js'
import { validateConfig, parseCli, generateCliHelp, ConfigRegistryError } from '@dsh-scholar/research-schemas'
import { registerRunnerKeyRequired } from '../runner-key-registration.js'

const argv = process.argv.slice(2)
if (argv.includes('--help') || argv.includes('-h')) {
  console.log(`Runner gateway — durable job scheduler (design §12.6) + fleet server/agent (FLEET-01)\nUsage: node lib/bin/runner.js [options]\n\n${generateCliHelp('runner-profile')}`)
  process.exit(0)
}

let cli: Record<string, unknown>
try {
  cli = parseCli(argv, 'runner-profile')
} catch (error) {
  console.error(`[runner-gateway] invalid config: ${error instanceof ConfigRegistryError ? error.message : (error as Error).message}`)
  process.exit(1)
}

const endpoint = (cli['runner.kernel'] as string | undefined) ?? 'http://127.0.0.1:7412'
const mode = (cli['runner.mode'] as RunnerMode | undefined) ?? 'subprocess'
const pollMs = (cli['runner.poll_ms'] as number | undefined) ?? 2000
const timeoutMs = (cli['runner.timeout_ms'] as number | undefined) ?? 60000
const heartbeatMs = (cli['runner.heartbeat_ms'] as number | undefined) ?? 15000
const cancelPollMs = (cli['runner.cancel_poll_ms'] as number | undefined) ?? 5000
const keyFile = cli['runner.key_file'] as string | undefined
const owner = (cli['runner.owner'] as string | undefined) ?? `runner-${randomUUID().slice(0, 8)}`
const serviceToken = process.env.DSH_SCHOLAR_SERVICE_TOKEN
const runnerTargetToken = process.env.DSH_SCHOLAR_RUNNER_TARGET_TOKEN
// §5 P0-1 (hardening API-01/SIDE-01): the runner's kernel bearer token.
// The process env is inherited by a runner spawned from a controlled host;
// credential values are deliberately absent from argv and generated help.
const token = process.env.DSH_SCHOLAR_KERNEL_TOKEN

// CONFIG-01: the runner's effective config is validated through the
// canonical Config Registry before any claim cycle (unknown keys / invalid
// values / security-floor violations fail fast; error messages never echo
// secret values). The one-way sha256 pin is logged so running runners can be
// correlated with the config that produced them.
try {
  const resolved = validateConfig(cli, { scopes: ['runner-profile'] })
  console.error(`[runner-gateway] config pin ${resolved.pinHash}`)
} catch (error) {
  console.error(`[runner-gateway] invalid config: ${error instanceof ConfigRegistryError ? error.message : (error as Error).message}`)
  process.exit(1)
}

const client = new ResearchClient({ endpoint, token, serviceToken, runnerTargetToken })

// ── FLEET-01: fleet 角色互斥判定（local 默认；fleet-server/agent 二选一，
//    且与本地模式专属 flag --mode 互斥；校验失败 fail fast）。────────────
const sshBootstrapTarget = (cli['runner.ssh_bootstrap_target'] as string | undefined) ?? ''
let fleetMode: 'local' | 'fleet-server' | 'agent' | 'ssh-bootstrap'
try {
  if (sshBootstrapTarget !== '') {
    if (typeof cli['runner.fleet_url'] !== 'string' || cli['runner.fleet_url'] === '') {
      throw new FleetCliConfigError('--ssh-bootstrap-target requires --agent <fleet-url>')
    }
    if (typeof cli['runner.fleet_server_port'] === 'number') {
      throw new FleetCliConfigError('--ssh-bootstrap-target cannot be combined with --fleet-server')
    }
    fleetMode = 'ssh-bootstrap'
  } else {
    fleetMode = resolveFleetMode(cli)
  }
} catch (error) {
  console.error(`[runner-gateway] invalid config: ${error instanceof FleetCliConfigError ? error.message : (error as Error).message}`)
  process.exit(1)
}

/** SIGINT/SIGTERM → abort signal（fleet 角色用；本地模式保留既有 stopping 语义）。 */
function fleetShutdownSignal(): AbortSignal {
  const controller = new AbortController()
  const onSignal = (): void => {
    console.error('[runner-gateway] stopping')
    controller.abort()
  }
  process.on('SIGINT', onSignal)
  process.on('SIGTERM', onSignal)
  return controller.signal
}

/**
 * --fleet-server <port>：RemoteFleetServer（HTTP + JSON wire，x-service-token
 * 鉴权；生产必须 mTLS——docs/remote-runner-wire.md §3/§9）。kernel client 复用
 * 本地 runner 同一 ResearchClient 路径（lease/run_id/Manifest 跨 Local/Remote
 * 一致）；plan 签名密钥 = --key-file 或临时生成的 Ed25519 密钥（公钥打印到
 * stderr，供 --fleet-public-key 配给 agent）。
 */
async function runFleetServerMain(): Promise<void> {
  const { key: signingKey, publicKeyPem } = loadOrCreateSigningKey(keyFile)
  const fleet = createFleetServer(client, {
    owner,
    signingKey,
    timeoutMs,
    leaseTtlSeconds: 300,
  })
  const { server, baseUrl } = await startFleetServer(fleet, {
    port: (cli['runner.fleet_server_port'] as number | undefined) ?? 0,
    serviceToken,
  })
  console.error(`[runner-gateway] fleet server listening on ${baseUrl} (owner=${owner}, kernel=${endpoint})`)
  console.error(`[runner-gateway] plan signing public key PEM (SPKI) — distribute to agents via --fleet-public-key:\n${publicKeyPem}`)
  console.error('[runner-gateway] WARNING: x-service-token auth only; production requires mTLS service identity (docs/remote-runner-wire.md §3)')
  const signal = fleetShutdownSignal()
  await new Promise<void>(resolve => {
    signal.addEventListener('abort', () => {
      server.closeAllConnections()
      server.close(() => resolve())
    }, { once: true })
  })
  console.error('[runner-gateway] fleet server stopped')
  process.exit(0)
}

/**
 * --agent <fleet-url>：RemoteRunnerAgentImpl 客户端循环（register → heartbeat
 * → poll claims → 执行 → frames/artifacts/complete；离线有界 spool 复用
 * AgentOutboundSpool）。plan 验签公钥经 --fleet-public-key 配置（缺省 → 任何
 * plan 拒绝执行，fail closed）；run_manifest 签名密钥 = --key-file；显式提供
 * --kernel 时必须先把该公钥注册到对应 kernel（§12.7，失败即停止）。
 */
async function runFleetAgentMainCli(): Promise<void> {
  const fleetUrl = cli['runner.fleet_url'] as string
  let parsedUrl: URL
  try {
    parsedUrl = new URL(fleetUrl)
  } catch {
    console.error(`[runner-gateway] invalid --agent URL: ${JSON.stringify(fleetUrl)}`)
    process.exit(1)
  }
  const { key: signingKey, publicKeyPem } = loadOrCreateSigningKey(keyFile)
  const fleetPublicKeyFile = cli['runner.fleet_public_key'] as string | undefined
  const fleetPublicKey = fleetPublicKeyFile !== undefined && fleetPublicKeyFile !== '' && existsSync(fleetPublicKeyFile)
    ? readFileSync(fleetPublicKeyFile, 'utf8')
    : undefined
  const agentId = (cli['runner.agent_id'] as string | undefined) ?? generateAgentId()
  const targetId = resolveTargetId(cli['runner.fleet_target_id'] as string | undefined)
  const runnerVersion = packageVersion()

  // An explicitly connected Kernel must accept the manifest key before this
  // agent starts polling. There is no unsigned/compatibility execution path.
  if ('runner.kernel' in cli) {
    await registerRunnerKeyOrExit(signingKey.keyId, publicKeyPem, 10_000)
  }

  console.error(`[runner-gateway] agent ${agentId} (target=${targetId}) polling ${parsedUrl.origin}${parsedUrl.pathname} (poll=${pollMs}ms, key=${signingKey.keyId}${fleetPublicKey === undefined ? ', NO fleet public key — plans will be refused (fail closed)' : ''})`)
  const signal = fleetShutdownSignal()
  const runs = await runFleetAgentMain({
    fleetUrl,
    serviceToken,
    agentId,
    targetId,
    runnerVersion,
    publicKeyPem: fleetPublicKey,
    signingKey,
    pollIntervalMs: pollMs,
    registerMaxWaitMs: 60_000,
    signal,
  })
  console.error(`[runner-gateway] agent ${agentId} stopped after ${runs} run(s)`)
  process.exit(0)
}

/**
 * --ssh-bootstrap-target <id>：从 Kernel Target Registry 读取仅含
 * SecretRef metadata 的 remote-ssh descriptor，在本机 secret root 解析
 * endpoint/key/known_hosts，以 StrictHostKeyChecking=yes 建立 SSH，并用
 * 固定命令启动远端 fleet agent。Job 仍由 fleet 的签名 plan/lease/CAS wire
 * 传输；SSH 不成为任意命令执行面。
 */
async function runSshBootstrapMain(): Promise<void> {
  const fleetUrl = cli['runner.fleet_url'] as string
  const secretRoot = (cli['runner.secret_root'] as string | undefined) ?? ''
  const fleetPublicKeyFile = (cli['runner.fleet_public_key'] as string | undefined) ?? ''
  if (secretRoot === '') throw new FleetCliConfigError('--ssh-bootstrap-target requires --secret-root')
  if (fleetPublicKeyFile === '' || !existsSync(fleetPublicKeyFile)) {
    throw new FleetCliConfigError('--ssh-bootstrap-target requires an existing --fleet-public-key file')
  }
  const target = await client.getRunnerTarget(sshBootstrapTarget)
  const resolved = resolveSshBootstrap(target, secretRoot)
  const agentId = (cli['runner.agent_id'] as string | undefined) || `${sshBootstrapTarget}-agent`
  const { key: manifestKey, publicKeyPem } = loadOrCreateSigningKey(keyFile)
  // Register before SSH starts: a remote completion signed by this key is
  // immediately verifiable at the central kernel.
  await registerRunnerKeyOrExit(manifestKey.keyId, publicKeyPem, 30_000)
  const privateKeyPem = manifestKey.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()
  const handle = startSshAgentBootstrap({
    resolved,
    fleetUrl,
    agentId,
    connectTimeoutMs: (cli['runner.ssh_connect_timeout_ms'] as number | undefined) ?? 15000,
    fleetPublicKeyPem: readFileSync(fleetPublicKeyFile, 'utf8'),
    manifestPrivateKeyPem: privateKeyPem,
    onStdout: text => process.stdout.write(text),
    onStderr: text => process.stderr.write(text),
  })
  console.error(`[runner-gateway] SSH bootstrap active for target ${sshBootstrapTarget} (agent=${agentId}); endpoint is redacted`)
  const signal = fleetShutdownSignal()
  signal.addEventListener('abort', () => handle.child.kill('SIGTERM'), { once: true })
  const code = await handle.completion
  console.error(`[runner-gateway] SSH bootstrap for target ${sshBootstrapTarget} exited (${code})`)
  process.exit(code)
}

if (fleetMode === 'fleet-server') {
  await runFleetServerMain()
}
if (fleetMode === 'agent') {
  await runFleetAgentMainCli()
}
if (fleetMode === 'ssh-bootstrap') {
  await runSshBootstrapMain()
}

/** runner_ver capability：从本包 package.json 读取（与发布版本一致）。 */
function packageVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as { version?: unknown }
    return typeof pkg.version === 'string' && pkg.version !== '' ? pkg.version : '0.1.0'
  } catch {
    return '0.1.0'
  }
}

/**
 * Load the Ed25519 signing key from --key-file, or generate an ephemeral one
 * (public key printed to stderr for tests, §12.7). A generated key is
 * persisted to --key-file when provided so restarts keep the same identity.
 */
function loadOrCreateSigningKey(file: string | undefined): { key: RunnerSigningKey; publicKeyPem: string } {
  if (file !== undefined && existsSync(file)) {
    const privateKey = createPrivateKey(readFileSync(file, 'utf8'))
    const publicKeyPem = createPublicKey(privateKey).export({ type: 'spki', format: 'pem' }).toString()
    const keyId = `runner-${createHash('sha256').update(publicKeyPem).digest('hex').slice(0, 16)}`
    console.error(`[runner-gateway] loaded signing key ${keyId} from ${file}`)
    return { key: { keyId, privateKey }, publicKeyPem }
  }
  const { privateKey, publicKey } = generateKeyPairSync('ed25519')
  const publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' }).toString()
  const keyId = `runner-${createHash('sha256').update(publicKeyPem).digest('hex').slice(0, 16)}`
  console.error(`[runner-gateway] generated ephemeral signing key ${keyId}`)
  console.error(`[runner-gateway] public key PEM (SPKI):\n${publicKeyPem}`)
  if (file !== undefined) {
    writeFileSync(file, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 })
    console.error(`[runner-gateway] saved private key to ${file}`)
  }
  return { key: { keyId, privateKey }, publicKeyPem }
}

/** Required public-key registration (§12.7). No compatibility mode exists. */
async function registerRunnerKeyOrExit(keyId: string, publicKeyPem: string, maxWaitMs = 60_000): Promise<void> {
  try {
    await registerRunnerKeyRequired(client, { keyId, publicKeyPem, maxWaitMs })
    console.error(`[runner-gateway] runner key ${keyId} registered with kernel`)
  } catch (error) {
    console.error(`[runner-gateway] FATAL: ${error instanceof Error ? error.message : 'runner manifest key registration failed'}`)
    process.exit(1)
  }
}

const { key: signingKey, publicKeyPem } = loadOrCreateSigningKey(keyFile)

console.error(`[runner-gateway] ${owner} polling ${endpoint} (mode=${mode}, poll=${pollMs}ms, heartbeat=${heartbeatMs}ms, cancel-poll=${cancelPollMs}ms, key=${signingKey.keyId})`)

const configuredLocalTargetId = (cli['runner.fleet_target_id'] as string | undefined)?.trim()
const localTargetId = configuredLocalTargetId !== undefined && configuredLocalTargetId !== ''
  ? configuredLocalTargetId
  : mode === 'docker' ? 'target_local_docker_v1' : 'target_local_process_v1'

// The shared service token gates internal routes, while this independent
// target token proves that this runner is allowlisted for localTargetId. A
// missing target token never falls back to a caller-supplied id/principal;
// the target remains unobserved and readiness expires fail closed.
let nextTargetHeartbeatAt = 0
async function heartbeatLocalTarget(): Promise<void> {
  if (runnerTargetToken === undefined || runnerTargetToken === '' || Date.now() < nextTargetHeartbeatAt) return
  const target = await client.getRunnerTarget(localTargetId)
  await client.heartbeatRunnerTarget(localTargetId, { expected_revision: target.revision, health: 'online' })
  nextTargetHeartbeatAt = Date.now() + Math.max(10_000, Math.min(heartbeatMs, 30_000))
}

// Register the public key once at startup before the first claim.
await registerRunnerKeyOrExit(signingKey.keyId, publicKeyPem)
await heartbeatLocalTarget().catch(error => {
  console.error(`[runner-gateway] target heartbeat rejected for ${localTargetId}: ${(error as Error).message}`)
})

let stopping = false
const shutdown = (): void => {
  stopping = true
  console.error('[runner-gateway] stopping')
  setTimeout(() => process.exit(0), 500).unref()
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)

while (!stopping) {
  try {
    await heartbeatLocalTarget().catch(error => {
      console.error(`[runner-gateway] target heartbeat rejected for ${localTargetId}: ${(error as Error).message}`)
      nextTargetHeartbeatAt = Date.now() + 10_000
    })
    // Recover stale leases on every cycle (self-healing after crashes, §9.3).
    await client.recoverExpiredLeases().catch(() => undefined)
    const localTargetKind = mode === 'docker' ? 'local-docker' : 'local-process'
    const jobs = await client.claimJobs(owner, 1, 300, {
      runner_target_kinds: [localTargetKind],
      runner_target_ids: [localTargetId],
      // Jobs created before target pinning existed remain executable by the
      // explicitly selected local mode. New jobs are always target-pinned.
      include_unpinned: true,
    })
    for (const job of jobs) {
      if (stopping) break
      console.error(`[runner-gateway] executing ${job.kind} job ${job.job_id}`)
      // §12.6: heartbeat the lease while the job runs; a cancel watcher polls
      // the kernel and terminates the REAL execution when the job is cancelled.
      const heartbeatAc = new AbortController()
      const executeAc = new AbortController()
      heartbeatLoop(job.job_id, owner, client, heartbeatMs, heartbeatAc.signal, job.lease_generation, job.lease_token)
      const cancelWatcher = setInterval(() => {
        void client.getJob(job.job_id).then(current => {
          if (current.status === 'cancelled' && !executeAc.signal.aborted) {
            console.error(`[runner-gateway] job ${job.job_id} cancelled — terminating execution`)
            cancelRun(job.job_id)
            heartbeatAc.abort()
            executeAc.abort()
          }
        }).catch(() => undefined)
      }, cancelPollMs)
      try {
        const { job: completed } = await executeJob(job, {
          client, owner, mode, timeoutMs, signal: executeAc.signal, signingKey, targetId: localTargetId,
        })
        console.error(`[runner-gateway] job ${job.job_id} → ${completed.status}`)
      } catch (error) {
        console.error(`[runner-gateway] job ${job.job_id} failed at gateway level:`, (error as Error).message)
        await client.completeJob({
          job_id: job.job_id,
          owner,
          status: 'failed',
          failure_class: 'unknown',
          error: `gateway error: ${(error as Error).message}`,
          // §12.6 fencing (P0): the job is leased — completion MUST carry the
          // claim's generation/token or the kernel rejects it (409 lease_stale).
          lease_generation: job.lease_generation,
          lease_token: job.lease_token,
        }).catch(() => undefined)
      } finally {
        clearInterval(cancelWatcher)
        heartbeatAc.abort()
        executeAc.abort()
      }
    }
  } catch (error) {
    const message = (error as Error).message ?? String(error)
    if (message.includes('unreachable')) {
      console.error(`[runner-gateway] kernel unreachable (${endpoint}) — retrying in ${pollMs}ms`)
    } else {
      console.error('[runner-gateway] error:', message)
    }
  }
  await new Promise(resolve => setTimeout(resolve, pollMs))
}
