import '../../styles/global.css'
import '../../styles/streamer.css'
import '../../styles/setup.css'
import { useRef } from 'react'

import { CapturePage } from '../../legacy/CapturePage'
import { HomePage } from '../../legacy/HomePage'
import { SettingsPage } from '../../legacy/SettingsPage'
import { StreamerPage } from '../../legacy/StreamerPage'
import { useAppBootstrap } from '../../legacy/useAppBootstrap'
import { SetupApp } from '../../setup/SetupApp'
import { useAppData } from '../appData'
import { useRouter, type LegacyPage } from '../router'

/**
 * Temporary host for pre-V2 screens that M3–M5 have not rebuilt yet. Loaded lazily, runs the
 * old bootstrap only while one of these screens is open, and is deleted in M6.
 * Old design tokens are scoped to `.legacy-host`, so they cannot leak into the new UI.
 */
export default function LegacyHost({ page }: { page: LegacyPage }): React.JSX.Element {
  const { navigate, back } = useRouter()
  const app = useAppData()
  const boot = useAppBootstrap()
  const { data } = boot
  // Refresh the new controllers after the old screens changed profiles or monitoring.
  const refreshed = useRef(false)
  const syncNewState = (): void => {
    refreshed.current = true
    void app.profiles.reload()
    void app.monitor.reload()
  }

  if (page === 'setup')
    return (
      <div className="legacy-host" style={{ height: '100%', overflow: 'auto' }}>
        <SetupApp
          onClose={() => {
            syncNewState()
            back()
          }}
        />
      </div>
    )

  return (
    <div className="legacy-host" style={{ height: '100%', overflow: 'auto' }}>
      <div className="page-stage shell-container" data-profile="dashboard">
        {page === 'home' ? (
          <HomePage
            auth={data.auth.value}
            captureStatus={data.capture.value}
            monitorView={data.monitor.value}
            onConfigure={() => navigate({ name: 'legacy', page: 'capture' })}
            onMonitorView={boot.setMonitor}
            onOpenWidget={() => void window.crTools.showWidget().then(boot.setWidget)}
            onCaptureStatus={boot.setCapture}
            onProfiles={boot.setProfiles}
            profiles={data.profiles.value}
          />
        ) : page === 'capture' ? (
          <CapturePage
            onMonitor={(view) => {
              boot.setMonitor(view)
              app.monitor.apply(view)
            }}
            onProfiles={(view) => {
              boot.setProfiles(view)
              syncNewState()
            }}
            onSetup={() => navigate({ name: 'legacy', page: 'setup' })}
            onStatus={boot.setCapture}
            profiles={data.profiles.value}
            status={data.capture.value}
          />
        ) : page === 'settings' ? (
          <SettingsPage
            appSettings={data.settings.value}
            onAppSettings={(view) => {
              boot.setSettings(view)
              void app.settings.reload()
            }}
            onStatus={boot.setWidget}
            onUpdateView={(view) => {
              boot.setUpdate(view)
              void app.update.reload()
            }}
            status={data.widget.value}
            updateView={data.update.value}
          />
        ) : (
          <StreamerPage
            auth={data.auth.value}
            onSetup={() => navigate({ name: 'legacy', page: 'setup' })}
          />
        )}
      </div>
    </div>
  )
}
