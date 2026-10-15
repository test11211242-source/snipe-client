import { useState } from 'react'

import { MAX_CAPTURE_PROFILES } from '../../../../shared/models/capture'
import {
  Banner,
  Button,
  Chip,
  Field,
  Icon,
  Input,
  Segment,
  Spinner,
  State,
  cx,
} from '../../ui'
import { profileNameError } from '../profiles/errors'
import styles from './Setup.module.css'
import type { SourcePicker } from './useSourcePicker'

const SUGGESTIONS: readonly string[] = ['Ноутбук', 'Турнирный', 'Резервный']

/** Step 1 of a new profile: its name. Names are unique without regard to case. */
export function NameStep({
  name,
  onName,
  existing,
  position,
  onNext,
}: {
  name: string
  onName: (value: string) => void
  existing: readonly { profileId: string; profileName: string }[]
  /** «Шаг 1 из 4». */
  position: string
  onNext: () => void
}): React.JSX.Element {
  const [touched, setTouched] = useState(false)
  const error = profileNameError(name, existing, null)
  const shown = touched ? error : null
  const taken = new Set(
    existing.map((item) => item.profileName.toLocaleLowerCase('ru-RU')),
  )

  if (existing.length >= MAX_CAPTURE_PROFILES)
    return (
      <div className={styles['center']}>
        <State icon="alert" title="Достигнут предел — 20 профилей" tone="warn">
          Удалите ненужный профиль в списке профилей, затем создайте новый.
        </State>
      </div>
    )

  const submit = (): void => {
    setTouched(true)
    if (error === null) onNext()
  }

  return (
    <form
      className={styles['center']}
      onSubmit={(event) => {
        event.preventDefault()
        submit()
      }}
    >
      <span className={styles['eyebrow']}>{position}</span>
      <h1 className={styles['h1']}>Как назовём профиль?</h1>
      <p className={styles['lead']}>
        Профиль хранит окно игры и положение ника на экране. Назовите так, чтобы его легко
        было найти в списке.
      </p>
      <div className={styles['nameField']}>
        <Field error={shown} label="Название профиля">
          {(controlProps) => (
            <Input
              {...controlProps}
              autoFocus
              className={styles['nameInput']}
              maxLength={90}
              onChange={(event) => {
                setTouched(true)
                onName(event.target.value)
              }}
              value={name}
            />
          )}
        </Field>
      </div>
      <div className={styles['chips']}>
        {SUGGESTIONS.filter((item) => !taken.has(item.toLocaleLowerCase('ru-RU'))).map(
          (item) => (
            <Chip
              key={item}
              onClick={() => {
                setTouched(true)
                onName(item)
              }}
              pressed={name === item}
            >
              {item}
            </Chip>
          ),
        )}
      </div>
      <Button disabled={shown !== null} size="lg" type="submit" variant="primary">
        Дальше
        <Icon name="chevronRight" size={16} />
      </Button>
    </form>
  )
}

/** Real windows and screens; the picked one is prepared at once and handed on by the action. */
export function SourceStep({
  picker,
  position,
  title,
  lead,
  actionLabel,
  onAction,
  acting,
  backLabel,
  onBack,
  secondary,
}: {
  picker: SourcePicker
  position: string
  title: string
  lead: string
  actionLabel: string
  onAction: () => void
  /** The action is running (freezing the frame / rebinding). */
  acting: boolean
  backLabel: string | null
  onBack: () => void
  /** A second way on with the same prepared source (e.g. manual setup). */
  secondary?: { label: string; onAction: () => void; loading: boolean } | undefined
}): React.JSX.Element {
  const { sources, tab, counts, loading, preparation, preparingKey, selectedKey } = picker
  const failure = picker.error

  return (
    <div className={styles['center']}>
      <span className={styles['eyebrow']}>{position}</span>
      <h1 className={styles['h1']}>{title}</h1>
      <p className={styles['lead']}>{lead}</p>
      <div className={styles['tools']}>
        <Segment
          label="Тип источника"
          onChange={picker.setTab}
          options={[
            { value: 'window', label: `Окна · ${counts.window}` },
            { value: 'display', label: `Экраны · ${counts.display}` },
          ]}
          value={tab}
        />
        <Button
          disabled={loading || acting}
          onClick={() => void picker.refresh()}
          size="sm"
          variant="ghost"
        >
          <Icon name="refresh" size={14} />
          Обновить список
        </Button>
      </div>
      {failure === null ? null : (
        <div className={styles['inlineBanner']}>
          <Banner icon="alert" live title="Не получилось" tone="danger">
            {failure}
          </Banner>
        </div>
      )}
      {loading && sources.length === 0 ? (
        <Spinner label="Ищем окна и экраны" />
      ) : (
        <div className={styles['sources']}>
          {sources.length === 0 ? (
            <p className={styles['sourceEmpty']}>
              {tab === 'window'
                ? 'Окон не найдено. Запустите игру и обновите список.'
                : 'Экранов не найдено.'}
            </p>
          ) : null}
          {sources.map((source) => {
            const on = source.sourceKey === selectedKey
            const off = !source.captureSupported
            return (
              <button
                aria-pressed={on}
                className={cx(
                  styles['source'],
                  on && styles['sourceOn'],
                  off && styles['sourceOff'],
                )}
                disabled={off || acting}
                key={source.sourceKey}
                onClick={() => void picker.select(source)}
                type="button"
              >
                <span className={styles['thumb']}>
                  {source.preview === null ? (
                    <Icon
                      name={source.kind === 'display' ? 'monitor' : 'window'}
                      size={28}
                    />
                  ) : (
                    <img
                      alt=""
                      className={styles['thumbImg']}
                      draggable={false}
                      src={source.preview.dataUrl}
                    />
                  )}
                  {on ? (
                    <span className={styles['sourceCheck']}>
                      {preparingKey === source.sourceKey ? (
                        <Spinner label="Подготавливаем источник" />
                      ) : (
                        <Icon name="check" size={13} />
                      )}
                    </span>
                  ) : null}
                </span>
                <span className={styles['sourceTitle']}>{source.label}</span>
                <span className={cx(styles['sourceSub'], off && styles['sourceSubWarn'])}>
                  {off
                    ? (source.unavailableReason ?? 'Недоступно')
                    : (source.detail ?? '')}
                </span>
              </button>
            )
          })}
        </div>
      )}
      <div className={styles['actions']}>
        {backLabel === null ? null : (
          <Button disabled={acting} onClick={onBack} size="lg">
            <Icon name="chevronLeft" size={16} />
            {backLabel}
          </Button>
        )}
        {secondary === undefined ? null : (
          <Button
            disabled={preparation === null || preparingKey !== null || acting}
            loading={secondary.loading}
            onClick={secondary.onAction}
            size="lg"
          >
            {secondary.label}
          </Button>
        )}
        <Button
          disabled={preparation === null || preparingKey !== null || acting}
          loading={acting && secondary?.loading !== true}
          onClick={onAction}
          size="lg"
          variant="primary"
        >
          {actionLabel}
          <Icon name="chevronRight" size={16} />
        </Button>
      </div>
    </div>
  )
}
