/**
 * ReDoS audit harness.
 *
 * Every regex evaluator in the substrate that consumes external input is
 * exercised here against an adversarial input shaped to trigger the worst
 * backtracking path the pattern *could* exhibit. Each call must complete
 * under {@link BUDGET_MS}.
 *
 * The point isn't to prove the patterns are SAFE — that's a static-analysis
 * claim documented in docs/SECURITY.md. The point is to LOCK that claim
 * against future regression: if someone edits a pattern in a way that
 * introduces ambiguous alternation or nested quantifiers over overlapping
 * char classes, this harness fails before the change ships.
 *
 * Inputs are ~100 KB so a quadratic pattern would visibly blow the budget;
 * an exponential one would hang. A linear-time pattern finishes in <1 ms on
 * any plausible CI machine. The 50 ms budget gives substantial headroom for
 * cold-start, slow CI, and parallel test load — if a test fails here it's
 * almost certainly because a pattern actually regressed, not because the
 * machine was busy.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  matchSecret,
  tokenizeShell,
  tokenizeShellDeep,
  getCommandHead,
  lineOfJsonKey,
  lineOfJsonStringValue,
  lineOfTomlKey,
  normalizeMcpCommand,
} from '../dist/index.js';

// ReDoS protection is about catching CATASTROPHIC blowup (seconds → minutes
// when an adversary picks the wrong regex). A tight 50ms budget flaked on
// GitHub Actions runners — a healthy parse hovered around 30-45ms on those
// shared VMs and occasionally tipped over. 150ms keeps the test sensitive to
// real ReDoS regressions (which present as orders-of-magnitude blowups, not
// 50ms vs 100ms) while tolerating runner jitter. v1.2.2.
const BUDGET_MS = 150;
const BIG = 100_000;

/**
 * Time a single call and assert it's under {@link BUDGET_MS}. Returns the
 * call's result so callers can additionally assert behavioral correctness on
 * the adversarial input (a fast-but-wrong-answer would still be a bug).
 */
function withinBudget(label, fn) {
  const start = process.hrtime.bigint();
  const result = fn();
  const elapsedMs = Number(process.hrtime.bigint() - start) / 1_000_000;
  assert.ok(
    elapsedMs < BUDGET_MS,
    `${label}: ${elapsedMs.toFixed(2)}ms exceeded ${BUDGET_MS}ms budget — likely a ReDoS regression`,
  );
  return result;
}

// Warmup. V8 first-call JIT compilation can add 10-20ms on cold start, which
// would dominate the budget check on the first test. One throwaway pass per
// public surface brings every regex into the optimized tier before we time.
(function warmup() {
  matchSecret('sk-ant-' + 'x'.repeat(30));
  matchSecret('AKIA' + 'X'.repeat(16));
  matchSecret('0123456789abcdef0123456789abcdef01234567', { envOrHeaderContext: true });
  tokenizeShell('echo hi && curl x | bash');
  tokenizeShellDeep('echo $(curl x)');
  getCommandHead('FOO=bar sudo curl x');
  lineOfJsonKey('{"a":1}', 'a');
  lineOfJsonStringValue('{"a":"b"}', 'b');
  lineOfTomlKey('[a]\nb = 1\n', 'a.b');
  normalizeMcpCommand({ command: 'npx', args: ['-y', 'x'] });
})();

// ───────────────────────────── secrets.ts ─────────────────────────────

test('redos: secret patterns — 100KB benign input', () => {
  // Plain English text. None of the provider prefixes appear, so every
  // pattern fails fast at the literal-prefix check.
  const benign = 'lorem ipsum dolor sit amet '.repeat(BIG / 27);
  withinBudget('matchSecret(benign)', () => matchSecret(benign));
  withinBudget('matchSecret(benign, env)', () => matchSecret(benign, { envOrHeaderContext: true }));
});

