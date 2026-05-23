import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createFinding,
  createReport,
  mergeFindings,
  validateMergedReport,
} from '../dist/index.js';

const finding = (tool, name, severity, location, salientKey) =>
  createFinding({ tool, name, severity, message: 'x', location, salientKey });

test('mergeFindings: empty input is valid', () => {
  const out = mergeFindings([]);
  assert.equal(out.schemaVersion, '1.0');
  assert.equal(out.rating, 'none');
  assert.deepEqual(out.findings, []);
  assert.deepEqual(out.sources, []);
  assert.deepEqual(out.severityCounts, { low: 0, medium: 0, high: 0, critical: 0 });
});

test('mergeFindings: combines findings across tools', () => {
  const a = createReport({
    tool: 'scope_trail',
    toolVersion: '0.1.18',
    findings: [finding('scope_trail', 'permission_allow_widened', 'high', { file: '.claude/settings.json', line: 12 })],
  });
  const b = createReport({
    tool: 'capability_echo',
    toolVersion: '0.1.0',
    findings: [finding('capability_echo', 'workflow_permission_write', 'critical', { file: '.github/workflows/ci.yml', line: 5 })],
  });
  const out = mergeFindings([a, b]);
  assert.equal(out.findings.length, 2);
  assert.equal(out.rating, 'critical');
  assert.equal(out.sources.length, 2);
  assert.equal(out.severityCounts.high, 1);
  assert.equal(out.severityCounts.critical, 1);
});

test('mergeFindings: dedupes by fingerprint, keeps highest severity by default', () => {
  // Same site, two reports — same fingerprint. The high-severity copy wins.
  const a = createReport({
    tool: 'scope_trail',
    findings: [finding('scope_trail', 'permission_allow_widened', 'medium', { file: '.claude/settings.json', line: 12 })],
  });
  const b = createReport({
    tool: 'scope_trail',
    findings: [finding('scope_trail', 'permission_allow_widened', 'high', { file: '.claude/settings.json', line: 12 })],
  });
  const out = mergeFindings([a, b]);
  assert.equal(out.findings.length, 1);
  assert.equal(out.findings[0].severity, 'high');
  assert.equal(out.duplicateCollapsed, 1);
});

test('mergeFindings: salientKey keeps distinct findings on the same line separate', () => {
  const a = createReport({
    tool: 'capability_echo',
    findings: [
      finding('capability_echo', 'suspicious_import', 'high', { file: 'src/x.ts', line: 12 }, 'pkg-a'),
      finding('capability_echo', 'suspicious_import', 'high', { file: 'src/x.ts', line: 12 }, 'pkg-b'),
    ],
  });
  const out = mergeFindings([a]);
  assert.equal(out.findings.length, 2);
  assert.equal(out.duplicateCollapsed, 0);
});

test('mergeFindings: threshold drops findings below the requested level', () => {
  const r = createReport({
    tool: 'task_bound',
    findings: [
      finding('task_bound', 'out_of_scope_file', 'low', { file: 'a.ts', line: 1 }),
      finding('task_bound', 'out_of_scope_file', 'medium', { file: 'b.ts', line: 1 }),
      finding('task_bound', 'out_of_scope_file', 'critical', { file: 'c.ts', line: 1 }),
    ],
  });
  const out = mergeFindings([r], { threshold: 'medium' });
  assert.equal(out.findings.length, 2);
  assert.equal(out.droppedBelowThreshold, 1);
  assert.equal(out.rating, 'critical');
});

test('mergeFindings: malformed report goes to invalidReports, valid ones still merge', () => {
  const valid = createReport({
    tool: 'scope_trail',
    findings: [finding('scope_trail', 'permission_allow_widened', 'high', { file: '.claude/settings.json', line: 12 })],
  });
  const malformed = { schemaVersion: '1.0', tool: 'not_a_tool', rating: 'none', findings: [] };
  const out = mergeFindings([valid, malformed]);
  assert.equal(out.findings.length, 1);
  assert.equal(out.sources.length, 1);
  assert.equal(out.invalidReports.length, 1);
  assert.equal(out.invalidReports[0].index, 1);
  assert.ok(out.invalidReports[0].errors.some((e) => /tool must be one of/.test(e)));
});

