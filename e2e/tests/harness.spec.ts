import { test, expect } from '../fixtures';

// The plumbing (#396): Playwright starts Vite, the harness installs the fake
// backend before the app loads, and the app boots all the way to Quick Start
// without calling anything the fake backend doesn't answer.
test('boots the real app to Quick Start on the fake backend', async ({ app, page }) => {
  await app.open();

  await expect(page.getByTestId('quickstart-tab')).toBeVisible();
  await expect(page.getByTestId('qs-load-sample')).toBeVisible();
  expect((await app.calls('vault_status')).length).toBeGreaterThan(0);
});
