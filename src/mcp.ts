export interface McpCommandSpec {
  command?: string;
  args?: readonly string[];
  /** Some configs use a URL (SSE/remote MCP). */
  url?: string;
  env?: Readonly<Record<string, string>>;
  cwd?: string;
}

/**
 * Returns a canonical identity string for an MCP server command.
 *
 * Goals:
 *  - Two specs that differ only in cosmetic ways (flag reordering, `.cmd`/`.exe`
 *    on Windows, equivalent env var ordering) hash the same.
 *  - Specs that differ in anything *load-bearing* (the executable, the URL, the
 *    cwd, any env value, any non-neutral arg) hash differently.
 *
 * Non-goals:
 *  - Understanding tool semantics. Two truly-different `--flag value` pairs hash
 *    differently even if the tool would treat them equivalently.
 *
 * @example
 * normalizeMcpCommand({ command: 'npx.cmd', args: ['-y', 'mcp-foo', '--token', 'abc'] });
 * normalizeMcpCommand({ command: 'npx',     args: ['mcp-foo', '--token', 'abc']      });
 * // → both produce the same canonical string
 *
 * @example
 * normalizeMcpCommand({ url: 'https://example.com/mcp/' });
 * // → 'url=https://example.com/mcp\nargs='
 */
export function normalizeMcpCommand(spec: McpCommandSpec): string {
  const parts: string[] = [];

  if (spec.url) {
    parts.push(`url=${spec.url.trim().replace(/\/$/, '')}`);
  }

  if (spec.command) {
    parts.push(`cmd=${normalizeExecutable(spec.command)}`);
  }

  const args = spec.args ?? [];
  parts.push(`args=${canonicalizeArgs(args).join(' ')}`);

  if (spec.cwd) {
    parts.push(`cwd=${normalizePath(spec.cwd)}`);
  }

  if (spec.env) {
    const env = Object.entries(spec.env)
      .map(([k, v]) => `${k}=${v}`)
      .sort();
    parts.push(`env=${env.join('|')}`);
  }

  return parts.join('\n');
}

/**
 * Strip `.cmd`/`.exe`/`.bat`/`.ps1` suffix on Windows-style paths and
 * lowercase those — Windows filesystem lookup is case-insensitive, so
 * `NPX.CMD`, `npx.cmd`, and `npx` all refer to the same executable and
 * should produce identical identity strings. POSIX paths (no backslash
 * separator, no Windows suffix) keep their case because `./curl` and
 * `./CURL` are genuinely different files there.
 */
function normalizeExecutable(cmd: string): string {
  const trimmed = cmd.trim();
  const base = trimmed.replace(/\\/g, '/');
  const hadWindowsSuffix = /\.(cmd|exe|bat|ps1)$/i.test(base);
  const withoutSuffix = base.replace(/\.(cmd|exe|bat|ps1)$/i, '');
  // Windows-shaped if the original used `\` separators or had a Windows
  // executable suffix. In either case, case-fold for cross-machine identity.
  const isWindowsShaped = hadWindowsSuffix || trimmed.includes('\\');
  const cased = isWindowsShaped ? withoutSuffix.toLowerCase() : withoutSuffix;

  // De-noise PATH-resolved runtimes: `/usr/bin/node` and `node` both run node.
  // Only fold when the basename matches a known runtime so custom scripts at
  // absolute paths (e.g. `/opt/internal/orchestrator.sh`) keep their identity.
  const basename = cased.split('/').pop() ?? cased;
  if (KNOWN_RUNTIMES.has(basename.toLowerCase())) {
    return isWindowsShaped ? basename.toLowerCase() : basename;
  }
  return cased;
}

/**
 * Common runtime executables whose absolute-path location varies across
 * machines (PATH lookup resolves them) but whose identity for MCP-config
 * purposes is the runtime name itself. Conservative — only entries where
 * basename collapse is provably safe across the platforms an MCP config
 * might be authored on.
 */
const KNOWN_RUNTIMES = new Set([
  'node', 'npx', 'npm', 'pnpm', 'yarn',
  'python', 'python3', 'pip', 'pip3', 'pipx', 'uvx', 'uv',
  'ruby', 'gem', 'bundle',
  'perl', 'cpan',
  'bash', 'sh', 'zsh', 'fish', 'powershell', 'pwsh',
  'deno', 'bun', 'tsx', 'ts-node',
]);

