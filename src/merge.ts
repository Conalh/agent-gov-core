import { type Finding, type Severity, type ToolKind, SEVERITIES, TOOL_KINDS, isToolKind, validateFinding } from './finding.js';
import { type Report, REPORT_SCHEMA_VERSION, maxSeverity } from './report.js';
import { rankSeverity } from './action.js';

export interface MergeOptions {
  /**
   * Lower bound for findings included in the merged output. Anything below
   * this severity is dropped from `findings` (but still counted in
   * `droppedBelowThreshold`). Defaults to `'low'` (include everything).
   */
  threshold?: Severity;
  /**
   * When two reports contribute findings with the same fingerprint, the
   * default keeps the one with the higher severity. Set this to `'first'`
   * to keep the first report's finding instead. Default: `'highest_severity'`.
   */
  duplicatePolicy?: 'highest_severity' | 'first';
}

export interface MergeSource {
  tool: ToolKind;
  toolVersion?: string;
  /** Conversation ID declared by this source, if any. */
  conversationId?: string;
  /** Number of findings in this source report (BEFORE dedup or threshold filtering). */
  findingCount: number;
  /** Aggregate rating reported by the source. */
  rating: 'none' | Severity;
}

export interface InvalidReport {
  /** Index into the input `reports` array. */
  index: number;
  /** Tool name from the malformed report, if recoverable. */
  tool?: ToolKind;
  errors: string[];
}

export interface InvalidFinding {
  /** Originating tool's report index. */
  reportIndex: number;
  /** Index of the finding within that report's `findings` array. */
  findingIndex: number;
  /** Tool name from the report. */
  tool: ToolKind;
  errors: string[];
}

export interface MergedReport {
  schemaVersion: '1.0';
  /** Per-tool provenance for the reports that fed into this merge. */
  sources: MergeSource[];
  /** Aggregate rating across all surviving findings. */
  rating: 'none' | Severity;
  /**
   * Conversation ID shared by all valid source reports — set iff every source
   * declared the same `conversationId`. When sources disagree (or some lack the
   * field), this is omitted so a meta-reviewer can detect cross-conversation
   * mixing.
   */
  conversationId?: string;
  /** Deduped findings, sorted by severity (highest first). */
  findings: Finding[];
  /** Count of findings dropped because their severity was below `threshold`. */
  droppedBelowThreshold: number;
  /** Count of finding pairs collapsed via fingerprint dedup. */
  duplicateCollapsed: number;
  /** Reports rejected by envelope validation. */
  invalidReports: InvalidReport[];
  /** Individual findings rejected by finding validation. */
  invalidFindings: InvalidFinding[];
  /** Severity counts across the surviving findings. */
  severityCounts: Record<Severity, number>;
}

/**
 * Merge N reports from different tools into one normalized report. Validates
 * each input report and each finding, deduplicates by fingerprint, applies an
 * optional severity threshold, and rolls up the aggregate rating.
 *
 * Invalid reports / findings are NOT silently dropped — they're collected in
 * `invalidReports` and `invalidFindings` so a meta-reviewer can surface them
 * to the user instead of letting bad data disappear.
 *
 * @example
 * import { readFileSync } from 'node:fs';
 * import { mergeFindings } from 'agent-gov-core';
 *
 * const reports = [
 *   JSON.parse(readFileSync('scopetrail-report.json', 'utf8')),
 *   JSON.parse(readFileSync('policymesh-report.json', 'utf8')),
 *   JSON.parse(readFileSync('capabilityecho-report.json', 'utf8')),
 * ];
 * const merged = mergeFindings(reports, { threshold: 'medium' });
 * console.log(`Merged rating: ${merged.rating}`);
 * console.log(`${merged.findings.length} unique findings across ${merged.sources.length} tools`);
 */
