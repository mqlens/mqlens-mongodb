import { test, expect } from '../fixtures';
import type { Doc } from '../harness/seed';
import { STAGING_URI, connectStaging, getEditorText, openCollection, setEditorText, view } from '../helpers';

// How the document editor writes and reads values (#396): a list with things
// in it, the plain values under the shell's type helpers, and a helper it has
// never heard of.

test.describe('Values in the document editor', () => {
  test('writes a list, its plain values and an empty object as the shell would', async ({ app, page }) => {
    const doc: Doc = {
      _id: 1,
      tags: ['a', 'b'],
      nested: [{ n: 1 }],
      meta: {},
      ok: false,
      note: null,
      count: 3,
    };
    await connectStaging(app, page, { servers: { [STAGING_URI]: { databases: { shop: { things: { docs: [doc] } } } } } });
    await openCollection(page, 'shop', 'things');
    await expect(view(page).locator('[data-json-line]').first()).toBeVisible();

    await view(page).getByTestId('edit-doc-btn').first().click();
    const modal = page.getByTestId('document-edit-modal');
    await expect.poll(() => getEditorText(page, modal)).toContain('"tags"');
    const shown = await getEditorText(page, modal);

    // A list with entries is written one per line, not as [].
    expect(shown).toMatch(/"tags"\s*:\s*\[\s*\n/);
    expect(shown).toContain('"a"');
    expect(shown).toContain('"nested"');
    // An object with nothing in it stays on one line.
    expect(shown).toContain('"meta" : {}');
    // Plain values are written as they are.
    expect(shown).toContain('false');
    expect(shown).toContain('null');
    expect(shown).toContain('3');
  });

  test('refuses a type helper it does not know, rather than inventing one', async ({ app, page }) => {
    await connectStaging(app, page, { servers: { [STAGING_URI]: { databases: { shop: { things: { docs: [{ _id: 1 }] } } } } } });
    await openCollection(page, 'shop', 'things');
    await expect(view(page).locator('[data-json-line]').first()).toBeVisible();

    await view(page).getByTestId('insert-doc-btn').click();
    const modal = page.getByTestId('document-edit-modal');
    await setEditorText(page, modal, '{ "at": myDate(1), "n": 2 }');

    // Left as written rather than turned into some other type, so it does not
    // parse and nothing is sent.
    await expect(modal.getByTestId('document-edit-error')).toContainText('Invalid document');
    await expect(modal.getByTestId('document-save-btn')).toBeDisabled();
    expect(await app.calls('insert_document')).toHaveLength(0);

    // A helper it does know saves as Extended JSON.
    await setEditorText(page, modal, '{ "at": ISODate("2024-01-02T03:04:05Z"), "n": 2 }');
    await modal.getByTestId('document-save-btn').click();
    await expect.poll(async () => (await app.calls('insert_document')).length).toBe(1);
  });
});
