import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './scripts',
  testMatch: 'capture-marketing.ts',
  timeout: 180_000,
  workers: 1,
  reporter: 'list',
  outputDir: '.superpowers/sdd/website-refresh/capture-results',
  webServer: {
    command: 'npx vite build --config vite.e2e.config.ts && npx vite preview --config vite.e2e.config.ts --host 127.0.0.1 --port 4173 --strictPort',
    url: 'http://127.0.0.1:4173/e2e/index.html',
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
