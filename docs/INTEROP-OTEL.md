# Interop: OpenTelemetry GenAI Semantic Conventions

`agent-gov-core` and the [OpenTelemetry GenAI semantic conventions](https://opentelemetry.io/docs/specs/semconv/gen-ai/) solve adjacent problems:

| | OpenTelemetry GenAI | agent-gov-core |
|---|---|---|
| **Domain** | Runtime trace observability | Static-analysis governance findings |
| **Question answered** | What did the agent do? | What's wrong with what the agent did (or might do)? |
| **Unit of work** | Span / trace | Finding / Report |
| **Lifetime** | Real-time, ephemeral | Persisted, reviewable in PR |
| **Audience** | SREs, on-call engineers | Code reviewers, security teams |

They're complementary. A team running OTel-instrumented agents can pair runtime traces with governance findings against the same conversation, then correlate by ID across the two systems.

## Recommended cross-walk

| OpenTelemetry `gen_ai.*` attribute | agent-gov-core field | Notes |
|---|---|---|
| `gen_ai.conversation.id` | `Report.conversationId` | Same string — pass through directly. v0.6.0 added `conversationId` as an optional `Report` field for this purpose. |
| `gen_ai.agent.name` | `Report.tool` | Loose match — OTel's "agent name" is whatever the application calls it. Our `tool` is one of five governance tools. If a consumer emits both, the OTel agent name is the *subject*, our tool is the *reviewer*. |
| `gen_ai.workflow.name` | `MergedReport` (no field today) | When `mergeFindings` rolls up N tool reports for one PR/conversation, that's structurally a workflow. We don't carry a workflow name field yet — a future `MergedReport.workflowName` could match. |
| `gen_ai.operation.name` | n/a | OTel has `create_agent`, `invoke_agent`, `invoke_workflow`. We're not a tracer; we don't emit operation spans. |
| `error.type` | `ConfigParseError.name` / Finding `data.errorType` | OTel's `error.type` is stable across all of OTel and stays the right field name for any error class identifier we surface to observability consumers. |
| `gen_ai.tool.definitions` | The data ScopeTrail / PolicyMesh *parse from* `.mcp.json` etc. | We extract this; OTel emits it as a span attribute. Same content, different transport. |
| `gen_ai.usage.*tokens` | n/a | Runtime telemetry, not governance. |
| `gen_ai.input.messages` / `gen_ai.output.messages` | n/a | Runtime telemetry. SessionTrail reviews *transcripts*, not active message streams. |

## Why we don't adopt the OTel namespace ourselves

1. **Different shape.** OTel attributes are flat key-value pairs on a span. Our `Finding` is a structured object with severity, location, and a namespaced `kind`. Forcing one onto the other loses information either way.
2. **Different stability lifecycle.** OTel GenAI attributes are marked `Development` (their pre-stable tier) and may still churn. Our schema needs to freeze at v1.0 with explicit semver guarantees for consumer tools.
3. **Different validation contract.** OTel attributes are "best effort, observability tools must tolerate missing fields." Our schema is strict (`additionalProperties: false`) because consumer detectors depend on field presence.

`Report.conversationId` is the one bridge field — same string on both sides, no transform, opt-in.

## How to bridge in practice

```ts
// In a consumer tool that also emits OTel traces:
import { trace } from '@opentelemetry/api';
import { createReport, mergeFindings } from 'agent-gov-core';

const span = trace.getActiveSpan();
const conversationId = span?.spanContext().traceState?.get('conversation.id');

const report = createReport({
  tool: 'scope_trail',
  conversationId,           // ← OTel's gen_ai.conversation.id, same value
  findings: collectedFindings,
});
```

Now an observability backend correlating by `conversation.id` can pull both the OTel traces (what the agent did) and the governance report (what was risky about it) for the same agent session.

## Future considerations

- **`MergedReport.workflowName`** — would map to `gen_ai.workflow.name`. Useful when the meta-reviewer is invoked across multiple tool runs that share a workflow context (e.g. a multi-PR review).
- **OTel span emission from the meta-reviewer** — `mergeFindings` could optionally emit a span with `gen_ai.operation.name = "review_workflow"` and findings as span events. Held for v1.x — current `mergeFindings` deliberately has no observability dependencies.

## References

- [OpenTelemetry GenAI semantic conventions](https://opentelemetry.io/docs/specs/semconv/gen-ai/)
- [Agent spans specifically](https://opentelemetry.io/docs/specs/semconv/gen-ai/gen-ai-agent-spans/)
- [`error.type` general convention](https://opentelemetry.io/docs/specs/semconv/attributes-registry/error/)
