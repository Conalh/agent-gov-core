/**
 * Transcript-event types — shared substrate for AI-agent governance tools
 * that ingest Claude Code / Cursor / Codex transcript JSONL.
 *
 * Originally vendored inside AgentPulse v0.1–v0.4 (`src/types.ts` Layer 1)
 * and SessionTrail (`src/transcript.ts`). In agent-gov-core v1.1.0 these
 * types — together with the per-runtime parsers in `./parsers/` — become
 * the single source of truth, so downstream tools no longer carry
 * separate copies that drift out of sync.
 *
 * The types are intentionally narrow: they describe what came off disk,
 * not what any particular tool wants to do with it. Higher-level concerns
 * (windowing, enrichment, trajectory verdicts, drift detectors) belong in
 * the consuming tool.
 */

/**
 * Origin of a transcript line. `'unknown'` is reserved for the rare case
 * where a parser can't tell — by contract the parsers prefer concrete
 * runtimes, so callers rarely see `'unknown'` in practice.
 */
export type Runtime = 'claude-code' | 'cursor' | 'codex' | 'unknown';

/**
 * Discriminator for the canonical event shape. `'system'` is the catchall
 * for runtime metadata lines (session opens, codex `session_meta`, etc.)
 * — anything not a message and not a tool call.
 */
export type EventKind =
  | 'user_message'
  | 'assistant_message'
  | 'tool_use'
  | 'tool_result'
  | 'system';

/**
 * A single normalized event from any supported transcript format.
 * Cross-runtime fields are normalized; runtime-specific fields go in `raw`.
 */
export interface TranscriptEvent {
  /** Epoch milliseconds. If the transcript line had no timestamp, parser
   *  SHOULD interpolate from surrounding events; if it can't, set to 0 and
   *  the windowing layer will drop. */
  timestamp: number;
  runtime: Runtime;
  kind: EventKind;
  /** Plain-text content for user_message / assistant_message. */
  text?: string;
  /** Tool name for tool_use (e.g. 'Read', 'Bash', 'WebFetch'). */
  toolName?: string;
  /** Tool input arguments for tool_use. Shape varies by tool. */
  toolInput?: Record<string, unknown>;
  /** Tool result content for tool_result. */
  toolResultText?: string;
  /** Tool result exit code if shell-like (Bash). Undefined when N/A. */
  toolResultExitCode?: number;
  /** Per-message working directory if the runtime supplied it. */
  cwd?: string;
  /** Opaque tool-use ID linking tool_use → tool_result pairs. */
  toolUseId?: string;
  /** Original parsed object for debugging / runtime-specific consumers. */
  raw?: unknown;
}

/**
 * Options for {@link parseTranscriptDir} and the per-runtime parsers in
 * `./parsers/`.
 */
export interface ParseOptions {
  /** Filter to events at or after this epoch ms. */
  since?: number;
  /** Filter to events at or before this epoch ms. */
  until?: number;
  /** Suppress the "skipped N malformed lines" aggregate warning emitted to
   *  `console.warn`. Set this when the consumer is a TUI that controls the
   *  screen — stray writes there cause whole-window flicker. */
  silent?: boolean;
}
