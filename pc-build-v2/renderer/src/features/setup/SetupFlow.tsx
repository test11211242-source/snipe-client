import { useEffect, useState } from 'react'

import type { CapturePreparationResult } from '../../../../shared/contracts/capture-ipc'
import type { SetupIntent } from '../../app/router'
import { useShellActions } from '../../app/shell/slotsContext'
import { State, useToast } from '../../ui'
import { useMonitorView, selectRunPhase } from '../monitor'
import { useProfiles } from '../profiles'
import { AutoFailure, AutoStage } from './AutoStage'
import { NameStep } from './EntrySteps'
import {
  commandErrorMessage,
  isSourceLostCode,
  SOURCE_LOST_TEXT,
  viewErrorMessage,
} from './errors'
import { RegionEditor } from './RegionEditor'
import { CheckStep, FailureView, OutcomeView } from './ResultViews'
import styles from './Setup.module.css'
import { prepareSameSource } from './retake'
import { SourceStage } from './SourceStage'
import { StepBar } from './StepBar'
import { useSetupSession } from './useSetupSession'

/** Where the route is. Automatic setup is a `DETECTING` session inside `session`. */
type Stage = 'boot' | 'name' | 'source' | 'session' | 'missing'
/** Inside a session: manual region editing, then the check of the analyzed trigger. */
type Phase = 'regions' | 'check'

const FULL_STEPS: readonly string[] = ['Название', 'Источник', 'Области', 'Проверка']
const AUTO_STEPS: readonly string[] = ['Название', 'Источник', 'Бой', 'Готово']

function defaultName(existing: readonly { profileName: string }[]): string {
  const taken = new Set(
    existing.map((item) => item.profileName.toLocaleLowerCase('ru-RU')),
  )
  if (existing.length === 0) return 'Основной'
  let index = existing.length + 1
  while (taken.has(`профиль ${index}`)) index += 1
  return `Профиль ${index}`
}

/**
 * Full-window setup: name → source → frozen frame → manual regions → analyzer check →
 * save. A session lives in main, so reopening the route resumes it. Cancel, close and back
 * end only the session; monitoring is never touched.
 */
