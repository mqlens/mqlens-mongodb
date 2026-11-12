import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './e2e/website',
  fullyParallel: true,
  workers: 2,
  retries: 0,
  reporter: 'list',
  use: { baseURL: 'http://127.0.0.1:4321', trace: 'retain-on-failure' },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: 'npm run preview --prefix website -- --host 127.0.0.1 --port 4321 --ignore-lock',
    url: 'http://127.0.0.1:4321',
    env: { ASTRO_TELEMETRY_DISABLED: '1' },
    reuseExistingServer: !process.env.CI,
  },
});
