import {
  Banner,
  Button,
  Card,
  Group,
  Icon,
  Pill,
  Segment,
  Setting,
  Skeleton,
  Stepper,
  Switch,
} from '../../ui'
import styles from './Settings.module.css'
import { useWidgetSettings } from './useWidgetSettings'

/**
 * «Оверлей соперника»: the same fields as the tray menu and the overlay window itself.
 * Every control saves immediately.
 */
export function OverlaySettingsPage(): React.JSX.Element {
  const widget = useWidgetSettings()
  const { status } = widget

  if (status === null)
    return (
      <div className={styles['page']}>
        {widget.loadFailed ? (
          <Banner
            actions={
              <Button onClick={() => void widget.reload()} size="sm">
                Повторить
              </Button>
            }
            icon="wifiOff"
            title="Не удалось получить настройки оверлея"
            tone="warn"
          >
            Окно оверлея продолжает работать как раньше. Повторите через минуту.
          </Banner>
        ) : (
          <Skeleton height={160} />
        )}
      </div>
    )

  const { settings } = status
  const compact = settings.compactMode
  const width = compact ? settings.compactWidth : settings.normalWidth

  return (
    <div className={styles['page']}>
      {widget.error === null ? null : (
        <Banner icon="alert" title="Не получилось" tone="danger">
          {widget.error}
        </Banner>
      )}
      <Group title="Окно">
        <Card padded>
          <div className={styles['row']}>
            <Button
              disabled={widget.pending}
              onClick={() => void widget.toggleWindow()}
              variant={status.visible ? 'default' : 'primary'}
            >
              <Icon name="window" size={15} />
              {status.visible ? 'Скрыть окно' : 'Показать окно'}
            </Button>
            <Pill tone={status.visible ? 'ok' : 'neutral'}>
              {status.visible ? 'Окно открыто' : 'Окно скрыто'}
            </Pill>
          </div>
        </Card>
      </Group>
      <Group title="Показ">
        <Card padded>
          <Setting
            hint="Окно появится поверх игры само"
            title="Открывать, когда найден соперник"
          >
            <Switch
              checked={settings.autoOpen}
              label="Открывать, когда найден соперник"
              onChange={(autoOpen) => void widget.update({ autoOpen })}
            />
          </Setting>
          <Setting hint="Чтобы окно не уходило под игру" title="Поверх всех окон">
            <Switch
              checked={settings.alwaysOnTop}
              label="Поверх всех окон"
              onChange={(alwaysOnTop) => void widget.update({ alwaysOnTop })}
            />
          </Setting>
          <Setting
            hint="Клики проходят сквозь него. Открепить: меню значка в трее или этот переключатель."
            title="Закрепить окно"
          >
            <Switch
              checked={settings.locked}
              label="Закрепить окно"
              onChange={(locked) => void widget.update({ locked })}
            />
          </Setting>
        </Card>
      </Group>
      <Group title="Вид">
        <Card padded>
          <Setting
            hint="Компактный — 8 карточек колоды в один ряд"
            title="Расположение колоды"
          >
            <Segment
              label="Расположение колоды"
              onChange={(mode) => void widget.update({ compactMode: mode === 'compact' })}
              options={[
                { value: 'normal', label: 'Обычное' },
                { value: 'compact', label: 'Компактное' },
              ]}
              value={compact ? 'compact' : 'normal'}
            />
          </Setting>
          <Setting
            hint={`От ${compact ? 440 : 300} до 720 точек. Запоминается отдельно для обычного и компактного вида.`}
            title="Ширина окна"
          >
            <Stepper
              format={(value) => `${value} px`}
              label="Ширина окна"
              max={720}
              min={compact ? 440 : 300}
              onChange={(next) =>
                void widget.update(
                  compact ? { compactWidth: next } : { normalWidth: next },
                )
              }
              step={20}
              value={width}
            />
          </Setting>
          <Setting hint="Насколько просвечивает окно" title="Прозрачность">
            <Stepper
              format={(value) => `${value}%`}
              label="Прозрачность окна, процентов"
              max={100}
              min={55}
              onChange={(percent) => void widget.update({ opacity: percent / 100 })}
              step={5}
              value={Math.round(settings.opacity * 100)}
            />
          </Setting>
        </Card>
      </Group>
    </div>
  )
}
