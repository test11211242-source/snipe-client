import type { z } from 'zod'

import { createApiError, type ApiError } from '../../../shared/errors/api-error'
import type { ServerConfig } from '../infrastructure/server-config'

export type ApiResult<T> =
  | { readonly ok: true; readonly status: number; readonly data: T }
  | { readonly ok: false; readonly error: ApiError }

export interface ApiRequest<T> {
  method: 'GET' | 'POST' | 'PUT' | 'DELETE'
  path: `/api/${string}`
  schema: z.ZodType<T>
  body?: unknown
  query?: Readonly<Record<string, string | number | boolean | undefined>>
  accessToken?: string
  timeoutMs?: number
  signal?: AbortSignal
}

export interface ApiClientLogger {
  debug: (message: string, context?: unknown) => void
  warn: (message: string, context?: unknown) => void
}

const DEFAULT_TIMEOUT_MS = 15_000
const DEFAULT_MAX_JSON_BYTES = 512 * 1024
const MAX_MULTIPART_BYTES = 11 * 1024 * 1024

function readServerMessage(value: unknown): string | undefined {
  if (value === null || typeof value !== 'object') return undefined
  const record = value as Record<string, unknown>
  for (const key of ['message', 'detail', 'error']) {
    const candidate = record[key]
    if (
      typeof candidate === 'string' &&
      candidate.length > 0 &&
      candidate.length <= 300
    ) {
      return candidate
    }
  }
  return undefined
}

function statusError(status: number, body: unknown): ApiError {
  const serverMessage = readServerMessage(body)
  if (status === 401) {
    return createApiError(
      'UNAUTHORIZED',
      serverMessage ?? 'Требуется повторный вход',
      false,
      401,
    )
  }
  if (status === 403) {
    return createApiError('FORBIDDEN', serverMessage ?? 'Доступ заблокирован', false, 403)
  }
  if (status === 400 || status === 409 || status === 422) {
    return createApiError(
      'VALIDATION_FAILED',
      serverMessage ?? 'Сервер отклонил введённые данные',
      false,
      status,
    )
  }
  return createApiError(
    'SERVER_ERROR',
    serverMessage ?? 'Сервис временно недоступен',
    status >= 500,
    status,
  )
}

async function readBoundedBody(
  response: Response,
  maxBytes: number,
): Promise<string | null> {
  if (response.body === null) return ''
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let totalBytes = 0
  try {
    let result = await reader.read()
    while (!result.done) {
      totalBytes += result.value.byteLength
      if (totalBytes > maxBytes) {
        await reader.cancel().catch(() => undefined)
        return null
      }
      chunks.push(result.value)
      result = await reader.read()
    }
  } finally {
    reader.releaseLock()
  }
  return Buffer.concat(chunks, totalBytes).toString('utf8')
}

export class ApiClient {
  constructor(
    private readonly config: ServerConfig,
    private readonly fetchImplementation: typeof fetch,
    private readonly logger: ApiClientLogger,
    private readonly maxJsonBytes = DEFAULT_MAX_JSON_BYTES,
  ) {}

