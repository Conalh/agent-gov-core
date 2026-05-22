# agent-gov-core

[![npm](https://img.shields.io/npm/v/agent-gov-core)](https://www.npmjs.com/package/agent-gov-core)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

Shared primitives for the AI-agent governance suite — a small library that ScopeTrail, PolicyMesh, CapabilityEcho, TaskBound, and SessionTrail all consume so common parsers, locators, and the `Finding` schema live in one place instead of five.

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

`createFinding` calls `kind()` to build the namespaced kind, validates the slug shape, and computes a stable `fingerprintFinding(finding)` hash of `(kind, file, line, column)`.

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

### Schema is the contract

The JSON schema at [`schemas/finding.schema.json`](./schemas/finding.schema.json) is the single source of truth for the dotted-kind shape, the closed `tool` enum, and the location fields. Any tool emitting unprefixed kinds will fail validation. See [CONTRIBUTING.md](./CONTRIBUTING.md#the-finding-schema-is-the-contract) for how the TypeScript types and JSON schema are kept in lockstep.

## What's in the library

### Finding schema and helpers
- `Finding`, `Severity`, `ToolKind`, `FindingLocation` — canonical types
- `SEVERITIES`, `TOOL_KINDS` — runtime arrays of the enum values
- `isSeverity(v)`, `isToolKind(v)`, `isNamespacedKind(v)` — type guards
- `kind(tool, name)` — build a namespaced kind without hand-assembling the dotted string
- `createFinding({tool, name, severity, message, ...})` — convenience constructor that calls `kind()` and `fingerprintFinding()` for you
- `fingerprintFinding(finding)` — 16-character hex hash of `(kind, file, line, column)`. Stable across runs and message rewordings, so a meta-reviewer can dedupe
- `validateFinding(value)` — runtime check against `schemas/finding.schema.json`, returns `{ ok, errors[] }`

### Config readers
- `readJsonObjectWithSource(path)` — JSONC reader, string-aware comment + trailing-comma stripping, position-preserving. Returns `{ value, json, text, parseError? }`; `value` and `json` reference the same parsed object — `json` is kept as a deprecated alias.
- `stripJsonComments(text)` — same logic exposed for in-memory text
- `readTomlObject(path)` — TOML reader (sections, arrays of tables, inline tables, multi-line strings, dotted/quoted keys). Returns `{ value, toml, text, parseError? }`; `value` and `toml` reference the same parsed object — `toml` is kept as a deprecated alias.
- `parseToml(text)` — same exposed for text

### Line locators
- `lineOfJsonKey(text, key, scope?)` — 1-based line of `"key":`, optionally scoped to a byte range
- `lineOfJsonStringValue(text, value, scope?)` — 1-based line of a JSON-encoded value, optionally scoped to a byte range
- `lineOfTomlKey(text, dottedKey, scope?)` — 1-based line of a TOML key, optionally scoped to a byte range. Use scope to disambiguate `[[array]]`-of-tables entries that share the same leaf key.

### MCP command normalization
- `normalizeMcpCommand({ command, args, url, env, cwd })` — canonical identity string for an MCP server entry. Drops neutral confirm flags (`-y`, `--yes`), strips Windows executable suffixes (`.cmd`, `.exe`, `.bat`, `.ps1`), sorts non-neutral flags alphabetically, preserves positional argument order, and includes env + cwd in the identity. Used to dedupe `mcp_command_mismatch` false positives when servers are equivalent but syntactically different (`npx -y foo@1.2.3` vs `npx foo@1.2.3`). Does not interpret what npx/uvx invocations resolve to at runtime — that's outside the substrate's scope.

### Shell tokenization
- `tokenizeShell(command)` — quote-aware split on `;`, `|`, `&&`, `||` plus trivial obfuscation neutralization (`c""url` → `curl`, `c\\url` → `curl`)
- `getCommandHead(subcommand)` — extract the leading verb after tokenization

### GitHub Action helpers
- `rankSeverity(s)` — numeric rank `low=1, medium=2, high=3, critical=4` (matches the schema's closed severity enum; there is no `none`)
- `passesSeverityThreshold(s, threshold)`, `anyAtOrAbove(findings, threshold)` — fail-on plumbing
- `emitFindingAnnotation(f)` — render a Finding as a `::warning file=…,line=…,title=…::…` GitHub workflow annotation

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

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md) for the dev workflow, "adding a detector" walkthrough, the dist/release rules, and the cross-tool dogfooding contract.

Per-release notes live in [CHANGELOG.md](./CHANGELOG.md).

## License

MIT.
