import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'

import { describe, expect, it, vi } from 'vitest'

import {
  createCaptureSourceHelpers,
  parsePhysicalDisplays,
  parseWindowMetadata,
  parseWindowPreview,
  runCaptureSourceHelper,
  type HelperChild,
  type WindowPreviewRecord,
} from './capture-source-helper'

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]).toString('base64')

class FakeChild extends EventEmitter implements HelperChild {
  readonly stdin = new PassThrough()
  readonly stdout = new PassThrough()
  readonly kill = vi.fn(() => true)
  request = ''

  constructor() {
    super()
    this.stdin.on('data', (chunk: Buffer) => {
      this.request += chunk.toString()
    })
  }

  send(...records: unknown[]): void {
    this.stdout.write(records.map((value) => `${JSON.stringify(value)}\n`).join(''))
  }

  exit(code: number): void {
    this.stdout.end()
    setImmediate(() => this.emit('close', code))
  }
}

function spawnOnce(child: FakeChild) {
  return vi.fn(() => child)
}

const OPTIONS = { executable: 'python.exe', scriptPath: 'capture_sources.py' }

describe('capture source helper records', () => {
  it('accepts exact display records and rejects malformed device names or bounds', () => {
    const display = {
      deviceName: '\\\\.\\DISPLAY1',
      bounds: { x: -5, y: 0, width: 10, height: 20 },
    }
    expect(parsePhysicalDisplays({ displays: [display] })).toEqual([display])
    for (const bad of [
      { displays: [] },
      { displays: [{ ...display, deviceName: 'DISPLAY1' }] },
      { displays: [{ ...display, bounds: { ...display.bounds, width: 0 } }] },
      { displays: [{ ...display, extra: 1 }] },
      { displays: [display], extra: 1 },
    ])
      expect(() => parsePhysicalDisplays(bad)).toThrow()
  })

  it('keeps only requested well-formed window metadata entries', () => {
    expect(
      parseWindowMetadata(
        {
          windows: [
            { windowHwnd: '1', ownerProcessId: 5, executableLabel: 'Game.exe' },
            { windowHwnd: '2', ownerProcessId: 6, executableLabel: null },
            { windowHwnd: '3', ownerProcessId: 7, executableLabel: 'Other.exe' },
            { windowHwnd: '1', ownerProcessId: 0, executableLabel: 'Bad.exe' },
            { windowHwnd: '2', ownerProcessId: 6, executableLabel: 'x'.repeat(121) },
          ],
        },
        new Set(['1', '2']),
      ),
    ).toEqual([
      { windowHwnd: '1', ownerProcessId: 5, executableLabel: 'Game.exe' },
      { windowHwnd: '2', ownerProcessId: 6, executableLabel: null },
    ])
  })

  it('validates preview size, title and JPEG bytes', () => {
    const requested = new Set(['1'])
    const max = { width: 360, height: 203 }
    const ok = {
      windowHwnd: '1',
      status: 'ok',
      title: 'Game',
      width: 360,
      height: 200,
      jpeg: JPEG,
    }
    expect(parseWindowPreview(ok, requested, max)).toMatchObject({
      status: 'ok',
      size: { width: 360, height: 200 },
      title: 'Game',
    })
    expect(
      parseWindowPreview({ windowHwnd: '1', status: 'failed' }, requested, max),
    ).toEqual({
      windowHwnd: '1',
      status: 'failed',
    })
    for (const bad of [
      { ...ok, windowHwnd: '2' },
      { ...ok, width: 361 },
      { ...ok, jpeg: Buffer.from('not a jpeg').toString('base64') },
      { ...ok, jpeg: 'not base64!' },
      { ...ok, title: 'x'.repeat(301) },
      { windowHwnd: '1', status: 'unavailable', title: 'Game' },
    ])
      expect(() => parseWindowPreview(bad, requested, max)).toThrow()
  })
})

