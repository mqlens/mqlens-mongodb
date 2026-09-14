// Coverage settings for the end-to-end suite (#396).
import type { CoverageReportOptions } from 'monocart-coverage-reports';

/**
 * The gate the suite must keep, in percent. A ratchet: raise it as tests are
 * added, never lower it, until it reaches the 95% target in #396.
 */
export const COVERAGE_GATE = { lines: 0, statements: 0 };

/** `src/...` for any path or URL that points into the app's source tree. */
export function toSourcePath(pathOrUrl: string): string {
  const clean = pathOrUrl.split(/[?#]/)[0].replace(/\\/g, '/');
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

const INLINE_MAP = /(\/\/# sourceMappingURL=data:application\/json;(?:charset=utf-8;)?base64,)([A-Za-z0-9+/=]+)/;

/**
 * Give each module's inline source map its full `src/...` path.
 *
 * Vite's dev server names a module's original source by file name alone
 * (`sources: ["App.tsx"]`), so every source path would reach the filters as a
 * bare file name, and files sharing a name in different folders would be merged
 * into one. The module's URL carries the real path, so it's written into the
 * map before the coverage is added.
 */
export function withFullSourcePaths<T extends { url: string; source?: string }>(entries: T[]): T[] {
  for (const entry of entries) {
    if (!entry.source) continue;
    const sourcePath = toSourcePath(new URL(entry.url, 'http://localhost').pathname);
    if (!isAppSource(sourcePath)) continue;
    const match = entry.source.match(INLINE_MAP);
    if (!match) continue;
    const map = JSON.parse(Buffer.from(match[2], 'base64').toString('utf8'));
    map.sources = [sourcePath];
    delete map.sourceRoot;
    const encoded = Buffer.from(JSON.stringify(map), 'utf8').toString('base64');
    entry.source = entry.source.replace(INLINE_MAP, `$1${encoded}`);
  }
  return entries;
}

export const coverageOptions: CoverageReportOptions = {
  name: 'MQLens end-to-end coverage',
  outputDir: './coverage/e2e',
  reports: ['console-summary', 'v8', 'json-summary', 'lcovonly'],

  // Only the app's own TS/TSX modules as the Vite dev server serves them.
  // Pre-bundled dependencies (/node_modules/.vite), Vite's client, stylesheets
  // served as modules, and the harness in e2e/ are left out.
  entryFilter: (entry) => {
    const { pathname } = new URL(entry.url, 'http://localhost');
    return isAppSource(toSourcePath(pathname));
  },
  sourcePath: (filePath) => toSourcePath(filePath),
  sourceFilter: (sourcePath) => isAppSource(toSourcePath(sourcePath)),

  // Files no test loaded still count, at 0%, so the percentage is out of the
  // whole app rather than only the parts a test happened to touch. They are
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
