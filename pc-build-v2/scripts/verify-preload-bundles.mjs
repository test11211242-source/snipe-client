import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

const outputDirectory = join(import.meta.dirname, '..', 'out', 'preload')
const entries = new Map([
  ['auth.cjs', 'crToolsAuth'],
  ['main.cjs', 'crTools'],
  ['setup.cjs', 'crToolsSetup'],
  ['widget.cjs', 'crToolsWidget'],
])
const allowedRequires = new Set([
  'electron',
  'events',
  'node:events',
  'node:timers',
  'node:url',
  'timers',
  'url',
])

for (const [fileName, bridgeName] of entries) {
  const source = await readFile(join(outputDirectory, fileName), 'utf8')
  const requiredModules = [
    ...source.matchAll(/\brequire\(\s*["']([^"']+)["']\s*\)/g),
  ].map((match) => match[1])
  const unsupportedModules = requiredModules.filter(
    (moduleName) => !allowedRequires.has(moduleName),
  )
  if (unsupportedModules.length > 0) {
    throw new Error(
      `${fileName} contains requires unsupported by Electron sandbox: ${[
        ...new Set(unsupportedModules),
      ].join(', ')}`,
    )
  }
  if (!source.includes(`exposeInMainWorld("${bridgeName}"`)) {
    throw new Error(`${fileName} does not expose the expected ${bridgeName} bridge`)
  }
}

console.log(`Verified ${entries.size} standalone sandboxed preload bundles.`)
