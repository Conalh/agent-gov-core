import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  isAntigravityLine,
  parseAntigravityLine,
  extractExitCode,
} from '../dist/parsers/antigravity.js';

test('isAntigravityLine: correctly discriminates Antigravity shapes', () => {
  assert.ok(isAntigravityLine({ step_index: 1, source: 'MODEL', type: 'PLANNER_RESPONSE' }));
  assert.ok(isAntigravityLine({ step_index: 0, source: 'USER_EXPLICIT', type: 'USER_INPUT' }));
  assert.ok(isAntigravityLine({ step_index: 2, source: 'SYSTEM', type: 'LIST_DIRECTORY' }));

  // Non-records or missing critical fields
  assert.equal(isAntigravityLine(null), false);
  assert.equal(isAntigravityLine({ source: 'MODEL', type: 'PLANNER_RESPONSE' }), false);
  assert.equal(isAntigravityLine({ step_index: 1, type: 'PLANNER_RESPONSE' }), false);
  assert.equal(isAntigravityLine({ step_index: 1, source: 'OTHER' }), false);
});

test('parseAntigravityLine: USER_INPUT correctly unwraps USER_REQUEST tags', () => {
  const line = {
    step_index: 0,
    source: 'USER_EXPLICIT',
    type: 'USER_INPUT',
    created_at: '2026-05-23T10:00:00.000Z',
    content: '<USER_REQUEST>\nFix the build issue\n</USER_REQUEST>',
  };

  const events = parseAntigravityLine(line);
  assert.equal(events.length, 1);
  assert.equal(events[0].kind, 'user_message');
  assert.equal(events[0].text, 'Fix the build issue');
  assert.equal(events[0].runtime, 'antigravity');
});

test('parseAntigravityLine: PLANNER_RESPONSE with text + tool_calls emits multiple events', () => {
  const line = {
    step_index: 5,
    source: 'MODEL',
    type: 'PLANNER_RESPONSE',
    status: 'DONE',
    created_at: '2026-05-23T10:00:50.000Z',
    content: 'Running the test suite...',
    tool_calls: [
      {
        name: 'run_command',
        args: {
          CommandLine: '"npm test"',
          Cwd: '"c:\\\\Dev\\\\AgentPulse"',
        },
      },
    ],
  };

  const activeToolCalls = new Map();
  const events = parseAntigravityLine(line, activeToolCalls);

  // Should emit an assistant_message and a tool_use event
  assert.equal(events.length, 2);
  assert.equal(events[0].kind, 'assistant_message');
  assert.equal(events[0].text, 'Running the test suite...');

  assert.equal(events[1].kind, 'tool_use');
  assert.equal(events[1].toolName, 'run_command');
  assert.equal(events[1].toolInput.command, 'npm test');
  assert.equal(events[1].toolInput.Cwd, 'c:\\Dev\\AgentPulse');
  assert.equal(events[1].cwd, 'c:\\Dev\\AgentPulse');

  // Verify sequential linkage map was populated
  assert.equal(activeToolCalls.get('runcommand'), '5-run_command');
});

test('parseAntigravityLine: MODEL result sequentially resolves toolUseId', () => {
  const activeToolCalls = new Map();
  activeToolCalls.set('runcommand', '5-run_command');

  const resultLine = {
    step_index: 6,
    source: 'MODEL',
    type: 'RUN_COMMAND',
    status: 'DONE',
    created_at: '2026-05-23T10:01:00.000Z',
    content: 'The command completed successfully.',
  };

  const events = parseAntigravityLine(resultLine, activeToolCalls);
  assert.equal(events.length, 1);
  assert.equal(events[0].kind, 'tool_result');
  assert.equal(events[0].toolResultExitCode, 0);
  assert.equal(events[0].toolUseId, '5-run_command');

  // Verify linked tool call was cleaned up
  assert.equal(activeToolCalls.has('runcommand'), false);
});

test('parseAntigravityLine: MODEL result defensive fallback does not crash', () => {
  // Test fallback path when activeToolCalls map is missing the entry.
  // Note: Fallback generates a structural ID string but does NOT functionally
  // link with the tool_use event due to case/asymmetry naming differences.
  const activeToolCalls = new Map();
  const resultLine = {
    step_index: 6,
    source: 'MODEL',
    type: 'RUN_COMMAND',
    status: 'DONE',
    created_at: '2026-05-23T10:01:00.000Z',
    content: 'The command completed successfully.',
  };

  const events = parseAntigravityLine(resultLine, activeToolCalls);
  assert.equal(events.length, 1);
  assert.equal(events[0].kind, 'tool_result');
  // Fallback resolves to "${step_index - 1}-${normType}" -> "5-runcommand"
  assert.equal(events[0].toolUseId, '5-runcommand');
});

test('extractExitCode: parses verified RUN_COMMAND shapes', () => {
  // 1. Success cases
  assert.equal(extractExitCode('The command completed successfully.\nOutput:\nOK', 'DONE'), 0);
  assert.equal(extractExitCode('completed successfully.', 'DONE'), 0);
  assert.equal(extractExitCode('exit code: 0', 'DONE'), 0);

  // 2. Failure cases with numeric codes
  assert.equal(extractExitCode('The command failed with exit code: 1', 'DONE'), 1);
  assert.equal(extractExitCode('exit code: 127', 'DONE'), 127);
  assert.equal(extractExitCode('exit_code: -1', 'DONE'), -1);

  // 3. Error status and tags fallback
  assert.equal(extractExitCode('Some random trace error', 'ERROR'), 1);
  assert.equal(extractExitCode('Encountered error in task', 'DONE'), 1);
  assert.equal(extractExitCode('<exit_code>143</exit_code>', 'DONE'), 143);

  // 4. Undefined cases
  assert.equal(extractExitCode('Normal non-numeric text output', 'DONE'), undefined);
});
