import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['**/*.test.{ts,tsx}'],
    setupFiles: ['./tests/setup.ts'],
    coverage: {
      reporter: ['text', 'html'],
    },
  },
})
