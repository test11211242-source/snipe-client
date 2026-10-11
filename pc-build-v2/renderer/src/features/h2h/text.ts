import type { H2HState } from './useH2H'

export const H2H_DISCLAIMER = 'по записанным боям Пути легенд'

/** Plain-language reason for every non-data outcome. Never claims a player does not exist. */
export function unavailableText(state: H2HState): { title: string; text: string } {
  if (state.kind === 'idle')
    return {
      title: 'Встречи недоступны',
      text: 'У этого соперника нет тега, поэтому записанные бои найти нельзя.',
    }
  if (state.kind === 'unavailable' && state.reason === 'rate_limited')
    return {
      title: 'Личные встречи сейчас недоступны',
      text: 'Слишком много запросов. Данные появятся чуть позже.',
    }
  if (state.kind === 'unavailable' && state.reason === 'unsupported')
    return {
      title: 'Личные встречи сейчас недоступны',
      text: 'Сервер пока не поддерживает этот раздел.',
    }
  if (state.kind === 'data' && state.data.status === 'unavailable')
    return {
      title: 'Личные встречи сейчас недоступны',
      text: 'Сервис личных встреч временно недоступен. Попробуйте позже.',
    }
  return {
    title: 'Личные встречи сейчас недоступны',
    text: 'Сервер не ответил. Попробуйте позже, остальное работает.',
  }
}
