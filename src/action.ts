import type { Finding, Severity } from './finding.js';

const SEVERITY_RANK: Record<Severity, number> = {
  low: 1,
  medium: 2,
  high: 3,
  critical: 4,
};

/** Numeric rank: low=1, medium=2, high=3, critical=4. */
export function rankSeverity(severity: Severity): number {
  return SEVERITY_RANK[severity];
}

/**
 * `true` when `severity` is at least as severe as `threshold` — i.e. the run
 * should FAIL. Returns `false` (= pass) if `severity` is below threshold.
 */
export function passesSeverityThreshold(severity: Severity, threshold: Severity): boolean {
  return rankSeverity(severity) >= rankSeverity(threshold);
}

/**
 * Returns true if any finding meets or exceeds the threshold.
 */
export function anyAtOrAbove(findings: readonly Finding[], threshold: Severity): boolean {
  for (const f of findings) {
    if (passesSeverityThreshold(f.severity, threshold)) return true;
  }
  return false;
}

/**
 * Build a GitHub Actions workflow command line for a finding.
 *
 * `critical` and `high` map to `::error`; everything else maps to `::warning`.
 * `notice` is intentionally not used — surfacing low findings as `warning` makes
 * them visible in the Files Changed tab.
 *
 * @example
 * emitFindingAnnotation({
 *   tool: 'capability_echo',
 *   kind: 'capability_echo.workflow_permission_write',
 *   severity: 'high',
 *   message: 'Workflow grants contents: write to PR-triggered jobs.',
 *   location: { file: '.github/workflows/ci.yml', line: 12 },
 * });
 * // → '::error file=.github/workflows/ci.yml,line=12,title=[capability_echo.workflow_permission_write] high::Workflow grants contents: write to PR-triggered jobs.'
 */
export function emitFindingAnnotation(finding: Finding): string {
  const level = finding.severity === 'critical' || finding.severity === 'high'
    ? 'error'
    : 'warning';

  const params: string[] = [];
  if (finding.location?.file) params.push(`file=${escapeProperty(finding.location.file)}`);
  if (finding.location?.line != null) params.push(`line=${finding.location.line}`);
  if (finding.location?.column != null) params.push(`col=${finding.location.column}`);
  if (finding.location?.endLine != null) params.push(`endLine=${finding.location.endLine}`);
  if (finding.location?.endColumn != null) params.push(`endColumn=${finding.location.endColumn}`);
  params.push(`title=${escapeProperty(`[${finding.kind}] ${finding.severity}`)}`);

  const message = escapeData(finding.message);
  return `::${level} ${params.join(',')}::${message}`;
}

// per GitHub Actions docs
function escapeData(s: string): string {
  return s
    .replace(/%/g, '%25')
    .replace(/\r/g, '%0D')
    .replace(/\n/g, '%0A');
}

function escapeProperty(s: string): string {
  return s
    .replace(/%/g, '%25')
    .replace(/\r/g, '%0D')
    .replace(/\n/g, '%0A')
    .replace(/:/g, '%3A')
    .replace(/,/g, '%2C');
}

export interface WorkflowSummaryOptions {
  /** Top-level heading. Default: `Findings`. */
  title?: string;
  /** Cap per severity group; remaining count rendered as `(+N more)`. Default: 100. */
  perSeverityLimit?: number;
  /** Truncate message to this many characters (with `…` suffix). Default: 200. */
  messageMaxLength?: number;
}

/**
 * Render a Markdown summary of findings suitable for writing to
 * `$GITHUB_STEP_SUMMARY`. GitHub Actions caps inline annotations (~10 per
 * level, 50 per run) and silently drops the rest; the step summary has no
 * such cap, so a Markdown table guarantees that 100% of findings are visible
 * in the workflow's run summary page even when annotations are truncated.
 *
 * Findings are grouped by severity (critical → high → medium → low) inside
 * collapsible `<details>` blocks. Each row carries file, line, kind, and a
 * length-capped message. Pipe characters in message text are escaped so they
 * don't break Markdown table rendering.
 *
 * @example
 * import { generateWorkflowSummary } from 'agent-gov-core';
 * import { appendFileSync } from 'node:fs';
 *
 * const md = generateWorkflowSummary(findings, { title: 'CapabilityEcho findings' });
 * if (process.env.GITHUB_STEP_SUMMARY) {
 *   appendFileSync(process.env.GITHUB_STEP_SUMMARY, md);
 * }
 */
export function generateWorkflowSummary(
  findings: readonly Finding[],
  options: WorkflowSummaryOptions = {},
): string {
  const title = options.title ?? 'Findings';
  const perGroupLimit = options.perSeverityLimit ?? 100;
  const messageMax = options.messageMaxLength ?? 200;

  if (findings.length === 0) {
    return `# ${title}\n\nNo findings.\n`;
  }

  const groups: Record<Severity, Finding[]> = {
    critical: [],
    high: [],
    medium: [],
    low: [],
  };
  for (const f of findings) groups[f.severity].push(f);

  const counts: Record<Severity, number> = {
    critical: groups.critical.length,
    high: groups.high.length,
    medium: groups.medium.length,
    low: groups.low.length,
  };

  const lines: string[] = [];
  lines.push(`# ${title}`, '');
  lines.push(
    `**Total**: ${findings.length} finding${findings.length === 1 ? '' : 's'} — ` +
      `${counts.critical} critical, ${counts.high} high, ` +
      `${counts.medium} medium, ${counts.low} low`,
  );
  lines.push('');

  const severityOrder: Severity[] = ['critical', 'high', 'medium', 'low'];
  for (const severity of severityOrder) {
    const group = groups[severity];
    if (group.length === 0) continue;
    const shown = group.slice(0, perGroupLimit);
    const overflow = group.length - shown.length;

    lines.push(`<details${severity === 'critical' || severity === 'high' ? ' open' : ''}>`);
    lines.push(`<summary><strong>${group.length} ${severity}</strong></summary>`);
    lines.push('');
    lines.push('| File | Line | Kind | Message |');
    lines.push('|------|------|------|---------|');
    for (const f of shown) {
      lines.push(
        '| ' +
          [
            escapeMarkdownTableCell(f.location?.file ?? '—'),
            f.location?.line ?? '—',
            escapeMarkdownTableCell(f.kind),
            escapeMarkdownTableCell(truncate(f.message, messageMax)),
          ].join(' | ') +
          ' |',
      );
    }
    if (overflow > 0) {
      lines.push(`| _(+${overflow} more ${severity} finding${overflow === 1 ? '' : 's'})_ | | | |`);
    }
    lines.push('');
    lines.push('</details>');
    lines.push('');
  }

  return lines.join('\n');
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, Math.max(1, max - 1)) + '…';
}

function escapeMarkdownTableCell(s: string | number): string {
  // Escape HTML control characters so a finding message containing
  // `</summary>` or `<h1>` can't break out of the `<details>` block we
  // emit around each severity group. GitHub sanitizes script execution,
  // but unescaped tags still let an attacker manipulate the visual layout
  // of the workflow summary (collapse other groups, inject misleading
  // headings, etc.).
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\|/g, '\\|')
    .replace(/\r?\n/g, ' ');
}
