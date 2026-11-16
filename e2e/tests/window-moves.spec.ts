import type { Page } from '@playwright/test';
import { test, expect, type App } from '../fixtures';
import { callFrom, connectStaging, getEditorText, openCollection, openInNewTab, setEditorText, view } from '../helpers';

// Tabs and other windows (#396): moving a tab that holds a document draft, and
// what this window does with tabs another window holds. Other windows exist
// only as the backend describes them in `workspace-changed` broadcasts.

const strip = (page: Page) => page.getByTestId('workspace-tab-strip');
const sidebar = (page: Page) => page.getByRole('complementary');
const toast = (page: Page, text: string | RegExp) => page.getByTestId('dialog-toast').filter({ hasText: text });

interface StoredTab {
  id: string;
  type: string;
  profileId: string;
  profileName: string;
  db: string;
  collection: string;
  builderState?: unknown;
}

const stagingTab = (collection: string): StoredTab => ({
  id: `profile:p-staging.sales_db.${collection}`,
  type: 'collection',
  profileId: 'p-staging',
  profileName: 'Staging',
  db: 'sales_db',
  collection,
});

/** A workspace of this window's `main` tabs and a second window, `win-2`, showing its own. */
function workspace(revision: number, main: StoredTab[], win2: StoredTab[]) {
  const pane = (tabs: StoredTab[]) => ({ kind: 'pane', id: 'pane-1', tabIds: tabs.map((tab) => tab.id), activeTabId: tabs[0]?.id ?? null });
  return {
    revision,
    windows: [
      { id: 'main', splitTree: pane(main), focusedPaneId: 'pane-1' },
      { id: 'win-2', splitTree: pane(win2), focusedPaneId: 'pane-1' },
    ],
    tabs: [...main, ...win2],
  };
}

/** Tell this window that win-2 exists, holding `win2` (a window other than main always holds a tab), without changing this window's own tabs. */
const announceSecondWindow = (app: App, revision: number, win2: StoredTab[]) =>
  app.emit('workspace-changed', { revision, origin: 'win-2', crossWindow: false, workspace: workspace(revision, [], win2) });

const ops = async (app: App) => (await app.calls('workspace_apply')).map((call) => (call.args as { op: Record<string, unknown> }).op);

async function openTabMenu(page: Page, label: string): Promise<void> {
  await strip(page).getByText(label, { exact: true }).first().click({ button: 'right' });
  await expect(page.getByTestId('context-menu')).toBeVisible();
}

/** Staging's customers, a second window, and the insert editor open over the tab with a draft typed. */
async function draftOnCustomers(app: App, page: Page): Promise<void> {
  await connectStaging(app, page);
  await openCollection(page, 'sales_db', 'customers');
  await expect(view(page).getByText('Alice Smith').first()).toBeVisible();
  await announceSecondWindow(app, 70, [stagingTab('transactions')]);
  await view(page).getByTestId('insert-doc-btn').click();
  await setEditorText(page, page.getByTestId('document-edit-modal'), '{ "name": "Dana White" }');
}

