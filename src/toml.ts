import { readFileSync } from 'node:fs';

export interface TomlObjectWithSource {
  /** Parsed TOML value, or `undefined` if parsing failed. */
  value: Record<string, unknown> | undefined;
  /**
   * @deprecated since v0.4.0 — prefer {@link TomlObjectWithSource.value}.
   * Kept as a populated alias for backwards compatibility; will be removed
   * in a future major version.
   */
  toml: Record<string, unknown> | undefined;
  /** Raw file text (untouched). */
  text: string;
  /** Set when parsing failed. */
  parseError?: Error;
}

export function readTomlObject(path: string): TomlObjectWithSource {
  const text = readFileSync(path, 'utf8');
  try {
    const parsed = parseToml(text);
    return { value: parsed, toml: parsed, text };
  } catch (err) {
    return { value: undefined, toml: undefined, text, parseError: err as Error };
  }
}

/**
 * Parse TOML text. Supports the subset relevant to agent-governance configs:
 * standard tables, arrays of tables, inline tables, multi-line basic/literal strings,
 * basic/literal strings, integers, floats, booleans, arrays, dotted keys, quoted keys,
 * and `#` comments.
 *
 * Datetime values are returned as strings rather than Date objects — consumers
 * compare on raw text and don't need timezone semantics.
 */
export function parseToml(input: string): Record<string, unknown> {
  const p = new TomlParser(input);
  return p.parse();
}

interface TableMarker {
  __isTable: true;
  __explicitlyDefined: boolean;
}

const TABLE_MARKER: TableMarker = { __isTable: true, __explicitlyDefined: false };

class TomlParser {
  private src: string;
  private pos = 0;
  private len: number;
  private root: Record<string, unknown> = {};
  private current: Record<string, unknown> = this.root;
  /** Tables explicitly created (so we can detect duplicate definition). */
  private definedTables = new Set<string>();
  /** Path of an array-of-tables table currently being filled. */
  private aotPaths = new Set<string>();
  /**
   * Internal delimiter for joining dotted-key path components into a single
   * hashable string. NUL is illegal in TOML keys (basic strings can't contain
   * U+0000, bare keys are ASCII-only), so using it as a delimiter is collision-
   * proof. Named for code-review clarity over an inline `'\0'`.
   */
  private readonly PATH_KEY_SEPARATOR = '\u0000';

  constructor(src: string) {
    this.src = src;
    this.len = src.length;
  }

  parse(): Record<string, unknown> {
    while (this.pos < this.len) {
      this.skipWhitespaceAndNewlines();
      if (this.pos >= this.len) break;
      const ch = this.src[this.pos]!;
      if (ch === '#') {
        this.skipComment();
        continue;
      }
      if (ch === '[') {
        if (this.src[this.pos + 1] === '[') {
          this.parseArrayOfTablesHeader();
        } else {
          this.parseTableHeader();
        }
        continue;
      }
      this.parseKeyValue(this.current);
    }
    return this.root;
  }

  private skipWhitespaceAndNewlines() {
    while (this.pos < this.len) {
      const c = this.src[this.pos]!;
      if (c === ' ' || c === '\t' || c === '\n' || c === '\r') {
        this.pos++;
      } else if (c === '#') {
        this.skipComment();
      } else {
        break;
      }
    }
  }

  private skipInlineWhitespace() {
    while (this.pos < this.len) {
      const c = this.src[this.pos]!;
      if (c === ' ' || c === '\t') this.pos++;
      else break;
    }
  }

  private skipComment() {
    while (this.pos < this.len && this.src[this.pos] !== '\n') this.pos++;
  }

  private expectLineEnd() {
    this.skipInlineWhitespace();
    if (this.pos >= this.len) return;
    const c = this.src[this.pos]!;
    if (c === '#') {
      this.skipComment();
      return;
    }
    if (c === '\n' || c === '\r') return;
    throw new Error(`Unexpected character ${JSON.stringify(c)} at offset ${this.pos}; expected end of line`);
  }

