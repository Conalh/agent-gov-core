import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import {
  writeFiles,
  makeGitRepo,
  makeOldNewFixture,
} from '../dist/test-utils.js';

test('writeFiles creates files and nested directories', async () => {
  const fx = await makeGitRepo();
  try {
    await writeFiles(fx.repo, {
      'a.txt': 'top',
      'nested/b.txt': 'middle',
      'nested/deep/c.txt': 'deep',
    });
    assert.equal((await readFile(join(fx.repo, 'a.txt'), 'utf8')), 'top');
    assert.equal((await readFile(join(fx.repo, 'nested/b.txt'), 'utf8')), 'middle');
    assert.equal((await readFile(join(fx.repo, 'nested/deep/c.txt'), 'utf8')), 'deep');
  } finally {
    await fx.cleanup();
  }
});

test('makeGitRepo initializes a repo on branch main with no initial commit', async () => {
  const fx = await makeGitRepo();
  try {
    const branch = await fx.git('symbolic-ref', '--short', 'HEAD');
    assert.equal(branch, 'main');
  } finally {
    await fx.cleanup();
  }
});

test('makeGitRepo with initialFiles produces a base commit', async () => {
  const fx = await makeGitRepo({
    initialFiles: { '.mcp.json': '{"mcpServers":{}}' },
    initialMessage: 'base config',
  });
  try {
    const base = await fx.head();
    assert.match(base, /^[0-9a-f]{40}$/);
    const log = await fx.git('log', '--format=%s', '-1');
    assert.equal(log, 'base config');
  } finally {
    await fx.cleanup();
  }
});

test('GitFixture.commit returns the new HEAD SHA and advances HEAD', async () => {
  const fx = await makeGitRepo({ initialFiles: { 'a.txt': 'first' } });
  try {
    const base = await fx.head();
    const head = await fx.commit({ 'a.txt': 'second', 'b.txt': 'new' }, 'second commit');
    assert.notEqual(base, head);
    assert.equal(head, await fx.head());
    const log = await fx.git('log', '--format=%s', '-2');
    assert.equal(log, 'second commit\ninitial commit');
  } finally {
    await fx.cleanup();
  }
});

test('GitFixture.cleanup removes the temp directory', async () => {
  const fx = await makeGitRepo();
  assert.equal(existsSync(fx.repo), true);
  await fx.cleanup();
  assert.equal(existsSync(fx.repo), false);
});

test('makeOldNewFixture creates two sibling directories with the given files', async () => {
  const fx = await makeOldNewFixture({
    old: { '.mcp.json': '{"old":true}' },
    new: { '.mcp.json': '{"new":true}', 'extra.txt': 'added' },
  });
  try {
    assert.equal((await readFile(join(fx.old, '.mcp.json'), 'utf8')), '{"old":true}');
    assert.equal((await readFile(join(fx.new, '.mcp.json'), 'utf8')), '{"new":true}');
    assert.equal((await readFile(join(fx.new, 'extra.txt'), 'utf8')), 'added');
  } finally {
    await fx.cleanup();
  }
});

test('makeOldNewFixture cleanup removes both directories and their parent', async () => {
  const fx = await makeOldNewFixture({ old: { 'a': '1' }, new: { 'a': '2' } });
  assert.equal(existsSync(fx.old), true);
  assert.equal(existsSync(fx.new), true);
  await fx.cleanup();
  assert.equal(existsSync(fx.old), false);
  assert.equal(existsSync(fx.new), false);
});
