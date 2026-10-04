import { test, expect } from '@playwright/test';

test.beforeEach(async ({ page }) => {
  await page.route('https://api.github.com/**', route => route.fulfill({ status: 503, body: '{}' }));
});

test('demo is an indexable watch page with accessible playback and a transcript', async ({ page }) => {
  const response = await page.goto('/demo/');
  expect(response?.status()).toBe(200);
  await expect(page.locator('h1')).toContainText('MQLens');
  await expect(page.locator('video[controls]')).toBeVisible();
  await expect(page.locator('video source')).toHaveAttribute('src', '/demo.mp4');
  await expect(page.locator('video')).not.toHaveAttribute('autoplay');
  await expect(page.getByRole('heading', { name: 'Demo transcript' })).toBeVisible();
  const schema = await page.locator('script[type="application/ld+json"]').allTextContents();
  expect(schema.some(s => JSON.stringify(JSON.parse(s)).includes('VideoObject'))).toBe(true);
});

test('downloads remain available when release lookup fails', async ({ page }) => {
  await page.goto('/#download');
  for (const key of ['exe', 'msi', 'dmg-arm', 'dmg-intel', 'deb', 'rpm']) {
    const button = page.locator(`[data-dl="${key}"]`);
    await expect(button).toBeVisible();
    await expect(button).toHaveAttribute('href', /^https:\/\/github.com\/mqlens\/mqlens-mongodb\/releases/);
  }
});

test('mobile navigation opens and closes accessibly', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  const toggle = page.getByRole('button', { name: 'Toggle menu' });
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  await page.keyboard.press('Escape');
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await expect(toggle).toBeFocused();
});

test('first screen has a download and demo path without automatic motion', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/');
  await expect(page.locator('main').getByRole('link', { name: 'Download MQLens', exact: true }).first()).toBeInViewport();
  await expect(page.locator('main').getByRole('link', { name: /Watch.*demo/i }).first()).toBeInViewport();
  expect(await page.locator('video[autoplay]').count()).toBe(0);
});

test('core content and download links work without JavaScript', async ({ browser }) => {
  const context = await browser.newContext({ javaScriptEnabled: false, viewport: { width: 390, height: 844 } });
  const page = await context.newPage();
  await page.goto('http://127.0.0.1:4321/');
  await expect(page.locator('h1')).toBeVisible();
  await expect(page.locator('[data-dl="exe"]')).toHaveAttribute('href', /^https:\/\//);
  await expect(page.locator('nav').getByRole('link', { name: 'Docs', exact: true })).toBeVisible();
  await context.close();
});

test('release data updates installers without removing manual architecture choices', async ({ page }) => {
  await page.route('https://api.github.com/repos/mqlens/mqlens-mongodb/releases/latest', route => route.fulfill({
    json: { assets: [{ name:'MQLens_aarch64.dmg', size:1048576, browser_download_url:'https://github.com/mqlens/mqlens-mongodb/releases/download/test/MQLens_aarch64.dmg' }] },
  }));
  await page.goto('/#download');
  await expect(page.locator('[data-dl="dmg-arm"]')).toHaveAttribute('href', /\/test\/MQLens_aarch64.dmg$/);
  await expect(page.locator('[data-dl="dmg-arm"] .dl-size')).toHaveText('1.0 MB');
  await expect(page.locator('[data-dl="dmg-intel"]')).toBeVisible();
  await expect(page.locator('[data-dl="exe"]')).toBeVisible();
});

test('homepage has no horizontal overflow on narrow screens', async ({ page }) => {
  for (const width of [320, 390, 768, 1440]) {
    await page.setViewportSize({width, height:900});
    await page.goto('/');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), `${width}px layout`).toBe(true);
  }
});

test('demo video decodes with a caption track', async ({ page }) => {
  await page.goto('/demo/');
  await page.locator('video').evaluate((video: HTMLVideoElement) => video.load());
  await expect.poll(() => page.locator('video').evaluate((v: HTMLVideoElement) => v.readyState)).toBeGreaterThanOrEqual(1);
  const media = await page.locator('video').evaluate((v: HTMLVideoElement) => ({duration:v.duration,width:v.videoWidth,tracks:v.textTracks.length}));
  expect(media.duration).toBeGreaterThan(10);
  expect(media.width).toBe(1600);
  expect(media.tracks).toBe(1);
});

test('supporting pages remain readable on mobile', async ({ page }) => {
  await page.setViewportSize({width:390,height:844});
  for (const route of ['/features/','/docs/','/demo/','/compare/mongodb-compass-alternative/','/mongodb-gui-for-linux/','/mongodb-mcp-server/','/mongodb-ai-query-assistant/','/mqlens-server/']) {
    await page.goto(route);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), route).toBe(true);
    await expect(page.locator('h1')).toBeVisible();
  }
});


test('server preview clearly identifies planned availability and separate licensing', async ({ page }) => {
  await page.goto('/mqlens-server/');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('MQLens Server');
  await expect(page.getByText('Coming soon · In design', { exact: true })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Follow development on GitHub' })).toHaveAttribute('href', 'https://github.com/mqlens/mqlens-server');
  const graph = await page.locator('script[type="application/ld+json"]').evaluate(el => JSON.parse(el.textContent!)['@graph']);
  expect(graph.some((item: Record<string, unknown>) => item['@type'] === 'SoftwareApplication')).toBe(false);
  await expect(page.getByText('MQLens Server is planned as a separate commercial product.', { exact: false })).toBeVisible();
});
