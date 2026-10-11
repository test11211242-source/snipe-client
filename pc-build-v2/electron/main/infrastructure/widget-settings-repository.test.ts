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
  it.each([false, true])(
    'migrates v3 preserving all preferences and original bytes (compact=%s)',
    async (compactMode) => {
      const { fs, files } = memoryFileSystem()
      const seed = new WidgetSettingsRepository('/v3', fs)
      await seed.save('one', DEFAULT_WIDGET_SETTINGS)
      const path = [...files.keys()][0]
      if (path === undefined) throw new Error('Missing seed path')
      const previous = {
        ...DEFAULT_WIDGET_SETTINGS,
        autoOpen: false,
        alwaysOnTop: false,
        locked: true,
        opacity: 0.7,
        compactMode,
        compactWidth: 620,
        normalWidth: 400,
        bounds: { x: -120, y: 80, width: compactMode ? 620 : 400, height: 310 },
      }
      const bytes = JSON.stringify({ schemaVersion: 3, settings: previous })
      files.set(path, bytes)
      const target = new WidgetSettingsRepository('/v4', fs, undefined, '/v3')
      const expected = {
        ...previous,
        compactWidth: 480,
        bounds: { ...previous.bounds, width: compactMode ? 480 : 400 },
      }
      await expect(target.load('one')).resolves.toEqual(expected)
      expect(files.get(path)).toBe(bytes)
      await expect(target.load('one')).resolves.toEqual(expected)
      expect(files.size).toBe(2)
    },
  )

  it('persists the narrow compact default and accepts only its 220–480 range', async () => {
    const { fs } = memoryFileSystem()
    const repository = new WidgetSettingsRepository('/v4', fs)
    expect(DEFAULT_WIDGET_SETTINGS.compactWidth).toBe(300)
    for (const width of [220, 300, 480]) {
      await repository.save('one', {
        ...DEFAULT_WIDGET_SETTINGS,
        compactMode: true,
        compactWidth: width,
        bounds: { ...DEFAULT_WIDGET_SETTINGS.bounds, width },
      })
      expect((await repository.load('one')).compactWidth).toBe(width)
    }
    for (const compactWidth of [219, 481]) {
      await expect(
        repository.save('one', { ...DEFAULT_WIDGET_SETTINGS, compactWidth }),
      ).rejects.toThrow()
    }
  })
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

  it.each([
    ['malformed JSON', '{not-json'],
    [
      'out-of-range settings',
      JSON.stringify({
        ...DEFAULT_WIDGET_SETTINGS,
        opacity: 0.1,
        bounds: { x: 120, y: 80, width: 10, height: 700 },
      }),
    ],
  ])('quarantines %s and loads defaults', async (_label, invalidValue) => {
    const { fs, files } = memoryFileSystem()
    const repository = new WidgetSettingsRepository('/widget', fs)
    await repository.save('one', DEFAULT_WIDGET_SETTINGS)
    const path = [...files.keys()][0]
    if (path === undefined) throw new Error('Settings file was not created')
    files.set(path, invalidValue)

    await expect(repository.load('one')).resolves.toEqual(DEFAULT_WIDGET_SETTINGS)
    expect(files.has(path)).toBe(false)
    expect([...files.keys()]).toEqual([expect.stringMatching(/\.invalid-/)])
    expect(files.values().next().value).toBe(invalidValue)
  })

  it('migrates valid compactMode settings without discarding user preferences', async () => {
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
        compactMode: true,
        bounds: { x: 120, y: 80, width: 620, height: 700 },
      }),
    )

    await expect(repository.load('one')).resolves.toEqual({
      autoOpen: false,
      alwaysOnTop: false,
      locked: true,
      opacity: 0.7,
      displayMode: 'deck',
      bounds: { x: 120, y: 80, width: 360, height: 300 },
      normalWidth: 360,
      compactWidth: 300,
      compactMode: false,
    })
    expect([...files.keys()]).toEqual([path])
    expect(JSON.parse(files.get(path) ?? '{}')).not.toHaveProperty('compactMode')
  })

  it('preserves operational read and quarantine errors', async () => {
    const denied = Object.assign(new Error('permission denied'), { code: 'EACCES' })
    const rename = vi.fn()
    const readFailure = new WidgetSettingsRepository('/widget', {
      ...memoryFileSystem().fs,
      readFile: vi.fn().mockRejectedValue(denied),
      rename,
    })
    await expect(readFailure.load('one')).rejects.toBe(denied)
    expect(rename).not.toHaveBeenCalled()

    const quarantineFailure = new Error('rename failed')
    const invalid = new WidgetSettingsRepository('/widget', {
      ...memoryFileSystem().fs,
      readFile: vi.fn().mockResolvedValue('{bad-json'),
      rename: vi.fn().mockRejectedValue(quarantineFailure),
    })
    await expect(invalid.load('one')).rejects.toBe(quarantineFailure)
  })

  it('preserves freely resized valid widget bounds', async () => {
    const { fs, files } = memoryFileSystem()
    const repository = new WidgetSettingsRepository('/widget', fs)
    await repository.save('one', {
      ...DEFAULT_WIDGET_SETTINGS,
      displayMode: 'deck',
      bounds: { x: 120, y: 80, width: 500, height: 620 },
    })
    const path = [...files.keys()][0]
    if (path === undefined) throw new Error('Settings file was not created')

    await expect(repository.load('one')).resolves.toMatchObject({
      displayMode: 'deck',
      bounds: { x: 120, y: 80, width: 500, height: 620 },
    })
    expect(JSON.parse(files.get(path) ?? '{}')).toMatchObject({
      schemaVersion: 4,
      settings: {
        displayMode: 'deck',
        bounds: { x: 120, y: 80, width: 500, height: 620 },
      },
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

describe('review regression legacy widget fallback', () => {
  it.each(['{invalid', JSON.stringify({ opacity: 0.01 })])(
    '#11 leaves invalid v2 input unchanged and uses defaults: %s',
    async (bytes) => {
      const { fs, files } = memoryFileSystem()
      const original = new WidgetSettingsRepository('/v2', fs)
      await original.save('one', DEFAULT_WIDGET_SETTINGS)
      const currentPath = [...files.keys()][0]
      if (currentPath === undefined) throw new Error('Missing fixture path')
      const legacyPath = currentPath
      files.delete(currentPath)
      files.set(legacyPath, bytes)
      const target = new WidgetSettingsRepository('/v3', fs, '/v2')
      await expect(target.load('one')).resolves.toEqual(DEFAULT_WIDGET_SETTINGS)
      expect(files.get(legacyPath)).toBe(bytes)
    },
  )
})
