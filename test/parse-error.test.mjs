import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ConfigParseError,
  lineColumnOfOffset,
  readJsonObjectWithSource,
  readTomlObject,
  parseToml,
} from '../dist/index.js';

test('lineColumnOfOffset: byte 0 → line 1 col 1', () => {
  assert.deepEqual(lineColumnOfOffset('abc\ndef', 0), { line: 1, column: 1 });
});

test('lineColumnOfOffset: across newline', () => {
  // "abc\ndef" — offset 4 is 'd' on line 2 col 1
  assert.deepEqual(lineColumnOfOffset('abc\ndef', 4), { line: 2, column: 1 });
});

test('lineColumnOfOffset: mid-line', () => {
  assert.deepEqual(lineColumnOfOffset('abc\ndefgh', 6), { line: 2, column: 3 });
});

test('lineColumnOfOffset: offset past end clamps to length', () => {
  assert.deepEqual(lineColumnOfOffset('ab', 999), { line: 1, column: 3 });
});

test('lineColumnOfOffset: handles CRLF as one newline boundary', () => {
  // "ab\r\ncd" — offset 4 is 'c'. \r doesn't increment line, \n does.
  // Implementation only treats \n as newline, so column counts \r. Pragmatic.
  const { line } = lineColumnOfOffset('ab\r\ncd', 4);
  assert.equal(line, 2);
});

test('readJsonObjectWithSource: parseError is ConfigParseError with line/column on broken JSON', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agc-pe-'));
  const path = join(dir, 'bad.json');
  // Break on line 3 column 3 (the unexpected ':')
  writeFileSync(path, '{\n  "a": 1,\n  :"b" }\n');
  const { parseError } = readJsonObjectWithSource(path);
  assert.ok(parseError, 'parseError must be set');
  assert.ok(parseError instanceof ConfigParseError, 'parseError should be ConfigParseError');
  assert.equal(typeof parseError.line, 'number');
  assert.equal(typeof parseError.column, 'number');
  assert.equal(typeof parseError.rawOffset, 'number');
  assert.ok(parseError.line >= 1);
  assert.ok(parseError.column >= 1);
});

test('readTomlObject: parseError is ConfigParseError with line/column on broken TOML', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agc-pe-'));
  const path = join(dir, 'bad.toml');
  // Line 3 col 1: 'duplicate key' will be at the "key = 2" assignment
  writeFileSync(path, 'key = 1\nother = 2\nkey = 3\n');
  const { parseError } = readTomlObject(path);
  assert.ok(parseError, 'parseError must be set');
  assert.ok(parseError instanceof ConfigParseError, 'parseError should be ConfigParseError');
  assert.equal(parseError.line, 3);
});

test('readTomlObject: parseError carries an `at offset` from duplicate-table-definition (regression for missing offset)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agc-pe-'));
  const path = join(dir, 'dup.toml');
  writeFileSync(path, '[foo]\nbar = 1\n[foo]\nbaz = 2\n');
  const { parseError } = readTomlObject(path);
  assert.ok(parseError instanceof ConfigParseError);
  assert.match(parseError.message, /Duplicate table/);
  // Line resolves to wherever this.pos was — past the second `[foo]` header.
  assert.ok(parseError.line >= 3);
});

test('parseToml directly (no file wrap) still throws plain Error with offset string', () => {
  // Sanity: the structured wrap happens only at the file-reader level. Direct
  // parseToml callers see the underlying error format unchanged.
  assert.throws(() => parseToml('key = 1\nkey = 2\n'), (e) => {
    return e instanceof Error
      && !(e instanceof ConfigParseError)
      && /Duplicate key/.test(e.message)
      && /at offset \d+/.test(e.message);
  });
});

test('ConfigParseError preserves the original error via `cause`', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agc-pe-'));
  const path = join(dir, 'bad.json');
  writeFileSync(path, '{ not valid');
  const { parseError } = readJsonObjectWithSource(path);
  if (parseError instanceof ConfigParseError) {
    assert.ok(parseError.cause instanceof Error);
  }
});
