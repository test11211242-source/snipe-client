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

function preparationFailureMessage(code: string): string {
  if (code === 'CAPTURE_PREPARATION_TIMEOUT') {
    return 'Захват не запустился за 8 секунд. Убедитесь, что источник доступен и не свёрнут, затем повторите выбор.'
  }
  if (
    code === 'CAPTURE_PREPARATION_START_FAILED' ||
    code === 'CAPTURE_PREPARATION_EXITED'
  ) {
    return 'Служба захвата не запустилась. Повторите выбор источника.'
  }
  if (code === 'DISPLAY_MAPPING_UNSUPPORTED') {
    return 'Выбранный монитор нельзя безопасно сопоставить с устройством Windows.'
  }
  if (code === 'CAPTURE_PREPARATION_CANCELLED') {
    return 'Подготовка источника была отменена. Выберите его повторно.'
  }
  return 'Не удалось запустить захват выбранного источника. Повторите выбор.'
}

interface ProfileAction {
  kind: 'configure' | 'rebind'
  profileId: string | null
  profileName: string
  expectedRevision: number
}

type ProfileDialogState =
  | {
      kind: 'create'
      initialName: string
    }
  | {
      kind: 'rename' | 'duplicate' | 'delete'
      profileId: string
      profileName: string
      initialName: string
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
  const [profileDialog, setProfileDialog] = useState<ProfileDialogState | null>(null)
  const [profileDialogName, setProfileDialogName] = useState('')
  const [profileDialogError, setProfileDialogError] = useState<string | null>(null)
  const selectedRef = useRef<CaptureSourceView | null>(null)
  const selectionGeneration = useRef(0)
  const sourceRefreshGeneration = useRef(0)
  const profileRefreshGeneration = useRef(0)
  const profileDialogRef = useRef<HTMLDialogElement | null>(null)
  const profileDialogReturnFocus = useRef<HTMLElement | null>(null)
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

  const refresh = async (): Promise<boolean> => {
    const generation = ++sourceRefreshGeneration.current
    releaseSelection()
    setLoading(true)
    setError(null)
    try {
      const nextSnapshot = await window.crTools.listCaptureSources()
      if (generation === sourceRefreshGeneration.current) setSnapshot(nextSnapshot)
      return true
    } catch {
      if (generation === sourceRefreshGeneration.current) {
        setError('Не удалось получить источники. Захват доступен только в Windows.')
      }
      return false
    } finally {
      if (generation === sourceRefreshGeneration.current) setLoading(false)
    }
  }

  useEffect(() => {
    let active = true
    const generation = ++sourceRefreshGeneration.current
    void window.crTools
      .listCaptureSources()
      .then(
        (value) => {
          if (active && generation === sourceRefreshGeneration.current) {
            setSnapshot(value)
          }
        },
        () => {
          if (active && generation === sourceRefreshGeneration.current)
            setError('Не удалось получить источники. Захват доступен только в Windows.')
        },
      )
      .finally(() => {
        if (active && generation === sourceRefreshGeneration.current) setLoading(false)
      })
    return () => {
      active = false
      sourceRefreshGeneration.current += 1
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
      const generation = ++profileRefreshGeneration.current
      void Promise.all([
        window.crTools.getCaptureStatus(),
        window.crTools.getCaptureProfiles(),
      ]).then(
        ([nextStatus, nextProfiles]) => {
          if (generation !== profileRefreshGeneration.current) return
          applyStatus(nextStatus)
          applyProfiles(nextProfiles)
        },
        () => undefined,
      )
    }
    window.addEventListener('focus', refreshStatus)
    return () => {
      profileRefreshGeneration.current += 1
      window.removeEventListener('focus', refreshStatus)
    }
  }, [])

  useEffect(() => {
    const dialog = profileDialogRef.current
    if (profileDialog !== null && dialog !== null && !dialog.open) dialog.showModal()
    if (profileDialog === null && profileDialogReturnFocus.current !== null) {
      const trigger = profileDialogReturnFocus.current
      const fallback = document.querySelector<HTMLElement>('.page-identity h1')
      const target =
        trigger.isConnected && !trigger.matches(':disabled') ? trigger : fallback
      target?.focus()
      profileDialogReturnFocus.current = null
    }
    return () => {
      if (dialog?.open === true) dialog.close()
    }
  }, [profileDialog])

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
    capture: CaptureStatus
  }): void => {
    profileRefreshGeneration.current += 1
    onProfiles(result.profiles)
    onMonitor(result.monitor)
    onStatus(result.capture)
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
    } catch {
      setError(
        'Не удалось включить профиль. Если окно изменилось, перепривяжите источник.',
      )
    } finally {
      setProfileBusy(null)
    }
  }

  const beginProfileDialog = (dialog: ProfileDialogState): void => {
    profileDialogReturnFocus.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null
    setProfileDialog(dialog)
    setProfileDialogName(dialog.initialName)
    setProfileDialogError(null)
  }

  const addProfile = (profileName: string): void => {
    releaseSelection()
    setProfileAction({
      kind: 'configure',
      profileId: null,
      profileName,
      expectedRevision: profiles?.revision ?? 0,
    })
  }

  const renameProfile = async (profileId: string, profileName: string): Promise<void> => {
    if (profiles?.revision === null || profiles?.revision === undefined) return
    setProfileBusy(profileId)
    setError(null)
    try {
      const result = await window.crTools.renameCaptureProfile({
        profileId,
        profileName,
        expectedRevision: profiles.revision,
      })
      applyMutation(result)
      setProfileAction((current) =>
        current?.profileId === profileId
          ? {
              ...current,
              profileName,
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
    profileName: string,
  ): Promise<void> => {
    if (profiles?.revision === null || profiles?.revision === undefined) return
    setProfileBusy(profileId)
    setError(null)
    try {
      const result = await window.crTools.duplicateCaptureProfile({
        profileId,
        profileName,
        expectedRevision: profiles.revision,
      })
      applyMutation(result)
      const duplicate = result.profiles.profiles.find(
        (profile) => profile.profileName === profileName,
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

  const deleteProfile = async (profileId: string): Promise<void> => {
    if (profiles?.revision === null || profiles?.revision === undefined) return
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
    } catch {
      setError('Не удалось удалить профиль. Единственный профиль удалить нельзя.')
    } finally {
      setProfileBusy(null)
    }
  }

  const submitProfileDialog = async (): Promise<void> => {
    const dialog = profileDialog
    if (dialog === null || profileBusy !== null) return
    if (dialog.kind === 'delete') {
      await deleteProfile(dialog.profileId)
      setProfileDialog(null)
      return
    }
    const profileName = profileDialogName.trim()
    if (profileName.length === 0) {
      setProfileDialogError('Введите название профиля.')
      return
    }
    if (profileName.length > 80) {
      setProfileDialogError('Название профиля должно быть короче 81 символа.')
      return
    }
    const duplicateName = profiles?.profiles.some(
      (profile) =>
        profile.profileId !== (dialog.kind === 'rename' ? dialog.profileId : null) &&
        profile.profileName.toLocaleLowerCase('ru-RU') ===
          profileName.toLocaleLowerCase('ru-RU'),
    )
    if (duplicateName === true) {
      setProfileDialogError('Профиль с таким названием уже существует.')
      return
    }
    if (dialog.kind === 'rename' && profileName === dialog.profileName) {
      setProfileDialog(null)
      return
    }
    if (dialog.kind === 'create') {
      addProfile(profileName)
      setProfileDialog(null)
    } else if (dialog.kind === 'rename') {
      await renameProfile(dialog.profileId, profileName)
      setProfileDialog(null)
    } else {
      await duplicateProfile(dialog.profileId, profileName)
      setProfileDialog(null)
    }
  }

  const selectSource = async (source: CaptureSourceView): Promise<void> => {
    if (loading || !source.captureSupported || startingKey !== null) return
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
      const response = await window.crTools.prepareCaptureSource({
        sourceKey: source.sourceKey,
        revision: source.revision,
      })
      if (
        generation !== selectionGeneration.current ||
        selectedRef.current.sourceKey !== source.sourceKey
      ) {
        return
      }
      if (!response.ok) {
        if (response.error.code === 'CAPTURE_SOURCE_STALE') {
          const refreshed = await refresh()
          if (refreshed) {
            setError(
              'Источник изменился. Список обновлён, выберите нужный источник ещё раз.',
            )
          }
        } else {
          setError(preparationFailureMessage(response.error.code))
        }
        return
      }
      const prepared = response.preparation
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
    setPreparation(null)
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
            onClick={() =>
              beginProfileDialog({
                kind: 'create',
                initialName: `Профиль ${(profiles?.profiles.length ?? 0) + 1}`,
              })
            }
            disabled={
              profiles === null ||
              profileBusy !== null ||
              profiles.profiles.length >= MAX_CAPTURE_PROFILES
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
                    title="Переименовать профиль"
                    disabled={profileBusy !== null}
                    onClick={() =>
                      beginProfileDialog({
                        kind: 'rename',
                        profileId: profile.profileId,
                        profileName: profile.profileName,
                        initialName: profile.profileName,
                      })
                    }
                  >
                    <Pencil aria-hidden="true" size={13} />
                  </Button>
                  <Button
                    variant="icon"
                    aria-label={`Дублировать ${profile.profileName}`}
                    title="Дублировать профиль"
                    disabled={
                      profileBusy !== null ||
                      profiles.profiles.length >= MAX_CAPTURE_PROFILES
                    }
                    onClick={() =>
                      beginProfileDialog({
                        kind: 'duplicate',
                        profileId: profile.profileId,
                        profileName: profile.profileName,
                        initialName: `${profile.profileName} 2`,
                      })
                    }
                  >
                    <Copy aria-hidden="true" size={13} />
                  </Button>
                  <Button
                    variant="icon"
                    aria-label={`Удалить ${profile.profileName}`}
                    title="Удалить профиль"
                    disabled={profileBusy !== null || profiles.profiles.length === 1}
                    onClick={() =>
                      beginProfileDialog({
                        kind: 'delete',
                        profileId: profile.profileId,
                        profileName: profile.profileName,
                        initialName: '',
                      })
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

      {profileDialog !== null && (
        <dialog
          aria-labelledby="profile-dialog-title"
          className="profile-dialog-shell"
          ref={profileDialogRef}
          onCancel={(event) => {
            if (profileBusy !== null) event.preventDefault()
            else setProfileDialog(null)
          }}
          onClick={(event) => {
            if (event.target === event.currentTarget && profileBusy === null) {
              setProfileDialog(null)
            }
          }}
        >
          <section aria-labelledby="profile-dialog-title" className="profile-dialog">
            <form
              onSubmit={(event) => {
                event.preventDefault()
                void submitProfileDialog()
              }}
            >
              <span className="eyebrow">ПРОФИЛЬ ЗАХВАТА</span>
              <h3 id="profile-dialog-title">
                {profileDialog.kind === 'create'
                  ? 'Новый профиль'
                  : profileDialog.kind === 'rename'
                    ? 'Переименовать профиль'
                    : profileDialog.kind === 'duplicate'
                      ? 'Дублировать профиль'
                      : 'Удалить профиль'}
              </h3>
              {profileDialog.kind === 'delete' ? (
                <p>
                  Удалить профиль <strong>«{profileDialog.profileName}»</strong>? Это
                  действие нельзя отменить.
                </p>
              ) : (
                <label>
                  <span>Название</span>
                  <input
                    autoFocus
                    maxLength={80}
                    value={profileDialogName}
                    aria-invalid={profileDialogError !== null}
                    aria-describedby={
                      profileDialogError === null ? undefined : 'profile-dialog-error'
                    }
                    onChange={(event) => {
                      setProfileDialogName(event.currentTarget.value)
                      setProfileDialogError(null)
                    }}
                  />
                </label>
              )}
              {profileDialogError !== null && (
                <p
                  className="profile-dialog-error"
                  id="profile-dialog-error"
                  role="alert"
                >
                  {profileDialogError}
                </p>
              )}
              <div className="profile-dialog-actions">
                <Button
                  autoFocus={profileDialog.kind === 'delete'}
                  disabled={profileBusy !== null}
                  onClick={() => setProfileDialog(null)}
                >
                  Отмена
                </Button>
                <Button
                  variant={profileDialog.kind === 'delete' ? 'danger' : 'primary'}
                  disabled={profileBusy !== null}
                  type="submit"
                >
                  {profileDialog.kind === 'create'
                    ? 'Продолжить'
                    : profileDialog.kind === 'rename'
                      ? 'Сохранить'
                      : profileDialog.kind === 'duplicate'
                        ? 'Создать копию'
                        : 'Удалить'}
                </Button>
              </div>
            </form>
          </section>
        </dialog>
      )}

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
                  disabled={loading || startingKey !== null}
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
