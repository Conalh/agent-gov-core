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
