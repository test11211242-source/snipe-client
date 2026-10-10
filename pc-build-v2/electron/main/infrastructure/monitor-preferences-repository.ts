import { createHash, randomUUID } from 'node:crypto'
import { promises as nodeFs } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'

import {
  MonitorPreferencesSchema,
  type MonitorPreferences,
} from '../../../shared/models/monitor'

export interface MonitorPreferencesFileSystem {
  readFile: (path: string, encoding: 'utf8') => Promise<string>
  writeFile: (path: string, data: string, encoding: 'utf8') => Promise<void>
  rename: (oldPath: string, newPath: string) => Promise<void>
  mkdir: (path: string, options: { recursive: true }) => Promise<unknown>
  rm: (path: string, options: { force: true }) => Promise<void>
}

export const nodeMonitorPreferencesFileSystem: MonitorPreferencesFileSystem = {
  readFile: (path, encoding) => nodeFs.readFile(path, encoding),
  writeFile: (path, data, encoding) => nodeFs.writeFile(path, data, encoding),
  rename: (oldPath, newPath) => nodeFs.rename(oldPath, newPath),
  mkdir: (path, options) => nodeFs.mkdir(path, options),
  rm: (path, options) => nodeFs.rm(path, options),
}

export const DEFAULT_MONITOR_PREFERENCES: MonitorPreferences = Object.freeze({
  deckMode: 'pol',
})

function fileName(userId: string): string {
  return `${createHash('sha256').update(userId).digest('hex')}.json`
}

function isMissing(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === 'ENOENT'
  )
}

export class MonitorPreferencesRepository {
  constructor(
    private readonly directory: string,
    private readonly fs: MonitorPreferencesFileSystem = nodeMonitorPreferencesFileSystem,
    private readonly legacyDirectory?: string,
  ) {}

  async load(userId: string): Promise<MonitorPreferences> {
    try {
      let value: string
      try {
        value = await this.fs.readFile(join(this.directory, fileName(userId)), 'utf8')
      } catch (error) {
        if (!isMissing(error) || this.legacyDirectory === undefined) throw error
        const legacy = z
          .object({
            searchMode: z.enum(['fast', 'precise']),
            deckMode: MonitorPreferencesSchema.shape.deckMode,
          })
          .strict()
          .parse(
            JSON.parse(
              await this.fs.readFile(
                join(this.legacyDirectory, fileName(userId)),
                'utf8',
              ),
            ),
          )
        return await this.save(userId, { deckMode: legacy.deckMode })
      }
      const stored = z
        .object({
          schemaVersion: z.literal(2),
          preferences: MonitorPreferencesSchema,
        })
        .strict()
        .parse(JSON.parse(value))
      return stored.preferences
    } catch (error) {
      if (isMissing(error)) return { ...DEFAULT_MONITOR_PREFERENCES }
      throw error
    }
  }

  async save(userId: string, value: MonitorPreferences): Promise<MonitorPreferences> {
    const preferences = MonitorPreferencesSchema.parse(value)
    await this.fs.mkdir(this.directory, { recursive: true })
    const destination = join(this.directory, fileName(userId))
    const temporary = `${destination}.${randomUUID()}.tmp`
    try {
      await this.fs.writeFile(
        temporary,
        `${JSON.stringify({ schemaVersion: 2, preferences }, null, 2)}\n`,
        'utf8',
      )
      await this.fs.rename(temporary, destination)
    } catch (error) {
      await this.fs.rm(temporary, { force: true })
      throw error
    }
    return preferences
  }
}
