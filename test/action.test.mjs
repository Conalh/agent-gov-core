import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  rankSeverity,
  passesSeverityThreshold,
  anyAtOrAbove,
  emitFindingAnnotation,
} from '../dist/index.js';

test('rankSeverity ordering', () => {
  assert.ok(rankSeverity('low') < rankSeverity('medium'));
  assert.ok(rankSeverity('medium') < rankSeverity('high'));
  assert.ok(rankSeverity('high') < rankSeverity('critical'));
});

test('passesSeverityThreshold', () => {
  assert.equal(passesSeverityThreshold('high', 'medium'), true);
  assert.equal(passesSeverityThreshold('low', 'medium'), false);
  assert.equal(passesSeverityThreshold('medium', 'medium'), true);
});

test('anyAtOrAbove', () => {
  const findings = [
    { tool: 'scope_trail', kind: 'scope_trail.x', severity: 'low', message: 'a' },
    { tool: 'scope_trail', kind: 'scope_trail.y', severity: 'high', message: 'b' },
  ];
  assert.equal(anyAtOrAbove(findings, 'high'), true);
  assert.equal(anyAtOrAbove(findings, 'critical'), false);
});

test('emitFindingAnnotation produces ::error for high+', () => {
  const line = emitFindingAnnotation({
    tool: 'scope_trail',
    kind: 'scope_trail.x',
    severity: 'high',
    message: 'something bad',
    location: { file: 'src/foo.js', line: 12 },
  });
  assert.match(line, /^::error /);
  assert.match(line, /file=src\/foo\.js/);
  assert.match(line, /line=12/);
  assert.match(line, /::something bad$/);
});

test('emitFindingAnnotation produces ::warning for low/medium', () => {
  const line = emitFindingAnnotation({
    tool: 'policy_mesh',
    kind: 'policy_mesh.x',
    severity: 'medium',
    message: 'fyi',
  });
  assert.match(line, /^::warning /);
});

test('emitFindingAnnotation escapes special chars in message', () => {
  const line = emitFindingAnnotation({
    tool: 'scope_trail',
    kind: 'scope_trail.x',
    severity: 'low',
    message: 'line1\nline2',
  });
  assert.match(line, /line1%0Aline2$/);
});