  private parseTableHeader() {
    this.pos++; // consume [
    this.skipInlineWhitespace();
    const keys = this.parseKeyChain();
    this.skipInlineWhitespace();
    if (this.src[this.pos] !== ']') {
      throw new Error(`Expected ']' at offset ${this.pos}`);
    }
    this.pos++;
    this.expectLineEnd();

    const path = keys.join(this.PATH_KEY_SEPARATOR);
    // A standard table header `[foo]` after an array-of-tables `[[foo]]` is a
    // TOML spec violation. Without this guard, `[foo]` silently descended
    // into the last `[[foo]]` entry and let writes leak into it.
    if (this.aotPaths.has(path)) {
      throw new Error(`Cannot redefine array-of-tables [[${keys.join('.')}]] as a standard table [${keys.join('.')}]`);
    }
    const table = this.descendTablePath(keys, /*forHeader*/ true);
    if (this.definedTables.has(path)) {
      throw new Error(`Duplicate table definition: [${keys.join('.')}]`);
    }
    this.definedTables.add(path);
    this.current = table;
  }

  private parseArrayOfTablesHeader() {
    this.pos += 2; // consume [[
    this.skipInlineWhitespace();
    const keys = this.parseKeyChain();
    this.skipInlineWhitespace();
    if (this.src[this.pos] !== ']' || this.src[this.pos + 1] !== ']') {
      throw new Error(`Expected ']]' at offset ${this.pos}`);
    }
    this.pos += 2;
    this.expectLineEnd();

    // Descend to parent
    const parent = this.descendTablePath(keys.slice(0, -1), /*forHeader*/ true);
    const last = keys[keys.length - 1]!;
    let arr = parent[last];
    if (arr === undefined) {
      arr = [];
      parent[last] = arr;
      this.aotPaths.add(keys.join(this.PATH_KEY_SEPARATOR));
    } else if (!Array.isArray(arr)) {
      throw new Error(`Key ${keys.join('.')} is not an array-of-tables`);
    }
    // Each new array entry resets the "already defined" status of any subtables
    // declared under this AOT path. TOML spec permits the same subtable header
    // (`[fruits.physical]`) to reappear under each fresh `[[fruits]]` entry — it
    // binds to the current array entry. Without this clearing, the v0.4.2
    // definedTables guard rejected the second [fruits.physical] as a duplicate.
    const aotPathPrefix = keys.join(this.PATH_KEY_SEPARATOR) + this.PATH_KEY_SEPARATOR;
    for (const definedPath of this.definedTables) {
      if (definedPath.startsWith(aotPathPrefix)) {
        this.definedTables.delete(definedPath);
      }
    }
    const newTable: Record<string, unknown> = {};
    (arr as unknown[]).push(newTable);
    this.current = newTable;
  }

  /** Walk/create the table path; returns the final table. */
  private descendTablePath(keys: string[], _forHeader: boolean): Record<string, unknown> {
    let node: Record<string, unknown> = this.root;
    for (let i = 0; i < keys.length; i++) {
      const k = keys[i]!;
      const existing = node[k];
      if (existing === undefined) {
        const next: Record<string, unknown> = {};
        node[k] = next;
        node = next;
      } else if (Array.isArray(existing)) {
        // descend into the last array-of-tables element
        const last = existing[existing.length - 1];
        if (!isPlainObject(last)) {
          throw new Error(`Cannot descend into non-table at ${keys.slice(0, i + 1).join('.')}`);
        }
        node = last as Record<string, unknown>;
      } else if (isPlainObject(existing)) {
        node = existing as Record<string, unknown>;
      } else {
        throw new Error(`Cannot redefine ${keys.slice(0, i + 1).join('.')} as a table`);
      }
    }
    return node;
  }

  private parseKeyChain(): string[] {
    const keys: string[] = [];
    keys.push(this.parseKeyPart());
    while (true) {
      this.skipInlineWhitespace();
      if (this.src[this.pos] !== '.') break;
      this.pos++;
      this.skipInlineWhitespace();
      keys.push(this.parseKeyPart());
    }
    return keys;
  }

