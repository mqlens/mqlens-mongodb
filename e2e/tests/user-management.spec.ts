import type { Page } from '@playwright/test';
import { test, expect, type App } from '../fixtures';
import { connectStaging, dismissHoverCards } from '../helpers';

// Managing database users (#396): the Users tab opened on one database, the
// checks before a user is written, and the menus that offer to add one.

const sidebar = (page: Page) => page.getByRole('complementary');
const users = (page: Page) => page.getByTestId('user-management-view');

/** Open the Users tab scoped to sales_db. */
async function openDatabaseUsers(app: App, page: Page): Promise<void> {
  await connectStaging(app, page);
  await sidebar(page).getByRole('button', { name: 'Database sales_db' }).click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Manage Users', exact: true }).click();
  await dismissHoverCards(page);
}

test.describe('Users of one database', () => {
  test('opens on that database, says why it could not list them, and asks again', async ({ app, page }) => {
    await connectStaging(app, page);
    await app.failNext('list_users', 'not authorized on sales_db to execute command { usersInfo: 1 }');
    await sidebar(page).getByRole('button', { name: 'Database sales_db' }).click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Manage Users', exact: true }).click();
    await dismissHoverCards(page);

    await expect(users(page)).toContainText('not authorized on sales_db');
    await users(page).getByTestId('refresh-users-btn').click();

    // The scope is the database it was opened on, so only its users are listed.
    await expect(users(page).getByTestId('user-db-scope')).toContainText('sales_db');
    await expect(users(page).getByTestId('user-row-sales_db.app_user')).toBeVisible();
    await expect(users(page).getByTestId('user-row-admin.admin')).toHaveCount(0);
  });

  test('offers to add a user where there is none, and from the list itself', async ({ app, page }) => {
    await openDatabaseUsers(app, page);
    await expect(users(page).getByTestId('users-tree')).toBeVisible();

    // The blank space beside the rows offers the same menu a row does.
    await users(page).getByTestId('users-tree').click({ button: 'right', position: { x: 20, y: 8 } });
    await page.getByRole('menuitem', { name: 'Create User' }).click();
    await page.getByTestId('close-user-editor').click();

    // A database with no users of its own has only the empty state to click.
    await users(page).getByTestId('user-db-scope').click();
    await page.getByRole('option', { name: 'user_analytics' }).click();
    await expect(users(page)).toContainText('No users found in user_analytics');

    await users(page).getByText('No users found in user_analytics').click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Create User' }).click();
    await expect(page.getByTestId('user-editor-modal')).toBeVisible();
  });

  test('a new user is not written without a password, and a drop can be called off', async ({ app, page }) => {
    await openDatabaseUsers(app, page);

    await users(page).getByTestId('create-user-btn').click();
    const editor = page.getByTestId('user-editor-modal');
    await editor.getByTestId('user-name-input').fill('reporter');
    // The field is required, so the form does not even reach its own check.
    await editor.getByTestId('save-user-btn').click();
    await expect(editor).toBeVisible();
    expect(await app.calls('create_user')).toHaveLength(0);
    await page.getByTestId('close-user-editor').click();

    await users(page).getByTestId('user-row-sales_db.analyst').click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Drop User' }).click();
    await page.getByTestId('dialog-cancel').click();
    expect(await app.calls('drop_user')).toHaveLength(0);
    await expect(users(page).getByTestId('user-row-sales_db.analyst')).toBeVisible();
  });
});
