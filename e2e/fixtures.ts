// Shared Playwright fixtures for the end-to-end suite (#396).
import { test as base, expect, type Page } from '@playwright/test';
import { CoverageReport } from 'monocart-coverage-reports';
import { coverageOptions } from './coverage-setup/options';
import type { Seed } from './harness/seed';

export interface RecordedCall {
  cmd: string;
  args: unknown;
  error?: string;
}

/** Drives the app in a page and talks to its fake backend. */
export class App {
  private opened = false;

  constructor(readonly page: Page) {}

  /** Load the app on a fake backend built from `seed`. */
  async open(seed: Seed = {}): Promise<void> {
    await this.page.addInitScript((value) => {
      window.__MQLENS_E2E_SEED__ = value;
    }, seed);
    // Not the full `load` event: nothing waits on it, and the assertions that
    // follow already wait for the app itself to appear.
    await this.page.goto('/e2e/index.html', { waitUntil: 'domcontentloaded' });
    this.opened = true;
  }

  get isOpen(): boolean {
    return this.opened;
  }

  /** Every backend call so far, optionally only those to `cmd`. Args are JSON-safe copies. */
  calls(cmd?: string): Promise<RecordedCall[]> {
    return this.page.evaluate((only) => {
      const calls = window.__MQLENS_E2E__!.calls.filter((call) => !only || call.cmd === only);
      return calls.map((call) => ({ cmd: call.cmd, args: JSON.parse(JSON.stringify(call.args ?? null)), error: call.error }));
    }, cmd);
  }

  /** Make the next call to `cmd` fail with `message`. */
  failNext(cmd: string, message: string): Promise<void> {
    return this.page.evaluate(([name, text]) => window.__MQLENS_E2E__!.failNext(name, text), [cmd, message] as const);
  }
}

export const test = base.extend<{ collectCoverage: void; app: App }>({
  // Every test contributes to the coverage report. Chromium only: coverage is
  // read from V8, and WebKit runs the same tests for behaviour.
  collectCoverage: [
    async ({ page, browserName }, use) => {
      const enabled = browserName === 'chromium';
      if (enabled) await page.coverage.startJSCoverage({ resetOnNavigation: false });
      await use();
      if (enabled) {
        const entries = await page.coverage.stopJSCoverage();
        await new CoverageReport(coverageOptions).add(entries);
      }
    },
    { auto: true },
  ],

  app: async ({ page }, use) => {
    const app = new App(page);
    await use(app);
    if (!app.isOpen) return;
    // Two checks every test gets for free, so a flow can't pass while the app
    // is quietly broken underneath it.
    const health = await page.evaluate(() => ({
      unhandled: [...window.__MQLENS_E2E__!.unhandled],
      frontendErrors: window.__MQLENS_E2E__!.state.frontendErrors,
    }));
    expect(health.unhandled, 'backend commands the app called that the fake backend has no handler for').toEqual([]);
    expect(health.frontendErrors, 'uncaught errors the app reported through log_frontend_error').toEqual([]);
  },
});

export { expect };
