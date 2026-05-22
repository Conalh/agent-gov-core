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

test('Windows-shaped executable names are case-folded (Cody regression)', () => {
  // Inspection: NPX.CMD and npx normalized differently, but Windows treats
  // them as the same executable. Both should produce identical identity.
  const upper = normalizeMcpCommand({ command: 'NPX.CMD', args: ['mcp-foo'] });
  const lower = normalizeMcpCommand({ command: 'npx', args: ['mcp-foo'] });
  const mixed = normalizeMcpCommand({ command: 'NpX.ExE', args: ['mcp-foo'] });
  assert.equal(upper, lower);
  assert.equal(mixed, lower);

  // Backslash-pathed Windows commands also case-fold (the backslash makes it
  // Windows-shaped, so even the drive letter is lowercased)
  const bsPath = normalizeMcpCommand({ command: 'C:\\Program Files\\NodeJS\\NPX.CMD', args: [] });
  const bsPathLower = normalizeMcpCommand({ command: 'c:\\program files\\nodejs\\npx.cmd', args: [] });
  assert.equal(bsPath, bsPathLower);
});

test('absolute-path runtime collapses to bare name (path de-noise)', () => {
  // Inspection: PolicyMesh false-positives across cross-platform setups where
  // one developer's MCP config has `node` and another's has `/usr/local/bin/node`.
  // Path basename is dropped for KNOWN_RUNTIMES, so they normalize identically.
  const bare = normalizeMcpCommand({ command: 'node', args: ['x.js'] });
  const linux1 = normalizeMcpCommand({ command: '/usr/bin/node', args: ['x.js'] });
  const linux2 = normalizeMcpCommand({ command: '/usr/local/bin/node', args: ['x.js'] });
  const mac = normalizeMcpCommand({ command: '/opt/homebrew/bin/node', args: ['x.js'] });
  assert.equal(bare, linux1);
  assert.equal(bare, linux2);
  assert.equal(bare, mac);
});

test('custom script at absolute path KEEPS its full path (not a known runtime)', () => {
  // Sanity for the path de-noise fix: only KNOWN_RUNTIMES collapse to basename.
  // Custom scripts at absolute paths carry their location as part of identity.
  const abs = normalizeMcpCommand({ command: '/opt/internal/orchestrator.sh', args: [] });
  const bare = normalizeMcpCommand({ command: 'orchestrator.sh', args: [] });
  assert.notEqual(abs, bare);
});

test('POSIX-shaped executable names keep their case', () => {
  // Sanity: case folding only applies when the path is Windows-shaped (had
  // .cmd/.exe/.bat/.ps1 suffix or backslash separators). POSIX paths stay
  // case-sensitive because `./curl` and `./CURL` are genuinely different files.
  const a = normalizeMcpCommand({ command: '/usr/bin/CURL', args: [] });
  const b = normalizeMcpCommand({ command: '/usr/bin/curl', args: [] });
  assert.notEqual(a, b);
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

test('known-boolean flags do not greedily eat the next positional (regression)', () => {
  // Inspection: --verbose followed by a non-flag was paired into --verbose=pkg,
  // so reordering `--host localhost --verbose pkg` vs `--verbose --host localhost pkg`
  // produced different canonical strings.
  const a = normalizeMcpCommand({ command: 'foo', args: ['--host', 'localhost', '--verbose', 'my-package'] });
  const b = normalizeMcpCommand({ command: 'foo', args: ['--verbose', '--host', 'localhost', 'my-package'] });
  assert.equal(a, b);
});

test('non-known-boolean flag still pairs with next positional', () => {
  // Sanity: the fix only changes behavior for flags in KNOWN_BOOLEAN_FLAGS.
  // Custom or unknown long flags retain the old "absorb next value" heuristic
  // since we can't know without a per-tool flag database.
  const a = normalizeMcpCommand({ command: 'foo', args: ['--port', '8080', 'server.js'] });
  const b = normalizeMcpCommand({ command: 'foo', args: ['--port=8080', 'server.js'] });
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
