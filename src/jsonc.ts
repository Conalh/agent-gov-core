import { readFileSync } from 'node:fs';

export interface JsonObjectWithSource {
  /** Parsed JSON value, or `undefined` if parsing failed. */
  json: unknown;
  /** Raw file text (untouched). */
  text: string;
  /** Set when parsing failed. */
  parseError?: Error;
}

/**
 * Strip `//` line comments, `/* ... *\/` block comments, and trailing commas from JSONC,
 * preserving byte offsets (replacement is space-filled, newlines preserved) so downstream
 * line locators still match the original `text`.
 */
export function stripJsonComments(input: string): string {
  const len = input.length;
  const out: string[] = new Array(len);
  let i = 0;
  let inString: '"' | "'" | null = null;
  let escape = false;

  while (i < len) {
    const ch = input[i]!;

    if (inString) {
      out[i] = ch;
      if (escape) {
        escape = false;
      } else if (ch === '\\') {
        escape = true;
      } else if (ch === inString) {
        inString = null;
      }
      i++;
      continue;
    }

    if (ch === '"') {
      inString = '"';
      out[i] = ch;
      i++;
      continue;
    }

    if (ch === '/' && i + 1 < len) {
      const next = input[i + 1]!;
      if (next === '/') {
        // line comment until newline (exclusive)
        let j = i;
        while (j < len && input[j] !== '\n' && input[j] !== '\r') {
          out[j] = ' ';
          j++;
        }
        i = j;
        continue;
      }
      if (next === '*') {
        let j = i;
        // replace until end of block comment (inclusive of */)
        const end = input.indexOf('*/', i + 2);
        const stop = end === -1 ? len : end + 2;
        while (j < stop) {
          const c = input[j]!;
          out[j] = c === '\n' || c === '\r' ? c : ' ';
          j++;
        }
        i = j;
        continue;
      }
    }

    out[i] = ch;
    i++;
  }

  let result = out.join('');

  // Strip trailing commas: `,` followed by optional whitespace then `}` or `]`.
  // Only outside strings — but at this point we've reconstructed the source character-by-character,
  // and the only commas we want to elide are structural ones. A safe pass: walk again with string-state.
  result = stripTrailingCommas(result);
  return result;
}

function stripTrailingCommas(input: string): string {
  const len = input.length;
  const out = input.split('');
  let inString: '"' | null = null;
  let escape = false;
  for (let i = 0; i < len; i++) {
    const ch = out[i]!;
    if (inString) {
      if (escape) escape = false;
      else if (ch === '\\') escape = true;
      else if (ch === inString) inString = null;
      continue;
    }
    if (ch === '"') {
      inString = '"';
      continue;
    }
    if (ch === ',') {
      let j = i + 1;
      while (j < len && /\s/.test(out[j]!)) j++;
      if (j < len && (out[j] === '}' || out[j] === ']')) {
        out[i] = ' ';
      }
    }
  }
  return out.join('');
}

/**
 * Read a JSONC file and return both the parsed value and the original text.
 * The original text is preserved exactly so line locators can operate on it.
 */
export function readJsonObjectWithSource(path: string): JsonObjectWithSource {
  const text = readFileSync(path, 'utf8');
  try {
    const stripped = stripJsonComments(text);
    const json = JSON.parse(stripped) as unknown;
    return { json, text };
  } catch (err) {
    return { json: undefined, text, parseError: err as Error };
  }
}
