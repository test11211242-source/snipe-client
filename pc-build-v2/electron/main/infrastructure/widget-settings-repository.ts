import { createHash, randomUUID } from 'node:crypto'
import { promises as nodeFs } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'

import {
  WIDGET_DETAILED_HEIGHT,
  WIDGET_DETAILED_WIDTH,
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
  displayMode: 'detailed',
  normalWidth: WIDGET_DECK_WIDTH,
  compactWidth: 520,
  compactMode: false,
  bounds: {
    x: null,
    y: null,
    width: WIDGET_DECK_WIDTH,
    height: WIDGET_DETAILED_HEIGHT,
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
    private readonly legacyDirectory?: string,
  ) {}

  async load(userId: string): Promise<WidgetSettings> {
    const source = join(this.directory, fileName(userId))
    let value: string
    try {
      try {
        value = await this.fs.readFile(source, 'utf8')
      } catch (error) {
        if (!isMissing(error) || this.legacyDirectory === undefined) throw error
        const bytes = await this.fs.readFile(
          join(this.legacyDirectory, fileName(userId)),
          'utf8',
        )
        let old: unknown
        try {
          old = JSON.parse(bytes) as unknown
        } catch {
          return structuredClone(DEFAULT_WIDGET_SETTINGS)
        }
        const parsed = WidgetSettingsSchema.omit({
          normalWidth: true,
          compactWidth: true,
          compactMode: true,
        }).safeParse(old)
        if (!parsed.success) return structuredClone(DEFAULT_WIDGET_SETTINGS)
        const oldSettings = parsed.data
        return await this.save(userId, {
          ...oldSettings,
          normalWidth: oldSettings.bounds.width,
          compactWidth: 520,
          compactMode: false,
        })
      }
    } catch (error) {
      if (isMissing(error)) return structuredClone(DEFAULT_WIDGET_SETTINGS)
      throw error
    }

    let raw: unknown
    try {
      raw = JSON.parse(value) as unknown
    } catch {
      await this.quarantine(source)
      return structuredClone(DEFAULT_WIDGET_SETTINGS)
    }
    const current = z
      .object({ schemaVersion: z.literal(3), settings: WidgetSettingsSchema })
      .strict()
      .safeParse(raw)
    if (current.success) return current.data.settings
    const legacy = LegacyWidgetSettingsSchema.safeParse(raw)
    if (legacy.success) {
      return this.save(userId, {
        autoOpen: legacy.data.autoOpen,
        alwaysOnTop: legacy.data.alwaysOnTop,
        locked: legacy.data.locked,
        opacity: legacy.data.opacity,
        displayMode: legacy.data.compactMode ? 'deck' : 'detailed',
        normalWidth: legacy.data.compactMode ? WIDGET_DECK_WIDTH : WIDGET_DETAILED_WIDTH,
        compactWidth: 520,
        compactMode: false,
        bounds: {
          x: legacy.data.bounds.x,
          y: legacy.data.bounds.y,
          width: legacy.data.compactMode ? WIDGET_DECK_WIDTH : WIDGET_DETAILED_WIDTH,
          height: legacy.data.compactMode ? WIDGET_DECK_HEIGHT : WIDGET_DETAILED_HEIGHT,
        },
      })
    }
    await this.quarantine(source)
    return structuredClone(DEFAULT_WIDGET_SETTINGS)
  }

  async save(userId: string, value: WidgetSettings): Promise<WidgetSettings> {
    const settings = WidgetSettingsSchema.parse(value)
    await this.fs.mkdir(this.directory, { recursive: true })
    const destination = join(this.directory, fileName(userId))
    const temporary = `${destination}.${randomUUID()}.tmp`
    try {
      await this.fs.writeFile(
        temporary,
        `${JSON.stringify({ schemaVersion: 3, settings }, null, 2)}\n`,
        'utf8',
      )
      await this.fs.rename(temporary, destination)
    } catch (error) {
      await this.fs.rm(temporary, { force: true })
      throw error
    }
    return settings
  }

  private async quarantine(source: string): Promise<void> {
    await this.fs.rename(source, `${source}.invalid-${Date.now()}-${randomUUID()}`)
  }
}
