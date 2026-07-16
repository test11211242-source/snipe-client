// @vitest-environment jsdom

import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { StreamerView } from '../../../shared/models/streamer'
import {
  DEFAULT_OVERLAY_SETTINGS,
  DEFAULT_TITLE_SETTINGS,
} from '../../../electron/main/services/streamer-adapters'
import { StreamerPage } from './StreamerPage'
import { NumberField } from './streamer/controls'

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

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolvePromise: (value: T) => void = () => {
    throw new Error('Deferred promise was not initialized')
  }
  const promise = new Promise<T>((resolve) => {
    resolvePromise = resolve
  })
  return { promise, resolve: resolvePromise }
}

const refreshedView: StreamerView = {
  ...view,
  predictions: {
    ...view.predictions,
    settings: { ...view.predictions.settings, predictionWindow: 120 },
  },
  overlay: {
    ...view.overlay,
    settings: { ...view.overlay.settings, matchupRankLimits: [200, 500] },
  },
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
    const rendered = render(<StreamerPage auth={auth} />)
    expect(await screen.findByText('Twitch @caster')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('tab', { name: 'OBS' }))
    expect(screen.getByText('Композиция без секретных данных')).toBeVisible()
    expect(screen.getByText('Пример игрока')).toBeVisible()
    expect(document.body.textContent).not.toContain('token=')
    rendered.unmount()
    expect(window.crTools.setStreamerSectionActive).toHaveBeenLastCalledWith(false)
  })

  it('supports roving keyboard tabs and preserves a title draft between tabs', async () => {
    render(<StreamerPage auth={auth} />)
    await screen.findByText('Twitch @caster')

    const overviewTab = screen.getByRole('tab', { name: 'Обзор' })
    overviewTab.focus()
    fireEvent.keyDown(overviewTab, { key: 'ArrowRight' })
    expect(screen.getByRole('tab', { name: 'Twitch и прогнозы' })).toHaveFocus()
    expect(screen.getByRole('tab', { name: 'Twitch и прогнозы' })).toHaveAttribute(
      'aria-selected',
      'true',
    )

    fireEvent.click(screen.getByRole('tab', { name: 'Название стрима' }))
    const prefix = screen.getByRole('textbox', { name: 'Шаблон префикса' })
    fireEvent.change(prefix, { target: { value: 'Черновик трансляции' } })
    expect(screen.getByText('Есть несохранённые изменения')).toBeVisible()

    fireEvent.click(screen.getByRole('tab', { name: 'Обзор' }))
    fireEvent.click(screen.getByRole('tab', { name: 'Название стрима' }))
    expect(screen.getByRole('textbox', { name: 'Шаблон префикса' })).toHaveValue(
      'Черновик трансляции',
    )
  })

  it('syncs untouched numeric and rank drafts when refresh returns changed settings', async () => {
    const refresh = deferred<StreamerView>()
    vi.mocked(window.crTools.refreshStreamer).mockReturnValueOnce(refresh.promise)
    render(<StreamerPage auth={auth} />)
    await screen.findByText('Twitch @caster')

    fireEvent.click(screen.getByRole('tab', { name: 'Twitch и прогнозы' }))
    const windowField = screen.getByRole('spinbutton', {
      name: 'Окно голосования, сек',
    })
    expect(windowField).toHaveValue(60)

    fireEvent.click(screen.getByRole('tab', { name: 'OBS' }))
    fireEvent.click(screen.getByText('Тайминги и сравнение'))
    const rankLimits = screen.getByRole('textbox', {
      name: 'Пределы рейтинга для сравнения',
    })

    await act(() => {
      refresh.resolve(refreshedView)
      return refresh.promise
    })

    await waitFor(() => expect(windowField).toHaveValue(120))
    expect(rankLimits).toHaveValue('200, 500')
  })

  it('does not overwrite an invalid focused numeric draft when props refresh', () => {
    const rendered = render(
      <NumberField
        fieldKey="window"
        label="Окно голосования, сек"
        value={60}
        min={30}
        max={1800}
        disabled={false}
        onChange={vi.fn()}
        onValidityChange={vi.fn()}
      />,
    )
    const windowField = screen.getByRole('spinbutton', {
      name: 'Окно голосования, сек',
    })
    windowField.focus()
    fireEvent.change(windowField, { target: { value: '' } })

    rendered.rerender(
      <NumberField
        fieldKey="window"
        label="Окно голосования, сек"
        value={120}
        min={30}
        max={1800}
        disabled={false}
        onChange={vi.fn()}
        onValidityChange={vi.fn()}
      />,
    )

    expect(windowField).toHaveValue(null)
    expect(windowField).toHaveFocus()
    expect(windowField).toHaveAttribute('aria-invalid', 'true')
  })

  it('blocks invalid numeric drafts and reports mutation errors', async () => {
    render(<StreamerPage auth={auth} />)
    await screen.findByText('Twitch @caster')

    fireEvent.click(screen.getByRole('tab', { name: 'Twitch и прогнозы' }))
    const windowField = screen.getByRole('spinbutton', {
      name: 'Окно голосования, сек',
    })
    fireEvent.change(windowField, { target: { value: '' } })
    expect(windowField).toHaveAttribute('aria-invalid', 'true')
    expect(screen.getByRole('button', { name: 'Запустить прогнозы' })).toBeDisabled()

    vi.mocked(window.crTools.updateOverlay).mockRejectedValueOnce(new Error('server'))
    fireEvent.click(screen.getByRole('tab', { name: 'OBS' }))
    fireEvent.click(screen.getByText('Тайминги и сравнение'))
    const rankLimits = screen.getByRole('textbox', {
      name: 'Пределы рейтинга для сравнения',
    })
    fireEvent.change(rankLimits, { target: { value: '100, abc' } })
    expect(rankLimits).toHaveAttribute('aria-invalid', 'true')
    expect(screen.getByRole('button', { name: 'Сохранить настройки OBS' })).toBeDisabled()
    fireEvent.change(rankLimits, { target: { value: '100, 200' } })
    expect(rankLimits).toHaveAttribute('aria-invalid', 'false')
    fireEvent.click(screen.getByRole('checkbox', { name: 'Оверлеи' }))
    fireEvent.click(screen.getByRole('button', { name: 'Сохранить настройки OBS' }))
    expect(
      await screen.findByText(
        'Не удалось сохранить настройки. Проверьте значения и повторите.',
      ),
    ).toBeVisible()
  })

  it('shows success feedback after copying an OBS URL', async () => {
    render(<StreamerPage auth={auth} />)
    await screen.findByText('Twitch @caster')
    fireEvent.click(screen.getByRole('tab', { name: 'OBS' }))

    const copyButton = screen.getAllByRole('button', { name: 'Копировать' })[0]
    if (copyButton === undefined) throw new Error('Copy button is missing')
    fireEvent.click(copyButton)

    expect(await screen.findByText('Ссылка скопирована в буфер обмена')).toBeVisible()
    expect(screen.getByRole('button', { name: 'Скопировано' })).toBeVisible()
    expect(window.crTools.copyOverlayUrl).toHaveBeenCalledWith('stats')
  })
})
