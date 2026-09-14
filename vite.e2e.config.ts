import path from "node:path";
import { defineConfig, mergeConfig, type UserConfig } from "vite";
import appConfig from "./vite.config";

// Production build of the end-to-end entry (#396): the app's own Vite config,
// building e2e/index.html (the fake-backend harness plus src/main.tsx) instead
// of index.html. Unminified with inline source maps, so coverage maps back to
// src/ accurately and stack traces stay readable.
export default defineConfig(async (env) => {
  const base = (typeof appConfig === "function" ? await appConfig(env) : appConfig) as UserConfig;
  return mergeConfig(base, {
    build: {
      outDir: "dist-e2e",
      emptyOutDir: true,
      sourcemap: "inline",
      minify: false,
      rolldownOptions: {
        input: path.resolve(__dirname, "e2e/index.html"),
      },
    },
  });
});
