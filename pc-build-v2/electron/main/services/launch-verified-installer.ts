import { spawn, type SpawnOptions } from 'node:child_process'
import type { Readable } from 'node:stream'

export interface VerifiedInstaller {
  path: string
  size: number
  sha512: string
}

export type VerifiedInstallerLauncher = (installer: VerifiedInstaller) => Promise<void>

interface InstallerProcess {
  stdout: Readable
  stderr: Readable
  once(event: 'error', listener: (error: Error) => void): this
  once(
    event: 'close',
    listener: (code: number | null, signal: string | null) => void,
  ): this
  kill(signal: NodeJS.Signals): boolean
}

interface InstallerSpawnOptions extends SpawnOptions {
  env: NodeJS.ProcessEnv
  shell: false
  windowsHide: true
  stdio: ['ignore', 'pipe', 'pipe']
}

export interface VerifiedInstallerLauncherDependencies {
  platform: () => NodeJS.Platform
  environment: () => NodeJS.ProcessEnv
  spawn: (
    executable: string,
    args: readonly string[],
    options: InstallerSpawnOptions,
  ) => InstallerProcess
  timers: Pick<typeof globalThis, 'setTimeout' | 'clearTimeout'>
}

const PROCESS_TIMEOUT_MS = 30_000
const MAX_OUTPUT_BYTES = 16 * 1024
const POWERSHELL_ARGS = [
  '-NoLogo',
  '-NoProfile',
  '-NonInteractive',
  '-Command',
  String.raw`
$ErrorActionPreference = 'Stop'
$installerPath = [Environment]::GetEnvironmentVariable('CR_TOOLS_INSTALLER_PATH', 'Process')
$expectedHash = [Environment]::GetEnvironmentVariable('CR_TOOLS_INSTALLER_SHA512', 'Process')
$expectedSizeText = [Environment]::GetEnvironmentVariable('CR_TOOLS_INSTALLER_SIZE', 'Process')
$expectedSize = 0L
if ([string]::IsNullOrWhiteSpace($installerPath) -or
    $expectedHash -notmatch '^[A-Za-z0-9+/]{86}==$' -or
    -not [long]::TryParse($expectedSizeText, [Globalization.NumberStyles]::None, [Globalization.CultureInfo]::InvariantCulture, [ref]$expectedSize) -or
    $expectedSize -lt 1) {
  throw 'Invalid trusted installer metadata'
}

$stream = [System.IO.File]::Open(
  $installerPath,
  [System.IO.FileMode]::Open,
  [System.IO.FileAccess]::Read,
  [System.IO.FileShare]::Read
)
try {
  if ($stream.Length -ne $expectedSize) {
    throw 'Installer size mismatch'
  }
  $sha512 = [System.Security.Cryptography.SHA512]::Create()
  try {
    $actualHash = [Convert]::ToBase64String($sha512.ComputeHash($stream))
  } finally {
    $sha512.Dispose()
  }
  if ($actualHash -cne $expectedHash) {
    throw 'Installer hash mismatch'
  }
  $installerProcess = Start-Process -FilePath $installerPath -Verb Open -PassThru
  if ($null -eq $installerProcess) {
    throw 'Installer process was not created'
  }
} finally {
  $stream.Dispose()
}
`,
] as const

const nodeDependencies: VerifiedInstallerLauncherDependencies = {
  platform: () => process.platform,
  environment: () => process.env,
  spawn: (executable, args, options) => spawn(executable, [...args], options),
  timers: { setTimeout, clearTimeout },
}

function validateInstaller(installer: VerifiedInstaller): void {
  if (
    installer.path.length === 0 ||
    !Number.isSafeInteger(installer.size) ||
    installer.size < 1 ||
    !/^[A-Za-z0-9+/]{86}==$/.test(installer.sha512)
  ) {
    throw new Error('Invalid trusted installer metadata')
  }
}

export function createVerifiedInstallerLauncher(
  dependencies: VerifiedInstallerLauncherDependencies = nodeDependencies,
): VerifiedInstallerLauncher {
  return (installer) => {
    if (dependencies.platform() !== 'win32') {
      return Promise.reject(new Error('Verified installer launch requires Windows'))
    }
    validateInstaller(installer)

    return new Promise<void>((resolve, reject) => {
      let child: InstallerProcess
      try {
        child = dependencies.spawn('powershell.exe', POWERSHELL_ARGS, {
          env: {
            ...dependencies.environment(),
            CR_TOOLS_INSTALLER_PATH: installer.path,
            CR_TOOLS_INSTALLER_SIZE: String(installer.size),
            CR_TOOLS_INSTALLER_SHA512: installer.sha512,
          },
          shell: false,
          windowsHide: true,
          stdio: ['ignore', 'pipe', 'pipe'],
        })
      } catch {
        reject(new Error('Verified installer launcher could not start'))
        return
      }

      let settled = false
      let outputBytes = 0
      const settle = (error?: Error): void => {
        if (settled) return
        settled = true
        dependencies.timers.clearTimeout(timeout)
        if (error === undefined) resolve()
        else reject(error)
      }
      const countOutput = (chunk: Buffer | string): void => {
        outputBytes += Buffer.byteLength(chunk)
        if (outputBytes > MAX_OUTPUT_BYTES && !settled) {
          child.kill('SIGKILL')
          settle(new Error('Verified installer launcher exceeded its output limit'))
        }
      }
      const timeout = dependencies.timers.setTimeout(() => {
        if (!settled) child.kill('SIGKILL')
        settle(new Error('Verified installer launcher timed out'))
      }, PROCESS_TIMEOUT_MS)

      child.stdout.on('data', countOutput)
      child.stderr.on('data', countOutput)
      child.once('error', () =>
        settle(new Error('Verified installer launcher failed to execute')),
      )
      child.once('close', (code) => {
        if (code === 0) settle()
        else settle(new Error('Verified installer launcher exited unsuccessfully'))
      })
    })
  }
}

export const launchVerifiedInstaller = createVerifiedInstallerLauncher()
