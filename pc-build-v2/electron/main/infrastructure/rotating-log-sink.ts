import { mkdir, stat, appendFile, rename, rm } from 'node:fs/promises'
import { join } from 'node:path'
import type { LogRecord } from './structured-logger'

/** Serialized, bounded diagnostics; disk failures are deliberately non-fatal. */
export class RotatingLogSink {
  #pendingBytes = 0
  #queue: Promise<void> = Promise.resolve()
  constructor(
    readonly directory: string,
    private readonly maxBytes = 1024 * 1024,
    private readonly files = 5,
  ) {}

  write = (record: LogRecord): void => {
    const line = `${JSON.stringify(record)}\n`
    const bytes = Buffer.byteLength(line)
    if (bytes > this.maxBytes || this.#pendingBytes + bytes > this.maxBytes) return
    this.#pendingBytes += bytes
    this.#queue = this.#queue
      .then(async () => {
        await mkdir(this.directory, { recursive: true })
        const current = join(this.directory, 'diagnostics.log')
        const size = await stat(current)
          .then((entry) => entry.size)
          .catch((error: unknown) => {
            if (
              error !== null &&
              typeof error === 'object' &&
              'code' in error &&
              error.code === 'ENOENT'
            )
              return 0
            throw error
          })
        if (size + bytes > this.maxBytes) {
          await rm(join(this.directory, `diagnostics.${this.files - 1}.log`), {
            force: true,
          })
          for (let index = this.files - 2; index >= 0; index -= 1) {
            const from =
              index === 0 ? current : join(this.directory, `diagnostics.${index}.log`)
            const to = join(this.directory, `diagnostics.${index + 1}.log`)
            await rename(from, to).catch((error: unknown) => {
              if (
                error !== null &&
                typeof error === 'object' &&
                'code' in error &&
                error.code === 'ENOENT'
              )
                return
              throw error
            })
          }
        }
        await appendFile(current, line, 'utf8')
      })
      .catch(() => undefined)
      .finally(() => {
        this.#pendingBytes -= bytes
      })
  }

  async flush(): Promise<void> {
    await this.#queue
  }
}
