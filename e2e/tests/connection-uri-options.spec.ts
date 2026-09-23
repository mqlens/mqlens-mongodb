import type { Page } from '@playwright/test';
import { test, expect, type App } from '../fixtures';
import { SAMPLE_SERVER, type ProfileSeed } from '../harness/seed';
import { callFrom, STAGING_URI } from '../helpers';

// The options a connection string carries (#396). The editor reads a saved URI
// into its form and writes the form back out again, so every option has to
// survive the round trip — a replica set, an X.509 or LDAP mechanism, a client
// certificate — and a compressor chosen in the editor has to reach it too.

const button = (page: Page, name: string) => page.getByRole('button', { name, exact: true });
const tree = (page: Page) => page.getByRole('dialog').getByRole('complementary');

const profiles: ProfileSeed[] = [
  {
    id: 'p-rs',
    name: 'Replica set',
    uri: 'mongodb://rs1.example:27017,rs2.example:27017/sales?replicaSet=rs0',
  },
  { id: 'p-direct', name: 'Direct', uri: 'mongodb://one.example:27017/?directConnection=true' },
  { id: 'p-srv', name: 'Cluster', uri: 'mongodb+srv://cluster.example/sales' },
  {
    id: 'p-x509',
    name: 'X509',
    uri: 'mongodb://x509.example:27017/?authMechanism=MONGODB-X509&tls=true&tlsCertificateKeyFile=%2Fcerts%2Fclient.pem&tlsAllowInvalidCertificates=true',
  },
  { id: 'p-ldap', name: 'LDAP', uri: 'mongodb://alice:secret@ldap.example:27017/?authMechanism=PLAIN' },
  { id: 'p-scram1', name: 'SCRAM 1', uri: 'mongodb://bob:secret@old.example:27017/?authMechanism=SCRAM-SHA-1' },
];

/** Open `name` in the editor, run `edit` over it, save, and hand back the URI written. */
async function reSave(app: App, page: Page, name: string, edit?: () => Promise<void>): Promise<string> {
  await tree(page).getByText(name, { exact: true }).click();
  await button(page, 'Edit').click();
  await expect(page.getByRole('heading', { name: 'Edit Connection' })).toBeVisible();
  await edit?.();
  const saved = await callFrom(app, 'save_connection_profile', () => button(page, 'Save').click());
  return (saved.profile as { uri: string }).uri;
}

test.describe('A connection string round trip', () => {
  test('keeps every option it was saved with', async ({ app, page }) => {
    await app.open({ profiles, servers: { [STAGING_URI]: SAMPLE_SERVER } });
    await page.getByRole('button', { name: 'New connection', exact: true }).first().click();
    await expect(button(page, 'New...')).toBeVisible();

    // A replica set is recognised by its own option, and keeps its hosts. The
    // compressor is the editor's to choose, and has to reach the string too.
    const rs = decodeURIComponent(
      await reSave(app, page, 'Replica set', async () => {
        await button(page, 'Advanced').click();
        await page.getByRole('combobox').filter({ hasText: /None/i }).click();
        await page.getByRole('option', { name: /snappy/i }).click();
      }),
    );
    expect(rs).toContain('replicaSet=rs0');
    expect(rs).toContain('compressors=snappy');
    expect(rs).toContain('rs1.example:27017,rs2.example:27017');

    // One host told to stay on it is a standalone, and says so again.
    expect(await reSave(app, page, 'Direct')).toContain('directConnection=true');

    // An SRV record is a cluster, and stays one.
    expect(await reSave(app, page, 'Cluster')).toMatch(/^mongodb\+srv:\/\/cluster\.example/);

    // A certificate authenticates without a password, and the file goes with it.
    const x509 = decodeURIComponent(await reSave(app, page, 'X509'));
    expect(x509).toContain('authMechanism=MONGODB-X509');
    expect(x509).toContain('tlsCertificateKeyFile=/certs/client.pem');
    expect(x509).toContain('tlsAllowInvalidCertificates=true');

    // The two mechanisms that are spelled differently in the URI than in the form.
    expect(await reSave(app, page, 'LDAP')).toContain('authMechanism=PLAIN');
    expect(await reSave(app, page, 'SCRAM 1')).toContain('authMechanism=SCRAM-SHA-1');
  });
});
