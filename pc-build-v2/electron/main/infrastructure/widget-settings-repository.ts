import { createHash, randomUUID } from 'node:crypto'
import { promises as nodeFs } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'

import {
  WIDGET_DECK_HEIGHT,
  WIDGET_DECK_WIDTH,
  WidgetBoundsSchema,
  WidgetSettingsSchema,
  type WidgetSettings,
} from '../../../shared/models/widget'

export interface WidgetSettingsFileSystem {
  readFile: (path: string, encoding: 'utf8') => Promise<string>
  writeFile: (path: string, data: string, encoding: 'utf8') => Promise<void>
  rename: (oldPath: string, newPath: string) => Promise<void>
  mkdir: (path: string, options: { recursive: true }) => Promise<unknown>
  rm: (path: string, options: { force: true }) => Promise<void>
}

export const nodeWidgetSettingsFileSystem: WidgetSettingsFileSystem = {
  readFile: (path, encoding) => nodeFs.readFile(path, encoding),
  writeFile: (path, data, encoding) => nodeFs.writeFile(path, data, encoding),
  rename: (oldPath, newPath) => nodeFs.rename(oldPath, newPath),
  mkdir: (path, options) => nodeFs.mkdir(path, options),
  rm: (path, options) => nodeFs.rm(path, options),
}

export const DEFAULT_WIDGET_SETTINGS: WidgetSettings = Object.freeze({
  autoOpen: true,
  alwaysOnTop: true,
  locked: false,
  opacity: 0.96,
  displayMode: 'deck',
  bounds: {
    x: null,
    y: null,
    width: WIDGET_DECK_WIDTH,
    height: WIDGET_DECK_HEIGHT,
  },
})

const LegacyWidgetSettingsSchema = z
  .object({
    autoOpen: z.boolean(),
    alwaysOnTop: z.boolean(),
    locked: z.boolean(),
    opacity: z.number().min(0.55).max(1),
    compactMode: z.boolean(),
    bounds: WidgetBoundsSchema,
  })
  .strict()

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

export class WidgetSettingsRepository {
  constructor(
    private readonly directory: string,
    private readonly fs: WidgetSettingsFileSystem = nodeWidgetSettingsFileSystem,
  ) {}

  async load(userId: string): Promise<WidgetSettings> {
    try {
      const value = await this.fs.readFile(join(this.directory, fileName(userId)), 'utf8')
      const raw = JSON.parse(value) as unknown
      const current = WidgetSettingsSchema.safeParse(raw)
      if (current.success) return current.data
      const legacy = LegacyWidgetSettingsSchema.parse(raw)
      const migrated = WidgetSettingsSchema.parse({
        autoOpen: legacy.autoOpen,
        alwaysOnTop: legacy.alwaysOnTop,
        locked: legacy.locked,
        opacity: legacy.opacity,
        displayMode: 'deck',
        bounds: {
          x: legacy.bounds.x,
          y: legacy.bounds.y,
          width: WIDGET_DECK_WIDTH,
          height: WIDGET_DECK_HEIGHT,
        },
      })
      return await this.save(userId, migrated)
    } catch (error) {
      if (isMissing(error)) return structuredClone(DEFAULT_WIDGET_SETTINGS)
      throw error
    }
  }

  async save(userId: string, value: WidgetSettings): Promise<WidgetSettings> {
    const settings = WidgetSettingsSchema.parse(value)
    await this.fs.mkdir(this.directory, { recursive: true })
    const destination = join(this.directory, fileName(userId))
    const temporary = `${destination}.${randomUUID()}.tmp`
    try {
      await this.fs.writeFile(temporary, `${JSON.stringify(settings, null, 2)}\n`, 'utf8')
      await this.fs.rename(temporary, destination)
    } catch (error) {
      await this.fs.rm(temporary, { force: true })
      throw error
    }
    return settings
  }
}
