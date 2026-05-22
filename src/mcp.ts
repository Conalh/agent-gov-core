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

/** Strip `.cmd`/`.exe`/`.bat`/`.ps1` suffix and lowercase on Windows-style paths. */
function normalizeExecutable(cmd: string): string {
  const trimmed = cmd.trim();
  const base = trimmed.replace(/\\/g, '/');
  const withoutSuffix = base.replace(/\.(cmd|exe|bat|ps1)$/i, '');
  return withoutSuffix;
}

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
      // After flags have started, an unattached positional gets a deterministic position
      // — push it into the sorted-pair bucket as a value-only entry keyed by itself.
      flagPairs.push([`__pos__${a}`, null]);
    } else {
      positional.push(a);
    }
  }

  flagPairs.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));

  const out: string[] = [...positional];
  for (const [k, v] of flagPairs) {
    if (k.startsWith('__pos__')) out.push(k.slice('__pos__'.length));
    else if (v === null) out.push(k);
    else out.push(`${k}=${v}`);
  }
  return out;
}
