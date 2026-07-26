import { spawnSync } from 'node:child_process'

const ALLOWED_DEV_ADVISORIES = new Set([
  'https://github.com/advisories/GHSA-mh99-v99m-4gvg',
])

function audit(arguments_) {
  const executable = process.platform === 'win32' ? 'npm.cmd' : 'npm'
  const result = spawnSync(executable, ['audit', '--json', ...arguments_], {
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
    windowsHide: true,
  })
  if (result.error !== undefined) throw result.error
  try {
    return JSON.parse(result.stdout)
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
const blocking = []
for (const [name, vulnerability] of Object.entries(vulnerabilities)) {
  if (vulnerability.severity !== 'high' && vulnerability.severity !== 'critical') continue
  const roots = [...rootAdvisories(name, vulnerabilities)]
  if (roots.length === 0 || roots.some((root) => !ALLOWED_DEV_ADVISORIES.has(root))) {
    blocking.push({ name, severity: vulnerability.severity, roots })
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
if (vulnerabilityCount(full) > 0) {
  console.log(
    `Accepted known dev-only advisory GHSA-mh99-v99m-4gvg (${vulnerabilityCount(full)} transitive findings).`,
  )
}
