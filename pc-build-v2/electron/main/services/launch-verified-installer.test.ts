import { EventEmitter } from 'node:events'
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
}

const hash = 'A'.repeat(86) + '=='

function dependencies(child: FakeProcess) {
  const spawn = vi.fn<VerifiedInstallerLauncherDependencies['spawn']>(() => child)
  const value: VerifiedInstallerLauncherDependencies = {
    platform: () => 'win32',
    environment: () => ({ SAFE_PARENT_VALUE: 'preserved' }),
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
    expect(executable).toBe('powershell.exe')
    expect(options).toMatchObject({
      shell: false,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        SAFE_PARENT_VALUE: 'preserved',
        CR_TOOLS_INSTALLER_PATH: 'C:\\safe & unusual\\setup.exe',
        CR_TOOLS_INSTALLER_SIZE: '123',
        CR_TOOLS_INSTALLER_SHA512: hash,
      },
    })
    expect(args).not.toContain('C:\\safe & unusual\\setup.exe')
    expect(args).not.toContain(hash)
    expect(args.join('\n')).toContain('[System.IO.FileShare]::Read')
    expect(args.join('\n')).toContain('$sha512.ComputeHash($stream)')
    expect(args.join('\n')).toContain(
      'Start-Process -FilePath $installerPath -Verb Open -PassThru',
    )
    expect(args).not.toContain('Bypass')

    const secondChild = new FakeProcess()
    const secondDependencies = dependencies(secondChild)
    const second = createVerifiedInstallerLauncher(secondDependencies.value)({
      path: 'C:\\other\\setup.exe',
      size: 456,
      sha512: 'B'.repeat(86) + '==',
    })
    expect(secondDependencies.spawn.mock.calls[0]?.[1]).toEqual(args)

    firstChild.emit('close', 0, null)
    secondChild.emit('close', 0, null)
    await expect(first).resolves.toBeUndefined()
    await expect(second).resolves.toBeUndefined()
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
      const rejected = expect(launch).rejects.toThrow('timed out')
      await vi.advanceTimersByTimeAsync(30_000)
      await rejected
      expect(timedChild.kill).toHaveBeenCalledWith('SIGKILL')
    } finally {
      vi.useRealTimers()
    }
  })
})
