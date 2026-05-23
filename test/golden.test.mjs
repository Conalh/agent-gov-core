/**
 * Golden compatibility tests for the contract-critical outputs of this
 * library — `fingerprintFinding` hashes and `normalizeMcpCommand` canonical
 * strings.
 *
 * These tests assert specific known-good values. If you change the hash
 * algorithm or the MCP normalization rules and these tests break, you're
 * breaking dedupe continuity for every existing consumer.
 *
 * Changing a value here is allowed only with:
 *  - A major version bump (or pre-1.0 minor)
 *  - A migration plan documented in CHANGELOG
 *  - Coordinated relock across all five consumer suite repos
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFinding, normalizeMcpCommand } from '../dist/index.js';

//
// ─── FINGERPRINT GOLDENS ─────────────────────────────────────────────────────
//

test('golden: minimal finding without salientKey', () => {
  const f = createFinding({
    tool: 'scope_trail',
    name: 'permission_allow_widened',
    severity: 'high',
    message: 'x',
    location: { file: '.claude/settings.json', line: 12 },
  });
  // This hash was the v0.4.2 form. Backwards-compat guarantee starts here.
  assert.equal(f.fingerprint, '45ed781e793c692a');
});

test('golden: finding with salientKey (added in 0.4.3)', () => {
  const f = createFinding({
    tool: 'capability_echo',
    name: 'suspicious_import',
    severity: 'high',
    message: 'x',
    location: { file: 'src/x.ts', line: 12 },
    salientKey: 'pkg-a',
  });
  assert.equal(f.fingerprint, 'c41d00e173447e8f');
});

test('golden: finding for an MCP server with salientKey', () => {
  const f = createFinding({
    tool: 'policy_mesh',
    name: 'mcp_command_mismatch',
    severity: 'medium',
    message: 'x',
    location: { file: '.mcp.json', line: 5 },
    salientKey: 'server-github',
  });
  assert.equal(f.fingerprint, 'fd1343d1cb4acd84');
});

test('golden: Windows backslash path normalizes to the POSIX hash', () => {
  // Cross-platform dedupe guarantee — see fingerprintFinding's path-normalize.
  const f = createFinding({
    tool: 'capability_echo',
    name: 'workflow_permission_write',
    severity: 'high',
    message: 'x',
    location: { file: '.github\\workflows\\ci.yml', line: 12 },
  });
  assert.equal(f.fingerprint, '2610cd5214510374');
});

test('golden: finding with column participates in hash', () => {
  const f = createFinding({
    tool: 'task_bound',
    name: 'out_of_scope_file',
    severity: 'medium',
    message: 'x',
    location: { file: 'src/unrelated.ts', line: 42, column: 5 },
  });
  assert.equal(f.fingerprint, '886eb410cee86d16');
});

//
// ─── MCP NORMALIZATION GOLDENS ───────────────────────────────────────────────
//

// v0.7.1 changed args/env serialization from space/pipe joins to JSON-encoded
// arrays to close two false-equivalence classes:
//   - args: ['a b'] vs ['a', 'b'] both produced 'a b' under space-join
//   - env: {A:'1|B=2'} vs {A:'1', B:'2'} both produced 'A=1|B=2' under pipe-join
// The canonical strings below reflect the JSON-encoded form. Any PolicyMesh
// run after v0.7.1 will see distinct canonicals for genuinely-distinct configs
// that were previously incorrectly conflated as identical.

test('golden: npx -y vs npx (neutral confirm flag dropped)', () => {
  const withYes = normalizeMcpCommand({ command: 'npx', args: ['-y', '@vendor/server@1.2.3'] });
  const withoutYes = normalizeMcpCommand({ command: 'npx', args: ['@vendor/server@1.2.3'] });
  assert.equal(withYes, withoutYes);
  assert.equal(withYes, 'cmd=npx\nargs=["@vendor/server@1.2.3"]');
});

test('golden: absolute-path runtime collapses to bare name', () => {
  // Path de-noising guarantee added in 0.5.0
  const abs = normalizeMcpCommand({ command: '/usr/local/bin/node', args: ['server.js'] });
  assert.equal(abs, 'cmd=node\nargs=["server.js"]');

  const alt = normalizeMcpCommand({ command: '/usr/bin/node', args: ['server.js'] });
  assert.equal(alt, 'cmd=node\nargs=["server.js"]');
});

test('golden: Windows NPX.CMD normalizes to the same canonical as bare npx', () => {
  const windows = normalizeMcpCommand({ command: 'NPX.CMD', args: ['@vendor/server@1.2.3'] });
  assert.equal(windows, 'cmd=npx\nargs=["@vendor/server@1.2.3"]');
});

test('golden: url-based MCP', () => {
  const r = normalizeMcpCommand({ url: 'https://example.com/mcp/' });
  assert.equal(r, 'url=https://example.com/mcp\nargs=[]');
});

test('golden: env values participate in canonical', () => {
  const r = normalizeMcpCommand({ command: 'node', args: ['x.js'], env: { TOKEN: 'abc' } });
  assert.equal(r, 'cmd=node\nargs=["x.js"]\nenv=[["TOKEN","abc"]]');
});

test('golden: custom script at absolute path keeps full path (NOT a runtime)', () => {
  // Sanity for the path-denoise fix: identity is the script path itself,
  // not just the basename, because we have no PATH-lookup guarantee.
  const r = normalizeMcpCommand({ command: '/opt/internal/orchestrator.sh', args: [] });
  assert.equal(r, 'cmd=/opt/internal/orchestrator.sh\nargs=[]');

  const bare = normalizeMcpCommand({ command: 'orchestrator.sh', args: [] });
  assert.notEqual(r, bare);
});
