import { test, expect } from '../fixtures';

// The vault's own screen (#396): what it calls the reader it found, and what
// it says when the reset it offers is refused.

test.describe('The unlock screen', () => {
  test('names Face ID when that is what the machine has', async ({ app, page }) => {
    await app.open({
      vault: 'locked',
      vaultPassword: 's3cret',
      // Without a refusal the gate unlocks on its own and the button never shows.
      biometric: { available: true, enrolled: true, biometryType: 3, unlockError: 'not now' },
    });

    await expect(page.getByTestId('vault-biometric-btn')).toContainText('Face ID');
  });

  test('falls back to a plain name for a reader it does not recognise', async ({ app, page }) => {
    await app.open({
      vault: 'locked',
      vaultPassword: 's3cret',
      biometric: { available: true, enrolled: true, biometryType: 9, unlockError: 'not now' },
    });

    const button = page.getByTestId('vault-biometric-btn');
    await expect(button).toBeVisible();
    await expect(button).not.toContainText('Touch ID');
    await expect(button).not.toContainText('Face ID');
  });

  test('says why a reset it offered could not be done', async ({ app, page }) => {
    await app.open({ vault: 'locked', vaultPassword: 's3cret' });
    page.once('dialog', (dialog) => void dialog.accept());
    await app.failNext('vault_reset', 'the vault file is in use');

    await page.getByTestId('vault-reset-btn').click();

    await expect(page.getByTestId('vault-error')).toContainText('the vault file is in use');
    await expect(page.getByTestId('vault-unlock')).toBeVisible();
  });
});
