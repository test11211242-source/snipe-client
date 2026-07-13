import { createHash, randomUUID } from 'node:crypto'
import { promises as nodeFs } from 'node:fs'
import { join } from 'node:path'

import {
  PredictionPreferencesSchema,
  type PredictionPreferences,
} from '../../../shared/models/streamer'

export const DEFAULT_PREDICTION_PREFERENCES: PredictionPreferences = Object.freeze({
  predictionType: 'win_lose',
  predictionWindow: 60,
  winStreakCount: 2,
  delayBetweenPredictions: 5,
  autoCreateNext: true,
})

export interface PredictionPreferencesFileSystem {
  readFile: (path: string, encoding: 'utf8') => Promise<string>
  writeFile: (path: string, data: string, encoding: 'utf8') => Promise<void>
  rename: (from: string, to: string) => Promise<void>
  mkdir: (path: string, options: { recursive: true }) => Promise<unknown>
  rm: (path: string, options: { force: true }) => Promise<void>
}

export const nodePredictionPreferencesFileSystem: PredictionPreferencesFileSystem = {
  readFile: (path, encoding) => nodeFs.readFile(path, encoding),
  writeFile: (path, data, encoding) => nodeFs.writeFile(path, data, encoding),
  rename: (from, to) => nodeFs.rename(from, to),
  mkdir: (path, options) => nodeFs.mkdir(path, options),
  rm: (path, options) => nodeFs.rm(path, options),
}

function pathFor(directory: string, userId: string): string {
  return join(directory, `${createHash('sha256').update(userId).digest('hex')}.json`)
}

export class PredictionPreferencesRepository {
  constructor(
    private readonly directory: string,
    private readonly fs: PredictionPreferencesFileSystem = nodePredictionPreferencesFileSystem,
  ) {}

  async load(userId: string): Promise<PredictionPreferences> {
    try {
      const value: unknown = JSON.parse(
        await this.fs.readFile(pathFor(this.directory, userId), 'utf8'),
      ) as unknown
      return PredictionPreferencesSchema.parse(value)
    } catch (error) {
      if (
        error !== null &&
        typeof error === 'object' &&
        'code' in error &&
        error.code === 'ENOENT'
      ) {
        return { ...DEFAULT_PREDICTION_PREFERENCES }
      }
      throw error
    }
  }

  async save(
    userId: string,
    value: PredictionPreferences,
  ): Promise<PredictionPreferences> {
    const parsed = PredictionPreferencesSchema.parse(value)
    await this.fs.mkdir(this.directory, { recursive: true })
    const destination = pathFor(this.directory, userId)
    const temporary = `${destination}.${randomUUID()}.tmp`
    try {
      await this.fs.writeFile(temporary, `${JSON.stringify(parsed, null, 2)}\n`, 'utf8')
      await this.fs.rename(temporary, destination)
    } catch (error) {
      await this.fs.rm(temporary, { force: true })
      throw error
    }
    return parsed
  }
}
