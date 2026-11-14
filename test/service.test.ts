import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { AuditLog } from '../src/audit.ts';
import { CommitService } from '../src/service.ts';
import { createPullRequest, parseRemote, resolveToken } from '../src/forgejo.ts';
import { cleanup, makeRepoWithRemote, sh, testConfig, write } from './helpers.ts';

const FORGEJO = { url: 'https://git.corp.example', tokenEnv: 'FJ_TOKEN', autoPullRequest: true };

function setup(overrides: Record<string, unknown> = {}, fetchImpl?: typeof fetch) {
  const fx = makeRepoWithRemote();
  const cfg = testConfig({ repos: [fx.work], ...overrides });
  const audit = new AuditLog(cfg.auditLogPath, 'J Smith');
  const svc = new CommitService(cfg, audit, {
    fetchImpl,
    env: { FJ_TOKEN: 'tok-123' },
    now: () => new Date('2026-03-04T05:06:07Z'),
  });
  return { ...fx, cfg, audit, svc, dispose: () => { fx.dispose(); cleanup(cfg.auditLogPath.replace(/audit\.jsonl$/, '')); } };
}

test('parseRemote handles https, ssh and scp forms', () => {
  assert.deepEqual(parseRemote('https://git.corp.example/org/repo.git'), { host: 'git.corp.example', owner: 'org', repo: 'repo' });
  assert.deepEqual(parseRemote('ssh://git@git.corp.example:2222/org/repo.git'), { host: 'git.corp.example', owner: 'org', repo: 'repo' });
  assert.deepEqual(parseRemote('git@git.corp.example:org/repo.git'), { host: 'git.corp.example', owner: 'org', repo: 'repo' });
  assert.equal(parseRemote('/just/a/path'), null);
});

test('resolveToken prefers env then file', () => {
  assert.equal(resolveToken({ ...FORGEJO }, { FJ_TOKEN: ' abc ' }), 'abc');
  assert.equal(resolveToken({ ...FORGEJO }, {}), null);
});

test('createPullRequest refuses to send the token to a different host', async () => {
  let called = false;
  const r = await createPullRequest({
    cfg: FORGEJO,
    remoteUrl: 'https://evil.example/org/repo.git',
    head: 'h',
    base: 'main',
    title: 't',
    body: 'b',
    env: { FJ_TOKEN: 'secret' },
    fetchImpl: (async () => { called = true; return new Response('{}'); }) as typeof fetch,
  });
  assert.equal(r.ok, false);
  assert.equal(called, false);
});

test('createPullRequest: success, existing PR, and server error', async () => {
  const mk = (status: number) => (async () => new Response(JSON.stringify({ html_url: 'https://git.corp.example/org/repo/pulls/7' }), { status })) as typeof fetch;
  const base = { cfg: FORGEJO, remoteUrl: 'git@git.corp.example:org/repo.git', head: 'h', base: 'main', title: 't', body: 'b', env: { FJ_TOKEN: 'x' } };
  const ok = await createPullRequest({ ...base, fetchImpl: mk(201) });
  assert.deepEqual([ok.ok, ok.url], [true, 'https://git.corp.example/org/repo/pulls/7']);
  assert.equal((await createPullRequest({ ...base, fetchImpl: mk(409) })).ok, true);
  assert.equal((await createPullRequest({ ...base, fetchImpl: mk(500) })).ok, false);
  assert.equal((await createPullRequest({ ...base, env: {}, fetchImpl: mk(201) })).ok, false);
});

test('service: validates input and repo', async () => {
  const s = setup();
  try {
    assert.equal((await s.svc.commit({ repo: '/not/managed', message: 'x', files: ['a'], push: false })).code, 'unknown-repo');
    assert.equal((await s.svc.commit({ repo: s.work, message: '   ', files: ['a'], push: false })).code, 'empty-message');
    write(s.work, 'a.txt', 'a');
    assert.equal((await s.svc.commit({ repo: s.work, message: 'm', files: ['nope.txt'], push: false })).code, 'no-files');
  } finally {
    s.dispose();
  }
});

test('service developer mode: protected branch is refused, new branch commit + push works', async () => {
  const s = setup();
  try {
    write(s.work, 'a.txt', 'a');
    const refused = await s.svc.commit({ repo: s.work, message: 'add a', files: ['a.txt'], push: true });
    assert.equal(refused.code, 'protected-branch');
    assert.equal(sh(s.work, 'rev-list', '--count', 'HEAD').trim(), '1'); // nothing committed

    const ok = await s.svc.commit({ repo: s.work, message: 'add a', files: ['a.txt'], push: true, newBranch: 'feat/a' });
    assert.equal(ok.ok, true, ok.message);
    assert.equal(ok.pushed, true);
    assert.match(sh(s.remote, 'branch', '--list', 'feat/a'), /feat\/a/);
    assert.equal(sh(s.remote, 'rev-parse', 'feat/a').trim(), ok.commit);

    const bad = await s.svc.commit({ repo: s.work, message: 'x', files: ['a.txt'], push: false, newBranch: 'main' });
    assert.notEqual(bad.ok, true);
  } finally {
    s.dispose();
  }
});

