/// <reference types="vite/client" />

import type {
  CrToolsApi,
  CrToolsAuthApi,
  CrToolsSetupApi,
  CrToolsWidgetApi,
} from '../../shared/contracts/preload'

declare global {
  interface Window {
    crTools: CrToolsApi
    crToolsAuth: CrToolsAuthApi
    crToolsSetup: CrToolsSetupApi
    crToolsWidget: CrToolsWidgetApi
  }
}

export {}
