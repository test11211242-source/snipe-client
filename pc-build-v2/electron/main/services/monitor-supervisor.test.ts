import { afterEach, describe, expect, it, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import { MonitorResultSchema } from '../../../shared/models/monitor'
import type { MonitorJournalRepository } from '../infrastructure/monitor-journal-repository'

import type { MonitorStartPayload } from '../../../shared/contracts/monitor-protocol'
import type { MonitorProcessListener } from './monitor-process-service'
import { MonitorSupervisor } from './monitor-supervisor'
import { ApplicationError } from '../../../shared/errors/application-error'
import { v4CaptureFixture } from '../../../tests/capture-fixtures'

function deferred<T>() {
  return Promise.withResolvers<T>()
}

const configuration = v4CaptureFixture({
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
    schemaVersion: 3 as const,
    analyzer: { name: 'cr-tools-trigger-analyzer' as const, version: '2.0.0' },
    innerRect: { x: 0, y: 0, width: 1, height: 1 },
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
      keypointsCount: 0,
      cropConfidence: 0,
      cropAreaRatio: 1,
    },
  },
})

function harness(
  resolveTarget = Promise.resolve({
    configuration,
    selector: { kind: 'window', windowHwnd: '12' },
  }),
  now: () => Date = () => new Date('2026-07-12T12:00:00.000Z'),
  journalRepository?: MonitorJournalRepository,
) {
  let currentUserId: string | null = '42'
  let processListener: MonitorProcessListener | null = null
  const captureConfigurations = {
    load: vi.fn().mockResolvedValue(configuration),
    getActive: vi.fn().mockResolvedValue({
      collectionRevision: 1,
      profile: { profileId: '00000000-0000-4000-8000-000000000001', configuration },
    }),
  }
  const preferenceRepository = {
    load: vi.fn().mockResolvedValue({ deckMode: 'pol' }),
    save: vi.fn((_user: string, value: unknown) => Promise.resolve(value)),
  }
  const targetResolver = { resolve: vi.fn(() => resolveTarget) }
  const process = {
    start: vi.fn((_payload: MonitorStartPayload, listener: MonitorProcessListener) => {
      processListener = listener
      return Promise.resolve('session')
    }),
    stop: vi.fn().mockResolvedValue(undefined),
  }
  const ocr = { process: vi.fn() }
  const supervisor = new MonitorSupervisor(
    {
      getView: () => ({
        state: currentUserId === null ? 'UNAUTHENTICATED' : 'AUTHENTICATED',
        user:
          currentUserId === null
            ? null
            : {
                id: currentUserId,
                username: `operator-${currentUserId}`,
                email: `${currentUserId}@example.com`,
                role: 'premium',
                roles: ['premium'],
              },
        error: null,
      }),
      getAccessToken: vi.fn().mockResolvedValue('token'),
    } as never,
    captureConfigurations as never,
    preferenceRepository as never,
    targetResolver as never,
    process as never,
    ocr as never,
    now,
    journalRepository,
  )
  return {
    supervisor,
    process,
    ocr,
    captureConfigurations,
    preferences: preferenceRepository,
    targetResolver,
    listener: () => processListener,
    user: (userId: string | null) => {
      currentUserId = userId
    },
  }
}

afterEach(() => vi.useRealTimers())

