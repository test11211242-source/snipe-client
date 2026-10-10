// Visual-check runner: renders the built renderer in a frameless window with a fake bridge
// and saves PNGs. Usage: electron harness-main.cjs <scenarios.json> <outDir>
const { app, BrowserWindow, ipcMain, protocol } = require('electron')
const fs = require('node:fs')
const path = require('node:path')

const [scenariosFile, outDir] = process.argv.slice(2)
const only =
  process.env.VISUAL_ONLY === undefined ? null : new RegExp(process.env.VISUAL_ONLY)
const scenarios = JSON.parse(fs.readFileSync(scenariosFile, 'utf8')).filter(
  (scenario) => only === null || only.test(scenario.name),
)
fs.mkdirSync(outDir, { recursive: true })
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
let current = {}
ipcMain.on('visual:fixture', (event) => {
  event.returnValue = current
})

app.on('window-all-closed', () => undefined)
// Stand-in for the public widget preview origin, so frames render without a network.
function widgetStub(url) {
  const stats = url.includes('streamer-stats')
  const body = stats
    ? '<div class=card style="display:flex;gap:24px"><div><small>Место</small><b>★ 297</b></div><div><small>Рейтинг</small><b>2 675</b></div><div><small>Сегодня</small><b>5 : 2</b></div><div><small>Изменение</small><b style="color:#63d2a9">+12</b></div></div>'
    : '<div class=card><div style="display:flex;justify-content:space-between"><b style="font-size:22px">Voron_17</b><b>2 487</b></div><small>Северный ветер</small><div style="display:grid;grid-template-columns:repeat(4,1fr);gap:8px;margin-top:14px">' +
      Array.from(
        { length: 8 },
        () => '<i style="aspect-ratio:5/6;border-radius:8px;background:#2b2f38"></i>',
      ).join('') +
      '</div></div>'
  return `<!doctype html><meta charset=utf-8><style>body{margin:0;background:transparent;color:#eef0f3;font:14px Segoe UI,sans-serif}.card{margin:8px;padding:16px;border-radius:16px;background:#151719;border:1px solid #262a2e}small{display:block;color:#8b9097}b{font-weight:600}</style>${body}`
}

app.whenReady().then(async () => {
  protocol.handle('https', (request) => {
    if (!request.url.startsWith('https://api.artcsworld.xyz/'))
      return new Response('', { status: 404 })
    if (current.frame === 'hang') return new Promise(() => undefined)
    return new Response(widgetStub(request.url), {
      headers: { 'content-type': 'text/html; charset=utf-8' },
    })
  })
  for (const scenario of scenarios) {
    current = scenario.fixture ?? {}
    const win = new BrowserWindow({
      width: scenario.width,
      height: scenario.height,
      useContentSize: true,
      frame: false,
      show: true,
      backgroundColor: '#0c0d0f',
      webPreferences: {
        preload: path.join(__dirname, 'harness-preload.cjs'),
        contextIsolation: true,
        sandbox: true,
      },
    })
    try {
      await win.loadFile(
        path.join(
          __dirname,
          '..',
          '..',
          'out',
          'renderer',
          scenario.page ?? 'index.html',
        ),
      )
    } catch (error) {
      console.error('load failed', scenario.name, String(error))
      win.destroy()
      continue
    }
    await sleep(900)
    await win.webContents.executeJavaScript(
      fs.readFileSync(path.join(__dirname, 'harness-helpers.cjs'), 'utf8'),
    )
    for (const step of scenario.steps ?? []) {
      await win.webContents.executeJavaScript(step)
      await sleep(350)
    }
    if (scenario.fit) {
      // Overlay: the window height follows the content, as it does natively.
      const height = await win.webContents.executeJavaScript(
        "Math.ceil(document.querySelector('main').getBoundingClientRect().height)",
      )
      win.setContentSize(scenario.width, height)
      await sleep(450)
    }
    const image = await win.webContents.capturePage()
    fs.writeFileSync(path.join(outDir, `${scenario.name}.png`), image.toPNG())
    win.destroy()
    await sleep(300)
  }
  app.quit()
})
