import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Git, parseStatus } from '../src/git.ts';
import { globToRegExp, isValidBranchName, sanitizeBranchSegment } from '../src/util.ts';
import { isProtectedBranch, scanFiles, scanText } from '../src/policy.ts';
import { ConfigError, loadConfig, validateConfig, DEFAULTS } from '../src/config.ts';
import { cleanup, makeRepoWithRemote, sh, tmp, write } from './helpers.ts';

test('globToRegExp handles * and **', () => {
  assert.ok(globToRegExp('release/*').test('release/1.2'));
  assert.ok(!globToRegExp('release/*').test('release/1/2'));
  assert.ok(globToRegExp('release/**').test('release/1/2'));
  assert.ok(globToRegExp('main').test('main'));
  assert.ok(!globToRegExp('main').test('mainline'));
});

test('branch name helpers', () => {
  assert.ok(isValidBranchName('users/jsmith/20260101'));
  for (const bad of ['', '-x', 'a..b', 'a b', 'x.lock', 'a/', '/a', 'a@{b', 'a~b', 'a:b']) {
    assert.ok(!isValidBranchName(bad), bad);
  }
  assert.equal(sanitizeBranchSegment('J. Smith!'), 'j.-smith');
  assert.equal(sanitizeBranchSegment('???'), 'user');
});

test('protected branch matching, detached HEAD is protected', () => {
  const p = ['main', 'release/*'];
  assert.ok(isProtectedBranch(p, 'main'));
  assert.ok(isProtectedBranch(p, 'release/2.0'));
  assert.ok(!isProtectedBranch(p, 'feature/x'));
  assert.ok(isProtectedBranch(p, null));
});

test('parseStatus parses v2 porcelain with renames and spaces', () => {
  const out = [
    '# branch.oid abc',
    '# branch.head feat/x',
    '# branch.upstream origin/feat/x',
    '# branch.ab +2 -1',
    '1 .M N... 100644 100644 100644 a b src/with space.ts',
    '1 A. N... 000000 100644 100644 a b new.ts',
    '2 R. N... 100644 100644 100644 a b R100 renamed.ts',
    'orig.ts',
    'u UU N... 1 2 3 4 a b c conflict.ts',
    '? untracked.txt',
    '',
  ].join('\0');
  const s = parseStatus(out, '/r');
  assert.equal(s.branch, 'feat/x');
  assert.equal(s.upstream, 'origin/feat/x');
  assert.equal(s.ahead, 2);
  assert.equal(s.behind, 1);
  assert.equal(s.hasConflicts, true);
  assert.deepEqual(
    s.files.map((f) => [f.path, f.kind, f.staged]),
    [
      ['src/with space.ts', 'modified', false],
      ['new.ts', 'added', true],
      ['renamed.ts', 'renamed', true],
      ['conflict.ts', 'conflict', false],
      ['untracked.txt', 'untracked', false],
    ],
  );
});

test('Git: status, stage subset, commit, push against a real repo', async () => {
  const { work, remote, dispose } = makeRepoWithRemote();
  try {
    const git = new Git(work);
    assert.equal((await git.status()).files.length, 0);

    write(work, 'a.txt', 'a');
    write(work, 'dir/b.txt', 'b');
    writeFileSync(join(work, 'README.md'), '# changed\n');
    const st = await git.status();
    assert.deepEqual(st.files.map((f) => f.path).sort(), ['README.md', 'a.txt', 'dir/b.txt']);

    await git.stage(['a.txt']);
    const sha = await git.commit('add a\n\nbody line');
    assert.match(sha, /^[0-9a-f]{40}$/);
    const after = await git.status();
    assert.deepEqual(after.files.map((f) => f.path).sort(), ['README.md', 'dir/b.txt']);
    assert.match(sh(work, 'log', '-1', '--format=%B'), /add a\n\nbody line/);

    await git.switchNewBranch('feat/test');
    await git.push('feat/test');
    assert.match(sh(remote, 'branch', '--list', 'feat/test'), /feat\/test/);
    assert.equal(await git.defaultBranch(), null); // no origin/HEAD symref in this fixture
  } finally {
    dispose();
  }
});

