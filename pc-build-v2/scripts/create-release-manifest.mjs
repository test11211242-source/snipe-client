import { createHash, createPrivateKey, createPublicKey, sign, verify } from 'node:crypto'
import { open, readFile, rename, stat } from 'node:fs/promises'
import { basename, resolve } from 'node:path'

import { canonicalizeUpdatePayload } from '../shared/update-manifest.mjs'

const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/
const ORIGIN = 'https://updates.artcsworld.xyz'
const PREFIX = '/downloads/v2/'
const MAX_ARTIFACT_BYTES = 500 * 1024 * 1024
const ALLOWED_ARGUMENTS = new Set([
  '--version',
  '--artifact',
  '--output',
  '--notes-file',
  '--minimum-version',
  '--critical',
])

function argumentsByName(values) {
  const parsed = new Map()
  for (let index = 0; index < values.length; index += 2) {
    const name = values[index]
    const value = values[index + 1]
    if (
      !name?.startsWith('--') ||
      !ALLOWED_ARGUMENTS.has(name) ||
      value === undefined ||
      parsed.has(name)
    ) {
      throw new Error('Invalid release manifest arguments')
    }
    parsed.set(name, value)
  }
  return parsed
}

function requireArgument(values, name) {
  const value = values.get(name)
  if (value === undefined || value === '') throw new Error(`Missing ${name}`)
  return value
}

async function sha512(path) {
  const file = await open(path, 'r')
  const hash = createHash('sha512')
  const buffer = Buffer.allocUnsafe(1024 * 1024)
  try {
    let position = 0
    while (true) {
      const result = await file.read(buffer, 0, buffer.length, position)
      if (result.bytesRead === 0) break
      hash.update(buffer.subarray(0, result.bytesRead))
      position += result.bytesRead
    }
    return hash.digest('base64')
  } finally {
    await file.close()
  }
}

async function main() {
  const args = argumentsByName(process.argv.slice(2))
  const version = requireArgument(args, '--version')
  const artifactPath = resolve(requireArgument(args, '--artifact'))
  const outputPath = resolve(requireArgument(args, '--output'))
  const notesPath = args.get('--notes-file')
  const minimumVersion = args.get('--minimum-version')
  const critical = args.get('--critical') === 'true'
  if (!SEMVER.test(version)) throw new Error('Version must be strict x.y.z semver')
  if (minimumVersion !== undefined && !SEMVER.test(minimumVersion)) {
    throw new Error('Minimum version must be strict x.y.z semver')
  }
  if (
    args.get('--critical') !== undefined &&
    !['true', 'false'].includes(args.get('--critical'))
  ) {
    throw new Error('Critical must be true or false')
  }

  const fileName = `CR_Tools_V2_Setup_${version}.exe`
  if (basename(artifactPath) !== fileName) throw new Error('Artifact filename is invalid')
  const artifactStat = await stat(artifactPath)
  if (
    !artifactStat.isFile() ||
    artifactStat.size <= 0 ||
    artifactStat.size > MAX_ARTIFACT_BYTES
  ) {
    throw new Error('Artifact size is invalid')
  }
  let notes = []
  if (notesPath !== undefined) {
    notes = JSON.parse(await readFile(resolve(notesPath), 'utf8'))
    if (
      !Array.isArray(notes) ||
      notes.length > 20 ||
      notes.some(
        (note) => typeof note !== 'string' || note.length < 1 || note.length > 1_000,
      )
    ) {
      throw new Error('Release notes are invalid')
    }
  }

  const payload = {
    schemaVersion: 1,
    channel: 'stable',
    version,
    publishedAt: new Date().toISOString(),
    ...(minimumVersion === undefined ? {} : { minimumVersion }),
    critical,
    notes,
    artifact: {
      fileName,
      size: artifactStat.size,
      sha512: await sha512(artifactPath),
      url: `${ORIGIN}${PREFIX}${fileName}`,
    },
  }
  const privateKeyValue = process.env.CR_TOOLS_V2_UPDATE_PRIVATE_KEY_B64
  if (privateKeyValue === undefined || privateKeyValue === '') {
    throw new Error('Signing key environment variable is missing')
  }
  const privateKeyBytes = Buffer.from(privateKeyValue, 'base64')
  if (privateKeyBytes.toString('base64') !== privateKeyValue) {
    throw new Error('Signing key encoding is invalid')
  }
  const privateKey = createPrivateKey(privateKeyBytes.toString('utf8'))
  if (privateKey.asymmetricKeyType !== 'ed25519')
    throw new Error('Signing key type is invalid')
  const publicKeyPath = resolve(import.meta.dirname, '../resources/update-public-key.pem')
  const publicKeyPem = await readFile(publicKeyPath, 'utf8')
  const publicKey = createPublicKey(publicKeyPem)
  const canonical = Buffer.from(canonicalizeUpdatePayload(payload), 'utf8')
  const signature = sign(null, canonical, privateKey)
  if (!verify(null, canonical, publicKey, signature)) {
    throw new Error('Manifest self-verification failed')
  }
  const manifest = `${JSON.stringify({ ...payload, signature: signature.toString('base64') }, null, 2)}\n`
  const temporaryPath = `${outputPath}.${process.pid}.${Date.now()}.tmp`
  const output = await open(temporaryPath, 'wx', 0o600)
  try {
    await output.writeFile(manifest, 'utf8')
    await output.sync()
  } finally {
    await output.close()
  }
  await rename(temporaryPath, outputPath)

  const publicDer = publicKey.export({ type: 'spki', format: 'der' })
  const fingerprint = createHash('sha256').update(publicDer).digest('hex')
  console.log(`artifact=${artifactPath}`)
  console.log(`version=${version}`)
  console.log(`output=${outputPath}`)
  console.log(`publicKeySha256=${fingerprint}`)
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : 'Unknown error'
  console.error(`Release manifest generation failed: ${message}`)
  process.exitCode = 1
})
