import { describe, expect, it, vi } from 'vitest'

import { decodeBinaryEnvelope, encodeBinaryEnvelope } from './binary-protocol'
import { CaptureService } from './capture-service'
import type { PythonWorkerRequest, PythonWorkerService } from './python-worker-service'

const frame = { size: { width: 100, height: 200 }, png: Buffer.from('confirmation PNG') }
const rect = { x: 0.1, y: 0.2, width: 0.4, height: 0.3 }

describe('CaptureService confirmation crop', () => {
  it('crops the retained PNG in memory using the analyzer worker and passes cancellation', async () => {
    const crop = Buffer.from('cropped PNG')
    const worker = {
      execute: vi.fn((request: PythonWorkerRequest) => {
        const input = decodeBinaryEnvelope(request.input, {
          maxMetadataBytes: 1024,
          maxBinaryBytes: 1024,
        })
        expect(input.metadata).toEqual({
          protocolVersion: 2,
          requestId: request.requestId,
          operation: 'crop_region',
          outerRect: { x: 10, y: 40, width: 40, height: 60 },
        })
        expect(input.binary).toEqual(frame.png)
        return Promise.resolve({
          requestId: request.requestId,
          stdout: encodeBinaryEnvelope(
            {
              protocolVersion: 2,
              requestId: request.requestId,
              ok: true,
              width: 40,
              height: 60,
              mimeType: 'image/png',
              byteLength: crop.byteLength,
            },
            crop,
          ),
        })
      }),
    }
    const service = new CaptureService(
      worker as unknown as PythonWorkerService,
      'python.exe',
      'capture.py',
      'analyze_trigger.py',
    )
    const controller = new AbortController()
    expect(await service.crop(frame, rect, controller.signal)).toEqual(crop)
    expect(worker.execute).toHaveBeenCalledWith(
      expect.objectContaining({
        scriptPath: 'analyze_trigger.py',
        signal: controller.signal,
        timeoutMs: 12_000,
      }),
    )
  })

  it.each(['request', 'size', 'length', 'failure'] as const)(
    'rejects invalid crop response (%s)',
    async (fault) => {
      const crop = Buffer.from('cropped PNG')
      const worker = {
        execute: vi.fn((request: PythonWorkerRequest) =>
          Promise.resolve({
            requestId: request.requestId,
            stdout: encodeBinaryEnvelope(
              fault === 'failure'
                ? {
                    protocolVersion: 2,
                    requestId: request.requestId,
                    ok: false,
                    error: { code: 'ANALYSIS_FAILED', message: 'bad frame' },
                  }
                : {
                    protocolVersion: 2,
                    requestId:
                      fault === 'request'
                        ? '00000000-0000-4000-8000-000000000001'
                        : request.requestId,
                    ok: true,
                    width: fault === 'size' ? 39 : 40,
                    height: 60,
                    mimeType: 'image/png',
                    byteLength: crop.byteLength + (fault === 'length' ? 1 : 0),
                  },
              crop,
            ),
          }),
        ),
      }
      const service = new CaptureService(
        worker as unknown as PythonWorkerService,
        'python.exe',
        'capture.py',
        'analyze_trigger.py',
      )
      await expect(service.crop(frame, rect)).rejects.toMatchObject({
        code:
          fault === 'request'
            ? 'WORKER_RESULT_STALE'
            : fault === 'failure'
              ? 'ANALYSIS_FAILED'
              : 'CAPTURE_INVALID',
      })
    },
  )
})
