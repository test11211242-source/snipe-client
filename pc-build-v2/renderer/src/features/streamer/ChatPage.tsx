import { useState } from 'react'

import { Banner, Card, Group, Requirements, Setting, Switch } from '../../ui'
import { missingFor, useFoundations, useRequirements } from './useRequirements'
import { StreamerGate } from './StreamerGate'
import { useRunner } from './useRunner'
import { useStreamer } from './streamerContext'
import styles from './Streamer.module.css'

/** «Колоды в чат»: one switch and the requirements it depends on. */
export function ChatPage(): React.JSX.Element {
  return (
    <StreamerGate>
      <Chat />
    </StreamerGate>
  )
}

function Chat(): React.JSX.Element {
  const { view, pendingKeys } = useStreamer()
  const { run, error } = useRunner()
  const requirements = useRequirements('chat')
  const ready = missingFor('chat', useFoundations()).length === 0
  const [desired, setDesired] = useState<boolean | null>(null)
  if (view === null) return <></>

  const enabled = view.deckSharing.enabled
  const shown = pendingKeys.has('chat.toggle') && desired !== null ? desired : enabled
  const toggle = (next: boolean): void => {
    setDesired(next)
    void run({ action: 'chat.toggle', enabled: next }, { key: 'chat.toggle' }).then(() =>
      setDesired(null),
    )
  }

  return (
    <div className={styles['page']}>
      <Banner
        icon="chat"
        title="Колода уходит в чат сама"
        tone={enabled && ready ? 'ok' : 'neutral'}
      >
        Когда мониторинг находит соперника, его колода отправляется в чат вашего канала.
        Включите один раз — во время эфира ничего нажимать не нужно.
      </Banner>
      <Requirements items={requirements} />
      {error === null ? null : (
        <Banner icon="alert" title="Не получилось" tone="danger">
          {error}
        </Banner>
      )}
      <Group title="Настройка">
        <Card padded>
          <Setting
            hint={
              ready || enabled
                ? 'Только найденные колоды, без служебных сообщений'
                : 'Сначала закройте пункты выше'
            }
            title="Отправлять колоды соперника в чат"
          >
            <Switch
              checked={shown}
              disabled={!enabled && !ready}
              label="Отправлять колоды в чат"
              onChange={toggle}
            />
          </Setting>
        </Card>
      </Group>
    </div>
  )
}
