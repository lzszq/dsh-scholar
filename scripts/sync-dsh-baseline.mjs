import { readFile, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const repo = dirname(dirname(fileURLToPath(import.meta.url)))
const check = process.argv.includes('--check')
const baseline = JSON.parse(await readFile(join(repo, 'config/dsh-baseline.json'), 'utf8'))
const version = baseline.version

if (typeof version !== 'string' || !/^0\.\d+\.\d+-rc\.\d+$/.test(version)) {
  throw new Error('config/dsh-baseline.json must contain a valid prerelease version')
}

const updates = new Map()
const manifestPath = join(repo, 'package.json')
const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
for (const name of Object.keys(manifest.peerDependencies ?? {})) {
  if (!name.startsWith('@deepseek-ai/dsh-')) continue
  manifest.peerDependencies[name] = `^${version}`
  if (!(name in (manifest.devDependencies ?? {}))) {
    throw new Error(`DSH peer ${name} is missing from devDependencies`)
  }
  manifest.devDependencies[name] = version
}
updates.set(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)

const workspacePath = join(repo, 'pnpm-workspace.yaml')
const workspace = await readFile(workspacePath, 'utf8')
const synchronizedWorkspace = workspace.replace(
  /('@deepseek-ai\/dsh-[^'@]+)@[^']+'/g,
  `$1@${version}'`,
)
updates.set(workspacePath, synchronizedWorkspace)

const drift = []
for (const [path, expected] of updates) {
  const current = await readFile(path, 'utf8')
  if (current === expected) continue
  if (check) drift.push(path)
  else await writeFile(path, expected)
}

if (drift.length > 0) {
  console.error(`DSH baseline ${version} is not synchronized:\n${drift.join('\n')}`)
  process.exitCode = 1
} else {
  console.log(`${check ? 'verified' : 'synchronized'} DSH baseline ${version}`)
}
