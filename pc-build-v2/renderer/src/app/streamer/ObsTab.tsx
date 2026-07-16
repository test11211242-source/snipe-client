import { AlertTriangle, Clipboard, Check } from 'lucide-react'
import { useEffect, useId, useRef, useState } from 'react'

import type { OverlaySettings, StreamerView } from '../../../../shared/models/streamer'
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

export function ObsTab({
  view,
  busy,
  run,
}: {
  view: StreamerView
  busy: string | null
  run: StreamerRunner
}): React.JSX.Element {
  const {
    draft: settings,
    setDraft: setSettings,
    dirty,
  } = useDraft(view.overlay.settings)
  const [invalidFields, setInvalidFields] = useState<ReadonlySet<string>>(new Set())
  const [copied, setCopied] = useState<'stats' | 'opponent' | null>(null)
  const copiedTimer = useRef<number | undefined>(undefined)
  const manualTagInvalid =
    settings.streamerAccountMode === 'manual' &&
    !/^#?[0289PYLQGRJCUV]+$/i.test(settings.manualStreamerTag.trim())
  const timingInvalid =
    settings.opponentSecondSlideEnabled &&
    settings.opponentSlideSeconds >= settings.opponentDisplaySeconds
  const invalid = invalidFields.size > 0 || manualTagInvalid || timingInvalid

  useEffect(
    () => () => {
      if (copiedTimer.current !== undefined) window.clearTimeout(copiedTimer.current)
    },
    [],
  )

  const setValidity = (fieldKey: string, fieldInvalid: boolean): void => {
    setInvalidFields((current) => {
      const next = new Set(current)
      if (fieldInvalid) next.add(fieldKey)
      else next.delete(fieldKey)
      return next
    })
  }

  const copyUrl = async (kind: 'stats' | 'opponent'): Promise<void> => {
    const result = await run(`copy-${kind}`, () => window.crTools.copyOverlayUrl(kind))
    if (result === null) return
    setCopied(kind)
    if (copiedTimer.current !== undefined) window.clearTimeout(copiedTimer.current)
    copiedTimer.current = window.setTimeout(() => setCopied(null), 2_500)
  }

  return (
    <div className="obs-layout">
      <div className="obs-main-column">
        <section className="streamer-panel obs-control-panel">
          <div className="streamer-section-heading">
            <div>
              <span className="eyebrow">ИСТОЧНИКИ OBS</span>
              <h2>Адаптивные оверлеи</h2>
            </div>
            <StreamerToggle
              label="Оверлеи"
              checked={settings.enabled}
              disabled={busy !== null}
              onChange={(enabled) => setSettings({ ...settings, enabled })}
            />
          </div>
          <p className="streamer-lead">
            Управление виджетами статистики и соперника для источников «Браузер» в OBS.
          </p>
          {settings.previewMode && (
            <div className="preview-warning" role="status">
              <AlertTriangle aria-hidden="true" size={17} />
              <span>
                Тестовый режим меняет серверное поведение. Выключите его перед эфиром.
              </span>
            </div>
          )}
          <OverlayFields
            value={settings}
            onChange={setSettings}
            disabled={busy !== null}
            onValidityChange={setValidity}
            manualTagInvalid={manualTagInvalid}
            timingInvalid={timingInvalid}
          />
          <div className="draft-row">
            <DraftStatus dirty={dirty} invalid={invalid} />
          </div>
          <div className="streamer-action-row">
            <Button
              variant="primary"
              disabled={busy !== null || !dirty || invalid}
              onClick={() =>
                void run('overlay-save', () => window.crTools.updateOverlay(settings))
              }
            >
              Сохранить настройки OBS
            </Button>
          </div>
        </section>
        <section className="streamer-panel obs-preview-panel">
          <div className="streamer-section-heading compact">
            <div>
              <span className="eyebrow">ЛОКАЛЬНАЯ ПРОВЕРКА</span>
              <h2>Композиция без секретных данных</h2>
            </div>
            <span className="preview-target-label">{previewTargetLabel(settings)}</span>
          </div>
          <div className="mock-preview-grid">
            <MockStats settings={settings} />
            <MockOpponent settings={settings} />
          </div>
        </section>
      </div>
      <aside className="streamer-context-stack obs-context" aria-label="Ссылки OBS">
        <section className="streamer-panel obs-urls-panel">
          <span className="eyebrow">ИСТОЧНИКИ</span>
          <h2>Ссылки OBS</h2>
          <p>Скопируйте URL и добавьте его в OBS как источник «Браузер».</p>
          <UrlRow
            label="Статистика стримера"
            available={view.overlay.urlsAvailable.stats}
            size={view.overlay.recommendedSizes.stats}
            copied={copied === 'stats'}
            copy={() => copyUrl('stats')}
          />
          <UrlRow
            label="Соперник"
            available={view.overlay.urlsAvailable.opponent}
            size={view.overlay.recommendedSizes.opponent}
            copied={copied === 'opponent'}
            copy={() => copyUrl('opponent')}
          />
          <div className="copy-feedback" aria-live="polite">
            {copied !== null && 'Ссылка скопирована в буфер обмена'}
          </div>
          <details className="streamer-disclosure token-disclosure">
            <summary>
              <span>Безопасность ссылок</span>
              <small>Замена скрытого ключа доступа</small>
            </summary>
            <p>После замены текущие URL в OBS сразу перестанут работать.</p>
            <ConfirmedButton
              label="Сменить ключ доступа"
              disabled={busy !== null}
              prompt="Старые OBS URL сразу перестанут работать. Сменить ключ?"
              action={() =>
                run('overlay-token', () =>
                  window.crTools.rotateOverlayToken({ confirmed: true }),
                ).then(() => undefined)
              }
            />
          </details>
        </section>
        <section className="streamer-panel obs-status-panel">
          <span className="eyebrow">СОСТОЯНИЕ ВИДЖЕТОВ</span>
          <h2>Эфирный контур</h2>
          <div className="widget-status-list">
            <Status
              label="Статистика стримера"
              tone={settings.streamerStatsEnabled ? 'success' : 'neutral'}
              value={settings.streamerStatsEnabled ? 'Включена' : 'Выключена'}
            />
            <Status
              label="Карточка соперника"
              tone={settings.opponentEnabled ? 'success' : 'neutral'}
              value={settings.opponentEnabled ? 'Включена' : 'Выключена'}
            />
            <Status
              label="Тестовый режим"
              tone={settings.previewMode ? 'warning' : 'success'}
              value={settings.previewMode ? 'Активен' : 'Выключен'}
            />
          </div>
        </section>
      </aside>
    </div>
  )
}

