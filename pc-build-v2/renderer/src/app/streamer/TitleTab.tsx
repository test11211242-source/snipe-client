import { useId, useState } from 'react'

import type {
  StreamerView,
  StreamTitleSettings,
} from '../../../../shared/models/streamer'
import { Button, Status } from '../ui'
import {
  ConfirmedButton,
  DraftStatus,
  NumberField,
  Select,
  StreamerToggle,
} from './controls'
import { useDraft } from './state'
import type { StreamerRunner } from './types'

const TAG_PATTERN = /^#?[0289PYLQGRJCUV]+$/i

export function TitleTab({
  view,
  busy,
  run,
}: {
  view: StreamerView
  busy: string | null
  run: StreamerRunner
}): React.JSX.Element {
  const { draft: settings, setDraft: setSettings, dirty } = useDraft(view.title.settings)
  const [tag, setTag] = useState('')
  const [alias, setAlias] = useState('')
  const [invalidFields, setInvalidFields] = useState<ReadonlySet<string>>(new Set())
  const tagErrorId = useId()
  const tagInvalid = tag.trim().length > 0 && !TAG_PATTERN.test(tag.trim())
  const accountLimitReached = view.title.accounts.length >= 4
  const manualTagInvalid =
    settings.accountDisplayMode === 'manual' &&
    !TAG_PATTERN.test(settings.manualAccountTag.trim())
  const invalid = invalidFields.size > 0 || manualTagInvalid

  const setValidity = (fieldKey: string, fieldInvalid: boolean): void => {
    setInvalidFields((current) => {
      const next = new Set(current)
      if (fieldInvalid) next.add(fieldKey)
      else next.delete(fieldKey)
      return next
    })
  }

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
    <div className="streamer-context-layout title-layout">
      <section className="streamer-panel streamer-context-main title-control-panel">
        <div className="streamer-section-heading">
          <div>
            <span className="eyebrow">НАЗВАНИЕ КАНАЛА</span>
            <h2>Автоматическое название</h2>
          </div>
          <StreamerToggle
            label="Автоматизация"
            checked={settings.enabled}
            disabled={busy !== null || !view.twitch.connected}
            onChange={(enabled) => {
              setSettings({ ...settings, enabled })
              void run('title-enabled', () =>
                window.crTools.setStreamTitleEnabled(enabled),
              )
            }}
          />
        </div>
        <div className="title-runtime-strip">
          <Status
            label={view.title.twitchOnline ? 'Канал онлайн' : 'Канал офлайн'}
            tone={view.title.twitchOnline ? 'success' : 'neutral'}
          />
          <Status
            label={settings.paused ? 'Обновления на паузе' : 'Обновления разрешены'}
            tone={settings.paused ? 'warning' : 'success'}
          />
        </div>
        <span className="field-caption">Проверка названия</span>
        <div className="title-preview">
          {view.title.previewTitle || 'Название появится после добавления аккаунта'}
        </div>
        <TitleFields
          value={settings}
          onChange={setSettings}
          disabled={busy !== null}
          onValidityChange={setValidity}
          manualTagInvalid={manualTagInvalid}
        />
        <div className="draft-row">
          <DraftStatus dirty={dirty} invalid={invalid} />
        </div>
        <div className="streamer-action-row title-primary-actions">
          <Button
            variant="primary"
            disabled={busy !== null || !dirty || invalid}
            onClick={() =>
              void run('title-save', () => window.crTools.updateStreamTitle(settings))
            }
          >
            Сохранить название
          </Button>
          <Button
            disabled={busy !== null}
            onClick={() => {
              const paused = !settings.paused
              setSettings({ ...settings, paused })
              void run('title-pause', () => window.crTools.setStreamTitlePaused(paused))
            }}
          >
            {settings.paused ? 'Продолжить обновления' : 'Поставить на паузу'}
          </Button>
        </div>
        <details className="streamer-disclosure title-session-actions">
          <summary>
            <span>Действия с текущей сессией</span>
            <small>Сброс, отмена результата и восстановление названия</small>
          </summary>
          <div className="button-row">
            <ConfirmedButton
              label="Сбросить победы и поражения"
              disabled={busy !== null}
              prompt="Сбросить статистику текущей сессии?"
              action={() =>
                run('title-reset', () =>
                  window.crTools.resetStreamTitle({ confirmed: true }),
                ).then(() => undefined)
              }
            />
            <ConfirmedButton
              label="Отменить результат"
              disabled={busy !== null}
              prompt="Отменить последний результат?"
              action={() =>
                run('title-undo', () =>
                  window.crTools.undoStreamTitle({ confirmed: true }),
                ).then(() => undefined)
              }
            />
            <ConfirmedButton
              label="Вернуть исходное название"
              disabled={busy !== null}
              prompt="Восстановить исходное название Twitch?"
              action={() =>
                run('title-restore', () =>
                  window.crTools.restoreStreamTitle({ confirmed: true }),
                ).then(() => undefined)
              }
            />
          </div>
        </details>
      </section>
      <aside className="streamer-context-stack" aria-label="Аккаунты и сессия">
        <section className="streamer-panel accounts-panel">
          <div className="streamer-section-heading compact">
            <div>
              <span className="eyebrow">CLASH ROYALE</span>
              <h2>Аккаунты</h2>
            </div>
            <span className="context-count">{view.title.accounts.length}/4</span>
          </div>
          <div className="account-add">
            <label>
              Тег аккаунта
              <input
                aria-describedby={tagInvalid ? tagErrorId : undefined}
                aria-invalid={tagInvalid}
                value={tag}
                maxLength={20}
                placeholder="#TAG"
                disabled={accountLimitReached || busy !== null}
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
                disabled={accountLimitReached || busy !== null}
                onChange={(event) => setAlias(event.target.value)}
              />
            </label>
            <Button
              variant="primary"
              disabled={
                busy !== null ||
                accountLimitReached ||
                tag.trim().length < 2 ||
                tagInvalid
              }
              onClick={() => void addAccount()}
            >
              Добавить аккаунт
            </Button>
            {accountLimitReached && (
              <small className="streamer-control-hint">
                Можно добавить не более 4 аккаунтов.
              </small>
            )}
          </div>
          {view.title.accounts.length === 0 ? (
            <div className="streamer-empty compact-empty">
              <strong>Аккаунтов пока нет</strong>
              <span>Добавьте тег, чтобы сформировать название.</span>
            </div>
          ) : (
            <div className="account-list">
              {view.title.accounts.map((account) => (
                <div key={account.tag}>
                  <span>
                    <strong title={account.alias || account.name || account.tag}>
                      {account.alias || account.name || account.tag}
                    </strong>
                    <small>
                      {account.tag} ·{' '}
                      {account.currentRank === null
                        ? 'место неизвестно'
                        : `место ${account.currentRank}`}{' '}
                      · {account.currentElo ?? 'ELO неизвестен'}
                      {account.currentElo !== null ? ' ELO' : ''}
                    </small>
                  </span>
                  <button
                    type="button"
                    disabled={busy !== null}
                    onClick={() =>
                      void run('account-remove', () =>
                        window.crTools.removeStreamTitleAccount(account.tag),
                      )
                    }
                  >
                    Удалить
                  </button>
                </div>
              ))}
            </div>
          )}
        </section>
        <section className="streamer-panel title-session-panel">
          <span className="eyebrow">ТЕКУЩАЯ СЕССИЯ</span>
          <h2>Результат эфира</h2>
          {view.title.session === null ? (
            <div className="streamer-empty compact-empty">
              <strong>Сессия ещё не началась</strong>
              <span>Статистика появится после первого результата.</span>
            </div>
          ) : (
            <div className="session-score">
              <div>
                <span>Победы</span>
                <strong>{view.title.session.totalWins}</strong>
              </div>
              <div>
                <span>Поражения</span>
                <strong>{view.title.session.totalLosses}</strong>
              </div>
              <small>
                Активный аккаунт: {view.title.session.activeAccountTag ?? 'не выбран'}
              </small>
            </div>
          )}
        </section>
      </aside>
    </div>
  )
}

