/// <reference types="vite/client" />

import type {
  CrToolsApi,
  CrToolsAuthApi,
  CrToolsWidgetApi,
} from '../../shared/contracts/preload'

declare global {
  interface Window {
    crTools: CrToolsApi
    crToolsAuth: CrToolsAuthApi
    crToolsWidget: CrToolsWidgetApi
  }
}

export {}