describe('runCaptureSourceHelper', () => {
  it('sends the request on stdin and delivers each line as it arrives', async () => {
    const child = new FakeChild()
    const records: unknown[] = []
    const done = runCaptureSourceHelper(
      { ...OPTIONS, spawn: spawnOnce(child) },
      { op: 'displays' },
      1_000,
      (value) => records.push(value),
    )
    child.stdout.write('{"a":')
    child.stdout.write('1}\n{"b":2}\n')
    await vi.waitFor(() => expect(records).toEqual([{ a: 1 }, { b: 2 }]))
    child.exit(0)
    await done
    expect(JSON.parse(child.request)).toEqual({ op: 'displays' })
  })

  it('kills the helper on timeout, invalid output or a failed exit', async () => {
    const slow = new FakeChild()
    await expect(
      runCaptureSourceHelper(
        { ...OPTIONS, spawn: spawnOnce(slow) },
        {},
        5,
        () => undefined,
      ),
    ).rejects.toMatchObject({ name: 'CaptureSourceHelperError', reason: 'timeout' })
    expect(slow.kill).toHaveBeenCalledOnce()

    const garbled = new FakeChild()
    const invalid = runCaptureSourceHelper(
      { ...OPTIONS, spawn: spawnOnce(garbled) },
      {},
      1_000,
      () => undefined,
    )
    garbled.stdout.write('not json\n')
    await expect(invalid).rejects.toMatchObject({ reason: 'output' })
    expect(garbled.kill).toHaveBeenCalledOnce()

    const failing = new FakeChild()
    const failed = runCaptureSourceHelper(
      { ...OPTIONS, spawn: spawnOnce(failing) },
      {},
      1_000,
      () => undefined,
    )
    failing.exit(1)
    await expect(failed).rejects.toMatchObject({ reason: 'exit' })
  })
})

describe('createCaptureSourceHelpers', () => {
  it('runs the runtime gate first and parses metadata for the requested windows', async () => {
    const child = new FakeChild()
    const beforeSpawn = vi.fn(() => Promise.resolve())
    const helpers = createCaptureSourceHelpers({
      ...OPTIONS,
      beforeSpawn,
      spawn: spawnOnce(child),
    })
    const result = helpers.windowMetadata(['42'])
    await vi.waitFor(() => expect(child.request).not.toBe(''))
    expect(beforeSpawn).toHaveBeenCalledOnce()
    expect(JSON.parse(child.request)).toEqual({ op: 'windows', handles: ['42'] })
    child.send({
      windows: [{ windowHwnd: '42', ownerProcessId: 9, executableLabel: 'Game.exe' }],
    })
    child.exit(0)
    await expect(result).resolves.toEqual([
      { windowHwnd: '42', ownerProcessId: 9, executableLabel: 'Game.exe' },
    ])
  })

  it('rejects invalid handles before starting a process', async () => {
    const spawn = vi.fn()
    const helpers = createCaptureSourceHelpers({ ...OPTIONS, spawn })
    await expect(helpers.windowMetadata(["42'; exit"])).rejects.toThrow()
    await expect(helpers.windowMetadata([])).resolves.toEqual([])
    expect(spawn).not.toHaveBeenCalled()
  })

  it('streams preview records and refuses a second record for one window', async () => {
    const child = new FakeChild()
    const helpers = createCaptureSourceHelpers({ ...OPTIONS, spawn: spawnOnce(child) })
    const records: WindowPreviewRecord[] = []
    const result = helpers.windowPreviews(
      ['1', '2'],
      { width: 360, height: 203 },
      (record) => records.push(record),
    )
    await vi.waitFor(() => expect(child.request).not.toBe(''))
    expect(JSON.parse(child.request)).toEqual({
      op: 'previews',
      handles: ['1', '2'],
      maxWidth: 360,
      maxHeight: 203,
    })
    child.send({
      windowHwnd: '1',
      status: 'ok',
      title: 'A',
      width: 10,
      height: 10,
      jpeg: JPEG,
    })
    await vi.waitFor(() => expect(records).toHaveLength(1))
    child.send({ windowHwnd: '1', status: 'failed' })
    await expect(result).rejects.toMatchObject({ reason: 'output' })
    expect(child.kill).toHaveBeenCalledOnce()
  })
})
