import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { SEVERITIES, TOOL_KINDS, isSeverity, isToolKind } from '../dist/index.js';

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
