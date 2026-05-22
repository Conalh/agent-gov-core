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

```ts
import { kind, type Finding } from 'agent-gov-core';

const finding: Finding = {
  tool: 'scope_trail',
  kind: kind('scope_trail', 'permission_allow_widened'),
  severity: 'high',
  message: 'Claude permission allowlist now includes Bash(npm *).',
  location: { file: '.claude/settings.json', line: 12 },
};
```

The JSON schema at [`schemas/finding.schema.json`](./schemas/finding.schema.json) enforces the dotted-kind shape — any tool emitting unprefixed kinds will fail validation.

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
- `readJsonObjectWithSource(path)` — JSONC reader, string-aware comment + trailing-comma stripping, position-preserving
- `stripJsonComments(text)` — same logic exposed for in-memory text
- `readTomlObject(path)` — TOML reader (sections, arrays of tables, inline tables, multi-line strings, dotted/quoted keys)
- `parseToml(text)` — same exposed for text

### Line locators
- `lineOfJsonKey(text, key)` — 1-based line of `"key":`
- `lineOfJsonStringValue(text, value, scope?)` — 1-based line of a JSON-encoded value, optionally scoped to a byte range
- `lineOfTomlKey(text, dottedKey)` — 1-based line of a TOML key

### MCP command normalization
- `normalizeMcpCommand({ command, args, url, serverUrl, env, cwd })` — canonical identity string for an MCP server entry. Drops neutral flags (`-y`, `--yes`), resolves npx/uvx invocations, includes env+cwd in the identity. Used to dedupe `mcp_command_mismatch` false positives when servers are equivalent but syntactically different (`npx -y foo@1.2.3` vs `npx foo@1.2.3`).

### Shell tokenization
- `tokenizeShell(command)` — quote-aware split on `;`, `|`, `&&`, `||` plus trivial obfuscation neutralization (`c""url` → `curl`, `c\\url` → `curl`)
- `getCommandHead(subcommand)` — extract the leading verb after tokenization

### GitHub Action helpers
- `rankSeverity(s)` — numeric rank `none=0 … critical=4`
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

## License

MIT.
