import path from 'node:path';
import { configDefaults, defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  test: {
    environment: 'jsdom',
    globals: true,
    // Above the raised `asyncUtilTimeout` in src/test/setup.ts, so a `waitFor`
    // that genuinely never settles reports its own assertion error instead of
    // being cut short by vitest. The default 5s was already below the
    // `{ timeout: 5000 }` override in Sidebar.test.tsx.
    testTimeout: 15000,
    setupFiles: './src/test/setup.ts',
    // e2e/ holds the Playwright suite (#396). Its *.spec.ts files match Vitest's
    // default pattern but can only run under Playwright.
    exclude: [...configDefaults.exclude, 'e2e/**'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json-summary', 'html'],
      reportsDirectory: './coverage/frontend',
      include: ['src/**/*.{ts,tsx}'],
      exclude: [
        'src/**/*.d.ts',
        'src/**/*.test.{ts,tsx}',
        'src/test/**',
        'src/vite-env.d.ts',
      ],
    },
  },
});
