// Visual-check runner: renders the built renderer in a frameless window with a fake bridge
// and saves PNGs. Usage: electron harness-main.cjs <scenarios.json> <outDir>
const { app, BrowserWindow, ipcMain } = require('electron')
const fs = require('node:fs')
const path = require('node:path')

const [scenariosFile, outDir] = process.argv.slice(2)
const scenarios = JSON.parse(fs.readFileSync(scenariosFile, 'utf8'))
fs.mkdirSync(outDir, { recursive: true })
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
let current = {}
ipcMain.on('visual:fixture', (event) => {
  event.returnValue = current
})

app.on('window-all-closed', () => undefined)
app.whenReady().then(async () => {
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
