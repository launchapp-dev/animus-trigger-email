// The SDK is pulled from a Git tag and the published archive does not include
// a pre-built `dist/`. Build it in place so TypeScript can resolve the package
// via its `main`/`types`/`exports` entries. Safe to skip when dist already
// exists (e.g. once the SDK starts publishing built artifacts).

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..");
const sdkRoot = resolve(repoRoot, "node_modules", "@launchapp-dev", "animus-plugin-sdk");

// npm prefers `git+ssh://` for `resolved` entries when resolving a git
// dependency on a developer machine with SSH keys. That breaks `npm ci` in CI
// runners and for users without GitHub SSH access. Force the lockfile back to
// HTTPS so installs work everywhere.
const lockfilePath = resolve(repoRoot, "package-lock.json");
if (existsSync(lockfilePath)) {
  const original = readFileSync(lockfilePath, "utf8");
  const rewritten = original.replace(
    /git\+ssh:\/\/git@github\.com\/launchapp-dev\/animus-plugin-sdk-ts\.git/g,
    "git+https://github.com/launchapp-dev/animus-plugin-sdk-ts.git",
  );
  if (rewritten !== original) {
    writeFileSync(lockfilePath, rewritten);
    console.error("[animus-trigger-email] rewrote SDK lockfile URL to HTTPS");
  }
}

if (!existsSync(sdkRoot)) {
  // SDK not yet installed (e.g. nested install). Nothing to do.
  process.exit(0);
}

if (existsSync(resolve(sdkRoot, "dist", "index.js")) && existsSync(resolve(sdkRoot, "dist", "index.d.ts"))) {
  process.exit(0);
}

// Write a self-contained tsconfig so we don't depend on whether the SDK
// archive shipped its build config.
const tsconfig = {
  compilerOptions: {
    target: "ES2022",
    module: "ESNext",
    moduleResolution: "Bundler",
    lib: ["ES2022"],
    types: ["node"],
    outDir: "dist",
    rootDir: "src",
    strict: true,
    skipLibCheck: true,
    esModuleInterop: true,
    declaration: true,
    declarationMap: false,
    sourceMap: false,
    isolatedModules: true,
    forceConsistentCasingInFileNames: true,
  },
  include: ["src/**/*.ts"],
  exclude: ["src/**/*.test.ts", "src/__tests__/**", "dist", "node_modules"],
};
writeFileSync(resolve(sdkRoot, "tsconfig.build.local.json"), JSON.stringify(tsconfig, null, 2));

try {
  // Prefer the workspace's own tsc binary (already installed as a devDep) so
  // we don't need a network round-trip on every install. Fall back to a
  // sandboxed `npx -p typescript@^5.6 -c tsc ...` invocation; bare
  // `npx --yes typescript@^5.6` does NOT resolve to the `tsc` binary because
  // the package's `bin` is named `tsc`, not `typescript`.
  const localTsc = resolve(__dirname, "..", "node_modules", ".bin", "tsc");
  if (existsSync(localTsc)) {
    execSync(`"${localTsc}" -p tsconfig.build.local.json`, {
      cwd: sdkRoot,
      stdio: "inherit",
    });
  } else {
    execSync(`npx --yes -p typescript@^5.6 tsc -p tsconfig.build.local.json`, {
      cwd: sdkRoot,
      stdio: "inherit",
    });
  }
} catch (err) {
  console.error("[animus-trigger-email] failed to build SDK in place:", err?.message ?? err);
  process.exit(1);
}
