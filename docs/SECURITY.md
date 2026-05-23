# Security

This document describes the threat model `agent-gov-core` is designed against, what it deliberately does **not** protect against, and how to report a finding.

The substrate consumes a lot of untrusted input — JSON/TOML config bodies, shell command text, environment values — and runs regex evaluators over that input. The first edition of this document focuses on that surface. Other surfaces (denial of service via parser nesting, secret exfiltration through error messages) get short sections at the end.

## Regex evaluation on untrusted input

### What we protect against

All regex patterns shipped in the library are constructed to evaluate in **linear time** on any input. Specifically:

- **No nested quantifiers over overlapping character classes** — the classic ReDoS shape `(a+)+` or `(a|a)+` does not appear anywhere in `src/`.
- **Disjoint alternation** — every `(x|y|z)` group in the library has branches that are mutually exclusive at the first character (`(sudo|nohup|env|…)`, `(?:sk|rk)_(?:live|test)_…`, `("bare"|"quoted"|'literal')`), so the engine commits early and does not backtrack between branches.
- **Anchored where possible** — patterns that scan input from the start use `^`, so the regex engine does not retry from each position.
- **Library-defined, not user-supplied** — unlike tools that ship a heuristic ReDoS detector for arbitrary user regexes (e.g. [SessionTrail's `redos_pattern_in_workflow`](https://github.com/Conalh/session-trail)), this library never accepts a pattern from a caller. The patterns are constants compiled into the source tree, audited per release, and locked against regression by [`test/redos.test.mjs`](../test/redos.test.mjs).

The harness in `test/redos.test.mjs` exercises every regex evaluator that touches external input against ~100 KB of adversarial input shaped to trigger the worst backtracking path the pattern could exhibit (long benign, long near-miss, nested-quantifier-style). Each call must complete under a 50 ms wall-clock budget. The current worst case is the `bash -c` payload extractor at <10 ms — three orders of magnitude clear of catastrophic backtracking.

The audited regex evaluators are:

| File | Pattern family | Risk class |
|---|---|---|
| `src/secrets.ts` | 13 provider patterns (Anthropic, OpenAI, GitHub, AWS, Slack, Google, GitLab, npm, Docker, Stripe, hex token) | Safe by construction — fixed prefix + single quantifier over disjoint character class |
| `src/shell.ts` | Env-var assignment, wrapper detection (`sudo`, `nohup`, …), dash-`c` runner detection (`bash`, `python`, …) | Safe by construction — anchored, fixed alternation |
| `src/locators.ts` | TOML header regex, dynamically-built dotted-key regex, JSON key/value locators | Safe by construction — literal anchors separate every quantifier |
| `src/mcp.ts` | Windows executable suffix, trailing slash normalization | Safe by construction — single anchored quantifier |

### What we don't protect against

- **The `dottedKey` argument to `lineOfTomlKey` is treated as developer-supplied, not attacker-supplied.** If a consumer passes a 100 KB attacker-controlled string with embedded regex metacharacters as the `dottedKey`, the dynamic regex constructed from that key can exceed V8's regex-bytecode size limit and throw `SyntaxError` during construction. This is misuse, not a vulnerability: in every consumer of this library (ScopeTrail, PolicyMesh, CapabilityEcho, TaskBound, SessionTrail) the dotted-key search target is derived from the static finding schema, never from input. Callers who route untrusted text into the `dottedKey` parameter should length-cap it themselves before calling.
- **RE2 is not a runtime dependency.** The library uses Node's built-in regex engine (V8 Irregexp), which is a backtracking NFA. The safety claim above rests on every shipped pattern being structurally non-pathological, not on the engine refusing to backtrack. A future maintainer who introduces a vulnerable pattern would not be caught by the engine — they would be caught by `test/redos.test.mjs` failing in CI.
- **The SessionTrail user-supplied-pattern vector does not apply.** SessionTrail ships a detector that flags ReDoS-vulnerable shapes in *user-authored* workflow regexes (e.g. a GitHub Actions workflow that runs `grep -E "<user pattern>"`). `agent-gov-core` has no equivalent surface — there is no API by which a caller can hand the library a pattern to evaluate.

## Other surfaces

### Secret material in error messages

`matchSecret` returns only the provider name, never the literal credential. This contract is asserted in `test/secrets.test.mjs`. Consumers that surface findings to a logging system can do so without leaking the matched bytes.

`ConfigParseError` carries the original parser error in its `cause`. The original error may contain a snippet of the offending input — if that input held a credential, the credential is in the cause chain. Consumers logging structured findings should not log `error.cause` verbatim.

## Reporting a finding

Open a private security advisory at https://github.com/Conalh/agent-gov-core/security/advisories or email **conal.hg@gmail.com**. Please include:

- The version (e.g. `v0.8.0`) and the file/function involved.
- An input that demonstrates the issue, ideally as a failing test.
- For ReDoS reports specifically: the wall-clock time the input takes on your machine plus the input size, so the budget in `test/redos.test.mjs` can be calibrated.

Reports will be acknowledged within seven days. A patch release follows the same cadence as other security-relevant fixes (`v0.7.1`, `v0.8.x`) — small, targeted, separately tagged, with the affected versions documented in `CHANGELOG.md`.

The library is pre-1.0 and shipped under MIT with no warranty. Best-effort fixes only; no SLA.
