import { useRef, useState } from 'react'

import type { StreamerCommand } from '../../../../shared/contracts/streamer-ipc'
import type { PredictionSettings } from '../../../../shared/models/streamer'
import {
  Banner,
  Button,
  Card,
  ConfirmDialog,
  Group,
  Pill,
  Requirements,
  Segment,
  Select,
  Setting,
  Stepper,
  Switch,
} from '../../ui'
import { useAuth } from '../auth'
import { StreamerGate } from './StreamerGate'
import { useStreamer } from './streamerContext'
import styles from './Streamer.module.css'
import {
  describeCommandError,
  predictionStatusText,
  streakProgress,
  VOTING_CHOICES,
  type StreamerFailureCode,
} from './text'
import { confirmManualIntent, manualRequestId } from './manualIntent'
import { useRequirements } from './useRequirements'
import type { CommandOutcome } from './useStreamerController'

/** Unsaved edits of the settings form; «Автопрогнозы» is saved by its own switch. */
type Draft = Partial<Omit<PredictionSettings, 'enabled'>>
type CommandKind = 'settings' | 'enabled' | 'battle' | 'cancel'
type ManualOutcome = Extract<StreamerCommand, { action: 'predictions.battle' }>['outcome']

/** Every prediction command runs under a `predictions.*` key: one at a time. */
const KEY_PREFIX = 'predictions.'
/** A manual command for a prediction that is no longer the current one (server 409). */
const STALE_PREDICTION = 'Прогноз уже сменился. Проверьте итог.'
/** A manual command whose result is unknown: it may have been applied. No «повторите». */
const UNCONFIRMED = 'Сервер не подтвердил действие. Проверьте итог.'
/** Failures where the server certainly did not apply the command. */
const REJECTED: Partial<Record<StreamerFailureCode, true>> = {
  UNAUTHORIZED: true,
  FORBIDDEN: true,
  STREAMER_ROLE_REQUIRED: true,
  TWITCH_REQUIRED: true,
}

/**
 * «Прогнозы»: server-side automatic predictions. The server is the only source of truth;
 * this page edits its settings (they apply to the next prediction, also while one runs),
 * shows the status in fixed phrases and settles the current prediction by hand.
 */
export function PredictionsPage(): React.JSX.Element {
  return (
    <StreamerGate>
      <Predictions />
    </StreamerGate>
  )
}

