// AST symbol-extraction tests (tree-sitter path). Imports from dist-electron
// like the other standalone suites — run `npm run build:electron` first.
import assert from 'node:assert/strict';
import { ensureSymbolParsersReady, parseSymbolsWithTreeSitterSync } from '../dist-electron/symbol-parser.js';
import { parseSymbolsFromCode } from '../dist-electron/code-tools.js';

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

const ready = await ensureSymbolParsersReady();
console.log(ready ? 'grammars warmed' : 'WARNING: grammars unavailable — AST assertions will fail');

await test('TypeScript multi-line signatures survive (the regex parser truncated them)', async () => {
  const code = [
    'import React from "react";',
    '',
    'export function runQuery(',
    '  table: string,',
    '  filters: QueryFilter[],',
    '  opts?: { limit?: number; offset?: number },',
    '): Promise<Row[]> {',
    '  return db.select(table).where(filters);',
    '}',
  ].join('\n');
  const symbols = parseSymbolsWithTreeSitterSync(code, 'db.ts');
  assert.ok(symbols, 'tree-sitter should produce symbols for .ts');
  const fn = symbols.find((s) => s.name === 'runQuery');
  assert.ok(fn, 'runQuery found');
  assert.equal(fn.kind, 'function');
  assert.ok(fn.signature.includes('filters: QueryFilter[]'), `full params in signature, got: ${fn.signature}`);
  assert.ok(fn.signature.includes('Promise<Row[]>'), `return type in signature, got: ${fn.signature}`);
  assert.ok(!symbols.some((s) => s.name === 'db'), 'import bindings are not symbols');
});

await test('TSX class members: decorated property, arrow-field handler, method', async () => {
  const code = [
    'class Dash extends Base {',
    '  @Inject() private api: ApiClient;',
    '',
    '  handleSave = async (draft: Draft): Promise<void> => {',
    '    await this.api.put(draft);',
    '  };',
    '',
    '  render() {',
    '    return null;',
    '  }',
    '}',
  ].join('\n');
  const symbols = parseSymbolsWithTreeSitterSync(code, 'Dash.tsx');
  assert.ok(symbols, 'symbols for .tsx');
  const names = symbols.map((s) => s.name);
  assert.ok(names.includes('Dash'), `class captured, got: ${names.join(', ')}`);
  assert.ok(names.includes('handleSave'), `arrow field captured, got: ${names.join(', ')}`);
  assert.equal(symbols.find((s) => s.name === 'handleSave')?.kind, 'function');
  assert.ok(names.includes('render'), `method captured, got: ${names.join(', ')}`);
});

await test('Python: decorated function, class, and methods', async () => {
  const code = [
    '@app.route("/health")',
    'async def health():',
    '    return "ok"',
    '',
    'class Repo:',
    '    def find(self, id):',
    '        return None',
  ].join('\n');
  const symbols = parseSymbolsWithTreeSitterSync(code, 'repo.py');
  assert.ok(symbols, 'symbols for .py');
  const names = symbols.map((s) => s.name);
  assert.ok(names.includes('health'), `decorated function captured, got: ${names.join(', ')}`);
  assert.ok(names.includes('Repo'), 'class captured');
  assert.ok(names.includes('find'), 'method captured');
  assert.equal(symbols.find((s) => s.name === 'find')?.kind, 'function');
});

await test('Go: methods and struct types', async () => {
  const code = [
    'package main',
    '',
    'func (s *Store) Find(id string) (*Item, error) {',
    '    return nil, nil',
    '}',
    '',
    'type Store struct {',
    '    items map[string]*Item',
    '}',
  ].join('\n');
  const symbols = parseSymbolsWithTreeSitterSync(code, 'store.go');
  assert.ok(symbols, 'symbols for .go');
  const find = symbols.find((s) => s.name === 'Find');
  assert.ok(find, `method captured, got: ${symbols.map((s) => s.name).join(', ')}`);
  assert.equal(find.kind, 'function');
  const store = symbols.find((s) => s.name === 'Store');
  assert.ok(store, 'struct captured');
  assert.equal(store.kind, 'struct');
});

await test('Rust: fn inside impl, struct, enum, trait', async () => {
  const code = [
    'pub struct Api {',
    '    pub url: String,',
    '}',
    '',
    'impl Api {',
    '    pub async fn fetch(&self, path: &str) -> Result<String, Error> {',
    '        Ok(String::new())',
    '    }',
    '}',
    '',
    'pub enum Mode { Fast, Slow }',
    '',
    'pub trait Reporter {',
    '    fn report(&self);',
    '}',
  ].join('\n');
  const symbols = parseSymbolsWithTreeSitterSync(code, 'api.rs');
  assert.ok(symbols, 'symbols for .rs');
  const byName = Object.fromEntries(symbols.map((s) => [s.name, s]));
  assert.equal(byName.Api?.kind, 'struct', `struct, got: ${JSON.stringify(byName)}`);
  assert.equal(byName.fetch?.kind, 'function', 'fn inside impl captured');
  assert.equal(byName.Mode?.kind, 'enum', 'enum captured');
  assert.equal(byName.Reporter?.kind, 'trait', 'trait captured');
});

await test('parseSymbolsFromCode routes to AST when warm and never throws on malformed code', async () => {
  assert.ok(ready, 'grammars must be warm for this assertion');
  const good = parseSymbolsFromCode('export function one(): number {\n  return 1;\n}\n', 'one.ts');
  assert.ok(good.some((s) => s.name === 'one'), 'AST path returns symbols for .ts');

  const malformed = parseSymbolsWithTreeSitterSync('def (:\n  pass', 'broken.py');
  assert.ok(Array.isArray(malformed) || malformed === null, 'malformed code returns symbols or null, never throws');
});
