// DOM helpers injected into every harness page; scenario steps call them as window.__h.*.
// Test tooling only.
window.__h = {
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  find(text, selector = 'button,[role=menuitem]') {
    return [...document.querySelectorAll(selector)].find((el) =>
      (el.getAttribute('aria-label') ?? el.textContent ?? '').trim().includes(text),
    )
  },
  click(text, selector) {
    const el = window.__h.find(text, selector)
    if (!el) throw new Error(`no element with "${text}"`)
    el.click()
  },
  type(label, value) {
    const el = [...document.querySelectorAll('input')].find(
      (input) =>
        input.getAttribute('aria-label') === label ||
        input.labels?.[0]?.textContent?.trim() === label,
    )
    if (!el) throw new Error(`no input "${label}"`)
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
    set.call(el, value)
    el.dispatchEvent(new Event('input', { bubbles: true }))
  },
  // Drag on the frame stage; coordinates are fractions of the frame.
  draw(x0, y0, x1, y1) {
    const stage = document.querySelector(
      '[aria-label="Выделение области на рабочем кадре"]',
    )
    const surface = stage.firstElementChild
    const r = surface.getBoundingClientRect()
    const at = (x, y) => ({
      clientX: r.left + x * r.width,
      clientY: r.top + y * r.height,
      pointerId: 1,
      button: 0,
      bubbles: true,
    })
    stage.dispatchEvent(new PointerEvent('pointerdown', at(x0, y0)))
    stage.dispatchEvent(new PointerEvent('pointermove', at(x1, y1)))
    stage.dispatchEvent(new PointerEvent('pointerup', at(x1, y1)))
  },
  async openPanel() {
    window.__h.click('Профиль:')
    await window.__h.sleep(200)
    window.__h.click('Управлять профилями')
    await window.__h.sleep(300)
  },
  rowMenu(name) {
    window.__h.click(`Действия с профилем «${name}»`)
  },
}

void 0
