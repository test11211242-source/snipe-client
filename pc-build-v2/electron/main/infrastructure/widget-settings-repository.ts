import { createHash, randomUUID } from 'node:crypto'
import { promises as nodeFs } from 'node:fs'
import { join } from 'node:path'

import { WidgetSettingsSchema, type WidgetSettings } from '../../../shared/models/widget'

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
  compactMode: false,
  bounds: { x: null, y: null, width: 420, height: 560 },
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

export class WidgetSettingsRepository {
  constructor(
    private readonly directory: string,
    private readonly fs: WidgetSettingsFileSystem = nodeWidgetSettingsFileSystem,
  ) {}

  async load(userId: string): Promise<WidgetSettings> {
    try {
      const value = await this.fs.readFile(join(this.directory, fileName(userId)), 'utf8')
      return WidgetSettingsSchema.parse(JSON.parse(value) as unknown)
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
