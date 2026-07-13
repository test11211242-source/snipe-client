import { describe, expect, it, vi } from 'vitest'

import type { MonitorProcessListener } from './monitor-process-service'
import { MonitorSupervisor } from './monitor-supervisor'

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((nextResolve, nextReject) => {
    resolve = nextResolve
    reject = nextReject
  })
  return { promise, resolve, reject }
}

const configuration = {
  schemaVersion: 1 as const,
  userId: '42',
  revision: 1,
  fingerprint: 'a'.repeat(64),
  committedAt: '2026-07-12T12:00:00.000Z',
  source: {
    kind: 'window' as const,
    label: 'Game',
    titleHint: 'Game',
    executableLabel: null,
  },
  frameSize: { width: 1920, height: 1080 },
  regions: {
    trigger: { x: 0, y: 0, width: 0.2, height: 0.2 },
    normal: { x: 0, y: 0, width: 0.5, height: 0.5 },
    precise: { x: 0, y: 0, width: 1, height: 1 },
  },
  triggerProfile: {
    schemaVersion: 2 as const,
    analyzer: { name: 'cr-tools-trigger-analyzer' as const, version: '1.0.0' },
    hashAlgorithm: 'ahash64-bitwise-v1' as const,
    ahash64: '0123456789abcdef',
    innerRect: { x: 0, y: 0, width: 1, height: 1 },
    featureMode: 'ncc' as const,
    keypointsCount: 0,
    normalizedTemplateSize: { width: 128, height: 128 },
    templateGrayBase64: 'AAAA',
    hashMaxDistance: 18,
    orbDistanceThreshold: 55,
    orbMinGoodMatches: 10,
    nccMinScore: 0.72,
  },
}

function harness(
  resolveTarget = Promise.resolve({
    configuration,
    selector: { kind: 'window', windowHwnd: '12' },
  }),
) {
  let processListener: MonitorProcessListener | null = null
  const process = {
    start: vi.fn((_payload, listener: MonitorProcessListener) => {
      processListener = listener
      return Promise.resolve('session')
    }),
    stop: vi.fn().mockResolvedValue(undefined),
  }
  const ocr = { process: vi.fn() }
  const supervisor = new MonitorSupervisor(
    {
      getView: () => ({
        state: 'AUTHENTICATED',
        user: {
          id: '42',
          username: 'operator',
          email: 'operator@example.com',
          role: 'premium',
          roles: ['premium'],
        },
        deviceHint: null,
        error: null,
      }),
      getAccessToken: vi.fn().mockResolvedValue('token'),
    } as never,
    { load: vi.fn().mockResolvedValue(configuration) } as never,
    {
      load: vi.fn().mockResolvedValue({ searchMode: 'fast', deckMode: 'pol' }),
      save: vi.fn().mockResolvedValue({ searchMode: 'fast', deckMode: 'pol' }),
    } as never,
    { resolve: vi.fn(() => resolveTarget) } as never,
    process as never,
    ocr as never,
    () => new Date('2026-07-12T12:00:00.000Z'),
  )
  return { supervisor, process, ocr, listener: () => processListener }
}