function OverlayFields({
  value,
  onChange,
  disabled,
  onValidityChange,
  manualTagInvalid,
  timingInvalid,
}: {
  value: OverlaySettings
  onChange: (value: OverlaySettings) => void
  disabled: boolean
  onValidityChange: (fieldKey: string, invalid: boolean) => void
  manualTagInvalid: boolean
  timingInvalid: boolean
}): React.JSX.Element {
  const manualTagErrorId = useId()
  const timingErrorId = useId()
  const setNumber = (key: keyof OverlaySettings) => (next: number) =>
    onChange({ ...value, [key]: next })

  return (
    <div className="streamer-settings-block overlay-settings">
      <span className="field-caption">Активные виджеты</span>
      <div className="streamer-switch-grid overlay-switches">
        <StreamerToggle
          label="Статистика стримера"
          checked={value.streamerStatsEnabled}
          disabled={disabled}
          onChange={(streamerStatsEnabled) =>
            onChange({ ...value, streamerStatsEnabled })
          }
        />
        <StreamerToggle
          label="Карточка соперника"
          checked={value.opponentEnabled}
          disabled={disabled}
          onChange={(opponentEnabled) => onChange({ ...value, opponentEnabled })}
        />
        <StreamerToggle
          label="Тестовый режим"
          checked={value.previewMode}
          disabled={disabled}
          onChange={(previewMode) => onChange({ ...value, previewMode })}
        />
      </div>
      <div className="streamer-form overlay-primary-form">
        <Select
          label="Проверяемые виджеты"
          value={value.previewTarget}
          options={[
            ['stats', 'Только статистика'],
            ['opponent', 'Только соперник'],
            ['both', 'Оба виджета'],
          ]}
          disabled={disabled}
          onChange={(previewTarget) => onChange({ ...value, previewTarget })}
        />
        <Select
          label="Компоновка статистики"
          value={value.statsLayout}
          options={[
            ['compact', 'Компактная'],
            ['standard', 'Стандартная'],
            ['detailed', 'Подробная'],
          ]}
          disabled={disabled}
          onChange={(statsLayout) => onChange({ ...value, statsLayout })}
        />
        <Select
          label="Компоновка соперника"
          value={value.opponentLayout}
          options={[
            ['compact', 'Компактная'],
            ['standard', 'Стандартная'],
            ['detailed', 'Подробная'],
          ]}
          disabled={disabled}
          onChange={(opponentLayout) => onChange({ ...value, opponentLayout })}
        />
        <Select
          label="Аккаунт стримера"
          value={value.streamerAccountMode}
          options={[
            ['stream_title', 'Из настроек названия'],
            ['manual', 'Указать вручную'],
          ]}
          disabled={disabled}
          onChange={(streamerAccountMode) => onChange({ ...value, streamerAccountMode })}
        />
        {value.streamerAccountMode === 'manual' && (
          <label>
            Тег аккаунта вручную
            <input
              aria-describedby={manualTagInvalid ? manualTagErrorId : undefined}
              aria-invalid={manualTagInvalid}
              disabled={disabled}
              maxLength={20}
              value={value.manualStreamerTag}
              onChange={(event) =>
                onChange({ ...value, manualStreamerTag: event.target.value })
              }
            />
            {manualTagInvalid && (
              <small className="field-error" id={manualTagErrorId}>
                Укажите корректный тег Clash Royale.
              </small>
            )}
          </label>
        )}
      </div>
      <details className="streamer-disclosure">
        <summary>
          <span>Оформление виджетов</span>
          <small>Шрифт и форма углов</small>
        </summary>
        <div className="streamer-form compact-form">
          <Select
            label="Стиль шрифта"
            value={value.widgetFontStyle}
            options={[
              ['gaming', 'Игровой'],
              ['clean', 'Нейтральный'],
              ['condensed', 'Узкий'],
            ]}
            disabled={disabled}
            onChange={(widgetFontStyle) => onChange({ ...value, widgetFontStyle })}
          />
          <Select
            label="Форма углов"
            value={value.widgetCornerStyle}
            options={[
              ['rounded', 'Скруглённые'],
              ['square', 'Прямые'],
              ['pill', 'Максимально круглые'],
            ]}
            disabled={disabled}
            onChange={(widgetCornerStyle) => onChange({ ...value, widgetCornerStyle })}
          />
        </div>
      </details>
      <details className="streamer-disclosure">
        <summary>
          <span>Тайминги и сравнение</span>
          <small>Интервалы обновления и переходов</small>
        </summary>
        <div className="streamer-switch-grid advanced-switches">
          <StreamerToggle
            label="Второй слайд соперника"
            checked={value.opponentSecondSlideEnabled}
            disabled={disabled}
            onChange={(opponentSecondSlideEnabled) =>
              onChange({ ...value, opponentSecondSlideEnabled })
            }
          />
          <StreamerToggle
            label="Статистика сравнения"
            checked={value.matchupEnabled}
            disabled={disabled}
            onChange={(matchupEnabled) => onChange({ ...value, matchupEnabled })}
          />
        </div>
        {timingInvalid && (
          <p className="form-summary-error" id={timingErrorId} role="alert">
            Второй слайд должен быть короче общего времени показа соперника.
          </p>
        )}
        <div className="streamer-form overlay-advanced-form">
          {(
            [
              ['recentLimit', 'Последних боёв', 1, 10],
              ['opponentDisplaySeconds', 'Показ соперника, сек', 5, 120],
              ['opponentSlideSeconds', 'Второй слайд, сек', 3, 60],
              ['opponentTransitionMs', 'Переход соперника, мс', 100, 3000],
              ['statsMainSeconds', 'Основная статистика, сек', 5, 120],
              ['statsDeltaSeconds', 'Изменение рейтинга, сек', 2, 30],
              ['statsBetweenSeconds', 'Пауза статистики, сек', 0, 30],
              ['statsPollMs', 'Опрос статистики, мс', 500, 5000],
              ['statsTransitionMs', 'Переход статистики, мс', 100, 3000],
              ['matchupMinGames', 'Минимум боёв для сравнения', 1, 100],
            ] as const
          ).map(([key, label, min, max]) => (
            <NumberField
              fieldKey={key}
              key={key}
              label={label}
              value={value[key]}
              min={min}
              max={max}
              disabled={disabled}
              onChange={setNumber(key)}
              onValidityChange={onValidityChange}
            />
          ))}
          <RankLimitsField
            value={value.matchupRankLimits}
            disabled={disabled}
            onChange={(matchupRankLimits) => onChange({ ...value, matchupRankLimits })}
            onValidityChange={(invalid) => onValidityChange('matchupRankLimits', invalid)}
          />
        </div>
      </details>
    </div>
  )
}