function normalizePath(p: string): string {
  return p.trim().replace(/\\/g, '/').replace(/\/+$/, '');
}

/**
 * Boolean flags that don't change *what* runs, just confirmation/verbosity.
 * Dropped before canonicalization so e.g. `npx -y foo@1.2.3` and `npx foo@1.2.3`
 * normalize identically. Keep this list conservative — only flags whose presence
 * vs. absence is provably neutral across the runners that show up in MCP configs
 * (npx, uvx, pipx, node).
 */
const NEUTRAL_BOOLEAN_FLAGS = new Set(['-y', '--yes']);

/**
 * Flags universally treated as boolean (no value follows) by the runners we
 * care about. Listed so `canonicalizeArgs` doesn't greedily pair them with the
 * next positional argument, which would conflate `--verbose pkg` with
 * `--verbose=pkg`. Unlike NEUTRAL_BOOLEAN_FLAGS these stay in the canonical
 * form — they're load-bearing (different identity vs. their absence) but
 * standalone.
 *
 * Conservative — only flags where "takes a value" is essentially never their
 * meaning in any CLI we'd see in an MCP config.
 */
const KNOWN_BOOLEAN_FLAGS = new Set([
  '-v', '-V', '-q', '-h', '-d',
  '--verbose', '--quiet', '--silent', '--debug', '--help', '--version',
  '--force', '--dry-run', '--no-cache', '--no-color', '--no-progress', '--json',
]);

/**
 * Sort *neutral* flag/value pairs so reordering doesn't change identity, but
 * preserve the order of positional arguments (which are usually load-bearing —
 * e.g. `npx <package> <subcommand>`).
 *
 * Heuristic: an argument starting with `-` is a flag. A flag followed by a
 * non-flag is treated as `--flag value` and the pair is sorted together. We
 * keep them in two buckets: positional (order-preserved) and flag-pairs (sorted).
 *
 * Neutral boolean flags (see NEUTRAL_BOOLEAN_FLAGS) are dropped entirely so they
 * never absorb a trailing positional as a fake `--flag value` pair.
 */
function canonicalizeArgs(args: readonly string[]): string[] {
  const filtered = args.filter((a) => !NEUTRAL_BOOLEAN_FLAGS.has(a));
  const positional: string[] = [];
  const flagPairs: Array<[string, string | null]> = [];

  let sawFlag = false;
  let postFlagPosIndex = 0;
  for (let i = 0; i < filtered.length; i++) {
    const a = filtered[i]!;
    if (a.startsWith('-')) {
      sawFlag = true;
      // `--key=value`
      const eq = a.indexOf('=');
      if (eq !== -1) {
        flagPairs.push([a.slice(0, eq), a.slice(eq + 1)]);
        continue;
      }
      // Known-boolean flags never consume the next argument, so `--verbose pkg`
      // leaves `pkg` as a positional rather than collapsing into a fake pair.
      // Without this guard, reordering ['--host', 'localhost', '--verbose', 'pkg']
      // vs ['--verbose', '--host', 'localhost', 'pkg'] produced different
      // canonical strings because `--verbose` greedily ate the next non-flag.
      if (KNOWN_BOOLEAN_FLAGS.has(a)) {
        flagPairs.push([a, null]);
        continue;
      }
      const next = filtered[i + 1];
      if (next !== undefined && !next.startsWith('-')) {
        flagPairs.push([a, next]);
        i++;
      } else {
        flagPairs.push([a, null]);
      }
      continue;
    }
    if (sawFlag) {
      // After flags have started, an unattached positional retains its
      // *relative* order via an index prefix. Without the index, two configs
      // with the same flags but different post-flag positional ordering would
      // collapse to the same identity — see canonicalizeArgs regression tests.
      const padIndex = postFlagPosIndex.toString().padStart(8, '0');
      flagPairs.push([`__pos_${padIndex}__${a}`, null]);
      postFlagPosIndex++;
    } else {
      positional.push(a);
    }
  }

  flagPairs.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));

  const out: string[] = [...positional];
  for (const [k, v] of flagPairs) {
    if (k.startsWith('__pos_')) {
      // Drop the `__pos_NNNNNNNN__` prefix to recover the original argument.
      out.push(k.slice(k.indexOf('__', 6) + 2));
    } else if (v === null) {
      out.push(k);
    } else {
      out.push(`${k}=${v}`);
    }
  }
  return out;
}
