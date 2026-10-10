// @vitest-environment jsdom

import { act, renderHook } from '@testing-library/react'
import { StrictMode, type ReactNode } from 'react'
import { describe, expect, it } from 'vitest'

import { useDraft } from './state'

const wrapper = ({ children }: { children: ReactNode }) => (
  <StrictMode>{children}</StrictMode>
)

describe('streamer setting drafts', () => {
  it('accepts refreshed settings when the draft has no local changes', () => {
    const hook = renderHook(({ value }) => useDraft(value), {
      initialProps: { value: { enabled: false, interval: 60 } },
      wrapper,
    })
    hook.rerender({ value: { enabled: true, interval: 120 } })
    expect(hook.result.current.draft).toEqual({ enabled: true, interval: 120 })
    expect(hook.result.current.dirty).toBe(false)
  })

  it('preserves unsaved changes across polling and resets to the newest settings', () => {
    const hook = renderHook(({ value }) => useDraft(value), {
      initialProps: { value: { interval: 60 } },
      wrapper,
    })
    act(() => hook.result.current.setDraft({ interval: 90 }))
    hook.rerender({ value: { interval: 120 } })
    expect(hook.result.current.draft).toEqual({ interval: 90 })
    expect(hook.result.current.dirty).toBe(true)
    act(() => hook.result.current.reset())
    expect(hook.result.current.draft).toEqual({ interval: 120 })
    expect(hook.result.current.dirty).toBe(false)
  })
})
