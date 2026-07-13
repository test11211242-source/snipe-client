import { randomUUID } from 'node:crypto'
import { promises as nodeFs } from 'node:fs'
import { dirname } from 'node:path'

import { z } from 'zod'

import { ApplicationError } from '../../../shared/errors/application-error'

const SecretFileSchema = z
  .object({
    version: z.literal(1),
    ciphertext: z.string().min(1).max(65_536),
  })
  .strict()

export interface SecretCryptoAdapter {
  isEncryptionAvailable: () => boolean
  encryptString: (value: string) => Buffer
  decryptString: (value: Buffer) => string
}

export interface SecretFileSystem {
  readFile: (path: string, encoding: 'utf8') => Promise<string>
  writeFile: (
    path: string,
    data: string,
    options: { encoding: 'utf8'; mode: number },
  ) => Promise<void>
  rename: (oldPath: string, newPath: string) => Promise<void>
  mkdir: (path: string, options: { recursive: true }) => Promise<unknown>
  rm: (path: string, options: { force: true }) => Promise<void>
}

export const nodeSecretFileSystem: SecretFileSystem = {
  readFile: (path, encoding) => nodeFs.readFile(path, encoding),
  writeFile: (path, data, options) => nodeFs.writeFile(path, data, options),
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

export class SecretStore {
  constructor(
    private readonly filePath: string,
    private readonly crypto: SecretCryptoAdapter,
    private readonly fs: SecretFileSystem = nodeSecretFileSystem,
  ) {}

  async loadRefreshToken(): Promise<string | null> {
    let content: string
    try {
      content = await this.fs.readFile(this.filePath, 'utf8')
    } catch (error) {
      if (isFileNotFound(error)) return null
      throw new ApplicationError(
        'SECRET_READ_FAILED',
        'Не удалось прочитать данные входа',
        {
          cause: error,
        },
      )
    }

    this.assertEncryptionAvailable()
    try {
      const file = SecretFileSchema.parse(JSON.parse(content) as unknown)
      const token = this.crypto.decryptString(Buffer.from(file.ciphertext, 'base64'))
      if (token.length === 0 || token.length > 16_384)
        throw new Error('Invalid token length')
      return token
    } catch (cause) {
      throw new ApplicationError(
        'SECRET_INVALID',
        'Сохранённые данные входа повреждены. Выполните вход заново.',
        { cause },
      )
    }
  }

  async saveRefreshToken(refreshToken: string): Promise<void> {
    this.assertEncryptionAvailable()
    if (refreshToken.length === 0 || refreshToken.length > 16_384) {
      throw new ApplicationError('SECRET_INVALID', 'Некорректный refresh token')
    }

    const encrypted = this.crypto.encryptString(refreshToken)
    const content = `${JSON.stringify({
      version: 1,
      ciphertext: encrypted.toString('base64'),
    })}\n`
    const temporaryPath = `${this.filePath}.${randomUUID()}.tmp`
    await this.fs.mkdir(dirname(this.filePath), { recursive: true })
    try {
      await this.fs.writeFile(temporaryPath, content, { encoding: 'utf8', mode: 0o600 })
      await this.fs.rename(temporaryPath, this.filePath)
    } catch (cause) {
      await this.fs.rm(temporaryPath, { force: true })
      throw new ApplicationError(
        'SECRET_WRITE_FAILED',
        'Не удалось безопасно сохранить данные входа',
        { cause },
      )
    }
  }

  async clear(): Promise<void> {
    await this.fs.rm(this.filePath, { force: true })
  }

  private assertEncryptionAvailable(): void {
    if (!this.crypto.isEncryptionAvailable()) {
      throw new ApplicationError(
        'SECRET_UNAVAILABLE',
        'Защищённое хранилище Windows недоступно. Перезапустите приложение в обычном сеансе Windows.',
      )
    }
  }
}
