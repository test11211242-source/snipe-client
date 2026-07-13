import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { lstat, readFile, readdir } from 'node:fs/promises'
import { posix, resolve, win32 } from 'node:path'

import { z } from 'zod'

import { ApplicationError } from '../../../shared/errors/application-error'

const MAX_INVENTORY_BYTES = 2 * 1024 * 1024
const MAX_ENTRIES = 20_000
const MAX_FILE_BYTES = 512 * 1024 * 1024
const MAX_TOTAL_BYTES = 2 * 1024 * 1024 * 1024

const InventorySchema = z
  .object({
    schemaVersion: z.literal(1),
    root: z.literal('python-runtime'),
    files: z
      .array(
        z
          .object({
            path: z.string().min(1).max(500),
            size: z.number().int().nonnegative().max(MAX_FILE_BYTES),
            sha256: z.string().regex(/^[0-9a-f]{64}$/),
          })
          .strict(),
      )
      .min(1)
      .max(MAX_ENTRIES),
  })
  .strict()

function validRelativePath(path: string): boolean {
  return (
    path === posix.normalize(path) &&
    !posix.isAbsolute(path) &&
    !win32.isAbsolute(path) &&
    !path.includes('\\') &&
    !path.includes('\0') &&
    path.split('/').every((part) => part !== '' && part !== '.' && part !== '..')
  )
}

async function hashFile(path: string): Promise<string> {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer)
  return hash.digest('hex')
}

async function listRuntimeFiles(root: string): Promise<Set<string>> {
  const files = new Set<string>()
  let visited = 0
  const walk = async (directory: string, prefix: string): Promise<void> => {
    const entries = await readdir(directory, { withFileTypes: true })
    for (const entry of entries) {
      visited += 1
      if (visited > MAX_ENTRIES) throw new Error('Runtime contains too many entries')
      const relative = prefix === '' ? entry.name : `${prefix}/${entry.name}`
      const fullPath = resolve(directory, entry.name)
      if (entry.isSymbolicLink()) throw new Error('Runtime contains a symbolic link')
      if (entry.isDirectory()) await walk(fullPath, relative)
      else if (entry.isFile()) files.add(relative)
      else throw new Error('Runtime contains an unsupported entry')
    }
  }
  await walk(root, '')
  return files
}

export class RuntimeIntegrityService {
  #verified = false
  #verification: Promise<void> | undefined

  constructor(
    private readonly runtimeRoot: string,
    private readonly inventoryPath: string,
  ) {}

  verify(): Promise<void> {
    if (this.#verified) return Promise.resolve()
    this.#verification ??= this.verifyOnce()
      .then(() => {
        this.#verified = true
      })
      .catch((cause: unknown) => {
        throw new ApplicationError(
          'RUNTIME_INTEGRITY_FAILED',
          'The bundled Python runtime failed integrity verification',
          { cause },
        )
      })
      .finally(() => {
        if (!this.#verified) this.#verification = undefined
      })
    return this.#verification
  }

  private async verifyOnce(): Promise<void> {
    const inventoryStat = await lstat(this.inventoryPath)
    if (
      !inventoryStat.isFile() ||
      inventoryStat.isSymbolicLink() ||
      inventoryStat.size <= 0 ||
      inventoryStat.size > MAX_INVENTORY_BYTES
    ) {
      throw new Error('Runtime inventory file is invalid')
    }
    const rawInventory = await readFile(this.inventoryPath, 'utf8')
    const parsed = InventorySchema.parse(JSON.parse(rawInventory) as unknown)
    const expectedPaths = new Set<string>()
    let totalBytes = 0
    for (const file of parsed.files) {
      if (!validRelativePath(file.path) || expectedPaths.has(file.path)) {
        throw new Error('Runtime inventory path is invalid')
      }
      expectedPaths.add(file.path)
      totalBytes += file.size
      if (totalBytes > MAX_TOTAL_BYTES) throw new Error('Runtime inventory is too large')
    }
    const actualPaths = await listRuntimeFiles(this.runtimeRoot)
    if (
      actualPaths.size !== expectedPaths.size ||
      [...actualPaths].some((path) => !expectedPaths.has(path))
    ) {
      throw new Error('Runtime files do not match the inventory')
    }
    for (const file of parsed.files) {
      const path = resolve(this.runtimeRoot, ...file.path.split('/'))
      const stat = await lstat(path)
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== file.size) {
        throw new Error('Runtime file metadata does not match the inventory')
      }
      if ((await hashFile(path)) !== file.sha256) {
        throw new Error('Runtime file hash does not match the inventory')
      }
    }
  }
}