describe('MonitorSupervisor concurrency', () => {
  it.each([
    'CAPTURE_SOURCE_CLOSED',
    'CAPTURE_START_FAILED',
    'CAPTURE_NO_FRAME',
    'CAPTURE_FRAME_INVALID',
    'CAPTURE_GEOMETRY_CHANGED',
    'MONITOR_INTERNAL_FAILED',
  ] as const)('projects a sanitized Russian fatal cause: %s', async (code) => {
    const test = harness()
    await test.supervisor.start()
    const events = test.listener()
    if (events === null) throw new Error('Missing process listener')
    events.onFatal(new ApplicationError(code, 'private arbitrary diagnostic'))
    const view = await test.supervisor.getView()
    expect(view.state).toBe(
      ['CAPTURE_SOURCE_CLOSED', 'CAPTURE_NO_FRAME'].includes(code)
        ? 'WAITING_SOURCE'
        : 'FAILED',
    )
    expect(view.error?.code).toBe(code)
    expect(view.error?.message).toMatch(/[А-Яа-я]/)
    expect(view.error?.message).not.toContain('private')
    expect(test.process.stop).toHaveBeenCalled()
    await test.supervisor.stop()
  })
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
    expect(test.process.start).toHaveBeenCalledWith(
      expect.objectContaining({ capturePolicy: 'immediate_nickname' }),
      expect.anything(),
    )
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

  it('allows a new start after a cancelled preflight never settles', async () => {
    const stalled = deferred<{
      configuration: typeof configuration
      selector: { kind: 'window'; windowHwnd: string }
    }>()
    const test = harness()
    test.targetResolver.resolve
      .mockReturnValueOnce(stalled.promise)
      .mockResolvedValueOnce({
        configuration,
        selector: { kind: 'window', windowHwnd: '12' },
      })

    const abandoned = test.supervisor.start()
    await vi.waitFor(() => expect(test.targetResolver.resolve).toHaveBeenCalledOnce())
    await test.supervisor.stop()
    await expect(test.supervisor.start()).resolves.toMatchObject({ state: 'READY' })
    expect(test.process.start).toHaveBeenCalledTimes(1)

    stalled.resolve({
      configuration,
      selector: { kind: 'window', windowHwnd: '12' },
    })
    await expect(abandoned).resolves.toMatchObject({ state: 'STOPPED' })
    expect(test.process.start).toHaveBeenCalledTimes(1)
  })

  it('restarts an in-flight preflight when the prediction runtime changes', async () => {
    const target = deferred<{
      configuration: typeof configuration
      selector: { kind: 'window'; windowHwnd: string }
    }>()
    const test = harness(target.promise)
    const starting = test.supervisor.start()
    const configuring = test.supervisor.configurePredictionRuntime({
      configuredFrameSize: configuration.calibration.referenceFrameSize,
      trigger: configuration.calibration.triggerRegion,
      data: configuration.calibration.nicknameRegion,
      triggerProfile: configuration.calibration.triggerProfile,
    })
    target.resolve({ configuration, selector: { kind: 'window', windowHwnd: '12' } })

    await starting
    await expect(configuring).resolves.toMatchObject({ state: 'READY' })
    expect(test.process.start).toHaveBeenCalledTimes(1)
    expect(test.process.start.mock.calls[0]?.[0].prediction?.configuredFrameSize).toEqual(
      configuration.calibration.referenceFrameSize,
    )
  })

  it('does not restart when a user stop joins an internal restart', async () => {
    const test = harness()
    await test.supervisor.start()
    const stopping = deferred<undefined>()
    test.process.stop.mockReturnValueOnce(stopping.promise)
    const restart = test.supervisor.restart()
    const userStop = test.supervisor.stop()
    stopping.resolve(undefined)

    await Promise.all([restart, userStop])
    expect((await test.supervisor.getView()).state).toBe('STOPPED')
    expect(test.process.start).toHaveBeenCalledTimes(1)
  })

  it('keeps immediate nickname policy when deck mode changes while READY', async () => {
    const test = harness()
    await test.supervisor.start()
    await expect(test.supervisor.updatePreferences({ deckMode: 'gt' })).resolves.toEqual({
      deckMode: 'gt',
    })
    expect(test.process.start).toHaveBeenCalledWith(
      expect.objectContaining({ capturePolicy: 'immediate_nickname' }),
      expect.anything(),
    )
    expect(test.process.start).toHaveBeenCalledTimes(1)
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
    test.listener()?.onTriggered(action.timestamp)
    test.listener()?.onAction(action)
    test.listener()?.onTriggered('2026-07-12T12:00:01.000Z')
    test.listener()?.onAction({ ...action, timestamp: '2026-07-12T12:00:01.000Z' })
    test.listener()?.onTriggered('2026-07-12T12:00:02.000Z')
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
      capturePolicy: null,
      sessionId: null,
      triggerId: null,
      attemptId: null,
      profileId: null,
      calibrationRevision: null,
      repeat: null,
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
      reprocessed: false,
      capturePolicy: null,
      sessionId: null,
      triggerId: null,
      attemptId: null,
      profileId: null,
      calibrationRevision: null,
      repeat: null,
    }
    test.supervisor.addExternalResult(result)
    expect(test.supervisor.getLatestResult()).toEqual(result)
    expect((await test.supervisor.getView()).stats.playersFound).toBe(0)
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
      configuredFrameSize: configuration.calibration.referenceFrameSize,
      trigger: configuration.calibration.triggerRegion,
      data: configuration.calibration.nicknameRegion,
      triggerProfile: configuration.calibration.triggerProfile,
    })
    expect(test.process.start).toHaveBeenCalledTimes(2)
    expect(test.process.start.mock.calls[1]?.[0]).toMatchObject({
      prediction: { configuredFrameSize: configuration.calibration.referenceFrameSize },
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
    test.listener()?.onTriggered(action.timestamp)
    test.listener()?.onAction(action)
    test.listener()?.onPredictionResult(action)
    expect(battle).toHaveBeenCalledWith(action.timestamp)
    expect((await test.supervisor.getView()).stats.triggers).toBe(1)
    expect(result).toHaveBeenCalledWith(expect.objectContaining({ image: action.image }))
    await vi.waitFor(async () =>
      expect((await test.supervisor.getView()).results).toHaveLength(1),
    )
  })

  it('clears retained user state on A -> logout -> B but preserves it on ordinary stop', async () => {
    const test = harness()
    await test.supervisor.start()
    await test.supervisor.configurePredictionRuntime({
      configuredFrameSize: configuration.calibration.referenceFrameSize,
      trigger: configuration.calibration.triggerRegion,
      data: configuration.calibration.nicknameRegion,
      triggerProfile: configuration.calibration.triggerProfile,
    })
    const result = {
      id: '29d970c1-fc4f-4bea-a767-8f108d3b8739',
      kind: 'player_not_found' as const,
      timestamp: '2026-07-12T12:00:00.000Z',
      searchMode: 'fast' as const,
      deckMode: 'pol' as const,
      searchedNickname: 'A-only',
      message: 'not found',
    }
    test.supervisor.addExternalResult(result)
    await test.supervisor.stop()
    expect(test.supervisor.getLatestResult()).toMatchObject(result)

    test.user(null)
    expect(test.supervisor.getLatestResult()).toBeNull()
    expect(test.supervisor.setUserContext(null)).toBe(true)
    expect(await test.supervisor.getView()).toMatchObject({
      stats: { playersNotFound: 0 },
      results: [],
    })

    test.user('84')
    expect(test.supervisor.setUserContext('84')).toBe(true)
    await test.supervisor.start()
    expect(test.process.start).toHaveBeenLastCalledWith(
      expect.objectContaining({ prediction: null }),
      expect.anything(),
    )
    expect(test.supervisor.getRetainedResult(result.id)).toBeNull()
  })

  it('fences deferred start work from spawning after A changes to B', async () => {
    const target = deferred<{
      configuration: typeof configuration
      selector: { kind: 'window'; windowHwnd: string }
    }>()
    const test = harness(target.promise)
    const starting = test.supervisor.start()
    await vi.waitFor(() => expect(test.targetResolver.resolve).toHaveBeenCalledOnce())
    await test.supervisor.stop()
    test.user('84')
    test.supervisor.setUserContext('84')
    target.resolve({ configuration, selector: { kind: 'window', windowHwnd: '12' } })
    await expect(starting).resolves.toMatchObject({ state: 'STOPPED' })
    expect(test.process.start).not.toHaveBeenCalled()
  })

  it('rejects stale deferred preference reads and writes without patching B', async () => {
    const reading = harness()
    const loaded = deferred<{ deckMode: 'gt' }>()
    reading.preferences.load.mockReturnValueOnce(loaded.promise)
    const getPreferences = reading.supervisor.getPreferences()
    reading.user('84')
    reading.supervisor.setUserContext('84')
    loaded.resolve({ deckMode: 'gt' })
    await expect(getPreferences).rejects.toMatchObject({ code: 'MONITOR_CONTEXT_STALE' })
    expect((await reading.supervisor.getView()).preferences).toEqual({ deckMode: 'pol' })

    const writing = harness()
    const saved = deferred<{ deckMode: 'gt' }>()
    writing.preferences.save.mockReturnValueOnce(saved.promise)
    const update = writing.supervisor.updatePreferences({ deckMode: 'gt' })
    writing.user(null)
    writing.supervisor.setUserContext(null)
    saved.resolve({ deckMode: 'gt' })
    await expect(update).rejects.toMatchObject({ code: 'MONITOR_CONTEXT_STALE' })
    expect((await writing.supervisor.getView()).preferences).toEqual({ deckMode: 'pol' })
  })
})

