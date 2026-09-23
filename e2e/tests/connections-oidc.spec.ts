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

  test('"Open browser again" reopens the pending test login, by its own loginId', async ({ app, page }) => {
    await app.open();
    await openNewConnectionEditor(page);
    await page.getByTestId('host-list').fill('mongo.corp.example.com:27017');
    await page.getByRole('button', { name: 'Authentication', exact: true }).click();
    await page.getByTestId('auth-method-select').click();
    await page.getByRole('option', { name: 'OIDC (browser login)', exact: true }).click();
    await page.getByRole('button', { name: 'Test Connection', exact: true }).click();

    await page.getByRole('button', { name: 'Open browser again', exact: true }).click();

    await expect.poll(async () => (await app.calls('reopen_oidc_login')).length).toBe(1);
    const testCall = (await app.calls('test_connection_uri'))[0];
    const reopenCall = (await app.calls('reopen_oidc_login'))[0];
    expect((reopenCall.args as { loginId: string }).loginId).toBe((testCall.args as { loginId: string }).loginId);
    // Reopening does not end the login: Cancel is still on offer.
    await expect(page.getByRole('button', { name: 'Cancel login', exact: true })).toBeVisible();
  });

  test('a connect from the editor can reopen and cancel its own browser login', async ({ app, page }) => {
    await app.open();
    await openNewConnectionEditor(page);
    await page.getByTestId('host-list').fill('mongo.corp.example.com:27017');
    await page.getByRole('button', { name: 'Authentication', exact: true }).click();
    await page.getByTestId('auth-method-select').click();
    await page.getByRole('option', { name: 'OIDC (browser login)', exact: true }).click();

    await page.getByTestId('editor-connect-btn').click();

    await page.getByTestId('connect-reopen-login').click();
    await expect.poll(async () => (await app.calls('reopen_oidc_login')).length).toBe(1);
    const connectCall = (await app.calls('connect_db'))[0];
    const loginId = (connectCall.args as { loginId: string }).loginId;
    expect(typeof loginId).toBe('string');
    expect(((await app.calls('reopen_oidc_login'))[0].args as { loginId: string }).loginId).toBe(loginId);

    await page.getByTestId('connect-cancel-login').click();
    await expect.poll(async () => (await app.calls('cancel_oidc_login')).length).toBe(1);
    expect(((await app.calls('cancel_oidc_login'))[0].args as { loginId: string }).loginId).toBe(loginId);
    await expect(page.getByTestId('connect-cancel-login')).not.toBeVisible();
    await expect(page.getByTestId('connect-error-summary')).toContainText('The login was cancelled.');
  });

  test('"Use ID token instead of access token" reaches the backend as use_id_token (T21)', async ({ app, page }) => {
    await app.open();
    await openNewConnectionEditor(page);
    await page.getByLabel('Display Name').fill('cidaas OIDC');
    await page.getByTestId('host-list').fill('mongo.corp.example.com:27017');

    await page.getByRole('button', { name: 'Authentication', exact: true }).click();
    await page.getByTestId('auth-method-select').click();
    await page.getByRole('option', { name: 'OIDC (browser login)', exact: true }).click();
    const useIdToken = page.getByRole('checkbox', { name: 'Use ID token instead of access token', exact: true });
    await expect(useIdToken).not.toBeChecked();
    await useIdToken.check();

    await page.getByRole('button', { name: 'Test Connection', exact: true }).click();

    await expect.poll(async () => (await app.calls('test_connection_uri')).length).toBe(1);
    const testCall = (await app.calls('test_connection_uri'))[0];
    // Snake_case inside the struct: Tauri converts only top-level argument names.
    expect((testCall.args as { oidc: unknown }).oidc).toEqual({ use_id_token: true });
  });
});
