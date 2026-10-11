import { mkdir, stat, appendFile, rename, rm } from 'node:fs/promises'
import { join } from 'node:path'
import type { LogRecord } from './structured-logger'

/** Serialized, bounded diagnostics; disk failures are deliberately non-fatal. */
export class RotatingLogSink {
  #pendingBytes = 0
  #queue: Promise<void> = Promise.resolve()
  #dropped = 0
  #failedWrites = 0
  #reportedDropped = 0
  #reportedFailedWrites = 0
  constructor(
    readonly directory: string,
    private readonly maxBytes = 1024 * 1024,
    private readonly files = 5,
  ) {}

  get droppedRecords(): number {
    return this.#dropped
  }
  get failedWrites(): number {
    return this.#failedWrites
  }

  write = (record: LogRecord): void => {
    const line = `${JSON.stringify(record)}\n`
    const bytes = Buffer.byteLength(line)
    if (bytes > this.maxBytes || this.#pendingBytes + bytes > this.maxBytes) {
      this.#dropped = Math.min(Number.MAX_SAFE_INTEGER, this.#dropped + 1)
      return
    }
    this.#pendingBytes += bytes
    this.#queue = this.#queue
      .then(async () => {
        await this.append(line)
        await this.reportLosses()
      })
      .catch(() => {
        this.#failedWrites = Math.min(Number.MAX_SAFE_INTEGER, this.#failedWrites + 1)
      })
      .finally(() => {
        this.#pendingBytes -= bytes
      })
  }

  private async append(line: string): Promise<void> {
    const bytes = Buffer.byteLength(line)
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
      await rm(join(this.directory, `diagnostics.${this.files - 1}.log`), { force: true })
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
  }

  private async reportLosses(): Promise<void> {
    if (
      this.#dropped === this.#reportedDropped &&
      this.#failedWrites === this.#reportedFailedWrites
    )
      return
    const dropped = this.#dropped
    const failedWrites = this.#failedWrites
    const line = `${JSON.stringify({ timestamp: new Date().toISOString(), level: 'warn', message: 'Diagnostic records lost', context: { dropped, failedWrites } })}\n`
    if (Buffer.byteLength(line) > this.maxBytes) return
    await this.append(line)
    this.#reportedDropped = dropped
    this.#reportedFailedWrites = failedWrites
  }

  async flush(): Promise<void> {
    this.#queue = this.#queue
      .then(() => this.reportLosses())
      .catch(() => {
        this.#failedWrites = Math.min(Number.MAX_SAFE_INTEGER, this.#failedWrites + 1)
      })
    await this.#queue
  }
}
