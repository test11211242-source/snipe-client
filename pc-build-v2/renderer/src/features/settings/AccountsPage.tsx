import { useState, type SyntheticEvent } from 'react'

import {
  GameAccountTagSchema,
  MAX_STREAMER_ACCOUNTS,
  type StreamerView,
} from '../../../../shared/models/streamer'
import { useRole } from '../auth'
import { StreamerGate } from '../streamer/StreamerGate'
import { useStreamer } from '../streamer/streamerContext'
import {
  describeCommandError,
  describeWarning,
  type CommandWarning,
  type StreamerFailureCode,
} from '../streamer/text'
import {
  Avatar,
  Banner,
  Button,
  Card,
  ConfirmDialog,
  Field,
  Group,
  Icon,
  IconButton,
  Input,
  Pill,
  Spinner,
  State,
  cx,
  useToast,
} from '../../ui'
import styles from './Settings.module.css'

type Account = StreamerView['title']['accounts'][number]

/** Failures that are about the tag itself belong under the tag field. */
const TAG_ERRORS: readonly StreamerFailureCode[] = [
  'ACCOUNT_TAG_INVALID',
  'ACCOUNT_NOT_FOUND',
]

/**
 * «Аккаунты Clash Royale» — the one home of the accounts. Only the streamer endpoints
 * exist today, so other roles get an honest explanation instead of a form that cannot work.
 */
export function AccountsPage(): React.JSX.Element {
  const role = useRole()
  if (role.pending)
    return (
      <div className={styles['page']}>
        <Spinner label="Загружаем" />
      </div>
    )
  if (!role.isStreamer)
    return (
      <State icon="users" title="Пока доступно только стримерам">
        Привязка аккаунтов Clash Royale сейчас работает только для роли «Стример» — для
        остальных ролей сервер её пока не открыл. Личные встречи и название стрима
        появятся здесь, когда это изменится.
      </State>
    )
  return (
    <StreamerGate>
      <Accounts />
    </StreamerGate>
  )
}

