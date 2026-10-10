import { useState } from 'react'

import {
  TITLE_PRESETS,
  type TitleBuilder,
  type TitleChip as TitleChipData,
} from '../../../../shared/contracts/title-builder'
import type { StreamTitleSettings } from '../../../../shared/models/streamer'
import { useRouter } from '../../app/router'
import {
  Banner,
  Button,
  Card,
  ConfirmDialog,
  Field,
  Group,
  Icon,
  Input,
  LinkButton,
  Menu,
  MenuItem,
  Pill,
  Requirements,
  Segment,
  Select,
  Setting,
  Switch,
  TitleChip,
  TitleTextChip,
  cx,
  useToast,
} from '../../ui'
import { StreamerGate } from './StreamerGate'
import { useStreamer } from './streamerContext'
import { titleApplicationText, type CommandWarning, type TitleApplication } from './text'
import styles from './Title.module.css'
import { missingFor, useFoundations, useRequirements } from './useRequirements'
import { useConfirmedAction, useRunner } from './useRunner'
import { useTitleEditor, type TitleNotice } from './useTitleEditor'
import { PRESET_IDS, useTitleExamples, type PresetId } from './useTitleExamples'

const PRESET_NAMES: Record<PresetId, string> = {
  short: 'Коротко',
  score: 'Со счётом',
  full: 'Полный',
  signed: 'С подписью',
}

type ChipKind = TitleChipData['kind']
const CHIP_INFO: Record<ChipKind, { name: string; hint: string; example: string }> = {
  rank: { name: 'Место в топе', hint: 'место аккаунта в рейтинге', example: '★ 297' },
  elo: { name: 'Рейтинг', hint: 'ELO аккаунта', example: '2 675 ELO' },
  wl: { name: 'Счёт за стрим', hint: 'победы и поражения за эфир', example: '5W-2L' },
  delta: { name: 'Изменение рейтинга', hint: 'сколько набрано за стрим', example: '+12' },
  account: {
    name: 'Ник аккаунта',
    hint: 'как назван аккаунт в списке',
    example: 'Основной',
  },
  best: {
    name: 'Лучший аккаунт',
    hint: 'название аккаунта с наибольшим рейтингом',
    example: 'Основной',
  },
  text: { name: 'Свой текст', hint: 'любая надпись', example: 'Играю в Clash Royale' },
}
const MAX_CHIPS = 12
const TWITCH_TITLE_LIMIT = 140

export function TitlePage(): React.JSX.Element {
  return (
    <StreamerGate>
      <Title />
    </StreamerGate>
  )
}