export function mergeFindings(reports: readonly unknown[], opts: MergeOptions = {}): MergedReport {
  const threshold: Severity = opts.threshold ?? 'low';
  const duplicatePolicy = opts.duplicatePolicy ?? 'highest_severity';
  const thresholdRank = rankSeverity(threshold);

  const sources: MergeSource[] = [];
  const invalidReports: InvalidReport[] = [];
  const invalidFindings: InvalidFinding[] = [];
  // fingerprint → Finding chosen so far
  const dedupe = new Map<string, Finding>();
  let droppedBelowThreshold = 0;
  let duplicateCollapsed = 0;

  for (let i = 0; i < reports.length; i++) {
    const candidate = reports[i];
    // Structural envelope check — does NOT recurse into individual findings.
    // A report with some malformed findings is still partially mergeable; we
    // collect the bad ones into `invalidFindings` and pass through the good
    // ones. Only a structurally broken envelope (wrong tool, missing array,
    // etc.) gets rejected wholesale.
    const envelope = validateReportEnvelope(candidate);
    if (!envelope.ok) {
      const tool = candidateTool(candidate);
      invalidReports.push({ index: i, tool, errors: envelope.errors });
      continue;
    }
    const report = candidate as Report;
    const source: MergeSource = {
      tool: report.tool,
      findingCount: report.findings.length,
      rating: report.rating,
    };
    if (report.toolVersion !== undefined) source.toolVersion = report.toolVersion;
    if (report.conversationId !== undefined) source.conversationId = report.conversationId;
    sources.push(source);

    for (let j = 0; j < report.findings.length; j++) {
      const finding = report.findings[j]!;
      const findingCheck = validateFinding(finding);
      if (!findingCheck.ok) {
        invalidFindings.push({
          reportIndex: i,
          findingIndex: j,
          tool: report.tool,
          errors: findingCheck.errors,
        });
        continue;
      }

      // Cross-check: a finding's tool must match the envelope's tool. Otherwise
      // the merge would attribute a foreign-tool finding to this report's
      // source provenance, breaking the meta-reviewer's audit trail.
      // validateReport enforces this strictly; the merge path was previously
      // more permissive — which let a forged report through.
      if (finding.tool !== report.tool) {
        invalidFindings.push({
          reportIndex: i,
          findingIndex: j,
          tool: report.tool,
          errors: [
            `finding.tool '${finding.tool}' does not match report.tool '${report.tool}'`,
          ],
        });
        continue;
      }

      if (rankSeverity(finding.severity) < thresholdRank) {
        droppedBelowThreshold++;
        continue;
      }

      // Dedupe by fingerprint. Fall back to the finding's structural identity
      // when fingerprint is missing — though by v0.5.0 it should always be
      // populated by `createFinding`.
      const key = finding.fingerprint ?? `${finding.kind}|${finding.location?.file ?? ''}|${finding.location?.line ?? ''}|${finding.salientKey ?? ''}`;
      const existing = dedupe.get(key);
      if (existing === undefined) {
        dedupe.set(key, finding);
        continue;
      }
      duplicateCollapsed++;
      if (duplicatePolicy === 'highest_severity') {
        if (rankSeverity(finding.severity) > rankSeverity(existing.severity)) {
          dedupe.set(key, finding);
        }
      }
      // 'first' policy: keep existing — do nothing
    }
  }

  const findings = Array.from(dedupe.values()).sort(
    (a, b) => rankSeverity(b.severity) - rankSeverity(a.severity),
  );
  const severityCounts: Record<Severity, number> = { low: 0, medium: 0, high: 0, critical: 0 };
  for (const f of findings) severityCounts[f.severity]++;

  // Propagate conversationId iff every source agrees. When sources disagree
  // or some lack the field, leave it undefined — silent unification of cross-
  // conversation reports would hide a meta-reviewer misuse.
  const conversationIds = sources.map((s) => s.conversationId);
  const allSame = conversationIds.length > 0
    && conversationIds.every((id) => id !== undefined && id === conversationIds[0]);

  const merged: MergedReport = {
    schemaVersion: '1.0',
    sources,
    rating: maxSeverity(findings),
    findings,
    droppedBelowThreshold,
    duplicateCollapsed,
    invalidReports,
    invalidFindings,
    severityCounts,
  };
  if (allSame) merged.conversationId = conversationIds[0];
  return merged;
}

function candidateTool(value: unknown): ToolKind | undefined {
  if (value === null || typeof value !== 'object') return undefined;
  const t = (value as { tool?: unknown }).tool;
  // Defer to isToolKind from finding.ts — the single source of truth for the
  // ToolKind enum. Avoids a hardcoded regex drifting from the TS union, the
  // schema, and TOOL_KINDS.
  return isToolKind(t) ? t : undefined;
}

/**
 * Envelope-only structural check. Unlike `validateReport`, this does NOT
 * recurse into individual findings — that's done separately by mergeFindings
 * so a single bad finding doesn't poison the rest of the report.
 */
function validateReportEnvelope(value: unknown): { ok: boolean; errors: string[] } {
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
  const ratingValues = new Set(['none', ...SEVERITIES]);
  if (typeof v.rating !== 'string' || !ratingValues.has(v.rating)) {
    errors.push(`rating must be one of: none, ${SEVERITIES.join(', ')}`);
  }
  if (!Array.isArray(v.findings)) {
    errors.push('findings must be an array');
  }
  return { ok: errors.length === 0, errors };
}
