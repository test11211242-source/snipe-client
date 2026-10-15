import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

import { describe, expect, it, vi } from 'vitest'

import {
  CaptureProfileCollectionSchema,
  MAX_CAPTURE_PROFILES,
  type CaptureConfiguration,
  type CaptureProfileCollection,
} from '../../../shared/models/capture'
import { ApplicationError } from '../../../shared/errors/application-error'
import { GAME_ASPECT_MIN, GAME_ASPECT_MAX } from '../../../shared/contracts/game-aspect'
import { MonitorPrimarySchema } from '../../../shared/contracts/monitor-protocol'
import {
  PredictionResultConfigurationRepository,
  predictionResultFingerprint,
} from './prediction-result-configuration-repository'
import {
  PredictionResultConfigurationSchema,
  predictionResultMatchesCapture,
  type PredictionResultConfiguration,
} from '../../../shared/models/prediction-result'
import {
  CannotDeleteLastCaptureProfileError,
  CaptureConfigurationRepository,
  CaptureProfileLimitError,
  CaptureProfileNameConflictError,
  CaptureProfileRevisionConflictError,
  CaptureProfileStoreCorruptError,
  captureConfigurationFingerprint,
  captureProfileCollectionFingerprint,
  type CaptureConfigurationFileSystem,
} from './capture-configuration-repository'
import { v4CaptureFixture } from '../../../tests/capture-fixtures'
import {
  LegacyCaptureConfigurationSchema,
  type LegacyCaptureConfiguration,
  V4CaptureCollectionSchema,
  V4CaptureConfigurationSchema,
  type V4CaptureCollection,
  type V4CaptureProfile,
} from './capture-profile-migration'

function required<T>(value: T | null | undefined): T {
  if (value === undefined || value === null) throw new Error('Missing test value')
  return value
}

