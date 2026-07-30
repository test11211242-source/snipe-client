// electron-vite 5's isolated-entry reporter assumes an interactive stdout.
if (process.stdout.isTTY !== true) {
  Object.assign(process.stdout, {
    clearLine: () => true,
    cursorTo: () => true,
    moveCursor: () => true,
  })
}

const { build } = await import('electron-vite')
await build()

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const thisDir = dirname(fileURLToPath(import.meta.url))
const resourceDir = resolve(thisDir, '..', 'resources')
if (!existsSync(resourceDir)) mkdirSync(resourceDir, { recursive: true })

const pkg = JSON.parse(readFileSync(resolve(thisDir, '..', 'package.json'), 'utf8'))
writeFileSync(
  resolve(resourceDir, 'app-version.json'),
  JSON.stringify({ version: pkg.version }, null, 2) + '\n',
)
