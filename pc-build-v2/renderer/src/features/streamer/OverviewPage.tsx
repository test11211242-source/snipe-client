import { useRouter, type StreamSection } from '../../app/router'
import {
  Banner,
  Button,
  Card,
  Group,
  Icon,
  IconButton,
  LinkButton,
  Pill,
  Row,
  Switch,
  cx,
  type IconName,
  type Tone,
} from '../../ui'
import { StreamerGate } from './StreamerGate'
import { useStreamer } from './streamerContext'
import styles from './Streamer.module.css'
import { useCopyUrl } from './useCopyUrl'
import { useOverlaySettings } from './useOverlaySettings'
import {
  missingFor,
  useFoundations,
  type FeatureId,
  type FoundationId,
  type FoundationItem,
} from './useRequirements'
import { useRunner } from './useRunner'
import { predictionStatusText, votingLabel } from './text'

const BASE: readonly FoundationId[] = [
  'twitch',
  'accounts',
  'monitoring',
  'predictionProfile',
]

/** «Обзор эфира»: four foundations on top, the features below, each with its next step. */
export function OverviewPage(): React.JSX.Element {
  return (
    <StreamerGate>
      <Overview />
    </StreamerGate>
  )
}

function Overview(): React.JSX.Element {
  const { view } = useStreamer()
  const { navigate } = useRouter()
  const foundations = useFoundations()
  const { run, error } = useRunner()
  const overlay = useOverlaySettings()
  const { copy, copied, error: copyError } = useCopyUrl()
  if (view === null) return <></>

  const open = (section: StreamSection) => (): void =>
    navigate({ name: 'stream', section })
  const next = (feature: FeatureId): FoundationItem | undefined =>
    missingFor(feature, foundations)[0]
  const isReady = (feature: FeatureId): boolean =>
    missingFor(feature, foundations).length === 0

  const settings = view.title.settings
  const predictionPill = predictionStatusText(view.predictions)
  const predictionMode =
    view.predictions.settings.mode === 'streak' ? 'Серия побед' : 'Каждый бой'
  const features: {
    id: FeatureId
    icon: IconName
    title: string
    sub: string
    pill?: { tone: Tone; label: string }
    toggle?: { label: string; checked: boolean; onChange: (next: boolean) => void }
    section: StreamSection
  }[] = [
    {
      id: 'predictions',
      icon: 'trophy',
      title: 'Прогнозы',
      sub: `${predictionMode} · ${votingLabel(view.predictions.settings.votingSeconds)} на ставки`,
      ...(predictionPill === null ? {} : { pill: predictionPill }),
      section: 'predictions',
    },
    {
      id: 'title',
      icon: 'title',
      title: 'Название стрима',
      sub:
        view.title.previewTitle === ''
          ? 'Название пока не собрано'
          : `«${view.title.previewTitle}»`,
      toggle: {
        label: 'Обновлять название само',
        checked: settings.enabled,
        onChange: (enabled) =>
          void run({ action: 'title.enabled', enabled }, { key: 'title.enabled' }),
      },
      section: 'title',
    },
    {
      id: 'chat',
      icon: 'chat',
      title: 'Колоды в чат',
      sub: 'Отправлять колоду соперника в чат Twitch',
      toggle: {
        label: 'Отправлять колоды в чат',
        checked: view.deckSharing.enabled,
        onChange: (enabled) =>
          void run({ action: 'chat.toggle', enabled }, { key: 'chat.toggle' }),
      },
      section: 'chat',
    },
  ]
  const url = view.overlay.urlsAvailable

  return (
    <div className={styles['page']}>
      {error === null && copyError === null && overlay.error === null ? null : (
        <Banner
          actions={
            overlay.error !== null && overlay.dirty ? (
              <Button onClick={overlay.retry} size="sm">
                Повторить
              </Button>
            ) : undefined
          }
          icon="alert"
          title="Не получилось"
          tone="danger"
        >
          {error ?? copyError ?? overlay.error}
        </Banner>
      )}
      <Group
        title="Основа"
        trail={<span>общие подключения: функции ниже только используют их</span>}
      >
        <div className={styles['foundation']}>
          {BASE.map((id) => {
            const item = foundations[id]
            return (
              <div
                className={cx(styles['base'], !item.ok && styles['baseWarn'])}
                key={id}
              >
                <div className={styles['baseHead']}>
                  <span className={styles['baseMark']}>
                    <Icon name={item.ok ? 'check' : 'alert'} size={13} />
                  </span>
                  <span>{item.name}</span>
                </div>
                <span className={styles['baseState']}>{item.state}</span>
                <div className={styles['baseAction']}>
                  {item.ok ? (
                    <LinkButton onClick={item.home}>
                      Управлять
                      <Icon name="chevronRight" size={12} />
                    </LinkButton>
                  ) : (
                    <Button onClick={item.action?.onAction} size="sm" variant="primary">
                      {item.action?.label ?? 'Исправить'}
                    </Button>
                  )}
                </div>
              </div>
            )
          })}
        </div>
      </Group>
      <Group title="Функции" trail={<span>что нужно каждой — в строке справа</span>}>
        <Card flush>
          {features.map((feature) => {
            const blocker = next(feature.id)
            const ready = isReady(feature.id)
            return (
              <Row
                bordered
                className={styles['rowPad']}
                key={feature.id}
                lead={<Icon name={feature.icon} size={17} />}
                sub={feature.sub}
                title={feature.title}
                trail={
                  <span className={styles['fnTrail']}>
                    {feature.pill === undefined ? null : (
                      <Pill tone={feature.pill.tone}>{feature.pill.label}</Pill>
                    )}
                    {blocker === undefined ? null : (
                      <LinkButton onClick={blocker.action?.onAction} tone="warn">
                        {blocker.name}: {blocker.action?.label.toLowerCase()}
                        <Icon name="chevronRight" size={12} />
                      </LinkButton>
                    )}
                    {feature.toggle === undefined ? null : (
                      <Switch
                        checked={feature.toggle.checked}
                        disabled={!ready && !feature.toggle.checked}
                        label={feature.toggle.label}
                        onChange={feature.toggle.onChange}
                      />
                    )}
                    <LinkButton onClick={open(feature.section)}>
                      Настроить
                      <Icon name="chevronRight" size={12} />
                    </LinkButton>
                  </span>
                }
              />
            )
          })}
          <Row
            bordered
            className={styles['rowPad']}
            lead={<Icon name="layers" size={17} />}
            sub="Работают без Twitch"
            title="Виджеты для OBS"
            trail={
              <span className={styles['fnTrail']}>
                {(
                  [
                    [
                      'opponent',
                      'Соперник',
                      overlay.settings.opponentEnabled,
                      'opponentEnabled',
                    ],
                    [
                      'stats',
                      'Статистика',
                      overlay.settings.streamerStatsEnabled,
                      'streamerStatsEnabled',
                    ],
                  ] as const
                ).map(([kind, label, on, field]) => (
                  <span className={styles['fnLabel']} key={kind}>
                    {label}
                    <Switch
                      checked={on}
                      label={`Показывать: ${label}`}
                      onChange={(next) => overlay.update({ [field]: next })}
                    />
                    <IconButton
                      disabled={!url[kind]}
                      label={`Скопировать ссылку: ${label}`}
                      onClick={() => void copy(kind)}
                      size="sm"
                    >
                      <Icon name={copied === kind ? 'check' : 'copy'} size={14} />
                    </IconButton>
                  </span>
                ))}
                <LinkButton onClick={open('widgets')}>
                  Настроить
                  <Icon name="chevronRight" size={12} />
                </LinkButton>
              </span>
            }
          />
        </Card>
      </Group>
    </div>
  )
}
