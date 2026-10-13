import { describe, expect, it, vi } from 'vitest'

import { CaptureService, PreparedCaptureGameSchema } from './capture-service'
import { decodeBinaryEnvelope, encodeBinaryEnvelope } from './binary-protocol'

const profile = {
  schemaVersion: 3 as const,
  analyzer: { name: 'cr-tools-trigger-analyzer' as const, version: '2.1.0' },
  innerRect: { x: 0.1, y: 0.2, width: 0.8, height: 0.6 },
  structureAlgorithm: 'max-channel-scharr-v1' as const,
  structureHash64: '0123456789abcdef',
  matcherMode: 'edge' as const,
  normalizedTemplateSize: { width: 128, height: 128 },
  structureTemplateBase64: 'AAAA',
  edgeTemplateBase64: 'AAAA',
  orientationTemplateBase64: 'AAAA',
  quality: {
    grade: 'medium' as const,
    score: 0.65,
    edgePixelCount: 120,
    edgeCoverage: 0.5,
    keypointsCount: 3,
    cropConfidence: 0.8,
    cropAreaRatio: 0.48,
  },
}

const legacyProfile = {
  templateGrayBase64: Buffer.from('legacy grayscale png').toString('base64'),
  thumbnailHash: 'fedcba9876543210',
  featureMode: 'ncc' as const,
  keypointsCount: 3,
  normalizedTemplateSize: { width: 128 as const, height: 128 as const },
  hashThreshold: 5 as const,
  orbDistanceThreshold: 55 as const,
  orbMinGoodMatches: 10 as const,
  nccThreshold: 0.72 as const,
  analyzerVersion: 'trigger-profile-v2' as const,
}

const badge = { cx: 0.496, cy: 0.429, width: 0.21, height: 0.14 }
const vsOrientation = {
  kind: 'vs_edge_orientation' as const,
  algorithm: 'vs-orient-1' as const,
  badge,
  normalizedSize: { width: 96 as const, height: 96 },
  cropMargin: 0.08 as const,
  padding: 4 as const,
  maxShift: 3 as const,
  threshold: 0.5 as const,
  angleQ8Base64: Buffer.alloc(96 * 96).toString('base64'),
  weightQ8Base64: Buffer.alloc(96 * 96, 255).toString('base64'),
  templateHash64: '0123456789abcdef',
  maskAreaRatio: 0.6,
}

function analyzerService(fields: Record<string, unknown> = {}) {
  const execute = vi.fn((request: { requestId: string; input: Buffer }) =>
    Promise.resolve({
      requestId: request.requestId,
      stdout: encodeBinaryEnvelope({
        protocolVersion: 2,
        requestId: request.requestId,
        ok: true,
        profile,
        legacyProfile,
        vsOrientation: null,
        vsBadge: null,
        ...fields,
      }),
    }),
  )
  return {
    execute,
    service: new CaptureService(
      { execute } as never,
      'python.exe',
      'capture.py',
      'analyze_trigger.py',
    ),
  }
}

const frame = { size: { width: 1000, height: 500 }, png: Buffer.from('frame') }
const region = { x: 0.0505, y: 0.101, width: 0.2005, height: 0.201 }

