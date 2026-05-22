import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  SEVERITIES,
  TOOL_KINDS,
  isSeverity,
  isToolKind,
  isNamespacedKind,
  kind,
  createFinding,
  fingerprintFinding,
  validateFinding,
} from '../dist/index.js';

test('Severity constants', () => {
  assert.deepEqual(SEVERITIES, ['low', 'medium', 'high', 'critical']);
});

test('ToolKind constants', () => {
  assert.deepEqual(TOOL_KINDS, [
    'scope_trail',
    'policy_mesh',
    'capability_echo',
    'task_bound',
    'session_trail',
  ]);
});

test('type guards', () => {
  assert.equal(isSeverity('low'), true);
  assert.equal(isSeverity('LOW'), false);
  assert.equal(isSeverity(1), false);
  assert.equal(isToolKind('scope_trail'), true);
  assert.equal(isToolKind('unknown'), false);
});

test('JSON Schema is valid JSON with expected enums', () => {
  const schema = JSON.parse(readFileSync(new URL('../schemas/finding.schema.json', import.meta.url), 'utf8'));
  assert.deepEqual(schema.properties.severity.enum, ['low', 'medium', 'high', 'critical']);
  assert.deepEqual(schema.properties.tool.enum, [
    'scope_trail',
    'policy_mesh',
    'capability_echo',
    'task_bound',
    'session_trail',
  ]);
  assert.match(schema.properties.kind.pattern, /scope_trail/);
});

test('kind() constructs namespaced kinds from a ToolKind + slug', () => {
  assert.equal(kind('scope_trail', 'permission_allow_widened'), 'scope_trail.permission_allow_widened');
  assert.equal(kind('policy_mesh', 'mcp_command_mismatch'), 'policy_mesh.mcp_command_mismatch');
  assert.equal(kind('task_bound', 'external_fetch_added'), 'task_bound.external_fetch_added');
});

test('kind() rejects invalid slug shapes', () => {
  assert.throws(() => kind('scope_trail', 'has-kebab'), /must match/);
  assert.throws(() => kind('scope_trail', 'hasUpper'), /must match/);
  assert.throws(() => kind('scope_trail', 'has.dot'), /must match/);
  assert.throws(() => kind('scope_trail', ''), /must match/);
});

test('isNamespacedKind matches the JSON schema pattern', () => {
  assert.equal(isNamespacedKind('scope_trail.permission_allow_widened'), true);
  assert.equal(isNamespacedKind('policy_mesh.mcp_command_mismatch'), true);
  assert.equal(isNamespacedKind('session_trail.privileged_path_access'), true);

  assert.equal(isNamespacedKind('permission_allow_widened'), false); // no prefix
  assert.equal(isNamespacedKind('unknown_tool.foo'), false);          // bad prefix
  assert.equal(isNamespacedKind('scope_trail.HasUpper'), false);      // bad slug
  assert.equal(isNamespacedKind('scope_trail.'), false);              // empty slug
  assert.equal(isNamespacedKind(42), false);
});

test('kind() and isNamespacedKind round-trip cleanly', () => {
  for (const t of TOOL_KINDS) {
    const k = kind(t, 'some_finding');
    assert.equal(isNamespacedKind(k), true);
  }
});

test('createFinding builds a Finding with namespaced kind and fingerprint', () => {
  const f = createFinding({
    tool: 'scope_trail',
    name: 'permission_allow_widened',
    severity: 'high',
    message: 'Claude Code allow rule widened to Bash(npm *)',
    location: { file: '.claude/settings.json', line: 12 },
  });
  assert.equal(f.tool, 'scope_trail');
  assert.equal(f.kind, 'scope_trail.permission_allow_widened');
  assert.equal(f.severity, 'high');
  assert.equal(f.location.file, '.claude/settings.json');
  assert.equal(f.location.line, 12);
  assert.equal(typeof f.fingerprint, 'string');
  assert.match(f.fingerprint, /^[0-9a-f]{16}$/);
});

