// Monaco ships its vendored DOMPurify without type declarations. The test that
// checks its version only reads `version`.
declare module 'monaco-editor/base/browser/dompurify/dompurify.js' {
  const purify: { version: string };
  export default purify;
}
