# Contributing to agent-gov-core

agent-gov-core is the substrate library for five AI-agent governance tools — [ScopeTrail](https://github.com/Conalh/ScopeTrail), [PolicyMesh](https://github.com/Conalh/PolicyMesh), [CapabilityEcho](https://github.com/Conalh/CapabilityEcho), [TaskBound](https://github.com/Conalh/TaskBound), and [SessionTrail](https://github.com/Conalh/SessionTrail). Each of those tools depends on this package via a pinned GitHub ref (and, after npm publish, the `agent-gov-core` package on npm).

That means: **every change here ships into five downstream tools**. The contribution rules below exist to make that safe.

## Local development

```sh
npm install
npm run build
npm test
```

- `npm run build` runs `tsc -p tsconfig.json` and emits to `dist/`.
- `npm test` runs the full test suite against the built `dist/`. Tests import from `../dist/index.js` (not from `src/`), so anything broken in the build will fail tests too.
- The CI matrix runs Node 20, 22, and 24. Use any of them locally; if you need to test against a specific version, use `nvm use 24`.

The `prepare` script also runs `npm run build`, so anyone who installs this package from GitHub (e.g. `github:Conalh/agent-gov-core#v0.3.1`) automatically gets a fresh `dist/` without committing it. This is why `dist/` is `.gitignore`d in this repo — it's a build artifact, not source — but the *consumer* repos (ScopeTrail, etc.) **do** commit their own `dist/` because their CI and Action runtimes read from it directly.

## Adding a new detector / helper

1. **Decide where it goes.** Group by domain:
   - `src/finding.ts` — anything that produces or operates on Findings
   - `src/jsonc.ts`, `src/toml.ts` — config file readers
   - `src/locators.ts` — converting parsed positions back to source lines/ranges
   - `src/mcp.ts` — MCP command identity / normalization
   - `src/shell.ts` — quote-aware shell tokenization and deobfuscation
   - `src/action.ts` — GitHub Action helpers (severity threshold, annotation rendering)
   - `src/test-utils.ts` — fixtures consumers use in their test suites (secondary entry point: `agent-gov-core/test-utils`)

2. **Write tests first.** Every test file lives in `test/<module>.test.mjs` and imports from `../dist/...`. Add cases for the happy path, edge cases, and at least one negative case (e.g. `validateFinding` rejecting malformed input).

3. **Update `src/index.ts`** to export new symbols. Type-only exports use `export type { ... }`; runtime exports use `export { ... }`. Don't re-export internal helpers — keep the public surface minimal.

4. **Update `README.md`** under the right section. The README is the package's npm landing page, so every export should be listed there with a one-line description.

5. **Add JSDoc with at least one `@example` block** for any non-trivial function. Consumers see this hover preview in their IDE — it's a much better doc surface than the README.

## Backwards compatibility

Until v1.0, **minor versions may include breaking changes** — but we still avoid them when possible. Rules of thumb:

- **Additive changes** (new exports, new optional parameters, new JSDoc) → patch or minor bump.
- **Renamed types or functions** → minor bump until v1.0, major after.
- **Removed exports** → minor bump until v1.0, major after. Prefer additive deprecation: keep the old export, add the new one, mark the old with `@deprecated`.
- **Changed Finding schema** (the canonical contract at `schemas/finding.schema.json`) → always coordinated across all five consumers in a single batch; never silent.

If you're not sure whether something is breaking, ask in an issue before sending the PR.

## The Finding schema is the contract

The canonical Finding shape is defined in two places that must stay in sync:

- TypeScript: `src/finding.ts` (the `Finding` interface and the `ToolKind` union)
- JSON Schema: `schemas/finding.schema.json` (used by the future cross-tool meta-reviewer)

If you change one, change the other in the same PR. The test suite has a check (`test/finding.test.mjs` → "JSON Schema is valid JSON with expected enums") that verifies the enums match — so a divergence will fail CI, not silently ship.

The `kind` field pattern (`^(scope_trail|policy_mesh|capability_echo|task_bound|session_trail)\.[a-z0-9_]+$`) is hard-coded in three places: the schema, the `kind()` helper in `src/finding.ts`, and the `isNamespacedKind()` regex constant. Adding a sixth tool means updating all three.

## Releasing

1. Bump `package.json` `"version"`.
2. Run `npm test` — must pass.
3. Update `README.md` if the public surface changed.
4. Commit: `v0.X.Y: <one-line summary>`.
5. Tag: `git tag v0.X.Y`.
6. Push: `git push origin main && git push origin v0.X.Y`.
7. Create a GitHub release using `gh release create v0.X.Y --title "v0.X.Y" --notes "..."`. List new exports and link any schema changes.
8. (Once published to npm) `npm publish` from the same commit that's tagged.

## Cross-tool dogfooding

Each of the five consumer tools runs itself on its own PRs ("self-dogfood"). agent-gov-core doesn't currently run any of them on its own PRs because the consumers depend on this package — circular. But every consumer that pins to a new agent-gov-core release will detect regressions in their own CI within a day, which is the integration test.

If you change a parser, locator, or shell-tokenization rule, expect to see consumer CI shifts. The right response is usually:
1. Open an issue on this repo describing the change.
2. Open PRs on each affected consumer that need test updates.
3. Land them in a batch alongside the agent-gov-core release.

## What does NOT belong here

- **Per-tool detector logic.** If a rule only matters for one tool (e.g. "ScopeTrail flags missing `.env` deny rules"), it lives in that tool, not here.
- **Network calls.** This library has zero runtime dependencies and zero outbound network. The consumers handle their own optional LLM calls; agent-gov-core stays inert.
- **Anthropic/OpenAI/transport SDKs.** Same reason — no network, no transitive deps.
- **Markdown rendering, CLI argument parsing, output formatting.** Each tool owns its own UX. agent-gov-core gives them the parsed data; what they do with it is their problem.