function legacyConfiguration(
  userId: string,
  revision = 1,
  sourceLabel = 'Game',
): LegacyCaptureConfiguration {
  const unsigned: Omit<LegacyCaptureConfiguration, 'fingerprint'> = {
    schemaVersion: 1,
    userId,
    revision,
    committedAt: `2026-07-${String(Math.min(revision, 28)).padStart(2, '0')}T12:00:00.000Z`,
    source: {
      kind: 'window',
      label: sourceLabel,
      titleHint: sourceLabel,
      executableLabel: null,
    },
    frameSize: { width: 1920, height: 1080 },
    regions: {
      trigger: { x: 0.1, y: 0.1, width: 0.2, height: 0.2 },
      normal: { x: 0.1, y: 0.2, width: 0.8, height: 0.5 },
      precise: { x: 0.05, y: 0.1, width: 0.9, height: 0.8 },
    },
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
  return LegacyCaptureConfigurationSchema.parse({
    ...unsigned,
    fingerprint: createHash('sha256').update(JSON.stringify(unsigned)).digest('hex'),
  })
}

function configuration(
  userId: string,
  revision = 1,
  sourceLabel = 'Game',
): CaptureConfiguration {
  return v4CaptureFixture(legacyConfiguration(userId, revision, sourceLabel))
}

function userHash(userId: string): string {
  return createHash('sha256').update(userId).digest('hex')
}

function legacyPath(directory: string, userId: string): string {
  return join(directory, `${userHash(userId)}.json`)
}

function profilePath(directory: string, userId: string): string {
  return join(directory, `${userHash(userId)}.profiles.v4.json`)
}

function legacyProfilePath(directory: string, userId: string): string {
  return join(directory, `${userHash(userId)}.profiles.v2.json`)
}

function memoryFileSystem(initial: ReadonlyMap<string, string> = new Map()): {
  fs: CaptureConfigurationFileSystem
  files: Map<string, string>
} {
  const files = new Map(initial)
  return {
    files,
    fs: {
      readFile: (path) => {
        const content = files.get(path)
        return content === undefined
          ? Promise.reject(Object.assign(new Error('missing'), { code: 'ENOENT' }))
          : Promise.resolve(content)
      },
      writeFile: (path, data) => {
        files.set(path, data)
        return Promise.resolve()
      },
      rename: (oldPath, newPath) => {
        files.set(newPath, required(files.get(oldPath)))
        files.delete(oldPath)
        return Promise.resolve()
      },
      mkdir: () => Promise.resolve(),
      rm: (path) => {
        files.delete(path)
        return Promise.resolve()
      },
    },
  }
}

function profileIdSequence(): () => string {
  let sequence = 0
  return () => {
    sequence += 1
    return `00000000-0000-4000-8000-${String(sequence).padStart(12, '0')}`
  }
}

function readCollection(
  files: ReadonlyMap<string, string>,
  directory: string,
  userId: string,
): CaptureProfileCollection {
  return CaptureProfileCollectionSchema.parse(
    JSON.parse(required(files.get(profilePath(directory, userId)))) as unknown,
  )
}

function repository(
  directory: string,
  fs: CaptureConfigurationFileSystem,
  legacyDirectory?: string,
): CaptureConfigurationRepository {
  return new CaptureConfigurationRepository(directory, fs, {
    ...(legacyDirectory === undefined ? {} : { legacyDirectory }),
    now: () => new Date('2026-07-17T10:00:00.000Z'),
    createProfileId: profileIdSequence(),
  })
}

describe('capture profile data model', () => {
  it('rejects duplicate case-insensitive names, duplicate IDs, and an invalid active pointer', () => {
    const id = '00000000-0000-4000-8000-000000000001'
    const profile = {
      profileId: id,
      profileName: 'Main',
      createdAt: '2026-07-17T10:00:00.000Z',
      updatedAt: '2026-07-17T10:00:00.000Z',
      configuration: configuration('user'),
    }
    const base = {
      schemaVersion: 4 as const,
      userId: 'user',
      revision: 1,
      fingerprint: '0'.repeat(64),
      activeProfileId: id,
      profiles: [profile],
    }
    expect(CaptureProfileCollectionSchema.safeParse(base).success).toBe(true)
    expect(
      CaptureProfileCollectionSchema.safeParse({
        ...base,
        profiles: [profile, { ...profile, profileName: ' main ' }],
      }).success,
    ).toBe(false)
    expect(
      CaptureProfileCollectionSchema.safeParse({
        ...base,
        activeProfileId: '00000000-0000-4000-8000-000000000002',
      }).success,
    ).toBe(false)
  })
})

describe('CaptureConfigurationRepository migration', () => {
  it('migrates the current directory deterministically and retains the legacy input', async () => {
    const userId = 'legacy-user'
    const legacy = `${JSON.stringify(legacyConfiguration(userId), null, 2)}\n`
    const { fs, files } = memoryFileSystem(
      new Map([[legacyPath('/config', userId), legacy]]),
    )
    const first = repository('/config', fs)

    const status = await first.list(userId)
    expect(status).toMatchObject({
      userId,
      revision: 1,
      profileCount: 1,
      profiles: [
        {
          profileName: 'Основной',
          isActive: true,
          createdAt: '2026-07-01T12:00:00.000Z',
          updatedAt: '2026-07-01T12:00:00.000Z',
          configurationRevision: 1,
          sourceLabel: 'Game',
        },
      ],
    })
    expect(files.get(legacyPath('/config', userId))).toBe(legacy)
    expect(files.has(profilePath('/config', userId))).toBe(true)
    await expect(first.load(userId)).resolves.toMatchObject({
      sourceBinding: { identity: legacyConfiguration(userId).source },
      calibration: {
        nicknameRegion: legacyConfiguration(userId).regions.normal,
        topLeftEvidenceRegion: legacyConfiguration(userId).regions.precise,
        validationStatus: 'needs_validation',
      },
    })

    const firstProfileId = required(status).activeProfileId
    files.delete(profilePath('/config', userId))
    const second = repository('/config', fs)
    await expect(second.list(userId)).resolves.toMatchObject({
      activeProfileId: firstProfileId,
    })
  })

  it('can migrate from an optional separate legacy directory', async () => {
    const userId = 'separate-legacy-user'
    const legacy = JSON.stringify(legacyConfiguration(userId))
    const { fs, files } = memoryFileSystem(
      new Map([[legacyPath('/legacy', userId), legacy]]),
    )
    const target = repository('/profiles', fs, '/legacy')

    await expect(target.load(userId)).resolves.toMatchObject({
      sourceBinding: { identity: legacyConfiguration(userId).source },
      calibration: { validationStatus: 'needs_validation' },
    })
    expect(files.get(legacyPath('/legacy', userId))).toBe(legacy)
    expect(files.has(profilePath('/profiles', userId))).toBe(true)
  })
})

describe('CaptureConfigurationRepository profiles', () => {
  it('supports rename, duplicate, activate, rebind, update, and deterministic active deletion', async () => {
    const { fs } = memoryFileSystem()
    const target = repository('/profiles', fs)
    await target.save(configuration('user'))
    const initial = required(await target.list('user'))
    const primaryId = initial.activeProfileId

    const renamed = await target.rename('user', primaryId, ' Main ', initial.revision)
    expect(renamed).toMatchObject({ revision: 2, profiles: [{ profileName: 'Main' }] })
    await expect(target.duplicate('user', primaryId, 'main')).rejects.toBeInstanceOf(
      CaptureProfileNameConflictError,
    )

    const duplicated = await target.duplicate('user', primaryId, 'Secondary', 2)
    const secondaryId = required(
      duplicated.profiles.find((profile) => profile.profileName === 'Secondary'),
    ).profileId
    expect(duplicated).toMatchObject({ revision: 3, profileCount: 2 })

    const activated = await target.activate('user', secondaryId, 3)
    expect(activated).toMatchObject({ revision: 4, activeProfileId: secondaryId })
    await expect(target.load('user')).resolves.toMatchObject({
      sourceBinding: { identity: { label: 'Game' } },
    })

    const rebound = await target.rebind(
      'user',
      secondaryId,
      { kind: 'display', label: 'Desk', displayId: 'display-2' },
      4,
    )
    expect(rebound).toMatchObject({
      revision: 5,
      profiles: [
        { profileName: 'Main', sourceLabel: 'Game' },
        {
          profileName: 'Secondary',
          configurationRevision: 2,
          sourceKind: 'display',
          sourceLabel: 'Desk',
        },
      ],
    })
    const reboundProfile = required(await target.get('user', secondaryId))
    const { fingerprint: reboundFingerprint, ...reboundUnsigned } =
      reboundProfile.configuration
    expect(captureConfigurationFingerprint(reboundUnsigned)).toBe(reboundFingerprint)

    const updated = await target.update(
      'user',
      primaryId,
      configuration('user', 7, 'Updated Game'),
      5,
    )
    expect(updated).toMatchObject({ revision: 6, activeProfileId: secondaryId })
    expect(
      updated.profiles.find((profile) => profile.profileId === primaryId),
    ).toMatchObject({
      profileName: 'Main',
      sourceLabel: 'Updated Game',
    })

    const afterDelete = await target.delete('user', secondaryId, 6)
    expect(afterDelete).toMatchObject({
      revision: 7,
      activeProfileId: primaryId,
      profileCount: 1,
    })
    await expect(target.load('user')).resolves.toMatchObject({
      revision: 7,
      sourceBinding: { identity: { label: 'Updated Game' } },
    })
    await expect(target.delete('user', primaryId)).rejects.toBeInstanceOf(
      CannotDeleteLastCaptureProfileError,
    )
  })

  it('keeps save(config) setup-compatible and can explicitly upsert and activate a profile', async () => {
    const { fs } = memoryFileSystem()
    const target = repository('/profiles', fs)
    await target.save(configuration('user', 1, 'First'))
    const primaryId = required(await target.list('user')).activeProfileId
    const secondaryId = '00000000-0000-4000-8000-000000000099'

    await target.save(configuration('user', 1, 'Second'), {
      profileId: secondaryId,
      profileName: 'Second profile',
      expectedRevision: 1,
    })
    expect(await target.list('user')).toMatchObject({
      revision: 2,
      activeProfileId: secondaryId,
      profileCount: 2,
    })

    await target.save(configuration('user', 2, 'Second updated'))
    expect(await target.list('user')).toMatchObject({
      revision: 3,
      activeProfileId: secondaryId,
      profiles: [
        { profileId: primaryId, sourceLabel: 'First' },
        {
          profileId: secondaryId,
          profileName: 'Second profile',
          sourceLabel: 'Second updated',
        },
      ],
    })
  })

  it('updates an inactive profile without changing the active profile', async () => {
    const { fs } = memoryFileSystem()
    const target = repository('/profiles', fs)
    await target.save(configuration('user', 1, 'First'))
    const primaryId = required(await target.list('user')).activeProfileId
    const secondaryId = '00000000-0000-4000-8000-000000000099'
    await target.save(configuration('user', 1, 'Second'), {
      profileId: secondaryId,
      profileName: 'Second profile',
      expectedRevision: 1,
    })

    await target.save(configuration('user', 2, 'First updated'), {
      profileId: primaryId,
      profileName: 'First profile',
      expectedRevision: 2,
      activate: false,
    })

    expect(await target.list('user')).toMatchObject({
      revision: 3,
      activeProfileId: secondaryId,
      profiles: [
        { profileId: primaryId, sourceLabel: 'First updated', isActive: false },
        { profileId: secondaryId, sourceLabel: 'Second', isActive: true },
      ],
    })
  })

  it('enforces optimistic collection revisions and changes collection fingerprints', async () => {
    const { fs, files } = memoryFileSystem()
    const target = repository('/profiles', fs)
    await target.save(configuration('user'))
    const before = required(await target.list('user'))

    const conflict = await target
      .rename('user', before.activeProfileId, 'Renamed', 0)
      .catch((error: unknown) => error)
    expect(conflict).toBeInstanceOf(CaptureProfileRevisionConflictError)
    expect(conflict).toMatchObject({ expectedRevision: 0, actualRevision: 1 })
    expect(await target.list('user')).toEqual(before)

    const after = await target.rename('user', before.activeProfileId, 'Renamed', 1)
    expect(after.revision).toBe(2)
    expect(after.fingerprint).not.toBe(before.fingerprint)
    const persisted = readCollection(files, '/profiles', 'user')
    const { fingerprint, ...unsigned } = persisted
    expect(captureProfileCollectionFingerprint(unsigned)).toBe(fingerprint)
  })

  it('enforces the maximum profile count', async () => {
    const { fs } = memoryFileSystem()
    const target = repository('/profiles', fs)
    await target.save(configuration('user'))
    const sourceId = required(await target.list('user')).activeProfileId
    for (let index = 2; index <= MAX_CAPTURE_PROFILES; index += 1) {
      await target.duplicate('user', sourceId, `Profile ${index}`)
    }
    expect(required(await target.list('user')).profileCount).toBe(MAX_CAPTURE_PROFILES)
    await expect(
      target.duplicate('user', sourceId, 'One too many'),
    ).rejects.toBeInstanceOf(CaptureProfileLimitError)
  })

  it('serializes concurrent mutations and separates opaque per-user files', async () => {
    const { fs, files } = memoryFileSystem()
    const target = repository('/profiles', fs)
    await Promise.all([
      target.save(configuration('user-a')),
      target.save(configuration('user-b')),
    ])
    const sourceId = required(await target.list('user-a')).activeProfileId
    await Promise.all([
      target.duplicate('user-a', sourceId, 'Copy A'),
      target.duplicate('user-a', sourceId, 'Copy B'),
    ])

    expect(await target.list('user-a')).toMatchObject({ revision: 3, profileCount: 3 })
    expect(await target.list('user-b')).toMatchObject({ revision: 1, profileCount: 1 })
    expect(
      [...files.keys()].filter((path) => path.endsWith('.profiles.v4.json')),
    ).toHaveLength(2)
    expect([...files.keys()].join()).not.toContain('user-a')
  })
})

describe('CaptureConfigurationRepository corruption and atomic writes', () => {
  it('does not overwrite a corrupt profile store or fall back to valid legacy data', async () => {
    const userId = 'user'
    const { fs, files } = memoryFileSystem()
    const target = repository('/profiles', fs)
    await target.save(configuration(userId))
    const path = profilePath('/profiles', userId)
    const corrupt = required(files.get(path)).replace('Game', 'Tampered')
    files.set(path, corrupt)
    const legacy = JSON.stringify(legacyConfiguration(userId, 9, 'Legacy'))
    files.set(legacyPath('/profiles', userId), legacy)

    await expect(target.load(userId)).rejects.toBeInstanceOf(
      CaptureProfileStoreCorruptError,
    )
    await expect(target.save(configuration(userId, 2))).rejects.toBeInstanceOf(
      CaptureProfileStoreCorruptError,
    )
    expect(files.get(path)).toBe(corrupt)
    expect(files.get(legacyPath('/profiles', userId))).toBe(legacy)
  })

  it('retains corrupt legacy input and does not create a profile store', async () => {
    const userId = 'user'
    const legacy = '{not-json'
    const { fs, files } = memoryFileSystem(
      new Map([[legacyPath('/config', userId), legacy]]),
    )
    const target = repository('/config', fs)

    await expect(target.list(userId)).rejects.toBeInstanceOf(
      CaptureProfileStoreCorruptError,
    )
    expect(files.get(legacyPath('/config', userId))).toBe(legacy)
    expect(files.has(profilePath('/config', userId))).toBe(false)
  })

  it('removes a temporary file when atomic rename fails', async () => {
    const rm = vi.fn().mockResolvedValue(undefined)
    const fs: CaptureConfigurationFileSystem = {
      readFile: vi
        .fn()
        .mockRejectedValue(Object.assign(new Error('missing'), { code: 'ENOENT' })),
      writeFile: vi.fn().mockResolvedValue(undefined),
      rename: vi.fn().mockRejectedValue(new Error('disk full')),
      mkdir: vi.fn().mockResolvedValue(undefined),
      rm,
    }
    const target = repository('/config', fs)

    await expect(target.save(configuration('42'))).rejects.toThrow('disk full')
    expect(rm).toHaveBeenCalledWith(expect.stringContaining('.tmp'), { force: true })
  })
})

function legacyCollection(userId: string, count: number) {
  const ids = profileIdSequence()
  const profiles = Array.from({ length: count }, (_, index) => ({
    profileId: ids(),
    profileName: `Emulator ${index + 1}`,
    createdAt: '2026-07-01T12:00:00.000Z',
    updatedAt: '2026-07-01T12:00:00.000Z',
    configuration: legacyConfiguration(userId, 1, `Emulator ${index + 1}`),
  }))
  const unsigned = {
    schemaVersion: 2,
    userId,
    revision: 7,
    activeProfileId: profiles.at(-1)?.profileId ?? '00000000-0000-4000-8000-000000000001',
    profiles,
  }
  return {
    ...unsigned,
    fingerprint: createHash('sha256').update(JSON.stringify(unsigned)).digest('hex'),
  }
}

describe('capture-profiles.v3 imports to v5', () => {
  it.each([1, 20])(
    'losslessly imports %i profiles with stable identities and honest provenance',
    async (count) => {
      const old = legacyCollection('user', count)
      const input = JSON.stringify(old)
      const { fs, files } = memoryFileSystem(
        new Map([[legacyProfilePath('/v3', 'user'), input]]),
      )
      const target = repository('/v5', fs, '/v3')
      const summary = required(await target.list('user'))
      expect(summary).toMatchObject({
        revision: 7,
        activeProfileId: old.activeProfileId,
        profileCount: count,
      })
      for (const previous of old.profiles) {
        const migrated = required(await target.get('user', previous.profileId))
        expect(migrated).toMatchObject({
          profileId: previous.profileId,
          profileName: previous.profileName,
          createdAt: previous.createdAt,
          updatedAt: previous.updatedAt,
          configuration: {
            sourceBinding: {
              identity: previous.configuration.source,
              lastVerifiedAt: null,
            },
            calibration: {
              referenceFrameSize: previous.configuration.frameSize,
              nicknameRegion: previous.configuration.regions.normal,
              topLeftEvidenceRegion: previous.configuration.regions.precise,
              triggerRegion: previous.configuration.regions.trigger,
              triggerProfile: previous.configuration.triggerProfile,
              expectedLayout: null,
              gameViewport: null,
              validationStatus: 'needs_validation',
              provenance: { nickname: { origin: 'imported', confidence: null } },
            },
          },
        })
      }
      expect(files.get(legacyProfilePath('/v3', 'user'))).toBe(input)
      const migratedBytes = files.get(profilePath('/v5', 'user'))
      await repository('/v5', fs, '/v3').list('user')
      expect(files.get(profilePath('/v5', 'user'))).toBe(migratedBytes)
    },
  )

  it('validates every old profile before writing any v5 replacement', async () => {
    const old = legacyCollection('user', 20)
    required(old.profiles[19]).configuration.fingerprint = 'f'.repeat(64)
    const { fs, files } = memoryFileSystem(
      new Map([[legacyProfilePath('/v3', 'user'), JSON.stringify(old)]]),
    )
    await expect(repository('/v5', fs, '/v3').list('user')).rejects.toBeInstanceOf(
      CaptureProfileStoreCorruptError,
    )
    expect(files.has(profilePath('/v5', 'user'))).toBe(false)
  })

  it('resumes interrupted prediction association migration before committing the collection', async () => {
    const old = legacyCollection('user', 2)
    const input = JSON.stringify(old)
    const { fs, files } = memoryFileSystem(
      new Map([[legacyProfilePath('/v3', 'user'), input]]),
    )
    let failed = false
    const migratePredictionReference = vi.fn((_user: string, profileId: string) => {
      if (!failed && profileId === old.profiles[1]?.profileId) {
        failed = true
        throw new Error('interrupted association write')
      }
      return Promise.resolve()
    })
    const target = new CaptureConfigurationRepository('/v5', fs, {
      legacyDirectory: '/v3',
      migratePredictionReference,
    })
    await expect(target.list('user')).rejects.toBeInstanceOf(
      CaptureProfileStoreCorruptError,
    )
    expect(files.has(profilePath('/v5', 'user'))).toBe(false)
    await expect(target.list('user')).resolves.toMatchObject({ profileCount: 2 })
    expect(files.get(legacyProfilePath('/v3', 'user'))).toBe(input)
    expect(migratePredictionReference).toHaveBeenCalledTimes(4)
  })

  it('rejects an unknown v5 schema instead of silently reimporting old data', async () => {
    const old = legacyCollection('user', 1)
    const { fs, files } = memoryFileSystem(
      new Map([
        [profilePath('/v3', 'user'), JSON.stringify(old)],
        [profilePath('/v5', 'user'), JSON.stringify({ schemaVersion: 99 })],
      ]),
    )
    await expect(repository('/v5', fs, '/v3').list('user')).rejects.toBeInstanceOf(
      CaptureProfileStoreCorruptError,
    )
    expect(files.get(profilePath('/v5', 'user'))).toBe(
      JSON.stringify({ schemaVersion: 99 }),
    )
  })
})

describe('review regression migrated source identity', () => {
  it('#3 flags imported profiles without executable identity for validation', async () => {
    const old = legacyCollection('user', 1)
    const { fs } = memoryFileSystem(
      new Map([[legacyProfilePath('/v3', 'user'), JSON.stringify(old)]]),
    )
    const target = repository('/v5', fs, '/v3')
    const migrated = required(
      await target.get('user', required(old.profiles[0]).profileId),
    )
    expect(migrated.configuration.calibration.validationStatus).toBe('needs_validation')
  })
})

function signSynthetic<T extends { fingerprint: string }>(value: T): T {
  const { fingerprint: _fingerprint, ...unsigned } = value
  void _fingerprint
  return {
    ...value,
    fingerprint: createHash('sha256').update(JSON.stringify(unsigned)).digest('hex'),
  }
}

function previousCollection(userId: string, count: number) {
  const ids = profileIdSequence()
  const profiles = Array.from({ length: count }, (_, index) => {
    const current = configuration(userId, index + 1, `Emulator ${index + 1}`)
    if (current.calibration.coordinateSpace !== 'full_frame_normalized')
      throw new Error('Expected full-frame fixture')
    const previous = signSynthetic(
      V4CaptureConfigurationSchema.parse({
        ...current,
        schemaVersion: 2,
        sourceBinding: { ...current.sourceBinding, lastVerifiedAt: current.committedAt },
        calibration: {
          ...current.calibration,
          schemaVersion: 1,
          calibrationId: ids(),
          revision: index + 3,
          gameViewport: { x: 0.05, y: 0.03, width: 0.9, height: 0.94 },
          expectedLayout: 'synthetic-layout',
          validationStatus: index % 2 === 0 ? 'validated' : 'imported',
        },
      }),
    )
    return {
      profileId: previous.calibration.calibrationId,
      profileName: `Emulator ${index + 1}`,
      createdAt: previous.committedAt,
      updatedAt: previous.committedAt,
      configuration: previous,
    }
  })
  return signSynthetic(
    V4CaptureCollectionSchema.parse({
      schemaVersion: 3,
      userId,
      revision: 37,
      fingerprint: '0'.repeat(64),
      activeProfileId: required(profiles.at(-1)).profileId,
      profiles,
    }),
  )
}

function previousResult(profile: V4CaptureProfile): PredictionResultConfiguration {
  const capture = profile.configuration
  return signSynthetic<PredictionResultConfiguration>({
    schemaVersion: 2,
    userId: capture.userId,
    captureProfileId: profile.profileId,
    captureConfigurationRevision: capture.revision,
    captureConfigurationFingerprint: capture.fingerprint,
    revision: 9,
    fingerprint: '0'.repeat(64),
    committedAt: capture.committedAt,
    source: capture.sourceBinding.identity,
    frameSize: capture.calibration.referenceFrameSize,
    trigger: capture.calibration.triggerRegion,
    data: capture.calibration.nicknameRegion,
    triggerProfile: capture.calibration.triggerProfile,
  })
}

function previousPath(directory: string, userId: string): string {
  return join(directory, `${userHash(userId)}.profiles.v3.json`)
}

describe('capture-profiles.v4 to v5 strict rollback migration', () => {
  it('handles zero profiles as an absent store without creating empty or rollback files', async () => {
    const { fs, files } = memoryFileSystem()
    const target = new CaptureConfigurationRepository('/v5', fs, {
      previousDirectory: '/v4',
      legacyDirectory: '/v3',
    })
    await expect(target.list('user')).resolves.toBeNull()
    await expect(target.load('user')).resolves.toBeNull()
    expect(files.size).toBe(0)
  })

  it('migrates frozen 6159cdd v4 bytes without rewriting rollback input or changing old fields', async () => {
    // Handcrafted from the schema and SHA-256 JSON signing order at 6159cdd.
    // Keep this input frozen: never generate it with the current capture schemas.
    const bytes = await readFile(
      new URL('../../../tests/capture-profiles.v4.6159cdd.json', import.meta.url),
      'utf8',
    )
    const old = JSON.parse(bytes) as V4CaptureCollection
    expect(V4CaptureCollectionSchema.parse(old)).toEqual(old)
    expect(old.fingerprint).toBe(
      'b9c0ce3adec7a305595cb479c847e8d85624962832f1c01a106b577d1d2b0c90',
    )
    const { fingerprint: oldFingerprint, ...unsignedOld } = old
    expect(createHash('sha256').update(JSON.stringify(unsignedOld)).digest('hex')).toBe(
      oldFingerprint,
    )
    expect(old.profiles.map((profile) => profile.configuration.fingerprint)).toEqual([
      '538497195c24366d047e3e95fc3412dcb300f44b373f76787837ecbe86809b45',
      '768137717a017700c42ae15a91d789e864068f0217d2291d7ba198c04d774b7a',
    ])
    const first = required(old.profiles[0]).configuration
    expect(first.sourceBinding).toEqual({
      identity: {
        kind: 'window',
        label: 'Synthetic Emulator',
        titleHint: 'Synthetic Clash Royale',
        executableLabel: 'synthetic-emulator.exe',
        windowHwnd: '987654321',
      },
      lastVerifiedAt: '2026-07-18T10:45:00.000Z',
    })
    expect(first.calibration).toMatchObject({
      coordinateSpace: 'full_frame_normalized',
      referenceFrameSize: { width: 1920, height: 1080 },
      gameViewport: { x: 0.3125, y: 0.0625, width: 0.375, height: 0.875 },
      expectedLayout: 'synthetic-portrait-v4',
      provenance: {
        trigger: { origin: 'auto', confidence: 0.875, analyzerVersion: '2.0.0' },
        nickname: { origin: 'manual', confidence: null, analyzerVersion: null },
        topLeftEvidence: {
          origin: 'imported',
          confidence: 0.625,
          analyzerVersion: '1.9.0',
        },
        viewport: {
          origin: 'auto',
          confidence: 0.9375,
          analyzerVersion: 'synthetic-viewport-1',
        },
      },
      triggerProfile: {
        normalizedTemplateSize: { width: 128, height: 128 },
        structureHash64: 'ffffffffffffffff',
        quality: { edgePixelCount: 4096, cropAreaRatio: 0.5625 },
      },
    })
    for (const template of [
      first.calibration.triggerProfile.structureTemplateBase64,
      first.calibration.triggerProfile.edgeTemplateBase64,
      first.calibration.triggerProfile.orientationTemplateBase64,
    ]) {
      expect(template).toMatch(/^iVBORw0KGgo/)
      expect(template.length).toBeGreaterThan(100)
    }

    const userId = old.userId
    const inputs = new Map([[previousPath('/v4', userId), bytes]])
    for (const profile of old.profiles) {
      const { fingerprint, ...unsigned } = profile.configuration
      expect(createHash('sha256').update(JSON.stringify(unsigned)).digest('hex')).toBe(
        fingerprint,
      )
      inputs.set(
        join('/results-v4', `${userHash(userId)}.${profile.profileId}.json`),
        JSON.stringify(previousResult(profile)),
      )
    }
    const { fs, files } = memoryFileSystem(inputs)
    const results = new PredictionResultConfigurationRepository('/results-v5', fs, [
      '/results-v4',
    ])
    const options = {
      previousDirectory: '/v4',
      migratePredictionReference: results.migrateCaptureReference.bind(results),
    }
    const target = new CaptureConfigurationRepository('/v5', fs, options)
    const status = await target.list(userId)
    expect(status).toMatchObject({
      activeProfileId: old.activeProfileId,
      revision: 23,
      profileCount: 2,
    })
    const migrated = readCollection(files, '/v5', userId)
    expect(migrated).toEqual({
      ...old,
      schemaVersion: 4,
      fingerprint: migrated.fingerprint,
      profiles: old.profiles.map((profile, index) => ({
        ...profile,
        configuration: {
          ...profile.configuration,
          schemaVersion: 3,
          fingerprint: required(migrated.profiles[index]).configuration.fingerprint,
          calibration: { ...profile.configuration.calibration, schemaVersion: 2 },
        },
      })),
    })
    expect(migrated.fingerprint).not.toBe(old.fingerprint)
    const { fingerprint, ...unsigned } = migrated
    expect(captureProfileCollectionFingerprint(unsigned)).toBe(fingerprint)
    for (const [index, profile] of migrated.profiles.entries()) {
      const previous = required(old.profiles[index])
      expect(profile.configuration.fingerprint).not.toBe(
        previous.configuration.fingerprint,
      )
      const { fingerprint: configurationFingerprint, ...unsignedConfiguration } =
        profile.configuration
      expect(captureConfigurationFingerprint(unsignedConfiguration)).toBe(
        configurationFingerprint,
      )
      const result = required(await results.load(userId, profile.profileId))
      expect(result).toEqual({
        ...previousResult(previous),
        fingerprint: result.fingerprint,
        captureConfigurationFingerprint: configurationFingerprint,
      })
      const { fingerprint: resultFingerprint, ...unsignedResult } = result
      expect(predictionResultFingerprint(unsignedResult)).toBe(resultFingerprint)
    }
    for (const [path, input] of inputs) expect(files.get(path)).toBe(input)
    const committed = required(files.get(profilePath('/v5', userId)))
    const reopened = new CaptureConfigurationRepository('/v5', fs, options)
    await expect(reopened.list(userId)).resolves.toEqual(status)
    await expect(reopened.load(userId)).resolves.toEqual(
      required(
        migrated.profiles.find((profile) => profile.profileId === old.activeProfileId),
      ).configuration,
    )
    for (const profile of migrated.profiles) {
      await expect(reopened.get(userId, profile.profileId)).resolves.toEqual(profile)
    }
    expect(files.get(profilePath('/v5', userId))).toBe(committed)
    for (const [path, input] of inputs) expect(files.get(path)).toBe(input)
  })

  it.each([1, 20])(
    'preserves every field and result for %i profiles, changing only versions and fingerprints',
    async (count) => {
      const old = previousCollection('user', count)
      const bytes = JSON.stringify(old)
      const inputs = new Map([[previousPath('/v4', 'user'), bytes]])
      for (const profile of old.profiles) {
        inputs.set(
          join('/results-v4', `${userHash('user')}.${profile.profileId}.json`),
          JSON.stringify(previousResult(profile)),
        )
      }
      const { fs, files } = memoryFileSystem(inputs)
      const results = new PredictionResultConfigurationRepository('/results-v5', fs, [
        '/results-v4',
        '/results-v3',
      ])
      const options = {
        previousDirectory: '/v4',
        legacyDirectory: '/v3',
        migratePredictionReference: results.migrateCaptureReference.bind(results),
      }
      const target = new CaptureConfigurationRepository('/v5', fs, options)
      expect(await target.list('user')).toMatchObject({
        activeProfileId: old.activeProfileId,
        revision: old.revision,
        profileCount: count,
      })
      const migrated = readCollection(files, '/v5', 'user')
      expect(migrated.schemaVersion).toBe(4)
      for (const [index, profile] of migrated.profiles.entries()) {
        const previous = required(old.profiles[index])
        const { fingerprint: _fingerprint, ...oldConfiguration } = previous.configuration
        void _fingerprint
        expect(profile).toEqual({
          ...previous,
          configuration: {
            ...oldConfiguration,
            schemaVersion: 3,
            fingerprint: profile.configuration.fingerprint,
            calibration: { ...oldConfiguration.calibration, schemaVersion: 2 },
          },
        })
        const previousGeometry = previousResult(previous)
        const result = required(await results.load('user', profile.profileId))
        expect(result).toEqual({
          ...previousGeometry,
          fingerprint: result.fingerprint,
          captureConfigurationFingerprint: profile.configuration.fingerprint,
        })
        const { fingerprint, ...unsignedResult } = result
        expect(predictionResultFingerprint(unsignedResult)).toBe(fingerprint)
      }
      for (const [path, input] of inputs) expect(files.get(path)).toBe(input)
      const committed = files.get(profilePath('/v5', 'user'))
      await new CaptureConfigurationRepository('/v5', fs, options).list('user')
      expect(files.get(profilePath('/v5', 'user'))).toBe(committed)
    },
  )

  it.each([
    'collection-version',
    'configuration-version',
    'calibration-version',
    'unknown-field',
    'collection-hash',
    'configuration-hash',
  ] as const)(
    'rejects invalid v4 %s without any writes or legacy fallback',
    async (kind) => {
      const old = previousCollection('user', 1)
      const raw = JSON.parse(JSON.stringify(old)) as {
        schemaVersion: number
        fingerprint: string
        profiles: {
          configuration: {
            schemaVersion: number
            fingerprint: string
            calibration: { schemaVersion: number; extra?: boolean }
          }
        }[]
      }
      const nested = required(raw.profiles[0]).configuration
      if (kind === 'collection-version') raw.schemaVersion = 99
      if (kind === 'configuration-version') nested.schemaVersion = 99
      if (kind === 'calibration-version') nested.calibration.schemaVersion = 99
      if (kind === 'unknown-field') nested.calibration.extra = true
      if (kind === 'collection-hash') raw.fingerprint = 'f'.repeat(64)
      if (kind === 'configuration-hash') {
        nested.fingerprint = 'f'.repeat(64)
        raw.fingerprint = signSynthetic(raw).fingerprint
      }
      const bytes = JSON.stringify(raw)
      const { fs, files } = memoryFileSystem(
        new Map([
          [previousPath('/v4', 'user'), bytes],
          [legacyPath('/v3', 'user'), JSON.stringify(legacyConfiguration('user'))],
        ]),
      )
      const migratePredictionReference = vi.fn().mockResolvedValue(undefined)
      const target = new CaptureConfigurationRepository('/v5', fs, {
        previousDirectory: '/v4',
        legacyDirectory: '/v3',
        migratePredictionReference,
      })
      await expect(target.list('user')).rejects.toBeInstanceOf(
        CaptureProfileStoreCorruptError,
      )
      expect(migratePredictionReference).not.toHaveBeenCalled()
      expect(files.has(profilePath('/v5', 'user'))).toBe(false)
      expect(files.get(previousPath('/v4', 'user'))).toBe(bytes)
    },
  )

  it.each(['capture', 'result'])(
    'resumes after %s rename failure with stable re-keyed results',
    async (failure) => {
      const old = previousCollection('user', 2)
      const inputs = new Map([[previousPath('/v4', 'user'), JSON.stringify(old)]])
      for (const profile of old.profiles) {
        inputs.set(
          join('/results-v4', `${userHash('user')}.${profile.profileId}.json`),
          JSON.stringify(previousResult(profile)),
        )
      }
      const { fs, files } = memoryFileSystem(inputs)
      const originalRename = fs.rename
      let failed = false
      fs.rename = async (from, to) => {
        if (
          !failed &&
          (failure === 'capture'
            ? to === profilePath('/v5', 'user')
            : to.startsWith(join('/results-v5')))
        ) {
          failed = true
          throw new Error('synthetic rename failure')
        }
        await originalRename(from, to)
      }
      const makeRepository = () => {
        const results = new PredictionResultConfigurationRepository(
          '/results-v5',
          fs,
          '/results-v4',
        )
        return {
          results,
          target: new CaptureConfigurationRepository('/v5', fs, {
            previousDirectory: '/v4',
            migratePredictionReference: results.migrateCaptureReference.bind(results),
          }),
        }
      }
      await expect(makeRepository().target.list('user')).rejects.toBeInstanceOf(
        CaptureProfileStoreCorruptError,
      )
      expect(files.has(profilePath('/v5', 'user'))).toBe(false)
      expect([...files.keys()].some((path) => path.endsWith('.tmp'))).toBe(false)
      const resumed = makeRepository()
      await expect(resumed.target.list('user')).resolves.toMatchObject({
        profileCount: 2,
      })
      for (const profile of old.profiles) {
        const capture = required(
          await resumed.target.get('user', profile.profileId),
        ).configuration
        expect(await resumed.results.load('user', profile.profileId)).toMatchObject({
          captureConfigurationFingerprint: capture.fingerprint,
          triggerProfile: profile.configuration.calibration.triggerProfile,
        })
      }
      for (const [path, input] of inputs) expect(files.get(path)).toBe(input)
    },
  )
})

function gameConfiguration(aspects = [0.42]): CaptureConfiguration {
  const fullFrame = configuration('user')
  if (fullFrame.calibration.coordinateSpace !== 'full_frame_normalized')
    throw new Error('Expected full-frame fixture')
  const ids = profileIdSequence()
  const calibration = fullFrame.calibration
  const layouts = aspects.map((gameAspect, index) => ({
    layoutId: ids(),
    layoutSource: index === 0 ? ('setup' as const) : ('learned' as const),
    gameAspect,
    referenceFrameSize: { width: 1000, height: 1400 },
    referenceGameRect: {
      x: 10,
      y: 10,
      width: Math.round(gameAspect * 1000),
      height: 1000,
    },
    windowChrome: {
      top: 0,
      bottom: 0,
      left: 0,
      right: 0,
      topEdges: null,
      bottomEdges: null,
      leftEdges: null,
      rightEdges: null,
    },
    expectedLayout: 'cr_battle_vs' as const,
    triggerRegion: calibration.triggerRegion,
    nicknameRegion: calibration.nicknameRegion,
    topLeftEvidenceRegion: calibration.topLeftEvidenceRegion,
    trigger: { kind: 'structural' as const, profile: calibration.triggerProfile },
    provenance: calibration.provenance,
    calibratedAt: `2026-07-${String(index + 1).padStart(2, '0')}T12:00:00.000Z`,
  }))
  const unsigned: Omit<CaptureConfiguration, 'fingerprint'> = {
    schemaVersion: 3,
    userId: 'user',
    revision: 5,
    committedAt: fullFrame.committedAt,
    sourceBinding: fullFrame.sourceBinding,
    calibration: {
      schemaVersion: 2,
      coordinateSpace: 'game_relative',
      calibrationId: calibration.calibrationId,
      revision: 3,
      layouts,
      validationStatus: 'validated',
      calibratedAt: calibration.calibratedAt,
    },
  }
  return { ...unsigned, fingerprint: captureConfigurationFingerprint(unsigned) }
}

describe('game-relative storage mutations', () => {
  it.each([0.5625 * 1.0305, GAME_ASPECT_MIN, GAME_ASPECT_MAX])(
    'round-trips learned aspect %s and validates its monitor restart layouts',
    async (gameAspect) => {
      const { fs } = memoryFileSystem()
      const target = repository('/v5', fs)
      const config = gameConfiguration([0.5625])
      if (config.calibration.coordinateSpace !== 'game_relative')
        throw new Error('Expected game-relative fixture')
      await target.save(config)
      const status = required(await target.list('user'))
      const learned = {
        ...required(config.calibration.layouts[0]),
        layoutSource: 'learned' as const,
        layoutId: '00000000-0000-4000-8000-000000000099',
        gameAspect,
      }
      await target.appendLearnedLayout(
        'user',
        status.activeProfileId,
        config.calibration.calibrationId,
        learned,
      )
      const reopened = repository('/v5', fs)
      const calibration = required(await reopened.get('user', status.activeProfileId))
        .configuration.calibration
      if (calibration.coordinateSpace !== 'game_relative')
        throw new Error('Expected persisted game-relative calibration')
      expect(calibration.layouts.map((layout) => layout.gameAspect)).toEqual([
        0.5625,
        gameAspect,
      ])
      const primary = MonitorPrimarySchema.parse({
        kind: 'game_relative',
        profileCalibrationId: calibration.calibrationId,
        layouts: calibration.layouts.map((layout) => ({
          layoutId: layout.layoutId,
          layoutSource: layout.layoutSource,
          calibratedAt: layout.calibratedAt,
          gameAspect: layout.gameAspect,
          windowChrome: layout.windowChrome,
          regions: {
            trigger: layout.triggerRegion,
            nicknameRegion: layout.nicknameRegion,
            topLeftEvidenceRegion: layout.topLeftEvidenceRegion,
          },
          trigger: layout.trigger,
          badge:
            layout.trigger.kind === 'vs_edge_orientation' ? layout.trigger.badge : null,
          zonesOrigin: {
            nickname: layout.provenance.nickname.origin,
            topLeftEvidence: layout.provenance.topLeftEvidence.origin,
          },
        })),
        learning: { enabled: true, maxLayouts: 4 },
      })
      expect(primary.kind).toBe('game_relative')
    },
  )

  it.each([0.5625 * 1.0299, 0.5625 / 1.0299])(
    'rejects symmetrically overlapping learned aspect %s without a write',
    async (gameAspect) => {
      const { fs, files } = memoryFileSystem()
      const target = repository('/v5', fs)
      const config = gameConfiguration([0.5625])
      if (config.calibration.coordinateSpace !== 'game_relative')
        throw new Error('Expected game-relative fixture')
      await target.save(config)
      const status = required(await target.list('user'))
      const bytes = files.get(profilePath('/v5', 'user'))
      await expect(
        target.appendLearnedLayout(
          'user',
          status.activeProfileId,
          config.calibration.calibrationId,
          {
            ...required(config.calibration.layouts[0]),
            layoutSource: 'learned',
            layoutId: '00000000-0000-4000-8000-000000000099',
            gameAspect,
          },
        ),
      ).rejects.toMatchObject({ code: 'LAYOUT_STALE' })
      expect(files.get(profilePath('/v5', 'user'))).toBe(bytes)
    },
  )

  it('rebinds without creating a full-frame size field or changing layout references', async () => {
    const { fs, files } = memoryFileSystem()
    const target = repository('/v5', fs)
    const config = gameConfiguration()
    await target.save(config)
    const before = required(await target.list('user'))
    expect(before.profiles[0]).toMatchObject({
      calibrationId: config.calibration.calibrationId,
    })
    await target.rebind(
      'user',
      before.activeProfileId,
      { kind: 'display', label: 'New', displayId: '2' },
      before.revision,
      { width: 2000, height: 900 },
    )
    const saved = required(await target.get('user', before.activeProfileId)).configuration
    expect(saved.calibration).toEqual({
      ...config.calibration,
      validationStatus: 'needs_validation',
    })
    expect(saved.calibration).not.toHaveProperty('referenceFrameSize')
    expect(readCollection(files, '/v5', 'user').schemaVersion).toBe(4)
  })

  it('appends atomically, increments all revisions, preserves identities/status and evicts oldest learned only', async () => {
    const { fs, files } = memoryFileSystem()
    const target = repository('/v5', fs)
    const config = gameConfiguration([0.42, 0.48, 0.56, 0.66])
    if (config.calibration.coordinateSpace !== 'game_relative')
      throw new Error('Expected game-relative fixture')
    await target.save(config)
    const before = required(await target.list('user'))
    const resultRepository = new PredictionResultConfigurationRepository(
      '/results-v5',
      fs,
    )
    const result = signSynthetic(
      PredictionResultConfigurationSchema.parse({
        ...previousResult(required(previousCollection('user', 1).profiles[0])),
        captureProfileId: before.activeProfileId,
        captureCalibrationId: config.calibration.calibrationId,
        captureConfigurationRevision: config.revision,
        captureConfigurationFingerprint: config.fingerprint,
      }),
    )
    await resultRepository.save(result, before.activeProfileId)
    const resultPath = join(
      '/results-v5',
      `${userHash('user')}.${before.activeProfileId}.json`,
    )
    const resultBytes = files.get(resultPath)
    const next = {
      ...required(config.calibration.layouts[1]),
      layoutId: '00000000-0000-4000-8000-000000000099',
      gameAspect: 0.75,
    }
    await target.appendLearnedLayout(
      'user',
      before.activeProfileId,
      config.calibration.calibrationId,
      next,
    )
    const saved = required(await target.get('user', before.activeProfileId)).configuration
    expect(saved.revision).toBe(config.revision + 1)
    expect(saved.calibration).toEqual({
      ...config.calibration,
      revision: config.calibration.revision + 1,
      layouts: [
        config.calibration.layouts[0],
        config.calibration.layouts[2],
        config.calibration.layouts[3],
        next,
      ],
    })
    expect(await target.list('user')).toMatchObject({
      revision: before.revision + 1,
      activeProfileId: before.activeProfileId,
    })
    expect(files.get(resultPath)).toBe(resultBytes)
    const savedResult = required(
      await resultRepository.load('user', before.activeProfileId),
    )
    expect(
      predictionResultMatchesCapture(savedResult, {
        profileId: before.activeProfileId,
        configurationRevision: saved.revision,
        configurationFingerprint: saved.fingerprint,
        calibrationId: saved.calibration.calibrationId,
      }),
    ).toBe(true)
  })

  it('serializes concurrent duplicate events and rejects stale calibrations without writes', async () => {
    const { fs, files } = memoryFileSystem()
    const target = repository('/v5', fs)
    const config = gameConfiguration()
    if (config.calibration.coordinateSpace !== 'game_relative')
      throw new Error('Expected game-relative fixture')
    await target.save(config)
    const status = required(await target.list('user'))
    const next = {
      ...required(config.calibration.layouts[0]),
      layoutSource: 'learned' as const,
      layoutId: '00000000-0000-4000-8000-000000000099',
      gameAspect: 0.56,
    }
    const results = await Promise.allSettled([
      target.appendLearnedLayout(
        'user',
        status.activeProfileId,
        config.calibration.calibrationId,
        next,
      ),
      target.appendLearnedLayout(
        'user',
        status.activeProfileId,
        config.calibration.calibrationId,
        next,
      ),
    ])
    expect(results.map((result) => result.status)).toEqual(['fulfilled', 'rejected'])
    expect(results[1]).toMatchObject({ reason: { code: 'LAYOUT_STALE' } })
    const bytes = files.get(profilePath('/v5', 'user'))
    await expect(
      target.appendLearnedLayout(
        'user',
        status.activeProfileId,
        '00000000-0000-4000-8000-000000000098',
        next,
      ),
    ).rejects.toMatchObject({ code: 'LAYOUT_STALE' })
    expect(files.get(profilePath('/v5', 'user'))).toBe(bytes)
  })

  it('rejects a fifth setup-only layout and preserves the committed file on disk failure', async () => {
    const { fs, files } = memoryFileSystem()
    const target = repository('/v5', fs)
    const config = gameConfiguration([0.42, 0.48, 0.56, 0.66])
    if (config.calibration.coordinateSpace !== 'game_relative')
      throw new Error('Expected game-relative fixture')
    config.calibration.layouts = config.calibration.layouts.map((layout) => ({
      ...layout,
      layoutSource: 'setup',
    }))
    const signed = signSynthetic(config)
    await target.save(signed)
    const status = required(await target.list('user'))
    const next = {
      ...required(config.calibration.layouts[0]),
      layoutSource: 'learned' as const,
      layoutId: '00000000-0000-4000-8000-000000000099',
      gameAspect: 0.75,
    }
    const bytes = files.get(profilePath('/v5', 'user'))
    await expect(
      target.appendLearnedLayout(
        'user',
        status.activeProfileId,
        config.calibration.calibrationId,
        next,
      ),
    ).rejects.toMatchObject({ code: 'LAYOUT_LIMIT' })
    expect(files.get(profilePath('/v5', 'user'))).toBe(bytes)
    const simple = gameConfiguration()
    await target.update('user', status.activeProfileId, simple)
    const committed = files.get(profilePath('/v5', 'user'))
    fs.rename = vi.fn().mockRejectedValue(new Error('synthetic disk failure'))
    const error = await target
      .appendLearnedLayout(
        'user',
        status.activeProfileId,
        simple.calibration.calibrationId,
        next,
      )
      .catch((cause: unknown) => cause)
    expect(error).toBeInstanceOf(ApplicationError)
    expect(error).toMatchObject({ code: 'LAYOUT_SAVE_FAILED' })
    expect(files.get(profilePath('/v5', 'user'))).toBe(committed)
    expect([...files.keys()].some((path) => path.endsWith('.tmp'))).toBe(false)
  })
})
