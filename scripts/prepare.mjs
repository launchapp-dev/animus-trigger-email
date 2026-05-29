// `prepare` runs (a) after `npm install` in this repo and (b) when this
// package is installed as a git dependency by another project. The git-install
// flow is the one `animus plugin install launchapp-dev/animus-trigger-email`
// uses: npm clones, runs `prepare`, then resolves the `bin` entry. Without a
// build here, `dist/index.js` would not exist on disk and the daemon would
// spawn a missing binary.
//
// We skip the build when `dist/index.js` already exists (release tarballs that
// include the artifact) and when tsup is unavailable (CI environments that
// only run typecheck).

import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..");
const distEntry = resolve(repoRoot, "dist", "index.js");

if (existsSync(distEntry)) {
  // Already built (released tarball or local dev rebuild). Nothing to do.
  process.exit(0);
}

const tsupBin = resolve(repoRoot, "node_modules", ".bin", "tsup");
if (!existsSync(tsupBin)) {
  // Production install (no devDeps) — nothing to do; the published tarball
  // includes a pre-built `dist/` and the git-install path runs `prepare` with
  // devDeps available, so this branch is only hit when something else is
  // wrong. Be loud about it on stderr but don't fail the install — the
  // operator will see the missing binary and report it.
  console.error("[animus-trigger-email] prepare: tsup not available; skipping build");
  process.exit(0);
}

execSync(`"${tsupBin}"`, { cwd: repoRoot, stdio: "inherit" });