test.describe('Moving a tab with a document draft', () => {
  test('saves the draft before the move, and holds the editor read-only while it lands', async ({ app, page }) => {
    await draftOnCustomers(app, page);
    const modal = page.getByTestId('document-edit-modal');

    await openTabMenu(page, 'customers');
    await page.getByTestId('context-menu').getByRole('menuitem', { name: /^Move to win-2/ }).click();
    await expect.poll(async () => (await ops(app)).some((op) => op.type === 'move_tab_to_window')).toBe(true);
    const sent = await ops(app);
    const draftAt = sent.findIndex((op) => op.type === 'update_tab_state' && JSON.stringify(op.document_edit ?? null).includes('Dana White'));
    expect(draftAt).toBeGreaterThanOrEqual(0);
    expect(draftAt).toBeLessThan(sent.findIndex((op) => op.type === 'move_tab_to_window'));

    // No broadcast takes the tab away here, so it stays frozen, with Save off.
    const save = modal.getByTestId('document-save-btn');
    await expect(save).toBeDisabled();

    // A move that never lands releases the editor after a while.
    await expect(save).toBeEnabled({ timeout: 20_000 });
    const inserted = await callFrom(app, 'insert_document', () => save.click());
    expect(JSON.parse(String(inserted.document))).toMatchObject({ name: 'Dana White' });
  });

  test('keeps the tab here when its draft cannot be saved', async ({ app, page }) => {
    await draftOnCustomers(app, page);

    // Two failures: the draft's own debounced write may go first, and a failed
    // write leaves the draft pending for the move's flush to try again.
    await app.failNext('workspace_apply', 'workspace store is busy');
    await app.failNext('workspace_apply', 'workspace store is busy');
    await openTabMenu(page, 'customers');
    await page.getByTestId('context-menu').getByRole('menuitem', { name: /^Move to win-2/ }).click();

    await expect(toast(page, /Could not save this tab.s document draft\. The tab was not moved\./)).toBeVisible();
    expect((await ops(app)).some((op) => op.type === 'move_tab_to_window')).toBe(false);
  });

  test('waits for a document save still on its way', async ({ app, page }) => {
    await draftOnCustomers(app, page);
    const modal = page.getByTestId('document-edit-modal');

    const release = await app.hold('insert_document');
    await modal.getByTestId('document-save-btn').click();
    await expect.poll(async () => (await app.calls('insert_document')).length).toBe(1);

    await openTabMenu(page, 'customers');
    await page.getByTestId('context-menu').getByRole('menuitem', { name: /^Move to win-2/ }).click();
    await expect(toast(page, 'Wait for the document save to finish before moving this tab.')).toBeVisible();
    expect((await ops(app)).some((op) => op.type === 'move_tab_to_window')).toBe(false);

    await release();
    await expect(modal).toHaveCount(0);
  });

  test('waits for a value saved in place in the grid (#554 review)', async ({ app, page }) => {
    await connectStaging(app, page);
    await openCollection(page, 'sales_db', 'customers');
    await expect(view(page).getByText('Alice Smith').first()).toBeVisible();
    await announceSecondWindow(app, 70, [stagingTab('transactions')]);
    await view(page).getByRole('button', { name: 'Table', exact: true }).click();
    await view(page).getByText('alice@example.com', { exact: true }).dblclick();
    await view(page).getByTestId('cell-editor').fill('"ada@example.com"');

    const release = await app.hold('update_document');
    await view(page).getByTestId('cell-editor').press('Enter');
    await expect.poll(async () => (await app.calls('update_document')).length).toBe(1);

    await openTabMenu(page, 'customers');
    await page.getByTestId('context-menu').getByRole('menuitem', { name: /^Move to win-2/ }).click();
    await expect(toast(page, 'Wait for the document save to finish before moving this tab.')).toBeVisible();
    expect((await ops(app)).some((op) => op.type === 'move_tab_to_window')).toBe(false);

    await release();
    await expect(view(page).getByText('ada@example.com', { exact: true })).toBeVisible();
  });

  test('does not save a value in place while the tab is on its way out (#554 review)', async ({ app, page }) => {
    await connectStaging(app, page);
    await openCollection(page, 'sales_db', 'customers');
    await expect(view(page).getByText('Alice Smith').first()).toBeVisible();
    await announceSecondWindow(app, 70, [stagingTab('transactions')]);
    await view(page).getByRole('button', { name: 'Table', exact: true }).click();

    // No broadcast takes the tab away, so it stays in the moving state.
    await openTabMenu(page, 'customers');
    await page.getByTestId('context-menu').getByRole('menuitem', { name: /^Move to win-2/ }).click();
    await expect.poll(async () => (await ops(app)).some((op) => op.type === 'move_tab_to_window')).toBe(true);

    await view(page).getByText('alice@example.com', { exact: true }).dblclick();
    await view(page).getByTestId('cell-editor').fill('"ada@example.com"');
    await view(page).getByTestId('cell-editor').press('Enter');
    await expect(view(page).getByTestId('cell-editor')).toHaveAttribute('title', 'This tab is being moved to another window.');
    expect(await app.calls('update_document')).toHaveLength(0);
  });
});

