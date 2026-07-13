import { randomUUID } from 'node:crypto'
import { promises as nodeFs } from 'node:fs'
import { dirname } from 'node:path'

import { z } from 'zod'

import type { StructuredLogger } from './structured-logger'

export const SETTINGS_VERSION = 1 as const

export const SettingsSchema = z
  .object({
    version: z.literal(SETTINGS_VERSION),
    appearance: z
      .object({
        theme: z.literal('operational-dark'),
        reducedMotion: z.boolean(),
      })
      .strict(),
    application: z
      .object({
        launchAtStartup: z.boolean(),
        diagnosticsEnabled: z.boolean(),
      })
      .strict(),
  })
  .strict()

const SettingsV0Schema = z
  .object({
    version: z.literal(0),
    startWithWindows: z.boolean().default(false),
    reduceMotion: z.boolean().default(false),
  })
  .strict()

export type Settings = z.infer<typeof SettingsSchema>

export function createDefaultSettings(): Settings {
  return {
    version: SETTINGS_VERSION,
    appearance: {
      theme: 'operational-dark',
      reducedMotion: false,
    },
    application: {
      launchAtStartup: false,
      diagnosticsEnabled: false,
    },
  }
}

export function parseAndMigrateSettings(input: unknown): Settings {
  const version = z.looseObject({ version: z.number().int() }).parse(input).version

  if (version === 0) {
    const legacy = SettingsV0Schema.parse(input)
    return SettingsSchema.parse({
      ...createDefaultSettings(),
      appearance: {
        theme: 'operational-dark',
        reducedMotion: legacy.reduceMotion,
      },
      application: {
        launchAtStartup: legacy.startWithWindows,
        diagnosticsEnabled: false,
      },
    })
  }

  return SettingsSchema.parse(input)
}

export interface SettingsFileSystem {
  readFile: (path: string, encoding: 'utf8') => Promise<string>
  writeFile: (path: string, data: string, encoding: 'utf8') => Promise<void>
  rename: (oldPath: string, newPath: string) => Promise<void>
  mkdir: (path: string, options: { recursive: true }) => Promise<unknown>
  rm: (path: string, options: { force: true }) => Promise<void>
}

export const nodeSettingsFileSystem: SettingsFileSystem = {
  readFile: (path, encoding) => nodeFs.readFile(path, encoding),
  writeFile: (path, data, encoding) => nodeFs.writeFile(path, data, encoding),
  rename: (oldPath, newPath) => nodeFs.rename(oldPath, newPath),
  mkdir: (path, options) => nodeFs.mkdir(path, options),
  rm: (path, options) => nodeFs.rm(path, options),
}

function isFileNotFound(error: unknown): boolean {
  return (
    error !== null &&
    typeof error === 'object' &&
    'code' in error &&
    error.code === 'ENOENT'
  )
}

export class SettingsRepository {
  constructor(
    private readonly filePath: string,
    private readonly logger: StructuredLogger,
    private readonly fs: SettingsFileSystem = nodeSettingsFileSystem,
  ) {}

  async load(): Promise<Settings> {
    try {
      const content = await this.fs.readFile(this.filePath, 'utf8')
      return parseAndMigrateSettings(JSON.parse(content) as unknown)
    } catch (error) {
      if (!isFileNotFound(error)) {
        this.logger.warn('Settings could not be loaded; defaults are active', { error })
      }
      return createDefaultSettings()
    }
  }

  async save(settings: Settings): Promise<void> {
    const validated = SettingsSchema.parse(settings)
    const temporaryPath = `${this.filePath}.${randomUUID()}.tmp`
    await this.fs.mkdir(dirname(this.filePath), { recursive: true })

    try {
      await this.fs.writeFile(
        temporaryPath,
        `${JSON.stringify(validated, null, 2)}\n`,
        'utf8',
      )
      await this.fs.rename(temporaryPath, this.filePath)
    } catch (error) {
      await this.fs.rm(temporaryPath, { force: true })
      throw error
    }
  }
}
