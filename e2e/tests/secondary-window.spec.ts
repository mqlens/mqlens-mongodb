import type { Page } from '@playwright/test';
import { test, expect } from '../fixtures';
import { SAMPLE_SERVER } from '../harness/seed';
import { STAGING_URI } from '../helpers';

// A window other than the first one (#396). Every window runs the same app and
// boots from the same saved workspace, but hydrates only its own slice of it —
// and a secondary window with no slice left has nothing to be, so it closes.

const strip = (page: Page) => page.getByTestId('workspace-tab-strip');

const storedTab = (collection: string) => ({
  id: `profile:p-staging.sales_db.${collection}`,
  type: 'collection',
  profileId: 'p-staging',
  profileName: 'Staging',
  db: 'sales_db',
  collection,
});

const pane = (id: string, tabIds: string[]) => ({ kind: 'pane', id, tabIds, activeTabId: tabIds[0] ?? null });

/** A saved workspace whose `main` window holds customers, and `win-2` whatever `win2` names. */
const workspace = (win2: string[]) => ({
  revision: 4,
  windows: [
    { id: 'main', splitTree: pane('pane-1', [storedTab('customers').id]), focusedPaneId: 'pane-1' },
    ...(win2.length > 0
      ? [{ id: 'win-2', splitTree: pane('pane-2', win2.map((c) => storedTab(c).id)), focusedPaneId: 'pane-2' }]
      : []),
  ],
  tabs: [storedTab('customers'), ...win2.map(storedTab)],
});

const base = {
  windowLabel: 'win-2',
  profiles: [{ id: 'p-staging', name: 'Staging', uri: STAGING_URI }],
  servers: { [STAGING_URI]: SAMPLE_SERVER },
};

test.describe('A second window', () => {
  test('restores only the tabs saved under its own label', async ({ app, page }) => {
    await app.open({ ...base, workspace: workspace(['products', 'transactions']) });

    await expect(strip(page).getByText('products', { exact: true })).toBeVisible();
    await expect(strip(page).getByText('transactions', { exact: true })).toBeVisible();
    // The other window's tab, and the Quick Start the initializers default to,
    // both belong to `main` — neither is this window's to show.
    await expect(strip(page).getByText('customers', { exact: true })).toHaveCount(0);
    await expect(strip(page).getByText('Quick Start', { exact: true })).toHaveCount(0);

    // Recreating the saved windows is the first window's job; a secondary one
    // doing it too would spawn the whole set a second time.
    expect(await app.calls('spawn_saved_windows')).toEqual([]);
    expect(await app.takeFrontendErrors()).toEqual([]);
  });

  test('closes itself when the workspace has nothing left under its label', async ({ app, page }) => {
    await app.open({ ...base, workspace: workspace([]) });

    // No Quick Start to fall back on: a secondary window with no tabs is over.
    await expect.poll(async () => await app.calls('close_workspace_window')).toEqual([
      expect.objectContaining({ args: { label: 'win-2', origin: 'win-2' } }),
    ]);
    await expect(strip(page).getByText('Quick Start', { exact: true })).toHaveCount(0);
    expect(await app.takeFrontendErrors()).toEqual([]);
  });
});
