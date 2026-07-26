import { AlertTriangle, Check, Clipboard } from 'lucide-react'
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

const WIDGET_ORIGIN = 'https://api.artcsworld.xyz'

export function ObsTab({
  view,
  busy,
  run,
  onDirtyChange,
}: {
  view: StreamerView
  busy: string | null
  run: StreamerRunner
  onDirtyChange?: (dirty: boolean) => void
}): React.JSX.Element {
  const {
    draft: settings,
    setDraft: setSettings,
    reset,
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
  const sizes = recommendedDraftSizes(settings)

  useEffect(() => onDirtyChange?.(dirty), [dirty, onDirtyChange])
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
    <div className="obs-workspace">
      <section className="streamer-panel obs-master-panel">
        <div className="streamer-section-heading">
          <div>
            <span className="eyebrow">OBS BROWSER SOURCES</span>
            <h2>Виджеты трансляции</h2>
          </div>
          <StreamerToggle
            label="Виджеты OBS"
            checked={settings.enabled}
            disabled={busy !== null}
            onChange={(enabled) => setSettings({ ...settings, enabled })}
          />
        </div>
        <p className="streamer-lead">
          Preview показывает реальный внешний вид на тестовых данных и не содержит вашего
          ключа OBS. Тайминги и доступность применятся только после сохранения.
        </p>
        <div className="obs-state-strip">
          <Status
            label="Сохранено на сервере"
            value={view.overlay.settings.enabled ? 'Включено' : 'Выключено'}
            tone={view.overlay.settings.enabled ? 'success' : 'neutral'}
          />
          <Status
            label="После сохранения"
            value={settings.enabled ? 'Будет включено' : 'Будет выключено'}
            tone={settings.enabled ? 'success' : 'neutral'}
          />
          <DraftStatus dirty={dirty} invalid={invalid} />
        </div>
        {view.overlay.settings.previewMode && (
          <div className="preview-warning" role="status">
            <AlertTriangle aria-hidden="true" size={17} />
            <span>
              Тестовый режим сейчас включён на сервере и влияет на источники OBS.
            </span>
          </div>
        )}
      </section>

      <section className="streamer-panel obs-shared-panel">
        <div className="streamer-section-heading compact">
          <div>
            <span className="eyebrow">ОБЩИЙ СТИЛЬ</span>
            <h2>Оформление обоих виджетов</h2>
          </div>
        </div>
        <div className="streamer-form obs-shared-form">
          <Select
            label="Стиль шрифта"
            value={settings.widgetFontStyle}
            options={[
              ['gaming', 'Игровой'],
              ['clean', 'Нейтральный'],
              ['condensed', 'Узкий'],
            ]}
            disabled={busy !== null}
            onChange={(widgetFontStyle) => setSettings({ ...settings, widgetFontStyle })}
          />
          <Select
            label="Форма углов"
            value={settings.widgetCornerStyle}
            options={[
              ['rounded', 'Скруглённые'],
              ['square', 'Прямые'],
              ['pill', 'Максимально круглые'],
            ]}
            disabled={busy !== null}
            onChange={(widgetCornerStyle) =>
              setSettings({ ...settings, widgetCornerStyle })
            }
          />
          <StreamerToggle
            label="Тестовый режим в OBS"
            checked={settings.previewMode}
            disabled={busy !== null}
            onChange={(previewMode) => setSettings({ ...settings, previewMode })}
          />
          {settings.previewMode && (
            <Select
              label="Показывать в тестовом режиме"
              value={settings.previewTarget}
              options={[
                ['stats', 'Только статистику'],
                ['opponent', 'Только соперника'],
                ['both', 'Оба виджета'],
              ]}
              disabled={busy !== null}
              onChange={(previewTarget) => setSettings({ ...settings, previewTarget })}
            />
          )}
        </div>
      </section>

      <div className="obs-widget-grid">
        <WidgetCard
          title="Статистика стримера"
          description="Место, ELO, изменение рейтинга и счёт текущего эфира."
          enabled={settings.streamerStatsEnabled}
          savedEnabled={view.overlay.settings.streamerStatsEnabled}
          previewUrl={widgetPreviewUrl('stats', settings)}
          previewClassName="stats"
          available={view.overlay.urlsAvailable.stats}
          size={sizes.stats}
          copied={copied === 'stats'}
          busy={busy !== null}
          toggle={(streamerStatsEnabled) =>
            setSettings({ ...settings, streamerStatsEnabled })
          }
          copy={() => copyUrl('stats')}
        >
          <StatsSettings
            value={settings}
            disabled={busy !== null}
            onChange={setSettings}
            onValidityChange={setValidity}
          />
        </WidgetCard>

        <WidgetCard
          title="Карточка соперника"
          description="Личные встречи, колоды и оценка матчапа после найденного соперника."
          enabled={settings.opponentEnabled}
          savedEnabled={view.overlay.settings.opponentEnabled}
          previewUrl={widgetPreviewUrl('opponent', settings)}
          previewClassName="opponent"
          available={view.overlay.urlsAvailable.opponent}
          size={sizes.opponent}
          copied={copied === 'opponent'}
          busy={busy !== null}
          toggle={(opponentEnabled) => setSettings({ ...settings, opponentEnabled })}
          copy={() => copyUrl('opponent')}
        >
          <OpponentSettings
            value={settings}
            disabled={busy !== null}
            onChange={setSettings}
            onValidityChange={setValidity}
            manualTagInvalid={manualTagInvalid}
            timingInvalid={timingInvalid}
          />
        </WidgetCard>
      </div>

      <section className="streamer-panel obs-save-panel">
        <div>
          <strong>
            {dirty ? 'Есть изменения, которые ещё не видит OBS' : 'Настройки сохранены'}
          </strong>
          <span>
            Preview обновляется сразу. Источники OBS изменятся только после сохранения.
          </span>
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
          <Button disabled={busy !== null || !dirty} onClick={reset}>
            Отменить изменения
          </Button>
        </div>
      </section>

      <details className="streamer-panel streamer-disclosure obs-danger-zone">
        <summary>
          <span>Безопасность ссылок OBS</span>
          <small>Замена ключа отключит уже добавленные browser sources</small>
        </summary>
        <p>
          Используйте это только если ссылка попала к постороннему. Старые URL сразу
          перестанут работать.
        </p>
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

      <div className="copy-feedback" aria-live="polite">
        {copied !== null && 'Ссылка скопирована в буфер обмена'}
      </div>
    </div>
  )
}

