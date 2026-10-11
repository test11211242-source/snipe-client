import { describe, expect, it } from 'vitest'

import {
  AppSettingsUpdateSchema,
  AppSnapshotResultSchema,
  HelloPayloadSchema,
  HelloResultSchema,
} from './app'

describe('application IPC contracts', () => {
  it('parses exact hello request and response envelopes', () => {
    expect(
      HelloPayloadSchema.parse({ protocolVersion: 1, client: 'main-renderer' }),
    ).toEqual({ protocolVersion: 1, client: 'main-renderer' })
    expect(
      HelloResultSchema.parse({
        protocolVersion: 1,
        message: 'hello from CR Tools V2',
      }),
    ).toBeDefined()
  })

  it('rejects unknown contract fields and invalid lifecycle values', () => {
    expect(() =>
      HelloPayloadSchema.parse({
        protocolVersion: 1,
        client: 'main-renderer',
        token: 'not-allowed',
      }),
    ).toThrow()
    expect(() =>
      AppSnapshotResultSchema.parse({
        lifecycle: 'STARTED',
        version: '0.1.0',
        settingsVersion: 1,
      }),
    ).toThrow()
  })
})

describe('review regression application setting patches', () => {
  it('#18 rejects explicit undefined instead of resetting a saved setting to its default', () => {
    expect(AppSettingsUpdateSchema.safeParse({ closeToTray: undefined }).success).toBe(
      false,
    )
    expect(AppSettingsUpdateSchema.parse({ closeToTray: false })).toEqual({
      closeToTray: false,
    })
    expect(AppSettingsUpdateSchema.parse({})).toEqual({})
  })
})
