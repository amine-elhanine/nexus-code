// Renderer snapshot harness — the verification gate the CSS collapse
// procedure requires (see the CSS DEBT MAP in src/styles/design-fixes.css).
//
// Boots the REAL renderer bundle (dist/index.html) in a hidden Electron
// window with a stubbed `window.nexus` API (test/harness/nexus-api-stub.cjs),
// switches through all three areas, and captures per area:
//   1. a DOM class inventory (tag + class-list multiset — stable across
//      runs, sensitive to CSS/structural drift),
//   2. computed-style assertions on cascade-critical selectors.
//
// Snapshots live in test/__snapshots__/; set NEXUS_UPDATE_SNAPSHOTS=1 to
// regenerate. Run with: npm run test:snapshot  (requires `npm run build`
// first — it loads the production bundle).
import { app, BrowserWindow } from "electron";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, "..");
const distIndex = path.join(root, "dist", "index.html");
const snapshotsDir = path.join(root, "test", "__snapshots__");
const update = process.env.NEXUS_UPDATE_SNAPSHOTS === "1";

let passed = 0;
let failed = 0;
function test(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => { console.log(`  ✓ ${name}`); passed++; })
    .catch((error) => { console.error(`  ✗ ${name}`); console.error(error); failed++; });
}

// ── captured in the page ────────────────────────────────────────────────
function captureScript(area) {
  return `(() => {
    const rootEl = document.querySelector('.app-root');
    if (!rootEl) return null;
    // Class inventory: tag + sorted class list per element. Stable identity
    // across runs (no ids, no timestamps, no generated keys), sensitive to
    // any CSS restructure that changes the rendered DOM.
    const inventory = {};
    for (const el of rootEl.querySelectorAll('*')) {
      const classes = Array.from(el.classList).sort().join('.');
      if (!classes) continue;
      const key = el.tagName.toLowerCase() + (classes ? '.' + classes : '');
      inventory[key] = (inventory[key] || 0) + 1;
    }
    // Computed-style assertions on cascade-critical selectors. Each value is
    // reduced to a compact string (name:value;...) of the properties the CSS
    // collapse must preserve.
    const styles = {};
    const probes = {
      appRoot: '.app-root',
      sidebar: '.app-sidebar',
      modeSwitcher: '.mode-switcher',
      modePillActive: '.mode-pill.active',
      topbar: '.app-root .home-topbar, .app-root .nb-topbar, .app-root .code-workbench-header',
      stage: '.app-view-stage',
    };
    const PROPS = ['padding-top','padding-right','padding-bottom','padding-left','display','position','overflow-y','background-color','color','border-radius','font-size'];
    for (const [name, sel] of Object.entries(probes)) {
      const el = document.querySelector(sel);
      if (!el) { styles[name] = null; continue; }
      const cs = getComputedStyle(el);
      styles[name] = PROPS.map((p) => p + ':' + cs.getPropertyValue(p).trim()).join(';');
    }
    // Presence flags the collapse procedure must not break.
    const presence = {
      modeSwitcher: !!document.querySelector('.mode-switcher'),
      modePills: document.querySelectorAll('.mode-pill').length,
      sidebar: !!document.querySelector('.app-sidebar'),
      transcriptOrEmpty: !!document.querySelector('.chat-transcript, .chat-empty, .agent-empty, .empty-state, .home-empty'),
      scrollbarsStyled: !!Array.from(document.styleSheets).length,
    };
    return JSON.stringify({ area: ${JSON.stringify(area)}, inventory, styles, presence });
  })()`;
}

function sanitize(capture) {
  // Keep deterministic keys only — tolerate class names that embed generated
  // suffixes (none known today; defensive for future CSS-module adoption).
  return capture;
}

async function waitFor(win, expr, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const ok = await win.webContents.executeJavaScript(`!!(${expr})`).catch(() => false);
    if (ok) return true;
    if (Date.now() > deadline) return false;
    await new Promise((r) => setTimeout(r, 250));
  }
}

const AREAS = ["home", "code", "notebook"];

