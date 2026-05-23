/**
 * Exception baselines — the "we know about this, suppress it for now" mechanism
 * that PolicyMesh (`.policymesh-exceptions.json`) and TaskBound (`.taskbound.yml`
 * `ignore_kinds` / `allow_paths`) both invented separately. Lifted into the
 * substrate so all five tools share one shape and one expiry contract.
 *
 * Two design choices worth flagging:
 *
 * 1. Expired exceptions DON'T silently drop. They re-surface the original
 *    finding with severity downgraded to `'low'` and an `[EXPIRED WHITELIST]`
 *    prefix on the message. The point of exception baselines is to make stale
 *    suppression visible, not to grow a graveyard of permanent ignores.
 *
 * 2. Match keys are `kind` (required) plus optional `salientKey` and
 *    `pathPrefix` narrowing. Subject/path matching from the two consumers
 *    maps cleanly: PolicyMesh's `subject` is now `salientKey`; TaskBound's
 *    `allow_paths` entries map to `pathPrefix` exceptions on the relevant
 *    finding kind.
 */

import type { Finding, Severity } from './finding.js';

/**
 * A single exception rule. Suppresses (or downgrades, when expired) findings
 * whose `kind` matches and — if either narrower is set — whose `salientKey`
 * or `location.file` prefix also matches.
 */
export interface Exception {
  /** Required: exact match against `Finding.kind`. */
  kind: string;
  /**
   * Optional: exact match against `Finding.salientKey`. Use this to scope an
   * exception to one specific finding instance at a site that produces
   * multiple distinct findings (e.g. one of several suspicious packages on
   * the same import line).
   */
  salientKey?: string;
  /**
   * Optional: only match findings whose `location.file` starts with this
   * string. Use to scope an exception to a directory subtree without listing
   * every file individually (TaskBound's `allow_paths` use case).
   */
  pathPrefix?: string;
  /**
   * Optional ISO 8601 date (YYYY-MM-DD or full timestamp). When the current
   * date is past `expires`, matched findings re-surface with severity
   * downgraded to `'low'` and an `[EXPIRED WHITELIST]` message prefix.
   */
  expires?: string;
  /** Optional free-text rationale, preserved on expired findings via `data.exceptionReason`. */
  reason?: string;
}

export interface ApplyExceptionsResult {
  /** Findings after exceptions applied: survivors + downgraded expired entries. */
  findings: Finding[];
  /** Count of findings suppressed by an active (non-expired) exception. */
  suppressed: number;
  /** Count of findings surfaced as expired (downgraded + prefixed). */
  expired: number;
}

const EXPIRED_PREFIX = '[EXPIRED WHITELIST] ';
const EXPIRED_DOWNGRADE: Severity = 'low';

/**
 * Apply a set of exceptions to a finding list. Returns the post-filter
 * list along with counts so a meta-reviewer can report how many findings
 * the baseline suppressed.
 *
 * @example
 * import { applyExceptions } from 'agent-gov-core';
 *
 * const result = applyExceptions(findings, [
 *   { kind: 'capability_echo.high_capability_dep_added', salientKey: 'puppeteer', expires: '2026-06-01', reason: 'browser-tests rollout' },
 *   { kind: 'task_bound.out_of_scope_file', pathPrefix: 'tools/internal/', reason: 'internal tooling refactor' },
 * ]);
 * console.log(`${result.suppressed} suppressed, ${result.expired} expired`);
 */
export function applyExceptions(
  findings: readonly Finding[],
  exceptions: readonly Exception[],
  now: Date = new Date(),
): ApplyExceptionsResult {
  if (exceptions.length === 0) {
    return { findings: [...findings], suppressed: 0, expired: 0 };
  }

  const result: Finding[] = [];
  let suppressed = 0;
  let expired = 0;

  for (const finding of findings) {
    // Collect ALL matching rules — order independence is required by contract.
    // A finding is suppressed when any matching rule is active; only when
    // every matching rule has expired does the finding re-surface as expired.
    // Previously the first match won, so a stale rule listed before an
    // active broader rule incorrectly surfaced expired alerts.
    const matches = findAllMatchingExceptions(finding, exceptions);
    if (matches.length === 0) {
      result.push(finding);
      continue;
    }

    const activeMatch = matches.find((m) => !m.expires || !isExpired(m.expires, now));
    if (activeMatch) {
      suppressed++;
      continue;
    }

    // Every matching rule has expired. Use the first match for reason text.
    result.push(downgradeExpired(finding, matches[0]!));
    expired++;
  }

  return { findings: result, suppressed, expired };
}

