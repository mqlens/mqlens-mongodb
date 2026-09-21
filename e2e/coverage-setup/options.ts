// Coverage settings for the end-to-end suite (#396).
import type { CoverageReportOptions } from 'monocart-coverage-reports';

/**
 * The gate the suite must keep, in percent. A ratchet: raise it as tests are
 * added, never lower it, until it reaches the 95% target in #396.
 *
 * It is checked against this report's own summary, not coverage-summary.json.
 * Both agree on statements, but they count lines differently: one run measured
 * 82.2% of 39,445 lines here and 84.7% of 11,414 in the JSON summary.
 */
export const COVERAGE_GATE = { lines: 92, statements: 93 };

/**
 * Set by the CI workflow on each shard, which runs part of the suite. A shard
 * keeps its coverage raw for the merge job, which reports and gates the whole.
 */
export const IS_SHARD = process.env.E2E_SHARD === '1';

/** `src/...` for any path or URL that points into the app's own source tree. */
function toSourcePath(pathOrUrl: string): string {
  const clean = pathOrUrl.split(/[?#]/)[0].replace(/\\/g, '/');
  // A dependency can have its own src/ folder; that is not the app's.
  if (clean.includes('node_modules/')) return clean;
  const at = clean.lastIndexOf('/src/');
  return at >= 0 ? clean.slice(at + 1) : clean;
}

/**
 * Same scope as the unit-test coverage in vitest.config.ts: every TS/TSX file
 * under src/, minus tests, test setup and type declarations.
 */
function isAppSource(sourcePath: string): boolean {
  return (
    /^src\/.+\.tsx?$/.test(sourcePath) &&
    !/\.d\.ts$/.test(sourcePath) &&
    !/\.test\.tsx?$/.test(sourcePath) &&
    !sourcePath.includes('/__tests__/') &&
    !sourcePath.startsWith('src/test/')
  );
}

export const coverageOptions: CoverageReportOptions = {
  name: 'MQLens end-to-end coverage',
  outputDir: './coverage/e2e',
  // A shard's raw data lands in coverage/e2e/raw, for merge-shards.ts to read.
  reports: IS_SHARD ? ['raw'] : ['console-summary', 'v8', 'json-summary', 'lcovonly'],

  // The production build's bundled chunks. Their source maps (fetched from the
  // preview server) unpack them to the original modules, and only the app's own
  // sources are kept:
  // dependencies, the harness in e2e/, and Monaco (loaded from its CDN) are not.
  entryFilter: (entry) => {
    const { pathname } = new URL(entry.url, 'http://localhost');
    return pathname.startsWith('/assets/') && pathname.endsWith('.js');
  },
  sourcePath: (filePath) => toSourcePath(filePath),
  sourceFilter: (sourcePath) => isAppSource(toSourcePath(sourcePath)),

  // Files the build never ran still count, at 0%, so the percentage is out of
  // the whole app rather than only the parts a test happened to touch. They are
  // TypeScript, which the coverage parser can't read, so they're compiled to
  // JS with a source map (named by full path) first.
  all: {
    dir: ['./src'],
    filter: (filePath) => (isAppSource(toSourcePath(filePath)) ? 'js' : false),
    transformer: async (entry: { url: string; source: string; sourceMap?: unknown }) => {
      const ts = (await import('typescript')).default;
      const sourcePath = toSourcePath(entry.url);
      const output = ts.transpileModule(entry.source, {
        fileName: sourcePath,
        compilerOptions: {
          target: ts.ScriptTarget.ES2022,
          module: ts.ModuleKind.ESNext,
          jsx: ts.JsxEmit.ReactJSX,
          sourceMap: true,
          inlineSources: true,
        },
      });
      entry.source = output.outputText.replace(/\/\/# sourceMappingURL=.*$/m, '');
      if (output.sourceMapText) {
        const map = JSON.parse(output.sourceMapText);
        map.sources = [sourcePath];
        delete map.sourceRoot;
        entry.sourceMap = map;
      }
    },
  },
};
