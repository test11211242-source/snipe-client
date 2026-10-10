import { promises as fs } from 'node:fs'
import { dirname } from 'node:path'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'

const MainWindowStateSchema = z
  .object({
    schemaVersion: z.literal(1),
    x: z.number().int().min(-32_768).max(32_767),
    y: z.number().int().min(-32_768).max(32_767),
    width: z.number().int().min(1).max(16_384),
    height: z.number().int().min(1).max(16_384),
    maximized: z.boolean(),
  })
  .strict()
export type MainWindowState = z.infer<typeof MainWindowStateSchema>

export class MainWindowStateRepository {
  #mutation: Promise<void> = Promise.resolve()
  constructor(private readonly filePath: string) {}

  async load(): Promise<MainWindowState | null> {
    try {
      return MainWindowStateSchema.parse(
        JSON.parse(await fs.readFile(this.filePath, 'utf8')),
      )
    } catch (error) {
      if (
        typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        error.code === 'ENOENT'
      )
        return null
      throw error
    }
  }

  save(rawState: MainWindowState): Promise<void> {
    const state = MainWindowStateSchema.parse(rawState)
    const operation = this.#mutation.then(async () => {
      await fs.mkdir(dirname(this.filePath), { recursive: true })
      const temporary = `${this.filePath}.${randomUUID()}.tmp`
      try {
        await fs.writeFile(temporary, `${JSON.stringify(state)}\n`, 'utf8')
        await fs.rename(temporary, this.filePath)
      } catch (error) {
        await fs.rm(temporary, { force: true })
        throw error
      }
    })
    this.#mutation = operation.catch(() => undefined)
    return operation
  }
}