function Accounts(): React.JSX.Element {
  const { view, command, pendingKeys } = useStreamer()
  const toast = useToast()
  // Drafts live here so a failed attempt never clears what the user typed.
  const [tag, setTag] = useState('')
  const [alias, setAlias] = useState('')
  const [tagError, setTagError] = useState<string | null>(null)
  const [formError, setFormError] = useState<string | null>(null)
  const [adding, setAdding] = useState(false)
  const [rowError, setRowError] = useState<string | null>(null)
  const [removing, setRemoving] = useState<Account | null>(null)
  const [removeError, setRemoveError] = useState<string | null>(null)
  const [removePending, setRemovePending] = useState(false)
  if (view === null) return <></>

  const accounts = view.title.accounts
  const full = accounts.length >= MAX_STREAMER_ACCOUNTS
  const activeTag = view.title.session?.activeAccountTag ?? null

  const warn = (warnings: readonly CommandWarning[]): void => {
    const text = warnings
      .filter((warning) => warning !== 'TITLE_APPLICATION_UNCONFIRMED')
      .map(describeWarning)
    if (text.length > 0) toast.show({ message: text.join(' '), duration: 7000 })
  }

  const add = (event: SyntheticEvent<HTMLFormElement>): void => {
    event.preventDefault()
    setFormError(null)
    const parsed = GameAccountTagSchema.safeParse(tag)
    if (!parsed.success) {
      setTagError(describeCommandError('ACCOUNT_TAG_INVALID'))
      return
    }
    if (accounts.some((account) => account.tag.toUpperCase() === parsed.data)) {
      setTagError(`Аккаунт ${parsed.data} уже добавлен.`)
      return
    }
    setTagError(null)
    setAdding(true)
    void command({ action: 'accounts.add', tag: parsed.data, alias: alias.trim() }).then(
      (outcome) => {
        setAdding(false)
        if (outcome.status === 'ok') {
          setTag('')
          setAlias('')
          toast.show({ message: 'Аккаунт добавлен' })
          warn(outcome.result.warnings)
        } else if (outcome.status === 'failed') {
          const text = describeCommandError(outcome.code)
          if (TAG_ERRORS.includes(outcome.code)) setTagError(text)
          else setFormError(text)
        }
      },
    )
  }

  const reenable = (account: Account): void => {
    setRowError(null)
    const parsed = GameAccountTagSchema.safeParse(account.tag)
    if (!parsed.success) {
      setRowError(describeCommandError('ACCOUNT_TAG_INVALID'))
      return
    }
    void command(
      { action: 'accounts.reenable', tag: parsed.data },
      { key: `account.${account.tag}` },
    ).then((outcome) => {
      if (outcome.status === 'failed') setRowError(describeCommandError(outcome.code))
      else if (outcome.status === 'ok') {
        toast.show({ message: 'Аккаунт включён' })
        warn(outcome.result.warnings)
      }
    })
  }

  const confirmRemove = (): void => {
    if (removing === null) return
    const parsed = GameAccountTagSchema.safeParse(removing.tag)
    if (!parsed.success) {
      setRemoveError(describeCommandError('ACCOUNT_TAG_INVALID'))
      return
    }
    setRemovePending(true)
    setRemoveError(null)
    void command({
      action: 'accounts.remove',
      tag: parsed.data,
    }).then((outcome) => {
      setRemovePending(false)
      if (outcome.status === 'ok') {
        setRemoving(null)
        toast.show({ message: 'Аккаунт удалён' })
        warn(outcome.result.warnings)
      } else if (outcome.status === 'failed') {
        setRemoveError(describeCommandError(outcome.code))
      }
    })
  }

  return (
    <div className={styles['page']}>
      <div className={styles['chips']} aria-label="Где используются аккаунты">
        <span className={styles['note']}>Где используются</span>
        <Pill>Личные встречи</Pill>
        <Pill>Название стрима</Pill>
        <Pill>Виджеты для OBS</Pill>
      </div>

      <Group
        title="Добавить аккаунт"
        trail={
          <span>
            {accounts.length} из {MAX_STREAMER_ACCOUNTS}
          </span>
        }
      >
        <Card padded>
          <form className={styles['form']} noValidate onSubmit={add}>
            <Field error={tagError ?? undefined} label="Тег Clash Royale">
              {(controlProps) => (
                <Input
                  {...controlProps}
                  autoComplete="off"
                  mono
                  onChange={(event) => {
                    setTag(event.currentTarget.value)
                    setTagError(null)
                  }}
                  placeholder="#8Y2QL0"
                  size="lg"
                  value={tag}
                />
              )}
            </Field>
            <Field label="Название (необязательно)">
              {(controlProps) => (
                <Input
                  {...controlProps}
                  autoComplete="off"
                  maxLength={100}
                  onChange={(event) => setAlias(event.currentTarget.value)}
                  placeholder="Например, Основной"
                  size="lg"
                  value={alias}
                />
              )}
            </Field>
            <div className={styles['formAction']}>
              <Button
                disabled={full || tag.trim() === ''}
                loading={adding}
                size="lg"
                type="submit"
                variant="primary"
              >
                <Icon name="plus" size={15} />
                Добавить
              </Button>
            </div>
          </form>
          {full ? (
            <p className={styles['note']}>
              {describeCommandError('ACCOUNT_LIMIT_REACHED')}
            </p>
          ) : null}
          {formError === null ? null : (
            <Banner icon="alert" title="Аккаунт не добавлен" tone="danger">
              {formError} Введённое сохранено в форме.
            </Banner>
          )}
        </Card>
      </Group>

      <Group title="Ваши аккаунты" trail={<span>одни на всё приложение</span>}>
        {rowError === null ? null : (
          <Banner icon="alert" title="Не получилось" tone="danger">
            {rowError}
          </Banner>
        )}
        <Card flush>
          {accounts.length === 0 ? (
            <State icon="users" title="Аккаунтов пока нет" headingLevel={3}>
              Добавьте первый аккаунт выше — по нему соберётся название стрима и
              статистика.
            </State>
          ) : (
            accounts.map((account) => {
              const name = account.alias || account.name || account.tag
              const rowPending = pendingKeys.has(`account.${account.tag}`)
              return (
                <div
                  className={cx(
                    styles['account'],
                    !account.enabled && styles['accountOff'],
                  )}
                  key={account.tag}
                >
                  <Avatar name={name} size="md" />
                  <div className={styles['accountMain']}>
                    <b>{name}</b>
                    <small>
                      {account.tag}
                      {account.name !== '' && account.name !== name
                        ? ` · в игре: ${account.name}`
                        : ''}
                    </small>
                  </div>
                  {account.enabled ? (
                    activeTag === account.tag ? (
                      <Pill tone="ok">играет сейчас</Pill>
                    ) : null
                  ) : (
                    <Pill>отключён</Pill>
                  )}
                  <div className={styles['stat']}>
                    <small>Место</small>
                    <b>
                      {account.currentRank === null ? '—' : `#${account.currentRank}`}
                    </b>
                  </div>
                  <div className={styles['stat']}>
                    <small>Рейтинг</small>
                    <b>
                      {account.currentElo === null
                        ? '—'
                        : account.currentElo.toLocaleString('ru-RU')}
                    </b>
                  </div>
                  {account.enabled ? null : (
                    <Button
                      loading={rowPending}
                      onClick={() => reenable(account)}
                      size="sm"
                    >
                      Включить
                    </Button>
                  )}
                  <IconButton
                    disabled={rowPending}
                    label={`Удалить аккаунт ${name}`}
                    onClick={() => {
                      setRemoveError(null)
                      setRemoving(account)
                    }}
                    size="sm"
                  >
                    <Icon name="trash" size={15} />
                  </IconButton>
                </div>
              )
            })
          )}
        </Card>
      </Group>

      {removing === null ? null : (
        <ConfirmDialog
          confirmLabel="Удалить аккаунт"
          error={removeError}
          onCancel={() => setRemoving(null)}
          onConfirm={confirmRemove}
          pending={removePending}
          text="Аккаунт пропадёт из названия стрима, статистики и личных встреч. Его можно добавить снова по тегу."
          title={`Удалить «${removing.alias || removing.name || removing.tag}»?`}
        />
      )}
    </div>
  )
}
