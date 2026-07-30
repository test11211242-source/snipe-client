import { describe, expect, it, vi } from 'vitest'

import { CaptureService } from './capture-service'
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

describe('CaptureService trigger analyzer protocol', () => {
  it('parses the framed V3 profile and transient V1 projection together', async () => {
    const worker = {
      execute: vi.fn((request: { requestId: string; input: Buffer }) => {
        const input = decodeBinaryEnvelope(request.input, {
          maxMetadataBytes: 64 * 1024,
          maxBinaryBytes: 32 * 1024 * 1024,
        })
        expect(input.metadata).toMatchObject({
          requestId: request.requestId,
          operation: 'analyze_trigger',
          outerRect: { x: 51, y: 51, width: 200, height: 100 },
        })
        return Promise.resolve({
          requestId: request.requestId,
          stdout: encodeBinaryEnvelope({
            protocolVersion: 1,
            requestId: request.requestId,
            ok: true,
            profile,
            legacyProfile,
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
    ).resolves.toEqual({ profile, legacyProfile })
  })
})
