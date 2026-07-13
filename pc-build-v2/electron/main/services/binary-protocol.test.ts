import { describe, expect, it } from 'vitest'

import { decodeBinaryEnvelope, encodeBinaryEnvelope } from './binary-protocol'

describe('CRT2 binary protocol', () => {
  it('round trips metadata and binary with exact bounds', () => {
    const result = decodeBinaryEnvelope(
      encodeBinaryEnvelope({ ok: true }, Buffer.from('png')),
      {
        maxMetadataBytes: 100,
        maxBinaryBytes: 3,
      },
    )
    expect(result.metadata).toEqual({ ok: true })
    expect(result.binary.toString()).toBe('png')
  })

  it('rejects malformed and truncated output', () => {
    expect(() =>
      decodeBinaryEnvelope(Buffer.from('bad'), {
        maxMetadataBytes: 100,
        maxBinaryBytes: 100,
      }),
    ).toThrow(/framing/)
    const truncated = encodeBinaryEnvelope({ ok: true }, Buffer.from('png')).subarray(
      0,
      -1,
    )
    expect(() =>
      decodeBinaryEnvelope(truncated, { maxMetadataBytes: 100, maxBinaryBytes: 100 }),
    ).toThrow(/truncated/)
  })
})