test.describe('Tabs another window holds', () => {
  test('the move menu names that window\'s tab, and opening its collection brings that window forward', async ({ app, page }) => {
    await connectStaging(app, page);
    await openCollection(page, 'sales_db', 'customers');
    await expect(view(page).getByText('Alice Smith').first()).toBeVisible();
    await announceSecondWindow(app, 80, [stagingTab('products')]);

    await openTabMenu(page, 'customers');
    await expect(page.getByTestId('context-menu').getByRole('menuitem', { name: 'Move to win-2 (products)' })).toBeVisible();
    await page.keyboard.press('Escape');

    const focused = await callFrom(app, 'focus_window', () => openInNewTab(page, 'products'));
    expect(focused.label).toBe('win-2');
    await expect(strip(page).getByText('products', { exact: true })).toHaveCount(0);
  });

  test('an export tab stays in its window through another window\'s change, and closes', async ({ app, page }) => {
    await connectStaging(app, page);
    await openCollection(page, 'sales_db', 'customers');
    await expect(view(page).getByText('Alice Smith').first()).toBeVisible();
    await view(page).getByTestId('export-btn').click();
    await expect(page.getByTestId('export-view')).toBeVisible();

    await openTabMenu(page, 'Export: customers');
    await expect(page.getByTestId('context-menu').getByRole('menuitem', { name: 'Export/import tabs stay in their window' })).toBeDisabled();
    await page.keyboard.press('Escape');

    // Another window's change describes this window without the export tab,
    // which was never shared, and hands it a tab with its query bar as it was.
    const builderState = {
      queryMode: 'find',
      filterQuery: '{ status: "Pending" }',
      sortQuery: '',
      projectionQuery: '',
      limit: '50',
      skip: '0',
      stages: [{ id: 'stage-1', operator: '$match', content: '{}' }],
    };
    const transactions = { ...stagingTab('transactions'), builderState };
    await app.emit('workspace-changed', {
      revision: 90,
      origin: 'win-2',
      crossWindow: true,
      workspace: workspace(90, [stagingTab('customers'), transactions], [stagingTab('products')]),
    });
    await expect(strip(page).getByText('transactions', { exact: true })).toBeVisible();
    await expect(strip(page).getByText('Export: customers', { exact: true })).toBeVisible();
    await strip(page).getByText('transactions', { exact: true }).click();
    await expect.poll(() => getEditorText(page, view(page).getByTestId('query-filter-input'))).toBe('{ status: "Pending" }');

    await strip(page).getByRole('button', { name: /^Close Export: customers/ }).click();
    await expect(strip(page).getByText('Export: customers', { exact: true })).toHaveCount(0);
    await expect(sidebar(page).getByRole('button', { name: 'Connection Staging' })).toBeVisible();
  });
});

