import type { Locator, Page } from '@playwright/test';
import { test, expect, type App } from '../fixtures';
import { connectStaging, dismissHoverCards, loadSample, openCollection } from '../helpers';

// Every kind of index MongoDB has, from the modal to the viewer and back.

const sidebar = (page: Page) => page.getByRole('complementary');
const view = (page: Page) => page.locator('[data-testid^="tab-content-"]:not([hidden])');
const toast = (page: Page, text: string) => page.getByTestId('dialog-toast').filter({ hasText: text });

async function openModal(page: Page): Promise<Locator> {
  await sidebar(page).getByText('indexes', { exact: true }).click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Create Index' }).click();
  const modal = page.getByTestId('index-modal');
  await expect(modal).toBeVisible();
  return modal;
}

/** A field typed by hand, so the test does not depend on the collection's schema having loaded. */
async function setKey(modal: Locator, row: number, field: string, type: string): Promise<void> {
  const select = modal.getByTestId(`index-key-field-${row}`);
  if ((await select.evaluate((el) => el.tagName)) === 'SELECT') await select.selectOption('__custom__');
  await modal.getByTestId(`index-key-field-${row}`).fill(field);
  await modal.getByTestId(`index-key-direction-${row}`).selectOption(type);
}

const option = (modal: Locator, name: string) => modal.getByTestId(`index-option-${name}`);

async function save(app: App, modal: Locator): Promise<Record<string, unknown>> {
  const before = (await app.calls('create_index')).length;
  await modal.getByTestId('save-index-btn').click();
  await expect(modal).toHaveCount(0);
  const calls = await app.calls('create_index');
  expect(calls).toHaveLength(before + 1);
  return JSON.parse((calls[before].args as { spec: string }).spec);
}

async function openIndex(page: Page, name: string): Promise<Locator> {
  await sidebar(page).getByText('indexes', { exact: true }).click();
  await dismissHoverCards(page);
  await sidebar(page).getByText(name, { exact: true }).click();
  await dismissHoverCards(page);
  const viewer = view(page).getByTestId('index-viewer');
  await expect(viewer.getByTestId('index-kind')).toBeVisible();
  return viewer;
}