function RankLimitsField({
  value,
  disabled,
  onChange,
  onValidityChange,
}: {
  value: (100 | 200 | 500 | 1000)[]
  disabled: boolean
  onChange: (value: (100 | 200 | 500 | 1000)[]) => void
  onValidityChange: (invalid: boolean) => void
}): React.JSX.Element {
  const serializedValue = value.join(', ')
  const [edit, setEdit] = useState({
    draft: serializedValue,
    sourceValue: serializedValue,
    dirty: false,
  })
  const [focused, setFocused] = useState(false)
  const [invalid, setInvalid] = useState(false)
  const errorId = useId()
  const displayedDraft =
    edit.sourceValue !== serializedValue && !edit.dirty && !focused
      ? serializedValue
      : edit.draft

  return (
    <label className="form-wide">
      Пределы рейтинга для сравнения
      <input
        aria-describedby={invalid ? errorId : undefined}
        aria-invalid={invalid}
        disabled={disabled}
        value={displayedDraft}
        onBlur={() => setFocused(false)}
        onChange={(event) => {
          const nextDraft = event.currentTarget.value
          const tokens = nextDraft.split(',').map((item) => item.trim())
          const valid =
            tokens.length >= 1 &&
            tokens.length <= 4 &&
            tokens.every((item) => /^(?:100|200|500|1000)$/.test(item))
          const parts = tokens.map(Number) as (100 | 200 | 500 | 1000)[]
          setEdit({
            draft: nextDraft,
            sourceValue: valid ? parts.join(', ') : serializedValue,
            dirty: !valid,
          })
          setInvalid(!valid)
          onValidityChange(!valid)
          if (valid) onChange(parts)
        }}
        onFocus={() => {
          setFocused(true)
          setEdit((current) =>
            current.sourceValue !== serializedValue && !current.dirty
              ? { draft: serializedValue, sourceValue: serializedValue, dirty: false }
              : current,
          )
        }}
      />
      {invalid && (
        <small className="field-error" id={errorId}>
          Укажите от 1 до 4 значений: 100, 200, 500 или 1000.
        </small>
      )}
    </label>
  )
}