test('Git: command injection through message/paths is inert', async () => {
  const { work, dispose } = makeRepoWithRemote();
  try {
    const git = new Git(work);
    write(work, 'x.txt', 'x');
    await git.stage(['x.txt']);
    await git.commit('$(touch pwned); `touch pwned2`; "quote"');
    const log = sh(work, 'log', '-1', '--format=%s');
    assert.match(log, /\$\(touch pwned\)/);
    assert.equal((await git.status()).files.length, 0);
  } finally {
    dispose();
  }
});

test('policy: secrets are detected without echoing them', () => {
  const key = '-----BEGIN RSA PRIVATE KEY-----\nabc\n';
  const f = scanText('k.txt', key);
  assert.equal(f[0]?.rule, 'private-key');
  assert.ok(!JSON.stringify(f).includes('abc'));
  assert.equal(scanText('c.ts', 'const password = "hunter2hunter2";')[0]?.rule, 'credential-assignment');
  assert.equal(scanText('c.ts', 'k = AKIAABCDEFGHIJKLMNOP')[0]?.rule, 'aws-access-key');
  assert.equal(scanText('c.ts', 'url = https://bob:s3cretpw@host.example/x')[0]?.rule, 'basic-auth-url');
  assert.equal(scanText('card.csv', 'pan,4111 1111 1111 1111')[0]?.rule, 'card-number');
  assert.equal(scanText('ok.csv', 'order,1234567890123')[0], undefined); // fails Luhn
  assert.equal(scanText('ok.ts', 'const x = 1;\n')[0], undefined);
});

test('policy: blocked filenames, size limit, binaries skipped', async () => {
  const root = tmp();
  try {
    write(root, '.env', 'A=1');
    write(root, '.env.example', 'A=');
    write(root, 'id_rsa', 'x');
    write(root, 'big.txt', 'x'.repeat(2000));
    write(root, 'ok.txt', 'hello');
    writeFileSync(join(root, 'bin.dat'), Buffer.from([0, 1, 2, 65, 75, 73, 65]));
    const f = await scanFiles({
      root,
      paths: ['.env', '.env.example', 'id_rsa', 'big.txt', 'ok.txt', 'bin.dat', 'gone.txt'],
      maxFileBytes: 1500,
      scanSecrets: true,
    });
    const rules = f.map((x) => `${x.path}:${x.rule}`).sort();
    assert.deepEqual(rules, ['.env:env-file', 'big.txt:file-too-large', 'id_rsa:private-key-file']);
  } finally {
    cleanup(root);
  }
});

test('config: defaults validate; managed layer overrides user layer', () => {
  const dir = tmp();
  try {
    write(dir, 'user.json', JSON.stringify({ repos: ['/r'], mode: 'simple', protectedBranches: ['dev'] }));
    write(dir, 'managed.json', JSON.stringify({ protectedBranches: ['main'], scanSecrets: true }));
    const cfg = loadConfig({ userPath: join(dir, 'user.json'), managedPath: join(dir, 'managed.json'), env: {} });
    assert.equal(cfg.mode, 'simple');
    assert.deepEqual(cfg.protectedBranches, ['main']);
    assert.ok(cfg.auditLogPath.length > 0);
  } finally {
    cleanup(dir);
  }
});

test('config: rejects unknown keys and bad values', () => {
  const base = JSON.parse(JSON.stringify(DEFAULTS));
  assert.throws(() => validateConfig({ ...base, nope: 1 }), ConfigError);
  assert.throws(() => validateConfig({ ...base, mode: 'root' }), ConfigError);
  assert.throws(() => validateConfig({ ...base, debounceMs: -1 }), ConfigError);
  assert.throws(() => validateConfig({ ...base, forgejo: { url: 'ftp://x' } }), ConfigError);
  assert.throws(() => validateConfig({ ...base, snoozeMinutes: [] }), ConfigError);
  const ok = validateConfig({ ...base, forgejo: { url: 'https://git.corp.example/' } });
  assert.equal(ok.forgejo?.url, 'https://git.corp.example');
  assert.equal(ok.forgejo?.tokenEnv, 'FORGEJO_TOKEN');
});
