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

/**
 * Build a namespaced finding kind like `scope_trail.permission_allow_widened`
 * without hand-assembling the dotted string. The `name` slug must match
 * `[a-z0-9_]+` — the same pattern the JSON schema enforces.
 *
 * @throws if `name` contains characters outside the allowed slug class.
 */
export function kind<T extends ToolKind>(tool: T, name: string): `${T}.${string}` {
  if (!/^[a-z0-9_]+$/.test(name)) {
    throw new Error(
      `agent-gov-core/kind: name '${name}' must match [a-z0-9_]+ (kebab, camelCase, and dots are rejected)`,
    );
  }
  return `${tool}.${name}` as `${T}.${string}`;
}

const KIND_PATTERN = /^(scope_trail|policy_mesh|capability_echo|task_bound|session_trail)\.[a-z0-9_]+$/;

/**
 * Runtime guard matching the JSON schema's `kind` pattern. Useful for
 * tools that want to assert their finding constructors produce valid
 * namespaced kinds before emit.
 */
export function isNamespacedKind(value: unknown): value is `${ToolKind}.${string}` {
  return typeof value === 'string' && KIND_PATTERN.test(value);
}
