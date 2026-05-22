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
