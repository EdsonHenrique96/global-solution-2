/// <reference types="vitest/config" />
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    // the agent's LLM proxy (../server), so the API key never reaches the page; the ML service (../ml)
    proxy: { '/api': 'http://127.0.0.1:8787', '/ml': 'http://127.0.0.1:8788' },
  },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: './src/setupTests.ts',
    exclude: ['**/node_modules/**', '**/*.integration.test.ts'],
  },
})