  private parseKeyPart(): string {
    const c = this.src[this.pos]!;
    if (c === '"') {
      return this.parseBasicString();
    }
    if (c === "'") {
      return this.parseLiteralString();
    }
    // bare key: A-Za-z0-9_-
    const start = this.pos;
    while (this.pos < this.len) {
      const ch = this.src[this.pos]!;
      if (/[A-Za-z0-9_-]/.test(ch)) this.pos++;
      else break;
    }
    if (this.pos === start) {
      throw new Error(`Expected key at offset ${this.pos}`);
    }
    return this.src.slice(start, this.pos);
  }

  private parseKeyValue(target: Record<string, unknown>) {
    const keys = this.parseKeyChain();
    this.skipInlineWhitespace();
    if (this.src[this.pos] !== '=') {
      throw new Error(`Expected '=' at offset ${this.pos}`);
    }
    this.pos++;
    this.skipInlineWhitespace();
    const value = this.parseValue();

    // descend dotted keys (all but last)
    let node = target;
    for (let i = 0; i < keys.length - 1; i++) {
      const k = keys[i]!;
      const existing = node[k];
      if (existing === undefined) {
        const next: Record<string, unknown> = {};
        node[k] = next;
        node = next;
      } else if (isPlainObject(existing)) {
        node = existing as Record<string, unknown>;
      } else {
        throw new Error(`Cannot set dotted key through non-table at ${keys.slice(0, i + 1).join('.')}`);
      }
    }
    const lastKey = keys[keys.length - 1]!;
    if (Object.prototype.hasOwnProperty.call(node, lastKey)) {
      throw new Error(`Duplicate key: ${keys.join('.')}`);
    }
    node[lastKey] = value;
    this.expectLineEnd();
  }

  private parseValue(): unknown {
    const c = this.src[this.pos]!;
    if (c === '"') {
      if (this.src[this.pos + 1] === '"' && this.src[this.pos + 2] === '"') {
        return this.parseMultilineBasicString();
      }
      return this.parseBasicString();
    }
    if (c === "'") {
      if (this.src[this.pos + 1] === "'" && this.src[this.pos + 2] === "'") {
        return this.parseMultilineLiteralString();
      }
      return this.parseLiteralString();
    }
    if (c === '[') return this.parseArray();
    if (c === '{') return this.parseInlineTable();
    if (c === 't' || c === 'f') return this.parseBoolean();
    return this.parseNumberOrDateTime();
  }

  private parseBasicString(): string {
    if (this.src[this.pos] !== '"') throw new Error(`Expected '"' at ${this.pos}`);
    this.pos++;
    let out = '';
    while (this.pos < this.len) {
      const c = this.src[this.pos]!;
      if (c === '"') {
        this.pos++;
        return out;
      }
      if (c === '\\') {
        this.pos++;
        out += this.readEscape(false);
        continue;
      }
      if (c === '\n') throw new Error(`Unterminated basic string at offset ${this.pos}`);
      out += c;
      this.pos++;
    }
    throw new Error(`Unterminated basic string`);
  }

  private parseMultilineBasicString(): string {
    this.pos += 3;
    // skip immediately-following newline (TOML rule)
    if (this.src[this.pos] === '\r') this.pos++;
    if (this.src[this.pos] === '\n') this.pos++;
    let out = '';
    while (this.pos < this.len) {
      // Check for closing """ (handle case of """" or """"")
      if (
        this.src[this.pos] === '"' &&
        this.src[this.pos + 1] === '"' &&
        this.src[this.pos + 2] === '"'
      ) {
        // Allow up to 2 additional quotes inside the close
        let extra = 0;
        while (extra < 2 && this.src[this.pos + 3 + extra] === '"') extra++;
        out += '"'.repeat(extra);
        this.pos += 3 + extra;
        return out;
      }
      const c = this.src[this.pos]!;
      if (c === '\\') {
        this.pos++;
        // line-ending backslash: consume to next non-ws line start
        const next = this.src[this.pos];
        if (next === '\n' || next === '\r' || next === undefined) {
          while (
            this.pos < this.len &&
            (this.src[this.pos] === ' ' ||
              this.src[this.pos] === '\t' ||
              this.src[this.pos] === '\n' ||
              this.src[this.pos] === '\r')
          ) {
            this.pos++;
          }
          continue;
        }
        out += this.readEscape(true);
        continue;
      }
      out += c;
      this.pos++;
    }
    throw new Error(`Unterminated multi-line basic string`);
  }

