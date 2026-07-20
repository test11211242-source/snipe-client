import { createHash } from 'node:crypto'
import { join } from 'node:path'

import { describe, expect, it, vi } from 'vitest'

import {
  CaptureProfileCollectionSchema,
  MAX_CAPTURE_PROFILES,
  type CaptureConfiguration,
  type CaptureProfileCollection,
} from '../../../shared/models/capture'
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

function required<T>(value: T | null | undefined): T {
  if (value === undefined || value === null) throw new Error('Missing test value')
  return value
}

function configuration(
  userId: string,
  revision = 1,
  sourceLabel = 'Game',
): CaptureConfiguration {
  const unsigned: Omit<CaptureConfiguration, 'fingerprint'> = {
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
  return { ...unsigned, fingerprint: captureConfigurationFingerprint(unsigned) }
}

function userHash(userId: string): string {
  return createHash('sha256').update(userId).digest('hex')
}

function legacyPath(directory: string, userId: string): string {
  return join(directory, `${userHash(userId)}.json`)
}

function profilePath(directory: string, userId: string): string {
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
      schemaVersion: 2 as const,
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
    const legacy = `${JSON.stringify(configuration(userId), null, 2)}\n`
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
    await expect(first.load(userId)).resolves.toEqual(configuration(userId))

    const firstProfileId = required(status).activeProfileId
    files.delete(profilePath('/config', userId))
    const second = repository('/config', fs)
    await expect(second.list(userId)).resolves.toMatchObject({
      activeProfileId: firstProfileId,
    })
  })

  it('can migrate from an optional separate legacy directory', async () => {
    const userId = 'separate-legacy-user'
    const legacy = JSON.stringify(configuration(userId))
    const { fs, files } = memoryFileSystem(
      new Map([[legacyPath('/legacy', userId), legacy]]),
    )
    const target = repository('/profiles', fs, '/legacy')

    await expect(target.load(userId)).resolves.toEqual(configuration(userId))
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
      source: { label: 'Game' },
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
      source: { label: 'Updated Game' },
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
      [...files.keys()].filter((path) => path.endsWith('.profiles.v2.json')),
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
    const legacy = JSON.stringify(configuration(userId, 9, 'Legacy'))
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
