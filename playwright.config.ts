// E2E del dashboard (ticket 014). El harness corre bajo Bun porque el server usa Bun.serve;
// Playwright sólo maneja el browser.
import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: './e2e',
  timeout: 30_000,
  expect: { timeout: 10_000 },
  reporter: [['list']],
  use: {
    baseURL: 'http://localhost:8788',
    trace: 'retain-on-failure',
  },
  webServer: {
    command: 'bun run scripts/e2e-harness.ts',
    url: 'http://localhost:8788',
    reuseExistingServer: false,
    timeout: 30_000,
    stdout: 'pipe',
  },
})
