import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeMcpCommand } from '../dist/index.js';

test('identical specs hash identically', () => {
  const a = normalizeMcpCommand({ command: 'npx', args: ['-y', 'mcp-package'] });
  const b = normalizeMcpCommand({ command: 'npx', args: ['-y', 'mcp-package'] });
  assert.equal(a, b);
});

test('neutral flag reordering does not change identity', () => {
  const a = normalizeMcpCommand({
    command: 'node',
    args: ['--foo', 'bar', '--baz', 'qux', 'server.js'],
  });
  const b = normalizeMcpCommand({
    command: 'node',
    args: ['--baz', 'qux', '--foo', 'bar', 'server.js'],
  });
  assert.equal(a, b);
});

test('positional args before flags are preserved in order', () => {
  const a = normalizeMcpCommand({ command: 'npx', args: ['package-a', '--flag', 'x'] });
  const b = normalizeMcpCommand({ command: 'npx', args: ['package-b', '--flag', 'x'] });
  assert.notEqual(a, b);
});

test('.cmd and .exe suffixes are stripped on Windows-style paths', () => {
  const a = normalizeMcpCommand({ command: 'npx.cmd', args: [] });
  const b = normalizeMcpCommand({ command: 'npx', args: [] });
  const c = normalizeMcpCommand({ command: 'npx.exe', args: [] });
  assert.equal(a, b);
  assert.equal(a, c);
});

test('env is included and order-independent', () => {
  const a = normalizeMcpCommand({ command: 'x', env: { A: '1', B: '2' } });
  const b = normalizeMcpCommand({ command: 'x', env: { B: '2', A: '1' } });
  assert.equal(a, b);
  const c = normalizeMcpCommand({ command: 'x', env: { A: '1', B: '3' } });
  assert.notEqual(a, c);
});

test('cwd is included', () => {
  const a = normalizeMcpCommand({ command: 'x', cwd: '/a' });
  const b = normalizeMcpCommand({ command: 'x', cwd: '/b' });
  assert.notEqual(a, b);
});

test('cwd path separators normalized', () => {
  const a = normalizeMcpCommand({ command: 'x', cwd: 'C:\\path\\to' });
  const b = normalizeMcpCommand({ command: 'x', cwd: 'C:/path/to' });
  assert.equal(a, b);
});

test('url-based MCP', () => {
  const a = normalizeMcpCommand({ url: 'https://example.com/mcp/' });
  const b = normalizeMcpCommand({ url: 'https://example.com/mcp' });
  assert.equal(a, b);
});

test('--key=value treated same as --key value', () => {
  const a = normalizeMcpCommand({ command: 'x', args: ['--foo=bar'] });
  const b = normalizeMcpCommand({ command: 'x', args: ['--foo', 'bar'] });
  assert.equal(a, b);
});

test('post-flag positional args preserve order (regression)', () => {
  // Bug class caught by Gemini code review: post-flag positional args were
  // co-sorted with flag pairs, collapsing different orderings to the same
  // identity. PolicyMesh's mcp_command_mismatch would under-report when two
  // configs had the same flags but different post-flag positional order.
  const ab = normalizeMcpCommand({ command: 'node', args: ['--flag', 'x', 'a', 'b'] });
  const ba = normalizeMcpCommand({ command: 'node', args: ['--flag', 'x', 'b', 'a'] });
  assert.notEqual(ab, ba);
});

test('flag order still does not affect identity even with post-flag positionals', () => {
  // Sanity check that the regression fix didn't over-correct: flags should
  // still be sortable regardless of where positionals fall.
  const a = normalizeMcpCommand({
    command: 'node',
    args: ['--foo', 'bar', '--baz', 'qux', 'server.js'],
  });
  const b = normalizeMcpCommand({
    command: 'node',
    args: ['--baz', 'qux', '--foo', 'bar', 'server.js'],
  });
  assert.equal(a, b);
});

test('npx -y <pkg> normalizes the same as npx <pkg> (neutral confirm flag)', () => {
  // Regression: PolicyMesh's mcp_command_mismatch false-positive class.
  // `-y` / `--yes` on npx only suppresses the install prompt — it doesn't
  // change what runs. Two surfaces should not be flagged as mismatched
  // just because one omits the confirm flag.
  const withYes = normalizeMcpCommand({ command: 'npx', args: ['-y', 'foo@1.2.3'] });
  const withoutYes = normalizeMcpCommand({ command: 'npx', args: ['foo@1.2.3'] });
  const withLongYes = normalizeMcpCommand({ command: 'npx', args: ['--yes', 'foo@1.2.3'] });
  assert.equal(withYes, withoutYes);
  assert.equal(withLongYes, withoutYes);
});
