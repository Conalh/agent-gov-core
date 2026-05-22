/**
 * Line locators operate on the *original* source text — JSONC strip-comments
 * is position-preserving so offsets line up.
 *
 * All returned line numbers are 1-based. `0` is reserved for "not found"; callers
 * generally treat that as "fall back to file-level annotation".
 */

import { stripJsonComments } from './jsonc.js';

export interface ByteRange {
  /** Inclusive start offset. */
  start: number;
  /** Exclusive end offset. */
  end: number;
}

/**
 * 1-based line number for the first occurrence of `"key"` followed by `:`.
 *
 * The key is JSON-encoded before matching so keys containing backslashes or
 * quotes (rare but legal) are located in the source bytes. The scan ignores
 * lines inside JSONC `//` and `/* *\/` comments so a commented-out `"key":`
 * does not shadow the real one.
 */
export function lineOfJsonKey(text: string, key: string, scope?: ByteRange): number {
  const encoded = jsonEncodeForRegex(key);
  return findLineByRegex(text, new RegExp(`"${encoded}"\\s*:`), scope);
}

/**
 * 1-based line number for the first JSON string value equal to `value`.
 * If `scope` is supplied (a byte range), only matches inside that range count —
 * this is the fix for the multi-server-ambiguity bug.
 *
 * The value is JSON-encoded before matching so values containing backslashes
 * (e.g. Windows paths like `C:\Temp` written as `"C:\\Temp"` in JSON) are
 * located correctly. The scan ignores JSONC comments so a commented-out
 * matching value does not shadow the real one. The negative lookahead skips
 * occurrences in key position (`"command":`) so a value matching a key name
 * elsewhere in the document doesn't return the key's line.
 */
export function lineOfJsonStringValue(text: string, value: string, scope?: ByteRange): number {
  const encoded = jsonEncodeForRegex(value);
  return findLineByRegex(text, new RegExp(`"${encoded}"(?!\\s*:)`), scope);
}

/**
 * Convert a string to the form it would appear in JSON source bytes, then
 * regex-escape. `JSON.stringify('C:\\Temp')` yields `'"C:\\\\Temp"'` — slice
 * off the surrounding quotes to get the inner byte sequence.
 */
function jsonEncodeForRegex(input: string): string {
  const jsonBody = JSON.stringify(input).slice(1, -1);
  return escapeForRegex(jsonBody);
}

/**
 * 1-based line number for a TOML key. Supports dotted keys (`a.b.c`) — the
 * locator points to the line where the *leaf* key is defined, scanning forward
 * from the line of the matching `[a.b]` table header (or the start of the file
 * for top-level keys). Bare and quoted leaf keys are both handled.
 *
 * If `scope` is supplied, only lines whose byte offsets fall inside the range
 * are considered. Useful when an outer locator has already pinned the byte
 * range of a parent table or array entry and you want to find a leaf inside
 * it without false matches from a sibling table that has the same leaf key.
 */
export function lineOfTomlKey(text: string, dottedKey: string, scope?: ByteRange): number {
  const parts = splitTomlDottedKey(dottedKey);
  if (parts.length === 0) return 0;

  const lines = text.split(/\r?\n/);
  const inScope = scopeLineFilter(text, scope);

  let currentTable: string[] = [];
  // Track multi-line basic (`"""`) and literal (`'''`) string state. A leaf-key
  // pattern can otherwise match against decoy text inside a multi-line string
  // value — see lineOfTomlKey regression tests.
  let inMultilineString: '"""' | "'''" | null = null;

  for (let i = 0; i < lines.length; i++) {
    const lineNumber = i + 1;
    const raw = lines[i]!;
    const stateAtLineStart = inMultilineString;
    inMultilineString = updateMultilineStringState(raw, inMultilineString);

    // If we entered this line inside a multi-line string, never match. The key
    // pattern there is part of a string literal, not a real assignment.
    if (stateAtLineStart !== null) continue;

    const trimmed = raw.trim();
    const headerMatch = /^\[\[?\s*([^\]]+?)\s*\]\]?\s*(#.*)?$/.exec(trimmed);
    if (headerMatch) {
      currentTable = splitTomlDottedKey(headerMatch[1]!);
      continue;
    }
    if (trimmed === '' || trimmed.startsWith('#')) continue;
    if (!inScope(lineNumber)) continue;

    // Generalized dotted-key matching: if the current table is a strict
    // prefix of (or equal to) the target dotted key, try matching the
    // REMAINING dotted segments on this line. Covers all three cases:
    //  - Top-level (`a.b.c = 1` at root):     currentTable=[]      → match `a.b.c`
    //  - Inside a parent (`[a]\nb.c = 1`):    currentTable=['a']   → match `b.c`
    //  - Inside the exact table (`[a.b]\nc = 1`): currentTable=['a','b'] → match `c`
    const tableIsPrefix =
      currentTable.length <= parts.length &&
      currentTable.every((seg, idx) => seg === parts[idx]);
    if (!tableIsPrefix) continue;

    const remaining = parts.slice(currentTable.length);
    if (remaining.length === 0) continue;

    // Remaining-as-dotted-key match (covers any depth ≥ 1). Build the
    // regex from individual segments joined by `\s*\.\s*` so spaced dotted
    // keys (`a . b . c = 1` — valid TOML) match as well as compact ones.
    const segmentsPattern = remaining.map(escapeForRegex).join('\\s*\\.\\s*');
    const dottedPattern = new RegExp(`^\\s*${segmentsPattern}\\s*=`);
    if (dottedPattern.test(raw)) return lineNumber;

    // If remaining is exactly the leaf, also try the quoted-leaf forms
    if (remaining.length === 1) {
      const leafKey = remaining[0]!;
      const leafPattern = new RegExp(
        `^\\s*(?:${escapeForRegex(leafKey)}|"${escapeForRegex(leafKey)}"|'${escapeForRegex(leafKey)}')\\s*(?:\\.|=)`
      );
      if (leafPattern.test(raw)) return lineNumber;
    }
  }
  return 0;
}

