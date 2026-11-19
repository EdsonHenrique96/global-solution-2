import '@testing-library/jest-dom/vitest'
import { beforeEach } from 'vitest'

// every test opens the app at its first page: the page lives in the address (AD-111), and jsdom keeps
// the address from one test to the next
beforeEach(() => {
  window.history.replaceState(null, '', '/')
})
