import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  REPORT_SCHEMA_VERSION,
  createFinding,
  createReport,
  maxSeverity,
  validateReport,
} from '../dist/index.js';

const sampleFinding = (severity = 'high', overrides = {}) =>
  createFinding({
    tool: 'scope_trail',
    name: 'permission_allow_widened',
    severity,
    message: 'x',
    location: { file: '.claude/settings.json', line: 12 },
    ...overrides,
  });

test('REPORT_SCHEMA_VERSION is "1.0"', () => {
  assert.equal(REPORT_SCHEMA_VERSION, '1.0');
});

test('createReport: sets schemaVersion and computes rating from findings', () => {
  const r = createReport({
    tool: 'scope_trail',
    findings: [sampleFinding('high'), sampleFinding('low', { name: 'permission_deny_removed' })],
  });
  assert.equal(r.schemaVersion, '1.0');
  assert.equal(r.tool, 'scope_trail');
  assert.equal(r.rating, 'high');
  assert.equal(r.findings.length, 2);
});

test('createReport: empty findings rates none', () => {
  const r = createReport({ tool: 'scope_trail', findings: [] });
  assert.equal(r.rating, 'none');
});

test('createReport: explicit rating overrides derived one', () => {
  const r = createReport({
    tool: 'scope_trail',
    findings: [sampleFinding('low')],
    rating: 'critical',
  });
  // Overriding upward is allowed; validateReport's consistency check only
  // catches ratings BELOW the implied max.
  assert.equal(r.rating, 'critical');
});

test('createReport: optional fields only present when supplied', () => {
  const r = createReport({ tool: 'scope_trail', findings: [] });
  assert.equal(r.toolVersion, undefined);
  assert.equal(r.runId, undefined);
  assert.equal(r.baseRef, undefined);
  assert.equal(r.headRef, undefined);
  assert.equal(r.data, undefined);

  const full = createReport({
    tool: 'capability_echo',
    toolVersion: '0.1.0',
    runId: 'run-abc',
    baseRef: 'abc123',
    headRef: 'def456',
    findings: [],
    data: { surfaceSummary: { source: 1 } },
  });
  assert.equal(full.toolVersion, '0.1.0');
  assert.equal(full.runId, 'run-abc');
  assert.equal(full.baseRef, 'abc123');
  assert.equal(full.headRef, 'def456');
  assert.deepEqual(full.data, { surfaceSummary: { source: 1 } });
});

test('maxSeverity ordering', () => {
  assert.equal(maxSeverity([]), 'none');
  assert.equal(maxSeverity([sampleFinding('low')]), 'low');
  assert.equal(maxSeverity([sampleFinding('low'), sampleFinding('critical')]), 'critical');
  assert.equal(maxSeverity([sampleFinding('medium'), sampleFinding('high')]), 'high');
});

test('validateReport accepts a well-formed report', () => {
  const r = createReport({
    tool: 'scope_trail',
    toolVersion: '0.1.18',
    findings: [sampleFinding('high')],
  });
  const result = validateReport(r);
  assert.equal(result.ok, true);
  assert.deepEqual(result.errors, []);
});

test('validateReport rejects missing schemaVersion', () => {
  const result = validateReport({
    tool: 'scope_trail',
    rating: 'none',
    findings: [],
  });
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => /schemaVersion/.test(e)));
});

test('validateReport rejects unknown tool', () => {
  const result = validateReport({
    schemaVersion: '1.0',
    tool: 'not_a_tool',
    rating: 'none',
    findings: [],
  });
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => /tool must be one of/.test(e)));
});

test('validateReport flags rating BELOW implied max severity', () => {
  // A report claiming 'low' rating but with a 'critical' finding is internally
  // inconsistent — the validator catches this.
  const result = validateReport({
    schemaVersion: '1.0',
    tool: 'capability_echo',
    rating: 'low',
    findings: [
      {
        tool: 'capability_echo',
        kind: 'capability_echo.workflow_permission_write',
        severity: 'critical',
        message: 'x',
      },
    ],
  });
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => /below the maximum finding severity/.test(e)));
});

test('validateReport allows rating ABOVE implied max (downgrade is fine)', () => {
  // A tool may rate higher than its findings imply (e.g., a single low
  // finding under a strict policy could rate high). The validator doesn't
  // enforce equality, only catches the unsafe direction (rating < implied).
  const result = validateReport({
    schemaVersion: '1.0',
    tool: 'task_bound',
    rating: 'critical',
    findings: [],
  });
  assert.equal(result.ok, true);
});

test('validateReport reports finding-level errors with index', () => {
  const result = validateReport({
    schemaVersion: '1.0',
    tool: 'policy_mesh',
    rating: 'none',
    findings: [
      { tool: 'policy_mesh', kind: 'policy_mesh.mcp_command_mismatch', severity: 'medium', message: 'ok' },
      { tool: 'policy_mesh', kind: 'BAD_KIND', severity: 'medium', message: 'bad' },
    ],
  });
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => /findings\[1\]:/.test(e)));
});

test('validateReport rejects tool mismatch between envelope and findings', () => {
  const result = validateReport({
    schemaVersion: '1.0',
    tool: 'scope_trail',
    rating: 'medium',
    findings: [
      {
        tool: 'capability_echo',
        kind: 'capability_echo.suspicious_import',
        severity: 'medium',
        message: 'x',
      },
    ],
  });
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => /does not match report\.tool/.test(e)));
});

test('createReport: conversationId passes through when supplied', () => {
  const r = createReport({
    tool: 'session_trail',
    conversationId: 'thread-abc-123',
    findings: [],
  });
  assert.equal(r.conversationId, 'thread-abc-123');
});

test('validateReport accepts conversationId as a string', () => {
  const result = validateReport({
    schemaVersion: '1.0',
    tool: 'session_trail',
    rating: 'none',
    findings: [],
    conversationId: 'pr-1234',
  });
  assert.equal(result.ok, true);
});

test('validateReport rejects non-string conversationId', () => {
  const result = validateReport({
    schemaVersion: '1.0',
    tool: 'session_trail',
    rating: 'none',
    findings: [],
    conversationId: 42,
  });
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => /conversationId must be a string/.test(e)));
});

test('validateReport rejects unknown top-level properties', () => {
  const result = validateReport({
    schemaVersion: '1.0',
    tool: 'scope_trail',
    rating: 'none',
    findings: [],
    surfaceSummary: { source: 1 }, // should be inside `data`, not top-level
  });
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => /unknown property: surfaceSummary/.test(e)));
});