test.describe('Creating each type of index', () => {
  test.beforeEach(async ({ app, page }) => {
    await app.open();
    await loadSample(page);
    await openCollection(page, 'sales_db', 'customers');
  });

  test('a text index, with its options, and an edit that keeps them', async ({ app, page }) => {
    const modal = await openModal(page);
    await setKey(modal, 0, 'bio', 'text');
    await modal.getByRole('button', { name: 'Add Index Key' }).click();
    await setKey(modal, 1, 'title', 'text');
    await expect(modal.getByTestId('index-name-input')).toHaveValue('bio_text_title_text');
    await option(modal, 'weights').fill('{ "title": 5 }');
    await option(modal, 'defaultLanguage').fill('german');
    await option(modal, 'languageOverride').fill('lang');
    await option(modal, 'textIndexVersion').fill('3');

    expect(await save(app, modal)).toEqual({
      key: { bio: 'text', title: 'text' },
      name: 'bio_text_title_text',
      weights: { title: 5 },
      default_language: 'german',
      language_override: 'lang',
      textIndexVersion: 3,
    });

    const viewer = view(page).getByTestId('index-viewer');
    await expect(viewer.getByTestId('index-kind')).toHaveText('Text');
    await expect(viewer.getByTestId('index-option-default_language')).toHaveText('german');
    await expect(viewer).toContainText('"_fts"');

    // Hidden changes in place, and an unchanged save writes nothing.
    await viewer.getByTestId('edit-index-btn').click();
    const edit = page.getByTestId('index-modal');
    await expect(edit.getByTestId('index-key-field-0')).toHaveValue('bio');
    await expect(edit.getByTestId('index-key-direction-1')).toHaveValue('text');
    await expect(edit.getByTestId('index-rebuild-hint')).toBeVisible();
    await edit.getByTestId('save-index-btn').click();
    await expect(edit).toHaveCount(0);
    expect(await app.calls('delete_index')).toHaveLength(0);

    await viewer.getByTestId('edit-index-btn').click();
    await edit.getByTestId('hidden-checkbox').check();
    await edit.getByTestId('save-index-btn').click();
    await expect(edit).toHaveCount(0);
    await expect(viewer.getByTestId('index-hidden')).toBeVisible();
    expect(await app.calls('delete_index')).toHaveLength(0);

    // Anything else rebuilds, with everything the form did not touch.
    await viewer.getByTestId('edit-index-btn').click();
    await option(edit, 'defaultLanguage').fill('french');
    expect(await save(app, edit)).toEqual({
      key: { bio: 'text', title: 'text' },
      name: 'bio_text_title_text',
      weights: { title: 5, bio: 1 },
      default_language: 'french',
      language_override: 'lang',
      textIndexVersion: 3,
      hidden: true,
    });
    expect(await app.calls('delete_index')).toHaveLength(1);
    await expect(view(page).getByTestId('index-viewer').getByTestId('index-option-default_language')).toHaveText('french');
  });

  test('a 2dsphere index', async ({ app, page }) => {
    const modal = await openModal(page);
    await setKey(modal, 0, 'loc', '2dsphere');
    await option(modal, 'sphereIndexVersion').fill('3');
    expect(await save(app, modal)).toEqual({ key: { loc: '2dsphere' }, name: 'loc_2dsphere', '2dsphereIndexVersion': 3 });
    await expect(view(page).getByTestId('index-viewer').getByTestId('index-kind')).toHaveText('2dsphere');
  });

  test('a 2d index', async ({ app, page }) => {
    const modal = await openModal(page);
    await setKey(modal, 0, 'pt', '2d');
    await option(modal, 'bits').fill('20');
    await option(modal, 'min').fill('-10');
    await option(modal, 'max').fill('100');
    expect(await save(app, modal)).toEqual({ key: { pt: '2d' }, name: 'pt_2d', bits: 20, min: -10, max: 100 });
    await expect(view(page).getByTestId('index-viewer').getByTestId('index-option-bits')).toHaveText('20');
  });

  test('a hashed index', async ({ app, page }) => {
    const modal = await openModal(page);
    await setKey(modal, 0, 'uid', 'hashed');
    expect(await save(app, modal)).toEqual({ key: { uid: 'hashed' }, name: 'uid_hashed' });
    await expect(view(page).getByTestId('index-viewer').getByTestId('index-kind')).toHaveText('Hashed');
  });

  test('a wildcard index with a projection', async ({ app, page }) => {
    const modal = await openModal(page);
    await setKey(modal, 0, '$**', '1');
    await option(modal, 'wildcardProjection').fill('{ "tags": 1 }');
    expect(await save(app, modal)).toEqual({ key: { '$**': 1 }, name: '$**_1', wildcardProjection: { tags: 1 } });
    await expect(view(page).getByTestId('index-viewer').getByTestId('index-kind')).toHaveText('Wildcard');
  });

  test('a compound wildcard index needs its projection', async ({ app, page }) => {
    const modal = await openModal(page);
    await setKey(modal, 0, 'tier', '1');
    await modal.getByRole('button', { name: 'Add Index Key' }).click();
    await setKey(modal, 1, '$**', '1');
    await modal.getByTestId('save-index-btn').click();
    await expect(modal).toContainText('A compound wildcard index on all fields needs a wildcard projection');
    expect(await app.calls('create_index')).toHaveLength(0);

    await option(modal, 'wildcardProjection').fill('{ "tier": 0 }');
    expect(await save(app, modal)).toMatchObject({ key: { tier: 1, '$**': 1 }, wildcardProjection: { tier: 0 } });
  });

  test('every general option, shown in the list and the viewer', async ({ app, page }) => {
    const modal = await openModal(page);
    await setKey(modal, 0, 'tier', '1');
    await modal.getByTestId('index-name-input').fill('tier_everything');
    await modal.getByTestId('unique-checkbox').check();
    await modal.getByTestId('hidden-checkbox').check();
    await option(modal, 'partialFilterExpression').fill('{ "joined": { "$gt": { "$date": "2026-01-01T00:00:00Z" } }, "tier": { "$in": ["Gold"] } }');
    await option(modal, 'collation').fill('{ "locale": "de", "strength": 2 }');
    await option(modal, 'storageEngine').fill('{ "wiredTiger": {} }');
    await modal.getByTestId('index-commit-quorum').fill('majority');
    const before = await app.calls('create_index');
    expect(await save(app, modal)).toEqual({
      key: { tier: 1 },
      name: 'tier_everything',
      unique: true,
      hidden: true,
      partialFilterExpression: { joined: { $gt: { $date: '2026-01-01T00:00:00Z' } }, tier: { $in: ['Gold'] } },
      collation: { locale: 'de', strength: 2 },
      storageEngine: { wiredTiger: {} },
    });
    expect((await app.calls('create_index'))[before.length].args).toMatchObject({ commitQuorum: 'majority' });
  });

  test('refuses what MongoDB would refuse, before writing anything', async ({ app, page }) => {
    const modal = await openModal(page);
    await setKey(modal, 0, 'tier', '1');
    const save = modal.getByTestId('save-index-btn');

    await modal.getByTestId('sparse-checkbox').check();
    await option(modal, 'partialFilterExpression').fill('{ "tier": "Gold" }');
    await save.click();
    await expect(modal).toContainText('A partial filter cannot be used with sparse');
    await modal.getByTestId('sparse-checkbox').uncheck();

    await option(modal, 'partialFilterExpression').fill('{ "tier": { "$ne": "Gold" } }');
    await save.click();
    await expect(modal).toContainText('A partial filter cannot use $ne');

    await option(modal, 'partialFilterExpression').fill('{ "tier": { "$exists": false } }');
    await save.click();
    await expect(modal).toContainText('A partial filter can only use $exists: true');

    await option(modal, 'partialFilterExpression').fill('{ "$nor": [{ "tier": "Gold" }] }');
    await save.click();
    await expect(modal).toContainText('A partial filter cannot use $nor');

    await option(modal, 'partialFilterExpression').fill('nope');
    await save.click();
    await expect(modal).toContainText('partialFilterExpression must be a JSON object');
    await option(modal, 'partialFilterExpression').fill('');

    await modal.getByTestId('index-key-direction-0').selectOption('hashed');
    await modal.getByTestId('unique-checkbox').check();
    await save.click();
    await expect(modal).toContainText('A hashed index cannot be unique');

    await modal.getByRole('button', { name: 'Add Index Key' }).click();
    await setKey(modal, 1, 'email', 'hashed');
    await save.click();
    await expect(modal).toContainText('A hashed index can hash only one field');
    await modal.getByTitle('Remove Key').nth(1).click();

    await setKey(modal, 0, '$**', '1');
    await save.click();
    await expect(modal).toContainText('A wildcard index cannot be unique');
    await modal.getByTestId('unique-checkbox').uncheck();
    await modal.getByTestId('sparse-checkbox').check();
    await save.click();
    await expect(modal).toContainText('A wildcard index cannot be sparse');
    await modal.getByTestId('sparse-checkbox').uncheck();
    await modal.getByTestId('ttl-checkbox').check();
    await modal.getByTestId('ttl-seconds-input').fill('60');
    await save.click();
    await expect(modal).toContainText('A wildcard index cannot have a TTL');
    await modal.getByTestId('ttl-checkbox').uncheck();

    await setKey(modal, 0, 'tags.$**', '1');
    await option(modal, 'wildcardProjection').fill('{ "a": 1 }');
    await save.click();
    await expect(modal).toContainText('A wildcard projection needs the key $**');
    await option(modal, 'wildcardProjection').fill('');

    await setKey(modal, 0, 'bio', 'text');
    await option(modal, 'collation').fill('{ "locale": "en" }');
    await save.click();
    await expect(modal).toContainText('Text and 2d indexes cannot have a collation');
    await option(modal, 'collation').fill('');

    await option(modal, 'weights').fill('{ "title": 2 }');
    await save.click();
    await expect(modal).toContainText('Text weights name title, which is not a text key');
    await option(modal, 'weights').fill('');

    await setKey(modal, 0, 'pt', '2d');
    await option(modal, 'bits').fill('many');
    await save.click();
    await expect(modal).toContainText('bits must be a number');

    expect(await app.calls('create_index')).toHaveLength(0);
  });

  test('switches a special key to raw JSON and back', async ({ app, page }) => {
    const modal = await openModal(page);
    await setKey(modal, 0, 'loc', '2dsphere');
    await modal.getByRole('tab', { name: 'Raw JSON' }).click();
    await expect(modal.getByPlaceholder('{ "email": 1 }')).toHaveValue(/"loc": "2dsphere"/);
    await modal.getByPlaceholder('{ "email": 1 }').fill('{ "loc": "2dsphere", "at": -1 }');
    await modal.getByRole('tab', { name: 'Key Builder' }).click();
    await expect(modal.getByTestId('index-key-direction-1')).toHaveValue('-1');
    expect((await save(app, modal)).key).toEqual({ loc: '2dsphere', at: -1 });
  });
});

