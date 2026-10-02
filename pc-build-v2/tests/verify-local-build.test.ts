import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

describe('local Windows build handoff', () => {
  let directory: string
  let receipt: Record<string, unknown>
  let transport: Record<string, unknown>
  const { version } = JSON.parse(
    readFileSync(join(import.meta.dirname, '../package.json'), 'utf8'),
  ) as { version: string }
  const correlation = '29d970c1-fc4f-4bea-a767-8f108d3b8739'
  const sha = 'a'.repeat(40)
  const tag = `local-windows-${version}-${correlation}`
  const hash = (value: string): string => createHash('sha512').update(value).digest('hex')
  const installer = `CR_Tools_V2_Setup_${version}.exe`
  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'local-build-handoff-'))
    writeFileSync(join(directory, installer), 'MZlocal Windows installer')
    writeFileSync(join(directory, 'runtime-integrity.json'), '{}')
    receipt = {
      schemaVersion: 1,
      mode: 'release',
      platform: 'win32',
      version,
      sourceSha: sha,
      correlationId: correlation,
      checks: [
        'lint',
        'typecheck',
        'release:verify-inputs',
        'test',
        'test:publisher',
        'test:python',
        'audit:release',
        'runtime:verify',
        'build:unpacked',
        'test:e2e:windows',
        'build',
        'installer-validation',
      ],
      artifact: {
        fileName: installer,
        size: Buffer.byteLength('MZlocal Windows installer'),
        sha512: hash('MZlocal Windows installer'),
      },
      runtimeSha512: hash('{}'),
    }
    transport = { draft: true, tag_name: tag, target_commitish: sha }
  })
  afterEach(() => rmSync(directory, { recursive: true, force: true }))
  function validate(): ReturnType<typeof spawnSync> {
    writeFileSync(join(directory, 'local-build.json'), JSON.stringify(receipt))
    writeFileSync(join(directory, 'transport.json'), JSON.stringify(transport))
    return spawnSync(
      process.execPath,
      [join(import.meta.dirname, '../scripts/verify-local-build.mjs'), directory],
      {
        env: {
          ...process.env,
          RELEASE_VERSION: version,
          CORRELATION_ID: correlation,
          RELEASE_SOURCE_SHA: sha,
          LOCAL_BUILD_TAG: tag,
        },
        encoding: 'utf8',
      },
    )
  }
  it('accepts the exact installer built and checked on Windows', () => {
    const result = validate()
    expect(result.status, String(result.stderr)).toBe(0)
  })
  it('rejects replacing the installer after checks', () => {
    writeFileSync(join(directory, installer), 'MZanother installer')
    expect(validate().status).toBe(1)
  })
  it('rejects replacing the runtime inventory', () => {
    writeFileSync(join(directory, 'runtime-integrity.json'), '{"changed":true}')
    expect(validate().status).toBe(1)
  })
  it('rejects a build from a different source commit', () => {
    receipt['sourceSha'] = 'b'.repeat(40)
    expect(validate().status).toBe(1)
  })
  it('rejects a build that skipped packaged Windows checks', () => {
    receipt['checks'] = ['lint', 'build']
    expect(validate().status).toBe(1)
  })
  it('rejects publishing a development test build', () => {
    receipt['mode'] = 'test'
    expect(validate().status).toBe(1)
  })
  it('rejects public releases and mismatched draft targets', () => {
    transport['draft'] = false
    expect(validate().status).toBe(1)
    transport['draft'] = true
    transport['target_commitish'] = 'b'.repeat(40)
    expect(validate().status).toBe(1)
  })
})
