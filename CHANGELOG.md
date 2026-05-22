# Changelog

All notable changes to this project will be documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html). Under v1.0, minor versions may include breaking changes — see [CONTRIBUTING.md](./CONTRIBUTING.md#backwards-compatibility) for the rules.

## [0.4.4] — 2026-05-22

Cody-led inspection (third reviewer, third round) caught five issues, two of them P0 regressions I introduced in my own v0.4.2 / v0.4.3 fixes. All five fixed here.

### Fixed
- **P0**: `fingerprintFinding` no longer appends an empty-string segment for findings without `salientKey`. v0.4.3 added `?? ''` which silently changed the hash for every existing finding and broke the v0.4.2 → v0.4.3 backwards-compat claim in my own changelog. Pinned by a new test that asserts the specific v0.4.2-form hash for a salient-less finding.
- **P0**: TOML parser no longer rejects valid subtable headers repeated under separate array-of-tables entries. `[[fruits]] [fruits.physical] [[fruits]] [fruits.physical]` now parses correctly — each `[[fruits]]` entry resets the "already defined" status of subtable paths under that AOT. My v0.4.2 `definedTables` guard was global per-file when it should have been scoped to the current AOT entry.
- `lineOfJsonStringValue` no longer matches occurrences in key position. Searching for value `"command"` in `{"command":"npx", "args":["command"]}` now returns the array-element line, not the key. Negative lookahead `(?!\s*:)` after the closing quote.
- `lineOfTomlKey` now finds top-level dotted keys. `lineOfTomlKey('a.b.c = 1', 'a.b.c')` returns 1 instead of 0 — the dotted-key check was gated behind `inTargetTable` which is false at file root.

### Changed
- `package-lock.json` resynced to 0.4.4. Was drifting at 0.4.2 because previous releases bumped `package.json` without running `npm install` to refresh the lockfile.

### Tests
- 6 new cases: pinned v0.4.2-form fingerprint hash, JSON value-vs-key disambiguation (+ colon-in-value sanity check), top-level dotted TOML keys, AOT subtable repeat across entries (+ within-entry duplicate still rejected). 108 total (up from 102).

## [0.4.3] — 2026-05-22

Third Gemini-inspection round caught one confirmed bug, one disguised-as-suggestion bug, and three feature opportunities. Both bugs fixed here; the feature work is queued for v0.5.0.

### Added
- `Finding.salientKey?: string` — optional discriminator that participates in the fingerprint hash. Set this when a single (kind, file, line) site can produce multiple distinct findings (e.g. two suspicious imports on the same line, two MCP servers in the same JSON object). Without it, the meta-reviewer would dedupe them into one. Stable values only — package name, server name, rule id; not timestamps or counters.
- `CreateFindingSpec.salientKey` — pass-through to the new field.
- Schema gained `salientKey` under properties (still optional, schema's `additionalProperties: false` updated to permit it).

### Fixed
- `fingerprintFinding` now includes `salientKey` in the hash. Two distinct findings of the same kind on the same line with different `salientKey` values now produce different fingerprints. Backwards-compatible: findings without `salientKey` still produce stable, identical fingerprints to v0.4.2 for the (kind, file, line, column) tuple.
- `lineOfTomlKey` now tracks multi-line basic (`"""`) and literal (`'''`) string state and skips key matching on lines that fall inside one. Previously a decoy key inside a multi-line string value could be matched as if it were a real assignment — confirmed bug with sharper reproduction than Gemini's first-round example.

### Tests
- 7 new regression cases. 102 total (up from 95). Covers salientKey discrimination, backwards-compat for fingerprints without salientKey, validateFinding type check, decoy-in-`"""`, decoy-in-`'''`, single-line `"""..."""` (must NOT enter multiline state), and a plain-TOML sanity check that the fix doesn't over-correct.

## [0.4.2] — 2026-05-22

External code review (Gemini, second pass) caught four correctness bugs and one source-cleanliness issue. All five fixed here.

### Fixed
- `lineOfJsonKey` and `lineOfJsonStringValue` now JSON-encode the search input before building the regex. A caller passing the *decoded* value (e.g. `C:\Temp` from a Windows-path field) now correctly locates the JSON source bytes (`"C:\\Temp"`) instead of returning 0. Affects CapabilityEcho's `package-scripts` detector for scripts containing quotes/backslashes.
- `lineOfJsonKey` and `lineOfJsonStringValue` now scan over `stripJsonComments(text)` instead of raw text. A commented-out `"command": "fake"` no longer shadows the real key on a later line. The strip is position-preserving so returned line numbers still reference the original source.
- `getCommandHead` now strips wrapper flags (`sudo -E`, `env -i`) after recognizing a wrapper, so `sudo -E curl ...` returns `curl` instead of `-E`. SessionTrail/CapabilityEcho shell detectors no longer miss wrapped curl/wget invocations. Known limitation: short flags taking a value (`sudo -u user curl`) still misclassify as the value — documented and pinned by test.
- TOML parser now rejects a standard table header (`[items]`) that follows an array-of-tables header (`[[items]]`) with a `Cannot redefine array-of-tables` error. Previously the standard table silently descended into the array's last entry, letting writes leak into `items[0]`. Spec compliance fix.
- TOML inline-table parser now rejects duplicate keys with `Duplicate key in inline table: ...`. Previously `server = { host = "a", host = "b" }` parsed as `{ host: "b" }` — the standard-table guard wasn't mirrored on inline tables. Spec compliance fix.

### Changed
- Source cleanup: the two `keys.join` calls in `src/toml.ts` now use a named `PATH_KEY_SEPARATOR = ''` constant instead of literal NUL bytes embedded in the source. Same runtime behavior (NUL as the delimiter, which is illegal in TOML keys so collision-proof), but `rg`/`grep` no longer treat the file as binary and `file(1)` reports it as proper text.
- README: `rankSeverity` doc corrected — was `none=0…critical=4`, actually `low=1, medium=2, high=3, critical=4`. The schema has no `none` severity.
- README: `normalizeMcpCommand` signature and behavior description corrected — was listing a non-existent `serverUrl` field and claiming "resolves npx/uvx invocations" which doesn't happen. Now accurately lists: drops neutral confirm flags, strips Windows executable suffixes, sorts non-neutral flags alphabetically, preserves positional argument order, includes env + cwd in identity.

### Added
- 7 new regression tests: encoded-value lookup, commented-out shadow, wrapper-flag unwrap (+ edge-case pin), AOT-vs-table mixing, inline-table duplicate keys.

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
