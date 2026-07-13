import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import os from 'node:os'

import { app, clipboard, Notification, safeStorage, shell } from 'electron'

import { ApplicationController } from './application/application-controller'
import {
  SettingsRepository,
  nodeSettingsFileSystem,
} from './infrastructure/settings-repository'
import { StructuredLogger } from './infrastructure/structured-logger'
import { SecretStore, nodeSecretFileSystem } from './infrastructure/secret-store'
import { createProductionServerConfig } from './infrastructure/server-config'
import {
  CaptureConfigurationRepository,
  nodeCaptureConfigurationFileSystem,
} from './infrastructure/capture-configuration-repository'
import {
  MonitorPreferencesRepository,
  nodeMonitorPreferencesFileSystem,
} from './infrastructure/monitor-preferences-repository'
import { ApiClient, AuthenticatedApiClient } from './services/api-client'
import { AuthSession } from './services/auth-session'
import { CaptureService } from './services/capture-service'
import { CaptureSourceRegistry } from './services/capture-source-registry'
import { ElectronCaptureSourceProvider } from './services/electron-capture-source-provider'
import { PythonWorkerService } from './services/python-worker-service'
import { SetupSessionService } from './services/setup-session-service'
import {
  DevelopmentDeviceIdentityProvider,
  DeviceIdentityService,
  WindowsDeviceIdentityProvider,
} from './services/device-identity-service'
import { WebSocketSession } from './services/websocket-session'
import { CaptureTargetResolver } from './services/capture-target-resolver'
import { MonitorProcessService } from './services/monitor-process-service'
import { MonitorSupervisor } from './services/monitor-supervisor'
import { OcrApiClient } from './services/ocr-api-client'
import {
  WidgetSettingsRepository,
  nodeWidgetSettingsFileSystem,
} from './infrastructure/widget-settings-repository'
import { WidgetController } from './services/widget-controller'
import { ImageAssetService } from './services/image-asset-service'
import { WindowCoordinator } from './windows/window-coordinator'
import {
  PredictionPreferencesRepository,
  nodePredictionPreferencesFileSystem,
} from './infrastructure/prediction-preferences-repository'
import {
  PredictionResultConfigurationRepository,
  nodePredictionResultFileSystem,
} from './infrastructure/prediction-result-configuration-repository'
import { PredictionCoordinator } from './services/prediction-coordinator'
import { StreamerService } from './services/streamer-service'
import { nodeUpdateDependencies, UpdateService } from './services/update-service'
import { RuntimeIntegrityService } from './services/runtime-integrity-service'
import { AppSettingsController } from './services/app-settings-controller'
import { NotificationService } from './services/notification-service'
import { launchVerifiedInstaller } from './services/launch-verified-installer'
import { ReprocessedResultService } from './services/reprocessed-result-service'

app.setName('CR Tools V2')

const logger = new StructuredLogger()
const windows = new WindowCoordinator(logger)
const server = createProductionServerConfig()
const api = new ApiClient(server, globalThis.fetch, logger)
const identityProvider = import.meta.env.PROD
  ? new WindowsDeviceIdentityProvider()
  : new DevelopmentDeviceIdentityProvider({
      cpuProcessorId: null,
      cpuModel: os.cpus()[0]?.model ?? 'explicit-development-device',
      motherboardSerial: null,
      diskSerials: [],
      networkInterfaces: os.networkInterfaces(),
      platform: `dev-${os.platform()}`,
      arch: os.arch(),
      release: os.release(),
    })
const identity = new DeviceIdentityService(identityProvider)
const secrets = new SecretStore(
  join(app.getPath('userData'), 'auth.v1.enc.json'),
  safeStorage,
  nodeSecretFileSystem,
)
const auth = new AuthSession(api, secrets, identity)
const authenticatedApi = new AuthenticatedApiClient(api, auth)
const realtime = new WebSocketSession(server.webSocketUrl, auth, logger)
const settingsRepository = new SettingsRepository(
  join(app.getPath('userData'), 'settings.v1.json'),
  logger,
  nodeSettingsFileSystem,
)
const settings = new AppSettingsController(settingsRepository, app, logger)
const captureConfigurations = new CaptureConfigurationRepository(
  join(app.getPath('userData'), 'capture-config.v1'),
  nodeCaptureConfigurationFileSystem,
)
const pythonRoot = import.meta.env.PROD
  ? join(process.resourcesPath, 'python')
  : join(process.cwd(), 'python')