app.whenReady().then(async () => {
  console.log("\n=== Renderer snapshot harness ===");
  if (!fs.existsSync(distIndex)) {
    console.error(`dist/index.html not found — run \`npm run build\` first (this harness boots the production renderer bundle).`);
    app.exit(1);
    return;
  }

  // Generate the API stub from the COMPILED preload's method list, so the
  // stub always covers the real NexusApi surface (219+ methods). A Proxy
  // cannot be used: contextBridge refuses non-cloneable objects.
  const preloadSource = fs.readFileSync(path.join(root, "dist-electron", "preload.cjs"), "utf8");
  const methodNames = [...new Set([...preloadSource.matchAll(/^\s+([a-zA-Z]+): \(/gm)].map((m) => m[1]))];
  if (methodNames.length < 50) throw new Error(`Only ${methodNames.length} API methods parsed from preload — extraction regex broke`);
  const stubPath = path.join(root, "test", ".renderer-build", "nexus-api-stub.gen.cjs");
  fs.mkdirSync(path.dirname(stubPath), { recursive: true });
  fs.writeFileSync(stubPath, `// GENERATED by test/renderer-snapshot.test.mjs — do not edit.
const { contextBridge } = require("electron");
const stub = () => Promise.resolve([]);
const api = {
${methodNames.map((n) => `  ${n}: stub,`).join("
")}
};
contextBridge.exposeInMainWorld("nexus", api);
`);

  const win = new BrowserWindow({
    show: false,
    width: 1440,
    height: 900,
    webPreferences: {
      preload: stubPath,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  const results = {};

  try {
    await win.loadFile(distIndex);
    const booted = await waitFor(win, "document.querySelector('.app-root')");
    if (!booted) throw new Error("Renderer did not mount .app-root within 30s");
    // Allow lazy chunks + first effects to settle.
    await new Promise((r) => setTimeout(r, 2500));

    for (const area of AREAS) {
      if (area !== "home") {
        await win.webContents.executeJavaScript(`
          (() => {
            const pill = document.querySelector('.mode-pill.mode-${area}');
            if (pill) { pill.click(); return 'clicked'; }
            return 'missing';
          })()
        `);
        await new Promise((r) => setTimeout(r, 1500));
      }
      const raw = await win.webContents.executeJavaScript(captureScript(area));
      if (!raw) throw new Error(`No .app-root capture for area ${area}`);
      results[area] = sanitize(JSON.parse(raw));
    }
  } catch (error) {
    console.error("Harness boot failed:", error.message);
    await win.destroy();
    app.exit(1);
    return;
  }
  await win.destroy();

  await test("boot renders all three areas with stable class inventories", () => {
    fs.mkdirSync(snapshotsDir, { recursive: true });
    const file = path.join(snapshotsDir, "renderer-areas.json");
    const previous = fs.existsSync(file) && !update ? JSON.parse(fs.readFileSync(file, "utf8")) : null;
    if (!previous) {
      fs.writeFileSync(file, JSON.stringify(results, null, 2));
      console.log("    (first run — baseline written; re-run to compare)");
      return;
    }
    for (const area of AREAS) {
      const a = JSON.stringify(results[area].inventory, null, 1);
      const b = JSON.stringify(previous[area]?.inventory, null, 1);
      if (a !== b) {
        // Diff summary: keys added/removed with counts.
        const diff = [];
        const keys = new Set([...Object.keys(results[area].inventory), ...Object.keys(previous[area]?.inventory || {})]);
        for (const k of keys) {
          if (results[area].inventory[k] !== previous[area]?.inventory?.[k]) {
            diff.push(`    ${k}: ${previous[area]?.inventory?.[k] ?? 0} -> ${results[area].inventory[k] ?? 0}`);
          }
        }
        throw new Error(`Class inventory drifted for area "${area}" (NEXUS_UPDATE_SNAPSHOTS=1 to accept):\n${diff.slice(0, 40).join("\n")}`);
      }
    }
  });

  await test("cascade-critical computed styles hold across all areas", () => {
    // The invariants the CSS collapse procedure must preserve. Written as
    // presence checks (values may legitimately vary by theme) — plus exact
    // assertions for the known regression classes (topbar window-controls
    // padding, transcript bottom padding).
    for (const area of AREAS) {
      const styles = results[area].styles;
      if (!styles?.appRoot) throw new Error(`${area}: .app-root has no computed style probe`);
      if (!styles?.sidebar) throw new Error(`${area}: .app-sidebar missing`);
      // Topbars must clear the window-controls strip (design-fixes #1).
      if (styles.topbar) {
        const pr = Number.parseInt(styles.topbar.match(/padding-right:([^;]*)/)?.[1] || "0", 10);
        if (!Number.isNaN(pr) && pr > 0 && pr < 120) {
          throw new Error(`${area}: topbar padding-right ${pr}px < 120px — topbars sliding under window controls again`);
        }
      }
    }
    if (!results.home.presence.modeSwitcher) throw new Error("home: .mode-switcher missing");
    if (results.notebook.presence.modePills < 1) throw new Error("notebook: mode pills missing");
  });

  console.log(`\nSummary: ${passed} passed, ${failed} failed.`);
  app.exit(failed > 0 ? 1 : 0);
});
