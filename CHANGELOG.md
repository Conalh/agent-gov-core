# Changelog

All notable changes to this project will be documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html). Under v1.0, minor versions may include breaking changes — see [CONTRIBUTING.md](./CONTRIBUTING.md#backwards-compatibility) for the rules.

## [0.4.1] — 2026-05-22

### Fixed
- `fingerprintFinding` now normalizes Windows-style backslash paths to forward slashes before hashing. A finding emitted on Windows and the same finding emitted in Linux CI now collapse to the same fingerprint — previously they'd diverge and break cross-platform dedupe. Caught by external code review.
- `normalizeMcpCommand` now preserves the relative order of positional arguments that appear after a flag. Previously `['--flag', 'x', 'a', 'b']` and `['--flag', 'x', 'b', 'a']` collapsed to the same canonical identity because the post-flag positional keys were co-sorted with flag pairs. PolicyMesh's `mcp_command_mismatch` would under-report under this bug. Caught by external code review.

### Changed
- `stripJsonComments` and `stripTrailingCommas` no longer carry the dead `"'"` (single-quote) state in their string tracker — JSON strings are double-quoted only. Pure type/comment cleanup, no behavior change. Caught by external code review.

### Added
- Regression tests for both fixes:
  - `fingerprintFinding`: identical fingerprint across Windows and POSIX path separators.
  - `normalizeMcpCommand`: differing post-flag positional order produces different identities; flag order independence preserved.
- `CHANGELOG.md` is now shipped in the npm tarball.

### Internal
- `package.json` `files` allow-list trimmed to exclude `.js.map` / `.d.ts.map` sourcemaps from the published tarball. The maps referenced `src/*.ts` source files that aren't shipped, so they were dead links anyway. Tarball is ~27% smaller (32.4 kB → ~23.6 kB).

## [0.4.0] — 2026-05-22

### Added
- `JsonObjectWithSource.value` — new field that mirrors `json`, populated identically. Use this in new code; `json` is kept as a populated alias.
- `TomlObjectWithSource.value` — same pattern for the TOML reader.
- `lineOfTomlKey(text, dottedKey, scope?)` — optional `scope: ByteRange` parameter for parity with `lineOfJsonKey` and `lineOfJsonStringValue`. Useful when an outer locator has already pinned a parent table's range and you want to find a leaf inside it without false matches from a sibling table.

### Deprecated
- `JsonObjectWithSource.json` — prefer `value`. Will be removed in a future major version.
- `TomlObjectWithSource.toml` — prefer `value`. Will be removed in a future major version.

## [0.3.1] — 2026-05-22

### Added
- Secondary entry point `agent-gov-core/test-utils` with fixtures the suite repos all hand-rolled:
  - `writeFiles(dir, fileMap)` — write a path-to-content map, creating parent directories.
  - `makeGitRepo({initialFiles?, initialMessage?})` → `{repo, commit, head, git, cleanup}` — temp git repo on branch `main` with placeholder identity. `commit()` applies files and commits, returning the new SHA.
  - `makeOldNewFixture({old, new})` → `{old, new, cleanup}` — two sibling temp directories for diff-mode CLI tests.

## [0.3.0] — 2026-05-22

### Added
- `createFinding({tool, name, severity, message, ...})` — convenience constructor that calls `kind()` and `fingerprintFinding()` for you.
- `fingerprintFinding(finding)` — 16-char hex hash of `(kind, file, line, column)`. Stable across runs and message rewordings, so a meta-reviewer can dedupe.
- `validateFinding(value)` — runtime check against `schemas/finding.schema.json`, returns `{ ok, errors[] }`.
- `CreateFindingSpec` and `FindingValidationResult` types.
- JSDoc `@example` blocks on `tokenizeShell`, `getCommandHead`, `normalizeMcpCommand`, `emitFindingAnnotation`.
- JSDoc on `ToolKind` explaining the schema/runtime lockstep contract.

## [0.2.0] — earlier

### Added
- `kind(tool, name)` typed helper that builds `<tool>.<slug>` strings.
- `isNamespacedKind(value)` runtime guard matching the JSON schema's `kind` pattern.

### Changed
- Schema regex tightened to require namespaced kinds: `^(scope_trail|policy_mesh|capability_echo|task_bound|session_trail)\.[a-z0-9_]+$`.

## [0.1.2] — earlier

### Changed
- `normalizeMcpCommand` drops neutral confirm flags (`-y`, `--yes`) before canonicalization, so `npx -y foo` and `npx foo` produce the same identity.

## [0.1.0] — earlier

Initial release. Finding schema, JSONC/TOML readers, line locators, MCP normalization, shell tokenization, and GitHub Action helpers.
