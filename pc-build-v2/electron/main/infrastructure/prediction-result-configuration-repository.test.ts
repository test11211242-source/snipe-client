import { createHash } from 'node:crypto'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import type { PredictionResultConfiguration } from '../../../shared/models/prediction-result'
import {
  PredictionResultConfigurationRepository,
  predictionResultFingerprint,
  type PredictionResultFileSystem,
} from './prediction-result-configuration-repository'
import { migratedCaptureProfileId } from './capture-configuration-repository'
import { v4CaptureFixture } from '../../../tests/capture-fixtures'

const FIRST_PROFILE = migratedCaptureProfileId('user-1')
const SECOND_PROFILE = '00000000-0000-4000-8000-000000000002'

function configuration(
  userId: string,
  revision = 1,
  profileId = FIRST_PROFILE,
): PredictionResultConfiguration {
  const unsigned: Omit<PredictionResultConfiguration, 'fingerprint'> = {
    schemaVersion: 2,
    userId,
    captureProfileId: profileId,
    captureConfigurationRevision: 3,
    captureConfigurationFingerprint: 'a'.repeat(64),
    revision,
    committedAt: '2026-07-17T10:00:00.000Z',
    source: {
      kind: 'window',
      label: 'Game',
      titleHint: 'Game',
      executableLabel: 'Game.exe',
      windowHwnd: '42',
    },
    frameSize: { width: 1920, height: 1080 },
    trigger: { x: 0.1, y: 0.1, width: 0.2, height: 0.2 },
    data: { x: 0.2, y: 0.2, width: 0.5, height: 0.5 },
    triggerProfile: {
      schemaVersion: 3,
      analyzer: { name: 'cr-tools-trigger-analyzer', version: '2.0.0' },
      innerRect: { x: 0, y: 0, width: 1, height: 1 },
      structureAlgorithm: 'max-channel-scharr-v1',
      structureHash64: '0123456789abcdef',
      matcherMode: 'edge',
      normalizedTemplateSize: { width: 128, height: 128 },
      structureTemplateBase64: 'AAAA',
      edgeTemplateBase64: 'AAAA',
      orientationTemplateBase64: 'AAAA',
      quality: {
        grade: 'medium',
        score: 0.65,
        edgePixelCount: 120,
        edgeCoverage: 0.5,
        keypointsCount: 0,
        cropConfidence: 0,
        cropAreaRatio: 1,
      },
    },
  }
  return { ...unsigned, fingerprint: predictionResultFingerprint(unsigned) }
}

function memoryFileSystem(initial = new Map<string, string>()) {
  const files = new Map(initial)
  const missing = () =>
    Promise.reject(Object.assign(new Error('missing'), { code: 'ENOENT' }))
  const fs: PredictionResultFileSystem = {
    readFile: (path) =>
      files.has(path) ? Promise.resolve(files.get(path) ?? '') : missing(),
    writeFile: (path, value) => {
      files.set(path, value)
      return Promise.resolve()
    },
    rename: (from, to) => {
      const value = files.get(from)
      if (value === undefined) return missing()
      files.set(to, value)
      files.delete(from)
      return Promise.resolve()
    },
    mkdir: () => Promise.resolve(),
    rm: (path) => {
      files.delete(path)
      return Promise.resolve()
    },
  }
  return { files, fs }
}

describe('PredictionResultConfigurationRepository profiles', () => {
  it('migrates the legacy singleton only into the first requested profile', async () => {
    const userId = 'user-1'
    const hash = createHash('sha256').update(userId).digest('hex')
    const legacy = configuration(userId)
    const { files, fs } = memoryFileSystem(
      new Map([[join('/results', `${hash}.json`), JSON.stringify(legacy)]]),
    )
    const repository = new PredictionResultConfigurationRepository('/results', fs)

    await expect(repository.load(userId, SECOND_PROFILE)).resolves.toBeNull()
    await expect(repository.load(userId, FIRST_PROFILE)).resolves.toEqual(legacy)
    expect(files.get(join('/results', `${hash}.json`))).toBe(JSON.stringify(legacy))
    expect(files.has(join('/results', `${hash}.${FIRST_PROFILE}.json`))).toBe(true)
  })

  it('keeps result calibration separate for each capture profile', async () => {
    const { fs } = memoryFileSystem()
    const repository = new PredictionResultConfigurationRepository('/results', fs)
    const first = configuration('user-1', 1)
    const second = configuration('user-1', 2, SECOND_PROFILE)

    await repository.save(first, FIRST_PROFILE)
    await repository.save(second, SECOND_PROFILE)

    await expect(repository.load('user-1', FIRST_PROFILE)).resolves.toEqual(first)
    await expect(repository.load('user-1', SECOND_PROFILE)).resolves.toEqual(second)
  })

  it('does not let a configured secondary profile suppress legacy migration', async () => {
    const userId = 'user-1'
    const hash = createHash('sha256').update(userId).digest('hex')
    const legacy = configuration(userId, 1)
    const secondary = configuration(userId, 2, SECOND_PROFILE)
    const { fs } = memoryFileSystem(
      new Map([[join('/results', `${hash}.json`), JSON.stringify(legacy)]]),
    )
    const repository = new PredictionResultConfigurationRepository('/results', fs)

    await repository.save(secondary, SECOND_PROFILE)
    await expect(repository.load(userId, SECOND_PROFILE)).resolves.toEqual(secondary)
    await expect(repository.load(userId, FIRST_PROFILE)).resolves.toEqual(legacy)
  })

  it('treats unbound schema v1 result calibration as inactive', async () => {
    const userId = 'user-1'
    const hash = createHash('sha256').update(userId).digest('hex')
    const legacy = { ...configuration(userId), schemaVersion: 1 }
    const { fs } = memoryFileSystem(
      new Map([[join('/results', `${hash}.json`), JSON.stringify(legacy)]]),
    )
    const repository = new PredictionResultConfigurationRepository('/results', fs)

    await expect(repository.load(userId, FIRST_PROFILE)).resolves.toBeNull()
  })
})

