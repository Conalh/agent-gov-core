import { createHash } from 'node:crypto';

export type Severity = 'low' | 'medium' | 'high' | 'critical';

/**
 * Closed set of tool identifiers in the AI-agent governance suite. Adding a new
 * tool requires updating this union, {@link TOOL_KINDS}, the `tool` enum in
 * `schemas/finding.schema.json`, and the `kind` pattern regex in both this file
 * and the schema — they are kept in lockstep by the test suite.
 */
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
  /**
   * Optional discriminator that participates in the fingerprint hash. Set this
   * when a single (kind, file, line) site can legitimately host multiple distinct
   * findings — e.g. two suspicious imports on the same line, two MCP servers in
   * the same JSON object, two npm dependencies declared in one package.json line.
   * Without it, the meta-reviewer would dedupe them into one. Use a stable value
   * that doesn't drift across reruns (package name, server name, rule id) — not
   * a timestamp or counter.
   */
  salientKey?: string;
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

/** Constructor spec for {@link createFinding}. */
export interface CreateFindingSpec {
  tool: ToolKind;
  /** Slug appended to `tool` to form `kind`. Must match `[a-z0-9_]+`. */
  name: string;
  severity: Severity;
  message: string;
  detail?: string;
  location?: FindingLocation;
  data?: Record<string, unknown>;
  /**
   * See {@link Finding.salientKey}. Pass when the same (kind, file, line) site
   * can produce multiple distinct findings that must not collapse to one
   * fingerprint.
   */
  salientKey?: string;
  /** Optional explicit fingerprint. If omitted, {@link fingerprintFinding} is computed. */
  fingerprint?: string;
}

/**
 * Convenience constructor that assembles a {@link Finding} with a validated
 * namespaced `kind` and a deterministic fingerprint. Equivalent to building the
 * object literal by hand plus calling {@link kind} and {@link fingerprintFinding}.
 *
 * @example
 * const f = createFinding({
 *   tool: 'scope_trail',
 *   name: 'permission_allow_widened',
 *   severity: 'high',
 *   message: 'Claude Code allow rule widened to Bash(npm *)',
 *   location: { file: '.claude/settings.json', line: 12 },
 * });
 * // f.kind === 'scope_trail.permission_allow_widened'
 * // f.fingerprint === '<stable hex>'
 */
export function createFinding(spec: CreateFindingSpec): Finding {
  const finding: Finding = {
    tool: spec.tool,
    kind: kind(spec.tool, spec.name),
    severity: spec.severity,
    message: spec.message,
  };
  if (spec.detail !== undefined) finding.detail = spec.detail;
  if (spec.location !== undefined) finding.location = spec.location;
  if (spec.salientKey !== undefined) finding.salientKey = spec.salientKey;
  if (spec.data !== undefined) finding.data = spec.data;
  finding.fingerprint = spec.fingerprint ?? fingerprintFinding(finding);
  return finding;
}

/**
 * Stable 16-character hex fingerprint for a finding, derived from its routing
 * fields (`kind`, `location.file`, `location.line`, `location.column`). Two
 * findings emitted by the same tool against the same site collapse to the same
 * fingerprint, so a downstream meta-reviewer can dedupe across runs.
 *
 * The fingerprint deliberately ignores `message`, `detail`, and `data` — those
 * fields can drift across versions without changing the underlying issue.
 *
 * @example
 * fingerprintFinding({
 *   tool: 'task_bound',
 *   kind: 'task_bound.out_of_scope_file',
 *   severity: 'medium',
 *   message: 'Touched file outside stated task',
 *   location: { file: 'src/index.ts', line: 42 },
 * });
 * // → '7e1c9b3a4d8f6e02'
 */
