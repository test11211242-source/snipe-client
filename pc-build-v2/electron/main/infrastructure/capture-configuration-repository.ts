import { createHash, randomUUID } from 'node:crypto'
import { promises as nodeFs } from 'node:fs'
import { join } from 'node:path'

import {
  CaptureConfigurationSchema,
  type CaptureConfiguration,
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

function fileNotFound(error: unknown): boolean {
  return (
    error !== null &&
    typeof error === 'object' &&
    'code' in error &&
    error.code === 'ENOENT'
  )
}

function userFileName(userId: string): string {
  return `${createHash('sha256').update(userId).digest('hex')}.json`
}

export function captureConfigurationFingerprint(
  config: Omit<CaptureConfiguration, 'fingerprint'>,
): string {
  return createHash('sha256').update(JSON.stringify(config)).digest('hex')
}

export class CaptureConfigurationRepository {
  constructor(
    private readonly directory: string,
    private readonly fs: CaptureConfigurationFileSystem = nodeCaptureConfigurationFileSystem,
  ) {}

  async load(userId: string): Promise<CaptureConfiguration | null> {
    try {
      const content = await this.fs.readFile(
        join(this.directory, userFileName(userId)),
        'utf8',
      )
      const parsed = CaptureConfigurationSchema.parse(JSON.parse(content) as unknown)
      if (parsed.userId !== userId) return null
      const { fingerprint, ...unsigned } = parsed
      return captureConfigurationFingerprint(unsigned) === fingerprint ? parsed : null
    } catch (error) {
      if (fileNotFound(error)) return null
      throw error
    }
  }

  async save(config: CaptureConfiguration): Promise<void> {
    const validated = CaptureConfigurationSchema.parse(config)
    const { fingerprint, ...unsigned } = validated
    if (captureConfigurationFingerprint(unsigned) !== fingerprint) {
      throw new Error('Capture configuration fingerprint is invalid')
    }
    await this.fs.mkdir(this.directory, { recursive: true })
    const destination = join(this.directory, userFileName(validated.userId))
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
}
