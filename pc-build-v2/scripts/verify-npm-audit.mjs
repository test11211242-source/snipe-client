import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const ALLOWED_DEV_ADVISORIES = new Set([
  'https://github.com/advisories/GHSA-mh99-v99m-4gvg',
])

// No upstream patched release exists as of 2026-10-03. This leaf is only in
// Electron's build/download tooling. Our downloader does not enable Got's HTTP
// cache, and no shared response cache or runtime dependency uses this package.
// Re-review if the locked version or dev-only scope changes.
const BUILD_CACHE_ADVISORY = 'https://github.com/advisories/GHSA-ch52-4w7c-c8xp'

function audit(arguments_) {
  const npmCli = process.env.npm_execpath
  const executable = npmCli === undefined ? 'npm' : process.execPath
  const commandArguments = [
    ...(npmCli === undefined ? [] : [npmCli]),
    'audit',
    '--json',
    ...arguments_,
  ]
  const result = spawnSync(executable, commandArguments, {
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
    windowsHide: true,
  })
  if (result.error !== undefined) throw result.error
  try {
    const report = JSON.parse(result.stdout)
    if (
      report.error !== undefined ||
      !Number.isSafeInteger(report.metadata?.vulnerabilities?.total) ||
      report.metadata.vulnerabilities.total < 0 ||
      report.vulnerabilities === null ||
      typeof report.vulnerabilities !== 'object'
    ) {
      throw new Error('npm audit did not return a complete vulnerability report')
    }
    return report
  } catch {
    const detail =
      result.stderr.trim() || result.stdout.trim() || 'npm audit returned no JSON'
    throw new Error(detail)
  }
}

function vulnerabilityCount(report) {
  return Number(report?.metadata?.vulnerabilities?.total ?? 0)
}

function rootAdvisories(name, vulnerabilities, trail = new Set()) {
  if (trail.has(name)) return new Set()
  const vulnerability = vulnerabilities[name]
  if (vulnerability === undefined) return new Set([`package:${name}`])
  const nextTrail = new Set(trail).add(name)
  const roots = new Set()
  for (const source of vulnerability.via ?? []) {
    if (typeof source === 'string') {
      for (const root of rootAdvisories(source, vulnerabilities, nextTrail))
        roots.add(root)
      continue
    }
    if (source !== null && typeof source === 'object') {
      const identifier =
        typeof source.url === 'string' ? source.url : `source:${source.source}`
      roots.add(identifier)
    }
  }
  if (roots.size === 0 && (vulnerability.via ?? []).length === 0) {
    roots.add(`package:${name}`)
  }
  return roots
}

const production = audit(['--omit=dev'])
if (vulnerabilityCount(production) !== 0) {
  console.error('Production npm dependencies contain audit findings.')
  process.exit(1)
}

const full = audit([])
const vulnerabilities = full.vulnerabilities ?? {}
const lock = JSON.parse(readFileSync(resolve('package-lock.json'), 'utf8'))
const cacheNodes = vulnerabilities['http-cache-semantics']?.nodes ?? []
const buildCacheOnly =
  cacheNodes.length > 0 &&
  cacheNodes.every(
    (path) =>
      (path === 'node_modules/http-cache-semantics' ||
        path.endsWith('/node_modules/http-cache-semantics')) &&
      lock.packages?.[path]?.version === '4.2.0' &&
      lock.packages[path].dev === true,
  )
const blocking = []
const accepted = new Set()
for (const [name, vulnerability] of Object.entries(vulnerabilities)) {
  if (vulnerability.severity !== 'high' && vulnerability.severity !== 'critical') continue
  const roots = [...rootAdvisories(name, vulnerabilities)]
  if (
    roots.length === 0 ||
    roots.some(
      (root) =>
        !ALLOWED_DEV_ADVISORIES.has(root) &&
        !(root === BUILD_CACHE_ADVISORY && buildCacheOnly),
    )
  ) {
    blocking.push({ name, severity: vulnerability.severity, roots })
  } else {
    for (const root of roots) accepted.add(root)
  }
}

if (blocking.length > 0) {
  console.error('Unexpected high or critical npm audit findings:')
  for (const finding of blocking) {
    console.error(`  ${finding.name} (${finding.severity}): ${finding.roots.join(', ')}`)
  }
  process.exit(1)
}

console.log('Production npm audit: 0 vulnerabilities.')
for (const advisory of accepted) {
  console.log(`Reviewed dev-only advisory: ${advisory}`)
}
if (vulnerabilityCount(full) > 0) {
  console.log(
    `Full toolchain audit: ${vulnerabilityCount(full)} findings; no unreviewed high/critical findings.`,
  )
}
