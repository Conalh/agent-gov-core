/**
 * Structured config-file parse error. Carries the 1-based line and column of
 * the failure so consumers can emit a `*.config_syntax_error` Finding pointing
 * at the exact spot without recomputing line numbers from the raw offset.
 *
 * Thrown nowhere directly — instead, {@link readJsonObjectWithSource} and
 * {@link readTomlObject} populate the `parseError` field of their result with
 * this type whenever they can resolve a byte offset from the underlying parser.
 * When the underlying error lacks position info, the original `Error` is
 * preserved unchanged.
 *
 * @example
 * import { readTomlObject, ConfigParseError } from 'agent-gov-core';
 * const { parseError } = readTomlObject('.codex/config.toml');
 * if (parseError instanceof ConfigParseError) {
 *   emitFinding({
 *     kind: 'policy_mesh.config_syntax_error',
 *     location: { file: '.codex/config.toml', line: parseError.line, column: parseError.column },
 *     message: parseError.message,
 *   });
 * }
 */
export class ConfigParseError extends Error {
  readonly line: number;
  readonly column: number;
  readonly rawOffset: number;

  constructor(message: string, opts: { line: number; column: number; rawOffset: number; cause?: Error }) {
    super(message);
    this.name = 'ConfigParseError';
    this.line = opts.line;
    this.column = opts.column;
    this.rawOffset = opts.rawOffset;
    if (opts.cause) {
      // Node 16.9+ supports the `cause` option on Error; some runtimes don't.
      (this as { cause?: Error }).cause = opts.cause;
    }
  }
}

/** Convert a 0-based byte offset to 1-based line and column. */
export function lineColumnOfOffset(text: string, offset: number): { line: number; column: number } {
  const safe = Math.max(0, Math.min(offset, text.length));
  let line = 1;
  let column = 1;
  for (let i = 0; i < safe; i++) {
    if (text[i] === '\n') {
      line++;
      column = 1;
    } else {
      column++;
    }
  }
  return { line, column };
}

/**
 * Extract a byte offset from a parser error message. Both this library's TOML
 * parser ("at offset N") and Node's `JSON.parse` ("at position N", or a
 * `position` property on newer runtimes) use compatible-enough formats that
 * one helper handles both.
 *
 * Returns `null` when no offset can be recovered — most semantic errors
 * (duplicate-key, table redefinition) don't include one.
 */
export function extractParseOffset(err: Error): number | null {
  const m = /at (?:offset|position)\s+(\d+)/i.exec(err.message);
  if (m) return Number.parseInt(m[1]!, 10);
  // Newer Node (≥21) attaches `position` to SyntaxError from JSON.parse.
  const maybePos = (err as { position?: unknown }).position;
  if (typeof maybePos === 'number') return maybePos;
  return null;
}

/**
 * Wrap an arbitrary parser error into a {@link ConfigParseError} when offset
 * recovery is possible; otherwise return the original error unchanged.
 */
export function toConfigParseError(text: string, err: Error): Error {
  const offset = extractParseOffset(err);
  if (offset === null) return err;
  const { line, column } = lineColumnOfOffset(text, offset);
  return new ConfigParseError(err.message, { line, column, rawOffset: offset, cause: err });
}
