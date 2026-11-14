import { execFile } from 'node:child_process';
import type { ChangeKind, FileChange, RepoStatus } from './types.ts';

export class GitError extends Error {
  readonly args: string[];
  readonly exitCode: number | null;
  readonly stderr: string;
  constructor(message: string, args: string[], exitCode: number | null, stderr: string) {
    super(message);
    this.name = 'GitError';
    this.args = args;
    this.exitCode = exitCode;
    this.stderr = stderr;
  }
}

export interface RunOptions {
  timeoutMs?: number;
  input?: string;
}

/**
 * Thin wrapper over the real git CLI. Arguments are passed as an array (never
 * through a shell) so file names and messages cannot be interpreted as commands.
 * Credentials are never handled here: git's own credential helpers do that, and
 * prompting is disabled so a headless daemon can never hang waiting on a tty.
 */
export class Git {
  readonly cwd: string;
  readonly bin: string;

  constructor(cwd: string, bin = 'git') {
    this.cwd = cwd;
    this.bin = bin;
  }

  run(args: string[], opts: RunOptions = {}): Promise<string> {
    return new Promise((resolve, reject) => {
      const child = execFile(
        this.bin,
        args,
        {
          cwd: this.cwd,
          timeout: opts.timeoutMs ?? 30_000,
          maxBuffer: 64 * 1024 * 1024,
          windowsHide: true,
          encoding: 'utf8',
          env: { ...process.env, GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C', GIT_OPTIONAL_LOCKS: '0' },
        },
        (err, stdout, stderr) => {
          if (err) {
            const code = typeof (err as NodeJS.ErrnoException).code === 'number' ? ((err as unknown as { code: number }).code) : null;
            const killed = (err as { killed?: boolean }).killed;
            const msg = killed
              ? `git ${args[0]} timed out`
              : `git ${args[0]} failed: ${String(stderr || err.message).trim().split('\n')[0]}`;
            reject(new GitError(msg, args, code, String(stderr)));
            return;
          }
          resolve(stdout);
        },
      );
      if (opts.input !== undefined) child.stdin?.end(opts.input);
    });
  }

  async isRepo(): Promise<boolean> {
    try {
      return (await this.run(['rev-parse', '--is-inside-work-tree'])).trim() === 'true';
    } catch {
      return false;
    }
  }

  async root(): Promise<string> {
    return (await this.run(['rev-parse', '--show-toplevel'])).trim();
  }

  async status(): Promise<RepoStatus> {
    const out = await this.run(['status', '--porcelain=v2', '--branch', '--untracked-files=all', '-z']);
    return parseStatus(out, this.cwd);
  }

  async currentBranch(): Promise<string | null> {
    try {
      const b = (await this.run(['symbolic-ref', '--short', '-q', 'HEAD'])).trim();
      return b || null;
    } catch {
      return null;
    }
  }

  async userName(): Promise<string> {
    try {
      return (await this.run(['config', 'user.name'])).trim();
    } catch {
      return '';
    }
  }

  async remoteUrl(remote = 'origin'): Promise<string | null> {
    try {
      return (await this.run(['remote', 'get-url', remote])).trim() || null;
    } catch {
      return null;
    }
  }

  async defaultBranch(remote = 'origin'): Promise<string | null> {
    try {
      const ref = (await this.run(['symbolic-ref', '--short', `refs/remotes/${remote}/HEAD`])).trim();
      return ref.startsWith(`${remote}/`) ? ref.slice(remote.length + 1) : ref;
    } catch {
      return null;
    }
  }

  async branchExists(name: string): Promise<boolean> {
    try {
      await this.run(['show-ref', '--verify', '--quiet', `refs/heads/${name}`]);
      return true;
    } catch {
      return false;
    }
  }

  async switchNewBranch(name: string): Promise<void> {
    await this.run(['switch', '-c', name]);
  }

  async switchBranch(name: string): Promise<void> {
    await this.run(['switch', name]);
  }

  /** Stage exactly these paths (including deletions). */
  async stage(paths: string[]): Promise<void> {
    if (paths.length === 0) return;
    await this.run(['add', '-A', '--', ...paths]);
  }

  async unstageAll(): Promise<void> {
    try {
      await this.run(['reset', '-q']);
    } catch {
      // No HEAD yet (fresh repo): nothing to reset against.
    }
  }

  async commit(message: string): Promise<string> {
    await this.run(['commit', '-q', '--file=-'], { input: message });
    return (await this.run(['rev-parse', 'HEAD'])).trim();
  }

  async push(branch: string, remote = 'origin'): Promise<void> {
    await this.run(['push', '--set-upstream', remote, `${branch}:${branch}`], { timeoutMs: 180_000 });
  }
}

const KIND_BY_CODE: Record<string, ChangeKind> = { A: 'added', D: 'deleted', R: 'renamed', C: 'added' };

function kindFromXY(xy: string): ChangeKind {
  const x = xy[0] ?? '.';
  const y = xy[1] ?? '.';
  if (x === 'D' || y === 'D') return 'deleted';
  if (x === 'A') return 'added';
  return KIND_BY_CODE[x] ?? KIND_BY_CODE[y] ?? 'modified';
}

/** Parse `git status --porcelain=v2 --branch -z` output. Exported for tests. */
export function parseStatus(out: string, root: string): RepoStatus {
  const status: RepoStatus = { root, branch: null, upstream: null, ahead: 0, behind: 0, files: [], hasConflicts: false };
  const records = out.split('\0');
  for (let i = 0; i < records.length; i++) {
    const rec = records[i];
    if (!rec) continue;
    if (rec.startsWith('# ')) {
      const [, key, ...rest] = rec.split(' ');
      const val = rest.join(' ');
      if (key === 'branch.head') status.branch = val === '(detached)' ? null : val;
      else if (key === 'branch.upstream') status.upstream = val;
      else if (key === 'branch.ab') {
        const m = /^\+(\d+) -(\d+)$/.exec(val);
        if (m) {
          status.ahead = Number(m[1]);
          status.behind = Number(m[2]);
        }
      }
      continue;
    }
    const type = rec[0];
    if (type === '1') {
      const parts = splitFields(rec, 8);
      const xy = parts[1] ?? '..';
      status.files.push({ path: parts[8] ?? '', kind: kindFromXY(xy), staged: xy[0] !== '.' });
    } else if (type === '2') {
      const parts = splitFields(rec, 9);
      const xy = parts[1] ?? '..';
      status.files.push({ path: parts[9] ?? '', kind: 'renamed', staged: xy[0] !== '.' });
      i++; // the original path follows as its own NUL-terminated record
    } else if (type === 'u') {
      const parts = splitFields(rec, 10);
      status.files.push({ path: parts[10] ?? '', kind: 'conflict', staged: false });
      status.hasConflicts = true;
    } else if (type === '?') {
      status.files.push({ path: rec.slice(2), kind: 'untracked', staged: false });
    }
  }
  return status;
}

/** Split on the first `n` spaces; the remainder (a path that may contain spaces) is the last element. */
function splitFields(s: string, n: number): string[] {
  const out: string[] = [];
  let start = 0;
  for (let k = 0; k < n; k++) {
    const idx = s.indexOf(' ', start);
    if (idx === -1) break;
    out.push(s.slice(start, idx));
    start = idx + 1;
  }
  out.push(s.slice(start));
  return out;
}
