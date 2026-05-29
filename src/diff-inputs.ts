import { resolve, sep } from 'node:path';

/**
 * Safety guards shared by every detector that ingests a diff from an
 * untrusted source — a PR branch, a pair of directories, a tree the
 * caller did not author. Three concerns live here because they all guard
 * the same boundary (the moment untrusted file/ref input enters a `git`
 * subprocess or a `readFile`):
 *
 *  - {@link isValidGitRef} — reject refs that `git` would re-parse as CLI
 *    flags or object-selector syntax (argument injection).
 *  - {@link resolveWithinRoot} — reject file paths that escape the root
 *    they are supposed to live under (path traversal / symlink target).
 *  - {@link withinByteCap} — reject inputs large enough to exhaust memory.
 *
 * Before v1.3.0 each detector carried its own copy (or, worse, was missing
 * one): ScopeTrail had the ref guard, TaskBound and CapabilityEcho did not;
 * TaskBound had `safeJoin`, CapabilityEcho did not. Centralizing closes
 * those gaps and keeps the rules identical across the suite.
 */

const GIT_REF_CONTROL_CHARS = /[\x00-\x1f\x7f]/;

/**
 * True when `ref` is safe to hand to `git` as a revision argument.
 *
 * `execFile` blocks shell-metacharacter injection, but it still passes the
 * value to `git` as a positional argument that git re-parses against its
 * own option table — so a `-`-leading ref (`--upload-pack=...`, `--help`)
 * is an argument-injection vector. Detectors also build `ref:path` object
 * selectors (`git show <ref>:<file>`), so a `:` in the ref would re-anchor
 * the selector and read an unintended object. Control characters are
 * rejected too: git would not accept them anyway, and refusing up front
 * yields a clean error instead of a raw subprocess rejection.
 *
 * This is a pure string check — it does not resolve the ref. Callers still
 * run `git rev-parse --verify` (wrapped in their own error type) to confirm
 * the ref actually exists.
 *
 * @example
 * isValidGitRef('main');                 // → true
 * isValidGitRef('origin/feature-x');     // → true
 * isValidGitRef('--upload-pack=/x');     // → false (leading '-')
 * isValidGitRef('HEAD:secret');          // → false (contains ':')
 * isValidGitRef('');                     // → false (empty)
 */
export function isValidGitRef(ref: string): boolean {
  return Boolean(ref) && !ref.startsWith('-') && !ref.includes(':') && !GIT_REF_CONTROL_CHARS.test(ref);
}

/**
 * Resolve `relativePath` against `root` and return the absolute path only
 * if it stays inside `root`; otherwise return `null`.
 *
 * Defense-in-depth for directory-comparison modes, which are fed
 * user-provided trees that may contain `..` sequences, absolute paths, or
 * symlink targets. `path.resolve` collapses `..` without touching the
 * filesystem, so a string that climbs out of `root` is caught here before
 * any `readFile` — keeping reads bounded to what the caller meant to
 * expose. (Symlinks resolve at read time, not by `resolve`, so callers
 * must *also* skip symlinked directory entries during the walk; this guard
 * only stops string-level traversal.)
 *
 * @example
 * resolveWithinRoot('/repo', 'src/app.ts');   // → '/repo/src/app.ts'
 * resolveWithinRoot('/repo', '../etc/passwd'); // → null
 * resolveWithinRoot('/repo', '/etc/passwd');   // → null
 */
export function resolveWithinRoot(root: string, relativePath: string): string | null {
  const rootResolved = resolve(root);
  const joined = resolve(rootResolved, relativePath);
  if (joined !== rootResolved && !joined.startsWith(rootResolved + sep)) {
    return null;
  }
  return joined;
}

/**
 * Default ceiling for a single input read into memory: 10 MiB. Matches the
 * per-file `maxBuffer` the suite already uses for `git show`/`git diff`
 * output, so adopting the cap does not change behavior on real source
 * trees (human-authored source files are orders of magnitude smaller).
 */
export const DEFAULT_MAX_INPUT_BYTES = 10 * 1024 * 1024;

/**
 * True when `byteLength` is within `cap` (default {@link DEFAULT_MAX_INPUT_BYTES}).
 *
 * Pure predicate so callers can `stat` a file (or measure a buffer) and
 * decide whether to read/scan it without each detector hard-coding its own
 * limit. A non-finite or negative `byteLength` is treated as over-cap
 * (fail closed).
 *
 * @example
 * if (!withinByteCap(stats.size)) continue; // skip oversized file
 */
export function withinByteCap(byteLength: number, cap: number = DEFAULT_MAX_INPUT_BYTES): boolean {
  if (!Number.isFinite(byteLength) || byteLength < 0) {
    return false;
  }
  return byteLength <= cap;
}
