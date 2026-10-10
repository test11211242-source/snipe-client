import { useState, type ReactNode } from 'react'

import {
  Avatar,
  Banner,
  Button,
  Card,
  CardTile,
  Chip,
  ClanLine,
  ConfirmDialog,
  Deck,
  DeckTabs,
  Dialog,
  Dot,
  Field,
  Group,
  Icon,
  IconButton,
  Input,
  LinkButton,
  Menu,
  MenuItem,
  MenuSeparator,
  Palette,
  Panel,
  Pill,
  Progress,
  Rating,
  Requirements,
  Row,
  RunButton,
  Segment,
  Setting,
  Skeleton,
  Spinner,
  State,
  Stepper,
  Switch,
  TagChip,
  TitleChip,
  ToastProvider,
  UpdateBar,
  useToast,
} from '../ui'
import { cx } from '../ui'
import styles from './Catalog.module.css'

// Catalog-only sample data: it never reaches production screens.
const SAMPLE_CARD =
  'data:image/svg+xml;utf8,' +
  encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" width="150" height="180"><rect width="150" height="180" rx="14" fill="#2b2f38"/><circle cx="75" cy="80" r="34" fill="#63d2a9"/></svg>',
  )
const CARDS = Array.from({ length: 8 }, (_, index) => ({
  name: `Карта ${index + 1}`,
  iconUrl: index === 6 ? null : SAMPLE_CARD,
}))

function Section({
  title,
  wide = false,
  children,
}: {
  title: string
  wide?: boolean
  children: ReactNode
}): React.JSX.Element {
  return (
    <section className={cx(styles['section'], wide && styles['wide'])}>
      <h2 className={styles['caption']}>{title}</h2>
      {children}
    </section>
  )
}

function ToastDemo(): React.JSX.Element {
  const toast = useToast()
  return (
    <Button
      onClick={() =>
        toast.show({
          message: 'Название обновлено',
          action: { label: 'Отменить', onAction: () => undefined },
        })
      }
    >
      Показать тост
    </Button>
  )
}

type Overlay = 'dialog' | 'confirm' | 'panel' | 'palette' | null

