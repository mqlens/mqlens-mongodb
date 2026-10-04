// Single source of truth for site-wide constants.
export const SITE = {
  name: 'MQLens',
  tagline: 'A free, open-source desktop workspace for MongoDB',
  titleTag: 'Free MongoDB GUI for Mac, Windows & Linux',
  description: 'Browse documents, build aggregations, and understand explain plans with MQLens, a free open-source MongoDB desktop GUI for macOS, Windows, and Linux.',
  url: 'https://mqlens.com',
  repo: 'https://github.com/mqlens/mqlens-mongodb',
  releases: 'https://github.com/mqlens/mqlens-mongodb/releases',
  releasesLatest: 'https://github.com/mqlens/mqlens-mongodb/releases/latest',
  license: 'Apache-2.0',
} as const;

export const NAV = [
  { label: 'Features', href: '/features/' },
  { label: 'Demo', href: '/demo/' },
  { label: 'Docs', href: '/docs/' },
  { label: 'Changelog', href: '/changelog/' },
  { label: 'GitHub', href: SITE.repo, external: true },
] as const;
