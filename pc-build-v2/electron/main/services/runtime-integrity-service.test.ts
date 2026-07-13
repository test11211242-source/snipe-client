import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { RuntimeIntegrityService } from './runtime-integrity-service'

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true })),
  )
})

async function fixture(path = 'python.exe') {
  const root = await mkdtemp(join(tmpdir(), 'cr-tools-runtime-'))
  temporaryDirectories.push(root)
  const runtime = join(root, 'python-runtime')
  await mkdir(runtime)
  const bytes = Buffer.from('trusted-runtime')
  await writeFile(join(runtime, 'python.exe'), bytes)
  const inventory = join(root, 'runtime-integrity.json')
  await writeFile(
    inventory,
    JSON.stringify({
      schemaVersion: 1,
      root: 'python-runtime',
      files: [
        {
          path,
          size: bytes.byteLength,
          sha256: createHash('sha256').update(bytes).digest('hex'),
        },
      ],
    }),
  )
  return { runtime, inventory }
}

describe('RuntimeIntegrityService', () => {
  it('verifies once and caches only the successful result', async () => {
    const paths = await fixture()
    const service = new RuntimeIntegrityService(paths.runtime, paths.inventory)
    await expect(service.verify()).resolves.toBeUndefined()
    await writeFile(join(paths.runtime, 'python.exe'), 'tampered-after-success')
    await expect(service.verify()).resolves.toBeUndefined()
  })

  it('fails closed for tampered and missing runtime files', async () => {
    const tampered = await fixture()
    await writeFile(join(tampered.runtime, 'python.exe'), 'tampered')
    await expect(
      new RuntimeIntegrityService(tampered.runtime, tampered.inventory).verify(),
    ).rejects.toMatchObject({ code: 'RUNTIME_INTEGRITY_FAILED' })

    const missing = await fixture()
    await rm(join(missing.runtime, 'python.exe'))
    await expect(
      new RuntimeIntegrityService(missing.runtime, missing.inventory).verify(),
    ).rejects.toMatchObject({ code: 'RUNTIME_INTEGRITY_FAILED' })
  })

  it('rejects inventory traversal before reading outside the runtime', async () => {
    const paths = await fixture('../outside.exe')
    await expect(
      new RuntimeIntegrityService(paths.runtime, paths.inventory).verify(),
    ).rejects.toMatchObject({ code: 'RUNTIME_INTEGRITY_FAILED' })
  })
})
