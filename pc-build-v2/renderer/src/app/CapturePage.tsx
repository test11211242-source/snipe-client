import {
  Check,
  ChevronRight,
  Copy,
  Link,
  Monitor,
  Pencil,
  Play,
  Plus,
  RefreshCw,
  ScanLine,
  Search,
  Trash2,
} from 'lucide-react'
import { useEffect, useEffectEvent, useRef, useState } from 'react'

import type { CapturePreparationResult } from '../../../shared/contracts/capture-ipc'
import { MAX_CAPTURE_PROFILES } from '../../../shared/models/capture'
import type {
  CaptureSourceSnapshot,
  CaptureSourceView,
  CaptureStatus,
  CaptureProfilesView,
} from '../../../shared/models/capture'
import type { MonitorView } from '../../../shared/models/monitor'
import { Alert, Button, PageHeader, Tabs } from './ui'

type SourceTab = 'window' | 'display'
interface ProfileAction {
  kind: 'configure' | 'rebind'
  profileId: string | null
  profileName: string
  expectedRevision: number
}

export function CapturePage({
  status,
  profiles,
  onStatus,
  onProfiles,
  onMonitor,
}: {
  status: CaptureStatus | null
  profiles: CaptureProfilesView | null
  onStatus: (status: CaptureStatus) => void
  onProfiles: (profiles: CaptureProfilesView) => void
  onMonitor: (monitor: MonitorView) => void
}): React.JSX.Element {
  const [snapshot, setSnapshot] = useState<CaptureSourceSnapshot | null>(null)
  const [tab, setTab] = useState<SourceTab>('window')
  const [loading, setLoading] = useState(true)
  const [startingKey, setStartingKey] = useState<string | null>(null)
  const [preparingKey, setPreparingKey] = useState<string | null>(null)
  const [preparation, setPreparation] = useState<CapturePreparationResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [selectedKey, setSelectedKey] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [availableOnly, setAvailableOnly] = useState(true)
  const [profileAction, setProfileAction] = useState<ProfileAction | null>(null)
  const [profileBusy, setProfileBusy] = useState<string | null>(null)
  const selectedRef = useRef<CaptureSourceView | null>(null)
  const selectionGeneration = useRef(0)
  const applyStatus = useEffectEvent(onStatus)
  const applyProfiles = useEffectEvent(onProfiles)
  const actionProfile =
    profileAction === null || profiles === null
      ? undefined
      : profileAction.profileId === null
        ? profiles.profiles.find(
            (profile) =>
              profile.profileName.toLocaleLowerCase('ru-RU') ===
              profileAction.profileName.toLocaleLowerCase('ru-RU'),
          )
        : profiles.profiles.find(
            (profile) => profile.profileId === profileAction.profileId,
          )
  const activeProfile = profiles?.profiles.find((profile) => profile.isActive)
  const currentProfileAction: ProfileAction | null =
    actionProfile !== undefined
      ? {
          ...(profileAction ?? { kind: 'configure' as const }),
          profileId: actionProfile.profileId,
          profileName: actionProfile.profileName,
          expectedRevision: profiles?.revision ?? profileAction?.expectedRevision ?? 0,
        }
      : profileAction?.profileId === null
        ? profileAction
        : profiles === null
          ? null
          : {
              kind: 'configure',
              profileId: activeProfile?.profileId ?? null,
              profileName: activeProfile?.profileName ?? 'Основной',
              expectedRevision: profiles.revision ?? 0,
            }

  const releaseSelection = (): void => {
    selectionGeneration.current += 1
    const selected = selectedRef.current
    selectedRef.current = null
    setSelectedKey(null)
    setPreparation(null)
    setPreparingKey(null)
    if (selected !== null) {
      void window.crTools
        .releaseCaptureSource({
          sourceKey: selected.sourceKey,
          revision: selected.revision,
        })
        .catch(() => undefined)
    }
  }

  const refresh = async (): Promise<void> => {
    releaseSelection()
    setLoading(true)
    setError(null)
    try {
      const nextSnapshot = await window.crTools.listCaptureSources()
      setSnapshot(nextSnapshot)
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
      selectionGeneration.current += 1
      const selected = selectedRef.current
      if (selected !== null) {
        void window.crTools
          .releaseCaptureSource({
            sourceKey: selected.sourceKey,
            revision: selected.revision,
          })
          .catch(() => undefined)
      }
      selectedRef.current = null
    }
  }, [])

  useEffect(() => {
    const refreshStatus = (): void => {
      void window.crTools.getCaptureStatus().then(applyStatus, () => undefined)
      void window.crTools.getCaptureProfiles().then(applyProfiles, () => undefined)
    }
    window.addEventListener('focus', refreshStatus)
    return () => window.removeEventListener('focus', refreshStatus)
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

  const applyMutation = (result: {
    profiles: CaptureProfilesView
    monitor: MonitorView
  }): void => {
    onProfiles(result.profiles)
    onMonitor(result.monitor)
  }

  const activateProfile = async (profileId: string): Promise<void> => {
    if (profiles?.revision === null || profiles?.revision === undefined) return
    setProfileBusy(profileId)
    setError(null)
    try {
      const result = await window.crTools.activateCaptureProfile({
        profileId,
        expectedRevision: profiles.revision,
      })
      applyMutation(result)
      const active = result.profiles.profiles.find((profile) => profile.isActive)
      if (active !== undefined) {
        setProfileAction({
          kind: 'configure',
          profileId: active.profileId,
          profileName: active.profileName,
          expectedRevision: result.profiles.revision ?? 0,
        })
      }
      onStatus(await window.crTools.getCaptureStatus())
    } catch {
      setError(
        'Не удалось включить профиль. Если окно изменилось, перепривяжите источник.',
      )
    } finally {
      setProfileBusy(null)
    }
  }

  const addProfile = (): void => {
    const name = window.prompt(
      'Название нового профиля',
      `Профиль ${(profiles?.profiles.length ?? 0) + 1}`,
    )
    const trimmed = name?.trim()
    if (trimmed === undefined || trimmed.length === 0) return
    if (trimmed.length > 80) {
      setError('Название профиля должно быть короче 81 символа.')
      return
    }
    if (
      profiles?.profiles.some(
        (profile) =>
          profile.profileName.toLocaleLowerCase('ru-RU') ===
          trimmed.toLocaleLowerCase('ru-RU'),
      ) === true
    ) {
      setError('Профиль с таким названием уже существует.')
      return
    }
    releaseSelection()
    setProfileAction({
      kind: 'configure',
      profileId: null,
      profileName: trimmed,
      expectedRevision: profiles?.revision ?? 0,
    })
  }

  const renameProfile = async (profileId: string, currentName: string): Promise<void> => {
    if (profiles?.revision === null || profiles?.revision === undefined) return
    const name = window.prompt('Новое название профиля', currentName)?.trim()
    if (name === undefined || name.length === 0 || name === currentName) return
    setProfileBusy(profileId)
    setError(null)
    try {
      const result = await window.crTools.renameCaptureProfile({
        profileId,
        profileName: name,
        expectedRevision: profiles.revision,
      })
      applyMutation(result)
      setProfileAction((current) =>
        current?.profileId === profileId
          ? {
              ...current,
              profileName: name,
              expectedRevision: result.profiles.revision ?? current.expectedRevision,
            }
          : current,
      )
    } catch {
      setError('Не удалось переименовать профиль. Название должно быть уникальным.')
    } finally {
      setProfileBusy(null)
    }
  }

  const duplicateProfile = async (
    profileId: string,
    currentName: string,
  ): Promise<void> => {
    if (profiles?.revision === null || profiles?.revision === undefined) return
    const name = window.prompt('Название копии профиля', `${currentName} 2`)?.trim()
    if (name === undefined || name.length === 0) return
    setProfileBusy(profileId)
    setError(null)
    try {
      const result = await window.crTools.duplicateCaptureProfile({
        profileId,
        profileName: name,
        expectedRevision: profiles.revision,
      })
      applyMutation(result)
      const duplicate = result.profiles.profiles.find(
        (profile) => profile.profileName === name,
      )
      if (duplicate !== undefined) {
        releaseSelection()
        setProfileAction({
          kind: 'rebind',
          profileId: duplicate.profileId,
          profileName: duplicate.profileName,
          expectedRevision: result.profiles.revision ?? 0,
        })
      }
    } catch {
      setError('Не удалось дублировать профиль. Проверьте название и повторите.')
    } finally {
      setProfileBusy(null)
    }
  }

  const deleteProfile = async (profileId: string, profileName: string): Promise<void> => {
    if (
      profiles?.revision === null ||
      profiles?.revision === undefined ||
      !window.confirm(`Удалить профиль «${profileName}»?`)
    ) {
      return
    }
    setProfileBusy(profileId)
    setError(null)
    try {
      const result = await window.crTools.deleteCaptureProfile({
        profileId,
        expectedRevision: profiles.revision,
      })
      applyMutation(result)
      const active = result.profiles.profiles.find((profile) => profile.isActive)
      setProfileAction(
        active === undefined
          ? null
          : {
              kind: 'configure',
              profileId: active.profileId,
              profileName: active.profileName,
              expectedRevision: result.profiles.revision ?? 0,
            },
      )
      onStatus(await window.crTools.getCaptureStatus())
    } catch {
      setError('Не удалось удалить профиль. Единственный профиль удалить нельзя.')
    } finally {
      setProfileBusy(null)
    }
  }

  const selectSource = async (source: CaptureSourceView): Promise<void> => {
    if (!source.captureSupported || startingKey !== null) return
    if (
      selectedRef.current?.sourceKey === source.sourceKey &&
      (preparation?.sourceKey === source.sourceKey || preparingKey === source.sourceKey)
    ) {
      return
    }
    const generation = ++selectionGeneration.current
    selectedRef.current = source
    setSelectedKey(source.sourceKey)
    setPreparation(null)
    setPreparingKey(source.sourceKey)
    setError(null)
    try {
      const prepared = await window.crTools.prepareCaptureSource({
        sourceKey: source.sourceKey,
        revision: source.revision,
      })
      if (
        generation !== selectionGeneration.current ||
        selectedRef.current.sourceKey !== source.sourceKey
      ) {
        return
      }
      setPreparation(prepared)
    } catch {
      if (generation !== selectionGeneration.current) return
      setError('Не удалось подготовить выбранный источник. Выберите его повторно.')
    } finally {
      if (generation === selectionGeneration.current) setPreparingKey(null)
    }
  }

  const start = async (source: CaptureSourceView): Promise<void> => {
    const prepared = preparation
    if (
      !source.captureSupported ||
      !sources.includes(source) ||
      prepared?.sourceKey !== source.sourceKey ||
      prepared.revision !== source.revision
    ) {
      return
    }
    setStartingKey(source.sourceKey)
    setError(null)
    try {
      if (
        currentProfileAction?.kind === 'rebind' &&
        currentProfileAction.profileId !== null
      ) {
        applyMutation(
          await window.crTools.rebindCaptureProfile({
            preparationId: prepared.preparationId,
            profileId: currentProfileAction.profileId,
            expectedRevision: currentProfileAction.expectedRevision,
          }),
        )
        onStatus(await window.crTools.getCaptureStatus())
      } else if (currentProfileAction !== null) {
        await window.crTools.startCaptureSetup({
          preparationId: prepared.preparationId,
          profileId: currentProfileAction.profileId,
          profileName: currentProfileAction.profileName,
          expectedRevision: currentProfileAction.expectedRevision,
        })
      }
      selectedRef.current = null
      setPreparation(null)
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

      <section
        className="capture-profile-manager"
        aria-labelledby="capture-profiles-title"
      >
        <div className="capture-profile-heading">
          <div>
            <span className="eyebrow">ПРОФИЛИ ЗАХВАТА</span>
            <h3 id="capture-profiles-title">Сохранённые конфигурации</h3>
          </div>
          <Button
            onClick={addProfile}
            disabled={
              profileBusy !== null ||
              (profiles?.profiles.length ?? 0) >= MAX_CAPTURE_PROFILES
            }
          >
            <Plus aria-hidden="true" size={15} />
            Добавить профиль
          </Button>
        </div>
        {profiles === null ? (
          <p className="profile-manager-empty">Загружаем профили...</p>
        ) : profiles.profiles.length === 0 ? (
          <p className="profile-manager-empty">
            Создайте первый профиль и выберите окно игры ниже.
          </p>
        ) : (
          <div className="capture-profile-list">
            {profiles.profiles.map((profile) => (
              <article
                className="capture-profile-card"
                data-active={profile.isActive}
                data-selected={currentProfileAction?.profileId === profile.profileId}
                key={profile.profileId}
              >
                <div className="capture-profile-copy">
                  <div>
                    <strong>{profile.profileName}</strong>
                    {profile.isActive && <span>Активный</span>}
                  </div>
                  <small title={profile.sourceLabel}>{profile.sourceLabel}</small>
                </div>
                <div className="capture-profile-actions">
                  {!profile.isActive && (
                    <Button
                      variant="text"
                      disabled={profileBusy !== null}
                      onClick={() => void activateProfile(profile.profileId)}
                    >
                      <Play aria-hidden="true" size={13} />
                      Использовать
                    </Button>
                  )}
                  <Button
                    variant="text"
                    disabled={profileBusy !== null}
                    onClick={() => {
                      releaseSelection()
                      setProfileAction({
                        kind: 'rebind',
                        profileId: profile.profileId,
                        profileName: profile.profileName,
                        expectedRevision: profiles.revision ?? 0,
                      })
                    }}
                  >
                    <Link aria-hidden="true" size={13} />
                    Перепривязать
                  </Button>
                  <Button
                    variant="text"
                    disabled={profileBusy !== null}
                    onClick={() => {
                      releaseSelection()
                      setProfileAction({
                        kind: 'configure',
                        profileId: profile.profileId,
                        profileName: profile.profileName,
                        expectedRevision: profiles.revision ?? 0,
                      })
                    }}
                  >
                    <ScanLine aria-hidden="true" size={13} />
                    Области
                  </Button>
                  <Button
                    variant="icon"
                    aria-label={`Переименовать ${profile.profileName}`}
                    disabled={profileBusy !== null}
                    onClick={() =>
                      void renameProfile(profile.profileId, profile.profileName)
                    }
                  >
                    <Pencil aria-hidden="true" size={13} />
                  </Button>
                  <Button
                    variant="icon"
                    aria-label={`Дублировать ${profile.profileName}`}
                    disabled={profileBusy !== null}
                    onClick={() =>
                      void duplicateProfile(profile.profileId, profile.profileName)
                    }
                  >
                    <Copy aria-hidden="true" size={13} />
                  </Button>
                  <Button
                    variant="icon"
                    aria-label={`Удалить ${profile.profileName}`}
                    disabled={profileBusy !== null || profiles.profiles.length === 1}
                    onClick={() =>
                      void deleteProfile(profile.profileId, profile.profileName)
                    }
                  >
                    <Trash2 aria-hidden="true" size={13} />
                  </Button>
                </div>
              </article>
            ))}
          </div>
        )}
        {currentProfileAction !== null && (
          <div className="capture-profile-task" data-kind={currentProfileAction.kind}>
            <strong>
              {currentProfileAction.kind === 'rebind' ? 'Перепривязка' : 'Настройка'}:{' '}
              {currentProfileAction.profileName}
            </strong>
            <span>
              {currentProfileAction.kind === 'rebind'
                ? 'Выберите другое окно. Сохранённые области останутся без изменений.'
                : 'Выберите источник, затем настройте области распознавания.'}
            </span>
          </div>
        )}
      </section>

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
              releaseSelection()
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
            releaseSelection()
          }}
        />
        <Button
          className="availability-filter"
          aria-pressed={availableOnly}
          onClick={() => {
            setAvailableOnly((value) => !value)
            releaseSelection()
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
                  busy={
                    startingKey === source.sourceKey || preparingKey === source.sourceKey
                  }
                  onSelect={() => void selectSource(source)}
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
                <p>
                  {currentProfileAction?.kind === 'rebind'
                    ? 'Области останутся прежними.'
                    : 'Настройка областей откроется в отдельном окне.'}
                </p>
              </>
            )}
          </div>
          {error !== null && <Alert>{error}</Alert>}
          <Button
            className="source-continue"
            variant="primary"
            disabled={
              selectedSource === null ||
              currentProfileAction === null ||
              !selectedSource.captureSupported ||
              preparation === null ||
              preparingKey !== null ||
              startingKey !== null
            }
            onClick={() => selectedSource !== null && void start(selectedSource)}
          >
            {startingKey !== null
              ? 'Фиксируем кадр...'
              : preparingKey !== null
                ? 'Подготовка захвата...'
                : currentProfileAction?.kind === 'rebind'
                  ? 'Перепривязать источник'
                  : 'Продолжить к настройке'}
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
  const previewState = !source.captureSupported
    ? 'unavailable'
    : source.preview !== null
      ? 'ready'
      : 'error'

  const previewLabel = !source.captureSupported
    ? 'Источник недоступен'
    : source.preview === null
      ? 'Миниатюра недоступна'
      : `${source.preview.size.width} × ${source.preview.size.height}`

  return (
    <article
      className="source-card"
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
          {source.preview !== null ? (
            <img src={source.preview.dataUrl} alt="" />
          ) : (
            <ScanLine
              className={busy ? 'is-spinning' : undefined}
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