test.describe('Undo of an edit in a tab that changes windows', () => {
  /** Staging's customers in the table, a second window, and an edit saved in place. */
  async function savedEdit(app: App, page: Page): Promise<void> {
    await connectStaging(app, page);
    await openCollection(page, 'sales_db', 'customers');
    await expect(view(page).getByText('Alice Smith').first()).toBeVisible();
    await announceSecondWindow(app, 70, [stagingTab('transactions')]);
    await view(page).getByRole('button', { name: 'Table', exact: true }).click();
    await view(page).getByText('alice@example.com', { exact: true }).dblclick();
    await view(page).getByTestId('cell-editor').fill('"ada@example.com"');
    await view(page).getByTestId('cell-editor').press('Enter');
    await expect(view(page).getByText('ada@example.com', { exact: true })).toBeVisible();
  }

  test('moving the tab to another window retires its Undo, which would write over a save made there', async ({ app, page }) => {
    await savedEdit(app, page);
    await openTabMenu(page, 'customers');
    await page.getByTestId('context-menu').getByRole('menuitem', { name: /^Move to win-2/ }).click();
    await expect.poll(async () => (await ops(app)).some((op) => op.type === 'move_tab_to_window')).toBe(true);

    await toast(page, 'Saved').getByRole('button', { name: 'Undo' }).click();
    await expect(toast(page, 'This edit can no longer be undone')).toBeVisible();
    expect(await app.calls('update_document')).toHaveLength(1);
  });

  test('a save refused after the move does not bring the Undo of the tab that moved', async ({ app, page }) => {
    await savedEdit(app, page);
    // A second tab on the same collection, with a save on its way.
    await openInNewTab(page, 'customers');
    await view(page).getByRole('button', { name: 'Table', exact: true }).click();
    const release = await app.hold('update_document');
    await view(page).getByText('bob@example.com', { exact: true }).dblclick();
    await view(page).getByTestId('cell-editor').fill('"bo@example.com"');
    await view(page).getByTestId('cell-editor').press('Enter');
    await expect.poll(async () => (await app.calls('update_document')).length).toBe(2);
    await app.failNext('update_document', 'Document failed validation');

    // The first tab, whose edit the Saved toast can undo, goes to win-2.
    await openTabMenu(page, 'Staging / sales_db:customers');
    await page.getByTestId('context-menu').getByRole('menuitem', { name: /^Move to win-2/ }).click();
    await expect.poll(async () => (await ops(app)).some((op) => op.type === 'move_tab_to_window')).toBe(true);
    await release();
    await expect(toast(page, 'Document failed validation')).toBeVisible();

    await toast(page, 'Saved').getByRole('button', { name: 'Undo' }).click();
    await expect(toast(page, 'This edit can no longer be undone')).toBeVisible();
    expect(await app.calls('update_document')).toHaveLength(2);
  });

  test('a document dialog that arrives from another window saves with no Undo', async ({ app, page }) => {
    await connectStaging(app, page);
    await openCollection(page, 'sales_db', 'products');
    // Opened over there, on a row this window never saw written: what it was
    // opened on, and what was written since, are not known here.
    const doc = { _id: { $oid: '603d779f4f102e3a105c3120' }, name: 'Alice Smith', email: 'alice@example.com' };
    const customers = {
      ...stagingTab('customers'),
      documentEdit: { id: 'edit-from-win-2', mode: 'edit', initialJson: JSON.stringify(doc), targetDoc: doc, draft: JSON.stringify({ ...doc, email: 'c@example.com' }) },
    };
    await app.emit('workspace-changed', {
      revision: 90,
      origin: 'win-2',
      crossWindow: true,
      workspace: workspace(90, [customers, stagingTab('products')], [stagingTab('transactions')]),
    });
    const modal = page.getByTestId('document-edit-modal');
    await expect(modal).toBeVisible();

    await callFrom(app, 'update_document', () => modal.getByTestId('document-save-btn').click());
    const saved = toast(page, 'Saved');
    await expect(saved).toBeVisible();
    expect(await saved.getByRole('button', { name: 'Undo' }).count()).toBe(0);
  });

  test('another window taking the tab retires its Undo too', async ({ app, page }) => {
    await savedEdit(app, page);
    await app.emit('workspace-changed', {
      revision: 80,
      origin: 'win-2',
      crossWindow: true,
      workspace: workspace(80, [stagingTab('products')], [stagingTab('transactions'), stagingTab('customers')]),
    });
    await expect(strip(page).getByText('customers', { exact: true })).toHaveCount(0);

    await toast(page, 'Saved').getByRole('button', { name: 'Undo' }).click();
    await expect(toast(page, 'This edit can no longer be undone')).toBeVisible();
    expect(await app.calls('update_document')).toHaveLength(1);
  });
});
