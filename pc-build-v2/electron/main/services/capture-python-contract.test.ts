import { spawn, spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { beforeAll, describe, expect, it, vi } from 'vitest'

import { pythonTestExecutable } from '../../../scripts/python-test-interpreter.mjs'
import { CaptureService } from './capture-service'
import {
  PreparedCaptureProcessService,
  type PreparedCaptureSpawn,
  type PreparedCaptureChild,
} from './prepared-capture-process-service'
import { PythonWorkerService } from './python-worker-service'

const pythonDirectory = fileURLToPath(new URL('../../../python/', import.meta.url))
const harnessPath = fileURLToPath(
  new URL('../../../python/tests/setup_contract_harness.py', import.meta.url),
)
const analyzePath = fileURLToPath(
  new URL('../../../python/analyze_trigger.py', import.meta.url),
)

function fixture(mode: 'fixture-vs' | 'fixture-non-vs'): Buffer {
  const result = spawnSync(pythonTestExecutable, ['-B', harnessPath, mode], {
    cwd: pythonDirectory,
    windowsHide: true,
    timeout: 15_000,
    maxBuffer: 2 * 1024 * 1024,
    env: { ...process.env, SNIPE_SETUP_CONTRACT_FRAME: '' },
  })
  if (result.error !== undefined) throw result.error
  if (result.status !== 0) {
    throw new Error(
      `Python fixture failed (${result.status ?? 'unknown'}): ${result.stderr.toString()}`,
    )
  }
  expect(result.stdout.subarray(0, 8)).toEqual(
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
  )
  return result.stdout
}

function preparedService(mode: 'prepared' | 'prepared-insufficient') {
  let closed: Promise<void> | undefined
  const spawnPrepared: PreparedCaptureSpawn = (executable, args, options) => {
    const child = spawn(executable, [...args, mode], {
      ...options,
      cwd: pythonDirectory,
      env: { ...options.env, SNIPE_SETUP_CONTRACT_FRAME: '' },
    })
    closed = new Promise<void>((resolve) => child.once('close', () => resolve()))
    return child as PreparedCaptureChild
  }
  return {
    service: new PreparedCaptureProcessService(
      pythonTestExecutable,
      harnessPath,
      { warn: vi.fn() },
      spawnPrepared,
    ),
    waitForClose: () => {
      if (closed === undefined) throw new Error('Prepared Python was not started')
      return closed
    },
  }
}

describe('genuine Python setup output → strict TS capture contracts', () => {
  beforeAll(() => {
    if (!existsSync(pythonTestExecutable)) {
      throw new Error(
        'Python contract tests require the worktree .venv; run npm run test:python first.',
      )
    }
  })

  it('parses prepared_capture.main CRT2 frozen output with temporal chrome history', async () => {
    const { service, waitForClose } = preparedService('prepared')
    try {
      const prepared = await service.start({ kind: 'window', windowHwnd: '123' })
      expect(prepared.size).toEqual({ width: 440, height: 712 })
      const frame = await service.freeze(prepared.sessionId)
      expect(frame.size).toEqual(prepared.size)
      expect(frame.game).toMatchObject({
        rect: { x: 40, y: 48, width: 360, height: 640 },
        aspect: 360 / 640,
        frames: 8,
        chrome: { top: 24, bottom: 0, left: 0, right: 0 },
      })
      if (!frame.game?.rect) {
        throw new Error('Python did not detect the synthetic game')
      }
      expect(frame.game.chrome.topEdges?.length).toBe(256)
      expect(frame.game.chrome.topEdges?.angleQ8Base64.length).toBeGreaterThan(0)
      expect(frame.png.readUInt32BE(16)).toBe(frame.size.width)
      expect(frame.png.readUInt32BE(20)).toBe(frame.size.height)
      await waitForClose()
    } finally {
      await service.stop()
    }
  }, 30_000)

  it('parses actual insufficient-history output without fabricating game geometry', async () => {
    const { service, waitForClose } = preparedService('prepared-insufficient')
    try {
      const prepared = await service.start({ kind: 'window', windowHwnd: '123' })
      const frame = await service.freeze(prepared.sessionId)
      expect(frame.game).toEqual({ rect: null, reason: 'insufficient_frames' })
      await waitForClose()
    } finally {
      await service.stop()
    }
  }, 30_000)

  it('parses protocol-2 VS output from the real analyzer subprocess and preserves both projections', async () => {
    const service = new CaptureService(
      new PythonWorkerService(),
      pythonTestExecutable,
      '',
      analyzePath,
    )
    const frame = {
      size: { width: 360, height: 640 },
      png: fixture('fixture-vs'),
    }
    const result = await service.analyze(
      frame,
      { x: 120 / 360, y: 215 / 640, width: 120 / 360, height: 120 / 640 },
      undefined,
      { x: 0, y: 0, width: 360, height: 640 },
    )
    expect(result.profile.schemaVersion).toBe(3)
    expect(result.profile.structureTemplateBase64.length).toBeGreaterThan(0)
    expect(result.legacyProfile.analyzerVersion).toBe('trigger-profile-v2')
    expect(result.legacyProfile.templateGrayBase64.length).toBeGreaterThan(0)
    expect(result.vsOrientation?.algorithm).toBe('vs-orient-1')
    expect(result.vsOrientation?.badge).toEqual(result.vsBadge)
    expect(result.vsBadge?.cx).toBeCloseTo(0.496, 2)
    expect(result.vsBadge?.cy).toBeCloseTo(0.429, 2)

    // Prediction-result setup must remain structural even on this same VS frame.
    const prediction = await service.analyze(frame, {
      x: 120 / 360,
      y: 215 / 640,
      width: 120 / 360,
      height: 120 / 640,
    })
    expect(prediction.vsOrientation).toBeNull()
    expect(prediction.vsBadge).toBeNull()
    expect(prediction.profile).toEqual(result.profile)
    expect(prediction.legacyProfile).toEqual(result.legacyProfile)
  }, 30_000)

  it('parses protocol-2 non-VS output with a supplied game rectangle', async () => {
    const service = new CaptureService(
      new PythonWorkerService(),
      pythonTestExecutable,
      '',
      analyzePath,
    )
    const result = await service.analyze(
      { size: { width: 320, height: 240 }, png: fixture('fixture-non-vs') },
      { x: 40 / 320, y: 30 / 240, width: 240 / 320, height: 180 / 240 },
      undefined,
      { x: 0, y: 0, width: 320, height: 240 },
    )
    expect(result.vsOrientation).toBeNull()
    expect(result.vsBadge).toBeNull()
    expect(result.profile.schemaVersion).toBe(3)
    expect(result.legacyProfile.analyzerVersion).toBe('trigger-profile-v2')
  }, 30_000)
})