/**
 * Walk a line and update multi-line string state.
 *
 * Inside a basic multi-line string (`"""…"""`), a backslash escapes the next
 * character — so `\"""` is a literal `"""` inside the value, NOT the string's
 * closing delimiter. The walker must skip the next character after each `\`
 * or it'll terminate the string state early and start matching key patterns
 * against text that's still inside the value.
 *
 * Literal multi-line strings (`'''…'''`) do not process escapes per TOML spec,
 * so backslash is inert there.
 */
function updateMultilineStringState(
  line: string,
  current: '"""' | "'''" | null,
): '"""' | "'''" | null {
  let state = current;
  let pos = 0;
  while (pos < line.length) {
    if (state === '"""') {
      // Inside a basic multi-line string — honor backslash escapes
      if (line[pos] === '\\') {
        pos += 2; // skip the backslash AND the next character
        continue;
      }
      if (pos <= line.length - 3 && line.substr(pos, 3) === '"""') {
        state = null;
        pos += 3;
        continue;
      }
      pos++;
      continue;
    }
    if (state === "'''") {
      // Literal multi-line — no escapes per spec
      if (pos <= line.length - 3 && line.substr(pos, 3) === "'''") {
        state = null;
        pos += 3;
        continue;
      }
      pos++;
      continue;
    }
    // state === null
    if (pos <= line.length - 3) {
      const window = line.substr(pos, 3);
      if (window === '"""') { state = '"""'; pos += 3; continue; }
      if (window === "'''") { state = "'''"; pos += 3; continue; }
    }
    pos++;
  }
  return state;
}

function scopeLineFilter(text: string, scope?: ByteRange): (line: number) => boolean {
  if (!scope) return () => true;
  const startLine = lineOfOffset(text, scope.start);
  const endLine = lineOfOffset(text, Math.max(scope.start, scope.end - 1));
  return (line: number) => line >= startLine && line <= endLine;
}

function findLineByRegex(text: string, regex: RegExp, scope?: ByteRange): number {
  // stripJsonComments is position-preserving: it replaces comment bytes with
  // spaces while leaving newlines intact. Offsets in the stripped text map
  // 1:1 to offsets in the original text, so line numbers stay correct, but
  // commented-out keys/values no longer match.
  const searchable = stripJsonComments(text);
  const haystack = scope ? searchable.slice(scope.start, scope.end) : searchable;
  const m = regex.exec(haystack);
  if (!m) return 0;
  const offset = (scope ? scope.start : 0) + m.index;
  return lineOfOffset(text, offset);
}

function lineOfOffset(text: string, offset: number): number {
  let line = 1;
  for (let i = 0; i < offset && i < text.length; i++) {
    if (text[i] === '\n') line++;
  }
  return line;
}

function escapeForRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Split a TOML dotted key, honoring "quoted" and 'literal' parts. */
function splitTomlDottedKey(input: string): string[] {
  const parts: string[] = [];
  let i = 0;
  const len = input.length;
  while (i < len) {
    while (i < len && (input[i] === ' ' || input[i] === '\t')) i++;
    if (i >= len) break;
    const c = input[i]!;
    if (c === '"') {
      i++;
      const start = i;
      while (i < len && input[i] !== '"') {
        if (input[i] === '\\') i++;
        i++;
      }
      parts.push(input.slice(start, i));
      i++;
    } else if (c === "'") {
      i++;
      const start = i;
      while (i < len && input[i] !== "'") i++;
      parts.push(input.slice(start, i));
      i++;
    } else {
      const start = i;
      while (i < len && input[i] !== '.' && input[i] !== ' ' && input[i] !== '\t') i++;
      parts.push(input.slice(start, i));
    }
    while (i < len && (input[i] === ' ' || input[i] === '\t')) i++;
    if (i < len && input[i] === '.') i++;
  }
  return parts;
}
