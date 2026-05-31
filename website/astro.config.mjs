// @ts-check
import { defineConfig } from 'astro/config';
import sitemap from '@astrojs/sitemap';

// Custom domain (mqlens.com) is served from the repo root, so no `base` is needed.
export default defineConfig({
  site: 'https://mqlens.com',
  integrations: [sitemap()],
  build: {
    // Emit clean URLs: /docs/ instead of /docs.html
    format: 'directory',
  },
});
