// LSP client tests: deterministic unit coverage of the framing parser, kind
// mapping, and language detection, plus a REAL round-trip against
// typescript-language-server when it is installed (skipped otherwise, so the
// suite stays green on machines and CI runners without the server).
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { existsSync } from 'node:fs';
import { parseLspFrames, lspSymbolKindToKind, languageForFile, lspDocumentSymbols } from '../dist-electron/lsp-service.js';

let passed = 0;
let failed = 0;

function test(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => {
      console.log(`  ✓ ${name}`);
      passed++;
    })
    .catch((error) => {
      console.error(`  ✗ ${name}`);
      console.error(error);
      failed++;
    });
}

await test('parseLspFrames: headers, chunked payloads, and multiple frames', () => {
  const a = { jsonrpc: '2.0', id: 1, result: { capabilities: {} } };
  const b = { jsonrpc: '2.0', method: 'textDocument/publishDiagnostics', params: { uri: 'file:///x.ts', diagnostics: [] } };
  const frame = (obj) => Buffer.from(`Content-Length: ${Buffer.byteLength(JSON.stringify(obj))}\r\n\r\n${JSON.stringify(obj)}`, 'utf8');
  const payload = Buffer.concat([frame(a), frame(b)]);

  // Whole buffer at once
  const once = parseLspFrames(payload);
  assert.equal(once.frames.length, 2);
  assert.deepEqual(once.frames[0].result, { capabilities: {} });
  assert.equal(once.frames[1].method, 'textDocument/publishDiagnostics');
  assert.equal(once.rest.length, 0);

  // Byte-at-a-time streaming (Content-Length counts BYTES, not chars)
  let rest = Buffer.alloc(0);
  const streamed = [];
  for (const byte of payload) {
    const parsed = parseLspFrames(Buffer.concat([rest, Buffer.from([byte])]));
    rest = parsed.rest;
    streamed.push(...parsed.frames);
  }
  assert.equal(streamed.length, 2);
  assert.deepEqual(streamed, once.frames);

  // Partial frame stays pending in rest
  const half = payload.subarray(0, payload.length - 5);
  const partial = parseLspFrames(half);
  assert.equal(partial.frames.length, 1);
  assert.ok(partial.rest.length > 0);

  // Multi-byte UTF-8 in payload must not corrupt framing
  const unicode = { jsonrpc: '2.0', method: 'x', params: { text: 'héllo ✓ 日本語' } };
  const uFrame = frame(unicode);
  const uParsed = parseLspFrames(uFrame);
  assert.equal(uParsed.frames.length, 1);
  assert.equal(uParsed.frames[0].params.text, 'héllo ✓ 日本語');
});

await test('lspSymbolKindToKind maps LSP SymbolKind numbers', () => {
  assert.equal(lspSymbolKindToKind(5), 'class');
  assert.equal(lspSymbolKindToKind(6), 'function');
  assert.equal(lspSymbolKindToKind(9), 'function');
  assert.equal(lspSymbolKindToKind(12), 'function');
  assert.equal(lspSymbolKindToKind(10), 'enum');
  assert.equal(lspSymbolKindToKind(11), 'interface');
  assert.equal(lspSymbolKindToKind(23), 'struct');
  assert.equal(lspSymbolKindToKind(14), 'variable');
  assert.equal(lspSymbolKindToKind(22), 'variable');
});

await test('languageForFile maps extensions to language servers', () => {
  assert.equal(languageForFile('src/App.tsx'), 'typescript');
  assert.equal(languageForFile('a.mjs'), 'typescript');
  assert.equal(languageForFile('x.py'), 'python');
  assert.equal(languageForFile('main.go'), 'go');
  assert.equal(languageForFile('lib.rs'), 'rust');
  assert.equal(languageForFile('main.cpp'), 'cpp');
  assert.equal(languageForFile('README.md'), null);
});

let serverAvailable = existsSync(
  path.join(process.cwd(), 'node_modules', '.bin', process.platform === 'win32' ? 'typescript-language-server.cmd' : 'typescript-language-server')
);
if (!serverAvailable) {
  console.log('  (typescript-language-server not installed — skipping live round-trip)');
}

if (serverAvailable) {
  await test('live round-trip: documentSymbol against typescript-language-server', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'nexus-lsp-'));
    try {
      await fs.writeFile(path.join(tempDir, 'tsconfig.json'), '{"compilerOptions":{"strict":true}}', 'utf8');
      await fs.writeFile(
        path.join(tempDir, 'sample.ts'),
        'export function greet(name: string): string {\n  return "hi " + name;\n}\n\nexport interface Thing { id: number }\n',
        'utf8'
      );
      const symbols = await lspDocumentSymbols(tempDir, path.join(tempDir, 'sample.ts'));
      const names = symbols.map((s) => s.name);
      assert.ok(names.includes('greet'), `expected greet, got: ${names.join(', ')}`);
      assert.equal(symbols.find((s) => s.name === 'greet')?.kind, 'function');
      assert.ok(names.includes('Thing'), `expected Thing, got: ${names.join(', ')}`);
      assert.equal(symbols.find((s) => s.name === 'Thing')?.kind, 'interface');
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
    }
  });
}
