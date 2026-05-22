import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/**
 * Apply a `{ relativePath -> content }` map under `dir`, creating parent
 * directories as needed. The map keys are interpreted as POSIX-style paths
 * (forward slashes); intermediate directories are created with recursive mkdir.
 *
 * @example
 * await writeFiles(repo, {
 *   '.mcp.json': '{"mcpServers":{}}',
 *   'src/index.ts': 'export {};',
 * });
 */
export async function writeFiles(dir: string, files: Record<string, string>): Promise<void> {
  for (const [relPath, content] of Object.entries(files)) {
    const full = join(dir, relPath);
    await mkdir(dirname(full), { recursive: true });
    await writeFile(full, content, 'utf8');
  }
}

export interface GitFixture {
  /** Absolute path to the git working tree. */
  readonly repo: string;
  /** Apply files and commit. Returns the new HEAD SHA. */
  commit(files: Record<string, string>, message?: string): Promise<string>;
  /** Read the current HEAD SHA. */
  head(): Promise<string>;
  /** Run an arbitrary git command in the fixture repo and return stdout. */
  git(...args: string[]): Promise<string>;
  /** Remove the temp directory and all its contents. */
  cleanup(): Promise<void>;
}

/**
 * Initialize a temp git repo on branch `main` with a placeholder user identity.
 * Optionally populates it with initial files and commits them.
 *
 * @example
 * const fx = await makeGitRepo({
 *   initialFiles: { '.mcp.json': '{}' },
 *   initialMessage: 'base agent config',
 * });
 * const base = await fx.head();
 * const head = await fx.commit({ '.mcp.json': '{"mcpServers":{...}}' }, 'add server');
 * // ... run CLI with --base $base --head $head ...
 * await fx.cleanup();
 */
export async function makeGitRepo(opts: {
  initialFiles?: Record<string, string>;
  initialMessage?: string;
  prefix?: string;
} = {}): Promise<GitFixture> {
  const repo = await mkdtemp(join(tmpdir(), opts.prefix ?? 'agent-gov-test-'));

  const git = async (...args: string[]): Promise<string> => {
    const { stdout } = await execFileAsync('git', args, { cwd: repo });
    return stdout.trim();
  };

  await git('init', '-b', 'main');
  await git('config', 'user.name', 'agent-gov-core tests');
  await git('config', 'user.email', 'agent-gov-core@example.invalid');
  await git('config', 'commit.gpgsign', 'false');

  const head = async (): Promise<string> => git('rev-parse', 'HEAD');

  const commit = async (files: Record<string, string>, message = 'test commit'): Promise<string> => {
    await writeFiles(repo, files);
    await git('add', '.');
    await git('commit', '-m', message);
    return head();
  };

  const cleanup = async (): Promise<void> => {
    await rm(repo, { recursive: true, force: true });
  };

  if (opts.initialFiles) {
    await commit(opts.initialFiles, opts.initialMessage ?? 'initial commit');
  }

  return { repo, commit, head, git, cleanup };
}

export interface OldNewFixture {
  readonly old: string;
  readonly new: string;
  cleanup(): Promise<void>;
}

/**
 * Create two sibling temp directories populated with `old` and `new` file maps.
 * Intended for diff-mode tests that take `--old` and `--new` directory paths.
 *
 * @example
 * const fx = await makeOldNewFixture({
 *   old: { '.mcp.json': '{"mcpServers":{}}' },
 *   new: { '.mcp.json': '{"mcpServers":{"x":{"command":"npx","args":["@vendor/x@latest"]}}}' },
 * });
 * // ... run CLI with --old fx.old --new fx.new ...
 * await fx.cleanup();
 */
export async function makeOldNewFixture(files: {
  old: Record<string, string>;
  new: Record<string, string>;
}, prefix = 'agent-gov-test-oldnew-'): Promise<OldNewFixture> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  const oldDir = join(root, 'old');
  const newDir = join(root, 'new');
  await mkdir(oldDir, { recursive: true });
  await mkdir(newDir, { recursive: true });
  await writeFiles(oldDir, files.old);
  await writeFiles(newDir, files.new);
  return {
    old: oldDir,
    new: newDir,
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
}