function WidgetCard({
  title,
  description,
  enabled,
  savedEnabled,
  previewUrl,
  previewClassName,
  available,
  size,
  copied,
  busy,
  toggle,
  copy,
  children,
}: {
  title: string
  description: string
  enabled: boolean
  savedEnabled: boolean
  previewUrl: string
  previewClassName: 'stats' | 'opponent'
  available: boolean
  size: string
  copied: boolean
  busy: boolean
  toggle: (enabled: boolean) => void
  copy: () => Promise<void>
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <article className="streamer-panel obs-widget-card" data-kind={previewClassName}>
      <div className="obs-widget-card-heading">
        <div>
          <span className="eyebrow">OBS ВИДЖЕТ</span>
          <h2>{title}</h2>
          <p>{description}</p>
        </div>
        <StreamerToggle
          label={`Показывать: ${title}`}
          checked={enabled}
          disabled={busy}
          onChange={toggle}
        />
      </div>

      <div className={`real-widget-preview real-widget-${previewClassName}`}>
        <div className="real-widget-preview-toolbar">
          <span>Preview внешнего вида</span>
          <Status
            label={savedEnabled ? 'Сейчас включён' : 'Сейчас выключен'}
            tone={savedEnabled ? 'success' : 'neutral'}
          />
        </div>
        <iframe
          key={previewUrl}
          loading="lazy"
          referrerPolicy="no-referrer"
          sandbox="allow-scripts"
          src={previewUrl}
          title={`Предпросмотр: ${title}`}
        />
      </div>

      <div className="obs-widget-source-row">
        <span>
          <strong>Источник «Браузер»</strong>
          <small>
            {size} · {available ? 'URL готов к копированию' : 'URL пока недоступен'}
          </small>
        </span>
        <Button disabled={!available || busy} onClick={() => void copy()}>
          {copied ? (
            <Check aria-hidden="true" size={15} />
          ) : (
            <Clipboard aria-hidden="true" size={15} />
          )}
          {copied ? 'Скопировано' : 'Копировать URL'}
        </Button>
      </div>

      <div className="obs-widget-settings">{children}</div>
    </article>
  )
}

