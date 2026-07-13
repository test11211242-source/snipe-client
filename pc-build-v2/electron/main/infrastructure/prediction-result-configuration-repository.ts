import { createHash, randomUUID } from 'node:crypto'
import { promises as nodeFs } from 'node:fs'
import { join } from 'node:path'

import {
  PredictionResultConfigurationSchema,
  type PredictionResultConfiguration,
} from '../../../shared/models/prediction-result'

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

export function predictionResultFingerprint(
  value: Omit<PredictionResultConfiguration, 'fingerprint'>,
): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

export class PredictionResultConfigurationRepository {
  constructor(
    private readonly directory: string,
    private readonly fs: PredictionResultFileSystem = nodePredictionResultFileSystem,
  ) {}

  async load(userId: string): Promise<PredictionResultConfiguration | null> {
    try {
      const parsed = PredictionResultConfigurationSchema.parse(
        JSON.parse(
          await this.fs.readFile(join(this.directory, fileName(userId)), 'utf8'),
        ),
      )
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

  async save(value: PredictionResultConfiguration): Promise<void> {
    const parsed = PredictionResultConfigurationSchema.parse(value)
    const { fingerprint, ...unsigned } = parsed
    if (predictionResultFingerprint(unsigned) !== fingerprint)
      throw new Error('Result configuration fingerprint is invalid')
    await this.fs.mkdir(this.directory, { recursive: true })
    const destination = join(this.directory, fileName(parsed.userId))
    const temporary = `${destination}.${randomUUID()}.tmp`
    try {
      await this.fs.writeFile(temporary, `${JSON.stringify(parsed, null, 2)}\n`, 'utf8')
      await this.fs.rename(temporary, destination)
    } catch (error) {
      await this.fs.rm(temporary, { force: true })
      throw error
    }
  }
}
