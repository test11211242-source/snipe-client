import { Check, ChevronRight, Monitor, RefreshCw, ScanLine, Search } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'

import type {
  CaptureSourcePreview,
  CaptureSourceSnapshot,
  CaptureSourceView,
  CaptureStatus,
} from '../../../shared/models/capture'
import { Alert, Button, PageHeader, Tabs } from './ui'

type SourceTab = 'window' | 'display'

export function CapturePage({
  status,
  onStatus,
}: {
  status: CaptureStatus | null
  onStatus: (status: CaptureStatus) => void
}): React.JSX.Element {
  const [snapshot, setSnapshot] = useState<CaptureSourceSnapshot | null>(null)
  const [tab, setTab] = useState<SourceTab>('window')
  const [loading, setLoading] = useState(true)
  const [startingKey, setStartingKey] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [selectedKey, setSelectedKey] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [availableOnly, setAvailableOnly] = useState(true)

  const refresh = async (): Promise<void> => {
    setLoading(true)
    setError(null)
    try {
      const nextSnapshot = await window.crTools.listCaptureSources()
      setSnapshot(nextSnapshot)
      setSelectedKey((current) =>
        nextSnapshot.sources.some((source) => source.sourceKey === current)
          ? current
          : null,
      )
    } catch {
      setError('Не удалось получить источники. Захват доступен только в Windows.')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    let active = true
    void window.crTools
      .listCaptureSources()
      .then(
        (value) => {
          if (active) setSnapshot(value)
        },
        () => {
          if (active)
            setError('Не удалось получить источники. Захват доступен только в Windows.')
        },
      )
      .finally(() => {
        if (active) setLoading(false)
      })
    return () => {
      active = false
    }
  }, [])

  const allSources = snapshot?.sources ?? []
  const normalizedQuery = query.trim().toLocaleLowerCase('ru-RU')
  const sources = allSources.filter(
    (source) =>
      source.kind === tab &&
      (!availableOnly || source.captureSupported) &&
      (normalizedQuery.length === 0 ||
        source.label.toLocaleLowerCase('ru-RU').includes(normalizedQuery) ||
        source.detail?.toLocaleLowerCase('ru-RU').includes(normalizedQuery) === true),
  )
  const selectedSource =
    sources.find((source) => source.sourceKey === selectedKey) ?? null

  const start = async (source: CaptureSourceView): Promise<void> => {
    if (!source.captureSupported || !sources.includes(source)) return
    setStartingKey(source.sourceKey)
    setError(null)
    try {
      await window.crTools.startCaptureSetup({
        sourceKey: source.sourceKey,
        revision: source.revision,
      })
      onStatus(await window.crTools.getCaptureStatus())
    } catch {
      setError(
        'Источник изменился или захват не запустился. Обновите список и повторите.',
      )
    } finally {
      setStartingKey(null)
    }
  }

  const windowCount = allSources.filter((source) => source.kind === 'window').length
  const displayCount = allSources.filter((source) => source.kind === 'display').length

  return (
    <section className="capture-page" aria-labelledby="capture-heading">
      <PageHeader
        eyebrow="ИСТОЧНИК ИЗОБРАЖЕНИЯ"
        headingId="capture-heading"
        title="Источник захвата"
        description="Выберите окно Clash Royale или монитор. Области распознавания настраиваются на следующем шаге."
        actions={
          <Button onClick={() => void refresh()} disabled={loading}>
            <RefreshCw
              className={loading ? 'is-spinning' : undefined}
              aria-hidden="true"
              size={16}
            />
            {loading ? 'Обновляем...' : 'Обновить список'}
          </Button>
        }
      />

      <div className="source-toolbar">
        <label className="source-search">
          <Search aria-hidden="true" size={17} />
          <span className="sr-only">Поиск источника</span>
          <input
            type="search"
            value={query}
            placeholder="Поиск по названию"
            onChange={(event) => {
              setQuery(event.currentTarget.value)
              setSelectedKey(null)
            }}
          />
        </label>
        <Tabs
          className="source-tabs"
          id="capture-source"
          label="Тип источника"
          tabs={[
            { id: 'window', label: 'Окна', count: windowCount },
            { id: 'display', label: 'Мониторы', count: displayCount },
          ]}
          value={tab}
          onChange={(nextTab) => {
            setTab(nextTab)
            setSelectedKey(null)
          }}
        />
        <Button
          className="availability-filter"
          aria-pressed={availableOnly}
          onClick={() => {
            setAvailableOnly((value) => !value)
            setSelectedKey(null)
          }}
        >
          Только доступные
        </Button>
      </div>

      <div className="capture-workspace">
        <div
          className="source-browser"
          id={`capture-source-panel-${tab}`}
          role="tabpanel"
          aria-labelledby={`capture-source-tab-${tab}`}
        >
          {loading && snapshot === null ? (
            <div className="source-grid" aria-label="Загрузка источников" role="status">
              {Array.from({ length: 6 }, (_, index) => (
                <div className="source-card source-card-skeleton" key={index}>
                  <span />
                  <div>
                    <i />
                    <i />
                  </div>
                </div>
              ))}
            </div>
          ) : sources.length === 0 ? (
            <div className="source-empty">
              <Monitor aria-hidden="true" size={25} />
              <strong>
                {normalizedQuery.length > 0
                  ? `По запросу «${query.trim()}» ничего не найдено`
                  : availableOnly
                    ? 'Доступные источники не найдены'
                    : 'Источники не найдены'}
              </strong>
              <span>
                {normalizedQuery.length > 0
                  ? 'Измените запрос или переключите тип источника.'
                  : 'Откройте нужное окно, измените фильтр или обновите список.'}
              </span>
            </div>
          ) : (
            <div className="source-grid">
              {sources.map((source) => (
                <SourceCard
                  key={`${source.sourceKey}-${source.revision}`}
                  source={source}
                  selected={selectedKey === source.sourceKey}
                  disabled={startingKey !== null}
                  busy={startingKey === source.sourceKey}
                  onSelect={() => setSelectedKey(source.sourceKey)}
                />
              ))}
            </div>
          )}
        </div>

        <aside className="source-selection" aria-live="polite">
          <div>
            <span className="eyebrow">ТЕКУЩАЯ КОНФИГУРАЦИЯ</span>
            <strong title={status?.sourceLabel ?? undefined}>
              {status?.sourceLabel ?? 'Источник не настроен'}
            </strong>
            <p>
              {status?.configured === true
                ? 'Конфигурация активна и готова к проверке.'
                : 'Перед запуском мониторинга выберите источник.'}
            </p>
          </div>
          <div className="selection-summary">
            <span className="eyebrow">ВЫБРАННЫЙ ИСТОЧНИК</span>
            {selectedSource === null ? (
              <p>Выберите источник из текущего списка.</p>
            ) : (
              <>
                <strong title={selectedSource.label}>{selectedSource.label}</strong>
                <span>
                  {selectedSource.detail ??
                    (selectedSource.kind === 'window' ? 'Окно приложения' : 'Монитор')}
                </span>
                <p>Настройка областей откроется в отдельном окне.</p>
              </>
            )}
          </div>
          {error !== null && <Alert>{error}</Alert>}
          <Button
            className="source-continue"
            variant="primary"
            disabled={
              selectedSource === null ||
              !selectedSource.captureSupported ||
              startingKey !== null
            }
            onClick={() => selectedSource !== null && void start(selectedSource)}
          >
            {startingKey !== null ? 'Получаем кадр...' : 'Продолжить к настройке'}
            {startingKey === null && <ChevronRight aria-hidden="true" size={15} />}
          </Button>
        </aside>
      </div>
    </section>
  )
}

