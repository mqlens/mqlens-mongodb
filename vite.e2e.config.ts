import path from "node:path";
import { defineConfig, mergeConfig, type UserConfig } from "vite";
import appConfig from "./vite.config";

// Production build of the end-to-end entry (#396): the app's own Vite config,
// building e2e/index.html (the fake-backend harness plus src/main.tsx) instead
// of index.html. Unminified, so stack traces stay readable.
//
// Source maps are separate files, not inline: inline maps more than doubled
// every chunk (the entry was 24.6 MB, 23.7 MB of it map) and a browser loads
// them with the page even though nothing in it reads them. The coverage report
// fetches the .map files by URL instead.
export default defineConfig(async (env) => {
  const base = (typeof appConfig === "function" ? await appConfig(env) : appConfig) as UserConfig;
  return mergeConfig(base, {
    build: {
      outDir: "dist-e2e",
      emptyOutDir: true,
      sourcemap: true,
      minify: false,
      rolldownOptions: {
        input: path.resolve(__dirname, "e2e/index.html"),
      },
    },
  });
});
