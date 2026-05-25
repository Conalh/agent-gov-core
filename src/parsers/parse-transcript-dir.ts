/**
 * Top-level transcript-directory parser.
 *
 * Reads `.jsonl` transcripts from Claude Code, Cursor, and Codex out of a
 * directory and emits a flat, chronologically sorted `TranscriptEvent[]`.
 *
 * Originally `parseTranscript` in AgentPulse v0.1 (`src/parser.ts`).
 * Promoted into agent-gov-core v1.1.0; renamed to `parseTranscriptDir`
 * for a clearer entry-point name. AgentPulse re-exports it as
 * `parseTranscript` for backwards compatibility with v0.4.x callers.
 *
 * Hard rules:
 *  - No network calls.
 *  - No LLM calls.
 *  - Node stdlib only.
 *  - TypeScript strict, ESM, Node 20+.
 */

import { createReadStream } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

import type { ParseOptions, TranscriptEvent } from '../transcript-events.js';
import {
  detectAnthropicRuntime,
  parseAnthropicLine,
} from './claude-code.js';
import {
  isCodexLine,
  isCodexSessionMeta,
  parseCodexLine,
} from './codex.js';
import {
  isAntigravityLine,
  parseAntigravityLine,
} from './antigravity.js';
import { interpolateTimestamps, isRecord } from './util.js';

/**
 * Parse all `.jsonl` transcripts under `transcriptDir` into normalized
 * events. Directories are walked recursively; non-jsonl files are ignored.
 * A single `.jsonl` file path is also accepted.
 *
 * Malformed lines are counted and reported via `console.warn` but do not
 * throw — partial transcripts are a fact of life with active sessions, and
 * we'd rather render a result from 95% of a file than refuse the whole
 * thing.
 *
 * Honors `opts.since` / `opts.until` as inclusive epoch-ms bounds. The
 * returned array is chronologically sorted by `timestamp`.
 */
export async function parseTranscriptDir(
  transcriptDir: string,
  opts: ParseOptions = {}
): Promise<TranscriptEvent[]> {
  const files = await listJsonlFiles(transcriptDir);

  const allEvents: TranscriptEvent[] = [];
  let totalSkipped = 0;
  let totalLines = 0;

  for (const file of files) {
    const { events, skipped, lines } = await parseFile(file);
    allEvents.push(...events);
    totalSkipped += skipped;
    totalLines += lines;
  }

  if (totalSkipped > 0 && !opts.silent) {
    // Single aggregate warning — we don't want to spam per-line. Counting
    // is the difference between an audit user noticing partial data and
    // silently trusting a half-parsed file.
    //
    // `opts.silent` is honored for TUI consumers, where `console.warn`
    // writes interfere with screen control and cause whole-window flicker
    // on every refresh tick.
    // eslint-disable-next-line no-console
    console.warn(
      `[transcript-parser] skipped ${totalSkipped} malformed line(s) out of ${totalLines} across ${files.length} file(s)`
    );
  }

  // Filter before sort — sorting is O(n log n) so trimming first when a
  // window is supplied keeps the constant factor low on long histories.
  const filtered = filterByWindow(allEvents, opts);

  filtered.sort((a, b) => a.timestamp - b.timestamp);
  return filtered;
}

interface FileParseResult {
  events: TranscriptEvent[];
  lines: number;
  skipped: number;
}

async function parseFile(path: string): Promise<FileParseResult> {
  const events: TranscriptEvent[] = [];
  let lines = 0;
  let skipped = 0;
  const activeToolCalls = new Map<string, string>();

  // Stream the file line-by-line via readline instead of buffering the whole
  // transcript in memory. Long-running sessions can accumulate hundreds of
  // MB of history; the previous `readFile + split` shape held a copy of the
  // raw text AND an array of every line simultaneously, producing GC spikes
  // proportional to file size. `crlfDelay: Infinity` collapses `\r\n` line
  // endings (Windows-emitted transcripts) so we don't emit empty interleaved
  // lines between them.
  const rl = createInterface({
    input: createReadStream(path, { encoding: 'utf8' }),
    crlfDelay: Infinity,
  });

  // Per-LINE codex detection (vs. per-session sticky flag) — a mixed-runtime
  // file (rare but real, e.g. Cursor transcripts copied into a Claude Code
  // projects dir) would otherwise have every Anthropic line mistagged as
  // codex because parseCodexLine's `default` branch always returns a system
  // event. Route to the codex parser only when the LINE itself looks like a
  // codex shape.
  for await (const line of rl) {
    if (!line.trim()) continue;
    lines += 1;

    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      skipped += 1;
      continue;
    }

    // Codex path: only when this specific line is a codex shape.
    if (isCodexSessionMeta(parsed) || isCodexLine(parsed)) {
      const out = parseCodexLine(parsed);
      if (out) {
        events.push(...out);
        continue;
      }
    }

    // Antigravity path: only when this specific line is an Antigravity shape.
    if (isAntigravityLine(parsed)) {
      const out = parseAntigravityLine(parsed, activeToolCalls);
      if (out && out.length > 0) {
        events.push(...out);
        continue;
      }
    }

    const anthropic = parseAnthropicLine(parsed);
    if (anthropic) {
      events.push(...anthropic);
      continue;
    }

    // Last-ditch: if it has any Anthropic-ish hints, force-parse as one.
    if (isRecord(parsed) && (parsed.message || parsed.role || parsed.type)) {
      const runtime = detectAnthropicRuntime(
        parsed as Parameters<typeof detectAnthropicRuntime>[0]
      );
      const forced = parseAnthropicLine(parsed, runtime);
      if (forced) {
        events.push(...forced);
        continue;
      }
    }
    // Unknown shape — count it as skipped so the user sees the gap.
    skipped += 1;
  }

  // Per-file interpolation keeps sessions independent: a missing timestamp
  // in file B shouldn't borrow from file A.
  interpolateTimestamps(events);

  return { events, lines, skipped };
}

function filterByWindow(events: TranscriptEvent[], opts: ParseOptions): TranscriptEvent[] {
  const since = opts.since;
  const until = opts.until;
  if (since === undefined && until === undefined) {
    return events;
  }
  return events.filter((e) => {
    // Drop events with timestamp 0 only when a window is specified —
    // they have no place in a time-bounded view.
    if (e.timestamp === 0) return false;
    if (since !== undefined && e.timestamp < since) return false;
    if (until !== undefined && e.timestamp > until) return false;
    return true;
  });
}

/**
 * Recursively collect `*.jsonl` files. Sorted lexicographically for
 * deterministic ordering across platforms (readdir order is FS-dependent).
 */
async function listJsonlFiles(directory: string): Promise<string[]> {
  let s;
  try {
    s = await stat(directory);
  } catch (err) {
    throw new Error(
      `transcript-parser: cannot read transcript path "${directory}": ${(err as Error).message}`
    );
  }
  if (s.isFile()) {
    return directory.endsWith('.jsonl') ? [directory] : [];
  }

  const result: string[] = [];
  async function walk(dir: string): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true });
    const sorted = [...entries].sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of sorted) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
      } else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
        result.push(full);
      }
    }
  }

  await walk(directory);
  return result;
}
