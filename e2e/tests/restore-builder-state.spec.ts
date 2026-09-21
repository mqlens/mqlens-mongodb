import { test, expect } from '../fixtures';
import { SAMPLE_SERVER } from '../harness/seed';
import { callFrom, STAGING_URI, view } from '../helpers';

// A restored tab keeps what was typed into its query bar (#396). The tab is
// saved under its profile and only gets a live connection id when it
// reconnects, so the as-typed state has to be carried across that rename or it
// is silently lost — a cache miss under the new id.

const BUILDER_STATE = {
  queryMode: 'find',
  filterQuery: '{ tier: "Premium" }',
  sortQuery: '',
  projectionQuery: '',
  limit: '50',
  skip: '0',
  stages: [{ id: 'stage-1', operator: '$match', content: '{}' }],
};

const TAB = {
  id: 'profile:p-staging.sales_db.customers',
  type: 'collection',
  profileId: 'p-staging',
  profileName: 'Staging',
  db: 'sales_db',
  collection: 'customers',
  builderState: BUILDER_STATE,
};

test.describe('A restored tab with unsaved query-bar state', () => {
  test('still has it after reconnecting', async ({ app, page }) => {
    await app.open({
      profiles: [{ id: 'p-staging', name: 'Staging', uri: STAGING_URI }],
      servers: { [STAGING_URI]: SAMPLE_SERVER },
      workspace: {
        revision: 1,
        windows: [
          {
            id: 'main',
            splitTree: { kind: 'pane', id: 'pane-1', tabIds: [TAB.id], activeTabId: TAB.id },
            focusedPaneId: 'pane-1',
          },
        ],
        tabs: [TAB],
      },
    });

    const banner = page.getByTestId('reconnect-banner');
    await expect(banner).toContainText('sales_db.customers');
    await callFrom(app, 'connect_db', () => banner.getByRole('button', { name: 'Reconnect Staging' }).click());
    await expect(banner).toHaveCount(0);

    // The filter typed before the session ended is still in the bar, and it is
    // what runs — not the plain find a rebound tab with no state would run.
    await expect(view(page).getByTestId('query-filter-input')).toContainText('Premium');
    const ran = await callFrom(app, 'execute_mql_query', () =>
      view(page).getByRole('button', { name: 'Run', exact: true }).click(),
    );
    expect(JSON.parse(String(ran.filter))).toEqual({ tier: 'Premium' });
    await expect(view(page)).toContainText('Charlie Brown');
    await expect(view(page)).not.toContainText('Bob Johnson');
  });
});
