// @vitest-environment jsdom

import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { CatalogApp } from './CatalogApp'

describe('component catalog', () => {
  it('renders every kit group and opens its overlays', () => {
    render(<CatalogApp />)
    for (const heading of ['Кнопки', 'Поля и выбор', 'Игра', 'Полоса обновления'])
      expect(screen.getByRole('heading', { name: heading })).toBeVisible()
    expect(screen.getAllByRole('listitem').length).toBeGreaterThanOrEqual(8)
    fireEvent.click(screen.getByRole('button', { name: 'Подтверждение' }))
    expect(screen.getByRole('alertdialog')).toBeVisible()
  })
})
