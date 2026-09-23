import type { Page } from '@playwright/test';
import { test, expect } from '../fixtures';

/** Quick Start → Connection Manager → a blank connection editor. */
async function openNewConnectionEditor(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'New connection', exact: true }).first().click();
  await page.getByRole('button', { name: 'New...', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'New Connection' })).toBeVisible();
}

test.describe('OIDC waiting-for-browser-login UI (#430)', () => {
  test('shows the authenticate row and cancel/reopen, and cancelling resets the dialog', async ({ app, page }) => {
    await app.open();
    await openNewConnectionEditor(page);
    await page.getByLabel('Display Name').fill('Corp OIDC');
    await page.getByTestId('host-list').fill('mongo.corp.example.com:27017');

    await page.getByRole('button', { name: 'Authentication', exact: true }).click();
    await page.getByTestId('auth-method-select').click();
    await page.getByRole('option', { name: 'OIDC (browser login)', exact: true }).click();

    await page.getByRole('button', { name: 'Test Connection', exact: true }).click();

    // The Authenticate row appears once the backend's `authenticate` phase
    // arrives, with Cancel/Reopen available while it's running.
    await expect(page.getByText(/waiting for browser login/i)).toBeVisible();
    const cancelBtn = page.getByRole('button', { name: 'Cancel login', exact: true });
    await expect(cancelBtn).toBeVisible();
    await expect(page.getByRole('button', { name: 'Open browser again', exact: true })).toBeVisible();

    const testCall = (await app.calls('test_connection_uri'))[0];
    const loginId = (testCall.args as { loginId: string }).loginId;
    expect(typeof loginId).toBe('string');
    expect(loginId.length).toBeGreaterThan(0);

    await cancelBtn.click();

    // The fake backend recorded the cancel with the exact loginId the test
    // call carried — not a different or missing one.
    await expect.poll(async () => (await app.calls('cancel_oidc_login')).length).toBe(1);
    const cancelCall = (await app.calls('cancel_oidc_login'))[0];
    expect((cancelCall.args as { loginId: string }).loginId).toBe(loginId);

    // The dialog resets: no row still claims to be running, and the
    // Cancel/Reopen buttons — which only make sense while a login is
    // pending — are gone.
    await expect(cancelBtn).not.toBeVisible();
    await expect(page.getByTestId('test-step-ping')).not.toHaveAttribute('data-status', 'running');
    await expect(page.getByTestId('test-step-authenticate')).toHaveAttribute('data-status', 'failed');
  });
});
