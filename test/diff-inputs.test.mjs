import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolve, sep } from 'node:path';
import {
  isValidGitRef,
  resolveWithinRoot,
  withinByteCap,
  DEFAULT_MAX_INPUT_BYTES,
} from '../dist/index.js';

test('isValidGitRef accepts ordinary refs', () => {
  for (const ref of ['main', 'HEAD', 'origin/feature-x', 'v1.2.3', 'release/2026-05', 'a1b2c3d']) {
    assert.equal(isValidGitRef(ref), true, `${ref} should be valid`);
  }
});

test('isValidGitRef rejects flag-leading refs (argument injection)', () => {
  for (const ref of ['-x', '--upload-pack=/tmp/x', '--help', '-']) {
    assert.equal(isValidGitRef(ref), false, `${ref} should be rejected`);
  }
});

test('isValidGitRef rejects refs containing a colon (object selector re-anchor)', () => {
  assert.equal(isValidGitRef('HEAD:secret'), false);
  assert.equal(isValidGitRef('refs/heads/main:../../etc/passwd'), false);
});

test('isValidGitRef rejects empty and control-character refs', () => {
  assert.equal(isValidGitRef(''), false);
  assert.equal(isValidGitRef('main\nrm -rf'), false); // newline (0x0a)
  assert.equal(isValidGitRef('tab\there'), false); // tab (0x09)
  assert.equal(isValidGitRef('nul\x00byte'), false); // NUL (0x00)
  assert.equal(isValidGitRef('del\x7f'), false); // DEL (0x7f)
});

test('isValidGitRef permits refs the guard does not police (git rev-parse is the backstop)', () => {
  // The guard only blocks the injection vectors (leading '-', ':', control
  // chars). A trailing space is not one of those, so it passes the string
  // check; `git rev-parse --verify` rejects it at resolution time.
  assert.equal(isValidGitRef('main '), true);
});

test('resolveWithinRoot returns the joined absolute path for in-tree files', () => {
  const root = resolve('/repo');
  assert.equal(resolveWithinRoot('/repo', 'src/app.ts'), `${root}${sep}src${sep}app.ts`);
  assert.equal(resolveWithinRoot('/repo', 'nested/dir/file.json'), `${root}${sep}nested${sep}dir${sep}file.json`);
});

test('resolveWithinRoot returns the root itself for an empty relative path', () => {
  assert.equal(resolveWithinRoot('/repo', ''), resolve('/repo'));
  assert.equal(resolveWithinRoot('/repo', '.'), resolve('/repo'));
});

test('resolveWithinRoot rejects parent-traversal escapes', () => {
  assert.equal(resolveWithinRoot('/repo', '../etc/passwd'), null);
  assert.equal(resolveWithinRoot('/repo', 'src/../../outside'), null);
});

test('resolveWithinRoot rejects absolute paths that leave the root', () => {
  assert.equal(resolveWithinRoot('/repo', resolve('/etc/passwd')), null);
});

test('resolveWithinRoot does not treat a sibling prefix as inside', () => {
  // /repo-secrets must not count as inside /repo just because of the shared prefix.
  assert.equal(resolveWithinRoot('/repo', `..${sep}repo-secrets${sep}x`), null);
});

test('withinByteCap uses the default 10 MiB ceiling', () => {
  assert.equal(DEFAULT_MAX_INPUT_BYTES, 10 * 1024 * 1024);
  assert.equal(withinByteCap(0), true);
  assert.equal(withinByteCap(DEFAULT_MAX_INPUT_BYTES), true);
  assert.equal(withinByteCap(DEFAULT_MAX_INPUT_BYTES + 1), false);
});

test('withinByteCap honors a custom cap', () => {
  assert.equal(withinByteCap(100, 100), true);
  assert.equal(withinByteCap(101, 100), false);
});

test('withinByteCap fails closed on invalid sizes', () => {
  assert.equal(withinByteCap(-1), false);
  assert.equal(withinByteCap(Number.NaN), false);
  assert.equal(withinByteCap(Number.POSITIVE_INFINITY), false);
});
