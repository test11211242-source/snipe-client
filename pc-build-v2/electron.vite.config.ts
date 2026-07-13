import { resolve } from 'node:path'

import react from '@vitejs/plugin-react-swc'
import { defineConfig } from 'electron-vite'

export default defineConfig({
  main: {
    build: {
      rollupOptions: {
        input: resolve(import.meta.dirname, 'electron/main/bootstrap.ts'),
      },
    },
  },
  preload: {
    build: {
      externalizeDeps: false,
      rollupOptions: {
        input: {
          auth: resolve(import.meta.dirname, 'electron/preload/auth.ts'),
          main: resolve(import.meta.dirname, 'electron/preload/main.ts'),
          setup: resolve(import.meta.dirname, 'electron/preload/setup.ts'),
          widget: resolve(import.meta.dirname, 'electron/preload/widget.ts'),
        },
        output: {
          entryFileNames: '[name].cjs',
          format: 'cjs',
        },
      },
    },
  },
  renderer: {
    root: resolve(import.meta.dirname, 'renderer'),
    plugins: [react()],
    build: {
      rollupOptions: {
        input: {
          main: resolve(import.meta.dirname, 'renderer/index.html'),
          auth: resolve(import.meta.dirname, 'renderer/auth.html'),
          setup: resolve(import.meta.dirname, 'renderer/setup.html'),
          widget: resolve(import.meta.dirname, 'renderer/widget.html'),
        },
      },
    },
  },
})
