/** Rebuild first: npx vite build --config vite.e2e.config.ts; serve on 4173.
 * Run npm run media:capture. CAPTURE_ONLY selects a single capture group.
 * Captures the real React UI against synthetic browser-harness fixtures.
 * These are UI previews, never live performance or native-window evidence.
 */
import { chromium, expect, test } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import { App } from '../e2e/fixtures';
import { openCollection, setEditorText, view, dismissHoverCards } from '../e2e/helpers';
import type { Seed } from '../e2e/harness/seed';

test('capture current interface with synthetic data', async () => {
const uri = 'mongodb://localhost:27017';
const profile = { id: 'demo', name: 'Local demo', uri, mcp_enabled: true };
const names = ['Aster Studio', 'Northstar Labs', 'Fieldwork', 'Orbit Systems', 'Tandem', 'Acme Data', 'River Retail', 'Metric Works'];
const customers = Array.from({ length: 24 }, (_, i) => ({ _id: { $oid: (1000 + i).toString(16).padStart(24,'0') }, name: names[i % names.length] + (i >= 8 ? ` ${Math.floor(i / 8) + 1}` : ''), email: `team${i + 1}@example.com`, region: ['Europe','North America','APAC'][i%3], tier: ['Premium','Standard'][i%2], seats: 4 + i * 3, address: { city: ['Berlin','Toronto','Tokyo'][i%3] } }));
const orders = Array.from({ length: 36 }, (_, i) => ({ _id: { $oid: (2000 + i).toString(16).padStart(24,'0') }, order: `ORD-${String(i+1).padStart(4,'0')}`, customer: names[i%8], region: ['Europe','North America','APAC'][i%3], status: ['shipped','processing','shipped'][i%3], total: 125 + i * 43, items: [{ sku: 'MQL-100', quantity: 2 }] }));
const seed: Seed = {
  appVersion: '0.21.0', profiles: [profile],
  settings: { theme: 'dark', ai_provider: 'openai', openai_model: 'gpt-4.1' },
  servers: { [uri]: { version: '7.0.5', databases: { mqlens_demo: {
    customers: { docs: customers, indexes: [{ name:'email_1', keys:{email:1}, unique:true }] },
    orders: { docs: orders, indexes:[{name:'region_1_total_-1',keys:{region:1,total:-1}}] },
    'fs.files': { docs:[] }, 'fs.chunks': { docs:[] },
  } } } },
  gridfs: { 'mqlens_demo.fs': [{ filename:'monthly-report.csv', content:'region,revenue\nEurope,14520\n', contentType:'text/csv', uploadDate:'2026-09-20T10:00:00Z' },{filename:'readme.txt',content:'Synthetic demo file',contentType:'text/plain',uploadDate:'2026-09-21T10:00:00Z'}] },
  aiReplies: [{ query: { explanation:'Find European customers on the Premium tier. Review the filter before running.', queryType:'find', filter:{region:'Europe',tier:'Premium'} } }],
  mcp: { enabled:false, port:8791, token:'synthetic-demo-token-not-a-credential' },
};
const out = 'website/public/screenshots';
await mkdir(out, {recursive:true});
await mkdir('.superpowers/sdd/website-refresh/captures', {recursive:true});
const browser = await chromium.launch();
const context = await browser.newContext({ viewport:{width:1600,height:1000}, deviceScaleFactor:1, baseURL:'http://127.0.0.1:4173', colorScheme:'dark', recordVideo:{dir:'.superpowers/sdd/website-refresh/captures',size:{width:1600,height:1000}} });
const page = await context.newPage();
page.setDefaultTimeout(12000);
await page.route(url => url.origin !== 'http://127.0.0.1:4173', route => route.abort());
const app = new App(page);
const only = process.env.CAPTURE_ONLY;
const shot = async (name: string) => { await page.mouse.move(1590,990); await page.waitForTimeout(450); await page.screenshot({path:`${out}/mqlens-${name}.png`}); console.log(`Captured ${name}`); };
const pause = () => page.waitForTimeout(1800);
async function open(extra: Seed = {}, connect = true) {
  await app.open({...seed,...extra});
  await expect(page.getByTestId('quickstart-tab').or(page.getByTestId('reconnect-banner').first())).toBeVisible();
  if(connect) { await page.getByTestId('conn-card-demo').click(); await page.getByRole('button',{name:'Connection Local demo',exact:true}).waitFor(); }
}
try {
if (!only || only === 'main') {
  await open({},false); await shot('quick-start');
  await page.getByTestId('conn-card-demo').click();
  await openCollection(page,'mqlens_demo','customers');
  await expect(view(page)).toContainText('Aster Studio');
  await view(page).getByRole('button',{name:'Table',exact:true}).click();
  await view(page).getByTestId('query-filter-input').locator('.monaco-editor').waitFor();
  await setEditorText(page,view(page).getByTestId('query-filter-input'),'{}');
  await shot('documents'); await pause();
  await view(page).getByRole('button',{name:'Tree',exact:true}).click(); await shot('tree'); await pause();
  await view(page).getByRole('button',{name:'JSON',exact:true}).click(); await shot('json'); await pause();
  await view(page).getByRole('button',{name:'Table',exact:true}).click();
  await view(page).getByTestId('mode-aggregate-tab').click();
  const stage=view(page).getByTestId('pipeline-stage-0');
  await stage.locator('select').selectOption('$group');
  await setEditorText(page,stage,'{ _id: "$region", customers: { $sum: 1 }, seats: { $sum: "$seats" } }');
  await view(page).getByRole('button',{name:'Run',exact:true}).click();
  await expect(view(page)).toContainText('North America');
  await shot('aggregation'); await pause();
  await view(page).getByRole('button',{name:'Find',exact:true}).click();
  await view(page).getByRole('button',{name:'Run',exact:true}).click();
  await view(page).getByTestId('explain-plan-tab').click();
  await expect(view(page).getByTestId('explain-panel')).toContainText('COLLSCAN');
  await shot('explain-plan'); await pause();
}
if (!only || only === 'extras') {
  await open(); await openCollection(page,'mqlens_demo','customers');
  await view(page).getByTestId('toggle-query-builder').click();
  const panel=view(page).getByTestId('query-builder-panel');
  await panel.locator('[data-testid^="rule-field-"]:not([data-testid^="rule-field-custom-"])').first().selectOption('region');
  await panel.locator('[data-testid^="rule-value-"]:not([data-testid^="rule-value-exists-"])').first().fill('Europe');
  await shot('visual-builder');
  await view(page).getByTestId('toggle-query-builder').click();
  await view(page).getByTestId('toggle-ai-helper').click();
  const ai=view(page).getByTestId('ai-helper-panel');
  await ai.getByTestId('chat-input').fill('Show Premium customers in Europe.');
  await ai.getByTestId('chat-send-btn').click();
  await ai.getByTestId('chat-query-card').waitFor(); await shot('ai-assistant');
  await view(page).getByTestId('toggle-ai-helper').click();
  await view(page).getByTestId('analyze-schema-btn').click();
  await page.getByTestId('schema-view').waitFor(); await shot('schema');
  await page.getByRole('complementary').getByText('customers',{exact:true}).click({button:'right'});
  await page.getByRole('menuitem',{name:'Generate Data…'}).click();
  await page.getByTestId('generate-view').waitFor(); await shot('data-generation');
  await page.getByRole('button',{name:'Open Settings',exact:true}).click();
  await page.getByTestId('settings-tab-mcp').click(); await shot('mcp');
}
if (!only || only === 'workspace') {
  const tabs=['customers','orders'].map(collection=>({id:`profile:demo.mqlens_demo.${collection}`,type:'collection',profileId:'demo',profileName:'Local demo',db:'mqlens_demo',collection}));
  await app.open({...seed,workspace:{revision:1,windows:[{id:'main',splitTree:{kind:'split',id:'split-1',dir:'row',ratio:.5,children:tabs.map((t,i)=>({kind:'pane',id:`pane-${i+1}`,tabIds:[t.id],activeTabId:t.id}))},focusedPaneId:'pane-1'}],tabs}});
  await page.getByRole('button',{name:'Reconnect Local demo'}).first().click();
  await expect(page.getByTestId('reconnect-banner')).toHaveCount(0);
  await expect(page.getByTestId('workspace-tab-strip')).toHaveCount(2);
  const panes=page.locator('[data-testid^="tab-content-"]:not([hidden])');
  await panes.first().getByRole('button',{name:'Table',exact:true}).click();
  await setEditorText(page,panes.first().getByTestId('query-filter-input'),'{}');
  await setEditorText(page,panes.last().getByTestId('query-filter-input'),'{ status: "shipped" }');
  await panes.last().getByRole('button',{name:'Run',exact:true}).click();
  await shot('workspace');
  await page.screenshot({path:`${out}/mqlens-workspace-mobile.png`,clip:{x:304,y:24,width:640,height:500}});
}
if (!only || only === 'connections') {
  await open({},false);
  await page.getByRole('button',{name:'New connection',exact:true}).first().click();
  await shot('connection-manager');
  await page.getByRole('button',{name:'New...',exact:true}).click();
  await page.getByRole('heading',{name:'New Connection',exact:true}).waitFor();
  await page.getByLabel('Display Name').fill('Local demo');
  await page.getByTestId('host-list').fill('localhost:27017');
  await shot('new-connection');
}
if (!only || only === 'tools') {
  await open(); await openCollection(page,'mqlens_demo','customers');
  const sidebar=page.getByRole('complementary');
  await sidebar.getByText('indexes',{exact:true}).first().click();
  await dismissHoverCards(page); await sidebar.getByText('email_1',{exact:true}).click();
  await page.getByTestId('index-viewer').waitFor(); await shot('index-detail');
  await sidebar.getByText('GridFS Buckets',{exact:true}).click(); await dismissHoverCards(page);
  await sidebar.getByText('fs',{exact:true}).click();
  await page.getByTestId('gridfs-view').waitFor(); await shot('gridfs');
  await sidebar.getByRole('button',{name:'Database mqlens_demo',exact:true}).click({button:'right'});
  await page.getByRole('menuitem',{name:'Open mongosh Shell'}).click();
  await dismissHoverCards(page);
  const shell=page.getByTestId('mongo-shell'); await shell.waitFor();
  await setEditorText(page,shell,'db.customers.find({ region: "Europe" }).limit(3)');
  await shell.getByRole('button',{name:'Run',exact:true}).click(); await page.waitForTimeout(500);
  await shot('mongosh');
}
if (!only || only === 'safeguards') {
  await open({profiles:[{...profile,connection_mode:'read_only'}]});
  await openCollection(page,'mqlens_demo','customers'); await shot('safeguards');
}
} catch (error) { await page.screenshot({path:'.superpowers/sdd/website-refresh/captures/failure.png'}); console.error(await page.locator('body').innerText()); throw error; }
finally {
  const video=page.video(); await context.close();
  if(video) { const path=await video.path(); await writeFile(`.superpowers/sdd/website-refresh/captures/${only ?? 'all'}-video.txt`,path); }
  await browser.close();
}

});
