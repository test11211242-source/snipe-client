import { describe, expect, it } from 'vitest'

import { sessionView } from '../../test/setupFake'
import {
  commandErrorMessage,
  isStaleCause,
  saveRetryable,
  viewErrorMessage,
} from './errors'
import { describeOutcome } from './outcome'

const committed = (
  saveOutcome: NonNullable<ReturnType<typeof sessionView>['saveOutcome']>,
  extra: Partial<ReturnType<typeof sessionView>> = {},
) => sessionView({ state: 'COMMITTED', saveOutcome, ...extra })

describe('describeOutcome', () => {
  it('is clean only when synchronization and runtime are fine', () => {
    const outcome = describeOutcome(
      committed({
        local: 'saved',
        projection: 'synced',
        runtime: 'ready',
        warning: null,
      }),
    )
    expect(outcome.tone).toBe('ok')
    expect(outcome.notes).toEqual([])
    expect(outcome.canRetrySync).toBe(false)
    expect(outcome.lines.map((line) => line.value)).toEqual([
      'сохранено',
      'синхронизировано',
      'готов к работе',
    ])
  })

  it('does not treat COMMITTED as synchronized', () => {
    const outcome = describeOutcome(
      committed({
        local: 'saved',
        projection: 'failed',
        runtime: 'ready',
        warning: 'SETUP_SYNC_FAILED',
      }),
    )
    expect(outcome.tone).toBe('warn')
    expect(outcome.title).toBe('Профиль сохранён на этом компьютере')
    expect(outcome.canRetrySync).toBe(true)
    expect(outcome.lines[1]).toMatchObject({ value: 'не отправлено', tone: 'warn' })
  })

  it('blocks the resend of an obsolete projection', () => {
    const outcome = describeOutcome(
      committed(
        {
          local: 'saved',
          projection: 'failed',
          runtime: 'ready',
          warning: 'SETUP_SYNC_FAILED',
        },
        { error: { code: 'CAPTURE_PROFILE_STALE', message: 'stale' } },
      ),
    )
    expect(outcome.canRetrySync).toBe(false)
    expect(outcome.notes[0]?.title).toBe('Отправку повторить нельзя')
  })

  it('reports runtime states separately', () => {
    expect(
      describeOutcome(
        committed({
          local: 'saved',
          projection: 'synced',
          runtime: 'waiting_source',
          warning: null,
        }),
      ).notes[0]?.title,
    ).toBe('Мониторинг ждёт окно игры')
    expect(
      describeOutcome(
        committed({
          local: 'saved',
          projection: 'synced',
          runtime: 'failed',
          warning: 'SETUP_RUNTIME_FAILED',
        }),
      ).notes[0]?.title,
    ).toBe('Мониторинг не запустился')
    const untouched = describeOutcome(
      committed({
        local: 'saved',
        projection: 'not_required',
        runtime: 'not_requested',
        warning: null,
      }),
    )
    expect(untouched.tone).toBe('ok')
    expect(untouched.lines.map((line) => line.value)).toContain('не затронут')
  })

  it('reports an unsaved result as danger and uses the result wording', () => {
    const outcome = describeOutcome(
      committed(
        {
          local: 'failed',
          projection: 'not_attempted',
          runtime: 'not_requested',
          warning: null,
        },
        { kind: 'predictionResult' },
      ),
    )
    expect(outcome.tone).toBe('danger')
    expect(outcome.title).toBe('Зоны результата не сохранены')
    expect(outcome.canRetrySync).toBe(false)
  })

  it('has a plain message when main sent no outcome', () => {
    expect(describeOutcome(sessionView({ state: 'COMMITTED' })).title).toBe(
      'Профиль сохранён',
    )
  })
})

describe('setup error wording', () => {
  it('maps main codes to Russian and leaves unknown codes to the caller', () => {
    expect(
      viewErrorMessage({ code: 'CAPTURE_PROFILE_NAME_CONFLICT', message: 'x' }),
    ).toMatch(/название/)
    expect(viewErrorMessage({ code: 'SOMETHING_NEW', message: 'x' })).toBeNull()
  })

  it('recognizes stale causes and retryable saves', () => {
    expect(isStaleCause(new Error('Setup command is stale'))).toBe(true)
    expect(isStaleCause(new Error('network'))).toBe(false)
    expect(saveRetryable('CAPTURE_PROFILE_STALE')).toBe(false)
    expect(saveRetryable('CAPTURE_PROFILE_LIMIT')).toBe(false)
    expect(saveRetryable('SETUP_FAILED')).toBe(true)
    expect(saveRetryable(undefined)).toBe(true)
  })

  it('never leaks a raw error message', () => {
    expect(commandErrorMessage(new Error('secret path C:\\x'), 'Повторите.')).toBe(
      'Повторите.',
    )
  })
})
