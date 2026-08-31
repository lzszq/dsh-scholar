/**
 * Research Kernel entry — sidecar process (design §9.1 Local Desktop Profile).
 * Usage: node lib/bin/kernel.js --db <path> --cas <dir> [--port 7412]
 *        [--endpoint-file <path>]
 *        Secrets are supplied out-of-band via DSH_SCHOLAR_KERNEL_TOKEN /
 *        DSH_SCHOLAR_SERVICE_TOKEN; DSH_SCHOLAR_DSH_PLUGIN_TOKEN is the
 *        route-specific create/link secret.
 *
 * CONFIG-01: the CLI surface is parsed by the canonical Config Registry
 * (parseCli) — flags, defaults and validation are the registry's single
 * source of truth; `--help` prints the registry-generated help text.
 * @module @dsh-scholar/research-kernel/bin
 */

import { basename, dirname, join, resolve } from 'node:path'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { ResearchKernel } from '../kernel.js'
import { startKernelServer } from '../server.js'
import { LocalPtyAdapter } from '../pty-local.js'
import { createStartupBackup } from '../backup.js'
import { validateConfig, parseCli, generateCliHelp, ConfigRegistryError } from '@dsh-scholar/research-schemas'

const argv = process.argv.slice(2)
if (argv.includes('--help') || argv.includes('-h')) {
  console.log(`Research Kernel — sidecar process (design §9.1)\nUsage: node lib/bin/kernel.js [options]\n\n${generateCliHelp('kernel')}`)
  process.exit(0)
}

// STORAGE-07 (storage-migrations.md §8.2): opt-in pre-migration backup +
// CAS inventory hook. --backup-on-start (stripped before the Config
// Registry parses the CLI — the registry owns the kernel.* keys, this flag
// is a bin-level operator switch) or DSH_SCHOLAR_BACKUP_ON_START=1, default
// OFF. The backup runs BEFORE the kernel opens/migrates the database, so it
// captures the pre-migration state (restore target if a migration fails).
const backupOnStart = argv.includes('--backup-on-start')
  || /^(1|true|yes)$/i.test(process.env.DSH_SCHOLAR_BACKUP_ON_START ?? '')
if (backupOnStart) {
  const flagIdx = argv.indexOf('--backup-on-start')
  if (flagIdx !== -1) argv.splice(flagIdx, 1)
}

let cli: Record<string, unknown>
try {
  cli = parseCli(argv, 'kernel')
} catch (error) {
  console.error(`[research-kernel] invalid config: ${error instanceof ConfigRegistryError ? error.message : (error as Error).message}`)
  process.exit(1)
}

const dbPath = (cli['kernel.db'] as string | undefined) ?? join(mkdtempSync(join(tmpdir(), 'research-kernel-')), 'kernel.db')
const casRoot = (cli['kernel.cas'] as string | undefined) ?? join(process.cwd(), '.research-cas')
const secretRoot = (cli['kernel.secret_root'] as string | undefined) ?? process.env.DSH_SCHOLAR_SECRET_ROOT ?? null
const port = (cli['kernel.port'] as number | undefined) ?? 7412
const host = (cli['kernel.host'] as string | undefined) ?? '127.0.0.1'
// Secrets are never accepted on argv, where process listings can expose them.
const token = process.env.DSH_SCHOLAR_KERNEL_TOKEN
const serviceToken = process.env.DSH_SCHOLAR_SERVICE_TOKEN
const dshPluginToken = process.env.DSH_SCHOLAR_DSH_PLUGIN_TOKEN
const orchestratorToken = process.env.DSH_SCHOLAR_ORCHESTRATOR_TOKEN
const endpointFile = (cli['kernel.endpoint_file'] as string | undefined) ?? process.env.DSH_SCHOLAR_KERNEL_ENDPOINT_FILE

// CONFIG-01: the deployment's effective config is validated through the
// canonical Config Registry BEFORE anything binds — unknown keys, invalid
// values and security-floor violations fail fast here (error messages never
// echo secret values). The one-way sha256 pin of the effective config is
// exposed via the HTTP x-config-pin header, the /v1|v2 health body, the
// GET /v1/config/effective body and the 0600 endpoint file, so running
// objects can be correlated with the config that produced them
// (docs/config-registry.md). The redacted effective config travels with the
// pin for the HTTP surface — secrets never leave the process in plaintext.
let configEffective: Record<string, unknown>
try {
  const resolved = validateConfig({
    'kernel.host': host,
    'kernel.port': port,
    'kernel.token': token ?? '',
    'kernel.service_token': serviceToken ?? '',
    'kernel.db': dbPath,
    'kernel.cas': casRoot,
    'kernel.secret_root': secretRoot ?? '',
    'kernel.endpoint_file': endpointFile ?? '',
    'kernel.require_signed_manifest': true,
  }, { scopes: ['global', 'project', 'kernel'] })
  configEffective = resolved.effective
} catch (error) {
  console.error(`[research-kernel] invalid config: ${error instanceof ConfigRegistryError ? error.message : (error as Error).message}`)
  process.exit(1)
}

