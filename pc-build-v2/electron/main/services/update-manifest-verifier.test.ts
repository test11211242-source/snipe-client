import { generateKeyPairSync, sign } from 'node:crypto'
import { describe, expect, it } from 'vitest'

import type {
  SignedUpdateManifest,
  UpdateManifestPayload,
} from '../../../shared/contracts/update'
import { canonicalizeUpdatePayload } from '../../../shared/update-manifest.mjs'
import { compareSemver, verifyUpdateManifest } from './update-manifest-verifier'

const keys = generateKeyPairSync('ed25519')
const publicKey = keys.publicKey.export({ type: 'spki', format: 'pem' }).toString()

function payload(version = '1.2.3'): UpdateManifestPayload {
  return {
    schemaVersion: 1,
    channel: 'stable',
    version,
    publishedAt: '2026-07-12T12:00:00.000Z',
    critical: false,
    notes: ['Bounded release note'],
    artifact: {
      fileName: `CR_Tools_V2_Setup_${version}.exe`,
      size: 3,
      sha512: Buffer.alloc(64, 1).toString('base64'),
      url: `https://updates.artcsworld.xyz/downloads/v2/CR_Tools_V2_Setup_${version}.exe`,
    },
  }
}

function signed(value: UpdateManifestPayload): SignedUpdateManifest {
  return {
    ...value,
    signature: sign(
      null,
      Buffer.from(canonicalizeUpdatePayload(value), 'utf8'),
      keys.privateKey,
    ).toString('base64'),
  }
}

function bytes(value: unknown): Uint8Array {
  return Buffer.from(JSON.stringify(value), 'utf8')
}

describe('update manifest verification', () => {
  it('uses one deterministic fixed-order canonical payload serialization', () => {
    expect(canonicalizeUpdatePayload(payload())).toBe(
      '{"schemaVersion":1,"channel":"stable","version":"1.2.3","publishedAt":"2026-07-12T12:00:00.000Z","critical":false,"notes":["Bounded release note"],"artifact":{"fileName":"CR_Tools_V2_Setup_1.2.3.exe","size":3,"sha512":"AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQ==","url":"https://updates.artcsworld.xyz/downloads/v2/CR_Tools_V2_Setup_1.2.3.exe"}}',
    )
  })

  it('accepts a valid Ed25519 manifest and rejects a tampered payload or signature', () => {
    const manifest = signed(payload())
    expect(verifyUpdateManifest(bytes(manifest), publicKey, '1.0.0')).toMatchObject({
      updateAvailable: true,
      manifest: { version: '1.2.3' },
    })

    expect(() =>
      verifyUpdateManifest(
        bytes({ ...manifest, notes: ['tampered after signing'] }),
        publicKey,
        '1.0.0',
      ),
    ).toThrow(/could not be verified/)
    expect(() =>
      verifyUpdateManifest(
        bytes({ ...manifest, signature: Buffer.alloc(64).toString('base64') }),
        publicKey,
        '1.0.0',
      ),
    ).toThrow(/could not be verified/)
  })

  it('rejects unknown and duplicate fields before trust decisions', () => {
    const manifest = signed(payload())
    expect(() =>
      verifyUpdateManifest(bytes({ ...manifest, extra: true }), publicKey, '1.0.0'),
    ).toThrow(/invalid/)

    const source = JSON.stringify(manifest).replace(
      '"schemaVersion":1',
      '"schemaVersion":1,"schemaVersion":1',
    )
    expect(() => verifyUpdateManifest(Buffer.from(source), publicKey, '1.0.0')).toThrow(
      /Duplicate JSON object key/,
    )
  })

  it('rejects signed artifact URLs outside the exact origin, path, and filename', () => {
    for (const url of [
      'https://evil.example/downloads/v2/CR_Tools_V2_Setup_1.2.3.exe',
      'https://updates.artcsworld.xyz/other/CR_Tools_V2_Setup_1.2.3.exe',
      'https://updates.artcsworld.xyz/downloads/v2/other.exe',
      'https://updates.artcsworld.xyz/downloads/v2/CR_Tools_V2_Setup_1.2.3.exe?token=x',
    ]) {
      const value = payload()
      value.artifact.url = url
      expect(() =>
        verifyUpdateManifest(bytes(signed(value)), publicKey, '1.0.0'),
      ).toThrow(/invalid/)
    }
  })

  it('rejects an artifact size declared above the hard cap', () => {
    const value = payload()
    value.artifact.size = 500 * 1024 * 1024 + 1
    expect(() => verifyUpdateManifest(bytes(signed(value)), publicKey, '1.0.0')).toThrow(
      /invalid/,
    )
  })

  it('rejects an oversized manifest response before parsing', () => {
    expect(() =>
      verifyUpdateManifest(Buffer.alloc(128 * 1024 + 1), publicKey, '1.0.0'),
    ).toThrow(/too large/)
  })

  it('uses numeric semver and does not accept equal or downgrade manifests', () => {
    expect(compareSemver('1.10.0', '1.9.9')).toBe(1)
    expect(
      verifyUpdateManifest(bytes(signed(payload('1.2.3'))), publicKey, '1.2.3'),
    ).toMatchObject({ updateAvailable: false })
    expect(
      verifyUpdateManifest(bytes(signed(payload('1.2.3'))), publicKey, '2.0.0'),
    ).toMatchObject({ updateAvailable: false })
    expect(
      verifyUpdateManifest(bytes(signed(payload('2.0.0'))), publicKey, '1.2.3'),
    ).toMatchObject({ updateAvailable: true })
  })

  it('rejects an unsupported minimum version', () => {
    const value = { ...payload(), minimumVersion: '1.1.0' }
    expect(() => verifyUpdateManifest(bytes(signed(value)), publicKey, '1.0.0')).toThrow(
      /cannot install/,
    )
  })
})
