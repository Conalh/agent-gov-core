/**
 * Hardcoded credential detection.
 *
 * Scans strings for provider-prefix tokens (Anthropic, OpenAI, GitHub, AWS,
 * Slack, Google, GitLab, npm, Docker, Stripe) plus a length-restricted hex
 * pattern that only fires in env/header context (a bare hex blob in a
 * positional command argument is indistinguishable from a commit SHA).
 *
 * Contract: the literal credential is NEVER returned in any field. Callers
 * receive only the provider name plus the pattern that matched (provider
 * label only — not the regex). This is the same contract PolicyMesh shipped
 * the detector under, lifted into the substrate so every governance tool
 * uses one source of truth for "what does a hardcoded credential look like."
 *
 * @example
 * import { matchSecret } from 'agent-gov-core';
 *
 * matchSecret('sk-ant-abcdefghijklmnopqrstuv');
 * // → { provider: 'Anthropic' }
 *
 * matchSecret('env:OPENAI_API_KEY');
 * // → undefined (env var reference, not a literal)
 *
 * matchSecret('a'.repeat(40), { envOrHeaderContext: true });
 * // → undefined (only A-F0-9 are hex; not a hex token)
 */

export interface SecretMatch {
  /** Human-readable provider name. The literal credential is NEVER included. */
  provider: string;
}

export interface MatchSecretOptions {
  /**
   * When `true`, patterns flagged `envOrHeaderOnly` are eligible. Set this
   * only when scanning env values or HTTP header values — never when scanning
   * a joined launch command (positional args often contain commit SHAs that
   * would false-positive against a bare hex token pattern).
   */
  envOrHeaderContext?: boolean;
}

interface SecretPattern {
  provider: string;
  regex: RegExp;
  /** See {@link MatchSecretOptions.envOrHeaderContext}. */
  envOrHeaderOnly?: boolean;
}

/**
 * Built-in provider patterns. Conservative — only shapes whose prefix
 * unambiguously identifies a credential class. The bare hex pattern is gated
 * to env/header context to avoid commit-SHA false positives.
 *
 * **Left-boundary anchored (v1.2.1).** Each provider prefix is gated by
 * `(?:^|[^A-Za-z0-9_-])` so the prefix only matches at the start of the
 * input or after a non-identifier character. Closes a false-positive class
 * where the prefix appears mid-token inside a longer compound identifier
 * (e.g. `mycommit_AIza…` no longer flags as Google; `Bearer AIza…` still
 * does). The hex-token pattern carried its own boundary anchors from v0.7.0
 * and is unchanged here.
 *
 * Stable as of v0.7.0 — additions are non-breaking, removals or shape changes
 * require a major bump (the golden compatibility tests in `test/golden.test.mjs`
 * pin the current provider set).
 */
export const SECRET_PATTERNS: readonly Readonly<SecretPattern>[] = [
  { provider: 'Anthropic', regex: /(?:^|[^A-Za-z0-9_-])sk-ant-[A-Za-z0-9_-]{20,}/ },
  { provider: 'OpenAI', regex: /(?:^|[^A-Za-z0-9_-])sk-proj-[A-Za-z0-9_-]{20,}/ },
  { provider: 'OpenAI', regex: /(?:^|[^A-Za-z0-9_-])sk-(?!ant-|proj-)[A-Za-z0-9]{32,}/ },
  { provider: 'GitHub', regex: /(?:^|[^A-Za-z0-9_-])gh[pousr]_[A-Za-z0-9]{36,}/ },
  { provider: 'GitHub', regex: /(?:^|[^A-Za-z0-9_-])github_pat_[A-Za-z0-9_]{20,}/ },
  { provider: 'Slack', regex: /(?:^|[^A-Za-z0-9_-])xox[abprs]-[A-Za-z0-9-]{20,}/ },
  { provider: 'AWS', regex: /(?:^|[^A-Za-z0-9_-])AKIA[0-9A-Z]{16}/ },
  { provider: 'Google', regex: /(?:^|[^A-Za-z0-9_-])AIza[0-9A-Za-z_-]{35}/ },
  { provider: 'GitLab', regex: /(?:^|[^A-Za-z0-9_-])glpat-[A-Za-z0-9_-]{20,}/ },
  { provider: 'npm', regex: /(?:^|[^A-Za-z0-9_-])npm_[A-Za-z0-9]{36}/ },
  { provider: 'Docker', regex: /(?:^|[^A-Za-z0-9_-])dckr_pat_[A-Za-z0-9_-]{20,}/ },
  { provider: 'Stripe', regex: /(?:^|[^A-Za-z0-9_-])(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{20,}/ },
  // env/header context only — see comment block at top of file.
  { provider: 'Hex token', regex: /(?:^|[^A-Fa-f0-9])([A-Fa-f0-9]{40,})(?:$|[^A-Fa-f0-9])/, envOrHeaderOnly: true },
];

/**
 * Prefix marking an environment-variable reference. Values starting with
 * `env:` are not literal credentials — they're a reference resolved at
 * runtime by the consuming tool (Codex notation). Skipped during scanning.
 */
const ENV_REFERENCE_PREFIX = 'env:';

/**
 * Scan `value` for a hardcoded provider credential. Returns the matched
 * provider name (never the literal credential) or `undefined` when nothing
 * matches.
 *
 * Set `options.envOrHeaderContext` to `true` only when scanning env values
 * or HTTP header values — that enables the more permissive hex-token pattern
 * which would false-positive on positional command arguments.
 */
export function matchSecret(value: string, options: MatchSecretOptions = {}): SecretMatch | undefined {
  if (!value) return undefined;
  if (value.startsWith(ENV_REFERENCE_PREFIX)) return undefined;

  for (const pattern of SECRET_PATTERNS) {
    if (pattern.envOrHeaderOnly && !options.envOrHeaderContext) continue;
    if (pattern.regex.test(value)) {
      return { provider: pattern.provider };
    }
  }

  return undefined;
}
