export type Severity = 'low' | 'medium' | 'high' | 'critical';

export type ToolKind =
  | 'scope_trail'
  | 'policy_mesh'
  | 'capability_echo'
  | 'task_bound'
  | 'session_trail';

export interface FindingLocation {
  file: string;
  line?: number;
  column?: number;
  endLine?: number;
  endColumn?: number;
}

export interface Finding {
  /** Originating tool. */
  tool: ToolKind;
  /** Namespaced kind: `<tool_kind>.<short_slug>` (e.g. `scope_trail.permission_allow_widened`). */
  kind: string;
  severity: Severity;
  /** Human-readable headline. Single line. */
  message: string;
  /** Optional longer-form explanation; can be multi-line. */
  detail?: string;
  location?: FindingLocation;
  /** Stable identifier for dedupe across runs. Recommended: hash of (kind, location, salient fields). */
  fingerprint?: string;
  /** Optional structured metadata; downstream meta-reviewers may inspect it. */
  data?: Record<string, unknown>;
}

export const SEVERITIES: readonly Severity[] = ['low', 'medium', 'high', 'critical'];

export const TOOL_KINDS: readonly ToolKind[] = [
  'scope_trail',
  'policy_mesh',
  'capability_echo',
  'task_bound',
  'session_trail',
];

export function isSeverity(value: unknown): value is Severity {
  return typeof value === 'string' && (SEVERITIES as readonly string[]).includes(value);
}

export function isToolKind(value: unknown): value is ToolKind {
  return typeof value === 'string' && (TOOL_KINDS as readonly string[]).includes(value);
}
