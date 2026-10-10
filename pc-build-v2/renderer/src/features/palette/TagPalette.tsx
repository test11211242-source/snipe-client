import { useMemo, useState } from 'react'

import { GameAccountTagSchema } from '../../../../shared/models/streamer'
import { useRouter } from '../../app/router'
import { H2HCard, useH2H } from '../h2h'
import { useMonitorView } from '../monitor'
import { useCopyTag } from '../player/useCopyTag'
import { sessionOpponents, type SessionOpponent } from './opponents'
import styles from './TagPalette.module.css'
import { Button, ClanLine, Icon, Palette, Rating, Row, State, TagChip } from '../../ui'

/** Head-to-head card for one tag; unmounting (new tag, close) cancels the request. */
function PaletteResult({
  tag,
  opponent,
  onBack,
  onLinkAccount,
}: {
  tag: string
  opponent: SessionOpponent | undefined
  onBack: () => void
  onLinkAccount: () => void
}): React.JSX.Element {
  const { state, retry } = useH2H(tag)
  const copy = useCopyTag()
  return (
    <div className={styles['result']}>
      <div className={styles['who']}>
        <div className={styles['whoText']}>
          <div className={styles['whoName']}>
            <h3>{opponent?.name ?? 'Игрок'}</h3>
            <TagChip onCopy={copy} tag={tag} />
          </div>
          {opponent === undefined ? null : <ClanLine clan={opponent.clan} />}
        </div>
        {opponent?.rating == null ? null : <Rating large value={opponent.rating} />}
      </div>
      <H2HCard onLinkAccount={onLinkAccount} onRetry={retry} state={state} />
      <div className={styles['foot']}>
        <Button onClick={onBack} variant="ghost">
          <Icon name="chevronRight" size={14} />
          Другой тег
        </Button>
      </div>
    </div>
  )
}

/**
 * Ctrl+K «Проверить тег»: tag input with canonical validation, the session's opponents to
 * pick from, and the real «Личные встречи» card for the chosen tag.
 */
export function TagPalette({ onClose }: { onClose: () => void }): React.JSX.Element {
  const monitor = useMonitorView()
  const { navigate } = useRouter()
  const [value, setValue] = useState('')
  const [tag, setTag] = useState<string | null>(null)
  const opponents = useMemo(() => sessionOpponents(monitor.value), [monitor.value])
  const parsed = GameAccountTagSchema.safeParse(value)
  const trimmed = value.trim()
  const invalid = trimmed.length > 0 && !parsed.success

  const submit = (): void => {
    if (parsed.success) setTag(parsed.data)
  }

  return (
    <Palette
      hint={
        invalid
          ? 'Тег состоит из цифр и букв 0 2 8 9 P Y L Q G R J C U V. Скопируйте его из профиля игрока.'
          : 'Вставьте тег игрока или выберите соперника из истории сессии. Esc — закрыть.'
      }
      label="Проверить тег"
      onClose={onClose}
      onSubmit={submit}
      onValueChange={(next) => {
        setValue(next)
        setTag(null)
      }}
      placeholder="#2Q8YLP0"
      value={value}
    >
      {tag !== null ? (
        <PaletteResult
          onBack={() => {
            setValue('')
            setTag(null)
          }}
          onLinkAccount={() => {
            onClose()
            navigate({ name: 'settings', section: 'accounts' })
          }}
          opponent={opponents.find((item) => item.tag === tag)}
          tag={tag}
        />
      ) : (
        <div role="list" aria-label="Соперники сессии">
          {opponents.length === 0 ? (
            <State headingLevel={3} icon="clock" title="История сессии пуста">
              Соперники появятся здесь после первого боя.
            </State>
          ) : (
            opponents.map((opponent) => (
              <div key={opponent.id} role="listitem">
                <Row
                  lead={<Icon name="user" size={16} />}
                  onClick={() => {
                    setValue(opponent.tag)
                    setTag(opponent.tag)
                  }}
                  sub={opponent.clan ?? <ClanLine clan={null} />}
                  title={opponent.name}
                  trail={
                    opponent.rating === null ? undefined : (
                      <Rating value={opponent.rating} />
                    )
                  }
                />
              </div>
            ))
          )}
        </div>
      )}
    </Palette>
  )
}