export function SetupFlow({
  intent,
  onExit,
}: {
  intent: SetupIntent
  onExit: () => void
}): React.JSX.Element {
  const profiles = useProfiles()
  const monitor = useMonitorView()
  const toast = useToast()
  const { openProfiles } = useShellActions()
  const session = useSetupSession()
  const { view } = session
  const { resume } = session
  const [stage, setStage] = useState<Stage>('boot')
  const [phase, setPhase] = useState<Phase>('regions')
  const [typedName, setName] = useState<string | null>(null)
  const [exiting, setExiting] = useState(false)
  const [retakeNote, setRetakeNote] = useState<string | null>(null)
  // Sessions the user took to the manual editor / whose window is gone (by session id).
  const [adjustingFor, setAdjustingFor] = useState<string | null>(null)
  const [lostFor, setLostFor] = useState<string | null>(null)
  const [unavailableFor, setUnavailableFor] = useState<string | null>(null)
  const name = typedName ?? defaultName(profiles.value?.profiles ?? [])

  useEffect(() => {
    let active = true
    void resume().then((current) => {
      if (!active) return
      setStage(
        current !== null
          ? 'session'
          : intent.kind === 'new'
            ? 'name'
            : intent.kind === 'resume'
              ? 'missing'
              : 'source',
      )
    })
    return () => {
      active = false
    }
  }, [resume, intent.kind])

  // A retry that finds the window gone leaves the old failure on the view; remember that
  // this session's source is dead so the retry is not offered again.
  const sessionId = view?.sessionId ?? null
  const commandCode = session.errorCode
  if (sessionId !== null && isSourceLostCode(commandCode) && lostFor !== sessionId) {
    setLostFor(sessionId)
  }
  if (
    sessionId !== null &&
    commandCode === 'SETUP_CAPTURE_UNAVAILABLE' &&
    unavailableFor !== sessionId
  ) {
    setUnavailableFor(sessionId)
  }

  const adjusting = view !== null && adjustingFor === view.sessionId
  const sourceLost = view !== null && lostFor === view.sessionId
  const captureUnavailable = view !== null && unavailableFor === view.sessionId
  const detection = view?.detection ?? null
  // Automatic setup succeeded and the user has not started editing: save or adjust.
  const autoSuccess =
    stage === 'session' &&
    !adjusting &&
    detection?.status === 'succeeded' &&
    (view?.state === 'SELECTING' || view?.state === 'REVIEW')
  // The automatic track: its own step names, until the user moves to the manual editor.
  const autoTrack =
    intent.kind !== 'rebind' &&
    (stage === 'name' ||
      stage === 'source' ||
      (stage === 'session' &&
        !adjusting &&
        detection !== null &&
        (view?.state === 'DETECTING' || detection.status === 'succeeded')))
  const track = autoTrack ? AUTO_STEPS : FULL_STEPS
  const offset = intent.kind === 'new' || intent.kind === 'resume' ? 0 : 1
  const steps = intent.kind === 'rebind' ? track.slice(1, 2) : track.slice(offset)
  const effectivePhase: Phase = view?.state === 'REVIEW' ? 'check' : phase
  // Main did not find the game in the frozen frame: there is nothing to mark yet.
  const gameMissing =
    stage === 'session' &&
    view !== null &&
    view.state === 'FAILED' &&
    view.error?.code === 'SETUP_GAME_NOT_FOUND'
  // The window went away while manual setup tried to freeze a frame.
  const sourceLostFailure =
    stage === 'session' &&
    view !== null &&
    view.state === 'FAILED' &&
    isSourceLostCode(view.error?.code)
  const manualIndex =
    stage === 'name'
      ? 0
      : stage === 'source' || gameMissing || sourceLostFailure
        ? 1
        : view?.state === 'COMMITTED'
          ? FULL_STEPS.length
          : effectivePhase === 'check'
            ? 3
            : 2
  const autoIndex =
    stage === 'name'
      ? 0
      : stage === 'source'
        ? 1
        : view?.state === 'COMMITTED'
          ? AUTO_STEPS.length
          : detection?.status === 'succeeded'
            ? 3
            : 2
  const fullIndex = autoTrack ? autoIndex : manualIndex
  const index = Math.max(0, Math.min(steps.length, fullIndex - offset))
  const position = `Шаг ${Math.min(index + 1, steps.length)} из ${steps.length}`
  const committed = stage === 'session' && view?.state === 'COMMITTED'
  const running =
    selectRunPhase(monitor.value, (profiles.value?.profiles.length ?? 0) > 0) ===
    'running'

  const exit = async (): Promise<void> => {
    setExiting(true)
    const ended = await session.end()
    setExiting(false)
    if (ended) onExit()
  }

  const done = async (): Promise<void> => {
    void profiles.reload()
    void monitor.reload()
    await exit()
  }

  const start = async (
    preparation: CapturePreparationResult,
    mode: 'auto' | 'manual',
  ): Promise<string | null> => {
    const target =
      intent.kind === 'recalibrate'
        ? {
            profileId: intent.profileId,
            profileName: intent.profileName,
            expectedRevision: intent.expectedRevision,
          }
        : {
            profileId: null,
            profileName: name.trim(),
            expectedRevision: profiles.value?.revision ?? 0,
          }
    try {
      const next = await window.crTools.startCaptureSetup({
        mode,
        preparationId: preparation.preparationId,
        ...target,
      })
      await session.adopt(next)
      setPhase('regions')
      setRetakeNote(null)
      setStage('session')
      return null
    } catch (cause) {
      return commandErrorMessage(
        cause,
        mode === 'auto'
          ? 'Не удалось начать автонастройку. Выберите источник и повторите.'
          : 'Не удалось заморозить кадр. Выберите источник и повторите.',
      )
    }
  }

  /** «Настроить вручную» during or after the automatic wait: same session, editor next. */
  const manual = async (): Promise<void> => {
    const next = await session.switchToManual()
    if (next === null) return
    setAdjustingFor(next.sessionId)
    setPhase('regions')
  }

  const rebind = async (
    preparation: CapturePreparationResult,
  ): Promise<string | null> => {
    if (intent.kind !== 'rebind') return null
    const outcome = await profiles.rebind(intent.profileId, preparation.preparationId)
    if (!outcome.ok) return outcome.message
    const updated = outcome.profiles.profiles.find(
      (item) => item.profileId === intent.profileId,
    )
    const needsCheck = updated?.calibrationHealth === 'needs_validation'
    toast.show({
      message: needsCheck
        ? `Источник профиля «${intent.profileName}» обновлён. Области нужно проверить заново.`
        : `Источник профиля «${intent.profileName}» обновлён.`,
      ...(needsCheck ? { action: { label: 'К профилям', onAction: openProfiles } } : {}),
    })
    onExit()
    return null
  }

  const restart = async (): Promise<void> => {
    setExiting(true)
    const ended = await session.end()
    setExiting(false)
    if (ended) setStage('source')
  }

  /**
   * «Сделать кадр ещё раз» after a missing game: prepare the same source first, then close
   * the failed session and freeze a fresh frame. The terminated prepared process is never
   * reused. If the same source cannot be prepared the user stays on the failure view.
   */
  const retake = async (): Promise<void> => {
    const failed = view
    if (failed === null || exiting) return
    setExiting(true)
    setRetakeNote(null)
    try {
      const prepared = await prepareSameSource(failed.source)
      if (!prepared.ok) {
        setRetakeNote(prepared.message)
        return
      }
      if (!(await session.end())) {
        void window.crTools
          .releaseCaptureSource({
            sourceKey: prepared.preparation.sourceKey,
            revision: prepared.preparation.revision,
          })
          .catch(() => undefined)
        setRetakeNote('Не удалось закрыть прежнюю настройку. Повторите.')
        return
      }
      const failure = await start(prepared.preparation, 'manual')
      if (failure !== null) {
        toast.show({ message: failure })
        setStage('source')
      }
    } finally {
      setExiting(false)
    }
  }

  let body: React.JSX.Element
  if (stage === 'boot') {
    body = (
      <div className={styles['full']}>
        <State icon="clock" pulse title="Открываем настройку" />
      </div>
    )
  } else if (stage === 'missing') {
    body = (
      <FailureView
        busy={false}
        message="Начатой настройки нет. Откройте её из списка профилей заново."
        onClose={onExit}
        onRetry={null}
        retryLabel=""
        view={null}
      />
    )
  } else if (stage === 'name') {
    body = (
      <NameStep
        existing={profiles.value?.profiles ?? []}
        name={name}
        onName={setName}
        onNext={() => setStage('source')}
        position={position}
      />
    )
  } else if (stage === 'source') {
    body =
      intent.kind === 'rebind' ? (
        <SourceStage
          actionLabel="Привязать источник"
          backLabel={null}
          lead="Выберите окно с игрой или экран. Профиль останется прежним, сменится только источник картинки."
          onBack={() => undefined}
          onConfirm={rebind}
          position={position}
          title={`Новый источник для «${intent.profileName}»`}
        />
      ) : (
        <SourceStage
          actionLabel="Дальше: автонастройка"
          backLabel={intent.kind === 'new' ? 'Назад' : null}
          lead="Выберите окно с игрой или экран."
          manualLabel="Настроить вручную"
          onBack={() => setStage('name')}
          onConfirm={(preparation) => start(preparation, 'auto')}
          onManual={(preparation) => start(preparation, 'manual')}
          position={position}
          title={
            intent.kind === 'recalibrate'
              ? `Перенастройка «${intent.profileName}»`
              : 'Откуда берём картинку?'
          }
        />
      )
  } else if (view === null) {
    body = (
      <div className={styles['full']}>
        <State icon="clock" pulse title="Открываем настройку" />
      </div>
    )
  } else if (view.state === 'COMMITTED') {
    body = <OutcomeView onDone={() => void done()} session={session} view={view} />
  } else if (gameMissing) {
    body = (
      <FailureView
        busy={exiting}
        message={null}
        note={retakeNote}
        onClose={() => void exit()}
        onRetry={() => void retake()}
        retryLabel="Сделать кадр ещё раз"
        secondary={{ label: 'Выбрать окно', onClick: () => void restart() }}
        title="Не вижу игру в окне — сделайте кадр ещё раз"
        view={view}
      />
    )
  } else if (sourceLostFailure) {
    body = (
      <AutoFailure
        busy={exiting || session.busy}
        error={null}
        message={SOURCE_LOST_TEXT}
        onChooseWindow={() => void restart()}
        onManual={null}
        onRetry={null}
      />
    )
  } else if (view.state === 'FAILED' || view.state === 'CANCELLED') {
    const failed = view.state === 'FAILED'
    body = (
      <FailureView
        busy={exiting}
        message={
          failed
            ? view.error === null
              ? 'Не удалось получить рабочий кадр. Проверьте, что игра открыта и окно не свёрнуто.'
              : (viewErrorMessage(view.error) ??
                'Не удалось получить рабочий кадр. Проверьте, что игра открыта и окно не свёрнуто.')
            : 'Настройка была отменена, например при смене аккаунта. Ничего не сохранено.'
        }
        onClose={() => void exit()}
        onRetry={failed && intent.kind !== 'resume' ? () => void restart() : null}
        retryLabel="Выбрать источник заново"
        view={view}
      />
    )
  } else if (view.state === 'CREATED' || view.state === 'CAPTURING') {
    body = (
      <div className={styles['full']}>
        <State icon="clock" pulse title="Фиксируем кадр" />
      </div>
    )
  } else if (view.state === 'DETECTING') {
    body = (
      <AutoStage
        captureUnavailable={captureUnavailable}
        exiting={exiting}
        onChooseWindow={() => void restart()}
        onManual={() => void manual()}
        session={session}
        sourceLost={sourceLost}
        view={view}
      />
    )
  } else if (view.state === 'SAVING') {
    body = (
      <div className={styles['full']}>
        <State icon="clock" pulse title="Сохраняем настройку" />
      </div>
    )
  } else if (autoSuccess) {
    body = (
      <CheckStep
        auto
        frameUrl={session.frameUrl}
        onBack={() => {
          setAdjustingFor(view.sessionId)
          setPhase('regions')
        }}
        session={session}
        view={view}
      />
    )
  } else if (effectivePhase === 'check') {
    body = (
      <CheckStep
        frameUrl={session.frameUrl}
        onBack={() => setPhase('regions')}
        session={session}
        view={view}
      />
    )
  } else {
    body = (
      <RegionEditor
        frameUrl={session.frameUrl}
        key={view.sessionId}
        onChecked={() => setPhase('check')}
        session={session}
        view={view}
      />
    )
  }

  return (
    <div className={styles['wiz']}>
      <StepBar
        cancelDisabled={exiting || session.busy || view?.state === 'SAVING'}
        cancelLabel={committed ? 'Закрыть' : 'Отмена'}
        index={index}
        note={running ? 'Мониторинг продолжается' : null}
        onCancel={() => void (committed ? done() : exit())}
        steps={steps}
      />
      {body}
    </div>
  )
}
