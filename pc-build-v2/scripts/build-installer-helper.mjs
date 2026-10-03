import { execFileSync } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { dirname, resolve, win32 } from 'node:path'
import { fileURLToPath } from 'node:url'

export function buildInstallerHelper(output) {
  if (process.platform !== 'win32') throw new Error('Installer helper builds on Windows')
  const root = process.env.SystemRoot ?? process.env.WINDIR
  if (!root || !win32.isAbsolute(root))
    throw new Error('Windows directory is unavailable')
  const compiler = win32.join(
    root,
    'Microsoft.NET',
    'Framework64',
    'v4.0.30319',
    'csc.exe',
  )
  const source = fileURLToPath(new URL('./windows/VerifiedInstaller.cs', import.meta.url))
  mkdirSync(dirname(output), { recursive: true })
  execFileSync(
    compiler,
    [
      '/nologo',
      '/target:winexe',
      '/platform:x64',
      '/optimize+',
      `/out:${resolve(output)}`,
      source,
    ],
    { windowsHide: true, stdio: 'pipe' },
  )
}
