# agent-gov-core

Shared primitives for the AI-agent governance suite — [ScopeTrail](https://github.com/Conalh/scope-trail), [PolicyMesh](https://github.com/Conalh/policy-mesh), [CapabilityEcho](https://github.com/Conalh/capability-echo), [TaskBound](https://github.com/Conalh/task-bound), and [SessionTrail](https://github.com/Conalh/session-trail).

Repeat detectors and rules live here. Per-tool reasoning and orchestration stays in each tool.

## Install

```sh
npm install agent-gov-core
```

## What's in v0.1

- **`Finding`, `Severity`, `ToolKind`** — canonical types + `schemas/finding.schema.json`.
- **`readJsonObjectWithSource(path)`** — JSONC reader (line/block comments + trailing commas), string-aware and position-preserving.
- **`readTomlObject(path)`** — TOML reader covering sections, arrays of tables, inline tables, multi-line strings, dotted/quoted keys.
- **`lineOfJsonKey`, `lineOfJsonStringValue`, `lineOfTomlKey`** — 1-based line locators; the JSON value locator accepts an optional byte-range scope.
- **`normalizeMcpCommand`** — canonical identity string for an MCP server entry.
- **`tokenizeShell`, `getCommandHead`** — quote-aware shell splitter with basic obfuscation neutralization.
- **`emitFindingAnnotation`, `rankSeverity`, `passesSeverityThreshold`** — GitHub Action helpers.

## Principles

- Zero runtime dependencies. ESM, TypeScript, target ES2022.
- MIT license. No telemetry. No network calls.
- Semver. Once a consumer ships against v1.0, the contract is frozen.

## License

MIT
