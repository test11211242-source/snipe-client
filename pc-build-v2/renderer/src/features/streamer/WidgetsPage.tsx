import { useState } from 'react'

import type { OverlayUrlKind } from '../../../../shared/models/streamer'
import {
  Banner,
  Button,
  Card,
  ConfirmDialog,
  Group,
  Icon,
  IconButton,
  Requirements,
  Row,
  Segment,
  Select,
  Setting,
  Stepper,
  Switch,
  useToast,
} from '../../ui'
import { StreamerGate } from './StreamerGate'
import { useStreamer } from './streamerContext'
import { useCopyUrl } from './useCopyUrl'
import { useOverlaySettings } from './useOverlaySettings'
import { useRequirements } from './useRequirements'
import { useConfirmedAction } from './useRunner'
import { widgetPreviewUrl, widgetSize } from './widgetUrl'
import { WidgetPreview } from './WidgetPreview'
import styles from './Widgets.module.css'
import page from './Streamer.module.css'

const KIND_LABEL: Record<OverlayUrlKind, string> = {
  opponent: 'Карточка соперника',
  stats: 'Статистика стримера',
}

export function WidgetsPage(): React.JSX.Element {
  return (
    <StreamerGate>
      <Widgets />
    </StreamerGate>
  )
}

function Widgets(): React.JSX.Element {
  const { view, reload } = useStreamer()
  const toast = useToast()
  const requirements = useRequirements('widgets')
  const overlay = useOverlaySettings()
  const { copy, copied, error: copyError } = useCopyUrl()
  const [selected, setSelected] = useState<OverlayUrlKind>('opponent')
  const rotate = useConfirmedAction(
    { action: 'widget.resetToken', confirmed: true },
    () => toast.show({ message: 'Ключ заменён. Скопируйте новые ссылки в OBS.' }),
  )
  if (view === null) return <></>

  const { settings } = overlay
  const urls = view.overlay.urlsAvailable
  const missingUrls = !urls.opponent || !urls.stats
  const enabledAccounts = view.title.accounts.filter((account) => account.enabled)
  const [width, height] = widgetSize(selected, settings)
  const on =
    selected === 'opponent' ? settings.opponentEnabled : settings.streamerStatsEnabled
  const error = overlay.error ?? copyError

  const sources: {
    kind: OverlayUrlKind
    icon: 'user' | 'chart'
    enabled: boolean
    field: 'opponentEnabled' | 'streamerStatsEnabled'
  }[] = [
    {
      kind: 'opponent',
      icon: 'user',
      enabled: settings.opponentEnabled,
      field: 'opponentEnabled',
    },
    {
      kind: 'stats',
      icon: 'chart',
      enabled: settings.streamerStatsEnabled,
      field: 'streamerStatsEnabled',
    },
  ]

  return (
    <div className={styles['cols']}>
      <div className={styles['main']}>
        <Requirements
          items={requirements}
          note="Twitch виджетам не нужен: они открываются по своей ссылке с ключом"
        />
        {missingUrls ? (
          <Banner
            actions={
              <Button onClick={() => void reload()} size="sm">
                <Icon name="refresh" size={14} />
                Обновить
              </Button>
            }
            icon="alert"
            title="Сервер ещё не выдал ссылки"
            tone="warn"
          >
            Нажмите «Обновить» или попробуйте через минуту. Ссылка появится здесь сама.
          </Banner>
        ) : null}
        {error === null ? null : (
          <Banner
            actions={
              overlay.dirty ? (
                <Button onClick={overlay.retry} size="sm">
                  Повторить
                </Button>
              ) : undefined
            }
            icon="alert"
            title="Не получилось"
            tone="danger"
          >
            {error}
            {overlay.dirty ? ' Изменения остались в форме.' : ''}
          </Banner>
        )}

        <Group title="Источники для OBS">
          <Card flush>
            <Row
              bordered
              sub="Общий выключатель. Выключен: OBS получит пустую картинку."
              title="Показывать виджеты в трансляции"
              trail={
                <Switch
                  checked={settings.enabled}
                  label="Виджеты включены"
                  onChange={(enabled) => overlay.update({ enabled })}
                />
              }
            />
            {sources.map((source) => (
              <Row
                bordered
                key={source.kind}
                lead={<Icon name={source.icon} size={17} />}
                selected={selected === source.kind}
                sub={
                  <span className={styles['url']}>
                    {urls[source.kind]
                      ? (view.overlay.maskedUrls[source.kind] ?? 'Ссылка готова')
                      : 'Ссылка пока не создана'}
                  </span>
                }
                title={KIND_LABEL[source.kind]}
                trail={
                  <span className={styles['trail']}>
                    <IconButton
                      disabled={!urls[source.kind]}
                      label={`Скопировать ссылку: ${KIND_LABEL[source.kind]}`}
                      onClick={() => void copy(source.kind)}
                      size="sm"
                    >
                      <Icon name={copied === source.kind ? 'check' : 'copy'} size={14} />
                    </IconButton>
                    <Switch
                      checked={source.enabled}
                      label={`Показывать: ${KIND_LABEL[source.kind]}`}
                      onChange={(next) => overlay.update({ [source.field]: next })}
                    />
                  </span>
                }
              />
            ))}
          </Card>
          <p className={page['muted']}>
            В OBS: «Источник» → «Браузер» → вставьте ссылку и задайте размер из подсказки
            справа.
          </p>
        </Group>

        <Group
          title={`Оформление · ${selected === 'opponent' ? 'карточка соперника' : 'статистика'}`}
        >
          <Card padded>
            <Setting title="Компоновка">
              <Segment
                label="Компоновка"
                onChange={(layout) =>
                  overlay.update(
                    selected === 'opponent'
                      ? { opponentLayout: layout }
                      : { statsLayout: layout },
                  )
                }
                options={[
                  { value: 'compact', label: 'Компактная' },
                  { value: 'standard', label: 'Стандартная' },
                  { value: 'detailed', label: 'Подробная' },
                ]}
                value={
                  selected === 'opponent' ? settings.opponentLayout : settings.statsLayout
                }
              />
            </Setting>
            <Setting hint="Для обоих виджетов" title="Шрифт">
              <Segment
                label="Шрифт"
                onChange={(widgetFontStyle) => overlay.update({ widgetFontStyle })}
                options={[
                  { value: 'gaming', label: 'Игровой' },
                  { value: 'clean', label: 'Чистый' },
                  { value: 'condensed', label: 'Узкий' },
                ]}
                value={settings.widgetFontStyle}
              />
            </Setting>
            <Setting hint="Для обоих виджетов" title="Углы">
              <Segment
                label="Углы"
                onChange={(widgetCornerStyle) => overlay.update({ widgetCornerStyle })}
                options={[
                  { value: 'rounded', label: 'Скруглённые' },
                  { value: 'square', label: 'Квадратные' },
                  { value: 'pill', label: 'Пилюля' },
                ]}
                value={settings.widgetCornerStyle}
              />
            </Setting>
            {selected === 'stats' ? (
              <>
                <Setting
                  hint="Аккаунт, статистика которого идёт в виджет"
                  title="Чей счёт показывать"
                >
                  <Segment
                    label="Чей счёт показывать"
                    onChange={(streamerAccountMode) =>
                      overlay.update({ streamerAccountMode })
                    }
                    options={[
                      { value: 'stream_title', label: 'Как в названии' },
                      { value: 'manual', label: 'Вручную' },
                    ]}
                    value={settings.streamerAccountMode}
                  />
                </Setting>
                {settings.streamerAccountMode === 'manual' ? (
                  <Setting title="Аккаунт">
                    <Select
                      aria-label="Аккаунт для статистики"
                      onChange={(event) =>
                        overlay.update({ manualStreamerTag: event.currentTarget.value })
                      }
                      value={settings.manualStreamerTag}
                    >
                      <option value="">Выберите аккаунт</option>
                      {enabledAccounts.map((account) => (
                        <option key={account.tag} value={account.tag}>
                          {account.alias || account.name || account.tag}
                        </option>
                      ))}
                    </Select>
                  </Setting>
                ) : null}
              </>
            ) : (
              <Setting hint="Карточка исчезнет сама" title="Сколько секунд показывать">
                <Stepper
                  format={(value) => `${value} с`}
                  label="Сколько секунд показывать карточку"
                  max={120}
                  min={5}
                  onChange={(opponentDisplaySeconds) =>
                    overlay.update({ opponentDisplaySeconds })
                  }
                  step={5}
                  value={settings.opponentDisplaySeconds}
                />
              </Setting>
            )}
          </Card>
        </Group>

        <Group title="Проверка в OBS">
          <Card padded>
            <Setting
              hint="Виджеты покажут пример, даже когда боя нет — удобно настраивать сцену"
              title="Тестовые данные"
            >
              <Switch
                checked={settings.previewMode}
                label="Тестовые данные в OBS"
                onChange={(previewMode) => overlay.update({ previewMode })}
              />
            </Setting>
            {settings.previewMode ? (
              <Setting title="Что показывать">
                <Segment
                  label="Что показывать в тестовом режиме"
                  onChange={(previewTarget) => overlay.update({ previewTarget })}
                  options={[
                    { value: 'opponent', label: 'Соперник' },
                    { value: 'stats', label: 'Статистика' },
                    { value: 'both', label: 'Оба' },
                  ]}
                  value={settings.previewTarget}
                />
              </Setting>
            ) : null}
          </Card>
        </Group>

        <Group title="Безопасность">
          <Card padded>
            <Setting
              hint="Если ссылкой поделились случайно. Старые ссылки перестанут работать."
              title="Ключ доступа к виджетам"
            >
              <Button onClick={rotate.ask} size="sm" variant="danger">
                Сменить ключ…
              </Button>
            </Setting>
          </Card>
        </Group>
      </div>

      <aside aria-label="Предпросмотр виджета" className={styles['preview']}>
        <div className={styles['previewBar']}>
          <span>Предпросмотр на тёмном фоне</span>
          <span>тестовые данные</span>
        </div>
        <WidgetPreview
          dimmed={!on || !settings.enabled}
          height={height}
          title={`Предпросмотр: ${KIND_LABEL[selected]}`}
          url={widgetPreviewUrl(selected, settings)}
          width={width}
        />
        <div className={styles['size']}>
          <span>Размер в OBS</span>
          <b>
            {width} × {height}
          </b>
          <span>подсказка сервера: {view.overlay.recommendedSizes[selected]}</span>
        </div>
        <div className={styles['pick']}>
          <Segment
            label="Что показать в предпросмотре"
            onChange={setSelected}
            options={[
              { value: 'opponent', label: 'Карточка соперника' },
              { value: 'stats', label: 'Статистика' },
            ]}
            value={selected}
          />
        </div>
      </aside>

      {rotate.open ? (
        <ConfirmDialog
          confirmLabel="Сменить ключ"
          error={rotate.error}
          onCancel={rotate.cancel}
          onConfirm={rotate.confirm}
          pending={rotate.pending}
          text="Ссылки в OBS перестанут работать: придётся скопировать новые и вставить их в источники «Браузер»."
          title="Сменить ключ доступа?"
        />
      ) : null}
    </div>
  )
}