describe('MonitorSupervisor concurrency', () => {
  it('coalesces simultaneous starts and becomes READY only after process readiness', async () => {
    const target = deferred<{
      configuration: typeof configuration
      selector: { kind: 'window'; windowHwnd: string }
    }>()
    const test = harness(target.promise)
    const first = test.supervisor.start()
    const second = test.supervisor.start()
    expect(first).toBe(second)
    expect((await test.supervisor.getView()).state).toBe('PREFLIGHT')
    target.resolve({ configuration, selector: { kind: 'window', windowHwnd: '12' } })
    await expect(first).resolves.toMatchObject({ state: 'READY' })
    expect(test.process.start).toHaveBeenCalledTimes(1)
  })

  it('cancels a start during preflight without spawning a stale child', async () => {
    const target = deferred<{
      configuration: typeof configuration
      selector: { kind: 'window'; windowHwnd: string }
    }>()
    const test = harness(target.promise)
    const starting = test.supervisor.start()
    const stopped = test.supervisor.stop()
    target.resolve({ configuration, selector: { kind: 'window', windowHwnd: '12' } })
    await expect(stopped).resolves.toMatchObject({ state: 'STOPPED' })
    await expect(starting).resolves.toMatchObject({ state: 'STOPPED' })
    expect(test.process.start).not.toHaveBeenCalled()
  })

  it('uses one active OCR plus one replaceable action and fences results after stop', async () => {
    const test = harness()
    await test.supervisor.start()
    const first = deferred<never>()
    const second = deferred<never>()
    test.ocr.process
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise)
    const action = {
      timestamp: '2026-07-12T12:00:00.000Z',
      width: 10,
      height: 10,
      image: Buffer.from('private'),
    }
    test.listener()?.onAction(action)
    test.listener()?.onAction({ ...action, timestamp: '2026-07-12T12:00:01.000Z' })
    test.listener()?.onAction({ ...action, timestamp: '2026-07-12T12:00:02.000Z' })
    expect(test.ocr.process).toHaveBeenCalledTimes(1)
    first.resolve({
      id: '29d970c1-fc4f-4bea-a767-8f108d3b8739',
      kind: 'player_not_found',
      timestamp: action.timestamp,
      searchMode: 'fast',
      deckMode: 'pol',
      searchedNickname: 'Ghost',
      message: 'Игрок не найден',
    } as never)
    await vi.waitFor(() => expect(test.ocr.process).toHaveBeenCalledTimes(2))
    expect((await test.supervisor.getView()).stats.droppedActions).toBe(1)
    await test.supervisor.stop()
    second.resolve({
      id: '1b9da80f-e290-4ea6-ac83-ff2e212cdb2a',
      kind: 'player_found',
      timestamp: action.timestamp,
      searchMode: 'fast',
      deckMode: 'pol',
      searchedNickname: 'Late',
      player: { name: 'Late', tag: null, rating: null, clan: null },
      decks: [],
    } as never)
    await Promise.resolve()
    expect((await test.supervisor.getView()).results).toHaveLength(1)
  })

  it('fails on unexpected child exit and ignores the old listener after restart', async () => {
    const test = harness()
    await test.supervisor.start()
    const oldListener = test.listener()
    oldListener?.onExit(
      Object.assign(new Error('closed'), { code: 'MONITOR_PROCESS_EXITED' }) as never,
    )
    expect((await test.supervisor.getView()).state).toBe('FAILED')
    await test.supervisor.restart()
    oldListener?.onFatal(Object.assign(new Error('stale'), { code: 'STALE' }) as never)
    expect((await test.supervisor.getView()).state).toBe('READY')
    expect(test.process.start).toHaveBeenCalledTimes(2)
  })

  it('notifies isolated result listeners and exposes only currently retained results', async () => {
    const test = harness()
    await test.supervisor.start()
    const id = '29d970c1-fc4f-4bea-a767-8f108d3b8739'
    const observed = vi.fn()
    const disposeThrowing = test.supervisor.subscribeResults((result) => {
      if (result.kind === 'player_found') result.player.name = 'mutated'
      throw new Error('listener failure')
    })
    const disposeAsyncThrowing = test.supervisor.subscribeResults(async () => {
      await Promise.resolve()
      throw new Error('async listener failure')
    })
    const disposeObserved = test.supervisor.subscribeResults(observed)
    test.ocr.process.mockResolvedValue({
      id,
      kind: 'player_found',
      timestamp: '2026-07-12T12:00:00.000Z',
      searchMode: 'fast',
      deckMode: 'pol',
      searchedNickname: 'Player',
      player: { name: 'Player', tag: null, rating: null, clan: null },
      decks: [],
    })
    test.listener()?.onAction({
      timestamp: '2026-07-12T12:00:00.000Z',
      width: 10,
      height: 10,
      image: Buffer.from('private'),
    })
    await vi.waitFor(() => expect(observed).toHaveBeenCalledTimes(1))
    expect(test.supervisor.getRetainedResult(id)).toMatchObject({
      id,
      player: { name: 'Player' },
    })
    expect(
      test.supervisor.getRetainedResult('1b9da80f-e290-4ea6-ac83-ff2e212cdb2a'),
    ).toBeNull()
    disposeThrowing()
    disposeAsyncThrowing()
    disposeObserved()
  })

  it('validates and retains bounded external results through the normal result pipeline', async () => {
    const test = harness()
    const observed = vi.fn()
    test.supervisor.subscribeResults(observed)
    const result = {
      id: '29d970c1-fc4f-4bea-a767-8f108d3b8739',
      kind: 'player_found' as const,
      timestamp: '2026-07-12T12:00:00.000Z',
      searchMode: 'fast' as const,
      deckMode: 'pol' as const,
      searchedNickname: 'External',
      player: { name: 'External', tag: null, rating: null, clan: null },
      decks: [],
    }
    test.supervisor.addExternalResult(result)
    expect(test.supervisor.getLatestResult()).toEqual(result)
    expect((await test.supervisor.getView()).stats.playersFound).toBe(1)
    expect(observed).toHaveBeenCalledWith(result)
    expect(() =>
      test.supervisor.addExternalResult({ ...result, raw: 'not allowed' }),
    ).toThrow()
    expect((await test.supervisor.getView()).results).toHaveLength(1)
  })

  it('restarts one worker with prediction profile and emits distinct private runtime events', async () => {
    const test = harness()
    await test.supervisor.start()
    const battle = vi.fn()
    const result = vi.fn()
    test.supervisor.subscribeBattleStarts(battle)
    test.supervisor.subscribePredictionResults(result)
    await test.supervisor.configurePredictionRuntime({
      configuredFrameSize: configuration.frameSize,
      trigger: configuration.regions.trigger,
      data: configuration.regions.normal,
      triggerProfile: configuration.triggerProfile,
    })
    expect(test.process.start).toHaveBeenCalledTimes(2)
    expect(test.process.start.mock.calls[1]?.[0]).toMatchObject({
      prediction: { configuredFrameSize: configuration.frameSize },
    })
    const action = {
      timestamp: '2026-07-12T12:00:00.000Z',
      width: 10,
      height: 10,
      image: Buffer.from('private'),
    }
    test.ocr.process.mockResolvedValue({
      id: '29d970c1-fc4f-4bea-a767-8f108d3b8739',
      kind: 'player_not_found',
      timestamp: action.timestamp,
      searchMode: 'fast',
      deckMode: 'pol',
      searchedNickname: null,
      message: 'not found',
    })
    test.listener()?.onAction(action)
    test.listener()?.onPredictionResult(action)
    expect(battle).toHaveBeenCalledWith(action.timestamp)
    expect(result).toHaveBeenCalledWith(expect.objectContaining({ image: action.image }))
    await vi.waitFor(async () =>
      expect((await test.supervisor.getView()).results).toHaveLength(1),
    )
  })
})
