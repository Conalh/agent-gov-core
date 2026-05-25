/**
 * Transcript-parser entry point for the agent-gov-core suite.
 *
 * Pulls together the per-runtime parsers (Claude Code / Cursor / Codex)
 * plus shared helpers under one barrel. Consumers should import from the
 * top-level package (`agent-gov-core`); this module exists so the parser
 * subtree can be reorganized later without churning consumer imports.
 */

export { parseTranscriptDir } from './parse-transcript-dir.js';

export {
  detectAnthropicRuntime,
  parseAnthropicLine,
} from './claude-code.js';

export {
  isCodexLine,
  isCodexSessionMeta,
  parseCodexLine,
} from './codex.js';

export {
  isAntigravityLine,
  parseAntigravityLine,
} from './antigravity.js';

export {
  coerceTimestamp,
  extractExitCode,
  extractTextFromBlocks,
  extractToolResultText,
  interpolateTimestamps,
  isRecord,
} from './util.js';
