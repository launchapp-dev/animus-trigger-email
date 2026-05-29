import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["cjs"],
  target: "node20",
  outDir: "dist",
  clean: true,
  splitting: false,
  minify: true,
  // Bundle runtime deps so the release asset can be installed as a single
  // executable file by `animus plugin install`.
  noExternal: ["@launchapp-dev/animus-plugin-sdk", "imapflow", "mailparser", "nodemailer"],
  outExtension: () => ({ js: ".cjs" }),
  banner: {
    js: "#!/usr/bin/env node",
  },
});