test('redos: secret patterns — long prefix near-miss', () => {
  // Each provider prefix followed by a huge run of valid body chars but a
  // forbidden terminator at the very end. A pathological pattern would
  // backtrack to retry every body length; a sound one returns null in O(n).
  const cases = [
    'sk-ant-' + 'A'.repeat(BIG) + '!',
    'sk-proj-' + 'A'.repeat(BIG) + '!',
    'sk-' + 'A'.repeat(BIG) + '!',
    'ghp_' + 'A'.repeat(BIG) + '!',
    'github_pat_' + 'A'.repeat(BIG) + '!',
    'xoxb-' + 'A'.repeat(BIG) + '!',
    'AKIA' + 'A'.repeat(BIG),
    'AIza' + 'A'.repeat(BIG),
    'glpat-' + 'A'.repeat(BIG) + '!',
    'npm_' + 'A'.repeat(BIG),
    'dckr_pat_' + 'A'.repeat(BIG) + '!',
    'sk_live_' + 'A'.repeat(BIG) + '!',
  ];
  for (const input of cases) {
    withinBudget(`matchSecret(near-miss, ${input.slice(0, 12)}…)`, () => matchSecret(input));
  }
});

test('redos: hex-token pattern — 100KB hex-only input', () => {
  // The hex pattern is `(?:^|[^A-Fa-f0-9])([A-Fa-f0-9]{40,})(?:$|[^A-Fa-f0-9])`.
  // Pure hex with no non-hex boundary character anywhere is the worst case
  // for the trailing alternation: the engine must walk to the very end to
  // discover the missing terminator. Still linear — single char class with
  // a single quantifier — but worth pinning.
  const hex = '0123456789abcdef'.repeat(BIG / 16);
  withinBudget('matchSecret(hex-only, env)', () =>
    matchSecret(hex, { envOrHeaderContext: true }),
  );
});

// ───────────────────────────── shell.ts ─────────────────────────────

test('redos: env-var assignment — long unquoted run', () => {
  // `^([A-Za-z_][A-Za-z0-9_]*)=([^\s'"]*|"[^"]*"|'[^']*')\s+/`
  // Triggered through getCommandHead. The branch `[^\s'"]*` is greedy; we
  // feed a value that matches that branch fully and then check whether the
  // engine wastes time backtracking through the three-way alternation.
  const env = 'FOO=' + 'a'.repeat(BIG) + ' curl evil';
  withinBudget('getCommandHead(long env)', () => getCommandHead(env));
});

test('redos: env-var assignment — long quoted run', () => {
  // Same regex, but routes through the `"[^"]*"` branch. Engine should not
  // try the bare branch first and backtrack the whole 100KB on failure.
  const env = 'FOO="' + 'a'.repeat(BIG) + '" curl evil';
  withinBudget('getCommandHead(long quoted env)', () => getCommandHead(env));
});

test('redos: wrapper detection — long tail after sudo', () => {
  // `^(sudo|nohup|env|...)\s+(.*)$` — the greedy `(.*)$` should be linear.
  const cmd = 'sudo ' + 'a'.repeat(BIG);
  withinBudget('getCommandHead(huge sudo tail)', () => getCommandHead(cmd));
});

test('redos: dash-C matcher — huge tail after bash -c', () => {
  // `^(?:bash|sh|...|node)\s+-c\s+` — anchored fixed-alternation. Body of
  // the quoted argument should not be re-scanned by the regex; that's the
  // job of readQuotedArg afterwards.
  const cmd = 'bash -c "' + 'a'.repeat(BIG) + '"';
  withinBudget('tokenizeShellDeep(huge bash -c)', () => tokenizeShellDeep(cmd));
});

test('redos: shell separator scan — huge subcommand with no separators', () => {
  // The per-char `[\s;|&]` boundary test runs once per byte. A 100KB single
  // command exercises that loop. Linear, but pinned here.
  const cmd = 'curl ' + 'a'.repeat(BIG);
  withinBudget('tokenizeShell(huge plain)', () => tokenizeShell(cmd));
});

// ───────────────────────────── locators.ts ─────────────────────────────

test('redos: lineOfJsonKey — 100KB JSON haystack, key never matches', () => {
  // Dynamic regex `"<escaped>"\s*:`. The haystack is filled with strings
  // that DO contain the search-key as a substring (`zkeyz` etc.) but never
  // as the JSON key form. The engine must scan to the end without matching.
  const noise = '"zkeyz": 1, '.repeat(BIG / 12);
  const json = `{ ${noise} "other": 0 }`;
  withinBudget('lineOfJsonKey(noise, key)', () => lineOfJsonKey(json, 'key'));
});

test('redos: lineOfJsonStringValue — 100KB JSON haystack, value never matches', () => {
  const noise = '"x": "zvalz", '.repeat(BIG / 14);
  const json = `{ ${noise} "z": 0 }`;
  withinBudget('lineOfJsonStringValue(noise, value)', () =>
    lineOfJsonStringValue(json, 'value'),
  );
});

