import { createHash, randomUUID } from 'node:crypto'
import { promises as nodeFs } from 'node:fs'
import { join } from 'node:path'

import {
  CaptureConfigurationSchema,
  CapturePreferenceSchema,
  CaptureProfileCollectionSchema,
  CaptureProfileCollectionStatusSchema,
  CaptureProfileIdSchema,
  CaptureProfileNameSchema,
  MAX_CAPTURE_PROFILES,
  type CaptureConfiguration,
  type CapturePreference,
  type PixelSize,
  type CaptureProfile,
  type CaptureProfileCollection,
  type CaptureProfileCollectionStatus,
} from '../../../shared/models/capture'

export interface CaptureConfigurationFileSystem {
  readFile: (path: string, encoding: 'utf8') => Promise<string>
  writeFile: (path: string, data: string, encoding: 'utf8') => Promise<void>
  rename: (oldPath: string, newPath: string) => Promise<void>
  mkdir: (path: string, options: { recursive: true }) => Promise<unknown>
  rm: (path: string, options: { force: true }) => Promise<void>
}

export const nodeCaptureConfigurationFileSystem: CaptureConfigurationFileSystem = {
  readFile: (path, encoding) => nodeFs.readFile(path, encoding),
  writeFile: (path, data, encoding) => nodeFs.writeFile(path, data, encoding),
  rename: (oldPath, newPath) => nodeFs.rename(oldPath, newPath),
  mkdir: (path, options) => nodeFs.mkdir(path, options),
  rm: (path, options) => nodeFs.rm(path, options),
}

export const DEFAULT_CAPTURE_PROFILE_NAME = 'Основной'

export interface CaptureConfigurationRepositoryOptions {
  /**
   * Directory containing schemaVersion 1 `<user-hash>.json` files. It defaults to
   * `directory`, which lets the current bootstrap migrate in place while retaining the old file.
   */
  legacyDirectory?: string
  now?: () => Date
  createProfileId?: () => string
}

export interface SaveCaptureConfigurationOptions {
  profileId?: string
  profileName?: string
  expectedRevision?: number
}

export class CaptureProfileNotFoundError extends Error {
  constructor(profileId: string) {
    super(`Capture profile ${profileId} was not found`)
    this.name = 'CaptureProfileNotFoundError'
  }
}

export class CaptureProfileNameConflictError extends Error {
  constructor(profileName: string) {
    super(`Capture profile name already exists: ${profileName}`)
    this.name = 'CaptureProfileNameConflictError'
  }
}

export class CaptureProfileLimitError extends Error {
  constructor() {
    super(`Capture profile limit of ${MAX_CAPTURE_PROFILES} has been reached`)
    this.name = 'CaptureProfileLimitError'
  }
}

export class CaptureProfileRevisionConflictError extends Error {
  constructor(
    readonly expectedRevision: number,
    readonly actualRevision: number,
  ) {
    super(
      `Capture profile collection revision conflict: expected ${expectedRevision}, actual ${actualRevision}`,
    )
    this.name = 'CaptureProfileRevisionConflictError'
  }
}

export class CaptureProfileStoreCorruptError extends Error {
  constructor(
    userId: string,
    source: 'profile store' | 'legacy configuration',
    cause: unknown,
  ) {
    super(`Capture ${source} is corrupt for user ${userId}`, { cause })
    this.name = 'CaptureProfileStoreCorruptError'
  }
}

export class CannotDeleteLastCaptureProfileError extends Error {
  constructor() {
    super('The last capture profile cannot be deleted')
    this.name = 'CannotDeleteLastCaptureProfileError'
  }
}

function fileNotFound(error: unknown): boolean {
  return (
    error !== null &&
    typeof error === 'object' &&
    'code' in error &&
    error.code === 'ENOENT'
  )
}

function userFileStem(userId: string): string {
  return createHash('sha256').update(userId).digest('hex')
}

function legacyUserFileName(userId: string): string {
  return `${userFileStem(userId)}.json`
}

function profileUserFileName(userId: string): string {
  return `${userFileStem(userId)}.profiles.v2.json`
}

