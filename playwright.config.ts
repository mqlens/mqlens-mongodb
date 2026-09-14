import { defineConfig, devices } from '@playwright/test';

// End-to-end UI tests (#396). The real React app runs in real browsers against
// the Vite dev server. The Rust backend can't run in a browser, so Tauri's IPC
// is answered by the fake backend in e2e/harness, loaded from e2e/index.html.
//
// Chromium also collects coverage (see e2e/coverage-setup); WebKit is the engine the
// macOS app uses, so it runs the same tests for behaviour.

// vite.config.ts pins the dev server to this port with strictPort.
const PORT = 1420;
const viewport = { width: 1440, height: 900 };

export default defineConfig({
  testDir: './e2e/tests',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  // No retries: a flaky test should fail visibly, not pass on a second try.
  retries: 0,
  // The first page load of a run transforms the whole module graph on the Vite
  // dev server, which takes several seconds while parallel workers all start at
  // once. Assertions get room for that instead of racing it.
  expect: { timeout: 15_000 },
  workers: process.env.CI ? 2 : undefined,
  reporter: process.env.CI
    ? [['list'], ['github'], ['html', { open: 'never' }]]
    : [['list'], ['html', { open: 'never' }]],
  globalSetup: './e2e/coverage-setup/global-setup.ts',
  globalTeardown: './e2e/coverage-setup/global-teardown.ts',
  use: {
    baseURL: `http://localhost:${PORT}`,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'], viewport } },
    { name: 'webkit', use: { ...devices['Desktop Safari'], viewport } },
  ],
  webServer: {
    command: `npx vite --port ${PORT} --strictPort`,
    url: `http://localhost:${PORT}/e2e/index.html`,
    // Locally, reuse a dev server that's already running (e.g. `npm run dev`).
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