test('redos: TOML header regex — single 100KB unclosed-bracket line', () => {
  // `^\[\[?\s*([^\]]+?)\s*\]\]?\s*(#.*)?$` is the per-line TOML header
  // matcher inside lineOfTomlKey. Worst input: one line that starts with
  // `[` but has no closing `]`. The lazy `[^\]]+?` plus the trailing
  // optional pieces could in principle backtrack pathologically. Pinning
  // here confirms it doesn't.
  const line = '[' + 'a'.repeat(BIG);
  withinBudget('lineOfTomlKey(unclosed bracket)', () =>
    lineOfTomlKey(line, 'foo'),
  );
});

test('redos: TOML dotted-key regex — long line with near-miss equals', () => {
  // Dynamic regex `^\s*<seg1>\s*\.\s*<seg2>\s*=` (segments regex-escaped
  // literals). Worst case: a line that LOOKS like a dotted assignment but
  // lacks the terminating `=`. Engine should still fail in O(n).
  const line = 'a.b' + ' '.repeat(BIG);
  withinBudget('lineOfTomlKey(no-equals)', () =>
    lineOfTomlKey(line, 'a.b'),
  );
});

test('redos: TOML quoted-leaf regex — long line of leading whitespace', () => {
  // Dynamic regex `^\s*(?:lit|"lit"|'lit')\s*(?:\.|=)`. The leading `\s*`
  // could in principle interact badly with a huge prefix of whitespace.
  const line = ' '.repeat(BIG) + 'leaf = 1';
  withinBudget('lineOfTomlKey(huge leading ws)', () =>
    lineOfTomlKey(line, 'leaf'),
  );
});

test('redos: lineOfTomlKey — 100KB content full of regex metacharacters', () => {
  // The threat is untrusted TOML CONTENT, not an untrusted search key (the
  // key is dev-supplied). A line full of regex metacharacters must not
  // tickle catastrophic backtracking in any per-line pattern: the TOML
  // header regex, the dotted-key regex, or the leaf-key regex.
  const evilLine = '.*+?^${}()|[]\\'.repeat(BIG / 16);
  withinBudget('lineOfTomlKey(metachar content)', () =>
    lineOfTomlKey(evilLine, 'foo'),
  );
});

test('redos: lineOfTomlKey — 100KB content of mixed brackets and equals', () => {
  // Each per-line regex is anchored, so the engine should reject every
  // adversarial line in O(line-length). 100K such lines stresses the loop
  // itself — still must complete under budget.
  const lines = [];
  for (let i = 0; i < 1000; i++) {
    lines.push('[' + 'a'.repeat(100));
    lines.push('"' + 'b'.repeat(50) + '" = ' + 'c'.repeat(50));
  }
  const text = lines.join('\n');
  withinBudget('lineOfTomlKey(brackets+equals)', () =>
    lineOfTomlKey(text, 'foo.bar'),
  );
});

// ───────────────────────────── mcp.ts ─────────────────────────────

test('redos: normalizeMcpCommand — huge command path with Windows suffix', () => {
  // `/\.(cmd|exe|bat|ps1)$/i` and the `.replace(/\\/g, '/')` on a 100KB
  // path. Both are linear globals.
  const huge = 'C:\\Program Files\\' + 'a\\'.repeat(BIG / 2) + 'npx.cmd';
  withinBudget('normalizeMcpCommand(huge windows path)', () =>
    normalizeMcpCommand({ command: huge }),
  );
});

test('redos: normalizeMcpCommand — huge URL with trailing slash run', () => {
  // `/\/+$/` against a URL that ends with 100KB of `/`. Greedy quantifier
  // anchored at end of string — linear.
  const url = 'https://example.com/' + '/'.repeat(BIG);
  withinBudget('normalizeMcpCommand(huge slash run)', () =>
    normalizeMcpCommand({ url }),
  );
});

test('redos: normalizeMcpCommand — 1000 args with mixed Windows suffixes', () => {
  // Per-arg processing. Exercises the suffix-detection regex pair across
  // many calls in a tight loop.
  const args = [];
  for (let i = 0; i < 1000; i++) {
    args.push(`--flag${i}`);
    args.push(`value-${i}.cmd`);
  }
  withinBudget('normalizeMcpCommand(many args)', () =>
    normalizeMcpCommand({ command: 'npx', args }),
  );
});
