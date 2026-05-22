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

test('lineOfTomlKey: scope outside the table returns 0 (not found)', () => {
  // Restrict to byte range before [server] — server.host shouldn't be found.
  const serverHeader = toml.indexOf('[server]');
  const result = lineOfTomlKey(toml, 'server.host', { start: 0, end: serverHeader });
  assert.equal(result, 0);
});