test.describe('Changing an index in place', () => {
  test.beforeEach(async ({ app, page }) => {
    await connectStaging(app, page);
    await openCollection(page, 'sales_db', 'customers');
  });

  test('hides and unhides it', async ({ app, page }) => {
    const viewer = await openIndex(page, 'tier_1');
    await viewer.getByTestId('hide-index-btn').click();
    await expect(viewer.getByTestId('index-hidden')).toBeVisible();
    await expect(viewer.getByTestId('hide-index-btn')).toHaveText('Unhide Index');
    await viewer.getByTestId('hide-index-btn').click();
    await expect(viewer.getByTestId('index-hidden')).toHaveCount(0);
    const calls = await app.calls('set_index_option');
    expect(calls.map((c) => (c.args as { value: boolean }).value)).toEqual([true, false]);
  });

  test('says when it cannot be changed', async ({ app, page }) => {
    const viewer = await openIndex(page, 'tier_1');
    await app.failNext('set_index_option', 'not authorized on sales_db to run collMod');
    await viewer.getByTestId('hide-index-btn').click();
    await expect(toast(page, 'not authorized on sales_db to run collMod')).toBeVisible();
    await expect(viewer.getByTestId('index-hidden')).toHaveCount(0);
  });

  test('converts it to unique once asked', async ({ app, page }) => {
    const viewer = await openIndex(page, 'email_1');
    await viewer.getByTestId('convert-unique-btn').click();
    await page.getByTestId('dialog-cancel').click();
    expect(await app.calls('set_index_option')).toHaveLength(0);

    await viewer.getByTestId('convert-unique-btn').click();
    await expect(page.getByTestId('dialog-title')).toHaveText('Make this index unique?');
    await page.getByTestId('dialog-confirm').click();
    await expect(viewer.getByTestId('convert-unique-btn')).toHaveCount(0);
    await expect(viewer).toContainText('"unique": true');
  });

  test('stays prepared when duplicates stop the conversion, and can stop', async ({ page }) => {
    const viewer = await openIndex(page, 'tier_1');
    await viewer.getByTestId('convert-unique-btn').click();
    await page.getByTestId('dialog-confirm').click();
    await expect(toast(page, 'The index stays non-unique')).toBeVisible();
    await expect(viewer.getByTestId('index-option-prepareUnique')).toHaveText('true');

    await viewer.getByTestId('stop-prepare-unique-btn').click();
    await expect(viewer.getByTestId('index-option-prepareUnique')).toHaveCount(0);
    await expect(viewer.getByTestId('stop-prepare-unique-btn')).toHaveCount(0);
  });
});

