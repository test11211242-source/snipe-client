import { useEffect, useState } from 'react'

import type { CapturePreparationResult } from '../../../../shared/contracts/capture-ipc'
import type { SetupIntent } from '../../app/router'
import { useShellActions } from '../../app/shell/slotsContext'
import { State, useToast } from '../../ui'
import { useMonitorView, selectRunPhase } from '../monitor'
import { useProfiles } from '../profiles'
import { NameStep } from './EntrySteps'
import { commandErrorMessage, viewErrorMessage } from './errors'
import { RegionEditor } from './RegionEditor'
import { CheckStep, FailureView, OutcomeView } from './ResultViews'
import styles from './Setup.module.css'
import { SourceStage } from './SourceStage'
import { StepBar } from './StepBar'
import { useSetupSession } from './useSetupSession'

/** Where the route is. A real auto-detection step would be one more `Stage` before `session`. */
type Stage = 'boot' | 'name' | 'source' | 'session' | 'missing'
/** Inside a session: manual region editing, then the check of the analyzed trigger. */
type Phase = 'regions' | 'check'

const FULL_STEPS: readonly string[] = ['Название', 'Источник', 'Области', 'Проверка']

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

  const result = view?.kind === 'predictionResult' && stage === 'session'
  const offset = result ? 2 : intent.kind === 'new' || intent.kind === 'resume' ? 0 : 1
  const steps =
    intent.kind === 'rebind' ? FULL_STEPS.slice(1, 2) : FULL_STEPS.slice(offset)
  const effectivePhase: Phase = view?.state === 'REVIEW' ? 'check' : phase
  const fullIndex =
    stage === 'name'
      ? 0
      : stage === 'source'
        ? 1
        : view?.state === 'COMMITTED'
          ? FULL_STEPS.length
          : effectivePhase === 'check'
            ? 3
            : 2
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

  const freeze = async (
    preparation: CapturePreparationResult,
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
        mode: 'manual',
        preparationId: preparation.preparationId,
        ...target,
      })
      await session.adopt(next)
      setPhase('regions')
      setStage('session')
      return null
    } catch (cause) {
      return commandErrorMessage(
        cause,
        'Не удалось заморозить кадр. Выберите источник и повторите.',
      )
    }
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
          actionLabel="Заморозить кадр"
          backLabel={intent.kind === 'new' ? 'Назад' : null}
          lead="Откройте в игре экран, на котором виден ник соперника, выберите окно или экран и нажмите «Заморозить кадр». По снимку вы отметите области вручную."
          onBack={() => setStage('name')}
          onConfirm={freeze}
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
        onRetry={
          failed && view.kind === 'capture' && intent.kind !== 'resume'
            ? () => void restart()
            : null
        }
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
  } else if (view.state === 'SAVING') {
    body = (
      <div className={styles['full']}>
        <State icon="clock" pulse title="Сохраняем настройку" />
      </div>
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