test('createFinding rejects invalid slugs by delegating to kind()', () => {
  assert.throws(
    () => createFinding({ tool: 'scope_trail', name: 'has-kebab', severity: 'low', message: 'x' }),
    /must match/,
  );
});

test('createFinding includes optional fields only when provided', () => {
  const minimal = createFinding({
    tool: 'task_bound',
    name: 'out_of_scope_file',
    severity: 'medium',
    message: 'touched a file outside the stated task',
  });
  assert.equal(minimal.detail, undefined);
  assert.equal(minimal.location, undefined);
  assert.equal(minimal.data, undefined);
  assert.equal(typeof minimal.fingerprint, 'string');

  const rich = createFinding({
    tool: 'task_bound',
    name: 'out_of_scope_file',
    severity: 'medium',
    message: 'touched a file outside the stated task',
    detail: 'longer explanation',
    location: { file: 'src/x.ts', line: 1 },
    data: { reason: 'unrelated' },
    fingerprint: 'override123',
  });
  assert.equal(rich.detail, 'longer explanation');
  assert.equal(rich.data.reason, 'unrelated');
  assert.equal(rich.fingerprint, 'override123');
});

test('fingerprintFinding is stable across identical findings', () => {
  const a = createFinding({
    tool: 'capability_echo',
    name: 'workflow_permission_write',
    severity: 'high',
    message: 'first run message',
    location: { file: '.github/workflows/ci.yml', line: 12 },
  });
  const b = createFinding({
    tool: 'capability_echo',
    name: 'workflow_permission_write',
    severity: 'high',
    message: 'wording drifted in v0.5',  // message changes don't affect fingerprint
    location: { file: '.github/workflows/ci.yml', line: 12 },
  });
  assert.equal(a.fingerprint, b.fingerprint);
});

test('fingerprintFinding normalizes Windows-style paths to forward slashes', () => {
  // A finding emitted on Windows and the same finding emitted on Linux CI
  // must collapse to the same fingerprint so dedupe works across platforms.
  const windowsFinding = createFinding({
    tool: 'capability_echo',
    name: 'workflow_permission_write',
    severity: 'high',
    message: 'x',
    location: { file: '.github\\workflows\\ci.yml', line: 12 },
  });
  const posixFinding = createFinding({
    tool: 'capability_echo',
    name: 'workflow_permission_write',
    severity: 'high',
    message: 'x',
    location: { file: '.github/workflows/ci.yml', line: 12 },
  });
  assert.equal(windowsFinding.fingerprint, posixFinding.fingerprint);
});

test('salientKey discriminates findings on the same (kind, file, line) site (regression)', () => {
  // Inspection: two distinct findings of the same kind on the same line would
  // collide under the old fingerprint, and a meta-reviewer would silently
  // dedupe one of them. salientKey lets the consumer disambiguate them with a
  // stable per-finding identifier (package name, server name, rule id).
  const a = createFinding({
    tool: 'capability_echo',
    name: 'suspicious_import',
    severity: 'high',
    message: 'Suspicious import of pkg-a',
    location: { file: 'src/x.ts', line: 12 },
    salientKey: 'pkg-a',
  });
  const b = createFinding({
    tool: 'capability_echo',
    name: 'suspicious_import',
    severity: 'high',
    message: 'Suspicious import of pkg-b',
    location: { file: 'src/x.ts', line: 12 },
    salientKey: 'pkg-b',
  });
  assert.notEqual(a.fingerprint, b.fingerprint);
});

test('findings without salientKey still produce stable identical fingerprints (regression)', () => {
  // Backwards-compatibility: pre-0.4.3 consumers don't set salientKey. Findings
  // without it must still fingerprint identically across runs.
  const a = createFinding({
    tool: 'scope_trail',
    name: 'permission_allow_widened',
    severity: 'high',
    message: 'first run wording',
    location: { file: '.claude/settings.json', line: 12 },
  });
  const b = createFinding({
    tool: 'scope_trail',
    name: 'permission_allow_widened',
    severity: 'high',
    message: 'wording drifted in v0.5',
    location: { file: '.claude/settings.json', line: 12 },
  });
  assert.equal(a.fingerprint, b.fingerprint);
});