function TitleFields({
  value,
  onChange,
  disabled,
  onValidityChange,
  manualTagInvalid,
}: {
  value: StreamTitleSettings
  onChange: (value: StreamTitleSettings) => void
  disabled: boolean
  onValidityChange: (fieldKey: string, invalid: boolean) => void
  manualTagInvalid: boolean
}): React.JSX.Element {
  const manualTagErrorId = useId()
  return (
    <div className="streamer-settings-block title-settings">
      <div className="streamer-form title-primary-form">
        <label className="form-wide">
          Шаблон префикса
          <input
            disabled={disabled}
            maxLength={200}
            value={value.prefixTemplate}
            onChange={(event) =>
              onChange({ ...value, prefixTemplate: event.target.value })
            }
          />
        </label>
        <Select
          label="Счёт побед и поражений"
          disabled={disabled}
          value={value.wlMode}
          options={[
            ['active', 'Текущий аккаунт'],
            ['total', 'Все аккаунты'],
          ]}
          onChange={(wlMode) => onChange({ ...value, wlMode })}
        />
        <Select
          label="Выбор аккаунта"
          disabled={disabled}
          value={value.accountDisplayMode}
          options={[
            ['last_active', 'Последний активный'],
            ['manual', 'Выбрать вручную'],
            ['best_elo', 'Лучший ELO'],
            ['multiple', 'Несколько аккаунтов'],
          ]}
          onChange={(accountDisplayMode) => {
            if (accountDisplayMode !== 'multiple') onValidityChange('maxAccounts', false)
            onChange({ ...value, accountDisplayMode })
          }}
        />
        {value.accountDisplayMode === 'manual' && (
          <label>
            Тег выбранного аккаунта
            <input
              aria-describedby={manualTagInvalid ? manualTagErrorId : undefined}
              aria-invalid={manualTagInvalid}
              disabled={disabled}
              maxLength={20}
              value={value.manualAccountTag}
              onChange={(event) =>
                onChange({ ...value, manualAccountTag: event.target.value })
              }
            />
            {manualTagInvalid && (
              <small className="field-error" id={manualTagErrorId}>
                Укажите корректный тег Clash Royale.
              </small>
            )}
          </label>
        )}
        {value.accountDisplayMode === 'multiple' && (
          <NumberField
            fieldKey="maxAccounts"
            label="Максимум аккаунтов"
            value={value.maxAccounts}
            min={1}
            max={4}
            disabled={disabled}
            onChange={(maxAccounts) => onChange({ ...value, maxAccounts })}
            onValidityChange={onValidityChange}
          />
        )}
      </div>
      <span className="field-caption">Данные в названии</span>
      <div className="streamer-switch-grid title-switches">
        {(
          [
            ['includeRank', 'Место в рейтинге'],
            ['includeElo', 'ELO'],
            ['includeWl', 'Победы и поражения'],
            ['includeDelta', 'Изменение рейтинга'],
          ] as const
        ).map(([key, label]) => (
          <StreamerToggle
            key={key}
            label={label}
            checked={value[key]}
            disabled={disabled}
            onChange={(checked) => onChange({ ...value, [key]: checked })}
          />
        ))}
      </div>
      <details className="streamer-disclosure">
        <summary>
          <span>Дополнительные правила</span>
          <small>Тип боёв и поведение после завершения эфира</small>
        </summary>
        <div className="streamer-form compact-form">
          <Select
            label="Учитывать бои"
            disabled={disabled}
            value={value.battleMode}
            options={[
              ['pathOfLegend', 'Только «Путь легенд»'],
              ['all', 'Все бои'],
            ]}
            onChange={(battleMode) => onChange({ ...value, battleMode })}
          />
          <StreamerToggle
            label="Восстановить название после офлайна"
            checked={value.restoreTitleOnOffline}
            disabled={disabled}
            onChange={(restoreTitleOnOffline) =>
              onChange({ ...value, restoreTitleOnOffline })
            }
          />
        </div>
      </details>
    </div>
  )
}
