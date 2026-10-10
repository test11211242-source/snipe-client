import { Suspense, lazy, useEffect } from 'react'

import { Spinner, State, ToastProvider } from '../ui'
import { useAppData } from './appData'
import { AppDataProvider } from './AppDataProvider'
import { MainRoute } from './routes/MainRoute'
import { SettingsRoutes } from './routes/SettingsRoutes'
import { SetupRoute } from './routes/SetupRoute'
import { StreamRoutes } from './routes/StreamRoutes'
import { MAIN_ROUTE, requiresStreamer, useRouter, type AppRoute } from './router'
import { RouterProvider } from './RouterProvider'
import { AppFrame } from './shell/AppFrame'

// Temporary: pre-V2 screens (deleted in M6). Own chunk, own CSS, loaded on first use.
const LegacyHost = lazy(() => import('./routes/LegacyHost'))

function RouteView({ route }: { route: AppRoute }): React.JSX.Element {
  switch (route.name) {
    case 'main':
      return <MainRoute />
    case 'setup':
      return <SetupRoute intent={route.intent} />
    case 'stream':
      return <StreamRoutes section={route.section} />
    case 'settings':
      return <SettingsRoutes section={route.section} />
    case 'legacy':
      return (
        <Suspense fallback={<State icon="clock" title="Загружаем…" />}>
          <LegacyHost page={route.page} />
        </Suspense>
      )
  }
}

/** Routes with role gating: the streamer area redirects to Игра for everyone else. */
function Routes(): React.JSX.Element {
  const { route, navigate } = useRouter()
  const { role } = useAppData()
  const blocked = requiresStreamer(route) && !role.isStreamer
  useEffect(() => {
    if (blocked && !role.pending) navigate(MAIN_ROUTE)
  }, [blocked, role.pending, navigate])

  const effective = blocked ? MAIN_ROUTE : route
  const fullWindow = effective.name === 'setup'
  return (
    <AppFrame chrome={fullWindow ? 'none' : 'full'}>
      {blocked && role.pending ? (
        <Spinner label="Загружаем" />
      ) : (
        <RouteView route={effective} />
      )}
    </AppFrame>
  )
}

/** Main-window composition. `initialRoute` exists for tests and the component catalog. */
export function AppRoot({
  initialRoute,
}: {
  initialRoute?: AppRoute
}): React.JSX.Element {
  return (
    <ToastProvider>
      <AppDataProvider>
        <RouterProvider initial={initialRoute}>
          <Routes />
        </RouterProvider>
      </AppDataProvider>
    </ToastProvider>
  )
}
