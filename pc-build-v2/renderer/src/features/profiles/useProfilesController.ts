import { useCallback, useMemo, useRef, useState } from 'react'

import type { CaptureProfileCommandResult } from '../../../../shared/contracts/capture-ipc'
import type { CaptureProfilesView } from '../../../../shared/models/capture'
import type { MonitorView } from '../../../../shared/models/monitor'
import { useResource, type Resource } from '../../app/useResource'
import { profileErrorMessage } from './errors'

const acceptsProfiles = (next: CaptureProfilesView, current: CaptureProfilesView) =>
  current.revision === null ||
  (next.revision !== null && next.revision >= current.revision)

/** Outcome of a profile command: the new collection, or the Russian reason it failed. */
export type ProfileOutcome =
  { ok: true; profiles: CaptureProfilesView } | { ok: false; message: string }

export interface ProfilesController extends Resource<CaptureProfilesView> {
  reload: () => Promise<void>
  /** A profile command is in flight; commands are serialized. */
  pending: boolean
  /** Failure of the last activation (other commands report through their outcome). */
  actionError: string | null
  clearActionError: () => void
  /** Makes a profile active (collection-revision fenced). */
  activate: (profileId: string) => Promise<boolean>
  rename: (profileId: string, profileName: string) => Promise<ProfileOutcome>
  duplicate: (profileId: string, profileName: string) => Promise<ProfileOutcome>
  remove: (profileId: string) => Promise<ProfileOutcome>
  /** Binds the profile to an already prepared source (`preparationId` from the picker). */
  rebind: (profileId: string, preparationId: string) => Promise<ProfileOutcome>
}

/**
 * Capture profile list. Every command carries the collection revision it was issued
 * against; main rejects it when the collection changed. Commands return the whole new
 * view plus a fresh monitor view, and the monitor part is forwarded to `onMonitor` so both
 * stay consistent. After a failure the list is reloaded quietly, so the next attempt
 * uses the current revision.
 */
export function useProfilesController(
  onMonitor: (view: MonitorView) => void,
): ProfilesController {
  const resource = useResource<CaptureProfilesView>(
    'profiles',
    () => window.crTools.getCaptureProfiles(),
    'Не удалось получить список профилей.',
    acceptsProfiles,
  )
  const { apply, reload: reloadResource, latest } = resource
  const [pending, setPending] = useState(false)
  const [actionError, setActionError] = useState<string | null>(null)
  const busy = useRef(false)

  const mutate = useCallback(
    async (
      call: (revision: number) => Promise<CaptureProfileCommandResult>,
      fallback: string,
    ): Promise<ProfileOutcome> => {
      const revision = latest()?.revision ?? null
      if (revision === null)
        return { ok: false, message: 'Список профилей ещё не загружен.' }
      if (busy.current)
        return { ok: false, message: 'Дождитесь завершения предыдущего действия.' }
      busy.current = true
      setPending(true)
      try {
        const result = await call(revision)
        if (!result.ok) {
          void reloadResource({ quiet: true })
          return { ok: false, message: profileErrorMessage(result.error.code, fallback) }
        }
        apply(result.profiles)
        onMonitor(result.monitor)
        return { ok: true, profiles: result.profiles }
      } catch {
        void reloadResource({ quiet: true })
        return { ok: false, message: fallback }
      } finally {
        busy.current = false
        setPending(false)
      }
    },
    [apply, onMonitor, reloadResource, latest],
  )

  const activate = useCallback(
    async (profileId: string): Promise<boolean> => {
      setActionError(null)
      const outcome = await mutate(
        (expectedRevision) =>
          window.crTools.activateCaptureProfile({ profileId, expectedRevision }),
        'Не удалось переключить профиль. Список обновлён.',
      )
      if (!outcome.ok) setActionError(outcome.message)
      return outcome.ok
    },
    [mutate],
  )

  const rename = useCallback(
    (profileId: string, profileName: string) =>
      mutate(
        (expectedRevision) =>
          window.crTools.renameCaptureProfile({
            profileId,
            profileName,
            expectedRevision,
          }),
        'Не удалось переименовать профиль. Название должно быть уникальным.',
      ),
    [mutate],
  )
  const duplicate = useCallback(
    (profileId: string, profileName: string) =>
      mutate(
        (expectedRevision) =>
          window.crTools.duplicateCaptureProfile({
            profileId,
            profileName,
            expectedRevision,
          }),
        'Не удалось дублировать профиль. Проверьте название и повторите.',
      ),
    [mutate],
  )
  const remove = useCallback(
    (profileId: string) =>
      mutate(
        (expectedRevision) =>
          window.crTools.deleteCaptureProfile({ profileId, expectedRevision }),
        'Не удалось удалить профиль. Список обновлён.',
      ),
    [mutate],
  )
  const rebind = useCallback(
    (profileId: string, preparationId: string) =>
      mutate(
        (expectedRevision) =>
          window.crTools.rebindCaptureProfile({
            profileId,
            preparationId,
            expectedRevision,
          }),
        'Не удалось применить источник. Выберите его повторно; если профиль изменён в другом окне, обновите список.',
      ),
    [mutate],
  )

  const reload = useCallback(() => reloadResource(), [reloadResource])
  const clearActionError = useCallback(() => setActionError(null), [])

  return useMemo(
    () => ({
      ...resource,
      reload,
      pending,
      actionError,
      clearActionError,
      activate,
      rename,
      duplicate,
      remove,
      rebind,
    }),
    [
      resource,
      reload,
      pending,
      actionError,
      clearActionError,
      activate,
      rename,
      duplicate,
      remove,
      rebind,
    ],
  )
}
