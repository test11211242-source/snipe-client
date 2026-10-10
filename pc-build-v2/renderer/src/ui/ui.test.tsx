// @vitest-environment jsdom

import { act, fireEvent, render, screen } from '@testing-library/react'
import { useState } from 'react'
import { describe, expect, it, vi } from 'vitest'

import {
  Button,
  ConfirmDialog,
  Deck,
  DeckTabs,
  Dialog,
  Menu,
  MenuItem,
  Requirements,
  Segment,
  Stepper,
  Switch,
  ToastProvider,
  useToast,
} from '.'

function DialogHarness({ onClose }: { onClose: () => void }): React.JSX.Element {
  const [open, setOpen] = useState(false)
  return (
    <>
      <button onClick={() => setOpen(true)} type="button">
        Открыть
      </button>
      {open ? (
        <Dialog
          footer={<Button onClick={() => setOpen(false)}>Закрыть</Button>}
          onClose={() => {
            onClose()
            setOpen(false)
          }}
          title="Вопрос"
        >
          <input aria-label="Поле" />
        </Dialog>
      ) : null}
    </>
  )
}

describe('Dialog focus handling', () => {
  it('moves focus inside, traps Tab, closes on Esc and returns focus to the opener', () => {
    const onClose = vi.fn()
    render(<DialogHarness onClose={onClose} />)
    const opener = screen.getByRole('button', { name: 'Открыть' })
    opener.focus()
    fireEvent.click(opener)

    const dialog = screen.getByRole('dialog', { name: 'Вопрос' })
    const field = screen.getByLabelText('Поле')
    const close = screen.getByRole('button', { name: 'Закрыть' })
    expect(dialog).toContainElement(document.activeElement as HTMLElement)
    expect(field).toHaveFocus()

    close.focus()
    fireEvent.keyDown(close, { key: 'Tab' })
    expect(field).toHaveFocus()
    fireEvent.keyDown(field, { key: 'Tab', shiftKey: true })
    expect(close).toHaveFocus()

    fireEvent.keyDown(field, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(1)
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(opener).toHaveFocus()
  })

  it('ConfirmDialog shows pending, keeps open on failure and blocks cancel while pending', () => {
    const onCancel = vi.fn()
    const { rerender } = render(
      <ConfirmDialog
        confirmLabel="Удалить"
        onCancel={onCancel}
        onConfirm={() => undefined}
        pending
        text="Это нельзя отменить."
        title="Удалить профиль?"
      />,
    )
    expect(screen.getByRole('alertdialog', { name: 'Удалить профиль?' })).toBeVisible()
    expect(screen.getByRole('button', { name: 'Отмена' })).toBeDisabled()
    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' })
    expect(onCancel).not.toHaveBeenCalled()

    rerender(
      <ConfirmDialog
        confirmLabel="Удалить"
        error="Профиль занят."
        onCancel={onCancel}
        onConfirm={() => undefined}
        text="Это нельзя отменить."
        title="Удалить профиль?"
      />,
    )
    expect(screen.getByText('Профиль занят.')).toBeVisible()
    fireEvent.click(screen.getByRole('button', { name: 'Отмена' }))
    expect(onCancel).toHaveBeenCalledTimes(1)
  })
})

describe('Menu', () => {
  it('opens with ArrowDown, moves with arrows, closes on Esc and refocuses the trigger', () => {
    const onSelect = vi.fn()
    render(
      <Menu
        label="Профили"
        trigger={({ props }) => (
          <button {...props} type="button">
            Меню
          </button>
        )}
      >
        <MenuItem onSelect={onSelect}>Первый</MenuItem>
        <MenuItem onSelect={() => undefined}>Второй</MenuItem>
      </Menu>,
    )
    const trigger = screen.getByRole('button', { name: 'Меню' })
    trigger.focus()
    expect(trigger).toHaveAttribute('aria-expanded', 'false')
    act(() => {
      fireEvent.keyDown(trigger, { key: 'ArrowDown' })
    })
    expect(trigger).toHaveAttribute('aria-expanded', 'true')
    const first = screen.getByRole('menuitem', { name: 'Первый' })
    const second = screen.getByRole('menuitem', { name: 'Второй' })
    expect(first).toHaveFocus()
    fireEvent.keyDown(first, { key: 'ArrowDown' })
    expect(second).toHaveFocus()
    fireEvent.keyDown(second, { key: 'ArrowDown' })
    expect(first).toHaveFocus()

    fireEvent.keyDown(first, { key: 'Escape' })
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
    expect(trigger).toHaveFocus()

    fireEvent.click(trigger)
    fireEvent.click(screen.getByRole('menuitem', { name: 'Первый' }))
    expect(onSelect).toHaveBeenCalledTimes(1)
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
  })

  it('closes on a press outside', () => {
    render(
      <>
        <Menu
          label="Меню"
          trigger={({ props }) => (
            <button {...props} type="button">
              Меню
            </button>
          )}
        >
          <MenuItem onSelect={() => undefined}>Пункт</MenuItem>
        </Menu>
        <p>снаружи</p>
      </>,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Меню' }))
    expect(screen.getByRole('menu')).toBeVisible()
    fireEvent.pointerDown(screen.getByText('снаружи'))
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
  })
})

describe('selection controls', () => {
  it('Switch exposes role=switch with aria-checked and toggles', () => {
    const onChange = vi.fn()
    render(<Switch checked={false} label="Автозапуск" onChange={onChange} />)
    const toggle = screen.getByRole('switch', { name: 'Автозапуск' })
    expect(toggle).toHaveAttribute('aria-checked', 'false')
    fireEvent.click(toggle)
    expect(onChange).toHaveBeenCalledWith(true)
  })

  it('Segment is a pressed-button group and ignores a disabled option', () => {
    const onChange = vi.fn()
    render(
      <Segment
        label="Режим колод"
        onChange={onChange}
        options={[
          { value: 'pol', label: 'Путь легенд' },
          { value: 'gt', label: 'Турнир' },
          { value: 'x', label: 'Скоро', disabled: true },
        ]}
        value="pol"
      />,
    )
    expect(screen.getByRole('group', { name: 'Режим колод' })).toBeVisible()
    expect(screen.getByRole('button', { name: 'Путь легенд' })).toHaveAttribute(
      'aria-pressed',
      'true',
    )
    fireEvent.click(screen.getByRole('button', { name: 'Путь легенд' }))
    expect(onChange).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Турнир' }))
    expect(onChange).toHaveBeenCalledWith('gt')
    expect(screen.getByRole('button', { name: 'Скоро' })).toBeDisabled()
  })

  it('Stepper respects bounds and arrow keys', () => {
    const onChange = vi.fn()
    render(<Stepper label="Окно" max={10} min={5} onChange={onChange} value={5} />)
    expect(screen.getByRole('button', { name: 'Уменьшить' })).toBeDisabled()
    fireEvent.click(screen.getByRole('button', { name: 'Увеличить' }))
    expect(onChange).toHaveBeenLastCalledWith(6)
    fireEvent.keyDown(screen.getByRole('spinbutton'), { key: 'ArrowUp' })
    expect(onChange).toHaveBeenLastCalledWith(6)
  })

  it('DeckTabs are tabs, hide for a single deck and move with arrow keys', () => {
    const onSelect = vi.fn()
    const { rerender } = render(<DeckTabs count={1} onSelect={onSelect} selected={0} />)
    expect(screen.queryByRole('tablist')).not.toBeInTheDocument()
    rerender(<DeckTabs count={3} onSelect={onSelect} selected={0} />)
    expect(screen.getByRole('tab', { name: 'Колода 1' })).toHaveAttribute(
      'aria-selected',
      'true',
    )
    expect(screen.getByText(/из 3/)).toBeVisible()
    fireEvent.keyDown(screen.getByRole('tab', { name: 'Колода 1' }), {
      key: 'ArrowRight',
    })
    expect(onSelect).toHaveBeenCalledWith(1)
  })
})

describe('game kit', () => {
  it('Deck always has eight slots and draws images only, without level or badges', () => {
    render(
      <Deck
        cards={[
          { name: 'Рыцарь', iconUrl: 'data:image/png;base64,AAAA' },
          { name: 'Ракета', iconUrl: null },
        ]}
        label="Колода 1"
      />,
    )
    expect(screen.getAllByRole('listitem')).toHaveLength(8)
    expect(screen.getByRole('img', { name: 'Рыцарь' })).toBeVisible()
    expect(document.body.textContent).not.toMatch(/ур\.|lvl|level|Эволюц|Герой/i)
  })

  it('Requirements: unmet items get a fix action in rows, met items collapse to chips', () => {
    const fix = vi.fn()
    const { rerender } = render(
      <Requirements
        items={[
          {
            id: 'twitch',
            name: 'Twitch',
            state: 'не подключён',
            ok: false,
            action: { label: 'Подключить', onAction: fix },
          },
          { id: 'monitor', name: 'Мониторинг', state: 'идёт', ok: true },
        ]}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: /Подключить/ }))
    expect(fix).toHaveBeenCalled()
    rerender(
      <Requirements
        items={[{ id: 'monitor', name: 'Мониторинг', state: 'идёт', ok: true }]}
      />,
    )
    expect(screen.getByText(/Мониторинг: идёт/)).toBeVisible()
  })
})

function ToastButton(): React.JSX.Element {
  const toast = useToast()
  return (
    <button
      onClick={() =>
        toast.show({
          message: 'Название обновлено',
          action: { label: 'Отменить', onAction: undo },
        })
      }
      type="button"
    >
      Показать
    </button>
  )
}
const undo = vi.fn()

describe('Toast', () => {
  it('announces a toast, runs its action and removes it', () => {
    render(
      <ToastProvider>
        <ToastButton />
      </ToastProvider>,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Показать' }))
    expect(screen.getByText('Название обновлено')).toBeVisible()
    fireEvent.click(screen.getByRole('button', { name: 'Отменить' }))
    expect(undo).toHaveBeenCalledTimes(1)
    expect(screen.queryByText('Название обновлено')).not.toBeInTheDocument()
  })
})