// STORAGE-07: pre-migration backup + CAS inventory (opt-in, see above).
// Fails loudly when requested — an explicit operator request must never
// silently no-op. A brand-new database (no file yet) is skipped with a
// notice: there is nothing to back up on first boot.
if (backupOnStart) {
  if (existsSync(dbPath)) {
    try {
      const backup = createStartupBackup({ dbPath, casRoot, instanceId: `kernel-${process.pid}` })
      console.error(`[research-kernel] backup created: ${backup.backup_path} (${backup.blob_count} CAS blobs, ${backup.blob_bytes} bytes; inventory ${backup.inventory_path})`)
    } catch (error) {
      console.error(`[research-kernel] backup failed (--backup-on-start): ${(error as Error).message}`)
      process.exit(1)
    }
  } else {
    console.error('[research-kernel] --backup-on-start: no existing database — backup skipped (first boot)')
  }
}

const kernel = new ResearchKernel({
  dbPath,
  casRoot,
  secretRoot,
  serviceToken,
  dshPluginToken,
  orchestratorToken,
  runtimeConfig: configEffective,
  // OCR-CONFIG-01: the first built-in provider is MinerU's official Open API.
  // Other DNS providers remain fail-closed unless a future instance policy
  // explicitly allowlists them; loopback remains disabled here.
  providerUrlAllowlist: { hosts: ['mineru.net'] },
})

// PTY-01 (execution-runtime.md §6.1): the production kernel serves REAL
// pseudo-terminals through the LocalPtyAdapter (python3 pty bridge). The
// workspace sandbox root lives under the kernel dataDir — never a host
// workspace path — and output flows into the session store (server_seq /
// bounded retention) which is NOT a formal Job log. A missing python3 makes
// every open fail with pty_adapter_failed (honest), never a fake tty.
{
  const ptyWorkspaceRoot = join(resolve(dirname(dbPath)), 'pty-workspaces')
  const ptyAdapter = new LocalPtyAdapter({
    workspaceRoot: ptyWorkspaceRoot,
    onOutput: (sessionId, frames) => {
      try {
        kernel.ptyAppendOutput(sessionId, frames)
      } catch {
        // Session already closed (race with close/sweep) — output after
        // close is dropped by the store's own rule; nothing to do here.
      }
    },
    log: (message) => console.error(`[research-kernel] ${message}`),
  })
  kernel.setPtyAdapter(ptyAdapter)
  if (!ptyAdapter.available) {
    console.error('[research-kernel] WARNING: python3 not available — PTY open will fail with pty_adapter_failed')
  }
}

try {
  const { server, url, port: actualPort } = await startKernelServer({ kernel, host, port, token })
  console.error(`[research-kernel] listening on ${url} (db=${dbPath}, cas=${casRoot}, instance=${kernel.instanceId}, config=${kernel.configPinHash})`)
  if (endpointFile !== undefined && endpointFile !== '') {
    // SIDE-01: server.address().port is the REAL port even when --port 0 was
    // requested. The 0600 file is the sidecar's only identity source: the
    // plugin/standalone sidecars refuse to reuse a kernel whose
    // protocol/schema/database/dataDir do not match their own instance.
    mkdirSync(dirname(endpointFile), { recursive: true })
    writeFileSync(endpointFile, JSON.stringify({
      host,
      port: actualPort,
      protocol: 'http',
      schema: 'v1',
      database: basename(dbPath),
      dataDir: resolve(dirname(dbPath)),
      // CONFIG-01: pin of the effective config that produced this kernel.
      configPin: kernel.configPinHash,
      pid: process.pid,
      started_at: new Date().toISOString(),
    }, null, 2) + '\n', { mode: 0o600 })
    chmodSync(endpointFile, 0o600)
  }
  const shutdown = (signal: string): void => {
    console.error(`[research-kernel] ${signal} — closing`)
    server.close(() => {
      kernel.close()
      process.exit(0)
    })
    setTimeout(() => process.exit(0), 2000).unref()
  }
  process.on('SIGINT', () => shutdown('SIGINT'))
  process.on('SIGTERM', () => shutdown('SIGTERM'))
} catch (error) {
  console.error('[research-kernel] failed to start:', error)
  kernel.close()
  process.exit(1)
}
