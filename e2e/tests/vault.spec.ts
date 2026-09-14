import { test, expect } from '../fixtures';

test.describe('Vault: first run', () => {
  test('sets a master password and opens the app', async ({ app, page }) => {
    await app.open({ vault: 'uninitialized' });
    await expect(page.getByTestId('vault-setup')).toBeVisible();

    await page.getByTestId('vault-password').fill('correct horse');
    await page.getByTestId('vault-confirm').fill('correct horse');
    await page.getByTestId('vault-setup-btn').click();

    await expect(page.getByTestId('quickstart-tab')).toBeVisible();
    expect(await app.calls('vault_initialize')).toMatchObject([{ args: { password: 'correct horse' } }]);
  });

  test('refuses passwords that do not match, without asking the backend', async ({ app, page }) => {
    await app.open({ vault: 'uninitialized' });

    await page.getByTestId('vault-password').fill('correct horse');
    await page.getByTestId('vault-confirm').fill('battery staple');
    await page.getByTestId('vault-setup-btn').click();

    await expect(page.getByTestId('vault-error')).toBeVisible();
    await expect(page.getByTestId('vault-setup')).toBeVisible();
    expect(await app.calls('vault_initialize')).toHaveLength(0);
  });

  test('refuses an empty password', async ({ app, page }) => {
    await app.open({ vault: 'uninitialized' });

    await page.getByTestId('vault-setup-btn').click();

    await expect(page.getByTestId('vault-error')).toBeVisible();
    expect(await app.calls('vault_initialize')).toHaveLength(0);
  });
});

test.describe('Vault: locked', () => {
  const seed = { vault: 'locked' as const, vaultPassword: 's3cret' };

  test('shows the backend error for a wrong password and stays locked', async ({ app, page }) => {
    await app.open(seed);
    await expect(page.getByTestId('vault-unlock')).toBeVisible();

    await page.getByTestId('vault-password').fill('wrong');
    await page.getByTestId('vault-unlock-btn').click();

    await expect(page.getByTestId('vault-error')).toHaveText('Incorrect master password');
    await expect(page.getByTestId('vault-unlock')).toBeVisible();
  });

  test('unlocks with the right password, submitted with Enter', async ({ app, page }) => {
    await app.open(seed);

    await page.getByTestId('vault-password').fill('s3cret');
    await page.getByTestId('vault-password').press('Enter');

    await expect(page.getByTestId('quickstart-tab')).toBeVisible();
    expect(await app.calls('vault_unlock')).toMatchObject([{ args: { password: 's3cret' } }]);
  });

  test('reset, once confirmed, returns to first-run setup', async ({ app, page }) => {
    await app.open(seed);

    page.once('dialog', (dialog) => dialog.accept());
    await page.getByTestId('vault-reset-btn').click();

    await expect(page.getByTestId('vault-setup')).toBeVisible();
    expect(await app.calls('vault_reset')).toHaveLength(1);
  });

  test('dismissing the reset confirmation keeps the vault', async ({ app, page }) => {
    await app.open(seed);

    page.once('dialog', (dialog) => dialog.dismiss());
    await page.getByTestId('vault-reset-btn').click();

    await expect(page.getByTestId('vault-unlock')).toBeVisible();
    expect(await app.calls('vault_reset')).toHaveLength(0);
  });
});