function foundResult(at: Date, tag: string | null = '#TAG') {
  return MonitorResultSchema.parse({
    id: randomUUID(),
    kind: 'player_found',
    timestamp: at.toISOString(),
    searchMode: 'fast',
    deckMode: 'pol',
    searchedNickname: 'Opponent',
    player: { name: 'Opponent', tag, rating: null, clan: null },
    decks: [],
  })
}

describe('MonitorSupervisor M1 recovery, attempts and sessions', () => {
  it('resumes the same binding and session and includes source waiting in duration', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-07-12T12:00:00.000Z'))
    const test = harness(undefined, () => new Date())
    await test.supervisor.start()
    const sessionId = test.supervisor.getCurrentView().session?.sessionId
    test.listener()?.onFatal(new ApplicationError('CAPTURE_SOURCE_CLOSED', 'closed'))
    expect(test.supervisor.getCurrentView()).toMatchObject({
      state: 'WAITING_SOURCE',
      runIntent: true,
      session: { sessionId },
    })
    await vi.advanceTimersByTimeAsync(1_000)
    expect(test.process.start).toHaveBeenCalledTimes(2)
    expect(test.supervisor.getCurrentView()).toMatchObject({
      state: 'READY',
      session: { sessionId, durationMs: 1_000 },
    })
    await test.supervisor.stop()
    const summary = test.supervisor.getCurrentView().summary
    await vi.advanceTimersByTimeAsync(3_000)
    await test.supervisor.stop()
    expect(test.supervisor.getCurrentView().summary).toEqual(summary)
    expect(summary).toMatchObject({ sessionId, durationMs: 1_000, stopReason: 'user' })
  })

  it('backs off resolution and cancels all recovery when explicitly stopped', async () => {
    vi.useFakeTimers()
    const test = harness()
    test.targetResolver.resolve.mockRejectedValue(
      new ApplicationError('SOURCE_NOT_FOUND', 'missing'),
    )
    await test.supervisor.start()
    await vi.advanceTimersByTimeAsync(999)
    expect(test.targetResolver.resolve).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(test.targetResolver.resolve).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(2_000)
    expect(test.targetResolver.resolve).toHaveBeenCalledTimes(3)
    await test.supervisor.stop()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(test.targetResolver.resolve).toHaveBeenCalledTimes(3)
    expect(test.supervisor.getCurrentView()).toMatchObject({
      state: 'STOPPED',
      runIntent: false,
    })
  })

  it('does not resume a changed calibration or binding during recovery', async () => {
    vi.useFakeTimers()
    const test = harness()
    await test.supervisor.start()
    test.listener()?.onFatal(new ApplicationError('CAPTURE_SOURCE_CLOSED', 'closed'))
    test.captureConfigurations.getActive.mockResolvedValue({
      collectionRevision: 2,
      profile: {
        profileId: '00000000-0000-4000-8000-000000000001',
        configuration: { ...configuration, fingerprint: 'b'.repeat(64) },
      },
    })
    await vi.advanceTimersByTimeAsync(1_000)
    expect(test.process.start).toHaveBeenCalledTimes(1)
    expect(test.supervisor.getCurrentView()).toMatchObject({
      state: 'FAILED',
      runIntent: false,
      error: { code: 'CAPTURE_CALIBRATION_INVALID' },
    })
    await test.supervisor.stop()
  })

  it('waits closed on ambiguity and drops recovery on auth change', async () => {
    vi.useFakeTimers()
    const test = harness()
    test.targetResolver.resolve.mockRejectedValue(
      new ApplicationError('SOURCE_AMBIGUOUS', 'ambiguous'),
    )
    await test.supervisor.start()
    await vi.advanceTimersByTimeAsync(3_000)
    expect(test.process.start).not.toHaveBeenCalled()
    expect(test.supervisor.getCurrentView()).toMatchObject({
      state: 'WAITING_SOURCE',
      error: { code: 'SOURCE_AMBIGUOUS' },
    })
    await test.supervisor.stop('auth_change')
    test.user(null)
    test.supervisor.setUserContext(null)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(test.targetResolver.resolve).toHaveBeenCalledTimes(3)
    expect(test.supervisor.getCurrentView().session).toBeNull()
  })

  it('correlates progress and coalesces manual retry using the original RAM crop and deck mode', async () => {
    const test = harness()
    await test.supervisor.start()
    const triggerId = randomUUID()
    const image = Buffer.from('private-crop')
    const action = {
      triggerId,
      timestamp: '2026-07-12T12:00:00.000Z',
      width: 10,
      height: 10,
      image,
    }
    const firstResult = MonitorResultSchema.parse({
      id: randomUUID(),
      kind: 'service_error',
      timestamp: action.timestamp,
      searchMode: 'fast',
      deckMode: 'pol',
      searchedNickname: null,
      message: 'service unavailable',
      retryable: true,
      authBlocked: false,
    })
    test.ocr.process.mockResolvedValueOnce(firstResult)
    test.listener()?.onTriggered(action.timestamp, triggerId)
    const capturing = test.supervisor.getCurrentView().search
    test.listener()?.onAction(action)
    await Promise.resolve()
    const failed = test.supervisor.getCurrentView().search
    expect(failed).toMatchObject({
      phase: 'failed',
      triggerId,
      attemptId: capturing?.attemptId,
    })
    if (failed === null) throw new Error('Missing failed attempt')
    const retryResponse = deferred<ReturnType<typeof foundResult>>()
    test.ocr.process.mockReturnValueOnce(retryResponse.promise)
    await test.supervisor.updatePreferences({ deckMode: 'gt' })
    const retry = test.supervisor.retrySearch(failed.attemptId)
    expect(test.supervisor.retrySearch(failed.attemptId)).toBe(retry)
    expect(test.ocr.process).toHaveBeenLastCalledWith(
      expect.objectContaining({ image, deckMode: 'pol' }),
    )
    expect(test.supervisor.getCurrentView().search?.attemptId).not.toBe(failed.attemptId)
    retryResponse.resolve(foundResult(new Date(action.timestamp)))
    await retry
    const view = test.supervisor.getCurrentView()
    expect(view.stats.requests).toBe(2)
    expect(view.results).toHaveLength(1)
    expect(view.results[0]).toMatchObject({
      id: firstResult.id,
      triggerId,
      capturePolicy: 'immediate_nickname',
      sessionId: view.session?.sessionId,
      attemptId: view.search?.attemptId,
    })
    await test.supervisor.stop()
  })

  it('releases retry crops on expiry and rejects recognition errors without a second search', async () => {
    vi.useFakeTimers()
    const test = harness()
    await test.supervisor.start()
    test.ocr.process.mockResolvedValue({
      id: randomUUID(),
      kind: 'service_error',
      timestamp: '2026-07-12T12:00:00.000Z',
      searchMode: 'fast',
      deckMode: 'pol',
      searchedNickname: null,
      message: 'service unavailable',
      retryable: true,
      authBlocked: false,
    })
    test.listener()?.onAction({
      triggerId: randomUUID(),
      timestamp: '2026-07-12T12:00:00.000Z',
      width: 10,
      height: 10,
      image: Buffer.from('private'),
    })
    await Promise.resolve()
    const attemptId = test.supervisor.getCurrentView().search?.attemptId
    if (attemptId === undefined) throw new Error('Missing attempt')
    await vi.advanceTimersByTimeAsync(120_000)
    expect(test.supervisor.getCurrentView().search?.retryExpiresAt).toBeNull()
    await expect(test.supervisor.retrySearch(attemptId)).rejects.toMatchObject({
      code: 'SEARCH_RETRY_STALE',
    })
    test.ocr.process.mockResolvedValue({
      id: randomUUID(),
      kind: 'recognition_failed',
      timestamp: '2026-07-12T12:01:00.000Z',
      searchMode: 'fast',
      deckMode: 'pol',
      searchedNickname: null,
      message: 'unreadable',
    })
    test.listener()?.onAction({
      triggerId: randomUUID(),
      timestamp: '2026-07-12T12:01:00.000Z',
      width: 10,
      height: 10,
      image: Buffer.from('private'),
    })
    await Promise.resolve()
    expect(test.ocr.process).toHaveBeenCalledTimes(2)
    expect(test.supervisor.getCurrentView().search?.retryExpiresAt).toBeNull()
    await test.supervisor.stop()
  })

  it('counts session repeats beyond the UI cap without duplicating redelivered encounters', async () => {
    let time = new Date('2026-07-12T12:00:00.000Z')
    const test = harness(undefined, () => time)
    await test.supervisor.start()
    let latest = foundResult(time)
    for (let index = 0; index < 25; index++) {
      time = new Date(time.getTime() + 1_000)
      latest = foundResult(time, index % 2 === 0 ? 'tag' : '#TAG')
      test.supervisor.addExternalResult(latest)
    }
    if (latest.kind !== 'player_found') throw new Error('Expected found result')
    test.supervisor.addExternalResult({
      ...latest,
      player: { ...latest.player, name: 'Corrected' },
    })
    expect(await test.supervisor.getHistory(0, 50)).toHaveLength(25)
    expect(test.supervisor.getCurrentView()).toMatchObject({
      stats: { playersFound: 25 },
      session: { repeatEncounters: 24, distinctRepeatedOpponents: 1 },
    })
    expect(test.supervisor.getCurrentView().results).toHaveLength(20)
    await test.supervisor.stop()
  })

  it('marks earlier-today encounters across sessions but never yesterday after local midnight', async () => {
    let time = new Date(2026, 6, 12, 23, 58, 0)
    const test = harness(undefined, () => time)
    await test.supervisor.start()
    const first = foundResult(time)
    test.supervisor.addExternalResult(first)
    await test.supervisor.stop()
    time = new Date(2026, 6, 12, 23, 59, 0)
    await test.supervisor.start()
    test.supervisor.addExternalResult(foundResult(time))
    expect(test.supervisor.getLatestResult()?.repeat).toMatchObject({
      previousResultId: first.id,
    })
    expect(test.supervisor.getCurrentView().session?.repeatEncounters).toBe(0)
    time = new Date(2026, 6, 13, 0, 1, 0)
    test.supervisor.addExternalResult(foundResult(time))
    expect(test.supervisor.getLatestResult()?.repeat).toBeNull()
    expect(test.supervisor.getCurrentView().session?.repeatEncounters).toBe(1)
    await test.supervisor.stop()
  })

  it('reports journal failure without disabling capture', async () => {
    const repository = {
      load: vi.fn().mockRejectedValue(new Error('disk denied')),
      save: vi.fn().mockResolvedValue(undefined),
    }
    const test = harness(
      undefined,
      undefined,
      repository as unknown as MonitorJournalRepository,
    )
    await test.supervisor.start()
    expect(test.supervisor.getCurrentView()).toMatchObject({
      state: 'READY',
      historyError: { code: 'HISTORY_STORAGE_FAILED' },
    })
    await test.supervisor.stop()
  })
})

