import { useMemo, useState } from 'react'

import { GameAccountTagSchema } from '../../../../shared/models/streamer'
import { useMonitorView } from '../monitor'
import { sessionOpponents } from './opponents'
import { ClanLine, Icon, Palette, Rating, Row, State } from '../../ui'

/**
 * Ctrl+K «Проверить тег»: tag input with canonical validation and the session's
 * opponents to pick from. M3 replaces the result slot with the real H2H card.
 */
export function TagPalette({ onClose }: { onClose: () => void }): React.JSX.Element {
  const monitor = useMonitorView()
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
        <State headingLevel={3} icon="users" title={`Игрок ${tag}`}>
          Личные встречи пока недоступны.
        </State>
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
