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
    // Treat a single `&` (background) as a separator too.
    if (c === '&') {
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
  // Strip leading env var assignments: `FOO=bar BAZ=qux curl ...`
  while (true) {
    const m = /^([A-Za-z_][A-Za-z0-9_]*)=([^\s'"]*|"[^"]*"|'[^']*')\s+/.exec(s);
    if (!m) break;
    s = s.slice(m[0].length);
  }
  // Strip leading sudo / env wrappers
  const wrapperMatch = /^(sudo|nohup|env|exec|command|builtin)\s+(.*)$/.exec(s);
  if (wrapperMatch) {
    return getCommandHead(wrapperMatch[2]!);
  }

  // Now extract first token, honoring quoting and obfuscation neutralization.
  const head = readFirstToken(s);
  return deobfuscate(head);
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
