import { useMemo } from 'react'

import { MAX_STREAMER_ACCOUNTS } from '../../../../shared/models/streamer'
import { useRouter } from '../../app/router'
import { useShellActions } from '../../app/shell/slotsContext'
import type { Requirement } from '../../ui'
import { useMonitorView } from '../monitor'
import { useProfiles } from '../profiles'
import { useStreamer } from './streamerContext'

export type FoundationId = 'twitch' | 'accounts' | 'profile' | 'zones' | 'monitoring'
export type FeatureId = 'predictions' | 'title' | 'chat' | 'widgets'

/** A requirement plus the one place that owns it ("Управлять"). */
export interface FoundationItem extends Requirement {
  home: () => void
}

const FEATURE_NEEDS: Record<FeatureId, readonly FoundationId[]> = {
  predictions: ['twitch', 'profile', 'zones', 'monitoring'],
  title: ['twitch', 'accounts'],
  chat: ['twitch', 'monitoring'],
  widgets: ['accounts'],
}

/**
 * Foundations (Twitch, accounts, profile, result zones, monitoring) from the main-process
 * readiness. A `null` readiness section means "could not check" and is never shown as
 * "not connected". Each item links to its single owning page.
 */
export function useFoundations(): Record<FoundationId, FoundationItem> {
  const { readiness, view, reload } = useStreamer()
  const { navigate } = useRouter()
  const { openProfiles } = useShellActions()
  const monitor = useMonitorView()
  const profiles = useProfiles()
  const profileName =
    profiles.value?.profiles.find((profile) => profile.isActive)?.profileName ?? null

  return useMemo(() => {
    const unknown = (
      id: FoundationId,
      name: string,
      home: () => void,
    ): FoundationItem => ({
      id,
      name,
      state: 'не удалось проверить',
      ok: false,
      action: { label: 'Проверить снова', onAction: () => void reload() },
      home,
    })
    const goTwitch = (): void => navigate({ name: 'stream', section: 'twitch' })
    const goAccounts = (): void => navigate({ name: 'settings', section: 'accounts' })

    const twitchOk = readiness?.twitchConnected
    const twitch: FoundationItem =
      twitchOk === undefined || twitchOk === null
        ? unknown('twitch', 'Twitch', goTwitch)
        : {
            id: 'twitch',
            name: 'Twitch',
            state: twitchOk
              ? view?.twitch.username != null
                ? `@${view.twitch.username}`
                : 'подключён'
              : 'не подключён',
            ok: twitchOk,
            action: { label: 'Подключить', onAction: goTwitch },
            home: goTwitch,
          }

    const count = readiness?.accountsCount
    const accounts: FoundationItem =
      count === undefined || count === null
        ? unknown('accounts', 'Аккаунты Clash Royale', goAccounts)
        : {
            id: 'accounts',
            name: 'Аккаунты Clash Royale',
            state: count > 0 ? `${count} из ${MAX_STREAMER_ACCOUNTS}` : 'нет ни одного',
            ok: count > 0,
            action: { label: 'Добавить', onAction: goAccounts },
            home: goAccounts,
          }

    const configured = readiness?.captureConfigured
    const profile: FoundationItem =
      configured === undefined || configured === null
        ? unknown('profile', 'Профиль мониторинга', openProfiles)
        : {
            id: 'profile',
            name: 'Профиль мониторинга',
            state: configured ? (profileName ?? 'настроен') : 'не настроен',
            ok: configured,
            action: configured
              ? { label: 'Профили', onAction: openProfiles }
              : {
                  label: 'Создать профиль',
                  onAction: () => navigate({ name: 'setup' }),
                },
            home: openProfiles,
          }

    const zonesOk = readiness?.resultZonesConfigured
    const zones: FoundationItem =
      zonesOk === undefined || zonesOk === null
        ? unknown('zones', 'Зоны результата', openProfiles)
        : {
            id: 'zones',
            name: 'Зоны результата',
            state: zonesOk ? 'настроены' : 'не настроены в профиле',
            ok: zonesOk,
            action: { label: 'Настроить в профиле', onAction: openProfiles },
            home: openProfiles,
          }

    const running = readiness?.monitoring
    const monitoring: FoundationItem =
      running === undefined || running === null
        ? unknown('monitoring', 'Мониторинг', () => undefined)
        : {
            id: 'monitoring',
            name: 'Мониторинг',
            state: running ? 'идёт' : 'не запущен',
            ok: running,
            action: {
              label: 'Запустить',
              onAction: () => void monitor.start(),
            },
            home: () => navigate({ name: 'main' }),
          }

    return { twitch, accounts, profile, zones, monitoring }
  }, [readiness, view, profileName, navigate, openProfiles, monitor, reload])
}

/** «Нужно для работы» of one feature page. */
export function useRequirements(feature: FeatureId): Requirement[] {
  const foundations = useFoundations()
  return useMemo(
    () =>
      FEATURE_NEEDS[feature].map((id) => {
        const { name, state, ok, action } = foundations[id]
        return action === undefined
          ? { id, name, state, ok }
          : { id, name, state, ok, action }
      }),
    [feature, foundations],
  )
}

/** Foundation ids a feature is blocked on (empty when it can run). */
export function missingFor(
  feature: FeatureId,
  foundations: Record<FoundationId, FoundationItem>,
): FoundationItem[] {
  return FEATURE_NEEDS[feature].map((id) => foundations[id]).filter((item) => !item.ok)
}
