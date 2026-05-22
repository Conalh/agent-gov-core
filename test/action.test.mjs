import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  rankSeverity,
  passesSeverityThreshold,
  anyAtOrAbove,
  emitFindingAnnotation,
  generateWorkflowSummary,
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

test('generateWorkflowSummary: empty findings produces no-findings message', () => {
  const out = generateWorkflowSummary([]);
  assert.match(out, /^# Findings/);
  assert.match(out, /No findings\./);
});

test('generateWorkflowSummary: groups by severity in critical-first order', () => {
  const findings = [
    { tool: 'scope_trail', kind: 'scope_trail.a', severity: 'low', message: 'low one', location: { file: 'a', line: 1 } },
    { tool: 'scope_trail', kind: 'scope_trail.b', severity: 'critical', message: 'crit one', location: { file: 'b', line: 2 } },
    { tool: 'scope_trail', kind: 'scope_trail.c', severity: 'high', message: 'high one', location: { file: 'c', line: 3 } },
  ];
  const out = generateWorkflowSummary(findings);
  const critIdx = out.indexOf('1 critical');
  const highIdx = out.indexOf('1 high');
  const lowIdx = out.indexOf('1 low');
  assert.ok(critIdx > -1 && highIdx > critIdx && lowIdx > highIdx,
    `Expected critical → high → low ordering, got positions ${critIdx}, ${highIdx}, ${lowIdx}`);
});

test('generateWorkflowSummary: totals line summarizes counts', () => {
  const findings = [
    { tool: 'scope_trail', kind: 'scope_trail.x', severity: 'critical', message: 'm', location: { file: 'a', line: 1 } },
    { tool: 'scope_trail', kind: 'scope_trail.x', severity: 'critical', message: 'm', location: { file: 'a', line: 2 } },
    { tool: 'scope_trail', kind: 'scope_trail.x', severity: 'high', message: 'm', location: { file: 'a', line: 3 } },
  ];
  const out = generateWorkflowSummary(findings);
  assert.match(out, /3 findings/);
  assert.match(out, /2 critical/);
  assert.match(out, /1 high/);
});

test('generateWorkflowSummary: escapes pipe and newline in message cells', () => {
  const findings = [{
    tool: 'capability_echo',
    kind: 'capability_echo.x',
    severity: 'medium',
    message: 'one | two\nthree',
    location: { file: 'a', line: 1 },
  }];
  const out = generateWorkflowSummary(findings);
  // Pipe must be escaped so it doesn't break the Markdown table column count
  assert.match(out, /one \\\| two/);
  // Newlines collapsed to spaces
  assert.doesNotMatch(out, /two\nthree/);
});

test('generateWorkflowSummary: truncates long messages', () => {
  const longMsg = 'a'.repeat(500);
  const findings = [{
    tool: 'capability_echo',
    kind: 'capability_echo.x',
    severity: 'medium',
    message: longMsg,
    location: { file: 'a', line: 1 },
  }];
  const out = generateWorkflowSummary(findings, { messageMaxLength: 50 });
  // The message column must contain ≤ 50 chars then a `…`
  const row = out.split('\n').find((l) => l.includes('capability_echo.x'));
  assert.ok(row);
  assert.match(row, /a{49}…/);
});

test('generateWorkflowSummary: caps per-severity rows with overflow line', () => {
  const findings = [];
  for (let i = 0; i < 5; i++) {
    findings.push({
      tool: 'scope_trail',
      kind: 'scope_trail.x',
      severity: 'critical',
      message: `m${i}`,
      location: { file: `f${i}`, line: i + 1 },
    });
  }
  const out = generateWorkflowSummary(findings, { perSeverityLimit: 2 });
  // 2 rows + overflow indicator
  assert.match(out, /\+3 more critical findings/);
});

test('generateWorkflowSummary: HTML-escapes message content (Cody regression)', () => {
  // Inspection: a message containing </summary> or other HTML tags could
  // break out of the <details> block and manipulate the rendered layout.
  // GitHub sanitizes script execution but doesn't fix visual injection.
  const findings = [{
    tool: 'capability_echo',
    kind: 'capability_echo.x',
    severity: 'medium',
    message: 'evil</summary><h1>injected heading</h1>',
    location: { file: 'src/x.ts', line: 1 },
  }];
  const out = generateWorkflowSummary(findings);
  // No raw `</summary>` in the message cell — it'd close the wrapping <details>
  assert.doesNotMatch(out, /evil<\/summary>/);
  // Properly escaped
  assert.match(out, /evil&lt;\/summary&gt;/);
  assert.match(out, /&lt;h1&gt;injected heading&lt;\/h1&gt;/);
});

test('generateWorkflowSummary: escapes ampersand to prevent entity confusion', () => {
  const findings = [{
    tool: 'capability_echo',
    kind: 'capability_echo.x',
    severity: 'low',
    message: 'A & B & C',
    location: { file: 'a', line: 1 },
  }];
  const out = generateWorkflowSummary(findings);
  assert.match(out, /A &amp; B &amp; C/);
});

test('generateWorkflowSummary: handles findings without location gracefully', () => {
  const findings = [{
    tool: 'session_trail',
    kind: 'session_trail.x',
    severity: 'high',
    message: 'no location finding',
  }];
  const out = generateWorkflowSummary(findings);
  // Should not crash; file/line columns show em-dash
  assert.match(out, /\| — \| — \|/);
});
