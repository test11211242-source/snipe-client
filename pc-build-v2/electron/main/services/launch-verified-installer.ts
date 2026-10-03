import { spawn, type SpawnOptions } from 'node:child_process'
import { join, win32 } from 'node:path'
import type { Readable } from 'node:stream'

export interface VerifiedInstaller {
  path: string
  size: number
  sha512: string
}

export interface VerifiedInstallerLaunchControl {
  cancel(): void
}

export type VerifiedInstallerLaunchErrorCode =
  | 'INSTALLER_HELPER_START_FAILED'
  | 'INSTALLER_HELPER_EXECUTION_FAILED'
  | 'INSTALLER_HELPER_TIMEOUT'
  | 'INSTALLER_HELPER_OUTPUT_LIMIT'
  | 'INSTALLER_HELPER_EXITED'
  | 'INSTALLER_HELPER_NOT_READY'

export class VerifiedInstallerLaunchError extends Error {
  override readonly name = 'VerifiedInstallerLaunchError'

  constructor(
    readonly code: VerifiedInstallerLaunchErrorCode,
    message: string,
    readonly exitCode: number | null = null,
    readonly diagnostic = '',
    readonly retryable = true,
  ) {
    super(message)
  }
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
  detached: true
  env: NodeJS.ProcessEnv
  shell: false
  windowsHide: true
  stdio: ['ignore', 'pipe', 'pipe']
}

export interface VerifiedInstallerLauncherDependencies {
  platform: () => NodeJS.Platform
  helperPath: () => string
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
const nodeDependencies: VerifiedInstallerLauncherDependencies = {
  platform: () => process.platform,
  helperPath: () => join(process.resourcesPath, 'installer-helper.exe'),
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

export function createVerifiedInstallerLauncher(
  dependencies: VerifiedInstallerLauncherDependencies = nodeDependencies,
): VerifiedInstallerLauncher {
  return (installer) => {
    if (dependencies.platform() !== 'win32') {
      return Promise.reject(new Error('Verified installer launch requires Windows'))
    }
    validateInstaller(installer)
    const environment = dependencies.environment()
    const executable = dependencies.helperPath()
    if (
      !win32.isAbsolute(executable) ||
      win32.extname(executable).toLowerCase() !== '.exe'
    ) {
      return Promise.reject(new Error('Installer helper path is invalid'))
    }

    return new Promise<VerifiedInstallerLaunchControl>((resolve, reject) => {
      let child: InstallerProcess
      try {
        child = dependencies.spawn(executable, [], {
          env: {
            ...environment,
            CR_TOOLS_INSTALLER_PATH: installer.path,
            CR_TOOLS_INSTALLER_SIZE: String(installer.size),
            CR_TOOLS_INSTALLER_SHA512: installer.sha512,
            CR_TOOLS_PARENT_PROCESS_ID: String(dependencies.parentProcessId()),
          },
          shell: false,
          detached: true,
          windowsHide: true,
          stdio: ['ignore', 'pipe', 'pipe'],
        })
      } catch {
        reject(
          new VerifiedInstallerLaunchError(
            'INSTALLER_HELPER_START_FAILED',
            'The Windows installer helper could not start',
          ),
        )
        return
      }

      let settled = false
      let outputBytes = 0
      let stdout = ''
      let stderr = ''
      const failure = (
        code: VerifiedInstallerLaunchErrorCode,
        message: string,
        exitCode: number | null = null,
        retryable = true,
      ): VerifiedInstallerLaunchError =>
        new VerifiedInstallerLaunchError(
          code,
          message,
          exitCode,
          stderr.trim(),
          retryable,
        )
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
        if (!isStdout && !settled) {
          stderr = `${stderr}${String(chunk)}`.slice(-MAX_OUTPUT_BYTES)
        }
        if (outputBytes > MAX_OUTPUT_BYTES && !settled) {
          child.kill('SIGKILL')
          settle(
            failure(
              'INSTALLER_HELPER_OUTPUT_LIMIT',
              'The Windows installer helper exceeded its output limit',
              null,
              false,
            ),
          )
          return
        }
        if (!isStdout || settled) return
        stdout = `${stdout}${String(chunk)}`.slice(-READY_MARKER.length * 2)
        if (stdout.includes(READY_MARKER)) settle()
      }
      const timeout = dependencies.timers.setTimeout(() => {
        if (!settled) child.kill('SIGKILL')
        settle(
          failure(
            'INSTALLER_HELPER_TIMEOUT',
            'The Windows installer helper timed out',
            null,
            false,
          ),
        )
      }, PROCESS_TIMEOUT_MS)

      child.stdout.on('data', (chunk: Buffer | string) => countOutput(chunk, true))
      child.stderr.on('data', (chunk: Buffer | string) => countOutput(chunk, false))
      child.once('error', (error) =>
        settle(
          new VerifiedInstallerLaunchError(
            'INSTALLER_HELPER_EXECUTION_FAILED',
            'The Windows installer helper failed to execute',
            null,
            error.message,
          ),
        ),
      )
      child.once('close', (code) => {
        if (!settled) {
          settle(
            failure(
              code === 0 ? 'INSTALLER_HELPER_NOT_READY' : 'INSTALLER_HELPER_EXITED',
              code === 0
                ? 'The Windows installer helper exited before readiness'
                : 'The Windows installer helper exited unsuccessfully',
              code,
            ),
          )
        }
      })
    })
  }
}

export const launchVerifiedInstaller = createVerifiedInstallerLauncher()
