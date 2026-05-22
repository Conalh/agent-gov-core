import { test } from 'node:test';
import assert from 'node:assert/strict';
import { matchSecret, SECRET_PATTERNS } from '../dist/index.js';

// Test fixtures are assembled at runtime from harmless fragments so this
// source file never contains a contiguous string that secret scanners (or
// GitHub Push Protection) would flag as a live credential. The runtime
// strings still match the patterns under test — that's the whole point.
const ALPHA20 = 'abcdefghijklmnopqrstuv';
const ALPHA36 = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJ';
const HEX40 = '0123456789abcdef0123456789abcdef01234567';
const fake = (prefix, body) => prefix + body;

test('matchSecret: detects Anthropic-shaped tokens', () => {
  const r = matchSecret(fake('sk-' + 'ant-', ALPHA20));
  assert.equal(r?.provider, 'Anthropic');
});

test('matchSecret: detects OpenAI sk- and sk-proj- shapes', () => {
  assert.equal(matchSecret(fake('sk-' + 'proj-', ALPHA36))?.provider, 'OpenAI');
  assert.equal(matchSecret(fake('sk-', ALPHA36))?.provider, 'OpenAI');
});

test('matchSecret: detects GitHub PAT shapes', () => {
  assert.equal(matchSecret(fake('gh' + 'p_', ALPHA36))?.provider, 'GitHub');
  assert.equal(matchSecret(fake('git' + 'hub_pat_', ALPHA20))?.provider, 'GitHub');
});

test('matchSecret: detects Slack, AWS, Google, GitLab, npm, Docker, Stripe', () => {
  assert.equal(matchSecret(fake('xo' + 'xb-', ALPHA20))?.provider, 'Slack');
  assert.equal(matchSecret(fake('AK' + 'IA', 'IOSFODNN7EXAMPLE'))?.provider, 'AWS');
  assert.equal(matchSecret(fake('AI' + 'za', 'SyDdI0hCZtE6vySjMm-WEfRq3CPzqKqqsHI'))?.provider, 'Google');
  assert.equal(matchSecret(fake('gl' + 'pat-', ALPHA20))?.provider, 'GitLab');
  assert.equal(matchSecret(fake('np' + 'm_', ALPHA36))?.provider, 'npm');
  assert.equal(matchSecret(fake('dc' + 'kr_pat_', ALPHA20))?.provider, 'Docker');
  assert.equal(matchSecret(fake('sk' + '_live_', ALPHA20))?.provider, 'Stripe');
  assert.equal(matchSecret(fake('rk' + '_test_', ALPHA20))?.provider, 'Stripe');
});

test('matchSecret: env:VAR references are NEVER flagged', () => {
  assert.equal(matchSecret('env:OPENAI_API_KEY'), undefined);
  // env: prefix wins even when the remainder would otherwise match a provider pattern.
  assert.equal(matchSecret('env:' + fake('sk-' + 'ant-', ALPHA20)), undefined);
});

test('matchSecret: empty input returns undefined', () => {
  assert.equal(matchSecret(''), undefined);
});

test('matchSecret: benign short strings are not flagged', () => {
  assert.equal(matchSecret('hello world'), undefined);
  assert.equal(matchSecret('abc123'), undefined);
});

test('matchSecret: hex token only fires in env/header context (not bare)', () => {
  assert.equal(matchSecret(HEX40), undefined, 'bare hex blob not flagged without envOrHeaderContext');
  assert.equal(
    matchSecret(HEX40, { envOrHeaderContext: true })?.provider,
    'Hex token',
  );
});

test('matchSecret: non-hex 40-char string is not a hex token', () => {
  const nonHex = 'g'.repeat(40); // 'g' is not a hex char
  assert.equal(matchSecret(nonHex, { envOrHeaderContext: true }), undefined);
});

test('matchSecret: never returns the literal credential', () => {
  // Critical contract — the secret material must not leak into the result.
  // The credential is built at runtime so it doesn't appear as a literal here.
  const credential = fake('sk-' + 'ant-', 'thisisasecretthatmustnotleak');
  const result = matchSecret(credential);
  assert.ok(result);
  for (const value of Object.values(result)) {
    const hasLeak = typeof value === 'string' && value.includes(credential);
    assert.equal(hasLeak, false, `Found literal credential in result value: ${JSON.stringify(value)}`);
  }
});

test('SECRET_PATTERNS: golden — provider set is frozen', () => {
  // Adding providers is non-breaking. Removing or renaming requires a major
  // bump and consumer relock since consumers may key on these labels in
  // finding messages.
  const providers = new Set(SECRET_PATTERNS.map((p) => p.provider));
  assert.deepEqual(
    [...providers].sort(),
    ['AWS', 'Anthropic', 'Docker', 'GitHub', 'GitLab', 'Google', 'Hex token', 'OpenAI', 'Slack', 'Stripe', 'npm'],
  );
});
