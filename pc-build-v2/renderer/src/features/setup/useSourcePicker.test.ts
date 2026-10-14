// @vitest-environment jsdom
import { cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { CaptureSourceSnapshot } from '../../../../shared/models/capture'
import { installBridge } from '../../test/bridge'
import { sourcesFixture } from '../../test/setupFake'
import { useSourcePicker } from './useSourcePicker'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

function withPreviews(
  snapshot: CaptureSourceSnapshot,
  count: number,
  previewsPending: boolean,
): CaptureSourceSnapshot {
  return {
    ...snapshot,
    previewsPending,
    sources: snapshot.sources.map((source, index) =>
      index < count
        ? {
            ...source,
            preview: {
              size: { width: 2, height: 1 },
              dataUrl: 'data:image/jpeg;base64,AA==',
            },
          }
        : source,
    ),
  }
}

describe('useSourcePicker previews', () => {
  it('shows the list first and fills previews in while main reports more pending', async () => {
    const bridge = installBridge()
    const sources = sourcesFixture()
    bridge.crTools.listCaptureSources.mockResolvedValue(sources)
    const second = Promise.withResolvers<CaptureSourceSnapshot>()
    bridge.crTools.loadCapturePreviews
      .mockResolvedValueOnce(withPreviews(sources, 1, true))
      .mockImplementationOnce(() => second.promise)

    const { result } = renderHook(useSourcePicker)
    await waitFor(() => expect(result.current.loading).toBe(false))
    await waitFor(() => expect(result.current.sources[0]?.preview).not.toBeNull())
    expect(result.current.sources[1]?.preview).toBeNull()

    second.resolve(withPreviews(sources, 3, false))
    await waitFor(() => expect(result.current.sources[1]?.preview).not.toBeNull())
    expect(bridge.crTools.loadCapturePreviews).toHaveBeenCalledTimes(2)
    expect(bridge.crTools.loadCapturePreviews).toHaveBeenCalledWith({
      revision: sources.revision,
    })
  })
})