function StatsSettings({
  value,
  disabled,
  onChange,
  onValidityChange,
}: {
  value: OverlaySettings
  disabled: boolean
  onChange: (value: OverlaySettings) => void
  onValidityChange: (fieldKey: string, invalid: boolean) => void
}): React.JSX.Element {
  const setNumber = (key: keyof OverlaySettings) => (next: number) =>
    onChange({ ...value, [key]: next })
  return (
    <>
      <Select
        label="Компоновка"
        value={value.statsLayout}
        options={[
          ['compact', 'Компактная'],
          ['standard', 'Стандартная'],
          ['detailed', 'Подробная'],
        ]}
        disabled={disabled}
        onChange={(statsLayout) => onChange({ ...value, statsLayout })}
      />
      <details className="streamer-disclosure">
        <summary>
          <span>Тайминги статистики</span>
          <small>Скорость смены ELO, дельты и W/L</small>
        </summary>
        <div className="streamer-form compact-form">
          {(
            [
              ['statsMainSeconds', 'Основная статистика, сек', 5, 120],
              ['statsDeltaSeconds', 'Изменение рейтинга, сек', 2, 30],
              ['statsBetweenSeconds', 'Пауза между блоками, сек', 0, 30],
              ['statsPollMs', 'Обновление данных, мс', 500, 5000],
              ['statsTransitionMs', 'Переход, мс', 100, 3000],
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
        </div>
      </details>
    </>
  )
}

function OpponentSettings({
  value,
  disabled,
  onChange,
  onValidityChange,
  manualTagInvalid,
  timingInvalid,
}: {
  value: OverlaySettings
  disabled: boolean
  onChange: (value: OverlaySettings) => void
  onValidityChange: (fieldKey: string, invalid: boolean) => void
  manualTagInvalid: boolean
  timingInvalid: boolean
}): React.JSX.Element {
  const manualTagErrorId = useId()
  const timingErrorId = useId()
  const setNumber = (key: keyof OverlaySettings) => (next: number) =>
    onChange({ ...value, [key]: next })
  return (
    <>
      <div className="streamer-form compact-form">
        <Select
          label="Компоновка"
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
            Тег аккаунта
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
        <NumberField
          fieldKey="recentLimit"
          label="Последних личных встреч"
          value={value.recentLimit}
          min={1}
          max={10}
          disabled={disabled}
          onChange={setNumber('recentLimit')}
          onValidityChange={onValidityChange}
        />
      </div>

      <details className="streamer-disclosure">
        <summary>
          <span>Тайминги и сравнение</span>
          <small>Второй слайд, матчап и длительность показа</small>
        </summary>
        <div className="streamer-switch-grid advanced-switches">
          <StreamerToggle
            label="Показывать колоды и матчап"
            checked={value.opponentSecondSlideEnabled}
            disabled={disabled}
            onChange={(opponentSecondSlideEnabled) =>
              onChange({ ...value, opponentSecondSlideEnabled })
            }
          />
          <StreamerToggle
            label="Рассчитывать преимущество"
            checked={value.matchupEnabled}
            disabled={disabled || !value.opponentSecondSlideEnabled}
            onChange={(matchupEnabled) => {
              if (!matchupEnabled) onValidityChange('matchupRankLimits', false)
              onChange({ ...value, matchupEnabled })
            }}
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
              ['opponentDisplaySeconds', 'Общее время показа, сек', 5, 120],
              ['opponentSlideSeconds', 'Второй слайд, сек', 3, 60],
              ['opponentTransitionMs', 'Переход между слайдами, мс', 100, 3000],
              ['matchupMinGames', 'Минимум боёв для оценки', 1, 100],
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
            key={value.matchupEnabled ? 'enabled' : 'disabled'}
            value={value.matchupRankLimits}
            disabled={disabled || !value.matchupEnabled}
            onChange={(matchupRankLimits) => onChange({ ...value, matchupRankLimits })}
            onValidityChange={(nextInvalid) =>
              onValidityChange('matchupRankLimits', nextInvalid)
            }
          />
        </div>
      </details>
    </>
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

function widgetPreviewUrl(kind: 'stats' | 'opponent', settings: OverlaySettings): string {
  const path = kind === 'stats' ? '/streamer-stats-widget' : '/opponent-widget'
  const parameters = new URLSearchParams({
    mock: '1',
    layout: kind === 'stats' ? settings.statsLayout : settings.opponentLayout,
    font: settings.widgetFontStyle,
    shape: settings.widgetCornerStyle,
  })
  return `${WIDGET_ORIGIN}${path}?${parameters.toString()}`
}

function recommendedDraftSizes(settings: OverlaySettings): {
  stats: string
  opponent: string
} {
  const stats = { compact: '360 × 48', standard: '480 × 64', detailed: '720 × 96' }
  const opponent = {
    compact: '420 × 300',
    standard: '560 × 380',
    detailed: '760 × 500',
  }
  return {
    stats: stats[settings.statsLayout],
    opponent: opponent[settings.opponentLayout],
  }
}