describe('prediction result references during capture migration to v5', () => {
  it('maps only the exact validated old profile reference and preserves result calibration', async () => {
    const previous = configuration('user-1')
    const hash = createHash('sha256').update('user-1').digest('hex')
    const path = join('/old', `${hash}.${FIRST_PROFILE}.json`)
    const { fs, files } = memoryFileSystem(new Map([[path, JSON.stringify(previous)]]))
    const capture = v4CaptureFixture({
      schemaVersion: 1,
      userId: 'user-1',
      revision: 3,
      committedAt: previous.committedAt,
      source: previous.source,
      frameSize: previous.frameSize,
      regions: {
        trigger: previous.trigger,
        normal: previous.data,
        precise: previous.data,
      },
      triggerProfile: previous.triggerProfile,
      fingerprint: 'a'.repeat(64),
    })
    const repository = new PredictionResultConfigurationRepository('/new', fs, '/old')
    await repository.migrateCaptureReference(
      'user-1',
      FIRST_PROFILE,
      3,
      'b'.repeat(64),
      capture,
    )
    await expect(repository.load('user-1', FIRST_PROFILE)).resolves.toBeNull()
    await repository.migrateCaptureReference(
      'user-1',
      SECOND_PROFILE,
      3,
      'a'.repeat(64),
      capture,
    )
    await expect(repository.load('user-1', SECOND_PROFILE)).resolves.toBeNull()
    await repository.migrateCaptureReference(
      'user-1',
      FIRST_PROFILE,
      3,
      'a'.repeat(64),
      capture,
    )
    const migrated = await repository.load('user-1', FIRST_PROFILE)
    expect(migrated).toMatchObject({
      captureProfileId: FIRST_PROFILE,
      captureConfigurationFingerprint: capture.fingerprint,
      trigger: previous.trigger,
      data: previous.data,
      triggerProfile: previous.triggerProfile,
      source: previous.source,
      frameSize: previous.frameSize,
    })
    expect(files.get(path)).toBe(JSON.stringify(previous))
    await repository.migrateCaptureReference(
      'user-1',
      FIRST_PROFILE,
      3,
      'a'.repeat(64),
      capture,
    )
    await expect(repository.load('user-1', FIRST_PROFILE)).resolves.toEqual(migrated)
  })
})

describe('review regression optional legacy result geometry', () => {
  it.each([
    '{invalid',
    JSON.stringify({ ...configuration('user-1'), fingerprint: 'f'.repeat(64) }),
  ])(
    '#12 leaves invalid legacy geometry unattached without aborting capture migration: %s',
    async (bytes) => {
      const previous = configuration('user-1')
      const hash = createHash('sha256').update('user-1').digest('hex')
      const path = join('/old', `${hash}.${FIRST_PROFILE}.json`)
      const { fs, files } = memoryFileSystem(new Map([[path, bytes]]))
      const capture = v4CaptureFixture({
        schemaVersion: 1,
        userId: 'user-1',
        revision: 3,
        committedAt: previous.committedAt,
        source: previous.source,
        frameSize: previous.frameSize,
        regions: {
          trigger: previous.trigger,
          normal: previous.data,
          precise: previous.data,
        },
        triggerProfile: previous.triggerProfile,
        fingerprint: 'a'.repeat(64),
      })
      const repository = new PredictionResultConfigurationRepository('/new', fs, '/old')
      await expect(
        repository.migrateCaptureReference(
          'user-1',
          FIRST_PROFILE,
          3,
          'a'.repeat(64),
          capture,
        ),
      ).resolves.toBeUndefined()
      expect(files.get(path)).toBe(bytes)
      expect([...files.keys()]).toEqual([path])
    },
  )
})

function migratedCapture(previous: PredictionResultConfiguration) {
  return v4CaptureFixture({
    schemaVersion: 1,
    userId: previous.userId,
    revision: previous.captureConfigurationRevision,
    committedAt: previous.committedAt,
    source: previous.source,
    frameSize: previous.frameSize,
    regions: { trigger: previous.trigger, normal: previous.data, precise: previous.data },
    triggerProfile: previous.triggerProfile,
    fingerprint: previous.captureConfigurationFingerprint,
  })
}

