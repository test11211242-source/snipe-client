import { useState } from 'react'

import type {
  CardAssetRequest,
  CardAssetResult,
} from '../../../../shared/contracts/widget-ipc'
import type { MonitorResult } from '../../../../shared/models/monitor'
import { useRouter } from '../../app/router'
import { useShellActions } from '../../app/shell/slotsContext'
import { useTier } from '../../app/useTier'
import {
  Button,
  ClanLine,
  Deck,
  DeckTabs,
  Icon,
  Rating,
  State,
  TagChip,
  type DeckCardData,
} from '../../ui'
import { useCardImages } from '../cards/useCardImages'
import { H2HBlock, H2HDialog, canonicalTag, useH2H } from '../h2h'
import { useAuth } from '../auth'
import { useCopyTag } from '../player/useCopyTag'
import styles from './Opponent.module.css'

type Found = Extract<MonitorResult, { kind: 'player_found' }>

const fetchCardAsset = (request: CardAssetRequest): Promise<CardAssetResult> =>
  window.crTools.getCardAsset(request)

const TILE_WIDTH = { wide: 108, medium: 84, mini: 82 } as const

function DeckView({
  result,
  deckIndex,
}: {
  result: Found
  deckIndex: number
}): React.JSX.Element {
  const tier = useTier()
  const deck = result.decks[deckIndex]
  const cards = deck?.cards ?? []
  const images = useCardImages(
    result.id,
    deckIndex,
    cards.map((card) => card.iconUrl !== null),
    fetchCardAsset,
  )
  const data: DeckCardData[] = cards.map((card, index) => ({
    name: card.name,
    iconUrl: images[index]?.src ?? null,
    pending: images[index]?.pending ?? false,
  }))
  return (
    <Deck
      cards={data}
      label={`Карты колоды ${deckIndex + 1}`}
      showNames={tier !== 'mini'}
      tileWidth={TILE_WIDTH[tier]}
    />
  )
}

function FoundBody({ result }: { result: Found }): React.JSX.Element {
  const tier = useTier()
  const { navigate } = useRouter()
  const copy = useCopyTag()
  const tag = canonicalTag(result.player.tag)
  const h2h = useH2H(tag)
  const [h2hOpen, setH2hOpen] = useState(false)
  const [selection, setSelection] = useState({ resultId: '', index: 0 })
  const requested = selection.resultId === result.id ? selection.index : 0
  const deckIndex = Math.min(requested, Math.max(0, result.decks.length - 1))
  const linkAccount = (): void => {
    setH2hOpen(false)
    navigate({ name: 'settings', section: 'accounts' })
  }
  const block = (variant: 'panel' | 'line'): React.JSX.Element => (
    <H2HBlock
      onLinkAccount={linkAccount}
      onOpen={() => setH2hOpen(true)}
      state={h2h.state}
      variant={variant}
    />
  )

  return (
    <div className={styles['found']}>
      <div className={styles['idRow']}>
        <div className={styles['idMain']}>
          <div className={styles['nameLine']}>
            <h2 className={styles['name']} title={result.player.name}>
              {result.player.name}
            </h2>
            {result.player.tag === null ? (
              <span className={styles['caption']}>Тег неизвестен</span>
            ) : (
              <span className={styles['tagGroup']}>
                <span className={styles['tagLabel']}>Тег игрока</span>
                <TagChip
                  onCopy={tag === null ? undefined : copy}
                  tag={result.player.tag}
                />
              </span>
            )}
          </div>
          <ClanLine clan={result.player.clan} />
          {tier === 'wide' ? null : block('line')}
        </div>
        <div className={styles['ratingBox']}>
          <span className={styles['caption']}>Рейтинг</span>
          {result.player.rating === null ? (
            <span className={styles['caption']}>нет данных</span>
          ) : (
            <Rating large value={result.player.rating} />
          )}
        </div>
      </div>

      {result.decks.length === 0 ? (
        <State headingLevel={3} icon="layers" title="Колоды не найдены">
          Профиль игрока получен без колод.
        </State>
      ) : (
        <>
          <DeckTabs
            count={result.decks.length}
            onSelect={(index) => setSelection({ resultId: result.id, index })}
            selected={deckIndex}
          />
          <div className={styles['decksRow']}>
            <DeckView
              deckIndex={deckIndex}
              key={`${result.id}:${deckIndex}`}
              result={result}
            />
            {tier === 'wide' ? (
              <div className={styles['h2hCol']}>{block('panel')}</div>
            ) : null}
          </div>
        </>
      )}

      <footer className={styles['foot']}>
        <span className={styles['caption']}>
          {result.searchedNickname === null ? '' : `Искали: «${result.searchedNickname}»`}
        </span>
        <Button
          onClick={() =>
            void Promise.resolve(window.crTools.showWidget()).catch(() => undefined)
          }
        >
          <Icon name="external" size={14} />
          Оверлей
        </Button>
      </footer>

      {h2hOpen ? (
        <H2HDialog
          onClose={() => setH2hOpen(false)}
          onLinkAccount={linkAccount}
          onRetry={h2h.retry}
          state={h2h.state}
          title={`Личные встречи с ${result.player.name}`}
        />
      ) : null}
    </div>
  )
}

/** Everything except a found player: calm explanations, one action at most. */
function NotFoundBody({
  result,
  retry,
}: {
  result: Exclude<MonitorResult, { kind: 'player_found' }>
  retry: { onRetry: () => void; pending: boolean } | null
}): React.JSX.Element {
  const { openProfiles } = useShellActions()
  const auth = useAuth()
  const nickname = result.searchedNickname
  switch (result.kind) {
    case 'player_not_found':
      return (
        <State
          icon="search"
          meta={nickname === null ? undefined : `Прочитано: «${nickname}»`}
          title="Игрока нет в базе"
        >
          Такого игрока не нашли. Если ник прочитан с ошибкой, в следующем бою всё
          получится.
        </State>
      )
    case 'recognition_failed':
      return (
        <State
          actions={
            <Button onClick={openProfiles} variant="ghost">
              Перенастроить профиль
            </Button>
          }
          icon="scan"
          meta={result.message}
          title="Не удалось прочитать ник"
          tone="warn"
        >
          В следующем бою попробуем снова. Если повторяется, перенастройте профиль.
        </State>
      )
    case 'service_error':
      if (result.authBlocked)
        return (
          <State
            actions={
              <Button onClick={() => void auth.logout()} variant="primary">
                Войти заново
              </Button>
            }
            icon="user"
            title="Нужно войти в аккаунт"
            tone="warn"
          >
            Сервис поиска не принял вход. Войдите снова — поиск продолжится.
          </State>
        )
      return (
        <State
          actions={
            retry === null ? undefined : (
              <Button loading={retry.pending} onClick={retry.onRetry} variant="primary">
                <Icon name="refresh" size={14} />
                Повторить поиск
              </Button>
            )
          }
          icon="alert"
          meta={result.message}
          title="Сервис поиска временно недоступен"
          tone="danger"
        >
          {nickname === null
            ? 'Ник прочитан, но сервер не ответил.'
            : `Ник «${nickname}» прочитан, но сервер не ответил.`}
        </State>
      )
  }
}

export function ResultBody({
  result,
  retry,
}: {
  result: MonitorResult
  retry: { onRetry: () => void; pending: boolean } | null
}): React.JSX.Element {
  return result.kind === 'player_found' ? (
    <FoundBody key={result.id} result={result} />
  ) : (
    <NotFoundBody result={result} retry={retry} />
  )
}
