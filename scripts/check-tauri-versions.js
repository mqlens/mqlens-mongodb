// Fail when a Tauri Rust crate and its npm package are on different major.minor
// releases.
//
// `tauri build` refuses to start in that state ("Found version mismatched Tauri
// packages"), but only the Release workflow runs `tauri build`. A dependency
// bump that moves just one side, like the cargo group bump in #382 that took
// tauri-plugin-updater to 2.11 while the npm package stayed on 2.10, merges
// with green CI and then fails every platform build of the next release (fixed
// in #387). This runs the same pairing check on every PR, in well under a second
// and without installing anything.
//
// Pairs checked: the `tauri` crate with `@tauri-apps/api`, and each direct
// `tauri-plugin-<name>` crate with `@tauri-apps/plugin-<name>`, using the
// versions actually resolved in Cargo.lock and package-lock.json. A plugin with
// no counterpart on the other side has nothing to drift from and is skipped.
//
// Usage: node scripts/check-tauri-versions.js [repo-root]

import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const root = resolve(process.argv[2] ?? '.');
const read = (rel) => readFileSync(join(root, rel), 'utf8');

const TAURI_CRATE = /^(tauri|tauri-plugin-[A-Za-z0-9_-]+)$/;

/** Names of the tauri / tauri-plugin-* crates the app depends on directly. */
function directTauriCrates(cargoToml) {
  const names = new Set();
  let inDeps = false;
  for (const raw of cargoToml.split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, '').trim();
    const header = line.match(/^\[(.+)\]$/);
    if (header) {
      // `[dependencies]` and `[target.'cfg(..)'.dependencies]`, but not
      // `[dev-dependencies]` or `[build-dependencies]` (tauri-build has no npm twin).
      inDeps = /(^|\.)dependencies$/.test(header[1]);
      // `[dependencies.tauri]` table form.
      const table = header[1].match(/(?:^|\.)dependencies\.([A-Za-z0-9_-]+)$/);
      if (table && TAURI_CRATE.test(table[1])) names.add(table[1]);
      continue;
    }
    if (!inDeps) continue;
    const dep = line.match(/^([A-Za-z0-9_-]+)\s*=/);
    if (dep && TAURI_CRATE.test(dep[1])) names.add(dep[1]);
  }
  return names;
}

/** Crate name -> every version of it resolved in Cargo.lock. */
function cargoLockVersions(lock) {
  const versions = new Map();
  for (const block of lock.split('[[package]]').slice(1)) {
    const name = block.match(/^name = "([^"]+)"/m)?.[1];
    const version = block.match(/^version = "([^"]+)"/m)?.[1];
    if (!name || !version) continue;
    if (!versions.has(name)) versions.set(name, new Set());
    versions.get(name).add(version);
  }
  return versions;
}

/** @tauri-apps/api and @tauri-apps/plugin-* -> resolved version, or null when the lockfile lacks it. */
function npmTauriPackages(pkg, lock) {
  const resolved = new Map();
  for (const field of ['dependencies', 'devDependencies', 'optionalDependencies']) {
    for (const name of Object.keys(pkg[field] ?? {})) {
      if (!/^@tauri-apps\/(api|plugin-.+)$/.test(name)) continue;
      resolved.set(name, lock.packages?.[`node_modules/${name}`]?.version ?? null);
    }
  }
  return resolved;
}

const npmNameFor = (crate) =>
  crate === 'tauri' ? '@tauri-apps/api' : crate.replace(/^tauri-plugin-/, '@tauri-apps/plugin-');
const majorMinor = (version) => version.split('.').slice(0, 2).join('.');

const crates = directTauriCrates(read('src-tauri/Cargo.toml'));
const lockVersions = cargoLockVersions(read('src-tauri/Cargo.lock'));
const npm = npmTauriPackages(JSON.parse(read('package.json')), JSON.parse(read('package-lock.json')));

const rows = [];
const problems = [];
for (const crate of [...crates].sort()) {
  const npmName = npmNameFor(crate);
  if (!npm.has(npmName)) continue;
  const crateVersions = [...(lockVersions.get(crate) ?? [])];
  const npmVersion = npm.get(npmName);
  if (crateVersions.length === 0) {
    problems.push(`${crate} is a dependency in src-tauri/Cargo.toml but is missing from src-tauri/Cargo.lock; regenerate the lockfile.`);
    continue;
  }
  if (npmVersion === null) {
    problems.push(`${npmName} is a dependency in package.json but is missing from package-lock.json; regenerate the lockfile.`);
    continue;
  }
  for (const crateVersion of crateVersions) {
    const ok = majorMinor(crateVersion) === majorMinor(npmVersion);
    rows.push({ ok, crate: `${crate} ${crateVersion}`, npm: `${npmName} ${npmVersion}` });
    if (!ok) {
      problems.push(
        `${crate} is ${crateVersion} but ${npmName} is ${npmVersion}. ` +
          `Move both to the same major.minor release; \`tauri build\` refuses to run otherwise.`,
      );
    }
  }
}

// A check that compares nothing must not pass: it would mean the parsing above
// no longer matches the manifests, and every future mismatch would slip through.
if (rows.length === 0 && problems.length === 0) {
  problems.push('Found no Tauri crate/npm pairs to compare; the manifest parsing in scripts/check-tauri-versions.js needs updating.');
}

const width = Math.max(0, ...rows.map((row) => row.crate.length));
for (const row of rows) {
  console.log(`${row.ok ? 'ok      ' : 'MISMATCH'}  ${row.crate.padEnd(width)}  ${row.npm}`);
}

if (problems.length > 0) {
  for (const problem of problems) {
    // GitHub Actions turns this into an error annotation on the run.
    console.log(`::error title=Tauri crate/npm version check::${problem}`);
  }
  console.error(`\n${problems.length} problem(s) with Tauri crate/npm versions.`);
  process.exit(1);
}

console.log(`\nAll ${rows.length} Tauri crate/npm pairs share a major.minor release.`);
