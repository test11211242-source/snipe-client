import { useEffect, useRef, useState, type Dispatch, type SetStateAction } from 'react'

import type { AppSettingsView, HelloResult } from '../../../shared/contracts/app'
import type { AppSnapshot } from '../../../shared/models/application'
import type { AuthView } from '../../../shared/models/auth'
import type { CaptureProfilesView, CaptureStatus } from '../../../shared/models/capture'
import type { MonitorView } from '../../../shared/models/monitor'
import type { RealtimeStatus } from '../../../shared/models/network'
import type { UpdateView } from '../../../shared/models/update'
import type { WidgetStatus } from '../../../shared/models/widget'

export type ResourceState = 'loading' | 'ready' | 'error'

export interface Resource<T> {
  value: T | null
  state: ResourceState
  error: string | null
}

export interface BootstrapData {
  protocol: Resource<HelloResult>
  snapshot: Resource<AppSnapshot>
  auth: Resource<AuthView>
  realtime: Resource<RealtimeStatus>
  capture: Resource<CaptureStatus>
  profiles: Resource<CaptureProfilesView>
  monitor: Resource<MonitorView>
  widget: Resource<WidgetStatus>
  settings: Resource<AppSettingsView>
  update: Resource<UpdateView>
}

const initialResource = <T>(): Resource<T> => ({
  value: null,
  state: 'loading',
  error: null,
})

function beginLoading<T>(setter: Dispatch<SetStateAction<Resource<T>>>): void {
  setter((current) => ({ ...current, state: 'loading', error: null }))
}

function loadResource<T>(
  request: Promise<T>,
  setter: Dispatch<SetStateAction<Resource<T>>>,
  active: () => boolean,
  error = 'Не удалось получить данные.',
): Promise<void> {
  return request.then(
    (value) => {
      if (active()) setter({ value, state: 'ready', error: null })
    },
    () => {
      if (active()) {
        setter((current) => ({
          ...current,
          state: 'error',
          error,
        }))
      }
    },
  )
}

function applySettlement<T>(
  result: PromiseSettledResult<T>,
  setter: Dispatch<SetStateAction<Resource<T>>>,
): void {
  if (result.status === 'fulfilled') {
    setter({ value: result.value, state: 'ready', error: null })
  } else {
    setter((current) => ({
      ...current,
      state: 'error',
      error: 'Не удалось получить данные.',
    }))
  }
}

