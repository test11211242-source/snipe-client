import { describe, expect, it } from 'vitest'

import {
  BinaryEnvelopeStreamDecoder,
  decodeBinaryEnvelope,
  encodeBinaryEnvelope,
} from './binary-protocol'

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

  it('decodes multiple envelopes across arbitrary stream chunks', () => {
    const decoder = new BinaryEnvelopeStreamDecoder({
      maxMetadataBytes: 100,
      maxBinaryBytes: 10,
    })
    const stream = Buffer.concat([
      encodeBinaryEnvelope({ sequence: 1 }),
      encodeBinaryEnvelope({ sequence: 2 }, Buffer.from('png')),
    ])
    const envelopes = [
      ...decoder.push(stream.subarray(0, 7)),
      ...decoder.push(stream.subarray(7, 19)),
      ...decoder.push(stream.subarray(19)),
    ]
    decoder.finish()
    expect(envelopes.map((envelope) => envelope.metadata)).toEqual([
      { sequence: 1 },
      { sequence: 2 },
    ])
    expect(envelopes[1]?.binary.toString()).toBe('png')

    const truncated = new BinaryEnvelopeStreamDecoder({
      maxMetadataBytes: 100,
      maxBinaryBytes: 10,
    })
    truncated.push(stream.subarray(0, 5))
    expect(() => truncated.finish()).toThrow(/truncated/)
  })
})