describe('monitor shutdown journal durability', () => {
  it('review regression #15: waits for the finalize-once journal snapshot before returning from Stop or Exit', async () => {
    const gate = Promise.withResolvers<undefined>()
    const repository = {
      load: vi.fn().mockResolvedValue({
        schemaVersion: 1,
        userId: '42',
        results: [],
        encounters: [],
        sessions: [],
      }),
      save: vi.fn(() => gate.promise),
    }
    const test = harness(
      undefined,
      undefined,
      repository as unknown as MonitorJournalRepository,
    )
    await test.supervisor.start()
    let returned = false
    const stopped = test.supervisor.stop('exit').then(() => {
      returned = true
    })
    await new Promise<void>((resolve) => setImmediate(resolve))
    expect(returned).toBe(false)
    expect(repository.save).toHaveBeenCalledOnce()
    expect(repository.save).toHaveBeenCalledWith(
      expect.objectContaining({
        sessions: [expect.objectContaining({ stopReason: 'exit' })],
      }),
    )
    gate.resolve(undefined)
    await stopped
    await test.supervisor.stop('exit')
    expect(repository.save).toHaveBeenCalledOnce()
  })
})

describe('monitor journal loading without auto-start', () => {
  it('loads persisted history when history is the first renderer request', async () => {
    const result = foundResult(new Date('2026-07-12T12:00:00.000Z'))
    const repository = {
      load: vi.fn().mockResolvedValue({
        schemaVersion: 1,
        userId: '42',
        results: [result],
        encounters: [],
        sessions: [],
      }),
      save: vi.fn().mockResolvedValue(undefined),
    }
    const test = harness(
      undefined,
      undefined,
      repository as unknown as MonitorJournalRepository,
    )
    expect(await test.supervisor.getHistory()).toEqual([result])
    expect(test.process.start).not.toHaveBeenCalled()
  })
})