export function useAppBootstrap(): {
  data: BootstrapData
  retry: () => void
  setSnapshot: (value: AppSnapshot) => void
  setAuth: (value: AuthView) => void
  setRealtime: (value: RealtimeStatus) => void
  setCapture: (value: CaptureStatus) => void
  setProfiles: (value: CaptureProfilesView) => void
  setMonitor: (value: MonitorView) => void
  setWidget: (value: WidgetStatus) => void
  setSettings: (value: AppSettingsView) => void
  setUpdate: (value: UpdateView) => void
} {
  const [protocol, setProtocolResource] = useState<Resource<HelloResult>>(initialResource)
  const [snapshot, setSnapshotResource] = useState<Resource<AppSnapshot>>(initialResource)
  const [auth, setAuthResource] = useState<Resource<AuthView>>(initialResource)
  const [realtime, setRealtimeResource] =
    useState<Resource<RealtimeStatus>>(initialResource)
  const [capture, setCaptureResource] = useState<Resource<CaptureStatus>>(initialResource)
  const [profiles, setProfilesResource] =
    useState<Resource<CaptureProfilesView>>(initialResource)
  const [monitor, setMonitorResource] = useState<Resource<MonitorView>>(initialResource)
  const [widget, setWidgetResource] = useState<Resource<WidgetStatus>>(initialResource)
  const [settings, setSettingsResource] =
    useState<Resource<AppSettingsView>>(initialResource)
  const [update, setUpdateResource] = useState<Resource<UpdateView>>(initialResource)
  const [attempt, setAttempt] = useState(0)
  const monitorStateRef = useRef<MonitorView['state'] | null>(null)
  const updateStateRef = useRef<UpdateView['state'] | null>(null)
  const captureGenerationRef = useRef(0)
  const profilesGenerationRef = useRef(0)
  const monitorGenerationRef = useRef(0)
  const updateGenerationRef = useRef(0)
  const restartMonitorPollingRef = useRef<() => void>(() => undefined)
  const restartUpdatePollingRef = useRef<() => void>(() => undefined)

  useEffect(() => {
    let active = true
    const isActive = (): boolean => active
    const captureGeneration = ++captureGenerationRef.current
    const profilesGeneration = ++profilesGenerationRef.current
    const monitorGeneration = ++monitorGenerationRef.current
    const updateGeneration = ++updateGenerationRef.current

    beginLoading(setProtocolResource)
    beginLoading(setSnapshotResource)
    beginLoading(setAuthResource)
    beginLoading(setRealtimeResource)
    beginLoading(setCaptureResource)
    beginLoading(setProfilesResource)
    beginLoading(setMonitorResource)
    beginLoading(setWidgetResource)
    beginLoading(setSettingsResource)
    beginLoading(setUpdateResource)

    void Promise.allSettled([
      loadResource(
        window.crTools.hello(),
        setProtocolResource,
        isActive,
        'Не удалось подтвердить совместимость приложения.',
      ),
      loadResource(window.crTools.getAppSnapshot(), setSnapshotResource, isActive),
      loadResource(window.crTools.getAuthView(), setAuthResource, isActive),
      loadResource(window.crTools.getRealtimeStatus(), setRealtimeResource, isActive),
      loadResource(
        window.crTools.getCaptureStatus(),
        setCaptureResource,
        () => active && captureGeneration === captureGenerationRef.current,
      ),
      loadResource(
        window.crTools.getCaptureProfiles(),
        setProfilesResource,
        () => active && profilesGeneration === profilesGenerationRef.current,
      ),
      loadResource(
        window.crTools.getMonitorView().then((value) => {
          if (active && monitorGeneration === monitorGenerationRef.current) {
            monitorStateRef.current = value.state
            restartMonitorPollingRef.current()
          }
          return value
        }),
        setMonitorResource,
        () => active && monitorGeneration === monitorGenerationRef.current,
      ),
      loadResource(window.crTools.getWidgetStatus(), setWidgetResource, isActive),
      loadResource(window.crTools.getAppSettings(), setSettingsResource, isActive),
      loadResource(
        window.crTools.getUpdateView().then((value) => {
          if (active && updateGeneration === updateGenerationRef.current) {
            updateStateRef.current = value.state
            restartUpdatePollingRef.current()
          }
          return value
        }),
        setUpdateResource,
        () => active && updateGeneration === updateGenerationRef.current,
      ),
    ])

    return () => {
      active = false
    }
  }, [attempt])

  useEffect(() => {
    let active = true
    let inFlight = false
    let restartPending = false
    let generation = 0
    let timer: number | undefined

    const nextDelay = (): number => {
      const monitorIsActive = ['PREFLIGHT', 'STARTING', 'READY', 'STOPPING'].includes(
        monitorStateRef.current ?? '',
      )
      return document.hidden ? 15_000 : monitorIsActive ? 1_500 : 5_000
    }

    const schedule = (delay: number): void => {
      if (!active) return
      if (timer !== undefined) window.clearTimeout(timer)
      timer = window.setTimeout(() => void poll(), delay)
    }

    const restart = (): void => {
      if (!active) return
      generation += 1
      if (inFlight) {
        restartPending = true
        return
      }
      schedule(document.hidden ? nextDelay() : 0)
    }

    const poll = async (): Promise<void> => {
      if (inFlight) return
      inFlight = true
      const pollGeneration = generation
      const captureGeneration = ++captureGenerationRef.current
      const profilesGeneration = ++profilesGenerationRef.current
      const monitorGeneration = ++monitorGenerationRef.current
      const [nextRealtime, nextCapture, nextProfiles, nextMonitor] =
        await Promise.allSettled([
          window.crTools.getRealtimeStatus(),
          window.crTools.getCaptureStatus(),
          window.crTools.getCaptureProfiles(),
          window.crTools.getMonitorView(),
        ])
      if (active) {
        if (pollGeneration === generation) {
          applySettlement(nextRealtime, setRealtimeResource)
          if (captureGeneration === captureGenerationRef.current) {
            applySettlement(nextCapture, setCaptureResource)
          }
          if (profilesGeneration === profilesGenerationRef.current) {
            applySettlement(nextProfiles, setProfilesResource)
          }
          if (monitorGeneration === monitorGenerationRef.current) {
            applySettlement(nextMonitor, setMonitorResource)
          }
          if (
            monitorGeneration === monitorGenerationRef.current &&
            nextMonitor.status === 'fulfilled'
          ) {
            monitorStateRef.current = nextMonitor.value.state
          }
        }
      }
      inFlight = false
      if (!active) return
      if (restartPending) {
        restartPending = false
        restart()
      } else {
        schedule(nextDelay())
      }
    }

    restartMonitorPollingRef.current = restart
    const onVisibilityChange = (): void => restart()
    document.addEventListener('visibilitychange', onVisibilityChange)
    schedule(2_000)
    return () => {
      active = false
      document.removeEventListener('visibilitychange', onVisibilityChange)
      restartMonitorPollingRef.current = () => undefined
      if (timer !== undefined) window.clearTimeout(timer)
    }
  }, [])

  useEffect(() => {
    let active = true
    let inFlight = false
    let restartPending = false
    let generation = 0
    let timer: number | undefined

    const nextDelay = (): number => {
      const state = updateStateRef.current
      const activeUpdate = state === 'CHECKING' || state === 'DOWNLOADING'
      const availableUpdate = state === 'AVAILABLE' || state === 'READY'
      return document.hidden
        ? 60_000
        : activeUpdate
          ? 1_000
          : availableUpdate
            ? 10_000
            : 60_000
    }

    const schedule = (delay: number): void => {
      if (!active) return
      if (timer !== undefined) window.clearTimeout(timer)
      timer = window.setTimeout(() => void poll(), delay)
    }

    const restart = (): void => {
      if (!active) return
      generation += 1
      if (inFlight) {
        restartPending = true
        return
      }
      schedule(document.hidden ? nextDelay() : 0)
    }

    const poll = async (): Promise<void> => {
      if (inFlight) return
      inFlight = true
      const pollGeneration = generation
      const updateGeneration = ++updateGenerationRef.current
      const nextUpdate = await Promise.allSettled([window.crTools.getUpdateView()])
      const result = nextUpdate[0]
      if (
        active &&
        pollGeneration === generation &&
        updateGeneration === updateGenerationRef.current
      ) {
        applySettlement(result, setUpdateResource)
        if (result.status === 'fulfilled') updateStateRef.current = result.value.state
      }
      inFlight = false
      if (!active) return
      if (restartPending) {
        restartPending = false
        restart()
      } else {
        schedule(nextDelay())
      }
    }

    restartUpdatePollingRef.current = restart
    const onVisibilityChange = (): void => restart()
    document.addEventListener('visibilitychange', onVisibilityChange)
    schedule(10_000)
    return () => {
      active = false
      document.removeEventListener('visibilitychange', onVisibilityChange)
      restartUpdatePollingRef.current = () => undefined
      if (timer !== undefined) window.clearTimeout(timer)
    }
  }, [])

  const ready = <T>(setter: Dispatch<SetStateAction<Resource<T>>>, value: T): void => {
    setter({ value, state: 'ready', error: null })
  }

  return {
    data: {
      protocol,
      snapshot,
      auth,
      realtime,
      capture,
      profiles,
      monitor,
      widget,
      settings,
      update,
    },
    retry: () => {
      captureGenerationRef.current += 1
      profilesGenerationRef.current += 1
      monitorGenerationRef.current += 1
      updateGenerationRef.current += 1
      restartMonitorPollingRef.current()
      restartUpdatePollingRef.current()
      setAttempt((current) => current + 1)
    },
    setSnapshot: (value) => ready(setSnapshotResource, value),
    setAuth: (value) => ready(setAuthResource, value),
    setRealtime: (value) => ready(setRealtimeResource, value),
    setCapture: (value) => {
      captureGenerationRef.current += 1
      ready(setCaptureResource, value)
      restartMonitorPollingRef.current()
    },
    setProfiles: (value) => {
      profilesGenerationRef.current += 1
      ready(setProfilesResource, value)
      restartMonitorPollingRef.current()
    },
    setMonitor: (value) => {
      monitorGenerationRef.current += 1
      monitorStateRef.current = value.state
      ready(setMonitorResource, value)
      restartMonitorPollingRef.current()
    },
    setWidget: (value) => ready(setWidgetResource, value),
    setSettings: (value) => ready(setSettingsResource, value),
    setUpdate: (value) => {
      updateGenerationRef.current += 1
      updateStateRef.current = value.state
      ready(setUpdateResource, value)
      restartUpdatePollingRef.current()
    },
  }
}
