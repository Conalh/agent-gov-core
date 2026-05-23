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

export type { WorkflowSummaryOptions } from './action.js';
export {
  rankSeverity,
  passesSeverityThreshold,
  anyAtOrAbove,
  emitFindingAnnotation,
  generateWorkflowSummary,
} from './action.js';
