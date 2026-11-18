import { defineConfig } from 'vitest/config'

// Tests that need the Mosquitto broker from ../docker-compose.yml running.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.integration.test.ts'],
    testTimeout: 15_000,
  },
})
