import type { Page } from '@playwright/test';
import { test, expect, type App } from '../fixtures';
import type { Seed } from '../harness/seed';
import { connectStaging } from '../helpers';

// The card behind a connection in the sidebar (#396): what it says about a
// deployment that is not a replica set, about members falling behind, and
// about a server it could not ask.

const sidebar = (page: Page) => page.getByRole('complementary');
const card = (page: Page) => page.getByTestId('cluster-health-card');

const MEMBER = {
  name: 'staging-a:27017',
  stateStr: 'PRIMARY',
  health: 1,
  self: true,
  uptimeSecs: 7_200,
  optimeDateMs: 1_747_000_000_000,
  pingMs: null,
  syncSource: '',
  lagSecs: null,
};

async function hoverConnection(app: App, page: Page, seed: Seed): Promise<void> {
  await connectStaging(app, page, seed);
  await sidebar(page).getByRole('button', { name: 'Connection Staging' }).hover();
  await expect(card(page)).toBeVisible();
}

test.describe('The cluster card', () => {
  test('says why it could not read the deployment', async ({ app, page }) => {
    await connectStaging(app, page);
    await app.failNext('repl_set_status', 'not authorized on admin to run replSetGetStatus');
    await sidebar(page).getByRole('button', { name: 'Connection Staging' }).hover();

    await expect(card(page)).toContainText('not authorized on admin to run replSetGetStatus');
    await expect(card(page).getByTestId('cluster-card-standalone')).toHaveCount(0);
  });

  test('names a standalone server as one', async ({ app, page }) => {
    await hoverConnection(app, page, {});
    await expect(card(page).getByTestId('cluster-card-standalone')).toBeVisible();
  });

  test('points a sharded cluster at its shards', async ({ app, page }) => {
    await hoverConnection(app, page, {
      monitoring: {
        replSet: {
          isReplicaSet: false,
          clusterType: 'sharded',
          set: '',
          myStateStr: '',
          mongoVersion: '7.0.5',
          members: [],
        },
      },
    });

    await expect(card(page).getByTestId('cluster-card-sharded')).toBeVisible();
    await expect(card(page).getByTestId('cluster-card-standalone')).toHaveCount(0);
  });

  test('shows how far behind each secondary is', async ({ app, page }) => {
    await hoverConnection(app, page, {
      monitoring: {
        replSet: {
          isReplicaSet: true,
          clusterType: 'replicaSet',
          set: 'rs0',
          myStateStr: 'PRIMARY',
          mongoVersion: '7.0.5',
          members: [
            MEMBER,
            { ...MEMBER, name: 'staging-b:27017', stateStr: 'SECONDARY', self: false, lagSecs: 2.5 },
            { ...MEMBER, name: 'staging-c:27017', stateStr: 'SECONDARY', self: false, lagSecs: 12 },
            { ...MEMBER, name: 'staging-d:27017', stateStr: 'SECONDARY', self: false, lagSecs: 95 },
          ],
        },
      },
    });

    // Under ten seconds it is worth a decimal; past that it is rounded.
    await expect(card(page).getByTestId('cluster-card-member-staging-b:27017')).toContainText('2.5s');
    await expect(card(page).getByTestId('cluster-card-member-staging-c:27017')).toContainText('12s');
    await expect(card(page).getByTestId('cluster-card-member-staging-d:27017')).toContainText('95s');
    // The one furthest behind is called out.
    await expect(card(page).getByTestId('cluster-card-member-staging-d:27017').locator('.text-destructive')).toBeVisible();
  });
});
