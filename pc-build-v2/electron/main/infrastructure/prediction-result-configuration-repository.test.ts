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

const FIRST_PROFILE = migratedCaptureProfileId('user-1')
const SECOND_PROFILE = '00000000-0000-4000-8000-000000000002'

function configuration(userId: string, revision = 1): PredictionResultConfiguration {
  const unsigned: Omit<PredictionResultConfiguration, 'fingerprint'> = {
    schemaVersion: 1,
    userId,
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
      schemaVersion: 2,
      analyzer: { name: 'cr-tools-trigger-analyzer', version: '1.0.0' },
      hashAlgorithm: 'ahash64-bitwise-v1',
      ahash64: '0123456789abcdef',
      innerRect: { x: 0, y: 0, width: 1, height: 1 },
      featureMode: 'ncc',
      keypointsCount: 0,
      normalizedTemplateSize: { width: 128, height: 128 },
      templateGrayBase64: 'AAAA',
      hashMaxDistance: 18,
      orbDistanceThreshold: 55,
      orbMinGoodMatches: 10,
      nccMinScore: 0.72,
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
    const second = configuration('user-1', 2)

    await repository.save(first, FIRST_PROFILE)
    await repository.save(second, SECOND_PROFILE)

    await expect(repository.load('user-1', FIRST_PROFILE)).resolves.toEqual(first)
    await expect(repository.load('user-1', SECOND_PROFILE)).resolves.toEqual(second)
  })

  it('does not let a configured secondary profile suppress legacy migration', async () => {
    const userId = 'user-1'
    const hash = createHash('sha256').update(userId).digest('hex')
    const legacy = configuration(userId, 1)
    const secondary = configuration(userId, 2)
    const { fs } = memoryFileSystem(
      new Map([[join('/results', `${hash}.json`), JSON.stringify(legacy)]]),
    )
    const repository = new PredictionResultConfigurationRepository('/results', fs)

    await repository.save(secondary, SECOND_PROFILE)
    await expect(repository.load(userId, SECOND_PROFILE)).resolves.toEqual(secondary)
    await expect(repository.load(userId, FIRST_PROFILE)).resolves.toEqual(legacy)
  })
})
