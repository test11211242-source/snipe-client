import { useId, useState } from 'react'

import {
  MAX_STREAMER_ACCOUNTS,
  GAME_ACCOUNT_TAG_PATTERN,
  type StreamerView,
} from '../../../../shared/models/streamer'
import { Button } from '../ui'
import type { StreamerRunner } from './types'

const ACCOUNT_ERROR_MESSAGES = {
  ACCOUNT_TAG_INVALID: 'Проверьте формат тега Clash Royale.',
  ACCOUNT_NOT_FOUND: 'Аккаунт с таким тегом не найден в Clash Royale.',
  ACCOUNT_LIMIT_REACHED: 'Достигнут лимит аккаунтов. Удалите ненужный аккаунт.',
  CLASH_API_UNAVAILABLE: 'API Clash Royale временно недоступен. Повторите позже.',
  ACCOUNT_SAVE_UNAVAILABLE: 'Не удалось сохранить аккаунт. Повторите позже.',
  UNAUTHORIZED: 'Требуется повторный вход.',
  FORBIDDEN: 'Добавление аккаунтов недоступно для этого профиля.',
  STREAMER_ROLE_REQUIRED: 'Для добавления аккаунтов требуется роль стримера.',
  STREAMER_CANCELLED: 'Добавление отменено при смене профиля.',
  UNKNOWN: 'Сервер не подтвердил сохранение аккаунта. Повторите попытку.',
} as const

export function AccountManager({
  accounts,
  busy,
  run,
  embedded = false,
}: {
  accounts: StreamerView['title']['accounts']
  busy: string | null
  run: StreamerRunner
  embedded?: boolean
}): React.JSX.Element {
  const [tag, setTag] = useState('')
  const [alias, setAlias] = useState('')
  const tagErrorId = useId()
  const [accountMessage, setAccountMessage] = useState<{
    text: string
    warning: boolean
  } | null>(null)
  const tagInvalid = tag.trim().length > 0 && !GAME_ACCOUNT_TAG_PATTERN.test(tag.trim())
  const limitReached = accounts.length >= MAX_STREAMER_ACCOUNTS

  const addAccount = async (): Promise<void> => {
    setAccountMessage(null)
    const result = await run('account-add', async () => {
      const response = await window.crTools.addStreamTitleAccount({
        tag: tag.trim(),
        alias: alias.trim(),
      })
      if (!response.ok) {
        setAccountMessage({
          text: ACCOUNT_ERROR_MESSAGES[response.error.code],
          warning: false,
        })
        return null
      }
      if (response.warning !== null) {
        setAccountMessage({
          text:
            response.warning === 'TITLE_UPDATE_FAILED'
              ? 'Аккаунт сохранён, но название Twitch не обновлено.'
              : 'Аккаунт сохранён, но список не удалось обновить. Обновите данные.',
          warning: true,
        })
      }
      return response.view
    })
    if (result !== null) {
      setTag('')
      setAlias('')
    }
  }

  return (
    <section
      className={embedded ? 'streamer-accounts-manager' : 'streamer-panel accounts-panel'}
    >
      <div className="streamer-section-heading compact">
        <div>
          <span className="eyebrow">CLASH ROYALE</span>
          <h2>Аккаунты стримера</h2>
        </div>
        <span className="context-count">
          {accounts.length}/{MAX_STREAMER_ACCOUNTS}
        </span>
      </div>
      <p className="streamer-lead compact-lead">
        Включённые аккаунты отслеживаются, когда канал онлайн и активна автоматизация
        названия или статистика OBS. Активный определяется по последнему новому бою.
      </p>
      <div className="account-add">
        <label>
          Тег аккаунта
          <input
            aria-describedby={tagInvalid ? tagErrorId : undefined}
            aria-invalid={tagInvalid}
            value={tag}
            maxLength={20}
            placeholder="#TAG"
            disabled={busy !== null || limitReached}
            onChange={(event) => {
              setTag(event.target.value)
              setAccountMessage(null)
            }}
          />
          {tagInvalid && (
            <small className="field-error" id={tagErrorId}>
              Проверьте формат тега Clash Royale.
            </small>
          )}
        </label>
        <label>
          Отображаемое имя
          <input
            value={alias}
            maxLength={100}
            placeholder="Основной"
            disabled={busy !== null || limitReached}
            onChange={(event) => {
              setAlias(event.target.value)
              setAccountMessage(null)
            }}
          />
        </label>
        <Button
          variant="primary"
          disabled={busy !== null || limitReached || tag.trim().length < 2 || tagInvalid}
          onClick={() => void addAccount()}
        >
          Добавить аккаунт
        </Button>
      </div>
      {accountMessage !== null && (
        <small
          className={
            accountMessage.warning ? 'streamer-lead compact-lead' : 'field-error'
          }
          role="status"
        >
          {accountMessage.text}
        </small>
      )}
      {limitReached && (
        <small className="field-error" role="status">
          Достигнут лимит: {MAX_STREAMER_ACCOUNTS} аккаунтов. Удалите ненужный аккаунт,
          чтобы добавить новый.
        </small>
      )}
      {accounts.length === 0 ? (
        <div className="streamer-empty compact-empty">
          <strong>Аккаунтов пока нет</strong>
          <span>Добавьте все аккаунты, между которыми переключается игрок.</span>
        </div>
      ) : (
        <div className="account-list">
          {accounts.map((account) => (
            <div key={account.tag}>
              <span>
                <strong>{account.alias || account.name || account.tag}</strong>
                <small>
                  {account.tag} · {account.enabled ? 'включён' : 'отключён'} ·{' '}
                  {account.currentRank === null
                    ? 'место неизвестно'
                    : `место ${account.currentRank}`}{' '}
                  · {account.currentElo ?? 'ELO неизвестен'}
                </small>
              </span>
              <button
                type="button"
                disabled={busy !== null}
                onClick={() => {
                  if (account.enabled) {
                    void run('account-remove', () =>
                      window.crTools.removeStreamTitleAccount(account.tag),
                    )
                  } else {
                    setAccountMessage(null)
                    void run('account-enable', async () => {
                      const response = await window.crTools.addStreamTitleAccount({
                        tag: account.tag,
                        alias: account.alias || account.name,
                      })
                      if (!response.ok) {
                        setAccountMessage({
                          text: ACCOUNT_ERROR_MESSAGES[response.error.code],
                          warning: false,
                        })
                        return null
                      }
                      if (response.warning !== null)
                        setAccountMessage({
                          text:
                            response.warning === 'TITLE_UPDATE_FAILED'
                              ? 'Аккаунт сохранён, но название Twitch не обновлено.'
                              : 'Аккаунт сохранён, но список не удалось обновить. Обновите данные.',
                          warning: true,
                        })
                      return response.view
                    })
                  }
                }}
              >
                {account.enabled ? 'Удалить' : 'Включить'}
              </button>
            </div>
          ))}
        </div>
      )}
    </section>
  )
}