export function fingerprintFinding(finding: Finding): string {
  // Normalize backslash → forward-slash so a finding emitted on Windows
  // (`src\index.ts`) collapses to the same fingerprint as the same finding
  // on Linux CI (`src/index.ts`). Consumer git-diff layers usually normalize
  // already, but the library can't trust that — defensive normalization at
  // the hash boundary keeps cross-platform dedupe correct.
  const fileNormalized = finding.location?.file?.replace(/\\/g, '/') ?? '';
  const parts = [
    finding.kind,
    fileNormalized,
    finding.location?.line ?? '',
    finding.location?.column ?? '',
    // salientKey lets multiple distinct findings at the same (kind, file, line)
    // site keep separate fingerprints. Empty string when absent so the hash
    // shape is stable across findings that don't need a discriminator.
    finding.salientKey ?? '',
  ];
  return createHash('sha256').update(parts.join('|')).digest('hex').slice(0, 16);
}

export interface FindingValidationResult {
  ok: boolean;
  errors: string[];
}

const FINDING_ALLOWED_KEYS = new Set([
  'tool',
  'kind',
  'severity',
  'message',
  'detail',
  'location',
  'fingerprint',
  'salientKey',
  'data',
]);

const LOCATION_ALLOWED_KEYS = new Set(['file', 'line', 'column', 'endLine', 'endColumn']);

/**
 * Runtime check that a value conforms to the canonical Finding schema
 * (`schemas/finding.schema.json`). Returns the first error per offending
 * field rather than throwing — meta-reviewers can collect errors across a
 * batch and report them in aggregate.
 *
 * @example
 * const result = validateFinding(jsonFromDisk);
 * if (!result.ok) console.error(result.errors.join('\n'));
 */
export function validateFinding(value: unknown): FindingValidationResult {
  const errors: string[] = [];
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return { ok: false, errors: ['finding must be a plain object'] };
  }
  const v = value as Record<string, unknown>;

  if (!isToolKind(v.tool)) errors.push(`tool must be one of: ${TOOL_KINDS.join(', ')}`);
  if (!isNamespacedKind(v.kind)) errors.push("kind must match '<tool>.<slug>' (e.g. 'scope_trail.permission_allow_widened')");
  if (!isSeverity(v.severity)) errors.push(`severity must be one of: ${SEVERITIES.join(', ')}`);
  if (typeof v.message !== 'string' || v.message.length === 0) errors.push('message must be a non-empty string');

  if (isToolKind(v.tool) && isNamespacedKind(v.kind) && !v.kind.startsWith(`${v.tool}.`)) {
    errors.push(`kind '${v.kind}' must start with tool '${v.tool}.'`);
  }

  if (v.detail !== undefined && typeof v.detail !== 'string') {
    errors.push('detail must be a string when present');
  }
  if (v.fingerprint !== undefined && typeof v.fingerprint !== 'string') {
    errors.push('fingerprint must be a string when present');
  }
  if (v.salientKey !== undefined && typeof v.salientKey !== 'string') {
    errors.push('salientKey must be a string when present');
  }
  if (v.data !== undefined && (v.data === null || typeof v.data !== 'object' || Array.isArray(v.data))) {
    errors.push('data must be an object when present');
  }
  if (v.location !== undefined) {
    errors.push(...validateLocation(v.location));
  }

  for (const key of Object.keys(v)) {
    if (!FINDING_ALLOWED_KEYS.has(key)) errors.push(`unknown property: ${key}`);
  }

  return { ok: errors.length === 0, errors };
}

function validateLocation(value: unknown): string[] {
  const errors: string[] = [];
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return ['location must be an object when present'];
  }
  const loc = value as Record<string, unknown>;
  if (typeof loc.file !== 'string' || loc.file.length === 0) {
    errors.push('location.file must be a non-empty string');
  }
  for (const field of ['line', 'column', 'endLine', 'endColumn'] as const) {
    if (loc[field] !== undefined) {
      const n = loc[field];
      if (typeof n !== 'number' || !Number.isInteger(n) || n < 1) {
        errors.push(`location.${field} must be a positive integer when present`);
      }
    }
  }
  for (const key of Object.keys(loc)) {
    if (!LOCATION_ALLOWED_KEYS.has(key)) errors.push(`unknown location property: ${key}`);
  }
  return errors;
}
