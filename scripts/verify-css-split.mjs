// Verifies the CSS split kept all content: original (minus standalone
// chapter-comment lines, which were consumed as file titles) must equal the
// concatenation of the part files, ignoring whitespace.
import fs from "node:fs";
import { execSync } from "node:child_process";
import path from "node:path";

const root = process.cwd();
const outDir = path.join(root, "src", "styles", "additions");
const orig = execSync("git show 1f494b7:src/styles-additions.css", { cwd: root, maxBuffer: 64e6 }).toString("utf8");

const isStandaloneComment = (l) => {
  // Exactly the splitter's marker rule (incl. the @/digit lookaheads):
  return /^\/\*\s*(?!\@)(?!\d)([^\n*]{3,70}?)\s*\*\/\s*$/.test(l);
};
const kept = [];
for (const line of orig.split(/\r?\n/)) {
  if (isStandaloneComment(line)) continue; // consumed as section titles
  kept.push(line);
}
const a = kept.join("\n").replace(/\s+/g, "");

const parts = fs.readdirSync(outDir).filter((f) => f.endsWith(".css")).sort().map((f) =>
  fs.readFileSync(path.join(outDir, f), "utf8"));
const b = parts.join("\n").replace(/\s+/g, "");

console.log(`orig(minus headers)=${a.length} parts=${b.length}`);
if (a === b) {
  console.log("MATCH: split preserved all rule content (headers consumed as titles).");
  process.exit(0);
}
let i = 0;
while (i < Math.min(a.length, b.length) && a[i] === b[i]) i++;
console.log(`MISMATCH at stripped-index ${i}`);
console.log("orig context:", JSON.stringify(a.slice(Math.max(0, i - 90), i + 90)));
console.log("part context:", JSON.stringify(b.slice(Math.max(0, i - 90), i + 90)));
process.exit(1);