function Catalog(): React.JSX.Element {
  const [on, setOn] = useState(true)
  const [seg, setSeg] = useState<'pol' | 'gt'>('pol')
  const [steps, setSteps] = useState(120)
  const [deck, setDeck] = useState(0)
  const [chip, setChip] = useState(true)
  const [overlay, setOverlay] = useState<Overlay>(null)
  const [palette, setPalette] = useState('')
  const [rose, setRose] = useState(false)

  return (
    <div className={styles['page']}>
      <div className={styles['title']}>
        <h1>Каталог компонентов</h1>
        <Segment
          label="Акцент"
          onChange={(next) => {
            setRose(next === 'rose')
            if (next === 'rose') document.documentElement.dataset['accent'] = 'rose'
            else delete document.documentElement.dataset['accent']
          }}
          options={[
            { value: 'green', label: 'Мята' },
            { value: 'rose', label: 'Розовый' },
          ]}
          value={rose ? 'rose' : 'green'}
        />
      </div>

      <Section title="Кнопки">
        <div className={styles['row']}>
          <Button variant="primary">Основная</Button>
          <Button>Обычная</Button>
          <Button variant="ghost">Тихая</Button>
          <Button variant="danger">Опасная</Button>
          <Button variant="dangerSolid">Удалить</Button>
          <Button loading>Загрузка</Button>
          <Button disabled>Недоступна</Button>
        </div>
        <div className={styles['row']}>
          <Button size="sm">Малая</Button>
          <Button size="lg">Крупная</Button>
          <IconButton label="Настройки">
            <Icon name="gear" size={18} />
          </IconButton>
          <RunButton label="Начать мониторинг">
            <Icon name="play" size={15} />
          </RunButton>
          <RunButton label="Остановить" running>
            <Icon name="stop" size={15} />
          </RunButton>
          <LinkButton tone="accent">Ссылка</LinkButton>
        </div>
      </Section>

      <Section title="Поля и выбор">
        <Field hint="От 1 до 80 символов" label="Название">
          {(props) => <Input {...props} placeholder="Основной" />}
        </Field>
        <Field error="Такое имя уже есть. Выберите другое." label="С ошибкой">
          {(props) => <Input {...props} defaultValue="Основной" />}
        </Field>
        <div className={styles['row']}>
          <Switch checked={on} label="Переключатель" onChange={setOn} />
          <Segment
            label="Режим колод"
            onChange={setSeg}
            options={[
              { value: 'pol', label: 'Путь легенд' },
              { value: 'gt', label: 'Турнир' },
            ]}
            value={seg}
          />
          <Stepper
            format={(value) => `${value} с`}
            label="Окно"
            max={1800}
            min={30}
            onChange={setSteps}
            step={10}
            value={steps}
          />
          <Chip onClick={() => setChip(!chip)} pressed={chip}>
            Фильтр
          </Chip>
          <TitleChip onRemove={() => undefined} removeLabel="Убрать блок">
            Место в топе
          </TitleChip>
        </div>
      </Section>

      <Section title="Обратная связь">
        <div className={styles['row']}>
          <Pill>Нейтральный</Pill>
          <Pill tone="ok">Идёт</Pill>
          <Pill tone="warn">Внимание</Pill>
          <Pill tone="danger">Ошибка</Pill>
          <Dot live tone="ok" />
          <Spinner />
          <Avatar name="ArtCS" />
          <ToastDemo />
        </div>
        <Skeleton height={18} width="60%" />
        <Progress label="Загрузка" value={62} />
        <Banner icon="wifiOff" title="Нет связи с сервером" tone="warn">
          Переподключаемся. Содержимое остаётся.
        </Banner>
        <Banner icon="checkCircle" title="Готово" tone="ok" />
      </Section>

      <Section title="Состояние">
        <State icon="target" pulse title="Ждём бой" tone="ok">
          Как только начнётся экран «VS», мы найдём соперника.
        </State>
      </Section>

      <Section title="Игра">
        <div className={styles['row']}>
          <Rating value={2487} />
          <TagChip onCopy={() => true} tag="#2Q8YLP0" />
          <TagChip tag="#9PCQ0Y2" />
        </div>
        <ClanLine clan="Северный ветер" />
        <ClanLine clan={null} />
        <div className={styles['row']}>
          <CardTile card={CARDS[0] ?? null} />
          <CardTile card={CARDS[6] ?? null} />
          <CardTile card={null} loading />
        </div>
        <DeckTabs count={3} onSelect={setDeck} selected={deck} />
        <Deck cards={CARDS.slice(0, 7)} label="Колода" tileWidth={84} />
      </Section>

      <Section title="Строки и требования">
        <Card flush>
          <Row
            lead={<Icon name="window" size={16} />}
            sub="BlueStacks App Player"
            title="Основной"
            trail={<Pill tone="ok">Активный</Pill>}
          />
          <Row
            lead={<Icon name="monitor" size={16} />}
            sub="окно не найдено"
            title="Твинк"
            warnSub
          />
        </Card>
        <Group title="Настройки">
          <Setting
            hint="Приложение откроется свёрнутым"
            title="Запускать вместе с Windows"
          >
            <Switch checked={on} label="Запускать вместе с Windows" onChange={setOn} />
          </Setting>
        </Group>
        <Requirements
          items={[
            {
              id: 't',
              name: 'Twitch',
              state: 'не подключён',
              ok: false,
              action: { label: 'Подключить', onAction: () => undefined },
            },
            { id: 'm', name: 'Мониторинг', state: 'идёт', ok: true },
          ]}
        />
      </Section>

      <Section title="Полоса обновления" wide>
        {(['AVAILABLE', 'DOWNLOADING', 'READY', 'FAILED'] as const).map((state) => (
          <UpdateBar
            key={state}
            onDownload={() => undefined}
            onInstall={() => undefined}
            onRetry={() => undefined}
            onWhatsNew={() => undefined}
            view={{
              state,
              currentVersion: '0.1.23',
              availableVersion: '0.2.0',
              critical: false,
              releaseNotes: [],
              progress:
                state === 'DOWNLOADING'
                  ? { downloadedBytes: 62, totalBytes: 100, percent: 62 }
                  : null,
              error:
                state === 'FAILED'
                  ? {
                      code: 'X',
                      message: 'Сервер обновлений не ответил.',
                      retryable: true,
                    }
                  : null,
            }}
          />
        ))}
      </Section>

      <Section title="Меню и окна">
        <div className={styles['row']}>
          <Menu
            label="Пример меню"
            trigger={({ props }) => (
              <Button {...props}>
                Меню <Icon name="chevronDown" size={14} />
              </Button>
            )}
          >
            <MenuItem onSelect={() => undefined}>Переименовать</MenuItem>
            <MenuItem onSelect={() => undefined}>Дублировать</MenuItem>
            <MenuSeparator />
            <MenuItem danger onSelect={() => undefined}>
              Удалить
            </MenuItem>
          </Menu>
          <Button onClick={() => setOverlay('dialog')}>Диалог</Button>
          <Button onClick={() => setOverlay('confirm')}>Подтверждение</Button>
          <Button onClick={() => setOverlay('panel')}>Панель</Button>
          <Button onClick={() => setOverlay('palette')}>Палитра</Button>
        </div>
      </Section>

      {overlay === 'dialog' ? (
        <Dialog
          footer={<Button onClick={() => setOverlay(null)}>Закрыть</Button>}
          onClose={() => setOverlay(null)}
          title="Диалог"
        />
      ) : null}
      {overlay === 'confirm' ? (
        <ConfirmDialog
          confirmLabel="Удалить профиль"
          onCancel={() => setOverlay(null)}
          onConfirm={() => setOverlay(null)}
          text="Настройки источника будут удалены. Игру и аккаунт это не затронет."
          title="Удалить профиль «Основной»?"
        />
      ) : null}
      {overlay === 'panel' ? (
        <Panel
          footer={<span>2 из 20</span>}
          onClose={() => setOverlay(null)}
          title="Профили"
        >
          <Row sub="BlueStacks App Player" title="Основной" />
        </Panel>
      ) : null}
      {overlay === 'palette' ? (
        <Palette
          hint="Вставьте тег игрока. Esc — закрыть."
          label="Проверить тег"
          onClose={() => setOverlay(null)}
          onSubmit={() => undefined}
          onValueChange={setPalette}
          placeholder="#2Q8YLP0"
          value={palette}
        />
      ) : null}
    </div>
  )
}

/** Dev/test-only kit catalog (renderer/catalog.html). Not part of the production build. */
export function CatalogApp(): React.JSX.Element {
  return (
    <ToastProvider>
      <Catalog />
    </ToastProvider>
  )
}