test.describe('A rebuild that fails', () => {
  test.beforeEach(async ({ app, page }) => {
    await connectStaging(app, page);
    await openCollection(page, 'sales_db', 'customers');
  });

  test('puts the old index back and says so', async ({ app, page }) => {
    const viewer = await openIndex(page, 'tier_1');
    await viewer.getByTestId('edit-index-btn').click();
    const modal = page.getByTestId('index-modal');
    await modal.getByTestId('unique-checkbox').check();
    await app.failNext('create_index', 'E11000 duplicate key error');
    await modal.getByTestId('save-index-btn').click();

    await expect(toast(page, 'put back as it was: E11000 duplicate key error')).toBeVisible();
    await expect(modal).toBeVisible();
    const creates = await app.calls('create_index');
    expect(JSON.parse((creates.at(-1)?.args as { spec: string }).spec)).toEqual({ key: { tier: 1 }, name: 'tier_1' });
    await modal.getByRole('button', { name: 'Cancel' }).click();
    await expect(sidebar(page).getByText('tier_1', { exact: true })).toBeVisible();
    await expect(viewer.getByTestId('index-kind')).toBeVisible();
  });

  test('moves to the new name, closing the old tab', async ({ page }) => {
    const viewer = await openIndex(page, 'tier_1');
    await viewer.getByTestId('edit-index-btn').click();
    const modal = page.getByTestId('index-modal');
    await modal.getByTestId('index-name-input').fill('tier_renamed');
    await modal.getByTestId('save-index-btn').click();
    await expect(modal).toHaveCount(0);
    await expect(view(page).getByTestId('index-viewer')).toContainText('tier_renamed');
    await expect(page.getByTestId('workspace-tab-strip').getByText('tier_1', { exact: true })).toHaveCount(0);
  });

  test('gives the old definition when it cannot', async ({ page }) => {
    const viewer = await openIndex(page, 'tier_1');
    await viewer.getByTestId('edit-index-btn').click();
    const modal = page.getByTestId('index-modal');
    await modal.getByTestId('unique-checkbox').check();
    await page.evaluate(() => {
      window.__MQLENS_E2E__!.register({
        create_index: () => {
          throw 'connection lost';
        },
      });
    });
    await modal.getByTestId('save-index-btn').click();
    const lost = toast(page, 'could not be put back: connection lost');
    await expect(lost).toBeVisible();
    await expect(lost).toContainText('"key":{"tier":1}');
  });
});

