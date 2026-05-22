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
