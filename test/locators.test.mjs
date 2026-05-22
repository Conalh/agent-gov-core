import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lineOfJsonKey, lineOfJsonStringValue, lineOfTomlKey } from '../dist/index.js';

const json = `{
  "servers": {
    "alpha": {
      "command": "node",
      "args": ["server.js"]
    },
    "beta": {
      "command": "python",
      "args": ["server.py"]
    }
  }
}`;

test('lineOfJsonKey: top-level', () => {
  assert.equal(lineOfJsonKey(json, 'servers'), 2);
});

test('lineOfJsonKey: nested', () => {
  assert.equal(lineOfJsonKey(json, 'alpha'), 3);
  assert.equal(lineOfJsonKey(json, 'beta'), 7);
});

test('lineOfJsonStringValue: first occurrence without scope', () => {
  assert.equal(lineOfJsonStringValue(json, 'node'), 4);
});

test('lineOfJsonStringValue: scope disambiguates between two servers', () => {
  // find the alpha block's span and limit search to it
  const alphaStart = json.indexOf('"alpha"');
  const betaStart = json.indexOf('"beta"');
  const alphaLine = lineOfJsonStringValue(json, 'python', { start: alphaStart, end: betaStart });
  // python only appears in beta block
  assert.equal(alphaLine, 0);

  const betaLine = lineOfJsonStringValue(json, 'python', { start: betaStart, end: json.length });
  assert.equal(betaLine, 8);
});

const toml = `# top
title = "x"

[server]
host = "localhost"
port = 8080

[[items]]
name = "first"

[[items]]
name = "second"

["weird.name"]
x = 42
`;

test('lineOfTomlKey: top-level', () => {
  assert.equal(lineOfTomlKey(toml, 'title'), 2);
});

test('lineOfTomlKey: nested', () => {
  assert.equal(lineOfTomlKey(toml, 'server.host'), 5);
  assert.equal(lineOfTomlKey(toml, 'server.port'), 6);
});

test('lineOfTomlKey: quoted-key section', () => {
  assert.equal(lineOfTomlKey(toml, '"weird.name".x'), 15);
});

test('lineOfTomlKey: scope disambiguates between two array-of-tables entries', () => {
  // Both [[items]] entries define `name`. Without scope, the first one wins.
  assert.equal(lineOfTomlKey(toml, 'items.name'), 9);

  // With scope pinning the second [[items]] block, the second match wins.
  const secondItemsHeader = toml.indexOf('[[items]]', toml.indexOf('[[items]]') + 1);
  const weirdHeader = toml.indexOf('["weird.name"]');
  const secondMatch = lineOfTomlKey(toml, 'items.name', {
    start: secondItemsHeader,
    end: weirdHeader,
  });
  assert.equal(secondMatch, 12);
});

test('lineOfJsonStringValue: matches decoded value containing backslashes (regression)', () => {
  // Inspection: caller passes the decoded value `C:\Temp`. Source bytes are
  // `"C:\\Temp"` (backslash escaped). Locator must JSON-encode the input
  // before matching, otherwise the lookup returns 0.
  const text = `{
  "path": "C:\\\\Temp"
}`;
  assert.equal(lineOfJsonStringValue(text, 'C:\\Temp'), 2);
});

test('lineOfJsonStringValue: matches decoded value containing quotes (regression)', () => {
  // package.json scripts that embed quotes — common pattern.
  // Source: "postinstall": "echo \"hello\""
  // Decoded value passed by caller: echo "hello"
  const text = `{
  "scripts": {
    "postinstall": "echo \\"hello\\""
  }
}`;
  assert.equal(lineOfJsonStringValue(text, 'echo "hello"'), 3);
});

test('lineOfJsonKey: ignores commented-out key (regression)', () => {
  // JSONC: a `//` comment containing a fake key should not shadow the real key.
  const text = `{
  // "command": "fake",
  "command": "real"
}`;
  assert.equal(lineOfJsonKey(text, 'command'), 3);
});

test('lineOfJsonStringValue: ignores value inside block comment (regression)', () => {
  const text = `{
  /* "target": "old-host" */
  "target": "new-host"
}`;
  assert.equal(lineOfJsonStringValue(text, 'new-host'), 3);
});

test('lineOfJsonStringValue: skips key-position matches when looking for a value (P0 regression)', () => {
  // Caught by Cody: `"command":"npx", "args":["command"]` — searching for value
  // "command" was matching the key on line 2 instead of the array element on
  // line 4. Negative lookahead for `\s*:` after the closing quote rules out
  // key-position occurrences.
  const text = `{
  "command": "npx",
  "args": [
    "command"
  ]
}`;
  assert.equal(lineOfJsonStringValue(text, 'command'), 4);
});

test('lineOfJsonStringValue: still matches values containing colons inside the string', () => {
  // Sanity: the negative-lookahead fix must not break values that legitimately
  // contain colons. `"host:port"` is a value, not a key.
  const text = `{
  "address": "host:port"
}`;
  assert.equal(lineOfJsonStringValue(text, 'host:port'), 2);
});

test('lineOfTomlKey: top-level dotted keys are reachable (P3 regression)', () => {
  // Caught by Cody: the dotted-key branch sat behind `if (!inTargetTable) continue`,
  // so it never fired when currentTable was empty. Now the dotted-key check
  // runs BEFORE the inTargetTable gate.
  assert.equal(lineOfTomlKey('a.b.c = 1\n', 'a.b.c'), 1);
  assert.equal(lineOfTomlKey('# header\nx.y = "value"\n', 'x.y'), 2);
});

test('lineOfTomlKey: ignores decoy keys inside multi-line basic strings (regression)', () => {
  // Inspection: a `"""..."""` value can contain text that looks like a key.
  // Without state tracking, the locator matched the decoy inside the string
  // instead of the real key below it.
  const toml = `[server]
description = """
host = "decoy"
port = 1234
"""
host = "real"
port = 9090
`;
  // Expected: line 6 (the real `host = "real"`), not 3 (the decoy inside `description`).
  assert.equal(lineOfTomlKey(toml, 'server.host'), 6);
});

test('lineOfTomlKey: ignores decoy keys inside multi-line literal strings (regression)', () => {
  const toml = `[server]
description = '''
host = "decoy"
'''
host = "real"
`;
  assert.equal(lineOfTomlKey(toml, 'server.host'), 5);
});

test('lineOfTomlKey: matches first real occurrence when no multi-line string interferes', () => {
  // Sanity check: the fix doesn't over-correct on plain TOML.
  const toml = `[server]
host = "first"
port = 1234
`;
  assert.equal(lineOfTomlKey(toml, 'server.host'), 2);
});

test('lineOfTomlKey: handles multi-line string that opens and closes on the same line', () => {
  // A single-line `"""..."""` does NOT enter multi-line state for subsequent lines.
  const toml = `[server]
description = """all on one line"""
host = "real"
`;
  assert.equal(lineOfTomlKey(toml, 'server.host'), 3);
});

test('lineOfTomlKey: scope outside the table returns 0 (not found)', () => {
  // Restrict to byte range before [server] — server.host shouldn't be found.
  const serverHeader = toml.indexOf('[server]');
  const result = lineOfTomlKey(toml, 'server.host', { start: 0, end: serverHeader });
  assert.equal(result, 0);
});