export function migratedCaptureProfileId(userId: string): string {
  const hash = createHash('sha256').update(`capture-profile-v2:${userId}`).digest('hex')
  const variant = ((Number.parseInt(hash.charAt(16), 16) & 0x3) | 0x8).toString(16)
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-5${hash.slice(13, 16)}-${variant}${hash.slice(17, 20)}-${hash.slice(20, 32)}`
}

function normalizedProfileName(profileName: string): string {
  return profileName.toLowerCase()
}

function assertExpectedRevision(
  collection: CaptureProfileCollection | null,
  expectedRevision: number | undefined,
): void {
  if (expectedRevision === undefined) return
  if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) {
    throw new RangeError('expectedRevision must be a non-negative safe integer')
  }
  const actualRevision = collection?.revision ?? 0
  if (actualRevision !== expectedRevision) {
    throw new CaptureProfileRevisionConflictError(expectedRevision, actualRevision)
  }
}

function assertUniqueProfileName(
  profiles: readonly CaptureProfile[],
  profileName: string,
  exceptProfileId?: string,
): void {
  const normalized = normalizedProfileName(profileName)
  if (
    profiles.some(
      (profile) =>
        profile.profileId !== exceptProfileId &&
        normalizedProfileName(profile.profileName) === normalized,
    )
  ) {
    throw new CaptureProfileNameConflictError(profileName)
  }
}

function requireProfileIndex(
  collection: CaptureProfileCollection,
  profileId: string,
): number {
  const index = collection.profiles.findIndex(
    (profile) => profile.profileId === profileId,
  )
  if (index < 0) throw new CaptureProfileNotFoundError(profileId)
  return index
}

export function captureConfigurationFingerprint(
  config: Omit<CaptureConfiguration, 'fingerprint'>,
): string {
  return createHash('sha256').update(JSON.stringify(config)).digest('hex')
}

export function captureProfileCollectionFingerprint(
  collection: Omit<CaptureProfileCollection, 'fingerprint'>,
): string {
  return createHash('sha256').update(JSON.stringify(collection)).digest('hex')
}

function validateConfiguration(config: CaptureConfiguration): CaptureConfiguration {
  const validated = CaptureConfigurationSchema.parse(config)
  const { fingerprint, ...unsigned } = validated
  if (captureConfigurationFingerprint(unsigned) !== fingerprint) {
    throw new Error('Capture configuration fingerprint is invalid')
  }
  return validated
}

function signConfiguration(
  config: Omit<CaptureConfiguration, 'fingerprint'>,
): CaptureConfiguration {
  return CaptureConfigurationSchema.parse({
    ...config,
    fingerprint: captureConfigurationFingerprint(config),
  })
}

function signCollection(
  collection: Omit<CaptureProfileCollection, 'fingerprint'>,
): CaptureProfileCollection {
  return CaptureProfileCollectionSchema.parse({
    ...collection,
    fingerprint: captureProfileCollectionFingerprint(collection),
  })
}

function validateCollection(
  collection: CaptureProfileCollection,
): CaptureProfileCollection {
  const validated = CaptureProfileCollectionSchema.parse(collection)
  for (const profile of validated.profiles) validateConfiguration(profile.configuration)
  const { fingerprint, ...unsigned } = validated
  if (captureProfileCollectionFingerprint(unsigned) !== fingerprint) {
    throw new Error('Capture profile collection fingerprint is invalid')
  }
  return validated
}

function collectionStatus(
  collection: CaptureProfileCollection,
): CaptureProfileCollectionStatus {
  return CaptureProfileCollectionStatusSchema.parse({
    userId: collection.userId,
    revision: collection.revision,
    fingerprint: collection.fingerprint,
    activeProfileId: collection.activeProfileId,
    profileCount: collection.profiles.length,
    profiles: collection.profiles.map((profile) => ({
      profileId: profile.profileId,
      profileName: profile.profileName,
      isActive: profile.profileId === collection.activeProfileId,
      createdAt: profile.createdAt,
      updatedAt: profile.updatedAt,
      configurationRevision: profile.configuration.revision,
      configurationFingerprint: profile.configuration.fingerprint,
      committedAt: profile.configuration.committedAt,
      sourceKind: profile.configuration.source.kind,
      sourceLabel: profile.configuration.source.label,
    })),
  })
}

export class CaptureConfigurationRepository {
  private readonly legacyDirectory: string
  private readonly now: () => Date
  private readonly createProfileId: () => string
  private mutationQueue: Promise<void> = Promise.resolve()

  /**
   * `directory` stores `*.profiles.v2.json`. The optional third argument can point migration at
   * another legacy directory; omitting it reads schemaVersion 1 files from `directory` itself.
   */
  constructor(
    private readonly directory: string,
    private readonly fs: CaptureConfigurationFileSystem = nodeCaptureConfigurationFileSystem,
    options: CaptureConfigurationRepositoryOptions = {},
  ) {
    this.legacyDirectory = options.legacyDirectory ?? directory
    this.now = options.now ?? (() => new Date())
    this.createProfileId = options.createProfileId ?? randomUUID
  }

  async load(userId: string): Promise<CaptureConfiguration | null> {
    return this.serialized(async () => {
      const collection = await this.readOrMigrate(userId)
      if (collection === null) return null
      const activeProfile = collection.profiles.find(
        (profile) => profile.profileId === collection.activeProfileId,
      )
      return activeProfile?.configuration ?? null
    })
  }

  async save(
    config: CaptureConfiguration,
    options: SaveCaptureConfigurationOptions = {},
  ): Promise<void> {
    const validated = validateConfiguration(config)
    await this.serialized(async () => {
      const collection = await this.readOrMigrate(validated.userId)
      assertExpectedRevision(collection, options.expectedRevision)
      const timestamp = this.timestamp()

      if (collection === null) {
        const profileId = CaptureProfileIdSchema.parse(
          options.profileId ?? this.createProfileId(),
        )
        const profileName = CaptureProfileNameSchema.parse(
          options.profileName ?? DEFAULT_CAPTURE_PROFILE_NAME,
        )
        await this.writeCollection(
          signCollection({
            schemaVersion: 2,
            userId: validated.userId,
            revision: 1,
            activeProfileId: profileId,
            profiles: [
              {
                profileId,
                profileName,
                createdAt: timestamp,
                updatedAt: timestamp,
                configuration: validated,
              },
            ],
          }),
        )
        return
      }

      const profileId = CaptureProfileIdSchema.parse(
        options.profileId ?? collection.activeProfileId,
      )
      const index = collection.profiles.findIndex(
        (profile) => profile.profileId === profileId,
      )
      const profiles = [...collection.profiles]
      if (index < 0) {
        if (profiles.length >= MAX_CAPTURE_PROFILES) throw new CaptureProfileLimitError()
        const profileName = CaptureProfileNameSchema.parse(
          options.profileName ?? DEFAULT_CAPTURE_PROFILE_NAME,
        )
        assertUniqueProfileName(profiles, profileName)
        profiles.push({
          profileId,
          profileName,
          createdAt: timestamp,
          updatedAt: timestamp,
          configuration: validated,
        })
      } else {
        const previous = profiles[index]
        if (previous === undefined) throw new CaptureProfileNotFoundError(profileId)
        const profileName = CaptureProfileNameSchema.parse(
          options.profileName ?? previous.profileName,
        )
        assertUniqueProfileName(profiles, profileName, profileId)
        profiles[index] = {
          ...previous,
          profileName,
          updatedAt: timestamp,
          configuration: validated,
        }
      }

      await this.writeCollection(this.reviseCollection(collection, profiles, profileId))
    })
  }

  async list(userId: string): Promise<CaptureProfileCollectionStatus | null> {
    return this.serialized(async () => {
      const collection = await this.readOrMigrate(userId)
      return collection === null ? null : collectionStatus(collection)
    })
  }

  async get(userId: string, profileId: string): Promise<CaptureProfile | null> {
    const validatedProfileId = CaptureProfileIdSchema.parse(profileId)
    return this.serialized(async () => {
      const collection = await this.readOrMigrate(userId)
      return (
        collection?.profiles.find(
          (profile) => profile.profileId === validatedProfileId,
        ) ?? null
      )
    })
  }

  async getActive(
    userId: string,
  ): Promise<{ collectionRevision: number; profile: CaptureProfile } | null> {
    return this.serialized(async () => {
      const collection = await this.readOrMigrate(userId)
      if (collection === null) return null
      const profile = collection.profiles.find(
        (candidate) => candidate.profileId === collection.activeProfileId,
      )
      if (profile === undefined)
        throw new CaptureProfileNotFoundError(collection.activeProfileId)
      return { collectionRevision: collection.revision, profile }
    })
  }

  async activate(
    userId: string,
    profileId: string,
    expectedRevision?: number,
  ): Promise<CaptureProfileCollectionStatus> {
    const validatedProfileId = CaptureProfileIdSchema.parse(profileId)
    return this.mutate(userId, expectedRevision, (collection) => {
      requireProfileIndex(collection, validatedProfileId)
      if (collection.activeProfileId === validatedProfileId) return collection
      return this.reviseCollection(collection, collection.profiles, validatedProfileId)
    })
  }

  async rename(
    userId: string,
    profileId: string,
    profileName: string,
    expectedRevision?: number,
  ): Promise<CaptureProfileCollectionStatus> {
    const validatedProfileId = CaptureProfileIdSchema.parse(profileId)
    const validatedProfileName = CaptureProfileNameSchema.parse(profileName)
    return this.mutate(userId, expectedRevision, (collection) => {
      const index = requireProfileIndex(collection, validatedProfileId)
      assertUniqueProfileName(
        collection.profiles,
        validatedProfileName,
        validatedProfileId,
      )
      const previous = collection.profiles[index]
      if (previous === undefined)
        throw new CaptureProfileNotFoundError(validatedProfileId)
      if (previous.profileName === validatedProfileName) return collection
      const profiles = [...collection.profiles]
      profiles[index] = {
        ...previous,
        profileName: validatedProfileName,
        updatedAt: this.timestamp(),
      }
      return this.reviseCollection(collection, profiles)
    })
  }

  async duplicate(
    userId: string,
    profileId: string,
    profileName: string,
    expectedRevision?: number,
    requestedProfileId?: string,
  ): Promise<CaptureProfileCollectionStatus> {
    const validatedProfileId = CaptureProfileIdSchema.parse(profileId)
    const validatedProfileName = CaptureProfileNameSchema.parse(profileName)
    return this.mutate(userId, expectedRevision, (collection) => {
      if (collection.profiles.length >= MAX_CAPTURE_PROFILES) {
        throw new CaptureProfileLimitError()
      }
      const source =
        collection.profiles[requireProfileIndex(collection, validatedProfileId)]
      if (source === undefined) throw new CaptureProfileNotFoundError(validatedProfileId)
      assertUniqueProfileName(collection.profiles, validatedProfileName)
      const duplicateProfileId = CaptureProfileIdSchema.parse(
        requestedProfileId ?? this.createProfileId(),
      )
      if (
        collection.profiles.some((profile) => profile.profileId === duplicateProfileId)
      ) {
        throw new Error('Generated capture profile ID already exists')
      }
      const timestamp = this.timestamp()
      return this.reviseCollection(collection, [
        ...collection.profiles,
        {
          profileId: duplicateProfileId,
          profileName: validatedProfileName,
          createdAt: timestamp,
          updatedAt: timestamp,
          configuration: source.configuration,
        },
      ])
    })
  }

  async delete(
    userId: string,
    profileId: string,
    expectedRevision?: number,
  ): Promise<CaptureProfileCollectionStatus> {
    const validatedProfileId = CaptureProfileIdSchema.parse(profileId)
    return this.mutate(userId, expectedRevision, (collection) => {
      requireProfileIndex(collection, validatedProfileId)
      if (collection.profiles.length === 1)
        throw new CannotDeleteLastCaptureProfileError()
      const profiles = collection.profiles.filter(
        (profile) => profile.profileId !== validatedProfileId,
      )
      const activeProfileId =
        collection.activeProfileId === validatedProfileId
          ? profiles[0]?.profileId
          : collection.activeProfileId
      if (activeProfileId === undefined) throw new CannotDeleteLastCaptureProfileError()
      return this.reviseCollection(collection, profiles, activeProfileId)
    })
  }

  async rebind(
    userId: string,
    profileId: string,
    source: CapturePreference,
    expectedRevision?: number,
    frameSize?: PixelSize,
  ): Promise<CaptureProfileCollectionStatus> {
    const validatedProfileId = CaptureProfileIdSchema.parse(profileId)
    const validatedSource = CapturePreferenceSchema.parse(source)
    return this.mutate(userId, expectedRevision, (collection) => {
      const index = requireProfileIndex(collection, validatedProfileId)
      const profile = collection.profiles[index]
      if (profile === undefined) throw new CaptureProfileNotFoundError(validatedProfileId)
      const updatedConfiguration = signConfiguration({
        schemaVersion: profile.configuration.schemaVersion,
        userId: profile.configuration.userId,
        revision: profile.configuration.revision + 1,
        committedAt: this.timestamp(),
        source: validatedSource,
        frameSize: frameSize ?? profile.configuration.frameSize,
        regions: profile.configuration.regions,
        triggerProfile: profile.configuration.triggerProfile,
      })
      const profiles = [...collection.profiles]
      profiles[index] = {
        ...profile,
        updatedAt: updatedConfiguration.committedAt,
        configuration: updatedConfiguration,
      }
      return this.reviseCollection(collection, profiles)
    })
  }

  async update(
    userId: string,
    profileId: string,
    configuration: CaptureConfiguration,
    expectedRevision?: number,
  ): Promise<CaptureProfileCollectionStatus> {
    const validatedProfileId = CaptureProfileIdSchema.parse(profileId)
    const validatedConfiguration = validateConfiguration(configuration)
    if (validatedConfiguration.userId !== userId) {
      throw new Error('Capture configuration userId does not match repository userId')
    }
    return this.mutate(userId, expectedRevision, (collection) => {
      const index = requireProfileIndex(collection, validatedProfileId)
      const profile = collection.profiles[index]
      if (profile === undefined) throw new CaptureProfileNotFoundError(validatedProfileId)
      const profiles = [...collection.profiles]
      profiles[index] = {
        ...profile,
        updatedAt: this.timestamp(),
        configuration: validatedConfiguration,
      }
      return this.reviseCollection(collection, profiles)
    })
  }

  private async mutate(
    userId: string,
    expectedRevision: number | undefined,
    operation: (collection: CaptureProfileCollection) => CaptureProfileCollection,
  ): Promise<CaptureProfileCollectionStatus> {
    return this.serialized(async () => {
      const collection = await this.readOrMigrate(userId)
      if (collection === null) throw new CaptureProfileNotFoundError('active')
      assertExpectedRevision(collection, expectedRevision)
      const updated = operation(collection)
      if (updated !== collection) await this.writeCollection(updated)
      return collectionStatus(updated)
    })
  }

  private reviseCollection(
    collection: CaptureProfileCollection,
    profiles: readonly CaptureProfile[],
    activeProfileId = collection.activeProfileId,
  ): CaptureProfileCollection {
    return signCollection({
      schemaVersion: 2,
      userId: collection.userId,
      revision: collection.revision + 1,
      activeProfileId,
      profiles: [...profiles],
    })
  }

  private async readOrMigrate(userId: string): Promise<CaptureProfileCollection | null> {
    const profileContent = await this.readOptional(
      join(this.directory, profileUserFileName(userId)),
    )
    if (profileContent !== null) {
      try {
        const collection = validateCollection(
          CaptureProfileCollectionSchema.parse(JSON.parse(profileContent) as unknown),
        )
        if (collection.userId !== userId) {
          throw new Error('Capture profile collection userId does not match its file')
        }
        return collection
      } catch (error) {
        throw new CaptureProfileStoreCorruptError(userId, 'profile store', error)
      }
    }

    const legacyContent = await this.readOptional(
      join(this.legacyDirectory, legacyUserFileName(userId)),
    )
    if (legacyContent === null) return null

    let configuration: CaptureConfiguration
    try {
      configuration = validateConfiguration(
        CaptureConfigurationSchema.parse(JSON.parse(legacyContent) as unknown),
      )
      if (configuration.userId !== userId) {
        throw new Error('Legacy capture configuration userId does not match its file')
      }
    } catch (error) {
      throw new CaptureProfileStoreCorruptError(userId, 'legacy configuration', error)
    }

    const profileId = migratedCaptureProfileId(userId)
    const migrated = signCollection({
      schemaVersion: 2,
      userId,
      revision: 1,
      activeProfileId: profileId,
      profiles: [
        {
          profileId,
          profileName: DEFAULT_CAPTURE_PROFILE_NAME,
          createdAt: configuration.committedAt,
          updatedAt: configuration.committedAt,
          configuration,
        },
      ],
    })
    await this.writeCollection(migrated)
    return migrated
  }

  private async readOptional(path: string): Promise<string | null> {
    try {
      return await this.fs.readFile(path, 'utf8')
    } catch (error) {
      if (fileNotFound(error)) return null
      throw error
    }
  }

  private async writeCollection(collection: CaptureProfileCollection): Promise<void> {
    const validated = validateCollection(collection)
    await this.fs.mkdir(this.directory, { recursive: true })
    const destination = join(this.directory, profileUserFileName(validated.userId))
    const temporary = `${destination}.${randomUUID()}.tmp`
    try {
      await this.fs.writeFile(
        temporary,
        `${JSON.stringify(validated, null, 2)}\n`,
        'utf8',
      )
      await this.fs.rename(temporary, destination)
    } catch (error) {
      await this.fs.rm(temporary, { force: true })
      throw error
    }
  }

  private timestamp(): string {
    return this.now().toISOString()
  }

  private async serialized<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.mutationQueue.then(operation, operation)
    this.mutationQueue = result.then(
      () => undefined,
      () => undefined,
    )
    return result
  }
}
