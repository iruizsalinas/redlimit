import { defineConfig } from 'vitest/config'

export default defineConfig({
  envDir: false,
  test: { include: ['test/unit/**/*.test.ts'], globals: true },
})
