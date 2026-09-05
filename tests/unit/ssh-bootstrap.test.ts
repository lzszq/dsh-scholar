import { afterEach, describe, expect, it } from 'vitest'
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  buildSshBootstrapArgs,
  parseRemoteSshEndpoint,
  resolveSshBootstrap,
  startSshAgentBootstrap,
  SshBootstrapError,
} from '../../workers/runner-gateway/src/ssh-bootstrap'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'dsh-ssh-'))
  roots.push(root)
  mkdirSync(join(root, 'runner'))
  writeFileSync(join(root, 'runner/endpoint.json'), JSON.stringify({ host: 'lab.example', port: 2222, user: 'research' }))
  writeFileSync(join(root, 'runner/key'), 'private')
  chmodSync(join(root, 'runner/key'), 0o600)
  writeFileSync(join(root, 'runner/known_hosts'), 'lab.example ssh-ed25519 pinned')
  writeFileSync(join(root, 'runner/identity'), 'test-target-token-0000000000000000000001', { mode: 0o600 })
  const target = {
    target_id: 'lab-a', kind: 'remote-ssh' as const, enabled: true, draining: false,
    service_identity: { scheme: 'file' as const, name: 'runner/identity', available: true },
    connection: {
      endpoint: { scheme: 'file' as const, name: 'runner/endpoint.json', available: true },
      credential: { scheme: 'file' as const, name: 'runner/key', available: true },
      known_hosts: { scheme: 'file' as const, name: 'runner/known_hosts', available: true },
    },
  }
  return { root, target }
}

describe('EXEC-ENV-02 SSH → RemoteRunnerAgent bootstrap', () => {
  it('parses only the strict host/port/user endpoint shape', () => {
    expect(parseRemoteSshEndpoint('{"host":"lab.example","port":22,"user":"runner"}')).toEqual({ host: 'lab.example', port: 22, user: 'runner' })
    expect(() => parseRemoteSshEndpoint('{"host":"lab.example","port":22,"user":"runner","proxy_command":"nc"}')).toThrow(SshBootstrapError)
    expect(() => parseRemoteSshEndpoint('{"host":"bad host","port":22,"user":"runner"}')).toThrow(SshBootstrapError)
  })

  it('resolves file SecretRefs inside the server secret root and enforces private-key mode', () => {
    const { root, target } = fixture()
    const resolved = resolveSshBootstrap(target, root)
    expect(resolved.endpoint).toEqual({ host: 'lab.example', port: 2222, user: 'research' })
    expect(resolved.credential_file).toBe(join(root, 'runner/key'))
    chmodSync(join(root, 'runner/key'), 0o644)
    expect(() => resolveSshBootstrap(target, root)).toThrow(/0600/)
  })

  it('builds strict OpenSSH args and a fixed remote agent command with no fallback shell input', () => {
    const { root, target } = fixture()
    const resolved = resolveSshBootstrap(target, root)
    const args = buildSshBootstrapArgs({ resolved, fleetUrl: 'https://fleet.example/v1', agentId: 'lab-a-agent', connectTimeoutMs: 15000 })
    expect(args).toContain('StrictHostKeyChecking=yes')
    expect(args).toContain(`UserKnownHostsFile=${join(root, 'runner/known_hosts')}`)
    expect(args).toContain('IdentitiesOnly=yes')
    expect(args).not.toContain('StrictHostKeyChecking=no')
    expect(args.join(' ')).not.toContain('ProxyCommand')
    expect(args.at(-1)).toContain('dsh-scholar-runner --agent')
    expect(args.at(-1)).toContain('--target-id')
    expect(args.at(-1)).toContain('--fleet-public-key "$key_file" --key-file "$manifest_key_file"')
  })

  it('fails closed for disabled, draining, unavailable or non-file targets', () => {
    const { root, target } = fixture()
    expect(() => resolveSshBootstrap({ ...target, enabled: false }, root)).toThrow(/disabled or draining/)
    expect(() => resolveSshBootstrap({ ...target, draining: true }, root)).toThrow(/disabled or draining/)
    expect(() => resolveSshBootstrap({ ...target, connection: { ...target.connection, known_hosts: { ...target.connection.known_hosts, available: false } } }, root)).toThrow(/unavailable/)
    expect(() => resolveSshBootstrap({ ...target, connection: { ...target.connection, credential: { scheme: 'vault', name: 'runner/key', available: true } } }, root)).toThrow(/no resolver/)
  })

  it('passes both identities via stdin into the fixed bootstrap script and removes temporary key files', async () => {
    const { root, target } = fixture()
    const output = join(root, 'captured.json')
    const serviceToken = 'test-service-$(unused)-`literal`'
    const targetToken = readFileSync(join(root, 'runner/identity'), 'utf8')
    writeFileSync(join(root, 'dsh-scholar-runner'), `#!${process.execPath}
      const fs = require('node:fs');
      const args = process.argv.slice(2);
      const keys = ['--fleet-public-key', '--key-file'].map(flag => args[args.indexOf(flag) + 1]);
      fs.writeFileSync(${JSON.stringify(output)}, JSON.stringify({
        args, keys, keyContents: keys.map(path => fs.readFileSync(path, 'utf8')),
        modes: keys.map(path => fs.statSync(path).mode & 0o777),
        service: process.env.DSH_SCHOLAR_SERVICE_TOKEN, target: process.env.DSH_SCHOLAR_RUNNER_TARGET_TOKEN,
      }));
    `, { mode: 0o700 })
    let sshArgs: string[] = []
    const handle = startSshAgentBootstrap({
      resolved: resolveSshBootstrap(target, root), fleetUrl: 'https://fleet.example', agentId: 'lab-a-agent',
      connectTimeoutMs: 15000, fleetPublicKeyPem: 'fixture public key\n', manifestPrivateKeyPem: 'fixture private key\n', serviceToken,
      // Execute the actual fixed bootstrap shell locally; no SSH server or
      // external machine is contacted by this credential-channel regression.
      spawnProcess: ((_command: string, args: string[]) => {
        sshArgs = args
        return spawn('/bin/sh', ['-c', args.at(-1)!], { stdio: ['pipe', 'pipe', 'pipe'], env: { PATH: `${root}:${process.env.PATH}` } })
      }) as typeof spawn,
    })
    try {
      expect(await handle.completion).toBe(0)
      const captured = JSON.parse(readFileSync(output, 'utf8'))
      expect(captured).toMatchObject({ service: serviceToken, target: targetToken, modes: [0o600, 0o600], keyContents: ['fixture public key\n', 'fixture private key\n'] })
      for (const secret of [serviceToken, targetToken, 'fixture private key']) {
        expect(sshArgs.join(' ')).not.toContain(secret)
        expect(captured.args.join(' ')).not.toContain(secret)
      }
      expect(captured.keys.every((path: string) => !existsSync(path))).toBe(true)
    } finally {
      if (handle.child.exitCode === null && handle.child.signalCode === null) handle.child.kill('SIGTERM')
      await handle.completion
    }
  })
})
