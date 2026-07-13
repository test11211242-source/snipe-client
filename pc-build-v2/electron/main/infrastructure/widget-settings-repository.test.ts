import { describe, expect, it, vi } from 'vitest'

import {
  DEFAULT_WIDGET_SETTINGS,
  WidgetSettingsRepository,
  type WidgetSettingsFileSystem,
} from './widget-settings-repository'

function memoryFileSystem(): {
  fs: WidgetSettingsFileSystem
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

describe('WidgetSettingsRepository', () => {
  it('uses practical defaults and atomically isolates users', async () => {
    const { fs, files } = memoryFileSystem()
    const repository = new WidgetSettingsRepository('/widget', fs)
    await expect(repository.load('one')).resolves.toEqual(DEFAULT_WIDGET_SETTINGS)
    await repository.save('one', { ...DEFAULT_WIDGET_SETTINGS, opacity: 0.7 })
    await repository.save('two', { ...DEFAULT_WIDGET_SETTINGS, compactMode: true })
    expect(files.size).toBe(2)
    expect([...files.keys()].join()).not.toContain('one')
    await expect(repository.load('one')).resolves.toMatchObject({ opacity: 0.7 })
  })

  it('rejects unsafe bounds and cleans a failed atomic write', async () => {
    const { fs } = memoryFileSystem()
    const repository = new WidgetSettingsRepository('/widget', fs)
    await expect(
      repository.save('one', {
        ...DEFAULT_WIDGET_SETTINGS,
        bounds: { x: null, y: null, width: 10, height: 560 },
      }),
    ).rejects.toThrow()

    const rm = vi.fn().mockResolvedValue(undefined)
    const failing = new WidgetSettingsRepository('/widget', {
      ...fs,
      rename: vi.fn().mockRejectedValue(new Error('disk full')),
      rm,
    })
    await expect(failing.save('one', DEFAULT_WIDGET_SETTINGS)).rejects.toThrow(
      'disk full',
    )
    expect(rm).toHaveBeenCalledWith(expect.stringContaining('.tmp'), { force: true })
  })
})
