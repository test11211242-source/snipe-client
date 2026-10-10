import '../../styles/global.css'
import '../../styles/streamer.css'

import { HomePage } from '../../legacy/HomePage'
import { SettingsPage } from '../../legacy/SettingsPage'
import { StreamerPage } from '../../legacy/StreamerPage'
import { useAppBootstrap } from '../../legacy/useAppBootstrap'
import { useAppData } from '../appData'
import { useRouter, type LegacyPage } from '../router'

/**
 * Temporary host for pre-V2 screens that M5 has not rebuilt yet. Loaded lazily, runs the
 * old bootstrap only while one of these screens is open, and is deleted in M6.
 * Old design tokens are scoped to `.legacy-host`, so they cannot leak into the new UI.
 */
export default function LegacyHost({ page }: { page: LegacyPage }): React.JSX.Element {
  const { navigate } = useRouter()
  const app = useAppData()
  const boot = useAppBootstrap()
  const { data } = boot

  return (
    <div className="legacy-host" style={{ height: '100%', overflow: 'auto' }}>
      <div className="page-stage shell-container" data-profile="dashboard">
        {page === 'home' ? (
          <HomePage
            auth={data.auth.value}
            captureStatus={data.capture.value}
            monitorView={data.monitor.value}
            onConfigure={() => navigate({ name: 'setup' })}
            onMonitorView={boot.setMonitor}
            onOpenWidget={() => void window.crTools.showWidget().then(boot.setWidget)}
            onCaptureStatus={boot.setCapture}
            onProfiles={boot.setProfiles}
            profiles={data.profiles.value}
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
            onSetup={() => navigate({ name: 'setup', intent: { kind: 'resume' } })}
          />
        )}
      </div>
    </div>
  )
}