const pythonExecutable = import.meta.env.PROD
  ? join(process.resourcesPath, 'python-runtime', 'python.exe')
  : (process.env['CR_TOOLS_PYTHON_PATH'] ??
    (process.platform === 'win32' ? 'python.exe' : 'python3'))
const runtimeIntegrity = import.meta.env.PROD
  ? new RuntimeIntegrityService(
      join(process.resourcesPath, 'python-runtime'),
      join(process.resourcesPath, 'runtime-integrity.json'),
    )
  : null
const verifyRuntime = (): Promise<void> => runtimeIntegrity?.verify() ?? Promise.resolve()
const worker = new PythonWorkerService(undefined, undefined, undefined, verifyRuntime)
const capture = new CaptureService(
  worker,
  pythonExecutable,
  join(pythonRoot, 'capture_once.py'),
  join(pythonRoot, 'analyze_trigger.py'),
)
const captureSources = new CaptureSourceRegistry(new ElectronCaptureSourceProvider())
const monitorPreferences = new MonitorPreferencesRepository(
  join(app.getPath('userData'), 'monitor-preferences.v1'),
  nodeMonitorPreferencesFileSystem,
)
const targetResolver = new CaptureTargetResolver(
  auth,
  captureConfigurations,
  captureSources,
)
const predictionResults = new PredictionResultConfigurationRepository(
  join(app.getPath('userData'), 'prediction-result-config.v1'),
  nodePredictionResultFileSystem,
)
const setup = new SetupSessionService(
  capture,
  captureConfigurations,
  api,
  auth,
  () => new Date(),
  predictionResults,
  authenticatedApi,
  targetResolver,
)
const monitorProcess = new MonitorProcessService(
  pythonExecutable,
  join(pythonRoot, 'monitor_engine.py'),
  logger,
  undefined,
  undefined,
  undefined,
  verifyRuntime,
)
const ocr = new OcrApiClient(globalThis.fetch, auth, server, logger)
const monitor = new MonitorSupervisor(
  auth,
  captureConfigurations,
  monitorPreferences,
  targetResolver,
  monitorProcess,
  ocr,
)
const predictionPreferences = new PredictionPreferencesRepository(
  join(app.getPath('userData'), 'prediction-preferences.v1'),
  nodePredictionPreferencesFileSystem,
)
const predictions = new PredictionCoordinator(
  auth,
  authenticatedApi,
  predictionResults,
  monitor,
)
const streamer = new StreamerService(
  auth,
  authenticatedApi,
  predictionPreferences,
  predictionResults,
  captureConfigurations,
  monitor,
  predictions,
  shell,
  clipboard,
)
const widgetSettings = new WidgetSettingsRepository(
  join(app.getPath('userData'), 'widget-settings.v1'),
  nodeWidgetSettingsFileSystem,
)
const widget = new WidgetController(monitor, widgetSettings, windows)
const images = new ImageAssetService(monitor, globalThis.fetch)
const notifications = new NotificationService(
  monitor,
  () => Notification.isSupported(),
  (options) => new Notification(options),
)
const reprocessedResults = new ReprocessedResultService(realtime, auth, monitor)
const updatePublicKey = readFileSync(
  import.meta.env.PROD
    ? join(process.resourcesPath, 'update-public-key.pem')
    : join(process.cwd(), 'resources', 'update-public-key.pem'),
  'utf8',
)
let requestApplicationShutdown = (): Promise<void> =>
  Promise.reject(new Error('Application controller is not ready'))
const updater = new UpdateService({
  fetch: globalThis.fetch,
  ...nodeUpdateDependencies,
  launchVerifiedInstaller,
  requestShutdown: () => requestApplicationShutdown(),
  currentVersion: () => app.getVersion(),
  userDataPath: () => app.getPath('userData'),
  isPackaged: () => app.isPackaged,
  platform: () => process.platform,
  publicKey: updatePublicKey,
})
const application = new ApplicationController(
  app,
  windows,
  settings,
  logger,
  auth,
  realtime,
  captureSources,
  setup,
  monitor,
  widget,
  images,
  notifications,
  reprocessedResults,
  streamer,
  updater,
)
requestApplicationShutdown = () => application.requestShutdown()

void application.start().catch((error: unknown) => {
  logger.error('Application startup failed', { error })
  void application.requestShutdown()
})
