import { describe, expect, it, vi } from 'vitest'

import {
  MonitorPreferencesRepository,
  type MonitorPreferencesFileSystem,
} from './monitor-preferences-repository'

function memoryFileSystem(): {
  fs: MonitorPreferencesFileSystem
  files: Map<string, string>
} {
  const files = new Map<string, string>()
  return {
    files,
    fs: {
      readFile: (path) => {
        const value = files.get(path)
        return value === undefined
          ? Promise.reject(Object.assign(new Error('missing'), { code: 'ENOENT' }))
          : Promise.resolve(value)
      },
      writeFile: (path, data) => {
        files.set(path, data)
        return Promise.resolve()
      },
      rename: (from, to) => {
        const value = files.get(from)
        if (value === undefined) throw new Error('missing temporary file')
        files.set(to, value)
        files.delete(from)
        return Promise.resolve()
      },
      mkdir: () => Promise.resolve(),
      rm: (path) => {
        files.delete(path)
        return Promise.resolve()
      },
    },
  }
}

describe('MonitorPreferencesRepository', () => {
  it('defaults to fast/PoL and stores strict per-user values atomically', async () => {
    const { fs, files } = memoryFileSystem()
    const repository = new MonitorPreferencesRepository('/prefs', fs)
    await expect(repository.load('user-a')).resolves.toEqual({
      searchMode: 'fast',
      deckMode: 'pol',
    })
    await repository.save('user-a', { searchMode: 'precise', deckMode: 'gt' })
    await repository.save('user-b', { searchMode: 'fast', deckMode: 'pol' })
    expect(files.size).toBe(2)
    expect([...files.keys()].join()).not.toContain('user-a')
    await expect(repository.load('user-a')).resolves.toEqual({
      searchMode: 'precise',
      deckMode: 'gt',
    })
  })

  it('rejects unknown persisted fields and removes a failed temporary write', async () => {
    const { fs, files } = memoryFileSystem()
    const repository = new MonitorPreferencesRepository('/prefs', fs)
    await repository.save('user', { searchMode: 'fast', deckMode: 'pol' })
    const path = [...files.keys()][0]
    if (path === undefined) throw new Error('missing test file')
    files.set(path, '{"searchMode":"fast","deckMode":"pol","token":"x"}')
    await expect(repository.load('user')).rejects.toThrow()

    const rm = vi.fn().mockResolvedValue(undefined)
    const failing = new MonitorPreferencesRepository('/prefs', {
      ...fs,
      rename: vi.fn().mockRejectedValue(new Error('disk full')),
      rm,
    })
    await expect(
      failing.save('user', { searchMode: 'fast', deckMode: 'pol' }),
    ).rejects.toThrow('disk full')
    expect(rm).toHaveBeenCalledWith(expect.stringContaining('.tmp'), { force: true })
  })
})
