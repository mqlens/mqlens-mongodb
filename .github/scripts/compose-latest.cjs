// Assemble a Tauri updater `latest.json` from the per-platform updater
// signatures attached to a release. Run after all matrix builds have uploaded
// their bundles + `.sig` files (the matrix uses uploadUpdaterJson:false so it
// never races on this single asset).
//
// Inputs (env): REPO (owner/name), REL_TAG (release the bundles live on),
// VERSION, NOTES. Reads `*.sig` files from ./sigs (downloaded by the caller).
// Writes ./latest.json.
//
// Each `<artifact>.sig` file's contents is the updater signature for `<artifact>`;
// the artifact's download URL is on the REL_TAG release. We ignore any duplicate
// non-canonical bundles (only files starting with the productName "MQLens").
const fs = require('fs');
const path = require('path');

const REPO = process.env.REPO;
const TAG = process.env.REL_TAG;
const VERSION = process.env.VERSION;
const NOTES = process.env.NOTES || '';
const PUB_DATE = process.env.PUB_DATE || new Date().toISOString();
const DIR = 'sigs';

const urlFor = (artifact) =>
  `https://github.com/${REPO}/releases/download/${TAG}/${encodeURIComponent(artifact)}`;

const platforms = {};
const add = (key, artifact) => {
  if (platforms[key]) return; // first match wins
  const sig = fs.readFileSync(path.join(DIR, `${artifact}.sig`), 'utf8').trim();
  platforms[key] = { signature: sig, url: urlFor(artifact) };
};

const sigFiles = fs.existsSync(DIR) ? fs.readdirSync(DIR).filter((f) => f.endsWith('.sig')) : [];
for (const f of sigFiles) {
  const artifact = f.slice(0, -4); // strip ".sig"
  if (!artifact.startsWith('MQLens')) continue; // skip duplicate mq-lens_ bundles
  if (/aarch64\.app\.tar\.gz$/.test(artifact)) add('darwin-aarch64', artifact);
  else if (/(x64|x86_64)\.app\.tar\.gz$/.test(artifact)) add('darwin-x86_64', artifact);
  else if (/\.app\.tar\.gz$/.test(artifact)) add('darwin-x86_64', artifact); // mac, no arch suffix
  else if (/\.AppImage(\.tar\.gz)?$/.test(artifact)) add('linux-x86_64', artifact);
  else if (/(-setup\.exe|\.nsis\.zip)$/.test(artifact)) add('windows-x86_64', artifact);
  else if (/\.msi(\.zip)?$/.test(artifact)) add('windows-x86_64', artifact); // MSI fallback
}

if (Object.keys(platforms).length === 0) {
  console.error('No updater signatures found in ./sigs — refusing to write an empty manifest.');
  process.exit(1);
}

const manifest = { version: VERSION, notes: NOTES, pub_date: PUB_DATE, platforms };
fs.writeFileSync('latest.json', JSON.stringify(manifest, null, 2));
console.log('Composed latest.json for', VERSION, '— platforms:', Object.keys(platforms).join(', '));
