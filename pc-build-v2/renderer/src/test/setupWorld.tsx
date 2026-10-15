import { render } from '@testing-library/react'
import { vi } from 'vitest'

import { StartSetupPayloadSchema } from '../../../shared/contracts/capture-ipc'
import { AppRoot } from '../app/AppRoot'
import type { AppRoute } from '../app/router'
import { installBridge, type Bridge, type BridgeOptions } from './bridge'
import {
  createSetupFake,
  detectingView,
  PROFILE_ID,
  sessionView,
  sourcesFixture,
  type SetupFake,
  type SetupFakeOptions,
} from './setupFake'

export interface SetupWorld {
  bridge: Bridge
  fake: SetupFake
}

/**
 * Renders the app on `route` with a bridge whose setup capabilities follow main's rules:
 * `startCaptureSetup` creates a session, sources are listed and prepare successfully.
 */
export function mountSetup(
  route: AppRoute,
  options: BridgeOptions & { session?: SetupFakeOptions } = {},
): SetupWorld {
  const { session, ...bridgeOptions } = options
  const bridge = installBridge(bridgeOptions)
  const fake = createSetupFake(session)
  Object.assign(bridge.crTools.setup, fake.api)
  const sources = sourcesFixture()
  bridge.crTools.listCaptureSources.mockImplementation(() => Promise.resolve(sources))
  bridge.crTools.prepareCaptureSource.mockImplementation(
    ({ sourceKey, revision }: { sourceKey: string; revision: string }) =>
      Promise.resolve({
        ok: true,
        preparation: {
          sourceKey,
          revision,
          preparationId: '00000000-0000-4000-8000-0000000000b1',
        },
      }),
  )
  bridge.crTools.startCaptureSetup.mockImplementation((rawPayload: unknown) => {
    const { mode, profileId, profileName } = StartSetupPayloadSchema.parse(rawPayload)
    const target = { profileId: profileId ?? PROFILE_ID, profileName }
    fake.replace(mode === 'auto' ? detectingView(target) : sessionView(target))
    return Promise.resolve(fake.current())
  })
  render(<AppRoot initialRoute={route} />)
  return { bridge, fake }
}

/** jsdom has no layout: a 800×400 stage showing a 1000×500 frame fills it exactly. */
export function stubStageGeometry(): void {
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe = vi.fn()
      disconnect = vi.fn()
      unobserve = vi.fn()
    },
  )
  Object.defineProperty(URL, 'createObjectURL', {
    configurable: true,
    value: vi.fn(() => 'blob:setup-frame'),
  })
  Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: vi.fn() })
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(800)
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(400)
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
    x: 0,
    y: 0,
    top: 0,
    left: 0,
    right: 800,
    bottom: 400,
    width: 800,
    height: 400,
    toJSON: () => ({}),
  })
}
