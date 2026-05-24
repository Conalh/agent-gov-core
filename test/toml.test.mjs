import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseToml, readTomlObject } from '../dist/index.js';

test('readTomlObject: value mirrors toml (v0.4 alias)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agc-toml-'));
  const path = join(dir, 'cfg.toml');
  writeFileSync(path, `host = "localhost"\nport = 8080\n`);
  const result = readTomlObject(path);
  assert.deepEqual(result.value, { host: 'localhost', port: 8080 });
  assert.deepEqual(result.value, result.toml);
  assert.equal(result.value, result.toml);  // referential equality
});

test('readTomlObject: value is undefined when parsing fails', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agc-toml-'));
  const path = join(dir, 'bad.toml');
  writeFileSync(path, `[invalid section\nkey = `);
  const result = readTomlObject(path);
  assert.equal(result.value, undefined);
  assert.equal(result.toml, undefined);
  assert.ok(result.parseError instanceof Error);
});

test('basic key=value', () => {
  const r = parseToml(`a = 1\nb = "hello"\nc = true\n`);
  assert.deepEqual(r, { a: 1, b: 'hello', c: true });
});

test('standard tables', () => {
  const r = parseToml(`
[server]
host = "localhost"
port = 8080

[client]
name = "x"
`);
  assert.deepEqual(r, {
    server: { host: 'localhost', port: 8080 },
    client: { name: 'x' },
  });
});

test('dotted section header creates nested tables', () => {
  const r = parseToml(`[a.b.c]\nx = 1\n`);
  assert.deepEqual(r, { a: { b: { c: { x: 1 } } } });
});

test('array of tables', () => {
  const r = parseToml(`
[[servers]]
name = "a"
[[servers]]
name = "b"
`);
  assert.deepEqual(r, { servers: [{ name: 'a' }, { name: 'b' }] });
});

test('inline tables', () => {
  const r = parseToml(`server = { host = "localhost", port = 8080 }\n`);
  assert.deepEqual(r, { server: { host: 'localhost', port: 8080 } });
});

test('multi-line basic string', () => {
  const r = parseToml(`x = """
line one
line two"""
`);
  assert.equal(r.x, 'line one\nline two');
});

test('multi-line literal string', () => {
  const r = parseToml(`x = '''
no \\escapes \\here
'''
`);
  assert.equal(r.x, 'no \\escapes \\here\n');
});

test('dotted keys at top level', () => {
  const r = parseToml(`a.b.c = 1\n`);
  assert.deepEqual(r, { a: { b: { c: 1 } } });
});

test('quoted-key section header', () => {
  const r = parseToml(`["weird.name"]\nx = 1\n`);
  assert.deepEqual(r, { 'weird.name': { x: 1 } });
});

test('arrays of values', () => {
  const r = parseToml(`a = [1, 2, 3]\nb = ["x", "y"]\n`);
  assert.deepEqual(r, { a: [1, 2, 3], b: ['x', 'y'] });
});

test('comments are ignored', () => {
  const r = parseToml(`# top comment\na = 1 # trailing\n`);
  assert.deepEqual(r, { a: 1 });
});

test('hex/oct/bin integers', () => {
  const r = parseToml(`a = 0xff\nb = 0o755\nc = 0b1010\n`);
  assert.deepEqual(r, { a: 255, b: 0o755, c: 10 });
});

test('floats and underscores', () => {
  const r = parseToml(`a = 1_000\nb = 3.14\n`);
  assert.deepEqual(r, { a: 1000, b: 3.14 });
});

test('accepts subtable headers repeated under each AOT entry (P0 regression)', () => {
  // Caught by Cody: my v0.4.2 fix scoped definedTables globally per-file, which
  // wrongly rejected the legitimate TOML pattern of declaring `[fruits.physical]`
  // under each fresh `[[fruits]]` entry. Each AOT entry should reset the
  // "already defined" status of its subtable paths.
  const r = parseToml(`[[fruits]]
name = "apple"
[fruits.physical]
color = "red"

[[fruits]]
name = "banana"
[fruits.physical]
color = "yellow"
`);
  assert.deepEqual(r, {
    fruits: [
      { name: 'apple', physical: { color: 'red' } },
      { name: 'banana', physical: { color: 'yellow' } },
    ],
  });
});

test('still rejects duplicate subtable header WITHIN the same AOT entry', () => {
  // Sanity: the fix above mustn't relax duplicate detection within one entry.
  assert.throws(
    () => parseToml(`[[fruits]]
name = "apple"
[fruits.physical]
color = "red"
[fruits.physical]
color = "also red"
`),
    /Duplicate table definition/,
  );
});

test('rejects [foo] after [[foo]] (array-of-tables / table mix, regression)', () => {
  // Inspection: a `[foo]` header following `[[foo]]` previously descended
  // into the array's last entry and let writes leak into items[0].
  assert.throws(
    () => parseToml(`[[items]]
name = "first"

[items]
extra = "leak"
`),
    /Cannot redefine array-of-tables/,
  );
});

test('line-ending backslash with trailing whitespace trims correctly (regression)', () => {
  // Inspection: TOML spec permits a `\` followed by any amount of spaces/tabs
  // before the newline as a "line-ending backslash" that strips the newline
  // and trims leading whitespace on the next line. Previously the trailing
  // spaces caused the parser to fall into readEscape and (per Gemini's claim)
  // throw — actually it didn't crash but also didn't trim, producing
  // `"escaped line   \n  next"` instead of `"escaped linenext"`.
  const r = parseToml('val = """\nescaped line\\   \n   next"""\n');
  assert.equal(r.val, 'escaped linenext');
});

test('line-ending backslash with no trailing whitespace still works', () => {
  // Sanity: the fix mustn't regress the simple case.
  const r = parseToml('val = """\nescaped\\\nnext"""\n');
  assert.equal(r.val, 'escapednext');
});

test('rejects duplicate keys in inline tables (regression)', () => {
  // Inspection: standard tables already rejected duplicate keys, but inline
  // tables silently took the last value. `{ host = "a", host = "b" }` parsed
  // as `{ host: "b" }` instead of raising.
  assert.throws(
    () => parseToml(`server = { host = "a", host = "b" }\n`),
    /Duplicate key in inline table/,
  );
});

test('rejects pathological inline-table nesting cleanly (regression)', () => {
  // Pre-fix, parseInlineTable ↔ parseValue mutually recursed without a depth
  // guard, so `{ a = { a = { … } } }` ~1000 levels deep blew the stack.
  // The parser must now throw a clean error well below the JS stack limit.
  const deep = 'a = ' + '{ a = '.repeat(2000) + '1' + ' }'.repeat(2000);
  assert.throws(() => parseToml(deep), /TOML nesting too deep/);
});

test('rejects pathological array nesting cleanly (regression)', () => {
  // parseArray shares the same parseValue recursion — exercise the array path too.
  const deep = 'a = ' + '['.repeat(2000) + '1' + ']'.repeat(2000);
  assert.throws(() => parseToml(deep), /TOML nesting too deep/);
});

test('plausible nesting depths still parse fine', () => {
  // Sanity: 50 levels is well above any real-world config and must still parse.
  const ok = 'a = ' + '{ a = '.repeat(50) + '1' + ' }'.repeat(50);
  const r = parseToml(ok);
  assert.equal(typeof r.a, 'object');
});
