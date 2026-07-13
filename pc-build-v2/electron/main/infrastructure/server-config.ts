import { ApplicationError } from '../../../shared/errors/application-error'

export const PRODUCTION_API_URL = 'https://api.artcsworld.xyz' as const
export const PRODUCTION_WS_URL = 'wss://api.artcsworld.xyz/ws' as const

export interface ServerConfig {
  readonly apiUrl: typeof PRODUCTION_API_URL
  readonly webSocketUrl: typeof PRODUCTION_WS_URL
}

const TRUSTED_HOSTS = new Set(['api.artcsworld.xyz'])

export function parseProductionServerUrl(input: string): ServerConfig {
  let url: URL
  try {
    url = new URL(input)
  } catch (cause) {
    throw new ApplicationError('SERVER_URL_INVALID', 'Server URL is invalid', { cause })
  }

  const valid =
    url.protocol === 'https:' &&
    TRUSTED_HOSTS.has(url.hostname) &&
    url.port === '' &&
    url.username === '' &&
    url.password === '' &&
    (url.pathname === '' || url.pathname === '/') &&
    url.search === '' &&
    url.hash === ''

  if (!valid) {
    throw new ApplicationError(
      'SERVER_URL_NOT_ALLOWED',
      'Only the CR Tools production API origin is allowed',
    )
  }

  return Object.freeze({
    apiUrl: PRODUCTION_API_URL,
    webSocketUrl: PRODUCTION_WS_URL,
  })
}

export function createProductionServerConfig(): ServerConfig {
  return parseProductionServerUrl(PRODUCTION_API_URL)
}
