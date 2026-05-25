/**
 * Tests for src/parsers/ — transcript JSONL → TranscriptEvent[] (v1.1.0).
 *
 * Ported from AgentPulse v0.4.x's `test/parser.test.mjs`. Fixtures live
 * alongside this file as `fixtures-parsers-<runtime>.jsonl` (flat layout,
 * matching the rest of the agent-gov-core test suite).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, cpSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseTranscriptDir } from '../dist/index.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE_CLAUDE = join(__dirname, 'fixtures-parsers-claude-code.jsonl');
const FIXTURE_CODEX = join(__dirname, 'fixtures-parsers-codex.jsonl');
const FIXTURE_CURSOR = join(__dirname, 'fixtures-parsers-cursor.jsonl');

function tmpDir() {
  return mkdtempSync(join(tmpdir(), 'agent-gov-core-parsers-'));
}

test('parses Claude Code JSONL with user/tool_use/tool_result roundtrip', async () => {
  const dir = tmpDir();
  cpSync(FIXTURE_CLAUDE, join(dir, 'session.jsonl'));
  try {
    const events = await parseTranscriptDir(dir);

    // 7 lines in the fixture, 1 is invalid JSON → 6 lines parsed.
    // Line breakdown:
    //   1: user_message
    //   2: assistant_message + tool_use(Read)
    //   3: tool_result
    //   4: tool_use(Bash) — no leading text → only tool_use
    //   5: tool_result
    //   6: assistant_message
    // Total events: 7 (assistant line 2 emits both message + tool_use).
    assert.equal(events.length, 7);
    assert.ok(events.every((e) => e.runtime === 'claude-code'));

    const kinds = events.map((e) => e.kind);
    assert.deepEqual(kinds, [
      'user_message',
      'assistant_message',
      'tool_use',
      'tool_result',
      'tool_use',
      'tool_result',
      'assistant_message',
    ]);

    // Tool use IDs link to tool result IDs
    const readToolUse = events[2];
    const readResult = events[3];
    assert.equal(readToolUse.toolName, 'Read');
    assert.equal(readToolUse.toolUseId, 'tu_read_1');
    assert.equal(readResult.toolUseId, 'tu_read_1');
    assert.match(readResult.toolResultText, /login/);

    const bashUse = events[4];
    const bashResult = events[5];
    assert.equal(bashUse.toolName, 'Bash');
    assert.equal(bashUse.toolInput.command, 'npm test');
    assert.equal(bashResult.toolResultExitCode, 0);

    // Chronologically sorted
    for (let i = 1; i < events.length; i += 1) {
      assert.ok(events[i].timestamp >= events[i - 1].timestamp);
    }

    // cwd flows through
    assert.equal(events[0].cwd, '/repo');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('parses Cursor JSONL and tolerates missing timestamps', async () => {
  const dir = tmpDir();
  cpSync(FIXTURE_CURSOR, join(dir, 'cursor.jsonl'));
  try {
    const events = await parseTranscriptDir(dir);
    assert.ok(events.length >= 3);
    assert.ok(events.every((e) => e.runtime === 'cursor'));

    // No timestamps in cursor fixture — all events should have timestamp 0
    // (interpolation has nothing to borrow from).
    assert.ok(events.every((e) => e.timestamp === 0));

    const toolUses = events.filter((e) => e.kind === 'tool_use');
    assert.equal(toolUses.length, 2);
    assert.deepEqual(
      toolUses.map((e) => e.toolName),
      ['Glob', 'Edit']
    );
    assert.equal(toolUses[1].toolInput.path, 'src/utils/date.ts');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('parses Codex JSONL with response_item shape', async () => {
  const dir = tmpDir();
  cpSync(FIXTURE_CODEX, join(dir, 'codex.jsonl'));
  try {
    const events = await parseTranscriptDir(dir);
    assert.ok(events.every((e) => e.runtime === 'codex'));

    // session_meta emits a system event; 4 response_items produce 4 more.
    assert.equal(events.length, 5);
    assert.deepEqual(
      events.map((e) => e.kind),
      ['system', 'tool_use', 'tool_result', 'tool_use', 'assistant_message']
    );

    // function_call_output exit_code is extracted
    const shellResult = events[2];
    assert.equal(shellResult.toolResultExitCode, 0);
    assert.match(shellResult.toolResultText, /package\.json/);

    // apply_patch arguments aren't valid JSON — should land under .patch
    const patchUse = events[3];
    assert.equal(patchUse.toolName, 'apply_patch');
    assert.ok(typeof patchUse.toolInput.patch === 'string');
    assert.match(patchUse.toolInput.patch, /Begin Patch/);

    // shell arguments ARE JSON
    const shellUse = events[1];
    assert.equal(shellUse.toolName, 'shell');
    assert.equal(shellUse.toolInput.command, 'ls /repo');

    // Codex timestamps are real, monotonic.
    for (let i = 1; i < events.length; i += 1) {
      assert.ok(events[i].timestamp >= events[i - 1].timestamp);
    }
    assert.ok(events[0].timestamp > 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('honors since/until window and drops zero-timestamp events when windowed', async () => {
  const dir = tmpDir();
  cpSync(FIXTURE_CODEX, join(dir, 'codex.jsonl'));
  cpSync(FIXTURE_CURSOR, join(dir, 'cursor.jsonl')); // no timestamps
  try {
    const since = Date.parse('2026-05-23T11:00:02.000Z');
    const until = Date.parse('2026-05-23T11:00:03.500Z');
    const events = await parseTranscriptDir(dir, { since, until });

    // Only codex events with ts in [since, until] survive; cursor (ts=0)
    // is dropped because a window was supplied.
    assert.ok(events.length > 0);
    assert.ok(events.every((e) => e.timestamp >= since && e.timestamp <= until));
    assert.ok(events.every((e) => e.runtime === 'codex'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('skips malformed lines without throwing', async () => {
  const dir = tmpDir();
  writeFileSync(
    join(dir, 'bad.jsonl'),
    'not json\n{"type":"user","message":{"content":[{"type":"text","text":"hi"}]}}\nalso not json\n'
  );
  try {
    const events = await parseTranscriptDir(dir, { silent: true });
    assert.equal(events.length, 1);
    assert.equal(events[0].kind, 'user_message');
    assert.equal(events[0].text, 'hi');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('streaming reader: handles CRLF line endings', async () => {
  // v1.2.1 — parseFile uses node:readline + createReadStream with
  // crlfDelay: Infinity so a Windows-emitted transcript with \r\n line
  // endings parses identically to one with \n.
  const dir = tmpDir();
  const lf = [
    '{"type":"user","message":{"content":[{"type":"text","text":"hello"}]}}',
    '{"type":"assistant","message":{"content":[{"type":"text","text":"hi back"}]}}',
  ].join('\n');
  const crlf = lf.replace(/\n/g, '\r\n') + '\r\n';
  writeFileSync(join(dir, 'crlf.jsonl'), crlf);
  try {
    const events = await parseTranscriptDir(dir);
    assert.equal(events.length, 2);
    assert.equal(events[0].text, 'hello');
    assert.equal(events[1].text, 'hi back');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('streaming reader: parses last line without trailing newline', async () => {
  // readline emits the final line whether or not it ends in \n. Pin it so
  // a partial-write transcript (active session writing a line right when
  // the parser opens the file) doesn't silently drop the last event.
  const dir = tmpDir();
  writeFileSync(
    join(dir, 'no-trailing.jsonl'),
    '{"type":"user","message":{"content":[{"type":"text","text":"only line"}]}}'
  );
  try {
    const events = await parseTranscriptDir(dir);
    assert.equal(events.length, 1);
    assert.equal(events[0].text, 'only line');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('streaming reader: parses a 5k-line transcript without buffering whole file', async () => {
  // Smoke test for the streaming swap — produce a file larger than any
  // realistic chunk size (≈1 MB) and confirm we parse every line. The
  // previous readFile+split path would have allocated the raw string plus
  // the split array; with streaming each line is processed and released
  // as we go. We can't directly assert RSS here, but full-count parity is
  // sufficient evidence the streaming loop walks the whole file.
  const dir = tmpDir();
  const lines = [];
  for (let i = 0; i < 5000; i += 1) {
    lines.push(
      JSON.stringify({
        type: 'user',
        timestamp: '2026-05-25T00:00:00.000Z',
        message: { content: [{ type: 'text', text: `msg ${i}` }] },
      })
    );
  }
  writeFileSync(join(dir, 'big.jsonl'), lines.join('\n') + '\n');
  try {
    const events = await parseTranscriptDir(dir, { silent: true });
    assert.equal(events.length, 5000);
    assert.equal(events[0].text, 'msg 0');
    assert.equal(events[4999].text, 'msg 4999');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('walks subdirectories and merges results chronologically', async () => {
  const dir = tmpDir();
  const sub = join(dir, 'nested');
  mkdirSync(sub, { recursive: true });
  cpSync(FIXTURE_CODEX, join(sub, 'codex.jsonl'));
  cpSync(FIXTURE_CLAUDE, join(dir, 'cc.jsonl'));
  try {
    const events = await parseTranscriptDir(dir);
    // Sorted by timestamp — claude events (May 23 10:00) come before codex
    // events (May 23 11:00).
    const runtimes = events.map((e) => e.runtime);
    const firstCodex = runtimes.indexOf('codex');
    const lastClaude = runtimes.lastIndexOf('claude-code');
    assert.ok(
      firstCodex > lastClaude,
      'claude-code events should precede codex events when sorted by timestamp'
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