test.describe('Index builds', () => {
  const BUILD = {
    opid: 7,
    op: 'command',
    ns: 'sales_db.customers',
    secsRunning: 12,
    client: '',
    desc: 'IndexBuildsCoordinatorMongod-0',
    command: '{ "createIndexes": "customers", "indexes": [{ "v": 2, "key": { "bio": 1 }, "name": "bio_1" }] }',
    progress: { done: 25, total: 100 },
  };

  test('shows a build until it ends, then lists the index', async ({ app, page }) => {
    await connectStaging(app, page, { monitoring: { currentOps: [BUILD] } as never });
    await openCollection(page, 'sales_db', 'customers');
    await sidebar(page).getByText('indexes', { exact: true }).click();
    await dismissHoverCards(page);
    const overview = view(page).getByTestId('collection-indexes');
    const banner = overview.getByTestId('index-builds');
    await expect(banner).toHaveText('Building bio_1: 25% (12 s)');

    await page.evaluate(() => {
      window.__MQLENS_E2E__!.register({ current_ops: () => [] });
    });
    await expect(banner).toHaveCount(0, { timeout: 10_000 });
    await expect(overview.getByTestId('index-row-email_1')).toBeVisible();
    expect((await app.calls('list_indexes')).length).toBeGreaterThan(1);
  });

  test('stays out of the way when operations cannot be read', async ({ app, page }) => {
    await connectStaging(app, page);
    await openCollection(page, 'sales_db', 'customers');
    await app.failNext('current_ops', 'not authorized on admin to run currentOp');
    await sidebar(page).getByText('indexes', { exact: true }).click();
    await dismissHoverCards(page);
    const overview = view(page).getByTestId('collection-indexes');
    await expect(overview.getByTestId('index-row-email_1')).toBeVisible();
    await expect(overview.getByTestId('index-builds')).toHaveCount(0);
  });
});
