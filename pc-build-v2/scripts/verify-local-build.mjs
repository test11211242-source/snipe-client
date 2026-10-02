import { createHash } from 'node:crypto'
import { open, readFile, stat } from 'node:fs/promises'
import { resolve } from 'node:path'

const checks = [
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
]

async function sha512(path) {
  const file = await open(path, 'r')
  const digest = createHash('sha512')
  try {
    for await (const block of file.createReadStream({ autoClose: false }))
      digest.update(block)
    return digest.digest('hex')
  } finally {
    await file.close()
  }
}

async function json(path) {
  if ((await stat(path)).size > 128 * 1024) throw new Error('Build metadata is too large')
  return JSON.parse(await readFile(path, 'utf8'))
}

async function main() {
  const version = process.env.RELEASE_VERSION
  const correlation = process.env.CORRELATION_ID
  const sha = process.env.RELEASE_SOURCE_SHA
  const tag = process.env.LOCAL_BUILD_TAG
  const directory = resolve(process.argv[2] ?? 'release-input')
  if (
    !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version ?? '') ||
    version.length > 32 ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
      correlation ?? '',
    ) ||
    !/^[0-9a-f]{40}$/.test(sha ?? '') ||
    tag !== `local-windows-${version}-${correlation}`
  ) {
    throw new Error('Invalid local publication inputs')
  }
  const release = await json(resolve(directory, 'transport.json'))
  if (
    release.draft !== true ||
    release.tag_name !== tag ||
    release.target_commitish !== sha
  ) {
    throw new Error('Draft transport does not match the reviewed dispatch commit')
  }
  const receipt = await json(resolve(directory, 'local-build.json'))
  if (
    receipt.schemaVersion !== 1 ||
    receipt.mode !== 'release' ||
    receipt.platform !== 'win32' ||
    receipt.version !== version ||
    receipt.sourceSha !== sha ||
    receipt.correlationId !== correlation ||
    JSON.stringify(receipt.checks) !== JSON.stringify(checks)
  ) {
    throw new Error('Local Windows build receipt or required checks are invalid')
  }
  const packageVersion = JSON.parse(
    await readFile(resolve(import.meta.dirname, '../package.json'), 'utf8'),
  ).version
  if (packageVersion !== version)
    throw new Error('Reviewed package version does not match')
  const artifact = receipt.artifact
  const expectedName = `CR_Tools_V2_Setup_${version}.exe`
  if (
    artifact?.fileName !== expectedName ||
    !Number.isSafeInteger(artifact.size) ||
    artifact.size < 1 ||
    artifact.size > 500 * 1024 * 1024 ||
    !/^[0-9a-f]{128}$/.test(artifact.sha512 ?? '') ||
    !/^[0-9a-f]{128}$/.test(receipt.runtimeSha512 ?? '')
  ) {
    throw new Error('Local installer metadata is invalid')
  }
  const installer = resolve(directory, expectedName)
  if (
    (await stat(installer)).size !== artifact.size ||
    (await sha512(installer)) !== artifact.sha512 ||
    (await sha512(resolve(directory, 'runtime-integrity.json'))) !== receipt.runtimeSha512
  ) {
    throw new Error('Uploaded files differ from the local Windows build')
  }
  const executable = await open(installer, 'r')
  try {
    const header = Buffer.alloc(2)
    await executable.read(header, 0, 2, 0)
    if (header.toString('ascii') !== 'MZ')
      throw new Error('Installer is not a Windows executable')
  } finally {
    await executable.close()
  }
  console.log(`Verified local Windows installer ${version} source=${sha}`)
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : 'Local build validation failed')
  process.exitCode = 1
})
