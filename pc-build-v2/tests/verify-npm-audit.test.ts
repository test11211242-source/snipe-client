import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

const advisory = 'https://github.com/advisories/GHSA-ch52-4w7c-c8xp'
const cachePath = 'node_modules/http-cache-semantics'
const clean = { metadata: { vulnerabilities: { total: 0 } }, vulnerabilities: {} }

function cacheReport(url = advisory) {
  return {
    metadata: { vulnerabilities: { total: 2 } },
    vulnerabilities: {
      got: { severity: 'high', via: ['http-cache-semantics'] },
      'http-cache-semantics': { severity: 'high', nodes: [cachePath], via: [{ url }] },
    },
  }
}

describe('release dependency audit', () => {
  let directory: string
  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'cr-tools-audit-'))
    writeFileSync(
      join(directory, 'npm.cjs'),
      `const fs=require('node:fs');console.log(fs.readFileSync(process.argv.includes('--omit=dev')?'production.json':'full.json','utf8'))`,
    )
  })
  afterEach(() => rmSync(directory, { recursive: true, force: true }))

  function check(
    production: unknown,
    full: unknown,
    entry: unknown = { version: '4.2.0', dev: true },
  ) {
    writeFileSync(join(directory, 'production.json'), JSON.stringify(production))
    writeFileSync(join(directory, 'full.json'), JSON.stringify(full))
    writeFileSync(
      join(directory, 'package-lock.json'),
      JSON.stringify({ packages: { [cachePath]: entry } }),
    )
    const environment: NodeJS.ProcessEnv = { ...process.env }
    // Windows environment keys are case-insensitive; do not retain an inherited
    // NPM_EXECPATH alongside the fixture's npm_execpath.
    for (const key of Object.keys(environment)) {
      if (key.toLowerCase() === 'npm_execpath') Reflect.deleteProperty(environment, key)
    }
    environment['npm_execpath'] = join(directory, 'npm.cjs')
    return spawnSync(
      process.execPath,
      [join(import.meta.dirname, '../scripts/verify-npm-audit.mjs')],
      {
        cwd: directory,
        env: environment,
        encoding: 'utf8',
        windowsHide: true,
      },
    )
  }

  it('accepts the reviewed build-only cache finding and reports it explicitly', () => {
    const result = check(clean, cacheReport())
    expect(result.status).toBe(0)
    expect(result.stdout).toContain('Production npm audit: 0 vulnerabilities')
    expect(result.stdout).toContain(advisory)
  })

  it('still blocks that finding in production', () => {
    expect(check(cacheReport(), cacheReport()).status).toBe(1)
  })

  it.each([{ version: '4.2.0', dev: false }, { version: '4.1.1', dev: true }, undefined])(
    'requires the exact reviewed leaf version and dev-only lock entry: %j',
    (entry) => {
      // null ensures the fixture does not use the helper's default entry.
      expect(check(clean, cacheReport(), entry ?? null).status).toBe(1)
    },
  )

  it('blocks an unrelated advisory even on the same leaf', () => {
    expect(
      check(clean, cacheReport('https://github.com/advisories/unknown')).status,
    ).toBe(1)
  })

  it('blocks a mixed advisory chain', () => {
    const report = cacheReport()
    report.vulnerabilities['http-cache-semantics'].via.push({
      url: 'https://github.com/advisories/unknown',
    })
    expect(check(clean, report).status).toBe(1)
  })

  it('blocks incomplete audit responses instead of treating them as clean', () => {
    expect(check({ error: { code: 'ENOAUDIT' } }, clean).status).not.toBe(0)
    expect(check(clean, { error: { code: 'ENOAUDIT' } }).status).not.toBe(0)
  })
})
