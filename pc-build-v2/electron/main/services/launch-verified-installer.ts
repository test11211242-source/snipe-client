import { spawn, type SpawnOptions } from 'node:child_process'
import { win32 } from 'node:path'
import type { Readable } from 'node:stream'

export interface VerifiedInstaller {
  path: string
  size: number
  sha512: string
}

export interface VerifiedInstallerLaunchControl {
  cancel(): void
}

export type VerifiedInstallerLauncher = (
  installer: VerifiedInstaller,
) => Promise<VerifiedInstallerLaunchControl>

interface InstallerProcess {
  stdout: Readable
  stderr: Readable
  unref(): void
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
  parentProcessId: () => number
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
const READY_MARKER = 'CR_TOOLS_INSTALLER_READY'
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
$parentProcessIdText = [Environment]::GetEnvironmentVariable('CR_TOOLS_PARENT_PROCESS_ID', 'Process')
$expectedSize = 0L
$parentProcessId = 0
if ([string]::IsNullOrWhiteSpace($installerPath) -or
    -not [System.IO.Path]::IsPathFullyQualified($installerPath) -or
    [System.IO.Path]::GetExtension($installerPath) -cne '.exe' -or
    $expectedHash -notmatch '^[A-Za-z0-9+/]{86}==$' -or
    -not [long]::TryParse($expectedSizeText, [Globalization.NumberStyles]::None, [Globalization.CultureInfo]::InvariantCulture, [ref]$expectedSize) -or
    $expectedSize -lt 1 -or
    -not [int]::TryParse($parentProcessIdText, [Globalization.NumberStyles]::None, [Globalization.CultureInfo]::InvariantCulture, [ref]$parentProcessId) -or
    $parentProcessId -lt 1 -or $parentProcessId -eq $PID) {
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
  Write-Output 'CR_TOOLS_INSTALLER_READY'
  $parentExitDeadline = [DateTime]::UtcNow.AddMinutes(5)
  while ($null -ne (Get-Process -Id $parentProcessId -ErrorAction SilentlyContinue)) {
    if ([DateTime]::UtcNow -ge $parentExitDeadline) {
      throw 'Application did not exit before installer deadline'
    }
    Start-Sleep -Milliseconds 200
  }
  $installerProcess = Start-Process -FilePath $installerPath -PassThru
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
  parentProcessId: () => process.pid,
  environment: () => process.env,
  spawn: (executable, args, options) => spawn(executable, [...args], options),
  timers: { setTimeout, clearTimeout },
}

function validateInstaller(installer: VerifiedInstaller): void {
  if (
    !win32.isAbsolute(installer.path) ||
    win32.extname(installer.path).toLowerCase() !== '.exe' ||
    !Number.isSafeInteger(installer.size) ||
    installer.size < 1 ||
    !/^[A-Za-z0-9+/]{86}==$/.test(installer.sha512)
  ) {
    throw new Error('Invalid trusted installer metadata')
  }
}

function powershellPath(environment: NodeJS.ProcessEnv): string {
  const root = environment['SystemRoot'] ?? environment['WINDIR']
  if (root === undefined || !win32.isAbsolute(root)) {
    throw new Error('Windows system directory is unavailable')
  }
  return win32.join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
}

export function createVerifiedInstallerLauncher(
  dependencies: VerifiedInstallerLauncherDependencies = nodeDependencies,
): VerifiedInstallerLauncher {
  return (installer) => {
    if (dependencies.platform() !== 'win32') {
      return Promise.reject(new Error('Verified installer launch requires Windows'))
    }
    validateInstaller(installer)
    const environment = dependencies.environment()
    const executable = powershellPath(environment)

    return new Promise<VerifiedInstallerLaunchControl>((resolve, reject) => {
      let child: InstallerProcess
      try {
        child = dependencies.spawn(executable, POWERSHELL_ARGS, {
          env: {
            ...environment,
            CR_TOOLS_INSTALLER_PATH: installer.path,
            CR_TOOLS_INSTALLER_SIZE: String(installer.size),
            CR_TOOLS_INSTALLER_SHA512: installer.sha512,
            CR_TOOLS_PARENT_PROCESS_ID: String(dependencies.parentProcessId()),
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
      let stdout = ''
      const settle = (error?: Error): void => {
        if (settled) return
        settled = true
        dependencies.timers.clearTimeout(timeout)
        if (error === undefined) {
          child.stdout.destroy()
          child.stderr.destroy()
          child.unref()
          resolve({
            cancel: () => {
              child.kill('SIGKILL')
            },
          })
        } else reject(error)
      }
      const countOutput = (chunk: Buffer | string, isStdout: boolean): void => {
        outputBytes += Buffer.byteLength(chunk)
        if (outputBytes > MAX_OUTPUT_BYTES && !settled) {
          child.kill('SIGKILL')
          settle(new Error('Verified installer launcher exceeded its output limit'))
          return
        }
        if (!isStdout || settled) return
        stdout = `${stdout}${String(chunk)}`.slice(-READY_MARKER.length * 2)
        if (stdout.includes(READY_MARKER)) settle()
      }
      const timeout = dependencies.timers.setTimeout(() => {
        if (!settled) child.kill('SIGKILL')
        settle(new Error('Verified installer launcher timed out'))
      }, PROCESS_TIMEOUT_MS)

      child.stdout.on('data', (chunk: Buffer | string) => countOutput(chunk, true))
      child.stderr.on('data', (chunk: Buffer | string) => countOutput(chunk, false))
      child.once('error', () =>
        settle(new Error('Verified installer launcher failed to execute')),
      )
      child.once('close', (code) => {
        if (!settled) {
          settle(
            new Error(
              code === 0
                ? 'Verified installer launcher exited before readiness'
                : 'Verified installer launcher exited unsuccessfully',
            ),
          )
        }
      })
    })
  }
}

export const launchVerifiedInstaller = createVerifiedInstallerLauncher()
