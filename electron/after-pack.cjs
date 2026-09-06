// electron-builder's node_modules collector treats a nested `node_modules` inside
// a package as a hoisting artifact and strips it from the asar. The published
// @langchain/langgraph-sdk build genuinely imports bundled deps through
// `dist/node_modules/.pnpm/...` at runtime (ESM from the main process), so
// without them the packaged app crashes at startup:
//   ERR_MODULE_NOT_FOUND ... p-retry@7.1.1 ... imported from async_caller.js
// Staging copies before packing are dropped when the packer assembles the asar
// from its own dependency-graph file list, so the only reliable insertion point
// is after the asar exists: repack it here with the bundled dir restored.
const { createPackageWithOptions, extractAll } = require("@electron/asar");
const { cpSync, existsSync, mkdtempSync, rmSync } = require("node:fs");
const { tmpdir } = require("node:os");
const path = require("node:path");

/** Packages known to bundle runtime-imported deps under dist/node_modules. */
const PACKAGES_WITH_BUNDLED_NODE_MODULES = ["@langchain/langgraph-sdk"];

// Mirrors electron-builder's own defaults: every native addon must stay outside
// the asar (node:process dlopen cannot map a file from the archive), and the
// project's explicit asarUnpack globs keep the PTY prebuilt's whole package on
// disk for the out-of-process host to require().
const UNPACK_GLOBS = ["**/*.node", "node_modules/@homebridge/node-pty-prebuilt-multiarch/**"];

module.exports = async function afterPack(context) {
  const projectDir = context.packager.info.projectDir || context.packager.projectDir;
  const resourcesDir = path.join(context.appOutDir, "resources");
  const asarPath = path.join(resourcesDir, "app.asar");

  for (const pkgName of PACKAGES_WITH_BUNDLED_NODE_MODULES) {
    const bundledSource = path.join(projectDir, "node_modules", pkgName, "dist", "node_modules");
    if (!existsSync(bundledSource)) continue;

    const staging = mkdtempSync(path.join(tmpdir(), "nexus-asar-"));
    try {
      // Extract once, restore the stripped directory, repack to the same path
      // with native addons and the PTY package left unpacked, as before.
      extractAll(asarPath, staging);
      const pkgInStaging = path.join(staging, "node_modules", pkgName, "dist", "node_modules");
      cpSync(bundledSource, pkgInStaging, { recursive: true });
      rmSync(asarPath, { force: true });
      await createPackageWithOptions(staging, asarPath, { unpack: `{${UNPACK_GLOBS.join(",")}}` });
      console.log(`  • afterPack: restored bundled node_modules for ${pkgName} (${asarPath})`);
    } finally {
      rmSync(staging, { recursive: true, force: true });
    }
  }
};