describe('legacy reprocessed results without server correlation', () => {
  it('keeps standalone entries visible but excludes them from session counters and the repeat index', async () => {
    let time = new Date('2026-07-12T12:00:00.000Z')
    const test = harness(undefined, () => time)
    await test.supervisor.start()
    const original = foundResult(time)
    test.supervisor.addExternalResult(original)
    test.supervisor.addExternalResult({ ...foundResult(time), reprocessed: true })
    test.supervisor.addExternalResult({ ...foundResult(time), reprocessed: true })
    expect(await test.supervisor.getHistory()).toHaveLength(3)
    expect(test.supervisor.getLatestResult()).toMatchObject({
      reprocessed: true,
      repeat: null,
    })
    expect(test.supervisor.getCurrentView()).toMatchObject({
      stats: { playersFound: 1 },
      session: { repeatEncounters: 0, distinctRepeatedOpponents: 0 },
    })
    time = new Date(time.getTime() + 60_000)
    test.supervisor.addExternalResult(foundResult(time))
    expect(test.supervisor.getLatestResult()?.repeat).toMatchObject({
      previousResultId: original.id,
    })
    await test.supervisor.stop()
    expect(test.supervisor.getCurrentView().summary).toMatchObject({
      stats: { playersFound: 2 },
      repeatEncounters: 1,
      distinctRepeatedOpponents: 1,
    })
  })
})

