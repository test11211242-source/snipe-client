// @vitest-environment jsdom

import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { AuthApp } from './AuthApp'

describe('AuthApp', () => {
  it('renders the invite gate and advances to accessible credentials', async () => {
    const activateInvite = vi.fn().mockResolvedValue({
      state: 'UNAUTHENTICATED',
      user: null,
      deviceHint: '12345678...abcd',
      error: null,
    })
    Object.defineProperty(window, 'crToolsAuth', {
      configurable: true,
      value: Object.freeze({
        getView: vi.fn().mockResolvedValue({
          state: 'INVITE_REQUIRED',
          user: null,
          deviceHint: '12345678...abcd',
          error: null,
        }),
        retryBootstrap: vi.fn(),
        checkInvite: vi.fn(),
        activateInvite,
        login: vi.fn(),
        register: vi.fn(),
      }),
    })
    render(<AuthApp />)
    const input = await screen.findByLabelText('Инвайт-код')
    fireEvent.change(input, { target: { value: 'INVITE_123' } })
    const form = input.closest('form')
    if (form === null) throw new Error('Invite form is missing')
    fireEvent.submit(form)
    expect(await screen.findByRole('heading', { name: 'Вход в CR Tools' })).toBeVisible()
    expect(screen.getByLabelText('Email')).toBeVisible()
    expect(activateInvite).toHaveBeenCalledWith({ inviteCode: 'INVITE_123' })
  })
})
