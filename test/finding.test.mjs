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