describe('review regression monitor ownership and persistence', () => {
  it('#1 keeps a failed journal read memory-only and merges it after a successful retry', async () => {
    const persisted = foundResult(new Date('2026-07-12T11:00:00.000Z'))
    const memory = foundResult(new Date('2026-07-12T12:00:00.000Z'))
    const repository = {
      load: vi.fn().mockRejectedValue(new Error('EBUSY')),
      save: vi.fn<MonitorJournalRepository['save']>().mockResolvedValue(undefined),
    }
    const test = harness(
      undefined,
      undefined,
      repository as unknown as MonitorJournalRepository,
    )
    await test.supervisor.start()
    test.supervisor.addExternalResult(memory)
    await test.supervisor.stop()
    expect(repository.save).not.toHaveBeenCalled()
    repository.load.mockResolvedValue({
      schemaVersion: 1,
      userId: '42',
      results: [persisted],
      encounters: [],
      sessions: [],
    })
    expect(await test.supervisor.getHistory()).toEqual(
      expect.arrayContaining([persisted, expect.objectContaining({ id: memory.id })]),
    )
    expect(test.supervisor.getCurrentView().historyError).toBeNull()
    await test.supervisor.start()
    await test.supervisor.stop()
    expect(repository.save.mock.calls.at(-1)?.[0]?.results).toEqual(
      expect.arrayContaining([persisted, expect.objectContaining({ id: memory.id })]),
    )
  })

  it('#4 polling an auth transition finalizes with auth_change, not user', async () => {
    const repository = {
      load: vi.fn().mockResolvedValue({
        schemaVersion: 1,
        userId: '42',
        results: [],
        encounters: [],
        sessions: [],
      }),
      save: vi.fn().mockResolvedValue(undefined),
    }
    const test = harness(
      undefined,
      undefined,
      repository as unknown as MonitorJournalRepository,
    )
    await test.supervisor.start()
    test.user('43')
    await test.supervisor.getView()
    await new Promise<void>((resolve) => setImmediate(resolve))
    expect(repository.save).toHaveBeenLastCalledWith(
      expect.objectContaining({
        sessions: [expect.objectContaining({ stopReason: 'auth_change' })],
      }),
    )
  })

  it('#5 does not re-arm a superseded retry crop while newer work is pending', async () => {
    const test = harness()
    await test.supervisor.start()
    const old = deferred<ReturnType<typeof MonitorResultSchema.parse>>()
    const next = deferred<ReturnType<typeof foundResult>>()
    test.ocr.process.mockReturnValueOnce(old.promise).mockReturnValueOnce(next.promise)
    const action = {
      triggerId: randomUUID(),
      timestamp: '2026-07-12T12:00:00.000Z',
      width: 10,
      height: 10,
      image: Buffer.from('crop'),
    }
    test.listener()?.onTriggered(action.timestamp, action.triggerId)
    test.listener()?.onAction(action)
    const attemptId = test.supervisor.getCurrentView().search?.attemptId
    if (attemptId === undefined) throw new Error('Missing attempt')
    const newer = { ...action, triggerId: randomUUID() }
    test.listener()?.onTriggered(newer.timestamp, newer.triggerId)
    test.listener()?.onAction(newer)
    old.resolve(
      MonitorResultSchema.parse({
        id: randomUUID(),
        timestamp: action.timestamp,
        kind: 'service_error',
        searchMode: 'fast',
        deckMode: 'pol',
        searchedNickname: null,
        message: 'busy',
        retryable: true,
        authBlocked: false,
      }),
    )
    await new Promise<void>((resolve) => setImmediate(resolve))
    try {
      await expect(test.supervisor.retrySearch(attemptId)).rejects.toMatchObject({
        code: 'SEARCH_RETRY_STALE',
      })
    } finally {
      next.resolve(foundResult(new Date(action.timestamp)))
      await new Promise<void>((resolve) => setImmediate(resolve))
      await test.supervisor.stop()
    }
  })

  it('#16 publishes results and reports synchronous journal-save errors without throwing', async () => {
    const repository = {
      load: vi.fn().mockResolvedValue({
        schemaVersion: 1,
        userId: '42',
        results: [],
        encounters: [],
        sessions: [],
      }),
      save: vi.fn(() => {
        throw new Error('Invalid journal')
      }),
    }
    const test = harness(
      undefined,
      undefined,
      repository as unknown as MonitorJournalRepository,
    )
    await test.supervisor.start()
    expect(() =>
      test.supervisor.addExternalResult(
        foundResult(new Date('2026-07-12T12:00:00.000Z')),
      ),
    ).not.toThrow()
    await new Promise<void>((resolve) => setImmediate(resolve))
    expect(test.supervisor.getCurrentView()).toMatchObject({
      results: [expect.anything()],
      historyError: { code: 'HISTORY_STORAGE_FAILED' },
    })
    await test.supervisor.stop()
  })
})
