import { describe, expect, it } from 'vitest'

import {
  SettingsSchema,
  createDefaultSettings,
  parseAndMigrateSettings,
} from './settings-repository'

describe('settings schema', () => {
  it('provides valid isolated defaults', () => {
    const first = createDefaultSettings()
    const second = createDefaultSettings()

    expect(SettingsSchema.parse(first)).toEqual(first)
    first.application.launchAtStartup = true
    expect(second.application.launchAtStartup).toBe(false)
  })

  it('migrates version zero into the current schema', () => {
    expect(
      parseAndMigrateSettings({
        version: 0,
        startWithWindows: true,
        reduceMotion: true,
      }),
    ).toEqual({
      version: 1,
      appearance: { theme: 'operational-dark', reducedMotion: true },
      application: { launchAtStartup: true, diagnosticsEnabled: false },
    })
  })

  it('rejects secret and unknown fields', () => {
    expect(() =>
      SettingsSchema.parse({ ...createDefaultSettings(), refreshToken: 'secret' }),
    ).toThrow()
  })
})