test('fingerprintFinding produces the v0.4.2 hash for findings without salientKey (P0 regression)', () => {
  // Caught by Cody: v0.4.3 appended `?? ''` for salientKey, which changed the
  // hash for every existing finding that didn't set the field. Pin the v0.4.2
  // hash here so any future change to the hash shape for salient-less findings
  // gets caught immediately.
  const f = createFinding({
    tool: 'scope_trail',
    name: 'permission_allow_widened',
    severity: 'high',
    message: 'x',
    location: { file: '.claude/settings.json', line: 12 },
  });
  // The exact hash produced by `sha256('scope_trail.permission_allow_widened|.claude/settings.json|12|').slice(0, 16)`
  // — the v0.4.2 form. If this test breaks, dedupe continuity across v0.4.2 → 0.4.4 has broken.
  assert.equal(f.fingerprint, '45ed781e793c692a');
});

test('validateFinding accepts salientKey when string, rejects when not', () => {
  const ok = validateFinding({
    tool: 'capability_echo',
    kind: 'capability_echo.suspicious_import',
    severity: 'high',
    message: 'x',
    salientKey: 'pkg-a',
  });
  assert.equal(ok.ok, true);

  const bad = validateFinding({
    tool: 'capability_echo',
    kind: 'capability_echo.suspicious_import',
    severity: 'high',
    message: 'x',
    salientKey: 42,
  });
  assert.equal(bad.ok, false);
  assert.ok(bad.errors.some((e) => /salientKey/.test(e)));
});

test('fingerprintFinding differs for different sites', () => {
  const a = createFinding({
    tool: 'capability_echo',
    name: 'workflow_permission_write',
    severity: 'high',
    message: 'x',
    location: { file: '.github/workflows/ci.yml', line: 12 },
  });
  const b = createFinding({
    tool: 'capability_echo',
    name: 'workflow_permission_write',
    severity: 'high',
    message: 'x',
    location: { file: '.github/workflows/ci.yml', line: 13 },  // different line
  });
  assert.notEqual(a.fingerprint, b.fingerprint);
});

test('validateFinding accepts a well-formed Finding', () => {
  const f = createFinding({
    tool: 'scope_trail',
    name: 'permission_allow_widened',
    severity: 'high',
    message: 'x',
    location: { file: '.claude/settings.json', line: 12 },
  });
  const result = validateFinding(f);
  assert.equal(result.ok, true);
  assert.deepEqual(result.errors, []);
});

test('validateFinding rejects missing required fields', () => {
  const result = validateFinding({});
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.includes('tool')));
  assert.ok(result.errors.some((e) => e.includes('kind')));
  assert.ok(result.errors.some((e) => e.includes('severity')));
  assert.ok(result.errors.some((e) => e.includes('message')));
});

test('validateFinding rejects mismatch between tool and kind prefix', () => {
  const result = validateFinding({
    tool: 'scope_trail',
    kind: 'policy_mesh.something',
    severity: 'low',
    message: 'x',
  });
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => /must start with tool/.test(e)));
});

test('validateFinding rejects unknown top-level properties', () => {
  const result = validateFinding({
    tool: 'scope_trail',
    kind: 'scope_trail.permission_allow_widened',
    severity: 'high',
    message: 'x',
    surface: 'config',  // not in schema
  });
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => /unknown property: surface/.test(e)));
});

test('validateFinding rejects invalid location values', () => {
  const result = validateFinding({
    tool: 'scope_trail',
    kind: 'scope_trail.permission_allow_widened',
    severity: 'high',
    message: 'x',
    location: { file: '', line: 0 },
  });
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => /location.file/.test(e)));
  assert.ok(result.errors.some((e) => /location.line/.test(e)));
});

test('validateFinding rejects non-object input', () => {
  assert.equal(validateFinding(null).ok, false);
  assert.equal(validateFinding(undefined).ok, false);
  assert.equal(validateFinding([]).ok, false);
  assert.equal(validateFinding('x').ok, false);
});