describe('result rollback roots and resumable v5 migration', () => {
  it.each(['v4-profile', 'v3-profile', 'v3-singleton'] as const)(
    're-keys %s directly into v5 without changing any old file',
    async (source) => {
      const previous = configuration('user-1')
      const hash = createHash('sha256').update(previous.userId).digest('hex')
      const directory = source.startsWith('v4') ? '/v4' : '/v3'
      const name = source.endsWith('singleton')
        ? `${hash}.json`
        : `${hash}.${FIRST_PROFILE}.json`
      const input = join(directory, name)
      const bytes = JSON.stringify(previous)
      const { fs, files } = memoryFileSystem(new Map([[input, bytes]]))
      const results = new PredictionResultConfigurationRepository('/v5', fs, [
        '/v4',
        '/v3',
      ])
      const capture = migratedCapture(previous)
      await results.migrateCaptureReference(
        previous.userId,
        FIRST_PROFILE,
        previous.captureConfigurationRevision,
        previous.captureConfigurationFingerprint,
        capture,
      )
      const migrated = await results.load(previous.userId, FIRST_PROFILE)
      expect(migrated).toMatchObject({
        captureProfileId: FIRST_PROFILE,
        captureConfigurationRevision: capture.revision,
        captureConfigurationFingerprint: capture.fingerprint,
        trigger: previous.trigger,
        data: previous.data,
        triggerProfile: previous.triggerProfile,
        revision: previous.revision,
        committedAt: previous.committedAt,
      })
      expect(files.get(input)).toBe(bytes)
      const output = files.get(join('/v5', `${hash}.${FIRST_PROFILE}.json`))
      await results.migrateCaptureReference(
        previous.userId,
        FIRST_PROFILE,
        previous.captureConfigurationRevision,
        previous.captureConfigurationFingerprint,
        capture,
      )
      expect(files.get(join('/v5', `${hash}.${FIRST_PROFILE}.json`))).toBe(output)
    },
  )

  it('uses the exact reference from an older root when the newest root has an unrelated reference', async () => {
    const previous = configuration('user-1')
    const unrelatedUnsigned = {
      ...previous,
      captureConfigurationFingerprint: 'b'.repeat(64),
    }
    const { fingerprint: _fingerprint, ...unsigned } = unrelatedUnsigned
    void _fingerprint
    const unrelated = { ...unsigned, fingerprint: predictionResultFingerprint(unsigned) }
    const hash = createHash('sha256').update(previous.userId).digest('hex')
    const name = `${hash}.${FIRST_PROFILE}.json`
    const newestBytes = JSON.stringify(unrelated)
    const oldestBytes = JSON.stringify(previous)
    const { fs, files } = memoryFileSystem(
      new Map([
        [join('/v4', name), newestBytes],
        [join('/v3', name), oldestBytes],
      ]),
    )
    const results = new PredictionResultConfigurationRepository('/v5', fs, ['/v4', '/v3'])
    const capture = migratedCapture(previous)
    await results.migrateCaptureReference(
      previous.userId,
      FIRST_PROFILE,
      previous.captureConfigurationRevision,
      previous.captureConfigurationFingerprint,
      capture,
    )
    expect(await results.load(previous.userId, FIRST_PROFILE)).toMatchObject({
      captureConfigurationFingerprint: capture.fingerprint,
      data: previous.data,
    })
    expect(files.get(join('/v4', name))).toBe(newestBytes)
    expect(files.get(join('/v3', name))).toBe(oldestBytes)
  })

  it('propagates old-root I/O failures so capture migration can retry instead of losing binding', async () => {
    const previous = configuration('user-1')
    const hash = createHash('sha256').update(previous.userId).digest('hex')
    const input = join('/v4', `${hash}.${FIRST_PROFILE}.json`)
    const bytes = JSON.stringify(previous)
    const { fs, files } = memoryFileSystem(new Map([[input, bytes]]))
    const originalRead = fs.readFile
    let interrupted = false
    fs.readFile = async (path, encoding) => {
      if (path === input && !interrupted) {
        interrupted = true
        throw Object.assign(new Error('synthetic I/O failure'), { code: 'EIO' })
      }
      return originalRead(path, encoding)
    }
    const results = new PredictionResultConfigurationRepository('/v5', fs, '/v4')
    const capture = migratedCapture(previous)
    await expect(
      results.migrateCaptureReference(
        previous.userId,
        FIRST_PROFILE,
        previous.captureConfigurationRevision,
        previous.captureConfigurationFingerprint,
        capture,
      ),
    ).rejects.toThrow('synthetic I/O failure')
    expect([...files.keys()]).toEqual([input])
    await results.migrateCaptureReference(
      previous.userId,
      FIRST_PROFILE,
      previous.captureConfigurationRevision,
      previous.captureConfigurationFingerprint,
      capture,
    )
    expect(await results.load(previous.userId, FIRST_PROFILE)).toMatchObject({
      captureConfigurationFingerprint: capture.fingerprint,
    })
    expect(files.get(input)).toBe(bytes)
  })
})
