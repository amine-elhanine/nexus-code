// Unit tests for skill .zip import (plain Node, no Electron).
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import { extractSkillArchive } from '../dist-electron/skill-archive.js';

const { default: JSZip } = await import('jszip');

async function makeZip(files) {
  const zip = new JSZip();
  for (const [name, content] of Object.entries(files)) zip.file(name, content);
  return zip.generateAsync({ type: 'nodebuffer' });
}

async function exists(p) {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

let passed = 0;
let failed = 0;
async function test(name, fn) {
  try {
    await fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (error) {
    console.error(`  ✗ ${name}`);
    console.error(error);
    failed++;
  }
}

console.log('\n=== Skill Archive Tests ===');

await test('root-level SKILL.md with scripts extracts as-is', async () => {
  const buffer = await makeZip({
    'SKILL.md': '---\nname: deck\n---\n\nBuild decks.',
    'scripts/build.py': 'print("build")',
  });
  const { dir, cleanup } = await extractSkillArchive(buffer);
  try {
    assert.equal(await exists(path.join(dir, 'SKILL.md')), true);
    assert.equal(await exists(path.join(dir, 'scripts', 'build.py')), true);
  } finally {
    await cleanup();
  }
  assert.equal(await exists(dir), false);
});

await test('single top-level folder is unwrapped', async () => {
  const buffer = await makeZip({ 'my-skill/SKILL.md': '# skill', 'my-skill/run.sh': 'echo hi' });
  const { dir, cleanup } = await extractSkillArchive(buffer);
  try {
    assert.equal(path.basename(dir), 'my-skill');
    assert.equal(await exists(path.join(dir, 'SKILL.md')), true);
    assert.equal(await exists(path.join(dir, 'run.sh')), true);
  } finally {
    await cleanup();
  }
});

await test('lone markdown without SKILL.md resolves to its folder', async () => {
  const buffer = await makeZip({ 'docs/guide.md': '# guide' });
  const { dir, cleanup } = await extractSkillArchive(buffer);
  try {
    assert.equal(await exists(path.join(dir, 'guide.md')), true);
  } finally {
    await cleanup();
  }
});

await test('zip-slip and junk entries never escape the temp dir', async () => {
  const buffer = await makeZip({
    'SKILL.md': '# ok',
    '../evil.txt': 'x',
    '/abs.txt': 'x',
    '__MACOSX/._SKILL.md': 'x',
    '.git/config': 'x',
  });
  const { dir, cleanup } = await extractSkillArchive(buffer);
  try {
    assert.equal(await exists(path.join(dir, 'SKILL.md')), true);
    // Junk metadata is dropped; everything else stays contained.
    assert.equal(await exists(path.join(dir, '__MACOSX')), false);
    assert.equal(await exists(path.join(dir, '.git')), false);
    // Nothing escapes the temp dir, whatever jszip normalized the names to.
    assert.equal(await exists(path.join(path.dirname(dir), 'evil.txt')), false);
    assert.equal(await exists(path.join(path.dirname(dir), 'abs.txt')), false);
  } finally {
    await cleanup();
  }
});

await test('empty and markdown-less archives throw clear errors', async () => {
  const empty = await makeZip({});
  await assert.rejects(() => extractSkillArchive(empty), /no usable files/i);
  const noMd = await makeZip({ 'bin/tool.exe': 'x', 'data/blob.bin': 'y' });
  await assert.rejects(() => extractSkillArchive(noMd), /no SKILL\.md or markdown/i);
  await assert.rejects(() => extractSkillArchive(Buffer.from('not a zip')), /valid zip/i);
});

console.log(`\nskill-archive: ${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
