// @vitest-environment jsdom

import { fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { Menu, MenuItem } from '.'
import { placeMenu } from './menuPlacement'

const viewport = { width: 800, height: 600 }
const menu = { width: 280, height: 200 }

function anchorAt(top: number, left = 100) {
  return { top, left, right: left + 32, bottom: top + 32 }
}

describe('placeMenu', () => {
  it('opens downward when there is room', () => {
    const placement = placeMenu({
      anchor: anchorAt(100),
      menu,
      viewport,
      direction: 'down',
      align: 'start',
      gap: 8,
      margin: 8,
    })
    expect(placement).toMatchObject({ side: 'down', top: 140, left: 100 })
  })

  it('flips upward near the bottom edge and stays inside the viewport', () => {
    const placement = placeMenu({
      anchor: anchorAt(540),
      menu,
      viewport,
      direction: 'down',
      align: 'start',
      gap: 8,
      margin: 8,
    })
    expect(placement.side).toBe('up')
    expect(placement.top).toBe(540 - 8 - 200)
    expect(placement.top + menu.height).toBeLessThanOrEqual(viewport.height)
  })

  it('flips downward for an upward menu without room above', () => {
    const placement = placeMenu({
      anchor: anchorAt(20),
      menu,
      viewport,
      direction: 'up',
      align: 'start',
      gap: 8,
      margin: 8,
    })
    expect(placement.side).toBe('down')
    expect(placement.top).toBe(60)
  })

  it('caps the height on the roomier side when neither side fits', () => {
    const placement = placeMenu({
      anchor: anchorAt(130),
      menu: { width: 280, height: 500 },
      viewport: { width: 800, height: 300 },
      direction: 'down',
      align: 'start',
      gap: 8,
      margin: 8,
    })
    // 300 - 162 - 16 = 122 below, 130 - 16 = 114 above: stays down, scrolls inside.
    expect(placement.side).toBe('down')
    expect(placement.maxHeight).toBe(122)
  })

  it('shifts horizontally inside the viewport and respects end alignment', () => {
    const right = placeMenu({
      anchor: anchorAt(100, 700),
      menu,
      viewport,
      direction: 'down',
      align: 'start',
      gap: 8,
      margin: 8,
    })
    expect(right.left).toBe(800 - 280 - 8)
    const end = placeMenu({
      anchor: anchorAt(100, 20),
      menu,
      viewport,
      direction: 'down',
      align: 'end',
      gap: 8,
      margin: 8,
    })
    expect(end.left).toBe(8)
  })
})

describe('Menu in a scroll container', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('renders outside the clipping ancestor, fixed, and flips upward at the bottom', () => {
    vi.spyOn(window, 'innerHeight', 'get').mockReturnValue(600)
    vi.spyOn(window, 'innerWidth', 'get').mockReturnValue(800)
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (
      this: HTMLElement,
    ) {
      if (this.getAttribute('role') === 'menu')
        return {
          top: 0,
          left: 0,
          right: 280,
          bottom: 200,
          width: 280,
          height: 200,
        } as DOMRect
      return {
        top: 560,
        left: 100,
        right: 132,
        bottom: 592,
        width: 32,
        height: 32,
      } as DOMRect
    })
    render(
      <div data-testid="scroller" style={{ overflow: 'auto', height: 100 }}>
        <Menu
          label="Действия"
          trigger={({ props }) => (
            <button {...props} type="button">
              Ещё
            </button>
          )}
        >
          <MenuItem onSelect={() => undefined}>Удалить</MenuItem>
        </Menu>
      </div>,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Ещё' }))
    const popup = screen.getByRole('menu')
    expect(screen.getByTestId('scroller').contains(popup)).toBe(false)
    expect(popup.parentElement).toBe(document.body)
    expect(popup.style.visibility).toBe('visible')
    // Flipped above the trigger: bottom edge 8px over it, fully inside the viewport.
    expect(popup.style.top).toBe(`${560 - 8 - 200}px`)
    expect(popup.style.left).toBe('100px')
    // A press inside the portaled menu is not an outside press.
    fireEvent.pointerDown(screen.getByRole('menuitem', { name: 'Удалить' }))
    expect(screen.getByRole('menu')).toBeInTheDocument()
  })
})