  async request<T>(request: ApiRequest<T>): Promise<ApiResult<T>> {
    if (
      !request.path.startsWith('/api/') ||
      request.path.includes('://') ||
      request.path.includes('..') ||
      request.path.includes('?') ||
      request.path.includes('#')
    ) {
      return {
        ok: false,
        error: createApiError('VALIDATION_FAILED', 'Некорректный путь API', false),
      }
    }

    const controller = new AbortController()
    const timeoutReason = new Error('request timeout')
    const abortFromCaller = (): void => controller.abort()
    request.signal?.addEventListener('abort', abortFromCaller, { once: true })
    if (request.signal?.aborted === true) controller.abort()
    const timeout = setTimeout(() => {
      controller.abort(timeoutReason)
    }, request.timeoutMs ?? DEFAULT_TIMEOUT_MS)
    const headers: Record<string, string> = { Accept: 'application/json' }
    if (request.body !== undefined && !(request.body instanceof FormData)) {
      headers['Content-Type'] = 'application/json'
    }
    if (request.accessToken !== undefined) {
      headers['Authorization'] = `Bearer ${request.accessToken}`
    }

    this.logger.debug('API request started', {
      method: request.method,
      path: request.path,
      authenticated: request.accessToken !== undefined,
    })

    try {
      let encodedBody: BodyInit | undefined
      if (request.body instanceof FormData) {
        let totalBytes = 0
        for (const [, value] of request.body.entries()) {
          totalBytes +=
            typeof value === 'string' ? Buffer.byteLength(value, 'utf8') : value.size
          if (totalBytes > MAX_MULTIPART_BYTES) {
            return {
              ok: false,
              error: createApiError(
                'VALIDATION_FAILED',
                'Тело запроса превышает допустимый размер',
                false,
              ),
            }
          }
        }
        encodedBody = request.body
      } else if (request.body !== undefined) {
        const jsonBody = JSON.stringify(request.body)
        if (Buffer.byteLength(jsonBody, 'utf8') > this.maxJsonBytes) {
          return {
            ok: false,
            error: createApiError(
              'VALIDATION_FAILED',
              'Тело запроса превышает допустимый размер',
              false,
            ),
          }
        }
        encodedBody = jsonBody
      }
      const init: RequestInit = {
        method: request.method,
        headers,
        signal: controller.signal,
      }
      if (encodedBody !== undefined) init.body = encodedBody
      const url = new URL(`${this.config.apiUrl}${request.path}`)
      for (const [key, value] of Object.entries(request.query ?? {})) {
        if (!/^[a-zA-Z][a-zA-Z0-9_]*$/.test(key)) {
          return {
            ok: false,
            error: createApiError(
              'VALIDATION_FAILED',
              'Некорректный параметр API',
              false,
            ),
          }
        }
        if (value !== undefined) url.searchParams.set(key, String(value))
      }
      const response = await this.fetchImplementation(url.href, init)

      const declaredLength = Number(response.headers.get('content-length'))
      if (Number.isFinite(declaredLength) && declaredLength > this.maxJsonBytes) {
        await response.body?.cancel().catch(() => undefined)
        return {
          ok: false,
          error: createApiError(
            'RESPONSE_TOO_LARGE',
            'Ответ сервера превышает допустимый размер',
            false,
          ),
        }
      }

      const text = await readBoundedBody(response, this.maxJsonBytes)
      if (text === null) {
        return {
          ok: false,
          error: createApiError(
            'RESPONSE_TOO_LARGE',
            'Ответ сервера превышает допустимый размер',
            false,
          ),
        }
      }

      let json: unknown = null
      if (text.length > 0) {
        try {
          json = JSON.parse(text) as unknown
        } catch {
          return {
            ok: false,
            error: createApiError(
              'INVALID_RESPONSE',
              'Сервер вернул некорректный JSON',
              true,
            ),
          }
        }
      }

      if (!response.ok) return { ok: false, error: statusError(response.status, json) }

      const parsed = request.schema.safeParse(json)
      if (!parsed.success) {
        this.logger.warn('API response contract rejected', {
          path: request.path,
          status: response.status,
        })
        return {
          ok: false,
          error: createApiError(
            'INVALID_RESPONSE',
            'Ответ сервера не соответствует ожидаемому формату',
            true,
            response.status,
          ),
        }
      }
      return { ok: true, status: response.status, data: parsed.data }
    } catch (error) {
      if (controller.signal.aborted) {
        return {
          ok: false,
          error:
            controller.signal.reason === timeoutReason
              ? createApiError('REQUEST_TIMEOUT', 'Сервер не ответил вовремя', true)
              : createApiError('AUTH_CANCELLED', 'Операция отменена', false),
        }
      }
      this.logger.warn('API request failed', { path: request.path, error })
      return {
        ok: false,
        error: createApiError(
          'NETWORK_UNAVAILABLE',
          'Нет соединения с сервером. Проверьте сеть и повторите попытку.',
          true,
        ),
      }
    } finally {
      clearTimeout(timeout)
      request.signal?.removeEventListener('abort', abortFromCaller)
    }
  }
}

export interface AccessTokenProvider {
  getAccessToken: (forceRefresh?: boolean) => Promise<string | null>
}

export class AuthenticatedApiClient {
  constructor(
    private readonly api: ApiClient,
    private readonly auth: AccessTokenProvider,
  ) {}

  async request<T>(request: Omit<ApiRequest<T>, 'accessToken'>): Promise<ApiResult<T>> {
    const token = await this.auth.getAccessToken()
    if (token === null) {
      return {
        ok: false,
        error: createApiError('UNAUTHORIZED', 'Требуется повторный вход', false, 401),
      }
    }
    const first = await this.api.request({ ...request, accessToken: token })
    if (first.ok || first.error.code !== 'UNAUTHORIZED' || request.signal?.aborted) {
      return first
    }
    const refreshed = await this.auth.getAccessToken(true)
    if (refreshed === null) return first
    return this.api.request({ ...request, accessToken: refreshed })
  }
}
