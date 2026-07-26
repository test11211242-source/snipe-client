import { useEffect, useId, useRef, useState } from 'react'

import type {
  StreamerView,
  StreamTitlePreview,
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
const TEMPLATE_TOKENS = [
  ['{rank}', 'место'],
  ['{elo}', 'ELO или лига'],
  ['{wins}', 'победы'],
  ['{losses}', 'поражения'],
  ['{delta}', 'изменение ELO'],
  ['{account}', 'аккаунт'],
] as const

export function TitleTab({
  view,
  active,
  busy,
  run,
  onDirtyChange,
}: {
  view: StreamerView
  active: boolean
  busy: string | null
  run: StreamerRunner
  onDirtyChange?: (dirty: boolean) => void
}): React.JSX.Element {
  const {
    draft: settings,
    setDraft: setSettings,
    reset,
    dirty,
  } = useDraft(view.title.settings)
  const [tag, setTag] = useState('')
  const [alias, setAlias] = useState('')
  const [invalidFields, setInvalidFields] = useState<ReadonlySet<string>>(new Set())
  const [preview, setPreview] = useState<StreamTitlePreview>({
    previewTitle: view.title.previewTitle,
    characterCount: view.title.previewTitle.length,
    warnings: [],
  })
  const [previewState, setPreviewState] = useState<'ready' | 'loading' | 'error'>('ready')
  const previewGeneration = useRef(0)
  const tagErrorId = useId()
  const tagInvalid = tag.trim().length > 0 && !TAG_PATTERN.test(tag.trim())
  const accountLimitReached = view.title.accounts.length >= 4
  const selectedManualTag = settings.manualAccountTag.replace('#', '').toUpperCase()
  const manualTagInvalid =
    settings.accountDisplayMode === 'manual' &&
    (!TAG_PATTERN.test(settings.manualAccountTag.trim()) ||
      !view.title.accounts.some(
        (account) => account.tag.replace('#', '').toUpperCase() === selectedManualTag,
      ))
  const invalid = invalidFields.size > 0 || manualTagInvalid

  useEffect(() => onDirtyChange?.(dirty), [dirty, onDirtyChange])

  useEffect(() => {
    if (!active || invalid) return
    const generation = ++previewGeneration.current
    const timer = window.setTimeout(() => {
      if (generation !== previewGeneration.current) return
      setPreviewState('loading')
      void window.crTools.previewStreamTitle(settings).then(
        (nextPreview) => {
          if (generation !== previewGeneration.current) return
          setPreview(nextPreview)
          setPreviewState('ready')
        },
        () => {
          if (generation === previewGeneration.current) setPreviewState('error')
        },
      )
    }, 250)
    return () => {
      window.clearTimeout(timer)
      previewGeneration.current += 1
    }
  }, [active, invalid, settings, view.refresh.refreshedAt])

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

  const changeEnabled = async (enabled: boolean): Promise<void> => {
    const result = await run('title-enabled', () =>
      window.crTools.setStreamTitleEnabled(enabled),
    )
    if (result !== null) {
      setSettings({ ...settings, enabled: result.title.settings.enabled })
    }
  }

  const changePaused = async (): Promise<void> => {
    const result = await run('title-pause', () =>
      window.crTools.setStreamTitlePaused(!settings.paused),
    )
    if (result !== null) {
      setSettings({ ...settings, paused: result.title.settings.paused })
    }
  }

  return (
    <div className="title-workspace">
      <section className="streamer-panel title-preview-hero">
        <div className="streamer-section-heading">
          <div>
            <span className="eyebrow">ПРЕДПРОСМОТР</span>
            <h2>Так будет выглядеть название</h2>
          </div>
          <div className="title-preview-statuses">
            <Status
              label={view.title.twitchOnline ? 'Канал онлайн' : 'Канал офлайн'}
              tone={view.title.twitchOnline ? 'success' : 'neutral'}
            />
            <Status
              label={
                settings.enabled ? 'Автоматизация включена' : 'Автоматизация выключена'
              }
              tone={settings.enabled ? 'success' : 'neutral'}
            />
          </div>
        </div>
        <div
          aria-atomic="true"
          aria-live="polite"
          className="title-live-preview"
          data-state={previewState}
        >
          <span>{previewState === 'loading' ? 'Пересчитываем...' : 'Черновик'}</span>
          <strong>
            {preview.previewTitle || 'Добавьте аккаунт, чтобы сформировать название'}
          </strong>
          <small>
            {preview.characterCount}/140 символов · Twitch не изменится до сохранения
          </small>
        </div>
        {previewState === 'error' && (
          <p className="title-preview-message" role="status">
            Не удалось пересчитать preview. Сохранённое название не изменено.
          </p>
        )}
        {preview.warnings.map((warning) => (
          <p className="title-preview-message" key={warning}>
            {warning}
          </p>
        ))}
      </section>

      <div className="streamer-context-layout title-layout">
        <section className="streamer-panel streamer-context-main title-control-panel">
          <div className="streamer-section-heading">
            <div>
              <span className="eyebrow">АВТОМАТИЗАЦИЯ</span>
              <h2>Что добавлять в название</h2>
            </div>
            <StreamerToggle
              label="Автоматизация"
              checked={settings.enabled}
              disabled={busy !== null || dirty || !view.twitch.connected}
              onChange={(enabled) => void changeEnabled(enabled)}
            />
          </div>
          <p className="streamer-lead">
            Выберите данные ниже. Предпросмотр обновляется сразу, а Twitch только после
            сохранения.
          </p>
          <TitleFields
            value={settings}
            accounts={view.title.accounts}
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
              disabled={busy !== null || !dirty || invalid || previewState !== 'ready'}
              onClick={() =>
                void run('title-save', () => window.crTools.updateStreamTitle(settings))
              }
            >
              Сохранить и применить
            </Button>
            <Button disabled={busy !== null || !dirty} onClick={reset}>
              Отменить изменения
            </Button>
            <Button disabled={busy !== null || dirty} onClick={() => void changePaused()}>
              {settings.paused ? 'Продолжить обновления' : 'Поставить на паузу'}
            </Button>
          </div>
          {dirty && (
            <small className="title-change-hint">
              Сначала сохраните или отмените черновик, затем меняйте состояние
              автоматизации.
            </small>
          )}
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
                      <strong>{account.alias || account.name || account.tag}</strong>
                      <small>
                        {account.tag} ·{' '}
                        {account.currentRank === null
                          ? 'место неизвестно'
                          : `место ${account.currentRank}`}{' '}
                        · {account.currentElo ?? 'ELO неизвестен'}
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
    </div>
  )
}

function TitleFields({
  value,
  accounts,
  onChange,
  disabled,
  onValidityChange,
  manualTagInvalid,
}: {
  value: StreamTitleSettings
  accounts: StreamerView['title']['accounts']
  onChange: (value: StreamTitleSettings) => void
  disabled: boolean
  onValidityChange: (fieldKey: string, invalid: boolean) => void
  manualTagInvalid: boolean
}): React.JSX.Element {
  const manualTagErrorId = useId()
  const dataOptions = [
    ['includeRank', 'Место в рейтинге', 'Текущая позиция в глобальном рейтинге'],
    ['includeElo', 'ELO', 'Рейтинг или текущая лига аккаунта'],
    ['includeWl', 'Победы и поражения', 'Счёт текущего эфира'],
    ['includeDelta', 'Изменение рейтинга', 'Рост или падение ELO за эфир'],
  ] as const

  return (
    <div className="streamer-settings-block title-settings-redesign">
      <div className="title-data-grid">
        {dataOptions.map(([key, label, description]) => (
          <div className="title-data-option" data-enabled={value[key]} key={key}>
            <StreamerToggle
              label={label}
              checked={value[key]}
              disabled={disabled}
              onChange={(checked) => onChange({ ...value, [key]: checked })}
            />
            <small>{description}</small>
          </div>
        ))}
      </div>

      <div className="streamer-form title-primary-form">
        <Select
          label="Какой аккаунт показывать"
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
        {value.includeWl && (
          <Select
            label="Чей счёт W/L показывать"
            disabled={disabled}
            value={value.wlMode}
            options={[
              ['active', 'Текущий аккаунт'],
              ['total', 'Все аккаунты'],
            ]}
            onChange={(wlMode) => onChange({ ...value, wlMode })}
          />
        )}
        {value.accountDisplayMode === 'manual' && (
          <label>
            Аккаунт для названия
            <select
              aria-describedby={manualTagInvalid ? manualTagErrorId : undefined}
              aria-invalid={manualTagInvalid}
              disabled={disabled || accounts.length === 0}
              value={value.manualAccountTag}
              onChange={(event) =>
                onChange({ ...value, manualAccountTag: event.currentTarget.value })
              }
            >
              <option value="">Выберите аккаунт</option>
              {accounts.map((account) => (
                <option key={account.tag} value={account.tag}>
                  {account.alias || account.name || account.tag} · {account.tag}
                </option>
              ))}
            </select>
            {manualTagInvalid && (
              <small className="field-error" id={manualTagErrorId}>
                Выберите один из добавленных аккаунтов.
              </small>
            )}
          </label>
        )}
        {value.accountDisplayMode === 'multiple' && (
          <NumberField
            fieldKey="maxAccounts"
            label="Сколько аккаунтов показать"
            value={value.maxAccounts}
            min={1}
            max={4}
            disabled={disabled}
            onChange={(maxAccounts) => onChange({ ...value, maxAccounts })}
            onValidityChange={onValidityChange}
          />
        )}
      </div>

      <details className="streamer-disclosure title-template-disclosure">
        <summary>
          <span>Расширенный шаблон</span>
          <small>Для ручной настройки порядка и оформления данных</small>
        </summary>
        <div className="title-template-editor">
          <p>
            Шаблон формирует автоматическую часть перед обычным названием Twitch. Значения
            в фигурных скобках заменяются данными аккаунта.
          </p>
          <label>
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
          <div className="title-token-list" aria-label="Доступные значения шаблона">
            {TEMPLATE_TOKENS.map(([token, label]) => (
              <button
                type="button"
                disabled={disabled}
                key={token}
                onClick={() =>
                  onChange({
                    ...value,
                    prefixTemplate: `${value.prefixTemplate}${token}`,
                  })
                }
              >
                <code>{token}</code>
                <span>{label}</span>
              </button>
            ))}
          </div>
        </div>
      </details>

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
