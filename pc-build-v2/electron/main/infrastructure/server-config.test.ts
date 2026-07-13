import { describe, expect, it } from 'vitest'

import {
  PRODUCTION_API_URL,
  PRODUCTION_WS_URL,
  parseProductionServerUrl,
} from './server-config'

describe('production server config', () => {
  it('normalizes the exact HTTPS production origin to its WSS endpoint', () => {
    expect(parseProductionServerUrl('https://api.artcsworld.xyz/')).toEqual({
      apiUrl: PRODUCTION_API_URL,
      webSocketUrl: PRODUCTION_WS_URL,
    })
  })

  it.each([
    'http://api.artcsworld.xyz',
    'https://user:pass@api.artcsworld.xyz',
    'https://api.artcsworld.xyz.evil.example',
    'https://api.artcsworld.xyz:444',
    'https://api.artcsworld.xyz/api',
    'https://api.artcsworld.xyz?server=evil',
  ])('rejects an unsafe server URL: %s', (url) => {
    expect(() => parseProductionServerUrl(url)).toThrow()
  })
})
