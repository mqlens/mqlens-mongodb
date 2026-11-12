import { describe, it, expect } from 'vitest';
import tauriConfig from '../../../src-tauri/tauri.conf.json';

// The policy Tauri serves with the built app's pages, checked by asking it
// about concrete requests the app makes (or must never make), the way the
// webview would. Tauri applies it only to the built app: `tauri dev` loads the
// page straight from Vite, without it.

type Policy = Map<string, string[]>;
type CspConfig = string | Record<string, string | string[]> | null;
type Security = {
  csp: CspConfig;
  dangerousDisableAssetCspModification?: boolean | string[];
};

/** The app's own origins: WebView2 on Windows, WKWebView and WebKitGTK elsewhere. */
const APP_ORIGINS = ['http://tauri.localhost', 'tauri://localhost'];

function parsePolicy(csp: CspConfig): Policy {
  const policy: Policy = new Map();
  if (csp === null) return policy;
  const entries: Array<[string, string]> =
    typeof csp === 'string'
      ? csp
          .split(';')
          .map((d) => d.trim())
          .filter(Boolean)
          .map((d) => {
            const [name, ...sources] = d.split(/\s+/);
            return [name, sources.join(' ')];
          })
      : Object.entries(csp).map(([name, sources]) => [name, Array.isArray(sources) ? sources.join(' ') : sources]);
  for (const [name, sources] of entries) policy.set(name.toLowerCase(), sources.split(/\s+/).filter(Boolean));
  return policy;
}

/** Which directive governs a request, following CSP Level 3's fallback lists. */
const FALLBACKS: Record<string, string[]> = {
  'script-src-elem': ['script-src-elem', 'script-src', 'default-src'],
  'style-src-elem': ['style-src-elem', 'style-src', 'default-src'],
  'worker-src': ['worker-src', 'child-src', 'script-src', 'default-src'],
  'connect-src': ['connect-src', 'default-src'],
  'img-src': ['img-src', 'default-src'],
  'font-src': ['font-src', 'default-src'],
  'object-src': ['object-src', 'default-src'],
  'base-uri': ['base-uri'],
};

/** The source list in force for `directive`, or undefined when nothing restricts it. */
function effectiveSources(policy: Policy, directive: string): string[] | undefined {
  for (const name of FALLBACKS[directive] ?? [directive]) {
    const sources = policy.get(name);
    if (sources) return sources;
  }
  return undefined;
}

function sourceMatches(source: string, url: URL, pageOrigin: string): boolean {
  // Not url.origin: a blob: URL inherits its creator's origin, but 'self'
  // never matches blob:, data: or filesystem: URLs; they must be listed.
  if (source === "'self'") return `${url.protocol}//${url.host}` === pageOrigin;
  if (source.startsWith("'")) return false; // 'none', 'unsafe-inline', nonces, hashes
  if (/^[a-z][a-z0-9+.-]*:$/i.test(source)) return url.protocol === source.toLowerCase();
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(source) ? source : `https://${source}`;
  const expected = new URL(withScheme.replace('://*.', '://wildcard.'));
  if (url.protocol !== expected.protocol) return false;
  const hostMatches = withScheme.includes('://*.')
    ? url.hostname.endsWith(expected.hostname.slice('wildcard'.length))
    : url.hostname === expected.hostname;
  return hostMatches && url.port === expected.port && url.pathname.startsWith(expected.pathname);
}

/** Whether the page at every app origin may make this request. */
function allows(policy: Policy, directive: string, request: string): boolean {
  return APP_ORIGINS.every((pageOrigin) => {
    const sources = effectiveSources(policy, directive);
    if (!sources) return true;
    // A relative request resolves against the page, as the asset URLs do.
    const url = new URL(request, pageOrigin);
    return sources.some((source) => sourceMatches(source, url, pageOrigin));
  });
}

/**
 * Whether inline code survives for `directive`. A nonce or hash in the list
 * switches 'unsafe-inline' off, and Tauri adds nonces and hashes to
 * script-src and style-src unless told to leave a directive alone.
 */