  private parseLiteralString(): string {
    if (this.src[this.pos] !== "'") throw new Error(`Expected "'" at ${this.pos}`);
    this.pos++;
    const start = this.pos;
    while (this.pos < this.len) {
      const c = this.src[this.pos]!;
      if (c === "'") {
        const out = this.src.slice(start, this.pos);
        this.pos++;
        return out;
      }
      if (c === '\n') throw new Error(`Unterminated literal string at offset ${this.pos}`);
      this.pos++;
    }
    throw new Error(`Unterminated literal string`);
  }

  private parseMultilineLiteralString(): string {
    this.pos += 3;
    if (this.src[this.pos] === '\r') this.pos++;
    if (this.src[this.pos] === '\n') this.pos++;
    const start = this.pos;
    while (this.pos < this.len) {
      if (
        this.src[this.pos] === "'" &&
        this.src[this.pos + 1] === "'" &&
        this.src[this.pos + 2] === "'"
      ) {
        let extra = 0;
        while (extra < 2 && this.src[this.pos + 3 + extra] === "'") extra++;
        const out = this.src.slice(start, this.pos) + "'".repeat(extra);
        this.pos += 3 + extra;
        return out;
      }
      this.pos++;
    }
    throw new Error(`Unterminated multi-line literal string`);
  }

  private readEscape(_multiline: boolean): string {
    const c = this.src[this.pos];
    if (c === undefined) throw new Error(`Dangling escape`);
    this.pos++;
    switch (c) {
      case 'b': return '\b';
      case 't': return '\t';
      case 'n': return '\n';
      case 'f': return '\f';
      case 'r': return '\r';
      case '"': return '"';
      case '\\': return '\\';
      case '/': return '/';
      case 'u': return this.readUnicodeEscape(4);
      case 'U': return this.readUnicodeEscape(8);
      default:
        throw new Error(`Invalid escape \\${c} at offset ${this.pos - 1}`);
    }
  }

  private readUnicodeEscape(nibbles: number): string {
    const hex = this.src.slice(this.pos, this.pos + nibbles);
    if (hex.length !== nibbles || !/^[0-9A-Fa-f]+$/.test(hex)) {
      throw new Error(`Invalid unicode escape at offset ${this.pos}`);
    }
    this.pos += nibbles;
    const code = parseInt(hex, 16);
    return String.fromCodePoint(code);
  }

  private parseArray(): unknown[] {
    this.pos++; // [
    const out: unknown[] = [];
    this.skipWhitespaceAndNewlines();
    if (this.src[this.pos] === ']') {
      this.pos++;
      return out;
    }
    while (true) {
      this.skipWhitespaceAndNewlines();
      out.push(this.parseValue());
      this.skipWhitespaceAndNewlines();
      const c = this.src[this.pos];
      if (c === ',') {
        this.pos++;
        this.skipWhitespaceAndNewlines();
        if (this.src[this.pos] === ']') {
          this.pos++;
          return out;
        }
        continue;
      }
      if (c === ']') {
        this.pos++;
        return out;
      }
      throw new Error(`Expected ',' or ']' in array at offset ${this.pos}`);
    }
  }

