import type { Page } from '@playwright/test';
import { test, expect, type App } from '../fixtures';
import { connectStaging, openCollection, setEditorText, view } from '../helpers';

// Each aggregation stage can show its first 20 input and output documents side
// by side, run apart from the results grid, and links to its operator's docs.

const stage = (page: Page, index: number) => view(page).getByTestId(`pipeline-stage-${index}`);
const pipelines = async (app: App) =>
  (await app.calls('execute_aggregate')).map((call) => JSON.parse((call.args as { pipeline: string }).pipeline));

async function openPipeline(app: App, page: Page): Promise<void> {
  await connectStaging(app, page);
  await openCollection(page, 'sales_db', 'customers');
  await expect(view(page).getByText('Alice Smith').first()).toBeVisible();
  await view(page).getByTestId('mode-aggregate-tab').click();
  await setEditorText(page, stage(page, 0), '{ tier: "Premium" }');
  await view(page).getByRole('button', { name: /add stage/i }).click();
  await stage(page, 1).locator('select').selectOption('$group');
  await setEditorText(page, stage(page, 1), '{ _id: "$tier", n: { $sum: 1 } }');
}

test.describe('Aggregation stage preview', () => {
  test("shows a stage's input beside its output without running the pipeline into the results", async ({ app, page }) => {
    await openPipeline(app, page);

    await view(page).getByRole('button', { name: 'Preview stage 2' }).click();

    await expect(view(page).getByTestId('stage-preview-input-1')).toContainText('"name" : "Alice Smith"');
    await expect(view(page).getByTestId('stage-preview-output-1')).toContainText('"_id" : "Premium"');
    const runs = await pipelines(app);
    expect(runs).toHaveLength(2);
    expect(runs.every((p) => JSON.stringify(p.at(-1)) === '{"$limit":20}')).toBe(true);

    // Refresh re-runs it; a second click on the toggle closes it.
    await view(page).getByRole('button', { name: 'Refresh preview' }).click();
    await expect.poll(async () => (await pipelines(app)).length).toBe(4);
    await view(page).getByRole('button', { name: 'Preview stage 2' }).click();
    await expect(view(page).getByTestId('stage-preview-1')).toHaveCount(0);
  });

  test('says why a preview failed, and links the operator docs', async ({ app, page }) => {
    await openPipeline(app, page);

    await app.failNext('execute_aggregate', 'unknown group operator');
    await view(page).getByRole('button', { name: 'Preview stage 2' }).click();
    await expect(view(page).getByTestId('stage-preview-1')).toContainText('unknown group operator');

    await view(page).getByRole('button', { name: '$group documentation' }).click();
    await expect
      .poll(async () => (await app.calls('plugin:opener|open_url')).map((call) => (call.args as { url: string }).url))
      .toContain('https://www.mongodb.com/docs/manual/reference/operator/aggregation/group/');
  });
});
