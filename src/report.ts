import {
  type Finding,
  type Severity,
  type ToolKind,
  SEVERITIES,
  TOOL_KINDS,
  isSeverity,
  isToolKind,
  validateFinding,
} from './finding.js';

/** Canonical envelope version. */
export const REPORT_SCHEMA_VERSION = '1.0' as const;

/**
 * Canonical multi-tool report envelope. Wraps `Finding[]` with provenance,
 * rating, and optional tool-specific extension data so a cross-tool
 * meta-reviewer can ingest reports from N tools through one shape.
 */
export interface Report {
  schemaVersion: typeof REPORT_SCHEMA_VERSION;
  tool: ToolKind;
  toolVersion?: string;
  runId?: string;
  /**
   * Identifier for the agent session, PR review, or thread this run belongs to.
   * Distinct from `runId` (which identifies *this* tool run): one conversation
   * can produce many runs. Matches OpenTelemetry's `gen_ai.conversation.id`
   * semantic convention — if a consumer also emits OTel traces about the same
   * agent session, pass the same string here and downstream tooling can cross-
   * reference governance findings with the traces.
   *
   * @see https://opentelemetry.io/docs/specs/semconv/gen-ai/
   */
  conversationId?: string;
  baseRef?: string;
  headRef?: string;
  /** Aggregate severity. `'none'` iff findings is empty or all below threshold. */
  rating: 'none' | Severity;
  findings: Finding[];
  /** Tool-specific extension data (PolicyMesh `effectiveUnion`, CapabilityEcho `surfaceSummary`, etc). */
  data?: Record<string, unknown>;
}

export interface CreateReportSpec {
  tool: ToolKind;
  toolVersion?: string;
  runId?: string;
  /** See {@link Report.conversationId}. */
  conversationId?: string;
  baseRef?: string;
  headRef?: string;
  findings: Finding[];
  data?: Record<string, unknown>;
  /**
   * Explicit rating override. When omitted, `rating` is computed as the
   * maximum severity across `findings` (or `'none'` if empty).
   */
  rating?: 'none' | Severity;
}

/**
 * Build a {@link Report} with `schemaVersion` set and `rating` derived from
 * the maximum finding severity (unless overridden). This is the recommended
 * way to produce a report — sets the envelope version correctly and computes
 * the rating consistently with other tools.
 *
 * @example
 * const report = createReport({
 *   tool: 'scope_trail',
 *   toolVersion: '0.1.18',
 *   baseRef: 'abc123',
 *   headRef: 'def456',
 *   findings: [finding1, finding2],
 *   data: { mcpServers: [...] },
 * });
 */
export function createReport(spec: CreateReportSpec): Report {
  const report: Report = {
    schemaVersion: REPORT_SCHEMA_VERSION,
    tool: spec.tool,
    rating: spec.rating ?? maxSeverity(spec.findings),
    findings: spec.findings,
  };
  if (spec.toolVersion !== undefined) report.toolVersion = spec.toolVersion;
  if (spec.runId !== undefined) report.runId = spec.runId;
  if (spec.conversationId !== undefined) report.conversationId = spec.conversationId;
  if (spec.baseRef !== undefined) report.baseRef = spec.baseRef;
  if (spec.headRef !== undefined) report.headRef = spec.headRef;
  if (spec.data !== undefined) report.data = spec.data;
  return report;
}

/**
 * Maximum severity across a finding list. Returns `'none'` for empty input.
 * Used by {@link createReport} when no explicit rating is supplied.
 */
export function maxSeverity(findings: readonly Finding[]): 'none' | Severity {
  let best: 'none' | Severity = 'none';
  for (const f of findings) {
    if (severityRank(f.severity) > severityRank(best)) best = f.severity;
  }
  return best;
}

function severityRank(s: 'none' | Severity): number {
  if (s === 'none') return 0;
  if (s === 'low') return 1;
  if (s === 'medium') return 2;
  if (s === 'high') return 3;
  return 4;
}

