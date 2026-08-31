import { parse } from 'yaml'

/** SemVer 2.0 exact version (stable or prerelease/build); ranges, tags and a
 * leading `v` are deliberately rejected because a compatibility receipt must
 * identify one published Host artifact. */
export function isExactSemver(version) {
  return typeof version === 'string'
    && /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.test(version)
}

/** Return deterministic drift messages for the root DSH importer and every
 * resolved DSH package key in a pnpm v9 lockfile. */
export function dshLockfileDrift(lockfile, version, directPackageNames) {
  let document
  try {
    document = parse(lockfile)
  } catch {
    return ['pnpm-lock.yaml is not valid YAML']
  }
  if (document === null || typeof document !== 'object' || Array.isArray(document)) {
    return ['pnpm-lock.yaml root must be a mapping']
  }
  const importers = document.importers
  if (importers === null || typeof importers !== 'object' || Array.isArray(importers)) {
    return ['pnpm-lock.yaml has no importers mapping']
  }
  const root = importers['.']
  if (root === null || typeof root !== 'object' || Array.isArray(root)) {
    return ['pnpm-lock.yaml has no root importer']
  }

  const direct = new Map()
  for (const sectionName of ['dependencies', 'devDependencies', 'optionalDependencies']) {
    const section = root[sectionName]
    if (section === null || typeof section !== 'object' || Array.isArray(section)) continue
    for (const [name, entry] of Object.entries(section)) {
      if (name.startsWith('@deepseek-ai/dsh-')) direct.set(name, entry)
    }
  }

  const errors = []
  const requiredNames = new Set([...directPackageNames, ...direct.keys()])
  for (const name of [...requiredNames].sort()) {
    const entry = direct.get(name)
    if (entry === undefined) {
      errors.push(`${name} root lock entry is missing`)
      continue
    }
    const specifier = typeof entry === 'object' && entry !== null ? entry.specifier : undefined
    const resolvedValue = typeof entry === 'object' && entry !== null ? entry.version : entry
    const resolved = typeof resolvedValue === 'string' ? resolvedValue.split('(', 1)[0] : ''
    if (specifier !== version || resolved !== version) {
      errors.push(`${name} root lock entry is not ${version}`)
    }
  }

  const packageErrors = new Set()
  for (const sectionName of ['packages', 'snapshots']) {
    const section = document[sectionName]
    if (section === null || typeof section !== 'object' || Array.isArray(section)) continue
    for (const key of Object.keys(section)) {
      const match = /^(@deepseek-ai\/dsh-[^@]+)@(.+)$/.exec(key)
      if (match === null) continue
      const resolved = (match[2] ?? '').split('(', 1)[0]
      if (resolved !== version) {
        packageErrors.add(`${match[1]} package key resolves ${resolved || 'unknown'}, expected ${version}`)
      }
    }
  }
  errors.push(...[...packageErrors].sort())
  return errors
}