function findAllMatchingExceptions(finding: Finding, exceptions: readonly Exception[]): Exception[] {
  const out: Exception[] = [];
  for (const exc of exceptions) {
    if (exc.kind !== finding.kind) continue;
    if (exc.salientKey !== undefined && exc.salientKey !== finding.salientKey) continue;
    if (exc.pathPrefix !== undefined && !pathPrefixMatches(finding.location?.file, exc.pathPrefix)) continue;
    out.push(exc);
  }
  return out;
}

/**
 * Segment-aware path-prefix match. Normalizes Windows backslashes to forward
 * slashes on BOTH sides so a finding's `src\app.ts` matches a `src/` prefix.
 * Requires the prefix match to land on a segment boundary OR be the exact
 * full path — so prefix `src/app` does NOT match `src/application.ts`.
 */
function pathPrefixMatches(file: string | undefined, prefix: string): boolean {
  if (!file) return false;
  const fileNorm = file.replace(/\\/g, '/');
  const prefixNorm = prefix.replace(/\\/g, '/');
  if (!fileNorm.startsWith(prefixNorm)) return false;
  // Exact match, prefix ends with `/`, or next char is `/` — all valid boundaries.
  if (fileNorm.length === prefixNorm.length) return true;
  if (prefixNorm.endsWith('/')) return true;
  return fileNorm[prefixNorm.length] === '/';
}

function isExpired(expires: string, now: Date): boolean {
  const parsed = new Date(expires);
  if (Number.isNaN(parsed.getTime())) return false;
  return parsed.getTime() < now.getTime();
}

function downgradeExpired(finding: Finding, exc: Exception): Finding {
  const downgraded: Finding = {
    ...finding,
    severity: EXPIRED_DOWNGRADE,
    message: EXPIRED_PREFIX + finding.message,
  };
  if (exc.reason !== undefined) {
    downgraded.data = { ...(finding.data ?? {}), exceptionReason: exc.reason };
  }
  return downgraded;
}

/**
 * Validate that an unknown value is a well-formed `Exception` shape. Useful
 * when consumers load exceptions from JSON/YAML and want to surface parse-
 * level errors as findings rather than crash.
 */
export function validateException(value: unknown): { ok: boolean; errors: string[] } {
  const errors: string[] = [];
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return { ok: false, errors: ['exception must be a plain object'] };
  }
  const v = value as Record<string, unknown>;
  if (typeof v.kind !== 'string' || v.kind.length === 0) {
    errors.push('kind must be a non-empty string');
  }
  if (v.salientKey !== undefined && typeof v.salientKey !== 'string') {
    errors.push('salientKey must be a string when present');
  }
  if (v.pathPrefix !== undefined && typeof v.pathPrefix !== 'string') {
    errors.push('pathPrefix must be a string when present');
  }
  if (v.expires !== undefined) {
    if (typeof v.expires !== 'string') {
      errors.push('expires must be an ISO 8601 string when present');
    } else if (Number.isNaN(new Date(v.expires).getTime())) {
      errors.push('expires must be a parseable date (e.g. "2026-12-31" or full ISO timestamp)');
    }
  }
  if (v.reason !== undefined && typeof v.reason !== 'string') {
    errors.push('reason must be a string when present');
  }
  const allowed = new Set(['kind', 'salientKey', 'pathPrefix', 'expires', 'reason']);
  for (const key of Object.keys(v)) {
    if (!allowed.has(key)) errors.push(`unknown property: ${key}`);
  }
  return { ok: errors.length === 0, errors };
}