test('service: only selected files are committed, pre-staged extras are not smuggled in', async () => {
  const s = setup();
  try {
    sh(s.work, 'switch', '-c', 'feat/sel');
    write(s.work, 'keep.txt', 'k');
    write(s.work, 'other.txt', 'o');
    sh(s.work, 'add', 'other.txt');
    const r = await s.svc.commit({ repo: s.work, message: 'only keep', files: ['keep.txt'], push: false });
    assert.equal(r.ok, true, r.message);
    assert.equal(sh(s.work, 'show', '--name-only', '--format=', 'HEAD').trim(), 'keep.txt');
    assert.match(sh(s.work, 'status', '--porcelain'), /other\.txt/);
  } finally {
    s.dispose();
  }
});

test('service: secrets block the save, change nothing, and are not logged', async () => {
  const s = setup();
  try {
    sh(s.work, 'switch', '-c', 'feat/sec');
    write(s.work, 'cfg.ts', 'const apiKey = "sk_live_ABCDEFGHIJKLMNOP";\n');
    write(s.work, '.env', 'X=1\n');
    const before = sh(s.work, 'rev-parse', 'HEAD');
    const r = await s.svc.commit({ repo: s.work, message: 'oops', files: ['cfg.ts', '.env'], push: true });
    assert.equal(r.code, 'policy-blocked');
    assert.equal(sh(s.work, 'rev-parse', 'HEAD'), before);
    const log = readFileSync(s.cfg.auditLogPath, 'utf8');
    assert.match(log, /policy-blocked/);
    assert.ok(!log.includes('sk_live'));
  } finally {
    s.dispose();
  }
});

test('service: conflicts block saving', async () => {
  const s = setup();
  try {
    sh(s.work, 'switch', '-c', 'feat/c1');
    write(s.work, 'f.txt', '1');
    sh(s.work, 'add', '-A'); sh(s.work, 'commit', '-m', 'c1');
    sh(s.work, 'switch', 'main');
    sh(s.work, 'switch', '-c', 'feat/c2');
    write(s.work, 'f.txt', '2');
    sh(s.work, 'add', '-A'); sh(s.work, 'commit', '-m', 'c2');
    try { sh(s.work, 'merge', 'feat/c1'); } catch { /* expected conflict */ }
    const r = await s.svc.commit({ repo: s.work, message: 'm', files: ['f.txt'], push: false });
    assert.equal(r.code, 'conflicts');
  } finally {
    s.dispose();
  }
});

test('service simple mode: personal branch, always shares, opens a PR', async () => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return new Response(JSON.stringify({ html_url: 'https://git.corp.example/org/repo/pulls/1' }), { status: 201 });
  }) as unknown as typeof fetch;
  const s = setup({ mode: 'simple', forgejo: FORGEJO }, fetchImpl);
  try {
    // Make origin look like the Forgejo remote for the API, but keep pushing to the local bare repo.
    sh(s.work, 'remote', 'set-url', 'origin', 'https://git.corp.example/org/repo.git');
    sh(s.work, 'remote', 'set-url', '--push', 'origin', s.remote);

    write(s.work, 'doc.md', 'hello');
    const r = await s.svc.commit({ repo: s.work, message: 'Update policy doc\n\nmore detail', files: ['doc.md'], push: false });
    assert.equal(r.ok, true, r.message);
    assert.equal(r.branch, 'users/j-smith/20260304');
    assert.equal(r.pushed, true);
    assert.equal(r.pullRequestUrl, 'https://git.corp.example/org/repo/pulls/1');
    assert.match(sh(s.remote, 'branch', '--list', 'users/j-smith/20260304'), /users\/j-smith/);

    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.url, 'https://git.corp.example/api/v1/repos/org/repo/pulls');
    assert.equal((calls[0]!.init.headers as Record<string, string>).Authorization, 'token tok-123');
    const body = JSON.parse(String(calls[0]!.init.body));
    assert.equal(body.head, 'users/j-smith/20260304');
    assert.equal(body.base, 'main');
    assert.equal(body.title, 'Update policy doc');

    // Second save in the same session stays on the personal branch.
    write(s.work, 'doc2.md', 'again');
    const r2 = await s.svc.commit({ repo: s.work, message: 'More', files: ['doc2.md'], push: false });
    assert.equal(r2.branch, 'users/j-smith/20260304');
  } finally {
    s.dispose();
  }
});

test('service: push failure keeps the local commit and says so', async () => {
  const s = setup();
  try {
    sh(s.work, 'remote', 'set-url', '--push', 'origin', '/definitely/not/here');
    write(s.work, 'a.txt', 'a');
    const r = await s.svc.commit({ repo: s.work, message: 'm', files: ['a.txt'], push: true, newBranch: 'feat/p' });
    assert.equal(r.code, 'push-failed');
    assert.equal(r.pushed, false);
    assert.match(r.commit ?? '', /^[0-9a-f]{40}$/);
    assert.equal(sh(s.work, 'rev-parse', 'HEAD').trim(), r.commit);
  } finally {
    s.dispose();
  }
});
