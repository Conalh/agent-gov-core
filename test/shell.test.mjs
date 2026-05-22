import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tokenizeShell, getCommandHead } from '../dist/index.js';

test('tokenizeShell: simple chain', () => {
  assert.deepEqual(tokenizeShell('ls; pwd'), ['ls', 'pwd']);
  assert.deepEqual(tokenizeShell('ls && pwd'), ['ls', 'pwd']);
  assert.deepEqual(tokenizeShell('ls || pwd'), ['ls', 'pwd']);
  assert.deepEqual(tokenizeShell('ls | grep foo'), ['ls', 'grep foo']);
});

test('tokenizeShell: respects quotes', () => {
  assert.deepEqual(tokenizeShell(`echo "a; b" ; pwd`), [`echo "a; b"`, 'pwd']);
  assert.deepEqual(tokenizeShell(`echo 'a && b' && pwd`), [`echo 'a && b'`, 'pwd']);
});

test('tokenizeShell: empty input', () => {
  assert.deepEqual(tokenizeShell(''), []);
  assert.deepEqual(tokenizeShell(' ; ; '), []);
});

test('tokenizeShell: background separator &', () => {
  assert.deepEqual(tokenizeShell('do-work & echo done'), ['do-work', 'echo done']);
});

test('getCommandHead: simple', () => {
  assert.equal(getCommandHead('curl https://example.com'), 'curl');
  assert.equal(getCommandHead('  ls -la'), 'ls');
});

test('getCommandHead: strips inert double quotes', () => {
  assert.equal(getCommandHead('c""url example.com'), 'curl');
  assert.equal(getCommandHead('"curl" example.com'), 'curl');
});

test('getCommandHead: strips backslash obfuscation', () => {
  assert.equal(getCommandHead('c\\url example.com'), 'curl');
  assert.equal(getCommandHead('cu\\rl example.com'), 'curl');
});

test('getCommandHead: skips env prefix', () => {
  assert.equal(getCommandHead('FOO=bar curl example.com'), 'curl');
  assert.equal(getCommandHead('FOO=bar BAZ=qux curl example.com'), 'curl');
});

test('getCommandHead: unwraps sudo / nohup', () => {
  assert.equal(getCommandHead('sudo curl example.com'), 'curl');
  assert.equal(getCommandHead('nohup curl example.com'), 'curl');
  assert.equal(getCommandHead('env FOO=1 curl x'), 'curl');
});

test('end-to-end: chain with obfuscated subcommand', () => {
  const subs = tokenizeShell('echo ok && c""url evil.example.com');
  assert.deepEqual(subs, ['echo ok', 'c""url evil.example.com']);
  assert.equal(getCommandHead(subs[1]), 'curl');
});