export interface ReportValidationResult {
  ok: boolean;
  errors: string[];
}

const REPORT_ALLOWED_KEYS = new Set([
  'schemaVersion',
  'tool',
  'toolVersion',
  'runId',
  'conversationId',
  'baseRef',
  'headRef',
  'rating',
  'findings',
  'data',
]);

const RATING_VALUES = new Set(['none', ...SEVERITIES]);

/**
 * Runtime check that a value conforms to the canonical Report envelope.
 * Aggregates errors across all findings — a single malformed finding does
 * not short-circuit the rest of the envelope check.
 *
 * @example
 * const result = validateReport(JSON.parse(reportJson));
 * if (!result.ok) console.error(result.errors.join('\n'));
 */
export function validateReport(value: unknown): ReportValidationResult {
  const errors: string[] = [];
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return { ok: false, errors: ['report must be a plain object'] };
  }
  const v = value as Record<string, unknown>;

  if (v.schemaVersion !== REPORT_SCHEMA_VERSION) {
    errors.push(`schemaVersion must be '${REPORT_SCHEMA_VERSION}'`);
  }
  if (!isToolKind(v.tool)) {
    errors.push(`tool must be one of: ${TOOL_KINDS.join(', ')}`);
  }
  if (typeof v.rating !== 'string' || !RATING_VALUES.has(v.rating)) {
    errors.push(`rating must be one of: none, ${SEVERITIES.join(', ')}`);
  }
  if (!Array.isArray(v.findings)) {
    errors.push('findings must be an array');
  } else {
    for (let i = 0; i < v.findings.length; i++) {
      const f = validateFinding(v.findings[i]);
      if (!f.ok) {
        errors.push(`findings[${i}]: ${f.errors.join('; ')}`);
      } else if (isToolKind(v.tool) && (v.findings[i] as Finding).tool !== v.tool) {
        errors.push(
          `findings[${i}].tool ('${(v.findings[i] as Finding).tool}') does not match report.tool ('${v.tool}')`,
        );
      }
    }
  }

  if (v.toolVersion !== undefined && typeof v.toolVersion !== 'string') {
    errors.push('toolVersion must be a string when present');
  }
  if (v.runId !== undefined && typeof v.runId !== 'string') {
    errors.push('runId must be a string when present');
  }
  if (v.conversationId !== undefined && typeof v.conversationId !== 'string') {
    errors.push('conversationId must be a string when present');
  }
  if (v.baseRef !== undefined && typeof v.baseRef !== 'string') {
    errors.push('baseRef must be a string when present');
  }
  if (v.headRef !== undefined && typeof v.headRef !== 'string') {
    errors.push('headRef must be a string when present');
  }
  if (v.data !== undefined && (v.data === null || typeof v.data !== 'object' || Array.isArray(v.data))) {
    errors.push('data must be an object when present');
  }

  for (const key of Object.keys(v)) {
    if (!REPORT_ALLOWED_KEYS.has(key)) errors.push(`unknown property: ${key}`);
  }

  // Cross-field consistency: rating should be at or above the max finding severity.
  // We don't *enforce* this strictly (a tool may downgrade by policy) but flag a
  // genuine inconsistency where the rating is BELOW what the findings imply.
  if (
    Array.isArray(v.findings) &&
    typeof v.rating === 'string' &&
    RATING_VALUES.has(v.rating)
  ) {
    const findingsOk = (v.findings as unknown[]).every((f) => validateFinding(f).ok);
    if (findingsOk) {
      const implied = maxSeverity(v.findings as Finding[]);
      if (severityRank(v.rating as Severity | 'none') < severityRank(implied)) {
        errors.push(
          `rating '${v.rating}' is below the maximum finding severity '${implied}'`,
        );
      }
    }
  }

  // Ensure isSeverity-style check on rating when not 'none' for callers that
  // need a tighter type than the wider RATING_VALUES set.
  void isSeverity;

  return { ok: errors.length === 0, errors };
}
