import { defineConfig } from 'vitest/config'
import { loadEnv } from 'vite'

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode ?? 'test', process.cwd(), '')

  return {
    test: {
      fileParallelism: false,
      globals: true,
      testTimeout: 15_000,
      env,
    },
  }
})