function previewTargetLabel(settings: OverlaySettings): string {
  if (settings.previewTarget === 'stats') return 'Только статистика'
  if (settings.previewTarget === 'opponent') return 'Только соперник'
  return 'Оба виджета'
}

function MockStats({ settings }: { settings: OverlaySettings }): React.JSX.Element {
  return (
    <div
      className={`mock-widget mock-${settings.widgetCornerStyle} mock-${settings.widgetFontStyle}`}
      data-visible={
        settings.streamerStatsEnabled && settings.previewTarget !== 'opponent'
      }
    >
      <small>СЕССИЯ СТРИМА</small>
      <strong>12 побед · 7 поражений</strong>
      <span>Место 284 · 1 942 ELO · +36</span>
    </div>
  )
}

function MockOpponent({ settings }: { settings: OverlaySettings }): React.JSX.Element {
  return (
    <div
      className={`mock-widget mock-opponent mock-${settings.widgetCornerStyle} mock-${settings.widgetFontStyle}`}
      data-visible={settings.opponentEnabled && settings.previewTarget !== 'stats'}
    >
      <small>СОПЕРНИК</small>
      <strong>Пример игрока</strong>
      <span>Личные встречи 8:5 · преимущество 54%</span>
      <div className="mock-cards" aria-hidden="true">
        {['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'].map((item) => (
          <i key={item}>{item}</i>
        ))}
      </div>
    </div>
  )
}

function UrlRow({
  label,
  available,
  size,
  copied,
  copy,
}: {
  label: string
  available: boolean
  size: string
  copied: boolean
  copy: () => Promise<void>
}): React.JSX.Element {
  return (
    <div className="url-row" data-available={available}>
      <span>
        <strong>{label}</strong>
        <small>
          {size} · {available ? 'Ссылка готова' : 'Ссылка недоступна'}
        </small>
      </span>
      <Button disabled={!available} onClick={() => void copy()}>
        {copied ? (
          <Check aria-hidden="true" size={15} />
        ) : (
          <Clipboard aria-hidden="true" size={15} />
        )}
        {copied ? 'Скопировано' : 'Копировать'}
      </Button>
    </div>
  )
}
