import { useState } from 'react'

import type { AppSettingsView } from '../../../../shared/contracts/app'
import {
  Banner,
  Button,
  Card,
  Group,
  Icon,
  Setting,
  Skeleton,
  Switch,
  useToast,
} from '../../ui'
import { useAppSettings } from './index'
import styles from './Settings.module.css'

type ToggleKey = keyof AppSettingsView

const GROUPS: {
  title: string
  items: { key: ToggleKey; title: string; hint: string }[]
}[] = [
  {
    title: 'Запуск',
    items: [
      {
        key: 'launchAtStartup',
        title: 'Запускать вместе с Windows',
        hint: 'Приложение откроется свёрнутым в трей',
      },
      {
        key: 'autoStartMonitoring',
        title: 'Начинать мониторинг при запуске',
        hint: 'Если профиль есть, приложение само начнёт следить за боями',
      },
      {
        key: 'closeToTray',
        title: 'Закрытие окна сворачивает в трей',
        hint: 'Мониторинг и оверлей продолжают работать',
      },
    ],
  },
  {
    title: 'Поведение',
    items: [
      {
        key: 'notifyOpponentFound',
        title: 'Сообщать о найденном сопернике',
        hint: 'Короткое уведомление Windows с ником и кланом',
      },
      {
        key: 'reducedMotion',
        title: 'Уменьшить анимацию',
        hint: 'Убирает плавные переходы и пульсацию',
      },
    ],
  },
]

/** «Приложение»: every switch saves immediately and shows pending and failure states. */
export function AppSettingsPage(): React.JSX.Element {
  const settings = useAppSettings()
  const toast = useToast()
  // The value the user just chose, shown until the save settles.
  const [desired, setDesired] = useState<Partial<Record<ToggleKey, boolean>>>({})
  const [logError, setLogError] = useState<string | null>(null)
  const [openingLogs, setOpeningLogs] = useState(false)
  const value = settings.value

  if (value === null)
    return (
      <div className={styles['page']}>
        {settings.error === null ? (
          <Skeleton height={160} />
        ) : (
          <Banner
            actions={
              <Button onClick={() => void settings.reload()} size="sm">
                Повторить
              </Button>
            }
            icon="wifiOff"
            title="Не удалось получить настройки"
            tone="warn"
          >
            {settings.error.message}
          </Banner>
        )}
      </div>
    )

  const save = (key: ToggleKey, next: boolean): void => {
    setDesired((current) => ({ ...current, [key]: next }))
    void settings.update({ [key]: next }).then((ok) => {
      setDesired((current) =>
        Object.fromEntries(Object.entries(current).filter(([name]) => name !== key)),
      )
      if (ok) toast.show({ message: 'Сохранено', duration: 1500 })
    })
  }

  const openLogs = (): void => {
    setOpeningLogs(true)
    setLogError(null)
    window.crTools.openLogFolder().then(
      (result) => {
        setOpeningLogs(false)
        if (!result.opened) setLogError('Не удалось открыть папку журналов.')
      },
      () => {
        setOpeningLogs(false)
        setLogError('Не удалось открыть папку журналов.')
      },
    )
  }

  return (
    <div className={styles['page']}>
      {settings.actionError === null ? null : (
        <Banner icon="alert" title="Не получилось" tone="danger">
          {settings.actionError}
        </Banner>
      )}
      {GROUPS.map((group) => (
        <Group key={group.title} title={group.title}>
          <Card padded>
            {group.items.map((item) => (
              <Setting hint={item.hint} key={item.key} title={item.title}>
                <Switch
                  checked={desired[item.key] ?? value[item.key]}
                  disabled={desired[item.key] !== undefined}
                  label={item.title}
                  onChange={(next) => save(item.key, next)}
                />
              </Setting>
            ))}
          </Card>
        </Group>
      ))}
      <Group title="Диагностика">
        <Card padded>
          <Setting
            hint="Расширенный вывод в локальный журнал. Данные никуда не отправляются."
            title="Подробный журнал"
          >
            <Switch
              checked={desired.diagnosticsEnabled ?? value.diagnosticsEnabled}
              disabled={desired.diagnosticsEnabled !== undefined}
              label="Подробный журнал"
              onChange={(next) => save('diagnosticsEnabled', next)}
            />
          </Setting>
          <Setting
            hint="Журналы лежат на этом компьютере. Они могут понадобиться поддержке."
            title="Папка журналов"
          >
            <Button loading={openingLogs} onClick={openLogs} size="sm">
              <Icon name="external" size={14} />
              Открыть папку журналов
            </Button>
          </Setting>
          {logError === null ? null : (
            <Banner icon="alert" title="Не получилось" tone="danger">
              {logError}
            </Banner>
          )}
        </Card>
      </Group>
    </div>
  )
}