describe('CaptureService trigger analyzer protocol', () => {
  it('parses the framed V3 profile and transient V1 projection together', async () => {
    const worker = {
      execute: vi.fn((request: { requestId: string; input: Buffer }) => {
        const input = decodeBinaryEnvelope(request.input, {
          maxMetadataBytes: 64 * 1024,
          maxBinaryBytes: 32 * 1024 * 1024,
        })
        expect(input.metadata).toMatchObject({
          protocolVersion: 2,
          requestId: request.requestId,
          operation: 'analyze_trigger',
          outerRect: { x: 51, y: 51, width: 200, height: 100 },
          gameRect: null,
        })
        return Promise.resolve({
          requestId: request.requestId,
          stdout: encodeBinaryEnvelope({
            protocolVersion: 2,
            requestId: request.requestId,
            ok: true,
            profile,
            legacyProfile,
            vsOrientation: null,
            vsBadge: null,
          }),
        })
      }),
    }
    const service = new CaptureService(
      worker as never,
      'python.exe',
      'capture.py',
      'analyze_trigger.py',
    )

    await expect(
      service.analyze(
        { size: { width: 1000, height: 500 }, png: Buffer.from('frame') },
        { x: 0.0505, y: 0.101, width: 0.2005, height: 0.201 },
      ),
    ).resolves.toEqual({ profile, legacyProfile, vsOrientation: null, vsBadge: null })
  })

  it('forwards the prepared game rectangle in protocol 2 and preserves VS and both projections', async () => {
    const { service, execute } = analyzerService({ vsOrientation, vsBadge: badge })
    const gameRect = { x: 50, y: 0, width: 250, height: 450 }
    await expect(service.analyze(frame, region, undefined, gameRect)).resolves.toEqual({
      profile,
      legacyProfile,
      vsOrientation,
      vsBadge: badge,
    })
    const request = execute.mock.calls[0]?.[0]
    if (request === undefined) throw new Error('Analyzer request was not sent')
    const input = decodeBinaryEnvelope(request.input, {
      maxMetadataBytes: 64 * 1024,
      maxBinaryBytes: 32 * 1024 * 1024,
    })
    expect(input.metadata).toMatchObject({ protocolVersion: 2, gameRect })
    expect(input.binary).toEqual(frame.png)
  })

  it.each<[string, Record<string, unknown>]>([
    ['old protocol', { protocolVersion: 1 }],
    ['unknown output field', { extra: true }],
    ['missing orientation', { vsOrientation: undefined }],
    ['missing badge', { vsBadge: undefined }],
    ['unknown orientation field', { vsOrientation: { ...vsOrientation, extra: true } }],
    [
      'short orientation array',
      { vsOrientation: { ...vsOrientation, angleQ8Base64: 'AAAA' } },
    ],
    [
      'bad orientation geometry',
      {
        vsOrientation: {
          ...vsOrientation,
          normalizedSize: { width: 96, height: 63 },
        },
      },
    ],
    ['unknown badge field', { vsBadge: { ...badge, extra: true } }],
    ['bad badge geometry', { vsBadge: { ...badge, width: 0 } }],
  ])('rejects %s instead of discarding strict contract errors', async (_name, fields) => {
    const { service } = analyzerService(fields)
    await expect(service.analyze(frame, region)).rejects.toThrow()
  })

  it('preserves protocol-2 analyzer failures', async () => {
    const { service } = analyzerService({
      ok: false,
      profile: undefined,
      legacyProfile: undefined,
      vsOrientation: undefined,
      vsBadge: undefined,
      error: { code: 'ANALYSIS_FAILED', message: 'Selected trigger is too flat' },
    })
    await expect(service.analyze(frame, region)).rejects.toMatchObject({
      code: 'ANALYSIS_FAILED',
      message: 'Selected trigger is too flat',
    })
  })
})

describe('PreparedCaptureGameSchema', () => {
  const chrome = {
    top: 0,
    bottom: 0,
    left: 0,
    right: 0,
    topEdges: null,
    bottomEdges: null,
    leftEdges: null,
    rightEdges: null,
  }
  const game = {
    rect: { x: 40, y: 24, width: 360, height: 640 },
    aspect: 360 / 640,
    chrome,
    frames: 8,
  }

  it.each(['too_small', 'aspect_out_of_range', 'unstable', 'insufficient_frames'])(
    'accepts the exact Python failure reason %s',
    (reason) => {
      expect(PreparedCaptureGameSchema.parse({ rect: null, reason })).toEqual({
        rect: null,
        reason,
      })
    },
  )

  it('accepts the eight sampled frames plus an unsampled latest frame', () => {
    expect(PreparedCaptureGameSchema.parse({ ...game, frames: 9 })).toEqual({
      ...game,
      frames: 9,
    })
  })

  it.each([
    null,
    { rect: null, reason: 'ok' },
    { rect: null, reason: 'unknown' },
    { rect: null, reason: 'unstable', aspect: game.aspect },
    { ...game, extra: true },
    { ...game, rect: { ...game.rect, extra: true } },
    { ...game, rect: { ...game.rect, x: -1 } },
    { ...game, rect: { x: 0, y: 0, width: 45, height: 80 } },
    { ...game, aspect: 0.8 },
    { ...game, aspect: game.aspect + 0.001 },
    { ...game, frames: 7 },
    { ...game, frames: 10 },
    { ...game, chrome: { ...chrome, extra: true } },
    {
      ...game,
      chrome: {
        ...chrome,
        topEdges: {
          length: 256,
          thickness: 1,
          angleQ8Base64: 'AAAA',
          weightQ8Base64: 'AAAA',
        },
      },
    },
  ])('rejects malformed frozen game %#', (value) => {
    expect(PreparedCaptureGameSchema.safeParse(value).success).toBe(false)
  })
})
