import { useCallback, useMemo, useState } from 'react'

import type { UpdateView } from '../../../../shared/models/update'
import { usePolling, useResource, type Resource } from '../../app/useResource'

export type UpdateCommand = 'check' | 'download' | 'cancel' | 'install'

export interface UpdaterController extends Resource<UpdateView> {
  reload: () => Promise<void>
  /** The command currently in flight, if any. */
  busy: UpdateCommand | null
  actionError: string | null
  check: () => Promise<void>
  download: () => Promise<void>
  cancel: () => Promise<void>
  /** Verified shutdown + install; the app closes on success. */
  install: () => Promise<void>
}

const FAILURES: Record<UpdateCommand, string> = {
  check: 'Не удалось проверить обновления.',
  download: 'Не удалось начать загрузку обновления.',
  cancel: 'Не удалось отменить загрузку.',
  install: 'Не удалось запустить установку.',
}

/** One updater controller for the banner and settings (the updater has no push event). */
export function useUpdaterController(): UpdaterController {
  const resource = useResource<UpdateView>(
    'update',
    () => window.crTools.getUpdateView(),
    'Не удалось получить состояние обновлений.',
  )
  const { apply, reload: reloadResource, value } = resource
  const [busy, setBusy] = useState<UpdateCommand | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)

  usePolling(
    () => void reloadResource({ quiet: true }),
    () => {
      if (document.hidden) return 60_000
      const state = value?.state
      if (state === 'CHECKING' || state === 'DOWNLOADING') return 1_000
      if (state === 'AVAILABLE' || state === 'READY') return 10_000
      return 60_000
    },
  )

  const run = useCallback(
    async (command: UpdateCommand): Promise<void> => {
      const call = {
        check: () => window.crTools.checkForUpdate(),
        download: () => window.crTools.downloadUpdate(),
        cancel: () => window.crTools.cancelUpdate(),
        install: () => window.crTools.installUpdate(),
      }[command]
      setBusy(command)
      setActionError(null)
      try {
        apply(await call())
      } catch {
        setActionError(FAILURES[command])
        void reloadResource({ quiet: true })
      } finally {
        setBusy(null)
      }
    },
    [apply, reloadResource],
  )

  const reload = useCallback(() => reloadResource(), [reloadResource])
  const check = useCallback(() => run('check'), [run])
  const download = useCallback(() => run('download'), [run])
  const cancel = useCallback(() => run('cancel'), [run])
  const install = useCallback(() => run('install'), [run])
  return useMemo(
    () => ({ ...resource, reload, busy, actionError, check, download, cancel, install }),
    [resource, reload, busy, actionError, check, download, cancel, install],
  )
}