function Title(): React.JSX.Element {
  const { view, pendingKeys } = useStreamer()
  const { navigate } = useRouter()
  const toast = useToast()
  const { run, error: commandError } = useRunner()
  const requirements = useRequirements('title')
  const ready = missingFor('title', useFoundations()).length === 0
  const [notice, setNotice] = useState<TitleNotice | null>(null)
  const editor = useTitleEditor(setNotice)
  const examples = useTitleExamples()
  const [advanced, setAdvanced] = useState(false)

  const afterAction =
    (fallback: string) =>
    (outcome: {
      result: { titleApplication: TitleApplication; warnings: CommandWarning[] }
    }): void => {
      const note = titleApplicationText(
        outcome.result.titleApplication,
        outcome.result.warnings,
      ) ?? { tone: 'ok' as const, text: fallback }
      setNotice(note)
      toast.show({ message: note.text })
    }
  const undo = useConfirmedAction(
    { action: 'title.undo', confirmed: true },
    afterAction('Последний бой отменён'),
  )
  const reset = useConfirmedAction(
    { action: 'title.reset', confirmed: true },
    afterAction('Счёт за стрим сброшен'),
  )
  const restore = useConfirmedAction(
    { action: 'title.restore', confirmed: true },
    afterAction('Прежнее название восстановлено'),
  )
  if (view === null) return <></>

  const { title } = view
  const saved = title.settings
  const { draft } = editor
  const accounts = title.accounts.filter((account) => account.enabled)
  const session = title.session

  // Preview: the server's own for the saved title, the server preview of the draft when edited.
  const text =
    editor.dirty && editor.preview !== null ? editor.preview.text : title.previewTitle
  const count =
    editor.dirty && editor.preview !== null ? editor.preview.count : text.length
  const previewWarnings =
    editor.dirty && editor.preview !== null ? editor.preview.warnings : []
  const online = title.twitchOnline

  const toggleEnabled = (enabled: boolean): void => {
    void run({ action: 'title.enabled', enabled }, { key: 'title.enabled' }).then(
      (outcome) => {
        if (outcome.status !== 'ok') return
        afterAction(enabled ? 'Автообновление включено' : 'Автообновление выключено')(
          outcome,
        )
      },
    )
  }
  const togglePaused = (paused: boolean): void => {
    void run({ action: 'title.paused', paused }, { key: 'title.paused' }).then(
      (outcome) => {
        if (outcome.status !== 'ok') return
        afterAction(paused ? 'Обновление на паузе' : 'Обновление продолжится')(outcome)
      },
    )
  }

  const builder = editor.builder
  const chips: readonly TitleChipData[] = builder?.mode === 'chips' ? builder.chips : []
  const setChips = (next: TitleChipData[]): void =>
    editor.setBuilder({ mode: 'chips', chips: next })
  const selectPreset = (preset: PresetId): void =>
    editor.setBuilder({ mode: 'preset', preset })
  const used = new Set<ChipKind>(chips.map((chip) => chip.kind))
  const addable = (Object.keys(CHIP_INFO) as ChipKind[]).filter(
    (kind) =>
      chips.length < MAX_CHIPS &&
      (kind === 'text' ||
        (!used.has(kind) &&
          !(kind === 'account' && used.has('best')) &&
          !(kind === 'best' && used.has('account')))),
  )
  const startCustom = (): void => {
    if (builder?.mode === 'chips') return
    const seed: TitleChipData[] =
      builder?.mode === 'preset' ? [...TITLE_PRESETS[builder.preset]] : []
    setChips(seed)
  }

  return (
    <div className={styles['cols']}>
      <div className={styles['main']}>
        <Requirements items={requirements} />
        {commandError === null && editor.builderError === null ? null : (
          <Banner icon="alert" title="Не получилось" tone="danger">
            {editor.builderError ?? commandError}
          </Banner>
        )}

        <section aria-label="Предпросмотр названия" className={styles['preview']}>
          <div className={styles['previewHead']}>
            <span className={styles['caps']}>
              {editor.dirty
                ? 'Так название будет выглядеть'
                : 'Так название выглядит сейчас'}
            </span>
            <span className={styles['pills']}>
              <Pill tone={online ? 'ok' : 'neutral'}>
                {online ? 'Канал онлайн' : 'Канал офлайн'}
              </Pill>
              <Pill tone={saved.enabled && !saved.paused ? 'ok' : 'neutral'}>
                {saved.enabled
                  ? saved.paused
                    ? 'Пауза'
                    : 'Обновляется само'
                  : 'Автообновление выключено'}
              </Pill>
            </span>
          </div>
          <div className={styles['previewText']} data-testid="title-preview">
            {text === '' ? 'Название пока не собрано' : text}
          </div>
          <div className={styles['previewMeta']}>
            <span>
              {count} из {TWITCH_TITLE_LIMIT} символов
              {editor.previewPending ? ' · обновляем предпросмотр…' : ''}
            </span>
            {count > TWITCH_TITLE_LIMIT ? (
              <span className={styles['warnText']}>
                Название длиннее {TWITCH_TITLE_LIMIT} символов — Twitch его обрежет.
                Уберите лишнее.
              </span>
            ) : (
              <span>
                Предпросмотр из данных ваших аккаунтов, на Twitch ничего не отправлено
              </span>
            )}
          </div>
          {previewWarnings.map((warning) => (
            <span className={styles['warnText']} key={warning}>
              {warning}
            </span>
          ))}
          {notice === null ? null : (
            <Banner
              icon={notice.tone === 'ok' ? 'checkCircle' : 'alert'}
              title={notice.text}
              tone={notice.tone === 'ok' ? 'ok' : 'warn'}
            />
          )}
          <div className={styles['actions']}>
            <Button
              disabled={!ready || editor.saving}
              loading={editor.saving}
              onClick={() => void editor.apply()}
              title="Сохранить и отправить название на Twitch"
            >
              <Icon name="broadcast" size={15} />
              Применить сейчас
            </Button>
          </div>
        </section>

        <Card padded>
          <Setting
            hint={
              ready || saved.enabled
                ? 'Во время эфира, после каждого боя. До включения название не меняется.'
                : 'Сначала закройте пункты выше'
            }
            title="Обновлять название само"
          >
            <Switch
              checked={saved.enabled}
              disabled={!saved.enabled && !ready}
              label="Обновлять название само"
              onChange={toggleEnabled}
            />
          </Setting>
          {saved.enabled ? (
            <Setting hint="Название замрёт, пока вы не продолжите" title="Пауза">
              <Switch
                checked={saved.paused}
                label="Пауза обновления"
                onChange={togglePaused}
              />
            </Setting>
          ) : null}
        </Card>

        <Group title="Стиль названия">
          <div className={styles['presets']}>
            {PRESET_IDS.map((preset) => {
              const on = builder?.mode === 'preset' && builder.preset === preset
              return (
                <button
                  aria-pressed={on}
                  className={styles['preset']}
                  key={preset}
                  onClick={() => selectPreset(preset)}
                  type="button"
                >
                  <span className={styles['presetName']}>
                    {PRESET_NAMES[preset]}
                    {on ? <Icon name="checkCircle" size={15} /> : null}
                  </span>
                  <span className={styles['presetExample']}>
                    {examples[preset] ?? '…'}
                  </span>
                </button>
              )
            })}
            {builder?.mode === 'raw' ? (
              <div
                aria-pressed="true"
                className={cx(styles['preset'], styles['custom'])}
                role="group"
              >
                <span className={styles['presetName']}>
                  <Icon name="sliders" size={14} />
                  Особый шаблон
                  <Icon name="checkCircle" size={15} />
                </span>
                <span className={styles['raw']}>{builder.template}</span>
                <span className={styles['example']}>
                  Шаблон собран вручную — мы сохраняем его без изменений. Выберите вариант
                  выше, чтобы заменить его.
                </span>
              </div>
            ) : (
              <button
                aria-pressed={builder?.mode === 'chips'}
                className={cx(styles['preset'], styles['custom'])}
                onClick={startCustom}
                type="button"
              >
                <span className={styles['presetName']}>
                  <Icon name="sliders" size={14} />
                  Свой вариант
                  {builder?.mode === 'chips' ? (
                    <Icon name="checkCircle" size={15} />
                  ) : null}
                </span>
                <span className={styles['presetExample']}>
                  Соберите из блоков: место, рейтинг, счёт, свой текст
                </span>
              </button>
            )}
          </div>
          {builder?.mode === 'chips' ? (
            <div className={styles['builder']}>
              <div className={styles['chips']}>
                {chips.map((chip, index) =>
                  chip.kind === 'text' ? (
                    <TitleTextChip
                      key={`text-${index}`}
                      label="Свой текст"
                      onChange={(value) =>
                        setChips(
                          chips.map((item, at) =>
                            at === index ? { kind: 'text', text: value } : item,
                          ),
                        )
                      }
                      onRemove={() => setChips(chips.filter((_, at) => at !== index))}
                      removeLabel="Убрать свой текст"
                      value={chip.text}
                    />
                  ) : (
                    <TitleChip
                      key={chip.kind}
                      onRemove={() => setChips(chips.filter((_, at) => at !== index))}
                      removeLabel={`Убрать «${CHIP_INFO[chip.kind].name}»`}
                    >
                      {CHIP_INFO[chip.kind].name}
                    </TitleChip>
                  ),
                )}
                <Menu
                  label="Добавить блок"
                  trigger={({ props }) => (
                    <Button {...props} disabled={addable.length === 0} size="sm">
                      <Icon name="plus" size={13} />
                      Добавить
                    </Button>
                  )}
                  width={340}
                >
                  {addable.map((kind) => (
                    <MenuItem
                      key={kind}
                      onSelect={() =>
                        setChips([
                          ...chips,
                          kind === 'text' ? { kind, text: '' } : { kind },
                        ])
                      }
                    >
                      <span className={styles['addItem']}>
                        <span>{CHIP_INFO[kind].name}</span>
                        <small>{CHIP_INFO[kind].hint}</small>
                      </span>
                      <span className={styles['example']}>{CHIP_INFO[kind].example}</span>
                    </MenuItem>
                  ))}
                </Menu>
              </div>
              <span className={styles['example']}>
                Блоки идут слева направо. Данные соединяются точками, свой текст ставится
                после черты.
              </span>
            </div>
          ) : null}
        </Group>

        <Group title="Данные">
          <Card padded>
            <Setting title="Какой аккаунт показывать">
              <Select
                aria-label="Какой аккаунт показывать"
                onChange={(event) =>
                  editor.patch({
                    accountDisplayMode: event.currentTarget
                      .value as StreamTitleSettings['accountDisplayMode'],
                  })
                }
                value={draft.accountDisplayMode}
              >
                <option value="last_active">Последний активный</option>
                <option value="best_elo">Лучший по рейтингу</option>
                <option value="manual">Выбрать вручную</option>
                {draft.accountDisplayMode === 'multiple' ? (
                  <option value="multiple">Несколько аккаунтов</option>
                ) : null}
              </Select>
            </Setting>
            {draft.accountDisplayMode === 'manual' ? (
              <Setting title="Аккаунт">
                <Select
                  aria-label="Аккаунт для названия"
                  onChange={(event) =>
                    editor.patch({ manualAccountTag: event.currentTarget.value })
                  }
                  value={draft.manualAccountTag}
                >
                  <option value="">Выберите аккаунт</option>
                  {accounts.map((account) => (
                    <option key={account.tag} value={account.tag}>
                      {account.alias || account.name || account.tag}
                    </option>
                  ))}
                </Select>
              </Setting>
            ) : null}
            <Setting hint="За этот эфир" title="Счёт побед и поражений">
              <Segment
                label="Счёт побед и поражений"
                onChange={(wlMode) => editor.patch({ wlMode })}
                options={[
                  { value: 'active', label: 'Активный аккаунт' },
                  { value: 'total', label: 'Все аккаунты' },
                ]}
                value={draft.wlMode}
              />
            </Setting>
          </Card>
        </Group>

        <Group title="Дополнительно">
          <Button
            aria-expanded={advanced}
            onClick={() => setAdvanced((open) => !open)}
            size="sm"
            variant="ghost"
          >
            <Icon name={advanced ? 'chevronUp' : 'chevronDown'} size={14} />
            {advanced ? 'Скрыть' : 'Показать'}
          </Button>
          {advanced ? (
            <Card padded>
              <div className={styles['advanced']}>
                <Setting title="Учитывать бои">
                  <Segment
                    label="Учитывать бои"
                    onChange={(battleMode) => editor.patch({ battleMode })}
                    options={[
                      { value: 'pathOfLegend', label: 'Путь легенд' },
                      { value: 'all', label: 'Все бои' },
                    ]}
                    value={draft.battleMode}
                  />
                </Setting>
                <Setting
                  hint={`Вернётся через ${draft.offlineGraceMinutes} мин после выхода из эфира`}
                  title="Вернуть прежнее название после эфира"
                >
                  <Switch
                    checked={draft.restoreTitleOnOffline}
                    label="Вернуть прежнее название"
                    onChange={(restoreTitleOnOffline) =>
                      editor.patch({ restoreTitleOnOffline })
                    }
                  />
                </Setting>
                <Field
                  hint="Для опытных: {rank} {elo} {wins}W-{losses}L {delta} {account}. Любой существующий шаблон сохраняется без изменений."
                  label="Шаблон названия"
                >
                  {(controlProps) => (
                    <Input
                      {...controlProps}
                      maxLength={200}
                      mono
                      onChange={(event) =>
                        editor.setBuilder({
                          mode: 'raw',
                          template: event.currentTarget.value,
                        } satisfies TitleBuilder)
                      }
                      value={
                        builder?.mode === 'raw' ? builder.template : draft.prefixTemplate
                      }
                    />
                  )}
                </Field>
              </div>
            </Card>
          ) : null}
        </Group>

        {editor.dirty ? (
          <div
            className={styles['saveBar']}
            role="region"
            aria-label="Несохранённые изменения"
          >
            <span>
              {editor.error ?? 'Есть несохранённые изменения. Предпросмотр — от сервера.'}
            </span>
            <span className={styles['actions']}>
              <Button disabled={editor.saving} onClick={editor.discard} variant="ghost">
                Отменить изменения
              </Button>
              <Button
                loading={editor.saving}
                onClick={() => void editor.save()}
                variant="primary"
              >
                Сохранить
              </Button>
            </span>
          </div>
        ) : editor.error === null ? null : (
          <Banner icon="alert" title="Не получилось" tone="danger">
            {editor.error}
          </Banner>
        )}
      </div>

      <aside className={styles['aside']}>
        <Card padded>
          <span className={styles['caps']}>Сессия</span>
          <div className={styles['session']}>
            <div>
              <b>{session?.totalWins ?? 0}</b>
              <small>Победы</small>
            </div>
            <div>
              <b>{session?.totalLosses ?? 0}</b>
              <small>Поражения</small>
            </div>
          </div>
          <div aria-label="Последние бои" className={styles['strip']} role="img">
            {title.recentResults
              .slice()
              .reverse()
              .map((result, index) => (
                <i
                  className={cx(
                    result.result === 'win' && styles['win'],
                    result.result === 'loss' && styles['loss'],
                  )}
                  key={index}
                  title={
                    { win: 'Победа', loss: 'Поражение', unknown: 'Неизвестно' }[
                      result.result
                    ]
                  }
                />
              ))}
          </div>
          <span className={styles['example']}>Последние бои, слева старые</span>
          <div className={styles['stack']}>
            <Button disabled={pendingKeys.size > 0} onClick={undo.ask} size="sm">
              <Icon name="repeat" size={14} />
              Отменить последний
            </Button>
            <Button disabled={pendingKeys.size > 0} onClick={reset.ask} size="sm">
              Сбросить счёт…
            </Button>
            <Button disabled={pendingKeys.size > 0} onClick={restore.ask} size="sm">
              Вернуть прежнее название…
            </Button>
          </div>
        </Card>
        <Card padded>
          <div className={styles['sideHead']}>
            <span className={styles['caps']}>Используемые аккаунты</span>
            <LinkButton
              onClick={() => navigate({ name: 'settings', section: 'accounts' })}
              tone="accent"
            >
              В настройки
            </LinkButton>
          </div>
          {accounts.length === 0 ? (
            <p className={styles['example']}>
              Нет включённых аккаунтов. Добавьте аккаунт, чтобы собрать название.
            </p>
          ) : (
            accounts.map((account) => (
              <div className={styles['accountRow']} key={account.tag}>
                <span>
                  <b>{account.alias || account.name || account.tag}</b>
                  <small>
                    {account.currentElo === null
                      ? 'данные появятся после проверки'
                      : `${account.currentElo.toLocaleString('ru-RU')} ELO`}
                  </small>
                </span>
                {session?.activeAccountTag === account.tag ? (
                  <Pill tone="ok">играет</Pill>
                ) : null}
              </div>
            ))
          )}
        </Card>
      </aside>

      {undo.open ? (
        <ConfirmDialog
          confirmLabel="Отменить бой"
          error={undo.error}
          onCancel={undo.cancel}
          onConfirm={undo.confirm}
          pending={undo.pending}
          text="Последний записанный результат уберётся из счёта за стрим, название пересоберётся по новому счёту."
          title="Отменить последний бой?"
        />
      ) : null}
      {reset.open ? (
        <ConfirmDialog
          confirmLabel="Сбросить счёт"
          error={reset.error}
          onCancel={reset.cancel}
          onConfirm={reset.confirm}
          pending={reset.pending}
          text="Победы и поражения за этот эфир обнулятся. Рейтинг аккаунтов не изменится."
          title="Сбросить счёт?"
        />
      ) : null}
      {restore.open ? (
        <ConfirmDialog
          confirmLabel="Вернуть название"
          error={restore.error}
          onCancel={restore.cancel}
          onConfirm={restore.confirm}
          pending={restore.pending}
          text="На канале будет восстановлено название, которое было до того, как CR Tools его изменил."
          title="Вернуть прежнее название?"
          tone="primary"
        />
      ) : null}
    </div>
  )
}
