import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseToml } from '../dist/index.js';

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