function SourceCard({
  source,
  selected,
  disabled,
  busy,
  onSelect,
}: {
  source: CaptureSourceView
  selected: boolean
  disabled: boolean
  busy: boolean
  onSelect: () => void
}): React.JSX.Element {
  const [preview, setPreview] = useState<CaptureSourcePreview | null>(null)
  const [previewError, setPreviewError] = useState(false)
  const [visible, setVisible] = useState(false)
  const cardRef = useRef<HTMLElement>(null)

  useEffect(() => {
    const node = cardRef.current
    if (node === null || typeof IntersectionObserver === 'undefined') {
      setVisible(true)
      return
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (!entries.some((entry) => entry.isIntersecting)) return
        observer.disconnect()
        setVisible(true)
      },
      { rootMargin: '120px' },
    )
    observer.observe(node)
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    if (!visible || !source.captureSupported) return
    let active = true
    void window.crTools
      .getCapturePreview({ sourceKey: source.sourceKey, revision: source.revision })
      .then((value) => {
        if (!active) return
        setPreview(value)
      })
      .catch(() => {
        if (active) setPreviewError(true)
      })
    return () => {
      active = false
    }
  }, [source.captureSupported, source.revision, source.sourceKey, visible])

  const previewState = !source.captureSupported
    ? 'unavailable'
    : previewError
      ? 'error'
      : preview !== null
        ? 'ready'
        : 'loading'

  const previewLabel = !source.captureSupported
    ? 'Источник недоступен'
    : previewState === 'error'
      ? 'Миниатюра недоступна'
      : previewState === 'ready' && preview !== null
        ? `${preview.size.width} × ${preview.size.height}`
        : 'Загружаем миниатюру'

  return (
    <article
      className="source-card"
      ref={cardRef}
      data-selected={selected}
      data-unavailable={!source.captureSupported}
      data-preview-state={previewState}
    >
      <button
        className="source-card-select"
        type="button"
        aria-label={`${source.label}. ${previewLabel}`}
        aria-pressed={selected}
        disabled={disabled || !source.captureSupported}
        onClick={onSelect}
      >
        <div className="source-preview">
          {preview !== null ? (
            <img src={preview.dataUrl} alt="" />
          ) : (
            <ScanLine
              className={previewState === 'loading' || busy ? 'is-spinning' : undefined}
              aria-hidden="true"
              size={25}
            />
          )}
          {selected && (
            <span className="source-selected-mark" aria-hidden="true">
              <Check size={13} />
            </span>
          )}
        </div>
        <div className="source-card-body">
          <div>
            <strong title={source.label}>{source.label}</strong>
            <span>
              {source.detail ??
                (source.kind === 'window' ? 'Окно приложения' : 'Монитор')}
            </span>
          </div>
          <small>{previewLabel}</small>
          {source.unavailableReason !== null && <p>{source.unavailableReason}</p>}
        </div>
      </button>
    </article>
  )
}
