import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    // Persistence tests temporarily switch the process-wide DSH_HOME.
    // Running files concurrently makes their async writes target another
    // test's temporary directory during cleanup.
    fileParallelism: false,
  },
})
