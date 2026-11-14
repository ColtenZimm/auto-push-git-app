import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { DEFAULTS, validateConfig } from '../src/config.ts';
import type { Config } from '../src/types.ts';

export function sh(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
  });
}

export function tmp(prefix = 'ap-'): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

export function cleanup(...dirs: string[]): void {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
}

export function write(root: string, rel: string, content: string): void {
  const p = join(root, rel);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, content);
}

/** A working repo on `main` with one commit and a bare `origin` it can push to. */
export function makeRepoWithRemote(): { work: string; remote: string; dispose: () => void } {
  const remote = tmp('ap-remote-');
  sh(remote, 'init', '--bare', '-b', 'main');
  const work = tmp('ap-work-');
  sh(work, 'init', '-b', 'main');
  sh(work, 'config', 'user.name', 'Test User');
  sh(work, 'config', 'user.email', 'test@example.com');
  sh(work, 'config', 'commit.gpgsign', 'false');
  sh(work, 'remote', 'add', 'origin', remote);
  write(work, 'README.md', '# hello\n');
  sh(work, 'add', '-A');
  sh(work, 'commit', '-m', 'init');
  sh(work, 'push', '-u', 'origin', 'main');
  return { work, remote, dispose: () => cleanup(work, remote) };
}

export function testConfig(overrides: Record<string, unknown> = {}): Config {
  const raw = { ...JSON.parse(JSON.stringify(DEFAULTS)), auditLogPath: join(tmp('ap-audit-'), 'audit.jsonl'), ...overrides };
  return validateConfig(raw);
}
