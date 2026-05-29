export type {
  Finding,
  FindingLocation,
  Severity,
  ToolKind,
  CreateFindingSpec,
  FindingValidationResult,
} from './finding.js';
export {
  SEVERITIES,
  TOOL_KINDS,
  isSeverity,
  isToolKind,
  isNamespacedKind,
  kind,
  createFinding,
  fingerprintFinding,
  validateFinding,
} from './finding.js';

export type { JsonObjectWithSource } from './jsonc.js';
export { readJsonObjectWithSource, stripJsonComments } from './jsonc.js';

export type { TomlObjectWithSource } from './toml.js';
export { readTomlObject, parseToml } from './toml.js';

export { ConfigParseError, lineColumnOfOffset } from './parse-error.js';

export type { Report, CreateReportSpec, ReportValidationResult } from './report.js';
export {
  REPORT_SCHEMA_VERSION,
  createReport,
  maxSeverity,
  validateReport,
} from './report.js';

export type {
  MergeOptions,
  MergeSource,
  InvalidReport,
  InvalidFinding,
  MergedReport,
} from './merge.js';
export { mergeFindings, validateMergedReport } from './merge.js';

export type { SecretMatch, MatchSecretOptions } from './secrets.js';
export { matchSecret, SECRET_PATTERNS } from './secrets.js';

export type { Exception, ApplyExceptionsResult } from './exceptions.js';
export { applyExceptions, validateException } from './exceptions.js';

export type { ByteRange } from './locators.js';
export {
  lineOfJsonKey,
  lineOfJsonStringValue,
  lineOfTomlKey,
} from './locators.js';

export type { McpCommandSpec } from './mcp.js';
export { normalizeMcpCommand } from './mcp.js';

export { tokenizeShell, tokenizeShellDeep, getCommandHead } from './shell.js';

// v1.3.0 — shared diff-input safety guards (git-ref validation, path
// containment, byte caps). Promoted out of ScopeTrail/TaskBound and applied
// across every detector that ingests an untrusted diff.
export {
  isValidGitRef,
  resolveWithinRoot,
  withinByteCap,
  DEFAULT_MAX_INPUT_BYTES,
} from './diff-inputs.js';

export type { WorkflowSummaryOptions } from './action.js';
export {
  rankSeverity,
  passesSeverityThreshold,
  anyAtOrAbove,
  emitFindingAnnotation,
  generateWorkflowSummary,
} from './action.js';

// v1.1.0 — transcript-event types + JSONL parsers (Claude Code, Cursor,
// Codex). Promoted out of vendored copies in AgentPulse v0.1–v0.4 and
// SessionTrail so every suite tool shares one parser surface.
export type {
  EventKind,
  ParseOptions,
  Runtime,
  TranscriptEvent,
} from './transcript-events.js';
export {
  // Top-level entry point.
  parseTranscriptDir,
  // Per-runtime parsers (exposed for callers that already hold a parsed line).
  detectAnthropicRuntime,
  parseAnthropicLine,
  isCodexLine,
  isCodexSessionMeta,
  parseCodexLine,
  isAntigravityLine,
  parseAntigravityLine,
  // Helpers shared across runtimes.
  coerceTimestamp,
  extractExitCode,
  extractTextFromBlocks,
  extractToolResultText,
  interpolateTimestamps,
  isRecord,
} from './parsers/index.js';
