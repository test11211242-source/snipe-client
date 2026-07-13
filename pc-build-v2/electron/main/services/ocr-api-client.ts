import { randomUUID } from 'node:crypto'

import {
  MonitorResultSchema,
  type DeckMode,
  type MonitorResult,
  type SearchMode,
} from '../../../shared/models/monitor'
import type { ServerConfig } from '../infrastructure/server-config'
import type { AuthSession } from './auth-session'

const MAX_IMAGE_BYTES = 10 * 1024 * 1024
const MAX_IMAGE_PIXELS = 20_000_000
const MAX_RESPONSE_BYTES = 1024 * 1024
const OCR_TIMEOUT_MS = 150_000

export interface OcrLogger {
  debug: (message: string, context?: unknown) => void
  warn: (message: string, context?: unknown) => void
}

export interface OcrRequest {
  image: Buffer
  timestamp: string
  searchMode: SearchMode
  deckMode: DeckMode
  signal: AbortSignal
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function safeText(value: unknown, max = 160): string | null {
  if (typeof value !== 'string') return null
  const normalized = Array.from(value)
    .map((character) => {
      const code = character.charCodeAt(0)
      return code < 32 || code === 127 ? ' ' : character
    })
    .join('')
    .trim()
    .slice(0, max)
  return normalized.length > 0 ? normalized : null
}

function safeInteger(value: unknown, max = 100_000): number | null {
  const number = typeof value === 'number' ? value : Number(value)
  return Number.isInteger(number) && number >= 0 && number <= max ? number : null
}

function pngDimensions(image: Buffer): { width: number; height: number } | null {
  if (
    image.byteLength < 24 ||
    !image.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ||
    image.subarray(12, 16).toString('ascii') !== 'IHDR'
  ) {
    return null
  }
  return { width: image.readUInt32BE(16), height: image.readUInt32BE(20) }
}

async function boundedText(response: Response): Promise<string | null> {
  const declared = Number(response.headers.get('content-length'))
  if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) {
    await response.body?.cancel().catch(() => undefined)
    return null
  }
  if (response.body === null) return ''
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    for (;;) {
      const next = await reader.read()
      if (next.done) break
      total += next.value.byteLength
      if (total > MAX_RESPONSE_BYTES) {
        await reader.cancel().catch(() => undefined)
        return null
      }
      chunks.push(next.value)
    }
  } finally {
    reader.releaseLock()
  }
  return Buffer.concat(chunks, total).toString('utf8')
}

function serviceResult(
  request: Omit<OcrRequest, 'image' | 'signal'>,
  message: string,
  retryable: boolean,
  authBlocked = false,
): MonitorResult {
  return MonitorResultSchema.parse({
    id: randomUUID(),
    kind: 'service_error',
    timestamp: request.timestamp,
    searchMode: request.searchMode,
    deckMode: request.deckMode,
    searchedNickname: null,
    message: message.slice(0, 160),
    retryable,
    authBlocked,
  })
}

function normalizeDecks(value: unknown): unknown[] {
  if (!Array.isArray(value)) return []
  return value.slice(0, 5).map((rawDeck) => {
    const deck = record(rawDeck) ?? {}
    const cards = Array.isArray(deck['cards']) ? deck['cards'] : []
    return {
      label: safeText(deck['name'] ?? deck['mode'] ?? deck['type']),
      cards: cards.slice(0, 8).flatMap((rawCard) => {
        const card = record(rawCard)
        if (card === null) return []
        const name = safeText(card['name'])
        if (name === null) return []
        const rawUrl = safeText(card['display_icon_url'] ?? card['icon_url'], 500)
        let iconUrl: string | null = null
        if (rawUrl !== null) {
          try {
            const parsed = new URL(rawUrl)
            if (parsed.protocol === 'https:') iconUrl = parsed.toString()
          } catch {
            iconUrl = null
          }
        }
        return [
          {
            name,
            level: safeInteger(card['level'], 100),
            evolutionLevel: safeInteger(card['evolution_level'], 10),
            iconUrl,
          },
        ]
      }),
    }
  })
}

export function normalizeOcrResponse(
  value: unknown,
  request: Omit<OcrRequest, 'image' | 'signal'>,
): MonitorResult {
  const body = record(value)
  if (body === null) {
    return serviceResult(request, 'Сервис распознавания вернул некорректный ответ', true)
  }
  const ocr = record(body['ocr_result'])
  const directPlayer = record(body['player'])
  const search = record(body['search_result'])
  const bestMatch = record(search?.['best_match'])
  const player = directPlayer ?? bestMatch
  const searchedNickname = safeText(body['searched_nickname'] ?? ocr?.['nickname'])
  const common = {
    id: randomUUID(),
    timestamp: request.timestamp,
    searchMode: request.searchMode,
    deckMode: request.deckMode,
    searchedNickname,
  }

  if (body['success'] === true && player !== null) {
    const name = safeText(player['name'] ?? player['nickname'])
    if (name === null) {
      return serviceResult(request, 'Сервис вернул результат игрока без имени', true)
    }
    return MonitorResultSchema.parse({
      ...common,
      kind: 'player_found',
      player: {
        name,
        tag: safeText(player['tag']),
        rating: safeInteger(player['rating'] ?? player['trophies']),
        clan: safeText(player['clan_name'] ?? player['clan']),
      },
      decks: normalizeDecks(body['decks']),
    })
  }

  if (body['player_not_found'] === true) {
    return MonitorResultSchema.parse({
      ...common,
      kind: 'player_not_found',
      message: safeText(body['error'] ?? search?.['message']) ?? 'Игрок не найден',
    })
  }

  if (ocr?.['found'] === false || body['success'] === false) {
    return MonitorResultSchema.parse({
      ...common,
      kind: 'recognition_failed',
      message:
        safeText(body['error'] ?? ocr?.['error'] ?? ocr?.['reason']) ??
        'Данные игрока не распознаны',
    })
  }

  return serviceResult(request, 'Сервис распознавания вернул неполный ответ', true)
}