test('mergeFindings: malformed finding goes to invalidFindings, valid ones still pass', () => {
  const r = {
    schemaVersion: '1.0',
    tool: 'policy_mesh',
    rating: 'high',
    findings: [
      // valid
      {
        tool: 'policy_mesh',
        kind: 'policy_mesh.mcp_command_mismatch',
        severity: 'high',
        message: 'real finding',
      },
      // invalid — bad kind shape
      {
        tool: 'policy_mesh',
        kind: 'INVALID',
        severity: 'medium',
        message: 'broken',
      },
    ],
  };
  const out = mergeFindings([r]);
  assert.equal(out.findings.length, 1);
  assert.equal(out.invalidFindings.length, 1);
  assert.equal(out.invalidFindings[0].reportIndex, 0);
  assert.equal(out.invalidFindings[0].findingIndex, 1);
  assert.equal(out.invalidFindings[0].tool, 'policy_mesh');
});

test('mergeFindings: findings sorted by severity, highest first', () => {
  const r = createReport({
    tool: 'capability_echo',
    findings: [
      finding('capability_echo', 'workflow_permission_write', 'low', { file: 'a', line: 1 }),
      finding('capability_echo', 'external_fetch_added', 'critical', { file: 'b', line: 1 }),
      finding('capability_echo', 'lifecycle_script_added', 'medium', { file: 'c', line: 1 }),
      finding('capability_echo', 'high_capability_dep_added', 'high', { file: 'd', line: 1 }),
    ],
  });
  const out = mergeFindings([r]);
  const severities = out.findings.map((f) => f.severity);
  assert.deepEqual(severities, ['critical', 'high', 'medium', 'low']);
});

test('mergeFindings: duplicatePolicy "first" keeps the first occurrence', () => {
  const a = createReport({
    tool: 'scope_trail',
    findings: [finding('scope_trail', 'permission_allow_widened', 'medium', { file: '.claude/settings.json', line: 12 })],
  });
  const b = createReport({
    tool: 'scope_trail',
    findings: [finding('scope_trail', 'permission_allow_widened', 'high', { file: '.claude/settings.json', line: 12 })],
  });
  const out = mergeFindings([a, b], { duplicatePolicy: 'first' });
  assert.equal(out.findings.length, 1);
  assert.equal(out.findings[0].severity, 'medium'); // first wins, not highest
});

test('mergeFindings: aggregate rating reflects the surviving findings, not source ratings', () => {
  // Source reports may rate themselves higher than their max finding (allowed
  // by validateReport). After threshold filtering, the merged rating must
  // reflect what actually survived.
  const r = createReport({
    tool: 'task_bound',
    rating: 'critical', // explicit override; source says critical
    findings: [
      finding('task_bound', 'out_of_scope_file', 'low', { file: 'a', line: 1 }),
    ],
  });
  const out = mergeFindings([r], { threshold: 'medium' });
  assert.equal(out.rating, 'none'); // the only finding was dropped
  assert.equal(out.findings.length, 0);
});

test('mergeFindings: conversationId propagated when all sources agree', () => {
  // Maps to OpenTelemetry gen_ai.conversation.id — five tool reports for the
  // same PR review share the conversation ID, so the merged report keeps it.
  const conversationId = 'pr-1234';
  const a = createReport({ tool: 'scope_trail', conversationId, findings: [] });
  const b = createReport({ tool: 'policy_mesh', conversationId, findings: [] });
  const c = createReport({ tool: 'capability_echo', conversationId, findings: [] });
  const out = mergeFindings([a, b, c]);
  assert.equal(out.conversationId, conversationId);
  // Source provenance also carries each individual conversationId
  for (const source of out.sources) {
    assert.equal(source.conversationId, conversationId);
  }
});

test('mergeFindings: conversationId omitted when sources disagree (cross-conversation guard)', () => {
  // If a meta-reviewer is fed reports from different conversations, the merged
  // conversationId is intentionally undefined so the misuse is detectable.
  const a = createReport({ tool: 'scope_trail', conversationId: 'pr-1', findings: [] });
  const b = createReport({ tool: 'policy_mesh', conversationId: 'pr-2', findings: [] });
  const out = mergeFindings([a, b]);
  assert.equal(out.conversationId, undefined);
});

test('mergeFindings: conversationId omitted when only some sources have it', () => {
  // Partial coverage — silently unifying would be wrong. Skip the field
  // unless every source agrees.
  const a = createReport({ tool: 'scope_trail', conversationId: 'pr-1', findings: [] });
  const b = createReport({ tool: 'policy_mesh', findings: [] }); // no conversationId
  const out = mergeFindings([a, b]);
  assert.equal(out.conversationId, undefined);
});