  private parseInlineTable(): Record<string, unknown> {
    this.pos++; // {
    this.skipInlineWhitespace();
    const obj: Record<string, unknown> = {};
    if (this.src[this.pos] === '}') {
      this.pos++;
      return obj;
    }
    while (true) {
      this.skipInlineWhitespace();
      // parse a single dotted-key = value
      const keys = this.parseKeyChain();
      this.skipInlineWhitespace();
      if (this.src[this.pos] !== '=') {
        throw new Error(`Expected '=' in inline table at offset ${this.pos}`);
      }
      this.pos++;
      this.skipInlineWhitespace();
      const value = this.parseValue();

      let node = obj;
      for (let i = 0; i < keys.length - 1; i++) {
        const k = keys[i]!;
        const existing = node[k];
        if (existing === undefined) {
          const next: Record<string, unknown> = {};
          node[k] = next;
          node = next;
        } else if (isPlainObject(existing)) {
          node = existing as Record<string, unknown>;
        } else {
          throw new Error(`Dotted key through non-table in inline table`);
        }
      }
      const leaf = keys[keys.length - 1]!;
      // Inline tables must reject duplicate keys just like standard tables.
      // Without this guard, `{ host = "a", host = "b" }` silently parsed as
      // `{ host: "b" }` instead of raising.
      if (Object.prototype.hasOwnProperty.call(node, leaf)) {
        throw new Error(`Duplicate key in inline table: ${keys.join('.')}`);
      }
      node[leaf] = value;

      this.skipInlineWhitespace();
      const c = this.src[this.pos];
      if (c === ',') {
        this.pos++;
        continue;
      }
      if (c === '}') {
        this.pos++;
        return obj;
      }
      throw new Error(`Expected ',' or '}' in inline table at offset ${this.pos}`);
    }
  }

  private parseBoolean(): boolean {
    if (this.src.startsWith('true', this.pos)) {
      this.pos += 4;
      return true;
    }
    if (this.src.startsWith('false', this.pos)) {
      this.pos += 5;
      return false;
    }
    throw new Error(`Expected boolean at offset ${this.pos}`);
  }

  private parseNumberOrDateTime(): unknown {
    const start = this.pos;
    while (this.pos < this.len) {
      const c = this.src[this.pos]!;
      // allow letters/digits/sign/colon/dot/dash for numbers + dates
      if (/[0-9A-Za-z_+\-:.]/.test(c)) this.pos++;
      else break;
    }
    const raw = this.src.slice(start, this.pos);
    if (raw === '') throw new Error(`Expected value at offset ${start}`);
    // datetime heuristic: contains ':' or 'T' or has shape YYYY-MM-DD
    if (/^\d{4}-\d{2}-\d{2}/.test(raw) || /\d{2}:\d{2}/.test(raw)) {
      return raw;
    }
    // hex / oct / bin
    if (/^0x[0-9A-Fa-f_]+$/.test(raw)) return parseInt(raw.slice(2).replace(/_/g, ''), 16);
    if (/^0o[0-7_]+$/.test(raw)) return parseInt(raw.slice(2).replace(/_/g, ''), 8);
    if (/^0b[01_]+$/.test(raw)) return parseInt(raw.slice(2).replace(/_/g, ''), 2);
    // integer
    if (/^[+-]?\d[\d_]*$/.test(raw)) return parseInt(raw.replace(/_/g, ''), 10);
    // float
    if (/^[+-]?(\d[\d_]*(\.\d[\d_]*)?([eE][+-]?\d[\d_]*)?|nan|inf)$/.test(raw)) {
      if (raw === 'nan' || raw === '+nan' || raw === '-nan') return NaN;
      if (raw === 'inf' || raw === '+inf') return Infinity;
      if (raw === '-inf') return -Infinity;
      return parseFloat(raw.replace(/_/g, ''));
    }
    throw new Error(`Could not parse value ${JSON.stringify(raw)} at offset ${start}`);
  }
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

// keep TABLE_MARKER referenced so it isn't pruned by isolatedModules
export const _internal = { TABLE_MARKER };
