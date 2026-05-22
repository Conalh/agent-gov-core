import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stripJsonComments, readJsonObjectWithSource } from '../dist/index.js';

test('strips line comments', () => {
  const input = `{
  // this is a comment
  "a": 1
}`;
  const stripped = stripJsonComments(input);
  assert.deepEqual(JSON.parse(stripped), { a: 1 });
  // position preserved
  assert.equal(stripped.length, input.length);
});

test('strips block comments preserving newlines', () => {
  const input = `{
  /* multi
     line */
  "a": 1
}`;
  const stripped = stripJsonComments(input);
  assert.deepEqual(JSON.parse(stripped), { a: 1 });
  assert.equal(stripped.split('\n').length, input.split('\n').length);
});

test('preserves URLs inside strings (the // case)', () => {
  const input = `{ "url": "https://example.com/path", "x": 1 }`;
  const stripped = stripJsonComments(input);
  assert.deepEqual(JSON.parse(stripped), { url: 'https://example.com/path', x: 1 });
});

test('strips trailing commas', () => {
  const input = `{ "a": 1, "b": [1, 2, 3,], }`;
  const stripped = stripJsonComments(input);
  assert.deepEqual(JSON.parse(stripped), { a: 1, b: [1, 2, 3] });
});

test('does not strip commas inside strings', () => {
  const input = `{ "x": "a, b," }`;
  const stripped = stripJsonComments(input);
  assert.deepEqual(JSON.parse(stripped), { x: 'a, b,' });
});

test('readJsonObjectWithSource: returns text and json', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agc-'));
  const path = join(dir, 'cfg.json');
  writeFileSync(path, `{ "a": 1, /* note */ "b": 2, }`);
  const { json, text, parseError } = readJsonObjectWithSource(path);
  assert.equal(parseError, undefined);
  assert.deepEqual(json, { a: 1, b: 2 });
  assert.match(text, /note/);
});

test('readJsonObjectWithSource: surfaces parse error', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agc-'));
  const path = join(dir, 'bad.json');
  writeFileSync(path, `{ not valid }`);
  const { json, parseError } = readJsonObjectWithSource(path);
  assert.equal(json, undefined);
  assert.ok(parseError instanceof Error);
});
