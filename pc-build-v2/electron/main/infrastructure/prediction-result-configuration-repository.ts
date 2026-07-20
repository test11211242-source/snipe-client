import { createHash, randomUUID } from 'node:crypto'
import { promises as nodeFs } from 'node:fs'
import { join } from 'node:path'

import {
  PredictionResultConfigurationSchema,
  type PredictionResultConfiguration,
} from '../../../shared/models/prediction-result'
import { CaptureProfileIdSchema } from '../../../shared/models/capture'
import { migratedCaptureProfileId } from './capture-configuration-repository'
import { z } from 'zod'

export interface PredictionResultFileSystem {
  readFile: (path: string, encoding: 'utf8') => Promise<string>
  writeFile: (path: string, data: string, encoding: 'utf8') => Promise<void>
  rename: (from: string, to: string) => Promise<void>
  mkdir: (path: string, options: { recursive: true }) => Promise<unknown>
  rm: (path: string, options: { force: true }) => Promise<void>
}

export const nodePredictionResultFileSystem: PredictionResultFileSystem = {
  readFile: (path, encoding) => nodeFs.readFile(path, encoding),
  writeFile: (path, data, encoding) => nodeFs.writeFile(path, data, encoding),
  rename: (from, to) => nodeFs.rename(from, to),
  mkdir: (path, options) => nodeFs.mkdir(path, options),
  rm: (path, options) => nodeFs.rm(path, options),
}

const fileName = (userId: string): string =>
  `${createHash('sha256').update(userId).digest('hex')}.json`

const profileFileName = (userId: string, profileId: string): string =>
  `${createHash('sha256').update(userId).digest('hex')}.${CaptureProfileIdSchema.parse(profileId)}.json`

const migrationFileName = (userId: string): string =>
  `${createHash('sha256').update(userId).digest('hex')}.profiles-v2-migration.json`

const MigrationSchema = z
  .object({ schemaVersion: z.literal(1), profileId: CaptureProfileIdSchema })
  .strict()

export function predictionResultFingerprint(
  value: Omit<PredictionResultConfiguration, 'fingerprint'>,
): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

export class PredictionResultConfigurationRepository {
  #operation: Promise<void> = Promise.resolve()

  constructor(
    private readonly directory: string,
    private readonly fs: PredictionResultFileSystem = nodePredictionResultFileSystem,
  ) {}

  load(
    userId: string,
    profileId?: string,
  ): Promise<PredictionResultConfiguration | null> {
    return this.serialized(async () => {
      if (profileId === undefined) return this.readConfiguration(userId, fileName(userId))
      const validatedProfileId = CaptureProfileIdSchema.parse(profileId)
      const profileConfiguration = await this.readConfiguration(
        userId,
        profileFileName(userId, validatedProfileId),
      )
      if (profileConfiguration !== null) {
        if (profileConfiguration.captureProfileId !== validatedProfileId) return null
        if (
          validatedProfileId === migratedCaptureProfileId(userId) &&
          (await this.readMigration(userId)) === null
        ) {
          await this.writeMigration(userId, validatedProfileId)
        }
        return profileConfiguration
      }

      const migration = await this.readMigration(userId)
      if (migration !== null) return null
      if (validatedProfileId !== migratedCaptureProfileId(userId)) return null
      const legacy = await this.readConfiguration(userId, fileName(userId))
      if (legacy === null) return null
      await this.writeConfiguration(legacy, profileFileName(userId, validatedProfileId))
      await this.writeMigration(userId, validatedProfileId)
      return legacy
    })
  }

  save(value: PredictionResultConfiguration, profileId?: string): Promise<void> {
    return this.serialized(async () => {
      const parsed = this.validate(value)
      if (profileId !== undefined && parsed.captureProfileId !== profileId) {
        throw new Error('Result configuration capture profile is invalid')
      }
      const destination =
        profileId === undefined
          ? fileName(parsed.userId)
          : profileFileName(parsed.userId, CaptureProfileIdSchema.parse(profileId))
      await this.writeConfiguration(parsed, destination)
    })
  }

  delete(userId: string, profileId: string): Promise<void> {
    return this.serialized(async () => {
      await this.fs.rm(join(this.directory, profileFileName(userId, profileId)), {
        force: true,
      })
    })
  }

  private async readConfiguration(
    userId: string,
    name: string,
  ): Promise<PredictionResultConfiguration | null> {
    try {
      const raw: unknown = JSON.parse(
        await this.fs.readFile(join(this.directory, name), 'utf8'),
      )
      if (
        raw !== null &&
        typeof raw === 'object' &&
        'schemaVersion' in raw &&
        raw.schemaVersion === 1
      ) {
        return null
      }
      const parsed = PredictionResultConfigurationSchema.parse(raw)
      if (parsed.userId !== userId) return null
      const { fingerprint, ...unsigned } = parsed
      return predictionResultFingerprint(unsigned) === fingerprint ? parsed : null
    } catch (error) {
      if (
        error !== null &&
        typeof error === 'object' &&
        'code' in error &&
        error.code === 'ENOENT'
      )
        return null
      throw error
    }
  }

  private validate(value: PredictionResultConfiguration): PredictionResultConfiguration {
    const parsed = PredictionResultConfigurationSchema.parse(value)
    const { fingerprint, ...unsigned } = parsed
    if (predictionResultFingerprint(unsigned) !== fingerprint)
      throw new Error('Result configuration fingerprint is invalid')
    return parsed
  }

  private async writeConfiguration(
    value: PredictionResultConfiguration,
    name: string,
  ): Promise<void> {
    const parsed = this.validate(value)
    await this.fs.mkdir(this.directory, { recursive: true })
    const destination = join(this.directory, name)
    const temporary = `${destination}.${randomUUID()}.tmp`
    try {
      await this.fs.writeFile(temporary, `${JSON.stringify(parsed, null, 2)}\n`, 'utf8')
      await this.fs.rename(temporary, destination)
    } catch (error) {
      await this.fs.rm(temporary, { force: true })
      throw error
    }
  }

  private async readMigration(
    userId: string,
  ): Promise<z.infer<typeof MigrationSchema> | null> {
    try {
      return MigrationSchema.parse(
        JSON.parse(
          await this.fs.readFile(join(this.directory, migrationFileName(userId)), 'utf8'),
        ),
      )
    } catch (error) {
      if (this.fileNotFound(error)) return null
      throw error
    }
  }

  private async writeMigration(userId: string, profileId: string): Promise<void> {
    await this.fs.mkdir(this.directory, { recursive: true })
    const destination = join(this.directory, migrationFileName(userId))
    const temporary = `${destination}.${randomUUID()}.tmp`
    try {
      await this.fs.writeFile(
        temporary,
        `${JSON.stringify(MigrationSchema.parse({ schemaVersion: 1, profileId }), null, 2)}\n`,
        'utf8',
      )
      await this.fs.rename(temporary, destination)
    } catch (error) {
      await this.fs.rm(temporary, { force: true })
      throw error
    }
  }

  private fileNotFound(error: unknown): boolean {
    return (
      error !== null &&
      typeof error === 'object' &&
      'code' in error &&
      error.code === 'ENOENT'
    )
  }

  private serialized<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#operation.then(operation, operation)
    this.#operation = result.then(
      () => undefined,
      () => undefined,
    )
    return result
  }
}
