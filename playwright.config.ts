import { defineConfig, devices } from '@playwright/test';

// End-to-end UI tests (#396). The real React app runs in real browsers. The
// Rust backend can't run in a browser, so Tauri's IPC is answered by the fake
// backend in e2e/harness, loaded from e2e/index.html.
//
// The app is tested as a production build (vite.e2e.config.ts), not on the dev
// server. In development React's StrictMode mounts every component twice, and
// @monaco-editor/react then reuses an editor it has just disposed
// ("InstantiationService has been disposed"), a crash the shipped app can't
// have. A build is also the bundled code users run: vite.config.ts records a bug
// only the bundle had.
//
// Chromium also collects coverage (see e2e/coverage-setup); WebKit is the engine
// the macOS app uses, so it runs the same tests for behaviour.

// `vite preview`'s port, away from the 1420 that `tauri dev` holds.
const PORT = 4173;
const viewport = { width: 1440, height: 900 };

export default defineConfig({
  testDir: './e2e/tests',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  // No retries: a flaky test should fail visibly, not pass on a second try.
  retries: 0,
  workers: process.env.CI ? 2 : undefined,
  // Room for a slow CI runner; a healthy assertion settles well within it.
  expect: { timeout: 15_000 },
  // Every test loads the whole app, and with many workers loading it at once a
  // page can take a while to arrive, WebKit especially. A real hang still fails.
  timeout: 60_000,
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
    command: `npx vite build --config vite.e2e.config.ts && npx vite preview --config vite.e2e.config.ts --port ${PORT} --strictPort`,
    url: `http://localhost:${PORT}/e2e/index.html`,
    // Always build fresh: a preview left running from an earlier run would
    // serve stale code.
    reuseExistingServer: false,
    timeout: 300_000,
  },
});
