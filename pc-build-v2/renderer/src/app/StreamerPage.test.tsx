// @vitest-environment jsdom

import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { StreamerView } from '../../../shared/models/streamer'
import {
  DEFAULT_OVERLAY_SETTINGS,
  DEFAULT_TITLE_SETTINGS,
} from '../../../electron/main/services/streamer-adapters'
import { StreamerPage } from './StreamerPage'

const view: StreamerView = {
  access: { allowed: true, reason: null },
  twitch: { connected: true, username: 'caster', polling: false },
  predictions: {
    active: false,
    state: 'idle',
    runtimeState: 'stopped',
    settings: {
      predictionType: 'win_lose',
      predictionWindow: 60,
      winStreakCount: 2,
      delayBetweenPredictions: 5,
      autoCreateNext: true,
    },
    statistics: {
      total: 3,
      successful: 2,
      successRate: 66.7,
      currentWinStreak: 1,
      activeTitle: null,
    },
    requirements: {
      twitchConnected: true,
      mainMonitorConfigured: true,
      mainMonitorRunning: true,
      resultConfigured: true,
    },
  },
  title: {
    settings: DEFAULT_TITLE_SETTINGS,
    accounts: [],
    session: null,
    recentResults: [],
    previewTitle: 'Safe title',
    twitchOnline: true,
  },
  deckSharing: { enabled: false },
  overlay: {
    settings: DEFAULT_OVERLAY_SETTINGS,
    urlsAvailable: { stats: true, opponent: true },
    maskedUrls: { stats: 'hidden', opponent: 'hidden' },
    recommendedSizes: { stats: '720 x 150', opponent: '620 x 420' },
  },
  refresh: { state: 'ready', errors: [], refreshedAt: '2026-07-12T12:00:00.000Z' },
}

describe('StreamerPage', () => {
  beforeEach(() => {
    Object.defineProperty(window, 'crTools', {
      configurable: true,
      value: {
        setStreamerSectionActive: vi.fn().mockResolvedValue(view),
        refreshStreamer: vi.fn().mockResolvedValue(view),
        startStreamerResultSetup: vi.fn().mockResolvedValue(view),
        setDeckSharing: vi.fn().mockResolvedValue(view),
        connectTwitch: vi.fn().mockResolvedValue(view),
        disconnectTwitch: vi.fn().mockResolvedValue(view),
        startPredictions: vi.fn().mockResolvedValue(view),
        stopPredictions: vi.fn().mockResolvedValue(view),
        updateStreamTitle: vi.fn().mockResolvedValue(view),
        setStreamTitleEnabled: vi.fn().mockResolvedValue(view),
        setStreamTitlePaused: vi.fn().mockResolvedValue(view),
        addStreamTitleAccount: vi.fn().mockResolvedValue(view),
        removeStreamTitleAccount: vi.fn().mockResolvedValue(view),
        resetStreamTitle: vi.fn().mockResolvedValue(view),
        undoStreamTitle: vi.fn().mockResolvedValue(view),
        restoreStreamTitle: vi.fn().mockResolvedValue(view),
        updateOverlay: vi.fn().mockResolvedValue(view),
        rotateOverlayToken: vi.fn().mockResolvedValue(view),
        copyOverlayUrl: vi.fn().mockResolvedValue(view),
      },
    })
  })

  it('renders all active tabs, local OBS mock previews, and tears down polling', async () => {
    const auth = {
      state: 'AUTHENTICATED' as const,
      user: {
        id: '42',
        username: 'caster',
        email: 'c@example.com',
        role: 'premium' as const,
        roles: ['premium' as const, 'streamer' as const],
      },
      deviceHint: null,
      error: null,
    }
    const rendered = render(<StreamerPage auth={auth} />)
    expect(await screen.findByText('Twitch @caster')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('tab', { name: 'OBS' }))
    expect(screen.getByText('Композиция без live token')).toBeInTheDocument()
    expect(screen.getByText('Example Player')).toBeInTheDocument()
    expect(document.body.textContent).not.toContain('token=')
    rendered.unmount()
    expect(window.crTools.setStreamerSectionActive).toHaveBeenLastCalledWith(false)
  })
})