export class OcrApiClient {
  constructor(
    private readonly fetchImplementation: typeof fetch,
    private readonly auth: Pick<AuthSession, 'getAccessToken'>,
    private readonly config: ServerConfig,
    private readonly logger: OcrLogger,
  ) {}

  async process(request: OcrRequest): Promise<MonitorResult> {
    const dimensions = pngDimensions(request.image)
    if (
      request.image.byteLength === 0 ||
      request.image.byteLength > MAX_IMAGE_BYTES ||
      dimensions === null ||
      dimensions.width > 8192 ||
      dimensions.height > 8192 ||
      dimensions.width * dimensions.height > MAX_IMAGE_PIXELS
    ) {
      return serviceResult(request, 'Изображение превышает безопасные лимиты', false)
    }
    let token = await this.auth.getAccessToken()
    if (token === null)
      return serviceResult(request, 'Требуется повторный вход', false, true)
    let response = await this.send(request, token)
    if (
      response instanceof Response &&
      response.status === 401 &&
      !request.signal.aborted
    ) {
      await response.body?.cancel().catch(() => undefined)
      token = await this.auth.getAccessToken(true)
      if (token === null)
        return serviceResult(request, 'Сеанс истёк. Войдите снова', false, true)
      response = await this.send(request, token)
    }
    if (!(response instanceof Response)) return response
    if (response.status === 401 || response.status === 403) {
      await response.body?.cancel().catch(() => undefined)
      return serviceResult(request, 'Доступ к распознаванию заблокирован', false, true)
    }
    let text: string | null
    try {
      text = await boundedText(response)
    } catch (error) {
      this.logger.warn('OCR response stream failed', {
        endpoint: '/api/ocr/process',
        error,
      })
      return serviceResult(request, 'Соединение прервалось во время ответа OCR', true)
    }
    if (text === null)
      return serviceResult(request, 'Ответ сервиса слишком большой', false)
    let json: unknown
    try {
      json = text.length > 0 ? (JSON.parse(text) as unknown) : null
    } catch {
      return serviceResult(request, 'Сервис распознавания вернул некорректный JSON', true)
    }
    if (!response.ok) {
      return serviceResult(
        request,
        response.status >= 500
          ? 'Сервис распознавания временно недоступен'
          : 'Сервис отклонил запрос',
        response.status >= 500 || response.status === 429,
      )
    }
    return normalizeOcrResponse(json, request)
  }

  private async send(
    request: OcrRequest,
    token: string,
  ): Promise<Response | MonitorResult> {
    const controller = new AbortController()
    const timeoutReason = new Error('ocr timeout')
    const cancel = (): void => controller.abort(request.signal.reason)
    request.signal.addEventListener('abort', cancel, { once: true })
    if (request.signal.aborted) cancel()
    const timer = setTimeout(() => controller.abort(timeoutReason), OCR_TIMEOUT_MS)
    const form = new FormData()
    form.append(
      'image',
      new Blob([Uint8Array.from(request.image)], { type: 'image/png' }),
      'capture.png',
    )
    form.append('timestamp', request.timestamp)
    form.append('search_mode', request.searchMode)
    form.append('deck_mode', request.deckMode)
    this.logger.debug('OCR request started', {
      endpoint: '/api/ocr/process',
      imageBytes: request.image.byteLength,
      searchMode: request.searchMode,
      deckMode: request.deckMode,
    })
    try {
      return await this.fetchImplementation(`${this.config.apiUrl}/api/ocr/process`, {
        method: 'POST',
        headers: { Accept: 'application/json', Authorization: `Bearer ${token}` },
        body: form,
        signal: controller.signal,
      })
    } catch (error) {
      if (controller.signal.aborted) {
        return serviceResult(
          request,
          controller.signal.reason === timeoutReason
            ? 'Распознавание не завершилось за 150 секунд'
            : 'Распознавание отменено',
          controller.signal.reason === timeoutReason,
        )
      }
      this.logger.warn('OCR request failed', { endpoint: '/api/ocr/process', error })
      return serviceResult(request, 'Нет соединения с сервисом распознавания', true)
    } finally {
      clearTimeout(timer)
      request.signal.removeEventListener('abort', cancel)
    }
  }
}
