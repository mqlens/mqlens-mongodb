// Single source of truth for site-wide constants.
export const SITE = {
  name: 'MQLens',
  tagline: 'Free native MongoDB GUI for SSH, TLS, enterprise auth, explain plans, and private local workflows',
  // Short <title> for pages that don't set their own — search engines truncate
  // titles around 60 characters, so the long tagline stays out of the head.
  titleTag: 'Free MongoDB GUI for Mac, Windows & Linux',
  description:
    'MQLens is a free, native, cross-platform MongoDB GUI with the power of paid tools: every auth mode (SCRAM, X.509, AWS, Kerberos, LDAP), TLS/SSH/proxy, aggregation pipelines with explain plans, bulk edit, index/view management, schema analysis, GridFS, an embedded mongosh, and an AI query assistant. Credentials are encrypted locally with zero telemetry. Apache-2.0.',
  url: 'https://mqlens.com',
  repo: 'https://github.com/mqlens/mqlens-mongodb',
  releases: 'https://github.com/mqlens/mqlens-mongodb/releases',
  releasesLatest: 'https://github.com/mqlens/mqlens-mongodb/releases/latest',
  license: 'Apache-2.0',
} as const;

export const NAV = [
  { label: 'Features', href: '/features/' },
  { label: 'Gallery', href: '/#gallery' },
  { label: 'Docs', href: '/docs/' },
  { label: 'Changelog', href: '/changelog/' },
  { label: 'GitHub', href: SITE.repo, external: true },
] as const;
