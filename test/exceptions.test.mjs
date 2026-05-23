import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyExceptions, createFinding, validateException } from '../dist/index.js';

const sampleFinding = (overrides = {}) => createFinding({
  tool: 'capability_echo',
  name: 'high_capability_dep_added',
  severity: 'high',
  message: 'puppeteer added — headless browser capability',
  location: { file: 'package.json', line: 17 },
  salientKey: 'puppeteer',
  ...overrides,
});

test('applyExceptions: empty exceptions list is identity', () => {
  const findings = [sampleFinding()];
  const result = applyExceptions(findings, []);
  assert.deepEqual(result.findings, findings);
  assert.equal(result.suppressed, 0);
  assert.equal(result.expired, 0);
});

test('applyExceptions: active exception by kind suppresses matching finding', () => {
  const findings = [sampleFinding()];
  const result = applyExceptions(findings, [
    { kind: 'capability_echo.high_capability_dep_added' },
  ]);
  assert.equal(result.findings.length, 0);
  assert.equal(result.suppressed, 1);
});

test('applyExceptions: salientKey narrows match (PolicyMesh `subject` pattern)', () => {
  const a = sampleFinding({ salientKey: 'puppeteer' });
  const b = sampleFinding({ salientKey: 'playwright' });
  const result = applyExceptions([a, b], [
    { kind: 'capability_echo.high_capability_dep_added', salientKey: 'puppeteer' },
  ]);
  assert.equal(result.findings.length, 1);
  assert.equal(result.findings[0].salientKey, 'playwright');
  assert.equal(result.suppressed, 1);
});

test('applyExceptions: pathPrefix narrows match (TaskBound `allow_paths` pattern)', () => {
  const internal = sampleFinding({ location: { file: 'tools/internal/setup.ts', line: 1 } });
  const main = sampleFinding({ location: { file: 'src/app.ts', line: 1 } });
  const result = applyExceptions([internal, main], [
    { kind: 'capability_echo.high_capability_dep_added', pathPrefix: 'tools/internal/' },
  ]);
  assert.equal(result.findings.length, 1);
  assert.equal(result.findings[0].location.file, 'src/app.ts');
  assert.equal(result.suppressed, 1);
});

test('applyExceptions: missing expires treated as perpetually active', () => {
  const findings = [sampleFinding()];
  const result = applyExceptions(findings, [
    { kind: 'capability_echo.high_capability_dep_added', reason: 'tracking via issue #42' },
  ]);
  assert.equal(result.findings.length, 0);
  assert.equal(result.suppressed, 1);
  assert.equal(result.expired, 0);
});

test('applyExceptions: expired exception surfaces finding with downgrade + prefix', () => {
  const past = new Date('2025-01-01');
  const now = new Date('2026-01-01');
  const findings = [sampleFinding()];
  const result = applyExceptions(findings, [
    {
      kind: 'capability_echo.high_capability_dep_added',
      expires: past.toISOString().slice(0, 10),
      reason: 'browser-tests rollout',
    },
  ], now);

  assert.equal(result.findings.length, 1);
  assert.equal(result.expired, 1);
  assert.equal(result.suppressed, 0);
  const surfaced = result.findings[0];
  assert.equal(surfaced.severity, 'low', 'expired exception downgrades to low');
  assert.match(surfaced.message, /^\[EXPIRED WHITELIST\] /);
  assert.equal(surfaced.data?.exceptionReason, 'browser-tests rollout');
});

test('applyExceptions: non-matching kind passes through unchanged', () => {
  const finding = sampleFinding();
  const result = applyExceptions([finding], [
    { kind: 'scope_trail.permission_allow_widened' }, // different kind entirely
  ]);
  assert.equal(result.findings.length, 1);
  assert.equal(result.findings[0], finding);
  assert.equal(result.suppressed, 0);
});

test('applyExceptions: non-matching salientKey passes through', () => {
  const finding = sampleFinding({ salientKey: 'puppeteer' });
  const result = applyExceptions([finding], [
    { kind: 'capability_echo.high_capability_dep_added', salientKey: 'playwright' },
  ]);
  assert.equal(result.findings.length, 1);
  assert.equal(result.suppressed, 0);
});

test('applyExceptions: pathPrefix without location.file is a non-match', () => {
  const finding = createFinding({
    tool: 'capability_echo',
    name: 'high_capability_dep_added',
    severity: 'high',
    message: 'no location',
    // no location at all
  });
  const result = applyExceptions([finding], [
    { kind: 'capability_echo.high_capability_dep_added', pathPrefix: 'src/' },
  ]);
  assert.equal(result.findings.length, 1, 'pathPrefix-required exception cannot match a no-location finding');
  assert.equal(result.suppressed, 0);
});

test('applyExceptions: malformed expires date is treated as never-expires', () => {
  // Defensive: if a consumer writes "soon" or "next-quarter", we don't blow up,
  // we treat the exception as perpetually active.
  const findings = [sampleFinding()];
  const result = applyExceptions(findings, [
    { kind: 'capability_echo.high_capability_dep_added', expires: 'not-a-date' },
  ]);
  assert.equal(result.findings.length, 0);
  assert.equal(result.suppressed, 1);
});

