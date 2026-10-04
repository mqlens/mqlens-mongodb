import { test, expect } from '@playwright/test';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

const dist = path.resolve('website/dist');
async function htmlFiles(directory: string): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(directory, {withFileTypes:true})) {
    const file=path.join(directory,entry.name);
    if(entry.isDirectory()) files.push(...await htmlFiles(file));
    else if(entry.name.endsWith('.html')) files.push(file);
  }
  return files;
}

test('every built page has unique metadata, valid schema and working local links', async ({ request }) => {
  const titles = new Set<string>();
  const descriptions = new Set<string>();
  const checked = new Set<string>();
  const anchors = new Map<string, Set<string>>();
  for (const file of await htmlFiles(dist)) {
    const html=await readFile(file,'utf8');
    const title=html.match(/<title>(.*?)<\/title>/s)?.[1];
    const description=html.match(/<meta name="description" content="([^"]*)"/)?.[1];
    expect(title, file).toBeTruthy(); expect(descriptions.has(description!), file).toBe(false);
    expect(description, file).toBeTruthy(); expect(titles.has(title!), file).toBe(false);
    expect(title, file).not.toContain("— MQLens — MQLens");
    titles.add(title!); descriptions.add(description!);
    expect((html.match(/<h1[ >]/g) ?? []).length, file).toBe(1);
    expect(html, file).toContain('rel="canonical"');
    for (const match of html.matchAll(/<script type="application\/ld\+json">(.*?)<\/script>/gs)) {
      expect(() => JSON.parse(match[1]), file).not.toThrow();
    }
    const relative=path.relative(dist,file).replaceAll(path.sep,'/');
    const route=relative==='index.html' ? '/' : '/'+relative.replace(/index\.html$/,'');
    for (const match of html.matchAll(/(?:href|src)="([^"\s]+)"/g)) {
      const value=match[1];
      if (!value.startsWith('/') && !value.startsWith('#')) continue;
      const url=new URL(value,`http://127.0.0.1:4321${route}`);
      if(!checked.has(url.pathname)) {
        const response=await request.get(url.pathname);
        expect(response.status(), `${file}: ${value}`).toBeLessThan(400);
        checked.add(url.pathname);
        if(response.headers()['content-type']?.includes('text/html')) {
          const body=await response.text();
          anchors.set(url.pathname,new Set([...body.matchAll(/\bid="([^"]+)"/g)].map(m=>m[1])));
        }
      }
      if(url.hash && anchors.has(url.pathname)) expect(anchors.get(url.pathname)!.has(decodeURIComponent(url.hash.slice(1))), `${file}: missing anchor ${value}`).toBe(true);
    }
  }
});

test('sitemap exposes new discovery pages and excludes 404', async ({ request }) => {
  const robots=await request.get('/robots.txt');
  expect(await robots.text()).toContain('Sitemap: https://mqlens.com/sitemap-index.xml');
  const index=await request.get('/sitemap-index.xml');
  const locs=[...(await index.text()).matchAll(/<loc>(.*?)<\/loc>/g)].map(m=>new URL(m[1]).pathname);
  let sitemap='';
  for(const url of locs) sitemap += await (await request.get(url)).text();
  for(const route of ['/demo/','/mongodb-mcp-server/','/mongodb-ai-query-assistant/','/mqlens-server/']) expect(sitemap).toContain(`https://mqlens.com${route}`);
  expect(sitemap).not.toContain('/404');
  const missing=await request.get('/this-page-does-not-exist/'); expect(missing.status()).toBe(404);
});
