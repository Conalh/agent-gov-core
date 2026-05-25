import type { TranscriptEvent } from '../transcript-events.js';
import { coerceTimestamp, isRecord } from './util.js';

export function isAntigravityLine(parsed: unknown): boolean {
  if (!isRecord(parsed)) return false;
  const line = parsed as Record<string, unknown>;
  return (
    typeof line.step_index === 'number' &&
    (line.source === 'USER_EXPLICIT' || line.source === 'MODEL' || line.source === 'SYSTEM')
  );
}

/**
 * Maps Antigravity tool names and result types to a shared slug.
 *
 * NOTE: Special-cases call-name vs result-type naming asymmetry. If new asymmetrical
 * tools are added in future Antigravity versions, they must be registered here.
 */
function linkageKey(name: string): string {
  const lower = name.toLowerCase().replace(/_/g, '').replace(/ /g, '');
  if (lower === 'listdirectory') return 'listdir';
  if (lower === 'viewfile') return 'viewfile';
  if (lower === 'runcommand') return 'runcommand';
  if (lower === 'writetofile') return 'writetofile';
  if (lower === 'replacefilecontent') return 'replacefilecontent';
  if (lower === 'multireplacefilecontent') return 'multireplacefilecontent';
  if (lower === 'grepsearch') return 'grepsearch';
  return lower;
}

function unwrapArgValue(v: unknown): unknown {
  if (typeof v !== 'string') return v;
  if (v.startsWith('"') && v.endsWith('"')) {
    try {
      return JSON.parse(v);
    } catch {
      return v;
    }
  }
  return v;
}

function unwrapArgs(args: unknown): Record<string, unknown> {
  if (!args) return {};
  let unwrapped = args;
  if (typeof args === 'string') {
    try {
      unwrapped = JSON.parse(args);
    } catch {
      return { raw: args };
    }
  }
  
  if (!isRecord(unwrapped)) return {};
  const record = unwrapped as Record<string, unknown>;
  const result: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(record)) {
    result[k] = unwrapArgValue(v);
  }

  // Normalize CommandLine to command key
  if (typeof result.CommandLine === 'string') {
    result.command = result.CommandLine;
  }

  return result;
}

export function extractExitCode(content: unknown, status: unknown): number | undefined {
  if (typeof content !== 'string') return undefined;

  // Match "exit code: N" or "exit_code: N" regardless of success/failure prefix
  const codeMatch = content.match(/exit[ _]code:\s*(-?\d+)/i);
  if (codeMatch) {
    return parseInt(codeMatch[1]!, 10);
  }

  if (content.includes('completed successfully')) return 0;
  if (content.includes('Encountered error') || status === 'ERROR') return 1;

  const match = content.match(/exit_code>\s*(-?\d+)\s*<\/exit_code/i);
  if (match) return parseInt(match[1]!, 10);

  return undefined;
}

export function parseAntigravityLine(
  parsed: unknown,
  activeToolCalls?: Map<string, string>
): TranscriptEvent[] {
  if (!isRecord(parsed)) return [];
  const line = parsed as Record<string, any>;
  const ts = coerceTimestamp(line.created_at) ?? 0;
  const events: TranscriptEvent[] = [];

  const toolCallsMap = activeToolCalls ?? new Map<string, string>();

  if (line.type === 'USER_INPUT') {
    let text = line.content ?? '';
    const match = text.match(/<USER_REQUEST>([\s\S]*?)<\/USER_REQUEST>/);
    if (match) text = match[1].trim();

    events.push({
      timestamp: ts,
      runtime: 'antigravity',
      kind: 'user_message',
      text,
      raw: parsed,
    });
  } else if (line.type === 'PLANNER_RESPONSE') {
    if (typeof line.content === 'string' && line.content.trim().length > 0) {
      events.push({
        timestamp: ts,
        runtime: 'antigravity',
        kind: 'assistant_message',
        text: line.content,
        raw: parsed,
      });
    }

    if (Array.isArray(line.tool_calls)) {
      for (const call of line.tool_calls) {
        const unwrapped = unwrapArgs(call.args);
        const toolUseId = `${line.step_index}-${call.name}`;
        
        let eventCwd: string | undefined = undefined;
        if (typeof unwrapped.Cwd === 'string') eventCwd = unwrapped.Cwd;
        else if (typeof unwrapped.DirectoryPath === 'string') eventCwd = unwrapped.DirectoryPath;
        else if (typeof unwrapped.SearchPath === 'string') eventCwd = unwrapped.SearchPath;

        const normName = linkageKey(call.name);
        // NOTE: Assumes sequential execution. If concurrent execution of multiple tool calls of the
        // same type in the same step/planner turn is observed, upgrade activeToolCalls to support a FIFO queue:
        // Map<string, Array<string>> (push on call, shift on result).
        toolCallsMap.set(normName, toolUseId);

        events.push({
          timestamp: ts,
          runtime: 'antigravity',
          kind: 'tool_use',
          toolName: call.name,
          toolInput: unwrapped,
          toolUseId,
          cwd: eventCwd,
          raw: call,
        });
      }
    }
  } else if (line.source === 'MODEL' && line.type !== 'PLANNER_RESPONSE') {
    const normType = linkageKey(line.type);
    let matchedToolUseId = toolCallsMap.get(normType);

    if (matchedToolUseId) {
      toolCallsMap.delete(normType);
    } else {
      matchedToolUseId = `${line.step_index - 1}-${normType}`;
    }

    const exitCode = extractExitCode(line.content, line.status);

    events.push({
      timestamp: ts,
      runtime: 'antigravity',
      kind: 'tool_result',
      toolResultText: line.content ?? '',
      toolResultExitCode: exitCode,
      toolUseId: matchedToolUseId,
      raw: parsed,
    });
  }

  return events;
}