test('applyExceptions: active rule wins over expired rule regardless of order (P0 regression)', () => {
  // Gemini-caught contract bug: previously the FIRST matching rule won. If a
  // stale specific rule was listed before a broader active rule, the finding
  // surfaced as expired instead of being suppressed by the active rule.
  const finding = createFinding({
    tool: 'task_bound',
    name: 'out_of_scope_file',
    severity: 'medium',
    message: 'x',
    location: { file: 'src/config/db.ts', line: 1 },
  });
  const now = new Date('2026-05-22');
  // Order A: expired specific first, active broader second
  const a = applyExceptions([finding], [
    { kind: 'task_bound.out_of_scope_file', pathPrefix: 'src/config/', expires: '2026-01-01' },
    { kind: 'task_bound.out_of_scope_file', pathPrefix: 'src/' },
  ], now);
  // Order B: reversed
  const b = applyExceptions([finding], [
    { kind: 'task_bound.out_of_scope_file', pathPrefix: 'src/' },
    { kind: 'task_bound.out_of_scope_file', pathPrefix: 'src/config/', expires: '2026-01-01' },
  ], now);
  assert.equal(a.suppressed, 1, 'active rule must suppress regardless of position');
  assert.equal(a.expired, 0);
  assert.deepEqual(
    { suppressed: a.suppressed, expired: a.expired },
    { suppressed: b.suppressed, expired: b.expired },
    'applyExceptions must be order-independent',
  );
});

test('applyExceptions: all-expired matching set surfaces with downgrade', () => {
  // Sanity: when no active rule exists and ALL matches are expired, the
  // finding does surface — using the first expired rule's reason text.
  const finding = createFinding({
    tool: 'task_bound', name: 'out_of_scope_file', severity: 'medium',
    message: 'x', location: { file: 'src/x.ts', line: 1 },
  });
  const now = new Date('2026-05-22');
  const r = applyExceptions([finding], [
    { kind: 'task_bound.out_of_scope_file', pathPrefix: 'src/', expires: '2025-01-01', reason: 'expired-A' },
    { kind: 'task_bound.out_of_scope_file', pathPrefix: 'src/', expires: '2025-06-01', reason: 'expired-B' },
  ], now);
  assert.equal(r.expired, 1);
  assert.equal(r.findings.length, 1);
  assert.equal(r.findings[0].data?.exceptionReason, 'expired-A', 'first expired match supplies the reason');
});

test('applyExceptions: pathPrefix normalizes Windows backslashes (P1 regression)', () => {
  // Cody-caught: a finding with `src\app.ts` (Windows) wasn't matching a
  // pathPrefix of `src/` (forward slash). Both sides normalize to `/`.
  const winFinding = createFinding({
    tool: 'task_bound', name: 'out_of_scope_file', severity: 'medium',
    message: 'x', location: { file: 'src\\app.ts', line: 1 },
  });
  const r = applyExceptions([winFinding], [
    { kind: 'task_bound.out_of_scope_file', pathPrefix: 'src/' },
  ]);
  assert.equal(r.suppressed, 1, 'Windows-style path must match POSIX-style prefix');
});

test('applyExceptions: pathPrefix requires segment boundary (P1 regression)', () => {
  // Cody-caught: `pathPrefix: 'src/app'` was suppressing `src/application.ts`
  // because of raw string-startsWith matching. Prefix matches must land on
  // a `/` boundary or be the exact full path.
  const finding = createFinding({
    tool: 'task_bound', name: 'out_of_scope_file', severity: 'medium',
    message: 'x', location: { file: 'src/application.ts', line: 1 },
  });
  const r = applyExceptions([finding], [
    { kind: 'task_bound.out_of_scope_file', pathPrefix: 'src/app' },
  ]);
  assert.equal(r.suppressed, 0, 'pathPrefix src/app must NOT match src/application.ts');
  assert.equal(r.findings.length, 1);

  // Sanity: same prefix should still match src/app/foo.ts (segment boundary)
  const innerFinding = createFinding({
    tool: 'task_bound', name: 'out_of_scope_file', severity: 'medium',
    message: 'x', location: { file: 'src/app/foo.ts', line: 1 },
  });
  const r2 = applyExceptions([innerFinding], [
    { kind: 'task_bound.out_of_scope_file', pathPrefix: 'src/app' },
  ]);
  assert.equal(r2.suppressed, 1, 'pathPrefix src/app must match src/app/foo.ts');
});

test('applyExceptions: future expires keeps the exception active', () => {
  const future = new Date('2099-01-01').toISOString().slice(0, 10);
  const result = applyExceptions([sampleFinding()], [
    { kind: 'capability_echo.high_capability_dep_added', expires: future },
  ]);
  assert.equal(result.suppressed, 1);
  assert.equal(result.expired, 0);
});

test('validateException: accepts a well-formed exception', () => {
  const r = validateException({
    kind: 'capability_echo.high_capability_dep_added',
    salientKey: 'puppeteer',
    pathPrefix: 'tools/internal/',
    expires: '2026-12-31',
    reason: 'in progress',
  });
  assert.equal(r.ok, true);
});

test('validateException: rejects missing kind', () => {
  const r = validateException({ salientKey: 'x' });
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => /kind/.test(e)));
});

test('validateException: rejects unparseable expires date', () => {
  const r = validateException({ kind: 'x.y', expires: 'someday' });
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => /expires must be a parseable date/.test(e)));
});

test('validateException: rejects unknown top-level properties', () => {
  const r = validateException({ kind: 'x.y', surface: 'workflow' });
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => /unknown property: surface/.test(e)));
});
