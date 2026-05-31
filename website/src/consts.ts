// Single source of truth for site-wide constants.
export const SITE = {
  name: 'MQLens',
  tagline: 'A fast, native desktop GUI for MongoDB',
  description:
    'MQLens is a fast, native cross-platform desktop GUI for MongoDB. Connect with full TLS/SSH/proxy support, browse data, build queries and aggregation pipelines, read explain plans, manage indexes and views, and run an embedded mongosh — with credentials encrypted behind a master password.',
  url: 'https://mqlens.com',
  repo: 'https://github.com/mqlens/mqlens-mongodb',
  releases: 'https://github.com/mqlens/mqlens-mongodb/releases',
  releasesLatest: 'https://github.com/mqlens/mqlens-mongodb/releases/latest',
  license: 'Apache-2.0',
} as const;

export const NAV = [
  { label: 'Features', href: '/#features' },
  { label: 'Docs', href: '/docs/' },
  { label: 'Changelog', href: '/changelog/' },
  { label: 'GitHub', href: SITE.repo, external: true },
] as const;
