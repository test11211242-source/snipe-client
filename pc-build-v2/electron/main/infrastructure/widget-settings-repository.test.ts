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
    await repository.save('two', { ...DEFAULT_WIDGET_SETTINGS, displayMode: 'detailed' })
    expect(files.size).toBe(2)
    expect([...files.keys()].join()).not.toContain('one')
    await expect(repository.load('one')).resolves.toMatchObject({ opacity: 0.7 })
  })

  it.each([false, true])(
    'migrates legacy compactMode=%s to the card grid and preserves window position',
    async (compactMode) => {
      const { fs, files } = memoryFileSystem()
      const repository = new WidgetSettingsRepository('/widget', fs)
      await repository.save('one', DEFAULT_WIDGET_SETTINGS)
      const path = [...files.keys()][0]
      if (path === undefined) throw new Error('Settings file was not created')
      files.set(
        path,
        JSON.stringify({
          autoOpen: false,
          alwaysOnTop: false,
          locked: true,
          opacity: 0.7,
          compactMode,
          bounds: { x: 120, y: 80, width: 620, height: 740 },
        }),
      )

      await expect(repository.load('one')).resolves.toEqual({
        autoOpen: false,
        alwaysOnTop: false,
        locked: true,
        opacity: 0.7,
        displayMode: 'deck',
        bounds: { x: 120, y: 80, width: 480, height: 300 },
      })
      expect(JSON.parse(files.get(path) ?? '{}')).not.toHaveProperty('compactMode')
      expect(JSON.parse(files.get(path) ?? '{}')).toHaveProperty('displayMode', 'deck')
    },
  )

  it('normalizes existing deck windows to a card-friendly aspect ratio', async () => {
    const { fs, files } = memoryFileSystem()
    const repository = new WidgetSettingsRepository('/widget', fs)
    await repository.save('one', {
      ...DEFAULT_WIDGET_SETTINGS,
      bounds: { x: 120, y: 80, width: 360, height: 900 },
    })
    const path = [...files.keys()][0]
    if (path === undefined) throw new Error('Settings file was not created')

    await expect(repository.load('one')).resolves.toMatchObject({
      bounds: { x: 120, y: 80, width: 720, height: 450 },
    })
    expect(JSON.parse(files.get(path) ?? '{}')).toMatchObject({
      bounds: { x: 120, y: 80, width: 720, height: 450 },
    })
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
