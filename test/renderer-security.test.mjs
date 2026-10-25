// Renderer-security regression canary.
//
// Two layers:
//  1. Static: the packaged main bundle must keep contextIsolation: true,
//     nodeIntegration: false and a sandboxed-by-default main window.
//  2. Runtime: a real sandboxed BrowserWindow loads the actual preload bundle
//     and the contextBridge API must be exposed and callable. This proves the
//     production preload configuration (including `sandbox: true`) works —
//     not just that the source text says so.
//
// Run: npx electron test/renderer-security.test.mjs  (exit 0 = pass)
// NOTE: no top-level await — Electron's main process does not resolve
// `app.whenReady()` under top-level-await module evaluation; use .then().

import assert from "node:assert/strict";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { app, BrowserWindow } from "electron";

const here = path.dirname(fileURLToPath(import.meta.url));
const distMain = path.join(here, "..", "dist-electron", "main.js");
const distPreload = path.join(here, "..", "dist-electron", "preload.cjs");

assert.ok(fs.existsSync(distMain), "dist-electron/main.js must be built first (npm run build:electron)");
assert.ok(fs.existsSync(distPreload), "dist-electron/preload.cjs must be built first (npm run build:electron)");

const mainSource = fs.readFileSync(distMain, "utf8");

let staticFailures = 0;
const checkSource = (pattern, ok = true, label) => {
  const matched = pattern.test(mainSource);
  const pass = matched === ok;
  console.log(`  ${pass ? "✔" : "✖"} ${label || pattern.toString()}`);
  if (!pass) staticFailures++;
};
console.log("=== 1. Packaged BrowserWindow configuration (static) ===");

checkSource(/contextIsolation:\s*true/, true, "main window keeps contextIsolation: true");
checkSource(/nodeIntegration:\s*false/, true, "main window keeps nodeIntegration: false");
checkSource(/sandbox:\s*process\.env\.NEXUS_SANDBOX\s*===\s*"0"\s*\?\s*false\s*:\s*true/, true, "main window defaults sandbox: true (dev-only NEXUS_SANDBOX=0 escape hatch)");
checkSource(/will-attach-webview/, true, "will-attach-webview guard exists");
checkSource(/webPreferences\.sandbox\s*=\s*true/, true, "attached webviews forced sandbox: true");
checkSource(/setWindowOpenHandler/, true, "window-open guard exists");
checkSource(/will-navigate/, true, "will-navigate guard exists");
checkSource(/preload:\s*path\.join\(__dirname,\s*"preload\.cjs"\)/, true, "renderer preload is the compiled bundle, not a node context");

let failures = 0;
const finish = (code) => {
  console.log(code === 0 ? "\nSummary: renderer security canary passed" : `\nSummary: ${failures} renderer-security failures`);
  process.exitCode = code;
  app.exit(code);
};

if (staticFailures > 0) {
  failures = staticFailures;
  console.log(`\n(skip runtime canary)`);
  finish(1);
} else {
  app.whenReady().then(async () => {
    console.log("=== 2. Sandbox+preload runtime canary ===");

    const win = new BrowserWindow({
      show: false,
      webPreferences: {
        preload: distPreload,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        webviewTag: true,
        plugins: true,
      },
    });
    await win.loadURL("data:text/html,<html><body><h1>canary</h1></body></html>");

    const prefs = win.webContents.getLastWebPreferences() || {};
    const runtimeChecks = [
      ["Chromium sandbox engaged", prefs.sandbox === true],
      ["contextIsolation stays on", prefs.contextIsolation === true],
      ["nodeIntegration stays off", prefs.nodeIntegration === false],
    ];

    const exposed = await win.webContents.executeJavaScript(
      "(function(){try{ return { nexus: typeof window.nexus, runAgent: typeof window.nexus?.runAgent, onAgentEvent: typeof window.nexus?.onAgentEvent }; }catch(e){ return { error: String(e) }; } })()"
    );
    if (exposed.error) console.log("  bridge probe error:", exposed.error);
    runtimeChecks.push(
      ["contextBridge exposed window.nexus", exposed.nexus === "object"],
      ["window.nexus.runAgent callable", exposed.runAgent === "function"],
      ["window.nexus.onAgentEvent callable", exposed.onAgentEvent === "function"]
    );

    // Sandboxed renderers must not resolve native Node modules. In a sandboxed
    // renderer `process` is a limited shim: getBuiltinModule either does not
    // exist ('none') or yields nothing for 'fs' ('null').
    const leak = await win.webContents.executeJavaScript(
      "(function(){try{ return { nodeRequire: (typeof process === 'undefined' || typeof process.getBuiltinModule !== 'function') ? 'none' : (String(process.getBuiltinModule('fs') ?? 'null')) }; }catch(e){ return { error: String(e) }; } })()"
    );
    runtimeChecks.push(["sandboxed process shim exposes no fs module", leak.nodeRequire === "none" || leak.nodeRequire === "null"]);

    for (const [label, ok] of runtimeChecks) {
      console.log(`  ${ok ? "✔" : "✖"} ${label}`);
      if (!ok) failures++;
    }

    try { win.destroy(); } catch { /* window already gone */ }
    finish(failures === 0 ? 0 : 1);
  }, (error) => {
    failures++;
    console.error("  runtime canary crashed:", error);
    finish(1);
  });
}
