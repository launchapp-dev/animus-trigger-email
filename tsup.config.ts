import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  target: "node20",
  outDir: "dist",
  clean: true,
  splitting: false,
  minify: true,
  // Bundle the SDK + its small runtime deps so the published plugin works as a
  // single self-contained file at `dist/index.js` (the binary entry).
  noExternal: ["@launchapp-dev/animus-plugin-sdk"],
  banner: {
    js: "#!/usr/bin/env node",
  },
});