function Predictions(): React.JSX.Element {
  const { view, pendingKeys, command } = useStreamer()
  const requirements = useRequirements('predictions')
  const [draft, setDraft] = useState<Draft>({})
  const [desiredEnabled, setDesiredEnabled] = useState<boolean | null>(null)
  const [error, setError] = useState<string | null>(null)
  // The cancel dialog is bound to the prediction it was opened for, never a newer one.
  const [cancelId, setCancelId] = useState<number | null>(null)
  const [cancelError, setCancelError] = useState<string | null>(null)
  const inFlight = useRef(false)
  // Intents are per account: another account never reuses a request ID.
  const userId = useAuth().value?.user?.id ?? null
  if (view === null) return <></>

  const { predictions } = view
  const { prediction, stats } = predictions
  const busy = [...pendingKeys].some((key) => key.startsWith(KEY_PREFIX))
  const pending = (kind: CommandKind): boolean => pendingKeys.has(KEY_PREFIX + kind)
  const saved = predictions.settings
  const form: PredictionSettings = { ...saved, ...draft }
  const dirty = (Object.keys(draft) as (keyof Draft)[]).some(
    (field) => draft[field] !== saved[field],
  )
  const enabled =
    pending('enabled') && desiredEnabled !== null ? desiredEnabled : saved.enabled
  const status = predictionStatusText(predictions)

  /** Sends one prediction command; `null` when another one is still running. */
  const send = async (
    next: StreamerCommand,
    kind: CommandKind,
  ): Promise<CommandOutcome | null> => {
    if (inFlight.current) return null
    inFlight.current = true
    try {
      return await command(next, { key: KEY_PREFIX + kind })
    } finally {
      inFlight.current = false
    }
  }
  const manualFailure = (code: StreamerFailureCode): string =>
    code === 'VALIDATION_FAILED'
      ? STALE_PREDICTION
      : REJECTED[code] === true
        ? describeCommandError(code)
        : UNCONFIRMED

  const change = (patch: Draft): void => setDraft({ ...draft, ...patch })
  const save = async (): Promise<void> => {
    setError(null)
    const next: StreamerCommand = { action: 'predictions.settings.save', settings: form }
    const outcome = await send(next, 'settings')
    if (outcome?.status === 'ok') setDraft({})
    else if (outcome?.status === 'failed')
      setError(`${describeCommandError(outcome.code)} Изменения остались в форме.`)
  }
  const toggle = async (on: boolean): Promise<void> => {
    setError(null)
    setDesiredEnabled(on)
    const settings = { ...saved, enabled: on }
    const next: StreamerCommand = { action: 'predictions.settings.save', settings }
    const outcome = await send(next, 'enabled')
    setDesiredEnabled(null)
    if (outcome?.status === 'failed') setError(describeCommandError(outcome.code))
  }
  const settle = async (
    predictionId: number,
    wins: number,
    result: ManualOutcome,
  ): Promise<void> => {
    if (inFlight.current) return
    setError(null)
    const key = `${userId ?? ''}:${predictionId}:${wins}`
    const next: StreamerCommand = {
      action: 'predictions.battle',
      predictionId,
      outcome: result,
      requestId: manualRequestId(key, result),
    }
    // Never retried automatically: the streamer checks the refreshed status first.
    const outcome = await send(next, 'battle')
    // A confirmed skip leaves the shown progress as it was, yet the next battle may need
    // one too. A confirmed win/loss keeps its ID: if the server stored it uncounted
    // (gated), a repeat at the same progress must not count a second battle.
    if (outcome?.status === 'ok' && result === 'not_ranked')
      confirmManualIntent(key, result)
    else if (outcome?.status === 'failed') setError(manualFailure(outcome.code))
  }
  const confirmCancel = async (): Promise<void> => {
    if (cancelId === null) return
    setCancelError(null)
    const next: StreamerCommand = {
      action: 'predictions.cancel',
      predictionId: cancelId,
      confirmed: true,
    }
    const outcome = await send(next, 'cancel')
    if (outcome?.status === 'ok') setCancelId(null)
    else if (outcome?.status === 'failed' && outcome.code === 'VALIDATION_FAILED') {
      // The dialog's prediction is gone; the refreshed status is already on the page.
      setCancelId(null)
      setError(STALE_PREDICTION)
    } else if (outcome?.status === 'failed') setCancelError(manualFailure(outcome.code))
  }

  return (
    <div className={styles['page']}>
      <Banner icon="wand" title="Прогнозы" tone="neutral">
        Ставки закрываются по таймеру.
      </Banner>
      <Requirements items={requirements} />
      {error === null ? null : (
        <Banner icon="alert" title="Не получилось" tone="danger">
          {error}
        </Banner>
      )}
      <Group title="Сейчас">
        <Card padded>
          <div className={styles['controlRow']}>
            {status === null ? null : <Pill tone={status.tone}>{status.label}</Pill>}
            {prediction === null ? (
              <span className={styles['muted']}>Прогноза сейчас нет</span>
            ) : null}
          </div>
          {prediction === null ? null : (
            <>
              <div className={styles['activeTitle']}>
                <span>Текущий прогноз</span>«{prediction.title}»
                {prediction.mode === 'streak' ? (
                  <div className={styles['muted']}>
                    {streakProgress(prediction.wins, prediction.target)}
                  </div>
                ) : null}
              </div>
              <div className={styles['manual']}>
                <Button
                  disabled={busy}
                  loading={pending('battle')}
                  onClick={() => void settle(prediction.id, prediction.wins, 'win')}
                  variant="primary"
                >
                  Победа
                </Button>
                <Button
                  disabled={busy}
                  loading={pending('battle')}
                  onClick={() => void settle(prediction.id, prediction.wins, 'loss')}
                >
                  Поражение
                </Button>
                <Button
                  disabled={busy}
                  loading={pending('battle')}
                  onClick={() =>
                    void settle(prediction.id, prediction.wins, 'not_ranked')
                  }
                >
                  Бой не считается
                </Button>
                <Button
                  disabled={busy}
                  onClick={() => {
                    setCancelError(null)
                    setCancelId(prediction.id)
                  }}
                  variant="danger"
                >
                  Отменить и вернуть ставки
                </Button>
              </div>
            </>
          )}
          <div className={styles['stats']}>
            <div className={styles['stat']}>
              <b>{stats.resolved + stats.canceled}</b>
              <small>Прогнозов</small>
            </div>
            <div className={styles['stat']}>
              <b>{stats.yes}</b>
              <small>Да</small>
            </div>
            <div className={styles['stat']}>
              <b>{stats.no}</b>
              <small>Нет</small>
            </div>
            <div className={styles['stat']}>
              <b>{stats.canceled}</b>
              <small>Отменены</small>
            </div>
          </div>
        </Card>
      </Group>
      <Group
        title="Настройки"
        trail={
          prediction === null ? undefined : (
            <span>изменения — со следующего прогноза</span>
          )
        }
      >
        <Card padded>
          <Setting
            hint="Новый прогноз открывается сразу после итога"
            title="Автопрогнозы"
          >
            <Switch
              checked={enabled}
              disabled={busy}
              label="Автопрогнозы"
              onChange={(on) => void toggle(on)}
            />
          </Setting>
          <Setting title="Что угадывают зрители">
            <Segment
              label="Что угадывают зрители"
              onChange={(mode) => change({ mode })}
              options={[
                { value: 'each_battle', label: 'Каждый бой', disabled: busy },
                { value: 'streak', label: 'Серия побед', disabled: busy },
              ]}
              value={form.mode}
            />
          </Setting>
          {form.mode === 'streak' ? (
            <>
              <Setting title="Длина серии">
                <Segment
                  label="Длина серии"
                  onChange={(streakKind) => change({ streakKind })}
                  options={[
                    { value: 'fixed', label: 'Точно', disabled: busy },
                    { value: 'random', label: 'Случайно', disabled: busy },
                  ]}
                  value={form.streakKind}
                />
              </Setting>
              {form.streakKind === 'fixed' ? (
                <Setting hint="От 2 до 10" title="Побед подряд">
                  <Stepper
                    disabled={busy}
                    label="Побед подряд"
                    max={10}
                    min={2}
                    onChange={(streakLength) => change({ streakLength })}
                    value={form.streakLength}
                  />
                </Setting>
              ) : (
                <Setting
                  hint="Для каждой серии длина выпадает заново. «От» не больше «До»"
                  title="Побед подряд: от и до"
                >
                  <div className={styles['controlRow']}>
                    <Stepper
                      disabled={busy}
                      format={(value) => `от ${value}`}
                      label="От"
                      max={form.streakTo}
                      min={1}
                      onChange={(streakFrom) => change({ streakFrom })}
                      value={form.streakFrom}
                    />
                    <Stepper
                      disabled={busy}
                      format={(value) => `до ${value}`}
                      label="До"
                      max={10}
                      min={form.streakFrom}
                      onChange={(streakTo) => change({ streakTo })}
                      value={form.streakTo}
                    />
                  </div>
                </Setting>
              )}
            </>
          ) : null}
          <Setting hint="Потом Twitch сам закроет ставки" title="Время на ставки">
            <Select
              aria-label="Время на ставки"
              disabled={busy}
              onChange={(event) => {
                const value = event.currentTarget.value
                const choice = VOTING_CHOICES.find((item) => String(item.value) === value)
                if (choice !== undefined) change({ votingSeconds: choice.value })
              }}
              value={String(form.votingSeconds)}
            >
              {VOTING_CHOICES.map((choice) => (
                <option key={choice.value} value={String(choice.value)}>
                  {choice.label}
                </option>
              ))}
            </Select>
          </Setting>
          {form.mode === 'streak' ? (
            <Setting
              hint="«Серия: 2/5» после каждого боя серии"
              title="Писать прогресс в чат"
            >
              <Switch
                checked={form.chatProgress}
                disabled={busy}
                label="Писать прогресс в чат"
                onChange={(chatProgress) => change({ chatProgress })}
              />
            </Setting>
          ) : null}
          <div className={styles['manual']}>
            <Button
              disabled={!dirty || busy}
              loading={pending('settings')}
              onClick={() => void save()}
              variant="primary"
            >
              Сохранить
            </Button>
          </div>
        </Card>
      </Group>
      {cancelId === null ? null : (
        <ConfirmDialog
          confirmLabel="Вернуть ставки"
          error={cancelError}
          onCancel={() => {
            if (!pending('cancel')) setCancelId(null)
          }}
          onConfirm={() => void confirmCancel()}
          pending={pending('cancel')}
          text="Все ставки вернутся зрителям."
          title="Отменить прогноз?"
        />
      )}
    </div>
  )
}
