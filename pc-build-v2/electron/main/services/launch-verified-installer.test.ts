import { createHash } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { promises as fileSystem } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { describe, expect, it, vi } from 'vitest'

import {
  createVerifiedInstallerLauncher,
  type VerifiedInstallerLauncherDependencies,
} from './launch-verified-installer'

class FakeProcess extends EventEmitter {
  readonly stdout = new PassThrough()
  readonly stderr = new PassThrough()
  readonly kill = vi.fn(() => true)
  readonly unref = vi.fn()
}

const hash = 'A'.repeat(86) + '=='
const windowsTest = process.platform === 'win32' ? it : it.skip

function dependencies(child: FakeProcess) {
  const spawn = vi.fn<VerifiedInstallerLauncherDependencies['spawn']>(() => child)
  const value: VerifiedInstallerLauncherDependencies = {
    platform: () => 'win32',
    parentProcessId: () => 4321,
    environment: () => ({
      SAFE_PARENT_VALUE: 'preserved',
      SystemRoot: 'C:\\Windows',
    }),
    spawn,
    timers: { setTimeout, clearTimeout },
  }
  return { value, spawn }
}

describe('launchVerifiedInstaller', () => {
  it('uses a fixed no-shell command and passes untrusted metadata only in the environment', async () => {
    const firstChild = new FakeProcess()
    const firstDependencies = dependencies(firstChild)
    const firstLaunch = createVerifiedInstallerLauncher(firstDependencies.value)
    const first = firstLaunch({
      path: 'C:\\safe & unusual\\setup.exe',
      size: 123,
      sha512: hash,
    })
    const firstCall = firstDependencies.spawn.mock.calls[0]
    expect(firstCall).toBeDefined()
    if (firstCall === undefined) throw new Error('Launcher was not spawned')
    const [executable, args, options] = firstCall
    expect(executable).toBe(
      'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
    )
    expect(options).toMatchObject({
      shell: false,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        SAFE_PARENT_VALUE: 'preserved',
        SystemRoot: 'C:\\Windows',
        CR_TOOLS_INSTALLER_PATH: 'C:\\safe & unusual\\setup.exe',
        CR_TOOLS_INSTALLER_SIZE: '123',
        CR_TOOLS_INSTALLER_SHA512: hash,
        CR_TOOLS_PARENT_PROCESS_ID: '4321',
      },
    })
    expect(args).not.toContain('C:\\safe & unusual\\setup.exe')
    expect(args).not.toContain(hash)
    expect(args.join('\n')).toContain('[System.IO.FileShare]::Read')
    expect(args.join('\n')).toContain('$sha512.ComputeHash($stream)')
    expect(args.join('\n')).toContain('Start-Process -FilePath $installerPath -PassThru')
    expect(args.join('\n')).toContain('Get-Process -Id $parentProcessId')
    expect(args.join('\n')).toContain('[DateTime]::UtcNow.AddMinutes(5)')
    expect(args.join('\n')).toContain('CR_TOOLS_INSTALLER_READY')
    expect(args.join('\n')).toContain('[System.IO.Path]::IsPathRooted($installerPath)')
    expect(args.join('\n')).not.toContain('IsPathFullyQualified')
    expect(args.join('\n')).not.toContain('-ArgumentList')
    expect(args).not.toContain('Bypass')

    const secondChild = new FakeProcess()
    const secondDependencies = dependencies(secondChild)
    const second = createVerifiedInstallerLauncher(secondDependencies.value)({
      path: 'C:\\other\\setup.exe',
      size: 456,
      sha512: 'B'.repeat(86) + '==',
    })
    expect(secondDependencies.spawn.mock.calls[0]?.[1]).toEqual(args)

    firstChild.stdout.write('CR_TOOLS_INSTALLER_READY\n')
    secondChild.stdout.write('CR_TOOLS_INSTALLER_READY\n')
    const firstControl = await first
    await second
    expect(firstChild.unref).toHaveBeenCalledOnce()
    firstControl.cancel()
    expect(firstChild.kill).toHaveBeenCalledWith('SIGKILL')
  })

  it('rejects non-Windows and kills a bounded process on timeout', async () => {
    const child = new FakeProcess()
    const testDependencies = dependencies(child)
    const nonWindows = createVerifiedInstallerLauncher({
      ...testDependencies.value,
      platform: () => 'linux',
    })
    await expect(
      nonWindows({ path: '/tmp/setup.exe', size: 123, sha512: hash }),
    ).rejects.toThrow('requires Windows')
    expect(testDependencies.spawn).not.toHaveBeenCalled()

    vi.useFakeTimers()
    try {
      const timedChild = new FakeProcess()
      const timedDependencies = dependencies(timedChild)
      const launch = createVerifiedInstallerLauncher(timedDependencies.value)({
        path: 'C:\\safe\\setup.exe',
        size: 123,
        sha512: hash,
      })
      const rejected = expect(launch).rejects.toMatchObject({
        code: 'INSTALLER_HELPER_TIMEOUT',
        retryable: false,
      })
      await vi.advanceTimersByTimeAsync(30_000)
      await rejected
      expect(timedChild.kill).toHaveBeenCalledWith('SIGKILL')
    } finally {
      vi.useRealTimers()
    }
  })

  it('rejects relative and non-executable installer paths before spawning', () => {
    const child = new FakeProcess()
    const testDependencies = dependencies(child)
    const launch = createVerifiedInstallerLauncher(testDependencies.value)

    expect(() => launch({ path: 'setup.exe', size: 123, sha512: hash })).toThrow(
      'Invalid trusted installer metadata',
    )
    expect(() =>
      launch({ path: 'C:\\safe\\setup.txt', size: 123, sha512: hash }),
    ).toThrow('Invalid trusted installer metadata')
    expect(testDependencies.spawn).not.toHaveBeenCalled()
  })

  it('preserves a bounded diagnostic and exit code when the helper exits', async () => {
    const child = new FakeProcess()
    const testDependencies = dependencies(child)
    const launch = createVerifiedInstallerLauncher(testDependencies.value)({
      path: 'C:\\safe\\setup.exe',
      size: 123,
      sha512: hash,
    })
    const rejected = expect(launch).rejects.toMatchObject({
      code: 'INSTALLER_HELPER_EXITED',
      exitCode: 1,
      diagnostic: 'PowerShell helper failure',
    })

    child.stderr.write('PowerShell helper failure\n')
    child.emit('close', 1, null)
    await rejected
  })

  windowsTest(
    'runs the exact helper with inbox Windows PowerShell 5.1',
    async () => {
      const directory = await fileSystem.mkdtemp(
        join(tmpdir(), 'cr-tools-installer-helper-'),
      )
      const installerPath = join(directory, 'probe.exe')
      const installer = Buffer.from('CR Tools verified installer helper probe')
      let control: { cancel(): void } | undefined
      await fileSystem.writeFile(installerPath, installer)

      try {
        control = await createVerifiedInstallerLauncher()({
          path: installerPath,
          size: installer.byteLength,
          sha512: createHash('sha512').update(installer).digest('base64'),
        })
      } finally {
        control?.cancel()
        await new Promise((resolve) => setTimeout(resolve, 250))
        await fileSystem.rm(directory, {
          recursive: true,
          force: true,
          maxRetries: 5,
          retryDelay: 100,
        })
      }
    },
    15_000,
  )
})