function allowsInline(security: Security, policy: Policy, directive: 'script-src' | 'style-src'): boolean {
  const sources = effectiveSources(policy, `${directive}-elem`);
  if (!sources) return true;
  const disabled = security.dangerousDisableAssetCspModification;
  const tauriAddsNonces = !(disabled === true || (Array.isArray(disabled) && disabled.includes(directive)));
  const hasNonceOrHash = sources.some((s) => /^'(nonce|sha256|sha384|sha512)-/.test(s));
  return sources.includes("'unsafe-inline'") && !tauriAddsNonces && !hasNonceOrHash;
}

const security = tauriConfig.app.security as Security;
const policy = parsePolicy(security.csp);

describe("the built app's content security policy", () => {
  it('lets the page call the Tauri backend', () => {
    expect(allows(policy, 'connect-src', 'ipc://localhost/load_app_settings')).toBe(true);
    expect(allows(policy, 'connect-src', 'http://ipc.localhost/load_app_settings')).toBe(true);
  });

  it("runs the app's own scripts and workers", () => {
    expect(allows(policy, 'script-src-elem', '/assets/index-abc123.js')).toBe(true);
    expect(allows(policy, 'worker-src', '/assets/ts.worker-abc123.js')).toBe(true);
  });

  it('refuses scripts and workers from anywhere else', () => {
    expect(allows(policy, 'script-src-elem', 'https://cdn.jsdelivr.net/npm/monaco-editor@0.55.1/min/vs/loader.js')).toBe(false);
    expect(allows(policy, 'worker-src', 'https://cdn.jsdelivr.net/npm/monaco-editor@0.55.1/min/vs/assets/ts.worker.js')).toBe(false);
    expect(allows(policy, 'script-src-elem', 'data:text/javascript,alert(1)')).toBe(false);
    expect(allows(policy, 'script-src-elem', 'blob:http://tauri.localhost/0f3c')).toBe(false);
    expect(allowsInline(security, policy, 'script-src')).toBe(false);
    expect(effectiveSources(policy, 'script-src-elem')).not.toContain("'unsafe-eval'");
  });

  // bson's Long compiles a small WebAssembly module for 64-bit arithmetic as
  // soon as it loads. Blocked, it falls back to plain JS, but every launch
  // logs a violation. 'wasm-unsafe-eval' allows WebAssembly compilation only;
  // JavaScript eval stays refused.
  it("lets bson's Long compile its WebAssembly helpers, but not evaluate JavaScript", () => {
    const sources = effectiveSources(policy, 'script-src-elem') ?? [];
    expect(sources).toContain("'wasm-unsafe-eval'");
    expect(sources).not.toContain("'unsafe-eval'");
  });

  it('lets Monaco and the UI libraries inject their styles at runtime', () => {
    expect(allowsInline(security, policy, 'style-src')).toBe(true);
    expect(allows(policy, 'style-src-elem', '/assets/index-abc123.css')).toBe(true);
  });

  it('loads the web fonts and the bundled icon font', () => {
    expect(allows(policy, 'style-src-elem', 'https://fonts.googleapis.com/css2?family=Inter:wght@400')).toBe(true);
    expect(allows(policy, 'font-src', 'https://fonts.gstatic.com/s/inter/v13/abc.woff2')).toBe(true);
    expect(allows(policy, 'font-src', '/assets/codicon-abc123.ttf')).toBe(true);
  });

  it('draws chart exports from blob: and data: images', () => {
    expect(allows(policy, 'img-src', 'blob:http://tauri.localhost/0f3c')).toBe(true);
    expect(allows(policy, 'img-src', 'data:image/png;base64,iVBORw0KGgo=')).toBe(true);
  });

  it('refuses plugin content and <base> rewrites', () => {
    expect(allows(policy, 'object-src', '/anything.swf')).toBe(false);
    expect(allows(policy, 'base-uri', 'https://example.com/')).toBe(false);
  });
});
