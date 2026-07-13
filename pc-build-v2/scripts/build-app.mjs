// electron-vite 5's isolated-entry reporter assumes an interactive stdout.
if (process.stdout.isTTY !== true) {
  Object.assign(process.stdout, {
    clearLine: () => true,
    cursorTo: () => true,
    moveCursor: () => true,
  })
}

const { build } = await import('electron-vite')
await build()
