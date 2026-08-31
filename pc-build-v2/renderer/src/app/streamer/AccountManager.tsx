import { useId, useState } from 'react'

import {
  MAX_STREAMER_ACCOUNTS,
  type StreamerView,
} from '../../../../shared/models/streamer'
import { Button } from '../ui'
import type { StreamerRunner } from './types'

const TAG_PATTERN = /^#?[0289PYLQGRJCUV]+$/i

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
  const tagInvalid = tag.trim().length > 0 && !TAG_PATTERN.test(tag.trim())
  const limitReached = accounts.length >= MAX_STREAMER_ACCOUNTS

  const addAccount = async (): Promise<void> => {
    const result = await run('account-add', () =>
      window.crTools.addStreamTitleAccount({ tag: tag.trim(), alias: alias.trim() }),
    )
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
            onChange={(event) => setTag(event.target.value)}
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
            onChange={(event) => setAlias(event.target.value)}
          />
        </label>
        <Button
          variant="primary"
          disabled={
            busy !== null || limitReached || tag.trim().length < 2 || tagInvalid
          }
          onClick={() => void addAccount()}
        >
          Добавить аккаунт
        </Button>
      </div>
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
                    void run('account-enable', () =>
                      window.crTools.addStreamTitleAccount({
                        tag: account.tag,
                        alias: account.alias || account.name,
                      }),
                    )
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
