// @ts-check
import { defineConfig } from 'astro/config';
import sitemap from '@astrojs/sitemap';

// Custom domain (mqlens.com) is served from the repo root, so no `base` is needed.
export default defineConfig({
  site: 'https://mqlens.com',
  integrations: [sitemap({ filter: (page) => !page.endsWith('/404/') && !page.endsWith('/404.html') })],
  build: {
    // Emit clean URLs: /docs/ instead of /docs.html
    format: 'directory',
    // The small marketing styles fit in the HTML; avoid blocking CSS requests.
    inlineStylesheets: 'always',
  },
});