test('mergeFindings: rejects finding whose tool does not match the envelope (P0 regression)', () => {
  // Cody-caught: validateReport rejected this mismatch but mergeFindings was
  // more permissive — it accepted the report and merged the foreign-tool
  // finding under the wrong provenance. Now the mismatch lands in
  // invalidFindings while the rest of the report still passes through.
  const mismatched = {
    schemaVersion: '1.0',
    tool: 'scope_trail',
    rating: 'high',
    findings: [
      {
        tool: 'policy_mesh',  // ← foreign tool
        kind: 'policy_mesh.mcp_command_mismatch',
        severity: 'high',
        message: 'forged finding inside a scope_trail report',
        fingerprint: 'fakefp1234567890',
      },
      // A valid scope_trail finding in the same report
      {
        tool: 'scope_trail',
        kind: 'scope_trail.permission_allow_widened',
        severity: 'medium',
        message: 'legitimate finding',
        fingerprint: 'realfp1234567890',
      },
    ],
  };
  const out = mergeFindings([mismatched]);
  assert.equal(out.findings.length, 1, 'only the matching-tool finding survives');
  assert.equal(out.findings[0].tool, 'scope_trail');
  assert.equal(out.invalidFindings.length, 1);
  assert.match(out.invalidFindings[0].errors[0], /does not match report\.tool/);
});

test('mergeFindings: sources carries provenance for each input report', () => {
  const a = createReport({ tool: 'scope_trail', toolVersion: '0.1.18', findings: [] });
  const b = createReport({ tool: 'policy_mesh', toolVersion: '0.1.0', findings: [] });
  const out = mergeFindings([a, b]);
  assert.equal(out.sources.length, 2);
  assert.equal(out.sources[0].tool, 'scope_trail');
  assert.equal(out.sources[0].toolVersion, '0.1.18');
  assert.equal(out.sources[1].tool, 'policy_mesh');
  assert.equal(out.sources[1].toolVersion, '0.1.0');
});

test('mergeFindings: workflowName round-trips when passed via opts', () => {
  // Cross-walks OpenTelemetry gen_ai.workflow.name — opt-in only, never inferred.
  const a = createReport({ tool: 'scope_trail', findings: [] });
  const out = mergeFindings([a], { workflowName: 'pr-1234-review' });
  assert.equal(out.workflowName, 'pr-1234-review');
});

test('mergeFindings: workflowName is omitted when not supplied', () => {
  // Never inferred from sources — the meta-reviewer caller owns it.
  const a = createReport({ tool: 'scope_trail', findings: [] });
  const out = mergeFindings([a]);
  assert.equal(out.workflowName, undefined);
  assert.equal('workflowName' in out, false);
});

test('validateMergedReport: accepts a freshly produced MergedReport', () => {
  const a = createReport({
    tool: 'scope_trail',
    findings: [createFinding({
      tool: 'scope_trail',
      name: 'permission_allow_widened',
      severity: 'high',
      message: 'x',
      location: { file: '.claude/settings.json', line: 12 },
    })],
  });
  const out = mergeFindings([a], { workflowName: 'pr-1' });
  const check = validateMergedReport(out);
  assert.equal(check.ok, true, check.errors.join('; '));
});

test('validateMergedReport: rejects non-objects, wrong schemaVersion, bad rating', () => {
  assert.equal(validateMergedReport(null).ok, false);
  assert.equal(validateMergedReport([]).ok, false);
  assert.equal(validateMergedReport('nope').ok, false);

  const base = mergeFindings([]);
  const bad1 = { ...base, schemaVersion: '0.9' };
  const r1 = validateMergedReport(bad1);
  assert.equal(r1.ok, false);
  assert.ok(r1.errors.some((e) => /schemaVersion/.test(e)));

  const bad2 = { ...base, rating: 'severe' };
  const r2 = validateMergedReport(bad2);
  assert.equal(r2.ok, false);
  assert.ok(r2.errors.some((e) => /rating/.test(e)));
});

test('validateMergedReport: rejects missing counters and unknown properties', () => {
  const base = mergeFindings([]);
  const noCounter = { ...base };
  delete noCounter.droppedBelowThreshold;
  const r1 = validateMergedReport(noCounter);
  assert.equal(r1.ok, false);
  assert.ok(r1.errors.some((e) => /droppedBelowThreshold/.test(e)));

  const extra = { ...base, somethingExtra: 1 };
  const r2 = validateMergedReport(extra);
  assert.equal(r2.ok, false);
  assert.ok(r2.errors.some((e) => /unknown property/.test(e)));
});

test('validateMergedReport: rejects non-string workflowName', () => {
  const base = mergeFindings([]);
  const bad = { ...base, workflowName: 42 };
  const r = validateMergedReport(bad);
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => /workflowName/.test(e)));
});
