/**
 * Line locators operate on the *original* source text — JSONC strip-comments
 * is position-preserving so offsets line up.
 *
 * All returned line numbers are 1-based. `0` is reserved for "not found"; callers
 * generally treat that as "fall back to file-level annotation".
 */

export interface ByteRange {
  /** Inclusive start offset. */
  start: number;
  /** Exclusive end offset. */
  end: number;
}

/** 1-based line number for the first occurrence of `"key"` followed by `:`. */
export function lineOfJsonKey(text: string, key: string, scope?: ByteRange): number {
  const needle = `"${escapeForRegex(key)}"\\s*:`;
  return findLineByRegex(text, new RegExp(needle), scope);
}

/**
 * 1-based line number for the first JSON string value equal to `value`.
 * If `scope` is supplied (a byte range), only matches inside that range count —
 * this is the fix for the multi-server-ambiguity bug.
 */
export function lineOfJsonStringValue(text: string, value: string, scope?: ByteRange): number {
  const needle = `"${escapeForRegex(value)}"`;
  return findLineByRegex(text, new RegExp(needle), scope);
}

/**
 * 1-based line number for a TOML key. Supports dotted keys (`a.b.c`) — the
 * locator points to the line where the *leaf* key is defined, scanning forward
 * from the line of the matching `[a.b]` table header (or the start of the file
 * for top-level keys). Bare and quoted leaf keys are both handled.
 */
export function lineOfTomlKey(text: string, dottedKey: string): number {
  const parts = splitTomlDottedKey(dottedKey);
  if (parts.length === 0) return 0;
  const leaf = parts[parts.length - 1]!;
  const prefix = parts.slice(0, -1);

  const lines = text.split(/\r?\n/);

  // Find header range we're inside of.
  let inTargetTable = prefix.length === 0;
  let currentTable: string[] = [];
  const targetHeader = prefix.join('.');

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]!;
    const trimmed = raw.trim();
    const headerMatch = /^\[\[?\s*([^\]]+?)\s*\]\]?\s*(#.*)?$/.exec(trimmed);
    if (headerMatch) {
      currentTable = splitTomlDottedKey(headerMatch[1]!);
      inTargetTable = currentTable.join('.') === targetHeader;
      continue;
    }
    if (!inTargetTable) continue;
    if (trimmed === '' || trimmed.startsWith('#')) continue;

    // Match leaf key at start of line: bare, "quoted", or 'literal'
    const leafPattern = new RegExp(
      `^\\s*(?:${escapeForRegex(leaf)}|"${escapeForRegex(leaf)}"|'${escapeForRegex(leaf)}')\\s*(?:\\.|=)`
    );
    if (leafPattern.test(raw)) return i + 1;

    // Also: dotted key like `prefix.leaf = ...` defined at top-level
    if (prefix.length > 0 && currentTable.length === 0) {
      const dottedPattern = new RegExp(
        `^\\s*${escapeForRegex(dottedKey)}\\s*=`
      );
      if (dottedPattern.test(raw)) return i + 1;
    }
  }
  return 0;
}

function findLineByRegex(text: string, regex: RegExp, scope?: ByteRange): number {
  const haystack = scope ? text.slice(scope.start, scope.end) : text;
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
