// One-time migration: split src/styles-additions.css into ordered feature
// files under src/styles/additions/. Split purely at section-marker comments;
// file order preserves cascade order exactly, so concatenating the parts
// (in import order) is equivalent to the original stylesheet. Idempotent:
// if the input is already an @import index, this exits without changes.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const src = path.join(here, "..", "src");
const input = path.join(src, "styles-additions.css");
const outDir = path.join(src, "styles", "additions");

const text = fs.readFileSync(input, "utf8");

if (text.includes('@import "./styles/additions/')) {
  console.log("styles-additions.css is already an index of parts — nothing to do.");
  process.exit(0);
}

// Section markers: standalone full-line comments used as chapter titles.
const markerRe = /^\/\*\s*(?!@)(?!\d)([^\n*]{3,70}?)\s*\*\/\s*$/gm;

const lines = text.split(/\r?\n/);
const sections = [];
let current = { title: "preamble", lines: [] };
for (const line of lines) {
  markerRe.lastIndex = 0;
  if (markerRe.test(line)) {
    sections.push(current);
    current = { title: line.replace(/\/\*|\*\//g, "").trim(), lines: [] };
  } else {
    current.lines.push(line);
  }
}
sections.push(current);

fs.mkdirSync(outDir, { recursive: true });
const used = new Map();
const files = [];
for (const s of sections) {
  const body = s.lines.join("\n").trim();
  if (!body) continue;
  const slug = s.title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 48) || "section";
  let name = slug;
  let n = 2;
  while (used.has(name)) name = `${slug}-${n++}`;
  used.set(name, true);
  files.push({ name: `${String(files.length + 1).padStart(2, "0")}-${name}.css`, body });
}

for (const f of files) fs.writeFileSync(path.join(outDir, f.name), f.body + "\n", "utf8");
fs.writeFileSync(input, files.map((f) => `@import "./styles/additions/${f.name}";`).join("\n") + "\n", "utf8");
console.log(`\n${files.length} parts written to src/styles/additions/; styles-additions.css now only @imports them`);
